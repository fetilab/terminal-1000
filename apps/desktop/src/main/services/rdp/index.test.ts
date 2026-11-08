// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * RDP 单测：命令行参数映射、二进制探测与安装提示、子进程生命周期（正常退出 vs 崩溃）、
 * 改分辨率重启。**不真的拉起 GUI 进程**（spawner 与 detector 都是注入的）。
 */

import { describe, expect, it } from 'vitest'
import { Actions, type RdpConnection } from '@t1000/shared'
import { AppError } from '../../errors'
import {
  RDP_DEFAULT_HEIGHT,
  RDP_DEFAULT_PORT,
  RDP_DEFAULT_WIDTH,
  RdpManager,
  buildRdpArgs,
  findRdpBinary,
  rdpHandlers,
  rdpInstallHint,
  type RdpChildProcess,
  type RdpEventSink,
} from './index'

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

function connection(over: Partial<RdpConnection> = {}): RdpConnection {
  return {
    kind: 'rdp',
    id: 'r1',
    name: 'win-box',
    host: '10.0.0.5',
    port: 3389,
    username: 'administrator',
    password: 'pw',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  }
}

class FakeChild implements RdpChildProcess {
  readonly killed: Array<string | undefined> = []
  readonly pid = 4242
  private exitCb: ((code: number | null, signal: NodeJS.Signals | null) => void) | null = null
  private errorCb: ((err: Error) => void) | null = null

  on(
    event: 'exit' | 'error',
    listener: ((code: number | null, signal: NodeJS.Signals | null) => void) | ((err: Error) => void),
  ): this {
    if (event === 'exit') this.exitCb = listener as (code: number | null, signal: NodeJS.Signals | null) => void
    else this.errorCb = listener as (err: Error) => void
    return this
  }

  kill(signal?: NodeJS.Signals): boolean {
    this.killed.push(signal)
    return true
  }

  emitExit(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.exitCb?.(code, signal)
  }

  emitError(err: Error): void {
    this.errorCb?.(err)
  }
}

interface Recorder extends RdpEventSink {
  states: Array<{ sessionId: string; state: string; message?: string }>
  exits: Array<{ sessionId: string; code: number | null; signal: string | null; crashed: boolean }>
}

function recorder(): Recorder {
  const states: Recorder['states'] = []
  const exits: Recorder['exits'] = []
  return {
    states,
    exits,
    state: (sessionId, state, message) =>
      states.push(message === undefined ? { sessionId, state } : { sessionId, state, message }),
    exit: (sessionId, info) => exits.push({ sessionId, ...info }),
  }
}

function setup(options: { binary?: string | null } = {}) {
  const sink = recorder()
  const spawned: Array<{ file: string; args: string[]; child: FakeChild }> = []
  const manager = new RdpManager({
    sink,
    findBinary: () => (options.binary === undefined ? '/usr/bin/xfreerdp' : options.binary),
    spawn: (file, args) => {
      const child = new FakeChild()
      spawned.push({ file, args: [...args], child })
      return child
    },
  })
  return { manager, sink, spawned }
}

// ---------------------------------------------------------------------------
// 命令行映射
// ---------------------------------------------------------------------------

