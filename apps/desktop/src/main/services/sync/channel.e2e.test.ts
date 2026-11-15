// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * TSC/1 **互通**端到端测试：我们的客户端（TS）↔ **store-dev 交付的真实服务端**（零依赖 JS）。
 *
 * 为什么这条比单测更重要：协议核与向量只能证明"在给定输入下两侧算法一致"，
 * 证明不了**两份独立实现真的能连起来**。这里起真实 TCP 服务端、走真实握手与加密帧，
 * 所以它是"两侧能互通"的人证。
 *
 * 顺带覆盖几个"只有真连起来才会暴露"的点：
 * - 握手字段的顺序/偏移（任一处错位都会立刻失败）
 * - `headers.authorization` 白名单（规范 §6.1）
 * - 错误路径：pin 不符要让客户端在**发送任何应用数据之前**就拒绝
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SecureChannel, SecureChannelError } from './channel'
import { fingerprintOf } from './protocol'

// 服务端是仓库里的零依赖 JS（不被 TS 编译，但 vitest 能直接加载）
import { startTsc1Server } from '../../../../../../server/src/tsc1/listener.js'
import { readIdentityPublicRaw } from '../../../../../../server/src/tsc1/identity.js'

interface Running {
  server: { close: (cb?: () => void) => void; address: () => { port: number } | string | null }
  identity: { publicKeyRaw: Buffer; fingerprint: string }
  fingerprint: string
  publicKey: Buffer
  port: number
  dataDir: string
}

let running: Running | null = null

/** 起一个真实 TSC/1 服务端；`dispatch` 是桩（我们只验传输层打通，不验业务路由） */
async function startServer(
  dispatch?: (req: { method: string; path: string; body?: unknown }) => Promise<unknown>,
): Promise<Running> {
  const dataDir = mkdtempSync(join(tmpdir(), 't1000-tsc1-'))
  const logs: string[] = []
  const { server, identity } = await startTsc1Server({
    dataDir,
    host: '127.0.0.1',
    port: 0,
    log: (m: string) => logs.push(m),
    dispatch:
      dispatch ??
      (async (req: { method: string; path: string; body?: unknown }) => ({
        ok: true,
        echo: { method: req.method, path: req.path, body: req.body ?? null },
      })),
  })
  const addr = server.address()
  const port = typeof addr === 'object' && addr ? addr.port : 0
  const publicKey = readIdentityPublicRaw(dataDir) as Buffer
  return {
    server,
    identity,
    fingerprint: identity.fingerprint,
    publicKey,
    port,
    dataDir,
  }
}

beforeEach(() => {
  running = null
})
afterEach(() => {
  if (running) {
    running.server.close()
    rmSync(running.dataDir, { recursive: true, force: true })
    running = null
  }
})

