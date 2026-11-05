// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 实体仓储：连接 / 分组 / 凭证的 CRUD，以及分组树、搜索。
 *
 * 职责边界
 * - 只管「实体 ↔ KV 行」的映射与关系维护，不碰 IPC、不抛 IPC 层错误。
 * - 敏感字段的加密/掩码在这里统一处理（读时按需解密，写时按需加密）。
 */

import type { Connection, ConnectionGroup, Credential, ConnectionKind } from '@t1000/shared'
import { STORE_KEYS, type StoreDb, type KvRow } from './db'
import {
  ENCRYPTED_FIELD_NAMES,
  LOCKED_MASK,
  decryptWithKey,
  encryptWithKey,
  isCiphertext,
  isLockedMask,
} from './crypto'

/** 分组树节点 */
export interface GroupTreeNode extends ConnectionGroup {
  children: GroupTreeNode[]
  /** 直属该分组（不含子分组）的连接数 */
  connectionCount: number
}

/**
 * 需要加密的字段：
 * - 顶层 `password` / `privateKey` / `passphrase`
 * - 跳板链每一跳的同类字段（跳板密码同样是机密）
 * - 代理密码、AI 供应商 apiKey、同步 token
 * 递归扫描，保证不会漏掉嵌套结构。
 */
function isSensitiveKey(key: string): boolean {
  return ENCRYPTED_FIELD_NAMES.includes(key)
}

/** 已解锁时的密钥提供者；返回 null 表示锁定 */
export type KeyProvider = () => Buffer | null

export class Repository {
  private readonly db: StoreDb
  private readonly key: KeyProvider

  constructor(db: StoreDb, key: KeyProvider) {
    this.db = db
    this.key = key
  }

  // ---------------------------------------------------------------- 通用 KV

  /** 读原始行（未做任何加解密处理；db 层单测与调试用） */
  readRow(storeKey: string, itemId: string): KvRow | undefined {
    return this.db.get(storeKey, itemId)
  }

  /** 写原始行 */
  writeRow(storeKey: string, itemId: string, payload: unknown, now: number): void {
    this.db.put(storeKey, itemId, JSON.stringify(payload), now)
  }

  // ------------------------------------------------------------ 加解密核心

