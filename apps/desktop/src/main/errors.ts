// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

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
  if (err instanceof Error) return AppError.internal(err.message)
  return AppError.internal(String(err))
}
