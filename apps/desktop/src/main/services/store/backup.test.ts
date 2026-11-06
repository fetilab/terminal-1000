// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 备份单测：信封格式、导出→导入往返、magic/版本篡改拒绝、口令错误、合并策略。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { StoreDb, STORE_KEYS } from './db'
import {
  BACKUP_MAGIC,
  BACKUP_VERSION,
  BackupDecryptError,
  BackupFormatError,
  backupFileName,
  exportBackup,
  importBackup,
  parseBackup,
} from './backup'

const PASS = 'backup-passphrase-123'

function seed(db: StoreDb): void {
  db.put(STORE_KEYS.server, 's1', JSON.stringify({ id: 's1', name: 'web-01' }), 1000)
  db.put(STORE_KEYS.server, 's2', JSON.stringify({ id: 's2', name: 'db-01' }), 2000)
  db.put(STORE_KEYS.group, 'g1', JSON.stringify({ id: 'g1', name: 'Prod' }), 3000)
  db.put(STORE_KEYS.credential, 'c1', JSON.stringify({ id: 'c1', name: 'key' }), 4000)
}

describe('backupFileName', () => {
  it('符合 YYYYMMDDHHmmss.v1.backup.t1000.enc', () => {
    const name = backupFileName(new Date(2026, 10, 5, 9, 8, 7))
    expect(name).toBe('20261105090807.v1.backup.t1000.enc')
    expect(name).toMatch(/^\d{14}\.v\d+\.backup\.t1000\.enc$/)
  })
})

describe('导出信封', () => {
  let db: StoreDb
  beforeEach(() => {
    db = new StoreDb(':memory:')
    seed(db)
  })
  afterEach(() => db.close())

  it('首行是 T1000_BACKUP magic，第二行是 base64 JSON', () => {
    const { data, envelope } = exportBackup(db, { passphrase: PASS })
    const text = data.toString('utf8')

    const [header, ...rest] = text.split('\n')
    expect(header).toBe(BACKUP_MAGIC)
    expect(envelope.magic).toBe(BACKUP_MAGIC)
    expect(envelope.version).toBe(BACKUP_VERSION)

    const decoded = JSON.parse(Buffer.from(rest.join('\n').trim(), 'base64').toString('utf8'))
    expect(decoded.magic).toBe(BACKUP_MAGIC)
  })

  it('信封声明了 KDF 参数与算法', () => {
    const { envelope } = exportBackup(db, { passphrase: PASS })
    expect(envelope.kdf.algo).toBe('scrypt')
    expect(envelope.kdf.N).toBe(16384)
    expect(envelope.kdf.r).toBe(8)
    expect(envelope.kdf.p).toBe(1)
    expect(envelope.cipher).toContain('aes-256-gcm')
  })

  it('统计每个实体的条数', () => {
    const { envelope } = exportBackup(db, { passphrase: PASS })
    expect(envelope.meta!.counts![STORE_KEYS.server]).toBe(2)
    expect(envelope.meta!.counts![STORE_KEYS.group]).toBe(1)
    expect(envelope.meta!.counts![STORE_KEYS.credential]).toBe(1)
  })

  it('备份文件里不含明文 payload', () => {
    const { data } = exportBackup(db, { passphrase: PASS })
    expect(data.toString('utf8')).not.toContain('web-01')
    expect(data.toString('utf8')).not.toContain('Prod')
  })

  it('相同数据两次导出产生不同密文（随机 salt/iv）', () => {
    const a = exportBackup(db, { passphrase: PASS }).data.toString('utf8')
    const b = exportBackup(db, { passphrase: PASS }).data.toString('utf8')
    expect(a).not.toBe(b)
  })

  it('缺少口令和密钥时拒绝导出', () => {
    expect(() => exportBackup(db, {})).toThrow(BackupFormatError)
  })

  it('可以只导出指定实体', () => {
    const { envelope } = exportBackup(db, { passphrase: PASS, entities: ['Server'] })
    expect(envelope.meta!.counts![STORE_KEYS.server]).toBe(2)
    expect(envelope.meta!.counts![STORE_KEYS.group]).toBeUndefined()
  })
})

