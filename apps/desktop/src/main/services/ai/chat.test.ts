// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 会话编排单测：工具调用循环、护栏接入、三重上限、流式事件、审计。
 * 供应商用**假 fetch + 手写 SSE**，绝不访问外部 AI 服务。
 */

import { describe, expect, it } from 'vitest'
import type { AiProviderConfig, AiSettings, ChatMessage } from '@t1000/shared'
import { Events } from '@t1000/shared'
import type { EventEmitterFn } from '../../ipc/router'
import { ChatService, chatPolicyFrom, type ChatDeps, type SessionSummary } from './chat'
import type { FetchLike, FetchResponseLike } from './providers'

// ---------------------------------------------------------------------------
// 脚手架
// ---------------------------------------------------------------------------

async function* bodyOf(chunks: string[], signal?: AbortSignal): AsyncGenerator<Uint8Array> {
  const encoder = new TextEncoder()
  for (const c of chunks) {
    if (signal?.aborted) return
    yield encoder.encode(c)
  }
}

function res(chunks: string[], signal?: AbortSignal): FetchResponseLike {
  return {
    ok: true,
    status: 200,
    text: async () => '',
    body: bodyOf(chunks, signal),
  }
}

/** 按调用顺序返回预设的流；用完后重复最后一个 */
function scriptedFetch(scripts: string[][], onRequest?: (body: unknown) => void): FetchLike {
  let i = 0
  return async (_url, init) => {
    const chunks = scripts[Math.min(i, scripts.length - 1)] ?? []
    i++
    if (init?.body) onRequest?.(JSON.parse(init.body))
    return res(chunks, init?.signal)
  }
}

function toolCallChunk(id: string, name: string, args: string, index = 0): string {
  return `data: ${JSON.stringify({
    choices: [{ delta: { tool_calls: [{ index, id, function: { name, arguments: args } }] } }],
  })}\n\n`
}

function textChunks(text: string, usage?: Record<string, number>): string[] {
  const out = [`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`]
  if (usage) out.push(`data: ${JSON.stringify({ choices: [], usage })}\n\n`)
  out.push('data: [DONE]\n\n')
  return out
}

interface Emitted {
  event: string
  payload: Record<string, unknown>
}

interface Harness {
  deps: ChatDeps
  events: Emitted[]
  executed: Array<{ sessionId: string; command: string; timeoutMs?: number }>
  eventsOf(event: string): Emitted[]
}

function harness(options: {
  fetch: FetchLike
  settings?: Partial<AiSettings>
  sessions?: SessionSummary[]
  exec?: ChatDeps['exec']
  readRemoteFile?: ChatDeps['readRemoteFile']
  /** 注入时钟：让消息 createdAt 可断言（默认真实时间） */
  now?: () => number
}): Harness {
  const events: Emitted[] = []
  const executed: Harness['executed'] = []
  const emit = ((event: string, payload: Record<string, unknown>) => {
    events.push({ event, payload })
  }) as unknown as EventEmitterFn

  const settings: AiSettings = {
    providers: [],
    mode: 'assistant',
    allowExecution: true,
    riskPolicy: { readOnlyAllowlist: [], dangerousDenylist: [], confirmSudo: true },
    limits: { maxRounds: 10, maxCommands: 10, maxTargets: 5 },
    ...options.settings,
  }
  const provider: AiProviderConfig = {
    id: 'p1',
    name: 'test',
    kind: 'openai',
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'sk-test',
    model: 'm',
  }
  const sessions: SessionSummary[] = options.sessions ?? [
    { sessionId: 's1', host: 'a', username: 'u', connectionId: 'c1' },
  ]

  const deps: ChatDeps = {
    emit,
    fetch: options.fetch,
    getSettings: () => settings,
    getProvider: () => provider,
    listSessions: () => sessions,
    exec:
      options.exec ??
      (async (sessionId, command, opts) => {
        executed.push({ sessionId, command, ...(opts?.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }) })
        return { stdout: 'ok', stderr: '', code: 0 }
      }),
    ...(options.readRemoteFile ? { readRemoteFile: options.readRemoteFile } : {}),
    ...(options.now ? { now: options.now } : {}),
  }
  return { deps, events, executed, eventsOf: (e) => events.filter((x) => x.event === e) }
}

