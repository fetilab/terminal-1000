// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 演示数据。
 *
 * 用途有两个，都是有意为之：
 * 1. 首次启动时的空状态引导 —— 用户点「载入演示数据」就能看到完整界面；
 * 2. 自动化验证 —— 无头环境通过 `window.__t1000.seedDemo(n)` 灌数据后截图。
 *
 * 数据全部是 RFC 5737 / RFC 2606 保留段（192.0.2.0/24、example.com），
 * 不会指向任何真实主机，也不会诱发真实连接尝试。
 */

import type { Connection, ConnectionGroup, SshConnection } from '@t1000/shared'

const NOW = '2026-01-01T00:00:00.000Z'

function iso(offsetDays: number): string {
  const base = Date.parse('2026-11-05T12:00:00.000Z')
  return new Date(base + offsetDays * 86_400_000).toISOString()
}

export const DEMO_GROUP_IDS = {
  prod: 'demo-group-prod',
  prodWeb: 'demo-group-prod-web',
  prodDb: 'demo-group-prod-db',
  staging: 'demo-group-staging',
  lab: 'demo-group-lab',
} as const

export function demoGroups(): ConnectionGroup[] {
  const g = (
    id: string,
    name: string,
    sortOrder: number,
    parentId?: string,
  ): ConnectionGroup => ({
    id,
    name,
    kind: 'ssh',
    sortOrder,
    ...(parentId === undefined ? {} : { parentId }),
    storeType: 'local',
    createdAt: NOW,
    updatedAt: NOW,
  })

  return [
    g(DEMO_GROUP_IDS.prod, '生产环境', 0),
    g(DEMO_GROUP_IDS.prodWeb, 'Web 集群', 0, DEMO_GROUP_IDS.prod),
    g(DEMO_GROUP_IDS.prodDb, '数据库', 1, DEMO_GROUP_IDS.prod),
    g(DEMO_GROUP_IDS.staging, '预发布', 1),
    g(DEMO_GROUP_IDS.lab, '实验机', 2),
  ]
}

interface SeedSpec {
  name: string
  host: string
  username: string
  groupId?: string
  port?: number
  authType?: SshConnection['authType']
  favorite?: boolean
  useCount?: number
  lastUsedAt?: string
  note?: string
}

const SEEDS: SeedSpec[] = [
  {
    name: 'edge-gateway-01',
    host: '192.0.2.10',
    username: 'ops',
    groupId: DEMO_GROUP_IDS.prodWeb,
    authType: 'privateKey',
    favorite: true,
    useCount: 42,
    lastUsedAt: iso(0),
    note: '对外网关，改动前先看 nginx -t',
  },
  {
    name: 'edge-gateway-02',
    host: '192.0.2.11',
    username: 'ops',
    groupId: DEMO_GROUP_IDS.prodWeb,
    authType: 'privateKey',
    favorite: true,
    useCount: 38,
    lastUsedAt: iso(0),
  },
  {
    name: 'app-node-a',
    host: '192.0.2.21',
    username: 'deploy',
    groupId: DEMO_GROUP_IDS.prodWeb,
    useCount: 17,
    lastUsedAt: iso(-1),
  },
  {
    name: 'app-node-b',
    host: '192.0.2.22',
    username: 'deploy',
    groupId: DEMO_GROUP_IDS.prodWeb,
    useCount: 15,
    lastUsedAt: iso(-1),
  },
  {
    name: 'app-node-c',
    host: '192.0.2.23',
    username: 'deploy',
    groupId: DEMO_GROUP_IDS.prodWeb,
    useCount: 9,
    lastUsedAt: iso(-3),
  },
  {
    name: 'pg-primary',
    host: '192.0.2.31',
    username: 'postgres',
    groupId: DEMO_GROUP_IDS.prodDb,
    authType: 'identity',
    useCount: 11,
    lastUsedAt: iso(-2),
    note: '只读账号；迁移窗口另行通知',
  },
  {
    name: 'pg-replica',
    host: '192.0.2.32',
    username: 'postgres',
    groupId: DEMO_GROUP_IDS.prodDb,
    useCount: 4,
    lastUsedAt: iso(-6),
  },
  {
    name: 'redis-cache',
    host: '192.0.2.33',
    username: 'ops',
    groupId: DEMO_GROUP_IDS.prodDb,
    port: 2222,
    useCount: 2,
    lastUsedAt: iso(-9),
  },
  {
    name: 'staging-all-in-one',
    host: '192.0.2.50',
    username: 'dev',
    groupId: DEMO_GROUP_IDS.staging,
    useCount: 23,
    lastUsedAt: iso(-1),
    note: '预发布单机，随便折腾',
  },
  {
    name: 'staging-worker',
    host: '192.0.2.51',
    username: 'dev',
    groupId: DEMO_GROUP_IDS.staging,
    useCount: 6,
    lastUsedAt: iso(-4),
  },
  {
    name: 'build-runner',
    host: '192.0.2.60',
    username: 'ci',
    groupId: DEMO_GROUP_IDS.lab,
    authType: 'keyboardInteractive',
    useCount: 3,
    lastUsedAt: iso(-12),
  },
  {
    name: 'nfs-store',
    host: '192.0.2.61',
    username: 'root',
    groupId: DEMO_GROUP_IDS.lab,
    port: 2200,
  },
  {
    name: 'jump-bastion',
    host: '192.0.2.9',
    username: 'jump',
    favorite: true,
    useCount: 51,
    lastUsedAt: iso(0),
    note: '所有生产连接的跳板入口',
  },
  {
    name: 'backup-archive',
    host: '192.0.2.70',
    username: 'archive',
    useCount: 1,
    lastUsedAt: iso(-21),
  },
]

