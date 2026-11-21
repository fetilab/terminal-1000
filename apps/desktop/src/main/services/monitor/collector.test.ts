// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * collector 单测：用可注入时钟 + 假采集通道驱动分档调度，不连任何主机。
 *
 * 覆盖验收点：
 * - 脚本只上传一次（版本一致完全跳过；版本不一致只装一次）
 * - 分档轮询：fast 3s 先出、medium 10s、slow 30s 互不干扰
 * - 关掉的卡片不产生采集命令；全部关掉时一次远端调用都不发
 * - 连续失败达阈值自动暂停并停掉定时器
 * - 并发取快照合并成同一次采集
 * - 缓存新鲜度、setCards 生效、stop 后静默
 */

import { describe, expect, it } from 'vitest'
import { MONITOR_TIER_INTERVALS, type MonitorCardConfig, type MonitorSnapshot } from '@t1000/shared'
import type { ExecResult } from '../session-registry'
import {
  MonitorCollector,
  defaultSettings,
  type CollectorClock,
  type CollectorEvents,
  type CollectorTransport,
  type MonitorStatus,
} from './collector'
import { HEREDOC_MARKER, SCRIPT_VERSION } from './scripts'

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

/** 受控时钟：定时器只在 advance() 时按到期顺序触发 */
class ManualClock implements CollectorClock {
  private current = 1_700_000_000_000
  private seq = 0
  private readonly timers = new Map<number, { at: number; fn: () => void }>()

  now(): number {
    return this.current
  }

  setTimeout(fn: () => void, ms: number): unknown {
    const id = ++this.seq
    this.timers.set(id, { at: this.current + ms, fn })
    return id
  }

  clearTimeout(handle: unknown): void {
    if (typeof handle === 'number') this.timers.delete(handle)
  }

  get pendingTimers(): number {
    return this.timers.size
  }

  async advance(ms: number): Promise<void> {
    const target = this.current + ms
    for (;;) {
      let nextId = -1
      let nextAt = Number.POSITIVE_INFINITY
      for (const [id, t] of this.timers) {
        if (t.at <= target && t.at < nextAt) {
          nextAt = t.at
          nextId = id
        }
      }
      if (nextId < 0) break
      const entry = this.timers.get(nextId)
      this.timers.delete(nextId)
      if (!entry) break
      this.current = entry.at
      entry.fn()
      await settle()
    }
    this.current = target
  }
}

/** 一次「所有模块都正常返回」的采集输出 */
const COLLECT_STDOUT = JSON.stringify({
  system: { hostname: 'test-host', distro: 'debian', loadAvg: [0.1, 0.2, 0.3] },
  cpu: { usage: 5, cores: [{ index: 0, usage: 5 }] },
  memory: { totalBytes: 1000, usedBytes: 400, freeBytes: 300, cachedBytes: 300 },
  network: { interfaces: [{ name: 'eth0', rxBytes: 10, txBytes: 20 }], rxSpeed: 1, txSpeed: 2 },
  disk: {
    partitions: [
      { mount: '/', totalBytes: 100, usedBytes: 50, availableBytes: 50, usedPercent: 50 },
    ],
    readSpeed: 0,
    writeSpeed: 0,
  },
  process: [{ pid: 1, command: 'init', cpu: 0, memory: 0 }],
  gpu: [],
})

const VERSION_CHECK_MARKER = 'cat "$HOME/.t1000-monitor/VERSION"'
const COLLECT_MARKER = 'T1000_PROC_LIMIT='

class FakeTransport implements CollectorTransport {
  readonly calls: { sessionId: string; command: string; timeoutMs?: number }[] = []
  /** 远端 VERSION 内容；null = 文件不存在 */
  remoteVersion: string | null = SCRIPT_VERSION
  failWith: Error | null = null
  /** 让安装命令失败（拿不到成功哨兵） */
  installFails = false
  stdout = COLLECT_STDOUT
  stderr = ''
  /** 挂起采集命令，用于测试订阅合并 */
  blocked = false
  private pending: (() => void)[] = []

  get versionChecks(): string[] {
    return this.calls.filter((c) => c.command.includes(VERSION_CHECK_MARKER)).map((c) => c.command)
  }

