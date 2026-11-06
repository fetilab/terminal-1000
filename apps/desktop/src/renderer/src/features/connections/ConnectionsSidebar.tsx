// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

import { useMemo, useState, type DragEvent } from 'react'
import type { ConnectionGroup, ConnectionKind } from '@t1000/shared'
import { Icon } from '../../components/Icon'
import { Button, IconButton } from '../../components/Button'
import { Field, Select, TextInput } from '../../components/Form'
import { Banner } from '../../components/Feedback'
import { Modal } from '../../components/Modal'
import {
  FILTER_ALL,
  FILTER_FAVORITE,
  FILTER_FREQUENT,
  FILTER_RECENT,
  actions,
  loadConnections,
  moveConnection,
  newConnectionId,
  saveGroup,
  useStoreShallow,
  type GroupNode,
  type UiConnection,
} from '../../lib/store'
import './connections.css'

/** 拖拽负载的 MIME，避免与外部拖入内容混淆 */
export const CONNECTION_DND_TYPE = 'application/x-t1000-connection'

/* ── 计数 ───────────────────────────────────────── */

interface Counts {
  all: number
  favorite: number
  recent: number
  frequent: number
  byGroup: Map<string, number>
}

function useCounts(): Counts {
  const connections = useStoreShallow(
    useMemo(() => (s: { connections: UiConnection[] }) => ({ connections: s.connections }), []),
  ).connections
  const protocol = useStoreShallow(
    useMemo(() => (s: { protocol: ConnectionKind }) => ({ protocol: s.protocol }), []),
  ).protocol

  return useMemo(() => {
    const byGroup = new Map<string, number>()
    let all = 0
    let favorite = 0
    let recent = 0
    let frequent = 0
    const now = Date.now()

    for (const conn of connections) {
      if (conn.kind !== protocol) continue
      all += 1
      if (conn.favorite) favorite += 1
      if (conn.lastUsedAt) {
        const t = Date.parse(conn.lastUsedAt)
        if (Number.isFinite(t) && now - t <= 7 * 86_400_000) recent += 1
      }
      if (conn.useCount && conn.useCount > 0) frequent += 1
      if (conn.groupId) byGroup.set(conn.groupId, (byGroup.get(conn.groupId) ?? 0) + 1)
    }
    return { all, favorite, recent, frequent, byGroup }
  }, [connections, protocol])
}

/** 子树计数：分组节点上的数字要含后代，否则多级分组看起来是空的。 */
function subtreeCount(node: GroupNode, byGroup: Map<string, number>): number {
  let total = byGroup.get(node.id) ?? 0
  for (const child of node.children) total += subtreeCount(child, byGroup)
  return total
}

/* ── 行 ─────────────────────────────────────────── */

interface FilterRowProps {
  icon: Parameters<typeof Icon>[0]['name']
  label: string
  count: number
  active: boolean
  onClick: () => void
}

function FilterRow({ icon, label, count, active, onClick }: FilterRowProps): React.JSX.Element {
  return (
    <button
      type="button"
      className={`tree__row${active ? ' tree__row--active' : ''}`}
      onClick={onClick}
      aria-current={active || undefined}
    >
      <span className="tree__twisty tree__twisty--leaf" aria-hidden>
        <Icon name="chevron-right" size={12} />
      </span>
      <Icon name={icon} size={14} />
      <span className="tree__label">{label}</span>
      <span className="tree__count">{count}</span>
    </button>
  )
}

interface GroupRowProps {
  node: GroupNode
  depth: number
  byGroup: Map<string, number>
  filter: string
  expanded: Set<string>
  onToggle: (id: string) => void
  onDropConnection: (connectionId: string, groupId: string) => void
}

