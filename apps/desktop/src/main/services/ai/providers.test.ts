// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * provider 单测：SSE 增量解析（含跨 chunk 截断）、OpenAI/Anthropic 流式组装、
 * 错误映射、请求体构造。
 *
 * **全部使用注入的假 fetch**，绝不访问任何外部 AI 服务。
 */

import { describe, expect, it } from 'vitest'
import type { AiProviderConfig } from '@t1000/shared'
import {
  SseParser,
  buildAnthropicBody,
  buildOpenAiBody,
  createProviderClient,
  parseToolArguments,
  resolveEndpoint,
  type FetchLike,
  type FetchResponseLike,
} from './providers'

// ---------------------------------------------------------------------------
// 脚手架
// ---------------------------------------------------------------------------

async function* iterate(chunks: string[]): AsyncGenerator<Uint8Array> {
  const encoder = new TextEncoder()
  for (const c of chunks) yield encoder.encode(c)
}

function response(chunks: string[], init: { ok?: boolean; status?: number; text?: string } = {}): FetchResponseLike {
  const ok = init.ok ?? true
  return {
    ok,
    status: init.status ?? (ok ? 200 : 500),
    statusText: ok ? 'OK' : 'Error',
    text: async () => init.text ?? '',
    body: iterate(chunks),
  }
}

function config(patch: Partial<AiProviderConfig> = {}): AiProviderConfig {
  return {
    id: 'p1',
    name: '本地测试',
    kind: 'openai',
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'sk-test',
    model: 'test-model',
    ...patch,
  }
}

function fetchReturning(res: FetchResponseLike, onCall?: (url: string, body: unknown) => void): FetchLike {
  return async (url, init) => {
    onCall?.(url, init?.body ? JSON.parse(init.body) : undefined)
    return res
  }
}

// ---------------------------------------------------------------------------

describe('SseParser（跨 chunk 截断是重点）', () => {
  it('按空行切分事件', () => {
    const p = new SseParser()
    const events = p.push('data: a\n\ndata: b\n\n')
    expect(events.map((e) => e.data)).toEqual(['a', 'b'])
  })

  it('一行被拆到两个 chunk 时不丢不炸', () => {
    const p = new SseParser()
    expect(p.push('data: hel')).toEqual([])
    expect(p.push('lo wor')).toEqual([])
    const events = p.push('ld\n\n')
    expect(events).toEqual([{ data: 'hello world' }])
  })

  it('JSON 帧被拆成三段也能拼回完整事件', () => {
    const p = new SseParser()
    const full = 'data: {"choices":[{"delta":{"content":"你好"}}]}\n\n'
    expect(p.push(full.slice(0, 10))).toEqual([])
    expect(p.push(full.slice(10, 25))).toEqual([])
    const events = p.push(full.slice(25))
    expect(events.length).toBe(1)
    expect(JSON.parse(events[0]!.data)).toMatchObject({ choices: [{ delta: { content: '你好' } }] })
  })

  it('支持 event: 字段、CRLF 与多行 data', () => {
    const p = new SseParser()
    const events = p.push('event: content_block_delta\r\ndata: {"a":1}\r\ndata: {"b":2}\r\n\r\n')
    expect(events).toEqual([{ event: 'content_block_delta', data: '{"a":1}\n{"b":2}' }])
  })

  it('忽略注释/心跳行', () => {
    const p = new SseParser()
    const events = p.push(': ping\n\ndata: real\n\n')
    expect(events.map((e) => e.data)).toEqual(['real'])
  })

  it('flush 吐出没有空行结尾的尾帧', () => {
    const p = new SseParser()
    expect(p.push('data: tail-without-blank')).toEqual([])
    expect(p.flush()).toEqual([{ data: 'tail-without-blank' }])
    expect(p.flush()).toEqual([])
  })
})

