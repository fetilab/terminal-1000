// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 服务端长期身份密钥（Ed25519）的生成与持久化。
 *
 * 规范 §5：首次启动生成，私钥落在数据目录，用户靠**指纹带外核对**。
 *
 * 纪律（安全相关）
 * - 私钥文件权限 **0600**（owner 读写，组/其他一律不可读）
 * - 私钥**绝不出现在日志、响应、错误信息里**
 * - 写入用原子替换，避免中途断电留下半个私钥
 */

import { createPublicKey } from 'node:crypto'
import { existsSync, readFileSync, chmodSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { ed25519PrivateFromRaw, ed25519PublicFromRaw, fingerprint, generateIdentity } from './crypto.js'
import { dataDir, ensureDir, writeFileAtomic } from '../util.js'

/** 身份密钥文件名 */
export const IDENTITY_FILE = 'identity.key'

/** 私钥文件权限 */
export const IDENTITY_MODE = 0o600

/** 身份文件格式版本（将来换算法时靠它迁移） */
const IDENTITY_FORMAT = 'tsc1-identity-v1'

export function identityPath(dir = dataDir()) {
  return join(dir, IDENTITY_FILE)
}

/**
 * 载入或生成长期身份密钥。
 *
 * @returns `{ privateKey, publicKey, publicKeyRaw, fingerprint, path, created, warning }`
 *   - `privateKey` / `publicKey` 是 KeyObject，仅用于签名与验签
 *   - `publicKeyRaw` 是 32 字节原始公钥（指纹与对外公开用）
 *   - `warning` 非空表示磁盘权限有问题（不阻断启动，但要显式提醒）
 */
export function loadOrCreateIdentity(dir = dataDir()) {
  const file = identityPath(dir)

  if (existsSync(file)) {
    return loadIdentity(file)
  }

  const { seed, publicKey } = generateIdentity()
  ensureDir(dir)

  writeFileAtomic(file, JSON.stringify({ format: IDENTITY_FORMAT, seed: seed.toString('base64') }, null, 2))

  // 原子写出来的文件默认权限受 umask 影响，这里显式收紧。
  // 先 chmod 再返回：宁可启动慢一毫秒，也不让私钥有一刻是可读的。
  chmodSync(file, IDENTITY_MODE)

  return describe(file, seed, publicKey, true, undefined)
}

/** 读取既有身份文件 */
function loadIdentity(file) {
  let parsed
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch (err) {
    throw new Error(`身份密钥文件无法解析（${file}）：${err instanceof Error ? err.message : String(err)}`)
  }

  if (!parsed || parsed.format !== IDENTITY_FORMAT) {
    throw new Error(`身份密钥格式不受支持（${file}）：${parsed?.format}`)
  }
  const seed = Buffer.from(String(parsed.seed ?? ''), 'base64')
  if (seed.length !== 32) {
    throw new Error(`身份密钥内容非法（${file}）：期望 32 字节种子`)
  }

  // 从私钥导出公钥，避免"文件里同时存公私钥却对不上"的隐患
  const pubRaw = publicRawFromPrivate(ed25519PrivateFromRaw(seed))

  const warning = checkPermissions(file)
  return describe(file, seed, pubRaw, false, warning)
}

/** 由 Ed25519 私钥导出原始 32 字节公钥 */
function publicRawFromPrivate(privateKeyObject) {
  const der = createPublicKey(privateKeyObject).export({ format: 'der', type: 'spki' })
  // SPKI 末尾 32 字节即原始公钥（与 crypto.js 里的前缀约定一致）
  return Buffer.from(der.subarray(der.length - 32))
}

/**
 * 检查私钥文件权限。
 *
 * 不阻断启动（服务还得能跑），但必须让用户看见——
 * 一个 world-readable 的长期私钥等于把服务器身份送人。
 */
function checkPermissions(file) {
  if (process.platform === 'win32') return undefined
  try {
    const mode = statSync(file).mode & 0o777
    if (mode !== IDENTITY_MODE) {
      return `身份密钥权限为 ${mode.toString(8)}，建议收紧到 ${IDENTITY_MODE.toString(8)}：chmod 600 ${file}`
    }
  } catch {
    return undefined
  }
  return undefined
}

function describe(file, seed, publicKeyRaw, created, warning) {
  const pubRaw = Buffer.isBuffer(publicKeyRaw) ? publicKeyRaw : Buffer.from(publicKeyRaw)
  return {
    privateKey: ed25519PrivateFromRaw(seed),
    publicKey: ed25519PublicFromRaw(pubRaw),
    publicKeyRaw: pubRaw,
    fingerprint: fingerprint(pubRaw),
    path: file,
    created,
    warning,
  }
}

/** 读取身份公钥原始字节（不载入私钥；仅供指纹核对） */
export function readIdentityPublicRaw(dir = dataDir()) {
  const file = identityPath(dir)
  if (!existsSync(file)) return undefined
  const parsed = JSON.parse(readFileSync(file, 'utf8'))
  const seed = Buffer.from(String(parsed.seed ?? ''), 'base64')
  if (seed.length !== 32) return undefined
  return publicRawFromPrivate(ed25519PrivateFromRaw(seed))
}

/** 当前身份指纹（未初始化时返回 undefined） */
export function readIdentityFingerprint(dir = dataDir()) {
  const raw = readIdentityPublicRaw(dir)
  return raw ? fingerprint(raw) : undefined
}
