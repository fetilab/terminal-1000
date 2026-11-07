// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * BYO-key 直连客户端：openai / anthropic（及任何兼容 endpoint）。
 *
 * 为什么手写而不用官方 SDK：
 * - 少两个重依赖、打包体积小（PERFORMANCE-GOALS 明确要控体积）；
 * - 只需要"流式 + 工具调用"这一个子集，SDK 的其余能力是负担；
 * - 关键：**直连用户自己的 endpoint**，不经任何中转，key 只在本地使用。
 *
 * 可测性：`fetch` 由外部注入。单测用假 fetch + 手写 SSE 分片（含跨 chunk 截断的行），
 * 绝不真的访问外部 AI 服务。
 */

import type { AiProviderConfig, ChatMessage, TokenUsage, ToolCallRequest } from '@t1000/shared'
import { AppError } from '../../errors'

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

// 消息 / 工具调用 / 用量这些**跨进程形状**的唯一定义处已上移到 `@t1000/shared`
// （渲染层同样从那里取），这里再导出一次保持既有 `./providers` 路径可用。
export type { ChatMessage, TokenUsage, ToolCallRequest }

/** 暴露给模型的工具定义（JSON Schema） */
export interface ToolSpec {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export interface StreamCallbacks {
  onText?(text: string): void
  onToolCall?(call: ToolCallRequest): void
  onUsage?(usage: TokenUsage): void
}

export interface StreamResult {
  text: string
  toolCalls: ToolCallRequest[]
  usage: TokenUsage
  finishReason?: string
}

/** 最小 fetch 契约：只用到 url/init/Response 的这一小部分，便于注入假实现 */
export interface FetchResponseLike {
  ok: boolean
  status: number
  statusText?: string
  text(): Promise<string>
  body?: AsyncIterable<Uint8Array | string> | null
}

export interface FetchLike {
  (url: string, init?: {
    method?: string
    headers?: Record<string, string>
    body?: string
    signal?: AbortSignal
  }): Promise<FetchResponseLike>
}

export interface ProviderClient {
  readonly kind: 'openai' | 'anthropic'
  streamChat(args: {
    messages: ChatMessage[]
    tools?: ToolSpec[]
    mode?: 'chat' | 'assistant' | 'confirm' | 'thinking'
    signal?: AbortSignal
    callbacks?: StreamCallbacks
  }): Promise<StreamResult>
}

// ---------------------------------------------------------------------------
// SSE 解析
// ---------------------------------------------------------------------------

export interface SseEvent {
  /** `event:` 字段（Anthropic 用；OpenAI 没有） */
  event?: string
  /** `data:` 字段（多行 data 按规范用 \n 连接） */
  data: string
}

/**
 * 增量 SSE 解析器。
 *
 * 关键点（也是单测重点）：网络分片**不保证按行/按事件边界**到达，
 * 所以必须保留未完成尾巴，等下一个 chunk 补齐。这里只在遇到空行（事件分隔）时才产出。
 */
export class SseParser {
  private buffer = ''

  /** 喂入一段文本，返回因此**完整**的事件（未完成的留在内部缓冲） */
  push(chunk: string): SseEvent[] {
    this.buffer += chunk
    const events: SseEvent[] = []

    // 事件以空行分隔；兼容 \r\n\r\n 与 \n\n
    let index = this.buffer.search(/\r?\n\r?\n/)
    while (index !== -1) {
      const raw = this.buffer.slice(0, index)
      const match = /\r?\n\r?\n/.exec(this.buffer.slice(index))
      const consumed = index + (match?.[0]?.length ?? 2)
      this.buffer = this.buffer.slice(consumed)
      const parsed = parseSseBlock(raw)
      if (parsed) events.push(parsed)
      index = this.buffer.search(/\r?\n\r?\n/)
    }
    return events
  }

  /** 流结束时调用：把没有空行结尾的最后一帧也吐出来（不少服务端发完就不补空行） */
  flush(): SseEvent[] {
    const rest = this.buffer
    this.buffer = ''
    const parsed = parseSseBlock(rest)
    return parsed ? [parsed] : []
  }
}

function parseSseBlock(raw: string): SseEvent | null {
  if (raw.trim() === '') return null
  let event: string | undefined
  const dataLines: string[] = []

  for (const line of raw.split(/\r?\n/)) {
    if (line === '' || line.startsWith(':')) continue // 注释/心跳
    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    // 规范：冒号后若有一个空格要去掉
    let value = colon === -1 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)

    if (field === 'data') dataLines.push(value)
    else if (field === 'event') event = value
    // id/retry 不需要
  }

