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

import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react'
import { Badge, EmptyState, Loading } from '../../components/Feedback'
import { Button, IconButton } from '../../components/Button'
import { Icon } from '../../components/Icon'
import { Splitter } from '../../components/Splitter'
import { usePaneWidth } from '../../lib/usePaneWidth'
import type { RdpConnection, TunnelConnection, VncConnection } from '@t1000/shared'
// 快速命令面板：只有终端类会话才有意义（它要往会话里发东西）
const QuickCommandPanel = lazy(() => import('../quickcmd/QuickCommandPanel'))
import {
  actions,
  broadcastGroupOf,
  closeTab,
  getConnection,
  dissolveBroadcastGroup,
  loadBroadcastGroups,
  setBroadcastMode,
  openLocalTerminal,
  setActiveTab,
  setTabLayout,
  toggleTabFiles,
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
/** 远端画面/桌面/隧道：各自独立 chunk，没这类标签就不加载 */
const VncViewer = lazy(() => import('../vnc/VncViewer'))
const RdpView = lazy(() => import('../rdp/RdpView'))
const TunnelView = lazy(() => import('../tunnel/TunnelView'))

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

  /**
   * 三个可拖动的栏宽。默认值按「1280 宽窗口下终端仍留 ≈500px」定的，
   * 记住的是用户最后一次拖到的宽度；窗口变窄时由 clamp 兜底。
   */
  const quickW = usePaneWidth({ key: 't1000:ws:quickcmd', initial: 286, min: 180, max: 480 })
  const filesW = usePaneWidth({ key: 't1000:ws:files', initial: 420, min: 260, max: 760 })
  const monitorW = usePaneWidth({ key: 't1000:ws:monitor', initial: 320, min: 220, max: 640 })

  /**
   * 工作区可用宽度。
   *
   * 记住的栏宽在窗口变窄后可能把终端挤成一条缝（实测 1080px 窗口 + 文件栏 560 +
   * 监控 320 → 终端只剩约 90px，xterm 直接竖排断字）。所以按可用宽度**等比缩放**
   * 两侧栏，始终给终端留 PANES_MIN：空间够时缩放系数为 1，宽度与用户拖的完全一致。
   */
  const wsRef = useRef<HTMLDivElement>(null)
  const [wsWidth, setWsWidth] = useState(0)
  const PANES_MIN = 320
  useEffect(() => {
    const el = wsRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0
      setWsWidth(Math.round(w))
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const active = tabs.find((t) => t.tabId === activeTabId) ?? null
  /** 当前标签所属的广播组（没有则不在任何组里） */
  /** 只有这几种才用"终端 + 文件"那套界面；vnc/rdp/tunnel 是各自独立的视图 */
  const quickcmdOpen = useStoreShallow((s) => ({ v: s.quickcmdOpen })).v
  const toolbarVisible = useStoreShallow((s) => ({ v: s.toolbarVisible })).v
  const isTerminalLike =
    active?.kind === 'ssh' || active?.kind === 'local' || active?.kind === 'telnet' || active === undefined
  /** 有文件系统的会话才有文件栏：telnet 只是字符流，vnc/rdp/tunnel 是各自视图 */
  const hasFiles = active?.kind === 'ssh' || active?.kind === 'local' || active === undefined
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

  const showQuick = isTerminalLike && quickcmdOpen
  const showFiles = isTerminalLike && hasFiles && mono.filesOpen && Boolean(mono.sessionId)
  const showMonitor = isTerminalLike && mono.monitorOpen

  /**
   * 面板宽度分配。
   *
   * - 窗口够宽（主流 1440+）：缩放系数为 1，用的就是用户拖出来的宽度；
   * - 窗口变窄：三栏按比例一起收，但每栏有硬下限，终端永远保住 PANES_MIN；
   * - 拖动上限 `*MaxDrag` 由「预算 - 其它栏」算出，因此拖到头就是真到头，
   *   不会出现"往右拖反而变窄"（那样看起来像 bug）。
   */
  const budget = wsWidth > 0 ? Math.max(0, wsWidth - PANES_MIN) : Number.POSITIVE_INFINITY
  const want = (showQuick ? quickW.width : 0) + (showFiles ? filesW.width : 0) + (showMonitor ? monitorW.width : 0)
  const k = budget !== Number.POSITIVE_INFINITY && want > budget && want > 0 ? budget / want : 1
  const effQuick = showQuick ? Math.max(150, Math.round(quickW.width * k)) : 0
  const effFiles = showFiles ? Math.max(200, Math.round(filesW.width * k)) : 0
  const effMonitor = showMonitor ? Math.max(180, Math.round(monitorW.width * k)) : 0
  const dragBudget = budget === Number.POSITIVE_INFINITY ? 0 : budget
  const quickMax = budget === Number.POSITIVE_INFINITY
    ? quickW.max
    : Math.max(quickW.min, dragBudget - effFiles - effMonitor)
  const filesMax = budget === Number.POSITIVE_INFINITY
    ? filesW.max
    : Math.max(filesW.min, dragBudget - effQuick - effMonitor)
  const monitorMax = budget === Number.POSITIVE_INFINITY
    ? monitorW.max
    : Math.max(monitorW.min, dragBudget - effQuick - effFiles)

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

      <div className={`term-toolbar${toolbarVisible ? '' : ' term-toolbar--hidden'}`}>
        <span className="term-toolbar__title">{mono.title}</span>
        <Badge tone={STATE_TONE[mono.state] ?? 'default'}>
          {STATE_LABEL[mono.state] ?? mono.state}
        </Badge>
        {mono.subtitle ? <span className="term-toolbar__meta">{mono.subtitle}</span> : null}
        <div style={{ flex: 1 }} />

        {isTerminalLike ? (
        <>
        <div className="t-toolbar__divider" />
        {/* 文件栏（左）：ssh/local 有文件系统；telnet 没有不给开关 */}
        {hasFiles ? (
          <IconButton
            icon="folder"
            label={mono.filesOpen ? '收起文件栏' : '展开文件栏'}
            tone={mono.filesOpen ? 'accent' : 'default'}
            onClick={() => toggleTabFiles(mono.tabId)}
          />
        ) : null}
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
        </>
        ) : null}
        <div className="t-toolbar__divider" />
        {isTerminalLike ? (
        <IconButton
          icon="zap"
          label={quickcmdOpen ? '关闭快速命令' : '打开快速命令（终端左栏）'}
          tone={quickcmdOpen ? 'accent' : 'default'}
          onClick={() => actions.toggleQuickcmd()}
        />
        ) : null}
        {isTerminalLike ? (
        <IconButton
          icon="activity"
          label={mono.monitorOpen ? '关闭监控' : '打开监控'}
          tone={mono.monitorOpen ? 'accent' : 'default'}
          onClick={() => toggleTabMonitor(mono.tabId)}
        />
        ) : null}
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

      <div className="term-workspace" ref={wsRef}>
        {/* 快速命令：终端自己的左栏（spec §6 的位置） */}
        {showQuick ? (
          <>
            <aside className="term-quickcmd" style={{ width: effQuick }} aria-label="快速命令">
              <Suspense fallback={<Loading text="载入快速命令…" />}>
                <QuickCommandPanel />
              </Suspense>
            </aside>
            <Splitter
              side="left"
              size={effQuick}
              min={quickW.min}
              max={quickMax}
              onResize={quickW.setWidth}
              onReset={quickW.reset}
              label="拖动调整快速命令栏宽度"
            />
          </>
        ) : null}
        {/* 文件栏（左）：与会话并存而非互换 —— ssh 用真 sftp，local 用本地后端（见 sftp 域） */}
        {showFiles ? (
          <>
            <aside className="term-files" style={{ width: effFiles }} aria-label="文件浏览">
              <Suspense fallback={<Loading text="正在载入文件浏览器…" />}>
                <SftpBrowser sessionId={mono.sessionId} title={mono.title} />
              </Suspense>
            </aside>
            <Splitter
              side="left"
              size={effFiles}
              min={filesW.min}
              max={filesMax}
              onResize={filesW.setWidth}
              onReset={filesW.reset}
              label="拖动调整文件栏宽度"
            />
          </>
        ) : null}
        <div className={`term-panes term-panes--${isTerminalLike ? layout : 'single'}`}>
          {tabs.map((tab) => {
            const visible = visibleIds.includes(tab.tabId)
            const conn = getConnection(tab.connectionId)
            return (
              <div
                key={tab.tabId}
                className={`term-slot${visible ? '' : ' term-slot--hidden'}`}
                aria-hidden={!visible}
              >
                <Suspense fallback={<Loading text="载入视图…" />}>
                  {tab.kind === 'vnc' ? (
                    <VncViewer
                      sessionId={tab.sessionId}
                      title={tab.title}
                      viewOnly={(conn as VncConnection | undefined)?.viewOnly === true}
                      scaleViewport={(conn as VncConnection | undefined)?.scaleViewport === true}
                      clipViewport={(conn as VncConnection | undefined)?.clipViewport === true}
                    />
                  ) : tab.kind === 'rdp' ? (
                    <RdpView
                      sessionId={tab.sessionId}
                      title={tab.title}
                      host={(conn as RdpConnection | undefined)?.host ?? ''}
                      width={(conn as RdpConnection | undefined)?.width ?? 1280}
                      height={(conn as RdpConnection | undefined)?.height ?? 800}
                      {...(tab.message === undefined ? {} : { errorMessage: tab.message })}
                    />
                  ) : tab.kind === 'tunnel' && conn ? (
                    <TunnelView
                      sessionId={tab.sessionId}
                      connection={conn as TunnelConnection}
                      state={tab.state}
                      {...(tab.message === undefined ? {} : { message: tab.message })}
                    />
                  ) : (
                    /* 从未可见过的标签不创建 xterm，切过去时才初始化 */
                    <TerminalPane tab={tab} visible={visible} />
                  )}
                </Suspense>
              </div>
            )
          })}
        </div>

        {showMonitor ? (
          <>
            <Splitter
              side="right"
              size={effMonitor}
              min={monitorW.min}
              max={monitorMax}
              onResize={monitorW.setWidth}
              onReset={monitorW.reset}
              label="拖动调整监控栏宽度"
            />
            {/* 外框只负责定宽：MonitorPanel 自己的根节点是 flex:0 0 320px，这里让它填满外框 */}
            <div className="term-monitor" style={{ width: effMonitor }}>
              <Suspense fallback={<div className="monitor"><Loading text="正在载入监控面板…" /></div>}>
                <MonitorPanel
                  sessionId={mono.sessionId}
                  title={mono.title}
                  onClose={() => toggleTabMonitor(mono.tabId)}
                />
              </Suspense>
            </div>
          </>
        ) : null}
      </div>
    </main>
  )
}

function activeId(tabs: Array<{ tabId: string }>, activeTabId: string | null): string | null {
  return tabs.some((t) => t.tabId === activeTabId) ? activeTabId : (tabs[0]?.tabId ?? null)
}
