// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 批量结果模型单测（纯函数）：**部分失败必须如实反映**。
 */

import { describe, expect, it } from 'vitest'
import {
  batchCounts,
  chmodStepOutcome,
  batchFailureLines,
  createBatchReport,
  finishReport,
  formatBatchSummary,
  hasFailures,
  markItem,
} from './batchOps'

const ENTRIES = [
  { path: '/logs/a.log', name: 'a.log', type: 'file' },
  { path: '/logs/b.log', name: 'b.log', type: 'file' },
  { path: '/logs/old', name: 'old', type: 'directory' },
]

describe('createBatchReport', () => {
  it('每个选中项一条 pending，目录被标记出来', () => {
    const r = createBatchReport('delete', ENTRIES)
    expect(r.items).toHaveLength(3)
    expect(r.items.every((i) => i.status === 'pending')).toBe(true)
    expect(r.items[2]).toMatchObject({ name: 'old', isDirectory: true })
    expect(r.kind).toBe('delete')
  })

  it('可带补充说明（例如"主进程无递归 chmod"）', () => {
    const r = createBatchReport('chmod', ENTRIES, '目录只改目录本身权限')
    expect(r.note).toBe('目录只改目录本身权限')
  })
})

describe('markItem', () => {
  it('只改命中项，其它项保持不变', () => {
    const r0 = createBatchReport('delete', ENTRIES)
    const r1 = markItem(r0, '/logs/b.log', { status: 'failed', error: 'Permission denied' })
    expect(r1.items[1]).toMatchObject({ status: 'failed', error: 'Permission denied' })
    expect(r1.items[0]?.status).toBe('pending')
    expect(r1.items[2]?.status).toBe('pending')
  })

  it('不原地修改（React 才能看到变化）', () => {
    const r0 = createBatchReport('delete', ENTRIES)
    const r1 = markItem(r0, '/logs/a.log', { status: 'ok' })
    expect(r0.items[0]?.status).toBe('pending')
    expect(r1).not.toBe(r0)
  })

  it('path 不存在时原样返回（不算 dirty）', () => {
    const r0 = createBatchReport('delete', ENTRIES)
    expect(markItem(r0, '/nope', { status: 'ok' })).toBe(r0)
  })

  it('可记录 transferId（下载是异步的，后续事件要归位）', () => {
    const r0 = createBatchReport('download', ENTRIES)
    const r1 = markItem(r0, '/logs/a.log', { status: 'submitted', transferId: 't-1' })
    expect(r1.items[0]).toMatchObject({ status: 'submitted', transferId: 't-1' })
  })
})

describe('batchCounts', () => {
  it('分别统计成功/失败/待处理/已提交，并判断是否已收敛', () => {
    let r = createBatchReport('delete', ENTRIES)
    expect(batchCounts(r)).toMatchObject({ total: 3, ok: 0, failed: 0, pending: 3, settled: false })

    r = markItem(r, '/logs/a.log', { status: 'ok' })
    r = markItem(r, '/logs/b.log', { status: 'failed', error: 'no such file' })
    r = markItem(r, '/logs/old', { status: 'running' })
    expect(batchCounts(r)).toMatchObject({ ok: 1, failed: 1, running: 1, settled: false })

    r = markItem(r, '/logs/old', { status: 'ok' })
    expect(batchCounts(r)).toMatchObject({ ok: 2, failed: 1, settled: true })
  })

  it('submitted（下载在途）与 pending 都会让"未收敛"成立', () => {
    let r = createBatchReport('download', ENTRIES)
    r = markItem(r, '/logs/a.log', { status: 'submitted', transferId: 't1' })
    const c = batchCounts(r)
    expect(c.submitted).toBe(1)
    expect(c.pending).toBe(2)
    // 还有 2 项没轮到 → 未收敛
    expect(c.settled).toBe(false)

    // 全部提交后：pending/running 清零 → 界面可以停止"排队中"动画（但传输仍在途）
    r = markItem(r, '/logs/b.log', { status: 'submitted', transferId: 't2' })
    r = markItem(r, '/logs/old', { status: 'submitted', transferId: 't3' })
    expect(batchCounts(r).settled).toBe(true)
    expect(batchCounts(r).submitted).toBe(3)
  })
})

