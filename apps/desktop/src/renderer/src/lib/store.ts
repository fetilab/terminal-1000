// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 全局状态（自研，零依赖）。
 *
 * 为什么不用 zustand/redux：这里只有「一个应用级状态树 + 若干派生视图」，
 * 用 `useSyncExternalStore` + 选择器就能拿到同样的细粒度更新能力，
 * 而且不增加首屏体积（性能目标里渲染层首屏是有预算的）。
 *
 * 三条纪律：
 * 1. **高频数据不进 store**。SSH_DATA / PTY_DATA 由终端组件自己订阅，
 *    一旦进 store 每次输出都会触发全树比对，10MB/s 吞吐直接崩掉。
 * 2. **写操作走 action，不直接改 state**。所有变更集中在一处，方便排查。
 * 3. **后端没就绪要降级**。store 域不可用时保留空列表 + 明确提示，
 *    绝不因为 IPC 失败把界面打崩。
 */

import {
  Events,
  type Connection,
  type ConnectionGroup,
  type ConnectionKind,
  type ConnectionState,
  type MonitorCardConfig,
  type MonitorSnapshot,
  type SshConnection,
  type TerminalEncoding,
} from '@t1000/shared'
import { useCallback, useRef, useSyncExternalStore } from 'react'
import { invoke, subscribe } from './ipc'
import { toast } from '../components/Toast'
import { errorText } from './format'
import { demoConnections, demoGroups, demoOtherConnections } from './demo'

/* ────────────────────────────────────────────── 类型 */

/** 现有契约里没有收藏/最近/常用字段，这里用持久化的附加字段表达（schema 是 passthrough） */
export interface ConnectionUiMeta {
  favorite?: boolean
  lastUsedAt?: string
  useCount?: number
  lastLatencyMs?: number
}

export type UiConnection = Connection & ConnectionUiMeta

/** 分组树节点。主进程 `store.listGroups` 返回的就是这个形状（含 children 与直属连接数）。 */
export interface GroupNode extends ConnectionGroup {
  children: GroupNode[]
  connectionCount: number
}

export type ViewId = 'connections' | 'console' | 'notes' | 'tools' | 'settings'

/** 分组过滤器：前四个是固定视图，其余是分组 id */
export const FILTER_ALL = '__all__'
export const FILTER_FAVORITE = '__favorite__'
export const FILTER_RECENT = '__recent__'
export const FILTER_FREQUENT = '__frequent__'

export type SortKey = 'name' | 'address' | 'latency' | 'status' | 'updated'
export type SortDir = 'asc' | 'desc'

export type TabKind = 'ssh' | 'local'
export type PaneLayout = 'single' | 'hsplit' | 'vsplit'

export interface TerminalTab {
  tabId: string
  kind: TabKind
  title: string
  subtitle?: string
  connectionId?: string
  sessionId?: string
  /** 会话状态；'idle' 表示还没有建立会话 */
  state: ConnectionState | 'idle'
  message?: string
  encoding: TerminalEncoding
  layout: PaneLayout
  /** 该标签右侧是否展开监控 */
  monitorOpen: boolean
  createdAt: number
}

export interface EditingTarget {
  mode: 'create' | 'edit'
  id?: string
  /** 新建时的预填协议 */
  kind?: ConnectionKind
}

export interface AppState {
  view: ViewId
  protocol: ConnectionKind

  connections: UiConnection[]
  groups: GroupNode[]
  loading: boolean
  loaded: boolean
  /** store 域是否可用；false 时列表/表单走降级分支 */
  backendReady: boolean
  backendError: string | null

  filter: string
  query: string
  sortKey: SortKey
  sortDir: SortDir
  showInfo: boolean
  selected: string[]

  editing: EditingTarget | null
  saving: boolean

  tabs: TerminalTab[]
  activeTabId: string | null

  monitorOpen: boolean
  monitorCards: MonitorCardConfig[]
  snapshots: Record<string, MonitorSnapshot>
  /** 每会话的 CPU 走势采样（最近 N 个点），走势图直接读它 */
  cpuHistory: Record<string, number[]>
  monitorStatus: Record<string, 'starting' | 'running' | 'paused' | 'stopped' | 'unavailable'>

