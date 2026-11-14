// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * terminal-1000 同步后端。
 *
 * 定位：给「多端同步连接/笔记/设置」提供一个**自建、零知识**的存储端点，
 * 用来替代原产品的付费云端仓库。服务端只存密文，密钥不出客户端。
 *
 * 部署要点：
 * - 零运行时依赖（仅 node 内置模块），拷过去有 node 就能跑
 * - 默认只监听 127.0.0.1；若要跨机访问需显式设 T1000_HOST，并建议置于反代/TLS 之后
 * - 数据目录由 T1000_DATA_DIR 指定（部署时指向机械盘）
 * - HTTP 访问日志**不记录请求体**，避免把密文或口令写进日志
 */

import { createServer as createHttpServer } from 'node:http'
import * as accounts from './accounts.js'
import * as blobs from './blobs.js'
import { checkAllowed, recordAttempt } from './ratelimit.js'
import {
  HttpError,
  clientIp,
  dataDir,
  isPublicBind,
  listenHost,
  listenPort,
  nowIso,
  readBody,
  sendError,
  sendJson,
} from './util.js'

const MAX_BODY_BYTES = Number(process.env.T1000_MAX_BODY_BYTES ?? 256 * 1024 * 1024)

/** 从请求头取 Bearer 令牌 */
function bearerToken(req) {
  const raw = req.headers['authorization']
  if (typeof raw !== 'string') return ''
  const m = /^Bearer\s+(.+)$/i.exec(raw.trim())
  return m?.[1] ?? ''
}

/** 鉴权：返回用户名 */
function authenticate(req) {
  return accounts.verifyToken(bearerToken(req))
}

/**
 * 路由表。
 * 每条：method + 正则 + 是否需要鉴权 + 处理函数。
 * 处理函数签名 (req, res, body, ctx) —— ctx 含已鉴权的 username。
 */
const routes = [
  {
    method: 'GET',
    pattern: /^\/api\/v1\/health$/,
    auth: false,
    handler: () => ({
      ok: true,
      service: 'terminal-1000-sync',
      version: '0.1.0',
      time: nowIso(),
      dataDir: dataDir(),
    }),
  },

  {
    method: 'POST',
    pattern: /^\/api\/v1\/register$/,
    auth: false,
    handler: (_req, _res, body) => accounts.register(body?.username, body?.password),
  },

  {
    method: 'POST',
    pattern: /^\/api\/v1\/login$/,
    auth: false,
    handler: (_req, _res, body) => accounts.login(body?.username, body?.password),
  },

  {
    method: 'POST',
    pattern: /^\/api\/v1\/logout$/,
    auth: true,
    handler: (req) => {
      accounts.logout(bearerToken(req))
      return { ok: true }
    },
  },

  {
    method: 'GET',
    pattern: /^\/api\/v1\/blobs$/,
    auth: true,
    handler: (_req, _res, _body, ctx) => ({ blobs: blobs.list(ctx.username) }),
  },

  {
    method: 'GET',
    pattern: /^\/api\/v1\/blobs\/(.+)$/,
    auth: true,
    handler: (_req, _res, _body, ctx, params) => blobs.get(ctx.username, decodeURIComponent(params[0])),
  },

  {
    method: 'PUT',
    pattern: /^\/api\/v1\/blobs\/(.+)$/,
    auth: true,
    handler: (_req, _res, body, ctx, params) =>
      blobs.put(
        ctx.username,
        decodeURIComponent(params[0]),
        body?.ciphertext,
        body?.baseVersion,
      ),
  },

  {
    method: 'DELETE',
    pattern: /^\/api\/v1\/blobs\/(.+)$/,
    auth: true,
    handler: (_req, _res, _body, ctx, params) =>
      blobs.remove(ctx.username, decodeURIComponent(params[0])),
  },

  {
    method: 'GET',
    pattern: /^\/api\/v1\/usage$/,
    auth: true,
    handler: (_req, _res, _body, ctx) => blobs.usage(ctx.username),
  },
]

function log(...args) {
  console.log(`[${nowIso()}]`, ...args)
}

/** 安全响应头（每个响应都发） */
function applySecurityHeaders(res) {
  res.setHeader('x-content-type-options', 'nosniff')
  res.setHeader('x-frame-options', 'DENY')
  res.setHeader('referrer-policy', 'no-referrer')
  res.setHeader('cache-control', 'no-store')
  if (process.env.T1000_TRUST_PROXY === '1') {
    res.setHeader('strict-transport-security', 'max-age=31536000; includeSubDomains')
  }
}

/**
 * 认证类接口限流。
 *
 * 公网暴露后 `/login` 就是最低成本的暴力破解入口；大量尝试本身也是资源消耗
 * （scrypt 会把 CPU 打满 = 拒绝服务）。按「IP」与「IP+账号」双 key 限流：
 * 单 IP 封不死所有账号，换 IP 打同一账号也会被第二个 key 拦住。
 */
const AUTH_PATHS = new Set(['/api/v1/login', '/api/v1/register'])

function authKeys(req, body) {
  const ip = clientIp(req)
  const username =
    typeof body?.username === 'string' ? body.username.trim().toLowerCase().slice(0, 64) : ''
  const keys = [`ip:${ip}`]
  if (username) keys.push(`acct:${ip}:${username}`)
  return { ip, username, keys }
}

