// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 演示数据灌入（**仅开发构建**）。
 *
 * 这个模块刻意从 lib/store.ts 里拆出来，并且只通过
 * `if (import.meta.env.DEV) await import('./demo-seed')` 这样的守卫引用，
 * 目的：Vite 在 production 下把 `import.meta.env.DEV` 替换为 false 后，
 * 死代码消除会连同这个动态导入一起删掉 —— 生产包里既没有这个 chunk，
 * 也没有 lib/demo.ts 的数据，用户数据不可能被演示数据污染。
 *
 * 数据本身全部指向 RFC 5737 / RFC 2606 保留地址段，不会发起真实连接。
 */

import type { ConnectionGroup } from '@t1000/shared'
import { toast } from '../components/Toast'
import {
  loadConnections,
  normaliseGroups,
  setState,
  type UiConnection,
} from './store'
import { invoke } from './ipc'
import { demoConnections, demoGroups, demoOtherConnections } from './demo'

export async function seedDemo(count = 14): Promise<{ persisted: boolean; total: number }> {
  const conns = [...demoConnections(count), ...demoOtherConnections()]
  const groups = demoGroups()
  let persisted = true

  setState({ busy: { label: '载入演示数据', done: 0, total: conns.length } })
  for (const g of groups) {
    try {
      await invoke<'store', 'saveGroup', ConnectionGroup, unknown>('store', 'saveGroup', g)
    } catch {
      persisted = false
    }
  }
  for (let i = 0; i < conns.length; i += 1) {
    const conn = conns[i]
    if (!conn) continue
    try {
      await invoke<'store', 'saveConnection', UiConnection, UiConnection>(
        'store',
        'saveConnection',
        conn as UiConnection,
      )
    } catch {
      persisted = false
    }
    if (i % 10 === 0) {
      setState({ busy: { label: '载入演示数据', done: i, total: conns.length } })
    }
  }

  setState({
    busy: null,
    connections: conns,
    groups: normaliseGroups(groups.map((g) => ({ ...g, children: [], connectionCount: 0 }))),
    loaded: true,
    loading: false,
  })
  await loadConnections(true)

  toast[persisted ? 'ok' : 'warn'](
    persisted ? `已载入 ${conns.length} 条演示连接` : `后端不可用，已用内存数据展示 ${conns.length} 条连接`,
  )
  return { persisted, total: conns.length }
}