// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

import { describe, expect, it } from 'vitest'
import { computeSelectionSpans, isSelectionEmpty, type SelectionPoint } from './selectionSpans'

const p = (x: number, y: number, half = true): SelectionPoint => ({ x, y, half })
const spans = (a: SelectionPoint | null, b: SelectionPoint | null, extra: Partial<{ rectangle: boolean; columns: number; rows: number }> = {}) =>
  computeSelectionSpans({ anchor: a, cursor: b, rectangle: false, columns: 10, rows: 5, ...extra })

describe('selectionSpans（kitty iteration_data 的等价实现）', () => {
  it('没有选区时返回 null', () => {
    expect(spans(null, null)).toBeNull()
    expect(spans(p(1, 1), null)).toBeNull()
  })

  it('按下还没拖动 → 空选区，一个色块都不画', () => {
    // 这条是回归点：早先这里会画出一格，"一按鼠标就出现一个消不掉的色块"
    expect(isSelectionEmpty(p(3, 2), p(3, 2))).toBe(true)
    expect(spans(p(3, 2), p(3, 2))).toBeNull()
  })

  it('同一格里从左半拖到右半 → 选中这一格', () => {
    expect(spans(p(3, 2, true), p(3, 2, false))).toEqual([{ y: 2, x1: 3, x2: 3 }])
  })

  it('同一格里从右半到左半 → 空（kitty 的语义）', () => {
    expect(spans(p(3, 2, false), p(3, 2, true))).toBeNull()
  })

  it('单行从左往右：两端都在左半 → 两端都包含', () => {
    expect(spans(p(2, 1, true), p(5, 1, true))).toEqual([{ y: 1, x1: 2, x2: 4 }])
  })

  it('单行从左往右：起点右半 + 终点右半 → 两侧各收一格', () => {
    expect(spans(p(2, 1, false), p(5, 1, false))).toEqual([{ y: 1, x1: 3, x2: 5 }])
  })

  it('从右往左拖（反向）→ 区间仍然正确', () => {
    expect(spans(p(6, 1, false), p(2, 1, true))).toEqual([{ y: 1, x1: 2, x2: 6 }])
  })

  it('多行向下：首行涂到行尾、中间整行、末行从行首到终点', () => {
    expect(spans(p(3, 1, true), p(4, 3, false))).toEqual([
      { y: 1, x1: 3, x2: 9 },
      { y: 2, x1: 0, x2: 9 },
      { y: 3, x1: 0, x2: 4 },
    ])
  })

  it('多行向上：方向反了但结果一致', () => {
    expect(spans(p(4, 3, false), p(3, 1, true))).toEqual([
      { y: 1, x1: 3, x2: 9 },
      { y: 2, x1: 0, x2: 9 },
      { y: 3, x1: 0, x2: 4 },
    ])
  })

  it('矩形选择：每行都是同一列区间', () => {
    expect(spans(p(2, 1, true), p(5, 3, false), { rectangle: true })).toEqual([
      { y: 1, x1: 2, x2: 5 },
      { y: 2, x1: 2, x2: 5 },
      { y: 3, x1: 2, x2: 5 },
    ])
  })

  it('矩形选择同格：只有「起点左半 → 终点右半」算一格', () => {
    expect(spans(p(4, 1, true), p(4, 1, false), { rectangle: true })).toEqual([{ y: 1, x1: 4, x2: 4 }])
    expect(spans(p(4, 1, false), p(4, 1, true), { rectangle: true })).toBeNull()
  })

  it('越界的列按边界收拢', () => {
    expect(spans(p(0, 0, true), p(9, 0, false))).toEqual([{ y: 0, x1: 0, x2: 9 }])
  })
})
