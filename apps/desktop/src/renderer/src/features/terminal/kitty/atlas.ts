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

/**
 * 笔画加黑（stem darkening）的查找表。
 *
 * canvas 的 `fillText` 没有 hinting：12px 下一条竖线的覆盖率通常只有 55%~70%，
 * 落在两个像素上，视觉上就是"两条灰边、发虚、毛糙"。FreeType 系终端靠 hinting
 * 把笔画吸附成整像素解决这件事，浏览器里没有这个开关，于是用一条**保端点**的
 * 覆盖度曲线把中段抬高：a' = 1-(1-a)^k。
 *
 * k 随字号变化 —— 字越小，笔画越容易被摊薄，补得越多；大字号本身笔画就够实，
 * 补太多会显得糊成一团。
 */
const DARKEN_TABLE = new Map<number, Uint8Array>()

function darkenTable(k: number): Uint8Array {
  let t = DARKEN_TABLE.get(k)
  if (t) return t
  t = new Uint8Array(256)
  for (let i = 0; i < 256; i += 1) {
    const a = i / 255
    t[i] = Math.round((1 - Math.pow(1 - a, k)) * 255)
  }
  DARKEN_TABLE.set(k, t)
  return t
}

/**
 * 制表符 / 块元素 / 阴影：**不交给字体光栅化**，直接按格子几何绘制。
 *
 * 三类都是"必须正好铺满单元格"的字符：
 * - 框线（─│┌┐└┘├┤┬┴┼ 及粗体/双线）：字形自带的线宽和位置随字体漂移，
 *   相邻格子接不上就成了一条条断开的横杠；
 * - 块元素（█▀▄▌▐ 与 1/8 分块）：字体的 em 框往往小于单元格，铺不满就留缝；
 * - 阴影（░▒▓）：字体里的点阵被缩放后变成麻点，几何填充才是均匀的。
 *
 * 按几何绘制后，制表符在任何字号下都严丝合缝、块元素是真正的实心。
 */
type Edge = 0 | 1 | 2 | 3 // 0 无 / 1 细 / 2 粗 / 3 双线

const BOX_EDGES: Record<number, [Edge, Edge, Edge, Edge]> = {
  //       左  右  上  下
  0x2500: [1, 1, 0, 0], // ─
  0x2501: [2, 2, 0, 0], // ━
  0x2502: [0, 0, 1, 1], // │
  0x2503: [0, 0, 2, 2], // ┃
  0x250c: [0, 1, 0, 1], // ┌
  0x250f: [0, 2, 0, 2], // ┏
  0x2510: [1, 0, 0, 1], // ┐
  0x2513: [2, 0, 0, 2], // ┓
  0x2514: [0, 1, 1, 0], // └
  0x2517: [0, 2, 2, 0], // ┗
  0x2518: [1, 0, 1, 0], // ┘
  0x251b: [2, 0, 2, 0], // ┛
  0x251c: [0, 1, 1, 1], // ├
  0x2523: [0, 2, 2, 2], // ┣
  0x2524: [1, 0, 1, 1], // ┤
  0x252b: [2, 0, 2, 2], // ┫
  0x252c: [1, 1, 0, 1], // ┬
  0x2533: [2, 2, 0, 2], // ┳
  0x2534: [1, 1, 1, 0], // ┴
  0x253b: [2, 2, 2, 0], // ┻
  0x253c: [1, 1, 1, 1], // ┼
  0x254b: [2, 2, 2, 2], // ╋
  0x2550: [3, 3, 0, 0], // ═
  0x2551: [0, 0, 3, 3], // ║
  0x2554: [0, 3, 0, 3], // ╔
  0x2557: [3, 0, 0, 3], // ╗
  0x255a: [0, 3, 3, 0], // ╚
  0x255d: [3, 0, 3, 0], // ╝
  0x2560: [0, 3, 3, 3], // ╠
  0x2563: [3, 0, 3, 3], // ╣
  0x2566: [3, 3, 0, 3], // ╦
  0x2569: [3, 3, 3, 0], // ╩
  0x256c: [3, 3, 3, 3], // ╬
  0x256d: [0, 1, 0, 1], // ╭
  0x256e: [1, 0, 0, 1], // ╮
  0x256f: [1, 0, 1, 0], // ╯
  0x2570: [0, 1, 1, 0], // ╰
}

