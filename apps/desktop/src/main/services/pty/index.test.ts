// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * pty 单测：输出合批（复用 services/output-batcher）+ 会话管理。
 *
 * **不加载 node-pty**（原生模块）：spawner / shell 探测 io 全部注入，
 * 因此这里验证的是纯逻辑，跑在普通 node 下也稳。
 *
 * 合批本身由共享的 OutputBatcher 实现（SSH 会话同款，另有独立单测），
 * 这里验证的是「PTY 数据路径确实按 16ms 帧合批」这一集成行为。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Actions } from '@t1000/shared'
import {
  DEFAULT_COLS,
  DEFAULT_ROWS,
  PTY_BATCH_MAX_BYTES,
  PTY_BATCH_MS,
  PtyManager,
  ptyHandlers,
  type PtyExitEvent,
  type PtySpawnOptions,
  type PtySpawner,
  type PtyProcessLike,
} from './index'
import { SHELLS_FILE, type ShellDetectIo } from './shells'

// ── 测试替身 ──────────────────────────────────────────────────────────────

class FakeProc implements PtyProcessLike {
  readonly pid = 4242
  readonly written: string[] = []
  readonly resizes: [number, number][] = []
  killed = false
  killSignal: string | undefined
  private dataCb: ((data: string) => void) | null = null
  private exitCb: ((event: PtyExitEvent) => void) | null = null

  onData(cb: (data: string) => void): void {
    this.dataCb = cb
  }

  onExit(cb: (event: PtyExitEvent) => void): void {
    this.exitCb = cb
  }

  write(data: string): void {
    this.written.push(data)
  }

  resize(cols: number, rows: number): void {
    this.resizes.push([cols, rows])
  }

  kill(signal?: string): void {
    this.killed = true
    this.killSignal = signal
  }

  emitData(data: string): void {
    this.dataCb?.(data)
  }

  emitExit(exitCode: number, signal?: number): void {
    this.exitCb?.(signal === undefined ? { exitCode } : { exitCode, signal })
  }
}

function fakeIo(
  existing: string[],
  shellsFile: string | null = null,
  env: Record<string, string> = {},
): ShellDetectIo {
  const set = new Set(existing)
  return {
    platform: 'linux',
    readFile: (path) => (path === SHELLS_FILE ? shellsFile : null),
    exists: (path) => set.has(path),
    env: (name) => env[name],
  }
}

interface Harness {
  manager: PtyManager
  procs: FakeProc[]
  spawnCalls: { file: string; args: readonly string[]; options: PtySpawnOptions }[]
  data: { ptyId: string; data: string }[]
  exits: { ptyId: string; exitCode: number; signal?: number }[]
}

function harness(overrides: {
  existing?: string[]
  shellsFile?: string | null
  baseEnv?: Record<string, string>
  cwdExists?: (path: string) => boolean
  homeDir?: string
  batchMaxBytes?: number
} = {}): Harness {
  const procs: FakeProc[] = []
  const spawnCalls: Harness['spawnCalls'] = []
  const data: Harness['data'] = []
  const exits: Harness['exits'] = []

  const spawner: PtySpawner = (file, args, options) => {
    const proc = new FakeProc()
    procs.push(proc)
    spawnCalls.push({ file, args, options })
    return proc
  }

  let seq = 0
  const manager = new PtyManager(
    {
      onData: (ptyId, chunk) => data.push({ ptyId, data: chunk }),
      onExit: (ptyId, exitCode, signal) =>
        exits.push(signal === undefined ? { ptyId, exitCode } : { ptyId, exitCode, signal }),
    },
    {
      spawner,
      batchMaxBytes: overrides.batchMaxBytes,
      io: fakeIo(
        overrides.existing ?? ['/bin/bash', '/bin/sh'],
        overrides.shellsFile ?? '/bin/bash\n/bin/sh\n',
        overrides.baseEnv ?? { SHELL: '/bin/bash' },
      ),
      env: overrides.baseEnv ?? { PATH: '/usr/bin:/bin', HOME: '/home/tester', TERM: 'xterm' },
      homeDir: overrides.homeDir ?? '/home/tester',
      cwdExists: overrides.cwdExists ?? (() => true),
      idFactory: () => `pty-${++seq}`,
      now: () => 1_700_000_000_000,
    },
  )

  return { manager, procs, spawnCalls, data, exits }
}

// 合批走全局 setTimeout（共享 OutputBatcher 的实现），用假定时器精确驱动
beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

// ── 输出合批（集成） ──────────────────────────────────────────────────────

