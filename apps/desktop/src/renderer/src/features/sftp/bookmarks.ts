// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * SFTP 目录书签（渲染层轻量存储）。
 *
 * 为什么不放 settings：settings 的写入是**深合并**，往里塞数组会让
 * "删除一个书签"变成一次读-改-写整个 settings，还要处理合并语义与同步范围；
 * 书签是很典型的"界面私有小数据"，用 localStorage 更简单也更不容易出错。
 *
 * 按 **connectionId** 分组而不是 sessionId：会话一断开 sessionId 就没了，
 * 书签要跟着连接走才能跨重连保留。
 *
 * ⚠️ 代价（如实记录）：localStorage 不参与「零知识同步」，也不随本地库备份走。
 * 如果以后要让书签跟着账号同步，就得迁到主进程存储里。
 */

export interface SftpBookmark {
  id: string
  connectionId: string
  /** 用户可读的名字（默认取路径最后一段） */
  name: string
  path: string
  createdAt: string
}

const KEY = 't1000.sftpBookmarks.v1'

function readAll(): SftpBookmark[] {
  try {
    const raw = window.localStorage.getItem(KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (b): b is SftpBookmark =>
        typeof b === 'object' &&
        b !== null &&
        typeof (b as SftpBookmark).id === 'string' &&
        typeof (b as SftpBookmark).connectionId === 'string' &&
        typeof (b as SftpBookmark).path === 'string',
    )
  } catch {
    // 存储损坏时按"没有书签"处理，不让它把浏览器整个搞挂
    return []
  }
}

function writeAll(list: SftpBookmark[]): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(list))
  } catch {
    /* 配额满/隐私模式：静默降级，功能仍可用只是不持久 */
  }
}

export function listBookmarks(connectionId: string | undefined): SftpBookmark[] {
  if (!connectionId) return []
  return readAll()
    .filter((b) => b.connectionId === connectionId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
}

/** 同一连接下同 path 只留一条 */
export function addBookmark(connectionId: string, path: string, name?: string): SftpBookmark {
  const all = readAll()
  const existing = all.find((b) => b.connectionId === connectionId && b.path === path)
  if (existing) return existing
  const seg = path.split('/').filter(Boolean).pop()
  const item: SftpBookmark = {
    id: `bm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    connectionId,
    name: (name?.trim() || seg || path || '/').slice(0, 60),
    path: path || '/',
    createdAt: new Date().toISOString(),
  }
  writeAll([...all, item])
  return item
}

export function removeBookmark(id: string): void {
  writeAll(readAll().filter((b) => b.id !== id))
}

export function renameBookmark(id: string, name: string): void {
  writeAll(
    readAll().map((b) => (b.id === id ? { ...b, name: name.trim().slice(0, 60) || b.name } : b)),
  )
}

/** 测试/维护用：清空全部书签 */
export function clearBookmarks(): void {
  writeAll([])
}
