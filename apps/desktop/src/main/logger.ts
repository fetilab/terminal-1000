// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { getAppPaths } from './paths'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

/** 由环境变量控制，默认 info */
const minLevel: LogLevel = (process.env.T1000_LOG_LEVEL as LogLevel | undefined) ?? 'info'

let logFile: string | null = null

function getLogFile(): string {
  if (!logFile) {
    const d = new Date()
    const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
    logFile = join(getAppPaths().logDir, `main-${stamp}.log`)
  }
  return logFile
}

function format(level: LogLevel, scope: string, message: string): string {
  return `[${new Date().toISOString()}] [${level.toUpperCase()}] [${scope}] ${message}`
}

function write(level: LogLevel, scope: string, message: string, extra?: unknown): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return

  const line = format(level, scope, message)
  const suffix = extra === undefined ? '' : ` ${safeStringify(extra)}`

  // 控制台始终输出（开发期可见）
  if (level === 'error') console.error(line + suffix)
  else if (level === 'warn') console.warn(line + suffix)
  else console.log(line + suffix)

  // 落盘（失败不影响主流程）
  try {
    appendFileSync(getLogFile(), line + suffix + '\n')
  } catch {
    /* 日志写失败不应中断业务 */
  }
}

function safeStringify(value: unknown): string {
  if (value instanceof Error) return `${value.name}: ${value.message}`
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

export interface Logger {
  debug(message: string, extra?: unknown): void
  info(message: string, extra?: unknown): void
  warn(message: string, extra?: unknown): void
  error(message: string, extra?: unknown): void
}

/** 创建带作用域前缀的 logger */
export function createLogger(scope: string): Logger {
  return {
    debug: (m, e) => write('debug', scope, m, e),
    info: (m, e) => write('info', scope, m, e),
    warn: (m, e) => write('warn', scope, m, e),
    error: (m, e) => write('error', scope, m, e),
  }
}

export const logger = createLogger('app')
