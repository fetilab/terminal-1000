// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * Android 上的「真 Linux 环境」：proot + Alpine rootfs。
 *
 * 为什么是 proot 而不是 chroot / 容器：
 * - 非 root 应用不能 chroot；
 * - Android 内核从 4.14 起默认关闭 user namespace（`CONFIG_USER_NS` 基本不开，
 *   且 App 的 seccomp 也不放行 `unshare(CLONE_NEWNS)`），所以 bwrap / podman 都不行；
 * - proot 是纯 ptrace 实现的"系统调用翻译器"，不需要任何特权。
 *   代价是每次系统调用都要停一次，性能约为原生的 1/3～1/2 —— 交互式 shell
 *   和 git/python 这类工作负载完全够用，编译大项目会明显慢。
 *
 * 这一层只负责**拼命令行**，不负责解包 rootfs（那是 Kotlin 的 RootfsManager 的事），
 * 也不负责 spawn（沿用现有的 pty 服务）。这样：
 * - 单测可以在桌面机上断言拼出来的 argv，而不需要真的跑 proot；
 * - rootfs 没准备好时，调用方可以干净地回退到 `/system/bin/sh`。
 */

import type { PtyProfile } from './shells'

/** guest 里的标准 PATH（Alpine 的 shell 全在这几个目录） */
export const ALPINE_GUEST_PATH =
  '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'

/** proot 运行时需要的目录布局 */
export interface AlpineLayout {
  /** rootfs 根目录（proot -r 的参数） */
  rootfs: string
  /** proot 主程序（nativeLibraryDir 里的 libproot.so） */
  proot: string
  /** proot 的 loader（静态链接的小 ELF，必须能 exec） */
  loader: string
  /** proot 自己的临时目录（它要在里面放 socket / 临时 rootfs） */
  tmp: string
  /** 原生库目录（libtalloc.so / libandroid-shmem.so 在这） */
  libDir: string
}

/** 拼 args 时需要知道"哪些宿主路径存在"（注入，便于单测） */
export interface AlpineIo {
  exists(path: string): boolean
  /** 不跟随符号链接的存在性判断（见下方 [entryExists] 的说明） */
  existsNoFollow?(path: string): boolean
  env(name: string): string | undefined
}

/**
 * rootfs 内的路径是否存在 —— **不跟随符号链接**。
 *
 * Alpine 里几乎所有"命令"都是绝对路径的符号链接（`/bin/sh → /bin/busybox`、
 * `/bin/ash → /bin/busybox`）。这些链接从宿主看一定是断的（宿主没有 /bin/busybox），
 * 用 `exists()` 判断会把装好的环境判成"没装"。链接只有放进 proot 的 guest
 * 视图里才有意义，所以这里只问"条目在不在"。
 */
function entryExists(io: AlpineIo, path: string): boolean {
  return io.existsNoFollow ? io.existsNoFollow(path) : io.exists(path)
}

/**
 * 从环境变量推导布局。任一项缺失或文件不存在 → 返回 null（调用方回退系统 shell）。
 *
 * 刻意检查 `rootfs/bin/sh` 是否存在：版本戳与解包由 Kotlin 负责，
 * JS 侧只需要一个"真的能用"的判据 —— 没有 busybox 的 rootfs 跑起来也是坏的。
 */
export function alpineLayout(io: AlpineIo): AlpineLayout | null {
  const rootfs = io.env('T1000_ROOTFS')?.trim()
  const libDir = io.env('T1000_NATIVE_LIB_DIR')?.trim()
  const tmp = io.env('T1000_TEMP')?.trim()
  if (!rootfs || !libDir || !tmp) return null

  const proot = `${libDir}/libproot.so`
  const loader = `${libDir}/libproot-loader.so`
  // 这两个是我们自己放进 nativeLibraryDir 的真实文件，可以按常规判断
  if (!io.exists(proot) || !io.exists(loader)) return null
  if (!entryExists(io, `${rootfs}/bin/sh`)) return null
  return { rootfs, proot, loader, tmp, libDir }
}

/**
 * 选 guest 里的登录 shell。
 *
 * minirootfs 只有 busybox 的 ash，bash/zsh 要用户 `apk add`。
 * 所以这里按"体验优先级"探测，探测不到就退到 ash —— 而不是硬编码 bash
 * 然后让用户看到一个 exit code 127 的黑窗口。
 */