describe('OpenAI 兼容流', () => {
  it('增量文本 + 跨 chunk 的工具调用参数都能拼全', async () => {
    // tool_calls.arguments 被拆成三段，且拆点落在 JSON 中间
    const chunks = [
      'data: {"choices":[{"delta":{"content":"正在"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"检查"}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"t1000_ssh_exec"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"argument',
      's":"{\\"sessionId\\":\\"s1\\",\\"com',
      'mand\\":\\"df -h\\"}"}}]}}]}\n\n',
      'data: {"choices":[{"finish_reason":"tool_calls"}]}\n\n',
      'data: [DONE]\n\n',
    ]
    const textDeltas: string[] = []
    const client = createProviderClient(config(), { fetch: fetchReturning(response(chunks)) })

    const result = await client.streamChat({
      messages: [{ role: 'user', content: '看看磁盘' }],
      callbacks: { onText: (t) => textDeltas.push(t) },
    })

    expect(result.text).toBe('正在检查')
    expect(textDeltas).toEqual(['正在', '检查'])
    expect(result.toolCalls).toHaveLength(1)
    expect(result.toolCalls[0]).toMatchObject({ id: 'call_1', name: 't1000_ssh_exec' })
    expect(parseToolArguments(result.toolCalls[0]!.arguments)).toEqual({
      sessionId: 's1',
      command: 'df -h',
    })
    expect(result.finishReason).toBe('tool_calls')
  })

  it('解析 usage 并回调', async () => {
    const chunks = [
      'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
      'data: {"choices":[],"usage":{"prompt_tokens":11,"completion_tokens":5}}\n\n',
      'data: [DONE]\n\n',
    ]
    const usages: Array<{ inputTokens?: number }> = []
    const client = createProviderClient(config(), { fetch: fetchReturning(response(chunks)) })
    const result = await client.streamChat({
      messages: [{ role: 'user', content: 'hi' }],
      callbacks: { onUsage: (u) => usages.push(u) },
    })
    expect(result.usage).toEqual({ inputTokens: 11, outputTokens: 5 })
    expect(usages.at(-1)?.['inputTokens']).toBe(11)
  })

  it('非 JSON 帧（心跳）被忽略而不抛错', async () => {
    const chunks = ['data: not-json\n\n', 'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n', 'data: [DONE]\n\n']
    const client = createProviderClient(config(), { fetch: fetchReturning(response(chunks)) })
    const result = await client.streamChat({ messages: [{ role: 'user', content: 'x' }] })
    expect(result.text).toBe('ok')
  })

  it('请求体带 tools/tool_choice 且 assistant 工具调用被正确回填', async () => {
    let seen: Record<string, unknown> | undefined
    const client = createProviderClient(config(), {
      fetch: fetchReturning(response(['data: [DONE]\n\n']), (_url, body) => {
        seen = body as Record<string, unknown>
      }),
    })
    await client.streamChat({
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'u' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'c1', name: 't', arguments: '{"a":1}' }],
        },
        { role: 'tool', content: '结果', toolCallId: 'c1' },
      ],
      tools: [{ name: 't', description: 'd', parameters: { type: 'object' } }],
    })

    expect(seen?.['stream']).toBe(true)
    expect(seen?.['model']).toBe('test-model')
    const messages = seen?.['messages'] as Array<Record<string, unknown>>
    expect(messages[3]).toMatchObject({ role: 'tool', tool_call_id: 'c1', content: '结果' })
    expect(messages[2]?.['tool_calls']).toEqual([
      { id: 'c1', type: 'function', function: { name: 't', arguments: '{"a":1}' } },
    ])
    expect(seen?.['tool_choice']).toBe('auto')
  })
})

describe('Anthropic 流', () => {
  it('文本增量 + tool_use 分片参数 + usage 都能解析', async () => {
    const chunks = [
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":9}}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"查一下"}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_1","name":"t1000_ssh_exec"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"command\\":\\"upt"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"ime\\"}"}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":7}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ]
    const client = createProviderClient(config({ kind: 'anthropic', baseUrl: 'https://api.anthropic.com' }), {
      fetch: fetchReturning(response(chunks)),
    })

    const result = await client.streamChat({ messages: [{ role: 'user', content: 'uptime' }] })
    expect(result.text).toBe('查一下')
    expect(result.toolCalls).toEqual([
      { id: 'toolu_1', name: 't1000_ssh_exec', arguments: '{"command":"uptime"}' },
    ])
    expect(result.usage).toEqual({ inputTokens: 9, outputTokens: 7 })
    expect(result.finishReason).toBe('tool_use')
  })

  it('Anthropic 请求体把 system 单独抽出，tool_result 包成 user content', () => {
    const body = buildAnthropicBody(
      config({ kind: 'anthropic' }),
      [
        { role: 'system', content: 'S' },
        { role: 'user', content: 'U' },
        { role: 'tool', content: 'R', toolCallId: 'toolu_1' },
      ],
      [],
    )
    expect(body['system']).toBe('S')
    const messages = body['messages'] as Array<Record<string, unknown>>
    expect(messages).toHaveLength(2)
    expect(messages[1]).toEqual({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'R' }],
    })
    // max_tokens 是 Anthropic 必填
    expect(body['max_tokens']).toBe(4096)
  })

  it('thinking 模式带上扩展思考参数', () => {
    const body = buildAnthropicBody(config({ kind: 'anthropic' }), [{ role: 'user', content: 'x' }], [], 'thinking')
    expect(body['thinking']).toEqual({ type: 'enabled', budget_tokens: 2048 })
  })
})

