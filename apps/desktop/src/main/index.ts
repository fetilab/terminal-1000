// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

import { app, BrowserWindow, ipcMain } from 'electron'
import { join } from 'node:path'
import { IPC_CHANNEL } from '@t1000/shared'
import { createIpcContext, dispatch, type IpcContext } from './ipc/router'
import { registerAllHandlers } from './ipc'
import { createLogger } from './logger'
import { getAppPaths } from './paths'
import { broadcast, createWindow, getMainWindow, setWindowBoundsFile } from './window'
import { destroyTray, hasTray, markQuitting, syncTray } from './tray'
import { registerFromSettings, shutdownHotkeys } from './services/hotkey'
import {
  applyEarlySettings,
  applyRuntimeSettings,
  shutdownSystem,
  startAutoLock,
  startDailyBackup,
} from './services/system'
import { subscribeSessionClosed } from './services/session-registry'

const log = createLogger('bootstrap')

// 硬件加速**只能在 ready 之前**设置（ready 之后再调是空操作，用户会以为设置没生效）。
// 这里读过一次设置；读失败会退回默认（开启），绝不让一个显示设置阻止启动。
applyEarlySettings()

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
    const res = await dispatch(raw, ctx)

    // 设置写操作之后同步依赖设置的宿主行为（托盘）。
    // 在这里挂钩而不是给 settings 服务加订阅回调：一是改动最小，
    // 二是 settings 服务当前正被队友修改，避免并行编辑同一文件。
    if (isSettingsWrite(raw) && !(res as { error?: unknown })?.error) {
      applyTraySettings()
      // 开机自启等运行期系统项也要立刻跟上（否则用户改了要重启才生效，而它本可立即生效）
      applyRuntimeSettings()
    }
    return res
  })
  log.info(`IPC 通道就绪: ${IPC_CHANNEL}`)
}

/** 判断这次 IPC 是否写了设置 */
function isSettingsWrite(raw: unknown): boolean {
  const req = raw as { domain?: unknown; action?: unknown } | null
  return (
    req?.domain === 'settings' &&
    (req.action === 'set' || req.action === 'reset')
  )
}

