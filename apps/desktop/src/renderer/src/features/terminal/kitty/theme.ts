// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

import type { TerminalSettings } from '@t1000/shared'

/** 0..1 的 RGBA */
export interface Rgba {
  r: number
  g: number
  b: number
  a: number
}

export interface RenderTheme {
  fg: Rgba
  bg: Rgba
  cursor: Rgba
  selectionBg: Rgba
  selectionFg: Rgba
  /** 下划线颜色；null = 跟随前景 */
  underline: Rgba | null
  /** 256 色（0–15 来自配色方案，16–255 来自内核调色板） */
  palette: Rgba[]
}

/** 与 xterm 主题对齐的默认暗色（与 TerminalPane 的 TERMINAL_THEME 同源） */
export const SCHEME_DARK = [
  '#1e222b',
  '#e5484d',
  '#46b17b',
  '#d9a441',
  '#6f8dff',
  '#b48ce0',
  '#3ec9d6',
  '#c6ccd8',
  '#4c5361',
  '#ff6b6f',
  '#63d29a',
  '#f0c065',
  '#8fa6ff',
  '#cfa8f0',
  '#63dde8',
  '#f2f4f8',
] as const

export const SCHEME_LIGHT = [
  '#1e222b',
  '#c62f34',
  '#1f8a52',
  '#9a6b00',
  '#3457d5',
  '#8b4bb5',
  '#0f7f8b',
  '#4a5260',
  '#6b7382',
  '#e5484d',
  '#2aa869',
  '#b8860b',
  '#5b7bff',
  '#a86fd1',
  '#1a9ba8',
  '#20242c',
] as const

export const BG_DARK = '#0d0f14'
export const BG_LIGHT = '#fbfcfe'

export function parseHex(hex: string, alpha = 1): Rgba {
  const trimmed = hex.trim()
  if (trimmed.startsWith('#')) {
    const h = trimmed.slice(1)
    if (h.length === 3) {
      const v = Number.parseInt(h, 16)
      return { r: ((v >> 8) & 0xf) / 15, g: ((v >> 4) & 0xf) / 15, b: (v & 0xf) / 15, a: alpha }
    }
    if (h.length === 6 || h.length === 8) {
      const v = Number.parseInt(h.slice(0, 6), 16)
      return {
        r: ((v >> 16) & 0xff) / 255,
        g: ((v >> 8) & 0xff) / 255,
        b: (v & 0xff) / 255,
        a: h.length === 8 ? Number.parseInt(h.slice(6, 8), 16) / 255 : alpha,
      }
    }
  }
  // rgba()/rgb() 兜底
  const m = /rgba?\(([^)]+)\)/.exec(trimmed)
  if (m && m[1]) {
    const parts = m[1].split(',').map((p) => Number.parseFloat(p.trim()))
    return {
      r: (parts[0] ?? 0) / 255,
      g: (parts[1] ?? 0) / 255,
      b: (parts[2] ?? 0) / 255,
      a: parts[3] ?? alpha,
    }
  }
  return { r: 1, g: 1, b: 1, a: alpha }
}

export function fromRgbInt(rgb: number, alpha = 1): Rgba {
  return {
    r: ((rgb >> 16) & 0xff) / 255,
    g: ((rgb >> 8) & 0xff) / 255,
    b: (rgb & 0xff) / 255,
    a: alpha,
  }
}

interface ThemeInput {
  settings: TerminalSettings
  resolved: 'light' | 'dark'
  /** 内核上报的默认前景/背景/光标（null = 应用没改过，用方案色） */
  core?: { fg: number | null; bg: number | null; cursor: number | null; palette: number[] }
}

/**
 * 组装渲染主题。
 *
 * 优先级（从高到低）：
 * 1. 用户显式改过的 16 色 / 前景 / 背景（设置页）
 * 2. 终端程序通过 OSC 4/10/11/12 改的颜色（内核上报）
 * 3. 内置配色方案（暗色/浅色/高对比）
 *
 * 这一顺序与 kitty 的 `colors.conf` 语义一致：配置文件 > 程序运行时 > 默认。
 */
export function buildTheme(input: ThemeInput): RenderTheme {
  const { settings, resolved, core } = input
  const scheme = settings.colorScheme === 'light' || (settings.colorScheme === 'default-dark' && resolved === 'light')
    ? SCHEME_LIGHT
    : settings.colorScheme === 'high-contrast'
      ? [...SCHEME_DARK.slice(0, 8), '#8a8a8a', '#ff6b6f', '#63d29a', '#f0c065', '#8fa6ff', '#cfa8f0', '#63dde8', '#ffffff']
      : SCHEME_DARK

  const palette: Rgba[] = new Array(256)
  for (let i = 0; i < 256; i += 1) {
    const override = settings.palette[i]
    if (override) palette[i] = parseHex(override)
    else if (i < 16) palette[i] = parseHex(scheme[i] ?? '#ffffff')
    else if (core && core.palette[i] !== undefined) palette[i] = fromRgbInt(core.palette[i] ?? 0)
    else palette[i] = defaultPalette(i)
  }

  const lightTheme = scheme === SCHEME_LIGHT
  const bgBase = parseHex(lightTheme ? BG_LIGHT : BG_DARK)
  const fgBase = parseHex(lightTheme ? '#1b2029' : '#e4e7ee')
  const bg = core?.bg != null ? fromRgbInt(core.bg, settings.backgroundOpacity) : { ...bgBase, a: settings.backgroundOpacity }
  const fg = core?.fg != null ? fromRgbInt(core.fg) : fgBase
  const cursor = core?.cursor != null ? fromRgbInt(core.cursor, settings.cursorOpacity) : { ...parseHex(lightTheme ? '#12909e' : '#3ec9d6'), a: settings.cursorOpacity }

  return {
    fg,
    bg,
    cursor,
    selectionBg: parseHex(settings.selectionBackground, 0.72),
    selectionFg: parseHex(settings.selectionForeground, 1),
    underline: settings.underlineColor ? parseHex(settings.underlineColor) : null,
    palette,
  }
}

/** xterm 256 色的标准生成公式（16–231 为 6×6×6 立方，232–255 为灰阶） */
function defaultPalette(index: number): Rgba {
  if (index < 16) return parseHex(SCHEME_DARK[index] ?? '#ffffff')
  if (index < 232) {
    const n = index - 16
    const steps = [0, 95, 135, 175, 215, 255]
    const r = steps[Math.floor(n / 36) % 6] ?? 0
    const g = steps[Math.floor(n / 6) % 6] ?? 0
    const b = steps[n % 6] ?? 0
    return { r: r / 255, g: g / 255, b: b / 255, a: 1 }
  }
  const v = 8 + (index - 232) * 10
  return { r: v / 255, g: v / 255, b: v / 255, a: 1 }
}
