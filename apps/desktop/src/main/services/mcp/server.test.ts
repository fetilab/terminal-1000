// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * MCP 服务端单测：策略执行（不变量）、工具分发、HTTP 鉴权与 Host 校验。
 *
 * 一半测试直接打 `handleRpc`（不需要 socket，跑得快且确定）；
 * HTTP 层只测真正属于传输的东西：401、405、Host 拒绝、端口占用。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer as createNetServer, request as httpRequest } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  TokenRegistry,
  normalizePolicy,
  withAllowedDirs,
  withAllowedServers,
  withEnabledTools,
  type McpPolicy,
} from './policy'
import { McpServer, type McpClientIdentity, type McpToolRuntime } from './server'

// ---------------------------------------------------------------------------
// 脚手架
// ---------------------------------------------------------------------------

let workRoot: string

function makeServer(
  patch: Partial<McpPolicy> = {},
  runtime: McpToolRuntime = {},
  onConfirm?: () => Promise<boolean>,
): { server: McpServer; tokens: TokenRegistry; client: McpClientIdentity; token: string } {
  const tokens = new TokenRegistry()
  const { client, token } = tokens.createClient('测试客户端', { allowSudo: true, allowWorkspace: true })
  const server = new McpServer({
    policy: normalizePolicy(patch),
    tokens,
    runtime,
    ...(onConfirm ? { onConfirm: () => onConfirm() } : {}),
  })
  return { server, tokens, client, token: token }
}

function rpc(server: McpServer, client: McpClientIdentity, method: string, params?: unknown, id: number | null = 1) {
  return server.handleRpc({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }, client)
}

function textOf(response: { result?: unknown; error?: unknown }): string {
  const result = response.result as { content?: Array<{ text: string }> } | undefined
  return result?.content?.[0]?.text ?? JSON.stringify(response.error ?? response.result)
}

/** 找一个空闲端口（先占 0 探测，再释放） */
async function freePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const probe = createNetServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      probe.close(() => resolve(port))
    })
  })
}

/** 原始 HTTP 请求（可自定义 Host 头，fetch 不允许） */
function httpPost(
  port: number,
  body: unknown,
  headers: Record<string, string> = {},
  method = 'POST',
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body)
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path: '/mcp',
        method,
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), ...headers },
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }))
      },
    )
    req.on('error', reject)
    req.end(payload)
  })
}

beforeEach(() => {
  workRoot = mkdtempSync(join(tmpdir(), 't1000-mcp-srv-'))
})

