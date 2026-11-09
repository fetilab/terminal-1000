// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 工具视图。
 *
 * 目前只有一个**完全本地、无后端依赖**的工具：密码/密钥生成器。
 * 它是刻意挑的——不需要任何主进程服务，所以能立刻可用，
 * 也让「工具」这个入口不是个空壳。命令手册与 AI 助手需要各自的语料/供应商配置，
 * 等对应服务上线后再挂进来。
 */

import { useMemo, useState } from 'react'
import { Button, IconButton } from '../../components/Button'
import { Badge, EmptyState } from '../../components/Feedback'
import { Field, Switch, TextInput } from '../../components/Form'
import { Icon, type IconName } from '../../components/Icon'
import { toast } from '../../components/Toast'
import { actions, useStoreShallow } from '../../lib/store'
import { CommandManual } from './CommandManual'
import './tools.css'

type ToolId = 'password' | 'manual'

interface ToolEntry {
  id: ToolId
  label: string
  icon: IconName
  blurb: string
}

const TOOLS: ToolEntry[] = [
  { id: 'password', label: '密码生成器', icon: 'key', blurb: '本机生成，不落盘不联网' },
  { id: 'manual', label: '命令手册', icon: 'list', blurb: '离线命令速查（214 条 / 9 类）' },
]

/* ── 密码生成器 ─────────────────────────────────── */

const CHARSETS = {
  lower: 'abcdefghijkmnopqrstuvwxyz',
  upper: 'ABCDEFGHJKLMNPQRSTUVWXYZ',
  digit: '23456789',
  symbol: '!@#$%^&*()-_=+[]{};:,.?',
} as const

const AMBIGUOUS = /[Il1O0o]/g

function randomInt(max: number): number {
  // 拒绝采样，消除取模偏差
  const limit = Math.floor(0xffffffff / max) * max
  const buf = new Uint32Array(1)
  for (;;) {
    crypto.getRandomValues(buf)
    const v = buf[0] ?? 0
    if (v < limit) return v % max
  }
}

function generate(length: number, pool: string, excludeAmbiguous: boolean): string {
  const charset = excludeAmbiguous ? pool.replace(AMBIGUOUS, '') : pool
  if (charset.length === 0) return ''
  let out = ''
  for (let i = 0; i < length; i += 1) out += charset[randomInt(charset.length)]
  return out
}

/** 熵 = length × log2(charsetSize)，单位 bit */
function entropyBits(length: number, poolSize: number): number {
  return poolSize <= 1 ? 0 : Math.round(length * Math.log2(poolSize))
}

