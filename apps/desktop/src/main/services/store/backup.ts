// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 加密备份：自有格式的导出与导入。
 *
 * 格式（v1）
 * ```
 * T1000_BACKUP\n<base64(JSON 信封)>
 * ```
 * 信封 JSON：
 * ```json
 * {
 *   "magic": "T1000_BACKUP",
 *   "version": 1,
 *   "createdAt": "2026-11-05T...",
 *   "cipher": "aes-256-gcm",
 *   "kdf": { "algo": "scrypt", "N": 16384, "r": 8, "p": 1 },
 *   "salt": "<b64>",
 *   "iv": "<b64>",
 *   "tag": "<b64>",
 *   "payload": "<b64(密文)>",
 *   "meta": { "counts": {...} }
 * }
 * ```
 *
 * **明确不兼容任何第三方备份格式**：只认 magic + version，解析失败一律拒绝，
 * 不做任何"猜测式"兼容解析（参考实现被 `sourceUserId` 字符串比较卡死跨机器恢复，
 * 我们刻意不留这种隐式约束）。
 */

import { randomBytes } from 'node:crypto'
import { createCipheriv, createDecipheriv } from 'node:crypto'
import { STORE_KEYS, type StoreDb, type StoreEntity } from './db'
import {
  CIPHER_VERSION,
  IV_BYTES,
  SALT_BYTES,
  TAG_BYTES,
  deriveKey,
} from './crypto'

/** 备份文件魔数 */
export const BACKUP_MAGIC = 'T1000_BACKUP' as const
/** 备份格式版本 */
export const BACKUP_VERSION = 1 as const
/** 文件扩展名 */
export const BACKUP_EXTENSION = '.backup.t1000.enc' as const

/** 信封结构 */
export interface BackupEnvelope {
  magic: string
  version: number
  createdAt: string
  /** 编码说明；与 CIPHER_VERSION 对应，便于将来换算法 */
  cipher: string
  kdf: { algo: string; N: number; r: number; p: number }
  salt: string
  iv: string
  tag: string
  payload: string
  meta?: {
    counts?: Record<string, number>
    [k: string]: unknown
  }
}

/** 导出内容（解密后的明文结构） */
export interface BackupContent {
  exportedAt: string
  /** store_key → 行数组 */
  entities: Record<string, Array<{ itemId: string; payload: unknown; updatedAt: number; createdAt: number }>>
}

/** 导出选项 */
export interface ExportOptions {
  /** 备份口令（不传则用当前主密码派生的密钥） */
  passphrase?: string
  /** 已解锁时的现成密钥（避免重复 KDF） */
  key?: Buffer
  /** 导出哪些实体；默认全部 */
  entities?: readonly StoreEntity[]
  /** 用于文件名的时间戳 */
  now?: Date
}

/** 导入选项 */
export interface ImportOptions {
  passphrase?: string
  key?: Buffer
  /**
   * 冲突策略：
   * - `replace`：整库替换（默认，跨机器迁移语义最干净）
   * - `merge`：同 item_id 以「updated_at 更新者」为准
   */
  mode?: 'replace' | 'merge'
}

export interface ImportResult {
  mode: 'replace' | 'merge'
  /** 每个实体导入的行数 */
  imported: Record<string, number>
  /** merge 模式下被本地更新版本盖过的行数 */
  skipped: number
  total: number
}

/** 生成备份文件名：`YYYYMMDDHHmmss.v1.backup.t1000.enc` */
export function backupFileName(now: Date = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  const stamp =
    `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}` +
    `${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`
  return `${stamp}.v${BACKUP_VERSION}${BACKUP_EXTENSION}`
}

/**
 * 导出备份。
 *
 * @returns 文件字节（UTF-8）与建议文件名
 */
