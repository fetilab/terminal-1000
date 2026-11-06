// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 代理连接：把 SOCKS4/5 与 HTTP(S) CONNECT 统一成一条到目标的 TCP 通道。
 *
 * 为什么自己实现而不是直接用 `socks` 包的 createConnection：
 * 需要支持 SOCKS4（参考实现支持），且要统一超时与错误语义。
 * `socks` 仍用于 SOCKS5 的用户名/密码认证场景。
 */

import { Socket } from 'node:net'
import { connect as tlsConnect } from 'node:tls'
import { AppError } from '../../errors'
import type { ProxyConfig } from '@t1000/shared'

/** 建立到 targetHost:targetPort 的代理隧道 */
export function createProxySocket(
  proxy: ProxyConfig,
  targetHost: string,
  targetPort: number,
): Socket {
  const parsed = parseProxyUrl(proxy)
  return new ProxyTunnel(parsed, targetHost, targetPort).connect()
}

interface ParsedProxy {
  protocol: 'socks5' | 'socks4' | 'http' | 'https'
  host: string
  port: number
  username?: string
  password?: string
}

/** 解析代理 URL；支持 socks5:// socks4:// http:// https:// */
export function parseProxyUrl(proxy: ProxyConfig): ParsedProxy {
  let url: URL
  try {
    url = new URL(proxy.url)
  } catch {
    // URL 解析器对越界端口只会笼统地报 "Invalid URL"。
    // 这里补一次精确探测，让用户看到真正的原因（端口越界 vs 地址格式错）。
    const portMatch = /:(\d+)(?:[/?#]|$)/.exec(proxy.url)
    if (portMatch?.[1]) {
      const raw = Number(portMatch[1])
      if (Number.isInteger(raw) && (raw <= 0 || raw > 65535)) {
        throw AppError.badRequest(`代理端口不合法: ${portMatch[1]}（有效范围 1-65535）`)
      }
    }
    throw AppError.badRequest(`代理地址不合法: ${proxy.url}`)
  }

  const protocol = url.protocol.replace(':', '') as ParsedProxy['protocol']
  if (!['socks5', 'socks4', 'http', 'https'].includes(protocol)) {
    throw AppError.unsupported(`不支持的代理协议: ${protocol}`)
  }

  const port = url.port
    ? Number(url.port)
    : protocol === 'socks5' || protocol === 'socks4'
      ? 1080
      : protocol === 'https'
        ? 443
        : 8080

  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw AppError.badRequest(`代理端口不合法: ${url.port}`)
  }

  return {
    protocol,
    host: url.hostname,
    port,
    ...(url.username ? { username: decodeURIComponent(url.username) } : {}),
    ...(url.password ? { password: decodeURIComponent(url.password) } : {}),
  }
}

/**
 * 代理隧道。
 *
 * SOCKS5 三次握手：认证协商 → （可选）用户名密码 → CONNECT 请求
 * SOCKS4  两段：CONNECT 请求 → 响应
 * HTTP(S) CONNECT 一段 + 响应头解析
 */
class ProxyTunnel {
  private socket: Socket | null = null

  constructor(
    private readonly proxy: ParsedProxy,
    private readonly targetHost: string,
    private readonly targetPort: number,
  ) {}

  connect(): Socket {
    const p = this.proxy

    if (p.protocol === 'https') {
      // 到代理本身是 TLS
      const sock = tlsConnect({ host: p.host, port: p.port, servername: p.host }) as unknown as Socket
      this.socket = sock
      sock.once('secureConnect', () => this.handshakeHttp(p.username, p.password))
      sock.once('error', () => {
        /* 错误通过 socket 事件向上传播 */
      })
      return sock
    }

    const sock = new Socket()
    this.socket = sock
    sock.once('connect', () => {
      if (p.protocol === 'socks5') this.handshakeSocks5(p.username, p.password)
      else if (p.protocol === 'socks4') this.handshakeSocks4()
      else this.handshakeHttp(p.username, p.password)
    })
    sock.connect(p.port, p.host)
    return sock
  }

  private fail(message: string, code: string): void {
    this.socket?.destroy(new AppError('INTERNAL', `${message} (${code})`))
  }

  /** SOCKS5：版本协商 → 认证 → CONNECT */
  private handshakeSocks5(username?: string, password?: string): void {
    const sock = this.socket
    if (!sock) return

    const useAuth = Boolean(username)
    // [ver=5, nmethods, method...]  0x00=无认证 0x02=用户密码
    const greeting = useAuth ? Buffer.from([0x05, 0x02, 0x00, 0x02]) : Buffer.from([0x05, 0x01, 0x00])
    sock.write(greeting)

    const onGreeting = (data: Buffer): void => {
      if (data.length < 2 || data[0] !== 0x05) {
        return this.fail('SOCKS5 协商失败', 'BAD_VERSION')
      }
      const method = data[1]
      if (method === 0x02) {
        if (!username) return this.fail('代理要求用户名密码', 'AUTH_REQUIRED')
        const u = Buffer.from(username, 'utf8')
        const p = Buffer.from(password ?? '', 'utf8')
        sock.write(Buffer.concat([Buffer.from([0x01, u.length]), u, Buffer.from([p.length]), p]))
        sock.once('data', (d: Buffer) => {
          if (d.length < 2 || d[1] !== 0x00) return this.fail('代理认证失败', 'AUTH_FAILED')
          this.socks5Connect()
        })
        return
      }
      if (method !== 0x00) return this.fail('代理不接受可用认证方式', 'NO_ACCEPTABLE_METHOD')
      this.socks5Connect()
    }

    sock.once('data', onGreeting)
  }

  private socks5Connect(): void {
    const sock = this.socket
    if (!sock) return

    const addr = encodeSocks5Target(this.targetHost, this.targetPort)
    // [ver, cmd=CONNECT, rsv=0, atyp, addr, port]
    sock.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00]), addr]))

    sock.once('data', (data: Buffer) => {
      if (data.length < 2) return this.fail('SOCKS5 响应过短', 'SHORT_RESPONSE')
      if (data[1] !== 0x00) {
        return this.fail(`SOCKS5 连接被拒 (reply=${data[1]})`, 'CONNECT_REFUSED')
      }
      // 握手完成，后续数据即目标流（socket 上残留的 data 已由 once 消费）
      sock.removeAllListeners('data')
    })
  }

  /** SOCKS4 / 4a */
  private handshakeSocks4(): void {
    const sock = this.socket
    if (!sock) return

    const isV4Addr = /^\d{1,3}(\.\d{1,3}){3}$/.test(this.targetHost)
    let request: Buffer

    if (isV4Addr) {
      request = Buffer.concat([
        Buffer.from([0x04, 0x01]),
        Buffer.from([this.targetPort >> 8, this.targetPort & 0xff]),
        Buffer.from(this.targetHost.split('.').map((n) => Number(n))),
        Buffer.from([0x00]), // 空 userid
      ])
    } else {
      // SOCKS4a：地址填 0.0.0.x + 域名
      request = Buffer.concat([
        Buffer.from([0x04, 0x01]),
        Buffer.from([this.targetPort >> 8, this.targetPort & 0xff]),
        Buffer.from([0, 0, 0, 1]),
        Buffer.from([0x00]),
        Buffer.from(this.targetHost, 'utf8'),
        Buffer.from([0x00]),
      ])
    }

    sock.write(request)
    sock.once('data', (data: Buffer) => {
      if (data.length < 2) return this.fail('SOCKS4 响应过短', 'SHORT_RESPONSE')
      if (data[1] !== 0x5a) return this.fail(`SOCKS4 连接被拒 (code=${data[1]})`, 'CONNECT_REFUSED')
      sock.removeAllListeners('data')
    })
  }

  /** HTTP CONNECT */
  private handshakeHttp(username?: string, password?: string): void {
    const sock = this.socket
    if (!sock) return

    const hostHeader =
      this.targetHost.includes(':') && !this.targetHost.startsWith('[')
        ? `[${this.targetHost}]:${this.targetPort}`
        : `${this.targetHost}:${this.targetPort}`

    const lines = [`CONNECT ${hostHeader} HTTP/1.1`, `Host: ${hostHeader}`, 'Proxy-Connection: keep-alive']

    if (username) {
      const token = Buffer.from(`${username}:${password ?? ''}`, 'utf8').toString('base64')
      lines.push(`Proxy-Authorization: Basic ${token}`)
    }
    lines.push('', '')

    sock.write(lines.join('\r\n'))

    let buf = ''
    const onData = (chunk: Buffer): void => {
      buf += chunk.toString('latin1')
      const end = buf.indexOf('\r\n\r\n')
      if (end === -1) {
        if (buf.length > 64 * 1024) this.fail('代理响应头过大', 'HEADER_TOO_LARGE')
        return
      }
      sock.removeListener('data', onData)

      const statusLine = buf.split('\r\n', 1)[0] ?? ''
      const m = /^HTTP\/\d\.\d\s+(\d{3})/.exec(statusLine)
      if (!m) return this.fail('代理响应格式异常', 'BAD_RESPONSE')
      const code = Number(m[1])
      if (code !== 200) return this.fail(`代理 CONNECT 失败 HTTP ${code}`, `HTTP_${code}`)
      // 响应头之后的字节属于目标流；为简化先丢弃（CONNECT 响应后不应有载荷）
    }
    sock.on('data', onData)
  }
}

