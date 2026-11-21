// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 数据目录解析与旧数据迁移的回归测试。
 *
 * 这里守的是两个曾经真实发生过的故障：
 * - 目录名跟着 package.json 走 → 版本一改名字，用户的库就「消失」了；
 * - 数据被写进安装目录 → 覆盖安装连库一起删掉。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  APP_DIR_NAME,
  isInside,
  legacyCandidates,
  migrateDataDir,
  resolveDataDir,
  scoreCandidate,
} from './dataDir'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 't1000-datadir-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('resolveDataDir', () => {
  it('Linux 用系统配置目录 + 固定名', () => {
    const r = resolveDataDir({
      platform: 'linux',
      appData: '/home/u/.config',
      home: '/home/u',
      exeDir: '/opt/terminal-1000',
    })
    expect(r.dir).toBe(join('/home/u/.config', APP_DIR_NAME))
    expect(r.relocatedFrom).toBeUndefined()
  })

  it('Windows 用 %APPDATA% + 固定名', () => {
    const r = resolveDataDir({
      platform: 'win32',
      appData: 'C:\\Users\\u\\AppData\\Roaming',
      home: 'C:\\Users\\u',
      exeDir: 'C:\\Program Files\\terminal-1000',
    })
    // 断言用后缀/前缀而不是拼字符串：测试跑在 Linux 上，path.join 用的是 `/`
    expect(r.dir).toContain('AppData')
    expect(r.dir.endsWith(APP_DIR_NAME)).toBe(true)
    expect(r.dir.startsWith('C:\\Users\\u')).toBe(true)
  })

  it('macOS 用 Application Support', () => {
    const r = resolveDataDir({
      platform: 'darwin',
      appData: '/Users/u/Library/Application Support',
      home: '/Users/u',
      exeDir: '/Applications/terminal-1000.app/Contents/MacOS',
    })
    expect(r.dir).toBe(join('/Users/u/Library/Application Support', APP_DIR_NAME))
  })

  it('appData 缺失时按平台兜底，而不是返回相对路径', () => {
    expect(
      resolveDataDir({ platform: 'linux', appData: '', home: '/home/u', exeDir: '/opt' }).dir,
    ).toBe(join('/home/u', '.config', APP_DIR_NAME))
    expect(
      resolveDataDir({ platform: 'win32', appData: '', home: 'C:\\Users\\u', exeDir: 'C:\\x' }).dir,
    ).toBe(join('C:\\Users\\u', 'AppData', 'Roaming', APP_DIR_NAME))
  })

  it('appData 是相对路径时不用它（启动器常把 XDG_CONFIG_HOME 设成相对值）', () => {
    const r = resolveDataDir({
      platform: 'linux',
      appData: 'relative/dir',
      home: '/home/u',
      exeDir: '/opt/terminal-1000',
    })
    expect(r.dir).toBe(join('/home/u', '.config', APP_DIR_NAME))
  })

  it('结果落在安装目录里时改到主目录，并记录原始值', () => {
    const exeDir = join(root, 'opt', 'terminal-1000')
    mkdirSync(exeDir, { recursive: true })
    const r = resolveDataDir({
      platform: 'linux',
      appData: exeDir, // 数据被指到安装目录 —— 覆盖安装必丢
      home: root,
      exeDir,
    })
    expect(r.dir).toBe(join(root, `.${APP_DIR_NAME}`))
    expect(r.relocatedFrom).toBe(join(exeDir, APP_DIR_NAME))
    expect(isInside(r.dir, exeDir)).toBe(false)
  })
})

describe('isInside', () => {
  it('同路径算在内', () => {
    expect(isInside('/a/b', '/a/b')).toBe(true)
  })

  it('子路径算在内', () => {
    expect(isInside('/a/b/c', '/a/b')).toBe(true)
  })

  it('前缀相同但不是子目录不算', () => {
    expect(isInside('/a/bc', '/a/b')).toBe(false)
  })

  it('父路径不在子路径之内', () => {
    expect(isInside('/a', '/a/b')).toBe(false)
  })
})

