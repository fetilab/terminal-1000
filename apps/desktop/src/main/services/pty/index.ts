// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * pty 域：本地终端（node-pty）+ shell profile。
 *
 * 动作清单见 packages/shared/src/ipc.ts 的 Actions.pty：
 * open / close / write / resize / list / listProfiles / listShells。
 *
 * 性能设计（与 SSH 会话保持一致的高吞吐）：
 * - 输出复用**同一个** `OutputBatcher`（`services/output-batcher.ts`，SSH 会话也用它）：
 *   16ms 窗口或 256KB 上限，二者先到者先冲刷，避免每个 data 事件都打一次 IPC。
 * - `node-pty` 是原生模块，**延迟到真正 spawn 时才 import**：
 *   这样本模块可以在普通 node（单测）里被安全 import，也不拖慢冷启动。
 */

import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { z } from 'zod'
import { Events } from '@t1000/shared'
import { AppError } from '../../errors'
import type { IpcContext, IpcHandler } from '../../ipc/router'
import { getCwd as getSessionCwd } from '../session-cwd'
import { OutputBatcher } from '../output-batcher'
import {
  publishSessionClosed,
  publishSessionData,
  registerWritable,
  unregisterWritable,
} from '../session-registry'
import {
  DEFAULT_TERM,
  buildShellEnv,
  defaultProfiles,
  detectShells,
  nodeShellIo,
  resolveShell,
  type PtyProfile,
  type ShellDetectIo,
  type ShellInfo,
} from './shells'
import { alpineLayout, alpineProfile } from './alpine'

/** 输出合批窗口（ms）。16ms ≈ 一帧，与 SSH 会话同值。 */
export const PTY_BATCH_MS = 16
/** 合批缓冲上限（字符数）。超过立即冲刷，避免高吞吐时内存膨胀。 */
export const PTY_BATCH_MAX_BYTES = 256 * 1024

export const DEFAULT_COLS = 80
export const DEFAULT_ROWS = 24

// ── node-pty 适配 ─────────────────────────────────────────────────────────

export interface PtyExitEvent {
  exitCode: number
  signal?: number
}

/** 对 node-pty `IPty` 的最小抽象，便于单测注入假实现 */
export interface PtyProcessLike {
  readonly pid: number
  onData(cb: (data: string) => void): void
  onExit(cb: (event: PtyExitEvent) => void): void
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(signal?: string): void
}

export interface PtySpawnOptions {
  name: string
  cwd: string
  env: Record<string, string>
  cols: number
  rows: number
}

export type PtySpawner = (
  file: string,
  args: readonly string[],
  options: PtySpawnOptions,
) => PtyProcessLike | Promise<PtyProcessLike>

type NodePtyModule = typeof import('node-pty')

/**
 * 延迟加载 node-pty：原生模块在 Electron ABI 下编译，普通 node 里 import
 * 有可能失败；放到真正 spawn 时再加载，失败也只影响一次 open 调用。
 */
async function loadNodePty(): Promise<NodePtyModule> {
  const mod: unknown = await import('node-pty')
  const wrapper = mod as { default?: NodePtyModule }
  return wrapper.default ?? (mod as NodePtyModule)
}

/** 默认真实 spawner（node-pty） */
export function createNodePtySpawner(
  loader: () => Promise<NodePtyModule> = loadNodePty,
): PtySpawner {
  return async (file, args, options) => {
    const pty = await loader()
    // 桌面端 node-pty 的 spawn 是同步的；Android 桥的实现要过一次原生通道，
    // 返回 Promise。用 await 统一两种形态：对 node-pty 只是多一个微任务。
    const proc = await Promise.resolve(
      pty.spawn(file, [...args], {
        name: options.name,
        cwd: options.cwd,
        env: options.env,
        cols: options.cols,
        rows: options.rows,
        encoding: 'utf8',
      }),
    )

    const toText = (data: unknown): string => {
      if (typeof data === 'string') return data
      if (Buffer.isBuffer(data)) return data.toString('utf8')
      return String(data)
    }

    return {
      pid: proc.pid,
      onData: (cb) => {
        proc.onData((data: string) => cb(toText(data)))
      },
      onExit: (cb) => {
        proc.onExit((event) => {
          cb(
            event.signal === undefined
              ? { exitCode: event.exitCode }
              : { exitCode: event.exitCode, signal: event.signal },
          )
        })
      },
      write: (data) => proc.write(data),
      resize: (cols, rows) => proc.resize(cols, rows),
      kill: (signal) => {
        if (signal === undefined) proc.kill()
        else proc.kill(signal)
      },
    }
  }
}

