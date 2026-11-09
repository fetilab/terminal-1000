// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 命令手册（离线命令搜索）。
 *
 * 定位很重要：这是**给人读的手册**，不是"点击即执行"的命令面板。
 * spec 原文就写着「只提供参考，不自动发送到终端」——
 * 所以这里所有按钮都是**复制到剪贴板**，没有任何一个会往终端里塞东西。
 *
 * 数据侧的几个事实决定了界面形态：
 * - 空 query 后端**短路返回空**（避免一次吐 214 条）→ 空输入显示引导而不是空列表
 * - `truncated` 如实反映截断 → 必须显示"还有更多"，不能假装只有这些
 * - `category` 已是中文 → 直接用来分组，不做二次映射
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CommandSearchItem, CommandSearchResponse } from '@t1000/shared'
import { Badge, EmptyState, Loading } from '../../components/Feedback'
import { Button, IconButton } from '../../components/Button'
import { Icon } from '../../components/Icon'
import { toast } from '../../components/Toast'
import { invoke } from '../../lib/ipc'
import { errorText } from '../../lib/format'
import './tools.css'

const SEARCH_LIMIT = 40
const DEBOUNCE_MS = 220

function CopyButton({ text, label }: { text: string; label: string }): React.JSX.Element {
  return (
    <IconButton
      icon="copy"
      label={label}
      size={12}
      onClick={() => {
        void navigator.clipboard.writeText(text).then(
          () => toast.ok('已复制到剪贴板（不会发送到终端）'),
          () => toast.error('复制失败'),
        )
      }}
    />
  )
}

function Section({
  title,
  icon,
  children,
}: {
  title: string
  icon: Parameters<typeof Icon>[0]['name']
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="cm-section">
      <div className="cm-section__title">
        <Icon name={icon} size={12} />
        {title}
      </div>
      {children}
    </div>
  )
}

