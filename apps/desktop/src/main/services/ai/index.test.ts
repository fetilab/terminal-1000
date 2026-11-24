// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * ai 域 handler 单测：机密封装（不泄漏 apiKey）、入参校验、依赖注入、send 走通。
 * 用注入的假 fetch，绝不访问外部 AI 服务。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AiProviderConfig, AiSettings, AppPaths } from '@t1000/shared'
import type { IpcContext } from '../../ipc/router'
import { aiHandlers, configureAi, resetAiRuntime } from './index'
import type { FetchLike } from './providers'

const PROVIDER: AiProviderConfig = {
  id: 'p1',
  name: '本地',
  kind: 'openai',
  baseUrl: 'https://api.example.com/v1',
  apiKey: 'sk-super-secret',
  model: 'm',
}

function settings(patch: Partial<AiSettings> = {}): AiSettings {
  return {
    providers: [PROVIDER],
    assistantName: '问问老菜',
    mode: 'assistant',
    allowExecution: false,
    riskPolicy: { readOnlyAllowlist: [], dangerousDenylist: [], confirmSudo: true },
    limits: { maxRounds: 10, maxCommands: 10, maxTargets: 5 },
    ...patch,
  }
}

const events: Array<{ event: string; payload: unknown }> = []

function ctx(): IpcContext {
  return {
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    paths: {} as AppPaths,
    emit: ((event: string, payload: unknown) => {
      events.push({ event, payload })
    }) as unknown as IpcContext['emit'],
  }
}

/**
 * 调用 handler 并保证"同步抛错"也变成 rejected promise ——
 * 真实 IPC 路由是 await handler(...) 包在 try/catch 里，这里要模拟同样的行为，
 * 否则 reject 断言会因为同步抛出而测不到。
 */
function call<T = unknown>(action: string, payload?: unknown): Promise<T> {
  const handler = aiHandlers[action]
  if (!handler) return Promise.reject(new Error(`缺少 handler: ${action}`))
  try {
    return Promise.resolve(handler(payload, ctx()) as T | Promise<T>)
  } catch (err) {
    return Promise.reject(err)
  }
}

