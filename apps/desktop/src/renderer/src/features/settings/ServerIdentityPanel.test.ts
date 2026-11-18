// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * `classifySyncError` 的分类判决。
 *
 * 这个函数决定用户看到的是"首次连接，请核对后信任"还是"可能是中间人攻击" ——
 * 把后者渲染成前者等于劝用户信任攻击者的密钥。判据**只能**是主进程送达的
 * 结构化 `detail.code`，绝不解析错误文案：指纹按 4 位分组输出，用正则从文案里
 * 抠字段在带空格的格式下永不匹配，分类就退化成了猜措辞。
 */

import { describe, expect, it } from 'vitest'
import { classifySyncError, formatFingerprint } from './syncError'

/** 构造主进程经 IPC 送达的错误形状（`AppError` → router 序列化后的 error 字段） */
function ipcError(code: string, detail?: unknown, message = '同步失败'): Error {
  const err = new Error(message) as Error & { code?: string; detail?: unknown }
  err.code = code
  err.detail = detail
  return err
}

const FP_PINNED = 'aaaa aaaa aaaa aaaa aaaa aaaa aaaa aaaa'
const FP_OTHER = 'bbbb bbbb bbbb bbbb bbbb bbbb bbbb bbbb'

describe('classifySyncError', () => {
  it('明文传输被拒 → plaintext-not-allowed', () => {
    const info = classifySyncError(ipcError('FORBIDDEN', { code: 'PLAINTEXT_NOT_ALLOWED' }))
    expect(info.kind).toBe('plaintext-not-allowed')
  })

  it('未钉扎（首次连接）→ untrusted-server，并带出对端指纹', () => {
    const info = classifySyncError(
      ipcError('UNAUTHORIZED', { code: 'UNTRUSTED_SERVER', fingerprint: FP_OTHER }),
    )
    expect(info.kind).toBe('untrusted-server')
    expect(info.fingerprint).toBe(FP_OTHER)
  })

  it('已钉扎却收到"未钉扎"、且对端指纹不同 → identity-changed', () => {
    const info = classifySyncError(
      ipcError('UNAUTHORIZED', { code: 'UNTRUSTED_SERVER', fingerprint: FP_OTHER }),
      FP_PINNED,
    )
    expect(info.kind).toBe('identity-changed')
    expect(info.expected).toBe('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
    expect(info.actual).toBe('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')
  })

  it('已钉扎且对端指纹一致 → 仍是 untrusted-server，不得误判成身份变化', () => {
    const info = classifySyncError(
      ipcError('UNAUTHORIZED', { code: 'UNTRUSTED_SERVER', fingerprint: FP_PINNED }),
      FP_PINNED,
    )
    expect(info.kind).toBe('untrusted-server')
  })

  it('结构化 SERVER_IDENTITY_CHANGED → identity-changed，带 expected/actual', () => {
    const info = classifySyncError(
      ipcError('FORBIDDEN', {
        code: 'SERVER_IDENTITY_CHANGED',
        expected: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        actual: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      }),
    )
    expect(info.kind).toBe('identity-changed')
    expect(info.expected).toBe('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
    expect(info.actual).toBe('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')
  })

  it('只有文案、没有 detail → other（禁止从消息文本反推分类）', () => {
    const untrustedText =
      `首次连接该同步服务端，需要你核对身份指纹：\n  ${FP_OTHER}\n` +
      '请在另一条可信渠道（服务器本机日志）核对一致后再信任。'
    expect(classifySyncError(new Error(untrustedText)).kind).toBe('other')
    expect(
      classifySyncError(new Error('同步服务端身份与已记录的不一致（可能为中间人，也可能服务端已更换密钥）')).kind,
    ).toBe('other')
  })

  it('非 Error 抛出物 → other，且不抛', () => {
    expect(classifySyncError(undefined).kind).toBe('other')
    expect(classifySyncError('boom').kind).toBe('other')
  })
})

describe('formatFingerprint', () => {
  it('每 4 位分组，容忍上游已带空格', () => {
    expect(formatFingerprint('aaaabbbbccccddddeeeeffff00001111')).toBe(
      'aaaa bbbb cccc dddd eeee ffff 0000 1111',
    )
    expect(formatFingerprint('aaaa bbbb cccc dddd eeee ffff 0000 1111')).toBe(
      'aaaa bbbb cccc dddd eeee ffff 0000 1111',
    )
  })
})
