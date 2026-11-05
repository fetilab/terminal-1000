// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * pty 域：本地终端（node-pty）、shell profile、Shell Integration。
 *
 * 动作清单见 packages/shared/src/ipc.ts 的 Actions.pty。
 */
import type { IpcHandler } from '../../ipc/router'

export const ptyHandlers: Record<string, IpcHandler> = {}
