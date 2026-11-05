// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * store 域的加密原语：主密码派生（scrypt）+ 字段级 AES-256-GCM。
 *
 * 设计要点
 * - KDF 用 Node 内置 `crypto.scryptSync`（N=16384, r=8, p=1, 32 字节），
 *   不引入 argon2 之类的原生依赖，避免 electron-rebuild 复杂度。
 * - 每个密文字段带**独立随机 salt**（作为该密文的 nonce 记录在密文里）：
 *   同一明文在两条记录里产生不同密文，密文本身即自描述、可独立轮换。
 * - **主密码与派生密钥只存在于内存**（Vault 闭包内），没有任何落盘路径，
 *   更没有 `getMasterPassword()` 这类出口。
 * - 密钥用 Buffer 持有且可被 `lock()` 显式 `fill(0)` 覆写，缩短明文密钥驻留时间。
 */

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto'

/** 密文版本前缀；将来换算法时靠它做迁移 */
export const CIPHER_VERSION = 'v1' as const

/** scrypt 参数（写入文档，不写入密文——版本号即代表参数集） */
export const SCRYPT_PARAMS = {
  /** CPU/内存开销，必须是 2 的幂 */
  N: 16384,
  /** 块大小 */
  r: 8,
  /** 并行度（Node 的 scrypt 只支持 p=1 的高效实现[1]，此处固定 1） */
  p: 1,
  /** 派生密钥长度（AES-256 需要 32 字节） */
  keylen: 32,
  /** scrypt 内部内存上限，N*r*128 = 16 MiB，留一倍余量 */
  maxmem: 64 * 1024 * 1024,
} as const

/** 随机 salt 长度 */
export const SALT_BYTES = 16
/** GCM IV 长度（12 字节是 GCM 推荐值，也是性能最优值） */
export const IV_BYTES = 12
/** GCM 认证标签长度 */
export const TAG_BYTES = 16

/**
 * 加密字段在「未解锁」状态下的占位值。
 * 读取时返回掩码而不是抛错——UI 需要能正常列出连接，只是看不到密码。
 */
export const LOCKED_MASK = '__LOCKED__'

/** 需要加密的字段名（全库统一：连接 / 跳板 / 凭证 / 代理 / AI key 都命中同一个集合） */
export const ENCRYPTED_FIELD_NAMES: readonly string[] = [
  'password',
  'privateKey',
  'passphrase',
  'apiKey',
  'token',
] as const

/** 判断一个字符串是否是我们的密文格式 */
export function isCiphertext(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(`${CIPHER_VERSION}:`)
}

/** 是否是锁定掩码 */
export function isLockedMask(value: unknown): boolean {
  return value === LOCKED_MASK
}

/** 由主密码派生 32 字节密钥（scrypt） */
export function deriveKey(password: string, salt: Buffer): Buffer {
  return scryptSync(password, salt, SCRYPT_PARAMS.keylen, {
    N: SCRYPT_PARAMS.N,
    r: SCRYPT_PARAMS.r,
    p: SCRYPT_PARAMS.p,
    maxmem: SCRYPT_PARAMS.maxmem,
  })
}

/**
 * 用密钥加密一段 UTF-8 明文字符串。
 *
 * @returns `v1:<saltB64>:<ivB64>:<tagB64>:<cipherB64>`
 */
export function encryptWithKey(key: Buffer, plaintext: string): string {
  const salt = randomBytes(SALT_BYTES)
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return [
    CIPHER_VERSION,
    salt.toString('base64'),
    iv.toString('base64'),
    tag.toString('base64'),
    ciphertext.toString('base64'),
  ].join(':')
}

/**
 * 解密一段密文。密钥不匹配或密文被篡改时抛错（GCM 认证失败）。
 *
 * 这里不吞异常：调用方（`decryptField`）决定是降级为掩码还是向上抛。
 */
export function decryptWithKey(key: Buffer, blob: string): string {
  const parts = blob.split(':')
  if (parts.length !== 5) {
    throw new Error('密文格式不合法：期望 5 段')
  }
  const [version, saltB64, ivB64, tagB64, cipherB64] = parts as [
    string,
    string,
    string,
    string,
    string,
  ]
  if (version !== CIPHER_VERSION) {
    throw new Error(`不支持的密文版本: ${version}`)
  }

  const iv = Buffer.from(ivB64, 'base64')
  const tag = Buffer.from(tagB64, 'base64')
  const ciphertext = Buffer.from(cipherB64, 'base64')
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new Error('密文格式不合法：IV 或认证标签长度错误')
  }

  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  // `final()` 会做 GCM 认证；密钥错误时在这里抛出
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
}

/** 常量时间比较，用于校验主密码（避免时序侧信道） */
export function safeEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/**
 * 主密码保管箱。
 *
 * - 只持有内存中的 `key`（Buffer）与一个用于校验的 salt + verifier。
 * - 校验值存储的是 `scrypt(password, verifySalt)` 的派生结果，
 *   **不是主密码本身**，也不是可直接解密的密钥，可以安全落盘。
 */
export class Vault {
  /** 当前派生密钥；null = 已锁定 */
  private key: Buffer | null = null

  /** 主密码是否已设置（区分「首次设置」与「解锁」语义） */
  isInitialized(): boolean {
    return this.key !== null
  }

  isUnlocked(): boolean {
    return this.key !== null
  }

  /** 取当前密钥；未解锁时返回 null（调用方据此写掩码） */
  currentKey(): Buffer | null {
    return this.key
  }

  /** 解锁：装填派生密钥 */
  unlockWithKey(key: Buffer): void {
    this.lock()
    this.key = key
  }

  /** 锁定：覆写并丢弃密钥 */
  lock(): void {
    if (this.key) {
      this.key.fill(0)
      this.key = null
    }
  }
}

/**
 * 生成「主密码校验记录」：`<saltB64>:<verifierB64>`。
 *
 * 用于启动时判断用户输入的主密码是否正确——校验值和密文一样落盘，
 * 但它无法反推主密码（scrypt 单向）。
 */
export function createVerifier(password: string): string {
  const salt = randomBytes(SALT_BYTES)
  const verifier = deriveKey(password, salt)
  const out = `${salt.toString('base64')}:${verifier.toString('base64')}`
  verifier.fill(0)
  return out
}

/**
 * 校验主密码是否与记录匹配，并返回派生密钥（用同一条记录里的 salt，
 * 避免二次派生）。
 *
 * @returns 匹配时返回 32 字节密钥，否则 null
 */
export function verifyAndDerive(password: string, record: string): Buffer | null {
  const parts = record.split(':')
  if (parts.length !== 2) return null
  const [saltB64, verifierB64] = parts as [string, string]
  let salt: Buffer
  let expected: Buffer
  try {
    salt = Buffer.from(saltB64, 'base64')
    expected = Buffer.from(verifierB64, 'base64')
  } catch {
    return null
  }
  if (salt.length === 0 || expected.length !== SCRYPT_PARAMS.keylen) return null

  const actual = deriveKey(password, salt)
  const ok = safeEqual(actual, expected)
  if (!ok) {
    actual.fill(0)
    return null
  }
  return actual
}
