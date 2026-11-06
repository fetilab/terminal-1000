// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 仓储层单测：连接/分组/凭证 CRUD、分组树、搜索、加密字段的读写与掩码。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Connection, ConnectionGroup, Credential, SshConnection } from '@t1000/shared'
import { StoreDb, STORE_KEYS } from './db'
import { Repository } from './repository'
import { LOCKED_MASK, Vault, deriveKey, isCiphertext } from './crypto'

const NOW = '2026-11-05T10:00:00.000Z'
const LATER = '2026-11-05T11:00:00.000Z'

function sshConn(over: Partial<SshConnection> = {}): SshConnection {
  return {
    kind: 'ssh',
    id: 'c1',
    name: 'web-01',
    host: '10.0.0.1',
    port: 22,
    username: 'root',
    authType: 'password',
    password: 's3cret',
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  }
}

/** 构造一个已解锁的 vault（用固定密钥，单测无需真实 KDF 开销） */
function unlockedVault(): Vault {
  const v = new Vault()
  v.unlockWithKey(deriveKey('test-master-password', Buffer.alloc(16, 7)))
  return v
}

describe('Repository（已解锁）', () => {
  let db: StoreDb
  let vault: Vault
  let repo: Repository

  beforeEach(() => {
    db = new StoreDb(':memory:')
    vault = unlockedVault()
    repo = new Repository(db, () => vault.currentKey())
  })

  afterEach(() => {
    db.close()
  })

  // ----------------------------------------------------------- 连接 CRUD

  it('保存并读回连接', () => {
    const saved = repo.saveConnection(sshConn(), NOW)
    expect(saved.id).toBe('c1')

    const got = repo.getConnection('c1') as SshConnection
    expect(got).toBeDefined()
    expect(got.name).toBe('web-01')
    expect(got.host).toBe('10.0.0.1')
    // 已解锁：密码读回是明文
    expect(got.password).toBe('s3cret')
  })

  it('getConnection 对不存在的 id 返回 undefined', () => {
    expect(repo.getConnection('nope')).toBeUndefined()
  })

  it('listConnections 返回全部连接', () => {
    repo.saveConnection(sshConn({ id: 'a', name: 'A', host: 'h1', createdAt: NOW, updatedAt: NOW }), NOW)
    repo.saveConnection(sshConn({ id: 'b', name: 'B', host: 'h2', createdAt: NOW, updatedAt: NOW }), NOW)
    expect(repo.listConnections().map((c) => c.id).sort()).toEqual(['a', 'b'])
  })

  it('保存时补 createdAt / updatedAt（新建）', () => {
    const saved = repo.saveConnection(sshConn({ createdAt: '', updatedAt: '' }), NOW)
    expect(saved.createdAt).toBe(NOW)
    expect(saved.updatedAt).toBe(NOW)
  })

  it('更新时保留原 createdAt，刷新 updatedAt', () => {
    const first = repo.saveConnection(sshConn(), NOW)
    expect(first.createdAt).toBe(NOW)

    const second = repo.saveConnection({ ...sshConn({ name: 'web-01-renamed' }), createdAt: NOW }, LATER)
    expect(second.createdAt).toBe(NOW) // 首次创建时间被保住
    expect(second.updatedAt).toBe(LATER) // 更新时间被刷新
    expect(second.name).toBe('web-01-renamed')
  })

  it('更新不会丢密文之外的字段', () => {
    repo.saveConnection(sshConn({ note: 'prod server', port: 2222 }), NOW)
    const got = repo.getConnection('c1') as SshConnection
    expect(got.note).toBe('prod server')
    expect(got.port).toBe(2222)
  })

  it('删除连接返回 true；重复删返回 false', () => {
    repo.saveConnection(sshConn(), NOW)
    expect(repo.deleteConnection('c1')).toBe(true)
    expect(repo.deleteConnection('c1')).toBe(false)
    expect(repo.getConnection('c1')).toBeUndefined()
  })

  it('moveConnection 改 groupId；传 undefined 移出分组', () => {
    repo.saveGroup({ id: 'g1', name: 'Prod', kind: 'ssh', sortOrder: 0, createdAt: NOW, updatedAt: NOW }, NOW)
    repo.saveConnection(sshConn(), NOW)

    const moved = repo.moveConnection('c1', 'g1', LATER)
    expect(moved!.groupId).toBe('g1')
    expect(moved!.updatedAt).toBe(LATER)

    const unmoved = repo.moveConnection('c1', undefined, LATER)
    expect(unmoved!.groupId).toBeUndefined()
  })

  it('moveConnection 对不存在的连接返回 undefined', () => {
    expect(repo.moveConnection('nope', 'g1', LATER)).toBeUndefined()
  })

  // ----------------------------------------------------------- 加密字段

  it('密码在库里以密文存储，读回是明文', () => {
    repo.saveConnection(sshConn(), NOW)

    // 直接看原始行：payload 里必须是 v1: 密文，不能有明文
    const raw = repo.readRow(STORE_KEYS.server, 'c1')!
    expect(raw.payload).not.toContain('s3cret')
    expect(isCiphertext((JSON.parse(raw.payload) as { password: string }).password)).toBe(true)

    expect((repo.getConnection('c1') as SshConnection).password).toBe('s3cret')
  })

  it('嵌套的跳板链密码也加密', () => {
    repo.saveConnection(
      sshConn({
        jumpChain: [
          { id: 'j1', host: 'bastion', port: 22, username: 'jump', authType: 'password', password: 'jump-pass' },
        ],
      }),
      NOW,
    )

    const raw = repo.readRow(STORE_KEYS.server, 'c1')!
    expect(raw.payload).not.toContain('jump-pass')

    const got = repo.getConnection('c1') as SshConnection
    expect(got.jumpChain![0]!.password).toBe('jump-pass')
  })

  it('非敏感字段保持明文可读（便于 SQL 粗筛）', () => {
    repo.saveConnection(sshConn(), NOW)
    const raw = repo.readRow(STORE_KEYS.server, 'c1')!
    expect(raw.payload).toContain('web-01')
    expect(raw.payload).toContain('10.0.0.1')
  })

  it('二次保存不会把已经加密的密文再加密一遍', () => {
    const first = repo.saveConnection(sshConn(), NOW)
    repo.saveConnection(first, LATER)
    // 明文仍然能正确读回，说明没有套娃加密
    expect((repo.getConnection('c1') as SshConnection).password).toBe('s3cret')
  })

  it('空字符串密码不加密（视为未设置）', () => {
    repo.saveConnection(sshConn({ password: '' }), NOW)
    const raw = repo.readRow(STORE_KEYS.server, 'c1')!
    expect((JSON.parse(raw.payload) as { password: string }).password).toBe('')
  })

  // --------------------------------------------------------------- 分组

  it('保存并列出分组', () => {
    repo.saveGroup({ id: 'g1', name: 'Prod', kind: 'ssh', sortOrder: 1, createdAt: NOW, updatedAt: NOW }, NOW)
    repo.saveGroup({ id: 'g2', name: 'Dev', kind: 'ssh', sortOrder: 0, createdAt: NOW, updatedAt: NOW }, NOW)

    const groups = repo.listGroups()
    expect(groups).toHaveLength(2)
    expect(repo.getGroup('g1')!.name).toBe('Prod')
  })

  it('分组保存同样维护时间戳', () => {
    repo.saveGroup({ id: 'g1', name: 'Prod', kind: 'ssh', sortOrder: 0, createdAt: NOW, updatedAt: NOW }, NOW)
    const updated = repo.saveGroup(
      { id: 'g1', name: 'Prod2', kind: 'ssh', sortOrder: 0, createdAt: NOW, updatedAt: NOW },
      LATER,
    )
    expect(updated.createdAt).toBe(NOW)
    expect(updated.updatedAt).toBe(LATER)
  })

  // ------------------------------------------------------------- 分组树

  it('分组树按 parentId 组装多级结构，并按 sortOrder 排序', () => {
    const mk = (id: string, name: string, sortOrder: number, parentId?: string): ConnectionGroup => ({
      id,
      name,
      kind: 'ssh',
      sortOrder,
      createdAt: NOW,
      updatedAt: NOW,
      ...(parentId === undefined ? {} : { parentId }),
    })

    repo.saveGroup(mk('root-b', 'RootB', 1), NOW)
    repo.saveGroup(mk('root-a', 'RootA', 0), NOW)
    repo.saveGroup(mk('child', 'Child', 0, 'root-a'), NOW)
    repo.saveGroup(mk('grandchild', 'Grand', 0, 'child'), NOW)

    const tree = repo.buildGroupTree()
    expect(tree.map((n) => n.id)).toEqual(['root-a', 'root-b'])
    expect(tree[0]!.children.map((n) => n.id)).toEqual(['child'])
    expect(tree[0]!.children[0]!.children.map((n) => n.id)).toEqual(['grandchild'])
  })

  it('分组树统计直属连接数（不含子分组）', () => {
    repo.saveGroup({ id: 'g1', name: 'G1', kind: 'ssh', sortOrder: 0, createdAt: NOW, updatedAt: NOW }, NOW)
    repo.saveGroup({ id: 'g2', name: 'G2', kind: 'ssh', sortOrder: 1, parentId: 'g1', createdAt: NOW, updatedAt: NOW }, NOW)

    repo.saveConnection(sshConn({ id: 'a', groupId: 'g1', createdAt: NOW, updatedAt: NOW }), NOW)
    repo.saveConnection(sshConn({ id: 'b', groupId: 'g1', createdAt: NOW, updatedAt: NOW }), NOW)
    repo.saveConnection(sshConn({ id: 'c', groupId: 'g2', createdAt: NOW, updatedAt: NOW }), NOW)

    const tree = repo.buildGroupTree()
    expect(tree[0]!.connectionCount).toBe(2) // 只算直属
    expect(tree[0]!.children[0]!.connectionCount).toBe(1)
  })

  it('孤儿分组（parentId 指向不存在）挂到根，不丢节点', () => {
    repo.saveGroup(
      { id: 'orphan', name: 'Orphan', kind: 'ssh', sortOrder: 0, parentId: 'ghost', createdAt: NOW, updatedAt: NOW },
      NOW,
    )
    const tree = repo.buildGroupTree()
    expect(tree.map((n) => n.id)).toContain('orphan')
  })

  it('空库返回空树', () => {
    expect(repo.buildGroupTree()).toEqual([])
  })

  // ---------------------------------------------------------------- 删除

  it('deleteGroup 级联删除子分组，并清掉孤儿连接的 groupId', () => {
    repo.saveGroup({ id: 'g1', name: 'G1', kind: 'ssh', sortOrder: 0, createdAt: NOW, updatedAt: NOW }, NOW)
    repo.saveGroup({ id: 'g2', name: 'G2', kind: 'ssh', sortOrder: 0, parentId: 'g1', createdAt: NOW, updatedAt: NOW }, NOW)
    repo.saveConnection(sshConn({ id: 'a', groupId: 'g2', createdAt: NOW, updatedAt: NOW }), NOW)

    const result = repo.deleteGroup('g1', true)
    expect(result.deletedGroups.sort()).toEqual(['g1', 'g2'])
    expect(result.affectedConnections).toBe(1)

    expect(repo.getGroup('g1')).toBeUndefined()
    expect(repo.getGroup('g2')).toBeUndefined()
    expect(repo.getConnection('a')!.groupId).toBeUndefined()
  })

  it('deleteGroup 非级联时把子分组提升到父级', () => {
    repo.saveGroup({ id: 'top', name: 'Top', kind: 'ssh', sortOrder: 0, createdAt: NOW, updatedAt: NOW }, NOW)
    repo.saveGroup({ id: 'mid', name: 'Mid', kind: 'ssh', sortOrder: 0, parentId: 'top', createdAt: NOW, updatedAt: NOW }, NOW)
    repo.saveGroup({ id: 'leaf', name: 'Leaf', kind: 'ssh', sortOrder: 0, parentId: 'mid', createdAt: NOW, updatedAt: NOW }, NOW)

    const result = repo.deleteGroup('mid', false)
    expect(result.deletedGroups).toEqual(['mid'])
    // leaf 被提升到 top
    expect(repo.getGroup('leaf')!.parentId).toBe('top')
  })

  it('deleteGroup 对不存在的分组返回空结果', () => {
    expect(repo.deleteGroup('nope').deletedGroups).toEqual([])
  })

  // --------------------------------------------------------------- 凭证

  it('凭证 CRUD 且 password / privateKey / passphrase 加密', () => {
    const cred: Credential = {
      id: 'cred1',
      name: 'deploy-key',
      username: 'deploy',
      password: 'cred-pass',
      privateKey: '-----BEGIN KEY-----\nxyz\n-----END KEY-----',
      passphrase: 'key-pass',
      createdAt: NOW,
      updatedAt: NOW,
    }
    repo.saveCredential(cred, NOW)

    const raw = repo.readRow(STORE_KEYS.credential, 'cred1')!
    expect(raw.payload).not.toContain('cred-pass')
    expect(raw.payload).not.toContain('key-pass')
    expect(raw.payload).not.toContain('BEGIN KEY')

    const got = repo.getCredential('cred1')!
    expect(got.password).toBe('cred-pass')
    expect(got.passphrase).toBe('key-pass')
    expect(got.username).toBe('deploy') // 用户名不加密
  })

  it('凭证列表与时间戳维护', () => {
    repo.saveCredential({ id: 'c1', name: 'n', createdAt: NOW, updatedAt: NOW }, NOW)
    repo.saveCredential({ id: 'c2', name: 'n2', createdAt: NOW, updatedAt: NOW }, NOW)
    expect(repo.listCredentials()).toHaveLength(2)

    const updated = repo.saveCredential({ id: 'c1', name: 'n-renamed', createdAt: NOW, updatedAt: NOW }, LATER)
    expect(updated.createdAt).toBe(NOW)
    expect(updated.updatedAt).toBe(LATER)
  })

  // --------------------------------------------------------------- 搜索

  it('搜索命中名称 / 主机 / 用户名 / 备注', () => {
    repo.saveConnection(sshConn({ id: 'a', name: 'alpha', host: 'alpha.example.com' }), NOW)
    repo.saveConnection(sshConn({ id: 'b', name: 'beta', host: 'beta.example.com' }), NOW)

    expect(repo.search('alpha').map((c) => c.id)).toEqual(['a'])
    expect(repo.search('example.com').map((c) => c.id).sort()).toEqual(['a', 'b'])
    expect(repo.search('root').map((c) => c.id).sort()).toEqual(['a', 'b']) // username
    expect(repo.search('nothing-matches')).toEqual([])
  })

  it('搜索大小写不敏感', () => {
    repo.saveConnection(sshConn({ id: 'a', name: 'AlphaServer' }), NOW)
    expect(repo.search('alphaserver').map((c) => c.id)).toEqual(['a'])
    expect(repo.search('ALPHASERVER').map((c) => c.id)).toEqual(['a'])
  })

  it('搜索空串返回空数组（不返回全表）', () => {
    repo.saveConnection(sshConn(), NOW)
    expect(repo.search('')).toEqual([])
    expect(repo.search('   ')).toEqual([])
  })

  it('搜索不会匹配到加密字段的明文（安全特性）', () => {
    repo.saveConnection(sshConn({ password: 'topsecretvalue' }), NOW)
    expect(repo.search('topsecretvalue')).toEqual([])
  })

  it('搜索命中结果里的密码已解密', () => {
    repo.saveConnection(sshConn({ name: 'findme' }), NOW)
    const hit = repo.search('findme')[0] as SshConnection
    expect(hit.password).toBe('s3cret')
  })

  it('搜索尊重 limit', () => {
    for (let i = 0; i < 10; i += 1) {
      repo.saveConnection(sshConn({ id: `c${i}`, name: `match-${i}` }), NOW)
    }
    expect(repo.search('match', 3)).toHaveLength(3)
  })

  it('LIKE 通配符被转义（输入 % 不会变成全表匹配）', () => {
    repo.saveConnection(sshConn({ id: 'a', name: 'percent' }), NOW)
    expect(repo.search('%')).toEqual([])
  })
})

