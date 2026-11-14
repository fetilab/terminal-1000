// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 改权限对话框（单目标与批量共用）。
 *
 * spec 明确要求两件容易被忽略的事，这里都做了：
 * 1. **预备执行命令区域** —— 执行前调主进程 `sftp.previewChmod`（只算不改），
 *    把 `summary` 与 `commands` 摆出来；条目/命令被截断时**如实说明**。
 * 2. **危险提示必须显著** —— 递归 + 权限不含 x 位时，目录会变得**进不去**
 *    （lead 真机验证时踩过：`chmod -R 600` 之后连 `stat` 子文件都 EACCES），
 *    所以这里用红色告警而不是灰字。
 *
 * 递归勾选框只在有目录时出现，且**默认不勾**（保守）。
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { Badge, Banner } from '../../components/Feedback'
import { Button } from '../../components/Button'
import { Checkbox, Field, TextInput } from '../../components/Form'
import { Modal } from '../../components/Modal'
import { octalToMode, type ChmodPlanResult, type RemoteEntry } from './sftpTypes'

/** 明细命令的展示上限（主进程每个目标最多给 50 条，多目标时这里是合计上限） */
const MAX_SHOWN_COMMANDS = 50

/**
 * 主进程的警告/说明文案里带 `**强调**`（Markdown 风格）。
 * 直接当纯文本渲染会让用户看到裸星号（第一版就出现了），这里只把 `**` 转成加粗，
 * 不解析其它 Markdown，也不注入 HTML。
 */
function withEmphasis(text: string): React.ReactNode {
  return text.split('**').map((part, i) =>
    i % 2 === 1 ? <strong key={i}>{part}</strong> : <span key={i}>{part}</span>,
  )
}

export interface ChmodDialogProps {
  open: boolean
  /** 目标：单文件/单目录，或批量选中的多项 */
  targets: RemoteEntry[]
  /** 单目标时的初始权限（批量留空） */
  initialMode?: string
  /** 调主进程 `sftp.previewChmod`（只算不改） */
  preview: (path: string, mode: number, recursive: boolean) => Promise<ChmodPlanResult>
  onRun: (mode: number, recursive: boolean) => void
  onClose: () => void
}

