// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 密文 blob 存储 —— **零知识**。
 *
 * 服务端只做三件事：按账号隔离地存、按版本号判冲突、原样返回。
 * 它**不解析、不解密、不索引** blob 内容；加密密钥由客户端持有，永不上传。
 * 因此即使这台服务器被完全攻破，攻击者也只拿到一堆密文。
 *
 * 存储布局：
 *   <data>/users/<userKey>/index.json        blob 元数据（名/版本/时间/大小）
 *   <data>/users/<userKey>/blobs/<hash>.ct   密文正文（对服务端不透明）
 *
 * 元数据与正文分离：列表操作只读 index.json，
 * 不需要把可能几 MB 的密文全读一遍。
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  HttpError,
  blobFileName,
  dataDir,
  ensureDir,
  readJson,
  removeFile,
  userKey,
  writeFileAtomic,
  writeJson,
} from './util.js'

/** 单个 blob 上限（默认 256MB，可用环境变量调整） */
function maxBlobBytes() {
  const raw = process.env.T1000_MAX_BLOB_BYTES
  const n = raw ? Number(raw) : 256 * 1024 * 1024
  return Number.isFinite(n) && n > 0 ? n : 256 * 1024 * 1024
}

function userDir(username) {
  return join(dataDir(), 'users', userKey(username))
}

function indexPath(username) {
  return join(userDir(username), 'index.json')
}

function blobPath(username, name) {
  return join(userDir(username), 'blobs', `${blobFileName(name)}.ct`)
}

function loadIndex(username) {
  return readJson(indexPath(username), { blobs: {} })
}

function saveIndex(username, index) {
  writeJson(indexPath(username), index)
}

/** 列出该账号的全部 blob 元数据（不含正文） */
export function list(username) {
  const index = loadIndex(username)
  return Object.entries(index.blobs ?? {}).map(([name, meta]) => ({
    name,
    version: meta.version,
    updatedAt: meta.updatedAt,
    createdAt: meta.createdAt,
    size: meta.size,
  }))
}

/** 取单个 blob（含密文正文） */
export function get(username, name) {
  const index = loadIndex(username)
  const meta = index.blobs?.[name]
  if (!meta) throw new HttpError(404, 'BLOB_NOT_FOUND', `blob 不存在: ${name}`)

  const file = blobPath(username, name)
  if (!existsSync(file)) {
    // 元数据在、正文丢了：属于存储损坏，明确报出来而不是返回空内容
    throw new HttpError(500, 'BLOB_CORRUPT', `blob 正文缺失: ${name}`)
  }

  return {
    name,
    version: meta.version,
    updatedAt: meta.updatedAt,
    createdAt: meta.createdAt,
    size: meta.size,
    ciphertext: readFileSync(file, 'utf8'),
  }
}

/**
 * 写入 blob。
 *
 * @param baseVersion 客户端读到的版本号；不匹配则拒绝（乐观并发控制）。
 *                    不传表示强制覆盖（首次上传或用户明确选择覆盖）。
 */
export function put(username, name, ciphertext, baseVersion) {
  if (typeof ciphertext !== 'string' || ciphertext.length === 0) {
    throw new HttpError(400, 'CIPHERTEXT_REQUIRED', '缺少密文内容')
  }
  const bytes = Buffer.byteLength(ciphertext)
  if (bytes > maxBlobBytes()) {
    throw new HttpError(413, 'BLOB_TOO_LARGE', `blob 超过上限 ${maxBlobBytes()} 字节`)
  }

  const index = loadIndex(username)
  index.blobs = index.blobs ?? {}

  const current = index.blobs[name]
  const currentVersion = current?.version ?? 0

  if (baseVersion !== undefined && baseVersion !== null) {
    if (!Number.isInteger(baseVersion) || baseVersion < 0) {
      throw new HttpError(400, 'BASE_VERSION_INVALID', 'baseVersion 必须是非负整数')
    }
    if (baseVersion !== currentVersion) {
      // 冲突：把服务端当前版本一并返回，客户端据此决定合并还是覆盖
      throw new HttpError(
        409,
        'VERSION_CONFLICT',
        `版本冲突：客户端基于 ${baseVersion}，服务端当前 ${currentVersion}`,
      )
    }
  }

  const now = new Date().toISOString()
  writeFileAtomic(blobPath(username, name), ciphertext)

  index.blobs[name] = {
    version: currentVersion + 1,
    updatedAt: now,
    createdAt: current?.createdAt ?? now,
    size: bytes,
  }
  saveIndex(username, index)

  return {
    name,
    version: index.blobs[name].version,
    updatedAt: now,
    size: bytes,
  }
}

/** 删除 blob（幂等） */
export function remove(username, name) {
  const index = loadIndex(username)
  const existed = Boolean(index.blobs?.[name])
  if (existed) {
    delete index.blobs[name]
    saveIndex(username, index)
  }
  removeFile(blobPath(username, name))
  return { deleted: existed, name }
}

/** 该账号占用的字节数（运维用） */
export function usage(username) {
  const index = loadIndex(username)
  let total = 0
  for (const meta of Object.values(index.blobs ?? {})) {
    total += meta.size ?? 0
  }
  const dir = userDir(username)
  return {
    blobs: Object.keys(index.blobs ?? {}).length,
    bytes: total,
    dirExists: existsSync(dir),
  }
}

/** 供运维：确认磁盘可写 */
export function ensureStorageReady() {
  ensureDir(join(dataDir(), 'users'))
  return dataDir()
}

export const _internals = { blobPath, indexPath, userDir, maxBlobBytes, statSync }
