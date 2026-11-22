// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * SSH 会话层的端到端测试。
 *
 * 做法：用 ssh2 自带的 Server 在进程内起一个**真实 SSH 服务端**，
 * 让 SshSession 连上去跑完整协议流程。这样无需 root、无需外部主机，
 * 但验证的是真实握手/认证/通道，而不是 mock。
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Server, type Connection, type ServerConfig } from 'ssh2'
import { generateKeyPairSync } from 'node:crypto'
import type { SshConnection } from '@t1000/shared'
import {
  SshSession,
  assertSshSecretsUsable,
  fingerprintOf,
  type HostKeyAskInfo,
  type SshSessionEvents,
} from './session'

/** 测试用服务端私钥（一次性生成，仅存在于内存） */
function makeHostKey(): string {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
  })
  return privateKey
}

const PASSWORD = 'test-secret'

/** 起一个测试 SSH 服务端，返回端口与关闭函数 */
function startServer(
  hostKey: string,
  options: {
    /** shell 通道：收到会话后要输出什么 */
    onShell?: (stream: NodeJS.WritableStream) => void
    /** exec：命令 → 输出 */
    onExec?: (command: string) => { stdout: string; stderr?: string; code?: number }
  } = {},
): Promise<{ port: number; close: () => Promise<void>; connections: Connection[] }> {
  const connections: Connection[] = []

  const config: ServerConfig = { hostKeys: [hostKey] }

  return new Promise((resolve, reject) => {
    const server = new Server(config, (client) => {
      connections.push(client)

      client.on('authentication', (ctx) => {
        if (ctx.method === 'password' && ctx.password === PASSWORD) {
          ctx.accept()
        } else if (ctx.method === 'none') {
          // 先要求认证，迫使客户端走 password
          ctx.reject(['password'])
        } else {
          ctx.reject(['password'])
        }
      })

      client.on('ready', () => {
        client.on('session', (accept) => {
          const session = accept()

          session.on('shell', (acceptShell) => {
            const stream = acceptShell()
            const onShell = options.onShell
            if (onShell) {
              onShell(stream as unknown as NodeJS.WritableStream)
            } else {
              stream.write('welcome\n')
            }
            // 回显输入（模拟 PTY 行为）
            stream.on('data', (d: Buffer) => {
              stream.write(d)
            })
          })

          session.on('pty', (accept) => {
            accept?.()
          })

          session.on('window-change', (accept) => {
            accept?.()
          })

          session.on('exec', (acceptExec, _rejectExec, info) => {
            const stream = acceptExec()
            const result = options.onExec?.(info.command) ?? { stdout: '', code: 0 }
            if (result.stdout) stream.write(result.stdout)
            if (result.stderr) stream.stderr.write(result.stderr)
            stream.exit(result.code ?? 0)
            stream.end()
          })
        })
      })

      client.on('error', () => {
        /* 测试中忽略 */
      })
    })

    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      if (!addr || typeof addr === 'string') {
        reject(new Error('无法获取测试服务端端口'))
        return
      }
      resolve({
        port: addr.port,
        connections,
        close: () =>
          new Promise<void>((res) => {
            for (const c of connections) {
              try {
                c.end()
              } catch {
                /* 忽略 */
              }
            }
            server.close(() => res())
          }),
      })
    })
  })
}

/** 收集事件的测试替身 */
function makeEvents(overrides: Partial<SshSessionEvents> = {}): {
  events: SshSessionEvents
  states: string[]
  output: string[]
  errors: string[]
  hostKeyAsks: HostKeyAskInfo[]
} {
  const states: string[] = []
  const output: string[] = []
  const errors: string[] = []
  const hostKeyAsks: HostKeyAskInfo[] = []

  const events: SshSessionEvents = {
    onState: (state) => {
      states.push(state)
    },
    onData: (data) => {
      output.push(data)
    },
    onDebug: () => {},
    onError: (message) => {
      errors.push(message)
    },
    onClosed: () => {},
    onHostKeyAsk: async (info) => {
      hostKeyAsks.push(info)
      return true // 测试中一律接受
    },
    onAuthPrompt: async () => [],
    ...overrides,
  }

  return { events, states, output, errors, hostKeyAsks }
}

function makeConnection(port: number, overrides: Partial<SshConnection> = {}): SshConnection {
  return {
    kind: 'ssh',
    id: 'test-1',
    name: 'test',
    host: '127.0.0.1',
    port,
    username: 'tester',
    authType: 'password',
    password: PASSWORD,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  }
}

// 生成一次私钥供所有用例复用（生成 RSA 有开销）
const HOST_KEY = makeHostKey()