  /**
   * 把对象里的敏感字段加密（写路径）。
   * 已经是密文的原样保留——避免「读回密文再存一遍」造成二次加密。
   */
  private encryptSensitive(value: unknown, key: Buffer): unknown {
    if (value === null || typeof value !== 'object') return value

    if (Array.isArray(value)) {
      return value.map((item) => this.encryptSensitive(item, key))
    }

    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (isSensitiveKey(k) && typeof v === 'string' && v.length > 0) {
        // 空串视为「未设置」，不加密也不落密文
        out[k] = isCiphertext(v) ? v : encryptWithKey(key, v)
      } else if (isSensitiveKey(k) && isLockedMask(v)) {
        // 掩码是「渲染层没改过这个字段」的信号，绝不能把掩码当明文存下去
        continue
      } else {
        out[k] = this.encryptSensitive(v, key)
      }
    }
    return out
  }

  /**
   * 把对象里的敏感字段解密（读路径）。
   * - 已解锁：解密成功返回明文；解不开（密钥不对/数据损坏）降级为掩码，不抛。
   * - 未锁定但字段是明文（历史数据）：原样返回。
   */
  private decryptSensitive(value: unknown, key: Buffer | null): unknown {
    if (value === null || typeof value !== 'object') return value

    if (Array.isArray(value)) {
      return value.map((item) => this.decryptSensitive(item, key))
    }

    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (isSensitiveKey(k) && typeof v === 'string') {
        out[k] = this.decryptField(v, key)
      } else {
        out[k] = this.decryptSensitive(v, key)
      }
    }
    return out
  }

  /** 单字段解密；拿不到密钥或解不开 → 掩码 */
  private decryptField(value: string, key: Buffer | null): string {
    if (!isCiphertext(value)) {
      // 明文（可能是迁移来的历史数据）。锁定状态下一律掩码，避免泄漏。
      return key ? value : LOCKED_MASK
    }
    if (!key) return LOCKED_MASK
    try {
      return decryptWithKey(key, value)
    } catch {
      // GCM 认证失败：密钥不匹配或数据被篡改。降级为掩码而不是让整个列表挂掉。
      return LOCKED_MASK
    }
  }

  /** 反序列化 + 按需解密 */
  private hydrate<T>(row: KvRow): T {
    const parsed = JSON.parse(row.payload) as unknown
    return this.decryptSensitive(parsed, this.key()) as T
  }

  /** 序列化 + 按需加密 */
  private dehydrate(payload: unknown): string {
    const key = this.key()
    const value = key ? this.encryptSensitive(payload, key) : stripLockedMasks(payload)
    return JSON.stringify(value)
  }

  // ------------------------------------------------------------ 连接 CRUD

  /** 全部连接（列表路径：只取索引列 + 逐行反序列化，不解密无关字段） */
  listConnections(): Connection[] {
    const rows = this.db.listIds(STORE_KEYS.server)
    const out: Connection[] = []
    for (const idx of rows) {
      const row = this.db.get(STORE_KEYS.server, idx.item_id)
      if (!row) continue
      out.push(this.hydrate<Connection>(row))
    }
    return out
  }

  /** 单条连接；不存在返回 undefined */
  getConnection(id: string): Connection | undefined {
    const row = this.db.get(STORE_KEYS.server, id)
    return row ? this.hydrate<Connection>(row) : undefined
  }

  /**
   * 保存连接（新建或更新）。
   * - 新建：补 createdAt / updatedAt
   * - 更新：保留原 createdAt，刷新 updatedAt
   * - 已存在的密文字段在 payload 里仍是密文（hydrate 给的是明文，
   *   渲染层回存的是明文），这里统一重新加密
   */
  saveConnection(input: Connection, now: string): Connection {
    const existingRow = this.db.get(STORE_KEYS.server, input.id)
    const existing = existingRow ? (JSON.parse(existingRow.payload) as Partial<Connection>) : undefined

    const saved = {
      ...input,
      createdAt: existing?.createdAt ?? input.createdAt ?? now,
      updatedAt: now,
    } as Connection

    this.db.put(STORE_KEYS.server, saved.id, this.dehydrate(saved), Date.now())
    return this.hydrate<Connection>(this.db.get(STORE_KEYS.server, saved.id)!)
  }

  /** 删除连接；返回是否真的删掉了 */
  deleteConnection(id: string): boolean {
    const exists = this.db.get(STORE_KEYS.server, id) !== undefined
    if (exists) this.db.delete(STORE_KEYS.server, id)
    return exists
  }

  /**
   * 移动连接：改 groupId（传 undefined/null 视为移出分组）。
   * 只重写目标行，不触发全表写。
   */
  moveConnection(id: string, groupId: string | undefined, now: string): Connection | undefined {
    const current = this.getConnection(id)
    if (!current) return undefined

    const moved = { ...current, updatedAt: now } as Connection
    if (groupId === undefined) {
      delete (moved as { groupId?: string }).groupId
    } else {
      moved.groupId = groupId
    }
    this.db.put(STORE_KEYS.server, id, this.dehydrate(moved), Date.now())
    return this.hydrate<Connection>(this.db.get(STORE_KEYS.server, id)!)
  }

  // ------------------------------------------------------------ 分组 CRUD

  listGroups(): ConnectionGroup[] {
    const rows = this.db.listIds(STORE_KEYS.group)
    const out: ConnectionGroup[] = []
    for (const idx of rows) {
      const row = this.db.get(STORE_KEYS.group, idx.item_id)
      if (!row) continue
      out.push(this.hydrate<ConnectionGroup>(row))
    }
    return out
  }

  getGroup(id: string): ConnectionGroup | undefined {
    const row = this.db.get(STORE_KEYS.group, id)
    return row ? this.hydrate<ConnectionGroup>(row) : undefined
  }

  saveGroup(input: ConnectionGroup, now: string): ConnectionGroup {
    const existingRow = this.db.get(STORE_KEYS.group, input.id)
    const existing = existingRow ? (JSON.parse(existingRow.payload) as Partial<ConnectionGroup>) : undefined

    const saved: ConnectionGroup = {
      ...input,
      createdAt: existing?.createdAt ?? input.createdAt ?? now,
      updatedAt: now,
    }
    this.db.put(STORE_KEYS.group, saved.id, this.dehydrate(saved), Date.now())
    return this.hydrate<ConnectionGroup>(this.db.get(STORE_KEYS.group, saved.id)!)
  }

  /**
   * 删除分组。
   * `cascade=true`（默认）连子分组一起删，并把孤儿连接的 groupId 清掉；
   * `cascade=false` 时把子分组挂到被删分组的父级（提升一层）。
   */
  deleteGroup(id: string, cascade = true): { deletedGroups: string[]; affectedConnections: number } {
    const groups = this.listGroups()
    const target = groups.find((g) => g.id === id)
    if (!target) return { deletedGroups: [], affectedConnections: 0 }

    // 收集子树（广度优先，避免深递归爆栈）
    const toDelete = new Set<string>([id])
    if (cascade) {
      let frontier = [id]
      while (frontier.length > 0) {
        const next: string[] = []
        for (const g of groups) {
          if (g.parentId !== undefined && frontier.includes(g.parentId) && !toDelete.has(g.id)) {
            toDelete.add(g.id)
            next.push(g.id)
          }
        }
        frontier = next
      }
    }

    const affected = this.listConnections().filter(
      (c) => c.groupId !== undefined && toDelete.has(c.groupId),
    )

    const now = Date.now()
    this.db.transaction(() => {
      for (const gid of toDelete) {
        this.db.delete(STORE_KEYS.group, gid)
      }

      if (!cascade) {
        // 直接子分组提升到被删分组的父级
        for (const g of groups) {
          if (g.parentId === id && !toDelete.has(g.id)) {
            const reparented: ConnectionGroup = { ...g, updatedAt: new Date(now).toISOString() }
            delete (reparented as { parentId?: string }).parentId
            if (target.parentId !== undefined) reparented.parentId = target.parentId
            this.db.put(STORE_KEYS.group, g.id, this.dehydrate(reparented), now)
          }
        }
      }

      // 孤儿连接清掉 groupId（级联删除时；非级联时子分组已提升，但直属连接仍要清）
      for (const conn of affected) {
        const next = { ...conn, updatedAt: new Date(now).toISOString() } as Connection
        delete (next as { groupId?: string }).groupId
        this.db.put(STORE_KEYS.server, conn.id, this.dehydrate(next), now)
      }
    })

    return { deletedGroups: [...toDelete], affectedConnections: affected.length }
  }

  /**
   * 构建分组树。
   * 一次取全部分组 + 一次取全部连接的分组归属，在内存里组装（O(n)）。
   * 孤儿分组（parentId 指向不存在的组）挂到根，避免整棵树丢失。
   */
  buildGroupTree(): GroupTreeNode[] {
    const groups = this.listGroups()
    const nodes = new Map<string, GroupTreeNode>()
    for (const g of groups) {
      nodes.set(g.id, { ...g, children: [], connectionCount: 0 })
    }

    // 直属连接计数：只读索引列，为了拿 groupId 必须解析 payload，
    // 因此只走一次 listConnections 复用结果
    for (const conn of this.listConnections()) {
      if (conn.groupId === undefined) continue
      const node = nodes.get(conn.groupId)
      if (node) node.connectionCount += 1
    }

    const roots: GroupTreeNode[] = []
    for (const g of groups) {
      const node = nodes.get(g.id)!
      const parent = g.parentId === undefined ? undefined : nodes.get(g.parentId)
      if (parent) parent.children.push(node)
      else roots.push(node)
    }

    const bySort = (a: GroupTreeNode, b: GroupTreeNode): number =>
      a.sortOrder - b.sortOrder || a.name.localeCompare(b.name)

    const sortDeep = (list: GroupTreeNode[]): GroupTreeNode[] => {
      list.sort(bySort)
      for (const n of list) sortDeep(n.children)
      return list
    }
    return sortDeep(roots)
  }

  // ------------------------------------------------------------ 凭证 CRUD

  listCredentials(): Credential[] {
    const rows = this.db.listIds(STORE_KEYS.credential)
    const out: Credential[] = []
    for (const idx of rows) {
      const row = this.db.get(STORE_KEYS.credential, idx.item_id)
      if (!row) continue
      out.push(this.hydrate<Credential>(row))
    }
    return out
  }

  getCredential(id: string): Credential | undefined {
    const row = this.db.get(STORE_KEYS.credential, id)
    return row ? this.hydrate<Credential>(row) : undefined
  }

  saveCredential(input: Credential, now: string): Credential {
    const existingRow = this.db.get(STORE_KEYS.credential, input.id)
    const existing = existingRow ? (JSON.parse(existingRow.payload) as Partial<Credential>) : undefined
    const saved: Credential = {
      ...input,
      createdAt: existing?.createdAt ?? input.createdAt ?? now,
      updatedAt: now,
    }
    this.db.put(STORE_KEYS.credential, saved.id, this.dehydrate(saved), Date.now())
    return this.hydrate<Credential>(this.db.get(STORE_KEYS.credential, saved.id)!)
  }

  // ---------------------------------------------------------------- 搜索

  /**
   * 关键词搜索。
   *
   * 两阶段：先在 SQL 里用 LIKE 粗筛（不反序列化不匹配的行），再对候选行做
   * 结构化匹配。1000 条连接时这一层能把 JSON.parse 次数从 O(n) 降到 O(hits)。
   *
   * 注意：payload 里密码是密文，搜索**不会**匹配到密码明文——
   * 这既是性能设计也是安全特性。
   */
  search(keyword: string, limit = 100): Connection[] {
    const trimmed = keyword.trim()
    if (trimmed.length === 0) return []

    const pattern = `%${escapeLike(trimmed)}%`
    const rows = this.db.stmts.searchPayload.all(STORE_KEYS.server, pattern, limit)

    const lower = trimmed.toLowerCase()
    const out: Connection[] = []
    for (const row of rows) {
      const conn = this.hydrate<Connection>(row)
      if (matchesConnection(conn, lower)) out.push(conn)
    }
    return out
  }

  // ------------------------------------------------------------ 密文轮换

  /**
   * 用新密钥重新加密所有密文字段（改主密码时调用）。
   *
   * 必须在**已持有旧密钥**的前提下调用：先解密出明文，再用新密钥加密。
   * 整体放在一个事务里，失败则全部回滚，不会出现半新半旧的密文。
   *
   * @returns 重新加密的行数
   */
  reencryptAll(oldKey: Buffer, newKey: Buffer): number {
    const entities = [STORE_KEYS.server, STORE_KEYS.group, STORE_KEYS.credential, STORE_KEYS.settings, STORE_KEYS.aiChat]
    let touched = 0

    this.db.transaction(() => {
      for (const storeKey of entities) {
        const rows = this.db.stmts.selectAllPayload.all(storeKey)
        for (const row of rows) {
          const parsed = JSON.parse(row.payload) as unknown
          if (!hasCiphertext(parsed)) continue

          // 旧密钥解密（此时 key provider 可能已切换，所以显式传旧密钥）
          const plain = this.decryptSensitiveWith(parsed, oldKey)
          const reencrypted = this.encryptSensitive(plain, newKey)
          this.db.put(storeKey, row.item_id, JSON.stringify(reencrypted), row.updated_at)
          touched += 1
        }
      }
    })

    return touched
  }

  /** 与 decryptSensitive 同逻辑，但显式指定密钥（轮换用） */
  private decryptSensitiveWith(value: unknown, key: Buffer): unknown {
    if (value === null || typeof value !== 'object') return value
    if (Array.isArray(value)) return value.map((item) => this.decryptSensitiveWith(item, key))

    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (isSensitiveKey(k) && typeof v === 'string' && isCiphertext(v)) {
        out[k] = decryptWithKey(key, v)
      } else {
        out[k] = this.decryptSensitiveWith(v, key)
      }
    }
    return out
  }
}

