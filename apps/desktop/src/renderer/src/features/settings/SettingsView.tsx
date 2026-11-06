// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 设置视图。
 *
 * 这一版只放**能拿到真实数据**的部分：运行环境、数据目录、存储后端状态、
 * 以及设计令牌的速览（方便后续做主题时对照）。
 * 其余设置分区（终端外观、补全、AI、同步…）需要 settings 服务支撑，
 * 这里给出明确说明而不是渲染一堆点了没反应的开关。
 */

import { useEffect, useState } from 'react'
import { Events } from '@t1000/shared'
import { Badge, Banner, Loading } from '../../components/Feedback'
import { Button, IconButton, Section } from '../../components/Button'
import { Icon, type IconName } from '../../components/Icon'
import { invoke } from '../../lib/ipc'
import { errorText } from '../../lib/format'
import { useStoreShallow } from '../../lib/store'

interface AppInfo {
  name: string
  version: string
  electron: string
  chrome: string
  node: string
  platform: string
  arch: string
  locale: string
}

interface AppPaths {
  userData: string
  dbFile: string
  notesDir: string
  sessionLogDir: string
  watchDir: string
  bgImagesDir: string
  backupDir: string
  logDir: string
}

const NAV: Array<{ id: string; label: string; icon: IconName; ready: boolean }> = [
  { id: 'about', label: '关于与运行环境', icon: 'info', ready: true },
  { id: 'storage', label: '存储与备份', icon: 'server', ready: true },
  { id: 'appearance', label: '外观与主题', icon: 'eye', ready: false },
  { id: 'terminal', label: '终端行为', icon: 'terminal', ready: false },
  { id: 'sync', label: '同步与云端', icon: 'cloud', ready: false },
  { id: 'hotkeys', label: '快捷键', icon: 'zap', ready: false },
]

const TOKENS: Array<[string, string]> = [
  ['--t1000-bg', '#12141a'],
  ['--t1000-bg-panel', '#1e222b'],
  ['--t1000-bg-raised', '#191c24'],
  ['--t1000-accent', '#3ec9d6'],
  ['--t1000-accent-strong', '#22b3c1'],
  ['--t1000-danger', '#e5484d'],
  ['--t1000-warn', '#d9a441'],
  ['--t1000-ok', '#46b17b'],
  ['--t1000-fg', '#e4e7ee'],
  ['--t1000-fg-muted', '#9aa3b2'],
]

export function SettingsSidebar(): React.JSX.Element {
  return (
    <aside className="panel" aria-label="设置">
      <header className="panel-header">
        <span className="panel-title">设置</span>
      </header>
      <div className="panel-body">
        <div className="sessions">
          {NAV.map((item, i) => (
            <div
              key={item.id}
              className={`session-item${i === 0 ? ' session-item--active' : ''}`}
              role="button"
              tabIndex={0}
              title={item.ready ? item.label : `${item.label}（待接入）`}
            >
              <Icon name={item.icon} size={14} />
              <div className="session-item__body">
                <div className="session-item__title">{item.label}</div>
                {!item.ready ? <div className="session-item__meta">待接入</div> : null}
              </div>
            </div>
          ))}
        </div>
      </div>
    </aside>
  )
}

