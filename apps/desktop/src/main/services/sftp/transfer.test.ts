// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 传输引擎单测。
 *
 * 全部使用**手写的假 SFTP 对象**（不连真实主机），本地文件用 os.tmpdir()，
 * 时钟与延迟调度可注入 —— 因此节流、取消这类时序断言是确定性的，不靠 sleep 碰运气。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Events } from '@t1000/shared'
import type { EventEmitterFn } from '../../ipc/router'
import type { SftpEntry, SftpLike, SftpStats } from './browser'
import { TransferEngine, TransferGate } from './transfer'

// ---------------------------------------------------------------------------
// 假 SFTP
// ---------------------------------------------------------------------------

const DIR_MODE = 0o040000 | 0o755
const FILE_MODE = 0o100000 | 0o644

/** 在 void 方法里安排延时回调：直接 `return later(...)` 会把 Timeout 值当返回值 */
const later = (fn: () => void, ms = 0): void => {
  setTimeout(fn, ms)
}

function stats(mode: number, size: number, mtime = 0): SftpStats {
  return {
    mode,
    uid: 0,
    gid: 0,
    size,
    atime: mtime,
    mtime,
    isDirectory: () => (mode & 0o170000) === 0o040000,
    isFile: () => (mode & 0o170000) === 0o100000,
    isSymbolicLink: () => (mode & 0o170000) === 0o120000,
  }
}

function noEnt(what: string): Error {
  const err = new Error(`No such file: ${what}`)
  ;(err as { code?: number }).code = 2
  return err
}

/** 内存里的假远端：文件表 + 目录表 + 句柄，行为足以驱动浏览器层与传输引擎 */
class FakeSftp implements SftpLike {
  readonly files = new Map<string, Buffer>()
  readonly dirs = new Set<string>(['/'])
  readonly unlinked: string[] = []
  readonly opened: Array<{ path: string; mode: string }> = []
  readonly writes: Array<{ path: string; position: number; length: number }> = []
  readonly mkdirs: string[] = []
  readonly chmods: Array<{ path: string; mode: number }> = []

  /** 每次 write 的额外延迟，用来制造并发重叠与可取消的慢传输 */
  writeDelayMs = 0
  readDelayMs = 0
  /** write 被调用时（延迟之前）触发，测试用它推进假时钟 */
  onWrite?: (info: { path: string; position: number }) => void

  /** 并发度量：open→close 之间算一个活跃传输 */
  activeTransfers = 0
  maxActiveTransfers = 0

  private readonly handles = new Map<number, { path: string; mode: string }>()
  private nextHandle = 1

  addFile(path: string, content: string | Buffer): this {
    this.files.set(path, Buffer.from(content))
    this.ensureParents(path)
    return this
  }

  addDir(path: string): this {
    const parts = path.split('/').filter((p) => p !== '')
    let cur = ''
    for (const p of parts) {
      cur += `/${p}`
      this.dirs.add(cur)
    }
    return this
  }

  private ensureParents(filePath: string): void {
    const idx = filePath.lastIndexOf('/')
    if (idx > 0) this.addDir(filePath.slice(0, idx))
  }

  readdir(location: string, cb: (err: Error | undefined, list: SftpEntry[]) => void): void {
    if (!this.dirs.has(location)) {
      setTimeout(() => cb(noEnt(location), []), 0)
      return
    }
    const prefix = location === '/' ? '/' : `${location}/`
    const entries: SftpEntry[] = []
    for (const d of this.dirs) {
      if (d === location || !d.startsWith(prefix)) continue
      const rest = d.slice(prefix.length)
      if (rest === '' || rest.includes('/')) continue
      entries.push({ filename: rest, longname: `d ${rest}`, attrs: stats(DIR_MODE, 0) })
    }
    for (const [f, buf] of this.files) {
      if (!f.startsWith(prefix)) continue
      const rest = f.slice(prefix.length)
      if (rest === '' || rest.includes('/')) continue
      entries.push({ filename: rest, longname: `- ${rest}`, attrs: stats(FILE_MODE, buf.length) })
    }
    setTimeout(() => cb(undefined, entries), 0)
  }

