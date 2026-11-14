// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * OSC 133 命令块测试。
 *
 * 与 `session-cwd.test.ts` 同一套重点：**OSC 序列会被 TCP 读切开**。
 * 这里额外覆盖：退出码是否准确、块列表上限与淘汰、多会话隔离、
 * "shell 不发 OSC 133"时必须给出可操作原因。
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { Actions } from '@t1000/shared'
import type { IpcContext, IpcHandler } from '../../ipc/router'
import { shellIntegrationHandlers } from './handlers'
import {
  DEFAULT_BLOCK_LIMIT,
  MAX_COMMAND_BLOCKS,
  cleanCommandLine,
  clearAllCommandBlocks,
  clearAllCwd,
  feedSessionData,
  forgetSession,
  getCwd,
  getOpenCommandBlock,
  listCommandBlocks,
  parseOsc133,
  setShellIntegrationEmitter,
  type ShellCommandEndEvent,
  type ShellCommandStartEvent,
} from './index'

const ESC = '\x1b'
/** OSC 133 序列（BEL 结尾） */
const osc = (payload: string): string => `${ESC}]${payload}\x07`
/** ST（ESC \）结尾变体 */
const oscSt = (payload: string): string => `${ESC}]${payload}${ESC}\\`

beforeEach(() => {
  clearAllCwd()
  clearAllCommandBlocks()
  setShellIntegrationEmitter(null)
})

// ---------------------------------------------------------------------------
// 载荷解析
// ---------------------------------------------------------------------------

describe('parseOsc133：载荷解析', () => {
  it('四种类型 + P（提示符属性）', () => {
    expect(parseOsc133('133;A')).toEqual({ kind: 'A' })
    expect(parseOsc133('133;B')).toEqual({ kind: 'B' })
    expect(parseOsc133('133;C')).toEqual({ kind: 'C' })
    expect(parseOsc133('133;P;k=v')).toEqual({ kind: 'P' })
  })

  it('★ 退出码：D;0 / D;1 / D 无参数', () => {
    expect(parseOsc133('133;D;0')).toEqual({ kind: 'D', exitCode: 0 })
    expect(parseOsc133('133;D;1')).toEqual({ kind: 'D', exitCode: 1 })
    expect(parseOsc133('133;D;127')).toEqual({ kind: 'D', exitCode: 127 })
    // 没给退出码 → null（**不能编一个 0 出来**）
    expect(parseOsc133('133;D')).toEqual({ kind: 'D', exitCode: null })
    expect(parseOsc133('133;D;')).toEqual({ kind: 'D', exitCode: null })
    expect(parseOsc133('133;D;abc')).toEqual({ kind: 'D', exitCode: null })
  })

  it('带额外参数（cl=… 等）也能解析', () => {
    expect(parseOsc133('133;A;cl=m')).toEqual({ kind: 'A' })
    expect(parseOsc133('133;D;2;foo=bar')).toEqual({ kind: 'D', exitCode: 2 })
  })

  it('不是 OSC 133 的载荷返回 null（不能瞎认）', () => {
    expect(parseOsc133('7;file://h/tmp')).toBeNull()
    expect(parseOsc133('0;title')).toBeNull()
    expect(parseOsc133('133')).toBeNull()
    expect(parseOsc133('133;Z')).toBeNull() // 未知类型
    expect(parseOsc133('nonsense')).toBeNull()
  })
})

describe('cleanCommandLine：把回显还原成命令文本', () => {
  it('去掉颜色/光标序列', () => {
    expect(cleanCommandLine('\x1b[31mdocker ps\x1b[0m')).toBe('docker ps')
  })

  it('★ 连续退格按终端语义逐个回退', () => {
    // `ls` + 4 个 DEL → 退回到空（空缓冲上再退无效），随后输入 e/cho hi → `echo hi`
    expect(cleanCommandLine(`ls\x7f\x7f\x7f\x7fe\x1b]0;title\x07cho hi`)).toBe('echo hi')
    expect(cleanCommandLine('abc\x7f\x7fd')).toBe('ad')
  })

  it('多行只取最后一行（回显里常带上一屏残留）', () => {
    // B→C 窗口从"用户开始输入"起算，所以正常不含提示符；
    // 这里也验证"不做提示符猜测剥离"（不猜更安全）
    expect(cleanCommandLine('上一屏残留\r\ntar -xzf a.tgz')).toBe('tar -xzf a.tgz')
    expect(cleanCommandLine('$ tar -xzf a.tgz')).toBe('$ tar -xzf a.tgz')
  })

  it('全空白/无内容时返回空串', () => {
    expect(cleanCommandLine('\x1b[?2004h')).toBe('')
    expect(cleanCommandLine('   \n  ')).toBe('')
  })
})

