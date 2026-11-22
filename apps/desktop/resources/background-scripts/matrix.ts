// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors
//
// 动态背景示例：代码雨（Matrix rain）。
// 脚本契约见 docs/background-scripts.md：默认导出 frame(api)，api 里有 2D 上下文与画布尺寸。

const GLYPHS = '01アイウエオカキクケコサシスセソ¥$#@%&+=～'.split('')
const COLUMN_WIDTH = 16
const TRAIL_FADE = 0.08

interface Drop {
  x: number
  y: number
  speed: number
}

let drops: Drop[] = []
let lastW = 0

export default function frame(api: {
  ctx: CanvasRenderingContext2D
  width: number
  height: number
  dt: number
}): void {
  const { ctx, width, height, dt } = api
  const cols = Math.max(1, Math.ceil(width / COLUMN_WIDTH))

  // 画布尺寸变化（窗口拉伸/首次运行）时重布雨滴
  if (cols !== lastW) {
    lastW = cols
    drops = Array.from({ length: cols }, () => ({
      x: Math.floor(Math.random() * cols),
      y: Math.random() * -height,
      speed: 120 + Math.random() * 240,
    }))
  }

  // 半透明黑罩出拖尾；首帧直接铺满
  ctx.fillStyle = `rgba(4, 8, 10, ${dt / TRAIL_FADE + 0.04})`
  ctx.fillRect(0, 0, width, height)

  ctx.font = '13px monospace'
  for (const drop of drops) {
    const glyph = GLYPHS[Math.floor(Math.random() * GLYPHS.length)] ?? '0'
    const px = drop.x * COLUMN_WIDTH
    // 雨头亮、雨尾靠罩子自然衰减
    ctx.fillStyle = 'rgba(140, 235, 180, 0.9)'
    ctx.fillText(glyph, px, drop.y)
    ctx.fillStyle = 'rgba(62, 201, 130, 0.45)'
    ctx.fillText(GLYPHS[Math.floor(Math.random() * GLYPHS.length)] ?? '1', px, drop.y - 14)
    drop.y += drop.speed * dt
    if (drop.y > height + 40 && Math.random() < 0.04) {
      drop.y = Math.random() * -80
      drop.speed = 120 + Math.random() * 240
    }
  }
}
