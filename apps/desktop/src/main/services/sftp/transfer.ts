// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * SFTP 上传/下载引擎：队列、并发闸门、递归、进度、抢占式取消、冲突、续传。
 *
 * 性能设计（对应 docs/PERFORMANCE-GOALS.md「文件传输」一节）：
 * - **流式分块**：本地与远端都用 handle + 定长缓冲，任何一个文件都不整块进内存；
 * - **可配置并发闸门**（默认 4/连接，参考实现同值但写死，我们可动态配）；
 * - **进度事件节流**（默认 200ms，与参考实现对齐），高频 chunk 不产生高频 IPC；
 * - **扫描与传输分阶段**：递归先扫描出 filesTotal/bytesTotal 再执行，扫描期间
 *   持续发 SFTP_DIR_SCANNED，10000 文件的目录也有人反馈，不会看起来卡死；
 * - **取消精确到 transferId**：分块边界检查，取消后约 100ms 回完成事件供 UI 过渡。
 *
 * 可测性设计：时钟（now）、延迟调度（schedule）、本地文件系统（local）、
 * 远端 SFTP（resolveSftp）全部可注入，单测因此不需要真实主机，也不需要真的等 200ms。
 */

import { randomUUID } from 'node:crypto'
import * as fsp from 'node:fs/promises'
import { basename, join as joinLocal, relative as relativeLocal, sep as localSep } from 'node:path'
import { Events } from '@t1000/shared'
import type {
  ConflictPolicy,
  TransferFile,
  TransferRequest,
  TransferSettings,
  TransferState,
  TransferTask,
} from '@t1000/shared'
import type { EventEmitterFn } from '../../ipc/router'
import { AppError } from '../../errors'
import {
  CancelledScanError,
  ensureRemoteDirectory,
  isNoSuchFile,
  pathExists,
  scanRemoteTree,
  sftpFs,
  type RemoteFileInfo,
  type SftpLike,
} from './browser'
import {
  basenameRemotePath,
  dirnameRemotePath,
  joinRemotePath,
  normalizeRemotePath,
  numberedName,
} from './paths'

/** 分块大小：64 KiB 是吞吐与事件循环占用的折中 */
const DEFAULT_CHUNK_SIZE = 64 * 1024
/** 取消后延迟回完成事件的毫秒数（给 UI 留过渡时间，与参考实现一致） */
const CANCEL_ACK_DELAY_MS = 100
/** listTransfers 里每个任务最多保留的文件明细条数（万级目录不能进内存） */
const MAX_TRACKED_FILES = 200
/** 任务历史上限，超出后淘汰最早的已结束任务 */
const DEFAULT_MAX_TASKS = 500

const DEFAULT_SETTINGS: TransferSettings = {
  maxInflightPerConnection: 4,
  progressThrottleMs: 200,
  conflictPolicy: 'ask',
  preservePermissions: false,
  preserveTimestamps: false,
}

/** 传输被取消的内部信号（不跨模块暴露） */
class CancelledTransferError extends Error {
  constructor() {
    super('传输已取消')
    this.name = 'CancelledTransferError'
  }
}

/** 取消信号：引擎内部用可变对象，队列里等待的闸门也能被唤醒 */
interface CancelSignal {
  cancelled: boolean
}

export interface ConflictInfo {
  sessionId: string
  direction: 'upload' | 'download'
  /** 已存在的目标路径 */
  targetPath: string
  /** 源路径 */
  sourcePath: string
  /** 已传输的文件数（目录任务时有用） */
  filesDone: number
}

export interface TransferLogger {
  warn(message: string, extra?: unknown): void
  error(message: string, extra?: unknown): void
}

// ---------------------------------------------------------------------------
// 本地文件系统抽象
//
// 抽出来有两个目的：单测注入可控实现、以及避免引擎到处直接依赖 node:fs。
// 默认实现（nodeLocalIo）就是 fs/promises 的薄包装。
// ---------------------------------------------------------------------------

export interface LocalStats {
  size: number
  mtimeMs: number
  mode: number
  isDirectory(): boolean
  isFile(): boolean
  isSymbolicLink(): boolean
}

export interface LocalDirEntry {
  name: string
  isDirectory(): boolean
  isFile(): boolean
  isSymbolicLink(): boolean
}

export interface LocalHandle {
  /** @returns 实际读到的字节数；0 表示已到文件末尾 */
  read(buffer: Buffer, offset: number, length: number, position: number): Promise<number>
  write(buffer: Buffer, offset: number, length: number, position: number): Promise<void>
  close(): Promise<void>
  stat(): Promise<{ size: number; mode: number }>
}

export interface LocalIo {
  stat(path: string): Promise<LocalStats>
  readdir(path: string): Promise<LocalDirEntry[]>
  open(path: string, flags: 'r' | 'w' | 'a'): Promise<LocalHandle>
  /** 递归建目录 */
  mkdir(path: string): Promise<void>
  unlink(path: string): Promise<void>
  chmod?(path: string, mode: number): Promise<void>
  utimes?(path: string, atime: number, mtime: number): Promise<void>
}

