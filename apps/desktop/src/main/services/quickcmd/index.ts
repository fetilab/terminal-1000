// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * quickcmd 域：快速命令 / 命令片段（spec §6 整节）。
 *
 * 分层：
 * - 纯逻辑：`variables.ts`（动态变量+预览）、`template.ts`（${{}} 解析/渲染）、
 *   `search.ts`（拼音首字母）、`tree.ts`（多级分组/级联/拖拽）、`history.ts`（历史回填）
 * - 编排：本文件（校验、缓存、持久化、执行/粘贴）
 * - 持久化：`store-port.ts` 端口 + `services/store/quickcmd.ts`（本地库）
 *
 * 存储取舍：**本轮只做本地库**。云端库 = 再实现一个 QuickCmdStorePort（kind:'cloud'），
 * 服务层与 UI 不需要改动；同步后端接入点见 `configureQuickCmd({ store })`。
 *
 * 执行语义：多行命令**逐行发送**；"粘贴"只返回渲染结果、由渲染层贴到终端或输入框。
 */

import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { AppError, parseInput } from '../../errors'
import type { IpcHandler } from '../../ipc/router'
import { requireSession } from '../session-registry'
import { ParamHistory, type HistoryValue, type ParamHistoryData, type ParamHistoryOptions } from './history'
import {
  matchesPinyin,
  matchItem,
  searchItems,
  type SearchableItem,
} from './search'
import { MemoryQuickCmdStore, type QuickCmdStorePort } from './store-port'
import {
  buildTree,
  cascadeDeleteGroup,
  cascadePreview,
  // 别名：类上也有同名方法，避免读代码时误以为在递归调用自己
  moveCommand as moveCommandInLibrary,
  moveGroup as moveGroupInLibrary,
  nextOrder,
  reorderSiblings,
  type QuickCommandRecord,
  type QuickGroupRecord,
  type QuickLibrary,
  type QuickTree,
} from './tree'
import { parseTemplate, renderLines, renderTemplate, splitLines, templateTags, type TemplateTag } from './template'
import {
  getVariableDef,
  isDynamicVariable,
  listVariablePreviews,
  variablePreview,
  type VariableContext,
  type VariablePreview,
} from './variables'

// ---------------------------------------------------------------------------
// 依赖注入
// ---------------------------------------------------------------------------

export interface QuickCmdDeps {
  store: QuickCmdStorePort
  /** 把文本送到终端会话（执行=逐行；未注入时尝试 session.write） */
  sendToSession?: (sessionId: string, data: string) => Promise<void> | void
  /** 动态变量的取值上下文（时钟/剪贴板/密码/主机信息） */
  variableContext?: () => VariableContext
  now?: () => number
  idFactory?: () => string
  historyOptions?: ParamHistoryOptions
}

let deps: QuickCmdDeps = { store: new MemoryQuickCmdStore() }
let service: QuickCmdService | null = null

/** 应用启动时注入真实依赖（本地库 store + 终端写入 + 变量上下文） */
export function configureQuickCmd(next: QuickCmdDeps): void {
  deps = { ...next }
  service = null // 依赖变了就重建服务（会重新加载库）
}

export function resetQuickCmd(): void {
  deps = { store: new MemoryQuickCmdStore() }
  service = null
}

export function getQuickCmdService(): QuickCmdService {
  if (!service) service = new QuickCmdService(deps)
  return service
}

/** 默认终端写入：中立契约里会话只有 exec，没有 write —— 需要 ssh 服务补一个写入能力 */
async function defaultSendToSession(sessionId: string, data: string): Promise<void> {
  let session
  try {
    session = requireSession(sessionId)
  } catch (err) {
    throw AppError.notConnected(err instanceof Error ? err.message : '会话不存在或已断开')
  }
  const writable = session as unknown as { write?: (d: string) => void }
  if (typeof writable.write !== 'function') {
    throw AppError.unsupported(
      '当前 SSH 会话未暴露终端写入能力，无法执行快速命令（需要 session-registry 的会话提供 write）',
    )
  }
  writable.write(data)
}

