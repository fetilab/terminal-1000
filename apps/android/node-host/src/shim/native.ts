// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * Node → Kotlin 的反向 RPC 通道。
 *
 * 为什么需要反向：主进程有相当一部分能力**只有原生侧能做**（文件选择器、
 * 系统剪贴板、用外部 App 打开文件/链接、退出进程）。在 Electron 里这些是
 * `dialog` / `clipboard` / `shell` / `app` 模块；在 Android 上它们分别对应
 * SAF、ClipboardManager、Intent 和 Activity 生命周期。
 *
 * 通道形态：Kotlin 作为 WebSocket **客户端**连到 `/native`，Node 侧保存这条
 * 连接并按请求 id 收发。走 WS 而不是 JNI，是因为 JNI 回调要处理线程附着，
 * 且 JSON 序列化在 JS 侧更自然。
 *
 * 降级原则：**原生侧没连上时绝不能让请求永久悬挂**。每个调用都有超时，
 * 超时或通道缺失时返回该能力"最小的安全默认值"（例如剪贴板读回空串、
 * 文件选择返回"已取消"），并在日志里留痕。这样即使壳有问题，
 * 主进程依然能启动、设置能读写、SSH 能连接。
 */

import { EventEmitter } from 'node:events'
import type { WebSocket } from 'ws'

/** 超时分级：本地即时能力给短的，需要用户操作的给长的 */
const TIMEOUT_MS: Record<string, number> = {
  'dialog.open': 10 * 60_000,
  'dialog.save': 10 * 60_000,
  'dialog.message': 10 * 60_000,
  'dialog.confirm': 10 * 60_000,
}
const DEFAULT_TIMEOUT_MS = 15_000

interface Pending {
  resolve: (v: unknown) => void
  reject: (e: Error) => void
  timer: NodeJS.Timeout
  method: string
}

export interface NativeStatus {
  connected: boolean
  /** Kotlin 上报的屏幕信息（dp），用于窗口尺寸模拟 */
  screen: { width: number; height: number; density: number } | null
}

class NativeBridge extends EventEmitter {
  private socket: WebSocket | null = null
  private nextId = 1
  private pending = new Map<number, Pending>()
  private status: NativeStatus = { connected: false, screen: null }

  attach(socket: WebSocket): void {
    // 同一时刻只保留一条原生连接：重复连接说明壳重建了，旧的那条已经没有回应者
    if (this.socket && this.socket !== socket) {
      try {
        this.socket.close()
      } catch {
        /* 已关闭 */
      }
    }
    this.socket = socket
    this.status = { ...this.status, connected: true }

    socket.on('message', (raw: Buffer | string) => {
      this.handleMessage(raw.toString())
    })
    socket.on('close', () => {
      if (this.socket === socket) {
        this.socket = null
        this.status = { ...this.status, connected: false }
      }
      this.failAll('原生通道已断开')
      this.emit('disconnect')
    })
    socket.on('error', (err: Error) => {
      console.error('[native] 通道错误:', err.message)
    })

    this.emit('connect')
  }

  private handleMessage(text: string): void {
    let msg: Record<string, unknown>
    try {
      msg = JSON.parse(text) as Record<string, unknown>
    } catch {
      console.error('[native] 收到非 JSON 消息，已忽略')
      return
    }

    // 响应包：{ id, ok, data|error }
    const id = msg['id']
    if (typeof id === 'number') {
      const p = this.pending.get(id)
      if (!p) return
      this.pending.delete(id)
      clearTimeout(p.timer)
      if (msg['ok'] === false) {
        p.reject(new Error(String(msg['error'] ?? '原生调用失败')))
      } else {
        p.resolve(msg['data'])
      }
      return
    }

    // 通知包：{ type: '...' , ... }
    const type = msg['type']
    if (typeof type === 'string') {
      if (type === 'screen') {
        const s = msg['screen'] as NativeStatus['screen']
        if (s && typeof s.width === 'number') this.status = { ...this.status, screen: s }
      }
      this.emit(type, msg)
    }
  }

  private failAll(reason: string): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer)
      p.reject(new Error(reason))
    }
    this.pending.clear()
  }

  get isConnected(): boolean {
    return this.socket !== null && this.socket.readyState === 1
  }

  get screen(): NativeStatus['screen'] {
    return this.status.screen
  }

  /**
   * 调用原生方法。
   *
   * `fallback` 是通道不可用时的返回值 —— 传入它表示"这个能力缺失可以接受"。
   * 不传则抛错（调用方自己决定怎么处理）。
   */
  async call<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    fallback?: T,
  ): Promise<T> {
    if (!this.isConnected) {
      if (fallback !== undefined) {
        console.warn(`[native] ${method}: 原生通道未连接，返回降级值`)
        return fallback
      }
      throw new Error(`原生通道未连接，无法执行 ${method}`)
    }

    const id = this.nextId++
    const timeoutMs = TIMEOUT_MS[method] ?? DEFAULT_TIMEOUT_MS

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        if (fallback !== undefined) {
          console.warn(`[native] ${method}: 超时 ${timeoutMs}ms，返回降级值`)
          resolve(fallback)
        } else {
          reject(new Error(`原生调用超时（${method}）`))
        }
      }, timeoutMs)

      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
        method,
      })

      try {
        this.socket!.send(JSON.stringify({ id, method, params }))
      } catch (err) {
        this.pending.delete(id)
        clearTimeout(timer)
        if (fallback !== undefined) resolve(fallback)
        else reject(err instanceof Error ? err : new Error(String(err)))
      }
    })
  }
}

export const native = new NativeBridge()
