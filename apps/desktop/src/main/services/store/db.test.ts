// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * db 层单测：KV 读写语义、upsert、预编译语句、事务、WAL/PRAGMA。
 *
 * 全部用 `:memory:`：不碰真实用户目录，也不留临时文件。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SCHEMA_VERSION, STORE_KEYS, StoreDb, storeKeyOf } from './db'

describe('StoreDb（内存库）', () => {
  let db: StoreDb

  beforeEach(() => {
    db = new StoreDb(':memory:')
  })

  afterEach(() => {
    db.close()
  })

  it('store_key 命名符合 GeneralDatabaseLocalImp-<Entity>DatabaseLocalImp', () => {
    expect(storeKeyOf('Server')).toBe('GeneralDatabaseLocalImp-ServerDatabaseLocalImp')
    expect(STORE_KEYS.server).toBe('GeneralDatabaseLocalImp-ServerDatabaseLocalImp')
    expect(STORE_KEYS.group).toContain('GroupDatabaseLocalImp')
    expect(STORE_KEYS.credential).toContain('CredentialDatabaseLocalImp')
  })

  it('建表后能写入并读回一行', () => {
    db.put(STORE_KEYS.server, 'c1', JSON.stringify({ name: 'web' }), 1000)
    const row = db.get(STORE_KEYS.server, 'c1')

    expect(row).toBeDefined()
    expect(JSON.parse(row!.payload)).toEqual({ name: 'web' })
    expect(row!.updated_at).toBe(1000)
    expect(row!.created_at).toBe(1000)
  })

  it('读不存在的行返回 undefined', () => {
    expect(db.get(STORE_KEYS.server, 'nope')).toBeUndefined()
  })

  it('upsert：同 id 二次写入更新 payload 与 updated_at，但保留 created_at', () => {
    db.put(STORE_KEYS.server, 'c1', JSON.stringify({ name: 'v1' }), 1000)
    db.put(STORE_KEYS.server, 'c1', JSON.stringify({ name: 'v2' }), 2000)

    const row = db.get(STORE_KEYS.server, 'c1')!
    expect(JSON.parse(row.payload)).toEqual({ name: 'v2' })
    expect(row.updated_at).toBe(2000)
    // created_at 必须还是首次写入的时间——这是 upsert SQL 里 CASE 的效果
    expect(row.created_at).toBe(1000)
    // 只有一行，没有产生重复
    expect(db.count(STORE_KEYS.server)).toBe(1)
  })

  it('不同 store_key 之间互不干扰（同一 item_id 可共存）', () => {
    db.put(STORE_KEYS.server, 'same-id', JSON.stringify({ kind: 'server' }), 1000)
    db.put(STORE_KEYS.group, 'same-id', JSON.stringify({ kind: 'group' }), 1000)

    expect(JSON.parse(db.get(STORE_KEYS.server, 'same-id')!.payload)).toEqual({ kind: 'server' })
    expect(JSON.parse(db.get(STORE_KEYS.group, 'same-id')!.payload)).toEqual({ kind: 'group' })
  })

  it('listIds 按 updated_at 倒序返回，且不含 payload 列', () => {
    db.put(STORE_KEYS.server, 'a', JSON.stringify({ n: 'a' }), 1000)
    db.put(STORE_KEYS.server, 'b', JSON.stringify({ n: 'b' }), 3000)
    db.put(STORE_KEYS.server, 'c', JSON.stringify({ n: 'c' }), 2000)

    const rows = db.listIds(STORE_KEYS.server)
    expect(rows.map((r) => r.item_id)).toEqual(['b', 'c', 'a'])
    // 索引行只带 3 个字段：这正是「列表不反序列化 payload」的性能保证
    expect(Object.keys(rows[0]!).sort()).toEqual(['created_at', 'item_id', 'updated_at'])
  })

  it('delete / deleteAllOf 生效', () => {
    db.put(STORE_KEYS.server, 'a', '{}', 1000)
    db.put(STORE_KEYS.server, 'b', '{}', 1000)
    db.delete(STORE_KEYS.server, 'a')
    expect(db.count(STORE_KEYS.server)).toBe(1)

    db.deleteAllOf(STORE_KEYS.server)
    expect(db.count(STORE_KEYS.server)).toBe(0)
  })

  it('putMany 批量写入在单事务内完成', () => {
    const rows = Array.from({ length: 500 }, (_, i) => ({
      storeKey: STORE_KEYS.server,
      itemId: `id-${i}`,
      payload: JSON.stringify({ i }),
    }))
    db.putMany(rows, 1234)

    expect(db.count(STORE_KEYS.server)).toBe(500)
    expect(JSON.parse(db.get(STORE_KEYS.server, 'id-499')!.payload)).toEqual({ i: 499 })
  })

  it('transaction 内部抛错时整体回滚', () => {
    db.put(STORE_KEYS.server, 'keep', '{}', 1000)

    expect(() =>
      db.transaction(() => {
        db.put(STORE_KEYS.server, 'new', '{}', 2000)
        throw new Error('boom')
      }),
    ).toThrow('boom')

    expect(db.get(STORE_KEYS.server, 'new')).toBeUndefined()
    expect(db.get(STORE_KEYS.server, 'keep')).toBeDefined()
  })

  it('meta KV 读写与覆盖', () => {
    expect(db.getMeta('missing')).toBeUndefined()
    db.setMeta('k', 'v1')
    expect(db.getMeta('k')).toBe('v1')
    db.setMeta('k', 'v2')
    expect(db.getMeta('k')).toBe('v2')
  })

  it('迁移登记了 schema 版本', () => {
    expect(db.getMeta('schema_version')).toBe(String(SCHEMA_VERSION))
  })

  it('关闭后再关闭是幂等的（不抛）', () => {
    const local = new StoreDb(':memory:')
    local.close()
    expect(() => local.close()).not.toThrow()
  })
})

describe('StoreDb（落盘库，临时目录）', () => {
  let dir: string
  let file: string

  beforeEach(() => {
    // 临时目录：绝不写真实用户数据目录
    dir = mkdtempSync(join(tmpdir(), 't1000-store-'))
    file = join(dir, 'local-store.db')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('落盘库开启 WAL 模式', () => {
    const db = new StoreDb(file)
    // journal_mode 返回的是 [{ journal_mode: 'wal' }]
    const mode = db.raw.pragma('journal_mode', { simple: true })
    expect(String(mode).toLowerCase()).toBe('wal')
    db.close()
  })

  it('重开同一个库能读回数据（持久化生效）', () => {
    const a = new StoreDb(file)
    a.put(STORE_KEYS.server, 'persist', JSON.stringify({ ok: true }), 5000)
    a.close()

    const b = new StoreDb(file)
    expect(JSON.parse(b.get(STORE_KEYS.server, 'persist')!.payload)).toEqual({ ok: true })
    b.close()
  })

  it('checkpoint 不抛错（WAL 合并回主库）', () => {
    const db = new StoreDb(file)
    db.put(STORE_KEYS.server, 'x', '{}', 1)
    expect(() => db.checkpoint()).not.toThrow()
    db.close()
  })
})
