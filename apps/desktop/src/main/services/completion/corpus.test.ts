// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 语料层单测：按需加载 / LRU / 负缓存 / 前缀索引 / 目录源安全 / 语料一致性。
 *
 * 「按需加载」用**计数源**断言：未命中的命令一次 loadSpec 都不该发生。
 */

import { describe, expect, it } from 'vitest'
import {
  CompletionCorpus,
  LruCache,
  PrefixIndex,
  bundledSpecSource,
  directorySpecSource,
  isSafeSpecName,
  type DirectorySourceIo,
  type SpecSource,
} from './corpus'
import { CATALOG, CATALOG_BY_NAME, CATALOG_SIZE } from './specs/catalog'
import { CATEGORY_LOADERS } from './specs/details'
import { COMMAND_CATEGORIES, normalizeSpec, type CommandIndexEntry, type CommandSpec, type SpecRows } from './specs/types'

// ── 测试替身 ──────────────────────────────────────────────────────────────

class CountingSource implements SpecSource {
  indexCalls = 0
  readonly specCalls: string[] = []

  constructor(
    private readonly entries: readonly CommandIndexEntry[],
    private readonly specs: Readonly<Record<string, CommandSpec | null>> = {},
  ) {}

  loadIndex(): Promise<readonly CommandIndexEntry[]> {
    this.indexCalls += 1
    return Promise.resolve(this.entries)
  }

  loadSpec(name: string): Promise<CommandSpec | null> {
    this.specCalls.push(name)
    return Promise.resolve(this.specs[name] ?? null)
  }
}

function entry(name: string): CommandIndexEntry {
  return { name, brief: `${name} 简述`, category: 'files' }
}

function spec(name: string): CommandSpec {
  return { name, options: [{ name: '--flag', description: '开关' }] }
}

// ── LRU ───────────────────────────────────────────────────────────────────

describe('LruCache', () => {
  it('容量必须为正', () => {
    expect(() => new LruCache<string, number>(0)).toThrow()
  })

  it('命中会提升为最近使用（淘汰最久未用）', () => {
    const cache = new LruCache<string, number>(2)
    cache.set('a', 1)
    cache.set('b', 2)
    expect(cache.get('a')).toBe(1) // a 变新
    cache.set('c', 3) // 淘汰 b

    expect(cache.has('b')).toBe(false)
    expect(cache.has('a')).toBe(true)
    expect(cache.has('c')).toBe(true)
    expect(cache.evictionCount).toBe(1)
    expect(cache.size).toBe(2)
  })

  it('未命中的键返回 undefined 且不影响顺序', () => {
    const cache = new LruCache<string, number>(2)
    cache.set('a', 1)
    cache.set('b', 2)
    expect(cache.get('zzz')).toBeUndefined()
    cache.set('c', 3) // 淘汰 a
    expect(cache.has('a')).toBe(false)
  })

  it('重复 set 同一个键不会增长', () => {
    const cache = new LruCache<string, number>(2)
    cache.set('a', 1)
    cache.set('a', 2)
    expect(cache.size).toBe(1)
    expect(cache.get('a')).toBe(2)
  })
})

// ── 前缀索引 ──────────────────────────────────────────────────────────────

describe('PrefixIndex', () => {
  const build = (): PrefixIndex<string> => {
    const trie = new PrefixIndex<string>()
    for (const name of ['ls', 'lsof', 'lsblk', 'git', 'grep']) trie.insert(name, name)
    return trie
  }

  it('按前缀收集', () => {
    expect(build().withPrefix('ls').sort()).toEqual(['ls', 'lsblk', 'lsof'])
  })

  it('大小写不敏感', () => {
    expect(build().withPrefix('LS').sort()).toEqual(['ls', 'lsblk', 'lsof'])
  })

  it('无匹配返回空数组', () => {
    expect(build().withPrefix('zzz')).toEqual([])
  })

  it('limit 限制收集数量（不会遍历整棵子树）', () => {
    expect(build().withPrefix('ls', 2)).toHaveLength(2)
  })

  it('空前缀返回全部', () => {
    expect(build().withPrefix('')).toHaveLength(5)
  })

  it('size 反映插入条数', () => {
    expect(build().size).toBe(5)
  })
})