/** 默认本地实现：node:fs/promises */
export const nodeLocalIo: LocalIo = {
  async stat(p) {
    const s = await fsp.stat(p)
    return {
      size: s.size,
      mtimeMs: s.mtimeMs,
      mode: s.mode,
      isDirectory: () => s.isDirectory(),
      isFile: () => s.isFile(),
      isSymbolicLink: () => s.isSymbolicLink(),
    }
  },
  async readdir(p) {
    const list = await fsp.readdir(p, { withFileTypes: true })
    return list.map((d) => ({
      name: d.name,
      isDirectory: () => d.isDirectory(),
      isFile: () => d.isFile(),
      isSymbolicLink: () => d.isSymbolicLink(),
    }))
  },
  async open(p, flags) {
    const handle = await fsp.open(p, flags)
    return {
      read: async (buffer, offset, length, position) =>
        (await handle.read(buffer, offset, length, position)).bytesRead,
      write: async (buffer, offset, length, position) => {
        await handle.write(buffer, offset, length, position)
      },
      close: () => handle.close(),
      stat: async () => {
        const s = await handle.stat()
        return { size: s.size, mode: s.mode }
      },
    }
  },
  async mkdir(p) {
    await fsp.mkdir(p, { recursive: true })
  },
  async unlink(p) {
    await fsp.unlink(p)
  },
  async chmod(p, mode) {
    await fsp.chmod(p, mode)
  },
  async utimes(p, atime, mtime) {
    await fsp.utimes(p, atime, mtime)
  },
}

export interface TransferEngineOptions {
  emit: EventEmitterFn
  /** 按 sessionId 取该连接的 SFTP 通道 */
  resolveSftp: (sessionId: string) => Promise<SftpLike>
  settings?: Partial<TransferSettings>
  local?: LocalIo
  /** 可注入时钟（默认 Date.now），单测用它做确定性节流断言 */
  now?: () => number
  /** 可注入延迟调度（默认 setTimeout），取消的 100ms 延迟走它 */
  schedule?: (fn: () => void, ms: number) => unknown
  /** 冲突策略为 ask 时的决策回调；未提供则按「拒绝并报冲突」处理 */
  onConflict?: (info: ConflictInfo) => Promise<ConflictPolicy> | ConflictPolicy
  chunkSize?: number
  maxTasks?: number
  logger?: TransferLogger
  /** 递归扫描的进度回调频率（条目数），默认 200 */
  scanProgressEvery?: number
}

interface InternalTask {
  task: TransferTask
  signal: CancelSignal
  /** 终态已完成结算（防止重复发完成/错误事件） */
  settled: boolean
  /** 完成事件是否已发（取消路径有 100ms 延迟） */
  finishNotified: boolean
  startedAtMs: number
  /** 上次进度事件时刻（节流用） */
  lastProgressAt: number
}

/** 闸门释放函数 */
type Release = () => void

interface GateWaiter {
  signal?: CancelSignal
  granted: boolean
  cancelled: boolean
  wake: () => void
}

/**
 * 每连接并发闸门。
 * 单独成类是为了能被独立测试：并发上限必须可证明，而不是"看起来没超"。
 */
export class TransferGate {
  private active = 0
  private readonly queue: GateWaiter[] = []

  constructor(
    readonly limit: number,
    private readonly onBusyChange: (busy: boolean) => void,
    private readonly onIdleDrained?: () => void,
  ) {}

  get running(): number {
    return this.active
  }

  get waiting(): number {
    return this.queue.length
  }

  /**
   * 取一个槽位。
   * @returns 释放函数；若等待期间被取消则返回 null（此时未占用槽位）
   */
  async acquire(signal?: CancelSignal): Promise<Release | null> {
    if (signal?.cancelled) return null

    if (this.active < this.limit) {
      this.active++
      if (this.active === 1) this.onBusyChange(true)
      return this.makeRelease()
    }

    const waiter: GateWaiter = {
      ...(signal ? { signal } : {}),
      granted: false,
      cancelled: false,
      wake: () => {},
    }
    await new Promise<void>((resolve) => {
      waiter.wake = resolve
      this.queue.push(waiter)
    })

    if (!waiter.granted) return null
    return this.makeRelease()
  }

  /** 把等待队列里对应信号的等待者标记取消并唤醒（不占槽位） */
  cancelWaiter(signal: CancelSignal): void {
    for (const waiter of this.queue) {
      if (waiter.signal === signal && !waiter.cancelled) {
        waiter.cancelled = true
        waiter.wake()
      }
    }
  }

  private makeRelease(): Release {
    let released = false
    return () => {
      if (released) return
      released = true
      this.active--
      if (this.active < 0) this.active = 0
      if (this.active === 0) {
        this.onBusyChange(false)
        this.onIdleDrained?.()
      }
      this.pump()
    }
  }

  /** 有空槽就把等待队列里还没被取消的人放进来 */
  private pump(): void {
    while (this.active < this.limit && this.queue.length > 0) {
      const waiter = this.queue.shift()
      if (!waiter) return
      if (waiter.cancelled || waiter.signal?.cancelled) {
        waiter.cancelled = true
        waiter.wake()
        continue
      }
      waiter.granted = true
      this.active++
      if (this.active === 1) this.onBusyChange(true)
      waiter.wake()
    }
  }
}

