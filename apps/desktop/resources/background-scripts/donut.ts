// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors
//
// 动态背景示例：旋转甜甜圈（经典 donut.c 的 canvas 2D 移植）。
// 环面参数方程 + 简单朗伯光照，逐字符铺到画布上。

const CHARSET = '.,-~:;=!*#$@'
const R1 = 1
const R2 = 2
const K2 = 5

export default function frame(api: {
  ctx: CanvasRenderingContext2D
  width: number
  height: number
  time: number
}): void {
  const { ctx, width, height, time } = api
  ctx.fillStyle = 'rgba(8, 10, 14, 0.32)'
  ctx.fillRect(0, 0, width, height)

  const K1 = Math.min(width, height) * K2 * 3 / (8 * (R1 + R2))
  const cell = 13
  const cols = Math.floor(width / cell)
  const rows = Math.floor(height / cell)
  const A = time * 0.9
  const B = time * 0.5

  const zbuf = new Float32Array(cols * rows)
  const out = new Array<string>(cols * rows).fill(' ')

  for (let theta = 0; theta < Math.PI * 2; theta += 0.07) {
    const costheta = Math.cos(theta)
    const sintheta = Math.sin(theta)
    for (let phi = 0; phi < Math.PI * 2; phi += 0.03) {
      const circlex = R2 + R1 * costheta
      const circley = R1 * sintheta
      const x = circlex * (Math.cos(B) * Math.cos(phi) + Math.sin(A) * Math.sin(B) * Math.sin(phi)) -
        circley * Math.cos(A) * Math.sin(B)
      const y = circlex * (Math.sin(B) * Math.cos(phi) - Math.sin(A) * Math.cos(B) * Math.sin(phi)) +
        circley * Math.cos(A) * Math.cos(B)
      const z = K2 + circlex * Math.sin(phi)
      const ooz = 1 / z
      const xp = Math.floor(cols / 2 + (K1 * ooz * x) / cell)
      const yp = Math.floor(rows / 2 - (K1 * ooz * y) / cell)
      if (xp < 0 || xp >= cols || yp < 0 || yp >= rows) continue
      // 光照：法向量点乘（与 donut.c 相同的 L 默认向量）
      const Lx = Math.cos(phi) * Math.cos(theta) * Math.sin(B) -
        Math.cos(A) * Math.cos(phi) * Math.sin(theta) -
        Math.sin(A) * Math.sin(theta)
      const Ly = Math.cos(B) * Math.cos(theta) * Math.sin(phi) +
        Math.sin(A) * Math.cos(B) * Math.sin(theta) * Math.cos(phi) -
        Math.cos(A) * Math.sin(B) * Math.sin(theta) * Math.cos(phi)
      const idx = Math.floor(Math.max(0, Math.min(CHARSET.length - 1, (Lx + Ly) * 4 + 6)))
      if (ooz > (zbuf[yp * cols + xp] ?? 0)) {
        zbuf[yp * cols + xp] = ooz
        out[yp * cols + xp] = CHARSET[idx] ?? '.'
      }
    }
  }

  ctx.font = `${cell - 1}px monospace`
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      const ch = out[r * cols + c] ?? ' '
      if (ch === ' ') continue
      ctx.fillStyle = 'rgba(62, 201, 214, 0.55)'
      ctx.fillText(ch, c * cell, (r + 1) * cell)
    }
  }
}
