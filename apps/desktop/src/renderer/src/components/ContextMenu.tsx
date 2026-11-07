// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 右键上下文菜单。
 *
 * 挂到 body 用 fixed 定位：终端区域有 overflow 裁剪，
 * 挂在内部会被裁掉。打开时监听一次全局 pointerdown / Escape / 滚动即关闭，
 * 这是上下文菜单该有的行为（用户点别处就该消失）。
 */

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Icon, type IconName } from './Icon'

export interface ContextMenuItem {
  id: string
  label: ReactNode
  icon?: IconName
  /** 展示快捷键提示 */
  hint?: string
  danger?: boolean
  disabled?: boolean
  /** 分隔线：在该项之前画一条线 */
  separatorBefore?: boolean
  onSelect: () => void
}

export interface ContextMenuProps {
  open: boolean
  x: number
  y: number
  items: ContextMenuItem[]
  onClose: () => void
}

export function ContextMenu({ open, x, y, items, onClose }: ContextMenuProps): React.JSX.Element | null {
  const ref = useRef<HTMLDivElement | null>(null)
  const [pos, setPos] = useState({ left: x, top: y })

  // 贴边时翻转，保证菜单完整可见
  useLayoutEffect(() => {
    if (!open) return
    const el = ref.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const left = x + rect.width > window.innerWidth - 8 ? Math.max(8, x - rect.width) : x
    const top = y + rect.height > window.innerHeight - 8 ? Math.max(8, y - rect.height) : y
    setPos({ left, top })
  }, [open, x, y, items.length])

  useEffect(() => {
    if (!open) return
    const close = (): void => onClose()
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    // 捕获阶段：先于终端自己的处理关掉菜单
    window.addEventListener('pointerdown', close, true)
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('blur', close)
    return () => {
      window.removeEventListener('pointerdown', close, true)
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('blur', close)
    }
  }, [open, onClose])

  if (!open) return null

  return createPortal(
    <div
      ref={ref}
      className="ctxmenu"
      style={{ left: pos.left, top: pos.top }}
      role="menu"
      // 菜单自身的按下不该触发"点别处关闭"
      onPointerDown={(e) => e.stopPropagation()}
    >
      {items.map((item) => (
        <div key={item.id}>
          {item.separatorBefore ? <div className="ctxmenu__sep" role="separator" /> : null}
          <button
            type="button"
            role="menuitem"
            className={`ctxmenu__item${item.danger ? ' ctxmenu__item--danger' : ''}`}
            disabled={item.disabled}
            onClick={() => {
              item.onSelect()
              onClose()
            }}
          >
            <span className="ctxmenu__icon">
              {item.icon ? <Icon name={item.icon} size={14} /> : null}
            </span>
            <span className="ctxmenu__label">{item.label}</span>
            {item.hint ? <span className="ctxmenu__hint">{item.hint}</span> : null}
          </button>
        </div>
      ))}
    </div>,
    document.body,
  )
}
