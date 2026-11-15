// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * **对已部署服务端**的 TSC/1 端到端验收（门控：设 `T1000_TSC1_E2E=host:port` 才跑）。
 *
 * 与 `channel.e2e.test.ts` 的区别：那个在进程内起服务端，验证协议互通；
 * 这个连**真实部署的**服务端（当前是 .187 的 8788，经 IPv6 域名），
 * 验证的是"这套东西在公网上真的能用"—— 包括 TOFU 指纹核对与完整业务链路。
 *
 * 平时 skip，不让日常测试依赖外部机器（与 VNC/RDP 的门控 E2E 同一套做法）。
 *
 * 运行示例：
 *   T1000_TSC1_E2E=mc.mosfetech.de5.net:8788 pnpm vitest run src/main/services/sync/channel.remote.test.ts
 */

import { describe, expect, it } from 'vitest'
import { SecureChannel } from './channel'

const target = process.env['T1000_TSC1_E2E']
const [host, portRaw] = (target ?? '').split(':')
const port = Number(portRaw ?? 0)

const enabled = host !== undefined && host !== '' && Number.isInteger(port) && port > 0

describe.skipIf(!enabled)('TSC/1 对已部署服务端的真机验收', () => {
  it('★ 探测身份（只握手不发数据）并拿到指纹', async () => {
    const probed = await SecureChannel.probe(host!, port)
    // 指纹格式：8 组 4 字符（便于口述核对）
    expect(probed.fingerprint).toMatch(/^[0-9a-f]{32}$/)
    expect(probed.publicKey).toHaveLength(32)
  }, 20000)

  it('★ 钉扎后能完成完整业务往返（注册 → 推送 → 拉回）', async () => {
    // 1) 探测拿到身份 → 作为钉扎（真机上这一步应当由用户带外核对指纹）
    const probed = await SecureChannel.probe(host!, port)
    const ch = await SecureChannel.connect({
      host: host!,
      port,
      pinnedFingerprint: probed.fingerprint,
      pinnedPublicKey: probed.publicKey,
    })

    // 2) 注册一个临时账号（用户名带时间戳，避免与既有账号冲突）
    const username = `e2e${Date.now().toString(36)}`
    const reg = await ch.request('/api/v1/register', {
      method: 'POST',
      body: { username, password: 'E2e#Passw0rd!2026' },
    })
    expect(reg.status).toBe(200)
    const token = (reg.body as { token?: string } | undefined)?.token
    expect(typeof token).toBe('string')

    // 3) 推送一段"密文"（服务端只存密文，这里用 base64 字符串模拟）
    const ciphertext = Buffer.from('tsc1-e2e-payload'.repeat(20)).toString('base64')
    const pushed = await ch.request('/api/v1/blobs/conn-1', {
      method: 'PUT',
      token: token!,
      body: { ciphertext },
    })
    expect(pushed.status).toBe(200)

    // 4) 拉回并逐字节比对
    const pulled = await ch.request('/api/v1/blobs/conn-1', { method: 'GET', token: token! })
    expect(pulled.status).toBe(200)
    const back = (pulled.body as { ciphertext?: string } | undefined)?.ciphertext
    expect(Buffer.from(back ?? '', 'base64').toString()).toBe('tsc1-e2e-payload'.repeat(20))

    // 5) 无令牌必须被拒（鉴权在通道内仍然生效 —— 加密**不替代**认证）
    const noAuth = await ch.request('/api/v1/blobs/conn-1', { method: 'GET' })
    expect(noAuth.status).toBe(401)

    ch.close()
  }, 30000)

  it('★ 指纹不符 → 拒绝连接（防换人）', async () => {
    const err = await SecureChannel.connect({
      host: host!,
      port,
      pinnedFingerprint: 'deadbeefdeadbeefdeadbeefdeadbeef',
      pinnedPublicKey: Buffer.alloc(32, 7),
    }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    expect(String((err as Error).message)).toMatch(/中间人|不一致|pin/)
  }, 20000)
})
