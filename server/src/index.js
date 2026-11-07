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
import {
  HttpError,
  dataDir,
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

/** 请求分发 */
async function handle(req, res) {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const path = url.pathname

  for (const route of routes) {
    if (req.method !== route.method) continue
    const m = route.pattern.exec(path)
    if (!m) continue

    // 非读操作才需要 body
    const needsBody = route.method === 'POST' || route.method === 'PUT'
    const body = needsBody ? await readBody(req, MAX_BODY_BYTES) : undefined

    const ctx = { username: undefined }
    if (route.auth) {
      ctx.username = authenticate(req)
    }

    const params = m.slice(1)
    const result = await route.handler(req, res, body, ctx, params)
    sendJson(res, 200, result)
    return
  }

  throw new HttpError(404, 'NOT_FOUND', `未知接口: ${req.method} ${path}`)
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
    if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
      log(`  ⚠️  正在监听非回环地址，请确保前面有 TLS 反代或处于可信网络`)
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
