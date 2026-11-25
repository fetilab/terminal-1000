// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

package dev.t1000.android

import android.system.Os
import android.system.OsConstants
import java.io.File
import java.io.IOException
import java.io.InputStream

/**
 * 最小可用的 tar 解包器（只处理 Alpine rootfs 需要的那几种条目）。
 *
 * 为什么不用 `/system/bin/tar`：
 * - toybox 的 `-z`（gzip）是 0.8.x 才加的，minSdk 26（Android 8）上不一定有；
 * - `tar` 的行为、可用参数各版本不一致，出问题时的报错还很难归因；
 * - 我们只需要 dir / regular / symlink（Alpine minirootfs 就这三种，
 *   实测 516 个条目：97 目录 + 84 文件 + 335 符号链接），
 *   纯 Kotlin 反而更可控、可单测、无外部进程。
 *
 * 仍然按规范处理了 GNU longname（'L'）与 PAX（'x'）两条路径 ——
 * 换个版本的 rootfs 或做定制镜像时不应该直接炸。
 *
 * 安全性：拒绝绝对路径与 `..`（zip-slip），并且**不**创建符号链接指向目标目录
 * 之外也不会写穿（创建符号链接本身无害，后续写入都经过 [safeFile] 归一化）。
 */
object TarExtractor {

    private const val BLOCK = 512
    private const val NAME = 0
    private const val MODE = 100
    private const val SIZE = 124
    private const val CHKSUM = 148
    private const val TYPEFLAG = 156
    private const val LINKNAME = 157
    private const val MAGIC = 257
    private const val PREFIX = 345

    private const val TYPE_FILE_OLD = '0'.code.toByte()
    private const val TYPE_HARDLINK = '1'.code.toByte()
    private const val TYPE_SYMLINK = '2'.code.toByte()
    private const val TYPE_CHAR = '3'.code.toByte()
    private const val TYPE_BLOCK = '4'.code.toByte()
    private const val TYPE_DIR = '5'.code.toByte()
    private const val TYPE_FIFO = '6'.code.toByte()
    private const val TYPE_GNU_LONGNAME = 'L'.code.toByte()
    private const val TYPE_GNU_LONGLINK = 'K'.code.toByte()
    private const val TYPE_PAX = 'x'.code.toByte()
    private const val TYPE_PAX_GLOBAL = 'g'.code.toByte()

    data class Stats(val entries: Int, val files: Int, val dirs: Int, val links: Int, val skipped: Int)

