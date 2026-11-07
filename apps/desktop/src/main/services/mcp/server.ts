// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * MCP 服务端（Streamable HTTP，最简实现）：`POST /mcp` + JSON-RPC 2.0。
 *
 * 安全护栏（与 policy.ts 配合）：
 * - **默认只听 127.0.0.1**；HTTP 层再做一次 Host 校验，挡住 DNS rebinding；
 * - 每个请求都要 `Authorization: Bearer <token>`，令牌只存摘要、可即时撤销；
 * - 工具按策略过滤（未启用的工具连声明都不给）；
 * - 服务器白名单 / 本地目录白名单（realpath）/ sudo 独立策略 / 工作区独立策略；
 * - 执行策略为 confirm 时，没有确认回调就**默认拒绝**（fail-closed），不会静默放行；
 * - 超时：默认 60s，上限 600s。
 *
 * 设计上把「JSON-RPC 处理」与「HTTP 传输」分开：策略与工具语义可以直接单测，
 * 不需要每次都起 socket；HTTP 层只负责鉴权、Host 校验、请求体读取与错误码。
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import { AppError } from '../../errors'
import {
  assertLocalPathAllowed,
  assertServerAllowed,
  enabledToolDefs,
  extractBearer,
  isLoopbackHost,
  PathAccessError,
  TokenRegistry,
  type McpClient,
  type McpPolicy,
  type McpToolDef,
} from './policy'

/** 请求体上限：MCP 请求都很小，超过直接拒，防内存打爆 */
const MAX_BODY_BYTES = 1024 * 1024

/**
 * 服务端在协议/工具层只需要客户端的身份与权限，**不需要令牌摘要**。
 * 用最小契约可以让已鉴权的 PublicMcpClient 直接传入，也避免摘要到处流。
 */
export type McpClientIdentity = Pick<McpClient, 'id' | 'name' | 'allowSudo' | 'allowWorkspace'>
const MCP_PATH = '/mcp'
const PROTOCOL_VERSION = '2024-11-05'

export interface McpExecOutcome {
  stdout: string
  stderr: string
  code: number
  durationMs?: number
}

export interface McpServerSummary {
  serverId: string
  host: string
  username: string
  connectionId: string
  name?: string
}

/** 工具的真实执行能力（由上层注入；未注入的工具返回明确错误而不是假装成功） */
export interface McpToolRuntime {
  exec?: (serverId: string, command: string, options: { timeoutMs: number }) => Promise<McpExecOutcome>
  listServers?: () => McpServerSummary[]
  sftpList?: (serverId: string, path: string) => Promise<unknown>
  sftpStat?: (serverId: string, path: string) => Promise<unknown>
  sftpReadText?: (serverId: string, path: string) => Promise<string>
  sftpWriteText?: (serverId: string, path: string, content: string) => Promise<unknown>
  transferUpload?: (args: { serverId: string; localPath: string; remotePath: string; recursive: boolean }) => Promise<unknown>
  transferDownload?: (args: { serverId: string; remotePath: string; localPath: string; recursive: boolean }) => Promise<unknown>
  transferList?: (serverId?: string) => Promise<unknown>
  transferCancel?: (transferId: string) => Promise<unknown>
  workspaceList?: (kind: string) => Promise<unknown>
  workspaceSave?: (kind: string, id: string | undefined, data: Record<string, unknown>) => Promise<unknown>
}

export interface ConfirmationRequest {
  clientId: string
  clientName: string
  operation: string
  serverId?: string
  command?: string
  path?: string
  cwd?: string
  overwrite?: boolean
}

export interface McpServerOptions {
  policy: McpPolicy
  tokens: TokenRegistry
  runtime?: McpToolRuntime
  /** confirm 策略下的人工确认；**未提供则视为拒绝** */
  onConfirm?: (req: ConfirmationRequest) => Promise<boolean>
  now?: () => number
  log?: (message: string) => void
}

export interface McpStatus {
  running: boolean
  host: string
  port: number
  endpoint: string
  clients: number
  tools: string[]
  policy: McpPolicy
}

interface RpcRequest {
  jsonrpc?: string
  id?: string | number | null
  method?: string
  params?: unknown
}

interface RpcSuccess {
  jsonrpc: '2.0'
  id: string | number | null
  result: unknown
}
interface RpcFailure {
  jsonrpc: '2.0'
  id: string | number | null
  error: { code: number; message: string; data?: unknown }
}
export type RpcResponse = RpcSuccess | RpcFailure

