// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 用户补全语料文件（设置项 `completion.corpusFile`）的解析与合并。
 *
 * 文件格式与内置语料（specs/）同一套紧凑写法，只是落在 JSON 里：
 * 顶层是「命令名 → 条目」的对象，条目字段全部可选，同名命令整体覆盖内置明细。
 *
 * 最小示例：
 * ```json
 * {
 *   "t1000demo": {
 *     "brief": "示例命令",
 *     "category": "system",
 *     "opts": [["--hello", "打招呼"]],
 *     "subs": [["add", "添加一条记录"]]
 *   }
 * }
 * ```
 *
 * 本模块是纯解析/合并逻辑：不碰文件系统、不 import 运行时实现；
 * 真实 IO 由调用方注入（completion/index.ts 用 node:fs/promises 实现）。
 * 条目级错误逐条上报（合法条目照常生效），整文件级错误全部降级。
 */

import type {
  CommandCategory,
  CommandIndexEntry,
  CommandSpec,
  SpecExample,
  SpecOption,
  SpecShortcut,
  SpecSubcommand,
} from './specs/types'
import { COMMAND_CATEGORIES, isSafeSpecName } from './specs/types'

/** 用户条目里供索引使用的补充/覆盖信息 */
export interface UserIndexEntry {
  /** 简述；同名覆盖时缺省沿用内置 brief，新命令缺省空串 */
  brief?: string
  /** 分类；同名覆盖时缺省沿用内置，新命令缺省 'system' */
  category?: CommandCategory
  hasSubcommands?: boolean
}

/** 语料层的用户部分：同名命令的明细与索引都以此为准 */
export interface UserCorpusLayer {
  readonly specs: ReadonlyMap<string, CommandSpec>
  readonly indexEntries: ReadonlyMap<string, UserIndexEntry>
}

export interface UserCorpusProblem {
  command: string
  detail: string
}

export interface ParsedUserCorpus {
  specs: Map<string, CommandSpec>
  indexEntries: Map<string, UserIndexEntry>
  /** 非法条目逐条上报；合法条目不受影响 */
  problems: UserCorpusProblem[]
}

