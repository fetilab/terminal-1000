// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 凭据保鲜（fresh secrets）。
 *
 * 渲染层缓存的连接对象可能带着 `__LOCKED__` 掩码（重启后库还没解锁时加载的），
 * 直接拿去连接协议域（ssh/telnet/…）会把掩码当口令喂出去——telnet 的自动登录
 * 应答器就曾把 `__LOCKED__` 字面量发给设备，用户怎么填密码都「登录不上」。
 *
 * 以主进程存储为准：按连接 id 重新读取库里的权威解密记录，覆盖 payload 里
 * 缺失/掩码的机密字段；payload 里非空且非掩码的字段保留（testConnection 的
 * 未保存草稿场景）。库锁定且有密文时给明确报错，而不是让协议栈报解析错误。
 *
 * 从 ssh 域抽出（2026-11-24）：telnet 域曾漏接这层防护。
 */

import { AppError } from '../../errors'
import { getStoreServiceIfExists, isLockedMask } from './index'

const SECRET_FIELDS = ['password', 'privateKey', 'passphrase', 'identityId'] as const

export function withFreshSecrets<T extends { id?: string }>(conn: T): T {
  if (!conn.id) return conn
  const svc = getStoreServiceIfExists()
  // 服务还没初始化（纯单测场景）：退回 payload 原样，掩码字段丢弃
  if (!svc) return stripMaskedSecrets(conn)
  let fresh: Record<string, unknown> | undefined
  try {
    fresh = svc.getConnection(conn.id) as unknown as Record<string, unknown>
  } catch {
    // 库里没有这条（未保存的草稿）——按 payload 原样，掩码字段丢弃
    return stripMaskedSecrets(conn)
  }
  if (!fresh) return stripMaskedSecrets(conn)

  const svcLocked = !svc.isUnlocked()
  const out = { ...conn } as Record<string, unknown>
  for (const field of SECRET_FIELDS) {
    const local = out[field]
    const localOk = typeof local === 'string' && local.length > 0 && !isLockedMask(local)
    if (localOk) continue
    const f = fresh[field]
    if (typeof f === 'string' && f.length > 0 && !isLockedMask(f)) {
      out[field] = f
    } else {
      // fresh 里也没有可用值；字段一并清掉（掩码绝不能往下传）
      delete out[field]
    }
  }
  // jumpChain 每一跳的机密字段同理（按跳 id 匹配；编辑表单可能重排顺序）
  if (Array.isArray(out.jumpChain) && Array.isArray(fresh.jumpChain)) {
    const freshHops = fresh.jumpChain as Record<string, unknown>[]
    out.jumpChain = (out.jumpChain as Record<string, unknown>[]).map((hop, i) => {
      const hopId = typeof hop.id === 'string' ? hop.id : undefined
      const freshHop =
        (hopId !== undefined ? freshHops.find((h) => h?.id === hopId) : undefined) ?? freshHops[i]
      const merged = { ...hop }
      for (const field of SECRET_FIELDS) {
        const local = merged[field]
        const localOk = typeof local === 'string' && local.length > 0 && !isLockedMask(local)
        if (localOk) continue
        const f = freshHop?.[field]
        if (typeof f === 'string' && f.length > 0 && !isLockedMask(f)) merged[field] = f
        else delete merged[field]
      }
      return merged
    })
  }
  // 库里有密文但当前锁定 → 解不出真值，给明确指引而不是让协议栈报解析错误
  if (svcLocked && hasEncryptedSecrets(fresh)) {
    throw AppError.unauthorized('这条连接的凭据保存在本地库中，当前处于锁定状态，请先解锁主密码再连接')
  }
  return out as T
}

/** 递归检查 payload 里有没有本产品的密文（v1: 前缀）机密字段 */
function hasEncryptedSecrets(value: unknown): boolean {
  if (typeof value === 'string') return false
  if (value === null || typeof value !== 'object') return false
  const obj = value as Record<string, unknown>
  for (const [k, v] of Object.entries(obj)) {
    if (
      ['password', 'privateKey', 'passphrase'].includes(k) &&
      typeof v === 'string' &&
      v.startsWith('v1:')
    ) {
      return true
    }
    if (hasEncryptedSecrets(v)) return true
  }
  return false
}

/** 库里没有对应记录时（未保存草稿）：掩码字段丢弃，绝不下传 */
export function stripMaskedSecrets<T>(conn: T): T {
  const out = { ...(conn as Record<string, unknown>) }
  for (const field of SECRET_FIELDS) {
    if (isLockedMask(out[field])) delete out[field]
  }
  if (Array.isArray(out.jumpChain)) {
    out.jumpChain = (out.jumpChain as Record<string, unknown>[]).map((hop) => {
      const h = { ...hop }
      for (const field of SECRET_FIELDS) {
        if (isLockedMask(h[field])) delete h[field]
      }
      return h
    })
  }
  return out as T
}
