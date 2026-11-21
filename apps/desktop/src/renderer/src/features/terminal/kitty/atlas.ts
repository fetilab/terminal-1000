// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 字形图集（glyph atlas）。
 *
 * 做法与 kitty 的 `fonts.c` 相同：**按需光栅化 + 图集缓存**。渲染时每帧只查表，
 * 遇到新字形才进 2D canvas 画一次，然后把那一小块用 `texSubImage2D` 补进图集，
 * 绝不重建整张纹理。
 *
 * 与 kitty 的差异（都是为了 Web 环境）：
 * - 用 canvas 的 `fillText` 代替 FreeType/HarfBuzz：**系统字体栈**由 CSS 决定，
 *   emoji / Nerd Font 回退由浏览器自己完成，不需要我们维护字体列表；
 * - 连字：以「整段同一样式」为单位光栅化，一段只占一个 atlas 条目（`span > 1`），
 *   渲染时拉成一个宽 quad。这既保留了连字，也不用实现 shaping；
 * - 彩色字形（emoji）单独标记，着色器里不乘前景色。
 */

export interface GlyphStyle {
  bold: boolean
  italic: boolean
}

export interface GlyphEntry {
  /** 图集内的纹理坐标（0..1） */
  u0: number
  v0: number
  u1: number
  v1: number
  /** 覆盖几列（连字/多字符集群） */
  span: number
  /** 彩色字形（emoji）：着色器不乘前景色 */
  colored: boolean
}

interface Rect {
  x: number
  y: number
  w: number
  h: number
}

const ATLAS_SIZE = 2048
const PAD = 1

/** 是否彩色字形（emoji 与部分符号）。用 Unicode 属性判断，比列举区间可靠。 */
const COLOR_GLYPH = /\p{Extended_Pictographic}|\p{Regional_Indicator}/u

export interface AtlasOptions {
  fontFamily: string
  fontSize: number
  fontWeight: number
  boldWeight: number
  fontFeatures: string[]
  ligatures: boolean
  dpr: number
}

export class GlyphAtlas {
  readonly canvas: HTMLCanvasElement
  private readonly ctx: CanvasRenderingContext2D
  private readonly cache = new Map<string, GlyphEntry>()
  private readonly opts: AtlasOptions
  /** 单元格尺寸（设备像素） */
  readonly cellW: number
  readonly cellH: number
  readonly baseline: number
  private shelfY = 0
  private shelfH = 0
  private penX = 0
  /** 未取整的单格步进（连字判定要用精确值，取整后的 cellW 会误判普通文本） */
  private advanceExact = 0
  /** 待上传的脏区（合并成一次 texSubImage2D） */
  private dirty: Rect | null = null
  private fullUpload = true

  constructor(opts: AtlasOptions) {
    this.opts = opts
    this.canvas = document.createElement('canvas')
    this.canvas.width = ATLAS_SIZE
    this.canvas.height = ATLAS_SIZE
    const ctx = this.canvas.getContext('2d', { alpha: true })
    if (!ctx) throw new Error('无法创建 2D 画布（字形图集）')
    this.ctx = ctx
    const { cssFont, fontPx } = this.fontOf(false)
    this.ctx.font = cssFont
    const metrics = this.ctx.measureText('M')
    const advance = metrics.width || fontPx * 0.6
    this.advanceExact = advance
    this.cellW = Math.max(1, Math.round(advance))
    const ascent = metrics.fontBoundingBoxAscent || metrics.actualBoundingBoxAscent || fontPx * 0.8
    const descent = metrics.fontBoundingBoxDescent || metrics.actualBoundingBoxDescent || fontPx * 0.2
    const lineHeightPx = Math.round(fontPx * 1.2)
    this.cellH = Math.max(Math.round(ascent + descent) + 2, Math.round(lineHeightPx))
    this.baseline = Math.round((this.cellH - (ascent + descent)) / 2 + ascent)
  }

  /** canvas 回退渲染器要用的字号（设备像素） */
  get fontSizeDpr(): number {
    return Math.round(this.opts.fontSize * this.opts.dpr)
  }

  get fontWeight(): number {
    return this.opts.fontWeight
  }

  get fontFamilyCss(): string {
    return this.opts.fontFamily
  }

  private fontOf(bold: boolean): { cssFont: string; fontPx: number } {
    const weight = bold ? this.opts.boldWeight : this.opts.fontWeight
    const fontPx = Math.round(this.opts.fontSize * this.opts.dpr)
    const features = this.opts.fontFeatures.length > 0 ? `font-feature-settings: ${this.opts.fontFeatures.join(', ')};` : ''
    void features
    return {
      cssFont: `${weight} ${fontPx}px ${this.opts.fontFamily}`,
      fontPx,
    }
  }

  /** 计算一段文本的覆盖列数（等宽字体下就是字符数，宽字符按 2 算） */
  private spanOf(text: string): number {
    let span = 0
    for (const ch of text) {
      const cp = ch.codePointAt(0) ?? 0
      // 宽的判定与 Unicode EastAsianWidth 的常用区间一致；内核给出的 WIDE 标志更权威，
      // 这里只是给图集条目定宽，差一列也只影响这一段的裁剪边界
      span += isWide(cp) ? 2 : 1
    }
    return Math.max(1, span)
  }

