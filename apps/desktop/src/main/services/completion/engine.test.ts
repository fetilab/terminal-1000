// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 引擎单测：匹配与排序、三路候选源、AI 通道、说明文本、去重。
 * 一部分用合成语料（精确控制排序），一部分用内置自建语料（贴近真实使用）。
 */

import { describe, expect, it } from 'vitest'
import type { CompletionSettings } from '@t1000/shared'
import { bundledSpecSource, CompletionCorpus, type SpecSource } from './corpus'
import {
  CompletionEngine,
  buildPopularity,
  createDirectoryGenerator,
  dedupeCandidates,
  isSubsequence,
  matchCandidate,
  sortCandidates,
  type CompletionCandidate,
  type HistoryEntry,
} from './engine'
import type { CommandIndexEntry, CommandSpec } from './specs/types'

// ── 工具 ──────────────────────────────────────────────────────────────────

function entry(name: string, brief = `${name} 简述`): CommandIndexEntry {
  return { name, brief, category: 'files' }
}

function synthetic(
  entries: CommandIndexEntry[],
  specs: Record<string, CommandSpec> = {},
  settings: Partial<CompletionSettings> = {},
): CompletionEngine {
  const source: SpecSource = {
    loadIndex: () => Promise.resolve(entries),
    loadSpec: (name) => Promise.resolve(specs[name] ?? null),
  }
  return new CompletionEngine({ corpus: new CompletionCorpus(source), settings })
}

function real(settings: Partial<CompletionSettings> = {}): CompletionEngine {
  return new CompletionEngine({ corpus: new CompletionCorpus(bundledSpecSource()), settings })
}

const values = (candidates: readonly CompletionCandidate[]): string[] =>
  candidates.map((c) => c.value)

// ── 匹配与排序（纯函数） ──────────────────────────────────────────────────

describe('matchCandidate', () => {
  it('分档：精确 1000 > 前缀 ~800 > 模糊 ~300', () => {
    expect(matchCandidate('git', 'git')).toEqual({ matchKind: 'exact', score: 1000 })

    const prefix = matchCandidate('git', 'gi')
    expect(prefix?.matchKind).toBe('prefix')
    expect(prefix?.score).toBeGreaterThan(300)
    expect(prefix?.score).toBeLessThan(1000)

    const fuzzy = matchCandidate('pgrep', 'gr')
    expect(fuzzy?.matchKind).toBe('fuzzy')
    expect(fuzzy?.score).toBeLessThan(300)
  })

  it('大小写不敏感', () => {
    expect(matchCandidate('Git', 'git')?.matchKind).toBe('exact')
    expect(matchCandidate('grep', 'GR')?.matchKind).toBe('prefix')
  })

  it('不匹配返回 null', () => {
    expect(matchCandidate('git', 'xyz')).toBeNull()
  })

  it('单字符不做模糊回退（避免噪音）', () => {
    expect(matchCandidate('pgrep', 'g')).toBeNull()
  })

  it('空前缀匹配一切', () => {
    expect(matchCandidate('anything', '')?.matchKind).toBe('prefix')
  })
})

describe('isSubsequence', () => {
  it('按顺序出现即匹配', () => {
    expect(isSubsequence('gr', 'grep')).toBe(true)
    expect(isSubsequence('gp', 'grep')).toBe(true)
    expect(isSubsequence('pg', 'grep')).toBe(false) // 顺序不对
    expect(isSubsequence('', 'x')).toBe(true)
  })
})

describe('sortCandidates / dedupeCandidates', () => {
  const candidate = (value: string, score: number): CompletionCandidate => ({
    value,
    kind: 'command',
    score,
    matchKind: 'prefix',
  })

  it('分数降序', () => {
    const sorted = sortCandidates([candidate('a', 10), candidate('b', 30), candidate('c', 20)])
    expect(values(sorted)).toEqual(['b', 'c', 'a'])
  })

  it('同分短值优先，再按字典序', () => {
    const sorted = sortCandidates([candidate('abb', 10), candidate('ab', 10), candidate('aa', 10)])
    // 同分 → 短者优先（ab/aa），同长再按字典序（aa < ab）
    expect(values(sorted)).toEqual(['aa', 'ab', 'abb'])
  })

  it('去重保留分数更高者', () => {
    const deduped = dedupeCandidates([candidate('ls', 300), candidate('ls', 900)])
    expect(deduped).toHaveLength(1)
    expect(deduped[0]?.score).toBe(900)
  })

  it('去重丢弃空值', () => {
    expect(dedupeCandidates([candidate('', 100)])).toEqual([])
  })
})

