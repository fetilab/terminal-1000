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
  LATENCY_UNREACHABLE,
  type Connection,
  type ConnectionGroup,
  type ConnectionKind,
  type ConnectionState,
  type GroupTreeNode,
  type Note,
  type NoteFolder,
  type NoteSummary,
  type PingResult,
  type HighlightRule,
  type RecordingSettings,
  type RecordingSummary,
  type Settings,
  type TerminalSettings,
  type ThemeMode,
  type MonitorCardConfig,
  type MonitorSnapshot,
  type SshConnection,
  type TerminalEncoding,
} from '@t1000/shared'
import { useCallback, useRef, useSyncExternalStore } from 'react'
import { invoke, subscribe } from './ipc'
import { ensureUnlocked } from './vault'
import { toast } from '../components/Toast'
import { applyAppearance } from '../theme/appearance'
import { errorText } from './format'

/* ────────────────────────────────────────────── 类型 */

/** 现有契约里没有收藏/最近/常用字段，这里用持久化的附加字段表达（schema 是 passthrough） */
export interface ConnectionUiMeta {
  favorite?: boolean
  lastUsedAt?: string
  useCount?: number
  lastLatencyMs?: number
}

export type UiConnection = Connection & ConnectionUiMeta

/** 渲染侧的探测缓存（PingResult 的 UI 视图，只留渲染需要的字段 + 探测时刻） */
export interface PingEntry {
  reachable: boolean
  latencyMs: number
  method: PingResult['method']
  reason?: string
  at: number
}

/**
 * 分组树节点。
 * 形状由 `@t1000/shared` 的 GroupTreeNode 统一定义（主进程 buildGroupTree 也返回它），
 * 这里只是给个短别名，避免渲染层再维护一份重复声明。
 */
export type GroupNode = GroupTreeNode

export type ViewId =
  | 'connections'
  | 'console'
  | 'notes'
  | 'tools'
  | 'ai'
  | 'services'
  | 'logs'
  | 'settings'

/**
 * 会话日志/录制类型统一从 `@t1000/shared` 引入（原先这里镜像过一份，已上移）。
 * `ActiveRecording` 是 active() 的返回形状，主进程侧未在 shared 定义，仍在此声明。
 */
export type { RecordingSettings, RecordingSummary, SessionLogReplay, ReplayFrame } from '@t1000/shared'

export interface ActiveRecording {
  sessionId: string
  logId: string
  title: string
  bytes: number
  startedAt: string
}

export interface LogReadResult {
  logId: string
  content: string
  offset: number
  totalBytes: number
  /** 本次窗口之前还有内容（向上翻） */
  hasMoreBefore: boolean
  /** 本次窗口之后还有内容（向下翻） */
  hasMoreAfter: boolean
  hasMore: boolean
}

/** 笔记面板的过滤条件：三个固定视图 + 任意文件夹 */
export type NotesFilter = 'all' | 'favorites' | 'trash' | `folder:${string}`

/**
 * 广播组成员。
 * `writable === false` 表示后端**不会**往这个会话写（例如只读会话），
 * 但它仍会被计入 send 的 `skipped` —— UI 必须标灰并说明，否则用户以为都收到了。
 */
export interface BroadcastMember {
  sessionId: string
  kind: 'ssh' | 'pty' | 'telnet'
  title: string
  writable: boolean
}

export interface BroadcastGroupView {
  groupId: string
  name: string
  mode: 'independent' | 'broadcast'
  createdAt: string
  members: BroadcastMember[]
}

/** send 的返回：不能只显示"已发送"，要能看出 N 台里有几台没收到 */
export interface BroadcastSendResult {
  delivered: number
  skipped: number
  details: Array<{ sessionId: string; title: string; message: string }>
}

/** 一条 Telnet 选项协商摘要（诊断"连上但键盘没反应"的关键证据） */
export interface NegotiationEntry {
  option: number
  optionName: string
  direction: 'local' | 'remote'
  accepted: boolean
  detail?: string
  at: number
}

/** 设置面板分区。定义在这里作为唯一真源，features/settings 直接复用。 */
export type SettingsSectionId =
  | 'app'
  | 'terminal'
  | 'highlights'
  | 'hotkeys'
  | 'completion'
  | 'ai'
  | 'transfer'
  | 'sync'
  | 'security'
  | 'vault'

/** 分组过滤器：前四个是固定视图，其余是分组 id */
export const FILTER_ALL = '__all__'
export const FILTER_FAVORITE = '__favorite__'
export const FILTER_RECENT = '__recent__'
export const FILTER_FREQUENT = '__frequent__'

export type SortKey = 'name' | 'address' | 'latency' | 'status' | 'updated'
export type SortDir = 'asc' | 'desc'

