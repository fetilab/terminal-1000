// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Note, NoteFolder, NoteSummary } from '@t1000/shared'
import { StoreService, setStoreService } from '../store'
import { AppError } from '../../errors'
import { notesHandlers } from './index'

const ctx = {
  logger: { debug() {}, info() {}, warn() {}, error() {} },
  paths: {
    userData: '/tmp',
    dbFile: ':memory:',
    notesDir: '/tmp',
    sessionLogDir: '/tmp',
    watchDir: '/tmp',
    bgImagesDir: '/tmp',
    backupDir: '/tmp',
    logDir: '/tmp',
  },
  emit() {},
} as never

const call = <T = unknown>(action: string, payload?: unknown): T => {
  const handler = notesHandlers[action]
  if (!handler) throw new Error(`未实现: ${action}`)
  return handler(payload, ctx) as T
}

describe('notes 域', () => {
  beforeEach(() => {
    setStoreService(new StoreService(':memory:'))
  })
  afterEach(() => {
    setStoreService(null)
  })

  it('新建笔记返回完整对象并带 id/时间戳', () => {
    const note = call<Note>('save', { title: '运维记录', content: '# 标题\n内容' })

    expect(note.id).toBeTruthy()
    expect(note.title).toBe('运维记录')
    expect(note.content).toContain('内容')
    expect(note.trashed).toBe(false)
    expect(note.createdAt).toBeTruthy()
    expect(note.updatedAt).toBeTruthy()
  })

  it('未给标题时使用默认名', () => {
    const note = call<Note>('save', { content: 'x' })
    expect(note.title).toBe('未命名笔记')
  })

  it('★ list 返回摘要且不含正文（性能关键属性）', () => {
    const long = 'x'.repeat(5000)
    call('save', { title: '长文', content: long })

    const list = call<NoteSummary[]>('list', {})
    expect(list).toHaveLength(1)

    const item = list[0]!
    expect(item.contentLength).toBe(5000)
    expect(item.excerpt.length).toBeLessThanOrEqual(160)
    // 摘要里不应出现完整正文
    expect(Object.prototype.hasOwnProperty.call(item, 'content')).toBe(false)
  })

  it('摘要把空白折叠成单空格', () => {
    call('save', { title: 't', content: 'a\n\n b\t\tc' })
    const list = call<NoteSummary[]>('list', {})
    expect(list[0]!.excerpt).toBe('a b c')
  })

  it('更新笔记保留 createdAt，只更新 updatedAt', async () => {
    const created = call<Note>('save', { title: 'old', content: 'a' })
    await new Promise((r) => setTimeout(r, 5))
    const updated = call<Note>('save', { id: created.id, title: 'new' })

    expect(updated.id).toBe(created.id)
    expect(updated.title).toBe('new')
    expect(updated.content).toBe('a') // 未传的字段保持原值
    expect(updated.createdAt).toBe(created.createdAt)
    expect(updated.updatedAt >= created.updatedAt).toBe(true)
  })

  it('更新不存在的笔记报 NOT_FOUND', () => {
    expect(() => call('save', { id: 'no-such-id', title: 'x' })).toThrow(AppError)
  })

  it('软删除进废纸篓：默认列表看不到，指定 trashed 才可见', () => {
    const note = call<Note>('save', { title: 't', content: 'c' })
    call('delete', { id: note.id })

    expect(call<NoteSummary[]>('list', {})).toHaveLength(0)
    const trash = call<NoteSummary[]>('list', { trashed: true })
    expect(trash).toHaveLength(1)
    expect(trash[0]!.deletedAt).toBeTruthy()
  })

  it('从废纸篓恢复后可再次出现在正常列表', () => {
    const note = call<Note>('save', { title: 't', content: 'c' })
    call('delete', { id: note.id })
    call('restore', { id: note.id })

    expect(call<NoteSummary[]>('list', {})).toHaveLength(1)
    const restored = call<Note>('get', { id: note.id })
    // deletedAt 必须被清掉，否则 UI 会以为还在回收站
    expect(restored.deletedAt).toBeUndefined()
  })

  it('恢复一个不在废纸篓的笔记会报错', () => {
    const note = call<Note>('save', { title: 't', content: 'c' })
    expect(() => call('restore', { id: note.id })).toThrow(/不在废纸篓/)
  })

  it('彻底删除后 get 报 NOT_FOUND', () => {
    const note = call<Note>('save', { title: 't', content: 'c' })
    call('delete', { id: note.id })
    call('purge', { id: note.id })

    expect(() => call('get', { id: note.id })).toThrow(AppError)
    expect(call<NoteSummary[]>('list', { trashed: true })).toHaveLength(0)
  })

  it('收藏过滤生效', () => {
    const a = call<Note>('save', { title: 'A', favorite: true })
    call('save', { title: 'B', favorite: false })

    const favs = call<NoteSummary[]>('list', { favoritesOnly: true })
    expect(favs).toHaveLength(1)
    expect(favs[0]!.id).toBe(a.id)
  })

  it('关键词过滤同时匹配标题与正文', () => {
    call('save', { title: '数据库备份', content: 'mysqldump 命令' })
    call('save', { title: '无关', content: 'nothing here' })

    expect(call<NoteSummary[]>('list', { keyword: '备份' })).toHaveLength(1)
    expect(call<NoteSummary[]>('list', { keyword: 'mysqldump' })).toHaveLength(1)
    expect(call<NoteSummary[]>('list', { keyword: 'zzz' })).toHaveLength(0)
  })

  it('按连接/分组关联并过滤', () => {
    call('save', { title: 'A', connectionId: 'conn-1' })
    call('save', { title: 'B', connectionId: 'conn-2' })

    const list = call<NoteSummary[]>('list', { connectionId: 'conn-1' })
    expect(list).toHaveLength(1)
    expect(list[0]!.connectionId).toBe('conn-1')
  })

  it('列表按 updatedAt 倒序（最近的在前）', async () => {
    const first = call<Note>('save', { title: 'first' })
    await new Promise((r) => setTimeout(r, 5))
    const second = call<Note>('save', { title: 'second' })

    const list = call<NoteSummary[]>('list', {})
    expect(list[0]!.id).toBe(second.id)
    expect(list[1]!.id).toBe(first.id)
  })

  it('limit 生效', () => {
    for (let i = 0; i < 5; i++) call('save', { title: `n${i}` })
    expect(call<NoteSummary[]>('list', { limit: 2 })).toHaveLength(2)
  })

  // ── 文件夹 ────────────────────────────────────────

  it('创建文件夹并支持多级', () => {
    const root = call<NoteFolder>('saveFolder', { name: '运维' })
    const child = call<NoteFolder>('saveFolder', { name: '数据库', parentId: root.id })

    const folders = call<NoteFolder[]>('listFolders')
    expect(folders).toHaveLength(2)
    expect(folders.find((f) => f.id === child.id)?.parentId).toBe(root.id)
  })

  it('删除文件夹递归删子文件夹，但笔记只解除归属不丢失', () => {
    const root = call<NoteFolder>('saveFolder', { name: 'root' })
    const child = call<NoteFolder>('saveFolder', { name: 'child', parentId: root.id })

    const inRoot = call<Note>('save', { title: 'a', folderId: root.id })
    const inChild = call<Note>('save', { title: 'b', folderId: child.id })
    const outside = call<Note>('save', { title: 'c' })

    const res = call<{ deletedFolders: string[]; detachedNotes: number }>('deleteFolder', { id: root.id })

    expect(res.deletedFolders).toHaveLength(2)
    expect(res.detachedNotes).toBe(2)
    expect(call<NoteFolder[]>('listFolders')).toHaveLength(0)

    // 三条笔记都还在，只是前两条失去了 folderId
    expect(call<NoteSummary[]>('list', {})).toHaveLength(3)
    expect(call<Note>('get', { id: inRoot.id }).folderId).toBeUndefined()
    expect(call<Note>('get', { id: inChild.id }).folderId).toBeUndefined()
    expect(call<Note>('get', { id: outside.id }).folderId).toBeUndefined()
  })

  it('删除不存在的文件夹报错', () => {
    expect(() => call('deleteFolder', { id: 'nope' })).toThrow(AppError)
  })

  it('落盘 JSON 不含 undefined 键（pruneUndefined 生效）', async () => {
    const note = call<Note>('save', { title: 't' })
    const { getStoreService } = await import('../store')
    const { STORE_KEYS } = await import('../store/db')

    const row = getStoreService().db.get(STORE_KEYS.note, note.id)
    expect(row).toBeTruthy()
    expect(row!.payload).not.toContain('undefined')
    expect(JSON.parse(row!.payload)).not.toHaveProperty('folderId')
  })
})
