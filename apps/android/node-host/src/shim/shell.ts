// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * `shell` 的 Android 实现 —— 全部映射到 Intent。
 *
 * - `openExternal(url)` → `ACTION_VIEW`（浏览器 / 邮件客户端）
 * - `openPath(path)` → `FileProvider` + `ACTION_VIEW`（用系统默认 App 打开）
 * - `showItemInFolder(path)` → Android 没有"在文件管理器中显示"的通用能力，
 *   退化为用文件管理器打开所在目录；失败则报给调用方（不静默假装成功）。
 *
 * 注意 `openPath` 的返回约定与 Electron 一致：**空串表示成功**，
 * 非空字符串是错误原因（不是抛异常）。
 */

import { native } from './native'

export const shell = {
  async openExternal(url: string): Promise<void> {
    await native.call('shell.openExternal', { url }, null)
  },

  async openPath(path: string): Promise<string> {
    const result = await native.call<{ error?: string } | null>(
      'shell.openPath',
      { path },
      // 原生不可用（本机调试）时如实报错，不假装打开成功
      { error: '原生通道不可用，无法打开文件' },
    )
    return result?.error ?? ''
  },

  showItemInFolder(path: string): void {
    void native.call('shell.showItemInFolder', { path }, null).catch(() => undefined)
  },

  beep(): void {
    void native.call('shell.beep', {}, null).catch(() => undefined)
  },

  async trashItem(path: string): Promise<void> {
    // Android 11+ 没有"移到回收站"的统一 API（MediaStore 只覆盖媒体文件）。
    // 走原生删除，具体语义由 Kotlin 侧决定（用户目录内的临时文件直接删）。
    await native.call('shell.trash', { path }, null)
  },
}
