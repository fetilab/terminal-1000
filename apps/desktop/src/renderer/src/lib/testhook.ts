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
import {
  actions,
  applySnapshot,
  getState,
  setState,
  loadConnections,
  type ViewId,
} from './store'

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
  /**
   * 挂一个独立的 kitty 引擎画演示内容（真实内核 + 真实渲染器）。
   *
   * 用途：在没有 PTY / 没有 SSH 主机的环境里验证渲染链路本身 ——
   * 颜色、宽字符、emoji、下划线样式、选区、光标，全都能用同一份 ANSI 复现。
   */
  kittyDemo(options?: { width?: number; height?: number; ansi?: string }): Promise<{ backend: string }>
  /** 用真实 IPC 存一条连接并连上去（返回 tabId），用于端到端验收 */
  connectTest(conn: {
    name: string
    host: string
    port: number
    username: string
    password: string
  }): Promise<string>
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
  /**
   * 按**设置界面同款路径**改一个设置项：IPC set → 拿回全量文档 → applyAppearance。
   * 与 SettingsView.update 完全一致 —— 验收动态背景时走这条，别绕过 UI 链路。
   */
  setAppearance(path: string, value: unknown): Promise<boolean>
  /**
   * 切换应用深浅主题（与 SettingsView.update 同一条链路：
   * 写设置 → applyTheme → applyAppearance 重算调色板）
   */
  setThemeMode(mode: 'light' | 'dark' | 'system'): Promise<boolean>
}

/**
 * 设置界面改一个字段的完整动作，抽取出来供探针复用：
 * IPC set 拿回全量文档 → 应用外观 → 主题项额外同步 store。
 *
 * 探针走这条而不是各写一遍，是为了保证"测的就是用户点设置时发生的事"。
 */
async function setBySettingsPath(path: string, value: unknown): Promise<void> {
  const { invoke } = await import('./ipc')
  const { applyAppearance } = await import('../theme/appearance')
  const { applyTheme } = await import('./store')
  const next = await invoke<'settings', 'set', { path: string; value: unknown }, Record<string, unknown>>(
    'settings',
    'set',
    { path, value },
  )
  applyAppearance(next as never)
  if (path === 'app.theme') {
    const theme = (next as { app?: { theme?: 'light' | 'dark' | 'system' } }).app?.theme
    if (theme) applyTheme(theme)
  }
}

function install(): void {
  const hook: T1000TestHook = {
    version: '2.0.0',
    kittyDemo: async (options) => {
      const { KittyEngine } = await import('../features/terminal/kitty/engine')
      const host = document.createElement('div')
      host.id = 'kitty-demo'
      host.style.position = 'fixed'
      host.style.left = '0'
      host.style.top = '0'
      host.style.width = `${options?.width ?? 900}px`
      host.style.height = `${options?.height ?? 560}px`
      host.style.zIndex = '99999'
      host.style.background = '#0d0f14'
      document.body.appendChild(host)
      const st = getState().terminalSettings
      const engine = new KittyEngine({
        host,
        sessionId: `demo-${Date.now()}`,
        kind: 'local',
        settings: st,
        resolvedTheme: 'dark',
        onWrite: () => undefined,
      })
      await engine.open()
      const demo =
        options?.ansi ??
        [
          '\x1b[1;38;2;62;201;214mterminal-1000\x1b[0m \x1b[2m· kitty VT 内核 + 自绘 WebGL2\x1b[0m',
          '',
          '\x1b[1m粗体\x1b[0m  \x1b[3m斜体\x1b[0m  \x1b[4m下划线\x1b[0m  \x1b[4:2m双线\x1b[0m  \x1b[4:3m波浪\x1b[0m  \x1b[4:5m虚线\x1b[0m  \x1b[9m删除\x1b[0m',
          '\x1b[31m红\x1b[0m \x1b[32m绿\x1b[0m \x1b[33m黄\x1b[0m \x1b[34m蓝\x1b[0m \x1b[35m品红\x1b[0m \x1b[36m青\x1b[0m \x1b[38;2;255;140;0m真彩橙\x1b[0m',
          '宽字符：中文对齐测试｜ＡＢＣ｜emoji 👍🚀 与半角混排 abc',
          '连字：-> => != === >= :: | 对齐',
          '256 色：\x1b[38;5;196m红\x1b[0m\x1b[38;5;46m绿\x1b[0m\x1b[38;5;21m蓝\x1b[0m\x1b[38;5;226m黄\x1b[0m \x1b[48;5;238m 背景 \x1b[0m',
          '',
          '\x1b[32m➜\x1b[0m \x1b[36m~/project\x1b[0m git:(\x1b[31mmain\x1b[0m) \x1b[33mnpm run build\x1b[0m',
          'vite v5.4.21 building for production...',
          '\x1b[32m✓\x1b[0m 993 modules transformed.',
          '\x1b[32m✓\x1b[0m built in 9.49s',
          '',
          '$ █',
        ].join('\r\n')
      engine.write(demo)
      ;(window as unknown as { __kittyDemoEngine?: unknown }).__kittyDemoEngine = engine
      return { backend: engine.backendLabel }
    },
    connectTest: async (conn) => {
      const { invoke } = await import('./ipc')
      const full = { ...conn, id: `test-${Date.now()}`, kind: 'ssh' as const, groupId: null }
      await invoke('store', 'saveConnection', full as never)
      await loadConnections(true)
      const { connectTo, getConnection } = await import('./store')
      const saved = getConnection(full.id)
      if (!saved) throw new Error('保存连接失败')
      const tab = await connectTo(saved)
      return (tab as unknown as { tabId: string }).tabId
    },
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
    setAppearance: async (path, value) => {
      await setBySettingsPath(path, value)
      return true
    },
    /*
     * 切明暗必须走**设置界面同款路径**：写 app.theme → applyTheme（store 的 resolvedTheme
     * + data-theme）→ applyAppearance（重算调色板）。
     *
     * 少了第二步会留下"文字换成浅色、面板还是浅色底"的半截状态 ——
     * 那不是应用的 bug，是探针抄了近路；探针必须和用户走同一条链路才有意义。
     */
    setThemeMode: async (mode) => {
      await setBySettingsPath('app.theme', mode)
      return true
    },
  }

  ;(window as unknown as { __t1000?: T1000TestHook }).__t1000 = hook
}

let installed = false

export function installTestHook(): void {
  if (installed) return
  installed = true
  install()
}
