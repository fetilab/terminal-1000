// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 补全语料的**数据契约**（叶子模块，不 import 任何东西，避免循环依赖）。
 *
 * 合规说明：本目录下的语料是 terminal-1000 自己编写的命令说明，
 * **没有**从任何第三方补全库（含 withfig / Fig）或逆向材料中提取。
 * 命令与选项事实属于通用 CLI 知识，描述文字为本项目自撰。
 */

/** 语料分类。同时决定详情模块的加载粒度（命中某一类才加载那一类）。 */
export type CommandCategory =
  | 'files'
  | 'text'
  | 'process'
  | 'network'
  | 'system'
  | 'package'
  | 'container'
  | 'vcs'
  | 'security'

export const COMMAND_CATEGORIES: readonly CommandCategory[] = [
  'files',
  'text',
  'process',
  'network',
  'system',
  'package',
  'container',
  'vcs',
  'security',
]

/** 索引条目：首屏只加载这个（命令名 + 简述 + 分类），不含任何选项明细。 */
export interface CommandIndexEntry {
  name: string
  brief: string
  category: CommandCategory
  /** 是否还有子命令（索引里显式声明，避免为了判断而加载详情） */
  hasSubcommands?: boolean
}

export interface SpecOption {
  /** 选项名，如 `-l` / `--long` */
  name: string
  description: string
  /** 该选项需要的参数占位符，如 `FILE`（没有参数则省略） */
  arg?: string
}

export interface SpecSubcommand {
  name: string
  description: string
}

/** 单个命令的详情（惰性加载的实体） */
export interface CommandSpec {
  name: string
  options: SpecOption[]
  subcommands?: SpecSubcommand[]
  example?: string
}

/** 紧凑的选项行：[选项, 说明] 或 [选项, 说明, 参数占位] */
export type OptionRow = readonly [string, string] | readonly [string, string, string]

/** 紧凑的子命令行：[子命令, 说明] */
export type SubcommandRow = readonly [string, string]

/**
 * 语料书写格式：各分类模块里手写这种紧凑结构，
 * 由 `normalizeSpec()` 转成完整的 CommandSpec。
 */
export interface SpecRows {
  /** 子命令行 */
  subs?: readonly SubcommandRow[]
  /** 选项行 */
  opts?: readonly OptionRow[]
  /** 示例（UI 展示用） */
  example?: string
}

/** 把紧凑行转成 CommandSpec（缺省字段一律补齐，避免下游判空） */
export function normalizeSpec(name: string, rows: SpecRows): CommandSpec {
  const options: SpecOption[] = (rows.opts ?? []).map((row) => {
    const [optName, description, arg] = row
    return arg === undefined ? { name: optName, description } : { name: optName, description, arg }
  })

  const spec: CommandSpec = { name, options }
  if (rows.subs && rows.subs.length > 0) {
    spec.subcommands = rows.subs.map(([subName, description]) => ({ name: subName, description }))
  }
  if (rows.example !== undefined) spec.example = rows.example
  return spec
}
