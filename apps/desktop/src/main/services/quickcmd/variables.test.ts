// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 动态变量单测：求值（确定性的时钟/随机）、格式、当前值预览（含机密打码）。
 */

import { describe, expect, it } from 'vitest'
import {
  DYNAMIC_VARIABLES,
  evaluateVariable,
  formatDateTime,
  getVariableDef,
  isDynamicVariable,
  isoWeek,
  listVariablePreviews,
  variablePreview,
  variableSnippet,
  type VariableContext,
} from './variables'

/** 固定时钟：2025-11-29 14:30:45 本地时间（spec 表格示例） */
const FIXED = new Date(2025, 10, 29, 14, 30, 45)

function ctx(patch: Partial<VariableContext> = {}): VariableContext {
  return { now: FIXED, randomString: (n) => 'x'.repeat(n), uuid: () => 'fixed-uuid', ...patch }
}

describe('date / time 格式', () => {
  it('默认格式与 spec 示例一致', () => {
    expect(evaluateVariable('date', undefined, ctx())).toBe('2025-11-29')
    expect(evaluateVariable('time', undefined, ctx())).toBe('14:30:45')
  })

  it('支持自定义格式（含无分隔符形式）', () => {
    expect(evaluateVariable('date', 'YYYYMMDD', ctx())).toBe('20251129')
    expect(evaluateVariable('date', 'YYYY-MM', ctx())).toBe('2025-11')
    expect(evaluateVariable('date', 'YY', ctx())).toBe('25')
    expect(evaluateVariable('date', 'DD/MM/YYYY', ctx())).toBe('29/11/2025')
    expect(evaluateVariable('time', 'HHmmss', ctx())).toBe('143045')
    expect(evaluateVariable('time', 'HH:mm', ctx())).toBe('14:30')
    expect(evaluateVariable('time', 'ss', ctx())).toBe('45')
  })

  it('未识别的 token 原样保留', () => {
    expect(formatDateTime(FIXED, 'YYYY年MM月DD日')).toBe('2025年11月29日')
    expect(formatDateTime(FIXED, 'QQ')).toBe('QQ')
  })

  it('补零正确（个位数月/日/时）', () => {
    const early = new Date(2025, 0, 5, 9, 8, 7)
    expect(evaluateVariable('date', 'YYYY-MM-DD', ctx({ now: early }))).toBe('2025-01-05')
    expect(evaluateVariable('time', 'HH:mm:ss', ctx({ now: early }))).toBe('09:08:07')
  })
})

describe('timestamp / week', () => {
  it('timestamp 是秒级 Unix 时间', () => {
    expect(evaluateVariable('timestamp', undefined, ctx())).toBe(String(Math.floor(FIXED.getTime() / 1000)))
  })

  it('week 是 ISO 周数（含跨年边界）', () => {
    expect(evaluateVariable('week', undefined, ctx())).toBe('48')
    // 2025-12-29 属于 2026 年第 1 周
    expect(isoWeek(new Date(2025, 11, 29))).toBe(1)
    expect(isoWeek(new Date(2026, 0, 1))).toBe(1)
  })
})

describe('uuid / random', () => {
  it('uuid 用注入的生成器', () => {
    expect(evaluateVariable('uuid', undefined, ctx())).toBe('fixed-uuid')
  })

  it('random 默认 6 位，可指定长度并夹到 1-64', () => {
    const lengths: number[] = []
    const counting = ctx({
      randomString: (n) => {
        lengths.push(n)
        return 'a'.repeat(n)
      },
    })
    expect(evaluateVariable('random', undefined, counting)).toHaveLength(6)
    expect(evaluateVariable('random', '8', counting)).toHaveLength(8)
    expect(evaluateVariable('random', '4', counting)).toHaveLength(4)
    expect(evaluateVariable('random', '999', counting)).toHaveLength(64)
    expect(evaluateVariable('random', '0', counting)).toHaveLength(1)
    expect(lengths).toEqual([6, 8, 4, 64, 1])
  })

  it('random 非数字格式回退到 6 位', () => {
    expect(evaluateVariable('random', 'abc', ctx())).toHaveLength(6)
  })
})

