// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 高亮规则编辑器。
 *
 * 规则是**用户自定义正则**，所以这里必须做两件事：
 * 1. 编译失败要当场告诉用户（不能等终端里静默不生效）；
 * 2. 给一个实时预览，用示例文本跑一遍规则，所见即所得。
 *
 * 内置规则（builtin）不可删除 —— 它们由主进程随包提供，
 * 删掉会让默认体验退化；但允许改颜色与优先级。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { HighlightRule } from '@t1000/shared'
import { Button, IconButton } from '../../components/Button'
import { Badge } from '../../components/Feedback'
import { Field, Switch, TextInput } from '../../components/Form'
import { Icon } from '../../components/Icon'
// 与终端共用同一份"命中 → 颜色"映射，保证预览和终端所见一致
import { segmentHighlightStyle } from '../terminal/highlights'

/** 预览用的示例文本：故意包含错误、警告、成功、IP 四类，能同时验证 4 条内置规则 */
const SAMPLE = `2026-11-07 09:12:03 [error] connection to 192.0.2.31 refused
2026-11-07 09:12:04 [warn] retrying in 2s
2026-11-07 09:12:06 [ok] tunnel active (running) on 127.0.0.1
Done. 3 hosts scanned, 1 unreachable`

interface PreviewSeg {
  text: string
  color?: string
  bold?: boolean
}

/** 用启用中的规则切分示例文本。重叠时按 priority 高的先占位。 */
function buildPreview(text: string, rules: HighlightRule[]): PreviewSeg[] {
  const active = rules
    .filter((r) => r.enabled && r.pattern)
    .slice()
    .sort((a, b) => b.priority - a.priority)

  // 每个字符位置记录最先命中的规则（高优先级先写）
  const owner: Array<HighlightRule | undefined> = new Array(text.length)
  for (const rule of active) {
    let re: RegExp
    try {
      // 强制带 g，且不吃掉用户自己的 flags 语义
      const flags = rule.flags?.includes('g') ? rule.flags : `${rule.flags ?? ''}g`
      re = new RegExp(rule.pattern, flags)
    } catch {
      continue
    }
    let guard = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(text)) !== null && guard < 500) {
      guard += 1
      if (m[0].length === 0) {
        re.lastIndex += 1
        continue
      }
      for (let i = m.index; i < m.index + m[0].length; i += 1) {
        if (owner[i] === undefined) owner[i] = rule
      }
    }
  }

  const segs: PreviewSeg[] = []
  let cur: { rule?: HighlightRule; text: string } | null = null
  for (let i = 0; i < text.length; i += 1) {
    const rule = owner[i]
    if (cur && cur.rule === rule) {
      cur.text += text[i]
    } else {
      if (cur) segs.push(toSeg(cur))
      cur = { rule, text: text[i] ?? '' }
    }
  }
  if (cur) segs.push(toSeg(cur))
  return segs
}

function toSeg(part: { rule?: HighlightRule; text: string }): PreviewSeg {
  if (!part.rule) return { text: part.text }
  // 与终端同语义：命中处涂**文字色**（前景优先，仅配了背景色时用它当文字色），不画底色
  const style = segmentHighlightStyle(part.rule)
  return {
    text: part.text,
    ...(style.color ? { color: style.color } : {}),
    ...(part.rule.bold ? { bold: true } : {}),
  }
}

