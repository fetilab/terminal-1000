// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 自有 WebGL2 渲染器（第三层）。
 *
 * 只消费 kitty 内核给出的单元格 ABI（8×u32/格），不解析任何转义序列。
 *
 * ## 实例化布局
 *
 * 一个终端有 `rows * cols` 个格子，每个格子**固定占一个实例槽位**，三个 pass
 * 各自一段连续显存：
 *
 * ```text
 * | bg pass (rows*cols) | glyph pass (rows*cols) | deco pass (rows*cols) |
 * ```
 *
 * 槽位固定的好处：某一行脏了，只需要 `bufferSubData` 覆盖那一行的 3 段，
 * 既不重建整块缓冲，也不用维护稀疏映射。空槽位把实例写成退化三角形（尺寸 0），
 * 10k 个退化实例对 GPU 来说几乎没有成本。
 *
 * ## 为什么不用 `<canvas>` 逐格 fillText
 *
 * 那是回退路径（`canvas-renderer.ts`）。逐格 `fillText` 每帧要走一次字形查找 +
 * 光栅化路径，40×120 的窗口在滚屏时就能把主线程吃满；实例化渲染把这件事压成
 * 3 次 draw call。
 */

import type { KittyMeta, KittyRow, KittySelectionSpan } from '@t1000/shared'
import { KITTY_CELL_WORDS } from '@t1000/shared'
import { GlyphAtlas } from './atlas'
import type { RenderTheme, Rgba } from './theme'
import { parseHex } from './theme'

/** 每个实例的 float 数：cell(2) + uv(4) + color(4) + flags(4) */
const FLOATS = 14
const STRIDE = FLOATS * 4

/** 单元格标志位（与内核一致） */
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

/** attach 到一行的高亮规则（绝对行号） */
export interface HighlightSpan {
  line: number
  x1: number
  x2: number
  color: Rgba
}

/** 搜索命中（绝对行号） */
export interface SearchSpan {
  line: number
  x1: number
  x2: number
}

export interface RendererOptions {
  ligatures: boolean
  /** 行间斑马纹（这个渲染器能真正画出来） */
  zebra: boolean
}

const VERT = `#version 300 es
precision highp float;
layout(location=0) in vec2 a_cell;
layout(location=1) in vec4 a_uv;
layout(location=2) in vec4 a_color;
layout(location=3) in vec4 a_flags;

uniform vec2 u_res;
uniform vec2 u_cell;
uniform float u_pass;   // 0 = 背景/实心, 1 = 字形, 2 = 装饰线

out vec2 v_uv;
out vec4 v_color;
out vec4 v_flags;
out vec2 v_local;

const vec2 QUAD[6] = vec2[6](
  vec2(0.0, 0.0), vec2(1.0, 0.0), vec2(0.0, 1.0),
  vec2(0.0, 1.0), vec2(1.0, 0.0), vec2(1.0, 1.0)
);

void main() {
  vec2 corner = QUAD[gl_VertexID];
  // pass 0（背景/光标）用 flags.xy 当尺寸倍数：背景是 1×1，光标可以是细条；
  // pass 1（字形）用 flags.z 当列数倍数：连字/宽字符的 quad 要横跨 span 格
  vec2 size = vec2(1.0);
  if (u_pass < 0.5) size = a_flags.xy;
  else if (u_pass < 1.5) size = vec2(max(a_flags.z, 1.0), 1.0);
  vec2 px = (a_cell + corner * size) * u_cell;
  vec2 clip = vec2(px.x / u_res.x * 2.0 - 1.0, 1.0 - px.y / u_res.y * 2.0);
  gl_Position = vec4(clip, 0.0, 1.0);
  v_uv = vec2(mix(a_uv.x, a_uv.z, corner.x), mix(a_uv.y, a_uv.w, corner.y));
  v_color = a_color;
  v_flags = a_flags;
  v_local = corner;
}`

