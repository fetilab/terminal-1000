// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * MCP 服务端面向 UI 的数据形状。
 *
 * 为什么在这里：策略类型与工具定义原先在 `services/mcp/policy.ts`，
 * 状态视图在 `services/mcp/server.ts` 与 `services/mcp/index.ts` 之间来回拼，
 * 渲染层只能各自镜像。上移后成为唯一契约。
 *
 * 边界（刻意不在这里的东西）：
 * - `McpToolRuntime`：含 SFTP 包装器的执行能力接口（`sftpList` / `sftpReadText`…），
 *   属于主进程实现细节，拖进 shared 会让渲染层间接依赖传输层类型。
 * - `McpClient`（含 `tokenDigest` 摘要）、`tokenDigest`/`digestToken` 等令牌内部结构。
 * - RPC 协议内部类型（`RpcRequest`/`RpcResponse`/`ToolCallResult`）。
 * - 本文件**零 import**、零运行时代码（`DEFAULT_MCP_POLICY` 留在主进程）。
 */

/** 普通 SSH 命令 / 远程文件操作的执行策略 */
export type ExecutionPolicy = 'confirm' | 'direct'
/** sudo 独立策略 */
export type SudoPolicy = 'deny' | 'confirm' | 'direct'
/** 工作区（连接/笔记等）管理策略 */
export type WorkspacePolicy = 'deny' | 'confirm' | 'direct'

/** 工具分组（用于 UI 分类与策略裁剪） */
export type ToolGroup = 'workspace' | 'ssh' | 'files' | 'transfer'

/** MCP 服务端策略 */
export interface McpPolicy {
  /** 监听地址；默认回环 */
  listenHost: string
  port: number
  executionPolicy: ExecutionPolicy
  sudoPolicy: SudoPolicy
  workspacePolicy: WorkspacePolicy
  /** 允许访问的 SSH 服务器 id；'all' 表示全部（不推荐） */
  allowedServerIds: string[] | 'all'
  /** 允许访问的本地目录白名单（绝对路径） */
  allowedLocalDirs: string[]
  /** 命令默认超时 */
  defaultTimeoutMs: number
  /** 命令超时上限 */
  maxTimeoutMs: number
  /** 启用的工具名；空数组 = 全部工具（语义由主进程解释） */
  enabledTools: string[]
}

/**
 * 客户端公开视图（**不含 `tokenDigest`**）。
 *
 * 令牌摘要属于凭证类内部数据，只在主进程保存与校验；UI 只需要知道
 * "哪个客户端、有什么权限、是否已撤销"。
 */
export interface PublicMcpClient {
  id: string
  name: string
  /** 该令牌是否允许 sudo（还要全局 sudoPolicy 允许） */
  allowSudo: boolean
  /** 该令牌是否允许工作区管理 */
  allowWorkspace: boolean
  createdAt: string
  revoked: boolean
}

/** 工具注册表条目（策略层用它判断启用/权限要求） */
export interface McpToolDef {
  name: string
  group: ToolGroup
  description: string
  /** JSON Schema 形状的入参定义 */
  parameters: Record<string, unknown>
  /** 需要 sudo 授权（全局 sudoPolicy + 令牌权限都要允许） */
  requiresSudo?: boolean
  /** 需要工作区授权 */
  requiresWorkspace?: boolean
  /** 需要本地目录白名单 */
  needsLocalDirs?: boolean
}

/** `mcp.listTools` 返回的单个工具视图（比 McpToolDef 多了即时开关状态） */
export interface McpToolView {
  name: string
  group: ToolGroup
  description: string
  /** 入参 JSON Schema（原样透传，UI 只做展示） */
  inputSchema: Record<string, unknown>
  enabled: boolean
  requiresSudo: boolean
  requiresWorkspace: boolean
}

/** `mcp.listTools` 的返回 */
export interface McpToolsResult {
  tools: McpToolView[]
  /** 当前实际生效的工具名（至少要保留一个） */
  effective: string[]
}

/**
 * `mcp.status` 的返回（UI 状态视图）。
 *
 * 与主进程 `server.ts` 内部的服务器状态区分：这里的 `clients` 是**客户端列表**
 * （UI 要展示每个令牌的权限），内部状态里的同名字段是**数量**。
 */
export interface McpStatus {
  running: boolean
  host: string
  port: number
  endpoint: string
  clients: PublicMcpClient[]
  tools: string[]
  policy: McpPolicy
}
