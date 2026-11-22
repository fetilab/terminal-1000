// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 外观设置（主题预设 / 背景 / 界面各组不透明度 / 毛玻璃 / 缩放）的解析与应用。
 *
 * **为什么要按「组件组」拆不透明度**：单一「界面不透明度」滑杆无法表达
 * 「面板要透一点看壁纸，但设置弹窗和菜单必须实色才读得清」。参考成熟终端
 * （kitty / iTerm 系）的设置面板，透明度是**分组**的：面板、侧边栏、
 * 设置弹窗、菜单浮层、输入框、代码块各自一个旋钮，外加背景层的
 * 不透明度 / 模糊 / 遮罩三件套，以及统一的毛玻璃强度。
 *
 * 结构上分两层：
 * - 解析与配色是**纯函数**（color.ts / presets.ts），可在 node 下单测；
 * - 只有 applyToDocument 碰 document，因此不需要 jsdom 也能覆盖逻辑。
 *
 * 一致性约束（终端与两侧必须同源）：
 * 终端画布 alpha 直接取 `panelOpacity`，与 `.content` 面板用**同一个变量**；
 * 毛玻璃只在三大区域容器（.rail / .panel / .content）上各加一层，强度同源。
 * 因此任何一档设置下，终端区域的透出量与模糊度都必然等于两侧面板。
 */

import type { ThemeMode } from '@t1000/shared'
import { paletteFor, paletteToCssVars, isThemePresetId, type AppearanceMode, type ThemePresetId } from './presets'

export type BackgroundType = 'none' | 'image' | 'video' | 'color' | 'script'

export interface AppearanceConfig {
  preset: ThemePresetId
  /** 本地图片的绝对路径（也接受 file:/data:/blob: URL）；空串表示不设背景图 */
  backgroundImage: string

  // ── 背景层 ────────────────────────────────────────────
  /** 背景媒体自身的不透明度 0~1：1 = 壁纸原样，0 = 完全隐藏 */
  backgroundOpacity: number
  /** 背景高斯模糊强度（px）：模糊壁纸、降低炫光 */
  backgroundBlur: number
  /** 背景遮罩 0~1：在壁纸上盖一层主题色（浅色=白 / 深色=黑），提高文字对比度 */
  backgroundScrim: number

  // ── 界面各组不透明度（1 = 不透明，0 = 全透） ─────────────
  /** 主区域（内容区 / 终端）：终端画布 alpha 与它同源 */
  panelOpacity: number
  /** 侧边栏（左侧图标栏 + 文件树/会话面板） */
  sidebarOpacity: number
  /** 设置与弹窗 */
  modalOpacity: number
  /** 菜单与浮层（右键菜单、补全弹窗、命令面板） */
  menuOpacity: number
  /** 输入框（工具栏搜索框、表单控件） */
  inputOpacity: number
  /** 代码块（编辑器、代码预览、日志块） */
  codeOpacity: number

  // ── 质感 ─────────────────────────────────────────────
  /** 毛玻璃强度（px）：三大区域背后的磨砂半径，0 = 关闭 */
  glassBlur: number
  /** 强调色浓度 0~1：选中/hover 的强调色填充强度 */
  accentStrength: number

  /** 界面缩放 0.8~1.4 */
  scale: number

  // ── 背景内容 ──────────────────────────────────────────
  /** 动态背景类型：纯色/图片/视频/TS 脚本，任意界面播放 */
  backgroundType: BackgroundType
  /** 纯色背景色（#RRGGBB / #RRGGBBAA） */
  backgroundColor: string
  /** 视频背景的本地路径 */
  backgroundVideo: string
  /** 背景脚本：内置脚本名（如 matrix）或脚本文件绝对路径 */
  backgroundScript: string
  /** 脚本帧率上限（10~60，默认 30） */
  backgroundFps: number
}

