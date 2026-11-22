// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 外观设置（主题预设 / 背景图 / 界面透明度 / 界面缩放）的解析与应用。
 *
 * **设置分组为什么是 `app.appearance.*`、而 packages/shared 不动**：
 * 设置文档的深合并保留未知键（见 main/services/settings/index.ts 里 sessionRecording 的先例），
 * 所以渲染层可以先行落地一个新分组；等 shared 补上强类型组后，
 * 把 resolveAppearance 换成直读 `settings.app.appearance` 即可，消费点不用改。
 *
 * 结构上分两层：
 * - 解析与配色是**纯函数**（color.ts / presets.ts），可在 node 下单测；
 * - 只有 applyAppearance 及其下游碰 document，因此不需要 jsdom 也能覆盖逻辑。
 */

import type { ThemeMode } from '@t1000/shared'
import { paletteFor, paletteToCssVars, isThemePresetId, type AppearanceMode, type ThemePresetId } from './presets'

export type BackgroundType = 'none' | 'image' | 'video' | 'color' | 'script'

export interface AppearanceConfig {
  preset: ThemePresetId
  /** 本地图片的绝对路径（也接受 file:/data:/blob: URL）；空串表示不设背景图 */
  backgroundImage: string
  /** 背景图可见度 0~1 */
  backgroundOpacity: number
  /** 界面不透明度 0.5~1：越低，背景图/桌面透出越多 */
  opacity: number
  /** 界面缩放 0.8~1.4 */
  scale: number
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
  backgroundOpacity: 0.35,
  // 默认 1（实心）——不改变现状观感；只有在设了背景图时才会自动略微透出
  opacity: 1,
  scale: 1,
  backgroundType: 'none',
  backgroundColor: '#10141a',
  backgroundVideo: '',
  backgroundScript: '',
  backgroundFps: 30,
}

/** 设置项路径；与 settingsFields.ts 的声明保持一致（那边是"设置必须被消费"的唯一真源） */
export const APPEARANCE_PATHS = {
  preset: 'app.appearance.preset',
  backgroundImage: 'app.appearance.backgroundImage',
  backgroundOpacity: 'app.appearance.backgroundOpacity',
  opacity: 'app.appearance.opacity',
  scale: 'app.appearance.scale',
} as const

/**
 * 背景可见度 → 界面透光强度。
 *
 * 语义：**背景可见度滑杆直接决定界面透多少** —— backgroundOpacity=1 时
 * 背景要清晰可见，面板/终端画布必须降到 30%；0 时界面保持实心。
 * 与界面不透明度（opacity）相乘组合，两个滑杆互不打架。
 *
 * 此前是 `opacity × 0.78`：背景永远只透 22%，观感等于「没生效」——
 * 正是「背景设置了完全不显示」的组成部分。
 */
export const BACKGROUND_VISIBILITY_STRENGTH = 0.7

const OPACITY_MIN = 0.5
const OPACITY_MAX = 1
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
    opacity: clampNumber(source.opacity, OPACITY_MIN, OPACITY_MAX, APPEARANCE_DEFAULTS.opacity),
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
  }
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

/** 背景图存在时界面不透明的实际系数（面板与终端画布同源） */
export function effectiveSurfaceAlpha(config: AppearanceConfig, hasImage: boolean): number {
  if (!hasImage) return config.opacity
  const visibility = 1 - config.backgroundOpacity * BACKGROUND_VISIBILITY_STRENGTH
  return config.opacity * visibility
}

/**
 * 当前设置下是否有媒体背景在生效；有则返回界面不透明系数（终端画布
 * 也应降到这个 alpha，否则背景层被实心画布挡住），没有返回 null。
 * 供终端窗格初始化时同步（applyAppearance 在窗格挂载前就跑过一次，
 * 只听 t1000-appearance 事件会漏掉启动时已生效的背景）。
 */
export function currentMediaSurfaceAlpha(): number | null {
  if (cachedSettings === null) return null
  const config = resolveAppearance(cachedSettings)
  // 可见度推到 0 = 媒体层整体隐藏（applyToDocument 同款判定），画布回到自身不透明度
  if (config.backgroundOpacity <= 0.001) return null
  const url = backgroundImageUrl(config.backgroundImage)
  const media =
    Boolean(url) ||
    (config.backgroundType === 'video' && config.backgroundVideo.trim() !== '') ||
    (config.backgroundType === 'script' && config.backgroundScript.trim() !== '') ||
    (config.backgroundType === 'color' && config.backgroundColor.trim() !== '')
  return media ? effectiveSurfaceAlpha(config, true) : null
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

function applyToDocument(config: AppearanceConfig, mode: AppearanceMode): void {
  if (typeof document === 'undefined') return
  const root = document.documentElement

  for (const [name, value] of Object.entries(paletteToCssVars(paletteFor(config.preset, mode), mode))) {
    root.style.setProperty(name, value)
  }

  root.dataset.theme = mode
  root.dataset.appearancePreset = config.preset

  const url = backgroundImageUrl(config.backgroundImage)
  /*
   * 媒体层满强度显示（kitty 观感：壁纸满强度铺底 + 终端 background_opacity + blur）。
   * 此前媒体层自己乘 backgroundOpacity（默认 0.35），与终端画布的透出（0.68）双衰减，
   * 壁纸净贡献只剩 ~11% —— 用户看到的就是「命令行终端（kitty 界面）不透明」。
   * 「背景可见度」滑杆现在唯一的作用是控制表面/画布透明度（effectiveSurfaceAlpha）：
   * 拉高 → 界面更透 → 背景更可见；推到 0 → 媒体层彻底隐藏（含 has-* 类，毛玻璃一并撤）。
   */
  const mediaHidden = config.backgroundOpacity <= 0.001
  root.style.setProperty('--t1000-bg-image', url && !mediaHidden ? cssUrlValue(url) : 'none')
  root.style.setProperty('--t1000-bg-image-opacity', '1')
  // 动态背景（视频/纯色/脚本）生效时收敛静态背景图，两层不叠画
  const dynActive =
    !mediaHidden &&
    ((config.backgroundType === 'video' && config.backgroundVideo.trim() !== '') ||
      (config.backgroundType === 'script' && config.backgroundScript.trim() !== ''))
  const colorActive =
    !mediaHidden && config.backgroundType === 'color' && config.backgroundColor.trim() !== ''
  root.style.setProperty('--t1000-dyn-bg-opacity', '1')
  root.style.setProperty('--t1000-dyn-bg-color', config.backgroundColor.trim() || '#000000')
  document.body?.classList.toggle('t1000-has-dynbg', dynActive || colorActive)
  const surfaceHasMedia = (Boolean(url) && !mediaHidden) || dynActive || colorActive
  root.style.setProperty(
    '--t1000-surface-alpha',
    `${(effectiveSurfaceAlpha(config, surfaceHasMedia) * 100).toFixed(1)}%`,
  )
  root.style.setProperty('--t1000-ui-scale', String(config.scale))

  document.body?.classList.toggle('t1000-has-bg', Boolean(url) && !mediaHidden)

  // 动态背景层（React 组件）监听这个事件换内容；不用把 appearance 塞进全局 store
  window.dispatchEvent(new CustomEvent<AppearanceConfig>('t1000-appearance', { detail: config }))

  // 缩放变了要让终端等自绘区域重新量尺寸（xterm 的格子尺寸不会自己跟着 zoom 变）
  if (cachedScale !== null && cachedScale !== config.scale) {
    window.dispatchEvent(new Event('resize'))
  }
  cachedScale = config.scale
}
