// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

import { useEffect, useState } from 'react'
import { invoke } from './lib/ipc'

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
  logDir: string
}

/**
 * 应用外壳。当前阶段只做两件事：
 * 1. 证明 main ↔ preload ↔ renderer 链路可用
 * 2. 落地整体布局骨架（左图标栏 / 列表面板 / 内容区）
 */
export function App(): React.JSX.Element {
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [paths, setPaths] = useState<AppPaths | null>(null)
  const [error, setError] = useState<string | null>(null)

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
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <div className="app-shell">
      <aside className="rail" aria-label="功能入口">
        <div className="rail-item rail-item--active" title="连接中心">
          <span aria-hidden>⌘</span>
        </div>
        <div className="rail-item" title="控制台">
          <span aria-hidden>▚</span>
        </div>
        <div className="rail-item" title="笔记">
          <span aria-hidden>▤</span>
        </div>
        <div className="rail-item" title="工具">
          <span aria-hidden>✦</span>
        </div>
        <div className="rail-spacer" />
        <div className="rail-item" title="设置">
          <span aria-hidden>⚙</span>
        </div>
      </aside>

      <section className="panel" aria-label="列表">
        <header className="panel-header">
          <span className="panel-title">连接中心</span>
        </header>
        <nav className="filter-list">
          <button className="filter filter--active" type="button">
            全部
          </button>
          <button className="filter" type="button">
            收藏
          </button>
          <button className="filter" type="button">
            最近
          </button>
          <button className="filter" type="button">
            常用
          </button>
        </nav>
      </section>

      <main className="content" aria-label="主内容">
        <div className="empty-state">
          <h1 className="empty-title">terminal-1000</h1>
          <p className="empty-subtitle">当前为骨架版本，功能模块正在接入。</p>

          {error && (
            <p className="banner banner--error" role="alert">
              主进程通信失败：{error}
            </p>
          )}

          {info && (
            <dl className="info-grid">
              <dt>版本</dt>
              <dd>{info.version}</dd>
              <dt>运行环境</dt>
              <dd>
                Electron {info.electron} · Chromium {info.chrome} · Node {info.node}
              </dd>
              <dt>平台</dt>
              <dd>
                {info.platform} / {info.arch} · {info.locale}
              </dd>
              {paths && (
                <>
                  <dt>数据目录</dt>
                  <dd className="mono">{paths.userData}</dd>
                </>
              )}
            </dl>
          )}

          {!info && !error && <p className="empty-subtitle">正在读取运行环境…</p>}
        </div>
      </main>
    </div>
  )
}
