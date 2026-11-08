// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 同步后端测试。
 *
 * 用真实 HTTP 服务 + 临时数据目录跑端到端，而不是只测函数：
 * 鉴权、路由、状态码、多租户隔离这些都在 HTTP 层才暴露得出来。
 */

import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 必须在 import 业务模块之前指定数据目录（模块在调用时读取该环境变量）
const testDataDir = mkdtempSync(join(tmpdir(), 't1000-sync-test-'))
process.env.T1000_DATA_DIR = testDataDir
process.env.T1000_MAX_BODY_BYTES = String(64 * 1024 * 1024)
// 本文件测的是 API 语义（鉴权/隔离/版本冲突），不是限流；
// 调高阈值避免自动化请求把自己锁死。限流本身由 ratelimit.test.js 专门验证。
process.env.T1000_RATE_MAX_ATTEMPTS = '100000'
process.env.T1000_LOCK_THRESHOLD = '100000'

const { createServer } = await import('../src/index.js')

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
  rmSync(testDataDir, { recursive: true, force: true })
})

/** 简易请求助手 */
async function req(method, path, { token, body } = {}) {
  const headers = {}
  if (token) headers.authorization = `Bearer ${token}`
  if (body !== undefined) headers['content-type'] = 'application/json'

  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let json
  try {
    json = text ? JSON.parse(text) : undefined
  } catch {
    json = undefined
  }
  return { status: res.status, body: json, raw: text }
}

async function registerUser(username) {
  const r = await req('POST', '/api/v1/register', { body: { username, password: 'passw0rd-strong' } })
  assert.equal(r.status, 200, `注册应成功，实际 ${r.status}: ${r.raw}`)
  return r.body.token
}

describe('健康检查', () => {
  it('返回服务信息且不需要鉴权', async () => {
    const r = await req('GET', '/api/v1/health')
    assert.equal(r.status, 200)
    assert.equal(r.body.ok, true)
    assert.equal(r.body.service, 'terminal-1000-sync')
  })
})

describe('账号', () => {
  it('注册成功并返回令牌', async () => {
    const r = await req('POST', '/api/v1/register', {
      body: { username: 'alice', password: 'passw0rd-strong' },
    })
    assert.equal(r.status, 200)
    assert.ok(r.body.token)
    assert.equal(r.body.username, 'alice')
  })

  it('重复注册返回 409', async () => {
    const r = await req('POST', '/api/v1/register', {
      body: { username: 'alice', password: 'passw0rd-strong' },
    })
    assert.equal(r.status, 409)
    assert.equal(r.body.error.code, 'USER_EXISTS')
  })

  it('口令过短被拒', async () => {
    const r = await req('POST', '/api/v1/register', { body: { username: 'shorty', password: '123' } })
    assert.equal(r.status, 400)
    assert.equal(r.body.error.code, 'PASSWORD_WEAK')
  })

  it('非法用户名被拒（含路径穿越尝试）', async () => {
    for (const username of ['../evil', 'a b', 'x', 'a/b']) {
      const r = await req('POST', '/api/v1/register', { body: { username, password: 'passw0rd-strong' } })
      assert.equal(r.status, 400, `用户名 ${username} 应被拒绝`)
      assert.equal(r.body.error.code, 'USERNAME_INVALID')
    }
  })

  it('口令错误返回 401', async () => {
    const r = await req('POST', '/api/v1/login', { body: { username: 'alice', password: 'wrong-password' } })
    assert.equal(r.status, 401)
    assert.equal(r.body.error.code, 'INVALID_CREDENTIALS')
  })

  it('不存在的用户与口令错误返回相同信息（防枚举）', async () => {
    const missing = await req('POST', '/api/v1/login', {
      body: { username: 'nobody-here', password: 'passw0rd-strong' },
    })
    const wrong = await req('POST', '/api/v1/login', {
      body: { username: 'alice', password: 'wrong-password' },
    })
    assert.equal(missing.status, 401)
    assert.equal(wrong.status, 401)
    assert.deepEqual(missing.body, wrong.body)
  })

  it('登录成功返回可用令牌', async () => {
    const r = await req('POST', '/api/v1/login', { body: { username: 'alice', password: 'passw0rd-strong' } })
    assert.equal(r.status, 200)
    assert.ok(r.body.token)
    const usage = await req('GET', '/api/v1/usage', { token: r.body.token })
    assert.equal(usage.status, 200)
  })
})

describe('鉴权', () => {
  it('无令牌访问受保护接口返回 401', async () => {
    const r = await req('GET', '/api/v1/blobs')
    assert.equal(r.status, 401)
  })

  it('伪造令牌返回 401', async () => {
    const r = await req('GET', '/api/v1/blobs', { token: 'not-a-real-token' })
    assert.equal(r.status, 401)
  })

  it('格式错误的 Authorization 头返回 401', async () => {
    const res = await fetch(`${baseUrl}/api/v1/blobs`, { headers: { authorization: 'Token abc' } })
    assert.equal(res.status, 401)
  })
})

