// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 补全引擎：命令行解析 + 三路候选源 + 排序。
 *
 * 设计要点
 * - **先解析再匹配**：`parseCommandLine()` 是纯函数（可单独测），产出光标处的
 *   token、是否在引号内、是否在管道后（管道后是新的命令位置 → 补命令名而不是选项）。
 * - **多源合并**：spec（命令名/子命令/选项）、history（频次）、generator（Beta）、AI（`??`）。
 * - **排序分档**：精确 > 前缀 > 模糊；同档内短者优先，再按字典序，保证结果稳定。
 * - **已输入的选项不再出现在候选里**（对齐参考实现的 removeAcceptedSuggestions）。
 * - 语料访问全部通过 `CompletionCorpus`，因此「按需加载 / LRU」可被计数断言。
 */

import type {
  CommandContext,
  CompletionCandidate,
  CompletionKind,
  CompletionRequest,
  CompletionResult,
  CompletionSettings,
  HistoryEntry,
  MatchKind,
} from '@t1000/shared'

// 面向 UI 的形状（候选/上下文/请求/结果）唯一定义处已上移到 `@t1000/shared`，
// 渲染层同样从那里取。这里再导出一次，保持既有 `./engine` import 路径可用。
export type {
  CommandContext,
  CompletionCandidate,
  CompletionKind,
  CompletionRequest,
  CompletionResult,
  HistoryEntry,
  MatchKind,
}
import { CompletionCorpus } from './corpus'
import { searchCommands, type CommandSearchResponse } from './search'
import type { CommandIndexEntry, SpecOption } from './specs/types'

// ── 类型 ──────────────────────────────────────────────────────────────────

// 候选/上下文/请求/结果等 UI 形状见 `@t1000/shared`（文件顶部已再导出）；
// 下面这些是**引擎内部**的注入点与调度类型，不属于跨进程契约。

export interface GeneratorRequest {
  /** 候选上限 */
  limit: number
  /** 终端当前工作目录（生成器按需使用） */
  cwd: string
}

export interface CompletionGenerator {
  readonly name: string
  /** 是否处理该上下文 */
  applies(context: CommandContext): boolean
  generate(context: CommandContext, request: GeneratorRequest): Promise<CompletionCandidate[]>
}

/** AI 建议通道（TODO：接入 services/ai；当前默认实现返回空） */
export interface AiSuggestionProvider {
  suggest(context: CommandContext, limit: number): Promise<CompletionCandidate[]>
}

export const DEFAULT_COMPLETION_SETTINGS: CompletionSettings = {
  enabled: true,
  specCompletion: true,
  historyCompletion: true,
  // 脚本生成式补全默认关闭（Beta，会起后台进程）
  generatorCompletion: false,
  aiSuggestion: true,
  debounceMs: 120,
  maxSuggestions: 20,
}

/** 图标按类型给出（终端 UI 的说明区用它区分候选来源） */
export const KIND_ICONS: Record<CompletionKind, string> = {
  command: '📀',
  subcommand: '📦',
  option: '🔗',
  history: '🕘',
  directory: '📁',
  argument: '📄',
  ai: '⭐',
}

// ── 命令行解析 ────────────────────────────────────────────────────────────

const COMMAND_SEPARATORS = new Set(['|', '||', '&&', ';', '&', '(', '\n'])
const REDIRECTIONS = new Set(['>', '>>', '<', '<<', '2>', '2>>', '&>'])
const ALL_OPERATORS = new Set([...COMMAND_SEPARATORS, ...REDIRECTIONS, ')'])
const WHITESPACE = /[ \t]/
const DELIMITERS = /[ \t|;&()<>]/

/** 是否是 `KEY=VALUE` 形式的环境变量前置赋值（它不是命令名） */
export function isEnvAssignment(token: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(token)
}

/**
 * 解析命令行（纯函数）。
 *
 * 处理：多空格、引号（单/双，含转义）、管道/`&&`/`;` 后的新命令位置、
 * 重定向后不当作命令位置、`KEY=VALUE` 前置赋值不当作命令。
 */
