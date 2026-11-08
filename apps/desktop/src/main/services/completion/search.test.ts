// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 命令搜索 / 离线手册单测。
 *
 * 覆盖：四档排序（完全匹配 > 前缀 > 包含 > 描述命中）、中文描述可搜、
 * 大小写不敏感、空 query、limit/truncated、手册字段可取出、
 * 以及**加载策略**（首次搜索才构建索引、之后常驻；用计数源固化实际行为）。
 */

import { describe, expect, it } from 'vitest'
import { bundledSpecSource, CompletionCorpus, type CommandDoc, type SpecSource } from './corpus'
import { CompletionEngine } from './engine'
import {
  SEARCH_DEFAULT_LIMIT,
  SEARCH_MAX_LIMIT,
  SEARCH_SCORES,
  scoreDoc,
  searchCommands,
  type CommandSearchItem,
} from './search'
import { CATALOG, CATALOG_SIZE } from './specs/catalog'
import { MANUAL_CORE_SIZE } from './specs/manual'

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

/** 包装真实语料：只用来数「加载了几次」，行为与内置源一致 */
class CountingSource implements SpecSource {
  loadIndexCalls = 0
  loadSpecCalls = 0
  loadAllCalls = 0

  constructor(private readonly inner: SpecSource) {}

  loadIndex(): Promise<readonly import('./specs/types').CommandIndexEntry[]> {
    this.loadIndexCalls += 1
    return this.inner.loadIndex()
  }

  loadSpec(name: string): Promise<import('./specs/types').CommandSpec | null> {
    this.loadSpecCalls += 1
    return this.inner.loadSpec(name)
  }

  loadAllSpecs(): Promise<readonly import('./specs/types').CommandSpec[]> {
    this.loadAllCalls += 1
    const inner = this.inner.loadAllSpecs
    if (inner === undefined) return Promise.resolve([])
    return inner.call(this.inner)
  }
}

function doc(over: Partial<CommandDoc> & { name: string }): CommandDoc {
  const matchText = over.matchText ?? over.name.toLowerCase()
  return {
    brief: `${over.name} 简述`,
    category: 'files',
    categoryLabel: '文件与目录',
    options: [],
    matchText,
    matchPrimary: over.matchPrimary ?? matchText,
    ...over,
  }
}

const realEngine = (): { engine: CompletionEngine; corpus: CompletionCorpus } => {
  const corpus = new CompletionCorpus(bundledSpecSource())
  return { engine: new CompletionEngine({ corpus }), corpus }
}

const names = (items: readonly CommandSearchItem[]): string[] => items.map((i) => i.name)

// ---------------------------------------------------------------------------
// 排序（纯函数，精确控制）
// ---------------------------------------------------------------------------

