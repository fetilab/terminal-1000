// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 命令搜索 / 离线命令手册（spec 验收标准第 8 条："命令搜索可离线查用法"）。
 *
 * 排序**可解释**：四档分数区间互不重叠，档位内短名优先 ——
 *   命令名完全匹配(1000) > 命令名前缀(≈800) > 命令名包含(≈600) > 描述命中(≈400)
 * 描述命中覆盖：用途、简述、选项名与选项描述、子命令、示例命令行。
 * 所以用户搜「压缩」能找到 tar/gzip、搜「端口」能找到 netstat/ss/lsof。
 *
 * 本文件只依赖 `CommandDoc`（由 corpus 一次性构建），是纯函数，便于单测。
 */

// 注意：`export type { X } from '...'` 只做再导出，**不会把 X 引入本地作用域** ——
// 本文件内部也用这两个类型，所以必须另外 import 一次。
import type { CommandSearchItem, CommandSearchResponse } from '@t1000/shared'
import type { CommandDoc } from './corpus'

/** 一条搜索结果（形状与契约一致；`packages/shared` 加入后按同名字段对齐） */
// 类型定义在 packages/shared：渲染层也要用同一份契约，
// 在主进程再定义一遍就会变成"镜像声明"（改了这边那边不报错，静默漂移）。
export type { CommandSearchItem, CommandSearchResponse } from '@t1000/shared'

export const SEARCH_DEFAULT_LIMIT = 20
export const SEARCH_MAX_LIMIT = 100

/** 匹配档位 */
export type SearchMatchKind = 'exact' | 'prefix' | 'contains' | 'text'

/**
 * 各档基础分。区间刻意拉开：
 * prefix 最低 800-64=736 > contains 最高 600；contains 最低 600-64=536 > text 最高 400。
 * 因此"档位优先"永远成立，与命令名长度无关。
 */
export const SEARCH_SCORES: Record<SearchMatchKind, number> = {
  exact: 1000,
  prefix: 800,
  contains: 600,
  text: 400,
}

/**
 * 给一条命令打分（可解释：返回命中的档位）。
 *
 * 同名长命令扣分（`- name.length`）：同档位下更短的名字更可能是用户想要的
 * （搜 "git" 时 git 排在 gitea 前）。
 */
export function scoreDoc(
  doc: CommandDoc,
  query: string,
): { kind: SearchMatchKind; score: number } | null {
  const q = query.trim().toLowerCase()
  if (q.length === 0) return null

  const name = doc.name.toLowerCase()
  if (name === q) return { kind: 'exact', score: SEARCH_SCORES.exact }
  if (name.startsWith(q)) return { kind: 'prefix', score: SEARCH_SCORES.prefix - name.length }
  if (name.includes(q)) return { kind: 'contains', score: SEARCH_SCORES.contains - name.length }
  if (doc.matchText.includes(q)) {
    // 同一档位内细分：命中用途/简述比只命中选项或示例更贴近用户意图。
    // 加分幅度（≤30）远小于档位间距（≥136），不会越过"包含命中"档。
    const bonus = doc.matchPrimary.includes(q) ? 30 : 10
    return { kind: 'text', score: SEARCH_SCORES.text - name.length + bonus }
  }
  return null
}

/**
 * 执行一次搜索。
 *
 * - 空 query → **空结果**（不返回全量，避免一次刷出 214 条）
 * - limit 默认 20、夹到 1..100；超出时 `truncated=true`
 */
export function searchCommands(
  docs: readonly CommandDoc[],
  query: string,
  limit: number = SEARCH_DEFAULT_LIMIT,
): CommandSearchResponse {
  const trimmed = query.trim()
  const capped = clampLimit(limit)
  if (trimmed.length === 0) return { query: trimmed, results: [], truncated: false }

  const scored: Array<{ doc: CommandDoc; kind: SearchMatchKind; score: number }> = []
  for (const doc of docs) {
    const match = scoreDoc(doc, trimmed)
    if (match !== null) scored.push({ doc, ...match })
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    if (a.doc.name.length !== b.doc.name.length) return a.doc.name.length - b.doc.name.length
    return a.doc.name.localeCompare(b.doc.name)
  })

  return {
    query: trimmed,
    results: scored.slice(0, capped).map((entry) => toSearchItem(entry.doc)),
    truncated: scored.length > capped,
  }
}

/** 把内部文档转成对外的结果项（可选字段缺省就不出现，保持载荷干净） */
export function toSearchItem(doc: CommandDoc): CommandSearchItem {
  const item: CommandSearchItem = { name: doc.name }

  // 用途缺失时回落到目录里的简述，保证任何来源都能给出说明
  const summary = doc.purpose ?? doc.brief
  if (summary !== '') item.summary = summary
  item.category = doc.categoryLabel
  if (doc.install !== undefined && doc.install !== '') item.install = doc.install
  if (doc.usage !== undefined && doc.usage !== '') item.usage = doc.usage

  if (doc.options.length > 0) {
    item.options = doc.options.map((option) =>
      option.arg === undefined || option.arg === ''
        ? { name: option.name, description: option.description }
        : { name: option.name, description: option.description, arg: option.arg },
    )
  }
  if (doc.subcommands !== undefined && doc.subcommands.length > 0) {
    item.subcommands = doc.subcommands.map((sub) => ({
      name: sub.name,
      description: sub.description,
    }))
  }
  if (doc.examples !== undefined && doc.examples.length > 0) {
    item.examples = doc.examples.map((example) => ({
      command: example.command,
      description: example.description,
    }))
  }
  if (doc.shortcuts !== undefined && doc.shortcuts.length > 0) {
    item.shortcuts = doc.shortcuts.map((shortcut) => ({
      key: shortcut.key,
      description: shortcut.description,
    }))
  }
  return item
}

function clampLimit(limit: number): number {
  if (!Number.isFinite(limit)) return SEARCH_DEFAULT_LIMIT
  return Math.min(SEARCH_MAX_LIMIT, Math.max(1, Math.trunc(limit)))
}
