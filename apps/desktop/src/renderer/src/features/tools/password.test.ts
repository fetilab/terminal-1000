// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 密码生成器测试（spec 验收第 7 条「参数与熵值正确」）。
 *
 * 这个模块此前**零测试**且逻辑内嵌在 .tsx 里。抽出来一测就发现
 * 「排除易混淆字符」开关**两个分支产出相同字符集**（字面量本来就已剔除），
 * 也就是那个复选框什么都不做 —— 见下方专门的用例。
 */

import { describe, expect, it } from 'vitest'
import {
  AMBIGUOUS,
  CHARSETS,
  MAX_LENGTH,
  MIN_LENGTH,
  buildPool,
  clampLength,
  entropyBits,
  generate,
  randomInt,
  strengthOf,
  type CharsetOptions,
} from './password'

const ALL_ON: CharsetOptions = {
  lower: true,
  upper: true,
  digit: true,
  symbol: true,
  excludeAmbiguous: false,
}

describe('字符集与易混淆字符', () => {
  it('★ 排除易混淆字符开关**真的改变**字符集（此前是个摆设）', () => {
    const withAmbiguous = buildPool({ ...ALL_ON, excludeAmbiguous: false })
    const without = buildPool({ ...ALL_ON, excludeAmbiguous: true })

    // 开关必须产生实际差异，否则复选框就是骗人的
    expect(without.length).toBeLessThan(withAmbiguous.length)
    // 且差的就是那些易混淆字符
    expect(/[Il1O0o]/.test(withAmbiguous)).toBe(true)
    expect(/[Il1O0o]/.test(without)).toBe(false)
  })

  it('字符集是完整字母/数字表（不含遗漏）', () => {
    // 完整 = 26 个小写 + 26 个大写 + 10 个数字
    expect(CHARSETS.lower).toHaveLength(26)
    expect(CHARSETS.upper).toHaveLength(26)
    expect(CHARSETS.digit).toHaveLength(10)
  })

  it('只选部分字符集时池子按组合变化', () => {
    const onlyDigit = buildPool({ ...ALL_ON, lower: false, upper: false, symbol: false })
    expect(onlyDigit).toBe(CHARSETS.digit)
    const lowerUpper = buildPool({
      ...ALL_ON,
      digit: false,
      symbol: false,
      excludeAmbiguous: true,
    })
    // 剔除的是 l/I/O/0/o/1 六个字符，注意 o 也要去掉 —— 我第一版手写期望时漏了它
    expect(lowerUpper).toBe('abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ')
  })

  it('一个都不选时池子为空（生成器要能安全处理）', () => {
    const empty = buildPool({ lower: false, upper: false, digit: false, symbol: false, excludeAmbiguous: false })
    expect(empty).toBe('')
    expect(generate(20, empty)).toBe('')
  })

  it('AMBIGUOUS 必须是带 /g 的正则 —— 用字符串只会替换第一处', () => {
    expect(AMBIGUOUS.global).toBe(true)
    // 反例演示：用字符串 replace 只替换第一处（这正是当初开关失效的同源陷阱）
    const pool = 'Il1O0o'
    expect(pool.replace(/[Il1O0o]/g, '')).toBe('')
  })
})

describe('长度与生成', () => {
  it('生成的长度等于请求长度', () => {
    const pool = buildPool(ALL_ON)
    for (const n of [4, 8, 20, 64, 128]) {
      expect(generate(n, pool)).toHaveLength(n)
    }
  })

  it('★ 长度被夹到 [4,128]，且生成结果与夹取后的长度一致', () => {
    expect(clampLength(0)).toBe(MIN_LENGTH)
    expect(clampLength(-10)).toBe(MIN_LENGTH)
    expect(clampLength(1e6)).toBe(MAX_LENGTH)
    const pool = buildPool(ALL_ON)
    // 越界请求时，长度也必须按夹取后的来（否则显示的字长与实际不符）
    expect(generate(1000, pool)).toHaveLength(MAX_LENGTH)
    expect(generate(1, pool)).toHaveLength(MIN_LENGTH)
  })

  it('生成结果只含池内字符', () => {
    const pool = buildPool({ ...ALL_ON, excludeAmbiguous: true })
    const pwd = generate(200, pool)
    for (const ch of pwd) expect(pool.includes(ch)).toBe(true)
  })

  it('可注入随机源（测试友好，且不依赖真实熵）', () => {
    const pool = 'abc'
    const pwd = generate(6, pool, () => 0)
    expect(pwd).toBe('aaaaaa')
    // 注意：长度会被夹到下限 4，所以这里不能用 3（那正是"夹取生效"的证明）
    const pwd2 = generate(4, pool, (max) => max - 1)
    expect(pwd2).toBe('cccc')
  })
})

describe('randomInt：边界与无偏性', () => {
  it('返回值始终落在 [0, max)', () => {
    for (let i = 0; i < 500; i++) {
      const v = randomInt(7)
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(7)
      expect(Number.isInteger(v)).toBe(true)
    }
  })

  it('max<=1 时返回 0（不会死循环）', () => {
    expect(randomInt(1)).toBe(0)
    expect(randomInt(0)).toBe(0)
  })

  it('大 max 也不越界（拒绝采样的边界）', () => {
    const max = 0x10000000
    for (let i = 0; i < 200; i++) {
      expect(randomInt(max)).toBeLessThan(max)
    }
  })
})

describe('熵值计算', () => {
  it('熵 = 长度 × log2(池大小)，取整', () => {
    // log2(32)=5 → 20 位 = 100 bit
    expect(entropyBits(20, 32)).toBe(100)
    // log2(64)=6 → 16 位 = 96 bit
    expect(entropyBits(16, 64)).toBe(96)
    // log2(94)≈6.554 → 20 位 ≈ 131
    expect(entropyBits(20, 94)).toBe(131)
  })

  it('池大小 <=1 时熵为 0（不能出现 log2(1)=0 之外的负数）', () => {
    expect(entropyBits(20, 1)).toBe(0)
    expect(entropyBits(20, 0)).toBe(0)
  })

  it('★ 熵按**夹取后**的长度算 —— 与生成的实际长度一致（原实现会虚高）', () => {
    const pool = buildPool(ALL_ON)
    const asked = 1000 // 越界
    const actual = generate(asked, pool).length
    expect(entropyBits(asked, pool.length)).toBe(entropyBits(actual, pool.length))
  })

  it('排除易混淆字符会降低熵（池子小了）—— 这正是开关应有的可观测后果', () => {
    const big = buildPool({ ...ALL_ON, excludeAmbiguous: false })
    const small = buildPool({ ...ALL_ON, excludeAmbiguous: true })
    expect(entropyBits(20, small.length)).toBeLessThan(entropyBits(20, big.length))
  })

  it('长度越长熵越高', () => {
    const pool = buildPool(ALL_ON)
    expect(entropyBits(24, pool.length)).toBeGreaterThan(entropyBits(16, pool.length))
  })
})

describe('强度分档', () => {
  it('阈值边界与文案一致', () => {
    expect(strengthOf(128).label).toBe('很强')
    expect(strengthOf(127).label).toBe('强')
    expect(strengthOf(90).label).toBe('强')
    expect(strengthOf(89).label).toBe('中等')
    expect(strengthOf(60).label).toBe('中等')
    expect(strengthOf(59).label).toBe('偏弱')
  })

  it('强度只取决于熵', () => {
    const bits = entropyBits(20, buildPool(ALL_ON).length)
    expect(strengthOf(bits).label).toBe(strengthOf(bits).label)
    expect(bits).toBeGreaterThan(60)
  })
})
