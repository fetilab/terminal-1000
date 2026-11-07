// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * sync 域：与自建后端的零知识同步。
 *
 * 数据流：
 *   本地 SQLite → store.renderBackup(主密码密钥) → 密文 → PUT 到后端
 *   后端 → 密文 → store.importBackup → 本地 SQLite
 *
 * **密钥永不出本机**：后端只看到密文。即使后端被完全攻破，
 * 攻击者拿到的也只是加密备份，与「备份文件被拿走」是同一等级的暴露。
 *
 * 令牌管理：访问令牌是机密，用主密码密钥封装后存进设置文档
 * （设置本身无需解锁即可读，所以绝不能明文存令牌）。
 */

import { z } from 'zod'
import { Events, type SyncSettings } from '@t1000/shared'
import { AppError, parseInput } from '../../errors'
import type { IpcContext, IpcHandler } from '../../ipc/router'
import { createLogger } from '../../logger'
import { getStoreService } from '../store'
import { getSettings, updateSettings } from '../settings'

const log = createLogger('sync')

/** 后端上的快照 blob 名 */
const SNAPSHOT_BLOB = 'snapshot'

/** 请求超时（同步可能传较大密文） */
const REQUEST_TIMEOUT_MS = 60_000

/** 同步状态（内存） */
interface SyncState {
  state: 'idle' | 'syncing' | 'offline' | 'error'
  lastSyncAt?: string
  lastError?: string
  /** 上次已知的服务端版本，用于乐观并发 */
  lastVersion?: number
}

const state: SyncState = { state: 'idle' }

// ── 配置读写 ─────────────────────────────────────────

function getSyncSettings(): SyncSettings {
  return getSettings().sync
}

function updateSyncSettings(patch: Partial<SyncSettings>): void {
  updateSettings({ sync: patch })
}

/** 令牌明文（仅内存中短暂存在） */
function readToken(): string | undefined {
  const sealed = getSyncSettings().token
  if (!sealed) return undefined
  try {
    return getStoreService().openValue(sealed)
  } catch (err) {
    // 未解锁或密文损坏：当作未登录，让用户重新登录
    log.warn('同步令牌无法解开（未解锁或已损坏）', err)
    return undefined
  }
}

function writeToken(token: string): void {
  updateSyncSettings({ token: getStoreService().sealValue(token) })
}

/** 同步口令（明文，仅内存中短暂存在） */
function readPassphrase(): string | undefined {
  const sealed = getSyncSettings().passphrase
  if (!sealed) return undefined
  try {
    return getStoreService().openValue(sealed)
  } catch (err) {
    log.warn('同步口令无法解开（未解锁或已损坏）', err)
    return undefined
  }
}

function writePassphrase(passphrase: string): void {
  updateSyncSettings({ passphrase: getStoreService().sealValue(passphrase) })
}

/**
 * 取用于加解密云端数据的同步口令。
 *
 * **绝不能用本机主密钥**：主密钥由每个库各自随机的 salt 派生，
 * A 机器加密的数据在 B 机器上用同一口令也解不开，多端同步会直接失效。
 * 同步必须走「口令 + 备份文件自带的 salt」这条路径 —— 同口令在任何设备都能解开。
 */
function requirePassphrase(): string {
  const pass = readPassphrase()
  if (!pass) {
    throw AppError.badRequest(
      '未设置同步口令：请在同步设置里设置「仓库密码」后再同步（新设备用同一口令即可解密云端数据）',
    )
  }
  return pass
}

function clearToken(): void {
  // 注意：不能传 undefined —— deepMerge 会忽略 undefined 键，等于没清。
  // 用空串表示"无令牌"（readToken 里 `if (!sealed)` 会当成未登录）。
  updateSyncSettings({ token: '' })
}

// ── HTTP ────────────────────────────────────────────

