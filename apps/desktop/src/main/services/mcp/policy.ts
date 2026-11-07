// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * MCP 访问范围与执行策略。
 *
 * 安全默认（**最保守**，未配置时就是最严）：
 * - 只听 127.0.0.1；
 * - 不暴露任何 SSH 服务器（allowedServerIds = []）；
 * - 不暴露任何本地目录（allowedLocalDirs = []）；
 * - 普通命令「每次确认」、sudo「禁用」、工作区「每次确认」；
 * - 没有任何令牌时，所有请求都被拒。
 *
 * 路径校验用 **realpath**（不是字符串前缀匹配）：先解析符号链接再判边界，
 * 因此 `..` 穿越和"白名单目录里的软链指向外部"都会被拒。
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import type {
  ExecutionPolicy,
  McpPolicy,
  McpToolDef,
  PublicMcpClient,
  SudoPolicy,
  ToolGroup,
  WorkspacePolicy,
} from '@t1000/shared'
import { AppError } from '../../errors'

// ---------------------------------------------------------------------------
// 策略
// ---------------------------------------------------------------------------

// 策略与工具形状的**唯一定义处**已上移到 `@t1000/shared`（渲染层同样从那里取），
// 这里再导出一次保持既有 `./policy` import 路径可用。
export type { ExecutionPolicy, McpPolicy, McpToolDef, PublicMcpClient, SudoPolicy, ToolGroup, WorkspacePolicy }

export const DEFAULT_MCP_POLICY: McpPolicy = {
  listenHost: '127.0.0.1',
  port: 12335,
  executionPolicy: 'confirm',
  sudoPolicy: 'deny',
  workspacePolicy: 'confirm',
  allowedServerIds: [],
  allowedLocalDirs: [],
  defaultTimeoutMs: 60_000,
  maxTimeoutMs: 600_000,
  enabledTools: [], // 空 = 全部工具（由 enabledToolDefs 解释）
}

const MIN_PORT = 1024
const MAX_PORT = 65535

/** 合并用户 patch（缺字段取保守默认；且**不允许**把安全默认"悄悄放松"成非法值） */
export function normalizePolicy(patch: Partial<McpPolicy> | undefined): McpPolicy {
  const merged: McpPolicy = { ...DEFAULT_MCP_POLICY, ...(patch ?? {}) }

  const port = Number(merged.port)
  if (!Number.isInteger(port) || port < MIN_PORT || port > MAX_PORT) {
    throw AppError.badRequest(`MCP 端口必须是 ${MIN_PORT}-${MAX_PORT} 的整数（收到 ${String(merged.port)}）`)
  }
  const host = String(merged.listenHost).trim()
  if (host === '') throw AppError.badRequest('MCP 监听地址不能为空')

  // 先夹 max，再让 default 落在 [1s, max] —— 否则 max<min 时 default 会被压到 max 之下
  const rawMax = Number(merged.maxTimeoutMs)
  const maxTimeoutMs = Number.isFinite(rawMax)
    ? Math.min(Math.max(Math.floor(rawMax), 1_000), 600_000)
    : 600_000
  const rawDefault = Number(merged.defaultTimeoutMs)
  const defaultTimeoutMs = Number.isFinite(rawDefault)
    ? Math.min(Math.max(Math.floor(rawDefault), 1_000), maxTimeoutMs)
    : Math.min(60_000, maxTimeoutMs)

  const allowedServerIds =
    merged.allowedServerIds === 'all'
      ? 'all'
      : [...new Set((merged.allowedServerIds ?? []).map((s) => String(s)).filter((s) => s !== ''))]

  const allowedLocalDirs = [...new Set((merged.allowedLocalDirs ?? []).map((d) => String(d)).filter((d) => d !== ''))]

  const enabledTools = [...new Set((merged.enabledTools ?? []).map((t) => String(t)).filter((t) => t !== ''))]

  return {
    ...merged,
    listenHost: host,
    port,
    allowedServerIds,
    allowedLocalDirs,
    enabledTools,
    defaultTimeoutMs,
    maxTimeoutMs,
  }
}

