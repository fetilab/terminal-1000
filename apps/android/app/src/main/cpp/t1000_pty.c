// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 伪终端（pty）原生层。
 *
 * 为什么不是 node-pty：
 * node-pty 是 NAN 原生模块，必须针对目标 Node 的 NODE_MODULE_VERSION 编译，
 * 还需要该版本 Node 的完整头文件。Android 侧的 Node 来自 Termux，包里**不带**
 * 头文件，走 addon 路线等于把自己绑死在一个拿不到头文件的 ABI 上。
 *
 * bionic 从 API 23 起自带 openpty/forkpty（见 NDK sysroot 的 pty.h），
 * 所以直接在这里 forkpty + execve 就行 —— 不依赖任何 Node 头文件，
 * ABI 只有 NDK 自己那一套，升级 Node 时不需要重编。
 *
 * 这里只做"系统调用薄封装"，业务逻辑（会话表、读取线程、事件上报）在 Kotlin。
 * 每个函数都必须返回明确结果，绝不静默失败：pty 起不来是"终端打不开"，
 * 必须让上层拿到 errno 才能给出人话提示。
 */

#define _GNU_SOURCE
#include <jni.h>

#include <errno.h>
#include <fcntl.h>
#include <pty.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/wait.h>
#include <termios.h>
#include <unistd.h>

#define T1000_PTY_TAG "t1000_pty"

/** 把 Java 字符串转成可安全用于 exec 的 C 字符串（拷贝，调用方负责 free） */
static char *dup_jstring(JNIEnv *env, jstring s) {
    if (s == NULL) return NULL;
    const char *utf = (*env)->GetStringUTFChars(env, s, NULL);
    if (utf == NULL) return NULL;
    char *copy = strdup(utf);
    (*env)->ReleaseStringUTFChars(env, s, utf);
    return copy;
}

/** jobjectArray<String> → char**（NULL 结尾）。失败返回 NULL 并已清空 out_count */
static char **dup_jstring_array(JNIEnv *env, jobjectArray arr, int *out_count) {
    *out_count = 0;
    if (arr == NULL) {
        char **empty = calloc(1, sizeof(char *));
        return empty;
    }
    jsize n = (*env)->GetArrayLength(env, arr);
    char **out = calloc((size_t)n + 1, sizeof(char *));
    if (out == NULL) return NULL;
    for (jsize i = 0; i < n; i++) {
        jstring item = (jstring)(*env)->GetObjectArrayElement(env, arr, i);
        out[i] = dup_jstring(env, item);
        (*env)->DeleteLocalRef(env, item);
        if (out[i] == NULL) {
            for (jsize k = 0; k < i; k++) free(out[k]);
            free(out);
            return NULL;
        }
    }
    *out_count = (int)n;
    return out;
}

static void free_string_array(char **arr, int count) {
    if (arr == NULL) return;
    for (int i = 0; i < count; i++) free(arr[i]);
    free(arr);
}

/**
 * 起一个 pty 会话。
 *
 * 返回子进程 pid（>0），失败返回 -errno。
 * outFd[0] 会被写成 master 端 fd —— 调用方只持有它，slave 端已交给子进程。
 *
 * 子进程里只能调用 async-signal-safe 的函数（fork 之后 JVM 的锁状态未知），
 * 所以这里不调用任何 JNI/Java，只用 setsid/ioctl/dup2/chdir/execve 这些系统调用。
 */
