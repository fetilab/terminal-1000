// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 快速命令的分组树模型与**纯操作**（spec §6.2）。
 *
 * 这些函数不碰存储、不碰时间，输入输出都是普通对象，
 * 因此"多级嵌套 / 级联删除 / 拖拽移动排序"都能被确定性地单测。
 * 持久化由 store 适配层负责（见 services/store/quickcmd.ts）。
 */

import { AppError } from '../../errors'
import { pinyinInitials } from './search'

export interface QuickCommandRecord {
  id: string
  /** null = 位于根（未分组） */
  groupId: string | null
  name: string
  /** 支持多行；执行时逐行发送 */
  command: string
  note?: string
  /** 同级排序，越小越靠前 */
  order: number
  createdAt: string
  updatedAt: string
}

export interface QuickGroupRecord {
  id: string
  /** null = 顶层分组 */
  parentId: string | null
  name: string
  order: number
  createdAt: string
  updatedAt: string
}

export interface QuickLibrary {
  commands: QuickCommandRecord[]
  groups: QuickGroupRecord[]
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

export interface GroupNode {
  kind: 'group'
  id: string
  name: string
  order: number
  parentId: string | null
  children: QuickNode[]
  /** 该组（含子组）下的命令总数，UI 用来显示计数 */
  commandCount: number
}

export type QuickNode = GroupNode | CommandNode

export interface QuickTree {
  roots: QuickNode[]
  totalCommands: number
  totalGroups: number
}

/**
 * 同级排序：order 优先（拖拽结果不可被覆盖），order 相同按**拼音首字母**再按名字。
 *
 * 为什么不用 `localeCompare('zh-Hans-CN')`：它依赖运行时 ICU 数据，
 * 同一条数据在不同环境可能排出不同顺序（测试会飘、跨机表现不一致）。
 * 拼音键是纯函数，结果稳定，且对中文用户更符合直觉。
 */
function sortKey(name: string): string {
  return `${pinyinInitials(name)}\u0000${name}`.toLowerCase()
}

function byOrderThenName(a: { order: number; name: string }, b: { order: number; name: string }): number {
  if (a.order !== b.order) return a.order - b.order
  const ka = sortKey(a.name)
  const kb = sortKey(b.name)
  if (ka !== kb) return ka < kb ? -1 : 1
  return 0
}

/**
 * 构建分组树。
 * 防御性：父分组不存在的"孤儿"节点挂到根，不会整棵树消失。
 */
export function buildTree(library: QuickLibrary): QuickTree {
  const groupIds = new Set(library.groups.map((g) => g.id))

  const nodeById = new Map<string, GroupNode>()
  const roots: QuickNode[] = []

  for (const group of library.groups) {
    nodeById.set(group.id, {
      kind: 'group',
      id: group.id,
      name: group.name,
      order: group.order,
      parentId: group.parentId,
      children: [],
      commandCount: 0,
    })
  }

  for (const node of nodeById.values()) {
    const parentId = node.parentId
    if (parentId === null || !groupIds.has(parentId)) {
      roots.push(node)
      node.parentId = parentId === null ? null : null // 孤儿按顶层处理
      continue
    }
    nodeById.get(parentId)?.children.push(node)
  }

  for (const command of library.commands) {
    const node: CommandNode = {
      kind: 'command',
      id: command.id,
      name: command.name,
      command: command.command,
      ...(command.note === undefined ? {} : { note: command.note }),
      order: command.order,
      groupId: command.groupId,
    }
    const parent = command.groupId === null ? undefined : nodeById.get(command.groupId)
    if (parent) parent.children.push(node)
    else roots.push(node)
  }

  const sortRecursive = (node: GroupNode): number => {
    node.children.sort(byOrderThenName)
    let count = 0
    for (const child of node.children) {
      if (child.kind === 'group') count += sortRecursive(child)
      else count += 1
    }
    node.commandCount = count
    return count
  }
  for (const node of roots) if (node.kind === 'group') sortRecursive(node)
  roots.sort(byOrderThenName)

  return { roots, totalCommands: library.commands.length, totalGroups: library.groups.length }
}

/** 该分组自身 + 所有后代分组的 id */
export function descendantGroupIds(groups: readonly QuickGroupRecord[], groupId: string): string[] {
  const result: string[] = []
  const stack = [groupId]
  const childrenOf = new Map<string | null, string[]>()
  for (const g of groups) {
    const key = g.parentId
    if (!childrenOf.has(key)) childrenOf.set(key, [])
    childrenOf.get(key)?.push(g.id)
  }
  const seen = new Set<string>()
  while (stack.length > 0) {
    const id = stack.pop()
    if (id === undefined || seen.has(id)) continue
    seen.add(id)
    result.push(id)
    for (const child of childrenOf.get(id) ?? []) stack.push(child)
  }
  return result
}

/** 是否是自己的祖先（移动分组时防止成环） */
export function isAncestor(groups: readonly QuickGroupRecord[], ancestorId: string, nodeId: string): boolean {
  let current: string | null = nodeId
  const byId = new Map(groups.map((g) => [g.id, g]))
  const guard = new Set<string>()
  while (current !== null) {
    if (guard.has(current)) return false // 数据损坏时不要死循环
    guard.add(current)
    const node = byId.get(current)
    if (!node) return false
    if (node.parentId === ancestorId) return true
    current = node.parentId
  }
  return false
}

export interface CascadeDeleteResult {
  library: QuickLibrary
  removedGroupIds: string[]
  removedCommandIds: string[]
}

/**
 * 删除分组 → **级联删除所有子分组与组内命令**（spec §6.2 明确要求，UI 需二次确认）。
 */
export function cascadeDeleteGroup(library: QuickLibrary, groupId: string): CascadeDeleteResult {
  if (!library.groups.some((g) => g.id === groupId)) {
    throw AppError.notFound(`分组不存在: ${groupId}`)
  }
  const doomedGroups = new Set(descendantGroupIds(library.groups, groupId))
  const removedCommandIds = library.commands
    .filter((c) => c.groupId !== null && doomedGroups.has(c.groupId))
    .map((c) => c.id)

  return {
    library: {
      groups: library.groups.filter((g) => !doomedGroups.has(g.id)),
      commands: library.commands.filter((c) => !removedCommandIds.includes(c.id)),
    },
    removedGroupIds: [...doomedGroups],
    removedCommandIds,
  }
}

function normalizeOrders<T extends { id: string; order: number }>(
  items: readonly T[],
  orderedIds: readonly string[],
): T[] {
  const rank = new Map(orderedIds.map((id, index) => [id, index]))
  return items.map((item) => {
    const next = rank.get(item.id)
    return next === undefined ? item : { ...item, order: next }
  })
}

/**
 * 拖拽排序持久化：把某个同级列表按给定顺序重排（order 重置为 0..n-1）。
 * 不在列表里的节点保持不变（避免把别的分组顺序搅乱）。
 */
export function reorderSiblings(
  library: QuickLibrary,
  parentId: string | null,
  orderedIds: readonly string[],
): QuickLibrary {
  const groups = library.groups.filter((g) => g.parentId === parentId)
  const commands = library.commands.filter((c) => c.groupId === parentId)

  const known = new Set([...groups.map((g) => g.id), ...commands.map((c) => c.id)])
  for (const id of orderedIds) {
    if (!known.has(id)) {
      throw AppError.badRequest(`节点 ${id} 不在该分组下，无法排序`)
    }
  }

  return {
    groups: normalizeOrders(library.groups, orderedIds),
    commands: normalizeOrders(library.commands, orderedIds),
  }
}

/** 把命令移动到目标分组（null = 根），可指定落点下标 */
export function moveCommand(
  library: QuickLibrary,
  commandId: string,
  targetGroupId: string | null,
  index?: number,
): QuickLibrary {
  const command = library.commands.find((c) => c.id === commandId)
  if (!command) throw AppError.notFound(`命令不存在: ${commandId}`)
  if (targetGroupId !== null && !library.groups.some((g) => g.id === targetGroupId)) {
    throw AppError.notFound(`分组不存在: ${targetGroupId}`)
  }

  const siblings = library.commands
    .filter((c) => c.groupId === targetGroupId && c.id !== commandId)
    .sort(byOrderThenName)
    .map((c) => c.id)

  const at = index === undefined ? siblings.length : Math.min(Math.max(index, 0), siblings.length)
  siblings.splice(at, 0, commandId)

  const commands = library.commands.map((c) => (c.id === commandId ? { ...c, groupId: targetGroupId } : c))
  return { groups: library.groups, commands: normalizeOrders(commands, siblings) }
}

/** 把分组移动到新的父分组（null = 顶层），可指定落点下标 */
export function moveGroup(
  library: QuickLibrary,
  groupId: string,
  newParentId: string | null,
  index?: number,
): QuickLibrary {
  const group = library.groups.find((g) => g.id === groupId)
  if (!group) throw AppError.notFound(`分组不存在: ${groupId}`)
  if (newParentId !== null && !library.groups.some((g) => g.id === newParentId)) {
    throw AppError.notFound(`分组不存在: ${newParentId}`)
  }
  if (newParentId === groupId) {
    throw AppError.badRequest('不能把分组移动到自身之下')
  }
  if (newParentId !== null && isAncestor(library.groups, groupId, newParentId)) {
    throw AppError.badRequest('不能把分组移动到它的子分组之下（会形成环）')
  }

  const siblings = library.groups
    .filter((g) => g.parentId === newParentId && g.id !== groupId)
    .sort(byOrderThenName)
    .map((g) => g.id)
  const at = index === undefined ? siblings.length : Math.min(Math.max(index, 0), siblings.length)
  siblings.splice(at, 0, groupId)

  const groups = library.groups.map((g) => (g.id === groupId ? { ...g, parentId: newParentId } : g))
  return { groups: normalizeOrders(groups, siblings), commands: library.commands }
}

/** 同级下一个可用 order */
export function nextOrder(library: QuickLibrary, parentId: string | null): number {
  const orders = [
    ...library.groups.filter((g) => g.parentId === parentId).map((g) => g.order),
    ...library.commands.filter((c) => c.groupId === parentId).map((c) => c.order),
  ]
  return orders.length === 0 ? 0 : Math.max(...orders) + 1
}

/** 统计（删除分组前给用户看"将删除 N 条命令"） */
export function cascadePreview(library: QuickLibrary, groupId: string): { groups: number; commands: number } {
  const doomed = new Set(descendantGroupIds(library.groups, groupId))
  return {
    groups: doomed.size,
    commands: library.commands.filter((c) => c.groupId !== null && doomed.has(c.groupId)).length,
  }
}
