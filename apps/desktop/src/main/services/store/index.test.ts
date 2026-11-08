// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * IPC 边界端到端单测：走真实的 `storeHandlers` 表 + zod 校验，
 * 覆盖验收标准里的「锁定/解锁往返」「改主密码后旧密文全部可读」「备份往返」。
 *
 * 不依赖 Electron：手工构造一个最小 IpcContext。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SshConnection } from '@t1000/shared'
import { AppError } from '../../errors'
import type { IpcContext, IpcHandler } from '../../ipc/router'
import { StoreService, setStoreService, storeHandlers } from './index'
import { LOCKED_MASK } from './crypto'
import { BackupDecryptError, parseBackup } from './backup'

/** 最小 IpcContext（真实实现依赖 Electron，这里只提供 store 用到的字段） */
function makeCtx(backupDir: string): IpcContext {
  return {
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    paths: { dbFile: ':memory:', backupDir } as IpcContext['paths'],
    emit: () => {},
  }
}

/** 调用某个 handler 并断言成功，返回 data */
async function call<T = unknown>(
  action: string,
  payload: unknown,
  ctx: IpcContext,
): Promise<T> {
  const handler = storeHandlers[action] as IpcHandler | undefined
  if (!handler) throw new Error(`handler 不存在: ${action}`)
  return (await handler(payload, ctx)) as T
}

/** 断言调用抛出指定 code 的 AppError */
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

const conn = (over: Partial<SshConnection> = {}): SshConnection => ({
  kind: 'ssh',
  id: 'c1',
  name: 'web-01',
  host: '10.0.0.1',
  port: 22,
  username: 'root',
  authType: 'password',
  password: 's3cret',
  createdAt: '',
  updatedAt: '',
  ...over,
})

