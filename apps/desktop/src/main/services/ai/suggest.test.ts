// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * AI 命令建议的纯逻辑测试。
 *
 * 重点在**解析**：模型不会只输出"每行一条命令"。它会加 markdown 代码块、序号、
 * 解释、重复。解析松一点就会把 ``` 或 "1. " 当命令塞进候选 ——
 * 而候选被用户一按 Tab 就**直接敲进终端**，所以宁可少给也不能给错的。
 */

import { describe, expect, it, vi } from 'vitest'
import {
  NO_PROVIDER_MESSAGE,
  buildSuggestPrompt,
  createCommandSuggester,
  missingApiKeyMessage,
  parseCommandSuggestions,
} from './suggest'

describe('buildSuggestPrompt', () => {
  it('把格式要求写死（每行一条、不要编号/代码块）', () => {
    const msgs = buildSuggestPrompt('docker run', 5)
    expect(msgs).toHaveLength(2)
    expect(msgs[0]!.role).toBe('system')
    expect(msgs[0]!.content).toContain('每行一条')
    expect(msgs[0]!.content).toContain('不要编号')
    expect(msgs[1]).toEqual({ role: 'user', content: 'docker run' })
  })

  it('条数落在合法区间（0 与超大值都要夹住）', () => {
    expect(buildSuggestPrompt('x', 0)[0]!.content).toContain('最多给出 1 条')
    expect(buildSuggestPrompt('x', 999)[0]!.content).toContain('最多给出 10 条')
  })

  it('用户输入被 trim（避免把多余空白当成命令的一部分）', () => {
    expect(buildSuggestPrompt('  ls -la  ', 3)[1]!.content).toBe('ls -la')
  })
})

describe('parseCommandSuggestions —— 模型输出的清洗', () => {
  it('干净输出原样解析', () => {
    const r = parseCommandSuggestions('docker ps\ndocker images', 5)
    expect(r.map((x) => x.command)).toEqual(['docker ps', 'docker images'])
  })

  it('★ 剥掉 markdown 代码块围栏（否则 ``` 会被当成命令）', () => {
    const r = parseCommandSuggestions('```bash\ndocker ps\n```', 5)
    expect(r.map((x) => x.command)).toEqual(['docker ps'])
  })

  it('★ 剥掉序号与项目符号', () => {
    const r = parseCommandSuggestions('1. docker ps\n2) docker images\n- docker rm x\n* docker rmi y', 5)
    expect(r.map((x) => x.command)).toEqual(['docker ps', 'docker images', 'docker rm x', 'docker rmi y'])
  })

  it('★ 剥掉反引号包裹', () => {
    expect(parseCommandSuggestions('`ls -la`', 3)[0]!.command).toBe('ls -la')
  })

  it('★ 用 " | " 分隔的说明被拆出来', () => {
    const r = parseCommandSuggestions('docker ps | 列出运行中的容器', 3)
    expect(r[0]).toEqual({ command: 'docker ps', description: '列出运行中的容器' })
  })

  it('★ 去重（不区分大小写）', () => {
    const r = parseCommandSuggestions('docker ps\nDocker PS\ndocker ps', 5)
    expect(r).toHaveLength(1)
  })

  it('★ 丢掉明显不是命令的行（避免把说明文字敲进终端）', () => {
    const r = parseCommandSuggestions(
      ['以下是几个建议：', '注意：需要 root 权限', 'docker ps', '这条命令会列出所有容器。'].join('\n'),
      5,
    )
    expect(r.map((x) => x.command)).toEqual(['docker ps'])
  })

  it('★ 超长行被丢掉（防止把一整段解释当成命令）', () => {
    const long = `echo ${'x'.repeat(600)}`
    expect(parseCommandSuggestions(long, 5)).toHaveLength(0)
  })

  it('尊重上限', () => {
    const text = Array.from({ length: 20 }, (_, i) => `cmd-${i}`).join('\n')
    expect(parseCommandSuggestions(text, 3)).toHaveLength(3)
  })

  it('空输入 / 只有空行 → 空数组（不抛错）', () => {
    expect(parseCommandSuggestions('', 5)).toEqual([])
    expect(parseCommandSuggestions('\n\n   \n', 5)).toEqual([])
  })

  it('CRLF 换行同样处理（模型有时给 \\r\\n）', () => {
    expect(parseCommandSuggestions('docker ps\r\ndocker images', 5)).toHaveLength(2)
  })

  it('命令里含单竖线不被误当说明（只认 " | " 两侧带空格的）', () => {
    const r = parseCommandSuggestions('grep -E "a|b" file.txt', 3)
    expect(r[0]!.command).toBe('grep -E "a|b" file.txt')
    expect(r[0]!.description).toBeUndefined()
  })
})

describe('createCommandSuggester —— 三条错误路径都要可操作', () => {
  const okDeps = (text: string) => ({
    resolveProvider: () => ({ name: 'NIM', hasApiKey: true }),
    ask: vi.fn(async () => text),
  })

  it('正常路径：问到模型并解析', async () => {
    const deps = okDeps('docker ps | 列出容器\n```\ndocker images\n```')
    const suggest = createCommandSuggester(deps)
    const r = await suggest({ query: 'docker' }, 5)
    expect(r.map((x) => x.command)).toEqual(['docker ps', 'docker images'])
    expect(deps.ask).toHaveBeenCalledTimes(1)
  })

  it('★ 未配置供应商 → 给"去哪配"的提示（不是"通道尚未接入"）', async () => {
    const suggest = createCommandSuggester({
      resolveProvider: () => undefined,
      ask: vi.fn(),
    })
    await expect(suggest({ query: 'x' }, 3)).rejects.toThrow(NO_PROVIDER_MESSAGE)
    // 文案必须指向具体入口
    expect(NO_PROVIDER_MESSAGE).toContain('设置 > AI 助手')
    expect(NO_PROVIDER_MESSAGE).toContain('API Key')
  })

  it('★ 供应商没填 Key → 点名是哪个供应商', async () => {
    const suggest = createCommandSuggester({
      resolveProvider: () => ({ name: '我的 NIM', hasApiKey: false }),
      ask: vi.fn(),
    })
    await expect(suggest({ query: 'x' }, 3)).rejects.toThrow(/我的 NIM/)
    expect(missingApiKeyMessage('我的 NIM')).toContain('设置 > AI 助手')
  })

  it('模型报错如实向上抛（补全侧会原样呈现）', async () => {
    const suggest = createCommandSuggester({
      resolveProvider: () => ({ name: 'NIM', hasApiKey: true }),
      ask: async () => {
        throw new Error('HTTP 429')
      },
    })
    await expect(suggest({ query: 'x' }, 3)).rejects.toThrow(/429/)
  })

  it('空查询不发请求（省一次调用）', async () => {
    const deps = okDeps('whatever')
    const suggest = createCommandSuggester(deps)
    expect(await suggest({ query: '   ' }, 3)).toEqual([])
    expect(deps.ask).not.toHaveBeenCalled()
  })

  it('模型返回空 → 空数组（由界面决定怎么提示"换个说法"）', async () => {
    const suggest = createCommandSuggester(okDeps(''))
    expect(await suggest({ query: 'x' }, 3)).toEqual([])
  })
})
