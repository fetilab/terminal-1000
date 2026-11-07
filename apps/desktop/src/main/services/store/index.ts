// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * store 域：SQLite 持久化、连接/分组/凭证仓储、主密码加密、备份导入导出。
 *
 * 动作清单见 packages/shared/src/ipc.ts 的 Actions.store。
 *
 * 设计要点
 * - **惰性建库**：`storeHandlers` 是纯函数表，数据库连接在首次调用时才建立，
 *   这样单测可以注入 `:memory:` 实例，也不拖慢主进程冷启动。
 * - **所有入参在边界用 zod 校验**，失败抛 `AppError.badRequest`（带 zod issues）。
 * - **未解锁不是错误**：加密字段读取返回 `__LOCKED__` 掩码，
 *   只有「需要密钥才能完成的操作」（改主密码、加密导出）才在锁定态拒绝。
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import type { Connection, ConnectionGroup, Credential } from '@t1000/shared'
import { AppError } from '../../errors'
import type { IpcHandler } from '../../ipc/router'
import { StoreDb } from './db'
import { Repository } from './repository'
import {
  Vault,
  createVerifier,
  decryptWithKey,
  encryptWithKey,
  isCiphertext,
  isLockedMask,
  verifyAndDerive,
  CIPHER_VERSION,
} from './crypto'
import {
  BackupConfigError,
  BackupDecryptError,
  BackupFormatError,
  BackupLockedError,
  backupFileName,
  exportBackup,
  importBackup,
} from './backup'

/** 主密码校验记录的 meta key */
const META_VERIFIER = 'master_password_verifier'

// ------------------------------------------------------------------ zod 校验

const idSchema = z.string().min(1, 'id 不能为空')

const connectionKindSchema = z.enum(['ssh', 'rdp', 'telnet', 'tunnel', 'vnc'])
const groupKindSchema = z.enum(['ssh', 'rdp', 'telnet', 'tunnel', 'vnc', 'mixed'])
const storeTypeSchema = z.enum(['local', 'cloud'])
const authTypeSchema = z.enum(['password', 'privateKey', 'identity', 'keyboardInteractive', 'keyboard'])

/**
 * 连接入参校验。
 *
 * 刻意用 **宽松对象**（只强校验 id / name / host / port 这类结构性字段，
 * 其余 passthrough）：Connection 是五态联合，规格还在演进，
 * 在这里做全量判别式校验会把 shared 的类型演进变成两处维护。
 * 结构性字段是「写坏库就救不回来」的部分，必须卡住。
 */
const connectionInputSchema = z
  .object({
    id: idSchema,
    name: z.string().min(1, '名称不能为空').max(200),
    kind: connectionKindSchema,
    host: z.string().min(1, '主机不能为空').max(255),
    port: z.number().int().min(1).max(65535),
    groupId: z.string().min(1).optional(),
    username: z.string().max(255).optional(),
    storeType: storeTypeSchema.optional(),
  })
  .passthrough()

const groupInputSchema = z
  .object({
    id: idSchema,
    name: z.string().min(1, '分组名不能为空').max(200),
    parentId: z.string().min(1).optional(),
    kind: groupKindSchema,
    sortOrder: z.number().int().optional(),
    storeType: storeTypeSchema.optional(),
  })
  .passthrough()

const credentialInputSchema = z
  .object({
    id: idSchema,
    name: z.string().min(1, '凭证名不能为空').max(200),
    username: z.string().max(255).optional(),
    password: z.string().optional(),
    privateKey: z.string().optional(),
    passphrase: z.string().optional(),
    note: z.string().optional(),
  })
  .passthrough()

const masterPasswordSchema = z.object({
  /** 改密码时提供旧密码；首次设置时省略 */
  oldPassword: z.string().min(1).optional(),
  newPassword: z.string().min(8, '主密码至少 8 位'),
})

const unlockSchema = z.object({
  password: z.string().min(1, '主密码不能为空'),
})

const exportBackupSchema = z.object({
  /** 备份口令；省略则用当前主密码派生的密钥 */
  passphrase: z.string().min(1).optional(),
  /** 输出目录；省略则用 ctx.paths.backupDir */
  dir: z.string().min(1).optional(),
  filePath: z.string().min(1).optional(),
})

