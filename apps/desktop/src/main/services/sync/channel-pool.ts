// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * TSC/1 通道复用池。
 *
 * 同步由多次小请求组成（login、push、pull）；握手包含 X25519 密钥协商与 Ed25519 验签，
 * 按端点复用连接以避免每个请求重复握手。
 *
 * 未钉扎或钉扎不匹配时不建立连接，分别抛 `UntrustedServerError` 与
 * `ServerIdentityChangedError`，由调用方决定是否提示用户核对指纹。
 * 明文 HTTP 回退不在本模块职责内，见 `docs/SYNC-SECURE-CHANNEL.md` §3.3.1。
 */

import { SecureChannel, SecureChannelError, type SecureChannelOptions } from './channel'
import { fingerprintOf } from './protocol'

export interface PeerPin {
  /** 指纹（hex，无空格） */
  fingerprint: string
  /** 身份公钥（base64） */
  publicKey: string
}

/**
 * 对端身份未钉扎。
 *
 * 携带本次连接观测到的指纹，供调用方展示给用户带外核对；不接受静默信任。
 */
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

/**
 * 对端出示的身份与已钉扎的不一致。
 *
 * 可能是中间人，也可能是服务端更换了密钥；调用方须要求用户显式确认后才能更新钉扎。
 */
export class ServerIdentityChangedError extends Error {
  readonly code = 'SERVER_IDENTITY_CHANGED'
  constructor(
    readonly expected: string,
    readonly actual: string,
  ) {
    super(
      `同步服务端身份与已记录的不一致（可能为中间人，也可能服务端已更换密钥）：\n  已记录 ${expected}\n  本次收到 ${actual}\n` +
        '若确认服务端已更换密钥，需手动更新钉扎；否则应视为中间人并中止。',
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
 * 取端点对应的通道，未建立时先握手。
 *
 * @param pin 已钉扎的对端身份；未提供时抛 `UntrustedServerError`，不建立连接
 * @returns 可收发请求的通道
 * @throws `UntrustedServerError` 未钉扎；`ServerIdentityChangedError` 身份与钉扎不符
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
    // 未钉扎与不一致都由调用方处理，这里一律不自动接受
    onPin: () => false,
  }

  let channel: SecureChannel
  try {
    channel = await SecureChannel.connect(options)
  } catch (err) {
    if (err instanceof SecureChannelError && err.kind === 'pin') {
      // 两种情况必须分开：有钉扎却不匹配（可能中间人）与根本没有钉扎（首次连接）。
      // 合并为"未钉扎"会让界面提示用户"核对后信任"，等于劝他信任错误的密钥。
      if (err.identityChanged === true && err.expectedFingerprint !== undefined) {
        throw new ServerIdentityChangedError(err.expectedFingerprint, err.fingerprint ?? '')
      }
      if (err.fingerprint !== undefined) throw new UntrustedServerError(err.fingerprint)
    }
    throw err
  }

  // 公钥字节比对：指纹相同不足以排除身份替换
  if (pin !== undefined && channel.peerFingerprint !== pin.fingerprint) {
    channel.close()
    throw new ServerIdentityChangedError(pin.fingerprint, channel.peerFingerprint)
  }

  pool.set(k, { channel, fingerprint: channel.peerFingerprint })
  return channel
}

/** 丢弃端点通道；退出登录或令牌变更后调用，下次请求重新握手 */
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

/** 当前池中通道数，供测试断言连接复用 */
export function poolSize(): number {
  return pool.size
}

/** 由 base64 身份公钥计算指纹，供确认流程比对 */
export function fingerprintOfPublicKey(publicKeyBase64: string): string {
  return fingerprintOf(Buffer.from(publicKeyBase64, 'base64')).replace(/ /g, '')
}
