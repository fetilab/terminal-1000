// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 其余 Electron 模块的 Android 实现（都是"能力不存在"的形态）。
 *
 * 这些模块在主进程里用得很少，且 Android 上确实没有对应概念。
 * 原则：**接口保留、行为退化**，让调用方代码不用改，也不会因为缺能力而崩。
 * 每个退化点都在这里写明理由，避免以后有人以为"忘了实现"。
 */

import { native } from './native'

/* ── nativeImage ─────────────────────────────────────
 * Android 的图标是资源（res/mipmap），不用运行时构造 NativeImage。
 * 主进程用它取托盘/窗口图标 —— 两个概念在平板上都不存在，
 * 返回一个 isEmpty() 为 true 的占位对象，调用方（tray/icon）会自动降级。
 */
export interface NativeImageStub {
  isEmpty(): boolean
  getSize(): { width: number; height: number }
  toPNG(): Buffer
  resize(opts: { width?: number; height?: number }): NativeImageStub
}

function makeStubImage(width = 0, height = 0): NativeImageStub {
  const img: NativeImageStub = {
    isEmpty: () => width === 0 || height === 0,
    getSize: () => ({ width, height }),
    toPNG: () => Buffer.alloc(0),
    resize: () => img,
  }
  return img
}

export const nativeImage = {
  createFromPath(_path: string): NativeImageStub {
    return makeStubImage()
  },
  createFromBuffer(_buf: Buffer, _opts?: { width?: number; height?: number }): NativeImageStub {
    return makeStubImage()
  },
  createFromDataURL(_url: string): NativeImageStub {
    return makeStubImage()
  },
  createEmpty(): NativeImageStub {
    return makeStubImage()
  },
}

/* ── Menu / Tray ──────────────────────────────────────
 * 平板没有系统托盘（没有"最小化到托盘"的容器），也没有窗口菜单栏。
 * 托盘相关的设置项在 Android 上会"看起来没效果"—— 这是正确的：
 * 对应设置项在移动端 UI 里会被隐藏。
 */
export interface MenuItemConstructorOptions {
  label?: string
  type?: string
  click?: () => void
  enabled?: boolean
  visible?: boolean
  submenu?: unknown[]
}

export const Menu = {
  buildFromTemplate(_template: MenuItemConstructorOptions[]): { items: unknown[] } {
    return { items: [] }
  },
  setApplicationMenu(_menu: unknown): void {
    /* Android 无应用菜单 */
  },
  getApplicationMenu(): null {
    return null
  },
}

export class Tray {
  constructor(_icon?: unknown) {
    // 构造成功但什么都不做：主进程的 syncTray 会以为托盘可用，
    // 于是"最小化到托盘"会 hide() 窗口 —— 而 Android 上 hide 等于切后台。
    // 若这里抛错，主进程会走"托盘不可用"分支并直接退出，那更糟。
    console.log('[shim] Tray 在 Android 上为空实现')
  }
  setToolTip(_t: string): void {}
  setContextMenu(_m: unknown): void {}
  setImage(_i: unknown): void {}
  on(_e: string, _fn: () => void): this {
    return this
  }
  destroy(): void {}
  isDestroyed(): boolean {
    return false
  }
}

/* ── globalShortcut ───────────────────────────────────
 * Android 不允许普通 App 注册系统级组合热键（除媒体键，且要专项权限）。
 * 应用内快捷键（Ctrl+, / Ctrl+1..7 / Ctrl+Shift+F）由 WebView 的
 * keydown 处理，不经过这里 —— 因此 register 恒返回 false 不会影响它们。
 */
const registered = new Set<string>()

export const globalShortcut = {
  register(accelerator: string, _cb: () => void): boolean {
    registered.add(accelerator)
    return false
  },
  registerAll(_bindings: Array<{ accelerator: string }>): void {},
  unregister(_accelerator: string): void {
    registered.delete(_accelerator)
  },
  unregisterAll(): void {
    registered.clear()
  },
  isRegistered(accelerator: string): boolean {
    return registered.has(accelerator)
  },
}

/* ── powerMonitor ─────────────────────────────────────
 * 主进程用它做"空闲自动锁库"。Android 上拿到前台/后台状态更准确，
 * 由 Kotlin 侧通过 `power.state` 通知；这里先给一个"永不休眠"的
 * 保守值（返回 0），锁库仍可通过手动锁定与切后台触发。
 */
export const powerMonitor = {
  getSystemIdleTime(): number {
    return 0
  },
  getSystemIdleState(_threshold: number): 'active' | 'idle' | 'locked' | 'unknown' {
    return 'active'
  },
  on(_event: string, _fn: () => void): void {
    /* 生命周期事件由 Kotlin 通过 native 通道推送（见 bridge） */
  },
  removeListener(_event: string, _fn: () => void): void {},
  isOnBatteryPower(): boolean {
    return false
  },
}

/* ── nativeTheme ──────────────────────────────────────
 * 跟随系统深浅色。Kotlin 启动时把当前值报上来，之后随配置变更推送。
 */
export const nativeTheme = {
  themeSource: 'system' as 'system' | 'light' | 'dark',
  get shouldUseDarkColors(): boolean {
    return false
  },
  get shouldUseHighContrastColors(): boolean {
    return false
  },
  on(_event: string, _fn: () => void): void {},
}

/* ── Notification ─────────────────────────────────────
 * Android 需要 POST_NOTIFICATIONS 运行时权限（API 33+）。
 * 会话结束/备份完成这类通知走 Kotlin 的通知渠道。
 */
export class Notification {
  constructor(private readonly options: { title?: string; body?: string }) {}
  show(): void {
    void native
      .call('notify.show', { title: this.options.title ?? '', body: this.options.body ?? '' }, null)
      .catch(() => undefined)
  }
  close(): void {}
  static isSupported(): boolean {
    return true
  }
}