// ── 会话管理 ──────────────────────────────────────────────────────────────

export interface PtyEvents {
  /**
   * 会话已就绪。
   *
   * 把"写入函数"从这里交出去，服务层才能把它登记到中立契约供并发广播使用 ——
   * 管理层因此不需要知道 session-registry 的存在（保持分层）。
   */
  onSpawn(ptyId: string, write: (data: string) => void): void
  onData(ptyId: string, data: string): void
  onExit(ptyId: string, exitCode: number, signal?: number): void
}

export interface PtyOpenRequest {
  /** 指定 shell 路径或别名（bash / zsh / …） */
  shell?: string
  args?: readonly string[]
  cwd?: string
  env?: Record<string, string>
  cols?: number
  rows?: number
  term?: string
  colorTerm?: string
  /** 使用内置 profile（shell + args 一起生效） */
  profileId?: string
}

export interface PtyOpenResult {
  ptyId: string
  pid: number
  shell: string
  cwd: string
  cols: number
  rows: number
  /** 请求的 cwd 不存在，已回退到家目录 */
  cwdFallback: boolean
  profileId?: string
}

export interface PtySessionInfo extends PtyOpenResult {
  startedAt: number
}

export interface PtyManagerOptions {
  spawner?: PtySpawner
  /** 合批时间窗（ms），默认与 SSH 会话一致 */
  batchWindowMs?: number
  /** 合批体积上限（字符数） */
  batchMaxBytes?: number
  io?: ShellDetectIo
  /** 基础环境变量（默认 process.env） */
  env?: Record<string, string | undefined>
  homeDir?: string
  /** cwd 可用性判断（默认 existsSync） */
  cwdExists?: (path: string) => boolean
  idFactory?: () => string
  now?: () => number
}

interface PtyEntry {
  info: PtySessionInfo
  proc: PtyProcessLike
  batcher: OutputBatcher
}

export class PtyManager {
  private readonly sessions = new Map<string, PtyEntry>()
  private readonly spawner: PtySpawner
  private readonly batchWindowMs: number
  private readonly batchMaxBytes: number
  private readonly io: ShellDetectIo
  private readonly baseEnv: Record<string, string | undefined>
  private readonly home: string
  private readonly cwdExists: (path: string) => boolean
  private readonly idFactory: () => string
  private readonly now: () => number

  constructor(
    private readonly events: PtyEvents,
    options: PtyManagerOptions = {},
  ) {
    this.spawner = options.spawner ?? createNodePtySpawner()
    this.batchWindowMs = options.batchWindowMs ?? PTY_BATCH_MS
    this.batchMaxBytes = options.batchMaxBytes ?? PTY_BATCH_MAX_BYTES
    this.io = options.io ?? nodeShellIo()
    this.baseEnv = options.env ?? process.env
    this.home = options.homeDir ?? safeHomedir()
    this.cwdExists = options.cwdExists ?? (() => true)
    this.idFactory = options.idFactory ?? defaultIdFactory()
    this.now = options.now ?? (() => Date.now())
  }

  listShells(): ShellInfo[] {
    return detectShells(this.io)
  }

  /**
   * Android 专属的「真 Linux 环境」profile（proot + Alpine）。
   * 别的平台上 [alpineLayout] 直接返回 null（环境变量不存在），这里就是空数组，
   * 所以桌面端的行为完全不变。
   */
  private alpineProfiles(): PtyProfile[] {
    const layout = alpineLayout(this.io)
    return layout ? [alpineProfile(layout, this.io)] : []
  }

  listProfiles(): PtyProfile[] {
    return [...defaultProfiles(this.listShells(), this.io), ...this.alpineProfiles()]
  }

  list(): PtySessionInfo[] {
    return [...this.sessions.values()].map((entry) => ({ ...entry.info }))
  }

  get(ptyId: string): PtySessionInfo | undefined {
    const entry = this.sessions.get(ptyId)
    return entry ? { ...entry.info } : undefined
  }