  if (dataLines.length === 0 && event === undefined) return null
  return { ...(event === undefined ? {} : { event }), data: dataLines.join('\n') }
}

/** 安全解析工具参数：模型可能给出不完整/非法 JSON，退化成 {} 而不是抛错 */
export function parseToolArguments(raw: string): Record<string, unknown> {
  if (!raw || raw.trim() === '') return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
    return { value: parsed }
  } catch {
    return {}
  }
}

// ---------------------------------------------------------------------------
// 请求构造
// ---------------------------------------------------------------------------

/** 规范化 baseUrl → 最终 endpoint */
export function resolveEndpoint(baseUrl: string, kind: 'openai' | 'anthropic'): string {
  const trimmed = baseUrl.replace(/\/+$/, '')
  if (kind === 'anthropic') {
    return trimmed.endsWith('/messages') ? trimmed : `${trimmed}/v1/messages`
  }
  if (trimmed.endsWith('/chat/completions')) return trimmed
  if (/\/v\d+$/.test(trimmed)) return `${trimmed}/chat/completions`
  return `${trimmed}/v1/chat/completions`
}

function toOpenAiTools(tools: ToolSpec[]): Array<Record<string, unknown>> {
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }))
}

function toAnthropicTools(tools: ToolSpec[]): Array<Record<string, unknown>> {
  return tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }))
}

/** 构造 OpenAI 兼容请求体（导出以便单测断言结构与顺序） */
export function buildOpenAiBody(
  config: AiProviderConfig,
  messages: ChatMessage[],
  tools: ToolSpec[],
  mode?: string,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: config.model,
    stream: true,
    messages: messages.map((m) => {
      if (m.role === 'tool') {
        return { role: 'tool', tool_call_id: m.toolCallId ?? '', content: m.content }
      }
      if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
        return {
          role: 'assistant',
          content: m.content === '' ? null : m.content,
          tool_calls: m.toolCalls.map((c) => ({
            id: c.id,
            type: 'function',
            function: { name: c.name, arguments: c.arguments },
          })),
        }
      }
      return { role: m.role, content: m.content }
    }),
  }
  if (tools.length > 0) {
    body.tools = toOpenAiTools(tools)
    body.tool_choice = 'auto'
  }
  if (typeof config.temperature === 'number') body.temperature = config.temperature
  if (typeof config.maxTokens === 'number') body.max_tokens = config.maxTokens
  // 扩展思考：仅显式开启时带上，避免兼容端点因未知字段报错
  if (mode === 'thinking' || config.extendedThinking) body.reasoning_effort = 'medium'
  return body
}

/** 构造 Anthropic 请求体 */
export function buildAnthropicBody(
  config: AiProviderConfig,
  messages: ChatMessage[],
  tools: ToolSpec[],
  mode?: string,
): Record<string, unknown> {
  const systemParts = messages.filter((m) => m.role === 'system').map((m) => m.content)
  const rest = messages.filter((m) => m.role !== 'system')

  const body: Record<string, unknown> = {
    model: config.model,
    stream: true,
    // Anthropic 的 max_tokens 必填
    max_tokens: config.maxTokens ?? 4096,
    messages: rest.map((m) => {
      if (m.role === 'tool') {
        return {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: m.toolCallId ?? '', content: m.content },
          ],
        }
      }
      if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
        const content: Array<Record<string, unknown>> = []
        if (m.content !== '') content.push({ type: 'text', text: m.content })
        for (const c of m.toolCalls) {
          content.push({ type: 'tool_use', id: c.id, name: c.name, input: parseToolArguments(c.arguments) })
        }
        return { role: 'assistant', content }
      }
      return { role: m.role, content: m.content }
    }),
  }
  if (systemParts.length > 0) body.system = systemParts.join('\n\n')
  if (tools.length > 0) body.tools = toAnthropicTools(tools)
  if (typeof config.temperature === 'number') body.temperature = config.temperature
  if (mode === 'thinking' || config.extendedThinking) {
    body.thinking = { type: 'enabled', budget_tokens: 2048 }
  }
  return body
}

// ---------------------------------------------------------------------------
// 客户端
// ---------------------------------------------------------------------------

interface OpenAiToolAccumulator {
  [index: number]: { id: string; name: string; args: string }
}

/**
 * 创建 provider 客户端。`deps.fetch` 必传（生产用 globalThis.fetch，单测用假实现）。
 */
