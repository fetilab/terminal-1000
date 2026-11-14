// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * TSC/1 服务端连接处理：握手 → 记录层 → 应用层消息 → **复用现有路由**。
 *
 * 设计要点
 * - 应用层消息（§6）只带 `{id, method, path, body}`，直接喂给 `dispatch()`，
 *   因此鉴权（Bearer 令牌）、限流、错误码语义与 HTTP 端**完全一致**，不存在第二套。
 * - 加密通道**不替代认证**：`login` 仍在通道内做，令牌仍是 Bearer 令牌。
 * - 所有失败走同一条出口：断开 + 审计日志（只记 IP 与原因，**不记明文、不记私钥**）。
 */

import { generateKeyPairSync } from 'node:crypto'
import { HttpError } from '../util.js'
import {
  HELLO_LEN,
  MAX_FRAME_LEN,
  NONCE_PREFIX_C2S,
  NONCE_PREFIX_S2C,
  Tsc1Error,
  buildServerHello,
  buildServerHelloPrefix,
  buildTranscript,
  computeShared,
  deriveSessionKeys,
  parseHello,
  random32,
  signTranscript,
  x25519PublicFromRaw,
  x25519RawPublic,
} from './crypto.js'
import { RecordReceiver, RecordSender } from './record.js'

/** 应用层 JSON 消息的最大字节数（受帧上限约束，减去 nonce 与 tag） */
const MAX_MESSAGE_BYTES = MAX_FRAME_LEN - 12 - 16

/**
 * 处理一条已建立的 TCP 连接。
 *
 * @param socket        net.Socket
 * @param opts.identity 长期身份密钥（loadOrCreateIdentity 的返回值）
 * @param opts.log      审计日志 (msg) => void
 * @param opts.dispatch 路由分发函数（通常传 index.js 的 dispatch）
 * @param opts.peerIp   对端真实 IP（**绝不采信 XFF**：TSC/1 是直连端口）
 * @param opts.generateEph 临时密钥对生成器（测试可注入固定密钥）
 */
