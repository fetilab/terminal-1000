// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * `store.importOpenSsh` 的 IPC 边界单测：zod 校验、默认路径、文件不存在的明确错误、
 * dryRun 不写库、以及导入后经真实 Repository 落库并加密。
 *
 * 用临时目录造真实的 ~/.ssh/config，走真实 IO 适配器（不是内存替身），
 * 这样能一起验证 sshconfig-fs 的路径展开与权限处理。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SshConnection } from '@t1000/shared'
import { AppError } from '../../errors'
import type { IpcContext, IpcHandler } from '../../ipc/router'
import { StoreService, setStoreService, storeHandlers } from './index'
import { LOCKED_MASK, isCiphertext } from './crypto'
import { STORE_KEYS } from './db'

function makeCtx(tempDir: string): IpcContext {
  return {
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    paths: { dbFile: ':memory:', backupDir: join(tempDir, 'backups') } as IpcContext['paths'],
    emit: () => {},
  }
}

async function call<T = unknown>(action: string, payload: unknown, ctx: IpcContext): Promise<T> {
  const handler = storeHandlers[action] as IpcHandler | undefined
  if (!handler) throw new Error(`handler 不存在: ${action}`)
  return (await handler(payload, ctx)) as T
}

async function expectAppError(
  action: string,
  payload: unknown,
  ctx: IpcContext,
  code: string,
): Promise<AppError> {
  try {
    await call(action, payload, ctx)
  } catch (err) {
    expect(err).toBeInstanceOf(AppError)
    const appErr = err as AppError
    expect(appErr.code).toBe(code)
    return appErr
  }
  throw new Error(`期望 ${action} 抛出 ${code}，但它成功了`)
}

/** 结果里 entries 的形状 */
interface EntryView {
  name: string
  host: string
  port: number
  username?: string
  warnings?: string[]
}

interface ImportResult {
  source: string
  parsed: number
  created: number
  skipped: number
  renamed: number
  overwritten: number
  dryRun: boolean
  entries: EntryView[]
  unsupported: Array<{ directive: string; host?: string; reason: string }>
  errors: Array<{ line: number; message: string; text: string }>
  missingKeys: string[]
}