// ---------------------------------------------------------------------------
// 服务
// ---------------------------------------------------------------------------

export interface CommandWithPath extends QuickCommandRecord {
  /** 分组路径（面包屑），未分组为空数组 */
  groupPath: string[]
}

export interface RenderOutcome {
  text: string
  lines: string[]
  missingParams: string[]
  /** 命中的动态变量（绿色标签） */
  variables: VariablePreview[]
  /** 模板里的占位符标签（绿=变量 / 蓝=参数） */
  tags: TemplateTag[]
  /** 是否有未闭合的 `${{` */
  hasUnclosed: boolean
}

export class QuickCmdService {
  private readonly store: QuickCmdStorePort
  private readonly history: ParamHistory
  private readonly now: () => number
  private readonly idFactory: () => string
  /** 注入的依赖要留在实例上 —— 直接用模块级 deps 会让"直接 new 出来的实例"拿不到自己的上下文 */
  private readonly options: QuickCmdDeps

  private library: QuickLibrary | null = null

  constructor(options: QuickCmdDeps) {
    this.options = options
    this.store = options.store
    this.now = options.now ?? (() => Date.now())
    this.idFactory = options.idFactory ?? (() => randomUUID())
    this.history = new ParamHistory({ ...(options.historyOptions ?? {}), now: this.now })
  }

  get storeKind(): string {
    return this.store.kind
  }

  /** 载入库与历史（幂等；`reload()` 可强制刷新） */
  private ensureLoaded(): QuickLibrary {
    if (this.library) return this.library
    this.library = this.store.loadLibrary()
    this.history.load(this.store.loadHistory())
    return this.library
  }

  async reload(): Promise<void> {
    this.library = null
    this.ensureLoaded()
  }

  private timestamp(): string {
    return new Date(this.now()).toISOString()
  }

  // -------------------------------------------------------------------------
  // 读
  // -------------------------------------------------------------------------

  list(): { commands: QuickCommandRecord[]; groups: QuickGroupRecord[]; tree: QuickTree } {
    const lib = this.ensureLoaded()
    return { commands: [...lib.commands], groups: [...lib.groups], tree: buildTree(lib) }
  }

  tree(): QuickTree {
    return buildTree(this.ensureLoaded())
  }

  listGroups(): QuickGroupRecord[] {
    return [...this.ensureLoaded().groups]
  }

  getCommand(id: string): QuickCommandRecord | undefined {
    return this.ensureLoaded().commands.find((c) => c.id === id)
  }

  /** 分组路径面包屑（搜索结果展示 "数据库 / MySQL / 备份" 用） */
  groupPathOf(groupId: string | null): string[] {
    const lib = this.ensureLoaded()
    const byId = new Map(lib.groups.map((g) => [g.id, g]))
    const path: string[] = []
    let current = groupId === null ? null : (byId.get(groupId) ?? null)
    const guard = new Set<string>()
    while (current && !guard.has(current.id)) {
      guard.add(current.id)
      path.unshift(current.name)
      current = current.parentId === null ? null : (byId.get(current.parentId) ?? null)
    }
    return path
  }

  /** 搜索：名称精确子串 > 拼音首字母 > 备注；空查询返回全部（按树序） */
  search(query: string): CommandWithPath[] {
    const lib = this.ensureLoaded()
    const items: Array<QuickCommandRecord & SearchableItem> = lib.commands.map((c) => ({ ...c }))
    const matched = searchItems(items, query)
    return matched.map((c) => ({ ...c, groupPath: this.groupPathOf(c.groupId) }))
  }

  /** 变量辅助面板：所有内置变量的说明/格式/**当前值预览** */
  variablePanel(): VariablePreview[] {
    return listVariablePreviews(this.variableContext())
  }

  // -------------------------------------------------------------------------
  // 命令 CRUD
  // -------------------------------------------------------------------------

