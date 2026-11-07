// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 语料加载层：**按需加载 + LRU + 前缀索引**。
 *
 * 性能设计（对应任务书的 ★ 要求）：
 * - 首屏只加载「命令名索引」（`specs/catalog.ts`，体积断言见 performance.test.ts），
 *   选项明细在第一次真正命中某命令时才加载，且**按分类惰性 import**。
 * - 命中过的 spec 进 **LRU**（上限可配），二次命中不再走加载器。
 * - 未命中的命令进**负缓存**（TTL，默认 30s），避免反复对同一个不存在的名字做无效加载。
 * - 命令名匹配走**前缀树**（trie），复杂度与语料规模解耦，不做线性遍历。
 *
 * 该文件还提供两种 `SpecSource`：
 * - `bundledSpecSource()`：内置自建语料（生产用，分类惰性 import）
 * - `directorySpecSource()`：从磁盘目录读取（用户自建语料 / 测试用，含路径穿越校验）
 */

import type { CommandIndexEntry, CommandSpec } from './specs/types'
import { normalizeSpec } from './specs/types'
import { CATALOG, CATALOG_BY_NAME } from './specs/catalog'
import { CATEGORY_LOADERS } from './specs/details'

// ── LRU ──────────────────────────────────────────────────────────────────

/**
 * 最小 LRU：Map 的插入顺序即使用顺序，命中时删除再插入实现「提升」。
 */
export class LruCache<K, V> {
  private readonly entries = new Map<K, V>()
  private evictions = 0

  constructor(private readonly maxSize: number) {
    if (maxSize <= 0) throw new Error('LruCache 容量必须为正数')
  }

  get size(): number {
    return this.entries.size
  }

  get evictionCount(): number {
    return this.evictions
  }

  has(key: K): boolean {
    return this.entries.has(key)
  }

  get(key: K): V | undefined {
    const value = this.entries.get(key)
    if (value === undefined) return undefined
    // 提升为最近使用
    this.entries.delete(key)
    this.entries.set(key, value)
    return value
  }

  set(key: K, value: V): void {
    if (this.entries.has(key)) this.entries.delete(key)
    this.entries.set(key, value)
    while (this.entries.size > this.maxSize) {
      const oldest = this.entries.keys().next()
      if (oldest.done === true) break
      this.entries.delete(oldest.value)
      this.evictions += 1
    }
  }

  clear(): void {
    this.entries.clear()
  }

  /** 当前键（按最近使用从旧到新）——测试用 */
  keys(): K[] {
    return [...this.entries.keys()]
  }
}

// ── 前缀索引（trie） ──────────────────────────────────────────────────────

class TrieNode<T> {
  readonly children = new Map<string, TrieNode<T>>()
  values: T[] | null = null
}

/**
 * 前缀树：`withPrefix()` 的代价只与「命中子树的大小」有关，
 * 与语料总量无关（对比线性 `filter(startsWith)`）。
 */
export class PrefixIndex<T> {
  private readonly root = new TrieNode<T>()
  private count = 0

  get size(): number {
    return this.count
  }

  insert(key: string, value: T): void {
    let node = this.root
    for (const ch of key.toLowerCase()) {
      let next = node.children.get(ch)
      if (next === undefined) {
        next = new TrieNode<T>()
        node.children.set(ch, next)
      }
      node = next
    }
    ;(node.values ??= []).push(value)
    this.count += 1
  }

  /** 收集所有以 prefix 开头的值（大小写不敏感），最多 limit 个 */
  withPrefix(prefix: string, limit = Number.MAX_SAFE_INTEGER): T[] {
    let node = this.root
    for (const ch of prefix.toLowerCase()) {
      const next = node.children.get(ch)
      if (next === undefined) return []
      node = next
    }
    const out: T[] = []
    this.collect(node, out, limit)
    return out
  }

