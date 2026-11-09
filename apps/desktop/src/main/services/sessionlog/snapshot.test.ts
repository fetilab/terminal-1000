// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 会话录制（快照 + 回放）服务级单测。
 *
 * 覆盖验收项：设置项读写与间隔下限钳制、录制产出 .rec、
 * **相同内容不重复写帧（计数断言，不只看文件存在）**、按区间读取、压缩往返、
 * 删除连带清理，以及一次**真实 PTY 录制实测**（帧数/大小/压缩比）。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StoreService, setStoreService } from '../store'
import { readRecordingSettings, resetSettingsCache, settingsHandlers } from '../settings'
import { publishSessionData } from '../session-registry'
import { SessionLogService, sessionlogHandlers } from './index'
import {
  MIN_INTERVAL_MS,
  systemRecordingTimer,
  type RecordingTimer,
} from './recording'

/** 手动定时器：精确驱动"间隔到点" */
class ManualTimer implements RecordingTimer {
  private seq = 0
  private readonly callbacks = new Map<number, () => void>()
  ticks = 0

  setInterval(fn: () => void, _ms: number): unknown {
    const id = ++this.seq
    this.callbacks.set(id, fn)
    return id
  }

  clearInterval(handle: unknown): void {
    if (typeof handle === 'number') this.callbacks.delete(handle)
  }

  fire(): void {
    this.ticks += 1
    for (const fn of [...this.callbacks.values()]) fn()
  }

  get active(): number {
    return this.callbacks.size
  }
}

const ctx = {
  logger: { debug() {}, info() {}, warn() {}, error() {} },
  paths: {
    userData: '/tmp',
    dbFile: ':memory:',
    notesDir: '/tmp',
    sessionLogDir: '',
    watchDir: '/tmp',
    bgImagesDir: '/tmp',
    backupDir: '/tmp',
    logDir: '/tmp',
  },
  emit() {},
} as never

let dir = ''
let now = 1_700_000_000_000
const clock = (): number => now

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 't1000-snap-'))
  now = 1_700_000_000_000
  ;(ctx as { paths: { sessionLogDir: string } }).paths.sessionLogDir = dir
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** 录制设置可注入的服务（间隔 1s，不自动压缩，便于检查 .rec） */
function makeService(
  over: {
    enabled?: boolean
    intervalMs?: number
    autoCompress?: boolean
    timer?: RecordingTimer
    withClock?: boolean
  } = {},
): { service: SessionLogService; timer: ManualTimer } {
  const timer = over.timer ?? new ManualTimer()
  const service = new SessionLogService(dir, {
    loadSettings: () => ({
      enabled: over.enabled ?? true,
      intervalMs: over.intervalMs ?? MIN_INTERVAL_MS,
      autoCompress: over.autoCompress ?? false,
    }),
    timer,
    ...(over.withClock === false ? {} : { now: clock }),
  })
  return { service, timer: timer as ManualTimer }
}

const lineCount = (path: string): number =>
  readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l !== '').length

const readMeta = (logId: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(dir, `${logId}.meta.json`), 'utf8')) as Record<string, unknown>

// ---------------------------------------------------------------------------
// 设置项（经 IPC 动作）
// ---------------------------------------------------------------------------