export default function SettingsView(): React.JSX.Element {
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [paths, setPaths] = useState<AppPaths | null>(null)
  const [error, setError] = useState<string | null>(null)
  const backend = useStoreShallow((s) => ({
    ready: s.backendReady,
    message: s.backendError,
    connections: s.connections.length,
    groups: s.groups.length,
  }))

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const [i, p] = await Promise.all([
          invoke<'app', 'getInfo', undefined, AppInfo>('app', 'getInfo', undefined),
          invoke<'app', 'getPaths', undefined, AppPaths>('app', 'getPaths', undefined),
        ])
        if (cancelled) return
        setInfo(i)
        setPaths(p)
      } catch (err) {
        if (!cancelled) setError(errorText(err))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const rows: Array<[string, React.ReactNode]> = info
    ? [
        ['应用', `${info.name} ${info.version}`],
        ['Electron', info.electron],
        ['Chromium', info.chrome],
        ['Node', info.node],
        ['平台', `${info.platform} / ${info.arch}`],
        ['语言区域', info.locale],
      ]
    : []

  const pathRows: Array<[string, string]> = paths
    ? [
        ['数据目录', paths.userData],
        ['数据库', paths.dbFile],
        ['备份目录', paths.backupDir],
        ['日志目录', paths.logDir],
        ['笔记目录', paths.notesDir],
        ['会话录制', paths.sessionLogDir],
      ]
    : []

  return (
    <main className="content" aria-label="设置">
      <div className="t-toolbar">
        <Icon name="settings" size={15} />
        <span className="panel-title">设置</span>
        <div className="t-toolbar__spacer" />
        <Badge tone={backend.ready ? 'ok' : 'warn'}>
          存储后端 {backend.ready ? '正常' : '不可用'}
        </Badge>
      </div>

      <div className="content-scroll" style={{ padding: 18, maxWidth: 900 }}>
        {error ? (
          <div style={{ marginBottom: 14 }}>
            <Banner tone="error">读取运行环境失败：{error}</Banner>
          </div>
        ) : null}

        <Section>运行环境</Section>
        {info ? (
          <div className="kv" style={{ gridTemplateColumns: '120px minmax(0, 1fr)' }}>
            {rows.map(([k, v]) => (
              <div key={k} style={{ display: 'contents' }}>
                <span className="kv__k">{k}</span>
                <span className="kv__v">{v}</span>
              </div>
            ))}
          </div>
        ) : (
          <Loading text="读取运行环境…" />
        )}

        <Section>数据位置</Section>
        {paths ? (
          <div className="kv" style={{ gridTemplateColumns: '120px minmax(0, 1fr)' }}>
            {pathRows.map(([k, v]) => (
              <div key={k} style={{ display: 'contents' }}>
                <span className="kv__k">{k}</span>
                <span className="kv__v mono" style={{ fontSize: 12, wordBreak: 'break-all' }}>
                  {v}
                </span>
              </div>
            ))}
          </div>
        ) : null}

        <Section>存储现状</Section>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <Badge tone="accent">连接 {backend.connections}</Badge>
          <Badge tone="accent">分组 {backend.groups}</Badge>
          <Badge>库类型 SQLite (WAL)</Badge>
          <Badge>加密 AES-256-GCM</Badge>
        </div>
        {!backend.ready && backend.message ? (
          <div style={{ marginTop: 10 }}>
            <Banner tone="warn">存储服务报错：{backend.message}</Banner>
          </div>
        ) : null}

        <Section>设计令牌</Section>
        <p className="t-field__hint" style={{ marginTop: 0 }}>
          自研视觉的基准色。色板刻意选择青色强调而非同类产品惯用的绿色，
          中性色偏冷灰蓝，层级用「底色深浅 + 1px 描边」而不是重投影。
        </p>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
          {TOKENS.map(([name, hex]) => (
            <div
              key={name}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '6px 10px',
                border: '1px solid var(--t1000-border)',
                borderRadius: 'var(--t1000-radius)',
                background: 'var(--t1000-bg-raised)',
              }}
            >
              <span
                aria-hidden
                style={{
                  width: 18,
                  height: 18,
                  borderRadius: 5,
                  background: hex,
                  border: '1px solid var(--t1000-border-strong)',
                }}
              />
              <span className="mono" style={{ fontSize: 11.5 }}>
                {name}
              </span>
              <span className="metric__sub mono">{hex}</span>
            </div>
          ))}
        </div>

        <Section>尚未接入的分区</Section>
        <p className="t-field__hint">
          外观主题、终端行为、补全、AI 助手、同步与快捷键都需要 settings / completion / ai / sync
          服务提供读写接口。界面在此明确标注，而不是渲染一批点了没反应的开关。
        </p>

        <Section>诊断</Section>
        <div style={{ display: 'flex', gap: 8 }}>
          <Button
            size="sm"
            variant="outline"
            icon="copy"
            onClick={() => {
              const text = JSON.stringify({ info, paths, events: Object.keys(Events).length }, null, 2)
              void navigator.clipboard.writeText(text)
            }}
          >
            复制环境信息
          </Button>
          <IconButton
            icon="refresh"
            label="重新读取"
            onClick={() => {
              setInfo(null)
              setPaths(null)
              setError(null)
              void (async () => {
                try {
                  const [i, p] = await Promise.all([
                    invoke<'app', 'getInfo', undefined, AppInfo>('app', 'getInfo', undefined),
                    invoke<'app', 'getPaths', undefined, AppPaths>('app', 'getPaths', undefined),
                  ])
                  setInfo(i)
                  setPaths(p)
                } catch (err) {
                  setError(errorText(err))
                }
              })()
            }}
          />
        </div>
      </div>
    </main>
  )
}
