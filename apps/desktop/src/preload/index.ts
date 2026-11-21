// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

import { contextBridge, ipcRenderer } from 'electron'
import { IPC_CHANNEL, ipcRequest, type IpcDomain, type IpcResponse } from '@t1000/shared'

/** 订阅事件的取消函数 */
export type Unsubscribe = () => void

export interface T1000Bridge {
  /** 调用主进程动作 */
  invoke<D extends IpcDomain, A extends string, P, R = unknown>(
    domain: D,
    action: A,
    payload: P,
  ): Promise<IpcResponse<R>>
  /** 订阅主进程事件流 */
  on(event: string, listener: (payload: never) => void): Unsubscribe
  /** 平台信息（同步可得，避免首屏闪烁） */
  platform: NodeJS.Platform
  /** 仅当主进程带 --t1000-testhook 启动时为 true（自动化验收用） */
  readonly testHook?: boolean
}

const bridge: T1000Bridge = {
  invoke(domain, action, payload) {
    return ipcRenderer.invoke(IPC_CHANNEL, ipcRequest(domain, action, payload))
  },

  on(event, listener) {
    const wrapped = (_e: unknown, payload: unknown): void => {
      ;(listener as (p: unknown) => void)(payload)
    }
    ipcRenderer.on(event, wrapped)
    return () => {
      ipcRenderer.removeListener(event, wrapped)
    }
  },

  platform: process.platform,
  /** 仅当主进程带 --t1000-testhook 启动时为 true（自动化验收用） */
  testHook: process.argv.includes('--t1000-testhook'),
}

contextBridge.exposeInMainWorld('t1000', bridge)