describe('Repository（锁定态）', () => {
  let db: StoreDb
  let vault: Vault
  let repo: Repository

  beforeEach(() => {
    db = new StoreDb(':memory:')
    vault = unlockedVault()
    repo = new Repository(db, () => vault.currentKey())
    repo.saveConnection(sshConn(), NOW)
    // 写入之后锁定
    vault.lock()
  })

  afterEach(() => {
    db.close()
  })

  it('锁定后加密字段读作掩码，而不是抛错', () => {
    const got = repo.getConnection('c1') as SshConnection
    expect(got.password).toBe(LOCKED_MASK)
    // 非敏感字段仍然可读——列表页因此能正常渲染
    expect(got.name).toBe('web-01')
    expect(got.host).toBe('10.0.0.1')
  })

  it('锁定后 listConnections 也能正常返回（只是密码被掩码）', () => {
    const list = repo.listConnections()
    expect(list).toHaveLength(1)
    expect((list[0] as SshConnection).password).toBe(LOCKED_MASK)
  })

  it('锁定后嵌套跳板密码也是掩码', () => {
    vault.unlockWithKey(deriveKey('test-master-password', Buffer.alloc(16, 7)))
    repo.saveConnection(
      sshConn({
        jumpChain: [{ id: 'j1', host: 'b', port: 22, username: 'j', authType: 'password', password: 'jp' }],
      }),
      NOW,
    )
    vault.lock()

    const got = repo.getConnection('c1') as SshConnection
    expect(got.jumpChain![0]!.password).toBe(LOCKED_MASK)
  })

  it('重新解锁后能读回原始明文（锁定/解锁往返）', () => {
    expect((repo.getConnection('c1') as SshConnection).password).toBe(LOCKED_MASK)

    vault.unlockWithKey(deriveKey('test-master-password', Buffer.alloc(16, 7)))
    expect((repo.getConnection('c1') as SshConnection).password).toBe('s3cret')
  })

  it('锁定态下写入不会把掩码存进库', () => {
    const locked = repo.getConnection('c1') as SshConnection
    expect(locked.password).toBe(LOCKED_MASK)

    // 模拟渲染层在锁定态回存（防御性：掩码必须被丢弃，而不是当明文写进去）
    repo.saveConnection({ ...locked, name: 'renamed' }, LATER)

    const raw = repo.readRow(STORE_KEYS.server, 'c1')!
    expect(raw.payload).not.toContain(LOCKED_MASK)

    // 重新解锁后原密码仍在
    vault.unlockWithKey(deriveKey('test-master-password', Buffer.alloc(16, 7)))
    const again = repo.getConnection('c1') as SshConnection
    expect(again.name).toBe('renamed')
    expect(again.password).toBe('s3cret')
  })

  it('密钥不匹配时解密失败降级为掩码，不让整个列表挂掉', () => {
    const other = new Vault()
    other.unlockWithKey(deriveKey('a-totally-different-password', Buffer.alloc(16, 9)))
    const wrongRepo = new Repository(db, () => other.currentKey())

    const got = wrongRepo.getConnection('c1') as SshConnection
    expect(got.password).toBe(LOCKED_MASK) // 降级而非抛错
    expect(got.name).toBe('web-01')
  })
})