describe('buildPopularity', () => {
  it('统计首 token 的频次并跳过环境变量赋值', () => {
    const pops = buildPopularity([
      'git status',
      { line: 'git commit', count: 5 },
      'FOO=1 ls',
      '   ',
    ])
    expect(pops.get('git')).toBe(6)
    expect(pops.get('ls')).toBe(1)
    expect(pops.has('FOO=1')).toBe(false)
  })
})

// ── 命令名补全（真实语料） ────────────────────────────────────────────────

describe('命令名补全（内置语料）', () => {
  it('精确命令排第一，且都带说明', async () => {
    const result = await real().complete({ line: 'ls' })
    expect(result.candidates[0]?.value).toBe('ls')
    expect(result.candidates[0]?.matchKind).toBe('exact')
    expect(result.candidates[0]?.description).toBeTruthy()
    // 非模糊（前缀/精确）命中都真的以 ls 开头
    expect(result.candidates.filter((c) => c.matchKind !== 'fuzzy').every((c) => c.value.startsWith('ls'))).toBe(true)
    expect(result.candidates.every((c) => c.kind === 'command')).toBe(true)
    expect(result.specName).toBeNull()
    // 模糊候选只能排在前缀候选之后
    const firstFuzzy = result.candidates.findIndex((c) => c.matchKind === 'fuzzy')
    const lastPrefix = result.candidates.findLastIndex((c) => c.matchKind === 'prefix')
    if (firstFuzzy >= 0) expect(firstFuzzy).toBeGreaterThan(lastPrefix)
  })

  it('空前缀给命令名候选，且受 maxSuggestions 限制', async () => {
    const result = await real().complete({ line: '' })
    expect(result.candidates.length).toBeGreaterThan(0)
    expect(result.candidates.length).toBeLessThanOrEqual(20)
  })

  it('limit 覆盖设置里的上限', async () => {
    const result = await real().complete({ line: '', limit: 3 })
    expect(result.candidates).toHaveLength(3)
  })

  it('模糊前缀也能命中（grp → grep / pgrep）', async () => {
    const result = await real().complete({ line: 'grp' })
    const names = values(result.candidates)
    expect(names).toContain('grep')
    expect(names).toContain('pgrep')
    expect(result.candidates.every((c) => c.matchKind === 'fuzzy')).toBe(true)
  })

  it('管道之后重新使用命令名补全', async () => {
    const result = await real().complete({ line: 'ls | gr' })
    expect(result.context.atCommandPosition).toBe(true)
    expect(values(result.candidates)).toContain('grep')
  })

  it('大小写不敏感', async () => {
    const result = await real().complete({ line: 'GRE' })
    expect(values(result.candidates)).toContain('grep')
  })

  it('结果自带防抖建议值', async () => {
    const result = await real({ debounceMs: 77 }).complete({ line: 'l' })
    expect(result.debounceMs).toBe(77)
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0)
  })
})

// ── 排序（合成语料） ──────────────────────────────────────────────────────

describe('排序：前缀优先于模糊', () => {
  it('前缀 > 模糊', async () => {
    const engine = synthetic([entry('grep'), entry('egrep'), entry('pgrep')])
    const result = await engine.complete({ line: 'gr', limit: 10 })

    expect(values(result.candidates)).toEqual(['grep', 'egrep', 'pgrep'])
    // 只有 grep 是真前缀；egrep / pgrep 是模糊命中（分数档位更低）
    expect(result.candidates.map((c) => c.matchKind)).toEqual(['prefix', 'fuzzy', 'fuzzy'])
  })

  it('精确 > 前缀', async () => {
    const engine = synthetic([entry('gitea'), entry('git')])
    const result = await engine.complete({ line: 'git', limit: 10 })
    expect(values(result.candidates)).toEqual(['git', 'gitea'])
  })

  it('同分时短值优先', async () => {
    const engine = synthetic([entry('abcd'), entry('abc')])
    const result = await engine.complete({ line: 'ab', limit: 10 })
    expect(values(result.candidates)).toEqual(['abc', 'abcd'])
  })

  it('历史高频命令在命令名补全里更靠前', async () => {
    const engine = synthetic([entry('git'), entry('gitea')])
    const history: HistoryEntry[] = [{ line: 'gitea status', count: 50 }]

    const without = await engine.complete({ line: 'gi', limit: 10 })
    expect(values(without.candidates)).toEqual(['git', 'gitea'])

    const withHistory = await engine.complete({ line: 'gi', limit: 10, history })
    // 只比较命令名候选（history 候选是整行，另算）
    const commandNames = withHistory.candidates
      .filter((c) => c.kind === 'command')
      .map((c) => c.value)
    expect(commandNames).toEqual(['gitea', 'git'])
  })
})

