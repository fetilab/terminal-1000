// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

import { BrowserWindow, screen, shell } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { EventName, EventPayloads } from '@t1000/shared'
import { appIconPath } from './icon'
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


// ── 窗口位置与尺寸记忆 ────────────────────────────────
//
// 对应 spec P1「系统配置：…窗口记忆」。原先没有任何实现。
// 用一个独立的小 JSON 文件而不是设置服务：窗口创建发生在应用早期，
// 不应该为了读一个矩形而依赖设置服务（以及它背后的数据库与解锁状态）。

interface WindowBounds {
  x: number
  y: number
  width: number
  height: number
  maximized?: boolean
}

let boundsFile = ''

/** 由主进程在启动时告知文件位置（避免本模块依赖 paths 服务） */
export function setWindowBoundsFile(file: string): void {
  boundsFile = file
}

function loadWindowBounds(): WindowBounds | undefined {
  if (!boundsFile || !existsSync(boundsFile)) return undefined
  try {
    const raw = JSON.parse(readFileSync(boundsFile, 'utf8')) as Partial<WindowBounds>
    if (
      typeof raw.x !== 'number' ||
      typeof raw.y !== 'number' ||
      typeof raw.width !== 'number' ||
      typeof raw.height !== 'number'
    ) {
      return undefined
    }
    // 显示器可能已经拔掉/换分辨率，落在屏幕外的窗口会让用户"找不到窗口"
    const visible = screen.getAllDisplays().some((d) => {
      const a = d.workArea
      return raw.x! < a.x + a.width && raw.x! + raw.width! > a.x && raw.y! < a.y + a.height && raw.y! + raw.height! > a.y
    })
    if (!visible) {
      log.info('上次的窗口位置已不在任何显示器内，回退到默认位置')
      return { ...(raw as WindowBounds), x: undefined as unknown as number, y: undefined as unknown as number }
    }
    return raw as WindowBounds
  } catch (err) {
    log.warn('读取窗口位置失败，使用默认值', err)
    return undefined
  }
}

function saveWindowBounds(win: BrowserWindow): void {
  if (!boundsFile || win.isDestroyed()) return
  try {
    const maximized = win.isMaximized()
    // 最大化时 getBounds 返回的是最大化后的尺寸；用 getNormalBounds 记住"还原后"的位置
    const b = maximized ? win.getNormalBounds() : win.getBounds()
    const payload: WindowBounds = { x: b.x, y: b.y, width: b.width, height: b.height, maximized }
    writeFileSync(boundsFile, JSON.stringify(payload))
  } catch (err) {
    log.warn('保存窗口位置失败', err)
  }
}

export interface CreateWindowOptions {
  /** 开发模式下的渲染进程 URL；生产模式为 undefined（走本地文件） */
  rendererUrl?: string | undefined
  show?: boolean
  /** 设为 false 时不恢复上次的位置尺寸（如测试或"重置窗口"） */
  restoreBounds?: boolean
}

export function createWindow(options: CreateWindowOptions = {}): BrowserWindow {
  const saved = options.restoreBounds === false ? undefined : loadWindowBounds()

  const win = new BrowserWindow({
    ...(saved?.x !== undefined && saved?.y !== undefined
      ? { x: saved.x, y: saved.y, width: saved.width, height: saved.height }
      : { width: 1440, height: 900 }),
    minWidth: 900,
    minHeight: 600,
    show: options.show ?? false,
    autoHideMenuBar: true,
    backgroundColor: '#1a1a1a',
    title: 'terminal-1000',
    // Linux/Windows 的窗口与任务栏图标；取不到就不设（用可执行文件自带图标）
    ...(appIconPath() ? { icon: appIconPath() as string } : {}),
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

  // 窗口生命周期日志：出问题时（窗口不出现、白屏）这几条是唯一能定位的线索，
  // 没有它们只能靠猜。
  win.once('ready-to-show', () => {
    log.info('窗口 ready-to-show')
    if (options.show ?? true) {
      win.show()
      log.info('窗口已显示')
    }
  })

  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    log.error(`渲染层加载失败 ${code} ${desc} ${url}`)
  })
  win.webContents.on('render-process-gone', (_e, details) => {
    log.error(`渲染进程退出: ${JSON.stringify(details)}`)
  })
  win.webContents.on('preload-error', (_e, preloadPath, error) => {
    // preload 出错会让 window.t1000 变成 undefined，渲染层随即大面积抛错
    log.error(`preload 加载失败 ${preloadPath}: ${error.message}`)
  })

  // 窗口位置/尺寸变更：防抖保存，避免拖动过程中疯狂写盘
  let saveTimer: NodeJS.Timeout | undefined
  const scheduleSave = (): void => {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => saveWindowBounds(win), 500)
  }
  win.on('resize', scheduleSave)
  win.on('move', scheduleSave)
  win.on('maximize', scheduleSave)
  win.on('unmaximize', scheduleSave)

  // 关闭时立即存一次（防抖可能还没触发）
  win.on('close', () => {
    if (saveTimer) clearTimeout(saveTimer)
    saveWindowBounds(win)
  })

  win.on('closed', () => {
    windows.delete(win)
  })

  if (saved?.maximized) win.maximize()

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
