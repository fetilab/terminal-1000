// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

package dev.t1000.android

import android.annotation.SuppressLint
import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.res.Configuration
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.webkit.ConsoleMessage
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewClientCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import java.io.ByteArrayInputStream
import java.io.File
import kotlin.coroutines.resume

/**
 * 唯一的前台界面：一个全屏 WebView，承载**原样复用**的桌面端渲染层。
 *
 * 三个关键决策：
 *
 * 1. **用 `WebViewAssetLoader` 走 https 伪源**，而不是 `file://`。
 *    原因：`file://` 是 opaque origin，WebGL、WASM、SharedArrayBuffer、
 *    localStorage 都会受限或被禁；而 `https://appassets.androidplatform.net`
 *    是真 secure context，渲染层与桌面端行为一致。
 *
 * 2. **桥用 `addDocumentStartJavaScript` 注入**，而不是 `evaluateJavascript`。
 *    后者在 onPageStarted 之后才生效，而渲染层首屏就要读
 *    `window.t1000.platform` —— 晚一步就是一屏白。
 *
 * 3. **CSP 在拦截层动态放宽**（见 [CspPathHandler]），不改构建产物。
 *    桌面端的 CSP 是 `connect-src 'self'`，不允许连 `ws://127.0.0.1`。
 *    桥必须连回环 WS，所以只对这一条策略打补丁，其余保持原样。
 */
class MainActivity : AppCompatActivity() {

    companion object {
        private const val TAG = "T1000Activity"
        private const val ASSET_DOMAIN = "appassets.androidplatform.net"
        private const val START_URL = "https://$ASSET_DOMAIN/assets/renderer/index.html"
    }

    private lateinit var webView: WebView
    private lateinit var runtime: NodeRuntime
    private var bridge: BridgeClient? = null

    /** 是否已经加载过页面（Node 重启换端口时需要重新加载） */
    private var loaded = false

    /** 是否已经切到「启动失败」诊断页（避免失败回调与定时兜底重复刷同一页） */
    private var fatalShown = false

    /** 文件选择器的等待者：一次只允许一个选择请求（符合用户直觉） */
    private var pickDeferred: CompletableDeferred<List<Uri>>? = null
    private var pickDirectory = false
    private var pickMultiple = false

    /**
     * 导出登记：save dialog 给了用户一个 content:// URI 作为目标，
     * 但主进程只会往本地路径写。这里记住映射，写完后由 [flushExport] 拷回去。
     */
    private val pendingExports = mutableMapOf<String, Uri>()

