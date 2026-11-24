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
import {
  Events,
  type AiSettings,
  type AppSettings,
  type CompletionSettings,
  type HighlightRule,
  type HotkeyBinding,
  type Settings,
  type SyncSettings,
  type TerminalSettings,
  type TransferSettings,
  type SecuritySettings,
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
  // kitty 的 middle release ungrabbed paste_from_selection 默认映射：X11 惯例默认开
  middleClickPaste: true,
  // Windows Terminal / VS Code 行为：Ctrl+C 有选区就复制（复制完清选区）、
  // 没选区照常发 SIGINT；Ctrl+V 粘贴。0.2.8 起默认开（老用户由
  // migrateClipboardKeys 按版本戳一次性迁移，见 readDoc）
  copyOnCtrlC: true,
  pasteOnCtrlV: true,
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
  // 助手默认称呼。曾是「问问小易」，与市面主流语音助手（如华为小艺等）撞名，
  // 改为一个自创词；设置 → AI 助手里可改。
  assistantName: '问问老菜',
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
  /*
   * ⚠️ 默认值的取舍原则：终端程序常用的按键**默认不抢**，想要的应用级功能去设置里打开。
   * - Ctrl+K 是 readline 的 kill-line（bash/zsh 删到行尾），默认关；
   * - Ctrl+Space 是 emacs/readline 的 set-mark，默认关；
   * - Ctrl+, 与 Ctrl+1..7 终端程序基本不用，默认开（保持 0.2.5 的行为，
   *   只是搬进了设置——用户现在可以关掉或改键）。
   * （Ctrl+C/Ctrl+V 例外：0.2.8 起默认接管，见 DEFAULT_TERMINAL_SETTINGS ——
   *   Ctrl+C 有选区才复制、没选区仍发 SIGINT，中断不受影响。）
   */
  { id: 'hk-open-settings', command: 'app.openSettings', accelerator: 'Ctrl+,', global: false, enabled: true },
  { id: 'hk-global-search', command: 'app.globalSearch', accelerator: 'Ctrl+K', global: false, enabled: false },
  { id: 'hk-completion', command: 'terminal.completion', accelerator: 'Ctrl+Space', global: false, enabled: false },
  { id: 'hk-view-connections', command: 'app.view.connections', accelerator: 'Ctrl+1', global: false, enabled: true },
  { id: 'hk-view-console', command: 'app.view.console', accelerator: 'Ctrl+2', global: false, enabled: true },
  { id: 'hk-view-notes', command: 'app.view.notes', accelerator: 'Ctrl+3', global: false, enabled: true },
  { id: 'hk-view-tools', command: 'app.view.tools', accelerator: 'Ctrl+4', global: false, enabled: true },
  { id: 'hk-view-ai', command: 'app.view.ai', accelerator: 'Ctrl+5', global: false, enabled: true },
  { id: 'hk-view-services', command: 'app.view.services', accelerator: 'Ctrl+6', global: false, enabled: true },
  { id: 'hk-view-logs', command: 'app.view.logs', accelerator: 'Ctrl+7', global: false, enabled: true },
]

/**
 * 快捷键迁移：老用户落库的 `hotkeys` 数组没有新版本加入的命令。
 * deepMerge 对数组是整体替换，不会自动补 —— 这里按 **command id** 缺哪补哪。
 *
 * 为什么能用「command 是否存在」判定而外观设置必须用版本戳（见 migrateAppearance）：
 * 快捷键只增不改语义，且绑定只能被禁用/清键、不能被删除 —— 按 command 补齐
 * 是幂等的加法，永远不会把用户的改动静掉。
 */
function migrateHotkeys(settings: Settings): boolean {
  const existing = settings.hotkeys ?? []
  const known = new Set(existing.map((b) => b.command))
  const missing = DEFAULT_HOTKEYS.filter((k) => !known.has(k.command))
  if (missing.length === 0) return false
  settings.hotkeys = [...existing, ...missing.map((k) => ({ ...k }))]
  return true
}

/*
 * 剪贴板键位迁移（0.2.8）：`copyOnCtrlC` / `pasteOnCtrlV` 出厂值从 false 翻成 true。
 *
 * 老用户配置里已经**显式落库**了 false —— 改默认值对 deepMerge 无效（用户值优先）。
 * 不能用「字段是否存在」判定（永远存在），必须像 migrateAppearance 一样盖版本戳：
 * `terminal.clipboardKeysRev` = 1 表示已经翻过，之后用户再手动关掉不会被重置。
 */
const CLIPBOARD_KEYS_REV = 1

function migrateClipboardKeys(settings: Settings): boolean {
  const t = settings.terminal
  if (!isPlainObject(t) || t.clipboardKeysRev === CLIPBOARD_KEYS_REV) return false
  const term = t as TerminalSettings
  term.copyOnCtrlC = true
  term.pasteOnCtrlV = true
  term.clipboardKeysRev = CLIPBOARD_KEYS_REV
  return true
}

