// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 端口转发 / 隧道引擎。
 *
 * 三种模式：
 * - local   本地监听 → 经 SSH 转发到远端目标（最常见：把远端服务映射到本机）
 * - remote  远端监听 → 经 SSH 转回本机目标（把本机服务暴露给远端）
 * - dynamic 本地 SOCKS5 服务 → 动态按目标地址经 SSH 出站
 *
 * 自动重连：隧道意外断开后按指数退避重试（可配置），独立于 SSH 连接本身。
 */

import { createServer, connect, type Server, type Socket } from 'node:net'
import type { ForwardType, TunnelConnection } from '@t1000/shared'
import { randomUUID } from 'node:crypto'
import { AppError } from '../../errors'
import { createLogger } from '../../logger'
import { getSession, listSessions, type SshSessionHandle } from '../session-registry'

const log = createLogger('forward')

export type TunnelState = 'idle' | 'connecting' | 'ready' | 'reconnecting' | 'failed' | 'closed'

export interface TunnelEvents {
  onState(tunnelId: string, state: TunnelState, message?: string): void
  onInfo(tunnelId: string, message: string): void
  onWarn(tunnelId: string, message: string): void
  onError(tunnelId: string, message: string): void
}

interface ReconnectPolicy {
  baseMs: number
  maxMs: number
  attempts: number
}

const DEFAULT_RECONNECT: ReconnectPolicy = { baseMs: 1000, maxMs: 30_000, attempts: 10 }

/**
 * 一条隧道的运行时实例。
 * 生命周期：open() → ready → (断开) → 退避重连 → ... → close()
 */

/**
 * 解析"承载这条隧道的 SSH 会话"。
 *
 * **为什么要这一层**：配置里的 `serverId` 是**连接** id（界面的"承载服务器"下拉
 * 选的就是连接库里的条目），而会话注册表是按**会话** id 索引的（随机 UUID）。
 * 早先这里直接把 `serverId` 当会话 id 查表，于是 `requireSession` 必然抛
 * "会话不存在或已断开" —— **隧道从来没能真正打开过**。
 * （UI 侧是用契约桩验证的，桩里 id 对得上，所以没暴露。）
 *
 * 解析顺序：
 * 1. 先按会话 id 命中（兼容运行时直接拿 sessionId 传进来的调用）
 * 2. 否则找该连接**当前就绪**的会话 —— 这正是"复用已有终端连接"的实现点：
 *    用户先连上服务器，隧道借这条连接建立转发通道，无需重新认证
 */
export function resolveCarrierSession(serverId: string): SshSessionHandle {
  const direct = getSession(serverId)
  if (direct && direct.state === 'ready') return direct

  const byConnection = listSessions().find(
    (s) => s.connectionId === serverId && s.state === 'ready',
  )
  if (byConnection) return byConnection

  throw new Error(
    `没有可用的 SSH 会话承载该隧道（承载服务器：${serverId}）。请先连接到该服务器，再启动隧道。`,
  )
}

export class Tunnel {
  readonly tunnelId: string
  private state: TunnelState = 'idle'
  private server: Server | null = null
  /** 本地监听实际使用的端口（传 0 时由系统分配，需要回读） */
  private boundPort = 0
  private attempt = 0
  private reconnectTimer: NodeJS.Timeout | null = null
  private closedByUser = false
  /** 活跃连接，关闭时需要一起清理，避免句柄泄漏 */
  private readonly sockets = new Set<Socket>()

  constructor(
    private readonly config: TunnelConnection,
    private readonly events: TunnelEvents,
    private readonly reconnect: ReconnectPolicy = DEFAULT_RECONNECT,
  ) {
    this.tunnelId = randomUUID()
  }

  getState(): TunnelState {
    return this.state
  }

  getBoundPort(): number {
    return this.boundPort
  }

  private setState(state: TunnelState, message?: string): void {
    this.state = state
    this.events.onState(this.tunnelId, state, message)
  }

