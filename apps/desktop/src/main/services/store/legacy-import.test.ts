// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * legacy-import 单测：
 * 造一个仿旧产品布局的临时库，验证字段映射、幂等、不覆盖已有数据、demo 清理。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { StoreDb, STORE_KEYS } from './db'
import { importLegacyReferenceStores } from './legacy-import'

/** 在临时目录里造一个仿旧产品的库 */
function makeLegacyDb(dir: string): string {
  const sqliteDir = join(dir, 'xterminal', 'sqlite')
  mkdirSync(sqliteDir, { recursive: true })
  const file = join(sqliteDir, 'local-store.db')
  const db = new Database(file)
  db.exec('CREATE TABLE local_store (store_key TEXT NOT NULL, item_id TEXT NOT NULL, payload TEXT NOT NULL, updated_at INTEGER, created_at INTEGER, PRIMARY KEY (store_key, item_id))')
  const put = db.prepare('INSERT INTO local_store (store_key, item_id, payload) VALUES (?, ?, ?)')
  const K = (e: string, id: string): string => `${id}-GeneralDatabaseLocalImp-${e}DatabaseLocalImp`

  // 一台带私钥的 SSH（installId 前缀 + title 字段命名）
  put.run(K('Server', '6a9c1b17bfa3db9b57b8c720'), '6a9c1ba09b3e48839b2a5308', JSON.stringify({
    title: 'debian',
    host: '192.0.2.10',
    port: 22,
    authType: 'privateKey',
    username: 'mosfet',
    note: 'dsh主机',
    privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----\nAAA\n',
    passphrase: 'secret',
    _id: '6a9c1ba09b3e48839b2a5308',
    createdAt: '2026-09-05T21:39:44.977+08:00',
    updatedAt: '2026-10-22T18:21:58.187+08:00',
    __storeType: 'local',
  }))
  // 一条 RDP（authDecrypted 嵌套）
  put.run(K('Rdp', '6a9c1b17bfa3db9b57b8c720'), '6af10a09faaf511644cdca1a', JSON.stringify({
    title: '1111',
    authDecrypted: { address: '192.0.2.10', port: 3389, username: 'mosfet', password: 'demo-pass', enableClipboard: true, renderQualityMode: 'balanced' },
    note: '',
    _id: '6af10a09faaf511644cdca1a',
    createdAt: '2026-11-09T07:47:21.796+08:00',
    updatedAt: '2026-11-09T07:47:21.797+08:00',
  }))
  // 一个不迁移的实体
  put.run(K('ServerStatus', '6a9c1b17bfa3db9b57b8c720'), '6a9c1ba09b3e48839b2a5308', JSON.stringify({ system: 'debian', cpu: 12 }))
  // 一条坏 JSON
  put.run(K('Server', '6a9c1b17bfa3db9b57b8c720'), 'bad-json', '{oops')
  db.close()
  return file
}

describe('legacy-import（历史数据一次性导入）', () => {
  let tmp: string
  let db: StoreDb

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 't1000-legacy-'))
    makeLegacyDb(tmp)
    db = new StoreDb(':memory:')
  })

  afterEach(() => {
    db.close()
    rmSync(tmp, { recursive: true, force: true })
  })

  it('SSH/RDP 映射到本项目模型，RDP 与 SSH 同入 server 库', () => {
    const report = importLegacyReferenceStores(db, tmp)
    expect(report).not.toBeNull()
    expect(report!.errors.some((e) => e.includes('bad-json'))).toBe(true)

    const ssh = JSON.parse(db.get(STORE_KEYS.server, '6a9c1ba09b3e48839b2a5308')!.payload)
    expect(ssh).toMatchObject({
      kind: 'ssh',
      name: 'debian',
      host: '192.0.2.10',
      port: 22,
      username: 'mosfet',
      authType: 'privateKey',
      privateKey: expect.stringContaining('BEGIN OPENSSH'),
      passphrase: 'secret',
      note: 'dsh主机',
      storeType: 'local',
    })

    const rdp = JSON.parse(db.get(STORE_KEYS.server, '6af10a09faaf511644cdca1a')!.payload)
    expect(rdp).toMatchObject({
      kind: 'rdp',
      host: '192.0.2.10',
      port: 3389,
      username: 'mosfet',
      password: 'demo-pass',
      clipboardShare: true,
      quality: 'balanced',
    })
    expect(report!.imported).toEqual({ Server: 1, Rdp: 1 })
    expect(report!.omitted.ServerStatus).toBeTruthy()
  })

  it('重复调用是空操作（meta 标记）', () => {
    importLegacyReferenceStores(db, tmp)
    expect(importLegacyReferenceStores(db, tmp)).toBeNull()
  })

  it('不覆盖目标库已有的同 id 数据', () => {
    const existing = { kind: 'ssh', id: '6a9c1ba09b3e48839b2a5308', name: '用户自己改过', host: '10.0.0.1', port: 22, username: 'x', authType: 'password', createdAt: '', updatedAt: '' }
    db.put(STORE_KEYS.server, existing.id, JSON.stringify(existing), 1)
    const report = importLegacyReferenceStores(db, tmp)!
    expect(report.imported.Server).toBeUndefined()
    expect(JSON.parse(db.get(STORE_KEYS.server, existing.id)!.payload).name).toBe('用户自己改过')
  })

  it('源库不存在：返回 null 并落标记，绝不报错', () => {
    const empty = mkdtempSync(join(tmpdir(), 't1000-empty-'))
    try {
      expect(importLegacyReferenceStores(db, empty)).toBeNull()
      expect(db.getMeta('legacy_import_v1')).toBeDefined()
    } finally {
      rmSync(empty, { recursive: true, force: true })
    }
  })

  it('导入成功后清掉历史 demo 行', () => {
    db.put(STORE_KEYS.server, 'demo-conn-1', JSON.stringify({ kind: 'ssh', id: 'demo-conn-1', name: '假连接' }), 1)
    importLegacyReferenceStores(db, tmp)
    expect(db.get(STORE_KEYS.server, 'demo-conn-1')).toBeUndefined()
    // 真实数据不受影响
    expect(db.get(STORE_KEYS.server, '6a9c1ba09b3e48839b2a5308')).toBeDefined()
  })
})