const importBackupSchema = z.object({
  data: z.union([z.string().min(1), z.instanceof(Buffer)]),
  passphrase: z.string().min(1).optional(),
  mode: z.enum(['replace', 'merge']).optional(),
})

const searchSchema = z.object({
  keyword: z.string().min(1, '搜索词不能为空').max(200),
  limit: z.number().int().min(1).max(1000).optional(),
})

const connectionIdSchema = z.object({ id: idSchema })

const moveConnectionSchema = z.object({
  id: idSchema,
  /** null / 省略 = 移出分组 */
  groupId: z.string().min(1).nullable().optional(),
})

const deleteGroupSchema = z.object({
  id: idSchema,
  /** false = 子分组提升一层，连接移出分组 */
  cascade: z.boolean().optional(),
})

/** 统一的 zod 解析：失败转成带 issues 的 AppError.badRequest */
function parseInput<T>(schema: z.ZodType<T>, payload: unknown): T {
  const result = schema.safeParse(payload)
  if (!result.success) {
    const issues = result.error.issues.map((i) => ({
      path: i.path.join('.'),
      message: i.message,
    }))
    throw AppError.badRequest(`参数校验失败: ${issues.map((i) => `${i.path}: ${i.message}`).join('; ')}`, issues)
  }
  return result.data
}

// ------------------------------------------------------------------ 服务本体

/**
 * store 服务：把 db / repository / vault / backup 组装起来并暴露业务方法。
 *
 * 与 IPC 层解耦，便于单测直接 new 一个 `:memory:` 实例。
 */
export class StoreService {
  readonly db: StoreDb
  readonly repo: Repository
  private readonly vault: Vault

  constructor(dbFile: string | StoreDb = ':memory:', vault = new Vault()) {
    this.db = typeof dbFile === 'string' ? new StoreDb(dbFile) : dbFile
    this.vault = vault
    this.repo = new Repository(this.db, () => this.vault.currentKey())
  }

  // ------------------------------------------------------------- 主密码

  /** 是否已经设置过主密码 */
  isInitialized(): boolean {
    return this.db.getMeta(META_VERIFIER) !== undefined
  }

  isUnlocked(): boolean {
    return this.vault.isUnlocked()
  }

  /**
   * 解锁。校验记录不存在时视为「首次设置」（用 newPassword 语义）。
   *
   * @returns 是否成功
   */
  unlock(password: string): boolean {
    const record = this.db.getMeta(META_VERIFIER)
    if (record === undefined) {
      // 首次：直接以此密码初始化
      this.setMasterPassword(password)
      return true
    }
    const key = verifyAndDerive(password, record)
    if (!key) return false
    this.vault.unlockWithKey(key)
    return true
  }

  lock(): void {
    this.vault.lock()
  }

  /**
   * 设置 / 修改主密码。
   *
   * 已初始化时必须提供正确的旧密码；修改时**重加密全部密文字段**，
   * 整个过程在一个事务里，失败回滚（不会出现半加密状态）。
   */
  setMasterPassword(newPassword: string, oldPassword?: string): { reencrypted: number; created: boolean } {
    const record = this.db.getMeta(META_VERIFIER)

    if (record === undefined) {
      // 首次设置：一次派生同时拿到「密钥」与「校验记录」，不做二次 scrypt
      const { key, verifier } = deriveNewCredentials(newPassword)
      this.vault.unlockWithKey(key)
      this.db.setMeta(META_VERIFIER, verifier)
      return { reencrypted: 0, created: true }
    }

    // 已存在：必须有旧密码且正确
    if (oldPassword === undefined) {
      throw AppError.badRequest('修改主密码需要提供旧密码')
    }
    const oldKey = verifyAndDerive(oldPassword, record)
    if (!oldKey) {
      throw AppError.unauthorized('旧主密码不正确')
    }

    // 先确保当前 vault 里就是旧密钥（可能处于锁定态）
    this.vault.unlockWithKey(oldKey)

    // 新密钥：用新密码 + 新 salt 派生（一次 scrypt，同时得到校验记录）
    const { key: newKey, verifier: newVerifierRecord } = deriveNewCredentials(newPassword)

    const reencrypted = this.repo.reencryptAll(oldKey, newKey)

    this.db.transaction(() => {
      this.db.setMeta(META_VERIFIER, newVerifierRecord)
    })

    this.vault.unlockWithKey(newKey)
    return { reencrypted, created: false }
  }

