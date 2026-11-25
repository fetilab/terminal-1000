// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

package dev.t1000.android

import android.content.Context
import android.content.pm.ApplicationInfo
import android.util.Log
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.util.Locale
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Node 运行时的准备与进程管理。
 *
 * 三件事按顺序：
 * 1. **把 assets 里的运行时摊到私有目录**（APK 内的 assets 不能直接执行、
 *    也不能被 Node 的 `require` 按路径解析）。带版本戳，只在版本变化时重做。
 * 2. **启动 Node 进程**。二进制以 `libnode.so` 命名放在 `nativeLibraryDir`：
 *    Android 10+ 禁止从可写目录 exec，而 `nativeLibraryDir` 是只读且被允许执行的 ——
 *    这是"绕开 W^X"的标准做法，也是本项目能在非 root 设备上跑 Node 的前提。
 * 3. **监督**：读 `bridge.json` 拿端口，进程退出时按退避重启。
 *
 * 关于进程隔离的取舍：没走 `libnode.so` 的 JNI 嵌入（`node::Start`），
 * 而是起独立进程。理由是可维护性 —— 独立进程里 Node 就是普通 Node，
 * `process.argv` / stdio / 信号 / `dlopen` 全部是标准语义，
 * better-sqlite3 与 node-pty 这类原生模块的行为与桌面端完全一致；
 * 而 JNI 嵌入要自己管线程附着与信号处理，出错点要多得多。
 */
class NodeRuntime(private val context: Context) {

    companion object {
        private const val TAG = "T1000Node"

        /** 运行时版本戳文件名：内容变了才重新摊开 assets */
        private const val VERSION_STAMP = "runtime.version"
        private const val BRIDGE_FILE = "bridge.json"

        /** 最多连续重启次数（超过就认为代码有问题，别无限刷） */
        private const val MAX_RESTARTS = 3
    }

    @Volatile
    var process: Process? = null
        private set

    @Volatile
    var lastExitCode: Int = Int.MIN_VALUE
        private set

    private val starting = AtomicBoolean(false)
    private val stopping = AtomicBoolean(false)

    private val filesDir: File get() = context.filesDir

    /** 摊开后的 host 脚本 */
    private val hostScript = File(filesDir, "host/node-host.mjs")

    /** Node 可执行文件（在 nativeLibraryDir 里，名字必须 lib*.so 才会被安装器解压出来） */
    private val nodeBinary: File
        get() = File(context.applicationInfo.nativeLibraryDir, "libnode.so")

    /** 日志文件：真机上出问题时要能拿到（logcat 会被刷掉） */
    private val logFile: File get() = File(filesDir, "logs/node.log")

    /**
     * 准备并启动。返回是否成功拉起（不代表 Node 已完成初始化 ——
     * 端口就绪由 [waitForBridge] 判断）。
     *
     * @param onPortReady Node 写出 bridge.json 后回调真实端口
     * @param onFatal     彻底失败（重启用尽）时回调，供界面显示原因
     */
    fun start(onPortReady: (Int) -> Unit, onFatal: (String) -> Unit) {
        if (!starting.compareAndSet(false, true)) {
            Log.w(TAG, "已有启动流程在进行，忽略重复调用")
            return
        }
        Thread({
            try {
                // 清掉上次运行残留的桥信息：否则可能读到旧端口
                File(filesDir, BRIDGE_FILE).delete()

                unpackAssets()

                // Alpine rootfs 与 Node 启动互不依赖，并行摊开即可：
                // 首次启动约 1 秒，用户真正去点"本地终端"时早就好了。
                // 万一没好，JS 侧会回退到 /system/bin/sh（见 services/pty/alpine.ts）。
                RootfsManager(context).ensureAsync()

                if (!nodeBinary.exists()) {
                    onFatal("安装包缺少运行时可执行文件（libnode.so），请重新安装")
                    return@Thread
                }

                var attempt = 0
                while (!stopping.get() && attempt <= MAX_RESTARTS) {
                    attempt++
                    Log.i(TAG, "启动 Node（第 $attempt 次）")
                    val proc = launch()
                    if (proc == null) {
                        onFatal("无法启动 Node 进程（见日志）")
                        return@Thread
                    }
                    process = proc

                    val port = waitForBridge(30_000)
                    if (port != null) {
                        if (attempt == 1) {
                            T1000App.publishPort(port)
                        } else {
                            // 重启后端口会变：界面必须重新加载，否则 WebView 还连着旧端口
                            T1000App.publishPortChanged(port)
                        }
                        onPortReady(port)
                        attempt = 0 // 成功启动就把失败计数清零
                    } else {
                        Log.e(TAG, "30s 内没有拿到 bridge.json（Node 可能启动失败）")
                    }

                    val code = proc.waitFor()
                    lastExitCode = code
                    process = null
                    if (stopping.get()) {
                        Log.i(TAG, "Node 已按要求停止（exit=$code）")
                        return@Thread
                    }
                    Log.w(TAG, "Node 退出（exit=$code），准备重启")
                }
                onFatal("Node 连续启动失败 $MAX_RESTARTS 次，已停止重试")
            } catch (t: Throwable) {
                Log.e(TAG, "启动流程异常", t)
                onFatal("启动失败：${t.message}")
            } finally {
                starting.set(false)
            }
        }, "t1000-node-launcher").start()
    }