/** 递归判断对象里有没有密文（决定是否需要轮换） */
function hasCiphertext(value: unknown): boolean {
  if (typeof value === 'string') return isCiphertext(value)
  if (value === null || typeof value !== 'object') return false
  if (Array.isArray(value)) return value.some(hasCiphertext)
  return Object.values(value as Record<string, unknown>).some(hasCiphertext)
}

/**
 * 未解锁时写回：把掩码字段整个丢掉，避免把 `__LOCKED__` 当密码存进库。
 * （锁定态下渲染层理论上不该提交写操作，这里是防御性兜底。）
 */
function stripLockedMasks(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(stripLockedMasks)

  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (isSensitiveKey(k) && isLockedMask(v)) continue
    out[k] = stripLockedMasks(v)
  }
  return out
}

/**
 * 结构化匹配：名称 / 主机 / 用户名 / 备注。
 *
 * `Connection` 是五态联合，`TunnelConnection` 没有 host，`TelnetConnection`
 * 的 username 是可选的——所以统一走可选访问器，不能直接 `conn.host`。
 */
function matchesConnection(conn: Connection, lower: string): boolean {
  const haystack: string[] = [conn.id, conn.name]

  const maybeHost = (conn as { host?: unknown }).host
  if (typeof maybeHost === 'string') haystack.push(maybeHost)

  const maybeUsername = (conn as { username?: unknown }).username
  if (typeof maybeUsername === 'string') haystack.push(maybeUsername)

  const maybeNote = (conn as { note?: unknown }).note
  if (typeof maybeNote === 'string') haystack.push(maybeNote)

  for (const field of haystack) {
    if (field.toLowerCase().includes(lower)) return true
  }
  return false
}

/** 转义 LIKE 通配符，避免用户输入的 % 变成全表扫描 */
function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, (ch) => `\\${ch}`)
}

/** 分组种类推断辅助（UI 建组时用） */
export function groupKindFor(kinds: readonly ConnectionKind[]): ConnectionKind | 'mixed' {
  const unique = new Set(kinds)
  if (unique.size === 0) return 'mixed'
  const first = [...unique][0]
  return unique.size === 1 && first !== undefined ? first : 'mixed'
}
