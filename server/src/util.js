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

/**
 * 监听地址。
 *
 * 默认只监听回环（最安全）。要对外提供服务时显式设置：
 * - IPv4 全接口：`0.0.0.0`
 * - **IPv6 全接口：`::`**（Node 默认双栈，同时接受 IPv4 映射地址）
 * - 指定单接口：如 `192.168.1.187` 或某条 v6 地址
 *
 * 注意：若服务器**只有 IPv6**，`0.0.0.0` 是无效的 —— 必须用 `::`，
 * 否则服务看起来"启动了"却在 v6 上完全不可达。
 */
export function listenHost() {
  return process.env.T1000_HOST ?? '127.0.0.1'
}

/** 判断监听地址是否属于"对外暴露"（回环不算）。用于启动时的安全提示。 */
export function isPublicBind(host) {
  return !(host === '127.0.0.1' || host === 'localhost' || host === '::1')
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


/**
 * 统一 IP 表示，便于作为限流 key。
 * - 剥掉方括号（`[2001:db8::1]` → `2001:db8::1`）
 * - IPv4-mapped IPv6（`::ffff:1.2.3.4`）归一为 IPv4 —— 双栈套接字上 v4 客户端
 *   会以此形式出现，不归一的话同一客户端会因地址形态不同而被算成两个 key
 */
export function normalizeIp(raw) {
  let ip = String(raw ?? '').trim()
  if (!ip) return 'unknown'
  if (ip.startsWith('[') && ip.includes(']')) ip = ip.slice(1, ip.indexOf(']'))
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip)
  if (mapped) return mapped[1]
  return ip
}

/**
 * 提取客户端 IP（用于限流）。
 *
 * **安全要点**：`X-Forwarded-For` 是**可伪造**的。只有明确知道自己位于受信反向代理之后
 * 时才应采信（`T1000_TRUST_PROXY=1`），否则攻击者可以每个请求伪造不同 IP 来绕过限流 ——
 * 那比不限流更糟（给人虚假的安全感）。默认**不信任**代理头，直接用 socket 地址。
 */
export function clientIp(req) {
  const direct = normalizeIp(req.socket?.remoteAddress ?? '')
  if (process.env.T1000_TRUST_PROXY !== '1') return direct

  const header = req.headers['x-forwarded-for']
  if (typeof header === 'string' && header.length > 0) {
    // 取最左侧（最初的客户端）；后续是代理链追加的
    const first = header.split(',')[0].trim()
    if (first) return normalizeIp(first)
  }
  const real = req.headers['x-real-ip']
  if (typeof real === 'string' && real.trim()) return normalizeIp(real.trim())
  return direct
}
