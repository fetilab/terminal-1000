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
import { Events } from '@t1000/shared'
import { AppError } from '../../errors'
import type { IpcContext, IpcHandler } from '../../ipc/router'
import { requireSession } from '../session-registry'
import { MonitorCollector, type CollectorTransport } from './collector'

let collector: MonitorCollector | null = null
let activeCtx: IpcContext | null = null

/** 应用退出时清理所有定时器 */
export function shutdownMonitor(): void {
  collector?.dispose()
  collector = null
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
  return collector
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
