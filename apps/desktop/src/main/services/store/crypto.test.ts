// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 加密原语单测：KDF 确定性、GCM 往返、篡改检测、密文格式、Vault 生命周期。
 */

import { describe, expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import {
  CIPHER_VERSION,
  IV_BYTES,
  LOCKED_MASK,
  SALT_BYTES,
  TAG_BYTES,
  Vault,
  createVerifier,
  decryptWithKey,
  deriveKey,
  encryptWithKey,
  isCiphertext,
  isLockedMask,
  safeEqual,
  verifyAndDerive,
} from './crypto'

describe('KDF', () => {
  it('同一密码 + 同一 salt 派生结果确定', () => {
    const salt = randomBytes(SALT_BYTES)
    const a = deriveKey('correct horse', salt)
    const b = deriveKey('correct horse', salt)
    expect(a.equals(b)).toBe(true)
    expect(a).toHaveLength(32)
  })

  it('不同 salt 派生结果不同', () => {
    const a = deriveKey('pw', randomBytes(SALT_BYTES))
    const b = deriveKey('pw', randomBytes(SALT_BYTES))
    expect(a.equals(b)).toBe(false)
  })

  it('不同密码派生结果不同', () => {
    const salt = randomBytes(SALT_BYTES)
    expect(deriveKey('pw1', salt).equals(deriveKey('pw2', salt))).toBe(false)
  })

  it('deriveKey 返回 32 字节（AES-256 要求）', () => {
    expect(deriveKey('pw', randomBytes(SALT_BYTES))).toHaveLength(32)
  })
})

describe('字段加解密', () => {
  const key = randomBytes(32)

  it('往返一致（含中文与特殊字符）', () => {
    for (const plain of ['hello', 'p@ss w0rd!#$%', '中文密码', '-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END-----', '']) {
      expect(decryptWithKey(key, encryptWithKey(key, plain))).toBe(plain)
    }
  })

  it('密文格式为 v1:salt:iv:tag:cipher 五段', () => {
    const blob = encryptWithKey(key, 'secret')
    const parts = blob.split(':')
    expect(parts).toHaveLength(5)
    expect(parts[0]).toBe(CIPHER_VERSION)
    expect(Buffer.from(parts[1]!, 'base64')).toHaveLength(SALT_BYTES)
    expect(Buffer.from(parts[2]!, 'base64')).toHaveLength(IV_BYTES)
    expect(Buffer.from(parts[3]!, 'base64')).toHaveLength(TAG_BYTES)
  })

  it('同一明文两次加密产生不同密文（随机 salt + IV）', () => {
    expect(encryptWithKey(key, 'same')).not.toBe(encryptWithKey(key, 'same'))
  })

  it('密文里不含明文片段', () => {
    const blob = encryptWithKey(key, 'SuperSecret123')
    expect(blob).not.toContain('SuperSecret123')
  })

  it('错误密钥解密抛错（GCM 认证失败）', () => {
    const blob = encryptWithKey(key, 'secret')
    expect(() => decryptWithKey(randomBytes(32), blob)).toThrow()
  })

  it('篡改密文正文抛错', () => {
    const blob = encryptWithKey(key, 'secret')
    const parts = blob.split(':')
    const cipher = Buffer.from(parts[4]!, 'base64')
    cipher[0] = cipher[0]! ^ 0xff
    parts[4] = cipher.toString('base64')
    expect(() => decryptWithKey(key, parts.join(':'))).toThrow()
  })

  it('篡改认证标签抛错', () => {
    const blob = encryptWithKey(key, 'secret')
    const parts = blob.split(':')
    const tag = Buffer.from(parts[3]!, 'base64')
    tag[0] = tag[0]! ^ 0xff
    parts[3] = tag.toString('base64')
    expect(() => decryptWithKey(key, parts.join(':'))).toThrow()
  })

  it('拒绝不支持的版本前缀', () => {
    const blob = encryptWithKey(key, 'secret')
    expect(() => decryptWithKey(key, blob.replace(/^v1:/, 'v9:'))).toThrow(/版本/)
  })

  it('拒绝段数不对的密文', () => {
    expect(() => decryptWithKey(key, 'v1:only:three')).toThrow(/5 段/)
  })

  it('isCiphertext 只认 v1: 前缀', () => {
    expect(isCiphertext(encryptWithKey(key, 'x'))).toBe(true)
    expect(isCiphertext('plaintext')).toBe(false)
    expect(isCiphertext(LOCKED_MASK)).toBe(false)
    expect(isCiphertext(undefined)).toBe(false)
  })

  it('isLockedMask 只认 __LOCKED__', () => {
    expect(isLockedMask(LOCKED_MASK)).toBe(true)
    expect(isLockedMask('__LOCKED__x')).toBe(false)
  })
})

describe('主密码校验记录', () => {
  it('正确密码校验通过并返回可用密钥', () => {
    const record = createVerifier('hunter2hunter2')
    const key = verifyAndDerive('hunter2hunter2', record)
    expect(key).not.toBeNull()
    expect(key).toHaveLength(32)

    // 用返回的密钥能正常解密
    const blob = encryptWithKey(key!, 'payload')
    expect(decryptWithKey(key!, blob)).toBe('payload')
  })

  it('错误密码校验失败返回 null', () => {
    const record = createVerifier('right-password')
    expect(verifyAndDerive('wrong-password', record)).toBeNull()
  })

  it('校验记录里不含主密码明文', () => {
    const record = createVerifier('MyPlainPassword')
    expect(record).not.toContain('MyPlainPassword')
  })

  it('每次生成的记录 salt 不同', () => {
    expect(createVerifier('same')).not.toBe(createVerifier('same'))
  })

  it('畸形记录返回 null 而不是抛错', () => {
    expect(verifyAndDerive('pw', 'garbage')).toBeNull()
    expect(verifyAndDerive('pw', '')).toBeNull()
    expect(verifyAndDerive('pw', 'a:b:c')).toBeNull()
    // salt 为空
    expect(verifyAndDerive('pw', `:${Buffer.alloc(32).toString('base64')}`)).toBeNull()
    // verifier 长度不对
    expect(verifyAndDerive('pw', `${Buffer.alloc(16).toString('base64')}:YWJj`)).toBeNull()
  })
})

describe('Vault 生命周期', () => {
  it('初始为锁定且未初始化', () => {
    const v = new Vault()
    expect(v.isUnlocked()).toBe(false)
    expect(v.isInitialized()).toBe(false)
    expect(v.currentKey()).toBeNull()
  })

  it('解锁后 currentKey 可用，锁定后清空', () => {
    const v = new Vault()
    const key = randomBytes(32)
    v.unlockWithKey(key)
    expect(v.isUnlocked()).toBe(true)
    expect(v.currentKey()).not.toBeNull()

    v.lock()
    expect(v.isUnlocked()).toBe(false)
    expect(v.currentKey()).toBeNull()
  })

  it('lock 会把密钥缓冲区清零（缩短密钥驻留时间）', () => {
    const v = new Vault()
    const key = Buffer.alloc(32, 0xab)
    v.unlockWithKey(key)
    v.lock()
    // 原 Buffer 被 fill(0)，不再含原密钥字节
    expect(key.every((b) => b === 0)).toBe(true)
  })

  it('重复解锁会先清掉上一个密钥', () => {
    const v = new Vault()
    const first = Buffer.alloc(32, 0x11)
    v.unlockWithKey(first)
    const second = randomBytes(32)
    v.unlockWithKey(second)

    expect(first.every((b) => b === 0)).toBe(true)
    expect(v.currentKey()!.equals(second)).toBe(true)
  })
})

describe('safeEqual', () => {
  it('相同内容返回 true，不同长度/内容返回 false', () => {
    expect(safeEqual(Buffer.from('abc'), Buffer.from('abc'))).toBe(true)
    expect(safeEqual(Buffer.from('abc'), Buffer.from('abd'))).toBe(false)
    expect(safeEqual(Buffer.from('abc'), Buffer.from('abcd'))).toBe(false)
  })
})
