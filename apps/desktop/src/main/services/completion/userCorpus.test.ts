// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 用户补全语料文件（completion.corpusFile）单测。
 *
 * 三条核心场景（任务验收要求）：
 * 1. 合并 —— 用户新命令追加，内置语料原样保留；
 * 2. 覆盖 —— 用户同名命令覆盖内置明细，未显式提供的索引字段沿用内置；
 * 3. 非法降级 —— 文件缺失/内容非法时退回仅内置语料，问题如实上报。
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CompletionCorpus, type SpecSource } from './corpus'
import {
  loadUserCorpus,
  mergeIndexEntries,
  parseUserCorpus,
  type UserCorpusIo,
} from './userCorpus'
import { CATALOG_BY_NAME } from './specs/catalog'

// ── 测试替身：极小内置语料 ─────────────────────────────────────────────────

const BUILTIN_INDEX = [
  { name: 'ls', brief: '列出目录内容', category: 'files' as const },
  { name: 'git', brief: '版本控制', category: 'vcs' as const, hasSubcommands: true },
]

const BUILTIN_SPECS: Record<string, { options: { name: string; description: string }[] }> = {
  ls: { options: [{ name: '-l', description: '长格式列出' }] },
}

const builtinSource: SpecSource = {
  loadIndex: () => Promise.resolve(BUILTIN_INDEX),
  loadSpec: (name) => {
    const spec = BUILTIN_SPECS[name]
    return Promise.resolve(spec ? { name, ...spec } : null)
  },
}

// ── parseUserCorpus：解析 ──────────────────────────────────────────────────

describe('parseUserCorpus 解析', () => {
  it('合法条目全字段解析：opts 空 arg 视为无参数，索引条目同步生成', () => {
    const parsed = parseUserCorpus(
      JSON.stringify({
        t1000demo: {
          brief: '示例命令',
          category: 'system',
          opts: [['--hello', '打招呼'], ['--count', '次数', 'N'], ['-q', '', '']],
          subs: [['add', '添加记录']],
          purpose: '演示合并行为',
          usage: 't1000demo [选项]',
          install: '无需安装',
          example: 't1000demo --hello',
          examples: [['t1000demo --hello', '打个招呼']],
          shortcuts: [['Ctrl+C', '中断']],
        },
      }),
    )

    expect(parsed.problems).toEqual([])
    const spec = parsed.specs.get('t1000demo')
    expect(spec).toBeDefined()
    expect(spec?.options).toEqual([
      { name: '--hello', description: '打招呼' },
      { name: '--count', description: '次数', arg: 'N' },
      { name: '-q', description: '' },
    ])
    expect(spec?.subcommands).toEqual([{ name: 'add', description: '添加记录' }])
    expect(spec?.purpose).toBe('演示合并行为')
    expect(spec?.examples).toEqual([{ command: 't1000demo --hello', description: '打个招呼' }])
    expect(spec?.shortcuts).toEqual([{ key: 'Ctrl+C', description: '中断' }])

    const indexEntry = parsed.indexEntries.get('t1000demo')
    expect(indexEntry).toEqual({ brief: '示例命令', category: 'system', hasSubcommands: true })
  })

  it('非 JSON 内容：整文件降级，问题指向 <文件> 且如实带原因', () => {
    const parsed = parseUserCorpus('{ 这不是 JSON')
    expect(parsed.specs.size).toBe(0)
    expect(parsed.problems).toHaveLength(1)
    expect(parsed.problems[0]?.command).toBe('<文件>')
    expect(parsed.problems[0]?.detail).toContain('不是合法 JSON')
  })

  it('顶层不是对象：整文件降级', () => {
    const parsed = parseUserCorpus('[1, 2, 3]')
    expect(parsed.specs.size).toBe(0)
    expect(parsed.problems[0]?.command).toBe('<文件>')
    expect(parsed.problems[0]?.detail).toContain('顶层必须是 JSON 对象')
  })

  it('条目级非法只丢该条：合法条目照常生效，问题逐条上报', () => {
    const parsed = parseUserCorpus(
      JSON.stringify({
        goodcmd: { brief: '好条目', opts: [['-v', '详细']] },
        badcmd: { opts: '不是数组' },
        worse: { category: '不存在分类' },
      }),
    )

    expect([...parsed.specs.keys()]).toEqual(['goodcmd'])
    expect(parsed.problems.map((p) => p.command).sort()).toEqual(['badcmd', 'worse'])
    expect(parsed.problems.find((p) => p.command === 'badcmd')?.detail).toContain('opts')
    expect(parsed.problems.find((p) => p.command === 'worse')?.detail).toContain('category')
  })

  it('命令名不合法（含路径分隔符 / . / ..）被拒绝', () => {
    const parsed = parseUserCorpus(
      JSON.stringify({ 'a/b': {}, '..': {}, '.': {}, 'ok-cmd': { brief: '合法' } }),
    )
    expect([...parsed.specs.keys()]).toEqual(['ok-cmd'])
    expect(parsed.problems.map((p) => p.command).sort()).toEqual(['.', '..', 'a/b'])
  })
})

