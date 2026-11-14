// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * `??` AI 命令辅助通道单测。
 *
 * 覆盖两道断点 + 三条降级路径：
 * - 触发：行尾 `docker run??` 与前缀 `?? 描述` 都能进入 AI 分支
 * - 注入：provider 缺失 / 注入后生效（configureCompletionAi 会重建引擎）
 * - 降级：未配置 provider、开关关闭、AI 报错、AI 返回空 —— **都有可操作提示，不静默**
 *
 * provider 全部是注入的假实现，**不打网络**。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CompletionSettings } from '@t1000/shared'
import type { IpcContext, IpcHandler } from '../../ipc/router'
import { CompletionCorpus, bundledSpecSource } from './corpus'
import {
  CompletionEngine,
  createAiSuggestionProvider,
  detectAiSuggestion,
  parseCommandLine,
  stripAiMarker,
  type AiSuggestionInput,
  type AiSuggestionProvider,
} from './engine'
import {
  completionHandlers,
  configureCompletionAi,
  configureCompletionSettings,
  isCompletionAiConfigured,
  resetCompletion,
} from './index'

const fakeCtx = {
  logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
  paths: {},
  emit: () => {},
} as unknown as IpcContext

function call(action: string, payload: unknown): Promise<unknown> {
  const fn = completionHandlers[action] as IpcHandler | undefined
  if (!fn) throw new Error(`缺少 handler: ${action}`)
  return Promise.resolve(fn(payload, fakeCtx))
}

const AI_CANDIDATE = {
  value: 'docker run -d --name web nginx',
  description: '后台启动 nginx 容器',
  kind: 'ai' as const,
  score: 900,
  matchKind: 'exact' as const,
}

/** 正常返回一个候选的假 provider */
function okProvider(): AiSuggestionProvider & { suggest: ReturnType<typeof vi.fn> } {
  return { suggest: vi.fn(async () => [AI_CANDIDATE]) }
}

function makeEngine(
  over: { settings?: Partial<CompletionSettings>; provider?: AiSuggestionProvider } = {},
): CompletionEngine {
  return new CompletionEngine({
    corpus: new CompletionCorpus(bundledSpecSource()),
    settings: { aiSuggestion: true, ...over.settings },
    ...(over.provider === undefined ? {} : { aiProvider: over.provider }),
  })
}

beforeEach(() => {
  resetCompletion()
  configureCompletionAi(null)
  configureCompletionSettings(null)
})

// ---------------------------------------------------------------------------
// 触发（断点 2）
// ---------------------------------------------------------------------------

