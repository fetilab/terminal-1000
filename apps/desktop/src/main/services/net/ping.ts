// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 延迟探测。
 *
 * 连接列表的「延迟」列需要快速拿到一批主机的可达性与往返时延。
 *
 * 设计取舍：
 * - **优先 TCP 探测**（连目标端口）：不需要特权，且测的是"SSH 端口是否响应"，
 *   比 ICMP 更贴近实际可用性。参考实现两种都用（pingus 的 PingICMP/PingTCP）。
 * - ICMP 作为回退：某些主机不开目标端口但网络可达；ICMP 需要裸 socket 权限，
 *   无权限时退化为调用系统 `ping` 命令，仍不可用则标记为不可测。
 * - **批量并发 + 总预算控制**：列表刷新不能因为个别主机不可达而卡住。
 *   并发上限 + 单目标超时 + 整批预算三者共同兜底。
 * - 不可达统一用 `LATENCY_UNREACHABLE`(9999) 哨兵，便于列表排序时排到最后。
 */

import { spawn } from 'node:child_process'
import { connect, type Socket } from 'node:net'
import { LATENCY_UNREACHABLE } from '@t1000/shared'
import { createLogger } from '../../logger'

const log = createLogger('ping')

export type PingMethod = 'tcp' | 'icmp' | 'none'

export interface PingResult {
  host: string
  port?: number
  reachable: boolean
  /** 往返时延（ms）；不可达时为 LATENCY_UNREACHABLE */
  latencyMs: number
  method: PingMethod
  /** 不可达/降级原因，便于 UI 提示与排查 */
  reason?: string
}

export interface PingOptions {
  /** 单目标超时（ms），默认 2000 */
  timeoutMs?: number
  /** 整批预算（ms），默认 5000；超预算的目标直接标记为未测 */
  budgetMs?: number
  /** 并发上限，默认 16 */
  concurrency?: number
  /**
   * TCP 不通时是否回退到 ICMP，默认 true。
   * 关掉可避免起子进程（受限环境/不想有额外开销），也让行为更可预期。
   */
  allowIcmpFallback?: boolean
}

/** TCP 连通性探测：能建连即视为可达，时延取握手耗时 */
function pingTcp(host: string, port: number, timeoutMs: number): Promise<PingResult> {
  return new Promise<PingResult>((resolve) => {
    const started = Date.now()
    let settled = false
    let socket: Socket | null = null

    const done = (result: PingResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket?.destroy()
      resolve(result)
    }

    const timer = setTimeout(() => {
      done({
        host,
        port,
        reachable: false,
        latencyMs: LATENCY_UNREACHABLE,
        method: 'tcp',
        reason: `TCP 握手超时 (${timeoutMs}ms)`,
      })
    }, timeoutMs)

    try {
      socket = connect({ host, port })
    } catch (err) {
      done({
        host,
        port,
        reachable: false,
        latencyMs: LATENCY_UNREACHABLE,
        method: 'tcp',
        reason: err instanceof Error ? err.message : String(err),
      })
      return
    }

    socket.once('connect', () => {
      done({ host, port, reachable: true, latencyMs: Date.now() - started, method: 'tcp' })
    })
    socket.once('error', (err: NodeJS.ErrnoException) => {
      // 端口拒绝也说明主机是通的 —— 但从"服务可用性"角度仍算不可用，
      // 故标记不可达并保留原因，让 UI 能区分"网络不通"与"端口关了"。
      done({
        host,
        port,
        reachable: false,
        latencyMs: LATENCY_UNREACHABLE,
        method: 'tcp',
        reason: err.code ? `${err.code}` : err.message,
      })
    })
  })
}

