// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 参数历史回填单测（spec §6.4）：最近使用排序、参数独立、跨命令共享、过期清理、不记动态变量。
 */

import { describe, expect, it } from 'vitest'
import { ParamHistory } from './history'

const DAY = 24 * 3600 * 1000

function make(options: { start?: number; perParamLimit?: number; maxAgeMs?: number } = {}): {
  history: ParamHistory
  tick: (ms: number) => void
  now: () => number
} {
  let clock = options.start ?? 1_000_000
  const history = new ParamHistory({
    now: () => clock,
    ...(options.perParamLimit === undefined ? {} : { perParamLimit: options.perParamLimit }),
    ...(options.maxAgeMs === undefined ? {} : { maxAgeMs: options.maxAgeMs }),
  })
  return { history, tick: (ms) => { clock += ms }, now: () => clock }
}

describe('记录与排序', () => {
  it('最新使用排在最前', () => {
    const { history, tick } = make()
    history.record('db', 'alpha')
    tick(1000)
    history.record('db', 'beta')
    expect(history.recent('db')).toEqual(['beta', 'alpha'])
  })

  it('重复值去重并置顶（不产生重复项）', () => {
    const { history, tick } = make()
    history.record('db', 'alpha')
    tick(10)
    history.record('db', 'beta')
    tick(10)
    history.record('db', 'alpha')
    expect(history.recent('db')).toEqual(['alpha', 'beta'])
  })

  it('latest / prefill 给出回填值', () => {
    const { history, tick } = make()
    history.record('host', 'web-1')
    tick(5)
    history.record('path', '/var/log')
    expect(history.latest('host')).toBe('web-1')
    expect(history.latest('missing')).toBeUndefined()
    expect(history.prefill(['host', 'path', 'missing'])).toEqual({ host: 'web-1', path: '/var/log' })
  })

  it('recordAll 批量记录一次执行的所有参数', () => {
    const { history } = make()
    history.recordAll({ container: 'api', service: 'nginx' })
    expect(history.recent('container')).toEqual(['api'])
    expect(history.recent('service')).toEqual(['nginx'])
  })
})

describe('参数独立与跨命令共享', () => {
  it('不同参数互不影响', () => {
    const { history } = make()
    history.record('a', '1')
    history.record('b', '2')
    expect(history.recent('a')).toEqual(['1'])
    expect(history.recent('b')).toEqual(['2'])
  })

  it('同名参数天然共享历史（跨命令）', () => {
    const { history, tick } = make()
    history.record('database', 'shop')   // 命令 A 填的
    tick(10)
    history.record('database', 'blog')   // 命令 B 填的
    // 之后任何用到 ${{database}} 的命令都能看到这两条
    expect(history.recent('database')).toEqual(['blog', 'shop'])
  })

  it('名字两端空白被归一（"db " 与 "db" 同一份历史）', () => {
    const { history } = make()
    history.record(' db ', 'x')
    expect(history.recent('db')).toEqual(['x'])
  })
})

describe('清理规则', () => {
  it('空值忽略（清空输入不应污染历史）', () => {
    const { history } = make()
    history.record('db', '')
    history.record('db', '   ')
    expect(history.recent('db')).toEqual([])
    expect(history.size).toBe(0)
  })

  it('★ 动态变量不记历史（password/date 等）', () => {
    const { history } = make()
    history.record('password', 's3cret')
    history.record('date', '2025-11-29')
    history.record('random', 'abc123')
    history.record('database', 'shop')
    expect(history.recent('password')).toEqual([])
    expect(history.recent('date')).toEqual([])
    expect(history.size).toBe(1)
  })

  it('每个参数有条数上限，超出丢最旧', () => {
    const { history, tick } = make({ perParamLimit: 3 })
    for (const value of ['v1', 'v2', 'v3', 'v4']) {
      history.record('db', value)
      tick(10)
    }
    expect(history.recent('db')).toEqual(['v4', 'v3', 'v2'])
  })

  it('recent(limit) 只取前 N 条（历史值提示列表用）', () => {
    const { history, tick } = make()
    for (const value of ['a', 'b', 'c']) {
      history.record('db', value)
      tick(10)
    }
    expect(history.recent('db', 2)).toEqual(['c', 'b'])
  })

  it('★ 过期记录自动清理（默认 90 天）', () => {
    const { history, tick } = make()
    history.record('db', 'old')
    tick(100 * DAY)
    history.record('db', 'fresh')
    // old 已过期，只剩 fresh
    expect(history.recent('db')).toEqual(['fresh'])
    expect(history.all()['db']?.map((e) => e.value)).toEqual(['fresh'])
  })

  it('prune 返回清理条数并移除空参数', () => {
    const { history, tick } = make()
    history.record('a', '1')
    history.record('b', '2')
    tick(100 * DAY)
    expect(history.prune()).toBe(2)
    expect(history.size).toBe(0)
  })

  it('clear 清单个或全部', () => {
    const { history } = make()
    history.record('a', '1')
    history.record('b', '2')
    history.clear('a')
    expect(history.recent('a')).toEqual([])
    expect(history.recent('b')).toEqual(['2'])
    history.clear()
    expect(history.size).toBe(0)
  })
})

describe('持久化往返', () => {
  it('all → load 保留值与最近顺序', () => {
    const { history, tick } = make()
    history.record('db', 'alpha')
    tick(100)
    history.record('db', 'beta')
    tick(100)
    history.record('host', 'web-1')

    const dump = history.all()

    // 注意：load 的数据来自假时钟（usedAt 很小），恢复时时钟也要对齐，否则会被判过期
    const target = new ParamHistory({ now: () => 1_000_000 })
    target.load(dump)
    expect(target.recent('db')).toEqual(['beta', 'alpha'])
    expect(target.recent('host')).toEqual(['web-1'])
  })

  it('load 过滤脏数据（非数组、缺字段、动态变量名）', () => {
    const target = new ParamHistory({ now: () => 1_000_000 })
    target.load({
      ok: [{ value: 'v', usedAt: 1 }],
      bad: 'not-an-array' as never,
      password: [{ value: 'secret', usedAt: 1 }],
      mixed: [{ value: 'good', usedAt: 2 }, { value: 123, usedAt: 3 } as never, null as never],
    })
    expect(target.recent('ok')).toEqual(['v'])
    expect(target.recent('password')).toEqual([])
    expect(target.recent('mixed')).toEqual(['good'])
  })

  it('load 会按上限截断并排序', () => {
    const target = new ParamHistory({ perParamLimit: 2, now: () => 1_000_000 })
    target.load({ db: [{ value: 'a', usedAt: 1 }, { value: 'b', usedAt: 5 }, { value: 'c', usedAt: 3 }] })
    expect(target.recent('db')).toEqual(['b', 'c'])
  })

  it('load(undefined) 不炸', () => {
    const target = new ParamHistory()
    expect(() => target.load(undefined)).not.toThrow()
  })
})
