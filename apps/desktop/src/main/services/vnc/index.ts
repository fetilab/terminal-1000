// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * vnc 域：RFB 3.8 客户端接入（Actions.vnc: connect / disconnect / sendPointer / sendKey）。
 *
 * 分层（与 `services/telnet` 同一套路）：
 * - 协议/编解码全在 `rfb.ts`（纯逻辑，无 socket，可单测）
 * - 本文件只做「socket 壳 + 会话管理 + 事件转换」
 *
 * 事件出口是**可注入的 sink**：生产环境接到 ctx.emit，单测直接换成一个记录器，
 * 因此这里不 import logger（那会把 Electron 拖进单测）。
 *
 * 连接选项的实际用法（对应 `VncConnection`）：
 * - `viewOnly`：本端不发任何键鼠（sendPointer/sendKey 直接返回 ignored）
 * - `shared`：作为 ClientInit 的 shared 标志；false 时请求独占会话
 * - `qualityLevel` / `compressionLevel`：映射到 QualityLevel(-256) / CompressLevel(-247) 伪编码
 * - `scaleViewport` / `clipViewport`：**渲染层行为**（后端不做缩放/裁剪），
 *   这里只把它们原样回给 UI，避免"后端假装支持其实没做"
 */

import { randomUUID } from 'node:crypto'
import { connect } from 'node:net'
import { z } from 'zod'
import { Events, type ConnectionState, type VncConnection } from '@t1000/shared'
import { AppError, parseInput } from '../../errors'
import type { IpcContext, IpcHandler } from '../../ipc/router'
import { RfbProtocol, type RfbEvent } from './rfb'

/** RFB 一帧里的一个矩形（已转成 IPC 友好形状：像素走 base64） */
export interface VncFrameRect {
  x: number
  y: number
  width: number
  height: number
  /** 32bpp BGRA 的 base64；CopyRect 时缺省 */
  pixels?: string
  /** CopyRect：源左上角（渲染层在自己画布上搬） */
  copyFrom?: { x: number; y: number }
}

export interface VncFrame {
  framebufferWidth: number
  framebufferHeight: number
  rects: VncFrameRect[]
}

/** 事件出口（生产 = ctx.emit；测试 = 记录器） */
export interface VncEventSink {
  state(sessionId: string, state: ConnectionState, message?: string): void
  frame(sessionId: string, frame: VncFrame): void
  clipboard(sessionId: string, text: string): void
  bell(sessionId: string): void
  error(sessionId: string, message: string): void
}

/** 用到的 socket 能力（`node:net` 的 Socket 结构上满足；测试可用假对象） */
export interface RfbSocket {
  write(data: Buffer): boolean
  end(): void
  destroy(): void
  on(event: 'connect', listener: () => void): unknown
  on(event: 'data', listener: (chunk: Buffer) => void): unknown
  on(event: 'error', listener: (err: Error) => void): unknown
  on(event: 'close', listener: () => void): unknown
}

export type VncSocketFactory = (options: { host: string; port: number }) => RfbSocket

/** 定时能力（注入以便单测精确控制握手超时） */
export interface VncTimer {
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export const systemVncTimer: VncTimer = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

/** 握手（版本 → 安全类型 → ServerInit）超时 */
export const VNC_HANDSHAKE_TIMEOUT_MS = 15_000

export interface VncManagerOptions {
  sink: VncEventSink
  createSocket?: VncSocketFactory
  timer?: VncTimer
  handshakeTimeoutMs?: number
}

interface VncSession {
  sessionId: string
  connection: VncConnection
  socket: RfbSocket
  protocol: RfbProtocol
  state: ConnectionState
  closed: boolean
  handshakeTimer: unknown
}

export class VncManager {
  private readonly sessions = new Map<string, VncSession>()
  private readonly sink: VncEventSink
  private readonly createSocket: VncSocketFactory
  private readonly timer: VncTimer
  private readonly handshakeTimeoutMs: number

