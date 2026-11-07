// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 性能断言（本模块的主要反超点）。
 *
 * 阈值刻意放宽（避免 CI 抖动），但**每一项都必须断言**，并且把实测值打到
 * 测试输出里，便于汇报与回归对比：
 * - 首屏只加载小索引，绝不加载任何 spec
 * - 5000 条语料下单次补全 < 50ms（任务书目标 50ms）
 * - 重复补全平均 < 5ms
 * - 语料索引体积远小于「15MB 级」的第三方语料
 */

import { describe, expect, it } from 'vitest'
import type { CompletionSettings } from '@t1000/shared'
import { CompletionCorpus, bundledSpecSource, type SpecSource } from './corpus'
import { CompletionEngine } from './engine'
import { CATALOG, CATALOG_SIZE } from './specs/catalog'
import { CATEGORY_LOADERS } from './specs/details'
import { COMMAND_CATEGORIES, type CommandIndexEntry, type CommandSpec } from './specs/types'

/** 单次补全的耗时上限（任务书目标：50ms） */
const COMPLETE_BUDGET_MS = 50
/** 重复调用的平均耗时上限 */
const AVERAGE_BUDGET_MS = 5
/** 索引体积上限（自证没有把 15MB 语料塞进首屏） */
const INDEX_BUDGET_BYTES = 100 * 1024
/** 全部语料体积上限 */
const CORPUS_BUDGET_BYTES = 1024 * 1024

class CountingSource implements SpecSource {
  readonly specCalls: string[] = []
  indexCalls = 0

