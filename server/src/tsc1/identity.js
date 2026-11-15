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

// ------------------------------------------------------------------ CLI 入口

/**
 * `node server/src/tsc1/identity.js --fingerprint`
 *
 * ## 为什么必须有这个命令
 * 规范 §8 记的薄弱处之一：**`identity.key` 丢失后没有任何恢复路径** ——
 * 所有已钉扎的客户端都会校验失败（§5 的唯一恢复方式是"用户手动更新指纹"）。
 * 用户需要在服务器上**看到当前指纹**才能去做这件事；没有它就只能瞎猜。
 *
 * 输出格式与启动日志**完全一致**（8 组 4 字符），便于逐字符口述比对。
 *
 * 注意
 * - 只读，**绝不打印私钥**（连种子长度都不打印）
 * - 文件不存在时**不自动生成**：那会让"已钉扎客户端全部失败"这件事
 *   悄悄发生在一个只读查询里。明确报错、要求用户知道自己在做什么。
 */
function runCli(argv) {
  const wantsFingerprint = argv.includes('--fingerprint') || argv.includes('--print-fingerprint')

  if (!wantsFingerprint) {
    console.log('用法: node server/src/tsc1/identity.js --fingerprint')
    console.log('  打印当前 TSC/1 服务端身份指纹（8 组 4 字符），供用户带外核对/更新钉扎。')
    console.log('  数据目录由 T1000_DATA_DIR 指定（默认 ./data）。')
    return 0
  }

  const dir = dataDir()
  const file = identityPath(dir)

  if (!existsSync(file)) {
    console.error(`未找到身份密钥: ${file}`)
    console.error('该实例还没有身份（首次启动时会自动生成）。此处不会自动创建 ——')
    console.error('若你原本已有身份却看不到这个文件，说明数据目录不对（检查 T1000_DATA_DIR）。')
    return 1
  }

  const fp = readIdentityFingerprint(dir)
  if (!fp) {
    console.error(`身份文件存在但内容不可解析: ${file}`)
    return 1
  }

  console.log(fp)
  return 0
}

// 仅在被直接执行时跑 CLI（被 import 时无副作用）
const invokedDirectly = process.argv[1] && import.meta.url === `file://${process.argv[1]}`
if (invokedDirectly) {
  process.exit(runCli(process.argv.slice(2)))
}
