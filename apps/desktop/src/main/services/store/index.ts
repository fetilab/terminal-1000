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
import type { Connection, ConnectionGroup, Credential, WorkspaceLayout } from '@t1000/shared'
import { AppError } from '../../errors'
import type { IpcHandler } from '../../ipc/router'
import { StoreDb, type StoreEntity } from './db'
import { importLegacyReferenceStores } from './legacy-import'
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
import { createParseIo, defaultHome, defaultSshConfigPath } from './sshconfig-fs'
import {
  importOpenSshConfig,
  type ConflictPolicy,
  type OpenSshImportResult,
} from './sshconfig-service'

/** 主密码校验记录的 meta key */
const META_VERIFIER = 'master_password_verifier'

// ------------------------------------------------------------------ zod 校验

/**
 * 工作区布局的校验。
 *
 * 分屏树是**递归**的（左右分屏里还能上下分），所以用 `z.lazy`。
 * 深度限制交给 `splitNodeSchema` 自身递归时的 `depth` 参数 —— 不设限的话
 * 一份畸形（或恶意）的布局能把主进程的校验栈打爆。
 */
const MAX_SPLIT_DEPTH = 8

const layoutTabSchema = z.object({
  connectionId: z.string().min(1),
  title: z.string().optional(),
})

const makeSplitNodeSchema = (depth: number): z.ZodTypeAny =>
  z.lazy(() =>
    z.union([
      z.object({ kind: z.literal('leaf'), tabIndex: z.number().int().min(0) }),
      z.object({
        kind: z.literal('split'),
        direction: z.enum(['horizontal', 'vertical']),
        ratio: z.number().min(0).max(1),
        first: depth <= 0 ? z.never() : makeSplitNodeSchema(depth - 1),
        second: depth <= 0 ? z.never() : makeSplitNodeSchema(depth - 1),
      }),
    ]),
  )

const layoutSchema = z.object({
  id: z.string().min(1),
  connectionId: z.string().optional(),
  name: z.string().max(200).optional(),
  isTemplate: z.boolean(),
  tabs: z.array(layoutTabSchema).max(64),
  split: makeSplitNodeSchema(MAX_SPLIT_DEPTH).nullable().optional(),
  panels: z
    .object({
      left: z.boolean().optional(),
      right: z.boolean().optional(),
      bottom: z.boolean().optional(),
    })
    .optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

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
    /**
     * 主机与端口在**公共部分必须可选**。
     *
     * 原因：隧道连接（`TunnelConnection`）用的是 localHost/localPort/remoteHost/remotePort，
     * **契约里根本没有 host/port**。此前公共部分强制要求它们，
     * 导致隧道连接一律保存失败（报 `host: Required; port: Required`）。
     * 必需性改由下面的 superRefine 按 kind 分别判定。
     */
    host: z.string().min(1, '主机不能为空').max(255).optional(),
    port: z.number().int().min(1).max(65535).optional(),
    groupId: z.string().min(1).optional(),
    username: z.string().max(255).optional(),
    storeType: storeTypeSchema.optional(),
  })
  .passthrough()
  .superRefine((value, ctx) => {
    const requireField = (field: string, message: string): void => {
      const v = (value as Record<string, unknown>)[field]
      if (v === undefined || v === null || v === '') {
        ctx.addIssue({ code: 'custom', path: [field], message })
      }
    }

    if (value.kind === 'tunnel') {
      // 隧道不校验 host/port，但要保证真正决定行为的字段齐备：
      // 没有 serverId 就不知道该挂在哪个 SSH 连接上；两端端口缺失则转发规则无从建立
      requireField('serverId', '必须指定承载隧道的 SSH 连接')
      requireField('localHost', '本机监听地址不能为空')
      requireField('localPort', '本机监听端口不能为空')
      requireField('remoteHost', '远端地址不能为空')
      requireField('remotePort', '远端端口不能为空')
      return
    }

    // 其余协议（ssh / rdp / telnet / vnc）都以 host:port 为目标
    requireField('host', '主机不能为空')
    requireField('port', '端口不能为空')
  })

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