export const APPEARANCE_DEFAULTS: AppearanceConfig = {
  preset: 'aurora',
  backgroundImage: '',
  backgroundOpacity: 1,
  backgroundBlur: 5,
  backgroundScrim: 0.35,
  // 0.72：能看见壁纸，但文字仍然压得住；想全透就直接拉到 0
  panelOpacity: 0.72,
  sidebarOpacity: 0.72,
  // 浮层默认实色：半透明会让壁纸透进来与文字抢对比度（这是用户反复抱怨的点）
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

/**
 * 六组界面不透明度的**唯一真源**：设置字段、CSS 变量、探针断言都从这里取，
 * 避免「加了一组但漏了某个消费点」。
 */
export const OPACITY_GROUPS = [
  { key: 'panelOpacity', cssVar: '--t1000-alpha-panel', label: '面板不透明度' },
  { key: 'sidebarOpacity', cssVar: '--t1000-alpha-sidebar', label: '侧边栏不透明度' },
  { key: 'modalOpacity', cssVar: '--t1000-alpha-modal', label: '设置与弹窗不透明度' },
  { key: 'menuOpacity', cssVar: '--t1000-alpha-menu', label: '菜单与浮层不透明度' },
  { key: 'inputOpacity', cssVar: '--t1000-alpha-input', label: '输入框不透明度' },
  { key: 'codeOpacity', cssVar: '--t1000-alpha-code', label: '代码块不透明度' },
] as const

export type OpacityGroupKey = (typeof OPACITY_GROUPS)[number]['key']

/** 设置项路径；与 settingsFields.ts 的声明保持一致（那边是"设置必须被消费"的唯一真源） */
export const APPEARANCE_PATHS = {
  preset: 'app.appearance.preset',
  backgroundImage: 'app.appearance.backgroundImage',
  backgroundOpacity: 'app.appearance.backgroundOpacity',
  backgroundBlur: 'app.appearance.backgroundBlur',
  backgroundScrim: 'app.appearance.backgroundScrim',
  scale: 'app.appearance.scale',
} as const

const SCALE_MIN = 0.8
const SCALE_MAX = 1.4

/** 与 settingsFields.readPath 同语义；这里自带一份是为了让 theme/ 不反向依赖设置面板 */
function readPath(obj: unknown, path: string): unknown {
  let current: unknown = obj
  for (const part of path.split('.')) {
    if (typeof current !== 'object' || current === null) return undefined
    current = (current as Record<string, unknown>)[part]
  }
  return current
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, value))
}

/** 解析设置文档里的外观分组；缺字段/脏值一律回退默认，绝不让界面因设置损坏而不可用 */
export function resolveAppearance(settings: unknown): AppearanceConfig {
  const raw = readPath(settings, 'app.appearance')
  const source = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
  const image = source.backgroundImage
  // 兼容：老版本没有 backgroundType， backgroundImage 非空就视为图片背景
  const legacyImage = typeof image === 'string' && image.trim() !== ''
  const type = source.backgroundType
  return {
    preset: isThemePresetId(source.preset) ? source.preset : APPEARANCE_DEFAULTS.preset,
    backgroundImage: typeof image === 'string' ? image.trim() : APPEARANCE_DEFAULTS.backgroundImage,
    backgroundOpacity: clampNumber(
      source.backgroundOpacity,
      0,
      1,
      APPEARANCE_DEFAULTS.backgroundOpacity,
    ),
    backgroundBlur: clampNumber(source.backgroundBlur, 0, 40, APPEARANCE_DEFAULTS.backgroundBlur),
    backgroundScrim: clampNumber(
      source.backgroundScrim,
      0,
      1,
      APPEARANCE_DEFAULTS.backgroundScrim,
    ),
    ...Object.fromEntries(
      OPACITY_GROUPS.map((g) => [
        g.key,
        clampNumber(source[g.key], 0, 1, APPEARANCE_DEFAULTS[g.key]),
      ]),
    ),
    glassBlur: clampNumber(source.glassBlur, 0, 40, APPEARANCE_DEFAULTS.glassBlur),
    accentStrength: clampNumber(
      source.accentStrength,
      0,
      1,
      APPEARANCE_DEFAULTS.accentStrength,
    ),
    scale: clampNumber(source.scale, SCALE_MIN, SCALE_MAX, APPEARANCE_DEFAULTS.scale),
    backgroundType:
      type === 'image' || type === 'video' || type === 'color' || type === 'script' || type === 'none'
        ? type
        : legacyImage
          ? 'image'
          : APPEARANCE_DEFAULTS.backgroundType,
    backgroundColor:
      typeof source.backgroundColor === 'string' ? source.backgroundColor : APPEARANCE_DEFAULTS.backgroundColor,
    backgroundVideo:
      typeof source.backgroundVideo === 'string' ? source.backgroundVideo : APPEARANCE_DEFAULTS.backgroundVideo,
    backgroundScript:
      typeof source.backgroundScript === 'string' ? source.backgroundScript : APPEARANCE_DEFAULTS.backgroundScript,
    backgroundFps: clampNumber(source.backgroundFps, 10, 60, APPEARANCE_DEFAULTS.backgroundFps),
  } as AppearanceConfig
}

/** 读 `app.theme`；未知值按 system 处理 */
export function readThemeMode(settings: unknown): ThemeMode {
  const value = readPath(settings, 'app.theme')
  return value === 'light' || value === 'dark' || value === 'system' ? value : 'system'
}

/** 把三态主题解析成实际明暗（`prefersLight` 由调用方给，便于纯函数测试） */
export function resolveMode(theme: ThemeMode, prefersLight: boolean): AppearanceMode {
  if (theme === 'system') return prefersLight ? 'light' : 'dark'
  return theme
}

