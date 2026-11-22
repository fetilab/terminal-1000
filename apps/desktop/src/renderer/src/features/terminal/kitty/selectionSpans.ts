// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 选区的**可视色块**计算（纯函数，可在主线程 / Worker / 单测里复用）。
 *
 * 内核（kitty-vt-wasm）负责「选了哪些字」，`selectionText()` 才是权威；
 * 这里只回答「色块画在哪几行、每行哪几列」。
 *
 * 规则逐条照抄 kitty `screen.c` 的 `iteration_data()`，包括那两个容易写错的细节：
 *
 * 1. 端点不是格坐标，是「格 + 格内左/右半」（`in_left_half_of_cell`）。
 *    起点在右半格 → 起始列 +1；终点在左半格 → 结束列 −1。
 * 2. **空选区的判据**：起点与终点同格同半格时是空的（`is_selection_empty()`），
 *    一格都不画。所以「按下鼠标还没拖」时屏幕上不该出现任何色块 ——
 *    这正是之前「一按就有个光标似的东西、还消不掉」的根因。
 */

import type { KittySelectionSpan } from '@t1000/shared'

export interface SelectionPoint {
  x: number
  y: number
  /** 指针位于格子左半（kitty 的 in_left_half_of_cell） */
  half: boolean
}

export interface SelectionInput {
  anchor: SelectionPoint | null
  cursor: SelectionPoint | null
  /** 矩形选择（kitty 的 ctrl+alt+左键） */
  rectangle: boolean
  columns: number
  rows: number
}

/** kitty `is_selection_empty()` 的等价判定 */
export function isSelectionEmpty(a: SelectionPoint, b: SelectionPoint): boolean {
  return a.x === b.x && a.y === b.y && a.half === b.half
}

const startShift = (p: SelectionPoint): number => (p.half ? 0 : 1)
const endShift = (p: SelectionPoint): number => (p.half ? -1 : 0)

export function computeSelectionSpans(input: SelectionInput): KittySelectionSpan[] | null {
  const { anchor: a, cursor: b, rectangle, columns: cols, rows } = input
  if (!a || !b) return null
  if (isSelectionEmpty(a, b)) return null

  const spans: KittySelectionSpan[] = []
  const push = (y: number, x1: number, x2: number): void => {
    if (y < 0 || y >= rows) return
    const lo = Math.max(0, Math.min(cols - 1, x1))
    const hi = Math.max(0, Math.min(cols - 1, x2))
    if (hi < lo) return
    spans.push({ y, x1: lo, x2: hi })
  }

  const y1 = Math.min(a.y, b.y)
  const y2 = Math.max(a.y, b.y)

  if (rectangle) {
    // 矩形状态下同格只有「起点左半 + 终点右半」才算一格，其余为空
    if (a.x === b.x && (!a.half || b.half)) return null
    let x1: number
    let x2: number
    if (a.x === b.x) {
      x1 = a.x
      x2 = a.x
    } else {
      const leftToRight = a.x < b.x
      const s = leftToRight ? a : b
      const e = leftToRight ? b : a
      x1 = s.x + startShift(s)
      x2 = e.x + endShift(e)
    }
    for (let y = y1; y <= y2; y += 1) push(y, x1, x2)
    return spans.length > 0 ? spans : null
  }

  if (y1 === y2) {
    // 单行：同格时只有 左半→右半 这一种非空情况（选中那一格）
    if (a.x === b.x) {
      if (a.half && !b.half) push(y1, a.x, a.x)
      return spans.length > 0 ? spans : null
    }
    const leftToRight = a.x < b.x
    const s = leftToRight ? a : b
    const e = leftToRight ? b : a
    push(y1, s.x + startShift(s), e.x + endShift(e))
    return spans.length > 0 ? spans : null
  }

  // 多行：首行从边界涂到行尾、末行从行首涂到边界、中间整行
  const forward = a.y <= b.y
  const top = forward ? a : b
  const bottom = forward ? b : a
  push(y1, top.x + startShift(top), cols - 1)
  for (let y = y1 + 1; y < y2; y += 1) push(y, 0, cols - 1)
  push(y2, 0, bottom.x + endShift(bottom))
  return spans.length > 0 ? spans : null
}