export function ChmodDialog({
  open,
  targets,
  initialMode,
  preview,
  onRun,
  onClose,
}: ChmodDialogProps): React.JSX.Element {
  const [modeText, setModeText] = useState(initialMode ?? '')
  const [recursive, setRecursive] = useState(false)
  const [plans, setPlans] = useState<ChmodPlanResult[]>([])
  const [planning, setPlanning] = useState(false)
  const [planError, setPlanError] = useState<string | null>(null)
  const seq = useRef(0)

  const hasDir = targets.some((t) => t.type === 'directory')
  const mode = octalToMode(modeText)

  // 打开时重置：权限来自当前目标，递归回到"不勾"（保守默认）
  useEffect(() => {
    if (!open) return
    setModeText(initialMode ?? '')
    setRecursive(false)
    setPlans([])
    setPlanError(null)
  }, [open, initialMode])

  // 预备预览：模式/递归变化时重新计算（只算不改）
  useEffect(() => {
    if (!open || mode === undefined || targets.length === 0) {
      setPlans([])
      return
    }
    const mySeq = ++seq.current
    setPlanning(true)
    setPlanError(null)
    void (async () => {
      try {
        const next: ChmodPlanResult[] = []
        for (const t of targets) {
          next.push(await preview(t.path, mode, recursive))
        }
        if (mySeq !== seq.current) return
        setPlans(next)
      } catch (err) {
        if (mySeq !== seq.current) return
        setPlanError(err instanceof Error ? err.message : String(err))
        setPlans([])
      } finally {
        if (mySeq === seq.current) setPlanning(false)
      }
    })()
  }, [open, mode, recursive, targets, preview])

  const aggregate = useMemo(() => {
    const entries = plans.reduce((n, p) => n + p.entries.length, 0)
    const truncated = plans.some((p) => p.truncated)
    const warnings = [...new Set(plans.map((p) => p.warning).filter((w): w is string => Boolean(w)))]
    const commands: string[] = []
    for (const p of plans) {
      for (const c of p.commands) {
        if (commands.length >= MAX_SHOWN_COMMANDS) break
        commands.push(c)
      }
    }
    const totalCommands = plans.reduce((n, p) => n + p.entries.length, 0)
    return { entries, truncated, warnings, commands, totalCommands }
  }, [plans])

  const title = targets.length === 1 ? `修改权限 · ${targets[0]?.name ?? ''}` : `批量改权限（${targets.length} 项）`

  return (
    <Modal
      open={open}
      title={title}
      onClose={onClose}
      footer={
        <>
          <div className="t-modal__footer-spacer" />
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button
            variant="primary"
            data-testid="chmod-run"
            disabled={mode === undefined}
            onClick={() => {
              if (mode === undefined) return
              onRun(mode, recursive)
            }}
          >
            {/* 递归时把影响面写进按钮，避免"手一抖改了一棵树" */}
            {recursive ? `递归执行${aggregate.entries > 0 ? `（${aggregate.entries} 项）` : ''}` : '执行'}
          </Button>
        </>
      }
    >
      <div className="t-grid">
        <Field label="八进制权限（如 644 / 755）" required>
          <TextInput
            mono
            autoFocus
            data-testid="chmod-mode"
            value={modeText}
            placeholder="644 / 755"
            onChange={(e) => setModeText(e.target.value)}
          />
        </Field>

        {hasDir ? (
          // Checkbox 的 props 是封闭接口（不转发 data-*），所以把锚点放在外层容器上；
          // 勾选框本身是 label 里的隐藏 input，程序化点击 input 即可触发 onChange。
          <div data-testid="chmod-recursive">
            <Checkbox
              checked={recursive}
              onChange={setRecursive}
              label="递归应用到目录内的所有内容（等价 chmod -R）"
            />
          </div>
        ) : null}

        {/* ── 危险提示：必须显著 ── */}
        {aggregate.warnings.map((w) => (
          <Banner key={w} tone="error">
            <span data-testid="chmod-warning">⚠ 危险：{withEmphasis(w)}</span>
          </Banner>
        ))}

        {/* ── 预备执行命令区域（spec 要求） ── */}
        <Field
          label="预备执行命令"
          hint={
            <>
              执行前先算清楚会动哪些路径。
              {recursive ? '符号链接不跟随（与 chmod -R 一致），链接自身会被改；根目录上不允许递归。' : ''}
            </>
          }
          aside={planning ? <Badge tone="outline">计算中…</Badge> : null}
        >
          {planError ? (
            <span className="t-field__hint" data-testid="chmod-plan-error">
              预览失败：{planError}（可仍然执行，结果会逐项报告）
            </span>
          ) : plans.length === 0 ? (
            <span className="t-field__hint" data-testid="chmod-plan-empty">
              {mode === undefined ? '填入合法权限后显示将要执行的命令' : '正在计算…'}
            </span>
          ) : (
            <div className="sftp-chmod__plan" data-testid="chmod-plan">
              {plans.map((p, i) => (
                <div key={targets[i]?.path ?? i} className="sftp-chmod__plan-row">
                  <code className="mono" data-testid="chmod-plan-summary">
                    {p.summary}
                  </code>
                  <span className="sftp-chmod__count">{p.entries.length} 项</span>
                </div>
              ))}
              {aggregate.truncated ? (
                <span className="sftp-chmod__truncated" data-testid="chmod-plan-truncated">
                  ⚠ 条目数超过主进程上限（5000），已截断 —— <b>执行时也只会处理已列出的部分</b>。
                </span>
              ) : null}
              <details className="sftp-chmod__details" data-testid="chmod-commands">
                <summary>
                  命令明细（显示 {aggregate.commands.length} / {aggregate.totalCommands} 条）
                </summary>
                <ul>
                  {aggregate.commands.map((c) => (
                    <li key={c}>
                      <code className="mono">{c}</code>
                    </li>
                  ))}
                </ul>
                {aggregate.totalCommands > aggregate.commands.length ? (
                  <span className="t-field__hint">
                    共 {aggregate.totalCommands} 项，此处显示前 {aggregate.commands.length} 条
                  </span>
                ) : null}
              </details>
            </div>
          )}
        </Field>

        <span className="t-field__hint" data-testid="chmod-impact">
          将影响 {aggregate.entries > 0 ? aggregate.entries : targets.length} 项
          {targets.length > 1 ? `（${targets.length} 个目标）` : ''}
        </span>
      </div>
    </Modal>
  )
}
