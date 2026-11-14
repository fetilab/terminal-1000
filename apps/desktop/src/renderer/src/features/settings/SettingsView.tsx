// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 设置面板（接真实 settings 域）。
 *
 * 三个要点：
 * 1. 写入用 `settings.set({ path, value })` —— 主进程做**深合并**，
 *    只传一个字段不会把整棵设置树覆盖掉。所以这里可以放心「改哪个字段就发哪个字段」。
 * 2. 文本/数字输入**防抖**后再提交，避免每敲一个字符一次 IPC + 一次落盘。
 * 3. 所有分区都可写（含补全/AI/传输/同步），靠声明式字段表 + 一个通用渲染器实现，
 *    不是只读展示。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Settings } from '@t1000/shared'
import { Button, IconButton, Section } from '../../components/Button'
import { Badge, Banner, Loading } from '../../components/Feedback'
import { Field, Select, Switch, TextInput } from '../../components/Form'
import { Icon, type IconName } from '../../components/Icon'
import { toast } from '../../components/Toast'
import { invoke } from '../../lib/ipc'
import { errorText } from '../../lib/format'
import {
  actions,
  applyHighlightRules,
  applyTerminalSettings,
  applyTheme,
  useStoreShallow,
} from '../../lib/store'
import {
  SECTION_META,
  SETTINGS_FIELDS,
  readPath,
  summarizeAi,
  type FieldDef,
  type SettingsSection,
} from './settingsFields'
import { HighlightsEditor } from './HighlightsEditor'
import { HotkeysEditor } from './HotkeysEditor'
import { VaultSettings } from './VaultSettings'
import './settings.css'

export const SETTINGS_SECTIONS: SettingsSection[] = [
  'app',
  'terminal',
  'highlights',
  'hotkeys',
  'completion',
  'ai',
  'transfer',
  'sync',
  'vault',
]

/* ── 数据 ──────────────────────────────────────── */

