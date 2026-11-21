// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 补全弹窗的定位计算。
 *
 * 为什么单独抽成纯函数：定位错一次就挡住用户正在敲的那一行，
 * 而这段几何逻辑在真实 xterm 里很难复现（字号 / DPI / 窗口尺寸 / 光标位置组合太多）。
 * 抽出来就能用边界用例直接断言。
 *
 * 两个必须满足的约束：
 * 1. **不遮住光标行**：默认贴在光标行**上方**；上方空间不够才翻到下方。
 *    （旧版固定钉在终端左下角，长命令一多就直接盖住输入区。）
 * 2. **不出面板**：水平方向夹在面板内，垂直方向的高度按可用空间收缩。
 */

export interface Rect {
  left: number
  top: number
  width: number
  height: number
}

export interface CompletionAnchorInput {
  /** 光标单元格坐标（视口内，来自 `term.buffer.active.cursorX/cursorY`） */
  cursor: { x: number; y: number }
  /** 单元格像素尺寸（来自 `.xterm-screen` 的实际尺寸 / cols rows） */
  cell: { width: number; height: number }
  /** 终端屏幕区相对面板的位置（`.xterm-screen` 的 box） */
  screen: Rect
  /** 面板尺寸（弹窗的定位容器） */
  pane: { width: number; height: number }
  /** 期望尺寸（实际会被夹到可用空间内） */
  preferred: { width: number; height: number }
  /** 距面板边缘的最小留白 */
  margin?: number
  /** 弹窗与光标行的间距 */
  gap?: number
  /** 判断"上方放得下"所需的最小高度 */
  minComfortHeight?: number
}

export interface CompletionAnchor {
  /** 定位方式：above 用 bottom，below 用 top */
  placement: 'above' | 'below'
  left: number
  width: number
  maxHeight: number
  top?: number
  bottom?: number
}

const DEFAULT_MARGIN = 8
const DEFAULT_GAP = 6
const DEFAULT_MIN_COMFORT = 168
const MIN_WIDTH = 240
const MIN_HEIGHT = 96

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value))

/**
 * 计算弹窗位置。
 * 入参全是像素值，出参是可直接写进 style 的 `left/top` 或 `left/bottom`。
 */
export function computeCompletionAnchor(input: CompletionAnchorInput): CompletionAnchor {
  const margin = input.margin ?? DEFAULT_MARGIN
  const gap = input.gap ?? DEFAULT_GAP
  const minComfort = input.minComfortHeight ?? DEFAULT_MIN_COMFORT

  const cursorLeft = input.screen.left + input.cursor.x * input.cell.width
  const cursorTop = input.screen.top + input.cursor.y * input.cell.height
  const cursorBottom = cursorTop + input.cell.height

  const availableWidth = Math.max(MIN_WIDTH, input.pane.width - margin * 2)
  const width = clamp(input.preferred.width, MIN_WIDTH, availableWidth)

  const spaceAbove = cursorTop - gap - margin
  const spaceBelow = input.pane.height - cursorBottom - gap - margin

  // 上方够放"比较舒服的高度"就放上方；否则谁空间大放谁（相等时选上方，视觉更稳）
  const placement: 'above' | 'below' =
    spaceAbove >= minComfort ? 'above' : spaceBelow > spaceAbove ? 'below' : 'above'

  const space = placement === 'above' ? spaceAbove : spaceBelow
  const maxHeight = clamp(space, MIN_HEIGHT, Math.max(MIN_HEIGHT, input.preferred.height))

  // 水平：跟随光标左边缘，靠右时整体左移，保证不出面板
  const left = clamp(cursorLeft, margin, Math.max(margin, input.pane.width - width - margin))

  const anchor: CompletionAnchor = { placement, left, width, maxHeight }
  if (placement === 'above') {
    // bottom 从面板底边量起：面板高 - (光标行顶 - 间距)
    anchor.bottom = Math.max(margin, input.pane.height - (cursorTop - gap))
  } else {
    anchor.top = cursorBottom + gap
  }
  return anchor
}
