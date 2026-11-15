// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 笔记面板（接真实 notes 域）。
 *
 * 信息架构：分类栏（面板列）| 笔记列表 | 编辑器。
 * 列表用 NoteSummary（不含正文），只有打开某条时才 `get` 正文 ——
 * 这是主进程刻意的设计（正文可能几十 KB），渲染层不该绕过它拉全量。
 *
 * 编辑器是懒加载 chunk（见 NoteEditor）。
 */

import { Suspense, lazy, useEffect, useMemo, useState } from 'react'
import type { Note } from '@t1000/shared'
import { Button, IconButton } from '../../components/Button'
import { Badge, Banner, EmptyState, Loading } from '../../components/Feedback'
import { Field, TextInput } from '../../components/Form'
import { Icon } from '../../components/Icon'
import { Modal } from '../../components/Modal'
import { toast } from '../../components/Toast'
import { formatRelativeTime } from '../../lib/format'
import {
  actions,
  loadNoteFolders,
  loadNotes,
  newNote,
  openNote,
  purgeNote,
  restoreNote,
  saveNoteDraft,
  saveNoteFolder,
  trashNote,
  updateNoteDraft,
  useStoreShallow,
  type NotesFilter,
} from '../../lib/store'
import './notes.css'

/** 编辑器单独成 chunk：只读列表不需要拖上它 */
const NoteEditor = lazy(() => import('./NoteEditor'))

/* ── 侧栏 ──────────────────────────────────────── */

function FolderDialog({ open, onClose }: { open: boolean; onClose: () => void }): React.JSX.Element {
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)

  const submit = async (): Promise<void> => {
    const trimmed = name.trim()
    if (!trimmed) {
      setError('文件夹名不能为空')
      return
    }
    await saveNoteFolder(trimmed)
    setName('')
    onClose()
  }

  return (
    <Modal
      open={open}
      size="sm"
      title="新建文件夹"
      onClose={onClose}
      footer={
        <>
          <div className="t-modal__footer-spacer" />
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" onClick={() => void submit()}>
            创建
          </Button>
        </>
      }
    >
      <Field label="名称" required error={error}>
        <TextInput
          value={name}
          placeholder="例如：变更记录"
          autoFocus
          onChange={(e) => {
            setName(e.target.value)
            setError(null)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void submit()
          }}
        />
      </Field>
    </Modal>
  )
}

export function NotesSidebar(): React.JSX.Element {
  const { filter, stats, folders } = useStoreShallow((s) => ({
    filter: s.notesFilter,
    stats: s.noteStats,
    folders: s.noteFolders,
  }))
  const [dialogOpen, setDialogOpen] = useState(false)

  const row = (
    key: NotesFilter,
    icon: 'notes' | 'star-filled' | 'trash' | 'folder',
    label: string,
    count: number,
  ): React.JSX.Element => (
    <button
      key={key}
      type="button"
      className={`tree__row${filter === key ? ' tree__row--active' : ''}`}
      aria-current={filter === key || undefined}
      onClick={() => {
        actions.setNotesFilter(key)
        void loadNotes()
      }}
    >
      <span className="tree__twisty tree__twisty--leaf" aria-hidden>
        <Icon name="chevron-right" size={12} />
      </span>
      <Icon name={icon} size={14} />
      <span className="tree__label">{label}</span>
      <span className="tree__count">{count}</span>
    </button>
  )

  return (
    <aside className="panel" aria-label="笔记">
      <header className="panel-header">
        <span className="panel-title">笔记</span>
        <IconButton
          icon="refresh"
          label="刷新"
          onClick={() => {
            void loadNotes()
            void loadNoteFolders()
          }}
        />
      </header>

      <div className="panel-body">
        <nav className="tree" role="tree" aria-label="笔记分类">
          {row('all', 'notes', '全部笔记', stats.all)}
          {row('favorites', 'star-filled', '我的收藏', stats.favorites)}
          {row('trash', 'trash', '废纸篓', stats.trash)}
          <div className="tree__section">文件夹</div>
          {folders.length === 0 ? (
            <div className="tree__empty">还没有文件夹。用下方按钮把笔记按主题归类。</div>
          ) : (
            folders.map((f) => row(`folder:${f.id}`, 'folder', f.name, stats.byFolder[f.id] ?? 0))
          )}
        </nav>
      </div>

      <div className="panel-footer">
        <IconButton icon="folder" label="新建文件夹" onClick={() => setDialogOpen(true)} />
        <Button
          size="sm"
          variant="outline"
          icon="plus"
          style={{ flex: 1 }}
          onClick={() => {
            const fid = filter.startsWith('folder:') ? filter.slice('folder:'.length) : undefined
            newNote(fid)
          }}
        >
          新建笔记
        </Button>
      </div>

      <FolderDialog open={dialogOpen} onClose={() => setDialogOpen(false)} />
    </aside>
  )
}

/* ── 主视图 ────────────────────────────────────── */

