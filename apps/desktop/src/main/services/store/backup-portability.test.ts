// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 备份的**跨设备字段可迁移性**（task-12 的核心）。
 *
 * 缺陷背景：信封用备份口令加密没问题，但信封内的敏感字段仍是「各机主密钥」的
 * 字段级密文 → 换机导入后凭据解不开（静默失效，比不同步更糟）。
 *
 * 新语义：
 * - 带口令的备份 = 可跨设备载体：导出时用本机主密钥解密 → 用备份口令派生的字段密钥重加密；
 *   导入时反向（用备份口令解开 → 用本机主密钥重新加密落库）。
 * - 不带口令的本地备份行为与格式完全不变：字段仍是本机主密钥密文，换机解不开且报错明确。
 * - 锁定态不能导出「可换机还原明文凭据」的备份 —— 那等于绕过主密码保护。
 *
 * 这里用真实的 StoreService（:memory: 库 + 真实 scrypt），
 * 「另一台机器」= 新 StoreService + 不同主密钥。
 */

import { describe, expect, it } from 'vitest'
import type { Credential, SshConnection } from '@t1000/shared'
import { AppError } from '../../errors'
import { StoreService } from './index'
import {
  BackupConfigError,
  BackupLockedError,
  exportBackup,
  importBackup,
  parseBackup,
  type BackupEnvelope,
  type FieldCodec,
} from './backup'
import { StoreDb } from './db'
import { Repository } from './repository'
import { Vault, deriveKey } from './crypto'

const NOW = '2026-11-05T10:00:00.000Z'
const PORTABLE_PASS = 'portable-passphrase-1'

/** 所有被加密的明文凭据：任何一条都不允许出现在备份字节里 */
const SECRETS = {
  connPassword: 'plain-conn-password-9d1f',
  privateKey: 'plain-private-key-4c2a',
  passphrase: 'plain-key-passphrase-77bb',
  jumpPassword: 'plain-jump-password-5e3c',
  jumpPassphrase: 'plain-jump-passphrase-8a01',
  proxyPassword: 'plain-proxy-password-2f6d',
  credPassword: 'plain-cred-password-b30e',
} as const

/** 一台「机器」= 独立库 + 独立主密钥（不同口令 → 不同密钥） */
function makeMachine(masterPassword: string): StoreService {
  const store = new StoreService(':memory:')
  store.unlock(masterPassword)
  return store
}

/** 造出覆盖嵌套敏感字段的夹具：连接（跳板链/代理）+ 凭证 */
function seedMachine(machine: StoreService): void {
  const conn: SshConnection = {
    kind: 'ssh',
    id: 'c1',
    name: 'web-01',
    host: '10.0.0.1',
    port: 22,
    username: 'root',
    authType: 'password',
    password: SECRETS.connPassword,
    privateKey: SECRETS.privateKey,
    passphrase: SECRETS.passphrase,
    jumpChain: [
      {
        id: 'j1',
        host: '10.0.0.9',
        port: 22,
        username: 'jump',
        authType: 'password',
        password: SECRETS.jumpPassword,
        passphrase: SECRETS.jumpPassphrase,
      },
    ],
    proxy: { url: 'socks5://127.0.0.1:1080', password: SECRETS.proxyPassword },
    createdAt: NOW,
    updatedAt: NOW,
  }
  machine.saveConnection(conn)

  const credential: Credential = {
    id: 'cred1',
    name: 'shared',
    username: 'deploy',
    password: SECRETS.credPassword,
    createdAt: NOW,
    updatedAt: NOW,
  }
  machine.saveCredential(credential)
}

/** 不做解密、只读信封 meta（用来断言格式自描述位） */
function readEnvelope(data: Buffer): BackupEnvelope {
  const text = data.toString('utf8')
  const body = text.slice(text.indexOf('\n') + 1).trim()
  return JSON.parse(Buffer.from(body, 'base64').toString('utf8')) as BackupEnvelope
}

const noopCodec: FieldCodec = {
  decryptFields: (payload) => payload,
  encryptFields: (payload) => payload,
}

