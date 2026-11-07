// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * mcp 域 IPC 入口：Actions.mcp 的 5 个动作（status / start / stop / listTools / setPolicy）。
 *
 * 安全姿态：
 * - 初始策略就是 `DEFAULT_MCP_POLICY`（只听回环、无服务器、无目录、每次确认、sudo 禁用）；
 * - 没有任何客户端令牌时，即使服务在跑，所有请求也会 401；
 * - start 不会自动换端口（占用即失败），避免用户按旧地址连不上。
 *
 * 令牌管理：`Actions.mcp` 里没有对应的动作用来增删客户端令牌，所以令牌生命周期
 * 以**导出函数**的形式提供（createMcpClient / revokeMcpClient / listMcpClients），
 * 由设置域或应用启动代码调用 —— 不自行发明 IPC 动作（需要新动作要先确认）。
 */

import { z } from 'zod'
import type { SFTPWrapper } from 'ssh2'
import type { McpStatus, McpToolsResult } from '@t1000/shared'
import { AppError, parseInput } from '../../errors'
import type { IpcContext, IpcHandler } from '../../ipc/router'
import { listSessions as listLiveSessions, requireSession } from '../session-registry'
import {
  DEFAULT_MCP_POLICY,
  MCP_TOOLS,
  TokenRegistry,
  enabledToolDefs,
  normalizePolicy,
  withEnabledTools,
  type McpPolicy,
  type PublicMcpClient,
} from './policy'
import { McpServer, type ConfirmationRequest, type McpToolRuntime } from './server'

/** 远程文本读取上限（MCP 读文件不能把主进程内存打爆） */
const MAX_READ_BYTES = 2 * 1024 * 1024

// ---------------------------------------------------------------------------
// 单例
// ---------------------------------------------------------------------------

const tokens = new TokenRegistry()
let policy: McpPolicy = normalizePolicy(undefined)
let runtime: McpToolRuntime = {}
let onConfirm: ((req: Parameters<NonNullable<Parameters<typeof McpServer.prototype.setConfirmationHandler>[0]>>[0]) => Promise<boolean>) | undefined

let server: McpServer | null = null

function requireServer(): McpServer {
  if (!server) {
    server = new McpServer({
      policy,
      tokens,
      runtime,
      log: (message) => logger?.(message),
    })
    if (onConfirm) server.setConfirmationHandler(onConfirm)
  }
  return server
}

let logger: ((message: string) => void) | undefined

/**
 * 应用启动时注入真实依赖。
 * `onConfirm` 不注入时，confirm 策略一律拒绝（fail-closed），不会静默放行。
 */
export function configureMcp(options: {
  runtime?: McpToolRuntime
  onConfirm?: (req: unknown) => Promise<boolean>
  policy?: Partial<McpPolicy>
  log?: (message: string) => void
}): void {
  if (options.runtime) runtime = { ...runtime, ...options.runtime }
  if (options.onConfirm) {
    onConfirm = options.onConfirm as typeof onConfirm
    server?.setConfirmationHandler(onConfirm)
  }
  if (options.policy) {
    policy = applyPolicyPatch(options.policy)
    server?.setPolicy(policy)
  }
  if (options.log) logger = options.log
  // 已创建的 server 要拿到最新 runtime
  server?.setRuntime(runtime)
}

/** 测试自检 / 应用重置 */
export function resetMcp(): void {
  void server?.stop()
  server = null
  tokens.clear()
  runtime = {}
  onConfirm = undefined
  logger = undefined
  policy = normalizePolicy(undefined)
}

export function getMcpServer(): McpServer {
  return requireServer()
}

export function getMcpTokens(): TokenRegistry {
  return tokens
}

// —— 令牌 API（供设置域调用；明文只在创建时返回一次）——

export function createMcpClient(
  name: string,
  options: { allowSudo?: boolean; allowWorkspace?: boolean } = {},
): { client: PublicMcpClient; token: string } {
  return tokens.createClient(name, options)
}

export function revokeMcpClient(clientId: string): boolean {
  // 撤销令牌要立即终止该客户端后续请求：注册表置 revoked 后 verify 立即失败
  return tokens.revoke(clientId)
}

export function listMcpClients(): PublicMcpClient[] {
  return tokens.list()
}

