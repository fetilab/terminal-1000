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

/** 一条图形协议图片摆放（引擎解码后的渲染输入） */
export interface ImagePlacement {
  imageNumber: number
  /** 内容变化时递增，驱动纹理重传 */
  revision: number
  /** 钉住的绝对行号（随内容滚动，回看时跟着移动） */
  absLine: number
  /** 起始列 */
  col: number
  /** 单元格内的像素纵向偏移 */
  yOffsetPx: number
  /** z<0 文字下、z>=0 文字上（kitty 图形协议语义） */
  z: number
  source: CanvasImageSource
  /** 图片像素尺寸（换算成格数用） */
  pxW: number
  pxH: number
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
uniform float u_pass;   // 0 = 背景/实心, 1 = 字形, 2 = 装饰线, 3 = 图形协议图片

out vec2 v_uv;
out vec4 v_color;
out vec4 v_flags;
out vec2 v_local;
out vec2 v_cellPos;

const vec2 QUAD[6] = vec2[6](
  vec2(0.0, 0.0), vec2(1.0, 0.0), vec2(0.0, 1.0),
  vec2(0.0, 1.0), vec2(1.0, 0.0), vec2(1.0, 1.0)
);

void main() {
  vec2 corner = QUAD[gl_VertexID];
  // pass 0（背景/光标）用 flags.xy 当尺寸倍数：背景是 1×1，光标可以是细条；
  // pass 1（字形）用 flags.z 当列数倍数：连字/宽字符的 quad 要横跨 span 格
  vec2 size = vec2(1.0);
  // pass 0（背景/光标/拖尾顶点）与 pass 3（图片）都用 flags.xy 当尺寸倍数；
  // pass 1（字形）用 flags.z 当列数倍数：连字/宽字符的 quad 要横跨 span 格
  if (u_pass < 0.5 || u_pass > 2.5) size = a_flags.xy;
  else if (u_pass < 1.5) size = vec2(max(a_flags.z, 1.0), 1.0);
  vec2 px = (a_cell + corner * size) * u_cell;
  vec2 clip = vec2(px.x / u_res.x * 2.0 - 1.0, 1.0 - px.y / u_res.y * 2.0);
  gl_Position = vec4(clip, 0.0, 1.0);
  v_uv = vec2(mix(a_uv.x, a_uv.z, corner.x), mix(a_uv.y, a_uv.w, corner.y));
  v_color = a_color;
  v_flags = a_flags;
  v_local = corner;
  v_cellPos = a_cell + corner * size;
}`

const FRAG = `#version 300 es
precision highp float;
in vec2 v_uv;
in vec4 v_color;
in vec4 v_flags;
in vec2 v_local;
in vec2 v_cellPos;

uniform sampler2D u_atlas;
uniform sampler2D u_img;
uniform float u_pass;
uniform float u_blinkOff;
// 拖尾遮罩：光标包围盒（cell 坐标 x0,x1,y0,y1）。只在画拖尾四边形时开启——
// kitty shaders/trail.slang：拖尾在光标包围盒内的部分直接乘掉 alpha。
uniform vec4 u_maskRect;
uniform float u_maskOn;

out vec4 outColor;

void main() {
  if (u_pass < 0.5) {
    // 背景/光标/图片：纯色，alpha 由 CPU 侧算好
    vec4 c = v_color;
    if (u_maskOn > 0.5) {
      float inX = step(u_maskRect.x, v_cellPos.x) * step(v_cellPos.x, u_maskRect.y);
      float inY = step(u_maskRect.z, v_cellPos.y) * step(v_cellPos.y, u_maskRect.w);
      c.a *= 1.0 - inX * inY;
    }
    outColor = c;
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
  if (u_pass > 2.5) {
    // kitty 图形协议：图片四边形，uv 是 0..1 全图
    outColor = texture(u_img, v_uv) * vec4(1.0, 1.0, 1.0, v_color.a);
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
  private readonly trailBuffer: WebGLBuffer
  private readonly trailVao: WebGLVertexArrayObject
  private readonly imageBuffer: WebGLBuffer
  private readonly imageVao: WebGLVertexArrayObject
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

  /* ── kitty 图形协议（graphics.c 的渲染端）──
   * 引擎负责解码/增量/删除逻辑，渲染器只管纹理上传与摆放。
   * 图片以「摆放槽」为单位：absLine 让图片钉在内容行上（随回看滚动移动，
   * 与 kitty 图片跟随滚动一致）；z<0 画在文字下，z>=0 画在文字上。
   */
  private imagePlacements: ImagePlacement[] = []
  private imageTextures = new Map<number, { tex: WebGLTexture; w: number; h: number; rev: number }>()

  /* ── 光标拖尾：kitty cursor_trail.c 的逐行移植 ──
   *
   * kitty 的拖尾**不是**残影序列，而是一个四边形：它的 4 个角各自独立地
   * 指数缓动追赶光标矩形的 4 个角（每角的衰减时间按「角相对光标中心的
   * 方向点积」在 decay_fast/slow 之间插值）。光标本体永远画在真实位置，
   * 拖尾四边形在光标包围盒内的部分由片元着色器遮掉 —— 所以原版任何
   * 时刻都只有一个光标，拖尾看起来是「拉着光标跑的彩色拖布」。
   */
  /** kitty cursor_trail：光标停留多少毫秒后才更新拖尾目标（0 = 整体关闭） */
  private trailMs = 3
  /** kitty cursor_trail_decay 的两个值（秒）：贴近光标中心的角衰减快 */
  private trailDecayFast = 0.1
  private trailDecaySlow = 0.4
  /** kitty cursor_trail_start_threshold：两轴位移都小于阈值则不启动拖尾 */
  private trailThresholdX = 2
  private trailThresholdY = 2

  /** 光标目标矩形（cell 坐标；x0=left x1=right y0=top y1=bottom） */
  private edgeX: [number, number] | null = null
  private edgeY: [number, number] | null = null
  private prevEdgeX: [number, number] = [0, 0]
  private prevEdgeY: [number, number] = [0, 0]
  private prevEdgeValid = false
  private targetUpdated = false
  /** 拖尾四边形的 4 个角（角序：0=右上 1=右下 2=左上 3=左下，与 kitty 一致） */
  private cornerX: [number, number, number, number] = [0, 0, 0, 0]
  private cornerY: [number, number, number, number] = [0, 0, 0, 0]
  private trailOpacity = 0
  private trailUpdatedAt = 0
  /** 光标最后一次被程序移动的时间（kitty position_changed_by_client_at） */
  private cursorChangedAt = 0
  private trailNeedsRender = false
  /** 上一帧的 needs_render。kitty 的 update_cursor_trail 返回 needs||prev，多跑一帧把残影擦掉 */
  private trailNeedsRenderPrev = false
  private cursorVisibleMode = true
  /** 上一帧的原始光标位置（检测程序驱动的移动） */
  private lastRawCursor: { x: number; y: number } | null = null
  private focused = true
  private shapeOverride: 'block' | 'underline' | 'bar' | null = null
  private inactiveStyle: 'outline' | 'block' | 'beam' | 'underline' | 'none' = 'outline'
  private cursorCount = 0

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
    const trailBuffer = gl.createBuffer()
    const trailVao = gl.createVertexArray()
    const imageBuffer = gl.createBuffer()
    const imageVao = gl.createVertexArray()
    if (!vao || !buffer || !cursorBuffer || !cursorVao || !trailBuffer || !trailVao || !imageBuffer || !imageVao)
      throw new Error('WebGL 资源分配失败')
    this.vao = vao
    this.buffer = buffer
    this.cursorBuffer = cursorBuffer
    this.cursorVao = cursorVao
    this.trailBuffer = trailBuffer
    this.trailVao = trailVao
    this.imageBuffer = imageBuffer
    this.imageVao = imageVao
    this.setupVao(this.vao, this.buffer)
    this.setupVao(this.cursorVao, this.cursorBuffer)
    this.setupVao(this.trailVao, this.trailBuffer, true)
    this.setupVao(this.imageVao, this.imageBuffer, true)
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

  private setupVao(vao: WebGLVertexArrayObject, buffer: WebGLBuffer, nonInstanced = false): void {
    const gl = this.gl
    gl.bindVertexArray(vao)
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
    const loc = (name: string): number => gl.getAttribLocation(this.program, name)
    const divisor = nonInstanced ? 0 : 1
    gl.enableVertexAttribArray(loc('a_cell'))
    gl.vertexAttribPointer(loc('a_cell'), 2, gl.FLOAT, false, STRIDE, 0)
    gl.vertexAttribDivisor(loc('a_cell'), divisor)
    gl.enableVertexAttribArray(loc('a_uv'))
    gl.vertexAttribPointer(loc('a_uv'), 4, gl.FLOAT, false, STRIDE, 2 * 4)
    gl.vertexAttribDivisor(loc('a_uv'), divisor)
    gl.enableVertexAttribArray(loc('a_color'))
    gl.vertexAttribPointer(loc('a_color'), 4, gl.FLOAT, false, STRIDE, 6 * 4)
    gl.vertexAttribDivisor(loc('a_color'), divisor)
    gl.enableVertexAttribArray(loc('a_flags'))
    gl.vertexAttribPointer(loc('a_flags'), 4, gl.FLOAT, false, STRIDE, 10 * 4)
    gl.vertexAttribDivisor(loc('a_flags'), divisor)
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

  /** kitty 图形协议：同步图片摆放（引擎每次变更全量下发） */
  setImages(placements: ImagePlacement[]): void {
    this.imagePlacements = placements
  }

  setBlinkOff(off: boolean): boolean {
    if (this.blinkOff === off) return false
    this.blinkOff = off
    return true
  }

  /** 光标拖尾阈值（kitty cursor_trail，毫秒；0 = 关闭） */
  setCursorTrail(ms: number): void {
    this.trailMs = Math.max(0, Math.min(1000, ms))
    if (this.trailMs === 0) this.snapTrail()
  }

  /** kitty cursor_trail_decay：贴近光标的角衰减快、远端角衰减慢 */
  setTrailDecay(fastSeconds: number, slowSeconds: number): void {
    const fast = Math.max(0.01, fastSeconds)
    this.trailDecayFast = fast
    this.trailDecaySlow = Math.max(fast, slowSeconds)
  }

  /** kitty cursor_trail_start_threshold（x/y 两轴，格数） */
  setTrailThreshold(x: number, y: number): void {
    this.trailThresholdX = Math.max(0, Math.round(x))
    this.trailThresholdY = Math.max(0, Math.round(y))
  }

  /** 光标形状覆盖（设置项 cursorStyle；null = 跟随内核上报） */
  setCursorShapeOverride(style: 'block' | 'underline' | 'bar' | null): void {
    this.shapeOverride = style
  }

  setFocused(focused: boolean): void {
    this.focused = focused
  }

  /** 光标被程序移动（kitty position_changed_by_client_at 的数据侧时刻） */
  noteCursorMoved(): void {
    this.cursorChangedAt = performance.now()
  }

  /** 动画是否还在跑（引擎据此决定要不要继续排下一帧） */
  get animActive(): boolean {
    // 目标还没跟上真实光标（trailMs 门控期内/目标尚未更新）：必须继续排帧，
    // 否则门控打开后没有渲染机会，拖尾永远不动
    const rect = this.cursorRect()
    if (rect && (!this.edgeX || !this.edgeY)) return true
    if (rect && this.edgeX && this.edgeY) {
      if (
        rect[0] !== this.edgeX[0] ||
        rect[1] !== this.edgeX[1] ||
        rect[2] !== this.edgeY[0] ||
        rect[3] !== this.edgeY[1]
      ) {
        return true
      }
    }
    return (
      this.trailNeedsRender || this.trailNeedsRenderPrev || (!this.cursorVisibleMode && this.trailOpacity > 0)
    )
  }

  /** 拖尾立刻贴合光标（关动画/重排时用） */
  private snapTrail(): void {
    if (this.edgeX && this.edgeY) {
      this.cornerX = [this.edgeX[1], this.edgeX[1], this.edgeX[0], this.edgeX[0]]
      this.cornerY = [this.edgeY[0], this.edgeY[1], this.edgeY[0], this.edgeY[1]]
    }
    this.trailNeedsRender = false
  }

  /* ─────────────── kitty cursor_trail.c 移植（几何与推进） ─────────────── */

  /** 当前光标的真实矩形（cell 坐标）。光标不可见/在视口外 → null */
  private cursorRect(): [number, number, number, number] | null {
    const meta = this.meta
    if (!meta || !meta.cursor.visible || meta.cursor.shape === 'none') return null
    // 光标住在 live 区（绝对行 = scrollbackLength + cursor.y）；回看时换算成
    // 视口行，落到视口外就不画（kitty 同样不画视口外的光标）
    const y = meta.scrolledBy + meta.cursor.y
    if (y < 0 || y >= this.rows) return null
    const x = meta.cursor.x
    // 形状：设置项覆盖 > 内核上报；失焦按 cursorInactiveStyle 降级。
    // 设置项里的 'bar' 与内核上报的 'beam' 是同一种形状（kitty 叫 bar）
    const shape = this.focused ? (this.shapeOverride ?? meta.cursor.shape) : this.cursorInactiveShape()
    if (shape === 'none') return null
    // kitty：beam/underline 的粗细是绝对 pt，按单元格像素尺寸换算成格数
    const cellWcss = this.atlas.cellW / this.dpr
    const cellHcss = this.atlas.cellH / this.dpr
    if (shape === 'beam' || shape === 'bar') {
      const w = Math.max(0.02, Math.min(1, this.beamThicknessPx / cellWcss))
      return [x, x + w, y, y + 1]
    }
    if (shape === 'underline') {
      const h = Math.max(0.02, Math.min(1, this.underlineThicknessPx / cellHcss))
      return [x, x + 1, y + 1 - h, y + 1]
    }
    // block / hollow 都是整格
    return [x, x + 1, y, y + 1]
  }

  /** kitty cursor_beam_thickness 默认 1.5pt，96dpi 下 = 2px */
  private beamThicknessPx = 2
  /** kitty cursor_underline_thickness 默认 2.0pt，96dpi 下 = 2.67px */
  private underlineThicknessPx = 2.67
  /** kitty add_hollow_cursor 用的是 box_drawing 细线（≈1.5pt） */
  private hollowThicknessPx = 2

  setBeamThicknessPx(px: number): void {
    this.beamThicknessPx = Math.max(1, px)
  }

  setUnderlineThicknessPx(px: number): void {
    this.underlineThicknessPx = Math.max(1, px)
  }

  private updateTrail(now: number): void {
    const meta = this.meta
    this.cursorVisibleMode = Boolean(meta && meta.cursor.visible && meta.cursor.shape !== 'none')
    const rect = this.cursorRect()
    // 光标位置变化（程序驱动）：对比**原始光标位置**而不是拖尾目标——
    // kitty 的 position_changed_by_client_at 在客户端移动光标时置一次，
    // 若每帧对着没跟上来的目标重新计时，门控会死锁（目标永远不更新）。
    // 只看光标本身：回看滚动会改变视口坐标，但 kitty 不把它算作客户端移动。
    if (meta) {
      const raw = { x: meta.cursor.x, y: meta.cursor.y }
      const last = this.lastRawCursor
      if (last && (raw.x !== last.x || raw.y !== last.y)) this.cursorChangedAt = now
      this.lastRawCursor = raw
    }
    // 目标更新门控：光标停稳 trailMs 毫秒后才跟随（kitty update_cursor_trail）
    const gated = this.trailMs > 0 && now - this.cursorChangedAt < this.trailMs
    this.targetUpdated = false
    if (rect && !gated) this.updateTrailTarget(rect)
    this.trailNeedsRenderPrev = this.trailNeedsRender
    this.updateTrailCorners(now)
    this.updateTrailOpacity(now)
    this.updateTrailNeedsRender()
    this.trailUpdatedAt = now
  }

  /** kitty update_cursor_trail_target：目标边变化时记录上一位置 */
  private updateTrailTarget(rect: [number, number, number, number]): void {
    const [left, right, top, bottom] = rect
    const changed =
      this.edgeX !== null &&
      (this.edgeX[0] !== left ||
        this.edgeX[1] !== right ||
        (this.edgeY !== null && (this.edgeY[0] !== top || this.edgeY[1] !== bottom)))
    if (changed && this.prevEdgeValid) {
      this.prevEdgeX = [this.edgeX![0], this.edgeX![1]]
      this.prevEdgeY = [this.edgeY![0], this.edgeY![1]]
    }
    if (changed || this.edgeX === null || this.edgeY === null) {
      this.targetUpdated = true
      this.prevEdgeValid = true
      this.edgeX = [left, right]
      this.edgeY = [top, bottom]
    }
  }

  /**
   * kitty update_cursor_trail_corners + should_skip_cursor_trail_update。
   * 每个角以 `step = 1 - 2^(-10·dt/decay)` 追赶目标角；decay 按「角相对
   * 光标中心的方向点积」在 fast/slow 之间插值（面向移动方向的角快）。
   */
  private updateTrailCorners(now: number): void {
    const CORNER_IX = [1, 1, 0, 0] as const
    const CORNER_IY = [0, 1, 1, 0] as const
    if (!this.edgeX || !this.edgeY) return

    // 起始阈值：拖尾四边形离目标已经够近（小移动）就不启动
    let skip = false
    if ((this.trailThresholdX > 0 || this.trailThresholdY > 0) && !this.trailNeedsRender) {
      const dx = Math.round(this.cornerX[0] - this.edgeX[1])
      const dy = Math.round(this.cornerY[0] - this.edgeY[0])
      if (Math.abs(dx) <= this.trailThresholdX && Math.abs(dy) <= this.trailThresholdY) skip = true
    }
    // 光标隐藏且拖尾已淡出：直接贴合
    if (!this.cursorVisibleMode && this.trailOpacity <= 0) skip = true

    if (skip) {
      this.targetUpdated = false
      this.cornerX = [
        this.edgeX[CORNER_IX[0]],
        this.edgeX[CORNER_IX[1]],
        this.edgeX[CORNER_IX[2]],
        this.edgeX[CORNER_IX[3]],
      ]
      this.cornerY = [
        this.edgeY[CORNER_IY[0]],
        this.edgeY[CORNER_IY[1]],
        this.edgeY[CORNER_IY[2]],
        this.edgeY[CORNER_IY[3]],
      ]
      return
    }
    if (this.trailUpdatedAt >= now) return
    const dt = Math.min(0.1, (now - this.trailUpdatedAt) / 1000)

    const centerX = (this.edgeX[0] + this.edgeX[1]) * 0.5
    const centerY = (this.edgeY[0] + this.edgeY[1]) * 0.5
    const diag2 = Math.hypot(this.edgeX[1] - this.edgeX[0], this.edgeY[1] - this.edgeY[0]) * 0.5
    const dx: number[] = [0, 0, 0, 0]
    const dy: number[] = [0, 0, 0, 0]
    const dot: number[] = [0, 0, 0, 0]
    for (let i = 0; i < 4; i += 1) {
      const tix = CORNER_IX[i] as 0 | 1
      const tiy = CORNER_IY[i] as 0 | 1
      dx[i] = this.edgeX[tix] - this.cornerX[i]!
      dy[i] = this.edgeY[tiy] - this.cornerY[i]!
      if (Math.abs(dx[i]!) < 1e-6 && Math.abs(dy[i]!) < 1e-6) {
        dx[i] = 0
        dy[i] = 0
        dot[i] = 0
        continue
      }
      // 方向向量与「光标中心到角」的点积归一化：角越面向光标移动方向越快
      dot[i] =
        (dx[i]! * (this.edgeX[tix] - centerX) + dy[i]! * (this.edgeY[tiy] - centerY)) /
        diag2 /
        Math.hypot(dx[i]!, dy[i]!)
    }
    let minDot = Infinity
    let maxDot = -Infinity
    for (let i = 0; i < 4; i += 1) {
      minDot = Math.min(minDot, dot[i]!)
      maxDot = Math.max(maxDot, dot[i]!)
    }
    for (let i = 0; i < 4; i += 1) {
      if ((dx[i] === 0 && dy[i] === 0) || minDot === Infinity) continue
      const decay =
        minDot === maxDot
          ? this.trailDecaySlow
          : this.trailDecaySlow +
            (this.trailDecayFast - this.trailDecaySlow) * ((dot[i]! - minDot) / (maxDot - minDot))
      const step = 1 - Math.pow(2, (-10 * dt) / decay)
      this.cornerX[i] = this.cornerX[i]! + dx[i]! * step
      this.cornerY[i] = this.cornerY[i]! + dy[i]! * step
    }
  }

  /** kitty update_cursor_trail_opacity：光标可见时淡入到 1，隐藏时淡出 */
  private updateTrailOpacity(now: number): void {
    if (this.trailUpdatedAt >= now) return
    const dt = Math.min(0.1, (now - this.trailUpdatedAt) / 1000)
    if (this.cursorVisibleMode) {
      this.trailOpacity = Math.min(1, this.trailOpacity + dt / this.trailDecaySlow)
    } else {
      this.trailOpacity = Math.max(0, this.trailOpacity - dt / this.trailDecaySlow)
    }
  }

  /** kitty update_cursor_trail_needs_render：任一角离目标 ≥ 半格就继续动画 */
  private updateTrailNeedsRender(): void {
    if (!this.edgeX || !this.edgeY) {
      this.trailNeedsRender = false
      return
    }
    const CORNER_IX = [1, 1, 0, 0] as const
    const CORNER_IY = [0, 1, 1, 0] as const
    let needed = false
    for (let i = 0; i < 4; i += 1) {
      const dx = Math.abs(this.edgeX[CORNER_IX[i] as 0 | 1] - this.cornerX[i]!)
      const dy = Math.abs(this.edgeY[CORNER_IY[i] as 0 | 1] - this.cornerY[i]!)
      if (0.5 <= dx || 0.5 <= dy) {
        needed = true
        break
      }
    }
    this.trailNeedsRender = needed
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
    // 重排后拖尾几何可能落在旧网格空间里，直接贴合光标（kitty 在 live resize
    // 期间跳过拖尾更新，观感等价）
    this.snapTrail()
    this.prevEdgeValid = false
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

  /**
   * 块光标所在的单元格（视口坐标）。
   *
   * kitty 的块光标**不是**一个盖在文字上的实心矩形：它是把该格的背景换成光标色、
   * 文字换成原底色（shaders.c：`foreground = if_one_then(has_block_cursor,
   * final_cursor_text_color, foreground)`）。所以格子里的字符始终可见 —— 反色。
   * 我们早先是先画字、再往上盖一个实心块，字就被盖没了。
   */
  private blockCursorCell(): { x1: number; x2: number; y: number } | null {
    const meta = this.meta
    if (!meta || this.blinkOff) return null
    if (!meta.cursor.visible || meta.cursor.shape === 'none') return null
    const shape = this.focused ? (this.shapeOverride ?? meta.cursor.shape) : this.cursorInactiveShape()
    if (shape !== 'block') return null
    const y = meta.scrolledBy + meta.cursor.y
    if (y < 0 || y >= this.rows) return null
    const x = meta.cursor.x
    if (x < 0 || x >= this.cols) return null
    /*
     * 宽字符（CJK / emoji）：kitty 在 shaders.c 里对 multicell 的块光标做
     * `rd->cursor_x2 += mcd_x_limit(cursor_cell) - 1`，也就是光标要盖满整个
     * 宽字符的两格。只盖第一格会留下一条没反色的缝，看上去像光标被切了一半。
     */
    const flags = this.grid[(y * this.cols + x) * KITTY_CELL_WORDS + 6] ?? 0
    const span = (flags & F_WIDE) !== 0 ? 2 : 1
    return { x1: x, x2: Math.min(this.cols - 1, x + span - 1), y }
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
    // 块光标所在格（视口坐标）：这一格的背景/前景要按 kitty 的规则反色
    const curCell = this.blockCursorCell()
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
      // kitty background.slang: displayed_foreground = lerp(cell_bg, fg, dim_opacity)。
      // 早先是「fg 乘 0.62」——黑字乘完还是黑，浅色主题上 DIM 完全看不出来。
      if (dim) fg = mixTo(fg, bg, DIM_OPACITY)
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

      // 块光标：背景→光标色、文字→原底色（kitty shaders.c 的 has_block_cursor 分支）。
      // 这样字始终可见且是反色的，而不是被一块实心矩形盖掉。
      // 宽字符占两格（blockCursorCell 已经按 F_WIDE 伸展）。
      if (curCell !== null && curCell.y === y && x >= curCell.x1 && x <= curCell.x2) {
        fg = { ...bg, a: 1 }
        bg = { ...this.theme.cursor }
      }

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
      // SGR 58：SGR 4:3 附带的下划线颜色（word 5），0 = 默认色
      const decoWord = grid[i + 5] ?? 0
      const decoColor = decoWord !== 0 ? this.packed(decoWord, false) : (this.theme.underline ?? fg)
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

    // 拖尾推进每帧一次（kitty 在 draw_cells 里做同样的事）；
    // 光标不可见时也要跑——拖尾 opacity 还在淡出。
    this.updateTrail(performance.now())

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
    // 清屏必须全透明：背景只由 bg pass 画一遍。此前 clearColor 也铺一层
    // theme.bg（alpha 0.88），再叠加每格 0.88 的背景实例 → 1-(1-0.88)²≈98.6%
    // 不透明，设置里的半透明/背景透出全部失效（「背景完全不显示」的根因）。
    gl.clearColor(0, 0, 0, 0)
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
    this.drawImages('below')
    drawPass(1)
    drawPass(2)
    this.drawImages('above')
    this.drawTrailQuad()
    this.drawCursorQuad()
    gl.bindVertexArray(null)
  }

  /**
   * kitty graphics.c 的绘制端：图片按 zIndex 分两层（below=文字下/above=文字上）。
   * 视口行 = absLine - (scrollbackLength - scrolledBy)，回看时图片跟着内容走。
   */
  private drawImages(layer: 'below' | 'above'): void {
    if (this.imagePlacements.length === 0) return
    const meta = this.meta
    if (!meta) return
    const gl = this.gl
    const abs0 = meta.scrollbackLength - meta.scrolledBy
    const cellW = this.atlas.cellW
    const cellH = this.atlas.cellH
    // 1) 纹理同步：只增不删（删除统一在 setImages 不成立时由下次全量同步清理）
    for (const p of this.imagePlacements) {
      let t = this.imageTextures.get(p.imageNumber)
      if (!t) {
        const tex = gl.createTexture()
        if (!tex) continue
        t = { tex, w: 0, h: 0, rev: -1 }
        this.imageTextures.set(p.imageNumber, t)
      }
      if (t.rev !== p.revision || t.w !== p.pxW || t.h !== p.pxH) {
        gl.bindTexture(gl.TEXTURE_2D, t.tex)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, p.source as TexImageSource)
        t.w = p.pxW
        t.h = p.pxH
        t.rev = p.revision
      }
    }
    const wanted = new Set(this.imagePlacements.map((p) => p.imageNumber))
    for (const [num, t] of this.imageTextures) {
      if (!wanted.has(num)) {
        gl.deleteTexture(t.tex)
        this.imageTextures.delete(num)
      }
    }

    // 2) 逐摆放画四边形（图片少，逐个 bufferData 成本可忽略）
    gl.uniform1f(gl.getUniformLocation(this.program, 'u_pass'), 3)
    gl.uniform1f(gl.getUniformLocation(this.program, 'u_maskOn'), 0)
    gl.uniform1i(gl.getUniformLocation(this.program, 'u_img'), 1)
    gl.bindVertexArray(this.imageVao)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.imageBuffer)
    for (const p of this.imagePlacements) {
      if ((layer === 'below') !== (p.z < 0)) continue
      const t = this.imageTextures.get(p.imageNumber)
      if (!t) continue
      const vy = p.absLine - abs0
      const h = p.pxH / cellH
      if (vy + h <= 0 || vy >= this.rows) continue
      const wCells = p.pxW / cellW
      const yOff = p.yOffsetPx / cellH
      const verts = new Float32Array(6 * FLOATS)
      // 角序与 VERT 的 QUAD 一致：先两个三角形，uv 左上 (0,0) 右下 (1,1)
      const corners: Array<[number, number, number, number]> = [
        [0, 0, 0, 0],
        [1, 0, 1, 0],
        [0, 1, 0, 1],
        [0, 1, 0, 1],
        [1, 0, 1, 0],
        [1, 1, 1, 1],
      ]
      for (let v = 0; v < 6; v += 1) {
        const [cx, cy, u, vv] = corners[v] as [number, number, number, number]
        const b = v * FLOATS
        verts[b] = p.col + cx * wCells
        verts[b + 1] = vy + yOff + cy * h
        verts[b + 2] = u
        verts[b + 3] = vv
        verts[b + 4] = u
        verts[b + 5] = vv
        verts[b + 6] = 0
        verts[b + 7] = 0
        verts[b + 8] = 0
        verts[b + 9] = 1
        verts[b + 10] = wCells
        verts[b + 11] = h
      }
      gl.bufferData(gl.ARRAY_BUFFER, verts, gl.DYNAMIC_DRAW)
      gl.activeTexture(gl.TEXTURE1)
      gl.bindTexture(gl.TEXTURE_2D, t.tex)
      gl.drawArrays(gl.TRIANGLES, 0, 6)
    }
    gl.activeTexture(gl.TEXTURE0)
    gl.bindVertexArray(null)
  }

  /**
   * 拖尾四边形（kitty shaders.c draw_cursor_trail + shaders/trail.slang）。
   * 4 个角独立缓动 → 一个可能拉伸变形的实心四边形；在光标包围盒内的
   * 片元被遮掉。非实例化绘制：6 个顶点直接来自 corner 数组。
   */
  private drawTrailQuad(): void {
    /*
     * kitty 只在 `cursor_trail.needs_render` 为真时画拖尾（shaders.c：
     * stop_os_window_rendering 的条件是 `OPT(cursor_trail) && needs_render`）。
     *
     * 这一条不能省：四个角收敛到 0.5 格以内之后，剩下的那块"变形"其实已经
     * 与实际光标几乎重合，画不画都看不出来；但如果继续画，它就**一直留在屏幕上**，
     * 直到下一帧（往往是 500ms 后的闪烁定时器）才被擦掉 —— 观感就是"光标卡在
     * 变形状态半秒，然后突然弹回去"。
     */
    if (!this.trailNeedsRender || this.trailOpacity <= 0 || !this.edgeX || !this.edgeY) return
    const gl = this.gl
    // 角序（kitty corner_index）：0=右上 1=右下 2=左上 3=左下 → 三角形 (0,1,2)(2,1,3)
    const order = [0, 1, 2, 2, 1, 3]
    const verts = new Float32Array(order.length * FLOATS)
    const color = this.theme.cursor
    for (let v = 0; v < order.length; v += 1) {
      const ci = order[v] as 0 | 1 | 2 | 3
      const base = v * FLOATS
      // a_cell 直接是角的格坐标；flags.xy = 尺寸 0 → 顶点正好落在角上
      verts[base] = this.cornerX[ci]
      verts[base + 1] = this.cornerY[ci]
      verts[base + 6] = color.r
      verts[base + 7] = color.g
      verts[base + 8] = color.b
      verts[base + 9] = color.a * this.trailOpacity
      // flags 全 0
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.trailBuffer)
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.DYNAMIC_DRAW)
    gl.bindVertexArray(this.trailVao)
    gl.uniform1f(gl.getUniformLocation(this.program, 'u_pass'), 0)
    gl.uniform1f(gl.getUniformLocation(this.program, 'u_maskOn'), 1)
    gl.uniform4f(
      gl.getUniformLocation(this.program, 'u_maskRect'),
      this.edgeX[0],
      this.edgeX[1],
      this.edgeY[0],
      this.edgeY[1],
    )
    gl.drawArrays(gl.TRIANGLES, 0, order.length)
    gl.uniform1f(gl.getUniformLocation(this.program, 'u_maskOn'), 0)
    gl.bindVertexArray(null)
  }

  /**
   * 光标本体：永远画在真实位置（kitty 的 cursor 由 cell 渲染管线在真实
   * 位置绘制，拖尾是独立四边形）——任何时刻屏幕上只有一个光标。
   */
  private drawCursorQuad(): void {
    const rect = this.cursorRect()
    if (!rect) return
    const [left, right, top, bottom] = rect
    const gl = this.gl
    const color = this.theme.cursor
    const shape = this.focused ? (this.shapeOverride ?? this.meta!.cursor.shape) : this.cursorInactiveShape()

    const build = (px: number, py: number, w: number, h: number, c: Rgba): void => {
      const base = this.cursorCount * FLOATS
      const inst = this.cursorInstances
      inst[base] = px
      inst[base + 1] = py
      inst[base + 2] = 0
      inst[base + 3] = 0
      inst[base + 4] = 0
      inst[base + 5] = 0
      inst[base + 6] = c.r
      inst[base + 7] = c.g
      inst[base + 8] = c.b
      inst[base + 9] = c.a
      inst[base + 10] = w
      inst[base + 11] = h
      inst[base + 12] = 0
      inst[base + 13] = 0
      this.cursorCount += 1
    }
    this.cursorCount = 0
    // kitty：闪烁的灭相完全不画光标（shaders.c 里 off 相直接跳过 cursor 绘制）
    if (this.blinkOff) return
    // 块光标已经在单元格里画成「反色格」（见 blockCursorCell），这里不再叠一个实心矩形，
    // 否则会把字符盖掉。竖线/下划线/空心没有这个问题，仍按四边形画。
    if (shape === 'block') return
    const c = color
    if (shape === 'beam' || shape === 'bar') build(left, top, right - left, bottom - top, c)
    else if (shape === 'underline') build(left, top, right - left, bottom - top, c)
    else if (shape === 'hollow') {
      /*
       * kitty 的 add_hollow_cursor 是「四条 box-drawing 细线」，线宽是绝对
       * 像素（1.5pt），横边按格高、竖边按格宽换算 —— 早先用 0.08 格近似，
       * 宽格子上竖边会明显比横边粗。
       */
      const cellWcss = this.atlas.cellW / this.dpr
      const cellHcss = this.atlas.cellH / this.dpr
      const tx = Math.max(0.02, Math.min(0.5, this.hollowThicknessPx / cellWcss))
      const ty = Math.max(0.02, Math.min(0.5, this.hollowThicknessPx / cellHcss))
      const w = right - left
      const h = bottom - top
      build(left, top, w, ty, c)
      build(left, bottom - ty, w, ty, c)
      build(left, top, tx, h, c)
      build(right - tx, top, tx, h, c)
    }
    if (this.cursorCount === 0) return
    gl.bindBuffer(gl.ARRAY_BUFFER, this.cursorBuffer)
    gl.bufferData(gl.ARRAY_BUFFER, this.cursorInstances.subarray(0, this.cursorCount * FLOATS), gl.DYNAMIC_DRAW)
    gl.bindVertexArray(this.cursorVao)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.cursorBuffer)
    gl.uniform1f(gl.getUniformLocation(this.program, 'u_pass'), 0)
    gl.uniform1f(gl.getUniformLocation(this.program, 'u_maskOn'), 0)
    // 光标用独立缓冲，逐实例偏移指针后各画 1 个实例（块/竖线/下划线/空心）
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

  private cursorInactiveShape(): string {
    // cursorInactiveStyle 的 outline 映射成 hollow；none 直接不画
    return this.inactiveStyle === 'none' ? 'none' : this.inactiveStyle === 'outline' ? 'hollow' : this.inactiveStyle
  }

  setCursorInactiveStyle(style: 'outline' | 'block' | 'beam' | 'underline' | 'none'): void {
    this.inactiveStyle = style
  }

  /** 供验收脚本读取拖尾内部状态 */
  trailDebug(): {
    edgeX: [number, number] | null
    edgeY: [number, number] | null
    cornerX: number[]
    cornerY: number[]
    opacity: number
    needsRender: boolean
    cursorRect: [number, number, number, number] | null
    cursorQuads: number
  } {
    return {
      edgeX: this.edgeX ? [...this.edgeX] : null,
      edgeY: this.edgeY ? [...this.edgeY] : null,
      cornerX: [...this.cornerX],
      cornerY: [...this.cornerY],
      opacity: this.trailOpacity,
      needsRender: this.trailNeedsRender,
      cursorRect: this.cursorRect(),
      cursorQuads: this.cursorCount,
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    const gl = this.gl
    gl.deleteProgram(this.program)
    gl.deleteBuffer(this.buffer)
    gl.deleteBuffer(this.cursorBuffer)
    gl.deleteBuffer(this.trailBuffer)
    gl.deleteBuffer(this.imageBuffer)
    gl.deleteVertexArray(this.vao)
    gl.deleteVertexArray(this.cursorVao)
    gl.deleteVertexArray(this.trailVao)
    gl.deleteVertexArray(this.imageVao)
    if (this.atlasTex) gl.deleteTexture(this.atlasTex)
    for (const t of this.imageTextures.values()) gl.deleteTexture(t.tex)
    this.imageTextures.clear()
  }
}
