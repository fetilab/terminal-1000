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
 *   "meta": { "counts": {...}, "fieldSalt": "<b64>", "portableFields": true }
 * }
 * ```
 *
 * **字段级可迁移性（带口令备份）**
 * - 不带口令（本机主密钥）的备份：敏感字段仍是本机主密钥的字段级密文，只在本机可解 —— 行为与旧版一致。
 * - 带口令的备份：导出时先用**本机主密钥**解开敏感字段，再用**备份口令派生的字段密钥**
 *   重新加密；`meta.fieldSalt` 记录字段密钥的盐，导入侧据此用备份口令还原，
 *   最后用**本机主密钥**重新加密落库。这样同一份备份在任意设备都能还原凭据。
 * - 没有 `meta.fieldSalt` 的旧备份按原样导入（字段保持原密文），兼容不破坏。
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

/**
 * 字段级编解码器（由 `Repository` 实现）。
 *
 * 备份层只依赖这两个操作，不直接依赖 repository —— 从而**复用**既有的
 * 「按 ENCRYPTED_FIELD_NAMES 递归扫描」实现，而不是再造一套字段清单。
 */
export interface FieldCodec {
  /** 用 key 解开 payload 里的敏感字段（密钥不对时抛错） */
  decryptFields(payload: unknown, key: Buffer): unknown
  /** 用 key 加密 payload 里的敏感字段（已是密文的原样保留） */
  encryptFields(payload: unknown, key: Buffer): unknown
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
  /**
   * 字段编解码器。**传入 + 有口令** 才会做跨设备字段迁移；
   * 不传则保持旧行为（字段仍是本机主密钥密文），供底层调用方与旧测试使用。
   */
  fieldCodec?: FieldCodec
  /** 本机主密钥（解开现有字段密文用）；带口令导出时必须提供 */
  masterKey?: Buffer | null
}

/** 导入选项 */
export interface ImportOptions {
  passphrase?: string
  key?: Buffer
  /** 字段编解码器（见 ExportOptions.fieldCodec）；导入带字段迁移的备份时必须提供 */
  fieldCodec?: FieldCodec
  /** 本机主密钥（把凭据重新加密到本机用）；导入带字段迁移的备份且未解锁时缺失 */
  masterKey?: Buffer | null
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

  // 「带口令 + 有编解码器」才是跨设备载体：敏感字段要迁到备份口令派生的密钥下。
  // （不带口令的本地备份保持旧行为：字段仍是本机主密钥密文。）
  const passphrase =
    options.passphrase !== undefined && options.passphrase.length > 0 ? options.passphrase : undefined
  const codec = options.fieldCodec
  const masterKey = options.masterKey ?? null
  let fieldKey: Buffer | null = null
  let fieldSalt: Buffer | null = null
  if (passphrase !== undefined && codec !== undefined) {
    if (masterKey === null) {
      // 安全含义：锁定态下绝不能产出「可换机还原明文凭据」的备份 ——
      // 那等于绕过了主密码保护。明确报错，而不是写出一个凭据解不开的备份。
      throw new BackupLockedError(
        '未解锁：无法导出可跨设备使用的备份，请先解锁主密码库后再导出',
      )
    }
    fieldSalt = randomBytes(SALT_BYTES)
    fieldKey = deriveKey(passphrase, fieldSalt)
  }

  const content: BackupContent = {
    exportedAt: new Date().toISOString(),
    entities: {},
  }
  const counts: Record<string, number> = {}

  for (const storeKey of storeKeys) {
    const rows = db.stmts.selectAllPayload.all(storeKey)
    content.entities[storeKey] = rows.map((r) => {
      const parsed = JSON.parse(r.payload) as unknown
      // 字段迁移在**这一遍遍历**里完成：不再整库反序列化第二遍。
      // 代价是 O(敏感字段数)：decrypt/encrypt 的递归扫描只碰命中的字段。
      const payload =
        fieldKey !== null && codec !== undefined && masterKey !== null
          ? codec.encryptFields(codec.decryptFields(parsed, masterKey), fieldKey)
          : parsed
      return {
        itemId: r.item_id,
        payload,
        updatedAt: r.updated_at,
        createdAt: r.created_at,
      }
    })
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
    meta: {
      counts,
      // 自描述：有 fieldSalt 就代表敏感字段是用备份口令加密的
      ...(fieldSalt === null
        ? {}
        : { fieldSalt: fieldSalt.toString('base64'), portableFields: true }),
    },
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
  const { envelope, content } = parseBackup(data, options)
  const mode = options.mode ?? 'replace'

  // 信封自描述：带 fieldSalt 说明字段是「备份口令」加密的，落库前必须迁回本机主密钥，
  // 否则就是「同步成功但凭据全废」的那种静默失效。
  const fieldSaltB64 = envelope.meta?.fieldSalt
  const codec = options.fieldCodec
  let fieldKey: Buffer | null = null
  let masterKey: Buffer | null = null
  if (typeof fieldSaltB64 === 'string' && fieldSaltB64.length > 0) {
    if (codec === undefined) {
      throw new BackupConfigError('导入该备份需要字段编解码器（内部接线缺失）')
    }
    const passphrase = options.passphrase
    if (passphrase === undefined || passphrase.length === 0) {
      throw new BackupConfigError('备份中的凭据由备份口令加密，导入时必须提供该口令')
    }
    masterKey = options.masterKey ?? null
    if (masterKey === null) {
      throw new BackupLockedError(
        '未解锁：无法导入可跨设备的备份（需要把凭据重新加密到本机），请先解锁主密码库后再导入',
      )
    }
    fieldKey = deriveKey(passphrase, Buffer.from(fieldSaltB64, 'base64'))
  }

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

        // 带字段迁移的备份：先用备份口令解开，再用本机主密钥重新加密
        let payload = row.payload
        if (fieldKey !== null && masterKey !== null && codec !== undefined) {
          try {
            payload = codec.encryptFields(codec.decryptFields(row.payload, fieldKey), masterKey)
          } catch {
            // 个别字段解不开（更早版本的备份字段仍是别机主密钥密文 / 数据损坏）：
            // 原样保留，绝不写入半截数据，也不静默丢掉用户原有的密文
            payload = row.payload
          }
        }

        // created_at 保留源库值：跨机器恢复后时间线不乱
        db.stmts.upsert.run(
          storeKey,
          row.itemId,
          JSON.stringify(payload),
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

/** 需要先解锁才能安全完成（导出/导入带口令备份时拿不到本机主密钥） */
export class BackupLockedError extends Error {
  readonly kind = 'locked' as const
  constructor(message: string) {
    super(message)
    this.name = 'BackupLockedError'
  }
}

/** 调用方接线/用法错误（例如带字段迁移的备份却没有提供编解码器） */
export class BackupConfigError extends Error {
  readonly kind = 'config' as const
  constructor(message: string) {
    super(message)
    this.name = 'BackupConfigError'
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
    case 'Note':
      return 'note'
    case 'NoteFolder':
      return 'noteFolder'
    case 'SessionLog':
      return 'sessionLog'
  }
}

/** 密钥解析：现成密钥 > 口令派生 > 报错 */
function resolveKey(passphrase: string | undefined, key: Buffer | undefined, salt: Buffer): Buffer {
  if (key) return key
  if (passphrase && passphrase.length > 0) return deriveKey(passphrase, salt)
  throw new BackupFormatError('缺少备份口令：导出或导入都需要口令或已解锁的主密码')
}