describe('PTY 输出合批', () => {
  it('合批参数与 SSH 会话一致：16ms / 256KB', () => {
    expect(PTY_BATCH_MS).toBe(16)
    expect(PTY_BATCH_MAX_BYTES).toBe(256 * 1024)
  })

  it('窗口内的多个小块合成一次 PTY_DATA', async () => {
    const h = harness()
    const { ptyId } = await h.manager.open()
    const proc = h.procs[0]
    if (!proc) throw new Error('no proc')

    proc.emitData('line1\r\n')
    proc.emitData('line2\r\n')
    expect(h.data).toEqual([]) // 还在窗口内

    vi.advanceTimersByTime(PTY_BATCH_MS)
    expect(h.data).toEqual([{ ptyId, data: 'line1\r\nline2\r\n' }])
  })

  it('窗口未到不交付，窗口到了才交付一次', async () => {
    const h = harness()
    await h.manager.open()
    const proc = h.procs[0]
    if (!proc) throw new Error('no proc')

    proc.emitData('x')
    vi.advanceTimersByTime(PTY_BATCH_MS - 1)
    expect(h.data).toEqual([])

    vi.advanceTimersByTime(1)
    expect(h.data).toHaveLength(1)
  })

  it('超过体积上限立即冲刷，不等窗口', async () => {
    const h = harness({ batchMaxBytes: 4 })
    const { ptyId } = await h.manager.open()
    h.procs[0]?.emitData('1234')
    expect(h.data).toEqual([{ ptyId, data: '1234' }])
  })

  it('不同会话的输出互不串台', async () => {
    const h = harness()
    const a = await h.manager.open()
    const b = await h.manager.open()

    h.procs[0]?.emitData('from-a')
    h.procs[1]?.emitData('from-b')
    vi.advanceTimersByTime(PTY_BATCH_MS)

    expect(h.data).toEqual([
      { ptyId: a.ptyId, data: 'from-a' },
      { ptyId: b.ptyId, data: 'from-b' },
    ])
  })

  it('高吞吐下累计交付量正确（无丢数据）', async () => {
    const h = harness()
    await h.manager.open()
    const proc = h.procs[0]
    if (!proc) throw new Error('no proc')

    for (let i = 0; i < 100; i++) proc.emitData('chunk')
    vi.advanceTimersByTime(PTY_BATCH_MS)

    const total = h.data.reduce((sum, item) => sum + item.data.length, 0)
    expect(total).toBe(500)
    expect(h.data).toHaveLength(1)
  })
})

// ── 会话管理 ──────────────────────────────────────────────────────────────

describe('PtyManager.open', () => {
  it('解析 shell、注入 TERM/COLORTERM，返回会话信息', async () => {
    const h = harness()
    const result = await h.manager.open()

    expect(result.ptyId).toBe('pty-1')
    expect(result.pid).toBe(4242)
    expect(result.shell).toBe('/bin/bash') // 来自 $SHELL
    expect(result.cwd).toBe('/home/tester')
    expect(result.cols).toBe(DEFAULT_COLS)
    expect(result.rows).toBe(DEFAULT_ROWS)
    expect(result.cwdFallback).toBe(false)

    const call = h.spawnCalls[0]
    expect(call?.file).toBe('/bin/bash')
    expect(call?.args).toEqual([])
    expect(call?.options.env['TERM']).toBe('xterm-256color')
    expect(call?.options.env['COLORTERM']).toBe('truecolor')
    expect(call?.options.name).toBe('xterm-256color')
    // PATH 补齐
    expect(call?.options.env['PATH']?.split(':')).toContain('/usr/local/bin')
  })

  it('request.term 覆盖默认 TERM', async () => {
    const h = harness()
    await h.manager.open({ term: 'screen-256color', colorTerm: '24bit' })
    expect(h.spawnCalls[0]?.options.env['TERM']).toBe('screen-256color')
    expect(h.spawnCalls[0]?.options.env['COLORTERM']).toBe('24bit')
  })

  it('cwd 不存在时回退到家目录并标记', async () => {
    const h = harness({ cwdExists: () => false })
    const result = await h.manager.open({ cwd: '/no/such/dir' })
    expect(result.cwd).toBe('/home/tester')
    expect(result.cwdFallback).toBe(true)
    expect(h.spawnCalls[0]?.options.cwd).toBe('/home/tester')
  })

  it('cwd 合法时原样使用', async () => {
    const h = harness()
    const result = await h.manager.open({ cwd: '/srv/app' })
    expect(result.cwd).toBe('/srv/app')
    expect(result.cwdFallback).toBe(false)
  })

  it('按 profileId 解析 shell 与参数', async () => {
    const h = harness()
    const result = await h.manager.open({ profileId: 'bash' })
    expect(result.profileId).toBe('bash')
    expect(h.spawnCalls[0]?.file).toBe('/bin/bash')
  })

  it('未知 profileId 报 BAD_REQUEST', async () => {
    const h = harness()
    await expect(h.manager.open({ profileId: 'nope' })).rejects.toThrow(/未知的终端配置/)
  })

  it('request.env 与基础环境合并', async () => {
    const h = harness()
    await h.manager.open({ env: { MY_VAR: '1' } })
    expect(h.spawnCalls[0]?.options.env['MY_VAR']).toBe('1')
    expect(h.spawnCalls[0]?.options.env['HOME']).toBe('/home/tester')
  })

  it('cols/rows 越界被夹到合法范围', async () => {
    const h = harness()
    const result = await h.manager.open({ cols: 99999, rows: 0 })
    expect(result.cols).toBe(1000)
    expect(result.rows).toBe(1)
  })

  it('显式 shell 别名解析失败时原样交给 spawn（由 spawn 报错）', async () => {
    const h = harness()
    await h.manager.open({ shell: 'myshell' })
    expect(h.spawnCalls[0]?.file).toBe('myshell')
  })

  it('list 反映当前会话', async () => {
    const h = harness()
    await h.manager.open()
    await h.manager.open()
    expect(h.manager.list().map((s) => s.ptyId)).toEqual(['pty-1', 'pty-2'])
    expect(h.manager.get('pty-1')?.startedAt).toBe(1_700_000_000_000)
  })
})

