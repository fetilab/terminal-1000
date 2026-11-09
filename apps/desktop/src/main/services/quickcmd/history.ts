// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 自定义参数的**历史回填**（spec §6.4）。
 *
 * 规则（照 spec 实现）：
 * - 按最近使用时间排序；
 * - **每个参数独立记录**、**跨命令共享**（相同参数名就是同一份历史）；
 * - 自动清理过旧记录（默认 90 天），每个参数还有条数上限（默认 10）；
 * - 动态变量**不记历史**（spec：绿色标签"不记录历史"）——这里做防御性拦截，
 *   即使上层误传 password/date 也不会落库。
 *
 * 纯内存 + 可注入时钟；持久化由 store 适配层读写 `all()` / `load()`。
 */

import { isDynamicVariable } from './variables'

export interface HistoryValue {
  value: string
  /** ms epoch，用于"最近使用"排序与过期清理 */
  usedAt: number
}

export type ParamHistoryData = Record<string, HistoryValue[]>

export interface ParamHistoryOptions {
  /** 每个参数保留多少条（默认 10） */
  perParamLimit?: number
  /** 超过多久算过旧（默认 90 天） */
  maxAgeMs?: number
  now?: () => number
}

const DAY = 24 * 3600 * 1000
const DEFAULTS = { perParamLimit: 10, maxAgeMs: 90 * DAY }

export class ParamHistory {
  private data: ParamHistoryData = {}
  private readonly perParamLimit: number
  private readonly maxAgeMs: number
  private readonly now: () => number

  constructor(options: ParamHistoryOptions = {}) {
    this.perParamLimit = Math.max(1, options.perParamLimit ?? DEFAULTS.perParamLimit)
    this.maxAgeMs = Math.max(0, options.maxAgeMs ?? DEFAULTS.maxAgeMs)
    this.now = options.now ?? (() => Date.now())
  }

  /**
   * 记录一个参数值。
   * - 空值忽略（清空输入框不应污染历史）
   * - 同名值只保留最新一条（去重后置顶）
   * - 动态变量名直接忽略
   */
  record(name: string, value: string): void {
    const key = name.trim()
    const trimmed = value
    if (key === '' || trimmed.trim() === '') return
    if (isDynamicVariable(key)) return

    const list = this.data[key] ?? []
    const kept = list.filter((entry) => entry.value !== trimmed)
    kept.unshift({ value: trimmed, usedAt: this.now() })
    this.data[key] = kept.slice(0, this.perParamLimit)
  }

  /** 批量记录一次执行填写的所有参数 */
  recordAll(values: Readonly<Record<string, string>>): void {
    for (const [name, value] of Object.entries(values)) this.record(name, value)
  }

  /** 某参数的最近值（按最近使用排序，已过滤过期） */
  recent(name: string, limit?: number): string[] {
    const list = (this.data[name.trim()] ?? []).filter((entry) => !this.isExpired(entry))
    const sliced = limit === undefined ? list : list.slice(0, Math.max(0, limit))
    return sliced.map((entry) => entry.value)
  }

  /** 回填用：某参数的**最新值**（没有则 undefined） */
  latest(name: string): string | undefined {
    return this.recent(name, 1)[0]
  }

  /** 一次执行的所有参数预填值（前端填表用） */
  prefill(names: readonly string[]): Record<string, string> {
    const out: Record<string, string> = {}
    for (const name of names) {
      const value = this.latest(name)
      if (value !== undefined) out[name] = value
    }
    return out
  }

  /** 全量数据（持久化用；已剔除过期项） */
  all(): ParamHistoryData {
    const out: ParamHistoryData = {}
    for (const [name, list] of Object.entries(this.data)) {
      const kept = list.filter((entry) => !this.isExpired(entry))
      if (kept.length > 0) out[name] = kept.map((entry) => ({ ...entry }))
    }
    return out
  }

  /** 从持久化数据恢复（过滤脏数据） */
  load(data: ParamHistoryData | undefined | null): void {
    if (!data || typeof data !== 'object') return
    const next: ParamHistoryData = {}
    for (const [name, list] of Object.entries(data)) {
      if (typeof name !== 'string' || name.trim() === '' || isDynamicVariable(name)) continue
      if (!Array.isArray(list)) continue
      const cleaned: HistoryValue[] = []
      for (const raw of list) {
        if (typeof raw !== 'object' || raw === null) continue
        const value = (raw as HistoryValue).value
        const usedAt = (raw as HistoryValue).usedAt
        if (typeof value !== 'string' || value === '') continue
        if (typeof usedAt !== 'number' || !Number.isFinite(usedAt)) continue
        cleaned.push({ value, usedAt })
      }
      cleaned.sort((a, b) => b.usedAt - a.usedAt)
      if (cleaned.length > 0) next[name] = cleaned.slice(0, this.perParamLimit)
    }
    this.data = next
  }

  /** 清掉过期项，返回清理条数 */
  prune(): number {
    let removed = 0
    for (const [name, list] of Object.entries(this.data)) {
      const kept = list.filter((entry) => !this.isExpired(entry))
      removed += list.length - kept.length
      if (kept.length === 0) delete this.data[name]
      else this.data[name] = kept
    }
    return removed
  }

  /** 清空某个参数的历史，或不传参数清空全部 */
  clear(name?: string): void {
    if (name === undefined) {
      this.data = {}
      return
    }
    delete this.data[name.trim()]
  }

  get size(): number {
    return Object.keys(this.data).length
  }

  private isExpired(entry: HistoryValue): boolean {
    return this.now() - entry.usedAt > this.maxAgeMs
  }
}
