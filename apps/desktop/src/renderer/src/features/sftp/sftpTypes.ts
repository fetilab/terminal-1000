// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * SFTP 前端类型。
 *
 * ⚠️ `RemoteEntry` / `RemoteTextFile` 目前只定义在主进程 `services/sftp/browser.ts`，
 * `packages/shared` 里没有（transfer 域的类型倒是已经在 shared 了）。
 * 这里镜像一份并已在反馈中提出：应像 PingResult / GroupTreeNode 一样上移到 shared，
 * 否则字段一改就是静默漂移。上移后本文件应只保留 UI 自己的类型。
 */

export type RemoteEntryType = 'directory' | 'file' | 'symlink' | 'other'

export interface RemoteEntry {
  name: string
  /** 规范化后的绝对路径 */
  path: string
  type: RemoteEntryType
  size: number
  mtime: number
  /** 数字权限位（低 12 位） */
  mode: number
  /** rwxr-xr-x 形式 */
  permissions: string
  uid: number
  gid: number
  /** ls -l 风格长名称 */
  longname: string
}

export interface RemoteTextFile {
  path: string
  content: string
  size: number
  mtime: number
  mode: number
}

export interface OpenEditorResult {
  remotePath: string
  /** 物化到本机临时目录的副本路径 */
  localPath: string
  size: number
  mtime: number
  mode: number
  editId: string
}

/** 权限字符串 → 三位八进制（chmod 用） */
export function modeToOctal(mode: number): string {
  return (mode & 0o777).toString(8).padStart(3, '0')
}

/** 八进制字符串 → 数字；非法返回 undefined */
export function octalToMode(text: string): number | undefined {
  const trimmed = text.trim()
  if (!/^[0-7]{3,4}$/.test(trimmed)) return undefined
  return Number.parseInt(trimmed, 8)
}

/** 远端路径拼接（保留根目录语义） */
export function joinRemote(dir: string, name: string): string {
  if (dir === '/' || dir === '') return `/${name}`
  return `${dir.replace(/\/+$/, '')}/${name}`
}

/** 取父目录 */
export function parentRemote(path: string): string {
  const trimmed = path.replace(/\/+$/, '')
  const idx = trimmed.lastIndexOf('/')
  if (idx <= 0) return '/'
  return trimmed.slice(0, idx)
}

/** 面包屑分段 */
export function breadcrumbSegments(path: string): Array<{ label: string; path: string }> {
  const parts = path.split('/').filter(Boolean)
  const out: Array<{ label: string; path: string }> = [{ label: '/', path: '/' }]
  let acc = ''
  for (const p of parts) {
    acc += `/${p}`
    out.push({ label: p, path: acc })
  }
  return out
}

export function entryIconType(entry: RemoteEntry): 'folder' | 'file' | 'link' {
  if (entry.type === 'directory') return 'folder'
  if (entry.type === 'symlink') return 'link'
  return 'file'
}