describe('导出 → 导入往返', () => {
  let src: StoreDb
  let dst: StoreDb

  beforeEach(() => {
    src = new StoreDb(':memory:')
    dst = new StoreDb(':memory:')
  })
  afterEach(() => {
    src.close()
    dst.close()
  })

  it('往返后数据逐行一致（含 payload / created_at / updated_at）', () => {
    seed(src)
    const { data } = exportBackup(src, { passphrase: PASS })
    const result = importBackup(dst, data, { passphrase: PASS })

    expect(result.total).toBe(4)
    expect(result.mode).toBe('replace')

    for (const id of ['s1', 's2']) {
      const a = src.get(STORE_KEYS.server, id)!
      const b = dst.get(STORE_KEYS.server, id)!
      expect(b.payload).toBe(a.payload)
      expect(b.created_at).toBe(a.created_at)
      expect(b.updated_at).toBe(a.updated_at)
    }
    expect(dst.count(STORE_KEYS.group)).toBe(1)
    expect(dst.count(STORE_KEYS.credential)).toBe(1)
  })

  it('导入 replace 模式会清掉目标库原有数据', () => {
    seed(src)
    dst.put(STORE_KEYS.server, 'stale', JSON.stringify({ id: 'stale' }), 999)

    const { data } = exportBackup(src, { passphrase: PASS })
    importBackup(dst, data, { passphrase: PASS, mode: 'replace' })

    expect(dst.get(STORE_KEYS.server, 'stale')).toBeUndefined()
    expect(dst.count(STORE_KEYS.server)).toBe(2)
  })

  it('merge 模式保留本地更新的行', () => {
    src.put(STORE_KEYS.server, 's1', JSON.stringify({ v: 'from-backup' }), 1000)
    dst.put(STORE_KEYS.server, 's1', JSON.stringify({ v: 'local-newer' }), 5000)

    const { data } = exportBackup(src, { passphrase: PASS })
    const result = importBackup(dst, data, { passphrase: PASS, mode: 'merge' })

    expect(result.skipped).toBe(1)
    expect(JSON.parse(dst.get(STORE_KEYS.server, 's1')!.payload).v).toBe('local-newer')
  })

  it('merge 模式会用更新的备份行覆盖本地旧行', () => {
    src.put(STORE_KEYS.server, 's1', JSON.stringify({ v: 'backup-newer' }), 9000)
    dst.put(STORE_KEYS.server, 's1', JSON.stringify({ v: 'local-older' }), 100)

    const { data } = exportBackup(src, { passphrase: PASS })
    importBackup(dst, data, { passphrase: PASS, mode: 'merge' })

    expect(JSON.parse(dst.get(STORE_KEYS.server, 's1')!.payload).v).toBe('backup-newer')
  })

  it('空库导出再导入不报错', () => {
    const { data } = exportBackup(src, { passphrase: PASS })
    const result = importBackup(dst, data, { passphrase: PASS })
    expect(result.total).toBe(0)
  })

  it('导入失败时不留半截数据（解析先于写入）', () => {
    seed(src)
    const { data } = exportBackup(src, { passphrase: PASS })
    dst.put(STORE_KEYS.server, 'existing', '{}', 1)

    const corrupted = Buffer.from(data.toString('utf8').replace(/A/g, 'B'), 'utf8')
    expect(() => importBackup(dst, corrupted, { passphrase: PASS })).toThrow()

    // 原有数据未被清掉
    expect(dst.get(STORE_KEYS.server, 'existing')).toBeDefined()
  })
})

