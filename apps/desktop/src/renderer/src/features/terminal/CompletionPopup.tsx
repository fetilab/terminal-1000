// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 命令补全弹窗。
 *
 * 纯展示 + 受控选中：键盘事件由 TerminalPane 在捕获阶段处理
 * （必须抢在 xterm 之前拿到 ↑↓/Tab/Esc，否则按键会被送进远端 shell）。
 *
 * 位置来自 `computeCompletionAnchor()`：**贴着光标行上方**，上方放不下才翻到下方。
 * 早期版本把弹窗钉在终端左下角（`left:10px; bottom:34px`），长命令行一多就直接
 * 盖住正在输入的那一行 —— 那是实打实的可用性 bug，不是审美问题。
 */

import type { CompletionCandidate, CompletionKind } from './completion'
import { KIND_LABEL } from './completion'
import type { CompletionAnchor } from './completionAnchor'
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

/** 一屏最多展示多少条：再多用户也看不过来，纯属撑大弹窗 */
const MAX_ROWS = 8

export interface CompletionPopupProps {
  candidates: CompletionCandidate[]
  selected: number
  onHover: (index: number) => void
  onAccept: (index: number) => void
  /** 主进程给出的耗时，展示出来便于判断是否卡顿 */
  elapsedMs?: number
  specName?: string | null
  aiRequested?: boolean
  /** 光标锚点；缺省时退化为容器内居中（仅测试/降级路径会走到） */
  anchor?: CompletionAnchor | null
}

export function CompletionPopup({
  candidates,
  selected,
  onHover,
  onAccept,
  elapsedMs,
  specName,
  aiRequested,
  anchor,
}: CompletionPopupProps): React.JSX.Element | null {
  if (candidates.length === 0) return null

  const current = candidates[Math.min(selected, candidates.length - 1)]
  const list = candidates.slice(0, MAX_ROWS)
  const style: React.CSSProperties = anchor
    ? {
        left: anchor.left,
        width: anchor.width,
        maxHeight: anchor.maxHeight,
        ...(anchor.placement === 'above' ? { bottom: anchor.bottom } : { top: anchor.top }),
      }
    : {}

  return (
    <div
      className="completion"
      role="listbox"
      aria-label="命令补全候选"
      data-placement={anchor?.placement ?? 'float'}
      style={style}
    >
      <div className="completion__head">
        <Icon name="zap" size={12} />
        <span>补全</span>
        {specName ? <Badge tone="outline">{specName}</Badge> : null}
        {aiRequested ? <Badge tone="accent">AI</Badge> : null}
        <span className="completion__count">
          {candidates.length} 项
          {elapsedMs === undefined ? '' : ` · ${Math.round(elapsedMs)}ms`}
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
            <Icon name={KIND_ICON[c.kind]} size={12} />
            <span className="completion__label">{c.label ?? c.value}</span>
            <span className="completion__kind">{KIND_LABEL[c.kind]}</span>
            {c.description ? <span className="completion__desc">{c.description}</span> : null}
          </button>
        ))}
        {candidates.length > list.length ? (
          <div className="completion__more">还有 {candidates.length - list.length} 项，继续输入以缩小范围</div>
        ) : null}
      </div>

      {current?.description ? (
        <div className="completion__preview">
          <div className="completion__preview-title">{current.label ?? current.value}</div>
          <div className="completion__preview-body">{current.description}</div>
        </div>
      ) : null}

      <div className="completion__foot">
        <kbd className="t-kbd">↑</kbd>
        <kbd className="t-kbd">↓</kbd>
        <kbd className="t-kbd">Tab</kbd>
        <kbd className="t-kbd">Esc</kbd>
        <span>选择 / 接受 / 关闭</span>
      </div>
    </div>
  )
}

export default CompletionPopup
