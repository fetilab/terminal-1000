// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * AI 助手状态（**独立 store，流式增量不进全局 store**）。
 *
 * 与终端里 SSH_DATA 的处理同一条原则：AI_DELTA 是逐 token 的高频事件，
 * 一旦进全局 store，每个 token 都会让整个界面参与一次状态比对。
 * 这里只让 AI 面板订阅，其余视图完全不受影响。
 *
 * `apiKey` 永不出主进程：`listProviders` 只回掩码/是否存在，UI 不尝试读明文。
 *
 * ⚠️ ChatSession / ChatMessage / PublicProvider 目前只定义在主进程
 * （`services/ai/chat.ts` / `providers.ts`），shared 里没有，故镜像于此，
 * 已在反馈中提出上移（同 PingResult / GroupTreeNode / RemoteEntry）。
 */

import { useCallback, useRef, useSyncExternalStore } from 'react'
import { Events } from '@t1000/shared'
import { invoke, subscribe } from '../../lib/ipc'
import { errorText } from '../../lib/format'

/* ── 类型镜像 ─────────────────────────────────── */

export interface ToolCallRecord {
  id: string
  name: string
  arguments?: unknown
}

export interface ChatMessage {
  id: string
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  toolCallId?: string
  toolCalls?: ToolCallRecord[]
  createdAt?: string
}

export interface ChatSession {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  messages: ChatMessage[]
  usage?: { inputTokens?: number; outputTokens?: number }
}

export interface ChatSummary {
  id: string
  title: string
  updatedAt: string
  messageCount?: number
}

export interface PublicProvider {
  id: string
  name: string
  kind: 'openai' | 'anthropic'
  baseUrl: string
  model: string
  hasApiKey: boolean
}

export interface SendResult {
  chatId: string
  messageId: string
  text: string
  toolCalls: number
}

/** 工具调用在 UI 上的呈现（把 AI_TOOL_CALL / AI_TOOL_RESULT 配成对） */
export interface ToolTrace {
  id: string
  tool: string
  args: unknown
  result?: unknown
  isError?: boolean
  done: boolean
}

/* ── store ────────────────────────────────────── */

interface AiState {
  chats: ChatSummary[]
  activeChatId: string | null
  messages: ChatMessage[]
  providers: PublicProvider[]
  activeProviderId: string | null
  /** 正在流式接收的助手消息 id */
  streamingId: string | null
  /** 流式文本缓冲：只在本 store 内累积，不逐 token 触发全局状态 */
  streamingText: string
  /** 按 messageId 归集的工具调用轨迹 */
  toolTraces: Record<string, ToolTrace[]>
  sending: boolean
  error: string | null
}

let state: AiState = {
  chats: [],
  activeChatId: null,
  messages: [],
  providers: [],
  activeProviderId: null,
  streamingId: null,
  streamingText: '',
  toolTraces: {},
  sending: false,
  error: null,
}

const listeners = new Set<() => void>()

function emit(): void {
  for (const l of listeners) l()
}

function set(patch: Partial<AiState>): void {
  state = { ...state, ...patch }
  emit()
}

