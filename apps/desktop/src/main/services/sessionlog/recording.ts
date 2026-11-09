// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 会话「录制」的快照帧与增量写入（spec §5.7 的后一半：可视化快照 / 回放）。
 *
 * ## 关键设计：我们录的是「带时间戳的输出流」，不是屏幕位图
 *
 * spec 字面写的是"录制终端**可视化快照**"。但**主进程没有终端仿真器**，
 * 拿不到"屏幕内容"这种状态（要拿到就得在 main 里实现一整套 VT 解析 + 屏幕缓冲，
 * 而渲染层已经有 xterm 了 —— 重复实现一份既昂贵又会与 xterm 的行为漂移）。
 *
 * 所以这里录 **带时间戳的原始输出流**（asciinema 的思路），回放时交给渲染层的
 * xterm 重放：把某个时间点之前的输出喂进去，就得到那一刻的屏幕。
 *
 * 与 spec 的**差异**（明确写出来，不含糊）：
 * - 存的是「输出流 + 时间戳」，不是「每帧的屏幕快照」；
 * - 因此帧里没有光标位置/颜色状态这类"屏幕态"，屏幕由 xterm 重放得到；
 * - 若将来 xterm 的 VT 实现变化，历史录制的**画面**可能随之变化（快照不会）。
 * 为什么这样更好：
 * - 体积小得多（只存输出增量 + gzip；屏幕快照每帧都要存整个屏幕）
 * - 逐帧 / 拖拽 / 变速**全都能实现**：帧带时间戳，渲染层按 t 重放到任意位置
 * - 不需要主进程实现 VT 仿真（少一份必然与 xterm 漂移的实现）
 * - 顺带能当"可 grep 的文本流"用（与 .log 同源）
 *
 * ## 增量（这是体积能降下来的原因）
 * 输出先缓冲，按间隔（默认 5s，最小 1s）合并成一帧；
 * **缓冲为空 → 不写帧**（内容与上一帧相同就跳过），计数在 `skippedTicks` 里，
 * 测试用计数断言固化这一点，而不是只看文件存在。
 */

import { createWriteStream, createReadStream } from 'node:fs'
import { stat, unlink } from 'node:fs/promises'
import { createGunzip, createGzip } from 'node:zlib'
import { pipeline } from 'node:stream/promises'

// ---------------------------------------------------------------------------
// 设置
// ---------------------------------------------------------------------------

export interface RecordingSettings {
  /** 是否录制终端数据（关掉就不产生 .rec / .rec.gz） */
  enabled: boolean
  /** 快照间隔（毫秒）。**最小 1000**（spec：默认 5 秒、最小 1 秒） */
  intervalMs: number
  /** 结束录制时自动压缩成 .rec.gz（spec：自动压缩可减少 60-80%） */
  autoCompress: boolean
}

/** spec 规定的最小间隔：1 秒 */
export const MIN_INTERVAL_MS = 1000
/** 上限（1 小时）——防止配置成"几乎不写帧"的荒谬值 */
export const MAX_INTERVAL_MS = 60 * 60 * 1000

/**
 * 默认设置。
 * `enabled` 默认 **false**：录制产物会包含终端里的敏感信息（口令、token），
 * 必须由用户显式开启，不能默认替用户落盘。
 */
export const DEFAULT_RECORDING_SETTINGS: RecordingSettings = {
  enabled: false,
  intervalMs: 5000,
  autoCompress: true,
}

/** 把任意外部输入规整成合法设置（间隔夹到 1s..1h；非法字段用默认值） */
export function normalizeRecordingSettings(
  patch: unknown,
  base: RecordingSettings = DEFAULT_RECORDING_SETTINGS,
): RecordingSettings {
  const out: RecordingSettings = { ...base }
  if (patch === null || typeof patch !== 'object') return out
  const raw = patch as Record<string, unknown>

  if (typeof raw['enabled'] === 'boolean') out.enabled = raw['enabled']
  if (typeof raw['autoCompress'] === 'boolean') out.autoCompress = raw['autoCompress']
  if (raw['intervalMs'] !== undefined) out.intervalMs = clampInterval(raw['intervalMs'])

  return out
}

