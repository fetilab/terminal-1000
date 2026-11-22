// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * Canvas 2D 回退渲染器。
 *
 * 什么时候用它：
 * - 机器没有可用的 WebGL2（虚拟机、旧显卡、被 `--disable-gpu` 启动）；
 * - 显存吃紧时按「资源分级」策略把非焦点终端降到这一层。
 *
 * 它比 WebGL 慢，但**行为一致**：同一份单元格 ABI、同一份主题、同一套选区/搜索/
 * 高亮叠加规则。宁可慢一点，也不能出现「切到回退就少了个功能」。
 */

import type { KittyMeta, KittyRow } from '@t1000/shared'
import { KITTY_CELL_WORDS } from '@t1000/shared'
import { drawGeometricGlyph, isGeometricGlyph, type GlyphAtlas } from './atlas'
import type { RenderTheme, Rgba } from './theme'
import type { HighlightSpan, ImagePlacement, RendererOptions, SearchSpan } from './webgl'
import { parseHex } from './theme'

const F_BOLD = 1
const F_DIM = 2
const F_ITALIC = 4
const F_REVERSE = 8
const F_STRIKE = 16
const F_BLINK = 32
const F_WIDE = 64
const F_WIDE_TRAIL = 128
const F_UNDERLINE_MASK = 7 << 8
const F_UNDERLINE_SHIFT = 8

/** kitty dim_opacity 默认 0.4：把前景往格子底色上兑，才是「变淡」而不是「变黑」 */
const DIM_OPACITY = 0.4
function mixTo(fg: Rgba, bg: Rgba, k: number): Rgba {
  return {
    r: bg.r + (fg.r - bg.r) * k,
    g: bg.g + (fg.g - bg.g) * k,
    b: bg.b + (fg.b - bg.b) * k,
    a: fg.a,
  }
}

function css(c: Rgba): string {
  return `rgba(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)},${c.a})`
}

export class CanvasTerminalRenderer {
  readonly canvas: HTMLCanvasElement
  private readonly ctx: CanvasRenderingContext2D
  private readonly atlas: GlyphAtlas
  private theme: RenderTheme
  private opts: RendererOptions
  private dpr: number
  private cols = 80
  private rows = 24
  private meta: KittyMeta | null = null
  private grid = new Uint32Array(0)
  private highlights: HighlightSpan[] = []
  private search: SearchSpan[] = []
  private searchActive = -1
  private blinkOff = false
  private fontFamily: string
  private images: ImagePlacement[] = []

  constructor(
    canvas: HTMLCanvasElement,
    atlas: GlyphAtlas,
    theme: RenderTheme,
    opts: RendererOptions,
    dpr: number,
    fontFamily: string,
  ) {
    this.canvas = canvas
    this.atlas = atlas
    this.theme = theme
    this.opts = opts
    this.dpr = dpr
    this.fontFamily = fontFamily
    const ctx = canvas.getContext('2d', { alpha: true })
    if (!ctx) throw new Error('2D 画布不可用')
    this.ctx = ctx
  }

  setTheme(theme: RenderTheme): void {
    this.theme = theme
  }

  setOptions(opts: RendererOptions): void {
    this.opts = opts
  }

  setHighlights(spans: HighlightSpan[]): void {
    this.highlights = spans
  }

  setSearch(spans: SearchSpan[], active: number): void {
    this.search = spans
    this.searchActive = active
  }

  setBlinkOff(off: boolean): boolean {
    if (this.blinkOff === off) return false
    this.blinkOff = off
    return true
  }

  setImages(placements: ImagePlacement[]): void {
    this.images = placements
  }

  /** 按 z 分层画图片（below = 文字下，above = 文字上） */
  private drawImages(meta: KittyMeta, layer: 'below' | 'above'): void {
    if (this.images.length === 0) return
    const ctx = this.ctx
    const cw = this.atlas.cellW
    const ch = this.atlas.cellH
    const abs0 = meta.scrollbackLength - meta.scrolledBy
    // 块光标：跟 WebGL 路径一样画成「反色格」，而不是最后盖一个实心块把字盖掉
    const cur = meta.cursor
    // 宽字符占两格（对齐 WebGL 路径的 blockCursorCell）：只反色第一格会留一条缝
    const curIdx = (meta.scrolledBy + cur.y) * this.cols + cur.x
    const curSpan = ((this.grid[curIdx * KITTY_CELL_WORDS + 6] ?? 0) & F_WIDE) !== 0 ? 2 : 1
    const cursorCell =
      !this.blinkOff && cur.visible && cur.shape === 'block'
        ? { x1: cur.x, x2: Math.min(this.cols - 1, cur.x + curSpan - 1), y: meta.scrolledBy + cur.y }
        : null
    for (const p of this.images) {
      if ((layer === 'below') !== (p.z < 0)) continue
      const vy = p.absLine - abs0
      const h = p.pxH / ch
      if (vy + h <= 0 || vy >= this.rows) continue
      ctx.drawImage(p.source, p.col * cw, vy * ch + p.yOffsetPx, p.pxW, p.pxH)
    }
  }

