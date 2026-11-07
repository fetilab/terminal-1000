// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * AI 会话编排：消息历史、流式推送、工具调用循环。
 *
 * 这一层的职责是**把护栏接进每一次工具调用**，而不是让模型直接碰命令：
 *   模型请求工具 → 护栏判定（只读/危险/未知）→ 三重上限计数 → 审计 → 执行 → 回填结果
 * 任何一环不通过，回给模型的是"被拒绝/需确认"的文本，命令不会被执行。
 *
 * 安全不变量：
 * - 未开启执行（AiSettings.allowExecution=false）→ 工具只回建议，绝不执行；
 * - 危险/未知命令按护栏决策，默认拒绝或要求人工确认；
 * - 每轮对话前 startRound()，每次执行前 recordCommand()，超限立即 AI_ERROR 并停止；
 * - 每次执行前后各写一条审计。
 */

import { randomUUID } from 'node:crypto'
import type {
  AiProviderConfig,
  AiSettings,
  ChatSession,
  EventName,
  EventPayloads,
  SendResult,
  SessionSummary,
} from '@t1000/shared'
import { Events } from '@t1000/shared'
import type { EventEmitterFn } from '../../ipc/router'
import { AppError } from '../../errors'
import {
  AiGuard,
  AiLimitError,
  AuditLog,
  effectivePolicyFrom,
  planCommandExecution,
  type AuditEntry,
  type EffectivePolicy,
} from './guard'
import {
  createProviderClient,
  parseToolArguments,
  globalFetch,
  type ChatMessage,
  type FetchLike,
  type ProviderClient,
  type ToolCallRequest,
  type ToolSpec,
  type TokenUsage,
} from './providers'

const MAX_CHATS = 100
const MAX_MESSAGES_PER_CHAT = 200
/** 一次用户输入内最多进行多少次"模型 → 工具 → 模型"往返（同时受 guard.maxRounds 约束） */
const MAX_TOOL_ITERATIONS = 8

// 会话/摘要/发送结果等 UI 形状见 `@t1000/shared`（下方再导出）
export type { ChatSession, SendResult, SessionSummary }

export interface ExecOutcome {
  stdout: string
  stderr: string
  code: number
}

export interface ChatDeps {
  /** 读取当前 AI 设置（由上层注入；默认一份保守设置） */
  getSettings?: () => AiSettings
  /** 可用供应商列表与当前选中项 */
  getProvider?: (providerId?: string) => AiProviderConfig | undefined
  listProviders?: () => AiProviderConfig[]
  fetch?: FetchLike
  /** 在已建立会话上执行命令（默认接 session-registry） */
  exec?: (sessionId: string, command: string, options?: { timeoutMs?: number }) => Promise<ExecOutcome>
  /** 列出可用的 SSH 会话 */
  listSessions?: () => SessionSummary[]
  /** 读远端文本文件（默认用 ssh2 sftp 读，带上限） */
  readRemoteFile?: (sessionId: string, path: string, maxBytes?: number) => Promise<string>
  emit: EventEmitterFn
  /** 审计落盘（可选） */
  auditSink?: (entry: AuditEntry) => void
  now?: () => number
}

/** 保守默认：不执行、chat 模式、严格上限 */
const SAFE_DEFAULT_SETTINGS: AiSettings = {
  providers: [],
  mode: 'chat',
  allowExecution: false,
  riskPolicy: { readOnlyAllowlist: [], dangerousDenylist: [], confirmSudo: true },
  limits: { maxRounds: 20, maxCommands: 50, maxTargets: 5 },
}

// ---------------------------------------------------------------------------
// 工具定义
// ---------------------------------------------------------------------------