describe('Repository 密钥轮换（reencryptAll）', () => {
  let db: StoreDb
  let vault: Vault
  let repo: Repository

  const oldKey = deriveKey('old-master', Buffer.alloc(16, 1))
  const newKey = deriveKey('new-master', Buffer.alloc(16, 2))

  beforeEach(() => {
    db = new StoreDb(':memory:')
    vault = new Vault()
    vault.unlockWithKey(oldKey)
    repo = new Repository(db, () => vault.currentKey())
  })

  afterEach(() => {
    db.close()
  })

  it('轮换后旧密钥解不开、新密钥能解开全部密文字段', () => {
    repo.saveConnection(sshConn({ password: 'conn-pass' }), NOW)
    repo.saveCredential(
      { id: 'cred1', name: 'k', password: 'cred-pass', passphrase: 'pp', createdAt: NOW, updatedAt: NOW },
      NOW,
    )

    const count = repo.reencryptAll(oldKey, newKey)
    expect(count).toBe(2) // 连接 + 凭证

    // 切到新密钥
    vault.unlockWithKey(newKey)
    expect((repo.getConnection('c1') as SshConnection).password).toBe('conn-pass')
    expect(repo.getCredential('cred1')!.password).toBe('cred-pass')
    expect(repo.getCredential('cred1')!.passphrase).toBe('pp')
  })

  it('用旧密钥读轮换后的数据会降级为掩码', () => {
    repo.saveConnection(sshConn({ password: 'conn-pass' }), NOW)
    repo.reencryptAll(oldKey, newKey)

    vault.unlockWithKey(oldKey)
    expect((repo.getConnection('c1') as SshConnection).password).toBe(LOCKED_MASK)
  })

  it('没有密文的库轮换返回 0', () => {
    repo.saveConnection(sshConn({ password: undefined }), NOW)
    expect(repo.reencryptAll(oldKey, newKey)).toBe(0)
  })

  it('轮换不会改动非敏感字段与时间戳', () => {
    repo.saveConnection(sshConn({ note: 'keep-me' }), NOW)
    const before = repo.readRow(STORE_KEYS.server, 'c1')!

    repo.reencryptAll(oldKey, newKey)

    const after = repo.readRow(STORE_KEYS.server, 'c1')!
    expect(after.updated_at).toBe(before.updated_at)
    expect(after.created_at).toBe(before.created_at)
    vault.unlockWithKey(newKey)
    expect((repo.getConnection('c1') as SshConnection).note).toBe('keep-me')
  })
})