describe('SshSession 端到端（真实 ssh2 服务端）', () => {
  let server: Awaited<ReturnType<typeof startServer>>

  beforeAll(async () => {
    server = await startServer(HOST_KEY, {
      onShell: (stream) => {
        stream.write('welcome\n')
      },
      onExec: (command) => {
        if (command === 'echo hi') return { stdout: 'hi\n', code: 0 }
        if (command === 'fail') return { stdout: '', stderr: 'boom\n', code: 1 }
        return { stdout: `ran:${command}\n`, code: 0 }
      },
    })
  }, 20_000)

  afterAll(async () => {
    await server.close()
  })

  it('完整流程：连接 → 认证 → 打开 shell → 收到输出', async () => {
    const { events, states, output } = makeEvents()
    const session = new SshSession(makeConnection(server.port), {
      knownHosts: new Map(),
      events,
    })

    await session.connect()

    expect(session.getState()).toBe('ready')
    expect(states).toContain('connecting')
    expect(states).toContain('authenticating')
    expect(states).toContain('ready')

    // 输出经合批后交付，需要等一个时间窗
    await new Promise((r) => setTimeout(r, 60))
    expect(output.join('')).toContain('welcome')

    session.disconnect()
  }, 20_000)

  it('首次连接触发主机指纹询问，接受后可达 ready', async () => {
    const { events, hostKeyAsks } = makeEvents()
    const session = new SshSession(makeConnection(server.port), {
      knownHosts: new Map(),
      events,
    })

    await session.connect()

    expect(hostKeyAsks).toHaveLength(1)
    expect(hostKeyAsks[0]?.host).toBe('127.0.0.1')
    expect(hostKeyAsks[0]?.fingerprint).toMatch(/^SHA256:/)
    // 首次连接不应被标记为 mismatch
    expect(hostKeyAsks[0]?.mismatch).toBe(false)

    session.disconnect()
  }, 20_000)

  it('拒绝主机指纹时连接失败（安全默认）', async () => {
    const { events, states } = makeEvents({
      onHostKeyAsk: async () => false,
    })
    const session = new SshSession(makeConnection(server.port), {
      knownHosts: new Map(),
      events,
    })

    await expect(session.connect()).rejects.toThrow()
    expect(states).toContain('failed')
  }, 20_000)

  it('指纹已信任时不弹询问（快路径零打扰）', async () => {
    // 先用一次连接拿到真实指纹
    const first = makeEvents()
    const probe = new SshSession(makeConnection(server.port), {
      knownHosts: new Map(),
      events: first.events,
    })
    await probe.connect()
    const fingerprint = first.hostKeyAsks[0]?.fingerprint
    probe.disconnect()
    expect(fingerprint).toBeTruthy()

    // 再连一次，预置信任
    const second = makeEvents()
    const knownHosts = new Map([[`127.0.0.1:${server.port}`, fingerprint!]])
    const session = new SshSession(makeConnection(server.port), { knownHosts, events: second.events })
    await session.connect()

    expect(second.hostKeyAsks).toHaveLength(0)
    session.disconnect()
  }, 20_000)

  it('指纹变更被标记为 mismatch（防中间人）', async () => {
    const { events, hostKeyAsks } = makeEvents()
    const knownHosts = new Map([[`127.0.0.1:${server.port}`, 'SHA256:totally-different-old-key']])
    const session = new SshSession(makeConnection(server.port), { knownHosts, events })

    await session.connect()

    expect(hostKeyAsks).toHaveLength(1)
    expect(hostKeyAsks[0]?.mismatch).toBe(true)
    session.disconnect()
  }, 20_000)

  it('密码错误时进入 failed 状态并报错', async () => {
    const { events, states, errors } = makeEvents()
    const session = new SshSession(makeConnection(server.port, { password: 'wrong-password' }), {
      knownHosts: new Map(),
      events,
    })

    await expect(session.connect()).rejects.toThrow()
    expect(states).toContain('failed')
    expect(errors.length).toBeGreaterThan(0)
  }, 20_000)

  it('write 把数据送到远端 shell（回显验证）', async () => {
    const { events, output } = makeEvents()
    const session = new SshSession(makeConnection(server.port), {
      knownHosts: new Map(),
      events,
    })
    await session.connect()

    session.write('ping-from-client\n')
    await new Promise((r) => setTimeout(r, 120))

    expect(output.join('')).toContain('ping-from-client')
    session.disconnect()
  }, 20_000)

  it('exec 返回标准输出与退出码', async () => {
    const { events } = makeEvents()
    const session = new SshSession(makeConnection(server.port), {
      knownHosts: new Map(),
      events,
    })
    await session.connect()

    const res = await session.exec('echo hi')
    expect(res.stdout).toBe('hi\n')
    expect(res.code).toBe(0)

    session.disconnect()
  }, 20_000)

  it('exec 非零退出码与 stderr 都被捕获', async () => {
    const { events } = makeEvents()
    const session = new SshSession(makeConnection(server.port), {
      knownHosts: new Map(),
      events,
    })
    await session.connect()

    const res = await session.exec('fail')
    expect(res.code).toBe(1)
    expect(res.stderr).toBe('boom\n')

    session.disconnect()
  }, 20_000)

  it('exec 超时被强制中止并抛 TIMEOUT', async () => {
    const { events } = makeEvents()
    const session = new SshSession(makeConnection(server.port), {
      knownHosts: new Map(),
      events,
    })
    await session.connect()

    // 服务端对未知命令会立刻返回，这里用一个 hack：请求一个不返回的命令较难，
    // 改为验证超时参数确实生效（1ms 必然超时）
    await expect(session.exec('echo hi', 1)).rejects.toThrow(/超时/)

    session.disconnect()
  }, 20_000)

  it('未连接时 write/exec 抛出 NOT_CONNECTED', async () => {
    const { events } = makeEvents()
    const session = new SshSession(makeConnection(server.port), {
      knownHosts: new Map(),
      events,
    })

    expect(() => session.write('x')).toThrow()
    await expect(session.exec('x')).rejects.toThrow()
  })

  it('测试连接失败时状态为 failed，不会停留在 connecting', async () => {
    const { events, states } = makeEvents()
    const session = new SshSession(
      makeConnection(server.port, { port: 1 }), // 必然连不上
      {
        knownHosts: new Map(),
        events,
        onHostKeyAccepted: () => {},
      },
    )

    await expect(session.connect()).rejects.toThrow()
    expect(states[states.length - 1]).toBe('failed')
  }, 20_000)
})

