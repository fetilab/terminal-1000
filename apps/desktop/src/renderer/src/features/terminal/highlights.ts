// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 高亮规则的**共用纯逻辑**：设置里的实时预览与终端里的实际着色都调这里。
 *
 * 为什么必须共用：这个功能上次翻车的根因就是"预览有、终端没有"——
 * 用户在预览里看到彩色、回终端毫无变化。如果预览和终端各写一套切分逻辑，
 * 迟早又会出现"预览说会变色、终端变的是另一段"这种同一类问题。
 * 所以：**切分算法只有一份**，预览负责画出来，终端负责登记 decoration。
 *
 * 关于能力边界（重要，界面上也如实写着）：
 * - xterm 6.0.0 的 DOM 渲染器会把 `layer: 'top'` 装饰的 `foregroundColor`/
 *   `backgroundColor` 逐单元格应用到命中的文字/底色上（`forEachDecorationAtCell`），
 *   但**只接受 `#RRGGBB`**——内部 `css.toColor` 对其它格式抛异常，且装饰的颜色
 *   getter 没有兜底，传非法值会砸掉渲染器。所以传给 `registerDecoration` 的颜色
 *   必须先过 `normalizeHexColor`，解析不了就跳过。
 * - 装饰只管颜色，**不支持粗体/斜体/下划线**；规则里的 bold/italic/underline 在
 *   终端里不生效，预览也不画它们（宁可少画，不要画了做不到）。
 * - decoration 的 `x`/`width` 单位是**单元格**，不是字符下标，
 *   所以要按显示宽度把字符下标换算过去（见 `cellsFor`）。
 *   宽度表与 `@xterm/addon-unicode11` 一致（终端挂了该插件，两边必须同表，
 *   否则装饰会相对文字偏移）。
 */

import type { HighlightRule } from '@t1000/shared'

export interface HighlightSegment {
  text: string
  /** 在整行文本里的字符下标（含） */
  start: number
  /** 字符下标（不含） */
  end: number
  rule?: HighlightRule
}

/** 编译规则；非法正则返回 null（调用方负责跳过，不抛） */
export function compileHighlightRule(rule: HighlightRule): RegExp | null {
  try {
    // 强制带 g：我们要在一行里找全部命中；同时保留用户自己的其它 flags
    const flags = rule.flags?.includes('g') ? rule.flags : `${rule.flags ?? ''}g`
    return new RegExp(rule.pattern, flags)
  } catch {
    return null
  }
}

/** 启用中的规则，按优先级从高到低 */
export function activeHighlightRules(rules: readonly HighlightRule[]): HighlightRule[] {
  return rules
    .filter((r) => r.enabled && r.pattern)
    .slice()
    .sort((a, b) => b.priority - a.priority)
}

/**
 * 把一行文本按规则切成片段。
 *
 * 语义（与预览完全一致）：**逐字符记录"谁先占到"**，高优先级规则先写；
 * 同一字符已被更高优先级占用时，低优先级不再覆盖 —— 即"重叠时高优先级胜出"。
 */
export function segmentText(text: string, rules: readonly HighlightRule[]): HighlightSegment[] {
  if (text.length === 0) return []
  const active = activeHighlightRules(rules)
  if (active.length === 0) return [{ text, start: 0, end: text.length }]

  const owner: Array<HighlightRule | undefined> = new Array(text.length)
  for (const rule of active) {
    const re = compileHighlightRule(rule)
    if (!re) continue
    let guard = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(text)) !== null && guard < 500) {
      guard += 1
      if (m[0].length === 0) {
        // 零宽匹配：推进一格，避免死循环
        re.lastIndex += 1
        continue
      }
      for (let i = m.index; i < m.index + m[0].length; i += 1) {
        if (owner[i] === undefined) owner[i] = rule
      }
    }
  }

  const segs: HighlightSegment[] = []
  let cur: { rule?: HighlightRule; start: number; text: string } | null = null
  for (let i = 0; i < text.length; i += 1) {
    const rule = owner[i]
    if (cur && cur.rule === rule) {
      cur.text += text[i]
    } else {
      if (cur) segs.push({ text: cur.text, start: cur.start, end: i, ...(cur.rule ? { rule: cur.rule } : {}) })
      cur = { ...(rule ? { rule } : {}), start: i, text: text[i] ?? '' }
    }
  }
  if (cur) {
    segs.push({
      text: cur.text,
      start: cur.start,
      end: text.length,
      ...(cur.rule ? { rule: cur.rule } : {}),
    })
  }
  return segs
}

/* ── 颜色 ─────────────────────────────────────── */

