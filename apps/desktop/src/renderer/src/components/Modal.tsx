// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

import { useEffect, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { IconButton } from './Button'

export interface ModalProps {
  open: boolean
  title: ReactNode
  subtitle?: ReactNode
  /** 头部右侧额外操作（关闭按钮之前） */
  headerExtra?: ReactNode
  footer?: ReactNode
  size?: 'sm' | 'md' | 'lg'
  onClose: () => void
  /** 点击遮罩关闭，默认 true */
  closeOnOverlay?: boolean
  children: ReactNode
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'

/**
 * 模态容器。
 *
 * 自带：
 * - 挂到 body（避免被内容区的 overflow 裁掉）
 * - Esc 关闭、遮罩点击关闭
 * - 打开时把焦点移入，Tab 在内部循环（简易焦点陷阱）
 * - 关闭后把焦点还给打开前的元素
 */
export function Modal({
  open,
  title,
  subtitle,
  headerExtra,
  footer,
  size = 'lg',
  onClose,
  closeOnOverlay = true,
  children,
}: ModalProps): React.JSX.Element | null {
  const panelRef = useRef<HTMLDivElement | null>(null)
  const restoreRef = useRef<HTMLElement | null>(null)
  /**
   * onClose 走 ref，不进焦点 effect 的依赖。
   *
   * 调用方普遍传内联箭头函数：弹窗内容的 draft 状态但凡在父组件，
   * 每敲一个字符就会生成新 onClose → 焦点 effect 重跑 → cleanup 把焦点
   * 还给打开前元素 + rAF 重新聚焦第一个输入框 —— 表现为"输入一个字焦点
   * 就跳回开头"。经 ref 读最新引用后，effect 只在 open 翻转时运行。
   */
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  useEffect(() => {
    if (!open) return
    restoreRef.current = document.activeElement as HTMLElement | null

    const requestClose = (): void => onCloseRef.current()

    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        requestClose()
        return
      }
      if (e.key !== 'Tab') return
      const panel = panelRef.current
      if (!panel) return
      const nodes = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (n) => n.offsetParent !== null || n === document.activeElement,
      )
      if (nodes.length === 0) return
      const first = nodes[0]
      const last = nodes[nodes.length - 1]
      if (!first || !last) return
      const active = document.activeElement
      if (e.shiftKey && (active === first || !panel.contains(active))) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && active === last) {
        e.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', onKeyDown, true)
    // 焦点移入：优先第一个输入框，否则第一个可聚焦元素
    const raf = requestAnimationFrame(() => {
      const panel = panelRef.current
      if (!panel) return
      const preferred =
        panel.querySelector<HTMLElement>('input:not([type="checkbox"]), textarea, select') ??
        panel.querySelector<HTMLElement>(FOCUSABLE)
      preferred?.focus()
    })

    return () => {
      document.removeEventListener('keydown', onKeyDown, true)
      cancelAnimationFrame(raf)
      restoreRef.current?.focus?.()
    }
  }, [open])

  if (!open) return null

  const sizeClass = size === 'lg' ? '' : ` t-modal--${size}`

  return createPortal(
    <div
      className="t-modal-overlay"
      onMouseDown={(e) => {
        if (closeOnOverlay && e.target === e.currentTarget) onCloseRef.current()
      }}
    >
      <div
        ref={panelRef}
        className={`t-modal${sizeClass}`}
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === 'string' ? title : undefined}
      >
        <header className="t-modal__header">
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="t-modal__title">{title}</div>
            {subtitle ? <div className="t-modal__subtitle">{subtitle}</div> : null}
          </div>
          {headerExtra}
          <IconButton icon="close" label="关闭" onClick={onClose} />
        </header>
        <div className="t-modal__body">{children}</div>
        {footer ? <footer className="t-modal__footer">{footer}</footer> : null}
      </div>
    </div>,
    document.body,
  )
}
