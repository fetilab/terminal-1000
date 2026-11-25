// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * `BrowserWindow` / `webContents` / `screen` 的 Android 实现。
 *
 * Android 上只有一个 Activity、一个 WebView，所以这里不做真正的"窗口管理"，
 * 而是**忠实地模拟窗口状态**，让主进程里那套窗口生命周期逻辑（位置记忆、
 * 关闭确认、最小化到托盘、新窗口重建）可以原样运行：
 *
 * - `webContents.send()` → 通过回环 WS 推给 WebView（事件流的唯一出口）；
 * - `loadURL` / `loadFile` → 转成一条原生调用，由 Kotlin 真正 `loadUrl`；
 * - `on('close'/'closed'/…)` → 由 Kotlin 在 Activity 生命周期节点上触发。
 *
 * 之所以要"模拟"而不是删掉这些代码：`main/index.ts` 里的关闭流程
 * （确认对话框 → 最小化 → 真退出）是有实际价值的用户行为，
 * 在平板上对应"返回键 / 任务切换"的语义，不该因为换平台就丢掉。
 */

import { Emitter } from './emitter'
import { native } from './native'
import { emitToWebView } from './outbound'

export interface Rectangle {
  x: number
  y: number
  width: number
  height: number
}

export interface Display {
  id: number
  bounds: Rectangle
  workArea: Rectangle
  scaleFactor: number
  size: { width: number; height: number }
}

/** 默认画布：平板横屏。真实值由 Kotlin 通过 screen 消息覆盖 */
const FALLBACK_W = 1280
const FALLBACK_H = 800

function currentDisplay(): Display {
  const s = native.screen
  const width = s?.width ?? FALLBACK_W
  const height = s?.height ?? FALLBACK_H
  const bounds: Rectangle = { x: 0, y: 0, width, height }
  return { id: 1, bounds, workArea: bounds, scaleFactor: s?.density ?? 2, size: { width, height } }
}

class WebContents extends Emitter {
  readonly id = 1
  private openHandler: ((details: { url: string }) => { action: 'deny' | 'allow' }) | null = null

  /** 推事件给 WebView。这是主进程所有 `broadcast()` 的最终落点 */
  send(channel: string, payload: unknown): void {
    emitToWebView(channel, payload)
  }

  setWindowOpenHandler(handler: (details: { url: string }) => { action: 'deny' | 'allow' }): void {
    this.openHandler = handler
  }

  /** 由 Kotlin 在 window.open / 链接点击时回调 */
  handleWindowOpen(url: string): { action: 'deny' | 'allow' } {
    if (!this.openHandler) return { action: 'deny' }
    try {
      return this.openHandler({ url })
    } catch {
      return { action: 'deny' }
    }
  }
}

export interface BrowserWindowOptions {
  width?: number
  height?: number
  minWidth?: number
  minHeight?: number
  show?: boolean
  title?: string
  backgroundColor?: string
  autoHideMenuBar?: boolean
  icon?: string
  x?: number
  y?: number
  webPreferences?: Record<string, unknown>
}

export class BrowserWindow extends Emitter {
  static readonly instances = new Set<BrowserWindow>()

  readonly webContents = new WebContents()

  private destroyed = false
  private visible: boolean
  private minimized = false
  private maximized = false
  private focused = false
  private bounds: Rectangle
  private readonly normalBounds: Rectangle
  private readonly options: BrowserWindowOptions

  constructor(options: BrowserWindowOptions = {}) {
    super()
    this.options = options
    const disp = currentDisplay()
    const width = options.width ?? disp.workArea.width
    const height = options.height ?? disp.workArea.height
    this.bounds = { x: options.x ?? 0, y: options.y ?? 0, width, height }
    this.normalBounds = { ...this.bounds }
    this.visible = options.show ?? false

    BrowserWindow.instances.add(this)
  }

  // ── 状态查询 ──
  isDestroyed(): boolean {
    return this.destroyed
  }

  isVisible(): boolean {
    return this.visible && !this.destroyed
  }

  isMinimized(): boolean {
    return this.minimized
  }

  isMaximized(): boolean {
    return this.maximized
  }

  isFocused(): boolean {
    return this.focused
  }

  getBounds(): Rectangle {
    return { ...this.bounds }
  }

  getNormalBounds(): Rectangle {
    return { ...this.normalBounds }
  }

  // ── 状态变更（同步通知 Kotlin，异步不阻塞主进程逻辑） ──
  show(): void {
    if (this.destroyed) return
    this.visible = true
    void native.call('window.show', {}, null).catch(() => undefined)
  }

  hide(): void {
    if (this.destroyed) return
    this.visible = false
    void native.call('window.hide', {}, null).catch(() => undefined)
  }

  focus(): void {
    if (this.destroyed) return
    this.focused = true
    void native.call('window.focus', {}, null).catch(() => undefined)
  }

  restore(): void {
    this.minimized = false
  }

  maximize(): void {
    this.maximized = true
    const disp = currentDisplay()
    this.bounds = { ...disp.workArea }
  }

  minimize(): void {
    this.minimized = true
  }

  setTitle(title: string): void {
    void native.call('window.setTitle', { title }, null).catch(() => undefined)
  }

  close(): void {
    if (this.destroyed) return
    // 与 Electron 一致：先发 close（可被 preventDefault 拦下），再 closed
    const prevent = { prevented: false }
    this.emit('close', { preventDefault: () => (prevent.prevented = true) })
    if (prevent.prevented) return
    this.destroy()
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.visible = false
    this.emit('closed')
    BrowserWindow.instances.delete(this)
  }

  // ── 页面加载：交给 Kotlin 的 WebView ──
  loadURL(url: string): Promise<void> {
    console.log(`[window] loadURL ${url}`)
    void native.call('window.load', { url }, null).catch((err: Error) => {
      console.error('[window] 通知原生加载失败:', err.message)
    })
    return Promise.resolve()
  }

  loadFile(file: string): Promise<void> {
    console.log(`[window] loadFile ${file}`)
    void native.call('window.load', { file }, null).catch((err: Error) => {
      console.error('[window] 通知原生加载失败:', err.message)
    })
    return Promise.resolve()
  }

  // ── 供 Kotlin 回调的入口 ──
  /** WebView 首帧就绪 */
  notifyReadyToShow(): void {
    this.emit('ready-to-show')
  }

  /** Activity 触发关闭（返回键 / 划掉任务） */
  requestClose(): void {
    this.close()
  }

  notifyResize(width: number, height: number): void {
    this.bounds = { ...this.bounds, width, height }
    this.emit('resize')
  }

  notifyFocus(focused: boolean): void {
    this.focused = focused
    this.emit(focused ? 'focus' : 'blur')
  }

  static getAllWindows(): BrowserWindow[] {
    return [...BrowserWindow.instances].filter((w) => !w.isDestroyed())
  }

  static fromWebContentsId(id: number): BrowserWindow | null {
    if (id !== 1) return null
    return BrowserWindow.getAllWindows()[0] ?? null
  }
}

/** `screen` 模块：Android 上只有一个（或分屏时两个）真实显示区 */
export const screen = {
  getAllDisplays(): Display[] {
    return [currentDisplay()]
  },
  getPrimaryDisplay(): Display {
    return currentDisplay()
  },
  getCursorScreenPoint(): { x: number; y: number } {
    // Android 没有全局光标概念；返回屏幕中心，避免调用方拿到 0,0 后误判"在左上角"
    const d = currentDisplay()
    return { x: d.workArea.width / 2, y: d.workArea.height / 2 }
  },
}