describe('clipboard / password / 主机信息', () => {
  it('取注入的剪贴板与密码', () => {
    expect(evaluateVariable('clipboard', undefined, ctx({ clipboard: 'hello' }))).toBe('hello')
    expect(evaluateVariable('password', undefined, ctx({ password: 's3cret' }))).toBe('s3cret')
  })

  it('未提供时返回空串（不抛错）', () => {
    expect(evaluateVariable('clipboard', undefined, ctx())).toBe('')
    expect(evaluateVariable('password', undefined, ctx())).toBe('')
  })

  it('hostname / username / ip 用注入值', () => {
    const c = ctx({ hostname: 'dev-box', username: 'mosfet', localIp: '192.168.1.20' })
    expect(evaluateVariable('hostname', undefined, c)).toBe('dev-box')
    expect(evaluateVariable('username', undefined, c)).toBe('mosfet')
    expect(evaluateVariable('ip', undefined, c)).toBe('192.168.1.20')
  })

  it('未知变量返回空串', () => {
    expect(evaluateVariable('nope', undefined, ctx())).toBe('')
  })
})

describe('变量识别', () => {
  it('isDynamicVariable 区分内置变量与自定义参数', () => {
    expect(isDynamicVariable('date')).toBe(true)
    expect(isDynamicVariable(' password ')).toBe(true)
    expect(isDynamicVariable('database')).toBe(false)
    expect(getVariableDef('random')?.defaultFormat).toBe('6')
  })

  it('内置变量表覆盖 spec 表格的 8 个', () => {
    const names = DYNAMIC_VARIABLES.map((v) => v.name)
    for (const required of ['date', 'time', 'timestamp', 'week', 'uuid', 'random', 'clipboard', 'password']) {
      expect(names, required).toContain(required)
    }
    // 任务要求补充的常用变量
    for (const extra of ['hostname', 'username', 'ip']) {
      expect(names, extra).toContain(extra)
    }
  })
})

describe('★ 当前值预览（spec 硬要求）', () => {
  it('普通变量给出真实当前值、格式与说明', () => {
    const preview = variablePreview(getVariableDef('date')!, ctx())
    expect(preview).toMatchObject({
      name: 'date',
      description: '当前日期',
      format: 'YYYY-MM-DD',
      value: '2025-11-29',
      masked: false,
      hasValue: true,
      secret: false,
    })
  })

  it('传入格式时按格式预览', () => {
    const preview = variablePreview(getVariableDef('date')!, ctx(), 'YYYYMMDD')
    expect(preview.format).toBe('YYYYMMDD')
    expect(preview.value).toBe('20251129')
  })

  it('★ 机密变量（password）打码但仍告知"有值"', () => {
    const withPwd = variablePreview(getVariableDef('password')!, ctx({ password: 's3cret' }))
    expect(withPwd.masked).toBe(true)
    expect(withPwd.secret).toBe(true)
    expect(withPwd.hasValue).toBe(true)
    expect(withPwd.value).not.toContain('s3cret')
    expect(withPwd.value).toContain('•')

    const empty = variablePreview(getVariableDef('password')!, ctx())
    expect(empty.masked).toBe(true)
    expect(empty.hasValue).toBe(false)
    expect(empty.value).toBe('')
  })

  it('listVariablePreviews 覆盖全部变量且都带说明与值字段', () => {
    const previews = listVariablePreviews(ctx({ clipboard: 'cb', password: 'p' }))
    expect(previews).toHaveLength(DYNAMIC_VARIABLES.length)
    for (const p of previews) {
      expect(p.description).not.toBe('')
      expect(p.name).not.toBe('')
      expect(typeof p.value).toBe('string')
      expect(typeof p.hasValue).toBe('boolean')
    }
  })

  it('variableSnippet 生成可插入文本', () => {
    expect(variableSnippet('date')).toBe('${{date}}')
    expect(variableSnippet('date', 'YYYYMMDD')).toBe('${{date:YYYYMMDD}}')
  })
})
