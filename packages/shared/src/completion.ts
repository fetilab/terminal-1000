// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 命令补全面向 UI 的数据形状。
 *
 * 为什么在这里：这些形状原先只定义在主进程 `services/completion/engine.ts`，
 * 渲染层（`features/terminal/completion.ts`）镜像了一份同形状声明。
 * 镜像已经出现漂移（见 `CompletionRequest.history`），上移后双方共用同一份定义。
 *
 * 边界：本文件只放"请求 / 结果 / 候选"这些跨进程形状；
 * 引擎内部的东西（`CompletionGenerator`、`AiSuggestionProvider`、语料 spec 等）
 * 仍然留在主进程。本文件**零 import**、零运行时代码（`KIND_LABEL` 之类的 UI 文案
 * 不属于契约，留在渲染层）。
 */

export type CompletionKind =
  | 'command'
  | 'subcommand'
  | 'option'
  | 'history'
  | 'directory'
  | 'argument'
  | 'ai'

/** 候选的匹配方式：精确 > 前缀 > 模糊（分数档位也按此递减） */
export type MatchKind = 'exact' | 'prefix' | 'fuzzy'

export interface CompletionCandidate {
  /** 接受后插入的文本 */
  value: string
  /** 展示文本（缺省与 value 相同） */
  label?: string
  description?: string
  kind: CompletionKind
  icon?: string
  /** 排序分（越大越靠前） */
  score: number
  matchKind: MatchKind
}

/** 命令行语法解析结果（光标处的上下文） */
export interface CommandContext {
  /** 光标前的文本 */
  before: string
  /** 光标后的文本 */
  after: string
  /** 光标处的 token（引号内为引号内容） */
  token: string
  /** token 在整行中的起始偏移（引号内指向引号之后） */
  tokenStart: number
  /** 建议替换到的偏移（token 结尾） */
  replaceEnd: number
  /** 光标前已完成的 token（含分隔符） */
  tokens: string[]
  /** 光标是否处于引号内 */
  quote: '"' | "'" | null
  /** 是否处于「命令名」位置（行首，或管道/&&/; 之后） */
  atCommandPosition: boolean
  /** 当前命令名（命令位置时为 null） */
  command: string | null
  /** 已输入的非选项参数个数 */
  argIndex: number
  /** 语法层期待：命令名 / 选项 / 参数 */
  expecting: 'command' | 'option' | 'argument'
  /** 已出现的选项（用于候选去重） */
  usedOptions: string[]
  /** 是否 `??` 开头（AI 建议通道） */
  aiPrefix: boolean
}

/** 历史命令条目（可带频次；纯字符串也接受，频次默认 1） */
export interface HistoryEntry {
  line: string
  count?: number
}

/**
 * 补全请求。
 *
 * 注意 `history` **同时接受字符串与带频次的条目** —— 主进程一直支持两种写法，
 * 早期渲染层的镜像只声明了 `readonly string[]`，属于已经发生的漂移。
 */
export interface CompletionRequest {
  line: string
  cursor?: number
  history?: readonly (string | HistoryEntry)[]
  /** 候选上限覆盖（缺省用 CompletionSettings.maxSuggestions） */
  limit?: number
  /** 终端当前工作目录（目录补全用） */
  cwd?: string
}

export interface CompletionResult {
  candidates: CompletionCandidate[]
  context: CommandContext
  /** 本次补全耗时（ms） */
  elapsedMs: number
  /** 命中的命令 spec 名（未命中为 null） */
  specName: string | null
  /** 主进程建议的输入防抖（ms）——UI 直接用，不要自己硬编码 */
  debounceMs: number
  /** 是否走了 AI 建议通道（`??` 前缀） */
  aiRequested: boolean
  notes?: string[]
}