export function getMcpPolicy(): McpPolicy {
  return policy
}

// ---------------------------------------------------------------------------
// 默认工具运行时（走中立契约 session-registry，不自建连接）
// ---------------------------------------------------------------------------

function sessionOrThrow(serverId: string) {
  try {
    return requireSession(serverId)
  } catch (err) {
    throw AppError.notConnected(err instanceof Error ? err.message : '会话不存在或已断开')
  }
}

function withSftp<T>(serverId: string, fn: (sftp: SFTPWrapper) => Promise<T>): Promise<T> {
  const session = sessionOrThrow(serverId)
  return new Promise<SFTPWrapper>((resolve, reject) => {
    session.client.sftp((err, wrapper) => {
      if (err) reject(AppError.notConnected(`打开 SFTP 通道失败: ${err.message}`))
      else resolve(wrapper)
    })
  }).then(fn)
}

/** 默认运行时：SSH 执行 / 会话列举 / 远程文件只读。写与传输能力需上层注入。 */
export const defaultMcpRuntime: McpToolRuntime = {
  listServers: () =>
    listLiveSessions().map((s) => ({
      serverId: s.sessionId,
      host: s.host,
      username: s.username,
      connectionId: s.connectionId,
    })),

  exec: async (serverId, command, options) => {
    const session = sessionOrThrow(serverId)
    const started = Date.now()
    const result = await session.exec(command, { timeoutMs: options.timeoutMs })
    return { ...result, durationMs: Date.now() - started }
  },

  sftpList: (serverId, path) =>
    withSftp(serverId, (sftp) =>
      new Promise((resolve, reject) => {
        sftp.readdir(path, (err, list) => {
          if (err) return reject(AppError.internal(`列目录失败: ${err.message}`))
          resolve(
            list.map((item) => ({
              name: item.filename,
              size: item.attrs.size,
              mode: item.attrs.mode,
              mtime: item.attrs.mtime,
              type: item.attrs.isDirectory() ? 'directory' : item.attrs.isSymbolicLink() ? 'symlink' : 'file',
            })),
          )
        })
      }),
    ),

  sftpStat: (serverId, path) =>
    withSftp(serverId, (sftp) =>
      new Promise((resolve, reject) => {
        sftp.stat(path, (err, stats) => {
          if (err) return reject(AppError.notFound(`路径不可访问: ${path}`))
          resolve({
            path,
            size: stats.size,
            mode: stats.mode,
            uid: stats.uid,
            gid: stats.gid,
            mtime: stats.mtime,
            type: stats.isDirectory() ? 'directory' : stats.isSymbolicLink() ? 'symlink' : 'file',
          })
        })
      }),
    ),

  sftpReadText: (serverId, path) =>
    withSftp(serverId, (sftp) =>
      new Promise<string>((resolve, reject) => {
        sftp.stat(path, (statErr, stats) => {
          if (statErr) return reject(AppError.notFound(`远端文件不可读: ${path}`))
          if (stats.size > MAX_READ_BYTES) {
            return reject(AppError.badRequest(`文件过大（${stats.size} > ${MAX_READ_BYTES} 字节）`))
          }
          sftp.readFile(path, (readErr, data) => {
            if (readErr) return reject(AppError.internal(`读取失败: ${readErr.message}`))
            resolve(data.toString('utf8'))
          })
        })
      }),
    ),
}

// ---------------------------------------------------------------------------
// 策略 patch
// ---------------------------------------------------------------------------

const policyPatchSchema = z.object({
  listenHost: z.string().min(1).optional(),
  port: z.number().int().optional(),
  executionPolicy: z.enum(['confirm', 'direct']).optional(),
  sudoPolicy: z.enum(['deny', 'confirm', 'direct']).optional(),
  workspacePolicy: z.enum(['deny', 'confirm', 'direct']).optional(),
  allowedServerIds: z.union([z.array(z.string()), z.literal('all')]).optional(),
  allowedLocalDirs: z.array(z.string()).optional(),
  enabledTools: z.array(z.string()).optional(),
  defaultTimeoutMs: z.number().int().optional(),
  maxTimeoutMs: z.number().int().optional(),
})

