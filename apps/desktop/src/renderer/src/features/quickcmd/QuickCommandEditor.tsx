// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 快速命令编辑器。
 *
 * 两个 spec 要求在这里落地：
 * - **实时参数标签**：一边写一边用 `analyze` 标出识别到的 `${{参数}}`（蓝）与
 *   动态变量（绿），未闭合的 `${{` 直接标红 —— 不让用户写完才发现没生效；
 * - **变量辅助面板**：列出所有动态变量 + 说明 + 格式 + **当前值预览**（`variables`），
 *   点击插入。机密变量（如 `${{password}}`）后端会打码，但仍标记"有值"。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { Badge, Banner } from '../../components/Feedback'
import { Button, IconButton } from '../../components/Button'
import { Field, Select, TextArea, TextInput } from '../../components/Form'
import { Icon } from '../../components/Icon'
import { Modal } from '../../components/Modal'
import { toast } from '../../components/Toast'
import { errorText } from '../../lib/format'
import { quickcmd } from './quickcmdApi'
import type { AnalyzeResult, QuickCommandRecord, QuickGroupRecord, VariablePreview } from './quickcmdTypes'
import './quickcmd.css'

/** JSX 里写 ${'{'} 这类占位符语法很容易踩转义，统一用常量表达 */
const PARAM_SYNTAX = '$' + '{' + '{' + '参数名' + '}' + '}'
const VAR_SYNTAX = '$' + '{' + '{' + 'date' + '}' + '}'
const OPEN_BRACE2 = '$' + '{' + '{'

export interface QuickCommandEditorProps {
  mode: 'create' | 'edit'
  groupId: string | null
  command?: QuickCommandRecord
  onClose: () => void
  onSaved: () => void | Promise<void>
}