/**
 * 归一化成 `#RRGGBB`。
 *
 * xterm 6.0.0 装饰的 `foregroundColor`/`backgroundColor` 只接受 `#RRGGBB`
 * （内部 `css.toColor` 对其它格式**抛异常**，而装饰的颜色 getter 没有兜底，
 * 传非法字符串会砸掉渲染器）。任何要传给 `registerDecoration` 的颜色都必须
 * 先过这里；解析不了就放弃该颜色，绝不能把原始字符串传下去。
 */
export function normalizeHexColor(input: string | undefined): string | null {
  if (!input) return null
  const s = input.trim()
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(s)
  if (hex) {
    const h = hex[1] ?? ''
    if (h.length === 3) {
      return `#${h[0]}${h[0]}${h[1]}${h[1]}${h[2]}${h[2]}`.toLowerCase()
    }
    return `#${h.slice(0, 6)}`.toLowerCase()
  }
  const rgb = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(s)
  if (rgb) {
    const a = rgb[4]
    if (a !== undefined && Number(a) < 1) return null // 半透明没法用 cell 颜色表达
    const to2 = (v: string): string => Math.max(0, Math.min(255, Number(v))).toString(16).padStart(2, '0')
    return `#${to2(rgb[1] ?? '0')}${to2(rgb[2] ?? '0')}${to2(rgb[3] ?? '0')}`
  }
  return null
}

/**
 * 命中片段最终用什么颜色显示 —— **预览与终端共用这一个函数**。
 *
 * 语义：**文字本身变色**（用户要求把"涂背景"改成"涂文字"）。
 * - 规则给了 `foreground` → 直接用作文字色；
 * - 只给了 `background` → 把该色相用作文字色，保证规则仍然可见
 *   （不然只配背景色的规则在终端里会"消失"）。
 *
 * 终端的落地方式见 TerminalPane 的 applyHighlights：把这里返回的颜色归一化成
 * `#RRGGBB` 后传给 `registerDecoration({ layer: 'top', foregroundColor })`，
 * xterm 自己把颜色涂到命中单元格的文字上——装饰元素本身保持透明。
 * 预览（HighlightsEditor）本来就以 `foreground` 画文字，两边语义一致；
 * 差异仅在"只配了背景色"的规则：预览画底色、终端画同色文字。
 */
export function segmentHighlightStyle(rule: HighlightRule): { color?: string } {
  const fg = rule.foreground?.trim()
  if (fg) return { color: fg }
  const bg = rule.background?.trim()
  if (bg) return { color: bg }
  return {}
}

/** 规则里终端**做不到**的样式，供界面如实提示 */
export function unsupportedStyles(rule: HighlightRule): string[] {
  const out: string[] = []
  if (rule.bold) out.push('粗体')
  if (rule.italic) out.push('斜体')
  if (rule.underline) out.push('下划线')
  // 颜色不受限（自己写到元素上），所以这里只报装饰能力覆盖不到的字体样式
  return out
}

/* ── 字符下标 → 单元格 ─────────────────────────── */

/**
 * 显示宽度（单元格数）。
 *
 * xterm 的 decoration 用「单元格」定位，而我们的规则按「字符」匹配，
 * 所以必须换算。宽字符表**抄自 `@xterm/addon-unicode11` 的宽度表**
 * （Unicode 11 的 East Asian Wide/Fullwidth）——终端挂了该插件，
 * 单元格布局以它为准，这里的表必须与它一致，否则装饰会相对文字偏移。
 * 零宽：组合附加符号、ZWJ（emoji ZWJ 序列的连接符）、变体选择符 FE00–FE0F。
 * ⚠️ "⚠"(U+26A0) 这类 text-presentation emoji 不在宽表里，加 VS16 后
 * 在 xterm 里仍按 1 格计（VS16 记 0 宽）——与 unicode11 插件保持一致。
 */