// ── 子命令与选项（真实语料） ──────────────────────────────────────────────

describe('子命令与选项', () => {
  it('命令后给出子命令，并命中该命令的 spec', async () => {
    const result = await real().complete({ line: 'git ' })
    expect(result.specName).toBe('git')
    expect(result.candidates[0]?.kind).toBe('subcommand')
    expect(values(result.candidates)).toContain('commit')
    expect(result.candidates[0]?.description).toBeTruthy()
  })

  it('子命令前缀匹配', async () => {
    const result = await real().complete({ line: 'git ch' })
    expect(values(result.candidates)).toContain('checkout')
    expect(values(result.candidates)).toContain('cherry-pick')
    expect(result.candidates.every((c) => c.kind === 'subcommand')).toBe(true)
  })

  it('选项位置给出选项，说明里带参数占位', async () => {
    const result = await real().complete({ line: 'git commit -m' })
    const target = result.candidates.find((c) => c.value === '-m')
    expect(target).toBeDefined()
    expect(target?.kind).toBe('option')
    expect(target?.description).toContain('<MSG>')
  })

  it('已经输入过的选项不再出现在候选里', async () => {
    const result = await real().complete({ line: 'git commit -m x -' })
    const names = values(result.candidates)
    expect(names).not.toContain('-m')
    expect(names).toContain('--amend')
  })

  it('子命令之后不再提示子命令（改为选项）', async () => {
    const result = await real().complete({ line: 'git commit ' })
    expect(result.candidates.some((c) => c.kind === 'subcommand')).toBe(false)
    expect(result.candidates.some((c) => c.kind === 'option')).toBe(true)
  })

  it('ls 的选项来自 files 分类（惰性加载）', async () => {
    const result = await real().complete({ line: 'ls -a' })
    expect(result.specName).toBe('ls')
    expect(values(result.candidates)).toContain('-a')
  })

  it('不在索引里的命令不产生候选，也不读 spec', async () => {
    const engine = synthetic([entry('ls')], { ls: { name: 'ls', options: [] } })
    const result = await engine.complete({ line: 'nosuchcmd -' })
    expect(result.specName).toBeNull()
    expect(result.candidates).toEqual([])
  })
})

// ── 历史补全 ──────────────────────────────────────────────────────────────

describe('历史补全', () => {
  const history = [
    { line: 'git status', count: 9 },
    { line: 'git stash', count: 2 },
    { line: 'git push origin main', count: 1 },
  ]

  it('按频次降序', async () => {
    const result = await real().complete({ line: 'git s', history })
    const historyValues = result.candidates.filter((c) => c.kind === 'history').map((c) => c.value)
    expect(historyValues).toEqual(['git status', 'git stash'])
  })

  it('候选带使用次数说明', async () => {
    const result = await real().complete({ line: 'git s', history })
    const item = result.candidates.find((c) => c.value === 'git status')
    expect(item?.description).toContain('9')
  })

  it('空行不提示历史（避免一打开就被淹没）', async () => {
    const result = await real().complete({ line: '', history })
    expect(result.candidates.some((c) => c.kind === 'history')).toBe(false)
  })

  it('已经输完的整行不再提示', async () => {
    const result = await real().complete({ line: 'git status', history })
    expect(result.candidates.some((c) => c.kind === 'history' && c.value === 'git status')).toBe(false)
  })

  it('纯字符串历史也支持（频次默认 1）', async () => {
    const result = await real().complete({ line: 'docker r', history: ['docker run -it', 'docker ps'] })
    expect(values(result.candidates)).toContain('docker run -it')
  })

  it('historyCompletion 关闭时不产出历史候选', async () => {
    const result = await real({ historyCompletion: false }).complete({ line: 'git s', history })
    expect(result.candidates.some((c) => c.kind === 'history')).toBe(false)
  })

  it('前缀匹配大小写不敏感', async () => {
    const result = await real().complete({ line: 'GIT S', history })
    expect(result.candidates.some((c) => c.kind === 'history')).toBe(true)
  })
})

// ── 去重 ──────────────────────────────────────────────────────────────────

describe('候选去重', () => {
  it('历史与命令名同名时只保留一个（分数高者胜）', async () => {
    const result = await real().complete({ line: 'ls', history: [{ line: 'ls', count: 3 }] })
    const ls = result.candidates.filter((c) => c.value === 'ls')
    expect(ls).toHaveLength(1)
  })
})

