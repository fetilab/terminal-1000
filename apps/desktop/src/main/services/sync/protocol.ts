// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * TSC/1 同步通道协议 —— **协议核（纯函数）**。
 *
 * 规范见 `docs/SYNC-SECURE-CHANNEL.md`；冻结向量见 `docs/fixtures/tsc1-vectors.json`。
 *
 * 这个文件里**不发明任何密码学**：X25519 / Ed25519 / HKDF-SHA256 / AES-256-GCM 全部来自
 * Node 的 `crypto`。这里只负责**字节布局与状态机** —— 也就是最容易写错、最需要测试的那部分。
 *
 * 为什么拆出纯函数：服务端是**零依赖 JS 的另一份实现**，两侧唯一的互操作保证就是
 * "同一组输入 → 同一组输出"。把协议核做成纯函数，就能拿冻结向量逐字节对照。
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  sign,
  verify,
  type KeyObject,
} from 'node:crypto'

export const TSC_MAGIC = 0x54 // 'T'
export const TSC_VERSION = 0x01

/** HELLO 长度：1+1+2+4+32+32 */
export const HELLO_LEN = 72
/** SERVER_HELLO 前缀（不含签名）长度：1+1+2+32+32 */
export const SERVER_HELLO_PREFIX_LEN = 68
/** SERVER_HELLO 总长：前缀 + 64 字节签名 */
export const SERVER_HELLO_LEN = SERVER_HELLO_PREFIX_LEN + 64

/** 单帧上限 16 MiB —— 长度字段必须限死，否则它是内存耗尽的入口 */
export const MAX_FRAME_BYTES = 16 * 1024 * 1024
/** nonce 与 tag 的固定开销 */
const NONCE_LEN = 12
const TAG_LEN = 16

/** 方向前缀：两个方向各自独立密钥还要再加这一层，是为了防止"实现出错把两方向混用同一密钥"时 nonce 相撞 */
const DIR_C2S = 1
const DIR_S2C = 2

const b64u = (b: Buffer): string => b.toString('base64url')

// ---------------------------------------------------------------------------
// 密钥构造（从原始字节，便于用固定向量测试）
// ---------------------------------------------------------------------------

/**
 * 由 32 字节私钥标量构造 X25519 私钥对象。
 *
 * ⚠️ **不要走 JWK**：JWK 的 OKP 私钥要求同时给出 `x`（公钥），而我们从标量反推不出公钥时
 * 只能填占位值 —— 填全零会被 Node 直接拒（`Invalid JWK OKP key`）。
 * 用 PKCS#8 DER 包装（OID 1.3.101.110 = X25519）是标准做法，也绕开了这个校验。
 */
export function x25519PrivateFromRaw(raw: Buffer): KeyObject {
  if (raw.length !== 32) throw new Error('X25519 私钥必须是 32 字节')
  const der = Buffer.concat([
    Buffer.from('302e020100300506032b656e04220420', 'hex'),
    raw,
  ])
  return createPrivateKey({ key: der, format: 'der', type: 'pkcs8' })
}

/** 由 32 字节公钥构造 X25519 公钥对象（SPKI DER，OID 1.3.101.110） */
export function x25519PublicFromRaw(raw: Buffer): KeyObject {
  if (raw.length !== 32) throw new Error('X25519 公钥必须是 32 字节')
  const der = Buffer.concat([Buffer.from('302a300506032b656e032100', 'hex'), raw])
  return createPublicKey({ key: der, format: 'der', type: 'spki' })
}

/** 导出 X25519 公钥的原始 32 字节 */
export function x25519PublicRaw(key: KeyObject): Buffer {
  const jwk = key.export({ format: 'jwk' }) as { x?: string }
  if (!jwk.x) throw new Error('无法导出 X25519 公钥')
  return Buffer.from(jwk.x, 'base64url')
}

/** 从 PKCS#8 DER 构造 Ed25519 私钥（服务端 identity.key 用这个格式存） */
export function ed25519PrivateFromPkcs8(der: Buffer): KeyObject {
  return createPrivateKey({ key: der, format: 'der', type: 'pkcs8' })
}