/** 本地递归扫描结果 */
interface LocalTree {
  root: string
  dirs: string[]
  files: Array<{ relativePath: string; absolutePath: string; size: number; mtimeMs: number; mode: number }>
  filesTotal: number
  bytesTotal: number
}

export class TransferEngine {
  /** 可变：IPC 上下文可能在引擎创建后才拿到最终的广播函数 */
  private emit: EventEmitterFn
  private readonly resolveSftp: (sessionId: string) => Promise<SftpLike>
  private readonly settings: TransferSettings
  private readonly local: LocalIo
  private readonly now: () => number
  private readonly schedule: (fn: () => void, ms: number) => unknown
  private readonly onConflict?: (info: ConflictInfo) => Promise<ConflictPolicy> | ConflictPolicy
  private readonly chunkSize: number
  private readonly maxTasks: number
  private readonly logger?: TransferLogger
  private readonly scanProgressEvery: number

  private readonly tasks = new Map<string, InternalTask>()
  /** 任务 id 顺序（老 → 新），用于 listTransfers 与历史淘汰 */
  private readonly order: string[] = []
  private readonly gates = new Map<string, TransferGate>()

  constructor(options: TransferEngineOptions) {
    this.emit = options.emit
    this.resolveSftp = options.resolveSftp
    this.settings = { ...DEFAULT_SETTINGS, ...options.settings }
    this.local = options.local ?? nodeLocalIo
    this.now = options.now ?? (() => Date.now())
    this.schedule = options.schedule ?? ((fn, ms) => setTimeout(fn, ms))
    if (options.onConflict) this.onConflict = options.onConflict
    this.chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE
    this.maxTasks = options.maxTasks ?? DEFAULT_MAX_TASKS
    if (options.logger) this.logger = options.logger
    this.scanProgressEvery = options.scanProgressEvery ?? 200
  }

  /** 运行时替换事件发送器（IPC 上下文可能在首次调用前还没准备好） */
  setEmitter(emit: EventEmitterFn): void {
    this.emit = emit
  }

  // -------------------------------------------------------------------------
  // 对外 API
  // -------------------------------------------------------------------------

  /**
   * 提交一个传输任务。立即返回任务快照，执行在后台推进。
   * 参数非法（路径为空 / 越界）时同步抛错，让 IPC 边界直接返回 BAD_REQUEST。
   */
  submit(request: TransferRequest): TransferTask {
    if (!request.sessionId) throw AppError.badRequest('缺少 sessionId')
    if (request.direction !== 'upload' && request.direction !== 'download') {
      throw AppError.badRequest(`未知传输方向: ${String(request.direction)}`)
    }
    if (!request.sourcePath) throw AppError.badRequest('源路径不能为空')
    if (!request.targetPath) throw AppError.badRequest('目标路径不能为空')

    const id = randomUUID()
    const task: TransferTask = {
      id,
      sessionId: request.sessionId,
      direction: request.direction,
      state: 'queued',
      sourcePath: request.sourcePath,
      targetPath: request.targetPath,
      createdAt: new Date(this.now()).toISOString(),
      recursive: request.recursive ?? false,
      filesTotal: 0,
      filesDone: 0,
      bytesTotal: 0,
      bytesDone: 0,
      speed: 0,
      conflictPolicy: request.conflictPolicy ?? this.settings.conflictPolicy,
      resume: request.resume ?? false,
      files: [],
    }

    const internal: InternalTask = {
      task,
      signal: { cancelled: false },
      settled: false,
      finishNotified: false,
      startedAtMs: 0,
      lastProgressAt: Number.NEGATIVE_INFINITY,
    }
    this.tasks.set(id, internal)
    this.order.push(id)
    this.trimHistory()

    void this.run(internal, request)
    return snapshot(task)
  }

  /** 按 transferId 精确取消 */
  cancel(transferId: string): boolean {
    const internal = this.tasks.get(transferId)
    if (!internal || internal.settled) return false

    internal.signal.cancelled = true
    internal.task.state = 'cancelling'
    // 等待闸门的任务必须被唤醒，否则取消要等到前序任务让位才生效
    for (const gate of this.gates.values()) gate.cancelWaiter(internal.signal)
    return true
  }

  /** 列出任务（可按会话过滤） */
  listTransfers(sessionId?: string): TransferTask[] {
    const out: TransferTask[] = []
    for (const id of this.order) {
      const internal = this.tasks.get(id)
      if (!internal) continue
      if (sessionId && internal.task.sessionId !== sessionId) continue
      out.push(snapshot(internal.task))
    }
    return out
  }

  getTask(transferId: string): TransferTask | undefined {
    const internal = this.tasks.get(transferId)
    return internal ? snapshot(internal.task) : undefined
  }

  /** 测试与关停用：某会话是否还有活跃任务 */
  hasActive(sessionId?: string): boolean {
    for (const internal of this.tasks.values()) {
      if (sessionId && internal.task.sessionId !== sessionId) continue
      if (!internal.settled) return true
    }
    return false
  }

  // -------------------------------------------------------------------------
  // 任务执行
  // -------------------------------------------------------------------------

