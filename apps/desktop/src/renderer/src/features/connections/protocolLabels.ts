// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

import type { ConnectionKind } from '@t1000/shared'

/** 顶部协议栏与各「新建连接」按钮共用的协议清单：顺序即协议栏顺序。 */
export const PROTOCOLS: ReadonlyArray<{ value: ConnectionKind; label: string }> = [
  { value: 'ssh', label: 'SSH' },
  { value: 'rdp', label: 'RDP' },
  { value: 'telnet', label: 'Telnet' },
  { value: 'tunnel', label: '隧道' },
  { value: 'vnc', label: 'VNC' },
]

/** 协议显示名；未知 kind 兜底为大写 kind，避免界面出现空串。 */
export function protocolLabel(kind: ConnectionKind): string {
  return PROTOCOLS.find((p) => p.value === kind)?.label ?? kind.toUpperCase()
}

/**
 * 「新建连接」按钮文案，跟随顶部协议栏。
 * 拉丁缩写两侧留空格（新建 SSH 连接），纯中文（隧道）不留（新建隧道连接）。
 */
export function createConnectionLabel(kind: ConnectionKind): string {
  const label = protocolLabel(kind)
  return /^[A-Za-z0-9-]+$/.test(label) ? `新建 ${label} 连接` : `新建${label}连接`
}