export function pickGuestShell(io: AlpineIo, rootfs: string): { shell: string; name: string } {
  const candidates: ReadonlyArray<readonly [string, string]> = [
    ['/bin/bash', 'bash'],
    ['/usr/bin/zsh', 'zsh'],
    ['/bin/zsh', 'zsh'],
    ['/bin/fish', 'fish'],
    ['/bin/ash', 'ash'],
    ['/bin/sh', 'sh'],
  ]
  for (const [path, name] of candidates) {
    if (entryExists(io, `${rootfs}${path}`)) return { shell: path, name }
  }
  return { shell: '/bin/sh', name: 'sh' }
}

/** proot 启动参数的可选部分 */
export interface ProotOptions {
  /** 假 root（`-0`）。默认开：终端里 `id` 是 root、能 `apk add`，符合直觉 */
  fakeRoot?: boolean
  /** guest 里的工作目录 */
  guestCwd?: string
  /** 额外绑定（host:guest 或单个 host 路径） */
  extraBinds?: readonly string[]
}

/**
 * 拼 proot 的参数（不含 proot 自己，最后一个元素起是要在 guest 里跑的命令）。
 */
export function buildProotArgs(
  layout: AlpineLayout,
  guestArgv: readonly string[],
  io: AlpineIo,
  options: ProotOptions = {},
): string[] {
  const args: string[] = ['--kill-on-exit', '--link2symlink']
  if (options.fakeRoot !== false) args.push('-0')
  args.push('-r', layout.rootfs)

  // /dev：终端能跑起来的前提（/dev/pts/N、/dev/null、/dev/tty、/dev/urandom）
  // /proc：ps、/proc/self/*、很多程序启动时会读
  // /sys：仅有部分工具用，但缺了会让 `lsblk` 之类直接崩，代价极小
  for (const bind of ['/dev', '/proc', '/sys']) {
    if (io.exists(bind)) args.push('-b', bind)
  }

  // 外部存储：有就挂上，方便在终端里直接操作下载目录
  if (io.exists('/storage/emulated/0')) args.push('-b', '/storage/emulated/0:/sdcard')

  for (const bind of options.extraBinds ?? []) args.push('-b', bind)

  args.push('-w', options.guestCwd ?? '/root')
  args.push(...guestArgv)
  return args
}

/**
 * 构造一个可直接交给 pty 服务的 profile。
 *
 * 注意 `cwd`：pty 服务会在**宿主**上校验 cwd 是否存在，
 * 所以这里给 rootfs 根目录而不是 `/root`（后者在宿主上不存在）；
 * guest 里的起始目录由 proot 的 `-w /root` 决定。
 */
export function alpineProfile(layout: AlpineLayout, io: AlpineIo): PtyProfile {
  const guest = pickGuestShell(io, layout.rootfs)
  // bash/zsh 用登录 shell（读 /etc/profile，PATH/提示符才正常）；
  // ash 也支持 -l
  const guestArgv = [guest.shell, '-l']
  return {
    id: 'alpine',
    name: guest.name === 'ash' || guest.name === 'sh' ? 'Alpine Linux' : `Alpine Linux（${guest.name}）`,
    shell: layout.proot,
    args: buildProotArgs(layout, guestArgv, io, { guestCwd: '/root' }),
    cwd: layout.rootfs,
    env: {
      // proot 自己的运行参数（编译期写死的是 Termux 的前缀路径，这里必须覆盖）
      PROOT_LOADER: layout.loader,
      PROOT_TMP_DIR: layout.tmp,
      // proot 与两个依赖库都在 nativeLibraryDir
      LD_LIBRARY_PATH: layout.libDir,
      // guest 侧的登录环境
      HOME: '/root',
      // pty 的 cwd 必须是宿主上真实存在的路径（我们给的是 rootfs 根），
      // 但 shell 里的 PWD 要显示成 guest 的 /root，否则提示符和 `cd -` 都是错乱的
      PWD: '/root',
      USER: 'root',
      LOGNAME: 'root',
      SHELL: guest.shell,
      PATH: ALPINE_GUEST_PATH,
      LANG: 'C.UTF-8',
      // 不带这个，部分程序会把终端当哑终端（Alpine 的 /etc/profile 会看 TERM）
      TERM: 'xterm-256color',
      // 关掉 proot 的 seccomp 加速：部分 Android 内核上它会让子进程收到
      // 假的 SIGSYS（表现为 shell 启动后立刻死、或命令随机失败）。
      // 纯 ptrace 慢一点，但行为稳定 —— 这是 proot-distro 在 Android 上的默认选择。
      PROOT_NO_SECCOMP: '1',
    },
  }
}