/** 工具调用结果（MCP 规范形状） */
export interface ToolCallResult {
  content: Array<{ type: 'text'; text: string }>
  isError?: boolean
}

export class McpServer {
  private readonly tokens: TokenRegistry
  private policy: McpPolicy
  private runtime: McpToolRuntime
  private onConfirm?: (req: ConfirmationRequest) => Promise<boolean>
  private readonly now: () => number
  private readonly log: (message: string) => void

  private server: Server | null = null
  private sockets = new Set<Socket>()
  private boundPort = 0

  /** 测试注入用：设置未提供 runtime 时使用 */
  setRuntime(runtime: McpToolRuntime): void {
    this.runtime = { ...this.runtime, ...runtime }
  }

  getRuntime(): McpToolRuntime {
    return this.runtime
  }

  setConfirmationHandler(handler: ((req: ConfirmationRequest) => Promise<boolean>) | undefined): void {
    if (handler) this.onConfirm = handler
    else delete this.onConfirm
  }

  constructor(options: McpServerOptions) {
    this.policy = options.policy
    this.tokens = options.tokens
    if (options.runtime) this.runtime = options.runtime
    else this.runtime = {}
    if (options.onConfirm) this.onConfirm = options.onConfirm
    this.now = options.now ?? (() => Date.now())
    this.log = options.log ?? ((): void => {})
  }

  getPolicy(): McpPolicy {
    return this.policy
  }

  setPolicy(policy: McpPolicy): void {
    this.policy = policy
  }

  status(): McpStatus {
    const port = this.server ? this.boundPort : this.policy.port
    return {
      running: this.server !== null,
      host: this.policy.listenHost,
      port,
      endpoint: `http://${this.policy.listenHost === '0.0.0.0' ? '127.0.0.1' : this.policy.listenHost}:${port}${MCP_PATH}`,
      clients: this.tokens.list().filter((c) => !c.revoked).length,
      tools: enabledToolDefs(this.policy).map((t) => t.name),
      policy: this.policy,
    }
  }

