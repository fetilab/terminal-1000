// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

import type { ReactNode } from 'react'
import { Icon, type IconName } from './Icon'

export interface SegmentedItem<T extends string> {
  value: T
  label: string
  icon?: IconName
  /** 右上角计数（如「收藏(3)」），undefined 不显示 */
  count?: number
  disabled?: boolean
}

export interface SegmentedProps<T extends string> {
  items: readonly SegmentedItem<T>[]
  value: T
  onChange: (value: T) => void
  /** 紧凑模式：无外框，用于工具条内嵌 */
  bare?: boolean
  ariaLabel?: string
  children?: ReactNode
}

/**
 * 分段控件。用于协议切换（SSH/RDP/…）与视图切换。
 * 用 role=tablist 让键盘用户可以用左右箭头切换。
 */
export function Segmented<T extends string>({
  items,
  value,
  onChange,
  bare = false,
  ariaLabel,
  children,
}: SegmentedProps<T>): React.JSX.Element {
  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return
    e.preventDefault()
    const enabled = items.filter((i) => !i.disabled)
    if (enabled.length === 0) return
    const idx = enabled.findIndex((i) => i.value === value)
    const next = e.key === 'ArrowRight' ? idx + 1 : idx - 1
    const target = enabled[(next + enabled.length) % enabled.length]
    if (target) onChange(target.value)
  }

  return (
    <div
      className="t-segmented"
      role="tablist"
      aria-label={ariaLabel}
      onKeyDown={onKeyDown}
      style={bare ? { background: 'transparent', border: 'none', padding: 0 } : undefined}
    >
      {items.map((item) => {
        const active = item.value === value
        const classes = ['t-segmented__item']
        if (active) classes.push('t-segmented__item--active')
        return (
          <button
            key={item.value}
            type="button"
            role="tab"
            aria-selected={active}
            disabled={item.disabled}
            tabIndex={active ? 0 : -1}
            className={classes.join(' ')}
            onClick={() => onChange(item.value)}
          >
            {item.icon ? <Icon name={item.icon} size={14} /> : null}
            {item.label}
            {item.count !== undefined ? <span className="t-segmented__count">{item.count}</span> : null}
          </button>
        )
      })}
      {children}
    </div>
  )
}
