// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * SQLite 封装层：连接、PRAGMA 调优、迁移、预编译语句缓存。
 *
 * 性能纪律（对应 docs/PERFORMANCE-GOALS.md §3「数据库」）
 * - **WAL** + `synchronous=NORMAL`：读不阻塞写，事务提交不必每次 fsync。
 * - **预编译语句在 open() 时一次性建好**并常驻缓存；所有读路径直接复用，
 *   绝不在每次调用里 `prepare()`（prepare 要走 SQL 解析+编译，是热路径的主要浪费）。
 * - 列表查询**只 SELECT 需要的列**（`item_id` / `updated_at` 等），
 *   需要整行时才取 `payload`，避免全表 JSON 反序列化。
 * - 批量写入用 `transaction()` 包裹（better-sqlite3 的事务是同步的，C++ 侧 BEGIN/COMMIT）。
 */

import Database from 'better-sqlite3'
import type { Database as SqliteDatabase, Statement } from 'better-sqlite3'

/** 实体后缀。store_key = `GeneralDatabaseLocalImp-<Entity>DatabaseLocalImp` */
export type StoreEntity =
  | 'Server'
  | 'Group'
  | 'Credential'
  | 'Settings'
  | 'AIChat'
  | 'Note'
  | 'NoteFolder'
  | 'SessionLog'

export const STORE_ENTITIES: readonly StoreEntity[] = [
  'Server',
  'Group',
  'Credential',
  'Settings',
  'AIChat',
  'Note',
  'NoteFolder',
  'SessionLog',
] as const

/** 拼出参考实现同构的 store_key */
export function storeKeyOf(entity: StoreEntity): string {
  return `GeneralDatabaseLocalImp-${entity}DatabaseLocalImp`
}

/** 各实体的 store_key 常量（避免调用点拼字符串拼错） */
export const STORE_KEYS = {
  server: storeKeyOf('Server'),
  group: storeKeyOf('Group'),
  credential: storeKeyOf('Credential'),
  settings: storeKeyOf('Settings'),
  aiChat: storeKeyOf('AIChat'),
  note: storeKeyOf('Note'),
  noteFolder: storeKeyOf('NoteFolder'),
  sessionLog: storeKeyOf('SessionLog'),
} as const

/** 元数据表里保存主密码校验记录、schema 版本等 */
export const META_KV_TABLE = 'store_meta'

export interface KvRow {
  store_key: string
  item_id: string
  payload: string
  updated_at: number
  created_at: number
}

/** 只取索引列的轻量行（不碰 payload，不反序列化） */
export interface KvIndexRow {
  item_id: string
  updated_at: number
  created_at: number
}

/** 预编译语句集合。字段名即用途，避免调用点写裸 SQL。 */
export interface Statements {
  /** 读一行完整 payload */
  selectOne: Statement<[string, string], KvRow>
  /** 只读索引列（列表用，不反序列化 payload） */
  selectIds: Statement<[string], KvIndexRow>
  /** 只读部分列：用于「按更新时间排序」的列表视图 */
  selectRecentIds: Statement<[string, number], KvIndexRow>
  /** 统计某实体条目数（分页与自检用） */
  countByKey: Statement<[string], { n: number }>
  /** upsert，保留原 created_at（冲突时用传入值覆盖 updated_at） */
  upsert: Statement<[string, string, string, number, number]>
  deleteOne: Statement<[string, string]>
  deleteByKey: Statement<[string]>
  /**
   * 服务端侧关键词粗筛：在 SQL 里先过滤掉明显不匹配的行，
   * 只把可能的候选行拉回来做 JSON 解析。避免全表反序列化。
   */
  searchPayload: Statement<[string, string, number], KvRow>
  /** 读取全部 payload（仅备份导出用） */
  selectAllPayload: Statement<[string], KvRow>
  /** 清空某实体（备份导入的替换语义用） */
  deleteAll: Statement<[]>
  countAll: Statement<[], { n: number }>
  selectMeta: Statement<[string], { value: string }>
  upsertMeta: Statement<[string, string]>
  deleteMeta: Statement<[string]>
}

