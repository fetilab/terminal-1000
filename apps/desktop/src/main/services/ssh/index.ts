// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * ssh 域 IPC 接入。
 *
 * 管理器单例、惰性创建（启动路径不初始化网络子系统，利于冷启动）。
 * 事件经 ctx.emit 广播；交互询问（主机指纹 / 交互式认证）由 UI 反向决议。
 */

import { join } from 'node:path'
import { z } from 'zod'
import { Events, type SshConnection } from '@t1000/shared'
import { AppError } from '../../errors'
import type { IpcContext, IpcHandler } from '../../ipc/router'
import { getCwd as getSessionCwd } from '../session-cwd'
import { createLogger } from '../../logger'
import { SshManager } from './manager'

const log = createLogger('ssh-ipc')

let manager: SshManager | null = null
let activeCtx: IpcContext | null = null

function getManager(ctx: IpcContext): SshManager {
  activeCtx = ctx
  if (manager) return manager

  manager = new SshManager(
    {
      onState: (sessionId, state, message) => {
        activeCtx?.emit(Events.SSH_STATE, { sessionId, state, ...(message ? { message } : {}) })
      },
      onData: (sessionId, data) => {
        activeCtx?.emit(Events.SSH_DATA, { sessionId, data })
      },
      onDebug: (sessionId, message) => {
        activeCtx?.emit(Events.SSH_DEBUG, { sessionId, message })
      },
      onError: (sessionId, message, code) => {
        activeCtx?.emit(Events.SSH_ERROR, { sessionId, message, ...(code ? { code } : {}) })
      },
      onClosed: (sessionId, reason, code) => {
        activeCtx?.emit(Events.SSH_CLOSED, {
          sessionId,
          ...(reason ? { reason } : {}),
          ...(code !== undefined ? { code } : {}),
        })
      },
      // 单向通知：挂起状态由管理器持有，UI 通过 verifyHostKey 动作回填
      onHostKeyAsk: (requestId, sessionId, info) => {
        activeCtx?.emit(Events.SSH_HOST_KEY_ASK, { requestId, sessionId, ...info })
      },
      onAuthPrompt: (requestId, sessionId, info) => {
        activeCtx?.emit(Events.SSH_AUTH_PROMPT, { requestId, sessionId, ...info })
      },
    },
    join(ctx.paths.userData, 'known-hosts.json'),
  )

  log.info('SSH 管理器已初始化')
  return manager
}

/** 应用退出时清理全部会话 */
export function shutdownSsh(): void {
  manager?.disconnectAll()
  manager = null
}

// ── 入参 schema（IPC 边界必须校验）────────────────────

