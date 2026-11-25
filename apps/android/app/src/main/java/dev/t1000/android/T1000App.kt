// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

package dev.t1000.android

import android.app.Application
import android.util.Log
import java.security.SecureRandom
import java.util.concurrent.CopyOnWriteArrayList

/**
 * 应用级单例：持有桥的端口与令牌，以及"Node 是否就绪"的观察者。
 *
 * 为什么要放在 Application 而不是 Service/Activity：
 * - **Service 可能先于 Activity 启动**（应用被杀后从通知恢复），也可能后启动；
 * - **Activity 可能被重建**（配置变更、系统回收），而 Node 进程不该跟着重启；
 * - 桥的端口/令牌是"整个进程一份"的资源，天然属于 Application 作用域。
 *
 * 令牌在每次进程启动时重新生成（不是持久化的）：
 * 它只需要阻止"同机其它 App 连进来"，不需要跨进程存活。
 * 每次重生成还顺带解决了"旧 token 泄漏"的问题。
 */
class T1000App : Application() {

    companion object {
        private const val TAG = "T1000App"

        @Volatile
        lateinit var self: T1000App
            private set

        /** 回环桥的鉴权令牌（进程内固定） */
        @Volatile
        var bridgeToken: String = ""
            private set

        /** 回环桥端口；0 表示 Node 还没就绪 */
        @Volatile
        var bridgePort: Int = 0
            private set

        /**
         * Node 彻底启动失败的原因（重试用尽）。
         *
         * 放在这里而不是抛异常：启动发生在 Service 线程，异常没人接；
         * 界面在任意时刻创建都能读到它并显示给用户 —— 否则用户只看到白屏。
         */
        @Volatile
        var fatalReason: String? = null

        /** 注意：Android 上只能监听 127.0.0.1，绝不能用 0.0.0.0（平板常连公共 Wi-Fi） */
        const val BRIDGE_HOST = "127.0.0.1"

        private val portObservers = CopyOnWriteArrayList<(Int) -> Unit>()

        fun onPortReady(observer: (Int) -> Unit) {
            val current = bridgePort
            if (current > 0) {
                observer(current)
            } else {
                portObservers.add(observer)
            }
        }

        fun publishPort(port: Int) {
            bridgePort = port
            Log.i(TAG, "桥端口就绪: $port")
            val snapshot = portObservers.toList()
            portObservers.clear()
            for (o in snapshot) {
                runCatching { o(port) }
            }
        }

        /** Node 进程重启后端口会变，界面需要重新加载（见 MainActivity 的重连处理） */
        fun publishPortChanged(port: Int) {
            bridgePort = port
            Log.w(TAG, "桥端口变更: $port")
            val snapshot = portObservers.toList()
            portObservers.clear()
            for (o in snapshot) {
                runCatching { o(port) }
            }
        }
    }

    override fun onCreate() {
        super.onCreate()
        self = this
        bridgeToken = generateToken()
        Log.i(TAG, "进程启动，已生成新桥令牌（长度 ${bridgeToken.length}）")
    }

    private fun generateToken(): String {
        val bytes = ByteArray(32)
        SecureRandom().nextBytes(bytes)
        val sb = StringBuilder(bytes.size * 2)
        for (b in bytes) {
            sb.append("0123456789abcdef"[(b.toInt() shr 4) and 0xF])
            sb.append("0123456789abcdef"[b.toInt() and 0xF])
        }
        return sb.toString()
    }
}
