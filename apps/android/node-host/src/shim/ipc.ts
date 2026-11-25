// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * `ipcMain` 的 Android 实现。
 *
 * 语义与 Electron 保持一致，主进程代码（`main/index.ts`）才能原样运行：
 * - `handle()` 注册**请求-响应**处理器（同一通道重复注册抛错，与原版一致）；
 * - 第一个参数是"事件对象"，主进程只用到 `sender`，这里给一个占位。
 *
 * 真正的传输由 `bridge/server.ts` 负责：它把 WebSocket 上收到的请求交给
 * `invokeChannel()`，后者再转给这里注册的处理器 —— 也就是说
 * **Electron 的 IPC 通道被完整替换成了回环 WS，业务代码感知不到区别**。
 */

import { Emitter } from './emitter'
import { emitToWebView } from './outbound'

export type IpcHandler = (event: IpcEvent, ...args: unknown[]) => unknown

/** 事件对象的占位：主进程侧只读 `sender`（用于回推），这里指向事件出口 */
export interface IpcEvent {
  sender: {
    id: number
    send: (channel: string, payload: unknown) => void
    isDestroyed: () => boolean
  }
}

const handlers = new Map<string, IpcHandler>()
const listeners = new Emitter()

/** 处理器是否已经注册（WebView 可能先于主进程初始化就发出请求） */
let pendingReady: Array<() => void> = []

const fakeEvent: IpcEvent = {
  sender: {
    id: 1,
    send: (channel, payload) => emitToWebView(channel, payload),
    isDestroyed: () => false,
  },
}

export function getIpcEvent(): IpcEvent {
  return fakeEvent
}

export const ipcMain = {
  handle(channel: string, fn: IpcHandler): void {
    if (handlers.has(channel)) {
      // 与 Electron 一致：重复注册是编程错误，必须显式暴露
      throw new Error(`IPC handler 重复注册: ${channel}`)
    }
    handlers.set(channel, fn)
    if (pendingReady.length > 0) {
      const waiting = pendingReady
      pendingReady = []
      for (const resolve of waiting) resolve()
    }
  },

  handleOnce(channel: string, fn: IpcHandler): void {
    const wrap: IpcHandler = (event, ...args) => {
      ipcMain.removeHandler(channel)
      return fn(event, ...args)
    }
    ipcMain.handle(channel, wrap)
  },

  removeHandler(channel: string): void {
    handlers.delete(channel)
  },

  /** 单向消息（Electron 里是 renderer → main 的 send/on） */
  on(channel: string, fn: (...args: unknown[]) => void): void {
    listeners.on(channel, fn)
  },

  once(channel: string, fn: (...args: unknown[]) => void): void {
    listeners.once(channel, fn)
  },

  off(channel: string, fn: (...args: unknown[]) => void): void {
    listeners.removeListener(channel, fn)
  },

  removeAllListeners(channel?: string): void {
    listeners.removeAllListeners(channel)
  },

  emit(channel: string, ...args: unknown[]): boolean {
    return listeners.emit(channel, ...args)
  },

  /** 是否已有该通道的处理器（测试与诊断用） */
  hasHandler(channel: string): boolean {
    return handlers.has(channel)
  },
}

/**
 * 调用已注册的处理器。
 *
 * 等待处理器就绪：WebView 首屏可能比 `registerAllHandlers()` 早几毫秒。
 * 等待有上限，超时后按"未注册"处理，避免请求永久悬挂。
 */
export async function invokeChannel(
  channel: string,
  args: unknown[],
  waitMs = 15_000,
): Promise<unknown> {
  if (!handlers.has(channel)) {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, waitMs)
      pendingReady.push(() => {
        clearTimeout(timer)
        resolve()
      })
    })
  }
  const fn = handlers.get(channel)
  if (!fn) {
    throw new Error(`没有注册 IPC 处理器: ${channel}`)
  }
  return fn(fakeEvent, ...args)
}