function enforceRateLimit(req, body) {
  for (const key of authKeys(req, body).keys) {
    const verdict = checkAllowed(key)
    if (!verdict.allowed) {
      const err = new HttpError(
        429,
        verdict.reason === 'locked' ? 'TOO_MANY_FAILURES' : 'RATE_LIMITED',
        verdict.reason === 'locked'
          ? `尝试过于频繁，已临时锁定，请 ${verdict.retryAfterSec} 秒后重试`
          : `请求过于频繁，请 ${verdict.retryAfterSec} 秒后重试`,
      )
      err.retryAfterSec = verdict.retryAfterSec
      throw err
    }
  }
}

/** 记录认证尝试（成功清失败计数；失败累计并可能触发锁定）。审计只记 IP+用户名，**绝不记口令**。 */
function noteAuthAttempt(req, body, success) {
  const { ip, username, keys } = authKeys(req, body)
  let locked
  for (const key of keys) {
    const r = recordAttempt(key, success)
    if (r.locked) locked = r
  }
  if (success) {
    log(`AUTH ok ip=${ip} user=${username || '-'}`)
  } else {
    log(`AUTH fail ip=${ip} user=${username || '-'}${locked ? ` LOCKED ${locked.retryAfterSec}s` : ''}`)
  }
  return locked
}

/**
 * 请求分发（**协议无关**）。
 *
 * 只依赖 `reqr` 这个描述符，不依赖 node:http 的对象。这样 HTTP 与 TSC/1
 * 加密通道可以**共用同一套路由/鉴权/限流** —— 抄第二份就会长出两套行为，
 * 迟早不一致（这正是任务卡明确禁止的）。
 *
 * 路由处理函数仍按原签名 `(req, res, body, ctx, params)` 调用，
 * 其中 `req`/`res` 由各传输自己提供（TSC/1 传最小 stub）。
 */
export async function dispatch(reqr) {
  const { method, path, body, req, res } = reqr

  for (const route of routes) {
    if (method !== route.method) continue
    const m = route.pattern.exec(path)
    if (!m) continue

    const ctx = { username: undefined }
    if (route.auth) {
      ctx.username = authenticate(req)
    }

    const params = m.slice(1)

    const isAuth = AUTH_PATHS.has(path)
    if (isAuth) enforceRateLimit(req, body)

    let result
    try {
      result = await route.handler(req, res, body, ctx, params)
    } catch (err) {
      // 认证失败计入失败次数（账号不存在与口令错一视同仁，避免通过锁定行为枚举账号）
      if (isAuth) noteAuthAttempt(req, body, false)
      throw err
    }
    if (isAuth) noteAuthAttempt(req, body, true)

    return result
  }

  throw new HttpError(404, 'NOT_FOUND', `未知接口: ${method} ${path}`)
}

/** HTTP 传输层：把 node 的 req/res 适配成 dispatch 的描述符 */
async function handle(req, res) {
  const url = new URL(req.url ?? '/', 'http://[::1]')
  const path = url.pathname

  applySecurityHeaders(res)

  // 非读操作才需要 body
  const needsBody = req.method === 'POST' || req.method === 'PUT'
  const body = needsBody ? await readBody(req, MAX_BODY_BYTES) : undefined
  sendJson(res, 200, await dispatch({ method: req.method, path, body, req, res }))
}

/** 创建服务实例（测试可直接用，不占用固定端口） */
export function createServer() {
  return createHttpServer((req, res) => {
    const started = Date.now()
    const method = req.method ?? 'GET'
    const path = (req.url ?? '/').split('?')[0]

    handle(req, res).then(
      () => {
        // 只记录方法/路径/状态/耗时 —— 绝不记录请求体
        if (path !== '/api/v1/health') {
          log(`${method} ${path} ${res.statusCode} ${Date.now() - started}ms`)
        }
      },
      (err) => {
        const status = err instanceof HttpError ? err.status : 500
        if (status >= 500) {
          log(`ERROR ${method} ${path}`, err instanceof Error ? err.message : String(err))
        }
        if (status === 429 && err && typeof err.retryAfterSec === 'number') {
          res.setHeader('retry-after', String(err.retryAfterSec))
        }
        if (!res.headersSent) sendError(res, err)
        else res.end()
      },
    )
  })
}

/** 直接运行入口 */
function main() {
  const dir = blobs.ensureStorageReady()
  const host = listenHost()
  const port = listenPort()
  const server = createServer()

  server.listen(port, host, () => {
    log(`terminal-1000 sync backend 已启动`)
    log(`  监听: http://${host}:${port}`)
    log(`  数据: ${dir}`)
    if (isPublicBind(host)) {
      log(`  ⚠️  正在监听对外地址 ${host} —— 请确保前面有 TLS 反代`)
      log(`      直连 HTTP 会让登录口令明文过网；建议仅把本端口暴露给反代`)
      if (process.env.T1000_TRUST_PROXY === '1') {
        log(`      T1000_TRUST_PROXY=1：将采信 X-Forwarded-For（仅在确实位于受信反代之后时启用）`)
      } else {
        log(`      未启用 T1000_TRUST_PROXY：限流按 socket 地址计（直连场景正确）`)
      }
    }
  })

  // systemd 停止服务时优雅退出，避免写坏文件
  const shutdown = (signal) => {
    log(`收到 ${signal}，正在关闭…`)
    server.close(() => {
      log('已关闭')
      process.exit(0)
    })
    // 兜底：10 秒内没关完就强制退出
    setTimeout(() => process.exit(0), 10_000).unref()
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
}

// 仅在被直接执行时启动（被 import 时只导出 createServer，便于测试）
const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`
if (isMain) main()