  // --------------------------------------------------------------- 连接

  listConnections(): Connection[] {
    return this.repo.listConnections()
  }

  getConnection(id: string): Connection {
    const conn = this.repo.getConnection(id)
    if (!conn) throw AppError.notFound(`连接不存在: ${id}`)
    return conn
  }

  saveConnection(input: Connection): Connection {
    const now = new Date().toISOString()
    return this.repo.saveConnection(input, now)
  }

  deleteConnection(id: string): { deleted: boolean } {
    const deleted = this.repo.deleteConnection(id)
    if (!deleted) throw AppError.notFound(`连接不存在: ${id}`)
    return { deleted }
  }

  moveConnection(id: string, groupId: string | null | undefined): Connection {
    const now = new Date().toISOString()
    const target = groupId === null ? undefined : groupId
    if (target !== undefined && !this.repo.getGroup(target)) {
      throw AppError.notFound(`分组不存在: ${target}`)
    }
    const moved = this.repo.moveConnection(id, target, now)
    if (!moved) throw AppError.notFound(`连接不存在: ${id}`)
    return moved
  }

  // --------------------------------------------------------------- 分组

  listGroups(): ConnectionGroup[] {
    return this.repo.listGroups()
  }

  /** 分组树（含直属连接数） */
  listGroupTree(): ReturnType<Repository['buildGroupTree']> {
    return this.repo.buildGroupTree()
  }

  saveGroup(input: ConnectionGroup): ConnectionGroup {
    if (input.parentId !== undefined) {
      // 防止自环与指向不存在的父级
      if (input.parentId === input.id) throw AppError.badRequest('分组不能以自己为父级')
      if (!this.repo.getGroup(input.parentId)) {
        throw AppError.notFound(`父分组不存在: ${input.parentId}`)
      }
    }
    const now = new Date().toISOString()
    const normalized: ConnectionGroup = { ...input, sortOrder: input.sortOrder ?? 0 }
    return this.repo.saveGroup(normalized, now)
  }

  deleteGroup(id: string, cascade = true): { deletedGroups: string[]; affectedConnections: number } {
    const result = this.repo.deleteGroup(id, cascade)
    if (result.deletedGroups.length === 0) throw AppError.notFound(`分组不存在: ${id}`)
    return result
  }

  // --------------------------------------------------------------- 凭证

  listCredentials(): Credential[] {
    return this.repo.listCredentials()
  }

  saveCredential(input: Credential): Credential {
    return this.repo.saveCredential(input, new Date().toISOString())
  }

  // --------------------------------------------------------------- 搜索

  search(keyword: string, limit?: number): Connection[] {
    return this.repo.search(keyword, limit)
  }

  // --------------------------------------------------------------- 备份

  /**
   * 导出加密备份并落盘。
   *
   * 密钥优先级：`passphrase` > 已解锁的主密码。
   * 两者都没有时拒绝（不能导出明文备份——那等于把密码库摊开在磁盘上）。
   */
  exportBackupToFile(params: {
    passphrase?: string
    dir?: string
    filePath?: string
    backupDir: string
  }): { fileName: string; filePath: string; bytes: number; counts: Record<string, number> } {
    const { data, fileName, counts } = this.renderBackup(params.passphrase)
    const target = params.filePath ?? join(params.dir ?? params.backupDir, fileName)

    // 目录可能被用户删过，落盘前补建
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, data, { mode: 0o600 })