export function parseCommandLine(line: string, cursor?: number): CommandContext {
  const limit = cursor === undefined ? line.length : Math.max(0, Math.min(cursor, line.length))
  const before = line.slice(0, limit)
  const after = line.slice(limit)

  const tokens: string[] = []
  const usedOptions: string[] = []

  let current = ''
  let tokenStart = -1
  let quote: '"' | "'" | null = null
  let quoteStart = -1
  let nextIsCommand = true
  let command: string | null = null
  let argIndex = 0

  const commit = (): void => {
    if (current.length === 0) {
      tokenStart = -1
      return
    }
    const value = current
    tokens.push(value)
    if (value.startsWith('-') && value.length > 1) usedOptions.push(value)

    if (nextIsCommand) {
      if (!isEnvAssignment(value)) {
        command = value
        nextIsCommand = false
      }
      // KEY=VALUE 视为环境变量前置，命令位置保持
    } else if (!value.startsWith('-')) {
      argIndex += 1
    }
    current = ''
    tokenStart = -1
  }

  let i = 0
  while (i < before.length) {
    const ch = before[i] as string

    if (quote !== null) {
      if (ch === '\\' && quote === '"' && i + 1 < before.length) {
        current += before[i + 1]
        i += 2
        continue
      }
      if (ch === quote) {
        quote = null
        i += 1
        continue
      }
      current += ch
      i += 1
      continue
    }

    if (ch === "'" || ch === '"') {
      if (current.length === 0) tokenStart = i
      quote = ch
      quoteStart = i
      i += 1
      continue
    }

    if (ch === '\\' && i + 1 < before.length) {
      if (current.length === 0) tokenStart = i
      current += before[i + 1]
      i += 2
      continue
    }

    if (WHITESPACE.test(ch)) {
      commit()
      i += 1
      continue
    }

    if (DELIMITERS.test(ch)) {
      // 操作符：先结算当前 token，再把操作符本身作为一个 token
      commit()
      let op = ch
      const two = before.slice(i, i + 2)
      const three = before.slice(i, i + 3)
      if (three === '2>>' || three === '&>>') op = three
      else if (two === '||' || two === '&&' || two === '>>' || two === '<<' || two === '2>' || two === '&>') op = two

      tokens.push(op)
      i += op.length

      if (COMMAND_SEPARATORS.has(op)) {
        nextIsCommand = true
        command = null
        argIndex = 0
      } else {
        // 重定向 / 右括号之后是「参数」位置
        nextIsCommand = false
      }
      continue
    }

    if (current.length === 0) tokenStart = i
    current += ch
    i += 1
  }

  const atCommandPosition = nextIsCommand
  const inQuote = quote !== null

  // 光标处的 token 起点：引号内时指向引号之后
  const effectiveTokenStart = inQuote ? quoteStart + 1 : tokenStart < 0 ? before.length : tokenStart

  let replaceEnd = limit
  while (replaceEnd < line.length) {
    const ch = line[replaceEnd] as string
    if (DELIMITERS.test(ch)) break
    replaceEnd += 1
  }

  const expecting: CommandContext['expecting'] = atCommandPosition
    ? 'command'
    : current.startsWith('-')
      ? 'option'
      : 'argument'

  return {
    before,
    after,
    token: current,
    tokenStart: effectiveTokenStart,
    replaceEnd,
    tokens,
    quote: inQuote ? quote : null,
    atCommandPosition,
    command: atCommandPosition ? null : command,
    argIndex,
    expecting,
    usedOptions,
    aiPrefix: /^\s*\?\?(\s|$)/.test(before),
  }
}

// ── 匹配与排序 ────────────────────────────────────────────────────────────

/** token 是否是 target 的子序列（模糊匹配） */
export function isSubsequence(token: string, target: string): boolean {
  if (token.length === 0) return true
  let ti = 0
  for (let i = 0; i < target.length && ti < token.length; i++) {
    if (target[i] === token[ti]) ti += 1
  }
  return ti === token.length
}

/**
 * 候选匹配打分。分数分档保证「精确 > 前缀 > 模糊」：
 * exact 1000 / prefix 800- / fuzzy 300-。
 */
export function matchCandidate(
  target: string,
  token: string,
): { matchKind: MatchKind; score: number } | null {
  if (token.length === 0) return { matchKind: 'prefix', score: 800 }
  const lowerTarget = target.toLowerCase()
  const lowerToken = token.toLowerCase()

  if (lowerTarget === lowerToken) return { matchKind: 'exact', score: 1000 }
  if (lowerTarget.startsWith(lowerToken)) {
    return { matchKind: 'prefix', score: 800 - Math.min(200, target.length) }
  }
  if (lowerToken.length >= 2 && isSubsequence(lowerToken, lowerTarget)) {
    return { matchKind: 'fuzzy', score: 300 - Math.min(200, target.length) }
  }
  return null
}

/**
 * 排序：分数降序 → 短值优先 → 字典序。
 * 用下标保证稳定（同分时保持来源顺序）。
 */
