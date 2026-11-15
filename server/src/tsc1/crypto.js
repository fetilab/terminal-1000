// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * TSC/1 的密码学原语与密钥派生（规范 `docs/SYNC-SECURE-CHANNEL.md` §2–§4）。
 *
 * 本文件**不发明任何密码学**：只调用 node:crypto 的 X25519 / Ed25519 /
 * HKDF-SHA256 / AES-256-GCM，负责把它们按规范拼成握手与会话密钥。
 *
 * 零依赖：只用 node 内置模块（server/ 不允许引入 npm 依赖）。
 */

import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  sign as edSign,
  timingSafeEqual,
  verify as edVerify,
  createHash,
} from 'node:crypto'

/** 协议版本；不做协商，不认识的版本直接断开 */
export const TSC1_VERSION = 0x01

/** magic 字节 = 'T'，用于快速识别"这不是 HTTP" */
export const TSC1_MAGIC = 0x54

/**
 * HELLO 总长 = **72**。
 *
 * 布局：magic(1) + version(1) + reserved(2) + timestamp(4) + client_random(32) + client_eph_pub(32)
 * = 72，`client_eph_pub` 的区间是 [40, 72)。
 *
 * 历史注记（供后来者理解为何这里会有注释）：规范 §3.1 标题**一度**写作
 * 「共 1+1+4+32+32 = 70 字节」——那是把 `reserved` 误计为 4 字节的笔误。
 * 当时从偏移表与 §3.2/§3.3 的自洽性判断出应为 72（SERVER_HELLO 的
 * 「1+1+2+32+32+64 = 132」自洽，且 §3.3 取前 68 字节 = 签名偏移），
 * 已反馈并在规范中更正。若按 70 实现，`client_eph_pub` 会被截成 30 字节，握手必然失败。
 *
 * 冻结向量 `docs/fixtures/tsc1-vectors.json` 里 `helloHex` 为 144 个十六进制字符 = 72 字节，与此一致。
 */
export const HELLO_LEN = 72
/**
 * SERVER_HELLO 总长 = **164**：1+1+2+32+32+32+64。
 *
 * v1 曾漏掉 `identity_pub`（132 字节版本）。补上它是**必需**的：
 * TOFU 的本质就是"首次连接时学习并记录对方的公钥"，客户端若不拿到公钥，
 * 就既无法算指纹让用户带外核对、也无法验签，首次连接只能盲信 —— 正是 TOFU 要避免的。
 */
export const SERVER_HELLO_LEN = 164

/** SERVER_HELLO 中签名之前的长度（= 参与 transcript 的前缀长度） */
export const SERVER_HELLO_PREFIX_LEN = 100

/** 签名在 SERVER_HELLO 内的偏移 */
export const SERVER_HELLO_SIG_OFFSET = 100

/** SERVER_HELLO 内 identity_pub 的偏移 */
export const SERVER_HELLO_IDPUB_OFFSET = 68

/** 记录层 length 上限 16 MiB（超限立即断开，防内存耗尽） */
export const MAX_FRAME_LEN = 16 * 1024 * 1024

/** 记录层固定开销：12B nonce + 16B tag */
export const FRAME_OVERHEAD = 12 + 16

/** nonce 方向前缀 */
export const NONCE_PREFIX_C2S = Buffer.from([0x00, 0x00, 0x00, 0x01])
export const NONCE_PREFIX_S2C = Buffer.from([0x00, 0x00, 0x00, 0x02])

/** 签名域分隔串（参与被签名的哈希） */
export const SIG_CONTEXT = Buffer.from('TSC/1 server-hello')

/** HKDF info 串 */
export const HKDF_INFO_C2S = Buffer.from('TSC/1 c2s')
export const HKDF_INFO_S2C = Buffer.from('TSC/1 s2c')

/** Ed25519 / X25519 的 SPKI 与 PKCS8 前缀（用于在「原始 32 字节」与 KeyObject 之间转换） */
const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')
const SPKI_X25519_PREFIX = Buffer.from('302a300506032b656e032100', 'hex')
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex')
const PKCS8_X25519_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex')

// ------------------------------------------------------------------ 编解码助手

/** 从 SPKI DER 里取出末尾 32 字节（即原始公钥） */
function rawFromSpki(der, prefix, what) {
  if (der.length !== prefix.length + 32) {
    throw new Error(`${what} SPKI 长度异常: ${der.length}`)
  }
  if (!der.subarray(0, prefix.length).equals(prefix)) {
    throw new Error(`${what} SPKI 前缀不匹配`)
  }
  return der.subarray(prefix.length)
}

