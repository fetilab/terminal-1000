// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 树视图纯逻辑单测（不需要 DOM）：排序、路径前缀、懒加载缓存、展开/折叠、摊平、方向键。
 *
 * 重点覆盖两类容易出错的边界：
 * 1. 缓存按路径**分段**判定 —— `/ab` 不能当成 `/a` 的后代（前缀误判会误删相邻目录缓存）；
 * 2. 未展开/未加载的目录**不产生行**，展开后未加载只产生一个状态行（按需懒加载的渲染侧证据）。
 */

import { describe, expect, it } from 'vitest'
import {
  ancestorsOf,
  collapsePath,
  dropDir,
  dropSubtree,
  expandPaths,
  flattenTree,
  getDir,
  isSelfOrDescendant,
  sortEntries,
  toggleExpanded,
  treeKeyIntent,
  withDir,
  type DirCache,
  type TreeNode,
} from './treeModel'

interface Entry {
  path: string
  name: string
  type: string
}

function dir(path: string): Entry {
  return { path, name: path.split('/').pop() ?? path, type: 'directory' }
}
function file(path: string): Entry {
  return { path, name: path.split('/').pop() ?? path, type: 'file' }
}

describe('sortEntries', () => {
  it('目录排在文件前，同类按名称本地化排序', () => {
    const out = sortEntries([file('/b.txt'), dir('/zd'), file('/a.txt'), dir('/ad')])
    expect(out.map((e) => e.path)).toEqual(['/ad', '/zd', '/a.txt', '/b.txt'])
  })

  it('不修改入参', () => {
    const input = [file('/b'), file('/a')]
    sortEntries(input)
    expect(input.map((e) => e.path)).toEqual(['/b', '/a'])
  })

  it('空输入不炸', () => {
    expect(sortEntries([])).toEqual([])
  })
})

describe('isSelfOrDescendant 按路径分段判断', () => {
  it('自身与后代为真', () => {
    expect(isSelfOrDescendant('/a', '/a')).toBe(true)
    expect(isSelfOrDescendant('/a/b', '/a')).toBe(true)
    expect(isSelfOrDescendant('/a/b/c', '/a')).toBe(true)
  })

  it('前缀相似的兄弟目录不算后代（这是缓存误删的来源）', () => {
    expect(isSelfOrDescendant('/ab', '/a')).toBe(false)
    expect(isSelfOrDescendant('/a-b', '/a')).toBe(false)
    expect(isSelfOrDescendant('/a', '/ab')).toBe(false)
  })

  it('根目录覆盖所有绝对路径', () => {
    expect(isSelfOrDescendant('/', '/')).toBe(true)
    expect(isSelfOrDescendant('/x/y', '/')).toBe(true)
    expect(isSelfOrDescendant('~', '/')).toBe(false)
  })
})

describe('ancestorsOf', () => {
  it('根与一级目录', () => {
    expect(ancestorsOf('/')).toEqual([])
    expect(ancestorsOf('/a')).toEqual(['/'])
  })

  it('多级目录从根开始列出，不含自身', () => {
    expect(ancestorsOf('/a/b/c')).toEqual(['/', '/a', '/a/b'])
  })

  it('忽略末尾多余的斜杠', () => {
    expect(ancestorsOf('/a/b/')).toEqual(['/', '/a'])
  })

  it('非绝对路径没有可推导的祖先', () => {
    expect(ancestorsOf('~')).toEqual([])
    expect(ancestorsOf('rel/x')).toEqual([])
  })
})