    fun stop() {
        stopping.set(true)
        val p = process ?: return
        Log.i(TAG, "停止 Node 进程")
        runCatching {
            // 先礼后兵：SIGTERM 让主进程走 before-quit 清理（关隧道、断 SSH）
            p.destroy()
            if (!p.waitFor(5, TimeUnit.SECONDS)) p.destroyForcibly()
        }
    }

    // ── 进程启动 ────────────────────────────────────────────

    private fun launch(): Process? {
        val bin = nodeBinary
        if (!bin.canExecute()) {
            Log.e(TAG, "可执行文件没有执行权限: ${bin.absolutePath}（extractNativeLibs 未生效？）")
            return null
        }

        val env = mutableMapOf(
            // Node 自己要看 HOME（部分模块会读）
            "HOME" to filesDir.absolutePath,
            "TMPDIR" to File(filesDir, "tmp").absolutePath,
            "PATH" to "/system/bin:/system/xbin:/vendor/bin",
            // 原生模块依赖的 libc++ 等随 APK 一起发在 nativeLibraryDir
            "LD_LIBRARY_PATH" to context.applicationInfo.nativeLibraryDir,
            // ── 应用自己的约定（与 node-host/src/env.ts 一一对应） ──
            "T1000_HOME" to filesDir.absolutePath,
            "T1000_USERDATA" to File(filesDir, "terminal-1000").absolutePath,
            "T1000_TEMP" to File(filesDir, "tmp").absolutePath,
            "T1000_RESOURCES" to File(filesDir, "resources").absolutePath,
            "T1000_NATIVE_LIB_DIR" to context.applicationInfo.nativeLibraryDir,
            // Alpine rootfs 根目录：proot 的 -r 参数，pty 层据此拼本地终端命令。
            // 这里无条件传（哪怕还没解包）—— "有没有解包好" 由 JS 侧检查 bin/sh 判断，
            // 免得 Kotlin 与 JS 两边各维护一份状态。
            "T1000_ROOTFS" to RootfsManager(context).rootfsDir.absolutePath,
            "T1000_TOKEN" to T1000App.bridgeToken,
            "T1000_PORT" to "0", // 0 = 由系统分配，真实端口写进 bridge.json
            "T1000_VERSION" to BuildConfigCompat.versionName(context),
            "T1000_LOCALE" to Locale.getDefault().toLanguageTag(),
            "TERM" to "xterm-256color",
        )
        // testhook：只在构建时显式打开（-Pt1000TestHook=true），
        // 不随 debug 包自动启用 —— 它会让主进程把 userData 换成临时目录，
        // 调试包一旦默认开启，用户会觉得"设置和连接存不住"
        if (BuildConfig.T1000_TEST_HOOK) env["T1000_TEST_HOOK"] = "1"

        return try {
            val pb = ProcessBuilder(bin.absolutePath, hostScript.absolutePath)
            pb.directory(filesDir)
            pb.environment().apply {
                // 只保留系统必要变量 + 我们自己的，不继承 JVM 的环境
                clear()
                putAll(env)
            }
            pb.redirectErrorStream(true)
            val proc = pb.start()
            pumpOutput(proc)
            Log.i(TAG, "Node 进程已启动 pid=${pidOf(proc)}")
            proc
        } catch (t: Throwable) {
            Log.e(TAG, "启动进程失败", t)
            null
        }
    }

    /** 把子进程输出同时写 logcat 与日志文件 */
    private fun pumpOutput(proc: Process) {
        Thread({
            logFile.parentFile?.mkdirs()
            FileOutputStream(logFile, true).use { out ->
                out.write("\n===== ${java.util.Date()} 启动 =====\n".toByteArray())
                proc.inputStream.bufferedReader().useLines { lines ->
                    for (line in lines) {
                        Log.i(TAG, line)
                        runCatching { out.write((line + "\n").toByteArray()) }
                    }
                }
            }
        }, "t1000-node-output").start()
    }

    // ── 端口等待 ────────────────────────────────────────────

