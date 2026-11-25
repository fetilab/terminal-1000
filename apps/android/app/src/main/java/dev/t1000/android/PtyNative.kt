// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

package dev.t1000.android

/**
 * JNI 绑定：`libt1000pty.so`（源码见 `src/main/cpp/t1000_pty.c`）。
 *
 * 只做系统调用转接，不含任何业务逻辑 —— 会话表、线程、事件上报都在
 * [PtyManager]。这样 C 侧保持"无状态、无线程"，调试时只看 errno 就够。
 */
internal object PtyNative {
    const val TAG = "T1000Pty"

    init {
        System.loadLibrary("t1000pty")
    }

    /**
     * 起 pty 会话。
     *
     * @return 子进程 pid（>0）；失败为 -errno（如 -13 = EACCES）
     */
    external fun nativeSpawn(
        argv: Array<String>,
        envp: Array<String>,
        cwd: String,
        cols: Int,
        rows: Int,
        /** 出参：下标 0 写入 master fd */
        outFd: IntArray,
    ): Int

    /** @return 读到的字节数，0=EOF，负=-errno */
    external fun nativeRead(fd: Int, buf: ByteArray): Int

    /** @return 写入字节数，负=-errno */
    external fun nativeWrite(fd: Int, buf: ByteArray, len: Int): Int

    external fun nativeResize(fd: Int, cols: Int, rows: Int): Int

    external fun nativeClose(fd: Int)

    /** 阻塞等到子进程退出：正常退出为 code，被信号杀死为 128+sig */
    external fun nativeWait(pid: Int): Int

    external fun nativeKill(pid: Int, sig: Int): Int

    external fun nativeProbe(fd: Int): Int

    external fun nativeVersion(): String
}
