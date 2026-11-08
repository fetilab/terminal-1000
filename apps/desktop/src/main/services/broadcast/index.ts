// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * broadcast 域：并发会话 / 多机广播。
 *
 * 语义（对齐 spec §3.7）：
 * - 多选连接打开后归入一个"组"
 * - **独立模式**：各终端互不影响
 * - **广播模式**：任意成员终端的输入，同步发送到组内所有成员 —— 一次输入多处执行
 *
 * 两个必须如实处理的现实问题（参考实现也提示了这两点）：
 * 1. **影响范围是所有成员**：一次误输入会同时打到 N 台服务器
 * 2. **响应时间不同导致执行顺序差异**：各机回显快慢不一，屏幕上看不出"谁先执行"，
 *    而远端实际耗时不同 —— 涉及有副作用的命令时这很危险，必须让用户知道
 *
 * 实现上刻意不做的事：
 * - **不做输入去重/合并**：用户敲什么就发什么，顺序保持（乱序合并会让远端行为不可预期）
 * - **不隐藏部分失败**：某个成员写不进去时逐条上报 BROADCAST_ERROR，
 *   不静默跳过 —— 否则用户以为"都执行了"
 */

import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { Events, type BroadcastGroupView } from '@t1000/shared'
import { AppError, parseInput } from '../../errors'
import type { IpcContext, IpcHandler } from '../../ipc/router'
import { createLogger } from '../../logger'
import { getWritable, listWritables, unregisterWritable } from '../session-registry'

const log = createLogger('broadcast')

type Mode = 'independent' | 'broadcast'

interface BroadcastGroup {
  groupId: string
  name: string
  mode: Mode
  sessionIds: string[]
  createdAt: number
}

const groups = new Map<string, BroadcastGroup>()
let activeCtx: IpcContext | null = null

// ── 视图 ─────────────────────────────────────────────

function toView(group: BroadcastGroup): BroadcastGroupView {
  return {
    groupId: group.groupId,
    name: group.name,
    mode: group.mode,
    createdAt: new Date(group.createdAt).toISOString(),
    members: group.sessionIds.map((sessionId) => {
      const writable = getWritable(sessionId)
      return {
        sessionId,
        kind: writable?.kind ?? 'ssh',
        title: writable?.title ?? sessionId,
        writable: writable ? writable.canWrite() : false,
      }
    }),
  }
}

function listViews(): BroadcastGroupView[] {
  return [...groups.values()].map(toView)
}

function broadcast(): void {
  activeCtx?.emit(Events.BROADCAST_STATE, { groups: listViews() })
}

function requireGroup(groupId: string): BroadcastGroup {
  const g = groups.get(groupId)
  if (!g) throw AppError.notFound(`广播组不存在: ${groupId}`)
  return g
}

// ── 生命周期 ─────────────────────────────────────────

/** 会话关闭时从所有组里摘掉（由 session-registry 的关闭事件驱动，避免留下幽灵成员） */
export function onSessionClosed(sessionId: string): void {
  let changed = false
  for (const group of groups.values()) {
    const idx = group.sessionIds.indexOf(sessionId)
    if (idx >= 0) {
      group.sessionIds.splice(idx, 1)
      changed = true
    }
  }
  // 成员全没了就自动解散：留一个空组会让用户困惑
  for (const [id, group] of groups) {
    if (group.sessionIds.length === 0) {
      groups.delete(id)
      log.info(`广播组 ${group.name} 成员已全部断开，自动解散`)
      changed = true
    }
  }
  // 会话不可写了，顺手清掉写入口，避免 getWritable 拿到失效对象
  unregisterWritable(sessionId)
  if (changed) broadcast()
}

/** 应用退出时清理 */
export function shutdownBroadcast(): void {
  groups.clear()
  activeCtx = null
}

// ── IPC ─────────────────────────────────────────────

const createSchema = z.object({
  sessionIds: z.array(z.string().min(1)).min(1).max(64),
  name: z.string().max(100).optional(),
  /** 建组即进入广播模式（多选连接"一次打开"时的常见诉求） */
  mode: z.enum(['independent', 'broadcast']).optional(),
})

const groupIdSchema = z.object({ groupId: z.string().min(1) })

const modifySchema = z.object({
  groupId: z.string().min(1),
  sessionIds: z.array(z.string().min(1)).min(1).max(64),
})

