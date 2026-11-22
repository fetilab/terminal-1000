// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * kitty 终端引擎：把「内核 + 渲染器 + 输入」组装成一个 **xterm 兼容对象**。
 *
 * 为什么要兼容 xterm 的 API：窗格（`TerminalPane`）身上挂着补全、高亮、搜索、
 * 选区、录制、广播、OSC 7 等一堆逻辑，它们都是围绕 xterm 的方法写的。把引擎做成
 * 同形接口，才能在不重写这些逻辑的前提下整体换掉渲染内核 —— 也让「渲染后端」
 * 真正成为可回退的开关，而不是一次性赌博。
 *
 * 兼容面（只覆盖窗格实际用到的部分）：
 * `open/cols/rows/focus/dispose/write/paste/clear/getSelection/scrollToBottom/
 *  options/onData/onResize/onBell/onSelectionChange/onWriteParsed/
 *  parser.registerOscHandler/registerMarker/registerDecoration/loadAddon/buffer`
 */

import type { KittyGraphicsCommand, KittyHostEvent, KittyMeta, TerminalSettings } from '@t1000/shared'
import { KITTY_CELL_WORDS } from '@t1000/shared'
import { GlyphAtlas } from './atlas'
import { CanvasTerminalRenderer } from './canvas'
import { KittySession, ensureKittyCore } from './client'
import { buildTheme, type RenderTheme } from './theme'
import { WebGLTerminalRenderer, type HighlightSpan, type ImagePlacement, type SearchSpan } from './webgl'
import { parseHex } from './theme'

type Kind = 'local' | 'ssh' | 'telnet'

export interface KittyEngineOptions {
  host: HTMLElement
  sessionId: string
  kind: Kind
  settings: TerminalSettings
  resolvedTheme: 'light' | 'dark'
  /** 内核要回写给 PTY 的字节（查询回复 + 编码后的按键） */
  onWrite: (data: string) => void
  onBell?: () => void
  onSelectionChange?: () => void
  /** 每帧渲染后回调（高亮扫描用，等价 xterm 的 onWriteParsed） */
  onWriteParsed?: () => void
  onTitle?: (title: string) => void
  onCwd?: (path: string) => void
  onResize?: (cols: number, rows: number) => void
  onFatal?: (message: string) => void
}

class DecorationImpl {
  absLine: number
  x: number
  width: number
  color: string
  disposed = false
  onRenderCb: ((el: HTMLElement) => void) | null = null
  onDisposeCb: (() => void) | null = null
  constructor(absLine: number, x: number, width: number, color: string) {
    this.absLine = absLine
    this.x = x
    this.width = width
    this.color = color
  }
  onRender(cb: (el: HTMLElement) => void): void {
    this.onRenderCb = cb
  }
  onDispose(cb: () => void): void {
    this.onDisposeCb = cb
  }
  dispose(): void {
    this.disposed = true
    this.onDisposeCb?.()
  }
}

/* ── kitty 图形协议（graphics.c 的客户端侧）──
 * 内核只解析命令并上报；解码、分块重组、摆放生命周期由引擎负责。
 * 摆放钉在绝对行号上：内容滚动时图片跟着内容走（与 kitty 一致），
 * z<0 画在文字下、z>=0 画在文字上（kitty 图形协议的 z 语义）。
 */
interface DecodedImage {
  source: CanvasImageSource
  w: number
  h: number
  rev: number
}

function decodeBase64(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i)
  return out
}

