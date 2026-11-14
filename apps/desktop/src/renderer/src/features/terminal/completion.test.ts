// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 终端补全的前端支撑单测：`??` AI 标记识别、命令行跟踪、接受候选。
 */

import { describe, expect, it } from 'vitest'
import { LineTracker, applyCandidate, detectAiSuggestion, stripAiMarker } from './completion'

describe('?? AI 建议标记识别', () => {
  it('前缀写法：`?? xxx`', () => {
    expect(detectAiSuggestion('?? 找出大于 100MB 的文件')).toBe(true)
    expect(detectAiSuggestion('  ?? 列出端口占用')).toBe(true)
    expect(detectAiSuggestion('??')).toBe(true)
  })

  it('★ 行尾紧跟写法：`docker run??`（本次要打通的用法）', () => {
    expect(detectAiSuggestion('docker run??')).toBe(true)
    expect(detectAiSuggestion('tar 压缩一个目录??')).toBe(true)
  })

  it('`??` 独立成词不算（那是给命令传字面参数）', () => {
    expect(detectAiSuggestion('echo ??')).toBe(false)
    expect(detectAiSuggestion('grep "??" file')).toBe(false)
    expect(detectAiSuggestion('docker run')).toBe(false)
    expect(detectAiSuggestion('ls -la')).toBe(false)
    expect(detectAiSuggestion('')).toBe(false)
  })

  it('去掉标记后就是给 AI 看的文本', () => {
    expect(stripAiMarker('?? 找出大文件')).toBe('找出大文件')
    expect(stripAiMarker('  ??   列出端口')).toBe('列出端口')
    expect(stripAiMarker('docker run??')).toBe('docker run')
    expect(stripAiMarker('docker run')).toBe('docker run')
  })

  it('非 AI 行不会被改动', () => {
    expect(stripAiMarker('echo ??')).toBe('echo ??')
  })
})

describe('LineTracker 与 AI 标记的配合', () => {
  it('跟踪到用户输入的 `??`（原样保留，由主进程解析）', () => {
    const tracker = new LineTracker()
    tracker.consume('docker run??')
    expect(tracker.line).toBe('docker run??')
    expect(detectAiSuggestion(tracker.line)).toBe(true)
    expect(tracker.isReliable).toBe(true)
  })

  it('回车后清空（AI 请求发出后不再重复触发）', () => {
    const tracker = new LineTracker()
    tracker.consume('docker run??')
    tracker.consume('\r')
    expect(tracker.line).toBe('')
    expect(detectAiSuggestion(tracker.line)).toBe(false)
  })
})

describe('applyCandidate（接受候选仍然是原逻辑）', () => {
  it('替换当前 token 并给出回传字节', () => {
    const line = 'docker ru'
    const result = applyCandidate(line, { tokenStart: 7, replaceEnd: 9 }, {
      value: 'run',
      kind: 'command',
      score: 100,
      matchKind: 'prefix',
    })
    expect(result.payload).toBe('\u007f\u007frun')
    expect(result.line).toBe('docker run')
  })
})