/** 块元素：以「格子宽高的比例矩形」描述 */
const BLOCK_RECTS: Record<number, [number, number, number, number]> = {
  0x2588: [0, 0, 1, 1], // █
  0x2580: [0, 0, 1, 0.5], // ▀
  0x2584: [0, 0.5, 1, 1], // ▄
  0x258c: [0, 0, 0.5, 1], // ▌
  0x2590: [0.5, 0, 1, 1], // ▐
  0x2594: [0, 0, 1, 0.125], // ▔
  0x2595: [0.875, 0, 1, 1], // ▕
  0x2581: [0, 0.875, 1, 1], // ▁
  0x2582: [0, 0.75, 1, 1], // ▂
  0x2583: [0, 0.625, 1, 1], // ▃
  0x2585: [0, 0.375, 1, 1], // ▅
  0x2586: [0, 0.25, 1, 1], // ▆
  0x2587: [0, 0.125, 1, 1], // ▇
  0x2589: [0, 0, 0.875, 1], // ▉
  0x258a: [0, 0, 0.75, 1], // ▊
  0x258b: [0, 0, 0.625, 1], // ▋
  0x258d: [0, 0, 0.375, 1], // ▍
  0x258e: [0, 0, 0.25, 1], // ▎
  0x258f: [0, 0, 0.125, 1], // ▏
}

/** 阴影块：整体填充的 alpha */
const SHADE_ALPHA: Record<number, number> = {
  0x2591: 0.25, // ░
  0x2592: 0.5, // ▒
  0x2593: 0.75, // ▓
}

/** 这个码点是否由几何绘制（不查字体） */
export function isGeometricGlyph(cp: number): boolean {
  return cp in BOX_EDGES || cp in BLOCK_RECTS || cp in SHADE_ALPHA
}

/**
 * 在 (x, y, w, h) 这个单元格内几何绘制制表/块/阴影字符。
 *
 * 由 atlas 光栅化和 canvas 回退渲染器共用 —— 两条路径必须画得一模一样，
 * 否则切渲染器时制表符会突然错位。
 *
 * @returns 是否真的画了（false = 不认识，交给字体）
 */