describe('legacyCandidates', () => {
  it('包含 Electron 默认目录、带 scope 的旧名与安装目录', () => {
    const list = legacyCandidates({
      appData: '/home/u/.config',
      exeDir: '/opt/terminal-1000',
      previousUserData: '/home/u/.config/@t1000/desktop',
    })
    expect(list[0]).toBe('/home/u/.config/@t1000/desktop')
    expect(list).toContain(join('/home/u/.config', '@t1000', 'desktop'))
    expect(list).toContain(join('/home/u/.config', '@t1000desktop'))
    expect(list).toContain('/opt/terminal-1000')
  })

  it('去重', () => {
    const list = legacyCandidates({
      appData: '/home/u/.config',
      exeDir: '/opt/t1000',
      previousUserData: join('/home/u/.config', '@t1000', 'desktop'),
    })
    expect(new Set(list.map((p) => p.replace(/\/+$/, ''))).size).toBe(list.length)
  })
})

describe('scoreCandidate', () => {
  it('不存在的目录得 0 分', () => {
    expect(scoreCandidate(join(root, 'nope'))).toBe(0)
  })

  it('有库的目录分数高于只有界面临时数据的目录', () => {
    const withDb = join(root, 'a')
    const withProfile = join(root, 'b')
    mkdirSync(join(withProfile, 'Local Storage'), { recursive: true })
    mkdirSync(withDb, { recursive: true })
    writeFileSync(join(withDb, 'local-store.db'), 'x')
    expect(scoreCandidate(withDb)).toBeGreaterThan(scoreCandidate(withProfile))
  })
})

describe('migrateDataDir', () => {
  function seedLegacy(dir: string): void {
    mkdirSync(join(dir, 'notes'), { recursive: true })
    writeFileSync(join(dir, 'local-store.db'), 'DB')
    writeFileSync(join(dir, 'known-hosts.json'), '[{"host":"a"}]')
    writeFileSync(join(dir, 'window-bounds.json'), '{"w":1}')
    writeFileSync(join(dir, 'notes', 'n1.md'), '# note')
  }

  it('首次启动把旧目录的数据复制过来', () => {
    const legacy = join(root, 'legacy')
    const target = join(root, 'target')
    seedLegacy(legacy)

    const report = migrateDataDir(target, [legacy])

    expect(report.from).toBe(legacy)
    expect(readFileSync(join(target, 'local-store.db'), 'utf8')).toBe('DB')
    expect(readFileSync(join(target, 'notes', 'n1.md'), 'utf8')).toBe('# note')
    expect(existsSync(join(target, 'known-hosts.json'))).toBe(true)
    expect(report.failed).toEqual([])
  })

  it('迁移只复制不删除源目录', () => {
    const legacy = join(root, 'legacy')
    seedLegacy(legacy)
    migrateDataDir(join(root, 'target'), [legacy])
    expect(readFileSync(join(legacy, 'local-store.db'), 'utf8')).toBe('DB')
  })

  it('写迁移记录，方便出问题时追溯', () => {
    const legacy = join(root, 'legacy')
    seedLegacy(legacy)
    const target = join(root, 'target')
    migrateDataDir(target, [legacy])
    const meta = JSON.parse(readFileSync(join(target, 'migration.json'), 'utf8')) as {
      from: string
      items: string[]
    }
    expect(meta.from).toBe(legacy)
    expect(meta.items).toContain('local-store.db')
  })

  it('目标已有库时不再迁移（幂等，重启不会互相污染）', () => {
    const legacy = join(root, 'legacy')
    const target = join(root, 'target')
    seedLegacy(legacy)
    mkdirSync(target, { recursive: true })
    writeFileSync(join(target, 'local-store.db'), 'NEW')

    const report = migrateDataDir(target, [legacy])

    expect(report.from).toBeNull()
    expect(readFileSync(join(target, 'local-store.db'), 'utf8')).toBe('NEW')
  })

  it('多个候选时挑数据最全的那个', () => {
    const onlyProfile = join(root, 'profile')
    const withDb = join(root, 'db')
    mkdirSync(join(onlyProfile, 'Local Storage'), { recursive: true })
    seedLegacy(withDb)

    const report = migrateDataDir(join(root, 'target'), [onlyProfile, withDb])

    expect(report.from).toBe(withDb)
  })

  it('没有旧数据时安静返回', () => {
    const report = migrateDataDir(join(root, 'target'), [join(root, 'nope')])
    expect(report.from).toBeNull()
    expect(report.items).toEqual([])
  })

  it('跳过候选里的自己（目标就是候选之一时）', () => {
    const target = join(root, 'target')
    seedLegacy(target)
    const report = migrateDataDir(target, [target])
    expect(report.from).toBeNull()
  })
})
