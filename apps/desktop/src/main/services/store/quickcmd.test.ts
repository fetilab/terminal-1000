// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 快速命令本地库存储单测：KV 往返、字段加密（含明文/密文混存）、坏行容错。
 * 全部用 `:memory:`，不碰真实用户目录。
 */

import { describe, expect, it } from 'vitest'
import { StoreDb } from './db'
import { QUICKCMD_STORE_KEYS, createQuickCmdStore, type QuickCmdSealer } from './quickcmd'
import type { QuickCommandRecord, QuickGroupRecord } from '../quickcmd/tree'

function command(id: string, name: string, extra: Partial<QuickCommandRecord> = {}): QuickCommandRecord {
  return {
    id,
    groupId: null,
    name,
    command: `echo ${name}`,
    order: 0,
    createdAt: '2025-11-29T00:00:00.000Z',
    updatedAt: '2025-11-29T00:00:00.000Z',
    ...extra,
  }
}

function group(id: string, name: string, parentId: string | null = null): QuickGroupRecord {
  return { id, parentId, name, order: 0, createdAt: 't', updatedAt: 't' }
}

/** 可逆的假加密器：用 store 的密文前缀，便于验证"读写走密文" */
function fakeSealer(): QuickCmdSealer {
  return {
    seal: (plain) => `v1:${Buffer.from(plain, 'utf8').toString('base64')}`,
    open: (sealed) => Buffer.from(sealed.slice('v1:'.length), 'base64').toString('utf8'),
  }
}

describe('KV 往返（明文）', () => {
  it('命令与分组能存能读', () => {
    const db = new StoreDb(':memory:')
    const store = createQuickCmdStore(db)

    store.saveCommand(command('c1', '查看磁盘'))
    store.saveGroup(group('g1', '数据库'))
    store.saveHistory({ db: [{ value: 'shop', usedAt: 1000 }] })

    const lib = store.loadLibrary()
    expect(lib.commands).toHaveLength(1)
    expect(lib.commands[0]).toMatchObject({ id: 'c1', name: '查看磁盘' })
    expect(lib.groups.map((g) => g.id)).toEqual(['g1'])
    expect(store.loadHistory()).toEqual({ db: [{ value: 'shop', usedAt: 1000 }] })
    expect(store.kind).toBe('local')
    db.close()
  })

  it('未注入加密器时 payload 是明文 JSON', () => {
    const db = new StoreDb(':memory:')
    const store = createQuickCmdStore(db)
    store.saveCommand(command('c1', 'x'))
    const row = db.get(QUICKCMD_STORE_KEYS.command, 'c1')
    expect(row?.payload.startsWith('{')).toBe(true)
    expect(row?.payload).toContain('"name":"x"')
    db.close()
  })

  it('删除命令与分组', () => {
    const db = new StoreDb(':memory:')
    const store = createQuickCmdStore(db)
    store.saveCommand(command('c1', 'a'))
    store.saveCommand(command('c2', 'b'))
    store.deleteCommand('c1')
    store.saveGroup(group('g1', 'G'))
    store.deleteGroup('g1')
    expect(store.loadLibrary().commands.map((c) => c.id)).toEqual(['c2'])
    expect(store.loadLibrary().groups).toEqual([])
    db.close()
  })

  it('覆盖保存（同一 id 更新）', () => {
    const db = new StoreDb(':memory:')
    const store = createQuickCmdStore(db)
    store.saveCommand(command('c1', 'old'))
    store.saveCommand(command('c1', 'new'))
    expect(store.loadLibrary().commands).toHaveLength(1)
    expect(store.loadLibrary().commands[0]?.name).toBe('new')
    db.close()
  })
})