describe('fingerprintOf', () => {
  it('输出 OpenSSH 风格前缀并剔除 base64 填充', () => {
    const fp = fingerprintOf(Buffer.from('some-key-blob'))
    expect(fp.startsWith('SHA256:')).toBe(true)
    expect(fp).not.toContain('=')
  })

  it('相同输入产生相同指纹（确定性）', () => {
    const key = Buffer.from('abc')
    expect(fingerprintOf(key)).toBe(fingerprintOf(key))
  })

  it('不同输入产生不同指纹', () => {
    expect(fingerprintOf(Buffer.from('a'))).not.toBe(fingerprintOf(Buffer.from('b')))
  })
})

/**
 * 凭据预检：掩码缓存 / 非法私钥格式必须在 ssh2 之前被拦下，
 * 否则用户看到的是 "Cannot parse privateKey: Unsupported key format"。
 * 这组用例直接对应「重启后私钥连接失败」的线上回归。
 */
describe('assertSshSecretsUsable（凭据预检）', () => {
  const OPENSSH_KEY = [
    '-----BEGIN OPENSSH PRIVATE KEY-----',
    'b3BlbnNzaC1rZXktdjEAAAAABG5vbmV0ZAAAAAAAAAEAAAABAAAABg==',
    '-----END OPENSSH PRIVATE KEY-----',
  ].join('\n')

  const baseConn = (): SshConnection =>
    ({
      id: 'c1',
      kind: 'ssh',
      name: 't',
      host: 'h',
      port: 22,
      username: 'u',
      authType: 'privateKey',
      state: 'idle',
      createdAt: '',
      updatedAt: '',
    }) as SshConnection

  it('锁定掩码私钥被拦下（提示先解锁，而不是 ssh2 的解析错误）', () => {
    const conn = { ...baseConn(), privateKey: '__LOCKED__' }
    expect(() => assertSshSecretsUsable(conn)).toThrow(/解锁主密码/)
  })

  it('历史上被污染的记录（掩码作为子串出现）同样拦截', () => {
    const conn = { ...baseConn(), privateKey: 'v1:xx\n__LOCKED__\n' }
    expect(() => assertSshSecretsUsable(conn)).toThrow(/解锁主密码/)
  })

  it('PuTTY .ppk 私钥被拦下并给出转换指引', () => {
    const conn = {
      ...baseConn(),
      privateKey: 'PuTTY-User-Key-File-3: EdDSA\nEncryption: none\nPublic-Lines: 4\n',
    }
    expect(() => assertSshSecretsUsable(conn)).toThrow(/PuTTY/)
  })

  it('需要私钥但一个都取不到 → 明确提示重新粘贴', () => {
    const savedSock = process.env['SSH_AUTH_SOCK']
    delete process.env['SSH_AUTH_SOCK']
    try {
      expect(() => assertSshSecretsUsable(baseConn())).toThrow(/重新粘贴私钥/)
    } finally {
      if (savedSock !== undefined) process.env['SSH_AUTH_SOCK'] = savedSock
    }
  })

  it('合法 OpenSSH 私钥不拦截', () => {
    expect(() => assertSshSecretsUsable({ ...baseConn(), privateKey: OPENSSH_KEY })).not.toThrow()
  })

  it('跳板链里的掩码私钥同样拦截', () => {
    const conn = {
      ...baseConn(),
      privateKey: OPENSSH_KEY,
      jumpChain: [{ id: 'j1', host: 'jump', port: 22, username: 'j', privateKey: '__LOCKED__' }],
    } as SshConnection
    expect(() => assertSshSecretsUsable(conn)).toThrow(/解锁主密码/)
  })

  it('密码认证 + 键盘交互兜底时不因缺私钥拦截', () => {
    const savedSock = process.env['SSH_AUTH_SOCK']
    delete process.env['SSH_AUTH_SOCK']
    try {
      expect(() => assertSshSecretsUsable({ ...baseConn(), password: 'p' })).not.toThrow()
      expect(() =>
        assertSshSecretsUsable({ ...baseConn(), authOrder: ['keyboard'] }),
      ).not.toThrow()
    } finally {
      if (savedSock !== undefined) process.env['SSH_AUTH_SOCK'] = savedSock
    }
  })
})
