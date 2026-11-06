// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 输出合批器。
 *
 * 终端数据路径的性能核心：SSH 会话与本地 PTY 都会产生高频小包，
 * 若每个包都发一次 IPC，渲染进程会被事件风暴打爆。
 * 这里按「时间窗 + 体积上限」双阈值合并，再一次性交付。
 *
 * 设计要点：
 * - 时间窗默认 16ms（≈ 一帧），在延迟与吞吐之间取平衡
 * - 体积上限兜底，避免高吞吐时缓冲撑爆内存
 * - **体积达上限立即冲刷**（不等时间窗），保证延迟敏感场景的响应
 * - flush 后清空缓冲；空缓冲不产生回调（避免无意义 IPC）
 *
 * 被 SSH 会话与本地 PTY 共用，保证两者吞吐特性一致。
 */

export interface OutputBatcherOptions {
  /** 时间窗（ms），默认 16 */
  windowMs?: number
  /** 缓冲体积上限（字符数），默认 256 KiB */
  maxBytes?: number
  /** 交付回调 */
  onFlush: (chunk: string) => void
}

export class OutputBatcher {
  private readonly windowMs: number
  private readonly maxBytes: number
  private readonly onFlush: (chunk: string) => void

  private chunks: string[] = []
  private pendingBytes = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  private disposed = false

  /** 累计交付次数（测试与指标用） */
  flushCount = 0
  /** 累计交付字符数 */
  totalBytes = 0

  constructor(options: OutputBatcherOptions) {
    this.windowMs = options.windowMs ?? 16
    this.maxBytes = options.maxBytes ?? 256 * 1024
    this.onFlush = options.onFlush
  }

  /** 追加一段输出 */
  push(chunk: string): void {
    if (this.disposed || chunk.length === 0) return

    this.chunks.push(chunk)
    this.pendingBytes += chunk.length

    // 超过体积上限：立即交付，不等时间窗
    if (this.pendingBytes >= this.maxBytes) {
      this.flush()
      return
    }

    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null
        this.flush()
      }, this.windowMs)
      // 终端输出不应阻止进程退出
      this.timer.unref?.()
    }
  }

  /** 立即交付缓冲内容（定时器到点、体积超限、或主动调用） */
  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (this.chunks.length === 0) return

    // 一次性拼接，避免多次字符串相加产生中间对象
    const payload = this.chunks.length === 1 ? this.chunks[0]! : this.chunks.join('')
    this.chunks = []
    this.pendingBytes = 0

    this.flushCount += 1
    this.totalBytes += payload.length
    this.onFlush(payload)
  }

  /** 当前待交付字符数 */
  get pending(): number {
    return this.pendingBytes
  }

  /** 是否有未交付内容 */
  get hasPending(): boolean {
    return this.pendingBytes > 0
  }

  /** 丢弃缓冲并停止工作（会话关闭时调用） */
  dispose(options: { flushFirst?: boolean } = {}): void {
    if (this.disposed) return
    if (options.flushFirst) this.flush()
    this.disposed = true
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.chunks = []
    this.pendingBytes = 0
  }
}
