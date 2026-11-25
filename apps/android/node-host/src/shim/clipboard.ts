// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * `clipboard` 的 Android 实现 —— 转给 ClipboardManager。
 *
 * 必须走原生而不是 `navigator.clipboard`，原因与桌面端一致（见
 * `services/clipboard/index.ts` 的注释）：HTML 剪贴板 API 要求 document 有焦点，
 * 而终端里"拖选后右键复制""切走窗口再粘贴"这些动作天然不满足该前提。
 * Android WebView 还额外要求页面处于 resumed 状态，更不可靠。
 *
 * PRIMARY selection（X11 的中键粘贴）在 Android 上不存在：
 * 这里把 `selection` 暴露为 `undefined`，主进程的 clipboard 域会自动退化成
 * 普通剪贴板（它的实现里就是这么写的），中键粘贴仍然可用。
 */

import { native } from './native'

interface SelectionApi {
  readText(): Promise<string>
  writeText(text: string): Promise<void>
}

export const clipboard = {
  async readText(_type?: string): Promise<string> {
    const result = await native.call<{ text?: string } | null>('clipboard.read', {}, { text: '' })
    return result?.text ?? ''
  },

  async writeText(text: string, _type?: string): Promise<void> {
    await native.call('clipboard.write', { text }, null)
  },

  /**
   * Android 没有 X11 PRIMARY。**显式设为 undefined**：
   * 主进程的 clipboard 域会检测到它不存在并回退到普通剪贴板
   * （`if (!selectionClipboard) return { text: await clipboard.readText() }`），
   * 这比伪造一个同义对象更诚实，也让中键粘贴的行为可预期。
   */
  selection: undefined as SelectionApi | undefined,

  async has(_format: string): Promise<boolean> {
    return false
  },

  availableFormats(): string[] {
    return ['text/plain']
  },

  clear(): void {
    void native.call('clipboard.write', { text: '' }, null).catch(() => undefined)
  },
}
