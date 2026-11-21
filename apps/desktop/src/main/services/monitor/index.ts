// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * monitor 域 IPC 接入。
 *
 * 动作清单见 packages/shared/src/ipc.ts 的 Actions.monitor。
 * - 采集器单例、惰性创建（启动路径不初始化网络子系统，利于冷启动）。
 * - 取会话走中立契约 `requireSession`，不 import ssh 服务内部实现。
 * - 事件经 ctx.emit 广播；日志用注入的 ctx.logger（本模块不直接 import logger，
 *   避免 import 链把 Electron 运行时拖进单测）。
 */

import { z } from 'zod'
import { join } from 'node:path'
import type { SFTPWrapper } from 'ssh2'
import { Events, type AgentProbeInfo } from '@t1000/shared'
import { AppError } from '../../errors'
import type { IpcContext, IpcHandler } from '../../ipc/router'
import { requireSession, subscribeSessionClosed } from '../session-registry'
import { AgentPrefs, AgentService } from './agent'
import { AGENT_VERSION } from './agent-source'
import { MonitorCollector, type CollectorTransport } from './collector'

let collector: MonitorCollector | null = null
let agentService: AgentService | null = null
let activeCtx: IpcContext | null = null
let closedSubscribed = false

/** 应用退出时清理所有定时器 */
export function shutdownMonitor(): void {
  collector?.dispose()
  collector = null
  agentService = null
}

/**
 * 把一段字节写到远端文件（SFTP）。
 *
 * 监控代理是 5MB 级的静态二进制，没法用 base64 + heredoc 过命令行（ARG_MAX 约 2MB），
 * 所以走 SFTP 写文件流。写完由远端 `chmod + mv` 原子激活 —— 中途断开也不会
 * 留下一个"看起来存在、其实是半个文件"的可执行文件。
 */
async function putRemoteFile(
  sessionId: string,
  remotePath: string,
  data: Buffer,
  mode: number,
): Promise<void> {
  const { client } = requireSessionOrThrow(sessionId)
  const sftp = await new Promise<SFTPWrapper>((resolve, reject) => {
    client.sftp((err, handle) => (err ? reject(err) : resolve(handle)))
  })
  try {
    await new Promise<void>((resolve, reject) => {
      const stream = sftp.createWriteStream(remotePath, { mode, autoClose: true })
      stream.on('close', () => resolve())
      stream.on('error', reject)
      stream.end(data)
    })
  } finally {
    sftp.end()
  }
}

function requireSessionOrThrow(sessionId: string): ReturnType<typeof requireSession> {
  try {
    return requireSession(sessionId)
  } catch (err) {
    throw AppError.notConnected(err instanceof Error ? err.message : String(err))
  }
}

function getCollector(ctx: IpcContext): MonitorCollector {
  activeCtx = ctx
  if (collector) return collector

  const transport: CollectorTransport = {
    exec: (sessionId, command, timeoutMs) => {
      const session = requireSessionOrThrow(sessionId)
      return session.exec(command, timeoutMs === undefined ? undefined : { timeoutMs })
    },
    // 代理优先；AgentService 自己负责"没装就返回 null"，采集器据此回退脚本
    agentSample: (sessionId, modules, options) => getAgentService(ctx).sample(sessionId, modules, options),
  }

  collector = new MonitorCollector(transport, {
    onSnapshot: (sessionId, snapshot) => {
      activeCtx?.emit(Events.MONITOR_SNAPSHOT, { sessionId, snapshot })
    },
    onStatus: (sessionId, status, message) => {
      activeCtx?.emit(Events.MONITOR_STATUS, {
        sessionId,
        status,
        ...(message === undefined ? {} : { message }),
      })
    },
    onError: (sessionId, message) => {
      activeCtx?.emit(Events.MONITOR_ERROR, { sessionId, message })
    },
  })

  // 会话断开 → 清掉采集状态与代理隧道（否则 Map 里会留下永远不用的通道）
  if (!closedSubscribed) {
    closedSubscribed = true
    subscribeSessionClosed((sessionId) => {
      collector?.forget(sessionId)
      agentService?.forget(sessionId)
    })
  }
  return collector
}

function getAgentService(ctx: IpcContext): AgentService {
  if (agentService) return agentService
  agentService = new AgentService(
    (sessionId, command, timeoutMs) =>
      requireSessionOrThrow(sessionId).exec(command, timeoutMs === undefined ? undefined : { timeoutMs }),
    new AgentPrefs(join(ctx.paths.userData, 'monitor-agents.json')),
    (sessionId, remotePath, data, mode) => putRemoteFile(sessionId, remotePath, data, mode),
  )
  return agentService
}

// ── 入参 schema（IPC 边界必须校验）────────────────────

const cardSchema = z.object({
  kind: z.enum(['system', 'cpu', 'memory', 'network', 'disk', 'process', 'gpu']),
  enabled: z.boolean(),
  order: z.number().int(),
  tier: z.enum(['fast', 'medium', 'slow']),
})

const startSchema = z.object({
  sessionId: z.string().min(1),
  cards: z.array(cardSchema).max(32).optional(),
  processLimit: z.number().int().min(1).max(200).optional(),
  failurePauseThreshold: z.number().int().min(1).max(100).optional(),
})

const sessionSchema = z.object({ sessionId: z.string().min(1) })

