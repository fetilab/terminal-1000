// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

package dev.t1000.android

import android.content.Context
import android.net.ConnectivityManager
import android.net.LinkProperties
import android.util.Log
import java.io.File
import java.util.concurrent.atomic.AtomicBoolean
import java.util.zip.GZIPInputStream

/**
 * Alpine rootfs 的落地与维护。
 *
 * 三件事：
 * 1. **首次启动把 assets/rootfs.tar.gz 解到私有目录**（[TarExtractor]）。
 *    带版本戳，升级时覆盖解包 —— 用户 `apk add` 装出来的文件不在归档里，
 *    因此就地升级不会丢，只有基础系统文件被刷新。
 * 2. **写 DNS**：Android 的 resolver 不会自动进 rootfs，`/etc/resolv.conf`
 *    必须按当前网络的 DNS 手写，否则 `apk` / `git clone` 全部解析失败。
 * 3. **汇报状态**给上层：proot 能不能用、缺什么。
 *
 * 放在 app 私有目录而不是外部存储：proot 需要符号链接、可执行位、
 * 以及大量小文件，只有 ext4/f2fs 的私有目录能同时满足（scoped storage 也不行）。
 */
class RootfsManager(private val context: Context) {

    companion object {
        private const val TAG = "T1000Rootfs"

        /** 与 scripts/build-rootfs.sh 里的 ALPINE_VER 对齐 */
        const val VERSION = "alpine-3.24.4"

        /** 版本戳文件名（放在 rootfs 里，解包成功后才写） */
        private const val STAMP = ".t1000-rootfs"

        /** 解包目标目录名（相对 filesDir） */
        private const val DIR = "alpine"

        /** 兜底 DNS：拿不到系统 DNS 时用它，比"完全不能联网"好 */
        private val FALLBACK_DNS = listOf("1.1.1.1", "8.8.8.8")
    }

    data class Status(
        val ready: Boolean,
        /** rootfs 目录绝对路径（未就绪时也会返回，供 UI 显示） */
        val rootfs: String,
        /** 已解包的版本；未解包为 null */
        val version: String?,
        /** 未就绪的原因（可直接展示给用户） */
        val reason: String?,
        /** 解包统计（仅本次解包时有值） */
        val stats: String? = null,
    )

    private val running = AtomicBoolean(false)
    private val lock = Any()

    val rootfsDir: File get() = File(context.filesDir, DIR)

    /** 只读检查，不做任何解包（给 IPC 的 status 用） */
    fun status(): Status {
        val dir = rootfsDir
        val stamp = File(dir, STAMP)
        val version = runCatching { stamp.takeIf { it.exists() }?.readText()?.trim() }.getOrNull()
        return when {
            !entryExists(File(dir, "bin/sh")) ->
                Status(false, dir.absolutePath, version, "Alpine 环境尚未解包")
            version == null -> Status(false, dir.absolutePath, null, "rootfs 版本戳缺失，需要重新解包")
            version != VERSION ->
                Status(false, dir.absolutePath, version, "rootfs 版本不匹配（$version → $VERSION），需要重新解包")
            else -> Status(true, dir.absolutePath, version, null)
        }
    }

    /**
     * 判断目录条目是否存在，**不跟随符号链接**。
     *
     * rootfs 里绝大多数可执行文件是绝对路径的符号链接（`/bin/sh → /bin/busybox`）。
     * 这些链接在宿主文件系统上按字面解析一定是断链（宿主没有 /bin/busybox），
     * 于是 `File.exists()` 会返回 false —— 用它的结果是"解包明明成功，
     * 却判定成"缺少 /bin/sh"然后静默失败"。链接的有效性只有 proot 的
     * guest 视角才能判断，这里只需要确认"条目在"。
     */
    private fun entryExists(file: File): Boolean = runCatching {
        android.system.Os.lstat(file.absolutePath)
        true
    }.getOrDefault(file.exists())

    /**
     * 就绪则直接返回；否则同步解包。可被多次/并发调用（内部串行化）。
     *
     * @param force 版本一致也强制重解（诊断用；会覆盖基础系统文件，但不动用户装的东西）
     */
    fun ensure(force: Boolean = false): Status {
        val current = status()
        if (current.ready && !force) return current

        synchronized(lock) {
            // 双检：可能等锁期间别的线程已经解好了
            val again = status()
            if (again.ready && !force) return again
            return extract()
        }
    }

    /** 后台解包，避免卡住 UI / Node 启动线程 */
    fun ensureAsync(force: Boolean = false, onDone: (Status) -> Unit = {}) {
        if (!running.compareAndSet(false, true)) {
            Log.i(TAG, "已有解包任务在进行，忽略重复调用")
            return
        }
        Thread({
            val result = try {
                ensure(force)
            } catch (t: Throwable) {
                Log.e(TAG, "解包失败", t)
                Status(false, rootfsDir.absolutePath, null, "解包失败：${t.message}")
            } finally {
                running.set(false)
            }
            // 失败必须留痕：这个流程在后台跑，静默失败的表现是
            // "本地终端莫名其妙退回了 mksh"，没有日志根本无从下手
            if (result.ready) Log.i(TAG, "Alpine 环境就绪：${result.rootfs}")
            else Log.w(TAG, "Alpine 环境不可用：${result.reason}")
            onDone(result)
        }, "t1000-rootfs").start()
    }