describe('目录缓存', () => {
  const empty: DirCache<Entry> = {}

  it('写入后可读，且原对象不被修改', () => {
    const a = withDir(empty, '/a', [file('/a/x')])
    expect(getDir(a, '/a')?.length).toBe(1)
    expect(getDir(empty, '/a')).toBeUndefined()
  })

  it('dropDir 只删自己', () => {
    const cache = withDir(withDir(withDir(empty, '/a', []), '/a/b', []), '/c', [])
    const next = dropDir(cache, '/a/b')
    expect(getDir(next, '/a/b')).toBeUndefined()
    expect(getDir(next, '/a')).toBeDefined()
    expect(getDir(next, '/c')).toBeDefined()
  })

  it('dropSubtree 删自身与后代，但保留前缀相似的兄弟', () => {
    const cache: DirCache<Entry> = withDir(
      withDir(withDir(withDir(empty, '/a', []), '/a/b', []), '/a/b/c', []), '/ab', [],
    )
    const next = dropSubtree(cache, '/a')
    expect(getDir(next, '/a')).toBeUndefined()
    expect(getDir(next, '/a/b')).toBeUndefined()
    expect(getDir(next, '/a/b/c')).toBeUndefined()
    expect(getDir(next, '/ab')).toBeDefined() // 不能被 "/a" 前缀误删
  })
})

describe('展开状态', () => {
  it('expandPaths 返回新集合，不改原集合', () => {
    const before = new Set<string>()
    const after = expandPaths(before, ['/a', '/b'])
    expect([...after].sort()).toEqual(['/a', '/b'])
    expect(before.size).toBe(0)
  })

  it('collapsePath 只删一个，且保留其子项的展开标记（重新展开时恢复原状）', () => {
    const expanded = new Set(['/a', '/a/b'])
    const collapsed = collapsePath(expanded, '/a')
    expect(collapsed.has('/a')).toBe(false)
    expect(collapsed.has('/a/b')).toBe(true)
  })

  it('toggleExpanded 来回切换', () => {
    const on = toggleExpanded(new Set(), '/a')
    expect(on.has('/a')).toBe(true)
    expect(toggleExpanded(on, '/a').has('/a')).toBe(false)
  })
})

describe('flattenTree', () => {
  const roots = [dir('/home'), file('/readme.txt')]

  it('未展开时只有根一层，且根按列表同一排序', () => {
    const rows = flattenTree<Entry>({ roots, expanded: new Set(), childrenOf: () => undefined })
    expect(rows.map((r) => r.path)).toEqual(['/home', '/readme.txt'])
    expect(rows.map((r) => r.depth)).toEqual([0, 0])
    expect(rows.every((r) => r.kind === 'entry')).toBe(true)
  })

  it('展开但未加载的目录产生一个状态行，且不带条目', () => {
    const rows = flattenTree<Entry>({ roots, expanded: new Set(['/home']), childrenOf: () => undefined })
    expect(rows.map((r) => r.kind)).toEqual(['entry', 'status', 'entry'])
    const status = rows[1]
    expect(status?.status).toBe('loading')
    expect(status?.path).toBe('/home')
    expect(status?.depth).toBe(1)
    expect(status?.entry).toBeNull()
    // 状态行 key 不能与真实路径相同，否则虚拟列表 key 撞车
    expect(rows.map((r) => r.key)).toHaveLength(new Set(rows.map((r) => r.key)).size)
  })

  it('加载失败时状态行带错误原因', () => {
    const rows = flattenTree<Entry>({
      roots,
      expanded: new Set(['/home']),
      childrenOf: () => undefined,
      statusOf: () => ({ status: 'error', message: 'Permission denied' }),
    })
    expect(rows[1]?.status).toBe('error')
    expect(rows[1]?.message).toBe('Permission denied')
  })

  it('展开已缓存的目录时子项被摊平且深度递增；未展开的子目录不再展开', () => {
    const children = [dir('/home/deep'), file('/home/a.txt')]
    const deepChildren = [file('/home/deep/x')]
    const childrenOf = (path: string): Entry[] | undefined =>
      path === '/home' ? children : path === '/home/deep' ? deepChildren : undefined

    const collapsed = flattenTree<Entry>({
      roots,
      expanded: new Set(['/home']),
      childrenOf,
    })
    expect(collapsed.map((r) => r.path)).toEqual([
      '/home', '/home/deep', '/home/a.txt', '/readme.txt',
    ])

    const nested = flattenTree<Entry>({
      roots,
      expanded: new Set(['/home', '/home/deep']),
      childrenOf,
    })
    expect(nested.map((r) => r.path)).toEqual([
      '/home', '/home/deep', '/home/deep/x', '/home/a.txt', '/readme.txt',
    ])
    expect(nested.find((r) => r.path === '/home/deep/x')?.depth).toBe(2)
  })

  it('展开的空目录只有自己一行，不会出现状态行', () => {
    const rows = flattenTree<Entry>({ roots, expanded: new Set(['/home']), childrenOf: () => [] })
    expect(rows.map((r) => r.path)).toEqual(['/home', '/readme.txt'])
  })

  it('目录标记为已展开（供 chevron 与 aria-expanded 使用）', () => {
    const rows = flattenTree<Entry>({ roots, expanded: new Set(['/home']), childrenOf: () => [] })
    const home = rows.find((r) => r.path === '/home')
    expect(home?.isDirectory).toBe(true)
    expect(home?.expanded).toBe(true)
    expect(rows.find((r) => r.path === '/readme.txt')?.isDirectory).toBe(false)
  })

  it('maxDepth 兜底：超过上限的层级不再摊平', () => {
    const childrenOf = (path: string): Entry[] | undefined =>
      path.split('/').filter(Boolean).length > 4 ? [] : [dir(`${path}/d`)]
    const rows = flattenTree<Entry>({
      roots: [dir('/d')],
      expanded: new Set(['/d', '/d/d', '/d/d/d', '/d/d/d/d', '/d/d/d/d/d']),
      childrenOf,
      maxDepth: 3,
    })
    // depth 0..3 各一行；更深的不再产生行
    expect(rows.map((r) => r.depth)).toEqual([0, 1, 2, 3])
  })

  it('树与列表对同一目录给出一致条目（同排序、同顺序）', () => {
    const listing: Entry[] = [file('/z.txt'), dir('/sub'), file('/a.txt'), dir('/abc')]
    const listView = sortEntries(listing).map((e) => e.path)
    const rows = flattenTree<Entry>({
      roots: [dir('/root')],
      expanded: new Set(['/root']),
      childrenOf: (p) => (p === '/root' ? listing : undefined),
    })
    const treeView = rows.filter((r) => r.depth === 1).map((r) => r.path)
    expect(treeView).toEqual(listView)
  })
})