    return { fileName, filePath: target, bytes: data.byteLength, counts }
  }

  /**
   * 生成备份字节（不落盘，测试与同步模块复用）。
   *
   * 带口令时会把敏感字段从「本机主密钥」迁移到「备份口令派生的字段密钥」，
   * 这样备份才能跨设备还原凭据（不带口令的本地备份行为不变）。
   * 未解锁时无法完成字段迁移，直接报错而不是写出一个凭据解不开的备份。
   */
  renderBackup(passphrase?: string): {
    data: Buffer
    fileName: string
    counts: Record<string, number>
  } {
    const key = this.resolveExportKey(passphrase)
    try {
      const { data, fileName, envelope } = exportBackup(this.db, {
        ...(passphrase === undefined ? {} : { passphrase }),
        ...(passphrase === undefined && key ? { key } : {}),
        // 字段级编解码复用 repository 的递归扫描（不另造字段清单）
        fieldCodec: this.repo,
        masterKey: this.vault.currentKey(),
      })
      return { data, fileName, counts: (envelope.meta?.counts ?? {}) as Record<string, number> }
    } catch (err) {
      throw this.toBackupError(err)
    }
  }

  /** 导入备份（带口令的备份会把凭据重新加密到本机主密钥后再落库） */
  importBackup(data: Buffer | string, options: { passphrase?: string; mode?: 'replace' | 'merge' } = {}) {
    const key = this.resolveExportKey(options.passphrase)
    try {
      return importBackup(this.db, data, {
        ...(options.passphrase === undefined ? {} : { passphrase: options.passphrase }),
        ...(options.passphrase === undefined && key ? { key } : {}),
        ...(options.mode === undefined ? {} : { mode: options.mode }),
        fieldCodec: this.repo,
        masterKey: this.vault.currentKey(),
      })
    } catch (err) {
      throw this.toBackupError(err)
    }
  }

  /** 备份层错误 → 带语义的 IPC 错误码 */
  private toBackupError(err: unknown): AppError {
    if (err instanceof BackupFormatError) return AppError.badRequest(err.message)
    if (err instanceof BackupDecryptError) return AppError.unauthorized(err.message)
    // 未解锁 / 带口令备份缺少口令 —— 都需要用户先解锁或补口令
    if (err instanceof BackupLockedError) return AppError.unauthorized(err.message)
    if (err instanceof BackupConfigError) return AppError.internal(err.message)
    if (err instanceof AppError) return err
    return AppError.internal(err instanceof Error ? err.message : String(err))
  }

  /** 备份文件名（渲染层预览用） */
  suggestBackupFileName(): string {
    return backupFileName()
  }

  /**
   * 用主密码密钥封装任意字符串。
   *
   * 用途：那些不属于「连接/凭证」实体、但同样是机密的少量数据
   * （例如同步服务的访问令牌）。设置文档是无需解锁即可读的，
   * 令牌绝不能明文躺在里面。
   *
   * 未解锁时抛错 —— 调用方应把它当作「需要用户解锁」处理，而不是降级明文存储。
   */
  sealValue(plain: string): string {
    const key = this.vault.currentKey()
    if (!key) throw AppError.unauthorized('未解锁，无法加密数据')
    // 注意参数顺序：crypto 层的签名是 (key, plaintext)
    return encryptWithKey(key, plain)
  }

  /** 解开 sealValue 的结果；未解锁或密文损坏都抛错（不返回空串，避免静默失败） */
  openValue(sealed: string): string {
    const key = this.vault.currentKey()
    if (!key) throw AppError.unauthorized('未解锁，无法解密数据')
    if (!isCiphertext(sealed)) {
      throw AppError.badRequest('数据不是本机封装的密文')
    }
    return decryptWithKey(key, sealed)
  }

  /** 导出密钥：口令优先，否则用已解锁的主密码密钥；都没有则拒绝 */
  private resolveExportKey(passphrase?: string): Buffer | null {
    if (passphrase !== undefined) return null
    const key = this.vault.currentKey()
    if (!key) {
      throw AppError.unauthorized('未解锁且未提供备份口令，无法导出加密备份')
    }
    return key
  }

  close(): void {
    this.vault.lock()
    this.db.close()
  }
}

/**
 * 为「新主密码」一次派生出**密钥**与**校验记录**。
 *
 * 校验记录里已经保存了 salt 与派生结果，所以直接用 `verifyAndDerive` 复用同一次
 * scrypt 的产物即可——scrypt 是这里唯一的性能热点（约 30~60ms），绝不能算两遍。
 */
function deriveNewCredentials(password: string): { key: Buffer; verifier: string } {
  const verifier = createVerifier(password)
  const key = verifyAndDerive(password, verifier)
  if (!key) throw AppError.internal('主密码派生失败')
  return { key, verifier }
}

// ------------------------------------------------------------------ IPC 挂载

/**
 * 惰性单例：第一个请求到达时才建库。
 * 测试可通过 `setStoreService()` 注入内存实例。
 */
let service: StoreService | null = null

export function getStoreService(dbFile?: string): StoreService {
  if (!service) {
    service = new StoreService(dbFile ?? ':memory:')
  }
  return service
}

/** 测试 / 主进程启动时注入实例 */
export function setStoreService(instance: StoreService | null): void {
  service = instance
}