function regexError(pattern: string, flags: string | undefined): string | null {
  if (!pattern.trim()) return '正则不能为空'
  try {
    new RegExp(pattern, flags)
    return null
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
}

export interface HighlightsEditorProps {
  rules: HighlightRule[]
  onChange: (rules: HighlightRule[]) => void
}

export function HighlightsEditor({ rules, onChange }: HighlightsEditorProps): React.JSX.Element {
  const [draft, setDraft] = useState<HighlightRule[]>(rules)
  const dirty = useRef(false)
  const timer = useRef<number | undefined>(undefined)

  useEffect(() => {
    if (!dirty.current) setDraft(rules)
  }, [rules])
  useEffect(() => () => window.clearTimeout(timer.current), [])

  const commitSoon = useCallback(
    (next: HighlightRule[], immediate = false) => {
      setDraft(next)
      dirty.current = true
      window.clearTimeout(timer.current)
      if (immediate) {
        dirty.current = false
        onChange(next)
        return
      }
      timer.current = window.setTimeout(() => {
        dirty.current = false
        onChange(next)
      }, 450)
    },
    [onChange],
  )

  const preview = useMemo(() => buildPreview(SAMPLE, draft), [draft])
  const broken = useMemo(
    () => draft.filter((r) => regexError(r.pattern, r.flags) !== null).map((r) => r.id),
    [draft],
  )

  const patch = (id: string, p: Partial<HighlightRule>, immediate = false): void => {
    commitSoon(draft.map((r) => (r.id === id ? { ...r, ...p } : r)), immediate)
  }

  return (
    <>
      <div className="hl-preview">
        <div className="hl-preview__label">
          <Icon name="eye" size={13} />
          实时预览
          {broken.length > 0 ? <Badge tone="danger">{broken.length} 条正则无效</Badge> : null}
        </div>
        <pre className="hl-preview__text">
          {preview.map((seg, i) => (
            <span
              key={i}
              style={{
                color: seg.color,
                fontWeight: seg.bold ? 700 : undefined,
              }}
            >
              {seg.text}
            </span>
          ))}
        </pre>
        <div className="t-field__hint">
          只对**增量渲染**生效，不会回刷已有历史输出（与原产品一致，避免滚动时重排卡顿）。
        </div>
      </div>

      <div className="hl-list">
        {draft
          .slice()
          .sort((a, b) => b.priority - a.priority)
          .map((rule) => {
            const err = regexError(rule.pattern, rule.flags)
            return (
              <div className="hl-rule" key={rule.id}>
                <div className="hl-rule__head">
                  <Switch
                    checked={rule.enabled}
                    onChange={(v) => patch(rule.id, { enabled: v }, true)}
                    label="启用"
                    bare
                  />
                  <TextInput
                    className="hl-rule__name"
                    value={rule.name}
                    aria-label="规则名称"
                    onChange={(e) => patch(rule.id, { name: e.target.value })}
                  />
                  <TextInput
                    className="hl-rule__flags"
                    value={rule.flags ?? ''}
                    aria-label="正则 flags"
                    mono
                    placeholder="gi"
                    onChange={(e) => patch(rule.id, { flags: e.target.value })}
                  />
                  <TextInput
                    className="hl-rule__priority"
                    type="number"
                    value={String(rule.priority)}
                    aria-label="优先级"
                    mono
                    onChange={(e) =>
                      patch(rule.id, { priority: Number(e.target.value) || 0 })
                    }
                  />
                  <label className="hl-rule__color" title="前景色">
                    <input
                      type="color"
                      value={rule.foreground ?? '#e4e7ee'}
                      onChange={(e) => patch(rule.id, { foreground: e.target.value }, true)}
                    />
                  </label>
                  {rule.builtin ? (
                    <Badge tone="outline" title="内置规则不可删除">
                      内置
                    </Badge>
                  ) : (
                    <IconButton
                      icon="trash"
                      label={`删除规则 ${rule.name}`}
                      tone="danger"
                      onClick={() => commitSoon(draft.filter((r) => r.id !== rule.id), true)}
                    />
                  )}
                </div>
                <Field label="正则" error={err}>
                  <TextInput
                    value={rule.pattern}
                    mono
                    invalid={Boolean(err)}
                    onChange={(e) => patch(rule.id, { pattern: e.target.value })}
                  />
                </Field>
                <Field label="文字颜色（可选）">
                  <div className="t-inputgroup">
                    <TextInput
                      value={rule.background ?? ''}
                      mono
                      placeholder="#2a2f3a 或留空"
                      onChange={(e) =>
                        patch(rule.id, {
                          background: e.target.value.trim() === '' ? undefined : e.target.value,
                        })
                      }
                    />
                    <label className="hl-rule__color">
                      <input
                        type="color"
                        value={rule.background ?? '#2a2f3a'}
                        onChange={(e) => patch(rule.id, { background: e.target.value }, true)}
                      />
                    </label>
                  </div>
                </Field>
              </div>
            )
          })}
      </div>

      <div style={{ marginTop: 14 }}>
        <Button
          variant="outline"
          icon="plus"
          onClick={() =>
            commitSoon(
              [
                ...draft,
                {
                  id: `custom-${Date.now()}`,
                  name: '新规则',
                  pattern: '',
                  flags: 'gi',
                  foreground: '#3ec9d6',
                  priority: 5,
                  enabled: true,
                },
              ],
              true,
            )
          }
        >
          新增规则
        </Button>
      </div>
    </>
  )
}

export default HighlightsEditor