/** 间隔钳制：<1s 抬到 1s（而不是报错拒绝，避免设置页存进一个不可用值） */
export function clampInterval(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return DEFAULT_RECORDING_SETTINGS.intervalMs
  return Math.min(MAX_INTERVAL_MS, Math.max(MIN_INTERVAL_MS, Math.trunc(n)))
}

// ---------------------------------------------------------------------------
// 帧格式（JSONL：第 1 行 header，其后每行一帧）
// ---------------------------------------------------------------------------

export const RECORDING_FORMAT_VERSION = 1

export interface RecordingHeader {
  v: number
  kind: 'session-recording'
  logId: string
  sessionId: string
  title: string
  /** ISO8601 */
  startedAt: string
  /** 合并间隔（回放工具可据此提示粒度） */
  intervalMs: number
  /** 终端尺寸（渲染层重放时先 resize 到它；调用方知道，主进程不猜） */
  cols?: number
  rows?: number
}

/** 一帧：`t` = 距开始的毫秒偏移，`d` = 这一段时间内产生的输出（增量） */
export interface RecordingFrame {
  t: number
  d: string
}

export type RecordingLine =
  | { kind: 'header'; header: RecordingHeader }
  | { kind: 'frame'; frame: RecordingFrame }

export function encodeHeader(header: RecordingHeader): string {
  return `${JSON.stringify(header)}\n`
}

export function encodeFrame(frame: RecordingFrame): string {
  return `${JSON.stringify({ t: frame.t, d: frame.d })}\n`
}

/** 解析一行；无法识别（含截断的最后一行）返回 null，由调用方跳过 */
export function parseRecordingLine(line: string): RecordingLine | null {
  const trimmed = line.trim()
  if (trimmed.length === 0) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const obj = parsed as Record<string, unknown>

  if (obj['kind'] === 'session-recording') {
    if (typeof obj['logId'] !== 'string' || typeof obj['sessionId'] !== 'string') return null
    const header: RecordingHeader = {
      v: typeof obj['v'] === 'number' ? obj['v'] : RECORDING_FORMAT_VERSION,
      kind: 'session-recording',
      logId: obj['logId'],
      sessionId: obj['sessionId'],
      title: typeof obj['title'] === 'string' ? obj['title'] : obj['sessionId'],
      startedAt: typeof obj['startedAt'] === 'string' ? obj['startedAt'] : new Date(0).toISOString(),
      intervalMs: typeof obj['intervalMs'] === 'number' ? obj['intervalMs'] : 0,
    }
    if (typeof obj['cols'] === 'number') header.cols = obj['cols']
    if (typeof obj['rows'] === 'number') header.rows = obj['rows']
    return { kind: 'header', header }
  }

  if (typeof obj['t'] === 'number' && typeof obj['d'] === 'string') {
    return { kind: 'frame', frame: { t: obj['t'], d: obj['d'] } }
  }
  return null
}

// ---------------------------------------------------------------------------
// 压缩
// ---------------------------------------------------------------------------

/** gzip 一个文件；返回压缩后字节数。失败时抛错，由调用方决定是否降级保留 .rec */
export async function gzipFile(src: string, dst: string): Promise<number> {
  await pipeline(createReadStream(src), createGzip({ level: 6 }), createWriteStream(dst))
  const { size } = await stat(dst)
  return size
}

// ---------------------------------------------------------------------------
// 增量写入器
// ---------------------------------------------------------------------------

export interface WriteStreamLike {
  write(chunk: string, cb?: () => void): boolean
  end(cb?: () => void): void
  on(event: 'error', listener: (err: Error) => void): unknown
}

export interface RecordingTimer {
  setInterval(fn: () => void, ms: number): unknown
  clearInterval(handle: unknown): void
}

export const systemRecordingTimer: RecordingTimer = {
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
}

