// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 主题预设 —— **全部自研配色**，无一取自原软件或任何第三方主题包。
 *
 * 模型：`外观预设`决定**色系**，`app.theme`（跟随系统/深色/浅色）决定**明暗**，
 * 两个维度正交 —— 所以 5 套预设天然包含「浅色 + 深色 + 若干预设」全部组合，
 * 也不需要在切换明暗时重选色系。
 *
 * 每套预设只声明 8 个锚色（底色/面板/浮层/输入框/前景/次要前景/强调/强调上的字），
 * 其余层级（下沉底、悬停、描边、更弱的字）由 color.ts 推导 —— 新增一套配色
 * 不需要手写二十多个色值，也不会漏掉某一层。
 *
 * 一致性约束（见 appearance.test.ts）：
 * - `aurora` 的色值与 styles/global.css 的令牌**必须逐字一致**（它是同一套配色的两份声明，
 *   测试会比对，防止两边漂移）；
 * - 所有预设、两种明暗都要满足 WCAG 对比度下限。
 */

import { mix, rgba } from './color'

export type AppearanceMode = 'light' | 'dark'

/** 一套完整配色（只有实色；-soft 这类半透明由 paletteToCssVars 现场推导） */
export interface Palette {
  bg: string
  bgSunken: string
  bgRaised: string
  bgPanel: string
  bgHover: string
  bgActive: string
  bgInput: string
  fg: string
  fgMuted: string
  fgDim: string
  fgFaint: string
  border: string
  borderStrong: string
  accent: string
  accentStrong: string
  accentFg: string
  danger: string
  warn: string
  ok: string
  info: string
  overlay: string
}

/** 预设的锚色：其余层级由 derivePalette 推导 */
interface Anchors {
  bg: string
  panel: string
  raised: string
  input: string
  fg: string
  muted: string
  accent: string
  accentOn: string
}

/**
 * 语义色在两套明暗下各一套。
 *
 * 刻意**不随预设变化**：红=错误、黄=警告、绿=成功是跨界面的一致性约定，
 * 换色系不该让用户重新学一遍语义。
 */
const SEMANTIC: Record<AppearanceMode, Pick<Palette, 'danger' | 'warn' | 'ok' | 'info'>> = {
  dark: { danger: '#e5484d', warn: '#d9a441', ok: '#46b17b', info: '#6f8dff' },
  light: { danger: '#c62f34', warn: '#8a6210', ok: '#217a4d', info: '#3f5fd0' },
}

/**
 * 由锚色推导整套配色；`tune` 用来覆盖个别手调值（默认预设用得上）。
 *
 * 推导规则有意保持"可解释"：下沉底=更深、悬停/选中=向前景方向靠、
 * 描边=前景与底色的中间色、弱的字=逐步向底色靠拢。
 */
function derivePalette(mode: AppearanceMode, a: Anchors, tune: Partial<Palette> = {}): Palette {
  const dark = mode === 'dark'
  return {
    bg: a.bg,
    bgSunken: dark ? mix(a.bg, '#000000', 0.28) : mix(a.bg, a.fg, 0.05),
    bgRaised: a.raised,
    bgPanel: a.panel,
    bgHover: mix(a.panel, a.fg, dark ? 0.08 : 0.06),
    bgActive: mix(a.panel, a.fg, dark ? 0.16 : 0.12),
    bgInput: a.input,
    fg: a.fg,
    fgMuted: a.muted,
    fgDim: mix(a.fg, a.bg, dark ? 0.42 : 0.35),
    fgFaint: mix(a.fg, a.bg, dark ? 0.56 : 0.5),
    border: mix(a.fg, a.bg, 0.86),
    borderStrong: mix(a.fg, a.bg, 0.72),
    accent: a.accent,
    accentStrong: mix(a.accent, '#000000', dark ? 0.22 : 0.16),
    accentFg: a.accentOn,
    ...SEMANTIC[mode],
    overlay: dark ? 'rgba(6, 8, 12, 0.62)' : 'rgba(28, 34, 44, 0.34)',
    ...tune,
  }
}

