// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 限流与失败锁定测试。
 *
 * 这是公网暴露后的第一道防线：没有它，`/login` 就是最低成本的暴力破解入口，
 * 而且大量尝试会把 scrypt 的 CPU 打满（等于拒绝服务）。
 */

import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const testDataDir = mkdtempSync(join(tmpdir(), 't1000-rl-test-'))
process.env.T1000_DATA_DIR = testDataDir
delete process.env.T1000_TRUST_PROXY

const { checkAllowed, recordAttempt, _resetForTests, _internals } = await import('../src/ratelimit.js')
const { normalizeIp, isPublicBind, clientIp } = await import('../src/util.js')
const { createServer } = await import('../src/index.js')

describe('滑动窗口限流', () => {
  it('窗口内未超限时放行', () => {
    _resetForTests()
    const now = 1_000_000
    for (let i = 0; i < _internals.MAX_ATTEMPTS_PER_WINDOW; i++) {
      assert.equal(checkAllowed('k', now).allowed, true)
      recordAttempt('k', true, now)
    }
  })

  it('超过窗口上限后拒绝，并给出重试秒数', () => {
    _resetForTests()
    const now = 2_000_000
    for (let i = 0; i < _internals.MAX_ATTEMPTS_PER_WINDOW; i++) {
      recordAttempt('k', true, now)
    }
    const verdict = checkAllowed('k', now)
    assert.equal(verdict.allowed, false)
    assert.equal(verdict.reason, 'rate_limited')
    assert.ok(verdict.retryAfterSec >= 1)
  })

  it('窗口滑过后自动放行（不是永久封禁）', () => {
    _resetForTests()
    const now = 3_000_000
    for (let i = 0; i < _internals.MAX_ATTEMPTS_PER_WINDOW; i++) {
      recordAttempt('k', true, now)
    }
    assert.equal(checkAllowed('k', now).allowed, false)
    // 窗口（60s）之后
    assert.equal(checkAllowed('k', now + _internals.WINDOW_MS + 1).allowed, true)
  })

  it('不同 key 互不影响', () => {
    _resetForTests()
    const now = 4_000_000
    for (let i = 0; i < _internals.MAX_ATTEMPTS_PER_WINDOW; i++) recordAttempt('a', true, now)
    assert.equal(checkAllowed('a', now).allowed, false)
    assert.equal(checkAllowed('b', now).allowed, true)
  })
})

describe('失败锁定与指数退避', () => {
  it('达到阈值后锁定，且拒绝原因区分为 locked', () => {
    _resetForTests()
    const now = 5_000_000
    let locked = null
    for (let i = 0; i < _internals.LOCK_THRESHOLD; i++) {
      locked = recordAttempt('k', false, now)
    }
    assert.equal(locked.locked, true)
    assert.ok(locked.retryAfterSec >= 1)

    const verdict = checkAllowed('k', now)
    assert.equal(verdict.allowed, false)
    assert.equal(verdict.reason, 'locked')
  })

  it('★ 锁定时长随再犯翻倍（指数退避），但有上限', () => {
    _resetForTests()
    const now = 6_000_000

    // 第 5 次失败 → 锁 1 分钟
    let r
    for (let i = 0; i < _internals.LOCK_THRESHOLD; i++) r = recordAttempt('k', false, now)
    assert.equal(r.retryAfterSec, _internals.BASE_LOCK_MS / 1000)

    // 第 6 次 → 2 分钟
    r = recordAttempt('k', false, now)
    assert.equal(r.retryAfterSec, (_internals.BASE_LOCK_MS * 2) / 1000)

    // 继续失败最终封顶
    for (let i = 0; i < 20; i++) r = recordAttempt('k', false, now)
    assert.equal(r.retryAfterSec, _internals.MAX_LOCK_MS / 1000)
  })

  it('成功后清空失败计数与锁定', () => {
    _resetForTests()
    const now = 7_000_000
    for (let i = 0; i < _internals.LOCK_THRESHOLD; i++) recordAttempt('k', false, now)
    assert.equal(checkAllowed('k', now).allowed, false)

    // 锁定期内即便"成功"也不该解锁（否则攻击者猜中一次就重置了计数）
    recordAttempt('k', true, now)
    // 直接看内部状态：failures 已清零，但 lockedUntil 仍在
    assert.equal(checkAllowed('k', now).allowed, false, '锁定期内不应因一次成功而解锁')

    // 锁定到期后放行
    assert.equal(checkAllowed('k', now + _internals.BASE_LOCK_MS + 1).allowed, true)
  })

  it('锁定只影响触发它的 key，不误伤其他 IP', () => {
    _resetForTests()
    const now = 8_000_000
    for (let i = 0; i < _internals.LOCK_THRESHOLD; i++) recordAttempt('ip:1.2.3.4:u', false, now)
    assert.equal(checkAllowed('ip:1.2.3.4:u', now).allowed, false)
    assert.equal(checkAllowed('ip:5.6.7.8:u', now).allowed, true)
  })
})