describe('排序分档：完全匹配 > 前缀 > 包含 > 描述命中', () => {
  it('一次查询同时体现四档，且顺序可解释', () => {
    const docs: CommandDoc[] = [
      doc({ name: 'tar', matchText: 'tar 打包归档' }),
      doc({ name: 'start' }), // 包含 tar
      doc({ name: 'restart' }), // 包含 tar（更长 → 更靠后）
      doc({ name: 'archive', matchText: '打包成 tar 归档' }), // 仅描述命中
    ]
    const result = searchCommands(docs, 'tar')
    expect(names(result.results)).toEqual(['tar', 'start', 'restart', 'archive'])
  })

  it('scoreDoc 返回命中的档位（可解释）', () => {
    expect(scoreDoc(doc({ name: 'tar' }), 'tar')?.kind).toBe('exact')
    expect(scoreDoc(doc({ name: 'tar' }), 'ta')?.kind).toBe('prefix')
    expect(scoreDoc(doc({ name: 'restart' }), 'tar')?.kind).toBe('contains')
    expect(scoreDoc(doc({ name: 'x', matchText: '里面提到 tar' }), 'tar')?.kind).toBe('text')
    expect(scoreDoc(doc({ name: 'x' }), 'zzz')).toBeNull()
  })

  it('档位分数区间不重叠 → 档位永远优先于名字长度', () => {
    expect(SEARCH_SCORES.prefix - 64).toBeGreaterThan(SEARCH_SCORES.contains)
    expect(SEARCH_SCORES.contains - 64).toBeGreaterThan(SEARCH_SCORES.text)
  })

  it('同一"描述命中"档位内：命中用途 优先于 只命中选项/示例', () => {
    const docs: CommandDoc[] = [
      // 只在选项描述里出现 "compress"
      doc({ name: 'aa', matchText: 'x compress', matchPrimary: 'aa 简述' }),
      // 用途里就有 "compress"
      doc({ name: 'zz', matchText: 'zz compress', matchPrimary: 'zz 用于 compress 文件' }),
    ]
    expect(names(searchCommands(docs, 'compress').results)).toEqual(['zz', 'aa'])
  })

  it('档位内细分不会越过档位边界（包含命中仍高于用途命中）', () => {
    const docs: CommandDoc[] = [
      doc({ name: 'xcompress', matchPrimary: 'xcompress' }), // 名字包含
      doc({ name: 'z', matchText: 'z 用途 compress', matchPrimary: 'z 用于 compress' }), // 用途命中
    ]
    expect(names(searchCommands(docs, 'compress').results)).toEqual(['xcompress', 'z'])
  })

  it('同档位短名优先（git 在 gitea 前）', () => {
    const docs = [doc({ name: 'gitea' }), doc({ name: 'git' })]
    expect(names(searchCommands(docs, 'gi').results)).toEqual(['git', 'gitea'])
  })

  it('真实语料：前缀命中排在包含命中之前', async () => {
    const { engine } = realEngine()
    // grep 是前缀命中；pgrep 只是包含 "gr"
    const list = names((await engine.search('gr', 50)).results)
    expect(list[0]).toBe('grep')
    expect(list).toContain('pgrep')
    expect(list.indexOf('grep')).toBeLessThan(list.indexOf('pgrep'))
  })

  it('真实语料：完全匹配 > 包含匹配', async () => {
    const { engine } = realEngine()
    // at 是命令本身；cat / date / stat / patch 只是包含 "at"
    const list = names((await engine.search('at', 50)).results)
    expect(list[0]).toBe('at')
    expect(list).toContain('cat')
    expect(list.indexOf('at')).toBeLessThan(list.indexOf('cat'))
  })

  it('真实语料：完全匹配排第一', async () => {
    const { engine } = realEngine()
    for (const query of ['grep', 'tar', 'docker', 'git']) {
      const result = await engine.search(query, 10)
      expect(result.results[0]?.name, `query=${query}`).toBe(query)
    }
  })
})

// ---------------------------------------------------------------------------
// 匹配范围
// ---------------------------------------------------------------------------