async function bootstrap(): Promise<void> {
  // 数据目录要在任何服务初始化之前准备好
  const paths = getAppPaths()
  log.info(`数据目录: ${paths.userData}`)

  // 窗口位置记忆：用独立小文件，避免窗口创建期依赖设置服务与数据库
  setWindowBoundsFile(join(paths.userData, 'window-bounds.json'))

  // 上下文建成一份，IPC 与需要主动广播的服务（如快捷键）共用
  const ctx = createIpcContext(broadcast)
  installIpcBridge(ctx)
  registerAllHandlers()

  // ready 之后才能用的系统项：开机自启
  applyRuntimeSettings()

  const mainWindow = createWindow()

  // 自动锁屏（系统级空闲计时）与每日自动备份
  startAutoLock(ctx)
  startDailyBackup(ctx, paths.backupDir)

  // 托盘：按设置启用（原先 app.showTrayIcon / app.minimizeToTray 没有任何消费者）
  applyTraySettings()

  // 会话关闭时把它从所有广播组里摘掉（否则会留下幽灵成员，
  // 广播时表现为"某台机器写不进去"）
  subscribeSessionClosed((sessionId) => {
    // 动态 import：广播域是懒加载的。若它从未被使用过，这里会真正加载一次
    // （代价很小）；若已加载则走模块缓存，瞬时完成。
    void import('./services/broadcast')
      .then((m) => m.onSessionClosed(sessionId))
      .catch((err: unknown) => log.warn('清理广播组成员时出错', err))
  })

  // 窗口就绪后按设置注册快捷键。
  // 放在窗口之后：应用内快捷键要挂到窗口的 before-input-event 上。
  try {
    registerFromSettings(ctx)
  } catch (err) {
    // 快捷键注册失败不应阻止应用启动
    log.warn('快捷键初始化失败', err)
  }

  // 关闭窗口 → 按设置决定"最小化到托盘"还是退出。
  //
  // 这里**先无条件拦截，再异步决策**：设置是懒加载的、读取要走异步路径，
  // 而 `close` 的 preventDefault 必须同步决定。若改成"同步读设置"，就只能
  // 在启动路径上把 settings 拉回来，破坏懒加载。
  let allowClose = false
  mainWindow.on('close', (event) => {
    if (allowClose) return
    event.preventDefault()
    void (async () => {
      try {
        const { getSettings } = await import('./services/settings')
        const appSettings = getSettings().app

        // 「关闭窗口前确认」：先问一句，用户取消就什么都不做。
        // 注意这里已经是异步路径（close 已被 preventDefault 拦下），所以可以放心 await 对话框。
        if (appSettings?.confirmOnClose === true) {
          const { dialog } = await import('electron')
          const { response } = await dialog.showMessageBox(mainWindow, {
            type: 'question',
            buttons: ['关闭', '取消'],
            defaultId: 1, // 默认落在"取消"：避免一个回车就把窗口关了
            cancelId: 1,
            title: '确认关闭',
            message: '确定要关闭 terminal-1000 吗？',
            detail: '正在运行的终端会话会被断开。',
          })
          if (response !== 0) {
            log.info('用户在关闭确认中选择了取消')
            return
          }
        }

        const minimize = appSettings?.minimizeToTray ?? false
        if (minimize && hasTray()) {
          mainWindow.hide()
          log.info('窗口已最小化到托盘')
          return
        }
      } catch (err) {
        log.warn('读取关闭相关设置失败，按直接退出处理', err)
      }
      // 真的退出：放行这次 close
      allowClose = true
      mainWindow.close()
    })()
  })

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
 * **全部走动态 import**，理由：这些服务模块是懒加载的（见 ipc/index.ts）。
 * 若在这里静态 import，等于把它们全部拉回启动路径，懒加载就白做了。
 *
 * 动态 import 在这里是安全的：**模块已加载时它是瞬时的（走模块缓存）；
 * 而模块没被加载过，说明这次会话根本没建立过对应资源，也就没有什么要清理的。**
 *
 * 顺序很重要：先关隧道（释放本地监听端口，否则下次启动会 EADDRINUSE），
 * 再断 SSH 会话（隧道依赖会话）。
 */
/**
 * 按设置同步托盘。
 *
 * 用动态 import 读设置：settings 域是懒加载的，这里不为了两个布尔值
 * 把它拉进启动路径（托盘本身也只在窗口创建后才需要）。
 */
function applyTraySettings(): void {
  void (async () => {
    try {
      const { getSettings } = await import('./services/settings')
      const appSettings = getSettings().app
      syncTray(appSettings?.showTrayIcon ?? false, {
        showWindow: () => {
          const w = getMainWindow()
          if (!w) return
          if (w.isMinimized()) w.restore()
          w.show()
          w.focus()
        },
        quit: () => {
          // 必须先标记"正在退出"，否则 close 处理器会把退出拦成"最小化到托盘"
          markQuitting()
          app.quit()
        },
      })
    } catch (err) {
      log.warn('同步托盘设置失败', err)
    }
  })()
}

async function shutdownServices(): Promise<void> {
  markQuitting()
  destroyTray()
  shutdownSystem()

  type Cleanup = { label: string; run: () => void | Promise<void> }

  const tasks: Cleanup[] = [
    {
      // 全局热键会占用系统级按键，不注销会留给下一个进程一个"死键"
      label: '注销快捷键',
      run: () => shutdownHotkeys(),
    },
    {
      // Telnet 是裸 socket，不主动销毁会留下半开连接
      label: '关闭 Telnet 会话',
      run: async () => (await import('./services/telnet')).shutdownTelnet(),
    },
    {
      label: '关闭 VNC 会话',
      run: async () => (await import('./services/vnc')).shutdownVnc(),
    },
    {
      // RDP 要 SIGTERM 掉外部查看器进程，否则会留下无人管理的窗口
      label: '关闭 RDP 查看器',
      run: async () => (await import('./services/rdp')).shutdownRdp(),
    },
    {
      label: '清理广播组',
      run: async () => (await import('./services/broadcast')).shutdownBroadcast(),
    },
    {
      label: '关闭隧道',
      run: async () => (await import('./services/forward')).shutdownForwards(),
    },
    {
      label: '断开 SSH 会话',
      run: async () => (await import('./services/ssh')).shutdownSsh(),
    },
  ]

  for (const task of tasks) {
    try {
      await task.run()
    } catch (err) {
      log.warn(`${task.label}时出错`, err)
    }
  }
}

let cleanupDone = false
app.on('before-quit', (event) => {
  if (cleanupDone) return
  // 清理是异步的（动态 import），必须先拦下这次退出，清完再退
  event.preventDefault()
  void shutdownServices().finally(() => {
    cleanupDone = true
    app.quit()
  })
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