export function sortCandidates(candidates: readonly CompletionCandidate[]): CompletionCandidate[] {
  return candidates
    .map((candidate, index) => ({ candidate, index }))
    .sort((a, b) => {
      if (b.candidate.score !== a.candidate.score) return b.candidate.score - a.candidate.score
      const av = a.candidate.value
      const bv = b.candidate.value
      if (av.length !== bv.length) return av.length - bv.length
      const byValue = av.localeCompare(bv)
      if (byValue !== 0) return byValue
      return a.index - b.index
    })
    .map(({ candidate }) => candidate)
}

/** 按 value 去重，保留分数更高（更靠前）的那个 */
export function dedupeCandidates(
  candidates: readonly CompletionCandidate[],
): CompletionCandidate[] {
  const best = new Map<string, CompletionCandidate>()
  for (const candidate of candidates) {
    if (candidate.value.length === 0) continue
    const existing = best.get(candidate.value)
    if (existing === undefined || candidate.score > existing.score) {
      best.set(candidate.value, candidate)
    }
  }
  return [...best.values()]
}

// ── 引擎 ──────────────────────────────────────────────────────────────────

export interface CompletionEngineOptions {
  corpus: CompletionCorpus
  settings?: Partial<CompletionSettings>
  generators?: readonly CompletionGenerator[]
  aiProvider?: AiSuggestionProvider
  /** 给命令名候选加一点「常用度」权重（命令名 → 权重），可选 */
  popularity?: ReadonlyMap<string, number>
}

/** 模糊回退对语料规模的硬上限（避免超大语料下退化成不可控的线性扫描） */
export const FUZZY_SCAN_LIMIT = 20_000

/** 从历史条目统计命令名常用度 */
export function buildPopularity(
  history: readonly (string | HistoryEntry)[],
): Map<string, number> {
  const counts = new Map<string, number>()
  for (const raw of history) {
    const entry: HistoryEntry = typeof raw === 'string' ? { line: raw } : raw
    // 跳过 `KEY=VALUE` 前置赋值，取第一个真正的命令名
    let command: string | undefined
    for (const part of entry.line.trim().split(/\s+/)) {
      if (part.length === 0 || isEnvAssignment(part)) continue
      command = part
      break
    }
    if (command === undefined) continue
    counts.set(command, (counts.get(command) ?? 0) + (entry.count ?? 1))
  }
  return counts
}

export class CompletionEngine {
  private settings: CompletionSettings
  private readonly generators: readonly CompletionGenerator[]
  /** 命令名 → 常用度权重（由历史频次动态刷新，叠加构造时传入的静态权重） */
  private popularity = new Map<string, number>()

  constructor(private readonly options: CompletionEngineOptions) {
    this.settings = { ...DEFAULT_COMPLETION_SETTINGS, ...options.settings }
    this.generators = options.generators ?? []
  }

  getSettings(): CompletionSettings {
    return { ...this.settings }
  }

  /** 局部更新设置（setSettings 用） */
  setSettings(patch: Partial<CompletionSettings>): CompletionSettings {
    this.settings = { ...this.settings, ...patch }
    return this.getSettings()
  }

  get corpus(): CompletionCorpus {
    return this.options.corpus
  }

  private refreshPopularity(history: readonly (string | HistoryEntry)[]): void {
    const counts = buildPopularity(history)
    if (this.options.popularity) {
      for (const [name, weight] of this.options.popularity) {
        counts.set(name, (counts.get(name) ?? 0) + weight)
      }
    }
    this.popularity = counts
  }

  /** 语料索引（listSpecs 用） */
  async listSpecs(): Promise<readonly CommandIndexEntry[]> {
    return this.options.corpus.index()
  }

  /**
   * 命令搜索 / 离线命令手册（spec 验收标准第 8 条）。
   *
   * 索引由 corpus 在**首次搜索时一次性构建**并常驻（不在启动路径上）；
   * 没有搜索/手册请求时，一个明细分类模块都不会被 import。
   */
  async search(query: string, limit?: number): Promise<CommandSearchResponse> {
    // 空 query 直接短路：清空搜索框不该触发一次全量索引构建
    const trimmed = query.trim()
    if (trimmed.length === 0) return { query: trimmed, results: [], truncated: false }
    const docs = await this.options.corpus.docs()
    return searchCommands(docs, trimmed, limit)
  }

