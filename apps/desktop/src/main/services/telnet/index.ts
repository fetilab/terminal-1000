// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * telnet 域：Telnet 会话。
 *
 * 目标场景主要是**网络设备**（交换机/路由器/老设备）—— 这与 SSH 的使用方式不同：
 * - 端口默认 23，通常没有认证层（设备自己弹提示符）
 * - 键位常需适配（有些设备把 Backspace 认成 DEL，或不认方向键）
 * - 必须正确处理选项协商，否则终端里会出现 `^[ÿû` 之类乱码
 *
 * 输出同样**按帧合批**（复用 output-batcher），与 SSH/PTY 保持一致的吞吐特性。
 */

import { connect, type Socket } from 'node:net'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { Events, type ConnectionState, type TelnetConnection } from '@t1000/shared'
import { AppError, parseInput } from '../../errors'
import type { IpcContext, IpcHandler } from '../../ipc/router'
import { createLogger } from '../../logger'
import { OutputBatcher } from '../output-batcher'
import { registerWritable, unregisterWritable } from '../session-registry'
import { applyKeyMapping, TelnetProtocol, type KeyMappingRule } from './protocol'

const log = createLogger('telnet')

/** 与 SSH/PTY 一致的合批参数 */
const BATCH_MS = 16
const BATCH_MAX_BYTES = 256 * 1024

interface TelnetSession {
  sessionId: string
  connection: TelnetConnection
  socket: Socket
  protocol: TelnetProtocol
  batcher: OutputBatcher
  state: ConnectionState
  /** 用户配置的按键映射（已解析） */
  keyRules: KeyMappingRule[] | undefined
}

const sessions = new Map<string, TelnetSession>()

let activeCtx: IpcContext | null = null

function emitState(session: TelnetSession, state: ConnectionState, message?: string): void {
  session.state = state
  activeCtx?.emit(Events.TELNET_STATE, {
    sessionId: session.sessionId,
    state,
    ...(message ? { message } : {}),
  })
}

/** 建立连接 */
function connectSession(connection: TelnetConnection, ctx: IpcContext): Promise<string> {
  activeCtx = ctx

  return new Promise<string>((resolve, reject) => {
    const sessionId = randomUUID()
    const socket = connect({ host: connection.host, port: connection.port })

    const batcher = new OutputBatcher({
      windowMs: BATCH_MS,
      maxBytes: BATCH_MAX_BYTES,
      onFlush: (chunk) => {
        activeCtx?.emit(Events.TELNET_DATA, { sessionId, data: chunk })
      },
    })

    const protocol = new TelnetProtocol({

      onNegotiation: (event) => {
        // 协商过程透出给渲染层，便于诊断"连上但键盘没反应"
        activeCtx?.emit(Events.TELNET_NEGOTIATION, { sessionId, ...event })
      },
      // 连接级选项（终端类型/尺寸）会影响对端排版，必须透传给协议层
      ...(connection.options?.term !== undefined ? { terminalType: connection.options.term } : {}),
      ...(connection.options?.cols !== undefined ? { cols: connection.options.cols } : {}),
      ...(connection.options?.rows !== undefined ? { rows: connection.options.rows } : {}),
    })

    const keyRules = connection.keyMapping?.rules
    const session: TelnetSession = {
      sessionId,
      connection,
      socket,
      protocol,
      batcher,
      state: 'connecting',
      keyRules:
        connection.keyMapping?.enabled && keyRules && keyRules.length > 0
          ? keyRules.map((r) => ({ from: r.from, to: r.to }))
          : undefined,
    }
    sessions.set(sessionId, session)

    registerWritable({
      sessionId,
      kind: 'telnet',
      title: connection.name,
      // 复用与 telnet.write 同一路径：按键映射必须一致，
      // 否则广播出去的键位与手动输入不同（网络设备上会表现为"广播时退格变怪字符"）
      write: (data) => {
        if (socket.destroyed) throw new Error('连接已断开')
        socket.write(applyKeyMapping(data, session.keyRules))
      },
      canWrite: () => socket.writable === true && !socket.destroyed,
    })

    let settled = false
    const fail = (message: string): void => {
      if (settled) return
      settled = true
      sessions.delete(sessionId)
      emitState(session, 'failed', message)
      reject(AppError.internal(message))
    }

    socket.setTimeout(connection.options?.timeoutMs ?? 20_000, () => {
      fail(`Telnet 连接超时（${connection.host}:${connection.port}）`)
      socket.destroy()
    })

    socket.once('connect', () => {
      socket.setTimeout(0)
      emitState(session, 'ready')
      log.info(`Telnet 会话就绪 ${sessionId} → ${connection.host}:${connection.port}`)
      resolve(sessionId)
    })

    socket.on('data', (chunk: Buffer) => {
      // 先剥掉协商字节，只把真实数据显示给用户
      const plain = protocol.process(chunk)
      if (plain.length > 0) batcher.push(plain.toString('utf8'))

      // 处理过程中产生的应答（拒绝/接受选项、上报窗口尺寸等）立即回写
      const reply = protocol.drainOutbox()
      if (reply.length > 0 && !socket.destroyed) socket.write(reply)
    })

    socket.on('error', (err: NodeJS.ErrnoException) => {
      if (session.state === 'ready') {
        emitState(session, 'failed', err.message)
      } else {
        fail(err.code ? `${err.code}: ${err.message}` : err.message)
      }
    })

    socket.on('close', () => {
      unregisterWritable(sessionId)
      batcher.dispose({ flushFirst: true })
      sessions.delete(sessionId)
      emitState(session, 'disconnected')
      activeCtx?.emit(Events.TELNET_CLOSED, { sessionId, reason: '远端关闭连接' })
    })
  })
}

