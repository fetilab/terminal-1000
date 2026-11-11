// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 全局搜索（命令面板）。
 *
 * spec §2.2：界面导览里要有全局搜索，覆盖**连接 / 分组 / 笔记 / 设置 / 服务器（会话）**。
 *
 * 两个实现要点：
 * 1. **来源分两类**——连接与笔记走主进程检索（`store.search` / `notes.list` 的 keyword），
 *    分组 / 设置项 / 当前会话在渲染层就地过滤（它们本来就在内存里，发一次 IPC 纯属浪费）。
 * 2. **结果必须能跳转**，否则搜索只是个只读列表：连接→真的去连；设置→跳到对应分区；
 *    笔记→打开该笔记；会话→切到那个标签。
 *
 * 快捷键用 **Ctrl/Cmd+K**：我核对过默认绑定（Ctrl+Shift+T/W/F/L/D/E、Ctrl+Shift+Space），
 * Ctrl+K 没被占用；而且这是**应用内**快捷键，走渲染层 keydown 即可，
 * 不需要登记到 hotkey 服务（那个是给全局/系统级快捷键用的）。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { invoke } from '../../lib/ipc'
import { errorText } from '../../lib/format'
import { Icon, type IconName } from '../../components/Icon'
import { Badge } from '../../components/Feedback'
import {
  actions,
  connectTo,
  openNote,
  setActiveTab,
  useStoreShallow,
  type UiConnection,
} from '../../lib/store'
import type { NoteSummary } from '@t1000/shared'
import { SECTION_META, SETTINGS_FIELDS } from '../settings/settingsFields'
import './search.css'

type HitGroup = '会话' | '连接' | '分组' | '笔记' | '设置'

interface Hit {
  id: string
  group: HitGroup
  title: string
  subtitle?: string
  icon: IconName
  run: () => void | Promise<void>
}

const GROUP_ORDER: HitGroup[] = ['会话', '连接', '分组', '笔记', '设置']
/** 每类最多给几条：面板是"快速跳转"，不是结果浏览页 */
const PER_GROUP = 6

/* ── 后台来源 ─────────────────────────────────── */

async function searchConnections(keyword: string): Promise<Hit[]> {
  try {
    const list = await invoke<'store', 'search', { keyword: string; limit?: number }, UiConnection[]>(
      'store',
      'search',
      { keyword, limit: PER_GROUP * 2 },
    )
    return (Array.isArray(list) ? list : []).slice(0, PER_GROUP).map((c) => ({
      id: `conn-${c.id}`,
      group: '连接' as const,
      title: c.name,
      subtitle: `${c.kind.toUpperCase()} · ${'host' in c ? String(c.host) : ''}${'port' in c ? `:${String(c.port)}` : ''}`,
      icon: (c.kind === 'ssh' ? 'terminal' : c.kind === 'vnc' ? 'eye' : 'server') as IconName,
      run: () => void connectTo(c),
    }))
  } catch {
    // 单类来源失败不该让整个面板空掉
    return []
  }
}

async function searchNotes(keyword: string): Promise<Hit[]> {
  try {
    const list = await invoke<'notes', 'list', { keyword: string }, NoteSummary[]>('notes', 'list', {
      keyword,
    })
    return (Array.isArray(list) ? list : []).slice(0, PER_GROUP).map((n) => ({
      id: `note-${n.id}`,
      group: '笔记' as const,
      title: n.title || '（无标题）',
      subtitle: n.folderId ? '已归类' : '未归类',
      icon: 'notes' as IconName,
      run: () => {
        actions.setView('notes')
        void openNote(n.id)
      },
    }))
  } catch {
    return []
  }
}

/* ── 面板 ─────────────────────────────────────── */

export interface GlobalSearchProps {
  onClose: () => void
}

