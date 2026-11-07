// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 快捷键的**纯逻辑**：加速键规范化、冲突检测、按键匹配。
 *
 * 刻意与 Electron 解耦（本文件不 import electron）：
 * - 这三件事是最容易出错、也最值得测的部分，解耦后能在 Node 下直接单测
 * - Electron 的注册只是把这些结果喂给 globalShortcut / before-input-event
 */

import type { HotkeyBinding } from '@t1000/shared'

/**
 * 最小按键形状（结构上兼容 Electron 的 Input）。
 * 不直接 import electron 的类型，避免测试运行时被拖进 Electron。
 */
export interface KeyInput {
  control: boolean
  alt: boolean
  shift: boolean
  meta: boolean
  key: string
}

const MODIFIER_ALIASES: Record<string, string> = {
  ctrl: 'Ctrl',
  control: 'Ctrl',
  cmd: 'Cmd',
  command: 'Cmd',
  meta: 'Cmd',
  super: 'Super',
  alt: 'Alt',
  option: 'Alt',
  opt: 'Alt',
  shift: 'Shift',
}

const KEY_ALIASES: Record<string, string> = {
  return: 'Enter',
  esc: 'Escape',
  space: 'Space',
  del: 'Delete',
}

/** 修饰键的固定输出顺序，保证同一个组合只有一种规范写法 */
const MODIFIER_ORDER = ['Ctrl', 'Cmd', 'Super', 'Alt', 'Shift'] as const

function isModifier(name: string): boolean {
  return (MODIFIER_ORDER as readonly string[]).includes(name)
}

function normalizeKey(raw: string): string {
  const t = raw.trim()
  if (/^f([1-9]|1[0-9]|2[0-4])$/i.test(t)) return t.toUpperCase()
  if (t.length === 1) return t.toUpperCase()
  return t.charAt(0).toUpperCase() + t.slice(1)
}

/**
 * 把用户输入的加速键规范化为 Electron 认识的写法。
 *
 * 返回 undefined 表示**无效**，调用方必须明确拒绝而不是静默忽略：
 * - 空输入
 * - 只有修饰键、没有主键
 * - **无修饰键的单键** —— 这类注册会吃掉用户的正常输入
 *   （比如注册 "a" 之后用户再也打不出字母 a），必须拒
 */
export function normalizeAccelerator(raw: string): string | undefined {
  const trimmed = raw.trim()
  if (!trimmed) return undefined

  const parts = trimmed
    .split('+')
    .map((p) => p.trim())
    .filter(Boolean)
  if (parts.length === 0) return undefined

  const modifiers = new Set<string>()
  let key: string | undefined

  for (const part of parts) {
    const lower = part.toLowerCase()
    const modAlias = MODIFIER_ALIASES[lower]
    if (modAlias) {
      modifiers.add(modAlias)
      continue
    }
    // 最后出现的非修饰键作为主键
    key = KEY_ALIASES[lower] ?? normalizeKey(part)
  }

  if (!key) return undefined
  if (modifiers.size === 0) return undefined

  const ordered = MODIFIER_ORDER.filter((m) => modifiers.has(m))
  return [...ordered, key].join('+')
}

/**
 * 找出被多条绑定占用的加速键。
 *
 * 返回值包含所有加速键（含只被一条占用的），调用方用 `ids.length > 1` 判断冲突；
 * 这样也便于一次性看到全貌。
 */
export function findConflicts(bindings: readonly HotkeyBinding[]): Map<string, string[]> {
  const byAccel = new Map<string, string[]>()
  for (const b of bindings) {
    if (!b.enabled || !b.accelerator) continue
    const norm = normalizeAccelerator(b.accelerator)
    if (!norm) continue
    const list = byAccel.get(norm) ?? []
    list.push(b.id)
    byAccel.set(norm, list)
  }
  return byAccel
}

/** 按键别名表：任一写法命中即可（Electron 在不同平台给的 key 名不一致） */
const INPUT_KEY_ALIASES: Record<string, string[]> = {
  enter: ['enter', 'return'],
  escape: ['escape', 'esc'],
  space: [' ', 'space'],
  delete: ['delete', 'del'],
  backspace: ['backspace'],
  tab: ['tab'],
  up: ['arrowup', 'up'],
  down: ['arrowdown', 'down'],
  left: ['arrowleft', 'left'],
  right: ['arrowright', 'right'],
  pageup: ['pageup'],
  pagedown: ['pagedown'],
  home: ['home'],
  end: ['end'],
}

/** 把规范化后的 accelerator 与一次按键输入做匹配 */
export function matchesInput(input: KeyInput, accel: string): boolean {
  const parts = accel.split('+')
  const key = (parts[parts.length - 1] ?? '').toLowerCase()

  if (input.control !== parts.includes('Ctrl')) return false
  if (input.alt !== parts.includes('Alt')) return false
  if (input.shift !== parts.includes('Shift')) return false
  if (input.meta !== (parts.includes('Cmd') || parts.includes('Super'))) return false

  const inputKey = (input.key ?? '').toLowerCase()
  if (inputKey === key) return true

  const alts = INPUT_KEY_ALIASES[key]
  return alts ? alts.includes(inputKey) : false
}