// ── IPC ─────────────────────────────────────────────

const connectionSchema = z.object({
  kind: z.literal('telnet'),
  id: z.string().min(1),
  name: z.string(),
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  username: z.string().optional(),
  password: z.string().optional(),
  note: z.string().optional(),
  keyMapping: z
    .object({
      enabled: z.boolean(),
      template: z.string().optional(),
      rules: z.array(z.object({ from: z.string(), to: z.string() })).optional(),
    })
    .optional(),
  storeType: z.enum(['local', 'cloud']).optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
}).passthrough()

const connectSchema = z.object({ connection: connectionSchema })
const sessionIdSchema = z.object({ sessionId: z.string().min(1) })
const writeSchema = z.object({ sessionId: z.string().min(1), data: z.string() })
const resizeSchema = z.object({
  sessionId: z.string().min(1),
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
})

/** 内置按键映射模板：网络设备常见适配 */
export const KEY_MAPPING_TEMPLATES: Array<{ id: string; name: string; description: string; rules: KeyMappingRule[] }> = [
  {
    id: 'standard',
    name: '标准模式',
    description: '默认按键映射，不做任何转换',
    rules: [],
  },
  {
    id: 'backspace-del',
    name: 'Backspace 发送 DEL',
    description: '部分交换机/路由器把退格认成 DEL(0x7f)',
    rules: [{ from: '\b', to: '\\x7f' }],
  },
  {
    id: 'no-arrow-keys',
    name: '方向键转为 VT100 序列',
    description: '当设备不认应用模式方向键时使用',
    rules: [
      { from: '\u001b[A', to: '\\x1bOA' },
      { from: '\u001b[B', to: '\\x1bOB' },
      { from: '\u001b[C', to: '\\x1bOC' },
      { from: '\u001b[D', to: '\\x1bOD' },
    ],
  },
]

export const telnetHandlers: Record<string, IpcHandler> = {
  connect: (payload, ctx) => {
    const { connection } = parseInput(connectSchema, payload)
    return connectSession(connection as unknown as TelnetConnection, ctx).then((sessionId) => ({ sessionId }))
  },

  disconnect: (payload, ctx) => {
    const { sessionId } = parseInput(sessionIdSchema, payload)
    const session = sessions.get(sessionId)
    if (!session) return { disconnected: false }
    try {
      session.socket.destroy()
    } catch {
      /* 已关闭 */
    }
    session.batcher.dispose({ flushFirst: true })
    unregisterWritable(sessionId)
    sessions.delete(sessionId)
    emitState(session, 'disconnected')
    ctx.emit(Events.TELNET_CLOSED, { sessionId, reason: '用户断开' })
    return { disconnected: true }
  },

  /** 发送按键：应用按键映射后再写 */
  write: (payload) => {
    const { sessionId, data } = parseInput(writeSchema, payload)
    const session = sessions.get(sessionId)
    if (!session) throw AppError.notConnected(`Telnet 会话不存在: ${sessionId}`)
    if (session.socket.destroyed) throw AppError.notConnected('连接已断开')

    const bytes = applyKeyMapping(data, session.keyRules)
    session.socket.write(bytes)
    return { written: bytes.length }
  },

  /** 窗口大小变化 → 若对端启用了 NAWS 则上报 */
  resize: (payload) => {
    const { sessionId, cols, rows } = parseInput(resizeSchema, payload)
    const session = sessions.get(sessionId)
    if (!session) return { resized: false }
    const payloadBytes = session.protocol.setWindowSize(cols, rows)
    if (payloadBytes.length > 0 && !session.socket.destroyed) {
      session.socket.write(payloadBytes)
    }
    return { resized: true, reported: payloadBytes.length > 0 }
  },

  /** 列出活跃连接与可选按键映射模板 */
  list: () => ({
    sessions: [...sessions.values()].map((s) => ({
      sessionId: s.sessionId,
      name: s.connection.name,
      host: s.connection.host,
      port: s.connection.port,
      state: s.state,
      negotiations: s.protocol.negotiations.slice(-20),
    })),
    templates: KEY_MAPPING_TEMPLATES,
  }),
}

/** 应用退出时清理 */
export function shutdownTelnet(): void {
  for (const s of sessions.values()) {
    try {
      s.socket.destroy()
    } catch {
      /* 忽略 */
    }
    s.batcher.dispose()
  }
  sessions.clear()
}