// ---------------------------------------------------------------------------
// 端到端：命令块
// ---------------------------------------------------------------------------

describe('命令块：完整序列', () => {
  it('A→B(回显)→C→D;1 得到一个带退出码的块', () => {
    feedSessionData('s1', osc('133;A') + 'prompt$ ')
    feedSessionData('s1', osc('133;B') + 'tar -xzf a.tgz\r\n')
    feedSessionData('s1', osc('133;C') + '解压中...\n')
    feedSessionData('s1', osc('133;D;1'))

    const result = listCommandBlocks('s1')
    expect(result.blocks).toHaveLength(1)
    const block = result.blocks[0]
    expect(block?.exitCode).toBe(1)
    expect(block?.commandLine).toBe('tar -xzf a.tgz')
    expect(block?.outputStart).toBeTypeOf('number')
    expect(block?.endedAt).toBeTypeOf('number')
    expect(result.total).toBe(1)
    expect(result.shellIntegration).toBe(true)
    expect(result.reason).toBeUndefined()
  })

  it('★ 退出码准确：0 与 1 不能互相混淆', () => {
    feedSessionData('s1', osc('133;C') + osc('133;D;0'))
    feedSessionData('s1', osc('133;B') + 'boom\r\n' + osc('133;C') + osc('133;D;1'))
    feedSessionData('s1', osc('133;B') + 'nope\r\n' + osc('133;C') + osc('133;D;130'))

    expect(listCommandBlocks('s1').blocks.map((b) => b.exitCode)).toEqual([0, 1, 130])
  })

  it('D 不带退出码 → null（"结束了但 shell 没给"）', () => {
    feedSessionData('s1', osc('133;C') + osc('133;D'))
    expect(listCommandBlocks('s1').blocks[0]?.exitCode).toBeNull()
  })

  it('只有 D（用户的 printf / 极简 shell）也能拿到退出码', () => {
    feedSessionData('s1', osc('133;D;3'))
    const result = listCommandBlocks('s1')
    expect(result.blocks).toHaveLength(1)
    expect(result.blocks[0]?.exitCode).toBe(3)
    expect(result.blocks[0]?.commandLine).toBeUndefined()
  })

  it('A 出现时把"没等到 D"的上一条按 null 收尾（不让它一直挂着）', () => {
    feedSessionData('s1', osc('133;B') + 'sleep 100\r\n' + osc('133;C'))
    feedSessionData('s1', osc('133;A'))
    const blocks = listCommandBlocks('s1').blocks
    expect(blocks).toHaveLength(1)
    expect(blocks[0]?.exitCode).toBeNull()
    expect(getOpenCommandBlock('s1')).toBeNull()
  })

  it('进行中的块可单独读取（UI 显示"正在跑"）', () => {
    feedSessionData('s1', osc('133;B') + 'make -j8\r\n' + osc('133;C') + '编译中')
    const open = getOpenCommandBlock('s1')
    expect(open?.commandLine).toBe('make -j8')
    expect(open?.exitCode).toBeUndefined()
    // 还没结束 → 不在已完成列表里
    expect(listCommandBlocks('s1').blocks).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// ★ 跨块（与 session-cwd.test.ts 同一套重点）
// ---------------------------------------------------------------------------

describe('★ 跨块解析（OSC 序列被 TCP 读切开）', () => {
  const full =
    osc('133;A') + 'prompt$ ' + osc('133;B') + 'ls -la\r\n' + osc('133;C') + 'total 0\n' + osc('133;D;0')

  it('整块到达', () => {
    feedSessionData('s1', full)
    const block = listCommandBlocks('s1').blocks[0]
    expect(block?.exitCode).toBe(0)
    expect(block?.commandLine).toBe('ls -la')
  })

  it('★ 在每个可能的位置切成两块，结果都必须一致', () => {
    for (let cut = 1; cut < full.length; cut += 1) {
      // 两个状态都要清：cwd 扫描器的跨块缓冲也要复位，否则上一轮的半截序列会污染这一轮
      clearAllCwd()
      clearAllCommandBlocks()
      feedSessionData('s1', full.slice(0, cut))
      feedSessionData('s1', full.slice(cut))
      const result = listCommandBlocks('s1')
      expect(result.blocks, `cut=${cut}`).toHaveLength(1)
      expect(result.blocks[0]?.exitCode, `cut=${cut}`).toBe(0)
      expect(result.blocks[0]?.commandLine, `cut=${cut}`).toBe('ls -la')
    }
  })

  it('★ 逐字符喂入也一致（引导符 ESC ] 被拆开是最经典的坑）', () => {
    for (const ch of full) feedSessionData('s1', ch)
    const result = listCommandBlocks('s1')
    expect(result.blocks).toHaveLength(1)
    expect(result.blocks[0]?.exitCode).toBe(0)
    expect(result.blocks[0]?.commandLine).toBe('ls -la')
  })

  it('★ 用 ST（ESC \\）结尾的变体同样识别', () => {
    feedSessionData('s1', oscSt('133;A') + oscSt('133;B') + 'echo hi\r\n' + oscSt('133;C') + oscSt('133;D;0'))
    const blocks = listCommandBlocks('s1').blocks
    expect(blocks).toHaveLength(1)
    expect(blocks[0]?.commandLine).toBe('echo hi')
  })

  it('★ 多会话隔离：A 会话的半截序列不与 B 会话拼接', () => {
    const a = osc('133;B') + 'cmd-a\r\n' + osc('133;C') + osc('133;D;1')
    const b = osc('133;B') + 'cmd-b\r\n' + osc('133;C') + osc('133;D;0')
    // 交错喂入，且都在中间切断
    feedSessionData('a', a.slice(0, 12))
    feedSessionData('b', b.slice(0, 9))
    feedSessionData('a', a.slice(12))
    feedSessionData('b', b.slice(9))

    expect(listCommandBlocks('a').blocks[0]).toMatchObject({ commandLine: 'cmd-a', exitCode: 1 })
    expect(listCommandBlocks('b').blocks[0]).toMatchObject({ commandLine: 'cmd-b', exitCode: 0 })
  })

  it('半截序列期间读列表：拿不到块但也不会报错（shellIntegration 尚未置位）', () => {
    feedSessionData('s1', osc('133;B').slice(0, 3)) // 只给了 `ESC]1`
    const result = listCommandBlocks('s1')
    expect(result.blocks).toEqual([])
    expect(result.shellIntegration).toBe(false)
    expect(result.reason).toContain('OSC 133')
  })
})

// ---------------------------------------------------------------------------
// 上限与淘汰
// ---------------------------------------------------------------------------

describe('块列表上限与淘汰', () => {
  it('★ 超过上限只留最近 MAX_COMMAND_BLOCKS 个，但 total 一直累计', () => {
    const over = MAX_COMMAND_BLOCKS + 20
    for (let i = 0; i < over; i += 1) {
      feedSessionData('s1', osc(`133;D;${i % 3}`))
    }
    const result = listCommandBlocks('s1', MAX_COMMAND_BLOCKS)
    expect(result.blocks).toHaveLength(MAX_COMMAND_BLOCKS)
    expect(result.total).toBe(over)
    expect(result.truncated).toBe(true) // 被上限淘汰过
    // 留下的应该是**最近**的那些（id 连续且是尾部）
    expect(result.blocks.at(-1)?.id).toBe(over)
    expect(result.blocks[0]?.id).toBe(over - MAX_COMMAND_BLOCKS + 1)
  })

  it('limit 生效并如实报告截断', () => {
    for (let i = 0; i < 10; i += 1) feedSessionData('s1', osc(`133;D;${i}`))

    const small = listCommandBlocks('s1', 3)
    expect(small.blocks).toHaveLength(3)
    expect(small.blocks.map((b) => b.exitCode)).toEqual([7, 8, 9])
    expect(small.truncated).toBe(true)

    const all = listCommandBlocks('s1', 50)
    expect(all.blocks).toHaveLength(10)
    expect(all.truncated).toBe(false)
  })

  it('默认条数 = DEFAULT_BLOCK_LIMIT', () => {
    for (let i = 0; i < DEFAULT_BLOCK_LIMIT + 5; i += 1) feedSessionData('s1', osc('133;D;0'))
    expect(listCommandBlocks('s1').blocks).toHaveLength(DEFAULT_BLOCK_LIMIT)
  })
})

// ---------------------------------------------------------------------------
// 会话清理
// ---------------------------------------------------------------------------

describe('会话断开时清理', () => {
  it('★ forgetSession 把命令块一起清掉（长会话/多会话都不留垃圾）', () => {
    feedSessionData('s1', osc('133;C') + osc('133;D;0'))
    feedSessionData('s2', osc('133;C') + osc('133;D;1'))
    expect(listCommandBlocks('s1').blocks).toHaveLength(1)

    forgetSession('s1')
    const after = listCommandBlocks('s1')
    expect(after.blocks).toEqual([])
    expect(after.total).toBe(0)
    expect(after.reason).toBeTypeOf('string')
    // 另一个会话不受影响
    expect(listCommandBlocks('s2').blocks[0]?.exitCode).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// 诚实边界：shell 不发 OSC 133
// ---------------------------------------------------------------------------

describe('★ shell 不发 OSC 133 时的表现', () => {
  it('完全没有输出的会话 → 说明"还没有输出"', () => {
    const result = listCommandBlocks('unknown-session')
    expect(result.blocks).toEqual([])
    expect(result.shellIntegration).toBe(false)
    expect(result.reason).toContain('还没有输出')
  })

  it('★ 有输出但没有 OSC 133 → 可操作原因（含 bash/zsh 配置指引）', () => {
    feedSessionData('s1', 'prompt$ ls -la\ntotal 0\nprompt$ ')
    const result = listCommandBlocks('s1')
    expect(result.blocks).toEqual([])
    expect(result.shellIntegration).toBe(false)
    expect(result.reason).toContain('OSC 133')
    expect(result.reason).toContain('PROMPT_COMMAND')
    expect(result.reason).toContain('zsh')
    // 给出可手动验证的最小序列
    expect(result.reason).toContain('133;D;0')
  })

  it('启用了但还没跑完命令 → 也能区分（不是"没配置"）', () => {
    feedSessionData('s1', osc('133;A') + 'prompt$ ')
    const result = listCommandBlocks('s1')
    expect(result.blocks).toEqual([])
    expect(result.shellIntegration).toBe(true)
    expect(result.reason).toContain('还没有跑完')
  })

  it('OSC 7（cwd）不会被误当成命令块', () => {
    feedSessionData('s1', osc('7;file://h/home/mosfet'))
    const result = listCommandBlocks('s1')
    expect(result.blocks).toEqual([])
    expect(result.shellIntegration).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 事件（退出码要给渲染层与 AI 用）
// ---------------------------------------------------------------------------

describe('命令开始/结束事件', () => {
  it('★ 结束事件带准确退出码与耗时', () => {
    const events: Array<ShellCommandStartEvent | ShellCommandEndEvent> = []
    setShellIntegrationEmitter((e) => events.push(e))

    feedSessionData('s1', osc('133;B') + 'false\r\n' + osc('133;C') + osc('133;D;1'))

    expect(events.map((e) => e.type)).toEqual(['start', 'end'])
    const end = events[1] as ShellCommandEndEvent
    expect(end.exitCode).toBe(1)
    expect(end.commandLine).toBe('false')
    expect(end.sessionId).toBe('s1')
    expect(end.endedAt).toBeGreaterThanOrEqual(end.startedAt)
    expect(end.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('★ 只有 D 时也先发一次 start（消费方可以只监听 end）', () => {
    const events: Array<ShellCommandStartEvent | ShellCommandEndEvent> = []
    setShellIntegrationEmitter((e) => events.push(e))

    feedSessionData('s1', osc('133;D;0'))
    expect(events.map((e) => e.type)).toEqual(['start', 'end'])
    expect((events[1] as ShellCommandEndEvent).exitCode).toBe(0)
  })

  it('未注入出口时不影响状态维护（读取照样有数据）', () => {
    setShellIntegrationEmitter(null)
    feedSessionData('s1', osc('133;D;0'))
    expect(listCommandBlocks('s1').blocks).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// 回归：完整序列之后紧跟的孤立 ESC（同一个扫描器，OSC 7 也受益）
// ---------------------------------------------------------------------------

describe('★ 回归：一块里"完整序列 + 提示符 + 孤立 ESC"被切开', () => {
  it('OSC 133：后面的序列仍能解析（退出码不丢）', () => {
    // 第一块以孤立 ESC 结尾，第二块以 `]133;…` 开头 —— 曾经的实现会丢掉这个 ESC
    const first = `${osc('133;A')}prompt$ ${ESC}`
    const second = `]133;B\x07echo hi\r\n${osc('133;C')}${osc('133;D;7')}`
    feedSessionData('s1', first)
    feedSessionData('s1', second)

    const blocks = listCommandBlocks('s1').blocks
    expect(blocks).toHaveLength(1)
    expect(blocks[0]?.exitCode).toBe(7)
    expect(blocks[0]?.commandLine).toBe('echo hi')
  })

  it('OSC 7（cwd）同样受益：cwd 不再因为孤立 ESC 而丢', () => {
    const first = `${osc('133;A')}prompt$ ${ESC}`
    const second = `]7;file://web-1/srv/app\x07`
    feedSessionData('s1', first)
    feedSessionData('s1', second)
    // 重点：cwd 也拿到了（同一个扫描器修一处，两个解析器都受益）
    expect(getCwd('s1')).toBe('/srv/app')
    expect(listCommandBlocks('s1').blocks).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// IPC 动作（不做成 ssh/pty 各一份：一个域覆盖所有会话类型）
// ---------------------------------------------------------------------------

const fakeCtx = {
  logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
  paths: {},
  emit: () => {},
} as unknown as IpcContext

const invoke = (payload: unknown): unknown => {
  const fn = shellIntegrationHandlers['listCommandBlocks'] as IpcHandler
  return fn(payload, fakeCtx)
}

describe('shellIntegration IPC 动作', () => {
  it('动作名与 Actions.shellIntegration 完全一致', () => {
    expect(Object.keys(shellIntegrationHandlers).sort()).toEqual([...Actions.shellIntegration].sort())
  })

  it('★ 有块时返回块与退出码', () => {
    feedSessionData('s1', osc('133;B') + 'false\r\n' + osc('133;C') + osc('133;D;1'))
    const result = invoke({ sessionId: 's1' }) as { total: number; blocks: Array<{ exitCode: number }> }
    expect(result.total).toBe(1)
    expect(result.blocks[0]?.exitCode).toBe(1)
  })

  it('★ 未知/未启用会话：空块 + 可操作原因（不是静默空数组）', () => {
    const unknown = invoke({ sessionId: 'nope' }) as { blocks: unknown[]; reason?: string }
    expect(unknown.blocks).toEqual([])
    expect(unknown.reason).toBeTypeOf('string')

    feedSessionData('s2', 'prompt$ ls\n')
    const noOsc = invoke({ sessionId: 's2' }) as { blocks: unknown[]; reason?: string }
    expect(noOsc.blocks).toEqual([])
    expect(noOsc.reason).toContain('OSC 133')
  })

  it('limit 透传并在越界时被拒（不静默吞掉非法输入）', () => {
    for (let i = 0; i < 5; i += 1) feedSessionData('s3', osc('133;D;0'))
    const three = invoke({ sessionId: 's3', limit: 3 }) as { blocks: unknown[]; truncated: boolean }
    expect(three.blocks).toHaveLength(3)
    expect(three.truncated).toBe(true)
    expect(() => invoke({ sessionId: 's3', limit: 999999 })).toThrow()
    expect(() => invoke({ sessionId: '' })).toThrow()
  })
})
