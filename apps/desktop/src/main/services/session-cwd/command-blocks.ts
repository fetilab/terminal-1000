// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * OSC 133（Shell Integration）命令块：命令边界 + 退出码。
 *
 * ## 序列含义（FinalTerm 约定，各家 shell 都遵循）
 * - `OSC 133 ; A`           提示符开始
 * - `OSC 133 ; B`           命令开始（提示符结束、用户输入开始）
 * - `OSC 133 ; C`           命令**输出**开始（也就是命令真正开始执行）
 * - `OSC 133 ; D [; exit]`  命令结束，**带退出码**（有些 shell 不带 → 我们记 null）
 * - `OSC 133 ; P ; k=v`     提示符属性（与我们无关，识别但忽略）
 *
 * 有了 A/B/C/D 才能做：命令块（按块复制/折叠/跳转）、"上一条命令成功了吗"、
 * 失败命令高亮、以及 AI 判断"刚才那步到底成没成"。
 *
 * ## 边界（必须如实告知调用方）
 * **不是所有 shell 都会发 OSC 133**：zsh/fish 的常见配置自带；
 * bash 需要在 `PROMPT_COMMAND` 里输出。拿不到时 `listCommandBlocks()` 返回空
 * **并附可操作的原因**（照 `ssh.getCwd` 返回 `{cwd:null, reason}` 的做法），
 * 绝不让调用方以为"没有输出就是没有块"。
 *
 * ## 为什么单独一个文件
 * 跨块扫描（"半截引导符"、"缓冲拼接"）只在 `index.ts` 里实现**一份**；
 * 本文件只负责「一段完整的 OSC 载荷 → 状态机推进」，两个解析器（OSC 7 / OSC 133）
 * 共用同一个扫描器，避免两套边界处理各自漂移。
 */

import { Events, type EventPayloads } from '@t1000/shared'

/** 一个命令块 */
export interface CommandBlock {
  /** 会话内自增 id（从 1 开始） */
  id: number
  /** 命令文本（B→C 之间终端回显的内容，清理过控制字符）；拿不到就不给 */
  commandLine?: string
  /** 命令提交时刻（B） */
  submittedAt?: number
  /** 命令开始执行的时刻（C）；shell 没发 C 时用 D 的时刻兜底 */
  startedAt: number
  /** 输出开始时刻（C） */
  outputStart?: number
  /**
   * 退出码：
   * - 数字：shell 明确告知
   * - `null`：命令结束了，但 shell **没给**退出码（D 不带参数）
   * - 缺省：还没结束
   */
  exitCode?: number | null
  /** 结束时刻（D） */
  endedAt?: number
}

/** 每个会话最多保留多少个命令块（长会话不能吃内存） */
export const MAX_COMMAND_BLOCKS = 500
/** `listCommandBlocks` 的默认条数 */
export const DEFAULT_BLOCK_LIMIT = 50
/** 单次请求的条数上限 */
export const MAX_BLOCK_LIMIT = 500

/** OSC 133 的类型 */
export type Osc133Kind = 'A' | 'B' | 'C' | 'D' | 'P'

export interface Osc133Parsed {
  kind: Osc133Kind
  /** 仅 D 可能有：退出码（缺失为 undefined） */
  exitCode?: number | null
}

const KINDS = new Set<string>(['A', 'B', 'C', 'D', 'P'])

/**
 * 解析 OSC 133 载荷（`133;A`、`133;D;1`、`133;A;cl=m` …）。
 *
 * 不是 OSC 133 时返回 null（调用方会继续试其它 OSC 解析器）。
 * 未知类型（例如某些 shell 的扩展）也返回 null —— 宁可忽略，不要瞎猜语义。
 */
export function parseOsc133(payload: string): Osc133Parsed | null {
  const parts = payload.split(';')
  if (parts[0] !== '133') return null
  const kind = parts[1]
  if (kind === undefined || !KINDS.has(kind)) return null

  if (kind === 'D') {
    const raw = parts[2]
    if (raw === undefined || raw === '') return { kind: 'D', exitCode: null }
    const code = Number.parseInt(raw, 10)
    // 非法退出码按"没给"处理（null），不要编一个 0 出来
    return { kind: 'D', exitCode: Number.isFinite(code) ? code : null }
  }
  return { kind: kind as Osc133Kind }
}