export interface RecordingSummary {
  path: string
  /** 压缩后的路径（未压缩时为 undefined） */
  gzPath?: string
  frames: number
  /** 因"内容与上一帧相同"而跳过的 tick 次数（增量效果的直接证据） */
  skippedTicks: number
  /** 未压缩字节数 */
  bytes: number
  /** 压缩后字节数 */
  gzBytes?: number
  durationMs: number
  /** 压缩是否成功（失败时保留 .rec） */
  compressed: boolean
}

export interface RecordingWriterOptions {
  path: string
  intervalMs: number
  header: Omit<RecordingHeader, 'v' | 'kind' | 'intervalMs'>
  clock?: () => number
  timer?: RecordingTimer
  createStream?: (path: string) => WriteStreamLike
  onError?: (err: Error) => void
}

export class RecordingWriter {
  private readonly path: string
  private readonly intervalMs: number
  private readonly header: RecordingHeader
  private readonly clock: () => number
  private readonly timer: RecordingTimer
  private readonly createStream: (path: string) => WriteStreamLike
  private readonly onError: (err: Error) => void

  private stream: WriteStreamLike | null = null
  private handle: unknown = null
  private readonly buffer: string[] = []
  private bufferedCount = 0
  private frameCount = 0
  private skipped = 0
  private bytes = 0
  private stopped = false
  private startedAtMs = 0
  private lastFrameT = 0
  /** 未落盘的写入（flush 用）。WriteStream 自己会缓冲，测试/读取需要"写到这里"的语义 */
  private pending: Array<Promise<void>> = []

  constructor(options: RecordingWriterOptions) {
    this.path = options.path
    this.intervalMs = clampInterval(options.intervalMs)
    this.clock = options.clock ?? (() => Date.now())
    this.timer = options.timer ?? systemRecordingTimer
    this.createStream =
      options.createStream ?? ((p) => createWriteStream(p, { flags: 'w' }) as WriteStreamLike)
    this.onError = options.onError ?? (() => {})
    this.header = {
      v: RECORDING_FORMAT_VERSION,
      kind: 'session-recording',
      ...options.header,
      intervalMs: this.intervalMs,
    }
  }

  get filePath(): string {
    return this.path
  }

  get frames(): number {
    return this.frameCount
  }

  get skippedTicks(): number {
    return this.skipped
  }

  get pendingChars(): number {
    return this.bufferedCount
  }

  get isStopped(): boolean {
    return this.stopped
  }

  /** 打开文件、写 header、启动定时合并 */
  start(): void {
    if (this.stream !== null) return
    this.startedAtMs = this.clock()
    const stream = this.createStream(this.path)
    stream.on('error', (err) => this.onError(err))
    this.stream = stream
    this.write(encodeHeader(this.header))
    this.handle = this.timer.setInterval(() => {
      this.tick()
    }, this.intervalMs)
  }

  /** 缓冲一段输出（不立刻落盘：等间隔合并成帧） */
  push(chunk: string): void {
    if (this.stopped || chunk.length === 0) return
    this.buffer.push(chunk)
    this.bufferedCount += chunk.length
  }

  /**
   * 一个间隔到点：有内容才写帧。
   *
   * **缓冲为空 → 跳过**：这就是 spec 说的"仅保存与上一帧不同的内容（增量录制）"。
   * 返回 'skipped' 时调用方可以据此统计（`skippedTicks`）。
   */
  tick(): 'written' | 'skipped' {
    if (this.stopped) return 'skipped'
    if (this.bufferedCount === 0) {
      this.skipped += 1
      return 'skipped'
    }
    const data = this.buffer.join('')
    this.buffer.length = 0
    this.bufferedCount = 0
    const t = Math.max(0, this.clock() - this.startedAtMs)
    this.write(encodeFrame({ t, d: data }))
    this.frameCount += 1
    this.lastFrameT = t
    return 'written'
  }