  saveCommand(input: {
    id?: string
    groupId?: string | null
    name: string
    command: string
    note?: string
  }): QuickCommandRecord {
    const lib = this.ensureLoaded()
    const name = input.name?.trim() ?? ''
    const command = input.command ?? ''
    if (name === '') throw AppError.badRequest('命令名称不能为空')
    if (command.trim() === '') throw AppError.badRequest('命令内容不能为空')
    const groupId = input.groupId ?? null
    if (groupId !== null && !lib.groups.some((g) => g.id === groupId)) {
      throw AppError.notFound(`分组不存在: ${groupId}`)
    }

    const existing = input.id === undefined ? undefined : lib.commands.find((c) => c.id === input.id)
    const record: QuickCommandRecord = existing
      ? {
          ...existing,
          name,
          command,
          groupId,
          ...(input.note === undefined ? {} : { note: input.note }),
          updatedAt: this.timestamp(),
        }
      : {
          id: input.id ?? this.idFactory(),
          groupId,
          name,
          command,
          ...(input.note === undefined ? {} : { note: input.note }),
          order: nextOrder(lib, groupId),
          createdAt: this.timestamp(),
          updatedAt: this.timestamp(),
        }

    lib.commands = existing
      ? lib.commands.map((c) => (c.id === record.id ? record : c))
      : [...lib.commands, record]
    this.store.saveCommand(record)
    return record
  }

  /** 删除命令（支持多选删除，spec §6.2） */
  deleteCommands(ids: readonly string[]): { deleted: number } {
    const lib = this.ensureLoaded()
    const wanted = new Set(ids)
    const existing = lib.commands.filter((c) => wanted.has(c.id))
    lib.commands = lib.commands.filter((c) => !wanted.has(c.id))
    for (const command of existing) this.store.deleteCommand(command.id)
    return { deleted: existing.length }
  }

  /** 移动命令到目标分组（可指定落点） */
  moveCommand(commandId: string, targetGroupId: string | null, index?: number): void {
    const lib = this.ensureLoaded()
    const before = new Map(lib.commands.map((c) => [c.id, c.groupId]))
    const next = moveCommandInLibrary(lib, commandId, targetGroupId, index)
    lib.commands = next.commands
    // 受影响的：移动的那条 + 目标分组里 order 变了的
    const changed = lib.commands.filter((c) => c.groupId === targetGroupId || before.get(c.id) === targetGroupId)
    this.saveCommands(changed)
  }

  // -------------------------------------------------------------------------
  // 分组 CRUD
  // -------------------------------------------------------------------------

  saveGroup(input: { id?: string; parentId?: string | null; name: string }): QuickGroupRecord {
    const lib = this.ensureLoaded()
    const name = input.name?.trim() ?? ''
    if (name === '') throw AppError.badRequest('分组名称不能为空')
    const parentId = input.parentId ?? null
    if (parentId !== null && !lib.groups.some((g) => g.id === parentId)) {
      throw AppError.notFound(`父分组不存在: ${parentId}`)
    }

    const existing = input.id === undefined ? undefined : lib.groups.find((g) => g.id === input.id)
    if (existing && parentId !== null && (parentId === existing.id || this.isDescendant(existing.id, parentId))) {
      throw AppError.badRequest('不能把分组移动到它的子分组之下（会形成环）')
    }

    const record: QuickGroupRecord = existing
      ? { ...existing, name, parentId, updatedAt: this.timestamp() }
      : {
          id: input.id ?? this.idFactory(),
          parentId,
          name,
          order: nextOrder(lib, parentId),
          createdAt: this.timestamp(),
          updatedAt: this.timestamp(),
        }

    lib.groups = existing ? lib.groups.map((g) => (g.id === record.id ? record : g)) : [...lib.groups, record]
    this.store.saveGroup(record)
    return record
  }

  private isDescendant(ancestorId: string, nodeId: string): boolean {
    const lib = this.ensureLoaded()
    const byId = new Map(lib.groups.map((g) => [g.id, g]))
    let current = byId.get(nodeId)?.parentId ?? null
    const guard = new Set<string>()
    while (current !== null && !guard.has(current)) {
      if (current === ancestorId) return true
      guard.add(current)
      current = byId.get(current)?.parentId ?? null
    }
    return false
  }