describe('录制设置：动作读写 + 间隔下限钳制', () => {
  beforeEach(() => {
    setStoreService(new StoreService(':memory:'))
    resetSettingsCache()
  })

  afterEach(() => {
    setStoreService(null)
    resetSettingsCache()
  })

  const call = (action: string, payload?: unknown): unknown => {
    const handler = sessionlogHandlers[action]
    if (!handler) throw new Error(`未实现: ${action}`)
    return handler(payload, ctx)
  }

  it('默认：不录制 / 5 秒 / 自动压缩开', () => {
    expect(call('getSettings')).toEqual({ enabled: false, intervalMs: 5000, autoCompress: true })
  })

  it('★ 间隔 <1s 被抬到 1s 后持久化（不是原样存进去）', () => {
    const saved = call('setSettings', { intervalMs: 500, enabled: true }) as {
      intervalMs: number
    }
    expect(saved.intervalMs).toBe(MIN_INTERVAL_MS)

    // 真的落到了设置文档里
    const group = readRecordingSettings()
    expect(group?.['intervalMs']).toBe(MIN_INTERVAL_MS)
    expect(group?.['enabled']).toBe(true)

    // 重新读也一致（缓存刷新后仍为钳制值）
    resetSettingsCache()
    expect(call('getSettings')).toMatchObject({ intervalMs: MIN_INTERVAL_MS, enabled: true })
  })

  it('只改一个字段时其余保持', () => {
    call('setSettings', { intervalMs: 8000, autoCompress: false })
    expect(call('getSettings')).toEqual({ enabled: false, intervalMs: 8000, autoCompress: false })
    call('setSettings', { enabled: true })
    expect(call('getSettings')).toMatchObject({ enabled: true, intervalMs: 8000, autoCompress: false })
  })

  it('录制设置不破坏设置文档的其它分组', () => {
    call('setSettings', { intervalMs: 2000 })
    const terminal = settingsHandlers['get']?.({ path: 'terminal.fontSize' }, ctx) as {
      value: unknown
    }
    expect(typeof terminal.value).toBe('number')
  })
})

// ---------------------------------------------------------------------------
// 录制与增量
// ---------------------------------------------------------------------------

describe('快照录制：产出 .rec 与增量判定', () => {
  it('start 返回 recPath 并写出 header（含终端尺寸）', async () => {
    const { service } = makeService()
    const started = service.start('s1', '会话一', { cols: 120, rows: 30 })
    expect(started.recPath).toBeDefined()

    const path = started.recPath as string
    // 文件由写入流异步创建，等落盘再读
    await new Promise((r) => setTimeout(r, 30))
    expect(existsSync(path)).toBe(true)
    const header = JSON.parse(readFileSync(path, 'utf8').split('\n')[0] as string) as Record<string, unknown>
    expect(header).toMatchObject({
      kind: 'session-recording',
      logId: started.logId,
      sessionId: 's1',
      cols: 120,
      rows: 30,
      intervalMs: MIN_INTERVAL_MS,
    })
    await service.stopAndFinalize()
  })

  it('★ 相同内容不重复写帧：空闲的 tick 只增加 skippedTicks，文件行数不变', async () => {
    const { service, timer } = makeService()
    const { logId, recPath } = service.start('s1', '增量测试')
    const path = recPath as string

    publishSessionData('s1', '第一段输出\n')
    now += 1000
    timer.fire()
    publishSessionData('s1', '第二段输出\n')
    now += 1000
    timer.fire()

    // 关键计数：此后 6 个间隔完全没有输出
    for (let i = 0; i < 6; i += 1) {
      now += 1000
      timer.fire()
    }

    const active = service.active()[0]
    expect(active?.frames).toBe(2)
    expect(active?.skippedTicks).toBe(6)
    expect(active?.recording).toBe(true)
    expect(timer.ticks).toBe(8)

    await service.stopAndFinalize()
    await new Promise((r) => setTimeout(r, 20))

    // 文件里恰好是 header + 2 帧：**没有**因为空闲被重复写
    expect(lineCount(path)).toBe(3)
    const meta = readMeta(logId)
    expect(meta['frames']).toBe(2)
    expect(meta['skippedTicks']).toBe(6)
  })

  it('精简后的 list 显示 hasRecording 与快照占用', async () => {
    const { service, timer } = makeService()
    const { logId } = service.start('s1', '列表测试')
    publishSessionData('s1', 'x'.repeat(500))
    timer.fire()
    await service.stopAndFinalize()
    await new Promise((r) => setTimeout(r, 20))

    const entry = service.list().find((l) => l.logId === logId)
    expect(entry?.hasRecording).toBe(true)
    expect(entry?.recBytes).toBeGreaterThan(0)
    expect(entry?.frames).toBe(1)
  })

  it('设置关闭且未显式要求时不产生快照（只写文本日志）', async () => {
    const { service } = makeService({ enabled: false })
    const started = service.start('s1', '不录快照')
    expect(started.recPath).toBeUndefined()
    expect(service.active()[0]?.recording).toBe(false)
    await service.stopAndFinalize()
  })

  it('显式 snapshot:true 可越过设置开关按会话录制', async () => {
    const { service } = makeService({ enabled: false })
    const started = service.start('s1', '显式录制', { snapshot: true })
    expect(started.recPath).toBeDefined()
    await service.stopAndFinalize()
  })
})