  /** 搜索索引是否已构建（自检与测试用） */
  get searchIndexBuilt(): boolean {
    return this.options.corpus.docsBuilt
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const started = performance.now()
    const context = parseCommandLine(request.line, request.cursor)
    const limit = request.limit ?? this.settings.maxSuggestions
    const cwd = request.cwd ?? '/'
    const notes: string[] = []

    if (!this.settings.enabled) {
      return this.buildResult([], context, started, null, false, ['补全总开关已关闭'])
    }

    // 历史里的高频命令在命令名补全里也应该更靠前
    if (request.history) this.refreshPopularity(request.history)

    // 1) AI 建议通道：`??` 前缀
    if (context.aiPrefix) {
      if (!this.settings.aiSuggestion) {
        return this.buildResult([], context, started, null, false, ['AI 建议已关闭'])
      }
      const provider = this.options.aiProvider
      if (!provider) {
        // TODO(ai): 接入 services/ai 后由它产出候选；当前只透传「已请求」标记
        return this.buildResult([], context, started, null, true, ['AI 建议通道尚未接入'])
      }
      const aiCandidates = await provider.suggest(context, limit)
      return this.buildResult(aiCandidates, context, started, null, true, notes)
    }

    const collected: CompletionCandidate[] = []
    let specName: string | null = null

    if (this.settings.specCompletion) {
      if (context.atCommandPosition) {
        collected.push(...(await this.commandCandidates(context, limit)))
      } else if (context.command) {
        // entry() 依赖索引；这里必须先 await（参数位置可能没走过命令名分支）
        await this.options.corpus.index()
        const entry = this.options.corpus.entry(context.command)
        if (entry) {
          specName = entry.name
          const spec = await this.options.corpus.spec(entry.name)
          if (spec) collected.push(...this.specCandidates(context, spec, limit))
        }
      }
    }

    if (this.settings.historyCompletion && request.history) {
      collected.push(...this.historyCandidates(context, request.history, limit))
    }

    if (this.settings.generatorCompletion) {
      for (const generator of this.generators) {
        if (!generator.applies(context)) continue
        collected.push(...(await generator.generate(context, { limit, cwd })))
      }
    }

    const candidates = sortCandidates(dedupeCandidates(collected)).slice(0, Math.max(0, limit))
    return this.buildResult(candidates, context, started, specName, false, notes)
  }

  // ── 命令名 ──────────────────────────────────────────────────────────────

  private async commandCandidates(
    context: CommandContext,
    limit: number,
  ): Promise<CompletionCandidate[]> {
    const corpus = this.options.corpus
    const index = await corpus.index()
    const token = context.token

    // 前缀树：代价与命中子树相关，不做全量线性遍历
    const prefixEntries = corpus.commandsWithPrefix(token, limit * 4)
    let entries: readonly CommandIndexEntry[] = prefixEntries

    // 模糊匹配与前缀结果一起参与排序（分数档位更低），
    // 扫描有界：token 至少 2 个字符，且语料规模在上限内。
    if (token.length >= 2 && index.length <= FUZZY_SCAN_LIMIT) {
      const known = new Set(prefixEntries.map((e) => e.name))
      const lower = token.toLowerCase()
      const fuzzy: CommandIndexEntry[] = []
      for (const candidate of index) {
        if (known.has(candidate.name)) continue
        if (isSubsequence(lower, candidate.name.toLowerCase())) {
          fuzzy.push(candidate)
          if (fuzzy.length >= limit * 2) break
        }
      }
      if (fuzzy.length > 0) entries = [...prefixEntries, ...fuzzy]
    }

    const popularity = this.popularity
    const out: CompletionCandidate[] = []
    for (const entry of entries) {
      const match = matchCandidate(entry.name, token)
      if (!match) continue
      const boost = popularity.get(entry.name) ?? 0
      out.push({
        value: entry.name,
        description: entry.brief,
        kind: 'command',
        icon: KIND_ICONS.command,
        score: match.score + Math.min(100, boost * 5),
        matchKind: match.matchKind,
      })
    }
    return out.slice(0, limit * 4)
  }

  // ── 子命令 / 选项 ───────────────────────────────────────────────────────

  private specCandidates(
    context: CommandContext,
    spec: { options: SpecOption[]; subcommands?: { name: string; description: string }[] },
    limit: number,
  ): CompletionCandidate[] {
    const out: CompletionCandidate[] = []
    const token = context.token
    const wantsOption = context.expecting === 'option'

    // 选项位置，或「还没输入过子命令」时给子命令
    const offerSubcommands =
      !wantsOption && context.argIndex === 0 && (spec.subcommands?.length ?? 0) > 0

    if (offerSubcommands) {
      for (const sub of spec.subcommands ?? []) {
        const match = matchCandidate(sub.name, token)
        if (!match) continue
        out.push({
          value: sub.name,
          description: sub.description,
          kind: 'subcommand',
          icon: KIND_ICONS.subcommand,
          score: match.score,
          matchKind: match.matchKind,
        })
      }
    }

    if (wantsOption || token.length === 0) {
      const used = new Set(context.usedOptions)
      for (const option of spec.options) {
        // 已经输入过的选项不再提示
        if (used.has(option.name)) continue
        const match = matchCandidate(option.name, token)
        if (!match) continue
        out.push({
          value: option.name,
          description: option.arg === undefined ? option.description : `${option.description} <${option.arg}>`,
          kind: 'option',
          icon: KIND_ICONS.option,
          score: match.score - 50, // 选项略低于同名子命令
          matchKind: match.matchKind,
        })
      }
    }

    return out.slice(0, limit * 4)
  }

