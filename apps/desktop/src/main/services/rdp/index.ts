// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * rdp 域：**务实方案** —— 调用系统 FreeRDP，而不是自研 RDP 渲染器。
 *
 * ## 与参考产品的边界（有意取舍，不要假装等价）
 * 参考产品用一个**自研原生模块**把远端画面**嵌进自己的窗口**，因此是"同一窗口内的标签页"。
 * 我们**拉起外部进程**（`xfreerdp`），画面出现在**它自己的独立窗口**里：
 * - 能做到：连接、参数映射、剪贴板、动态分辨率、退出状态如实上报
 * - 做不到：把画面嵌进我们的窗口、与终端做分屏、统一主题
 * 自研 RDP 渲染器（协议栈 + 位图解码 + 输入代理 + 剪贴板通道）成本极高，
 * 这里明确选择"可用优先"，并在 UI 上应把它当成"打开一个外部远程桌面窗口"。
 *
 * ## 其它已知取舍
 * - 口令经命令行 `/p:` 传给子进程：同机其它用户能通过 `ps` 看到。
 *   xfreerdp3 支持 `/from-stdin` 可以规避，但那要区分二进制版本、并接管子进程 stdin；
 *   当前实现选择简单直接，风险在文档里写明（见汇报）。
 * - 外部窗口**无法在运行时原地改分辨率**：`sendResize` 会**重启查看器进程**并上新尺寸。
 *   这是刻意的行为（用户改分辨率 → 拿到一个新窗口），需要 UI 明确提示。
 */

import { spawn } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { basename, join } from 'node:path'
import { z } from 'zod'
import { Events, type ConnectionState, type RdpConnection } from '@t1000/shared'
import { AppError, parseInput } from '../../errors'
import type { IpcContext, IpcHandler } from '../../ipc/router'

/** 候选可执行文件名（按优先级） */
export const RDP_BINARY_CANDIDATES = ['xfreerdp', 'xfreerdp3', 'wlfreerdp', 'freerdp'] as const

/** 找不到二进制时的可操作提示（不是笼统失败） */
export function rdpInstallHint(): string {
  return [
    '未检测到 FreeRDP（xfreerdp），无法打开 RDP 会话。请先安装后再试：',
    '  Debian/Ubuntu: sudo apt install freerdp2-x11',
    '  Fedora/RHEL:   sudo dnf install freerdp',
    '  Arch:          sudo pacman -S freerdp',
  ].join('\n')
}

/** RDP 默认端口 */
export const RDP_DEFAULT_PORT = 3389
/** follow-window 模式下的初始窗口尺寸（之后交给 /dynamic-resolution） */
export const RDP_DEFAULT_WIDTH = 1280
export const RDP_DEFAULT_HEIGHT = 800

export interface RdpConnectOptions {
  /** 全屏（/f）；契约里没有这个字段，由 UI 在 connect 时显式传 */
  fullscreen?: boolean
  /** 覆盖分辨率（优先级高于 connection 里的 width/height） */
  width?: number
  height?: number
  /**
   * 强制固定分辨率。
   * 「跟随窗口」的连接在用户显式指定分辨率（改分辨率）时也要固定下来，
   * 否则会被当作 follow-window 而忽略尺寸。
   */
  forceFixedSize?: boolean
}

/**
 * 把连接配置映射成 xfreerdp 命令行参数（**纯函数**，便于单测）。
 *
 * 映射规则：
 * - 主机：`/v:host:port`
 * - 认证：`/u:` `/d:` `/p:`，`/cert:ignore`（RDP 服务端多为自签证书，否则会卡在证书校验）
 * - 显示：固定分辨率 → `/size:WxH`；跟随窗口 → `/size:初始 + /dynamic-resolution`；全屏 → `/f`
 * - 画质：low → `/bpp:16 /network:modem`；balanced → `/bpp:24 /network:broadband`；high → `/bpp:32 /network:lan`
 * - 剪贴板：`/clipboard` 或 `-clipboard`
 */