/** 会话内的块状态 */
interface BlockState {
  blocks: CommandBlock[]
  nextId: number
  /** 累计创建过的块数（含被淘汰的），用于告诉 UI"还有更多" */
  total: number
  /** 进行中的块（B/C 之后、D 之前） */
  open: {
    id: number
    submittedAt?: number
    started: boolean
    startedAt?: number
    outputStart?: number
    /** B→C 之间的回显文本（用于还原 commandLine） */
    input: string
  } | null
  /** 见过任何 OSC 133 序列（用于区分"shell 没配"与"还没跑过命令"） */
  sawOsc133: boolean
  /** 这个会话有过任何输出（用于区分"会话刚开"） */
  sawData: boolean
  lastActivityAt: number
}

const states = new Map<string, BlockState>()

function stateFor(sessionId: string): BlockState {
  let s = states.get(sessionId)
  if (!s) {
    s = {
      blocks: [],
      nextId: 1,
      total: 0,
      open: null,
      sawOsc133: false,
      sawData: false,
      lastActivityAt: 0,
    }
    states.set(sessionId, s)
  }
  return s
}

/**
 * 按终端语义处理退格：DEL/BS 删掉前一个字符（在空缓冲上什么也不做）。
 *
 * 不能用正则一把替换：`ls\x7f\x7f` 这类连续退格必须**逐个**回退
 * （正则的贪婪匹配会把整段连同退格一起吃掉，只退一格）。
 */
function applyBackspaces(text: string): string {
  let out = ''
  for (const ch of text) {
    if (ch === '\x7f' || ch === '\b') out = out.slice(0, -1)
    else out += ch
  }
  return out
}

/** 清理命令回显里的控制序列，只留人能读的命令文本 */
export function cleanCommandLine(raw: string): string {
  return (
    applyBackspaces(raw)
      // OSC 序列（含未闭合的尾巴）
      .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g, '')
      // CSI 序列（颜色、光标移动…）
      .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
      // 其它 ESC 序列
      .replace(/\x1b[@-Z\\-_]/g, '')
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')
      .replace(/\r/g, '')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .pop() ?? ''
  ).trim()
}

/**
 * 把一段完整 OSC 133 序列喂给状态机（由 `index.ts` 的扫描器调用）。
 *
 * @param emit 事件出口（未注入时只维护状态，不影响读取）
 */
export function applyOsc133(
  sessionId: string,
  parsed: Osc133Parsed,
  emit?: ShellEventEmitter,
  now: number = Date.now(),
): void {
  const s = stateFor(sessionId)
  s.sawOsc133 = true
  s.lastActivityAt = now

  const open = s.open
  switch (parsed.kind) {
    case 'A': {
      // 新提示符：如果上一条命令还"开着"（shell 没发 D），按未知退出码收尾，
      // 否则这个 open 会一直挂着，后面的块全部错位。
      if (open !== null && open.started) finalize(sessionId, s, open, null, emit, now)
      s.open = null
      return
    }
    case 'B': {
      if (s.open === null) {
        s.open = { id: s.nextId++, started: false, input: '' }
      }
      s.open.submittedAt = now
      s.open.input = ''
      return
    }
    case 'C': {
      const target = s.open ?? { id: s.nextId++, started: false, input: '' }
      s.open = target
      target.outputStart = now
      if (!target.started) {
        target.started = true
        target.startedAt = now
        emit?.({
          type: 'start',
          sessionId,
          blockId: target.id,
          ...(cleanCommandLine(target.input) === ''
            ? {}
            : { commandLine: cleanCommandLine(target.input) }),
          startedAt: now,
        })
      }
      return
    }
    case 'D': {
      // 有些 shell（或用户的 printf）只发 D：也要能拿到退出码，所以这里补建块
      const target = s.open ?? { id: s.nextId++, started: false, input: '' }
      s.open = null
      if (!target.started) {
        target.started = true
        target.startedAt = now
        // 保证 START 一定先于 END 出现（消费方可以只监听 END）
        emit?.({
          type: 'start',
          sessionId,
          blockId: target.id,
          ...(cleanCommandLine(target.input) === ''
            ? {}
            : { commandLine: cleanCommandLine(target.input) }),
          startedAt: now,
        })
      }
      finalize(sessionId, s, target, parsed.exitCode ?? null, emit, now)
      return
    }
    case 'P':
      // 提示符属性：与我们无关（但要算作"见过 OSC 133"）
      return
  }
}