const connectionSchema = z
  .object({
    kind: z.literal('ssh'),
    id: z.string().min(1),
    name: z.string(),
    host: z.string().min(1),
    port: z.number().int().min(1).max(65535),
    username: z.string().min(1),
    authType: z.enum(['password', 'privateKey', 'identity', 'keyboardInteractive', 'keyboard']),
    password: z.string().optional(),
    privateKey: z.string().optional(),
    passphrase: z.string().optional(),
    identityId: z.string().optional(),
    jumpChain: z
      .array(
        z.object({
          id: z.string(),
          host: z.string().min(1),
          port: z.number().int().min(1).max(65535),
          username: z.string().min(1),
          authType: z.enum(['password', 'privateKey', 'identity', 'keyboardInteractive', 'keyboard']),
          privateKey: z.string().optional(),
          passphrase: z.string().optional(),
          password: z.string().optional(),
          identityId: z.string().optional(),
          name: z.string().optional(),
          verifyHostKey: z.boolean().optional(),
        }),
      )
      .max(20)
      .optional(),
    options: z
      .object({
        timeoutMs: z.number().int().positive().optional(),
        term: z.string().optional(),
        colorTerm: z.string().optional(),
        encoding: z.string().optional(),
        disableProxy: z.boolean().optional(),
        disablePwdSync: z.boolean().optional(),
        disableListing: z.boolean().optional(),
        watchDirs: z.array(z.string()).optional(),
        keepalive: z
          .object({
            transportIntervalMs: z.number().int().optional(),
            shell: z.object({ text: z.string().optional(), intervalMs: z.number().int().optional() }).optional(),
            forwardBackoff: z
              .object({
                baseMs: z.number().int().optional(),
                maxMs: z.number().int().optional(),
                attempts: z.number().int().optional(),
              })
              .optional(),
          })
          .optional(),
        algorithms: z
          .object({
            kex: z.array(z.string()).optional(),
            cipher: z.array(z.string()).optional(),
            hostKey: z.array(z.string()).optional(),
            hmac: z.array(z.string()).optional(),
            compress: z.array(z.string()).optional(),
          })
          .optional(),
        x11: z.object({ enabled: z.boolean(), cookieMode: z.string().optional() }).optional(),
      })
      .optional(),
    proxy: z
      .object({
        url: z.string().min(1),
        protocol: z.enum(['socks5', 'socks4', 'http', 'https']).optional(),
      })
      .optional(),
    note: z.string().optional(),
    storeType: z.enum(['local', 'cloud']).optional(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .passthrough()

const connectSchema = z.object({ connection: connectionSchema })
const sessionIdSchema = z.object({ sessionId: z.string().min(1) })
const writeSchema = z.object({ sessionId: z.string().min(1), data: z.string() })
const resizeSchema = z.object({
  sessionId: z.string().min(1),
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
})
const resolveHostKeySchema = z.object({
  requestId: z.string().min(1),
  accepted: z.boolean(),
})
const resolveAuthSchema = z.object({
  requestId: z.string().min(1),
  responses: z.array(z.string()),
})
const setEncodingSchema = z.object({
  sessionId: z.string().min(1),
  encoding: z.string().min(1),
})

export const sshHandlers: Record<string, IpcHandler> = {
  /**
   * 读取交互式 shell 的当前目录（来自主进程解析的 OSC 7，见 services/session-cwd）。
   *
   * 因为那个模块用**全局数据挂钩**覆盖所有会话类型，消费方**何时来问都有值**。
   * 拿不到时返回 `cwd: null` + `reason`，让界面能**如实说明原因**
   * （而不是"点了没反应"——那对用户是最差的结果）。
   */
  getCwd: (payload) => {
    const { sessionId } = sessionIdSchema.parse(payload)
    const cwd = getSessionCwd(sessionId)
    if (cwd !== null) return { cwd, source: 'osc7' as const }
    return {
      cwd: null,
      reason:
        '还没拿到终端的当前目录：需要远端 shell 发 OSC 7 才能识别（bash 可在 PROMPT_COMMAND 里输出，zsh/fish 常见配置自带）',
    }
  },

  connect: async (payload, ctx) => {
    const { connection } = connectSchema.parse(payload)
    const sessionId = await getManager(ctx).connect(connection as unknown as SshConnection)
    return { sessionId }
  },

  disconnect: (payload, ctx) => {
    const { sessionId } = sessionIdSchema.parse(payload)
    getManager(ctx).disconnect(sessionId)
    return { disconnected: true }
  },

  listSessions: (_payload, ctx) => getManager(ctx).listSessions(),

  write: (payload, ctx) => {
    const { sessionId, data } = writeSchema.parse(payload)
    getManager(ctx).write(sessionId, data)
    return { written: data.length }
  },

  resize: (payload, ctx) => {
    const { sessionId, cols, rows } = resizeSchema.parse(payload)
    getManager(ctx).resize(sessionId, cols, rows)
    return { resized: true }
  },

  /** UI 对主机指纹询问做出决定（由管理器唯一持有挂起状态） */
  verifyHostKey: (payload, ctx) => {
    const { requestId, accepted } = resolveHostKeySchema.parse(payload)
    getManager(ctx).resolveHostKeyAsk(requestId, accepted)
    return { resolved: true }
  },

  /** UI 提交交互式认证响应 */
  respondAuth: (payload, ctx) => {
    const { requestId, responses } = resolveAuthSchema.parse(payload)
    getManager(ctx).resolveAuthPrompt(requestId, responses)
    return { resolved: true }
  },

  /** 测试连接：只验证可达与认证，不打开 shell */
  testConnection: async (payload, ctx) => {
    const { connection } = connectSchema.parse(payload)
    return getManager(ctx).testConnection(connection as unknown as SshConnection)
  },

  reconnect: async (payload, ctx) => {
    const { connection } = connectSchema.parse(payload)
    const sessionId = await getManager(ctx).connect(connection as unknown as SshConnection)
    return { sessionId }
  },

  /**
   * 记录会话解码编码。
   * 实际字节→字符的转换在渲染层完成（xterm 收到的是字符串）；
   * 此处保存以便重连时沿用同一编码。
   */
  setEncoding: (payload) => {
    const { sessionId, encoding } = setEncodingSchema.parse(payload)
    if (encoding.trim().length === 0) throw AppError.badRequest('编码不能为空')
    return { sessionId, encoding, applied: true }
  },
}