afterEach(() => {
  rmSync(workRoot, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// 协议
// ---------------------------------------------------------------------------

describe('JSON-RPC 协议', () => {
  it('initialize 返回协议版本与工具能力', async () => {
    const { server, client } = makeServer()
    const res = await rpc(server, client, 'initialize')
    expect(res).toMatchObject({
      jsonrpc: '2.0',
      result: { protocolVersion: expect.any(String), capabilities: { tools: {} } },
    })
  })

  it('tools/list 只列出启用的工具', async () => {
    const { server, client } = makeServer({ enabledTools: ['t1000_ssh_exec'] })
    const res = (await rpc(server, client, 'tools/list')) as { result: { tools: Array<{ name: string }> } }
    expect(res.result.tools.map((t) => t.name)).toEqual(['t1000_ssh_exec'])

    const all = (await rpc(server, client, 'tools/list')) as { result: { tools: Array<{ inputSchema: unknown }> } }
    expect(all.result.tools[0]?.inputSchema).toBeDefined()
  })

  it('未知方法与未知工具都被明确拒绝', async () => {
    const { server, client } = makeServer()
    const unknownMethod = await rpc(server, client, 'does/not/exist')
    expect(unknownMethod).toMatchObject({ error: { code: -32601 } })

    const unknownTool = await rpc(server, client, 'tools/call', { name: 't1000_nope', arguments: {} })
    expect(textOf(unknownTool as never)).toContain('未启用或不存在')
  })

  it('通知（id 为 null）不产生 result 也不报错', async () => {
    const { server, client } = makeServer()
    const res = await rpc(server, client, 'notifications/initialized', undefined, null)
    expect(res).toMatchObject({ id: null, result: {} })
  })
})

// ---------------------------------------------------------------------------
// ★ 策略执行（最重要）
// ---------------------------------------------------------------------------

describe('★ 执行策略', () => {
  it('默认 confirm 且无确认回调 → 不执行（fail-closed）', async () => {
    let executed = 0
    const { server, client } = makeServer(
      { allowedServerIds: ['s1'] },
      { exec: async () => (executed++, { stdout: 'x', stderr: '', code: 0 }) },
    )
    const res = await rpc(server, client, 'tools/call', {
      name: 't1000_ssh_exec',
      arguments: { serverId: 's1', command: 'df -h' },
    })
    expect(executed).toBe(0)
    expect(textOf(res as never)).toContain('需要用户确认')
  })

  it('direct 策略 + 白名单服务器 → 执行并回传退出码', async () => {
    let seen: { serverId: string; command: string; timeoutMs: number } | undefined
    const { server, client } = makeServer(
      { executionPolicy: 'direct', allowedServerIds: ['s1'] },
      {
        exec: async (serverId, command, options) => {
          seen = { serverId, command, timeoutMs: options.timeoutMs }
          return { stdout: 'out', stderr: '', code: 0 }
        },
      },
    )
    const res = await rpc(server, client, 'tools/call', {
      name: 't1000_ssh_exec',
      arguments: { serverId: 's1', command: 'df -h' },
    })
    expect(seen).toEqual({ serverId: 's1', command: 'df -h', timeoutMs: 60_000 })
    expect(textOf(res as never)).toContain('exitCode=0')
    expect((res as { result: { isError?: boolean } }).result.isError).toBeUndefined()
  })

  it('confirm 策略 + 确认通过 → 正常执行', async () => {
    const { server, client } = makeServer(
      { allowedServerIds: ['s1'] },
      { exec: async () => ({ stdout: 'ok', stderr: '', code: 0 }) },
      async () => true,
    )
    const res = await rpc(server, client, 'tools/call', {
      name: 't1000_ssh_exec',
      arguments: { serverId: 's1', command: 'uptime' },
    })
    expect(textOf(res as never)).toContain('exitCode=0')
  })

  it('未授权服务器被拒（默认不暴露任何服务器）', async () => {
    const { server, client } = makeServer({ executionPolicy: 'direct' })
    const res = await rpc(server, client, 'tools/call', {
      name: 't1000_ssh_exec',
      arguments: { serverId: 's1', command: 'df -h' },
    })
    expect(textOf(res as never)).toContain('未被授权')
  })

  it('ssh_list_servers 只返回被授权的那部分', async () => {
    const { server, client } = makeServer(
      { executionPolicy: 'direct', allowedServerIds: ['s2'] },
      {
        listServers: () => [
          { serverId: 's1', host: 'a', username: 'u', connectionId: 'c1' },
          { serverId: 's2', host: 'b', username: 'u', connectionId: 'c2' },
        ],
      },
    )
    const res = await rpc(server, client, 'tools/call', { name: 't1000_ssh_list_servers', arguments: {} })
    const text = textOf(res as never)
    expect(text).toContain('s2')
    expect(text).not.toContain('"s1"')
  })
})

describe('★ sudo 独立策略', () => {
  it('sudoPolicy=deny → 即使令牌允许 sudo 也拒绝', async () => {
    let executed = 0
    const { server, client } = makeServer(
      { executionPolicy: 'direct', sudoPolicy: 'deny', allowedServerIds: ['s1'] },
      { exec: async () => (executed++, { stdout: '', stderr: '', code: 0 }) },
    )
    const res = await rpc(server, client, 'tools/call', {
      name: 't1000_ssh_sudo_exec',
      arguments: { serverId: 's1', command: 'systemctl status nginx' },
    })
    expect(executed).toBe(0)
    expect(textOf(res as never)).toContain('sudo 已被禁用')
  })

  it('令牌未开「允许 sudo」→ 拒绝', async () => {
    const tokens = new TokenRegistry()
    const { client, token } = tokens.createClient('no-sudo', { allowSudo: false })
    const server = new McpServer({
      policy: normalizePolicy({ executionPolicy: 'direct', sudoPolicy: 'direct', allowedServerIds: ['s1'] }),
      tokens,
      runtime: { exec: async () => ({ stdout: '', stderr: '', code: 0 }) },
    })
    const res = await rpc(server, client, 'tools/call', {
      name: 't1000_ssh_sudo_exec',
      arguments: { serverId: 's1', command: 'id' },
    })
    expect(token).toBeTruthy()
    expect(textOf(res as never)).toContain('未开启「允许 sudo」')
  })

  it('sudoPolicy=direct + 令牌允许 → 自动补 sudo 前缀执行（客户端不传密码）', async () => {
    let seen = ''
    const { server, client } = makeServer(
      { executionPolicy: 'direct', sudoPolicy: 'direct', allowedServerIds: ['s1'] },
      {
        exec: async (_s, command) => {
          seen = command
          return { stdout: 'root', stderr: '', code: 0 }
        },
      },
    )
    await rpc(server, client, 'tools/call', {
      name: 't1000_ssh_sudo_exec',
      arguments: { serverId: 's1', command: 'systemctl status nginx' },
    })
    expect(seen).toBe('sudo systemctl status nginx')
  })
})

describe('★ 工作区策略', () => {
  it('workspacePolicy=deny → 拒绝', async () => {
    const { server, client } = makeServer(
      { executionPolicy: 'direct', workspacePolicy: 'deny' },
      { workspaceList: async () => [] },
    )
    const res = await rpc(server, client, 'tools/call', {
      name: 't1000_workspace_list',
      arguments: { kind: 'connections' },
    })
    expect(textOf(res as never)).toContain('工作区管理已被禁用')
  })

  it('令牌未开工作区权限 → 拒绝；都允许时执行', async () => {
    const tokens = new TokenRegistry()
    const { client } = tokens.createClient('no-ws', { allowWorkspace: false })
    const noWs = new McpServer({
      policy: normalizePolicy({ executionPolicy: 'direct', workspacePolicy: 'direct' }),
      tokens,
      runtime: { workspaceList: async () => [{ id: 'x' }] },
    })
    expect(textOf((await rpc(noWs, client, 'tools/call', { name: 't1000_workspace_list', arguments: { kind: 'notes' } })) as never)).toContain(
      '未开启「允许工作区管理」',
    )

    const okHarness = makeServer(
      { executionPolicy: 'direct', workspacePolicy: 'direct' },
      { workspaceList: async (kind) => [{ kind }] },
    )
    const ok = await rpc(okHarness.server, okHarness.client, 'tools/call', {
      name: 't1000_workspace_list',
      arguments: { kind: 'notes' },
    })
    expect(textOf(ok as never)).toContain('notes')
  })
})

describe('★ 本地目录白名单（传输工具）', () => {
  it('允许目录内的源文件放行；范围外拒绝', async () => {
    const allowed = join(workRoot, 'allowed')
    const outside = join(workRoot, 'outside')
    mkdirSync(allowed)
    mkdirSync(outside)
    writeFileSync(join(allowed, 'ok.txt'), 'x')
    writeFileSync(join(outside, 'bad.txt'), 'x')

    const seen: string[] = []
    const { server, client } = makeServer(
      { executionPolicy: 'direct', allowedServerIds: ['s1'] },
      {
        transferUpload: async (a) => {
          seen.push(a.localPath)
          return { ok: true }
        },
      },
    )
    // 注入白名单（withAllowedDirs 会规范化路径）
    server.setPolicy(withAllowedDirs(withAllowedServers(server.getPolicy(), ['s1']), [allowed]))

    const good = await rpc(server, client, 'tools/call', {
      name: 't1000_transfer_upload',
      arguments: { serverId: 's1', localPath: join(allowed, 'ok.txt'), remotePath: '/tmp/ok.txt' },
    })
    expect(textOf(good as never)).not.toContain('不被允许')
    expect(seen).toHaveLength(1)

    const bad = await rpc(server, client, 'tools/call', {
      name: 't1000_transfer_upload',
      arguments: { serverId: 's1', localPath: join(outside, 'bad.txt'), remotePath: '/tmp/bad.txt' },
    })
    expect(textOf(bad as never)).toContain('路径越出允许范围')
    expect(seen).toHaveLength(1)
  })

  it('未配置目录白名单时，传输工具一律拒绝', async () => {
    const { server, client } = makeServer(
      { executionPolicy: 'direct', allowedServerIds: ['s1'] },
      { transferUpload: async () => ({ ok: true }) },
    )
    const res = await rpc(server, client, 'tools/call', {
      name: 't1000_transfer_upload',
      arguments: { serverId: 's1', localPath: '/tmp/x', remotePath: '/tmp/x' },
    })
    expect(textOf(res as never)).toContain('未配置允许访问的本地目录')
  })
})

describe('超时与能力缺失', () => {
  it('超时按请求值取用，并被上限裁剪', async () => {
    const seen: number[] = []
    const { server, client } = makeServer(
      { executionPolicy: 'direct', allowedServerIds: ['s1'], defaultTimeoutMs: 60_000, maxTimeoutMs: 120_000 },
      {
        exec: async (_s, _c, o) => {
          seen.push(o.timeoutMs)
          return { stdout: '', stderr: '', code: 0 }
        },
      },
    )
    await rpc(server, client, 'tools/call', {
      name: 't1000_ssh_exec',
      arguments: { serverId: 's1', command: 'df', timeoutSec: 30 },
    })
    await rpc(server, client, 'tools/call', {
      name: 't1000_ssh_exec',
      arguments: { serverId: 's1', command: 'df', timeoutSec: 99999 },
    })
    await rpc(server, client, 'tools/call', {
      name: 't1000_ssh_exec',
      arguments: { serverId: 's1', command: 'df' },
    })
    expect(seen).toEqual([30_000, 120_000, 60_000])
  })

  it('未注入能力时返回明确错误，不假装成功', async () => {
    const { server, client } = makeServer({ executionPolicy: 'direct', allowedServerIds: ['s1'] })
    const res = await rpc(server, client, 'tools/call', {
      name: 't1000_ssh_exec',
      arguments: { serverId: 's1', command: 'df' },
    })
    expect(textOf(res as never)).toContain('未接入命令执行能力')
  })

  it('缺少必填参数时报错', async () => {
    const { server, client } = makeServer({ executionPolicy: 'direct', allowedServerIds: ['s1'] }, {
      exec: async () => ({ stdout: '', stderr: '', code: 0 }),
    })
    const res = await rpc(server, client, 'tools/call', {
      name: 't1000_ssh_exec',
      arguments: { serverId: 's1' },
    })
    expect(textOf(res as never)).toContain('缺少参数 command')
  })
})

// ---------------------------------------------------------------------------
// HTTP 传输层
// ---------------------------------------------------------------------------

describe('HTTP 层（Bearer 鉴权与 Host 校验）', () => {
  it('无 token / 错 token → 401；正确 token → 200；GET → 405', async () => {
    const port = await freePort()
    const { server, token } = makeServer({ port, executionPolicy: 'direct' })
    await server.start()
    try {
      const init = { jsonrpc: '2.0', id: 1, method: 'initialize' }

      const noToken = await httpPost(port, init)
      expect(noToken.status).toBe(401)

      const wrong = await httpPost(port, init, { authorization: 'Bearer not-a-real-token' })
      expect(wrong.status).toBe(401)

      const ok = await httpPost(port, init, { authorization: `Bearer ${token}` })
      expect(ok.status).toBe(200)
      expect(JSON.parse(ok.body)).toMatchObject({ result: { serverInfo: { name: 'terminal-1000' } } })

      const get = await httpPost(port, init, { authorization: `Bearer ${token}` }, 'GET')
      expect(get.status).toBe(405)
    } finally {
      await server.stop()
    }
  })

  it('Host 头不是回环 → 403（防 DNS rebinding）', async () => {
    const port = await freePort()
    const { server, token } = makeServer({ port })
    await server.start()
    try {
      const res = await httpPost(
        port,
        { jsonrpc: '2.0', id: 1, method: 'initialize' },
        { authorization: `Bearer ${token}`, host: 'evil.example.com' },
      )
      expect(res.status).toBe(403)
    } finally {
      await server.stop()
    }
  })

  it('撤销令牌后立即失效', async () => {
    const port = await freePort()
    const { server, tokens, token } = makeServer({ port })
    await server.start()
    try {
      const init = { jsonrpc: '2.0', id: 1, method: 'initialize' }
      expect((await httpPost(port, init, { authorization: `Bearer ${token}` })).status).toBe(200)

      const clientId = tokens.list()[0]?.id ?? ''
      expect(tokens.revoke(clientId)).toBe(true)
      expect((await httpPost(port, init, { authorization: `Bearer ${token}` })).status).toBe(401)
    } finally {
      await server.stop()
    }
  })

  it('端口被占用 → CONFLICT，且不自动换端口', async () => {
    const port = await freePort()
    const first = makeServer({ port })
    await first.server.start()
    try {
      const second = makeServer({ port })
      await expect(second.server.start()).rejects.toMatchObject({ code: 'CONFLICT' })
    } finally {
      await first.server.stop()
    }
  })

  it('status 反映运行状态、端点与启用工具', async () => {
    const port = await freePort()
    const { server } = makeServer({ port, enabledTools: ['t1000_ssh_exec'] })
    expect(server.status().running).toBe(false)
    await server.start()
    try {
      const status = server.status()
      expect(status.running).toBe(true)
      expect(status.port).toBe(port)
      expect(status.endpoint).toBe(`http://127.0.0.1:${port}/mcp`)
      expect(status.tools).toEqual(['t1000_ssh_exec'])
      expect(status.policy.executionPolicy).toBe('confirm')
    } finally {
      await server.stop()
    }
    expect(server.status().running).toBe(false)
  })

  it('错误令牌不会泄漏工具信息（401 响应体不含工具名）', async () => {
    const port = await freePort()
    const { server } = makeServer({ port })
    await server.start()
    try {
      const res = await httpPost(port, { jsonrpc: '2.0', id: 1, method: 'tools/list' })
      expect(res.status).toBe(401)
      expect(res.body).not.toContain('t1000_')
    } finally {
      await server.stop()
    }
  })
})
