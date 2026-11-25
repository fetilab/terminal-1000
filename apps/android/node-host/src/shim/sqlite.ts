// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * `better-sqlite3` 的 Android 替身 —— 用 Node 内置的 `node:sqlite` 实现。
 *
 * 为什么不在 Android 上重编译 better-sqlite3：
 * 它是一个带 V8 API（`node_api` / NAN）绑定的原生模块，Android 上没有预编译产物，
 * 必须用 NDK + 目标 Node 的 ABI 头文件交叉编译。这件事不仅麻烦，而且**极易在
 * 升级 Node 后静默失效**（ABI 不匹配的报错是 `NODE_MODULE_VERSION` 不一致或
 * `dlopen` 失败，真机上表现为"数据库打不开、连接列表空着"）。
 *
 * 而 Node 22+ 自带 `node:sqlite`（SQLite 官方 C 源码直接编进 runtime），
 * API 与 better-sqlite3 高度同构 —— 于是这里做一层薄适配：
 * **零原生编译、零 ABI 兼容问题、升级 Node 不用重新编译**。
 *
 * 覆盖范围严格按主进程实际用到的 API（见 `services/store/db.ts` 与
 * `services/store/legacy-import.ts`）：构造、`exec`、`prepare`（get/all/run）、
 * `pragma`、`transaction`、`close`。其它方法**故意不实现**：
 * 万一将来有人用到没适配的方法，让它直接抛错比返回一个语义不对的值更好排查。
 */

import { existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

/** `db.prepare(sql)` 返回值的形状（只保留主进程用到的部分） */
export interface ShimStatement {
  get(...params: unknown[]): unknown
  all(...params: unknown[]): unknown[]
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint }
}

/** `db.transaction(fn)` 的返回值：可调用，且带三种"立即执行"变体 */
export interface ShimTransaction<Args extends unknown[], R> {
  (...args: Args): R
  deferred(...args: Args): R
  immediate(...args: Args): R
  exclusive(...args: Args): R
}

export interface DatabaseOptions {
  readonly?: boolean
  fileMustExist?: boolean
  /** better-sqlite3 的 busy 超时（ms）。node:sqlite 没有直接选项，用 PRAGMA 补 */
  timeout?: number
  /** 主进程没用到，但调用点可能传（verbose 是调试输出），显式忽略 */
  verbose?: unknown
}

/**
 * better-sqlite3 的 `Database` 替身。
 *
 * 只实现被用到的子集；语义上有一处**刻意的差异**：
 * `pragma()` 的返回值统一成"行数组"或"首行对象"。better-sqlite3 是
 * 单行返回对象、多行返回数组，而主进程只对 `wal_checkpoint` 的返回值不做处理，
 * 其余 PRAGMA 都是纯设置 —— 所以这个差异不影响行为。
 */
export class Database {
  /** 底层 node:sqlite 句柄 */
  readonly #db: DatabaseSync
  #closed = false
  /** 事务嵌套深度：better-sqlite3 支持嵌套事务（内层退化为 SAVEPOINT） */
  #depth = 0

  constructor(file: string, options: DatabaseOptions = {}) {
    if (options.fileMustExist && file !== ':memory:') {
      // 与 better-sqlite3 一致：文件不存在直接抛，而不是默默建一个空库
      if (!existsSync(file)) {
        throw new Error(`数据库文件不存在：${file}`)
      }
    }
    this.#db = new DatabaseSync(file, { readOnly: options.readonly ?? false })
    if (typeof options.timeout === 'number' && options.timeout > 0) {
      this.#db.exec(`PRAGMA busy_timeout = ${Math.floor(options.timeout)}`)
    }
  }

  /** 执行一段 SQL（可以是多条语句）。与 better-sqlite3 同名同义。 */
  exec(sql: string): this {
    this.#db.exec(sql)
    return this
  }

  prepare(sql: string): ShimStatement {
    const stmt = this.#db.prepare(sql)
    return {
      get: (...params) => stmt.get(...(params as never[])) ?? undefined,
      all: (...params) => stmt.all(...(params as never[])) as unknown[],
      run: (...params) => {
        const r = stmt.run(...(params as never[]))
        return {
          changes: Number(r.changes),
          lastInsertRowid: r.lastInsertRowid as number | bigint,
        }
      },
    }
  }

  /**
   * PRAGMA 便捷方法。
   *
   * 含 `=` 的是"设置"（走 exec，无返回值）；
   * 其余按"查询"处理（可能返回多行，例如 `wal_checkpoint`）。
   * 查询失败时返回空数组而不是抛错 —— 与 better-sqlite3 对未知 pragma 的宽容一致。
   */
  pragma(source: string, _options?: { simple?: boolean }): unknown {
    if (source.includes('=')) {
      this.#db.exec(`PRAGMA ${source}`)
      return undefined
    }
    try {
      const rows = this.#db.prepare(`PRAGMA ${source}`).all() as unknown[]
      return rows.length === 1 ? rows[0] : rows
    } catch {
      return []
    }
  }

  /**
   * 把函数包成事务。
   *
   * 用 SAVEPOINT 而非 BEGIN：主进程会嵌套调用（`putMany` 在 `transaction` 里），
   * BEGIN 嵌套会直接报 "cannot start a transaction within a transaction"。
   */
  transaction<Args extends unknown[], R>(fn: (...args: Args) => R): ShimTransaction<Args, R> {
    const run = (...args: Args): R => {
      const name = `t1000_sp_${this.#depth}`
      this.#db.exec(`SAVEPOINT ${name}`)
      this.#depth++
      try {
        const out = fn(...args)
        this.#depth--
        this.#db.exec(`RELEASE ${name}`)
        return out
      } catch (err) {
        this.#depth--
        // 回滚到保存点并释放，否则连接会一直挂着一个未关闭的事务
        try {
          this.#db.exec(`ROLLBACK TO ${name}`)
          this.#db.exec(`RELEASE ${name}`)
        } catch {
          /* 回滚失败说明事务已不在，忽略 */
        }
        throw err
      }
    }
    // better-sqlite3 的三个变体在 node:sqlite 上语义差别只在加锁时机，
    // 单进程单连接场景下没有可观察差异 —— 统一走同一实现，保留方法名以免调用点报错
    return Object.assign(run, {
      deferred: run,
      immediate: run,
      exclusive: run,
    }) as ShimTransaction<Args, R>
  }

  /** 当前是否在事务中（主进程没用到，但备份逻辑将来可能查） */
  get inTransaction(): boolean {
    return this.#depth > 0
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    this.#db.close()
  }

  get open(): boolean {
    return !this.#closed
  }
}

export default Database