    // ── 解包 ───────────────────────────────────────────────────

    private fun extract(): Status {
        val dir = rootfsDir
        val started = System.currentTimeMillis()
        Log.i(TAG, "开始解包 rootfs $VERSION → ${dir.absolutePath}")

        // 版本戳先删：解包中途被杀进程时，下次启动一定会重来，
        // 而不是把"半套 rootfs"当成好的用（那种状态排查起来极痛苦）
        File(dir, STAMP).delete()
        if (!dir.exists() && !dir.mkdirs()) {
            return Status(false, dir.absolutePath, null, "无法创建 $DIR 目录")
        }

        val stats = try {
            context.assets.open("rootfs.tgz").use { raw ->
                // 包一层缓冲：AssetInputStream 的 read 是逐段进入 native 的，
                // 不缓冲会让 516 条目的 block 读取变成几千次跨 JNI 调用；
                // 也顺手把"read 返回 0"的边界情形挡在 GZIPInputStream 之前。
                java.io.BufferedInputStream(raw, 128 * 1024).use { buffered ->
                    GZIPInputStream(buffered, 128 * 1024).use { gz ->
                        TarExtractor.extract(
                            gz,
                            dir,
                            onProgress = { count, name ->
                                if (count % 200 == 0) Log.i(TAG, "进度 $count 项：$name")
                            },
                            onEntry = { count, type, name, size ->
                                // 解包卡住时，这条 DEBUG 日志能直接指出最后一个处理到的条目
                                if (Log.isLoggable(TAG, Log.DEBUG)) {
                                    Log.d(TAG, "  #$count $type $name ($size)")
                                }
                            },
                        )
                    }
                }
            }
        } catch (e: java.io.FileNotFoundException) {
            Log.e(TAG, "APK 里没有 assets/rootfs.tgz", e)
            return Status(false, dir.absolutePath, null, "安装包缺少 Alpine 环境（rootfs.tgz）")
        } catch (t: Throwable) {
            Log.e(TAG, "解包 rootfs 失败", t)
            return Status(false, dir.absolutePath, null, "解包失败：${t.message}")
        }

        writeResolverConfig(dir)
        chmodHelper(dir)

        if (!entryExists(File(dir, "bin/sh"))) {
            return Status(false, dir.absolutePath, null, "解包后缺少 /bin/sh，归档可能不完整")
        }

        File(dir, STAMP).writeText(VERSION)
        val cost = System.currentTimeMillis() - started
        val summary = "解包 ${stats.entries} 项（文件 ${stats.files} / 目录 ${stats.dirs} / " +
            "链接 ${stats.links} / 跳过 ${stats.skipped}），用时 ${cost}ms"
        Log.i(TAG, summary)
        return Status(true, dir.absolutePath, VERSION, null, summary)
    }

    /**
     * 写 `/etc/resolv.conf` 与 `/etc/hosts`。
     *
     * Android 的 DNS 在 netd 里，rootfs 里没有 /etc/resolv.conf 就等于没网。
     * 取当前活动网络的 DNS 服务器（Wi-Fi/移动网络的真实地址），拿不到再兜底。
     */
    private fun writeResolverConfig(dir: File) {
        val servers = systemDnsServers().ifEmpty { FALLBACK_DNS }
        val etc = File(dir, "etc")
        etc.mkdirs()
        runCatching {
            File(etc, "resolv.conf").writeText(
                buildString {
                    appendLine("# 由 terminal-1000 在启动时按当前网络写入")
                    for (s in servers) appendLine("nameserver $s")
                    appendLine("options timeout:2 attempts:2")
                },
            )
        }.onFailure { Log.w(TAG, "写 resolv.conf 失败", it) }

        runCatching {
            File(etc, "hosts").writeText(
                """
                |127.0.0.1   localhost localhost.localdomain
                |::1         localhost localhost.localdomain
                |""".trimMargin(),
            )
        }.onFailure { Log.w(TAG, "写 hosts 失败", it) }
    }

    private fun systemDnsServers(): List<String> {
        return runCatching {
            val cm = context.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
                ?: return emptyList()
            val network = cm.activeNetwork ?: return emptyList()
            val lp: LinkProperties = cm.getLinkProperties(network) ?: return emptyList()
            lp.dnsServers.mapNotNull { it.hostAddress }.filter { it.isNotBlank() }
        }.getOrDefault(emptyList())
    }

    /**
     * `/system/bin` 风格的可执行位补齐（有些 ROM 的 chmod 会静默失败，这里只补关键项）。
     * 只看真实文件：rootfs 里的 `bin/sh` 是指向 busybox 的符号链接，
     * 对链接做 chmod 没有意义（宿主的权限位也不是 guest 看到的那个）。
     */
    private fun chmodHelper(dir: File) {
        for (path in listOf("bin/busybox", "sbin/apk")) {
            val f = File(dir, path)
            if (f.isFile && !f.canExecute()) runCatching { f.setExecutable(true, false) }
        }
    }
}
