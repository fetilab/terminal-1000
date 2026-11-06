// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 自研图标集。
 *
 * 设计约束（保证整套视觉一致）：
 * - 统一 24×24 视框、1.7 描边、圆头圆角连接（除明确填充的实心图标外一律不填充）；
 * - 只用直线、圆、圆弧这类基本几何，不引入任何第三方图标库的路径数据；
 * - 图标是「线构成」的，与整体的低对比深色底 + 细描边语言一致。
 *
 * 命名按语义而非外形，避免出现 `circleWithLine` 这种实现导向的名字。
 */

import type { JSX } from 'react'

export type IconName =
  // 导航
  | 'connections'
  | 'console'
  | 'notes'
  | 'tools'
  | 'settings'
  // 通用
  | 'plus'
  | 'close'
  | 'check'
  | 'chevron-down'
  | 'chevron-right'
  | 'chevron-left'
  | 'search'
  | 'refresh'
  | 'more'
  | 'copy'
  | 'trash'
  | 'edit'
  | 'upload'
  | 'download'
  | 'cloud'
  | 'folder'
  | 'folder-open'
  | 'star'
  | 'star-filled'
  | 'sort'
  | 'filter'
  | 'info'
  | 'sliders'
  // 状态
  | 'alert-triangle'
  | 'alert-circle'
  | 'check-circle'
  | 'clock'
  | 'zap'
  | 'power'
  | 'lock'
  | 'key'
  | 'shield'
  // 领域
  | 'server'
  | 'terminal'
  | 'split-h'
  | 'split-v'
  | 'panel-right'
  | 'route'
  | 'globe'
  | 'user'
  | 'activity'
  // 监控
  | 'cpu'
  | 'memory'
  | 'disk'
  | 'network'
  | 'list'
  | 'eye'

const S = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round' } as const
const F = { fill: 'currentColor', stroke: 'none' } as const

