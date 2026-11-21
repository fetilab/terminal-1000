// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 系统托盘。
 *
 * 对应设置项 `app.showTrayIcon` 与 `app.minimizeToTray` —— 这两个设置原先
 * **没有任何消费者**（用户拨了开关什么都不发生）。这里补上真正的行为。
 *
 * 设计取舍：
 * - 托盘图标是**可选**的：很多桌面环境（尤其 Wayland/精简 WM）不支持托盘，
 *   `Tray` 构造会抛错。这里**捕获并降级**，绝不让"托盘不可用"导致应用起不来。
 * - 关闭窗口的行为分三种：最小化到托盘 / 直接退出 / 询问。由设置决定。
 * - 托盘菜单里始终有「显示主窗口」与「退出」—— 否则最小化到托盘后用户可能找不到退出口。
 */

import { Menu, Tray, nativeImage, type BrowserWindow } from 'electron'
import { trayIcon } from './icon'
import { createLogger } from './logger'

const log = createLogger('tray')

let tray: Tray | null = null

/**
 * 生成托盘图标。
 *
 * 优先用打包资源里的单色 `>_`（apps/desktop/build/tray.svg 渲染产物）：
 * 托盘背景色不可控，深色底板图标在深色面板上会直接消失。
 * 取不到资源时才退回下面这个代码绘制的方块占位图 —— 图标缺失不该让托盘功能失效。
 */
function buildIcon(): Electron.NativeImage {
  const real = trayIcon()
  if (real) return real

  const size = 16
  const buf = Buffer.alloc(size * size * 4)
  for (let i = 0; i < size * size; i++) {
    const x = i % size
    const y = Math.floor(i / size)
    // 画一个带边框的方块，中心留空 —— 在深浅两种托盘背景上都看得见
    const edge = x === 0 || y === 0 || x === size - 1 || y === size - 1
    const inner = x > 3 && y > 3 && x < size - 4 && y < size - 4
    const on = edge || inner
    buf[i * 4 + 0] = on ? 0x2f : 0x00 // B
    buf[i * 4 + 1] = on ? 0xb0 : 0x00 // G
    buf[i * 4 + 2] = on ? 0xa8 : 0x00 // R
    buf[i * 4 + 3] = on ? 0xff : 0x00 // A
  }
  return nativeImage.createFromBuffer(buf, { width: size, height: size })
}

export interface TrayOptions {
  /** 显示主窗口（并聚焦） */
  showWindow: () => void
  /** 退出应用 */
  quit: () => void
}

/**
 * 按设置同步托盘的存在与否。
 * 幂等：可反复调用（设置变更后调用它即可生效）。
 *
 * @returns 托盘当前是否可用
 */
export function syncTray(
  enabled: boolean,
  options: TrayOptions,
  /** 可选：由调用方注入「检查更新」的行为 —— 托盘不自己实现业务，避免两处行为分叉 */
  onCheckUpdate?: () => void,
): boolean {
  if (!enabled) {
    destroyTray()
    return false
  }
  if (tray) return true

  try {
    tray = new Tray(buildIcon())
    tray.setToolTip('terminal-1000')
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: '显示主窗口', click: () => options.showWindow() },
        { type: 'separator' },
        {
          label: '检查更新…',
          click: () => {
            // 托盘菜单里的"检查更新"要走**同一个**服务与提示路径，
            // 不另起一套（否则两处行为会慢慢分叉）
            void onCheckUpdate?.()
          },
        },
        { type: 'separator' },
        { label: '退出 terminal-1000', click: () => options.quit() },
      ]),
    )
    // 单击托盘图标显示窗口（Windows/Linux 常见习惯）
    tray.on('click', () => options.showWindow())
    log.info('系统托盘已启用')
    return true
  } catch (err) {
    // 桌面环境不支持托盘（Wayland、精简 WM、缺少 libappindicator 等）
    // —— 降级即可，不能因此影响应用启动
    tray = null
    log.warn(`系统托盘不可用（已降级为无托盘）: ${err instanceof Error ? err.message : String(err)}`)
    return false
  }
}

export function destroyTray(): void {
  if (!tray) return
  try {
    tray.destroy()
  } catch {
    /* 已销毁 */
  }
  tray = null
}

export function hasTray(): boolean {
  return tray !== null
}

/**
 * 应用是否正在退出。
 *
 * **不能依赖 `app.isQuitting`** —— 它不是 Electron 的公开属性（早年版有，
 * 现行版本没有），写成 `app.isQuitting === true` 会永远为 false，
 * 于是"最小化到托盘"会连**主动退出**也一并拦下，导致应用关不掉。
 */
let quitting = false

/** 由主进程在真正退出前调用，用于放行关闭流程 */
export function markQuitting(): void {
  quitting = true
}

/**
 * 关闭窗口时的行为。
 *
 * @returns true 表示"已拦截关闭"（隐藏到托盘），调用方应阻止默认的退出流程
 */
export function handleWindowClose(win: BrowserWindow, minimizeToTray: boolean): boolean {
  if (quitting) return false
  if (!minimizeToTray || !tray) return false
  win.hide()
  return true
}
