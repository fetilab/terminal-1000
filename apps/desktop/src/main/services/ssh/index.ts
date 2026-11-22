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
import { getStoreServiceIfExists, isLockedMask } from '../store'
import { SshManager } from './manager'

const log = createLogger('ssh-ipc')

/**
 * 用库里的最新解密记录覆盖渲染层传来的机密字段。
 *
 * 渲染层缓存的连接对象可能带着 `__LOCKED__` 掩码（重启后库还没解锁时加载的），
 * 直接拿去连会把掩码当口令/私钥喂给 ssh2，报出一堆莫名其妙的
 * "Cannot parse privateKey" 错误。以主进程存储为准：payload 里非空且非掩码的
 * 机密字段保留（testConnection 的未保存草稿场景），否则用库里的新值。
 * 库锁定时给明确报错，而不是让 ssh2 报解析错误。
 */
function withFreshSecrets<T extends { id?: string }>(conn: T): T {
  if (!conn.id) return conn
  const svc = getStoreServiceIfExists()
  // 服务还没初始化（纯 ssh 单测场景）：退回 payload 原样，掩码字段丢弃
  if (!svc) return stripMaskedSecrets(conn)
  let fresh: Record<string, unknown> | undefined
  try {
    fresh = svc.getConnection(conn.id) as unknown as Record<string, unknown>
  } catch {
    // 库里没有这条（未保存的草稿）——按 payload 原样，掩码字段丢弃
    return stripMaskedSecrets(conn)
  }
  if (!fresh) return stripMaskedSecrets(conn)

  const svcLocked = !svc.isUnlocked()
  const out = { ...conn } as Record<string, unknown>
  for (const field of ['password', 'privateKey', 'passphrase', 'identityId'] as const) {
    const local = out[field]
    const localOk = typeof local === 'string' && local.length > 0 && !isLockedMask(local)
    if (localOk) continue
    const f = fresh[field]
    if (typeof f === 'string' && f.length > 0 && !isLockedMask(f)) {
      out[field] = f
    } else {
      // fresh 里也没有可用值；字段一并清掉（掩码绝不能往下传）
      delete out[field]
    }
  }
  // jumpChain 每一跳的机密字段同理（按跳 id 匹配；编辑表单可能重排顺序）
  if (Array.isArray(out.jumpChain) && Array.isArray(fresh.jumpChain)) {
    const freshHops = fresh.jumpChain as Record<string, unknown>[]
    out.jumpChain = (out.jumpChain as Record<string, unknown>[]).map((hop, i) => {
      const hopId = typeof hop.id === 'string' ? hop.id : undefined
      const freshHop =
        (hopId !== undefined ? freshHops.find((h) => h?.id === hopId) : undefined) ?? freshHops[i]
      const merged = { ...hop }
      for (const field of ['password', 'privateKey', 'passphrase', 'identityId'] as const) {
        const local = merged[field]
        const localOk = typeof local === 'string' && local.length > 0 && !isLockedMask(local)
        if (localOk) continue
        const f = freshHop?.[field]
        if (typeof f === 'string' && f.length > 0 && !isLockedMask(f)) merged[field] = f
        else delete merged[field]
      }
      return merged
    })
  }
  // 库里有密文但当前锁定 → 解不出真值，给明确指引而不是让 ssh2 报解析错误
  if (svcLocked && hasEncryptedSecrets(fresh)) {
    throw AppError.unauthorized('这条连接的凭据保存在本地库中，当前处于锁定状态，请先解锁主密码再连接')
  }
  return out as T
}

/** 递归检查 payload 里有没有本产品的密文（v1: 前缀）机密字段 */
function hasEncryptedSecrets(value: unknown): boolean {
  if (typeof value === 'string') return false
  if (value === null || typeof value !== 'object') return false
  const obj = value as Record<string, unknown>
  for (const [k, v] of Object.entries(obj)) {
    if (
      ['password', 'privateKey', 'passphrase'].includes(k) &&
      typeof v === 'string' &&
      v.startsWith('v1:')
    ) {
      return true
    }
    if (hasEncryptedSecrets(v)) return true
  }
  return false
}

/** 库里没有对应记录时（未保存草稿）：掩码字段丢弃，绝不下传 */
function stripMaskedSecrets<T>(conn: T): T {
  const out = { ...(conn as Record<string, unknown>) }
  for (const field of ['password', 'privateKey', 'passphrase', 'identityId'] as const) {
    if (isLockedMask(out[field])) delete out[field]
  }
  if (Array.isArray(out.jumpChain)) {
    out.jumpChain = (out.jumpChain as Record<string, unknown>[]).map((hop) => {
      const h = { ...hop }
      for (const field of ['password', 'privateKey', 'passphrase', 'identityId'] as const) {
        if (isLockedMask(h[field])) delete h[field]
      }
      return h
    })
  }
  return out as T
}

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
    // identity 认证的凭证解析：按 id 从库里取凭证并解密。
    // 此前生产代码从未接这条线 —— identity 类连接永远拿不到私钥，
    // 只会报"All configured authentication methods failed"。
    // 锁定态下 hydrate 出来的是掩码，绝不能当真值返回。
    (id: string) => {
      const svc = getStoreServiceIfExists()
      if (!svc) return undefined
      try {
        const cred = svc.getCredential(id)
        if (!cred) return undefined
        const pick = (v: string | undefined): string | undefined =>
          typeof v === 'string' && v.length > 0 && !isLockedMask(v) ? v : undefined
        return {
          ...(pick(cred.privateKey) !== undefined ? { privateKey: pick(cred.privateKey) } : {}),
          ...(pick(cred.passphrase) !== undefined ? { passphrase: pick(cred.passphrase) } : {}),
          ...(pick(cred.password) !== undefined ? { password: pick(cred.password) } : {}),
        }
      } catch {
        return undefined
      }
    },
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
    const sessionId = await getManager(ctx).connect(withFreshSecrets(connection as unknown as SshConnection))
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
    return getManager(ctx).testConnection(withFreshSecrets(connection as unknown as SshConnection))
  },

  reconnect: async (payload, ctx) => {
    const { connection } = connectSchema.parse(payload)
    const sessionId = await getManager(ctx).connect(withFreshSecrets(connection as unknown as SshConnection))
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
