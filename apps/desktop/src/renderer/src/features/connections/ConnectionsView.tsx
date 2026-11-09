// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

import { Suspense, lazy, useMemo, useState } from 'react'
import type { ConnectionKind } from '@t1000/shared'
import { Button } from '../../components/Button'
import { Banner, EmptyState, Loading } from '../../components/Feedback'
import { Switch } from '../../components/Form'
import { Segmented } from '../../components/Segmented'
import {
  actions,
  loadConnections,
  probeLatency,
  selectProtocolCounts,
  selectVisibleConnections,
  useStore,
  useStoreShallow,
} from '../../lib/store'
import { ConnectionList } from './ConnectionList'
import { ImportOpenSshDialog } from './ImportOpenSshDialog'
import './connections.css'

/** 表单只在真正打开时加载：它是这个视图里最重的模块 */
const ConnectionForm = lazy(() => import('./ConnectionForm'))

/** 演示数据只在开发构建里可载入；生产包连这段代码都不会被加载 */
const DEMO_ENABLED = import.meta.env.DEV

async function loadDemoData(): Promise<void> {
  if (!DEMO_ENABLED) return
  const { seedDemo } = await import('../../lib/demo-seed')
  await seedDemo()
}

const PROTOCOLS: ReadonlyArray<{ value: ConnectionKind; label: string }> = [
  { value: 'ssh', label: 'SSH' },
  { value: 'rdp', label: 'RDP' },
  { value: 'telnet', label: 'Telnet' },
  { value: 'tunnel', label: '隧道' },
  { value: 'vnc', label: 'VNC' },
]

export default function ConnectionsView(): React.JSX.Element {
  const { query, filter, showInfo, protocol, loading, loaded, backendReady, backendError, editing, busy, pingBusy } =
    useStoreShallow((s) => ({
      query: s.query,
      filter: s.filter,
      showInfo: s.showInfo,
      protocol: s.protocol,
      loading: s.loading,
      loaded: s.loaded,
      backendReady: s.backendReady,
      backendError: s.backendError,
      editing: s.editing,
      busy: s.busy,
      pingBusy: s.pingBusy,
    }))

  // 派生结果整体订阅：它本身就是「列表要渲染什么」的最小描述
  const { items, totalInProtocol } = useStore(selectVisibleConnections)
  const counts = useStore(selectProtocolCounts)

  const [importOpen, setImportOpen] = useState(false)
  const hasAny = counts.ssh + counts.rdp + counts.telnet + counts.tunnel + counts.vnc > 0
  const filtered = filter !== '__all__' || query.trim().length > 0

  const segments = useMemo(
    () => PROTOCOLS.map((p) => ({ value: p.value, label: p.label, count: counts[p.value] })),
    [counts],
  )

  return (
    <main className="content" aria-label="连接列表">
      <div className="connlist__protocols">
        <Segmented
          items={segments}
          value={protocol}
          onChange={(v) => actions.setProtocol(v)}
          ariaLabel="连接协议"
        />
        <div style={{ flex: 1 }} />
      </div>

      <div className="t-toolbar">
        <div className="t-search">
          <span className="t-search__icon">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round">
              <circle cx="11" cy="11" r="6.2" />
              <path d="M15.7 15.7l4.3 4.3" />
            </svg>
          </span>
          <input
            className="t-input"
            value={query}
            placeholder="搜索名称、地址、用户或备注…"
            aria-label="搜索连接"
            onChange={(e) => actions.setQuery(e.target.value)}
          />
          {query ? (
            <button
              type="button"
              className="t-iconbtn t-search__clear"
              aria-label="清空搜索"
              onClick={() => actions.setQuery('')}
            >
              ✕
            </button>
          ) : null}
        </div>

        <div className="t-toolbar__spacer" />
        <Switch checked={showInfo} onChange={() => actions.toggleShowInfo()} label="详情列" />
        <div className="t-toolbar__divider" />
        <Button
          size="sm"
          variant="ghost"
          icon="activity"
          loading={pingBusy}
          title="对当前列表做一次延迟探测（15 秒内不会重复探测）"
          onClick={() => void probeLatency(undefined, true)}
        >
          探测延迟
        </Button>
        <Button
          size="sm"
          variant="ghost"
          icon="refresh"
          loading={loading}
          onClick={() => {
            void loadConnections(true)
            void probeLatency()
          }}
        >
          刷新
        </Button>
        <Button size="sm" variant="outline" icon="upload" onClick={() => setImportOpen(true)}>
          导入配置
        </Button>
        <Button size="sm" variant="primary" icon="plus" onClick={() => actions.openCreate(protocol)}>
          新建连接
        </Button>
      </div>

      {busy ? (
        <div className="connlist__bulk">
          <span className="connlist__bulk-count">
            {busy.label} {busy.done}/{busy.total}
          </span>
          <div className="connlist__bulk-spacer" />
        </div>
      ) : null}

      {!backendReady && loaded ? (
        <div style={{ padding: '10px 12px 0' }}>
          <Banner tone="warn" actions={<Button size="sm" onClick={() => void loadConnections(true)}>重试</Button>}>
            存储服务暂时不可用{backendError ? `（${backendError}）` : ''}。可以继续浏览界面，但改动不会落库。
          </Banner>
        </div>
      ) : null}

      {loading && !loaded ? (
        <Loading text="正在读取连接…" />
      ) : !hasAny ? (
        <div className="conn-empty">
          <EmptyState
            icon="server"
            title="还没有任何连接"
            text="新建一条 SSH 连接。填好地址、端口与凭据后保存，双击列表项即可打开终端。"
            actions={
              <>
                <Button variant="primary" icon="plus" onClick={() => actions.openCreate('ssh')}>
                  新建 SSH 连接
                </Button>
                {DEMO_ENABLED ? (
                  <Button variant="outline" icon="cloud" onClick={() => void loadDemoData()}>
                    载入演示数据
                  </Button>
                ) : null}
              </>
            }
          />
        </div>
      ) : items.length === 0 ? (
        <div className="conn-empty">
          <EmptyState
            icon="filter"
            title="没有匹配的连接"
            text={
              filtered
                ? '当前的分组筛选或搜索条件下没有结果。'
                : `${PROTOCOLS.find((p) => p.value === protocol)?.label ?? ''} 分类下还没有连接。`
            }
            actions={
              <>
                {filtered ? (
                  <Button
                    variant="outline"
                    onClick={() => {
                      actions.setFilter('__all__')
                      actions.setQuery('')
                    }}
                  >
                    清除筛选
                  </Button>
                ) : null}
                <Button variant="primary" icon="plus" onClick={() => actions.openCreate(protocol)}>
                  新建连接
                </Button>
              </>
            }
          />
        </div>
      ) : (
        <ConnectionList items={items} showInfo={showInfo} />
      )}

      {editing ? (
        <Suspense fallback={<Loading text="正在载入表单…" />}>
          <ConnectionForm />
        </Suspense>
      ) : null}

      {importOpen ? (
        <Suspense fallback={<Loading text="载入导入器…" />}>
          <ImportOpenSshDialog onClose={() => setImportOpen(false)} />
        </Suspense>
      ) : null}

      <span className="sr-only" aria-live="polite">
        共 {totalInProtocol} 条连接，当前显示 {items.length} 条
      </span>
    </main>
  )
}
