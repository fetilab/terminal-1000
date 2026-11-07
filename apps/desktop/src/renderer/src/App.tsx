// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 应用外壳：图标栏 | 列表面板 | 内容区。
 *
 * 三栏的角色在每个视图下是固定的：
 *   rail    = 顶级功能入口（连接中心 / 控制台 / 笔记 / 工具 / 设置）
 *   panel   = 当前视图的导航（连接中心是分组树，控制台是会话列表…）
 *   content = 当前视图的主体
 *
 * 视图内容全部走 React.lazy：首屏只会下载「连接中心」这一个 chunk，
 * xterm / 监控面板 / 连接表单这类重模块在真正用到时才拉取。
 */

import { Suspense, lazy, useEffect } from 'react'
import { Icon, type IconName } from './components/Icon'
import { Loading } from './components/Feedback'
import { ToastHost } from './components/Toast'
import {
  actions,
  loadConnections,
  loadInitialSettings,
  useStoreShallow,
  watchSystemTheme,
  wireEvents,
  type ViewId,
} from './lib/store'
import './styles/global.css'
import './styles/components.css'

const ConnectionsView = lazy(() => import('./features/connections/ConnectionsView'))
const TerminalWorkspace = lazy(() => import('./features/terminal/TerminalWorkspace'))
const NotesView = lazy(() => import('./features/notes/NotesView'))
const ToolsView = lazy(() => import('./features/tools/ToolsView'))
const AiView = lazy(() => import('./features/ai/AiView'))
const ServicesView = lazy(() => import('./features/services/ServicesView'))
const SessionLogView = lazy(() => import('./features/sessionlog/SessionLogView'))
const SettingsView = lazy(() => import('./features/settings/SettingsView'))

const ConnectionsSidebar = lazy(() =>
  import('./features/connections/ConnectionsSidebar').then((m) => ({ default: m.ConnectionsSidebar })),
)
const SessionSidebar = lazy(() =>
  import('./features/terminal/SessionSidebar').then((m) => ({ default: m.SessionSidebar })),
)
const NotesSidebar = lazy(() =>
  import('./features/notes/NotesView').then((m) => ({ default: m.NotesSidebar })),
)
const ToolsSidebar = lazy(() =>
  import('./features/tools/ToolsView').then((m) => ({ default: m.ToolsSidebar })),
)
const SettingsSidebar = lazy(() =>
  import('./features/settings/SettingsView').then((m) => ({ default: m.SettingsSidebar })),
)
const AiSidebar = lazy(() => import('./features/ai/AiView').then((m) => ({ default: m.AiSidebar })))
const ServicesSidebar = lazy(() =>
  import('./features/services/ServicesView').then((m) => ({ default: m.ServicesSidebar })),
)
const SessionLogSidebar = lazy(() =>
  import('./features/sessionlog/SessionLogView').then((m) => ({ default: m.SessionLogSidebar })),
)

interface RailEntry {
  view: ViewId
  icon: IconName
  label: string
}

const RAIL: RailEntry[] = [
  { view: 'connections', icon: 'connections', label: '连接中心' },
  { view: 'console', icon: 'console', label: '控制台' },
  { view: 'notes', icon: 'notes', label: '笔记' },
  { view: 'tools', icon: 'tools', label: '工具' },
  { view: 'ai', icon: 'activity', label: 'AI 助手' },
  { view: 'services', icon: 'cloud', label: '外部服务' },
  { view: 'logs', icon: 'notes', label: '会话日志' },
]