/** 用原始 32 字节构造 Ed25519 公钥 */
export function ed25519PublicFromRaw(raw) {
  if (!Buffer.isBuffer(raw) || raw.length !== 32) throw new Error('Ed25519 公钥必须是 32 字节')
  return createPublicKey({
    key: Buffer.concat([SPKI_ED25519_PREFIX, raw]),
    format: 'der',
    type: 'spki',
  })
}

/** 用原始 32 字节种子构造 Ed25519 私钥 */
export function ed25519PrivateFromRaw(seed) {
  if (!Buffer.isBuffer(seed) || seed.length !== 32) throw new Error('Ed25519 种子必须是 32 字节')
  return createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]),
    format: 'der',
    type: 'pkcs8',
  })
}

/**
 * 取 Ed25519 公钥的原始 32 字节。
 *
 * ⚠️ 参数必须是**公钥** KeyObject。误传私钥时 Node 会抛
 * `ERR_INVALID_ARG_VALUE: The property 'options.type' is invalid. Received 'spki'`
 * —— 这个报错信息很不直观（它其实在说"私钥不能按 spki 导出"）。
 * 手上只有种子/私钥时，请用 `ed25519PublicRawFromSeed`。
 */
export function ed25519RawPublic(keyObject) {
  return Buffer.from(rawFromSpki(keyObject.export({ format: 'der', type: 'spki' }), SPKI_ED25519_PREFIX, 'Ed25519'))
}

/** 由 32 字节种子推出公钥的原始 32 字节（避免"拿私钥当公钥传"的坑） */
export function ed25519PublicRawFromSeed(seed) {
  return ed25519RawPublic(createPublicKey(ed25519PrivateFromRaw(seed)))
}

/** 取 X25519 公钥的原始 32 字节 */
export function x25519RawPublic(keyObject) {
  return Buffer.from(rawFromSpki(keyObject.export({ format: 'der', type: 'spki' }), SPKI_X25519_PREFIX, 'X25519'))
}

/** 用原始 32 字节构造 X25519 公钥 */
export function x25519PublicFromRaw(raw) {
  if (!Buffer.isBuffer(raw) || raw.length !== 32) throw new Error('X25519 公钥必须是 32 字节')
  return createPublicKey({
    key: Buffer.concat([SPKI_X25519_PREFIX, raw]),
    format: 'der',
    type: 'spki',
  })
}

/** 用原始 32 字节构造 X25519 私钥 */
export function x25519PrivateFromRaw(raw) {
  if (!Buffer.isBuffer(raw) || raw.length !== 32) throw new Error('X25519 私钥必须是 32 字节')
  return createPrivateKey({
    key: Buffer.concat([PKCS8_X25519_PREFIX, raw]),
    format: 'der',
    type: 'pkcs8',
  })
}

// ------------------------------------------------------------------ 身份密钥

/**
 * 生成长期身份密钥对（Ed25519）。
 *
 * 注意：本函数**只返回原始字节**，不返回 KeyObject——
 * 调用方负责立即把私钥写到 0600 的文件里，绝不进日志。
 */
export function generateIdentity() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const seed = Buffer.from(
    privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(PKCS8_ED25519_PREFIX.length),
  )
  return { seed, publicKey: ed25519RawPublic(publicKey) }
}

/**
 * 计算身份公钥指纹。
 *
 * 规范 §5：`SHA256(pubkey)` 取**前 16 字节** = 32 个十六进制字符，
 * 格式化为 8 组 4 字符（便于口述带外核对）。
 */
export function fingerprint(publicKeyRaw) {
  const digest = createHash('sha256').update(publicKeyRaw).digest()
  return formatFingerprint(digest.subarray(0, 16))
}

/** 32 位十六进制 → 8 组 4 字符 */
export function formatFingerprint(bytes16) {
  const hex = bytes16.toString('hex')
  return (hex.match(/.{4}/g) ?? []).join(' ')
}

// ------------------------------------------------------------------ 握手

/**
 * 构造 HELLO（客户端侧，服务端测试也用它造输入）。
 *
 * 布局见规范 §3.1。
 */