export function handleTsc1Connection(socket, opts) {
  const { identity, log, dispatch, peerIp, generateEph } = opts

  // 临时私钥：握手完成、会话密钥派生后**立即丢弃**（前向保密）
  let eph = (generateEph ?? defaultGenerateEph)()

  let phase = 'await-hello'
  let receiver = null
  let sender = null
  let buffer = Buffer.alloc(0)

  const fail = (code, message) => {
    if (phase === 'closed') return
    phase = 'closed'
    log(`TSC1 fail ip=${peerIp} code=${code} msg=${message}`)
    receiver?.close()
    sender?.close()
    eph = null
    socket.destroy()
  }

  socket.on('error', (err) => {
    // 只记原因，不记对端数据
    log(`TSC1 socket-error ip=${peerIp} ${err?.message ?? 'unknown'}`)
  })

  socket.on('close', () => {
    receiver?.close()
    sender?.close()
    eph = null
  })

  socket.on('data', (chunk) => {
    if (phase === 'closed') return
    try {
      buffer = buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([buffer, chunk])

      if (phase === 'await-hello') {
        // 长度不足就继续等（TCP 是流，不能假设一次 data 就是一条完整消息）
        if (buffer.length < HELLO_LEN) return
        const hello = buffer.subarray(0, HELLO_LEN)
        buffer = buffer.subarray(HELLO_LEN)
        doHandshake(hello)
        phase = 'ready'
      }

      if (phase === 'ready') {
        const rest = buffer
        buffer = Buffer.alloc(0)
        for (const plaintext of receiver.feed(rest)) {
          handleMessage(plaintext).catch((err) => {
            fail(err instanceof Tsc1Error ? err.code : 'DISPATCH_ERROR', err instanceof Error ? err.message : String(err))
          })
        }
      }
    } catch (err) {
      fail(err instanceof Tsc1Error ? err.code : 'INTERNAL', err instanceof Error ? err.message : String(err))
    }
  })

  /** 握手：校验 HELLO → 派生会话密钥 → 回 SERVER_HELLO */
  function doHandshake(helloBytes) {
    // parseHello 会校验 magic / version / reserved（任一不符即抛错断开，**不降级**）
    const hello = parseHello(helloBytes)

    const serverRandom = random32()
    const serverEphPub = x25519RawPublic(eph.publicKey)

    // 共享密钥：低阶点/全零会被 computeShared 显式拒绝
    const shared = computeShared(eph.privateKey, x25519PublicFromRaw(hello.clientEphPub))

    // ⚠️ transcript 必须覆盖 identity_pub，否则攻击者可替换身份公钥而不破坏签名
    const prefix = buildServerHelloPrefix({
      serverRandom,
      serverEphPub,
      identityPub: identity.publicKeyRaw,
    })
    const transcript = buildTranscript(helloBytes, prefix)
    const signature = signTranscript(transcript, identity.privateKey)

    // 前向保密：会话密钥材料齐了，立刻丢弃临时私钥
    eph = null

    const keys = deriveSessionKeys(shared, transcript)
    receiver = new RecordReceiver({ key: keys.c2sKey, prefix: NONCE_PREFIX_C2S })
    sender = new RecordSender({ key: keys.s2cKey, prefix: NONCE_PREFIX_S2C })

    socket.write(
      buildServerHello({
        serverRandom,
        serverEphPub,
        identityPub: identity.publicKeyRaw,
        signature,
      }),
    )
  }

  /** 应用层消息 → 复用路由 → 响应消息 */
  async function handleMessage(plaintext) {
    let msg
    try {
      msg = JSON.parse(plaintext.toString('utf8'))
    } catch {
      throw new Tsc1Error('BAD_MESSAGE', '应用层消息不是合法 JSON')
    }
    if (!msg || typeof msg !== 'object') {
      throw new Tsc1Error('BAD_MESSAGE', '应用层消息必须是对象')
    }

    const method = typeof msg.method === 'string' ? msg.method.toUpperCase() : ''
    const path = typeof msg.path === 'string' ? msg.path : ''
    if (!method || !path) throw new Tsc1Error('BAD_MESSAGE', '消息缺少 method 或 path')

    // 传给路由的是**最小 stub**：现有 handler 只用到 method/url/headers/socket
    const reqStub = {
      method,
      url: path,
      headers: normalizeHeaders(msg.headers),
      socket: { remoteAddress: peerIp },
    }
    const resStub = { headersSent: false }

    let reply
    try {
      const result = await dispatch({ method, path, body: msg.body, req: reqStub, res: resStub })
      reply = { id: msg.id, status: 200, body: result }
    } catch (err) {
      // 与 HTTP 端同源：错误码/状态码语义一致
      const status = err instanceof HttpError ? err.status : 500
      const code = err instanceof HttpError ? err.code : 'INTERNAL'
      const message = err instanceof Error ? err.message : String(err)
      reply = { id: msg.id, status, body: { error: { code, message } } }
    }

    sendMessage(reply)
  }

  function sendMessage(obj) {
    const buf = Buffer.from(JSON.stringify(obj), 'utf8')
    if (buf.length > MAX_MESSAGE_BYTES) {
      fail('MESSAGE_TOO_LARGE', `响应 ${buf.length} 字节超过上限 ${MAX_MESSAGE_BYTES}`)
      return
    }
    socket.write(sender.send(buf))
  }
}

/**
 * 把应用层 `headers` 归一成 node 风格的小写键对象。
 *
 * 只放行 `authorization`：加密通道里没有必要（也不应该）让客户端注入任意头部
 * 去影响限流或来源判断。
 */
function normalizeHeaders(raw) {
  const out = {}
  if (!raw || typeof raw !== 'object') return out
  const auth = raw.authorization ?? raw.Authorization
  if (typeof auth === 'string') out.authorization = auth
  return out
}

/** 默认的临时 X25519 密钥对生成（每连接一对，用完即丢） */
function defaultGenerateEph() {
  return generateKeyPairSync('x25519')
}
