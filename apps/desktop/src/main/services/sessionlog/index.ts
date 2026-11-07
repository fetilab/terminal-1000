// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * sessionlog 域：会话日志与录制。
 *
 * 两种产物：
 * - `.log`    纯文本输出（给人看、给 grep 用）
 * - `.timing` JSONL 时间线（每行 `{t, n}`：距开始的毫秒偏移 + 本次写入的字符数），
 *             用于按原始节奏回放（对齐 asciinema 的思路，但格式自定）
 *
 * 设计要点：
 * - 走 `subscribeSessionData`（中立契约）而不是监听渲染层的 SSH_DATA ——
 *   录制不应依赖界面是否在订阅，界面关掉也要能继续记
 * - 用写入流而非同步写：终端高吞吐时同步写会卡住会话
 * - **有大小上限**：日志无限增长会吃满磁盘，到上限就停止并给出明确原因
 * - 日志必然可能含敏感信息（命令里的密码、token），在 UI 上必须提示
 */

import {
  closeSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
  unlinkSync,
  writeFileSync,
  type WriteStream,
} from 'node:fs'
import { basename, join } from 'node:path'
import { z } from 'zod'
import { AppError, parseInput } from '../../errors'
import type { IpcContext, IpcHandler } from '../../ipc/router'
import { createLogger } from '../../logger'
import { subscribeSessionClosed, subscribeSessionData } from '../session-registry'

const log = createLogger('sessionlog')

/** 单个日志文件上限（默认 64MB，可用环境变量覆盖） */
function maxLogBytes(): number {
  const raw = process.env.T1000_MAX_SESSIONLOG_BYTES
  const n = raw ? Number(raw) : 64 * 1024 * 1024
  return Number.isFinite(n) && n > 0 ? n : 64 * 1024 * 1024
}

/** 读取时的默认分块（避免一次把几十 MB 塞给渲染层） */
const DEFAULT_READ_LIMIT = 256 * 1024

/** 一次录制 */
interface Recording {
  logId: string
  sessionId: string
  title: string
  logPath: string
  timingPath: string
  logStream: WriteStream
  timingStream: WriteStream
  startedAt: number
  bytes: number
  /** 达到上限或出错后停止写入 */
  stopped: boolean
  unsubscribe: () => void
}