export function buildHello({ clientRandom, clientEphPub, timestamp = 0 }) {
  if (clientRandom.length !== 32) throw new Error('client_random 必须是 32 字节')
  if (clientEphPub.length !== 32) throw new Error('client_eph_pub 必须是 32 字节')
  const buf = Buffer.alloc(HELLO_LEN)
  buf.writeUInt8(TSC1_MAGIC, 0)
  buf.writeUInt8(TSC1_VERSION, 1)
  buf.writeUInt16BE(0, 2) // reserved
  buf.writeUInt32BE(timestamp >>> 0, 4)
  clientRandom.copy(buf, 8)
  clientEphPub.copy(buf, 40)
  return buf
}

/** 解析 HELLO；结构非法时抛错（调用方负责断开） */
export function parseHello(buf) {
  if (!Buffer.isBuffer(buf) || buf.length !== HELLO_LEN) {
    throw new Tsc1Error('BAD_HELLO_LEN', `HELLO 长度应为 ${HELLO_LEN}，实际 ${buf?.length}`)
  }
  if (buf.readUInt8(0) !== TSC1_MAGIC) throw new Tsc1Error('BAD_MAGIC', 'magic 不匹配')
  if (buf.readUInt8(1) !== TSC1_VERSION) {
    throw new Tsc1Error('BAD_VERSION', `不支持的版本 ${buf.readUInt8(1)}（本实现只支持 1）`)
  }
  if (buf.readUInt16BE(2) !== 0) throw new Tsc1Error('BAD_RESERVED', 'reserved 必须为 0')
  return {
    timestamp: buf.readUInt32BE(4),
    clientRandom: Buffer.from(buf.subarray(8, 40)),
    // 末端就是 HELLO_LEN(72)；写死 70 会把公钥截成 30 字节
    clientEphPub: Buffer.from(buf.subarray(40, HELLO_LEN)),
  }
}

/**
 * 构造 SERVER_HELLO 的**前缀**（前 100 字节，不含 signature）。transcript 以此为准。
 *
 * ⚠️ `identityPub` 必须包含在内：签名要覆盖它，否则攻击者能换掉身份公钥而不破坏签名。
 */
export function buildServerHelloPrefix({ serverRandom, serverEphPub, identityPub }) {
  if (serverRandom.length !== 32) throw new Error('server_random 必须是 32 字节')
  if (serverEphPub.length !== 32) throw new Error('server_eph_pub 必须是 32 字节')
  if (identityPub.length !== 32) throw new Error('identity_pub 必须是 32 字节')
  const buf = Buffer.alloc(SERVER_HELLO_PREFIX_LEN)
  buf.writeUInt8(TSC1_MAGIC, 0)
  buf.writeUInt8(TSC1_VERSION, 1)
  buf.writeUInt16BE(0, 2)
  serverRandom.copy(buf, 4)
  serverEphPub.copy(buf, 36)
  identityPub.copy(buf, SERVER_HELLO_IDPUB_OFFSET)
  return buf
}

/** 解析 SERVER_HELLO 的前缀部分（前 100 字节） */
export function parseServerHelloPrefix(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < SERVER_HELLO_PREFIX_LEN) {
    throw new Tsc1Error('BAD_SERVER_HELLO_LEN', `长度不足 ${SERVER_HELLO_PREFIX_LEN}`)
  }
  if (buf.readUInt8(0) !== TSC1_MAGIC) throw new Tsc1Error('BAD_MAGIC', 'magic 不匹配')
  if (buf.readUInt8(1) !== TSC1_VERSION) {
    throw new Tsc1Error('BAD_VERSION', `不支持的版本 ${buf.readUInt8(1)}`)
  }
  if (buf.readUInt16BE(2) !== 0) throw new Tsc1Error('BAD_RESERVED', 'reserved 必须为 0')
  return {
    serverRandom: Buffer.from(buf.subarray(4, 36)),
    serverEphPub: Buffer.from(buf.subarray(36, 68)),
    identityPub: Buffer.from(buf.subarray(SERVER_HELLO_IDPUB_OFFSET, SERVER_HELLO_SIG_OFFSET)),
  }
}

/** 拼出完整的 SERVER_HELLO（前缀 + 签名），便于服务端一次写出 */
export function buildServerHello({ serverRandom, serverEphPub, identityPub, signature }) {
  if (signature.length !== 64) throw new Error('signature 必须是 64 字节')
  return Buffer.concat([
    buildServerHelloPrefix({ serverRandom, serverEphPub, identityPub }),
    signature,
  ])
}

