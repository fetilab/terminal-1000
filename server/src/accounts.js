// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 账号与会话令牌。
 *
 * 安全要点：
 * - 口令用 scrypt + 每账号独立随机 salt，绝不明文/可逆存储
 * - 会话令牌**只存哈希**：存储文件泄露也无法直接拿去用
 * - 令牌有有效期，过期即失效
 * - 登录失败不区分「用户不存在」与「口令错」，避免枚举用户
 *
 * 注意：这里的账号口令只用于**访问同步服务**，
 * 与用户数据的加密密钥**完全无关** —— 服务端永远拿不到解密密钥（零知识）。
 */

import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { join } from 'node:path'
import { HttpError, dataDir, ensureDir, readJson, safeEqual, writeJson } from './util.js'

const SCRYPT_N = 16384
const SCRYPT_R = 8
const SCRYPT_P = 1
const KEY_LEN = 32

/** 令牌有效期：30 天 */
const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000

function accountsFile() {
  return join(dataDir(), 'accounts.json')
}

function load() {
  const data = readJson(accountsFile(), { accounts: {}, tokens: {} })
  return {
    accounts: data.accounts ?? {},
    tokens: data.tokens ?? {},
  }
}

function save(db) {
  // 顺手清掉过期令牌，避免文件无限增长
  const now = Date.now()
  for (const [tokenHash, meta] of Object.entries(db.tokens)) {
    if (!meta || typeof meta.expiresAt !== 'number' || meta.expiresAt <= now) {
      delete db.tokens[tokenHash]
    }
  }
  writeJson(accountsFile(), db)
}

function hashPassword(password, salt) {
  return scryptSync(password, salt, KEY_LEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P }).toString('base64')
}

function hashToken(token) {
  return createHash('sha256').update(token).digest('hex')
}

function normalizeUsername(username) {
  if (typeof username !== 'string') throw new HttpError(400, 'USERNAME_INVALID', '用户名不合法')
  const name = username.trim()
  if (name.length < 3 || name.length > 64) {
    throw new HttpError(400, 'USERNAME_INVALID', '用户名长度需为 3-64')
  }
  if (!/^[A-Za-z0-9._@-]+$/.test(name)) {
    throw new HttpError(400, 'USERNAME_INVALID', '用户名只允许字母数字与 . _ @ -')
  }
  return name
}

function assertPassword(password) {
  if (typeof password !== 'string' || password.length < 8) {
    throw new HttpError(400, 'PASSWORD_WEAK', '口令至少 8 位')
  }
  if (password.length > 512) {
    throw new HttpError(400, 'PASSWORD_WEAK', '口令过长')
  }
}

/** 注册；返回会话令牌 */
export function register(username, password) {
  const name = normalizeUsername(username)
  assertPassword(password)

  const db = load()
  const key = name.toLowerCase()
  if (db.accounts[key]) {
    throw new HttpError(409, 'USER_EXISTS', '用户名已存在')
  }

  const salt = randomBytes(16).toString('base64')
  db.accounts[key] = {
    username: name,
    salt,
    passwordHash: hashPassword(password, salt),
    createdAt: new Date().toISOString(),
  }
  save(db)

  return issueToken(name)
}

/** 登录；返回会话令牌 */
export function login(username, password) {
  const name = normalizeUsername(username)
  const db = load()
  const account = db.accounts[name.toLowerCase()]

  // 统一的失败信息，不泄露用户是否存在
  const invalid = new HttpError(401, 'INVALID_CREDENTIALS', '用户名或口令错误')
  if (!account) {
    // 即便账号不存在也做一次等价开销的派生，避免通过响应时间枚举用户
    hashPassword(typeof password === 'string' ? password : '', 'dummy-salt-value')
    throw invalid
  }
  if (typeof password !== 'string') throw invalid

  const expected = Buffer.from(account.passwordHash, 'base64')
  const actual = Buffer.from(hashPassword(password, account.salt), 'base64')
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw invalid
  }

  return issueToken(account.username)
}

function issueToken(username) {
  const db = load()
  const token = randomBytes(32).toString('base64url')
  db.tokens[hashToken(token)] = {
    username,
    createdAt: Date.now(),
    expiresAt: Date.now() + TOKEN_TTL_MS,
  }
  save(db)
  return { token, username, expiresInMs: TOKEN_TTL_MS }
}

/**
 * 校验令牌 → 返回用户名。失败抛 401。
 * 只比对哈希，且用定长比较。
 */
export function verifyToken(token) {
  if (typeof token !== 'string' || token.length === 0) {
    throw new HttpError(401, 'UNAUTHORIZED', '缺少访问令牌')
  }
  const db = load()
  const meta = db.tokens[hashToken(token)]
  if (!meta) throw new HttpError(401, 'UNAUTHORIZED', '令牌无效')
  if (typeof meta.expiresAt !== 'number' || meta.expiresAt <= Date.now()) {
    throw new HttpError(401, 'TOKEN_EXPIRED', '令牌已过期，请重新登录')
  }
  return meta.username
}

/** 注销当前令牌 */
export function logout(token) {
  if (typeof token !== 'string' || token.length === 0) return
  const db = load()
  delete db.tokens[hashToken(token)]
  save(db)
}

/** 测试用：清空所有账号与令牌 */
export function _resetForTests() {
  ensureDir(dataDir())
  writeJson(accountsFile(), { accounts: {}, tokens: {} })
}

/** 供测试断言使用（不暴露给 HTTP 层） */
export const _internals = { hashToken, safeEqual, accountsFile }