export function drawGeometricGlyph(
  ctx: CanvasRenderingContext2D,
  cp: number,
  x: number,
  y: number,
  w: number,
  h: number,
  color: string,
  linePx: number,
): boolean {
  ctx.save()
  ctx.fillStyle = color
  const box = BOX_EDGES[cp]
  if (box) {
    const t = Math.max(1, Math.round(linePx))
    // cx/cy 是**绝对**坐标（格子原点 + 半个格），不是格内偏移
    const cx = x + Math.round(w / 2)
    const cy = y + Math.round(h / 2)
    const [left, right, up, down] = box

    /*
     * 一条边 =「从格子中心出发延伸到该方向边界」的一段。
     * 粗细按中心线对称摊开；双线是两条细线夹一道同样宽的空隙。
     * 全部用整数 fillRect：相邻格子的两段拼在一起才是笔直的连续线。
     *
     * 注意方向必须由参数传进来 —— 早先这里读的是外层的 left/right/up/down，
     * 四次调用就全按同一个方向画了（结果 │ ┌ ┬ ┼ 全都画成了一条横线）。
     */
    const seg = (edge: Edge, dir: 'left' | 'right' | 'up' | 'down'): void => {
      if (edge === 0) return
      const thick = edge === 3 ? t : edge === 2 ? Math.max(2, t * 2) : t
      const offsets = edge === 3 ? [-t - 1, 1] : [-Math.floor(thick / 2)]
      const horizontal = dir === 'left' || dir === 'right'
      for (const off of offsets) {
        if (horizontal) {
          const x0 = dir === 'left' ? x : cx
          const x1 = dir === 'right' ? x + w : cx
          ctx.fillRect(x0, cy + off, Math.max(1, x1 - x0), thick)
        } else {
          const y0 = dir === 'up' ? y : cy
          const y1 = dir === 'down' ? y + h : cy
          ctx.fillRect(cx + off, y0, thick, Math.max(1, y1 - y0))
        }
      }
    }
    seg(left, 'left')
    seg(right, 'right')
    seg(up, 'up')
    seg(down, 'down')
    ctx.restore()
    return true
  }
  const rect = BLOCK_RECTS[cp]
  if (rect) {
    const [x0, y0, x1, y1] = rect
    ctx.fillRect(
      x + Math.round(w * x0),
      y + Math.round(h * y0),
      Math.max(1, Math.round(w * (x1 - x0))),
      Math.max(1, Math.round(h * (y1 - y0))),
    )
    ctx.restore()
    return true
  }
  const alpha = SHADE_ALPHA[cp]
  if (alpha !== undefined) {
    ctx.globalAlpha = alpha
    ctx.fillRect(x, y, w, h)
    ctx.restore()
    return true
  }
  ctx.restore()
  return false
}

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
  private advanceExact: number
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
    const targetW = this.cellW * span
    ctx.save()
    ctx.font = cssFont
    ctx.textBaseline = 'alphabetic'
    ctx.clearRect(rect.x, rect.y, rect.w, rect.h)
    const colored = COLOR_GLYPH.test(text)
    ctx.fillStyle = '#ffffff'

    const cp = text.length === 1 ? text.codePointAt(0) ?? 0 : 0
    let geometric = false
    if (cp !== 0 && !colored) {
      // 制表/块/阴影按几何画：不查字体，任何字号都严丝合缝
      // 线宽随字号：12px → 1px，24px → 2px（与 kitty 的观感一致）
      geometric = drawGeometricGlyph(
        ctx,
        cp,
        rect.x + PAD,
        rect.y + PAD,
        targetW,
        this.cellH,
        '#ffffff',
        (this.opts.fontSize * this.opts.dpr) / 12,
      )
    }

    if (!geometric) {
      /*
       * 关键一步：**横向缩放到正好一格**。
       *
       * 之前是「原样 fillText 到 cellW×cellH 的框里」，而 cellW 是取整后的值
       * （12px 的等宽字体 advance ≈ 7.22 → cellW = 7），于是字形右边 0.2~0.5px
       * 被格子边界切掉 —— 屏幕上就是每个字母右边缘被"抠"掉一条。
       * 中日韩字符更明显：字体给它们 1em 的宽度（12px），而网格给两格（14px），
       * 不缩放就会两边各空 1px，看起来稀稀拉拉。
       *
       * 缩放比例每格最多差 3%，肉眼看不出来，但裁切和缝隙都没了。
       * 彩色字形（emoji）不缩放：拉伸 emoji 会变形，只在格子里居中。
       */
      const natural = ctx.measureText(text).width || targetW
      if (colored) {
        ctx.fillText(text, rect.x + PAD + (targetW - natural) / 2, rect.y + PAD + this.baseline)
      } else {
        const sx = targetW / natural
        ctx.save()
        ctx.translate(rect.x + PAD, rect.y + PAD + this.baseline)
        ctx.scale(sx, 1)
        ctx.fillText(text, 0, 0)
        ctx.restore()
      }
    }
    ctx.restore()

    // 笔画加黑：只在文本字形上做（几何字符本来就是实心、emoji 是位图）
    if (!geometric && !colored) this.darken(rect)

    const entry: GlyphEntry = {
      u0: (rect.x + PAD) / ATLAS_SIZE,
      v0: (rect.y + PAD) / ATLAS_SIZE,
      u1: (rect.x + PAD + targetW) / ATLAS_SIZE,
      v1: (rect.y + PAD + this.cellH) / ATLAS_SIZE,
      span,
      colored,
    }
    const key = `${style.bold ? 'b' : 'n'}${style.italic ? 'i' : 'n'}:${span}:${text}`
    this.cache.set(key, entry)
    this.markDirty(rect)
    return entry
  }

  /**
   * 覆盖度曲线：把 AA 灰边抬成"实笔画"。
   *
   * 没有 hinting 的 12px 文字，竖线往往落在两像素中间，各 60% 左右的覆盖率，
   * 屏幕上是一条 2px 的灰色带子 —— 用户看到的就是"毛糙、发虚、像抠图没抠干净"。
   * 这里对图集里这一小块做一次逐像素变换（每个字形只做一次，成本可忽略）。
   */
  private darken(rect: Rect): void {
    const fontPx = Math.round(this.opts.fontSize * this.opts.dpr)
    // 小字补得多，大字几乎不补。k=1.85 时 12px 会明显变粗（像加了个假粗体），
    // 1.3 是"笔画实了但字重没变"的位置
    const k = fontPx <= 14 ? 1.3 : fontPx <= 20 ? 1.18 : 1.06
    const lut = darkenTable(k)
    const img = this.ctx.getImageData(rect.x, rect.y, rect.w, rect.h)
    const d = img.data
    for (let i = 3; i < d.length; i += 4) {
      const a = d[i]!
      if (a === 0 || a === 255) continue
      d[i] = lut[a]!
    }
    this.ctx.putImageData(img, rect.x, rect.y)
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
