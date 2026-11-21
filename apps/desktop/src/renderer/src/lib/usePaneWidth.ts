// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 可拖动分栏：窗口内各面板的宽度记忆与拖拽手柄。
 *
 * ## 为什么宽度存在 localStorage 而不是 store
 * 宽度是纯外观偏好，不参与任何 IPC、也不影响逻辑；放 localStorage 可以
 * 不必等 store 就绪就有值，首帧直接按上次宽度布局（不会先按默认宽度画一帧再跳）。
 * 键名带 `t1000:ws:` 前缀，与 SFTP 的视图记忆（`t1000:sftp-view`）同一约定。
 *
 * ## 为什么要 clamp
 * 用户把窗口拉窄后，上次记住的宽度可能超过可用空间；clamp 保证任何窗口尺寸下
 * 三个面板都还留得住最小可用宽度（拖动时由 Splitter 约束，读取时由这里约束）。
 */

import { useCallback, useEffect, useRef, useState } from 'react'

export interface PaneWidthOptions {
  key: string
  initial: number
  min: number
  max: number
}

function readWidth(key: string, initial: number, min: number, max: number): number {
  try {
    const raw = localStorage.getItem(key)
    if (raw === null) return initial
    const n = Number(raw)
    if (!Number.isFinite(n)) return initial
    return Math.min(max, Math.max(min, Math.round(n)))
  } catch {
    // 隐私模式/存储配额异常：退回默认宽度，不影响可用性
    return initial
  }
}

export interface PaneWidthApi {
  width: number
  setWidth: (next: number) => void
  reset: () => void
  /** 边界一并回传：Splitter 需要它们做键盘/拖动的约束与 aria 值 */
  min: number
  max: number
}

export function usePaneWidth({ key, initial, min, max }: PaneWidthOptions): PaneWidthApi {
  const [width, setWidthState] = useState(() => readWidth(key, initial, min, max))
  /** 连续拖动时不必每个 pointermove 都写一次存储 */
  const timer = useRef<number | null>(null)

  const persist = useCallback(
    (value: number): void => {
      if (timer.current !== null) window.clearTimeout(timer.current)
      timer.current = window.setTimeout(() => {
        try {
          localStorage.setItem(key, String(value))
        } catch {
          // 写不进去只意味着"下次回到默认宽度"，不该打断交互
        }
      }, 200)
    },
    [key],
  )

  const setWidth = useCallback(
    (next: number): void => {
      const clamped = Math.min(max, Math.max(min, Math.round(next)))
      setWidthState(clamped)
      persist(clamped)
    },
    [max, min, persist],
  )

  const reset = useCallback((): void => {
    setWidthState(initial)
    persist(initial)
  }, [initial, persist])

  // 卸载时把待写的宽度落盘，避免"拖完立刻切视图"丢掉最后一次
  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current)
    },
    [],
  )

  return { width, setWidth, reset, min, max }
}