  /* 光标动画与形状覆盖：2D 回退路径不做拖尾动画（保持光标即点即到），
     但接口保持同形，引擎无需区分后端。 */
  setCursorTrail(_ms: number): void {}
  setCursorShapeOverride(_style: 'block' | 'underline' | 'bar' | null): void {}
  setCursorInactiveStyle(_style: 'outline' | 'block' | 'beam' | 'underline' | 'none'): void {}
  setFocused(_focused: boolean): void {}
  get animActive(): boolean {
    return false
  }

  setGrid(cols: number, rows: number): void {
    if (cols === this.cols && rows === this.rows) return
    this.cols = cols
    this.rows = rows
    this.grid = new Uint32Array(cols * rows * KITTY_CELL_WORDS)
  }

  resize(cssWidth: number, cssHeight: number, cols: number, rows: number, dpr: number): void {
    const w = Math.max(1, Math.round(cssWidth * dpr))
    const h = Math.max(1, Math.round(cssHeight * dpr))
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w
      this.canvas.height = h
    }
    this.dpr = dpr
    this.setGrid(cols, rows)
  }

  applyFrame(meta: KittyMeta, rows: KittyRow[], _full: boolean): void {
    this.setGrid(meta.cols, meta.rows)
    this.meta = meta
    for (const row of rows) {
      if (row.y < 0 || row.y >= this.rows) continue
      const dst = new Uint32Array(
        this.grid.buffer,
        row.y * this.cols * KITTY_CELL_WORDS * 4,
        this.cols * KITTY_CELL_WORDS,
      )
      const src = new Uint32Array(row.words)
      dst.set(src.subarray(0, Math.min(src.length, dst.length)))
    }
  }

  get hasFrame(): boolean {
    return this.meta !== null
  }

  private packed(word: number, background: boolean): Rgba {
    const kind = word >>> 24
    if (kind === 1) return this.theme.palette[word & 0xff] ?? this.theme.fg
    if (kind === 2) {
      const rgb = word & 0xffffff
      return { r: ((rgb >> 16) & 0xff) / 255, g: ((rgb >> 8) & 0xff) / 255, b: (rgb & 0xff) / 255, a: 1 }
    }
    return background ? this.theme.bg : this.theme.fg
  }

  render(): void {
    const meta = this.meta
    if (!meta) return
    const ctx = this.ctx
    const cw = this.atlas.cellW
    const ch = this.atlas.cellH
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height)
    ctx.fillStyle = css(this.theme.bg)
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height)
    ctx.textBaseline = 'alphabetic'
    ctx.font = `${this.atlas.fontWeight} ${this.atlas.fontSizeDpr}px ${this.atlas.fontFamilyCss}`

    // z<0 的图片画在所有文字/背景之下（2D 单通道做不到「背景上、文字下」的精确层）
    this.drawImages(meta, 'below')

    const abs0 = meta.scrollbackLength - meta.scrolledBy
    // 块光标：跟 WebGL 路径一样画成「反色格」，而不是最后盖一个实心块把字盖掉
    const cur = meta.cursor
    // 宽字符占两格（对齐 WebGL 路径的 blockCursorCell）：只反色第一格会留一条缝
    const curIdx = (meta.scrolledBy + cur.y) * this.cols + cur.x
    const curSpan = ((this.grid[curIdx * KITTY_CELL_WORDS + 6] ?? 0) & F_WIDE) !== 0 ? 2 : 1
    const cursorCell =
      !this.blinkOff && cur.visible && cur.shape === 'block'
        ? { x1: cur.x, x2: Math.min(this.cols - 1, cur.x + curSpan - 1), y: meta.scrolledBy + cur.y }
        : null
    for (let y = 0; y < this.rows; y += 1) {
      const abs = abs0 + y
      const sel = meta.selection?.find((s) => s.y === y) ?? null
      for (let x = 0; x < this.cols; x += 1) {
        const i = (y * this.cols + x) * KITTY_CELL_WORDS
        const cp = this.grid[i] ?? 0
        const flags = this.grid[i + 6] ?? 0
        const reverse = (flags & F_REVERSE) !== 0
        let fg = this.packed(this.grid[i + 3] ?? 0, false)
        let bg = this.packed(this.grid[i + 4] ?? 0, true)
        if (reverse) {
          const tmp = fg
          fg = { ...bg, a: 1 }
          bg = { ...tmp, a: this.theme.bg.a }
        }
        // 与 WebGL 路径同源：kitty dim_opacity 是把前景往格子底色上兑（lerp(bg, fg, 0.4)）
        if ((flags & F_DIM) !== 0) fg = mixTo(fg, bg, DIM_OPACITY)
        const selected = sel !== null && x >= sel.x1 && x <= sel.x2
        if (selected) {
          bg = this.theme.selectionBg
          fg = this.theme.selectionFg
        }
        const hit = this.search.findIndex((s) => s.line === abs && x >= s.x1 && x <= s.x2)
        if (hit >= 0 && !selected) {
          bg = parseHex(hit === this.searchActive ? '#f5c451' : '#f5c451', hit === this.searchActive ? 0.85 : 0.38)
          fg = parseHex('#101318')
        }
        const hi = this.highlights.find((s) => s.line === abs && x >= s.x1 && x <= s.x2)
        if (hi) fg = hi.color

        const isCursorCell = cursorCell !== null && cursorCell.y === y && x >= cursorCell.x1 && x <= cursorCell.x2
        if (isCursorCell) {
          fg = { ...bg, a: 1 }
          bg = { ...this.theme.cursor }
        }

        const px = x * cw
        const py = y * ch
        // 背景只在非默认色时画，省掉绝大多数 fillRect
        if (bg.a > 0 && (selected || hit >= 0 || reverse || isCursorCell || (this.grid[i + 4] ?? 0) !== 0)) {
          ctx.fillStyle = css(bg)
          ctx.fillRect(px, py, cw, ch)
        }
        if (cp === 0 || (flags & F_WIDE_TRAIL) !== 0) continue
        const wide = (flags & F_WIDE) !== 0
        let text = String.fromCodePoint(cp)
        if (this.grid[i + 1]) text += String.fromCodePoint(this.grid[i + 1] ?? 0)
        if (this.grid[i + 2]) text += String.fromCodePoint(this.grid[i + 2] ?? 0)
        if ((flags & F_BLINK) !== 0 && this.blinkOff) continue
        ctx.fillStyle = css(fg)
        /*
         * 与 WebGL 路径同一套画法：
         * - 制表/块/阴影用几何绘制（回退渲染器也不能出现断线的框、漏缝的块）；
         * - 普通文字横向缩放到正好一格，避免右边被格子切掉。
         */
        const one = [...text]
        const gcp = one.length === 1 ? (one[0]?.codePointAt(0) ?? 0) : 0
        const boxW = wide ? cw * 2 : cw
        if (gcp && isGeometricGlyph(gcp)) {
          drawGeometricGlyph(ctx, gcp, px, py, boxW, ch, css(fg), (this.atlas.fontSizeDpr || 12) / 12)
        } else {
          const natural = ctx.measureText(text).width || boxW
          const sx = gcp && natural > 0 ? boxW / natural : 1
          ctx.save()
          ctx.translate(px, py + this.atlas.baseline)
          ctx.scale(sx, 1)
          ctx.fillText(text, 0, 0)
          ctx.restore()
        }
        const underline = (flags & F_UNDERLINE_MASK) >> F_UNDERLINE_SHIFT
        if (underline > 0 || (flags & F_STRIKE) !== 0) {
          // SGR 58：SGR 4:3 附带的下划线颜色（word 5），0 = 默认色
          const decoWord = this.grid[i + 5] ?? 0
          ctx.strokeStyle = css(decoWord !== 0 ? this.packed(decoWord, false) : (this.theme.underline ?? fg))
          ctx.lineWidth = Math.max(1, Math.round(this.dpr))
          const width = wide ? cw * 2 : cw
          if ((flags & F_STRIKE) !== 0) {
            ctx.beginPath()
            ctx.moveTo(px, py + ch * 0.52)
            ctx.lineTo(px + width, py + ch * 0.52)
            ctx.stroke()
          }
          if (underline > 0) {
            const ys = underline === 2 ? [0.8, 0.93] : [0.88]
            for (const ratio of ys) {
              ctx.beginPath()
              if (underline === 3) {
                for (let k = 0; k <= width; k += 2) {
                  const yy = py + ch * 0.86 + Math.sin((k / cw) * Math.PI * 4) * ch * 0.035
                  if (k === 0) ctx.moveTo(px + k, yy)
                  else ctx.lineTo(px + k, yy)
                }
              } else {
                ctx.moveTo(px, py + ch * ratio)
                ctx.lineTo(px + width, py + ch * ratio)
              }
              ctx.stroke()
            }
          }
        }
      }
    }
    // z>=0 的图片画在文字上、光标下
    this.drawImages(meta, 'above')
    this.drawCursor(meta)
  }

  private drawCursor(meta: KittyMeta): void {
    if (!meta.cursor.visible || meta.cursor.shape === 'none') return
    // kitty：闪烁的灭相完全不画光标
    if (this.blinkOff) return
    const ctx = this.ctx
    const cw = this.atlas.cellW
    const ch = this.atlas.cellH
    const x = meta.cursor.x * cw
    const y = meta.cursor.y * ch
    const c = this.theme.cursor
    ctx.fillStyle = css(c)
    switch (meta.cursor.shape) {
      case 'block':
        // 已作为单元格底色的反色块画过（见 render()），这里不能再盖一次
        break
      case 'beam':
        ctx.fillRect(x, y, Math.max(1, cw * 0.14), ch)
        break
      case 'underline':
        ctx.fillRect(x, y + ch * 0.88, cw, Math.max(1, ch * 0.12))
        break
      case 'hollow':
        ctx.strokeStyle = css(c)
        ctx.lineWidth = Math.max(1, this.dpr)
        ctx.strokeRect(x + 0.5, y + 0.5, cw - 1, ch - 1)
        break
      default:
        ctx.fillRect(x, y, cw, ch)
    }
    void this.opts
  }

  dispose(): void {
    this.meta = null
  }
}