JNIEXPORT jint JNICALL
Java_dev_t1000_android_PtyNative_nativeSpawn(JNIEnv *env, jclass clazz,
                                             jobjectArray argv, jobjectArray envp,
                                             jstring jcwd, jint cols, jint rows,
                                             jintArray outFd) {
    (void)clazz;

    int argc = 0, envc = 0;
    char **cargv = dup_jstring_array(env, argv, &argc);
    char **cenvp = dup_jstring_array(env, envp, &envc);
    char *cwd = dup_jstring(env, jcwd);

    if (cargv == NULL || cargv[0] == NULL || cenvp == NULL) {
        free_string_array(cargv, argc);
        free_string_array(cenvp, envc);
        free(cwd);
        return -EINVAL;
    }

    struct winsize ws;
    memset(&ws, 0, sizeof(ws));
    ws.ws_col = (unsigned short)(cols > 0 ? cols : 80);
    ws.ws_row = (unsigned short)(rows > 0 ? rows : 24);
    ws.ws_xpixel = 0;
    ws.ws_ypixel = 0;

    int master = -1;
    int slave = -1;
    if (openpty(&master, &slave, NULL, NULL, &ws) != 0) {
        int err = errno;
        free_string_array(cargv, argc);
        free_string_array(cenvp, envc);
        free(cwd);
        return -err;
    }
    (void)fcntl(master, F_SETFD, FD_CLOEXEC);

    pid_t pid = fork();
    if (pid < 0) {
        int err = errno;
        close(master);
        close(slave);
        free_string_array(cargv, argc);
        free_string_array(cenvp, envc);
        free(cwd);
        return -err;
    }

    if (pid == 0) {
        /* ── 子进程：只允许系统调用 ── */

        /* 关键：把信号处置与信号掩码重置为默认。
         *
         * 从 Zygote fork 出来的 Android 应用进程里，SIGHUP 是 SIG_IGN
         * （zygote 与 ART 都忽略它来防止意外退出），而 **execve 会保留
         * "被忽略"的处置**。结果就是 shell 从第一条指令起就忽略 SIGHUP，
         * 之后 `kill -HUP` 完全无效 —— 症状是"点了关闭，终端一直挂着"。
         * 只重置掩码不够，必须显式把每个信号设回 SIG_DFL。 */
        struct sigaction dfl;
        memset(&dfl, 0, sizeof(dfl));
        dfl.sa_handler = SIG_DFL;
        sigemptyset(&dfl.sa_mask);
        for (int sig = 1; sig < NSIG; sig++) {
            /* SIGKILL/SIGSTOP 不可捕获，设了也无害；跳过以免多余的系统调用报错 */
            if (sig == SIGKILL || sig == SIGSTOP) continue;
            sigaction(sig, &dfl, NULL);
        }
        sigset_t empty;
        sigemptyset(&empty);
        sigprocmask(SIG_SETMASK, &empty, NULL);

        close(master);
        setsid();
        /* 把自己提到新会话首进程后，再把这个 tty 认作控制终端。
         * 少了这一步，Ctrl+C 产生的 SIGINT 送不到前台进程组，
         * 表现就是"按 Ctrl+C 不管用"。 */
        ioctl(slave, TIOCSCTTY, 0);

        if (dup2(slave, STDIN_FILENO) < 0 || dup2(slave, STDOUT_FILENO) < 0 ||
            dup2(slave, STDERR_FILENO) < 0) {
            _exit(126);
        }
        if (slave > STDERR_FILENO) close(slave);

        if (cwd != NULL && cwd[0] != '\0') {
            if (chdir(cwd) != 0) chdir("/");
        }

        execve(cargv[0], cargv, cenvp);
        /* exec 失败：给上层一个可辨认的退出码，并留一行到 stderr
         * （stderr 是 pty，用户会直接在终端里看到） */
        const char *msg = "t1000: 无法执行 ";
        if (write(STDERR_FILENO, msg, strlen(msg)) < 0) {}
        if (write(STDERR_FILENO, cargv[0], strlen(cargv[0])) < 0) {}
        if (write(STDERR_FILENO, "\r\n", 2) < 0) {}
        _exit(127);
    }

    /* ── 父进程 ── */
    close(slave);
    free_string_array(cargv, argc);
    free_string_array(cenvp, envc);
    free(cwd);

    jint fd = (jint)master;
    (*env)->SetIntArrayRegion(env, outFd, 0, 1, &fd);
    return (jint)pid;
}

/** 读 master。返回字节数；0 = EOF；-1 = 出错（errno 见 -2 之后的约定） */
JNIEXPORT jint JNICALL
Java_dev_t1000_android_PtyNative_nativeRead(JNIEnv *env, jclass clazz, jint fd,
                                            jbyteArray buf) {
    (void)clazz;
    jsize cap = (*env)->GetArrayLength(env, buf);
    if (cap <= 0) return 0;

    jbyte *raw = (*env)->GetByteArrayElements(env, buf, NULL);
    if (raw == NULL) return -EIO;

    ssize_t n;
    do {
        n = read((int)fd, raw, (size_t)cap);
    } while (n < 0 && errno == EINTR);

    int err = errno;
    (*env)->ReleaseByteArrayElements(env, buf, raw, n > 0 ? 0 : JNI_ABORT);
    if (n < 0) return (err == EIO || err == EBADF) ? 0 : -err;
    return (jint)n;
}