  async open(): Promise<void> {
    this.closedByUser = false
    try {
      await this.start()
    } catch (err) {
      this.setState('failed', err instanceof Error ? err.message : String(err))
      throw err
    }
  }

  private async start(): Promise<void> {
    const c = this.config
    this.setState('connecting')

    switch (c.type) {
      case 'local':
        await this.startLocal()
        break
      case 'remote':
        await this.startRemote()
        break
      case 'dynamic':
        await this.startDynamic()
        break
      default:
        throw AppError.unsupported(`不支持的转发类型: ${String(c.type)}`)
    }

    this.attempt = 0
    this.setState('ready')
    const desc =
      c.type === 'remote'
        ? `远端 ${c.remoteHost}:${c.remotePort} → 本机 ${c.localHost}:${c.localPort}`
        : c.type === 'dynamic'
          ? `SOCKS5 监听 ${c.localHost}:${this.boundPort}`
          : `本机 ${c.localHost}:${this.boundPort} → ${c.remoteHost}:${c.remotePort}`
    this.events.onInfo(this.tunnelId, `隧道已就绪：${desc}`)
    log.info(`隧道就绪 ${this.tunnelId} (${c.type}) ${desc}`)
  }

  /** 本地转发：本地监听，每个连接经 SSH forwardOut 到远端目标 */
  private async startLocal(): Promise<void> {
    const c = this.config
    const session = resolveCarrierSession(c.serverId)

    const server = createServer((local) => {
      this.trackSocket(local)
      session.client.forwardOut(
        c.localHost || '127.0.0.1',
        this.boundPort || 0,
        c.remoteHost,
        c.remotePort,
        (err, stream) => {
          if (err) {
            this.events.onError(this.tunnelId, `转发失败: ${err.message}`)
            local.destroy()
            return
          }
          // 双向管道；任一端关闭时销毁另一端，避免半开连接堆积
          local.pipe(stream as unknown as NodeJS.WritableStream)
          ;(stream as unknown as NodeJS.ReadableStream).pipe(local)
          const cleanup = (): void => {
            local.destroy()
            try {
              ;(stream as unknown as { end?: () => void }).end?.()
            } catch {
              /* 忽略 */
            }
          }
          local.on('close', cleanup)
          local.on('error', cleanup)
          ;(stream as unknown as NodeJS.EventEmitter).on?.('close', cleanup)
          ;(stream as unknown as NodeJS.EventEmitter).on?.('error', cleanup)
        },
      )
    })

    await this.listen(server, c.localHost, c.localPort)
    this.server = server
  }

  /** 远程转发：请求远端监听，收到连接时转回本机目标 */
  private async startRemote(): Promise<void> {
    const c = this.config
    const session = resolveCarrierSession(c.serverId)

    await new Promise<void>((resolve, reject) => {
      session.client.forwardIn(c.remoteHost, c.remotePort, (err) => {
        if (err) return reject(AppError.internal(`远端监听失败: ${err.message}`))
        resolve()
      })
    })

    const onTcpConnection = (_info: unknown, accept: () => NodeJS.ReadWriteStream, rejectConn: () => void): void => {
      const local = connect(c.localPort, c.localHost || '127.0.0.1')
      this.trackSocket(local)

      local.on('connect', () => {
        const stream = accept()
        local.pipe(stream)
        stream.pipe(local)
        const cleanup = (): void => {
          local.destroy()
          try {
            stream.end()
          } catch {
            /* 忽略 */
          }
        }
        local.on('close', cleanup)
        local.on('error', cleanup)
        stream.on('close', cleanup)
        stream.on('error', cleanup)
      })

      local.on('error', (err) => {
        this.events.onWarn(this.tunnelId, `本机目标不可达 ${c.localHost}:${c.localPort} — ${err.message}`)
        try {
          rejectConn()
        } catch {
          /* 忽略 */
        }
      })
    }

    session.client.on('tcp connection', onTcpConnection)
    // 关闭时移除监听
    this.remoteCleanup = () => {
      session.client.removeListener('tcp connection', onTcpConnection)
      try {
        session.client.unforwardIn(c.remoteHost, c.remotePort, () => {
          /* 尽力而为 */
        })
      } catch {
        /* 忽略 */
      }
    }
  }

