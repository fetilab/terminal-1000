// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

import { describe, expect, it, vi } from 'vitest'
import type { TelnetConnection } from '@t1000/shared'
import { feedAutoAuth } from './index'

/** 造一个最小 session：socket 收集写入，protocol 不参与本测试 */
function makeSession(opts: { username?: string; password?: string } = {}) {
  const writes: string[] = []
  const socket = {
    destroyed: false,
    write: vi.fn((data: string | Buffer) => {
      writes.push(String(data))
      return true
    }),
  }
  const connection = {
    kind: 'telnet',
    id: 't1',
    name: 'router',
    host: '192.168.1.1',
    port: 23,
    username: opts.username,
    password: opts.password,
  } as TelnetConnection
  const session = {
    sessionId: 's1',
    connection,
    socket: socket as unknown as import('node:net').Socket,
    protocol: {} as never,
    batcher: {} as never,
    state: 'ready' as const,
    keyRules: undefined,
    auth:
      opts.username && opts.username.length > 0
        ? { username: opts.username, password: opts.password ?? '', attempts: 0, tail: '' }
        : null,
  }
  return { session: session as never, writes }
}

describe('telnet 自动登录（提示符应答）', () => {
  it('未配置凭据的会话完全不参与应答', () => {
    const { session, writes } = makeSession({})
    feedAutoAuth(session, Buffer.from('Username: '))
    expect(writes).toHaveLength(0)
  })

  it('检测 Username: 提示符应答用户名，再检测 Password: 应答密码', () => {
    const { session, writes } = makeSession({ username: 'admin', password: 'p@ss' })
    feedAutoAuth(session, Buffer.from('\r\nWelcome\r\nUsername: '))
    expect(writes).toEqual(['admin\r\n'])
    feedAutoAuth(session, Buffer.from('admin\r\nPassword: '))
    expect(writes).toEqual(['admin\r\n', 'p@ss\r\n'])
  })

  it('login: 与 Password: 混合大小写、跨 chunk 分片也能匹配', () => {
    const { session, writes } = makeSession({ username: 'root', password: 'pw' })
    // 提示符被 TCP 分片切开：先送 "Lo"，再送 "gin: "
    feedAutoAuth(session, Buffer.from('Lo'))
    expect(writes).toHaveLength(0)
    feedAutoAuth(session, Buffer.from('gin: '))
    expect(writes).toEqual(['root\r\n'])
    // 常见设备会在提示符前打 ANSI 颜色码
    feedAutoAuth(session, Buffer.from('\x1b[32mPassword: \x1b[0m'))
    expect(writes).toEqual(['root\r\n', 'pw\r\n'])
  })

  it('中文提示符（UTF-8）也能应答', () => {
    const { session, writes } = makeSession({ username: 'admin', password: 'x' })
    feedAutoAuth(session, Buffer.from('用户名:'))
    expect(writes).toEqual(['admin\r\n'])
    feedAutoAuth(session, Buffer.from('密码:'))
    expect(writes).toEqual(['admin\r\n', 'x\r\n'])
  })

  it('行内出现 login 字样但不在行尾时不误触发（MOTD 横幅）', () => {
    const { session, writes } = makeSession({ username: 'admin', password: 'x' })
    feedAutoAuth(session, Buffer.from('login service started, 3 users online\r\n'))
    expect(writes).toHaveLength(0)
  })

  it('应答次数封顶：提示符反复出现（认证失败循环）不会无限发送', () => {
    const { session, writes } = makeSession({ username: 'admin', password: 'x' })
    for (let i = 0; i < 20; i++) feedAutoAuth(session, Buffer.from('Username: '))
    // AUTH_MAX_ATTEMPTS = 6
    expect(writes.length).toBe(6)
  })

  it('设备只问密码不问用户名时直接应答密码', () => {
    const { session, writes } = makeSession({ username: 'admin', password: 'pw' })
    feedAutoAuth(session, Buffer.from('Password: '))
    expect(writes).toEqual(['pw\r\n'])
  })
})