describe('TSC/1 客户端 ↔ 真实服务端（互通）', () => {
  it('★ 完整握手 + 一次请求/响应往返（两份独立实现真的连起来了）', async () => {
    running = await startServer()
    const ch = await SecureChannel.connect({
      host: '127.0.0.1',
      port: running.port,
      pinnedPublicKey: running.publicKey,
      pinnedFingerprint: running.fingerprint.replace(/ /g, ''),
    })

    const res = await ch.request('/api/v1/health', { method: 'GET' })
    expect(res.status).toBe(200)
    // 服务端把请求原样回显 —— 证明应用层 JSON 真的过去了、也真的回来了
    expect(res.body).toMatchObject({ ok: true, echo: { method: 'GET', path: '/api/v1/health' } })
    ch.close()
  })

  it('★ 客户端算出的指纹与服务端自报的一致（钉扎才有意义）', async () => {
    running = await startServer()
    const ch = await SecureChannel.connect({
      host: '127.0.0.1',
      port: running.port,
      pinnedPublicKey: running.publicKey,
      pinnedFingerprint: running.fingerprint.replace(/ /g, ''),
    })
    // 客户端在握手时从对端出示的 identity_pub 算出的指纹
    expect(ch.peerFingerprint).toBe(fingerprintOf(running.publicKey).replace(/ /g, ''))
    expect(ch.peerFingerprint).toBe(running.fingerprint.replace(/ /g, ''))
    ch.close()
  })

  it('★ 多请求（帧序号递增）+ 带 body 的请求', async () => {
    running = await startServer()
    const ch = await SecureChannel.connect({
      host: '127.0.0.1',
      port: running.port,
      pinnedPublicKey: running.publicKey,
      pinnedFingerprint: running.fingerprint.replace(/ /g, ''),
    })

    for (let i = 0; i < 5; i++) {
      const res = await ch.request('/api/v1/echo', { method: 'PUT', body: { n: i } })
      expect(res.status).toBe(200)
      expect(res.body).toMatchObject({ echo: { body: { n: i } } })
    }
    ch.close()
  })

  it('★ 令牌经 headers.authorization 传过去（规范 §6.1 的白名单）', async () => {
    let seenAuth: string | undefined
    // 注意：服务端把 node 风格的 req 放在 `req` 字段里（dispatch({method,path,body,req,res})），
    // 所以 headers 在 `arg.req.headers` 而不是顶层 —— 我第一版读错了一层。
    running = await startServer(
      async (arg: { req?: { headers?: Record<string, string> } }) => {
        seenAuth = arg.req?.headers?.['authorization']
        return { ok: true }
      },
    )
    const ch = await SecureChannel.connect({
      host: '127.0.0.1',
      port: running.port,
      pinnedPublicKey: running.publicKey,
      pinnedFingerprint: running.fingerprint.replace(/ /g, ''),
    })
    await ch.request('/api/v1/blobs', { method: 'GET', token: 'tok-123' })
    expect(seenAuth).toBe('Bearer tok-123')
    ch.close()
  })

  it('★ 钉扎不符 → 客户端拒绝，且**不发送任何应用数据**', async () => {
    running = await startServer()
    // 用一个别的公钥当钉扎值（模拟被换人）
    const wrongKey = Buffer.alloc(32, 0x7a)
    const err = await SecureChannel.connect({
      host: '127.0.0.1',
      port: running.port,
      pinnedPublicKey: wrongKey,
      pinnedFingerprint: running.fingerprint.replace(/ /g, ''), // 指纹故意留对，看它是否只看指纹
    }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(SecureChannelError)
    // 指纹对了但**验签用的是对端出示的公钥** → 签名能过；
    // 这条路径真正要保证的是：即使签过，调用方的钉扎比对也必须拦住。
    // 这里公钥与指纹不匹配（指纹来自真服务端，公钥是假的）→ 必须在握手期拒绝。
    expect(String((err as Error).message)).toMatch(/握手失败|签名|钉扎|指纹/)
  })

  it('★ 指纹不符 → 明确报"可能被中间人"，且不建立连接', async () => {
    running = await startServer()
    const err = await SecureChannel.connect({
      host: '127.0.0.1',
      port: running.port,
      pinnedPublicKey: running.publicKey,
      pinnedFingerprint: 'deadbeefdeadbeefdeadbeefdeadbeef', // 错的指纹
    }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(SecureChannelError)
    expect((err as SecureChannelError).kind).toBe('pin')
    expect(String((err as Error).message)).toMatch(/中间人|不一致/)
  })

  it('明文 HTTP 打到该端口 → 服务端立刻断开（不挂到超时）', async () => {
    running = await startServer()
    const { connect } = await import('node:net')
    const t0 = Date.now()
    await new Promise<void>((resolve) => {
      const s = connect(running!.port, '127.0.0.1', () => {
        s.write('GET / HTTP/1.1\r\nHost: x\r\n\r\n')
      })
      s.on('close', () => resolve())
      s.on('error', () => resolve())
      setTimeout(() => {
        s.destroy()
        resolve()
      }, 3000)
    })
    expect(Date.now() - t0).toBeLessThan(1500) // 首字节即判 magic → 立刻断
  })

  it('服务端不可达 → 明确报错（而不是静默）', async () => {
    const err = await SecureChannel.connect({
      host: '127.0.0.1',
      port: 1, // 基本不可能有服务
      pinnedPublicKey: Buffer.alloc(32, 1),
      pinnedFingerprint: 'x',
      handshakeTimeoutMs: 2000,
    }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(SecureChannelError)
    expect((err as SecureChannelError).kind).toBe('connect')
  })
})
