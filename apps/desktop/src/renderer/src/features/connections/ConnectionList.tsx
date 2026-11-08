// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

import { memo } from 'react'
import { Icon, type IconName } from '../../components/Icon'
import { Button, IconButton, StatusDot } from '../../components/Button'
import { Badge } from '../../components/Feedback'
import { toast } from '../../components/Toast'
import { Checkbox } from '../../components/Form'
import { VirtualList } from '../../components/VirtualList'
import { formatRelativeTime } from '../../lib/format'
import {
  actions,
  connectManyAsGroup,
  connectTo,
  connectionAddress,
  connectionUsername,
  deleteConnections,
  duplicateConnections,
  isFavorite,
  pingLabel,
  toggleFavorite,
  useStoreShallow,
  type PingEntry,
  type SortKey,
  type UiConnection,
} from '../../lib/store'
import { CONNECTION_DND_TYPE } from './ConnectionsSidebar'

const KIND_ICON: Record<UiConnection['kind'], IconName> = {
  ssh: 'terminal',
  rdp: 'server',
  telnet: 'server',
  tunnel: 'route',
  vnc: 'eye',
}

const KIND_LABEL: Record<UiConnection['kind'], string> = {
  ssh: 'SSH',
  rdp: 'RDP',
  telnet: 'Telnet',
  tunnel: '隧道',
  vnc: 'VNC',
}

const STATE_TEXT: Record<string, string> = {
  connecting: '连接中',
  authenticating: '认证中',
  'verifying-host-key': '校验指纹',
  ready: '已连接',
  disconnected: '已断开',
  failed: '失败',
}

interface HeaderProps {
  sortKey: SortKey
  sortDir: 'asc' | 'desc'
  allSelected: boolean
  someSelected: boolean
  showInfo: boolean
  onSelectAll: (checked: boolean) => void
}

function ListHeader({
  sortKey,
  sortDir,
  allSelected,
  someSelected,
  showInfo,
  onSelectAll,
}: HeaderProps): React.JSX.Element {
  const sortButton = (key: SortKey, label: string): React.JSX.Element => {
    const active = sortKey === key
    return (
      <button
        type="button"
        className={`connlist__sort${active ? ' connlist__sort--on' : ''}`}
        onClick={() => actions.setSort(key)}
        title={`按${label}排序`}
      >
        {label}
        {active ? (
          <Icon name={sortDir === 'asc' ? 'chevron-down' : 'chevron-right'} size={12} />
        ) : null}
      </button>
    )
  }

  return (
    <div className={`connlist__head connlist__grid${showInfo ? '' : ' connlist__grid--nodetail'}`}>
      <Checkbox
        bare
        checked={allSelected}
        indeterminate={someSelected && !allSelected}
        ariaLabel="全选"
        onChange={onSelectAll}
      />
      <span aria-hidden />
      {sortButton('status', '状态')}
      {sortButton('name', '名称')}
      {sortButton('address', '地址')}
      {showInfo ? <span>详情</span> : null}
      <span style={{ textAlign: 'right' }}>操作</span>
    </div>
  )
}

interface RowProps {
  conn: UiConnection
  selected: boolean
  showInfo: boolean
  ping: PingEntry | undefined
  sessionState: string | undefined
}

/**
 * 单行。用 memo 包住：列表滚动时只有进入视口的行会重建，
 * 已渲染行的 props 不变则完全跳过渲染。
 */
