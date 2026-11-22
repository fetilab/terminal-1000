// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 剪贴板唯一入口。
 *
 * **不要在渲染层直接用 `navigator.clipboard`** —— Electron 里它有两条硬限制：
 * `writeText`/`readText` 要求 document 有焦点（否则 `NotAllowedError:
 * Document is not focused`），`readText` 还额外要 `clipboard-read` 权限，
 * 而 Electron 默认不授予。表现就是「复制粘贴偶尔没反应 / 完全没反应」。
 *
 * 这里统一走主进程的 `clipboard` 模块（不受焦点与权限限制），
 * 只有在 IPC 不可用时（例如单测里没有 preload）才回退到 HTML API。
 */

import { invoke } from './ipc'

/** 写系统剪贴板。失败时抛出，调用方负责提示用户 */
export async function copyText(text: string): Promise<void> {
  if (!text) return
  try {
    await invoke<'clipboard', 'write', { text: string }, { ok: boolean }>('clipboard', 'write', {
      text,
    })
    return
  } catch {
    /* 主进程不可用（单测/预览环境）时才回退 */
  }
  await navigator.clipboard.writeText(text)
}

/** 读系统剪贴板；读不到（空/被占用）返回空串，不抛错 */
export async function readClipboardText(): Promise<string> {
  try {
    const res = await invoke<'clipboard', 'read', Record<string, never>, { text: string }>(
      'clipboard',
      'read',
      {},
    )
    return res?.text ?? ''
  } catch {
    /* 回退见下 */
  }
  try {
    return await navigator.clipboard.readText()
  } catch {
    return ''
  }
}

/**
 * 读 X11 PRIMARY selection（中键粘贴）。
 *
 * 非 Linux 平台主进程会回退成普通剪贴板，所以这里不用按平台分支。
 */
export async function readSelectionText(): Promise<string> {
  try {
    const res = await invoke<'clipboard', 'readSelection', Record<string, never>, { text: string }>(
      'clipboard',
      'readSelection',
      {},
    )
    return res?.text ?? ''
  } catch {
    return ''
  }
}

/** 写 X11 PRIMARY selection（选中即复制到 selection，非 Linux 回退普通剪贴板） */
export async function copyToSelection(text: string): Promise<void> {
  if (!text) return
  try {
    await invoke<'clipboard', 'writeSelection', { text: string }, { ok: boolean }>(
      'clipboard',
      'writeSelection',
      { text },
    )
  } catch {
    /* selection 只是锦上添花，失败不影响主剪贴板 */
  }
}