// ---------------------------------------------------------------------------

describe('工具调用循环（正常路径）', () => {
  it('只读命令被放行执行，工具结果回填，最终回答与事件齐全', async () => {
    const fetch = scriptedFetch([
      [toolCallChunk('call_1', 't1000_ssh_exec', '{"sessionId":"s1","command":"df -h"}'), 'data: [DONE]\n\n'],
      textChunks('磁盘使用正常', { prompt_tokens: 10, completion_tokens: 4 }),
    ])
    const h = harness({ fetch })
    const service = new ChatService(h.deps)

    const result = await service.send({ text: '看看磁盘' })

    expect(h.executed).toEqual([{ sessionId: 's1', command: 'df -h', timeoutMs: 60_000 }])
    expect(result.toolCalls).toBe(1)
    expect(result.text).toBe('磁盘使用正常')

    const deltas = h.eventsOf(Events.AI_DELTA)
    expect(deltas.map((d) => d.payload['text'])).toEqual(['磁盘使用正常'])
    expect(h.eventsOf(Events.AI_DONE)).toHaveLength(1)

    const toolResults = h.eventsOf(Events.AI_TOOL_RESULT)
    expect(toolResults).toHaveLength(1)
    expect(toolResults[0]?.payload['tool']).toBe('t1000_ssh_exec')
    expect(toolResults[0]?.payload['isError']).toBe(false)

    const calls = h.eventsOf(Events.AI_TOOL_CALL)
    expect(calls[0]?.payload['args']).toEqual({ sessionId: 's1', command: 'df -h' })
  })

  it('AI_DONE 带上 usage；工具调用后还会再问模型一次', async () => {
    let calls = 0
    const fetch = scriptedFetch(
      [
        [toolCallChunk('c1', 't1000_ssh_list_sessions', '{}'), 'data: [DONE]\n\n'],
        textChunks('有 1 个会话', { prompt_tokens: 1, completion_tokens: 2 }),
      ],
      () => calls++,
    )
    const h = harness({ fetch })
    const service = new ChatService(h.deps)
    await service.send({ text: '有哪些会话' })

    expect(calls).toBe(2)
    const done = h.eventsOf(Events.AI_DONE)[0]?.payload['usage'] as Record<string, number>
    expect(done).toEqual({ inputTokens: 1, outputTokens: 2 })

    const result = h.eventsOf(Events.AI_TOOL_RESULT)[0]?.payload['result']
    expect(JSON.stringify(result)).toContain('s1')
  })

  it('非零退出码标记为工具错误，但仍会把结果回给模型', async () => {
    const fetch = scriptedFetch([
      [toolCallChunk('c1', 't1000_ssh_exec', '{"sessionId":"s1","command":"cat /nope"}'), 'data: [DONE]\n\n'],
      textChunks('文件不存在'),
    ])
    const h = harness({
      fetch,
      exec: async () => ({ stdout: '', stderr: 'No such file', code: 1 }),
    })
    const service = new ChatService(h.deps)
    await service.send({ text: '读文件' })
    expect(h.eventsOf(Events.AI_TOOL_RESULT)[0]?.payload['isError']).toBe(true)
  })
})

