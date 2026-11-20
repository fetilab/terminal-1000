// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * SFTP 树视图的**渲染层**。
 *
 * 它只负责把 `treeModel.flattenTree` 摊平好的行画出来，以及转发交互事件；
 * 展开/折叠、懒加载缓存、方向键语义、选择状态全都在父组件与 treeModel 里，
 * 所以树与列表共用同一套行为，不会出现两套口径。
 *
 * 性能：行列表同样走 `VirtualList`（固定行高 30px），深层目录展开上千行也不全量渲染。
 */

import { EmptyState, Badge, Loading } from '../../components/Feedback'
import { Icon } from '../../components/Icon'
import { VirtualList } from '../../components/VirtualList'
import { formatBytes, formatDate } from '../../lib/format'
import { isSelected, type ClickMods, type SelectionState } from './selection'
import { entryIconType, type RemoteEntry } from './sftpTypes'
import type { TreeNode } from './treeModel'

export interface SftpTreeProps {
  rows: readonly TreeNode<RemoteEntry>[]
  selection: SelectionState
  /** 键盘活动行（与"选中"分开：方向键只移动焦点，不改变选择） */
  activeKey: string | null
  /** 根目录仍在读取 */
  loading: boolean
  /** 根目录为空时的说明 */
  emptyText: string
  onRowClick: (row: TreeNode<RemoteEntry>, mods: ClickMods) => void
  onRowDoubleClick: (row: TreeNode<RemoteEntry>) => void
  onToggle: (row: TreeNode<RemoteEntry>) => void
  onContextMenu: (row: TreeNode<RemoteEntry>, x: number, y: number) => void
  onKeyDown: (e: React.KeyboardEvent<HTMLDivElement>) => void
  onBlankMouseDown: () => void
  /** 目录读取失败后的重试 */
  onRetry: (row: TreeNode<RemoteEntry>) => void
}

function statusRow(row: TreeNode<RemoteEntry>, onRetry: (row: TreeNode<RemoteEntry>) => void): React.JSX.Element {
  const indent = { paddingLeft: 14 + row.depth * 14 }
  if (row.status === 'error') {
    return (
      <div
        className="sftp-tree__status sftp-tree__status--error"
        style={indent}
        data-testid="sftp-tree-status"
        data-path={row.path}
      >
        <Icon name="alert-triangle" size={12} />
        <span className="sftp-tree__status-text" title={row.message}>
          {row.message ?? '读取失败'}
        </span>
        <button type="button" className="sftp-tree__retry" onClick={() => onRetry(row)}>
          重试
        </button>
      </div>
    )
  }
  return (
    <div className="sftp-tree__status" style={indent} data-testid="sftp-tree-status" data-path={row.path}>
      <Icon name="clock" size={12} />
      <span className="sftp-tree__status-text">读取中…</span>
    </div>
  )
}

export function SftpTree({
  rows,
  selection,
  activeKey,
  loading,
  emptyText,
  onRowClick,
  onRowDoubleClick,
  onToggle,
  onContextMenu,
  onKeyDown,
  onBlankMouseDown,
  onRetry,
}: SftpTreeProps): React.JSX.Element {
  const renderRow = (row: TreeNode<RemoteEntry>): React.JSX.Element => {
    if (row.kind === 'status') return statusRow(row, onRetry)

    const entry = row.entry
    if (!entry) return <div className="sftp-tree__status" style={{ paddingLeft: 14 + row.depth * 14 }} />

    const selected = isSelected(selection, entry.path)
    const kind = entryIconType(entry)
    const active = activeKey === row.key

    return (
      <div
        className={`sftp-row sftp-tree__row${selected ? ' sftp-row--selected' : ''}${
          active ? ' sftp-tree__row--active' : ''
        }`}
        data-testid="sftp-tree-row"
        data-path={entry.path}
        data-entry-type={entry.type}
        data-tree-key={row.key}
        role="treeitem"
        aria-selected={selected}
        aria-level={row.depth + 1}
        aria-expanded={row.isDirectory ? row.expanded : undefined}
        onClick={(e) => onRowClick(row, { ctrl: e.ctrlKey, meta: e.metaKey, shift: e.shiftKey })}
        onDoubleClick={() => onRowDoubleClick(row)}
        onContextMenu={(e) => {
          e.preventDefault()
          onContextMenu(row, e.clientX, e.clientY)
        }}
      >
        <div className="sftp-row__name" style={{ paddingLeft: row.depth * 14 }}>
          {row.isDirectory ? (
            <button
              type="button"
              className="sftp-tree__twisty"
              data-testid="sftp-tree-toggle"
              aria-label={`${row.expanded ? '折叠' : '展开'} ${entry.name}`}
              onClick={(e) => {
                // 只切换展开态，不改变选择、也不触发行的单击语义
                e.stopPropagation()
                onToggle(row)
              }}
              onDoubleClick={(e) => e.stopPropagation()}
            >
              <Icon name={row.expanded ? 'chevron-down' : 'chevron-right'} size={12} />
            </button>
          ) : (
            <span className="sftp-tree__spacer" aria-hidden="true" />
          )}
          <Icon
            name={kind === 'folder' ? (row.expanded ? 'folder-open' : 'folder') : kind === 'link' ? 'connections' : 'notes'}
            size={13}
          />
          <span title={entry.name}>{entry.name}</span>
          {kind === 'link' ? <Badge tone="outline">软链</Badge> : null}
        </div>
        <span className="sftp-row__num" style={{ textAlign: 'right' }}>
          {row.isDirectory ? '—' : formatBytes(entry.size)}
        </span>
        <span className="sftp-row__perm">{entry.permissions}</span>
        {/* mtime 契约是秒（SFTP 线路单位），new Date 需要毫秒 */}
        <span className="sftp-row__num">{formatDate(new Date(entry.mtime * 1000).toISOString())}</span>
      </div>
    )
  }

  return (
    <div
      className="sftp-list sftp-tree"
      data-testid="sftp-tree"
      tabIndex={0}
      role="tree"
      aria-multiselectable
      aria-label="远端目录树"
      // 键盘只在树被聚焦时生效 —— 与列表同一策略，绝不抢终端快捷键
      onKeyDown={onKeyDown}
      onMouseDown={(e) => {
        const el = e.currentTarget
        if (document.activeElement !== el) el.focus()
        if (!(e.target as HTMLElement).closest('[data-testid="sftp-tree-row"]')) onBlankMouseDown()
      }}
    >
      {rows.length === 0 ? (
        loading ? (
          <Loading text="读取目录…" />
        ) : (
          <EmptyState icon="folder" title="没有可展开的目录" text={emptyText} />
        )
      ) : (
        <VirtualList
          items={rows}
          rowHeight={30}
          className="sftp-scroll"
          getKey={(r) => r.key}
          renderRow={renderRow}
        />
      )}
    </div>
  )
}
