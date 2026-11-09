// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 快照录制单测：设置钳制、帧格式往返、**增量判定（相同内容不重复写帧）**、
 * 收尾补帧、压缩往返与压缩比、`.rec` / `.rec.gz` 两种文件都能读。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import {
  DEFAULT_RECORDING_SETTINGS,
  type RecordingWriterOptions,
  MAX_INTERVAL_MS,
  MIN_INTERVAL_MS,
  RecordingWriter,
  clampInterval,
  encodeFrame,
  encodeHeader,
  normalizeRecordingSettings,
  parseRecordingLine,
  readRecordingLines,
  type RecordingTimer,
} from './recording'

/** 手动定时器：测试里精确控制"间隔到点" */
class ManualTimer implements RecordingTimer {
  private seq = 0
  private readonly callbacks = new Map<number, () => void>()

  setInterval(fn: () => void, _ms: number): unknown {
    const id = ++this.seq
    this.callbacks.set(id, fn)
    return id
  }

  clearInterval(handle: unknown): void {
    if (typeof handle === 'number') this.callbacks.delete(handle)
  }

  /** 触发一次"间隔到点" */
  fire(): void {
    for (const fn of [...this.callbacks.values()]) fn()
  }

  get active(): number {
    return this.callbacks.size
  }
}

let dir = ''
let now = 1_700_000_000_000

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 't1000-rec-'))
  now = 1_700_000_000_000
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const clock = (): number => now

function makeWriter(over: Partial<RecordingWriterOptions> = {}) {
  const timer = new ManualTimer()
  const writer = new RecordingWriter({
    path: join(dir, 'rec1.rec'),
    intervalMs: 5000,
    header: {
      logId: 'LOG1',
      sessionId: 'S1',
      title: '测试会话',
      startedAt: new Date(0).toISOString(),
    },
    clock,
    timer,
    ...over,
  })
  return { writer, timer, path: join(dir, 'rec1.rec') }
}

const lines = (path: string): string[] => readFileSync(path, 'utf8').split('\n').filter((l) => l !== '')

// ---------------------------------------------------------------------------
// 设置
// ---------------------------------------------------------------------------

describe('录制设置与间隔钳制', () => {
  it('默认值：不录制（需用户显式开启）、5 秒、自动压缩', () => {
    expect(DEFAULT_RECORDING_SETTINGS).toEqual({
      enabled: false,
      intervalMs: 5000,
      autoCompress: true,
    })
  })

  it('★ 间隔下限：<1s 被抬到 1s（spec：最小 1 秒）', () => {
    expect(clampInterval(500)).toBe(MIN_INTERVAL_MS)
    expect(clampInterval(0)).toBe(MIN_INTERVAL_MS)
    expect(clampInterval(-100)).toBe(MIN_INTERVAL_MS)
    expect(clampInterval(999)).toBe(MIN_INTERVAL_MS)
    expect(clampInterval(1000)).toBe(1000)
    expect(clampInterval(5000)).toBe(5000)
  })

  it('间隔上限与非法输入', () => {
    expect(clampInterval(Number.MAX_SAFE_INTEGER)).toBe(MAX_INTERVAL_MS)
    expect(clampInterval(Number.NaN)).toBe(DEFAULT_RECORDING_SETTINGS.intervalMs)
    expect(clampInterval('3000')).toBe(3000) // 字符串数字也接受
    expect(clampInterval('abc')).toBe(DEFAULT_RECORDING_SETTINGS.intervalMs)
  })

  it('normalize 只覆盖出现的字段，其余保持', () => {
    const base = { enabled: true, intervalMs: 8000, autoCompress: false }
    expect(normalizeRecordingSettings({ intervalMs: 500 }, base)).toEqual({
      enabled: true,
      intervalMs: 1000,
      autoCompress: false,
    })
    expect(normalizeRecordingSettings(undefined, base)).toEqual(base)
    expect(normalizeRecordingSettings('垃圾', base)).toEqual(base)
  })
})

// ---------------------------------------------------------------------------
// 帧格式
// ---------------------------------------------------------------------------