export function createProviderClient(
  config: AiProviderConfig,
  deps: { fetch: FetchLike },
): ProviderClient {
  const kind = config.kind

  return {
    kind,
    async streamChat({ messages, tools = [], mode, signal, callbacks }): Promise<StreamResult> {
      if (!config.apiKey) {
        throw AppError.unauthorized(`供应商「${config.name}」未配置 API Key`)
      }
      const endpoint = resolveEndpoint(config.baseUrl, kind)
      const body =
        kind === 'anthropic'
          ? buildAnthropicBody(config, messages, tools, mode)
          : buildOpenAiBody(config, messages, tools, mode)

      const headers: Record<string, string> = {
        'content-type': 'application/json',
        accept: 'text/event-stream',
        ...(kind === 'anthropic'
          ? { 'x-api-key': config.apiKey, 'anthropic-version': '2023-06-01' }
          : { authorization: `Bearer ${config.apiKey}` }),
      }

      let response: FetchResponseLike
      try {
        response = await deps.fetch(endpoint, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          ...(signal ? { signal } : {}),
        })
      } catch (err) {
        throw AppError.internal(
          `连接供应商失败: ${err instanceof Error ? err.message : String(err)}`,
        )
      }

      if (!response.ok) {
        const detail = await safeText(response)
        const message = `供应商返回 ${response.status}${detail ? `: ${truncate(detail, 300)}` : ''}`
        if (response.status === 401 || response.status === 403) throw AppError.unauthorized(message)
        if (response.status === 429) throw AppError.timeout(message)
        throw AppError.internal(message)
      }

      return kind === 'anthropic'
        ? consumeAnthropic(response, callbacks)
        : consumeOpenAi(response, callbacks)
    },
  }
}

