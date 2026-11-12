// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 远端文件编辑会话：**把改动写回远端**。
 *
 * ## 为什么需要它
 * 早先的 `openEditor` 只做了一半：把远端文件物化到临时目录、用系统编辑器打开、提示"已打开"。
 * 但**没有任何写回路径** —— `editId` 返回了却无人消费。用户在编辑器里改完保存，
 * **远端文件永远不变**，而界面此前已经提示成功打开。这是**静默丢改动**，
 * 比"不能编辑"糟得多（用户以为改好了）。
 *
 * ## 两个方向的数据安全
 * 写回这件事本身也会丢数据，所以这里同时防两件事：
 * 1. **用户的改动不能丢**：本地文件一改就写回（防抖后），失败要**如实报出来**
 * 2. **别人的改动不能被静默覆盖**：物化时记下远端 mtime，写回前再 stat 一次；
 *    若远端在这期间被改过，仍然写（用户的编辑是明确的意图）但**在事件里标记**
 *    `remoteChangedSinceOpen`，由界面提示"远端在此期间被改过，可能覆盖了别人的修改"。
 *    选择"写并告知"而不是"拒绝写入"，是因为拒绝会让用户的编辑无处可去 —— 那也是一种丢数据。
 */

import { existsSync, readFileSync, statSync, watch, type FSWatcher } from 'node:fs'
import { createHash } from 'node:crypto'
import { Events, type EventName } from '@t1000/shared'
import { createLogger } from '../../logger'
import { writeRemoteTextFile, statPath } from './browser'
import type { SftpLike } from './browser'

const log = createLogger('sftp-editor')

/** 写回防抖：编辑器保存常常连发多次写事件，攒一下再传 */
const SAVE_DEBOUNCE_MS = 400

/** 单次写回的大小上限（与读取上限一致的量级；编辑场景本来就是小文件） */
const MAX_WRITE_BYTES = 8 * 1024 * 1024

export interface EditorSession {
  editId: string
  sessionId: string
  remotePath: string
  localPath: string
  /** 物化时远端的 mtime（用于检测"远端在此期间被别人改过"） */
  remoteMtimeAtOpen: number
  /** 物化时的内容摘要（用于跳过"内容没变"的写回） */
  lastHash: string
  startedAt: number
}

export interface EditorDeps {
  /** 取某会话的 SFTP 通道（由 index.ts 注入，避免这里反向依赖服务内部） */
  sftpFor: (sessionId: string) => Promise<SftpLike>
  emit: (event: EventName, payload: unknown) => void
}

/** 计算内容摘要（用于判断"真的变了没"） */
export function hashContent(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex')
}

export class RemoteEditorRegistry {
  private readonly sessions = new Map<string, EditorSession>()
  private readonly watchers = new Map<string, FSWatcher>()
  private readonly timers = new Map<string, NodeJS.Timeout>()

  constructor(private readonly deps: EditorDeps) {}

  /** 登记一个编辑会话并开始监听本地副本 */
  open(session: EditorSession): void {
    this.sessions.set(session.editId, session)
    this.watch(session)
  }

  get(editId: string): EditorSession | undefined {
    return this.sessions.get(editId)
  }

  list(): EditorSession[] {
    return [...this.sessions.values()]
  }

  /** 结束编辑会话：停掉监听与计时器 */
  close(editId: string): boolean {
    const session = this.sessions.get(editId)
    if (!session) return false
    const w = this.watchers.get(editId)
    if (w) {
      try {
        w.close()
      } catch {
        /* 已经关了 */
      }
    }
    const t = this.timers.get(editId)
    if (t) clearTimeout(t)
    this.watchers.delete(editId)
    this.timers.delete(editId)
    this.sessions.delete(editId)
    return true
  }

  /** 会话断开时清掉它的所有编辑会话（否则监听会留着，写回必然失败） */
  closeBySession(sessionId: string): number {
    let n = 0
    for (const s of [...this.sessions.values()]) {
      if (s.sessionId === sessionId) {
        this.close(s.editId)
        n += 1
      }
    }
    return n
  }

  closeAll(): void {
    for (const id of [...this.sessions.keys()]) this.close(id)
  }