describe('★ 护栏接入（最重要）', () => {
  it('allowExecution=false → 只给建议，绝不执行', async () => {
    const fetch = scriptedFetch([
      [toolCallChunk('c1', 't1000_ssh_exec', '{"sessionId":"s1","command":"ls -la"}'), 'data: [DONE]\n\n'],
      textChunks('建议你执行 ls -la'),
    ])
    const h = harness({ fetch, settings: { allowExecution: false, mode: 'assistant' } })
    const service = new ChatService(h.deps)

    await service.send({ text: '列一下' })

    expect(h.executed).toHaveLength(0)
    const tr = h.eventsOf(Events.AI_TOOL_RESULT)[0]
    expect(tr?.payload['isError']).toBe(false)
    expect(String(JSON.stringify(tr?.payload['result']))).toContain('suggest')
  })

  it('危险命令（rm -rf）被拒绝，且不执行', async () => {
    const fetch = scriptedFetch([
      [toolCallChunk('c1', 't1000_ssh_exec', '{"sessionId":"s1","command":"rm -rf /var/log"}'), 'data: [DONE]\n\n'],
      textChunks('已拒绝'),
    ])
    const h = harness({ fetch })
    const service = new ChatService(h.deps)

    await service.send({ text: '清日志' })

    expect(h.executed).toHaveLength(0)
    const tr = h.eventsOf(Events.AI_TOOL_RESULT)[0]
    expect(tr?.payload['isError']).toBe(true)
    expect(String(JSON.stringify(tr?.payload['result']))).toContain('deny')
  })

  it('未在白名单的未知命令（mkdir）不自动执行，要求确认', async () => {
    const fetch = scriptedFetch([
      [toolCallChunk('c1', 't1000_ssh_exec', '{"sessionId":"s1","command":"mkdir /tmp/x"}'), 'data: [DONE]\n\n'],
      textChunks('ok'),
    ])
    const h = harness({ fetch })
    await new ChatService(h.deps).send({ text: '建目录' })

    expect(h.executed).toHaveLength(0)
    expect(String(JSON.stringify(h.eventsOf(Events.AI_TOOL_RESULT)[0]?.payload['result']))).toContain('confirm')
  })

  it('sudo 默认需要确认 → 不执行；confirmSudo=false 且 assistant 时才执行', async () => {
    const sudoCall = [
      [toolCallChunk('c1', 't1000_ssh_sudo_exec', '{"sessionId":"s1","command":"systemctl status nginx"}'), 'data: [DONE]\n\n'],
      textChunks('done'),
    ]

    const strict = harness({ fetch: scriptedFetch(sudoCall) })
    await new ChatService(strict.deps).send({ text: '看服务' })
    expect(strict.executed).toHaveLength(0)
    expect(String(JSON.stringify(strict.eventsOf(Events.AI_TOOL_RESULT)[0]?.payload['result']))).toContain('confirm')

    const open = harness({
      fetch: scriptedFetch(sudoCall),
      settings: { riskPolicy: { readOnlyAllowlist: [], dangerousDenylist: [], confirmSudo: false } },
    })
    await new ChatService(open.deps).send({ text: '看服务' })
    expect(open.executed[0]?.command).toBe('sudo systemctl status nginx')
  })

  it('chat 模式永不执行', async () => {
    const fetch = scriptedFetch([
      [toolCallChunk('c1', 't1000_ssh_exec', '{"sessionId":"s1","command":"df -h"}'), 'data: [DONE]\n\n'],
      textChunks('建议'),
    ])
    const h = harness({ fetch, settings: { mode: 'chat' } })
    await new ChatService(h.deps).send({ text: '看看' })
    expect(h.executed).toHaveLength(0)
  })

  it('chatPolicyFrom 恒不放开黑名单（AI 不自动执行危险命令）', () => {
    const policy = chatPolicyFrom({
      providers: [],
      mode: 'assistant',
      allowExecution: true,
      riskPolicy: { readOnlyAllowlist: [], dangerousDenylist: [], confirmSudo: false },
      limits: { maxRounds: 5, maxCommands: 5, maxTargets: 5 },
    })
    expect(policy.allowDangerous).toBe(false)
    expect(policy.allowSudo).toBe(true)
  })
})

