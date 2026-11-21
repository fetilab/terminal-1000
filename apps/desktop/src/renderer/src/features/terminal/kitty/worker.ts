// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * kitty 终端内核 Worker。
 *
 * 这里跑的是 **kitty 真正的 VT 内核**（`kitty-vt-wasm`，由 kitty 的 `screen.c` +
 * `vt-parser.c` 编译而来）。它负责：解析字节流、维护主/备用屏与回看缓冲、
 * 选区、搜索、键位编码（`key_encoding.c`）、图形协议解析。
 *
 * 主线程只做两件事：把字节扔进来、把 cells 画出去。这样即使远端喷出 10MB/s 的
 * 输出，卡住的也只是这个 Worker，窗口依旧可拖动、可切换。
 *
 * 关键设计：
 * - **帧合并**：一次 `flush()` 把所有脏行合成一帧，微任务里只跑一次；
 * - **零拷贝**：每行的 `Uint32Array` 用 `slice()` 拷成独立 buffer 后 transfer，
 *   主线程拿到的是可转移的 ArrayBuffer，不经过结构化克隆的逐元素复制；
 * - **回看模式下全量重发**：回看内容来自 scrollback，`lineDirty` 不覆盖它，
 *   所以 `scrolledBy > 0` 时直接发整屏；
 * - **不做任何 DOM 假设**：Worker 里没有 document，所有渲染决策留给主线程。
 */

import {
  KittyTerminal,
  type KittyEvent,
  type KittyTerminalOptions,
} from 'kitty-vt-wasm'
import type {
  KittyCursorShape,
  KittyGraphicsCommand,
  KittyHostEvent,
  KittyMeta,
  KittyRequest,
  KittyResponse,
  KittyRow,
  KittySearchHit,
  KittySearchResult,
  KittySelectionSpan,
} from '@t1000/shared'
import { KITTY_CELL_WORDS } from '@t1000/shared'

/** 功能键名 → kitty 的 GLFW 键码（与 `key_encoding.c` 的输入约定一致） */
const FUNCTION_KEYS: Record<string, number> = {
  Escape: 57344,
  Enter: 57345,
  Tab: 57346,
  Backspace: 57347,
  Insert: 57348,
  Delete: 57349,
  ArrowLeft: 57350,
  ArrowRight: 57351,
  ArrowUp: 57352,
  ArrowDown: 57353,
  PageUp: 57354,
  PageDown: 57355,
  Home: 57356,
  End: 57357,
  F1: 57364,
  F2: 57365,
  F3: 57366,
  F4: 57367,
  F5: 57368,
  F6: 57369,
  F7: 57370,
  F8: 57371,
  F9: 57372,
  F10: 57373,
  F11: 57374,
  F12: 57375,
}

const CURSOR_SHAPES: Record<number, KittyCursorShape> = {
  0: 'block',
  1: 'block',
  2: 'beam',
  3: 'underline',
  4: 'hollow',
}

interface Session {
  term: KittyTerminal
  cols: number
  rows: number
  cols_words: number
  seq: number
  /** 上一次下发的 scrolledBy；变化时强制整屏重发 */
  lastScrolledBy: number
  forceFull: boolean
  title: string
  /** OSC 7 报告的工作目录（内核不导出，自己从原始字节里嗅探） */
  cwd: string
  selectionAnchor: { x: number; y: number } | null
  selectionCursor: { x: number; y: number } | null
  rectangle: boolean
  /** 搜索命中（绝对行号空间） */
  searchIndex: number
  searchHits: { abs: number; x1: number; x2: number }[]
  /** 一块字节里残留的 OSC 7 前缀（跨 chunk 时补齐） */
  cwdTail: string
  lastActivity: number
}

const sessions = new Map<string, Session>()
let wasmBuffer: ArrayBuffer | null = null
let wasmModule: WebAssembly.Module | null = null
let flushScheduled = false
const pendingFlush = new Set<string>()

