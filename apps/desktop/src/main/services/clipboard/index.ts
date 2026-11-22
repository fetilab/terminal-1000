// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * clipboard 域：系统剪贴板读写。
 *
 * 为什么需要这个域（而不是让渲染层用 `navigator.clipboard`）：
 *
 * HTML 剪贴板 API 在 Electron 里有两道与"用户体验"直接冲突的限制：
 * 1. **要求 document 有焦点**。窗口切走、右键菜单抢走焦点、拖选时焦点在
 *    弹层上的瞬间，`writeText`/`readText` 都抛
 *    `NotAllowedError: Document is not focused` —— 用户看到的就是"复制没反应"。
 * 2. **`readText` 需要 `clipboard-read` 权限**，而 Electron 默认不授予，
 *    没设 `setPermissionRequestHandler` 时直接被拒。
 *
 * 实测（Xvfb + 真实 Electron，本仓库 0.2.4）：渲染层
 * `navigator.clipboard.writeText` 在 document 未聚焦时抛 NotAllowedError；
 * 而主进程的 `clipboard` 模块不关心焦点，也不走权限门，且能正确成为
 * X11 selection owner（别的程序能粘贴出来）。
 *
 * 注意本仓库所用的 Electron 45 里，`clipboard` 的方法**都是异步的**
 * （`readText(): Promise<string>`、`writeText(text): Promise<void>`），
 * 且 Linux 上通过 `clipboard.selection` 访问 PRIMARY —— 不是旧版的
 * `readText('selection')`。
 */

import { clipboard } from 'electron'
import { z } from 'zod'
import { createLogger } from '../../logger'
import { parseInput } from '../../errors'
import type { IpcHandler } from '../../ipc/router'

const log = createLogger('clipboard')

/** 剪贴板文本长度上限：防止某个程序写了 200MB 文本把渲染层卡死 */
const MAX_CLIPBOARD_CHARS = 8 * 1024 * 1024

const textSchema = z.object({
  text: z.string().max(MAX_CLIPBOARD_CHARS),
})

/** Linux 才有 PRIMARY selection；其它平台 `clipboard.selection` 为 undefined */
const selectionClipboard = clipboard.selection

export const clipboardHandlers: Record<string, IpcHandler> = {
  read: async () => ({ text: await clipboard.readText() }),

  write: async (payload) => {
    const { text } = parseInput(textSchema, payload)
    await clipboard.writeText(text)
    return { ok: true, length: text.length }
  },

  readSelection: async () => {
    if (!selectionClipboard) return { text: await clipboard.readText() }
    try {
      return { text: await selectionClipboard.readText() }
    } catch (err) {
      // 某些桌面环境（Wayland 无 XWayland、剪贴板管理器抢占）会抛错；
      // 退化成普通剪贴板，别让中键粘贴彻底失效
      log.warn(`读 PRIMARY selection 失败，回退到普通剪贴板: ${String(err)}`)
      return { text: await clipboard.readText() }
    }
  },

  writeSelection: async (payload) => {
    const { text } = parseInput(textSchema, payload)
    if (!selectionClipboard) {
      await clipboard.writeText(text)
      return { ok: true }
    }
    try {
      await selectionClipboard.writeText(text)
    } catch (err) {
      log.warn(`写 PRIMARY selection 失败，回退到普通剪贴板: ${String(err)}`)
      await clipboard.writeText(text)
    }
    return { ok: true }
  },
}
