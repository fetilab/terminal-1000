// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * `electron` 模块的 Android 替身。
 *
 * 这是整个移植的关键手法：**构建时把 `electron` 这个模块标识符重定向到本文件**
 * （见 build.mjs 里的 onResolve 插件），于是 `apps/desktop/src/main` 那 3.7 万行
 * 主进程代码一行都不用改，就能跑在 Android 的 Node 运行时上。
 *
 * 为什么选"替身"而不是"重写主进程"：
 * - 主进程里绝大部分是纯业务（SSH/SFTP/存储/加密/同步/AI/补全），
 *   与平台无关；重写等于把 3.7 万行重新验证一遍，回归风险不可接受。
 * - Electron 在其中的角色只有 14 个模块、约 40 个方法，且都能找到 Android 的
 *   对应物（或明确的可接受降级）。
 *
 * 约定：任何在这里"降级为空实现"的能力，都必须在 shim 文件里写清理由，
 * 且不能影响主进程启动与核心功能（连接、终端、文件、设置）。
 */

export { app } from './app'
export { BrowserWindow, screen } from './window'
export type { BrowserWindowOptions, Display, Rectangle } from './window'
export { ipcMain } from './ipc'
export type { IpcEvent, IpcHandler } from './ipc'
export { dialog } from './dialog'
export { shell } from './shell'
export { clipboard } from './clipboard'
export {
  Menu,
  Tray,
  nativeImage,
  globalShortcut,
  powerMonitor,
  nativeTheme,
  Notification,
} from './misc'

/* ── preload 侧的 API ─────────────────────────────────
 * Android 端不用 preload：`window.t1000` 由 Kotlin 在文档创建前注入的
 * 一段 JS 提供（见 app/src/main/assets/inject/bridge.js），
 * WebView 与 Node 之间直接走回环 WebSocket。
 *
 * 这里保留导出只是为了让任何残留的 import 不至于在打包时解析失败 ——
 * 运行时若真被调用，说明有代码走错了路，直接抛错比静默降级更好排查。
 */
export const contextBridge = {
  exposeInMainWorld(_key: string, _api: unknown): void {
    throw new Error('contextBridge 在 Android 上不可用：渲染层桥由 Kotlin 注入')
  },
}

export const ipcRenderer = {
  invoke(): Promise<never> {
    return Promise.reject(new Error('ipcRenderer 在 Android 上不可用：请使用 window.t1000'))
  },
  on(): void {},
  removeListener(): void {},
  send(): void {},
}
