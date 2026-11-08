// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

import { app, BrowserWindow, ipcMain } from 'electron'
import { IPC_CHANNEL } from '@t1000/shared'
import { createIpcContext, dispatch, type IpcContext } from './ipc/router'
import { registerAllHandlers } from './ipc'
import { createLogger } from './logger'
import { getAppPaths } from './paths'
import { broadcast, createWindow, getMainWindow } from './window'
import { shutdownSsh } from './services/ssh'
import { shutdownForwards } from './services/forward'
import { registerFromSettings, shutdownHotkeys } from './services/hotkey'
import { shutdownTelnet } from './services/telnet'
import { shutdownVnc } from './services/vnc'
import { shutdownRdp } from './services/rdp'
import { onSessionClosed, shutdownBroadcast } from './services/broadcast'
import { subscribeSessionClosed } from './services/session-registry'

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

function installIpcBridge(ctx: IpcContext): void {
  ipcMain.handle(IPC_CHANNEL, async (_event, raw: unknown) => {
    return dispatch(raw, ctx)
  })
  log.info(`IPC 通道就绪: ${IPC_CHANNEL}`)
}

async function bootstrap(): Promise<void> {
  // 数据目录要在任何服务初始化之前准备好
  const paths = getAppPaths()
  log.info(`数据目录: ${paths.userData}`)

  // 上下文建成一份，IPC 与需要主动广播的服务（如快捷键）共用
  const ctx = createIpcContext(broadcast)
  installIpcBridge(ctx)
  registerAllHandlers()

  createWindow()

  // 会话关闭时把它从所有广播组里摘掉（否则会留下幽灵成员，
  // 广播时表现为"某台机器写不进去"）
  subscribeSessionClosed((sessionId) => {
    try {
      onSessionClosed(sessionId)
    } catch (err) {
      log.warn('清理广播组成员时出错', err)
    }
  })

  // 窗口就绪后按设置注册快捷键。
  // 放在窗口之后：应用内快捷键要挂到窗口的 before-input-event 上。
  try {
    registerFromSettings(ctx)
  } catch (err) {
    // 快捷键注册失败不应阻止应用启动
    log.warn('快捷键初始化失败', err)
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      const win = createWindow()
      // 新窗口也要挂上应用内快捷键，否则新建窗口里快捷键失效
      try {
        registerFromSettings(ctx)
      } catch (err) {
        log.warn('新窗口快捷键注册失败', err)
      }
      void win
    }
  })
}

/**
 * 只有拿到单实例锁才启动。
 *
 * 之前这里漏了判断：拿不到锁时虽然调了 app.quit()，但 whenReady 仍会触发 bootstrap，
 * 于是又建了一个窗口、随即被 quit 关掉 —— 表现为"进程还活着、窗口却不见了"，
 * 排查时非常迷惑（会误以为是渲染层或显示环境的问题）。
 */
if (gotLock) {
  app.whenReady().then(bootstrap).catch((err) => {
    log.error('启动失败', err)
    app.exit(1)
  })
} else {
  log.info('已有实例在运行，本次启动退出并聚焦既有窗口')
}

/**
 * 退出前释放外部资源。
 *
 * 顺序很重要：先关隧道（释放本地监听端口，否则下次启动会 EADDRINUSE），
 * 再断 SSH 会话（隧道依赖会话）。
 */
function shutdownServices(): void {
  try {
    // 先注销快捷键：全局热键会占用系统级按键，不注销会留给下一个进程一个"死键"
    shutdownHotkeys()
  } catch (err) {
    log.warn('注销快捷键时出错', err)
  }
  try {
    // Telnet 是裸 socket，不主动销毁会留下半开连接
    shutdownTelnet()
  } catch (err) {
    log.warn('关闭 Telnet 会话时出错', err)
  }
  try {
    // VNC 同为裸 socket
    shutdownVnc()
  } catch (err) {
    log.warn('关闭 VNC 会话时出错', err)
  }
  try {
    // RDP 要 SIGTERM 掉外部查看器进程，否则会留下无人管理的窗口
    shutdownRdp()
  } catch (err) {
    log.warn('关闭 RDP 会话时出错', err)
  }
  try {
    // 广播组只存在于内存，退出时清掉避免残留引用
    shutdownBroadcast()
  } catch (err) {
    log.warn('清理广播组时出错', err)
  }
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