  get installs(): string[] {
    return this.calls.filter((c) => c.command.includes(HEREDOC_MARKER)).map((c) => c.command)
  }

  get collects(): string[] {
    return this.calls.filter((c) => c.command.startsWith(COLLECT_MARKER)).map((c) => c.command)
  }

  get lastCollect(): string {
    return this.collects[this.collects.length - 1] ?? ''
  }

  releaseAll(): void {
    const waiting = this.pending
    this.pending = []
    for (const release of waiting) release()
  }

  async exec(sessionId: string, command: string, timeoutMs?: number): Promise<ExecResult> {
    this.calls.push({ sessionId, command, timeoutMs })
    if (this.failWith) throw this.failWith

    if (this.blocked && command.startsWith(COLLECT_MARKER)) {
      await new Promise<void>((resolve) => this.pending.push(resolve))
    }

    if (command.includes(VERSION_CHECK_MARKER)) {
      return this.remoteVersion === null
        ? { stdout: '__T1000_MISSING__\n', stderr: '', code: 0 }
        : { stdout: `${this.remoteVersion}\n`, stderr: '', code: 0 }
    }
    if (command.includes(HEREDOC_MARKER)) {
      return this.installFails
        ? { stdout: '', stderr: 'mkdir: Permission denied', code: 1 }
        : { stdout: '__T1000_OK__\n', stderr: '', code: 0 }
    }
    return { stdout: this.stdout, stderr: this.stderr, code: 0 }
  }
}

interface Recorded {
  snapshots: { sessionId: string; snapshot: MonitorSnapshot }[]
  statuses: { sessionId: string; status: MonitorStatus; message?: string }[]
  errors: { sessionId: string; message: string }[]
  events: CollectorEvents
}

function recorder(): Recorded {
  const snapshots: Recorded['snapshots'] = []
  const statuses: Recorded['statuses'] = []
  const errors: Recorded['errors'] = []
  return {
    snapshots,
    statuses,
    errors,
    events: {
      onSnapshot: (sessionId, snapshot) => snapshots.push({ sessionId, snapshot }),
      onStatus: (sessionId, status, message) =>
        statuses.push({ sessionId, status, ...(message === undefined ? {} : { message }) }),
      onError: (sessionId, message) => errors.push({ sessionId, message }),
    },
  }
}

function setup(): {
  clock: ManualClock
  transport: FakeTransport
  rec: Recorded
  collector: MonitorCollector
} {
  const clock = new ManualClock()
  const transport = new FakeTransport()
  const rec = recorder()
  const collector = new MonitorCollector(transport, rec.events, clock)
  return { clock, transport, rec, collector }
}

/** 取采集命令里的模块参数（脚本路径之后的部分） */
function moduleArgs(command: string): string[] {
  const marker = 'collect.sh"'
  const i = command.indexOf(marker)
  if (i < 0) return []
  return command
    .slice(i + marker.length)
    .trim()
    .split(/\s+/)
    .filter(Boolean)
}

function withEnabledOnly(kinds: string[]): MonitorCardConfig[] {
  return defaultSettings().cards.map((c) => ({ ...c, enabled: kinds.includes(c.kind) }))
}