  private async run(internal: InternalTask, request: TransferRequest): Promise<void> {
    const { task } = internal
    internal.startedAtMs = this.now()
    task.startedAt = new Date(this.now()).toISOString()

    try {
      if (request.direction === 'upload') {
        await this.runUpload(internal, request)
      } else {
        await this.runDownload(internal, request)
      }
      this.finishSuccess(internal)
    } catch (err) {
      if (err instanceof CancelledTransferError || err instanceof CancelledScanError) {
        this.finishCancelled(internal)
        return
      }
      this.finishFailed(internal, err)
    }
  }

  // ------------------------------- 上传 ------------------------------------

  private async runUpload(internal: InternalTask, request: TransferRequest): Promise<void> {
    const { task } = internal
    const sftp = await this.resolveSftpFor(internal)

    // 源在本地
    const sourceStats = await this.local.stat(request.sourcePath).catch((err: unknown) => {
      throw AppError.notFound(`本地源路径不可用: ${request.sourcePath}（${errorMessage(err)}）`)
    })

    if (sourceStats.isDirectory()) {
      if (!request.recursive) {
        throw AppError.badRequest(`源是目录，需要 recursive=true: ${request.sourcePath}`)
      }
      // 目录：先扫描（占用一个槽位，避免大量扫描同时压垮通道）
      task.state = 'scanning'
      const tree = await this.withSlot(internal, () => this.scanLocalTree(internal, request.sourcePath))
      task.filesTotal = tree.filesTotal
      task.bytesTotal = tree.bytesTotal
      this.emitDirScanned(internal, request.sourcePath, tree.filesTotal, tree.bytesTotal)

      task.state = 'running'
      const destRoot = await this.resolveDestRoot(internal, sftp, {
        sourceName: basename(request.sourcePath),
        rawTarget: request.targetPath,
        sourceIsDir: true,
        targetRawLooksLikeDir: request.targetPath.endsWith('/'),
      })

      // 目录结构先建好（远端），文件逐个过闸门
      await this.withSlot(internal, async () => {
        await ensureRemoteDirectory(sftp, destRoot)
        for (const rel of tree.dirs) {
          this.throwIfCancelled(internal)
          await ensureRemoteDirectory(sftp, joinRemotePath(destRoot, rel))
        }
      })

      for (const file of tree.files) {
        this.throwIfCancelled(internal)
        const dest = joinRemotePath(destRoot, file.relativePath)
        await this.transferOneUpload(internal, sftp, file.absolutePath, dest, {
          size: file.size,
          mode: file.mode,
          mtimeMs: file.mtimeMs,
        })
      }
      return
    }

    // 单文件
    task.state = 'running'
    const destRoot = await this.resolveDestRoot(internal, sftp, {
      sourceName: basename(request.sourcePath),
      rawTarget: request.targetPath,
      sourceIsDir: false,
      targetRawLooksLikeDir: request.targetPath.endsWith('/'),
    })
    await this.transferOneUpload(internal, sftp, request.sourcePath, destRoot, {
      size: sourceStats.size,
      mode: sourceStats.mode,
      mtimeMs: sourceStats.mtimeMs,
    })
  }

  /** 上传单个文件（含续传/冲突/权限保留） */
  private async transferOneUpload(
    internal: InternalTask,
    sftp: SftpLike,
    localPath: string,
    remotePathRaw: string,
    meta: { size: number; mode: number; mtimeMs: number },
  ): Promise<void> {
    const { task } = internal
    let remotePath = normalizeRemotePath(remotePathRaw)
    let offset = 0
    let openMode: 'w' | 'a' = 'w'

    const remoteStats = await this.statOrNull(sftp, remotePath)
    if (task.resume && remoteStats && !remoteStats.isDirectory()) {
      // 续传：远端更大说明本地被换过，从头来（否则会写出坏文件）
      if (remoteStats.size <= meta.size) {
        offset = remoteStats.size
        openMode = 'a'
      }
    } else if (remoteStats) {
      const decision = await this.resolveConflict(internal, remotePath, localPath)
      if (decision === 'skip') {
        this.recordFile(internal, remotePath, localPath, meta.size, 0, 'succeeded', '已跳过（目标已存在）')
        task.filesTotal = Math.max(task.filesTotal, task.filesDone + 1)
        return
      }
      if (decision === 'rename') {
        const renamed = await this.nextFreeRemoteName(sftp, remotePath)
        remotePath = renamed
        this.logger?.warn(`目标已存在，重命名为 ${renamed}`)
      } else {
        // overwrite：先删目标，避免残留旧内容（POSIX rename 之外的写不会自动截断）
        if (!remoteStats.isDirectory()) await sftpFs.unlink(sftp, remotePath)
        else throw AppError.conflict(`目标已存在且是目录: ${remotePath}`)
      }
    }

    const fileEntry = this.beginFile(internal, remotePath, localPath, meta.size)
    if (task.filesTotal === 0) task.filesTotal = 1

    const release = await this.gateFor(task.sessionId).acquire(internal.signal)
    if (!release) throw new CancelledTransferError()

    let localHandle: Awaited<ReturnType<LocalIo['open']>> | null = null
    let remoteHandle: Buffer | null = null
    try {
      localHandle = await this.local.open(localPath, 'r')
      remoteHandle = await sftpFs.open(sftp, remotePath, openMode)

      const buffer = Buffer.allocUnsafe(this.chunkSize)
      let position = offset
      while (position < meta.size) {
        this.throwIfCancelled(internal)
        const want = Math.min(this.chunkSize, meta.size - position)
        const bytesRead = await localHandle.read(buffer, 0, want, position)
        if (bytesRead <= 0) break
        await sftpFs.write(sftp, remoteHandle, buffer, 0, bytesRead, position)
        position += bytesRead
        this.reportFileProgress(internal, remotePath, position, meta.size)
      }

      if (this.settings.preservePermissions) {
        await sftpFs.chmod(sftp, remotePath, meta.mode & 0o7777).catch((err: unknown) => {
          this.logger?.warn(`保留远端权限失败: ${remotePath}`, err)
        })
      }
      if (this.settings.preserveTimestamps && sftp.utimes) {
        const seconds = meta.mtimeMs / 1000
        await sftpFs.utimes(sftp, remotePath, seconds, seconds).catch((err: unknown) => {
          this.logger?.warn(`保留远端时间戳失败: ${remotePath}`, err)
        })
      }

      this.completeFile(internal, fileEntry, meta.size)
      // 收尾进度：bytesDone 已含本文件，故整体字节数显式覆盖，避免重复计数
      this.reportFileProgress(internal, remotePath, meta.size, meta.size, true, task.bytesDone)
    } finally {
      if (remoteHandle) await sftpFs.close(sftp, remoteHandle).catch(() => {})
      if (localHandle) await localHandle.close().catch(() => {})
      release()
    }
  }