describe('匹配范围：命令名 + 用途 + 选项描述', () => {
  it('★ 中文用途可搜（"压缩" → tar / gzip / xz）', async () => {
    const { engine } = realEngine()
    const result = await engine.search('压缩', 50)
    const list = names(result.results)
    expect(list).toContain('tar')
    expect(list).toContain('gzip')
    expect(list).toContain('xz')
    // 这些是描述命中（名字里没有"压缩"）
    expect(result.results.find((r) => r.name === 'tar')).toBeDefined()
  })

  it('★ "端口" → netstat / ss / lsof', async () => {
    const { engine } = realEngine()
    const list = names((await engine.search('端口', 50)).results)
    expect(list).toContain('netstat')
    expect(list).toContain('ss')
    expect(list).toContain('lsof')
  })

  it('选项描述也参与匹配（搜 "-l" 类关键词能命中）', async () => {
    const { engine } = realEngine()
    // "长格式" 出现在 ls 的 -l 描述里
    const list = names((await engine.search('长格式', 50)).results)
    expect(list).toContain('ls')
  })

  it('子命令描述参与匹配（"变基" → git/rebase 子命令）', async () => {
    const { engine } = realEngine()
    const list = names((await engine.search('变基', 50)).results)
    expect(list).toContain('git')
  })

  it('大小写不敏感', async () => {
    const { engine } = realEngine()
    expect((await engine.search('GREP', 5)).results[0]?.name).toBe('grep')
    expect((await engine.search('Tar', 5)).results[0]?.name).toBe('tar')
    expect((await engine.search('DOCKER', 5)).results[0]?.name).toBe('docker')
  })

  it('查不到时返回空结果（不是全量）', async () => {
    const { engine } = realEngine()
    const result = await engine.search('zzzznotacommand', 20)
    expect(result.results).toEqual([])
    expect(result.truncated).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 空 query / limit / truncated
// ---------------------------------------------------------------------------

describe('空 query 与 limit / truncated 语义', () => {
  it('空 query（含纯空白）→ 空结果，避免一次刷出 214 条', async () => {
    const { engine } = realEngine()
    for (const query of ['', '   ', '\t']) {
      const result = await engine.search(query)
      expect(result.results, `query=${JSON.stringify(query)}`).toEqual([])
      expect(result.truncated).toBe(false)
    }
  })

  it('空 query 不会触发索引构建（连明细都不读）', async () => {
    const source = new CountingSource(bundledSpecSource())
    const engine = new CompletionEngine({ corpus: new CompletionCorpus(source) })
    await engine.search('')
    expect(source.loadAllCalls).toBe(0)
  })

  it('默认 limit = 20', async () => {
    const { engine } = realEngine()
    const result = await engine.search('a')
    expect(result.results.length).toBeLessThanOrEqual(SEARCH_DEFAULT_LIMIT)
    expect(result.results.length).toBe(SEARCH_DEFAULT_LIMIT)
    expect(result.truncated).toBe(true)
  })

  it('limit 生效且 truncated 如实反映截断', async () => {
    const { engine } = realEngine()
    const small = await engine.search('a', 5)
    expect(small.results).toHaveLength(5)
    expect(small.truncated).toBe(true)

    // 匹配数远小于上限时不应标记截断
    const big = await engine.search('tar', SEARCH_MAX_LIMIT)
    expect(big.results.length).toBeGreaterThan(0)
    expect(big.results.length).toBeLessThan(SEARCH_MAX_LIMIT)
    expect(big.truncated).toBe(false)
  })

  it('limit 越界被夹到 1..100', async () => {
    const { engine } = realEngine()
    expect((await engine.search('a', 0)).results).toHaveLength(1)
    expect((await engine.search('a', 9999)).results.length).toBeLessThanOrEqual(SEARCH_MAX_LIMIT)
  })

  it('query 回显（去掉首尾空白）', async () => {
    const { engine } = realEngine()
    expect((await engine.search('  tar  ', 5)).query).toBe('tar')
  })
})

// ---------------------------------------------------------------------------
// 手册字段
// ---------------------------------------------------------------------------

describe('手册字段（用途/安装/语法/参数/示例/快捷键）', () => {
  it('tar：用途 + 语法 + 安装 + 示例都有', async () => {
    const { engine } = realEngine()
    const item = (await engine.search('tar', 5)).results.find((r) => r.name === 'tar')
    expect(item?.summary).toContain('归档')
    expect(item?.usage).toContain('tar')
    expect(item?.install).toBeTruthy()
    expect(item?.examples?.length ?? 0).toBeGreaterThanOrEqual(2)
    expect(item?.examples?.[0]?.command).toBeTruthy()
    expect(item?.examples?.[0]?.description).toBeTruthy()
    expect(item?.options?.length ?? 0).toBeGreaterThan(0)
  })

  it('非系统自带命令给出安装方式（htop → apt install htop）', async () => {
    const { engine } = realEngine()
    const item = (await engine.search('htop', 5)).results.find((r) => r.name === 'htop')
    expect(item?.install).toContain('apt install htop')
  })

  it('交互式命令带常用快捷键（less → q / g / G / /）', async () => {
    const { engine } = realEngine()
    const item = (await engine.search('less', 5)).results.find((r) => r.name === 'less')
    const keys = item?.shortcuts?.map((s) => s.key) ?? []
    expect(keys).toContain('q')
    expect(keys.some((k) => k.includes('g / G'))).toBe(true)
    expect(keys.some((k) => k.includes('/'))).toBe(true)
  })

  it('分类是中文标签（UI 直接可显示）', async () => {
    const { engine } = realEngine()
    const item = (await engine.search('grep', 5)).results[0]
    expect(item?.category).toBe('文本处理')
    const net = (await engine.search('netstat', 5)).results[0]
    expect(net?.category).toBe('网络')
  })

  it('子命令作为结构返回（git 子命令可展开）', async () => {
    const { engine } = realEngine()
    const item = (await engine.search('git', 5)).results[0]
    expect(item?.subcommands?.some((s) => s.name === 'commit')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 覆盖度：214 条都要有用途与语法
// ---------------------------------------------------------------------------

describe('手册覆盖度', () => {
  it('目录里每一条命令都有文档、且都有用途与语法', async () => {
    const corpus = new CompletionCorpus(bundledSpecSource())
    const docs = await corpus.docs()
    expect(docs).toHaveLength(CATALOG_SIZE)

    const missing = docs
      .filter((d) => d.purpose === undefined || d.purpose === '' || d.usage === undefined || d.usage === '')
      .map((d) => d.name)
    expect(missing).toEqual([])

    // 目录顺序一致，且每条都能搜到（按名字精确搜）
    expect(docs.map((d) => d.name)).toEqual(CATALOG.map((e) => e.name))
    const searchable = docs.filter((d) => scoreDoc(d, d.name)?.kind === 'exact')
    expect(searchable).toHaveLength(CATALOG_SIZE)
  })

  it('详版（含示例）覆盖足够多，其余也都有基础手册', async () => {
    expect(MANUAL_CORE_SIZE).toBeGreaterThanOrEqual(60)
    const corpus = new CompletionCorpus(bundledSpecSource())
    const docs = await corpus.docs()
    const withExamples = docs.filter((d) => (d.examples?.length ?? 0) > 0)
    expect(withExamples.length).toBeGreaterThanOrEqual(MANUAL_CORE_SIZE)
    // 基础手册：所有条目都有用途+语法（上面已断言）
  })

  it('分类标签覆盖全部分类', async () => {
    const corpus = new CompletionCorpus(bundledSpecSource())
    const labels = new Set((await corpus.docs()).map((d) => d.categoryLabel))
    expect(labels.size).toBeGreaterThanOrEqual(9)
    expect(labels.has('文件与目录')).toBe(true)
    expect(labels.has('网络')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// ★ 加载策略（lead 特别关心：搜索要不要全量加载）
// ---------------------------------------------------------------------------

describe('★ 加载策略与代价', () => {
  it('不搜索就不加载：索引构建之前 loadAllSpecs 一次都没发生', async () => {
    const source = new CountingSource(bundledSpecSource())
    const corpus = new CompletionCorpus(source)
    const engine = new CompletionEngine({ corpus })

    // 只用 listSpecs（命令名索引）——明细不该被读
    await engine.listSpecs()
    expect(source.loadAllCalls).toBe(0)
    expect(source.loadSpecCalls).toBe(0)
    expect(corpus.docsBuilt).toBe(false)
    expect(engine.searchIndexBuilt).toBe(false)
  })

  it('首次搜索才构建索引（一次），之后常驻不再重复加载', async () => {
    const source = new CountingSource(bundledSpecSource())
    const corpus = new CompletionCorpus(source)
    const engine = new CompletionEngine({ corpus })

    await engine.search('tar', 5)
    expect(source.loadAllCalls).toBe(1)
    expect(corpus.docsBuilt).toBe(true)
    expect(corpus.stats().docsBuilt).toBe(true)
    expect(corpus.stats().docsSize).toBe(CATALOG_SIZE)

    // 后续搜索不再加载任何东西
    await engine.search('grep', 5)
    await engine.search('压缩', 5)
    await engine.search('端口', 5)
    expect(source.loadAllCalls).toBe(1)
    expect(corpus.stats().specLoads).toBe(0) // 批量入口没有走逐个 loadSpec
  })

  it('首次搜索的代价实测（构建全量索引），并断言上限', async () => {
    const corpus = new CompletionCorpus(bundledSpecSource())
    const engine = new CompletionEngine({ corpus })

    const started = performance.now()
    const result = await engine.search('tar', 5)
    const coldMs = performance.now() - started

    const warmStarted = performance.now()
    for (let i = 0; i < 50; i += 1) await engine.search('压缩', 5)
    const warmAvg = (performance.now() - warmStarted) / 50

    const docs = await corpus.docs()
    console.log(
      `[perf] 命令搜索：${docs.length} 条文档；首次（含索引构建）${coldMs.toFixed(2)}ms；` +
        `后续平均 ${warmAvg.toFixed(3)}ms`,
    )
    expect(result.results[0]?.name).toBe('tar')
    expect(coldMs).toBeLessThan(200)
    expect(warmAvg).toBeLessThan(20)
  })

  it('批量加载失败回退到逐个 loadSpec（自定义源未实现 loadAllSpecs 时）', async () => {
    const inner = bundledSpecSource()
    const source: SpecSource = {
      loadIndex: () => inner.loadIndex(),
      loadSpec: (name) => inner.loadSpec(name),
      // 故意不实现 loadAllSpecs
    }
    const corpus = new CompletionCorpus(source)
    const docs = await corpus.docs()
    expect(docs).toHaveLength(CATALOG_SIZE)
    expect(docs.every((d) => d.options !== undefined)).toBe(true)
  })
})
