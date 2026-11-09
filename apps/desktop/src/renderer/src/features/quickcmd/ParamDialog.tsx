// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 参数填写窗。
 *
 * 数据来自 `parameterDialog`：参数名 + **历史预填**（每个参数显示最近用过的值，点一下即可填）。
 * 底部给**渲染预览**（`render` 的结果），这样用户在按"执行"之前就能看到
 * 占位符会被替换成什么、以及哪些参数还缺 —— 而不是发出去才知道。
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Badge, Banner, Loading } from '../../components/Feedback'
import { Button } from '../../components/Button'
import { Field, TextInput } from '../../components/Form'
import { Modal } from '../../components/Modal'
import { toast } from '../../components/Toast'
import { errorText } from '../../lib/format'
import { writeToSession, type TabKind } from '../../lib/store'
import { quickcmd } from './quickcmdApi'
import type { ParameterDialogData, RenderOutcome } from './quickcmdTypes'
import './quickcmd.css'

export interface ParamDialogProps {
  commandId: string
  name: string
  mode: 'execute' | 'paste'
  sessionId: string
  sessionKind: TabKind
  onClose: () => void
  onDone: (message: string) => void | Promise<void>
}

export function ParamDialog({
  commandId,
  name,
  mode,
  sessionId,
  sessionKind,
  onClose,
  onDone,
}: ParamDialogProps): React.JSX.Element {
  const [data, setData] = useState<ParameterDialogData | null>(null)
  const [values, setValues] = useState<Record<string, string>>({})
  const [preview, setPreview] = useState<RenderOutcome | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    void (async () => {
      try {
        const d = await quickcmd.parameterDialog({ commandId })
        setData(d)
        // 历史预填：优先"最近值"
        setValues({ ...(d.recentValues ?? {}) })
      } catch (e) {
        setErr(errorText(e))
      }
    })()
  }, [commandId])

  // 参数一变就重算预览（让用户按执行前就看到最终命令）
  useEffect(() => {
    void quickcmd
      .render({ commandId, params: values })
      .then(setPreview)
      .catch(() => setPreview(null))
  }, [commandId, values])

  const missing = useMemo(
    () => (preview?.missingParams ?? data?.parameters ?? []).filter((p) => !values[p]?.trim()),
    [preview, data, values],
  )

  const confirm = useCallback(async () => {
    if (missing.length > 0) {
      toast.warn(`还有 ${missing.length} 个参数没填：${missing.join('、')}`)
      return
    }
    setBusy(true)
    try {
      if (mode === 'execute') {
        const res = await quickcmd.execute({ sessionId, commandId, params: values })
        await onDone(`已发送「${name}」：${res?.sent ?? 0} 行（逐行发送）`)
      } else {
        const res = await quickcmd.paste({ commandId, params: values })
        // "粘贴到输入框"：送进终端但不回车，用户可以改完再执行
        await writeToSession(sessionKind, sessionId, res?.text ?? '')
        await onDone(`已粘贴到终端输入框（未执行）：「${name}」`)
      }
    } catch (e) {
      setErr(errorText(e))
    } finally {
      setBusy(false)
    }
  }, [missing, mode, sessionId, commandId, values, name, sessionKind, onDone])

  return (
    <Modal
      open
      size="md"
      title={`填写参数 · ${name}`}
      subtitle={mode === 'execute' ? '填完后逐行发送到当前会话' : '填完后只粘贴到输入框，不会执行'}
      onClose={onClose}
      footer={
        <>
          {missing.length > 0 ? (
            <span className="t-field__error">还缺 {missing.join('、')}</span>
          ) : (
            <span className="form-footer-hint">
              {preview?.lines.length ?? 0} 行
            </span>
          )}
          <div className="t-modal__footer-spacer" />
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" loading={busy} disabled={missing.length > 0} onClick={() => void confirm()}>
            {mode === 'execute' ? '发送' : '粘贴'}
          </Button>
        </>
      }
    >
      {err ? (
        <div style={{ marginBottom: 12 }}>
          <Banner tone="error">{err}</Banner>
        </div>
      ) : null}

      {!data ? (
        <Loading text="读取参数…" />
      ) : data.parameters.length === 0 ? (
        <p className="t-field__hint">这条命令没有参数，直接执行即可。</p>
      ) : (
        <div className="t-grid">
          {data.parameters.map((p) => {
            const history = data.history?.[p] ?? []
            return (
              <div key={p}>
                <div className="qc-param-row">
                  <span className="qc-param-row__name">{`\${{${p}}}`}</span>
                  <Field label="" hint="">
                    <TextInput
                      value={values[p] ?? ''}
                      autoFocus={p === data.parameters[0]}
                      placeholder={data.recentValues?.[p] ? `上次：${data.recentValues[p]}` : `填写 ${p}`}
                      onChange={(e) => setValues((v) => ({ ...v, [p]: e.target.value }))}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && missing.length === 0) void confirm()
                      }}
                    />
                  </Field>
                </div>
                {history.length > 0 ? (
                  <div className="qc-param-history">
                    <span className="t-field__hint">历史：</span>
                    {history.slice(0, 6).map((h) => (
                      <button key={h} type="button" onClick={() => setValues((v) => ({ ...v, [p]: h }))}>
                        {h}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            )
          })}
        </div>
      )}

      {preview ? (
        <>
          <div className="t-field__label" style={{ marginTop: 16, marginBottom: 5 }}>
            渲染预览
            {preview.variables.length > 0 ? (
              <Badge tone="ok">{preview.variables.length} 个变量已求值</Badge>
            ) : null}
            {preview.lines.length > 1 ? <Badge tone="accent">{preview.lines.length} 行</Badge> : null}
          </div>
          <pre className="qc-preview">{preview.text || '（空）'}</pre>
          {preview.variables.some((v) => v.masked) ? (
            <p className="t-field__hint">
              预览里的机密变量（如 password）是打码后的显示值；**实际发送时会用真实值**。
            </p>
          ) : null}
        </>
      ) : null}
    </Modal>
  )
}

export default ParamDialog
