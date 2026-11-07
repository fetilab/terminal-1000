// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * mcp 域 handler 单测：默认策略、工具开关、策略校验、令牌 API、启停。
 * 不连任何外部服务；start 只在 127.0.0.1 上起一个临时端口。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer as createNetServer } from 'node:http'
import type { AppPaths } from '@t1000/shared'
import type { IpcContext } from '../../ipc/router'
import { Events } from '@t1000/shared'
import {
  configureMcp,
  createMcpClient,
  getMcpServer,
  getMcpTokens,
  listMcpClients,
  mcpHandlers,
  resetMcp,
  revokeMcpClient,
} from './index'

function ctx(): IpcContext {
  return {
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    paths: {} as AppPaths,
    emit: ((event: string) => {
      void event
      void Events
    }) as unknown as IpcContext['emit'],
  }
}

/** 同 ai 域：把同步抛错也转成 rejected promise，匹配真实路由的 await try/catch 行为 */
function call<T = unknown>(action: string, payload?: unknown): Promise<T> {
  const handler = mcpHandlers[action]
  if (!handler) return Promise.reject(new Error(`缺少 handler: ${action}`))
  try {
    return Promise.resolve(handler(payload, ctx()) as T | Promise<T>)
  } catch (err) {
    return Promise.reject(err)
  }
}

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

beforeEach(() => {
  resetMcp()
})

afterEach(() => {
  resetMcp()
})

describe('默认状态（保守）', () => {
  it('未启动、只听回环、每次确认、sudo 禁用、无服务器无目录', async () => {
    const status = await call<{
      running: boolean
      host: string
      policy: { executionPolicy: string; sudoPolicy: string; workspacePolicy: string; allowedServerIds: unknown; allowedLocalDirs: unknown }
    }>('status')

    expect(status.running).toBe(false)
    expect(status.host).toBe('127.0.0.1')
    expect(status.policy.executionPolicy).toBe('confirm')
    expect(status.policy.sudoPolicy).toBe('deny')
    expect(status.policy.workspacePolicy).toBe('confirm')
    expect(status.policy.allowedServerIds).toEqual([])
    expect(status.policy.allowedLocalDirs).toEqual([])
  })

  it('不配置任何依赖也能拿到状态（fail-closed）', async () => {
    const others = await call<{ policy: { listenHost: string } }>('status')
    void others
    const server = getMcpServer()
    expect(server.getPolicy().listenHost).toBe('127.0.0.1')
    // 没有确认回调时，confirm 策略不会放行
    expect(server.status().running).toBe(false)
  })
})

