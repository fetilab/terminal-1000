// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

package dev.t1000.android

import android.util.Base64
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/**
 * pty 会话管理。
 *
 * 一个会话 = 1 个 master fd + 1 个读取线程 + 1 个退出等待线程。
 * 读取线程把字节流 base64 后通过原生通道推给 Node（Node 侧再解成 string 发给终端），
 * 退出线程阻塞在 waitpid 上，等到子进程真的走了才上报 —— 这样界面上的
 * "进程已退出（code）"是真实退出码，而不是猜的。
 *
 * 为什么 base64 而不是直接塞字符串：
 * pty 输出是**字节流**，一帧里可能把某个 UTF-8 字符从中间切断。若在 Kotlin
 * 侧先解码成 String，半个字符会变成 U+FFFD 且不可逆。base64 保留原始字节，
 * Node 侧用 StringDecoder 跨帧拼接后再解码 —— 这才是正确的做法。
 */
object PtyManager {
    private const val TAG = "T1000Pty"

    /** 单次读取上限。pty 内核缓冲区通常 4–64KB，32KB 能一次吸干又不至于让单帧过大 */
    private const val READ_CHUNK = 32 * 1024

    /** 会话表：id → 会话 */
    private val sessions = ConcurrentHashMap<String, Session>()

    /**
     * 事件出口。由壳在原生通道连上后注入（MainActivity 里设置）。
     * 为空表示 Node 侧还没准备好接 —— 此时丢弃事件但不崩，
     * 因为会话本身的状态仍在 Kotlin 侧，重连后 pty.list 能查回来。
     */
    @Volatile
    var sink: ((String, JSONObject) -> Unit)? = null

    private fun emit(type: String, payload: JSONObject) {
        val s = sink ?: return
        runCatching { s(type, payload) }
            .onFailure { Log.w(TAG, "事件 $type 上报失败: ${it.message}") }
    }

    /** 会话。object 里不能写 inner，emit 用限定名调用即可 */
    class Session(
        val id: String,
        val fd: Int,
        val pid: Int,
        val file: String,
        cols: Int,
        rows: Int,
    ) {
        @Volatile var cols: Int = cols
        @Volatile var rows: Int = rows
        private val closed = AtomicBoolean(false)
        /** master fd 是否已关闭；fd 会被复用，重复 close 会误伤别的会话 */
        private val fdClosed = AtomicBoolean(false)
        private val writes = LinkedBlockingQueue<ByteArray>()
        private val writer = Thread({ writerLoop() }, "t1000-pty-w-$id")
        private val reader = Thread({ readerLoop() }, "t1000-pty-r-$id")
        private val waiter = Thread({ waiterLoop() }, "t1000-pty-e-$id")

        init {
            writer.isDaemon = true
            reader.isDaemon = true
            waiter.isDaemon = true
            writer.start()
            reader.start()
            waiter.start()
        }

        fun write(data: ByteArray) {
            if (closed.get()) return
            // 粘包无意义，直接排队；队列本身无界，但输入侧只有键盘与粘贴，
            // 极端的大粘贴由写入线程顺序消化，不会丢字节
            writes.offer(data)
        }

        private fun writerLoop() {
            while (true) {
                val first = writes.poll(1, TimeUnit.SECONDS) ?: continue
                if (first.isEmpty() && closed.get()) return
                // 把队列里已经到的块拼起来一次写，减少系统调用
                var total = first
                while (true) {
                    val more = writes.poll() ?: break
                    val merged = ByteArray(total.size + more.size)
                    System.arraycopy(total, 0, merged, 0, total.size)
                    System.arraycopy(more, 0, merged, total.size, more.size)
                    total = merged
                    if (total.size >= READ_CHUNK) break
                }
                if (closed.get()) return
                val n = PtyNative.nativeWrite(fd, total, total.size)
                if (n < 0) {
                    Log.w(TAG, "写入失败（$id）: ${-n}")
                    return
                }
            }
        }

        private fun readerLoop() {
            val buf = ByteArray(READ_CHUNK)
            try {
                while (true) {
                    val n = PtyNative.nativeRead(fd, buf)
                    if (n == 0) break // EOF / 已关闭
                    if (n < 0) {
                        Log.w(TAG, "读取失败（$id）: ${-n}")
                        break
                    }
                    val chunk = ByteArray(n)
                    System.arraycopy(buf, 0, chunk, 0, n)
                    PtyManager.emit(
                        "pty.data",
                        JSONObject().apply {
                            put("id", id)
                            put("data", Base64.encodeToString(chunk, Base64.NO_WRAP))
                        },
                    )
                }
            } catch (t: Throwable) {
                Log.w(TAG, "读取线程异常（$id）: ${t.message}")
            }
        }

        private fun waiterLoop() {
            val status = PtyNative.nativeWait(pid)
            val exitCode: Int
            val signal: Int?
            when {
                status >= 0 -> {
                    exitCode = status
                    signal = null
                }
                status > -256 -> {
                    // 被信号杀死：Node 侧 node-pty 的约定是 exitCode=0 + signal
                    exitCode = 0
                    signal = -status
                }
                else -> {
                    exitCode = -1
                    signal = null
                }
            }
            closed.set(true)
            sessions.remove(id)
            closeFd()
            PtyManager.emit(
                "pty.exit",
                JSONObject().apply {
                    put("id", id)
                    put("exitCode", exitCode)
                    if (signal != null) put("signal", signal)
                },
            )
            Log.i(TAG, "会话结束 $id: code=$exitCode signal=${signal ?: "-"}")
        }

        fun resize(newCols: Int, newRows: Int) {
            cols = newCols
            rows = newRows
            PtyNative.nativeResize(fd, newCols, newRows)
        }

        /**
         * 结束会话。三步阶梯，每一步都留痕：
         *
         * 1. 发信号（默认 SIGHUP）—— 但**不能只靠它**：交互式 shell 的作业控制
         *    会把某些信号忽略掉，实测 Android 的 mksh 收到 SIGHUP 也不退出；
         * 2. 关闭 master fd —— 内核随即给 slave 侧送 EOF/HUP，这是终端
         *    "真的没了"的语义，比任何信号都可靠；
         * 3. 还活着就 SIGKILL，绝不留孤儿。
         *
         * 早先只做第 1 步 + 3 秒后 SIGKILL，结果用户点"关闭"要等 3 秒才响应，
         * 而且退出原因被记成"被 KILL"，跟用户操作对不上。
         */
        fun kill(signal: Int) {
            val sent = PtyNative.nativeKill(pid, signal)
            Log.i(TAG, "发送信号 $signal → $id（native=$sent）")
            if (signal == 9) return

            Thread({
                sleepQuietly(1500)
                if (closed.get()) return@Thread
                Log.w(TAG, "会话 $id 未响应信号 $signal，关闭 pty（EOF/HUP）")
                closeFd()

                sleepQuietly(1500)
                if (closed.get()) return@Thread
                Log.w(TAG, "会话 $id 仍未退出，强制结束")
                PtyNative.nativeKill(pid, 9)
            }, "t1000-pty-k-$id").apply { isDaemon = true }.start()
        }

        fun dispose() {
            closed.set(true)
            closeFd()
        }

        /**
         * 关闭 master fd。**只能关一次**：fd 编号会被后续 openpty 复用，
         * 重复 close 会关掉别的会话的 pty（症状是"另一个终端莫名断流"）。
         */
        private fun closeFd() {
            if (fdClosed.compareAndSet(false, true)) {
                PtyNative.nativeClose(fd)
            }
        }

        private fun sleepQuietly(ms: Long) {
            try {
                Thread.sleep(ms)
            } catch (e: InterruptedException) {
                Thread.currentThread().interrupt()
            }
        }
    }

