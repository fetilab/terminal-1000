// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 动态背景脚本运行时。
 *
 * 脚本以 TypeScript 源码形态存在（内置脚本随包分发、自定义脚本用户自选），
 * 主进程用 typescript 包做类型剥离（transpileModule），渲染层拿到 CommonJS 后
 * `new Function` 执行。脚本契约见 docs/background-scripts.md：
 *
 * ```ts
 * export default function frame(api: FrameInfo): void
 * // 或
 * export default { frame(api): void, dispose?(): void }
 * ```
 *
 * 错误围栏：脚本抛错不会影响主界面 —— 单帧异常打一次日志后跳过，连续失败直接停机。
 */

export interface BackgroundFrameInfo {
  ctx: CanvasRenderingContext2D
  canvas: HTMLCanvasElement
  width: number
  height: number
  /** 距上一帧的秒数（帧率无关） */
  dt: number
  /** 距脚本启动的秒数 */
  time: number
}

interface BackgroundModule {
  frame?: (api: BackgroundFrameInfo) => void
  dispose?: () => void
}

const COMPILE_CACHE_MAX = 4
const compileCache = new Map<string, { js: string; mtimeMs: number }>()

async function loadCompiled(source: string): Promise<string> {
  const { invoke } = await import('../../lib/ipc')
  const res = await invoke<
    'app',
    'compileBackgroundScript',
    { source: string },
    { js: string; mtimeMs: number; path: string }
  >('app', 'compileBackgroundScript', { source })
  const cached = compileCache.get(source)
  if (cached && cached.mtimeMs === res.mtimeMs) return cached.js
  if (compileCache.size >= COMPILE_CACHE_MAX) {
    const oldest = compileCache.keys().next().value
    if (oldest !== undefined) compileCache.delete(oldest)
  }
  compileCache.set(source, { js: res.js, mtimeMs: res.mtimeMs })
  return res.js
}

function instantiate(js: string): BackgroundModule {
  const moduleObj: { exports: Record<string, unknown> } = { exports: {} }
  // 脚本是用户/内置的可信代码（用户自己选的本地文件），与主进程读盘同级信任
  const factory = new Function('module', 'exports', js)
  factory(moduleObj, moduleObj.exports)
  const mod = moduleObj.exports as { default?: unknown } & BackgroundModule
  const def = (mod.default ?? mod) as BackgroundModule | ((api: BackgroundFrameInfo) => void)
  if (typeof def === 'function') return { frame: def }
  return def
}

/** 一个正在运行的脚本实例（画布 + 循环 + 生命周期） */
export class BackgroundScriptRunner {
  private readonly canvas: HTMLCanvasElement
  private readonly ctx: CanvasRenderingContext2D
  private raf = 0
  private lastFrameAt = 0
  private startedAt = 0
  private mod: BackgroundModule | null = null
  private consecutiveErrors = 0
  private errorLogged = false
  private disposed = false
  private readonly fps: number
  private resizeObs: ResizeObserver | null = null

  constructor(
    private readonly host: HTMLElement,
    private readonly source: string,
    fps: number,
  ) {
    this.canvas = document.createElement('canvas')
    this.canvas.className = 't1000-dynbg__canvas'
    host.appendChild(this.canvas)
    const ctx = this.canvas.getContext('2d')
    if (!ctx) throw new Error('背景脚本画布初始化失败')
    this.ctx = ctx
    this.fps = fps
  }

  async start(): Promise<void> {
    const js = await loadCompiled(this.source)
    if (this.disposed) return
    this.mod = instantiate(js)
    this.measure()
    this.resizeObs = new ResizeObserver(() => this.measure())
    this.resizeObs.observe(this.host)
    this.startedAt = performance.now()
    this.lastFrameAt = this.startedAt
    this.tick()
  }

  /** 画布按宿主的物理像素尺寸铺满（cover 裁切语义在脚本里自己处理） */
  private measure(): void {
    const dpr = Math.max(1, window.devicePixelRatio || 1)
    const w = Math.max(1, Math.round(this.host.clientWidth * dpr))
    const h = Math.max(1, Math.round(this.host.clientHeight * dpr))
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w
      this.canvas.height = h
    }
  }

  private tick = (): void => {
    if (this.disposed || !this.mod) return
    this.raf = requestAnimationFrame(this.tick)
    const now = performance.now()
    const interval = 1000 / this.fps
    if (now - this.lastFrameAt < interval) return // 帧率上限
    const dt = Math.min(0.25, (now - this.lastFrameAt) / 1000)
    this.lastFrameAt = now
    const frame = this.mod.frame
    if (!frame) return
    try {
      frame({
        ctx: this.ctx,
        canvas: this.canvas,
        width: this.canvas.width,
        height: this.canvas.height,
        dt,
        time: (now - this.startedAt) / 1000,
      })
      this.consecutiveErrors = 0
    } catch (err) {
      this.consecutiveErrors += 1
      if (!this.errorLogged) {
        console.error('[背景脚本] 运行失败，连续失败 30 次后停机：', err)
        this.errorLogged = true
      }
      if (this.consecutiveErrors >= 30) {
        console.error('[背景脚本] 连续失败，已停止渲染')
        cancelAnimationFrame(this.raf)
        this.raf = 0
      }
    }
  }

  dispose(): void {
    this.disposed = true
    if (this.raf !== 0) cancelAnimationFrame(this.raf)
    this.resizeObs?.disconnect()
    try {
      this.mod?.dispose?.()
    } catch (err) {
      console.warn('[背景脚本] dispose 失败（忽略）：', err)
    }
    this.canvas.remove()
  }
}