export const AI_TOOLS: readonly ToolSpec[] = [
  {
    name: 't1000_ssh_list_sessions',
    description: '列出当前已建立、可执行命令的 SSH 会话（返回 sessionId 供其它工具使用）',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 't1000_ssh_exec',
    description: '在一个已建立的 SSH 会话上非交互执行一条命令，返回退出码与输出。只读命令会被直接放行，危险命令会被拒绝或要求确认。',
    parameters: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 't1000_ssh_list_sessions 返回的会话 id' },
        command: { type: 'string', description: '要执行的命令（不要带 sudo）' },
        timeoutMs: { type: 'number', description: '超时毫秒，默认 60000' },
      },
      required: ['sessionId', 'command'],
      additionalProperties: false,
    },
  },
  {
    name: 't1000_ssh_sudo_exec',
    description: '以 sudo 执行一条命令（命令中不要写 sudo）。需要用户显式允许 sudo，且默认还需要人工确认。',
    parameters: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        command: { type: 'string', description: '要提权执行的命令，不要带 sudo 前缀' },
      },
      required: ['sessionId', 'command'],
      additionalProperties: false,
    },
  },
  {
    name: 't1000_ssh_read_file',
    description: '读取远端文本文件内容（有大小上限）',
    parameters: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        path: { type: 'string', description: '远端绝对路径' },
      },
      required: ['sessionId', 'path'],
      additionalProperties: false,
    },
  },
]

/**
 * AI 侧生效策略。
 *
 * sudo 的处理：AI 允许**提出** sudo（工具存在），但是否真的执行由 confirmSudo 决定 ——
 * 默认 confirmSudo=true ⇒ 只回"需要人工确认"，不会自动提权。
 * allowDangerous 恒为 false：AI 永不自动执行黑名单命令（必须人来做）。
 */
export function chatPolicyFrom(settings: AiSettings): EffectivePolicy {
  return { ...effectivePolicyFrom(settings), allowSudo: true, allowDangerous: false }
}

// ---------------------------------------------------------------------------
// 服务
// ---------------------------------------------------------------------------

export class ChatService {
  private readonly chats = new Map<string, ChatSession>()
  private readonly order: string[] = []
  private readonly active = new Map<string, AbortController>()
  private readonly audit: AuditLog
  private readonly deps: ChatDeps

  constructor(deps: ChatDeps) {
    this.deps = deps
    this.audit = new AuditLog(1000, deps.auditSink)
  }

  private settings(): AiSettings {
    return this.deps.getSettings?.() ?? SAFE_DEFAULT_SETTINGS
  }

  listChats(): Array<Pick<ChatSession, 'id' | 'title' | 'createdAt' | 'updatedAt'>> {
    return this.order
      .map((id) => this.chats.get(id))
      .filter((c): c is ChatSession => c !== undefined)
      .map((c) => ({ id: c.id, title: c.title, createdAt: c.createdAt, updatedAt: c.updatedAt }))
  }

  getChat(id: string): ChatSession | undefined {
    const chat = this.chats.get(id)
    // 读取路径就把身份补齐并固化：旧数据第一次读出来是什么 id，之后就一直是什么 id
    if (chat) this.ensureMessageIdentity(chat)
    return chat
  }

  deleteChat(id: string): boolean {
    this.cancel(id)
    const existed = this.chats.delete(id)
    const idx = this.order.indexOf(id)
    if (idx >= 0) this.order.splice(idx, 1)
    return existed
  }

  createChat(title = '新会话'): ChatSession {
    const now = this.timestamp()
    const chat: ChatSession = {
      id: randomUUID(),
      title,
      createdAt: now,
      updatedAt: now,
      messages: [],
      usage: {},
    }
    this.chats.set(chat.id, chat)
    this.order.push(chat.id)
    while (this.order.length > MAX_CHATS) {
      const oldest = this.order.shift()
      if (oldest !== undefined) this.chats.delete(oldest)
    }
    return chat
  }

  /** 运行时替换事件发送器（IPC 上下文可能在服务创建后才就绪） */
  setEmitter(emit: EventEmitterFn): void {
    this.deps.emit = emit
  }

  /** 取消该会话正在进行的请求（abort 会让流式循环尽快退出） */
  cancel(chatId: string): boolean {
    const controller = this.active.get(chatId)
    if (!controller) return false
    controller.abort()
    this.active.delete(chatId)
    return true
  }

  /** 最近审计（供 UI 展示"AI 做过什么"） */
  auditEntries(limit = 100): AuditEntry[] {
    return this.audit.list(limit)
  }