/** 由 32 字节公钥构造 Ed25519 公钥对象（**注意与 X25519 是不同类型，不能混用**） */
export function ed25519PublicFromRaw(raw: Buffer): KeyObject {
  return createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: b64u(raw) }, format: 'jwk' })
}

export function ed25519PublicRaw(key: KeyObject): Buffer {
  const jwk = createPublicKey(key).export({ format: 'jwk' }) as { x?: string }
  if (!jwk.x) throw new Error('无法导出 Ed25519 公钥')
  return Buffer.from(jwk.x, 'base64url')
}

/** 生成本机临时 X25519 密钥对与随机数（每次连接一份） */
export function generateEphemeral(): { privateKey: KeyObject; publicRaw: Buffer; random: Buffer } {
  const { privateKey } = generateKeyPairSync('x25519')
  return { privateKey, publicRaw: x25519PublicRaw(privateKey), random: randomBytes(32) }
}

// ---------------------------------------------------------------------------
// 握手
// ---------------------------------------------------------------------------

export function buildHello(clientRandom: Buffer, clientEphPub: Buffer): Buffer {
  if (clientRandom.length !== 32) throw new Error('client_random 必须 32 字节')
  if (clientEphPub.length !== 32) throw new Error('client_eph_pub 必须 32 字节')
  const buf = Buffer.alloc(HELLO_LEN)
  buf[0] = TSC_MAGIC
  buf[1] = TSC_VERSION
  buf.writeUInt16BE(0, 2) // reserved 必须 0
  buf.writeUInt32BE(Math.floor(Date.now() / 1000), 4)
  clientRandom.copy(buf, 8)
  clientEphPub.copy(buf, 40)
  return buf
}

export interface ServerHello {
  serverRandom: Buffer
  serverEphPub: Buffer
  signature: Buffer
}

/** 解析 SERVER_HELLO；任何字段不合法都抛错（**不返回"部分成功"**，调用方据此断开） */
export function parseServerHello(buf: Buffer): ServerHello {
  if (buf.length !== SERVER_HELLO_LEN) {
    throw new Error(`SERVER_HELLO 长度不合法: ${buf.length}（应为 ${SERVER_HELLO_LEN}）`)
  }
  if (buf[0] !== TSC_MAGIC) throw new Error('SERVER_HELLO magic 不匹配（对面可能不是 TSC/1 服务）')
  if (buf[1] !== TSC_VERSION) {
    // 明确的降级防护：不认识的版本一律断开，绝不"猜一个能用的"
    throw new Error(`协议版本不支持: ${buf[1]}（本机支持 ${TSC_VERSION}）`)
  }
  if (buf.readUInt16BE(2) !== 0) throw new Error('SERVER_HELLO 保留位必须为 0')
  return {
    serverRandom: buf.subarray(4, 36),
    serverEphPub: buf.subarray(36, 68),
    signature: buf.subarray(68, 132),
  }
}

/** 服务端侧：构造 SERVER_HELLO（含签名） */
export function buildServerHello(
  hello: Buffer,
  serverRandom: Buffer,
  serverEphPub: Buffer,
  identityPrivateKey: KeyObject,
): Buffer {
  const prefix = Buffer.alloc(SERVER_HELLO_PREFIX_LEN)
  prefix[0] = TSC_MAGIC
  prefix[1] = TSC_VERSION
  prefix.writeUInt16BE(0, 2)
  serverRandom.copy(prefix, 4)
  serverEphPub.copy(prefix, 36)
  const sig = signTranscript(hello, prefix, identityPrivateKey)
  return Buffer.concat([prefix, sig])
}

/**
 * 签名载荷：`SHA256("TSC/1 server-hello" || transcript)`。
 *
 * 为什么要先哈希：Ed25519 的签名接口对超长消息也能用，但套一层带域分隔标签的哈希
 * 能防止"同一条字节在不同上下文被当不同用途"的歧义（域分隔是这类协议的基本纪律）。
 */
