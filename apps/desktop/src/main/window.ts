// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

import { BrowserWindow, shell } from 'electron'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { EventName, EventPayloads } from '@t1000/shared'
import { createLogger } from './logger'

const log = createLogger('window')

const __dirname_ = fileURLToPath(new URL('.', import.meta.url))

/** 所有已创建的主窗口 */
const windows = new Set<BrowserWindow>()

export function broadcast<E extends EventName>(event: E, payload: EventPayloads[E]): void {
  for (const win of windows) {
    if (!win.isDestroyed()) {
      win.webContents.send(event, payload)
    }
  }
}

export function getMainWindow(): BrowserWindow | null {
  return [...windows][0] ?? null
}

export function listWindows(): BrowserWindow[] {
  return [...windows]
}

export interface CreateWindowOptions {
  /** 开发模式下的渲染进程 URL；生产模式为 undefined（走本地文件） */
  rendererUrl?: string | undefined
  show?: boolean
}

export function createWindow(options: CreateWindowOptions = {}): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    show: options.show ?? false,
    autoHideMenuBar: true,
    backgroundColor: '#1a1a1a',
    title: 'terminal-1000',
    webPreferences: {
      preload: join(__dirname_, '../preload/index.mjs'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      // 终端需要持续的定时器精度，后台节流交给应用自己判断
      backgroundThrottling: false,
    },
  })

  windows.add(win)

  win.once('ready-to-show', () => {
    if (options.show ?? true) win.show()
  })

  win.on('closed', () => {
    windows.delete(win)
  })

  // 站内导航一律拦截，外部链接交给系统浏览器
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  const devUrl = options.rendererUrl ?? process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    void win.loadURL(devUrl)
    log.info(`加载开发地址 ${devUrl}`)
  } else {
    void win.loadFile(join(__dirname_, '../renderer/index.html'))
  }

  return win
}
