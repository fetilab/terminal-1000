// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 拼音首字母搜索单测（spec 示例：输入 qd 匹配「前端」）。
 */

import { describe, expect, it } from 'vitest'
import {
  initialOf,
  initialSegments,
  matchItem,
  matchesPinyin,
  matchesPinyinSubsequence,
  pinyinInitials,
  pinyinTableConflicts,
  searchItems,
} from './search'

describe('映射表自检', () => {
  it('没有同一个字被归到两个首字母（重复会静默改变检索行为）', () => {
    expect(pinyinTableConflicts()).toEqual([])
  })

  it('表内常用字的首字母正确', () => {
    const cases: Array<[string, string]> = [
      ['前', 'q'],
      ['端', 'd'],
      ['数', 's'],
      ['据', 'j'],
      ['库', 'k'],
      ['部', 'b'],
      ['署', 's'],
      ['日', 'r'],
      ['志', 'z'],
      ['监', 'j'],
      ['控', 'k'],
      ['重', 'c'],
      ['启', 'q'],
    ]
    for (const [char, initial] of cases) {
      expect(initialOf(char), char).toBe(initial)
    }
  })
})

describe('pinyinInitials / initialSegments', () => {
  it('★ spec 示例：前端 → qd', () => {
    expect(pinyinInitials('前端')).toBe('qd')
    expect(matchesPinyin('前端', 'qd')).toBe(true)
  })

  it('多字词与混合文本', () => {
    expect(pinyinInitials('数据库')).toBe('sjk')
    expect(pinyinInitials('部署')).toBe('bs')
    expect(pinyinInitials('日志')).toBe('rz')
    expect(pinyinInitials('防火墙')).toBe('fhq')
    // 拉丁字母/数字保留，标点当分隔
    expect(pinyinInitials('nginx 重启')).toBe('nginx' + 'cq')
    expect(pinyinInitials('v2 部署')).toBe('v2bs')
  })

  it('表外汉字不猜测（跳过后不影响精确匹配）', () => {
    expect(pinyinInitials('龘')).toBe('')
    expect(initialOf('龘')).toBeUndefined()
    // 混合时只取表内字的拼音
    expect(pinyinInitials('龘前端')).toBe('qd')
  })

  it('按词切段（"前端 服务" 输入 qd 也能命中）', () => {
    expect(initialSegments('前端 服务')).toEqual(['qd', 'fw'])
    expect(matchesPinyin('前端 服务', 'qd')).toBe(true)
    expect(matchesPinyin('前端 服务', 'fw')).toBe(true)
    expect(matchesPinyin('前端 服务', 'qdfw')).toBe(true)
  })

  it('不会误命中', () => {
    expect(matchesPinyin('前端', 'zz')).toBe(false)
    expect(matchesPinyin('前端', 'dq')).toBe(false) // 顺序不能反
    expect(matchesPinyin('数据库', 'qd')).toBe(false)
  })

  it('空查询恒为真', () => {
    expect(matchesPinyin('前端', '')).toBe(true)
    expect(matchesPinyin('前端', '   ')).toBe(true)
  })

  it('子序列匹配支持跨词缩写', () => {
    expect(matchesPinyinSubsequence('前端防火墙', 'qdfhq')).toBe(true)
    expect(matchesPinyinSubsequence('前端防火墙', 'qdhq')).toBe(true)
    expect(matchesPinyinSubsequence('前端防火墙', 'xq')).toBe(false)
  })
})

describe('matchItem', () => {
  const item = { id: '1', name: '前端构建', note: 'npm run build' }

  it('精确子串优先', () => {
    expect(matchItem(item, '前端')).toBe('exact')
    expect(matchItem(item, '构建')).toBe('exact')
  })

  it('拼音命中', () => {
    expect(matchItem(item, 'qd')).toBe('pinyin')
    expect(matchItem(item, 'qdgj')).toBe('pinyin')
  })

  it('备注命中算 fuzzy', () => {
    expect(matchItem(item, 'npm')).toBe('fuzzy')
  })

  it('不命中返回 none', () => {
    expect(matchItem(item, 'zzzz')).toBe('none')
  })
})

describe('searchItems', () => {
  const items = [
    { id: '1', name: '数据库备份' },
    { id: '2', name: '前端构建' },
    { id: '3', name: '部署服务' },
    { id: '4', name: 'nginx reload' },
  ]

  it('拼音首字母过滤（qd → 前端构建）', () => {
    expect(searchItems(items, 'qd').map((i) => i.id)).toEqual(['2'])
  })

  it('精确匹配排在拼音匹配前面', () => {
    const mixed = [
      { id: 'pinyin', name: '前段' }, // qd（拼音，且不是"前端"精确）
      { id: 'exact', name: 'qd 工具' }, // 精确子串含 qd
    ]
    expect(searchItems(mixed, 'qd').map((i) => i.id)).toEqual(['exact', 'pinyin'])
  })

  it('空查询原样返回（调用方按分组树展示）', () => {
    expect(searchItems(items, '  ').map((i) => i.id)).toEqual(['1', '2', '3', '4'])
  })

  it('多结果时按名称稳定排序', () => {
    const many = [
      { id: 'b', name: '部署 B' },
      { id: 'a', name: '部署 A' },
    ]
    expect(searchItems(many, 'bs').map((i) => i.id)).toEqual(['a', 'b'])
  })

  it('搜不到返回空数组', () => {
    expect(searchItems(items, 'qqqq')).toEqual([])
  })
})