// ── AI 通道 ───────────────────────────────────────────────────────────────

describe('AI 建议通道（?? 前缀）', () => {
  it('?? 触发 AI 通道，并标注尚未接入', async () => {
    const result = await real().complete({ line: '?? 怎么列出大文件' })
    expect(result.aiRequested).toBe(true)
    expect(result.candidates).toEqual([])
    expect(result.notes?.join()).toContain('AI 建议通道尚未接入')
  })

  it('aiSuggestion 关闭时不走 AI', async () => {
    const result = await real({ aiSuggestion: false }).complete({ line: '?? hi' })
    expect(result.aiRequested).toBe(false)
    expect(result.notes?.join()).toContain('AI 建议已关闭')
  })

  it('普通命令不触发 AI', async () => {
    const result = await real().complete({ line: 'ls -' })
    expect(result.aiRequested).toBe(false)
  })

  it('提供 aiProvider 时会采用其候选', async () => {
    const engine = new CompletionEngine({
      corpus: new CompletionCorpus(bundledSpecSource()),
      aiProvider: {
        suggest: () =>
          Promise.resolve([
            { value: 'find . -size +100M', description: 'AI 建议', kind: 'ai' as const, score: 900, matchKind: 'prefix' as const },
          ]),
      },
    })
    const result = await engine.complete({ line: '?? 大文件' })
    expect(result.aiRequested).toBe(true)
    expect(values(result.candidates)).toEqual(['find . -size +100M'])
  })
})

// ── 生成器（Beta） ────────────────────────────────────────────────────────

describe('目录生成器（cd）', () => {
  const dirs: Record<string, string[]> = { '/': ['tmp', 'home', 'etc', 'var'], '/home': ['alice'] }
  const isDir = (path: string): boolean =>
    ['/tmp', '/home', '/etc', '/var', '/home/alice'].includes(path)

  const generator = createDirectoryGenerator({
    listDir: (path) => dirs[path] ?? null,
    isDir,
  })

  it('generatorCompletion 关闭时不出目录候选（默认关闭）', async () => {
    const engine = new CompletionEngine({
      corpus: new CompletionCorpus(bundledSpecSource()),
      generators: [generator],
    })
    const result = await engine.complete({ line: 'cd /tm', cwd: '/' })
    expect(result.candidates.some((c) => c.kind === 'directory')).toBe(false)
  })

  it('打开后给出目录候选并补上尾部斜杠', async () => {
    const engine = new CompletionEngine({
      corpus: new CompletionCorpus(bundledSpecSource()),
      generators: [generator],
      settings: { generatorCompletion: true },
    })
    const result = await engine.complete({ line: 'cd /tm', cwd: '/' })
    const dir = result.candidates.find((c) => c.kind === 'directory')
    expect(dir?.value).toBe('/tmp/')
  })

  it('相对路径基于 cwd', async () => {
    const engine = new CompletionEngine({
      corpus: new CompletionCorpus(bundledSpecSource()),
      generators: [generator],
      settings: { generatorCompletion: true },
    })
    const result = await engine.complete({ line: 'cd ho', cwd: '/' })
    expect(values(result.candidates)).toContain('home/')
  })

  it('只对 cd 生效', async () => {
    const engine = new CompletionEngine({
      corpus: new CompletionCorpus(bundledSpecSource()),
      generators: [generator],
      settings: { generatorCompletion: true },
    })
    const result = await engine.complete({ line: 'ls /tm', cwd: '/' })
    expect(result.candidates.some((c) => c.kind === 'directory')).toBe(false)
  })
})

// ── 设置 ──────────────────────────────────────────────────────────────────

describe('设置开关', () => {
  it('总开关关闭时直接返回空', async () => {
    const result = await real({ enabled: false }).complete({ line: 'ls' })
    expect(result.candidates).toEqual([])
    expect(result.notes?.join()).toContain('总开关已关闭')
  })

  it('specCompletion 关闭时不产出命令名/选项候选', async () => {
    const result = await real({ specCompletion: false }).complete({ line: 'ls' })
    expect(result.candidates.some((c) => c.kind === 'command' || c.kind === 'option')).toBe(false)
  })

  it('getSettings / setSettings 局部更新', () => {
    const engine = real()
    expect(engine.getSettings().debounceMs).toBe(120)
    engine.setSettings({ debounceMs: 200 })
    expect(engine.getSettings().debounceMs).toBe(200)
    // 未传的字段保持不变
    expect(engine.getSettings().specCompletion).toBe(true)
  })
})
