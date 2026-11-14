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

describe('动态转发（SOCKS5）—— 回归：问候后的偏移', () => {
  beforeEach(() => clearSessions())
  afterEach(() => clearSessions())

  function dynamicTunnel(serverId: string): TunnelConnection {
    return {
      kind: 'tunnel',
      id: 'dyn-1',
      name: 'dyn',
      serverId,
      type: 'dynamic',
      localHost: '127.0.0.1',
      localPort: 0,
      autoReconnect: false,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }
  }

  /**
   * 走一遍 SOCKS5 握手。
   *
   * ⚠️ 必须**按偏移解析**而不能"一次 read 处理一个应答"：服务端可能把
   * 「问候应答(2B)」与「成功应答(10B)」合成一个 TCP 段 —— 我第一版就是这么写的，
   * 于是丢掉后 10 字节、永远等不到数据，看起来像服务端坏了。
   * `pipeline=true` 时把问候与请求放进**同一个 write**（真实客户端的常见优化，
   * 也正是把服务端偏移写成 2 而非 2+nmethods 时会踩到的那条路径）。
   */
  function socksConnect(
    port: number,
    target: { host: string; port: number },
    pipeline: boolean,
    /** 自定义问候（默认"单方法、无认证"）；用于验证 NMETHODS != 1 时的偏移 */
    customGreeting?: Buffer,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const s = connect(port, '127.0.0.1')
      const greeting = customGreeting ?? Buffer.from([0x05, 0x01, 0x00])
      const req = Buffer.from([
        0x05, 0x01, 0x00, 0x01,
        ...target.host.split('.').map(Number),
        target.port >> 8, target.port & 0xff,
      ])
      let buf = Buffer.alloc(0)
      let sentReq = false
      let connected = false
      s.setTimeout(4000)
      s.on('connect', () => {
        if (pipeline) {
          sentReq = true
          s.write(Buffer.concat([greeting, req]))
        } else {
          s.write(greeting)
        }
      })
      s.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk])
        // 1) 问候应答 2 字节
        if (buf.length >= 2 && !connected) {
          if (buf[0] !== 0x05 || buf[1] !== 0x00) {
            s.destroy()
            reject(new Error(`问候应答异常 ${buf.subarray(0, 2).toString('hex')}`))
            return
          }
          buf = buf.subarray(2)
          connected = true
          if (!sentReq) {
            sentReq = true
            s.write(req)
          }
        }
        // 2) CONNECT 应答 10 字节
        if (connected && sentReq && buf.length >= 10) {
          if (buf[0] !== 0x05 || buf[1] !== 0x00) {
            s.destroy()
            reject(new Error(`CONNECT 被拒 ${buf.subarray(0, 2).toString('hex')}`))
            return
          }
          buf = buf.subarray(10)
          if (buf.length === 0 && !s.__pinged) {
            ;(s as Socket & { __pinged?: boolean }).__pinged = true
            s.write('PING')
            return
          }
        }
        // 3) 回程数据
        const text = buf.toString()
        if (text.includes('PING')) {
          s.destroy()
          resolve(text)
        }
      })
      s.on('timeout', () => { s.destroy(); reject(new Error('超时')) })
      s.on('error', reject)
    })
  }

  function setupDynamic(): Promise<{ handle: SshSessionHandle; tunnel: Tunnel; port: number }> {
    // "远端"侧把收到的内容原样回送，验证数据真的经 forwardOut 出去
    const forwardOut = vi.fn(
      (
        _lh: string,
        _lp: number,
        _rh: string,
        _rp: number,
        cb: (err: Error | null, stream?: Duplex) => void,
      ) => {
        const toRemote = new PassThrough()
        const fromRemote = new PassThrough()
        toRemote.on('data', (c: Buffer) => fromRemote.write(c))
        cb(null, Duplex.from({ writable: toRemote, readable: fromRemote }))
      },
    )
    const handle = {
      sessionId: 's1',
      connectionId: 'conn-1',
      client: { forwardOut } as never,
      host: '10.0.0.9',
      port: 22,
      username: 'u',
      state: 'ready' as const,
      connectedAt: Date.now(),
      exec: (async () => ({ stdout: '', stderr: '', code: 0 })) as never,
    } satisfies SshSessionHandle
    registerSession(handle)
    const tunnel = new Tunnel(dynamicTunnel('conn-1'), noopEvents)
    return tunnel.open().then(() => ({ handle, tunnel, port: tunnel.getBoundPort() }))
  }

  it('★ 问候**单独**发送后握手（常规路径）', async () => {
    const { tunnel, port } = await setupDynamic()
    const echoed = await socksConnect(port, { host: '127.0.0.1', port: 8080 }, false)
    expect(echoed).toBe('PING')
    tunnel.close()
  })

  it('★ 回归：问候与请求**放在同一个包**里也必须能握手', async () => {
    // 这是修复前的失败场景：服务端把 `chunk.subarray(2)` 当成请求，
    // 而偏移 2 是**方法字节** —— 于是拿 1 个字节去解析 CONNECT，回 05 07（命令不支持）。
    // 表现是"动态转发对任何客户端都不工作"，而错误信息看起来像客户端的问题。
    const { tunnel, port } = await setupDynamic()
    const echoed = await socksConnect(port, { host: '127.0.0.1', port: 8080 }, true)
    expect(echoed).toBe('PING')
    tunnel.close()
  })

  it('NMETHODS 声明多个方法时偏移按 2+nmethods 算', async () => {
    const { tunnel, port } = await setupDynamic()
    // 问候带两个方法：05 02 00 02 → 偏移应为 4（若错写成 2，会把方法字节当请求）
    const greeting = Buffer.from([0x05, 0x02, 0x00, 0x02])
    const echoed = await socksConnect(port, { host: '127.0.0.1', port: 8080 }, true, greeting)
    expect(echoed).toBe('PING')
    tunnel.close()
  })

  it('动态隧道不要求远端目标（契约：SOCKS5 的目标来自请求）', async () => {
    const { tunnel, port } = await setupDynamic()
    expect(port).toBeGreaterThan(0)
    // 能起来就说明 remoteHost/remotePort 的缺失没有阻塞它
    expect(tunnel.getState()).toBe('ready')
    tunnel.close()
  })
})
