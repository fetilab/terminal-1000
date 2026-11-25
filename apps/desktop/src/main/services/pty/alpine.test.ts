// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * alpine 单测：只验证「拼出来的东西对不对」。
 *
 * 这一层刻意做成纯函数（io 全部注入），因为真正的 proot 只能在 Android 上跑，
 * 而拼错参数的表现是「终端起来后立刻退出」或者「什么都没打印」——
 * 这种故障在设备上极难定位，必须在桌面侧就把 argv 锁死。
 */

import { describe, expect, it } from 'vitest'
import {
  ALPINE_GUEST_PATH,
  alpineLayout,
  alpineProfile,
  buildProotArgs,
  pickGuestShell,
  type AlpineIo,
  type AlpineLayout,
} from './alpine'

interface FakeIoOptions {
  /** 认为「普通存在」的路径（跟随符号链接语义） */
  existing?: string[]
  /** 认为「不跟随链接也存在」的条目（lstat 语义） */
  entries?: string[]
  env?: Record<string, string>
}

function fakeIo(options: FakeIoOptions = {}): AlpineIo {
  const existing = new Set(options.existing ?? [])
  const entries = new Set([...existing, ...(options.entries ?? [])])
  const envMap = options.env ?? {}
  return {
    exists: (path) => existing.has(path),
    existsNoFollow: (path) => entries.has(path),
    env: (name) => envMap[name],
  }
}

const ROOT = '/data/user/0/dev.t1000.android/files/alpine'
const LIB = '/data/app/x/lib/x86_64'
const TMP = '/data/user/0/dev.t1000.android/cache'

/** 一套「装好了」的环境 */
const readyIo = (overrides: FakeIoOptions = {}) =>
  fakeIo({
    existing: [`${LIB}/libproot.so`, `${LIB}/libproot-loader.so`, '/dev', '/proc', '/sys'],
    // /bin/sh 是符号链接，等于 /bin/busybox：从宿主看是断的，只有 lstat 能看见
    entries: [`${ROOT}/bin/sh`, `${ROOT}/bin/busybox`, `${ROOT}/bin/ash`],
    env: { T1000_ROOTFS: ROOT, T1000_NATIVE_LIB_DIR: LIB, T1000_TEMP: TMP },
    ...overrides,
  })

const layout: AlpineLayout = {
  rootfs: ROOT,
  proot: `${LIB}/libproot.so`,
  loader: `${LIB}/libproot-loader.so`,
  tmp: TMP,
  libDir: LIB,
}

describe('alpineLayout', () => {
  it('环境齐全时给出布局', () => {
    expect(alpineLayout(readyIo())).toEqual(layout)
  })

  it('缺任一环境变量就返回 null（调用方回退系统 shell）', () => {
    for (const drop of ['T1000_ROOTFS', 'T1000_NATIVE_LIB_DIR', 'T1000_TEMP']) {
      const io = readyIo()
      const env = {
        T1000_ROOTFS: ROOT,
        T1000_NATIVE_LIB_DIR: LIB,
        T1000_TEMP: TMP,
      } as Record<string, string>
      delete env[drop]
      const withHole: AlpineIo = { ...io, env: (name) => env[name] }
      expect(alpineLayout(withHole), drop).toBeNull()
    }
  })

  it('proot 或 loader 不存在时返回 null', () => {
    const io = fakeIo({
      existing: ['/dev', '/proc', '/sys'], // 少了两个 .so
      entries: [`${ROOT}/bin/sh`],
      env: { T1000_ROOTFS: ROOT, T1000_NATIVE_LIB_DIR: LIB, T1000_TEMP: TMP },
    })
    expect(alpineLayout(io)).toBeNull()
  })

  it('rootfs 里没有 /bin/sh 时返回 null', () => {
    const io = fakeIo({
      existing: [`${LIB}/libproot.so`, `${LIB}/libproot-loader.so`],
      entries: [],
      env: { T1000_ROOTFS: ROOT, T1000_NATIVE_LIB_DIR: LIB, T1000_TEMP: TMP },
    })
    expect(alpineLayout(io)).toBeNull()
  })

  /**
   * 回归：rootfs 里的 shell 全是绝对路径符号链接，
   * 用「跟随链接的 exists」判断一定为 false（宿主上没有 /bin/busybox），
   * 曾经因此把装好的环境判成没装、静默退回 mksh。
   */
  it('用不跟随链接的判断识别 rootfs 里的 shell 软链', () => {
    const env: Record<string, string> = {
      T1000_ROOTFS: ROOT,
      T1000_NATIVE_LIB_DIR: LIB,
      T1000_TEMP: TMP,
    }
    const io: AlpineIo = {
      exists: (p) => p === `${LIB}/libproot.so` || p === `${LIB}/libproot-loader.so`, // 跟随后全部断链
      existsNoFollow: (p) => p === `${ROOT}/bin/sh`,
      env: (name) => env[name],
    }
    expect(alpineLayout(io)).not.toBeNull()
  })

  it('没有 existsNoFollow 的 io 也能工作（回退到 exists）', () => {
    const env: Record<string, string> = {
      T1000_ROOTFS: ROOT,
      T1000_NATIVE_LIB_DIR: LIB,
      T1000_TEMP: TMP,
    }
    const io: AlpineIo = {
      exists: (p) =>
        p === `${ROOT}/bin/sh` || p === `${LIB}/libproot.so` || p === `${LIB}/libproot-loader.so`,
      env: (name) => env[name],
    }
    expect(alpineLayout(io)).not.toBeNull()
  })
})