// ── 语料门面 ──────────────────────────────────────────────────────────────

describe('CompletionCorpus', () => {
  it('索引只加载一次，且首屏不加载任何 spec', async () => {
    const source = new CountingSource([entry('ls'), entry('git')], { ls: spec('ls'), git: spec('git') })
    const corpus = new CompletionCorpus(source)

    await corpus.index()
    await corpus.index()

    expect(source.indexCalls).toBe(1)
    expect(source.specCalls).toEqual([]) // 关键：还没读任何详情
    expect(corpus.indexLoaded).toBe(true)
    expect(corpus.stats().specLoads).toBe(0)
  })

  it('首次命中才读 spec，二次命中走缓存', async () => {
    const source = new CountingSource([entry('ls')], { ls: spec('ls') })
    const corpus = new CompletionCorpus(source)
    await corpus.index()

    const first = await corpus.spec('ls')
    const second = await corpus.spec('ls')

    expect(first?.name).toBe('ls')
    expect(second).toBe(first) // 同一个对象 → 没重新解析
    expect(source.specCalls).toEqual(['ls'])
    const stats = corpus.stats()
    expect(stats.specLoads).toBe(1)
    expect(stats.specCacheHits).toBe(1)
  })

  it('未命中的命令不触发 spec 读取', async () => {
    const source = new CountingSource([entry('ls')], { ls: spec('ls') })
    const corpus = new CompletionCorpus(source)
    await corpus.index()

    // 索引里没有 zzz，因此连 loadSpec 都不该调用
    expect(corpus.entry('zzz')).toBeUndefined()
    expect(source.specCalls).toEqual([])
  })

  it('LRU 达到上限后淘汰最久未用，再命中会重新加载', async () => {
    const names = ['a', 'b', 'c']
    const source = new CountingSource(
      names.map(entry),
      Object.fromEntries(names.map((n) => [n, spec(n)])),
    )
    const corpus = new CompletionCorpus(source, { specCacheSize: 2 })
    await corpus.index()

    await corpus.spec('a')
    await corpus.spec('b')
    await corpus.spec('c') // 淘汰 a

    expect(corpus.stats().evictions).toBe(1)
    await corpus.spec('a') // 需要重新加载
    expect(source.specCalls).toEqual(['a', 'b', 'c', 'a'])
  })

  it('未命中进负缓存，TTL 内不再重复加载', async () => {
    let now = 1000
    const source = new CountingSource([entry('ghost')], {}) // 索引里有，但源返回 null
    const corpus = new CompletionCorpus(source, {
      negativeTtlMs: 30_000,
      now: () => now,
    })
    await corpus.index()

    expect(await corpus.spec('ghost')).toBeNull()
    expect(await corpus.spec('ghost')).toBeNull()
    expect(source.specCalls).toEqual(['ghost']) // 只加载过一次
    expect(corpus.stats().negativeCacheHits).toBe(1)

    // TTL 过期后允许重试
    now += 31_000
    expect(await corpus.spec('ghost')).toBeNull()
    expect(source.specCalls).toEqual(['ghost', 'ghost'])
  })

  it('negativeTtlMs = 0 时禁用负缓存', async () => {
    const source = new CountingSource([entry('ghost')], {})
    const corpus = new CompletionCorpus(source, { negativeTtlMs: 0 })
    await corpus.index()
    await corpus.spec('ghost')
    await corpus.spec('ghost')
    expect(source.specCalls).toEqual(['ghost', 'ghost'])
  })

  it('clearCache 之后需要重新加载', async () => {
    const source = new CountingSource([entry('ls')], { ls: spec('ls') })
    const corpus = new CompletionCorpus(source)
    await corpus.index()
    await corpus.spec('ls')
    corpus.clearCache()
    await corpus.spec('ls')
    expect(source.specCalls).toEqual(['ls', 'ls'])
  })

  it('commandsWithPrefix 走索引，索引未加载时返回空', async () => {
    const source = new CountingSource([entry('ls'), entry('lsof'), entry('git')], {})
    const corpus = new CompletionCorpus(source)
    expect(corpus.commandsWithPrefix('ls', 10)).toEqual([]) // 还没加载索引

    await corpus.index()
    expect(corpus.commandsWithPrefix('ls', 10).map((e) => e.name).sort()).toEqual(['ls', 'lsof'])
  })

  it('stats 初始快照', () => {
    const corpus = new CompletionCorpus(new CountingSource([], {}))
    expect(corpus.stats()).toMatchObject({
      indexLoaded: false,
      indexSize: 0,
      specLoads: 0,
      specCacheHits: 0,
      specCacheMisses: 0,
      negativeCacheHits: 0,
      evictions: 0,
      cacheSize: 0,
    })
  })
})

