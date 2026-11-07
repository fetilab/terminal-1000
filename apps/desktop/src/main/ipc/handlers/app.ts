// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

import { app, shell } from 'electron'
import { z } from 'zod'
import { AppError, parseInput } from '../../errors'
import type { IpcHandler } from '../router'
import { pingMany, pingTarget } from '../../services/net/ping'

const openExternalSchema = z.object({
  url: z.string().url(),
})

const showItemSchema = z.object({
  path: z.string().min(1),
})

const pingSchema = z.object({
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535).optional(),
  timeoutMs: z.number().int().positive().max(30_000).optional(),
})

const pingManySchema = z.object({
  targets: z
    .array(
      z.object({
        host: z.string().min(1),
        port: z.number().int().min(1).max(65535).optional(),
      }),
    )
    .max(2000),
  timeoutMs: z.number().int().positive().max(30_000).optional(),
  budgetMs: z.number().int().positive().max(120_000).optional(),
  concurrency: z.number().int().positive().max(256).optional(),
})

/** 只允许打开 http/https/mailto，避免被当作任意协议处理器 */
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:', 'mailto:'])

export const appHandlers: Record<string, IpcHandler> = {
  getInfo: () => ({
    name: app.getName(),
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    locale: app.getLocale(),
  }),

  getPaths: (_payload, ctx) => ctx.paths,

  openExternal: async (payload) => {
    const { url } = openExternalSchema.parse(payload)
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      throw AppError.badRequest('URL 不合法')
    }
    if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
      throw AppError.forbidden(`不允许打开该协议: ${parsed.protocol}`)
    }
    await shell.openExternal(url)
    return { opened: true }
  },

  showItemInFolder: (payload) => {
    const { path } = parseInput(showItemSchema, payload)
    shell.showItemInFolder(path)
    return { shown: true }
  },

  /** 探测单个目标的可达性与时延 */
  ping: (payload) => {
    const { host, port, timeoutMs } = parseInput(pingSchema, payload)
    return pingTarget(host, port, timeoutMs !== undefined ? { timeoutMs } : {})
  },

  /**
   * 批量探测（连接列表刷新延迟列用）。
   * 一次 IPC 拿回整批结果，并有整批预算兜底，避免个别不可达主机拖住界面。
   */
  pingMany: (payload) => {
    const { targets, timeoutMs, budgetMs, concurrency } = parseInput(pingManySchema, payload)
    const options = {
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      ...(budgetMs !== undefined ? { budgetMs } : {}),
      ...(concurrency !== undefined ? { concurrency } : {}),
    }
    return pingMany(targets, options)
  },

  quit: () => {
    app.quit()
    return { quitting: true }
  },

  relaunch: () => {
    app.relaunch()
    app.exit(0)
    return { relaunching: true }
  },
}
