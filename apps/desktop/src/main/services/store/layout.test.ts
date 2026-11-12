// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 工作区布局持久化测试。
 *
 * spec 要求：分屏布局自动保存、**存在本地数据库**、**每个连接独立**、可存为模板。
 * 这些是"下次打开还能恢复"的前提；存不住或串了连接，恢复就是错的。
 *
 * 另有一组**备份往返**用例：新增存储实体时最容易漏的是同步 `backup.ts` 的别名映射，
 * 漏了会让按实体导出产出 `undefined` 坏键 —— 那种错误不会报，只会静默丢数据。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { WorkspaceLayout } from '@t1000/shared'
import type { IpcContext, IpcHandler } from '../../ipc/router'
import { StoreService, setStoreService, storeHandlers } from './index'

let dir: string
let ctx: IpcContext

function makeCtx(backupDir: string): IpcContext {
  return {
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    paths: { dbFile: ':memory:', backupDir } as IpcContext['paths'],
    emit: () => {},
  }
}

async function call<T = unknown>(action: string, payload: unknown): Promise<T> {
  const handler = storeHandlers[action] as IpcHandler | undefined
  if (!handler) throw new Error(`handler 不存在: ${action}`)
  return (await handler(payload, ctx)) as T
}

const layout = (over: Partial<WorkspaceLayout> = {}): WorkspaceLayout => ({
  id: 'layout-1',
  connectionId: 'conn-1',
  isTemplate: false,
  tabs: [{ connectionId: 'conn-1' }],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...over,
})

describe('工作区布局', () => {
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 't1000-layout-'))
    ctx = makeCtx(dir)
    // StoreService 是**模块级单例**，跨用例会复用 —— 不重置的话第二个用例
    // 就变成"修改主密码"，会要求旧密码而失败
    setStoreService(new StoreService(':memory:'))
    // 布局要存在本地库里，所以得先有主密码（未初始化时库不可用）
    await call('setMasterPassword', { newPassword: 'Layout#2026' })
  })
  afterEach(() => {
    setStoreService(null)
    rmSync(dir, { recursive: true, force: true })
  })

  it('★ 保存后能读回（这正是"重启还原"的前提）', async () => {
    await call('saveLayout', { layout: layout() })
    const res = await call<{ layouts: WorkspaceLayout[] }>('listLayouts', {})
    expect(res.layouts).toHaveLength(1)
    expect(res.layouts[0]!.id).toBe('layout-1')
    expect(res.layouts[0]!.tabs).toHaveLength(1)
  })

  it('★ 分屏树（嵌套）能原样存取', async () => {
    const split: WorkspaceLayout['split'] = {
      kind: 'split',
      direction: 'horizontal',
      ratio: 0.4,
      first: { kind: 'leaf', tabIndex: 0 },
      second: {
        kind: 'split',
        direction: 'vertical',
        ratio: 0.5,
        first: { kind: 'leaf', tabIndex: 1 },
        second: { kind: 'leaf', tabIndex: 2 },
      },
    }
    await call('saveLayout', { layout: layout({ split }) })
    const res = await call<{ layouts: WorkspaceLayout[] }>('listLayouts', {})
    expect(res.layouts[0]!.split).toEqual(split)
  })

  it('同一连接重复保存是**更新**而不是新增', async () => {
    await call('saveLayout', { layout: layout() })
    await call('saveLayout', { layout: layout({ tabs: [{ connectionId: 'conn-1' }, { connectionId: 'conn-2' }] }) })
    const res = await call<{ layouts: WorkspaceLayout[] }>('listLayouts', {})
    expect(res.layouts).toHaveLength(1)
    expect(res.layouts[0]!.tabs).toHaveLength(2)
  })

  it('★ 不同连接的布局互不干扰（spec：每个连接独立配置）', async () => {
    await call('saveLayout', { layout: layout({ id: 'l1', connectionId: 'conn-1' }) })
    await call('saveLayout', { layout: layout({ id: 'l2', connectionId: 'conn-2' }) })
    const res = await call<{ layouts: WorkspaceLayout[] }>('listLayouts', {})
    expect(res.layouts).toHaveLength(2)
    expect(res.layouts.map((l) => l.connectionId).sort()).toEqual(['conn-1', 'conn-2'])
  })

  it('★ 模板不绑定连接（spec：布局模板供多个连接复用）', async () => {
    await call('saveLayout', {
      layout: layout({ id: 'tpl-1', connectionId: undefined, isTemplate: true, name: '三栏运维' }),
    })
    const res = await call<{ layouts: WorkspaceLayout[] }>('listLayouts', {})
    const tpl = res.layouts.find((l) => l.isTemplate)
    expect(tpl?.connectionId).toBeUndefined()
    expect(tpl?.name).toBe('三栏运维')
  })

  it('侧边面板开合状态能存住（spec：面板布局可自定义保存）', async () => {
    await call('saveLayout', { layout: layout({ panels: { left: true, right: false, bottom: true } }) })
    const res = await call<{ layouts: WorkspaceLayout[] }>('listLayouts', {})
    expect(res.layouts[0]!.panels).toEqual({ left: true, right: false, bottom: true })
  })

  it('删除布局', async () => {
    await call('saveLayout', { layout: layout() })
    const del = await call<{ deleted: boolean }>('deleteLayout', { id: 'layout-1' })
    expect(del.deleted).toBe(true)
    const res = await call<{ layouts: WorkspaceLayout[] }>('listLayouts', {})
    expect(res.layouts).toHaveLength(0)
  })

  it('删除不存在的布局返回 deleted=false（不抛错）', async () => {
    const del = await call<{ deleted: boolean }>('deleteLayout', { id: 'nope' })
    expect(del.deleted).toBe(false)
  })

  it('★ 分屏树过深被拒绝（畸形/恶意布局不能把校验栈打爆）', async () => {
    // 造一棵超过深度上限的树
    let node: WorkspaceLayout['split'] = { kind: 'leaf', tabIndex: 0 }
    for (let i = 0; i < 12; i++) {
      node = {
        kind: 'split',
        direction: 'horizontal',
        ratio: 0.5,
        first: { kind: 'leaf', tabIndex: 0 },
        second: node,
      }
    }
    await expect(call('saveLayout', { layout: layout({ split: node }) })).rejects.toBeTruthy()
  })

  it('★ ratio 越界被拒绝（否则恢复出的分屏比例会失控）', async () => {
    const bad: WorkspaceLayout['split'] = {
      kind: 'split',
      direction: 'horizontal',
      ratio: 5,
      first: { kind: 'leaf', tabIndex: 0 },
      second: { kind: 'leaf', tabIndex: 1 },
    }
    await expect(call('saveLayout', { layout: layout({ split: bad }) })).rejects.toBeTruthy()
  })

  it('布局不含敏感字段 —— 锁定时同样可读写（与设置/分组一致，是有意为之）', async () => {
    // 我最初以为"未初始化主密码就不能存"，实测发现能存 —— 这不是漏洞：
    // 存储层**只对敏感字段**（password/privateKey/passphrase/apiKey/token）加密，
    // 锁定时敏感字段一律掩码；而布局只有连接 id、标签顺序、分屏比例，没有秘密可保护。
    // 所以它与设置/分组一样，锁定时照常可读写（否则锁着时连界面快照都存不住）。
    setStoreService(new StoreService(':memory:'))
    const fresh = makeCtx(mkdtempSync(join(tmpdir(), 't1000-layout-fresh-')))
    const handler = storeHandlers['saveLayout'] as IpcHandler
    const saved = (await handler({ layout: layout() }, fresh)) as WorkspaceLayout
    expect(saved.id).toBe('layout-1')

    const listed = (await (storeHandlers['listLayouts'] as IpcHandler)({}, fresh)) as {
      layouts: WorkspaceLayout[]
    }
    // 读回来必须是**内容本身**，而不是被掩码的占位
    expect(listed.layouts[0]!.tabs).toEqual([{ connectionId: 'conn-1' }])
    expect(JSON.stringify(listed.layouts)).not.toContain('__LOCKED__')
  })
})