export function exportBackup(
  db: StoreDb,
  options: ExportOptions = {},
): { data: Buffer; fileName: string; envelope: BackupEnvelope } {
  db.checkpoint()

  const storeKeys: string[] = options.entities
    ? options.entities.map((entity) => STORE_KEYS[storeKeyAlias(entity)])
    : Object.values(STORE_KEYS)

  const content: BackupContent = {
    exportedAt: new Date().toISOString(),
    entities: {},
  }
  const counts: Record<string, number> = {}

  for (const storeKey of storeKeys) {
    const rows = db.stmts.selectAllPayload.all(storeKey)
    content.entities[storeKey] = rows.map((r) => ({
      itemId: r.item_id,
      payload: JSON.parse(r.payload) as unknown,
      updatedAt: r.updated_at,
      createdAt: r.created_at,
    }))
    counts[storeKey] = rows.length
  }

  // 派生密钥：优先用调用方给的现成密钥，其次用口令，最后报错
  const salt = randomBytes(SALT_BYTES)
  const key = resolveKey(options.passphrase, options.key, salt)
  const iv = randomBytes(IV_BYTES)

  const plaintext = Buffer.from(JSON.stringify(content), 'utf8')
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const tag = cipher.getAuthTag()
  // 本函数自产的密钥用完即毁（调用方传入的 key 由调用方管理）
  if (!options.key) key.fill(0)

  const envelope: BackupEnvelope = {
    magic: BACKUP_MAGIC,
    version: BACKUP_VERSION,
    createdAt: content.exportedAt,
    cipher: `aes-256-gcm/${CIPHER_VERSION}`,
    kdf: { algo: 'scrypt', N: 16384, r: 8, p: 1 },
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    payload: ciphertext.toString('base64'),
    meta: { counts },
  }

  const json = Buffer.from(JSON.stringify(envelope), 'utf8')
  const data = Buffer.concat([
    Buffer.from(`${BACKUP_MAGIC}\n`, 'utf8'),
    Buffer.from(json.toString('base64'), 'utf8'),
    Buffer.from('\n', 'utf8'),
  ])

  return { data, fileName: backupFileName(options.now), envelope }
}

/**
 * 解析备份文件 → 信封。
 *
 * 校验点（任一不满足即抛错，绝不"尽力而为"地猜）：
 * 1. 首行必须是 magic
 * 2. base64 必须能解出 JSON
 * 3. `magic` 字段必须一致（防首行被人为拼接）
 * 4. `version` 必须在支持列表里
 * 5. GCM 认证必须通过（口令错误 / 文件被篡改都会在这里失败）
 */
export function parseBackup(
  data: Buffer | string,
  options: Pick<ImportOptions, 'passphrase' | 'key'> = {},
): { envelope: BackupEnvelope; content: BackupContent } {
  const text = typeof data === 'string' ? data : data.toString('utf8')

  const newlineIdx = text.indexOf('\n')
  if (newlineIdx < 0) {
    throw new BackupFormatError('备份文件缺少头部：不是 terminal-1000 备份格式')
  }

  const header = text.slice(0, newlineIdx).trim()
  if (header !== BACKUP_MAGIC) {
    throw new BackupFormatError(`备份文件 magic 不匹配：期望 ${BACKUP_MAGIC}`)
  }

  const b64 = text.slice(newlineIdx + 1).trim()
  let envelope: BackupEnvelope
  try {
    const json = Buffer.from(b64, 'base64').toString('utf8')
    envelope = JSON.parse(json) as BackupEnvelope
  } catch {
    throw new BackupFormatError('备份文件信封不是合法 JSON')
  }

  if (envelope.magic !== BACKUP_MAGIC) {
    throw new BackupFormatError('备份信封 magic 字段不匹配')
  }
  if (typeof envelope.version !== 'number' || envelope.version !== BACKUP_VERSION) {
    throw new BackupFormatError(
      `不支持的备份版本: ${String(envelope.version)}（当前支持 ${BACKUP_VERSION}）`,
    )
  }
  if (envelope.kdf?.algo !== 'scrypt') {
    throw new BackupFormatError(`不支持的 KDF: ${String(envelope.kdf?.algo)}`)
  }

  const salt = Buffer.from(envelope.salt, 'base64')
  const iv = Buffer.from(envelope.iv, 'base64')
  const tag = Buffer.from(envelope.tag, 'base64')
  const ciphertext = Buffer.from(envelope.payload, 'base64')

  if (salt.length !== SALT_BYTES || iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new BackupFormatError('备份文件字段长度不合法（salt / iv / tag）')
  }

  const key = resolveKey(options.passphrase, options.key, salt)
  let plaintext: Buffer
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAuthTag(tag)
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()])
  } catch {
    // GCM 认证失败：口令不对，或者文件被篡改
    throw new BackupDecryptError('备份解密失败：口令错误或文件已被篡改')
  } finally {
    if (!options.key) key.fill(0)
  }

  let content: BackupContent
  try {
    content = JSON.parse(plaintext.toString('utf8')) as BackupContent
  } catch {
    throw new BackupFormatError('备份明文内容不是合法 JSON')
  }
  if (typeof content !== 'object' || content === null || typeof content.entities !== 'object') {
    throw new BackupFormatError('备份明文结构不合法：缺少 entities')
  }

  return { envelope, content }
}

