// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * forward 域：端口转发（本地 / 远程 / 动态 SOCKS5）、自动重连。
 *
 * 动作清单见 packages/shared/src/ipc.ts 的 Actions.forward。
 */
import type { IpcHandler } from '../../ipc/router'

export const forwardHandlers: Record<string, IpcHandler> = {}
