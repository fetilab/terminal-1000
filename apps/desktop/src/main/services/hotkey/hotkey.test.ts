// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 快捷键纯逻辑测试。
 *
 * 注册本身依赖 Electron 运行时，但**最容易出错的三件事都是纯逻辑**：
 * 加速键规范化（别名/顺序/非法输入）、冲突检测、按键匹配。
 * 这些测透了，注册那条路径基本只剩"系统是否占用"这种外部因素。
 */

import { describe, expect, it } from 'vitest'
import type { HotkeyBinding } from '@t1000/shared'
// 从纯逻辑模块导入（不 import ./index，避免把 Electron 运行时拖进 Node 测试）
import { findConflicts, matchesInput, normalizeAccelerator, type KeyInput } from './accelerator'

describe('normalizeAccelerator', () => {
  it('规范修饰键顺序（无论输入顺序如何）', () => {
    expect(normalizeAccelerator('shift+ctrl+t')).toBe('Ctrl+Shift+T')
    expect(normalizeAccelerator('Ctrl+Shift+T')).toBe('Ctrl+Shift+T')
    expect(normalizeAccelerator('T+Shift+Ctrl')).toBe('Ctrl+Shift+T')
  })

  it('识别修饰键别名', () => {
    expect(normalizeAccelerator('control+a')).toBe('Ctrl+A')
    expect(normalizeAccelerator('cmd+a')).toBe('Cmd+A')
    expect(normalizeAccelerator('command+a')).toBe('Cmd+A')
    expect(normalizeAccelerator('option+a')).toBe('Alt+A')
    expect(normalizeAccelerator('meta+a')).toBe('Cmd+A')
  })

  it('规范常见按键别名', () => {
    expect(normalizeAccelerator('Ctrl+return')).toBe('Ctrl+Enter')
    expect(normalizeAccelerator('Ctrl+esc')).toBe('Ctrl+Escape')
    expect(normalizeAccelerator('Ctrl+del')).toBe('Ctrl+Delete')
    expect(normalizeAccelerator('Ctrl+space')).toBe('Ctrl+Space')
  })

  it('功能键统一大写', () => {
    expect(normalizeAccelerator('Ctrl+f5')).toBe('Ctrl+F5')
    expect(normalizeAccelerator('Alt+f12')).toBe('Alt+F12')
  })

  it('★ 拒绝无修饰键的单键（会吃掉正常输入）', () => {
    // 这是最坑用户的一种配置：注册了 "a" 之后用户就再也打不出字母 a
    expect(normalizeAccelerator('a')).toBeUndefined()
    expect(normalizeAccelerator('F5')).toBeUndefined()
    expect(normalizeAccelerator('Enter')).toBeUndefined()
  })

  it('空串与空白返回 undefined', () => {
    expect(normalizeAccelerator('')).toBeUndefined()
    expect(normalizeAccelerator('   ')).toBeUndefined()
  })

  it('忽略多余空白与空段', () => {
    expect(normalizeAccelerator('  ctrl + shift + t  ')).toBe('Ctrl+Shift+T')
    expect(normalizeAccelerator('ctrl++t')).toBe('Ctrl+T')
  })

  it('只有修饰键时返回 undefined（没有主键）', () => {
    expect(normalizeAccelerator('Ctrl+Shift')).toBeUndefined()
  })

  it('保留 Cmd/Super 与 Ctrl 的区别（跨平台语义不同）', () => {
    expect(normalizeAccelerator('Cmd+K')).toBe('Cmd+K')
    expect(normalizeAccelerator('Ctrl+K')).toBe('Ctrl+K')
    expect(normalizeAccelerator('Cmd+K')).not.toBe(normalizeAccelerator('Ctrl+K'))
  })
})

describe('findConflicts', () => {
  const mk = (id: string, accelerator?: string, enabled = true, global = false): HotkeyBinding => ({
    id,
    command: `cmd.${id}`,
    ...(accelerator !== undefined ? { accelerator } : {}),
    global,
    enabled,
  })

  it('识别同一加速键被多条绑定占用', () => {
    const conflicts = findConflicts([mk('a', 'Ctrl+T'), mk('b', 'ctrl+t')])
    // 大小写不同但规范化后相同，属于冲突
    expect(conflicts.get('Ctrl+T')).toEqual(['a', 'b'])
  })

  it('不同加速键不算冲突', () => {
    const conflicts = findConflicts([mk('a', 'Ctrl+T'), mk('b', 'Ctrl+Y')])
    expect(conflicts.get('Ctrl+T')).toEqual(['a'])
    expect(conflicts.get('Ctrl+Y')).toEqual(['b'])
  })

  it('禁用的绑定不参与冲突判定', () => {
    const conflicts = findConflicts([mk('a', 'Ctrl+T'), mk('b', 'Ctrl+T', false)])
    expect(conflicts.get('Ctrl+T')).toEqual(['a'])
  })

  it('无加速键的绑定被忽略', () => {
    const conflicts = findConflicts([mk('a'), mk('b', 'Ctrl+T')])
    expect(conflicts.has('Ctrl+T')).toBe(true)
    expect([...conflicts.values()].flat()).not.toContain('a')
  })
})

describe('matchesInput', () => {
  const input = (over: Partial<KeyInput>): KeyInput => ({
    control: false,
    alt: false,
    shift: false,
    meta: false,
    key: '',
    ...over,
  })

  it('修饰键与主键全匹配才命中', () => {
    expect(matchesInput(input({ control: true, key: 't' }), 'Ctrl+T')).toBe(true)
    // 缺 Shift 不该命中
    expect(matchesInput(input({ control: true, key: 't' }), 'Ctrl+Shift+T')).toBe(false)
    // 多按了 Alt 也不该命中
    expect(matchesInput(input({ control: true, alt: true, key: 't' }), 'Ctrl+T')).toBe(false)
  })

  it('大小写不敏感', () => {
    expect(matchesInput(input({ control: true, shift: true, key: 'T' }), 'Ctrl+Shift+t')).toBe(true)
  })

  it('按键别名可互相匹配', () => {
    expect(matchesInput(input({ control: true, key: 'Return' }), 'Ctrl+Enter')).toBe(true)
    expect(matchesInput(input({ control: true, key: 'Esc' }), 'Ctrl+Escape')).toBe(true)
    expect(matchesInput(input({ control: true, key: ' ' }), 'Ctrl+Space')).toBe(true)
    expect(matchesInput(input({ control: true, key: 'ArrowUp' }), 'Ctrl+Up')).toBe(true)
  })

  it('Cmd 与 Super 都映射到 meta', () => {
    expect(matchesInput(input({ meta: true, key: 'k' }), 'Cmd+K')).toBe(true)
    expect(matchesInput(input({ meta: true, key: 'k' }), 'Super+K')).toBe(true)
    // Ctrl 不应误命中 Cmd
    expect(matchesInput(input({ control: true, key: 'k' }), 'Cmd+K')).toBe(false)
  })

  it('功能键匹配', () => {
    expect(matchesInput(input({ control: true, key: 'F5' }), 'Ctrl+F5')).toBe(true)
    expect(matchesInput(input({ control: true, key: 'f5' }), 'Ctrl+F5')).toBe(true)
  })
})