/**
 * 导入备份。
 *
 * 写入前先完整解析成功，再在一个事务里落库；解析失败不会留下半截数据。
 * 不校验任何用户身份字段（参考实现被 `sourceUserId` 卡死，我们故意不管）。
 */
export function importBackup(
  db: StoreDb,
  data: Buffer | string,
  options: ImportOptions = {},
): ImportResult {
  const { content } = parseBackup(data, options)
  const mode = options.mode ?? 'replace'

  const imported: Record<string, number> = {}
  let skipped = 0
  let total = 0

  db.transaction(() => {
    if (mode === 'replace') {
      db.stmts.deleteAll.run()
    }

    for (const [storeKey, rows] of Object.entries(content.entities)) {
      let count = 0
      for (const row of rows) {
        // 防御：导入文件里的 itemId 必须是非空字符串，避免污染主键
        if (typeof row.itemId !== 'string' || row.itemId.length === 0) continue

        if (mode === 'merge') {
          const existing = db.get(storeKey, row.itemId)
          if (existing && existing.updated_at > row.updatedAt) {
            skipped += 1
            continue
          }
        }

        // created_at 保留源库值：跨机器恢复后时间线不乱
        db.stmts.upsert.run(
          storeKey,
          row.itemId,
          JSON.stringify(row.payload),
          row.updatedAt,
          row.createdAt,
        )
        count += 1
        total += 1
      }
      imported[storeKey] = count
    }
  })

  return { mode, imported, skipped, total }
}

/** 格式错误（magic / 版本 / 结构） */
export class BackupFormatError extends Error {
  readonly kind = 'format' as const
  constructor(message: string) {
    super(message)
    this.name = 'BackupFormatError'
  }
}

/** 解密错误（口令错 / 被篡改），与格式错误区分以便给出不同提示 */
export class BackupDecryptError extends Error {
  readonly kind = 'decrypt' as const
  constructor(message: string) {
    super(message)
    this.name = 'BackupDecryptError'
  }
}

/** 实体名 → STORE_KEYS 的键名映射（'Server' → 'server'） */
function storeKeyAlias(entity: StoreEntity): keyof typeof STORE_KEYS {
  switch (entity) {
    case 'Server':
      return 'server'
    case 'Group':
      return 'group'
    case 'Credential':
      return 'credential'
    case 'Settings':
      return 'settings'
    case 'AIChat':
      return 'aiChat'
  }
}

/** 密钥解析：现成密钥 > 口令派生 > 报错 */
function resolveKey(passphrase: string | undefined, key: Buffer | undefined, salt: Buffer): Buffer {
  if (key) return key
  if (passphrase && passphrase.length > 0) return deriveKey(passphrase, salt)
  throw new BackupFormatError('缺少备份口令：导出或导入都需要口令或已解锁的主密码')
}