  // ── 历史 ────────────────────────────────────────────────────────────────

  private historyCandidates(
    context: CommandContext,
    history: readonly (string | HistoryEntry)[],
    limit: number,
  ): CompletionCandidate[] {
    const prefix = context.before.replace(/^\s+/, '')
    // 空行不提示历史（避免一打开就被历史淹没）
    if (prefix.length === 0) return []

    const lowerPrefix = prefix.toLowerCase()
    const out: CompletionCandidate[] = []

    for (let i = 0; i < history.length; i++) {
      const raw = history[i]
      if (raw === undefined) continue
      const entry: HistoryEntry = typeof raw === 'string' ? { line: raw } : raw
      const line = entry.line.trim()
      if (line.length === 0) continue
      if (!line.toLowerCase().startsWith(lowerPrefix)) continue
      if (line === prefix) continue // 已经输完了

      const count = entry.count ?? 1
      out.push({
        value: line,
        label: line,
        description: `历史命令 · 使用 ${count} 次`,
        kind: 'history',
        icon: KIND_ICONS.history,
        // 频次主导排序（同频时越靠前越新）
        score: 500 + Math.min(400, count * 20) - Math.min(40, i),
        matchKind: 'prefix',
      })
      if (out.length >= limit * 4) break
    }
    return out
  }

  private buildResult(
    candidates: readonly CompletionCandidate[],
    context: CommandContext,
    startedAt: number,
    specName: string | null,
    aiRequested: boolean,
    notes: readonly string[],
  ): CompletionResult {
    const result: CompletionResult = {
      candidates: [...candidates],
      context,
      elapsedMs: performance.now() - startedAt,
      specName,
      debounceMs: this.settings.debounceMs,
      aiRequested,
    }
    if (notes.length > 0) result.notes = [...notes]
    return result
  }
}

// ── 内置生成器（Beta） ────────────────────────────────────────────────────

export interface DirectoryGeneratorIo {
  /** 列出目录下的条目；不可读返回 null */
  listDir(path: string): readonly string[] | null
  /** 判断是否是目录 */
  isDir(path: string): boolean
}

/**
 * `cd` 的目录补全（对应设置里的「脚本生成式补全（Beta）」）。
 * 真实实现由调用方注入 IO，单测可完全脱离文件系统。
 */
export function createDirectoryGenerator(io: DirectoryGeneratorIo): CompletionGenerator {
  return {
    name: 'directory',
    applies: (context) => context.command === 'cd' && !context.token.startsWith('-'),
    generate: (context, request) => {
      const limit = request.limit
      const token = context.token
      const slash = token.lastIndexOf('/')
      const dirPart = slash >= 0 ? token.slice(0, slash + 1) : ''
      const namePart = slash >= 0 ? token.slice(slash + 1) : token
      const baseDir = dirPart.length === 0 ? request.cwd : resolvePath(request.cwd, dirPart)

      const entries = io.listDir(baseDir)
      if (entries === null) return Promise.resolve([])

      const out: CompletionCandidate[] = []
      for (const entry of entries) {
        const full = dirPart.length === 0 ? entry : `${dirPart}${entry}`
        const match = matchCandidate(entry, namePart)
        if (!match) continue
        const path = resolvePath(request.cwd, full)
        if (!io.isDir(path)) continue
        out.push({
          value: `${full}/`,
          description: '目录',
          kind: 'directory',
          icon: KIND_ICONS.directory,
          score: match.score,
          matchKind: match.matchKind,
        })
        if (out.length >= limit) break
      }
      return Promise.resolve(out)
    },
  }
}

function resolvePath(cwd: string, target: string): string {
  if (target.startsWith('/')) return normalizeSlashes(target)
  const base = cwd.endsWith('/') ? cwd.slice(0, -1) : cwd
  return normalizeSlashes(`${base}/${target}`)
}

function normalizeSlashes(path: string): string {
  return path.replace(/\/{2,}/g, '/')
}
