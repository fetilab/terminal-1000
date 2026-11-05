// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * forward 域 IPC 接入：隧道生命周期与状态广播。
 */

import { z } from 'zod'
import { Events, type ConnectionState, type TunnelConnection } from '@t1000/shared'
import type { IpcContext, IpcHandler } from '../../ipc/router'
import { createLogger } from '../../logger'
import { Tunnel, quickFillTemplates, type TunnelState } from './tunnel'

const log = createLogger('forward-ipc')

/** 活跃隧道：tunnelId → 实例 */
const tunnels = new Map<string, Tunnel>()
/** 配置快照，供 list 返回 */
const configs = new Map<string, TunnelConnection>()

/** 把隧道内部状态映射为共享契约里的连接状态 */
function toConnectionState(state: TunnelState): ConnectionState {
  switch (state) {
    case 'ready':
      return 'ready'
    case 'connecting':
      return 'connecting'
    case 'reconnecting':
      return 'connecting'
    case 'failed':
      return 'failed'
    case 'closed':
    case 'idle':
    default:
      return 'disconnected'
  }
}

function makeTunnel(config: TunnelConnection, ctx: IpcContext): Tunnel {
  return new Tunnel(config, {
    onState: (id, state, message) => {
      ctx.emit(Events.FORWARD_STATE, {
        forwardId: id,
        state: toConnectionState(state),
        ...(message ? { message } : {}),
      })
    },
    onInfo: (id, message) => ctx.emit(Events.FORWARD_INFO, { forwardId: id, message }),
    onWarn: (id, message) => ctx.emit(Events.FORWARD_WARN, { forwardId: id, message }),
    onError: (id, message) => ctx.emit(Events.FORWARD_ERROR, { forwardId: id, message }),
  })
}

/** 应用退出时清理全部隧道（释放监听端口，避免下次启动 EADDRINUSE） */
export function shutdownForwards(): void {
  for (const t of tunnels.values()) t.close()
  tunnels.clear()
  configs.clear()
}

// ── 入参 schema ──────────────────────────────────────

const tunnelSchema = z.object({
  kind: z.literal('tunnel'),
  id: z.string().min(1),
  name: z.string(),
  serverId: z.string().min(1),
  type: z.enum(['local', 'remote', 'dynamic']),
  localHost: z.string(),
  localPort: z.number().int().min(0).max(65535),
  remoteHost: z.string(),
  remotePort: z.number().int().min(0).max(65535),
  autoReconnect: z.boolean(),
  note: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

const openSchema = z.object({ tunnel: tunnelSchema })
const tunnelIdSchema = z.object({ tunnelId: z.string().min(1) })

export const forwardHandlers: Record<string, IpcHandler> = {
  /** 打开隧道：返回运行时 tunnelId 与实际监听端口 */
  open: async (payload, ctx) => {
    const { tunnel: config } = openSchema.parse(payload)
    const tunnel = makeTunnel(config as unknown as TunnelConnection, ctx)
    tunnels.set(tunnel.tunnelId, tunnel)
    configs.set(tunnel.tunnelId, config as unknown as TunnelConnection)

    try {
      await tunnel.open()
    } catch (err) {
      tunnels.delete(tunnel.tunnelId)
      configs.delete(tunnel.tunnelId)
      throw err
    }

    log.info(`隧道已打开 ${tunnel.tunnelId} type=${config.type}`)
    return { tunnelId: tunnel.tunnelId, boundPort: tunnel.getBoundPort() }
  },

  close: (payload, ctx) => {
    const { tunnelId } = tunnelIdSchema.parse(payload)
    const tunnel = tunnels.get(tunnelId)
    if (tunnel) {
      tunnel.close()
      tunnels.delete(tunnelId)
      configs.delete(tunnelId)
      ctx.emit(Events.FORWARD_STATE, { forwardId: tunnelId, state: 'disconnected' })
    }
    return { closed: true }
  },

  /** 列出活跃隧道的运行时状态 */
  list: () =>
    [...tunnels.entries()].map(([tunnelId, tunnel]) => {
      const config = configs.get(tunnelId)
      return {
        tunnelId,
        configId: config?.id ?? '',
        name: config?.name ?? '',
        type: config?.type ?? 'local',
        state: tunnel.getState(),
        boundPort: tunnel.getBoundPort(),
        localHost: config?.localHost ?? '',
        localPort: config?.localPort ?? 0,
        remoteHost: config?.remoteHost ?? '',
        remotePort: config?.remotePort ?? 0,
      }
    }),

  /** 快速填充模板（UI 用） */
  templates: () => quickFillTemplates(),
}