  stat(path: string, cb: (err: Error | undefined, s: SftpStats) => void): void {
    if (this.dirs.has(path)) return later(() => cb(undefined, stats(DIR_MODE, 0)), 0)
    const f = this.files.get(path)
    if (f) return later(() => cb(undefined, stats(FILE_MODE, f.length)), 0)
    setTimeout(() => cb(noEnt(path), stats(0, 0)), 0)
  }

  lstat(path: string, cb: (err: Error | undefined, s: SftpStats) => void): void {
    this.stat(path, cb)
  }

  mkdir(path: string, _attrs: { mode?: number }, cb: (err?: Error | null) => void): void {
    if (this.dirs.has(path)) {
      const err = new Error(`File exists: ${path}`)
      ;(err as { code?: number }).code = 4
      setTimeout(() => cb(err), 0)
      return
    }
    this.mkdirs.push(path)
    this.addDir(path)
    setTimeout(() => cb(), 0)
  }

  rmdir(path: string, cb: (err?: Error | null) => void): void {
    if (!this.dirs.has(path)) return later(() => cb(noEnt(path)), 0)
    for (const f of this.files.keys()) if (f.startsWith(`${path}/`)) return later(() => cb(new Error('Directory not empty')), 0)
    this.dirs.delete(path)
    setTimeout(() => cb(), 0)
  }

  unlink(path: string, cb: (err?: Error | null) => void): void {
    if (!this.files.has(path)) return later(() => cb(noEnt(path)), 0)
    this.files.delete(path)
    this.unlinked.push(path)
    setTimeout(() => cb(), 0)
  }

  rename(src: string, dest: string, cb: (err?: Error | null) => void): void {
    const f = this.files.get(src)
    if (f) {
      this.files.delete(src)
      this.files.set(dest, f)
    } else {
      this.dirs.delete(src)
      this.addDir(dest)
    }
    setTimeout(() => cb(), 0)
  }

  chmod(path: string, mode: number, cb: (err?: Error | null) => void): void {
    this.chmods.push({ path, mode })
    setTimeout(() => cb(), 0)
  }

  readFile(path: string, cb: (err: Error | undefined, data: Buffer) => void): void {
    const f = this.files.get(path)
    if (!f) return later(() => cb(noEnt(path), Buffer.alloc(0)), 0)
    setTimeout(() => cb(undefined, Buffer.from(f)), 0)
  }

  writeFile(path: string, data: Buffer, cb?: (err?: Error | null) => void): void {
    this.files.set(path, Buffer.from(data))
    this.ensureParents(path)
    setTimeout(() => cb?.(), 0)
  }

  open(path: string, mode: string, cb: (err: Error | undefined, handle: Buffer) => void): void {
    if (mode.startsWith('r') && !this.files.has(path)) {
      setTimeout(() => cb(noEnt(path), Buffer.alloc(0)), 0)
      return
    }
    if (mode.startsWith('w')) {
      this.files.set(path, Buffer.alloc(0))
      this.ensureParents(path)
    }
    const id = this.nextHandle++
    this.handles.set(id, { path, mode })
    this.opened.push({ path, mode })
    this.activeTransfers++
    this.maxActiveTransfers = Math.max(this.maxActiveTransfers, this.activeTransfers)
    const handle = Buffer.alloc(4)
    handle.writeUInt32BE(id, 0)
    setTimeout(() => cb(undefined, handle), 0)
  }

  close(handle: Buffer, cb: (err?: Error | null) => void): void {
    if (this.handles.delete(handle.readUInt32BE(0))) {
      this.activeTransfers = Math.max(0, this.activeTransfers - 1)
    }
    setTimeout(() => cb(), 0)
  }

