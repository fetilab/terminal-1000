// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * SFTP 树视图的**纯逻辑**（不依赖 React / DOM）。
 *
 * 为什么单独一层：树的展开/折叠、懒加载缓存、方向键导航这几处边界
 * （折叠后子节点是否保留、缓存按路径前缀判定、深层目录的祖先链）
 * 在组件里很难穷举，抽成纯函数几行就能测明白 —— 与 selection.ts / batchOps.ts 同一套路。
 *
 * 与列表视图的一致性靠**共用** `sortEntries` 保证：树和列表对同一目录渲染的是
 * 同一个排序结果，不允许各排一套。
 *
 * 目录缓存刻意做成不可变对象（而不是 Map）：React 状态下复制一层很便宜
 * （条目数是引用拷贝），且不需要额外的版本号来触发重渲染。
 */

/** 树/列表排序所需的最小结构（只依赖远端条目的公开字段） */
export interface TreeEntryLike {
  path: string
  name: string
  type: string
}

/**
 * 目录排序：**目录永远在文件前面**，再按名称本地化比较。
 * 列表视图与树视图都走这一个函数，避免两套排序口径。
 */
export function sortEntries<T extends { name: string; type: string }>(entries: readonly T[]): T[] {
  return entries.slice().sort((a, b) => {
    const da = a.type === 'directory' ? 0 : 1
    const db = b.type === 'directory' ? 0 : 1
    if (da !== db) return da - db
    return a.name.localeCompare(b.name, 'zh-CN')
  })
}

/**
 * `path` 是否等于 `ancestor` 或位于其下。
 *
 * **按路径分段判断**，不能只做 startsWith：`/ab` 不是 `/a` 的后代，
 * 用它来清理缓存时前缀误判会让相邻目录的缓存被误删。
 */
export function isSelfOrDescendant(path: string, ancestor: string): boolean {
  if (path === ancestor) return true
  if (ancestor === '/') return path.startsWith('/')
  const base = ancestor.endsWith('/') ? ancestor.slice(0, -1) : ancestor
  if (base === '') return false
  return path.startsWith(`${base}/`)
}

/**
 * 绝对路径的祖先链（不含自身，从根开始）。
 * 非绝对路径（如 `~`）没有可推导的祖先，返回空数组。
 */
export function ancestorsOf(path: string): string[] {
  if (!path.startsWith('/')) return []
  const parts = path.split('/').filter(Boolean)
  if (parts.length === 0) return []
  const out: string[] = ['/']
  let acc = ''
  for (let i = 0; i < parts.length - 1; i++) {
    acc += `/${parts[i]}`
    out.push(acc)
  }
  return out
}

/* ── 懒加载缓存 ─────────────────────────────────────── */

/** path → 该目录已缓存的子项；缺键 = 尚未加载 */
export type DirCache<T> = Readonly<Record<string, readonly T[] | undefined>>

export function withDir<T>(cache: DirCache<T>, path: string, entries: readonly T[]): DirCache<T> {
  return { ...cache, [path]: entries }
}

export function getDir<T>(cache: DirCache<T>, path: string): readonly T[] | undefined {
  return cache[path]
}

export function dropDir<T>(cache: DirCache<T>, path: string): DirCache<T> {
  if (cache[path] === undefined) return cache
  const next: Record<string, readonly T[] | undefined> = { ...cache }
  delete next[path]
  return next
}

/**
 * 丢弃 `dirPath` 自身与其全部后代的缓存。
 * 目录被重命名/删除/过滤条件变化后必须调用，否则树里会残留已不存在的旧路径。
 */
export function dropSubtree<T>(cache: DirCache<T>, dirPath: string): DirCache<T> {
  const kept: Record<string, readonly T[] | undefined> = {}
  for (const key of Object.keys(cache)) {
    if (!isSelfOrDescendant(key, dirPath)) kept[key] = cache[key]
  }
  return kept
}

/* ── 展开状态 ───────────────────────────────────────── */

export function expandPaths(expanded: ReadonlySet<string>, paths: readonly string[]): Set<string> {
  if (paths.length === 0) return new Set(expanded)
  const next = new Set(expanded)
  for (const p of paths) next.add(p)
  return next
}

export function collapsePath(expanded: ReadonlySet<string>, path: string): Set<string> {
  if (!expanded.has(path)) return new Set(expanded)
  const next = new Set(expanded)
  next.delete(path)
  return next
}

export function toggleExpanded(expanded: ReadonlySet<string>, path: string): Set<string> {
  return expanded.has(path) ? collapsePath(expanded, path) : expandPaths(expanded, [path])
}

/* ── 行模型 ─────────────────────────────────────────── */

export type TreeNodeStatus = 'loading' | 'error'

export interface TreeNode<T> {
  /** 稳定 key：条目行 = path；状态行 = path + NUL 前缀（不会与真实路径撞） */
  key: string
  kind: 'entry' | 'status'
  /** 条目行 = 条目路径；状态行 = 所属目录路径 */
  path: string
  depth: number
  isDirectory: boolean
  /** 目录是否已展开（状态行为 false） */
  expanded: boolean
  /** 条目行的原始条目；状态行为 null */
  entry: T | null
  status?: TreeNodeStatus
  message?: string
}

export interface FlattenTreeOptions<T extends TreeEntryLike> {
  roots: readonly T[]
  expanded: ReadonlySet<string>
  /** 已缓存的子项；`undefined` 表示尚未加载（会生成一个状态行） */
  childrenOf: (path: string) => readonly T[] | undefined
  /** 尚未加载时的状态；缺省按「读取中」处理 */
  statusOf?: (path: string) => { status: TreeNodeStatus; message?: string } | undefined
  /** 递归深度上限，防御性兜底（正常远端目录不会有这种深度） */
  maxDepth?: number
}

