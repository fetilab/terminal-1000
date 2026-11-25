// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

package dev.t1000.android

import android.util.Log
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/**
 * 连到 node host 的 `/native` 通道（Node → Kotlin 的反向 RPC）。
 *
 * 协议（与 node-host/src/shim/native.ts 对应）：
 * - Node → 我们：`{ id, method, params }`
 * - 我们 → Node：`{ id, ok, data }` 或 `{ id, ok: false, error }`
 * - 我们 → Node（通知）：`{ type: 'screen', screen: { width, height, density } }`
 *
 * 重连策略：Node 可能因为内存压力被系统杀掉并由 [NodeRuntime] 重启，
 * 端口也会变。所以这里记录"当前期望端口"，断开后由外部在拿到新端口时重建。
 * 不自己轮询端口 —— 那是 Runtime 的职责，避免两处竞态。
 */
class BridgeClient(
    private val handler: NativeHandler,
    private val onClosed: () -> Unit,
) {
    companion object {
        private const val TAG = "T1000Bridge"
        private const val NORMAL_CLOSURE = 1000

        /**
         * 发送队列上限（字节）。超过就阻塞生产端。
         *
         * 取值理由：一屏终端渲染最多吃到几 MB；8MB 足够吸收突发（ls -R / 编译输出），
         * 又不至于让内存出现肉眼可见的抖动。
         */
        private const val BACKPRESSURE_BYTES = 8L * 1024 * 1024
    }

    private val client = OkHttpClient.Builder()
        // 回环连接，不需要超时保护；但要有 ping 保活，防止被系统当"空闲连接"掐掉
        .pingInterval(20, TimeUnit.SECONDS)
        .connectTimeout(5, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .build()

    private var socket: WebSocket? = null

    @Volatile
    var connected: Boolean = false
        private set

    fun connect(port: Int, token: String) {
        disconnect()
        val url = "ws://${T1000App.BRIDGE_HOST}:$port/native?token=$token"
        Log.i(TAG, "连接原生通道 127.0.0.1:$port")
        val request = Request.Builder().url(url).build()
        socket = client.newWebSocket(request, Listener())
    }

    fun disconnect() {
        socket?.close(NORMAL_CLOSURE, "bye")
        socket = null
        connected = false
    }

    /** 上报屏幕信息：Node 侧用它模拟 BrowserWindow 的尺寸与 DPI */
    fun reportScreen(width: Int, height: Int, density: Float) {
        val ws = socket ?: return
        val msg = JSONObject().apply {
            put("type", "screen")
            put(
                "screen",
                JSONObject().apply {
                    put("width", width)
                    put("height", height)
                    put("density", density)
                },
            )
        }
        runCatching { ws.send(msg.toString()) }
    }

    /**
     * 推送任意类型事件（`{ type, ...payload }`）。
     *
     * **带背压**：pty 输出可能是 `cat 大文件` 这种无上限的洪水，若一路塞进
     * OkHttp 的发送队列，几十兆数据会先堆在内存里，最后以 OOM 收场。
     * 这里在队列积压时主动阻塞调用线程（pty 的读取线程），
     * 让内核 pty 缓冲区回满、再让子进程的 write 阻塞 —— 这才是终端应有的流控。
     */
    fun notify(type: String, payload: JSONObject) {
        val ws = socket ?: return
        var waited = 0L
        while (ws.queueSize() > BACKPRESSURE_BYTES) {
            // 最多等 5 秒：真卡死时宁可丢这一段，也不能让界面完全停摆
            if (waited >= 5000) {
                Log.w(TAG, "发送队列积压 ${ws.queueSize()} 字节，丢弃一帧 $type")
                return
            }
            try {
                Thread.sleep(2)
            } catch (e: InterruptedException) {
                Thread.currentThread().interrupt()
                return
            }
            waited += 2
        }
        val msg = payload.apply { put("type", type) }
        runCatching { ws.send(msg.toString()) }
            .onFailure { Log.w(TAG, "推送 $type 失败: ${it.message}") }
    }

    private inner class Listener : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) {
            connected = true
            Log.i(TAG, "原生通道已连上")
            handler.onBridgeConnected()
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
            val msg = runCatching { JSONObject(text) }.getOrNull() ?: return
            val id = msg.optInt("id", -1)
            if (id < 0) return
            val method = msg.optString("method", "")
            val params = msg.optJSONObject("params") ?: JSONObject()

            // 处理是异步的（可能要等用户从文件选择器返回），但**必须保证每个请求都有回包**：
            // Node 侧每个调用都有超时，漏回包会让界面卡住直到超时，表现为"点按钮没反应"
            if (method.startsWith("pty.")) {
                // pty 的动作都必须"立即返回"（写入只是入队、resize 是 ioctl）。
                // 键盘输入是高频路径，每敲一个键起一个线程是纯粹的浪费 ——
                // 这里直接在 WS 线程上处理，保持输入延迟稳定。
                val reply = JSONObject().apply { put("id", id) }
                try {
                    val data = handler.handleBlocking(method, params)
                    reply.put("ok", true)
                    reply.put("data", data ?: JSONObject())
                } catch (t: Throwable) {
                    Log.e(TAG, "处理 $method 失败", t)
                    reply.put("ok", false)
                    reply.put("error", t.message ?: t::class.java.simpleName)
                }
                runCatching { webSocket.send(reply.toString()) }
                return
            }

            Thread({
                val reply = JSONObject().apply { put("id", id) }
                try {
                    val data = handler.handleBlocking(method, params)
                    reply.put("ok", true)
                    reply.put("data", data ?: JSONObject())
                } catch (t: Throwable) {
                    Log.e(TAG, "处理 $method 失败", t)
                    reply.put("ok", false)
                    reply.put("error", t.message ?: t::class.java.simpleName)
                }
                runCatching { webSocket.send(reply.toString()) }
            }, "t1000-native-$method").start()
        }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            connected = false
            Log.w(TAG, "原生通道断开: ${t.message}")
            onClosed()
        }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
            connected = false
            Log.i(TAG, "原生通道关闭: $code $reason")
            onClosed()
        }
    }
}