// ── 目录源安全 ────────────────────────────────────────────────────────────

describe('isSafeSpecName', () => {
  it('接受普通扁平的命令名', () => {
    for (const name of ['ls', 'apt-get', 'docker-compose', '@scope-pkg', 'a.b_c+d']) {
      expect(isSafeSpecName(name)).toBe(true)
    }
  })

  it('拒绝路径穿越与非法字符（目录源用扁平文件名，因此 / 一律拒绝）', () => {
    for (const name of ['', '.', '..', '../../etc/passwd', '/etc/passwd', 'a/b', '@scope/pkg', 'a\\b', 'a\0b', 'x'.repeat(201)]) {
      expect(isSafeSpecName(name)).toBe(false)
    }
  })
})

describe('directorySpecSource', () => {
  function fakeIo(files: Record<string, string>): DirectorySourceIo & { reads: string[] } {
    const reads: string[] = []
    return {
      reads,
      join: (...parts) => parts.join('/'),
      readFile: (path) => {
        reads.push(path)
        return files[path] ?? null
      },
    }
  }

  it('加载索引并惰性读取单个 spec', async () => {
    const io = fakeIo({
      '/corpus/index.json': JSON.stringify({ commands: [{ name: 'ls', brief: '列目录', category: 'files' }] }),
      '/corpus/ls.json': JSON.stringify({ name: 'ls', options: [{ name: '-l', description: '长格式' }] }),
    })
    const source = directorySpecSource('/corpus', io)

    const index = await source.loadIndex()
    expect(index).toHaveLength(1)
    expect(io.reads).toEqual(['/corpus/index.json']) // 索引阶段没有读任何 spec

    const spec = await source.loadSpec('ls')
    expect(spec?.options[0]?.name).toBe('-l')
    expect(io.reads).toEqual(['/corpus/index.json', '/corpus/ls.json'])
  })

  it('非法名字直接拒绝，不产生读盘动作', async () => {
    const io = fakeIo({})
    const source = directorySpecSource('/corpus', io)
    expect(await source.loadSpec('../../etc/passwd')).toBeNull()
    expect(io.reads).toEqual([])
  })

  it('坏 JSON / 文件缺失都返回 null，不抛异常', async () => {
    const io = fakeIo({ '/corpus/index.json': '{oops', '/corpus/x.json': 'not json' })
    const source = directorySpecSource('/corpus', io)
    expect(await source.loadIndex()).toEqual([])
    expect(await source.loadSpec('x')).toBeNull()
  })
})

// ── 内置自建语料 ──────────────────────────────────────────────────────────