describe('脚本分发（只上传一次）', () => {
  it('远端版本一致：只读一次 VERSION，永不上传', async () => {
    const { clock, transport, collector } = setup()
    await collector.start('s1')

    expect(transport.versionChecks).toHaveLength(1)
    expect(transport.installs).toHaveLength(0)
    expect(transport.collects).toHaveLength(1)

    await clock.advance(9_000) // 3 个快档节拍
    expect(transport.collects.length).toBeGreaterThan(1)
    expect(transport.versionChecks).toHaveLength(1) // 不再回远端读版本
    expect(transport.installs).toHaveLength(0)
  })

  it('远端版本落后：上传一次，之后不再重复上传', async () => {
    const { clock, transport, collector } = setup()
    transport.remoteVersion = '0'

    await collector.start('s1')
    expect(transport.versionChecks).toHaveLength(1)
    expect(transport.installs).toHaveLength(1)
    // 顺序：读版本 → 安装 → 采集
    const kinds = transport.calls.map((c) =>
      c.command.includes(VERSION_CHECK_MARKER)
        ? 'version'
        : c.command.includes(HEREDOC_MARKER)
          ? 'install'
          : 'collect',
    )
    expect(kinds).toEqual(['version', 'install', 'collect'])

    await clock.advance(9_000)
    expect(transport.installs).toHaveLength(1)
    expect(transport.versionChecks).toHaveLength(1)
  })

  it('远端完全没有脚本（VERSION 缺失）：走安装', async () => {
    const { transport, collector } = setup()
    transport.remoteVersion = null
    await collector.start('s1')
    expect(transport.installs).toHaveLength(1)
    expect(transport.collects).toHaveLength(1)
  })

  it('安装失败计入失败次数并上报', async () => {
    const { transport, rec, collector } = setup()
    transport.remoteVersion = '0'
    transport.installFails = true

    const snap = await collector.start('s1')
    expect(snap).toBeNull()
    expect(transport.installs).toHaveLength(1)
    expect(rec.errors[0]?.message).toContain('安装失败')
    expect(collector.getStatus('s1')).toBe('starting')
  })
})

describe('分档轮询', () => {
  it('首采覆盖全部模块，之后 fast 档按 3s 独立刷新', async () => {
    const { clock, transport, collector } = setup()
    await collector.start('s1')

    expect(moduleArgs(transport.lastCollect)).toEqual([
      'system',
      'cpu',
      'memory',
      'network',
      'disk',
      'process',
      'gpu',
    ])

    await clock.advance(MONITOR_TIER_INTERVALS.fast)
    expect(moduleArgs(transport.lastCollect)).toEqual(['cpu'])

    await clock.advance(MONITOR_TIER_INTERVALS.fast)
    expect(moduleArgs(transport.lastCollect)).toEqual(['cpu'])

    await clock.advance(MONITOR_TIER_INTERVALS.fast)
    expect(moduleArgs(transport.lastCollect)).toEqual(['cpu'])
  })

  it('medium 档到 10s 才采，且与 fast 档互不干扰', async () => {
    const { clock, transport, collector } = setup()
    await collector.start('s1')
    await clock.advance(9_000) // 到 T+9s，只有 fast 跑过

    await clock.advance(1_000) // T+10s：medium 到期，fast 刚跑过 1s
    expect(moduleArgs(transport.lastCollect)).toEqual(['system', 'memory', 'network', 'process'])

    await clock.advance(2_000) // T+12s：fast 又到期
    expect(moduleArgs(transport.lastCollect)).toEqual(['cpu'])
  })

  it('slow 档到 30s 才采（含磁盘与 GPU）', async () => {
    const { clock, transport, collector } = setup()
    await collector.start('s1')
    const afterFirst = transport.collects.length // 首采覆盖全部档，从这之后才算数

    await clock.advance(29_000)
    for (const cmd of transport.collects.slice(afterFirst)) {
      expect(cmd).not.toContain('disk')
      expect(cmd).not.toContain('gpu')
    }

    await clock.advance(1_000) // T+30s
    const args = moduleArgs(transport.lastCollect)
    expect(args).toContain('disk')
    expect(args).toContain('gpu')
  })

  it('只启用 slow 卡片时，节拍就变成 30s（不做无谓空转）', async () => {
    const { clock, transport, collector } = setup()
    await collector.start('s1', { cards: withEnabledOnly(['disk']) })
    expect(transport.collects).toHaveLength(1)

    await clock.advance(29_000)
    expect(transport.collects).toHaveLength(1)

    await clock.advance(1_000)
    expect(transport.collects).toHaveLength(2)
    expect(moduleArgs(transport.lastCollect)).toEqual(['disk'])
  })
})