  async open(request: PtyOpenRequest = {}): Promise<PtyOpenResult> {
    const shells = detectShells(this.io)
    const alpineProfileList = this.alpineProfiles()
    const profiles = [...defaultProfiles(shells, this.io), ...alpineProfileList]

    let profile: PtyProfile | undefined
    if (request.profileId) {
      profile = profiles.find((p) => p.id === request.profileId)
      if (!profile) throw AppError.badRequest(`未知的终端配置: ${request.profileId}`)
    } else if (!request.shell && alpineProfileList.length > 0) {
      // Android 上的"本地终端"默认就给真 Linux 环境（bash/git/python 都能用）。
      // rootfs 还没解包好时 alpineProfiles() 是空的，自然回落到系统 shell，
      // 用户看到的是 mksh 而不是一个报错的标签页。
      profile = alpineProfileList[0]
    }

    const shell = resolveShell(request.shell ?? profile?.shell, this.io, shells)
    const args = [...(request.args ?? profile?.args ?? [])]

    const requestedCwd = request.cwd?.trim() || profile?.cwd
    let cwd = requestedCwd && requestedCwd.length > 0 ? requestedCwd : this.home
    let cwdFallback = false
    if (!this.cwdExists(cwd)) {
      cwd = this.home
      cwdFallback = true
    }

    const cols = clampInt(request.cols ?? DEFAULT_COLS, 2, 1000)
    const rows = clampInt(request.rows ?? DEFAULT_ROWS, 1, 1000)

    const env = buildShellEnv(
      { ...this.baseEnv, ...(profile?.env ?? {}), ...(request.env ?? {}) },
      {
        term: request.term ?? DEFAULT_TERM,
        ...(request.colorTerm === undefined ? {} : { colorTerm: request.colorTerm }),
        // profile 自己声明了 PATH（proot 的 guest 路径）时不要用宿主的目录去补
        extendPath: profile?.env?.['PATH'] === undefined,
      },
      this.io.platform,
    )

    const ptyId = this.idFactory()
    const proc = await this.spawner(shell, args, {
      name: env['TERM'] ?? DEFAULT_TERM,
      cwd,
      env,
      cols,
      rows,
    })

    const batcher = new OutputBatcher({
      windowMs: this.batchWindowMs,
      maxBytes: this.batchMaxBytes,
      onFlush: (data) => this.events.onData(ptyId, data),
    })

    const info: PtySessionInfo = {
      ptyId,
      pid: proc.pid,
      shell,
      cwd,
      cols,
      rows,
      cwdFallback,
      ...(profile ? { profileId: profile.id } : {}),
      startedAt: this.now(),
    }
    this.sessions.set(ptyId, { info, proc, batcher })
    this.events.onSpawn(ptyId, (data) => proc.write(data))

    proc.onData((data) => batcher.push(data))
    proc.onExit((event) => {
      // 退出前把缓冲冲刷掉，避免最后一段输出丢失
      batcher.dispose({ flushFirst: true })
      this.sessions.delete(ptyId)
      if (event.signal === undefined) this.events.onExit(ptyId, event.exitCode)
      else this.events.onExit(ptyId, event.exitCode, event.signal)
    })

    return {
      ptyId,
      pid: proc.pid,
      shell,
      cwd,
      cols,
      rows,
      cwdFallback,
      ...(profile ? { profileId: profile.id } : {}),
    }
  }

  write(ptyId: string, data: string): void {
    this.require(ptyId).proc.write(data)
  }

  resize(ptyId: string, cols: number, rows: number): void {
    const entry = this.require(ptyId)
    const nextCols = clampInt(cols, 2, 1000)
    const nextRows = clampInt(rows, 1, 1000)
    entry.proc.resize(nextCols, nextRows)
    entry.info.cols = nextCols
    entry.info.rows = nextRows
  }

  close(ptyId: string): boolean {
    const entry = this.sessions.get(ptyId)
    if (!entry) return false
    this.sessions.delete(ptyId)
    // 先把待发送的数据送出去，再结束进程
    entry.batcher.dispose({ flushFirst: true })
    try {
      entry.proc.kill()
    } catch {
      /* 进程可能已经退出 */
    }
    return true
  }

  disposeAll(): void {
    for (const ptyId of [...this.sessions.keys()]) {
      this.close(ptyId)
    }
  }

  private require(ptyId: string): PtyEntry {
    const entry = this.sessions.get(ptyId)
    if (!entry) throw AppError.notFound(`终端不存在或已关闭: ${ptyId}`)
    return entry
  }
}