  // ------------------------------- 下载 ------------------------------------

  private async runDownload(internal: InternalTask, request: TransferRequest): Promise<void> {
    const { task } = internal
    const sftp = await this.resolveSftpFor(internal)
    const remoteSource = normalizeRemotePath(request.sourcePath)
    const sourceStats = await this.statOrNull(sftp, remoteSource)
    if (!sourceStats) throw AppError.notFound(`远端源路径不存在: ${remoteSource}`)

    if (sourceStats.isDirectory()) {
      if (!request.recursive) {
        throw AppError.badRequest(`源是目录，需要 recursive=true: ${remoteSource}`)
      }
      task.state = 'scanning'
      const tree = await this.withSlot(internal, () =>
        scanRemoteTree(sftp, remoteSource, {
          progressEvery: this.scanProgressEvery,
          isCancelled: () => internal.signal.cancelled,
          onProgress: (p) => this.emitDirScanned(internal, remoteSource, p.files, p.bytes),
        }),
      )
      task.filesTotal = tree.filesTotal
      task.bytesTotal = tree.bytesTotal
      this.emitDirScanned(internal, remoteSource, tree.filesTotal, tree.bytesTotal)

      task.state = 'running'
      const destRoot = await this.resolveDestRootLocal(internal, {
        sourceName: basenameRemotePath(remoteSource),
        rawTarget: request.targetPath,
        sourceIsDir: true,
        targetRawLooksLikeDir: request.targetPath.endsWith('/'),
      })

      await this.local.mkdir(destRoot)
      for (const rel of tree.dirs) {
        this.throwIfCancelled(internal)
        await this.local.mkdir(joinLocalRelative(destRoot, rel))
      }

      for (const file of tree.files) {
        this.throwIfCancelled(internal)
        const dest = joinLocalRelative(destRoot, file.relativePath)
        await this.transferOneDownload(internal, sftp, file, dest)
      }
      return
    }

    task.state = 'running'
    const dest = await this.resolveDestRootLocal(internal, {
      sourceName: basenameRemotePath(remoteSource),
      rawTarget: request.targetPath,
      sourceIsDir: false,
      targetRawLooksLikeDir: request.targetPath.endsWith('/'),
    })
    const fileInfo: RemoteFileInfo = {
      relativePath: basenameRemotePath(remoteSource),
      absolutePath: remoteSource,
      size: sourceStats.size,
      mtime: sourceStats.mtime,
      mode: sourceStats.mode & 0o7777,
    }
    await this.transferOneDownload(internal, sftp, fileInfo, dest)
  }

