// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * store 域：SQLite 持久化、连接/分组/凭证仓储、主密码加密、备份导入导出。
 *
 * 动作清单见 packages/shared/src/ipc.ts 的 Actions.store。
 */
import type { IpcHandler } from '../../ipc/router'

export const storeHandlers: Record<string, IpcHandler> = {}
