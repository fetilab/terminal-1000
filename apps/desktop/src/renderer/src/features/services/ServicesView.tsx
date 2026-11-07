// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 外部服务：同步 与 MCP。
 *
 * 放在同一个顶级入口下，是因为它们都是「本机应用与外部系统对接」的运维面，
 * 而不是日常操作（日常在连接中心/控制台）。两者各自独立懒加载。
 */

import { Suspense, lazy } from 'react'
import { Loading } from '../../components/Feedback'
import { Icon, type IconName } from '../../components/Icon'
import { actions, useStoreShallow } from '../../lib/store'
import './services.css'

const SyncPanel = lazy(() => import('./SyncPanel'))
const McpPanel = lazy(() => import('./McpPanel'))

interface SvcEntry {
  id: 'sync' | 'mcp'
  label: string
  icon: IconName
  blurb: string
}

const SERVICES: SvcEntry[] = [
  { id: 'sync', label: '同步与云端', icon: 'cloud', blurb: '零知识加密的多端同步' },
  { id: 'mcp', label: 'MCP 服务', icon: 'server', blurb: '把能力暴露给 MCP 客户端' },
]

export function ServicesSidebar(): React.JSX.Element {
  const section = useStoreShallow((s) => ({ section: s.servicesSection })).section

  return (
    <aside className="panel" aria-label="外部服务">
      <header className="panel-header">
        <span className="panel-title">外部服务</span>
      </header>
      <div className="panel-body">
        <nav className="sessions">
          {SERVICES.map((svc) => (
            <button
              key={svc.id}
              type="button"
              className={`settings-nav${svc.id === section ? ' settings-nav--active' : ''}`}
              aria-current={svc.id === section || undefined}
              onClick={() => actions.setServicesSection(svc.id)}
            >
              <Icon name={svc.icon} size={14} />
              <span className="settings-nav__body">
                <span className="settings-nav__title">{svc.label}</span>
                <span className="settings-nav__desc">{svc.blurb}</span>
              </span>
            </button>
          ))}
        </nav>
      </div>
      <div className="panel-footer">
        <span className="form-footer-hint">两个服务都是可选的</span>
      </div>
    </aside>
  )
}

export default function ServicesView(): React.JSX.Element {
  const section = useStoreShallow((s) => ({ section: s.servicesSection })).section

  return (
    <main className="content" aria-label="外部服务">
      <div className="t-toolbar">
        <Icon name={section === 'sync' ? 'cloud' : 'server'} size={15} />
        <span className="panel-title">
          {section === 'sync' ? '同步与云端' : 'MCP 服务'}
        </span>
        <span className="term-toolbar__meta">
          {section === 'sync'
            ? '服务端只保存密文，密钥不出本机'
            : '默认只监听回环，策略默认最保守'}
        </span>
      </div>
      <Suspense fallback={<Loading text="正在载入…" />}>
        {section === 'sync' ? <SyncPanel /> : <McpPanel />}
      </Suspense>
    </main>
  )
}