describe('storeHandlers 端到端', () => {
  let dir: string
  let ctx: IpcContext
  let svc: StoreService

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 't1000-store-ipc-'))
    ctx = makeCtx(dir)
    svc = new StoreService(':memory:')
    setStoreService(svc)
  })

  afterEach(() => {
    setStoreService(null)
    svc.close()
    rmSync(dir, { recursive: true, force: true })
  })

  // ------------------------------------------------------------ 动作完整性

  it('15 个 store 动作全部已实现', () => {
    const expected = [
      'listConnections',
      'getConnection',
      'saveConnection',
      'deleteConnection',
      'moveConnection',
      'listGroups',
      'saveGroup',
      'deleteGroup',
      'exportBackup',
      'importBackup',
      'setMasterPassword',
      'unlock',
      'lock',
      'isUnlocked',
      'search',
    ]
    for (const action of expected) {
      expect(storeHandlers[action], `缺少 handler: ${action}`).toBeTypeOf('function')
    }
  })

  // -------------------------------------------------------------- 校验边界

  it('非法入参抛 BAD_REQUEST 并带 issues', async () => {
    const err = await expectAppError('getConnection', { id: '' }, ctx, 'BAD_REQUEST')
    expect(err.message).toContain('参数校验失败')
    expect(Array.isArray(err.detail)).toBe(true)
  })

  it('saveConnection 缺必填字段抛 BAD_REQUEST', async () => {
    await expectAppError('saveConnection', { id: 'x', name: 'n' }, ctx, 'BAD_REQUEST')
  })

  it('端口越界抛 BAD_REQUEST', async () => {
    await expectAppError('saveConnection', conn({ port: 99999 }), ctx, 'BAD_REQUEST')
  })

  it('未知 kind 抛 BAD_REQUEST', async () => {
    await expectAppError('saveConnection', { ...conn(), kind: 'gopher' }, ctx, 'BAD_REQUEST')
  })

  // ── 隧道连接的校验必须与其它协议不同 ──
  //
  // 曾经的真 bug：公共 schema 对所有 kind 都强制要求 host/port，
  // 而 TunnelConnection 契约里根本没有这两个字段（用 localHost/localPort/...），
  // 导致**隧道连接一律保存失败**（报 `host: Required; port: Required`）。
  // 这几条用例把"按 kind 分别校验"钉住，防止有人把 host/port 改回必填。
  describe('隧道连接的字段校验与其它协议不同', () => {
    const tunnel = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
      id: 'tun-1',
      name: 'grafana 隧道',
      kind: 'tunnel',
      serverId: 'srv-1',
      type: 'local',
      localHost: '127.0.0.1',
      localPort: 13000,
      remoteHost: '10.0.0.5',
      remotePort: 3000,
      autoReconnect: true,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      ...over,
    })

    it('★ 没有 host/port 也能保存（这正是之前保存失败的原因）', async () => {
      const saved = await call<{ id: string }>('saveConnection', tunnel(), ctx)
      expect(saved.id).toBe('tun-1')
    })

    it('缺 serverId 被拒（不知道该挂在哪个 SSH 连接上）', async () => {
      const { serverId: _drop, ...rest } = tunnel()
      await expectAppError('saveConnection', rest, ctx, 'BAD_REQUEST')
    })

    it('缺远端端口被拒', async () => {
      const { remotePort: _drop, ...rest } = tunnel()
      await expectAppError('saveConnection', rest, ctx, 'BAD_REQUEST')
    })

    it('非隧道协议仍然必须有 host（不能因为改了 schema 就放松）', async () => {
      const { host: _drop, ...rest } = conn()
      await expectAppError('saveConnection', rest, ctx, 'BAD_REQUEST')
    })

    it('非隧道协议仍然必须有 port', async () => {
      const { port: _drop, ...rest } = conn()
      await expectAppError('saveConnection', rest, ctx, 'BAD_REQUEST')
    })
  })

  it('主密码短于 8 位抛 BAD_REQUEST', async () => {
    await expectAppError('setMasterPassword', { newPassword: 'short' }, ctx, 'BAD_REQUEST')
  })

  it('搜索空关键词抛 BAD_REQUEST', async () => {
    await expectAppError('search', { keyword: '' }, ctx, 'BAD_REQUEST')
  })

  // ------------------------------------------------------- 主密码 / 锁定

  it('首次设置主密码后即处于解锁态', async () => {
    const before = await call<{ unlocked: boolean; initialized: boolean }>('isUnlocked', {}, ctx)
    expect(before).toEqual({ unlocked: false, initialized: false })

    await call('setMasterPassword', { newPassword: 'master-pass-1' }, ctx)

    const after = await call<{ unlocked: boolean; initialized: boolean }>('isUnlocked', {}, ctx)
    expect(after).toEqual({ unlocked: true, initialized: true })
  })

  it('锁定 → 解锁往返：加密字段写入后重新解锁能读回原值', async () => {
    await call('setMasterPassword', { newPassword: 'master-pass-1' }, ctx)
    await call('saveConnection', conn(), ctx)

    // 解锁态：读到明文
    const unlocked = await call<SshConnection>('getConnection', { id: 'c1' }, ctx)
    expect(unlocked.password).toBe('s3cret')

    // 锁定
    await call('lock', {}, ctx)
    const locked = await call<SshConnection>('getConnection', { id: 'c1' }, ctx)
    expect(locked.password).toBe(LOCKED_MASK)
    expect(locked.name).toBe('web-01') // 非敏感字段仍可读

    // 重新解锁：读回原值
    await call('unlock', { password: 'master-pass-1' }, ctx)
    const again = await call<SshConnection>('getConnection', { id: 'c1' }, ctx)
    expect(again.password).toBe('s3cret')
  })

  it('错误主密码解锁抛 UNAUTHORIZED', async () => {
    await call('setMasterPassword', { newPassword: 'master-pass-1' }, ctx)
    await call('lock', {}, ctx)
    await expectAppError('unlock', { password: 'wrong-pass-1' }, ctx, 'UNAUTHORIZED')
  })

  it('改主密码后旧密文全部可读（重加密生效）', async () => {
    await call('setMasterPassword', { newPassword: 'master-pass-1' }, ctx)
    await call('saveConnection', conn(), ctx)
    await call('saveCredential', { id: 'cred1', name: 'k', password: 'cred-pass' }, ctx)

    const result = await call<{ reencrypted: number; created: boolean }>(
      'setMasterPassword',
      { oldPassword: 'master-pass-1', newPassword: 'master-pass-2' },
      ctx,
    )
    expect(result.created).toBe(false)
    expect(result.reencrypted).toBe(2) // 连接 + 凭证

    // 新密码能读回全部旧密文
    await call('lock', {}, ctx)
    await call('unlock', { password: 'master-pass-2' }, ctx)

    const c = await call<SshConnection>('getConnection', { id: 'c1' }, ctx)
    expect(c.password).toBe('s3cret')
    const cred = await call<{ password?: string }>('listCredentials', {}, ctx)
    expect(cred).toHaveLength(1)
  })

  it('用旧主密码解锁改过密码的库会失败', async () => {
    await call('setMasterPassword', { newPassword: 'master-pass-1' }, ctx)
    await call('saveConnection', conn(), ctx)
    await call('setMasterPassword', { oldPassword: 'master-pass-1', newPassword: 'master-pass-2' }, ctx)

    await call('lock', {}, ctx)
    await expectAppError('unlock', { password: 'master-pass-1' }, ctx, 'UNAUTHORIZED')
  })

  it('改主密码时旧密码不对抛 UNAUTHORIZED', async () => {
    await call('setMasterPassword', { newPassword: 'master-pass-1' }, ctx)
    await expectAppError(
      'setMasterPassword',
      { oldPassword: 'nope-nope', newPassword: 'master-pass-2' },
      ctx,
      'UNAUTHORIZED',
    )
  })

  it('改主密码缺旧密码抛 BAD_REQUEST', async () => {
    await call('setMasterPassword', { newPassword: 'master-pass-1' }, ctx)
    await expectAppError('setMasterPassword', { newPassword: 'master-pass-2' }, ctx, 'BAD_REQUEST')
  })

  // ----------------------------------------------------------- 连接 CRUD

  it('保存 / 列出 / 获取 / 删除 连接', async () => {
    await call('setMasterPassword', { newPassword: 'master-pass-1' }, ctx)

    const saved = await call<SshConnection>('saveConnection', conn(), ctx)
    expect(saved.id).toBe('c1')
    expect(saved.createdAt).not.toBe('') // 时间戳被补上
    expect(saved.updatedAt).toBe(saved.createdAt)

    expect(await call<unknown[]>('listConnections', {}, ctx)).toHaveLength(1)

    await call('deleteConnection', { id: 'c1' }, ctx)
    expect(await call<unknown[]>('listConnections', {}, ctx)).toHaveLength(0)
  })

  it('getConnection 不存在抛 NOT_FOUND', async () => {
    await expectAppError('getConnection', { id: 'ghost' }, ctx, 'NOT_FOUND')
  })

  it('deleteConnection 不存在抛 NOT_FOUND', async () => {
    await expectAppError('deleteConnection', { id: 'ghost' }, ctx, 'NOT_FOUND')
  })

  it('save 时时间戳正确维护（新建补、更新只刷新 updatedAt）', async () => {
    await call('setMasterPassword', { newPassword: 'master-pass-1' }, ctx)

    const first = await call<SshConnection>('saveConnection', conn(), ctx)
    expect(first.createdAt).toBe(first.updatedAt)

    await new Promise((r) => setTimeout(r, 5))
    const second = await call<SshConnection>('saveConnection', conn({ name: 'renamed' }), ctx)

    expect(second.createdAt).toBe(first.createdAt) // 创建时间不变
    expect(second.updatedAt).not.toBe(first.updatedAt) // 更新时间前进
    expect(second.name).toBe('renamed')
  })

  // ------------------------------------------------------------ 分组

  it('分组 CRUD 与分组树', async () => {
    await call('setMasterPassword', { newPassword: 'master-pass-1' }, ctx)

    await call('saveGroup', { id: 'g1', name: 'Prod', kind: 'ssh', sortOrder: 0 }, ctx)
    await call('saveGroup', { id: 'g2', name: 'Sub', kind: 'ssh', sortOrder: 0, parentId: 'g1' }, ctx)
    await call('saveConnection', conn({ groupId: 'g1' }), ctx)

    const tree = await call<Array<{ id: string; connectionCount: number; children: Array<{ id: string }> }>>(
      'listGroups',
      {},
      ctx,
    )
    expect(tree).toHaveLength(1)
    expect(tree[0]!.id).toBe('g1')
    expect(tree[0]!.connectionCount).toBe(1)
    expect(tree[0]!.children.map((c) => c.id)).toEqual(['g2'])
  })

  it('分组不能以自己为父级', async () => {
    await call('setMasterPassword', { newPassword: 'master-pass-1' }, ctx)
    await expectAppError(
      'saveGroup',
      { id: 'g1', name: 'X', kind: 'ssh', sortOrder: 0, parentId: 'g1' },
      ctx,
      'BAD_REQUEST',
    )
  })

  it('父分组不存在抛 NOT_FOUND', async () => {
    await call('setMasterPassword', { newPassword: 'master-pass-1' }, ctx)
    await expectAppError(
      'saveGroup',
      { id: 'g1', name: 'X', kind: 'ssh', sortOrder: 0, parentId: 'ghost' },
      ctx,
      'NOT_FOUND',
    )
  })

  it('moveConnection 移入 / 移出分组', async () => {
    await call('setMasterPassword', { newPassword: 'master-pass-1' }, ctx)
    await call('saveGroup', { id: 'g1', name: 'Prod', kind: 'ssh', sortOrder: 0 }, ctx)
    await call('saveConnection', conn(), ctx)

    const moved = await call<SshConnection>('moveConnection', { id: 'c1', groupId: 'g1' }, ctx)
    expect(moved.groupId).toBe('g1')

    const out = await call<SshConnection>('moveConnection', { id: 'c1', groupId: null }, ctx)
    expect(out.groupId).toBeUndefined()
  })

  it('moveConnection 目标分组不存在抛 NOT_FOUND', async () => {
    await call('setMasterPassword', { newPassword: 'master-pass-1' }, ctx)
    await call('saveConnection', conn(), ctx)
    await expectAppError('moveConnection', { id: 'c1', groupId: 'ghost' }, ctx, 'NOT_FOUND')
  })

  it('deleteGroup 级联删子分组并清孤儿连接', async () => {
    await call('setMasterPassword', { newPassword: 'master-pass-1' }, ctx)
    await call('saveGroup', { id: 'g1', name: 'P', kind: 'ssh', sortOrder: 0 }, ctx)
    await call('saveGroup', { id: 'g2', name: 'S', kind: 'ssh', sortOrder: 0, parentId: 'g1' }, ctx)
    await call('saveConnection', conn({ groupId: 'g2' }), ctx)

    const result = await call<{ deletedGroups: string[]; affectedConnections: number }>(
      'deleteGroup',
      { id: 'g1' },
      ctx,
    )
    expect(result.deletedGroups.sort()).toEqual(['g1', 'g2'])
    expect(result.affectedConnections).toBe(1)

    const c = await call<SshConnection>('getConnection', { id: 'c1' }, ctx)
    expect(c.groupId).toBeUndefined()
  })

  it('deleteGroup 不存在抛 NOT_FOUND', async () => {
    await expectAppError('deleteGroup', { id: 'ghost' }, ctx, 'NOT_FOUND')
  })

  // ------------------------------------------------------------ 搜索

  it('search 命中并尊重 limit', async () => {
    await call('setMasterPassword', { newPassword: 'master-pass-1' }, ctx)
    await call('saveConnection', conn({ id: 'a', name: 'alpha' }), ctx)
    await call('saveConnection', conn({ id: 'b', name: 'beta' }), ctx)

    const hits = await call<SshConnection[]>('search', { keyword: 'alpha' }, ctx)
    expect(hits.map((h) => h.id)).toEqual(['a'])
    expect(hits[0]!.password).toBe('s3cret') // 命中结果中密码已解密
  })

  // ------------------------------------------------------------ 备份

  it('exportBackup 落盘 + importBackup 往返一致', async () => {
    await call('setMasterPassword', { newPassword: 'master-pass-1' }, ctx)
    await call('saveConnection', conn(), ctx)
    await call('saveGroup', { id: 'g1', name: 'Prod', kind: 'ssh', sortOrder: 0 }, ctx)

    const exported = await call<{ filePath: string; fileName: string; bytes: number; counts: Record<string, number> }>(
      'exportBackup',
      { passphrase: 'backup-pass-1' },
      ctx,
    )
    expect(exported.fileName).toMatch(/^\d{14}\.v1\.backup\.t1000\.enc$/)
    expect(exported.bytes).toBeGreaterThan(0)

    // 文件真的写到了 tmp 目录，且首行是 magic
    const onDisk = readFileSync(exported.filePath, 'utf8')
    expect(onDisk.startsWith('T1000_BACKUP')).toBe(true)

    // 先清空，再导入，验证往返
    await call('deleteConnection', { id: 'c1' }, ctx)
    await call('deleteGroup', { id: 'g1' }, ctx)
    expect(await call<unknown[]>('listConnections', {}, ctx)).toHaveLength(0)

    const result = await call<{ total: number; mode: string }>(
      'importBackup',
      { data: onDisk, passphrase: 'backup-pass-1', mode: 'replace' },
      ctx,
    )
    expect(result.total).toBeGreaterThan(0)

    const restored = await call<SshConnection>('getConnection', { id: 'c1' }, ctx)
    expect(restored.name).toBe('web-01')
    expect(restored.password).toBe('s3cret') // 解锁态，密码完整恢复
  })

  it('导入被篡改 magic 的备份抛 BAD_REQUEST', async () => {
    await call('setMasterPassword', { newPassword: 'master-pass-1' }, ctx)
    await call('saveConnection', conn(), ctx)

    const exported = await call<{ filePath: string }>('exportBackup', { passphrase: 'backup-pass-1' }, ctx)
    const tampered = readFileSync(exported.filePath, 'utf8').replace('T1000_BACKUP', 'EVIL_BACKUP')

    await expectAppError('importBackup', { data: tampered, passphrase: 'backup-pass-1' }, ctx, 'BAD_REQUEST')
  })

  it('导入版本号不支持的备份抛 BAD_REQUEST', async () => {
    await call('setMasterPassword', { newPassword: 'master-pass-1' }, ctx)
    await call('saveConnection', conn(), ctx)

    const exported = await call<{ filePath: string }>('exportBackup', { passphrase: 'backup-pass-1' }, ctx)
    const text = readFileSync(exported.filePath, 'utf8')
    const [, b64] = text.split('\n')
    const env = JSON.parse(Buffer.from(b64!.trim(), 'base64').toString('utf8'))
    env.version = 42
    const tampered = `T1000_BACKUP\n${Buffer.from(JSON.stringify(env)).toString('base64')}\n`

    const err = await expectAppError(
      'importBackup',
      { data: tampered, passphrase: 'backup-pass-1' },
      ctx,
      'BAD_REQUEST',
    )
    expect(err.message).toContain('版本')
  })

  it('备份口令错误导入抛 UNAUTHORIZED', async () => {
    await call('setMasterPassword', { newPassword: 'master-pass-1' }, ctx)
    await call('saveConnection', conn(), ctx)

    const exported = await call<{ filePath: string }>('exportBackup', { passphrase: 'backup-pass-1' }, ctx)
    const text = readFileSync(exported.filePath, 'utf8')

    await expectAppError('importBackup', { data: text, passphrase: 'wrong-pass' }, ctx, 'UNAUTHORIZED')
  })

  it('未解锁且未给口令时拒绝导出（不能导出明文备份）', async () => {
    await call('setMasterPassword', { newPassword: 'master-pass-1' }, ctx)
    await call('saveConnection', conn(), ctx)
    await call('lock', {}, ctx)

    await expectAppError('exportBackup', {}, ctx, 'UNAUTHORIZED')
  })

  /**
   * 新语义（task-12）：带口令的备份要先把敏感字段用**本机主密钥**解密、
   * 再用备份口令派生的字段密钥重加密，锁定态拿不到主密钥 → 只能明确报错。
   *
   * 安全含义：锁定状态不应能产出「可换机还原明文凭据」的备份 —— 那等于绕过主密码保护。
   */
  it('锁定时带口令导出会明确报错（并告知先解锁）', async () => {
    await call('setMasterPassword', { newPassword: 'master-pass-1' }, ctx)
    await call('saveConnection', conn(), ctx)
    await call('lock', {}, ctx)

    const err = await expectAppError(
      'exportBackup',
      { passphrase: 'backup-pass-1' },
      ctx,
      'UNAUTHORIZED',
    )
    expect(err.message).toContain('未解锁')
    expect(err.message).toContain('请先解锁')
  })

  it('已解锁时备份口令优先于主密码（信封用口令而不是主密钥）', async () => {
    await call('setMasterPassword', { newPassword: 'master-pass-1' }, ctx)
    await call('saveConnection', conn(), ctx)

    const exported = await call<{ bytes: number; filePath: string }>(
      'exportBackup',
      { passphrase: 'backup-pass-1' },
      ctx,
    )
    expect(exported.bytes).toBeGreaterThan(0)

    const raw = readFileSync(exported.filePath)
    // 备份口令能打开
    const parsed = parseBackup(raw, { passphrase: 'backup-pass-1' })
    expect(Object.keys(parsed.content.entities).length).toBeGreaterThan(0)
    // 主密码打不开 → 证明信封用的是备份口令，而不是本机主密钥
    expect(() => parseBackup(raw, { passphrase: 'master-pass-1' })).toThrow(BackupDecryptError)
  })

  // ------------------------------------------------------------ 锁定态写入

  it('锁定态下改名不会抹掉已保存的密码', async () => {
    await call('setMasterPassword', { newPassword: 'master-pass-1' }, ctx)
    await call('saveConnection', conn(), ctx)

    await call('lock', {}, ctx)
    const locked = await call<SshConnection>('getConnection', { id: 'c1' }, ctx)
    expect(locked.password).toBe(LOCKED_MASK)

    // 锁定态回存（密码是掩码）
    await call('saveConnection', { ...locked, name: 'renamed-while-locked' }, ctx)

    await call('unlock', { password: 'master-pass-1' }, ctx)
    const after = await call<SshConnection>('getConnection', { id: 'c1' }, ctx)
    expect(after.name).toBe('renamed-while-locked')
    expect(after.password).toBe('s3cret') // 密码没有被掩码覆盖
  })
})