/** 调用系统 ping 做一次 ICMP 探测（无裸 socket 权限时的回退） */
function pingIcmp(host: string, timeoutMs: number): Promise<PingResult> {
  return new Promise<PingResult>((resolve) => {
    const started = Date.now()
    const seconds = Math.max(1, Math.ceil(timeoutMs / 1000))

    // -n 不做反向解析；-c 1 单次；-W 超时（秒）
    const args = process.platform === 'win32' ? ['-n', '1', '-w', String(timeoutMs), host] : ['-n', '-c', '1', '-W', String(seconds), host]

    let child: ReturnType<typeof spawn>
    try {
      child = spawn('ping', args, { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch {
      resolve({
        host,
        reachable: false,
        latencyMs: LATENCY_UNREACHABLE,
        method: 'none',
        reason: 'ping 命令不可用',
      })
      return
    }

    let out = ''
    let settled = false
    const done = (result: PingResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        child.kill()
      } catch {
        /* 已退出 */
      }
      resolve(result)
    }

    const timer = setTimeout(() => {
      done({
        host,
        reachable: false,
        latencyMs: LATENCY_UNREACHABLE,
        method: 'icmp',
        reason: `ICMP 超时 (${timeoutMs}ms)`,
      })
    }, timeoutMs + 500)

    child.stdout?.on('data', (d: Buffer) => {
      out += d.toString()
    })
    child.on('error', () => {
      done({
        host,
        reachable: false,
        latencyMs: LATENCY_UNREACHABLE,
        method: 'none',
        reason: 'ping 执行失败',
      })
    })
    child.on('close', (code) => {
      if (code !== 0) {
        done({
          host,
          reachable: false,
          latencyMs: LATENCY_UNREACHABLE,
          method: 'icmp',
          reason: 'ICMP 不可达',
        })
        return
      }
      // Linux: "time=0.123 ms" / Windows: "time<1ms"
      const m = /time[=<]\s*([\d.]+)\s*ms/i.exec(out)
      const latency = m?.[1] ? Number(m[1]) : Date.now() - started
      done({ host, reachable: true, latencyMs: latency, method: 'icmp' })
    })
  })
}

/**
 * 探测单个目标。
 * 给了端口就优先 TCP；TCP 不可达且有权限/命令时再试 ICMP。
 */
export async function pingTarget(
  host: string,
  port?: number,
  options: PingOptions = {},
): Promise<PingResult> {
  const timeoutMs = options.timeoutMs ?? 2000

  if (!host) {
    return {
      host,
      ...(port !== undefined ? { port } : {}),
      reachable: false,
      latencyMs: LATENCY_UNREACHABLE,
      method: 'none',
      reason: '主机为空',
    }
  }

  if (port !== undefined && port > 0) {
    const tcp = await pingTcp(host, port, timeoutMs)
    if (tcp.reachable) return tcp
    if (options.allowIcmpFallback === false) return tcp

    // TCP 不通时再给一次 ICMP 机会：可能是端口被防火墙挡了但主机在
    const icmp = await pingIcmp(host, timeoutMs)
    if (icmp.reachable) return { ...icmp, port }
    // 两者都不可达时，返回 TCP 的结果（原因更有信息量）
    return tcp
  }

  if (options.allowIcmpFallback === false) {
    return {
      host,
      reachable: false,
      latencyMs: LATENCY_UNREACHABLE,
      method: 'none',
      reason: '未提供端口且已禁用 ICMP',
    }
  }
  return pingIcmp(host, timeoutMs)
}

/** 按并发上限跑一批任务（保持输入顺序返回） */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0

  const runner = async (): Promise<void> => {
    for (;;) {
      const i = next++
      if (i >= items.length) return
      results[i] = await worker(items[i]!, i)
    }
  }

  const runners = Array.from({ length: Math.min(limit, items.length) }, () => runner())
  await Promise.all(runners)
  return results
}

/**
 * 批量探测（列表刷新用）。
 *
 * 一次 IPC 拿回整批结果，而不是每个主机一次往返；
 * 整体受 `budgetMs` 约束，超预算的目标标记为未测，避免界面被拖住。
 */
export async function pingMany(
  targets: ReadonlyArray<{ host: string; port?: number }>,
  options: PingOptions = {},
): Promise<PingResult[]> {
  const concurrency = options.concurrency ?? 16
  const budgetMs = options.budgetMs ?? 5000
  const deadline = Date.now() + budgetMs

  const results = await mapWithConcurrency(targets, concurrency, async (t) => {
    if (Date.now() > deadline) {
      return {
        host: t.host,
        ...(t.port !== undefined ? { port: t.port } : {}),
        reachable: false,
        latencyMs: LATENCY_UNREACHABLE,
        method: 'none' as const,
        reason: '超出批量探测预算，未测',
      }
    }
    return pingTarget(t.host, t.port, options)
  })

  log.debug(`批量探测 ${targets.length} 个目标，可达 ${results.filter((r) => r.reachable).length} 个`)
  return results
}