    /**
     * 起会话。[env] 是 `KEY=VALUE` 数组（与 execve 的 envp 同形）。
     * 失败返回 null，调用方负责把 errno 翻成人话。
     */
    fun spawn(
        id: String,
        file: String,
        args: List<String>,
        env: List<String>,
        cwd: String,
        cols: Int,
        rows: Int,
    ): SpawnResult {
        if (sessions.containsKey(id)) {
            return SpawnResult.Err(-17) // EEXIST
        }
        val argv = ArrayList<String>(args.size + 1)
        argv.add(file)
        argv.addAll(args)

        val outFd = IntArray(1)
        val pid = PtyNative.nativeSpawn(argv.toTypedArray(), env.toTypedArray(), cwd, cols, rows, outFd)
        if (pid <= 0) {
            Log.w(TAG, "spawn 失败: ${-pid}（$file）")
            return SpawnResult.Err(pid)
        }
        val session = Session(id, outFd[0], pid, file, cols, rows)
        sessions[id] = session
        Log.i(TAG, "会话已创建 $id pid=$pid fd=${outFd[0]} ${cols}x$rows $file")
        return SpawnResult.Ok(session)
    }

    fun write(id: String, data: ByteArray): Boolean {
        val s = sessions[id] ?: return false
        s.write(data)
        return true
    }

    fun resize(id: String, cols: Int, rows: Int): Boolean {
        val s = sessions[id] ?: return false
        s.resize(cols, rows)
        return true
    }

    fun kill(id: String, signal: Int): Boolean {
        val s = sessions[id] ?: return false
        s.kill(signal)
        return true
    }

    fun list(): JSONArray {
        val arr = JSONArray()
        for ((id, s) in sessions) {
            arr.put(
                JSONObject().apply {
                    put("id", id)
                    put("pid", s.pid)
                    put("file", s.file)
                    put("cols", s.cols)
                    put("rows", s.rows)
                },
            )
        }
        return arr
    }

    /** 应用退出前调用：把所有会话连同进程组一起收掉，不留孤儿 */
    fun killAll() {
        for ((_, s) in sessions) {
            runCatching { PtyNative.nativeKill(s.pid, 9) }
        }
        sessions.clear()
    }

    sealed class SpawnResult {
        class Ok(val session: Session) : SpawnResult()
        class Err(val code: Int) : SpawnResult()
    }
}