  /** 取一个字形条目；没有就现光栅化 */
  entry(text: string, style: GlyphStyle, span: number): GlyphEntry {
    const key = `${style.bold ? 'b' : 'n'}${style.italic ? 'i' : 'n'}:${span}:${text}`
    const hit = this.cache.get(key)
    if (hit) return hit

    const { cssFont } = this.fontOf(style.bold)
    this.ctx.font = cssFont
    this.ctx.textBaseline = 'alphabetic'
    const w = Math.max(1, Math.min(ATLAS_SIZE, this.cellW * span))
    const h = this.cellH
    const rect = this.alloc(w + PAD * 2, h + PAD * 2)
    if (!rect) {
      // 图集满：粗暴但正确 —— 清空重来。终端里常见字形是有限的，
      // 触发一次重建比"悄悄画不出字"好得多。
      this.reset()
      const again = this.alloc(w + PAD * 2, h + PAD * 2)
      if (!again) throw new Error('字形图集已满')
      return this.rasterize(text, style, span, again)
    }
    return this.rasterize(text, style, span, rect)
  }

  private rasterize(text: string, style: GlyphStyle, span: number, rect: Rect): GlyphEntry {
    const { cssFont } = this.fontOf(style.bold)
    const ctx = this.ctx
    ctx.save()
    ctx.font = cssFont
    ctx.textBaseline = 'alphabetic'
    ctx.clearRect(rect.x, rect.y, rect.w, rect.h)
    const colored = COLOR_GLYPH.test(text)
    ctx.fillStyle = colored ? '#ffffff' : '#ffffff'
    ctx.fillText(text, rect.x + PAD, rect.y + PAD + this.baseline)
    ctx.restore()

    const entry: GlyphEntry = {
      u0: (rect.x + PAD) / ATLAS_SIZE,
      v0: (rect.y + PAD) / ATLAS_SIZE,
      u1: (rect.x + PAD + this.cellW * span) / ATLAS_SIZE,
      v1: (rect.y + PAD + this.cellH) / ATLAS_SIZE,
      span,
      colored,
    }
    const key = `${style.bold ? 'b' : 'n'}${style.italic ? 'i' : 'n'}:${span}:${text}`
    this.cache.set(key, entry)
    this.markDirty(rect)
    return entry
  }

  private reset(): void {
    this.cache.clear()
    this.ctx.clearRect(0, 0, ATLAS_SIZE, ATLAS_SIZE)
    this.shelfY = 0
    this.shelfH = 0
    this.penX = 0
    this.fullUpload = true
    this.dirty = null
  }

  /** 货架式分配：一行一行铺，铺满换下一行 */
  private alloc(w: number, h: number): Rect | null {
    if (w > ATLAS_SIZE) return null
    if (this.penX + w > ATLAS_SIZE) {
      this.shelfY += this.shelfH
      this.shelfH = 0
      this.penX = 0
    }
    if (this.shelfY + h > ATLAS_SIZE) return null
    const rect = { x: this.penX, y: this.shelfY, w, h }
    this.penX += w
    this.shelfH = Math.max(this.shelfH, h)
    return rect
  }

  private markDirty(rect: Rect): void {
    if (!this.dirty) {
      this.dirty = { ...rect }
      return
    }
    const x0 = Math.min(this.dirty.x, rect.x)
    const y0 = Math.min(this.dirty.y, rect.y)
    const x1 = Math.max(this.dirty.x + this.dirty.w, rect.x + rect.w)
    const y1 = Math.max(this.dirty.y + this.dirty.h, rect.y + rect.h)
    this.dirty = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
  }

  /**
   * 把新增字形补进纹理。
   * @returns true 表示这次是全量上传（首次或图集重建）
   */
  upload(gl: WebGL2RenderingContext, texture: WebGLTexture): boolean {
    gl.bindTexture(gl.TEXTURE_2D, texture)
    if (this.fullUpload) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.canvas)
      this.fullUpload = false
      this.dirty = null
      return true
    }
    const d = this.dirty
    if (!d) return false
    // 走 getImageData + ArrayBufferView，不用「DOM 源 + 源矩形」的 texSubImage2D 重载：
    // 后者在部分实现（SwiftShader / 旧驱动）下静默不生效，字形会整块消失。
    // 画布是 premultiplied，getImageData 给回非预乘的 straight alpha，与默认的
    // UNPACK_PREMULTIPLY_ALPHA_WEBGL=false 匹配。
    const img = this.ctx.getImageData(d.x, d.y, d.w, d.h)
    gl.texSubImage2D(gl.TEXTURE_2D, 0, d.x, d.y, d.w, d.h, gl.RGBA, gl.UNSIGNED_BYTE, img.data)
    this.dirty = null
    return false
  }

  /**
   * 这段文本在这套字体下是否真的会被「连起来」。
   *
   * 判据很朴素：整段成形的宽度明显小于逐字宽度之和。像 `->`、`!=`、`=>` 这类
   * 连字在 JetBrains Mono / Fira Code 里都满足；普通 `abc` 不满足，于是回退到
   * 逐格绘制（保持每格可独立着色与选中）。
   */
  hasLigature(text: string, span: number): boolean {
    if (span < 2) return false
    const { cssFont } = this.fontOf(false)
    this.ctx.save()
    this.ctx.font = cssFont
    const width = this.ctx.measureText(text).width
    this.ctx.restore()
    // 用未取整的步进比较：等宽字体下普通文本宽度 == span*advance（浮点级相等），
    // 取整后的 cellW 会造成 0.5~几像素的假差，把普通单词误判成连字
    return width > 0 && width < span * this.advanceExact - 0.5
  }

  /** 供 canvas 回退渲染器直接取像素源 */
  get source(): HTMLCanvasElement {
    return this.canvas
  }
}

/** East Asian Wide / Fullwidth 的常用判定（与内核的宽度表方向一致，不追求逐码点一致） */
export function isWide(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x1f680 && cp <= 0x1f6ff) ||
    (cp >= 0x1f1e6 && cp <= 0x1f1ff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  )
}