const importOpenSshSchema = z.object({
  /** 配置文件路径；省略则用 ~/.ssh/config */
  path: z.string().min(1).optional(),
  /** 只解析不写库（UI 预览用） */
  dryRun: z.boolean().optional(),
  /** 同名连接的处理方式 */
  conflictPolicy: z.enum(['skip', 'rename', 'overwrite']).optional(),
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

  /** 工作区布局（按连接独立；isTemplate 的用于跨连接复用） */
  listLayouts(): WorkspaceLayout[] {
    return this.repo.listLayouts()
  }

  saveLayout(input: WorkspaceLayout): WorkspaceLayout {
    if (!input.id) throw new Error('布局缺少 id')
    return this.repo.saveLayout(input, new Date().toISOString())
  }

  deleteLayout(id: string): boolean {
    return this.repo.deleteLayout(id)
  }

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

  // --------------------------------------------------- 导入 OpenSSH 配置

  /**
   * 解析 `~/.ssh/config` 并批量导入连接。
   *
   * 与 `importBackup` 是**两件事**：这里读的是用户既有的 OpenSSH 明文配置，
   * 产出的是普通连接（敏感字段仍然走 Repository 的加密路径落库）。
   *
   * @param params.path 默认 `~/.ssh/config`；不存在时报明确错误
   * @param params.dryRun true 时只解析不写库，供 UI 预览
   */
  importOpenSsh(params: {
    path?: string
    dryRun?: boolean
    conflictPolicy?: ConflictPolicy
    /** 测试用：注入 home 与 IO */
    home?: string
    io?: ReturnType<typeof createParseIo>
  } = {}): OpenSshImportResult & { missingKeys: string[] } {
    const home = params.home ?? defaultHome()
    const path = params.path ?? defaultSshConfigPath(home)
    const io = params.io ?? createParseIo(home)

    // 先确认入口文件可读。这里刻意**不重复读**（大配置读两遍没必要）：
    // 只判断可读性，真正内容由 parseSshConfig 内部读取。
    const resolvedPath = io.paths.resolve(path, home)
    const absolutePath = resolvedPath.startsWith('/') ? resolvedPath : path
    if (io.readFile(resolvedPath) === null) {
      // 目录存在但文件读不到 → 更像是权限问题；否则就是文件不存在
      const dirReadable = io.paths.isDirectory(io.paths.dirname(resolvedPath))
      throw AppError.notFound(
        dirReadable
          ? `未找到 ${absolutePath}（若文件确实存在，请检查读取权限）`
          : `未找到 ${absolutePath}`,
      )
    }

    const dryRun = params.dryRun ?? false

    // 写库前必须已解锁：锁定态下 Repository 的写路径会把"看起来像机密的字段"
    // 当作未修改而丢弃（那是为防止掩码覆盖密文的设计）。若在这里放行，
    // 导入进来的私钥会被**静默丢掉**，用户以为导入成功但密钥没了。
    // 所以宁可明确拒绝，也不能悄悄丢数据。
    if (!dryRun && !this.isUnlocked()) {
      throw AppError.unauthorized('导入 OpenSSH 配置需要先解锁（私钥需要加密存储）')
    }

    const result = importOpenSshConfig({
      path,
      dryRun,
      ...(params.conflictPolicy === undefined ? {} : { conflictPolicy: params.conflictPolicy }),
      io,
      sink: this.repo,
    })

    // 汇总"哪些条目缺私钥"，方便 UI 一次性提示，不让用户自己去翻 warnings
    const missingKeys = result.entries
      .filter((e) => e.warnings?.some((w) => w.includes('私钥不可读')))
      .map((e) => e.name)

    return { ...result, missingKeys }
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
  renderBackup(
    passphrase?: string,
    /**
     * 只导出这些实体（不传 = 全部）。
     *
     * 用于让**同步**尊重设置里的 `sync.scopes.*`：用户明确关掉"同步凭证"时，
     * 载荷里就不该出现凭证 —— 否则是违背用户显式设置的数据外发。
     */
    entities?: StoreEntity[],
  ): {
    data: Buffer
    fileName: string
    counts: Record<string, number>
  } {
    const key = this.resolveExportKey(passphrase)
    try {
      const { data, fileName, envelope } = exportBackup(this.db, {
        ...(passphrase === undefined ? {} : { passphrase }),
        ...(passphrase === undefined && key ? { key } : {}),
        ...(entities === undefined ? {} : { entities }),
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
function ensureService(ctx: { paths: { dbFile: string; userData?: string } }): StoreService {
  if (!service) {
    service = new StoreService(ctx.paths.dbFile)
    // 一次性导入原产品（xterminal）的历史数据。只在真实文件库上做，
    // 幂等由 meta 标记保证；任何异常都不能阻断启动。
    if (ctx.paths.dbFile !== ':memory:' && ctx.paths.userData) {
      try {
        const report = importLegacyReferenceStores(service.db, dirname(ctx.paths.userData))
        if (report) {
          const n = Object.entries(report.imported)
            .map(([k, v]) => `${k}:${v}`)
            .join(' ')
          if (n) console.info(`[store] 已从旧版数据导入：${n}（跳过 ${report.skipped}）`)
          for (const e of report.errors) console.warn(`[store] 旧数据导入告警：${e}`)
        }
      } catch (err) {
        console.warn('[store] 旧数据导入失败（不影响使用）：', err)
      }
    }
  }
  return service
}

/** 掩码常量导出，供渲染层判断 */
export const STORE_LOCKED_MASK = '__LOCKED__'
export { CIPHER_VERSION, isCiphertext, isLockedMask, decryptWithKey }

// 备份/同步需要按实体过滤载荷，因此把实体联合类型作为 store 域的公开类型导出
// （避免其它服务从 ./db 这种内部模块直接引，造成跨服务耦合）
export type { StoreEntity } from './db'

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
  listLayouts: (_payload, ctx) => ({ layouts: ensureService(ctx).listLayouts() }),

  saveLayout: (payload, ctx) => {
    const { layout } = parseInput(z.object({ layout: layoutSchema }), payload)
    return ensureService(ctx).saveLayout(layout)
  },

  deleteLayout: (payload, ctx) => {
    const { id } = parseInput(z.object({ id: z.string().min(1) }), payload)
    return { id, deleted: ensureService(ctx).deleteLayout(id) }
  },

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

  // --------------------------------------------- 导入 OpenSSH 配置（~/.ssh/config）
  importOpenSsh: (payload, ctx) => {
    const opts = parseInput(importOpenSshSchema, payload ?? {})
    return ensureService(ctx).importOpenSsh({
      ...(opts.path === undefined ? {} : { path: opts.path }),
      ...(opts.dryRun === undefined ? {} : { dryRun: opts.dryRun }),
      ...(opts.conflictPolicy === undefined ? {} : { conflictPolicy: opts.conflictPolicy }),
    })
  },
}
