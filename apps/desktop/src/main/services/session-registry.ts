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

/**
 * 在已建立会话上执行远端命令。
 * 用可调用签名（而非 `{ exec(): ... }`），调用端写成 `session.exec(cmd)` 更自然。
 */
export interface RemoteExec {
  (command: string, options?: { timeoutMs?: number }): Promise<ExecResult>
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
  const existed = sessions.delete(sessionId)
  // 会话注销即广播"已关闭"：订阅方（如会话日志）据此自动收尾，
  // 不需要 ssh 服务反过来调用日志服务（那样两个服务就互相依赖了）。
  if (existed) publishSessionClosed(sessionId)
}

/**
 * 会话关闭订阅 —— 与数据订阅同属中立契约：
 * 生产者只 publish，消费者只 subscribe，双方互不感知。
 */
const closedListeners = new Set<(sessionId: string) => void>()

export function subscribeSessionClosed(listener: (sessionId: string) => void): () => void {
  closedListeners.add(listener)
  return () => {
    closedListeners.delete(listener)
  }
}

export function publishSessionClosed(sessionId: string): void {
  // 数据订阅一并清掉，避免监听器悬挂
  dataListeners.delete(sessionId)
  for (const listener of closedListeners) {
    try {
      listener(sessionId)
    } catch {
      /* 单个订阅者出错不影响其它 */
    }
  }
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

/**
 * 会话输出订阅（会话日志 / 录制用）。
 *
 * 放在中立契约里而不是让日志服务 import ssh 服务内部：
 * 生产者（ssh 会话）只负责 publish，消费者（sessionlog）只负责 subscribe，
 * 双方都不需要知道对方的存在。
 *
 * 与渲染层的 SSH_DATA 事件是**两条独立通道** ——
 * 录制不能依赖"界面恰好订阅了"，界面关掉时也要能继续记。
 */
const dataListeners = new Map<string, Set<(chunk: string) => void>>()

/** 订阅某会话的输出；返回取消订阅函数 */
export function subscribeSessionData(sessionId: string, listener: (chunk: string) => void): () => void {
  let set = dataListeners.get(sessionId)
  if (!set) {
    set = new Set()
    dataListeners.set(sessionId, set)
  }
  set.add(listener)

  return () => {
    const current = dataListeners.get(sessionId)
    if (!current) return
    current.delete(listener)
    if (current.size === 0) dataListeners.delete(sessionId)
  }
}

/** 由会话生产者调用：把输出分发给所有订阅者 */
export function publishSessionData(sessionId: string, chunk: string): void {
  const set = dataListeners.get(sessionId)
  if (!set || set.size === 0) return
  for (const listener of set) {
    try {
      listener(chunk)
    } catch {
      // 单个订阅者出错不应影响会话本身或其它订阅者
    }
  }
}

/** 该会话当前有多少订阅者（测试与诊断用） */
export function sessionDataListenerCount(sessionId: string): number {
  return dataListeners.get(sessionId)?.size ?? 0
}

// ── 可写入会话（并发广播用）──────────────────────────
//
// 广播需要"往一批终端里写同样的输入"，但 ssh / pty / telnet 的写入口各不相同
// （ssh 走 session.write、pty 走 pty.write、telnet 还要先过按键映射）。
// 让广播服务去 import 三个服务显然不对，所以在这里放一个中立的写入口：
// 各服务登记自己的写入函数，广播按 sessionId 取用。

/** 终端型会话（可接收用户输入的那类） */
export interface WritableSession {
  sessionId: string
  kind: 'ssh' | 'pty' | 'telnet'
  /** 展示名（连接名 / 终端标题），广播界面显示成员用 */
  title: string
  /** 写入用户输入（实现方自己负责按键映射等细节） */
  write(data: string): void
  /**
   * 当前是否可写。
   * 用于跳过已断开或只读（如 VNC viewOnly）的成员 ——
   * 不检查的话广播会静默丢输入，用户以为发出去了。
   */
  canWrite(): boolean
}

const writables = new Map<string, WritableSession>()

export function registerWritable(session: WritableSession): void {
  writables.set(session.sessionId, session)
}

export function unregisterWritable(sessionId: string): void {
  writables.delete(sessionId)
}

export function getWritable(sessionId: string): WritableSession | undefined {
  return writables.get(sessionId)
}

export function listWritables(): WritableSession[] {
  return [...writables.values()]
}

/** 测试用：清空注册表 */
export function clearSessions(): void {
  sessions.clear()
  dataListeners.clear()
  writables.clear()
}
