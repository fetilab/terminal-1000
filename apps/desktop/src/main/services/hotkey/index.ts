// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * hotkey 域：把设置里的快捷键配置**真正注册到 Electron**。
 *
 * 双通道（对齐参考实现的做法）：
 * - `global === true` → `globalShortcut`，应用未聚焦也生效
 * - `global === false` → 每个窗口的 `before-input-event`，仅应用内生效
 *
 * 为什么两条都要：
 * 全局快捷键会**抢占系统级按键**，滥用会干扰用户在其它程序里的操作；
 * 而纯应用内的按键用 globalShortcut 注册是过度索取。让用户按需选择。
 *
 * 状态如实上报：注册失败（最常见是被其它程序占用）必须回传原因，
 * 否则用户按了没反应会以为是自己按错。
 */

import { BrowserWindow, globalShortcut } from 'electron'
import { z } from 'zod'
import { Events, type HotkeyBinding, type HotkeyRegistration } from '@t1000/shared'
import { AppError, parseInput } from '../../errors'
import type { IpcContext, IpcHandler } from '../../ipc/router'
import { createLogger } from '../../logger'
import { getSettings, updateSettings } from '../settings'
import { DEFAULT_HOTKEYS } from '../settings'
import { findConflicts, matchesInput, normalizeAccelerator, type KeyInput } from './accelerator'

// 纯逻辑（规范化/冲突检测/按键匹配）在 ./accelerator，本文件只负责与 Electron 打交道
export { findConflicts, matchesInput, normalizeAccelerator } from './accelerator'

const log = createLogger('hotkey')

/** 当前注册结果（bindingId → 状态），供 list 与状态广播使用 */
let registrations = new Map<string, HotkeyRegistration>()

/** 应用内按键的监听器（需要时移除，避免重复注册） */
const inputListeners = new WeakMap<BrowserWindow, (e: unknown, input: KeyInput) => void>()

let activeCtx: IpcContext | null = null

// ── 注册与撤销 ───────────────────────────────────────

function emitTriggered(ctx: IpcContext, binding: HotkeyBinding, source: 'global' | 'in-app'): void {
  ctx.emit(Events.HOTKEY_TRIGGERED, {
    bindingId: binding.id,
    command: binding.command,
    source,
  })
}

/** 卸载全部已注册的快捷键（含窗口级监听） */
export function unregisterAll(): void {
  try {
    globalShortcut.unregisterAll()
  } catch (err) {
    log.warn('注销全局快捷键失败', err)
  }
  for (const win of BrowserWindow.getAllWindows()) {
    const listener = inputListeners.get(win)
    if (listener) {
      win.webContents.removeListener('before-input-event', listener as never)
      inputListeners.delete(win)
    }
  }
  registrations = new Map()
}

/**
 * 从设置读取并注册全部快捷键。
 * 幂等：可反复调用（设置变更后调用它即可热生效）。
 */
export function registerFromSettings(ctx: IpcContext): HotkeyRegistration[] {
  activeCtx = ctx
  unregisterAll()

  const bindings = getSettings().hotkeys ?? []
  const next = new Map<string, HotkeyRegistration>()
  const conflicts = findConflicts(bindings)

  for (const binding of bindings) {
    const accel = binding.accelerator ? normalizeAccelerator(binding.accelerator) : undefined

    const base: HotkeyRegistration = {
      bindingId: binding.id,
      command: binding.command,
      ...(binding.accelerator !== undefined ? { accelerator: binding.accelerator } : {}),
      global: binding.global,
      enabled: binding.enabled,
      registered: false,
    }

    if (!binding.enabled) {
      next.set(binding.id, { ...base, error: '已禁用' })
      continue
    }
    if (!accel) {
      // 无修饰键的单键会被拒绝，这里给出明确原因而不是静默忽略
      next.set(binding.id, { ...base, error: '无效的快捷键（必须含修饰键，如 Ctrl/Alt/Shift/Cmd）' })
      continue
    }

    const sharingIds = conflicts.get(accel)
    if (sharingIds && sharingIds.length > 1) {
      next.set(binding.id, {
        ...base,
        error: `与其他快捷键冲突：${sharingIds.filter((id) => id !== binding.id).join(', ')}`,
      })
      continue
    }

    if (binding.global) {
      try {
        const ok = globalShortcut.register(accel, () => {
          if (activeCtx) emitTriggered(activeCtx, binding, 'global')
        })
        next.set(
          binding.id,
          ok ? { ...base, accelerator: accel, registered: true } : { ...base, accelerator: accel, error: '该快捷键已被系统或其它程序占用' },
        )
      } catch (err) {
        next.set(binding.id, {
          ...base,
          accelerator: accel,
          error: err instanceof Error ? err.message : '注册失败',
        })
      }
    } else {
      // 应用内：挂到每个窗口的 before-input-event
      let attached = false
      for (const win of BrowserWindow.getAllWindows()) {
        attachInApp(win, accel, binding)
        attached = true
      }
      next.set(
        binding.id,
        attached
          ? { ...base, accelerator: accel, registered: true }
          : { ...base, accelerator: accel, error: '当前没有可用窗口' },
      )
    }
  }

  registrations = next
  const list = [...next.values()]
  const failed = list.filter((r) => !r.registered && r.enabled).length
  log.info(`快捷键已加载：${list.filter((r) => r.registered).length} 个生效${failed > 0 ? `，${failed} 个未生效` : ''}`)

  ctx.emit(Events.HOTKEY_STATUS, { registrations: list })
  return list
}

