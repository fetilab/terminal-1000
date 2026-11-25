// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 主进程 → WebView 的事件出口。
 *
 * 单独成一个模块是为了**断开循环依赖**：`window.ts`（webContents.send）与
 * `ipc.ts`（event.sender.send）都要发事件，而真正的 WS 连接由 `bridge/server.ts`
 * 持有。三者互相 import 会成环，这里做一个单向的注入口。
 */

type Sink = (event: string, payload: unknown) => void

let sink: Sink | null = null

/** 由 bridge/server.ts 在 WS 服务就绪后注入 */
export function setEventSink(fn: Sink | null): void {
  sink = fn
}

/**
 * 向 WebView 推送事件。
 *
 * 没有连接时**静默丢弃**（与 Electron 里"窗口已销毁还 send"的处理一致）：
 * 推送是尽力而为的，丢一条状态更新远好于让调用方抛错。
 */
export function emitToWebView(event: string, payload: unknown): void {
  if (!sink) return
  try {
    sink(event, payload)
  } catch (err) {
    console.error(`[outbound] 推送事件 ${event} 失败:`, err)
  }
}
