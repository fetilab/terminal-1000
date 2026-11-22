// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 动态背景层：任意界面都可以播放的视频 / 图片 / 纯色 / TS 脚本背景。
 *
 * 数据流：设置（app.appearance.*）→ applyAppearance 写 CSS 变量 + 派发
 * `t1000-appearance` 事件 → 本组件按 backgroundType 渲染对应媒体。
 * 层级与静态背景图（body::before）一致：fixed / z-index 0 / pointer-events none，
 * 生效时收敛静态层，两层不叠画。
 */

import { useEffect, useRef, useState } from 'react'
import { backgroundImageUrl, type AppearanceConfig, type BackgroundType } from '../../theme/appearance'
import { BackgroundScriptRunner } from './BackgroundScriptRunner'

/** 抖动过滤：小于 200ms 的设置抖动不触发媒体重建（视频/脚本是重资源） */
const SWITCH_DEBOUNCE_MS = 200

export function DynamicBackground(): React.JSX.Element | null {
  const [config, setConfig] = useState<AppearanceConfig | null>(null)
  const scriptHost = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const onChange = (e: Event): void => {
      const detail = (e as CustomEvent<AppearanceConfig>).detail
      if (detail) setConfig(detail)
    }
    window.addEventListener('t1000-appearance', onChange)
    return () => window.removeEventListener('t1000-appearance', onChange)
  }, [])

  const type: BackgroundType = config?.backgroundType ?? 'none'
  const videoSrc = type === 'video' ? backgroundImageUrl(config?.backgroundVideo ?? '') : ''
  const scriptSource = type === 'script' ? (config?.backgroundScript ?? '').trim() : ''
  const fps = config?.backgroundFps ?? 30

  // 脚本实例的装载/卸载：source 或 fps 变化都重启
  useEffect(() => {
    if (!scriptSource) return
    const host = scriptHost.current
    if (!host) return
    let runner: BackgroundScriptRunner | null = null
    let cancelled = false
    const timer = window.setTimeout(() => {
      if (cancelled) return
      runner = new BackgroundScriptRunner(host, scriptSource, fps)
      void runner.start().catch((err) => console.error('[背景脚本] 装载失败：', err))
    }, SWITCH_DEBOUNCE_MS)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
      runner?.dispose()
    }
  }, [scriptSource, fps])

  // 与静态背景图同层但互斥：type=image 时走 body::before（CSS 变量），这里不渲染
  const showColor = type === 'color'
  const showVideo = Boolean(videoSrc)
  const showScript = Boolean(scriptSource)
  if (!config || (!showColor && !showVideo && !showScript)) return null

  return (
    <div className="t1000-dynbg" aria-hidden="true">
      {showColor ? <div className="t1000-dynbg--color" /> : null}
      {showVideo ? (
        <video src={videoSrc} autoPlay loop muted playsInline />
      ) : null}
      {showScript ? <div ref={scriptHost} style={{ position: 'absolute', inset: 0 }} /> : null}
    </div>
  )
}