function Rail(): React.JSX.Element {
  const { view, sessionCount } = useStoreShallow((s) => ({ view: s.view, sessionCount: s.tabs.length }))

  const item = (entry: RailEntry, badge?: number): React.JSX.Element => {
    const active = view === entry.view
    return (
      <button
        key={entry.view}
        type="button"
        className={`rail-item${active ? ' rail-item--active' : ''}`}
        title={entry.label}
        aria-label={entry.label}
        aria-current={active ? 'page' : undefined}
        onClick={() => actions.setView(entry.view)}
      >
        <Icon name={entry.icon} size={18} />
        {badge && badge > 0 ? <span className="rail-badge">{badge > 99 ? '99+' : badge}</span> : null}
      </button>
    )
  }

  return (
    <nav className="rail" aria-label="功能入口">
      <div className="rail-brand" title="terminal-1000">
        T1
      </div>
      {RAIL.map((entry) => item(entry, entry.view === 'console' ? sessionCount : undefined))}
      <div className="rail-spacer" />
      <button
        type="button"
        className={`rail-item${view === 'settings' ? ' rail-item--active' : ''}`}
        title="设置"
        aria-label="设置"
        aria-current={view === 'settings' ? 'page' : undefined}
        onClick={() => actions.setView('settings')}
      >
        <Icon name="settings" size={18} />
      </button>
    </nav>
  )
}

function Sidebar(): React.JSX.Element {
  const view = useStoreShallow((s) => ({ view: s.view })).view
  switch (view) {
    case 'connections':
      return <ConnectionsSidebar />
    case 'console':
      return <SessionSidebar />
    case 'notes':
      return <NotesSidebar />
    case 'tools':
      return <ToolsSidebar />
    case 'ai':
      return <AiSidebar />
    case 'services':
      return <ServicesSidebar />
    case 'logs':
      return <SessionLogSidebar />
    case 'settings':
      return <SettingsSidebar />
    default:
      return <aside className="panel" />
  }
}

function View(): React.JSX.Element {
  const view = useStoreShallow((s) => ({ view: s.view })).view
  switch (view) {
    case 'connections':
      return <ConnectionsView />
    case 'console':
      return <TerminalWorkspace />
    case 'notes':
      return <NotesView />
    case 'tools':
      return <ToolsView />
    case 'ai':
      return <AiView />
    case 'services':
      return <ServicesView />
    case 'logs':
      return <SessionLogView />
    case 'settings':
      return <SettingsView />
    default:
      return <main className="content" />
  }
}

export function App(): React.JSX.Element {
  useEffect(() => {
    // 事件接线与应用同生命周期；loadConnections 内部对并发调用做了去重
    wireEvents()
    // 主题要在首屏就位，否则会先闪一下深色再切浅色
    void loadInitialSettings()
    void loadConnections()
    return watchSystemTheme()
  }, [])

  useEffect(() => {
    // 自动化验证钩子只在开发构建里安装。
    // import.meta.env.DEV 在 production 下被替换为 false，配合动态 import，
    // 死代码消除会把整条分支连同 testhook chunk 一起删掉——
    // 生产包里不存在能被控制台调用、往真实库里灌数据的入口。
    if (!import.meta.env.DEV) return
    let cancelled = false
    void import('./lib/testhook').then((m) => {
      if (!cancelled) m.installTestHook()
    })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (!e.ctrlKey) return
      if (e.key === ',') {
        e.preventDefault()
        actions.setView('settings')
        return
      }
      const byNumber: Record<string, ViewId> = {
        '1': 'connections',
        '2': 'console',
        '3': 'notes',
        '4': 'tools',
        '5': 'ai',
        '6': 'services',
        '7': 'logs',
      }
      const target = byNumber[e.key]
      if (target) {
        e.preventDefault()
        actions.setView(target)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  const view = useStoreShallow((s) => ({ view: s.view })).view

  return (
    <div className="app-shell">
      <Rail />
      <Suspense fallback={<aside className="panel"><Loading text="载入面板…" /></aside>}>
        <Sidebar />
      </Suspense>
      <Suspense fallback={<Loading text="载入视图…" />}>
        <div key={view} className="view-enter" style={{ display: 'contents' }}>
          <View />
        </div>
      </Suspense>
      <ToastHost />
    </div>
  )
}
