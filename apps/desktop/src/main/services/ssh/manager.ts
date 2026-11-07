// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * SSH 会话管理器：会话生命周期、事件桥接、已知主机指纹存储。
 *
 * 与 UI 的交互通过事件回调完成（由 IPC 层注入），管理器本身不依赖 Electron。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { ConnectionState, SshConnection } from '@t1000/shared'
import { AppError } from '../../errors'
import { createLogger } from '../../logger'
import {
  listSessions as listRegistrySessions,
  registerSession,
  unregisterSession,
  publishSessionData,
  type SshSessionHandle,
} from '../session-registry'
import { SshSession, type AuthPromptInfo, type HostKeyAskInfo } from './session'

const log = createLogger('ssh-manager')

/**
 * 管理器对外的事件出口。
 *
 * onHostKeyAsk / onAuthPrompt 是**单向通知**（把询问推给 UI），
 * 决议由 UI 反向调用 resolveHostKeyAsk / resolveAuthPrompt 完成 ——
 * 挂起状态只由管理器持有，避免多处各存一份 resolver 导致决议丢失。
 */
export interface ManagerEvents {
  onState(sessionId: string, state: ConnectionState, message?: string): void
  onData(sessionId: string, data: string): void
  onDebug(sessionId: string, message: string): void
  onError(sessionId: string, message: string, code?: string): void
  onClosed(sessionId: string, reason?: string, code?: number): void
  onHostKeyAsk(requestId: string, sessionId: string, info: HostKeyAskInfo): void
  onAuthPrompt(requestId: string, sessionId: string, info: AuthPromptInfo): void
}

/** 待决议的交互请求（主机指纹 / 认证提示） */
interface PendingInteraction<T> {
  resolve: (value: T) => void
  timer: NodeJS.Timeout
}

/** 交互请求超时（ms）—— 用户不响应不应永久挂起连接 */
const INTERACTION_TIMEOUT_MS = 120_000

export class SshManager {
  private readonly sessions = new Map<string, SshSession>()

  /** 已知主机指纹：`host:port` → SHA256 指纹 */
  private knownHosts = new Map<string, string>()

  private readonly pendingHostKey = new Map<string, PendingInteraction<boolean>>()
  private readonly pendingAuth = new Map<string, PendingInteraction<string[]>>()

  constructor(
    private readonly events: ManagerEvents,
    private readonly knownHostsFile: string,
    private readonly resolveIdentity?: (id: string) => { privateKey?: string; passphrase?: string; password?: string } | undefined,
  ) {
    this.loadKnownHosts()
  }

  // ── 已知主机指纹持久化 ────────────────────────────────

  private loadKnownHosts(): void {
    try {
      if (!existsSync(this.knownHostsFile)) return
      const raw = readFileSync(this.knownHostsFile, 'utf8')
      const obj = JSON.parse(raw) as Record<string, string>
      this.knownHosts = new Map(Object.entries(obj))
      log.debug(`已加载 ${this.knownHosts.size} 条主机指纹`)
    } catch (err) {
      log.warn('主机指纹文件损坏，忽略', err)
      this.knownHosts = new Map()
    }
  }

  private saveKnownHosts(): void {
    try {
      const dir = dirname(this.knownHostsFile)
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      const obj = Object.fromEntries(this.knownHosts)
      writeFileSync(this.knownHostsFile, JSON.stringify(obj, null, 2), { mode: 0o600 })
    } catch (err) {
      log.warn('主机指纹保存失败', err)
    }
  }

  /** 记录一个已确认的主机指纹 */
  rememberHostKey(host: string, port: number, fingerprint: string): void {
    this.knownHosts.set(`${host}:${port}`, fingerprint)
    this.saveKnownHosts()
  }

  /** 移除一条主机指纹（用户主动"忘记"时） */
  forgetHostKey(host: string, port: number): void {
    if (this.knownHosts.delete(`${host}:${port}`)) this.saveKnownHosts()
  }

  listKnownHosts(): Array<{ host: string; fingerprint: string }> {
    return [...this.knownHosts.entries()].map(([host, fingerprint]) => ({ host, fingerprint }))
  }

  // ── 交互请求决议 ─────────────────────────────────────

  /** 由 IPC 层在用户做出选择后调用 */
  resolveHostKeyAsk(requestId: string, accepted: boolean): void {
    const p = this.pendingHostKey.get(requestId)
    if (!p) return
    clearTimeout(p.timer)
    this.pendingHostKey.delete(requestId)
    p.resolve(accepted)
  }

  /** 会话在用户接受新指纹后回调，由管理器统一落盘 */
  private handleHostKeyAccepted(host: string, port: number, fingerprint: string): void {
    this.knownHosts.set(`${host}:${port}`, fingerprint)
    this.saveKnownHosts()
    log.info(`已信任主机指纹 ${host}:${port}`)
  }

  /** 由 IPC 层在用户填写交互式认证后调用 */
  resolveAuthPrompt(requestId: string, responses: string[]): void {
    const p = this.pendingAuth.get(requestId)
    if (!p) return
    clearTimeout(p.timer)
    this.pendingAuth.delete(requestId)
    p.resolve(responses)
  }

  private newRequestId(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  }

  // ── 会话生命周期 ─────────────────────────────────────