// ── mergeIndexEntries：合并 / 覆盖 ─────────────────────────────────────────

describe('mergeIndexEntries 合并与覆盖', () => {
  it('用户新命令追加在尾部，category 缺省 system，内置条目不被改动', () => {
    const merged = mergeIndexEntries(BUILTIN_INDEX, new Map([['t1000demo', { brief: '新命令' }]]))

    expect(merged.slice(0, BUILTIN_INDEX.length)).toEqual(BUILTIN_INDEX)
    expect(merged[2]).toEqual({ name: 't1000demo', brief: '新命令', category: 'system' })
    expect(BUILTIN_INDEX).toHaveLength(2) // 输入未被修改
  })

  it('同名命令：用户显式提供的字段覆盖，未提供的沿用内置', () => {
    const merged = mergeIndexEntries(
      BUILTIN_INDEX,
      new Map([['ls', { brief: '用户版 ls' }, ], ['git', { category: 'files' }]]),
    )

    const ls = merged.find((e) => e.name === 'ls')
    expect(ls).toEqual({ name: 'ls', brief: '用户版 ls', category: 'files' })

    const git = merged.find((e) => e.name === 'git')
    expect(git).toEqual({ name: 'git', brief: '版本控制', category: 'files', hasSubcommands: true })
  })
})

// ── CompletionCorpus 用户语料层：合并 / 覆盖 / 降级 ────────────────────────

describe('CompletionCorpus 用户语料层', () => {
  it('合并：index 与前缀树包含用户新命令，内置命令保留', async () => {
    const corpus = new CompletionCorpus(builtinSource)
    corpus.setUserLayer({
      specs: new Map([['t1000demo', { name: 't1000demo', options: [] }]]),
      indexEntries: new Map([['t1000demo', { brief: '新命令' }]]),
    })

    const index = await corpus.index()
    expect(index.map((e) => e.name)).toContain('t1000demo')
    expect(index.map((e) => e.name)).toEqual(expect.arrayContaining(['ls', 'git']))
    expect(corpus.commandsWithPrefix('t1000', 10).map((e) => e.name)).toContain('t1000demo')

    const spec = await corpus.spec('t1000demo')
    expect(spec?.name).toBe('t1000demo')
  })

  it('覆盖：同名命令的明细以用户文件为准（用户 opts 替换内置 opts）', async () => {
    const corpus = new CompletionCorpus(builtinSource)
    corpus.setUserLayer({
      specs: new Map([['ls', { name: 'ls', options: [{ name: '--my-flag', description: '用户选项' }] }]]),
      indexEntries: new Map([['ls', { brief: '用户版 ls' }]]),
    })

    const spec = await corpus.spec('ls')
    expect(spec?.options).toEqual([{ name: '--my-flag', description: '用户选项' }])

    const index = await corpus.index()
    expect(index.find((e) => e.name === 'ls')?.brief).toBe('用户版 ls')
    // 未提供 category → 沿用内置
    expect(index.find((e) => e.name === 'ls')?.category).toBe('files')
  })

  it('降级：setUserLayer(null) 后回到仅内置语料，缓存全部失效', async () => {
    const corpus = new CompletionCorpus(builtinSource)
    corpus.setUserLayer({
      specs: new Map([['t1000demo', { name: 't1000demo', options: [] }]]),
      indexEntries: new Map([['t1000demo', { brief: '新命令' }]]),
    })
    expect((await corpus.index()).map((e) => e.name)).toContain('t1000demo')

    corpus.setUserLayer(null)
    const index = await corpus.index()
    expect(index.map((e) => e.name)).toEqual(['ls', 'git'])
    await expect(corpus.spec('t1000demo')).resolves.toBeNull()
    expect(corpus.commandsWithPrefix('t1000', 10)).toEqual([])
  })

  it('搜索文档：用户命令的 purpose 不被内置手册覆盖，内置命令手册仍生效', async () => {
    const corpus = new CompletionCorpus(builtinSource)
    corpus.setUserLayer({
      specs: new Map([
        ['ls', { name: 'ls', options: [], purpose: '用户自己的 ls 用途' }],
        ['t1000demo', { name: 't1000demo', options: [], purpose: '用户命令用途' }],
      ]),
      indexEntries: new Map([
        ['ls', {}],
        ['t1000demo', { brief: '新命令' }],
      ]),
    })

    const docs = await corpus.docs()
    const ls = docs.find((d) => d.name === 'ls')
    expect(ls?.purpose).toBe('用户自己的 ls 用途')
    const demo = docs.find((d) => d.name === 't1000demo')
    expect(demo?.purpose).toBe('用户命令用途')
    expect(demo?.brief).toBe('新命令')
    // 内置未覆盖命令（git）的 matchText 仍由内置明细构成
    const git = docs.find((d) => d.name === 'git')
    expect(git?.matchText).toContain('git')
  })

  it('真实内置语料：内置命令名在语料层覆盖后仍走用户明细', async () => {
    // 用真实 catalog 里的命令名验证「同名覆盖」在生产形状下成立
    const builtinName = [...CATALOG_BY_NAME.keys()][0] as string
    const corpus = new CompletionCorpus(builtinSource)
    corpus.setUserLayer({
      specs: new Map([[builtinName, { name: builtinName, options: [{ name: '--user-opt', description: '用户' }] }]]),
      indexEntries: new Map([[builtinName, { brief: '用户版' }]]),
    })
    const spec = await corpus.spec(builtinName)
    expect(spec?.options).toEqual([{ name: '--user-opt', description: '用户' }])
  })
})

