// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * settings 域：应用设置的读写。
 *
 * 设置是**单文档**，整体存在 store 的 KV 里（`Settings` 实体，item_id = 'app'）。
 * 与连接不同，设置不含机密，**无需解锁即可读写** —— 否则用户连主题都改不了。
 *
 * 写入采用「深合并 + 全文档回写」：调用方只传要改的路径，不必回传整个设置树，
 * 避免 UI 漏字段导致配置被清空。
 */

import { z } from 'zod'
import type {
  AiSettings,
  AppSettings,
  CompletionSettings,
  HighlightRule,
  HotkeyBinding,
  Settings,
  SyncSettings,
  TerminalSettings,
  TransferSettings,
  SecuritySettings,
} from '@t1000/shared'
import { AppError, parseInput } from '../../errors'
import type { IpcHandler } from '../../ipc/router'
import { createLogger } from '../../logger'
import { getStoreService } from '../store'
import { storeKeyOf } from '../store/db'

const log = createLogger('settings')

/** 设置文档在 KV 中的 item_id */
const SETTINGS_ITEM_ID = 'app'
/** 设置文档结构版本；将来迁移用 */
const SETTINGS_VERSION = 1

interface SettingsDoc {
  version: number
  data: Settings
}

// ── 默认值 ───────────────────────────────────────────

export const DEFAULT_APP_SETTINGS: AppSettings = {
  theme: 'system',
  language: 'zh-CN',
  restoreLastSession: true,
  minimizeToTray: false,
  showTrayIcon: true,
  autoCheckUpdate: true,
  updateChannel: 'stable',
  // 默认提示（不打扰与有更新知道之间，选让用户知道）
  updatePromptMode: 'prompt',
  // 遥测默认关闭（隐私优先）
  telemetry: false,
  // 开机自启默认关闭（不替用户决定开机行为）
  openAtLogin: false,
  // 关闭确认默认关闭（不额外打断）
  confirmOnClose: false,
  // 硬件加速默认开启（关掉会明显变慢，只有兼容性问题时才需要关）
  hardwareAcceleration: true,
  // 每日自动备份默认开启：这是**数据安全**项，默认保护更划算
  dailyBackup: true,
}

export const DEFAULT_SECURITY_SETTINGS: SecuritySettings = {
  // 默认不自动锁：不替用户决定"多久没操作就锁屏"
  autoLockMinutes: 0,
  // spec：备份保留 7 天
  backupRetentionDays: 7,
}

export const DEFAULT_TERMINAL_SETTINGS: TerminalSettings = {
  // 对齐用户 kitty.conf：MesloLGS NF 12pt、beam 光标、背景透明 0.88、
  // padding 12、scrollback 50000、Catppuccin 配色（theme.ts 同源）
  fontFamily: "'MesloLGS NF', 'JetBrains Mono', 'Cascadia Code', Menlo, Consolas, monospace",
  fontSize: 12,
  lineHeight: 1.2,
  letterSpacing: 0,
  cursorStyle: 'bar',
  cursorBlink: true,
  copyOnSelect: true,
  rightClickPaste: false,
  scrollback: 50000,
  // 默认关闭：斑马纹是辅助，不该替用户改变默认观感
  zebraStripes: false,
  wrapLines: true,
  bell: 'none',
  defaultEncoding: 'utf-8',
  colorScheme: 'default-dark',
  linkDetection: true,

  // 0.2.0：kitty 内核 + 自绘 WebGL2。失败会自动回落 xterm（窗格会提示原因）
  renderer: 'kitty',
  fontWeight: 450,
  boldWeight: 700,
  fontFeatures: [],
  ligatures: true,
  padding: 12,
  backgroundOpacity: 0.88,
  cursorOpacity: 1,
  cursorInactiveStyle: 'outline',
  wheelMultiplier: 3,
  selectionBackground: '#F5E0DC',
  selectionForeground: '#1E1E2E',
  underlineColor: '',
  kittyGraphics: true,
  // 光标拖尾（kitty cursor_trail 3）：0 关闭
  cursorTrail: 3,
  // 空数组 = 用配色方案自带的 16 色
  palette: [],
  termType: 'xterm-kitty',
}

