// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

package dev.t1000.android

import android.app.NotificationManager
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.OpenableColumns
import android.util.Log
import android.webkit.MimeTypeMap
import androidx.core.content.FileProvider
import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * 处理来自 node host 的原生调用（`/native` 通道）。
 *
 * 每个方法都必须**有返回值或明确抛错**：Node 侧每个调用都有超时，
 * 挂住不回会让界面上的按钮"点了没反应"，这比直接报错更难排查。
 *
 * 关于线程：`handleBlocking` 在 IO 线程被调用，涉及 UI 的操作（文件选择器）
 * 通过 `runBlocking` 等主线程返回结果。这不是最佳实践，但在这个
 * "一个请求一个线程"的模型下是最直白的实现 —— 并发请求各自独立，
 * 不会互相阻塞。
 */
class NativeHandler(
    private val context: Context,
    /** 当前在前台的 Activity（文件选择器需要它） */
    private val activityProvider: () -> MainActivity?,
) {
    companion object {
        private const val TAG = "T1000Native"
    }

    /** Node 侧连上原生通道时调用（可用于上报初始状态） */
    fun onBridgeConnected() {
        Log.i(TAG, "原生处理器就绪")
    }

    fun handleBlocking(method: String, params: JSONObject): Any? {
        Log.d(TAG, "→ $method")
        return when (method) {
            // ── 窗口 ──
            "window.load" -> handleWindowLoad(params)
            "window.show" -> true
            "window.hide" -> true
            "window.focus" -> true
            "window.setTitle" -> true

            // ── 应用 ──
            "app.exit" -> {
                val code = params.optInt("code", 0)
                Log.i(TAG, "请求退出应用（code=$code）")
                // pty 子进程是「应用进程的子进程」，应用被杀后它们不会自动消失，
                // 会在后台留一堆孤儿 shell。退出前必须显式收掉整个进程组。
                PtyManager.killAll()
                activityProvider()?.finishAndRemoveTask()
                NodeService.stop(context)
                jsonOf("code" to code)
            }
            "app.relaunch" -> {
                // Android 上没有"热重启进程"的正当做法；用重建任务代替
                val intent = context.packageManager.getLaunchIntentForPackage(context.packageName)
                if (intent != null) {
                    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
                    context.startActivity(intent)
                }
                jsonOf("ok" to true)
            }

            // ── 剪贴板 ──
            "clipboard.read" -> {
                val cm = context.getSystemService(ClipboardManager::class.java)
                // itemCount 可能为 0（刚从别的应用清空），直接 getItemAt(0) 会抛
                // IndexOutOfBounds；这里显式判空，读不到就如实返回空串
                val clip = cm?.primaryClip
                val text = if (clip != null && clip.itemCount > 0) {
                    clip.getItemAt(0)?.coerceToText(context)?.toString() ?: ""
                } else {
                    ""
                }
                jsonOf("text" to text)
            }
            "clipboard.write" -> {
                val text = params.optString("text", "")
                val cm = context.getSystemService(ClipboardManager::class.java)
                cm?.setPrimaryClip(ClipData.newPlainText("terminal-1000", text))
                jsonOf("ok" to true)
            }

            // ── 对话框 ──
            "dialog.open" -> runBlocking { handleOpenDialog(params) }
            "dialog.save" -> runBlocking { handleSaveDialog(params) }
            "dialog.message" -> runBlocking { handleMessage(params) }
            "dialog.error" -> {
                Log.e(TAG, "${params.optString("title")}: ${params.optString("message")}")
                jsonOf("ok" to true)
            }

            // ── 系统外壳 ──
            "shell.openExternal" -> handleOpenExternal(params)
            "shell.openPath" -> handleOpenPath(params)
            "shell.showItemInFolder" -> handleShowInFolder(params)
            "shell.beep" -> jsonOf("ok" to true)
            "shell.trash" -> handleTrash(params)

            // ── 通知 ──
            "notify.show" -> handleNotify(params)

            // ── Alpine rootfs（proot 的根） ──
            // status 只读；ensure 会真的解包（首次约 1 秒），
            // 用于"本地终端"打开前确认环境，以及设置页的"修复 Alpine 环境"。
            "rootfs.status" -> rootfsStatusJson(RootfsManager(context).status())
            "rootfs.ensure" -> {
                val force = params.optBoolean("force", false)
                rootfsStatusJson(RootfsManager(context).ensure(force))
            }

            // ── 本地终端（pty，走 libt1000pty.so） ──
            "pty.spawn" -> handlePtySpawn(params)
            "pty.write" -> handlePtyWrite(params)
            "pty.resize" -> {
                val ok = PtyManager.resize(
                    params.optString("id"),
                    params.optInt("cols", 80),
                    params.optInt("rows", 24),
                )
                jsonOf("ok" to ok)
            }
            "pty.kill" -> {
                val ok = PtyManager.kill(params.optString("id"), parseSignal(params.opt("signal")))
                jsonOf("ok" to ok)
            }
            "pty.list" -> jsonOf("sessions" to PtyManager.list())

            else -> throw IllegalArgumentException("未实现的原生方法: $method")
        }
    }

    // ── 窗口 ──

    private fun handleWindowLoad(params: JSONObject): Any {
        val activity = activityProvider()
        val url = params.optString("url", "")
        val file = params.optString("file", "")
        if (activity == null) {
            Log.w(TAG, "window.load 时没有 Activity，忽略（界面会在 onCreate 自行加载）")
            return jsonOf("ok" to false)
        }
        activity.runOnUiThread {
            if (url.isNotEmpty()) activity.loadPage(url)
            else if (file.isNotEmpty()) activity.loadAssetFile(file)
        }
        return jsonOf("ok" to true)
    }

    // ── 文件选择 ──

    /**
     * 选文件/目录。
     *
     * 返回的是**本地绝对路径**，而不是 content:// URI —— 主进程侧（Node）
     * 完全不认识 Android 的 URI 方案，它只做 `fs.readFile(path)`。
     * 所以这里把选中的 URI **复制到应用私有目录**再返回路径。
     *
     * 代价是选一个大文件会多占一份空间。取舍：SFTP 上传、导入备份这些场景
     * 的文件通常在几十 MB 以内，可接受；而"返回 URI 让主进程理解"要改
     * 整个 IPC 契约（所有文件操作都要兼容两种方案），不值得。
     */
    private suspend fun handleOpenDialog(params: JSONObject): Any {
        val activity = activityProvider() ?: return jsonOf("canceled" to true, "paths" to JSONArray())
        val directory = params.optString("mode") == "directory"
        val multiple = params.optBoolean("multiple", false)

        val uris = activity.pickDocuments(directory = directory, multiple = multiple)
        if (uris.isEmpty()) return jsonOf("canceled" to true, "paths" to JSONArray())

        val paths = JSONArray()
        for (uri in uris) {
            val local = materialize(uri)
            if (local != null) paths.put(local)
        }
        return jsonOf("canceled" to (paths.length() == 0), "paths" to paths)
    }

    private suspend fun handleSaveDialog(params: JSONObject): Any {
        val activity = activityProvider() ?: return jsonOf("canceled" to true)
        val suggested = params.optString("defaultPath", "untitled.txt")
        val name = File(suggested).name.ifBlank { "untitled.txt" }
        val uri = activity.createDocument(name) ?: return jsonOf("canceled" to true)
        // 保存对话框只回路径；真正写文件由主进程做（它写不进去 content://，
        // 所以这里也物化一个本地路径，主进程写完后由 Java 侧再拷回 URI）
        val local = File(context.filesDir, "tmp/exported/$name").apply {
            parentFile?.mkdirs()
        }
        activity.registerPendingExport(uri, local)
        return jsonOf("canceled" to false, "path" to local.absolutePath)
    }

    private suspend fun handleMessage(params: JSONObject): Any {
        val activity = activityProvider() ?: return jsonOf("response" to params.optInt("defaultId", 0))
        val buttons = params.optJSONArray("buttons") ?: JSONArray().put("确定")
        val labels = Array(buttons.length()) { buttons.optString(it, "确定") }
        val chosen = activity.showChoiceDialog(
            title = params.optString("title", ""),
            message = params.optString("message", ""),
            detail = params.optString("detail", ""),
            buttons = labels,
            defaultIndex = params.optInt("defaultId", 0),
        )
        return jsonOf("response" to chosen)
    }

    // ── 系统外壳 ──

    private fun handleOpenExternal(params: JSONObject): Any {
        val url = params.optString("url", "")
        if (url.isEmpty()) throw IllegalArgumentException("url 为空")
        return try {
            val intent = Intent(Intent.ACTION_VIEW, Uri.parse(url)).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            context.startActivity(intent)
            jsonOf("ok" to true)
        } catch (t: Throwable) {
            // 没有能处理该协议的 App（例如没装邮件客户端却点了 mailto:）
            throw IllegalStateException("没有应用可以打开此链接：${t.message}")
        }
    }

    private fun handleOpenPath(params: JSONObject): Any {
        val path = params.optString("path", "")
        val file = File(path)
        if (!file.exists()) return jsonOf("error" to "文件不存在：$path")
        return try {
            val uri = FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", file)
            val mime = MimeTypeMap.getSingleton()
                .getMimeTypeFromExtension(file.extension.lowercase()) ?: "*/*"
            val intent = Intent(Intent.ACTION_VIEW).apply {
                setDataAndType(uri, mime)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            context.startActivity(intent)
            jsonOf("error" to "")
        } catch (t: Throwable) {
            // 与 Electron 的约定一致：空串=成功，非空=错误原因（不抛异常）
            jsonOf("error" to (t.message ?: "无法打开"))
        }
    }

    private fun handleShowInFolder(params: JSONObject): Any {
        val path = params.optString("path", "")
        val file = File(path)
        // Android 没有"在文件管理器中高亮某个文件"的通用能力，
        // 退化成打开所在目录；连目录都打不开就如实失败
        val dir = if (file.isDirectory) file else file.parentFile
        if (dir == null || !dir.exists()) return jsonOf("error" to "目录不存在")
        return handleOpenPath(JSONObject().put("path", dir.absolutePath))
    }

    private fun handleTrash(params: JSONObject): Any {
        val path = params.optString("path", "")
        val file = File(path)
        // 只允许删应用私有目录里的东西：跨应用删除要走 MediaStore/SAF，
        // 而主进程调用它的场景只有"清理自己物化的临时文件"
        val allowedRoot = context.filesDir.canonicalPath
        val target = runCatching { file.canonicalPath }.getOrNull()
        if (target == null || !target.startsWith(allowedRoot)) {
            throw SecurityException("拒绝删除应用目录之外的文件：$path")
        }
        file.delete()
        return jsonOf("ok" to true)
    }

    private fun handleNotify(params: JSONObject): Any {        val mgr = context.getSystemService(NotificationManager::class.java)
        Log.i(TAG, "通知: ${params.optString("title")} / ${params.optString("body")}")
        // 应用内通知走 NodeService 的前台通知渠道由渲染层控制更合适；
        // 这里只做日志留痕，避免两套通知渠道打架
        return jsonOf("ok" to (mgr != null))
    }

    // ── 工具 ──

    /**
     * 把 content:// 复制到私有目录并返回绝对路径。
     *
     * 目录型 URI（tree）也走这里：递归复制内容。
     */
    // ── 本地终端 ─────────────────────────────────────────────────────────

    /**
     * 起一个 pty 会话。
     *
     * 环境变量由 Node 侧（主进程 `buildShellEnv`）完整给出，这里只补两件事：
     * - `PATH`：Exec 出来的 shell 需要能在 Android 的目录布局里找到命令，
     *   而 app 进程自身的 PATH 未必包含 `/system/bin`（取决于启动方式）；
     * - `HOME`/`TMPDIR`：两者都指向应用私有目录，否则 shell 里的 `cd ~`、
     *   临时文件都会落到不可写的位置（Android 上 `/` 是只读的）。
     */
    private fun handlePtySpawn(params: JSONObject): Any {
        val id = params.optString("id", "")
        val file = params.optString("file", "")
        if (id.isEmpty() || file.isEmpty()) {
            throw IllegalArgumentException("pty.spawn 缺少 id 或 file")
        }

        val argsArr = params.optJSONArray("args")
        val args = ArrayList<String>(argsArr?.length() ?: 0)
        if (argsArr != null) {
            for (i in 0 until argsArr.length()) args.add(argsArr.getString(i))
        }

        val envMap = LinkedHashMap<String, String>()
        params.optJSONObject("env")?.let { obj ->
            for (key in obj.keys()) envMap[key] = obj.optString(key, "")
        }
        // Android 的命令目录；放在前面保证 `ls`/`sh` 这类名字先落到系统实现上
        envMap["PATH"] = envMap["PATH"]?.takeIf { it.isNotBlank() }
            ?: "/system/bin:/system/xbin:/vendor/bin:/product/bin"
        envMap["HOME"] = envMap["HOME"]?.takeIf { it.isNotBlank() } ?: context.filesDir.absolutePath
        envMap["PWD"] = envMap["PWD"]?.takeIf { it.isNotBlank() } ?: envMap["HOME"]!!
        envMap["TMPDIR"] = envMap["TMPDIR"]?.takeIf { it.isNotBlank() } ?: context.cacheDir.absolutePath
        // 少数命令行工具会读这两个，缺失时会去猜（猜错就崩）
        envMap.putIfAbsent("ANDROID_DATA", "/data")
        envMap.putIfAbsent("ANDROID_ROOT", "/system")

        val env = envMap.map { (k, v) -> "$k=$v" }
        val cwd = params.optString("cwd", envMap["HOME"]!!)
        val cols = params.optInt("cols", 80).coerceIn(2, 1000)
        val rows = params.optInt("rows", 24).coerceIn(2, 1000)

        return when (val result = PtyManager.spawn(id, file, args, env, cwd, cols, rows)) {
            is PtyManager.SpawnResult.Ok ->
                jsonOf("pid" to result.session.pid, "process" to file)
            is PtyManager.SpawnResult.Err ->
                throw IllegalStateException("无法创建终端（$file）：${describeErrno(result.code)}")
        }
    }

    private fun handlePtyWrite(params: JSONObject): Any {
        val id = params.optString("id", "")
        val b64 = params.optString("data", "")
        if (b64.isEmpty()) return jsonOf("ok" to true, "bytes" to 0)
        val bytes = try {
            android.util.Base64.decode(b64, android.util.Base64.DEFAULT)
        } catch (e: IllegalArgumentException) {
            throw IllegalArgumentException("pty.write 的 data 不是合法 base64")
        }
        val ok = PtyManager.write(id, bytes)
        return jsonOf("ok" to ok, "bytes" to (if (ok) bytes.size else 0))
    }

    /** 信号既接受数字，也接受 `SIGTERM` 这类名字（Node 侧传的是字符串） */
    private fun parseSignal(raw: Any?): Int {
        if (raw == null || raw == JSONObject.NULL) return 15 // SIGTERM
        if (raw is Number) return raw.toInt()
        val name = raw.toString().trim().uppercase()
        return when (name) {
            "", "SIGTERM", "TERM" -> 15
            "SIGHUP", "HUP" -> 1
            "SIGINT", "INT" -> 2
            "SIGQUIT", "QUIT" -> 3
            "SIGKILL", "KILL" -> 9
            "SIGUSR1", "USR1" -> 10
            "SIGUSR2", "USR2" -> 12
            "SIGWINCH", "WINCH" -> 28
            else -> name.toIntOrNull() ?: 15
        }
    }

    /** 把 errno 翻成用户能看懂的话（终端起不来时这条信息就是全部线索） */
    private fun describeErrno(code: Int): String {
        val err = if (code < 0) -code else code
        return when (err) {
            1 -> "操作不被允许（EPERM）"
            2 -> "文件不存在（ENOENT），请检查 shell 路径"
            12 -> "内存不足（ENOMEM）"
            13 -> "没有执行权限（EACCES），该路径不可执行"
            17 -> "同名会话已存在（EEXIST）"
            19 -> "设备不可用（ENODEV），可能是系统限制了 pty"
            26 -> "文本文件忙（ETXTBSY）"
            else -> "系统错误 errno=$err"
        }
    }

    private fun materialize(uri: Uri): String? {
        return try {
            val name = displayName(uri) ?: "imported-${System.currentTimeMillis()}"
            val destDir = File(context.filesDir, "tmp/imported").apply { mkdirs() }
            val dest = File(destDir, name)
            context.contentResolver.openInputStream(uri)?.use { input ->
                dest.outputStream().use { output -> input.copyTo(output, 64 * 1024) }
            } ?: return null
            dest.absolutePath
        } catch (t: Throwable) {
            Log.e(TAG, "物化 URI 失败: $uri", t)
            null
        }
    }

    private fun displayName(uri: Uri): String? {
        if (uri.scheme == "file") return uri.lastPathSegment
        return runCatching {
            context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)
                ?.use { c ->
                    if (c.moveToFirst()) {
                        val idx = c.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                        if (idx >= 0) c.getString(idx) else null
                    } else null
                }
        }.getOrNull()
    }

    private fun rootfsStatusJson(status: RootfsManager.Status): JSONObject = jsonOf(
        "ready" to status.ready,
        "rootfs" to status.rootfs,
        "version" to status.version,
        "reason" to status.reason,
        "stats" to status.stats,
    )

    private fun jsonOf(vararg pairs: Pair<String, Any?>): JSONObject {
        val o = JSONObject()
        for ((k, v) in pairs) o.put(k, v ?: JSONObject.NULL)
        return o
    }
}