describe('安全校验：篡改与错误口令', () => {
  let db: StoreDb
  beforeEach(() => {
    db = new StoreDb(':memory:')
    seed(db)
  })
  afterEach(() => db.close())

  it('口令错误时拒绝导入', () => {
    const { data } = exportBackup(db, { passphrase: PASS })
    expect(() => parseBackup(data, { passphrase: 'wrong-passphrase' })).toThrow(BackupDecryptError)
  })

  it('篡改 magic 首行被拒绝', () => {
    const { data } = exportBackup(db, { passphrase: PASS })
    const tampered = data.toString('utf8').replace(BACKUP_MAGIC, 'XTREM_BACKUP')
    expect(() => parseBackup(tampered, { passphrase: PASS })).toThrow(BackupFormatError)
    expect(() => parseBackup(tampered, { passphrase: PASS })).toThrow(/magic/)
  })

  it('篡改版本号被拒绝', () => {
    const { data, envelope } = exportBackup(db, { passphrase: PASS })
    const bumped = { ...envelope, version: 99 }
    const text = `${BACKUP_MAGIC}\n${Buffer.from(JSON.stringify(bumped)).toString('base64')}\n`

    expect(() => parseBackup(text, { passphrase: PASS })).toThrow(BackupFormatError)
    expect(() => parseBackup(text, { passphrase: PASS })).toThrow(/版本/)
  })

  it('信封内 magic 字段与首行不一致时被拒绝', () => {
    const { envelope } = exportBackup(db, { passphrase: PASS })
    const bad = { ...envelope, magic: 'SOMETHING_ELSE' }
    const text = `${BACKUP_MAGIC}\n${Buffer.from(JSON.stringify(bad)).toString('base64')}\n`
    expect(() => parseBackup(text, { passphrase: PASS })).toThrow(/magic/)
  })

  it('篡改密文正文被拒绝（GCM 认证失败）', () => {
    const { envelope } = exportBackup(db, { passphrase: PASS })
    const bytes = Buffer.from(envelope.payload, 'base64')
    bytes[0] = bytes[0]! ^ 0xff
    const bad = { ...envelope, payload: bytes.toString('base64') }
    const text = `${BACKUP_MAGIC}\n${Buffer.from(JSON.stringify(bad)).toString('base64')}\n`
    expect(() => parseBackup(text, { passphrase: PASS })).toThrow(BackupDecryptError)
  })

  it('缺少 magic 首行被拒绝', () => {
    expect(() => parseBackup('just some text', { passphrase: PASS })).toThrow(BackupFormatError)
    expect(() => parseBackup('just some text', { passphrase: PASS })).toThrow(/缺少头部/)
  })

  it('第二行不是合法 JSON 时被拒绝', () => {
    expect(() => parseBackup(`${BACKUP_MAGIC}\nnot-base64-json!!!`, { passphrase: PASS })).toThrow(
      BackupFormatError,
    )
  })

  it('不支持的 KDF 被拒绝', () => {
    const { envelope } = exportBackup(db, { passphrase: PASS })
    const bad = { ...envelope, kdf: { ...envelope.kdf, algo: 'argon2' } }
    const text = `${BACKUP_MAGIC}\n${Buffer.from(JSON.stringify(bad)).toString('base64')}\n`
    expect(() => parseBackup(text, { passphrase: PASS })).toThrow(/KDF/)
  })

  it('salt/iv/tag 长度非法被拒绝', () => {
    const { envelope } = exportBackup(db, { passphrase: PASS })
    const bad = { ...envelope, salt: Buffer.alloc(4).toString('base64') }
    const text = `${BACKUP_MAGIC}\n${Buffer.from(JSON.stringify(bad)).toString('base64')}\n`
    expect(() => parseBackup(text, { passphrase: PASS })).toThrow(/长度/)
  })

  it('导入时缺口令抛错（不会写出半截数据）', () => {
    const { data } = exportBackup(db, { passphrase: PASS })
    const target = new StoreDb(':memory:')
    expect(() => importBackup(target, data, {})).toThrow(BackupFormatError)
    target.close()
  })
})