describe('★ 汇总文案：成功与失败都要说', () => {
  it('全部成功', () => {
    let r = createBatchReport('chmod', ENTRIES)
    for (const e of ENTRIES) r = markItem(r, e.path, { status: 'ok' })
    expect(formatBatchSummary(r)).toBe('改权限：成功 3 / 共 3')
  })

  it('部分失败时明确写出失败数', () => {
    let r = createBatchReport('delete', ENTRIES)
    r = markItem(r, '/logs/a.log', { status: 'ok' })
    r = markItem(r, '/logs/b.log', { status: 'failed', error: 'Permission denied' })
    r = markItem(r, '/logs/old', { status: 'ok' })
    expect(formatBatchSummary(r)).toBe('删除：成功 2 / 失败 1 / 共 3')
  })

  it('下载在途时显示进行中', () => {
    let r = createBatchReport('download', ENTRIES)
    r = markItem(r, '/logs/a.log', { status: 'ok' })
    r = markItem(r, '/logs/b.log', { status: 'submitted', transferId: 't1' })
    r = markItem(r, '/logs/old', { status: 'submitted', transferId: 't2' })
    expect(formatBatchSummary(r)).toBe('下载：成功 1 / 进行中 2 / 共 3')
  })

  it('失败明细带原因（用户要知道哪些没成、为什么）', () => {
    let r = createBatchReport('delete', ENTRIES)
    r = markItem(r, '/logs/a.log', { status: 'failed', error: 'Permission denied' })
    r = markItem(r, '/logs/b.log', { status: 'failed' })
    r = markItem(r, '/logs/old', { status: 'ok' })
    expect(batchFailureLines(r)).toEqual(['a.log：Permission denied', 'b.log：未知原因'])
    expect(hasFailures(r)).toBe(true)
  })

  it('无失败时 hasFailures=false', () => {
    let r = createBatchReport('delete', [ENTRIES[0]!])
    r = markItem(r, '/logs/a.log', { status: 'ok' })
    expect(hasFailures(r)).toBe(false)
    expect(batchFailureLines(r)).toEqual([])
  })
})

describe('finishReport', () => {
  it('打上结束时间，重复调用不覆盖', () => {
    const r0 = createBatchReport('delete', ENTRIES)
    const r1 = finishReport(r0)
    expect(r1.finishedAt).toBeTypeOf('number')
    expect(finishReport(r1).finishedAt).toBe(r1.finishedAt)
  })
})


describe('★ chmodStepOutcome：递归 chmod 的"部分成功"必须能表达', () => {
  it('全部成功：只报改动了多少项', () => {
    const outcome = chmodStepOutcome({ changed: 12, failed: [] })
    expect(outcome).toEqual({ changed: 12 })
    expect(outcome.error).toBeUndefined()
  })

  it('部分失败：★ 既说改了 N 项，也给出逐项原因（不能糊成一个"失败"）', () => {
    const outcome = chmodStepOutcome({
      changed: 3,
      failed: [
        { path: '/tree/a.txt', message: 'Permission denied' },
        { path: '/tree/b.txt', message: 'No such file' },
      ],
    })
    expect(outcome.changed).toBe(3)
    expect(outcome.error).toBe('2 项失败（已改 3 项）')
    expect(outcome.details).toEqual([
      '/tree/a.txt: Permission denied',
      '/tree/b.txt: No such file',
    ])
  })

  it('全部失败：changed=0 也要如实说', () => {
    const outcome = chmodStepOutcome({ changed: 0, failed: [{ path: '/x', message: 'boom' }] })
    expect(outcome.error).toBe('1 项失败（已改 0 项）')
  })

  it('映射到面板：失败项的 details 会进 BatchItem（面板逐条展示）', () => {
    let report = createBatchReport('chmod', [{ path: '/tree', name: 'tree', type: 'directory' }])
    const outcome = chmodStepOutcome({ changed: 1, failed: [{ path: '/tree/a', message: 'EACCES' }] })
    report = markItem(report, '/tree', {
      status: outcome.error ? 'failed' : 'ok',
      ...(outcome.error === undefined ? {} : { error: outcome.error }),
      ...(outcome.changed === undefined ? {} : { changed: outcome.changed }),
      ...(outcome.details === undefined ? {} : { details: outcome.details }),
    })
    expect(report.items[0]).toMatchObject({
      status: 'failed',
      changed: 1,
      error: '1 项失败（已改 1 项）',
      details: ['/tree/a: EACCES'],
    })
    expect(batchCounts(report).failed).toBe(1)
  })
})