export function CommandManual(): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [items, setItems] = useState<CommandSearchItem[]>([])
  const [truncated, setTruncated] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selectedName, setSelectedName] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  /** 递增序号丢弃过期响应：快速输入时先发的可能后到 */
  const seqRef = useRef(0)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const run = useCallback(async (q: string) => {
    const trimmed = q.trim()
    if (!trimmed) {
      // 空输入不请求：后端也是短路返回空，请求了纯属浪费
      setItems([])
      setTruncated(false)
      setError(null)
      return
    }
    const seq = ++seqRef.current
    setLoading(true)
    try {
      const res = await invoke<
        'completion',
        'search',
        { query: string; limit: number },
        CommandSearchResponse
      >('completion', 'search', { query: trimmed, limit: SEARCH_LIMIT })
      if (seq !== seqRef.current) return
      setItems(Array.isArray(res?.results) ? res.results : [])
      setTruncated(res?.truncated === true)
      setError(null)
      setSelectedName((prev) =>
        prev && res.results.some((r) => r.name === prev) ? prev : (res.results[0]?.name ?? null),
      )
    } catch (err) {
      if (seq !== seqRef.current) return
      setItems([])
      setTruncated(false)
      setError(errorText(err))
    } finally {
      if (seq === seqRef.current) setLoading(false)
    }
  }, [])

  // 防抖：输入时不打后端
  useEffect(() => {
    const t = window.setTimeout(() => void run(query), DEBOUNCE_MS)
    return () => window.clearTimeout(t)
  }, [query, run])

  const selected = useMemo(
    () => items.find((i) => i.name === selectedName) ?? null,
    [items, selectedName],
  )

  /** 按 category 分组；同一分类内保持后端给的排序 */
  const grouped = useMemo(() => {
    const map = new Map<string, CommandSearchItem[]>()
    for (const it of items) {
      const key = it.category ?? '未分类'
      const list = map.get(key)
      if (list) list.push(it)
      else map.set(key, [it])
    }
    return [...map.entries()]
  }, [items])

  return (
    <div className="cm">
      <div className="t-toolbar">
        <div className="t-search" style={{ maxWidth: 420 }}>
          <span className="t-search__icon">
            <Icon name="search" size={14} />
          </span>
          <input
            ref={inputRef}
            className="t-input"
            value={query}
            placeholder="输入命令名，如 tar、journalctl、docker…"
            aria-label="搜索命令"
            onChange={(e) => setQuery(e.target.value)}
          />
          {query ? (
            <IconButton
              className="t-search__clear"
              icon="close"
              label="清空"
              onClick={() => {
                setQuery('')
                inputRef.current?.focus()
              }}
            />
          ) : null}
        </div>
        {items.length > 0 ? <Badge>{items.length} 条</Badge> : null}
        {truncated ? <Badge tone="warn">还有更多（已截断）</Badge> : null}
        <div className="t-toolbar__spacer" />
        {/* 这句必须显眼：用户很容易以为点一下就会执行 */}
        <span className="t-field__hint">
          <Icon name="info" size={12} /> 仅供查阅，不会自动发送到终端
        </span>
      </div>

      {!query.trim() ? (
        <div className="conn-empty">
          <EmptyState
            icon="list"
            title="输入命令名开始查询"
            text="内置 214 条常用命令（9 个分类），其中 73 条带安装方式与示例，部分交互式命令还带常用快捷键。全部离线，不联网。"
          />
        </div>
      ) : error ? (
        <div style={{ padding: 18 }}>
          <div className="t-banner t-banner--error">{error}</div>
        </div>
      ) : loading && items.length === 0 ? (
        <Loading text="查询中…" />
      ) : items.length === 0 ? (
        <div className="conn-empty">
          <EmptyState
            icon="search"
            title={`没有匹配「${query.trim()}」的命令`}
            text="试试更短的关键词，或直接用命令名（支持前缀/包含/描述命中）。"
          />
        </div>
      ) : (
        <div className="cm-split">
          <div className="cm-list">
            {grouped.map(([category, list]) => (
              <div key={category}>
                <div className="cm-list__group">{category}</div>
                {list.map((it) => (
                  <button
                    key={it.name}
                    type="button"
                    className={`cm-item${it.name === selectedName ? ' cm-item--active' : ''}`}
                    onClick={() => setSelectedName(it.name)}
                  >
                    <span className="cm-item__name">{it.name}</span>
                    <span className="cm-item__summary">{it.summary ?? ''}</span>
                  </button>
                ))}
              </div>
            ))}
            {truncated ? (
              <div className="cm-list__more">
                已显示前 {items.length} 条，还有更多结果 —— 再输入几个字符缩小范围即可。
              </div>
            ) : null}
          </div>

          <div className="cm-detail">
            {!selected ? (
              <EmptyState icon="list" title="选择左侧的命令" />
            ) : (
              <>
                <div className="cm-detail__head">
                  <span className="cm-detail__name mono">{selected.name}</span>
                  {selected.category ? <Badge tone="outline">{selected.category}</Badge> : null}
                </div>
                {selected.summary ? <div className="cm-detail__summary">{selected.summary}</div> : null}

                <div className="cm-detail__body">
                  {selected.usage ? (
                    <Section title="语法" icon="terminal">
                      <div className="cm-code">
                        <code>{selected.usage}</code>
                        <CopyButton text={selected.usage} label="复制语法" />
                      </div>
                    </Section>
                  ) : null}

                  {selected.options && selected.options.length > 0 ? (
                    <Section title={`参数（${selected.options.length}）`} icon="sliders">
                      <div className="cm-kv">
                        {selected.options.map((o) => (
                          <div className="cm-kv__row" key={o.name}>
                            <span className="cm-kv__key mono">
                              {o.name}
                              {o.arg ? <span className="cm-kv__arg"> {o.arg}</span> : null}
                            </span>
                            <span className="cm-kv__val">{o.description}</span>
                          </div>
                        ))}
                      </div>
                    </Section>
                  ) : null}

                  {selected.subcommands && selected.subcommands.length > 0 ? (
                    <Section title={`子命令（${selected.subcommands.length}）`} icon="list">
                      <div className="cm-kv">
                        {selected.subcommands.map((s) => (
                          <div className="cm-kv__row" key={s.name}>
                            <span className="cm-kv__key mono">{s.name}</span>
                            <span className="cm-kv__val">{s.description}</span>
                          </div>
                        ))}
                      </div>
                    </Section>
                  ) : null}

                  {selected.examples && selected.examples.length > 0 ? (
                    <Section title="常用示例" icon="zap">
                      <div className="cm-examples">
                        {selected.examples.map((ex) => (
                          <div className="cm-example" key={ex.command}>
                            <div className="cm-example__cmd">
                              <code>{ex.command}</code>
                              <CopyButton text={ex.command} label={`复制示例 ${ex.command}`} />
                            </div>
                            {ex.description ? (
                              <div className="cm-example__desc">{ex.description}</div>
                            ) : null}
                          </div>
                        ))}
                      </div>
                    </Section>
                  ) : null}

                  {selected.shortcuts && selected.shortcuts.length > 0 ? (
                    <Section title="常用快捷键" icon="key">
                      <div className="cm-keys">
                        {selected.shortcuts.map((s) => (
                          <span className="cm-key" key={s.key}>
                            <kbd className="t-kbd">{s.key}</kbd>
                            {s.description}
                          </span>
                        ))}
                      </div>
                    </Section>
                  ) : null}

                  {selected.install ? (
                    <Section title="安装方式" icon="download">
                      <div className="cm-code">
                        <code>{selected.install}</code>
                        <CopyButton text={selected.install} label="复制安装命令" />
                      </div>
                    </Section>
                  ) : null}

                  {!selected.usage && !selected.options?.length && !selected.examples?.length ? (
                    <p className="t-field__hint">
                      这条命令目前只有简要说明（详版 73 条之一尚未覆盖到它）。
                    </p>
                  ) : null}
                </div>

                <div className="cm-detail__foot">
                  <Button
                    size="sm"
                    variant="outline"
                    icon="copy"
                    onClick={() => {
                      void navigator.clipboard.writeText(`${selected.name} — ${selected.summary ?? ''}`)
                      toast.ok('已复制命令名与用途')
                    }}
                  >
                    复制这条说明
                  </Button>
                  <span className="t-field__hint">
                    手册只提供参考；要执行请自己在终端里输入。
                  </span>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

export default CommandManual