  constructor(options: VncManagerOptions) {
    this.sink = options.sink
    this.createSocket =
      options.createSocket ?? (({ host, port }) => connect({ host, port }) as unknown as RfbSocket)
    this.timer = options.timer ?? systemVncTimer
    this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? VNC_HANDSHAKE_TIMEOUT_MS
  }

  list(): Array<{ sessionId: string; state: ConnectionState; host: string; port: number }> {
    return [...this.sessions.values()].map((s) => ({
      sessionId: s.sessionId,
      state: s.state,
      host: s.connection.host,
      port: s.connection.port,
    }))
  }

  /** 建立连接并开始 RFB 握手；立即返回 sessionId（画面/尺寸随后由事件推送） */
  connect(connection: VncConnection): { sessionId: string; viewOnly: boolean } {
    const sessionId = randomUUID()
    const protocol = new RfbProtocol({
      authType: connection.authType === 'vnc-password' ? 'vnc-password' : 'none',
      ...(connection.password === undefined ? {} : { password: connection.password }),
      shared: connection.shared !== false,
      ...(connection.qualityLevel === undefined ? {} : { qualityLevel: connection.qualityLevel }),
      ...(connection.compressionLevel === undefined
        ? {}
        : { compressionLevel: connection.compressionLevel }),
    })

    const socket = this.createSocket({ host: connection.host, port: connection.port })
    const session: VncSession = {
      sessionId,
      connection,
      socket,
      protocol,
      state: 'connecting',
      closed: false,
      handshakeTimer: null,
    }
    this.sessions.set(sessionId, session)
    this.setState(session, 'connecting')

    // 握手超时：服务端不吐字节时不要让会话永远停在 connecting
    session.handshakeTimer = this.timer.setTimeout(() => {
      if (session.state === 'ready' || session.closed) return
      this.fail(session, `RFB 握手超时（${this.handshakeTimeoutMs}ms）`)
    }, this.handshakeTimeoutMs)

    socket.on('connect', () => {
      // RFB 由服务端先发版本串，这里不需要主动写
      this.setState(session, 'connecting')
    })
    socket.on('data', (chunk) => this.onData(session, chunk))
    socket.on('error', (err) => this.fail(session, err.message))
    socket.on('close', () => this.onClose(session))
    return { sessionId, viewOnly: connection.viewOnly === true }
  }

  disconnect(sessionId: string): boolean {
    const session = this.require(sessionId)
    this.cleanup(session)
    this.setState(session, 'disconnected')
    return true
  }

  /** 鼠标事件；viewOnly 时忽略 */
  sendPointer(
    sessionId: string,
    buttonMask: number,
    x: number,
    y: number,
  ): { sent: boolean; ignored?: string } {
    const session = this.require(sessionId)
    if (session.connection.viewOnly === true) return { sent: false, ignored: 'viewOnly' }
    if (session.state !== 'ready') return { sent: false, ignored: `会话未就绪（${session.state}）` }
    session.protocol.sendPointer(buttonMask, x, y)
    this.flush(session)
    return { sent: true }
  }

  /** 键盘事件；viewOnly 时忽略 */
  sendKey(
    sessionId: string,
    down: boolean,
    keysym: number,
  ): { sent: boolean; ignored?: string } {
    const session = this.require(sessionId)
    if (session.connection.viewOnly === true) return { sent: false, ignored: 'viewOnly' }
    if (session.state !== 'ready') return { sent: false, ignored: `会话未就绪（${session.state}）` }
    session.protocol.sendKey(down, keysym)
    this.flush(session)
    return { sent: true }
  }

  /** 把本地剪贴板发给远端（UI 主动调用；不在 Actions.vnc 里，先作为能力暴露） */
  sendClipboard(sessionId: string, text: string): { sent: boolean } {
    const session = this.require(sessionId)
    if (session.connection.viewOnly === true) return { sent: false }
    session.protocol.sendClientCutText(text)
    this.flush(session)
    return { sent: true }
  }

