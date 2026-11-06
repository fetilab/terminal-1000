// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { OutputBatcher } from './output-batcher'

describe('OutputBatcher', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('把时间窗内的高频小包合并成一次交付', () => {
    const flushed: string[] = []
    const b = new OutputBatcher({ windowMs: 16, onFlush: (c) => flushed.push(c) })

    for (const s of ['a', 'b', 'c', 'd', 'e']) b.push(s)
    expect(flushed).toHaveLength(0) // 时间窗未到，不应交付

    vi.advanceTimersByTime(16)
    expect(flushed).toHaveLength(1)
    expect(flushed[0]).toBe('abcde')
  })

  it('体积达到上限时立即交付，不等时间窗', () => {
    const flushed: string[] = []
    const b = new OutputBatcher({ windowMs: 1000, maxBytes: 10, onFlush: (c) => flushed.push(c) })

    b.push('12345')
    expect(flushed).toHaveLength(0)

    b.push('67890') // 累计 10，达到上限
    expect(flushed).toHaveLength(1)
    expect(flushed[0]).toBe('1234567890')
  })

  it('空缓冲不产生交付（避免无意义 IPC）', () => {
    const onFlush = vi.fn()
    const b = new OutputBatcher({ windowMs: 16, onFlush })

    b.flush() // 无内容
    vi.advanceTimersByTime(100)
    expect(onFlush).not.toHaveBeenCalled()
  })

  it('重复 flush 不会重复交付同一批内容', () => {
    const flushed: string[] = []
    const b = new OutputBatcher({ windowMs: 16, onFlush: (c) => flushed.push(c) })

    b.push('x')
    b.flush()
    b.flush()
    vi.advanceTimersByTime(100)
    expect(flushed).toEqual(['x'])
  })

  it('flush 会取消未到点的定时器，不会二次交付', () => {
    const flushed: string[] = []
    const b = new OutputBatcher({ windowMs: 16, onFlush: (c) => flushed.push(c) })

    b.push('a')
    b.flush()
    vi.advanceTimersByTime(1000)
    expect(flushed).toEqual(['a'])
  })

  it('push 空字符串是 no-op', () => {
    const onFlush = vi.fn()
    const b = new OutputBatcher({ onFlush })
    b.push('')
    vi.advanceTimersByTime(100)
    expect(onFlush).not.toHaveBeenCalled()
  })

  it('dispose 后不再交付，且不再接收新数据', () => {
    const onFlush = vi.fn()
    const b = new OutputBatcher({ windowMs: 16, onFlush })

    b.push('pending')
    b.dispose({ flushFirst: true })
    expect(onFlush).toHaveBeenCalledTimes(1)

    b.push('after-dispose')
    vi.advanceTimersByTime(100)
    expect(onFlush).toHaveBeenCalledTimes(1)
  })

  it('dispose 不带 flushFirst 时丢弃缓冲', () => {
    const onFlush = vi.fn()
    const b = new OutputBatcher({ windowMs: 16, onFlush })

    b.push('lost')
    b.dispose()
    vi.advanceTimersByTime(100)
    expect(onFlush).not.toHaveBeenCalled()
  })

  it('统计 flushCount 与 totalBytes 反映实际吞吐', () => {
    const b = new OutputBatcher({ windowMs: 16, maxBytes: 10, onFlush: () => {} })

    b.push('12345')
    b.push('67890') // 触发一次
    vi.advanceTimersByTime(16)

    expect(b.flushCount).toBe(1)
    expect(b.totalBytes).toBe(10)
    expect(b.hasPending).toBe(false)
    expect(b.pending).toBe(0)
  })

  it('大块内容不会因单次超限丢数据', () => {
    const flushed: string[] = []
    const b = new OutputBatcher({ windowMs: 16, maxBytes: 1024, onFlush: (c) => flushed.push(c) })

    // 单次 push 就远超上限 —— 必须完整交付，不能截断
    const big = 'x'.repeat(5000)
    b.push(big)
    expect(flushed.join('')).toBe(big)
  })

  it('合并顺序保持先进先出', () => {
    const flushed: string[] = []
    const b = new OutputBatcher({ windowMs: 16, onFlush: (c) => flushed.push(c) })

    b.push('1')
    vi.advanceTimersByTime(16)
    b.push('2')
    vi.advanceTimersByTime(16)
    b.push('3')
    vi.advanceTimersByTime(16)

    expect(flushed).toEqual(['1', '2', '3'])
  })

  it('吞吐场景：1000 个小包在时间窗内只交付一次', () => {
    const flushed: string[] = []
    // 用大上限，确保由时间窗触发而非体积触发
    const b = new OutputBatcher({ windowMs: 16, maxBytes: 1024 * 1024, onFlush: (c) => flushed.push(c) })

    for (let i = 0; i < 1000; i++) b.push('line\n')
    vi.advanceTimersByTime(16)

    expect(flushed).toHaveLength(1)
    expect(flushed[0]).toBe('line\n'.repeat(1000))
  })
})