export const DEFAULT_COMPLETION_SETTINGS: CompletionSettings = {
  enabled: true,
  specCompletion: true,
  historyCompletion: true,
  // 生成式补全会起后台进程，默认关闭
  generatorCompletion: false,
  aiSuggestion: false,
  debounceMs: 80,
  maxSuggestions: 20,
}

export const DEFAULT_AI_SETTINGS: AiSettings = {
  providers: [],
  mode: 'chat',
  // 默认不允许执行命令（安全默认，用户显式开启）
  allowExecution: false,
  riskPolicy: {
    readOnlyAllowlist: [],
    dangerousDenylist: [],
    confirmSudo: true,
  },
  limits: {
    maxRounds: 20,
    maxCommands: 50,
    maxTargets: 5,
  },
}

export const DEFAULT_TRANSFER_SETTINGS: TransferSettings = {
  maxInflightPerConnection: 4,
  progressThrottleMs: 200,
  conflictPolicy: 'ask',
  preservePermissions: true,
  preserveTimestamps: false,
}

export const DEFAULT_SYNC_SETTINGS: SyncSettings = {
  enabled: false,
  autoSync: false,
  conflictPolicy: 'keep-newest',
  scopes: {
    connections: true,
    groups: true,
    credentials: true,
    notes: true,
    settings: true,
  },
}

export const DEFAULT_HIGHLIGHTS: HighlightRule[] = [
  {
    id: 'builtin-error',
    name: '错误关键字',
    pattern: '\\b(error|failed|fatal|exception|denied|refused)\\b',
    flags: 'gi',
    foreground: '#e5484d',
    priority: 10,
    enabled: true,
    builtin: true,
  },
  {
    id: 'builtin-warn',
    name: '警告关键字',
    pattern: '\\b(warn|warning|deprecated|retry)\\b',
    flags: 'gi',
    foreground: '#d9a441',
    priority: 9,
    enabled: true,
    builtin: true,
  },
  {
    id: 'builtin-ok',
    name: '成功关键字',
    pattern: '\\b(ok|success|done|passed|active\\s*\\(running\\))\\b',
    flags: 'gi',
    foreground: '#46b17b',
    priority: 8,
    enabled: true,
    builtin: true,
  },
  {
    id: 'builtin-ip',
    name: 'IPv4 地址',
    pattern: '\\b(?:\\d{1,3}\\.){3}\\d{1,3}\\b',
    flags: 'g',
    foreground: '#3ec9d6',
    priority: 6,
    enabled: true,
    builtin: true,
  },
]

export const DEFAULT_HOTKEYS: HotkeyBinding[] = [
  { id: 'hk-new-tab', command: 'terminal.newTab', accelerator: 'Ctrl+Shift+T', global: false, enabled: true },
  { id: 'hk-close-tab', command: 'terminal.closeTab', accelerator: 'Ctrl+Shift+W', global: false, enabled: true },
  { id: 'hk-find', command: 'terminal.find', accelerator: 'Ctrl+Shift+F', global: false, enabled: true },
  { id: 'hk-clear', command: 'terminal.clear', accelerator: 'Ctrl+Shift+L', global: false, enabled: true },
  { id: 'hk-split-h', command: 'terminal.splitHorizontal', accelerator: 'Ctrl+Shift+D', global: false, enabled: true },
  { id: 'hk-split-v', command: 'terminal.splitVertical', accelerator: 'Ctrl+Shift+E', global: false, enabled: true },
  { id: 'hk-toggle-window', command: 'app.toggleWindow', accelerator: 'Ctrl+Shift+Space', global: true, enabled: false },
]