export type TabKind = 'ssh' | 'local' | 'telnet' | 'vnc' | 'rdp' | 'tunnel'
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
  /** 该标签左侧是否展开文件栏（ssh/local 有文件系统；telnet 没有） */
  filesOpen: boolean
  /** 工作区视图：终端 / 远端文件（SFTP）；三栏布局下终端类会话不再切换，保留字段兼容既有存档 */
  mode: 'terminal' | 'sftp'
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

  /** 设置面板当前分区 */
  settingsSection: SettingsSectionId
  /** 传输同名冲突策略（来自 settings.transfer），SFTP 上传下载要用 */
  transferConflictPolicy: 'ask' | 'overwrite' | 'skip' | 'rename'
  /** AI 交互模式（来自 settings.ai.mode），面板顶部展示 */
  aiMode: 'chat' | 'assistant' | 'confirm' | 'thinking'
  /** 终端/远端响铃设置（来自 settings.terminal.bell）；VNC 的 BELL 事件据此决定是否发声 */
  bellMode: 'none' | 'sound' | 'visual'
  /**
   * 终端外观与行为（settings.terminal 的渲染层消费子集）。
   * 放在 store 是为了**热更新**：设置面板改一项，已经打开的 xterm 要立刻跟着变，
   * 而不是等下次新建终端。
   */
  terminalSettings: TerminalSettings
  /**
   * 高亮规则（settings.highlights，数组 section）。
   *
   * 放 store 是为了**热更新**：设置里改规则，已打开的终端立刻用新规则着色新输出，
   * 不需要重连。（已经打印出来的行不会回溯重染 —— xterm 的 decoration 只影响之后渲染的内容。）
   */
  highlightRules: HighlightRule[]
  /** 外部服务面板当前分区 */
  servicesSection: 'sync' | 'mcp'
  /** 工具页当前选中的工具 */
  toolsSection: 'password' | 'manual'
  /** 全局搜索面板是否打开（放 store 是为了任何视图都能开它，不用逐层传 prop） */
  globalSearchOpen: boolean
  /**
   * 终端工具栏是否显示。
   *
   * spec 第 251 行要求「`Ctrl/Cmd+Shift+T` 打开工具条」且可设"自动显示"，
   * 所以它必须**可隐藏** —— 放 store 是因为右键菜单（TerminalPane）要能切换它，
   * 而工具栏本身在 TerminalWorkspace 里。
   */
  toolbarVisible: boolean
  /**
   * 控制台左侧「会话栏」是否折叠成窄条图标。
   *
   * 只影响控制台视图（折叠后宽度是 44px，其它视图的侧栏内容塞不进去）；
   * 放 store 是因为外壳（App）要改 grid 列宽，而开关按钮在 SessionSidebar 里，
   * 两者之间没有父子关系。偏好持久化到 localStorage，重启后保持。
   */
  panelCollapsed: boolean
  /**
   * 会话 → 远端 shell 当前目录。
   *
   * 来源是终端输出里的 **OSC 7**（`\x1b]7;file://host/path\x07`）。
   * 主进程**没有**提供"当前 cwd"的动作（`Actions.ssh` 里没有），
   * 所以在渲染层用 xterm 的 OSC handler 自己解析 —— 不必为这件事改主进程。
   * ⚠️ 代价：只有远端 shell 配置了发 OSC 7 才有值（bash 需要 PROMPT_COMMAND 钩子、
   * zsh/fish 常见配置自带），拿不到时界面上要如实说明，而不是默默失效。
   */
  sessionCwd: Record<string, string>

  /* ── 会话日志 ── */
  sessionLogs: RecordingSummary[]
  /** 正在录制的会话（终端要据此显示红点指示） */
  activeRecordings: ActiveRecording[]
  logsLoading: boolean
  logsReady: boolean
  logsError: string | null
  /** 录制设置（间隔 / 自动压缩 / 是否录制） */
  recordingSettings: RecordingSettings | null

  /** 会话 id → 最近的协商记录（只对 telnet 有值；低频，放全局无压力） */
  negotiations: Record<string, NegotiationEntry[]>

  /* ── 广播组 ── */
  broadcastGroups: BroadcastGroupView[]
  /** 最近一次广播发送的结果（每个组一条），用于"5 台里 2 台没收到"的即时反馈 */
  broadcastLastSend: Record<string, BroadcastSendResult>
  /** 逐条上报的发送失败 */
  broadcastErrors: Array<{ groupId: string; sessionId: string; title: string; message: string; at: number }>

  /* ── 笔记 ── */
  notes: NoteSummary[]
  noteFolders: NoteFolder[]
  notesFilter: NotesFilter
  notesQuery: string
  notesLoading: boolean
  /** notes 域是否可用（未挂载时面板给出明确空状态而不是空白） */
  notesReady: boolean
  notesError: string | null
  /** 当前打开的笔记全文（含正文）；新建时为一份未落库的草稿 */
  noteDraft: Note | null
  /** 草稿相对库中版本是否已改动 */
  noteDirty: boolean
  noteSaving: boolean
  /** 侧栏计数：一次刷新算好，避免每个文件夹各发一次 list */
  noteStats: { all: number; favorites: number; trash: number; byFolder: Record<string, number> }
  /** 用户选择的主题（可能是 system） */
  theme: ThemeMode
  /** 实际生效的主题（把 system 解析后的结果），用于给 xterm 等自绘区域选配色 */
  resolvedTheme: 'light' | 'dark'

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
  /** 连接 id → 最近一次延迟探测结果 */
  pings: Record<string, PingEntry>
  pingBusy: boolean

  editing: EditingTarget | null
  saving: boolean

  tabs: TerminalTab[]
  activeTabId: string | null

  monitorOpen: boolean
  /** 终端工作区左侧的快速命令面板是否展开（应用级，切视图不重置） */
  quickcmdOpen: boolean
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

/** 会话栏折叠偏好：坏值/不可用一律当"展开"，展开永远是最安全的默认 */
function readPanelCollapsed(): boolean {
  try {
    return localStorage.getItem('t1000:panel-collapsed') === '1'
  } catch {
    return false
  }
}