export type ThemePresetId = 'aurora' | 'graphite' | 'ember' | 'forest' | 'violet'

export interface ThemePreset {
  id: ThemePresetId
  label: string
  /** 给设置界面的一句话说明 */
  hint: string
  dark: Palette
  light: Palette
}

/** 冷青（默认）：与 styles/global.css 的令牌逐字一致，保证默认观感不变 */
const AURORA_DARK = derivePalette(
  'dark',
  {
    bg: '#12141a',
    panel: '#1e222b',
    raised: '#191c24',
    input: '#171a21',
    fg: '#e4e7ee',
    muted: '#9aa3b2',
    accent: '#3ec9d6',
    accentOn: '#05222a',
  },
  {
    bgSunken: '#0d0f14',
    bgHover: '#252a35',
    bgActive: '#2c3240',
    fgDim: '#6b7382',
    fgFaint: '#4c5361',
    border: '#2a2f3a',
    borderStrong: '#3a4150',
    accentStrong: '#22b3c1',
    overlay: 'rgba(6, 8, 12, 0.62)',
  },
)

const AURORA_LIGHT = derivePalette(
  'light',
  {
    bg: '#f4f6f9',
    panel: '#f9fafc',
    raised: '#ffffff',
    input: '#ffffff',
    fg: '#1b2029',
    muted: '#5a6474',
    accent: '#0e7581',
    accentOn: '#ffffff',
  },
  {
    bgSunken: '#e9edf3',
    bgHover: '#eef1f6',
    bgActive: '#e2e8f1',
    fgDim: '#7d8798',
    // 原为 #a4aebd（对底色仅 2.07:1）：次要提示文字在浅色下几乎读不清，本次打磨压暗到 3.06:1
    fgFaint: '#848e9e',
    border: '#dde3ec',
    borderStrong: '#c3ccda',
    // 原为 #12909e：作为链接色对底色 3.52:1、作为白字底 3.81:1，两处都不足 4.5，压暗一档
    accentStrong: '#0a5c66',
    overlay: 'rgba(28, 34, 44, 0.34)',
  },
)

export const THEME_PRESETS: readonly ThemePreset[] = [
  {
    id: 'aurora',
    label: '冷青（默认）',
    hint: '冷灰蓝底 + 青色强调',
    dark: AURORA_DARK,
    light: AURORA_LIGHT,
  },
  {
    id: 'graphite',
    label: '石墨',
    hint: '中性灰底 + 钢蓝强调',
    dark: derivePalette('dark', {
      bg: '#16181b',
      panel: '#1e2125',
      raised: '#24272c',
      input: '#1a1d20',
      fg: '#e6e7ea',
      muted: '#9ba0a8',
      accent: '#8fa8d8',
      accentOn: '#101a2b',
    }),
    light: derivePalette('light', {
      bg: '#f5f6f7',
      panel: '#fbfbfc',
      raised: '#ffffff',
      input: '#ffffff',
      fg: '#1c1e21',
      muted: '#5d6167',
      accent: '#3d5fa8',
      accentOn: '#ffffff',
    }),
  },
  {
    id: 'ember',
    label: '曙光',
    hint: '暖棕底 + 琥珀强调',
    dark: derivePalette('dark', {
      bg: '#191411',
      panel: '#221b16',
      raised: '#2a221b',
      input: '#1e1814',
      fg: '#ece4dc',
      muted: '#a89c90',
      accent: '#e0a15c',
      accentOn: '#2a1a08',
    }),
    light: derivePalette('light', {
      bg: '#faf6f1',
      panel: '#fffaf4',
      raised: '#ffffff',
      input: '#ffffff',
      fg: '#241d18',
      muted: '#6b5f54',
      accent: '#a35f16',
      accentOn: '#ffffff',
    }),
  },
  {
    id: 'forest',
    label: '松林',
    hint: '墨绿底 + 松绿强调',
    dark: derivePalette('dark', {
      bg: '#101713',
      panel: '#17201b',
      raised: '#1e2822',
      input: '#141c17',
      fg: '#dfe8e1',
      muted: '#93a296',
      accent: '#57bf8a',
      accentOn: '#06251a',
    }),
    light: derivePalette('light', {
      bg: '#f3f7f4',
      panel: '#f9fdfa',
      raised: '#ffffff',
      input: '#ffffff',
      fg: '#16201a',
      muted: '#55635a',
      accent: '#1f7a4d',
      accentOn: '#ffffff',
    }),
  },
  {
    id: 'violet',
    label: '紫罗兰',
    hint: '靛紫底 + 紫罗兰强调',
    dark: derivePalette('dark', {
      bg: '#131120',
      panel: '#1b1830',
      raised: '#221e3a',
      input: '#171429',
      fg: '#e6e3f2',
      muted: '#a09ab8',
      accent: '#a48bf0',
      accentOn: '#1c1040',
    }),
    light: derivePalette('light', {
      bg: '#f6f4fb',
      panel: '#fcfaff',
      raised: '#ffffff',
      input: '#ffffff',
      fg: '#1d1930',
      muted: '#5d5674',
      accent: '#5b3fb8',
      accentOn: '#ffffff',
    }),
  },
]

