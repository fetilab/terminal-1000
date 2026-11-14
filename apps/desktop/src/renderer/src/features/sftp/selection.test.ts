// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 多选状态机单测（纯函数，不需要 DOM）。
 * 覆盖单击 / Ctrl 加选 / Shift 连选 / 锚点失效 / 全选 / 清除。
 */

import { describe, expect, it } from 'vitest'
import {
  clickSelection,
  clearSelection,
  countDirectories,
  EMPTY_SELECTION,
  isSelected,
  selectAll,
  selectedEntries,
  type SelectionState,
} from './selection'

const ORDER = ['/a', '/b', '/c', '/d', '/e']

describe('单击', () => {
  it('普通单击：只选它并设为锚点', () => {
    const s = clickSelection(EMPTY_SELECTION, ORDER, '/c')
    expect(s).toEqual({ ids: ['/c'], anchor: '/c' })
  })

  it('普通单击会替换掉之前的多选', () => {
    const prev: SelectionState = { ids: ['/a', '/b'], anchor: '/b' }
    expect(clickSelection(prev, ORDER, '/d')).toEqual({ ids: ['/d'], anchor: '/d' })
  })
})

describe('Ctrl/Cmd 加选', () => {
  it('加选未选中的项', () => {
    let s = clickSelection(EMPTY_SELECTION, ORDER, '/a')
    s = clickSelection(s, ORDER, '/c', { ctrl: true })
    expect(s.ids).toEqual(['/a', '/c'])
    expect(s.anchor).toBe('/c')
  })

  it('再次 Ctrl 点击取消该项', () => {
    let s: SelectionState = { ids: ['/a', '/c'], anchor: '/c' }
    s = clickSelection(s, ORDER, '/a', { ctrl: true })
    expect(s.ids).toEqual(['/c'])
  })

  it('metaKey（macOS Cmd）等价于 ctrl', () => {
    const s = clickSelection({ ids: ['/a'], anchor: '/a' }, ORDER, '/b', { meta: true })
    expect(s.ids).toEqual(['/a', '/b'])
  })
})

describe('Shift 连选', () => {
  it('从锚点向后连选（替换原有选择）', () => {
    const s = clickSelection({ ids: ['/b'], anchor: '/b' }, ORDER, '/d', { shift: true })
    expect(s.ids).toEqual(['/b', '/c', '/d'])
    expect(s.anchor).toBe('/b') // 连选不改锚点，便于反复调整范围
  })

  it('从锚点向前连选（反向也算对）', () => {
    const s = clickSelection({ ids: ['/d'], anchor: '/d' }, ORDER, '/b', { shift: true })
    expect(s.ids).toEqual(['/b', '/c', '/d'])
  })

  it('Ctrl+Shift 连选并并入原有选择', () => {
    const s = clickSelection({ ids: ['/a'], anchor: '/c' }, ORDER, '/d', { shift: true, ctrl: true })
    expect(s.ids).toEqual(['/a', '/c', '/d'])
  })

  it('没有锚点时退化成单选', () => {
    const s = clickSelection(EMPTY_SELECTION, ORDER, '/c', { shift: true })
    expect(s).toEqual({ ids: ['/c'], anchor: '/c' })
  })

  it('锚点已不在当前列表（换目录后）退化成单选，不会选错一片', () => {
    const s = clickSelection({ ids: ['/gone'], anchor: '/gone' }, ORDER, '/c', { shift: true })
    expect(s).toEqual({ ids: ['/c'], anchor: '/c' })
  })

  it('连选结果按列表顺序给出，不受点击顺序影响', () => {
    let s = clickSelection(EMPTY_SELECTION, ORDER, '/e')
    s = clickSelection(s, ORDER, '/c', { shift: true })
    expect(s.ids).toEqual(['/c', '/d', '/e'])
  })
})

describe('全选与清除', () => {
  it('全选选中所有可见项，锚点为第一项', () => {
    expect(selectAll(ORDER)).toEqual({ ids: ORDER, anchor: '/a' })
  })

  it('空列表全选不炸', () => {
    expect(selectAll([])).toEqual({ ids: [], anchor: null })
  })

  it('清除回到空状态', () => {
    expect(clearSelection()).toEqual(EMPTY_SELECTION)
  })
})

describe('派生查询', () => {
  const entries = [
    { path: '/dir', name: 'dir', type: 'directory' },
    { path: '/a', name: 'a', type: 'file' },
    { path: '/b', name: 'b', type: 'file' },
  ]

  it('isSelected', () => {
    expect(isSelected({ ids: ['/a'], anchor: '/a' }, '/a')).toBe(true)
    expect(isSelected({ ids: ['/a'], anchor: '/a' }, '/b')).toBe(false)
  })

  it('selectedEntries 按列表顺序返回，并丢掉已消失的 path', () => {
    const picked = selectedEntries(entries, { ids: ['/b', '/gone', '/dir'], anchor: null })
    expect(picked.map((e) => e.path)).toEqual(['/dir', '/b'])
  })

  it('countDirectories 用于"其中 N 个目录会被递归删除"的文案', () => {
    expect(countDirectories(selectedEntries(entries, { ids: ['/dir', '/a'], anchor: null }))).toBe(1)
    expect(countDirectories([])).toBe(0)
  })
})