  /** 批量操作进行中 */
  busy: null | { label: string; done: number; total: number }
}

/* ────────────────────────────────────────────── 初值 */

export const DEFAULT_MONITOR_CARDS: MonitorCardConfig[] = [
  { kind: 'system', enabled: true, order: 0, tier: 'slow' },
  { kind: 'cpu', enabled: true, order: 1, tier: 'fast' },
  { kind: 'memory', enabled: true, order: 2, tier: 'fast' },
  { kind: 'network', enabled: true, order: 3, tier: 'medium' },
  { kind: 'disk', enabled: true, order: 4, tier: 'medium' },
  { kind: 'process', enabled: false, order: 5, tier: 'medium' },
  { kind: 'gpu', enabled: false, order: 6, tier: 'slow' },
]

const initialState: AppState = {
  view: 'connections',
  protocol: 'ssh',
  connections: [],
  groups: [],
  loading: false,
  loaded: false,
  backendReady: true,
  backendError: null,
  filter: FILTER_ALL,
  query: '',
  sortKey: 'name',
  sortDir: 'asc',
  showInfo: true,
  selected: [],
  editing: null,
  saving: false,
  tabs: [],
  activeTabId: null,
  monitorOpen: false,
  monitorCards: DEFAULT_MONITOR_CARDS,
  snapshots: {},
  cpuHistory: {},
  monitorStatus: {},
  busy: null,
}

/** 走势图保留的采样点数（约 48 × 3s = 2.5 分钟） */
const CPU_HISTORY_LEN = 48

/* ────────────────────────────────────────────── 内核 */

let state: AppState = initialState
const listeners = new Set<() => void>()

export function getState(): AppState {
  return state
}

export function setState(patch: Partial<AppState> | ((s: AppState) => Partial<AppState>)): void {
  const next = typeof patch === 'function' ? patch(state) : patch
  let changed = false
  for (const key of Object.keys(next) as (keyof AppState)[]) {
    if (!Object.is(state[key], next[key])) {
      changed = true
      break
    }
  }
  if (!changed) return
  state = { ...state, ...next }
  for (const listener of listeners) listener()
}