  shutdown(): void {
    for (const session of this.sessions.values()) {
      this.cleanup(session)
      session.state = 'disconnected'
    }
    this.sessions.clear()
  }

  // -------------------------------------------------------------- 内部

  private require(sessionId: string): VncSession {
    const session = this.sessions.get(sessionId)
    if (!session) throw AppError.notFound(`VNC 会话不存在或已断开: ${sessionId}`)
    return session
  }

  private setState(session: VncSession, state: ConnectionState, message?: string): void {
    session.state = state
    if (message === undefined) this.sink.state(session.sessionId, state)
    else this.sink.state(session.sessionId, state, message)
  }

  private onData(session: VncSession, chunk: Buffer): void {
    if (session.closed) return
    let events: RfbEvent[]
    try {
      events = session.protocol.feed(chunk)
    } catch (err) {
      this.fail(session, err instanceof Error ? err.message : String(err))
      return
    }
    for (const event of events) this.dispatch(session, event)
    this.flush(session)
  }

  private dispatch(session: VncSession, event: RfbEvent): void {
    switch (event.type) {
      case 'version':
        break
      case 'security':
        // 进入认证阶段（VNC Auth 会有 challenge 往返）
        this.setState(session, 'authenticating')
        break
      case 'securityResult':
        if (!event.ok) {
          this.fail(
            session,
            `VNC 认证失败${event.reason === undefined ? '' : `：${event.reason}`}`,
          )
        }
        break
      case 'serverInit':
        this.clearHandshakeTimer(session)
        this.setState(session, 'ready')
        break
      case 'desktopSize':
        // 尺寸变化随下一帧的 VNC_FRAME 一起给 UI（framebufferWidth/Height）
        break
      case 'frame':
        this.sink.frame(session.sessionId, {
          framebufferWidth: event.framebufferWidth,
          framebufferHeight: event.framebufferHeight,
          rects: event.rects.map((rect) =>
            rect.pixels === undefined
              ? {
                  x: rect.x,
                  y: rect.y,
                  width: rect.width,
                  height: rect.height,
                  ...(rect.copyFrom === undefined ? {} : { copyFrom: rect.copyFrom }),
                }
              : {
                  x: rect.x,
                  y: rect.y,
                  width: rect.width,
                  height: rect.height,
                  pixels: rect.pixels.toString('base64'),
                },
          ),
        })
        break
      case 'bell':
        this.sink.bell(session.sessionId)
        break
      case 'clipboard':
        this.sink.clipboard(session.sessionId, event.text)
        break
      case 'error':
        this.fail(session, event.message)
        break
    }
  }

  private flush(session: VncSession): void {
    const out = session.protocol.drainOutbox()
    if (out.length === 0 || session.closed) return
    try {
      session.socket.write(out)
    } catch (err) {
      this.fail(session, err instanceof Error ? err.message : String(err))
    }
  }

  private fail(session: VncSession, message: string): void {
    if (session.closed) return
    this.sink.error(session.sessionId, message)
    this.cleanup(session)
    this.setState(session, 'failed', message)
  }

  private onClose(session: VncSession): void {
    if (session.closed) return
    this.clearHandshakeTimer(session)
    session.closed = true
    if (session.state !== 'failed') this.setState(session, 'disconnected')
    this.sessions.delete(session.sessionId)
  }

  private cleanup(session: VncSession): void {
    this.clearHandshakeTimer(session)
    if (session.closed) return
    session.closed = true
    try {
      session.socket.end()
      session.socket.destroy()
    } catch {
      /* 关闭期错误忽略 */
    }
    this.sessions.delete(session.sessionId)
  }

