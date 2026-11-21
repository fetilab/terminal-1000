// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 旧版（参考实现产品）数据的一次性导入。
 *
 * 背景：用户之前一直用原产品，连接/密钥都存在
 * `<系统配置目录>/xterminal/sqlite/local-store.db` 里。我们的数据目录
 * （`terminal-1000`）从第一版起就是独立目录，`dataDir.ts` 的目录级迁移
 * 只处理「同一目录布局」的旧版本 —— 对原产品的库无能为力，而且只要目标
 * 目录里已经先建了库（哪怕只有 demo 数据），那次迁移就直接跳过。
 * 结果就是用户装上新版看到空列表，以为「配置全丢了」。
 *
 * 这里在 store 服务首次创建时做**行级**导入：
 * - 只读打开旧库，绝不修改源文件；
 * - 按 `store_key` 后缀识别实体，字段映射到本项目的模型；
 * - **跳过 id 已存在的行**（幂等；demo 行是 `demo-*`，不会撞）；
 * - AI 会话/笔记等结构差异过大的实体本轮不导（避免静默损坏），只在报告里记数；
 * - 完成后在 `store_meta` 落标记，之后启动不再重复执行。
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { STORE_KEYS, type StoreDb } from './db'

/** 原产品在本项目之前使用的数据库名（相对系统配置目录） */
export const LEGACY_DB_RELATIVE = ['xterminal', 'sqlite', 'local-store.db'] as const

export interface LegacyImportReport {
  /** 源库路径 */
  source: string
  /** 按实体统计的导入条数（只含实际写入的） */
  imported: Record<string, number>
  /** 因 id 已存在 / 结构不认识而跳过的条数 */
  skipped: number
  /** 不导入的实体及原因 */
  omitted: Record<string, string>
  /** 非致命错误（单行解析失败不影响其余） */
  errors: string[]
}

interface LegacyRow {
  storeKey: string
  itemId: string
  payload: string
}

/** 旧库 store_key 形如 `<24hex>-GeneralDatabaseLocalImp-<X>DatabaseLocalImp`，也可能没有前缀 */
const KEY_RE = /^(?:[0-9a-f]{16,32}-)?GeneralDatabaseLocalImp-([A-Za-z]+)DatabaseLocalImp$/

/** meta 标记：做过就不再做 */
const META_FLAG = 'legacy_import_v1'

/** 旧字段宽松取值 */
function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined
}
function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

/** SSH 连接：旧 payload → 本项目模型（命名收敛后的 SshConnection） */
function mapSsh(payload: Record<string, unknown>): Record<string, unknown> | null {
  const host = str(payload.host)
  if (!host) return null
  const out: Record<string, unknown> = {
    kind: 'ssh',
    id: str(payload._id),
    name: str(payload.title) ?? host,
    host,
    port: num(payload.port) ?? 22,
    username: str(payload.username) ?? 'root',
    authType: str(payload.authType) ?? 'password',
    storeType: 'local',
    createdAt: str(payload.createdAt) ?? new Date().toISOString(),
    updatedAt: str(payload.updatedAt) ?? new Date().toISOString(),
  }
  for (const k of ['password', 'privateKey', 'passphrase', 'note'] as const) {
    const v = str(payload[k])
    if (v !== undefined) out[k] = v
  }
  // 引用式凭证：旧模型同样用 id 引用，直接透传
  const identityId = str(payload.identityId) ?? str(payload.credentialId)
  if (identityId) {
    out.identityId = identityId
    out.authType = out.authType === 'privateKey' ? 'identity' : out.authType
  }
  return out
}

/** RDP 连接：旧的 authDecrypted 嵌套结构拍平 */
function mapRdp(payload: Record<string, unknown>): Record<string, unknown> | null {
  const auth = (payload.authDecrypted ?? {}) as Record<string, unknown>
  const host = str(auth.address) ?? str(payload.host)
  if (!host) return null
  const out: Record<string, unknown> = {
    kind: 'rdp',
    id: str(payload._id),
    name: str(payload.title) ?? host,
    host,
    port: num(auth.port) ?? num(payload.port) ?? 3389,
    username: str(auth.username) ?? str(payload.username) ?? '',
    storeType: 'local',
    createdAt: str(payload.createdAt) ?? new Date().toISOString(),
    updatedAt: str(payload.updatedAt) ?? new Date().toISOString(),
  }
  const password = str(auth.password) ?? str(payload.password)
  if (password) out.password = password
  if (auth.enableClipboard === true) out.clipboardShare = true
  const quality = str(auth.renderQualityMode)
  if (quality === 'low' || quality === 'balanced' || quality === 'high') out.quality = quality
  const note = str(payload.note)
  if (note) out.note = note
  return out
}

