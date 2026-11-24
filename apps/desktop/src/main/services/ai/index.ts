// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * ai 域 IPC 入口：Actions.ai 的 7 个动作。
 *
 * 依赖注入：设置（AiSettings）、供应商、命令执行、会话列举、远端读文件
 * 都由 `configureAi()` 注入 —— 跨服务调用走显式注入，不 import 其它服务内部实现。
 * 命令执行默认接**中立契约** session-registry 的 `session.exec`，不自建连接。
 *
 * 机密边界：`listProviders` 绝不返回 apiKey（只回 hasApiKey 布尔）。
 */

import { z } from 'zod'
import type { AiProviderConfig, AiSettings, EventName, EventPayloads, PublicProvider, ChatMessage} from '@t1000/shared'
import { AppError, parseInput } from '../../errors'
import type { IpcContext, IpcHandler } from '../../ipc/router'
import { listSessions as listLiveSessions, requireSession } from '../session-registry'
import { ChatService, type ChatDeps, type SessionSummary } from './chat'
import { createProviderClient, globalFetch } from './providers'
import {
  NO_PROVIDER_MESSAGE,
  SUGGEST_TIMEOUT_MS,
  buildSuggestPrompt,
  missingApiKeyMessage,
  parseCommandSuggestions,
} from './suggest'

/** 单次读取远端文件的字节上限（AI 读文件不能把主进程内存打爆） */
const MAX_AI_READ_BYTES = 2 * 1024 * 1024

/** 未注入设置时的保守默认（与 guard 的安全默认一致） */
const SAFE_SETTINGS: AiSettings = {
  providers: [],
  assistantName: '问问老菜',
  mode: 'chat',
  allowExecution: false,
  riskPolicy: { readOnlyAllowlist: [], dangerousDenylist: [], confirmSudo: true },
  limits: { maxRounds: 20, maxCommands: 50, maxTargets: 5 },
}

// ---------------------------------------------------------------------------
// 运行时依赖（可注入）
// ---------------------------------------------------------------------------

export interface AiRuntime {
  getSettings?: () => AiSettings
  /** 覆盖"当前选中的供应商"（setProvider 动作写入） */
  setActiveProvider?: (providerId: string) => void
  fetch?: ChatDeps['fetch']
  exec?: ChatDeps['exec']
  listSessions?: () => SessionSummary[]
  readRemoteFile?: ChatDeps['readRemoteFile']
  auditSink?: ChatDeps['auditSink']
}

let runtime: AiRuntime = {}
let activeProviderOverride: string | undefined

/** 应用启动时注入真实依赖（设置服务 / 日志 / 审计落盘等） */
export function configureAi(next: AiRuntime): void {
  runtime = { ...runtime, ...next }
}

/** 测试自检用 */
/**
 * AI 命令建议（补全里的 `??` 通道）。
 *
 * 这是 `services/completion` 需要的**最小缝**：只回命令文本 + 可选说明，
 * 不让 AI 侧了解补全的候选结构（score/matchKind…）。
 *
 * 实现要点：
 * - **复用既有的 provider client**，不另写 HTTP（跨服务能力统一走 providers.ts）
 * - 未配供应商 / 未填 API Key / 调用失败 → 抛**可操作**的错误（补全侧会原样呈现给用户）
 */