const setModeSchema = z.object({
  groupId: z.string().min(1),
  mode: z.enum(['independent', 'broadcast']),
})

const sendSchema = z.object({
  groupId: z.string().min(1),
  /** 要广播的原始输入（含控制字符，如 \r） */
  data: z.string().max(64 * 1024),
})

export const broadcastHandlers: Record<string, IpcHandler> = {
  create: (payload, ctx) => {
    activeCtx = ctx
    const { sessionIds, name, mode } = parseInput(createSchema, payload)

    // 去重：多选时可能重复传入同一会话
    const unique = [...new Set(sessionIds)]
    const known = new Set(listWritables().map((w) => w.sessionId))
    const unknown = unique.filter((id) => !known.has(id))
    if (unknown.length === unique.length) {
      throw AppError.notFound('这些会话当前都不可写入（可能已断开）')
    }

    const group: BroadcastGroup = {
      groupId: randomUUID(),
      name: name ?? `${unique.length} 台会话`,
      mode: mode ?? 'independent',
      sessionIds: unique,
      createdAt: Date.now(),
    }
    groups.set(group.groupId, group)
    broadcast()

    // 有成员不在可写列表时如实告知，而不是假装全都在
    return { group: toView(group), skipped: unknown }
  },

  dissolve: (payload, ctx) => {
    activeCtx = ctx
    const { groupId } = parseInput(groupIdSchema, payload)
    const group = requireGroup(groupId)
    groups.delete(groupId)
    broadcast()
    return { dissolved: true, groupId, name: group.name }
  },

  add: (payload, ctx) => {
    activeCtx = ctx
    const { groupId, sessionIds } = parseInput(modifySchema, payload)
    const group = requireGroup(groupId)
    for (const id of sessionIds) {
      if (!group.sessionIds.includes(id)) group.sessionIds.push(id)
    }
    broadcast()
    return { group: toView(group) }
  },

  remove: (payload, ctx) => {
    activeCtx = ctx
    const { groupId, sessionIds } = parseInput(modifySchema, payload)
    const group = requireGroup(groupId)
    group.sessionIds = group.sessionIds.filter((id) => !sessionIds.includes(id))
    if (group.sessionIds.length === 0) {
      groups.delete(groupId)
    }
    broadcast()
    return { group: group.sessionIds.length > 0 ? toView(group) : null }
  },

  setMode: (payload, ctx) => {
    activeCtx = ctx
    const { groupId, mode } = parseInput(setModeSchema, payload)
    const group = requireGroup(groupId)
    group.mode = mode
    broadcast()
    log.info(`广播组 ${group.name} 切换到${mode === 'broadcast' ? '广播' : '独立'}模式`)
    return { group: toView(group) }
  },

  /**
   * 广播一段输入。
   *
   * 独立模式下**直接拒绝**而不是静默什么都不做 ——
   * 否则 UI 出错时会表现为"输入丢了"，难以定位。
   */
  send: (payload, ctx) => {
    activeCtx = ctx
    const { groupId, data } = parseInput(sendSchema, payload)
    const group = requireGroup(groupId)

    if (group.mode !== 'broadcast') {
      throw AppError.badRequest('当前为独立模式，未开启广播')
    }

    const delivered: string[] = []
    const skipped: Array<{ sessionId: string; title: string; message: string }> = []

    for (const sessionId of group.sessionIds) {
      const target = getWritable(sessionId)
      if (!target) {
        skipped.push({ sessionId, title: sessionId, message: '会话不存在或已断开' })
        continue
      }
      if (!target.canWrite()) {
        skipped.push({ sessionId, title: target.title, message: '当前不可写入' })
        continue
      }
      try {
        target.write(data)
        delivered.push(sessionId)
      } catch (err) {
        skipped.push({
          sessionId,
          title: target.title,
          message: err instanceof Error ? err.message : '写入失败',
        })
      }
    }

    // 逐条上报跳过/失败：广播最容易出的问题就是"以为发出去了其实没有"
    for (const s of skipped) {
      ctx.emit(Events.BROADCAST_ERROR, {
        groupId,
        sessionId: s.sessionId,
        title: s.title,
        message: s.message,
      })
    }

    return { delivered: delivered.length, skipped: skipped.length, details: skipped }
  },

  list: () => listViews(),

  status: (payload) => {
    const { groupId } = parseInput(groupIdSchema, payload)
    return toView(requireGroup(groupId))
  },
}
