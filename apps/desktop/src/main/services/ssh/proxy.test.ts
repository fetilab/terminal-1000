// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

import { describe, expect, it } from 'vitest'
import { parseProxyUrl, encodeSocks5Target, expandIpv6 } from './proxy'

describe('parseProxyUrl', () => {
  it('解析 socks5 并套用默认端口 1080', () => {
    const p = parseProxyUrl({ url: 'socks5://127.0.0.1' })
    expect(p.protocol).toBe('socks5')
    expect(p.host).toBe('127.0.0.1')
    expect(p.port).toBe(1080)
  })

  it('解析 socks4（参考实现支持的旧协议）', () => {
    const p = parseProxyUrl({ url: 'socks4://proxy.local:1081' })
    expect(p.protocol).toBe('socks4')
    expect(p.port).toBe(1081)
  })

  it('解析 http 并套用默认端口 8080', () => {
    const p = parseProxyUrl({ url: 'http://proxy.local' })
    expect(p.protocol).toBe('http')
    expect(p.port).toBe(8080)
  })

  it('解析 https 并套用默认端口 443', () => {
    const p = parseProxyUrl({ url: 'https://secure.proxy' })
    expect(p.protocol).toBe('https')
    expect(p.port).toBe(443)
  })

  it('提取并解码用户名密码', () => {
    const p = parseProxyUrl({ url: 'socks5://user%40name:p%3Ass@127.0.0.1:1080' })
    expect(p.username).toBe('user@name')
    expect(p.password).toBe('p:ss')
  })

  it('无凭据时不带 username/password 字段', () => {
    const p = parseProxyUrl({ url: 'socks5://127.0.0.1:1080' })
    expect(p.username).toBeUndefined()
    expect(p.password).toBeUndefined()
  })

  it('拒绝不支持的协议', () => {
    expect(() => parseProxyUrl({ url: 'ftp://127.0.0.1' })).toThrow(/不支持的代理协议/)
  })

  it('拒绝非法 URL', () => {
    expect(() => parseProxyUrl({ url: 'not a url' })).toThrow(/不合法/)
  })

  it('拒绝越界端口', () => {
    expect(() => parseProxyUrl({ url: 'socks5://127.0.0.1:99999' })).toThrow(/端口不合法/)
  })

  it('使用 URL 里的显式端口', () => {
    const p = parseProxyUrl({ url: 'socks5://10.0.0.1:9050' })
    expect(p.port).toBe(9050)
  })
})

describe('expandIpv6', () => {
  it('展开完整 8 组地址', () => {
    const b = expandIpv6('2001:db8:0:0:0:0:0:1')
    expect(b).toHaveLength(16)
    expect(b).toEqual([0x20, 0x01, 0x0d, 0xb8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x01])
  })

  it('展开 :: 简写（中段压缩）', () => {
    const b = expandIpv6('2001:db8::1')
    expect(b).toHaveLength(16)
    expect(b).toEqual([0x20, 0x01, 0x0d, 0xb8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x01])
  })

  it('展开 :: 在末尾', () => {
    const b = expandIpv6('fe80::')
    expect(b).toHaveLength(16)
    expect(b?.slice(0, 2)).toEqual([0xfe, 0x80])
    expect(b?.slice(2)).toEqual(new Array(14).fill(0))
  })

  it('展开 ::1（回环）', () => {
    const b = expandIpv6('::1')
    expect(b).toHaveLength(16)
    expect(b?.[15]).toBe(1)
    expect(b?.slice(0, 15)).toEqual(new Array(15).fill(0))
  })

  it('组数超出 8 时返回 null（非法地址）', () => {
    expect(expandIpv6('1:2:3:4:5:6:7:8:9')).toBeNull()
  })

  it('出现多个 :: 时返回 null', () => {
    expect(expandIpv6('2001::db8::1')).toBeNull()
  })

  it('含非法十六进制时返回 null', () => {
    expect(expandIpv6('2001:zzzz::1')).toBeNull()
  })
})

describe('encodeSocks5Target', () => {
  it('IPv4 用 ATYP=0x01 且为紧凑 4 字节', () => {
    const b = encodeSocks5Target('192.0.2.10', 22)
    expect(b[0]).toBe(0x01)
    expect(b).toHaveLength(1 + 4 + 2)
    expect([...b.subarray(1, 5)]).toEqual([192, 0, 2, 10])
    // 端口大端
    expect([...b.subarray(5, 7)]).toEqual([0x00, 0x16])
  })

  it('域名用 ATYP=0x03 且带长度前缀', () => {
    const b = encodeSocks5Target('example.com', 443)
    expect(b[0]).toBe(0x03)
    expect(b[1]).toBe('example.com'.length)
    expect(b.subarray(2, 2 + 11).toString('utf8')).toBe('example.com')
    expect([...b.subarray(b.length - 2)]).toEqual([0x01, 0xbb])
  })

  it('IPv6 用 ATYP=0x04 且为 16 字节', () => {
    const b = encodeSocks5Target('::1', 80)
    expect(b[0]).toBe(0x04)
    expect(b).toHaveLength(1 + 16 + 2)
    expect([...b.subarray(b.length - 2)]).toEqual([0x00, 0x50])
  })

  it('IPv6 无法解析时退化为域名编码', () => {
    // 含冒号但非法 → 走域名分支（长度 5）
    const b = encodeSocks5Target('1:2:3:4:5:6:7:8:9', 22)
    expect(b[0]).toBe(0x03)
    expect(b[1]).toBe('1:2:3:4:5:6:7:8:9'.length)
  })

  it('端口按大端编码（跨字节边界）', () => {
    expect([...encodeSocks5Target('1.1.1.1', 0x1234).subarray(5, 7)]).toEqual([0x12, 0x34])
    expect([...encodeSocks5Target('1.1.1.1', 65535).subarray(5, 7)]).toEqual([0xff, 0xff])
  })

  it('超长域名抛错（协议限制 255 字节）', () => {
    expect(() => encodeSocks5Target('a'.repeat(256), 22)).toThrow(/域名过长/)
  })
})
