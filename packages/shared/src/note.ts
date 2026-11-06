// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 笔记领域模型。
 *
 * 特色能力（对齐并超过参考实现）：
 * - 笔记可**关联到具体连接或分组**，运维时随手记录
 * - 废纸篓语义（软删除 + 可恢复 + 可彻底清除）
 * - Markdown 正文，编辑器侧用 Monaco
 */

/** 笔记 */
export interface Note {
  id: string
  title: string
  /** Markdown 正文 */
  content: string
  /** 所属文件夹 */
  folderId?: string
  /** 关联的连接（可选） */
  connectionId?: string
  /** 关联的分组（可选） */
  groupId?: string
  tags?: string[]
  /** 收藏 */
  favorite?: boolean
  /** 是否在废纸篓 */
  trashed?: boolean
  /** 进入废纸篓的时间 */
  deletedAt?: string
  createdAt: string
  updatedAt: string
}

/** 笔记文件夹（支持多级） */
export interface NoteFolder {
  id: string
  name: string
  parentId?: string
  sortOrder: number
  createdAt: string
  updatedAt: string
}

/** 笔记列表项（不含正文，避免列表传输大文本） */
export interface NoteSummary {
  id: string
  title: string
  folderId?: string
  connectionId?: string
  groupId?: string
  tags?: string[]
  favorite?: boolean
  trashed?: boolean
  deletedAt?: string
  /** 正文长度，用于列表展示体量 */
  contentLength: number
  /** 正文前若干字符，列表预览用 */
  excerpt: string
  createdAt: string
  updatedAt: string
}