describe('三重上限', () => {
  it('命令数超限 → 发 AI_ERROR 并停止（不再执行第二条）', async () => {
    const fetch = scriptedFetch([
      [
        toolCallChunk('c1', 't1000_ssh_exec', '{"sessionId":"s1","command":"df -h"}', 0),
        toolCallChunk('c2', 't1000_ssh_exec', '{"sessionId":"s1","command":"uptime"}', 1),
        'data: [DONE]\n\n',
      ],
      textChunks('done'),
    ])
    const h = harness({ fetch, settings: { limits: { maxRounds: 10, maxCommands: 1, maxTargets: 5 } } })
    const service = new ChatService(h.deps)

    await expect(service.send({ text: '跑两条' })).rejects.toThrow(/命令数上限/)
    expect(h.executed).toHaveLength(1)
    const errors = h.eventsOf(Events.AI_ERROR)
    expect(errors).toHaveLength(1)
    expect(String(errors[0]?.payload['message'])).toContain('命令数上限')
  })

  it('目标数超限 → AI_ERROR 并停止', async () => {
    const fetch = scriptedFetch([
      [
        toolCallChunk('c1', 't1000_ssh_exec', '{"sessionId":"s1","command":"df -h"}', 0),
        toolCallChunk('c2', 't1000_ssh_exec', '{"sessionId":"s2","command":"df -h"}', 1),
        'data: [DONE]\n\n',
      ],
      textChunks('done'),
    ])
    const h = harness({
      fetch,
      settings: { limits: { maxRounds: 10, maxCommands: 10, maxTargets: 1 } },
      sessions: [
        { sessionId: 's1', host: 'a', username: 'u', connectionId: 'c1' },
        { sessionId: 's2', host: 'b', username: 'u', connectionId: 'c2' },
      ],
    })
    await expect(new ChatService(h.deps).send({ text: '两台都跑' })).rejects.toThrow(/主机数上限/)
    expect(h.executed).toHaveLength(1)
    expect(String(h.eventsOf(Events.AI_ERROR)[0]?.payload['message'])).toContain('主机数上限')
  })

  it('轮数超限 → AI_ERROR 并停止', async () => {
    // 每次都请求工具，永不收敛；maxRounds=2 时第 3 轮开始就抛
    const loops = Array.from({ length: 6 }, () => [
      toolCallChunk('c', 't1000_ssh_list_sessions', '{}'),
      'data: [DONE]\n\n',
    ])
    const h = harness({ fetch: scriptedFetch(loops), settings: { limits: { maxRounds: 2, maxCommands: 50, maxTargets: 5 } } })
    await expect(new ChatService(h.deps).send({ text: '循环' })).rejects.toThrow(/轮数上限/)
    expect(String(h.eventsOf(Events.AI_ERROR)[0]?.payload['message'])).toContain('轮数上限')
  })
})

