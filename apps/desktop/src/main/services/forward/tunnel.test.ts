// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 端口转发测试。
 *
 * 这个目录此前**一个测试都没有** —— 于是下面这个 bug 一直活着：
 * 配置里的 `serverId` 是**连接** id（界面下拉选的是连接库条目），
 * 而会话注册表按**会话** id（随机 UUID）索引，代码却直接拿它当 sessionId 查表，
 * 结果 `requireSession` 必然抛"会话不存在" → **隧道从来没真正打开过**。
 *
 * 所以这里既测"解析承载会话"的各种情形，也**真的把本地转发跑起来**：
 * 起本地监听 → 连上去 → 断言数据经 `forwardOut` 送达远端、双向都能回。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { connect, type Socket } from 'node:net'
import { Duplex, PassThrough } from 'node:stream'
import type { TunnelConnection } from '@t1000/shared'
import {
  clearSessions,
  registerSession,
  listSessions,
  type SshSessionHandle,
} from '../session-registry'
import { Tunnel, resolveCarrierSession } from './tunnel'

/** 造一个假的 SSH 会话句柄；forwardOut 记录调用并返回一条双向管道 */
function fakeSession(opts: {
  sessionId: string
  connectionId: string
  state?: 'ready' | 'connecting' | 'disconnected'
}): {
  handle: SshSessionHandle
  forwardOut: ReturnType<typeof vi.fn>
} {
  const forwardOut = vi.fn(
    (
      _localHost: string,
      _localPort: number,
      _remoteHost: string,
      _remotePort: number,
      cb: (err: Error | null, stream?: Duplex) => void,
    ) => {
      // 真实的 SSH 通道是**双工**的：写入端与读出端相互独立。
      // 用一个 PassThrough 边读边写自身会产生竞态（我第一次就这么写，回程数据丢了）。
      const toRemote = new PassThrough()
      const fromRemote = new PassThrough()
      // "远端"把收到的内容转成大写回送 —— 便于断言数据真的穿过去了
      toRemote.on('data', (chunk: Buffer) => fromRemote.write(chunk.toString('utf8').toUpperCase()))
      cb(null, Duplex.from({ writable: toRemote, readable: fromRemote }))
    },
  )

  const handle = {
    sessionId: opts.sessionId,
    connectionId: opts.connectionId,
    client: { forwardOut } as never,
    host: '10.0.0.9',
    port: 22,
    username: 'tester',
    state: opts.state ?? 'ready',
    connectedAt: Date.now(),
    exec: (async () => ({ stdout: '', stderr: '', code: 0 })) as never,
  } satisfies SshSessionHandle

  return { handle, forwardOut }
}

function localTunnel(serverId: string, extra: Partial<TunnelConnection> = {}): TunnelConnection {
  return {
    kind: 'tunnel',
    id: 'tun-1',
    name: 'test-tunnel',
    serverId,
    type: 'local',
    localHost: '127.0.0.1',
    localPort: 0, // 由系统分配，避免测试端口冲突
    remoteHost: '10.0.0.9',
    remotePort: 8080,
    autoReconnect: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...extra,
  }
}

const noopEvents = {
  onState: () => {},
  onInfo: () => {},
  onWarn: () => {},
  onError: () => {},
}

/** 连本地监听端口、发一句话、拿回响应 */
function roundTrip(port: number, message: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock: Socket = connect(port, '127.0.0.1')
    let got = ''
    sock.setTimeout(4000)
    sock.on('connect', () => sock.write(message))
    sock.on('data', (chunk) => {
      got += chunk.toString('utf8')
    })
    sock.on('timeout', () => {
      sock.destroy()
      reject(new Error(`读回超时，已收到: ${JSON.stringify(got)}`))
    })
    sock.on('error', reject)
    // 远端回送后由测试侧主动收尾
    setTimeout(() => {
      sock.destroy()
      resolve(got)
    }, 300)
  })
}