function useSettings(): {
  settings: Settings | null
  error: string | null
  loading: boolean
  update: (path: string, value: unknown) => Promise<void>
  resetSection: (section: SettingsSection) => Promise<void>
  reload: () => Promise<void>
} {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const reload = useCallback(async () => {
    setLoading(true)
    try {
      const all = await invoke<'settings', 'getAll', Record<string, never>, Settings>(
        'settings',
        'getAll',
        {},
      )
      setSettings(all)
      setError(null)
      applyTheme(all.app.theme)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  const update = useCallback(
    async (path: string, value: unknown) => {
      try {
        // 主进程返回写入后的**完整设置文档**，直接整体替换，
        // 不在渲染层自己拼合并逻辑（避免与主进程的深合并规则产生两套语义）
        const next = await invoke<'settings', 'set', { path: string; value: unknown }, Settings>(
          'settings',
          'set',
          { path, value },
        )
        setSettings(next)
        if (path === 'app.theme') applyTheme(next.app.theme)
        // 终端相关改一项就推一次，已打开的 xterm 立刻跟着变（热更新）
        if (path.startsWith('terminal.')) applyTerminalSettings(next.terminal)
      } catch (err) {
        toast.error(`设置保存失败：${errorText(err)}`)
        void reload()
      }
    },
    [reload],
  )

  const resetSection = useCallback(async (section: SettingsSection) => {
    try {
      const next = await invoke<'settings', 'reset', { section: string }, Settings>(
        'settings',
        'reset',
        { section },
      )
      setSettings(next)
      applyTheme(next.app.theme)
      applyTerminalSettings(next.terminal)
      toast.ok(`「${SECTION_META[section].label}」已恢复默认值`)
    } catch (err) {
      toast.error(`重置失败：${errorText(err)}`)
    }
  }, [])

  return { settings, error, loading, update, resetSection, reload }
}

/* ── 防抖输入 ──────────────────────────────────── */

function useDebounced<T>(value: T, commit: (v: T) => void, delay = 450): [T, (v: T) => void] {
  const [draft, setDraft] = useState(value)
  const dirty = useRef(false)
  const timer = useRef<number | undefined>(undefined)

  useEffect(() => {
    if (!dirty.current) setDraft(value)
  }, [value])

  useEffect(() => () => window.clearTimeout(timer.current), [])

  const onChange = useCallback(
    (v: T) => {
      setDraft(v)
      dirty.current = true
      window.clearTimeout(timer.current)
      timer.current = window.setTimeout(() => {
        dirty.current = false
        commit(v)
      }, delay)
    },
    [commit, delay],
  )

  return [draft, onChange]
}

/* ── 通用字段渲染 ──────────────────────────────── */

function FieldControl({
  def,
  value,
  onChange,
}: {
  def: FieldDef
  value: unknown
  onChange: (v: unknown) => void
}): React.JSX.Element {
  const str = value === undefined || value === null ? '' : String(value)
  const [text, setText] = useDebounced(str, (v) => {
    if (def.kind === 'number') {
      const n = Number(v)
      onChange(Number.isFinite(n) && v.trim() !== '' ? n : 0)
    } else {
      onChange(v)
    }
  })

  switch (def.kind) {
    case 'switch':
      return <Switch checked={value === true} onChange={(v) => onChange(v)} label={def.label} />
    case 'select':
      return <Select value={str} options={def.options ?? []} onChange={(e) => onChange(e.target.value)} />
    case 'number':
      return (
        <TextInput
          type="number"
          mono
          value={text}
          min={def.min}
          max={def.max}
          step={def.step}
          onChange={(e) => setText(e.target.value)}
        />
      )
    default:
      return <TextInput value={text} mono={def.path.includes('font')} onChange={(e) => setText(e.target.value)} />
  }
}

function FieldsGrid({
  defs,
  settings,
  update,
}: {
  defs: readonly FieldDef[]
  settings: Settings
  update: (path: string, value: unknown) => void
}): React.JSX.Element {
  return (
    <div className="t-grid t-grid--2 settings-grid">
      {defs.map((def) => {
        const value = readPath(settings, def.path)
        if (def.kind === 'switch') {
          return (
            <div className="settings-switch-row" key={def.path}>
              <FieldControl def={def} value={value} onChange={(v) => update(def.path, v)} />
              <div className="t-field__hint">
                {def.hint ?? def.path}
                {def.caution ? <Badge tone="warn">谨慎</Badge> : null}
              </div>
            </div>
          )
        }
        return (
          <Field
            key={def.path}
            label={def.label}
            hint={def.hint}
            className={def.wide ? 't-grid__span2' : undefined}
            aside={def.caution ? <Badge tone="warn">谨慎</Badge> : undefined}
          >
            <FieldControl def={def} value={value} onChange={(v) => update(def.path, v)} />
          </Field>
        )
      })}
    </div>
  )
}

function ReadonlyRows({ rows }: { rows: Array<[string, React.ReactNode]> }): React.JSX.Element {
  return (
    <div className="kv" style={{ gridTemplateColumns: '160px minmax(0, 1fr)' }}>
      {rows.map(([k, v]) => (
        <div key={k} style={{ display: 'contents' }}>
          <span className="kv__k">{k}</span>
          <span className="kv__v">{v}</span>
        </div>
      ))}
    </div>
  )
}

/* ── 侧栏 ──────────────────────────────────────── */

export function SettingsSidebar(): React.JSX.Element {
  const section = useStoreShallow((s) => ({ section: s.settingsSection })).section
  return (
    <aside className="panel" aria-label="设置">
      <header className="panel-header">
        <span className="panel-title">设置</span>
      </header>
      <div className="panel-body">
        <nav className="settings-nav-list">
          {SETTINGS_SECTIONS.map((id) => (
            <button
              key={id}
              type="button"
              className={`settings-nav${id === section ? ' settings-nav--active' : ''}`}
              aria-current={id === section || undefined}
              onClick={() => actions.setSettingsSection(id)}
            >
              <Icon name={SECTION_META[id].icon as IconName} size={14} />
              <span className="settings-nav__body">
                <span className="settings-nav__title">{SECTION_META[id].label}</span>
                <span className="settings-nav__desc">{SECTION_META[id].blurb}</span>
              </span>
            </button>
          ))}
        </nav>
      </div>
    </aside>
  )
}

/* ── 主视图 ────────────────────────────────────── */

export default function SettingsView(): React.JSX.Element {
  const section = useStoreShallow((s) => ({ section: s.settingsSection })).section
  const { settings, error, loading, update, resetSection, reload } = useSettings()
  const backend = useStoreShallow((s) => ({ ready: s.backendReady, message: s.backendError }))

  const meta = SECTION_META[section]
  const defs = useMemo(
    () =>
      section === 'highlights' || section === 'hotkeys' || section === 'vault'
        ? []
        : SETTINGS_FIELDS[section],
    [section],
  )

  if (loading && !settings) {
    return (
      <main className="content" aria-label="设置">
        <Loading text="正在读取设置…" />
      </main>
    )
  }

  if (error && !settings) {
    return (
      <main className="content" aria-label="设置">
        <div className="content-scroll" style={{ padding: 18 }}>
          <Banner
            tone="error"
            actions={
              <Button size="sm" onClick={() => void reload()}>
                重试
              </Button>
            }
          >
            无法读取设置：{error}
          </Banner>
        </div>
      </main>
    )
  }

  if (!settings) return <main className="content" />

  return (
    <main className="content" aria-label="设置">
      <div className="t-toolbar">
        <Icon name={meta.icon as IconName} size={15} />
        <span className="panel-title">{meta.label}</span>
        <span className="term-toolbar__meta">{meta.blurb}</span>
        <div className="t-toolbar__spacer" />
        <Badge tone={backend.ready ? 'ok' : 'warn'}>{backend.ready ? '已持久化' : '存储不可用'}</Badge>
        <IconButton icon="refresh" label="重新读取" onClick={() => void reload()} />
        <Button size="sm" variant="ghost" icon="chevron-left" onClick={() => void resetSection(section)}>
          本页恢复默认
        </Button>
      </div>

      <div className="content-scroll settings-body">
        {section === 'vault' ? (
          <VaultSettings />
        ) : section === 'highlights' ? (
          <HighlightsEditor
            rules={settings.highlights}
            onChange={(rules) => {
              // 立刻推给 store：已打开的终端无需重连即用新规则
              applyHighlightRules(rules)
              void update('highlights', rules)
            }}
          />
        ) : section === 'hotkeys' ? (
          <HotkeysEditor bindings={settings.hotkeys} onChange={(list) => void update('hotkeys', list)} />
        ) : (
          <FieldsGrid defs={defs} settings={settings} update={(p, v) => void update(p, v)} />
        )}

        {section === 'ai' ? (
          <>
            <Section>供应商与名单（只读）</Section>
            <ReadonlyRows
              rows={[
                ['供应商', summarizeAi(settings)],
                [
                  '只读白名单',
                  settings.ai.riskPolicy.readOnlyAllowlist.length === 0
                    ? '使用内置默认名单'
                    : `${settings.ai.riskPolicy.readOnlyAllowlist.length} 条`,
                ],
                [
                  '危险黑名单',
                  settings.ai.riskPolicy.dangerousDenylist.length === 0
                    ? '使用内置默认名单'
                    : `${settings.ai.riskPolicy.dangerousDenylist.length} 条`,
                ],
              ]}
            />
            <p className="t-field__hint">
              供应商配置（endpoint / API key / 模型）需要单独表单，且密钥只存本机；这一版先只读展示。
            </p>
          </>
        ) : null}

        {section === 'sync' ? (
          <>
            <Section>零知识说明</Section>
            <p className="t-field__hint">
              服务端只保存密文块，密钥不离开本机。代价是服务端无法索引你的数据、忘记主密码也无法找回——
              这是设计取舍，不是缺陷。
            </p>
            <ReadonlyRows
              rows={[
                ['令牌', settings.sync.token ? '已保存（仅本机）' : '未配置'],
                ['后端', settings.sync.endpoint || '未设置'],
              ]}
            />
          </>
        ) : null}
      </div>
    </main>
  )
}
