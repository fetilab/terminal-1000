// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * Shell Integration 跟踪：**当前工作目录（OSC 7）+ 命令块（OSC 133）**。
 *
 * 目录名仍叫 `session-cwd`（历史原因）：改名会波及 `services/ssh`、`services/pty`
 * 的 import 点，而那些文件不在本任务的写范围内；本模块现在**同时**解析两类 OSC，
 * 且只有**一份**跨块扫描器（`feedSessionData`），命令块的语义在 `command-blocks.ts`。
 *
 * 跟踪交互式会话的**当前工作目录**。
 *
 * ## 为什么放在主进程
 * 渲染层也能解析 OSC 7（`TerminalPane` 里就有一份），但那样有三个代价：
 * 1. **渲染层重载就丢**（刷新窗口/切换视图后要等下一次提示符才有值）
 * 2. **主进程的消费方拿不到**（SFTP 服务、会话恢复等都在主进程）
 * 3. 同一件事被解析两遍，两处的边界处理容易不一致
 *
 * 这里用 `subscribeAllSessionData` 一次订阅覆盖**所有会话类型**（ssh / pty / telnet）。
 *
 * ## 一个必须讲清的局限
 * **shell 的 cwd 只能从 shell 自己那里得知**。主进程没有"魔法"能问出来：
 * - 另开一条 exec 通道跑 `pwd`，拿到的是**那条通道**的目录，不是交互式 shell 的
 * - 往 shell 里注入 `pwd` 会**污染用户的终端**（会看到这行命令）
 *
 * 所以唯一干净的办法是 **OSC 7**（`\x1b]7;file://host/path\x07`）—— 但需要远端 shell 主动发。
 * zsh/fish 的常见配置自带；bash 需要用户在 `PROMPT_COMMAND` 里输出。
 * 拿不到时 `getCwd()` 返回 `null`，**调用方必须如实告诉用户原因**，而不是"点了没反应"。
 */

import { subscribeAllSessionData, subscribeSessionClosed } from '../session-registry'
import {
  applyOsc133,
  clearAllCommandBlocks,
  forgetCommandBlocks,
  markSessionData,
  feedPlainText,
  parseOsc133,
  type ShellEventEmitter,
} from './command-blocks'

export * from './command-blocks'
export * from './handlers'

/** 命令块事件的出口（由 main/index.ts 注入 ctx.emit；未注入时只维护状态） */
let shellEmitter: ShellEventEmitter | null = null

export function setShellIntegrationEmitter(next: ShellEventEmitter | null): void {
  shellEmitter = next
}

/** 每个会话一个解析状态（OSC 序列可能被 TCP 读切成两段，必须跨块缓冲） */
interface ParserState {
  /** 尚未闭合的 OSC 载荷缓冲 */
  buffer: string
  /** 是否正处于 OSC 序列中间 */
  inOsc: boolean
  cwd: string | null
}

const states = new Map<string, ParserState>()

/** OSC 引导符 ESC ] */
const OSC_INTRO = '\x1b]'
/** 字符串终止符（BEL 之外还有 ST：ESC \） */
const BEL = '\x07'
const ST = '\x1b\\'

/** 缓冲上限：防止一个畸形流把内存吃满（正常 OSC 7 只有几十字节） */
const MAX_BUFFER = 4096

/**
 * 取出字符串末尾"可能是 OSC 引导符前缀"的那一段。
 *
 * `ESC ]` 可能被切成 `ESC` + `]`，所以结尾的 `ESC`（以及 `ESC ]` 的一部分）必须留下。
 */
function trailingIntroPrefix(text: string): string {
  if (text.endsWith('\x1b')) return '\x1b'
  return ''
}

function stateFor(sessionId: string): ParserState {
  let s = states.get(sessionId)
  if (!s) {
    s = { buffer: '', inOsc: false, cwd: null }
    states.set(sessionId, s)
  }
  return s
}

/**
 * 解析 OSC 7 载荷：`file://<host>/<path>` 或 `file:///<path>`。
 *
 * @returns 解码后的绝对路径；不是合法 OSC 7 时返回 null
 */
export function parseOsc7(payload: string): string | null {
  // 形如 `7;file://host/path`
  const idx = payload.indexOf(';')
  if (idx < 0) return null
  if (payload.slice(0, idx) !== '7') return null

  let rest = payload.slice(idx + 1)
  const scheme = 'file://'
  if (!rest.startsWith(scheme)) return null
  rest = rest.slice(scheme.length)

  // rest = `<host>/<path>`（host 可能为空 → `file:///path`）
  const slash = rest.indexOf('/')
  if (slash < 0) return null
  const path = rest.slice(slash)

  // 百分号解码（路径里可能有空格/中文）
  try {
    return decodeURIComponent(path)
  } catch {
    // 非法百分号序列：原样返回比抛错好（至少还能用）
    return path
  }
}

/**
 * 喂一段会话输出，更新该会话的 cwd 状态。
 *
 * **必须按会话分别缓冲**：会话 A 的半截 OSC 不能和会话 B 的数据拼在一起。
 */