  private clearHandshakeTimer(session: VncSession): void {
    if (session.handshakeTimer === null) return
    this.timer.clearTimeout(session.handshakeTimer)
    session.handshakeTimer = null
  }
}

// ---------------------------------------------------------------------------
// IPC 接入
// ---------------------------------------------------------------------------

const vncConnectionSchema = z
  .object({
    kind: z.literal('vnc'),
    id: z.string().min(1),
    name: z.string(),
    host: z.string().min(1),
    port: z.number().int().min(1).max(65535),
    authType: z.enum(['vnc-password', 'none']).optional(),
    password: z.string().optional(),
    viewOnly: z.boolean().optional(),
    shared: z.boolean().optional(),
    scaleViewport: z.boolean().optional(),
    clipViewport: z.boolean().optional(),
    qualityLevel: z.number().int().min(0).max(9).optional(),
    compressionLevel: z.number().int().min(0).max(9).optional(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .passthrough()

const connectSchema = z.object({ connection: vncConnectionSchema })
const sessionSchema = z.object({ sessionId: z.string().min(1) })
const pointerSchema = z.object({
  sessionId: z.string().min(1),
  buttonMask: z.number().int().min(0).max(255),
  x: z.number().int(),
  y: z.number().int(),
})
const keySchema = z.object({
  sessionId: z.string().min(1),
  down: z.boolean(),
  /** X11 keysym */
  keysym: z.number().int().min(0),
})

/**
 * 生产事件出口：接到 ctx.emit。
 *
 * 每个事件直接调用（不做泛型转发），这样 payload 与 `EventPayloads` 的校验
 * 由编译器逐条盯着；契约改字段时这里会立刻报错。
 */
function sinkFromContext(getCtx: () => IpcContext | null): VncEventSink {
  return {
    state: (sessionId, state, message) => {
      const ctx = getCtx()
      if (!ctx) return
      ctx.emit(
        Events.VNC_STATE,
        message === undefined ? { sessionId, state } : { sessionId, state, message },
      )
    },
    frame: (sessionId, frame) => {
      getCtx()?.emit(Events.VNC_FRAME, { sessionId, ...frame })
    },
    clipboard: (sessionId, text) => {
      getCtx()?.emit(Events.VNC_CLIPBOARD, { sessionId, text })
    },
    bell: (sessionId) => {
      getCtx()?.emit(Events.VNC_BELL, { sessionId })
    },
    error: (sessionId, message) => {
      getCtx()?.emit(Events.VNC_ERROR, { sessionId, message })
    },
  }
}

let manager: VncManager | null = null
let activeCtx: IpcContext | null = null

/** 应用退出时关闭全部 VNC 会话 */
export function shutdownVnc(): void {
  manager?.shutdown()
  manager = null
}

/** 供测试注入（替换单例） */
export function setVncManagerForTests(next: VncManager | null): void {
  manager = next
}

function getManager(ctx: IpcContext): VncManager {
  activeCtx = ctx
  manager ??= new VncManager({ sink: sinkFromContext(() => activeCtx) })
  return manager
}

export const vncHandlers: Record<string, IpcHandler> = {
  connect: (payload, ctx) => {
    const { connection } = parseInput(connectSchema, payload)
    const result = getManager(ctx).connect(connection as unknown as VncConnection)
    // scaleViewport / clipViewport 是渲染层行为，这里原样回给 UI
    return {
      ...result,
      scaleViewport: connection.scaleViewport === true,
      clipViewport: connection.clipViewport === true,
    }
  },

  disconnect: (payload, ctx) => {
    const { sessionId } = parseInput(sessionSchema, payload)
    return { sessionId, disconnected: getManager(ctx).disconnect(sessionId) }
  },

  sendPointer: (payload, ctx) => {
    const { sessionId, buttonMask, x, y } = parseInput(pointerSchema, payload)
    return getManager(ctx).sendPointer(sessionId, buttonMask, x, y)
  },

  sendKey: (payload, ctx) => {
    const { sessionId, down, keysym } = parseInput(keySchema, payload)
    return getManager(ctx).sendKey(sessionId, down, keysym)
  },
}