/**
 * 从 ctx.paths 惰性解析库文件。
 * 不在模块顶层 import paths.ts，避免单测（无 Electron）加载时炸掉。
 */
function ensureService(ctx: { paths: { dbFile: string } }): StoreService {
  if (!service) {
    service = new StoreService(ctx.paths.dbFile)
  }
  return service
}

/** 掩码常量导出，供渲染层判断 */
export const STORE_LOCKED_MASK = '__LOCKED__'
export { CIPHER_VERSION, isCiphertext, isLockedMask, decryptWithKey }

export const storeHandlers: Record<string, IpcHandler> = {
  // ------------------------------------------------------------- 连接
  listConnections: (_payload, ctx) => ensureService(ctx).listConnections(),

  getConnection: (payload, ctx) => {
    const { id } = parseInput(connectionIdSchema, payload)
    return ensureService(ctx).getConnection(id)
  },

  saveConnection: (payload, ctx) => {
    const input = parseInput(connectionInputSchema, payload) as unknown as Connection
    return ensureService(ctx).saveConnection(input)
  },

  deleteConnection: (payload, ctx) => {
    const { id } = parseInput(connectionIdSchema, payload)
    return ensureService(ctx).deleteConnection(id)
  },

  moveConnection: (payload, ctx) => {
    const { id, groupId } = parseInput(moveConnectionSchema, payload)
    return ensureService(ctx).moveConnection(id, groupId)
  },

  // ------------------------------------------------------------- 分组
  listGroups: (_payload, ctx) => ensureService(ctx).listGroupTree(),

  saveGroup: (payload, ctx) => {
    const input = parseInput(groupInputSchema, payload) as unknown as ConnectionGroup
    return ensureService(ctx).saveGroup(input)
  },

  deleteGroup: (payload, ctx) => {
    const { id, cascade } = parseInput(deleteGroupSchema, payload)
    return ensureService(ctx).deleteGroup(id, cascade ?? true)
  },

  // ------------------------------------------------------------- 凭证
  listCredentials: (_payload, ctx) => ensureService(ctx).listCredentials(),

  saveCredential: (payload, ctx) => {
    const input = parseInput(credentialInputSchema, payload) as unknown as Credential
    return ensureService(ctx).saveCredential(input)
  },

  // ------------------------------------------------------------- 备份
  exportBackup: (payload, ctx) => {
    const opts = parseInput(exportBackupSchema, payload ?? {})
    const svc = ensureService(ctx)
    // 落盘放在 service 层，backup.ts 保持纯函数（便于单测与同步模块复用）
    return svc.exportBackupToFile({
      ...(opts.passphrase === undefined ? {} : { passphrase: opts.passphrase }),
      ...(opts.dir === undefined ? {} : { dir: opts.dir }),
      ...(opts.filePath === undefined ? {} : { filePath: opts.filePath }),
      backupDir: ctx.paths.backupDir,
    })
  },

  importBackup: (payload, ctx) => {
    const opts = parseInput(importBackupSchema, payload)
    const svc = ensureService(ctx)
    return svc.importBackup(opts.data, {
      ...(opts.passphrase === undefined ? {} : { passphrase: opts.passphrase }),
      ...(opts.mode === undefined ? {} : { mode: opts.mode }),
    })
  },

  // ------------------------------------------------------------- 主密码
  setMasterPassword: (payload, ctx) => {
    const { oldPassword, newPassword } = parseInput(masterPasswordSchema, payload)
    return ensureService(ctx).setMasterPassword(newPassword, oldPassword)
  },

  unlock: (payload, ctx) => {
    const { password } = parseInput(unlockSchema, payload)
    const ok = ensureService(ctx).unlock(password)
    if (!ok) throw AppError.unauthorized('主密码不正确')
    return { unlocked: true }
  },

  lock: (_payload, ctx) => {
    ensureService(ctx).lock()
    return { unlocked: false }
  },

  isUnlocked: (_payload, ctx) => {
    const svc = ensureService(ctx)
    return { unlocked: svc.isUnlocked(), initialized: svc.isInitialized() }
  },

  // ------------------------------------------------------------- 搜索
  search: (payload, ctx) => {
    const { keyword, limit } = parseInput(searchSchema, payload)
    return ensureService(ctx).search(keyword, limit)
  },
}