/** 收尾一个块：入列、淘汰、发事件 */
function finalize(
  sessionId: string,
  s: BlockState,
  open: NonNullable<BlockState['open']>,
  exitCode: number | null,
  emit: ShellEventEmitter | undefined,
  now: number,
): void {
  const commandLine = cleanCommandLine(open.input)
  const block: CommandBlock = {
    id: open.id,
    startedAt: open.startedAt ?? now,
    ...(open.submittedAt === undefined ? {} : { submittedAt: open.submittedAt }),
    ...(open.outputStart === undefined ? {} : { outputStart: open.outputStart }),
    ...(commandLine === '' ? {} : { commandLine }),
    exitCode,
    endedAt: now,
  }
  s.blocks.push(block)
  s.total += 1
  // 上限：只留最近 MAX_COMMAND_BLOCKS 个（列表头部的老块直接丢）
  if (s.blocks.length > MAX_COMMAND_BLOCKS) {
    s.blocks.splice(0, s.blocks.length - MAX_COMMAND_BLOCKS)
  }

  emit?.({
    type: 'end',
    sessionId,
    blockId: block.id,
    exitCode,
    ...(block.commandLine === undefined ? {} : { commandLine: block.commandLine }),
    startedAt: block.startedAt,
    endedAt: now,
    durationMs: Math.max(0, now - block.startedAt),
  })
}

/** 记录一段"纯输出"文本（B→C 之间用来还原命令回显） */
export function feedPlainText(sessionId: string, text: string, now: number = Date.now()): void {
  const s = stateFor(sessionId)
  s.sawData = true
  s.lastActivityAt = now
  // 只在"已提交、还没开始输出"的窗口里收集回显
  if (s.open !== null && s.open.started === false && s.open.submittedAt !== undefined) {
    const room = 4096 - s.open.input.length
    if (room > 0) s.open.input += text.slice(0, room)
  }
}

/** 标记会话有过输出（没有任何 OSC 时也要能区分"会话刚开"） */
export function markSessionData(sessionId: string, now: number = Date.now()): void {
  const s = stateFor(sessionId)
  s.sawData = true
  s.lastActivityAt = now
}

export interface CommandBlocksResult {
  sessionId: string
  /** 最近 limit 个块（按时间正序，最后一个是最新的） */
  blocks: CommandBlock[]
  /** 本会话累计完成过多少块（含已被上限淘汰的） */
  total: number
  /** 是否因 limit 截断 */
  truncated: boolean
  /** 本会话是否见过 OSC 133（shell 是否装了 Shell Integration） */
  shellIntegration: boolean
  /** 拿不到块时的**可操作**原因（有块时为 undefined） */
  reason?: string
}

/** "shell 没发 OSC 133"时的可操作说明 */
export function shellIntegrationReason(state: BlockState | undefined): string {
  if (state === undefined || !state.sawData) {
    return '这个会话还没有输出，暂时读不到命令块；先执行一条命令再试'
  }
  if (!state.sawOsc133) {
    return (
      '该会话的 shell 没有发送 OSC 133（Shell Integration 未启用），因此读不到命令块与退出码。' +
      'zsh / fish 的常见配置自带；bash 需要在 PROMPT_COMMAND 里输出 OSC 133 序列。' +
      '可手动验证：printf "\\033]133;D;0\\007"'
    )
  }
  return 'Shell Integration 已启用，但本会话还没有跑完任何命令'
}