export async function suggestCommands(
  input: { query: string; context?: unknown },
  limit: number,
): Promise<Array<{ command: string; description?: string }>> {
  const provider = findProvider()
  if (!provider) throw AppError.badRequest(NO_PROVIDER_MESSAGE)
  if (!provider.apiKey) throw AppError.badRequest(missingApiKeyMessage(provider.name))

  const client = createProviderClient(provider, { fetch: runtime.fetch ?? globalFetch })
  // 纯函数只产出 {role, content}；这里补齐 ChatMessage 需要的元数据
  const now = new Date().toISOString()
  const messages: ChatMessage[] = buildSuggestPrompt(input.query, limit).map((turn, i) => ({
    id: `suggest-${i}`,
    role: turn.role,
    content: turn.content,
    createdAt: now,
  }))

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), SUGGEST_TIMEOUT_MS)
  try {
    const result = await client.streamChat({ messages, signal: controller.signal })
    return parseCommandSuggestions(result.text, limit)
  } catch (err) {
    // 超时要说清是超时（而不是让用户对着"失败"发愣）
    if (controller.signal.aborted) {
      throw AppError.internal(
        `AI 建议在 ${Math.round(SUGGEST_TIMEOUT_MS / 1000)} 秒内没有返回。` +
          'AI 建议对延迟很敏感（补全弹窗会一直等），建议在「设置 > AI 助手」里为它改用**响应更快的模型**' +
          '（推理型模型往往会先"想"很久）；也可以换个说法再试',
      )
    }
    throw err instanceof AppError
      ? err
      : AppError.internal(
          `AI 建议调用失败：${err instanceof Error ? err.message : String(err)}`,
        )
  } finally {
    clearTimeout(timer)
  }
}

export function resetAiRuntime(): void {
  runtime = {}
  activeProviderOverride = undefined
  service = null
}

function settings(): AiSettings {
  return runtime.getSettings?.() ?? SAFE_SETTINGS
}

function findProvider(id?: string): AiProviderConfig | undefined {
  const s = settings()
  const all = s.providers
  // 解析优先级：调用方显式指定 > 运行期 override > **设置里持久化的 activeProviderId** > 第一个。
  // 中间那两级缺一不可：只认 override 的话，用户选中的供应商**重启后就丢了**
  // （设置里明明存着，却没人读）。
  const wanted = id ?? activeProviderOverride ?? s.activeProviderId
  if (wanted !== undefined) {
    const hit = all.find((p) => p.id === wanted)
    if (hit) return hit
  }
  return all[0]
}

/** 默认命令执行：走 session-registry 的中立契约，不自建连接 */
const defaultExec: NonNullable<ChatDeps['exec']> = async (sessionId, command, options) => {
  let session
  try {
    session = requireSession(sessionId)
  } catch (err) {
    throw AppError.notConnected(err instanceof Error ? err.message : '会话不存在或已断开')
  }
  return session.exec(command, { timeoutMs: options?.timeoutMs ?? 60_000 })
}

const defaultListSessions = (): SessionSummary[] =>
  listLiveSessions().map((s) => ({
    sessionId: s.sessionId,
    host: s.host,
    username: s.username,
    connectionId: s.connectionId,
  }))

/**
 * 默认远端读文件：直接用会话的 ssh2 SFTP 通道读，**先 stat 查大小**再读。
 * 不从 sftp 服务 import（跨服务内部文件不允许），只依赖客户端原生能力。
 */
const defaultReadRemoteFile: NonNullable<ChatDeps['readRemoteFile']> = async (
  sessionId,
  path,
  maxBytes = MAX_AI_READ_BYTES,
) => {
  let session
  try {
    session = requireSession(sessionId)
  } catch (err) {
    throw AppError.notConnected(err instanceof Error ? err.message : '会话不存在或已断开')
  }
  const sftp = await new Promise<import('ssh2').SFTPWrapper>((resolve, reject) => {
    session.client.sftp((err, wrapper) => {
      if (err) reject(AppError.notConnected(`打开 SFTP 通道失败: ${err.message}`))
      else resolve(wrapper)
    })
  })
  return new Promise<string>((resolve, reject) => {
    sftp.stat(path, (statErr, stats) => {
      if (statErr) return reject(AppError.notFound(`远端文件不可读: ${path}`))
      if (stats.size > maxBytes) {
        return reject(AppError.badRequest(`文件过大（${stats.size} > ${maxBytes} 字节），已拒绝读取`))
      }
      sftp.readFile(path, (readErr, data) => {
        if (readErr) return reject(AppError.internal(`读取失败: ${readErr.message}`))
        resolve(data.toString('utf8'))
      })
    })
  })
}

