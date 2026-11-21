// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 面板之间的拖动分隔条。
 *
 * 交互契约（对齐常见桌面软件的做法，而不是自创）：
 * - 指针按下即捕获，拖动过程中不选中文字、光标固定为 col-resize；
 * - 双击复位为默认宽度；
 * - 键盘可聚焦，←/→ 每次 16px（Home 复位）—— 只用键盘也能调整布局；
 * - 只报告"宽度应该是多少"，具体 clamp 由调用方与 usePaneWidth 负责。
 *
 * `side` 决定拖动方向与宽度的关系：`left` 表示被调宽的面板在分隔条左侧
 * （向右拖变宽），`right` 表示在右侧（向右拖变窄）。
 */

import { useCallback, useRef, useState } from 'react'

export interface SplitterProps {
  /** 被调整的面板当前宽度 */
  size: number
  min: number
  max: number
  onResize: (next: number) => void
  side: 'left' | 'right'
  /** 双击/Home 复位 */
  onReset?: () => void
  /** 可读标签，例如「拖动调整文件栏宽度」 */
  label: string
  /** 紧凑模式（窄至 3px 的视觉，仍保留 9px 热区） */
  thin?: boolean
}

export function Splitter({
  size,
  min,
  max,
  onResize,
  side,
  onReset,
  label,
  thin = false,
}: SplitterProps): React.JSX.Element {
  const [dragging, setDragging] = useState(false)
  const drag = useRef<{ startX: number; startSize: number } | null>(null)
  const clamp = (n: number): number => Math.min(max, Math.max(min, n))

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>): void => {
      if (e.button !== 0) return
      e.preventDefault()
      drag.current = { startX: e.clientX, startSize: size }
      setDragging(true)
      // 拖动期间全局改光标：指针一旦滑出这条 9px 的细缝，光标仍要提示"正在调宽"
      document.documentElement.classList.add('t-resizing')
      const move = (ev: PointerEvent): void => {
        const d = drag.current
        if (!d) return
        const delta = side === 'left' ? ev.clientX - d.startX : d.startX - ev.clientX
        onResize(clamp(d.startSize + delta))
      }
      const end = (): void => {
        drag.current = null
        setDragging(false)
        document.documentElement.classList.remove('t-resizing')
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', end)
        window.removeEventListener('pointercancel', end)
      }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', end)
      window.addEventListener('pointercancel', end)
    },
    [max, min, onResize, side, size],
  )

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    const step = e.shiftKey ? 48 : 16
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault()
      const dir = e.key === 'ArrowRight' ? 1 : -1
      onResize(clamp(size + dir * step * (side === 'left' ? 1 : -1)))
      return
    }
    if (e.key === 'Home' && onReset) {
      e.preventDefault()
      onReset()
    }
  }

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={size}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      title={`${label}（双击复位）`}
      className={`t-splitter${thin ? ' t-splitter--thin' : ''}${dragging ? ' t-splitter--active' : ''}`}
      onPointerDown={onPointerDown}
      onDoubleClick={() => onReset?.()}
      onKeyDown={onKeyDown}
    />
  )
}
