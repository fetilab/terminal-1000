// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * completion 域 IPC 接入。
 *
 * 动作清单见 packages/shared/src/ipc.ts 的 Actions.completion：
 * complete / settings / setSettings / listSpecs。
 *
 * - 引擎单例、惰性创建：语料索引也是首次真正用到补全时才加载（冷启动无负担）。
 * - 语料是**自建**的（`specs/`），不含任何第三方补全库内容。
 * - 日志走注入的 ctx.logger；本模块不 import logger/router 的运行时实现，
 *   避免把 Electron 依赖带进单测。
 */

import { readdirSync, statSync } from 'node:fs'
import { z } from 'zod'
import type { CompletionSettings } from '@t1000/shared'
import type { IpcContext, IpcHandler } from '../../ipc/router'
import {
  CompletionCorpus,
  DEFAULT_NEGATIVE_TTL_MS,
  DEFAULT_SPEC_CACHE_SIZE,
  bundledSpecSource,
} from './corpus'
import { CompletionEngine, createDirectoryGenerator } from './engine'

let engine: CompletionEngine | null = null
let activeCtx: IpcContext | null = null

/** 供测试或设置变更时丢弃单例（下次调用重新建） */
export function resetCompletion(): void {
  engine = null
}

function getEngine(ctx: IpcContext): CompletionEngine {
  activeCtx = ctx
  if (engine) return engine

  const corpus = new CompletionCorpus(bundledSpecSource(), {
    specCacheSize: DEFAULT_SPEC_CACHE_SIZE,
    negativeTtlMs: DEFAULT_NEGATIVE_TTL_MS,
  })

  engine = new CompletionEngine({
    corpus,
    // 「脚本生成式补全（Beta）」：cd 的目录候选，默认关闭（见 CompletionSettings）
    generators: [
      createDirectoryGenerator({
        listDir: (path) => {
          try {
            return readdirSync(path)
          } catch {
            return null
          }
        },
        isDir: (path) => {
          try {
            return statSync(path).isDirectory()
          } catch {
            return false
          }
        },
      }),
    ],
  })

  // TODO(settings): services/settings 目前未注入 CompletionSettings；
  // 接入方式是给本模块注入 { load(): CompletionSettings, save(s): void }，
  // 避免直接 import 其它服务的内部实现（架构 §3 边界纪律）。
  return engine
}

// ── 入参 schema（IPC 边界必须校验）────────────────────

const historyEntrySchema = z.union([
  z.string(),
  z.object({
    line: z.string(),
    count: z.number().int().min(1).optional(),
  }),
])

const completeSchema = z.object({
  line: z.string(),
  cursor: z.number().int().min(0).optional(),
  history: z.array(historyEntrySchema).max(5000).optional(),
  limit: z.number().int().min(1).max(200).optional(),
  cwd: z.string().optional(),
})

const settingsPatchSchema = z.object({
  enabled: z.boolean().optional(),
  specCompletion: z.boolean().optional(),
  historyCompletion: z.boolean().optional(),
  generatorCompletion: z.boolean().optional(),
  aiSuggestion: z.boolean().optional(),
  debounceMs: z.number().int().min(0).max(5000).optional(),
  maxSuggestions: z.number().int().min(1).max(200).optional(),
})

export const completionHandlers: Record<string, IpcHandler> = {
  /** 计算补全候选 */
  complete: async (payload, ctx) => {
    const request = completeSchema.parse(payload ?? {})
    return getEngine(ctx).complete(request)
  },

  settings: (_payload, ctx) => {
    const current: CompletionSettings = getEngine(ctx).getSettings()
    return current
  },

  /** 局部更新设置（只覆盖传了的字段） */
  setSettings: (payload, ctx) => {
    const patch = settingsPatchSchema.parse(payload ?? {})
    return getEngine(ctx).setSettings(patch)
  },

  /** 语料索引（命令名 + 简述），供设置页/文档展示 */
  listSpecs: async (_payload, ctx) => {
    const entries = await getEngine(ctx).listSpecs()
    return { total: entries.length, entries }
  },
}
