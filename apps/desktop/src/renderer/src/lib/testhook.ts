// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 自动化验证钩子。
 *
 * 无头环境（Xvfb + Electron）里没法手动点界面，所以把几个「造数据」的动作
 * 挂到 `window.__t1000` 上，供 CDP / 控制台驱动：
 *
 *   await window.__t1000.seedDemo(300)   // 灌 300 条连接，验证虚拟滚动
 *   window.__t1000.demoSession()         // 造一个已连接会话 + 监控快照
 *   window.__t1000.setView('console')
 *
 * 只做「填充数据 / 切视图」，不暴露任何绕过业务逻辑的后门：
 * 写库仍然走 store 的 IPC，走的是和界面完全相同的路径。
 */

import type { ConnectionKind, MonitorSnapshot } from '@t1000/shared'
import { seedDemo } from './demo-seed'
import { actions, applySnapshot, getState, setState, type ViewId } from './store'

const DEMO_SESSION_ID = 'demo-session-0001'

/** 造一份指标齐全的快照；进程数刻意给多，用来验证进程列表的虚拟滚动。 */
function demoSnapshot(processCount = 300): MonitorSnapshot {
  const cores = Array.from({ length: 16 }, (_, i) => ({
    index: i,
    usage: 8 + ((i * 37) % 70),
    mhz: 2400 + ((i * 133) % 1200),
  }))
  const processes = Array.from({ length: processCount }, (_, i) => ({
    pid: 1000 + i * 7,
    command: ['nginx: worker', 'node /srv/api/index.js', 'postgres: writer', 'python3 worker.py', 'systemd-journald'][i % 5] + ` #${i}`,
    cpu: Number((((i * 17) % 400) / 10).toFixed(1)),
    memory: Number((((i * 7) % 180) / 10).toFixed(1)),
    user: ['root', 'www-data', 'postgres', 'deploy'][i % 4],
    state: 'S',
  }))

  return {
    sessionId: DEMO_SESSION_ID,
    at: new Date().toISOString(),
    elapsedMs: 142,
    system: {
      hostname: 'edge-gateway-01',
      distro: 'Debian 12 (bookworm)',
      release: '6.1.0-18-amd64',
      kernel: 'Linux 6.1.0-18-amd64',
      arch: 'x86_64',
      timezone: 'Asia/Shanghai',
      uptimeSeconds: 1_234_567,
      users: 3,
      loadAvg: [0.42, 0.55, 0.61],
    },
    cpu: {
      usage: 34.7,
      cores,
      model: 'AMD EPYC 7B13 64-Core Processor',
      logicalCount: 16,
      physicalCount: 8,
      temperatureC: 52,
    },
    memory: {
      totalBytes: 16 * 1024 ** 3,
      usedBytes: 6.4 * 1024 ** 3,
      freeBytes: 9.6 * 1024 ** 3,
      cachedBytes: 3.1 * 1024 ** 3,
      swapTotalBytes: 4 * 1024 ** 3,
      swapUsedBytes: 0.2 * 1024 ** 3,
    },
    network: {
      interfaces: [
        { name: 'eth0', rxBytes: 8.1e11, txBytes: 3.4e11, rxSpeed: 1_258_291, txSpeed: 342_118 },
        { name: 'lo', rxBytes: 1.2e9, txBytes: 1.2e9, rxSpeed: 4096, txSpeed: 4096 },
      ],
      rxTotalBytes: 8.1e11,
      txTotalBytes: 3.4e11,
      rxSpeed: 1_258_291,
      txSpeed: 342_118,
    },
    disk: {
      partitions: [
        {
          mount: '/',
          device: '/dev/vda1',
          fsType: 'ext4',
          totalBytes: 98 * 1024 ** 3,
          usedBytes: 41 * 1024 ** 3,
          availableBytes: 57 * 1024 ** 3,
          usedPercent: 42,
          readSpeed: 2_400_000,
          writeSpeed: 1_100_000,
        },
        {
          mount: '/data',
          device: '/dev/vdb1',
          fsType: 'btrfs',
          totalBytes: 1024 * 1024 ** 3,
          usedBytes: 900 * 1024 ** 3,
          availableBytes: 124 * 1024 ** 3,
          usedPercent: 88,
          readSpeed: 8_100_000,
          writeSpeed: 5_600_000,
        },
        {
          mount: '/boot',
          device: '/dev/vda2',
          fsType: 'ext4',
          totalBytes: 1024 ** 3,
          usedBytes: 210 * 1024 ** 2,
          availableBytes: 790 * 1024 ** 2,
          usedPercent: 21,
        },
      ],
      readSpeed: 2_400_000,
      writeSpeed: 1_100_000,
    },
    processes,
    gpu: [
      {
        index: 0,
        name: 'NVIDIA A10',
        utilization: 62,
        memoryTotalBytes: 24 * 1024 ** 3,
        memoryUsedBytes: 9.5 * 1024 ** 3,
        temperatureC: 61,
      },
    ],
  }
}

export interface T1000TestHook {
  version: string
  getState(): ReturnType<typeof getState>
  setView(view: ViewId): void
  setProtocol(protocol: ConnectionKind): void
  seedDemo(count?: number): Promise<{ persisted: boolean; total: number }>
  /** 造一个「已连接」的会话标签，并把监控面板打开 */
  demoSession(title?: string): string
  /** 往指定会话注入一份监控快照（默认 demoSession 造的那个） */
  demoMonitor(processCount?: number, sessionId?: string): void
  snapshot(processCount?: number): MonitorSnapshot
}

function install(): void {
  const hook: T1000TestHook = {
    version: '1.0.0',
    getState,
    setView: (view) => actions.setView(view),
    setProtocol: (protocol) => actions.setProtocol(protocol),
    seedDemo: (count?: number) => seedDemo(count),
    demoSession: (title = 'edge-gateway-01') => {
      const tab = {
        tabId: 'demo-tab-1',
        kind: 'ssh' as const,
        title,
        subtitle: '192.0.2.10',
        connectionId: 'demo-conn-1',
        sessionId: DEMO_SESSION_ID,
        state: 'ready' as const,
        encoding: 'utf-8' as const,
        layout: 'single' as const,
        monitorOpen: true,
        filesOpen: true,
        mode: 'terminal' as const,
        createdAt: Date.now(),
      }
      setState((s) => ({
        view: 'console',
        tabs: s.tabs.some((t) => t.tabId === tab.tabId)
          ? s.tabs.map((t) => (t.tabId === tab.tabId ? tab : t))
          : [...s.tabs, tab],
        activeTabId: tab.tabId,
        monitorStatus: { ...s.monitorStatus, [DEMO_SESSION_ID]: 'running' },
      }))
      return tab.tabId
    },
    demoMonitor: (processCount = 300, sessionId = DEMO_SESSION_ID) => {
      applySnapshot(sessionId, { ...demoSnapshot(processCount), sessionId })
    },
    snapshot: (processCount = 300) => demoSnapshot(processCount),
  }

  ;(window as unknown as { __t1000?: T1000TestHook }).__t1000 = hook
}

let installed = false

export function installTestHook(): void {
  if (installed) return
  installed = true
  install()
}