/** 建表 SQL（幂等） */
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS local_store (
  store_key  TEXT    NOT NULL,
  item_id    TEXT    NOT NULL,
  payload    TEXT    NOT NULL,
  updated_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (store_key, item_id)
);
-- 列表按「最近更新」排序是高频路径，单独建索引避免全表排序
CREATE INDEX IF NOT EXISTS idx_local_store_updated
  ON local_store (store_key, updated_at DESC);

CREATE TABLE IF NOT EXISTS ${META_KV_TABLE} (
  key   TEXT NOT NULL PRIMARY KEY,
  value TEXT NOT NULL
);
`

/** 当前 schema 版本（将来加表/加列时递增并在 migrate 里做增量） */
export const SCHEMA_VERSION = 1

/**
 * store 的数据库句柄。
 *
 * 生命周期由调用方（services/store 的 StoreService）持有；测试里直接 new 一个
 * `:memory:` 实例即可，不依赖 Electron。
 */
export class StoreDb {
  readonly raw: SqliteDatabase
  readonly stmts: Statements
  /** 库文件路径；`:memory:` 表示内存库 */
  readonly file: string
  private closed = false

  constructor(file: string, options: { readonly?: boolean } = {}) {
    this.file = file
    this.raw = new Database(file, { readonly: options.readonly ?? false })

    this.applyPragmas()
    if (!options.readonly) {
      this.raw.exec(SCHEMA_SQL)
      this.migrate()
    }
    this.stmts = this.prepareStatements()
  }

  /**
   * 连接级 PRAGMA。注意：`:memory:` 库不支持 WAL（SQLite 会静默回落到 memory
   * journal），这里不报错——单测就是用内存库跑的。
   */
  private applyPragmas(): void {
    // WAL：读写并发，且写提交不必每事务 fsync（配合 synchronous=NORMAL）
    this.raw.pragma('journal_mode = WAL')
    this.raw.pragma('synchronous = NORMAL')
    // 外键：本项目用应用层维护关系（raw KV），但打开以防将来加关联表
    this.raw.pragma('foreign_keys = ON')
    // 内存库调优：临时表放内存，减少磁盘抖动
    this.raw.pragma('temp_store = MEMORY')
    // 忙等待：多窗口/多进程偶发争用时不要立刻 SQLITE_BUSY
    this.raw.pragma('busy_timeout = 5000')
    // 4 KiB 页（默认）即可；cache_size 负值 = KiB
    this.raw.pragma('cache_size = -16000')
  }

  private migrate(): void {
    const current = this.getMetaNumber('schema_version', 0)
    if (current >= SCHEMA_VERSION) return

    // v0 → v1：建表（SCHEMA_SQL 已幂等执行），只登记版本
    // 将来的增量迁移在这里按 current 分支追加。
    this.raw
      .prepare(`INSERT INTO ${META_KV_TABLE} (key, value) VALUES (?, ?)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
      .run('schema_version', String(SCHEMA_VERSION))
  }

  /** 迁移期用的一次性 prepare（此时 stmts 还没建好） */
  private getMetaNumber(key: string, fallback: number): number {
    const row = this.raw.prepare(`SELECT value FROM ${META_KV_TABLE} WHERE key = ?`).get(key) as
      | { value: string }
      | undefined
    if (!row) return fallback
    const n = Number.parseInt(row.value, 10)
    return Number.isFinite(n) ? n : fallback
  }

  /** 一次性把全部语句编译好并常驻（热路径零 prepare 开销） */
  private prepareStatements(): Statements {
    const raw = this.raw
    return {
      selectOne: raw.prepare(
        `SELECT store_key, item_id, payload, updated_at, created_at
           FROM local_store WHERE store_key = ? AND item_id = ?`,
      ) as Statement<[string, string], KvRow>,

      selectIds: raw.prepare(
        `SELECT item_id, updated_at, created_at
           FROM local_store WHERE store_key = ? ORDER BY updated_at DESC, item_id ASC`,
      ) as Statement<[string], KvIndexRow>,

      selectRecentIds: raw.prepare(
        `SELECT item_id, updated_at, created_at
           FROM local_store WHERE store_key = ? AND updated_at >= ?
           ORDER BY updated_at DESC LIMIT 200`,
      ) as Statement<[string, number], KvIndexRow>,

      countByKey: raw.prepare(
        `SELECT COUNT(*) AS n FROM local_store WHERE store_key = ?`,
      ) as Statement<[string], { n: number }>,

      // created_at 用 CASE 保住首次写入的时间戳，updated_at 每次覆盖
      upsert: raw.prepare(
        `INSERT INTO local_store (store_key, item_id, payload, updated_at, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(store_key, item_id) DO UPDATE SET
           payload    = excluded.payload,
           updated_at = excluded.updated_at,
           created_at = local_store.created_at`,
      ) as Statement<[string, string, string, number, number]>,

      deleteOne: raw.prepare(
        `DELETE FROM local_store WHERE store_key = ? AND item_id = ?`,
      ) as Statement<[string, string]>,

      deleteByKey: raw.prepare(`DELETE FROM local_store WHERE store_key = ?`) as Statement<[string]>,

      searchPayload: raw.prepare(
        `SELECT store_key, item_id, payload, updated_at, created_at
           FROM local_store
          WHERE store_key = ? AND payload LIKE ? COLLATE NOCASE
          ORDER BY updated_at DESC LIMIT ?`,
      ) as Statement<[string, string, number], KvRow>,

      selectAllPayload: raw.prepare(
        `SELECT store_key, item_id, payload, updated_at, created_at
           FROM local_store WHERE store_key = ? ORDER BY item_id ASC`,
      ) as Statement<[string], KvRow>,

      deleteAll: raw.prepare(`DELETE FROM local_store`) as Statement<[], unknown>,

      countAll: raw.prepare(`SELECT COUNT(*) AS n FROM local_store`) as Statement<[], { n: number }>,

      selectMeta: raw.prepare(
        `SELECT value FROM ${META_KV_TABLE} WHERE key = ?`,
      ) as Statement<[string], { value: string }>,

      upsertMeta: raw.prepare(
        `INSERT INTO ${META_KV_TABLE} (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      ) as Statement<[string, string]>,

      deleteMeta: raw.prepare(`DELETE FROM ${META_KV_TABLE} WHERE key = ?`) as Statement<[string]>,
    }
  }

  /** 读单行；不存在返回 undefined */
  get(storeKey: string, itemId: string): KvRow | undefined {
    return this.stmts.selectOne.get(storeKey, itemId)
  }

  /** 只读索引列（列表路径：不反序列化 payload） */
  listIds(storeKey: string): KvIndexRow[] {
    return this.stmts.selectIds.all(storeKey)
  }

  count(storeKey: string): number {
    return this.stmts.countByKey.get(storeKey)?.n ?? 0
  }

  /** 写入一行（upsert），created_at 已存在时保留原值 */
  put(storeKey: string, itemId: string, payload: string, now: number): void {
    this.stmts.upsert.run(storeKey, itemId, payload, now, now)
  }

  /**
   * 批量写入，单事务包裹。
   * 1000 条时比逐条 run 快一个数量级（省掉 1000 次隐式事务提交）。
   */
  putMany(rows: readonly { storeKey: string; itemId: string; payload: string }[], now: number): void {
    const upsert = this.stmts.upsert
    const tx = this.raw.transaction((items: readonly { storeKey: string; itemId: string; payload: string }[]) => {
      for (const item of items) {
        upsert.run(item.storeKey, item.itemId, item.payload, now, now)
      }
    })
    tx(rows)
  }

  /** 单事务执行任意写操作（导出/导入用） */
  transaction<T>(fn: () => T): T {
    return this.raw.transaction(fn)()
  }

  delete(storeKey: string, itemId: string): void {
    this.stmts.deleteOne.run(storeKey, itemId)
  }

  deleteAllOf(storeKey: string): void {
    this.stmts.deleteByKey.run(storeKey)
  }

  getMeta(key: string): string | undefined {
    return this.stmts.selectMeta.get(key)?.value
  }

  setMeta(key: string, value: string): void {
    this.stmts.upsertMeta.run(key, value)
  }

  /**
   * WAL 检查点：把 -wal 内容合并回主库文件。
   * 备份导出前调用，保证拷走的是完整数据。
   */
  checkpoint(): void {
    if (this.file === ':memory:') return
    try {
      this.raw.pragma('wal_checkpoint(TRUNCATE)')
    } catch {
      /* 只读库或非 WAL 模式下忽略 */
    }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.raw.close()
  }
}