    /**
     * 把 [input]（已解压的 tar 字节流）解到 [destDir]。
     *
     * 覆盖语义：同名文件会被覆盖，同名符号链接先删再建 ——
     * 这样"用新版 rootfs 覆盖旧 rootfs"能就地升级，同时保留
     * 用户自己 `apk add` 装出来的文件（它们不在归档里，不会被删）。
     */
    @Throws(IOException::class)
    fun extract(
        input: InputStream,
        destDir: File,
        onProgress: ((Int, String) -> Unit)? = null,
        onEntry: ((Int, Char, String, Long) -> Unit)? = null,
    ): Stats {
        if (!destDir.exists() && !destDir.mkdirs()) {
            throw IOException("无法创建目录 ${destDir.absolutePath}")
        }
        var files = 0
        var dirs = 0
        var links = 0
        var skipped = 0
        var entries = 0

        var longName: String? = null
        var longLink: String? = null
        var paxPath: String? = null
        var paxLink: String? = null

        val header = ByteArray(BLOCK)
        val reader = BoundedInputStream(input)
        while (true) {
            val got = reader.readFully(header)
            if (got == 0) break // 正常结束（遇到 EOF）
            if (got < BLOCK) throw IOException("tar 尾部不完整（$got 字节）")
            if (isZeroBlock(header)) break // 归档结束标记

            val type = header[TYPEFLAG]
            val rawSize = parseOctal(header, SIZE, 12)
            val body = reader

            when (type) {
                TYPE_GNU_LONGNAME, TYPE_GNU_LONGLINK, TYPE_PAX, TYPE_PAX_GLOBAL -> {
                    val data = readEntryData(body, rawSize)
                    when (type) {
                        TYPE_GNU_LONGNAME -> longName = cString(data, 0, data.size)
                        TYPE_GNU_LONGLINK -> longLink = cString(data, 0, data.size)
                        TYPE_PAX -> {
                            val kv = parsePax(data)
                            kv["path"]?.let { paxPath = it }
                            kv["linkpath"]?.let { paxLink = it }
                        }
                        // 'g' 是全局属性，对我们没用
                    }
                    continue
                }
            }

            entries++
            var name = cString(header, NAME, 100)
            if (name.isEmpty()) name = cString(header, 128, 24) // 极老的 tar 用 128 偏移

            // POSIX ustar 用 prefix + '/' + name；GNU 的 magic 是 "ustar  \0"（不带 prefix）
            val isPosixUstar = header[MAGIC] == 'u'.code.toByte() &&
                header[MAGIC + 5] == 0.toByte()
            if (isPosixUstar) {
                val prefix = cString(header, PREFIX, 155)
                if (prefix.isNotEmpty()) name = "$prefix/$name"
            }

            val finalName = paxPath ?: longName ?: name
            val finalLink = paxLink ?: longLink ?: cString(header, LINKNAME, 100)
            paxPath = null
            paxLink = null
            longName = null
            longLink = null

            if (entries % 100 == 0) onProgress?.invoke(entries, finalName)
            onEntry?.invoke(entries, type.toInt().toChar(), finalName, rawSize)

            val target = safeFile(destDir, finalName)
            val mode = parseOctal(header, MODE, 8).toInt()

            when (type) {
                TYPE_DIR -> {
                    if (!target.isDirectory && !target.mkdirs() && !target.isDirectory) {
                        throw IOException("无法创建目录 $finalName")
                    }
                    chmod(target, mode)
                    dirs++
                }

                TYPE_SYMLINK -> {
                    target.parentFile?.mkdirs()
                    deleteQuietly(target)
                    runCatching { Os.symlink(finalLink, target.absolutePath) }
                        .onFailure {
                            // 极端情况下（比如目标是个已存在的非空目录）退化成不建链接，
                            // 但绝不能静默：调用方要能在日志里看到
                            skipped++
                        }
                    links++
                }

                TYPE_HARDLINK -> {
                    val source = safeFile(destDir, finalLink)
                    target.parentFile?.mkdirs()
                    deleteQuietly(target)
                    runCatching { Os.link(source.absolutePath, target.absolutePath) }
                        .onFailure { skipped++ }
                    files++
                }

                TYPE_CHAR, TYPE_BLOCK, TYPE_FIFO -> {
                    // 设备节点/管道在 app 里没权限也没意义（/dev 由 proot 绑定宿主 /dev）
                    reader.skipFully(rawSize)
                    skipped++
                }

                else -> {
                    // '0'、'\0'（TYPE_FILE_OLD）以及未知类型一律当普通文件
                    target.parentFile?.mkdirs()
                    deleteQuietly(target)
                    target.outputStream().use { out ->
                        copyExactly(reader, out, rawSize)
                    }
                    chmod(target, mode)
                    files++
                }
            }
        }
        return Stats(entries, files, dirs, links, skipped)
    }

    // ── 工具 ───────────────────────────────────────────────────

    /**
     * 把归档里的名字归一化成 [destDir] 下的安全路径。
     * 拒绝：绝对路径、含 `..` 的路径、归一化后跑出 [destDir] 的路径。
     */
    private fun safeFile(destDir: File, rawName: String): File {
        var name = rawName.replace('\\', '/').trim()
        while (name.startsWith("./")) name = name.substring(2)
        name = name.trimStart('/')
        if (name.isEmpty() || name == ".") return destDir
        val parts = name.split('/').filter { it.isNotEmpty() && it != "." }
        if (parts.any { it == ".." }) {
            throw IOException("归档条目试图跳出目标目录：$rawName")
        }
        return File(destDir, parts.joinToString("/"))
    }

    private fun chmod(file: File, mode: Int) {
        val perm = mode and 0x1FF // 0777
        if (perm == 0) return
        val ok = runCatching { Os.chmod(file.absolutePath, perm) }.isSuccess
        if (!ok) {
            // Os.chmod 在个别文件系统上会给 EPERM，退化成 Java API（精度差但不至于不可执行）
            file.setExecutable(perm and 0x49 != 0, false)
            file.setReadable(perm and 0x24 != 0, false)
            file.setWritable(perm and 0x12 != 0, false)
        }
    }

    private fun deleteQuietly(file: File) {
        runCatching { if (file.exists() || isSymlink(file)) file.delete() }
    }

    private fun isSymlink(file: File): Boolean = runCatching {
        Os.lstat(file.absolutePath).st_mode and OsConstants.S_IFMT == OsConstants.S_IFLNK
    }.getOrDefault(false)