const initialState: AppState = {
  view: 'connections',
  protocol: 'ssh',
  settingsSection: 'app',
  transferConflictPolicy: 'ask',
  aiMode: 'chat',
  bellMode: 'none',
  terminalSettings: {
    fontFamily: "'JetBrains Mono', 'Cascadia Code', Menlo, Consolas, monospace",
    fontSize: 13,
    lineHeight: 1.2,
    letterSpacing: 0,
    cursorStyle: 'bar',
    cursorBlink: true,
    copyOnSelect: false,
    rightClickPaste: false,
    scrollback: 8000,
    wrapLines: true,
    bell: 'none',
    defaultEncoding: 'utf-8',
    colorScheme: 'default-dark',
    linkDetection: true,
    // 与主进程默认值保持一致（这个对象是"设置还没加载出来"时的兜底，
    // 少一个字段就会让类型不完整 —— 补契约字段时必须一起补这里）
    zebraStripes: false,
  },
  highlightRules: [],
  servicesSection: 'sync',
  toolsSection: 'password',
  globalSearchOpen: false,
  toolbarVisible: true,
  panelCollapsed: readPanelCollapsed(),
  sessionCwd: {},
  negotiations: {},
  broadcastGroups: [],
  broadcastLastSend: {},
  broadcastErrors: [],
  sessionLogs: [],
  activeRecordings: [],
  logsLoading: false,
  logsReady: true,
  logsError: null,
  recordingSettings: null,
  notes: [],
  noteFolders: [],
  notesFilter: 'all',
  notesQuery: '',
  notesLoading: false,
  notesReady: true,
  notesError: null,
  noteDraft: null,
  noteDirty: false,
  noteSaving: false,
  noteStats: { all: 0, favorites: 0, trash: 0, byFolder: {} },
  theme: 'system',
  resolvedTheme: 'dark',
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
  pings: {},
  pingBusy: false,
  editing: null,
  saving: false,
  tabs: [],
  activeTabId: null,
  monitorOpen: false,
  quickcmdOpen: false,
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
      case 'latency': {
        // 不可达/未探测统一排到最后，再按真实时延比较
        const rank = (c: UiConnection): [number, number] => {
          const p = state.pings[c.id]
          if (!p) return [2, Number.MAX_SAFE_INTEGER]
          if (!p.reachable || p.latencyMs >= LATENCY_UNREACHABLE) return [1, Number.MAX_SAFE_INTEGER]
          return [0, p.latencyMs]
        }
        const [ra, la] = rank(a)
        const [rb, lb] = rank(b)
        return (ra - rb || la - lb) * dir
      }
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

  setSettingsSection(section: SettingsSectionId) {
    setState({ settingsSection: section })
  },

  setServicesSection(section: 'sync' | 'mcp') {
    setState({ servicesSection: section })
  },

  setToolsSection(section: 'password' | 'manual') {
    setState({ toolsSection: section })
  },

  toggleToolbar() {
    setState((s) => ({ toolbarVisible: !s.toolbarVisible }))
  },

  /** 控制台会话栏折叠/展开。展开态是默认值，写盘失败也不影响当下这次切换。 */
  togglePanelCollapsed() {
    setState((s) => {
      const next = !s.panelCollapsed
      try {
        localStorage.setItem('t1000:panel-collapsed', next ? '1' : '0')
      } catch {
        // 存不下来只意味着"下次启动回到展开"，不打断交互
      }
      return { panelCollapsed: next }
    })
  },

  toggleGlobalSearch() {
    setState((s) => ({ globalSearchOpen: !s.globalSearchOpen }))
  },

  closeGlobalSearch() {
    setState({ globalSearchOpen: false })
  },

  setNotesFilter(filter: NotesFilter) {
    // 切分类时关掉当前详情：它可能不属于新分类，留着会让人误以为还在同一个列表里
    setState({ notesFilter: filter, noteDraft: null, noteDirty: false })
  },

  setNotesQuery(query: string) {
    setState({ notesQuery: query })
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

  /** 终端左栏的快速命令面板 */
  toggleQuickcmd() {
    setState((s) => ({ quickcmdOpen: !s.quickcmdOpen }))
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

/* ────────────────────────────────────────────── 主题 */

/**
 * 应用主题。
 *
 * 用 `data-theme` 属性切换一整套 CSS 令牌，而不是到处写条件类名——
 * 组件只认令牌，主题切换对它们完全透明。
 * `system` 会跟随系统的 prefers-color-scheme，并监听它的变化。
 */
export function applyTheme(theme: ThemeMode): void {
  const resolved: 'light' | 'dark' =
    theme === 'system'
      ? window.matchMedia('(prefers-color-scheme: light)').matches
        ? 'light'
        : 'dark'
      : theme
  setState({ theme, resolvedTheme: resolved })
  document.documentElement.dataset.theme = resolved
}

/** 设置面板改了 terminal.* 时同步进 store，让已打开的终端热更新 */
export function applyHighlightRules(rules: HighlightRule[]): void {
  setState({ highlightRules: Array.isArray(rules) ? rules : [] })
}

export function applyTerminalSettings(next: TerminalSettings): void {
  setState({ terminalSettings: next, bellMode: next.bell })
}

/** 跟随系统主题变化（只在 theme === 'system' 时生效） */
export function watchSystemTheme(): () => void {
  const mq = window.matchMedia('(prefers-color-scheme: light)')
  const onChange = (): void => {
    if (state.theme === 'system') applyTheme('system')
  }
  mq.addEventListener('change', onChange)
  return () => mq.removeEventListener('change', onChange)
}

/**
 * 启动时读一次设置，把主题应用到根节点。
 * 设置域不可用**不影响启动**：静默回退到默认深色。
 */
export async function loadInitialSettings(): Promise<void> {
  try {
    const settings = await invoke<'settings', 'getAll', Record<string, never>, Settings>(
      'settings',
      'getAll',
      {},
    )
    applyTheme(settings.app.theme)
    // 外观层（预设/背景图/透明度/缩放）在主题之后应用：它要对 data-theme 派生的令牌做覆盖
    applyAppearance(settings)
    setState({
      transferConflictPolicy: settings.transfer.conflictPolicy,
      aiMode: settings.ai.mode,
      bellMode: settings.terminal.bell,
      terminalSettings: settings.terminal,
      highlightRules: Array.isArray(settings.highlights) ? settings.highlights : [],
    })
  } catch {
    applyTheme('dark')
  }
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
export function normaliseGroups(nodes: GroupNode[]): GroupNode[] {
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

/** 载荷里是否含机密字段（口令/私钥/口令短语）—— 有就要先解锁，否则会被丢弃 */
function hasCredential(input: Record<string, unknown>): boolean {
  const SECRET_KEYS = ['password', 'passphrase', 'privateKey', 'privateKeyPath', 'credentialId', 'proxyPassword']
  return SECRET_KEYS.some((k) => {
    const v = input[k]
    return typeof v === 'string' && v.trim() !== ''
  })
}

export async function saveConnection(input: UiConnection): Promise<boolean> {
  // 含机密的连接必须先解锁本地库：未解锁时主进程会 fail-fast，
  // 这里提前拦一道并就地引导（创建主密码 / 解锁），而不是让保存静默丢凭据。
  if (hasCredential(input as unknown as Record<string, unknown>)) {
    const unlocked = await ensureUnlocked('这条连接带有口令或私钥，需要先解锁本地库才能安全保存。')
    if (!unlocked) {
      toast.warn('本地库未解锁，已取消保存（避免凭据被丢弃）')
      return false
    }
  }
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

/* ────────────────────────────────────────────── 笔记 */

/** 过滤条件 → notes.list 的参数 */
function notesListParams(filter: NotesFilter, keyword: string): Record<string, unknown> {
  const params: Record<string, unknown> = {}
  if (filter === 'trash') params.trashed = true
  if (filter === 'favorites') params.favoritesOnly = true
  if (filter.startsWith('folder:')) params.folderId = filter.slice('folder:'.length)
  if (keyword.trim()) params.keyword = keyword.trim()
  return params
}

let notesLoadSeq = 0

/**
 * 拉取笔记列表。
 *
 * 用递增序号丢弃过期响应：快速切文件夹时，先发的请求可能后到，
 * 不做处理就会出现"列表和选中的文件夹对不上"。
 */
export async function loadNotes(): Promise<void> {
  const seq = ++notesLoadSeq
  setState({ notesLoading: true })
  try {
    const list = await invoke<'notes', 'list', Record<string, unknown>, NoteSummary[]>(
      'notes',
      'list',
      notesListParams(state.notesFilter, state.notesQuery),
    )
    if (seq !== notesLoadSeq) return
    setState({ notes: Array.isArray(list) ? list : [], notesLoading: false, notesReady: true, notesError: null })
    void loadNoteStats()
  } catch (err) {
    if (seq !== notesLoadSeq) return
    setState({ notesLoading: false, notesReady: false, notesError: errorText(err) })
  }
}

/**
 * 侧栏计数。
 *
 * 单独拉两批摘要（在用的 + 废纸篓）在渲染层算全部计数，
 * 而不是给每个文件夹各发一次 list —— 文件夹多了会把 IPC 打成一串。
 * 摘要不含正文，所以这两次调用很轻。
 */
async function loadNoteStats(): Promise<void> {
  try {
    const [live, trashed] = await Promise.all([
      invoke<'notes', 'list', Record<string, unknown>, NoteSummary[]>('notes', 'list', {}),
      invoke<'notes', 'list', Record<string, unknown>, NoteSummary[]>('notes', 'list', {
        trashed: true,
      }),
    ])
    const byFolder: Record<string, number> = {}
    let favorites = 0
    for (const n of live) {
      if (n.favorite) favorites += 1
      if (n.folderId) byFolder[n.folderId] = (byFolder[n.folderId] ?? 0) + 1
    }
    setState({
      noteStats: { all: live.length, favorites, trash: trashed.length, byFolder },
    })
  } catch {
    // 计数失败不影响列表
  }
}

export async function loadNoteFolders(): Promise<void> {
  try {
    const folders = await invoke<'notes', 'listFolders', Record<string, never>, NoteFolder[]>(
      'notes',
      'listFolders',
      {},
    )
    setState({ noteFolders: Array.isArray(folders) ? folders : [] })
  } catch {
    // 文件夹不可用不影响笔记列表
  }
}

/** 打开一条笔记：列表只给了摘要，正文要单独 get */
export async function openNote(id: string): Promise<void> {
  try {
    const note = await invoke<'notes', 'get', { id: string }, Note>('notes', 'get', { id })
    setState({ noteDraft: note, noteDirty: false })
  } catch (err) {
    toast.error(`打开笔记失败：${errorText(err)}`)
  }
}

export function newNote(folderId?: string): void {
  const now = new Date().toISOString()
  setState({
    noteDraft: {
      id: '',
      title: '',
      content: '',
      ...(folderId ? { folderId } : {}),
      favorite: false,
      trashed: false,
      createdAt: now,
      updatedAt: now,
    },
    noteDirty: true,
  })
}

export function updateNoteDraft(patch: Partial<Note>): void {
  setState((s) => (s.noteDraft ? { noteDraft: { ...s.noteDraft, ...patch }, noteDirty: true } : {}))
}

/** 保存草稿（id 为空则新建）。返回是否成功。 */
export async function saveNoteDraft(): Promise<boolean> {
  const draft = state.noteDraft
  if (!draft) return false
  setState({ noteSaving: true })
  try {
    const payload: Record<string, unknown> = {
      title: draft.title.trim() || '未命名笔记',
      content: draft.content,
      favorite: draft.favorite === true,
    }
    if (draft.id) payload.id = draft.id
    if (draft.folderId) payload.folderId = draft.folderId
    if (draft.connectionId) payload.connectionId = draft.connectionId
    if (draft.groupId) payload.groupId = draft.groupId
    if (draft.tags) payload.tags = draft.tags

    const saved = await invoke<'notes', 'save', Record<string, unknown>, Note>('notes', 'save', payload)
    setState({ noteDraft: saved, noteDirty: false, noteSaving: false, notesReady: true })
    await loadNotes()
    return true
  } catch (err) {
    setState({ noteSaving: false })
    toast.error(`保存笔记失败：${errorText(err)}`)
    return false
  }
}

/** 软删：移入废纸篓（可恢复） */
export async function trashNote(id: string): Promise<void> {
  try {
    await invoke<'notes', 'delete', { id: string }, unknown>('notes', 'delete', { id })
    if (state.noteDraft?.id === id) setState({ noteDraft: null, noteDirty: false })
    await loadNotes()
    toast.ok('已移入废纸篓')
  } catch (err) {
    toast.error(`移入废纸篓失败：${errorText(err)}`)
  }
}

export async function restoreNote(id: string): Promise<void> {
  try {
    await invoke<'notes', 'restore', { id: string }, unknown>('notes', 'restore', { id })
    await loadNotes()
    toast.ok('已从废纸篓恢复')
  } catch (err) {
    toast.error(`恢复失败：${errorText(err)}`)
  }
}

/** 彻底删除，不可恢复 —— 调用方必须先二次确认 */
export async function purgeNote(id: string): Promise<void> {
  try {
    await invoke<'notes', 'purge', { id: string }, unknown>('notes', 'purge', { id })
    if (state.noteDraft?.id === id) setState({ noteDraft: null, noteDirty: false })
    await loadNotes()
    toast.ok('已彻底删除')
  } catch (err) {
    toast.error(`彻底删除失败：${errorText(err)}`)
  }
}

export async function saveNoteFolder(name: string, parentId?: string): Promise<void> {
  try {
    await invoke<'notes', 'saveFolder', Record<string, unknown>, unknown>('notes', 'saveFolder', {
      name,
      ...(parentId ? { parentId } : {}),
    })
    await loadNoteFolders()
    toast.ok(`已创建文件夹「${name}」`)
  } catch (err) {
    toast.error(`创建文件夹失败：${errorText(err)}`)
  }
}

/**
 * 删除文件夹。
 * 主进程的语义是**笔记不删，只解除归属**，所以这里要把这件事明确告诉用户，
 * 否则用户会以为笔记跟着没了。
 */
export async function removeNoteFolder(id: string): Promise<void> {
  try {
    const res = await invoke<
      'notes',
      'deleteFolder',
      { id: string },
      { deletedFolders: string[]; detachedNotes: number }
    >('notes', 'deleteFolder', { id })
    await Promise.all([loadNoteFolders(), loadNotes()])
    toast.ok(`已删除 ${res.deletedFolders.length} 个文件夹，${res.detachedNotes} 条笔记回到未分类（未删除）`)
  } catch (err) {
    toast.error(`删除文件夹失败：${errorText(err)}`)
  }
}

/* ────────────────────────────────────────────── 会话日志 */

/**
 * 拉取日志列表与正在录制的会话。
 *
 * 录制中会有实时字节数，但没有对应事件，所以录制期间用一个 2s 的轮询刷新指示器
 * （只在真的有录制时轮询，平时零开销）。
 */
export async function loadSessionLogs(): Promise<void> {
  setState({ logsLoading: true })
  try {
    const res = await invoke<
      'sessionlog',
      'list',
      Record<string, never>,
      { logs: RecordingSummary[]; active: ActiveRecording[] }
    >('sessionlog', 'list', {})
    setState({
      sessionLogs: Array.isArray(res?.logs) ? res.logs : [],
      activeRecordings: Array.isArray(res?.active) ? res.active : [],
      logsLoading: false,
      logsReady: true,
      logsError: null,
    })
    syncLogPolling()
  } catch (err) {
    setState({ logsLoading: false, logsReady: false, logsError: errorText(err) })
  }
}

let logPollTimer: number | undefined

/** 有录制才轮询，停止后立刻收掉定时器 */
function syncLogPolling(): void {
  const need = state.activeRecordings.length > 0
  if (need && logPollTimer === undefined) {
    logPollTimer = window.setInterval(() => {
      void refreshActiveRecordings()
    }, 2000)
  } else if (!need && logPollTimer !== undefined) {
    window.clearInterval(logPollTimer)
    logPollTimer = undefined
  }
}

async function refreshActiveRecordings(): Promise<void> {
  try {
    const res = await invoke<
      'sessionlog',
      'list',
      Record<string, never>,
      { logs: RecordingSummary[]; active: ActiveRecording[] }
    >('sessionlog', 'list', {})
    setState({ activeRecordings: Array.isArray(res?.active) ? res.active : [] })
    syncLogPolling()
  } catch {
    /* 轮询失败静默，不打扰用户 */
  }
}

/** 某个会话是否正在录制 */
export function recordingOf(sessionId: string | undefined): ActiveRecording | undefined {
  if (!sessionId) return undefined
  return state.activeRecordings.find((r) => r.sessionId === sessionId)
}

export async function startSessionLog(sessionId: string, title?: string): Promise<void> {
  try {
    await invoke<'sessionlog', 'start', Record<string, unknown>, { logId: string }>(
      'sessionlog',
      'start',
      title === undefined ? { sessionId } : { sessionId, title },
    )
    await loadSessionLogs()
    toast.warn('已开始记录会话日志 —— 命令中的密码、token 会原样落盘，注意文件安全')
  } catch (err) {
    toast.error(`开始记录失败：${errorText(err)}`)
  }
}

export async function stopSessionLog(sessionId?: string): Promise<void> {
  try {
    const res = await invoke<'sessionlog', 'stop', Record<string, unknown>, { stopped: string[] }>(
      'sessionlog',
      'stop',
      sessionId === undefined ? {} : { sessionId },
    )
    await loadSessionLogs()
    toast.ok(sessionId ? '已停止记录该会话' : `已停止 ${res?.stopped?.length ?? 0} 个会话的录制`)
  } catch (err) {
    toast.error(`停止记录失败：${errorText(err)}`)
  }
}

export async function deleteSessionLog(logId: string): Promise<void> {
  try {
    await invoke<'sessionlog', 'delete', { logId: string }, unknown>('sessionlog', 'delete', { logId })
    await loadSessionLogs()
    toast.ok('日志已删除')
  } catch (err) {
    toast.error(`删除失败：${errorText(err)}`)
  }
}

export async function loadRecordingSettings(): Promise<void> {
  try {
    const res = await invoke<'sessionlog', 'getSettings', Record<string, never>, RecordingSettings>(
      'sessionlog',
      'getSettings',
      {},
    )
    setState({ recordingSettings: res })
  } catch {
    // 录制设置不可用不影响日志列表
  }
}

export async function saveRecordingSettings(patch: Partial<RecordingSettings>): Promise<void> {
  try {
    const next = await invoke<'sessionlog', 'setSettings', Record<string, unknown>, RecordingSettings>(
      'sessionlog',
      'setSettings',
      patch,
    )
    setState({ recordingSettings: next })
    // 主进程会把 <1000ms 的间隔抬到 1000，如实告诉用户实际生效值
    if (patch.intervalMs !== undefined && next.intervalMs !== patch.intervalMs) {
      toast.info(`快照间隔已调整为 ${next.intervalMs} ms（下限 1000ms）`)
    }
  } catch (err) {
    toast.error(`保存录制设置失败：${errorText(err)}`)
  }
}

/** 分页读取。默认从尾部读（最新内容），向上翻页用返回的 offset。 */
export async function readSessionLog(
  logId: string,
  opts: { offset?: number; limit?: number; fromEnd?: boolean } = {},
): Promise<LogReadResult | null> {
  try {
    return await invoke<'sessionlog', 'read', Record<string, unknown>, LogReadResult>(
      'sessionlog',
      'read',
      { logId, ...opts },
    )
  } catch (err) {
    toast.error(`读取日志失败：${errorText(err)}`)
    return null
  }
}

/* ────────────────────────────────────────────── 广播组 */

export async function loadBroadcastGroups(): Promise<void> {
  try {
    const groups = await invoke<'broadcast', 'list', Record<string, never>, BroadcastGroupView[]>(
      'broadcast',
      'list',
      {},
    )
    setState({ broadcastGroups: Array.isArray(groups) ? groups : [] })
  } catch {
    // broadcast 域不可用时静默：它只是增强能力，不该影响主流程
  }
}

export function broadcastGroupOf(sessionId: string | undefined): BroadcastGroupView | undefined {
  if (!sessionId) return undefined
  return state.broadcastGroups.find((g) => g.members.some((m) => m.sessionId === sessionId))
}

/** 用一批已建立的会话创建广播组；返回 groupId 或 null */
export async function createBroadcastGroup(
  sessionIds: string[],
  name?: string,
): Promise<string | null> {
  if (sessionIds.length === 0) return null
  try {
    const res = await invoke<
      'broadcast',
      'create',
      Record<string, unknown>,
      { group: BroadcastGroupView; skipped: string[] }
    >('broadcast', 'create', name === undefined ? { sessionIds } : { sessionIds, name })
    await loadBroadcastGroups()
    if (res?.skipped?.length) {
      toast.warn(`${res.skipped.length} 个会话未加入广播组（可能已断开）`)
    }
    return res?.group?.groupId ?? null
  } catch (err) {
    toast.error(`创建广播组失败：${errorText(err)}`)
    return null
  }
}

export async function dissolveBroadcastGroup(groupId: string): Promise<void> {
  try {
    await invoke<'broadcast', 'dissolve', { groupId: string }, unknown>('broadcast', 'dissolve', {
      groupId,
    })
    await loadBroadcastGroups()
    toast.ok('广播组已解散（各会话恢复独立）')
  } catch (err) {
    toast.error(`解散失败：${errorText(err)}`)
  }
}

export async function setBroadcastMode(
  groupId: string,
  mode: 'independent' | 'broadcast',
): Promise<void> {
  try {
    await invoke<'broadcast', 'setMode', { groupId: string; mode: string }, unknown>(
      'broadcast',
      'setMode',
      { groupId, mode },
    )
    await loadBroadcastGroups()
  } catch (err) {
    toast.error(`切换模式失败：${errorText(err)}`)
  }
}

export async function addToBroadcastGroup(groupId: string, sessionIds: string[]): Promise<void> {
  if (sessionIds.length === 0) return
  try {
    await invoke<'broadcast', 'add', Record<string, unknown>, unknown>('broadcast', 'add', {
      groupId,
      sessionIds,
    })
    await loadBroadcastGroups()
  } catch (err) {
    toast.error(`加入广播组失败：${errorText(err)}`)
  }
}

/**
 * 广播输入。
 *
 * 注意：**独立模式下 send 会抛错**（后端不是静默丢弃），
 * 所以调用方必须先判断模式 —— 这里也兜一层，把错误如实告诉用户，
 * 而不是让它看起来"输入丢了"。
 */
/**
 * 多选并发打开：逐个建立会话，然后把它们组成一个广播组（默认**独立模式**）。
 *
 * 默认独立而不是广播：用户只是想"一次开好几台"时，不应该一上来就把输入打到所有机器。
 * 切到广播必须是一次显式操作 —— 这是安全事故与便利的分界线。
 */
export async function connectManyAsGroup(connections: UiConnection[]): Promise<void> {
  const sessionIds: string[] = []
  for (const c of connections) {
    if (c.kind !== 'ssh' && c.kind !== 'telnet') {
      toast.info(`${c.name}：${c.kind.toUpperCase()} 工作区尚未接入，已跳过`)
      continue
    }
    await connectTo(c)
    // connectTo 不返回 sessionId，从落库后的标签里取
    const tab = [...state.tabs].reverse().find((t) => t.connectionId === c.id && t.sessionId)
    if (tab?.sessionId) sessionIds.push(tab.sessionId)
  }
  if (sessionIds.length === 0) return
  const groupId = await createBroadcastGroup(sessionIds, `${connections.length} 台并发`)
  if (groupId) {
    toast.ok(`已打开 ${sessionIds.length} 个会话并归为一组（当前独立模式，切到广播后输入会同步）`)
  }
}

export async function sendBroadcast(groupId: string, data: string): Promise<BroadcastSendResult | null> {
  try {
    const res = await invoke<'broadcast', 'send', { groupId: string; data: string }, BroadcastSendResult>(
      'broadcast',
      'send',
      { groupId, data },
    )
    setState((s) => ({
      broadcastLastSend: { ...s.broadcastLastSend, [groupId]: res },
    }))
    return res
  } catch (err) {
    toast.error(`广播发送失败：${errorText(err)}`)
    return null
  }
}

export function setSessionCwd(sessionId: string, path: string): void {
  setState((s) => {
    if (s.sessionCwd[sessionId] === path) return {} // 同一个值不触发更新
    return { sessionCwd: { ...s.sessionCwd, [sessionId]: path } }
  })
}

/* ────────────────────────────────────────────── 会话写入 */

/**
 * 往会话写数据 —— **唯一**知道各域载荷字段名不同的地方。
 *
 * ssh / telnet 用 `sessionId`，pty 用 `ptyId`。
 * 之前这段逻辑散在 TerminalPane 里，一旦有一处写成 `sessionId`，
 * 本地终端就会"能显示但打不了字"（zod 拒绝 + 被 catch 吞掉）。
 * 收敛到这里之后，快速命令面板等调用方不必再关心这个差异。
 */
export function sessionWritePayload(
  kind: TabKind,
  sessionId: string,
  data: string,
): { domain: 'ssh' | 'telnet' | 'pty'; payload: Record<string, unknown> } {
  if (kind === 'local') return { domain: 'pty', payload: { ptyId: sessionId, data } }
  if (kind === 'telnet') return { domain: 'telnet', payload: { sessionId, data } }
  return { domain: 'ssh', payload: { sessionId, data } }
}

export async function writeToSession(kind: TabKind, sessionId: string, data: string): Promise<void> {
  if (!sessionId || !data) return
  const { domain, payload } = sessionWritePayload(kind, sessionId, data)
  await invoke(domain, 'write', payload)
}

/* ────────────────────────────────────────────── 终端标签 */

let tabSeq = 0

function makeTab(
  partial: Omit<TerminalTab, 'tabId' | 'createdAt' | 'layout' | 'monitorOpen' | 'filesOpen' | 'encoding' | 'mode'> & {
    encoding?: TerminalEncoding
  },
): TerminalTab {
  tabSeq += 1
  return {
    tabId: `tab-${tabSeq}`,
    createdAt: Date.now(),
    layout: 'single',
    monitorOpen: false,
    filesOpen: true,
    mode: 'terminal',
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
    // ssh 是 disconnect({sessionId})，pty 是 close({ptyId}) —— 动作名与字段名都不同
    if (tab.kind === 'ssh') {
      void invoke('ssh', 'disconnect', { sessionId: tab.sessionId }).catch(() => undefined)
    } else if (tab.kind === 'telnet') {
      void invoke('telnet', 'disconnect', { sessionId: tab.sessionId }).catch(() => undefined)
    } else if (tab.kind === 'vnc') {
      void invoke('vnc', 'disconnect', { sessionId: tab.sessionId }).catch(() => undefined)
    } else if (tab.kind === 'rdp') {
      void invoke('rdp', 'disconnect', { sessionId: tab.sessionId }).catch(() => undefined)
    } else if (tab.kind === 'tunnel') {
      void invoke('forward', 'close', { tunnelId: tab.sessionId }).catch(() => undefined)
    } else {
      void invoke('pty', 'close', { ptyId: tab.sessionId }).catch(() => undefined)
    }
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

export function setTabMode(tabId: string, mode: 'terminal' | 'sftp'): void {
  updateTab(tabId, { mode })
}

export function toggleTabMonitor(tabId: string): void {
  const tab = state.tabs.find((t) => t.tabId === tabId)
  if (!tab) return
  updateTab(tabId, { monitorOpen: !tab.monitorOpen })
}

export function toggleTabFiles(tabId: string): void {
  const tab = state.tabs.find((t) => t.tabId === tabId)
  if (!tab) return
  updateTab(tabId, { filesOpen: !tab.filesOpen })
}

/**
 * 打开一个连接的工作区。
 *
 * 注意：这里只负责「建标签 + 发起连接」，后续状态完全由 SSH_STATE 事件驱动，
 * 不在渲染层做乐观状态猜测——否则事件与本地状态会互相打架。
 */
export async function connectTo(connection: UiConnection): Promise<void> {

  // 幂等：同一连接已经在连接中/已连接时，只把焦点切过去，不再发起第二次握手。
  // 重复点击、双击、批量操作叠加都不会产生多余会话——每个多余会话在远端都是一次真实登录。
  const alive = state.tabs.find(
    (t) =>
      t.connectionId === connection.id &&
      (t.state === 'connecting' || t.state === 'authenticating' || t.state === 'ready'),
  )
  if (alive) {
    setState({ activeTabId: alive.tabId, view: 'console' })
    return
  }

  const kind: TabKind =
    connection.kind === 'telnet'
      ? 'telnet'
      : connection.kind === 'vnc'
        ? 'vnc'
        : connection.kind === 'rdp'
          ? 'rdp'
          : connection.kind === 'tunnel'
            ? 'tunnel'
            : 'ssh'

  const tab = makeTab({
    kind,
    title: connection.name,
    subtitle: connectionAddress(connection),
    connectionId: connection.id,
    state: 'connecting',
    // telnet 连接没有 options.encoding（是另一个类型），只有 ssh 才有
    encoding:
      (connection.kind === 'ssh' ? (connection.options?.encoding as TerminalEncoding) : undefined) ??
      'utf-8',
  })
  setState((s) => ({ tabs: [...s.tabs, tab], activeTabId: tab.tabId, view: 'console' }))

  try {
    if (connection.kind === 'vnc') {
      const res = await invoke<'vnc', 'connect', { connection: UiConnection }, { sessionId: string }>(
        'vnc',
        'connect',
        { connection },
      )
      if (res?.sessionId) {
        updateTab(tab.tabId, { sessionId: res.sessionId, state: 'ready' })
        touchConnection(connection.id)
      }
      return
    }

    if (connection.kind === 'rdp') {
      // 失败时**必须保留原文**：缺 FreeRDP 的报错里带安装命令，要在界面上原样展示
      const res = await invoke<'rdp', 'connect', { connection: UiConnection }, { sessionId: string }>(
        'rdp',
        'connect',
        { connection },
      )
      if (res?.sessionId) {
        updateTab(tab.tabId, { sessionId: res.sessionId, state: 'ready' })
        touchConnection(connection.id)
      }
      return
    }

    if (connection.kind === 'tunnel') {
      const res = await invoke<
        'forward',
        'open',
        { tunnel: UiConnection },
        { tunnelId: string }
      >('forward', 'open', { tunnel: connection })
      if (res?.tunnelId) {
        // 隧道用运行期 tunnelId 当作会话标识，后续 close/状态事件都按它匹配
        updateTab(tab.tabId, { sessionId: res.tunnelId, state: 'ready' })
        touchConnection(connection.id)
      }
      return
    }

    // Telnet 没有 shell 通道，但对接网络设备的用法和终端一致，所以复用同一套标签/终端
    const res = await invoke<
      'ssh' | 'telnet',
      'connect',
      { connection: UiConnection },
      { sessionId: string }
    >(connection.kind === 'telnet' ? 'telnet' : 'ssh', 'connect', { connection })
    if (res?.sessionId) {
      // 连接即开监控：采集脚本自动上传（collector 做版本比对，只传一次）并开始拉数据，
      // 右栏只是它的展示面 —— 不因面板开着与否决定采不采集
      updateTab(tab.tabId, { sessionId: res.sessionId, state: 'ready', monitorOpen: true })
      void startMonitor(res.sessionId)
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

/* ────────────────────────────────────────────── 延迟探测 */

/** 节流窗口：列表刷新不该每次都打一轮探测（探测是真实网络 IO） */
const PING_THROTTLE_MS = 15_000
let lastProbeAt = 0

/**
 * 探测连接延迟。
 *
 * 走 `app.pingMany` **一次 IPC 拿整批**，而不是循环调 ping：
 * 1000 条连接循环调用会产生 1000 次 IPC 往返，批量接口一次就够。
 * 默认带节流，多次触发（刷新、排序、切分组）不会把网络打满。
 *
 * 刻意**不在启动时自动探测**：应用启动不该产生用户没要求的网络流量。
 * 由工具条的「探测延迟」按钮或刷新动作显式触发。
 */
export async function probeLatency(ids?: string[], force = false): Promise<void> {
  const now = Date.now()
  if (!force && now - lastProbeAt < PING_THROTTLE_MS) return

  // tunnel 没有单一 host，不参与探测
  const targets = state.connections
    .filter((c) => c.kind !== 'tunnel' && (ids === undefined || ids.includes(c.id)))
    .filter((c): c is UiConnection & { host: string; port: number } => 'host' in c && 'port' in c)

  if (targets.length === 0) return
  lastProbeAt = now
  setState({ pingBusy: true })

  try {
    const results = await invoke<'app', 'pingMany', { targets: Array<{ host: string; port?: number }> }, PingResult[]>(
      'app',
      'pingMany',
      { targets: targets.map((t) => ({ host: t.host, port: t.port })) },
    )
    const list = Array.isArray(results) ? results : []
    // 优先按 host:port 配对；对不上再退回下标（接口约定是同序返回）
    const byKey = new Map(list.map((r) => [`${r.host}:${r.port ?? ''}`, r]))
    const next: Record<string, PingEntry> = { ...state.pings }
    targets.forEach((t, i) => {
      const r = byKey.get(`${t.host}:${t.port}`) ?? list[i]
      if (!r) return
      next[t.id] = {
        reachable: r.reachable,
        latencyMs: r.latencyMs,
        method: r.method,
        ...(r.reason === undefined ? {} : { reason: r.reason }),
        at: Date.now(),
      }
    })
    setState({ pings: next, pingBusy: false })
  } catch (err) {
    setState({ pingBusy: false })
    toast.warn(`延迟探测不可用：${errorText(err)}`)
  }
}

/** 探测结果 → 展示文案。不可达（哨兵 9999）显示为「超时」而不是一个巨大的数字。 */
export function pingLabel(entry: PingEntry | undefined): string {
  if (!entry) return '—'
  if (!entry.reachable || entry.latencyMs >= LATENCY_UNREACHABLE) return '超时'
  return `${Math.round(entry.latencyMs)} ms`
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

  subscribe(Events.TELNET_STATE, (p) => {
    setState((s) => ({
      tabs: s.tabs.map((t) =>
        t.sessionId === p.sessionId ? { ...t, state: p.state, message: p.message } : t,
      ),
    }))
  })

  subscribe(Events.TELNET_CLOSED, (p) => {
    setState((s) => ({
      tabs: s.tabs.map((t) =>
        t.sessionId === p.sessionId
          ? { ...t, state: 'disconnected', message: p.reason ?? '连接已关闭' }
          : t,
      ),
    }))
  })

  // 选项协商：Telnet"连上却键盘没反应"几乎都是协商没谈拢，留着给 UI 定位
  subscribe(Events.TELNET_NEGOTIATION, (p) => {
    setState((s) => {
      const prev = s.negotiations[p.sessionId] ?? []
      const entry: NegotiationEntry = {
        option: p.option,
        optionName: p.optionName,
        direction: p.direction,
        accepted: p.accepted,
        ...(p.detail === undefined ? {} : { detail: p.detail }),
        at: Date.now(),
      }
      // 只保留最近 50 条，协商在连接期就结束了，不会无限增长
      return { negotiations: { ...s.negotiations, [p.sessionId]: [...prev, entry].slice(-50) } }
    })
  })

  subscribe(Events.BROADCAST_STATE, (p) => {
    setState({ broadcastGroups: Array.isArray(p.groups) ? p.groups : [] })
  })

  // 逐条上报的失败：汇总到列表，由工作区展示（避免 N 台失败刷 N 个 toast）
  subscribe(Events.BROADCAST_ERROR, (p) => {
    setState((s) => ({
      broadcastErrors: [
        { groupId: p.groupId, sessionId: p.sessionId, title: p.title, message: p.message, at: Date.now() },
        ...s.broadcastErrors,
      ].slice(0, 50),
    }))
  })

  subscribe(Events.VNC_STATE, (p) => {
    setState((s) => ({
      tabs: s.tabs.map((t) =>
        t.sessionId === p.sessionId ? { ...t, state: p.state, message: p.message } : t,
      ),
    }))
  })

  subscribe(Events.RDP_STATE, (p) => {
    setState((s) => ({
      tabs: s.tabs.map((t) =>
        t.sessionId === p.sessionId ? { ...t, state: p.state, message: p.message } : t,
      ),
    }))
  })

  // RDP 进程退出：外部窗口被关掉和崩溃是两件事，措辞在视图里区分
  subscribe(Events.RDP_EXIT, (p) => {
    setState((s) => ({
      tabs: s.tabs.map((t) =>
        t.sessionId === p.sessionId
          ? {
              ...t,
              state: 'disconnected',
              message: p.crashed
                ? `远程桌面进程异常退出（code ${p.code ?? '—'}）`
                : '远程桌面窗口已关闭',
            }
          : t,
      ),
    }))
  })

  subscribe(Events.FORWARD_STATE, (p) => {
    setState((s) => ({
      tabs: s.tabs.map((t) =>
        t.sessionId === p.forwardId ? { ...t, state: p.state, message: p.message } : t,
      ),
    }))
  })

  subscribe(Events.FORWARD_ERROR, (p) => {
    setState((s) => ({
      tabs: s.tabs.map((t) =>
        t.sessionId === p.forwardId ? { ...t, state: 'failed', message: p.message } : t,
      ),
    }))
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
