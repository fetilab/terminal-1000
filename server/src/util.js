// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 同步后端的通用工具：路径、原子写、JSON 读写、HTTP 辅助。
 *
 * 后端刻意**零运行时依赖**（只用 node 内置模块）：
 * 部署到目标机器只需要一个有 node 的环境，不需要 npm install，
 * 也不需要编译原生模块 —— 这对"把服务放到服务器上常驻"很重要。
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

/** 数据根目录：环境变量优先，便于部署时指定到机械盘 */
export function dataDir() {
  return resolve(process.env.T1000_DATA_DIR ?? join(process.cwd(), 'data'))
}

/** 监听地址：默认只监听回环，避免误暴露到公网 */
export function listenHost() {
  return process.env.T1000_HOST ?? '127.0.0.1'
}

export function listenPort() {
  const raw = process.env.T1000_PORT
  const port = raw ? Number(raw) : 8787
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`T1000_PORT 不合法: ${raw}`)
  }
  return port
}

export function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

/**
 * 原子写文件（写临时文件再 rename）。
 * 同步过程中途断电时，宁可保留旧版本，也不要写出半个文件。
 */
export function writeFileAtomic(file, content) {
  ensureDir(dirname(file))
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tmp, content)
  renameSync(tmp, file)
}

export function readJson(file, fallback = undefined) {
  try {
    if (!existsSync(file)) return fallback
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

export function writeJson(file, value) {
  writeFileAtomic(file, JSON.stringify(value, null, 2))
}

export function removeFile(file) {
  try {
    rmSync(file, { force: true })
  } catch {
    /* 不存在即视为已删除 */
  }
}

/**
 * 用户名 → 安全的目录名。
 * 直接拿用户名拼路径会允许 `../` 逃逸，所以必须哈希后使用。
 */
export function userKey(username) {
  return createHash('sha256').update(username.trim().toLowerCase()).digest('hex').slice(0, 32)
}

/**
 * blob 名 → 安全文件名。
 * 同样必须哈希：blob 名来自客户端，不能直接作为路径。
 */
export function blobFileName(name) {
  if (typeof name !== 'string' || name.length === 0 || name.length > 200) {
    throw new HttpError(400, 'BLOB_NAME_INVALID', 'blob 名不合法')
  }
  return createHash('sha256').update(name).digest('hex')
}

/** 定长安全比较，避免按字符提前返回泄露信息 */
export function safeEqual(a, b) {
  const ba = Buffer.from(String(a))
  const bb = Buffer.from(String(b))
  if (ba.length !== bb.length) return false
  return timingSafeEqual(ba, bb)
}

export function randomToken(bytes = 32) {
  return randomBytes(bytes).toString('base64url')
}

/** 带状态码与稳定错误码的 HTTP 错误 */
export class HttpError extends Error {
  constructor(status, code, message) {
    super(message)
    this.name = 'HttpError'
    this.status = status
    this.code = code
  }
}

/** 读取请求体并限制大小（防止内存被打爆） */
export function readBody(req, limitBytes = 64 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limitBytes) {
        reject(new HttpError(413, 'PAYLOAD_TOO_LARGE', `请求体超过 ${limitBytes} 字节`))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks)
      if (raw.length === 0) return resolve(undefined)
      try {
        resolve(JSON.parse(raw.toString('utf8')))
      } catch {
        reject(new HttpError(400, 'BAD_JSON', '请求体不是合法 JSON'))
      }
    })
    req.on('error', reject)
  })
}

export function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    // 同步接口只面向本应用的客户端，不需要被浏览器跨站调用
    'cache-control': 'no-store',
  })
  res.end(body)
}

export function sendError(res, err) {
  const status = err instanceof HttpError ? err.status : 500
  const code = err instanceof HttpError ? err.code : 'INTERNAL'
  const message = err instanceof Error ? err.message : String(err)
  sendJson(res, status, { error: { code, message } })
}

export function nowIso() {
  return new Date().toISOString()
}