  /** 动态转发：本地起一个 SOCKS5 服务，按请求目标经 SSH 出站 */
  private async startDynamic(): Promise<void> {
    const c = this.config
    const session = resolveCarrierSession(c.serverId)

    const server = createServer((client) => {
      this.trackSocket(client)
      handleSocks5(client, (targetHost, targetPort) =>
        new Promise((resolve, reject) => {
          session.client.forwardOut('127.0.0.1', 0, targetHost, targetPort, (err, stream) => {
            if (err) return reject(err)
            resolve(stream)
          })
        }),
      )
    })

    await this.listen(server, c.localHost, c.localPort)
    this.server = server
  }

  private remoteCleanup: (() => void) | null = null

  /** 监听并在端口冲突时给出明确错误 */
  private listen(server: Server, host: string, port: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const onError = (err: NodeJS.ErrnoException): void => {
        server.removeListener('listening', onListening)
        if (err.code === 'EADDRINUSE') {
          reject(AppError.conflict(`端口已被占用: ${host}:${port}`))
        } else if (err.code === 'EACCES') {
          reject(AppError.forbidden(`无权限监听 ${host}:${port}（<1024 需要特权）`))
        } else {
          reject(AppError.internal(`监听失败: ${err.message}`))
        }
      }
      const onListening = (): void => {
        server.removeListener('error', onError)
        const addr = server.address()
        if (addr && typeof addr === 'object') this.boundPort = addr.port
        resolve()
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(port, host || '127.0.0.1')
    })
  }

  private trackSocket(sock: Socket): void {
    this.sockets.add(sock)
    const forget = (): void => {
      this.sockets.delete(sock)
    }
    sock.on('close', forget)
    sock.on('error', forget)
  }

  /**
   * 隧道断开：按指数退避重连。
   * 用户主动 close() 时不重连。
   */
  private scheduleReconnect(reason: string): void {
    if (this.closedByUser) return
    if (!this.config.autoReconnect) {
      this.setState('failed', reason)
      return
    }
    if (this.attempt >= this.reconnect.attempts) {
      this.setState('failed', `${reason}（已重试 ${this.attempt} 次，放弃）`)
      return
    }

    this.attempt += 1
    const delay = Math.min(this.reconnect.baseMs * 2 ** (this.attempt - 1), this.reconnect.maxMs)
    this.setState('reconnecting', `${reason} — ${Math.round(delay / 1000)}s 后第 ${this.attempt} 次重试`)

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      void this.restart()
    }, delay)
  }

  private async restart(): Promise<void> {
    this.teardown()
    try {
      await this.start()
    } catch (err) {
      this.scheduleReconnect(err instanceof Error ? err.message : String(err))
    }
  }

  /** 资源清理（不改变用户意图标记） */
  private teardown(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    for (const s of this.sockets) s.destroy()
    this.sockets.clear()

    if (this.server) {
      this.server.close()
      this.server = null
    }
    if (this.remoteCleanup) {
      this.remoteCleanup()
      this.remoteCleanup = null
    }
  }

  /** 用户主动关闭 */
  close(): void {
    this.closedByUser = true
    this.teardown()
    this.setState('closed')
    log.info(`隧道已关闭 ${this.tunnelId}`)
  }
}

/**
 * 极简 SOCKS5 服务端（动态转发的本地侧）。
 * 只实现 CONNECT 命令；不做认证（绑定在 127.0.0.1 或用户指定地址）。
 */