function post(msg: KittyResponse, transfer: Transferable[] = []): void {
  ;(self as unknown as Worker).postMessage(msg, transfer)
}

function fail(id: number, error: unknown): void {
  post({ t: 'reply', id, ok: false, error: error instanceof Error ? error.message : String(error) })
}

/* ────────────────────────────── 会话创建 ────────────────────────────── */

async function createSession(
  sessionId: string,
  cols: number,
  rows: number,
  scrollback: number,
): Promise<void> {
  if (!wasmBuffer && !wasmModule) throw new Error('内核尚未加载')
  if (!wasmModule && wasmBuffer) {
    wasmModule = await WebAssembly.compile(wasmBuffer)
  }
  const opts: KittyTerminalOptions = {
    columns: cols,
    rows,
    scrollback,
    wasm: wasmModule ?? wasmBuffer ?? undefined,
    onOutput: (bytes) => {
      // 内核要给应用的回复（DA/DSR/DECRQSS/OSC 查询…）——原样转发到 PTY
      post({ t: 'write', sessionId, data: decode(bytes) })
    },
    onEvent: (ev) => handleEvent(sessionId, ev),
  }
  const term = await KittyTerminal.create(opts)
  const session: Session = {
    term,
    cols,
    rows,
    cols_words: cols * KITTY_CELL_WORDS,
    seq: 0,
    lastScrolledBy: 0,
    forceFull: true,
    title: '',
    cwd: '',
    selectionAnchor: null,
    selectionCursor: null,
    rectangle: false,
    searchIndex: -1,
    searchHits: [],
    cwdTail: '',
    lastActivity: Date.now(),
  }
  sessions.set(sessionId, session)
  scheduleFlush(sessionId)
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes)
}

function handleEvent(sessionId: string, ev: KittyEvent): void {
  const s = sessions.get(sessionId)
  if (!s) return
  switch (ev.type) {
    case 'title':
      s.title = ev.title
      post({ t: 'event', sessionId, event: { type: 'title', title: ev.title } })
      return
    case 'bell':
      post({ t: 'event', sessionId, event: { type: 'bell' } })
      return
    case 'clipboard':
      post({ t: 'event', sessionId, event: { type: 'clipboard', data: ev.data, query: ev.query } })
      return
    case 'notification':
      post({ t: 'event', sessionId, event: { type: 'notify', message: ev.data } })
      return
    case 'progress':
      post({ t: 'event', sessionId, event: { type: 'progress', state: ev.state, percent: ev.percent } })
      return
    case 'reset':
      post({ t: 'event', sessionId, event: { type: 'reset' } })
      scheduleFlush(sessionId, true)
      return
    case 'graphics_command':
      post({ t: 'event', sessionId, event: { type: 'graphics', command: mapGraphics(ev) } })
      return
    default:
      return
  }
}

function mapGraphics(ev: Extract<KittyEvent, { type: 'graphics_command' }>): KittyGraphicsCommand {
  return {
    action: ev.action,
    deleteAction: ev.delete_action,
    transmission: ev.transmission,
    id: ev.id,
    imageNumber: ev.image_number,
    placementId: ev.placement_id,
    format: ev.format,
    more: ev.more,
    width: ev.width,
    height: ev.height,
    xOffset: ev.x_offset,
    yOffset: ev.y_offset,
    dataWidth: ev.data_width,
    dataHeight: ev.data_height,
    zIndex: ev.z_index,
    compressed: ev.compressed,
    unicodePlacement: ev.unicode_placement,
    payload: ev.payload,
  }
}

/* ─────────────────────────────── 帧调度 ─────────────────────────────── */