    private fun isZeroBlock(block: ByteArray): Boolean {
        for (b in block) if (b != 0.toByte()) return false
        return true
    }

    /** tar 的数值字段：八进制，允许前导空格与尾部 NUL/空格；也容忍 GNU base-256 编码 */
    private fun parseOctal(header: ByteArray, offset: Int, length: Int): Long {
        // GNU base-256：最高位为 1 时是二进制大端
        if (header[offset].toInt() and 0x80 != 0) {
            var v = (header[offset].toInt() and 0x7F).toLong()
            for (i in 1 until length) v = (v shl 8) or (header[offset + i].toInt() and 0xFF).toLong()
            return v
        }
        var value = 0L
        var seen = false
        for (i in 0 until length) {
            val c = header[offset + i].toInt() and 0xFF
            if (c == 0 || c == ' '.code) {
                if (seen) break else continue
            }
            if (c < '0'.code || c > '7'.code) break
            value = value * 8 + (c - '0'.code)
            seen = true
        }
        return value
    }

    private fun cString(buf: ByteArray, offset: Int, length: Int): String {
        var end = offset
        val limit = minOf(buf.size, offset + length)
        while (end < limit && buf[end] != 0.toByte()) end++
        return String(buf, offset, end - offset, Charsets.UTF_8)
    }

    private fun readEntryData(reader: BoundedInputStream, size: Long): ByteArray {
        if (size <= 0) return ByteArray(0)
        val out = ByteArray(size.toInt())
        var off = 0
        while (off < out.size) {
            val n = reader.read(out, off, out.size - off)
            if (n < 0) throw IOException("tar 条目数据被截断")
            off += n
        }
        reader.alignToBlock(size)
        return out
    }

    private fun copyExactly(reader: BoundedInputStream, out: java.io.OutputStream, size: Long) {
        val buf = ByteArray(64 * 1024)
        var left = size
        while (left > 0) {
            val n = reader.read(buf, 0, minOf(buf.size.toLong(), left).toInt())
            if (n < 0) throw IOException("tar 条目数据被截断")
            out.write(buf, 0, n)
            left -= n
        }
        reader.alignToBlock(size)
    }

    /** PAX 扩展头：形如 `27 path=./very/long/name\n` 的重复片段 */
    private fun parsePax(data: ByteArray): Map<String, String> {
        val text = String(data, Charsets.UTF_8)
        val out = HashMap<String, String>()
        var i = 0
        while (i < text.length) {
            val space = text.indexOf(' ', i)
            if (space < 0) break
            val len = text.substring(i, space).toIntOrNull() ?: break
            if (len <= 0 || i + len > text.length) break
            val record = text.substring(space + 1, i + len).trimEnd('\n')
            val eq = record.indexOf('=')
            if (eq > 0) out[record.substring(0, eq)] = record.substring(eq + 1)
            i += len
        }
        return out
    }

    /** 按 512 字节块对齐的读取器：tar 每条数据都要补齐到块边界 */
    private class BoundedInputStream(private val src: InputStream) {

        /**
         * Android 的 AssetInputStream（APK 内的未压缩 asset）在个别情况下
         * `read` 会返回 0 表示"暂时没数据"。把它当 EOF 会截断归档，
         * 无限重试又会静默挂死 —— 所以连续零字节超过阈值就直接抛错，
         * 让上层看到原因。
         */
        private var zeroReads = 0

        private fun read1(buf: ByteArray, off: Int, len: Int): Int {
            while (true) {
                val n = src.read(buf, off, len)
                if (n > 0 || n < 0) {
                    zeroReads = 0
                    return n
                }
                if (++zeroReads > 64) throw IOException("tar 流连续返回 0 字节（读不出数据）")
            }
        }

        /** 读满 [buf]；EOF 时返回已读字节数 */
        fun readFully(buf: ByteArray): Int {
            var off = 0
            while (off < buf.size) {
                val n = read1(buf, off, buf.size - off)
                if (n < 0) return off
                off += n
            }
            return off
        }

        fun read(buf: ByteArray, off: Int, len: Int): Int = read1(buf, off, len)

        fun alignToBlock(size: Long) {
            val pad = (BLOCK - (size % BLOCK)) % BLOCK
            if (pad > 0) skipFully(pad)
        }

        fun skipFully(count: Long) {
            var left = count
            val scratch = ByteArray(4096)
            while (left > 0) {
                val n = src.read(scratch, 0, minOf(scratch.size.toLong(), left).toInt())
                if (n < 0) return
                left -= n
            }
        }
    }
}
