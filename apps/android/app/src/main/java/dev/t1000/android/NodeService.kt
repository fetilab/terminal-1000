// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

package dev.t1000.android

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import android.util.Log

/**
 * 承载 Node 进程的前台服务。
 *
 * 为什么必须是**前台**服务：
 * 后台服务在 Android 8+ 会被随时冻结/杀掉，而终端应用恰恰要在用户切走之后
 * 继续跑（长任务、SSH 会话、文件传输）。前台服务是系统认可的"用户知情的长任务"，
 * 也是唯一稳定的保活途径 —— 副作用是必须有常驻通知，这在本场景里是合理的：
 * 用户确实需要知道"终端还在跑"。
 *
 * 注意 `startForeground` 必须在 `onStartCommand` 里**尽快**调用（系统给 5 秒），
 * 否则 ANR。所以先起通知，再去启动 Node（后者可能要解包上百个文件）。
 */
class NodeService : Service() {

    companion object {
        private const val TAG = "T1000Service"
        private const val CHANNEL_ID = "t1000_runtime"
        private const val NOTIFICATION_ID = 1001

        fun start(context: Context) {
            val intent = Intent(context, NodeService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, NodeService::class.java))
        }
    }

    private lateinit var runtime: NodeRuntime

    override fun onCreate() {
        super.onCreate()
        runtime = NodeRuntime(this)
        createChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // 先上通知：系统只给 5 秒，而解包 assets 可能要 1–2 秒
        startForeground(NOTIFICATION_ID, buildNotification())

        runtime.start(
            onPortReady = { port -> Log.i(TAG, "Node 桥就绪: $port") },
            onFatal = { reason ->
                Log.e(TAG, "Node 启动失败: $reason")
                // 把失败原因留给界面显示（Application 单例里读）
                T1000App.fatalReason = reason
            },
        )

        // START_STICKY：被系统杀掉后尝试重启。真正的重启逻辑在 NodeRuntime 里，
        // 这里只是让系统在内存回收后再拉起一次服务。
        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        Log.i(TAG, "服务销毁，停止 Node")
        runtime.stop()
        super.onDestroy()
    }

    private fun createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val mgr = getSystemService(NotificationManager::class.java)
        if (mgr.getNotificationChannel(CHANNEL_ID) != null) return
        val channel = NotificationChannel(
            CHANNEL_ID,
            getString(R.string.notification_channel_name),
            // LOW：不发声、不弹横幅。这条通知是"状态指示"而不是"打扰"
            NotificationManager.IMPORTANCE_LOW,
        ).apply {
            description = getString(R.string.notification_channel_desc)
            setShowBadge(false)
            enableVibration(false)
        }
        mgr.createNotificationChannel(channel)
    }

    private fun buildNotification(): Notification {
        val open = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        val flags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        } else {
            PendingIntent.FLAG_UPDATE_CURRENT
        }
        val contentIntent = PendingIntent.getActivity(this, 0, open, flags)

        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(this, CHANNEL_ID)
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(this)
        }
        return builder
            .setContentTitle(getString(R.string.notification_title))
            .setContentText(getString(R.string.notification_text))
            .setSmallIcon(R.drawable.ic_stat_terminal)
            .setContentIntent(contentIntent)
            .setOngoing(true)
            .setShowWhen(false)
            .build()
    }
}