function scheduleFlush(sessionId: string, full = false): void {
  const s = sessions.get(sessionId)
  if (s && full) s.forceFull = true
  pendingFlush.add(sessionId)
  if (flushScheduled) return
  flushScheduled = true
  // 微任务不够：多个 chunk 可能在同一个任务里到达，用节流把一帧压到 ~8ms
  setTimeout(() => {
    flushScheduled = false
    const ids = [...pendingFlush]
    pendingFlush.clear()
    for (const id of ids) {
      try {
        flush(id)
      } catch (err) {
        post({ t: 'event', sessionId: id, event: { type: 'notify', message: `渲染帧失败：${String(err)}` } })
      }
    }
  }, 8)
}

function flush(sessionId: string): void {
  const s = sessions.get(sessionId)
  if (!s) return
  const term = s.term
  const rows = term.rows
  const cols = term.columns
  const colsWords = cols * KITTY_CELL_WORDS
  if (colsWords !== s.cols_words || rows !== s.rows) {
    s.cols = cols
    s.rows = rows
    s.cols_words = colsWords
    s.forceFull = true
  }
  const scrolledBy = term.scrolledBy
  const full = s.forceFull || scrolledBy !== s.lastScrolledBy
  s.forceFull = false
  s.lastScrolledBy = scrolledBy

  const rowsOut: KittyRow[] = []
  const transfer: Transferable[] = []
  for (let y = 0; y < rows; y += 1) {
    if (!full && !term.lineDirty(y)) continue
    const words = term.viewportLineCells(y)
    if (!words || words.length === 0) continue
    const copy = words.slice(0, colsWords)
    rowsOut.push({ y, words: copy.buffer as ArrayBuffer })
    transfer.push(copy.buffer as ArrayBuffer)
  }
  term.clearDirty()

  const meta = buildMeta(s, term, scrolledBy)
  s.seq += 1
  meta.seq = s.seq
  post({ t: 'frame', sessionId, meta, rows: rowsOut, full }, transfer)
}

/** Color 是 `{index}|{rgb}|null` 的联合；只有 truecolor 才算"程序改过颜色" */
function rgbOf(color: { index: number } | { rgb: number } | null | undefined): number | null {
  if (!color) return null
  return 'rgb' in color ? color.rgb : null
}

function buildMeta(s: Session, term: KittyTerminal, scrolledBy: number): KittyMeta {
  const cur = term.cursor
  const shape = CURSOR_SHAPES[cur.shape] ?? 'block'
  const palette: number[] = new Array(256)
  for (let i = 0; i < 256; i += 1) palette[i] = term.paletteColor(i)
  return {
    seq: s.seq,
    cols: term.columns,
    rows: term.rows,
    cursor: { x: cur.x, y: cur.y, shape: cur.visible ? shape : 'none', visible: cur.visible, blink: cur.blink },
    modes: {
      bracketedPaste: term.mode(2004) === 1,
      applicationCursorKeys: term.mode(1) === 1,
      altScreen: !term.isMainScreen,
      mouseTracking: term.mode(1000) === 1 || term.mode(1002) === 1 || term.mode(1003) === 1,
      focusTracking: term.mode(1004) === 1,
    },
    scrolledBy,
    scrollbackLength: term.scrollbackLength,
    title: s.title,
    defaultFg: rgbOf(term.defaultFg),
    defaultBg: rgbOf(term.defaultBg),
    cursorColor: rgbOf(term.cursorColor),
    palette,
    selection: computeSelectionSpans(s, term, scrolledBy),
  }
}

/**
 * 选区的可视色块。
 *
 * 内核负责「选了什么字」（`selectionText()` 才是权威），这里只负责「画在哪」。
 * 线性选择跨行时每行都是从行首到行尾（首行从起点开始、末行到终点结束）；
 * 矩形选择每行都是同一列区间。
 */
