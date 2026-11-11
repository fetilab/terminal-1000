// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * update 域：检查更新。
 *
 * ## 能力边界（写在最前面，因为它决定了实现范围）
 * spec 的更新一节标注为"**部分（依赖分发服务）**"。我们目前**没有分发服务**，
 * 所以这里**只做"检查"**：从可配置的更新源拉一份版本清单、与当前版本比较、
 * 有新版本就提示并给出下载地址。**不做自动下载/静默安装** ——
 * 那需要签名与分发通道，没有它而假装能装，比不做更糟。
 *
 * 因此本模块的诚实要求：
 * - 未配置更新源 → 明确返回"未配置"，**不假装检查过了**
 * - 网络失败 → 返回失败原因，**不静默当成"已是最新"**（那会让用户以为一切正常）
 *
 * ## 安全约束
 * - **只接受 https**（例外：loopback 上的 http，便于本地/内网自建更新源与测试）。
 *   更新检查会给出"下载并安装"的指引，明文通道等于把这条路径交给中间人。
 * - **不自动执行任何东西**：不下载、不写入、不启动。只返回信息 + 用系统浏览器打开链接。
 * - 限制响应体大小，避免恶意/异常的超大响应把内存吃满。
 */

import { app, shell } from 'electron'
import { z } from 'zod'
import { parseInput } from '../../errors'
import { createLogger } from '../../logger'
import { getSettings } from '../settings'
import type { IpcHandler } from '../../ipc/router'

const log = createLogger('update')

/** 响应体上限：更新清单是几百字节的 JSON，1MB 已是非常宽松的上限 */
const MAX_MANIFEST_BYTES = 1024 * 1024

/** 一次检查网络请求的超时 */
const FETCH_TIMEOUT_MS = 10_000

export type UpdateChannel = 'stable' | 'beta' | 'dev'

export interface UpdateCheckResult {
  /** 当前版本 */
  current: string
  /** 更新源里的版本（拿不到为 null） */
  latest: string | null
  hasUpdate: boolean
  channel: UpdateChannel
  notes?: string
  downloadUrl?: string
  publishedAt?: string
  /** 实际使用的更新源（未配置为 null） */
  source: string | null
  /** 没拿到结果时的原因（面向用户，可直接显示） */
  reason?: string
}

/**
 * 更新源地址。
 *
 * 优先取环境变量 `T1000_UPDATE_URL`（便于自建源与测试），否则未配置。
 * （没有默认值：我们还没有公开发布地址，**编一个假的默认源会让"检查更新"永远失败**，
 *   那比明确说"未配置"更让人困惑。）
 */
export function resolveUpdateSource(): string | null {
  const fromEnv = process.env.T1000_UPDATE_URL
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim()
  return null
}

/** 更新源必须是 https；仅 loopback 允许 http（本地/内网自建源与测试） */
export function isAllowedUpdateUrl(raw: string): { ok: boolean; reason?: string } {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return { ok: false, reason: '更新源不是合法 URL' }
  }
  if (url.protocol === 'https:') return { ok: true }
  if (url.protocol === 'http:') {
    const h = url.hostname
    const loopback = h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]'
    return loopback
      ? { ok: true }
      : { ok: false, reason: '更新源必须使用 https（明文通道会让更新路径暴露给中间人）' }
  }
  return { ok: false, reason: `不支持的协议：${url.protocol}` }
}

/**
 * 比较版本号。
 *
 * 只做**够用的**语义比较，不引依赖：
 * - 按 `.` 切分数字段逐个比
 * - **有预发布标记的版本小于同号的正式版**（`1.0.0-beta` < `1.0.0`）
 *
 * @returns a>b 返回正数，a<b 返回负数，相等返回 0
 */
export function compareVersions(a: string, b: string): number {
  const split = (v: string): { nums: number[]; pre: string | null } => {
    const [core, ...rest] = v.trim().replace(/^v/, '').split('-')
    const nums = (core ?? '').split('.').map((s) => {
      const n = Number.parseInt(s, 10)
      return Number.isFinite(n) ? n : 0
    })
    return { nums, pre: rest.length > 0 ? rest.join('-') : null }
  }
  const A = split(a)
  const B = split(b)
  const len = Math.max(A.nums.length, B.nums.length)
  for (let i = 0; i < len; i += 1) {
    const x = A.nums[i] ?? 0
    const y = B.nums[i] ?? 0
    if (x !== y) return x - y
  }
  // 数字段相同：有预发布标记的更小
  if (A.pre === null && B.pre === null) return 0
  if (A.pre === null) return 1
  if (B.pre === null) return -1
  return A.pre === B.pre ? 0 : A.pre > B.pre ? 1 : -1
}

const channelEntrySchema = z.object({
  version: z.string().min(1),
  notes: z.string().optional(),
  url: z.string().optional(),
  publishedAt: z.string().optional(),
})

/**
 * 解析更新清单。
 *
 * 支持两种常见形状，减少自建源的适配成本：
 * - `{ channels: { stable: {...}, beta: {...} } }`
 * - 扁平 `{ version, notes, url }`（视为当前通道）
 */