  /**
   * 建立连接。
   * @returns sessionId
   */
  async connect(connection: SshConnection): Promise<string> {
    if (!connection.host) throw AppError.badRequest('主机地址不能为空')
    if (!connection.username) throw AppError.badRequest('用户名不能为空')

    // 显式标注类型：事件回调里会引用 session.sessionId，
    // 不标注会让 TS 陷入循环推断（TS7022/TS7023）。
    const session: SshSession = new SshSession(connection, {
      knownHosts: this.knownHosts,
      ...(this.resolveIdentity ? { resolveIdentity: this.resolveIdentity } : {}),
      onHostKeyAccepted: (host, port, fingerprint) => {
        this.handleHostKeyAccepted(host, port, fingerprint)
      },
      events: {
        onState: (state, message) => {
          this.events.onState(session.sessionId, state, message)
        },
        onData: (data) => {
          this.events.onData(session.sessionId, data)
          // 同时分发给内部订阅者（会话日志/录制）。
          // 走中立契约：录制不依赖"界面恰好订阅了 SSH_DATA"，界面关掉也能继续记。
          publishSessionData(session.sessionId, data)
        },
        onDebug: (message) => {
          this.events.onDebug(session.sessionId, message)
        },
        onError: (message, code) => {
          this.events.onError(session.sessionId, message, code)
        },
        onClosed: (reason, code) => {
          unregisterSession(session.sessionId)
          this.sessions.delete(session.sessionId)
          this.events.onClosed(session.sessionId, reason, code)
        },
        // 会话层 await 这两个回调的返回值；
        // 挂起由管理器持有，决议走 resolveHostKeyAsk / resolveAuthPrompt
        onHostKeyAsk: (info) => this.askHostKey(session.sessionId, info),
        onAuthPrompt: (info) => this.askAuth(session.sessionId, info),
      },
    })

    this.sessions.set(session.sessionId, session)

    try {
      await session.connect()
      // 连接就绪后登记到中立注册表，供 SFTP / 监控 / 转发取用
      registerSession(session.getInfo())
      return session.sessionId
    } catch (err) {
      this.sessions.delete(session.sessionId)
      throw err
    }
  }

  private askHostKey(sessionId: string, info: HostKeyAskInfo): Promise<boolean> {
    const requestId = this.newRequestId()
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingHostKey.delete(requestId)
        // 超时按拒绝处理：安全默认，避免无人值守时被静默信任
        log.warn(`主机指纹询问超时，按拒绝处理 ${info.host}:${info.port}`)
        resolve(false)
      }, INTERACTION_TIMEOUT_MS)

      this.pendingHostKey.set(requestId, { resolve, timer })
      // 把询问推给 UI；决议走 resolveHostKeyAsk
      this.events.onHostKeyAsk(requestId, sessionId, info)
    })
  }

  private askAuth(sessionId: string, info: AuthPromptInfo): Promise<string[]> {
    const requestId = this.newRequestId()
    return new Promise<string[]>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingAuth.delete(requestId)
        resolve([])
      }, INTERACTION_TIMEOUT_MS)

      this.pendingAuth.set(requestId, { resolve, timer })
      this.events.onAuthPrompt(requestId, sessionId, info)
    })
  }

  getSession(sessionId: string): SshSession | undefined {
    return this.sessions.get(sessionId)
  }

  requireSession(sessionId: string): SshSession {
    const s = this.sessions.get(sessionId)
    if (!s) throw AppError.notConnected(`会话不存在: ${sessionId}`)
    return s
  }

  /** 已建立会话的只读信息（不含底层 client） */
  listSessions(): Array<{ sessionId: string; connectionId: string; state: ConnectionState; host: string }> {
    return listRegistrySessions().map((s: SshSessionHandle) => ({
      sessionId: s.sessionId,
      connectionId: s.connectionId,
      state: s.state,
      host: s.host,
    }))
  }

  write(sessionId: string, data: string): void {
    this.requireSession(sessionId).write(data)
  }

  resize(sessionId: string, cols: number, rows: number): void {
    this.requireSession(sessionId).resize(cols, rows)
  }

  disconnect(sessionId: string): void {
    const s = this.sessions.get(sessionId)
    if (!s) return
    s.disconnect()
    this.sessions.delete(sessionId)
    unregisterSession(sessionId)
  }

  /** 关闭全部会话（应用退出时调用） */
  disconnectAll(): void {
    for (const id of [...this.sessions.keys()]) {
      this.disconnect(id)
    }
  }

  /**
   * 测试连接（不打开 shell，只验证可达与认证）。
   * 用于连接表单的"测试连接"按钮。
   */
  async testConnection(connection: SshConnection): Promise<{ ok: boolean; message: string; latencyMs: number }> {
    const started = Date.now()
    const session = new SshSession(
      { ...connection, name: `__test__${connection.name}` },
      {
        knownHosts: this.knownHosts,
        ...(this.resolveIdentity ? { resolveIdentity: this.resolveIdentity } : {}),
        events: {
          onState: () => {},
          onData: () => {},
          onDebug: () => {},
          onError: () => {},
          onClosed: () => {},
          onHostKeyAsk: async (info) => {
            // 测试连接时自动接受并向用户回显指纹（首次连接场景）
            if (!info.mismatch) this.rememberHostKey(info.host, info.port, info.fingerprint)
            return !info.mismatch
          },
          onAuthPrompt: async () => [],
        },
      },
    )

    try {
      await session.connect()
      const latencyMs = Date.now() - started
      session.disconnect()
      return { ok: true, message: '连接成功', latencyMs }
    } catch (err) {
      try {
        session.disconnect()
      } catch {
        /* 忽略 */
      }
      return {
        ok: false,
        message: err instanceof Error ? err.message : String(err),
        latencyMs: Date.now() - started,
      }
    }
  }
}
