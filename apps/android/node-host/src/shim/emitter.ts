// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 最小 EventEmitter（语义对齐 Node 的 EventEmitter）。
 *
 * 为什么不用 `node:events`：能直接用。这里自己实现只是为了让 shim 层的
 * 行为完全可控（尤其 `once` 与"抛错不打断其它监听器"的取舍），
 * 并且它同时被 app / BrowserWindow / webContents 复用。
 */

export type Listener = (...args: unknown[]) => void

export class Emitter {
  private listeners = new Map<string, Set<Listener>>()

  on(event: string, fn: Listener): this {
    let set = this.listeners.get(event)
    if (!set) {
      set = new Set()
      this.listeners.set(event, set)
    }
    set.add(fn)
    return this
  }

  addListener(event: string, fn: Listener): this {
    return this.on(event, fn)
  }

  once(event: string, fn: Listener): this {
    const wrap: Listener = (...args) => {
      this.removeListener(event, wrap)
      fn(...args)
    }
    return this.on(event, wrap)
  }

  removeListener(event: string, fn: Listener): this {
    this.listeners.get(event)?.delete(fn)
    return this
  }

  off(event: string, fn: Listener): this {
    return this.removeListener(event, fn)
  }

  removeAllListeners(event?: string): this {
    if (event === undefined) this.listeners.clear()
    else this.listeners.delete(event)
    return this
  }

  listenerCount(event: string): number {
    return this.listeners.get(event)?.size ?? 0
  }

  eventNames(): string[] {
    return [...this.listeners.keys()]
  }

  /**
   * 触发事件。
   *
   * 单个监听器抛错**不影响**其它监听器 —— 与 Electron 的 webContents 行为一致：
   * 某个订阅者写错不该让"关闭窗口"这类广播整体失败。
   */
  emit(event: string, ...args: unknown[]): boolean {
    const set = this.listeners.get(event)
    if (!set || set.size === 0) return false
    for (const fn of [...set]) {
      try {
        fn(...args)
      } catch (err) {
        console.error(`[shim] 事件 ${event} 的监听器抛错:`, err)
      }
    }
    return true
  }
}
