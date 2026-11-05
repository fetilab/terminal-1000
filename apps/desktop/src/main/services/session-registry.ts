// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 运行时会话注册表 —— 模块间的**中立契约**。
 *
 * 为什么单独放这里：SFTP / 监控 / 端口转发都需要「借」一个已建立的 SSH 会话，
 * 但它们不应该直接 import ssh 服务的内部实现。ssh 服务把已就绪的会话登记进来，
 * 其它模块按 sessionId 取用，双方只依赖本文件。
 */

import type { Client } from 'ssh2'
import type { ConnectionState } from '@t1000/shared'

/** 远端命令执行结果 */
export interface ExecResult {
  stdout: string
  stderr: string
  /** 退出码；无法获取时为 -1 */
  code: number
}

/** 在已建立会话上执行远端命令 */
export interface RemoteExec {
  exec(command: string, options?: { timeoutMs?: number }): Promise<ExecResult>
}

/** 一个已建立的 SSH 会话句柄 */
export interface SshSessionHandle {
  sessionId: string
  connectionId: string
  /** 底层 ssh2 客户端；需要 SFTP/转发等原生能力时使用 */
  client: Client
  host: string
  port: number
  username: string
  state: ConnectionState
  /** 建立时刻（ms epoch） */
  connectedAt: number
  /** 该会话是否支持 SFTP 子系统 */
  sftpAvailable?: boolean
  /** 远端命令执行能力（监控采集等使用） */
  exec: RemoteExec
}

const sessions = new Map<string, SshSessionHandle>()

export function registerSession(handle: SshSessionHandle): void {
  sessions.set(handle.sessionId, handle)
}

export function unregisterSession(sessionId: string): void {
  sessions.delete(sessionId)
}

export function getSession(sessionId: string): SshSessionHandle | undefined {
  return sessions.get(sessionId)
}

/** 取会话，不存在则抛错（调用方需要明确失败而非 undefined 时用） */
export function requireSession(sessionId: string): SshSessionHandle {
  const s = sessions.get(sessionId)
  if (!s) throw new Error(`会话不存在或已断开: ${sessionId}`)
  return s
}

export function listSessionIds(): string[] {
  return [...sessions.keys()]
}

export function listSessions(): SshSessionHandle[] {
  return [...sessions.values()]
}

/** 测试用：清空注册表 */
export function clearSessions(): void {
  sessions.clear()
}