describe('buildRdpArgs：连接参数 → xfreerdp 命令行', () => {
  it('主机与端口', () => {
    expect(buildRdpArgs(connection())).toContain('/v:10.0.0.5:3389')
    expect(buildRdpArgs(connection({ port: 13389 }))).toContain('/v:10.0.0.5:13389')
    // 端口缺失/非法时回落默认端口
    expect(buildRdpArgs(connection({ port: 0 }))).toContain(`/v:10.0.0.5:${RDP_DEFAULT_PORT}`)
  })

  it('用户名 / 域 / 口令', () => {
    const args = buildRdpArgs(connection({ domain: 'CORP' }))
    expect(args).toContain('/u:administrator')
    expect(args).toContain('/d:CORP')
    expect(args).toContain('/p:pw')
  })

  it('没有口令/域时不生成对应参数', () => {
    const args = buildRdpArgs(connection({ password: undefined, domain: undefined }))
    expect(args.some((a) => a.startsWith('/p:'))).toBe(false)
    expect(args.some((a) => a.startsWith('/d:'))).toBe(false)
  })

  it('固定分辨率 → /size:WxH；跟随窗口 → 初始尺寸 + /dynamic-resolution', () => {
    const fixed = buildRdpArgs(
      connection({ displayMode: 'fixed-resolution', width: 1920, height: 1080 }),
    )
    expect(fixed).toContain('/size:1920x1080')
    expect(fixed).not.toContain('/dynamic-resolution')

    const follow = buildRdpArgs(connection({ displayMode: 'follow-window' }))
    expect(follow).toContain(`/size:${RDP_DEFAULT_WIDTH}x${RDP_DEFAULT_HEIGHT}`)
    expect(follow).toContain('/dynamic-resolution')
  })

  it('fixed-resolution 但缺尺寸 → 退回跟随窗口（不会生成非法 /size:）', () => {
    const args = buildRdpArgs(connection({ displayMode: 'fixed-resolution' }))
    expect(args.some((a) => a.startsWith('/size:0x'))).toBe(false)
    expect(args).toContain('/dynamic-resolution')
  })

  it('connect 时显式传的尺寸覆盖连接配置', () => {
    const args = buildRdpArgs(
      connection({ displayMode: 'fixed-resolution', width: 800, height: 600 }),
      { width: 1024, height: 768 },
    )
    expect(args).toContain('/size:1024x768')
  })

  it('全屏 → /f', () => {
    expect(buildRdpArgs(connection(), { fullscreen: true })).toContain('/f')
    expect(buildRdpArgs(connection())).not.toContain('/f')
  })

  it('画质映射到 bpp 与 network', () => {
    expect(buildRdpArgs(connection({ quality: 'low' }))).toEqual(
      expect.arrayContaining(['/bpp:16', '/network:modem']),
    )
    expect(buildRdpArgs(connection({ quality: 'balanced' }))).toEqual(
      expect.arrayContaining(['/bpp:24', '/network:broadband']),
    )
    expect(buildRdpArgs(connection({ quality: 'high' }))).toEqual(
      expect.arrayContaining(['/bpp:32', '/network:lan']),
    )
    // 未配置时按 balanced
    expect(buildRdpArgs(connection())).toContain('/bpp:24')
  })

  it('剪贴板开关', () => {
    expect(buildRdpArgs(connection({ clipboardShare: true }))).toContain('/clipboard')
    expect(buildRdpArgs(connection({ clipboardShare: false }))).toContain('-clipboard')
    expect(buildRdpArgs(connection())).toContain('-clipboard')
  })

  it('总是忽略证书校验（RDP 服务端多为自签证书）', () => {
    expect(buildRdpArgs(connection())).toContain('/cert:ignore')
  })
})

describe('二进制探测与安装提示', () => {
  it('按候选顺序在 PATH 中查找', () => {
    const existing = new Set(['/usr/local/bin/xfreerdp3', '/usr/bin/freerdp'])
    const found = findRdpBinary({ PATH: '/usr/local/bin:/usr/bin' }, (p) => existing.has(p))
    expect(found).toBe('/usr/local/bin/xfreerdp3')
  })

  it('优先 xfreerdp（第一候选）', () => {
    const existing = new Set(['/usr/bin/xfreerdp', '/usr/bin/xfreerdp3'])
    expect(findRdpBinary({ PATH: '/usr/bin' }, (p) => existing.has(p))).toBe('/usr/bin/xfreerdp')
  })

  it('都没有 → null', () => {
    expect(findRdpBinary({ PATH: '/usr/bin' }, () => false)).toBeNull()
    expect(findRdpBinary({}, () => true)).toBeNull()
  })

  it('安装提示给出可操作命令', () => {
    const hint = rdpInstallHint()
    expect(hint).toContain('apt install freerdp2-x11')
    expect(hint).toContain('dnf install freerdp')
    expect(hint).toContain('pacman -S freerdp')
  })

  it('未安装 FreeRDP → connect 抛 UNSUPPORTED 并带安装提示', () => {
    const { manager } = setup({ binary: null })
    try {
      manager.connect(connection())
      throw new Error('应当抛错')
    } catch (err) {
      expect(err).toBeInstanceOf(AppError)
      const appErr = err as AppError
      expect(appErr.code).toBe('UNSUPPORTED')
      expect(appErr.message).toContain('apt install freerdp2-x11')
    }
  })
})

// ---------------------------------------------------------------------------
// 生命周期
// ---------------------------------------------------------------------------

