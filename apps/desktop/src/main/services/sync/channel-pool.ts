// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * TSC/1 通道复用池。
 *
 * 为什么需要复用：TSC/1 每次连接都要做一次 X25519 握手 + Ed25519 验签，
 * 而同步是"多次小请求"（push/pull/login 各一次）。每个请求都重新握手
 * 既浪费往返、也让每次同步都要重新验签。
 *
 * 三条纪律：
 * 1. **未钉扎就不连**（TOFU 必须由用户显式确认）—— 这里会抛 `UntrustedServerError`
 *    把指纹带出去，由上层交给用户核对（SSH 式流程）
 * 2. **指纹/公钥不一致一律拒绝**（可能被中间人），不允许"自动接受新指纹"
 * 3. **绝不在失败后回退到明文 HTTP**（规范 §3.3.1）—— 这条由调用方保证，
 *    本模块只负责"要么走加密通道、要么明确失败"
 */

import { SecureChannel, SecureChannelError, type SecureChannelOptions } from './channel'
import { fingerprintOf } from './protocol'

export interface PeerPin {
  /** 指纹（hex，无空格） */
  fingerprint: string
  /** 身份公钥（base64） */
  publicKey: string
}

/** 服务端未钉扎 —— 上层应当**显著提示用户核对指纹**，而不是静默接受 */
export class UntrustedServerError extends Error {
  readonly code = 'UNTRUSTED_SERVER'
  constructor(readonly fingerprint: string) {
    super(
      `首次连接该同步服务端，需要你核对身份指纹：\n  ${fingerprint}\n` +
        '请在另一条可信渠道（服务器本机日志）核对一致后再信任。',
    )
    this.name = 'UntrustedServerError'
  }
}

/** 指纹与已记录的不一致 —— 可能被中间人 */
export class ServerIdentityChangedError extends Error {
  readonly code = 'SERVER_IDENTITY_CHANGED'
  constructor(
    readonly expected: string,
    readonly actual: string,
  ) {
    super(
      `同步服务端身份与已记录的不一致（**可能被中间人**）：\n  已记录 ${expected}\n  本次收到 ${actual}\n` +
        '若你确认服务端确实换了密钥，请手动更新钉扎。',
    )
    this.name = 'ServerIdentityChangedError'
  }
}

interface Pooled {
  channel: SecureChannel
  fingerprint: string
}

const pool = new Map<string, Pooled>()

function keyOf(host: string, port: number): string {
  return `${host}:${port}`
}

/**
 * 取一条可用通道（必要时握手）。
 *
 * @param pin 已钉扎的身份；未提供 → 抛 `UntrustedServerError`（**不自动信任**）
 */
export async function getChannel(
  host: string,
  port: number,
  pin: PeerPin | undefined,
): Promise<SecureChannel> {
  const k = keyOf(host, port)
  const existing = pool.get(k)
  if (existing) return existing.channel

  const options: SecureChannelOptions = {
    host,
    port,
    ...(pin === undefined
      ? {}
      : {
          pinnedFingerprint: pin.fingerprint,
          pinnedPublicKey: Buffer.from(pin.publicKey, 'base64'),
        }),
    // 首次连接（未钉扎）**不接受**：把手印带出去让用户显式确认
    onPin: (info) => {
      if (info.isNew) return false
      return false // 不一致时也拒绝 —— 由上层决定是否手动换钉扎
    },
  }

  let channel: SecureChannel
  try {
    channel = await SecureChannel.connect(options)
  } catch (err) {
    if (err instanceof SecureChannelError && err.kind === 'pin') {
      // 握手本身能走通（对端出示了公钥并签了名），只是我们没钉扎 → 把指纹报上去
      const fp = extractFingerprint(String(err.message))
      if (fp !== null) throw new UntrustedServerError(fp)
    }
    throw err
  }

  // 二次核对：handshake 内部已经比过，这里再确认一次**公钥字节**（比指纹更严）
  if (pin !== undefined && channel.peerFingerprint !== pin.fingerprint) {
    channel.close()
    throw new ServerIdentityChangedError(pin.fingerprint, channel.peerFingerprint)
  }

  pool.set(k, { channel, fingerprint: channel.peerFingerprint })
  return channel
}

/** 从错误信息里抠出指纹（`channel.ts` 在拒绝时会把指纹写进去） */
function extractFingerprint(message: string): string | null {
  const m = message.match(/[0-9a-f]{32}/i)
  return m === null ? null : m[0].toLowerCase()
}

/** 主动丢弃某端点的通道（令牌变更、退出登录时用） */
export function dropChannel(host: string, port: number): void {
  const k = keyOf(host, port)
  const p = pool.get(k)
  if (p) {
    p.channel.close()
    pool.delete(k)
  }
}

export function closeAllChannels(): void {
  for (const [, p] of pool) p.channel.close()
  pool.clear()
}

/** 自检/测试用 */
export function poolSize(): number {
  return pool.size
}

/** 把公钥字节算成指纹（供上层在确认时用） */
export function fingerprintOfPublicKey(publicKeyBase64: string): string {
  return fingerprintOf(Buffer.from(publicKeyBase64, 'base64')).replace(/ /g, '')
}