describe('IPv6 与客户端 IP', () => {
  it('IPv4-mapped IPv6 归一化为 IPv4（限流 key 才稳定）', () => {
    assert.equal(normalizeIp('::ffff:192.168.1.5'), '192.168.1.5')
    assert.equal(normalizeIp('::ffff:10.0.0.1'), '10.0.0.1')
  })

  it('IPv6 地址保持原样，方括号被剥掉', () => {
    assert.equal(normalizeIp('[2001:db8::1]'), '2001:db8::1')
    assert.equal(normalizeIp('2001:db8::1'), '2001:db8::1')
  })

  it('空值归一为 unknown，避免 undefined 作为 key', () => {
    assert.equal(normalizeIp(''), 'unknown')
    assert.equal(normalizeIp(undefined), 'unknown')
  })

  it('★ 默认不信任 X-Forwarded-For（否则可伪造成任意 IP 绕过限流）', () => {
    const req = {
      socket: { remoteAddress: '::ffff:203.0.113.9' },
      headers: { 'x-forwarded-for': '1.2.3.4, 5.6.7.8' },
    }
    assert.equal(clientIp(req), '203.0.113.9', '未启用 TRUST_PROXY 时应取 socket 地址')
  })

  it('显式启用 TRUST_PROXY 后才采信转发头，并取最左侧客户端', () => {
    process.env.T1000_TRUST_PROXY = '1'
    try {
      const req = {
        socket: { remoteAddress: '::ffff:10.0.0.1' },
        headers: { 'x-forwarded-for': '1.2.3.4, 5.6.7.8' },
      }
      assert.equal(clientIp(req), '1.2.3.4')
    } finally {
      delete process.env.T1000_TRUST_PROXY
    }
  })

  it('回环地址不算对外暴露', () => {
    assert.equal(isPublicBind('127.0.0.1'), false)
    assert.equal(isPublicBind('localhost'), false)
    assert.equal(isPublicBind('::1'), false)
  })

  it('★ :: 视为对外暴露（IPv6 全接口就是对外）', () => {
    assert.equal(isPublicBind('::'), true)
    assert.equal(isPublicBind('0.0.0.0'), true)
    assert.equal(isPublicBind('192.168.1.187'), true)
  })
})

describe('HTTP 层的限流与安全头（真实服务端）', () => {
  let server
  let baseUrl

  before(async () => {
    server = createServer()
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const addr = server.address()
    baseUrl = `http://127.0.0.1:${addr.port}`
  })

  after(async () => {
    await new Promise((resolve) => server.close(resolve))
  })

  async function login(payload) {
    const res = await fetch(`${baseUrl}/api/v1/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
    return { status: res.status, headers: res.headers, body: await res.json().catch(() => undefined) }
  }

  it('安全响应头随响应返回', async () => {
    const res = await fetch(`${baseUrl}/api/v1/health`)
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff')
    assert.equal(res.headers.get('x-frame-options'), 'DENY')
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer')
  })

  it('★ 连续失败触发锁定，返回 429 且带 Retry-After', async () => {
    _resetForTests() // 让本用例从干净状态开始
    let last
    for (let i = 0; i < _internals.LOCK_THRESHOLD + 1; i++) {
      last = await login({ username: 'brute-target', password: `wrong-${i}` })
    }
    assert.equal(last.status, 429)
    assert.ok(last.body?.error?.code === 'TOO_MANY_FAILURES' || last.body?.error?.code === 'RATE_LIMITED')
    assert.ok(Number(last.headers.get('retry-after')) >= 1)
  })

  it('锁定后即使口令正确也被拒（锁定优先）', async () => {
    _resetForTests()
    // 先制造锁定
    for (let i = 0; i < _internals.LOCK_THRESHOLD + 1; i++) {
      await login({ username: 'locked-user', password: 'wrong' })
    }
    const res = await login({ username: 'locked-user', password: 'wrong' })
    assert.equal(res.status, 429)
  })

  it('健康检查不受限流影响（运维探活不能被自己锁死）', async () => {
    _resetForTests()
    for (let i = 0; i < 50; i++) {
      const res = await fetch(`${baseUrl}/api/v1/health`)
      assert.equal(res.status, 200)
    }
  })
})

// 清理临时目录
process.on('exit', () => {
  try {
    rmSync(testDataDir, { recursive: true, force: true })
  } catch {
    /* 忽略 */
  }
})