/** 写 master。返回写入字节数；<0 为 -errno */
JNIEXPORT jint JNICALL
Java_dev_t1000_android_PtyNative_nativeWrite(JNIEnv *env, jclass clazz, jint fd,
                                             jbyteArray buf, jint len) {
    (void)clazz;
    if (len <= 0) return 0;

    jbyte *raw = (*env)->GetByteArrayElements(env, buf, NULL);
    if (raw == NULL) return -EIO;

    ssize_t written = 0;
    while (written < len) {
        ssize_t n = write((int)fd, raw + written, (size_t)(len - written));
        if (n < 0) {
            if (errno == EINTR) continue;
            int err = errno;
            (*env)->ReleaseByteArrayElements(env, buf, raw, JNI_ABORT);
            return -err;
        }
        written += n;
    }

    (*env)->ReleaseByteArrayElements(env, buf, raw, JNI_ABORT);
    return (jint)written;
}

JNIEXPORT jint JNICALL
Java_dev_t1000_android_PtyNative_nativeResize(JNIEnv *env, jclass clazz, jint fd,
                                              jint cols, jint rows) {
    (void)env;
    (void)clazz;
    struct winsize ws;
    memset(&ws, 0, sizeof(ws));
    ws.ws_col = (unsigned short)(cols > 0 ? cols : 80);
    ws.ws_row = (unsigned short)(rows > 0 ? rows : 24);
    if (ioctl((int)fd, TIOCSWINSZ, &ws) != 0) return -errno;
    /* 尺寸变化要通知前台进程组，否则 vim/htop 不会重排 */
    return 0;
}

JNIEXPORT void JNICALL
Java_dev_t1000_android_PtyNative_nativeClose(JNIEnv *env, jclass clazz, jint fd) {
    (void)env;
    (void)clazz;
    if (fd >= 0) close((int)fd);
}

/**
 * 阻塞等待子进程退出。
 *
 * 返回值约定：
 * - `>= 0`：正常退出，值为退出码
 * - `-1 … -64`：被信号杀死，值为 `-signo`
 * - `-256`：waitpid 本身失败（pid 不属于本进程等）
 *
 * 这样"退出码"和"哪个信号"这一对信息都不会丢，上层才能如实回报，
 * 而不是把所有异常退出都糊成同一个数字。
 */
JNIEXPORT jint JNICALL
Java_dev_t1000_android_PtyNative_nativeWait(JNIEnv *env, jclass clazz, jint pid) {
    (void)env;
    (void)clazz;
    int status = 0;
    pid_t r;
    do {
        r = waitpid((pid_t)pid, &status, 0);
    } while (r < 0 && errno == EINTR);

    if (r < 0) return -256;
    if (WIFEXITED(status)) return WEXITSTATUS(status);
    if (WIFSIGNALED(status)) return -(int)WTERMSIG(status);
    return -256;
}

/** 给整个进程组发信号（调用方传 -pid 前请用 nativeKillGroup） */
JNIEXPORT jint JNICALL
Java_dev_t1000_android_PtyNative_nativeKill(JNIEnv *env, jclass clazz, jint pid,
                                            jint sig) {
    (void)env;
    (void)clazz;
    /* pty 会话里子进程是 session leader + pgrp leader，
     * 所以要打整个组，否则 shell 里正在跑的前台程序收不到 */
    if (killpg((pid_t)pid, sig) == 0) return 0;
    if (errno == ESRCH) {
        if (kill((pid_t)pid, sig) == 0) return 0;
    }
    return -errno;
}

/** 探测该 fd 是不是有效 pty（用于启动自检） */
JNIEXPORT jint JNICALL
Java_dev_t1000_android_PtyNative_nativeProbe(JNIEnv *env, jclass clazz, jint fd) {
    (void)env;
    (void)clazz;
    struct termios t;
    if (tcgetattr((int)fd, &t) != 0) return -errno;
    return 0;
}

JNIEXPORT jstring JNICALL
Java_dev_t1000_android_PtyNative_nativeVersion(JNIEnv *env, jclass clazz) {
    (void)clazz;
    return (*env)->NewStringUTF(env, "t1000-pty/1");
}
