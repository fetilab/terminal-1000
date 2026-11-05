// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * sftp 域：文件浏览、上传下载（含目录递归）、进度、取消、
 * 权限管理、远端文件读写。
 *
 * 动作清单见 packages/shared/src/ipc.ts 的 Actions.sftp。
 */
import type { IpcHandler } from '../../ipc/router'

export const sftpHandlers: Record<string, IpcHandler> = {}