describe('按卡片开关采集', () => {
  it('关掉的卡片不产生采集命令', async () => {
    const { transport, collector } = setup()
    await collector.start('s1', { cards: withEnabledOnly(['system', 'cpu', 'memory', 'network']) })

    expect(moduleArgs(transport.lastCollect)).toEqual(['system', 'cpu', 'memory', 'network'])
    expect(transport.lastCollect).not.toContain('disk')
    expect(transport.lastCollect).not.toContain('gpu')
    expect(transport.lastCollect).not.toContain('process')
  })

  it('全部关掉：一次远端调用都不发，并给出警告', async () => {
    const { clock, transport, collector } = setup()
    const snapshot = await collector.start('s1', { cards: withEnabledOnly([]) })

    expect(transport.calls).toHaveLength(0)
    expect(transport.collects).toHaveLength(0)
    expect(snapshot?.warnings?.[0]).toContain('没有启用的监控卡片')

    await clock.advance(60_000)
    expect(transport.calls).toHaveLength(0)
  })

  it('setCards 之后按新配置采集', async () => {
    const { transport, collector } = setup()
    await collector.start('s1')
    collector.setCards(withEnabledOnly(['system', 'memory']), 's1')

    await collector.refresh('s1')
    expect(moduleArgs(transport.lastCollect)).toEqual(['system', 'memory'])
    expect(transport.lastCollect).not.toContain('cpu')
  })

  it('processLimit 透传到采集命令', async () => {
    const { transport, collector } = setup()
    await collector.start('s1', { processLimit: 3 })
    expect(transport.lastCollect).toContain('T1000_PROC_LIMIT=3')
  })
})

describe('失败与暂停', () => {
  it('连续 3 次失败后自动暂停，且不再发起任何远端调用', async () => {
    const { clock, transport, rec, collector } = setup()
    transport.failWith = new Error('远端命令超时 (8000ms)')

    await collector.start('s1') // 第 1 次失败
    expect(collector.getStatus('s1')).toBe('starting')
    expect(rec.errors).toHaveLength(1)
    expect(rec.errors[0]?.message).toContain('超时')

    await clock.advance(MONITOR_TIER_INTERVALS.fast) // 第 2 次
    expect(collector.getStatus('s1')).toBe('starting')

    await clock.advance(MONITOR_TIER_INTERVALS.fast) // 第 3 次 → 暂停
    expect(collector.getStatus('s1')).toBe('paused')
    expect(rec.errors).toHaveLength(3)

    const paused = rec.statuses.filter((s) => s.status === 'paused')
    expect(paused).toHaveLength(1)
    expect(paused[0]?.message).toContain('已自动暂停')

    const callsAtPause = transport.calls.length
    await clock.advance(120_000)
    expect(transport.calls.length).toBe(callsAtPause)
    expect(clock.pendingTimers).toBe(0)
  })

  it('阈值可配：设为 1 时首次失败即暂停', async () => {
    const { transport, rec, collector } = setup()
    transport.failWith = new Error('boom')
    await collector.start('s1', { failurePauseThreshold: 1 })
    expect(collector.getStatus('s1')).toBe('paused')
    expect(rec.errors).toHaveLength(1)
  })

  it('成功后失败计数清零（不会攒够阈值）', async () => {
    const { clock, transport, rec, collector } = setup()
    transport.failWith = new Error('偶发失败')
    await collector.start('s1') // 1 次失败
    transport.failWith = null
    await clock.advance(MONITOR_TIER_INTERVALS.fast) // 成功
    expect(collector.getStatus('s1')).toBe('running')

    transport.failWith = new Error('再失败')
    await clock.advance(MONITOR_TIER_INTERVALS.fast) // 1 次失败（计数从 0 开始）
    expect(collector.getStatus('s1')).toBe('running')
    expect(rec.errors).toHaveLength(2)
  })

  it('暂停后手动 refresh 能恢复调度', async () => {
    const { clock, transport, collector } = setup()
    transport.failWith = new Error('boom')
    await collector.start('s1', { failurePauseThreshold: 1 })
    expect(collector.getStatus('s1')).toBe('paused')

    transport.failWith = null
    await collector.refresh('s1')
    expect(collector.getStatus('s1')).toBe('running')

    const before = transport.collects.length
    await clock.advance(MONITOR_TIER_INTERVALS.fast)
    expect(transport.collects.length).toBeGreaterThan(before)
  })

  it('stop 之后彻底静默', async () => {
    const { clock, transport, collector } = setup()
    await collector.start('s1')
    collector.stop('s1')
    expect(collector.getStatus('s1')).toBe('stopped')

    const calls = transport.calls.length
    await clock.advance(120_000)
    expect(transport.calls.length).toBe(calls)
  })
})