export function formatUserCorpusProblem(problem: UserCorpusProblem): string {
  return `${problem.command}: ${problem.detail}`
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function isStringPair(row: unknown): row is readonly [string, string] {
  return (
    Array.isArray(row) &&
    row.length === 2 &&
    typeof row[0] === 'string' &&
    typeof row[1] === 'string'
  )
}

/** [选项, 说明] 或 [选项, 说明, 参数占位] */
function isOptionRow(row: unknown): row is readonly [string, string] | readonly [string, string, string] {
  return (
    Array.isArray(row) &&
    (row.length === 2 || row.length === 3) &&
    typeof row[0] === 'string' &&
    typeof row[1] === 'string' &&
    (row.length === 2 || typeof row[2] === 'string')
  )
}

function parseOptionRow(row: readonly [string, string] | readonly [string, string, string]): SpecOption {
  const [name, description, arg] = row
  // 空占位符视为「该选项不带参数」，与内置语料 normalizeSpec 同规则
  if (arg === undefined || arg.trim().length === 0) return { name, description }
  return { name, description, arg }
}

/** 解析用户语料文件文本。永不抛出：所有问题都以 problems 形式如实返回。 */
export function parseUserCorpus(text: string): ParsedUserCorpus {
  const specs = new Map<string, CommandSpec>()
  const indexEntries = new Map<string, UserIndexEntry>()
  const problems: UserCorpusProblem[] = []
  const fail = (command: string, detail: string): void => {
    problems.push({ command, detail })
  }

  let root: unknown
  try {
    root = JSON.parse(text)
  } catch (err) {
    fail('<文件>', `不是合法 JSON：${err instanceof Error ? err.message : String(err)}`)
    return { specs, indexEntries, problems }
  }
  if (!isPlainObject(root)) {
    fail('<文件>', '顶层必须是 JSON 对象（命令名 → 条目）')
    return { specs, indexEntries, problems }
  }

  for (const [name, raw] of Object.entries(root)) {
    if (!isSafeSpecName(name)) {
      fail(name, '命令名不合法（只允许字母数字与 @._+-，且不含路径分隔符）')
      continue
    }
    if (!isPlainObject(raw)) {
      fail(name, '条目必须是对象（字段：brief / category / opts / subs / example / purpose / install / usage / examples / shortcuts）')
      continue
    }

    const entry = raw
    let invalid = false
    const bad = (field: string, expect: string): void => {
      invalid = true
      fail(name, `字段 ${field} ${expect}`)
    }

    let brief: string | undefined
    if (entry.brief !== undefined) {
      if (typeof entry.brief !== 'string') bad('brief', '必须是字符串')
      else brief = entry.brief
    }

    let category: CommandCategory | undefined
    if (entry.category !== undefined) {
      if (typeof entry.category !== 'string' || !COMMAND_CATEGORIES.includes(entry.category as CommandCategory)) {
        bad('category', `必须是 ${COMMAND_CATEGORIES.join(' / ')} 之一`)
      } else {
        category = entry.category as CommandCategory
      }
    }

    let options: SpecOption[] | undefined
    if (entry.opts !== undefined) {
      const optsError = '必须是数组，元素为 [选项, 说明] 或 [选项, 说明, 参数占位]'
      if (!Array.isArray(entry.opts)) {
        bad('opts', optsError)
      } else {
        const rows: SpecOption[] = []
        let ok = true
        for (const row of entry.opts) {
          if (!isOptionRow(row)) {
            bad('opts', optsError)
            ok = false
            break
          }
          rows.push(parseOptionRow(row))
        }
        if (ok) options = rows
      }
    }

    let subcommands: SpecSubcommand[] | undefined
    if (entry.subs !== undefined) {
      const subsError = '必须是数组，元素为 [子命令, 说明]'
      if (!Array.isArray(entry.subs)) {
        bad('subs', subsError)
      } else {
        const rows: SpecSubcommand[] = []
        let ok = true
        for (const row of entry.subs) {
          if (!isStringPair(row)) {
            bad('subs', subsError)
            ok = false
            break
          }
          rows.push({ name: row[0], description: row[1] })
        }
        if (ok) subcommands = rows
      }
    }

    let example: string | undefined
    if (entry.example !== undefined) {
      if (typeof entry.example !== 'string') bad('example', '必须是字符串')
      else example = entry.example
    }
    let purpose: string | undefined
    if (entry.purpose !== undefined) {
      if (typeof entry.purpose !== 'string') bad('purpose', '必须是字符串')
      else purpose = entry.purpose
    }
    let install: string | undefined
    if (entry.install !== undefined) {
      if (typeof entry.install !== 'string') bad('install', '必须是字符串')
      else install = entry.install
    }
    let usage: string | undefined
    if (entry.usage !== undefined) {
      if (typeof entry.usage !== 'string') bad('usage', '必须是字符串')
      else usage = entry.usage
    }

    let examples: SpecExample[] | undefined
    if (entry.examples !== undefined) {
      const examplesError = '必须是数组，元素为 [命令, 说明]'
      if (!Array.isArray(entry.examples)) {
        bad('examples', examplesError)
      } else {
        const rows: SpecExample[] = []
        let ok = true
        for (const row of entry.examples) {
          if (!isStringPair(row)) {
            bad('examples', examplesError)
            ok = false
            break
          }
          rows.push({ command: row[0], description: row[1] })
        }
        if (ok) examples = rows
      }
    }

    let shortcuts: SpecShortcut[] | undefined
    if (entry.shortcuts !== undefined) {
      const shortcutsError = '必须是数组，元素为 [按键, 说明]'
      if (!Array.isArray(entry.shortcuts)) {
        bad('shortcuts', shortcutsError)
      } else {
        const rows: SpecShortcut[] = []
        let ok = true
        for (const row of entry.shortcuts) {
          if (!isStringPair(row)) {
            bad('shortcuts', shortcutsError)
            ok = false
            break
          }
          rows.push({ key: row[0], description: row[1] })
        }
        if (ok) shortcuts = rows
      }
    }

    if (invalid) continue

    const spec: CommandSpec = { name, options: options ?? [] }
    if (subcommands !== undefined && subcommands.length > 0) spec.subcommands = subcommands
    if (example !== undefined) spec.example = example
    if (purpose !== undefined) spec.purpose = purpose
    if (install !== undefined) spec.install = install
    if (usage !== undefined) spec.usage = usage
    if (examples !== undefined) spec.examples = examples
    if (shortcuts !== undefined) spec.shortcuts = shortcuts

    specs.set(name, spec)
    indexEntries.set(name, {
      ...(brief !== undefined ? { brief } : {}),
      ...(category !== undefined ? { category } : {}),
      ...(subcommands !== undefined ? { hasSubcommands: subcommands.length > 0 } : {}),
    })
  }

  return { specs, indexEntries, problems }
}

/**
 * 索引合并：内置条目在前；用户同名条目只覆盖它显式提供的字段（brief/category/hasSubcommands），
 * 用户新增命令追加在尾部（category 缺省 'system'）。
 */
export function mergeIndexEntries(
  builtin: readonly CommandIndexEntry[],
  user: ReadonlyMap<string, UserIndexEntry>,
): CommandIndexEntry[] {
  if (user.size === 0) return [...builtin]
  const out: CommandIndexEntry[] = builtin.map((entry) => ({ ...entry }))
  const positions = new Map(out.map((entry, index) => [entry.name, index]))
  for (const [name, userEntry] of user) {
    const position = positions.get(name)
    if (position !== undefined) {
      const current = out[position] as CommandIndexEntry
      out[position] = {
        ...current,
        ...(userEntry.brief !== undefined ? { brief: userEntry.brief } : {}),
        ...(userEntry.category !== undefined ? { category: userEntry.category } : {}),
        ...(userEntry.hasSubcommands !== undefined ? { hasSubcommands: userEntry.hasSubcommands } : {}),
      }
    } else {
      positions.set(name, out.length)
      const appended: CommandIndexEntry = {
        name,
        brief: userEntry.brief ?? '',
        category: userEntry.category ?? 'system',
      }
      if (userEntry.hasSubcommands !== undefined) appended.hasSubcommands = userEntry.hasSubcommands
      out.push(appended)
    }
  }
  return out
}

// ── 加载（IO 注入） ────────────────────────────────────────────────────────

export interface UserCorpusIo {
  /** 读文件文本；文件不存在返回 null，其它错误抛出 */
  readFile(path: string): Promise<string | null>
}

export type UserCorpusLoadResult =
  | {
      state: 'ok'
      layer: UserCorpusLayer
      /** 用户语料里的命令条数（不含被丢弃的非法条目） */
      userCommands: number
      /** 部分条目非法时的明细（合法条目已生效） */
      problems: readonly UserCorpusProblem[]
    }
  | { state: 'missing' }
  | { state: 'error'; detail: string }
  | { state: 'invalid'; problems: readonly UserCorpusProblem[] }

/** 读取并解析用户语料文件。永不抛出（读取错误折进 error 状态）。 */
export async function loadUserCorpus(path: string, io: UserCorpusIo): Promise<UserCorpusLoadResult> {
  let text: string | null
  try {
    text = await io.readFile(path)
  } catch (err) {
    return { state: 'error', detail: err instanceof Error ? err.message : String(err) }
  }
  if (text === null) return { state: 'missing' }

  const parsed = parseUserCorpus(text)
  // 文件可读但没有一条可用 → 如实判非法（而不是静默当成"空语料"）
  if (parsed.specs.size === 0 && parsed.problems.length > 0) {
    return { state: 'invalid', problems: parsed.problems }
  }
  return {
    state: 'ok',
    layer: { specs: parsed.specs, indexEntries: parsed.indexEntries },
    userCommands: parsed.specs.size,
    problems: parsed.problems,
  }
}
