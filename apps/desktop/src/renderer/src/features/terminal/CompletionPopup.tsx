// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 命令补全弹窗。
 *
 * 纯展示 + 受控选中：键盘事件由 TerminalPane 在捕获阶段处理
 * （必须抢在 xterm 之前拿到 ↑↓/Tab/Esc，否则按键会被送进远端 shell）。
 *
 * 位置固定在终端左下角而不是跟着光标：
 * xterm 没有公开「光标像素坐标」的 API，私有 API 一旦变动就会错位；
 * 左下角锚点在任何 DPI / 字号下都稳。
 */

import type { CompletionCandidate, CompletionKind } from './completion'
import { KIND_LABEL } from './completion'
import { Icon, type IconName } from '../../components/Icon'
import { Badge } from '../../components/Feedback'

const KIND_ICON: Record<CompletionKind, IconName> = {
  command: 'terminal',
  subcommand: 'chevron-right',
  option: 'sliders',
  history: 'clock',
  directory: 'folder',
  argument: 'list',
  ai: 'zap',
}

export interface CompletionPopupProps {
  candidates: CompletionCandidate[]
  selected: number
  onHover: (index: number) => void
  onAccept: (index: number) => void
  /** 主进程给出的耗时，展示出来便于判断是否卡顿 */
  elapsedMs?: number
  specName?: string | null
  aiRequested?: boolean
}

export function CompletionPopup({
  candidates,
  selected,
  onHover,
  onAccept,
  elapsedMs,
  specName,
  aiRequested,
}: CompletionPopupProps): React.JSX.Element | null {
  if (candidates.length === 0) return null

  const current = candidates[Math.min(selected, candidates.length - 1)]
  const list = candidates.slice(0, 12)

  return (
    <div className="completion" role="listbox" aria-label="命令补全候选">
      <div className="completion__head">
        <Icon name="zap" size={12} />
        <span>补全</span>
        {specName ? <Badge tone="outline">{specName}</Badge> : null}
        {aiRequested ? <Badge tone="accent">AI 通道</Badge> : null}
        <span className="completion__count">
          {candidates.length} 项
          {elapsedMs === undefined ? '' : ` · ${elapsedMs} ms`}
        </span>
      </div>

      <div className="completion__list">
        {list.map((c, i) => (
          <button
            key={`${c.value}-${i}`}
            type="button"
            role="option"
            aria-selected={i === selected}
            className={`completion__item${i === selected ? ' completion__item--active' : ''}`}
            onMouseEnter={() => onHover(i)}
            // 用 mousedown 而不是 click：click 前焦点会离开终端，导致后续按键丢失
            onMouseDown={(e) => {
              e.preventDefault()
              onAccept(i)
            }}
          >
            <Icon name={KIND_ICON[c.kind]} size={13} />
            <span className="completion__label">{c.label ?? c.value}</span>
            <span className="completion__kind">{KIND_LABEL[c.kind]}</span>
            {c.description ? <span className="completion__desc">{c.description}</span> : null}
          </button>
        ))}
        {candidates.length > list.length ? (
          <div className="completion__more">还有 {candidates.length - list.length} 项，继续输入以缩小范围</div>
        ) : null}
      </div>

      <div className="completion__preview">
        {current?.description ? (
          <>
            <div className="completion__preview-title">{current.label ?? current.value}</div>
            <div className="completion__preview-body">{current.description}</div>
          </>
        ) : (
          <div className="completion__preview-body completion__preview-body--muted">
            {current ? `${current.label ?? current.value}（无说明）` : ''}
          </div>
        )}
      </div>

      <div className="completion__foot">
        <kbd className="t-kbd">↑</kbd>
        <kbd className="t-kbd">↓</kbd> 选择
        <kbd className="t-kbd">Tab</kbd> 接受
        <kbd className="t-kbd">Esc</kbd> 关闭
      </div>
    </div>
  )
}

export default CompletionPopup