  /** 删除分组前的提示：将删除多少分组/命令（UI 二次确认） */
  previewGroupDelete(groupId: string): { groups: number; commands: number } {
    return cascadePreview(this.ensureLoaded(), groupId)
  }

  /** 删除分组 → 级联删除子分组与组内命令 */
  deleteGroup(groupId: string): { removedGroups: number; removedCommands: number } {
    const lib = this.ensureLoaded()
    const result = cascadeDeleteGroup(lib, groupId)
    lib.groups = result.library.groups
    lib.commands = result.library.commands
    for (const id of result.removedCommandIds) this.store.deleteCommand(id)
    for (const id of result.removedGroupIds) this.store.deleteGroup(id)
    return { removedGroups: result.removedGroupIds.length, removedCommands: result.removedCommandIds.length }
  }

  moveGroup(groupId: string, newParentId: string | null, index?: number): void {
    const lib = this.ensureLoaded()
    const next = moveGroupInLibrary(lib, groupId, newParentId, index)
    lib.groups = next.groups
    this.saveGroups(lib.groups.filter((g) => g.parentId === newParentId || g.id === groupId))
  }

  /** 拖拽排序持久化：同级按给定顺序重排 */
  reorder(parentId: string | null, orderedIds: readonly string[]): void {
    const lib = this.ensureLoaded()
    const next = reorderSiblings(lib, parentId, orderedIds)
    lib.groups = next.groups
    lib.commands = next.commands
    this.saveGroups(lib.groups.filter((g) => g.parentId === parentId))
    this.saveCommands(lib.commands.filter((c) => c.groupId === parentId))
  }

  // -------------------------------------------------------------------------
  // 渲染 / 执行 / 粘贴
  // -------------------------------------------------------------------------

  /** 解析 + 渲染（不执行）：PREVIEW 区域与参数标签用 */
  render(input: { commandId?: string; command?: string; params?: Record<string, string> }): RenderOutcome {
    const command = this.resolveCommandText(input)
    const parsed = parseTemplate(command)
    const context = this.variableContext()
    const rendered = renderTemplate(command, {
      context,
      params: input.params ?? {},
    })
    return {
      text: rendered.text,
      lines: splitLines(rendered.text),
      missingParams: rendered.missingParams,
      // 预览要按**这个占位符实际用的格式**求值（${{date:YYYYMMDD}} 就显示 20251129）
      variables: parsed.variables.map((token) => {
        const def = getVariableDef(token.name)
        if (def) return variablePreview(def, context, token.format)
        return {
          name: token.name,
          description: token.name,
          format: token.format ?? '-',
          value: '',
          masked: false,
          hasValue: false,
          secret: false,
        }
      }),
      tags: templateTags(parsed),
      hasUnclosed: parsed.hasUnclosed,
    }
  }

  /** 参数填写窗口的数据：历史回填 + 最近值提示 + 变量预览 + 当前渲染 */
  parameterDialog(input: { commandId?: string; command?: string }): {
    parameters: string[]
    /** 预填值（每个参数的最新历史值） */
    prefill: Record<string, string>
    /** 每个参数的最近值（"recent" 提示，按最近使用排序） */
    recent: Record<string, string[]>
    variables: VariablePreview[]
    tags: TemplateTag[]
    preview: string
    missingParams: string[]
  } {
    const command = this.resolveCommandText(input)
    const parsed = parseTemplate(command)
    const names = parsed.parameterNames
    const recent: Record<string, string[]> = {}
    for (const name of names) recent[name] = this.history.recent(name, 5)
    return {
      parameters: names,
      prefill: this.history.prefill(names),
      recent,
      variables: this.variablePanel(),
      tags: templateTags(parsed),
      preview: renderTemplate(command, { context: this.variableContext() }).text,
      missingParams: names,
    }
  }

