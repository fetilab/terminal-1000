// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

import type {
  KittyGraphicsCommand,
  KittyHostEvent,
  KittyMeta,
  KittyRequest,
  KittyResponse,
  KittyRow,
  KittySearchResult,
} from '@t1000/shared'
import { invoke } from '../../../lib/ipc'

/**
 * kitty 内核的渲染侧客户端。
 *
 * 责任边界：
 * - **一个 Worker** 进程内共享（每个窗口一个），里面可以开多个终端实例；
 * - 每个 `KittySession` 是一条会话的句柄，负责把字节喂进去、把帧交给渲染器；
 * - 请求/回复用自增 id 关联；帧与事件是单向推送（高频路径上不放 Promise）。
 *
 * 内核崩溃（WASM 未捕获异常 / OOM）时会把错误上报成 `fatal`，客户端据此
 * 触发一次整体重建，并把原因交给上层——上层会回落到 xterm，绝不出现「黑屏但没人知道」。
 */

export interface KittyFrame {
  meta: KittyMeta
  rows: KittyRow[]
  full: boolean
}

export interface KittySessionHandlers {
  onFrame: (frame: KittyFrame) => void
  onEvent: (event: KittyHostEvent) => void
  onFatal?: (message: string) => void
}

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void }

let workerRef: Worker | null = null
let readyRef: Promise<void> | null = null
let nextId = 1
const pending = new Map<number, Pending>()
const sessions = new Map<string, KittySession>()
const handlers = new Map<string, KittySessionHandlers>()

function decodeBase64(b64: string): ArrayBuffer {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i)
  return out.buffer
}

function ensureWorker(): Worker {
  if (workerRef) return workerRef
  const worker = new Worker(new URL('./worker.ts', import.meta.url), {
    type: 'module',
    name: 'kitty-vt',
  })
  worker.onmessage = (ev: MessageEvent<KittyResponse>): void => {
    const msg = ev.data
    switch (msg.t) {
      case 'ready':
        return
      case 'reply': {
        const p = pending.get(msg.id)
        if (!p) return
        pending.delete(msg.id)
        if (msg.ok) p.resolve(msg.value)
        else p.reject(new Error(msg.error))
        return
      }
      case 'frame': {
        handlers.get(msg.sessionId)?.onFrame({ meta: msg.meta, rows: msg.rows, full: msg.full })
        return
      }
      case 'state': {
        handlers.get(msg.sessionId)?.onFrame({ meta: msg.meta, rows: [], full: false })
        return
      }
      case 'event': {
        handlers.get(msg.sessionId)?.onEvent(msg.event)
        return
      }
      case 'write': {
        sessions.get(msg.sessionId)?.emitWrite(msg.data)
        return
      }
      case 'fatal': {
        for (const p of pending.values()) p.reject(new Error(msg.error))
        pending.clear()
        for (const h of handlers.values()) h.onFatal?.(msg.error)
        workerRef = null
        readyRef = null
        return
      }
      default:
        return
    }
  }
  worker.onerror = (ev): void => {
    const message = ev.message || 'kitty 内核线程异常退出'
    for (const p of pending.values()) p.reject(new Error(message))
    pending.clear()
    for (const h of handlers.values()) h.onFatal?.(message)
    workerRef = null
    readyRef = null
  }
  workerRef = worker
  return worker
}

function request<T>(msg: Omit<KittyRequest, 'id'> & { id?: number }, transfer: Transferable[] = []): Promise<T> {
  const worker = ensureWorker()
  const id = nextId++
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
    worker.postMessage({ ...msg, id } as KittyRequest, transfer)
  })
}

/** 预热内核（首帧之前调用；失败会被上层捕获并回落 xterm） */
export async function ensureKittyCore(): Promise<void> {
  if (readyRef) return readyRef
  readyRef = (async () => {
    ensureWorker()
    const asset = await invoke<'app', 'kittyWasm', Record<string, never>, { base64: string; bytes: number }>(
      'app',
      'kittyWasm',
      {},
    )
    const buffer = decodeBase64(asset.base64)
    await request<{ bytes: number }>({ t: 'init', wasm: buffer } as never, [buffer])
  })()
  try {
    await readyRef
  } catch (err) {
    readyRef = null
    throw err
  }
}

export class KittySession {
  readonly sessionId: string
  /** 内核因为查询要向 PTY 回写的字节（上层负责真正写入） */
  onWrite: ((data: string) => void) | null = null