/**
 * 解析完整 SERVER_HELLO。
 *
 * `expectedFingerprint` 若给出，则比对 `SHA256(identity_pub)` 前 16 字节；
 * 不一致时抛 `IDENTITY_MISMATCH` —— **这正是 TOFU 的落点**：
 * 签名只证明"持有该公钥的私钥"，只有与钉扎值比对才能发现"换了个服务端"。
 */
export function parseServerHello(buf, { expectedFingerprint } = {}) {
  if (!Buffer.isBuffer(buf) || buf.length !== SERVER_HELLO_LEN) {
    throw new Tsc1Error('BAD_SERVER_HELLO_LEN', `SERVER_HELLO 长度应为 ${SERVER_HELLO_LEN}，实际 ${buf?.length}`)
  }
  const prefix = parseServerHelloPrefix(buf)
  const signature = Buffer.from(buf.subarray(SERVER_HELLO_SIG_OFFSET, SERVER_HELLO_LEN))

  if (expectedFingerprint !== undefined) {
    const actual = fingerprint(prefix.identityPub)
    if (actual.replace(/ /g, '') !== String(expectedFingerprint).replace(/ /g, '').toLowerCase()) {
      throw new Tsc1Error(
        'IDENTITY_MISMATCH',
        `服务端身份指纹与钉扎值不一致（可能被中间人）：收到 ${actual}`,
      )
    }
  }

  return { ...prefix, signature }
}

/** transcript = HELLO || SERVER_HELLO_prefix */
export function buildTranscript(helloBytes, serverHelloPrefix) {
  return Buffer.concat([helloBytes, serverHelloPrefix])
}

/**
 * 对 transcript 签名：`Ed25519_sign(priv, SHA256("TSC/1 server-hello" || transcript))`
 *
 * ⚠️ **签名本身不证明身份**。任何人都能现场生成一对密钥并自签，
 * 所以"验签通过"只说明：**对方持有该 identity_pub 对应的私钥**（防冒名，不防换人）。
 *
 * 安全性来自两件事的**组合**：
 *   ① 签名证明持有对应私钥；
 *   ② 客户端把 identity_pub 的指纹与**已存储的钉扎值**比对（首次连接走 TOFU 并提示用户带外核对）。
 * **缺了②，自签就是纸糊的。** 见 `parseServerHello({ expectedFingerprint })`。
 *
 * 注意规范 §3.3 的定义是**先哈希再签名**——不是对 transcript 直接签名。
 */
export function signTranscript(transcript, identityPrivateKey) {
  const digest = createHash('sha256').update(SIG_CONTEXT).update(transcript).digest()
  return Buffer.from(edSign(null, digest, identityPrivateKey))
}

/** 校验 transcript 签名（客户端侧与测试用） */
export function verifyTranscript(transcript, signature, identityPublicKey) {
  const digest = createHash('sha256').update(SIG_CONTEXT).update(transcript).digest()
  try {
    return edVerify(null, digest, identityPublicKey, signature)
  } catch {
    return false
  }
}

// ------------------------------------------------------------------ 会话密钥

/**
 * X25519 共享密钥，**显式拒绝全零结果**。
 *
 * 低阶点攻击：对端若提交低阶点公钥，X25519 会得到 0（或小阶子群里的值），
 * 攻击者据此可固定/削弱会话密钥。**必须检查共享密钥非零**。
 *
 * 实测（Node 24 / OpenSSL 3.5）本机上对全零点会直接抛错，但另一侧实现
 * （或换 OpenSSL 版本）可能**静默返回全零**，所以这里的检查不能省。
 */
