// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 快速命令的前端类型。
 *
 * ⚠️ 这些类型目前只定义在主进程 `services/quickcmd/*.ts`，**`packages/shared` 里还没有**，
 * 所以这里镜像一份（domain 侧已经补齐，不需要再绕了）。
 * 已反馈：把下面这些类型按 sessionlog/sftp 的先例上移到 shared，之后本文件只留 UI 自己的类型。
 *
 * 字段名严格按主进程实现（读源码得来），不按任务卡的描述猜：
 * - 保存/删除用的是 `save({id?, groupId?, name, command, note?})`、`delete({ids: []})`
 * - 移动是 `move({kind:'command'|'group', id, targetId, index?})`（注意是 `targetId` 不是 groupId）
 * - 渲染/粘贴用 `render({commandId?|command?, params?})`
 */

export interface QuickCommandRecord {
  id: string
  /** null = 位于根（未分组） */
  groupId: string | null
  name: string
  /** 支持多行；执行时逐行发送 */
  command: string
  note?: string
  order: number
  createdAt: string
  updatedAt: string
}

export interface QuickGroupRecord {
  id: string
  parentId: string | null
  name: string
  order: number
  createdAt: string
  updatedAt: string
}

export interface CommandNode {
  kind: 'command'
  id: string
  name: string
  command: string
  note?: string
  order: number
  groupId: string | null
}

export interface GroupTree extends QuickGroupRecord {
  kind: 'group'
  children: QuickNode[]
  /** 该组（含子组）下的命令总数 */
  commandCount: number
}

export type QuickNode = CommandNode | GroupTree

/**
 * 树形结构。
 *
 * ⚠️ 注意它**不是数组**：`{ roots, totalCommands, totalGroups }`。
 * 我一开始按数组用（`setTree(res.tree)`），面板一挂载就 `nodes is not iterable` 崩了 ——
 * 所以这里把形状写清楚，调用点也做 `Array.isArray` 防御。
 */
export interface QuickTree {
  roots: QuickNode[]
  totalCommands: number
  totalGroups: number
}

/** `list()` 的返回：既给扁平表，也给树 */
export interface QuickLibraryResponse {
  commands: QuickCommandRecord[]
  groups: QuickGroupRecord[]
  tree: QuickTree
}

/** `search()` 的返回 */
export interface CommandWithPath extends QuickCommandRecord {
  groupPath: string[]
}

/** 变量预览（`variables` 动作） */
export interface VariablePreview {
  name: string
  description: string
  format: string
  /** 机密变量返回打码后的文本 */
  value: string
  masked: boolean
  hasValue: boolean
  secret: boolean
}

/** 模板标签（`analyze` / `render`） */
export interface TemplateTag {
  kind: 'variable' | 'parameter'
  name: string
  format?: string
  /** 原文片段，便于高亮 */
  raw: string
}

export interface AnalyzeResult {
  tags: TemplateTag[]
  parameterNames: string[]
  /** 是否存在未闭合的 `${{` */
  hasUnclosed: boolean
}

/** `render()` 的返回 */
export interface RenderOutcome {
  text: string
  lines: string[]
  missingParams: string[]
  variables: VariablePreview[]
  tags: TemplateTag[]
  hasUnclosed: boolean
}

/** `parameterDialog()` 的返回 */
export interface ParameterDialogData {
  parameters: string[]
  /** 参数名 → 最近使用值（预填） */
  recentValues?: Record<string, string>
  /** 参数名 → 历史值列表 */
  history?: Record<string, string[]>
  preview: string
  missingParams: string[]
}

/** `paste()` 的返回 */
export interface PasteOutcome {
  lines: string[]
  text: string
  missingParams: string[]
}

/** `history()` 的返回（不带 name 时是全体） */
export type ParamHistoryData = Record<string, string[]>

/** `execute()` 的返回 */
export interface ExecuteOutcome {
  sessionId: string
  /** 实际发送的行 */
  lines: string[]
  sent: number
  missingParams?: string[]
}