  constructor(sessionId: string, h: KittySessionHandlers) {
    this.sessionId = sessionId
    handlers.set(sessionId, h)
  }

  static async open(
    sessionId: string,
    opts: { cols: number; rows: number; scrollback: number; handlers: KittySessionHandlers },
  ): Promise<KittySession> {
    await ensureKittyCore()
    const session = new KittySession(sessionId, opts.handlers)
    sessions.set(sessionId, session)
    await request({
      t: 'create',
      sessionId,
      cols: opts.cols,
      rows: opts.rows,
      scrollback: opts.scrollback,
    } as never)
    return session
  }

  emitWrite(data: string): void {
    this.onWrite?.(data)
  }

  /** 把远端输出喂进内核（零拷贝：chunk 的 buffer 直接转移） */
  write(chunk: ArrayBuffer | Uint8Array): void {
    const buf =
      chunk instanceof Uint8Array
        ? chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength)
        : chunk
    void request({ t: 'data', sessionId: this.sessionId, chunk: buf } as never, [buf]).catch(() => undefined)
  }

  resize(cols: number, rows: number): Promise<void> {
    return request<void>({ t: 'resize', sessionId: this.sessionId, cols, rows } as never)
  }

  key(key: string, mods: number, action: 'press' | 'repeat' | 'release' = 'press'): void {
    void request({ t: 'key', sessionId: this.sessionId, key, mods, action } as never).catch(() => undefined)
  }

  paste(text: string): void {
    void request({ t: 'paste', sessionId: this.sessionId, text } as never).catch(() => undefined)
  }

  mouse(spec: {
    x: number
    y: number
    button: 'left' | 'middle' | 'right' | 'none' | 'wheel-up' | 'wheel-down'
    action: 'press' | 'release' | 'move'
    mods: number
  }): void {
    void request({ t: 'mouse', sessionId: this.sessionId, ...spec } as never).catch(() => undefined)
  }

  focus(focused: boolean): void {
    void request({ t: 'focus', sessionId: this.sessionId, focused } as never).catch(() => undefined)
  }

  scroll(action: number | 'top' | 'bottom' | 'page-up' | 'page-down'): void {
    void request({ t: 'scroll', sessionId: this.sessionId, action } as never).catch(() => undefined)
  }

  selection(
    kind: 'start' | 'update' | 'clear',
    x: number,
    y: number,
    opts?: { rectangle?: boolean; ended?: boolean },
  ): Promise<{ text: string | null } | null> {
    return request<{ text: string | null } | null>({
      t: 'selection',
      sessionId: this.sessionId,
      kind,
      x,
      y,
      rectangle: opts?.rectangle,
      ended: opts?.ended,
    } as never)
  }

  search(pattern: string, step: 'first' | 'next' | 'prev' = 'first'): Promise<KittySearchResult> {
    return request<KittySearchResult>({ t: 'search', sessionId: this.sessionId, pattern, step } as never)
  }

  selectAll(): Promise<{ text: string | null }> {
    return request<{ text: string | null }>({ t: 'selectAll', sessionId: this.sessionId } as never)
  }

  serialize(): Promise<{ text: string }> {
    return request<{ text: string }>({ t: 'serialize', sessionId: this.sessionId } as never)
  }

  refresh(): void {
    void request({ t: 'refresh', sessionId: this.sessionId } as never).catch(() => undefined)
  }

  stats(): Promise<{ cols: number; rows: number; scrollback: number; title: string; cwd: string }> {
    return request({ t: 'stats', sessionId: this.sessionId } as never)
  }

  dispose(): void {
    sessions.delete(this.sessionId)
    handlers.delete(this.sessionId)
    void request({ t: 'dispose', sessionId: this.sessionId } as never).catch(() => undefined)
  }
}

/** 供图形协议解码使用：把 base64 载荷变成可交给 createImageBitmap 的 Blob */
export function graphicsToBlob(cmd: KittyGraphicsCommand): Blob | null {
  if (!cmd.payload) return null
  try {
    const bin = atob(cmd.payload)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i)
    if (cmd.format === 100) return new Blob([bytes], { type: 'image/png' })
    if (cmd.format === 24 || cmd.format === 32) {
      // 原始 RGB/RGBA：交给 createImageBitmap 前得先包成 ImageData，
      // 这里返回裸数据让调用方处理（宽高来自 s=/v=）
      return new Blob([bytes], { type: 'application/octet-stream' })
    }
    return new Blob([bytes])
  } catch {
    return null
  }
}