function computeSelectionSpans(
  s: Session,
  term: KittyTerminal,
  scrolledBy: number,
): KittySelectionSpan[] | null {
  const a = s.selectionAnchor
  const b = s.selectionCursor
  if (!a || !b) return null
  const spans: KittySelectionSpan[] = []
  const y1 = Math.min(a.y, b.y)
  const y2 = Math.max(a.y, b.y)
  const cols = term.columns
  for (let y = y1; y <= y2; y += 1) {
    if (y < 0 || y >= term.rows) continue
    if (s.rectangle) {
      const x1 = Math.min(a.x, b.x)
      const x2 = Math.max(a.x, b.x)
      spans.push({ y, x1, x2 })
      continue
    }
    if (y1 === y2) {
      spans.push({ y, x1: Math.min(a.x, b.x), x2: Math.max(a.x, b.x) })
      continue
    }
    const fromStart = a.y <= b.y
    if (y === y1) {
      spans.push({ y, x1: fromStart ? a.x : 0, x2: cols - 1 })
    } else if (y === y2) {
      spans.push({ y, x1: 0, x2: fromStart ? b.x : a.x })
    } else {
      spans.push({ y, x1: 0, x2: cols - 1 })
    }
  }
  // scrolledBy 只影响 y 的映射：kitty 的选区坐标就是视口坐标，直接可用
  void scrolledBy
  return spans.length > 0 ? spans : null
}

/* ────────────────────────────── OSC 7 嗅探 ────────────────────────────── */

const OSC7_PREFIX = '\x1b]7;'
const OSC7_RE = /\x1b]7;(?:file:\/\/[^/]*)?([^\x07\x1b]*)(?:\x07|\x1b\\)/

function sniffCwd(sessionId: string, text: string): void {
  const s = sessions.get(sessionId)
  if (!s || !text.includes(OSC7_PREFIX)) return
  // 跨 chunk：把上一次的尾巴拼上，避免路径被切断
  const hay = s.cwdTail + text
  s.cwdTail = hay.slice(-64)
  const m = OSC7_RE.exec(hay)
  if (!m || !m[1]) return
  const path = decodeURIComponent(m[1])
  if (path && path !== s.cwd) {
    s.cwd = path
    post({ t: 'event', sessionId, event: { type: 'cwd', path } })
  }
}

/* ─────────────────────────────── 请求处理 ─────────────────────────────── */

function modsOf(mask: number): { shift: boolean; alt: boolean; ctrl: boolean; super: boolean } {
  return { shift: (mask & 1) !== 0, alt: (mask & 2) !== 0, ctrl: (mask & 4) !== 0, super: (mask & 8) !== 0 }
}

function searchOver(s: Session, term: KittyTerminal, pattern: string): void {
  s.searchHits = []
  s.searchIndex = -1
  if (!pattern) return
  const needle = pattern.toLowerCase()
  const history = term.scrollbackLength
  const rows = term.rows
  const scan = (text: string, abs: number): void => {
    if (!text) return
    const lower = text.toLowerCase()
    let from = 0
    for (;;) {
      const at = lower.indexOf(needle, from)
      if (at < 0) break
      s.searchHits.push({ abs, x1: at, x2: at + needle.length - 1 })
      from = at + Math.max(1, needle.length)
      if (s.searchHits.length > 5000) break
    }
  }
  for (let i = 0; i < history; i += 1) scan(term.scrollbackLine(i) ?? '', i)
  for (let y = 0; y < rows; y += 1) scan(term.line(y), history + y)
}

function jumpToHit(s: Session, term: KittyTerminal, abs: number): void {
  const history = term.scrollbackLength
  const rows = term.rows
  const current = term.scrolledBy
  // 命中行的视口 y = abs - (history - scrolledBy)；想让它落在视口中部
  const wantY = Math.max(0, Math.min(rows - 1, Math.floor(rows / 3)))
  const targetScrolledBy = Math.max(0, Math.min(history, history - abs + wantY))
  const delta = targetScrolledBy - current
  if (delta !== 0) term.scrollViewport(delta)
}