describe('错误映射与配置校验', () => {
  it('未配置 apiKey 直接拒绝，不发请求', async () => {
    let called = false
    const client = createProviderClient(config({ apiKey: undefined }), {
      fetch: async () => {
        called = true
        return response([])
      },
    })
    await expect(client.streamChat({ messages: [] })).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
    expect(called).toBe(false)
  })

  it('401/403 → UNAUTHORIZED，429 → TIMEOUT，5xx → INTERNAL，且带上响应片段', async () => {
    const cases: Array<[number, string]> = [
      [401, 'UNAUTHORIZED'],
      [403, 'UNAUTHORIZED'],
      [429, 'TIMEOUT'],
      [500, 'INTERNAL'],
    ]
    for (const [status, code] of cases) {
      const client = createProviderClient(config(), {
        fetch: fetchReturning(response([], { ok: false, status, text: 'bad key' })),
      })
      await expect(client.streamChat({ messages: [] })).rejects.toMatchObject({ code })
      await expect(client.streamChat({ messages: [] })).rejects.toThrow(/bad key/)
    }
  })

  it('网络异常包装成 INTERNAL 而不是裸抛', async () => {
    const client = createProviderClient(config(), {
      fetch: async () => {
        throw new Error('ECONNREFUSED')
      },
    })
    await expect(client.streamChat({ messages: [] })).rejects.toMatchObject({ code: 'INTERNAL' })
  })
})

describe('resolveEndpoint', () => {
  it('补全 OpenAI/Anthropic 路径，且不重复拼接', () => {
    expect(resolveEndpoint('https://api.openai.com/v1', 'openai')).toBe(
      'https://api.openai.com/v1/chat/completions',
    )
    expect(resolveEndpoint('https://api.openai.com', 'openai')).toBe(
      'https://api.openai.com/v1/chat/completions',
    )
    expect(resolveEndpoint('https://proxy.local/v1/chat/completions', 'openai')).toBe(
      'https://proxy.local/v1/chat/completions',
    )
    expect(resolveEndpoint('https://api.anthropic.com', 'anthropic')).toBe(
      'https://api.anthropic.com/v1/messages',
    )
    expect(resolveEndpoint('https://api.anthropic.com/v1/messages', 'anthropic')).toBe(
      'https://api.anthropic.com/v1/messages',
    )
  })
})

describe('parseToolArguments', () => {
  it('合法 JSON 解析为对象，非法/空退化成 {}', () => {
    expect(parseToolArguments('{"a":1}')).toEqual({ a: 1 })
    expect(parseToolArguments('')).toEqual({})
    expect(parseToolArguments('{"a":')).toEqual({})
    expect(parseToolArguments('not json')).toEqual({})
    expect(parseToolArguments('"str"')).toEqual({ value: 'str' })
  })
})

describe('buildOpenAiBody', () => {
  it('空 toolCalls 的 assistant 消息仍是普通文本消息', () => {
    const body = buildOpenAiBody(config(), [{ role: 'assistant', content: 'hi', toolCalls: [] }], [])
    const messages = body['messages'] as Array<Record<string, unknown>>
    expect(messages[0]).toEqual({ role: 'assistant', content: 'hi' })
  })

  it('thinking 模式带 reasoning_effort', () => {
    const body = buildOpenAiBody(config(), [{ role: 'user', content: 'x' }], [], 'thinking')
    expect(body['reasoning_effort']).toBe('medium')
  })
})