  read(
    handle: Buffer,
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
    cb: (err: Error | undefined, bytesRead: number, buffer: Buffer) => void,
  ): void {
    const h = this.handles.get(handle.readUInt32BE(0))
    if (!h) return later(() => cb(noEnt('handle'), 0, buffer), 0)
    const data = this.files.get(h.path) ?? Buffer.alloc(0)
    const slice = data.subarray(position, position + length)
    slice.copy(buffer, offset)
    setTimeout(() => cb(undefined, slice.length, buffer), this.readDelayMs)
  }

  write(
    handle: Buffer,
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
    cb: (err?: Error | null) => void,
  ): void {
    const h = this.handles.get(handle.readUInt32BE(0))
    if (!h) return later(() => cb(noEnt('handle')), 0)
    const chunk = Buffer.from(buffer.subarray(offset, offset + length))
    const existing = this.files.get(h.path) ?? Buffer.alloc(0)
    const needed = position + chunk.length
    const next =
      existing.length >= needed
        ? Buffer.from(existing)
        : Buffer.concat([Buffer.from(existing), Buffer.alloc(needed - existing.length)])
    chunk.copy(next, position)
    this.files.set(h.path, next)
    this.writes.push({ path: h.path, position, length: chunk.length })
    this.onWrite?.({ path: h.path, position })
    setTimeout(() => cb(), this.writeDelayMs)
  }

  realpath(_path: string, cb: (err: Error | undefined, absPath: string) => void): void {
    setTimeout(() => cb(undefined, '/'), 0)
  }
}

// ---------------------------------------------------------------------------
// 测试脚手架
// ---------------------------------------------------------------------------

interface Emitted {
  event: string
  payload: Record<string, unknown>
}

interface Harness {
  events: Emitted[]
  emit: EventEmitterFn
  eventsOf(event: string): Emitted[]
}

function makeEmitter(): Harness {
  const events: Emitted[] = []
  const emit = ((event: string, payload: Record<string, unknown>) => {
    events.push({ event, payload })
  }) as unknown as EventEmitterFn
  return { events, emit, eventsOf: (event: string) => events.filter((e) => e.event === event) }
}

interface ManualScheduler {
  queue: Array<{ fn: () => void; ms: number }>
  schedule: (fn: () => void, ms: number) => unknown
  runAll: () => void
}

function makeScheduler(): ManualScheduler {
  const queue: Array<{ fn: () => void; ms: number }> = []
  return {
    queue,
    schedule: (fn, ms) => {
      queue.push({ fn, ms })
      return queue.length
    },
    runAll: () => {
      const pending = queue.splice(0, queue.length)
      for (const item of pending) item.fn()
    },
  }
}

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled'])

async function waitFor(cond: () => boolean, timeoutMs = 5000, label = '条件'): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`等待「${label}」超时`)
    await new Promise((r) => setTimeout(r, 2))
  }
}

function engineFor(
  fake: FakeSftp,
  harness: Harness,
  options: Partial<ConstructorParameters<typeof TransferEngine>[0]> = {},
): TransferEngine {
  return new TransferEngine({
    emit: harness.emit,
    resolveSftp: async () => fake,
    now: () => Date.now(),
    ...options,
  })
}

let workDir: string

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 't1000-sftp-'))
})

