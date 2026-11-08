// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * OpenSSH 配置导入的编排层：把「解析 → 转换 → 落库」串起来。
 *
 * 与 IPC 解耦（不 import router/AppError），便于单测直接调用；
 * `services/store/index.ts` 里只做参数校验与错误码映射。
 */

import { randomUUID } from 'node:crypto'
import type { Connection, SshConnection } from '@t1000/shared'
import { parseSshConfig, type ParseIo } from './sshconfig'
import { buildImportEntries, type ImportEntry, type UnsupportedItem } from './sshconfig-import'

/** 冲突策略 */
export type ConflictPolicy = 'skip' | 'rename' | 'overwrite'

/** 预览/结果里的单条 */
export interface OpenSshEntryView {
  name: string
  host: string
  port: number
  username?: string
  warnings?: string[]
}

/** 语法/语义问题（行号 1-based） */
export interface OpenSshErrorView {
  line: number
  message: string
  text: string
}

/** 导入结果（与契约形状一致） */
export interface OpenSshImportResult {
  source: string
  parsed: number
  created: number
  skipped: number
  renamed: number
  overwritten: number
  dryRun: boolean
  entries: OpenSshEntryView[]
  unsupported: UnsupportedItem[]
  errors: OpenSshErrorView[]
}

/**
 * 落库所需的最小接口（真实实现是 Repository，测试可给内存替身）。
 *
 * 用 `Connection` 而不是 `SshConnection`：Repository 面向所有连接种类，
 * 这里收窄会逼出一个不安全的断言。
 */
export interface ConnectionSink {
  listConnections(): Connection[]
  saveConnection(input: Connection, now: string): Connection
}

export interface ImportOptions {
  /** 配置文件路径；默认由调用方给出（通常是 ~/.ssh/config） */
  path: string
  dryRun?: boolean
  conflictPolicy?: ConflictPolicy
  io: ParseIo
  sink: ConnectionSink
  /** 注入时钟，便于测试断言时间戳 */
  now?: () => Date
}

/**
 * 执行导入。
 *
 * 关键行为
 * - `dryRun: true` **完全不调用 sink.saveConnection**，只做解析与预览
 * - 冲突按 `skip`/`rename`/`overwrite` 处理并分别计数
 * - 私钥等敏感字段交给 sink（Repository）走既有加密路径，这里绝不自己写库
 */
export function importOpenSshConfig(options: ImportOptions): OpenSshImportResult {
  const { path, io, sink } = options
  const dryRun = options.dryRun ?? false
  const policy = options.conflictPolicy ?? 'skip'
  const nowFn = options.now ?? (() => new Date())

  const parsedConfig = parseSshConfig(path, io)
  const { entries, unsupported } = buildImportEntries(parsedConfig, io)

  const result: OpenSshImportResult = {
    source: path,
    parsed: entries.length,
    created: 0,
    skipped: 0,
    renamed: 0,
    overwritten: 0,
    dryRun,
    entries: [],
    unsupported,
    errors: parsedConfig.errors.map((e) => ({
      line: e.line,
      message: e.message,
      // 出错行文本里带上文件名，Include 场景下才知道是哪个文件出的问题
      text: e.file === parsedConfig.files[0] ? e.text : `${e.text}  (${e.file})`,
    })),
  }

  // 已有连接按 displayName 索引（不区分大小写），用于冲突检测。
  // 注意：只在需要写库时才读，dryRun 也要读——否则无法预测冲突计数。
  const existing = sink.listConnections()
  const existingNames = new Map<string, Connection>()
  for (const conn of existing) {
    existingNames.set(conn.name.toLowerCase(), conn)
  }

  // 同一次导入内部的重名（config 里重复的 Host 别名）也要处理，
  // 否则 rename 会产生两个一样的名字
  const usedNames = new Set<string>(existingNames.keys())

  for (const entry of entries) {
    const view: OpenSshEntryView = {
      name: entry.name,
      host: entry.host,
      port: entry.port,
    }
    if (entry.username !== undefined) view.username = entry.username
    if (entry.warnings.length > 0) view.warnings = [...entry.warnings]

    const finalName = resolveName(entry.name, { existingNames, usedNames, policy, view })

    if (finalName === null) {
      // skip
      result.skipped += 1
      // 预览仍要展示这条（用户想知道"这些被跳过了"），用原名
      result.entries.push(view)
      continue
    }

    view.name = finalName
    result.entries.push(view)
    usedNames.add(finalName.toLowerCase())

    if (finalName.toLowerCase() !== entry.name.toLowerCase()) {
      result.renamed += 1
    } else if (existingNames.has(finalName.toLowerCase())) {
      result.overwritten += 1
      // overwrite：沿用已有连接的 id，保持引用（如隧道里的 serverId）不断
    } else {
      result.created += 1
    }

    if (dryRun) continue

    // 真正写库：走 sink → Repository → 字段加密路径
    const now = nowFn().toISOString()
    const target = existingNames.get(finalName.toLowerCase())

    const connection = toConnection(entry, {
      id: target?.id ?? randomUUID(),
      name: finalName,
      now,
      createdAt: target?.createdAt ?? now,
    })

    const saved = sink.saveConnection(connection, now)
    // 更新索引，让同一次导入里的后续重名能正确冲突
    existingNames.set(saved.name.toLowerCase(), saved)
  }

  return result
}

/** 决定这条用哪个名字；返回 null 表示跳过 */
function resolveName(
  original: string,
  ctx: {
    existingNames: ReadonlyMap<string, Connection>
    usedNames: ReadonlySet<string>
    policy: ConflictPolicy
    view: OpenSshEntryView
  },
): string | null {
  const key = original.toLowerCase()
  const conflicts = ctx.existingNames.has(key) || ctx.usedNames.has(key)
  if (!conflicts) return original

  switch (ctx.policy) {
    case 'skip':
      return null
    case 'overwrite':
      return original
    case 'rename': {
      const renamed = nextAvailableName(original, ctx.usedNames)
      ctx.view.warnings = [...(ctx.view.warnings ?? []), `名称冲突，已重命名为 "${renamed}"`]
      return renamed
    }
  }
}

/** `web` → `web (2)` → `web (3)` … */
export function nextAvailableName(base: string, used: ReadonlySet<string>): string {
  for (let i = 2; i < 1000; i += 1) {
    const candidate = `${base} (${i})`
    if (!used.has(candidate.toLowerCase())) return candidate
  }
  // 极端情况下退化为带随机后缀，保证一定不重名
  return `${base} (${randomUUID().slice(0, 8)})`
}

/** 条目 → 契约里的 SshConnection */
function toConnection(
  entry: ImportEntry,
  meta: { id: string; name: string; now: string; createdAt: string },
): SshConnection {
  const conn: SshConnection = {
    kind: 'ssh',
    id: meta.id,
    name: meta.name,
    host: entry.host,
    port: entry.port,
    username: entry.username ?? '',
    // 有私钥就按私钥认证，否则密码认证（导入后由用户补密码）
    authType: entry.privateKey !== undefined ? 'privateKey' : 'password',
    createdAt: meta.createdAt,
    updatedAt: meta.now,
  }

  if (entry.privateKey !== undefined) conn.privateKey = entry.privateKey
  // 没写 User 时 OpenSSH 会用本地用户名；我们无法可靠得知，留空并备注，
  // 避免把当前机器的用户名当作目标账号写进配置
  if (entry.username === undefined) {
    conn.note = '从 OpenSSH 配置导入，未指定 User'
  }
  if (entry.jumpChain.length > 0) conn.jumpChain = entry.jumpChain

  return conn
}