export function buildRdpArgs(connection: RdpConnection, options: RdpConnectOptions = {}): string[] {
  const args: string[] = []

  const port = connection.port > 0 ? connection.port : RDP_DEFAULT_PORT
  args.push(`/v:${connection.host}:${port}`)
  args.push(`/u:${connection.username}`)
  if (connection.domain !== undefined && connection.domain !== '') {
    args.push(`/d:${connection.domain}`)
  }
  if (connection.password !== undefined && connection.password !== '') {
    // 注意：口令会出现在本机进程列表里（见文件头"已知取舍"）
    args.push(`/p:${connection.password}`)
  }
  // 自签证书是 RDP 的常态；不忽略会让用户卡在证书对话框
  args.push('/cert:ignore')

  const explicitWidth = options.width ?? connection.width
  const explicitHeight = options.height ?? connection.height
  const hasSize = explicitWidth !== undefined && explicitHeight !== undefined
  const fixed =
    hasSize && (connection.displayMode === 'fixed-resolution' || options.forceFixedSize === true)

  if (options.fullscreen === true) {
    args.push('/f')
  }
  if (fixed) {
    args.push(`/size:${Math.trunc(explicitWidth as number)}x${Math.trunc(explicitHeight as number)}`)
  } else {
    // 跟随窗口：给一个初始尺寸，再让 FreeRDP 跟随窗口大小变化
    args.push(`/size:${RDP_DEFAULT_WIDTH}x${RDP_DEFAULT_HEIGHT}`)
    args.push('/dynamic-resolution')
  }

  const quality = connection.quality ?? 'balanced'
  if (quality === 'low') {
    args.push('/bpp:16')
    args.push('/network:modem')
  } else if (quality === 'high') {
    args.push('/bpp:32')
    args.push('/network:lan')
  } else {
    args.push('/bpp:24')
    args.push('/network:broadband')
  }

  args.push(connection.clipboardShare === true ? '/clipboard' : '-clipboard')
  return args
}

/** 在 PATH 中找 FreeRDP 可执行文件；找不到返回 null */
export function findRdpBinary(
  env: NodeJS.ProcessEnv = process.env,
  exists: (path: string) => boolean = defaultExecutableExists,
): string | null {
  const pathValue = env['PATH'] ?? ''
  const dirs = pathValue.split(':').filter((dir) => dir.length > 0)
  for (const candidate of RDP_BINARY_CANDIDATES) {
    for (const dir of dirs) {
      const full = join(dir, candidate)
      if (exists(full)) return full
    }
  }
  return null
}