describe('bundledSpecSource', () => {
  it('索引来自 catalog，命令数达到起步要求', async () => {
    const index = await bundledSpecSource().loadIndex()
    expect(index.length).toBe(CATALOG_SIZE)
    expect(index.length).toBeGreaterThanOrEqual(100)
  })

  it('按需加载单条详情', async () => {
    const source = bundledSpecSource()
    const git = await source.loadSpec('git')
    expect(git?.name).toBe('git')
    expect(git?.subcommands?.length ?? 0).toBeGreaterThan(5)
    expect(git?.options.length ?? 0).toBeGreaterThan(3)
  })

  it('索引外的命令返回 null（不加载任何分类模块）', async () => {
    expect(await bundledSpecSource().loadSpec('definitely-not-a-command')).toBeNull()
  })
})

// ── 语料一致性 ────────────────────────────────────────────────────────────

describe('语料一致性（索引 ↔ 详情）', () => {
  async function loadAll(): Promise<Map<string, Record<string, SpecRows>>> {
    const out = new Map<string, Record<string, SpecRows>>()
    for (const category of COMMAND_CATEGORIES) {
      out.set(category, await CATEGORY_LOADERS[category]())
    }
    return out
  }

  it('索引里的每个命令都有同分类的详情', async () => {
    const byCategory = await loadAll()
    const missing = CATALOG.filter((e) => byCategory.get(e.category)?.[e.name] === undefined).map(
      (e) => e.name,
    )
    expect(missing).toEqual([])
  })

  it('详情里没有索引外的命令', async () => {
    const byCategory = await loadAll()
    const known = new Set(CATALOG.map((e) => e.name))
    const extra: string[] = []
    for (const details of byCategory.values()) {
      for (const name of Object.keys(details)) if (!known.has(name)) extra.push(name)
    }
    expect(extra).toEqual([])
  })

  it('hasSubcommands 标记与实际详情一致', async () => {
    const byCategory = await loadAll()
    const wrong: string[] = []
    for (const e of CATALOG) {
      const rows = byCategory.get(e.category)?.[e.name]
      const hasSubs = (rows?.subs?.length ?? 0) > 0
      if (hasSubs !== (e.hasSubcommands === true)) wrong.push(e.name)
    }
    expect(wrong).toEqual([])
  })

  it('选项/子命令字段非空，且同名选项不重复', async () => {
    const byCategory = await loadAll()
    const problems: string[] = []
    for (const [category, details] of byCategory) {
      for (const [name, rows] of Object.entries(details)) {
        const normalized = normalizeSpec(name, rows)
        const seen = new Set<string>()
        for (const option of normalized.options) {
          if (option.name.trim().length === 0) problems.push(`${name}: 空选项名`)
          if (option.description.trim().length === 0) problems.push(`${name}: ${option.name} 说明为空`)
          if (option.arg !== undefined && option.arg.trim().length === 0) {
            problems.push(`${name}: ${option.name} 参数占位为空`)
          }
          if (seen.has(option.name)) problems.push(`${name}: 选项重复 ${option.name}`)
          seen.add(option.name)
        }
        for (const sub of normalized.subcommands ?? []) {
          if (sub.name.trim().length === 0) problems.push(`${name}: 空子命令名`)
          if (sub.description.trim().length === 0) problems.push(`${name}: 子命令 ${sub.name} 说明为空`)
        }
      }
    }
    expect(problems).toEqual([])
  })

  it('分类覆盖所有条目，且每个分类都有内容', async () => {
    const byCategory = await loadAll()
    const unknown = CATALOG.filter((e) => !COMMAND_CATEGORIES.includes(e.category)).map((e) => e.name)
    expect(unknown).toEqual([])
    for (const category of COMMAND_CATEGORIES) {
      expect((byCategory.get(category) ?? {}) as object).not.toEqual({})
    }
  })

  it('CATALOG_BY_NAME 与 CATALOG 一一对应', () => {
    expect(CATALOG_BY_NAME.size).toBe(CATALOG_SIZE)
  })
})