async function safeText(response: FetchResponseLike): Promise<string> {
  try {
    return await response.text()
  } catch {
    return ''
  }
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`
}

/** 把 body 统一成字符串分片迭代器（兼容 Uint8Array 与 string 分片） */
async function* bodyChunks(response: FetchResponseLike): AsyncGenerator<string> {
  const body = response.body
  if (!body) return
  const decoder = new TextDecoder()
  for await (const chunk of body) {
    yield typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true })
  }
}

interface JsonRecord {
  [k: string]: unknown
}

function asRecord(value: unknown): JsonRecord | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : null
}

/** OpenAI 兼容流：choices[].delta.content / delta.tool_calls，结束于 [DONE] */
async function consumeOpenAi(
  response: FetchResponseLike,
  callbacks?: StreamCallbacks,
): Promise<StreamResult> {
  const parser = new SseParser()
  const toolAcc: OpenAiToolAccumulator = {}
  let text = ''
  let finishReason: string | undefined
  const usage: TokenUsage = {}

  const handle = (data: string): boolean => {
    if (data.trim() === '[DONE]') return true
    let json: JsonRecord | null
    try {
      json = asRecord(JSON.parse(data))
    } catch {
      return false // 容忍心跳/非 JSON 帧
    }
    if (!json) return false

    const usageRecord = asRecord(json['usage'])
    if (usageRecord) {
      const input = usageRecord['prompt_tokens'] ?? usageRecord['input_tokens']
      const output = usageRecord['completion_tokens'] ?? usageRecord['output_tokens']
      if (typeof input === 'number') usage.inputTokens = input
      if (typeof output === 'number') usage.outputTokens = output
      callbacks?.onUsage?.({ ...usage })
    }

    const choices = json['choices']
    if (!Array.isArray(choices)) return false
    const choice = asRecord(choices[0])
    if (!choice) return false

    if (typeof choice['finish_reason'] === 'string') finishReason = choice['finish_reason']
    const delta = asRecord(choice['delta'])
    if (!delta) return false

    const content = delta['content']
    if (typeof content === 'string' && content !== '') {
      text += content
      callbacks?.onText?.(content)
    }

    const toolCalls = delta['tool_calls']
    if (Array.isArray(toolCalls)) {
      for (const raw of toolCalls) {
        const call = asRecord(raw)
        if (!call) continue
        const index = typeof call['index'] === 'number' ? call['index'] : 0
        const slot = (toolAcc[index] ??= { id: '', name: '', args: '' })
        if (typeof call['id'] === 'string' && call['id'] !== '') slot.id = call['id']
        const fn = asRecord(call['function'])
        if (fn) {
          if (typeof fn['name'] === 'string' && fn['name'] !== '') slot.name = fn['name']
          if (typeof fn['arguments'] === 'string') slot.args += fn['arguments']
        }
      }
    }
    return false
  }

  for await (const chunk of bodyChunks(response)) {
    for (const event of parser.push(chunk)) {
      if (handle(event.data)) return finalizeOpenAi(toolAcc, text, usage, finishReason, callbacks)
    }
  }
  for (const event of parser.flush()) {
    handle(event.data)
  }
  return finalizeOpenAi(toolAcc, text, usage, finishReason, callbacks)
}

function finalizeOpenAi(
  toolAcc: OpenAiToolAccumulator,
  text: string,
  usage: TokenUsage,
  finishReason: string | undefined,
  callbacks?: StreamCallbacks,
): StreamResult {
  const toolCalls: ToolCallRequest[] = []
  for (const key of Object.keys(toolAcc)) {
    const slot = toolAcc[Number(key)]
    if (!slot || slot.name === '') continue
    const call: ToolCallRequest = {
      id: slot.id || `call_${key}`,
      name: slot.name,
      arguments: slot.args,
    }
    toolCalls.push(call)
    callbacks?.onToolCall?.(call)
  }
  return { text, toolCalls, usage, ...(finishReason === undefined ? {} : { finishReason }) }
}

/** Anthropic 流：content_block_delta(text_delta / input_json_delta)、message_delta(usage) */
async function consumeAnthropic(
  response: FetchResponseLike,
  callbacks?: StreamCallbacks,
): Promise<StreamResult> {
  const parser = new SseParser()
  const blocks = new Map<number, { id: string; name: string; args: string }>()
  let text = ''
  const usage: TokenUsage = {}
  let finishReason: string | undefined

  const handle = (event: SseEvent): void => {
    let json: JsonRecord | null
    try {
      json = asRecord(JSON.parse(event.data))
    } catch {
      return
    }
    if (!json) return
    const type = typeof json['type'] === 'string' ? json['type'] : event.event

    if (type === 'message_start') {
      const message = asRecord(json['message'])
      const u = message ? asRecord(message['usage']) : null
      const input = u?.['input_tokens']
      if (typeof input === 'number') {
        usage.inputTokens = input
        callbacks?.onUsage?.({ ...usage })
      }
      return
    }

    if (type === 'content_block_start') {
      const index = typeof json['index'] === 'number' ? json['index'] : 0
      const block = asRecord(json['content_block'])
      if (block && block['type'] === 'tool_use') {
        blocks.set(index, {
          id: typeof block['id'] === 'string' ? block['id'] : '',
          name: typeof block['name'] === 'string' ? block['name'] : '',
          args: '',
        })
      }
      return
    }

    if (type === 'content_block_delta') {
      const index = typeof json['index'] === 'number' ? json['index'] : 0
      const delta = asRecord(json['delta'])
      if (!delta) return
      if (delta['type'] === 'text_delta' && typeof delta['text'] === 'string') {
        text += delta['text']
        callbacks?.onText?.(delta['text'])
      } else if (delta['type'] === 'input_json_delta' && typeof delta['partial_json'] === 'string') {
        const slot = blocks.get(index)
        if (slot) slot.args += delta['partial_json']
      }
      return
    }

    if (type === 'message_delta') {
      const delta = asRecord(json['delta'])
      if (delta && typeof delta['stop_reason'] === 'string') finishReason = delta['stop_reason']
      const u = asRecord(json['usage'])
      const output = u?.['output_tokens']
      if (typeof output === 'number') {
        usage.outputTokens = output
        callbacks?.onUsage?.({ ...usage })
      }
    }
  }

  for await (const chunk of bodyChunks(response)) {
    for (const event of parser.push(chunk)) handle(event)
  }
  for (const event of parser.flush()) handle(event)

  const toolCalls: ToolCallRequest[] = []
  for (const [, slot] of [...blocks.entries()].sort((a, b) => a[0] - b[0])) {
    const call: ToolCallRequest = {
      id: slot.id || `toolu_${toolCalls.length}`,
      name: slot.name,
      arguments: slot.args,
    }
    if (call.name === '') continue
    toolCalls.push(call)
    callbacks?.onToolCall?.(call)
  }
  return { text, toolCalls, usage, ...(finishReason === undefined ? {} : { finishReason }) }
}

/** 默认 fetch（Node 18+/Electron 均自带）。显式包一层只为统一类型与报错。 */
export const globalFetch: FetchLike = (url, init) =>
  (globalThis.fetch as unknown as FetchLike)(url, init)
