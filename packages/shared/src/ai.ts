// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * AI 助手面向 UI 的数据形状。
 *
 * 为什么在这里：这些形状原先分散在主进程 `services/ai/providers.ts`（消息/用量）
 * 与 `services/ai/chat.ts`（会话/摘要），渲染层只能镜像。上移后成为唯一契约。
 *
 * 边界：本文件只放**跨进程形状**。provider 客户端内部类型（`ProviderClient`、
 * `FetchLike`、`StreamCallbacks`、`StreamResult`、`ToolSpec`、`SseEvent`）与
 * 工具执行编排类型（`ChatDeps`、`ExecOutcome`、`AuditEntry`）都留在主进程。
 * 本文件**零 import**、零运行时代码。
 *
 * 安全不变量：面向 UI 的供应商视图（`PublicProvider`）**绝不含 apiKey**，
 * 只暴露 `hasApiKey` 布尔。密钥永不出主进程。
 */

/** 模型发起的工具调用（`arguments` 是原始 JSON 字符串，流式拼装完成前可能不完整） */
export interface ToolCallRequest {
  id: string
  name: string
  arguments: string
}

/**
 * 一条对话消息。
 *
 * 注意：这是主进程实际存取与返回的形状 —— **没有 `id` / `createdAt` 字段**。
 * 早期渲染层镜像多声明了这两个字段，运行期恒为 undefined（典型静默漂移）。
 */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  /** tool 角色回填时对应哪次调用 */
  toolCallId?: string
  /** assistant 消息里模型发起的工具调用 */
  toolCalls?: ToolCallRequest[]
  name?: string
}

/** token 用量（供应商不返回时字段缺省） */
export interface TokenUsage {
  inputTokens?: number
  outputTokens?: number
}

/** 一个 AI 会话（含完整消息历史） */
export interface ChatSession {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  messages: ChatMessage[]
  usage: TokenUsage
}

/** 会话列表项（`ai.listChats` 的返回；不含消息体） */
export interface ChatSummary {
  id: string
  title: string
  createdAt: string
  updatedAt: string
}

/** `ai.send` 的返回 */
export interface SendResult {
  chatId: string
  messageId: string
  text: string
  /** 本轮实际执行的工具调用次数 */
  toolCalls: number
}

/** 可执行的远端会话摘要（供"跨多台主机执行"的场景选择目标） */
export interface SessionSummary {
  sessionId: string
  host: string
  username: string
  connectionId: string
}

/**
 * 供应商公开视图（`ai.listProviders` 的返回）。
 *
 * **绝不含 `apiKey`**：只给 `hasApiKey` 布尔，UI 据此显示"已配置/未配置"。
 * 需要密钥的操作只能走主进程内部（`AiProviderConfig` 含密钥，不进 shared 的对外视图）。
 */
export interface PublicProvider {
  id: string
  name: string
  kind: 'openai' | 'anthropic'
  baseUrl: string
  model: string
  /** 是否已配置密钥（不含密钥本身） */
  hasApiKey: boolean
  extendedThinking?: boolean
  temperature?: number
  maxTokens?: number
}