/**
 * 读取某会话的命令块（最近 limit 个）。
 *
 * 拿不到时 `blocks` 为空**且带 `reason`**（可操作），调用方不要把它当成"没有输出"。
 */
export function listCommandBlocks(
  sessionId: string,
  limit: number = DEFAULT_BLOCK_LIMIT,
): CommandBlocksResult {
  const state = states.get(sessionId)
  const capped = Math.min(MAX_BLOCK_LIMIT, Math.max(1, Math.trunc(limit) || DEFAULT_BLOCK_LIMIT))

  if (state === undefined) {
    return {
      sessionId,
      blocks: [],
      total: 0,
      truncated: false,
      shellIntegration: false,
      reason: shellIntegrationReason(undefined),
    }
  }

  const all = state.blocks
  const start = Math.max(0, all.length - capped)
  const blocks = all.slice(start)
  const result: CommandBlocksResult = {
    sessionId,
    blocks,
    total: state.total,
    // 两种情况都算截断：本次 limit 截了，或历史上被上限淘汰过
    truncated: start > 0 || state.total > all.length,
    shellIntegration: state.sawOsc133,
  }
  if (blocks.length === 0) result.reason = shellIntegrationReason(state)
  return result
}

/** 进行中的块（UI 可以据此显示"正在跑"） */
export function getOpenCommandBlock(sessionId: string): CommandBlock | null {
  const open = states.get(sessionId)?.open
  if (open === undefined || open === null) return null
  return {
    id: open.id,
    startedAt: open.startedAt ?? 0,
    ...(open.submittedAt === undefined ? {} : { submittedAt: open.submittedAt }),
    ...(open.outputStart === undefined ? {} : { outputStart: open.outputStart }),
    ...(cleanCommandLine(open.input) === '' ? {} : { commandLine: cleanCommandLine(open.input) }),
  }
}

/** 会话结束/被遗忘时清理（长会话与多会话都不留垃圾） */
export function forgetCommandBlocks(sessionId: string): void {
  states.delete(sessionId)
}

export function clearAllCommandBlocks(): void {
  states.clear()
}

/** 自检/测试用：当前跟踪了多少个会话 */
export function trackedSessionCount(): number {
  return states.size
}

// ── 事件出口（由 main/index.ts 注入 ctx.emit）────────────────────────────

export type ShellCommandStartEvent = {
  type: 'start'
  sessionId: string
  blockId: number
  commandLine?: string
  startedAt: number
}

export type ShellCommandEndEvent = {
  type: 'end'
  sessionId: string
  blockId: number
  /** 数字 = shell 给的退出码；null = 命令结束了但 shell 没给 */
  exitCode: number | null
  commandLine?: string
  startedAt: number
  endedAt: number
  durationMs: number
}

export interface ShellEventEmitter {
  (event: ShellCommandStartEvent | ShellCommandEndEvent): void
}

/**
 * 把本模块的事件映射到 shared 的事件通道。
 *
 * 给 main/index.ts 用一行接上：
 * `setShellIntegrationEmitter(createShellIntegrationEmitter(ctx.emit))`
 * （映射放在这里，免得调用方手抄字段、漏掉退出码。）
 */
export function createShellIntegrationEmitter(
  emit: <E extends keyof EventPayloads>(event: E, payload: EventPayloads[E]) => void,
): ShellEventEmitter {
  return (event) => {
    if (event.type === 'start') {
      emit(Events.SHELL_COMMAND_START, {
        sessionId: event.sessionId,
        blockId: event.blockId,
        ...(event.commandLine === undefined ? {} : { commandLine: event.commandLine }),
        startedAt: event.startedAt,
      })
      return
    }
    emit(Events.SHELL_COMMAND_END, {
      sessionId: event.sessionId,
      blockId: event.blockId,
      exitCode: event.exitCode,
      ...(event.commandLine === undefined ? {} : { commandLine: event.commandLine }),
      startedAt: event.startedAt,
      endedAt: event.endedAt,
      durationMs: event.durationMs,
    })
  }
}
