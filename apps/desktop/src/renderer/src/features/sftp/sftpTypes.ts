// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * SFTP 前端类型。
 *
 * 领域类型已上移到 `packages/shared/src/sftp.ts`，这里只做 re-export +
 * 渲染层自己的路径/权限辅助函数。
 */

/**
 * 领域类型统一从 `@t1000/shared` 引入（原先这里镜像了一份，属于契约漂移风险）。
 * 本文件只保留渲染层自己的路径/权限辅助函数。
 */
import type { RemoteEntry } from '@t1000/shared'

export type {
  OpenEditorResult,
  RemoteEntry,
  RemoteEntryType,
  RemoteTextFile,
} from '@t1000/shared'

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
