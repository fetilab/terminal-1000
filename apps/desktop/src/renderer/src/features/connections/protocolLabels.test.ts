// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

import { describe, expect, it } from 'vitest'
import type { ConnectionKind } from '@t1000/shared'
import { PROTOCOLS, createConnectionLabel, protocolLabel } from './protocolLabels'

describe('protocolLabels', () => {
  it('协议清单覆盖全部 ConnectionKind，顺序即协议栏顺序', () => {
    const kinds: ConnectionKind[] = ['ssh', 'rdp', 'telnet', 'tunnel', 'vnc']
    expect(PROTOCOLS.map((p) => p.value)).toEqual(kinds)
  })

  it('createConnectionLabel：拉丁缩写两侧留空格', () => {
    expect(createConnectionLabel('ssh')).toBe('新建 SSH 连接')
    expect(createConnectionLabel('rdp')).toBe('新建 RDP 连接')
    expect(createConnectionLabel('telnet')).toBe('新建 Telnet 连接')
    expect(createConnectionLabel('vnc')).toBe('新建 VNC 连接')
  })

  it('createConnectionLabel：纯中文协议不留空格', () => {
    expect(createConnectionLabel('tunnel')).toBe('新建隧道连接')
  })

  it('protocolLabel：未知 kind 兜底为大写 kind，不出现空串', () => {
    expect(protocolLabel('relay' as ConnectionKind)).toBe('RELAY')
    expect(createConnectionLabel('relay' as ConnectionKind)).toBe('新建 RELAY 连接')
  })
})
