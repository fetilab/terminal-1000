// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 颜色小工具（纯函数，无 DOM 依赖）。
 *
 * 用途只有一个：让**主题预设的派生色**和**对比度校验**可计算、可测试。
 * 预设只声明少量"锚色"（底色/面板/前景/强调），其余层级由这里推导，
 * 于是新增一套配色不需要手写二十多个色值，也不会出现某一层漏改。
 */

export type Rgb = readonly [number, number, number]

const HEX_RE = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i

/** 解析 #rgb / #rrggbb；非法输入返回 null（调用方决定回退，不抛异常） */
export function parseHex(input: string): Rgb | null {
  const match = HEX_RE.exec(input.trim())
  if (!match) return null
  let body = match[1]!
  if (body.length === 3) body = body.split('').map((c) => c + c).join('')
  return [
    Number.parseInt(body.slice(0, 2), 16),
    Number.parseInt(body.slice(2, 4), 16),
    Number.parseInt(body.slice(4, 6), 16),
  ]
}

function channel(value: number): string {
  return Math.round(Math.min(255, Math.max(0, value)))
    .toString(16)
    .padStart(2, '0')
}

export function toHex(rgb: Rgb): string {
  return `#${channel(rgb[0])}${channel(rgb[1])}${channel(rgb[2])}`
}

/**
 * 按 sRGB 分量线性插值：t=0 取 a，t=1 取 b。
 *
 * 刻意**不做** gamma 校正下的插值：这些色都是界面底/描边的近邻色，
 * 分量插值的结果与设计工具里"取中间色"的直觉一致，也更容易解释。
 */
export function mix(a: string, b: string, t: number): string {
  const from = parseHex(a)
  const to = parseHex(b)
  if (!from || !to) return a
  const k = Math.min(1, Math.max(0, t))
  return toHex([
    from[0] + (to[0] - from[0]) * k,
    from[1] + (to[1] - from[1]) * k,
    from[2] + (to[2] - from[2]) * k,
  ])
}

/** WCAG 相对亮度（0~1） */
export function relativeLuminance(color: string): number {
  const rgb = parseHex(color)
  if (!rgb) return 0
  const [r, g, b] = rgb.map((v) => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }) as [number, number, number]
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** WCAG 对比度（1~21）；顺序无关 */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a)
  const lb = relativeLuminance(b)
  const hi = Math.max(la, lb)
  const lo = Math.min(la, lb)
  return (hi + 0.05) / (lo + 0.05)
}

/** 十六进制 → rgba()，用于 -soft 这类半透明令牌 */
export function rgba(color: string, alpha: number): string {
  const rgb = parseHex(color)
  if (!rgb) return color
  const a = Math.min(1, Math.max(0, alpha))
  return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${Number(a.toFixed(3))})`
}

/**
 * 半透明前景叠在不透明底色上的**实际**底色。
 *
 * "彩色文字放在同色半透明底上"（`--t1000-danger` on `--t1000-danger-soft`）是常见组合，
 * 直接比较两个色值会高估对比度 —— 必须先合成为不透明色再比。
 */
export function composite(foreground: string, alpha: number, background: string): string {
  const over = parseHex(foreground)
  const base = parseHex(background)
  if (!over || !base) return background
  const k = Math.min(1, Math.max(0, alpha))
  return toHex([
    base[0] + (over[0] - base[0]) * k,
    base[1] + (over[1] - base[1]) * k,
    base[2] + (over[2] - base[2]) * k,
  ])
}
