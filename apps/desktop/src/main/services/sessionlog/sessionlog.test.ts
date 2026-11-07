// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 会话日志/录制测试。
 *
 * 数据来源走**中立契约**的 publishSessionData（真实路径），
 * 而不是去 mock 内部方法 —— 这样也顺带验证了"生产者发布 / 消费者订阅"这条链路。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { publishSessionData, sessionDataListenerCount } from '../session-registry'
import { SessionLogService } from './index'

let dir: string
let svc: SessionLogService

/** 等待写入流落盘（fs 流是异步的） */
const settle = (ms = 60): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe('SessionLogService', () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 't1000-sessionlog-'))
    svc = new SessionLogService(dir)
  })

  afterEach(async () => {
    // 先停掉所有录制让写入流关闭，再删临时目录。
    // 否则流还在写、目录已被删 → ENOENT 会以未捕获异常的形式冒出来。
    svc.stop()
    await settle(30)
    rmSync(dir, { recursive: true, force: true })
  })

  it('开始录制会创建 .log / .timing / .meta.json 三个文件', async () => {
    const { logId, logPath } = svc.start('sess-1', 'prod-web')
    await settle()

    expect(existsSync(logPath)).toBe(true)
    expect(existsSync(join(dir, `${logId}.timing`))).toBe(true)
    expect(existsSync(join(dir, `${logId}.meta.json`))).toBe(true)
    expect(logId).toContain('prod-web')
  })

  it('★ 通道打通：publishSessionData 的输出被写进日志', async () => {
    svc.start('sess-1', 'demo')
    publishSessionData('sess-1', 'hello ')
    publishSessionData('sess-1', 'world\n')
    await settle()

    svc.stop()
    await settle()

    const content = readFileSync(join(dir, `${svc.list()[0]!.logId}.log`), 'utf8')
    expect(content).toBe('hello world\n')
  })

  it('时间线记录每次写入的偏移与长度', async () => {
    svc.start('sess-1', 'demo')
    publishSessionData('sess-1', 'abc')
    publishSessionData('sess-1', 'de')
    await settle()
    svc.stop()
    await settle()

    const logId = svc.list()[0]!.logId
    const timing = readFileSync(join(dir, `${logId}.timing`), 'utf8').trim().split('\n')
    const parsed = timing.map((l) => JSON.parse(l) as { t: number; n: number })

    expect(parsed).toHaveLength(2)
    expect(parsed.map((p) => p.n)).toEqual([3, 2])
    // 偏移单调不减
    expect(parsed[1]!.t).toBeGreaterThanOrEqual(parsed[0]!.t)
  })

  it('会话断开时订阅被解除（不留泄漏的监听）', () => {
    svc.start('sess-1', 'demo')
    expect(sessionDataListenerCount('sess-1')).toBe(1)

    svc.stop('sess-1')
    expect(sessionDataListenerCount('sess-1')).toBe(0)
  })

  it('同一会话重复 start 报冲突而不是静默开两份', () => {
    svc.start('sess-1', 'demo')
    expect(() => svc.start('sess-1', 'demo2')).toThrow(/已在录制/)
  })

  it('不同会话可同时录制，互不串数据', async () => {
    svc.start('a', 'conn-a')
    svc.start('b', 'conn-b')
    publishSessionData('a', 'AAA')
    publishSessionData('b', 'BBB')
    await settle()
    svc.stop()
    await settle()

    const logs = svc.list()
    const find = (t: string): string => {
      const meta = logs.find((l) => l.title === t)!
      return readFileSync(join(dir, `${meta.logId}.log`), 'utf8')
    }
    expect(find('conn-a')).toBe('AAA')
    expect(find('conn-b')).toBe('BBB')
  })

  it('★ 达到大小上限时自动停止并给出原因（不无限吃磁盘）', async () => {
    // 临时把上限调到很小
    const prev = process.env.T1000_MAX_SESSIONLOG_BYTES
    process.env.T1000_MAX_SESSIONLOG_BYTES = '10'
    try {
      const { logId } = svc.start('sess-1', 'tiny')
      publishSessionData('sess-1', 'x'.repeat(6)) // 6 <= 10，写入
      publishSessionData('sess-1', 'y'.repeat(6)) // 会越过上限 → 停止
      await settle()

      // 超限后不再写入（当前块整体丢弃，不产生半行）
      const size = statSync(join(dir, `${logId}.log`)).size
      expect(size).toBe(6)

      const meta = JSON.parse(readFileSync(join(dir, `${logId}.meta.json`), 'utf8')) as {
        stopReason?: string
        stoppedAt?: string
      }
      expect(meta.stopReason).toContain('上限')
      expect(meta.stoppedAt).toBeTruthy()
      // 已自动移出活跃列表
      expect(svc.active()).toHaveLength(0)
    } finally {
      if (prev === undefined) delete process.env.T1000_MAX_SESSIONLOG_BYTES
      else process.env.T1000_MAX_SESSIONLOG_BYTES = prev
    }
  })

  it('stop 会写 stoppedAt 与 stopReason', async () => {
    const { logId } = svc.start('sess-1', 'demo')
    publishSessionData('sess-1', 'data')
    await settle()
    svc.stop('sess-1', '会话已断开')
    await settle()

    const meta = JSON.parse(readFileSync(join(dir, `${logId}.meta.json`), 'utf8')) as {
      stoppedAt?: string
      stopReason?: string
      bytes: number
    }
    expect(meta.stopReason).toBe('会话已断开')
    expect(meta.stoppedAt).toBeTruthy()
    expect(meta.bytes).toBe(4)
  })

  it('list 按开始时间倒序，并带上真实文件大小与时间线标记', async () => {
    svc.start('a', 'first')
    await settle(1100) // 时间戳精确到秒，隔一秒才能稳定排序
    svc.start('b', 'second')
    publishSessionData('b', 'xx')
    await settle()
    svc.stop()
    await settle()

    const logs = svc.list()
    expect(logs).toHaveLength(2)
    expect(logs[0]!.title).toBe('second')
    expect(logs[1]!.title).toBe('first')
    expect(logs[0]!.hasTiming).toBe(true)
    expect(logs[0]!.sizeBytes).toBe(2)
  })

  it('active 返回正在录制的会话及已写字节数', async () => {
    svc.start('sess-1', 'demo')
    publishSessionData('sess-1', 'abcdef')
    await settle()

    const active = svc.active()
    expect(active).toHaveLength(1)
    expect(active[0]!.sessionId).toBe('sess-1')
    expect(active[0]!.bytes).toBe(6)
  })

  it('read 默认从尾部读，避免把整个大日志推给渲染层', async () => {
    const { logId } = svc.start('sess-1', 'demo')
    publishSessionData('sess-1', 'A'.repeat(1000))
    await settle()
    svc.stop()
    await settle()

    const r = svc.read(logId, { limit: 100 })
    expect(r.totalBytes).toBe(1000)
    expect(r.content).toHaveLength(100)
    expect(r.content).toBe('A'.repeat(100))
    // 从尾部读意味着前面还有内容
    expect(r.hasMore).toBe(true)
    expect(r.offset).toBe(900)
  })

  it('read 支持指定偏移从头读', async () => {
    const { logId } = svc.start('sess-1', 'demo')
    publishSessionData('sess-1', '0123456789')
    await settle()
    svc.stop()
    await settle()

    const r = svc.read(logId, { offset: 2, limit: 4, fromEnd: false })
    expect(r.content).toBe('2345')
    expect(r.offset).toBe(2)
  })

  it('从文件开头读且读完时两个方向都没有更多', async () => {
    const { logId } = svc.start('sess-1', 'demo')
    publishSessionData('sess-1', '0123456789')
    await settle()
    svc.stop()
    await settle()

    const r = svc.read(logId, { offset: 0, limit: 999, fromEnd: false })
    expect(r.content).toBe('0123456789')
    expect(r.hasMoreBefore).toBe(false)
    expect(r.hasMoreAfter).toBe(false)
    expect(r.hasMore).toBe(false)
  })

  it('read 不存在的日志报 NOT_FOUND', () => {
    expect(() => svc.read('no-such-log')).toThrow(/不存在/)
  })

  it('delete 同时清掉 log / timing / meta 三个文件', async () => {
    const { logId } = svc.start('sess-1', 'demo')
    publishSessionData('sess-1', 'x')
    await settle()
    svc.stop()
    await settle()

    const before = readdirSync(dir).filter((f) => f.startsWith(logId))
    expect(before).toHaveLength(3)

    expect(svc.remove(logId)).toEqual({ deleted: true })
    expect(readdirSync(dir).filter((f) => f.startsWith(logId))).toHaveLength(0)
    expect(svc.list()).toHaveLength(0)
  })

  it('delete 不存在的日志报 NOT_FOUND', () => {
    expect(() => svc.remove('nope')).toThrow(/不存在/)
  })

  it('标题里的路径分隔符被中和（不会写到目录外）', async () => {
    const { logId, logPath } = svc.start('sess-1', '../../etc/passwd')
    await settle()

    expect(logId).not.toContain('/')
    expect(logId).not.toContain('..')
    // 文件确实落在日志目录内
    expect(logPath.startsWith(dir)).toBe(true)
    expect(readdirSync(dir).some((f) => f.includes('etc_passwd'))).toBe(true)
  })

  it('元信息损坏时 list 跳过而不是整体失败', async () => {
    svc.start('sess-1', 'good')
    await settle()
    svc.stop()
    await settle()

    // 塞一个坏文件
    const { writeFileSync } = await import('node:fs')
    writeFileSync(join(dir, 'broken.meta.json'), '{ not json')

    expect(() => svc.list()).not.toThrow()
    expect(svc.list()).toHaveLength(1)
  })
})