/** 完整默认设置 */
export function defaultSettings(): Settings {  return {
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

/**
 * 全新安装时的外观初值。
 *
 * 必须与 renderer 的 `APPEARANCE_DEFAULTS` 保持一致（那里是渲染用的真源，
 * 这里是落库用的真源；主进程不能 import 渲染层代码，所以只能各存一份）。
 *
 * 为什么不能只靠渲染层兜底：设置界面读的是**文档里的值**，缺字段就显示 0 ——
 * 于是新装的用户会看到"界面明显是 72% 半透明，设置里却写着 0%"。
 * 早先这里只盖章不写值，面板上一排滑杆全归零就是这么来的。
 */
const FRESH_APPEARANCE: Record<string, unknown> = {
  preset: 'aurora',
  backgroundImage: '',
  backgroundOpacity: 1,
  backgroundBlur: 5,
  backgroundScrim: 0.35,
  panelOpacity: 0.72,
  sidebarOpacity: 0.72,
  modalOpacity: 1,
  menuOpacity: 1,
  inputOpacity: 1,
  codeOpacity: 1,
  glassBlur: 8,
  accentStrength: 0.22,
  scale: 1,
  backgroundType: 'none',
  backgroundColor: '#10141a',
  backgroundVideo: '',
  backgroundScript: '',
  backgroundFps: 30,
}

function migrateAppearance(data: Record<string, unknown>): boolean {
  const app = data.app
  if (!isPlainObject(app)) return false

  /*
   * 已经迁移过：只补**后来新增**的缺字段（老版 v3 文档缺 scale 之类）。
   * 幂等 —— 补完之后不再缺，就不会再写。
   */
  if (app.appearanceRev === APPEARANCE_REV) {
    const cur = app.appearance
    if (!isPlainObject(cur)) return false
    const missing = Object.keys(FRESH_APPEARANCE).filter((k) => !(k in cur))
    if (missing.length === 0) return false
    app.appearance = { ...FRESH_APPEARANCE, ...cur }
    return true
  }

  const raw = app.appearance
  const ap: Record<string, unknown> = isPlainObject(raw) ? { ...raw } : {}

  /*
   * v1/v2 的「可见度」换算必须在补默认值**之前**判定：
   * 先合并 FRESH 的话 panelOpacity 就已经存在，hasGroups 永远是 true，
   * 老用户的 0.25 会被当成"已经调好的分组 alpha"原样留下（壁纸直接糊满）。
   */
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

  // 已合并/废弃的旋钮
  delete ap.opacity

  // 缺什么补什么，已有的用户值优先
  app.appearance = { ...FRESH_APPEARANCE, ...ap }
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
    // 外观迁移**必须先于合并**：它靠原地改写 data.app.appearance 生效，
    // 先合并的话迁移值进不了结果。返回值只用来决定要不要落盘。
    const appearanceMigrated = migrateAppearance(data as Record<string, unknown>)
    const merged = deepMerge(defaultSettings(), data)
    const hotkeysMigrated = migrateHotkeys(merged)
    const clipboardMigrated = migrateClipboardKeys(merged)
    // 迁移命中任意一项都立即落盘：避免每次启动都用内存里的迁移值、而设置面板显示旧值
    if (appearanceMigrated || hotkeysMigrated || clipboardMigrated) {
      writeDoc(merged)
      if (appearanceMigrated) log.info('外观设置已迁移到 v2（单滑杆 + 背景模糊）')
      if (hotkeysMigrated) log.info('快捷键配置已补齐新版本命令')
      if (clipboardMigrated) log.info('剪贴板键位已迁移：Ctrl+C 复制 / Ctrl+V 粘贴 默认开启')
    }
    return merged
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

/**
 * 设置变更广播。任何写路径（IPC set/reset、其它服务的 updateSettings、
 * 迁移）改完设置都要发 —— 渲染层的 store 靠它热更新。
 *
 * 没有它，绕过设置界面直接 IPC 写设置时（同步、自动化探针、未来的 MCP
 * 工具），已打开的终端不会收到新值 —— 探针里实测：关掉 pasteOnCtrlV 后
 * Ctrl+V 仍然粘贴，因为 termSettingsRef 还是旧值。
 *
 * 动态 import window：settings ↔ hotkey ↔ window 的静态环会在这里闭环，
 * 运行时才解（与 set 里 hotkeys 热重载是同一手法）。
 */
function notifyChanged(path: string, settings: Settings): void {
  void import('../../window')
    .then((m) => m.broadcast(Events.SETTINGS_CHANGED, { path, settings }))
    .catch((err: unknown) => log.warn('设置变更广播失败', err))
}

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
  notifyChanged('(patch)', next)
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
    notifyChanged(RECORDING_SETTINGS_GROUP, next)
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
  set: (payload, ctx) => {
    const { path, value } = parseInput(setSchema, payload)
    const current = getSettings()

    // 用 patch 重建，保证不会因为调用方只传一个字段而丢掉整棵树
    const patch: Record<string, unknown> = {}
    setPath(patch, path, value)

    const next = deepMerge(current, patch)
    writeDoc(next)
    cache = next
    log.debug(`设置已更新: ${path}`)
    notifyChanged(path, next)

    // 快捷键改动即时生效：动态 import 避免 settings ↔ hotkey 的静态循环依赖
    //（hotkey 静态依赖本模块的 getSettings/updateSettings）
    if (path === 'hotkeys' || path.startsWith('hotkeys.')) {
      void import('../hotkey')
        .then((m) => m.registerFromSettings(ctx))
        .catch((err: unknown) => log.warn('快捷键重注册失败', err))
    }
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
    notifyChanged(section ?? '*', next)
    return next
  },
}