export function parseManifest(
  raw: unknown,
  channel: UpdateChannel,
): { version: string; notes?: string; url?: string; publishedAt?: string } | null {
  if (raw === null || typeof raw !== 'object') return null
  const obj = raw as Record<string, unknown>

  const channels = obj['channels']
  if (channels !== null && typeof channels === 'object') {
    const entry = (channels as Record<string, unknown>)[channel]
    const parsed = channelEntrySchema.safeParse(entry)
    if (!parsed.success) return null
    const out: { version: string; notes?: string; url?: string; publishedAt?: string } = {
      version: parsed.data.version,
    }
    if (parsed.data.notes !== undefined) out.notes = parsed.data.notes
    if (parsed.data.url !== undefined) out.url = parsed.data.url
    if (parsed.data.publishedAt !== undefined) out.publishedAt = parsed.data.publishedAt
    return out
  }

  const flat = channelEntrySchema.safeParse(obj)
  if (!flat.success) return null
  const out: { version: string; notes?: string; url?: string; publishedAt?: string } = {
    version: flat.data.version,
  }
  if (flat.data.notes !== undefined) out.notes = flat.data.notes
  if (flat.data.url !== undefined) out.url = flat.data.url
  if (flat.data.publishedAt !== undefined) out.publishedAt = flat.data.publishedAt
  return out
}

/** 最近一次检查结果（缓存给界面展示；不持久化，避免"上次检查"看起来像"刚刚检查"） */
let lastResult: UpdateCheckResult | null = null

export function getLastUpdateResult(): UpdateCheckResult | null {
  return lastResult
}

/**
 * 执行一次检查。
 *
 * @param channel 更新通道
 */
export async function checkForUpdate(channel: UpdateChannel): Promise<UpdateCheckResult> {
  const current = app.getVersion()
  const source = resolveUpdateSource()

  if (source === null) {
    const result: UpdateCheckResult = {
      current,
      latest: null,
      hasUpdate: false,
      channel,
      source: null,
      reason:
        '尚未配置更新源，无法检查更新（本项目开源后可由发行方或自建源提供；设置环境变量 T1000_UPDATE_URL 指向版本清单）',
    }
    lastResult = result
    return result
  }

  const allowed = isAllowedUpdateUrl(source)
  if (!allowed.ok) {
    const result: UpdateCheckResult = {
      current,
      latest: null,
      hasUpdate: false,
      channel,
      source,
      reason: `更新源不可用：${allowed.reason ?? '地址不合法'}`,
    }
    lastResult = result
    return result
  }

  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
    let res: Response
    try {
      res = await fetch(source, {
        signal: controller.signal,
        headers: { accept: 'application/json' },
        redirect: 'follow',
      })
    } finally {
      clearTimeout(timer)
    }

    if (!res.ok) {
      throw new Error(`更新源返回 HTTP ${res.status}`)
    }

    const text = await res.text()
    if (text.length > MAX_MANIFEST_BYTES) {
      throw new Error('更新清单异常大，已拒绝解析')
    }

    const entry = parseManifest(JSON.parse(text), channel)
    if (entry === null) {
      throw new Error('更新清单格式无法识别（需要 {channels:{...}} 或 {version,...}）')
    }

    // 更新源里的下载地址同样要过 https 检查：否则"检查"这一环是安全的，
    // "点下载"那一环却把用户送到明文地址 —— 等于白做。
    const safeUrl =
      entry.url !== undefined && isAllowedUpdateUrl(entry.url).ok ? entry.url : undefined

    const hasUpdate = compareVersions(entry.version, current) > 0
    const result: UpdateCheckResult = {
      current,
      latest: entry.version,
      hasUpdate,
      channel,
      source,
    }
    if (entry.notes !== undefined) result.notes = entry.notes
    if (safeUrl !== undefined) result.downloadUrl = safeUrl
    if (entry.publishedAt !== undefined) result.publishedAt = entry.publishedAt

    lastResult = result
    log.info(`检查更新完成：当前 ${current} / 最新 ${entry.version}（${channel}），有更新=${hasUpdate}`)
    return result
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const result: UpdateCheckResult = {
      current,
      latest: null,
      hasUpdate: false,
      channel,
      source,
      // 失败**不能**当成"已是最新"：那会让用户以为一切正常
      reason: `检查更新失败：${message}`,
    }
    lastResult = result
    log.warn('检查更新失败', err)
    return result
  }
}

/** 启动时按设置自动检查（有新版本时由界面提示；不发静默下载） */
export function scheduleStartupCheck(): void {
  setTimeout(() => {
    try {
      const settings = getSettings()
      if (settings.app?.autoCheckUpdate === false) return
      const channel = (settings.app?.updateChannel ?? 'stable') as UpdateChannel
      void checkForUpdate(channel)
    } catch (err) {
      log.warn('启动检查更新失败', err)
    }
  }, 8_000).unref?.()
}

// ── IPC ─────────────────────────────────────────────

const checkSchema = z.object({ channel: z.enum(['stable', 'beta', 'dev']).optional() })
const openSchema = z.object({ url: z.string().min(1) })

export const updateHandlers: Record<string, IpcHandler> = {
  /** 当前版本与上次检查结果（不发网络请求） */
  getInfo: () => {
    let channel: UpdateChannel = 'stable'
    try {
      channel = (getSettings().app?.updateChannel ?? 'stable') as UpdateChannel
    } catch {
      /* 设置读不到就用默认通道 */
    }
    return { current: app.getVersion(), channel, last: lastResult }
  },

  /** 主动检查更新（走网络） */
  check: async (payload) => {
    const { channel } = parseInput(checkSchema, payload ?? {})
    const effChannel =
      channel ??
      (() => {
        try {
          return (getSettings().app?.updateChannel ?? 'stable') as UpdateChannel
        } catch {
          return 'stable' as UpdateChannel
        }
      })()
    return checkForUpdate(effChannel)
  },

  /** 用系统浏览器打开下载页（**不自动下载/安装**） */
  openDownload: async (payload) => {
    const { url } = parseInput(openSchema, payload)
    const allowed = isAllowedUpdateUrl(url)
    if (!allowed.ok) throw new Error(allowed.reason ?? '地址不被允许')
    await shell.openExternal(url)
    return { opened: true }
  },
}
