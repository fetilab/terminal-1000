// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

import { app, BrowserWindow, ipcMain } from 'electron'
import { IPC_CHANNEL } from '@t1000/shared'
import { createIpcContext, dispatch } from './ipc/router'
import { registerAllHandlers } from './ipc'
import { createLogger } from './logger'
import { getAppPaths } from './paths'
import { broadcast, createWindow, getMainWindow } from './window'
import { shutdownSsh } from './services/ssh'
import { shutdownForwards } from './services/forward'

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

/**
 * 退出前释放外部资源。
 *
 * 顺序很重要：先关隧道（释放本地监听端口，否则下次启动会 EADDRINUSE），
 * 再断 SSH 会话（隧道依赖会话）。
 */
function shutdownServices(): void {
  try {
    shutdownForwards()
  } catch (err) {
    log.warn('关闭隧道时出错', err)
  }
  try {
    shutdownSsh()
  } catch (err) {
    log.warn('关闭 SSH 会话时出错', err)
  }
}

app.on('before-quit', shutdownServices)

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