const createClientSchema = z.object({
  name: z.string().min(1).max(100),
  /** 是否允许该客户端执行 sudo 命令（默认否 —— 安全默认） */
  allowSudo: z.boolean().optional(),
  /** 是否允许该客户端操作工作区（默认否） */
  allowWorkspace: z.boolean().optional(),
})

const revokeClientSchema = z.object({
  clientId: z.string().min(1),
})

export type McpPolicyPatch = z.infer<typeof policyPatchSchema>

/** 合并策略 patch（enabledTools 会校验工具名；端口/超时由 normalizePolicy 校验） */
function applyPolicyPatch(patch: McpPolicyPatch): McpPolicy {
  const next = normalizePolicy({ ...policy, ...patch })
  return patch.enabledTools === undefined ? next : withEnabledTools(next, patch.enabledTools)
}

// ---------------------------------------------------------------------------
// Handler 表
// ---------------------------------------------------------------------------

export const mcpHandlers: Record<string, IpcHandler> = {
  status: () => {
    const s = requireServer()
    // 显式标注 shared 契约：UI 视图里 clients 是列表，而内部状态里是数量
    const view: McpStatus = { ...s.status(), clients: tokens.list() }
    return view
  },

  start: async (payload) => {
    const patch = payload === undefined || payload === null ? {} : parseInput(policyPatchSchema, payload)
    if (Object.keys(patch).length > 0) {
      policy = applyPolicyPatch(patch)
      requireServer().setPolicy(policy)
    }
    await requireServer().setRuntime(runtime)
    const status = await requireServer().start()
    const view: McpStatus = { ...status, clients: tokens.list() }
    return view
  },

  stop: async () => {
    await requireServer().stop()
    return { running: false }
  },

  listTools: () => {
    const enabled = new Set(enabledToolDefs(policy).map((t) => t.name))
    const view: McpToolsResult = {
      tools: MCP_TOOLS.map((t) => ({
        name: t.name,
        group: t.group,
        description: t.description,
        inputSchema: t.parameters,
        enabled: enabled.has(t.name),
        requiresSudo: t.requiresSudo === true,
        requiresWorkspace: t.requiresWorkspace === true,
      })),
      // 至少要保留一个工具：这里告诉 UI 当前生效的那一个
      effective: [...enabled],
    }
    return view
  },

  setPolicy: (payload) => {
    const patch = parseInput(policyPatchSchema, payload)
    const before = policy
    policy = applyPolicyPatch(patch)
    const s = requireServer()
    s.setPolicy(policy)
    const hostOrPortChanged =
      before.listenHost !== policy.listenHost || before.port !== policy.port
    return {
      policy,
      // 运行中改地址/端口必须重启才生效（不自动重启，避免悄悄中断客户端）
      restartRequired: hostOrPortChanged && s.status().running,
      running: s.status().running,
    }
  },

  /** 列出已授权的 MCP 客户端（只回摘要，不回令牌明文） */
  listClients: () => tokens.list(),

  /**
   * 新建 MCP 客户端并返回**一次性的令牌明文**。
   * 之后服务端只保留其 sha256 摘要，无法再次取回 —— 这与访问令牌的最佳实践一致。
   */
  createClient: (payload) => {
    const { name, allowSudo, allowWorkspace } = parseInput(createClientSchema, payload)
    const created = createMcpClient(name, {
      ...(allowSudo !== undefined ? { allowSudo } : {}),
      ...(allowWorkspace !== undefined ? { allowWorkspace } : {}),
    })
    return {
      client: created,
      // 明确提示：这是唯一一次能看到明文令牌
      notice: '请立即保存该令牌，服务端只保存摘要，之后无法再次查看。',
    }
  },

  revokeClient: (payload) => {
    const { clientId } = parseInput(revokeClientSchema, payload)
    const revoked = revokeMcpClient(clientId)
    if (!revoked) throw AppError.notFound(`MCP 客户端不存在: ${clientId}`)
    return { revoked: true, clientId }
  },
}

export type { McpPolicy, PublicMcpClient }
export { DEFAULT_MCP_POLICY }

/** 供测试自检：当前生效策略与运行时是否已注入 */
export function mcpSelfCheck(): { policy: McpPolicy; hasRuntime: boolean; clients: number; running: boolean } {
  return {
    policy,
    hasRuntime: Object.keys(runtime).length > 0,
    clients: tokens.size,
    running: requireServer().status().running,
  }
}