  /** 下载单个文件（含续传/冲突/权限保留） */
  private async transferOneDownload(
    internal: InternalTask,
    sftp: SftpLike,
    file: RemoteFileInfo,
    localPathRaw: string,
  ): Promise<void> {
    const { task } = internal
    let localPath = localPathRaw
    let offset = 0
    let openMode: 'w' | 'a' = 'w'

    const localStats = await this.local.stat(localPath).catch(() => null)

    if (task.resume && localStats && !localStats.isDirectory()) {
      if (localStats.size <= file.size) {
        offset = localStats.size
        openMode = 'a'
      }
    } else if (localStats) {
      const decision = await this.resolveConflict(internal, localPath, file.absolutePath)
      if (decision === 'skip') {
        this.recordFile(internal, file.absolutePath, localPath, file.size, 0, 'succeeded', '已跳过（目标已存在）')
        task.filesTotal = Math.max(task.filesTotal, task.filesDone + 1)
        return
      }
      if (decision === 'rename') {
        localPath = this.nextFreeLocalName(localPath, await this.siblingNames(localPath))
      } else {
        if (localStats.isDirectory()) {
          throw AppError.conflict(`本地目标已存在且是目录: ${localPath}`)
        }
        // 续传为假时覆盖前先删除本地目标（与参考实现一致）
        await this.local.unlink(localPath)
      }
    }

    const fileEntry = this.beginFile(internal, file.absolutePath, localPath, file.size)
    if (task.filesTotal === 0) task.filesTotal = 1

    const release = await this.gateFor(task.sessionId).acquire(internal.signal)
    if (!release) throw new CancelledTransferError()

    let localHandle: Awaited<ReturnType<LocalIo['open']>> | null = null
    let remoteHandle: Buffer | null = null
    try {
      await this.local.mkdir(dirnameLocal(localPath))
      localHandle = await this.local.open(localPath, openMode)
      remoteHandle = await sftpFs.open(sftp, file.absolutePath, 'r')

      const buffer = Buffer.allocUnsafe(this.chunkSize)
      let position = offset
      while (position < file.size) {
        this.throwIfCancelled(internal)
        const want = Math.min(this.chunkSize, file.size - position)
        const bytesRead = await sftpFs.read(sftp, remoteHandle, buffer, 0, want, position)
        if (bytesRead <= 0) break
        await localHandle.write(buffer, 0, bytesRead, position)
        position += bytesRead
        this.reportFileProgress(internal, file.absolutePath, position, file.size)
      }

      if (this.settings.preservePermissions && this.local.chmod) {
        await this.local.chmod(localPath, file.mode & 0o7777).catch((err: unknown) => {
          this.logger?.warn(`保留本地权限失败: ${localPath}`, err)
        })
      }
      if (this.settings.preserveTimestamps && this.local.utimes) {
        const seconds = file.mtime
        await this.local.utimes(localPath, seconds, seconds).catch((err: unknown) => {
          this.logger?.warn(`保留本地时间戳失败: ${localPath}`, err)
        })
      }

      this.completeFile(internal, fileEntry, file.size)
      this.reportFileProgress(internal, file.absolutePath, file.size, file.size, true, task.bytesDone)
    } finally {
      if (remoteHandle) await sftpFs.close(sftp, remoteHandle).catch(() => {})
      if (localHandle) await localHandle.close().catch(() => {})
      release()
    }
  }

  // ------------------------------ 目录扫描 ---------------------------------

  /** 本地目录递归扫描（显式栈，符号链接当文件读取，不跟进） */
  private async scanLocalTree(internal: InternalTask, root: string): Promise<LocalTree> {
    const files: LocalTree['files'] = []
    const dirs: string[] = []
    let bytesTotal = 0
    let scanned = 0

    const stack: Array<{ abs: string; rel: string }> = [{ abs: root, rel: '' }]
    while (stack.length > 0) {
      this.throwIfCancelled(internal)
      const current = stack.pop()
      if (!current) break

      const entries = await this.local.readdir(current.abs)
      for (const entry of entries) {
        this.throwIfCancelled(internal)
        scanned++
        const abs = joinLocal(current.abs, entry.name)
        const rel = current.rel === '' ? entry.name : `${current.rel}/${entry.name}`

        if (entry.isDirectory() && !entry.isSymbolicLink()) {
          dirs.push(rel)
          stack.push({ abs, rel })
        } else {
          const stats = await this.local.stat(abs)
          if (stats.isDirectory()) continue // 竞态：扫到一半变成目录，跳过
          files.push({ relativePath: rel, absolutePath: abs, size: stats.size, mtimeMs: stats.mtimeMs, mode: stats.mode })
          bytesTotal += stats.size
        }

        if (scanned % this.scanProgressEvery === 0) {
          this.emitDirScanned(internal, root, files.length, bytesTotal)
        }
      }
    }
    return { root, dirs, files, filesTotal: files.length, bytesTotal }
  }

  // ------------------------------ 冲突处理 ---------------------------------

  private async resolveConflict(
    internal: InternalTask,
    targetPath: string,
    sourcePath: string,
  ): Promise<'overwrite' | 'skip' | 'rename'> {
    const policy = internal.task.conflictPolicy
    if (policy === 'overwrite') return 'overwrite'
    if (policy === 'skip') return 'skip'
    if (policy === 'rename') return 'rename'
    // ask：交给注入的决策器；没有决策器时明确失败，而不是猜一个
    if (this.onConflict) {
      const decided = await this.onConflict({
        sessionId: internal.task.sessionId,
        direction: internal.task.direction,
        targetPath,
        sourcePath,
        filesDone: internal.task.filesDone,
      })
      if (decided === 'ask') throw AppError.conflict(`目标已存在且未选择处理方式: ${targetPath}`)
      return decided === 'overwrite' || decided === 'skip' || decided === 'rename'
        ? decided
        : 'overwrite'
    }
    throw AppError.conflict(`目标已存在: ${targetPath}（conflictPolicy=ask 需要上层决策）`)
  }

