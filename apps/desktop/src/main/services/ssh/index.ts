// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * ssh 域：SSH 会话生命周期、5 态认证、跳板机链路、代理、算法、
 * keepalive、主机指纹校验、终端数据流。
 *
 * 动作清单见 packages/shared/src/ipc.ts 的 Actions.ssh。
 */
import type { IpcHandler } from '../../ipc/router'

export const sshHandlers: Record<string, IpcHandler> = {}