  /**
   * 发送一条用户消息并跑完整个（可能的）工具调用循环。
   * 流式增量与工具事件通过 emit 推送；返回时本轮已结束。
   */
  async send(args: { chatId?: string; text: string; providerId?: string }): Promise<SendResult> {
    const text = args.text?.trim() ?? ''
    if (text === '') throw AppError.badRequest('消息不能为空')

    const settings = this.settings()
    const provider = this.deps.getProvider?.(args.providerId)
    if (!provider) {
      throw AppError.badRequest('未配置 AI 供应商（请在设置中填写 API Key 与模型）')
    }

    // 传了 chatId 却找不到 → 明确报错，不静默新建（否则消息会落到"另一个会话"里）
    let session: ChatSession
    if (args.chatId !== undefined) {
      const existing = this.chats.get(args.chatId)
      if (!existing) throw AppError.notFound(`AI 会话不存在: ${args.chatId}`)
      session = existing
    } else {
      session = this.createChat()
    }
    if (session.title === '新会话' && session.messages.length === 0) {
      session.title = text.slice(0, 40)
    }
    // 追加任何新消息之前，先把历史消息（可能来自旧数据）的派生 id 固化
    this.ensureMessageIdentity(session)

    const controller = new AbortController()
    this.active.set(session.id, controller)

    const policy = chatPolicyFrom(settings)
    const guard = new AiGuard(policy.limits)
    const client = createProviderClient(provider, { fetch: this.deps.fetch ?? globalFetch })

    const userMessage: ChatMessage = {
      id: randomUUID(),
      role: 'user',
      content: text,
      createdAt: this.timestamp(),
    }
    this.pushMessage(session, userMessage)

    // 兜底 id：若一轮都没跑完（立刻被取消），AI_DONE 仍需要一个可引用的 id
    let messageId = randomUUID()
    let answer = ''
    let toolCallCount = 0

    try {
      guard.startRound() // 第 1 轮：决定"要不要用工具"

      for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
        if (controller.signal.aborted) break

        // 每次「模型 → 工具」迭代产出一条**独立的** assistant 消息；
        // 事件里的 messageId 就是这条消息的 id —— UI 才能把流式文本与工具轨迹
        // 挂到正确的消息上（也是渲染层 key={m.id} / toolTraces[m.id] 的依据）。
        messageId = randomUUID()

        const result = await client.streamChat({
          messages: session.messages,
          tools: [...AI_TOOLS],
          mode: settings.mode,
          signal: controller.signal,
          callbacks: {
            onText: (delta) => {
              answer += delta
              this.emit(Events.AI_DELTA, { chatId: session.id, messageId, text: delta })
            },
            onUsage: (usage) => {
              session.usage = { ...session.usage, ...usage }
            },
          },
        })

        this.pushMessage(session, {
          id: messageId,
          role: 'assistant',
          content: result.text,
          createdAt: this.timestamp(),
          ...(result.toolCalls.length > 0 ? { toolCalls: result.toolCalls } : {}),
        })
        if (result.text !== '') answer = result.text === answer ? answer : result.text

        if (result.toolCalls.length === 0) break
        if (controller.signal.aborted) break

        // 逐个执行工具：每个都过护栏 + 上限 + 审计
        for (const call of result.toolCalls) {
          toolCallCount++
          const toolResult = await this.runTool(call, session, guard, policy, messageId)
          this.emit(Events.AI_TOOL_RESULT, {
            chatId: session.id,
            messageId,
            tool: call.name,
            result: toolResult.summary,
            isError: toolResult.isError,
          })
          this.pushMessage(session, {
            id: randomUUID(),
            role: 'tool',
            content: toolResult.content,
            createdAt: this.timestamp(),
            toolCallId: call.id,
            name: call.name,
          })
        }

        guard.startRound() // 下一次模型调用算新一轮
      }

      session.updatedAt = this.timestamp()
      this.emit(Events.AI_DONE, {
        chatId: session.id,
        messageId,
        usage: {
          ...(session.usage.inputTokens === undefined ? {} : { inputTokens: session.usage.inputTokens }),
          ...(session.usage.outputTokens === undefined ? {} : { outputTokens: session.usage.outputTokens }),
        },
      })
      // 把最终回答写进 assistant 消息（模型可能只调工具没回文本，这里保持原样）
      return { chatId: session.id, messageId, text: answer, toolCalls: toolCallCount }
    } catch (err) {
      if (isAbort(err) || controller.signal.aborted) {
        this.emit(Events.AI_DONE, { chatId: session.id, messageId })
        return { chatId: session.id, messageId, text: answer, toolCalls: toolCallCount }
      }
      const message = err instanceof AiLimitError ? err.message : errorMessage(err)
      this.emit(Events.AI_ERROR, { chatId: session.id, message })
      throw err instanceof AppError ? err : AppError.internal(message)
    } finally {
      this.active.delete(session.id)
    }
  }

  // -------------------------------------------------------------------------

  /** 执行一次工具调用：护栏决策 → 上限 → 审计 → 执行 */
  private async runTool(
    call: ToolCallRequest,
    session: ChatSession,
    guard: AiGuard,
    policy: EffectivePolicy,
    messageId: string,
  ): Promise<{ content: string; summary: unknown; isError: boolean }> {
    const args = parseToolArguments(call.arguments)

    if (call.name === 't1000_ssh_list_sessions') {
      const sessions = this.deps.listSessions?.() ?? []
      return {
        // content 给模型（含 host/user），summary 给 UI（只留 id，不把连接信息刷进事件流）
        content: JSON.stringify(sessions),
        summary: { sessions: sessions.length, ids: sessions.map((s) => s.sessionId) },
        isError: false,
      }
    }

    if (call.name === 't1000_ssh_read_file') {
      const sessionId = String(args['sessionId'] ?? '')
      const path = String(args['path'] ?? '')
      if (sessionId === '' || path === '') {
        return { content: '参数不完整：需要 sessionId 与 path', summary: { error: 'bad-args' }, isError: true }
      }
      // 读文件是只读操作：计入命令数与目标数，但不走命令黑名单
      guard.recordCommand(sessionId)
      this.audit.record({
        phase: 'before',
        actor: 'ai-assistant',
        chatId: session.id,
        sessionId,
        target: sessionId,
        command: `read-file ${path}`,
        decision: 'executed',
        risk: 'read-only',
      })
      if (!this.deps.readRemoteFile) {
        return { content: '当前未提供远端文件读取能力', summary: { error: 'unsupported' }, isError: true }
      }
      try {
        const content = await this.deps.readRemoteFile(sessionId, path)
        return { content, summary: { path, bytes: content.length }, isError: false }
      } catch (err) {
        const message = errorMessage(err)
        this.audit.record({
          phase: 'after',
          actor: 'ai-assistant',
          chatId: session.id,
          sessionId,
          command: `read-file ${path}`,
          decision: 'failed',
          risk: 'read-only',
          error: message,
        })
        return { content: `读取失败: ${message}`, summary: { error: message }, isError: true }
      }
    }

    if (call.name !== 't1000_ssh_exec' && call.name !== 't1000_ssh_sudo_exec') {
      return { content: `未知工具: ${call.name}`, summary: { error: 'unknown-tool' }, isError: true }
    }

    const sessionId = String(args['sessionId'] ?? '')
    const rawCommand = String(args['command'] ?? '').trim()
    if (sessionId === '' || rawCommand === '') {
      return { content: '参数不完整：需要 sessionId 与 command', summary: { error: 'bad-args' }, isError: true }
    }

    const command = call.name === 't1000_ssh_sudo_exec' ? `sudo ${rawCommand}` : rawCommand
    const plan = planCommandExecution({ command, policy })

    this.emit(Events.AI_TOOL_CALL, {
      chatId: session.id,
      messageId: session.id,
      tool: call.name,
      args: { sessionId, command: rawCommand },
    })

    // 未开启执行 / chat 模式 / 需确认 / 拒绝：都不执行，把原因回给模型与 UI
    if (plan.action !== 'execute') {
      const decision = plan.action === 'deny' ? 'rejected' : 'suggested'
      this.audit.record({
        phase: 'before',
        actor: 'ai-assistant',
        chatId: session.id,
        sessionId,
        target: sessionId,
        command,
        decision,
        risk: plan.risk,
        reason: plan.reason,
      })
      const prefix =
        plan.action === 'suggest'
          ? '未执行（仅建议）'
          : plan.action === 'confirm'
            ? '未执行（需要人工确认）'
            : '已拒绝'
      return {
        content: `${prefix}：${command}\n原因：${plan.reason}`,
        summary: { decision: plan.action, reason: plan.reason, risk: plan.risk },
        isError: plan.action === 'deny',
      }
    }

    // 上限：超限直接抛 AiLimitError（由 send 转成 AI_ERROR 并停止）
    guard.recordCommand(sessionId)

    const started = this.deps.now?.() ?? Date.now()
    this.audit.record({
      phase: 'before',
      actor: 'ai-assistant',
      chatId: session.id,
      sessionId,
      target: sessionId,
      command,
      decision: 'executed',
      risk: plan.risk,
      reason: plan.reason,
    })

    if (!this.deps.exec) {
      return { content: '当前未提供命令执行能力', summary: { error: 'unsupported' }, isError: true }
    }

    const timeoutMs = numberOr(args['timeoutMs'], 60_000, 600_000)
    try {
      const outcome = await this.deps.exec(sessionId, command, { timeoutMs })
      const durationMs = (this.deps.now?.() ?? Date.now()) - started
      this.audit.record({
        phase: 'after',
        actor: 'ai-assistant',
        chatId: session.id,
        sessionId,
        target: sessionId,
        command,
        decision: 'executed',
        risk: plan.risk,
        exitCode: outcome.code,
        durationMs,
      })
      return {
        content: formatExecOutcome(outcome),
        summary: { exitCode: outcome.code, durationMs },
        // 非零退出码算工具错误，让模型知道要处理
        isError: outcome.code !== 0,
      }
    } catch (err) {
      const message = errorMessage(err)
      this.audit.record({
        phase: 'after',
        actor: 'ai-assistant',
        chatId: session.id,
        sessionId,
        target: sessionId,
        command,
        decision: 'failed',
        risk: plan.risk,
        error: message,
        durationMs: (this.deps.now?.() ?? Date.now()) - started,
      })
      return { content: `执行失败: ${message}`, summary: { error: message }, isError: true }
    }
  }


  /** 统一的时间戳来源（`deps.now` 可注入，便于测试固定时间） */
  private timestamp(): string {
    return new Date(this.deps.now?.() ?? Date.now()).toISOString()
  }

  /**
   * 给历史消息补齐稳定身份（旧数据没有 id/createdAt）。
   *
   * 按 `chatId:序号` 派生并**就地固化**，因此：
   * - 同一会话多次读取得到完全相同的 id（否则 UI 每次刷新 key 都在变，等于没修）；
   * - 之后即使触及消息数上限被裁剪，已固化的 id 也不会漂移。
   */
  private ensureMessageIdentity(chat: ChatSession): void {
    chat.messages.forEach((message, index) => {
      if (typeof message.id !== 'string' || message.id.length === 0) {
        message.id = `${chat.id}:${index}`
      }
      if (typeof message.createdAt !== 'string' || message.createdAt.length === 0) {
        message.createdAt = chat.createdAt
      }
    })
  }

  private pushMessage(session: ChatSession, message: ChatMessage): void {
    // 先把历史消息的派生 id 固化，避免序号随追加/裁剪漂移
    this.ensureMessageIdentity(session)
    // 类型上 id/createdAt 已必填；这里只做运行期兜底（例如将来从存储反序列化）
    if (typeof message.id !== 'string' || message.id.length === 0) message.id = randomUUID()
    if (typeof message.createdAt !== 'string' || message.createdAt.length === 0) {
      message.createdAt = this.timestamp()
    }
    session.messages.push(message)
    if (session.messages.length > MAX_MESSAGES_PER_CHAT) {
      session.messages.splice(0, session.messages.length - MAX_MESSAGES_PER_CHAT)
    }
  }

  private emit<E extends EventName>(event: E, payload: EventPayloads[E]): void {
    this.deps.emit(event, payload)
  }
}

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function isAbort(err: unknown): boolean {
  return err instanceof Error && (err.name === 'AbortError' || /aborted/i.test(err.message))
}

function numberOr(value: unknown, fallback: number, max: number): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.min(Math.floor(n), max)
}

function formatExecOutcome(outcome: ExecOutcome): string {
  const parts = [`exitCode=${outcome.code}`]
  if (outcome.stdout !== '') parts.push(`stdout:\n${truncate(outcome.stdout, 8000)}`)
  if (outcome.stderr !== '') parts.push(`stderr:\n${truncate(outcome.stderr, 4000)}`)
  return parts.join('\n')
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n…（已截断，共 ${text.length} 字符）`
}
