// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 快速命令的**本地库**持久化（store 层）。
 *
 * 为什么单独一个文件：`db.ts` / `repository.ts` 正被别的任务编辑，
 * 这里只**新增**，不改动它们 —— 用 StoreDb 已有的泛型 KV 能力就够了。
 *
 * 加密：命令正文里可能写密码（`mysqldump -p...`），所以整条记录 JSON
 * 走 store 的字段加密路径（`StoreService.sealValue`）。
 * - 已设主密码且已解锁 → 落库为 `v1:` 前缀的密文
 * - 未设主密码（本地库"免登录"）→ 明文 JSON，与连接的存储语义一致
 * 读的时候用 `isCiphertext()` 判断，因此**明文/密文混存也能正确读**（用户中途设了主密码）。
 *
 * ⚠ 实体注册：`db.ts` 的 STORE_ENTITIES 里还没有 QuickCommand 等实体，
 * 这里暂时用**等价的 store_key 字面量**（KV 表本身不校验实体名）。
 * 正式注册需要 store 负责人往 STORE_ENTITIES / STORE_KEYS 各加两行，已上报。
 */

import type { StoreDb, KvRow } from './db'
import { isCiphertext } from './crypto'
import type { ParamHistoryData } from '../quickcmd/history'
import type { QuickCmdStorePort } from '../quickcmd/store-port'
import type { QuickCommandRecord, QuickGroupRecord, QuickLibrary } from '../quickcmd/tree'

/** 与 storeKeyOf() 同构的 key（先在本地定义，注册后可换成 STORE_KEYS） */
export const QUICKCMD_STORE_KEYS = {
  command: 'GeneralDatabaseLocalImp-QuickCommandDatabaseLocalImp',
  group: 'GeneralDatabaseLocalImp-QuickCommandGroupDatabaseLocalImp',
  history: 'GeneralDatabaseLocalImp-QuickCommandParamHistoryDatabaseLocalImp',
} as const

const HISTORY_ITEM_ID = 'param-history'

/** store 的字段加密接口（由 StoreService 提供；未注入则明文存储） */
export interface QuickCmdSealer {
  seal(plain: string): string
  open(sealed: string): string
}

export interface QuickCmdStoreOptions {
  sealer?: QuickCmdSealer
  now?: () => number
}

/**
 * 创建本地库存储。
 * @param db 复用 StoreService 的同一个 StoreDb 实例（不要自己再开一个连接）
 */
export function createQuickCmdStore(db: StoreDb, options: QuickCmdStoreOptions = {}): QuickCmdStorePort {
  const sealer = options.sealer
  const now = options.now ?? (() => Date.now())

  const encode = (value: unknown): string => {
    const json = JSON.stringify(value)
    if (!sealer) return json
    try {
      return sealer.seal(json)
    } catch {
      // 未解锁等情况：降级为明文，保证"免登录也能用本地库"
      return json
    }
  }

  const decode = <T>(payload: string): T | undefined => {
    try {
      const json = isCiphertext(payload) ? (sealer ? sealer.open(payload) : undefined) : payload
      if (json === undefined) return undefined
      return JSON.parse(json) as T
    } catch {
      // 单行损坏不应该让整个列表打不开
      return undefined
    }
  }

  const readRow = <T>(storeKey: string, itemId: string): T | undefined => {
    const row: KvRow | undefined = db.get(storeKey, itemId)
    if (!row) return undefined
    return decode<T>(row.payload)
  }

  const readAll = <T>(storeKey: string): T[] => {
    const out: T[] = []
    for (const index of db.listIds(storeKey)) {
      const value = readRow<T>(storeKey, index.item_id)
      if (value !== undefined) out.push(value)
    }
    return out
  }

  return {
    kind: 'local',

    loadLibrary(): QuickLibrary {
      return {
        commands: readAll<QuickCommandRecord>(QUICKCMD_STORE_KEYS.command).filter(isCommandRecord),
        groups: readAll<QuickGroupRecord>(QUICKCMD_STORE_KEYS.group).filter(isGroupRecord),
      }
    },

    saveCommand(command: QuickCommandRecord): void {
      db.put(QUICKCMD_STORE_KEYS.command, command.id, encode(command), now())
    },

    deleteCommand(id: string): void {
      db.delete(QUICKCMD_STORE_KEYS.command, id)
    },

    saveGroup(group: QuickGroupRecord): void {
      db.put(QUICKCMD_STORE_KEYS.group, group.id, encode(group), now())
    },

    deleteGroup(id: string): void {
      db.delete(QUICKCMD_STORE_KEYS.group, id)
    },

    loadHistory(): ParamHistoryData {
      return readRow<ParamHistoryData>(QUICKCMD_STORE_KEYS.history, HISTORY_ITEM_ID) ?? {}
    },

    saveHistory(data: ParamHistoryData): void {
      db.put(QUICKCMD_STORE_KEYS.history, HISTORY_ITEM_ID, encode(data), now())
    },
  }
}

// ---------------------------------------------------------------------------
// 读取时的形状校验（旧版本数据/损坏行不能把 UI 带崩）
// ---------------------------------------------------------------------------

function isCommandRecord(value: unknown): value is QuickCommandRecord {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Partial<QuickCommandRecord>
  return (
    typeof v.id === 'string' &&
    typeof v.name === 'string' &&
    typeof v.command === 'string' &&
    (v.groupId === null || typeof v.groupId === 'string') &&
    typeof v.order === 'number'
  )
}

function isGroupRecord(value: unknown): value is QuickGroupRecord {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Partial<QuickGroupRecord>
  return (
    typeof v.id === 'string' &&
    typeof v.name === 'string' &&
    (v.parentId === null || typeof v.parentId === 'string') &&
    typeof v.order === 'number'
  )
}
