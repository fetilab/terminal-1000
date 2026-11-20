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
/** 分类的中文标签（UI 直接展示，不要让它自己维护一份映射） */
export const CATEGORY_LABELS: Record<CommandCategory, string> = {
  files: '文件与目录',
  text: '文本处理',
  process: '进程与资源',
  network: '网络',
  system: '系统与 Shell',
  package: '包管理与构建',
  container: '容器与虚拟化',
  vcs: '版本控制',
  security: '安全与密钥',
}

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

/** 一个示例：命令行 + 一句说明 */
export interface SpecExample {
  command: string
  description: string
}

/** 交互界面里的常用快捷键 */
export interface SpecShortcut {
  key: string
  description: string
}

/**
 * 单个命令的详情（惰性加载的实体）。
 *
 * `purpose` / `install` / `usage` / `examples` / `shortcuts` 是**命令手册**需要的字段
 * （spec/official-features.md 的「命令搜索」要求展开 用途/安装方式/语法/参数/常用快捷键）。
 * 全部可选：补全逻辑只依赖 name/options/subcommands。
 */
export interface CommandSpec {
  name: string
  options: SpecOption[]
  subcommands?: SpecSubcommand[]
  /** 补全用的单条示例（可被 examples 取代） */
  example?: string
  /** 用途：一句话说明这条命令是干什么的 */
  purpose?: string
  /** 安装方式（系统自带的可写「系统自带」） */
  install?: string
  /** 语法/用法行 */
  usage?: string
  /** 常用示例 */
  examples?: SpecExample[]
  /** 常用快捷键（交互式命令才有） */
  shortcuts?: SpecShortcut[]
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
  /** 手册字段（可选；内置语料把手册文本集中放在 specs/manual/ 下） */
  purpose?: string
  install?: string
  usage?: string
  examples?: readonly (readonly [string, string])[]
  shortcuts?: readonly (readonly [string, string])[]
}

/**
 * 手册行（紧凑书写，供 specs/manual/ 使用）：
 * `[用途, 语法]` 或 `[用途, 语法, 安装方式]`
 */
export type ManualRow = readonly [string, string] | readonly [string, string, string]

/** 手册条目（含示例与快捷键时用对象形式书写） */
export interface ManualEntry {
  purpose: string
  usage: string
  install?: string
  examples?: readonly (readonly [string, string])[]
  shortcuts?: readonly (readonly [string, string])[]
}

/** 把紧凑手册行展开成 ManualEntry */
export function manualFromRow(row: ManualRow): ManualEntry {
  const [purpose, usage, install] = row
  return install === undefined ? { purpose, usage } : { purpose, usage, install }
}

/** 把手册字段写进 CommandSpec（就地返回同一个对象，便于链式组装） */
export function applyManual(spec: CommandSpec, manual: ManualEntry): CommandSpec {
  spec.purpose = manual.purpose
  spec.usage = manual.usage
  if (manual.install !== undefined && manual.install !== '') spec.install = manual.install
  if (manual.examples !== undefined && manual.examples.length > 0) {
    spec.examples = manual.examples.map(([command, description]) => ({ command, description }))
  }
  if (manual.shortcuts !== undefined && manual.shortcuts.length > 0) {
    spec.shortcuts = manual.shortcuts.map(([key, description]) => ({ key, description }))
  }
  return spec
}

/**
 * 路径穿越防护：只允许普通命令名，拒绝空串 / 分隔符 / `..` / 控制字符。
 * 放在叶子模块：内置目录语料与用户语料文件都要用它校验命令名。
 */
export function isSafeSpecName(name: string): boolean {
  if (name.length === 0 || name.length > 200) return false
  if (name.includes('/') || name.includes('\\') || name.includes('\0')) return false
  if (name === '.' || name === '..') return false
  return /^[A-Za-z0-9@._+-]+$/.test(name)
}

/** 把紧凑行转成 CommandSpec（缺省字段一律补齐，避免下游判空） */
export function normalizeSpec(name: string, rows: SpecRows): CommandSpec {
  const options: SpecOption[] = (rows.opts ?? []).map((row) => {
    const [optName, description, arg] = row
    // 空/纯空白的占位符视为「该选项不带参数」，避免手写语料时的空字符串漏进产物
    if (arg === undefined || arg.trim().length === 0) return { name: optName, description }
    return { name: optName, description, arg }
  })

  const spec: CommandSpec = { name, options }
  if (rows.subs && rows.subs.length > 0) {
    spec.subcommands = rows.subs.map(([subName, description]) => ({ name: subName, description }))
  }
  if (rows.example !== undefined) spec.example = rows.example
  if (rows.purpose !== undefined || rows.usage !== undefined) {
    applyManual(spec, {
      purpose: rows.purpose ?? '',
      usage: rows.usage ?? '',
      ...(rows.install === undefined ? {} : { install: rows.install }),
      ...(rows.examples === undefined ? {} : { examples: rows.examples }),
      ...(rows.shortcuts === undefined ? {} : { shortcuts: rows.shortcuts }),
    })
  }
  return spec
}