  constructor(
    private readonly entries: readonly CommandIndexEntry[],
    private readonly specs: Readonly<Record<string, CommandSpec>>,
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

/** 生成 N 条合成语料（用来模拟「大语料」而不真的打包大语料） */
function syntheticCorpus(size: number, specCacheSize = 256): {
  source: CountingSource
  corpus: CompletionCorpus
  engine: CompletionEngine
} {
  const entries: CommandIndexEntry[] = []
  const specs: Record<string, CommandSpec> = {}
  for (let i = 0; i < size; i++) {
    const name = `cmd${String(i).padStart(5, '0')}`
    entries.push({ name, brief: `${name} 的简述`, category: 'files' })
    specs[name] = {
      name,
      options: [
        { name: '-a', description: '全部' },
        { name: '-l', description: '长格式' },
        { name: '--verbose', description: '详细输出' },
      ],
    }
  }
  const source = new CountingSource(entries, specs)
  const corpus = new CompletionCorpus(source, { specCacheSize })
  return { source, corpus, engine: new CompletionEngine({ corpus }) }
}

function realEngine(settings: Partial<CompletionSettings> = {}): {
  engine: CompletionEngine
  corpus: CompletionCorpus
} {
  const corpus = new CompletionCorpus(bundledSpecSource())
  return { engine: new CompletionEngine({ corpus, settings }), corpus }
}

describe('性能：首屏只加载索引', () => {
  it('5000 条语料加载索引期间一次 spec 都不读', async () => {
    const { source, corpus } = syntheticCorpus(5000)

    const started = performance.now()
    const index = await corpus.index()
    const elapsed = performance.now() - started

    expect(index).toHaveLength(5000)
    expect(source.specCalls).toEqual([])
    expect(source.indexCalls).toBe(1)
    expect(corpus.stats().specLoads).toBe(0)
    console.log(`[perf] 5000 条索引加载耗时 ${elapsed.toFixed(2)}ms`)
    expect(elapsed).toBeLessThan(200)
  })

  it('内置语料首屏只构建索引（不解析任何选项明细）', async () => {
    const { corpus } = realEngine()
    await corpus.index()
    expect(corpus.stats().specLoads).toBe(0)
    expect(corpus.indexLoaded).toBe(true)
  })
})

describe('性能：单次补全耗时', () => {
  it('5000 条语料下，一次命令名补全 < 50ms', async () => {
    const { engine } = syntheticCorpus(5000)
    await engine.complete({ line: 'cm' }) // 预热（含索引加载）

    const started = performance.now()
    const result = await engine.complete({ line: 'cmd001' })
    const elapsed = performance.now() - started

    console.log(`[perf] 5000 条语料单次补全 ${elapsed.toFixed(3)}ms（${result.candidates.length} 个候选）`)
    expect(result.candidates.length).toBeGreaterThan(0)
    expect(elapsed).toBeLessThan(COMPLETE_BUDGET_MS)
  })

  it('5000 条语料下，无匹配的前缀也快速返回', async () => {
    const { engine } = syntheticCorpus(5000)
    await engine.complete({ line: 'cm' })

    const started = performance.now()
    const result = await engine.complete({ line: 'zzzzzz' })
    const elapsed = performance.now() - started

    console.log(`[perf] 无匹配前缀补全 ${elapsed.toFixed(3)}ms`)
    expect(result.candidates).toEqual([])
    expect(elapsed).toBeLessThan(COMPLETE_BUDGET_MS)
  })

  it('内置语料冷启动首个补全 < 50ms（含索引构建）', async () => {
    const { engine } = realEngine()
    const started = performance.now()
    const result = await engine.complete({ line: 'do' })
    const elapsed = performance.now() - started

    console.log(`[perf] 内置语料冷启动首补 ${elapsed.toFixed(3)}ms`)
    expect(result.candidates.length).toBeGreaterThan(0)
    expect(elapsed).toBeLessThan(COMPLETE_BUDGET_MS)
  })

  it('重复补全平均耗时 < 5ms（200 次）', async () => {
    const { engine } = syntheticCorpus(5000)
    await engine.complete({ line: 'cmd1' })

    const iterations = 200
    const started = performance.now()
    for (let i = 0; i < iterations; i++) {
      await engine.complete({ line: `cmd${String(i).padStart(3, '0')}` })
    }
    const average = (performance.now() - started) / iterations

    console.log(`[perf] 5000 条语料平均单次补全 ${average.toFixed(3)}ms（${iterations} 次）`)
    expect(average).toBeLessThan(AVERAGE_BUDGET_MS)
  })

  it('语料规模放大 10 倍，单次补全耗时仍在预算内', async () => {
    const small = syntheticCorpus(500)
    const large = syntheticCorpus(5000)
    await small.engine.complete({ line: 'cm' })
    await large.engine.complete({ line: 'cm' })

    const measure = async (engine: CompletionEngine): Promise<number> => {
      const started = performance.now()
      for (let i = 0; i < 50; i++) await engine.complete({ line: 'cmd002' })
      return (performance.now() - started) / 50
    }

    const smallAvg = await measure(small.engine)
    const largeAvg = await measure(large.engine)
    console.log(
      `[perf] 500 条平均 ${smallAvg.toFixed(3)}ms vs 5000 条平均 ${largeAvg.toFixed(3)}ms`,
    )
    expect(smallAvg).toBeLessThan(AVERAGE_BUDGET_MS)
    expect(largeAvg).toBeLessThan(AVERAGE_BUDGET_MS)
    // 前缀树路径不应出现「规模 ×10 → 耗时 ×10」的线性退化
    expect(largeAvg).toBeLessThan(Math.max(1, smallAvg * 10))
  })
})

describe('性能：按需加载与 LRU', () => {
  it('未命中的命令一次 spec 都不读（5000 条语料）', async () => {
    const { engine, source } = syntheticCorpus(5000)
    await engine.complete({ line: 'nosuchcommand -' })
    expect(source.specCalls).toEqual([])
    await engine.complete({ line: 'ls -l' }) // 不在合成语料里
    expect(source.specCalls).toEqual([])
  })

  it('命中同一命令多次只加载一次（内置语料）', async () => {
    const corpus = new CompletionCorpus(bundledSpecSource())
    const engine = new CompletionEngine({ corpus })

    await engine.complete({ line: 'git ' })
    await engine.complete({ line: 'git c' })
    await engine.complete({ line: 'git commit -' })

    const stats = corpus.stats()
    console.log(
      `[perf] git 三次补全：specLoads=${stats.specLoads} cacheHits=${stats.specCacheHits}`,
    )
    expect(stats.specLoads).toBe(1) // 只加载过一次 git 的 spec
    expect(stats.specCacheHits).toBeGreaterThanOrEqual(2)
  })

  it('大语料下 LRU 淘汰后重新加载（缓存上限可配）', async () => {
    const { engine, corpus, source } = syntheticCorpus(5000, 8)
    const names = Array.from({ length: 20 }, (_, i) => `cmd${String(i).padStart(5, '0')}`)
    for (const name of names) await engine.complete({ line: `${name} -` })

    // 20 个不同命令 + 上限 8 → 必须发生淘汰
    expect(corpus.stats().evictions).toBeGreaterThan(0)
    expect(source.specCalls.length).toBe(20)
  })
})

describe('性能：语料体积（自证没有 15MB 语料）', () => {
  it('索引体积 < 100KB，全部语料 < 1MB，且索引远小于明细', async () => {
    const indexBytes = Buffer.byteLength(JSON.stringify(CATALOG), 'utf8')

    let detailsBytes = 0
    let optionCount = 0
    let subcommandCount = 0
    for (const category of COMMAND_CATEGORIES) {
      const details = await CATEGORY_LOADERS[category]()
      detailsBytes += Buffer.byteLength(JSON.stringify(details), 'utf8')
      for (const rows of Object.values(details)) {
        optionCount += rows.opts?.length ?? 0
        subcommandCount += rows.subs?.length ?? 0
      }
    }

    console.log(
      `[perf] 语料规模：${CATALOG_SIZE} 条命令 / ${optionCount} 个选项 / ${subcommandCount} 个子命令；` +
        `索引 ${(indexBytes / 1024).toFixed(1)}KB；明细 ${(detailsBytes / 1024).toFixed(1)}KB；` +
        `合计 ${((indexBytes + detailsBytes) / 1024).toFixed(1)}KB`,
    )

    expect(indexBytes).toBeLessThan(INDEX_BUDGET_BYTES)
    expect(indexBytes + detailsBytes).toBeLessThan(CORPUS_BUDGET_BYTES)
    expect(indexBytes).toBeLessThan(detailsBytes)
  })
})