describe('treeKeyIntent', () => {
  const rows: Array<TreeNode<Entry>> = flattenTree<Entry>({
    roots: [dir('/a'), dir('/b'), file('/z.txt')],
    expanded: new Set(['/a']),
    childrenOf: (p) => (p === '/a' ? [file('/a/x'), dir('/a/sub')] : undefined),
  })
  // 行序（子项同样目录优先）：/a, /a/sub, /a/x, /b, /z.txt

  const keys = (): string[] => rows.filter((r) => r.kind === 'entry').map((r) => r.key)

  it('夹具符合预期', () => {
    expect(keys()).toEqual(['/a', '/a/sub', '/a/x', '/b', '/z.txt'])
  })

  it('↓ 向下移动，到末尾不循环', () => {
    expect(treeKeyIntent({ key: 'ArrowDown', rows, activeKey: '/a' })).toEqual({ kind: 'move', key: '/a/sub' })
    expect(treeKeyIntent({ key: 'ArrowDown', rows, activeKey: '/z.txt' })).toEqual({ kind: 'ignore' })
  })

  it('↑ 向上移动，到开头不循环', () => {
    expect(treeKeyIntent({ key: 'ArrowUp', rows, activeKey: '/b' })).toEqual({ kind: 'move', key: '/a/x' })
    expect(treeKeyIntent({ key: 'ArrowUp', rows, activeKey: '/a' })).toEqual({ kind: 'ignore' })
  })

  it('没有活动行时 ↓ 选第一行、↑ 选最后一行', () => {
    expect(treeKeyIntent({ key: 'ArrowDown', rows, activeKey: null })).toEqual({ kind: 'move', key: '/a' })
    expect(treeKeyIntent({ key: 'ArrowUp', rows, activeKey: null })).toEqual({ kind: 'move', key: '/z.txt' })
  })

  it('Home/End 跳到首尾', () => {
    expect(treeKeyIntent({ key: 'Home', rows, activeKey: '/b' })).toEqual({ kind: 'move', key: '/a' })
    expect(treeKeyIntent({ key: 'End', rows, activeKey: '/a' })).toEqual({ kind: 'move', key: '/z.txt' })
  })

  it('→ 展开已折叠目录；已展开则进入第一个子项；文件上无动作', () => {
    expect(treeKeyIntent({ key: 'ArrowRight', rows, activeKey: '/b' })).toEqual({ kind: 'expand', path: '/b' })
    expect(treeKeyIntent({ key: 'ArrowRight', rows, activeKey: '/a' })).toEqual({ kind: 'move', key: '/a/sub' })
    expect(treeKeyIntent({ key: 'ArrowRight', rows, activeKey: '/z.txt' })).toEqual({ kind: 'ignore' })
  })

  it('← 折叠已展开目录；已折叠则跳到父项；根层无父项时不动作', () => {
    expect(treeKeyIntent({ key: 'ArrowLeft', rows, activeKey: '/a' })).toEqual({ kind: 'collapse', path: '/a' })
    expect(treeKeyIntent({ key: 'ArrowLeft', rows, activeKey: '/a/x' })).toEqual({ kind: 'move', key: '/a' })
    expect(treeKeyIntent({ key: 'ArrowLeft', rows, activeKey: '/b' })).toEqual({ kind: 'ignore' })
  })

  it('Enter 打开目录 / 文件不误触发', () => {
    expect(treeKeyIntent({ key: 'Enter', rows, activeKey: '/a' })).toEqual({
      kind: 'activate', key: '/a', path: '/a', isDirectory: true,
    })
    expect(treeKeyIntent({ key: 'Enter', rows, activeKey: '/z.txt' })).toEqual({
      kind: 'activate', key: '/z.txt', path: '/z.txt', isDirectory: false,
    })
  })

  it('Space 切换目录展开，文件上无动作', () => {
    expect(treeKeyIntent({ key: ' ', rows, activeKey: '/a' })).toEqual({ kind: 'collapse', path: '/a' })
    expect(treeKeyIntent({ key: ' ', rows, activeKey: '/b' })).toEqual({ kind: 'expand', path: '/b' })
    expect(treeKeyIntent({ key: ' ', rows, activeKey: '/z.txt' })).toEqual({ kind: 'ignore' })
  })

  it('Ctrl/Cmd+A 全选，单独的 a 不处理（不能抢终端输入）', () => {
    expect(treeKeyIntent({ key: 'a', ctrlKey: true, rows, activeKey: '/a' })).toEqual({ kind: 'selectAll' })
    expect(treeKeyIntent({ key: 'a', metaKey: true, rows, activeKey: '/a' })).toEqual({ kind: 'selectAll' })
    expect(treeKeyIntent({ key: 'a', rows, activeKey: '/a' })).toEqual({ kind: 'ignore' })
  })

  it('Esc 清除选择', () => {
    expect(treeKeyIntent({ key: 'Escape', rows, activeKey: '/a' })).toEqual({ kind: 'clear' })
  })

  it('不相关按键一律 ignore（调用方因此不会 preventDefault，终端快捷键不受影响）', () => {
    for (const key of ['c', 'Tab', 'F5', 'PageDown', '1']) {
      expect(treeKeyIntent({ key, rows, activeKey: '/a' })).toEqual({ kind: 'ignore' })
    }
  })

  it('状态行不参与方向键移动', () => {
    const loadingRows = flattenTree<Entry>({
      roots: [dir('/a'), dir('/b')],
      expanded: new Set(['/a']),
      childrenOf: () => undefined,
    })
    // 行序：/a, /a::status, /b
    expect(treeKeyIntent({ key: 'ArrowDown', rows: loadingRows, activeKey: '/a' })).toEqual({
      kind: 'move', key: '/b',
    })
  })
})
