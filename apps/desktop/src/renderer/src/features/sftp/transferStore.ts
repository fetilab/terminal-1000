// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 传输队列状态（**独立小 store，不进全局 store**）。
 *
 * 理由与终端里 SSH_DATA 不进全局 store 一致：
 * 进度事件是高频数据，进了全局 store 就会让整棵树参与比对。
 * 这里只让传输队列组件订阅，其余界面完全不受影响。
 *
 * 主进程已把进度节流到 200ms（transfer.progressThrottleMs），
 * 所以这里不需要再节流，只做「按 transferId 归并」。
 */

import { useSyncExternalStore } from 'react'
import { Events, type TransferSummary } from '@t1000/shared'
import { subscribe } from '../../lib/ipc'
import { toast } from '../../components/Toast'
import { formatBytes } from '../../lib/format'

export interface TransferItem {
  transferId: string
  sessionId: string
  direction: 'upload' | 'download'
  file: string
  transferredBytes: number
  totalBytes: number
  filesDone?: number
  filesTotal?: number
  speed?: number
  /** 'running' | 'finished' | 'failed' | 'cancelled' */
  status: 'running' | 'finished' | 'failed' | 'cancelled'
  message?: string
  /** 目录扫描阶段的反馈（10000 文件时用户需要知道在做什么） */
  scanning?: { path: string; files: number; bytes: number } | null
  finishedAt?: number
}

let items: TransferItem[] = []
const listeners = new Set<() => void>()

function emit(): void {
  for (const l of listeners) l()
}

function subscribeStore(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function snapshot(): TransferItem[] {
  return items
}

function upsert(id: string, patch: Partial<TransferItem> & { transferId: string }): void {
  const idx = items.findIndex((t) => t.transferId === id)
  if (idx === -1) {
    items = [patch as TransferItem, ...items].slice(0, 200)
  } else {
    const next = items.slice()
    next[idx] = { ...next[idx], ...patch } as TransferItem
    items = next
  }
  emit()
}

/** 已结束的条目保留一段时间再淡出，避免用户还没看到就消失 */
const RETENTION_MS = 5 * 60_000

function prune(): void {
  const now = Date.now()
  const next = items.filter(
    (t) => t.status === 'running' || !t.finishedAt || now - t.finishedAt < RETENTION_MS,
  )
  if (next.length !== items.length) {
    items = next
    emit()
  }
}

export function clearFinished(): void {
  items = items.filter((t) => t.status === 'running')
  emit()
}

export function useTransfers(): TransferItem[] {
  return useSyncExternalStore(subscribeStore, snapshot, snapshot)
}

export function transfersFor(sessionId: string | undefined): TransferItem[] {
  if (!sessionId) return []
  return items.filter((t) => t.sessionId === sessionId)
}

let wired = false

/** 订阅传输事件。整个应用只需接一次（模块级幂等）。 */
export function wireTransferEvents(): void {
  if (wired) return
  wired = true

  subscribe(Events.SFTP_TRANSFER_PROGRESS, (p) => {
    upsert(p.transferId, {
      transferId: p.transferId,
      sessionId: p.sessionId,
      direction: p.direction,
      file: p.file,
      transferredBytes: p.transferredBytes,
      totalBytes: p.totalBytes,
      ...(p.filesDone === undefined ? {} : { filesDone: p.filesDone }),
      ...(p.filesTotal === undefined ? {} : { filesTotal: p.filesTotal }),
      ...(p.speed === undefined ? {} : { speed: p.speed }),
      status: 'running',
    })
  })

  subscribe(Events.SFTP_DIR_SCANNED, (p) => {
    // 扫描阶段没有 transferId：挂到该会话最近一条 running 上
    const target = items.find((t) => t.sessionId === p.sessionId && t.status === 'running')
    if (!target) return
    upsert(target.transferId, {
      transferId: target.transferId,
      scanning: { path: p.path, files: p.files, bytes: p.bytes },
    })
  })

  subscribe(Events.SFTP_TRANSFER_FINISHED, (p) => {
    upsert(p.transferId, {
      transferId: p.transferId,
      sessionId: p.sessionId,
      direction: p.direction,
      status: 'finished',
      finishedAt: Date.now(),
      scanning: null,
    })
    const summary = p as unknown as TransferSummary
    const extra =
      summary.skipped || summary.failed
        ? `（跳过 ${summary.skipped ?? 0}，失败 ${summary.failed ?? 0}）`
        : ''
    toast.ok(
      `${p.direction === 'upload' ? '上传' : '下载'}完成：${p.files} 个文件 · ${formatBytes(p.bytes)}${extra}`,
    )
    prune()
  })

  subscribe(Events.SFTP_TRANSFER_ERROR, (p) => {
    upsert(p.transferId, {
      transferId: p.transferId,
      sessionId: p.sessionId,
      status: 'failed',
      message: p.message,
      finishedAt: Date.now(),
      scanning: null,
      ...(p.file ? { file: p.file } : {}),
    })
    toast.error(`传输失败${p.file ? `（${p.file}）` : ''}：${p.message}`)
  })
}

/** 取消后由调用方标记（主进程不发专门事件，状态要靠 UI 收敛） */
export function markCancelled(transferId: string): void {
  upsert(transferId, { transferId, status: 'cancelled', finishedAt: Date.now() })
}
