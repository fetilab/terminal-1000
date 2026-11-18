// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 同步失败的结构化分类与指纹格式化。
 *
 * 与组件分开是为了能在 node 环境的单测里直接验证：这段判决决定用户看到
 * "首次连接，请核对后信任"还是"可能是中间人攻击"。把后者渲染成前者，
 * 等于劝用户去信任攻击者的密钥 —— 分类错误比措辞问题严重得多。
 *
 * 判据**只能**是主进程送达的结构化 `detail.code`（`AppError.detail` 跨 IPC 保留，
 * 见 `main/ipc/router` 的错误序列化）。绝不解析错误文案：指纹按 4 位分组输出，
 * 用正则从文案里抠字段在带空格的格式下永不匹配，分类就退化成猜措辞。
 */

import { errorText } from '../../lib/format'

/** 主进程错误里的 `detail` 结构（只在已知 code 时可信） */
interface SyncErrorDetail {
  code?: string
  fingerprint?: string
  expected?: string
  actual?: string
}

export interface SyncErrorInfo {
  /** 主进程用来描述"这次失败属于哪一类"的稳定标识 */
  kind: 'plaintext-not-allowed' | 'untrusted-server' | 'identity-changed' | 'other'
  message: string
  fingerprint?: string
  expected?: string
  actual?: string
}

/**
 * 把 IPC 错误归类。导出是给**登录入口**（外部服务面板）复用的 ——
 * 未钉扎的登录失败必须能直接进入确认流程，而不是只在那边显示一条报错。
 */
export function classifySyncError(err: unknown, pinnedFingerprint?: string | null): SyncErrorInfo {
  const message = errorText(err)
  const e = err as { code?: string; detail?: unknown }
  const detail = (typeof e?.detail === 'object' && e.detail !== null ? e.detail : {}) as SyncErrorDetail

  if (detail.code === 'PLAINTEXT_NOT_ALLOWED') return { kind: 'plaintext-not-allowed', message }

  if (detail.code === 'UNTRUSTED_SERVER') {
    /**
     * 已钉扎却收到"未钉扎"时，**实际是身份变了**：两个结构化字段
     * （本地钉扎指纹 vs 对端本次出示的指纹）不一致即身份变化。
     *
     * 主进程已能正确分类（`channel-pool` 抛 `ServerIdentityChangedError`），这里是纵深防御：
     * 若上游漏带 `identityChanged` 标记而退回 `UntrustedServerError`，也不能把
     * "可能中间人"渲染成"首次连接，请核对后信任"。判据只用结构化字段。
     */
    const offered = detail.fingerprint?.replace(/\s+/g, '').toLowerCase()
    const pinned = pinnedFingerprint?.replace(/\s+/g, '').toLowerCase()
    if (offered && pinned && offered !== pinned) {
      return { kind: 'identity-changed', message, expected: pinned, actual: offered }
    }
    return {
      kind: 'untrusted-server',
      message,
      ...(detail.fingerprint === undefined ? {} : { fingerprint: detail.fingerprint }),
    }
  }

  if (detail.code === 'SERVER_IDENTITY_CHANGED') {
    return {
      kind: 'identity-changed',
      message,
      ...(detail.expected === undefined ? {} : { expected: detail.expected }),
      ...(detail.actual === undefined ? {} : { actual: detail.actual }),
    }
  }

  // 未知/缺失 code 一律 other：宁可只弹一条普通报错，也不靠文案猜分类
  return { kind: 'other', message }
}

/** 32 个 hex 字符按 4 个一组分开，便于口述核对 */
export function formatFingerprint(raw: string): string {
  const hex = raw.replace(/\s+/g, '')
  return (hex.match(/.{1,4}/g) ?? []).join(' ')
}
