// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

import { createLogger } from '../logger'
import { appHandlers } from './handlers/app'
import { listRegistered, registerDomain } from './router'

const log = createLogger('ipc-setup')

/**
 * 注册全部 IPC 域。
 * 新增服务时在此处挂载，保持单点可查。
 */
export function registerAllHandlers(): void {
  registerDomain('app', appHandlers)
  log.info(`已注册 ${listRegistered().length} 个 IPC 动作`)
}