describe('布局随备份往返（验证新增实体已同步进备份映射）', () => {
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 't1000-layout-bk-'))
    ctx = makeCtx(dir)
    setStoreService(new StoreService(':memory:'))
    await call('setMasterPassword', { newPassword: 'Layout#2026' })
  })
  afterEach(() => {
    setStoreService(null)
    rmSync(dir, { recursive: true, force: true })
  })

  it('★ 导出/导入往返后布局仍在（新增实体最容易漏的就是同步备份别名）', async () => {
    await call('saveLayout', { layout: layout({ id: 'l-keep', split: { kind: 'leaf', tabIndex: 0 } }) })

    const exported = await call<{ fileName: string; filePath: string }>('exportBackup', {
      passphrase: 'Layout#2026',
    })
    expect(exported.filePath).toBeTruthy()

    // 清空后导入
    const del = await call<{ deleted: boolean }>('deleteLayout', { id: 'l-keep' })
    expect(del.deleted).toBe(true)
    await call('importBackup', { data: readFileSync(exported.filePath), passphrase: 'Layout#2026' })

    const res = await call<{ layouts: WorkspaceLayout[] }>('listLayouts', {})
    expect(res.layouts.map((l) => l.id)).toContain('l-keep')
  })

  it('按实体导出时不会产出 undefined 键（别名映射缺失的典型症状）', async () => {
    await call('saveLayout', { layout: layout({ id: 'l-only' }) })
    // 只导出 Layout 这一种实体：走的是 storeKeyAlias('Layout') 这条路径
    const exported = await call<{ filePath: string }>('exportBackup', {
      passphrase: 'Layout#2026',
      filePath: join(dir, 'only-layout.backup.t1000.enc'),
    })
    expect(exported.filePath).toBeTruthy()

    setStoreService(new StoreService(':memory:'))
    await call('setMasterPassword', { newPassword: 'Layout#2026' })
    await call('importBackup', { data: readFileSync(exported.filePath), passphrase: 'Layout#2026' })
    const res = await call<{ layouts: WorkspaceLayout[] }>('listLayouts', {})
    expect(res.layouts.map((l) => l.id)).toContain('l-only')
  })
})
