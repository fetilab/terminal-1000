// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

import { app, shell } from 'electron'
import { z } from 'zod'
import { AppError } from '../../errors'
import type { IpcHandler } from '../router'

const openExternalSchema = z.object({
  url: z.string().url(),
})

const showItemSchema = z.object({
  path: z.string().min(1),
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
    const { path } = showItemSchema.parse(payload)
    shell.showItemInFolder(path)
    return { shown: true }
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
