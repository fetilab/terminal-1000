// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

import { app, BrowserWindow, dialog, shell } from 'electron'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { z } from 'zod'
import { AppError, parseInput } from '../../errors'
import type { IpcHandler } from '../router'
import { pingMany, pingTarget } from '../../services/net/ping'
import { getMainWindow } from '../../window'

const openExternalSchema = z.object({
  url: z.string().url(),
})

const pickLocalPathSchema = z.object({
  mode: z.enum(['file', 'directory']).default('file'),
  multiple: z.boolean().optional(),
  /** 对话框标题（本地化文案由渲染层给） */
  title: z.string().max(200).optional(),
  /** 初始目录；越权/不存在时由系统自行回退 */
  defaultPath: z.string().max(4096).optional(),
  /** 文件过滤，如 [{name:'文本', extensions:['txt']}] */
  filters: z
    .array(z.object({ name: z.string().max(100), extensions: z.array(z.string().max(20)).max(50) }))
    .max(20)
    .optional(),
})

const openPathSchema = z.object({
  path: z.string().min(1),
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

/**
 * 定位 kitty 内核的 wasm。
 *
 * 两种运行形态：
 * - 开发：`apps/desktop/vendor/kitty-vt-wasm/dist/kitty-vt.wasm`（仓库内，随源码走）；
 * - 打包：`<resources>/kitty-vt.wasm`（electron-builder 的 extraResources 拷进去）。
 *
 * 用「逐个候选探测」而不是写死路径：asar 内的 `__dirname` 层级在 dev/prod 不一致，
 * 任何一处写死都会在另一种形态下变成"内核加载失败"。
 */
function kittyWasmPath(): string | null {
  const candidates: string[] = []
  if (process.resourcesPath) candidates.push(join(process.resourcesPath, 'kitty-vt.wasm'))
  candidates.push(join(app.getAppPath(), 'vendor', 'kitty-vt-wasm', 'dist', 'kitty-vt.wasm'))
  let dir = __dirname
  for (let i = 0; i < 6; i += 1) {
    candidates.push(join(dir, 'vendor', 'kitty-vt-wasm', 'dist', 'kitty-vt.wasm'))
    candidates.push(join(dir, 'apps', 'desktop', 'vendor', 'kitty-vt-wasm', 'dist', 'kitty-vt.wasm'))
    dir = dirname(dir)
  }
  for (const c of candidates) {
    if (existsSync(c)) return resolve(c)
  }
  return null
}

/** 只允许打开 http/https/mailto，避免被当作任意协议处理器 */
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:', 'mailto:'])

export const appHandlers: Record<string, IpcHandler> = {
  /**
   * 返回 kitty 内核的 wasm 字节（base64）。
   *
   * 为什么不让 Worker 自己 `fetch()`：打包后页面是 `file://`，`fetch` 会被同源策略挡掉；
   * 走主进程读盘再交给 Worker，是在两种形态下都稳定的一条路。
   */
  kittyWasm: () => {
    const file = kittyWasmPath()
    if (!file) throw new AppError('NOT_FOUND', '找不到 kitty 内核（kitty-vt.wasm），安装包可能不完整')
    const buf = readFileSync(file)
    return { base64: buf.toString('base64'), bytes: buf.byteLength, path: file }
  },

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

  /**
   * 打开本机文件/目录选择对话框，返回**绝对路径**。
   *
   * 为什么必须由主进程做：Electron 32+ 移除了 `File.path`，
   * 渲染层拿到 `File` 对象也读不出本地绝对路径（安全收紧），
   * 于是"选择上传文件"这类操作在渲染层无法自行完成。
   *
   * 返回 `canceled` 而不是抛错：用户取消是正常操作，不该当异常处理。
   */
  pickLocalPath: async (payload) => {
    const input = parseInput(pickLocalPathSchema, payload ?? {})
    const parent = getMainWindow()

    const properties: Array<'openFile' | 'openDirectory' | 'multiSelections'> = [
      input.mode === 'directory' ? 'openDirectory' : 'openFile',
    ]
    if (input.multiple && input.mode === 'file') properties.push('multiSelections')

    const options = {
      properties,
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.defaultPath !== undefined ? { defaultPath: input.defaultPath } : {}),
      ...(input.filters !== undefined ? { filters: input.filters } : {}),
    }

    const result = parent
      ? await dialog.showOpenDialog(parent, options)
      : await dialog.showOpenDialog(options)

    return {
      canceled: result.canceled,
      paths: result.filePaths,
    }
  },

  /**
   * 用系统默认程序打开一个本地路径。
   * SFTP 的"在线编辑"把远端文件物化到临时文件后，用它直接打开编辑器。
   * 返回失败原因（`shell.openPath` 用非空字符串表示错误，不抛异常）。
   */
  openPath: async (payload) => {
    const { path } = parseInput(openPathSchema, payload)
    const error = await shell.openPath(path)
    if (error) throw AppError.badRequest(`无法打开该路径：${error}`)
    return { opened: true, path }
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