describe('帧格式往返', () => {
  it('header 往返', () => {
    const header = {
      v: 1,
      kind: 'session-recording' as const,
      logId: 'L1',
      sessionId: 'S1',
      title: '会话',
      startedAt: '2026-01-01T00:00:00.000Z',
      intervalMs: 5000,
      cols: 120,
      rows: 30,
    }
    const parsed = parseRecordingLine(encodeHeader(header).trim())
    expect(parsed).toEqual({ kind: 'header', header })
  })

  it('帧往返（含中文与换行转义）', () => {
    const data = '第一行\n第二行\r\n$ ls -a\n'
    const parsed = parseRecordingLine(encodeFrame({ t: 1234, d: data }).trim())
    expect(parsed).toEqual({ kind: 'frame', frame: { t: 1234, d: data } })
  })

  it('垃圾行 / 截断行返回 null（回放时直接跳过，不整场失败）', () => {
    expect(parseRecordingLine('')).toBeNull()
    expect(parseRecordingLine('{坏掉的 json')).toBeNull()
    expect(parseRecordingLine('{"t":1}')).toBeNull() // 缺 d
    expect(parseRecordingLine('{"d":"x"}')).toBeNull() // 缺 t
    expect(parseRecordingLine(JSON.stringify({ kind: 'session-recording' }))).toBeNull() // 缺 logId
  })
})

// ---------------------------------------------------------------------------
// 写入器：增量
// ---------------------------------------------------------------------------