describe('★ 字段加密', () => {
  it('注入加密器后落库是密文，读回来是原文', () => {
    const db = new StoreDb(':memory:')
    const store = createQuickCmdStore(db, { sealer: fakeSealer() })
    store.saveCommand(command('c1', '带密码的命令', { command: 'mysqldump -pS3cret db' }))

    const row = db.get(QUICKCMD_STORE_KEYS.command, 'c1')
    expect(row?.payload.startsWith('v1:')).toBe(true)
    // 明文内容不得出现在库里
    expect(row?.payload).not.toContain('S3cret')
    expect(row?.payload).not.toContain('带密码的命令')

    const loaded = store.loadLibrary().commands[0]
    expect(loaded?.command).toBe('mysqldump -pS3cret db')
    expect(loaded?.name).toBe('带密码的命令')
    db.close()
  })

  it('历史同样加密', () => {
    const db = new StoreDb(':memory:')
    const store = createQuickCmdStore(db, { sealer: fakeSealer() })
    store.saveHistory({ host: [{ value: 'web-1', usedAt: 5 }] })
    const row = db.get(QUICKCMD_STORE_KEYS.history, 'param-history')
    expect(row?.payload.startsWith('v1:')).toBe(true)
    expect(store.loadHistory()).toEqual({ host: [{ value: 'web-1', usedAt: 5 }] })
    db.close()
  })

  it('★ 明文/密文混存也能读（用户中途设了主密码）', () => {
    const db = new StoreDb(':memory:')
    const plain = createQuickCmdStore(db)
    plain.saveCommand(command('old', '设密码前存的'))

    const sealed = createQuickCmdStore(db, { sealer: fakeSealer() })
    sealed.saveCommand(command('new', '设密码后存的'))

    const loaded = sealed.loadLibrary().commands
    expect(loaded.map((c) => c.id).sort()).toEqual(['new', 'old'])
    expect(loaded.find((c) => c.id === 'old')?.name).toBe('设密码前存的')
    db.close()
  })

  it('加密器抛错（未解锁）时降级为明文，保证免登录可用', () => {
    const db = new StoreDb(':memory:')
    const store = createQuickCmdStore(db, {
      sealer: {
        seal: () => {
          throw new Error('未解锁')
        },
        open: (s) => s,
      },
    })
    store.saveCommand(command('c1', 'x'))
    const row = db.get(QUICKCMD_STORE_KEYS.command, 'c1')
    expect(row?.payload.startsWith('{')).toBe(true)
    expect(store.loadLibrary().commands[0]?.name).toBe('x')
    db.close()
  })

  it('密文行遇到无法解密时不炸，跳过该行', () => {
    const db = new StoreDb(':memory:')
    // 先写入密文，再用"没有加密器"的 store 读 → 无法解开
    const sealed = createQuickCmdStore(db, { sealer: fakeSealer() })
    sealed.saveCommand(command('c1', 'x'))

    const noopener = createQuickCmdStore(db)
    expect(() => noopener.loadLibrary()).not.toThrow()
    expect(noopener.loadLibrary().commands).toEqual([])
    db.close()
  })
})

describe('坏数据容错', () => {
  it('payload 不是合法 JSON 时跳过该行，其它行照常读', () => {
    const db = new StoreDb(':memory:')
    const store = createQuickCmdStore(db)
    store.saveCommand(command('good', 'ok'))
    db.put(QUICKCMD_STORE_KEYS.command, 'bad', '{not json', Date.now())
    expect(store.loadLibrary().commands.map((c) => c.id)).toEqual(['good'])
    db.close()
  })

  it('形状不符（缺字段）的行被过滤掉', () => {
    const db = new StoreDb(':memory:')
    const store = createQuickCmdStore(db)
    store.saveCommand(command('good', 'ok'))
    db.put(QUICKCMD_STORE_KEYS.command, 'shape', JSON.stringify({ id: 'shape' }), Date.now())
    db.put(QUICKCMD_STORE_KEYS.group, 'shape', JSON.stringify({ foo: 1 }), Date.now())
    const lib = store.loadLibrary()
    expect(lib.commands.map((c) => c.id)).toEqual(['good'])
    expect(lib.groups).toEqual([])
    db.close()
  })

  it('历史行损坏时返回空对象', () => {
    const db = new StoreDb(':memory:')
    const store = createQuickCmdStore(db)
    db.put(QUICKCMD_STORE_KEYS.history, 'param-history', '<broken>', Date.now())
    expect(store.loadHistory()).toEqual({})
    db.close()
  })

  it('空库读到空库', () => {
    const db = new StoreDb(':memory:')
    const store = createQuickCmdStore(db)
    expect(store.loadLibrary()).toEqual({ commands: [], groups: [] })
    expect(store.loadHistory()).toEqual({})
    db.close()
  })
})