// ---------------------------------------------------------------------------
// 回放读取
// ---------------------------------------------------------------------------

describe('回放读取：按时间区间取帧', () => {
  async function record(over: { autoCompress?: boolean } = {}): Promise<{
    service: SessionLogService
    logId: string
    path: string
  }> {
    const { service, timer } = makeService({ autoCompress: over.autoCompress ?? false })
    const { logId, recPath } = service.start('s1', '回放测试', { cols: 100, rows: 40 })
    for (const [i, t] of [1000, 2000, 3000, 4000].entries()) {
      publishSessionData('s1', `第 ${i + 1} 段\n`)
      now += 1000
      timer.fire()
      void t
    }
    await service.stopAndFinalize()
    await new Promise((r) => setTimeout(r, 20))
    return { service, logId, path: recPath as string }
  }

  it('默认返回全部帧 + 时间轴信息', async () => {
    const { service, logId } = await record()
    const replay = await service.replay(logId)

    expect(replay.frames.map((f) => f.data)).toEqual([
      '第 1 段\n',
      '第 2 段\n',
      '第 3 段\n',
      '第 4 段\n',
    ])
    expect(replay.frames.map((f) => f.tMs)).toEqual([1000, 2000, 3000, 4000])
    expect(replay.totalMs).toBe(4000)
    expect(replay.frameCount).toBe(4)
    expect(replay.hasMore).toBe(false)
    expect(replay.intervalMs).toBe(MIN_INTERVAL_MS)
    expect(replay.cols).toBe(100)
    expect(replay.rows).toBe(40)
    expect(replay.compressed).toBe(false)
  })

  it('★ 按区间取：只返回窗口内的帧（拖拽跳转靠它）', async () => {
    const { service, logId } = await record()
    const window = await service.replay(logId, { fromMs: 2000, toMs: 4000 })
    expect(window.frames.map((f) => f.tMs)).toEqual([2000, 3000])
    expect(window.totalMs).toBe(4000) // 总时长仍是全场，进度条才画得对
    expect(window.frameCount).toBe(2)
  })

  it('limit 截断 + hasMore（不把整场录制塞给渲染层）', async () => {
    const { service, logId } = await record()
    const page = await service.replay(logId, { limit: 2 })
    expect(page.frames).toHaveLength(2)
    expect(page.frameCount).toBe(4)
    expect(page.hasMore).toBe(true)

    const second = await service.replay(logId, { fromMs: 3000, limit: 2 })
    expect(second.frames.map((f) => f.tMs)).toEqual([3000, 4000])
    expect(second.hasMore).toBe(false)
  })

  it('压缩后仍能回放（透明读 .rec.gz），并报告 compressed', async () => {
    const { service, logId, path } = await record({ autoCompress: true })
    expect(existsSync(path)).toBe(false) // 已压缩，原始 .rec 不在
    expect(existsSync(`${path}.gz`)).toBe(true)

    const replay = await service.replay(logId)
    expect(replay.compressed).toBe(true)
    expect(replay.frames.map((f) => f.data)).toEqual([
      '第 1 段\n',
      '第 2 段\n',
      '第 3 段\n',
      '第 4 段\n',
    ])
  })

  it('没有快照的日志 → NOT_FOUND（而不是返回空帧让人以为录制坏了）', async () => {
    const { service } = makeService({ enabled: false })
    const { logId } = service.start('s1', '纯文本')
    await service.stopAndFinalize()
    await expect(service.replay(logId)).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('delete 连带清掉压缩快照', async () => {
    const { service, logId, path } = await record({ autoCompress: true })
    expect(existsSync(`${path}.gz`)).toBe(true)
    expect(service.remove(logId)).toEqual({ deleted: true })
    expect(existsSync(`${path}.gz`)).toBe(false)
    expect(existsSync(join(dir, `${logId}.meta.json`))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// ★ 真实录制实测（本地 PTY）
// ---------------------------------------------------------------------------

const ptyModule = await import('node-pty').catch(() => null)

describe('★ 真实 PTY 录制实测', () => {
  it.skipIf(ptyModule === null)(
    '录制真实终端输出：给出 .rec 大小、帧数、增量跳过次数与压缩比',
    async () => {
      if (ptyModule === null) return
      // 真实录制走服务路径：设置间隔 1s（spec 下限）、自动压缩开、**真实定时器**
      const { service } = makeService({
        intervalMs: MIN_INTERVAL_MS,
        autoCompress: true,
        timer: systemRecordingTimer,
        // 真实时钟：帧时间戳才有真实的时间轴（否则全为 0）
        withClock: false,
      })
      const { logId } = service.start('pty-real', '真实终端录制', { cols: 100, rows: 30 })

      const pty = ptyModule.spawn(
        '/bin/sh',
        [
          '-c',
          // 三段输出（含变化的内容，压缩比更接近真实），
          // 段间与结尾都留出"没有输出"的空闲间隔 → 应产生 skipped 帧
          'for i in 1 2 3; do printf "=== 第 %s 段 ===\\n" "$i"; ' +
            'seq 1 120 | sed "s/^/line-$(date +%s)-/"; ' +
            'printf "固定横幅：abcdefghijklmnopqrstuvwxyz 0123456789\\n"; ' +
            'sleep 0.6; done; sleep 1.6; echo "=== 结束 ==="',
        ],
        { name: 'xterm-256color', cols: 100, rows: 30 },
      )

      let bytes = 0
      pty.onData((chunk) => {
        bytes += chunk.length
        // 真实链路：PTY → 中立契约 → 录制
        publishSessionData('pty-real', chunk)
      })

      await new Promise<void>((resolve) => {
        pty.onExit(() => resolve())
        setTimeout(() => resolve(), 8000)
      })

      const result = await service.stopAndFinalize()
      const summary = result.recordings[0]
      expect(summary).toBeDefined()
      await new Promise((r) => setTimeout(r, 30))

      const meta = readMeta(logId)
      const recBytes = Number(meta['recBytes'] ?? 0)
      const gzBytes = Number(meta['gzBytes'] ?? 0)
      const frames = Number(meta['frames'] ?? 0)
      const skipped = Number(meta['skippedTicks'] ?? 0)

      const gzPath = join(dir, `${logId}.rec.gz`)
      const onDisk = statSync(gzPath).size
      const ratio = recBytes > 0 ? gzBytes / recBytes : 1

      console.log(
        `[perf] 真实 PTY 录制：PTY 输出 ${bytes} 字节 / ${frames} 帧 / 跳过 ${skipped} 次空闲 tick；` +
          `.rec ${recBytes} 字节 → .rec.gz ${gzBytes} 字节（减少 ${((1 - ratio) * 100).toFixed(1)}%）`,
      )

      // 真实产出：有输出、有帧
      expect(bytes).toBeGreaterThan(1000)
      expect(frames).toBeGreaterThanOrEqual(2)
      // 空闲间隔确实被跳过（"相同内容不重复写帧"的直接证据）
      expect(skipped).toBeGreaterThanOrEqual(1)
      // 压缩确实生效且文件在磁盘上（大小与 meta 一致）
      expect(existsSync(gzPath)).toBe(true)
      expect(onDisk).toBe(gzBytes)
      expect(ratio).toBeLessThan(0.5)

      // 录下来的内容真的能回放
      const replay = await service.replay(logId)
      console.log(`[perf] 真实录制回放：${replay.frames.length} 帧，总时长 ${replay.totalMs}ms`)
      expect(replay.frames.length).toBe(frames)
      const text = replay.frames.map((f) => f.data).join('')
      expect(text).toContain('=== 第 1 段 ===')
      expect(text).toContain('固定横幅')
      expect(replay.totalMs).toBeGreaterThanOrEqual(1000)
    },
    20_000,
  )
})
