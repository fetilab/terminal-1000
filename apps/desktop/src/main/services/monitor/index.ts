// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * monitor 域：远端采集脚本分发、按档轮询、指标快照与广播。
 *
 * 动作清单见 packages/shared/src/ipc.ts 的 Actions.monitor。
 */
import type { IpcHandler } from '../../ipc/router'

export const monitorHandlers: Record<string, IpcHandler> = {}