/** 一个只回固定文本的假 SSE 流 */
function textFetch(text: string): FetchLike {
  return async () => ({
    ok: true,
    status: 200,
    text: async () => '',
    body: (async function* () {
      const encoder = new TextEncoder()
      yield encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`)
      yield encoder.encode('data: [DONE]\n\n')
    })(),
  })
}

beforeEach(() => {
  resetAiRuntime()
  events.length = 0
  configureAi({ getSettings: () => settings(), fetch: textFetch('你好'), listSessions: () => [] })
})

afterEach(() => {
  resetAiRuntime()
})

describe('listProviders（机密封装）', () => {
  it('绝不返回 apiKey，只给 hasApiKey', async () => {
    const result = await call<{ providers: Array<Record<string, unknown>> }>('listProviders')
    expect(result.providers).toHaveLength(1)
    const p = result.providers[0]!
    expect(p).not.toHaveProperty('apiKey')
    expect(p['hasApiKey']).toBe(true)
    expect(p['id']).toBe('p1')
    // 整个响应体里不能出现明文 key
    expect(JSON.stringify(result)).not.toContain('sk-super-secret')
  })

  it('未配置 key 时 hasApiKey=false', async () => {
    resetAiRuntime()
    configureAi({ getSettings: () => settings({ providers: [{ ...PROVIDER, apiKey: undefined }] }) })
    const result = await call<{ providers: Array<Record<string, unknown>> }>('listProviders')
    expect(result.providers[0]?.['hasApiKey']).toBe(false)
  })
})

describe('setProvider', () => {
  it('存在的供应商可切换；不存在报 NOT_FOUND', async () => {
    expect(await call('setProvider', { providerId: 'p1' })).toEqual({ providerId: 'p1' })
    await expect(call('setProvider', { providerId: 'nope' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('缺少 providerId 时报 BAD_REQUEST', async () => {
    await expect(call('setProvider', {})).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })
})

describe('会话动作', () => {
  it('初始为空；getChat 不存在报 NOT_FOUND；cancel 未运行返回 false；deleteChat 幂等', async () => {
    expect(await call('listChats')).toEqual([])
    await expect(call('getChat', { chatId: 'x' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(await call('cancel', { chatId: 'x' })).toEqual({ chatId: 'x', cancelled: false })
    expect(await call('deleteChat', { chatId: 'x' })).toEqual({ chatId: 'x', deleted: false })
  })

  it('send 走通并把增量推成事件；会话进入列表', async () => {
    const result = await call<{ chatId: string; text: string }>('send', { text: '打个招呼' })

    expect(result.text).toBe('你好')
    const chat = await call<{ title: string; messages: Array<{ role: string }> }>('getChat', { chatId: result.chatId })
    expect(chat.title).toBe('打个招呼')
    expect(chat.messages.map((m) => m.role)).toEqual(['user', 'assistant'])

    expect(events.some((e) => e.event === 'AI_DELTA')).toBe(true)
    expect(events.some((e) => e.event === 'AI_DONE')).toBe(true)

    const list = await call<Array<{ id: string }>>('listChats')
    expect(list.map((c) => c.id)).toContain(result.chatId)
    expect(await call('deleteChat', { chatId: result.chatId })).toEqual({ chatId: result.chatId, deleted: true })
  })

  it('send 空消息报 BAD_REQUEST', async () => {
    await expect(call('send', { text: '' })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })

  it('未配置供应商时报 BAD_REQUEST', async () => {
    resetAiRuntime()
    configureAi({ getSettings: () => settings({ providers: [] }), fetch: textFetch('x') })
    await expect(call('send', { text: 'hi' })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })
})

describe('依赖注入', () => {
  it('未注入任何依赖时也有保守默认：不执行命令、chat 模式', async () => {
    resetAiRuntime()
    // 没有 provider → send 明确失败，而不是去连什么
    await expect(call('send', { text: 'hi' })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    // listProviders 也不炸
    expect(await call<{ providers: unknown[] }>('listProviders')).toEqual({ providers: [] })
  })

  it('注入的 exec 被用于工具执行（allowExecution=true + 只读命令）', async () => {
    resetAiRuntime()
    const executed: string[] = []
    // 第一轮返回工具调用，第二轮返回文本
    let callIndex = 0
    const fetch: FetchLike = async () => {
      callIndex++
      const chunks =
        callIndex === 1
          ? [
              `data: ${JSON.stringify({
                choices: [
                  {
                    delta: {
                      tool_calls: [
                        {
                          index: 0,
                          id: 'c1',
                          function: { name: 't1000_ssh_exec', arguments: '{"sessionId":"s1","command":"df -h"}' },
                        },
                      ],
                    },
                  },
                ],
              })}\n\n`,
              'data: [DONE]\n\n',
            ]
          : [`data: ${JSON.stringify({ choices: [{ delta: { content: '好了' } }] })}\n\n`, 'data: [DONE]\n\n']
      return {
        ok: true,
        status: 200,
        text: async () => '',
        body: (async function* () {
          const encoder = new TextEncoder()
          for (const c of chunks) yield encoder.encode(c)
        })(),
      }
    }

    configureAi({
      getSettings: () => settings({ allowExecution: true }),
      fetch,
      exec: async (_s, command) => {
        executed.push(command)
        return { stdout: 'ok', stderr: '', code: 0 }
      },
      listSessions: () => [{ sessionId: 's1', host: 'a', username: 'u', connectionId: 'c1' }],
    })

    const result = await call<{ text: string }>('send', { text: '看看磁盘' })
    expect(executed).toEqual(['df -h'])
    expect(result.text).toBe('好了')
    expect(events.some((e) => e.event === 'AI_TOOL_RESULT')).toBe(true)
  })
})