async function inflateZlib(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

interface Marker {
  absLine: number
  disposed: boolean
  dispose: () => void
}

const SPECIAL_KEYS: Record<string, string> = {
  Enter: 'Enter',
  Tab: 'Tab',
  Backspace: 'Backspace',
  Escape: 'Escape',
  ArrowUp: 'ArrowUp',
  ArrowDown: 'ArrowDown',
  ArrowLeft: 'ArrowLeft',
  ArrowRight: 'ArrowRight',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  Insert: 'Insert',
  Delete: 'Delete',
  F1: 'F1',
  F2: 'F2',
  F3: 'F3',
  F4: 'F4',
  F5: 'F5',
  F6: 'F6',
  F7: 'F7',
  F8: 'F8',
  F9: 'F9',
  F10: 'F10',
  F11: 'F11',
  F12: 'F12',
}

/** 单行文本（供高亮扫描用；与 xterm 的 IBufferLine 同形的最小子集） */
interface LineView {
  translateToString: (trimRight?: boolean) => string
}

export class KittyEngine {
  readonly element: HTMLElement
  readonly options: TerminalSettings
  cols = 80
  rows = 24

  private readonly opts: KittyEngineOptions
  private readonly canvas: HTMLCanvasElement
  /** 与 canvas 同框的 `.xterm-screen` 等价物：补全弹窗的锚点计算要量它的尺寸 */
  private readonly screen: HTMLDivElement
  private readonly wrap: HTMLDivElement
  private readonly ime: HTMLTextAreaElement
  private readonly scrollbar: HTMLDivElement
  private readonly thumb: HTMLDivElement
  private readonly review: HTMLDivElement
  private dragScroll: { startY: number; startTopPx: number } | null = null
  private readonly scrollbarAbort = new AbortController()
  private atlas: GlyphAtlas
  private renderer: WebGLTerminalRenderer | CanvasTerminalRenderer
  private session: KittySession | null = null
  private theme: RenderTheme
  private meta: KittyMeta | null = null
  private grid: Uint32Array = new Uint32Array(0)
  private rowValid = new Uint8Array(0)
  private rowsText: string[] = []
  private disposed = false
  private ready = false
  private raf = 0
  private blinkTimer = 0
  private blinkOff = false
  private selectionText = ''
  private markers: Marker[] = []
  private decorations: DecorationImpl[] = []
  private searchSpans: SearchSpan[] = []
  private searchActive = -1
  private searchPattern = ''
  private oscHandlers = new Map<number, (data: string) => boolean>()
  private dataListeners = new Set<(data: string) => void>()
  private resizeListeners = new Set<(size: { cols: number; rows: number }) => void>()
  private bellListeners = new Set<() => void>()
  private selectionListeners = new Set<() => void>()
  private renderListeners = new Set<() => void>()
  private dragging = false
  private composing = false
  private visible = true
  private lastCwd = ''
  /** 光标最后一次移动的时间（用于「静止后停止闪烁」） */
  private lastCursorMoveAt = Date.now()
  private lastCursorKey = ''
  private customThemeBase: { fg: number | null; bg: number | null; cursor: number | null; palette: number[] } | null =
    null
  /** 已解码图片（imageNumber → 位图）；重传时 rev 递增驱动纹理重传 */
  private graphicsImages = new Map<number, DecodedImage>()
  /** 分块传输的重组桶（imageNumber → 已收到的段） */
  private graphicsChunks = new Map<number, { parts: string[]; cmd: KittyGraphicsCommand }>()
  /** 生效的摆放（key = placementId 或 imageNumber） */
  private graphicsPlacements = new Map<string, ImagePlacement>()
  private graphicsRev = 0

  constructor(opts: KittyEngineOptions) {
    this.opts = opts
    this.options = opts.settings
    this.element = opts.host
    this.theme = buildTheme({ settings: opts.settings, resolved: opts.resolvedTheme })

    this.wrap = document.createElement('div')
    this.wrap.className = 'kitty-surface'
    this.wrap.tabIndex = 0
    this.wrap.style.position = 'absolute'
    this.wrap.style.inset = '0'
    this.wrap.style.outline = 'none'

    this.canvas = document.createElement('canvas')
    this.canvas.className = 'kitty-canvas'
    this.canvas.style.position = 'absolute'
    this.canvas.style.inset = '0'
    this.canvas.style.width = '100%'
    this.canvas.style.height = '100%'
    this.wrap.appendChild(this.canvas)

    this.screen = document.createElement('div')
    this.screen.className = 'xterm-screen'
    this.screen.style.position = 'absolute'
    this.screen.style.pointerEvents = 'none'
    this.screen.style.inset = '0'
    this.wrap.appendChild(this.screen)

    this.ime = document.createElement('textarea')
    this.ime.className = 'kitty-ime'
    this.ime.setAttribute('aria-label', '终端输入')
    this.ime.autocapitalize = 'off'
    this.ime.autocomplete = 'off'
    this.ime.spellcheck = false
    this.ime.style.position = 'absolute'
    this.ime.style.opacity = '0'
    this.ime.style.width = '1px'
    this.ime.style.height = '1px'
    this.ime.style.left = '0'
    this.ime.style.top = '0'
    this.ime.style.border = 'none'
    this.ime.style.padding = '0'
    this.ime.style.resize = 'none'
    this.wrap.appendChild(this.ime)

    // 回看滚动条：xterm 后端自带 .xterm-viewport 滚动条，kitty 后端自己补一个。
    // 轨道铺满右缘，thumb 用百分比定位（免量容器尺寸），alt 屏/无历史时隐藏。
    this.scrollbar = document.createElement('div')
    this.scrollbar.className = 'kitty-scrollbar'
    this.thumb = document.createElement('div')
    this.thumb.className = 'kitty-scrollbar__thumb'
    this.scrollbar.appendChild(this.thumb)
    this.wrap.appendChild(this.scrollbar)

    // 回看徽标：滚离底部时提示「回看了多少行」，点击回底（等价 xterm 的 scrollToBottom）
    this.review = document.createElement('div')
    this.review.className = 'kitty-review'
    this.review.addEventListener('click', () => this.scrollToBottom())
    this.wrap.appendChild(this.review)

    this.bindScrollbar()
    this.element.appendChild(this.wrap)

    const dpr = Math.max(1, window.devicePixelRatio || 1)
    this.atlas = new GlyphAtlas({
      fontFamily: opts.settings.fontFamily,
      fontSize: opts.settings.fontSize,
      fontWeight: opts.settings.fontWeight,
      boldWeight: opts.settings.boldWeight,
      fontFeatures: opts.settings.fontFeatures,
      ligatures: opts.settings.ligatures,
      dpr,
    })
    this.renderer = this.createRenderer(dpr)
    this.bindDom()
  }

  private createRenderer(dpr: number): WebGLTerminalRenderer | CanvasTerminalRenderer {
    const renderOpts = { ligatures: this.options.ligatures, zebra: this.options.zebraStripes }
    try {
      return new WebGLTerminalRenderer(this.canvas, this.atlas, this.theme, renderOpts, dpr)
    } catch (err) {
      // 没有 WebGL2：降级到 2D，而不是让终端整个白屏
      console.warn('[kitty] WebGL2 不可用，回退 canvas', err)
      return new CanvasTerminalRenderer(
        this.canvas,
        this.atlas,
        this.theme,
        renderOpts,
        dpr,
        this.options.fontFamily,
      )
    }
  }

  /* ─────────────────────────── 启动 ─────────────────────────── */

  async open(): Promise<void> {
    await ensureKittyCore()
    const dpr = Math.max(1, window.devicePixelRatio || 1)
    const { cols, rows } = this.measure()
    this.cols = cols
    this.rows = rows
    this.renderer.resize(this.cssWidth(), this.cssHeight(), cols, rows, dpr)
    this.session = await KittySession.open(this.opts.sessionId, {
      cols,
      rows,
      scrollback: this.options.scrollback,
      handlers: {
        onFrame: (frame) => {
          this.meta = frame.meta
          this.applyRows(frame.rows, frame.full)
          this.refreshThemeBase(frame.meta)
          // 光标位置变化：重置「静止计时」（停止闪烁用），并告知渲染器
          // 拖尾的数据侧移动时刻（kitty position_changed_by_client_at）
          const ck = `${frame.meta.cursor.x},${frame.meta.cursor.y}`
          if (ck !== this.lastCursorKey) {
            this.lastCursorKey = ck
            this.lastCursorMoveAt = Date.now()
            // canvas 回退渲染器没有拖尾状态机，安全跳过
            ;(this.renderer as { noteCursorMoved?: () => void }).noteCursorMoved?.()
          }
          this.scheduleRender()
          if (frame.meta.title && this.opts.onTitle) this.opts.onTitle(frame.meta.title)
        },
        onEvent: (ev) => this.onHostEvent(ev),
        onFatal: (msg) => {
          this.opts.onFatal?.(msg)
        },
      },
    })
    this.session.onWrite = (data) => this.emitData(data)
    // 关掉自动换行（用户在设置里关了的话）；必须在任何输出前下发
    if (!this.options.wrapLines) this.session.write(new TextEncoder().encode('\x1b[?7l'))
    // 光标观感（kitty cursor_trail / cursor_shape / cursor_inactive_style）
    // 全部对齐用户 kitty.conf：cursor_trail 3（毫秒）、decay 0.1 0.4、
    // start_threshold 2、beam 2.0pt、underline 2.0pt
    this.renderer.setCursorTrail(this.options.cursorTrail)
    if (typeof (this.renderer as WebGLTerminalRenderer).setTrailDecay === 'function') {
      const glr = this.renderer as WebGLTerminalRenderer
      glr.setTrailDecay(0.1, 0.4)
      glr.setTrailThreshold(2, 2)
      glr.setBeamThicknessPx(2)
      glr.setUnderlineThicknessPx(2)
    }
    this.renderer.setCursorShapeOverride(this.options.cursorStyle)
    this.renderer.setCursorInactiveStyle(this.options.cursorInactiveStyle)
    this.renderer.setFocused(true)
    this.ready = true
    // cursorBlink=false 时光标常亮（此前这个设置被忽略，定时器无条件启动）
    if (this.options.cursorBlink !== false) this.startBlink()
    this.scheduleRender()
  }

  private applyRows(rows: { y: number; words: ArrayBuffer }[], full: boolean): void {
    if (this.grid.length !== this.cols * this.rows * KITTY_CELL_WORDS) {
      this.grid = new Uint32Array(this.cols * this.rows * KITTY_CELL_WORDS)
      this.rowValid = new Uint8Array(this.rows)
      this.rowsText = new Array(this.rows).fill('')
    }
    if (full) this.rowValid.fill(0)
    for (const row of rows) {
      if (row.y < 0 || row.y >= this.rows) continue
      const src = new Uint32Array(row.words)
      const perRow = this.cols * KITTY_CELL_WORDS
      const dst = new Uint32Array(this.grid.buffer, row.y * perRow * 4, perRow)
      dst.set(src.subarray(0, Math.min(src.length, perRow)))
      this.rowValid[row.y] = 1
      this.rowsText[row.y] = this.rowToText(dst)
    }
    this.renderer.applyFrame(this.meta as KittyMeta, rows, full)
  }

  private rowToText(words: Uint32Array): string {
    let out = ''
    for (let x = 0; x < this.cols; x += 1) {
      const i = x * KITTY_CELL_WORDS
      const flags = words[i + 6] ?? 0
      if ((flags & 128) !== 0) continue // wide trail
      const cp = words[i] ?? 0
      if (!cp) {
        out += ' '
        continue
      }
      out += String.fromCodePoint(cp)
      if (words[i + 1]) out += String.fromCodePoint(words[i + 1] ?? 0)
      if (words[i + 2]) out += String.fromCodePoint(words[i + 2] ?? 0)
    }
    return out.replace(/\s+$/, '')
  }

  private refreshThemeBase(meta: KittyMeta): void {
    const base = {
      fg: meta.defaultFg,
      bg: meta.defaultBg,
      cursor: meta.cursorColor,
      palette: meta.palette,
    }
    this.customThemeBase = base
    this.theme = buildTheme({
      settings: this.options,
      resolved: this.opts.resolvedTheme,
      core: base,
    })
    this.renderer.setTheme(this.theme)
  }

  /* ─────────────────────────── 事件 ─────────────────────────── */

  private onHostEvent(ev: KittyHostEvent): void {
    switch (ev.type) {
      case 'bell':
        this.opts.onBell?.()
        for (const cb of this.bellListeners) cb()
        return
      case 'title':
        this.opts.onTitle?.(ev.title)
        return
      case 'cwd':
        this.lastCwd = ev.path
        this.opts.onCwd?.(ev.path)
        this.notifyOsc(7, `file://localhost${ev.path}`)
        return
      case 'clipboard':
        if (!ev.query && ev.data) void navigator.clipboard.writeText(ev.data).catch(() => undefined)
        return
      case 'graphics':
        // 图形协议：解码 + 摆放交给渲染器画出来；解码失败不能影响文本
        this.onGraphics(ev.command)
        return
      case 'reset':
        this.decorations = []
        this.markers = []
        this.clearGraphics()
        return
      default:
        return
    }
  }

  private notifyOsc(code: number, data: string): void {
    const handler = this.oscHandlers.get(code)
    if (handler) handler(data)
  }

  /* ───────────────────── kitty 图形协议 ───────────────────── */

  private onGraphics(cmd: KittyGraphicsCommand): void {
    if (this.options.kittyGraphics === false) return // 设置里关了图形协议
    if (cmd.unicodePlacement) return // Unicode 占位：暂不支持，忽略
    if (cmd.action === 'd') {
      this.deleteGraphics(cmd)
      return
    }
    if (cmd.action === 't' || cmd.action === 'T' || cmd.action === 'p') {
      this.displayGraphics(cmd)
    }
    // 'a'（动画）/ 'f'（帧）/ 'q'（查询）超出静态图片范围，忽略
  }

  /** 传输（'t'/'T'）与摆放（'p'/'T'）：分块重组后解码 */
  private displayGraphics(cmd: KittyGraphicsCommand): void {
    if (cmd.action === 'p') {
      // 只摆放：复用已解码的图片
      const img = this.graphicsImages.get(cmd.imageNumber)
      if (img) {
        this.placeGraphics(cmd, img)
        this.syncGraphics()
      }
      return
    }
    if (cmd.more === 1 || this.graphicsChunks.has(cmd.imageNumber)) {
      let bucket = this.graphicsChunks.get(cmd.imageNumber)
      if (!bucket) {
        bucket = { parts: [], cmd }
        this.graphicsChunks.set(cmd.imageNumber, bucket)
      }
      bucket.cmd = cmd
      if (cmd.payload) bucket.parts.push(cmd.payload)
      if (cmd.more === 1) return // 还有后续块
      this.graphicsChunks.delete(cmd.imageNumber)
      void this.decodeAndPlace(bucket.parts.join(''), bucket.cmd)
      return
    }
    void this.decodeAndPlace(cmd.payload, cmd)
  }

  private async decodeAndPlace(payload: string, cmd: KittyGraphicsCommand): Promise<void> {
    try {
      let bytes = decodeBase64(payload)
      if (cmd.compressed === 1) bytes = await inflateZlib(bytes)
      let source: CanvasImageSource
      let w: number
      let h: number
      if (cmd.format === 100 || cmd.format === 200) {
        const bmp = await createImageBitmap(new Blob([bytes as BlobPart], { type: 'image/png' }))
        source = bmp
        w = bmp.width
        h = bmp.height
      } else if (cmd.format === 32 || cmd.format === 24) {
        // 原始像素：32 = RGBA，24 = RGB
        const iw = cmd.dataWidth || cmd.width
        const ih = cmd.dataHeight || cmd.height
        if (!iw || !ih) return
        const bpp = cmd.format === 32 ? 4 : 3
        if (bytes.length < iw * ih * bpp) return
        const data = new Uint8ClampedArray(iw * ih * 4)
        for (let i = 0, j = 0; i < iw * ih; i += 1, j += bpp) {
          data[i * 4] = bytes[j] as number
          data[i * 4 + 1] = bytes[j + 1] as number
          data[i * 4 + 2] = bytes[j + 2] as number
          data[i * 4 + 3] = cmd.format === 32 ? (bytes[j + 3] as number) : 255
        }
        const bmp = await createImageBitmap(new ImageData(data, iw, ih))
        source = bmp
        w = iw
        h = ih
      } else {
        return // 200 级 PNG 走 format===200；其余（SBIR 等）不支持
      }
      const img: DecodedImage = { source, w, h, rev: ++this.graphicsRev }
      this.graphicsImages.set(cmd.imageNumber, img)
      if (cmd.action === 't' || cmd.action === 'T' || cmd.action === 'p') this.placeGraphics(cmd, img)
      this.syncGraphics()
    } catch {
      // 解码失败：静默（kitty 对坏图同样只丢弃）
    }
  }

  /** 在当前光标位置落一个摆放（kitty 默认把图放到光标处） */
  private placeGraphics(cmd: KittyGraphicsCommand, img: DecodedImage): void {
    const meta = this.meta
    if (!meta) return
    const key = cmd.placementId > 0 ? `p${cmd.placementId}` : `i${cmd.imageNumber}`
    this.graphicsPlacements.set(key, {
      imageNumber: cmd.imageNumber,
      revision: img.rev,
      absLine: meta.scrollbackLength - meta.scrolledBy + meta.cursor.y,
      col: meta.cursor.x,
      yOffsetPx: cmd.yOffset,
      z: cmd.zIndex,
      source: img.source,
      pxW: img.w,
      pxH: img.h,
    })
  }

  /** a=d 删除：A=全部、i=按图片号、I=按摆放号（与 kitty deleteGraphics 对齐的子集） */
  private deleteGraphics(cmd: KittyGraphicsCommand): void {
    const q = cmd.deleteAction
    if (!q) return
    if (q === 'A') {
      this.clearGraphics()
      return
    }
    let touched = false
    if (q === 'i') {
      for (const [k, p] of this.graphicsPlacements) {
        if (p.imageNumber === cmd.imageNumber) {
          this.graphicsPlacements.delete(k)
          touched = true
        }
      }
      this.graphicsImages.delete(cmd.imageNumber)
    } else if (q === 'I' && cmd.placementId > 0) {
      touched = this.graphicsPlacements.delete(`p${cmd.placementId}`)
    }
    if (touched) this.syncGraphics()
  }

  private clearGraphics(): void {
    if (this.graphicsPlacements.size === 0 && this.graphicsImages.size === 0) return
    this.graphicsPlacements.clear()
    this.graphicsImages.clear()
    this.graphicsChunks.clear()
    this.syncGraphics()
  }

  private syncGraphics(): void {
    this.renderer.setImages([...this.graphicsPlacements.values()])
    this.scheduleRender()
  }

  /* ─────────────────────────── 渲染 ─────────────────────────── */

  private scheduleRender(): void {
    if (this.disposed || !this.visible) return
    if (this.raf !== 0) return
    this.raf = requestAnimationFrame(() => {
      this.raf = 0
      this.renderNow()
    })
  }

  private renderNow(): void {
    if (this.disposed) return
    this.syncDecorations()
    this.renderer.render()
    this.updateScrollbar()
    // 光标拖尾/滑动动画未收尾时持续排帧，直到光标贴合目标、残影烧完
    if (this.renderer.animActive) this.scheduleRender()
    for (const cb of this.renderListeners) cb()
    this.opts.onWriteParsed?.()
  }

  /* ─────────────────────────── 回看滚动条 ─────────────────────────── */

  /** 每帧同步滚动条与回看徽标（渲染路径上，必须足够便宜） */
  private updateScrollbar(): void {
    const meta = this.meta
    const history = meta?.scrollbackLength ?? 0
    const scrolledBy = meta?.scrolledBy ?? 0
    const total = history + this.rows
    const scrollable = !meta?.modes.altScreen && total > this.rows && this.rows > 0
    this.scrollbar.classList.toggle('kitty-scrollbar--on', scrollable)
    if (scrollable) {
      // 视口顶的绝对行号 = history - scrolledBy；thumb 顶部比例 = 该行 / 总行数
      const frac = this.rows / total
      const h = Math.min(1, frac) * 100
      const top = Math.max(0, Math.min(1 - frac, (history - scrolledBy) / total)) * 100
      this.thumb.style.height = `${h}%`
      this.thumb.style.top = `${top}%`
    }
    if (scrolledBy > 0) {
      this.review.textContent = `回看 ${scrolledBy} 行 · 点击回底`
      this.review.classList.add('kitty-review--on')
    } else {
      this.review.classList.remove('kitty-review--on')
    }
  }

  private bindScrollbar(): void {
    const signal = this.scrollbarAbort.signal
    const thumbDown = (e: MouseEvent): void => {
      e.preventDefault()
      e.stopPropagation()
      this.dragScroll = { startY: e.clientY, startTopPx: this.thumb.offsetTop }
      this.scrollbar.classList.add('kitty-scrollbar--dragging')
    }
    const thumbMove = (e: MouseEvent): void => {
      if (!this.dragScroll || !this.meta) return
      const meta = this.meta
      const total = meta.scrollbackLength + this.rows
      const trackH = Math.max(1, this.scrollbar.clientHeight - this.thumb.offsetHeight)
      // thumb 每移动 1px，视口顶移动 (total - rows) / 可滑行程 行
      const rowsPerPx = (total - this.rows) / trackH
      const movedPx = e.clientY - this.dragScroll.startY
      // startTopPx 对应视口顶绝对行，换算成期望的 scrolledBy
      const startTopRows = (this.dragScroll.startTopPx / Math.max(1, this.scrollbar.clientHeight)) * total
      const wantTop = Math.max(0, Math.min(meta.scrollbackLength, startTopRows + movedPx * rowsPerPx))
      const wantScrolledBy = meta.scrollbackLength - wantTop
      const delta = Math.round(meta.scrolledBy - wantScrolledBy)
      if (delta !== 0) this.session?.scroll(delta)
    }
    const thumbUp = (): void => {
      this.dragScroll = null
      this.scrollbar.classList.remove('kitty-scrollbar--dragging')
    }
    this.thumb.addEventListener('mousedown', thumbDown)
    window.addEventListener('mousemove', thumbMove, { signal })
    window.addEventListener('mouseup', thumbUp, { signal })
    // 点轨道空白 = 翻页（与 xterm/常见终端一致）
    this.scrollbar.addEventListener('mousedown', (e) => {
      if (e.target !== this.scrollbar) return
      const rect = this.scrollbar.getBoundingClientRect()
      this.session?.scroll(e.clientY < rect.top + rect.height / 2 ? 'page-up' : 'page-down')
    })
  }

  private syncDecorations(): void {
    const meta = this.meta
    if (!meta) return
    const base = meta.scrollbackLength - meta.scrolledBy
    const spans: HighlightSpan[] = []
    for (const deco of this.decorations) {
      if (deco.disposed) continue
      const y = deco.absLine - base
      if (y < 0 || y >= this.rows) continue
      spans.push({ line: deco.absLine, x1: deco.x, x2: deco.x + deco.width - 1, color: parseHex(deco.color) })
    }
    this.renderer.setHighlights(spans)
    this.renderer.setSearch(this.searchSpans, this.searchActive)
  }

  private startBlink(): void {
    window.clearInterval(this.blinkTimer)
    // kitty cursor_blink_interval 0.5
    this.blinkTimer = window.setInterval(() => {
      if (this.disposed) return
      // kitty cursor_stop_blinking_after 15：光标静止 15s 后常亮，不再闪
      if (Date.now() - this.lastCursorMoveAt > 15000) {
        this.blinkOff = false
        if (this.renderer.setBlinkOff(false)) this.scheduleRender()
        return
      }
      this.blinkOff = !this.blinkOff
      if (this.renderer.setBlinkOff(this.blinkOff)) this.scheduleRender()
    }, 500)
  }

  /* ─────────────────────────── 尺寸 ─────────────────────────── */

  private cssWidth(): number {
    return Math.max(1, this.element.clientWidth)
  }

  private cssHeight(): number {
    return Math.max(1, this.element.clientHeight)
  }

  private measure(): { cols: number; rows: number } {
    const dpr = Math.max(1, window.devicePixelRatio || 1)
    const pad = this.options.padding
    const cw = this.atlas.cellW / dpr
    const ch = this.atlas.cellH / dpr
    const cols = Math.max(2, Math.floor((this.cssWidth() - pad * 2) / cw))
    const rows = Math.max(1, Math.floor((this.cssHeight() - pad * 2) / ch))
    return { cols, rows }
  }

  fit(): void {
    if (this.disposed) return
    const pad = this.options.padding
    const { cols, rows } = this.measure()
    const dpr = Math.max(1, window.devicePixelRatio || 1)
    // canvas 只覆盖网格区域，剩下的由 padding 留白（这样字符不会被拉变形）
    const width = cols * (this.atlas.cellW / dpr)
    const height = rows * (this.atlas.cellH / dpr)
    this.canvas.style.left = `${pad}px`
    this.canvas.style.top = `${pad}px`
    this.canvas.style.width = `${width}px`
    this.canvas.style.height = `${height}px`
    this.screen.style.left = `${pad}px`
    this.screen.style.top = `${pad}px`
    this.screen.style.width = `${width}px`
    this.screen.style.height = `${height}px`
    this.renderer.resize(width, height, cols, rows, dpr)
    if (cols !== this.cols || rows !== this.rows) {
      this.cols = cols
      this.rows = rows
      this.grid = new Uint32Array(cols * rows * KITTY_CELL_WORDS)
      this.rowValid = new Uint8Array(rows)
      this.rowsText = new Array(rows).fill('')
      void this.session?.resize(cols, rows)
      this.opts.onResize?.(cols, rows)
      for (const cb of this.resizeListeners) cb({ cols, rows })
    }
    this.scheduleRender()
  }

  /* ─────────────────────────── 输入 ─────────────────────────── */

  private bindDom(): void {
    const wrap = this.wrap
    wrap.addEventListener('mousedown', this.onMouseDown)
    wrap.addEventListener('wheel', this.onWheel, { passive: false })
    this.ime.addEventListener('keydown', this.onKeyDown)
    this.ime.addEventListener('compositionstart', () => {
      this.composing = true
    })
    this.ime.addEventListener('compositionend', (e) => {
      this.composing = false
      if (e.data) void this.sendText(e.data)
      this.ime.value = ''
    })
    this.ime.addEventListener('input', () => {
      if (this.composing) return
      const value = this.ime.value
      if (value) void this.sendText(value)
      this.ime.value = ''
    })
    this.ime.addEventListener('paste', (e) => {
      const text = e.clipboardData?.getData('text/plain') ?? ''
      if (!text) return
      e.preventDefault()
      this.session?.paste(text)
    })
    this.ime.addEventListener('focus', () => {
      this.renderer.setFocused(true)
      this.session?.focus(true)
    })
    this.ime.addEventListener('blur', () => {
      this.renderer.setFocused(false)
      this.session?.focus(false)
    })
  }

  private modsOf(e: KeyboardEvent | MouseEvent): number {
    return (e.shiftKey ? 1 : 0) | (e.altKey ? 2 : 0) | (e.ctrlKey ? 4 : 0) | (e.metaKey ? 8 : 0)
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    if (this.disposed || !this.session) return
    if (this.composing) return
    // 组合键交给上层（复制/粘贴/查找/补全）
    if (e.ctrlKey && e.shiftKey) return
    if (e.metaKey) return
    if (e.key === 'Process' || e.key === 'Unidentified') return
    if (e.key === 'Shift' || e.key === 'Control' || e.key === 'Alt' || e.key === 'Meta') return

    const special = SPECIAL_KEYS[e.key]
    const mods = this.modsOf(e)
    if (special) {
      e.preventDefault()
      this.session.key(special, mods, e.repeat ? 'repeat' : 'press')
      this.scheduleRender()
      return
    }
    // 单字符：交给 kitty 的编码器（它会处理 CSI u / 应用光标键等模式）
    if (e.key.length === 1) {
      e.preventDefault()
      this.session.key(e.key, mods, e.repeat ? 'repeat' : 'press')
      return
    }
  }

  /** 文本输入（IME 提交、多字符粘贴等价路径） */
  private async sendText(text: string): Promise<void> {
    if (!this.session) return
    // IME 提交的整段文本按字符逐个交给 kitty 的编码器（它负责 UTF-8 与 CSI u 的组合）
    for (const ch of text) this.session.key(ch, 0, 'press')
  }

  private cellAt(clientX: number, clientY: number): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect()
    const dpr = Math.max(1, window.devicePixelRatio || 1)
    const cw = this.atlas.cellW / dpr
    const ch = this.atlas.cellH / dpr
    const x = Math.floor((clientX - rect.left) / cw)
    const y = Math.floor((clientY - rect.top) / ch)
    return {
      x: Math.max(0, Math.min(this.cols - 1, x)),
      y: Math.max(0, Math.min(this.rows - 1, y)),
    }
  }

  private onMouseDown = (e: MouseEvent): void => {
    this.focus()
    if (e.button === 2) {
      if (this.options.rightClickPaste) {
        e.preventDefault()
        void navigator.clipboard
          .readText()
          .then((text) => {
            if (text) this.session?.paste(text)
          })
          .catch(() => undefined)
      }
      return
    }
    if (e.button !== 0) return
    const { x, y } = this.cellAt(e.clientX, e.clientY)
    if (this.meta?.modes.mouseTracking) {
      this.session?.mouse({ x, y, button: 'left', action: 'press', mods: this.modsOf(e) })
      return
    }
    this.dragging = true
    void this.session?.selection('start', x, y, { rectangle: e.altKey })
    window.addEventListener('mousemove', this.onMouseMove)
    window.addEventListener('mouseup', this.onMouseUp, { once: true })
  }

  private onMouseMove = (e: MouseEvent): void => {
    if (!this.dragging) return
    const { x, y } = this.cellAt(e.clientX, e.clientY)
    if (this.meta?.modes.mouseTracking) {
      this.session?.mouse({ x, y, button: 'none', action: 'move', mods: this.modsOf(e) })
      return
    }
    void this.session?.selection('update', x, y, {});
  }

  private onMouseUp = (e: MouseEvent): void => {
    this.dragging = false
    window.removeEventListener('mousemove', this.onMouseMove)
    if (this.meta?.modes.mouseTracking) {
      const { x, y } = this.cellAt(e.clientX, e.clientY)
      this.session?.mouse({ x, y, button: 'left', action: 'release', mods: this.modsOf(e) })
      return
    }
    void this.session
      ?.selection('update', this.cellAt(e.clientX, e.clientY).x, this.cellAt(e.clientX, e.clientY).y, {
        ended: true,
      })
      .then((res) => {
        this.selectionText = res?.text ?? ''
        for (const cb of this.selectionListeners) cb()
        this.opts.onSelectionChange?.()
        if (this.options.copyOnSelect && this.selectionText) {
          void navigator.clipboard.writeText(this.selectionText).catch(() => undefined)
        }
      })
  }

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault()
    const mode = this.meta?.modes
    if (mode?.mouseTracking && mode.altScreen) {
      const { x, y } = this.cellAt(e.clientX, e.clientY)
      const button = e.deltaY < 0 ? 'wheel-up' : 'wheel-down'
      this.session?.mouse({ x, y, button, action: 'press', mods: this.modsOf(e) })
      return
    }
    const lines = Math.max(1, Math.round((Math.abs(e.deltaY) / 40) * this.options.wheelMultiplier))
    this.session?.scroll(e.deltaY < 0 ? lines : -lines)
  }

  /* ─────────────────────────── xterm 兼容面 ─────────────────────────── */

  focus(): void {
    this.ime.focus({ preventScroll: true })
  }

  /**
   * 写入输出。
   *
   * 第二个参数是 **xterm 的写入完成回调**：窗格的背压写入器依赖它串行化写入
   * （一次只允许一个未完成的 write）。我们这里把「已投递给 Worker」当作完成，
   * 用微任务回调即可 —— 背压的目标是不让队列无限膨胀，这一点已经达到。
   */
  write(data: string, cb?: () => void): void {
    if (!this.session) {
      cb?.()
      return
    }
    this.session.write(new TextEncoder().encode(data))
    if (cb) queueMicrotask(cb)
  }

  paste(text: string): void {
    this.session?.paste(text)
  }

  clear(): void {
    // 发 Ctrl+L 不够（有些程序不认），等价于 xterm 的 clear()：清屏 + 光标归位
    this.write('\x1b[H\x1b[2J')
  }

  scrollToBottom(): void {
    this.session?.scroll('bottom')
  }

  getSelection(): string {
    return this.selectionText
  }

  refresh(): void {
    this.session?.refresh()
    this.scheduleRender()
  }

  /** 焦点/可见性：隐藏时停止渲染，保留内核状态（资源分级） */
  setVisible(visible: boolean): void {
    this.visible = visible
    if (visible) {
      this.fit()
      this.session?.refresh()
    }
  }

  onData(cb: (data: string) => void): { dispose: () => void } {
    this.dataListeners.add(cb)
    return { dispose: () => this.dataListeners.delete(cb) }
  }

  private emitData(data: string): void {
    for (const cb of this.dataListeners) cb(data)
  }

  onResize(cb: (size: { cols: number; rows: number }) => void): { dispose: () => void } {
    this.resizeListeners.add(cb)
    return { dispose: () => this.resizeListeners.delete(cb) }
  }

  onBell(cb: () => void): { dispose: () => void } {
    this.bellListeners.add(cb)
    return { dispose: () => this.bellListeners.delete(cb) }
  }

  onSelectionChange(cb: () => void): { dispose: () => void } {
    this.selectionListeners.add(cb)
    return { dispose: () => this.selectionListeners.delete(cb) }
  }

  onRender(cb: () => void): { dispose: () => void } {
    this.renderListeners.add(cb)
    return { dispose: () => this.renderListeners.delete(cb) }
  }

  onWriteParsed(cb: () => void): { dispose: () => void } {
    // 与 xterm 的语义对齐：解析后（我们这里是一帧画完）回调一次
    return this.onRender(cb)
  }

  /** OSC 处理器（只支持「按 code 注册」这一 xterm 用法） */
  readonly parser = {
    registerOscHandler: (code: number, cb: (data: string) => boolean): { dispose: () => void } => {
      this.oscHandlers.set(code, cb)
      return { dispose: () => this.oscHandlers.delete(code) }
    },
  }

  /**
   * 注册书签。
   *
   * xterm 的 `registerMarker(offset)` 收的是**相对光标行的偏移**（负数向上），
   * 这里换算成绝对行号，后续窗口滚动/回看都不会让它漂移。
   */
  registerMarker(offset: number): Marker | undefined {
    if (!this.meta) return undefined
    const cursorAbs = this.meta.scrollbackLength - this.meta.scrolledBy + this.meta.cursor.y
    const marker: Marker = {
      absLine: cursorAbs + offset,
      disposed: false,
      dispose: () => {
        marker.disposed = true
        const i = this.markers.indexOf(marker)
        if (i >= 0) this.markers.splice(i, 1)
      },
    }
    this.markers.push(marker)
    return marker
  }

  registerDecoration(opts: {
    marker: Marker
    x: number
    width: number
    foregroundColor: string | null
  }): DecorationImpl | undefined {
    if (!opts.foregroundColor) return undefined
    const deco = new DecorationImpl(opts.marker.absLine, opts.x, Math.max(1, opts.width), opts.foregroundColor)
    this.decorations.push(deco)
    this.scheduleRender()
    return deco
  }

  /** 供窗格读取光标位置（补全弹窗定位用）：形如 xterm 的 `term.buffer` */
  get buffer(): {
    active: { baseY: number; cursorX: number; cursorY: number; getLine: (y: number) => LineView | null }
  } {
    return { active: this.activeBuffer }
  }

  get activeBuffer(): { baseY: number; cursorX: number; cursorY: number; getLine: (y: number) => LineView | null } {
    const base = this.meta ? this.meta.scrollbackLength - this.meta.scrolledBy : 0
    return {
      baseY: base,
      cursorX: this.meta?.cursor.x ?? 0,
      cursorY: this.meta?.cursor.y ?? 0,
      getLine: (absY: number): LineView | null => {
        const y = absY - base
        if (y < 0 || y >= this.rows) return null
        const text = this.rowsText[y] ?? ''
        return { translateToString: (trimRight = true) => (trimRight ? text.replace(/\s+$/, '') : text) }
      },
    }
  }

  /** 搜索（xterm 的 SearchAddon 替身） */
  readonly searchShim = {
    findNext: (term: string, opts?: { incremental?: boolean }): boolean => {
      this.runSearch(term, opts?.incremental && term === this.searchPattern ? 'next' : 'first')
      return this.searchSpans.length > 0
    },
    findPrevious: (term: string): boolean => {
      this.runSearch(term, 'prev')
      return this.searchSpans.length > 0
    },
    clearDecorations: (): void => {
      this.searchSpans = []
      this.searchActive = -1
      this.scheduleRender()
    },
  }

  private runSearch(term: string, step: 'first' | 'next' | 'prev'): void {
    if (!this.session) return
    if (step === 'first') this.searchPattern = term
    void this.session.search(term, step).then((res) => {
      const base = res.scrolledBy
      void base
      // hits 的 y 是相对当前视口的行号；换算成绝对行号给渲染器
      const meta = this.meta
      if (!meta) return
      const abs0 = meta.scrollbackLength - meta.scrolledBy
      this.searchSpans = res.hits.map((h) => ({ line: abs0 + h.y, x1: h.x1, x2: h.x2 }))
      this.searchActive = res.index
      this.scheduleRender()
    })
  }

  /**
   * 应用明暗模式（深色 ↔ 浅色切换）。
   *
   * resolvedTheme 原先只在构造时捕获，之后 buildTheme（applySettings 与
   * 每帧的 refreshThemeBase）都读构造时的旧值 —— 切换应用主题后 kitty
   * 渲染器永远停在旧配色上。窗格在 resolvedTheme 变化时必须调用这里。
   */
  setResolvedTheme(mode: 'light' | 'dark'): void {
    if (this.opts.resolvedTheme === mode) return
    ;(this.opts as { resolvedTheme: 'light' | 'dark' }).resolvedTheme = mode
    this.theme = buildTheme({
      settings: this.options,
      resolved: mode,
      core: this.customThemeBase ?? undefined,
    })
    this.renderer.setTheme(this.theme)
  }

  /** 换主题/字体（设置热更新） */
  applySettings(settings: TerminalSettings): void {
    Object.assign(this.options, settings)
    if (settings.renderer === 'xterm') return // 由窗格负责整体切换
    const fontChanged =
      settings.fontFamily !== undefined &&
      (this.atlas.fontFamilyCss !== settings.fontFamily ||
        this.atlas.fontSizeDpr !== Math.round(settings.fontSize * (window.devicePixelRatio || 1)) ||
        this.atlas.fontWeight !== settings.fontWeight)
    if (fontChanged) {
      this.rebuildAtlas(settings)
      return
    }
    this.theme = buildTheme({
      settings,
      resolved: this.opts.resolvedTheme,
      core: this.customThemeBase ?? undefined,
    })
    this.renderer.setTheme(this.theme)
    this.renderer.setOptions({ ligatures: settings.ligatures, zebra: settings.zebraStripes })
    this.renderer.setCursorTrail(settings.cursorTrail)
    this.renderer.setCursorShapeOverride(settings.cursorStyle)
    this.renderer.setCursorInactiveStyle(settings.cursorInactiveStyle)
    // 闪烁开关热更新：false = 清定时器常亮；true = 重启定时器
    if (settings.cursorBlink !== undefined) {
      window.clearInterval(this.blinkTimer)
      this.blinkOff = false
      if (this.renderer.setBlinkOff(false)) this.scheduleRender()
      if (settings.cursorBlink) this.startBlink()
    }
    this.fit()
  }

  private rebuildAtlas(settings: TerminalSettings): void {
    const dpr = Math.max(1, window.devicePixelRatio || 1)
    const atlas = new GlyphAtlas({
      fontFamily: settings.fontFamily,
      fontSize: settings.fontSize,
      fontWeight: settings.fontWeight,
      boldWeight: settings.boldWeight,
      fontFeatures: settings.fontFeatures,
      ligatures: settings.ligatures,
      dpr,
    })
    this.renderer.dispose()
    // 用新图集重建渲染器（句柄变了，直接换掉实例）
    Object.assign(this, { atlas })
    this.renderer = this.createRenderer(dpr)
    this.fit()
  }

  get backendLabel(): string {
    return this.renderer instanceof WebGLTerminalRenderer ? 'WebGL2' : 'Canvas'
  }

  get kernelLabel(): string {
    return `kitty VT · ${this.cols}×${this.rows}`
  }

  /** 供状态栏/诊断读取 */
  get stats(): { scrollback: number; scrolledBy: number; mode: string; cwd: string } {
    const meta = this.meta
    return {
      scrollback: meta?.scrollbackLength ?? 0,
      scrolledBy: meta?.scrolledBy ?? 0,
      mode: meta?.modes.altScreen ? 'alt' : 'main',
      cwd: this.lastCwd,
    }
  }

  /** 当前视口文本（诊断/截图比对用） */
  viewportText(): string {
    return this.rowsText.join('\n')
  }

  /** 拖尾内部状态（验收脚本用；canvas 回退渲染器返回 null） */
  trailDebug():
    | ReturnType<WebGLTerminalRenderer['trailDebug']>
    | null {
    const r = this.renderer
    return r instanceof WebGLTerminalRenderer ? r.trailDebug() : null
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.scrollbarAbort.abort()
    window.clearInterval(this.blinkTimer)
    if (this.raf !== 0) cancelAnimationFrame(this.raf)
    window.removeEventListener('mousemove', this.onMouseMove)
    this.ime.removeEventListener('keydown', this.onKeyDown)
    this.clearGraphics()
    this.session?.dispose()
    this.session = null
    this.renderer.dispose()
    this.wrap.remove()
  }
}

