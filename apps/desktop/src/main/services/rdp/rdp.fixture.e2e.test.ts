// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * RDP 端到端（**默认运行**）：真实 `spawn` + 仓库内假 FreeRDP 客户端夹具。
 *
 * 我们的 RDP 实现真正负责的是「二进制探测 → 参数映射 → 进程生命周期上报」，
 * 所以这里验证的边界是**真实进程**：断言子进程实际收到的 argv（而不是只断言
 * `buildRdpArgs` 的返回值），以及退出码/信号/主动结束是否被如实分类。
 *
 * 夹具 `test-fixtures/fake-freerdp/` 通过注入 PATH 生效，从不联网；
 * `T1000_RDP_E2E` 门控（`rdp.e2e.test.ts`）仍保留用于真实 xrdp 服务端验收。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ConnectionState, RdpConnection } from '@t1000/shared'
import { RdpManager, findRdpBinary, type RdpEventSink } from './index'

// ---------------------------------------------------------------------------
// 环境脚手架
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url))
const FIXTURE_ROOT = join(here, '..', '..', '..', '..', 'test-fixtures', 'fake-freerdp')
const X11_BIN = join(FIXTURE_ROOT, 'bin')
const WAYLAND_BIN = join(FIXTURE_ROOT, 'wl-bin')
const NODE_DIR = dirname(process.execPath)

interface FakeCall {
  invokedAs: string
  argv: string[]
  pid: number
  cwd: string
  display: string | null
}

interface Harness {
  manager: RdpManager
  states: Array<{ state: ConnectionState; message?: string }>
  exits: Array<{ code: number | null; signal: string | null; crashed: boolean }>
}

const managers: RdpManager[] = []
let workDir = ''
let recordFile = ''
let savedEnv: NodeJS.ProcessEnv = {}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 't1000-fake-rdp-'))
  recordFile = join(workDir, 'calls.jsonl')
  savedEnv = { ...process.env }
  process.env['T1000_FAKE_RDP_RECORD'] = recordFile
})

afterEach(() => {
  for (const manager of managers.splice(0)) manager.shutdown()
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) delete process.env[key]
  }
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  rmSync(workDir, { recursive: true, force: true })
})

/** 把 PATH 指向夹具目录（node 目录保留，外壳脚本还要 exec node）；返回期望被选中的可执行文件 */
function useFakeBinary(which: 'x11' | 'wayland'): string {
  const dir = which === 'x11' ? X11_BIN : WAYLAND_BIN
  process.env['PATH'] = [dir, NODE_DIR, '/usr/bin', '/bin'].join(':')
  return join(dir, which === 'x11' ? 'xfreerdp' : 'wlfreerdp')
}

function fakeEnv(patch: Record<string, string>): void {
  for (const [key, value] of Object.entries(patch)) process.env[key] = value
}

function calls(): FakeCall[] {
  if (!existsSync(recordFile)) return []
  return readFileSync(recordFile, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as FakeCall)
}

async function waitFor(predicate: () => boolean, what: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`等待超时：${what}`)
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function makeHarness(): Harness {
  const states: Harness['states'] = []
  const exits: Harness['exits'] = []
  const sink: RdpEventSink = {
    state(_id, state, message) {
      states.push(message === undefined ? { state } : { state, message })
    },
    exit(_id, info) {
      exits.push(info)
    },
  }
  const manager = new RdpManager({ sink })
  managers.push(manager)
  return { manager, states, exits }
}

function rdpConnection(patch: Partial<RdpConnection> = {}): RdpConnection {
  const now = '2026-01-01T00:00:00.000Z'
  return {
    kind: 'rdp',
    id: 'fixture-rdp',
    name: 'fixture',
    host: 'rdp.invalid',
    port: 3389,
    username: 'bob',
    createdAt: now,
    updatedAt: now,
    ...patch,
  }
}

function lastMessage(h: Harness): string {
  return h.states
    .map((s) => s.message ?? '')
    .filter((m) => m.length > 0)
    .join('\n')
}

// ---------------------------------------------------------------------------

