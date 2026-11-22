// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

import { describe, expect, it } from 'vitest'
import { drawGeometricGlyph, isGeometricGlyph } from './atlas'

/**
 * 制表符 / 块元素是**几何绘制**的：这几条断言把「画在哪、画多粗」钉死。
 *
 * 为什么值得单测：这些字符一旦画错，屏幕上就是「横线贯穿文字」「竖线断了」，
 * 而截图只能看到现象、看不到成因。这里用记录 fillRect 的假 ctx 直接比对坐标。
 */

type Rect = [number, number, number, number]

function recorder(): { ctx: CanvasRenderingContext2D; rects: Rect[]; alpha: number[] } {
  const rects: Rect[] = []
  const alpha: number[] = []
  let current = 1
  const ctx = {
    save(): void {},
    restore(): void {
      current = 1
    },
    set fillStyle(_v: string) {},
    get fillStyle(): string {
      return '#fff'
    },
    set globalAlpha(v: number) {
      current = v
    },
    get globalAlpha(): number {
      return current
    },
    fillRect(x: number, y: number, w: number, h: number): void {
      rects.push([x, y, w, h])
      alpha.push(current)
    },
  } as unknown as CanvasRenderingContext2D
  return { ctx, rects, alpha }
}

/** 画一个 7×17 的格子，返回 fillRect 记录 */
function draw(cp: number, w = 7, h = 17, linePx = 1): Rect[] {
  const { ctx, rects } = recorder()
  const ok = drawGeometricGlyph(ctx, cp, 100, 200, w, h, '#fff', linePx)
  expect(ok).toBe(true)
  return rects
}

describe('几何字形：制表符', () => {
  it('横线 ─ 铺满整格、纵向居中', () => {
    expect(draw(0x2500)).toEqual([
      [100, 209, 4, 1],
      [104, 209, 3, 1],
    ])
  })

  it('竖线 │ 铺满整格、横向居中（不能画成横线）', () => {
    // 上/下两段相邻拼接 = 整格通高（两段之间无缝）
    expect(draw(0x2502)).toEqual([
      [104, 200, 1, 9],
      [104, 209, 1, 8],
    ])
  })

  it('左上角 ┌ 是「向右」+「向下」两段', () => {
    expect(draw(0x250c)).toEqual([
      [104, 209, 3, 1],
      [104, 209, 1, 8],
    ])
  })

  it('十字 ┼ 四段都在，且交点不重复填充', () => {
    const rects = draw(0x253c)
    // 左右两段 + 上下两段
    expect(rects).toHaveLength(4)
    expect(rects[0]).toEqual([100, 209, 4, 1])
    expect(rects[1]).toEqual([104, 209, 3, 1])
    expect(rects[2]).toEqual([104, 200, 1, 9])
    expect(rects[3]).toEqual([104, 209, 1, 8])
  })

  it('粗线按 2 倍加粗，双线画两条', () => {
    expect(draw(0x2501)[0]![3]).toBe(2)
    expect(draw(0x2550)).toHaveLength(4)
  })

  it('24px 字号时线宽跟着变粗', () => {
    expect(draw(0x2502, 14, 34, 2)).toEqual([
      [106, 200, 2, 17],
      [106, 217, 2, 17],
    ])
  })
})

describe('几何字形：块与阴影', () => {
  it('全块 █ 正好铺满单元格', () => {
    expect(draw(0x2588)).toEqual([[100, 200, 7, 17]])
  })

  it('上半块 ▀ 只占上半', () => {
    expect(draw(0x2580)).toEqual([[100, 200, 7, 9]])
  })

  it('左 1/8 块 ▏ 只占左边一列', () => {
    expect(draw(0x258f)).toEqual([[100, 200, 1, 17]])
  })

  it('阴影 ▒ 是整格半透明填充', () => {
    const { ctx, rects, alpha } = recorder()
    drawGeometricGlyph(ctx, 0x2592, 0, 0, 7, 17, '#fff', 1)
    expect(rects).toEqual([[0, 0, 7, 17]])
    expect(alpha[0]).toBeCloseTo(0.5, 5)
  })

  it('普通字符不归几何绘制管', () => {
    expect(isGeometricGlyph(0x41)).toBe(false)
    const { ctx } = recorder()
    expect(drawGeometricGlyph(ctx, 0x41, 0, 0, 7, 17, '#fff', 1)).toBe(false)
  })
})