export function QuickCommandEditor({
  mode,
  groupId,
  command,
  onClose,
  onSaved,
}: QuickCommandEditorProps): React.JSX.Element {
  const [name, setName] = useState(command?.name ?? '')
  const [body, setBody] = useState(command?.command ?? '')
  const [note, setNote] = useState(command?.note ?? '')
  const [targetGroup, setTargetGroup] = useState<string>(command?.groupId ?? groupId ?? '')
  const [groups, setGroups] = useState<QuickGroupRecord[]>([])
  const [tags, setTags] = useState<AnalyzeResult | null>(null)
  const [vars, setVars] = useState<VariablePreview[]>([])
  const [showVars, setShowVars] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const areaRef = useRef<HTMLTextAreaElement | null>(null)

  useEffect(() => {
    void quickcmd.listGroups().then((g) => setGroups(g ?? [])).catch(() => setGroups([]))
    void quickcmd.variables().then((v) => setVars(v ?? [])).catch(() => setVars([]))
  }, [])

  // 实时分析：把识别到的占位符标出来（防"写完才发现没生效"）
  useEffect(() => {
    const t = window.setTimeout(() => {
      if (!body.trim()) {
        setTags(null)
        return
      }
      void quickcmd.analyze(body).then(setTags).catch(() => setTags(null))
    }, 250)
    return () => window.clearTimeout(t)
  }, [body])

  /** 在光标处插入片段 */
  const insert = useCallback((snippet: string) => {
    const el = areaRef.current
    if (!el) {
      setBody((b) => b + snippet)
      return
    }
    const start = el.selectionStart
    const end = el.selectionEnd
    setBody((b) => b.slice(0, start) + snippet + b.slice(end))
    requestAnimationFrame(() => {
      el.focus()
      el.selectionStart = el.selectionEnd = start + snippet.length
    })
  }, [])

  const submit = async (): Promise<void> => {
    if (!name.trim()) {
      setErr('命令名称不能为空')
      return
    }
    if (!body.trim()) {
      setErr('命令内容不能为空')
      return
    }
    setSaving(true)
    try {
      await quickcmd.save({
        ...(command ? { id: command.id } : {}),
        groupId: targetGroup === '' ? null : targetGroup,
        name: name.trim(),
        command: body,
        ...(note.trim() ? { note: note.trim() } : {}),
      })
      toast.ok(mode === 'create' ? `已创建「${name.trim()}」` : `已保存「${name.trim()}」`)
      await onSaved()
    } catch (e) {
      setErr(errorText(e))
    } finally {
      setSaving(false)
    }
  }

  const paramNames = tags?.parameterNames ?? []
  const varTags = (tags?.tags ?? []).filter((t) => t.kind === 'variable')
  const lineCount = body.split('\n').filter((l) => l.trim() !== '').length

  return (
    <Modal
      open
      title={mode === 'create' ? '新建快速命令' : `编辑「${command?.name ?? ''}」`}
      subtitle="支持参数占位符与变量占位符（含格式）；动态变量见下方辅助面板"
      onClose={onClose}
      footer={
        <>
          <span className="form-footer-hint">
            {lineCount > 1 ? `${lineCount} 行 —— 执行时逐行发送` : '单行命令'}
          </span>
          <div className="t-modal__footer-spacer" />
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" loading={saving} onClick={() => void submit()}>
            {mode === 'create' ? '创建' : '保存'}
          </Button>
        </>
      }
    >
      <div className="t-grid t-grid--2">
        <Field label="名称" required error={err}>
          <TextInput
            value={name}
            autoFocus
            placeholder="例如：查看磁盘占用"
            onChange={(e) => {
              setName(e.target.value)
              setErr(null)
            }}
          />
        </Field>
        <Field label="分组">
          <Select
            value={targetGroup}
            onChange={(e) => setTargetGroup(e.target.value)}
            options={[
              { value: '', label: '（未分组）' },
              ...groups.map((g) => ({ value: g.id, label: g.name })),
            ]}
          />
        </Field>

        <Field
          label="命令内容"
          required
          className="t-grid__span2"
          hint="多行会在执行时逐行发送；换行即分次输入"
          aside={
            <Button size="sm" variant="ghost" icon="zap" onClick={() => setShowVars((v) => !v)}>
              {showVars ? '收起变量' : '变量辅助'}
            </Button>
          }
        >
          <TextArea
            ref={areaRef}
            className="note-editor__body"
            style={{ minHeight: 130 }}
            value={body}
            mono
            placeholder={'例如：\ncd ${{目录}}\nls -lh'}
            onChange={(e) => setBody(e.target.value)}
          />
        </Field>

        {/* 实时参数标签 */}
        <div className="t-grid__span2">
          <div className="t-field__label" style={{ marginBottom: 5 }}>
            识别到的占位符
            {paramNames.length > 0 ? <Badge tone="accent">{paramNames.length} 个参数</Badge> : null}
            {varTags.length > 0 ? <Badge tone="ok">{varTags.length} 个变量</Badge> : null}
          </div>
          <div className="qc-edit__param-preview">
            {!tags || tags.tags.length === 0 ? (
              <span className="t-field__hint">
                还没有占位符。用 {PARAM_SYNTAX} 表示参数，用 {VAR_SYNTAX} 表示动态变量。
              </span>
            ) : (
              tags.tags.map((t, i) => (
                <span key={`${t.raw}-${i}`} className={`qc-tag qc-tag--${t.kind === 'parameter' ? 'param' : 'var'}`}>
                  {t.kind === 'parameter' ? '参数' : '变量'} {t.name}
                  {t.format ? `:${t.format}` : ''}
                </span>
              ))
            )}
            {tags?.hasUnclosed ? (
              <span className="qc-tag qc-tag--bad">有未闭合的 {OPEN_BRACE2}</span>
            ) : null}
          </div>
        </div>

        {/* 变量辅助面板：带当前值预览 */}
        {showVars ? (
          <div className="t-grid__span2">
            <div className="t-field__label" style={{ marginBottom: 5 }}>
              动态变量（点击插入）
            </div>
            <div className="qc-vars">
              {vars.length === 0 ? (
                <div className="t-field__hint">没有可用变量（变量服务未就绪）。</div>
              ) : (
                vars.map((v) => (
                  <button
                    key={v.name}
                    type="button"
                    className="qc-var"
                    title={`${v.description}${v.format ? ` · 格式 ${v.format}` : ''}`}
                    onClick={() => insert(`\${{${v.name}}}`)}
                  >
                    <span className="qc-var__name">{`\${{${v.name}}}`}</span>
                    <span className="qc-var__desc">{v.description}</span>
                    {/* 当前值预览：机密变量是打码值，但仍标出"有没有值" */}
                    <span className={`qc-var__value${v.hasValue ? '' : ' qc-var__value--none'}`}>
                      {v.hasValue ? v.value : '（当前无值）'}
                    </span>
                    {v.masked ? <Badge tone="warn">已打码</Badge> : null}
                  </button>
                ))
              )}
            </div>
          </div>
        ) : null}

        <Field label="备注" className="t-grid__span2">
          <TextInput value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
      </div>

      {tags?.hasUnclosed ? (
        <div style={{ marginTop: 12 }}>
          <Banner tone="warn">
            命令里有未闭合的 <code className="mono">{OPEN_BRACE2}</code>
            —— 这样的片段不会被当作占位符替换，会原样发送。请补上两个右花括号。
          </Banner>
        </div>
      ) : null}

      <p className="t-field__hint" style={{ marginTop: 12 }}>
        <Icon name="info" size={12} /> 变量在**执行时**才求值（时间、主机名、剪贴板等），
        所以命令里存的是占位符而不是当时的值。
      </p>
    </Modal>
  )
}

export default QuickCommandEditor