  private async nextFreeRemoteName(sftp: SftpLike, remotePath: string): Promise<string> {
    const dir = dirnameRemotePath(remotePath)
    const name = basenameRemotePath(remotePath)
    for (let i = 1; i <= 10_000; i++) {
      const numbered = numberedName(name, i)
      if (!(await pathExists(sftp, joinRemotePath(dir, numbered)))) {
        return joinRemotePath(dir, numbered)
      }
    }
    throw AppError.conflict(`无法为 ${remotePath} 生成可用的重命名`)
  }

  private nextFreeLocalName(localPath: string, siblings: Set<string>): string {
    const dir = dirnameLocal(localPath)
    const name = basename(localPath)
    for (let i = 1; i <= 10_000; i++) {
      const numbered = numberedName(name, i)
      if (!siblings.has(numbered)) return joinLocal(dir, numbered)
    }
    throw AppError.conflict(`无法为 ${localPath} 生成可用的重命名`)
  }

  private async siblingNames(localPath: string): Promise<Set<string>> {
    const dir = dirnameLocal(localPath)
    const entries = await this.local.readdir(dir).catch(() => [] as LocalDirEntry[])
    return new Set(entries.map((e) => e.name))
  }

  // --------------------------- 目标路径解析 --------------------------------

  /**
   * 目的路径规则（与 scp/cp 一致）：
   * - 目标已存在（或用户以 `/` 结尾指明目录）→ 在目标目录下用源的名字；
   * - 否则目标路径就是源在目的端的最终路径。
   */
  private async resolveDestRoot(
    internal: InternalTask,
    sftp: SftpLike,
    args: { sourceName: string; rawTarget: string; sourceIsDir: boolean; targetRawLooksLikeDir: boolean },
  ): Promise<string> {
    const target = normalizeRemotePath(args.rawTarget)
    const stats = await this.statOrNull(sftp, target)
    const intoDir = args.targetRawLooksLikeDir || stats?.isDirectory() === true
    if (intoDir) return joinRemotePath(target, args.sourceName)
    void args.sourceIsDir
    void internal
    return target
  }

  private async resolveDestRootLocal(
    internal: InternalTask,
    args: { sourceName: string; rawTarget: string; sourceIsDir: boolean; targetRawLooksLikeDir: boolean },
  ): Promise<string> {
    const target = args.rawTarget
    const stats = await this.local.stat(target).catch(() => null)
    const intoDir = args.targetRawLooksLikeDir || stats?.isDirectory() === true
    if (intoDir) return joinLocal(target, args.sourceName)
    void args.sourceIsDir
    void internal
    return target
  }

  // ------------------------------ 状态与事件 -------------------------------

  private beginFile(
    internal: InternalTask,
    remotePath: string,
    localPath: string,
    size: number,
  ): TransferFile {
    const entry: TransferFile = {
      remotePath,
      localPath,
      size,
      transferred: 0,
      state: 'running',
    }
    const files = internal.task.files ?? (internal.task.files = [])
    files.push(entry)
    if (files.length > MAX_TRACKED_FILES) files.shift()
    return entry
  }

  private completeFile(internal: InternalTask, entry: TransferFile, size: number): void {
    entry.transferred = size
    entry.state = 'succeeded'
    internal.task.filesDone++
    internal.task.bytesDone += size
  }

  /** 跳过/失败也记一条明细，UI 才能解释"为什么总数对不上" */
  private recordFile(
    internal: InternalTask,
    remotePath: string,
    localPath: string,
    size: number,
    transferred: number,
    state: TransferState,
    note?: string,
  ): void {
    const entry: TransferFile = {
      remotePath,
      localPath,
      size,
      transferred,
      state,
      ...(note ? { error: note } : {}),
    }
    const files = internal.task.files ?? (internal.task.files = [])
    files.push(entry)
    if (files.length > MAX_TRACKED_FILES) files.shift()
    internal.task.filesDone++
  }

  /**
   * 进度事件节流：默认 200ms 一次（性能关键，参考实现同值）。
   * `force` 用于文件完成/任务结束时的收尾事件，保证 UI 拿到准确的终值。
   */
  private reportFileProgress(
    internal: InternalTask,
    file: string,
    fileTransferred: number,
    fileTotal: number,
    force = false,
    doneOverride?: number,
  ): void {
    const now = this.now()
    if (!force && now - internal.lastProgressAt < this.settings.progressThrottleMs) return
    internal.lastProgressAt = now

    const task = internal.task
    // 传输中：bytesDone 只含已完成文件，加上当前文件已传部分；
    // 文件刚完成时 bytesDone 已包含它，调用方用 doneOverride 显式给出，避免重复计数。
    const done = doneOverride ?? task.bytesDone + fileTransferred
    const elapsedSec = Math.max(0, (now - internal.startedAtMs) / 1000)
    const speed = elapsedSec > 0 ? done / elapsedSec : 0
    task.speed = Math.round(speed)
    if (speed > 0 && task.bytesTotal > 0) {
      task.etaSeconds = Math.max(0, Math.round((task.bytesTotal - done) / speed))
    }

    this.emit(Events.SFTP_TRANSFER_PROGRESS, {
      transferId: task.id,
      sessionId: task.sessionId,
      direction: task.direction,
      file,
      transferredBytes: fileTransferred,
      totalBytes: fileTotal,
      filesDone: task.filesDone,
      filesTotal: task.filesTotal,
      speed: task.speed,
    })
  }