describe('?? 触发', () => {
  it('识别两种写法；`echo ??` 不算', () => {
    expect(detectAiSuggestion('docker run??')).toBe(true)
    expect(detectAiSuggestion('?? 找出大文件')).toBe(true)
    expect(detectAiSuggestion('echo ??')).toBe(false)
    expect(detectAiSuggestion('docker run')).toBe(false)

    expect(parseCommandLine('docker run??').aiPrefix).toBe(true)
    expect(parseCommandLine('?? 找出大文件').aiPrefix).toBe(true)
    // 既有约定保持不变
    expect(parseCommandLine('echo ??').aiPrefix).toBe(false)
  })

  it('去掉标记后的文本就是给 AI 的查询', () => {
    expect(stripAiMarker('docker run??')).toBe('docker run')
    expect(stripAiMarker('?? 找出大文件')).toBe('找出大文件')
    expect(stripAiMarker('echo ??')).toBe('echo ??') // 非 AI 行原样不动
  })

  it('★ 行尾 `docker run??` 触发 AI 分支，且给 AI 的是干净文本', async () => {
    const provider = okProvider()
    const engine = makeEngine({ provider })
    const result = await engine.complete({ line: 'docker run??', aiPrefix: true })

    expect(provider.suggest).toHaveBeenCalledTimes(1)
    const input = provider.suggest.mock.calls[0]?.[0] as AiSuggestionInput
    expect(input.query).toBe('docker run')
    expect(input.line).toBe('docker run')
    expect(result.candidates[0]?.value).toBe(AI_CANDIDATE.value)
    expect(result.aiRequested).toBe(true)
  })

  it('★ 主进程自己也能识别（渲染层没置位也照样生效）', async () => {
    const provider = okProvider()
    const engine = makeEngine({ provider })
    const result = await engine.complete({ line: '?? 列出端口占用' })
    expect(result.aiRequested).toBe(true)
    const input = provider.suggest.mock.calls[0]?.[0] as AiSuggestionInput
    expect(input.query).toBe('列出端口占用')
  })

  it('limit 透传给 provider', async () => {
    const provider = okProvider()
    const engine = makeEngine({ provider })
    await engine.complete({ line: 'docker run??', aiPrefix: true, limit: 3 })
    expect(provider.suggest.mock.calls[0]?.[1]).toBe(3)
  })

  it('普通行不进 AI 分支', async () => {
    const provider = okProvider()
    const engine = makeEngine({ provider })
    const result = await engine.complete({ line: 'git ch', aiPrefix: false })
    expect(provider.suggest).not.toHaveBeenCalled()
    expect(result.aiRequested).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 降级（要求 3：三条路径都要可操作、无静默）
// ---------------------------------------------------------------------------

describe('降级：provider 缺失', () => {
  it('★ 给可操作提示（而不是"通道尚未接入"），并且有可见的行', async () => {
    const engine = makeEngine() // 未注入 provider
    const result = await engine.complete({ line: 'docker run??', aiPrefix: true })

    expect(result.aiRequested).toBe(true)
    const notes = result.notes?.join(' ') ?? ''
    expect(notes).toContain('设置 > AI 助手')
    expect(notes).toContain('API Key')
    expect(notes).not.toContain('尚未接入')

    // 现有 UI 只在有候选时弹层，所以提示必须随候选一起给出来
    expect(result.candidates).toHaveLength(1)
    const info = result.candidates[0]
    expect(info?.kind).toBe('ai')
    expect(`${info?.label} ${info?.description}`).toContain('API Key')
  })

  it('★ 提示行是"无操作"的：value 就是原样 token，接受它不会改动命令行', async () => {
    const engine = makeEngine()
    const result = await engine.complete({ line: 'docker run??', aiPrefix: true })
    // 原样 token 就是 `run??`
    expect(result.candidates[0]?.value).toBe('run??')
  })
})

describe('降级：开关关闭', () => {
  it('★ 说明已关闭 + 继续走普通补全（不静默、也不卡住用户）', async () => {
    const provider = okProvider()
    const engine = makeEngine({ settings: { aiSuggestion: false }, provider })
    const result = await engine.complete({ line: 'docker run??', aiPrefix: true })

    expect(provider.suggest).not.toHaveBeenCalled() // 关了就不该偷偷调用
    const notes = result.notes?.join(' ') ?? ''
    expect(notes).toContain('已')
    expect(notes).toContain('关闭')
    expect(notes).toContain('设置 > 补全')
    // 走了普通补全：aiRequested 为 false（确实没用 AI 通道）
    expect(result.aiRequested).toBe(false)
  })
})

describe('降级：AI 报错 / 返回空', () => {
  it('★ provider 抛错（如未填 Key）→ 原样呈现 AI 侧的可操作文案', async () => {
    const provider: AiSuggestionProvider = {
      suggest: vi.fn(async () => {
        throw new Error('请先在「设置 > AI 助手」里填写供应商 API Key')
      }),
    }
    const engine = makeEngine({ provider })
    const result = await engine.complete({ line: 'docker run??', aiPrefix: true })

    const notes = result.notes?.join(' ') ?? ''
    expect(notes).toContain('请先在「设置 > AI 助手」里填写供应商 API Key')
    expect(result.candidates).toHaveLength(1) // 仍然可见
    expect(result.aiRequested).toBe(true)
  })

  it('★ 超时/网络错误也如实说明', async () => {
    const provider: AiSuggestionProvider = {
      suggest: vi.fn(async () => {
        throw new Error('请求超时（15s）')
      }),
    }
    const result = await makeEngine({ provider }).complete({ line: '?? 看看磁盘', aiPrefix: true })
    expect(result.notes?.join(' ')).toContain('请求超时（15s）')
  })

  it('★ AI 返回空数组 → 提示换个说法', async () => {
    const provider: AiSuggestionProvider = { suggest: vi.fn(async () => []) }
    const result = await makeEngine({ provider }).complete({ line: 'docker run??', aiPrefix: true })
    const notes = result.notes?.join(' ') ?? ''
    expect(notes).toContain('没有返回可用的命令建议')
    expect(result.candidates).toHaveLength(1)
  })

  it('只有空白内容的候选被当成空结果', async () => {
    const provider: AiSuggestionProvider = {
      suggest: vi.fn(async () => [
        { value: '   ', kind: 'ai' as const, score: 1, matchKind: 'exact' as const },
      ]),
    }
    const result = await makeEngine({ provider }).complete({ line: 'docker run??', aiPrefix: true })
    expect(result.candidates[0]?.label).toContain('AI 没有给出建议')
  })
})

// ---------------------------------------------------------------------------
// 注入与 IPC（断点 1）
// ---------------------------------------------------------------------------

describe('provider 注入（断点 1）', () => {
  it('未注入时 isCompletionAiConfigured 为 false；注入后为 true', () => {
    expect(isCompletionAiConfigured()).toBe(false)
    configureCompletionAi(okProvider())
    expect(isCompletionAiConfigured()).toBe(true)
    configureCompletionAi(null)
    expect(isCompletionAiConfigured()).toBe(false)
  })

  it('★ IPC 端到端：schema 接受 aiPrefix，请求真的能走到 provider', async () => {
    const provider = okProvider()
    configureCompletionAi(provider)

    const result = (await call('complete', {
      line: 'docker run??',
      aiPrefix: true,
    })) as { candidates: Array<{ value: string }>; aiRequested: boolean }

    expect(result.aiRequested).toBe(true)
    expect(result.candidates[0]?.value).toBe(AI_CANDIDATE.value)
    expect(provider.suggest).toHaveBeenCalledTimes(1)
  })

  it('★ 引擎已建好之后再注入也生效（configureCompletionAi 会重建单例）', async () => {
    // 先在没有 provider 的情况下用一次（会建出单例）
    const before = (await call('complete', { line: 'docker run??', aiPrefix: true })) as {
      candidates: Array<{ label?: string }>
    }
    expect(before.candidates[0]?.label).toContain('AI 建议不可用')

    // 再注入 provider：如果单例没被丢弃，这里仍会返回旧的"不可用"
    const provider = okProvider()
    configureCompletionAi(provider)
    const after = (await call('complete', { line: 'docker run??', aiPrefix: true })) as {
      candidates: Array<{ value: string }>
    }
    expect(after.candidates[0]?.value).toBe(AI_CANDIDATE.value)
    expect(provider.suggest).toHaveBeenCalledTimes(1)
  })

  it('清除 provider 后回到可操作提示', async () => {
    configureCompletionAi(okProvider())
    configureCompletionAi(null)
    const result = (await call('complete', { line: '?? 看看磁盘', aiPrefix: true })) as {
      candidates: Array<{ label?: string; description?: string }>
    }
    expect(`${result.candidates[0]?.label} ${result.candidates[0]?.description}`).toContain('API Key')
  })
})

// ---------------------------------------------------------------------------
// 最小 AI 契约（AI 侧只需给命令文本）
// ---------------------------------------------------------------------------

describe('createAiSuggestionProvider：AI 侧只给命令文本', () => {
  it('把命令文本转成 ai 候选，保持顺序与说明', async () => {
    const provider = createAiSuggestionProvider({
      suggestCommands: vi.fn(async () => [
        { command: 'docker run -d nginx', description: '后台启动 nginx' },
        { command: 'docker ps', description: '看运行中的容器' },
      ]),
    })
    const candidates = await provider.suggest(
      {
        query: 'docker run',
        line: 'docker run',
        context: parseCommandLine('docker run'),
      },
      5,
    )
    expect(candidates.map((c) => c.value)).toEqual(['docker run -d nginx', 'docker ps'])
    expect(candidates[0]?.kind).toBe('ai')
    expect(candidates[0]?.description).toBe('后台启动 nginx')
    expect(candidates[0]!.score).toBeGreaterThan(candidates[1]!.score) // 顺序即优先级
  })

  it('过滤空命令、按 limit 截断、去首尾空白', async () => {
    const provider = createAiSuggestionProvider({
      suggestCommands: vi.fn(async () => [
        { command: '  ls -la  ' },
        { command: '   ' },
        { command: 'echo a' },
        { command: 'echo b' },
      ]),
    })
    const candidates = await provider.suggest(
      { query: 'x', line: 'x', context: parseCommandLine('x') },
      2,
    )
    expect(candidates.map((c) => c.value)).toEqual(['ls -la', 'echo a'])
  })

  it('AI 侧抛错会向上传播（由引擎转成可操作提示）', async () => {
    const provider = createAiSuggestionProvider({
      suggestCommands: vi.fn(async () => {
        throw new Error('未配置 API Key')
      }),
    })
    const engine = makeEngine({ provider })
    const result = await engine.complete({ line: '?? 看看磁盘', aiPrefix: true })
    expect(result.notes?.join(' ')).toContain('未配置 API Key')
  })
})

// ---------------------------------------------------------------------------
// 设置来源（第 4 道断点：设置面板的开关到不了引擎）
// ---------------------------------------------------------------------------

describe('settingsProvider：设置面板的开关立即生效', () => {
  it('★ 注入的设置说"关闭" → 不调用 AI，并提示已关闭', async () => {
    const provider = okProvider()
    let settings: Partial<CompletionSettings> = { aiSuggestion: false }
    const real = new CompletionEngine({
      corpus: new CompletionCorpus(bundledSpecSource()),
      aiProvider: provider,
      settingsProvider: () => settings,
    })

    const off = await real.complete({ line: 'docker run??', aiPrefix: true })
    expect(provider.suggest).not.toHaveBeenCalled()
    expect(off.notes?.join(' ')).toContain('关闭')

    // 用户在设置面板里打开开关 → 同一次会话内立即生效（不需要重建引擎）
    settings = { aiSuggestion: true }
    const on = await real.complete({ line: 'docker run??', aiPrefix: true })
    expect(provider.suggest).toHaveBeenCalledTimes(1)
    expect(on.candidates[0]?.value).toBe(AI_CANDIDATE.value)
  })

  it('provider 与设置来源可同时注入（生产的接线方式）', async () => {
    const provider = okProvider()
    const engine = new CompletionEngine({
      corpus: new CompletionCorpus(bundledSpecSource()),
      aiProvider: provider,
      settingsProvider: () => ({ enabled: true, specCompletion: true, aiSuggestion: true }),
    })
    const result = await engine.complete({ line: 'docker run??', aiPrefix: true })
    expect(result.aiRequested).toBe(true)
    expect(result.candidates[0]?.value).toBe(AI_CANDIDATE.value)
  })

  it('★ IPC 端到端：configureCompletionSettings 注入后，关闭开关真的生效', async () => {
    configureCompletionAi(okProvider())
    configureCompletionSettings(() => ({ aiSuggestion: false }) as CompletionSettings)

    const result = (await call('complete', { line: 'docker run??', aiPrefix: true })) as {
      notes?: string[]
      aiRequested: boolean
    }
    expect(result.aiRequested).toBe(false)
    expect(result.notes?.join(' ')).toContain('关闭')
  })

  it('★ 关闭开关且普通补全也没候选时，仍给一行可见提示（不静默）', async () => {
    // `docker run??` 的普通补全匹配不到东西 → 旧实现会让 UI 什么都不显示
    const result = (await call('complete', {
      line: 'docker run??',
      aiPrefix: true,
    })) as { candidates: Array<{ label?: string; description?: string }> }
    // 走真实默认设置（aiSuggestion 默认 true、未注入 provider）→ 这里是"不可用"提示；
    // 关键是：只要没有候选，就必须有一行说明
    expect(result.candidates.length).toBeGreaterThan(0)
    expect(String(result.candidates[0]?.label ?? '')).not.toBe('')
  })

  it('★ 开关关闭 + 无候选：提示里说明已关闭', async () => {
    configureCompletionSettings(() => ({ aiSuggestion: false }) as CompletionSettings)
    const result = (await call('complete', {
      line: 'docker run??',
      aiPrefix: true,
    })) as { candidates: Array<{ label?: string; description?: string }> }
    const text = `${result.candidates[0]?.label} ${result.candidates[0]?.description}`
    expect(text).toContain('关闭')
  })
})