    private val pickFilesLauncher =
        registerForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris ->
            pickDeferred?.complete(uris ?: emptyList())
            pickDeferred = null
        }

    private val pickFileLauncher =
        registerForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
            pickDeferred?.complete(if (uri != null) listOf(uri) else emptyList())
            pickDeferred = null
        }

    private val pickTreeLauncher =
        registerForActivityResult(ActivityResultContracts.OpenDocumentTree()) { uri ->
            pickDeferred?.complete(if (uri != null) listOf(uri) else emptyList())
            pickDeferred = null
        }

    private val createDocLauncher =
        registerForActivityResult(ActivityResultContracts.CreateDocument("*/*")) { uri ->
            createDocDeferred?.complete(uri)
            createDocDeferred = null
        }

    private var createDocDeferred: CompletableDeferred<Uri?>? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WindowCompat.setDecorFitsSystemWindows(window, false)

        runtime = NodeRuntime(this)

        setupWebView()
        /*
         * WebView 必须装在一个容器里，而不是直接当 contentView。
         *
         * 原因：`WebView.setPadding()` **不会缩小页面视口** —— 实测视图 1600×1000、
         * padding 35/75 都设上了，页面里 `innerHeight` 依旧是 800dp，
         * padding 只影响滚动内容的内缩。想真正把页面让出来，只能让 WebView 的
         * **布局**变小，而 FrameLayout 会把 padding 施加到子 view 的布局上。
         */
        val root = FrameLayout(this).apply {
            setBackgroundColor(0xFF1A1A1A.toInt())
            addView(
                webView,
                FrameLayout.LayoutParams(
                    FrameLayout.LayoutParams.MATCH_PARENT,
                    FrameLayout.LayoutParams.MATCH_PARENT,
                ),
            )
        }
        setContentView(root)
        installInsets(root)

        // 隐藏系统栏，让终端占满整块屏幕（平板横屏下这块空间很宝贵）
        hideSystemBars()

        // 先起服务，再等端口。顺序很重要：Service 负责拉起 Node 进程。
        NodeService.start(this)

        /*
         * 订阅启动失败。
         *
         * 之前这里只有一条 35 秒的定时器：到点若还没加载就**写一行 logcat** 了事。
         * 结果是「点开应用 → 黑屏 → 什么提示都没有」，而真正的原因（子进程
         * dlopen libnode.so 失败）安安静静躺在 logcat 里 —— 群友反馈「根本无法
         * 启动」时，双方都无从下手。
         *
         * 现在失败一发生就把界面切成诊断页：失败原因 + 设备/ABI/页大小 + Node
         * 日志尾部。用户长按就能把整块复制出来发给我。
         */
        T1000App.onFatal { reason -> showFatalPage(reason) }

        awaitBridgeThenLoad()
    }

    /**
     * 用一屏 HTML 代替黑屏。
     *
     * 刻意把「页大小」摆出来：Android 15 起新机型大量改用 16 KB 页，而
     * 4 KB 对齐的 so 在 16 KB 设备上会 dlopen 失败 —— 这是最容易被忽略、
     * 又最能一眼定性的一个数字。
     */
    private fun showFatalPage(reason: String) {
        runOnUiThread {
            if (fatalShown) return@runOnUiThread
            fatalShown = true
            Log.e(TAG, "显示启动失败页: $reason")
            webView.loadDataWithBaseURL(null, buildFatalHtml(reason), "text/html", "utf-8", null)
        }
    }

    /**
     * 读设备页大小（字节）。
     *
     * 为什么不用 `Os.sysconf(OsConstants._SC_PAGESIZE)`：那个常量在 android.jar 里
     * 是 @hide 的，编译过得了但运行时可能 NoSuchFieldError —— 在"诊断页"这种
     * 绝不能自己崩的地方不值得冒这个险。
     *
     * 改读 `/proc/self/auxv`：内核在进程启动时把 AT_PAGESZ 写进去，格式是
     * 一串 (type: u64, value: u64) 小端对，AT_PAGESZ = 6。纯文件读取，
     * 从 API 21 到最新都一样。
     */
    private fun detectPageSize(): Long = runCatching {
        val buf = File("/proc/self/auxv").readBytes()
        var i = 0
        while (i + 16 <= buf.size) {
            var type = 0L
            var value = 0L
            for (k in 0 until 8) {
                type = type or ((buf[i + k].toLong() and 0xFF) shl (8 * k))
                value = value or ((buf[i + 8 + k].toLong() and 0xFF) shl (8 * k))
            }
            if (type == 6L) return@runCatching value // AT_PAGESZ
            i += 16
        }
        0L
    }.getOrDefault(0L)

    private fun buildFatalHtml(reason: String): String {
        fun esc(s: String): String = s
            .replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")

        val pageSize = detectPageSize()

        val webViewPkg = runCatching {
            WebViewCompat.getCurrentWebViewPackage(this)?.let { "${it.packageName} ${it.versionName}" }
        }.getOrNull() ?: "(未知)"

        val logTail = runCatching { runtime.tailLog(40) }.getOrDefault("(读取日志失败)")

        val env = buildString {
            appendLine("应用版本   ${BuildConfigCompat.versionName(this@MainActivity)} (${BuildConfigCompat.versionCode(this@MainActivity)})")
            appendLine("Android   ${Build.VERSION.RELEASE} (API ${Build.VERSION.SDK_INT})")
            appendLine("机型      ${Build.MANUFACTURER} ${Build.MODEL}")
            appendLine("ABI       ${Build.SUPPORTED_ABIS.joinToString(", ")}")
            appendLine("页大小    $pageSize 字节" + if (pageSize == 16384L) "（16 KB 设备）" else "")
            appendLine("WebView   $webViewPkg")
            appendLine("应用 ID   $packageName")
        }

        return """
            <!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
            <meta name="viewport" content="width=device-width,initial-scale=1">
            <title>启动失败</title>
            <style>
              :root { color-scheme: dark }
              body { margin:0; padding:24px; background:#16181d; color:#e6e8ee;
                     font:15px/1.6 -apple-system,system-ui,"Noto Sans CJK SC",sans-serif }
              h1 { font-size:20px; margin:0 0 4px }
              .sub { color:#9aa3b2; font-size:13px; margin-bottom:20px }
              .card { background:#1e2128; border:1px solid #2b303a; border-radius:10px;
                      padding:14px 16px; margin-bottom:14px }
              .reason { color:#ff9a9a; font-weight:600; white-space:pre-wrap; word-break:break-word }
              h2 { font-size:13px; color:#9aa3b2; font-weight:600; letter-spacing:.06em;
                   text-transform:uppercase; margin:18px 0 8px }
              pre { margin:0; padding:12px 14px; background:#12141a; border:1px solid #2b303a;
                    border-radius:8px; overflow:auto; font:12px/1.55 ui-monospace,Menlo,monospace;
                    color:#c8d0dd; -webkit-user-select:text; user-select:text }
              .hint { color:#7f8899; font-size:12px; margin-top:18px }
            </style></head><body>
            <h1>terminal-1000 启动失败</h1>
            <div class="sub">与本机 Node 运行时的连接没有建立起来。</div>
            <div class="card"><div class="reason">${esc(reason)}</div></div>
            <h2>环境</h2>
            <pre>${esc(env)}</pre>
            <h2>Node 日志（末尾 40 行）</h2>
            <pre>${esc(logTail)}</pre>
            <div class="hint">长按上面的文字可以选中复制。反馈问题时把「环境」和「Node 日志」一起发出来。</div>
            </body></html>
        """.trimIndent()
    }

    override fun onDestroy() {
        // 先摘掉 pty 出口：Activity 没了但 Node 进程还活着时，
        // 继续往一个已断开的 WS 推数据只是白费 CPU
        PtyManager.sink = null
        bridge?.disconnect()
        webView.destroy()
        super.onDestroy()
    }

    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        reportScreen()
    }

    // ── WebView 装配 ──────────────────────────────────────

    /**
     * 把系统栏 / 输入法占位让出来。
     *
     * WebView 是 edge-to-edge 的（`setDecorFitsSystemWindows(false)`），不消费 insets
     * 就会一直画到屏幕物理边缘，最底下那一行被压在系统栏底下 —— 终端的按键条与
     * 状态栏正好在最底部，表现就是"按键条被切掉一半"。
     *
     * 四个必须记住的点（都是实测踩出来的）：
     *
     * 1. **padding 必须加在容器上，不能加在 WebView 上。**
     *    `WebView.setPadding()` 不缩小页面视口：实测 view 1600×1000、padding 35/75
     *    都设上了，页面里 `innerHeight` 仍然是 800dp —— padding 只内缩滚动内容。
     *    FrameLayout 则会把 padding 施加到子 view 的**布局**上，页面才真的变小。
     *
     * 2. **按类型分别判断可见性，不能用 `Type.systemBars()` 的组合结果。**
     *    我们只隐藏状态栏，此时 `isVisible(systemBars())` 是 false（因为状态栏不可见），
     *    可导航栏其实好好地画着（实测 nav 可见、75px）。用组合判据会得出
     *    "没有任何栏"的错误结论，padding 恒为 0，等于没修。
     *
     * 3. **必须处理 ime。** 平板软键盘弹出时若只补系统栏，终端下半屏被键盘整个盖住 ——
     *    对终端应用这是致命的（看不见自己在敲什么）。边到边模式下系统不会替你缩窗口。
     *
     * 4. **`tappableElement` 也要算进底部，它比"栏是否可见"更可信。**
     *    实测某些 ROM（Waydroid 的平板任务栏就是）明明把栏画在屏幕上、也照样吞掉
     *    那一条的触摸，却报告 `navigationBars` 不可见、insets=0。只信可见性的话
     *    界面被压住且无法自知。`tappableElement` 的语义是"系统会拦截触摸的区域"，
     *    正是"别把可点控件放这儿"—— 对一排触摸按键来说这是最贴切的判据。
     */
    private fun installInsets(root: FrameLayout) {
        ViewCompat.setOnApplyWindowInsetsListener(root) { view, insets ->
            val status = insets.getInsets(WindowInsetsCompat.Type.statusBars())
            val nav = insets.getInsets(WindowInsetsCompat.Type.navigationBars())
            val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
            val tap = insets.getInsets(WindowInsetsCompat.Type.tappableElement())
            val statusShown = insets.isVisible(WindowInsetsCompat.Type.statusBars())
            val navShown = insets.isVisible(WindowInsetsCompat.Type.navigationBars())
            val imeShown = insets.isVisible(WindowInsetsCompat.Type.ime())
            val top = maxOf(if (statusShown) status.top else 0, tap.top)
            val bottom = maxOf(
                if (navShown) nav.bottom else 0,
                if (imeShown) ime.bottom else 0,
                tap.bottom,
            )
            if (view.paddingTop != top || view.paddingBottom != bottom) {
                Log.i(
                    TAG,
                    "insets → padding top=$top bottom=$bottom" +
                        "（status=$statusShown/${status.top} nav=$navShown/${nav.bottom}" +
                        " ime=$imeShown/${ime.bottom} tap=${tap.top}/${tap.bottom}）",
                )
                view.setPadding(0, top, 0, bottom)
            }
            insets
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun setupWebView() {
        webView = WebView(this).apply {
            layoutParams = ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT,
            )
            setBackgroundColor(0xFF1A1A1A.toInt())
            overScrollMode = View.OVER_SCROLL_NEVER
            isVerticalScrollBarEnabled = false
            isHorizontalScrollBarEnabled = false
        }

        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            // 安全：渲染层只需要读 assets，不该碰 file:// 与任意 content://
            allowFileAccess = false
            allowContentAccess = false
            javaScriptCanOpenWindowsAutomatically = false
            // 终端不是网页：禁止双指缩放（会与画布内的字号缩放冲突）
            setSupportZoom(false)
            builtInZoomControls = false
            displayZoomControls = false
            useWideViewPort = true
            loadWithOverviewMode = false
            // 混合内容一律拒绝：我们自己的资源都在 https 伪源下
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            cacheMode = WebSettings.LOAD_DEFAULT
            // 终端输出会反复读 localStorage/IndexedDB（分栏宽度、折叠状态）
            mediaPlaybackRequiresUserGesture = false
        }

        // assets 资源加载：把 /assets/ 映射到 APK 的 assets 目录，
        // 并在 HTML 上动态放宽 CSP（见类注释）
        val assetsHandler = WebViewAssetLoader.AssetsPathHandler(this)
        val loader = WebViewAssetLoader.Builder()
            .setDomain(ASSET_DOMAIN)
            .addPathHandler("/assets/", CspPathHandler(assetsHandler))
            .build()

        webView.webViewClient = object : WebViewClientCompat() {
            override fun shouldInterceptRequest(
                view: WebView,
                request: WebResourceRequest,
            ): WebResourceResponse? = loader.shouldInterceptRequest(request.url)

            override fun shouldOverrideUrlLoading(
                view: WebView,
                request: WebResourceRequest,
            ): Boolean {
                val url = request.url
                // 站内（伪源）导航放行；外部链接交给系统浏览器
                if (url.host == ASSET_DOMAIN) return false
                runCatching {
                    startActivity(Intent(Intent.ACTION_VIEW, url).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                }
                return true
            }

            override fun onPageFinished(view: WebView, url: String) {
                super.onPageFinished(view, url)
                Log.i(TAG, "页面加载完成: $url")
                reportScreen()
            }
        }

        webView.webChromeClient = object : WebChromeClient() {
            override fun onConsoleMessage(msg: ConsoleMessage): Boolean {
                // 把渲染层的 console 转到 logcat：真机上这是唯一能看到前端报错的通道
                val line = "[web] ${msg.message()} (${msg.sourceId()}:${msg.lineNumber()})"
                when (msg.messageLevel()) {
                    ConsoleMessage.MessageLevel.ERROR -> Log.e(TAG, line)
                    ConsoleMessage.MessageLevel.WARNING -> Log.w(TAG, line)
                    else -> Log.i(TAG, line)
                }
                return true
            }
        }
    }

    /**
     * 注入桥。
     *
     * **必须在"端口就绪之后、loadUrl 之前"调用**：脚本里的
     * `window.__T1000_CONFIG__` 要带真实端口，而端口是 Node 启动后由系统分配、
     * 写进 bridge.json 才知道的。早期实现把注入放在 setupWebView() 里，
     * 那时 bridgePort 还是 0，结果页面拿到空配置、所有 IPC 静默失败。
     *
     * 把 `__T1000_CONFIG__` 拼在 bridge.js 前面，而不是去改 bridge.js 的
     * 占位符 —— 脚本本体保持"可被任何环境原样执行"，本机验收脚本也用同一份。
     *
     * 端口变更（Node 重启）时会再注一次：文档开始脚本按注册顺序执行，
     * 后注册的会覆盖 `window.__T1000_CONFIG__`，所以最后一次一定生效。
     */
    private fun injectBridge() {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            // 老 WebView（Chromium < 89）不支持文档开始脚本。
            // 这里如实报错而不是静默降级：没有桥，界面等于不能用，
            // 用户应当看到明确提示而不是一屏白。
            Log.e(TAG, "当前 WebView 不支持 document-start 脚本，无法注入桥")
            T1000App.publishFatal("系统 WebView 版本过旧，请更新 Android System WebView 后重试")
            return
        }

        val bridgeJs = assets.open("inject/bridge.js").bufferedReader().use { it.readText() }
        val config = "window.__T1000_CONFIG__ = ${bridgeConfigJson()};"

        val script = "$config\n$bridgeJs"
        WebViewCompat.addDocumentStartJavaScript(webView, script, setOf("*"))
        Log.i(TAG, "桥注入脚本已注册（${script.length} 字节，port=${T1000App.bridgePort}）")
    }

    private fun bridgeConfigJson(): String {
        // testHook 与 NodeRuntime 用同一个构建期开关：渲染层的 testHook
        // 只有主进程真的开了才该是 true，否则界面会去调不存在的能力
        val testHook = BuildConfig.T1000_TEST_HOOK
        return """
            {"port":${T1000App.bridgePort},"token":"${T1000App.bridgeToken}","testHook":$testHook}
        """.trimIndent()
    }

    // ── 加载与桥连接 ──────────────────────────────────────

    private fun awaitBridgeThenLoad() {
        T1000App.onPortReady { port ->
            runOnUiThread {
                if (isFinishing || isDestroyed) return@runOnUiThread
                Log.i(TAG, "端口就绪 $port，开始连接")

                // 原生通道：Node → Kotlin 的反向调用
                val handler = NativeHandler(this) { if (isFinishing) null else this }
                bridge = BridgeClient(handler) {
                    // 断开后不自己重连：端口可能已经变了，
                    // 由 NodeRuntime 的新端口通知驱动重建（避免抢跑）
                    Log.w(TAG, "原生通道断开，等待端口变更事件")
                }
                bridge?.connect(port, T1000App.bridgeToken)

                // pty 输出走同一条原生通道（反过来：Kotlin → Node 的推送）。
                // 必须在 connect 之前/之后都设一次，因为 Node 侧重连后 sink 要指向新 socket
                bridge?.let { b -> PtyManager.sink = { type, payload -> b.notify(type, payload) } }

                // 桥必须带着真实端口注入，且必须在 loadUrl 之前
                injectBridge()

                if (!loaded) {
                    loaded = true
                    webView.loadUrl(START_URL)
                    Log.i(TAG, "加载界面 $START_URL")
                } else {
                    // Node 重启过：页面里还是旧端口的桥连接，必须重载
                    Log.w(TAG, "端口变更，重新加载界面")
                    webView.reload()
                }
            }
        }

        // 最终兜底：既没失败回调、也没加载成功（例如子进程卡死不退出）。
        // 到点就把现有的信息摆出来，别让用户对着黑屏猜。
        webView.postDelayed({
            if (!loaded && !fatalShown) {
                val reason = T1000App.fatalReason
                    ?: "Node 运行时在 35 秒内没有就绪（子进程可能卡住或反复崩溃，原因见下方日志）"
                showFatalPage(reason)
            }
        }, 35_000)
    }

    /** 供 Node 侧 `window.load` 调用 */
    fun loadPage(url: String) {
        runOnUiThread {
            loaded = true
            webView.loadUrl(url)
        }
    }

    /** 供 Node 侧 `window.load`（loadFile）调用：把私有目录路径映射回 assets URL */
    fun loadAssetFile(file: String) {
        val rel = file.substringAfter("/assets/", "")
            .ifEmpty { file.removePrefix(filesDir.absolutePath).trimStart('/') }
        val url = "https://$ASSET_DOMAIN/assets/$rel"
        loadPage(url)
    }

    private fun reportScreen() {
        val b = bridge ?: return
        val dm = resources.displayMetrics
        val w = webView.width.takeIf { it > 0 } ?: dm.widthPixels
        val h = webView.height.takeIf { it > 0 } ?: dm.heightPixels
        b.reportScreen(w, h, dm.density)
    }

    // ── 系统栏 ────────────────────────────────────────────

    private fun hideSystemBars() {
        WindowInsetsControllerCompat(window, window.decorView).apply {
            hide(WindowInsetsCompat.Type.systemBars())
            systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        }
    }

    // ── 返回键 ────────────────────────────────────────────

    /**
     * 返回键语义（对齐桌面端的"关闭窗口 = 最小化到托盘"）：
     * 先让页面处理（它可能要关弹层/关闭标签），页面不处理就退到后台
     * **而不是销毁 Activity** —— 销毁会连带杀掉 Node 进程，
     * 用户切回来就发现所有会话都断了。
     */
    override fun onKeyDown(keyCode: Int, event: KeyEvent?): Boolean {
        if (keyCode == KeyEvent.KEYCODE_BACK) {
            webView.evaluateJavascript(
                "(function(){ if (window.__t1000HandleBack) { return window.__t1000HandleBack() ? '1' : '0' } return '0' })()",
            ) { result ->
                if (result?.contains("1") != true) {
                    moveTaskToBack(true)
                }
            }
            return true
        }
        // 硬件键盘：把按键透传给页面（外接键盘是平板的主力输入方式）
        return super.onKeyDown(keyCode, event)
    }

    // ── 文件选择（供 NativeHandler 调用）────────────────

    suspend fun pickDocuments(directory: Boolean, multiple: Boolean): List<Uri> =
        withContext(Dispatchers.Main) {
            pickDirectory = directory
            pickMultiple = multiple
            val deferred = CompletableDeferred<List<Uri>>()
            pickDeferred = deferred
            try {
                when {
                    directory -> pickTreeLauncher.launch(null)
                    multiple -> pickFilesLauncher.launch(arrayOf("*/*"))
                    else -> pickFileLauncher.launch(arrayOf("*/*"))
                }
            } catch (t: ActivityNotFoundException) {
                Log.e(TAG, "没有可用的文件选择器", t)
                pickDeferred = null
                return@withContext emptyList()
            }
            deferred.await()
        }

    suspend fun createDocument(name: String): Uri? = withContext(Dispatchers.Main) {
        val deferred = CompletableDeferred<Uri?>()
        createDocDeferred = deferred
        try {
            createDocLauncher.launch(name)
        } catch (t: ActivityNotFoundException) {
            createDocDeferred = null
            return@withContext null
        }
        deferred.await()
    }

    /** 记住"导出目标 URI → 本地路径"，主进程写完后由 [flushExport] 拷回去 */
    fun registerPendingExport(uri: Uri, local: File) {
        synchronized(pendingExports) { pendingExports[local.absolutePath] = uri }
    }

    /**
     * 把主进程写好的本地文件复制到用户选定的 URI。
     *
     * 为什么需要这一步：`ACTION_CREATE_DOCUMENT` 给的是 `content://`，
     * Node 侧无法写入；所以主进程写本地、我们负责回填。
     * 由渲染层在导出完成后调 `app.exportDone` 触发（M3 接入）。
     */
    fun flushExport(localPath: String): Boolean {
        val uri = synchronized(pendingExports) { pendingExports.remove(localPath) } ?: return false
        val local = File(localPath)
        if (!local.exists()) return false
        return runCatching {
            contentResolver.openOutputStream(uri)?.use { out ->
                local.inputStream().use { it.copyTo(out, 64 * 1024) }
            }
            true
        }.getOrElse {
            Log.e(TAG, "回填导出文件失败", it)
            false
        }
    }

    suspend fun showChoiceDialog(
        title: String,
        message: String,
        detail: String,
        buttons: Array<String>,
        defaultIndex: Int,
    ): Int = withContext(Dispatchers.Main) {
        suspendCancellableCoroutine { cont ->
            val body = if (detail.isNotBlank()) "$message\n\n$detail" else message
            AlertDialog.Builder(this@MainActivity)
                .setTitle(title)
                .setMessage(body)
                .setCancelable(false)
                .apply {
                    // 用 positive/negative/neutral 三个槽位承载最常见的 1~3 个按钮，
                    // 更多按钮时退化为列表（Electron 那边也很少超过 3 个）
                    val b0 = buttons.getOrNull(0)
                    val b1 = buttons.getOrNull(1)
                    val b2 = buttons.getOrNull(2)
                    if (b0 != null) setPositiveButton(b0) { _, _ -> cont.resume(0) }
                    if (b1 != null) setNegativeButton(b1) { _, _ -> cont.resume(1) }
                    if (b2 != null) setNeutralButton(b2) { _, _ -> cont.resume(2) }
                }
                .show()
        }
    }

    /**
     * 拦截 assets 请求，对 HTML 放宽 CSP。
     *
     * 只改 `connect-src` 一条：桌面端的 CSP 不允许连回环 WS（Electron 走 IPC，
     * 不需要网络），而 Android 上的桥就是 WS。其余策略（禁止远程脚本、
     * 禁止 inline eval）保持原样 —— 渲染层本来就是按这个约束构建的。
     */
    private class CspPathHandler(
        private val inner: WebViewAssetLoader.PathHandler,
    ) : WebViewAssetLoader.PathHandler {
        override fun handle(path: String): WebResourceResponse? {
            val res = inner.handle(path) ?: return null
            if (!path.endsWith(".html") && !path.endsWith(".htm")) return res

            val original = res.data?.readBytes() ?: return res
            val html = original.toString(Charsets.UTF_8)
            val patched = html.replace(
                "connect-src 'self'",
                "connect-src 'self' ws://127.0.0.1:* http://127.0.0.1:*",
            )
            return WebResourceResponse(
                "text/html",
                "utf-8",
                200,
                "OK",
                res.responseHeaders ?: emptyMap(),
                ByteArrayInputStream(patched.toByteArray(Charsets.UTF_8)),
            )
        }
    }
}