const FRAG = `#version 300 es
precision highp float;
in vec2 v_uv;
in vec4 v_color;
in vec4 v_flags;
in vec2 v_local;

uniform sampler2D u_atlas;
uniform float u_pass;
uniform float u_blinkOff;

out vec4 outColor;

void main() {
  if (u_pass < 0.5) {
    // 背景/光标/图片：纯色，alpha 由 CPU 侧算好
    outColor = v_color;
    return;
  }
  if (u_pass < 1.5) {
    if (u_blinkOff > 0.5 && v_flags.y > 0.5) discard;
    vec4 tex = texture(u_atlas, v_uv);
    if (tex.a < 0.02) discard;
    vec3 rgb = mix(v_color.rgb, tex.rgb, step(0.5, v_flags.x));
    outColor = vec4(rgb, tex.a * v_color.a);
    return;
  }
  // 装饰线：u_flags.z 是样式（1 直/2 双/3 波浪/4 点/5 虚/9 删除线）
  float style = v_flags.z;
  float y = v_local.y;
  bool on = false;
  float thickness = v_flags.w;
  if (style > 8.5) {
    on = abs(y - 0.52) < thickness;
  } else if (style > 4.5) {
    // 虚线
    on = y > 0.86 - thickness && y < 0.86 + thickness && fract(v_local.x * 2.0) < 0.62;
  } else if (style > 3.5) {
    // 点线
    on = y > 0.86 - thickness && y < 0.86 + thickness && fract(v_local.x * 2.0) < 0.34;
  } else if (style > 2.5) {
    // 波浪
    float wave = 0.86 + sin(v_local.x * 12.566) * 0.035;
    on = abs(y - wave) < thickness;
  } else if (style > 1.5) {
    // 双下划线
    on = (abs(y - 0.80) < thickness) || (abs(y - 0.93) < thickness);
  } else {
    on = abs(y - 0.88) < thickness;
  }
  if (!on) discard;
  outColor = v_color;
}`

export class WebGLTerminalRenderer {
  readonly canvas: HTMLCanvasElement
  readonly gl: WebGL2RenderingContext
  readonly atlas: GlyphAtlas
  private readonly program: WebGLProgram
  private readonly vao: WebGLVertexArrayObject
  private readonly buffer: WebGLBuffer
  private readonly cursorBuffer: WebGLBuffer
  private readonly cursorVao: WebGLVertexArrayObject
  private atlasTex: WebGLTexture | null = null
  private theme: RenderTheme
  private opts: RendererOptions

  private cols = 80
  private rows = 24
  private meta: KittyMeta | null = null
  private grid: Uint32Array = new Uint32Array(0)
  private rowValid: Uint8Array = new Uint8Array(0)
  private instances: Float32Array = new Float32Array(0)
  private dirty = new Set<number>()
  private highlights: HighlightSpan[] = []
  private search: SearchSpan[] = []
  private searchActive = -1
  private cursorInstances = new Float32Array(FLOATS * 4)
  private blinkOff = false
  private disposed = false
  private dpr: number

  constructor(
    canvas: HTMLCanvasElement,
    atlas: GlyphAtlas,
    theme: RenderTheme,
    opts: RendererOptions,
    dpr: number,
  ) {
    this.canvas = canvas
    this.atlas = atlas
    this.theme = theme
    this.opts = opts
    this.dpr = dpr
    const gl = canvas.getContext('webgl2', {
      alpha: true,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
      powerPreference: 'high-performance',
    })
    if (!gl) throw new Error('WebGL2 不可用')
    this.gl = gl
    this.program = this.link()
    const vao = gl.createVertexArray()
    const buffer = gl.createBuffer()
    const cursorBuffer = gl.createBuffer()
    const cursorVao = gl.createVertexArray()
    if (!vao || !buffer || !cursorBuffer || !cursorVao) throw new Error('WebGL 资源分配失败')
    this.vao = vao
    this.buffer = buffer
    this.cursorBuffer = cursorBuffer
    this.cursorVao = cursorVao
    this.setupVao(this.vao, this.buffer)
    this.setupVao(this.cursorVao, this.cursorBuffer)
    gl.disable(gl.DEPTH_TEST)
    gl.enable(gl.BLEND)
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
  }