function clampNumber(value: unknown, min: number, max: number): number {
  const n = Number(value)
  if (!Number.isFinite(n)) return min
  return Math.min(Math.max(Math.floor(n), min), max)
}

/** 是否为回环地址（默认只允许回环；对外暴露必须显式改 listenHost） */
export function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]'
}

/** 服务器是否在允许范围（'all' 或白名单命中） */
export function isServerAllowed(serverId: string, policy: McpPolicy): boolean {
  if (policy.allowedServerIds === 'all') return true
  return policy.allowedServerIds.includes(serverId)
}

export function assertServerAllowed(serverId: string, policy: McpPolicy): void {
  if (!isServerAllowed(serverId, policy)) {
    throw new AppError('FORBIDDEN', `该 SSH 服务器未被授权访问: ${serverId}`)
  }
}

// ---------------------------------------------------------------------------
// 路径校验（realpath，防 .. 与符号链接绕过）
// ---------------------------------------------------------------------------

export class PathAccessError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PathAccessError'
  }
}

/**
 * 校验本地路径是否落在白名单目录内。
 *
 * - `mustExist`：目标必须已存在（读/下载），直接 realpath 解析；
 * - 否则（上传/写入目标）：解析**父目录**的 realpath，再拼 basename ——
 *   这样"父目录是软链指向外部"同样会被拦。
 *
 * @returns 解析后的真实绝对路径
 */
export async function assertLocalPathAllowed(
  candidate: string,
  policy: McpPolicy,
  options: { mustExist?: boolean } = {},
): Promise<string> {
  if (typeof candidate !== 'string' || candidate.trim() === '') {
    throw new PathAccessError('路径不能为空')
  }
  if (candidate.includes('\0')) throw new PathAccessError('路径包含非法字符 NUL')
  if (policy.allowedLocalDirs.length === 0) {
    throw new PathAccessError('未配置允许访问的本地目录')
  }

  const roots: string[] = []
  for (const dir of policy.allowedLocalDirs) {
    try {
      roots.push(await realpath(dir))
    } catch {
      // 白名单目录不存在就忽略（不因为它不可用而放行别的路径）
    }
  }
  if (roots.length === 0) throw new PathAccessError('允许访问的目录均不可用')

  const absolute = resolve(candidate)
  let real: string
  if (options.mustExist) {
    try {
      real = await realpath(absolute)
    } catch {
      throw new PathAccessError(`路径不存在或不可访问: ${candidate}`)
    }
  } else {
    const base = absolute.slice(absolute.lastIndexOf(sep) + 1)
    if (base === '' || base === '.' || base === '..') {
      throw new PathAccessError(`目标文件名不合法: ${candidate}`)
    }
    try {
      const parent = await realpath(dirname(absolute))
      real = join(parent, base)
    } catch {
      throw new PathAccessError(`父目录不存在或不可访问: ${candidate}`)
    }
  }

  const inside = roots.some((root) => real === root || real.startsWith(root.endsWith(sep) ? root : root + sep))
  if (!inside) throw new PathAccessError(`路径越出允许范围: ${candidate}`)
  return real
}

/** 纯字符串层面的快速预检（供 UI 即时反馈用；真正判定仍以 realpath 为准） */
export function looksLikeTraversal(candidate: string): boolean {
  const segments = candidate.split(/[/\\]/)
  return segments.includes('..')
}

// ---------------------------------------------------------------------------
// 令牌
// ---------------------------------------------------------------------------

export interface McpClient {
  id: string
  name: string
  /** 只存摘要，永不存明文 */
  tokenDigest: string
  /** 该令牌是否允许 sudo（还要全局 sudoPolicy 允许） */
  allowSudo: boolean
  /** 该令牌是否允许工作区管理 */
  allowWorkspace: boolean
  createdAt: string
  revoked: boolean
}

// PublicMcpClient 见 shared（= 去掉 tokenDigest 摘要的公开视图）

export function digestToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

/** 从 Authorization 头取 Bearer 令牌 */
export function extractBearer(header: string | undefined): string | undefined {
  if (typeof header !== 'string') return undefined
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  return match?.[1]?.trim() || undefined
}