afterEach(() => {
  // 只删自己建的临时目录，绝不碰用户数据目录
  rmSync(workDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// 并发闸门
// ---------------------------------------------------------------------------

describe('TransferGate（并发闸门）', () => {
  it('limit=4 时同时获取 10 个槽位，实际并发不超过 4 且能全部完成', async () => {
    let busyEvents = 0
    const gate = new TransferGate(4, (busy) => {
      if (busy) busyEvents++
    })

    let running = 0
    let peak = 0
    const tasks = Array.from({ length: 10 }, async () => {
      const release = await gate.acquire()
      expect(release).not.toBeNull()
      running++
      peak = Math.max(peak, running)
      await new Promise((r) => setTimeout(r, 5))
      running--
      release?.()
    })
    await Promise.all(tasks)

    expect(peak).toBe(4)
    expect(gate.running).toBe(0)
    expect(gate.waiting).toBe(0)
    // busy 只在 0↔有任务 的边界翻转一次进入
    expect(busyEvents).toBe(1)
  })

  it('等待中的槽位可被取消：唤醒后返回 null 且不占用槽位', async () => {
    const gate = new TransferGate(1, () => {})
    const first = await gate.acquire()
    expect(first).not.toBeNull()

    const signal = { cancelled: false }
    let second: (() => void) | null | 'pending' = 'pending'
    void gate.acquire(signal).then((release) => {
      second = release
    })
    await new Promise((r) => setTimeout(r, 0))
    expect(gate.waiting).toBe(1)

    gate.cancelWaiter(signal)
    await new Promise((r) => setTimeout(r, 0))
    expect(second).toBeNull()
    expect(gate.running).toBe(1) // 仍只有第一个占着

    first?.()
    expect(gate.running).toBe(0)
  })
})

describe('并发闸门（任务级）', () => {
  it('同时提交 10 个上传，假 SFTP 观测到的并发不超过 4', async () => {
    const fake = new FakeSftp().addDir('/dst')
    fake.writeDelayMs = 2
    const h = makeEmitter()
    const engine = engineFor(fake, h, { settings: { maxInflightPerConnection: 4 }, chunkSize: 4096 })

    const localFiles: string[] = []
    for (let i = 0; i < 10; i++) {
      const p = join(workDir, `f${i}.bin`)
      writeFileSync(p, Buffer.alloc(32 * 1024, i + 1))
      localFiles.push(p)
    }

    const ids = localFiles.map(
      (p, i) =>
        engine.submit({
          sessionId: 's1',
          direction: 'upload',
          sourcePath: p,
          targetPath: `/dst/f${i}.bin`,
        }).id,
    )

    await waitFor(
      () => ids.every((id) => TERMINAL.has(engine.getTask(id)?.state ?? 'queued')),
      10_000,
      '10 个任务完成',
    )

    for (const id of ids) expect(engine.getTask(id)?.state).toBe('succeeded')
    // 硬要求：每连接并发 ≤ 4
    expect(fake.maxActiveTransfers).toBeLessThanOrEqual(4)
    // 而且确实并行了（不是退化成串行）
    expect(fake.maxActiveTransfers).toBeGreaterThan(1)
    expect(fake.files.size).toBe(10)
    expect(h.eventsOf(Events.SFTP_BUSY).length).toBeGreaterThanOrEqual(2)
  })
})

// ---------------------------------------------------------------------------
// 进度节流
// ---------------------------------------------------------------------------

describe('进度节流', () => {
  it('高频分块只产生少量进度事件（200ms 节流语义）', async () => {
    const content = Buffer.alloc(64, 7)
    const localFile = join(workDir, 'big.bin')
    writeFileSync(localFile, content)

    const fake = new FakeSftp().addDir('/dst')
    const h = makeEmitter()

    // 假时钟：每次 write 前进 1ms；throttle=1000ms ⇒ 整段传输最多 1 次节流事件
    let clock = 0
    fake.onWrite = () => {
      clock++
    }
    const engine = engineFor(fake, h, {
      settings: { progressThrottleMs: 1000 },
      now: () => clock,
      chunkSize: 8, // 64 / 8 = 8 个分块
    })

    const task = engine.submit({
      sessionId: 's1',
      direction: 'upload',
      sourcePath: localFile,
      targetPath: '/dst/big.bin',
    })
    await waitFor(() => TERMINAL.has(engine.getTask(task.id)?.state ?? 'queued'))

    const progress = h.eventsOf(Events.SFTP_TRANSFER_PROGRESS)
    // 8 个分块 ≠ 8 个事件：1 次节流窗口内 + 1 次文件完成的强制收尾
    expect(progress.length).toBe(2)
    expect(fake.writes.length).toBe(8)

    const last = progress[progress.length - 1]?.payload
    expect(last).toMatchObject({ transferredBytes: 64, totalBytes: 64 })
    // 收尾事件不得重复计数：整体字节数就是文件大小
    expect(engine.getTask(task.id)?.bytesDone).toBe(64)
    expect(engine.getTask(task.id)?.filesDone).toBe(1)
  })

  it('分块数远大于事件数（1000 块 → 事件数受节流限制）', async () => {
    const localFile = join(workDir, 'many.bin')
    writeFileSync(localFile, Buffer.alloc(4000, 3))
    const fake = new FakeSftp().addDir('/dst')
    const h = makeEmitter()
    const engine = engineFor(fake, h, {
      settings: { progressThrottleMs: 50 },
      chunkSize: 4, // 1000 块
      now: () => Date.now(),
    })

    const task = engine.submit({
      sessionId: 's1',
      direction: 'upload',
      sourcePath: localFile,
      targetPath: '/dst/many.bin',
    })
    await waitFor(() => TERMINAL.has(engine.getTask(task.id)?.state ?? 'queued'))

    const progress = h.eventsOf(Events.SFTP_TRANSFER_PROGRESS)
    expect(fake.writes.length).toBe(1000)
    // 关键是量级差：事件数只与节流窗口有关，与分块数无关
    expect(progress.length).toBeGreaterThanOrEqual(1)
    expect(progress.length).toBeLessThan(fake.writes.length / 10)
  })
})

// ---------------------------------------------------------------------------
// 冲突策略
// ---------------------------------------------------------------------------

describe('冲突策略', () => {
  const localContent = 'NEW-CONTENT'

  async function conflictUpload(
    policy: 'ask' | 'overwrite' | 'skip' | 'rename',
    extra: Partial<ConstructorParameters<typeof TransferEngine>[0]> = {},
  ): Promise<{ fake: FakeSftp; harness: Harness; engine: TransferEngine; id: string }> {
    const localFile = join(workDir, 'photo.png')
    writeFileSync(localFile, localContent)

    const fake = new FakeSftp().addFile('/dst/photo.png', 'OLD')
    const harness = makeEmitter()
    const engine = engineFor(fake, harness, { settings: { conflictPolicy: policy }, ...extra })
    const task = engine.submit({
      sessionId: 's1',
      direction: 'upload',
      sourcePath: localFile,
      targetPath: '/dst/photo.png',
    })
    await waitFor(() => TERMINAL.has(engine.getTask(task.id)?.state ?? 'queued'))
    return { fake, harness, engine, id: task.id }
  }

  it('overwrite：先 unlink 目标再写入新内容', async () => {
    const { fake, engine, id } = await conflictUpload('overwrite')
    expect(engine.getTask(id)?.state).toBe('succeeded')
    expect(fake.files.get('/dst/photo.png')?.toString()).toBe(localContent)
    expect(fake.unlinked).toContain('/dst/photo.png')
  })

  it('skip：跳过不写，原文件保持不变，仍计入完成文件数', async () => {
    const { fake, engine, id } = await conflictUpload('skip')
    const task = engine.getTask(id)
    expect(task?.state).toBe('succeeded')
    expect(fake.files.get('/dst/photo.png')?.toString()).toBe('OLD')
    expect(fake.writes.length).toBe(0)
    expect(task?.filesDone).toBe(1)
    expect(task?.bytesDone).toBe(0)
    expect(task?.files?.[0]?.error).toContain('已跳过')
  })

  it('rename：写到 name (1).ext，原文件不动', async () => {
    const { fake, engine, id } = await conflictUpload('rename')
    expect(engine.getTask(id)?.state).toBe('succeeded')
    expect(fake.files.get('/dst/photo.png')?.toString()).toBe('OLD')
    expect(fake.files.get('/dst/photo (1).png')?.toString()).toBe(localContent)
  })

  it('ask：无决策器时明确失败（不猜策略、不静默覆盖）', async () => {
    const { fake, harness, engine, id } = await conflictUpload('ask')
    const task = engine.getTask(id)
    expect(task?.state).toBe('failed')
    expect(task?.error).toContain('目标已存在')
    expect(fake.files.get('/dst/photo.png')?.toString()).toBe('OLD')
    expect(harness.eventsOf(Events.SFTP_TRANSFER_ERROR).length).toBe(1)
  })

  it('ask：有决策器时按决策执行（返回 overwrite）', async () => {
    const { fake, engine, id } = await conflictUpload('ask', {
      onConflict: () => 'overwrite',
    })
    expect(engine.getTask(id)?.state).toBe('succeeded')
    expect(fake.files.get('/dst/photo.png')?.toString()).toBe(localContent)
  })
})

// ---------------------------------------------------------------------------
// 续传
// ---------------------------------------------------------------------------

describe('续传语义', () => {
  it('resume=true 从已传字节开始（以追加模式打开，首写位置=已有长度）', async () => {
    const localFile = join(workDir, 'partial.bin')
    writeFileSync(localFile, Buffer.from('0123456789ABCDEF')) // 16 字节
    const fake = new FakeSftp().addFile('/dst/partial.bin', '0123456789') // 远端已有 10 字节

    const h = makeEmitter()
    const engine = engineFor(fake, h, { chunkSize: 4 })
    const task = engine.submit({
      sessionId: 's1',
      direction: 'upload',
      sourcePath: localFile,
      targetPath: '/dst/partial.bin',
      resume: true,
    })
    await waitFor(() => TERMINAL.has(engine.getTask(task.id)?.state ?? 'queued'))

    expect(engine.getTask(task.id)?.state).toBe('succeeded')
    expect(fake.opened[0]).toEqual({ path: '/dst/partial.bin', mode: 'a' })
    expect(fake.writes[0]?.position).toBe(10)
    expect(fake.files.get('/dst/partial.bin')?.toString()).toBe('0123456789ABCDEF')
    // 续传不应删除既有文件
    expect(fake.unlinked).not.toContain('/dst/partial.bin')
  })

  it('resume=false 覆盖前先 unlink，从头写入', async () => {
    const localFile = join(workDir, 'full.bin')
    writeFileSync(localFile, Buffer.from('0123456789ABCDEF'))
    const fake = new FakeSftp().addFile('/dst/full.bin', '0123456789')

    const h = makeEmitter()
    const engine = engineFor(fake, h, { chunkSize: 4 })
    const task = engine.submit({
      sessionId: 's1',
      direction: 'upload',
      sourcePath: localFile,
      targetPath: '/dst/full.bin',
      conflictPolicy: 'overwrite',
    })
    await waitFor(() => TERMINAL.has(engine.getTask(task.id)?.state ?? 'queued'))

    expect(fake.unlinked).toContain('/dst/full.bin')
    expect(fake.opened[0]?.mode).toBe('w')
    expect(fake.writes[0]?.position).toBe(0)
    expect(fake.files.get('/dst/full.bin')?.toString()).toBe('0123456789ABCDEF')
  })
})

// ---------------------------------------------------------------------------
// 取消
// ---------------------------------------------------------------------------

describe('取消', () => {
  it('运行中取消：状态流转到 cancelled，约 100ms 后才回一次完成事件', async () => {
    const localFile = join(workDir, 'slow.bin')
    writeFileSync(localFile, Buffer.alloc(64 * 1024, 5))

    const fake = new FakeSftp().addDir('/dst')
    fake.writeDelayMs = 4
    const h = makeEmitter()
    const scheduler = makeScheduler()
    const engine = engineFor(fake, h, { chunkSize: 4096, schedule: scheduler.schedule })

    const task = engine.submit({
      sessionId: 's1',
      direction: 'upload',
      sourcePath: localFile,
      targetPath: '/dst/slow.bin',
    })

    await waitFor(() => fake.writes.length >= 2, 5000, '传输已开始')
    expect(engine.cancel(task.id)).toBe(true)
    expect(engine.getTask(task.id)?.state).toBe('cancelling')

    await waitFor(() => engine.getTask(task.id)?.state === 'cancelled', 5000, '状态变为 cancelled')
    // 完成事件被延迟，此刻还没发
    expect(h.eventsOf(Events.SFTP_TRANSFER_FINISHED).length).toBe(0)
    expect(scheduler.queue.length).toBe(1)
    expect(scheduler.queue[0]?.ms).toBe(100)

    scheduler.runAll()
    expect(h.eventsOf(Events.SFTP_TRANSFER_FINISHED).length).toBe(1)
    // 取消不是错误
    expect(h.eventsOf(Events.SFTP_TRANSFER_ERROR).length).toBe(0)
    // 重复取消无效
    expect(engine.cancel(task.id)).toBe(false)
  })

  it('排队中取消：等待闸门的任务能被立刻唤醒取消', async () => {
    const slowLocal = join(workDir, 'slow.bin')
    const queuedLocal = join(workDir, 'queued.bin')
    writeFileSync(slowLocal, Buffer.alloc(64 * 1024, 1))
    writeFileSync(queuedLocal, Buffer.alloc(64 * 1024, 2))

    const fake = new FakeSftp().addDir('/dst')
    fake.writeDelayMs = 4
    const h = makeEmitter()
    const scheduler = makeScheduler()
    // 只允许 1 个并发，好让第二个任务真的排队
    const engine = engineFor(fake, h, {
      chunkSize: 4096,
      schedule: scheduler.schedule,
      settings: { maxInflightPerConnection: 1 },
    })

    const first = engine.submit({
      sessionId: 's1',
      direction: 'upload',
      sourcePath: slowLocal,
      targetPath: '/dst/slow.bin',
    })
    await waitFor(() => fake.writes.length >= 2, 5000, '第一个任务开始')

    const second = engine.submit({
      sessionId: 's1',
      direction: 'upload',
      sourcePath: queuedLocal,
      targetPath: '/dst/queued.bin',
    })
    await waitFor(() => engine.getTask(second.id)?.state === 'queued', 2000, '第二个任务排队')

    expect(engine.cancel(second.id)).toBe(true)
    await waitFor(() => engine.getTask(second.id)?.state === 'cancelled', 2000, '排队任务被取消')
    // 第一个任务不受影响，仍在跑
    expect(engine.getTask(first.id)?.state).toBe('running')

    scheduler.runAll()
    await waitFor(() => TERMINAL.has(engine.getTask(first.id)?.state ?? 'queued'), 5000)
    expect(engine.getTask(first.id)?.state).toBe('succeeded')
    expect(h.eventsOf(Events.SFTP_TRANSFER_FINISHED).length).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// 递归
// ---------------------------------------------------------------------------

describe('目录递归', () => {
  it('上传目录：先扫描发 SFTP_DIR_SCANNED，再逐文件传输并建好目录结构', async () => {
    // 本地树：src/{a.txt, sub/{b.txt, c.txt}}
    const src = join(workDir, 'src')
    mkdirSync(join(src, 'sub'), { recursive: true })
    writeFileSync(join(src, 'a.txt'), 'AAAA')
    writeFileSync(join(src, 'sub', 'b.txt'), 'BBBBBB')
    writeFileSync(join(src, 'sub', 'c.txt'), 'CC')

    const fake = new FakeSftp().addDir('/target')
    const h = makeEmitter()
    const engine = engineFor(fake, h, { chunkSize: 4 })
    const task = engine.submit({
      sessionId: 's1',
      direction: 'upload',
      sourcePath: src,
      targetPath: '/target',
      recursive: true,
    })

    await waitFor(() => TERMINAL.has(engine.getTask(task.id)?.state ?? 'queued'), 10_000, '递归上传完成')

    const t = engine.getTask(task.id)
    expect(t?.state).toBe('succeeded')
    expect(t?.filesTotal).toBe(3)
    expect(t?.bytesTotal).toBe(12)
    expect(t?.bytesDone).toBe(12)

    // 目标已存在 → 在其下用源目录名（scp/cp 语义）
    expect(fake.files.get('/target/src/a.txt')?.toString()).toBe('AAAA')
    expect(fake.files.get('/target/src/sub/b.txt')?.toString()).toBe('BBBBBB')
    expect(fake.files.get('/target/src/sub/c.txt')?.toString()).toBe('CC')
    expect(fake.dirs.has('/target/src/sub')).toBe(true)

    const scanned = h.eventsOf(Events.SFTP_DIR_SCANNED)
    expect(scanned.length).toBeGreaterThanOrEqual(1)
    expect(scanned[scanned.length - 1]?.payload).toMatchObject({ files: 3, bytes: 12 })
  })

  it('下载目录：扫描远端的 filesTotal/bytesTotal，并递归落到本地', async () => {
    const fake = new FakeSftp()
      .addFile('/remote/pkg/x.txt', 'XXXX')
      .addFile('/remote/pkg/sub/y.txt', 'YY')

    const h = makeEmitter()
    const engine = engineFor(fake, h, { chunkSize: 4 })
    const target = join(workDir, 'dl')
    mkdirSync(target, { recursive: true })

    const task = engine.submit({
      sessionId: 's1',
      direction: 'download',
      sourcePath: '/remote/pkg',
      targetPath: target,
      recursive: true,
    })
    await waitFor(() => TERMINAL.has(engine.getTask(task.id)?.state ?? 'queued'), 10_000, '递归下载完成')

    const t = engine.getTask(task.id)
    expect(t?.state).toBe('succeeded')
    expect(t?.filesTotal).toBe(2)
    expect(t?.bytesTotal).toBe(6)

    const scanned = h.eventsOf(Events.SFTP_DIR_SCANNED)
    expect(scanned[scanned.length - 1]?.payload).toMatchObject({ files: 2, bytes: 6 })
  })

  it('非递归传目录：明确报错而不是静默半途而废', async () => {
    const src = join(workDir, 'src2')
    mkdirSync(src, { recursive: true })
    writeFileSync(join(src, 'a.txt'), 'A')

    const fake = new FakeSftp().addDir('/target')
    const h = makeEmitter()
    const engine = engineFor(fake, h)
    const task = engine.submit({
      sessionId: 's1',
      direction: 'upload',
      sourcePath: src,
      targetPath: '/target',
      recursive: false,
    })
    await waitFor(() => TERMINAL.has(engine.getTask(task.id)?.state ?? 'queued'))
    expect(engine.getTask(task.id)?.state).toBe('failed')
    expect(engine.getTask(task.id)?.error).toContain('recursive=true')
  })
})

// ---------------------------------------------------------------------------
// 队列查询
// ---------------------------------------------------------------------------

describe('任务查询与历史', () => {
  it('listTransfers 按会话过滤并返回副本（外部改动不影响引擎）', async () => {
    const localFile = join(workDir, 'a.txt')
    writeFileSync(localFile, 'A')
    const fake = new FakeSftp().addDir('/dst')
    const h = makeEmitter()
    const engine = engineFor(fake, h)

    engine.submit({ sessionId: 's1', direction: 'upload', sourcePath: localFile, targetPath: '/dst/a.txt' })
    engine.submit({ sessionId: 's2', direction: 'upload', sourcePath: localFile, targetPath: '/dst/b.txt' })

    const s1 = engine.listTransfers('s1')
    expect(s1.length).toBe(1)
    expect(engine.listTransfers().length).toBe(2)

    s1[0]!.state = 'failed'
    expect(engine.listTransfers('s1')[0]?.state).not.toBe('failed')
    await waitFor(() => !engine.hasActive(), 5000)
  })

  it('会话不可用时任务失败为 NOT_CONNECTED', async () => {
    const localFile = join(workDir, 'a.txt')
    writeFileSync(localFile, 'A')
    const h = makeEmitter()
    const engine = new TransferEngine({
      emit: h.emit,
      resolveSftp: async () => {
        throw new Error('通道已断开')
      },
    })
    const task = engine.submit({
      sessionId: 'gone',
      direction: 'upload',
      sourcePath: localFile,
      targetPath: '/dst/a.txt',
    })
    await waitFor(() => TERMINAL.has(engine.getTask(task.id)?.state ?? 'queued'))
    expect(engine.getTask(task.id)?.state).toBe('failed')
    expect(h.eventsOf(Events.SFTP_TRANSFER_ERROR).length).toBe(1)
  })
})
