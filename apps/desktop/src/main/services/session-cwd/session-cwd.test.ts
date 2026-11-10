// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * cwd 跟踪测试。
 *
 * 重点是 **OSC 序列被 TCP 读切成两段** —— 这是这类解析器最经典的 bug：
 * 逐块独立解析时，半截 `\x1b]7;file://host/ho` 会因为"没有终止符"被丢弃，
 * 于是路径永远拿不到，但**不报任何错**，看起来像"远端 shell 不发 OSC 7"。
 */

import { beforeEach, describe, expect, it } from 'vitest'
import {
  clearAllCwd,
  feedSessionData,
  forgetSession,
  getCwd,
  parseOsc7,
  setCwd,
} from './index'

const ESC = '\x1b'
/** 构造一个 OSC 7 序列（BEL 结尾） */
const osc7 = (path: string, host = 'web-1'): string => `${ESC}]7;file://${host}${path}\x07`
/** ST（ESC \）结尾的变体：两种终止符都要认 */
const osc7St = (path: string, host = 'web-1'): string => `${ESC}]7;file://${host}${path}${ESC}\\`

describe('parseOsc7 载荷解析', () => {
  it('解析标准 file://host/path', () => {
    expect(parseOsc7('7;file://web-1/home/mosfet')).toBe('/home/mosfet')
  })

  it('空 host（file:///path）也能解析', () => {
    expect(parseOsc7('7;file:///var/log')).toBe('/var/log')
  })

  it('百分号解码（空格 / 中文）', () => {
    expect(parseOsc7('7;file://h/tmp/a%20b')).toBe('/tmp/a b')
    expect(parseOsc7('7;file://h/%E6%96%87%E4%BB%B6')).toBe('/文件')
  })

  it('非法百分号序列时原样返回（不抛错）', () => {
    expect(parseOsc7('7;file://h/tmp/%ZZ')).toBe('/tmp/%ZZ')
  })

  it('不是 OSC 7 的载荷返回 null', () => {
    expect(parseOsc7('0;title')).toBeNull()
    expect(parseOsc7('133;A')).toBeNull()
    expect(parseOsc7('7;notfile://x/y')).toBeNull()
    expect(parseOsc7('7;file://')).toBeNull()
    expect(parseOsc7('nonsense')).toBeNull()
  })
})

describe('feedSessionData + getCwd', () => {
  beforeEach(() => clearAllCwd())

  it('完整序列出现在一块里', () => {
    feedSessionData('s1', `prompt$ ${osc7('/home/mosfet')}more`)
    expect(getCwd('s1')).toBe('/home/mosfet')
  })

  it('★ 序列被切成两块（TCP 读边界）仍能拿到', () => {
    const full = osc7('/home/mosfet/projects')
    feedSessionData('s1', full.slice(0, 10))
    expect(getCwd('s1')).toBeNull() // 还没闭合
    feedSessionData('s1', full.slice(10))
    expect(getCwd('s1')).toBe('/home/mosfet/projects')
  })

  it('★ 被切成很多块（逐字符）也能拿到', () => {
    const full = osc7('/var/log/nginx')
    for (const ch of full) feedSessionData('s1', ch)
    expect(getCwd('s1')).toBe('/var/log/nginx')
  })

  it('★ 用 ST（ESC \\）结尾的变体同样识别', () => {
    feedSessionData('s1', osc7St('/opt/app'))
    expect(getCwd('s1')).toBe('/opt/app')
  })

  it('★ 不同会话的缓冲互不污染', () => {
    const a = osc7('/a', 'host-a')
    const b = osc7('/b', 'host-b')
    // 交错喂：A 的前半 + B 的全部 + A 的后半
    feedSessionData('s1', a.slice(0, 8))
    feedSessionData('s2', b)
    expect(getCwd('s2')).toBe('/b')
    expect(getCwd('s1')).toBeNull() // A 还没闭合，且**不能**被 B 的数据凑出来
    feedSessionData('s1', a.slice(8))
    expect(getCwd('s1')).toBe('/a')
    expect(getCwd('s2')).toBe('/b')
  })

  it('同一块里出现多个序列时取最后一个（后来的提示符更新）', () => {
    feedSessionData('s1', `${osc7('/first')}text${osc7('/second')}`)
    expect(getCwd('s1')).toBe('/second')
  })

  it('普通输出（没有 OSC）不改变已记录的 cwd', () => {
    feedSessionData('s1', osc7('/keep'))
    feedSessionData('s1', 'ls -la\r\nfile1 file2\r\n')
    expect(getCwd('s1')).toBe('/keep')
  })

  it('非 OSC 7 的 OSC 序列（如改标题）被忽略，不影响缓冲', () => {
    feedSessionData('s1', `${ESC}]0;my title\x07`)
    expect(getCwd('s1')).toBeNull()
    feedSessionData('s1', osc7('/after-title'))
    expect(getCwd('s1')).toBe('/after-title')
  })

  it('畸形巨长且不闭合的序列不会吃满内存（有上限保护）', () => {
    feedSessionData('s1', `${ESC}]7;file://h/${'x'.repeat(100_000)}`)
    // 缓冲被丢弃而不是无限增长；后续正常序列仍能工作
    feedSessionData('s1', osc7('/recovered'))
    expect(getCwd('s1')).toBe('/recovered')
  })

  it('未知会话返回 null（而不是抛错）', () => {
    expect(getCwd('never-seen')).toBeNull()
  })

  it('forgetSession 后回到 null（会话关闭后不该留残值）', () => {
    feedSessionData('s1', osc7('/gone'))
    expect(getCwd('s1')).toBe('/gone')
    forgetSession('s1')
    expect(getCwd('s1')).toBeNull()
  })

  it('setCwd 可主动回填（渲染层已解析时保持一致）', () => {
    setCwd('s1', '/from-renderer')
    expect(getCwd('s1')).toBe('/from-renderer')
    // 之后真实 OSC 仍可覆盖它
    feedSessionData('s1', osc7('/from-shell'))
    expect(getCwd('s1')).toBe('/from-shell')
  })
})