describe('快照获取', () => {
  it('并发 force 取快照合并成同一次采集', async () => {
    const { transport, collector } = setup()
    await collector.start('s1')
    const before = transport.collects.length

    transport.blocked = true
    const p1 = collector.snapshot('s1', { force: true })
    const p2 = collector.snapshot('s1', { force: true })
    await settle()
    expect(transport.collects.length).toBe(before + 1)

    transport.releaseAll()
    const [a, b] = await Promise.all([p1, p2])
    expect(a).toBe(b)
    expect(transport.collects.length).toBe(before + 1)
  })

  it('默认取快照吃缓存，不产生新命令', async () => {
    const { transport, collector } = setup()
    await collector.start('s1')
    const before = transport.collects.length

    const snapshot = await collector.snapshot('s1')
    expect(transport.collects.length).toBe(before)
    expect(snapshot).toBe(collector.peek('s1'))
    expect(snapshot.system?.hostname).toBe('test-host')
  })

  it('stderr 作为警告保留，不影响快照', async () => {
    const { transport, collector } = setup()
    transport.stderr = 'df: /run/user/1000: Permission denied\n'
    await collector.start('s1')
    const snapshot = collector.peek('s1')
    expect(snapshot?.warnings).toContain('df: /run/user/1000: Permission denied')
    expect(snapshot?.cpu?.usage).toBe(5)
  })

  it('未启动的会话取快照只回空警告，不碰远端', async () => {
    const { transport, collector } = setup()
    expect(collector.getStatus('unknown')).toBe('idle')

    const snapshot = await collector.snapshot('unknown')
    expect(snapshot.warnings?.[0]).toContain('未运行')
    expect(transport.calls).toHaveLength(0)
  })
})

describe('生命周期', () => {
  it('重复 start 幂等，返回当前快照', async () => {
    const { transport, collector } = setup()
    const first = await collector.start('s1')
    const second = await collector.start('s1')
    expect(second).toBe(first)
    expect(transport.collects).toHaveLength(1)
  })

  it('状态事件顺序：starting → running', async () => {
    const { rec, collector } = setup()
    await collector.start('s1')
    expect(rec.statuses.map((s) => s.status)).toEqual(['starting', 'running'])
  })

  it('dispose 清掉所有定时器', async () => {
    const { clock, collector } = setup()
    await collector.start('s1')
    collector.dispose()
    expect(clock.pendingTimers).toBe(0)
  })

  it('forget 移除会话状态', async () => {
    const { collector } = setup()
    await collector.start('s1')
    collector.forget('s1')
    expect(collector.getStatus('s1')).toBe('idle')
    expect(collector.peek('s1')).toBeNull()
  })
})

/* ── 分档快照合并 / 代理通道 ─────────────────────────────────────────────── */

/**
 * 只回"本次请求的模块"的通道，用来验证分档合并。
 * 真实脚本就是这么干的：`collect.sh cpu` 只输出 `{"cpu":...}`。
 */
class PerModuleTransport implements CollectorTransport {
  collects: string[] = []
  versionChecks = 0