export const PRESET_IDS: readonly ThemePresetId[] = THEME_PRESETS.map((p) => p.id)

export function isThemePresetId(value: unknown): value is ThemePresetId {
  return typeof value === 'string' && (PRESET_IDS as readonly string[]).includes(value)
}

/** 取某预设某明暗下的配色；未知预设回退默认（设置里存了脏值时界面仍可用） */
export function paletteFor(preset: unknown, mode: AppearanceMode): Palette {
  const found = THEME_PRESETS.find((p) => p.id === preset) ?? THEME_PRESETS[0]!
  return mode === 'light' ? found.light : found.dark
}

/** 配色 → CSS 自定义属性（`--t1000-*`）。`surface` 类只给 `-solid`，半透明由 appearance.css 派生 */
export function paletteToCssVars(p: Palette, mode: AppearanceMode): Record<string, string> {
  const soft = mode === 'light' ? 0.13 : 0.15
  return {
    '--t1000-bg-solid': p.bg,
    '--t1000-bg-sunken-solid': p.bgSunken,
    '--t1000-bg-raised-solid': p.bgRaised,
    '--t1000-bg-panel-solid': p.bgPanel,
    '--t1000-bg-hover-solid': p.bgHover,
    '--t1000-bg-active-solid': p.bgActive,
    '--t1000-bg-input-solid': p.bgInput,
    '--t1000-fg': p.fg,
    '--t1000-fg-muted': p.fgMuted,
    '--t1000-fg-dim': p.fgDim,
    '--t1000-fg-faint': p.fgFaint,
    '--t1000-border': p.border,
    '--t1000-border-strong': p.borderStrong,
    '--t1000-accent': p.accent,
    '--t1000-accent-strong': p.accentStrong,
    '--t1000-accent-fg': p.accentFg,
    '--t1000-accent-soft': rgba(p.accent, mode === 'light' ? 0.13 : 0.14),
    '--t1000-accent-softer': rgba(p.accent, mode === 'light' ? 0.06 : 0.07),
    '--t1000-border-accent': rgba(p.accent, 0.45),
    '--t1000-danger': p.danger,
    '--t1000-danger-soft': rgba(p.danger, soft),
    '--t1000-warn': p.warn,
    '--t1000-warn-soft': rgba(p.warn, soft),
    '--t1000-ok': p.ok,
    '--t1000-ok-soft': rgba(p.ok, soft),
    '--t1000-info': p.info,
    '--t1000-overlay': p.overlay,
  }
}