describe('RecordingWriter：定时合并 + 增量判定', () => {
  it('start 只写 header，不写空帧', async () => {
    const { writer, path } = makeWriter()
    writer.start()
    await writer.flush()
    expect(lines(path)).toHaveLength(1)
    expect(parseRecordingLine(lines(path)[0] as string)?.kind).toBe('header')
  })

  it('一个间隔内的多段输出合并成**一帧**', async () => {
    const { writer, timer, path } = makeWriter()
    writer.start()
    writer.push('a')
    writer.push('b')
    now += 1000
    timer.fire()
    await writer.flush()

    const parsed = lines(path).map((l) => parseRecordingLine(l))
    expect(parsed).toHaveLength(2) // header + 1 帧
    expect(parsed[1]).toEqual({ kind: 'frame', frame: { t: 1000, d: 'ab' } })
    expect(writer.frames).toBe(1)
  })

  it('★ 缓冲为空 → 跳过（相同内容不重复写帧），并计数', async () => {
    const { writer, timer, path } = makeWriter()
    writer.start()
    writer.push('只有这一段')
    timer.fire()
    await writer.flush()
    expect(writer.frames).toBe(1)
    expect(lines(path)).toHaveLength(2)

    // 连续 5 个间隔都没有新输出 → 全部跳过，文件不再增长
    for (let i = 0; i < 5; i += 1) {
      now += 5000
      timer.fire()
    }
    expect(writer.frames).toBe(1)
    expect(writer.skippedTicks).toBe(5)
    expect(lines(path)).toHaveLength(2)

    // 再来一段新输出 → 只多一帧
    writer.push('新的输出')
    now += 5000
    timer.fire()
    await writer.flush()
    expect(writer.frames).toBe(2)
    expect(lines(path)).toHaveLength(3)
    expect(writer.skippedTicks).toBe(5)
  })

  it('空字符串不进入缓冲（不产生空帧）', async () => {
    const { writer } = makeWriter()
    writer.start()
    writer.push('')
    expect(writer.tick()).toBe('skipped')
    await writer.flush()
    expect(writer.frames).toBe(0)
    expect(writer.skippedTicks).toBe(1)
  })

  it('stop 会把缓冲里剩下的输出补成最后一帧（否则最后一段输出会丢）', async () => {
    const { writer, path } = makeWriter()
    writer.start()
    writer.push('还没来得及落盘的一段')
    const summary = await writer.stop({ compress: false })

    expect(summary.frames).toBe(1)
    const parsed = lines(path).map((l) => parseRecordingLine(l))
    expect(parsed.at(-1)).toEqual({
      kind: 'frame',
      frame: { t: 0, d: '还没来得及落盘的一段' },
    })
    expect(writer.isStopped).toBe(true)
  })

  it('stop 会清掉定时器（不留悬挂 handle）', async () => {
    const { writer, timer } = makeWriter()
    writer.start()
    expect(timer.active).toBe(1)
    await writer.stop({ compress: false })
    expect(timer.active).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 压缩
// ---------------------------------------------------------------------------

describe('压缩（结束录制时自动压成 .rec.gz）', () => {
  it('★ 压缩成功：生成 .rec.gz、删掉 .rec、算出压缩比', async () => {
    const { writer, timer, path } = makeWriter()
    writer.start()
    // 可压缩的重复内容（真实终端输出也高度重复）
    for (let i = 0; i < 20; i += 1) {
      writer.push(`行 ${i}：这是一段重复的终端输出内容，用于验证 gzip 压缩比\n`.repeat(20))
      now += 5000
      timer.fire()
    }
    const summary = await writer.stop({ compress: true })

    expect(summary.compressed).toBe(true)
    expect(summary.gzPath).toBe(`${path}.gz`)
    expect(existsSync(`${path}.gz`)).toBe(true)
    expect(existsSync(path)).toBe(false) // 压缩后不留原始文件（否则没省空间）
    expect(summary.gzBytes).toBeGreaterThan(0)
    expect(summary.gzBytes as number).toBeLessThan(summary.bytes)
    console.log(
      `[perf] 压缩比：${summary.bytes} → ${summary.gzBytes} 字节（` +
        `${(100 - ((summary.gzBytes as number) / summary.bytes) * 100).toFixed(1)}% 减少），` +
        `${summary.frames} 帧，跳过 ${summary.skippedTicks} 次`,
    )
  })

  it('gzip 往返：解压后内容与原始 .rec 完全一致（含中文）', async () => {
    const { writer, path } = makeWriter()
    writer.start()
    writer.push('中文内容\n第二行\n')
    writer.tick()
    await writer.flush()
    const before = readFileSync(path, 'utf8')
    const summary = await writer.stop({ compress: true })

    const restored = gunzipSync(readFileSync(summary.gzPath as string)).toString('utf8')
    expect(restored).toBe(before)
  })

  it('关闭自动压缩 → 保留 .rec', async () => {
    const { writer, path } = makeWriter()
    writer.start()
    writer.push('x')
    const summary = await writer.stop({ compress: false })
    expect(summary.compressed).toBe(false)
    expect(summary.gzPath).toBeUndefined()
    expect(existsSync(path)).toBe(true)
    expect(existsSync(`${path}.gz`)).toBe(false)
  })

  it('录制中也能读到实时统计（帧数 / 跳过次数 / 字节数）', () => {
    const { writer, timer } = makeWriter()
    writer.start()
    writer.push('abc')
    timer.fire()
    const stats = writer.liveStats()
    expect(stats.frames).toBe(1)
    expect(stats.pendingChars).toBe(0)
    expect(stats.bytes).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// 读取（回放侧）
// ---------------------------------------------------------------------------

describe('readRecordingLines：.rec 与 .rec.gz 都能读', () => {
  it('读取明文 .rec', async () => {
    const { writer, timer, path } = makeWriter()
    writer.start()
    writer.push('一')
    timer.fire()
    now += 5000
    writer.push('二')
    timer.fire()
    await writer.stop({ compress: false })

    const frames: Array<{ t: number; d: string }> = []
    await readRecordingLines(path, (line) => {
      if (line.kind === 'frame') frames.push(line.frame)
    }, false)
    expect(frames.map((f) => f.d)).toEqual(['一', '二'])
  })

  it('读取压缩 .rec.gz（与明文得到同样的帧）', async () => {
    const { writer, timer, path } = makeWriter()
    writer.start()
    writer.push('甲')
    timer.fire()
    now += 5000
    writer.push('乙')
    timer.fire()
    const summary = await writer.stop({ compress: true })

    const frames: string[] = []
    await readRecordingLines(summary.gzPath as string, (line) => {
      if (line.kind === 'frame') frames.push(line.frame.d)
    }, true)
    expect(frames).toEqual(['甲', '乙'])
    void path
  })

  it('最后一行被截断（异常中断）时跳过而不是整体失败', async () => {
    const { writer, timer, path } = makeWriter()
    writer.start()
    writer.push('完整的一帧')
    timer.fire()
    await writer.stop({ compress: false })

    const content = readFileSync(path, 'utf8')
    writeFileSync(path, `${content}{"t":9999,"d":"被截断`, 'utf8') // 故意截断

    const frames: string[] = []
    await readRecordingLines(path, (line) => {
      if (line.kind === 'frame') frames.push(line.frame.d)
    }, false)
    expect(frames).toEqual(['完整的一帧'])
  })
})