export function GlobalSearch({ onClose }: GlobalSearchProps): React.JSX.Element {
  const { tabs, groups } = useStoreShallow((s) => ({ tabs: s.tabs, groups: s.groups }))
  const [query, setQuery] = useState('')
  const [remote, setRemote] = useState<{ conn: Hit[]; notes: Hit[] }>({ conn: [], notes: [] })
  const [loading, setLoading] = useState(false)
  const [cursor, setCursor] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const seqRef = useRef(0)
  const listRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  /* 后台检索（连接 + 笔记），防抖 + 序号丢弃过期响应 */
  useEffect(() => {
    const q = query.trim()
    if (!q) {
      setRemote({ conn: [], notes: [] })
      setError(null)
      return
    }
    const seq = ++seqRef.current
    setLoading(true)
    const t = window.setTimeout(() => {
      void Promise.all([searchConnections(q), searchNotes(q)])
        .then(([conn, notes]) => {
          if (seq !== seqRef.current) return
          setRemote({ conn, notes })
          setError(null)
        })
        .catch((e) => {
          if (seq === seqRef.current) setError(errorText(e))
        })
        .finally(() => {
          if (seq === seqRef.current) setLoading(false)
        })
    }, 180)
    return () => window.clearTimeout(t)
  }, [query])

  /* 本地来源：会话 / 分组 / 设置项 —— 数据已在内存，直接过滤 */
  const localHits = useMemo<Hit[]>(() => {
    const q = query.trim().toLowerCase()
    if (!q) return []
    const hits: Hit[] = []

    for (const tab of tabs.slice(0, PER_GROUP)) {
      if (!tab.title.toLowerCase().includes(q) && !(tab.subtitle ?? '').toLowerCase().includes(q)) continue
      hits.push({
        id: `tab-${tab.tabId}`,
        group: '会话',
        title: tab.title,
        subtitle: `${tab.subtitle ?? ''}${tab.state === 'ready' ? ' · 已连接' : ` · ${tab.state}`}`,
        icon: 'console',
        run: () => {
          actions.setView('console')
          setActiveTab(tab.tabId)
        },
      })
    }

    for (const g of groups) {
      if (!g.name.toLowerCase().includes(q)) continue
      hits.push({
        id: `group-${g.id}`,
        group: '分组',
        title: g.name,
        subtitle: '在连接中心按该分组筛选',
        icon: 'folder',
        run: () => {
          actions.setView('connections')
          actions.setFilter(g.id)
        },
      })
    }

    // 设置项：按 label / hint / path 过滤，跳到对应分区
    for (const [section, meta] of Object.entries(SECTION_META)) {
      const fields =
        section === 'highlights' || section === 'hotkeys' || section === 'vault'
          ? []
          : (SETTINGS_FIELDS[section as keyof typeof SETTINGS_FIELDS] ?? [])
      for (const f of fields) {
        const hay = `${f.label} ${f.hint ?? ''} ${f.path}`.toLowerCase()
        if (!hay.includes(q)) continue
        hits.push({
          id: `set-${f.path}`,
          group: '设置',
          title: f.label,
          subtitle: `${meta.label} · ${f.path}`,
          icon: 'settings',
          run: () => {
            actions.setView('settings')
            actions.setSettingsSection(section as never)
          },
        })
        if (hits.filter((h) => h.group === '设置').length >= PER_GROUP) break
      }
      // 分区名本身命中也要能跳过去
      if (
        meta.label.toLowerCase().includes(q) &&
        !hits.some((h) => h.id === `setsec-${section}`)
      ) {
        hits.push({
          id: `setsec-${section}`,
          group: '设置',
          title: meta.label,
          subtitle: meta.blurb,
          icon: 'settings',
          run: () => {
            actions.setView('settings')
            actions.setSettingsSection(section as never)
          },
        })
      }
    }

    return hits
  }, [query, tabs, groups])

  const grouped = useMemo(() => {
    const all = [...remote.conn, ...localHits, ...remote.notes]
    const byGroup = new Map<HitGroup, Hit[]>()
    for (const h of all) {
      const list = byGroup.get(h.group) ?? []
      list.push(h)
      byGroup.set(h.group, list)
    }
    return GROUP_ORDER.map((g) => ({ group: g, hits: byGroup.get(g) ?? [] })).filter(
      (x) => x.hits.length > 0,
    )
  }, [remote, localHits])

  /** 扁平化后的顺序，键盘导航按它走 */
  const flat = useMemo(() => grouped.flatMap((g) => g.hits), [grouped])

  useEffect(() => {
    setCursor(0)
  }, [query])

  // 让光标项始终可见（长列表时键盘导航不至于"走出去"）
  useEffect(() => {
    listRef.current?.querySelector('.gs-item--active')?.scrollIntoView({ block: 'nearest' })
  }, [cursor])

  const runHit = useCallback(
    (hit: Hit | undefined) => {
      if (!hit) return
      onClose()
      void Promise.resolve(hit.run()).catch((e) => errorText(e))
    },
    [onClose],
  )

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setCursor((c) => (flat.length === 0 ? 0 : (c + 1) % flat.length))
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      setCursor((c) => (flat.length === 0 ? 0 : (c - 1 + flat.length) % flat.length))
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      runHit(flat[cursor])
    }
  }

  const hasQuery = query.trim().length > 0
  let flatIndex = -1

  return (
    <div className="gs-backdrop" onMouseDown={onClose} role="presentation">
      <div
        className="gs"
        role="dialog"
        aria-modal="true"
        aria-label="全局搜索"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <div className="gs__input-row">
          <Icon name="search" size={16} />
          <input
            ref={inputRef}
            className="gs__input"
            value={query}
            placeholder="搜索连接、分组、笔记、设置、当前会话…"
            aria-label="全局搜索"
            onChange={(e) => setQuery(e.target.value)}
          />
          {loading ? <span className="gs__spinner" aria-hidden /> : null}
          {query ? (
            <button type="button" className="gs__clear" aria-label="清空" onClick={() => setQuery('')}>
              <Icon name="close" size={13} />
            </button>
          ) : (
            <kbd className="t-kbd">Esc</kbd>
          )}
        </div>

        <div className="gs__list" ref={listRef}>
          {error ? <div className="gs__err">{error}</div> : null}

          {!hasQuery ? (
            <div className="gs__guide">
              <div className="gs__guide-title">搜索范围</div>
              <ul>
                <li>
                  <b>连接</b> —— 按名称、主机检索，回车直接连接
                </li>
                <li>
                  <b>分组</b> —— 跳到连接中心并按该分组筛选
                </li>
                <li>
                  <b>笔记</b> —— 按标题与正文检索，回车打开该笔记
                </li>
                <li>
                  <b>设置</b> —— 按名称检索设置项，回车跳到对应分区
                </li>
                <li>
                  <b>会话</b> —— 切到已经打开的标签
                </li>
              </ul>
              <div className="gs__guide-foot">
                <kbd className="t-kbd">↑</kbd>
                <kbd className="t-kbd">↓</kbd> 选择 · <kbd className="t-kbd">Enter</kbd> 执行 ·{' '}
                <kbd className="t-kbd">Esc</kbd> 关闭
              </div>
            </div>
          ) : flat.length === 0 && !loading ? (
            <div className="gs__empty">没有匹配「{query.trim()}」的结果</div>
          ) : (
            grouped.map(({ group, hits }) => (
              <div className="gs__group" key={group}>
                <div className="gs__group-title">
                  {group}
                  <Badge tone="outline">{hits.length}</Badge>
                </div>
                {hits.map((h) => {
                  flatIndex += 1
                  const active = flatIndex === cursor
                  const idx = flatIndex
                  return (
                    <button
                      key={h.id}
                      type="button"
                      className={`gs-item${active ? ' gs-item--active' : ''}`}
                      onMouseEnter={() => setCursor(idx)}
                      onClick={() => runHit(h)}
                    >
                      <Icon name={h.icon} size={15} />
                      <span className="gs-item__body">
                        <span className="gs-item__title">{h.title}</span>
                        {h.subtitle ? <span className="gs-item__sub">{h.subtitle}</span> : null}
                      </span>
                      {active ? <kbd className="t-kbd">Enter</kbd> : null}
                    </button>
                  )
                })}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  )
}

export default GlobalSearch
