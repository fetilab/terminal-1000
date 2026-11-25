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
import { copyText, copyToSelection, readClipboardText, readSelectionText } from '../../../lib/clipboard'

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
  /** 是否处于闪烁模式（cursorBlink=true）；false = 常亮 */
  private blinking = false
  /** 窗格是否持有输入焦点（kitty 只在聚焦窗口上闪光标） */
  private focused = true
  /**
   * 粘滞修饰键（触摸键盘的 Ctrl/Alt）。
   *
   * 软键盘发不出 Ctrl，而 `Ctrl+R`/`Ctrl+A`/`Ctrl+K` 是 shell 的日常操作。
   * 这里存"下一次输入要带上的修饰位"，由 `takePendingMods` **取走并清零** ——
   * 粘滞键绝不能漏到后续输入里，否则用户会莫名其妙地发出控制字符。
   */
  private pendingMods = 0
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
  /** kitty drag_threshold（css px）：位移不超过它算「点击」，不启动拖拽 */
  private static readonly DRAG_THRESHOLD = 5
  /** kitty click_interval（ms）：双击/三击判定窗口 */
  private static readonly CLICK_INTERVAL = 500
  /**
   * 当前这次按下的手势。kitty 把「按下」拆成 press / drag / click 三种语义，
   * 全靠这份状态区分（见 mouse.c 的 handle_button_event / handle_potential_drag）。
   */
  private gesture: {
    button: number
    x: number
    y: number
    half: boolean
    clientX: number
    clientY: number
    dragging: boolean
    /** 转发给程序（程序抓了鼠标），不参与本地选择 */
    forwarded: boolean
    /** 第几次连续点击（1/2/3） */
    count: number
  } | null = null
  /** 最近几次按下的时间与位置（双击/三击判定） */
  private clickHistory: { at: number; x: number; y: number }[] = []
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
    this.syncWrapBg()

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
    // 点徽标回底：同时挡掉 mousedown，避免顺带起一个选区
    this.review.addEventListener('mousedown', (e) => e.stopPropagation())
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
            // 光标跳了：点亮 + 重新起表，避免正好落在「灭」的相位里
            this.noteActivity()
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
    // 全部对齐 kitty 默认值：cursor_trail 3（毫秒）、decay 0.1 0.4、
    // start_threshold 2 格、beam 1.5pt、underline 2.0pt（96dpi 下 2px / 2.67px）
    this.renderer.setCursorTrail(this.options.cursorTrail)
    if (typeof (this.renderer as WebGLTerminalRenderer).setTrailDecay === 'function') {
      const glr = this.renderer as WebGLTerminalRenderer
      glr.setTrailDecay(0.1, 0.4)
      glr.setTrailThreshold(2, 2)
      glr.setBeamThicknessPx(2) // 1.5pt @96dpi
      glr.setUnderlineThicknessPx(2.67) // 2.0pt @96dpi
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
    this.syncWrapBg()
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
        /*
         * OSC 52：程序要求写系统剪贴板（tmux/vim 的 yank 会用）。
         * 必须走主进程 —— 渲染层的 navigator.clipboard 要求 document 有焦点，
         * 而 OSC 52 往往是在后台/失焦时触发的。
         */
        if (!ev.query && ev.data) void copyText(ev.data).catch(() => undefined)
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
      // 别让它冒泡到 .kitty-surface —— 否则点轨道会顺带起一个选区
      e.stopPropagation()
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
    this.blinking = true
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

  private stopBlink(): void {
    window.clearInterval(this.blinkTimer)
    this.blinkTimer = 0
    this.blinking = false
    if (this.blinkOff) {
      this.blinkOff = false
      if (this.renderer.setBlinkOff(false)) this.scheduleRender()
    }
  }

  /**
   * 有活动（按键、输出、光标跳动）时，闪烁相位立刻回到「亮」。
   *
   * 之前的定时器只翻相位、不看活动时刻：你刚敲一个字或移动光标，若正好落在
   * 「灭」的那半个周期，光标就地消失 0.5 秒 —— 用起来就是「一动光标就看不见」。
   *
   * kitty 的规则是「活动后从可见开始重新计时」，这里照做：点亮 + 重新起表。
   * 常亮模式（cursorBlink=false）下什么都不用做。
   */
  noteActivity(): void {
    this.lastCursorMoveAt = Date.now()
    if (!this.blinking) return
    if (this.blinkOff) {
      this.blinkOff = false
      if (this.renderer.setBlinkOff(false)) this.scheduleRender()
    }
    this.startBlink()
  }

  /* ─────────────────────────── 尺寸 ─────────────────────────── */

  private cssWidth(): number {
    return Math.max(1, this.element.clientWidth)
  }

  /**
   * 让 .kitty-surface 的底色与画布清屏色一致。
   *
   * 渲染器的 canvas 只覆盖「网格区域」：四周由 options.padding 留白，
   * 留白处看到的是容器底色。如果容器底色不是终端底色（例如透明、或面板色），
   * 终端四周就会浮出一圈颜色不同的「间隔」，而且这圈和中间的字区永远对不上。
   * 把 wrap 底色同步成 theme.bg（含 alpha）后：alpha=1 时留白=画布色，
   * alpha=0（有媒体背景）时两者都是完全透明，都无缝。
   */
  private syncWrapBg(): void {
    const { r, g, b, a } = this.theme.bg
    const c = (v: number): number => Math.round(Math.min(1, Math.max(0, v)) * 255)
    this.wrap.style.backgroundColor = `rgba(${c(r)}, ${c(g)}, ${c(b)}, ${a})`
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
      this.focused = true
      this.renderer.setFocused(true)
      this.session?.focus(true)
      /*
       * kitty 的闪烁判据是 `cursor_blinking = !cursor->non_blinking && os_window->is_focused`
       * —— 只有聚焦的窗口才闪。失焦时光标常亮（形状换成 cursor_shape_unfocused），
       * 所以重新聚焦才需要起表；否则一个没在用的窗格也在那里闪，很吵。
       */
      if (this.options.cursorBlink !== false && !this.blinking) this.startBlink()
    })
    this.ime.addEventListener('blur', () => {
      this.focused = false
      this.renderer.setFocused(false)
      this.session?.focus(false)
      this.stopBlink()
    })
  }

  private modsOf(e: KeyboardEvent | MouseEvent): number {
    return (e.shiftKey ? 1 : 0) | (e.altKey ? 2 : 0) | (e.ctrlKey ? 4 : 0) | (e.metaKey ? 8 : 0)
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    if (this.disposed || !this.session) return
    // 按键即活动：连敲时不该出现「光标在灭的相位里」，点了键就该看得见
    this.noteActivity()
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
    // 粘滞 Ctrl/Alt 只作用于**紧接着的第一个字符**：用户按了 Ctrl 再敲 a，
    // 得到的是 Ctrl+A；后面继续敲的字仍是普通输入。
    let mods = this.takePendingMods()
    // IME 提交的整段文本按字符逐个交给 kitty 的编码器（它负责 UTF-8 与 CSI u 的组合）
    for (const ch of text) {
      this.session.key(ch, mods, 'press')
      mods = 0
    }
  }

  /**
   * 指针所在的格子 + **格内左右半**。
   *
   * 半格不是花活：kitty 的选区端点记 `in_left_half_of_cell`，它同时决定
   * 边界格算不算进选区、以及「按下没动」时选区的空/非空
   * （`is_selection_empty()` 要求同一格**同一半格**）。
   */
  private cellAtEx(clientX: number, clientY: number): { x: number; y: number; half: boolean } {
    const rect = this.canvas.getBoundingClientRect()
    const dpr = Math.max(1, window.devicePixelRatio || 1)
    const cw = this.atlas.cellW / dpr
    const ch = this.atlas.cellH / dpr
    const fx = (clientX - rect.left) / cw
    const fy = (clientY - rect.top) / ch
    const cx = Math.floor(fx)
    const cy = Math.floor(fy)
    const x = Math.max(0, Math.min(this.cols - 1, cx))
    const y = Math.max(0, Math.min(this.rows - 1, cy))
    // 越界到左边按"左半"、右边按"右半"，这样拖到窗口外仍能选到行首/行尾
    const half = cx < 0 ? true : cx >= this.cols ? false : fx - cx < 0.5
    return { x, y, half }
  }

  private cellAt(clientX: number, clientY: number): { x: number; y: number } {
    const { x, y } = this.cellAtEx(clientX, clientY)
    return { x, y }
  }

  /** 连续点击计数：kitty 的 click_interval（默认 0.5s）+ 半格半径 */
  private clickCount(clientX: number, clientY: number): number {
    const now = performance.now()
    const dpr = Math.max(1, window.devicePixelRatio || 1)
    const radius = (this.atlas.cellH / dpr) * 0.5
    const near = (a: { x: number; y: number }, b: { x: number; y: number }): boolean =>
      Math.hypot(a.x - b.x, a.y - b.y) <= radius
    const h = this.clickHistory
    const last = h[h.length - 1]
    if (!last || now - last.at > KittyEngine.CLICK_INTERVAL || !near(last, { x: clientX, y: clientY })) {
      h.length = 0
    }
    h.push({ at: now, x: clientX, y: clientY })
    if (h.length > 3) h.shift()
    let count = 1
    if (h.length >= 3) {
      const [a, , c] = h
      if (a && c && c.at - a.at <= KittyEngine.CLICK_INTERVAL * 2 && near(a, c)) count = 3
    } else if (h.length === 2) {
      const [a, c] = h
      if (a && c && c.at - a.at <= KittyEngine.CLICK_INTERVAL && near(a, c)) count = 2
    }
    if (count === 3) h.length = 0
    return count
  }

  private onMouseDown = (e: MouseEvent): void => {
    this.focus()
    this.noteActivity()
    if (e.button === 2) {
      if (this.options.rightClickPaste) {
        e.preventDefault()
        void readClipboardText().then((text) => {
          if (text) this.session?.paste(text)
        })
      }
      return
    }
    if (e.button !== 0 && e.button !== 1) return
    const cell = this.cellAtEx(e.clientX, e.clientY)
    const mods = this.modsOf(e)
    const tracking = Boolean(this.meta?.modes.mouseTracking)
    const openGesture = (forwarded: boolean, count: number): void => {
      this.gesture = {
        button: e.button,
        x: cell.x,
        y: cell.y,
        half: cell.half,
        clientX: e.clientX,
        clientY: e.clientY,
        dragging: false,
        forwarded,
        count,
      }
      window.addEventListener('mousemove', this.onMouseMove)
      window.addEventListener('mouseup', this.onMouseUp, { once: true })
    }

    if (e.button === 1) {
      // 中键：程序抓了鼠标就转发；否则是 kitty 的 `middle release ungrabbed paste_from_selection`
      openGesture(tracking, 1)
      if (tracking) {
        this.session?.mouse({ x: cell.x, y: cell.y, button: 'middle', action: 'press', mods })
      } else if (this.options.middleClickPaste) {
        // kitty 的 `middle release ungrabbed paste_from_selection`：X11 上是 PRIMARY。
        // 这条默认映射可由「设置 → 终端 → 中键粘贴」关闭（触控板误触的用户）。
        void readSelectionText().then((text) => {
          if (text) this.session?.paste(text)
        })
      }
      return
    }
    /*
     * 三种情况分开处理，对应 kitty 的三条默认映射：
     * - 程序抓了鼠标且没按 Shift → 全部转发给程序（`left press grabbed`），
     *   本地不做任何选择；
     * - 程序抓了鼠标 + Shift → `shift+left press grabbed mouse_selection normal`，
     *   绕过程序做本地选择（vim/htop 里选文本就靠它）；
     * - 没抓鼠标 → 本地选择。
     */
    const localSelect = !tracking || e.shiftKey
    const count = this.clickCount(e.clientX, e.clientY)
    openGesture(!localSelect, count)

    if (!localSelect) {
      // 1000/1002/1003 的模式过滤在核心里做，这里只管把事件按次序送进去
      this.session?.mouse({ x: cell.x, y: cell.y, button: 'left', action: 'press', mods })
      return
    }
    /*
     * 按下只**起锚点**，不画任何东西：此时 anchor 与 cursor 是同一格的同一半格，
     * 内核算空选区（见 computeSelectionSpans），屏幕上不会出现色块。
     * 拖出去之后才变成可见的选区 —— 与 kitty 「按下并拖拽才出选区」一致。
     */
    if (count >= 3) {
      // 三击：选整行（kitty 的 triplepress）
      void this.session?.selection('line', cell.x, cell.y).then((res) => this.finishSelection(res))
    } else if (count === 2) {
      // 双击：选词（kitty 的 doublepress）
      void this.session?.selection('word', cell.x, cell.y).then((res) => this.finishSelection(res))
    } else {
      void this.session?.selection('start', cell.x, cell.y, {
        // kitty 默认是 ctrl+alt 矩形选择
        rectangle: e.ctrlKey && e.altKey,
        half: cell.half,
      })
    }
  }

  private onMouseMove = (e: MouseEvent): void => {
    const g = this.gesture
    if (!g) return
    const cell = this.cellAtEx(e.clientX, e.clientY)
    if (g.forwarded) {
      /*
       * 这一行是「vim 里拖不动、像卡死」的修复点。
       *
       * 早先按下就 return，move/up 监听根本没挂上：程序只收到 press，
       * 永远等不到 release，于是它认为鼠标一直被按着 —— 选中、拖拽全都不响应。
       */
      this.session?.mouse({
        x: cell.x,
        y: cell.y,
        button: 'left',
        action: 'move',
        mods: this.modsOf(e),
      })
      return
    }
    if (!g.dragging) {
      const dist = Math.hypot(e.clientX - g.clientX, e.clientY - g.clientY)
      if (dist <= KittyEngine.DRAG_THRESHOLD) return
      g.dragging = true
    }
    if (cell.x === g.x && cell.y === g.y && cell.half === g.half) return
    /*
     * 双击/三击之后接着拖：扩展粒度要跟着点击次数走（kitty 的
     * SelectionExtendMode）。只发 'update' 会把按词的选区立刻降级成按格，
     * 与「别人的 kitty」手感不一样。
     */
    const extend = g.count >= 3 ? 'line' : g.count === 2 ? 'word' : undefined
    void this.session?.selection('update', cell.x, cell.y, extend ? { half: cell.half, extend } : { half: cell.half })
  }

  private onMouseUp = (e: MouseEvent): void => {
    const g = this.gesture
    this.gesture = null
    window.removeEventListener('mousemove', this.onMouseMove)
    if (!g) return
    const cell = this.cellAtEx(e.clientX, e.clientY)
    if (g.forwarded) {
      this.session?.mouse({
        x: cell.x,
        y: cell.y,
        button: g.button === 1 ? 'middle' : 'left',
        action: 'release',
        mods: this.modsOf(e),
      })
      return
    }
    if (g.button === 1) return
    if (g.dragging) {
      const extend = g.count >= 3 ? 'line' : g.count === 2 ? 'word' : undefined
      void this.session
        ?.selection('update', cell.x, cell.y, extend ? { half: cell.half, ended: true, extend } : { half: cell.half, ended: true })
        .then((res) => this.finishSelection(res))
      return
    }
    if (g.count === 1 && !e.shiftKey) {
      /*
       * 单击（没拖动）：清掉选区。
       *
       * kitty 的 `left click` 动作是 `mouse_handle_click selection link prompt`，
       * 「已有选区就什么都不做」—— 那是靠 shell 集成把点击变成"移动光标"才有意义。
       * 我们没有 shell 集成，照搬的结果就是选区永远消不掉，所以这里做成点击即清空。
       */
      this.clearSelection()
      return
    }
  }

  /** 选区定稿：更新文本、通知订阅者、按设置自动复制 */
  private finishSelection(res: { text: string | null } | null): void {
    this.selectionText = res?.text ?? ''
    for (const cb of this.selectionListeners) cb()
    this.opts.onSelectionChange?.()
    /*
     * 选中即复制。
     *
     * 除了系统剪贴板，X11 上还要写 PRIMARY selection —— 那是「选中就能用中键
     * 粘出来」的约定，也正是我们中键粘贴读的那一块。只写 CLIPBOARD 的话，
     * 用户选中后去 xterm/别的程序里按中键会粘到旧内容。
     */
    if (this.selectionText) {
      void copyToSelection(this.selectionText)
      if (this.options.copyOnSelect) void copyText(this.selectionText).catch(() => undefined)
    }
  }

  /** 清空选区（单击、Esc） */
  clearSelection(): void {
    this.selectionText = ''
    void this.session?.selection('clear', 0, 0).then(() => this.finishSelection(null))
  }

  get hasSelection(): boolean {
    return this.selectionText.length > 0
  }

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault()
    const mode = this.meta?.modes
    const { x, y } = this.cellAtEx(e.clientX, e.clientY)
    if (mode?.mouseTracking) {
      // 程序在听鼠标：滚轮就是鼠标按钮 4/5，主屏备用屏都一样（kitty mouse.c）
      const button = e.deltaY < 0 ? 'wheel-up' : 'wheel-down'
      const times = Math.max(1, Math.round(Math.abs(e.deltaY) / 40))
      for (let i = 0; i < times; i += 1) {
        this.session?.mouse({ x, y, button, action: 'press', mods: this.modsOf(e) })
      }
      return
    }
    const lines = Math.max(1, Math.round((Math.abs(e.deltaY) / 40) * this.options.wheelMultiplier))
    if (mode?.altScreen) {
      /*
       * 备用屏没有回看区。kitty 的 fake_scroll 把滚轮翻译成 ↑/↓ 按键发给程序，
       * 这样 less/vim 这类全屏程序才能滚动；早先我们在这里去滚 scrollback，
       * 在备用屏上等于什么都没发生。
       */
      const key = e.deltaY < 0 ? 'ArrowUp' : 'ArrowDown'
      for (let i = 0; i < lines; i += 1) {
        this.session?.key(key, 0, 'press')
        this.session?.key(key, 0, 'release')
      }
      return
    }
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
    // 有输出 = 有活动：光标应保持亮着（程序在写屏时闪烁只是干扰）
    if (data.length > 0) this.noteActivity()
    this.session.write(new TextEncoder().encode(data))
    if (cb) queueMicrotask(cb)
  }

  paste(text: string): void {
    this.session?.paste(text)
  }

  /**
   * 合成一次按键 —— 给触摸键盘条用。
   *
   * 刻意走 `session.key` 而不是直接往 PTY 写 `\x1b[A` 这类字节：
   * 编码要由 kitty 内核按**当前模式**决定（legacy 控制字符 / CSI u 键盘协议 /
   * application cursor keys）。自己拼字节在 shell 里看着没问题，一进 vim
   * （切到 application cursor keys）方向键就全废 —— 这是终端模拟器的经典坑。
   */
  pressKey(key: string, mods = 0): void {
    if (this.disposed || !this.session) return
    this.noteActivity()
    this.session.key(key, mods, 'press')
    this.scheduleRender()
  }

  /** 设置粘滞修饰位（下一次输入生效一次） */
  setPendingMods(mods: number): void {
    this.pendingMods = mods
  }

  /** 取走粘滞修饰位并清零 */
  private takePendingMods(): number {
    const mods = this.pendingMods
    this.pendingMods = 0
    return mods
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
    this.syncWrapBg()
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
    this.syncWrapBg()
    this.renderer.setOptions({ ligatures: settings.ligatures, zebra: settings.zebraStripes })
    this.renderer.setCursorTrail(settings.cursorTrail)
    this.renderer.setCursorShapeOverride(settings.cursorStyle)
    this.renderer.setCursorInactiveStyle(settings.cursorInactiveStyle)
    // 闪烁开关热更新：false = 清定时器常亮；true = 重启定时器
    if (settings.cursorBlink !== undefined) {
      /*
       * 只在**真的变了**的时候动定时器。
       *
       * applySettings 会被窗格频繁调用（任何一项设置变化、甚至一次重渲染都可能触发）。
       * 早先这里无条件 startBlink()，等于每来一次就把 500ms 的计时清零 ——
       * 定时器永远也走不到触发点，光标看上去就是常亮，"闪烁"开关形同虚设。
       */
      const want = Boolean(settings.cursorBlink) && this.focused
      if (want !== this.blinking) {
        if (want) this.startBlink()
        else this.stopBlink()
      }
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

