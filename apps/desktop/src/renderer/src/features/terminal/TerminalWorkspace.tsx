// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 终端工作区：标签 + 分屏 + 右侧监控。
 *
 * ## 为什么所有标签的窗格都挂在 DOM 里
 * 每个标签对应一个 xterm 实例。如果只渲染当前标签，切回来时 xterm 会被销毁重建，
 * 滚动回看内容、光标位置、远端 shell 的状态视觉全部丢失。
 * 所以这里**全部渲染、用 CSS 隐藏非活动窗格**，代价是每会话一份 xterm 内存
 * （架构目标里单 SSH 会话增量是 25MB，xterm 实例远小于这个量级）。
 *
 * 隐藏期间容器尺寸为 0，`TerminalPane` 内部对此做了保护（不做 fit），
 * 重新可见时会强制重新 fit。
 */

import { Suspense, lazy, useEffect, useMemo, useState } from 'react'
import { Badge, EmptyState, Loading } from '../../components/Feedback'
import { Button, IconButton } from '../../components/Button'
import { Icon } from '../../components/Icon'
import {
  actions,
  broadcastGroupOf,
  closeTab,
  dissolveBroadcastGroup,
  loadBroadcastGroups,
  setBroadcastMode,
  openLocalTerminal,
  setActiveTab,
  setTabLayout,
  setTabMode,
  toggleTabMonitor,
  useStoreShallow,
  type PaneLayout,
} from '../../lib/store'
import { TerminalPane } from './TerminalPane'
import './terminal.css'

/** 监控面板按需加载：没打开监控就不下载这一块代码 */
const MonitorPanel = lazy(() => import('../monitor/MonitorPanel'))
/** SFTP 浏览器同理：只有切到「文件」才加载 */
const SftpBrowser = lazy(() => import('../sftp/SftpBrowser'))

const LAYOUTS: ReadonlyArray<{ value: PaneLayout; icon: 'panel-right' | 'split-h' | 'split-v'; label: string }> = [
  { value: 'single', icon: 'panel-right', label: '单窗格' },
  { value: 'hsplit', icon: 'split-h', label: '左右分屏' },
  { value: 'vsplit', icon: 'split-v', label: '上下分屏' },
]

const STATE_TONE: Record<string, 'default' | 'accent' | 'ok' | 'warn' | 'danger'> = {
  idle: 'default',
  connecting: 'accent',
  authenticating: 'accent',
  'verifying-host-key': 'warn',
  ready: 'ok',
  disconnected: 'default',
  failed: 'danger',
}

const STATE_LABEL: Record<string, string> = {
  idle: '空闲',
  connecting: '连接中',
  authenticating: '认证中',
  'verifying-host-key': '校验主机指纹',
  ready: '已连接',
  disconnected: '已断开',
  failed: '失败',
}

