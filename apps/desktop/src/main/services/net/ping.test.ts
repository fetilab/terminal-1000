// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

import { createServer, type Server } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { LATENCY_UNREACHABLE } from '@t1000/shared'
import { pingMany, pingTarget } from './ping'

describe('pingTarget — TCP 探测', () => {
  let server: Server
  let openPort: number

  beforeAll(async () => {
    server = createServer()
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const addr = server.address()
    openPort = typeof addr === 'object' && addr ? addr.port : 0
  }, 10_000)

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it('端口可连时可达，且时延为合理值', async () => {
    const r = await pingTarget('127.0.0.1', openPort, { allowIcmpFallback: false })

    expect(r.reachable).toBe(true)
    expect(r.method).toBe('tcp')
    expect(r.latencyMs).toBeGreaterThanOrEqual(0)
    expect(r.latencyMs).toBeLessThan(LATENCY_UNREACHABLE)
  })

  it('端口关闭时不可达，并使用哨兵值', async () => {
    // 127.0.0.1:1 通常立即 ECONNREFUSED
    const r = await pingTarget('127.0.0.1', 1, { allowIcmpFallback: false, timeoutMs: 1500 })

    expect(r.reachable).toBe(false)
    expect(r.latencyMs).toBe(LATENCY_UNREACHABLE)
    expect(r.reason).toBeTruthy()
  })

  it('超时目标被中止，不会永久挂起', async () => {
    const started = Date.now()
    // 10.255.255.1 通常不可路由；给很短超时
    const r = await pingTarget('10.255.255.1', 65000, { allowIcmpFallback: false, timeoutMs: 400 })
    const elapsed = Date.now() - started

    expect(r.reachable).toBe(false)
    expect(r.latencyMs).toBe(LATENCY_UNREACHABLE)
    expect(elapsed).toBeLessThan(3000)
  }, 10_000)

  it('空主机名直接返回不可达并给出原因', async () => {
    const r = await pingTarget('', 22)
    expect(r.reachable).toBe(false)
    expect(r.method).toBe('none')
    expect(r.reason).toContain('主机为空')
  })

  it('未提供端口且禁用 ICMP 时明确说明，而不是静默失败', async () => {
    const r = await pingTarget('127.0.0.1', undefined, { allowIcmpFallback: false })
    expect(r.reachable).toBe(false)
    expect(r.method).toBe('none')
    expect(r.reason).toContain('禁用 ICMP')
  })
})

describe('pingMany — 批量探测', () => {
  let server: Server
  let openPort: number

  beforeAll(async () => {
    server = createServer()
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const addr = server.address()
    openPort = typeof addr === 'object' && addr ? addr.port : 0
  }, 10_000)

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it('结果顺序与输入一致', async () => {
    const targets = [
      { host: '127.0.0.1', port: openPort },
      { host: '127.0.0.1', port: 1 },
      { host: '127.0.0.1', port: openPort },
    ]
    const results = await pingMany(targets, { allowIcmpFallback: false, timeoutMs: 1000 })

    expect(results).toHaveLength(3)
    expect(results[0]!.host).toBe('127.0.0.1')
    expect(results[0]!.reachable).toBe(true)
    expect(results[1]!.reachable).toBe(false)
    expect(results[2]!.reachable).toBe(true)
  }, 15_000)

  it('超过整批预算的目标被标记为未测，而不是让整批卡住', async () => {
    // 用极短预算 + 不可路由目标，强制触发预算分支
    const targets = Array.from({ length: 40 }, () => ({ host: '10.255.255.1', port: 65000 }))
    const started = Date.now()
    const results = await pingMany(targets, {
      allowIcmpFallback: false,
      timeoutMs: 3000,
      budgetMs: 300,
      concurrency: 2,
    })
    const elapsed = Date.now() - started

    expect(results).toHaveLength(40)
    // 预算生效：整批不应远超预算
    expect(elapsed).toBeLessThan(6000)
    // 至少有一部分被标为"超出预算"
    expect(results.some((r) => r.reason?.includes('预算'))).toBe(true)
  }, 20_000)

  it('空列表返回空结果', async () => {
    expect(await pingMany([], {})).toEqual([])
  })

  it('并发上限生效：大量目标仍能在合理时间完成', async () => {
    const targets = Array.from({ length: 32 }, () => ({ host: '127.0.0.1', port: openPort }))
    const started = Date.now()
    const results = await pingMany(targets, { concurrency: 8, timeoutMs: 1000 })
    const elapsed = Date.now() - started

    expect(results.every((r) => r.reachable)).toBe(true)
    expect(elapsed).toBeLessThan(8000)
  }, 20_000)
})