describe('RdpManager：子进程生命周期', () => {
  it('connect 拉起进程并上报 connecting → ready', () => {
    const { manager, sink, spawned } = setup()
    const result = manager.connect(connection({ displayMode: 'fixed-resolution', width: 1024, height: 768 }))

    expect(result.executable).toBe('/usr/bin/xfreerdp')
    expect(result.args).toContain('/size:1024x768')
    expect(spawned).toHaveLength(1)
    expect(sink.states.map((s) => s.state)).toEqual(['connecting', 'ready'])
    expect(manager.list()[0]).toMatchObject({ state: 'ready', host: '10.0.0.5' })
  })

  it('用户关窗口（code 0）→ disconnected 且 crashed=false', () => {
    const { manager, sink, spawned } = setup()
    const { sessionId } = manager.connect(connection())
    spawned[0]?.child.emitExit(0)

    expect(sink.states.at(-1)?.state).toBe('disconnected')
    expect(sink.exits[0]).toEqual({ sessionId, code: 0, signal: null, crashed: false })
    expect(manager.list()).toHaveLength(0)
  })

  it('异常退出（非 0）→ crashed=true 且状态里说明原因', () => {
    const { manager, sink, spawned } = setup()
    const { sessionId } = manager.connect(connection())
    spawned[0]?.child.emitExit(1)

    expect(sink.exits[0]).toEqual({ sessionId, code: 1, signal: null, crashed: true })
    expect(sink.states.at(-1)?.message).toContain('异常退出')
  })

  it('信号结束也会如实上报 signal', () => {
    const { manager, sink, spawned } = setup()
    manager.connect(connection())
    spawned[0]?.child.emitExit(null, 'SIGSEGV')

    expect(sink.exits[0]).toMatchObject({ code: null, signal: 'SIGSEGV', crashed: true })
  })

  it('disconnect 主动结束 → 不发崩溃退出事件', () => {
    const { manager, sink, spawned } = setup()
    const { sessionId } = manager.connect(connection())
    manager.disconnect(sessionId)

    expect(spawned[0]?.child.killed).toContain('SIGTERM')
    expect(sink.states.at(-1)?.state).toBe('disconnected')
    // 主动断开后进程的 exit 回调不应再产生 RDP_EXIT
    spawned[0]?.child.emitExit(0)
    expect(sink.exits).toHaveLength(0)
  })

  it('进程 error 事件 → failed（附消息）', () => {
    const { manager, sink, spawned } = setup()
    manager.connect(connection())
    spawned[0]?.child.emitError(new Error('spawn xfreerdp EACCES'))

    expect(sink.states.at(-1)).toMatchObject({ state: 'failed', message: 'spawn xfreerdp EACCES' })
  })

  it('未知 sessionId → NOT_FOUND', () => {
    const { manager } = setup()
    expect(() => manager.disconnect('nope')).toThrow(AppError)
    expect(() => manager.sendResize('nope', 800, 600)).toThrow(/不存在/)
  })

  it('shutdown 杀掉全部进程', () => {
    const { manager, spawned } = setup()
    manager.connect(connection())
    manager.connect(connection())
    manager.shutdown()

    expect(manager.list()).toHaveLength(0)
    expect(spawned.every((s) => s.child.killed.includes('SIGTERM'))).toBe(true)
  })
})

describe('RdpManager：改分辨率（重启外部窗口）', () => {
  it('★ 杀掉旧进程、用新尺寸重启，并返回 restarted', () => {
    const { manager, sink, spawned } = setup()
    const { sessionId } = manager.connect(connection({ displayMode: 'follow-window' }))

    const result = manager.sendResize(sessionId, 1600, 900)
    expect(result).toEqual({ sessionId, width: 1600, height: 900, restarted: true })

    expect(spawned).toHaveLength(2)
    expect(spawned[0]?.child.killed).toContain('SIGTERM')
    expect(spawned[1]?.args).toContain('/size:1600x900')
    // 重启过程状态：connecting（带说明）→ ready
    expect(sink.states.filter((s) => s.message !== undefined).at(-1)?.message).toContain('分辨率变更')
  })

  it('尺寸被夹到合理下限（不会生成非法 /size:）', () => {
    const { manager, spawned } = setup()
    const { sessionId } = manager.connect(connection({ displayMode: 'follow-window' }))
    manager.sendResize(sessionId, 10, 10)

    expect(spawned[1]?.args).toContain('/size:320x240')
  })

  it('旧进程的 exit 不影响重启后的会话状态（代际守卫）', () => {
    const { manager, sink, spawned } = setup()
    const { sessionId } = manager.connect(connection({ displayMode: 'follow-window' }))
    manager.sendResize(sessionId, 1600, 900)

    // 旧进程此刻才真正退出（SIGTERM 生效）
    spawned[0]?.child.emitExit(null, 'SIGTERM')

    // 不应被当成"会话结束"：会话仍在，且没有崩溃退出事件
    expect(manager.list()).toHaveLength(1)
    expect(manager.list()[0]?.sessionId).toBe(sessionId)
    expect(sink.exits.some((e) => e.crashed)).toBe(false)
  })
})

describe('rdp IPC 契约', () => {
  it('handler 动作集合与 Actions.rdp 一致', () => {
    expect(Object.keys(rdpHandlers).sort()).toEqual([...Actions.rdp].sort())
  })

  it('每个动作都是函数', () => {
    for (const [action, fn] of Object.entries(rdpHandlers)) {
      expect(typeof fn, `动作 ${action}`).toBe('function')
    }
  })
})