  /**
   * 启动 HTTP 服务。
   * 端口被占用时抛 CONFLICT 且**不自动换端口**（与参考实现一致，避免用户连错地址）。
   */
  async start(): Promise<McpStatus> {
    if (this.server) return this.status()

    const server = createServer((req, res) => {
      void this.handleHttp(req, res)
    })
    server.on('connection', (socket) => {
      this.sockets.add(socket)
      socket.on('close', () => this.sockets.delete(socket))
    })

    await new Promise<void>((resolve, reject) => {
      const onError = (err: NodeJS.ErrnoException): void => {
        server.removeListener('listening', onListening)
        if (err.code === 'EADDRINUSE') {
          reject(AppError.conflict(`MCP 端口被占用: ${this.policy.port}（不会自动换端口，请改端口后重试）`))
        } else {
          reject(AppError.internal(`MCP 启动失败: ${err.message}`))
        }
      }
      const onListening = (): void => {
        server.removeListener('error', onError)
        resolve()
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(this.policy.port, this.policy.listenHost)
    })

    const address = server.address()
    this.boundPort = typeof address === 'object' && address !== null ? address.port : this.policy.port
    this.server = server
    this.log(`MCP 已监听 ${this.policy.listenHost}:${this.boundPort}${MCP_PATH}`)
    return this.status()
  }

  /** 停止服务并关闭所有连接（含 keep-alive，避免测试/退出时挂住） */
  async stop(): Promise<void> {
    const server = this.server
    this.server = null
    if (!server) return
    for (const socket of this.sockets) socket.destroy()
    this.sockets.clear()
    await new Promise<void>((resolve) => {
      server.close(() => resolve())
      // 已 destroy 的连接不应再阻塞 close；兜底定时器避免极端情况挂死
      setTimeout(resolve, 500).unref?.()
    })
    this.log('MCP 已停止')
  }

  // -------------------------------------------------------------------------
  // HTTP 传输层
  // -------------------------------------------------------------------------

  private async handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const url = req.url ?? '/'
      if (!url.startsWith(MCP_PATH)) {
        return sendJson(res, 404, { error: 'not found' })
      }
      if (req.method !== 'POST') {
        // 本实现不做 SSE 流式通道，GET 明确不支持
        res.setHeader('allow', 'POST')
        return sendJson(res, 405, { error: 'method not allowed' })
      }
      if (!this.hostAllowed(req)) {
        return sendJson(res, 403, { error: 'invalid host header' })
      }

      const client = this.tokens.verify(extractBearer(firstHeader(req.headers['authorization'])))
      if (!client) {
        res.setHeader('www-authenticate', 'Bearer')
        return sendJson(res, 401, { error: 'unauthorized' })
      }

      let body: string
      try {
        body = await readBody(req)
      } catch (err) {
        const message = err instanceof AppError ? err.message : '读取请求体失败'
        return sendJson(res, err instanceof AppError && err.code === 'BAD_REQUEST' ? 413 : 400, { error: message })
      }

      let parsed: RpcRequest
      try {
        parsed = JSON.parse(body) as RpcRequest
      } catch {
        return sendJson(res, 200, rpcError(null, -32700, 'Parse error'))
      }

      // 通知（没有 id）不返回 response body
      const isNotification = parsed.id === undefined || parsed.id === null
      const response = await this.handleRpc(parsed, client)
      if (isNotification) {
        res.statusCode = 202
        res.end()
        return
      }
      sendJson(res, 200, response)
    } catch (err) {
      this.log(`MCP 请求处理异常: ${err instanceof Error ? err.message : String(err)}`)
      if (!res.headersSent) sendJson(res, 500, { error: 'internal error' })
      else res.end()
    }
  }

  /** 回环监听时校验 Host，防 DNS rebinding 把浏览器指向本机服务 */
  private hostAllowed(req: IncomingMessage): boolean {
    if (!isLoopbackHost(this.policy.listenHost)) return true
    const host = firstHeader(req.headers['host'])
    if (!host) return false
    const hostname = host.startsWith('[') ? host.slice(1, host.indexOf(']')) : host.split(':')[0]
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1'
  }

  // -------------------------------------------------------------------------
  // JSON-RPC 处理（可独立单测）
  // -------------------------------------------------------------------------

  async handleRpc(request: RpcRequest, client: McpClientIdentity): Promise<RpcResponse> {
    const id = request.id ?? null
    const method = request.method

    if (typeof method !== 'string' || method === '') {
      return rpcError(id, -32600, 'Invalid Request')
    }

    switch (method) {
      case 'initialize':
        return rpcResult(id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'terminal-1000', version: '0.1.0' },
        })

      case 'notifications/initialized':
      case 'notifications/cancelled':
        return rpcResult(id, {})

      case 'ping':
        return rpcResult(id, {})

      case 'tools/list':
        return rpcResult(id, {
          tools: enabledToolDefs(this.policy).map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.parameters,
          })),
        })

      case 'tools/call': {
        const params = asRecord(request.params)
        const name = typeof params?.['name'] === 'string' ? params['name'] : ''
        if (name === '') return rpcError(id, -32602, 'Invalid params: missing tool name')
        const args = asRecord(params?.['arguments']) ?? {}
        const result = await this.callTool(name, args, client)
        return rpcResult(id, result)
      }

      default:
        return rpcError(id, -32601, `Method not found: ${method}`)
    }
  }

  // -------------------------------------------------------------------------
  // 工具执行（策略在这里生效）
  // -------------------------------------------------------------------------

  /** 执行工具；任何拒绝都以 isError 结果返回，不抛给传输层 */
  async callTool(name: string, args: Record<string, unknown>, client: McpClientIdentity): Promise<ToolCallResult> {
    const def = enabledToolDefs(this.policy).find((t) => t.name === name)
    if (!def) {
      return toolError(`工具未启用或不存在: ${name}`)
    }

    // 工作区授权
    if (def.requiresWorkspace) {
      if (this.policy.workspacePolicy === 'deny') {
        return toolError('工作区管理已被禁用（workspacePolicy=deny）')
      }
      if (!client.allowWorkspace) {
        return toolError('该客户端令牌未开启「允许工作区管理」')
      }
    }

    // sudo 授权：全局策略与令牌权限必须同时允许
    if (def.requiresSudo) {
      if (this.policy.sudoPolicy === 'deny') {
        return toolError('sudo 已被禁用（sudoPolicy=deny）')
      }
      if (!client.allowSudo) {
        return toolError('该客户端令牌未开启「允许 sudo」')
      }
    }

    const serverId = typeof args['serverId'] === 'string' ? args['serverId'] : undefined
    if (requiresServerId(def) && serverId === undefined) {
      return toolError(`缺少 serverId（先用 t1000_ssh_list_servers 获取）`)
    }
    if (serverId !== undefined) {
      try {
        assertServerAllowed(serverId, this.policy)
      } catch (err) {
        return toolError(err instanceof Error ? err.message : '服务器未被授权')
      }
    }

    // 本地目录白名单（上传源/下载目标）
    if (def.needsLocalDirs) {
      const localPath = args['localPath']
      if (typeof localPath !== 'string') return toolError('缺少 localPath')
      try {
        await assertLocalPathAllowed(localPath, this.policy, {
          // 上传源必须存在；下载目标按"可创建"校验
          mustExist: def.name === 't1000_transfer_upload',
        })
      } catch (err) {
        return toolError(err instanceof PathAccessError ? err.message : '本地路径不被允许')
      }
    }

    // 执行策略：confirm 时必须拿到确认，拿不到就拒绝（fail-closed）。
    // sudo 工具由 **sudoPolicy 自己**决定是否需要确认（deny 已在上面拦掉），
    // 不能被普通 executionPolicy 额外加一道确认，否则 sudoPolicy=direct 永远无法生效。
    const needsConfirm = def.requiresSudo
      ? this.policy.sudoPolicy === 'confirm'
      : this.policy.executionPolicy === 'confirm'
    if (needsConfirm) {
      const approved = await this.confirm({
        clientId: client.id,
        clientName: client.name,
        operation: def.name,
        ...(serverId === undefined ? {} : { serverId }),
        ...(typeof args['command'] === 'string' ? { command: args['command'] } : {}),
        ...(typeof args['path'] === 'string' ? { path: args['path'] } : {}),
        ...(typeof args['cwd'] === 'string' ? { cwd: args['cwd'] } : {}),
      })
      if (!approved) {
        return toolError('需要用户确认，已拒绝执行（未获确认）')
      }
    }

    try {
      return await this.dispatch(def, args, serverId)
    } catch (err) {
      if (err instanceof AppError) return toolError(err.message)
      return toolError(err instanceof Error ? err.message : String(err))
    }
  }

  private async confirm(req: ConfirmationRequest): Promise<boolean> {
    if (!this.onConfirm) return false
    try {
      return await this.onConfirm(req)
    } catch {
      return false
    }
  }

  private async dispatch(
    def: McpToolDef,
    args: Record<string, unknown>,
    serverId: string | undefined,
  ): Promise<ToolCallResult> {
    const timeoutMs = this.resolveTimeout(args['timeoutSec'])

    switch (def.name) {
      case 't1000_ssh_list_servers': {
        const all = this.runtime.listServers?.() ?? []
        const visible = all.filter((s) => this.policy.allowedServerIds === 'all' || this.policy.allowedServerIds.includes(s.serverId))
        return toolOk(JSON.stringify(visible))
      }

      case 't1000_ssh_exec': {
        const command = requireString(args, 'command')
        if (!this.runtime.exec) return toolError('当前未接入命令执行能力')
        const outcome = await this.runtime.exec(serverId!, command, { timeoutMs })
        return toolOk(formatOutcome(outcome), outcome.code !== 0)
      }

      case 't1000_ssh_sudo_exec': {
        const command = requireString(args, 'command')
        if (!this.runtime.exec) return toolError('当前未接入命令执行能力')
        // 客户端不传 sudo 前缀、不传密码；这里只负责加前缀
        const outcome = await this.runtime.exec(serverId!, `sudo ${command}`, { timeoutMs })
        return toolOk(formatOutcome(outcome), outcome.code !== 0)
      }

      case 't1000_sftp_list': {
        if (!this.runtime.sftpList) return toolError('当前未接入远程文件能力')
        return toolOk(JSON.stringify(await this.runtime.sftpList(serverId!, requireString(args, 'path'))))
      }

      case 't1000_sftp_stat': {
        if (!this.runtime.sftpStat) return toolError('当前未接入远程文件能力')
        return toolOk(JSON.stringify(await this.runtime.sftpStat(serverId!, requireString(args, 'path'))))
      }

      case 't1000_sftp_read_text': {
        if (!this.runtime.sftpReadText) return toolError('当前未接入远程文件能力')
        return toolOk(await this.runtime.sftpReadText(serverId!, requireString(args, 'path')))
      }

      case 't1000_sftp_write_text': {
        if (!this.runtime.sftpWriteText) return toolError('当前未接入远程文件能力')
        await this.runtime.sftpWriteText(serverId!, requireString(args, 'path'), requireString(args, 'content'))
        return toolOk('已写入')
      }

      case 't1000_transfer_upload': {
        if (!this.runtime.transferUpload) return toolError('当前未接入文件传输能力')
        const result = await this.runtime.transferUpload({
          serverId: serverId!,
          localPath: requireString(args, 'localPath'),
          remotePath: requireString(args, 'remotePath'),
          recursive: args['recursive'] === true,
        })
        return toolOk(JSON.stringify(result))
      }

      case 't1000_transfer_download': {
        if (!this.runtime.transferDownload) return toolError('当前未接入文件传输能力')
        const result = await this.runtime.transferDownload({
          serverId: serverId!,
          remotePath: requireString(args, 'remotePath'),
          localPath: requireString(args, 'localPath'),
          recursive: args['recursive'] === true,
        })
        return toolOk(JSON.stringify(result))
      }

      case 't1000_transfer_list': {
        if (!this.runtime.transferList) return toolError('当前未接入文件传输能力')
        return toolOk(JSON.stringify(await this.runtime.transferList(serverId)))
      }

      case 't1000_transfer_cancel': {
        if (!this.runtime.transferCancel) return toolError('当前未接入文件传输能力')
        return toolOk(JSON.stringify(await this.runtime.transferCancel(requireString(args, 'transferId'))))
      }

      case 't1000_workspace_list': {
        if (!this.runtime.workspaceList) return toolError('当前未接入工作区能力')
        return toolOk(JSON.stringify(await this.runtime.workspaceList(requireString(args, 'kind'))))
      }

      case 't1000_workspace_save': {
        if (!this.runtime.workspaceSave) return toolError('当前未接入工作区能力')
        const data = asRecord(args['data'])
        if (!data) return toolError('data 必须是对象')
        const id = typeof args['id'] === 'string' ? args['id'] : undefined
        return toolOk(JSON.stringify(await this.runtime.workspaceSave(requireString(args, 'kind'), id, data)))
      }

      default:
        return toolError(`工具未实现: ${def.name}`)
    }
  }

  /** 超时：默认值 → 请求值 → 上限裁剪 */
  private resolveTimeout(timeoutSec: unknown): number {
    const requested = typeof timeoutSec === 'number' && Number.isFinite(timeoutSec) ? timeoutSec * 1000 : undefined
    if (requested === undefined) return this.policy.defaultTimeoutMs
    return Math.min(Math.max(Math.floor(requested), 1_000), this.policy.maxTimeoutMs)
  }
}

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