const WIDE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f], [0x231a, 0x231b], [0x2329, 0x232a], [0x23e9, 0x23ec],
  [0x23f0, 0x23f0], [0x23f3, 0x23f3], [0x25fd, 0x25fe], [0x2614, 0x2615],
  [0x2648, 0x2653], [0x267f, 0x267f], [0x2693, 0x2693], [0x26a1, 0x26a1],
  [0x26aa, 0x26ab], [0x26bd, 0x26be], [0x26c4, 0x26c5], [0x26ce, 0x26ce],
  [0x26d4, 0x26d4], [0x26ea, 0x26ea], [0x26f2, 0x26f3], [0x26f5, 0x26f5],
  [0x26fa, 0x26fa], [0x26fd, 0x26fd], [0x2705, 0x2705], [0x270a, 0x270b],
  [0x2728, 0x2728], [0x274c, 0x274c], [0x274e, 0x274e], [0x2753, 0x2755],
  [0x2757, 0x2757], [0x2795, 0x2797], [0x27b0, 0x27b0], [0x27bf, 0x27bf],
  [0x2b1b, 0x2b1c], [0x2b50, 0x2b50], [0x2b55, 0x2b55],
  [0x2e80, 0x2e99], [0x2e9b, 0x2ef3], [0x2f00, 0x2fd5], [0x2ff0, 0x2ffb],
  [0x3000, 0x3029], [0x302e, 0x303e], [0x3041, 0x3096], [0x309b, 0x30ff],
  [0x3105, 0x312f], [0x3131, 0x318e], [0x3190, 0x31ba], [0x31c0, 0x31e3],
  [0x31f0, 0x321e], [0x3220, 0x3247], [0x3250, 0x4dbf], [0x4e00, 0xa48c],
  [0xa490, 0xa4c6], [0xa960, 0xa97c], [0xac00, 0xd7a3], [0xf900, 0xfaff],
  [0xfe10, 0xfe19], [0xfe30, 0xfe52], [0xfe54, 0xfe66], [0xfe68, 0xfe6b],
  [0xff01, 0xff60], [0xffe0, 0xffe6],
  // astral：emoji / 符号 / 表意扩展
  [0x16fe0, 0x16fe3], [0x17000, 0x187f7], [0x18800, 0x18af2],
  [0x1b000, 0x1b11e], [0x1b150, 0x1b152], [0x1b164, 0x1b167], [0x1b170, 0x1b2fb],
  [0x1f004, 0x1f004], [0x1f0cf, 0x1f0cf], [0x1f18e, 0x1f18e], [0x1f191, 0x1f19a],
  [0x1f200, 0x1f202], [0x1f210, 0x1f23b], [0x1f240, 0x1f248], [0x1f250, 0x1f251],
  [0x1f260, 0x1f265], [0x1f300, 0x1f320], [0x1f32d, 0x1f335], [0x1f337, 0x1f37c],
  [0x1f37e, 0x1f393], [0x1f3a0, 0x1f3ca], [0x1f3cf, 0x1f3d3], [0x1f3e0, 0x1f3f0],
  [0x1f3f4, 0x1f3f4], [0x1f3f8, 0x1f43e], [0x1f440, 0x1f440], [0x1f442, 0x1f4fc],
  [0x1f4ff, 0x1f53d], [0x1f54b, 0x1f54e], [0x1f550, 0x1f567], [0x1f57a, 0x1f57a],
  [0x1f595, 0x1f596], [0x1f5a4, 0x1f5a4], [0x1f5fb, 0x1f64f], [0x1f680, 0x1f6c5],
  [0x1f6cc, 0x1f6cc], [0x1f6d0, 0x1f6d2], [0x1f6d5, 0x1f6d5], [0x1f6eb, 0x1f6ec],
  [0x1f6f4, 0x1f6fa], [0x1f7e0, 0x1f7eb], [0x1f90d, 0x1f971], [0x1f973, 0x1f976],
  [0x1f97a, 0x1f9a2], [0x1f9a5, 0x1f9aa], [0x1f9ae, 0x1f9ca], [0x1f9cd, 0x1f9ff],
  [0x1fa70, 0x1fa73], [0x1fa78, 0x1fa7a], [0x1fa80, 0x1fa82], [0x1fa90, 0x1fa95],
  [0x20000, 0x2fffd], [0x30000, 0x3fffd],
]

export function charCells(cp: number): number {
  if (cp === 0x200d) return 0 // ZWJ
  if (cp >= 0x0300 && cp <= 0x036f) return 0 // 组合附加符号
  if (cp >= 0xfe00 && cp <= 0xfe0f) return 0 // 变体选择符（VS15/VS16）
  for (const [lo, hi] of WIDE_RANGES) {
    if (cp >= lo && cp <= hi) return 2
  }
  return 1
}

/** 文本前 `charIndex` 个字符占多少单元格 */
export function cellsFor(text: string, charIndex: number): number {
  let cells = 0
  const upto = Math.max(0, Math.min(charIndex, text.length))
  for (let i = 0; i < upto; i += 1) {
    const cp = text.codePointAt(i)
    if (cp === undefined) break
    cells += charCells(cp)
    // 代理对：跳过低位
    if (cp > 0xffff) i += 1
  }
  return cells
}