  /**
   * 执行：渲染 → 记录参数历史 → **逐行发送**到会话。
   * 缺参数直接拒绝（不允许把 `${{x}}` 原样打到终端上）。
   */
  async execute(input: {
    sessionId: string
    commandId?: string
    command?: string
    params?: Record<string, string>
  }): Promise<{ lines: string[]; missingParams: string[] }> {
    const command = this.resolveCommandText(input)
    const params = input.params ?? {}
    const rendered = renderLines(command, { context: this.variableContext(), params })

    if (rendered.missingParams.length > 0) {
      throw AppError.badRequest(`还有参数未填写: ${rendered.missingParams.join('、')}`)
    }
    if (rendered.lines.length === 0) throw AppError.badRequest('命令为空，没有可执行的内容')

    // 只有自定义参数进历史（动态变量由 history 内部再拦一道）
    this.history.recordAll(params)
    this.store.saveHistory(this.history.all())

    const sender = this.options.sendToSession ?? defaultSendToSession
    for (const line of rendered.lines) {
      await sender(input.sessionId, `${line}\n`)
    }
    return { lines: rendered.lines, missingParams: [] }
  }

  /** 粘贴：只渲染，不发送（渲染层贴到终端或输入框） */
  paste(input: { commandId?: string; command?: string; params?: Record<string, string> }): {
    lines: string[]
    text: string
    missingParams: string[]
  } {
    const command = this.resolveCommandText(input)
    const params = input.params ?? {}
    const rendered = renderTemplate(command, { context: this.variableContext(), params })
    return { lines: splitLines(rendered.text), text: rendered.text, missingParams: rendered.missingParams }
  }

  /** 编辑器实时提示：识别到的参数标签（绿=变量/蓝=参数） */
  analyze(command: string): { tags: TemplateTag[]; parameterNames: string[]; hasUnclosed: boolean } {
    const parsed = parseTemplate(command)
    return { tags: templateTags(parsed), parameterNames: parsed.parameterNames, hasUnclosed: parsed.hasUnclosed }
  }

  // -------------------------------------------------------------------------
  // 历史
  // -------------------------------------------------------------------------

  historyAll(): ParamHistoryData {
    this.ensureLoaded()
    return this.history.all()
  }

  historyFor(name: string, limit?: number): string[] {
    this.ensureLoaded()
    return this.history.recent(name, limit)
  }

  clearHistory(name?: string): void {
    this.ensureLoaded()
    this.history.clear(name)
    this.store.saveHistory(this.history.all())
  }

  // -------------------------------------------------------------------------
  // 内部
  // -------------------------------------------------------------------------

  /** 动态变量上下文（实例级注入；未注入则用空上下文） */
  private variableContext(): VariableContext {
    return this.options.variableContext?.() ?? {}
  }

  private resolveCommandText(input: { commandId?: string; command?: string }): string {
    if (input.command !== undefined) return input.command
    if (input.commandId !== undefined) {
      const record = this.getCommand(input.commandId)
      if (!record) throw AppError.notFound(`命令不存在: ${input.commandId}`)
      return record.command
    }
    throw AppError.badRequest('需要 commandId 或 command 之一')
  }

  private saveCommands(commands: readonly QuickCommandRecord[]): void {
    for (const command of commands) this.store.saveCommand(command)
  }

  private saveGroups(groups: readonly QuickGroupRecord[]): void {
    for (const group of groups) this.store.saveGroup(group)
  }
}

// ---------------------------------------------------------------------------
// IPC handler 表（Actions 由 lead 定契约；这里是建议的动作名）
// ---------------------------------------------------------------------------

const idString = z.string().min(1)
const paramMap = z.record(z.string(), z.string())

