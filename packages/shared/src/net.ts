// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 网络探测相关类型。
 *
 * 放在 shared 而非主进程内部：渲染层要用它渲染延迟列，
 * 否则只能自己镜像一份同形状声明——那种重复不会有编译期保护，
 * 一旦主进程改字段就会静默漂移。
 */

/** 探测手段：TCP 握手 / ICMP / 未能探测 */
export type PingMethod = 'tcp' | 'icmp' | 'none'

export interface PingResult {
  host: string
  port?: number
  reachable: boolean
  /** 往返时延（ms）；不可达时为 LATENCY_UNREACHABLE */
  latencyMs: number
  method: PingMethod
  /** 不可达或降级的原因，适合放进 tooltip */
  reason?: string
}

/** 批量探测的目标 */
export interface PingTarget {
  host: string
  port?: number
}

export interface PingOptions {
  /** 单目标超时（ms），默认 2000 */
  timeoutMs?: number
  /** 整批预算（ms），默认 5000 */
  budgetMs?: number
  /** 并发上限，默认 16 */
  concurrency?: number
  /** TCP 不通时是否回退 ICMP，默认 true */
  allowIcmpFallback?: boolean
}
