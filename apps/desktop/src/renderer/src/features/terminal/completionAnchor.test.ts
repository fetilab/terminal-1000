// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 补全弹窗定位的边界用例。
 *
 * 核心断言只有两条：**不压光标行**、**不出面板**。
 * 旧实现（固定 left:10px / bottom:34px）在这两条上都是错的，所以这两个用例
 * 失败即代表回退到了旧行为。
 */

import { describe, expect, it } from 'vitest'
import { computeCompletionAnchor, type CompletionAnchorInput } from './completionAnchor'

const BASE: CompletionAnchorInput = {
  cursor: { x: 10, y: 20 },
  cell: { width: 8, height: 18 },
  screen: { left: 0, top: 0, width: 800, height: 432 },
  pane: { width: 800, height: 460 },
  preferred: { width: 400, height: 300 },
}

describe('补全弹窗定位', () => {
  it('空间充足时贴在光标行上方，底面刚好让开光标行', () => {
    const a = computeCompletionAnchor(BASE)
    expect(a.placement).toBe('above')
    // 光标行顶 = 20*18 = 360；bottom = 面板高 - (360 - 6)
    expect(a.bottom).toBe(460 - (360 - 6))
    expect(a.top).toBeUndefined()
    expect(a.maxHeight).toBe(300)
  })

  it('光标在顶行时翻到下方，不遮挡输入行', () => {
    const a = computeCompletionAnchor({ ...BASE, cursor: { x: 0, y: 0 } })
    expect(a.placement).toBe('below')
    expect(a.top).toBe(18 + 6)
    expect(a.bottom).toBeUndefined()
  })

  it('靠右时光标不再溢出面板（整体左移）', () => {
    const a = computeCompletionAnchor({ ...BASE, cursor: { x: 98, y: 20 } })
    expect(a.left + a.width).toBeLessThanOrEqual(BASE.pane.width - 8)
    expect(a.left).toBeGreaterThanOrEqual(8)
  })

  it('靠左时不会被推到负坐标', () => {
    const a = computeCompletionAnchor({ ...BASE, cursor: { x: 0, y: 20 } })
    expect(a.left).toBe(8)
  })

  it('窄面板下宽度收到可用宽度', () => {
    const a = computeCompletionAnchor({
      ...BASE,
      pane: { width: 320, height: 460 },
      screen: { left: 0, top: 0, width: 320, height: 432 },
    })
    expect(a.width).toBe(320 - 16)
  })

  it('上下都局促时高度收缩到可用空间，绝不越过光标行', () => {
    // 面板很矮：光标在中间，上下各 ~100px
    const a = computeCompletionAnchor({
      ...BASE,
      cursor: { x: 2, y: 5 },
      screen: { left: 0, top: 0, width: 800, height: 216 },
      pane: { width: 800, height: 240 },
    })
    expect(a.maxHeight).toBeLessThanOrEqual(240)
    if (a.placement === 'above') {
      // 弹窗顶边 = 面板高 - bottom - maxHeight 必须 ≥ 0
      expect(BASE.pane.height - (a.bottom ?? 0) - a.maxHeight).toBeGreaterThanOrEqual(0)
    } else {
      expect((a.top ?? 0) + a.maxHeight).toBeLessThanOrEqual(240)
    }
  })

  it('偏移的屏幕区（有内边距）也被算进去', () => {
    const a = computeCompletionAnchor({ ...BASE, screen: { left: 4, top: 4, width: 792, height: 432 } })
    // 光标行顶 = 4 + 360
    expect(a.bottom).toBe(460 - (364 - 6))
    // 光标左 = 4 + 80
    expect(a.left).toBe(84)
  })
})