export function subscribeStore(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** 重置到初始状态（测试/退出登录用）。 */
export function resetStore(): void {
  state = initialState
  for (const listener of listeners) listener()
}

/* ────────────────────────────────────────────── React 绑定 */

export function shallowEqual<T>(a: T, b: T): boolean {
  if (Object.is(a, b)) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  const ka = Object.keys(a as Record<string, unknown>)
  const kb = Object.keys(b as Record<string, unknown>)
  if (ka.length !== kb.length) return false
  for (const k of ka) {
    if (!Object.is((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false
  }
  return true
}

/**
 * 订阅状态切片。
 *
 * 关键在缓存：只有 `state` 引用变化时才重新计算选择器；如果新值与旧值
 * 在 `isEqual` 下相等，就返回**旧引用**，这样 React 不会重渲染。
 * 这正是「状态更新细粒度订阅，避免整树重渲染」的落点。
 */
export function useStore<S>(
  selector: (s: AppState) => S,
  isEqual: (a: S, b: S) => boolean = Object.is,
): S {
  const cache = useRef<{ state: AppState; value: S } | null>(null)
  const selectorRef = useRef(selector)
  const equalRef = useRef(isEqual)
  selectorRef.current = selector
  equalRef.current = isEqual

  const getSnapshot = useCallback(() => {
    const current = getState()
    const cached = cache.current
    if (cached && cached.state === current) return cached.value
    const value = selectorRef.current(current)
    if (cached && equalRef.current(cached.value, value)) {
      cache.current = { state: current, value: cached.value }
      return cached.value
    }
    cache.current = { state: current, value }
    return value
  }, [])

  return useSyncExternalStore(subscribeStore, getSnapshot, getSnapshot)
}

/** 返回多个字段时用它，避免每次渲染产生新对象导致无限重渲染。 */
export function useStoreShallow<S extends Record<string, unknown>>(
  selector: (s: AppState) => S,
): S {
  return useStore(selector, shallowEqual)
}

/* ────────────────────────────────────────────── 派生 */

const DEFAULT_PORTS: Record<ConnectionKind, number> = {
  ssh: 22,
  rdp: 3389,
  telnet: 23,
  tunnel: 0,
  vnc: 5901,
}

export function defaultPort(kind: ConnectionKind): number {
  return DEFAULT_PORTS[kind]
}

/** 统一的地址展示（tunnel 例外：显示 本地→远端）。 */
export function connectionAddress(conn: UiConnection): string {
  if (conn.kind === 'tunnel') {
    return `${conn.localHost}:${conn.localPort} → ${conn.remoteHost}:${conn.remotePort}`
  }
  const port = conn.port
  const def = defaultPort(conn.kind)
  return port === def ? conn.host : `${conn.host}:${port}`
}

export function connectionUsername(conn: UiConnection): string {
  return 'username' in conn && typeof conn.username === 'string' ? conn.username : ''
}

export function isFavorite(conn: UiConnection): boolean {
  return conn.favorite === true
}

/** 收集某个分组及其全部后代的 id。 */
export function collectGroupIds(nodes: GroupNode[], rootId: string, acc: string[] = []): string[] {
  for (const node of nodes) {
    if (node.id === rootId) {
      collectGroupIds(node.children, rootId, acc)
      acc.push(node.id)
      for (const child of node.children) {
        if (!acc.includes(child.id)) acc.push(child.id)
      }
      return acc
    }
    collectGroupIds(node.children, rootId, acc)
  }
  return acc
}

/** 主机名（tunnel 没有单一 host，用两端拼出来参与搜索）。 */
export function connectionHost(conn: UiConnection): string {
  if (conn.kind === 'tunnel') return `${conn.localHost} ${conn.remoteHost}`
  return conn.host
}

function matchesQuery(conn: UiConnection, needle: string): boolean {
  if (!needle) return true
  const haystack = [
    conn.name,
    connectionHost(conn),
    connectionUsername(conn),
    'port' in conn ? String(conn.port) : '',
    conn.note ?? '',
  ]
    .join('\u0000')
    .toLowerCase()
  return needle
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((term) => haystack.includes(term))
}

/** 状态优先级：出问题的排在前面，方便用户一眼看到故障。 */
const STATE_WEIGHT: Record<string, number> = {
  failed: 0,
  disconnected: 1,
  connecting: 2,
  authenticating: 3,
  'verifying-host-key': 4,
  ready: 5,
  idle: 6,
}

export interface VisibleResult {
  items: UiConnection[]
  /** 过滤前该协议下的总数（用于分段标签计数） */
  totalInProtocol: number
}

export function selectVisibleConnections(s: AppState): VisibleResult {
  const protocol = s.protocol
  const inProtocol = s.connections.filter((c) => c.kind === protocol)

  const groupIds =
    s.filter !== FILTER_ALL &&
    s.filter !== FILTER_FAVORITE &&
    s.filter !== FILTER_RECENT &&
    s.filter !== FILTER_FREQUENT
      ? collectGroupIds(s.groups, s.filter)
      : null

  const now = Date.now()
  let items = inProtocol.filter((conn) => {
    if (s.filter === FILTER_FAVORITE && !isFavorite(conn)) return false
    if (s.filter === FILTER_RECENT) {
      if (!conn.lastUsedAt) return false
      const t = Date.parse(conn.lastUsedAt)
      if (!Number.isFinite(t) || now - t > 7 * 86_400_000) return false
    }
    if (s.filter === FILTER_FREQUENT && !(conn.useCount && conn.useCount > 0)) return false
    if (groupIds && !(conn.groupId && groupIds.includes(conn.groupId))) return false
    return matchesQuery(conn, s.query)
  })

  const dir = s.sortDir === 'asc' ? 1 : -1
  const key = s.sortKey
  const statusOf = (c: UiConnection): number => STATE_WEIGHT[tabStateForConnection(c.id) ?? 'idle'] ?? 6

  items = items.slice().sort((a, b) => {
    switch (key) {
      case 'name':
        return a.name.localeCompare(b.name, 'zh-CN') * dir
      case 'address':
        return connectionAddress(a).localeCompare(connectionAddress(b)) * dir
      case 'latency':
        return ((a.lastLatencyMs ?? Number.MAX_SAFE_INTEGER) - (b.lastLatencyMs ?? Number.MAX_SAFE_INTEGER)) * dir
      case 'status':
        return (statusOf(a) - statusOf(b)) * dir
      case 'updated':
        return (Date.parse(a.updatedAt) - Date.parse(b.updatedAt)) * dir
      default:
        return 0
    }
  })

  return { items, totalInProtocol: inProtocol.length }
}

/** 协议标签上的计数 */
export function selectProtocolCounts(s: AppState): Record<ConnectionKind, number> {
  const counts: Record<ConnectionKind, number> = { ssh: 0, rdp: 0, telnet: 0, tunnel: 0, vnc: 0 }
  for (const c of s.connections) counts[c.kind] += 1
  return counts
}

/** 某个连接当前是否有活动会话（用于「已连接」指示） */
export function tabStateForConnection(connectionId: string): ConnectionState | undefined {
  const tab = state.tabs.find((t) => t.connectionId === connectionId)
  if (!tab) return undefined
  return tab.state === 'idle' ? undefined : tab.state
}

/* ────────────────────────────────────────────── 基础动作 */

export const actions = {
  setView(view: ViewId) {
    setState({ view })
  },

  setProtocol(protocol: ConnectionKind) {
    setState({ protocol, selected: [], filter: FILTER_ALL })
  },

  setFilter(filter: string) {
    setState({ filter, selected: [] })
  },

  setQuery(query: string) {
    setState({ query })
  },

  setSort(key: SortKey) {
    setState((s) =>
      s.sortKey === key
        ? { sortDir: s.sortDir === 'asc' ? 'desc' : 'asc' }
        : { sortKey: key, sortDir: 'asc' },
    )
  },

  setSortExplicit(key: SortKey, dir: SortDir) {
    setState({ sortKey: key, sortDir: dir })
  },

  toggleShowInfo() {
    setState((s) => ({ showInfo: !s.showInfo }))
  },

  toggleSelect(id: string) {
    setState((s) => ({
      selected: s.selected.includes(id)
        ? s.selected.filter((x) => x !== id)
        : [...s.selected, id],
    }))
  },

  setSelection(ids: string[]) {
    setState({ selected: ids })
  },

  clearSelection() {
    setState({ selected: [] })
  },

  openCreate(kind: ConnectionKind = 'ssh') {
    setState({ editing: { mode: 'create', kind } })
  },

  openEdit(id: string) {
    setState({ editing: { mode: 'edit', id } })
  },

  closeEditor() {
    setState({ editing: null })
  },

  toggleMonitor() {
    setState((s) => ({ monitorOpen: !s.monitorOpen }))
  },

  toggleMonitorCard(kind: MonitorCardConfig['kind']) {
    setState((s) => ({
      monitorCards: s.monitorCards.map((c) => (c.kind === kind ? { ...c, enabled: !c.enabled } : c)),
    }))
  },

  setBusy(busy: AppState['busy']) {
    setState({ busy })
  },
}

/* ────────────────────────────────────────────── 数据加载 */

let loadPromise: Promise<void> | null = null

/**
 * 加载连接与分组。
 * 并发调用会复用同一个 in-flight promise，避免首屏多个组件各拉一次。
 */
export function loadConnections(force = false): Promise<void> {
  if (loadPromise && !force) return loadPromise
  setState({ loading: true })
  loadPromise = (async () => {
    try {
      const [conns, groups] = await Promise.all([
        invoke<'store', 'listConnections', Record<string, never>, UiConnection[]>(
          'store',
          'listConnections',
          {},
        ),
        invoke<'store', 'listGroups', Record<string, never>, GroupNode[]>('store', 'listGroups', {}),
      ])
      const validGroups = Array.isArray(groups) ? groups : []
      setState({
        connections: Array.isArray(conns) ? conns : [],
        groups: normaliseGroups(validGroups),
        loading: false,
        loaded: true,
        backendReady: true,
        backendError: null,
      })
    } catch (err) {
      setState({
        loading: false,
        loaded: true,
        backendReady: false,
        backendError: errorText(err),
      })
    } finally {
      loadPromise = null
    }
  })()
  return loadPromise
}

/** 兜底：主进程返回的树节点可能缺 children / connectionCount，补齐成规范形状。 */
function normaliseGroups(nodes: GroupNode[]): GroupNode[] {
  return nodes.map((n) => ({
    ...n,
    children: Array.isArray(n.children) ? normaliseGroups(n.children) : [],
    connectionCount: typeof n.connectionCount === 'number' ? n.connectionCount : 0,
  }))
}

export function getConnection(id: string | undefined): UiConnection | undefined {
  if (!id) return undefined
  return state.connections.find((c) => c.id === id)
}

/* ────────────────────────────────────────────── 写操作 */

export function newConnectionId(): string {
  const bytes = new Uint8Array(12)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

export async function saveConnection(input: UiConnection): Promise<boolean> {
  setState({ saving: true })
  try {
    const saved = await invoke<'store', 'saveConnection', UiConnection, UiConnection>(
      'store',
      'saveConnection',
      input,
    )
    const next = saved && saved.id ? saved : input
    setState((s) => {
      const exists = s.connections.some((c) => c.id === next.id)
      return {
        connections: exists
          ? s.connections.map((c) => (c.id === next.id ? next : c))
          : [...s.connections, next],
        saving: false,
        editing: null,
        backendReady: true,
      }
    })
    return true
  } catch (err) {
    setState({ saving: false, backendReady: false, backendError: errorText(err) })
    toast.error(`保存失败：${errorText(err)}`)
    return false
  }
}

/**
 * 更新附加元信息（收藏 / 使用统计）。
 *
 * 这些字段不在 shared 的 Connection 里，但 store 的 zod schema 是 passthrough，
 * 所以能跟着 payload 一起持久化。写失败不影响主流程（只是统计信息）。
 */
async function patchMeta(id: string, patch: ConnectionUiMeta, silent = true): Promise<void> {
  const current = getConnection(id)
  if (!current) return
  const next: UiConnection = { ...current, ...patch }
  setState((s) => ({ connections: s.connections.map((c) => (c.id === id ? next : c)) }))
  try {
    await invoke<'store', 'saveConnection', UiConnection, UiConnection>('store', 'saveConnection', next)
  } catch (err) {
    if (!silent) toast.warn(`状态未能保存：${errorText(err)}`)
  }
}

export function toggleFavorite(id: string): void {
  const current = getConnection(id)
  if (!current) return
  void patchMeta(id, { favorite: !isFavorite(current) })
}

/** 连接成功时记录使用情况，「最近 / 常用」据此计算。 */
export function touchConnection(id: string): void {
  const current = getConnection(id)
  if (!current) return
  void patchMeta(id, {
    lastUsedAt: new Date().toISOString(),
    useCount: (current.useCount ?? 0) + 1,
  })
}

export async function deleteConnections(ids: string[]): Promise<number> {
  if (ids.length === 0) return 0
  setState({ busy: { label: '删除连接', done: 0, total: ids.length } })
  let done = 0
  const failed: string[] = []
  for (const id of ids) {
    try {
      await invoke<'store', 'deleteConnection', { id: string }, unknown>('store', 'deleteConnection', { id })
      done += 1
    } catch (err) {
      failed.push(errorText(err))
    }
    setState({ busy: { label: '删除连接', done, total: ids.length } })
  }
  setState((s) => ({
    connections: s.connections.filter((c) => !ids.includes(c.id)),
    selected: s.selected.filter((x) => !ids.includes(x)),
    busy: null,
  }))
  if (failed.length > 0) {
    toast.error(`${failed.length} 条删除失败：${failed[0] ?? ''}`)
  } else {
    toast.ok(`已删除 ${done} 条连接`)
  }
  return done
}

/** 复制连接：新 id、新名称后缀，其余原样。 */
export async function duplicateConnections(ids: string[]): Promise<void> {
  if (ids.length === 0) return
  setState({ busy: { label: '复制连接', done: 0, total: ids.length } })
  let ok = 0
  for (let i = 0; i < ids.length; i += 1) {
    const src = getConnection(ids[i])
    if (!src) continue
    const now = new Date().toISOString()
    const copy: UiConnection = {
      ...src,
      id: newConnectionId(),
      name: `${src.name} 副本`,
      createdAt: now,
      updatedAt: now,
    }
    try {
      const saved = await invoke<'store', 'saveConnection', UiConnection, UiConnection>(
        'store',
        'saveConnection',
        copy,
      )
      setState((s) => ({ connections: [...s.connections, saved?.id ? saved : copy] }))
      ok += 1
    } catch {
      /* 单条失败继续 */
    }
    setState({ busy: { label: '复制连接', done: i + 1, total: ids.length } })
  }
  setState({ busy: null, selected: [] })
  toast.ok(`已复制 ${ok} 条连接`)
}

/** 导出备份：走 store.exportBackup，落盘路径由主进程决定。 */
export async function exportBackup(): Promise<void> {
  try {
    const res = await invoke<'store', 'exportBackup', Record<string, never>, { filePath?: string }>(
      'store',
      'exportBackup',
      {},
    )
    toast.ok(res?.filePath ? `备份已写入 ${res.filePath}` : '备份已导出')
  } catch (err) {
    toast.error(`导出失败：${errorText(err)}`)
  }
}

/** 移动连接到分组（拖拽/右键菜单用）。 */
export async function moveConnection(id: string, groupId: string | undefined): Promise<void> {
  const current = getConnection(id)
  if (!current) return
  const next: UiConnection = { ...current, groupId }
  setState((s) => ({ connections: s.connections.map((c) => (c.id === id ? next : c)) }))
  try {
    await invoke<'store', 'moveConnection', { id: string; groupId?: string }, unknown>(
      'store',
      'moveConnection',
      groupId === undefined ? { id } : { id, groupId },
    )
  } catch (err) {
    toast.error(`移动失败：${errorText(err)}`)
    void loadConnections(true)
  }
}

export async function saveGroup(group: ConnectionGroup): Promise<boolean> {
  try {
    await invoke<'store', 'saveGroup', ConnectionGroup, unknown>('store', 'saveGroup', group)
    await loadConnections(true)
    return true
  } catch (err) {
    toast.error(`分组保存失败：${errorText(err)}`)
    return false
  }
}

export async function deleteGroup(id: string): Promise<void> {
  try {
    await invoke<'store', 'deleteGroup', { id: string; cascade: boolean }, unknown>(
      'store',
      'deleteGroup',
      { id, cascade: false },
    )
    await loadConnections(true)
  } catch (err) {
    toast.error(`分组删除失败：${errorText(err)}`)
  }
}

/* ────────────────────────────────────────────── 演示数据 */

/**
 * 通过**真实 IPC** 灌入演示数据。
 * 这样既能在空状态下给用户一个可看的界面，也顺带验证了整条读写链路。
 * 后端不可用时退化为纯内存展示，UI 依然可验证。
 */
export async function seedDemo(count = 14): Promise<{ persisted: boolean; total: number }> {
  const conns = [...demoConnections(count), ...demoOtherConnections()]
  const groups = demoGroups()
  let persisted = true

  setState({ busy: { label: '载入演示数据', done: 0, total: conns.length } })
  for (const g of groups) {
    try {
      await invoke<'store', 'saveGroup', ConnectionGroup, unknown>('store', 'saveGroup', g)
    } catch {
      persisted = false
    }
  }
  for (let i = 0; i < conns.length; i += 1) {
    const conn = conns[i]
    if (!conn) continue
    try {
      await invoke<'store', 'saveConnection', UiConnection, UiConnection>(
        'store',
        'saveConnection',
        conn as UiConnection,
      )
    } catch {
      persisted = false
    }
    if (i % 10 === 0) {
      setState({ busy: { label: '载入演示数据', done: i, total: conns.length } })
    }
  }

  setState({
    busy: null,
    connections: conns,
    groups: normaliseGroups(groups.map((g) => ({ ...g, children: [], connectionCount: 0 }))),
    loaded: true,
    loading: false,
  })
  await loadConnections(true)

  toast[persisted ? 'ok' : 'warn'](
    persisted ? `已载入 ${conns.length} 条演示连接` : `后端不可用，已用内存数据展示 ${conns.length} 条连接`,
  )
  return { persisted, total: conns.length }
}

/* ────────────────────────────────────────────── 终端标签 */

let tabSeq = 0

function makeTab(partial: Omit<TerminalTab, 'tabId' | 'createdAt' | 'layout' | 'monitorOpen' | 'encoding'> & { encoding?: TerminalEncoding }): TerminalTab {
  tabSeq += 1
  return {
    tabId: `tab-${tabSeq}`,
    createdAt: Date.now(),
    layout: 'single',
    monitorOpen: false,
    encoding: partial.encoding ?? 'utf-8',
    ...partial,
  }
}

function updateTab(tabId: string, patch: Partial<TerminalTab>): void {
  setState((s) => ({
    tabs: s.tabs.map((t) => (t.tabId === tabId ? { ...t, ...patch } : t)),
  }))
}

export function setActiveTab(tabId: string | null): void {
  setState({ activeTabId: tabId })
}

export function closeTab(tabId: string): void {
  const tab = state.tabs.find((t) => t.tabId === tabId)
  // 先请求断开，再移除标签；断开失败不影响 UI 收敛
  if (tab?.sessionId) {
    const domain = tab.kind === 'ssh' ? 'ssh' : 'pty'
    const action = 'disconnect'
    void invoke(domain, action, { sessionId: tab.sessionId }).catch(() => undefined)
  }
  setState((s) => {
    const tabs = s.tabs.filter((t) => t.tabId !== tabId)
    const activeTabId =
      s.activeTabId === tabId ? (tabs.length > 0 ? (tabs[tabs.length - 1]?.tabId ?? null) : null) : s.activeTabId
    return { tabs, activeTabId }
  })
}

export function setTabLayout(tabId: string, layout: PaneLayout): void {
  updateTab(tabId, { layout })
}

export function toggleTabMonitor(tabId: string): void {
  const tab = state.tabs.find((t) => t.tabId === tabId)
  if (!tab) return
  updateTab(tabId, { monitorOpen: !tab.monitorOpen })
}

/**
 * 打开一个连接的工作区。
 *
 * 注意：这里只负责「建标签 + 发起连接」，后续状态完全由 SSH_STATE 事件驱动，
 * 不在渲染层做乐观状态猜测——否则事件与本地状态会互相打架。
 */
export async function connectTo(connection: UiConnection): Promise<void> {
  if (connection.kind !== 'ssh') {
    toast.info(`${connection.kind.toUpperCase()} 工作区尚未接入，当前版本先支持 SSH 与本地终端`)
    return
  }
  const tab = makeTab({
    kind: 'ssh',
    title: connection.name,
    subtitle: connectionAddress(connection),
    connectionId: connection.id,
    state: 'connecting',
    encoding: (connection.options?.encoding as TerminalEncoding | undefined) ?? 'utf-8',
  })
  setState((s) => ({ tabs: [...s.tabs, tab], activeTabId: tab.tabId, view: 'console' }))

  try {
    const res = await invoke<'ssh', 'connect', { connection: UiConnection }, { sessionId: string }>(
      'ssh',
      'connect',
      { connection },
    )
    if (res?.sessionId) {
      updateTab(tab.tabId, { sessionId: res.sessionId, state: 'ready' })
      if (state.monitorOpen) void startMonitor(res.sessionId)
      touchConnection(connection.id)
    }
  } catch (err) {
    const message = errorText(err)
    updateTab(tab.tabId, { state: 'failed', message })
    toast.error(`连接 ${connection.name} 失败：${message}`)
  }
}

/** 打开本地终端（PTY）。pty 服务未就绪时给出明确提示而不是静默失败。 */
export async function openLocalTerminal(shell?: string): Promise<void> {
  const tab = makeTab({ kind: 'local', title: '本地终端', subtitle: shell ?? '默认 shell', state: 'connecting' })
  setState((s) => ({ tabs: [...s.tabs, tab], activeTabId: tab.tabId, view: 'console' }))
  try {
    const res = await invoke<'pty', 'open', { shell?: string }, { ptyId: string }>(
      'pty',
      'open',
      shell === undefined ? {} : { shell },
    )
    const ptyId = res?.ptyId
    updateTab(tab.tabId, { sessionId: ptyId, state: ptyId ? 'ready' : 'failed' })
  } catch (err) {
    updateTab(tab.tabId, { state: 'failed', message: errorText(err) })
    toast.warn(`本地终端不可用：${errorText(err)}`)
  }
}

/* ────────────────────────────────────────────── 监控 */

export async function startMonitor(sessionId: string): Promise<void> {
  setState((s) => ({ monitorStatus: { ...s.monitorStatus, [sessionId]: 'starting' } }))
  try {
    await invoke<'monitor', 'start', { sessionId: string; cards: MonitorCardConfig[] }, unknown>(
      'monitor',
      'start',
      { sessionId, cards: state.monitorCards.filter((c) => c.enabled) },
    )
    setState((s) => ({ monitorStatus: { ...s.monitorStatus, [sessionId]: 'running' } }))
  } catch (err) {
    setState((s) => ({ monitorStatus: { ...s.monitorStatus, [sessionId]: 'unavailable' } }))
    toast.warn(`监控采集不可用：${errorText(err)}`)
  }
}

export async function stopMonitor(sessionId: string): Promise<void> {
  try {
    await invoke<'monitor', 'stop', { sessionId: string }, unknown>('monitor', 'stop', { sessionId })
  } catch {
    /* 停不下来不阻塞 UI */
  }
  setState((s) => ({ monitorStatus: { ...s.monitorStatus, [sessionId]: 'stopped' } }))
}

/** 注入一份快照（事件路径与演示路径共用）。 */
export function applySnapshot(sessionId: string, snapshot: MonitorSnapshot): void {
  setState((s) => {
    const usage = snapshot.cpu?.usage
    const history =
      usage === undefined
        ? (s.cpuHistory[sessionId] ?? [])
        : [...(s.cpuHistory[sessionId] ?? []), usage].slice(-CPU_HISTORY_LEN)
    return {
      snapshots: { ...s.snapshots, [sessionId]: snapshot },
      cpuHistory: { ...s.cpuHistory, [sessionId]: history },
    }
  })
}

/* ────────────────────────────────────────────── 事件接线 */

let wired = false

/**
 * 订阅主进程事件。应用生命周期内常驻，只接一次（StrictMode 双调用安全）。
 * 高频的 SSH_DATA / PTY_DATA 故意不在这里处理。
 */
export function wireEvents(): void {
  if (wired) return
  wired = true

  subscribe(Events.SSH_STATE, (p) => {
    setState((s) => ({
      tabs: s.tabs.map((t) =>
        t.sessionId === p.sessionId ? { ...t, state: p.state, message: p.message } : t,
      ),
    }))
  })

  subscribe(Events.SSH_ERROR, (p) => {
    setState((s) => ({
      tabs: s.tabs.map((t) =>
        t.sessionId === p.sessionId ? { ...t, state: 'failed', message: p.message } : t,
      ),
    }))
    toast.error(`会话错误：${p.message}`)
  })

  subscribe(Events.SSH_CLOSED, (p) => {
    setState((s) => ({
      tabs: s.tabs.map((t) =>
        t.sessionId === p.sessionId
          ? { ...t, state: 'disconnected', message: p.reason ?? '连接已关闭' }
          : t,
      ),
    }))
  })

  subscribe(Events.SSH_AUTH_RESULT, (p) => {
    if (!p.success) toast.warn(`认证方式 ${p.method} 未通过`)
  })

  subscribe(Events.PTY_EXIT, (p) => {
    setState((s) => ({
      tabs: s.tabs.map((t) =>
        t.sessionId === p.ptyId
          ? { ...t, state: 'disconnected', message: `进程已退出（code ${p.exitCode}）` }
          : t,
      ),
    }))
  })

  subscribe(Events.MONITOR_SNAPSHOT, (p) => {
    applySnapshot(p.sessionId, p.snapshot)
  })

  subscribe(Events.MONITOR_STATUS, (p) => {
    setState((s) => ({ monitorStatus: { ...s.monitorStatus, [p.sessionId]: p.status } }))
  })

  subscribe(Events.MONITOR_ERROR, (p) => {
    setState((s) => ({ monitorStatus: { ...s.monitorStatus, [p.sessionId]: 'unavailable' } }))
    toast.warn(`监控采集失败：${p.message}`)
  })
}

export type { SshConnection }
