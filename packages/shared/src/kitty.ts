// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * kitty 终端内核的线程间协议（Renderer 主线程 ↔ Worker）。
 *
 * ## 为什么是 Worker 而不是 UtilityProcess
 *
 * 计划里第一层写的是「UtilityProcess 持有 SSH 与 Kitty 内核」。落地时 SSH 传输
 * 仍留在主进程：它身上挂着 SFTP / 端口转发 / 性能监控 / 跳板机 / 代理 / 主机密钥
 * 校验，把这些整体搬进 UtilityProcess 等于把最容易出事的一层重写一遍，而收益
 * （每帧少一次 structured clone）远小于风险。
 *
 * 内核这一层则**确实**移出了 UI 线程：kitty-vt-wasm 在 Web Worker 里跑。
 * 与 UtilityProcess 相比它有两点更好：
 * - 渲染层直接持有 `MessagePort` 等价的 worker 通道，不需要穿过 contextBridge
 *   （MessagePort 穿沙箱桥会被结构化克隆，`Uint32Array` 的零拷贝转移就没了）；
 * - Worker 与渲染层同进程但不同线程，崩溃只影响该会话，主线程不卡。
 *
 * byte 流的路径：SSH/PTY → 主进程 → 渲染层 → Worker(解析) → cells → WebGL2。
 * 输入反方向：键盘 → Worker(用 kitty 原版 key_encoding.c 编码) → 主进程 → SSH。
 *
 * ## cells ABI
 *
 * 每个单元格 **8 个 little-endian u32**（与 kitty 的 `cell` 结构一一对应，
 * 直接来自内核的 `lineCells()`，不在这里重排）：
 *
 * | word | 含义 |
 * | ---- | ---- |
 * | 0 | 字形码点（0 = 不绘制） |
 * | 1 | 组合字符 1 |
 * | 2 | 组合字符 2 |
 * | 3 | 前景色（打包） |
 * | 4 | 背景色（打包） |
 * | 5 | 下划线/删除线颜色 |
 * | 6 | 标志位：bold/dim/italic/reverse/strike/blink/wide/wideTrail + 下划线样式 |
 * | 7 | OSC 8 超链接 id |
 *
 * 打包颜色的规则由内核定义（palette 索引 / truecolor / 默认），渲染层只做解码。
 */

/** 每个单元格的 u32 数量（= kitty 内核的 CELL_U32） */
export const KITTY_CELL_WORDS = 8

/** 光标形状（与 kitty 的 CursorShape 对齐） */
export type KittyCursorShape = 'block' | 'beam' | 'underline' | 'hollow' | 'none'

export interface KittyCursorState {
  x: number
  y: number
  shape: KittyCursorShape
  visible: boolean
  blink: boolean
}

/** 终端模式位（渲染层做输入决策时需要的子集） */
export interface KittyModes {
  bracketedPaste: boolean
  applicationCursorKeys: boolean
  altScreen: boolean
  mouseTracking: boolean
  focusTracking: boolean
}

/** 一帧里随行数据一起下发的状态。`seq` 单调递增，渲染层据此丢弃过期帧。 */
export interface KittyMeta {
  seq: number
  cols: number
  rows: number
  cursor: KittyCursorState
  modes: KittyModes
  /** 视口向上回看的行数（0 = 贴底） */
  scrolledBy: number
  /** 回看缓冲总行数 */
  scrollbackLength: number
  title: string
  /**
   * 默认前景 / 背景 / 光标色，0xRRGGBB。
   * **null 表示程序没有用 OSC 10/11/12 改过**，渲染层应回落到配色方案。
   */
  defaultFg: number | null
  defaultBg: number | null
  cursorColor: number | null
  /** 256 色调色板（0xRRGGBB） */
  palette: number[]
  /** 当前选区的可视行范围（相对视口），null = 没有选区 */
  selection: KittySelectionSpan[] | null
}

/** 选区在视口坐标下的一段（同一行） */
export interface KittySelectionSpan {
  y: number
  x1: number
  x2: number
}

/** 一行单元格（`words` 是 transferable 的 ArrayBuffer） */
export interface KittyRow {
  y: number
  words: ArrayBuffer
}

