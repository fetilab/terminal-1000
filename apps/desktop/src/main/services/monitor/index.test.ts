// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * monitor IPC 契约测试。
 *
 * router 注册的是「handler 表里有什么就注册什么」，所以 Actions.monitor 与实际
 * handler 的漂移不会在编译期暴露（渲染层只会收到 UNSUPPORTED）。这里把它钉死。
 */

import { describe, expect, it } from 'vitest'
import { Actions } from '@t1000/shared'
import { monitorHandlers } from './index'

describe('monitor IPC 契约', () => {
  it('handler 动作集合与 Actions.monitor 完全一致', () => {
    expect(Object.keys(monitorHandlers).sort()).toEqual([...Actions.monitor].sort())
  })

  it('每个动作都是可调用函数', () => {
    for (const [action, handler] of Object.entries(monitorHandlers)) {
      expect(typeof handler, `动作 ${action} 应该是函数`).toBe('function')
    }
  })

  it('不重复导出动作名', () => {
    const names = Object.keys(monitorHandlers)
    expect(new Set(names).size).toBe(names.length)
  })
})
