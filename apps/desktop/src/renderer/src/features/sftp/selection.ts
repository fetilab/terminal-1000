// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * SFTP 列表的**多选状态机**（纯函数，不依赖 React / DOM）。
 *
 * 交互语义对齐文件管理器（也是用户肌肉记忆）：
 * - 单击：只选它，并把它设为「锚点」
 * - Ctrl/Cmd + 单击：切换该项的选中态，锚点移到它
 * - Shift + 单击：从锚点到该项**连选**（替换原有选择）
 * - Ctrl/Cmd + Shift + 单击：连选并**并入**原有选择
 * - Ctrl/Cmd + A：全选（由调用方保证只在列表聚焦时触发）
 * - Esc / 空白处单击：清空
 *
 * 为什么单独抽出来：这些边界（锚点丢失、目标不在列表里、连选方向）
 * 在 UI 里很难穷举，但用纯函数几行就能测明白。
 */

export interface SelectionState {
  /** 已选中的 id（保持顺序，便于稳定渲染与断言） */
  ids: string[]
  /** 连选的锚点（Shift 单击的起点） */
  anchor: string | null
}

export const EMPTY_SELECTION: SelectionState = { ids: [], anchor: null }

export interface ClickMods {
  ctrl?: boolean
  meta?: boolean
  shift?: boolean
}

function unique(ids: readonly string[]): string[] {
  return [...new Set(ids)]
}

/**
 * 处理一次单击。
 * @param orderedIds 当前列表的**可见顺序**（连选要按这个顺序算范围）
 */
export function clickSelection(
  state: SelectionState,
  orderedIds: readonly string[],
  id: string,
  mods: ClickMods = {},
): SelectionState {
  const additive = mods.ctrl === true || mods.meta === true

  if (mods.shift === true) {
    const anchor = state.anchor ?? id
    const from = orderedIds.indexOf(anchor)
    const to = orderedIds.indexOf(id)
    // 目标或锚点不在当前列表（例如翻目录后锚点失效）→ 退化成单选
    if (from === -1 || to === -1) return { ids: [id], anchor: id }
    const [start, end] = from <= to ? [from, to] : [to, from]
    const range = orderedIds.slice(start, end + 1)
    return {
      ids: additive ? unique([...state.ids, ...range]) : unique(range),
      // 连选不改锚点，用户才能反复调整范围
      anchor,
    }
  }

  if (additive) {
    const has = state.ids.includes(id)
    const ids = has ? state.ids.filter((x) => x !== id) : [...state.ids, id]
    return { ids, anchor: id }
  }

  return { ids: [id], anchor: id }
}

export function selectAll(orderedIds: readonly string[]): SelectionState {
  return { ids: unique(orderedIds), anchor: orderedIds[0] ?? null }
}

export function clearSelection(): SelectionState {
  return EMPTY_SELECTION
}

export function isSelected(state: SelectionState, id: string): boolean {
  return state.ids.includes(id)
}

/** 把选中 id 映射回条目（保持列表顺序），并丢掉已不存在的 id */
export function selectedEntries<T extends { path: string }>(
  entries: readonly T[],
  state: SelectionState,
): T[] {
  const wanted = new Set(state.ids)
  return entries.filter((e) => wanted.has(e.path))
}

/** 选中项里的目录数（删除/权限确认文案要用"其中 N 个目录会被递归删除"） */
export function countDirectories(entries: readonly { type: string }[]): number {
  return entries.filter((e) => e.type === 'directory').length
}