describe('pickGuestShell', () => {
  it('只有 busybox 时选 ash', () => {
    expect(pickGuestShell(readyIo(), ROOT)).toEqual({ shell: '/bin/ash', name: 'ash' })
  })

  it('装了 bash 就优先 bash', () => {
    const io = fakeIo({ entries: [`${ROOT}/bin/bash`, `${ROOT}/bin/ash`, `${ROOT}/bin/sh`] })
    expect(pickGuestShell(io, ROOT)).toEqual({ shell: '/bin/bash', name: 'bash' })
  })

  it('zsh 优先于 ash 但次于 bash', () => {
    const io = fakeIo({ entries: [`${ROOT}/usr/bin/zsh`, `${ROOT}/bin/ash`] })
    expect(pickGuestShell(io, ROOT)).toEqual({ shell: '/usr/bin/zsh', name: 'zsh' })
  })

  it('什么都没有时退回 /bin/sh（不硬编码 bash，避免 exit 127 的黑窗口）', () => {
    expect(pickGuestShell(fakeIo(), ROOT)).toEqual({ shell: '/bin/sh', name: 'sh' })
  })
})

describe('buildProotArgs', () => {
  it('基本形状：保活 + 软链兼容 + 假 root + rootfs + 绑定 + 工作目录 + guest 命令', () => {
    const args = buildProotArgs(layout, ['/bin/ash', '-l'], readyIo(), { guestCwd: '/root' })
    expect(args.slice(0, 2)).toEqual(['--kill-on-exit', '--link2symlink'])
    expect(args).toContain('-0')
    expect(args.slice(args.indexOf('-r'), args.indexOf('-r') + 2)).toEqual(['-r', ROOT])
    expect(args.slice(-4)).toEqual(['-w', '/root', '/bin/ash', '-l'])
    expect(args[args.indexOf('-w') + 1]).toBe('/root')
  })

  it('绑定 /dev /proc /sys（终端能用 /dev/pts 的前提）', () => {
    const args = buildProotArgs(layout, ['/bin/sh'], readyIo())
    for (const m of ['/dev', '/proc', '/sys']) {
      const i = args.indexOf(m)
      expect(i, m).toBeGreaterThan(0)
      expect(args[i - 1], m).toBe('-b')
    }
  })

  it('宿主上不存在的绑定不会出现（避免 proot 启动即报错）', () => {
    const io = fakeIo({
      existing: [`${LIB}/libproot.so`, `${LIB}/libproot-loader.so`], // 没有 /dev /proc /sys
      entries: [`${ROOT}/bin/sh`],
      env: { T1000_ROOTFS: ROOT, T1000_NATIVE_LIB_DIR: LIB, T1000_TEMP: TMP },
    })
    const args = buildProotArgs(layout, ['/bin/sh'], io)
    expect(args).not.toContain('/dev')
    expect(args).not.toContain('/proc')
  })

  it('有外部存储时挂到 guest 的 /sdcard', () => {
    const io = readyIo({ existing: [`${LIB}/libproot.so`, `${LIB}/libproot-loader.so`, '/storage/emulated/0'] })
    const args = buildProotArgs(layout, ['/bin/sh'], io)
    expect(args).toContain('/storage/emulated/0:/sdcard')
  })

  it('fakeRoot 可以关掉', () => {
    const args = buildProotArgs(layout, ['/bin/sh'], readyIo(), { fakeRoot: false })
    expect(args).not.toContain('-0')
  })

  it('额外绑定按原样追加，且在 -w 之前', () => {
    const args = buildProotArgs(layout, ['/bin/sh'], readyIo(), { extraBinds: ['/data/local/tmp:/mnt/host'] })
    expect(args).toContain('/data/local/tmp:/mnt/host')
    expect(args.indexOf('/data/local/tmp:/mnt/host')).toBeLessThan(args.indexOf('-w'))
  })

  it('guest 命令整体落在末尾（proot 把 -w 之后的一切都当要执行的命令）', () => {
    const args = buildProotArgs(layout, ['/bin/sh', '-c', 'echo hi'], readyIo())
    expect(args.slice(-3)).toEqual(['/bin/sh', '-c', 'echo hi'])
  })
})

