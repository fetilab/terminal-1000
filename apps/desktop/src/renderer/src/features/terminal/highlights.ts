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
 * - xterm 的 decoration 只能设 `#RRGGBB` 的前景/背景色，
 *   **不支持粗体/斜体/下划线**；所以规则里的 bold/italic/underline 在终端里
 *   **不会生效**，预览也不再画它们（宁可少画，不要画了做不到）。
 * - decoration 的 `x`/`width` 单位是**单元格**，不是字符下标，
 *   所以要按显示宽度把字符下标换算过去（见 `cellsFor`）。全宽字符（CJK）按 2 格算。
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
 * ⚠️ 现在**不再用它来卡终端能不能显示** —— 实测发现 xterm 6.0 的 DOM 装饰渲染器
 * **根本不读 `backgroundColor`/`foregroundColor`**（typings 里有这两个选项，
 * 但 `browser/decorations/*` 里没有任何应用代码）。所以颜色是**我们自己**写到
 * 装饰元素上的，任意合法 CSS 颜色都能用。
 * 保留这个函数是因为它在做"用户输入是否是规范颜色"的判断时仍然有用。
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
    if (a !== undefined && Number(a) < 1) return null // 半透明没法用 cell 背景表达
    const to2 = (v: string): string => Math.max(0, Math.min(255, Number(v))).toString(16).padStart(2, '0')
    return `#${to2(rgb[1] ?? '0')}${to2(rgb[2] ?? '0')}${to2(rgb[3] ?? '0')}`
  }
  return null
}

/**
 * 一条规则要用的颜色。
 *
 * **原样透传**：因为颜色由我们自己写到装饰元素上（见文件头说明），
 * 不经过 `#RRGGBB` 的窄化 —— 这样预览与终端能用完全相同的取值，
 * 用户填 `rgba()` / 颜色名也能生效。
 */
export function decorationColors(rule: HighlightRule): {
  foregroundColor?: string
  backgroundColor?: string
} {
  const fg = rule.foreground?.trim()
  const bg = rule.background?.trim()
  return {
    ...(fg ? { foregroundColor: fg } : {}),
    ...(bg ? { backgroundColor: bg } : {}),
  }
}

/**
 * 命中片段最终用什么样式显示 —— **预览与终端共用这一个函数**。
 *
 * ## 为什么是"底色"而不是"文字变色"
 * 我实测过 xterm 6.0 的 DOM 装饰：
 * 1. `IDecorationOptions` 的 `backgroundColor`/`foregroundColor` **没有任何实现去读**
 *    （`browser/decorations/*` 里 0 命中），颜色只能由我们自己写到装饰元素上；
 * 2. 装饰元素本身是**空的覆盖层**，只设 `color` 没有文字可染；
 * 3. 于是试过"把命中文本画进装饰元素再上色"——**实测会错位**（约半字符，
 *    截图里出现 `failled`/`runniing` 这种重影），比不着色更糟。
 *
 * 结论：用**底色**标出命中区域，最稳且真实。规则给了 `background` 就用它；
 * 只给了 `foreground` 就把它的色相拿来、取 22% 透明度做底。
 * 预览调同一个函数，所以**两边看到的是同一个效果**。
 */
export function segmentHighlightStyle(rule: HighlightRule): { background?: string } {
  const bg = rule.background?.trim()
  if (bg) return { background: bg }
  const fg = rule.foreground?.trim()
  if (fg) return { background: `color-mix(in srgb, ${fg} 22%, transparent)` }
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
 * 所以必须换算。这里按 East Asian Width 的 Wide/Fullwidth 记 2 格，
 * 组合记号记 0 格，其余 1 格 —— 覆盖了终端里绝大多数输出。
 * ⚠️ 与 xterm 内部的 wcwidth 表可能有极小差异（冷僻字符），
 * 那种情况下色的范围可能偏一两格；ASCII/CJK 常见内容不受影响。
 */
export function charCells(cp: number): number {
  if (cp === 0x200d) return 0
  if (cp >= 0x0300 && cp <= 0x036f) return 0 // 组合附加符号
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xa960 && cp <= 0xa97f) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe10 && cp <= 0xfe19) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  ) {
    return 2
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
