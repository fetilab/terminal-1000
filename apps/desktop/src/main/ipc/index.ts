// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

import { createLogger } from '../logger'
import { appHandlers } from './handlers/app'
import { listRegistered, registerDomain } from './router'

// 各功能域自行导出 handler 表；本文件是唯一挂载点，便于一眼看清有哪些域已接入。
import { storeHandlers } from '../services/store'
import { sshHandlers } from '../services/ssh'
import { sftpHandlers } from '../services/sftp'
import { monitorHandlers } from '../services/monitor'
import { ptyHandlers } from '../services/pty'
import { forwardHandlers } from '../services/forward'

const log = createLogger('ipc-setup')

/**
 * 注册全部 IPC 域。
 * 新增服务时在此处挂载，保持单点可查。
 */
export function registerAllHandlers(): void {
  registerDomain('app', appHandlers)
  registerDomain('store', storeHandlers)
  registerDomain('ssh', sshHandlers)
  registerDomain('sftp', sftpHandlers)
  registerDomain('monitor', monitorHandlers)
  registerDomain('pty', ptyHandlers)
  registerDomain('forward', forwardHandlers)

  log.info(`已注册 ${listRegistered().length} 个 IPC 动作`)
}