/** 按 SOCKS5 ATYP 编码目标地址（导出以便单测） */
export function encodeSocks5Target(host: string, port: number): Buffer {
  const portBuf = Buffer.from([port >> 8, port & 0xff])

  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    return Buffer.concat([Buffer.from([0x01]), Buffer.from(host.split('.').map(Number)), portBuf])
  }

  // IPv6
  if (host.includes(':')) {
    const groups = expandIpv6(host)
    if (groups) {
      return Buffer.concat([Buffer.from([0x04]), Buffer.from(groups), portBuf])
    }
  }

  const name = Buffer.from(host, 'utf8')
  if (name.length > 255) throw AppError.badRequest('域名过长')
  return Buffer.concat([Buffer.from([0x03, name.length]), name, portBuf])
}

/** 把 IPv6 文本展开成 16 字节（导出以便单测） */
export function expandIpv6(host: string): number[] | null {
  const parts = host.split('::')
  if (parts.length > 2) return null

  const head = parts[0] ? parts[0].split(':') : []
  const tail = parts.length === 2 && parts[1] ? parts[1].split(':') : []

  const missing = 8 - head.length - tail.length
  if (missing < 0) return null

  const groups = [...head, ...Array<string>(missing).fill('0'), ...tail]
  if (groups.length !== 8) return null

  const bytes: number[] = []
  for (const g of groups) {
    const n = parseInt(g || '0', 16)
    if (!Number.isFinite(n) || n < 0 || n > 0xffff) return null
    bytes.push(n >> 8, n & 0xff)
  }
  return bytes
}