const STATUS_SUFFIX = '\u0000status'

/**
 * 把「根条目 + 展开集合 + 目录缓存」摊平成可渲染的行列表。
 *
 * 只展开 `expanded` 里的目录，其余子树不访问缓存也不排序 —— 这是"按需懒加载"
 * 在渲染层的体现：没展开的深层目录不产生任何行。
 */
export function flattenTree<T extends TreeEntryLike>(options: FlattenTreeOptions<T>): Array<TreeNode<T>> {
  const maxDepth = options.maxDepth ?? 64
  const out: Array<TreeNode<T>> = []

  const walk = (items: readonly T[], depth: number): void => {
    for (const entry of sortEntries(items)) {
      const isDirectory = entry.type === 'directory'
      const expanded = isDirectory && options.expanded.has(entry.path)
      out.push({
        key: entry.path,
        kind: 'entry',
        path: entry.path,
        depth,
        isDirectory,
        expanded,
        entry,
      })
      if (!expanded || depth + 1 > maxDepth) continue

      const children = options.childrenOf(entry.path)
      if (children === undefined) {
        const state = options.statusOf?.(entry.path)
        const status = state?.status ?? 'loading'
        out.push({
          key: `${entry.path}${STATUS_SUFFIX}`,
          kind: 'status',
          path: entry.path,
          depth: depth + 1,
          isDirectory: false,
          expanded: false,
          entry: null,
          status,
          ...(state?.message === undefined ? {} : { message: state.message }),
        })
        continue
      }
      walk(children, depth + 1)
    }
  }

  walk(options.roots, 0)
  return out
}

/* ── 键盘导航 ───────────────────────────────────────── */

export interface TreeKeyContext<T> {
  key: string
  ctrlKey?: boolean
  metaKey?: boolean
  shiftKey?: boolean
  rows: readonly TreeNode<T>[]
  activeKey: string | null
}

export type TreeKeyIntent<T> =
  | { kind: 'ignore' }
  | { kind: 'move'; key: string }
  | { kind: 'expand'; path: string }
  | { kind: 'collapse'; path: string }
  | { kind: 'activate'; key: string; path: string; isDirectory: boolean }
  | { kind: 'selectAll' }
  | { kind: 'clear' }

/**
 * 把一次按键翻译成意图（组件只负责执行，不再各自判断方向键语义）。
 *
 * 规则对齐 ARIA tree 与文件管理器直觉：
 * - ↑/↓ 在**可选中行**之间移动（状态行跳过），到边界不循环
 * - → 展开已折叠目录；已展开则进入第一个子项
 * - ← 折叠已展开目录；否则跳到父项
 * - Enter 打开（目录）／无动作（文件，避免误触发编辑器）
 * - Space 切换目录展开，Ctrl/Cmd+A 全选，Esc 清除
 * - 其余按键一律 `ignore`，**不 preventDefault**，不干扰终端快捷键
 */
export function treeKeyIntent<T>(ctx: TreeKeyContext<T>): TreeKeyIntent<T> {
  const entries = ctx.rows.filter((r) => r.kind === 'entry')
  const index = ctx.activeKey === null ? -1 : entries.findIndex((r) => r.key === ctx.activeKey)
  const active = index >= 0 ? entries[index] : undefined
  const additive = ctx.ctrlKey === true || ctx.metaKey === true

  switch (ctx.key) {
    case 'ArrowDown':
    case 'ArrowUp': {
      if (entries.length === 0) return { kind: 'ignore' }
      let target: TreeNode<T> | undefined
      if (index < 0) {
        target = ctx.key === 'ArrowDown' ? entries[0] : entries[entries.length - 1]
      } else {
        const next = ctx.key === 'ArrowDown' ? index + 1 : index - 1
        target = entries[Math.min(Math.max(next, 0), entries.length - 1)]
      }
      if (!target || target.key === ctx.activeKey) return { kind: 'ignore' }
      return { kind: 'move', key: target.key }
    }

    case 'Home':
    case 'End': {
      if (entries.length === 0) return { kind: 'ignore' }
      const target = ctx.key === 'Home' ? entries[0] : entries[entries.length - 1]
      if (!target || target.key === ctx.activeKey) return { kind: 'ignore' }
      return { kind: 'move', key: target.key }
    }

    case 'ArrowRight': {
      if (!active || !active.isDirectory) return { kind: 'ignore' }
      if (!active.expanded) return { kind: 'expand', path: active.path }
      // 已展开：进入第一个子项（若有）
      const child = entries.slice(index + 1).find((r) => r.depth > active.depth)
      return child ? { kind: 'move', key: child.key } : { kind: 'ignore' }
    }

    case 'ArrowLeft': {
      if (!active) return { kind: 'ignore' }
      if (active.isDirectory && active.expanded) return { kind: 'collapse', path: active.path }
      let parent: TreeNode<T> | undefined
      for (let i = index - 1; i >= 0; i--) {
        const row = entries[i]
        if (row && row.depth < active.depth) {
          parent = row
          break
        }
      }
      if (!parent) return { kind: 'ignore' }
      return { kind: 'move', key: parent.key }
    }

    case 'Enter':
    case 'Return':
      return active
        ? { kind: 'activate', key: active.key, path: active.path, isDirectory: active.isDirectory }
        : { kind: 'ignore' }

    case ' ':
      if (!active || !active.isDirectory) return { kind: 'ignore' }
      return active.expanded
        ? { kind: 'collapse', path: active.path }
        : { kind: 'expand', path: active.path }

    case 'a':
    case 'A':
      return additive ? { kind: 'selectAll' } : { kind: 'ignore' }

    case 'Escape':
      return { kind: 'clear' }

    default:
      return { kind: 'ignore' }
  }
}