/** 分组（尽力而为：旧库当前没有分组行，字段对得上就收） */
function mapGroup(payload: Record<string, unknown>): Record<string, unknown> | null {
  const name = str(payload.title) ?? str(payload.name)
  if (!name) return null
  const out: Record<string, unknown> = {
    id: str(payload._id) ?? str(payload.id),
    name,
    createdAt: str(payload.createdAt) ?? new Date().toISOString(),
    updatedAt: str(payload.updatedAt) ?? new Date().toISOString(),
  }
  const parentId = str(payload.parentId) ?? str(payload.parent)
  if (parentId) out.parentId = parentId
  return out
}

/** 各实体的映射器；没有列出的实体一律不导 */
const MAPPERS: Record<string, { storeKey: string; map: (p: Record<string, unknown>) => Record<string, unknown> | null; reason?: string }> = {
  Server: { storeKey: STORE_KEYS.server, map: mapSsh },
  Rdp: { storeKey: STORE_KEYS.server, map: mapRdp },
  Group: { storeKey: STORE_KEYS.group, map: mapGroup },
}

const OMIT_REASONS: Record<string, string> = {
  AIChat: '消息结构（segments）与本项目（ChatMessage）差异过大，导入会静默损坏，暂不迁移',
  ServerStatus: '运行时监控快照，属临时数据，无需迁移',
  SessionLog: '会话日志属临时数据，无需迁移',
  Settings: '原产品的设置项命名与本项目完全不同，无法安全映射',
  Credential: '凭证行可能被旧产品加密，格式未知，暂不迁移',
}

/**
 * 执行导入。做过（meta 标记存在）、源库不存在时返回 null。
 * 任何异常都不应让启动失败 —— 出错时返回带 errors 的报告。
 */
export function importLegacyReferenceStores(db: StoreDb, appData: string): LegacyImportReport | null {
  if (db.getMeta(META_FLAG) !== undefined) return null

  const source = join(appData, ...LEGACY_DB_RELATIVE)
  if (!existsSync(source)) {
    db.setMeta(META_FLAG, JSON.stringify({ source, found: false, at: new Date().toISOString() }))
    return null
  }

  const report: LegacyImportReport = { source, imported: {}, skipped: 0, omitted: {}, errors: [] }

  let rows: LegacyRow[]
  try {
    // readonly + fileMustExist：双重保险，物理上无法写源库。
    // （不传 URI 串 —— better-sqlite3 对 file: 前缀需要显式 uri 开关，实测反而打不开）
    const legacy = new Database(source, { readonly: true, fileMustExist: true })
    try {
      rows = legacy
        .prepare<[], LegacyRow>('SELECT store_key AS storeKey, item_id AS itemId, payload AS payload FROM local_store')
        .all()
    } finally {
      legacy.close()
    }
  } catch (err) {
    report.errors.push(`打开旧库失败：${err instanceof Error ? err.message : String(err)}`)
    db.setMeta(META_FLAG, JSON.stringify({ ...report, at: new Date().toISOString() }))
    return report
  }

  const now = Date.now()
  for (const row of rows) {
    const m = KEY_RE.exec(row.storeKey)
    if (!m) {
      report.skipped += 1
      continue
    }
    const entity = m[1]
    if (!entity) {
      report.skipped += 1
      continue
    }
    const reason = OMIT_REASONS[entity]
    if (reason) {
      report.omitted[entity] = reason
      report.skipped += 1
      continue
    }
    const entry = MAPPERS[entity]
    if (!entry) {
      // 认识前缀但没映射器的实体：记一次跳过，不喧宾夺主
      report.skipped += 1
      continue
    }
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(row.payload) as Record<string, unknown>
    } catch (err) {
      report.errors.push(`解析 ${entity}/${row.itemId} 失败：${err instanceof Error ? err.message : String(err)}`)
      continue
    }
    const mapped = entry.map(parsed)
    if (!mapped || typeof mapped.id !== 'string') {
      report.skipped += 1
      continue
    }
    // id 已存在 → 跳过（绝不覆盖用户已改过的数据）
    if (db.get(entry.storeKey, mapped.id)) {
      report.skipped += 1
      continue
    }
    try {
      db.put(entry.storeKey, mapped.id, JSON.stringify(mapped), now)
      report.imported[entity] = (report.imported[entity] ?? 0) + 1
    } catch (err) {
      report.errors.push(`写入 ${entity}/${mapped.id} 失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  db.setMeta(META_FLAG, JSON.stringify({ ...report, at: new Date().toISOString() }))

  // 历史上 dev 构建给目标库种过 demo 数据（item_id 以 demo- 开头）。
  // 既然确认了用户真实数据的存在，这些假连接只会造成「列表很乱/配置像丢了」的观感，
  // 一次性清掉（真实用户数据 id 不可能是 demo- 前缀）。
  if (Object.keys(report.imported).length > 0) {
    let removedDemo = 0
    for (const key of [STORE_KEYS.server, STORE_KEYS.group]) {
      for (const idx of db.listIds(key)) {
        if (idx.item_id.startsWith('demo-')) {
          db.delete(key, idx.item_id)
          removedDemo += 1
        }
      }
    }
    if (removedDemo > 0) report.omitted['demo'] = `已清除 ${removedDemo} 条历史演示数据`
  }

  return report
}