describe('带口令备份：跨设备字段迁移', () => {
  it('★ 换一台机器导入后，嵌套敏感字段都能读回原值', () => {
    const machineA = makeMachine('master-A')
    seedMachine(machineA)
    const { data } = machineA.renderBackup(PORTABLE_PASS)

    // 另一台机器：不同主密钥，只有同一个备份口令
    const machineB = makeMachine('master-B')
    machineB.importBackup(data, { passphrase: PORTABLE_PASS, mode: 'replace' })

    const conn = machineB.listConnections().find((c) => c.id === 'c1') as SshConnection
    expect(conn).toBeDefined()
    expect(conn.password).toBe(SECRETS.connPassword)
    expect(conn.privateKey).toBe(SECRETS.privateKey)
    expect(conn.passphrase).toBe(SECRETS.passphrase)
    // 跳板链每一跳
    expect(conn.jumpChain?.[0]?.password).toBe(SECRETS.jumpPassword)
    expect(conn.jumpChain?.[0]?.passphrase).toBe(SECRETS.jumpPassphrase)
    // 代理密码
    expect(conn.proxy?.password).toBe(SECRETS.proxyPassword)

    const credential = machineB.listCredentials().find((c) => c.id === 'cred1')
    expect(credential?.password).toBe(SECRETS.credPassword)
  })

  it('导入后字段重新变成「本机主密钥」密文（不是备份口令的密文）', () => {
    const machineA = makeMachine('master-A')
    seedMachine(machineA)
    const { data } = machineA.renderBackup(PORTABLE_PASS)

    const machineB = makeMachine('master-B')
    machineB.importBackup(data, { passphrase: PORTABLE_PASS, mode: 'replace' })

    // B 锁定后应看到掩码（说明字段是 B 的主密钥密文），而不是乱码或备份口令密文
    machineB.lock()
    const locked = machineB.getConnection('c1') as SshConnection
    expect(locked.password).toBe('__LOCKED__')
    // 再解锁又能读回
    machineB.unlock('master-B')
    expect((machineB.getConnection('c1') as SshConnection).password).toBe(SECRETS.connPassword)
  })

  it('导出字节里不含任何明文凭据（原始字节 + base64 双向 grep）', () => {
    const machineA = makeMachine('master-A')
    seedMachine(machineA)
    const { data } = machineA.renderBackup(PORTABLE_PASS)
    const raw = data.toString('utf8')

    for (const secret of Object.values(SECRETS)) {
      expect(raw).not.toContain(secret)
      // 也要排除「只是被 base64 了一遍」的情况
      expect(raw).not.toContain(Buffer.from(secret, 'utf8').toString('base64'))
    }

    // 信封自描述为「可迁移」
    const envelope = readEnvelope(data)
    expect(envelope.meta?.fieldSalt).toBeTypeOf('string')
    expect(envelope.meta?.portableFields).toBe(true)

    // 用备份口令解开信封后，字段本身仍是 v1: 前缀的密文（二次加密，不是明文）
    const { content } = parseBackup(data, { passphrase: PORTABLE_PASS })
    const fieldsJson = JSON.stringify(content.entities)
    expect(fieldsJson).toContain('v1:')
    for (const secret of Object.values(SECRETS)) {
      expect(fieldsJson).not.toContain(secret)
    }
  })

  it('带字段迁移的备份若缺口令导入，必须明确报错（不能写入解不开的凭据）', () => {
    const machineA = makeMachine('master-A')
    seedMachine(machineA)
    const { data } = machineA.renderBackup(PORTABLE_PASS)
    const envelope = readEnvelope(data)

    const db = new StoreDb(':memory:')
    const envelopeKey = deriveKey(PORTABLE_PASS, Buffer.from(envelope.salt, 'base64'))
    expect(() =>
      importBackup(db, data, {
        key: envelopeKey, // 信封解得开
        fieldCodec: noopCodec,
        masterKey: deriveKey('master-B', Buffer.alloc(16, 1)),
        // 但没有备份口令 → 无法派生字段密钥
      }),
    ).toThrow(BackupConfigError)
  })
})