/** 给单个窗口挂应用内快捷键监听（窗口新建时也要调用） */
export function attachInApp(win: BrowserWindow, accel: string, binding: HotkeyBinding): void {
  // 同一窗口同一 accelerator 不重复挂
  const existing = inputListeners.get(win)
  if (existing) {
    win.webContents.removeListener('before-input-event', existing as never)
    inputListeners.delete(win)
  }

  // Electron 的 Input 结构上兼容 KeyInput（control/alt/shift/meta/key），
  // 这里用最小形状接收，避免把 electron 类型渗进纯逻辑
  const listener = (_e: unknown, input: KeyInput): void => {
    if (!activeCtx) return
    if (matchesInput(input, accel)) {
      emitTriggered(activeCtx, binding, 'in-app')
    }
  }
  win.webContents.on('before-input-event', listener as never)
  inputListeners.set(win, listener)
}

/** 把 Electron 的 Input 与规范化后的 accelerator 做匹配 */
export function matchesInputStub(input: KeyInput, accel: string): boolean {
  const parts = accel.split('+')
  const key = parts[parts.length - 1]
  const needCtrl = parts.includes('Ctrl')
  const needAlt = parts.includes('Alt')
  const needShift = parts.includes('Shift')
  const needMeta = parts.includes('Cmd') || parts.includes('Super')

  if (input.control !== needCtrl) return false
  if (input.alt !== needAlt) return false
  if (input.shift !== needShift) return false
  if (input.meta !== needMeta) return false

  const inputKey = (input.key ?? '').toLowerCase()
  const target = (key ?? '').toLowerCase()
  if (inputKey === target) return true

  // 常见别名
  const ALIAS: Record<string, string[]> = {
    enter: ['enter', 'return'],
    escape: ['escape', 'esc'],
    space: [' ', 'space'],
    delete: ['delete', 'del'],
    arrowup: ['arrowup', 'up'],
    arrowdown: ['arrowdown', 'down'],
    arrowleft: ['arrowleft', 'left'],
    arrowright: ['arrowright', 'right'],
  }
  const alts = ALIAS[target]
  return alts ? alts.includes(inputKey) : false
}

/** 应用退出前注销，避免占用系统快捷键 */
export function shutdownHotkeys(): void {
  unregisterAll()
}

// ── IPC ─────────────────────────────────────────────

const setBindingSchema = z.object({
  id: z.string().min(1),
  accelerator: z.string().nullable().optional(),
  global: z.boolean().optional(),
  enabled: z.boolean().optional(),
})

export const hotkeyHandlers: Record<string, IpcHandler> = {
  list: (_payload, ctx) => {
    // 首次调用时若还没注册过，就先按设置注册一遍
    if (registrations.size === 0) return registerFromSettings(ctx)
    return [...registrations.values()]
  },

  reload: (_payload, ctx) => registerFromSettings(ctx),

  /** 改一条绑定并立即生效（返回新的注册状态） */
  setBinding: (payload, ctx) => {
    const patch = parseInput(setBindingSchema, payload)
    const bindings = getSettings().hotkeys ?? []
    const idx = bindings.findIndex((b) => b.id === patch.id)
    if (idx === -1) throw AppError.notFound(`快捷键绑定不存在: ${patch.id}`)

    const current = bindings[idx]!
    const updated: HotkeyBinding = {
      ...current,
      ...(patch.accelerator !== undefined
        ? patch.accelerator === null
          ? { accelerator: undefined }
          : { accelerator: patch.accelerator }
        : {}),
      ...(patch.global !== undefined ? { global: patch.global } : {}),
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
    }

    // 校验加速键：无效就明确拒绝，不要存进去等注册时才发现
    if (updated.accelerator) {
      const norm = normalizeAccelerator(updated.accelerator)
      if (!norm) {
        throw AppError.badRequest('无效的快捷键：必须包含修饰键（Ctrl/Alt/Shift/Cmd）')
      }
      updated.accelerator = norm
    }

    const nextBindings = [...bindings]
    nextBindings[idx] = updated
    updateSettings({ hotkeys: nextBindings })

    return { registrations: registerFromSettings(ctx), binding: updated }
  },

  reset: (_payload, ctx) => {
    updateSettings({ hotkeys: DEFAULT_HOTKEYS.map((k) => ({ ...k })) })
    return { registrations: registerFromSettings(ctx) }
  },
}
