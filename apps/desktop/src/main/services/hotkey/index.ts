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
import { findConflicts, matchFirst, normalizeAccelerator, type KeyInput } from './accelerator'

// 纯逻辑（规范化/冲突检测/按键匹配）在 ./accelerator，本文件只负责与 Electron 打交道
export { findConflicts, matchesInput, normalizeAccelerator } from './accelerator'

const log = createLogger('hotkey')

/** 当前注册结果（bindingId → 状态），供 list 与状态广播使用 */
let registrations = new Map<string, HotkeyRegistration>()

/** 一条应用内绑定：规范化后的加速键 + 它对应的 binding */
interface InAppEntry {
  accel: string
  binding: HotkeyBinding
}

/**
 * 单个窗口的应用内快捷键状态。
 *
 * ⚠️ 关键约束：**一个窗口只挂一条 `before-input-event`**，`entries` 是查表用的。
 *
 * 早先是「每个应用内绑定各挂一条监听器」。默认配置 14 个快捷键里有 11 个是
 * 应用内的，于是启动就往 stderr 打：
 *
 *   MaxListenersExceededWarning: Possible EventEmitter memory leak detected.
 *   11 before-input-event listeners added to [WebContents]. MaxListeners is 10.
 *
 * 数量其实是固定的、不会真的无限增长，但两个后果是实的：每按一个键 11 个回调
 * 全部跑一遍；控制台常驻一条看着像崩溃的警告（Windows 上会直接开个黑窗口显示
 * 它，用户第一眼看到的就是这行字）。
 *
 * 改成单 dispatcher 后监听器数量恒为 1，按键只走一次表查找。
 */
interface InAppState {
  entries: InAppEntry[]
  dispatcher: (e: unknown, input: KeyInput) => void
}
const inAppState = new WeakMap<BrowserWindow, InAppState>()

let activeCtx: IpcContext | null = null

// ── 注册与撤销 ───────────────────────────────────────

function emitTriggered(ctx: IpcContext, binding: HotkeyBinding, source: 'global' | 'in-app'): void {
  /*
   * app.toggleWindow 必须在主进程就地执行：全局键在**应用未聚焦**时触发，
   * 此时窗口可能是隐藏的 —— 渲染层虽然还活着、能收到事件，但"把窗口显示出来
   * 并抢焦点"是窗口管理操作，只有主进程能做对。
   */
  if (binding.command === 'app.toggleWindow') {
    void toggleMainWindow()
    return
  }
  ctx.emit(Events.HOTKEY_TRIGGERED, {
    bindingId: binding.id,
    command: binding.command,
    source,
  })
}

/** 显示 / 隐藏主窗口（托盘常驻场景下 = 一键呼出/收起） */
async function toggleMainWindow(): Promise<void> {
  try {
    const { getMainWindow } = await import('../../window')
    const win = getMainWindow()
    if (!win) return
    if (win.isVisible() && win.isFocused()) {
      win.hide()
    } else {
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
    }
  } catch (err) {
    log.warn('切换窗口可见性失败', err)
  }
}

/** 卸载全部已注册的快捷键（含窗口级监听） */
export function unregisterAll(): void {
  try {
    globalShortcut.unregisterAll()
  } catch (err) {
    log.warn('注销全局快捷键失败', err)
  }
  for (const win of BrowserWindow.getAllWindows()) {
    const state = inAppState.get(win)
    if (!state) continue
    win.webContents.removeListener('before-input-event', state.dispatcher as never)
    inAppState.delete(win)
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

/**
 * 给单个窗口挂应用内快捷键监听（窗口新建时也要调用）。
 *
 * 只会往表里加/更新一条绑定；`before-input-event` 监听器**每窗口至多一条**，
 * 首次调用时挂上，之后复用（见 `InAppState` 的注释）。
 */
export function attachInApp(win: BrowserWindow, accel: string, binding: HotkeyBinding): void {
  let state = inAppState.get(win)
  if (!state) {
    /*
     * 单 dispatcher：一次按键只走一遍表查找。
     *
     * 必须 preventDefault：`before-input-event` 不拦的话按键会继续送进渲染层，
     * 终端就会把它当普通输入编码给 PTY（Ctrl+1 → `1`、Ctrl+K → `^K`）。
     * 那样既是"快捷键和终端同时响应"，也会把垃圾字符塞进用户的命令里。
     */
    const created: InAppState = {
      entries: [],
      dispatcher: (e, input) => {
        if (!activeCtx) return
        const hit = matchFirst(created.entries, input)
        if (!hit) return
        const ev = e as { preventDefault?: () => void }
        ev.preventDefault?.()
        emitTriggered(activeCtx, hit.binding, 'in-app')
      },
    }
    win.webContents.on('before-input-event', created.dispatcher as never)
    inAppState.set(win, created)
    state = created
  }

  // 按 accelerator 去重：同键重复注册时用最新的 binding 覆盖旧的。
  // （早先这里靠「数组里找同 accel 的监听器再 remove」，换成查表后只需覆盖条目。）
  const existing = state.entries.findIndex((item) => item.accel === accel)
  if (existing >= 0) {
    state.entries[existing] = { accel, binding }
  } else {
    state.entries.push({ accel, binding })
  }
}

/**
 * 窗口**新建时**把当前已启用的应用内绑定全部挂上去。
 *
 * `registerFromSettings` 只覆盖注册那一刻存在的窗口 —— 主窗口销毁重建
 * （或将来出现第二个窗口）后不补挂的话，应用内快捷键就全部静默失效，
 * 而注册状态里还显示"生效"，用户无从排查。
 */
export function attachAllInApp(win: BrowserWindow): void {
  const bindings = getSettings().hotkeys ?? []
  for (const binding of bindings) {
    if (!binding.enabled || binding.global) continue
    const accel = binding.accelerator ? normalizeAccelerator(binding.accelerator) : undefined
    if (!accel) continue
    attachInApp(win, accel, binding)
  }
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