function endpoint(): string {
  const raw = getSyncSettings().endpoint
  if (!raw) throw AppError.badRequest('未配置同步服务地址')
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw AppError.badRequest(`同步服务地址不合法: ${raw}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw AppError.badRequest('同步服务地址必须是 http(s)')
  }
  // 去掉末尾斜杠，便于拼路径
  return url.toString().replace(/\/+$/, '')
}

interface HttpResult {
  status: number
  body: unknown
}

async function call(
  path: string,
  options: { method?: string; body?: unknown; token?: string } = {},
): Promise<HttpResult> {
  const url = `${endpoint()}${path}`
  const headers: Record<string, string> = {}
  if (options.token) headers['authorization'] = `Bearer ${options.token}`
  if (options.body !== undefined) headers['content-type'] = 'application/json'

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

  let res: Response
  try {
    res = await fetch(url, {
      method: options.method ?? 'GET',
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      signal: controller.signal,
    })
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    state.state = 'offline'
    throw AppError.internal(`无法连接同步服务: ${reason}`)
  } finally {
    clearTimeout(timer)
  }

  const text = await res.text()
  let body: unknown
  try {
    body = text ? JSON.parse(text) : undefined
  } catch {
    body = undefined
  }
  return { status: res.status, body }
}

/** 把后端的错误体转成 AppError，保留稳定错误码 */
function toAppError(result: HttpResult, fallback: string): AppError {
  const body = result.body as { error?: { code?: string; message?: string } } | undefined
  const code = body?.error?.code
  const message = body?.error?.message ?? fallback

  if (code === 'VERSION_CONFLICT') return AppError.conflict(message)
  if (code === 'INVALID_CREDENTIALS' || code === 'UNAUTHORIZED' || code === 'TOKEN_EXPIRED') {
    return AppError.unauthorized(message)
  }
  if (code === 'NOT_FOUND') return AppError.notFound(message)
  if (result.status === 409) return AppError.conflict(message)
  if (result.status === 401) return AppError.unauthorized(message)
  if (result.status === 400) return AppError.badRequest(message)
  return AppError.internal(message)
}

function emitState(ctx: IpcContext): void {
  ctx.emit(Events.SYNC_STATE, {
    state: state.state,
    ...(state.lastError ? { message: state.lastError } : {}),
  })
}

// ── 同步动作 ─────────────────────────────────────────

/**
 * 向服务端查询当前快照版本。
 *
 * 为什么必须在登录后做：`lastVersion` 是「本客户端已知的远端版本」，
 * 它和具体账号/端点绑定。若跨账号或跨端点复用旧值，
 * 乐观并发就会用错误的基版本提交 —— 轻则误报冲突，重则覆盖别人的数据。
 */
async function refreshRemoteVersion(token: string): Promise<number> {
  const result = await call('/api/v1/blobs', { token })
  if (result.status !== 200) return 0
  const body = result.body as { blobs?: Array<{ name: string; version: number }> }
  const snapshot = body.blobs?.find((b) => b.name === SNAPSHOT_BLOB)
  return snapshot?.version ?? 0
}

/** 上传本机快照（密文） */
async function pushSnapshot(ctx: IpcContext, options: { force?: boolean } = {}): Promise<{
  version: number
  bytes: number
  counts: Record<string, number>
}> {
  const token = readToken()
  if (!token) throw AppError.unauthorized('未登录同步服务')

  // 用**同步口令**加密整份快照（不是本机主密钥 —— 那样换设备就解不开了）。
  // 备份文件自带 salt，因此同口令在任何设备都能解开；后端始终拿不到明文。
  const { data, counts } = getStoreService().renderBackup(requirePassphrase())
  const ciphertext = data.toString('base64')

  state.state = 'syncing'
  emitState(ctx)

  const result = await call(`/api/v1/blobs/${SNAPSHOT_BLOB}`, {
    method: 'PUT',
    token,
    body: {
      ciphertext,
      // 乐观并发：基于已知版本提交；force 时不带 baseVersion（强制覆盖）
      ...(options.force ? {} : { baseVersion: state.lastVersion ?? 0 }),
    },
  })

  if (result.status !== 200) {
    state.state = 'error'
    const err = toAppError(result, '上传失败')
    state.lastError = err.message
    emitState(ctx)
    throw err
  }

  const body = result.body as { version: number }
  state.lastVersion = body.version
  state.state = 'idle'
  state.lastSyncAt = new Date().toISOString()
  state.lastError = undefined
  emitState(ctx)
  log.info(`已上传快照 version=${body.version} bytes=${data.byteLength}`)

  return { version: body.version, bytes: data.byteLength, counts }
}

/** 下载并应用远端快照 */
async function pullSnapshot(
  ctx: IpcContext,
  options: { mode?: 'replace' | 'merge' } = {},
): Promise<{ version: number; imported: unknown }> {
  const token = readToken()
  if (!token) throw AppError.unauthorized('未登录同步服务')

  state.state = 'syncing'
  emitState(ctx)

  const result = await call(`/api/v1/blobs/${SNAPSHOT_BLOB}`, { token })
  if (result.status === 404) {
    state.state = 'idle'
    emitState(ctx)
    throw AppError.notFound('远端还没有快照，请先上传一次')
  }
  if (result.status !== 200) {
    state.state = 'error'
    const err = toAppError(result, '下载失败')
    state.lastError = err.message
    emitState(ctx)
    throw err
  }

  const body = result.body as { version: number; ciphertext: string }
  const data = Buffer.from(body.ciphertext, 'base64')

  // 用同步口令解密并导入；解密失败说明口令不对（或数据被篡改）
  const imported = getStoreService().importBackup(data, {
    passphrase: requirePassphrase(),
    mode: options.mode ?? 'merge',
  })

  state.lastVersion = body.version
  state.state = 'idle'
  state.lastSyncAt = new Date().toISOString()
  state.lastError = undefined
  emitState(ctx)
  log.info(`已拉取快照 version=${body.version}`)

  return { version: body.version, imported }
}

// ── schema ──────────────────────────────────────────

const statusSchema = z.object({}).optional()

const loginSchema = z.object({
  endpoint: z.string().min(1),
  username: z.string().min(1),
  password: z.string().min(1),
  /** 没有账号时先注册 */
  register: z.boolean().optional(),
  /**
   * 同步口令（仓库密码）。与登录口令相互独立：
   * 新设备只要知道它就能解密云端数据。首次设置后本地加密保存，之后可不传。
   */
  passphrase: z.string().min(8).optional(),
})

// 注意：不要写成 .optional()。payload 缺失时用 `payload ?? {}` 兜底即可，
// 若 schema 本身可选，解析结果类型会带上 undefined，调用点就得多一层判空。
const pushSchema = z.object({ force: z.boolean().optional() })

const pullSchema = z.object({ mode: z.enum(['replace', 'merge']).optional() })

const resolveSchema = z.object({
  /** 冲突时保留哪一侧 */
  keep: z.enum(['local', 'remote']),
})

export const syncHandlers: Record<string, IpcHandler> = {
  status: (payload) => {
    parseInput(statusSchema, payload ?? {})
    const settings = getSyncSettings()
    return {
      enabled: settings.enabled,
      endpoint: settings.endpoint ?? '',
      autoSync: settings.autoSync,
      /** 只回是否已登录，不回令牌本身 */
      loggedIn: Boolean(settings.token),
      state: state.state,
      lastSyncAt: state.lastSyncAt ?? null,
      lastVersion: state.lastVersion ?? null,
      lastError: state.lastError ?? null,
      conflictPolicy: settings.conflictPolicy,
    }
  },

  /** 登录（或注册后登录），成功即保存令牌与地址 */
  login: async (payload) => {
    const input = parseInput(loginSchema, payload)

    // 先把 endpoint 落库，call() 依赖它
    updateSyncSettings({ endpoint: input.endpoint, enabled: true })

    const path = input.register ? '/api/v1/register' : '/api/v1/login'
    const result = await call(path, {
      method: 'POST',
      body: { username: input.username, password: input.password },
    })

    if (result.status !== 200) {
      throw toAppError(result, input.register ? '注册失败' : '登录失败')
    }

    const body = result.body as { token: string; username: string }
    writeToken(body.token)

    // 传了口令就更新本地保存的同步口令（首次设置或轮换时）
    if (input.passphrase) writePassphrase(input.passphrase)

    // 登录后立刻对齐远端版本认知（切换账号时尤其重要）
    state.lastVersion = await refreshRemoteVersion(body.token)
    state.lastError = undefined
    state.state = 'idle'

    log.info(`同步已登录: ${body.username}（远端快照版本 ${state.lastVersion}）`)
    return {
      username: body.username,
      endpoint: input.endpoint,
      remoteVersion: state.lastVersion,
      hasPassphrase: Boolean(readPassphrase()),
    }
  },

  logout: () => {
    const token = readToken()
    clearToken()
    state.lastVersion = undefined
    // 尽力通知后端失效令牌；失败不影响本地登出
    if (token) {
      void call('/api/v1/logout', { method: 'POST', token }).catch(() => {})
    }
    return { loggedOut: true }
  },

  push: (payload, ctx) => {
    const { force } = parseInput(pushSchema, payload ?? {})
    return pushSnapshot(ctx, force !== undefined ? { force } : {})
  },

  pull: (payload, ctx) => {
    const { mode } = parseInput(pullSchema, payload ?? {})
    return pullSnapshot(ctx, mode !== undefined ? { mode } : {})
  },

  /**
   * 冲突处置。
   * 本地保留 = 强制上传覆盖；远端优先 = 直接拉取覆盖本地。
   */
  resolveConflict: async (payload, ctx) => {
    const { keep } = parseInput(resolveSchema, payload)
    if (keep === 'local') {
      const r = await pushSnapshot(ctx, { force: true })
      return { resolved: 'local', version: r.version }
    }
    const r = await pullSnapshot(ctx, { mode: 'replace' })
    return { resolved: 'remote', version: r.version }
  },
}

/** 应用退出时不做特殊处理（无长连接、无后台定时器） */
export function shutdownSync(): void {
  state.state = 'idle'
}

/**
 * 测试用：重置内存同步状态。
 *
 * `state` 是模块级单例（生产下一个应用实例只有一份），
 * 测试里要模拟"另一个应用实例"时必须能把它清干净。
 */
export function _resetSyncStateForTests(): void {
  state.state = 'idle'
  state.lastVersion = undefined
  state.lastSyncAt = undefined
  state.lastError = undefined
}

/** 测试用：伪造"本客户端已知的远端版本"，用于构造过期客户端场景 */
export function _setLastVersionForTests(version: number | undefined): void {
  state.lastVersion = version
}
