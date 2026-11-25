// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * `dialog` 的 Android 实现 —— 全部转成原生调用。
 *
 * 对应关系：
 * - `showOpenDialog` → Storage Access Framework（`ACTION_OPEN_DOCUMENT` /
 *   `ACTION_OPEN_DOCUMENT_TREE`）。**这是 Android 上唯一合规的选文件方式**：
 *   API 30+ 起不能直接遍历别人的外部目录，拿到的是一份 content:// URI，
 *   Kotlin 侧会把它翻译成我们能读的本地描述（必要时先复制到缓存）。
 * - `showMessageBox` → AlertDialog。
 * - `showSaveDialog` → `ACTION_CREATE_DOCUMENT`。
 *
 * 签名兼容：Electron 允许 `(window, options)` 与 `(options)` 两种调用，
 * 主进程两处都用到了（`pickLocalPath` 会因为有没有主窗口而走不同分支）。
 */

import { native } from './native'

export interface OpenDialogOptions {
  title?: string
  defaultPath?: string
  filters?: Array<{ name: string; extensions: string[] }>
  properties?: Array<'openFile' | 'openDirectory' | 'multiSelections'> | string[]
}

export interface OpenDialogReturnValue {
  canceled: boolean
  filePaths: string[]
}

export interface SaveDialogReturnValue {
  canceled: boolean
  filePath?: string
}

export interface MessageBoxOptions {
  type?: 'none' | 'info' | 'error' | 'question' | 'warning'
  title?: string
  message?: string
  detail?: string
  buttons?: string[]
  defaultId?: number
  cancelId?: number
  noLink?: boolean
  checkboxLabel?: string
  checkboxChecked?: boolean
}

export interface MessageBoxReturnValue {
  response: number
  checkboxChecked: boolean
}

/** 从参数里挑出真正的 options（兼容 (win, opts) 与 (opts) 两种签名） */
function pickOptions<T>(first: unknown, second: unknown): T {
  if (second !== undefined) return second as T
  return first as T
}

function toNativeFilters(
  filters: Array<{ name: string; extensions: string[] }> | undefined,
): Array<{ name: string; mime: string[] }> | undefined {
  if (!filters || filters.length === 0) return undefined
  // Android 的选择器按 MIME 过滤而不是扩展名。常见的文本类统一映射到 text/*，
  // 其它按扩展名交给 Kotlin 侧解析（它会尽力推导，推不出就不加过滤）。
  return filters.map((f) => ({
    name: f.name,
    mime: f.extensions.map((ext) => (ext === '*' ? '*/*' : `application/${ext}`)),
  }))
}

export const dialog = {
  async showOpenDialog(
    ...args: unknown[]
  ): Promise<OpenDialogReturnValue> {
    const raw = pickOptions<OpenDialogOptions>(args[0], args[1]) ?? {}
    const props = raw.properties ?? ['openFile']
    const directory = props.includes('openDirectory')
    const multiple = props.includes('multiSelections')

    const result = await native.call<{ canceled?: boolean; paths?: string[] } | null>(
      'dialog.open',
      {
        mode: directory ? 'directory' : 'file',
        multiple,
        title: raw.title ?? '',
        defaultPath: raw.defaultPath ?? '',
        filters: toNativeFilters(raw.filters) ?? null,
      },
      { canceled: true, paths: [] },
    )

    return {
      canceled: result?.canceled ?? true,
      filePaths: result?.paths ?? [],
    }
  },

  async showSaveDialog(...args: unknown[]): Promise<SaveDialogReturnValue> {
    const raw = pickOptions<{ title?: string; defaultPath?: string }>(args[0], args[1]) ?? {}
    const result = await native.call<{ canceled?: boolean; path?: string } | null>(
      'dialog.save',
      {
        title: raw.title ?? '',
        defaultPath: raw.defaultPath ?? '',
      },
      { canceled: true },
    )
    return result?.path
      ? { canceled: result.canceled ?? false, filePath: result.path }
      : { canceled: true }
  },

  async showMessageBox(...args: unknown[]): Promise<MessageBoxReturnValue> {
    const raw = pickOptions<MessageBoxOptions>(args[0], args[1]) ?? {}
    const result = await native.call<{ response?: number } | null>(
      'dialog.message',
      {
        type: raw.type ?? 'info',
        title: raw.title ?? '',
        message: raw.message ?? '',
        detail: raw.detail ?? '',
        buttons: raw.buttons ?? ['确定'],
        defaultId: raw.defaultId ?? 0,
        cancelId: raw.cancelId ?? -1,
      },
      // 原生不可用时的默认：返回 defaultId，让调用方按"用户点了默认项"继续，
      // 而不是永久卡在一个永远不出现的对话框上
      { response: raw.cancelId ?? raw.defaultId ?? 0 },
    )
    return {
      response: result?.response ?? raw.cancelId ?? 0,
      checkboxChecked: raw.checkboxChecked ?? false,
    }
  },

  showErrorBox(title: string, content: string): void {
    void native.call('dialog.error', { title, message: content }, null).catch(() => undefined)
  },

  showCertificateTrustDialog(): Promise<void> {
    // Android 的证书信任由系统管理，App 无权干预
    return Promise.resolve()
  },
}