  private link(): WebGLProgram {
    const gl = this.gl
    const compile = (type: number, src: string): WebGLShader => {
      const sh = gl.createShader(type)
      if (!sh) throw new Error('createShader 失败')
      gl.shaderSource(sh, src)
      gl.compileShader(sh)
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        const log = gl.getShaderInfoLog(sh) ?? ''
        throw new Error(`着色器编译失败：${log}`)
      }
      return sh
    }
    const prog = gl.createProgram()
    if (!prog) throw new Error('createProgram 失败')
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT))
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAG))
    gl.linkProgram(prog)
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error(`着色器链接失败：${gl.getProgramInfoLog(prog) ?? ''}`)
    }
    return prog
  }

  private setupVao(vao: WebGLVertexArrayObject, buffer: WebGLBuffer): void {
    const gl = this.gl
    gl.bindVertexArray(vao)
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
    const loc = (name: string): number => gl.getAttribLocation(this.program, name)
    gl.enableVertexAttribArray(loc('a_cell'))
    gl.vertexAttribPointer(loc('a_cell'), 2, gl.FLOAT, false, STRIDE, 0)
    gl.vertexAttribDivisor(loc('a_cell'), 1)
    gl.enableVertexAttribArray(loc('a_uv'))
    gl.vertexAttribPointer(loc('a_uv'), 4, gl.FLOAT, false, STRIDE, 2 * 4)
    gl.vertexAttribDivisor(loc('a_uv'), 1)
    gl.enableVertexAttribArray(loc('a_color'))
    gl.vertexAttribPointer(loc('a_color'), 4, gl.FLOAT, false, STRIDE, 6 * 4)
    gl.vertexAttribDivisor(loc('a_color'), 1)
    gl.enableVertexAttribArray(loc('a_flags'))
    gl.vertexAttribPointer(loc('a_flags'), 4, gl.FLOAT, false, STRIDE, 10 * 4)
    gl.vertexAttribDivisor(loc('a_flags'), 1)
    gl.bindVertexArray(null)
  }

  setTheme(theme: RenderTheme): void {
    this.theme = theme
    for (let y = 0; y < this.rows; y += 1) this.dirty.add(y)
  }

  setOptions(opts: RendererOptions): void {
    this.opts = opts
    for (let y = 0; y < this.rows; y += 1) this.dirty.add(y)
  }

  setHighlights(spans: HighlightSpan[]): void {
    this.highlights = spans
    for (let y = 0; y < this.rows; y += 1) this.dirty.add(y)
  }

  setSearch(spans: SearchSpan[], active: number): void {
    this.search = spans
    this.searchActive = active
    for (let y = 0; y < this.rows; y += 1) this.dirty.add(y)
  }

  setBlinkOff(off: boolean): boolean {
    if (this.blinkOff === off) return false
    this.blinkOff = off
    return true
  }

  /** 画布尺寸（CSS 像素）；返回是否需要重排 */
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

  /** 只重排网格（不改画布像素尺寸） */
  setGrid(cols: number, rows: number): void {
    if (cols === this.cols && rows === this.rows) return
    this.cols = cols
    this.rows = rows
    this.grid = new Uint32Array(cols * rows * KITTY_CELL_WORDS)
    this.rowValid = new Uint8Array(rows)
    this.instances = new Float32Array(cols * rows * FLOATS * 3)
    const gl = this.gl
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer)
    gl.bufferData(gl.ARRAY_BUFFER, this.instances.byteLength, gl.DYNAMIC_DRAW)
    for (let y = 0; y < rows; y += 1) this.dirty.add(y)
  }

  applyFrame(meta: KittyMeta, rows: KittyRow[], full: boolean): void {
    this.setGrid(meta.cols, meta.rows)
    this.meta = meta
    if (full) for (let y = 0; y < this.rows; y += 1) this.dirty.add(y)
    for (const row of rows) {
      if (row.y < 0 || row.y >= this.rows) continue
      const dst = new Uint32Array(this.grid.buffer, row.y * this.cols * KITTY_CELL_WORDS * 4, this.cols * KITTY_CELL_WORDS)
      const src = new Uint32Array(row.words)
      dst.set(src.subarray(0, Math.min(src.length, dst.length)))
      this.rowValid[row.y] = 1
      this.dirty.add(row.y)
    }
    // 行数/列数变化后，新行没有数据 —— 视为全空
    for (let y = 0; y < this.rows; y += 1) {
      if (!this.rowValid[y]) {
        this.dirty.add(y)
        this.rowValid[y] = 1
      }
    }
  }

  /** 供主线程合成光标闪烁时判断是否有可见内容 */
  get hasFrame(): boolean {
    return this.meta !== null
  }

  /* ─────────────────────────── 构建实例 ─────────────────────────── */

  private rgba(color: Rgba, alphaScale = 1): [number, number, number, number] {
    return [color.r, color.g, color.b, color.a * alphaScale]
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

  private selectionAt(y: number): KittySelectionSpan | null {
    const spans = this.meta?.selection
    if (!spans) return null
    for (const s of spans) if (s.y === y) return s
    return null
  }

  private highlightAt(abs: number, x: number): Rgba | null {
    for (const span of this.highlights) {
      if (span.line === abs && x >= span.x1 && x <= span.x2) return span.color
    }
    return null
  }

  private searchHitAt(abs: number, x: number): 0 | 1 | 2 {
    let found: 0 | 1 | 2 = 0
    for (let i = 0; i < this.search.length; i += 1) {
      const span = this.search[i]
      if (!span || span.line !== abs || x < span.x1 || x > span.x2) continue
      found = i === this.searchActive ? 2 : Math.max(found, 1) as 1 | 2
    }
    return found
  }

  private buildRow(y: number): void {
    const cols = this.cols
    const rows = this.rows
    const grid = this.grid
    const inst = this.instances
    const N = cols * rows
    const rowBase = y * cols
    const bgBase = rowBase * FLOATS
    const glyphBase = (N + rowBase) * FLOATS
    const decoBase = (2 * N + rowBase) * FLOATS
    const atlas = this.atlas
    const abs = (this.meta?.scrollbackLength ?? 0) - (this.meta?.scrolledBy ?? 0) + y
    const sel = this.selectionAt(y)
    const zebra = this.opts.zebra && y % 2 === 1
    const blinkOff = this.blinkOff ? 1 : 0
    // 连字段占多列：段内后续列不再画独立字形
    let glyphSkipUntil = -1

    for (let x = 0; x < cols; x += 1) {
      const i = (rowBase + x) * KITTY_CELL_WORDS
      const ch = grid[i] ?? 0
      const cc1 = grid[i + 1] ?? 0
      const cc2 = grid[i + 2] ?? 0
      const flags = grid[i + 6] ?? 0
      const bold = (flags & F_BOLD) !== 0
      const dim = (flags & F_DIM) !== 0
      const italic = (flags & F_ITALIC) !== 0
      const reverse = (flags & F_REVERSE) !== 0
      const strike = (flags & F_STRIKE) !== 0
      const blink = (flags & F_BLINK) !== 0
      const wideTrail = (flags & F_WIDE_TRAIL) !== 0
      const wide = (flags & F_WIDE) !== 0
      let underline = (flags & F_UNDERLINE_MASK) >> F_UNDERLINE_SHIFT

      let fg = this.packed(grid[i + 3] ?? 0, false)
      let bg = this.packed(grid[i + 4] ?? 0, true)
      if (reverse) {
        const tmp = fg
        fg = { ...bg, a: 1 }
        bg = { ...tmp, a: this.theme.bg.a }
      }
      if (dim) fg = { ...fg, r: fg.r * 0.62, g: fg.g * 0.62, b: fg.b * 0.62 }
      if (zebra && !reverse) bg = { ...bg, r: bg.r + 0.03, g: bg.g + 0.03, b: bg.b + 0.05 }

      const selected = sel !== null && x >= sel.x1 && x <= sel.x2
      if (selected) {
        bg = this.theme.selectionBg
        fg = this.theme.selectionFg
      }
      const hit = this.searchHitAt(abs, x)
      if (hit > 0 && !selected) {
        bg = hit === 2 ? parseHex('#f5c451', 0.85) : parseHex('#f5c451', 0.38)
        fg = parseHex('#101318', 1)
      }
      const hi = this.highlightAt(abs, x)
      if (hi) fg = hi

      // 背景实例
      const cc = this.rgba(bg)
      const ob = bgBase + x * FLOATS
      inst[ob] = x
      inst[ob + 1] = y
      inst[ob + 2] = 0
      inst[ob + 3] = 0
      inst[ob + 4] = 0
      inst[ob + 5] = 0
      inst[ob + 6] = cc[0]
      inst[ob + 7] = cc[1]
      inst[ob + 8] = cc[2]
      inst[ob + 9] = cc[3]
      inst[ob + 10] = 1
      inst[ob + 11] = 1
      inst[ob + 12] = 0
      inst[ob + 13] = 0

      // 字形实例
      const og = glyphBase + x * FLOATS
      const empty = !ch || wideTrail || x <= glyphSkipUntil
      if (empty) {
        this.zero(inst, og)
      } else {
        let text = String.fromCodePoint(ch)
        if (cc1) text += String.fromCodePoint(cc1)
        if (cc2) text += String.fromCodePoint(cc2)
        // 连字：整段同一样式的连续 ASCII 交给图集做一次成形
        let span = wide ? 2 : 1
        if (this.opts.ligatures && !wide && ch < 0x7f && x + 1 < cols) {
          const run = this.ligatureRun(y, x)
          if (run && run.span > 1) {
            text = run.text
            span = run.span
          }
        }
        const entry = atlas.entry(text, { bold, italic }, span)
        const fc = this.rgba(fg)
        inst[og] = x
        inst[og + 1] = y
        inst[og + 2] = entry.u0
        inst[og + 3] = entry.v0
        inst[og + 4] = entry.u1
        inst[og + 5] = entry.v1
        inst[og + 6] = fc[0]
        inst[og + 7] = fc[1]
        inst[og + 8] = fc[2]
        inst[og + 9] = fc[3]
        inst[og + 10] = entry.colored ? 1 : 0
        inst[og + 11] = blink && blinkOff ? 1 : 0
        // pass1 的 quad 横向倍数 = 覆盖列数（宽字符 2、连字 span）
        inst[og + 12] = span
        inst[og + 13] = 0
        if (span > 1) glyphSkipUntil = x + span - 1
      }

      // 装饰线
      const od = decoBase + x * FLOATS
      const decoColor = this.theme.underline ?? fg
      if (underline > 0 || strike) {
        const dc = this.rgba(decoColor)
        inst[od] = x
        inst[od + 1] = y
        inst[od + 6] = dc[0]
        inst[od + 7] = dc[1]
        inst[od + 8] = dc[2]
        inst[od + 9] = dc[3]
        inst[od + 10] = 0
        inst[od + 11] = 0
        inst[od + 12] = strike && underline === 0 ? 9 : underline
        inst[od + 13] = 0.055
      } else {
        this.zero(inst, od)
      }
    }
  }

  /** 用零尺寸实例占位（不画任何东西） */
  private zero(inst: Float32Array, offset: number): void {
    for (let k = 0; k < FLOATS; k += 1) inst[offset + k] = 0
  }

  /** 连字游程：返回整段文本与覆盖列数 */
  private ligatureRun(y: number, x: number): { text: string; span: number } | null {
    const cols = this.cols
    const base = (y * cols + x) * KITTY_CELL_WORDS
    const flags0 = this.grid[base + 6] ?? 0
    let text = ''
    let span = 0
    for (let k = 0; x + k < cols; k += 1) {
      const i = (y * cols + x + k) * KITTY_CELL_WORDS
      const ch = this.grid[i] ?? 0
      const flags = this.grid[i + 6] ?? 0
      if (ch === 0 || ch >= 0x7f || (flags & (F_WIDE | F_WIDE_TRAIL)) !== 0) break
      if ((flags & (F_BOLD | F_ITALIC)) !== (flags0 & (F_BOLD | F_ITALIC))) break
      if ((this.grid[i + 3] ?? 0) !== (this.grid[base + 3] ?? 0)) break
      text += String.fromCodePoint(ch)
      span += 1
      if (span >= 6) break
    }
    if (span < 2) return null
    if (!this.atlas.hasLigature(text, span)) return null
    return { text, span }
  }

  /* ───────────────────────────── 绘制 ───────────────────────────── */

  render(): void {
    if (this.disposed) return
    const gl = this.gl
    const N = this.cols * this.rows
    if (N === 0) return

    if (!this.atlasTex) {
      const tex = gl.createTexture()
      if (!tex) return
      this.atlasTex = tex
      gl.bindTexture(gl.TEXTURE_2D, tex)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    }

    // 先建实例、再传图集：buildRow 会把新字形光栅化进图集画布，
    // upload 必须发生在其后，否则首帧纹理是空的（字形整帧消失）。
    if (this.dirty.size > 0) {
      for (const y of this.dirty) this.buildRow(y)
      gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer)
      const rowFloats = this.cols * FLOATS
      for (const y of this.dirty) {
        const byteOffset = (y * this.cols) * FLOATS * 4
        const secondOffset = (N + y * this.cols) * FLOATS * 4
        const thirdOffset = (2 * N + y * this.cols) * FLOATS * 4
        gl.bufferSubData(gl.ARRAY_BUFFER, byteOffset, this.instances, (y * this.cols) * FLOATS, rowFloats)
        gl.bufferSubData(gl.ARRAY_BUFFER, secondOffset, this.instances, (N + y * this.cols) * FLOATS, rowFloats)
        gl.bufferSubData(gl.ARRAY_BUFFER, thirdOffset, this.instances, (2 * N + y * this.cols) * FLOATS, rowFloats)
      }
      this.dirty.clear()
    }
    this.atlas.upload(gl, this.atlasTex)

    gl.viewport(0, 0, this.canvas.width, this.canvas.height)
    gl.clearColor(this.theme.bg.r, this.theme.bg.g, this.theme.bg.b, this.theme.bg.a)
    gl.clear(gl.COLOR_BUFFER_BIT)

    gl.useProgram(this.program)
    gl.uniform2f(gl.getUniformLocation(this.program, 'u_res'), this.canvas.width, this.canvas.height)
    gl.uniform2f(gl.getUniformLocation(this.program, 'u_cell'), this.atlas.cellW, this.atlas.cellH)
    gl.uniform1f(gl.getUniformLocation(this.program, 'u_blinkOff'), this.blinkOff ? 1 : 0)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.atlasTex)
    gl.uniform1i(gl.getUniformLocation(this.program, 'u_atlas'), 0)

    const passLoc = gl.getUniformLocation(this.program, 'u_pass')
    const drawPass = (pass: number): void => {
      gl.bindVertexArray(this.vao)
      gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer)
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, STRIDE, pass * N * STRIDE)
      gl.vertexAttribPointer(1, 4, gl.FLOAT, false, STRIDE, pass * N * STRIDE + 2 * 4)
      gl.vertexAttribPointer(2, 4, gl.FLOAT, false, STRIDE, pass * N * STRIDE + 6 * 4)
      gl.vertexAttribPointer(3, 4, gl.FLOAT, false, STRIDE, pass * N * STRIDE + 10 * 4)
      gl.uniform1f(passLoc, pass)
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, N)
    }

    drawPass(0)
    drawPass(1)
    drawPass(2)
    this.drawCursor()
    gl.bindVertexArray(null)
  }

  private drawCursor(): void {
    const meta = this.meta
    if (!meta || !meta.cursor.visible || meta.cursor.shape === 'none') return
    if (meta.modes.altScreen && !meta.cursor.visible) return
    const gl = this.gl
    const { x, y, shape } = meta.cursor
    const color = this.theme.cursor
    const build = (ox: number, oy: number, w: number, h: number, c: Rgba): void => {
      const base = this.cursorCount * FLOATS
      const inst = this.cursorInstances
      inst[base] = x + ox
      inst[base + 1] = y + oy
      inst[base + 2] = 0
      inst[base + 3] = 0
      inst[base + 4] = 0
      inst[base + 5] = 0
      inst[base + 6] = c.r
      inst[base + 7] = c.g
      inst[base + 8] = c.b
      inst[base + 9] = c.a
      // 用 flags.z 之外的两个通道传尺寸缩放（w/h 相对单元格）
      inst[base + 10] = w
      inst[base + 11] = h
      inst[base + 12] = 0
      inst[base + 13] = 0
      this.cursorCount += 1
    }
    this.cursorCount = 0
    const c = { ...color, a: this.blinkOff ? color.a * 0.35 : color.a }
    if (shape === 'block') build(0, 0, 1, 1, c)
    else if (shape === 'beam') build(0, 0, 0.14, 1, c)
    else if (shape === 'underline') build(0, 0.88, 1, 0.12, c)
    else if (shape === 'hollow') {
      const t = 0.08
      build(0, 0, 1, t, c)
      build(0, 1 - t, 1, t, c)
      build(0, 0, t, 1, c)
      build(1 - t, 0, t, 1, c)
    }
    if (this.cursorCount === 0) return
    gl.bindBuffer(gl.ARRAY_BUFFER, this.cursorBuffer)
    gl.bufferData(gl.ARRAY_BUFFER, this.cursorInstances.subarray(0, this.cursorCount * FLOATS), gl.DYNAMIC_DRAW)
    gl.bindVertexArray(this.cursorVao)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.cursorBuffer)
    gl.uniform1f(gl.getUniformLocation(this.program, 'u_pass'), 0)
    // 光标用独立缓冲，逐实例偏移指针后各画 1 个实例（块/竖线/下划线/空心共 1–4 个）
    for (let i = 0; i < this.cursorCount; i += 1) {
      const off = i * STRIDE
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, STRIDE, off)
      gl.vertexAttribPointer(1, 4, gl.FLOAT, false, STRIDE, off + 2 * 4)
      gl.vertexAttribPointer(2, 4, gl.FLOAT, false, STRIDE, off + 6 * 4)
      gl.vertexAttribPointer(3, 4, gl.FLOAT, false, STRIDE, off + 10 * 4)
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, 1)
    }
    gl.bindVertexArray(null)
  }

  private cursorCount = 0

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    const gl = this.gl
    gl.deleteProgram(this.program)
    gl.deleteBuffer(this.buffer)
    gl.deleteBuffer(this.cursorBuffer)
    gl.deleteVertexArray(this.vao)
    gl.deleteVertexArray(this.cursorVao)
    if (this.atlasTex) gl.deleteTexture(this.atlasTex)
  }
}