/**
 * 把设置里的图片值转成可用的 URL。
 *
 * 只接受本地来源：`data:` / `blob:` / `file:` / 绝对路径 / 渲染层相对路径。
 * **刻意不支持 http(s)** —— 那会让每次启动都向外部发起请求，等于对外泄漏"这台机器在用它"，
 * 而背景图完全没有远程加载的必要。
 */
export function backgroundImageUrl(raw: string): string {
  const value = raw.trim()
  if (!value) return ''
  if (/^(data:image\/|blob:|file:)/i.test(value)) return value
  // 其它带协议的（http:/https:/javascript:/…）一律拒绝
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return ''
  if (value.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(value)) {
    const encoded = value
      .replace(/\\/g, '/')
      .split('/')
      .map((segment) => encodeURIComponent(segment))
      .join('/')
    return `file://${encoded.startsWith('/') ? '' : '/'}${encoded}`
  }
  return value
}

/** 供设置界面的 `<img>` 探针直接使用（与 CSS 里的写法同源） */
export function backgroundImageProbeUrl(raw: string): string {
  return backgroundImageUrl(raw)
}

/** 转成 CSS `url()` 里的字符串；引号与反斜杠必须转义，否则用户路径能破坏整条声明 */
function cssUrlValue(url: string): string {
  // eslint-disable-next-line no-control-regex
  const safe = url.replace(/[\u0000-\u001f]/g, '').replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  return `url("${safe}")`
}

/**
 * 当前设置下媒体背景是否真的可见。
 *
 * **必须严格按 backgroundType 判定来源**：用户可能同时存着图片路径、视频路径
 * 和脚本名（切来切去留下的），只有被选中的那一个才生效。如果拿"任意字段非空"
 * 当有媒体，就会出现「类型选了无、壁纸却还在」「遮罩/毛玻璃莫名全屏」这类
 * 联动错乱 —— 这是背景设置最容易出错的地方。
 */
export function hasVisibleMedia(config: AppearanceConfig): boolean {
  if (config.backgroundOpacity <= 0.001) return false
  switch (config.backgroundType) {
    case 'image':
      return Boolean(backgroundImageUrl(config.backgroundImage))
    case 'video':
      return config.backgroundVideo.trim() !== ''
    case 'script':
      return config.backgroundScript.trim() !== ''
    case 'color':
      return config.backgroundColor.trim() !== ''
    default:
      return false
  }
}

/**
 * 主区域（面板 / 终端画布）的不透明度。
 *
 * **恒等于 panelOpacity**，不随背景有无/类型变化 —— 这正是「不同背景可见度下
 * 终端必须和两侧一致」的保证：三者读同一个数字，没有第二套公式。
 */
export function panelAlpha(config: AppearanceConfig): number {
  return config.panelOpacity
}

/**
 * 终端画布的 alpha。
 *
 * **只在「有媒体背景」时降到 0** —— 此时终端画布完全透明，透出来的是
 * `.content` 的面板色（panelOpacity + 毛玻璃），于是终端区域与两侧面板
 * 拿到的是同一层底色、同一层磨砂，任何一档设置下都不可能不一致。
 *
 * 无媒体背景时画布实色（1），终端显示自己的配色；此时把画布调半透只会
 * 透出窗口底色，没有观感收益。
 *
 * 注意不要用 panelOpacity 直接当画布 alpha：画布与 `.content` 是两层，
 * 两层各 72% 会复合出 92%，终端又比两侧实一截 —— 这就是历史上反复
 * 出现的「终端和其他界面不一致」。（一层负责底色，见 appearance.css）
 */
export function canvasAlphaFor(config: AppearanceConfig): number {
  return hasVisibleMedia(config) ? 0 : 1
}

/** 启动时的画布 alpha（窗格挂载可能早于第一条 t1000-appearance 事件） */
export function currentCanvasAlpha(): number {
  if (cachedSettings === null) return 1
  return canvasAlphaFor(resolveAppearance(cachedSettings))
}

/**
 * 当前设置下的主区域不透明度（供终端窗格初始化时同步）。
 * 窗格挂载可能早于第一条 `t1000-appearance` 事件，只靠监听会漏掉启动态。
 */
export function currentPanelAlpha(): number {
  if (cachedSettings === null) return APPEARANCE_DEFAULTS.panelOpacity
  return panelAlpha(resolveAppearance(cachedSettings))
}

function prefersLight(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  return window.matchMedia('(prefers-color-scheme: light)').matches
}

let cachedSettings: unknown = null
let cachedScale: number | null = null
let watching = false