export function signTranscript(
  hello: Buffer,
  serverHelloPrefix: Buffer,
  identityPrivateKey: KeyObject,
): Buffer {
  const digest = createHash('sha256')
    .update('TSC/1 server-hello')
    .update(Buffer.concat([hello, serverHelloPrefix]))
    .digest()
  return sign(null, digest, identityPrivateKey)
}

export interface DerivedKeys {
  c2sKey: Buffer
  s2cKey: Buffer
  /** 共享密钥（仅测试与断言用；生产不必保留） */
  shared: Buffer
  transcriptHash: Buffer
}

/**
 * 校验服务端签名并派生会话密钥。
 *
 * @param pinnedPub 钉扎的 Ed25519 公钥。**未钉扎（首次连接）时由调用方决定**是否放行 ——
 *   本函数要求显式传入，避免"忘了校验"变成默认行为。
 */
export function verifyAndDerive(args: {
  hello: Buffer
  serverHello: ServerHello
  clientEphPrivate: KeyObject
  pinnedPub: Buffer
}): DerivedKeys {
  const prefix = Buffer.alloc(SERVER_HELLO_PREFIX_LEN)
  prefix[0] = TSC_MAGIC
  prefix[1] = TSC_VERSION
  prefix.writeUInt16BE(0, 2)
  args.serverHello.serverRandom.copy(prefix, 4)
  args.serverHello.serverEphPub.copy(prefix, 36)

  const digest = createHash('sha256')
    .update('TSC/1 server-hello')
    .update(Buffer.concat([args.hello, prefix]))
    .digest()

  // ⚠️ 必须是 Ed25519（不是 X25519）—— 两者同为 OKP 但 crv 不同
  const ok = verify(null, digest, ed25519PublicFromRaw(args.pinnedPub), args.serverHello.signature)
  if (!ok) {
    throw new Error('服务端身份校验失败：签名与钉扎指纹不符（可能被中间人）')
  }

  return deriveKeys(args.hello, prefix, args.clientEphPrivate, args.serverHello.serverEphPub)
}

/** 服务端侧：从 HELLO 派生同一组密钥（不需要验签，自己就是签名者） */
export function deriveKeys(
  hello: Buffer,
  serverHelloPrefix: Buffer,
  clientEphPrivate: KeyObject,
  serverEphPubRaw: Buffer,
): DerivedKeys {
  let shared: Buffer
  try {
    shared = diffieHellman({
      privateKey: clientEphPrivate,
      publicKey: x25519PublicFromRaw(serverEphPubRaw),
    })
  } catch (err) {
    // **低阶点/非法点防护（第一道）**：不同运行时的行为不一样 ——
    // Node 24 / OpenSSL 3.5.9 实测**直接抛错**（`failed during derivation`），
    // 而规范按"静默返回全零"写的（别的 Node/OpenSSL 组合、以及非 Node 实现确实可能那样）。
    // 所以这里把底层错误**归一化成可操作的措辞**，调用方不必依赖具体 OpenSSL 版本的错误串。
    throw new Error(
      `对端公钥不可用于密钥协商（低阶点或非法点），已拒绝：${err instanceof Error ? err.message : String(err)}`,
    )
  }

  // **第二道**：万一某个实现真的静默返回全零，这里必须拦住 ——
  // 不拦的话，攻击者能让两侧"协商成功"却共享一个可预测的密钥。
  if (shared.length !== 32) throw new Error('共享密钥长度异常')
  if (shared.every((b) => b === 0)) {
    throw new Error('共享密钥为全零：对端公钥是低阶点，已拒绝（可能是攻击）')
  }

  const transcript = Buffer.concat([hello, serverHelloPrefix])
  const transcriptHash = createHash('sha256').update(transcript).digest()
  const derive = (info: string): Buffer =>
    Buffer.from(hkdfSync('sha256', shared, transcriptHash, Buffer.from(info), 32))

  return {
    c2sKey: derive('TSC/1 c2s'),
    s2cKey: derive('TSC/1 s2c'),
    shared,
    transcriptHash,
  }
}

// ---------------------------------------------------------------------------
// 记录层
// ---------------------------------------------------------------------------

