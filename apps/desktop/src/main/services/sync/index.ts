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
import {
  ServerIdentityChangedError,
  UntrustedServerError,
  closeAllChannels,
  getChannel,
} from './channel-pool'
import { SecureChannel } from './channel'
import { fingerprintOf } from './protocol'
import type { IpcContext, IpcHandler } from '../../ipc/router'
import { createLogger } from '../../logger'
import { getStoreService, type StoreEntity } from '../store'
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

/**
 * 解析 TSC/1 的 host/port。
 *
 * 允许两种写法：`tsc1://host:port` 或 `http://host:port`（用户指着 TSC/1 端口）。
 * **不接受不带端口的写法** —— TSC/1 端口与 HTTP 端口是分开的（理由见规范 §7：
 * 8787 仅回环正是 HTTP 侧采信 XFF 的前提，而加密通道必须能公网直连）。
 */
function tsc1Target(): { host: string; port: number } {
  const raw = getSyncSettings().endpoint
  if (!raw) throw AppError.badRequest('未配置同步服务地址')
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw AppError.badRequest(`同步服务地址不合法: ${raw}`)
  }
  const port = url.port === '' ? 0 : Number(url.port)
  if (!Number.isInteger(port) || port <= 0) {
    throw AppError.badRequest(
      'TSC/1 需要显式端口（例如 tsc1://host:8788）—— 加密通道与 HTTP 端口是分开的',
    )
  }
  return { host: url.hostname, port }
}

/** 是否回环地址（明文 HTTP 只允许回环） */
function isLoopbackHost(host: string): boolean {
  return (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '::1' ||
    host === '[::1]' ||
    host.endsWith('.localhost')
  )
}

/**
 * 走 TSC/1 加密通道。
 *
 * 不退回 HTTP（规范 §3.3.1）。
 * 只要有 fallback，攻击者阻断握手即可降级成功，加密层就成了装饰。
 */
async function callOverTsc1(
  path: string,
  options: { method?: string; body?: unknown; token?: string },
  settings: SyncSettings,
): Promise<HttpResult> {
  const { host, port } = tsc1Target()
  let channel
  try {
    channel = await getChannel(host, port, settings.pin ?? undefined)
  } catch (err) {
    if (err instanceof UntrustedServerError) {
      // 未钉扎：把指纹交给用户核对（**不自动信任**）。
      // 用 detail 带出结构化的 code/fingerprint，界面据此弹"确认指纹"对话框。
      throw new AppError('UNAUTHORIZED', err.message, {
        code: err.code,
        fingerprint: err.fingerprint,
      })
    }
    if (err instanceof ServerIdentityChangedError) {
      throw new AppError('FORBIDDEN', err.message, {
        code: err.code,
        expected: err.expected,
        actual: err.actual,
      })
    }
    state.state = 'offline'
    throw AppError.internal(
      `无法建立加密同步通道（${host}:${port}）：${err instanceof Error ? err.message : String(err)}
` +
        '（不会退回明文 HTTP —— 见规范 §3.3.1）',
    )
  }
  const res = await channel.request(path, {
    method: options.method ?? 'GET',
    ...(options.body === undefined ? {} : { body: options.body }),
    ...(options.token === undefined ? {} : { token: options.token }),
  })
  return { status: res.status, body: res.body }
}