  private watch(session: EditorSession): void {
    try {
      // fs.watch 而不是轮询：编辑器保存是低频事件，轮询会白白占 CPU
      const w = watch(session.localPath, () => this.scheduleSave(session.editId))
      w.on('error', (err) => {
        log.warn(`编辑副本监听失败: ${session.localPath}`, err)
        this.deps.emit(Events.SFTP_EDIT_ERROR, {
          editId: session.editId,
          remotePath: session.remotePath,
          message: `无法监听本地副本（${err.message}）——改动不会自动写回远端`,
        })
      })
      this.watchers.set(session.editId, w)
    } catch (err) {
      // 监听不上必须**立刻告知**：否则用户以为会自动保存，实际不会
      const message = err instanceof Error ? err.message : String(err)
      log.warn('无法监听编辑副本', err)
      this.deps.emit(Events.SFTP_EDIT_ERROR, {
        editId: session.editId,
        remotePath: session.remotePath,
        message: `无法监听本地副本（${message}）——改动不会自动写回远端；可手动调用保存`,
      })
    }
  }

  private scheduleSave(editId: string): void {
    const existing = this.timers.get(editId)
    if (existing) clearTimeout(existing)
    const t = setTimeout(() => {
      this.timers.delete(editId)
      // ⚠️ 必须接住拒绝：这是"无人 await"的路径，未处理的 Promise 拒绝会刷屏甚至让进程出问题。
      // 失败原因已经通过 SFTP_EDIT_ERROR 事件告知用户了，这里只需不让它悬空。
      void this.save(editId, 'auto').catch((err: unknown) => {
        log.debug(`自动写回未成功（已发事件告知）: ${editId}`, err)
        // 本地副本都没了（临时目录被清理等）→ 这个会话已经不可能再写回，直接收掉，
        // 免得之后每次文件事件都白试一遍。
        if (!existsSync(this.sessions.get(editId)?.localPath ?? '')) {
          this.close(editId)
        }
      })
    }, SAVE_DEBOUNCE_MS)
    this.timers.set(editId, t)
  }

  /**
   * 写回远端。
   *
   * @param reason `auto` 自动（本地变更触发）/ `manual` 用户显式保存
   */
  async save(
    editId: string,
    reason: 'auto' | 'manual' = 'manual',
  ): Promise<{ bytes: number; skipped: boolean; remoteChangedSinceOpen: boolean }> {
    const session = this.sessions.get(editId)
    if (!session) throw new Error(`编辑会话不存在或已结束: ${editId}`)

    if (!existsSync(session.localPath)) {
      this.deps.emit(Events.SFTP_EDIT_ERROR, {
        editId,
        remotePath: session.remotePath,
        message: '本地编辑副本已不存在（可能被临时目录清理）——未写回远端',
      })
      throw new Error('本地编辑副本不存在')
    }

    const stat = statSync(session.localPath)
    if (!stat.isFile()) throw new Error('本地编辑副本不是文件')
    if (stat.size > MAX_WRITE_BYTES) {
      const message = `编辑副本过大（${stat.size} 字节 > 上限 ${MAX_WRITE_BYTES}），已拒绝写回`
      this.deps.emit(Events.SFTP_EDIT_ERROR, { editId, remotePath: session.remotePath, message })
      throw new Error(message)
    }

    const data = readFileSync(session.localPath)
    const hash = hashContent(data)
    // 内容没变就别传（编辑器可能只是 touch 了一下）
    if (hash === session.lastHash) {
      return { bytes: 0, skipped: true, remoteChangedSinceOpen: false }
    }

    const sftp = await this.deps.sftpFor(session.sessionId)

    // 远端在编辑期间被改过吗？（写之前查，避免"用旧认知覆盖别人的改动"）
    let remoteChangedSinceOpen = false
    try {
      const remote = await statPath(sftp, session.remotePath)
      remoteChangedSinceOpen = Math.abs(remote.mtime - session.remoteMtimeAtOpen) > 1000
    } catch {
      // 远端查不到（被删了？）——不阻塞写回，但要知道
      remoteChangedSinceOpen = true
    }

    try {
      const result = await writeRemoteTextFile(sftp, session.remotePath, data)
      session.lastHash = hash
      this.deps.emit(Events.SFTP_EDIT_SAVED, {
        editId,
        sessionId: session.sessionId,
        remotePath: session.remotePath,
        bytes: result.size,
        at: Date.now(),
        reason,
        remoteChangedSinceOpen,
      })
      log.info(
        `编辑改动已写回 ${session.remotePath}（${result.size} 字节，${reason}，远端期间被改过=${remoteChangedSinceOpen}）`,
      )
      return { bytes: result.size, skipped: false, remoteChangedSinceOpen }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      // 写回失败**必须让用户知道** —— 否则他以为存到远端了（正是本次要修的那个问题）
      this.deps.emit(Events.SFTP_EDIT_ERROR, {
        editId,
        sessionId: session.sessionId,
        remotePath: session.remotePath,
        message: `写回远端失败：${message}（本地副本仍保留在 ${session.localPath}）`,
      })
      log.warn(`写回失败 ${session.remotePath}`, err)
      throw err
    }
  }
}
