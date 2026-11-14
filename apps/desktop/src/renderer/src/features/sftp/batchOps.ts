// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 批量操作的**逐项结果模型**（纯函数）。
 *
 * 为什么必须有这层：批量里**部分失败是常态**（一个文件没权限、一个已经被别人删了）。
 * 只显示"完成"会让用户以为全成了，于是带着错误认知继续干活 —— 这是静默失败。
 * 所以每一项都要有明确状态与失败原因，汇总也要如实。
 *
 * 状态语义：
 * - `pending`   还没轮到我
 * - `running`   正在做（删除/改权限是同步完成的远端操作）
 * - `submitted` 已提交给传输引擎（下载是异步的，完成/失败要等事件回来）
 * - `ok` / `failed`
 */

export type BatchKind = 'download' | 'delete' | 'chmod'

export type BatchItemStatus = 'pending' | 'running' | 'submitted' | 'ok' | 'failed'

export interface BatchItem {
  path: string
  name: string
  isDirectory: boolean
  status: BatchItemStatus
  /** 失败原因（必须给用户看，不是只记日志） */
  error?: string
  /** 下载提交后拿到的传输 id，用于把后续事件归位到这一项 */
  transferId?: string
  /** chmod：成功改动了多少条目（递归时与"1 项"区分开） */
  changed?: number
  /** 逐项失败明细（如 `/dir/a.txt: Permission denied`）—— chmod 的 failed[] 映射过来 */
  details?: string[]
}

export interface BatchReport {
  kind: BatchKind
  items: BatchItem[]
  startedAt: number
  finishedAt?: number
  /** 补充说明（例如"目录只改目录本身权限，主进程无递归 chmod 动作"） */
  note?: string
}

export interface BatchEntryLike {
  path: string
  name: string
  type: string
}

export function createBatchReport(
  kind: BatchKind,
  entries: readonly BatchEntryLike[],
  note?: string,
): BatchReport {
  return {
    kind,
    items: entries.map((e) => ({
      path: e.path,
      name: e.name,
      isDirectory: e.type === 'directory',
      status: 'pending',
    })),
    startedAt: Date.now(),
    ...(note === undefined ? {} : { note }),
  }
}

/** 更新某一项（按 path 定位），返回新报告（不原地改，React 才能看到变化） */
export function markItem(
  report: BatchReport,
  path: string,
  patch: Partial<Omit<BatchItem, 'path' | 'name' | 'isDirectory'>>,
): BatchReport {
  let touched = false
  const items = report.items.map((item) => {
    if (item.path !== path) return item
    touched = true
    return { ...item, ...patch }
  })
  if (!touched) return report
  return { ...report, items }
}

/**
 * 按 transferId 更新某一项。
 * 下载是**异步**的：submit 返回后 invoke 就结束了，真正成功/失败要等
 * SFTP_TRANSFER_FINISHED / SFTP_TRANSFER_ERROR 事件回来，用这个把事件归位到条目上。
 */
export function markItemByTransfer(
  report: BatchReport,
  transferId: string,
  patch: Partial<Omit<BatchItem, 'path' | 'name' | 'isDirectory' | 'transferId'>>,
): BatchReport {
  const index = report.items.findIndex((i) => i.transferId === transferId)
  if (index === -1) return report
  const items = report.items.slice()
  const current = items[index]
  if (!current) return report
  items[index] = { ...current, ...patch }
  return { ...report, items }
}

/** 标记报告结束（所有项都不再 pending/running 时由调用方触发） */
export function finishReport(report: BatchReport): BatchReport {
  return report.finishedAt === undefined ? { ...report, finishedAt: Date.now() } : report
}

export interface BatchCounts {
  total: number
  ok: number
  failed: number
  pending: number
  running: number
  submitted: number
  settled: boolean
}

export function batchCounts(report: BatchReport): BatchCounts {
  let ok = 0
  let failed = 0
  let pending = 0
  let running = 0
  let submitted = 0
  for (const item of report.items) {
    if (item.status === 'ok') ok++
    else if (item.status === 'failed') failed++
    else if (item.status === 'pending') pending++
    else if (item.status === 'running') running++
    else submitted++
  }
  return {
    total: report.items.length,
    ok,
    failed,
    pending,
    running,
    submitted,
    settled: pending === 0 && running === 0,
  }
}

const KIND_LABEL: Record<BatchKind, string> = {
  download: '下载',
  delete: '删除',
  chmod: '改权限',
}

/**
 * 一句话汇总：**成功与失败都要说**。
 * 例：`删除：成功 2 / 失败 1 / 共 3`
 */
export function formatBatchSummary(report: BatchReport): string {
  const c = batchCounts(report)
  const label = KIND_LABEL[report.kind]
  const parts = [`成功 ${c.ok}`]
  if (c.failed > 0) parts.push(`失败 ${c.failed}`)
  if (c.submitted > 0) parts.push(`进行中 ${c.submitted}`)
  if (c.pending > 0 || c.running > 0) parts.push(`待处理 ${c.pending + c.running}`)
  return `${label}：${parts.join(' / ')} / 共 ${c.total}`
}

/** 失败项摘要（每条都带原因），用于 toast 与面板标题 */
export function batchFailureLines(report: BatchReport): string[] {
  return report.items
    .filter((i) => i.status === 'failed')
    .map((i) => `${i.name}：${i.error ?? '未知原因'}`)
}

/** 是否有失败（决定 toast 用 ok 还是 warn/error） */
export function hasFailures(report: BatchReport): boolean {
  return report.items.some((i) => i.status === 'failed')
}


/**
 * 把一次 `sftp.chmod` 的返回映射成批量执行壳能吃的"步骤结果"。
 *
 * 为什么需要它：批量里**部分失败是常态**，而且 chmod 的失败是**目标内部的逐项失败**
 * （`failed[]`）。只把整项标成成功会把"改了 3 个、失败 2 个"糊掉。
 */
export function chmodStepOutcome(result: {
  changed: number
  failed: Array<{ path: string; message: string }>
}): { changed: number; details?: string[]; error?: string } {
  const changed = result.changed
  const details = result.failed.map((f) => `${f.path}: ${f.message}`)
  if (result.failed.length === 0) {
    return { changed, ...(details.length > 0 ? { details } : {}) }
  }
  return {
    changed,
    details,
    error: `${result.failed.length} 项失败（已改 ${changed} 项）`,
  }
}
