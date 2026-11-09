// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * sessionlog 域：会话日志与录制。
 *
 * spec §5.7 的两种记录方式都在这里：
 * - **会话日志**：`.log` 纯文本输出（给人看、给 grep 用）
 *   + `.timing` JSONL 时间线（每行 `{t, n}`：距开始的毫秒偏移 + 本次写入的字符数）
 * - **会话录制**：`.rec`（JSONL：header + 带时间戳的输出增量帧），停止时可自动压成 `.rec.gz`
 *   供回放工具逐帧/拖拽/变速播放。**我们录的是输出流而不是屏幕快照**
 *   （主进程没有 VT 仿真器，渲染层有 xterm）—— 详见 recording.ts 开头的差异说明。
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
import {
  DEFAULT_RECORDING_SETTINGS,
  MAX_INTERVAL_MS,
  MIN_INTERVAL_MS,
  RecordingWriter,
  clampInterval,
  normalizeRecordingSettings,
  readRecordingLines,
  type RecordingSettings,
  type RecordingSummary,
} from './recording'
import { AppError, parseInput } from '../../errors'
import type { IpcContext, IpcHandler } from '../../ipc/router'
import { readRecordingSettings, updateRecordingSettings } from '../settings'
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
  /** 快照录制文件（未开启录制时为 ''） */
  recPath: string
  logStream: WriteStream
  timingStream: WriteStream
  /** 增量帧写入器（未开启录制时为 null） */
  writer: RecordingWriter | null
  intervalMs: number
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
  // ── 快照录制（.rec）的统计；未录制时缺省 ─────────────────────────────
  /** 快照帧数（帧 = 一个间隔内的输出增量） */
  frames?: number
  /** 因"内容与上一帧相同"而跳过的 tick 次数（增量效果的证据） */
  skippedTicks?: number
  /** 未压缩时 .rec 的字节数 */
  recBytes?: number
  /** 压缩后 .rec.gz 的字节数 */
  gzBytes?: number
  /** 是否已压缩（压缩后 .rec 被删除，只留 .rec.gz） */
  compressed?: boolean
  /** 快照间隔 */
  intervalMs?: number
}

export interface SessionLogServiceOptions {
  /**
   * 读当前录制设置（间隔 / 自动压缩 / 是否录制）。
   * 注入而不是直接 import settings：单测不需要拉进 store。
   */
  loadSettings?: () => RecordingSettings
  /** 注入时钟与定时器（测试可精确驱动"间隔到点"） */
  now?: () => number
  timer?: import('./recording').RecordingTimer
}

export class SessionLogService {
  private readonly recordings = new Map<string, Recording>()

