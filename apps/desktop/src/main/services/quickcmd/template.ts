// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * `${{...}}` 模板解析与渲染（spec §6.2/§6.3/§6.4）。
 *
 * 两种占位符共用同一语法，按**名字**区分：
 * - 名字是内置动态变量 → 绿色标签（系统生成、不记历史）
 * - 其它合法名字 → 蓝色自定义参数（用户输入、记历史、跨命令共享）
 *
 * 边界情况（单测重点）：
 * - 未闭合 `${{name`  → 原样当字面量，绝不猜测
 * - 空名字 `${{}}` / `${{:fmt}}` → 字面量
 * - 名字含空格/点/`$`等非法字符 → 字面量（不会被当成参数悄悄吃掉）
 * - 同一个参数出现多次 → 只提示一次、渲染时全部替换
 */

import { evaluateVariable, isDynamicVariable, type VariableContext } from './variables'

export type TokenKind = 'variable' | 'parameter'

export interface TemplateToken {
  kind: TokenKind
  /** 占位符名字（已 trim） */
  name: string
  /** `${{name:format}}` 的格式部分（动态变量用） */
  format?: string
  /** 原始文本，如 `${{date:YYYYMMDD}}` */
  raw: string
  /** 在命令文本中的起止下标（含 raw） */
  start: number
  end: number
}

export interface ParsedTemplate {
  tokens: TemplateToken[]
  /** 动态变量（按出现顺序，允许重名重复出现） */
  variables: TemplateToken[]
  /** 自定义参数（按出现顺序，允许重名重复出现） */
  parameters: TemplateToken[]
  /** 参数名去重后的顺序列表（执行时逐个提示） */
  parameterNames: string[]
  /** 是否存在未闭合的 `${{`（UI 可据此提示用户"你少写了 }}"） */
  hasUnclosed: boolean
}

/** 合法名字：字母/数字/下划线/中文（v5.2.47 起支持中文变量名） */
const VALID_NAME = /^[A-Za-z0-9_\u3400-\u9fff]+$/

const OPEN = '${{'
const CLOSE = '}}'

/**
 * 解析模板。不抛错：任何不合法的写法都退化成字面量（命令照样能保存/执行）。
 */
export function parseTemplate(command: string): ParsedTemplate {
  const tokens: TemplateToken[] = []
  let hasUnclosed = false
  let cursor = 0

  while (cursor < command.length) {
    const open = command.indexOf(OPEN, cursor)
    if (open === -1) break

    const close = command.indexOf(CLOSE, open + OPEN.length)
    if (close === -1) {
      hasUnclosed = true
      break // 剩下的全是字面量
    }

    const body = command.slice(open + OPEN.length, close)
    const colon = body.indexOf(':')
    const rawName = colon === -1 ? body : body.slice(0, colon)
    const rawFormat = colon === -1 ? undefined : body.slice(colon + 1)
    const name = rawName.trim()
    const format = rawFormat?.trim()

    if (name === '' || !VALID_NAME.test(name)) {
      // 非法 → 当字面量跳过整段，继续往后扫
      cursor = close + CLOSE.length
      continue
    }

    const kind: TokenKind = isDynamicVariable(name) ? 'variable' : 'parameter'
    const token: TemplateToken = {
      kind,
      name,
      ...(kind === 'variable' && format !== undefined && format !== '' ? { format } : {}),
      raw: command.slice(open, close + CLOSE.length),
      start: open,
      end: close + CLOSE.length,
    }
    tokens.push(token)
    cursor = close + CLOSE.length
  }

  const variables = tokens.filter((t) => t.kind === 'variable')
  const parameters = tokens.filter((t) => t.kind === 'parameter')
  const parameterNames: string[] = []
  for (const token of parameters) {
    if (!parameterNames.includes(token.name)) parameterNames.push(token.name)
  }

  return { tokens, variables, parameters, parameterNames, hasUnclosed }
}

/** 模板里用到的动态变量名（去重，保持顺序） */
export function variableNamesOf(parsed: ParsedTemplate): string[] {
  const names: string[] = []
  for (const token of parsed.variables) {
    if (!names.includes(token.name)) names.push(token.name)
  }
  return names
}

export interface RenderResult {
  /** 替换后的完整文本 */
  text: string
  /** 未提供值的参数名（渲染时保留原占位符） */
  missingParams: string[]
}

/**
 * 渲染模板。
 * - 动态变量：始终由 context 求值（含 password/clipboard）
 * - 自定义参数：用 `params` 里的值替换；**缺失时保留占位符**并记入 missingParams
 *   （这样 PREVIEW 能如实显示"还有哪些没填"，而不是显示一个假的空值）
 */
export function renderTemplate(
  command: string,
  values: { context?: VariableContext; params?: Record<string, string> } = {},
): RenderResult {
  const parsed = parseTemplate(command)
  const params = values.params ?? {}
  const context = values.context ?? {}
  const missing: string[] = []

  let out = ''
  let last = 0
  for (const token of parsed.tokens) {
    out += command.slice(last, token.start)
    if (token.kind === 'variable') {
      out += evaluateVariable(token.name, token.format, context)
    } else {
      const value = params[token.name]
      if (value === undefined) {
        out += token.raw
        if (!missing.includes(token.name)) missing.push(token.name)
      } else {
        out += value
      }
    }
    last = token.end
  }
  out += command.slice(last)
  return { text: out, missingParams: missing }
}

/**
 * 拆成待发送的行（多行命令"逐行发送"，spec §6.2）。
 * - 去掉首尾空白行与纯空白行
 * - 行尾的 `\r` 去掉（Windows 换行）
 */
export function splitLines(command: string): string[] {
  return command
    .split(/\r?\n/)
    .map((line) => line.replace(/\r$/, '').trim())
    .filter((line) => line !== '')
}

/** 渲染 + 逐行拆分（执行/粘贴用） */
export function renderLines(
  command: string,
  values: { context?: VariableContext; params?: Record<string, string> } = {},
): { lines: string[]; missingParams: string[] } {
  const rendered = renderTemplate(command, values)
  return { lines: splitLines(rendered.text), missingParams: rendered.missingParams }
}

export interface TemplateTag {
  name: string
  kind: TokenKind
  /** 动态变量的格式（自定义参数为 undefined） */
  format?: string
  count: number
}

/** UI 的标签列表：绿色=动态变量、蓝色=自定义参数（同名的合并计数） */
export function templateTags(parsed: ParsedTemplate): TemplateTag[] {
  const tags: TemplateTag[] = []
  for (const token of parsed.tokens) {
    const existing = tags.find((t) => t.name === token.name && t.kind === token.kind)
    if (existing) {
      existing.count++
      continue
    }
    tags.push({
      name: token.name,
      kind: token.kind,
      ...(token.format === undefined ? {} : { format: token.format }),
      count: 1,
    })
  }
  return tags
}

/** 便捷：直接由命令文本得到参数名列表（UI 实时显示识别到的参数标签） */
export function parameterNamesOf(command: string): string[] {
  return parseTemplate(command).parameterNames
}