  /** 结束录制：补最后一帧 → 关闭流 →（可选）压缩 */
  async stop(options: { compress?: boolean } = {}): Promise<RecordingSummary> {
    if (this.stopped) return this.summary(false)
    // 收尾补帧：否则缓冲里最后一段输出会丢（终端最后一屏常常就在这段里）
    if (this.bufferedCount > 0) this.tick()
    this.clearTimer()
    await this.flush()
    await this.close()

    this.stopped = true
    let compressed = false
    let gzPath: string | undefined
    let gzBytes: number | undefined

    if (options.compress === true && this.bytes > 0) {
      const target = `${this.path}.gz`
      try {
        gzBytes = await gzipFile(this.path, target)
        // 压缩成功后删掉原始 .rec：保留两份等于没省空间（spec 的目的就是省空间）。
        // 两个大小都记进 meta，压缩比可核对。
        await unlink(this.path)
        compressed = true
        gzPath = target
      } catch (err) {
        // 压缩失败不影响录制数据：保留 .rec
        this.onError(err instanceof Error ? err : new Error(String(err)))
      }
    }

    return this.summary(compressed, gzPath, gzBytes)
  }

  /**
   * 等到已提交的写入真正落盘。
   *
   * WriteStream 内部有缓冲，`write()` 返回时数据可能还没到磁盘 ——
   * 录制中要读文件（测试、以及"边录边看"）就必须先 flush。
   */
  async flush(): Promise<void> {
    const waiting = this.pending
    this.pending = []
    await Promise.all(waiting)
  }

  /** 不关闭流的快照信息（录制中也可读） */
  liveStats(): { frames: number; skippedTicks: number; bytes: number; pendingChars: number } {
    return {
      frames: this.frameCount,
      skippedTicks: this.skipped,
      bytes: this.bytes,
      pendingChars: this.bufferedCount,
    }
  }

  private summary(
    compressed: boolean,
    gzPath?: string,
    gzBytes?: number,
  ): RecordingSummary {
    const out: RecordingSummary = {
      path: this.path,
      frames: this.frameCount,
      skippedTicks: this.skipped,
      bytes: this.bytes,
      durationMs: Math.max(this.lastFrameT, this.clock() - this.startedAtMs),
      compressed,
    }
    if (gzPath !== undefined) out.gzPath = gzPath
    if (gzBytes !== undefined) out.gzBytes = gzBytes
    return out
  }

  private write(line: string): void {
    const stream = this.stream
    if (stream === null) return
    this.bytes += Buffer.byteLength(line)
    this.pending.push(
      new Promise<void>((resolve) => {
        try {
          stream.write(line, () => resolve())
        } catch (err) {
          this.onError(err instanceof Error ? err : new Error(String(err)))
          resolve()
        }
      }),
    )
  }

  private clearTimer(): void {
    if (this.handle === null) return
    this.timer.clearInterval(this.handle)
    this.handle = null
  }

  private close(): Promise<void> {
    const stream = this.stream
    this.stream = null
    if (stream === null) return Promise.resolve()
    return new Promise((resolve) => {
      try {
        stream.end(() => resolve())
      } catch {
        resolve()
      }
    })
  }
}

// ---------------------------------------------------------------------------
// 读取（回放用）
// ---------------------------------------------------------------------------

/**
 * 逐行解析录制文件（支持 `.rec` 与 `.rec.gz`）。
 *
 * 用流式读取：一次只持有一行，避免把整场录制读进内存。
 * 调用方决定要保留哪些帧（回放只保留时间窗口内的）。
 */
export async function readRecordingLines(
  filePath: string,
  onLine: (line: RecordingLine) => void,
  compressed: boolean,
): Promise<void> {
  const source = compressed
    ? createReadStream(filePath).pipe(createGunzip())
    : createReadStream(filePath)
  let carry = ''
  for await (const chunk of source) {
    carry += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    let index = carry.indexOf('\n')
    while (index >= 0) {
      const line = carry.slice(0, index)
      carry = carry.slice(index + 1)
      const parsed = parseRecordingLine(line)
      if (parsed !== null) onLine(parsed)
      index = carry.indexOf('\n')
    }
  }
  // 文件末尾可能没有换行（异常中断）
  const last = parseRecordingLine(carry)
  if (last !== null) onLine(last)
}