export function feedSessionData(sessionId: string, chunk: string): void {
  const s = stateFor(sessionId)
  // 收到任何字节就算"这个会话有过输出"（哪怕只是半截 OSC）：
  // 否则"shell 没发 OSC 133"会被误报成"会话还没有输出"，提示就不准了
  if (chunk.length > 0) markSessionData(sessionId)
  // 缓冲里可能是「半截 OSC 序列」也可能是「半截引导符」，两种情况都必须先拼回来。
  // （我第一版写成 `s.inOsc ? buffer + chunk : chunk`，于是 inOsc=false 时留下的
  //   半截引导符永远用不上，逐字符到达时整条序列丢失。）
  let text = s.buffer + chunk

  // 不在 OSC 中时，快速跳过没有引导符的内容。
  //
  // ⚠️ 但不能把**可能是引导符前缀的尾部**一起丢掉：`ESC ]` 这两个字符完全可能被
  // TCP 读切成两块（第一块只到 `ESC`）。我第一版就在这里直接清空缓冲，导致
  // 逐块到达的序列**永远解析不出来**，而且不报任何错 —— 看起来就像"远端 shell 没发 OSC 7"。
  // 逐字符喂入的测试正是为了钉死这一点。
  if (!s.inOsc && !text.includes(OSC_INTRO)) {
    const tail = trailingIntroPrefix(text)
    s.inOsc = false
    s.buffer = tail
    // 整块都是普通输出（或半截引导符）：也要喂给命令块状态机，
    // 否则 B→C 之间的命令回显就收集不到，commandLine 永远是空的
    const plain = tail.length > 0 ? text.slice(0, text.length - tail.length) : text
    if (plain.length > 0) feedPlainText(sessionId, plain)
    else markSessionData(sessionId)
    return
  }

  let cursor = 0
  s.inOsc = false
  s.buffer = ''

  for (;;) {
    const start = text.indexOf(OSC_INTRO, cursor)
    if (start < 0) break

    // 找终止符：BEL 或 ST，取更早的那个
    const bel = text.indexOf(BEL, start + OSC_INTRO.length)
    const st = text.indexOf(ST, start + OSC_INTRO.length)
    let end = -1
    let endLen = 1
    if (bel >= 0 && (st < 0 || bel < st)) {
      end = bel
      endLen = BEL.length
    } else if (st >= 0) {
      end = st
      endLen = ST.length
    }

    if (end < 0) {
      // 序列还没结束：把残余（含引导符）留到下一块。
      // ⚠️ 但要**先**把引导符之前的普通输出喂掉：那可能正是 B→C 之间的命令回显，
      // 丢掉它 → commandLine 永远是空的（而且只在"序列恰好被切开"时复现，极难查）。
      if (start > cursor) feedPlainText(sessionId, text.slice(cursor, start))
      const tail = text.slice(start)
      s.inOsc = true
      s.buffer = tail.length > MAX_BUFFER ? '' : tail
      return
    }

    const payload = text.slice(start + OSC_INTRO.length, end)
    // 引导符之前的都是普通输出（含命令回显）→ 先喂给块状态机
    if (start > cursor) feedPlainText(sessionId, text.slice(cursor, start))

    const cwd = parseOsc7(payload)
    if (cwd !== null) s.cwd = cwd

    // 同一份扫描器顺带解析 OSC 133（不另起一套边界处理）
    const osc133 = parseOsc133(payload)
    if (osc133 !== null) applyOsc133(sessionId, osc133, shellEmitter ?? undefined)

    cursor = end + endLen
  }

  // 处理完所有完整序列后，若末尾又出现一个未闭合的引导符，同样要留下
  const lastIntro = text.lastIndexOf(OSC_INTRO)
  if (lastIntro >= cursor) {
    // 引导符之前剩下的普通输出先喂给块状态机
    if (lastIntro > cursor) feedPlainText(sessionId, text.slice(cursor, lastIntro))
    const tail = text.slice(lastIntro)
    s.inOsc = true
    s.buffer = tail.length > MAX_BUFFER ? '' : tail
  } else {
    // ⚠️ 这里也必须留下**可能是引导符前缀的尾部**：一块里可能有
    // "完整序列 + 提示符 + 孤立的 ESC"，下一个 TCP 块带着 `]7;…` / `]133;…` 到来。
    // 早先这条路径直接把尾部当普通文本喂掉，于是紧随其后的序列永远解析不出来
    // （现象同样是"shell 好像没发 OSC"，且 OSC 7 与 OSC 133 一起受影响）。
    const rest = text.slice(cursor)
    const tail = trailingIntroPrefix(rest)
    const plain = tail.length > 0 ? rest.slice(0, rest.length - tail.length) : rest
    if (plain.length > 0) feedPlainText(sessionId, plain)
    if (tail.length > 0) {
      s.inOsc = false
      s.buffer = tail
    } else {
      markSessionData(sessionId)
    }
  }
}

/** 读取某会话最后已知的 cwd（未知返回 null） */
export function getCwd(sessionId: string): string | null {
  return states.get(sessionId)?.cwd ?? null
}

/** 主动记录一个已知 cwd（例如渲染层已经解析出来，回填以保持一致） */
export function setCwd(sessionId: string, cwd: string | null): void {
  stateFor(sessionId).cwd = cwd
}

export function forgetSession(sessionId: string): void {
  states.delete(sessionId)
  // 会话断开必须把命令块一起清掉，否则长时间开着会一直累积（每个会话一份）
  forgetCommandBlocks(sessionId)
}

export function clearAllCwd(): void {
  states.clear()
  clearAllCommandBlocks()
}

let installed = false

/**
 * 装上全局订阅（幂等）。
 *
 * 在应用启动时调用一次；此后所有会话的输出都会经过解析，
 * 因此**消费方何时来问都有值**，不受"谁先订阅"影响。
 */
export function installCwdTracking(): () => void {
  if (installed) return () => {}
  installed = true

  const offData = subscribeAllSessionData((sessionId, chunk) => {
    feedSessionData(sessionId, chunk)
  })
  const offClosed = subscribeSessionClosed((sessionId) => {
    forgetSession(sessionId)
  })

  return () => {
    offData()
    offClosed()
    installed = false
  }
}
