// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type UIEvent,
} from 'react'

export interface VirtualListProps<T> {
  items: readonly T[]
  /** 固定行高（px）。固定行高是这套实现的前提，换来的是零依赖与稳定的 60fps */
  rowHeight: number
  /** 视口外上下各多渲染几行，减少快速滚动白屏 */
  overscan?: number
  /** 行数不超过该值时直接全量渲染（小列表更快，也便于调试） */
  threshold?: number
  className?: string
  renderRow: (item: T, index: number) => ReactNode
  getKey: (item: T, index: number) => string
  /** 无数据时渲染的内容 */
  empty?: ReactNode
  role?: string
}

/**
 * 窗口化列表（零依赖）。
 *
 * 为什么自己写：引入 react-window / react-virtual 会带来额外的包体积与 API 约束，
 * 而连接列表和进程列表都只需要「固定行高 + 垂直滚动」这一种场景。
 *
 * 关键点：
 * - 行高固定，所以位置可以纯算术推导，不需要测量每一行；
 * - 滚动用 rAF 节流，避免每个 scroll 事件都触发一次 React 渲染；
 * - 视口高度用 ResizeObserver 跟踪，面板宽度变化不影响行高。
 */
export function VirtualList<T>({
  items,
  rowHeight,
  overscan = 6,
  threshold = 60,
  className,
  renderRow,
  getKey,
  empty,
  role,
}: VirtualListProps<T>): React.JSX.Element {
  const viewportRef = useRef<HTMLDivElement | null>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(0)
  const rafRef = useRef(0)
  const pendingRef = useRef(0)

  useLayoutEffect(() => {
    const el = viewportRef.current
    if (!el) return
    const measure = (): void => setViewportHeight(el.clientHeight)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => {
      ro.disconnect()
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
    }
  }, [])

  const handleScroll = useCallback((e: UIEvent<HTMLDivElement>) => {
    pendingRef.current = e.currentTarget.scrollTop
    if (rafRef.current) return
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0
      setScrollTop(pendingRef.current)
    })
  }, [])

  const virtualize = items.length > threshold
  const classes = ['t-vlist']
  if (className) classes.push(className)

  if (items.length === 0) {
    return (
      <div ref={viewportRef} className={classes.join(' ')} role={role}>
        {empty}
      </div>
    )
  }

  if (!virtualize) {
    return (
      <div ref={viewportRef} className={classes.join(' ')} role={role} onScroll={handleScroll}>
        {items.map((item, i) => (
          <div key={getKey(item, i)}>{renderRow(item, i)}</div>
        ))}
      </div>
    )
  }

  const total = items.length * rowHeight
  const visibleCount = Math.ceil(viewportHeight / rowHeight) + overscan * 2
  const start = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan)
  const end = Math.min(items.length, start + Math.max(visibleCount, 1))
  const slice = items.slice(start, end)

  return (
    <div
      ref={viewportRef}
      className={classes.join(' ')}
      role={role}
      onScroll={handleScroll}
      // 虚拟滚动必须在滚动容器上；键盘/读屏仍能通过行内元素访问
      tabIndex={-1}
    >
      <div className="t-vlist__inner" style={{ height: total }}>
        <div className="t-vlist__window" style={{ transform: `translateY(${start * rowHeight}px)` }}>
          {slice.map((item, i) => (
            <div key={getKey(item, start + i)}>{renderRow(item, start + i)}</div>
          ))}
        </div>
      </div>
    </div>
  )
}