  async exec(_sessionId: string, command: string): Promise<ExecResult> {
    if (command.includes('VERSION')) {
      this.versionChecks += 1
      return { stdout: `${SCRIPT_VERSION}\n`, stderr: '', code: 0 }
    }
    this.collects.push(command)
    // 采集命令形如 `T1000_PROC_LIMIT=8 ... sh "$HOME/.../collect.sh" cpu memory`
    const modules = (command.split(/\.sh"?\s+/).at(-1) ?? '').trim().split(/\s+/)
    const out: Record<string, unknown> = {}
    for (const mod of modules) {
      if (mod === 'cpu') out.cpu = { usage: 7, cores: [] }
      if (mod === 'memory') out.memory = { totalBytes: 100, usedBytes: 40, freeBytes: 60 }
      if (mod === 'disk')
        out.disk = { partitions: [{ mount: '/', totalBytes: 10, usedBytes: 5, availableBytes: 5, usedPercent: 50 }] }
    }
    return { stdout: JSON.stringify(out), stderr: '', code: 0 }
  }
}

describe('分档采集的快照合并', () => {
  it('fast 拍只采了 cpu，但面板上其它卡片的数据仍在（不再闪烁/消失）', async () => {
    const clock = new ManualClock()
    const transport = new PerModuleTransport()
    const rec = recorder()
    const collector = new MonitorCollector(transport, rec.events, clock)
    const cards: MonitorCardConfig[] = [
      { kind: 'cpu', enabled: true, order: 0, tier: 'fast' },
      { kind: 'memory', enabled: true, order: 1, tier: 'medium' },
      { kind: 'disk', enabled: true, order: 2, tier: 'slow' },
    ]
    await collector.start('s1', { cards })

    // 首拍覆盖所有档位
    const first = collector.peek('s1')
    expect(first?.cpu).toBeTruthy()
    expect(first?.memory).toBeTruthy()
    expect(first?.disk).toBeTruthy()

    await clock.advance(MONITOR_TIER_INTERVALS.fast)
    const afterFast = collector.peek('s1')
    expect(afterFast?.cpu).toBeTruthy()
    // 关键断言：本拍没采的模块沿用上一拍，而不是被抹掉
    expect(afterFast?.memory).toBeTruthy()
    expect(afterFast?.disk).toBeTruthy()
    // 最后一条命令确实只有 cpu
    expect(transport.collects.at(-1)?.trim().endsWith('cpu')).toBe(true)
  })

  it('关掉卡片后旧数据立即从快照里摘掉', async () => {
    const clock = new ManualClock()
    const transport = new PerModuleTransport()
    const rec = recorder()
    const collector = new MonitorCollector(transport, rec.events, clock)
    await collector.start('s1', {
      cards: [
        { kind: 'cpu', enabled: true, order: 0, tier: 'fast' },
        { kind: 'memory', enabled: true, order: 1, tier: 'medium' },
      ],
    })
    expect(collector.peek('s1')?.memory).toBeTruthy()

    collector.setCards(
      [
        { kind: 'cpu', enabled: true, order: 0, tier: 'fast' },
        { kind: 'memory', enabled: false, order: 1, tier: 'medium' },
      ],
      's1',
    )
    expect(collector.peek('s1')?.memory).toBeUndefined()
    // 新配置立即触发一次补采（不用等 10 秒的 medium 档）
    await settle()
    expect(transport.collects.length).toBeGreaterThanOrEqual(2)
  })
})

describe('代理通道优先', () => {
  const AGENT_JSON = JSON.stringify({
    cpu: { usage: 42, cores: [] },
    memory: { totalBytes: 100, usedBytes: 60, freeBytes: 40 },
  })

  it('代理可用时不跑任何采集脚本，快照标记 source=agent', async () => {
    const clock = new ManualClock()
    const transport: CollectorTransport = {
      exec: async () => {
        throw new Error('代理可用时不应该 exec 采集脚本')
      },
      agentSample: async () => ({ json: AGENT_JSON, version: '2' }),
    }
    const rec = recorder()
    const collector = new MonitorCollector(transport, rec.events, clock)
    const snap = await collector.start('s1')
    expect(snap?.cpu?.usage).toBe(42)
    expect(snap?.source).toBe('agent')
    expect(snap?.agentVersion).toBe('2')
  })

  it('代理返回 null 时自动回退脚本模式（服务器没装代理不影响监控）', async () => {
    const clock = new ManualClock()
    const transport = new PerModuleTransport()
    const withAgent: CollectorTransport = {
      exec: (s, c, t) => transport.exec(s, c),
      agentSample: async () => null,
    }
    const rec = recorder()
    const collector = new MonitorCollector(withAgent, rec.events, clock)
    const snap = await collector.start('s1', {
      cards: [{ kind: 'cpu', enabled: true, order: 0, tier: 'fast' }],
    })
    expect(snap?.cpu?.usage).toBe(7)
    expect(snap?.source).toBe('script')
    expect(transport.collects.length).toBe(1)
  })
})