/**
 * 把外观应用到根节点。
 *
 * 幂等；`system` 模式下会自行监听 `prefers-color-scheme` —— 系统明暗切换时重放一次，
 * 否则预设令牌会停留在旧明暗上（面板跟随系统变色、但色系令牌没跟上，正是"浅色下低对比"的成因）。
 */
export function applyAppearance(settings: unknown): AppearanceConfig {
  const config = resolveAppearance(settings)
  const mode = resolveMode(readThemeMode(settings), prefersLight())

  cachedSettings = settings
  applyToDocument(config, mode)

  if (!watching && typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    watching = true
    window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
      if (readThemeMode(cachedSettings) === 'system') applyAppearance(cachedSettings)
    })
  }
  return config
}

/** 直接按已解析的配置应用（测试与"预览"场景用；生产路径走 applyAppearance） */
export function applyAppearanceConfig(config: AppearanceConfig, mode: AppearanceMode): void {
  applyToDocument(config, mode)
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`
}

function applyToDocument(config: AppearanceConfig, mode: AppearanceMode): void {
  if (typeof document === 'undefined') return
  const root = document.documentElement

  for (const [name, value] of Object.entries(paletteToCssVars(paletteFor(config.preset, mode), mode))) {
    root.style.setProperty(name, value)
  }

  root.dataset.theme = mode
  root.dataset.appearancePreset = config.preset

  // 六组界面不透明度：每组一个变量，CSS 里各区域各取各的
  for (const group of OPACITY_GROUPS) {
    root.style.setProperty(group.cssVar, pct(config[group.key]))
  }

  const url = backgroundImageUrl(config.backgroundImage)
  const mediaVisible = hasVisibleMedia(config)
  /*
   * 背景层三件套，语义互相独立（参考图的分法）：
   *   backgroundOpacity —— 壁纸自身多不透明（0 = 藏起来）
   *   backgroundBlur    —— 壁纸自身模糊半径
   *   backgroundScrim   —— 壁纸之上盖一层主题色，压住花哨部分让文字更好读
   * 三者都只影响壁纸，不参与界面构造 —— 界面读的是六组 alpha。
   */
  const imageActive = mediaVisible && config.backgroundType === 'image'
  root.style.setProperty('--t1000-bg-image', imageActive ? cssUrlValue(url) : 'none')
  root.style.setProperty('--t1000-bg-image-opacity', String(config.backgroundOpacity))
  // 动态背景（视频/纯色/脚本）生效时收敛静态背景图，两层不叠画
  const dynActive =
    mediaVisible &&
    ((config.backgroundType === 'video' && config.backgroundVideo.trim() !== '') ||
      (config.backgroundType === 'script' && config.backgroundScript.trim() !== ''))
  const colorActive =
    mediaVisible && config.backgroundType === 'color' && config.backgroundColor.trim() !== ''
  root.style.setProperty('--t1000-dyn-bg-opacity', String(config.backgroundOpacity))
  root.style.setProperty('--t1000-dyn-bg-color', config.backgroundColor.trim() || '#000000')
  root.style.setProperty('--t1000-bg-blur', `${config.backgroundBlur}px`)
  // 遮罩颜色跟随明暗：浅色主题用白压（提亮壁纸），深色用黑压（压暗）
  root.style.setProperty('--t1000-scrim-color', mode === 'light' ? '#ffffff' : '#000000')
  root.style.setProperty('--t1000-bg-scrim', String(config.backgroundScrim))
  // 毛玻璃：三大区域容器共用一个强度，终端画布透明后自然继承
  root.style.setProperty('--t1000-glass-blur', `${config.glassBlur}px`)
  // 强调色浓度：accent-soft / accent-softer 的填充比例
  root.style.setProperty('--t1000-accent-strength', pct(config.accentStrength))
  // 兼容旧消费点：surface-alpha 现在就是主区域 alpha（终端画布同源）
  root.style.setProperty('--t1000-surface-alpha', pct(panelAlpha(config)))
  root.style.setProperty('--t1000-ui-scale', String(config.scale))

  document.body?.classList.toggle('t1000-has-bg', imageActive)
  document.body?.classList.toggle('t1000-has-dynbg', dynActive || colorActive)
  // 「有媒体在播」：毛玻璃/遮罩只在这时才有意义（背后没东西可磨）
  document.body?.classList.toggle('t1000-has-media', mediaVisible)

  // 动态背景层（React 组件）监听这个事件换内容；不用把 appearance 塞进全局 store
  window.dispatchEvent(new CustomEvent<AppearanceConfig>('t1000-appearance', { detail: config }))

  // 缩放变了要让终端等自绘区域重新量尺寸（xterm 的格子尺寸不会自己跟着 zoom 变）
  if (cachedScale !== null && cachedScale !== config.scale) {
    window.dispatchEvent(new Event('resize'))
  }
  cachedScale = config.scale
}