function GroupRow({
  node,
  depth,
  byGroup,
  filter,
  expanded,
  onToggle,
  onDropConnection,
}: GroupRowProps): React.JSX.Element {
  const [dropActive, setDropActive] = useState(false)
  const isOpen = expanded.has(node.id)
  const hasChildren = node.children.length > 0
  const active = filter === node.id
  const count = subtreeCount(node, byGroup)

  const onDragOver = (e: DragEvent<HTMLDivElement>): void => {
    if (!e.dataTransfer.types.includes(CONNECTION_DND_TYPE)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    setDropActive(true)
  }

  return (
    <div className="tree__group">
      <div
        onDragOver={onDragOver}
        onDragLeave={() => setDropActive(false)}
        onDrop={(e) => {
          setDropActive(false)
          const id = e.dataTransfer.getData(CONNECTION_DND_TYPE)
          if (!id) return
          e.preventDefault()
          onDropConnection(id, node.id)
        }}
      >
        <div
          className={`tree__row${active ? ' tree__row--active' : ''}${dropActive ? ' tree__row--drop' : ''}`}
          style={{ paddingLeft: 8 + depth * 13 }}
          onClick={() => actions.setFilter(node.id)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              actions.setFilter(node.id)
            }
          }}
          role="treeitem"
          aria-expanded={hasChildren ? isOpen : undefined}
          aria-selected={active}
          tabIndex={0}
        >
          <span
            className={`tree__twisty${isOpen ? ' tree__twisty--open' : ''}${hasChildren ? '' : ' tree__twisty--leaf'}`}
            aria-hidden
            onClick={(e) => {
              e.stopPropagation()
              onToggle(node.id)
            }}
          >
            <Icon name="chevron-right" size={12} />
          </span>
          <Icon name={isOpen && hasChildren ? 'folder-open' : 'folder'} size={14} />
          <span className="tree__label" title={node.name}>
            {node.name}
          </span>
          <span className="tree__count">{count}</span>
        </div>
      </div>
      {hasChildren && isOpen ? (
        <div className="tree__children" role="group">
          {node.children.map((child) => (
            <GroupRow
              key={child.id}
              node={child}
              depth={depth + 1}
              byGroup={byGroup}
              filter={filter}
              expanded={expanded}
              onToggle={onToggle}
              onDropConnection={onDropConnection}
            />
          ))}
        </div>
      ) : null}
    </div>
  )
}

/* ── 新建分组弹窗 ───────────────────────────────── */