const saveCommandSchema = z.object({
  id: idString.optional(),
  groupId: z.union([idString, z.null()]).optional(),
  name: z.string().min(1, '命令名称不能为空'),
  command: z.string().min(1, '命令内容不能为空'),
  note: z.string().optional(),
})
const deleteCommandsSchema = z.object({ ids: z.array(idString).min(1) })
const saveGroupSchema = z.object({
  id: idString.optional(),
  parentId: z.union([idString, z.null()]).optional(),
  name: z.string().min(1, '分组名称不能为空'),
})
const groupIdSchema = z.object({ id: idString })
const moveSchema = z.object({
  kind: z.enum(['command', 'group']),
  id: idString,
  /** 命令用 groupId，分组用 parentId；null = 根/顶层 */
  targetId: z.union([idString, z.null()]),
  index: z.number().int().min(0).optional(),
})
const reorderSchema = z.object({ parentId: z.union([idString, z.null()]), orderedIds: z.array(idString) })
const searchSchema = z.object({ query: z.string() })
const renderSchema = z.object({
  commandId: idString.optional(),
  command: z.string().optional(),
  params: paramMap.optional(),
})
const dialogSchema = z.object({ commandId: idString.optional(), command: z.string().optional() })
const executeSchema = z.object({
  sessionId: idString,
  commandId: idString.optional(),
  command: z.string().optional(),
  params: paramMap.optional(),
})
const historySchema = z.object({ name: idString.optional(), limit: z.number().int().min(1).max(50).optional() })

export const quickcmdHandlers: Record<string, IpcHandler> = {
  list: () => getQuickCmdService().list(),
  listGroups: () => getQuickCmdService().listGroups(),
  save: (payload) => getQuickCmdService().saveCommand(parseInput(saveCommandSchema, payload)),
  delete: (payload) => {
    const { ids } = parseInput(deleteCommandsSchema, payload)
    return getQuickCmdService().deleteCommands(ids)
  },
  move: (payload) => {
    const { kind, id, targetId, index } = parseInput(moveSchema, payload)
    const svc = getQuickCmdService()
    if (kind === 'command') svc.moveCommand(id, targetId, index)
    else svc.moveGroup(id, targetId, index)
    return { moved: true }
  },
  reorder: (payload) => {
    const { parentId, orderedIds } = parseInput(reorderSchema, payload)
    getQuickCmdService().reorder(parentId, orderedIds)
    return { reordered: orderedIds.length }
  },
  saveGroup: (payload) => getQuickCmdService().saveGroup(parseInput(saveGroupSchema, payload)),
  deleteGroup: (payload) => {
    const { id } = parseInput(groupIdSchema, payload)
    return getQuickCmdService().deleteGroup(id)
  },
  previewGroupDelete: (payload) => {
    const { id } = parseInput(groupIdSchema, payload)
    return getQuickCmdService().previewGroupDelete(id)
  },
  search: (payload) => {
    const { query } = parseInput(searchSchema, payload)
    return getQuickCmdService().search(query)
  },
  render: (payload) => getQuickCmdService().render(parseInput(renderSchema, payload)),
  parameterDialog: (payload) => getQuickCmdService().parameterDialog(parseInput(dialogSchema, payload)),
  execute: (payload) => getQuickCmdService().execute(parseInput(executeSchema, payload)),
  paste: (payload) => getQuickCmdService().paste(parseInput(renderSchema, payload)),
  analyze: (payload) => {
    const { command } = parseInput(z.object({ command: z.string() }), payload)
    return getQuickCmdService().analyze(command)
  },
  /** 变量辅助面板（含当前值预览） */
  variables: () => getQuickCmdService().variablePanel(),
  /** 历史（回填数据源） */
  history: (payload) => {
    const { name, limit } = parseInput(historySchema, payload ?? {})
    const svc = getQuickCmdService()
    return name === undefined ? svc.historyAll() : { name, values: svc.historyFor(name, limit) }
  },
  clearHistory: (payload) => {
    const { name } = parseInput(historySchema, payload ?? {})
    getQuickCmdService().clearHistory(name)
    return { cleared: name ?? 'all' }
  },
  /** 存储类型（本地库 / 将来的云端库） */
  storage: () => ({ kind: getQuickCmdService().storeKind }),
}

// 供上层/测试使用的类型再导出
export type { QuickCmdStorePort } from './store-port'
export { MemoryQuickCmdStore } from './store-port'
export { isDynamicVariable, matchesPinyin, matchItem }
export type { HistoryValue }