describe('锁定态：不能产出可跨设备还原凭据的备份', () => {
  it('未解锁时带口令导出明确报错，并告知先解锁', () => {
    const machineA = makeMachine('master-A')
    seedMachine(machineA)
    machineA.lock()

    let caught: unknown
    try {
      machineA.renderBackup(PORTABLE_PASS)
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(AppError)
    const appErr = caught as AppError
    expect(appErr.code).toBe('UNAUTHORIZED')
    expect(appErr.message).toContain('未解锁')
    expect(appErr.message).toContain('请先解锁')
  })

  it('低层 exportBackup 在缺少主密钥时抛 BackupLockedError（不会写出坏备份）', () => {
    const db = new StoreDb(':memory:')
    expect(() =>
      exportBackup(db, { passphrase: PORTABLE_PASS, fieldCodec: noopCodec, masterKey: null }),
    ).toThrow(BackupLockedError)
  })

  it('未解锁时导入带字段迁移的备份同样明确报错', () => {
    const machineA = makeMachine('master-A')
    seedMachine(machineA)
    const { data } = machineA.renderBackup(PORTABLE_PASS)

    const machineB = makeMachine('master-B')
    machineB.lock()

    let caught: unknown
    try {
      machineB.importBackup(data, { passphrase: PORTABLE_PASS, mode: 'replace' })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(AppError)
    expect((caught as AppError).message).toContain('请先解锁')
  })
})

describe('不带口令的本地备份：行为与格式不变', () => {
  it('同一台机器可导入并读回密文，且信封不写 fieldSalt', () => {
    const machineA = makeMachine('master-A')
    seedMachine(machineA)

    const local = machineA.renderBackup() // 无口令 → 本机主密钥信封
    expect(readEnvelope(local.data).meta?.fieldSalt).toBeUndefined()

    // 同机导入（同一把主密钥）→ 字段照常可读
    const result = machineA.importBackup(local.data, { mode: 'merge' })
    expect(result.total).toBeGreaterThan(0)
    const conn = machineA.listConnections().find((c) => c.id === 'c1') as SshConnection
    expect(conn.password).toBe(SECRETS.connPassword)
    expect(conn.jumpChain?.[0]?.password).toBe(SECRETS.jumpPassword)
  })

  it('换一台机器导入本地备份：明确报错，而不是写入解不开的凭据', () => {
    const machineA = makeMachine('master-A')
    seedMachine(machineA)
    const local = machineA.renderBackup()

    const machineB = makeMachine('master-B')
    let caught: unknown
    try {
      machineB.importBackup(local.data, { mode: 'replace' })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(AppError)
    expect((caught as AppError).code).toBe('UNAUTHORIZED')
    // 拒绝导入 → B 仍是空库，没有半截数据
    expect(machineB.listConnections()).toHaveLength(0)
  })

  it('低层不带 codec 的调用保持旧行为（既有测试依赖这点）', () => {
    const machineA = makeMachine('master-A')
    seedMachine(machineA)
    const db = new StoreDb(':memory:')
    // 直接调低层：只做信封加密，字段原样搬运，不写 fieldSalt
    const { envelope } = exportBackup(db, { passphrase: PORTABLE_PASS })
    expect(envelope.meta?.fieldSalt).toBeUndefined()
  })
})

describe('字段清单复用 repository（不另造一套）', () => {
  it('apiKey / token 与 password 走同一套递归扫描', () => {
    const vault = new Vault()
    vault.unlockWithKey(deriveKey('master-key', Buffer.alloc(16, 7)))
    const key = vault.currentKey()
    expect(key).not.toBeNull()
    if (!key) return

    const repo = new Repository(new StoreDb(':memory:'), () => vault.currentKey())
    const otherKey = deriveKey('other-master', Buffer.alloc(16, 8))

    const payload = {
      password: 'p-secret',
      nested: { apiKey: 'k-secret', token: 't-secret' },
      list: [{ passphrase: 'pp-secret', privateKey: 'pk-secret' }],
      plain: 'keep-me',
    }

    const encrypted = repo.encryptFields(payload, key)
    const asText = JSON.stringify(encrypted)
    for (const secret of ['p-secret', 'k-secret', 't-secret', 'pp-secret', 'pk-secret']) {
      expect(asText).not.toContain(secret)
    }
    expect(asText).toContain('keep-me') // 非敏感字段不动

    // 解回来一模一样
    expect(repo.decryptFields(encrypted, key)).toEqual(payload)
    // 别的密钥解不开（GCM 认证失败）
    expect(() => repo.decryptFields(encrypted, otherKey)).toThrow()
  })
})