  private emitDirScanned(internal: InternalTask, path: string, files: number, bytes: number): void {
    this.emit(Events.SFTP_DIR_SCANNED, {
      sessionId: internal.task.sessionId,
      path,
      files,
      bytes,
    })
  }

  private finishSuccess(internal: InternalTask): void {
    if (internal.settled) return
    internal.settled = true
    const task = internal.task
    task.state = 'succeeded'
    task.finishedAt = new Date(this.now()).toISOString()
    this.emitFinished(internal)
  }

  private finishFailed(internal: InternalTask, err: unknown): void {
    if (internal.settled) return
    internal.settled = true
    const task = internal.task
    task.state = 'failed'
    task.error = errorMessage(err)
    task.finishedAt = new Date(this.now()).toISOString()
    this.emit(Events.SFTP_TRANSFER_ERROR, {
      transferId: task.id,
      sessionId: task.sessionId,
      message: task.error,
    })
  }

  private finishCancelled(internal: InternalTask): void {
    if (internal.settled) return
    internal.settled = true
    const task = internal.task
    task.state = 'cancelled'
    task.finishedAt = new Date(this.now()).toISOString()
    // 约 100ms 后回完成事件，让 UI 有时间从"取消中"过渡到终态（与参考实现一致）
    this.schedule(() => this.emitFinished(internal), CANCEL_ACK_DELAY_MS)
  }

  private emitFinished(internal: InternalTask): void {
    if (internal.finishNotified) return
    internal.finishNotified = true
    const task = internal.task
    // 收尾进度由每个文件完成时的强制事件负责，这里不再重复发（省一次 IPC）
    this.emit(Events.SFTP_TRANSFER_FINISHED, {
      transferId: task.id,
      sessionId: task.sessionId,
      direction: task.direction,
      files: task.filesDone,
      bytes: task.bytesDone,
      durationMs: Math.max(0, this.now() - internal.startedAtMs),
    })
  }

  // ------------------------------ 基础设施 ---------------------------------

  private async resolveSftpFor(internal: InternalTask): Promise<SftpLike> {
    try {
      return await this.resolveSftp(internal.task.sessionId)
    } catch (err) {
      if (err instanceof AppError) throw err
      throw AppError.notConnected(`SFTP 通道不可用: ${errorMessage(err)}`)
    }
  }

  private gateFor(sessionId: string): TransferGate {
    let gate = this.gates.get(sessionId)
    if (!gate) {
      gate = new TransferGate(this.settings.maxInflightPerConnection, (busy) => {
        this.emit(Events.SFTP_BUSY, { sessionId, busy })
      })
      this.gates.set(sessionId, gate)
    }
    return gate
  }

  private async withSlot<T>(internal: InternalTask, fn: () => Promise<T>): Promise<T> {
    const release = await this.gateFor(internal.task.sessionId).acquire(internal.signal)
    if (!release) throw new CancelledTransferError()
    try {
      return await fn()
    } finally {
      release()
    }
  }

  private throwIfCancelled(internal: InternalTask): void {
    if (internal.signal.cancelled) throw new CancelledTransferError()
  }

  private async statOrNull(sftp: SftpLike, path: string) {
    const p = normalizeRemotePath(path)
    try {
      return await sftpFs.stat(sftp, p)
    } catch (err) {
      if (isNoSuchFile(err)) return null
      throw err
    }
  }

  private trimHistory(): void {
    while (this.order.length > this.maxTasks) {
      const oldest = this.order[0]
      if (oldest === undefined) break
      const internal = this.tasks.get(oldest)
      // 只淘汰已结算的任务；活跃任务必须留着，否则取消/查询会找不到
      if (internal && !internal.settled) break
      this.order.shift()
      this.tasks.delete(oldest)
      if (internal) this.maybeDisposeGate(internal.task.sessionId)
    }
  }

  /** 某会话已无任务时释放闸门，避免长时间运行后 Map 无限增长 */
  private maybeDisposeGate(sessionId: string): void {
    for (const internal of this.tasks.values()) {
      if (internal.task.sessionId === sessionId) return
    }
    this.gates.delete(sessionId)
  }
}

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

/** 对外返回的副本，避免调用方改到引擎内部状态 */
function snapshot(task: TransferTask): TransferTask {
  return {
    ...task,
    ...(task.files ? { files: task.files.map((f) => ({ ...f })) } : {}),
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** 本地相对路径 → 绝对路径（用宿主分隔符） */
function joinLocalRelative(root: string, relativePath: string): string {
  const safe = relativePath.split('/').filter((s) => s !== '' && s !== '.' && s !== '..')
  return joinLocal(root, ...safe)
}

function dirnameLocal(p: string): string {
  const idx = p.lastIndexOf(localSep)
  if (idx <= 0) return p.startsWith(localSep) ? localSep : '.'
  return p.slice(0, idx)
}

/** 把内部路径拼装函数导出给测试复用 */
export { joinLocalRelative }
