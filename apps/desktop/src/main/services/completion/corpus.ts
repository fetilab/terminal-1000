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

import type {
  CommandCategory,
  CommandIndexEntry,
  CommandSpec,
  SpecExample,
  SpecOption,
  SpecShortcut,
  SpecSubcommand,
} from './specs/types'
import { CATEGORY_LABELS, applyManual, isSafeSpecName, normalizeSpec } from './specs/types'
import { CATALOG, CATALOG_BY_NAME } from './specs/catalog'
import { CATEGORY_LOADERS } from './specs/details'
import { COMMAND_CATEGORIES } from './specs/types'
import { MANUAL_BY_NAME } from './specs/manual'
import { mergeIndexEntries, type UserCorpusLayer } from './userCorpus'

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
  /**
   * 一次性加载全部明细（命令搜索/手册索引用）。
   *
   * 搜索必须扫全部描述文本才能正确排序（用户搜"压缩"要能找到 tar），
   * 所以这里给一个"批量入口"，让按分类的惰性 import 只发生一次、
   * 而不是逐个 loadSpec 把 LRU 冲掉。未实现时由 corpus 回退到逐个加载。
   */
  loadAllSpecs?(): Promise<readonly CommandSpec[]>
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
    /**
     * 一次加载全部明细：只 import 用到的分类模块（同一分类复用同一个 module promise），
     * 因此 9 个分类模块最多各加载一次。
     */
    loadAllSpecs: async () => {
      const specs: CommandSpec[] = []
      for (const category of COMMAND_CATEGORIES) {
        const details = await CATEGORY_LOADERS[category]()
        for (const [name, rows] of Object.entries(details)) specs.push(normalizeSpec(name, rows))
      }
      return specs
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
 * 实现移到叶子模块 specs/types（用户语料文件也要用它），这里保留导出兼容既有 import。
 */
export { isSafeSpecName } from './specs/types'

/**
 * 从磁盘目录读取语料：`<dir>/index.json` + `<dir>/<name>.json`。
 * 用于用户自建语料与单测（真实惰性 IO，不做任何预读）。
 */
export function directorySpecSource(dir: string, io: DirectorySourceIo): SpecSource {
  const readSpec = (name: string): CommandSpec | null => {
    if (!isSafeSpecName(name)) return null
    const raw = io.readFile(io.join(dir, `${name}.json`))
    if (raw === null) return null
    try {
      const parsed: unknown = JSON.parse(raw)
      if (typeof parsed !== 'object' || parsed === null) return null
      const spec = parsed as CommandSpec
      return {
        name,
        options: Array.isArray(spec.options) ? spec.options : [],
        ...(Array.isArray(spec.subcommands) ? { subcommands: spec.subcommands } : {}),
        ...(typeof spec.example === 'string' ? { example: spec.example } : {}),
        ...(typeof spec.purpose === 'string' ? { purpose: spec.purpose } : {}),
        ...(typeof spec.usage === 'string' ? { usage: spec.usage } : {}),
        ...(typeof spec.install === 'string' ? { install: spec.install } : {}),
        ...(Array.isArray(spec.examples) ? { examples: spec.examples } : {}),
        ...(Array.isArray(spec.shortcuts) ? { shortcuts: spec.shortcuts } : {}),
      }
    } catch {
      return null
    }
  }

  const readIndex = (): readonly CommandIndexEntry[] => {
    const raw = io.readFile(io.join(dir, 'index.json'))
    if (raw === null) return []
    try {
      const parsed: DirectoryIndexFile = JSON.parse(raw)
      const commands = parsed.commands
      return Array.isArray(commands) ? (commands as CommandIndexEntry[]) : []
    } catch {
      return []
    }
  }

  return {
    loadIndex: () => Promise.resolve(readIndex()),
    loadSpec: (name) => Promise.resolve(readSpec(name)),
    loadAllSpecs: () => {
      const specs: CommandSpec[] = []
      for (const entry of readIndex()) {
        const spec = readSpec(entry.name)
        if (spec !== null) specs.push(spec)
      }
      return Promise.resolve(specs)
    },
  }
}

/** 把一条命令的可检索文本拼成小写串（用途 + 简述 + 选项/子命令 + 示例命令） */
function buildMatchText(entry: CommandIndexEntry, spec: CommandSpec): string {
  const parts: string[] = [entry.name, entry.brief]
  if (spec.purpose !== undefined) parts.push(spec.purpose)
  if (spec.usage !== undefined) parts.push(spec.usage)
  for (const option of spec.options) {
    parts.push(option.name, option.description)
    if (option.arg !== undefined) parts.push(option.arg)
  }
  for (const sub of spec.subcommands ?? []) parts.push(sub.name, sub.description)
  for (const example of spec.examples ?? []) parts.push(example.command, example.description)
  return parts.join(' ').toLowerCase()
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

/**
 * 命令搜索/手册用的一条完整文档：目录（名字/简述/分类）+ 明细（选项/子命令）+ 手册
 * （用途/安装/语法/示例/快捷键）合并成 UI 可直接渲染的形状。
 */
export interface CommandDoc {
  name: string
  brief: string
  category: CommandCategory
  /** 分类中文标签（UI 直接显示） */
  categoryLabel: string
  purpose?: string
  install?: string
  usage?: string
  examples?: SpecExample[]
  shortcuts?: SpecShortcut[]
  options: SpecOption[]
  subcommands?: SpecSubcommand[]
  /** 供描述命中检索的小写文本（用途 + 简述 + 选项/子命令 + 示例命令） */
  matchText: string
  /**
   * 其中属于「用途/简述」的那部分（小写）。
   * 用于在同一个"描述命中"档位内细分：命中用途比只命中选项/示例更可能是用户想要的。
   */
  matchPrimary: string
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
  /** 搜索/手册索引是否已构建 */
  docsBuilt: boolean
  docsSize: number
}

export const DEFAULT_SPEC_CACHE_SIZE = 64
export const DEFAULT_NEGATIVE_TTL_MS = 30_000

/**
 * 语料门面：索引只加载一次；spec 走 LRU；未命中走 TTL 负缓存。
 * 可选的用户语料层（setUserLayer）在所有读取路径上覆盖内置语料：同名命令以用户文件为准。
 * 引擎只依赖它，因此所有「按需加载」的行为都能用计数断言验证。
 */
export class CompletionCorpus {
  private readonly specCache: LruCache<string, CommandSpec>
  private readonly negativeUntil = new Map<string, number>()
  private readonly negativeTtlMs: number
  private readonly now: () => number

  private docsPromise: Promise<readonly CommandDoc[]> | null = null
  private docsCache: readonly CommandDoc[] = []
  private indexPromise: Promise<readonly CommandIndexEntry[]> | null = null
  private cachedIndex: readonly CommandIndexEntry[] | null = null
  private byName: Map<string, CommandIndexEntry> | null = null
  private prefix: PrefixIndex<CommandIndexEntry> | null = null

  /** 用户语料层（completion.corpusFile）；null = 未启用，只用内置语料 */
  private userLayer: UserCorpusLayer | null = null

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

  /**
   * 设置/移除用户语料层（null = 移除）。
   *
   * 层一换，索引/spec/搜索文档的全部缓存作废：下次访问按新层重建。
   * 用户层条目**不经** LRU/负缓存——同名命令整体覆盖内置明细，重载以层为单位整体替换。
   */
  setUserLayer(layer: UserCorpusLayer | null): void {
    this.userLayer = layer
    this.specCache.clear()
    this.negativeUntil.clear()
    this.docsPromise = null
    this.docsCache = []
    this.cachedIndex = null
    this.indexPromise = null
    this.byName = null
    this.prefix = null
  }

  /** 索引（首屏唯一加载项），只读一次 */
  async index(): Promise<readonly CommandIndexEntry[]> {
    if (this.cachedIndex) return this.cachedIndex
    this.indexPromise ??= this.source.loadIndex().then((entries) => {
      // 用户语料追加/覆盖索引条目：同名条目只覆盖用户显式提供的字段，新命令追加
      const merged =
        this.userLayer === null ? entries : mergeIndexEntries(entries, this.userLayer.indexEntries)
      this.cachedIndex = merged
      this.byName = new Map(merged.map((e) => [e.name, e]))
      const trie = new PrefixIndex<CommandIndexEntry>()
      for (const entry of merged) trie.insert(entry.name, entry)
      this.prefix = trie
      return merged
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

  /**
   * 命令手册/搜索索引（**首次使用时一次性构建，之后常驻**）。
   *
   * 代价与取舍（写清楚，不悄悄退化成"启动全加载"）：
   * - 搜索要扫用途/选项描述才能正确排序，因此这一步会把**全部明细**读进来
   *   （内置语料 9 个分类模块，实测见 search.test.ts 的耗时/规模断言）；
   * - 但它**不在启动路径**上：没有任何搜索/手册请求时，一个分类模块都不会被 import；
   * - 构建后常驻内存，后续搜索零额外加载。
   */
  async docs(): Promise<readonly CommandDoc[]> {
    if (this.docsPromise === null) {
      this.docsPromise = this.buildDocs().then((docs) => {
        this.docsCache = docs
        return docs
      })
    }
    return this.docsPromise
  }

  get docsBuilt(): boolean {
    return this.docsPromise !== null
  }

  private async buildDocs(): Promise<readonly CommandDoc[]> {
    const entries = await this.index()
    const specs = this.source.loadAllSpecs
      ? await this.source.loadAllSpecs()
      : (await Promise.all(entries.map((e) => this.spec(e.name)))).filter(
          (s): s is CommandSpec => s !== null,
        )
    const byName = new Map(specs.map((spec) => [spec.name, spec]))
    // 用户语料覆盖的命令以用户文件为唯一真相：明细与手册字段都不再来自内置
    if (this.userLayer !== null) {
      for (const [name, userSpec] of this.userLayer.specs) byName.set(name, userSpec)
    }

    return entries.map((entry) => {
      const base = byName.get(entry.name)
      // 浅拷贝：手册字段写在副本上，不污染 LRU 里的 spec
      const merged: CommandSpec = base === undefined ? { name: entry.name, options: [] } : { ...base }
      if (this.userLayer?.specs.has(entry.name) !== true) {
        const manual = MANUAL_BY_NAME.get(entry.name)
        if (manual) applyManual(merged, manual)
      }

      const doc: CommandDoc = {
        name: entry.name,
        brief: entry.brief,
        category: entry.category,
        categoryLabel: CATEGORY_LABELS[entry.category],
        options: merged.options,
        matchText: buildMatchText(entry, merged),
        matchPrimary: `${entry.name} ${entry.brief} ${merged.purpose ?? ''}`.toLowerCase(),
      }
      if (merged.purpose !== undefined) doc.purpose = merged.purpose
      if (merged.install !== undefined) doc.install = merged.install
      if (merged.usage !== undefined) doc.usage = merged.usage
      if (merged.examples !== undefined) doc.examples = merged.examples
      if (merged.shortcuts !== undefined) doc.shortcuts = merged.shortcuts
      if (merged.subcommands !== undefined && merged.subcommands.length > 0) {
        doc.subcommands = merged.subcommands
      }
      return doc
    })
  }

  /** 单条命令详情：用户层（同名覆盖） → LRU → 负缓存 → 源加载 */
  async spec(name: string): Promise<CommandSpec | null> {
    const userSpec = this.userLayer?.specs.get(name)
    if (userSpec !== undefined) return userSpec

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
      docsBuilt: this.docsPromise !== null,
      docsSize: this.docsCache.length,
    }
  }
}
