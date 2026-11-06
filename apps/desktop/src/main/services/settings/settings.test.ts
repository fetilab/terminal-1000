// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { StoreService, setStoreService } from '../store'
import { AppError } from '../../errors'
import {
  DEFAULT_TERMINAL_SETTINGS,
  deepMerge,
  defaultSettings,
  resetSettingsCache,
  settingsHandlers,
} from './index'

/** 简易 IPC 上下文替身（settings 不用 emit） */
const ctx = {
  logger: { debug() {}, info() {}, warn() {}, error() {} },
  paths: {
    userData: '/tmp',
    dbFile: ':memory:',
    notesDir: '/tmp',
    sessionLogDir: '/tmp',
    watchDir: '/tmp',
    bgImagesDir: '/tmp',
    backupDir: '/tmp',
    logDir: '/tmp',
  },
  emit() {},
} as never

const call = (action: string, payload?: unknown): unknown => {
  const handler = settingsHandlers[action]
  if (!handler) throw new Error(`未实现: ${action}`)
  return handler(payload, ctx)
}

describe('deepMerge', () => {
  it('只覆盖出现的键，其余保持不变', () => {
    const base = { a: 1, b: { c: 2, d: 3 } }
    expect(deepMerge(base, { b: { c: 99 } })).toEqual({ a: 1, b: { c: 99, d: 3 } })
  })

  it('数组整体替换而非逐项合并', () => {
    expect(deepMerge({ list: [1, 2, 3] }, { list: [9] })).toEqual({ list: [9] })
  })

  it('patch 里的 undefined 被忽略（不会误清空字段）', () => {
    expect(deepMerge({ a: 1, b: 2 }, { a: undefined })).toEqual({ a: 1, b: 2 })
  })

  it('patch 非对象时直接替换', () => {
    expect(deepMerge({ a: 1 }, 5)).toBe(5)
  })
})

describe('settings 域', () => {
  beforeEach(() => {
    setStoreService(new StoreService(':memory:'))
    resetSettingsCache()
  })

  afterEach(() => {
    setStoreService(null)
    resetSettingsCache()
  })

  it('首次读取返回默认值', () => {
    const s = call('getAll') as ReturnType<typeof defaultSettings>
    expect(s.terminal.fontSize).toBe(DEFAULT_TERMINAL_SETTINGS.fontSize)
    expect(s.app.theme).toBe('system')
    // 安全默认：遥测关闭、AI 不允许执行命令
    expect(s.app.telemetry).toBe(false)
    expect(s.ai.allowExecution).toBe(false)
  })

  it('按路径写入只改目标字段，不丢其它字段（关键防回归）', () => {
    call('set', { path: 'terminal.fontSize', value: 18 })
    const s = call('getAll') as ReturnType<typeof defaultSettings>

    expect(s.terminal.fontSize).toBe(18)
    // 同一子树里的邻居必须还在
    expect(s.terminal.fontFamily).toBe(DEFAULT_TERMINAL_SETTINGS.fontFamily)
    expect(s.terminal.scrollback).toBe(DEFAULT_TERMINAL_SETTINGS.scrollback)
    // 其它子树完全不受影响
    expect(s.app.theme).toBe('system')
  })

  it('嵌套路径可写（ai.limits.maxCommands）', () => {
    call('set', { path: 'ai.limits.maxCommands', value: 7 })
    const v = call('get', { path: 'ai.limits.maxCommands' }) as { value: number }
    expect(v.value).toBe(7)

    const s = call('getAll') as ReturnType<typeof defaultSettings>
    expect(s.ai.limits.maxRounds).toBe(defaultSettings().ai.limits.maxRounds)
  })

  it('写入落盘后可被重新读出（内存缓存清掉也不丢）', () => {
    call('set', { path: 'app.theme', value: 'dark' })
    resetSettingsCache() // 强制从 SQLite 重读
    const v = call('get', { path: 'app.theme' }) as { value: string }
    expect(v.value).toBe('dark')
  })

  it('get 不存在的路径返回 undefined 而不是抛错', () => {
    const v = call('get', { path: 'nope.not.here' }) as { value: unknown }
    expect(v.value).toBeUndefined()
  })

  it('reset 单个分区只重置该分区', () => {
    call('set', { path: 'terminal.fontSize', value: 22 })
    call('set', { path: 'app.theme', value: 'dark' })

    call('reset', { section: 'terminal' })
    const s = call('getAll') as ReturnType<typeof defaultSettings>

    expect(s.terminal.fontSize).toBe(DEFAULT_TERMINAL_SETTINGS.fontSize)
    expect(s.app.theme).toBe('dark') // 未被重置
  })

  it('全量 reset 恢复所有默认值', () => {
    call('set', { path: 'app.theme', value: 'light' })
    call('set', { path: 'terminal.fontSize', value: 30 })
    call('reset', {})

    const s = call('getAll') as ReturnType<typeof defaultSettings>
    expect(s.app.theme).toBe('system')
    expect(s.terminal.fontSize).toBe(DEFAULT_TERMINAL_SETTINGS.fontSize)
  })

  it('空路径被拒绝', () => {
    expect(() => call('set', { path: '', value: 1 })).toThrow(AppError)
  })

  it('默认内置高亮规则存在且带 builtin 标记', () => {
    const s = call('getAll') as ReturnType<typeof defaultSettings>
    expect(s.highlights.length).toBeGreaterThan(0)
    expect(s.highlights.every((r) => r.builtin === true)).toBe(true)
    // 每条规则的正则都应能编译
    for (const r of s.highlights) {
      expect(() => new RegExp(r.pattern, r.flags ?? '')).not.toThrow()
    }
  })

  it('默认快捷键里有终端操作且无语义重复的 id', () => {
    const s = call('getAll') as ReturnType<typeof defaultSettings>
    expect(s.hotkeys.length).toBeGreaterThan(0)
    const ids = s.hotkeys.map((h) => h.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})