/** 完整默认设置 */
export function defaultSettings(): Settings {
  return {
    app: { ...DEFAULT_APP_SETTINGS },
    security: { ...DEFAULT_SECURITY_SETTINGS },
    terminal: { ...DEFAULT_TERMINAL_SETTINGS },
    completion: { ...DEFAULT_COMPLETION_SETTINGS },
    highlights: DEFAULT_HIGHLIGHTS.map((r) => ({ ...r })),
    ai: structuredClone(DEFAULT_AI_SETTINGS),
    transfer: { ...DEFAULT_TRANSFER_SETTINGS },
    hotkeys: DEFAULT_HOTKEYS.map((k) => ({ ...k })),
    sync: structuredClone(DEFAULT_SYNC_SETTINGS),
  }
}

// ── 合并逻辑 ─────────────────────────────────────────

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * 深合并：只覆盖 patch 里出现的键。
 * 数组整体替换（不逐项合并）—— 列表语义上替换更符合直觉。
 */
export function deepMerge<T>(base: T, patch: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(patch)) {
    return (patch === undefined ? base : patch) as T
  }
  const out: Record<string, unknown> = { ...base }
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue
    const cur = out[k]
    out[k] = isPlainObject(cur) && isPlainObject(v) ? deepMerge(cur, v) : v
  }
  return out as T
}

/** 读/写点分路径 */
function getPath(obj: unknown, path: string): unknown {
  const parts = path.split('.').filter(Boolean)
  let cur: unknown = obj
  for (const p of parts) {
    if (!isPlainObject(cur)) return undefined
    cur = cur[p]
  }
  return cur
}

function setPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.').filter(Boolean)
  if (parts.length === 0) throw AppError.badRequest('设置路径不能为空')

  let cur: Record<string, unknown> = obj
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i]!
    const next = cur[p]
    if (!isPlainObject(next)) {
      cur[p] = {}
    }
    cur = cur[p] as Record<string, unknown>
  }
  cur[parts[parts.length - 1]!] = value
}

// ── 持久化 ───────────────────────────────────────────

/**
 * 外观迁移到 **v3：分组不透明度 + 背景三件套**。
 *
 * v1/v2 只有「背景可见度」一个旋钮，语义是「表面 alpha = 1 - v × 0.9」。
 * v3 起透明度按组件组拆开（面板/侧边栏/弹窗/浮层/输入框/代码块各一个），
 * 背景层则有「不透明度 / 模糊 / 遮罩」三件套。
 *
 * 迁移目标：**保持用户当前观感**，不突然变样 ——
 * 旧的 v 换算成 panel/sidebar 的 alpha（同一个公式），背景媒体层改为满强度
 * （v=0 时表示用户不想看壁纸 → 媒体不透明度 0），其余组给实色默认值。
 *
 * 判定用显式的 `app.appearanceRev` 版本戳，**不能**用字段存在性：
 * writeDoc 会盖戳，所以写过的文档不会再迁移（否则用户调完重启就被重置）。
 */
const APPEARANCE_REV = 3

