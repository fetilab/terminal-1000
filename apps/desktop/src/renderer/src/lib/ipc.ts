// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

import type { EventName, EventPayloads, IpcDomain, IpcErrorCode, IpcResponse } from '@t1000/shared'

/** 主进程业务错误在渲染侧的表示 */
export class IpcCallError extends Error {
  readonly code: IpcErrorCode
  readonly detail?: unknown

  constructor(error: { code: IpcErrorCode; message: string; detail?: unknown }) {
    super(error.message)
    this.name = 'IpcCallError'
    this.code = error.code
    this.detail = error.detail
  }
}

/**
 * 调用主进程动作；失败时抛出 IpcCallError。
 * 返回类型由调用点通过泛型指定（契约在 packages/shared 的 Actions 中登记）。
 */
export async function invoke<D extends IpcDomain, A extends string, P, R>(
  domain: D,
  action: A,
  payload: P,
): Promise<R> {
  const res: IpcResponse<R> = await window.t1000.invoke<D, A, P, R>(domain, action, payload)
  if (!res.ok) throw new IpcCallError(res.error)
  return res.data
}

/** 订阅主进程事件 */
export function subscribe<E extends EventName>(
  event: E,
  listener: (payload: EventPayloads[E]) => void,
): () => void {
  return window.t1000.on(event, listener as (payload: never) => void)
}
