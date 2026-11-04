// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

import type {
  AppPaths,
  EventName,
  EventPayloads,
  IpcDomain,
  IpcRequest,
  IpcResponse,
} from '@t1000/shared'
import { ipcRequestSchema } from '@t1000/shared'
import { AppError, toAppError } from '../errors'
import { createLogger, type Logger } from '../logger'
import { getAppPaths } from '../paths'

/** 事件发送器（由 window 层注入，避免 router 依赖 Electron） */
export type EventEmitterFn = <E extends EventName>(event: E, payload: EventPayloads[E]) => void

export interface IpcContext {
  logger: Logger
  paths: AppPaths
  /** 向所有窗口广播事件 */
  emit: EventEmitterFn
}

export type IpcHandler = (payload: unknown, ctx: IpcContext) => Promise<unknown> | unknown

const registry = new Map<string, IpcHandler>()

function key(domain: IpcDomain, action: string): string {
  return `${domain}.${action}`
}

/**
 * 注册一个域的全部动作。
 * @param handlers 动作名 → 处理函数
 */
export function registerDomain(
  domain: IpcDomain,
  handlers: Record<string, IpcHandler>,
): void {
  for (const [action, fn] of Object.entries(handlers)) {
    const k = key(domain, action)
    if (registry.has(k)) {
      throw new Error(`IPC handler 重复注册: ${k}`)
    }
    registry.set(k, fn)
  }
}

/** 已注册的动作（测试与自检用） */
export function listRegistered(): string[] {
  return [...registry.keys()].sort()
}

export function hasHandler(domain: IpcDomain, action: string): boolean {
  return registry.has(key(domain, action))
}

/**
 * 分派一次请求。所有异常都被归一化为 IpcErr，绝不向渲染进程抛。
 */
export async function dispatch(
  raw: unknown,
  ctx: IpcContext,
): Promise<IpcResponse<unknown>> {
  let parsed: IpcRequest
  try {
    parsed = ipcRequestSchema.parse(raw) as IpcRequest
  } catch (err) {
    return fail(AppError.badRequest('IPC 请求格式不合法', err))
  }

  const handler = registry.get(key(parsed.domain, parsed.action))
  if (!handler) {
    return fail(AppError.unsupported(`未实现的动作: ${key(parsed.domain, parsed.action)}`))
  }

  try {
    const data = await handler(parsed.payload, ctx)
    return { ok: true, data }
  } catch (err) {
    const appErr = toAppError(err)
    // 业务错误记 warn，内部错误记 error（便于区分"预期失败"与"代码 bug"）
    if (appErr.code === 'INTERNAL') {
      ctx.logger.error(`${key(parsed.domain, parsed.action)} 失败`, err)
    } else {
      ctx.logger.warn(`${key(parsed.domain, parsed.action)} 拒绝: ${appErr.code} ${appErr.message}`)
    }
    return fail(appErr)
  }
}

function fail(err: AppError): IpcResponse<never> {
  return {
    ok: false,
    error: {
      code: err.code,
      message: err.message,
      ...(err.detail === undefined ? {} : { detail: err.detail }),
    },
  }
}

/** 构造默认上下文 */
export function createIpcContext(emit: EventEmitterFn): IpcContext {
  return {
    logger: createLogger('ipc'),
    paths: getAppPaths(),
    emit,
  }
}

/** 测试用：清空注册表 */
export function clearRegistry(): void {
  registry.clear()
}
