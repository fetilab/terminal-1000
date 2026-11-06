// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 路径规范化与穿越拒绝的单测。
 * 纯函数，不碰文件系统，不连主机。
 */

import { describe, expect, it } from 'vitest'
import {
  assertSafeRemoteName,
  basenameRemotePath,
  dirnameRemotePath,
  formatPermissions,
  isInsideRemotePath,
  joinRemotePath,
  nextAvailableName,
  normalizeRemotePath,
  numberedName,
  parseMode,
} from './paths'

describe('normalizeRemotePath', () => {
  it('规约多余的斜杠、点段与内部 ..', () => {
    expect(normalizeRemotePath('/a//b/./c')).toBe('/a/b/c')
    expect(normalizeRemotePath('/a/b/../c')).toBe('/a/c')
    expect(normalizeRemotePath('/a/b/..')).toBe('/a')
    expect(normalizeRemotePath('/')).toBe('/')
    expect(normalizeRemotePath('/a/b/')).toBe('/a/b')
  })

  it('拒绝逃出根目录的 ..', () => {
    expect(() => normalizeRemotePath('/..')).toThrow(/越界/)
    expect(() => normalizeRemotePath('/a/../../etc/passwd')).toThrow(/越界/)
    expect(() => normalizeRemotePath('../etc')).toThrow(/越界/)
    expect(() => normalizeRemotePath('..')).toThrow(/越界/)
    // 深度刚好归零（回到根）是允许的，不算逃逸
    expect(normalizeRemotePath('/a/..')).toBe('/')
  })

  it('拒绝空路径与 NUL', () => {
    expect(() => normalizeRemotePath('')).toThrow(/不能为空/)
    expect(() => normalizeRemotePath('/a\0b')).toThrow(/NUL/)
  })

  it('相对路径按 base 解析，且同样受根约束', () => {
    expect(normalizeRemotePath('logs', '/home/dev')).toBe('/home/dev/logs')
    expect(normalizeRemotePath('./logs/../tmp', '/home/dev')).toBe('/home/dev/tmp')
    // base 不足时继续向上仍然拒绝
    expect(() => normalizeRemotePath('../../x', '/home')).toThrow(/越界/)
  })
})

describe('join/basename/dirname/isInside', () => {
  it('joinRemotePath 串联并规范化', () => {
    expect(joinRemotePath('/a', 'b', 'c')).toBe('/a/b/c')
    expect(joinRemotePath('/a', '/b/')).toBe('/a/b')
    expect(joinRemotePath()).toBe('/')
  })

  it('dirnameRemotePath / basenameRemotePath', () => {
    expect(dirnameRemotePath('/a/b/c.txt')).toBe('/a/b')
    expect(dirnameRemotePath('/a')).toBe('/')
    expect(dirnameRemotePath('/')).toBe('/')
    expect(basenameRemotePath('/a/b/c.txt')).toBe('c.txt')
    expect(basenameRemotePath('/')).toBe('/')
  })

  it('isInsideRemotePath 区分同名前缀', () => {
    expect(isInsideRemotePath('/home/dev', '/home/dev/logs')).toBe(true)
    expect(isInsideRemotePath('/home/dev', '/home/dev')).toBe(true)
    // /home/developer 不是 /home/dev 的子路径
    expect(isInsideRemotePath('/home/dev', '/home/developer')).toBe(false)
    expect(isInsideRemotePath('/', '/anything')).toBe(true)
    expect(isInsideRemotePath('/home/dev', '/etc')).toBe(false)
  })
})

describe('assertSafeRemoteName', () => {
  it('接受普通名字', () => {
    expect(assertSafeRemoteName('logs')).toBe('logs')
    expect(assertSafeRemoteName('.env')).toBe('.env')
  })

  it('拒绝空、点、.. 与含斜杠的名字', () => {
    expect(() => assertSafeRemoteName('')).toThrow(/不能为空/)
    expect(() => assertSafeRemoteName('.')).toThrow(/不合法/)
    expect(() => assertSafeRemoteName('..')).toThrow(/不合法/)
    expect(() => assertSafeRemoteName('a/b')).toThrow(/不能包含/)
    expect(() => assertSafeRemoteName('a\0b')).toThrow(/NUL/)
  })
})

describe('numberedName / nextAvailableName', () => {
  it('生成 name (n).ext 形式', () => {
    expect(numberedName('photo.png', 1)).toBe('photo (1).png')
    expect(numberedName('archive.tar.gz', 2)).toBe('archive.tar (2).gz')
    expect(numberedName('noext', 3)).toBe('noext (3)')
    // 点开头且无其它点的文件视为无扩展名
    expect(numberedName('.bashrc', 1)).toBe('.bashrc (1)')
    expect(numberedName('a.', 1)).toBe('a. (1)')
  })

  it('nextAvailableName 跳过已占用的编号', () => {
    const taken = new Set(['photo (1).png', 'photo (2).png'])
    expect(nextAvailableName('photo.png', (c) => taken.has(c))).toBe('photo (3).png')
  })
})

describe('parseMode / formatPermissions', () => {
  it('解析八进制数字与字符串', () => {
    expect(parseMode(0o755)).toBe(0o755)
    expect(parseMode('755')).toBe(0o755)
    expect(parseMode('0755')).toBe(0o755)
    expect(parseMode('0o644')).toBe(0o644)
    expect(parseMode('644')).toBe(0o644)
  })

  it('拒绝非法权限值', () => {
    expect(() => parseMode('999')).toThrow(/不合法/)
    expect(() => parseMode('abc')).toThrow(/不合法/)
    expect(() => parseMode('')).toThrow(/不能为空/)
    expect(() => parseMode(-1)).toThrow(/不合法/)
    expect(() => parseMode(1.5)).toThrow(/不合法/)
  })

  it('格式化权限位', () => {
    expect(formatPermissions(0o755)).toBe('rwxr-xr-x')
    expect(formatPermissions(0o644)).toBe('rw-r--r--')
    expect(formatPermissions(0o600)).toBe('rw-------')
    expect(formatPermissions(0o000)).toBe('---------')
  })
})