function nonceFor(dir: number, seq: bigint): Buffer {
  const nonce = Buffer.alloc(NONCE_LEN)
  nonce.writeUInt32BE(dir, 0)
  nonce.writeBigUInt64BE(seq, 4)
  return nonce
}

/** 加密封装一帧：[u32 len][u64 seq][12B nonce][ct][16B tag] */
export function seal(
  key: Buffer,
  dir: 'c2s' | 's2c',
  seq: bigint,
  plaintext: Buffer,
): Buffer {
  const dirNum = dir === 'c2s' ? DIR_C2S : DIR_S2C
  const nonce = nonceFor(dirNum, seq)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const tag = cipher.getAuthTag()
  const body = Buffer.concat([nonce, ct, tag])
  // 帧头 12 字节 = [u32 len][u64 seq] → seq 必须写在偏移 **4**（4+8=12），
  // 我第一版写成 8（8+8=16 > 12）—— 直接越界报错
  const head = Buffer.alloc(12)
  head.writeUInt32BE(body.length, 0)
  head.writeBigUInt64BE(seq, 4)
  return Buffer.concat([head, body])
}

export interface OpenedFrame {
  seq: bigint
  plaintext: Buffer
}

/**
 * 解封一帧。
 *
 * 严格校验三件事，任一不符即抛错（调用方必须**断开连接**而不是跳过）：
 * 1. `length` 在合法范围（防内存耗尽）
 * 2. `seq` 等于期望值（**防重放与乱序**；TCP 有序，不相等说明有人插手）
 * 3. GCM tag 校验通过（防篡改）
 */
export function open(
  key: Buffer,
  dir: 'c2s' | 's2c',
  expectedSeq: bigint,
  frame: Buffer,
): OpenedFrame {
  if (frame.length < 12 + NONCE_LEN + TAG_LEN) throw new Error('帧过短')
  const declared = frame.readUInt32BE(0)
  if (declared > MAX_FRAME_BYTES) throw new Error(`帧过大: ${declared} > ${MAX_FRAME_BYTES}`)
  if (declared !== frame.length - 12) throw new Error('帧长度字段与实际不符')

  const seq = frame.readBigUInt64BE(4)
  if (seq !== expectedSeq) {
    throw new Error(`帧序号不连续：期望 ${expectedSeq}，收到 ${seq}（可能被重放或乱序）`)
  }

  const nonce = frame.subarray(12, 12 + NONCE_LEN)
  const body = frame.subarray(12)
  const tag = body.subarray(body.length - TAG_LEN)
  const ct = body.subarray(NONCE_LEN, body.length - TAG_LEN)

  const dirNum = dir === 'c2s' ? DIR_C2S : DIR_S2C
  const expectedNonce = nonceFor(dirNum, seq)
  if (!nonce.equals(expectedNonce)) throw new Error('nonce 与序号不符（帧被改动过）')

  const decipher = createDecipheriv('aes-256-gcm', key, nonce)
  decipher.setAuthTag(tag)
  const plaintext = Buffer.concat([decipher.update(ct), decipher.final()])
  return { seq, plaintext }
}

/** 从任意长度的流缓冲区里切出完整帧（返回 null 表示还需要更多数据） */
export function takeFrame(buffer: Buffer): { frame: Buffer; rest: Buffer } | null {
  if (buffer.length < 12) return null
  const declared = buffer.readUInt32BE(0)
  if (declared > MAX_FRAME_BYTES) throw new Error(`帧过大: ${declared} > ${MAX_FRAME_BYTES}`)
  const total = 12 + declared
  if (buffer.length < total) return null
  return { frame: buffer.subarray(0, total), rest: buffer.subarray(total) }
}

/** 指纹：SHA256(pubkey) 前 16 字节的 hex，8 组 4 字符（便于口述核对） */
export function fingerprintOf(publicKey: Buffer): string {
  const hex = createHash('sha256').update(publicKey).digest('hex').slice(0, 32)
  return (hex.match(/.{4}/g) ?? []).join(' ')
}