    /**
     * 等 Node 写出 `bridge.json` 并解析出端口。
     *
     * 为什么用文件而不是解析 stdout：stdout 会被日志淹没、可能被缓冲，
     * 而文件是原子的（写完才可见，且我们校验 content-length + JSON 可解析）。
     */
    private fun waitForBridge(timeoutMs: Long): Int? {
        val file = File(filesDir, BRIDGE_FILE)
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            if (stopping.get()) return null
            if (file.exists()) {
                val text = runCatching { file.readText() }.getOrNull()
                if (!text.isNullOrBlank()) {
                    val port = runCatching { JSONObject(text).optInt("port", 0) }.getOrDefault(0)
                    if (port > 0) return port
                }
            }
            Thread.sleep(120)
        }
        return null
    }

    // ── 资产摊开 ────────────────────────────────────────────

    /**
     * 把 assets 里需要"以真实文件存在"的内容复制到私有目录。
     *
     * 必须摊开的（不能直接从 assets 读）：
     * - `host/`：Node 脚本，需要被当作真实文件路径启动；
     * - `resources/`：主进程按路径查找（kitty-vt.wasm、背景脚本）；
     * - `node_modules/`：原生模块 `.node` 必须能被 dlopen；
     * - `renderer/`：WebView 通过 AssetLoader 读，其实不必摊开，
     *   但摊开后调试时可以替换单个文件，代价只是几十 MB 磁盘。
     *
     * 用版本戳避免每次启动都做一遍（上百个文件 + 12MB bundle，
     * 冷启动会多出 1–2 秒，用户感受得到）。
     */
    private fun unpackAssets() {
        // 版本戳必须能区分"同一个版本号但内容不同"的两次安装：
        // 开发期反复 install -r 时 versionCode 不变，只用版本号会一直命中旧资产，
        // 改了 node-host / renderer 却在设备上看到老行为（排查起来极浪费时间）。
        // lastUpdateTime 每次安装都会变，天然是内容指纹。
        val installed = runCatching {
            context.packageManager.getPackageInfo(context.packageName, 0).lastUpdateTime
        }.getOrDefault(0L)
        val version = BuildConfigCompat.versionName(context) + ":" +
            BuildConfigCompat.versionCode(context) + ":" + installed
        val stamp = File(filesDir, VERSION_STAMP)

        if (stamp.exists() && stamp.readText().trim() == version && hostScript.exists()) {
            Log.i(TAG, "运行时已是当前版本（$version），跳过解包")
            ensureDirs()
            return
        }

        Log.i(TAG, "开始解包运行时资源（版本 $version）")
        val started = System.currentTimeMillis()
        ensureDirs()

        val am = context.assets
        for (top in listOf("host", "resources", "renderer", "node_modules", "inject")) {
            val exists = runCatching { am.list(top)?.isNotEmpty() == true }.getOrDefault(false)
            if (!exists) {
                Log.w(TAG, "assets 里没有 $top（该功能将不可用）")
                continue
            }
            copyAssetDir(top, File(filesDir, top))
        }

        stamp.writeText(version)
        Log.i(TAG, "解包完成，用时 ${System.currentTimeMillis() - started} ms")
    }

    private fun ensureDirs() {
        for (d in listOf("logs", "tmp", "terminal-1000", "host", "resources", "renderer")) {
            File(filesDir, d).mkdirs()
        }
    }

    private fun copyAssetDir(assetPath: String, target: File) {
        val children = context.assets.list(assetPath) ?: emptyArray()
        if (children.isEmpty()) {
            copyAssetFile(assetPath, target)
            return
        }
        target.mkdirs()
        for (child in children) {
            copyAssetDir("$assetPath/$child", File(target, child))
        }
    }

    private fun copyAssetFile(assetPath: String, target: File) {
        target.parentFile?.mkdirs()
        context.assets.open(assetPath).use { input ->
            FileOutputStream(target).use { output ->
                input.copyTo(output, 64 * 1024)
            }
        }
    }

    private fun isDebuggable(): Boolean =
        (context.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0

    /**
     * 取子进程 pid（只为日志好认）。
     *
     * `Process.pid()` 是 Java 9 的 API，Android 要 API 30+ 才有；
     * 低版本上直接反射拿不到，所以失败就返回 -1 —— 这只是日志字段，
     * 不该因为它让整个启动流程抛错。
     */
    private fun pidOf(proc: Process): Long = runCatching {
        (proc.javaClass.getMethod("pid").invoke(proc) as? Long) ?: -1L
    }.getOrDefault(-1L)

    /** 读日志尾部（设置页"诊断"用） */
    fun tailLog(maxLines: Int = 200): String {
        if (!logFile.exists()) return "(还没有日志)"
        val lines = logFile.readLines()
        return lines.takeLast(maxLines).joinToString("\n")
    }
}

/**
 * 版本信息的兼容取法。
 *
 * 不用 `BuildConfig`：它在不同 AGP 版本下的包名/可见性会变，
 * 而这里只需要"版本名 + 版本号"两个值，从 PackageManager 取更稳。
 */
object BuildConfigCompat {
    fun versionName(context: Context): String = runCatching {
        context.packageManager.getPackageInfo(context.packageName, 0).versionName ?: "0.0.0"
    }.getOrDefault("0.0.0")

    fun versionCode(context: Context): Long = runCatching {
        val info = context.packageManager.getPackageInfo(context.packageName, 0)
        if (android.os.Build.VERSION.SDK_INT >= 28) info.longVersionCode
        else @Suppress("DEPRECATION") info.versionCode.toLong()
    }.getOrDefault(0L)
}