function safeEqualDigest(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8')
  const bufB = Buffer.from(b, 'utf8')
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}

/**
 * 客户端令牌注册表。
 * 明文令牌只在 `createClient` 的返回值里出现一次，之后只保留摘要。
 */
export class TokenRegistry {
  private readonly clients = new Map<string, McpClient>()

  /** 创建令牌：返回值中的 token 只应展示一次 */
  createClient(
    name: string,
    options: { allowSudo?: boolean; allowWorkspace?: boolean; now?: () => number } = {},
  ): { client: PublicMcpClient; token: string } {
    const token = randomBytes(32).toString('base64url')
    const client: McpClient = {
      id: `mcp-${randomBytes(6).toString('hex')}`,
      name: name.trim() === '' ? '未命名客户端' : name.trim(),
      tokenDigest: digestToken(token),
      allowSudo: options.allowSudo ?? false,
      allowWorkspace: options.allowWorkspace ?? false,
      createdAt: new Date(options.now?.() ?? Date.now()).toISOString(),
      revoked: false,
    }
    this.clients.set(client.id, client)
    return { client: stripDigest(client), token }
  }

  /** 校验 Bearer 令牌；未命中或已撤销返回 undefined */
  verify(token: string | undefined): McpClient | undefined {
    if (typeof token !== 'string' || token === '') return undefined
    const digest = digestToken(token)
    for (const client of this.clients.values()) {
      if (client.revoked) continue
      if (safeEqualDigest(client.tokenDigest, digest)) return client
    }
    return undefined
  }

  revoke(clientId: string): boolean {
    const client = this.clients.get(clientId)
    if (!client || client.revoked) return false
    client.revoked = true
    return true
  }

  list(): PublicMcpClient[] {
    return [...this.clients.values()].map(stripDigest)
  }

  get size(): number {
    return this.clients.size
  }

  clear(): void {
    this.clients.clear()
  }
}

function stripDigest(client: McpClient): PublicMcpClient {
  const { tokenDigest: _tokenDigest, ...rest } = client
  return rest
}

// ---------------------------------------------------------------------------
// 工具注册表
// ---------------------------------------------------------------------------

// McpToolDef 见 shared（工具注册表条目）

const obj = (
  properties: Record<string, unknown>,
  required: string[] = [],
): Record<string, unknown> => ({ type: 'object', properties, required, additionalProperties: false })