describe('PtyManager 数据通路', () => {
  it('进程退出会先冲刷缓冲，再发 PTY_EXIT 并移除会话', async () => {
    const h = harness()
    const { ptyId } = await h.manager.open()
    const proc = h.procs[0]
    if (!proc) throw new Error('no proc')

    proc.emitData('bye')
    proc.emitExit(0)

    expect(h.data).toEqual([{ ptyId, data: 'bye' }])
    expect(h.exits).toEqual([{ ptyId, exitCode: 0 }])
    expect(h.manager.list()).toEqual([])
  })

  it('带信号的退出会带上 signal', async () => {
    const h = harness()
    const { ptyId } = await h.manager.open()
    h.procs[0]?.emitExit(137, 9)
    expect(h.exits).toEqual([{ ptyId, exitCode: 137, signal: 9 }])
  })

  it('write 转发到进程', async () => {
    const h = harness()
    const { ptyId } = await h.manager.open()
    h.manager.write(ptyId, 'ls -la\r')
    expect(h.procs[0]?.written).toEqual(['ls -la\r'])
  })

  it('resize 转发并更新会话信息', async () => {
    const h = harness()
    const { ptyId } = await h.manager.open()
    h.manager.resize(ptyId, 120, 40)
    expect(h.procs[0]?.resizes).toEqual([[120, 40]])
    expect(h.manager.get(ptyId)).toMatchObject({ cols: 120, rows: 40 })
  })

  it('close 刷缓冲、杀进程并移除会话', async () => {
    const h = harness()
    const { ptyId } = await h.manager.open()
    const proc = h.procs[0]
    if (!proc) throw new Error('no proc')
    proc.emitData('pending')

    expect(h.manager.close(ptyId)).toBe(true)
    expect(h.data).toEqual([{ ptyId, data: 'pending' }])
    expect(proc.killed).toBe(true)
    expect(h.manager.list()).toEqual([])
    expect(h.manager.close(ptyId)).toBe(false)
  })

  it('disposeAll 关闭全部会话', async () => {
    const h = harness()
    await h.manager.open()
    await h.manager.open()
    h.manager.disposeAll()
    expect(h.manager.list()).toEqual([])
    expect(h.procs.every((p) => p.killed)).toBe(true)
  })

  it('操作不存在的终端报 NOT_FOUND', async () => {
    const h = harness()
    expect(() => h.manager.write('pty-x', 'a')).toThrow(/终端不存在/)
    expect(() => h.manager.resize('pty-x', 80, 24)).toThrow(/终端不存在/)
  })
})

describe('pty IPC 契约', () => {
  it('handler 动作集合与 Actions.pty 完全一致', () => {
    expect(Object.keys(ptyHandlers).sort()).toEqual([...Actions.pty].sort())
  })

  it('每个动作都是可调用函数', () => {
    for (const [action, handler] of Object.entries(ptyHandlers)) {
      expect(typeof handler, `动作 ${action} 应该是函数`).toBe('function')
    }
  })
})

describe('PtyManager shell 查询', () => {
  it('listShells / listProfiles 用注入的 io', () => {
    const h = harness({
      existing: ['/bin/bash', '/usr/bin/fish'],
      shellsFile: '/bin/bash\n/usr/bin/fish\n',
    })
    expect(h.manager.listShells().map((s) => s.name)).toEqual(['bash', 'fish'])
    expect(h.manager.listProfiles().map((p) => p.id)).toEqual(['default', 'bash', 'fish'])
  })
})
