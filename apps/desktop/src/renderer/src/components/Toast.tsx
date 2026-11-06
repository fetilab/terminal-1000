// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

import { useSyncExternalStore } from 'react'
import { Icon, type IconName } from './Icon'
import { IconButton } from './Button'

export type ToastKind = 'info' | 'ok' | 'warn' | 'error'

export interface ToastItem {
  id: string
  kind: ToastKind
  text: string
  /** 毫秒；0 表示需要手动关闭 */
  ttl: number
}

/* ── 极简 toast 队列：与业务状态解耦，任何模块都能直接调用 ── */

let items: ToastItem[] = []
const listeners = new Set<() => void>()
let seq = 0
const timers = new Map<string, ReturnType<typeof setTimeout>>()

function emit(): void {
  for (const l of listeners) l()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function snapshot(): ToastItem[] {
  return items
}

function dismiss(id: string): void {
  const timer = timers.get(id)
  if (timer) {
    clearTimeout(timer)
    timers.delete(id)
  }
  if (!items.some((t) => t.id === id)) return
  items = items.filter((t) => t.id !== id)
  emit()
}

function push(kind: ToastKind, text: string, ttl = 4200): string {
  const id = `toast-${++seq}`
  // 同类同文的重复提示合并，避免刷屏（例如后端连续报同一个错）
  const dup = items.find((t) => t.kind === kind && t.text === text)
  if (dup) {
    const timer = timers.get(dup.id)
    if (timer) clearTimeout(timer)
    if (ttl > 0) timers.set(dup.id, setTimeout(() => dismiss(dup.id), ttl))
    return dup.id
  }
  items = [...items, { id, kind, text, ttl }]
  emit()
  if (ttl > 0) timers.set(id, setTimeout(() => dismiss(id), ttl))
  return id
}

/** 全局提示出口。视图层不吞异常，统一从这里反馈给用户。 */
export const toast = {
  info: (text: string, ttl?: number) => push('info', text, ttl),
  ok: (text: string, ttl?: number) => push('ok', text, ttl),
  warn: (text: string, ttl?: number) => push('warn', text, ttl),
  error: (text: string, ttl?: number) => push('error', text, ttl ?? 6000),
  dismiss,
  clear: () => {
    items = []
    emit()
  },
}

const ICONS: Record<ToastKind, IconName> = {
  info: 'info',
  ok: 'check-circle',
  warn: 'alert-triangle',
  error: 'alert-circle',
}

/** 挂在应用根部一次即可。 */
export function ToastHost(): React.JSX.Element {
  const list = useSyncExternalStore(subscribe, snapshot, snapshot)
  return (
    <div className="t-toasts" role="status" aria-live="polite">
      {list.map((t) => (
        <div key={t.id} className={`t-toast t-toast--${t.kind}`}>
          <span className="t-toast__icon">
            <Icon name={ICONS[t.kind]} size={15} />
          </span>
          <div className="t-toast__body">{t.text}</div>
          <IconButton
            className="t-toast__dismiss"
            icon="close"
            label="关闭提示"
            size={13}
            onClick={() => dismiss(t.id)}
          />
        </div>
      ))}
    </div>
  )
}