export default function TerminalWorkspace(): React.JSX.Element {
  const { tabs, activeTabId, recordings, groups, lastSend, bcErrors } = useStoreShallow((s) => ({
    tabs: s.tabs,
    activeTabId: s.activeTabId,
    recordings: s.activeRecordings,
    groups: s.broadcastGroups,
    lastSend: s.broadcastLastSend,
    bcErrors: s.broadcastErrors,
  }))

  useEffect(() => {
    void loadBroadcastGroups()
  }, [])
  const [secondaryTabId, setSecondaryTabId] = useState<string | null>(null)

  const active = tabs.find((t) => t.tabId === activeTabId) ?? null
  /** 当前标签所属的广播组（没有则不在任何组里） */
  const activeGroup = broadcastGroupOf(active?.sessionId)
  const groupOf = (sessionId: string | undefined): typeof activeGroup =>
    sessionId ? groups.find((g) => g.members.some((m) => m.sessionId === sessionId)) : undefined
  const sendInfo = activeGroup ? lastSend[activeGroup.groupId] : undefined
  const groupErrors = activeGroup
    ? bcErrors.filter((e) => e.groupId === activeGroup.groupId).slice(0, 3)
    : []
  const layout: PaneLayout = active?.layout ?? 'single'

  // 分屏的第二窗格被关掉后要清空，否则网格里会留一个空槽
  useEffect(() => {
    if (secondaryTabId && !tabs.some((t) => t.tabId === secondaryTabId)) setSecondaryTabId(null)
  }, [tabs, secondaryTabId])

  const visibleIds = useMemo(() => {
    if (!active) return [] as string[]
    if (layout === 'single' || !secondaryTabId) return [active.tabId]
    return [active.tabId, secondaryTabId]
  }, [active, layout, secondaryTabId])

  if (!active) {
    return (
      <main className="content" aria-label="终端工作区">
        <div className="conn-empty">
          <EmptyState
            icon="terminal"
            title="工作区是空的"
            text="在连接中心双击一台服务器打开 SSH 会话，或者开一个本地终端。所有会话都会以标签形式留在这里。"
            actions={
              <>
                <Button variant="primary" icon="connections" onClick={() => actions.setView('connections')}>
                  打开连接中心
                </Button>
                <Button variant="outline" icon="terminal" onClick={() => void openLocalTerminal()}>
                  本地终端
                </Button>
              </>
            }
          />
        </div>
      </main>
    )
  }

  const mono = active

  return (
    <main className="content" aria-label="终端工作区">
      <div className="term-tabs" role="tablist" aria-label="终端标签">
        {tabs.map((tab) => (
          <div
            key={tab.tabId}
            role="tab"
            tabIndex={tab.tabId === activeId(tabs, activeTabId) ? 0 : -1}
            aria-selected={tab.tabId === activeTabId}
            className={`term-tab${tab.tabId === activeTabId ? ' term-tab--active' : ''}`}
            title={tab.subtitle ? `${tab.title} · ${tab.subtitle}` : tab.title}
            onClick={() => setActiveTab(tab.tabId)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                setActiveTab(tab.tabId)
              }
            }}
          >
            <Icon name={tab.kind === 'local' ? 'console' : 'terminal'} size={13} />
            {recordings.some((r) => r.sessionId === tab.sessionId) ? (
              <span className="rec-dot" title="正在记录会话日志" />
            ) : null}
            {(() => {
              const g = groupOf(tab.sessionId)
              if (!g) return null
              return (
                <span
                  className={`bc-chip${g.mode === 'broadcast' ? ' bc-chip--live' : ''}`}
                  title={`属于广播组「${g.name}」（${g.mode === 'broadcast' ? '广播模式' : '独立模式'}，${g.members.length} 台）`}
                >
                  {g.mode === 'broadcast' ? '广播' : '组'}
                </span>
              )
            })()}
            <span className="term-tab__label">{tab.title}</span>
            <button
              type="button"
              className="term-tab__close"
              aria-label={`关闭 ${tab.title}`}
              onClick={(e) => {
                e.stopPropagation()
                closeTab(tab.tabId)
              }}
            >
              <Icon name="close" size={11} />
            </button>
          </div>
        ))}
        <IconButton icon="plus" label="新建本地终端" onClick={() => void openLocalTerminal()} />
        <div className="term-tabs__spacer" />
      </div>

      <div className="term-toolbar">
        <span className="term-toolbar__title">{mono.title}</span>
        <Badge tone={STATE_TONE[mono.state] ?? 'default'}>
          {STATE_LABEL[mono.state] ?? mono.state}
        </Badge>
        {mono.subtitle ? <span className="term-toolbar__meta">{mono.subtitle}</span> : null}
        <div style={{ flex: 1 }} />

        <div className="t-toolbar__divider" />
        {/* 终端 / 远端文件：同一会话的两种视图，SFTP 依附于该会话 */}
        <div className="t-segmented" role="tablist" aria-label="工作区视图">
          {(
            [
              ['terminal', '终端'],
              ['sftp', '文件'],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={(mono.mode ?? 'terminal') === value}
              disabled={value === 'sftp' && !mono.sessionId}
              title={value === 'sftp' && !mono.sessionId ? '会话建立后才能浏览远端文件' : undefined}
              className={`t-segmented__item${(mono.mode ?? 'terminal') === value ? ' t-segmented__item--active' : ''}`}
              onClick={() => setTabMode(mono.tabId, value)}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="t-toolbar__divider" />
        {LAYOUTS.map((l) => (
          <IconButton
            key={l.value}
            icon={l.icon}
            label={l.label}
            tone={layout === l.value ? 'accent' : 'default'}
            onClick={() => {
              setTabLayout(mono.tabId, l.value)
              if (l.value !== 'single' && !secondaryTabId) {
                const other = tabs.find((t) => t.tabId !== mono.tabId)
                setSecondaryTabId(other?.tabId ?? null)
              }
            }}
          />
        ))}
        {layout !== 'single' ? (
          <select
            className="t-select"
            style={{ width: 150, height: 26 }}
            aria-label="第二窗格的会话"
            value={secondaryTabId ?? ''}
            onChange={(e) => setSecondaryTabId(e.target.value || null)}
          >
            <option value="">选择会话…</option>
            {tabs
              .filter((t) => t.tabId !== mono.tabId)
              .map((t) => (
                <option key={t.tabId} value={t.tabId}>
                  {t.title}
                </option>
              ))}
          </select>
        ) : null}
        {activeGroup ? (
          <>
            <div className="t-toolbar__divider" />
            <Badge tone={activeGroup.mode === 'broadcast' ? 'danger' : 'outline'}>
              {activeGroup.name} · {activeGroup.members.length} 台
            </Badge>
            <div className="t-segmented" role="tablist" aria-label="会话模式">
              {(
                [
                  ['independent', '独立'],
                  ['broadcast', '广播'],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  role="tab"
                  aria-selected={activeGroup.mode === value}
                  className={`t-segmented__item${activeGroup.mode === value ? ' t-segmented__item--active' : ''}`}
                  onClick={() => void setBroadcastMode(activeGroup.groupId, value)}
                >
                  {label}
                </button>
              ))}
            </div>
            <IconButton
              icon="close"
              label="解散广播组"
              onClick={() => void dissolveBroadcastGroup(activeGroup.groupId)}
            />
          </>
        ) : null}
        <div className="t-toolbar__divider" />
        <IconButton
          icon="activity"
          label={mono.monitorOpen ? '关闭监控' : '打开监控'}
          tone={mono.monitorOpen ? 'accent' : 'default'}
          onClick={() => toggleTabMonitor(mono.tabId)}
        />
      </div>

      {activeGroup?.mode === 'broadcast' ? (
        <div className="bc-ribbon" role="status">
          <Icon name="alert-triangle" size={15} />
          <div className="bc-ribbon__body">
            <b>广播已开启：一次输入会同时发送到 {activeGroup.members.length} 台服务器。</b>
            <div className="bc-ribbon__sub">
              各机回显快慢不一，<b>屏幕上分不出谁先执行</b>，而远端实际耗时也不同 ——
              涉及有副作用的命令（重启服务、改配置、删文件）时这一点很危险。
            </div>
            {activeGroup.members.some((m) => !m.writable) ? (
              <div className="bc-ribbon__sub">
                其中有 {activeGroup.members.filter((m) => !m.writable).length} 台标记为**只读**：
                不会收到输入，但会计入"跳过"。见下方成员列表。
              </div>
            ) : null}
            {sendInfo ? (
              <div className="bc-ribbon__sub">
                最近一次：已送达 <b>{sendInfo.delivered}</b> 台
                {sendInfo.skipped > 0 ? (
                  <>
                    ，跳过 <b className="bc-ribbon__warn">{sendInfo.skipped}</b> 台
                  </>
                ) : null}
              </div>
            ) : null}
            {groupErrors.map((e) => (
              <div className="bc-ribbon__err" key={`${e.sessionId}-${e.at}`}>
                {e.title}：{e.message}
              </div>
            ))}
          </div>
          <div className="bc-ribbon__members">
            {activeGroup.members.map((m) => (
              <span
                key={m.sessionId}
                className={`bc-member${m.writable ? '' : ' bc-member--ro'}`}
                title={m.writable ? `${m.title}（可写）` : `${m.title}：后端不会写入该会话（只读）`}
              >
                {m.writable ? null : <Icon name="lock" size={10} />}
                {m.title}
              </span>
            ))}
          </div>
        </div>
      ) : null}

      <div className="term-workspace">
        {(mono.mode ?? 'terminal') === 'sftp' ? (
          <Suspense fallback={<Loading text="正在载入文件浏览器…" />}>
            <SftpBrowser sessionId={mono.sessionId} title={mono.title} />
          </Suspense>
        ) : (
        <div className={`term-panes term-panes--${layout}`}>
          {tabs.map((tab) => {
            const visible = visibleIds.includes(tab.tabId)
            return (
              <div
                key={tab.tabId}
                className={`term-slot${visible ? '' : ' term-slot--hidden'}`}
                aria-hidden={!visible}
              >
                {/* 从未可见过的标签不创建 xterm，切过去时才初始化 */}
                <TerminalPane tab={tab} visible={visible} />
              </div>
            )
          })}
        </div>
        )}

        {mono.monitorOpen && (mono.mode ?? 'terminal') === 'terminal' ? (
          <Suspense fallback={<div className="monitor"><Loading text="正在载入监控面板…" /></div>}>
            <MonitorPanel
              sessionId={mono.sessionId}
              title={mono.title}
              onClose={() => toggleTabMonitor(mono.tabId)}
            />
          </Suspense>
        ) : null}
      </div>
    </main>
  )
}

function activeId(tabs: Array<{ tabId: string }>, activeTabId: string | null): string | null {
  return tabs.some((t) => t.tabId === activeTabId) ? activeTabId : (tabs[0]?.tabId ?? null)
}
