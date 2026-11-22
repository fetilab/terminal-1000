// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors
//
// 动态背景示例：下雪。随机雪片带横漂与近大远小，鼠标不动也有微风的「呼吸感」。

interface Flake {
  x: number
  y: number
  r: number
  vy: number
  drift: number
  phase: number
}

let flakes: Flake[] = []
let seededFor = 0

export default function frame(api: {
  ctx: CanvasRenderingContext2D
  width: number
  height: number
  dt: number
  time: number
}): void {
  const { ctx, width, height, dt, time } = api

  // 密度按面积算，窗口变化时重新播种
  const want = Math.round((width * height) / 26000)
  if (want !== seededFor) {
    seededFor = want
    flakes = Array.from({ length: want }, () => ({
      x: Math.random() * width,
      y: Math.random() * height,
      r: 1 + Math.random() * 2.6,
      vy: 26 + Math.random() * 70,
      drift: 8 + Math.random() * 26,
      phase: Math.random() * Math.PI * 2,
    }))
  }

  ctx.clearRect(0, 0, width, height)
  for (const f of flakes) {
    // 横向正弦漂移 + 微风
    f.x += (Math.sin(time * 0.7 + f.phase) * f.drift + Math.sin(time * 0.23) * 12) * dt
    f.y += f.vy * dt
    if (f.y > height + 6) {
      f.y = -8
      f.x = Math.random() * width
    }
    if (f.x > width + 6) f.x = -6
    if (f.x < -6) f.x = width + 6
    ctx.beginPath()
    ctx.arc(f.x, f.y, f.r, 0, Math.PI * 2)
    ctx.fillStyle = `rgba(226, 238, 246, ${0.25 + (f.r / 3.6) * 0.5})`
    ctx.fill()
  }
}