describe('store.importOpenSsh（IPC 边界）', () => {
  let dir: string
  let sshDir: string
  let configPath: string
  let ctx: IpcContext
  let svc: StoreService

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 't1000-openssh-'))
    sshDir = join(dir, '.ssh')
    mkdirSync(sshDir, { recursive: true })
    configPath = join(sshDir, 'config')
    ctx = makeCtx(dir)
    svc = new StoreService(':memory:')
    setStoreService(svc)
  })

  /**
   * 导入需要解锁（否则机密字段会在写库时被丢弃）。
   * 大多数用例关心的是解析/冲突逻辑，所以默认先解锁；
   * "锁定态应被拒绝"由下面专门的用例覆盖。
   */
  async function unlock(): Promise<void> {
    await call('setMasterPassword', { newPassword: 'master-pass-1' }, ctx)
  }

  afterEach(() => {
    setStoreService(null)
    svc.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('动作已在 handler 表里注册', () => {
    expect(storeHandlers.importOpenSsh).toBeTypeOf('function')
  })

  it('通过显式 path 导入，dryRun 不写库', async () => {
    writeFileSync(configPath, ['Host web', '  HostName 10.0.0.1', '  User deploy'].join('\n'))

    const result = await call<ImportResult>('importOpenSsh', { path: configPath, dryRun: true }, ctx)

    expect(result.dryRun).toBe(true)
    expect(result.parsed).toBe(1)
    // dryRun 下计数仍然预演（UI 要提前告诉用户"将新建 1 条"），但**不写库**
    expect(result.created).toBe(1)
    expect(result.entries[0]).toMatchObject({ name: 'web', host: '10.0.0.1', port: 22, username: 'deploy' })
    // 关键：库里确实没有
    expect(await call<unknown[]>('listConnections', {}, ctx)).toEqual([])
  })

  it('非 dryRun 真正写库且能被 listConnections 读到', async () => {
    await unlock()
    writeFileSync(configPath, ['Host web', '  HostName 10.0.0.1', '  User deploy', '  Port 2222'].join('\n'))

    const result = await call<ImportResult>('importOpenSsh', { path: configPath }, ctx)
    expect(result.created).toBe(1)

    const list = await call<SshConnection[]>('listConnections', {}, ctx)
    expect(list).toHaveLength(1)
    expect(list[0]!.name).toBe('web')
    expect(list[0]!.host).toBe('10.0.0.1')
    expect(list[0]!.port).toBe(2222)
    expect(list[0]!.username).toBe('deploy')
  })

  it('path 缺省时报明确的「未找到」错误（本机无 ~/.ssh/config）', async () => {
    // 不传 path → 用真实 home 的 ~/.ssh/config；本机不存在
    const err = await expectAppError('importOpenSsh', {}, ctx, 'NOT_FOUND')
    expect(err.message).toContain('未找到')
    expect(err.message).toContain('.ssh/config')
  })

  it('显式 path 指向不存在的文件 → NOT_FOUND 且带路径', async () => {
    const missing = join(sshDir, 'nope.conf')
    const err = await expectAppError('importOpenSsh', { path: missing }, ctx, 'NOT_FOUND')
    expect(err.message).toContain(missing)
  })

  it('path 为空串 → BAD_REQUEST（zod 拦截）', async () => {
    await expectAppError('importOpenSsh', { path: '' }, ctx, 'BAD_REQUEST')
  })

  it('非法 conflictPolicy → BAD_REQUEST', async () => {
    writeFileSync(configPath, 'Host a\n')
    await expectAppError(
      'importOpenSsh',
      { path: configPath, conflictPolicy: 'explode' },
      ctx,
      'BAD_REQUEST',
    )
  })

  it('payload 缺省（undefined）也能工作', async () => {
    // 不传任何参数 → 用默认路径，本机无文件 → NOT_FOUND
    await expectAppError('importOpenSsh', undefined, ctx, 'NOT_FOUND')
  })

  it('语法错误带准确行号地返回，不抛异常', async () => {
    writeFileSync(configPath, ['Host a', '  HostName "unterminated', '  User u'].join('\n'))

    const result = await call<ImportResult>('importOpenSsh', { path: configPath, dryRun: true }, ctx)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]!.line).toBe(2)
    expect(result.errors[0]!.message).toContain('引号未闭合')
  })

  it('unsupported 如实返回未知指令', async () => {
    writeFileSync(configPath, ['Host a', '  TotallyUnknownDirective 1'].join('\n'))
    const result = await call<ImportResult>('importOpenSsh', { path: configPath, dryRun: true }, ctx)
    expect(result.unsupported.some((u) => u.directive === 'totallyunknowndirective')).toBe(true)
  })

  it('三种冲突策略在 IPC 层都生效', async () => {
    await unlock()
    writeFileSync(configPath, ['Host web', '  HostName 10.0.0.1'].join('\n'))

    // 先建一个同名连接
    await call('saveConnection', {
      kind: 'ssh',
      id: 'x1',
      name: 'web',
      host: '9.9.9.9',
      port: 22,
      username: 'old',
      authType: 'password',
    }, ctx)

    const skip = await call<ImportResult>(
      'importOpenSsh', { path: configPath, conflictPolicy: 'skip' }, ctx)
    expect(skip.skipped).toBe(1)

    const rename = await call<ImportResult>(
      'importOpenSsh', { path: configPath, conflictPolicy: 'rename', dryRun: true }, ctx)
    expect(rename.renamed).toBe(1)
    expect(rename.entries[0]!.name).toBe('web (2)')

    const overwrite = await call<ImportResult>(
      'importOpenSsh', { path: configPath, conflictPolicy: 'overwrite' }, ctx)
    expect(overwrite.overwritten).toBe(1)

    const list = await call<SshConnection[]>('listConnections', {}, ctx)
    expect(list).toHaveLength(1) // overwrite 没新增
    expect(list[0]!.host).toBe('10.0.0.1')
    expect(list[0]!.id).toBe('x1') // 沿用原 id
  })

  it('导入的私钥经 Repository 落库后是密文（未绕过加密层）', async () => {
    const keyPath = join(sshDir, 'id_test')
    writeFileSync(keyPath, 'SUPER-SECRET-KEY-MATERIAL')

    // 用绝对路径引用私钥，避免依赖真实 home
    writeFileSync(
      configPath,
      ['Host secure', '  HostName 10.0.0.5', `  IdentityFile ${keyPath}`].join('\n'),
    )

    // 必须先解锁：锁定态写库会丢机密字段（见下面的专门测试）
    await call('setMasterPassword', { newPassword: 'master-pass-1' }, ctx)
    await call<ImportResult>('importOpenSsh', { path: configPath }, ctx)

    const list = await call<SshConnection[]>('listConnections', {}, ctx)
    expect(list).toHaveLength(1)
    // 解锁态：读回明文
    expect(list[0]!.privateKey).toBe('SUPER-SECRET-KEY-MATERIAL')

    // 落盘是密文
    const row = svc.db.get(STORE_KEYS.server, list[0]!.id)!
    expect(row.payload).not.toContain('SUPER-SECRET-KEY-MATERIAL')
    expect(isCiphertext((JSON.parse(row.payload) as { privateKey: string }).privateKey)).toBe(true)
  })

  it('私钥不可读：只警告不中断，且 missingKeys 明确指出是哪一条', async () => {
    await unlock()
    writeFileSync(
      configPath,
      [
        'Host good',
        '  HostName 10.0.0.1',
        'Host bad',
        '  HostName 10.0.0.2',
        `  IdentityFile ${join(sshDir, 'does_not_exist')}`,
      ].join('\n'),
    )

    const result = await call<ImportResult>('importOpenSsh', { path: configPath }, ctx)

    // 两条都导入了，没有因为私钥缺失中断
    expect(result.created).toBe(2)
    expect(result.missingKeys).toEqual(['bad'])
    const bad = result.entries.find((e) => e.name === 'bad')!
    expect(bad.warnings!.some((w) => w.includes('私钥不可读'))).toBe(true)
  })

  it('Include 目录 + 通配符 + 循环在真实文件系统下都正常', async () => {
    const confD = join(sshDir, 'conf.d')
    mkdirSync(confD, { recursive: true })
    writeFileSync(join(confD, 'a.conf'), 'Host from-a\n  HostName 10.1.1.1\n')
    writeFileSync(join(confD, 'b.conf'), 'Host from-b\n  HostName 10.1.1.2\n')
    writeFileSync(
      configPath,
      ['Host main', '  HostName 10.0.0.1', 'Include conf.d/*.conf'].join('\n'),
    )

    const result = await call<ImportResult>('importOpenSsh', { path: configPath, dryRun: true }, ctx)
    expect(result.entries.map((e) => e.name).sort()).toEqual(['from-a', 'from-b', 'main'])
    expect(result.errors).toEqual([])
  })

  it('循环 Include 在真实文件系统下不死循环', async () => {
    const other = join(sshDir, 'other.conf')
    writeFileSync(configPath, ['Include other.conf', 'Host main', '  HostName 10.0.0.1'].join('\n'))
    writeFileSync(other, ['Include config', 'Host other', '  HostName 10.0.0.2'].join('\n'))

    const result = await call<ImportResult>('importOpenSsh', { path: configPath, dryRun: true }, ctx)
    expect(result.entries.map((e) => e.name).sort()).toEqual(['main', 'other'])
    expect(result.errors.some((e) => e.message.includes('循环 Include'))).toBe(true)
  })

  it('ProxyJump 映射为契约的 jumpChain', async () => {
    await unlock()
    writeFileSync(
      configPath,
      ['Host web', '  HostName 10.0.0.1', '  ProxyJump alice@bastion:2200'].join('\n'),
    )

    await call<ImportResult>('importOpenSsh', { path: configPath }, ctx)

    const list = await call<SshConnection[]>('listConnections', {}, ctx)
    expect(list[0]!.jumpChain).toHaveLength(1)
    expect(list[0]!.jumpChain![0]).toMatchObject({
      host: 'bastion',
      port: 2200,
      username: 'alice',
    })
  })

  it('导入的连接锁定后私钥读作掩码', async () => {
    const keyPath = join(sshDir, 'id_x')
    writeFileSync(keyPath, 'KEYDATA')
    writeFileSync(
      configPath,
      ['Host secure', '  HostName 10.0.0.5', `  IdentityFile ${keyPath}`].join('\n'),
    )

    await unlock()
    await call<ImportResult>('importOpenSsh', { path: configPath }, ctx)

    await call('lock', {}, ctx)
    const list = await call<SshConnection[]>('listConnections', {}, ctx)
    expect(list[0]!.privateKey).toBe(LOCKED_MASK)
  })
})

