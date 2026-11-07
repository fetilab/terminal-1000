// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 命令补全的前端支撑：类型镜像 + 命令行跟踪 + 接受候选。
 *
 * ⚠️ 这些类型目前只定义在主进程 `services/completion/engine.ts`，
 * `packages/shared` 里没有，渲染层 import 不到，只能镜像一份同形状声明。
 * 已经在反馈里提过（和当初的 PingResult / GroupTreeNode 一样），
 * 移到 shared 之后本文件里的镜像声明应当直接删掉。
 */

export type CompletionKind =
  | 'command'
  | 'subcommand'
  | 'option'
  | 'history'
  | 'directory'
  | 'argument'
  | 'ai'

export type MatchKind = 'exact' | 'prefix' | 'fuzzy'

export interface CompletionCandidate {
  /** 接受后插入的文本 */
  value: string
  /** 展示文本（缺省与 value 相同） */
  label?: string
  description?: string
  kind: CompletionKind
  icon?: string
  score: number
  matchKind: MatchKind
}

export interface CommandContext {
  before: string
  after: string
  token: string
  /** token 在整行中的起始偏移 */
  tokenStart: number
  /** 建议替换到的偏移（token 结尾） */
  replaceEnd: number
  tokens: string[]
  quote: '"' | "'" | null
  atCommandPosition: boolean
  command: string | null
  argIndex: number
  expecting: 'command' | 'option' | 'argument'
  usedOptions: string[]
  aiPrefix: boolean
}

export interface CompletionResult {
  candidates: CompletionCandidate[]
  context: CommandContext
  elapsedMs: number
  specName: string | null
  /** 主进程建议的输入防抖（ms）——UI 直接用它，不要自己硬编码 */
  debounceMs: number
  aiRequested: boolean
  notes?: string[]
}

export interface CompletionRequest {
  line: string
  cursor?: number
  history?: readonly string[]
  limit?: number
  cwd?: string
}

export const KIND_LABEL: Record<CompletionKind, string> = {
  command: '命令',
  subcommand: '子命令',
  option: '选项',
  history: '历史',
  directory: '目录',
  argument: '参数',
  ai: 'AI',
}

/* ────────────────────────────────────────────── 命令行跟踪 */

/**
 * 从终端输入流里跟踪「当前命令行」。
 *
 * 为什么不问 shell 要（Shell Integration / OSC 133）：
 * 那需要先注入 shell 脚本、且失败要回退，属于另一个模块的事。
 * 对补全来说，本地跟踪已经够用：只要正确维护「已输入、还没按回车」的那一段。
 *
 * 已知局限（写在明处，不假装完备）：
 * - 方向键/Home/End 会移动光标，本地不知道，因此行尾光标假设不总成立；
 *   检测到这类转义序列时直接**放弃本次补全**而不是给错结果。
 * - 远端 shell 自己做的行编辑（如 Ctrl+R 反向搜索）无法跟踪。
 */
export class LineTracker {
  private buffer = ''
  /** 遇到过无法跟踪的编辑动作，直到下次回车前都不再提供补全 */
  private unreliable = false

  get line(): string {
    return this.buffer
  }

  get cursor(): number {
    return this.buffer.length
  }

  get isReliable(): boolean {
    return !this.unreliable
  }

  reset(): void {
    this.buffer = ''
    this.unreliable = false
  }

  /** 消费一段来自终端的输入字节，返回是否需要重新计算补全 */
  consume(data: string): void {
    for (let i = 0; i < data.length; i += 1) {
      const ch = data[i]
      if (ch === undefined) continue

      // 回车 / 换行：提交，进历史
      if (ch === '\r' || ch === '\n') {
        this.reset()
        continue
      }
      // Ctrl+C / Ctrl+D / Ctrl+U 等：行内容作废
      if (ch === '\u0003' || ch === '\u0004' || ch === '\u0015' || ch === '\u001b') {
        // ESC 开头的是转义序列（方向键、Home/End…），光标位置不再可控
        if (ch === '\u001b') this.unreliable = true
        else this.reset()
        continue
      }
      // Backspace：DEL(0x7f) 或 BS(0x08)
      if (ch === '\u007f' || ch === '\b') {
        this.buffer = this.buffer.slice(0, -1)
        continue
      }
      // 其它控制字符忽略（Tab 补全由我们接管，不会走到这里）
      if (ch < ' ') continue
      this.buffer += ch
    }
  }
}

/* ────────────────────────────────────────────── 接受候选 */

export interface ApplyResult {
  /** 要发回终端的字节：若干退格 + 新文本 */
  payload: string
  /** 应用之后的整行（用于更新本地跟踪缓冲） */
  line: string
  /** 在新行里的光标位置 */
  cursor: number
}

/**
 * 把一个候选应用到当前命令行。
 *
 * 做法是「退格若干次 + 输入新文本」，而不是自己重绘整行：
 * 终端里回显的是远端 shell 的状态，本地重绘会和远端打架。
 * 退格用 DEL(0x7f)，这是绝大多数 shell 的行编辑约定。
 */
export function applyCandidate(
  line: string,
  context: Pick<CommandContext, 'tokenStart' | 'replaceEnd'>,
  candidate: CompletionCandidate,
): ApplyResult {
  const start = Math.max(0, Math.min(context.tokenStart, line.length))
  const end = Math.max(start, Math.min(context.replaceEnd, line.length))
  const backspaces = '\u007f'.repeat(end - start)
  const nextLine = line.slice(0, start) + candidate.value + line.slice(end)
  return {
    payload: `${backspaces}${candidate.value}`,
    line: nextLine,
    cursor: start + candidate.value.length,
  }
}
