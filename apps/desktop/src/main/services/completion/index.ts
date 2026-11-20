// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * completion 域 IPC 接入。
 *
 * 动作清单见 packages/shared/src/ipc.ts 的 Actions.completion：
 * complete / settings / setSettings / listSpecs，外加命令搜索 `search`
 * （spec 验收标准第 8 条「命令搜索可离线查用法」；契约由 lead 同步加入 Actions）。
 *
 * - 引擎单例、惰性创建：语料索引也是首次真正用到补全时才加载（冷启动无负担）。
 * - 语料是**自建**的（`specs/`），不含任何第三方补全库内容。
 * - 用户可通过设置项 `completion.corpusFile` 指定自建语料文件（格式与 specs/ 相同，
 *   见 userCorpus.ts）：路径变更后的下一次补全/搜索/listSpecs 自动重载；
 *   文件缺失/非法时降级为仅内置语料，并在日志与 completionUserCorpusStatus() 如实说明。
 * - 日志走注入的 ctx.logger；本模块不 import logger/router 的运行时实现，
 *   避免把 Electron 依赖带进单测。
 */

import { readdirSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import type { CompletionSettings } from '@t1000/shared'
import type { IpcContext, IpcHandler } from '../../ipc/router'
import {
  CompletionCorpus,
  DEFAULT_NEGATIVE_TTL_MS,
  DEFAULT_SPEC_CACHE_SIZE,
  bundledSpecSource,
} from './corpus'
import { CompletionEngine, createDirectoryGenerator,
  type AiSuggestionProvider,
} from './engine'
import {
  formatUserCorpusProblem,
  loadUserCorpus,
  type UserCorpusIo,
} from './userCorpus'

let engine: CompletionEngine | null = null
let activeCtx: IpcContext | null = null

/** 供测试或设置变更时丢弃单例（下次调用重新建） */
export function resetCompletion(): void {
  engine = null
  activeCorpus = null
  appliedCorpusFile = undefined
  userCorpusStatus = { state: 'unset', path: null }
}

/** 注入的 AI 建议 provider（跨服务，由 main/index.ts 显式注入） */
let aiProvider: AiSuggestionProvider | null = null
/** 注入的设置来源 */
let settingsReader: (() => CompletionSettings) | null = null

/**
 * 注入 AI 建议通道。
 *
 * 同时丢弃引擎单例：引擎在构造时接收 provider，已存在的实例不会感知本次注入。
 */
export function configureCompletionAi(provider: AiSuggestionProvider | null): void {
  aiProvider = provider
  engine = null
}

/**
 * 注入设置来源。
 *
 * 引擎**每次 complete 都会读它**，所以设置面板改完立即生效，不必重启。
 */
export function configureCompletionSettings(reader: (() => CompletionSettings) | null): void {
  settingsReader = reader
  engine = null
}

/** 自检：AI 通道是否已接上（界面与排障用） */
export function isCompletionAiConfigured(): boolean {
  return aiProvider !== null
}

function getEngine(ctx: IpcContext): CompletionEngine {
  activeCtx = ctx
  if (engine) return engine

  const corpus = new CompletionCorpus(bundledSpecSource(), {
    specCacheSize: DEFAULT_SPEC_CACHE_SIZE,
    negativeTtlMs: DEFAULT_NEGATIVE_TTL_MS,
  })
  // 新语料实例不携带任何用户层；appliedCorpusFile 归零强制下一次同步重新应用
  activeCorpus = corpus
  appliedCorpusFile = undefined

  engine = new CompletionEngine({
    corpus,
    // AI 建议通道（未注入时为 null → 引擎会给出"请去设置填 API Key"的可操作提示）
    ...(aiProvider === null ? {} : { aiProvider }),
    ...(settingsReader === null ? {} : { settingsProvider: settingsReader }),
    // 设置变更钩子：completion.corpusFile 改动后的下一次 complete 自动重载用户语料
    onSettingsRefreshed: () => syncUserCorpus(),
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

// ── 用户语料文件（设置项 completion.corpusFile）──────────────────────────

export interface CompletionUserCorpusStatus {
  /** unset=未配置路径；ok=已与内置语料合并；missing=文件不存在；invalid=内容非法；error=读取失败 */
  state: 'unset' | 'ok' | 'missing' | 'invalid' | 'error'
  path: string | null
  /** ok：用户语料中的命令条数 */
  userCommands?: number
  /** ok 但部分条目非法被丢弃时的明细 */
  problems?: string[]
  /** missing / invalid / error 时的具体原因（如实透出，不静默） */
  detail?: string
}

const realUserCorpusIo: UserCorpusIo = {
  readFile: async (path) => {
    try {
      return await readFile(path, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return null
      throw err
    }
  },
}

let activeCorpus: CompletionCorpus | null = null
let userCorpusStatus: CompletionUserCorpusStatus = { state: 'unset', path: null }
/** 已应用的用户语料文件路径；undefined = 尚未应用过（引擎重建后强制重新应用） */
let appliedCorpusFile: string | null | undefined = undefined

/** 用户语料层当前状态（界面/排障/测试用） */
export function completionUserCorpusStatus(): CompletionUserCorpusStatus {
  return { ...userCorpusStatus }
}

/**
 * 从设置里读用户语料文件路径。
 *
 * `completion.corpusFile` 不在 shared 的 CompletionSettings 契约里：设置文档
 * 深合并会保留未知键（sessionRecording 分组同款做法），运行时该字段存在，
 * 读不到（未配置/空串）按未配置处理。
 */
function corpusFilePathFromSettings(): string | null {
  if (settingsReader === null) return null
  try {
    const raw = (settingsReader() as { corpusFile?: unknown }).corpusFile
    if (typeof raw !== 'string') return null
    const trimmed = raw.trim()
    return trimmed.length === 0 ? null : trimmed
  } catch {
    return null
  }
}

async function applyUserCorpus(corpus: CompletionCorpus, path: string | null): Promise<void> {
  if (path === null) {
    corpus.setUserLayer(null)
    userCorpusStatus = { state: 'unset', path: null }
    return
  }

  const result = await loadUserCorpus(path, realUserCorpusIo)
  switch (result.state) {
    case 'ok': {
      corpus.setUserLayer(result.layer)
      userCorpusStatus = {
        state: 'ok',
        path,
        userCommands: result.userCommands,
        ...(result.problems.length > 0
          ? { problems: result.problems.map(formatUserCorpusProblem) }
          : {}),
      }
      activeCtx?.logger.info(
        `用户补全语料已加载：${result.userCommands} 条命令（${path}）` +
          (result.problems.length > 0 ? `；丢弃 ${result.problems.length} 条非法条目` : ''),
      )
      break
    }
    case 'missing':
      corpus.setUserLayer(null)
      userCorpusStatus = { state: 'missing', path, detail: '文件不存在，已降级为仅内置语料' }
      activeCtx?.logger.warn(`补全语料文件不存在：${path}（已降级为仅内置语料）`)
      break
    case 'invalid': {
      corpus.setUserLayer(null)
      const problems = result.problems.map(formatUserCorpusProblem)
      userCorpusStatus = { state: 'invalid', path, problems, detail: '文件内容非法，已降级为仅内置语料' }
      activeCtx?.logger.warn(`补全语料文件非法：${path}（已降级为仅内置语料）— ${problems.join('；')}`)
      break
    }
    case 'error':
      corpus.setUserLayer(null)
      userCorpusStatus = { state: 'error', path, detail: result.detail }
      activeCtx?.logger.warn(`补全语料文件读取失败：${path}（${result.detail}；已降级为仅内置语料）`)
      break
  }
}

/**
 * 让用户语料层与设置保持一致（幂等：路径没变就是 no-op）。
 *
 * 触发点：引擎每次 complete 读完设置后（onSettingsRefreshed）、listSpecs/search
 * handler 入口。语料加载的任何失败都折进状态，不影响补全本身。
 */
export async function syncUserCorpus(): Promise<void> {
  const path = corpusFilePathFromSettings()
  if (appliedCorpusFile === path) return
  const corpus = activeCorpus
  if (corpus === null) return // 引擎尚未建立；保持"未应用"，建引擎后首次读取时应用
  appliedCorpusFile = path
  try {
    await applyUserCorpus(corpus, path)
  } catch (err) {
    userCorpusStatus = {
      state: 'error',
      path,
      detail: err instanceof Error ? err.message : String(err),
    }
  }
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
  /** 渲染层置位的"本次是 `??` AI 请求"信号（主进程自己也会从行文本识别） */
  aiPrefix: z.boolean().optional(),
  cursor: z.number().int().min(0).optional(),
  history: z.array(historyEntrySchema).max(5000).optional(),
  limit: z.number().int().min(1).max(200).optional(),
  cwd: z.string().optional(),
})

const searchSchema = z.object({
  query: z.string(),
  limit: z.number().int().min(1).max(100).optional(),
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
    await syncUserCorpus()
    const entries = await getEngine(ctx).listSpecs()
    return { total: entries.length, entries }
  },

  /**
   * 命令搜索：输入命令名/用途关键词，返回候选 + 手册字段（用途/安装/语法/参数/示例/快捷键）。
   * 只提供参考，不向终端发送任何内容。
   */
  search: async (payload, ctx) => {
    const { query, limit } = searchSchema.parse(payload ?? {})
    await syncUserCorpus()
    return getEngine(ctx).search(query, limit)
  },
}
