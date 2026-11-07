// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * completion IPC 契约 + 边界行为测试。
 *
 * 契约：handler 动作集合必须与 `Actions.completion` 一一对应
 * （router 只注册 handler 表里有的动作，漂移了不会在编译期报错）。
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { Actions, type CompletionSettings } from '@t1000/shared'
import type { IpcContext, IpcHandler } from '../../ipc/router'
import { completionHandlers, resetCompletion } from './index'
import type { CompletionResult } from './engine'

const fakeCtx = {
  logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
  paths: {},
  emit: () => {},
} as unknown as IpcContext

function handler(name: string): IpcHandler {
  const fn = completionHandlers[name]
  if (!fn) throw new Error(`缺少 handler: ${name}`)
  return fn
}

beforeEach(() => {
  resetCompletion()
})

describe('completion IPC 契约', () => {
  it('handler 动作集合与 Actions.completion 完全一致', () => {
    expect(Object.keys(completionHandlers).sort()).toEqual([...Actions.completion].sort())
  })

  it('每个动作都是可调用函数', () => {
    for (const [action, fn] of Object.entries(completionHandlers)) {
      expect(typeof fn, `动作 ${action} 应该是函数`).toBe('function')
    }
  })
})

describe('completion handler 行为', () => {
  it('complete 返回候选与上下文，并命中 spec', async () => {
    const result = (await handler('complete')({ line: 'git ch' }, fakeCtx)) as CompletionResult
    expect(result.specName).toBe('git')
    expect(result.candidates.map((c) => c.value)).toContain('checkout')
    expect(result.debounceMs).toBeGreaterThan(0)
    expect(result.context.command).toBe('git')
  })

  it('complete 支持 limit 与 history', async () => {
    const result = (await handler('complete')(
      { line: 'git s', limit: 5, history: [{ line: 'git status', count: 4 }] },
      fakeCtx,
    )) as CompletionResult
    expect(result.candidates.length).toBeLessThanOrEqual(5)
    expect(result.candidates.map((c) => c.value)).toContain('git status')
  })

  it('settings 与 setSettings 往返一致', async () => {
    const before = (await handler('settings')({}, fakeCtx)) as CompletionSettings
    expect(before.enabled).toBe(true)
    expect(before.specCompletion).toBe(true)

    const updated = (await handler('setSettings')({ debounceMs: 250 }, fakeCtx)) as CompletionSettings
    expect(updated.debounceMs).toBe(250)
    expect(updated.enabled).toBe(true) // 未传的字段保持不变

    const current = (await handler('settings')({}, fakeCtx)) as CompletionSettings
    expect(current.debounceMs).toBe(250)

    await handler('setSettings')({ debounceMs: before.debounceMs }, fakeCtx)
  })

  it('listSpecs 返回自建语料索引', async () => {
    const result = (await handler('listSpecs')({}, fakeCtx)) as {
      total: number
      entries: { name: string; brief: string }[]
    }
    expect(result.total).toBeGreaterThanOrEqual(100)
    expect(result.entries[0]?.name).toBeTruthy()
    expect(result.entries[0]?.brief).toBeTruthy()
  })

  it('非法 payload 被 zod 拒绝', async () => {
    // complete 是 async handler → 返回 rejected promise
    await expect(handler('complete')({ line: 123 }, fakeCtx)).rejects.toThrow()
    // setSettings 是同步 handler → 直接抛（router 的 try/catch 同样能兜住）
    expect(() => handler('setSettings')({ debounceMs: -5 }, fakeCtx)).toThrow()
    expect(() => handler('setSettings')({ maxSuggestions: 9999 }, fakeCtx)).toThrow()
  })

  it('空 payload 也能安全处理', async () => {
    await expect(handler('complete')(undefined, fakeCtx)).rejects.toThrow() // line 必填
    const settings = (await handler('settings')(undefined, fakeCtx)) as CompletionSettings
    expect(settings).toBeTruthy()
    const specs = (await handler('listSpecs')(undefined, fakeCtx)) as { total: number }
    expect(specs.total).toBeGreaterThan(0)
  })
})
