// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

import { Button, IconButton, StatusDot } from '../../components/Button'
import { Icon } from '../../components/Icon'
import { EmptyState } from '../../components/Feedback'
import {
  actions,
  closeTab,
  openLocalTerminal,
  setActiveTab,
  useStoreShallow,
  type TerminalTab,
} from '../../lib/store'
import './terminal.css'

const STATE_TONE: Record<string, 'muted' | 'ok' | 'warn' | 'danger' | 'accent'> = {
  idle: 'muted',
  connecting: 'accent',
  authenticating: 'accent',
  'verifying-host-key': 'warn',
  ready: 'ok',
  disconnected: 'muted',
  failed: 'danger',
}

const STATE_LABEL: Record<string, string> = {
  idle: '空闲',
  connecting: '连接中',
  authenticating: '认证中',
  'verifying-host-key': '校验指纹',
  ready: '已连接',
  disconnected: '已断开',
  failed: '失败',
}

function Item({ tab, active }: { tab: TerminalTab; active: boolean }): React.JSX.Element {
  return (
    <div
      className={`session-item${active ? ' session-item--active' : ''}`}
      role="button"
      tabIndex={0}
      aria-current={active || undefined}
      onClick={() => setActiveTab(tab.tabId)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          setActiveTab(tab.tabId)
        }
      }}
    >
      <StatusDot
        tone={STATE_TONE[tab.state] ?? 'muted'}
        pulse={tab.state === 'connecting' || tab.state === 'authenticating'}
        label={STATE_LABEL[tab.state] ?? tab.state}
      />
      <div className="session-item__body">
        <div className="session-item__title" title={tab.title}>
          {tab.title}
        </div>
        <div className="session-item__meta">
          {tab.kind === 'local' ? '本地' : (tab.subtitle ?? 'SSH')} · {STATE_LABEL[tab.state] ?? tab.state}
        </div>
      </div>
      <IconButton
        icon="close"
        label={`关闭 ${tab.title}`}
        size={12}
        onClick={(e) => {
          e.stopPropagation()
          closeTab(tab.tabId)
        }}
      />
    </div>
  )
}

export function SessionSidebar(): React.JSX.Element {
  const { tabs, activeTabId } = useStoreShallow((s) => ({
    tabs: s.tabs,
    activeTabId: s.activeTabId,
  }))

  const active = tabs.filter((t) => t.state === 'ready').length

  return (
    <aside className="panel" aria-label="会话列表">
      <header className="panel-header">
        <span className="panel-title">会话</span>
        <span className="t-badge">{active}/{tabs.length}</span>
      </header>

      <div className="panel-body">
        {tabs.length === 0 ? (
          <EmptyState
            icon="terminal"
            title="没有打开的会话"
            text="从连接中心双击一台服务器，或直接开一个本地终端。"
            actions={
              <Button size="sm" variant="primary" onClick={() => actions.setView('connections')}>
                去连接中心
              </Button>
            }
          />
        ) : (
          <div className="sessions" role="list">
            {tabs.map((tab) => (
              <Item key={tab.tabId} tab={tab} active={tab.tabId === activeTabId} />
            ))}
          </div>
        )}
      </div>

      <div className="panel-footer">
        <Button
          size="sm"
          variant="outline"
          icon="plus"
          style={{ flex: 1 }}
          onClick={() => void openLocalTerminal()}
        >
          本地终端
        </Button>
        <IconButton
          icon="trash"
          label="关闭全部会话"
          disabled={tabs.length === 0}
          onClick={() => {
            for (const t of tabs) closeTab(t.tabId)
          }}
        />
      </div>
    </aside>
  )
}