function PasswordTool(): React.JSX.Element {
  const [length, setLength] = useState(20)
  const [useLower, setUseLower] = useState(true)
  const [useUpper, setUseUpper] = useState(true)
  const [useDigit, setUseDigit] = useState(true)
  const [useSymbol, setUseSymbol] = useState(true)
  const [excludeAmbiguous, setExcludeAmbiguous] = useState(true)
  const [nonce, setNonce] = useState(0)

  const pool = useMemo(() => {
    let p = ''
    if (useLower) p += CHARSETS.lower
    if (useUpper) p += CHARSETS.upper
    if (useDigit) p += CHARSETS.digit
    if (useSymbol) p += CHARSETS.symbol
    return excludeAmbiguous ? p.replace(AMBIGUOUS, '') : p
  }, [useLower, useUpper, useDigit, useSymbol, excludeAmbiguous])

  const value = useMemo(
    () => generate(Math.max(4, Math.min(128, length)), pool, excludeAmbiguous),
    // nonce 是「重新生成」的触发器
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [length, pool, excludeAmbiguous, nonce],
  )

  const bits = entropyBits(length, pool.length)
  const strength = bits >= 128 ? '很强' : bits >= 90 ? '强' : bits >= 60 ? '中等' : '偏弱'
  const tone = bits >= 90 ? 'ok' : bits >= 60 ? 'warn' : 'danger'

  return (
    <div className="t-grid" style={{ maxWidth: 620 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '12px 14px',
          border: '1px solid var(--t1000-border-strong)',
          borderRadius: 'var(--t1000-radius)',
          background: 'var(--t1000-bg-input)',
        }}
      >
        <code
          className="mono"
          style={{ flex: 1, minWidth: 0, wordBreak: 'break-all', fontSize: 14, lineHeight: 1.6 }}
        >
          {value || '—'}
        </code>
        <IconButton icon="refresh" label="重新生成" onClick={() => setNonce((n) => n + 1)} />
        <IconButton
          icon="copy"
          label="复制"
          onClick={() => {
            if (!value) return
            void navigator.clipboard.writeText(value).then(() => toast.ok('已复制到剪贴板'))
          }}
        />
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <Badge tone={tone}>{strength}</Badge>
        <span className="metric__sub">熵 ≈ {bits} bit · 字符集 {pool.length} 个</span>
      </div>

      <Field label={`长度：${length}`}>
        <input
          type="range"
          min={8}
          max={64}
          value={length}
          aria-label="密码长度"
          onChange={(e) => setLength(Number(e.target.value))}
          style={{ width: '100%', accentColor: 'var(--t1000-accent)' }}
        />
      </Field>

      <div className="t-grid t-grid--2" style={{ gap: 10 }}>
        <Switch checked={useLower} onChange={setUseLower} label="小写字母" />
        <Switch checked={useUpper} onChange={setUseUpper} label="大写字母" />
        <Switch checked={useDigit} onChange={setUseDigit} label="数字" />
        <Switch checked={useSymbol} onChange={setUseSymbol} label="符号" />
        <Switch
          checked={excludeAmbiguous}
          onChange={setExcludeAmbiguous}
          label="排除易混淆字符 (I l 1 O 0 o)"
        />
      </div>

      <p className="t-field__hint" style={{ margin: 0 }}>
        生成过程完全在本机用 <code className="mono">crypto.getRandomValues</code> 完成，
        不落盘、不发网络请求。
      </p>
    </div>
  )
}

/* ── 视图 ───────────────────────────────────────── */

export function ToolsSidebar(): React.JSX.Element {
  const section = useStoreShallow((s) => ({ section: s.toolsSection })).section
  return (
    <aside className="panel" aria-label="工具">
      <header className="panel-header">
        <span className="panel-title">工具</span>
      </header>
      <div className="panel-body">
        <nav className="sessions">
          {TOOLS.map((tool) => (
            <button
              key={tool.id}
              type="button"
              className={`settings-nav${tool.id === section ? ' settings-nav--active' : ''}`}
              aria-current={tool.id === section || undefined}
              onClick={() => actions.setToolsSection(tool.id)}
            >
              <Icon name={tool.icon} size={14} />
              <span className="settings-nav__body">
                <span className="settings-nav__title">{tool.label}</span>
                <span className="settings-nav__desc">{tool.blurb}</span>
              </span>
            </button>
          ))}
        </nav>
      </div>
      <div className="panel-footer">
        <span className="form-footer-hint">
          AI 助手与命令手册已各自成页（左侧导航「AI 助手」）
        </span>
      </div>
    </aside>
  )
}

export default function ToolsView(): React.JSX.Element {
  const section = useStoreShallow((s) => ({ section: s.toolsSection })).section

  // 命令手册自带完整工具栏与左右分栏，所以单独成块、不套外层 content-scroll
  if (section === 'manual') {
    return (
      <main className="content" aria-label="命令手册">
        <CommandManual />
      </main>
    )
  }

  return (
    <main className="content" aria-label="工具">
      <div className="t-toolbar">
        <Icon name="key" size={15} />
        <span className="panel-title">密码生成器</span>
        <div className="t-toolbar__spacer" />
        <Button size="sm" variant="ghost" icon="connections" onClick={() => actions.setView('connections')}>
          返回连接中心
        </Button>
      </div>
      <div className="content-scroll" style={{ padding: 18 }}>
        <PasswordTool />
      </div>
    </main>
  )
}