  private collect(node: TrieNode<T>, out: T[], limit: number): void {
    if (out.length >= limit) return
    if (node.values) {
      for (const value of node.values) {
        if (out.length >= limit) return
        out.push(value)
      }
    }
    for (const child of node.children.values()) {
      this.collect(child, out, limit)
      if (out.length >= limit) return
    }
  }
}

// ── 语料源 ────────────────────────────────────────────────────────────────

/** 语料来源抽象：索引 + 单条详情。所有性能断言都基于「loadSpec 被调用几次」。 */
export interface SpecSource {
  loadIndex(): Promise<readonly CommandIndexEntry[]>
  loadSpec(name: string): Promise<CommandSpec | null>
}

/** 内置自建语料：分类惰性 import */
export function bundledSpecSource(): SpecSource {
  return {
    loadIndex: () => Promise.resolve(CATALOG),
    loadSpec: async (name) => {
      const entry = CATALOG_BY_NAME.get(name)
      if (entry === undefined) return null // 不在索引里 → 一次模块也不加载
      const details = await CATEGORY_LOADERS[entry.category]()
      const rows = details[name]
      return rows === undefined ? null : normalizeSpec(name, rows)
    },
  }
}

export interface DirectorySourceIo {
  /** 读文本文件；不存在返回 null */
  readFile(path: string): string | null
  /** 拼接路径（注入以便测试） */
  join(...parts: string[]): string
}

/** 目录语料的索引文件格式 */
interface DirectoryIndexFile {
  commands?: unknown
}

/**
 * 路径穿越防护：只允许普通命令名，拒绝空串 / 分隔符 / `..` / 控制字符。
 * （参考实现的 isSafeWithfigSpecKey 同类校验；这里是我们自己的实现。）
 */
export function isSafeSpecName(name: string): boolean {
  if (name.length === 0 || name.length > 200) return false
  if (name.includes('/') || name.includes('\\') || name.includes('\0')) return false
  if (name === '.' || name === '..') return false
  return /^[A-Za-z0-9@._+-]+$/.test(name)
}

/**
 * 从磁盘目录读取语料：`<dir>/index.json` + `<dir>/<name>.json`。
 * 用于用户自建语料与单测（真实惰性 IO，不做任何预读）。
 */
export function directorySpecSource(dir: string, io: DirectorySourceIo): SpecSource {
  return {
    loadIndex: () => {
      const raw = io.readFile(io.join(dir, 'index.json'))
      if (raw === null) return Promise.resolve([])
      try {
        const parsed: DirectoryIndexFile = JSON.parse(raw)
        const commands = parsed.commands
        return Promise.resolve(Array.isArray(commands) ? (commands as CommandIndexEntry[]) : [])
      } catch {
        return Promise.resolve([])
      }
    },
    loadSpec: (name) => {
      if (!isSafeSpecName(name)) return Promise.resolve(null)
      const raw = io.readFile(io.join(dir, `${name}.json`))
      if (raw === null) return Promise.resolve(null)
      try {
        const parsed: unknown = JSON.parse(raw)
        if (typeof parsed !== 'object' || parsed === null) return Promise.resolve(null)
        const spec = parsed as CommandSpec
        return Promise.resolve({
          name,
          options: Array.isArray(spec.options) ? spec.options : [],
          ...(Array.isArray(spec.subcommands) ? { subcommands: spec.subcommands } : {}),
          ...(typeof spec.example === 'string' ? { example: spec.example } : {}),
        })
      } catch {
        return Promise.resolve(null)
      }
    },
  }
}

// ── 语料门面 ──────────────────────────────────────────────────────────────

export interface CorpusOptions {
  /** spec LRU 上限（默认 64） */
  specCacheSize?: number
  /** 未命中负缓存 TTL（ms，默认 30s；0 表示禁用负缓存） */
  negativeTtlMs?: number
  /** 可注入时钟（测试用） */
  now?: () => number
}

export interface CorpusStats {
  indexLoaded: boolean
  indexSize: number
  /** 真正调用 source.loadSpec 的次数 */
  specLoads: number
  specCacheHits: number
  specCacheMisses: number
  negativeCacheHits: number
  evictions: number
  cacheSize: number
}