/** kitty 图形协议的一条命令（已解码的元数据 + base64 载荷） */
export interface KittyGraphicsCommand {
  action: string
  deleteAction: string
  transmission: string
  id: number
  imageNumber: number
  placementId: number
  format: number
  more: number
  width: number
  height: number
  xOffset: number
  yOffset: number
  dataWidth: number
  dataHeight: number
  zIndex: number
  compressed: number
  unicodePlacement: boolean
  payload: string
}

/** 内核上报的宿主事件（渲染层/主进程消费） */
export type KittyHostEvent =
  | { type: 'title'; title: string }
  | { type: 'bell' }
  | { type: 'clipboard'; data: string; query: boolean }
  | { type: 'notify'; message: string }
  | { type: 'cwd'; path: string }
  | { type: 'progress'; state: number; percent: number }
  | { type: 'graphics'; command: KittyGraphicsCommand }
  | { type: 'reset' }

/** 主线程 → Worker */
export type KittyRequest =
  | { id: number; t: 'init'; wasm: ArrayBuffer }
  | { id: number; t: 'create'; sessionId: string; cols: number; rows: number; scrollback: number }
  | { id: number; t: 'dispose'; sessionId: string }
  | { id: number; t: 'data'; sessionId: string; chunk: ArrayBuffer }
  | { id: number; t: 'resize'; sessionId: string; cols: number; rows: number }
  | {
      id: number
      t: 'key'
      sessionId: string
      /** 功能键名（Key 枚举）或单字符 */
      key: string
      /** 位掩码：1 shift, 2 alt, 4 ctrl, 8 super */
      mods: number
      action: 'press' | 'repeat' | 'release'
    }
  | { id: number; t: 'paste'; sessionId: string; text: string }
  | {
      id: number
      t: 'mouse'
      sessionId: string
      x: number
      y: number
      button: 'left' | 'middle' | 'right' | 'none' | 'wheel-up' | 'wheel-down'
      action: 'press' | 'release' | 'move'
      mods: number
    }
  | { id: number; t: 'focus'; sessionId: string; focused: boolean }
  | { id: number; t: 'scroll'; sessionId: string; action: number | 'top' | 'bottom' | 'page-up' | 'page-down' }
  | {
      id: number
      t: 'selection'
      sessionId: string
      /**
       * start/update：鼠标按下与拖拽；clear：清空；
       * word/line：双击选词、三击选行（kitty 的 doublepress / triplepress）。
       */
      kind: 'start' | 'update' | 'clear' | 'word' | 'line'
      x: number
      y: number
      rectangle?: boolean
      ended?: boolean
      /** kitty 的 in_left_half_of_cell：指针在格子左半还是右半 */
      half?: boolean
      /**
       * kitty 的 SelectionExtendMode：双击/三击之后继续拖动，扩展粒度不是
       * 「格」而是「词」/「行」（screen.c 的 EXTEND_WORD / EXTEND_LINE）。
       */
      extend?: 'word' | 'line'
    }
  | { id: number; t: 'search'; sessionId: string; pattern: string; step: 'first' | 'next' | 'prev' }
  | { id: number; t: 'selectAll'; sessionId: string }
  | { id: number; t: 'serialize'; sessionId: string }
  | { id: number; t: 'refresh'; sessionId: string }
  | { id: number; t: 'stats'; sessionId: string }

/** Worker → 主线程 */
export type KittyResponse =
  | { t: 'ready' }
  | { t: 'reply'; id: number; ok: true; value: unknown }
  | { t: 'reply'; id: number; ok: false; error: string }
  | { t: 'frame'; sessionId: string; meta: KittyMeta; rows: KittyRow[]; full: boolean }
  | { t: 'state'; sessionId: string; meta: KittyMeta }
  | { t: 'write'; sessionId: string; data: string }
  | { t: 'event'; sessionId: string; event: KittyHostEvent }
  | { t: 'fatal'; error: string }

/** 搜索结果里的一条命中（视口坐标；y 可能落在视口外，靠 offset 表示） */
export interface KittySearchHit {
  /** 相对当前视口的行号（负值 = 在上方回看里） */
  y: number
  x1: number
  x2: number
}

/** 主线程请求的检索结果 */
export interface KittySearchResult {
  hits: KittySearchHit[]
  index: number
  total: number
  scrolledBy: number
}