function searchResult(s: Session, term: KittyTerminal, index: number): KittySearchResult {
  const scrolledBy = term.scrolledBy
  const history = term.scrollbackLength
  const hits: KittySearchHit[] = s.searchHits.map((h) => ({
    y: h.abs - (history - scrolledBy),
    x1: h.x1,
    x2: h.x2,
  }))
  return { hits, index, total: hits.length, scrolledBy }
}

async function handle(req: KittyRequest): Promise<void> {
  switch (req.t) {
    case 'init': {
      wasmBuffer = req.wasm
      wasmModule = await WebAssembly.compile(req.wasm)
      post({ t: 'reply', id: req.id, ok: true, value: { bytes: req.wasm.byteLength } })
      post({ t: 'ready' })
      return
    }
    case 'create': {
      await createSession(req.sessionId, req.cols, req.rows, req.scrollback)
      post({ t: 'reply', id: req.id, ok: true, value: { sessionId: req.sessionId } })
      return
    }
    case 'dispose': {
      const s = sessions.get(req.sessionId)
      s?.term.dispose()
      sessions.delete(req.sessionId)
      post({ t: 'reply', id: req.id, ok: true, value: null })
      return
    }
    case 'data': {
      const s = sessions.get(req.sessionId)
      if (!s) {
        post({ t: 'reply', id: req.id, ok: true, value: null })
        return
      }
      const bytes = new Uint8Array(req.chunk)
      s.term.write(bytes)
      s.lastActivity = Date.now()
      if (bytes.length > 0) {
        // OSC 7 只需要在文本里找；做一次廉价预筛，避免每个 chunk 都解码
        if (bytes.includes(0x1b)) {
          sniffCwd(req.sessionId, new TextDecoder().decode(bytes))
        }
      }
      scheduleFlush(req.sessionId, s.searchHits.length > 0)
      post({ t: 'reply', id: req.id, ok: true, value: { bytes: bytes.length } })
      return
    }
    case 'resize': {
      const s = sessions.get(req.sessionId)
      if (!s) throw new Error('会话不存在')
      s.term.resize(req.cols, req.rows)
      s.forceFull = true
      scheduleFlush(req.sessionId, true)
      post({ t: 'reply', id: req.id, ok: true, value: { cols: req.cols, rows: req.rows } })
      return
    }
    case 'key': {
      const s = sessions.get(req.sessionId)
      if (!s) throw new Error('会话不存在')
      const key = FUNCTION_KEYS[req.key] ?? req.key
      const encoded = s.term.encodeKey(key as never, modsOf(req.mods), req.action)
      if (encoded) post({ t: 'write', sessionId: req.sessionId, data: encoded })
      post({ t: 'reply', id: req.id, ok: true, value: encoded })
      return
    }
    case 'paste': {
      const s = sessions.get(req.sessionId)
      if (!s) throw new Error('会话不存在')
      const encoded = s.term.paste(req.text)
      if (encoded) post({ t: 'write', sessionId: req.sessionId, data: encoded })
      post({ t: 'reply', id: req.id, ok: true, value: encoded })
      return
    }
    case 'mouse': {
      const s = sessions.get(req.sessionId)
      if (!s) throw new Error('会话不存在')
      const encoded = s.term.encodeMouse({
        x: req.x,
        y: req.y,
        button: req.button,
        action: req.action,
        mods: modsOf(req.mods),
      })
      if (encoded) post({ t: 'write', sessionId: req.sessionId, data: encoded })
      post({ t: 'reply', id: req.id, ok: true, value: encoded })
      return
    }
    case 'focus': {
      const s = sessions.get(req.sessionId)
      if (!s) throw new Error('会话不存在')
      const encoded = s.term.encodeFocus(req.focused)
      if (encoded) post({ t: 'write', sessionId: req.sessionId, data: encoded })
      post({ t: 'reply', id: req.id, ok: true, value: encoded })
      return
    }
    case 'scroll': {
      const s = sessions.get(req.sessionId)
      if (!s) throw new Error('会话不存在')
      const moved = s.term.scrollViewport(req.action)
      if (moved) scheduleFlush(req.sessionId, true)
      post({ t: 'reply', id: req.id, ok: true, value: moved })
      return
    }
    case 'selection': {
      const s = sessions.get(req.sessionId)
      if (!s) throw new Error('会话不存在')
      if (req.kind === 'clear') {
        s.selectionAnchor = null
        s.selectionCursor = null
        s.term.selectionClear()
        scheduleFlush(req.sessionId, true)
        post({ t: 'reply', id: req.id, ok: true, value: null })
        return
      }
      if (req.kind === 'start') {
        s.selectionAnchor = { x: req.x, y: req.y }
        s.selectionCursor = { x: req.x, y: req.y }
        s.rectangle = req.rectangle ?? false
        s.term.selectionStart(req.x, req.y, { rectangle: req.rectangle })
      } else {
        s.selectionCursor = { x: req.x, y: req.y }
        s.term.selectionUpdate(req.x, req.y, { ended: req.ended })
      }
      scheduleFlush(req.sessionId, true)
      const text = s.term.selectionText({ stripTrailingWhitespace: true })
      post({ t: 'reply', id: req.id, ok: true, value: { text } })
      return
    }
    case 'search': {
      const s = sessions.get(req.sessionId)
      if (!s) throw new Error('会话不存在')
      if (req.step === 'first') {
        searchOver(s, s.term, req.pattern)
        const first = s.searchHits[0]
        if (first) {
          s.searchIndex = 0
          jumpToHit(s, s.term, first.abs)
        }
      } else if (s.searchHits.length > 0) {
        const n = s.searchHits.length
        s.searchIndex = (s.searchIndex + (req.step === 'next' ? 1 : -1) + n) % n
        const hit = s.searchHits[s.searchIndex]
        if (hit) jumpToHit(s, s.term, hit.abs)
      }
      scheduleFlush(req.sessionId, true)
      post({ t: 'reply', id: req.id, ok: true, value: searchResult(s, s.term, s.searchIndex) })
      return
    }
    case 'selectAll': {
      const s = sessions.get(req.sessionId)
      if (!s) throw new Error('会话不存在')
      s.term.selectionStart(0, 0)
      s.term.selectionUpdate(s.term.columns - 1, s.term.rows - 1, { ended: true })
      s.selectionAnchor = { x: 0, y: 0 }
      s.selectionCursor = { x: s.term.columns - 1, y: s.term.rows - 1 }
      scheduleFlush(req.sessionId, true)
      post({ t: 'reply', id: req.id, ok: true, value: { text: s.term.selectionText() } })
      return
    }
    case 'serialize': {
      const s = sessions.get(req.sessionId)
      if (!s) throw new Error('会话不存在')
      const bytes = s.term.serialize()
      post({ t: 'reply', id: req.id, ok: true, value: { text: new TextDecoder().decode(bytes) } })
      return
    }
    case 'refresh': {
      scheduleFlush(req.sessionId, true)
      post({ t: 'reply', id: req.id, ok: true, value: null })
      return
    }
    case 'stats': {
      const s = sessions.get(req.sessionId)
      if (!s) throw new Error('会话不存在')
      post({
        t: 'reply',
        id: req.id,
        ok: true,
        value: {
          cols: s.term.columns,
          rows: s.term.rows,
          scrollback: s.term.scrollbackLength,
          title: s.title,
          cwd: s.cwd,
          memoryBytes: 0,
        },
      })
      return
    }
    default:
      throw new Error('未知请求')
  }
}

self.onmessage = (ev: MessageEvent<KittyRequest>): void => {
  const req = ev.data
  void handle(req).catch((err: unknown) => {
    if (typeof req.id === 'number') fail(req.id, err)
    else post({ t: 'fatal', error: String(err) })
  })
}