/** 暴露给 MCP 客户端的工具（`t1000_` 前缀，四组） */
export const MCP_TOOLS: readonly McpToolDef[] = [
  // ── 工作区 ───────────────────────────────────────────
  {
    name: 't1000_workspace_list',
    group: 'workspace',
    description: '浏览工作区已有的连接、分组、快速命令与笔记',
    parameters: obj({ kind: { type: 'string', enum: ['connections', 'groups', 'notes', 'snippets'] } }, ['kind']),
    requiresWorkspace: true,
  },
  {
    name: 't1000_workspace_save',
    group: 'workspace',
    description: '创建或更新工作区数据（更新需提供已有 id；不会返回已保存的密码/私钥）',
    parameters: obj({
      kind: { type: 'string', enum: ['connection', 'note', 'snippet', 'group'] },
      id: { type: 'string', description: '更新时提供；创建时省略' },
      data: { type: 'object' },
    }, ['kind', 'data']),
    requiresWorkspace: true,
  },
  // ── SSH ─────────────────────────────────────────────
  {
    name: 't1000_ssh_list_servers',
    group: 'ssh',
    description: '列出被授权访问的 SSH 服务器（拿 serverId 供其它工具使用）',
    parameters: obj({}),
  },
  {
    name: 't1000_ssh_exec',
    group: 'ssh',
    description: '在指定服务器上非交互执行一条命令，返回退出码与输出（默认超时 60s，上限 600s）',
    parameters: obj({
      serverId: { type: 'string' },
      command: { type: 'string' },
      timeoutSec: { type: 'number' },
      cwd: { type: 'string' },
    }, ['serverId', 'command']),
  },
  {
    name: 't1000_ssh_sudo_exec',
    group: 'ssh',
    description: '以 sudo 执行命令（命令中不要写 sudo，也不要传密码）。需全局 sudo 策略与令牌权限同时允许',
    parameters: obj({
      serverId: { type: 'string' },
      command: { type: 'string' },
      timeoutSec: { type: 'number' },
    }, ['serverId', 'command']),
    requiresSudo: true,
  },
  // ── 远程文件 ─────────────────────────────────────────
  {
    name: 't1000_sftp_list',
    group: 'files',
    description: '列出远端目录内容',
    parameters: obj({ serverId: { type: 'string' }, path: { type: 'string' } }, ['serverId', 'path']),
  },
  {
    name: 't1000_sftp_stat',
    group: 'files',
    description: '查看远端路径的元数据',
    parameters: obj({ serverId: { type: 'string' }, path: { type: 'string' } }, ['serverId', 'path']),
  },
  {
    name: 't1000_sftp_read_text',
    group: 'files',
    description: '读取远端文本文件（有大小上限）',
    parameters: obj({ serverId: { type: 'string' }, path: { type: 'string' } }, ['serverId', 'path']),
  },
  {
    name: 't1000_sftp_write_text',
    group: 'files',
    description: '写入远端文本文件',
    parameters: obj({ serverId: { type: 'string' }, path: { type: 'string' }, content: { type: 'string' } }, ['serverId', 'path', 'content']),
  },
  // ── 文件传输 ─────────────────────────────────────────
  {
    name: 't1000_transfer_upload',
    group: 'transfer',
    description: '上传本地文件到远端（本地源路径受目录白名单限制）',
    parameters: obj({
      serverId: { type: 'string' },
      localPath: { type: 'string' },
      remotePath: { type: 'string' },
      recursive: { type: 'boolean' },
    }, ['serverId', 'localPath', 'remotePath']),
    needsLocalDirs: true,
  },
  {
    name: 't1000_transfer_download',
    group: 'transfer',
    description: '下载远端文件到本地（本地目标路径受目录白名单限制）',
    parameters: obj({
      serverId: { type: 'string' },
      remotePath: { type: 'string' },
      localPath: { type: 'string' },
      recursive: { type: 'boolean' },
    }, ['serverId', 'remotePath', 'localPath']),
    needsLocalDirs: true,
  },
  {
    name: 't1000_transfer_list',
    group: 'transfer',
    description: '查看传输任务状态',
    parameters: obj({ serverId: { type: 'string' } }),
  },
  {
    name: 't1000_transfer_cancel',
    group: 'transfer',
    description: '取消一个传输任务',
    parameters: obj({ transferId: { type: 'string' } }, ['transferId']),
  },
]

/** 按策略过滤出可用工具；enabledTools 为空表示全部 */
export function enabledToolDefs(policy: McpPolicy): McpToolDef[] {
  const all = [...MCP_TOOLS]
  if (policy.enabledTools.length === 0) return all
  const wanted = new Set(policy.enabledTools)
  const filtered = all.filter((t) => wanted.has(t.name))
  // 至少保留一个工具（否则客户端会加载到空工具表）
  return filtered.length > 0 ? filtered : all.slice(0, 1)
}

/**
 * 设置启用工具。空数组 = 全部；给名字时必须都是已知工具。
 */
export function withEnabledTools(policy: McpPolicy, names: string[]): McpPolicy {
  const unique = [...new Set(names.map((n) => String(n).trim()).filter((n) => n !== ''))]
  for (const name of unique) {
    if (!MCP_TOOLS.some((t) => t.name === name)) {
      throw AppError.badRequest(`未知的 MCP 工具: ${name}`)
    }
  }
  return normalizePolicy({ ...policy, enabledTools: unique })
}

/** 服务器白名单设置 */
export function withAllowedServers(policy: McpPolicy, value: string[] | 'all'): McpPolicy {
  return normalizePolicy({ ...policy, allowedServerIds: value })
}

/** 本地目录白名单设置（去重 + 规范化为绝对路径） */
export function withAllowedDirs(policy: McpPolicy, dirs: string[]): McpPolicy {
  return normalizePolicy({ ...policy, allowedLocalDirs: dirs.map((d) => resolve(String(d))) })
}
