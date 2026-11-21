// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 品牌标：与 build/icon.svg **同一份图形**（深色圆角方块 + 青色 `>_`）。
 *
 * 为什么要有这个组件：界面左上角原先是一个写着 "T1" 的渐变方块 ——
 * 与安装包/任务栏用的新图标完全是两套视觉，用户会觉得"图标根本没换"。
 * 现在界面内、窗口图标、安装包图标三者用同一个字形族。
 *
 * 尺寸只是缩放 viewBox，所以 16px（工具栏）到 64px（关于页）都清晰：
 * 图形只有一个粗笔画字形，缩小后不会糊。
 */

import { useId } from 'react'

export interface BrandMarkProps {
  /** 渲染尺寸（正方形，px） */
  size?: number
  className?: string
  /** 无障碍名称；装饰性使用时传空字符串 */
  label?: string
}

export function BrandMark({ size = 34, className, label = 'terminal-1000' }: BrandMarkProps): React.JSX.Element {
  // 同一页面可能有多个实例（侧栏 + 关于页），渐变 id 必须唯一，否则后渲染的会复用前者的
  const uid = useId().replace(/:/g, '')
  const bgId = `bm-bg-${uid}`
  const glowId = `bm-glow-${uid}`
  const inkId = `bm-ink-${uid}`

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 512 512"
      className={className}
      role={label ? 'img' : 'presentation'}
      aria-label={label || undefined}
      aria-hidden={label ? undefined : true}
      focusable="false"
    >
      <defs>
        <linearGradient id={bgId} x1="0.15" y1="0" x2="0.85" y2="1">
          <stop offset="0" stopColor="#1c2634" />
          <stop offset="0.55" stopColor="#111823" />
          <stop offset="1" stopColor="#0a0d13" />
        </linearGradient>
        <radialGradient id={glowId} cx="0.5" cy="0.52" r="0.46">
          <stop offset="0" stopColor="#3ec9d6" stopOpacity="0.28" />
          <stop offset="0.6" stopColor="#3ec9d6" stopOpacity="0.08" />
          <stop offset="1" stopColor="#3ec9d6" stopOpacity="0" />
        </radialGradient>
        <linearGradient id={inkId} gradientUnits="userSpaceOnUse" x1="150" y1="176" x2="356" y2="336">
          <stop offset="0" stopColor="#7feaf3" />
          <stop offset="0.5" stopColor="#3ec9d6" />
          <stop offset="1" stopColor="#22a7bb" />
        </linearGradient>
      </defs>

      <rect x="16" y="16" width="480" height="480" rx="116" fill="#080a0e" />
      <rect x="20" y="20" width="472" height="472" rx="112" fill={`url(#${bgId})`} />
      <rect x="20" y="20" width="472" height="472" rx="112" fill={`url(#${glowId})`} />
      <g fill="none" stroke={`url(#${inkId})`} strokeWidth="38" strokeLinecap="round" strokeLinejoin="round">
        <path d="M172 190 L244 256 L172 322" />
        <path d="M278 322 L344 322" />
      </g>
    </svg>
  )
}