describe('importOpenSsh：锁定态必须拒绝写库', () => {
  let dir: string
  let sshDir: string
  let configPath: string
  let ctx: IpcContext
  let svc: StoreService

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 't1000-openssh-lock-'))
    sshDir = join(dir, '.ssh')
    mkdirSync(sshDir, { recursive: true })
    configPath = join(sshDir, 'config')
    ctx = makeCtx(dir)
    svc = new StoreService(':memory:')
    setStoreService(svc)
  })

  afterEach(() => {
    setStoreService(null)
    svc.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('未解锁时写库被拒绝（否则私钥会被静默丢弃）', async () => {
    // 造一把能读到的私钥——问题不在于读不到，而在于锁定态**写不进去**
    const keyPath = join(sshDir, 'id_locked')
    writeFileSync(keyPath, 'KEY-MATERIAL')
    writeFileSync(
      configPath,
      ['Host secure', '  HostName 10.0.0.5', `  IdentityFile ${keyPath}`].join('\n'),
    )

    expect(svc.isUnlocked()).toBe(false)
    const err = await expectAppError('importOpenSsh', { path: configPath }, ctx, 'UNAUTHORIZED')
    expect(err.message).toContain('解锁')

    // 关键：没有留下任何半截数据
    expect(await call<unknown[]>('listConnections', {}, ctx)).toEqual([])
  })

  it('未解锁时 dryRun 仍然允许（预览不需要密钥）', async () => {
    writeFileSync(configPath, ['Host web', '  HostName 10.0.0.1'].join('\n'))

    const result = await call<ImportResult>('importOpenSsh', { path: configPath, dryRun: true }, ctx)
    expect(result.entries[0]!.name).toBe('web')
    expect(await call<unknown[]>('listConnections', {}, ctx)).toEqual([])
  })

  it('解锁后导入成功，且私钥完整可读回（回归：不得被掩码顶掉）', async () => {
    const keyPath = join(sshDir, 'id_ok')
    writeFileSync(keyPath, 'REAL-KEY-MATERIAL')
    writeFileSync(
      configPath,
      ['Host secure', '  HostName 10.0.0.5', `  IdentityFile ${keyPath}`].join('\n'),
    )

    await call('setMasterPassword', { newPassword: 'master-pass-1' }, ctx)
    await call<ImportResult>('importOpenSsh', { path: configPath }, ctx)

    const list = await call<SshConnection[]>('listConnections', {}, ctx)
    expect(list[0]!.privateKey).toBe('REAL-KEY-MATERIAL')
    expect(list[0]!.privateKey).not.toBe(LOCKED_MASK)
  })

  it('锁定态被拒绝后，解锁再导入仍然正常', async () => {
    writeFileSync(configPath, ['Host web', '  HostName 10.0.0.1'].join('\n'))

    await expectAppError('importOpenSsh', { path: configPath }, ctx, 'UNAUTHORIZED')

    await call('setMasterPassword', { newPassword: 'master-pass-1' }, ctx)
    const result = await call<ImportResult>('importOpenSsh', { path: configPath }, ctx)
    expect(result.created).toBe(1)
  })
})