function migrateAppearance(data: Record<string, unknown>): boolean {
  const app = data.app
  if (!isPlainObject(app)) return false
  if (app.appearanceRev === APPEARANCE_REV) return false
  const ap = app.appearance
  if (!isPlainObject(ap)) {
    // 全新安装：没有外观配置，不需要改值，只需盖章
    app.appearanceRev = APPEARANCE_REV
    return true
  }

  // v1/v2 的「可见度」语义：把旧值换算成面板/侧边栏 alpha，保住当前观感
  const legacy = typeof ap.backgroundOpacity === 'number' ? ap.backgroundOpacity : null
  const hasGroups = typeof ap.panelOpacity === 'number'
  if (legacy !== null && !hasGroups) {
    const v = Math.min(1, Math.max(0, legacy))
    // 旧公式：surface = 1 - v × 0.9；下限 15% 避免面板完全消失
    const surface = Math.min(1, Math.max(0.15, 1 - v * 0.9))
    ap.panelOpacity = surface
    ap.sidebarOpacity = surface
    // 旧值 0 = 用户不想看壁纸 → 新语义下就是媒体不透明度 0
    ap.backgroundOpacity = v <= 0.001 ? 0 : 1
    /*
     * 遮罩必须给 0：旧模型里没有这一层，壁纸看到多少就是多少。
     * 如果迁移时塞上默认的 0.35，老用户的壁纸会凭空被盖掉三成
     * （可见量 1-0.775=22.5% 再乘 (1-0.35) ≈ 14.6%，明显变淡）。
     * 保持 0 才能让「升完级一看还是原来那样」成立；新装才用 0.35。
     */
    ap.backgroundScrim = 0
  }

  if (typeof ap.backgroundOpacity !== 'number') ap.backgroundOpacity = 1
  if (typeof ap.backgroundBlur !== 'number') ap.backgroundBlur = 5
  if (typeof ap.backgroundScrim !== 'number') ap.backgroundScrim = 0.35
  if (typeof ap.panelOpacity !== 'number') ap.panelOpacity = 0.72
  if (typeof ap.sidebarOpacity !== 'number') ap.sidebarOpacity = 0.72
  // 浮层默认实色：半透明会让壁纸与文字抢对比度
  if (typeof ap.modalOpacity !== 'number') ap.modalOpacity = 1
  if (typeof ap.menuOpacity !== 'number') ap.menuOpacity = 1
  if (typeof ap.inputOpacity !== 'number') ap.inputOpacity = 1
  if (typeof ap.codeOpacity !== 'number') ap.codeOpacity = 1
  if (typeof ap.glassBlur !== 'number') ap.glassBlur = 8
  if (typeof ap.accentStrength !== 'number') ap.accentStrength = 0.22
  // 已合并/废弃的第二、第三个透明度旋钮
  delete ap.opacity
  app.appearanceRev = APPEARANCE_REV
  return true
}

function readDoc(): Settings {
  const db = getStoreService().db
  const row = db.get(storeKeyOf('Settings'), SETTINGS_ITEM_ID)
  if (!row) return defaultSettings()

  try {
    const parsed = JSON.parse(row.payload) as Partial<SettingsDoc>
    // 与默认值深合并：旧版本新增的设置项会自动补齐，不会因缺字段而 undefined
    const data = parsed.data ?? {}
    if (migrateAppearance(data as Record<string, unknown>)) {
      const migrated = deepMerge(defaultSettings(), data)
      // 落盘：避免每次启动都用内存里的迁移值、而设置面板显示旧值
      writeDoc(migrated)
      log.info('外观设置已迁移到 v2（单滑杆 + 背景模糊）')
      return migrated
    }
    return deepMerge(defaultSettings(), data)
  } catch (err) {
    log.warn('设置文档损坏，回退默认值', err)
    return defaultSettings()
  }
}

function writeDoc(settings: Settings): void {
  const db = getStoreService().db
  // v2 代码写出的文档一律盖戳：这样迁移只发生一次，之后用户把可见度调成
  // 任何值都不会在下次启动被重置（判定依据见 migrateAppearance）
  const app = (settings as { app?: unknown }).app
  if (isPlainObject(app) && isPlainObject(app.appearance)) app.appearanceRev = APPEARANCE_REV
  const doc: SettingsDoc = { version: SETTINGS_VERSION, data: settings }
  const now = Date.now()
  db.put(storeKeyOf('Settings'), SETTINGS_ITEM_ID, JSON.stringify(doc), now)
}

// 内存缓存的文档快照：设置读多写少，避免每次读都 JSON.parse
let cache: Settings | null = null

export function getSettings(): Settings {
  if (!cache) cache = readDoc()
  return cache
}

/** 允许部分更新的设置补丁类型 */
export type SettingsPatch = {
  [K in keyof Settings]?: Settings[K] extends readonly unknown[]
    ? Settings[K]
    : Settings[K] extends object
      ? Partial<Settings[K]>
      : Settings[K]
}

