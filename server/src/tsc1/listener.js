// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * TSC/1 监听：与现有 HTTP 监听**并存**（HTTP 保留给反代/本机兼容）。
 *
 * ## 为什么用独立端口，而不是同端口按 magic 分流
 *
 * 本部署的现实约束（见 `docs/DEPLOYMENT-192.168.1.187.md`）：
 * - HTTP 的 **8787 被 nft `t1000-port-guard` 限制为仅回环**，只允许本机反代连入；
 *   正因为如此，`T1000_TRUST_PROXY=1`（采信 X-Forwarded-For）才是安全的。
 * - TSC/1 的存在意义恰恰是**被公网直连**（用户 80 被 ISP 封、无证书、不动 DNS）。
 *
 * 若把 TSC/1 放到 8787 做同端口分流，就必须放开 8787 的公网可达性 ——
 * 那等于**同时废掉两件事**：① HTTP 的明文口令保护（口令会明文过网）；
 * ② XFF 可信前提（公网可直连即可伪造 XFF 绕过限流）。**为了省一个端口而拆掉两道防线，不划算。**
 *
 * 独立端口还带来两个实际好处：
 * - 两条链路的**信任模型不同**：TSC/1 端口上 `clientIp` 必须用真实 socket 地址，
 *   绝不采信 XFF（这里没有反代）。分开后这个差异是结构性的，不靠约定。
 * - 运维上可分别限流/封禁（`t1000-port-guard` 只需继续只管 8787）。
 *
 * 代价：需要额外开放一个端口。这是本部署可接受的（已有端口开放先例）。
 */

import { createServer as createTcpServer } from 'node:net'
import { normalizeIp } from '../util.js'
import { DEFAULT_HANDSHAKE_TIMEOUT_MS } from './crypto.js'
import { loadOrCreateIdentity } from './identity.js'
import { handleTsc1Connection } from './server.js'

/** 默认 TSC/1 端口 */
export const DEFAULT_TSC1_PORT = 8788

export function tsc1Port() {
  const raw = process.env.T1000_TSC1_PORT
  if (raw === undefined || raw === '') return DEFAULT_TSC1_PORT
  const port = Number(raw)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`T1000_TSC1_PORT 不合法: ${raw}`)
  }
  return port
}

export function tsc1Host() {
  return process.env.T1000_TSC1_HOST ?? '127.0.0.1'
}

/**
 * 单 IP 并发 TSC/1 连接上限，默认 **8**。
 *
 * 为什么是 8：客户端有通道复用池（一个 `host:port` 只建一条连接并复用），
 * 正常使用下并发连接数**接近 1**；8 是很宽松的余量（多开窗口 / 重连竞态）。
 * 真要跑多路复用也不该靠"开更多连接"。
 *
 * ## 为什么需要它
 * 握手阶段此前**没有任何限制** —— 记录层有帧长上限，但握手阶段没有，
 * 已建立连接数也无上限。这是公网暴露下最廉价的一类攻击：
 * 每个连接只发几个字节就能占住服务端资源。
 * 「收到首字节即判 magic」只挡住了非 TSC/1 流量（攻击的一半），
 * 这条补的是另一半：**限制合法握手前的资源占用**。
 */
export const DEFAULT_MAX_CONN_PER_IP = 8

export function tsc1MaxConnPerIp() {
  const raw = process.env.T1000_TSC1_MAX_CONN_PER_IP
  if (raw === undefined || raw === '') return DEFAULT_MAX_CONN_PER_IP
  const n = Number(raw)
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`T1000_TSC1_MAX_CONN_PER_IP 不合法: ${raw}`)
  }
  return n
}

export { DEFAULT_HANDSHAKE_TIMEOUT_MS }

export function tsc1HandshakeTimeoutMs() {
  const raw = process.env.T1000_TSC1_HANDSHAKE_TIMEOUT_MS
  if (raw === undefined || raw === '') return DEFAULT_HANDSHAKE_TIMEOUT_MS
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`T1000_TSC1_HANDSHAKE_TIMEOUT_MS 不合法: ${raw}`)
  }
  return n
}

/**
 * 创建 TSC/1 服务器。
 *
 * @param opts.dispatch  路由分发函数（index.js 的 dispatch）
 * @param opts.identity  身份密钥；省略则从数据目录载入/生成
 * @param opts.log       日志函数
 * @param opts.dataDir   数据目录（测试用临时目录）
 * @param opts.maxConnPerIp      覆盖单 IP 并发上限
 * @param opts.handshakeTimeoutMs 覆盖握手超时
 */
export function createTsc1Server(opts) {
  const { dispatch, log } = opts
  const identity = opts.identity ?? loadOrCreateIdentity(opts.dataDir)
  const maxConnPerIp = opts.maxConnPerIp ?? tsc1MaxConnPerIp()
  const handshakeTimeoutMs = opts.handshakeTimeoutMs ?? tsc1HandshakeTimeoutMs()

  if (identity.warning) log(`TSC1 warning ${identity.warning}`)
  log(`TSC1 identity fingerprint ${identity.fingerprint}${identity.created ? ' (newly generated)' : ''}`)

  /**
   * 每个 IP 当前活着的连接数。
   *
   * 计数在 accept 时 +1、socket 关闭时 -1。
   * 注意**在 accept 处就判**而不是"握手成功后再判"：攻击者正是靠
   * "连上但不完成握手"来占资源，如果等握手后才计数，限制就形同虚设。
   */
  const perIp = new Map()

  const server = createTcpServer((socket) => {
    // ⚠️ 这里是**真实**对端地址：TSC/1 端口是直连的，前面没有反代，
    //    因此绝不能像 HTTP 那样采信 X-Forwarded-For。
    const peerIp = normalizeIp(socket.remoteAddress ?? '')

    const current = perIp.get(peerIp) ?? 0
    if (current >= maxConnPerIp) {
      // 如实记录原因，不静默丢弃（只记 IP 与原因，不记对端数据）
      log(`TSC1 reject ip=${peerIp} code=TOO_MANY_CONNECTIONS active=${current} limit=${maxConnPerIp}`)
      socket.destroy()
      return
    }
    perIp.set(peerIp, current + 1)

    let released = false
    const release = () => {
      if (released) return
      released = true
      const n = (perIp.get(peerIp) ?? 1) - 1
      if (n <= 0) perIp.delete(peerIp)
      else perIp.set(peerIp, n)
    }
    socket.once('close', release)

    socket.setNoDelay(true)
    handleTsc1Connection(socket, { identity, log, dispatch, peerIp, handshakeTimeoutMs })
  })

  // 便于测试与运维观测当前占用
  server.activeConnections = () => [...perIp.entries()]

  return { server, identity }
}

/** 启动监听 */
export function startTsc1Server(opts) {
  const { server, identity } = createTsc1Server(opts)
  const host = opts.host ?? tsc1Host()
  const port = opts.port ?? tsc1Port()

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      server.removeListener('error', reject)
      const address = server.address()
      opts.log(`TSC1 监听 tsc1://${host}:${typeof address === 'object' && address ? address.port : port}`)
      resolve({ server, identity })
    })
  })
}