  constructor(
    private readonly logDir: string,
    private readonly options: SessionLogServiceOptions = {},
  ) {
    if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true })
  }

  /** 当前生效的录制设置（外部输入一律过 normalize，间隔 <1s 会被抬到 1s） */
  recordingSettings(): RecordingSettings {
    return normalizeRecordingSettings(this.options.loadSettings?.() ?? DEFAULT_RECORDING_SETTINGS)
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
  start(
    sessionId: string,
    title?: string,
    startOptions: { cols?: number; rows?: number; snapshot?: boolean } = {},
  ): { logId: string; logPath: string; recPath?: string; frames?: number } {
    if (this.recordings.has(sessionId)) {
      throw AppError.conflict('该会话已在录制中')
    }

    const logId = `${timestamp()}-${safeFileSegment(title ?? sessionId, 'session')}-${sessionId.slice(0, 8)}`
    const logPath = join(this.logDir, `${logId}.log`)
    const timingPath = join(this.logDir, `${logId}.timing`)

    const settings = this.recordingSettings()
    // 「是否录制终端数据」= 是否产生快照；调用方也可按会话显式要求
    const wantSnapshot = settings.enabled || startOptions.snapshot === true
    const recPath = join(this.logDir, `${logId}.rec`)
    const startedAt = this.options.now?.() ?? Date.now()

    const recording: Recording = {
      logId,
      sessionId,
      title: title ?? sessionId,
      logPath,
      timingPath,
      recPath: wantSnapshot ? recPath : '',
      logStream: createWriteStream(logPath, { flags: 'a' }),
      timingStream: createWriteStream(timingPath, { flags: 'a' }),
      writer: null,
      intervalMs: settings.intervalMs,
      startedAt,
      bytes: 0,
      stopped: false,
      unsubscribe: () => {},
    }

    if (wantSnapshot) {
      const writer = new RecordingWriter({
        path: recPath,
        intervalMs: settings.intervalMs,
        header: {
          logId,
          sessionId,
          title: recording.title,
          startedAt: new Date(startedAt).toISOString(),
          ...(startOptions.cols === undefined ? {} : { cols: startOptions.cols }),
          ...(startOptions.rows === undefined ? {} : { rows: startOptions.rows }),
        },
        ...(this.options.now === undefined ? {} : { clock: this.options.now }),
        ...(this.options.timer === undefined ? {} : { timer: this.options.timer }),
        onError: (err) => {
          log.warn(`快照录制写入失败（停止录制）: ${err.message}`)
          this.stop(sessionId, `快照写入失败：${err.message}`)
        },
      })
      writer.start()
      recording.writer = writer
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

    log.info(
      `开始录制会话 ${sessionId} → ${basename(logPath)}${wantSnapshot ? `（快照，间隔 ${settings.intervalMs}ms）` : ''}`,
    )
    return wantSnapshot
      ? { logId, logPath, recPath, frames: 0 }
      : { logId, logPath }
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
    // 快照侧只做缓冲，按间隔合并成帧（空缓冲的 tick 会被跳过 → 增量）
    recording.writer?.push(chunk)
    // 时间线：偏移 + 本次字符数
    recording.timingStream.write(`${JSON.stringify({ t: Date.now() - recording.startedAt, n: chunk.length })}\n`)
  }

  /**
   * 停止录制（不传 sessionId 则停全部）。
   *
   * 保持**同步**契约（既有调用方如 ssh 断开时是 fire-and-forget）：
   * 文本日志与元信息立刻落盘；快照的补帧/压缩是异步的，由 `finalize()` 完成。
   * 需要拿到压缩结果时用 `stopAndFinalize()`。
   */
  stop(sessionId?: string, reason = '用户停止'): { stopped: string[] } {
    const pending = this.finalize(sessionId, reason)
    // 不等待，但要吞掉 rejection：没人 await 时不能让未处理异常冒出来
    pending.catch((err: unknown) => log.warn('录制收尾失败', err))
    return { stopped: this.lastStopped }
  }

  /** 停止并等待快照收尾（补最后一帧 + 可选压缩）完成 */
  async stopAndFinalize(
    sessionId?: string,
    reason = '用户停止',
  ): Promise<{ stopped: string[]; recordings: RecordingSummary[] }> {
    return this.finalize(sessionId, reason)
  }

  private lastStopped: string[] = []

  private async finalize(
    sessionId: string | undefined,
    reason: string,
  ): Promise<{ stopped: string[]; recordings: RecordingSummary[] }> {
    const targets = sessionId ? [sessionId] : [...this.recordings.keys()]
    const stopped: string[] = []
    const summaries: RecordingSummary[] = []
    const settings = this.recordingSettings()

    const pending: Array<Promise<void>> = []
    for (const id of targets) {
      const rec = this.recordings.get(id)
      if (!rec || rec.stopped) continue

      rec.stopped = true
      rec.unsubscribe()
      try {
        rec.logStream.end()
        rec.timingStream.end()
      } catch {
        /* 已关闭 */
      }

      const writer = rec.writer
      const meta: LogMeta = {
        logId: rec.logId,
        sessionId: rec.sessionId,
        title: rec.title,
        startedAt: new Date(rec.startedAt).toISOString(),
        stoppedAt: new Date().toISOString(),
        bytes: rec.bytes,
        stopReason: reason,
        ...(writer === null ? {} : { intervalMs: rec.intervalMs, ...writer.liveStats() }),
      }
      this.writeMeta(meta)

      if (writer !== null) {
        const done = writer
          .stop({ compress: settings.autoCompress })
          .then((summary) => {
            summaries.push(summary)
            this.writeMeta({
              ...meta,
              frames: summary.frames,
              skippedTicks: summary.skippedTicks,
              recBytes: summary.gzBytes === undefined ? summary.bytes : summary.bytes,
              ...(summary.gzBytes === undefined ? {} : { gzBytes: summary.gzBytes }),
              compressed: summary.compressed,
            })
            log.info(
              `快照收尾 ${rec.logId}：${summary.frames} 帧 / 跳过 ${summary.skippedTicks} 次` +
                ` / ${summary.bytes} 字节${summary.compressed ? ` → ${summary.gzBytes} 字节（gzip）` : ''}`,
            )
          })
          .catch((err: unknown) => {
            log.warn('快照收尾失败（保留 .rec）', err)
          })
        pending.push(done)
      }

      this.recordings.delete(id)
      stopped.push(rec.logId)
      log.info(`停止录制 ${rec.logId}（${reason}，${rec.bytes} 字节）`)
    }

    this.lastStopped = stopped
    await Promise.all(pending)
    return { stopped, recordings: summaries }
  }

  /** 会话断开时自动收尾（由 ssh 服务在会话关闭时调用） */
  stopBySession(sessionId: string): void {
    this.stop(sessionId, '会话已断开')
  }

  /** 正在录制的会话 */
  active(): Array<{
    sessionId: string
    logId: string
    title: string
    bytes: number
    startedAt: string
    /** 是否在录快照 */
    recording: boolean
    /** 已写出的快照帧数 */
    frames: number
    /** 因内容未变而跳过的 tick 数 */
    skippedTicks: number
  }> {
    return [...this.recordings.values()].map((r) => {
      const stats = r.writer?.liveStats()
      return {
        sessionId: r.sessionId,
        logId: r.logId,
        title: r.title,
        bytes: r.bytes,
        startedAt: new Date(r.startedAt).toISOString(),
        recording: r.writer !== null,
        frames: stats?.frames ?? 0,
        skippedTicks: stats?.skippedTicks ?? 0,
      }
    })
  }

  /** 列出已保存的日志（按开始时间倒序） */
  list(): Array<
    LogMeta & {
      sizeBytes: number
      hasTiming: boolean
      /** 是否存在快照（.rec 或 .rec.gz） */
      hasRecording: boolean
      /** 快照文件实际占用（压缩后取 .gz 大小） */
      recBytes: number
    }
  > {
    let files: string[] = []
    try {
      files = readdirSync(this.logDir)
    } catch {
      return []
    }

    const metas: Array<
      LogMeta & { sizeBytes: number; hasTiming: boolean; hasRecording: boolean; recBytes: number }
    > = []
    for (const f of files) {
      if (!f.endsWith('.meta.json')) continue
      try {
        const meta = JSON.parse(readFileSync(join(this.logDir, f), 'utf8')) as LogMeta
        const logFile = join(this.logDir, `${meta.logId}.log`)
        const timingFile = join(this.logDir, `${meta.logId}.timing`)
        const recFile = join(this.logDir, `${meta.logId}.rec`)
        const gzFile = join(this.logDir, `${meta.logId}.rec.gz`)
        const hasGz = existsSync(gzFile)
        const hasRec = existsSync(recFile)
        metas.push({
          ...meta,
          sizeBytes: existsSync(logFile) ? statSync(logFile).size : 0,
          hasTiming: existsSync(timingFile),
          hasRecording: hasRec || hasGz,
          recBytes: hasGz ? statSync(gzFile).size : hasRec ? statSync(recFile).size : 0,
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
  /**
   * 回放数据读取：按**时间区间**取快照帧（不把整场录制塞给渲染层）。
   *
   * - `fromMs` / `toMs`：相对录制开始的毫秒区间（闭开区间 [from, to)）
   * - `limit`：本次最多返回多少帧（默认 2000，上限 20000）；超出时 `hasMore=true`
   * - `totalMs`：整场录制的总时长（渲染层用它画进度条）
   *
   * 实现是流式扫一遍文件：内存只保留窗口内的帧（有 limit 上限），
   * 时间轴信息在全扫描中得到。`.rec` 与 `.rec.gz` 都能读。
   */
  async replay(
    logId: string,
    options: { fromMs?: number; toMs?: number; limit?: number } = {},
  ): Promise<{
    logId: string
    frames: Array<{ tMs: number; data: string }>
    fromMs: number
    toMs: number | null
    totalMs: number
    /** 窗口内（未截断前）共有多少帧 */
    frameCount: number
    /** 是否还有更多（limit 截断） */
    hasMore: boolean
    intervalMs: number
    cols?: number
    rows?: number
    /** 数据源是否为压缩文件 */
    compressed: boolean
    /** 文件路径（UI 上"打开所在目录"用） */
    path: string
  }> {
    const { filePath, compressed } = this.locateRecording(logId)
    const fromMs = Math.max(0, options.fromMs ?? 0)
    const toMs = options.toMs === undefined ? null : Math.max(0, options.toMs)
    const limit = Math.min(20000, Math.max(1, Math.trunc(options.limit ?? 2000)))

    const frames: Array<{ tMs: number; data: string }> = []
    let frameCount = 0
    let totalMs = 0
    let hasMore = false
    let header: { intervalMs: number; cols?: number; rows?: number } = { intervalMs: 0 }

    await readRecordingLines(
      filePath,
      (line) => {
        if (line.kind === 'header') {
          header = {
            intervalMs: line.header.intervalMs,
            ...(line.header.cols === undefined ? {} : { cols: line.header.cols }),
            ...(line.header.rows === undefined ? {} : { rows: line.header.rows }),
          }
          return
        }
        const { t, d } = line.frame
        if (t > totalMs) totalMs = t
        if (t < fromMs) return
        if (toMs !== null && t >= toMs) return
        frameCount += 1
        if (frames.length < limit) frames.push({ tMs: t, data: d })
        else hasMore = true
      },
      compressed,
    )

    return {
      logId,
      frames,
      fromMs,
      toMs,
      totalMs,
      frameCount,
      hasMore,
      intervalMs: header.intervalMs,
      ...(header.cols === undefined ? {} : { cols: header.cols }),
      ...(header.rows === undefined ? {} : { rows: header.rows }),
      compressed,
      path: filePath,
    }
  }

  /** 找到某场录制的快照文件（优先压缩版）；没有则报 NOT_FOUND */
  private locateRecording(logId: string): { filePath: string; compressed: boolean } {
    const gz = join(this.logDir, `${logId}.rec.gz`)
    if (existsSync(gz)) return { filePath: gz, compressed: true }
    const rec = join(this.logDir, `${logId}.rec`)
    if (existsSync(rec)) return { filePath: rec, compressed: false }
    throw AppError.notFound(`该录制没有快照数据: ${logId}`)
  }

  remove(logId: string): { deleted: boolean } {
    const files = [
      `${logId}.log`,
      `${logId}.timing`,
      `${logId}.rec`,
      `${logId}.rec.gz`,
      `${logId}.meta.json`,
    ]
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

/**
 * 从设置域读取录制设置（形状由本模块定义，见 recording.ts）。
 *
 * 为什么这样绕：`Settings` 的形状在 `packages/shared`（lead 维护），
 * 目前还没有录制分组。设置文档的深合并会**保留未知键**，所以先把
 * `sessionRecording` 存在同一个设置文档里；等 shared 加上这组后，
 * 只需把 loadSettings 换成读 `settings.sessionRecording` 即可，本模块不用改。
 */
function readRecordingSettingsFromSettings(): RecordingSettings {
  try {
    return normalizeRecordingSettings(readRecordingSettings())
  } catch {
    // 设置文档损坏/不可读时退回默认值：录制不能因此整个不可用
    return DEFAULT_RECORDING_SETTINGS
  }
}

/**
 * 写录制设置（间隔一律过 clamp：<1s 抬到 1s）。
 *
 * 注意生效范围：**对之后新开始的录制生效**；正在进行的录制保持开始时读到的间隔，
 * 避免帧节奏中途变化导致时间轴忽长忽短。
 */
function updateRecordingSettingsFromSettings(
  patch: Partial<RecordingSettings>,
): RecordingSettings {
  const next = normalizeRecordingSettings({ ...readRecordingSettings(), ...patch })
  updateRecordingSettings({ ...next })
  return next
}

/** 单例创建时挂一次"会话关闭"订阅（只挂一次，避免重复注册） */
let closedWired = false

export function getSessionLogService(logDir: string): SessionLogService {
  if (!service) {
    service = new SessionLogService(logDir, {
      // 录制设置存在设置域文档里（`sessionRecording` 分组）。
      // 延迟到调用时读取，避免模块加载期就去碰 store。
      loadSettings: () => readRecordingSettingsFromSettings(),
    })
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
  cols: z.number().int().min(1).max(10000).optional(),
  rows: z.number().int().min(1).max(10000).optional(),
  /** 显式要求录制快照（即使设置里"是否录制"为关） */
  snapshot: z.boolean().optional(),
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

const replaySchema = z.object({
  logId: z.string().min(1),
  fromMs: z.number().int().min(0).optional(),
  toMs: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).max(20000).optional(),
})

const recordingSettingsSchema = z.object({
  /** 是否录制终端数据 */
  enabled: z.boolean().optional(),
  /** 快照间隔（毫秒）；<1000 会被抬到 1000 */
  intervalMs: z.number().int().optional(),
  /** 停止录制时自动压缩 */
  autoCompress: z.boolean().optional(),
})

export const sessionlogHandlers: Record<string, IpcHandler> = {
  start: (payload, ctx: IpcContext) => {
    const { sessionId, title, cols, rows, snapshot } = parseInput(startSchema, payload)
    return getSessionLogService(ctx.paths.sessionLogDir).start(sessionId, title, {
      ...(cols === undefined ? {} : { cols }),
      ...(rows === undefined ? {} : { rows }),
      ...(snapshot === undefined ? {} : { snapshot }),
    })
  },

  /** 停止并**等待**快照收尾（补帧 + 可选压缩）完成，返回每场录制的汇总 */
  stop: async (payload, ctx: IpcContext) => {
    const { sessionId } = parseInput(stopSchema, payload ?? {})
    return getSessionLogService(ctx.paths.sessionLogDir).stopAndFinalize(sessionId)
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

  /**
   * 回放：按时间区间取快照帧（播放/暂停/拖拽/逐帧/变速都由渲染层实现，
   * 主进程只负责"给我某个时间区间的帧"）。
   */
  replay: (payload, ctx: IpcContext) => {
    const { logId, fromMs, toMs, limit } = parseInput(replaySchema, payload)
    return getSessionLogService(ctx.paths.sessionLogDir).replay(logId, {
      ...(fromMs === undefined ? {} : { fromMs }),
      ...(toMs === undefined ? {} : { toMs }),
      ...(limit === undefined ? {} : { limit }),
    })
  },

  /** 读录制设置（间隔下限、自动压缩、是否录制） */
  getSettings: (_payload, ctx: IpcContext) => {
    return getSessionLogService(ctx.paths.sessionLogDir).recordingSettings()
  },

  /** 改录制设置（间隔 <1000ms 会被抬到 1000ms） */
  setSettings: (payload, ctx: IpcContext) => {
    const patch = parseInput(recordingSettingsSchema, payload ?? {})
    return updateRecordingSettingsFromSettings(patch)
  },
}
