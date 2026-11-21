// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 会话栏（控制台左侧）。
 *
 * 两种形态：
 * - 展开：标题 + 状态点 + 会话名 + 元信息 + 关闭按钮（默认）；
 * - 折叠：44px 一条，只留协议图标与状态点，鼠标悬停弹出属性卡片。
 *
 * ## 折叠态的悬停卡片为什么用 fixed 定位
 * 折叠后侧栏只有 44px 宽，而 `.panel` 是 `overflow: hidden`（列表要能滚动）。
 * 卡片若作为子元素绝对定位，会被这层裁切直接吃掉 —— 只能脱离布局流。
 * 用 `position: fixed` 并按悬停行的 `getBoundingClientRect()` 定位，
 * 既不裁切，也不需要在 DOM 里造 portal。卡片出现的行一变就重算。
 */

import { useState } from 'react'
import { Button, IconButton, StatusDot } from '../../components/Button'
import { Icon } from '../../components/Icon'
import { EmptyState } from '../../components/Feedback'
import {
  actions,
  closeTab,
  openLocalTerminal,
  setActiveTab,
  useStoreShallow,
  type PaneLayout,
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

const KIND_LABEL: Record<string, string> = {
  ssh: 'SSH',
  local: '本地终端',
  telnet: 'Telnet',
  vnc: 'VNC',
  rdp: 'RDP',
  tunnel: '隧道',
}

const LAYOUT_LABEL: Record<PaneLayout, string> = {
  single: '单窗格',
  hsplit: '左右分屏',
  vsplit: '上下分屏',
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

/** 折叠态的单行：只有图标 + 角标状态点，悬停出属性卡片 */
function MiniItem({
  tab,
  active,
  onHover,
}: {
  tab: TerminalTab
  active: boolean
  onHover: (tab: TerminalTab | null, anchor: HTMLElement | null) => void
}): React.JSX.Element {
  const tone = STATE_TONE[tab.state] ?? 'muted'
  return (
    <button
      type="button"
      className={`sess-mini${active ? ' sess-mini--active' : ''}`}
      aria-label={`${tab.title}：${STATE_LABEL[tab.state] ?? tab.state}`}
      aria-current={active || undefined}
      onClick={() => setActiveTab(tab.tabId)}
      onMouseEnter={(e) => onHover(tab, e.currentTarget)}
      onMouseLeave={() => onHover(null, null)}
      onFocus={(e) => onHover(tab, e.currentTarget)}
      onBlur={() => onHover(null, null)}
    >
      <Icon name={tab.kind === 'local' ? 'console' : 'terminal'} size={16} />
      <span className={`sess-mini__dot sess-mini__dot--${tone}`} aria-hidden />
    </button>
  )
}

export function SessionSidebar(): React.JSX.Element {
  const { tabs, activeTabId, collapsed } = useStoreShallow((s) => ({
    tabs: s.tabs,
    activeTabId: s.activeTabId,
    collapsed: s.panelCollapsed,
  }))

  /** 悬停卡片的位置：行变了就重算，避免卡片停在上一行旁边 */
  const [tip, setTip] = useState<{ tab: TerminalTab; top: number; left: number } | null>(null)

  const hover = (tab: TerminalTab | null, anchor: HTMLElement | null): void => {
    if (!tab || !anchor) {
      setTip(null)
      return
    }
    const r = anchor.getBoundingClientRect()
    // 卡片高约 150px：贴底时上移，避免超出窗口下沿
    const top = Math.min(r.top, Math.max(8, window.innerHeight - 170))
    setTip({ tab, top, left: r.right + 10 })
  }

  const active = tabs.filter((t) => t.state === 'ready').length

  if (collapsed) {
    return (
      <aside className="panel panel--mini" aria-label="会话列表（已折叠）">
        <div className="panel-mini__head">
          <IconButton
            icon="panel-left"
            label="展开会话栏"
            size={14}
            onClick={() => actions.togglePanelCollapsed()}
          />
        </div>
        {tabs.length === 0 ? (
          <div className="panel-mini__empty" title="没有打开的会话">—</div>
        ) : (
          <div className="sessions-mini" role="list">
            {tabs.map((tab) => (
              <MiniItem
                key={tab.tabId}
                tab={tab}
                active={tab.tabId === activeTabId}
                onHover={hover}
              />
            ))}
          </div>
        )}
        <div className="panel-mini__foot">
          <IconButton icon="plus" label="新建本地终端" size={14} onClick={() => void openLocalTerminal()} />
        </div>

        {tip ? (
          <div className="sess-tip" role="tooltip" style={{ top: tip.top, left: tip.left }}>
            <div className="sess-tip__head">
              <span className="sess-tip__title">{tip.tab.title}</span>
              <span className={`sess-tip__state sess-tip__state--${STATE_TONE[tip.tab.state] ?? 'muted'}`}>
                {STATE_LABEL[tip.tab.state] ?? tip.tab.state}
              </span>
            </div>
            <dl className="sess-tip__props">
              <div>
                <dt>类型</dt>
                <dd>{KIND_LABEL[tip.tab.kind] ?? tip.tab.kind}</dd>
              </div>
              <div>
                <dt>地址</dt>
                <dd className="mono">{tip.tab.subtitle ?? '—'}</dd>
              </div>
              <div>
                <dt>会话 ID</dt>
                <dd className="mono">{tip.tab.sessionId ? tip.tab.sessionId.slice(0, 12) : '尚未建立'}</dd>
              </div>
              <div>
                <dt>窗格</dt>
                <dd>{LAYOUT_LABEL[tip.tab.layout]}</dd>
              </div>
              <div>
                <dt>文件栏</dt>
                <dd>{tip.tab.filesOpen ? '展开' : '收起'}</dd>
              </div>
              <div>
                <dt>监控</dt>
                <dd>{tip.tab.monitorOpen ? '展开' : '收起'}</dd>
              </div>
            </dl>
          </div>
        ) : null}
      </aside>
    )
  }

  return (
    <aside className="panel" aria-label="会话列表">
      <header className="panel-header">
        <span className="panel-title">会话</span>
        <span className="t-badge">{active}/{tabs.length}</span>
        <div className="t-toolbar__spacer" />
        {/* 全局搜索的可见入口：Ctrl+K 是加速键，但不该只有键盘才知道 */}
        <IconButton
          icon="search"
          label="全局搜索（Ctrl+K）"
          size={13}
          onClick={() => actions.toggleGlobalSearch()}
        />
        <IconButton
          icon="panel-left"
          label="折叠会话栏（只留图标，悬停看属性）"
          size={14}
          onClick={() => actions.togglePanelCollapsed()}
        />
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
