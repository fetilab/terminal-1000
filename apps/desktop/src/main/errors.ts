// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

import type { ZodType } from 'zod'
import type { IpcErrorCode } from '@t1000/shared'

/**
 * 业务错误。跨 IPC 边界时只保留 code / message / detail，
 * 不把堆栈暴露给渲染进程。
 */
export class AppError extends Error {
  readonly code: IpcErrorCode
  readonly detail?: unknown

  constructor(code: IpcErrorCode, message: string, detail?: unknown) {
    super(message)
    this.name = 'AppError'
    this.code = code
    this.detail = detail
  }

  static badRequest(message: string, detail?: unknown): AppError {
    return new AppError('BAD_REQUEST', message, detail)
  }

  static notFound(message: string): AppError {
    return new AppError('NOT_FOUND', message)
  }

  static conflict(message: string): AppError {
    return new AppError('CONFLICT', message)
  }

  static unauthorized(message = '未授权'): AppError {
    return new AppError('UNAUTHORIZED', message)
  }

  static forbidden(message = '操作被拒绝'): AppError {
    return new AppError('FORBIDDEN', message)
  }

  static notConnected(message = '连接未建立'): AppError {
    return new AppError('NOT_CONNECTED', message)
  }

  static timeout(message = '操作超时'): AppError {
    return new AppError('TIMEOUT', message)
  }

  static unsupported(message: string): AppError {
    return new AppError('UNSUPPORTED', message)
  }

  static internal(message: string, detail?: unknown): AppError {
    return new AppError('INTERNAL', message, detail)
  }
}

/** 把任意抛出物归一化成 AppError */
export function toAppError(err: unknown): AppError {
  if (err instanceof AppError) return err

  // zod 校验失败是**调用方入参问题**，不是服务端故障。
  // 在路由层统一归类为 BAD_REQUEST，各域不必各自处理 ——
  // 否则 ZodError 会被当成 INTERNAL，渲染层无法区分"我传错了"和"程序炸了"。
  if (isZodError(err)) {
    const detail = err.issues.map((i) => ({
      path: i.path.join('.'),
      message: i.message,
      code: i.code,
    }))
    const first = detail[0]
    const summary = first
      ? `${first.path || '<root>'}: ${first.message}`
      : '入参校验失败'
    return AppError.badRequest(`入参不合法 — ${summary}`, detail)
  }

  if (err instanceof Error) return AppError.internal(err.message)
  return AppError.internal(String(err))
}

/**
 * 校验入参：失败抛 AppError.badRequest（契约要求）。
 *
 * 直接用 `schema.parse()` 会抛 ZodError —— 经路由层会被兜底成 BAD_REQUEST，
 * 但 handler 被直接调用时（如单测）就绕过了兜底。统一走这里，两种路径行为一致。
 */
export function parseInput<T>(schema: ZodType<T>, payload: unknown): T {
  const result = schema.safeParse(payload)
  if (!result.success) throw toAppError(result.error)
  return result.data
}

/**
 * 结构判断而非 `instanceof ZodError`。
 *
 * 打包后可能存在多份 zod 实例（不同依赖各自携带），`instanceof` 会漏判，
 * 导致校验错误被降级成 INTERNAL。这里按形状识别更稳。
 */
function isZodError(err: unknown): err is { issues: Array<{ path: (string | number)[]; message: string; code: string }> } {
  if (typeof err !== 'object' || err === null) return false
  const e = err as { name?: unknown; issues?: unknown }
  if (e.name !== 'ZodError') return false
  return Array.isArray(e.issues)
}
