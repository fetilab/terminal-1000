// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 更新检查的纯逻辑测试。
 *
 * 这里最要紧的是 **`isAllowedUpdateUrl`：它是安全边界** ——
 * 判断错了就等于给用户开了一条明文更新通道（"检查"是安全的、"点下载"却被送到 http，
 * 那这一环等于白做）。所以 https / 非 loopback http 的组合要逐个钉住。
 */

import { describe, expect, it } from 'vitest'
import { compareVersions, isAllowedUpdateUrl, parseManifest } from './index'

describe('compareVersions 版本比较', () => {
  it('按数字段比较，而不是字符串比较', () => {
    // 字符串比较会得出 "0.10.0" < "0.9.0" 的错误结论
    expect(compareVersions('0.10.0', '0.9.0')).toBeGreaterThan(0)
    expect(compareVersions('1.0.0', '0.99.99')).toBeGreaterThan(0)
    expect(compareVersions('0.1.0', '0.1.0')).toBe(0)
  })

  it('段数不同时缺位按 0 处理', () => {
    expect(compareVersions('1.2', '1.2.0')).toBe(0)
    expect(compareVersions('1.2.1', '1.2')).toBeGreaterThan(0)
  })

  it('★ 预发布版本小于同号正式版（0.2.0-beta < 0.2.0）', () => {
    expect(compareVersions('0.2.0-beta', '0.2.0')).toBeLessThan(0)
    expect(compareVersions('0.2.0', '0.2.0-beta')).toBeGreaterThan(0)
    // 但预发布版本仍**大于**更早的正式版
    expect(compareVersions('0.2.0-beta', '0.1.9')).toBeGreaterThan(0)
  })

  it('容忍前缀 v 与空白（更新源写法不统一）', () => {
    expect(compareVersions('v1.0.0', '1.0.0')).toBe(0)
    expect(compareVersions(' 1.0.0 ', '1.0.0')).toBe(0)
  })

  it('非法段按 0 处理而不是抛错（畸形清单不该让检查崩掉）', () => {
    expect(compareVersions('1.x.0', '1.0.0')).toBe(0)
  })
})

describe('isAllowedUpdateUrl 安全边界', () => {
  it('https 一律允许', () => {
    expect(isAllowedUpdateUrl('https://example.com/update.json').ok).toBe(true)
  })

  it('★ 非 loopback 的 http 一律拒绝（明文更新通道）', () => {
    for (const u of [
      'http://example.com/update.json',
      'http://192.0.2.10/update.json',
      'http://10.0.0.1/x.json',
    ]) {
      const r = isAllowedUpdateUrl(u)
      expect(r.ok, `${u} 不应被允许`).toBe(false)
      expect(r.reason).toMatch(/https/)
    }
  })

  it('loopback 上的 http 允许（本地/内网自建源与测试）', () => {
    for (const u of [
      'http://127.0.0.1:8080/update.json',
      'http://localhost/update.json',
      'http://[::1]:9000/update.json',
    ]) {
      expect(isAllowedUpdateUrl(u).ok, `${u} 应被允许`).toBe(true)
    }
  })

  it('非 http(s) 协议一律拒绝（file: 读本地文件、其它协议等）', () => {
    for (const u of ['file:///etc/passwd', 'ftp://x/y', 'data:text/plain,x']) {
      expect(isAllowedUpdateUrl(u).ok, `${u} 不应被允许`).toBe(false)
    }
  })

  it('非法 URL 返回可读原因而不是抛错', () => {
    const r = isAllowedUpdateUrl('not a url')
    expect(r.ok).toBe(false)
    expect(r.reason).toBeTruthy()
  })

  it('★ 不能靠伪装绕过：http + 形似本地的主机名仍要拒', () => {
    // 域名以 localhost 开头、但不是 loopback 地址
    expect(isAllowedUpdateUrl('http://localhost.evil.com/x.json').ok).toBe(false)
    // 127.x 只有 127.0.0.1 是 loopback（这里按主机名精确匹配，不做网段推断）
    expect(isAllowedUpdateUrl('http://127.0.0.2/x.json').ok).toBe(false)
  })
})

describe('parseManifest 清单解析', () => {
  it('支持 channels 形状（按通道取）', () => {
    const raw = {
      channels: {
        stable: { version: '1.0.0', notes: '稳定版说明', url: 'https://x/1.0.0' },
        beta: { version: '1.1.0-beta.1', notes: '测试版说明' },
      },
    }
    expect(parseManifest(raw, 'stable')?.version).toBe('1.0.0')
    expect(parseManifest(raw, 'beta')?.version).toBe('1.1.0-beta.1')
    expect(parseManifest(raw, 'stable')?.notes).toBe('稳定版说明')
  })

  it('支持扁平形状（视为当前通道）', () => {
    expect(parseManifest({ version: '2.0.0', url: 'https://x/2.0.0' }, 'dev')?.version).toBe('2.0.0')
  })

  it('通道在清单里不存在时返回 null（不是"已是最新"）', () => {
    expect(parseManifest({ channels: { stable: { version: '1.0.0' } } }, 'beta')).toBeNull()
  })

  it('缺少 version 或形状不对时返回 null', () => {
    expect(parseManifest({ channels: { stable: {} } }, 'stable')).toBeNull()
    expect(parseManifest({ notes: '只有说明' }, 'stable')).toBeNull()
    expect(parseManifest(null, 'stable')).toBeNull()
    expect(parseManifest('字符串', 'stable')).toBeNull()
    expect(parseManifest([], 'stable')).toBeNull()
  })

  it('可选字段缺失时不报错（只有 version 也算合法清单）', () => {
    const r = parseManifest({ version: '1.0.0' }, 'stable')
    expect(r?.version).toBe('1.0.0')
    expect(r?.url).toBeUndefined()
    expect(r?.notes).toBeUndefined()
  })
})