function subscribeStore(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function snapshot(): AiState {
  return state
}

/**
 * 订阅 AI 状态切片。
 *
 * ⚠️ 必须做快照缓存：`useSyncExternalStore` 要求 getSnapshot 在状态未变时
 * 返回**同一个引用**。如果选择器返回新对象（`s => ({a: s.a, b: s.b})`），
 * 每次调用都是新引用 → React 判定"状态一直在变" → 无限重渲染直至整棵树崩掉
 * （表现出来是整个界面变空白）。这与 lib/store 里 useStore 的做法一致。
 */
export function useAi<S>(
  selector: (s: AiState) => S,
  isEqual: (a: S, b: S) => boolean = Object.is,
): S {
  const cache = useRef<{ state: AiState; value: S } | null>(null)
  const selectorRef = useRef(selector)
  const equalRef = useRef(isEqual)
  selectorRef.current = selector
  equalRef.current = isEqual

  const getSnapshot = useCallback(() => {
    const current = snapshot()
    const cached = cache.current
    if (cached && cached.state === current) return cached.value
    const value = selectorRef.current(current)
    if (cached && equalRef.current(cached.value, value)) {
      cache.current = { state: current, value: cached.value }
      return cached.value
    }
    cache.current = { state: current, value }
    return value
  }, [])

  return useSyncExternalStore(subscribeStore, getSnapshot, getSnapshot)
}

export function aiState(): AiState {
  return state
}

/* ── 数据加载 ─────────────────────────────────── */

export async function loadChats(): Promise<void> {
  try {
    const chats = await invoke<'ai', 'listChats', Record<string, never>, ChatSummary[]>(
      'ai',
      'listChats',
      {},
    )
    set({ chats: Array.isArray(chats) ? chats : [], error: null })
  } catch (err) {
    set({ error: errorText(err) })
  }
}

export async function loadProviders(): Promise<void> {
  try {
    const res = await invoke<'ai', 'listProviders', Record<string, never>, { providers: PublicProvider[] }>(
      'ai',
      'listProviders',
      {},
    )
    set({ providers: res?.providers ?? [] })
  } catch {
    set({ providers: [] })
  }
}

export async function openChat(chatId: string): Promise<void> {
  try {
    const chat = await invoke<'ai', 'getChat', { chatId: string }, ChatSession>('ai', 'getChat', {
      chatId,
    })
    set({
      activeChatId: chat.id,
      messages: chat.messages ?? [],
      streamingId: null,
      streamingText: '',
      toolTraces: {},
      error: null,
    })
  } catch (err) {
    set({ error: errorText(err) })
  }
}

export function startNewChat(): void {
  set({
    activeChatId: null,
    messages: [],
    streamingId: null,
    streamingText: '',
    toolTraces: {},
    error: null,
  })
}

export async function deleteChat(chatId: string): Promise<void> {
  try {
    await invoke<'ai', 'deleteChat', { chatId: string }, unknown>('ai', 'deleteChat', { chatId })
    if (state.activeChatId === chatId) startNewChat()
    await loadChats()
  } catch (err) {
    set({ error: errorText(err) })
  }
}

export async function setProvider(providerId: string): Promise<void> {
  try {
    await invoke<'ai', 'setProvider', { providerId: string }, unknown>('ai', 'setProvider', {
      providerId,
    })
    set({ activeProviderId: providerId })
  } catch (err) {
    set({ error: errorText(err) })
  }
}

/**
 * 发送一条消息。
 *
 * 先把用户消息乐观插入列表，助手回复通过事件流式追加；
 * `send` 本身是等到整轮结束才 resolve 的，所以 UI 不能等它。
 */
export async function sendMessage(text: string): Promise<void> {
  const trimmed = text.trim()
  if (!trimmed || state.sending) return

  const localUserId = `local-user-${Date.now()}`
  set({
    messages: [
      ...state.messages,
      { id: localUserId, role: 'user', content: trimmed, createdAt: new Date().toISOString() },
    ],
    sending: true,
    error: null,
  })

  try {
    const payload: Record<string, unknown> = { text: trimmed }
    if (state.activeChatId) payload.chatId = state.activeChatId
    const res = await invoke<'ai', 'send', Record<string, unknown>, SendResult>('ai', 'send', payload)

    // send 返回时整轮已结束；把流式缓冲收尾成正式消息
    set({
      activeChatId: res.chatId,
      sending: false,
      streamingId: null,
      streamingText: '',
      messages: [
        ...state.messages.filter((m) => m.id !== res.messageId),
        { id: res.messageId, role: 'assistant', content: res.text, createdAt: new Date().toISOString() },
      ],
    })
    await loadChats()
  } catch (err) {
    set({ sending: false, streamingId: null, error: errorText(err) })
  }
}

export async function cancelSend(): Promise<void> {
  if (!state.activeChatId) return
  try {
    await invoke<'ai', 'cancel', { chatId: string }, unknown>('ai', 'cancel', {
      chatId: state.activeChatId,
    })
  } catch {
    /* 取消失败不阻塞 UI */
  }
}

/* ── 事件接线 ─────────────────────────────────── */

let wired = false

export function wireAiEvents(): void {
  if (wired) return
  wired = true

  subscribe(Events.AI_DELTA, (p) => {
    // 只累积文本，不把每个 token 变成一次全局状态变更
    set({ streamingId: p.messageId, streamingText: state.streamingText + p.text })
  })

  subscribe(Events.AI_TOOL_CALL, (p) => {
    const list = state.toolTraces[p.messageId] ?? []
    set({
      toolTraces: {
        ...state.toolTraces,
        [p.messageId]: [...list, { id: `${p.tool}-${list.length}`, tool: p.tool, args: p.args, done: false }],
      },
    })
  })

  subscribe(Events.AI_TOOL_RESULT, (p) => {
    const list = state.toolTraces[p.messageId] ?? []
    // 配对：取最后一条同名且未完成的调用
    let idx = -1
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const item = list[i]
      if (item && item.tool === p.tool && !item.done) {
        idx = i
        break
      }
    }
    const next = list.slice()
    if (idx >= 0) {
      const cur = next[idx]
      if (cur) next[idx] = { ...cur, result: p.result, isError: p.isError === true, done: true }
    } else {
      next.push({
        id: `${p.tool}-${list.length}`,
        tool: p.tool,
        args: undefined,
        result: p.result,
        isError: p.isError === true,
        done: true,
      })
    }
    set({ toolTraces: { ...state.toolTraces, [p.messageId]: next } })
  })

  subscribe(Events.AI_DONE, (p) => {
    const text = state.streamingText
    set({
      streamingId: null,
      streamingText: '',
      sending: false,
      messages: [
        ...state.messages.filter((m) => m.id !== p.messageId),
        { id: p.messageId, role: 'assistant', content: text, createdAt: new Date().toISOString() },
      ],
    })
  })

  subscribe(Events.AI_ERROR, (p) => {
    set({ sending: false, streamingId: null, streamingText: '', error: p.message })
  })
}