const snapshotSchema = z.object({
  sessionId: z.string().min(1),
  force: z.boolean().optional(),
})

const cardsQuerySchema = z.object({ sessionId: z.string().min(1).optional() })

const setCardsSchema = z.object({
  sessionId: z.string().min(1).optional(),
  cards: z.array(cardSchema).max(32),
})

const declineSchema = z.object({
  sessionId: z.string().min(1),
  forever: z.boolean().optional(),
})

export const monitorHandlers: Record<string, IpcHandler> = {
  /** 开始监控（幂等：重复 start 返回当前快照） */
  start: async (payload, ctx) => {
    const { sessionId, cards, processLimit, failurePauseThreshold } = startSchema.parse(payload)
    const target = getCollector(ctx)
    // 先探测一次会话存在性，给出 NOT_CONNECTED 而不是 INTERNAL
    requireSessionOrThrow(sessionId)

    const settings = {
      ...(cards === undefined ? {} : { cards }),
      ...(processLimit === undefined ? {} : { processLimit }),
      ...(failurePauseThreshold === undefined ? {} : { failurePauseThreshold }),
    }
    const snapshot = await target.start(sessionId, settings)
    return { sessionId, status: target.getStatus(sessionId), snapshot }
  },

  stop: (payload, ctx) => {
    const { sessionId } = sessionSchema.parse(payload)
    const target = getCollector(ctx)
    target.stop(sessionId)
    return { sessionId, status: target.getStatus(sessionId) }
  },

  /** 取当前快照：默认吃缓存（一个快档周期内），force 时强制重新采集 */
  getSnapshot: async (payload, ctx) => {
    const { sessionId, force } = snapshotSchema.parse(payload)
    const target = getCollector(ctx)

    if (force === true) {
      requireSessionOrThrow(sessionId)
      return target.snapshot(sessionId, { force: true })
    }
    const cached = target.peek(sessionId)
    if (cached) return cached
    if (target.getStatus(sessionId) === 'idle') return emptySnapshot(sessionId)
    return target.snapshot(sessionId)
  },

  listCards: (payload, ctx) => {
    const { sessionId } = cardsQuerySchema.parse(payload ?? {})
    return getCollector(ctx).getSettings(sessionId)
  },

  setCards: (payload, ctx) => {
    const { sessionId, cards } = setCardsSchema.parse(payload)
    return getCollector(ctx).setCards(cards, sessionId)
  },

  /** 手动刷新：清失败计数，已暂停则恢复调度 */
  refresh: async (payload, ctx) => {
    const { sessionId } = sessionSchema.parse(payload)
    requireSessionOrThrow(sessionId)
    return getCollector(ctx).refresh(sessionId)
  },

  /**
   * 探测远端监控代理。
   *
   * UI 在连接成功后调用：`installed=false && decision='ask'` 就弹窗问用户装不装。
   * 只探测，不安装 —— 装软件这种事必须用户点头。
   */
  probeAgent: async (payload, ctx) => {
    const { sessionId } = sessionSchema.parse(payload)
    const session = requireSessionOrThrow(sessionId)
    const probe = await getAgentService(ctx).probe(sessionId)
    return {
      ...probe,
      /**
       * sessionId 必须回传：渲染层拿到的是这一份，弹窗里的「安装 / 暂不 / 不再询问」
       * 都要靠它去调后续 IPC。少这个字段，点安装就是 `sessionId: Required`。
       */
      sessionId,
      host: session.host,
      port: session.port ?? null,
      username: session.username,
      /** 代理版本落后时也算"需要升级"，UI 文案不同 */
      needsUpgrade: probe.installed && probe.version !== null && probe.version !== AGENT_VERSION,
      agentVersion: AGENT_VERSION,
    } satisfies AgentProbeInfo
  },

  /** 安装并启动代理（用户点了"安装并启用"） */
  installAgent: async (payload, ctx) => {
    const { sessionId } = sessionSchema.parse(payload)
    requireSessionOrThrow(sessionId)
    const result = await getAgentService(ctx).install(sessionId)
    return { ...result, tunnel: 'ssh-direct-tcpip' as const }
  },

  /** 停止代理（保留文件，下次连接会自动再启动） */
  stopAgent: async (payload, ctx) => {
    const { sessionId } = sessionSchema.parse(payload)
    requireSessionOrThrow(sessionId)
    await getAgentService(ctx).stop(sessionId, false)
    return { stopped: true }
  },

  /** 卸载代理（删文件 + 停止 + 记住"不再安装"） */
  uninstallAgent: async (payload, ctx) => {
    const { sessionId } = sessionSchema.parse(payload)
    requireSessionOrThrow(sessionId)
    await getAgentService(ctx).stop(sessionId, true)
    return { uninstalled: true }
  },

  /** 用户拒绝安装：forever=true 对应"不再询问这台服务器" */
  declineAgent: (payload, ctx) => {
    const { sessionId, forever } = declineSchema.parse(payload)
    getAgentService(ctx).decline(sessionId, forever === true)
    return { declined: true, forever }
  },
}

function emptySnapshot(sessionId: string): {
  sessionId: string
  at: string
  warnings: string[]
} {
  return {
    sessionId,
    at: new Date().toISOString(),
    warnings: ['该会话尚未开始监控'],
  }
}