function GroupDialog({
  open,
  groups,
  defaultParentId,
  onClose,
}: {
  open: boolean
  groups: GroupNode[]
  defaultParentId: string | null
  onClose: () => void
}): React.JSX.Element {
  const [name, setName] = useState('')
  const [parentId, setParentId] = useState(defaultParentId ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const flat = useMemo(() => {
    const out: Array<{ id: string; label: string; depth: number }> = []
    const walk = (nodes: GroupNode[], depth: number): void => {
      for (const n of nodes) {
        out.push({ id: n.id, label: n.name, depth })
        walk(n.children, depth + 1)
      }
    }
    walk(groups, 0)
    return out
  }, [groups])

  const submit = async (): Promise<void> => {
    const trimmed = name.trim()
    if (!trimmed) {
      setError('分组名不能为空')
      return
    }
    setBusy(true)
    const now = new Date().toISOString()
    const group: ConnectionGroup = {
      id: newConnectionId(),
      name: trimmed,
      kind: 'ssh',
      sortOrder: flat.length,
      storeType: 'local',
      createdAt: now,
      updatedAt: now,
      ...(parentId ? { parentId } : {}),
    }
    const ok = await saveGroup(group)
    setBusy(false)
    if (ok) {
      setName('')
      onClose()
    } else {
      setError('保存失败，请检查存储是否可用')
    }
  }

  return (
    <Modal
      open={open}
      size="sm"
      title="新建分组"
      onClose={onClose}
      footer={
        <>
          <div className="t-modal__footer-spacer" />
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" loading={busy} onClick={() => void submit()}>
            创建
          </Button>
        </>
      }
    >
      <div className="t-grid">
        <Field label="分组名称" required error={error}>
          <TextInput
            value={name}
            placeholder="例如：生产环境 / Web 集群"
            onChange={(e) => {
              setName(e.target.value)
              setError(null)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submit()
            }}
          />
        </Field>
        <Field label="上级分组" hint="留空则创建为顶层分组">
          <Select
            value={parentId}
            onChange={(e) => setParentId(e.target.value)}
            options={[
              { value: '', label: '（顶层）' },
              ...flat.map((g) => ({ value: g.id, label: `${'　'.repeat(g.depth)}${g.label}` })),
            ]}
          />
        </Field>
      </div>
    </Modal>
  )
}

/* ── 侧边栏 ─────────────────────────────────────── */

export function ConnectionsSidebar(): React.JSX.Element {
  const { groups, filter, backendReady, backendError, loaded } = useStoreShallow((s) => ({
    groups: s.groups,
    filter: s.filter,
    backendReady: s.backendReady,
    backendError: s.backendError,
    loaded: s.loaded,
  }))
  const counts = useCounts()
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [dialogOpen, setDialogOpen] = useState(false)

  const toggle = (id: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const expandAll = (): void => {
    const ids: string[] = []
    const walk = (nodes: GroupNode[]): void => {
      for (const n of nodes) {
        if (n.children.length > 0) ids.push(n.id)
        walk(n.children)
      }
    }
    walk(groups)
    setExpanded(new Set(ids))
  }

  const collapseAll = (): void => setExpanded(new Set())

  return (
    <aside className="panel" aria-label="连接分组">
      <header className="panel-header">
        <span className="panel-title">连接中心</span>
        <IconButton icon="refresh" label="刷新列表" onClick={() => void loadConnections(true)} />
      </header>

      <div className="panel-body">
        {!backendReady && loaded ? (
          <div style={{ padding: 8 }}>
            <Banner tone="warn">
              存储服务不可用{backendError ? `：${backendError}` : ''}
              <br />
              当前展示的是内存数据，重启后不保留。
            </Banner>
          </div>
        ) : null}

        <nav className="tree" role="tree" aria-label="分组树">
          <FilterRow
            icon="server"
            label="全部"
            count={counts.all}
            active={filter === FILTER_ALL}
            onClick={() => actions.setFilter(FILTER_ALL)}
          />
          <FilterRow
            icon="star-filled"
            label="收藏"
            count={counts.favorite}
            active={filter === FILTER_FAVORITE}
            onClick={() => actions.setFilter(FILTER_FAVORITE)}
          />
          <FilterRow
            icon="clock"
            label="最近"
            count={counts.recent}
            active={filter === FILTER_RECENT}
            onClick={() => actions.setFilter(FILTER_RECENT)}
          />
          <FilterRow
            icon="zap"
            label="常用"
            count={counts.frequent}
            active={filter === FILTER_FREQUENT}
            onClick={() => actions.setFilter(FILTER_FREQUENT)}
          />

          <div className="tree__section">自定义分组</div>
          {groups.length === 0 ? (
            <div className="tree__empty">还没有分组。用下方「+ 分组」把连接按环境或用途归类。</div>
          ) : (
            groups.map((node) => (
              <GroupRow
                key={node.id}
                node={node}
                depth={0}
                byGroup={counts.byGroup}
                filter={filter}
                expanded={expanded}
                onToggle={toggle}
                onDropConnection={(connectionId, groupId) => void moveConnection(connectionId, groupId)}
              />
            ))
          )}
        </nav>
      </div>

      <div className="panel-footer">
        <IconButton
          icon="chevron-down"
          label="全部折叠"
          onClick={() => {
            collapseAll()
          }}
        />
        <IconButton
          icon="chevron-right"
          label="全部展开"
          onClick={() => {
            expandAll()
          }}
        />
        <div style={{ flex: 1 }} />
        <IconButton icon="folder" label="新建分组" onClick={() => setDialogOpen(true)} />
        <Button size="sm" variant="outline" icon="plus" onClick={() => actions.openCreate('ssh')}>
          连接
        </Button>
      </div>

      <GroupDialog
        open={dialogOpen}
        groups={groups}
        defaultParentId={null}
        onClose={() => setDialogOpen(false)}
      />
    </aside>
  )
}