// ── IPC 接入 ──────────────────────────────────────────────────────────────

let manager: PtyManager | null = null
let activeCtx: IpcContext | null = null

/** 应用退出时关闭全部本地终端 */
export function shutdownPty(): void {
  manager?.disposeAll()
  manager = null
}

function getManager(ctx: IpcContext): PtyManager {
  activeCtx = ctx
  if (manager) return manager

  manager = new PtyManager(
    {
      // 本地终端也可参与广播（批量在本机+多台远机同时执行时有用）
      onSpawn: (ptyId, writeToProc) => {
        registerWritable({
          sessionId: ptyId,
          kind: 'pty',
          title: `本地终端 ${ptyId.slice(0, 8)}`,
          write: (data) => writeToProc(data),
          canWrite: () => true,
        })
      },
      onData: (ptyId, data) => {
        activeCtx?.emit(Events.PTY_DATA, { ptyId, data })
        // 同时写入中立契约：会话日志/录制订阅的是这条通道。
        // 只 emit 给渲染层的话，本地终端会"看起来在录、实际是空文件"。
        publishSessionData(ptyId, data)
      },
      onExit: (ptyId, exitCode, signal) => {
        activeCtx?.emit(Events.PTY_EXIT, {
          ptyId,
          exitCode,
          ...(signal === undefined ? {} : { signal }),
        })
        unregisterWritable(ptyId)
        // 广播关闭，让正在录制的日志自动收尾（否则写入流一直挂着）
        publishSessionClosed(ptyId)
      },
    },
    { cwdExists: (path) => defaultCwdExists(path) },
  )
  return manager
}

const openSchema = z.object({
  shell: z.string().min(1).optional(),
  args: z.array(z.string()).optional(),
  cwd: z.string().min(1).optional(),
  env: z.record(z.string()).optional(),
  cols: z.number().int().min(2).max(1000).optional(),
  rows: z.number().int().min(1).max(1000).optional(),
  term: z.string().min(1).optional(),
  colorTerm: z.string().min(1).optional(),
  profileId: z.string().min(1).optional(),
})

const ptyIdSchema = z.object({ ptyId: z.string().min(1) })

const writeSchema = z.object({
  ptyId: z.string().min(1),
  data: z.string(),
})

const resizeSchema = z.object({
  ptyId: z.string().min(1),
  cols: z.number().int().min(2).max(1000),
  rows: z.number().int().min(1).max(1000),
})

export const ptyHandlers: Record<string, IpcHandler> = {
  /** 本地终端当前目录：与 SSH 走同一套 OSC 7 跟踪（能力一致） */
  getCwd: (payload) => {
    const { ptyId } = ptyIdSchema.parse(payload)
    const cwd = getSessionCwd(ptyId)
    if (cwd !== null) return { cwd, source: 'osc7' as const }
    return {
      cwd: null,
      reason: '还没拿到终端的当前目录（shell 需要发 OSC 7；zsh/fish 常见配置自带）',
    }
  },

  open: (payload, ctx) => getManager(ctx).open(openSchema.parse(payload ?? {})),

  close: (payload, ctx) => {
    const { ptyId } = ptyIdSchema.parse(payload)
    return { ptyId, closed: getManager(ctx).close(ptyId) }
  },

  write: (payload, ctx) => {
    const { ptyId, data } = writeSchema.parse(payload)
    getManager(ctx).write(ptyId, data)
    return { ptyId, written: data.length }
  },

  resize: (payload, ctx) => {
    const { ptyId, cols, rows } = resizeSchema.parse(payload)
    getManager(ctx).resize(ptyId, cols, rows)
    return { ptyId, cols, rows }
  },

  list: (_payload, ctx) => getManager(ctx).list(),

  listProfiles: (_payload, ctx) => getManager(ctx).listProfiles(),

  listShells: (_payload, ctx) => getManager(ctx).listShells(),
}

// ── 工具 ──────────────────────────────────────────────────────────────────

function defaultIdFactory(): () => string {
  let seq = 0
  return () => {
    seq += 1
    return `pty-${Date.now().toString(36)}-${seq.toString(36)}`
  }
}

function safeHomedir(): string {
  try {
    return homedir()
  } catch {
    return '/'
  }
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, Math.trunc(value)))
}

/** 默认 cwd 校验：目录存在即可（文件不算） */
function defaultCwdExists(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isDirectory()
  } catch {
    return false
  }
}