/** 文件名里不允许出现路径分隔符与控制字符 */
function safeFileSegment(raw: string, fallback: string): string {
  const cleaned = raw
    .replace(/[/\\:*?"<>|\u0000-\u001f]/g, '_')
    // 折叠连续点：`..` 作为文件名本身不构成穿越（分隔符已替换），
    // 但带 `..` 的文件名极易被误读为路径，且某些解压/同步工具会特殊处理
    .replace(/\.{2,}/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 60)
    .trim()
  return cleaned.length > 0 ? cleaned : fallback
}

function timestamp(d = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/** 元信息文件（与日志同目录，`.meta.json`），列表据此展示而不是靠猜文件名 */
interface LogMeta {
  logId: string
  sessionId: string
  title: string
  startedAt: string
  stoppedAt?: string
  bytes: number
  /** 停止原因：正常停止 / 达到上限 / 会话断开 */
  stopReason?: string
}

export class SessionLogService {
  private readonly recordings = new Map<string, Recording>()

  constructor(private readonly logDir: string) {
    if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true })
  }

  private metaPath(logId: string): string {
    return join(this.logDir, `${logId}.meta.json`)
  }

  private writeMeta(meta: LogMeta): void {
    try {
      writeFileSync(this.metaPath(meta.logId), JSON.stringify(meta, null, 2))
    } catch (err) {
      log.warn('写入日志元信息失败', err)
    }
  }

  /**
   * 开始录制。
   * @returns logId（供 stop / read / delete 使用）
   */
  start(sessionId: string, title?: string): { logId: string; logPath: string } {
    if (this.recordings.has(sessionId)) {
      throw AppError.conflict('该会话已在录制中')
    }

    const logId = `${timestamp()}-${safeFileSegment(title ?? sessionId, 'session')}-${sessionId.slice(0, 8)}`
    const logPath = join(this.logDir, `${logId}.log`)
    const timingPath = join(this.logDir, `${logId}.timing`)

    const startedAt = Date.now()
    const recording: Recording = {
      logId,
      sessionId,
      title: title ?? sessionId,
      logPath,
      timingPath,
      logStream: createWriteStream(logPath, { flags: 'a' }),
      timingStream: createWriteStream(timingPath, { flags: 'a' }),
      startedAt,
      bytes: 0,
      stopped: false,
      unsubscribe: () => {},
    }

    // 必须挂 error 处理：磁盘满、目录被删、权限被撤销都会让写流出错，
    // 而**未处理的 stream error 会升级成未捕获异常**，可能直接崩掉主进程。
    const onStreamError = (err: Error): void => {
      if (recording.stopped) return
      log.warn(`录制写入失败（停止录制）: ${err.message}`)
      this.stop(sessionId, `写入失败：${err.message}`)
    }
    recording.logStream.on('error', onStreamError)
    recording.timingStream.on('error', onStreamError)

    recording.unsubscribe = subscribeSessionData(sessionId, (chunk) => {
      this.append(recording, chunk)
    })

    this.recordings.set(sessionId, recording)
    this.writeMeta({
      logId,
      sessionId,
      title: recording.title,
      startedAt: new Date(startedAt).toISOString(),
      bytes: 0,
    })

    log.info(`开始录制会话 ${sessionId} → ${basename(logPath)}`)
    return { logId, logPath }
  }

  /** 追加一段输出（含上限保护） */
  private append(recording: Recording, chunk: string): void {
    if (recording.stopped || chunk.length === 0) return

    const limit = maxLogBytes()
    if (recording.bytes + chunk.length > limit) {
      // 不截断当前块（截断会产生半行，回放时更容易误导），直接停止并说明原因
      this.stop(recording.sessionId, `已达大小上限 ${Math.round(limit / 1024 / 1024)}MB，自动停止`)
      return
    }

    recording.bytes += chunk.length
    recording.logStream.write(chunk)
    // 时间线：偏移 + 本次字符数
    recording.timingStream.write(`${JSON.stringify({ t: Date.now() - recording.startedAt, n: chunk.length })}\n`)
  }

  /** 停止录制（不传 sessionId 则停全部） */
  stop(sessionId?: string, reason = '用户停止'): { stopped: string[] } {
    const targets = sessionId ? [sessionId] : [...this.recordings.keys()]
    const stopped: string[] = []

    for (const id of targets) {
      const rec = this.recordings.get(id)
      if (!rec) continue

      rec.stopped = true
      rec.unsubscribe()
      try {
        rec.logStream.end()
        rec.timingStream.end()
      } catch {
        /* 已关闭 */
      }

      this.writeMeta({
        logId: rec.logId,
        sessionId: rec.sessionId,
        title: rec.title,
        startedAt: new Date(rec.startedAt).toISOString(),
        stoppedAt: new Date().toISOString(),
        bytes: rec.bytes,
        stopReason: reason,
      })

      this.recordings.delete(id)
      stopped.push(rec.logId)
      log.info(`停止录制 ${rec.logId}（${reason}，${rec.bytes} 字节）`)
    }

    return { stopped }
  }

  /** 会话断开时自动收尾（由 ssh 服务在会话关闭时调用） */
  stopBySession(sessionId: string): void {
    this.stop(sessionId, '会话已断开')
  }

  /** 正在录制的会话 */
  active(): Array<{ sessionId: string; logId: string; title: string; bytes: number; startedAt: string }> {
    return [...this.recordings.values()].map((r) => ({
      sessionId: r.sessionId,
      logId: r.logId,
      title: r.title,
      bytes: r.bytes,
      startedAt: new Date(r.startedAt).toISOString(),
    }))
  }

  /** 列出已保存的日志（按开始时间倒序） */
  list(): Array<LogMeta & { sizeBytes: number; hasTiming: boolean }> {
    let files: string[] = []
    try {
      files = readdirSync(this.logDir)
    } catch {
      return []
    }

    const metas: Array<LogMeta & { sizeBytes: number; hasTiming: boolean }> = []
    for (const f of files) {
      if (!f.endsWith('.meta.json')) continue
      try {
        const meta = JSON.parse(readFileSync(join(this.logDir, f), 'utf8')) as LogMeta
        const logFile = join(this.logDir, `${meta.logId}.log`)
        const timingFile = join(this.logDir, `${meta.logId}.timing`)
        metas.push({
          ...meta,
          sizeBytes: existsSync(logFile) ? statSync(logFile).size : 0,
          hasTiming: existsSync(timingFile),
        })
      } catch {
        /* 跳过损坏的元信息 */
      }
    }
    return metas.sort((a, b) => b.startedAt.localeCompare(a.startedAt))
  }

  /**
   * 读取日志内容。
   * 默认从**末尾**往回读（终端场景通常关心最近发生了什么），
   * 并限制单次返回量，避免把几十 MB 一次性推给渲染层。
   */
  read(logId: string, options: { offset?: number; limit?: number; fromEnd?: boolean } = {}): {
    logId: string
    content: string
    offset: number
    totalBytes: number
    /** 本次窗口之前还有内容（可向上翻） */
    hasMoreBefore: boolean
    /** 本次窗口之后还有内容（可向下翻） */
    hasMoreAfter: boolean
    /** 任一方向还有内容 —— 便于"是否还有更多"这类简化判断 */
    hasMore: boolean
  } {
    const logPath = join(this.logDir, `${safeFileSegment(logId, '')}.log`)
    // logId 里已含时间戳与短 id，safeFileSegment 可能改动它；这里直接用原值并做严格校验
    const exact = join(this.logDir, `${logId}.log`)
    const target = existsSync(exact) ? exact : logPath
    if (!existsSync(target)) throw AppError.notFound(`日志不存在: ${logId}`)

    const totalBytes = statSync(target).size
    const limit = options.limit ?? DEFAULT_READ_LIMIT
    const fromEnd = options.fromEnd ?? true

    let start: number
    if (fromEnd) {
      const tailStart = Math.max(0, totalBytes - limit)
      start = options.offset !== undefined ? Math.max(0, Math.min(options.offset, totalBytes)) : tailStart
    } else {
      start = Math.max(0, options.offset ?? 0)
    }
    const end = Math.min(totalBytes, start + limit)

    const fd = openSync(target, 'r')
    try {
      const buf = Buffer.alloc(end - start)
      readSync(fd, buf, 0, buf.length, start)
      // 两个方向分开报：从尾部读时"还有更多"指的是**前面**还有内容，
      // 只给一个 hasMore 会让调用方无法决定该往上还是往下翻页。
      const hasMoreBefore = start > 0
      const hasMoreAfter = end < totalBytes
      return {
        logId,
        content: buf.toString('utf8'),
        offset: start,
        totalBytes,
        hasMoreBefore,
        hasMoreAfter,
        hasMore: hasMoreBefore || hasMoreAfter,
      }
    } finally {
      closeSync(fd)
    }
  }

  /** 删除日志（连同时间线与元信息） */
  remove(logId: string): { deleted: boolean } {
    const files = [`${logId}.log`, `${logId}.timing`, `${logId}.meta.json`]
    let deleted = false
    for (const f of files) {
      const p = join(this.logDir, f)
      if (existsSync(p)) {
        try {
          unlinkSync(p)
          deleted = true
        } catch (err) {
          log.warn(`删除失败 ${p}`, err)
        }
      }
    }
    if (!deleted) throw AppError.notFound(`日志不存在: ${logId}`)
    return { deleted: true }
  }
}

// ── 单例与 IPC ───────────────────────────────────────

let service: SessionLogService | null = null

/** 单例创建时挂一次"会话关闭"订阅（只挂一次，避免重复注册） */
let closedWired = false

export function getSessionLogService(logDir: string): SessionLogService {
  if (!service) {
    service = new SessionLogService(logDir)
    if (!closedWired) {
      // 走中立契约订阅：不依赖 ssh 服务反过来调用我们。
      // 会话断开后必须收尾，否则写入流会一直挂着（句柄泄漏）。
      subscribeSessionClosed((sessionId) => {
        service?.stopBySession(sessionId)
      })
      closedWired = true
    }
  }
  return service
}

/** 测试用 */
export function _setSessionLogService(next: SessionLogService | null): void {
  service = next
}

const startSchema = z.object({
  sessionId: z.string().min(1),
  title: z.string().max(200).optional(),
})

// 不要写成 .optional()：schema 可选会让解析结果带上 undefined，调用点还得判空
const stopSchema = z.object({ sessionId: z.string().min(1).optional() })

const listSchema = z.object({})

const readSchema = z.object({
  logId: z.string().min(1),
  offset: z.number().int().min(0).optional(),
  limit: z.number().int().positive().max(16 * 1024 * 1024).optional(),
  fromEnd: z.boolean().optional(),
})

const deleteSchema = z.object({ logId: z.string().min(1) })

export const sessionlogHandlers: Record<string, IpcHandler> = {
  start: (payload, ctx: IpcContext) => {
    const { sessionId, title } = parseInput(startSchema, payload)
    return getSessionLogService(ctx.paths.sessionLogDir).start(sessionId, title)
  },

  stop: (payload, ctx: IpcContext) => {
    const { sessionId } = parseInput(stopSchema, payload ?? {})
    return getSessionLogService(ctx.paths.sessionLogDir).stop(sessionId)
  },

  /** 列出已保存日志 + 正在录制的会话 */
  list: (payload, ctx: IpcContext) => {
    parseInput(listSchema, payload ?? {})
    const svc = getSessionLogService(ctx.paths.sessionLogDir)
    return { logs: svc.list(), active: svc.active() }
  },

  read: (payload, ctx: IpcContext) => {
    const { logId, offset, limit, fromEnd } = parseInput(readSchema, payload)
    return getSessionLogService(ctx.paths.sessionLogDir).read(logId, {
      ...(offset !== undefined ? { offset } : {}),
      ...(limit !== undefined ? { limit } : {}),
      ...(fromEnd !== undefined ? { fromEnd } : {}),
    })
  },

  delete: (payload, ctx: IpcContext) => {
    const { logId } = parseInput(deleteSchema, payload)
    return getSessionLogService(ctx.paths.sessionLogDir).remove(logId)
  },
}