// ── loadUserCorpus：文件加载三态 ───────────────────────────────────────────

describe('loadUserCorpus 文件加载', () => {
  const validJson = JSON.stringify({ t1000demo: { brief: '示例', opts: [['--hello', '打招呼']] } })
  const brokenJson = '{ bad json'

  const memIo = (files: Record<string, string>): UserCorpusIo => ({
    readFile: async (path) => {
      const content = files[path]
      return content === undefined ? null : content
    },
  })

  it('文件存在且合法 → ok（含 layer 与 userCommands）', async () => {
    const result = await loadUserCorpus('/tmp/corpus.json', memIo({ '/tmp/corpus.json': validJson }))
    expect(result.state).toBe('ok')
    if (result.state !== 'ok') return
    expect(result.userCommands).toBe(1)
    expect(result.layer.specs.get('t1000demo')?.options).toEqual([{ name: '--hello', description: '打招呼' }])
  })

  it('文件不存在 → missing（调用方降级为仅内置）', async () => {
    const result = await loadUserCorpus('/tmp/absent.json', memIo({}))
    expect(result).toEqual({ state: 'missing' })
  })

  it('内容非法 → invalid（问题如实上报）', async () => {
    const result = await loadUserCorpus('/tmp/corpus.json', memIo({ '/tmp/corpus.json': brokenJson }))
    expect(result.state).toBe('invalid')
    if (result.state !== 'invalid') return
    expect(result.problems[0]?.command).toBe('<文件>')
  })

  it('读取抛错 → error（含原始原因）', async () => {
    const io: UserCorpusIo = {
      readFile: async () => {
        throw new Error('EACCES: permission denied')
      },
    }
    const result = await loadUserCorpus('/tmp/secret.json', io)
    expect(result.state).toBe('error')
    if (result.state !== 'error') return
    expect(result.detail).toContain('EACCES')
  })

  it('真实文件系统 wiring：临时文件 ok → 改坏后 invalid → 删除后 missing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 't1000-user-corpus-'))
    const file = join(dir, 'corpus.json')
    try {
      writeFileSync(file, validJson, 'utf8')
      const ok = await loadUserCorpus(file, realFsIo())
      expect(ok.state).toBe('ok')

      writeFileSync(file, brokenJson, 'utf8')
      const bad = await loadUserCorpus(file, realFsIo())
      expect(bad.state).toBe('invalid')

      rmSync(file)
      const missing = await loadUserCorpus(file, realFsIo())
      expect(missing.state).toBe('missing')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

/** 与 completion/index.ts 相同语义的真实 IO：ENOENT → null，其余抛出 */
function realFsIo(): UserCorpusIo {
  // 延迟 import 避免 ESM 顶层 await 语义差异；vitest 环境直接可用
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return {
    readFile: async (path) => {
      const { readFile } = await import('node:fs/promises')
      try {
        return await readFile(path, 'utf8')
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return null
        throw err
      }
    },
  }
}