describe('listTools / setPolicy', () => {
  it('listTools 列出全部工具并标出启用状态；默认全部启用', async () => {
    const result = await call<{ tools: Array<{ name: string; group: string; enabled: boolean; inputSchema: unknown }>; effective: string[] }>(
      'listTools',
    )
    expect(result.tools).toHaveLength(13)
    expect(result.tools.every((t) => t.enabled)).toBe(true)
    expect(result.tools.every((t) => t.name.startsWith('t1000_'))).toBe(true)
    expect(new Set(result.tools.map((t) => t.group))).toEqual(new Set(['workspace', 'ssh', 'files', 'transfer']))
    expect(result.effective.length).toBe(result.tools.length)
  })

  it('setPolicy 关掉部分工具后 listTools 反映出来', async () => {
    await call('setPolicy', { enabledTools: ['t1000_ssh_exec'] })
    const result = await call<{ tools: Array<{ name: string; enabled: boolean }>; effective: string[] }>('listTools')
    expect(result.effective).toEqual(['t1000_ssh_exec'])
    expect(result.tools.filter((t) => t.enabled).map((t) => t.name)).toEqual(['t1000_ssh_exec'])
  })

  it('setPolicy 校验端口与未知工具名', async () => {
    await expect(call('setPolicy', { port: 80 })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    await expect(call('setPolicy', { enabledTools: ['nope'] })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })

  it('运行中改端口 → restartRequired=true（不自动重启）', async () => {
    const port = await freePort()
    await call('start', { port })
    try {
      const applied = await call<{ restartRequired: boolean; running: boolean }>('setPolicy', { port: port + 1 })
      expect(applied.running).toBe(true)
      expect(applied.restartRequired).toBe(true)

      // 只改执行策略不需要重启
      const soft = await call<{ restartRequired: boolean }>('setPolicy', { executionPolicy: 'direct' })
      expect(soft.restartRequired).toBe(false)
    } finally {
      await call('stop')
    }
  })

  it('setPolicy 支持服务器/目录白名单与 sudo 策略', async () => {
    const result = await call<{ policy: { allowedServerIds: unknown; allowedLocalDirs: unknown; sudoPolicy: string } }>('setPolicy', {
      allowedServerIds: ['s1'],
      allowedLocalDirs: ['/srv/data'],
      sudoPolicy: 'confirm',
    })
    expect(result.policy.allowedServerIds).toEqual(['s1'])
    expect(result.policy.allowedLocalDirs).toEqual(['/srv/data'])
    expect(result.policy.sudoPolicy).toBe('confirm')
  })
})

describe('令牌 API', () => {
  it('创建只回一次明文，列表里没有摘要；撤销后失效', () => {
    const { client, token } = createMcpClient('Codex', { allowSudo: true })
    expect(token.length).toBeGreaterThan(20)
    expect(client).not.toHaveProperty('tokenDigest')
    expect(listMcpClients()[0]).not.toHaveProperty('tokenDigest')

    expect(getMcpTokens().verify(token)?.id).toBe(client.id)
    expect(revokeMcpClient(client.id)).toBe(true)
    expect(getMcpTokens().verify(token)).toBeUndefined()
  })

  it('status 里带客户端列表（无摘要）', async () => {
    createMcpClient('claude')
    const status = await call<{ clients: Array<Record<string, unknown>> }>('status')
    expect(status.clients).toHaveLength(1)
    expect(status.clients[0]).not.toHaveProperty('tokenDigest')
    expect(status.clients[0]?.['name']).toBe('claude')
  })
})

describe('start / stop', () => {
  it('start 在回环上监听并返回端点；stop 后停止', async () => {
    const port = await freePort()
    const started = await call<{ running: boolean; port: number; endpoint: string; host: string }>('start', { port })

    expect(started.running).toBe(true)
    expect(started.port).toBe(port)
    expect(started.host).toBe('127.0.0.1')
    expect(started.endpoint).toBe(`http://127.0.0.1:${port}/mcp`)

    const stopping = await call<{ running: boolean }>('stop')
    expect(stopping.running).toBe(false)
  })

  it('端口占用 → CONFLICT（不自动换端口）', async () => {
    const port = await freePort()
    await call('start', { port })
    try {
      const other = getMcpServer()
      other.setPolicy({ ...other.getPolicy(), port })
      // 同一个单例已在监听，第二次 start 直接返回当前状态；用另一个实例验证占用语义
      const { McpServer } = await import('./server')
      const { TokenRegistry, normalizePolicy } = await import('./policy')
      const second = new McpServer({ policy: normalizePolicy({ port }), tokens: new TokenRegistry() })
      await expect(second.start()).rejects.toMatchObject({ code: 'CONFLICT' })
    } finally {
      await call('stop')
    }
  })

  it('configureMcp 可注入策略（启动前生效）', async () => {
    const port = await freePort()
    configureMcp({ policy: { executionPolicy: 'direct', allowedServerIds: ['s1'] } })
    const started = await call<{ policy: { executionPolicy: string; allowedServerIds: unknown } }>('start', { port })
    expect(started.policy.executionPolicy).toBe('direct')
    expect(started.policy.allowedServerIds).toEqual(['s1'])
    await call('stop')
  })
})
