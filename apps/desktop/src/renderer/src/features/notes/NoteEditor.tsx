// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 笔记编辑器（懒加载模块）。
 *
 * 编辑区已换成 **Monaco**（`features/editor/CodeEditor`，独立懒加载 chunk）。
 * Markdown 语法高亮 + Ctrl+F 查找替换由它提供；实时预览、元信息栏、
 * 保存/删除、脏标记这些外层逻辑保持不变。
 *
 * ⚠️ Monaco 加载失败时 CodeEditor 会**自动退回等宽 textarea**并说明原因，
 * 所以"编辑器挂了就编不了笔记"不会发生。
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import type { Connection, Note, NoteFolder } from '@t1000/shared'
import { Button, IconButton } from '../../components/Button'
import { Badge } from '../../components/Feedback'
import { Field, Select, Switch, TextInput } from '../../components/Form'
import { Icon } from '../../components/Icon'
import { formatDate } from '../../lib/format'
import { renderMarkdown } from './markdown'
import { CodeEditor } from '../editor/CodeEditor'

export interface NoteEditorProps {
  draft: Note
  folders: NoteFolder[]
  connections: Pick<Connection, 'id' | 'name' | 'kind'>[]
  groups: Array<{ id: string; name: string }>
  dirty: boolean
  saving: boolean
  onPatch: (patch: Partial<Note>) => void
  onSave: () => void
  onTrash: () => void
  onRestore: () => void
  onPurge: () => void
}

export function NoteEditor({
  draft,
  folders,
  connections,
  groups,
  dirty,
  saving,
  onPatch,
  onSave,
  onTrash,
  onRestore,
  onPurge,
}: NoteEditorProps): React.JSX.Element {
  const [mode, setMode] = useState<'split' | 'edit' | 'preview'>('split')
  const [confirmPurge, setConfirmPurge] = useState(false)
  const bodyRef = useRef<HTMLTextAreaElement | null>(null)

  const html = useMemo(() => renderMarkdown(draft.content), [draft.content])
  const isNew = !draft.id
  const trashed = draft.trashed === true

  // Ctrl/Cmd+S 保存：编辑器里的肌肉记忆，不接会很别扭
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
        e.preventDefault()
        onSave()
      }
      // Tab 在正文里插入两个空格而不是跳焦点
      if (e.key === 'Tab' && document.activeElement === bodyRef.current) {
        e.preventDefault()
        const el = bodyRef.current
        if (!el) return
        const start = el.selectionStart
        const end = el.selectionEnd
        const next = `${draft.content.slice(0, start)}  ${draft.content.slice(end)}`
        onPatch({ content: next })
        requestAnimationFrame(() => {
          el.selectionStart = el.selectionEnd = start + 2
        })
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [draft.content, onPatch, onSave])

  return (
    <div className="note-editor">
      <div className="note-editor__bar">
        <TextInput
          className="note-editor__title"
          value={draft.title}
          placeholder="笔记标题"
          aria-label="笔记标题"
          onChange={(e) => onPatch({ title: e.target.value })}
        />
        <IconButton
          icon={draft.favorite ? 'star-filled' : 'star'}
          label={draft.favorite ? '取消收藏' : '加入收藏'}
          tone={draft.favorite ? 'on' : 'default'}
          onClick={() => onPatch({ favorite: !draft.favorite })}
        />
        <div className="t-toolbar__divider" />
        <div className="t-segmented" role="tablist" aria-label="编辑器视图">
          {(
            [
              ['split', '分栏'],
              ['edit', '编辑'],
              ['preview', '预览'],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={mode === value}
              className={`t-segmented__item${mode === value ? ' t-segmented__item--active' : ''}`}
              onClick={() => setMode(value)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="note-editor__meta">
        <Field label="文件夹">
          <Select
            value={draft.folderId ?? ''}
            options={[{ value: '', label: '（未分类）' }, ...folders.map((f) => ({ value: f.id, label: f.name }))]}
            onChange={(e) => onPatch({ folderId: e.target.value || undefined })}
          />
        </Field>
        <Field label="关联连接" hint="运维时随手记：这条笔记属于哪台机器">
          <Select
            value={draft.connectionId ?? ''}
            options={[
              { value: '', label: '（不关联）' },
              ...connections.map((c) => ({ value: c.id, label: `${c.name} · ${c.kind.toUpperCase()}` })),
            ]}
            onChange={(e) => onPatch({ connectionId: e.target.value || undefined })}
          />
        </Field>
        <Field label="关联分组">
          <Select
            value={draft.groupId ?? ''}
            options={[{ value: '', label: '（不关联）' }, ...groups.map((g) => ({ value: g.id, label: g.name }))]}
            onChange={(e) => onPatch({ groupId: e.target.value || undefined })}
          />
        </Field>
        <div className="note-editor__flags">
          <Switch checked={draft.favorite === true} onChange={(v) => onPatch({ favorite: v })} label="收藏" />
          <span className="t-field__hint">
            {isNew ? '尚未保存' : `更新于 ${formatDate(draft.updatedAt)}`}
            {dirty ? ' · 有未保存改动' : ''}
          </span>
        </div>
      </div>

      <div className={`note-editor__panes note-editor__panes--${mode}`}>
        {mode !== 'preview' ? (
          <div className="note-editor__pane">
            <div className="note-editor__pane-label">
              <Icon name="edit" size={12} /> Markdown
            </div>
            <CodeEditor
              value={draft.content}
              language="markdown"
              height={360}
              ariaLabel="笔记内容"
              onChange={(next) => onPatch({ content: next })}
              onSave={onSave}
              statusLeft="Markdown"
            />
          </div>
        ) : null}
        {mode !== 'edit' ? (
          <div className="note-editor__pane">
            <div className="note-editor__pane-label">
              <Icon name="eye" size={12} /> 预览
            </div>
            {/* 内容已在 renderMarkdown 内做过 HTML 转义，只放行自生成的白名单标签 */}
            <div className="note-preview markdown-body" dangerouslySetInnerHTML={{ __html: html }} />
          </div>
        ) : null}
      </div>

      <div className="note-editor__actions">
        {trashed ? (
          <>
            <Badge tone="warn">在废纸篓中</Badge>
            <Button variant="outline" icon="refresh" onClick={onRestore}>
              恢复
            </Button>
            {confirmPurge ? (
              <>
                <span className="t-field__error">彻底删除后无法恢复，确认？</span>
                <Button variant="danger" icon="trash" onClick={onPurge}>
                  确认彻底删除
                </Button>
                <Button variant="ghost" onClick={() => setConfirmPurge(false)}>
                  取消
                </Button>
              </>
            ) : (
              <Button variant="danger" icon="trash" onClick={() => setConfirmPurge(true)}>
                彻底删除
              </Button>
            )}
          </>
        ) : (
          <>
            <Button variant="primary" icon="check" loading={saving} disabled={!dirty && !isNew} onClick={onSave}>
              {isNew ? '创建笔记' : '保存'}
            </Button>
            <span className="t-field__hint">
              <kbd className="t-kbd">Ctrl</kbd>+<kbd className="t-kbd">S</kbd>
            </span>
            <div className="t-toolbar__spacer" />
            <IconButton icon="trash" label="移入废纸篓" tone="danger" onClick={onTrash} disabled={isNew} />
          </>
        )}
      </div>
    </div>
  )
}

export default NoteEditor