function baseConnection(
  id: string,
  name: string,
  host: string,
  port: number,
  username: string,
  createdAt: string,
  updatedAt: string,
): Omit<SshConnection, 'authType'> & { authType: SshConnection['authType'] } {
  return {
    kind: 'ssh',
    id,
    name,
    host,
    port,
    username,
    authType: 'password',
    options: { timeoutMs: 15000, keepalive: { transportIntervalMs: 5000 } },
    storeType: 'local',
    createdAt,
    updatedAt,
  }
}

/** 生成演示连接。count 用来做压力验证（灌 300 条看虚拟滚动是否稳）。 */
export function demoConnections(count = SEEDS.length): Connection[] {
  const out: Connection[] = []
  const groups = demoGroups()

  for (let i = 0; i < count; i += 1) {
    const seed = SEEDS[i % SEEDS.length]
    if (!seed) continue
    const isRepeat = i >= SEEDS.length
    const suffix = isRepeat ? `-${String(Math.floor(i / SEEDS.length) + 1).padStart(2, '0')}` : ''
    const id = `demo-conn-${i + 1}`
    const conn = baseConnection(
      id,
      `${seed.name}${suffix}`,
      isRepeat ? `192.0.${100 + Math.floor(i / 250)}.${(i % 250) + 1}` : seed.host,
      seed.port ?? 22,
      seed.username,
      iso(-40 + (i % 20)),
      iso(-(i % 14)),
    ) as Connection & Record<string, unknown>

    conn.authType = seed.authType ?? 'password'
    if (seed.groupId && groups.some((g) => g.id === seed.groupId)) conn.groupId = seed.groupId
    if (seed.note) conn.note = seed.note
    if (seed.favorite) conn.favorite = true
    if (seed.useCount) conn.useCount = seed.useCount
    if (seed.lastUsedAt) conn.lastUsedAt = seed.lastUsedAt

    out.push(conn)
  }

  return out
}

/** 非 SSH 协议的演示连接，让顶部分类标签不至于全是空的。 */
export function demoOtherConnections(): Connection[] {
  const mk = (
    kind: Connection['kind'],
    id: string,
    name: string,
    host: string,
    port: number,
    extra: Record<string, unknown> = {},
  ): Connection =>
    ({
      kind,
      id,
      name,
      host,
      port,
      groupId: DEMO_GROUP_IDS.lab,
      storeType: 'local',
      createdAt: NOW,
      updatedAt: NOW,
      ...extra,
    }) as unknown as Connection

  return [
    mk('rdp', 'demo-rdp-1', 'win-builder', '192.0.2.80', 3389, {
      username: 'Administrator',
      domain: 'LAB',
      displayMode: 'follow-window',
      quality: 'balanced',
      clipboardShare: true,
    }),
    mk('telnet', 'demo-telnet-1', 'core-switch', '192.0.2.90', 23, {
      username: 'admin',
      keyMapping: { enabled: true, template: 'standard' },
    }),
    mk('tunnel', 'demo-tunnel-1', 'grafana-3000', '0.0.0.0', 3000, {
      serverId: 'demo-conn-13',
      type: 'local',
      localHost: '127.0.0.1',
      localPort: 13000,
      remoteHost: '127.0.0.1',
      remotePort: 3000,
      autoReconnect: true,
    }),
    mk('vnc', 'demo-vnc-1', 'lab-desktop', '192.0.2.91', 5901, {
      authType: 'vnc-password',
      viewOnly: false,
      shared: true,
      scaleViewport: true,
      qualityLevel: 6,
      compressionLevel: 2,
    }),
  ]
}