async function call(
  path: string,
  options: { method?: string; body?: unknown; token?: string } = {},
): Promise<HttpResult> {
  const settings = getSyncSettings()
  const transport = settings.transport ?? 'tsc1'

  if (transport === 'tsc1') {
    return callOverTsc1(path, options, settings)
  }

  // 明文 HTTP：**只允许回环**（规范 §3.3.1）。非回环直接拒绝并给迁移指引 ——
  // 这是"用户选择加密通道"的应有之义，不是可选项。
  const url = new URL(endpoint())
  if (!isLoopbackHost(url.hostname)) {
    throw new AppError(
      'FORBIDDEN',
      `拒绝以明文 HTTP 连接非回环地址 ${url.hostname}：登录口令与会话令牌会在公网裸奔。\n` +
        '请在「设置 → 同步」把传输方式改为 TSC/1（加密通道），并填好它的端口与服务端指纹。',
      { code: 'PLAINTEXT_NOT_ALLOWED' },
    )
  }

  const fullUrl = `${endpoint()}${path}`
  const headers: Record<string, string> = {}
  if (options.token) headers['authorization'] = `Bearer ${options.token}`
  if (options.body !== undefined) headers['content-type'] = 'application/json'

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

  let res: Response
  try {
    res = await fetch(fullUrl, {
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
  // 按设置里的同步范围过滤载荷。
  //
  // 此前这里是全库转储，`sync.scopes.*` 五项**全被忽略** —— 用户取消勾选
  // "同步凭证"也照样上传凭证，属于违背用户显式设置的数据外发。
  //
  // 未列入任何范围的实体（AI 对话、会话日志）**默认不同步**：
  // 设置里没有对应的开关，同步它们等于未经用户同意；且两者体积大、偏本地。
  const scopes = getSettings().sync?.scopes
  const entities: StoreEntity[] = []
  if (scopes?.connections !== false) entities.push('Server')
  if (scopes?.groups !== false) entities.push('Group')
  if (scopes?.credentials !== false) entities.push('Credential')
  if (scopes?.notes !== false) entities.push('Note', 'NoteFolder')
  if (scopes?.settings !== false) entities.push('Settings')

  if (entities.length === 0) {
    throw AppError.badRequest('同步范围全部关闭：请在同步设置里至少开启一项')
  }

  const { data, counts } = getStoreService().renderBackup(requirePassphrase(), entities)
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
  /** 设置传输方式；显式指定，不按探测回退（规范 §3.3.1） */
  setTransport: (payload) => {
    const { transport } = parseInput(
      z.object({ transport: z.enum(['http', 'tsc1']) }),
      payload,
    )
    updateSyncSettings({ transport })
    return { transport }
  },

  /**
   * 探测 TSC/1 服务端身份。
   *
   * 只做一次握手拿到指纹与公钥，**不发送任何应用数据**、也不写入钉扎 ——
   * 用户需要在另一条可信渠道（服务器本机日志）核对指纹后才调用 `trustServer`。
   */
  inspectServer: async () => {
    const { host, port } = tsc1Target()
    const probed = await SecureChannel.probe(host, port)
    return {
      fingerprint: probed.fingerprint,
      // 公钥回传是为了让界面能把它交给 trustServer；它本身不是秘密，
      // 但**指纹才是用户要核对的东西**
      publicKey: probed.publicKey.toString('base64'),
    }
  },

  /** 用户确认指纹一致后写入钉扎 */
  trustServer: (payload) => {
    const { fingerprint, publicKey } = parseInput(
      z.object({ fingerprint: z.string().min(1), publicKey: z.string().min(1) }),
      payload,
    )
    // 指纹与公钥必须来自同一次探测，否则钉扎后无法建立连接
    const expect = fingerprintOf(Buffer.from(publicKey, 'base64')).replace(/ /g, '')
    if (expect !== fingerprint.replace(/ /g, '')) {
      throw AppError.badRequest('指纹与公钥不匹配（两者必须来自同一次探测）')
    }
    updateSyncSettings({ pin: { fingerprint: expect, publicKey } })
    state.state = 'idle'
    return { pinned: true, fingerprint: expect }
  },

  /** 清除钉扎（服务端确实换了密钥时才用；之后会重新走首次连接流程） */
  forgetServer: () => {
    // 写 null 而非 undefined：设置深合并会跳过 undefined，旧钉扎会继续生效
    updateSyncSettings({ pin: null })
    closeAllChannels()
    return { pinned: false }
  },

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
      /**
       * 当前传输方式与钉扎状态；界面需展示，避免用户在未加密传输下同步。
       */
      transport: settings.transport ?? 'tsc1',
      pinned: settings.pin != null,
      /** 已钉扎的指纹（可展示给用户核对；它本身不是秘密） */
      pinnedFingerprint: settings.pin?.fingerprint ?? null,
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