/**
 * 以补丁方式更新设置（深合并 + 持久化 + 刷新缓存）。
 *
 * 供其它服务使用（如 sync 保存服务地址与令牌）。
 * 之所以不直接读写 KV：设置文档的形状（item_id、`{version, data}` 包装）
 * 是 settings 域的私有知识，暴露出去会让两处实现各自漂移。
 */
export function updateSettings(patch: SettingsPatch): Settings {
  const next = deepMerge(getSettings(), patch)
  writeDoc(next)
  cache = next
  return next
}

/** 测试用：清掉内存缓存，强制从磁盘重读 */
export function resetSettingsCache(): void {
  cache = null
}

// ── 录制设置（分组形状由 sessionlog 域定义）─────────────

/** 设置文档里存放会话录制设置的分组名 */
export const RECORDING_SETTINGS_GROUP = 'sessionRecording'

/**
 * 读会话录制设置分组。
 *
 * 为什么不并进 `SettingsPatch`：`Settings` 的形状在 `packages/shared`（lead 维护），
 * 目前还没有录制分组。设置文档的深合并会**保留未知键**，所以先把
 * `sessionRecording` 存在同一个设置文档里 —— 这样设置域仍是设置文档的唯一写入者，
 * 等 shared 加上这一组后把这两个函数换成强类型访问即可，调用方不用改。
 */
export function readRecordingSettings(): Record<string, unknown> | undefined {
  const raw = (getSettings() as unknown as Record<string, unknown>)[RECORDING_SETTINGS_GROUP]
  return isPlainObject(raw) ? raw : undefined
}

/** 合并写回会话录制设置分组（只覆盖传入的键） */
export function updateRecordingSettings(patch: Record<string, unknown>): Record<string, unknown> {
  const current = getSettings() as unknown as Record<string, unknown>
  const existing = current[RECORDING_SETTINGS_GROUP]
  const group = isPlainObject(existing) ? existing : {}
  const nextGroup: Record<string, unknown> = { ...group, ...patch }
  const next = { ...current, [RECORDING_SETTINGS_GROUP]: nextGroup } as unknown as Settings
  writeDoc(next)
  cache = next
  return nextGroup
}

// ── IPC ─────────────────────────────────────────────

const setSchema = z.object({
  path: z.string().min(1),
  value: z.unknown(),
})

const getSchema = z.object({
  path: z.string().min(1),
})

const resetSchema = z.object({
  /** 只重置某一棵子树；不传则全量重置 */
  section: z.enum(['app', 'terminal', 'termStyle', 'completion', 'highlights', 'ai', 'transfer', 'hotkeys', 'sync']).optional(),
})

export const settingsHandlers: Record<string, IpcHandler> = {
  getAll: () => getSettings(),

  get: (payload) => {
    const { path } = parseInput(getSchema, payload)
    return { path, value: getPath(getSettings(), path) }
  },

  /** 按点分路径写入；只覆盖该路径，其余保持不变 */
  set: (payload) => {
    const { path, value } = parseInput(setSchema, payload)
    const current = getSettings()

    // 用 patch 重建，保证不会因为调用方只传一个字段而丢掉整棵树
    const patch: Record<string, unknown> = {}
    setPath(patch, path, value)

    const next = deepMerge(current, patch)
    writeDoc(next)
    cache = next
    log.debug(`设置已更新: ${path}`)
    return next
  },

  reset: (payload) => {
    const { section } = parseInput(resetSchema, payload ?? {})
    const defaults = defaultSettings()

    let next: Settings
    if (section) {
      // termStyle 是纯界面分区（字段都落在 terminal.* 上），重置时映射回 terminal 组
      const group = section === 'termStyle' ? 'terminal' : section
      next = { ...getSettings(), [group]: defaults[group] } as Settings
    } else {
      next = defaults
    }

    writeDoc(next)
    cache = next
    log.info(section ? `设置已重置: ${section}` : '设置已全量重置')
    return next
  },
}
