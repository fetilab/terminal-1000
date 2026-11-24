// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { StoreService, getStoreService, setStoreService } from '../store'
import { storeKeyOf } from '../store/db'
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

  it('全新文档：外观落库时补齐全部默认值（否则设置面板一排滑杆显示 0）', () => {
    /*
     * 回归用例：早先这里只盖 appearanceRev 章、不写值，
     * 结果设置界面读不到字段 —— 界面明明是 72% 半透明，滑杆却显示 0%。
     */
    const fresh = { version: 1, data: { app: { theme: 'light' } } }
    getStoreService().db.put(storeKeyOf('Settings'), 'app', JSON.stringify(fresh), Date.now())
    resetSettingsCache()

    const s = call('getAll') as ReturnType<typeof defaultSettings> & {
      app: { appearance?: Record<string, unknown> }
    }
    const ap = s.app.appearance
    expect(ap).toBeDefined()
    for (const key of [
      'backgroundOpacity',
      'backgroundBlur',
      'backgroundScrim',
      'panelOpacity',
      'sidebarOpacity',
      'modalOpacity',
      'menuOpacity',
      'inputOpacity',
      'codeOpacity',
      'glassBlur',
      'accentStrength',
    ]) {
      expect(typeof ap![key], `${key} 必须落库`).toBe('number')
    }
    // 与渲染层 APPEARANCE_DEFAULTS 一致的那几个关键值
    expect(ap!.panelOpacity).toBe(0.72)
    expect(ap!.sidebarOpacity).toBe(0.72)
    expect(ap!.glassBlur).toBe(8)
    expect(ap!.scale).toBe(1)
    expect(ap!.backgroundType).toBe('none')
    expect(ap!.preset).toBe('aurora')
  })

  it('旧外观文档迁移到 v3：可见度换算成分组 alpha，壁纸改为满强度', () => {
    // v1 文档：没有 backgroundBlur，带 opacity（界面不透明度），可见度是「背景图层缩放」语义
    const legacy = {
      version: 1,
      data: {
        app: {
          theme: 'light',
          appearance: {
            preset: 'aurora',
            backgroundType: 'image',
            backgroundImage: '/tmp/wall.png',
            backgroundOpacity: 0.25,
            opacity: 0.95,
          },
        },
      },
    }
    new StoreService(':memory:') // 确保 db 可用（setStoreService 已在 beforeEach 建好）
    getStoreService().db.put(storeKeyOf('Settings'), 'app', JSON.stringify(legacy), Date.now())
    resetSettingsCache()

    const s = call('getAll') as ReturnType<typeof defaultSettings> & {
      app: { appearance?: Record<string, unknown> }
    }
    const ap = s.app.appearance
    expect(ap).toBeDefined()
    // 旧「可见度 0.25」→ 面板 alpha = 1 - 0.25×0.9 = 0.775：观感不变
    expect(ap!.panelOpacity).toBeCloseTo(0.775, 3)
    expect(ap!.sidebarOpacity).toBeCloseTo(0.775, 3)
    // 壁纸自身改为满强度（v3 里它不再兼任界面透明度）
    expect(ap!.backgroundOpacity).toBe(1)
    // 背景三件套与浮层组补齐默认值
    // 遮罩必须留 0：旧模型没有这一层，塞默认 0.35 会让老用户壁纸凭空变淡
    expect(ap!.backgroundScrim).toBe(0)
    expect(ap!.glassBlur).toBe(8)
    expect(ap!.accentStrength).toBe(0.22)
    expect(ap!.modalOpacity).toBe(1)
    expect(ap!.menuOpacity).toBe(1)
    expect(ap!.inputOpacity).toBe(1)
    expect(ap!.codeOpacity).toBe(1)
    expect(ap as Record<string, unknown>).not.toHaveProperty('opacity')
    // 其余字段原样保留（迁移不能顺手清掉用户的壁纸）
    expect(ap!.backgroundImage).toBe('/tmp/wall.png')
    expect(ap!.preset).toBe('aurora')
    expect(ap!.backgroundType).toBe('image')

    // 幂等：再读一次不会重复迁移，且迁移结果已落盘
    resetSettingsCache()
    const again = call('getAll') as typeof s
    expect((again.app.appearance as Record<string, unknown>).panelOpacity).toBeCloseTo(0.775, 3)
    expect((again.app as unknown as Record<string, unknown>).appearanceRev).toBe(3)
  })

  it('v3 文档不再被迁移：用户调过的分组 alpha 重启后保持原值', () => {
    const doc = {
      version: 1,
      data: {
        app: {
          appearanceRev: 3,
          appearance: {
            backgroundType: 'image',
            backgroundImage: '/tmp/w.png',
            backgroundOpacity: 1,
            panelOpacity: 0.4,
            sidebarOpacity: 0.55,
            modalOpacity: 1,
            menuOpacity: 1,
            inputOpacity: 1,
            codeOpacity: 1,
            backgroundScrim: 0.2,
            glassBlur: 12,
            accentStrength: 0.3,
          },
        },
      },
    }
    getStoreService().db.put(storeKeyOf('Settings'), 'app', JSON.stringify(doc), Date.now())
    resetSettingsCache()

    const s = call('getAll') as ReturnType<typeof defaultSettings> & {
      app: { appearance?: Record<string, unknown> }
    }
    expect(s.app.appearance!.panelOpacity).toBe(0.4)
    expect(s.app.appearance!.sidebarOpacity).toBe(0.55)
    expect(s.app.appearance!.glassBlur).toBe(12)
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

  it('终端程序常用的键默认不抢：Ctrl+K（kill-line）/ Ctrl+Space（set-mark）默认关', () => {
    const s = call('getAll') as ReturnType<typeof defaultSettings>
    const byCommand = new Map(s.hotkeys.map((h) => [h.command, h]))
    expect(byCommand.get('app.globalSearch')?.enabled).toBe(false)
    expect(byCommand.get('terminal.completion')?.enabled).toBe(false)
    // Ctrl+, / Ctrl+1..7 终端程序基本不用，保持默认开
    expect(byCommand.get('app.openSettings')?.enabled).toBe(true)
    expect(byCommand.get('app.view.console')?.enabled).toBe(true)
  })

  it('旧文档的 hotkeys 数组补齐新版本命令，且不动用户的改动', () => {
    // 0.2.5 落库的 hotkeys 只有 7 条；用户把 new-tab 改成 Alt+Q 并禁用了 find
    const oldDoc = {
      version: 1,
      data: {
        hotkeys: [
          { id: 'hk-new-tab', command: 'terminal.newTab', accelerator: 'Alt+Q', global: false, enabled: true },
          { id: 'hk-find', command: 'terminal.find', accelerator: 'Ctrl+Shift+F', global: false, enabled: false },
        ],
      },
    }
    getStoreService().db.put(storeKeyOf('Settings'), 'app', JSON.stringify(oldDoc), Date.now())
    resetSettingsCache()

    const s = call('getAll') as ReturnType<typeof defaultSettings>
    const byCommand = new Map(s.hotkeys.map((h) => [h.command, h]))
    // 用户的改动原样保留（迁移是按 command 补缺的加法，不是重置）
    expect(byCommand.get('terminal.newTab')?.accelerator).toBe('Alt+Q')
    expect(byCommand.get('terminal.find')?.enabled).toBe(false)
    // 新版本命令补齐
    expect(byCommand.get('app.globalSearch')).toBeDefined()
    expect(byCommand.get('app.openSettings')).toBeDefined()
    expect(byCommand.get('app.view.console')).toBeDefined()
    expect(byCommand.get('terminal.completion')).toBeDefined()

    // 幂等：重读不会重复追加
    resetSettingsCache()
    const again = call('getAll') as typeof s
    expect(again.hotkeys.length).toBe(s.hotkeys.length)
  })

  it('剪贴板键位迁移：rev 1 文档（0.2.8 首版翻过的）回退为不抢占，其它文档只盖新戳', () => {
    // rev 1 文档：0.2.8 首版把出厂值翻成了 true —— 必须翻回去
    const flipped = {
      version: 1,
      data: { terminal: { copyOnCtrlC: true, pasteOnCtrlV: true, clipboardKeysRev: 1, fontSize: 12 } },
    }
    getStoreService().db.put(storeKeyOf('Settings'), 'app', JSON.stringify(flipped), Date.now())
    resetSettingsCache()
    const s = call('getAll') as ReturnType<typeof defaultSettings>
    expect(s.terminal.copyOnCtrlC).toBe(false)
    expect(s.terminal.pasteOnCtrlV).toBe(false)
    expect(s.terminal.clipboardKeysRev).toBe(2)
    expect(s.terminal.fontSize).toBe(12)

    // 0.2.7 及更早（无 rev）：值原样保留 —— 手动开过 true 的用户不被重置
    const manual = {
      version: 1,
      data: { terminal: { copyOnCtrlC: true, pasteOnCtrlV: false, fontSize: 13 } },
    }
    getStoreService().db.put(storeKeyOf('Settings'), 'app', JSON.stringify(manual), Date.now())
    resetSettingsCache()
    const s2 = call('getAll') as ReturnType<typeof defaultSettings>
    expect(s2.terminal.copyOnCtrlC).toBe(true)
    expect(s2.terminal.pasteOnCtrlV).toBe(false)
    expect(s2.terminal.clipboardKeysRev).toBe(2)
  })

  it('新装用户拿到剪贴板键位默认关（不抢终端键位）', () => {
    const s = call('getAll') as ReturnType<typeof defaultSettings>
    expect(s.terminal.copyOnCtrlC).toBe(false)
    expect(s.terminal.pasteOnCtrlV).toBe(false)
  })
})