function requiresServerId(def: McpToolDef): boolean {
  const required = def.parameters['required']
  return Array.isArray(required) && required.includes('serverId')
}

function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key]
  if (typeof value !== 'string' || value === '') {
    throw AppError.badRequest(`缺少参数 ${key}`)
  }
  return value
}

export function toolOk(text: string, isError = false): ToolCallResult {
  return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) }
}

export function toolError(text: string): ToolCallResult {
  return { content: [{ type: 'text', text }], isError: true }
}

function formatOutcome(outcome: McpExecOutcome): string {
  const parts = [`exitCode=${outcome.code}`]
  if (outcome.durationMs !== undefined) parts.push(`durationMs=${outcome.durationMs}`)
  if (outcome.stdout !== '') parts.push(`stdout:\n${outcome.stdout}`)
  if (outcome.stderr !== '') parts.push(`stderr:\n${outcome.stderr}`)
  return parts.join('\n')
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0]
  return value
}

function rpcResult(id: string | number | null, result: unknown): RpcSuccess {
  return { jsonrpc: '2.0', id, result }
}

function rpcError(id: string | number | null, code: number, message: string, data?: unknown): RpcFailure {
  return { jsonrpc: '2.0', id, error: { code, message, ...(data === undefined ? {} : { data }) } }
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('content-length', Buffer.byteLength(body))
  res.end(body)
}

async function readBody(req: IncomingMessage): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(AppError.badRequest('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', (err) => reject(err))
  })
}