function defaultExecutableExists(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// 子进程抽象（注入以便单测；不真的拉起 GUI）
// ---------------------------------------------------------------------------

export interface RdpChildProcess {
  readonly pid?: number | undefined
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown
  on(event: 'error', listener: (err: Error) => void): unknown
  kill(signal?: NodeJS.Signals): boolean
}

export type RdpSpawner = (file: string, args: readonly string[]) => RdpChildProcess

export interface RdpEventSink {
  state(sessionId: string, state: ConnectionState, message?: string): void
  exit(sessionId: string, info: { code: number | null; signal: string | null; crashed: boolean }): void
}

export interface RdpManagerOptions {
  sink: RdpEventSink
  findBinary?: () => string | null
  spawn?: RdpSpawner
}

interface RdpSession {
  sessionId: string
  connection: RdpConnection
  options: RdpConnectOptions
  child: RdpChildProcess
  executable: string
  state: ConnectionState
  /** 我们主动结束（disconnect / resize 重启）→ 不算崩溃 */
  stopping: boolean
  /** 重启前先摘掉旧进程的 exit 监听影响 */
  generation: number
}

export class RdpManager {
  private readonly sessions = new Map<string, RdpSession>()
  private readonly sink: RdpEventSink
  private readonly findBinary: () => string | null
  private readonly spawnProcess: RdpSpawner

  constructor(options: RdpManagerOptions) {
    this.sink = options.sink
    this.findBinary = options.findBinary ?? ((): string | null => findRdpBinary())
    this.spawnProcess =
      options.spawn ??
      ((file, args) =>
        spawn(file, [...args], { stdio: 'ignore' }) as unknown as RdpChildProcess)
  }

  list(): Array<{ sessionId: string; state: ConnectionState; host: string; executable: string }> {
    return [...this.sessions.values()].map((s) => ({
      sessionId: s.sessionId,
      state: s.state,
      host: s.connection.host,
      executable: basename(s.executable),
    }))
  }

  /** 探测可执行文件；找不到抛**可操作**的错误 */
  detectBinary(): string {
    const file = this.findBinary()
    if (file === null) {
      throw AppError.unsupported(rdpInstallHint())
    }
    return file
  }

  connect(
    connection: RdpConnection,
    options: RdpConnectOptions = {},
  ): { sessionId: string; executable: string; args: string[] } {
    const executable = this.detectBinary()
    const args = buildRdpArgs(connection, options)
    const sessionId = randomUUID()

    const child = this.spawnProcess(executable, args)
    const session: RdpSession = {
      sessionId,
      connection,
      options,
      child,
      executable,
      state: 'connecting',
      stopping: false,
      generation: 0,
    }
    this.sessions.set(sessionId, session)
    this.sink.state(sessionId, 'connecting')
    // 外部进程没有"就绪握手"可等：进程起来了就算 ready（窗口由它自己创建）
    this.setState(session, 'ready')

    this.watch(session, child)
    return { sessionId, executable, args }
  }

  disconnect(sessionId: string): boolean {
    const session = this.require(sessionId)
    session.stopping = true
    try {
      session.child.kill('SIGTERM')
    } catch {
      /* 进程可能已退出 */
    }
    this.sessions.delete(sessionId)
    this.setState(session, 'disconnected')
    return true
  }

  /**
   * 改分辨率：外部窗口无法原地改，**重启查看器进程**。
   *
   * 行为要明确（汇报里也提了）：用户点"改分辨率"会拿到一个**新窗口**，
   * 旧窗口关闭；RDP 会话本身会重连。返回 restarted=true 便于 UI 提示。
   */
  sendResize(sessionId: string, width: number, height: number): {
    sessionId: string
    width: number
    height: number
    restarted: boolean
  } {
    const session = this.require(sessionId)
    const nextWidth = Math.max(320, Math.trunc(width))
    const nextHeight = Math.max(240, Math.trunc(height))

    // 旧进程标记为主动停止 → 不产生"崩溃"误报
    session.stopping = true
    session.generation += 1
    try {
      session.child.kill('SIGTERM')
    } catch {
      /* ignore */
    }

    // 显式指定分辨率 → 强制固定尺寸（follow-window 的连接也照此处理）
    const options: RdpConnectOptions = {
      ...session.options,
      width: nextWidth,
      height: nextHeight,
      forceFixedSize: true,
    }
    const args = buildRdpArgs(session.connection, options)
    const child = this.spawnProcess(session.executable, args)

    session.options = options
    session.stopping = false
    session.child = child
    session.state = 'connecting'
    this.sink.state(session.sessionId, 'connecting', '分辨率变更：正在重启远程桌面窗口')
    this.setState(session, 'ready')
    this.watch(session, child)

    return { sessionId, width: nextWidth, height: nextHeight, restarted: true }
  }

  shutdown(): void {
    for (const session of this.sessions.values()) {
      session.stopping = true
      try {
        session.child.kill('SIGTERM')
      } catch {
        /* ignore */
      }
    }
    this.sessions.clear()
  }

  // -------------------------------------------------------------- 内部

  private require(sessionId: string): RdpSession {
    const session = this.sessions.get(sessionId)
    if (!session) throw AppError.notFound(`RDP 会话不存在或已关闭: ${sessionId}`)
    return session
  }

  private watch(session: RdpSession, child: RdpChildProcess): void {
    const generation = session.generation
    let exited = false

    child.on('error', (err) => {
      if (exited || this.isStale(session, generation)) return
      this.sink.state(session.sessionId, 'failed', err.message)
      session.state = 'failed'
    })

    child.on('exit', (code, signal) => {
      if (exited) return
      exited = true
      if (this.isStale(session, generation)) return
      // 主动结束（disconnect / shutdown / 重启）：状态已由调用方上报，这里不重复发事件
      if (session.stopping) return

      // 只有"非主动结束且非 0 退出"才算崩溃（用户关窗口通常是 code 0）
      const crashed = code !== 0
      session.stopping = true
      session.state = 'disconnected'
      this.sessions.delete(session.sessionId)

      this.sink.state(
        session.sessionId,
        'disconnected',
        crashed ? `远程桌面进程异常退出（code=${String(code)}）` : undefined,
      )
      this.sink.exit(session.sessionId, {
        code,
        signal: signal === null ? null : String(signal),
        crashed,
      })
    })
  }

  /** 重启后旧进程的 exit 事件不应影响新进程的状态 */
  private isStale(session: RdpSession, generation: number): boolean {
    return session.generation !== generation
  }

  private setState(session: RdpSession, state: ConnectionState, message?: string): void {
    session.state = state
    if (message === undefined) this.sink.state(session.sessionId, state)
    else this.sink.state(session.sessionId, state, message)
  }
}

// ---------------------------------------------------------------------------
// IPC 接入
// ---------------------------------------------------------------------------

const rdpConnectionSchema = z
  .object({
    kind: z.literal('rdp'),
    id: z.string().min(1),
    name: z.string(),
    host: z.string().min(1),
    port: z.number().int().min(1).max(65535),
    username: z.string().min(1),
    password: z.string().optional(),
    domain: z.string().optional(),
    displayMode: z.enum(['follow-window', 'fixed-resolution']).optional(),
    width: z.number().int().min(320).max(8192).optional(),
    height: z.number().int().min(240).max(8192).optional(),
    quality: z.enum(['low', 'balanced', 'high']).optional(),
    clipboardShare: z.boolean().optional(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .passthrough()

const connectSchema = z.object({
  connection: rdpConnectionSchema,
  fullscreen: z.boolean().optional(),
  width: z.number().int().min(320).max(8192).optional(),
  height: z.number().int().min(240).max(8192).optional(),
})
const sessionSchema = z.object({ sessionId: z.string().min(1) })
const resizeSchema = z.object({
  sessionId: z.string().min(1),
  width: z.number().int().min(320).max(8192),
  height: z.number().int().min(240).max(8192),
})

function sinkFromContext(getCtx: () => IpcContext | null): RdpEventSink {
  return {
    state: (sessionId, state, message) => {
      const ctx = getCtx()
      if (!ctx) return
      ctx.emit(
        Events.RDP_STATE,
        message === undefined ? { sessionId, state } : { sessionId, state, message },
      )
    },
    exit: (sessionId, info) => {
      getCtx()?.emit(Events.RDP_EXIT, { sessionId, ...info })
    },
  }
}

let manager: RdpManager | null = null
let activeCtx: IpcContext | null = null

/** 应用退出时结束全部外部查看器进程 */
export function shutdownRdp(): void {
  manager?.shutdown()
  manager = null
}

/** 供测试注入（替换单例） */
export function setRdpManagerForTests(next: RdpManager | null): void {
  manager = next
}

function getManager(ctx: IpcContext): RdpManager {
  activeCtx = ctx
  manager ??= new RdpManager({ sink: sinkFromContext(() => activeCtx) })
  return manager
}

export const rdpHandlers: Record<string, IpcHandler> = {
  connect: (payload, ctx) => {
    const { connection, fullscreen, width, height } = parseInput(connectSchema, payload)
    const options: RdpConnectOptions = {
      ...(fullscreen === undefined ? {} : { fullscreen }),
      ...(width === undefined ? {} : { width }),
      ...(height === undefined ? {} : { height }),
    }
    return getManager(ctx).connect(connection as unknown as RdpConnection, options)
  },

  disconnect: (payload, ctx) => {
    const { sessionId } = parseInput(sessionSchema, payload)
    return { sessionId, disconnected: getManager(ctx).disconnect(sessionId) }
  },

  /** 改分辨率 = 重启外部查看器（外部窗口无法原地改，见文件头说明） */
  sendResize: (payload, ctx) => {
    const { sessionId, width, height } = parseInput(resizeSchema, payload)
    return getManager(ctx).sendResize(sessionId, width, height)
  },
}