// ---------------------------------------------------------------------------
// 服务单例
// ---------------------------------------------------------------------------

let service: ChatService | null = null

function chatService(ctx: IpcContext): ChatService {
  if (!service) {
    service = new ChatService({
      emit: ctx.emit,
      getSettings: settings,
      getProvider: findProvider,
      listProviders: () => settings().providers,
      fetch: runtime.fetch ?? globalFetch,
      exec: runtime.exec ?? defaultExec,
      listSessions: runtime.listSessions ?? defaultListSessions,
      readRemoteFile: runtime.readRemoteFile ?? defaultReadRemoteFile,
      ...(runtime.auditSink ? { auditSink: runtime.auditSink } : {}),
    })
  } else {
    // IPC 上下文可能在服务创建后才拿到最终广播函数
    service.setEmitter(ctx.emit)
  }
  return service
}

/** 测试/排障：当前会话服务实例 */
export function getChatService(): ChatService | null {
  return service
}

// ---------------------------------------------------------------------------
// 参数校验
// ---------------------------------------------------------------------------

const chatId = z.string().min(1, '缺少 chatId')
const sendSchema = z.object({
  chatId: chatId.optional(),
  text: z.string().min(1, '消息不能为空'),
  providerId: z.string().min(1).optional(),
})
const getChatSchema = z.object({ chatId })
const cancelSchema = z.object({ chatId })
const deleteChatSchema = z.object({ chatId })
const setProviderSchema = z.object({ providerId: z.string().min(1) })

/**
 * 对外暴露的供应商信息（**不含 apiKey**）。
 *
 * 返回类型显式标注为 shared 的 `PublicProvider`：UI 契约在 shared 里定义，
 * 这里少一个字段或多带一个密钥都会在编译期报错。
 */
function publicProvider(p: AiProviderConfig): PublicProvider {
  return {
    id: p.id,
    name: p.name,
    kind: p.kind,
    baseUrl: p.baseUrl,
    model: p.model,
    hasApiKey: typeof p.apiKey === 'string' && p.apiKey !== '',
    ...(p.extendedThinking === undefined ? {} : { extendedThinking: p.extendedThinking }),
    ...(p.temperature === undefined ? {} : { temperature: p.temperature }),
    ...(p.maxTokens === undefined ? {} : { maxTokens: p.maxTokens }),
  }
}

// ---------------------------------------------------------------------------
// Handler 表
// ---------------------------------------------------------------------------

export const aiHandlers: Record<string, IpcHandler> = {
  listChats: (_payload, ctx) => chatService(ctx).listChats(),

  getChat: (payload, ctx) => {
    const { chatId: id } = parseInput(getChatSchema, payload)
    const chat = chatService(ctx).getChat(id)
    if (!chat) throw AppError.notFound(`AI 会话不存在: ${id}`)
    return chat
  },

  send: (payload, ctx) => {
    const { chatId: id, text, providerId } = parseInput(sendSchema, payload)
    return chatService(ctx).send({
      ...(id === undefined ? {} : { chatId: id }),
      text,
      ...(providerId === undefined ? {} : { providerId }),
    })
  },

  cancel: (payload, ctx) => {
    const { chatId: id } = parseInput(cancelSchema, payload)
    return { chatId: id, cancelled: chatService(ctx).cancel(id) }
  },

  deleteChat: (payload, ctx) => {
    const { chatId: id } = parseInput(deleteChatSchema, payload)
    return { chatId: id, deleted: chatService(ctx).deleteChat(id) }
  },

  /** 只回可公开字段；apiKey 永不出主进程 */
  listProviders: () => ({ providers: settings().providers.map(publicProvider) }),

  setProvider: (payload) => {
    const { providerId } = parseInput(setProviderSchema, payload)
    if (!settings().providers.some((p) => p.id === providerId)) {
      throw AppError.notFound(`供应商不存在: ${providerId}`)
    }
    activeProviderOverride = providerId
    runtime.setActiveProvider?.(providerId)
    return { providerId }
  },
}
