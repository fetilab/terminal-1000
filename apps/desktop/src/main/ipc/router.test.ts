// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * IPC 路由层测试。
 *
 * 这一层是**所有 IPC 的唯一入口**，此前零测试。它负责三件容易出错的事：
 * 1. 请求/入参校验与错误**归一化**（任何异常都不能抛到渲染进程）
 * 2. **懒加载**：域在首次被调用时才 import（我加的，省启动内存）
 * 3. 懒加载的**并发保护**：同一域被并发首次调用时只能注册一次
 *    （重复注册会抛错，而竞态只在并发下出现 —— 不测就等于没写）
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppError } from '../errors'
import {
  clearRegistry,
  dispatch,
  hasHandler,
  listLazyDomains,
  listRegistered,
  registerDomain,
  registerLazyDomain,
  type IpcContext,
  type IpcHandler,
} from './router'

/**
 * 手工构造最小上下文。
 * 不用 `createIpcContext()`：它要读 Electron 的 `app.getPath('userData')`，
 * 而这里跑在 Node 测试环境里（没有 Electron 运行时）。
 * 本文件的 handler 都不碰 ctx，所以给一个够用的空壳即可。
 */
const ctx = {
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  paths: {},
  emit: () => {},
} as unknown as IpcContext

const call = (domain: string, action: string, payload?: unknown): Promise<unknown> =>
  dispatch({ domain, action, ...(payload === undefined ? {} : { payload }) }, ctx)

describe('IPC 路由', () => {
  beforeEach(() => clearRegistry())
  afterEach(() => clearRegistry())

  it('正常调用返回 ok + data', async () => {
    registerDomain('app', { ping: () => ({ pong: true }) })
    const res = (await call('app', 'ping')) as { ok: boolean; data: unknown }
    expect(res.ok).toBe(true)
    expect(res.data).toEqual({ pong: true })
  })

  it('未实现的动作返回 UNSUPPORTED（而不是抛异常）', async () => {
    registerDomain('app', { ping: () => 1 })
    const res = (await call('app', 'nope')) as { ok: boolean; error: { code: string } }
    expect(res.ok).toBe(false)
    expect(res.error.code).toBe('UNSUPPORTED')
  })

  it('★ 域不在契约枚举里 → BAD_REQUEST（是"请求不合法"，不是"动作未实现"）', async () => {
    // 这个区分是有意的：`domain` 由请求 schema 按契约枚举校验，
    // 传一个契约里没有的域，性质是**请求格式错误**；而"域合法但动作没实现"才是 UNSUPPORTED。
    // 两者给用户的处置不同（前者说明调用方写错了，后者说明功能缺失）。
    const res = (await call('nosuchdomain', 'x')) as { ok: boolean; error: { code: string } }
    expect(res.error.code).toBe('BAD_REQUEST')
  })

  it('请求体本身不合法 → BAD_REQUEST', async () => {
    const res = (await dispatch({ nope: true }, ctx)) as { error: { code: string } }
    expect(res.error.code).toBe('BAD_REQUEST')
  })

  it('AppError 的错误码被保留', async () => {
    registerDomain('app', {
      boom: () => {
        throw AppError.notFound('找不到')
      },
    })
    const res = (await call('app', 'boom')) as { error: { code: string; message: string } }
    expect(res.error.code).toBe('NOT_FOUND')
    expect(res.error.message).toBe('找不到')
  })

  it('普通 Error 归一化为 INTERNAL（绝不外泄堆栈）', async () => {
    registerDomain('app', {
      boom: () => {
        throw new Error('内部炸了')
      },
    })
    const res = (await call('app', 'boom')) as { error: { code: string } }
    expect(res.error.code).toBe('INTERNAL')
  })

  it('★ ZodError 归一化为 BAD_REQUEST（不是 INTERNAL）', async () => {
    // 用真实的 zod 触发一次校验失败
    const { z } = await import('zod')
    const schema = z.object({ required: z.string() })
    registerDomain('app', {
      validate: (payload) => schema.parse(payload),
    })
    const res = (await call('app', 'validate', {})) as { error: { code: string } }
    expect(res.error.code).toBe('BAD_REQUEST')
  })

  it('异步 handler 的拒绝也被捕获成响应', async () => {
    registerDomain('app', {
      slow: async () => {
        await new Promise((r) => setTimeout(r, 5))
        throw AppError.conflict('冲突了')
      },
    })
    const res = (await call('app', 'slow')) as { error: { code: string } }
    expect(res.error.code).toBe('CONFLICT')
  })
})

describe('IPC 懒加载域', () => {
  beforeEach(() => clearRegistry())
  afterEach(() => clearRegistry())

  const loader = (impl: () => Record<string, IpcHandler>, spy?: () => void): (() => Promise<Record<string, IpcHandler>>) =>
    async () => {
      spy?.()
      return impl()
    }

  it('★ 声明后**不会**立刻加载；首次调用才 import', async () => {
    const loads = vi.fn()
    registerLazyDomain('app', loader(() => ({ hello: () => 'hi' }), loads))

    // 声明阶段：没加载，也没有已注册动作
    expect(loads).not.toHaveBeenCalled()
    expect(listRegistered()).toEqual([])
    expect(listLazyDomains()).toContain('app')

    const res = (await call('app', 'hello')) as { ok: boolean; data: unknown }
    expect(res.data).toBe('hi')
    expect(loads).toHaveBeenCalledTimes(1)
    // 加载后从"待加载"里移除、进入已注册
    expect(listLazyDomains()).not.toContain('app')
    expect(hasHandler('app', 'hello')).toBe(true)
  })

  it('★ 并发首次调用只加载一次（否则重复注册会抛错）', async () => {
    let loads = 0
    registerLazyDomain('app', async () => {
      loads += 1
      // 故意慢一点，制造"两个调用同时到达"的竞态
      await new Promise((r) => setTimeout(r, 20))
      return { hello: () => 'hi' }
    })

    const [a, b, c] = (await Promise.all([
      call('app', 'hello'),
      call('app', 'hello'),
      call('app', 'hello'),
    ])) as Array<{ ok: boolean; data: unknown }>

    expect(loads, '并发首次调用只应触发一次 import').toBe(1)
    for (const r of [a, b, c]) expect(r?.data).toBe('hi')
  })

  it('加载器抛错 → INTERNAL，且错误信息点明是哪个域', async () => {
    registerLazyDomain('app', async () => {
      throw new Error('import 失败')
    })
    const res = (await call('app', 'hello')) as { error: { code: string; message: string } }
    expect(res.error.code).toBe('INTERNAL')
    expect(res.error.message).toContain('app')
  })

  it('懒加载域加载后，后续调用不再走加载器', async () => {
    const loads = vi.fn()
    registerLazyDomain('app', loader(() => ({ n: () => 1 }), loads))
    await call('app', 'n')
    await call('app', 'n')
    await call('app', 'n')
    expect(loads).toHaveBeenCalledTimes(1)
  })

  it('懒加载域里不存在的动作仍然返回 UNSUPPORTED（不能因为"域加载了"就放行）', async () => {
    registerLazyDomain('app', loader(() => ({ real: () => 1 })))
    const res = (await call('app', 'fake')) as { error: { code: string } }
    expect(res.error.code).toBe('UNSUPPORTED')
  })
})