describe('blob 存储（零知识）', () => {
  let token

  before(async () => {
    token = await registerUser('blobuser')
  })

  it('写入后能原样读回密文', async () => {
    const ciphertext = 'v1:c2FsdA==:aXY=:dGFn:Y2lwaGVy'
    const put = await req('PUT', '/api/v1/blobs/connections', {
      token,
      body: { ciphertext },
    })
    assert.equal(put.status, 200)
    assert.equal(put.body.version, 1)

    const get = await req('GET', '/api/v1/blobs/connections', { token })
    assert.equal(get.status, 200)
    assert.equal(get.body.ciphertext, ciphertext)
    assert.equal(get.body.version, 1)
  })

  it('列表只返回元数据、不含密文', async () => {
    const r = await req('GET', '/api/v1/blobs', { token })
    assert.equal(r.status, 200)
    assert.equal(r.body.blobs.length, 1)

    const item = r.body.blobs[0]
    assert.equal(item.name, 'connections')
    assert.equal(item.version, 1)
    assert.ok(item.size > 0)
    assert.equal(Object.prototype.hasOwnProperty.call(item, 'ciphertext'), false)
  })

  it('版本冲突被拒并返回服务端当前版本', async () => {
    const r = await req('PUT', '/api/v1/blobs/connections', {
      token,
      body: { ciphertext: 'x', baseVersion: 0 },
    })
    assert.equal(r.status, 409)
    assert.equal(r.body.error.code, 'VERSION_CONFLICT')
    assert.match(r.body.error.message, /服务端当前 1/)
  })

  it('基于正确版本可继续推进版本号', async () => {
    const r = await req('PUT', '/api/v1/blobs/connections', {
      token,
      body: { ciphertext: 'v2-content', baseVersion: 1 },
    })
    assert.equal(r.status, 200)
    assert.equal(r.body.version, 2)
  })

  it('强制覆盖（不传 baseVersion）允许推进', async () => {
    const r = await req('PUT', '/api/v1/blobs/connections', { token, body: { ciphertext: 'forced' } })
    assert.equal(r.status, 200)
    assert.equal(r.body.version, 3)
  })

  it('空密文被拒', async () => {
    const r = await req('PUT', '/api/v1/blobs/connections', { token, body: { ciphertext: '' } })
    assert.equal(r.status, 400)
    assert.equal(r.body.error.code, 'CIPHERTEXT_REQUIRED')
  })

  it('读取不存在的 blob 返回 404', async () => {
    const r = await req('GET', '/api/v1/blobs/no-such-blob', { token })
    assert.equal(r.status, 404)
  })

  it('删除是幂等的', async () => {
    const first = await req('DELETE', '/api/v1/blobs/connections', { token })
    assert.equal(first.status, 200)
    assert.equal(first.body.deleted, true)

    const second = await req('DELETE', '/api/v1/blobs/connections', { token })
    assert.equal(second.status, 200)
    assert.equal(second.body.deleted, false)
  })

  it('★ 多租户隔离：另一账号看不到、也读不到别人的 blob', async () => {
    const aliceToken = await registerUser('alice-tenant')
    await req('PUT', '/api/v1/blobs/secret', { token: aliceToken, body: { ciphertext: 'alice-only' } })

    const bobToken = await registerUser('bob-tenant')

    const bobList = await req('GET', '/api/v1/blobs', { token: bobToken })
    assert.equal(bobList.body.blobs.length, 0, 'B 不应看到 A 的 blob')

    const bobGet = await req('GET', '/api/v1/blobs/secret', { token: bobToken })
    assert.equal(bobGet.status, 404, 'B 即使知道名字也读不到 A 的 blob')
  })

  it('★ blob 名含路径穿越也被中和（名字被哈希，不落成路径）', async () => {
    const evilName = '../../../../etc/passwd'
    const put = await req('PUT', `/api/v1/blobs/${encodeURIComponent(evilName)}`, {
      token,
      body: { ciphertext: 'should-not-escape' },
    })
    assert.equal(put.status, 200)

    const get = await req('GET', `/api/v1/blobs/${encodeURIComponent(evilName)}`, { token })
    assert.equal(get.status, 200)
    assert.equal(get.body.ciphertext, 'should-not-escape')
    // 名字原样保存，但磁盘上是哈希后的文件名（见 blobs/blobFileName）
    assert.equal(get.body.name, evilName)
  })

  it('未知接口返回 404 且带稳定错误码', async () => {
    const r = await req('GET', '/api/v1/nope')
    assert.equal(r.status, 404)
    assert.equal(r.body.error.code, 'NOT_FOUND')
  })

  it('非法 JSON 请求体返回 400', async () => {
    const res = await fetch(`${baseUrl}/api/v1/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    })
    assert.equal(res.status, 400)
    const body = await res.json()
    assert.equal(body.error.code, 'BAD_JSON')
  })
})

describe('注销', () => {
  it('注销后令牌立即失效', async () => {
    const token = await registerUser('logout-user')
    assert.equal((await req('GET', '/api/v1/usage', { token })).status, 200)

    const out = await req('POST', '/api/v1/logout', { token })
    assert.equal(out.status, 200)

    assert.equal((await req('GET', '/api/v1/usage', { token })).status, 401)
  })
})
