// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * system 域测试。
 *
 * 这里只测**纯逻辑**（备份保留策略）—— 它出错的两个方向都很糟：
 * 删多了会毁掉用户的历史备份，删少了会一直堆积。而空闲锁屏依赖 `powerMonitor`，
 * 只能靠真实运行验证（见 `scripts/acceptance.mjs`）。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isBackupDue, isBackupFileName, pruneBackups } from './index'

let dir: string

/** 造一个备份文件（可选：指定 mtime 天数前） */
function makeBackup(name: string, daysAgo = 0, content = 'x'): string {
  const full = join(dir, name)
  writeFileSync(full, content)
  if (daysAgo > 0) {
    const t = (Date.now() - daysAgo * 24 * 60 * 60 * 1000) / 1000
    utimesSync(full, t, t)
  }
  return full
}

// 用 store **真实**产生的命名：`<时间戳>.v<版本><扩展名>`
// （我第一版用了自己编的 `t1000-backup-` 前缀，结果 listBackups/pruneBackups 全都对不上）
const NAME = (n: number): string => `2026010${n}000000.v1.backup.t1000.enc`

describe('备份保留策略', () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 't1000-backup-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('保留期内的备份不动', () => {
    makeBackup(NAME(1), 1)
    makeBackup(NAME(2), 3)
    expect(pruneBackups(dir, 7)).toBe(0)
    expect(readdirSync(dir)).toHaveLength(2)
  })

  it('★ 超过保留期的备份被删除', () => {
    makeBackup(NAME(1), 1)
    makeBackup(NAME(2), 10)
    makeBackup(NAME(3), 30)
    expect(pruneBackups(dir, 7)).toBe(2)
    expect(readdirSync(dir)).toEqual([NAME(1)])
  })

  it('★ 只删自己生成的备份 —— 目录里的其它文件一个都不能动', () => {
    makeBackup(NAME(1), 30)
    // 用户可能往备份目录塞别的东西：误删是灾难性的
    const 别的文件 = [
      'my-important-notes.txt',
      't1000-backup-old.txt', // 后缀不对
      'important-notes.backup.t1000.enc', // 后缀对但不符合格式（不能被误删）
      '20260101000000.v1.backup.txt', // 格式像但扩展名不对
      'database.db',
    ]
    for (const n of 别的文件) writeFileSync(join(dir, n), 'keep me')

    const pruned = pruneBackups(dir, 7)
    // 只删了那个真正的旧备份：命名必须**完全匹配**本应用的生成格式，
    // 所以"恰好后缀同名"的 important-notes.backup.t1000.enc 不会被误删
    expect(pruned).toBe(1)
    for (const n of 别的文件) expect(readdirSync(dir), `${n} 不应被删除`).toContain(n)
  })

  it('保留天数下界保护：传 0 或负数按 1 天处理，不会"删光所有备份"', () => {
    makeBackup(NAME(1), 0.5) // 半天前，属于 1 天内
    makeBackup(NAME(2), 5)
    // 若实现里没做下界保护，cutoff 会落到未来，把全部备份删掉
    expect(pruneBackups(dir, 0)).toBe(1)
    expect(readdirSync(dir)).toEqual([NAME(1)])
  })

  it('目录不存在时安全返回 0（不抛错）', () => {
    expect(pruneBackups(join(dir, 'nope'), 7)).toBe(0)
  })

  it('空目录返回 0', () => {
    expect(pruneBackups(dir, 7)).toBe(0)
  })

  it('子目录即使名匹配也不删（只处理文件）', () => {
    const sub = join(dir, NAME(9))
    mkdirSync(sub)
    // 设成很旧的 mtime 也不该被当作文件删掉
    const old = (Date.now() - 30 * 24 * 60 * 60 * 1000) / 1000
    utimesSync(sub, old, old)
    expect(pruneBackups(dir, 7)).toBe(0)
    expect(statSync(sub).isDirectory()).toBe(true)
  })
})

describe('备份到期判断（决定"该不该备份"）', () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 't1000-due-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('没有任何备份 → 到期（该备）', () => {
    expect(isBackupDue(dir)).toBe(true)
  })

  it('目录不存在 → 也视为到期', () => {
    expect(isBackupDue(join(dir, 'nope'))).toBe(true)
  })

  it('最新备份在 24 小时内 → 不到期（不重复备）', () => {
    makeBackup(NAME(1), 0.5) // 12 小时前
    expect(isBackupDue(dir)).toBe(false)
  })

  it('★ 最新备份超过 24 小时 → 到期（这才是"每日"的意义）', () => {
    makeBackup(NAME(1), 2)
    expect(isBackupDue(dir)).toBe(true)
  })

  it('★ 取**最新**的那个判断：旧备份不影响（多个旧备份不造成反复重备）', () => {
    makeBackup(NAME(1), 10)
    makeBackup(NAME(2), 0.2) // 最新的是 5 小时前
    expect(isBackupDue(dir)).toBe(false)
  })

  it('目录里的其它文件不参与判断（避免把无关文件当成"刚备过份"）', () => {
    writeFileSync(join(dir, 'notes.txt'), 'x') // 刚写的
    expect(isBackupDue(dir)).toBe(true) // 没有真正的备份 → 仍应到期
  })

  it('可自定义间隔（便于将来做"每小时"等策略）', () => {
    makeBackup(NAME(1), 0.1) // 约 2.4 小时前
    expect(isBackupDue(dir, 60 * 60 * 1000)).toBe(true)
    expect(isBackupDue(dir, 24 * 60 * 60 * 1000)).toBe(false)
  })
})

describe('备份文件识别', () => {
  it('★ 只认 store 真实生成的命名格式', () => {
    expect(isBackupFileName('20260101000000.v1.backup.t1000.enc')).toBe(true)
    expect(isBackupFileName('20261231235959.v3.backup.t1000.enc')).toBe(true)
  })

  it('拒绝"看起来像但格式不对"的名字（避免误删用户文件）', () => {
    expect(isBackupFileName('important-notes.backup.t1000.enc')).toBe(false)
    expect(isBackupFileName('20260101000000.v1.backup.txt')).toBe(false)
    expect(isBackupFileName('t1000-backup-20260101.backup.t1000.enc')).toBe(false) // 我曾用错的前缀
    expect(isBackupFileName('20260101000000.backup.t1000.enc')).toBe(false) // 少了 .v<n>
    expect(isBackupFileName('backup.t1000.enc')).toBe(false)
  })
})