const GLYPHS: Record<IconName, JSX.Element> = {
  // ── 导航 ────────────────────────────────────────────
  connections: (
    <>
      <path {...S} d="M10.2 13.8a3.6 3.6 0 0 0 5.1 0l3-3a3.6 3.6 0 0 0-5.1-5.1l-1.1 1.1" />
      <path {...S} d="M13.8 10.2a3.6 3.6 0 0 0-5.1 0l-3 3a3.6 3.6 0 0 0 5.1 5.1l1.1-1.1" />
    </>
  ),
  console: (
    <>
      <rect {...S} x="3.6" y="5" width="16.8" height="14" rx="2.2" />
      <path {...S} d="M7.6 9.6l2.6 2.4-2.6 2.4M12.6 14.6h4" />
    </>
  ),
  notes: (
    <>
      <path {...S} d="M6 3.8h8.2L18.4 8v12.2H6z" />
      <path {...S} d="M14.2 3.8V8h4.2M9 12.4h6M9 15.8h4.2" />
    </>
  ),
  tools: (
    <>
      <path {...S} d="M15.1 5.6a3.9 3.9 0 0 0 4.9 5.2l-8.6 8.6-3.7 1.2 1.2-3.7z" />
      <path {...S} d="M6.2 6.2l3.1 3.1" />
    </>
  ),
  settings: (
    <>
      <path {...S} d="M4 8h9M18.4 8H20M4 16h3.6M12 16h8" />
      <circle {...S} cx="15.2" cy="8" r="2.3" />
      <circle {...S} cx="9.8" cy="16" r="2.3" />
    </>
  ),

  // ── 通用 ────────────────────────────────────────────
  plus: <path {...S} d="M12 5.2v13.6M5.2 12h13.6" />,
  close: <path {...S} d="M6.4 6.4l11.2 11.2M17.6 6.4L6.4 17.6" />,
  check: <path {...S} d="M5.4 12.6l4.4 4.4L18.6 7.2" />,
  'chevron-down': <path {...S} d="M6.4 9.6l5.6 5.6 5.6-5.6" />,
  'chevron-right': <path {...S} d="M9.6 6.4l5.6 5.6-5.6 5.6" />,
  'chevron-left': <path {...S} d="M14.4 6.4L8.8 12l5.6 5.6" />,
  search: (
    <>
      <circle {...S} cx="11" cy="11" r="6.2" />
      <path {...S} d="M15.7 15.7l4.3 4.3" />
    </>
  ),
  refresh: (
    <>
      <path {...S} d="M19.6 12a7.6 7.6 0 1 1-2.3-5.4" />
      <path {...S} d="M19.6 4.6v4.4h-4.4" />
    </>
  ),
  more: (
    <>
      <circle {...F} cx="6" cy="12" r="1.5" />
      <circle {...F} cx="12" cy="12" r="1.5" />
      <circle {...F} cx="18" cy="12" r="1.5" />
    </>
  ),
  copy: (
    <>
      <rect {...S} x="9" y="9" width="11" height="11" rx="2" />
      <path {...S} d="M15 6.6V5.6a2 2 0 0 0-2-2H5.6a2 2 0 0 0-2 2V13a2 2 0 0 0 2 2h1" />
    </>
  ),
  trash: (
    <>
      <path {...S} d="M4.6 7h14.8M9.6 7V4.9h4.8V7" />
      <path {...S} d="M6.6 7l.9 12.1h9l.9-12.1M10.4 10.6v6.1M13.6 10.6v6.1" />
    </>
  ),
  edit: (
    <>
      <path {...S} d="M15.4 5.2l3.4 3.4-9.6 9.6-4.3 1 1-4.3z" />
      <path {...S} d="M13.2 7.4l3.4 3.4" />
    </>
  ),
  upload: (
    <>
      <path {...S} d="M12 19.2V5.6M7.6 10l4.4-4.4L16.4 10" />
      <path {...S} d="M4.6 19.4h14.8" />
    </>
  ),
  download: (
    <>
      <path {...S} d="M12 4.8v13.6M7.6 14l4.4 4.4L16.4 14" />
      <path {...S} d="M4.6 19.4h14.8" />
    </>
  ),
  cloud: (
    <path
      {...S}
      d="M7.6 18.6h9.6a4.2 4.2 0 0 0 .4-8.4 5.6 5.6 0 0 0-10.8 1.3 3.5 3.5 0 0 0 .8 7.1z"
    />
  ),
  folder: (
    <path
      {...S}
      d="M3.6 7.2a1.6 1.6 0 0 1 1.6-1.6h3.6l2 2.6h8a1.6 1.6 0 0 1 1.6 1.6v8.4a1.6 1.6 0 0 1-1.6 1.6H5.2a1.6 1.6 0 0 1-1.6-1.6z"
    />
  ),
  'folder-open': (
    <>
      <path {...S} d="M3.6 7.2a1.6 1.6 0 0 1 1.6-1.6h3.6l2 2.6h8a1.6 1.6 0 0 1 1.6 1.6v1.6" />
      <path {...S} d="M3.6 10.4h17.2l-2.1 8a1.6 1.6 0 0 1-1.6 1.2H5.2a1.6 1.6 0 0 1-1.6-1.6z" />
    </>
  ),
  star: (
    <path {...S} d="M12 4.4l2.4 4.9 5.4.8-3.9 3.8.9 5.4-4.8-2.6-4.8 2.6.9-5.4L4.2 10.1l5.4-.8z" />
  ),
  'star-filled': (
    <path
      {...F}
      d="M12 4.4l2.4 4.9 5.4.8-3.9 3.8.9 5.4-4.8-2.6-4.8 2.6.9-5.4L4.2 10.1l5.4-.8z"
    />
  ),
  sort: (
    <>
      <path {...S} d="M8 5.6v13M4.6 15l3.4 3.4L11.4 15" />
      <path {...S} d="M16 18.4v-13M12.6 9L16 5.6 19.4 9" />
    </>
  ),
  filter: <path {...S} d="M3.8 6.2h16.4l-6.4 7.4v5.2l-3.6-2v-3.2z" />,
  info: (
    <>
      <circle {...S} cx="12" cy="12" r="8.2" />
      <path {...S} d="M12 11.2v5M12 8.1v.1" />
    </>
  ),
  sliders: (
    <>
      <path {...S} d="M4 7.6h9.2M18.4 7.6H20M4 16.4h4.4M13.6 16.4H20" />
      <circle {...S} cx="15.8" cy="7.6" r="2.2" />
      <circle {...S} cx="11" cy="16.4" r="2.2" />
    </>
  ),

  // ── 状态 ────────────────────────────────────────────
  'alert-triangle': (
    <>
      <path {...S} d="M12 4.8l7.8 13.6H4.2z" />
      <path {...S} d="M12 9.8v4M12 16.4v.1" />
    </>
  ),
  'alert-circle': (
    <>
      <circle {...S} cx="12" cy="12" r="8.2" />
      <path {...S} d="M12 7.9v4.9M12 15.9v.1" />
    </>
  ),
  'check-circle': (
    <>
      <circle {...S} cx="12" cy="12" r="8.2" />
      <path {...S} d="M8.3 12.2l2.6 2.6 4.8-5.4" />
    </>
  ),
  clock: (
    <>
      <circle {...S} cx="12" cy="12" r="8.2" />
      <path {...S} d="M12 7.4V12l3.2 2" />
    </>
  ),
  zap: <path {...S} d="M13.2 3.6L6.6 13.4h4.6l-.6 7.2 6.8-10h-4.6z" />,
  power: (
    <>
      <path {...S} d="M12 4.4v7.2" />
      <path {...S} d="M7.4 7.2a6.6 6.6 0 1 0 9.2 0" />
    </>
  ),
  lock: (
    <>
      <rect {...S} x="5.4" y="10.4" width="13.2" height="9.2" rx="2" />
      <path {...S} d="M8.8 10.4V7.8a3.2 3.2 0 0 1 6.4 0v2.6" />
    </>
  ),
  key: (
    <>
      <circle {...S} cx="8.4" cy="12" r="3.6" />
      <path {...S} d="M12 12h8.2M17.2 12v2.8M14.6 12v2.2" />
    </>
  ),
  shield: (
    <path {...S} d="M12 4.2l6.6 2.4v5.2c0 4.1-2.7 7.5-6.6 8.6-3.9-1.1-6.6-4.5-6.6-8.6V6.6z" />
  ),

  // ── 领域 ────────────────────────────────────────────
  server: (
    <>
      <rect {...S} x="3.8" y="5.4" width="16.4" height="5.4" rx="1.8" />
      <rect {...S} x="3.8" y="13.2" width="16.4" height="5.4" rx="1.8" />
      <path {...S} d="M7.2 8.1v.1M7.2 15.9v.1" />
    </>
  ),
  terminal: (
    <>
      <rect {...S} x="3.4" y="5" width="17.2" height="14" rx="2.2" />
      <path {...S} d="M7.4 10l2.4 2.2-2.4 2.2M12.6 14.6h4.2" />
    </>
  ),
  'split-h': (
    <>
      <rect {...S} x="3.4" y="5" width="17.2" height="14" rx="2.2" />
      <path {...S} d="M12 5v14" />
    </>
  ),
  'split-v': (
    <>
      <rect {...S} x="3.4" y="5" width="17.2" height="14" rx="2.2" />
      <path {...S} d="M3.4 12h17.2" />
    </>
  ),
  'panel-right': (
    <>
      <rect {...S} x="3.4" y="5" width="17.2" height="14" rx="2.2" />
      <path {...S} d="M14.6 5v14" />
    </>
  ),
  route: (
    <>
      <circle {...S} cx="5.6" cy="18.4" r="2.2" />
      <circle {...S} cx="18.4" cy="5.6" r="2.2" />
      <path {...S} d="M7.6 17c3.2-1.1 1.4-9.2 5-10.6 1-.4 2-.6 3.4-.7" />
    </>
  ),
  globe: (
    <>
      <circle {...S} cx="12" cy="12" r="8.2" />
      <path {...S} d="M3.9 12h16.2" />
      <path {...S} d="M12 3.8c2.5 2.3 3.9 5 3.9 8.2s-1.4 5.9-3.9 8.2c-2.5-2.3-3.9-5-3.9-8.2s1.4-5.9 3.9-8.2z" />
    </>
  ),
  user: (
    <>
      <circle {...S} cx="12" cy="8.4" r="3.6" />
      <path {...S} d="M5.4 19.6a6.6 6.6 0 0 1 13.2 0" />
    </>
  ),
  activity: <path {...S} d="M3.6 13h3.6l2.5-6.2 3.6 11 2.4-6.2h4.7" />,

  // ── 监控 ────────────────────────────────────────────
  cpu: (
    <>
      <rect {...S} x="6.6" y="6.6" width="10.8" height="10.8" rx="2" />
      <rect {...S} x="10.2" y="10.2" width="3.6" height="3.6" rx="0.8" />
      <path {...S} d="M9.6 6.6V4.2M14.4 6.6V4.2M9.6 19.8v-2.4M14.4 19.8v-2.4M6.6 9.6H4.2M6.6 14.4H4.2M19.8 9.6h-2.4M19.8 14.4h-2.4" />
    </>
  ),
  memory: (
    <>
      <rect {...S} x="3.6" y="8" width="16.8" height="8" rx="1.8" />
      <path {...S} d="M7.4 8V5.8M11 8V5.8M14.6 8V5.8M18.2 8V5.8M7.4 16v2.2M11 16v2.2M14.6 16v2.2M18.2 16v2.2" />
    </>
  ),
  disk: (
    <>
      <rect {...S} x="3.6" y="6.6" width="16.8" height="10.8" rx="2" />
      <circle {...S} cx="9" cy="12" r="2.2" />
      <path {...S} d="M14.4 10.4h3.2M14.4 13.6h3.2" />
    </>
  ),
  network: (
    <>
      <path {...S} d="M4.6 17.6l5.2-5.4M13.6 11.6l5.8-5.4" />
      <circle {...S} cx="17.6" cy="6.8" r="2.4" />
      <circle {...S} cx="6.4" cy="17.8" r="2.4" />
      <circle {...S} cx="12" cy="12" r="1.6" />
    </>
  ),
  list: <path {...S} d="M8.4 6.6h11.2M8.4 12h11.2M8.4 17.4h11.2M4.6 6.6v.1M4.6 12v.1M4.6 17.4v.1" />,
  eye: (
    <>
      <path {...S} d="M2.8 12S6.6 6.6 12 6.6 21.2 12 21.2 12 17.4 17.4 12 17.4 2.8 12 2.8 12z" />
      <circle {...S} cx="12" cy="12" r="2.8" />
    </>
  ),
}

export interface IconProps {
  name: IconName
  /** 边长（px），默认 16 */
  size?: number
  className?: string
  /** 装饰性图标对读屏隐藏；带 title 时自动暴露 */
  title?: string
}

export function Icon({ name, size = 16, className, title }: IconProps): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className={className}
      aria-hidden={title ? undefined : true}
      role={title ? 'img' : undefined}
      focusable="false"
    >
      {title ? <title>{title}</title> : null}
      {GLYPHS[name]}
    </svg>
  )
}