export function computeShared(ephPrivateKey, peerEphPublicKey) {
  let shared
  try {
    shared = diffieHellman({ privateKey: ephPrivateKey, publicKey: peerEphPublicKey })
  } catch (err) {
    throw new Tsc1Error('X25519_FAILED', `密钥协商失败: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (shared.length !== 32) throw new Tsc1Error('X25519_BAD_LEN', '共享密钥长度异常')
  if (isAllZero(shared)) {
    throw new Tsc1Error('X25519_ZERO_SHARED', '共享密钥为全零（低阶点攻击），已拒绝')
  }
  return shared
}

/** 常量时间判断是否全零（不提前返回，避免把"第几位非零"泄漏成时序） */
export function isAllZero(buf) {
  let acc = 0
  for (const byte of buf) acc |= byte
  return acc === 0
}

function hkdf(ikm, salt, info) {
  return Buffer.from(hkdfSync('sha256', ikm, salt, info, 32))
}

/**
 * 由共享密钥与 transcript 派生双向会话密钥。
 *
 * ```
 * transcript_h = SHA256(transcript)
 * c2s_key      = HKDF(ikm=shared, salt=transcript_h, info="TSC/1 c2s", L=32)
 * s2c_key      = HKDF(ikm=shared, salt=transcript_h, info="TSC/1 s2c", L=32)
 * ```
 *
 * 两个方向用**各自的密钥**，因此各自的 seq 计数器不会共享 nonce 空间
 * （GCM 的硬要求）。
 */
export function deriveSessionKeys(shared, transcript) {
  const transcriptHash = createHash('sha256').update(transcript).digest()
  return {
    transcriptHash,
    c2sKey: hkdf(shared, transcriptHash, HKDF_INFO_C2S),
    s2cKey: hkdf(shared, transcriptHash, HKDF_INFO_S2C),
  }
}

// ------------------------------------------------------------------ 记录层

/** 构造 nonce：4 字节方向前缀 || 8 字节 BE seq */
export function buildNonce(prefix, seq) {
  if (prefix.length !== 4) throw new Error('nonce 前缀必须是 4 字节')
  const nonce = Buffer.alloc(12)
  prefix.copy(nonce, 0)
  nonce.writeBigUInt64BE(BigInt(seq), 4)
  return nonce
}

/**
 * 加密一帧，返回完整线上字节：
 * `[u32 length][u64 seq][12B nonce][ciphertext || 16B tag]`
 */
export function encryptFrame({ key, prefix, seq, plaintext }) {
  const nonce = buildNonce(prefix, seq)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const tag = cipher.getAuthTag()
  const bodyLen = 12 + ciphertext.length + 16
  const out = Buffer.alloc(4 + 8 + bodyLen)
  out.writeUInt32BE(bodyLen, 0)
  out.writeBigUInt64BE(BigInt(seq), 4)
  nonce.copy(out, 12)
  ciphertext.copy(out, 24)
  tag.copy(out, 24 + ciphertext.length)
  return out
}

/**
 * 解密一帧。
 *
 * AAD 为空——规范 §4 已论证 seq 同时受 (a) tag 覆盖 nonce (b) 外层递增校验约束。
 *
 * @param expectedSeq 期望的 seq；不相等即拒绝（防重放/乱序）
 */
export function decryptFrame({ key, prefix, frame, expectedSeq }) {
  if (frame.length < 4 + 8 + FRAME_OVERHEAD) throw new Tsc1Error('FRAME_TOO_SHORT', '帧过短')
  const length = frame.readUInt32BE(0)
  if (length > MAX_FRAME_LEN) {
    throw new Tsc1Error('FRAME_TOO_LARGE', `length ${length} 超过上限 ${MAX_FRAME_LEN}`)
  }
  if (length < FRAME_OVERHEAD) throw new Tsc1Error('FRAME_BAD_LENGTH', `length ${length} 小于最小开销`)

  const seq = frame.readBigUInt64BE(4)
  if (seq !== BigInt(expectedSeq)) {
    throw new Tsc1Error('FRAME_BAD_SEQ', `seq 期望 ${expectedSeq}，实际 ${seq}`)
  }

  const nonce = frame.subarray(12, 24)
  // nonce 的方向前缀必须匹配，否则说明两个方向被混用
  if (!nonce.subarray(0, 4).equals(prefix)) {
    throw new Tsc1Error('FRAME_BAD_NONCE_PREFIX', 'nonce 方向前缀不匹配')
  }
  const ciphertext = frame.subarray(24, 24 + length - FRAME_OVERHEAD)
  const tag = frame.subarray(24 + ciphertext.length, 24 + length)

  const decipher = createDecipheriv('aes-256-gcm', key, nonce)
  decipher.setAuthTag(tag)
  let plaintext
  try {
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()])
  } catch {
    throw new Tsc1Error('FRAME_AUTH_FAILED', 'GCM 认证失败（篡改或密钥不符）')
  }
  return { seq, plaintext }
}

/** 常量时间比较（令牌/指纹核对用） */
export function safeEqualBuf(a, b) {
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/** 生成 CSPRNG 随机字节 */
export function random32() {
  return randomBytes(32)
}

/** 协议层错误：带稳定的 code，便于审计与测试断言 */
export class Tsc1Error extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'Tsc1Error'
    this.code = code
  }
}