describe('resolveCarrierSession —— 承载会话解析', () => {
  beforeEach(() => clearSessions())
  afterEach(() => clearSessions())

  it('★ 传"连接 id"能找到该连接当前就绪的会话（这正是此前的 bug）', () => {
    const { handle } = fakeSession({ sessionId: 'sess-uuid', connectionId: 'conn-1' })
    registerSession(handle)

    // 配置里存的是 conn-1（连接 id），不是 sess-uuid
    const found = resolveCarrierSession('conn-1')
    expect(found.sessionId).toBe('sess-uuid')
    expect(found.connectionId).toBe('conn-1')
  })

  it('传"会话 id"也能命中（兼容运行时直接传 sessionId）', () => {
    const { handle } = fakeSession({ sessionId: 'sess-uuid', connectionId: 'conn-1' })
    registerSession(handle)
    expect(resolveCarrierSession('sess-uuid').sessionId).toBe('sess-uuid')
  })

  it('★ 连接存在但会话未就绪 → 报错并提示先连接，而不是拿一条不能用的会话去转发', () => {
    const { handle } = fakeSession({
      sessionId: 'sess-1',
      connectionId: 'conn-1',
      state: 'connecting',
    })
    registerSession(handle)
    expect(() => resolveCarrierSession('conn-1')).toThrow(/没有可用的 SSH 会话/)
  })

  it('完全未知的 id → 错误信息里带上它，便于排查', () => {
    expect(() => resolveCarrierSession('nope-1')).toThrow(/nope-1/)
  })

  it('同一连接有多条会话时，取就绪的那条', () => {
    const bad = fakeSession({ sessionId: 's-bad', connectionId: 'conn-1', state: 'disconnected' })
    const good = fakeSession({ sessionId: 's-good', connectionId: 'conn-1' })
    registerSession(bad.handle)
    registerSession(good.handle)
    expect(resolveCarrierSession('conn-1').sessionId).toBe('s-good')
  })
})

describe('本地转发真的能通', () => {
  beforeEach(() => clearSessions())
  afterEach(() => clearSessions())

  it('★ 起本地监听 → 连上去 → 数据经 forwardOut 送达远端并回传', async () => {
    const { handle, forwardOut } = fakeSession({ sessionId: 's1', connectionId: 'conn-1' })
    registerSession(handle)

    const tunnel = new Tunnel(localTunnel('conn-1'), noopEvents)
    await tunnel.open()
    const port = tunnel.getBoundPort()
    expect(port).toBeGreaterThan(0)

    // 端到端：写 hello → 远端转大写回送 → 本地读到 HELLO
    const echoed = await roundTrip(port, 'hello')
    expect(echoed).toBe('HELLO')

    // `forwardOut` 是**每条入站连接**调用一次（一条本地连接 = 一条转发通道），
    // 所以必须在真正连过之后断言，而不是 open() 之后立刻断言。
    expect(forwardOut).toHaveBeenCalledTimes(1)
    const call = forwardOut.mock.calls[0]!
    expect(call[2]).toBe('10.0.0.9') // remoteHost 如实传递
    expect(call[3]).toBe(8080) // remotePort

    tunnel.close()
  })

  it('承载连接不存在时 open 抛错，且状态变成 failed（不是静默挂起）', async () => {
    const states: string[] = []
    const tunnel = new Tunnel(localTunnel('ghost-conn'), {
      ...noopEvents,
      onState: (_id, state) => states.push(state),
    })
    await expect(tunnel.open()).rejects.toThrow(/没有可用的 SSH 会话/)
    expect(tunnel.getState()).toBe('failed')
    expect(states).toContain('failed')
  })

  it('关闭隧道后本地端口被释放（不留下孤儿监听）', async () => {
    const { handle } = fakeSession({ sessionId: 's1', connectionId: 'conn-1' })
    registerSession(handle)

    const tunnel = new Tunnel(localTunnel('conn-1'), noopEvents)
    await tunnel.open()
    const port = tunnel.getBoundPort()
    tunnel.close()

    // 等监听真正释放
    await new Promise((r) => setTimeout(r, 200))
    // 端口已释放：再连应当失败
    await expect(
      new Promise((resolve, reject) => {
        const s = connect(port, '127.0.0.1')
        s.on('connect', () => {
          s.destroy()
          resolve('connected')
        })
        s.on('error', reject)
      }),
    ).rejects.toBeTruthy()
  })

  it('关闭隧道不影响承载会话本身（spec：关转发不影响终端）', async () => {
    const { handle } = fakeSession({ sessionId: 's1', connectionId: 'conn-1' })
    registerSession(handle)
    const tunnel = new Tunnel(localTunnel('conn-1'), noopEvents)
    await tunnel.open()
    tunnel.close()
    // 会话仍在注册表里，可被下一条隧道继续复用
    expect(listSessions().map((s) => s.sessionId)).toContain('s1')
  })
})
