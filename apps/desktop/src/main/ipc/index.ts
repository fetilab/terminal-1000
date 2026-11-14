// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

import { createLogger } from '../logger'
import { appHandlers } from './handlers/app'
import { listLazyDomains, listRegistered, registerDomain, registerLazyDomain } from './router'

const log = createLogger('ipc-setup')

/**
 * 注册全部 IPC 域。
 *
 * **除启动即用的少数域外，一律懒加载**：只在第一次被调用时才 import。
 *
 * 为什么：启动时全量 import 会把 ssh2 / better-sqlite3 / node-pty 以及各协议实现
 * 一次性拉进内存，直接体现为空闲内存偏高；而多数会话根本用不到
 * AI / MCP / VNC / RDP / 隧道 这些域。
 *
 * `app` 保持立即注册：它极小，且渲染层首屏第一时间就要（窗口信息、路径）。
 */
export function registerAllHandlers(): void {
  // ── 立即注册 ──
  registerDomain('app', appHandlers)

  // ── 懒加载：以下每个域都只在第一次被调用时 import ──
  registerLazyDomain('store', async () => (await import('../services/store')).storeHandlers)
  registerLazyDomain('ssh', async () => (await import('../services/ssh')).sshHandlers)
  registerLazyDomain('sftp', async () => (await import('../services/sftp')).sftpHandlers)
  registerLazyDomain('monitor', async () => (await import('../services/monitor')).monitorHandlers)
  registerLazyDomain('pty', async () => (await import('../services/pty')).ptyHandlers)
  registerLazyDomain('forward', async () => (await import('../services/forward')).forwardHandlers)
  registerLazyDomain('settings', async () => (await import('../services/settings')).settingsHandlers)
  registerLazyDomain('notes', async () => (await import('../services/notes')).notesHandlers)
  registerLazyDomain('sync', async () => (await import('../services/sync')).syncHandlers)
  registerLazyDomain('completion', async () =>
    (await import('../services/completion')).completionHandlers,
  )
  registerLazyDomain('ai', async () => (await import('../services/ai')).aiHandlers)
  registerLazyDomain('mcp', async () => (await import('../services/mcp')).mcpHandlers)
  registerLazyDomain('hotkey', async () => (await import('../services/hotkey')).hotkeyHandlers)
  registerLazyDomain('sessionlog', async () =>
    (await import('../services/sessionlog')).sessionlogHandlers,
  )
  registerLazyDomain('telnet', async () => (await import('../services/telnet')).telnetHandlers)
  registerLazyDomain('vnc', async () => (await import('../services/vnc')).vncHandlers)
  registerLazyDomain('rdp', async () => (await import('../services/rdp')).rdpHandlers)
  registerLazyDomain('broadcast', async () =>
    (await import('../services/broadcast')).broadcastHandlers,
  )
  registerLazyDomain('quickcmd', async () => (await import('../services/quickcmd')).quickcmdHandlers)
  registerLazyDomain('system', async () => (await import('../services/system')).systemHandlers)
  // 命令块（OSC 133）：解析走 subscribeAllSessionData，一份覆盖 ssh/pty/telnet，
  // 所以做成单独一个域而不是 ssh.* + pty.* 两份（拆两份迟早不一致）
  registerLazyDomain(
    'shellIntegration',
    async () => (await import('../services/session-cwd')).shellIntegrationHandlers,
  )
  registerLazyDomain('update', async () => (await import('../services/update')).updateHandlers)

  // 分两段报：否则"动作数变少"会让人误以为有域没挂上
  log.info(
    `IPC 就绪：立即注册 ${listRegistered().length} 个动作；` +
      `${listLazyDomains().length} 个域按首次调用懒加载`,
  )
}