const Row = memo(function Row({ conn, selected, showInfo, ping, sessionState }: RowProps): React.JSX.Element {
  const favorite = isFavorite(conn)
  const user = connectionUsername(conn)
  // ssh 与 telnet 都能打开终端工作区（RDP/VNC/隧道尚未接入）
  const canConnect = conn.kind === 'ssh' || conn.kind === 'telnet'

  return (
    <div
      className={`connlist__row connlist__grid${showInfo ? '' : ' connlist__grid--nodetail'}${
        selected ? ' connlist__row--selected' : ''
      }`}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(CONNECTION_DND_TYPE, conn.id)
        e.dataTransfer.effectAllowed = 'move'
      }}
      onDoubleClick={(e) => {
        if (!canConnect) return
        // 双击落在按钮/复选框/开关上时不再触发：它们自己的 onClick 已经处理过了。
        // 否则「快速双击连接按钮」会同时走按钮 onClick 与行 onDoubleClick，
        // 一个手势发起两次 ssh.connect（实测现象：两条 handshake 超时）。
        if (e.target instanceof HTMLElement && e.target.closest('button, input, a, select')) return
        void connectTo(conn)
      }}
    >
      <Checkbox bare checked={selected} ariaLabel={`选择 ${conn.name}`} onChange={() => actions.toggleSelect(conn.id)} />

      <IconButton
        icon={favorite ? 'star-filled' : 'star'}
        label={favorite ? '取消收藏' : '加入收藏'}
        size={14}
        tone={favorite ? 'on' : 'default'}
        onClick={() => toggleFavorite(conn.id)}
      />

      <div className="connlist__status">
        {sessionState ? (
          <>
            <StatusDot
              tone={sessionState === 'ready' ? 'ok' : sessionState === 'failed' ? 'danger' : 'accent'}
              pulse={sessionState === 'connecting' || sessionState === 'authenticating'}
              label={STATE_TEXT[sessionState] ?? sessionState}
            />
            <span>{STATE_TEXT[sessionState] ?? sessionState}</span>
          </>
        ) : (
          <>
            <StatusDot
              tone={ping ? (ping.reachable ? 'ok' : 'danger') : 'muted'}
              label={ping ? pingLabel(ping) : '未探测'}
            />
            <span
              title={
                ping
                  ? `${ping.method.toUpperCase()}${ping.reason ? ` · ${ping.reason}` : ''}`
                  : '空闲。点工具条「探测延迟」测量'
              }
            >
              {pingLabel(ping)}
            </span>
          </>
        )}
      </div>

      <div className="connlist__name">
        <Icon name={KIND_ICON[conn.kind]} size={15} />
        <div style={{ minWidth: 0 }}>
          <div className="connlist__name-text" title={conn.name}>
            {conn.name}
          </div>
          {conn.note ? (
            <div className="connlist__note" title={conn.note}>
              {conn.note}
            </div>
          ) : null}
        </div>
      </div>

      <div className="connlist__addr" title={connectionAddress(conn)}>
        {connectionAddress(conn)}
      </div>

      {showInfo ? (
        <div className="connlist__meta">
          <Badge tone="outline">{KIND_LABEL[conn.kind]}</Badge>
          {user ? <Badge>{user}</Badge> : null}
          {conn.lastUsedAt ? (
            <Badge tone="accent">最近 {formatRelativeTime(conn.lastUsedAt)}</Badge>
          ) : null}
        </div>
      ) : null}

      <div className={`connlist__actions${selected ? ' connlist__actions--pinned' : ''}`}>
        <Button
          size="sm"
          variant="primary"
          disabled={!canConnect}
          title={canConnect ? '打开终端' : `${KIND_LABEL[conn.kind]} 工作区尚未接入`}
          onClick={() => void connectTo(conn)}
        >
          连接
        </Button>
        <IconButton icon="edit" label="编辑" onClick={() => actions.openEdit(conn.id)} />
        <IconButton
          icon="more"
          label="更多操作"
          onClick={() => {
            actions.setSelection([conn.id])
          }}
        />
      </div>
    </div>
  )
})

export interface ConnectionListProps {
  items: UiConnection[]
  /** 是否显示「详情」列 */
  showInfo: boolean
}

export function ConnectionList({ items, showInfo }: ConnectionListProps): React.JSX.Element {
  const { selected, tabs, pings } = useStoreShallow((s) => ({
    selected: s.selected,
    tabs: s.tabs,
    pings: s.pings,
  }))
  const selectedSet = new Set(selected)
  const allSelected = items.length > 0 && items.every((c) => selectedSet.has(c.id))
  const someSelected = selected.length > 0

  const sort = useStoreShallow((s) => ({ sortKey: s.sortKey, sortDir: s.sortDir }))

  const sessionStateOf = (connectionId: string): string | undefined => {
    const tab = tabs.find((t) => t.connectionId === connectionId && t.state !== 'idle')
    return tab?.state
  }

  return (
    <div className="connlist">
      <ListHeader
        sortKey={sort.sortKey}
        sortDir={sort.sortDir}
        allSelected={allSelected}
        someSelected={someSelected}
        showInfo={showInfo}
        onSelectAll={(checked) => {
          if (checked) actions.setSelection(items.map((c) => c.id))
          else actions.clearSelection()
        }}
      />

      {someSelected ? (
        <div className="connlist__bulk">
          <span className="connlist__bulk-count">已选 {selected.length} 项</span>
          <div className="connlist__bulk-spacer" />
          <Button size="sm" icon="cloud" onClick={() => void duplicateConnections(selected)}>
            复制
          </Button>
          <Button size="sm" icon="download" onClick={() => actions.setView('settings')}>
            导出
          </Button>
          <Button
            size="sm"
            icon="zap"
            onClick={() => {
              // 多选并发：逐个打开后自动归为一个广播组（默认独立模式，
              // 切到广播必须是一次显式操作）
              const targets = items.filter(
                (c) => selectedSet.has(c.id) && (c.kind === 'ssh' || c.kind === 'telnet'),
              )
              if (targets.length === 0) {
                toast.warn('所选里没有可打开终端的 SSH / Telnet 连接')
                return
              }
              actions.clearSelection()
              void connectManyAsGroup(targets)
            }}
          >
            并发连接
          </Button>
          <Button size="sm" variant="danger" icon="trash" onClick={() => void deleteConnections(selected)}>
            删除
          </Button>
          <IconButton icon="close" label="取消选择" onClick={() => actions.clearSelection()} />
        </div>
      ) : null}

      <div className="connlist__body">
        <VirtualList
          items={items}
          rowHeight={46}
          className="connlist__list"
          role="grid"
          getKey={(c) => c.id}
          renderRow={(conn) => (
            <Row
              conn={conn}
              selected={selectedSet.has(conn.id)}
              showInfo={showInfo}
              ping={pings[conn.id]}
              sessionState={sessionStateOf(conn.id)}
            />
          )}
        />
      </div>

    </div>
  )
}