describe('RDP 端到端（假 FreeRDP 客户端，默认运行）', () => {
  it('二进制探测选中注入的夹具，而不是系统里真实存在的客户端', () => {
    const expected = useFakeBinary('x11')
    expect(findRdpBinary()).toBe(expected)
    // 候选回退：目录里只有 wlfreerdp 时，跳过前面两个候选命中它
    const wayland = useFakeBinary('wayland')
    expect(findRdpBinary()).toBe(wayland)
  })

  it('★ 参数映射完整送达真实子进程（host/port/user/domain/口令/全屏/分辨率/画质/剪贴板）', async () => {
    const binary = useFakeBinary('x11')
    fakeEnv({ T1000_FAKE_RDP_MODE: 'exit', T1000_FAKE_RDP_CODE: '0' })
    const h = makeHarness()

    const connection = rdpConnection({
      host: 'rdp.invalid',
      port: 3390,
      username: 'alice',
      password: 'p@ss word',
      domain: 'CORP',
      displayMode: 'fixed-resolution',
      width: 1440,
      height: 900,
      quality: 'high',
      clipboardShare: true,
    })
    const expected = [
      '/v:rdp.invalid:3390',
      '/u:alice',
      '/d:CORP',
      '/p:p@ss word',
      '/cert:ignore',
      '/f',
      '/size:1440x900',
      '/bpp:32',
      '/network:lan',
      '/clipboard',
    ]

    const result = h.manager.connect(connection, { fullscreen: true })
    expect(result.executable).toBe(binary)

    await waitFor(() => calls().length >= 1, '夹具收到调用')
    const call = calls()[0]!
    // 子进程实际 argv 必须与返回给调用方的完全一致（spawn 不得吞参数/改引号）
    expect(call.argv).toEqual(expected)
    expect(result.args).toEqual(expected)
    expect(call.invokedAs).toBe('xfreerdp')
    // 口令确实在命令行上（已知取舍：ps 可见），不能被静默丢掉
    expect(call.argv).toContain('/p:p@ss word')
  })

  it('★ 没有口令也显式传空 ` /p:`（漏传会让 xfreerdp 转去交互式索要凭据并秒退）', async () => {
    useFakeBinary('x11')
    fakeEnv({ T1000_FAKE_RDP_MODE: 'exit', T1000_FAKE_RDP_CODE: '0' })
    const h = makeHarness()

    const expected = [
      '/v:host.invalid:3389',
      '/u:bob',
      '/p:',
      '/cert:ignore',
      '/size:1280x800',
      '/dynamic-resolution',
      '/bpp:16',
      '/network:modem',
      '-clipboard',
    ]
    const connection = rdpConnection({ host: 'host.invalid', quality: 'low', clipboardShare: false })
    const result = h.manager.connect(connection)

    await waitFor(() => calls().length >= 1, '夹具收到调用')
    expect(calls()[0]!.argv).toEqual(expected)
    expect(result.args).toContain('/p:')
    expect(result.args.some((arg) => arg.startsWith('/p:undefined'))).toBe(false)
  })

  it('跟随窗口缺省画质：/bpp:24 + /network:broadband，且域缺省时不生成 /d:', async () => {
    useFakeBinary('x11')
    fakeEnv({ T1000_FAKE_RDP_MODE: 'exit', T1000_FAKE_RDP_CODE: '0' })
    const h = makeHarness()

    h.manager.connect(rdpConnection({ host: 'h.invalid', port: 3389, username: 'u' }))
    await waitFor(() => calls().length >= 1, '夹具收到调用')

    const argv = calls()[0]!.argv
    expect(argv).toEqual([
      '/v:h.invalid:3389',
      '/u:u',
      '/p:',
      '/cert:ignore',
      '/size:1280x800',
      '/dynamic-resolution',
      '/bpp:24',
      '/network:broadband',
      '-clipboard',
    ])
    expect(argv.some((arg) => arg.startsWith('/d:'))).toBe(false)
  })

  it('★ 主动 disconnect：驻留进程被真的结束，且不产生崩溃事件', async () => {
    useFakeBinary('x11')
    fakeEnv({ T1000_FAKE_RDP_MODE: 'resident', T1000_FAKE_RDP_MAX_MS: '15000' })
    const h = makeHarness()

    const { sessionId } = h.manager.connect(rdpConnection())
    await waitFor(() => calls().length >= 1, '夹具启动')
    const pid = calls()[0]!.pid
    expect(processAlive(pid)).toBe(true)
    expect(h.states.some((s) => s.state === 'ready')).toBe(true)

    expect(h.manager.disconnect(sessionId)).toBe(true)
    await waitFor(() => !processAlive(pid), '驻留进程被结束')
    await new Promise((resolve) => setTimeout(resolve, 100))

    expect(h.manager.list()).toEqual([])
    expect(h.exits).toEqual([])
    expect(h.states[h.states.length - 1]?.state).toBe('disconnected')
    expect(h.states.some((s) => s.state === 'failed')).toBe(false)
  })

  it('★ 异常退出：如实上报退出码，并把客户端 stderr 带进状态消息', async () => {
    useFakeBinary('x11')
    fakeEnv({
      T1000_FAKE_RDP_MODE: 'exit',
      T1000_FAKE_RDP_CODE: '7',
      T1000_FAKE_RDP_STDERR: 'ERRCONNECT: 无法连接到目标主机',
    })
    const h = makeHarness()

    h.manager.connect(rdpConnection())
    await waitFor(() => h.exits.length >= 1, '退出事件')

    expect(h.exits[0]).toEqual({ code: 7, signal: null, crashed: true })
    expect(h.states[h.states.length - 1]?.state).toBe('disconnected')
    const message = lastMessage(h)
    expect(message).toMatch(/异常退出（code=7）/)
    expect(message).toMatch(/无法连接到目标主机/)
    expect(h.manager.list()).toEqual([])
  })

  it('秒退 code=127：给出"二进制无法执行或找不到"的可操作提示', async () => {
    useFakeBinary('x11')
    fakeEnv({ T1000_FAKE_RDP_MODE: 'quick-exit', T1000_FAKE_RDP_CODE: '127' })
    const h = makeHarness()

    h.manager.connect(rdpConnection())
    await waitFor(() => h.exits.length >= 1, '退出事件')

    expect(h.exits[0]).toEqual({ code: 127, signal: null, crashed: true })
    expect(lastMessage(h)).toMatch(/126\/127/)
  })

  it('wlfreerdp 秒退 code=255：给出"显示环境/Wayland"专用提示', async () => {
    const binary = useFakeBinary('wayland')
    fakeEnv({ T1000_FAKE_RDP_MODE: 'quick-exit', T1000_FAKE_RDP_CODE: '255' })
    const h = makeHarness()

    const result = h.manager.connect(rdpConnection())
    expect(result.executable).toBe(binary)
    await waitFor(() => h.exits.length >= 1, '退出事件')

    expect(calls()[0]!.invokedAs).toBe('wlfreerdp')
    expect(h.exits[0]).toEqual({ code: 255, signal: null, crashed: true })
    expect(lastMessage(h)).toMatch(/Wayland/)
  })

  it('shutdown：结束全部驻留进程，不留孤儿', async () => {
    useFakeBinary('x11')
    fakeEnv({ T1000_FAKE_RDP_MODE: 'resident', T1000_FAKE_RDP_MAX_MS: '15000' })
    const h = makeHarness()

    h.manager.connect(rdpConnection())
    h.manager.connect(rdpConnection())
    await waitFor(() => calls().length >= 2, '两个驻留进程')
    const pids = calls().map((c) => c.pid)
    expect(pids).toHaveLength(2)

    h.manager.shutdown()
    for (const pid of pids) await waitFor(() => !processAlive(pid), `pid ${pid} 被结束`)
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(h.exits).toEqual([])
    expect(h.manager.list()).toEqual([])
  })

  it('★ sendResize：以新尺寸重启查看器，旧进程按代际守卫不产生崩溃事件', async () => {
    useFakeBinary('x11')
    fakeEnv({ T1000_FAKE_RDP_MODE: 'resident', T1000_FAKE_RDP_MAX_MS: '15000' })
    const h = makeHarness()

    const { sessionId } = h.manager.connect(rdpConnection())
    await waitFor(() => calls().length >= 1, '首个进程')
    const firstPid = calls()[0]!.pid

    const resized = h.manager.sendResize(sessionId, 1024, 768)
    expect(resized).toEqual({ sessionId, width: 1024, height: 768, restarted: true })

    await waitFor(() => calls().length >= 2, '重启后的新进程')
    const second = calls()[1]!
    expect(second.argv).toContain('/size:1024x768')
    expect(second.argv).not.toContain('/dynamic-resolution')

    await waitFor(() => !processAlive(firstPid), '旧进程被结束')
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(h.exits).toEqual([])
    expect(h.states[h.states.length - 1]?.state).toBe('ready')
  })
})