function handleSocks5(
  socket: Socket,
  open: (host: string, port: number) => Promise<NodeJS.ReadWriteStream>,
): void {
  let stage: 'greeting' | 'request' | 'done' = 'greeting'

  socket.on('data', (chunk: Buffer) => {
    if (stage === 'greeting') {
      if (chunk.length < 2 || chunk[0] !== 0x05) {
        socket.destroy()
        return
      }
      // 只接受"无认证"
      socket.write(Buffer.from([0x05, 0x00]))
      stage = 'request'
      // 可能同一包里带着请求，继续走下面的分支
      const rest = chunk.subarray(2)
      if (rest.length > 0) void handleRequest(rest)
      return
    }
    if (stage === 'request') {
      void handleRequest(chunk)
    }
  })

  async function handleRequest(buf: Buffer): Promise<void> {
    stage = 'done'
    if (buf.length < 7 || buf[0] !== 0x05 || buf[1] !== 0x01) {
      // 只支持 CONNECT
      socket.write(Buffer.from([0x05, 0x07, 0x00, 0x01, 0, 0, 0, 0, 0, 0]))
      socket.destroy()
      return
    }

    const atyp = buf[3]
    let host = ''
    let portOffset = 0

    if (atyp === 0x01) {
      if (buf.length < 10) return fail(0x08)
      host = `${buf[4]}.${buf[5]}.${buf[6]}.${buf[7]}`
      portOffset = 8
    } else if (atyp === 0x03) {
      const len = buf[4] ?? 0
      if (buf.length < 5 + len + 2) return fail(0x08)
      host = buf.subarray(5, 5 + len).toString('utf8')
      portOffset = 5 + len
    } else if (atyp === 0x04) {
      if (buf.length < 22) return fail(0x08)
      const parts: string[] = []
      for (let i = 0; i < 8; i++) parts.push(((buf[4 + i * 2] ?? 0) << 8 | (buf[5 + i * 2] ?? 0)).toString(16))
      host = parts.join(':')
      portOffset = 20
    } else {
      return fail(0x08)
    }

    const port = ((buf[portOffset] ?? 0) << 8) | (buf[portOffset + 1] ?? 0)

    try {
      const stream = await open(host, port)
      // 成功响应：BND.ADDR 用 0.0.0.0:0 占位（客户端一般忽略）
      socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]))
      socket.removeAllListeners('data')
      socket.pipe(stream)
      stream.pipe(socket)
      const cleanup = (): void => {
        socket.destroy()
        try {
          stream.end()
        } catch {
          /* 忽略 */
        }
      }
      socket.on('close', cleanup)
      socket.on('error', cleanup)
      stream.on('close', cleanup)
      stream.on('error', cleanup)
    } catch {
      fail(0x05) // connection refused
    }
  }

  function fail(code: number): void {
    try {
      socket.write(Buffer.from([0x05, code, 0x00, 0x01, 0, 0, 0, 0, 0, 0]))
    } catch {
      /* 忽略 */
    }
    socket.destroy()
  }
}

/** 预置的快速填充模板（与原产品常用组合对齐，命名自研） */
export function quickFillTemplates(): Array<{
  label: string
  type: ForwardType
  localHost: string
  localPort: number
  remoteHost: string
  remotePort: number
}> {
  return [
    { label: '动态代理 (SOCKS5 1080)', type: 'dynamic', localHost: '127.0.0.1', localPort: 1080, remoteHost: '', remotePort: 0 },
    { label: '本地转发 MySQL 3306 → 3307', type: 'local', localHost: '127.0.0.1', localPort: 3307, remoteHost: '127.0.0.1', remotePort: 3306 },
    { label: '本地转发 Web 80 → 8080', type: 'local', localHost: '127.0.0.1', localPort: 8080, remoteHost: '127.0.0.1', remotePort: 80 },
    { label: '远程转发 服务器9000 → 本机3000', type: 'remote', localHost: '127.0.0.1', localPort: 3000, remoteHost: '127.0.0.1', remotePort: 9000 },
  ]
}
