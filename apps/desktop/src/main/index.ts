// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

import { app, BrowserWindow, ipcMain } from 'electron'
import { IPC_CHANNEL } from '@t1000/shared'
import { createIpcContext, dispatch } from './ipc/router'
import { registerAllHandlers } from './ipc'
import { createLogger } from './logger'
import { getAppPaths } from './paths'
import { broadcast, createWindow, getMainWindow } from './window'

const log = createLogger('bootstrap')

/** 单实例：第二次启动时聚焦已有窗口 */
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const win = getMainWindow()
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })
}

function installIpcBridge(): void {
  const ctx = createIpcContext(broadcast)
  ipcMain.handle(IPC_CHANNEL, async (_event, raw: unknown) => {
    return dispatch(raw, ctx)
  })
  log.info(`IPC 通道就绪: ${IPC_CHANNEL}`)
}

async function bootstrap(): Promise<void> {
  // 数据目录要在任何服务初始化之前准备好
  const paths = getAppPaths()
  log.info(`数据目录: ${paths.userData}`)

  installIpcBridge()
  registerAllHandlers()

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
}

app.whenReady().then(bootstrap).catch((err) => {
  log.error('启动失败', err)
  app.exit(1)
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// 未捕获异常不要静默吞掉
process.on('uncaughtException', (err) => {
  log.error('uncaughtException', err)
})
process.on('unhandledRejection', (reason) => {
  log.error('unhandledRejection', reason)
})