export default function NotesView(): React.JSX.Element {
  const { notes, folders, filter, query, draft, dirty, saving, loading, ready, error, connections, groups } =
    useStoreShallow((s) => ({
      notes: s.notes,
      folders: s.noteFolders,
      filter: s.notesFilter,
      query: s.notesQuery,
      draft: s.noteDraft,
      dirty: s.noteDirty,
      saving: s.noteSaving,
      loading: s.notesLoading,
      ready: s.notesReady,
      error: s.notesError,
      connections: s.connections,
      groups: s.groups,
    }))

  useEffect(() => {
    void loadNoteFolders()
    void loadNotes()
  }, [])

  // 搜索防抖：别每敲一个字符发一次 IPC
  const [search, setSearch] = useState(query)
  useEffect(() => {
    const t = window.setTimeout(() => {
      if (search !== query) {
        actions.setNotesQuery(search)
        void loadNotes()
      }
    }, 350)
    return () => window.clearTimeout(t)
  }, [search, query])

  const flatGroups = useMemo(() => {
    const out: Array<{ id: string; name: string }> = []
    const walk = (nodes: typeof groups, depth: number): void => {
      for (const n of nodes) {
        out.push({ id: n.id, name: `${'　'.repeat(depth)}${n.name}` })
        walk(n.children, depth + 1)
      }
    }
    walk(groups, 0)
    return out
  }, [groups])

  const trashed = filter === 'trash'

  const editorNode = draft ? (
    <Suspense fallback={<Loading text="正在载入编辑器…" />}>
      <NoteEditor
        draft={draft}
        folders={folders}
        connections={connections}
        groups={flatGroups}
        dirty={dirty}
        saving={saving}
        onPatch={(patch: Partial<Note>) => updateNoteDraft(patch)}
        onSave={() => {
          void saveNoteDraft().then((ok) => {
            if (ok) toast.ok('笔记已保存')
          })
        }}
        onTrash={() => {
          if (draft.id) void trashNote(draft.id)
        }}
        onRestore={() => {
          if (draft.id) void restoreNote(draft.id)
        }}
        onPurge={() => {
          if (draft.id) void purgeNote(draft.id)
        }}
      />
    </Suspense>
  ) : (
    <EmptyState
      icon="notes"
      title={notes.length === 0 ? '这里还没有笔记' : '选择左侧的一条笔记'}
      text="笔记支持 Markdown，并且可以关联到具体连接或分组——排查问题时把结论就地记在对应机器上。"
      actions={
        <Button variant="primary" icon="plus" onClick={() => newNote()}>
          新建笔记
        </Button>
      }
    />
  )

  return (
    <main className="content" aria-label="笔记">
      <div className="t-toolbar">
        <div className="t-search">
          <span className="t-search__icon">
            <Icon name="search" size={14} />
          </span>
          <input
            className="t-input"
            value={search}
            placeholder="搜索标题或正文…"
            aria-label="搜索笔记"
            onChange={(e) => setSearch(e.target.value)}
          />
          {search ? (
            <IconButton
              className="t-search__clear"
              icon="close"
              label="清空搜索"
              onClick={() => setSearch('')}
            />
          ) : null}
        </div>
        <div className="t-toolbar__spacer" />
        {trashed ? <Badge tone="warn">废纸篓</Badge> : null}
        <Badge>{notes.length} 条</Badge>
        <IconButton icon="refresh" label="刷新列表" onClick={() => void loadNotes()} />
      </div>

      {!ready && error ? (
        <div style={{ padding: '10px 12px 0' }}>
          <Banner tone="warn">笔记服务不可用：{error}</Banner>
        </div>
      ) : null}

      <div className="notes-split">
        <div className="notes-list" role="list">
          {loading && notes.length === 0 ? (
            <Loading text="读取笔记…" />
          ) : notes.length === 0 ? (
            <div className="notes-list__empty">
              {query
                ? '没有匹配的笔记'
                : trashed
                  ? '废纸篓是空的'
                  : filter === 'favorites'
                    ? '还没有收藏的笔记'
                    : '这个分类下还没有笔记'}
            </div>
          ) : (
            notes.map((n) => {
              const active = draft?.id === n.id
              return (
                <div
                  key={n.id}
                  role="listitem"
                  className={`notes-item${active ? ' notes-item--active' : ''}`}
                  tabIndex={0}
                  onClick={() => void openNote(n.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      void openNote(n.id)
                    }
                  }}
                >
                  <div className="notes-item__head">
                    {n.favorite ? <Icon name="star-filled" size={12} /> : null}
                    <span className="notes-item__title">{n.title || '未命名笔记'}</span>
                  </div>
                  {n.excerpt ? <div className="notes-item__excerpt">{n.excerpt}</div> : null}
                  <div className="notes-item__meta">
                    <span>{formatRelativeTime(n.updatedAt)}</span>
                    {n.contentLength > 0 ? <span>{n.contentLength} 字</span> : null}
                    {n.connectionId ? (
                      <Badge tone="accent">
                        {connections.find((c) => c.id === n.connectionId)?.name ?? '已关联连接'}
                      </Badge>
                    ) : null}
                  </div>
                </div>
              )
            })
          )}
        </div>

        <div className="notes-detail">{editorNode}</div>
      </div>
    </main>
  )
}