export const DEFAULT_SPEC_CACHE_SIZE = 64
export const DEFAULT_NEGATIVE_TTL_MS = 30_000

/**
 * 语料门面：索引只加载一次；spec 走 LRU；未命中走 TTL 负缓存。
 * 引擎只依赖它，因此所有「按需加载」的行为都能用计数断言验证。
 */
export class CompletionCorpus {
  private readonly specCache: LruCache<string, CommandSpec>
  private readonly negativeUntil = new Map<string, number>()
  private readonly negativeTtlMs: number
  private readonly now: () => number

  private indexPromise: Promise<readonly CommandIndexEntry[]> | null = null
  private cachedIndex: readonly CommandIndexEntry[] | null = null
  private byName: Map<string, CommandIndexEntry> | null = null
  private prefix: PrefixIndex<CommandIndexEntry> | null = null

  private readonly counters = {
    specLoads: 0,
    specCacheHits: 0,
    specCacheMisses: 0,
    negativeCacheHits: 0,
  }

  constructor(
    private readonly source: SpecSource,
    options: CorpusOptions = {},
  ) {
    this.specCache = new LruCache<string, CommandSpec>(
      options.specCacheSize ?? DEFAULT_SPEC_CACHE_SIZE,
    )
    this.negativeTtlMs = options.negativeTtlMs ?? DEFAULT_NEGATIVE_TTL_MS
    this.now = options.now ?? (() => Date.now())
  }

  /** 索引（首屏唯一加载项），只读一次 */
  async index(): Promise<readonly CommandIndexEntry[]> {
    if (this.cachedIndex) return this.cachedIndex
    this.indexPromise ??= this.source.loadIndex().then((entries) => {
      this.cachedIndex = entries
      this.byName = new Map(entries.map((e) => [e.name, e]))
      const trie = new PrefixIndex<CommandIndexEntry>()
      for (const entry of entries) trie.insert(entry.name, entry)
      this.prefix = trie
      return entries
    })
    return this.indexPromise
  }

  get indexLoaded(): boolean {
    return this.cachedIndex !== null
  }

  /** 索引里的条目（需要先 await index()） */
  entry(name: string): CommandIndexEntry | undefined {
    return this.byName?.get(name)
  }

  /** 前缀匹配命令名；索引未加载时返回空数组 */
  commandsWithPrefix(prefix: string, limit: number): CommandIndexEntry[] {
    return this.prefix?.withPrefix(prefix, limit) ?? []
  }

  /** 单条命令详情：LRU → 负缓存 → 源加载 */
  async spec(name: string): Promise<CommandSpec | null> {
    const cached = this.specCache.get(name)
    if (cached !== undefined) {
      this.counters.specCacheHits += 1
      return cached
    }
    this.counters.specCacheMisses += 1

    const until = this.negativeUntil.get(name)
    if (until !== undefined) {
      if (until > this.now()) {
        this.counters.negativeCacheHits += 1
        return null
      }
      this.negativeUntil.delete(name)
    }

    this.counters.specLoads += 1
    const spec = await this.source.loadSpec(name)
    if (spec === null) {
      if (this.negativeTtlMs > 0) this.negativeUntil.set(name, this.now() + this.negativeTtlMs)
      return null
    }
    this.specCache.set(name, spec)
    return spec
  }

  /** 清空缓存（用户更新语料后调用） */
  clearCache(): void {
    this.specCache.clear()
    this.negativeUntil.clear()
  }

  stats(): CorpusStats {
    return {
      indexLoaded: this.cachedIndex !== null,
      indexSize: this.cachedIndex?.length ?? 0,
      specLoads: this.counters.specLoads,
      specCacheHits: this.counters.specCacheHits,
      specCacheMisses: this.counters.specCacheMisses,
      negativeCacheHits: this.counters.negativeCacheHits,
      evictions: this.specCache.evictionCount,
      cacheSize: this.specCache.size,
    }
  }
}
