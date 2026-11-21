// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 应用图标（运行时）。
 *
 * 打包时资源在 `build/` 下，运行时要能从 asar 之外取到同一份图：
 * - 安装包：electron-builder 会把 `build/icon.png` 复制到 `resources/icon.png`
 *   （见 electron-builder.yml 的 extraResources）；
 * - 开发态：直接从 `build/` 读。
 *
 * 取不到时返回 null，调用方自己降级 —— 图标缺失绝不该让应用起不来。
 */

import { app, nativeImage, type NativeImage } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))

function candidates(name: 'icon.png' | 'tray.png'): string[] {
  if (app.isPackaged) return [join(process.resourcesPath, name)]
  // 开发态 __dirname 是 out/main，资源在 apps/desktop/build
  return [join(here, '../../build', name), join(here, '../../../build', name)]
}

export function appIconPath(): string | null {
  return candidates('icon.png').find((p) => existsSync(p)) ?? null
}

export function trayIconPath(): string | null {
  return candidates('tray.png').find((p) => existsSync(p)) ?? null
}

/** 窗口图标（Linux/Windows 生效；macOS 用 bundle 图标） */
export function appIcon(): NativeImage | null {
  const p = appIconPath()
  if (!p) return null
  const img = nativeImage.createFromPath(p)
  return img.isEmpty() ? null : img
}

/** 托盘图标：托盘尺寸小，按平台缩到 16/22px，避免糊成一块 */
export function trayIcon(): NativeImage | null {
  const p = trayIconPath()
  if (!p) return null
  const img = nativeImage.createFromPath(p)
  if (img.isEmpty()) return null
  const size = process.platform === 'darwin' ? 18 : 20
  return img.resize({ width: size, height: size, quality: 'best' })
}