describe('会话与取消', () => {
  it('未指定 chatId 时自动建会话，标题取首条消息', async () => {
    const h = harness({ fetch: scriptedFetch([textChunks('你好')]) })
    const service = new ChatService(h.deps)
    const result = await service.send({ text: '帮我看看服务器状态' })

    const chat = service.getChat(result.chatId)
    expect(chat?.title).toBe('帮我看看服务器状态')
    expect(chat?.messages.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(service.listChats()).toHaveLength(1)
    expect(service.deleteChat(result.chatId)).toBe(true)
    expect(service.listChats()).toHaveLength(0)
  })

  it('chatId 不存在时报 NOT_FOUND，不静默新建', async () => {
    const h = harness({ fetch: scriptedFetch([textChunks('x')]) })
    await expect(new ChatService(h.deps).send({ chatId: 'nope', text: 'hi' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
  })

  it('cancel 中断流式请求：send 正常返回并收尾 AI_DONE', async () => {
    // 一个"永不结束"的流：每次产出一点，直到 signal 被 abort
    const fetch: FetchLike = async (_url, init) => ({
      ok: true,
      status: 200,
      text: async () => '',
      body: (async function* () {
        const encoder = new TextEncoder()
        for (let i = 0; i < 200; i++) {
          if (init?.signal?.aborted) return
          yield encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: '.' } }] })}\n\n`)
          await new Promise((r) => setTimeout(r, 2))
        }
      })(),
    })
    const h = harness({ fetch })
    const service = new ChatService(h.deps)

    const sending = service.send({ text: '一直说' })
    // 等到开始产出后再取消
    await new Promise((r) => setTimeout(r, 30))
    const chatId = service.listChats()[0]?.id
    expect(chatId).toBeDefined()
    expect(service.cancel(chatId!)).toBe(true)

    const result = await sending
    expect(result.text.length).toBeGreaterThan(0)
    expect(h.eventsOf(Events.AI_DONE)).toHaveLength(1)
    expect(h.eventsOf(Events.AI_ERROR)).toHaveLength(0)
  })

  it('未配置供应商时报 BAD_REQUEST', async () => {
    const h = harness({ fetch: scriptedFetch([textChunks('x')]) })
    const deps: ChatDeps = { ...h.deps, getProvider: () => undefined }
    await expect(new ChatService(deps).send({ text: 'hi' })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })
})

describe('审计', () => {
  it('执行的命令留下 before/after 两条记录；被拒的留下 rejected', async () => {
    const fetch = scriptedFetch([
      [toolCallChunk('c1', 't1000_ssh_exec', '{"sessionId":"s1","command":"df -h"}'), 'data: [DONE]\n\n'],
      [toolCallChunk('c2', 't1000_ssh_exec', '{"sessionId":"s1","command":"rm -rf /tmp/x"}'), 'data: [DONE]\n\n'],
      textChunks('done'),
    ])
    const h = harness({ fetch })
    const service = new ChatService(h.deps)
    await service.send({ text: '先看再删' })

    const entries = service.auditEntries()
    const executed = entries.filter((e) => e.decision === 'executed')
    expect(executed.map((e) => e.phase)).toEqual(['before', 'after'])
    expect(executed[0]?.command).toBe('df -h')
    expect(entries.some((e) => e.decision === 'rejected' && e.command.includes('rm -rf'))).toBe(true)
    // 审计里带上会话与目标，便于追责
    expect(executed[0]?.sessionId).toBe('s1')
    expect(executed[0]?.actor).toBe('ai-assistant')
  })
})

describe('读远端文件工具', () => {
  it('读出内容并计入用量；缺参数时报错', async () => {
    const fetch = scriptedFetch([
      [toolCallChunk('c1', 't1000_ssh_read_file', '{"sessionId":"s1","path":"/etc/hostname"}'), 'data: [DONE]\n\n'],
      textChunks('读到了'),
    ])
    const h = harness({ fetch, readRemoteFile: async () => 'myhost\n' })
    await new ChatService(h.deps).send({ text: '读 hostname' })

    const tr = h.eventsOf(Events.AI_TOOL_RESULT)[0]
    expect(tr?.payload['isError']).toBe(false)
    expect(String(JSON.stringify(tr?.payload['result']))).toContain('/etc/hostname')

    const bad = harness({ fetch: scriptedFetch([
      [toolCallChunk('c1', 't1000_ssh_read_file', '{"sessionId":"s1"}'), 'data: [DONE]\n\n'],
      textChunks('x'),
    ]) })
    await new ChatService(bad.deps).send({ text: '缺 path' })
    expect(bad.eventsOf(Events.AI_TOOL_RESULT)[0]?.payload['isError']).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 消息的稳定身份（task-15）：渲染层 key={m.id} 与 toolTraces[m.id] 依赖它
// ---------------------------------------------------------------------------

const FIXED_MS = 1_760_000_000_000
const FIXED_ISO = new Date(FIXED_MS).toISOString()

describe('消息的稳定身份（id / createdAt）', () => {
  it('追加的消息都有唯一 id 与 createdAt', async () => {
    const h = harness({ fetch: scriptedFetch([textChunks('好的')]), now: () => FIXED_MS })
    const service = new ChatService(h.deps)
    const result = await service.send({ text: '第一条' })

    const chat = service.getChat(result.chatId)
    expect(chat?.messages.map((m) => m.role)).toEqual(['user', 'assistant'])

    const ids = chat?.messages.map((m) => m.id) ?? []
    expect(ids.every((id) => typeof id === 'string' && id.length > 0)).toBe(true)
    expect(new Set(ids).size).toBe(ids.length) // 唯一
    expect(chat?.messages.every((m) => m.createdAt === FIXED_ISO)).toBe(true)
  })

  it('assistant 消息的 id 就是本次 send 的 messageId（工具轨迹能挂上）', async () => {
    const h = harness({ fetch: scriptedFetch([textChunks('答案')]) })
    const service = new ChatService(h.deps)
    const result = await service.send({ text: 'q' })

    const assistant = service.getChat(result.chatId)?.messages.find((m) => m.role === 'assistant')
    expect(assistant?.id).toBe(result.messageId)
    // 事件里的 messageId 与落库消息一致，UI 才能把流式内容挂到同一条消息上
    expect(h.eventsOf(Events.AI_DONE)[0]?.payload['messageId']).toBe(result.messageId)
  })

  it('★ 多次读取同一会话，消息 id 完全一致（刷新不换身份）', async () => {
    const h = harness({ fetch: scriptedFetch([textChunks('hi')]) })
    const service = new ChatService(h.deps)
    const { chatId } = await service.send({ text: 'hello' })

    const first = service.getChat(chatId)?.messages.map((m) => m.id)
    const second = service.getChat(chatId)?.messages.map((m) => m.id)
    const third = service.getChat(chatId)?.messages.map((m) => m.id)

    expect(first).toBeDefined()
    expect(second).toEqual(first)
    expect(third).toEqual(first)
  })

  it('旧数据缺 id/createdAt：读取时派生 chatId:序号，且多次读取一致', () => {
    const h = harness({ fetch: scriptedFetch([textChunks('x')]) })
    const service = new ChatService(h.deps)
    const chat = service.createChat('旧会话')

    // 模拟从旧持久化数据反序列化出来的消息（没有 id/createdAt）
    chat.messages.push(
      { role: 'user', content: '旧问题' } as unknown as ChatMessage,
      { role: 'assistant', content: '旧回答' } as unknown as ChatMessage,
    )

    const expectedIds = [`${chat.id}:0`, `${chat.id}:1`]
    const first = service.getChat(chat.id)?.messages
    expect(first?.map((m) => m.id)).toEqual(expectedIds)
    expect(first?.every((m) => m.createdAt === chat.createdAt)).toBe(true)

    // 核心防线：再读两次必须一模一样（否则每次刷新 key 都在变）
    expect(service.getChat(chat.id)?.messages.map((m) => m.id)).toEqual(expectedIds)
    expect(service.getChat(chat.id)?.messages.map((m) => m.id)).toEqual(expectedIds)
  })

  it('派生 id 在随后追加新消息后不漂移（先固化再追加）', async () => {
    const h = harness({ fetch: scriptedFetch([textChunks('新回答')]) })
    const service = new ChatService(h.deps)
    const chat = service.createChat('旧会话')
    chat.messages.push({ role: 'user', content: '旧问题' } as unknown as ChatMessage)

    // 先读一次把派生 id 固化
    expect(service.getChat(chat.id)?.messages[0]?.id).toBe(`${chat.id}:0`)

    await service.send({ chatId: chat.id, text: '新问题' })

    const messages = service.getChat(chat.id)?.messages ?? []
    expect(messages[0]?.id).toBe(`${chat.id}:0`) // 旧消息身份不变
    const ids = messages.map((m) => m.id)
    expect(new Set(ids).size).toBe(ids.length) // 新消息仍是唯一 id
    expect(messages.slice(1).every((m) => !m.id.startsWith(`${chat.id}:`))).toBe(true)
  })
})