describe('alpineProfile', () => {
  it('shell 指向 nativeLibraryDir 里的 proot', () => {
    const p = alpineProfile(layout, readyIo())
    expect(p.id).toBe('alpine')
    expect(p.shell).toBe(`${LIB}/libproot.so`)
    expect(p.args).toEqual(buildProotArgs(layout, ['/bin/ash', '-l'], readyIo(), { guestCwd: '/root' }))
  })

  /**
   * cwd 是**宿主**路径（pty 服务会在宿主上校验存在性），
   * 而 guest 的起始目录靠 -w 传递。写成 /root 会让 open 直接失败。
   */
  it('cwd 用 rootfs 根（宿主上真实存在），不是 guest 的 /root', () => {
    const p = alpineProfile(layout, readyIo())
    expect(p.cwd).toBe(ROOT)
    expect(p.cwd).not.toBe('/root')
    expect(p.env?.['PWD']).toBe('/root')
  })

  it('proot 运行参数齐全（编译期写死的 Termux 前缀必须被覆盖）', () => {
    const env = alpineProfile(layout, readyIo()).env ?? {}
    expect(env['PROOT_LOADER']).toBe(`${LIB}/libproot-loader.so`)
    expect(env['PROOT_TMP_DIR']).toBe(TMP)
    expect(env['LD_LIBRARY_PATH']).toBe(LIB)
    // 关掉 seccomp 加速：部分内核上会让子进程收到假 SIGSYS
    expect(env['PROOT_NO_SECCOMP']).toBe('1')
  })

  it('guest 侧环境是 root 登录态，PATH 只有 Alpine 的目录', () => {
    const env = alpineProfile(layout, readyIo()).env ?? {}
    expect(env['HOME']).toBe('/root')
    expect(env['USER']).toBe('root')
    expect(env['SHELL']).toBe('/bin/ash')
    // 不能混进宿主的 /system/bin：那是 Android 的 toybox，进了 guest 全是错的
    expect(env['PATH']).toBe(ALPINE_GUEST_PATH)
    expect(env['PATH']).not.toContain('/system/bin')
    expect(env['TERM']).toBe('xterm-256color')
  })

  it('装了 bash 时名字带出来，便于用户在会话列表里认出来', () => {
    const io = fakeIo({ entries: [`${ROOT}/bin/bash`, `${ROOT}/bin/sh`] })
    const p = alpineProfile(layout, io)
    expect(p.name).toContain('bash')
    expect(p.args).toContain('/bin/bash')
  })
})
