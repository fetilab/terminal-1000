// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 设置项的消费者清单 —— 「设置面板不能说谎」的记账本。
 *
 * 为什么需要它：设置面板最容易出的问题不是画错，而是**存了却没人消费**。
 * 用户拨了开关、什么都没发生，会以为是自己操作没生效，甚至去排查环境问题。
 * 这类问题靠人记不住（49 项里漏 14 项就是这么来的），所以：
 *
 * - 本文件把「每一项由谁消费」显式写下来；
 * - `settingsFields.test.ts` 强制要求：settingsFields 里出现的每个路径，
 *   **必须**要么在 `SETTINGS_CONSUMERS`，要么在 `PENDING_CONSUMERS`（带原因）。
 *   新增设置项忘了接线 → 测试直接红。
 *
 * 两条纪律：
 * 1. `PENDING_CONSUMERS` 必须写清**为什么还没生效**和**谁来补**，不许写"待办"了事；
 * 2. 一旦补上消费点，把它从 PENDING 挪到 SETTINGS_CONSUMERS，别留在白名单里。
 */

/** 渲染层（或明确的主进程模块）已经消费的设置路径 → 消费点说明 */
export const SETTINGS_CONSUMERS: Record<string, string> = {
  // ── 外观与通用 ──
  'app.theme': 'lib/store.ts applyTheme() → 根节点 data-theme + 终端配色跟随',

  // ── 终端（全部由 features/terminal/TerminalPane 消费，且支持热更新） ──
  'terminal.fontFamily': 'TerminalPane 创建时使用 + 热更新 term.options.fontFamily',
  'terminal.fontSize': '同上（term.options.fontSize）',
  'terminal.lineHeight': '同上（term.options.lineHeight）',
  'terminal.letterSpacing': '同上（term.options.letterSpacing）',
  'terminal.cursorStyle': '同上（term.options.cursorStyle）',
  'terminal.cursorBlink': '同上（term.options.cursorBlink）',
  'terminal.copyOnSelect': 'TerminalPane onSelectionChange → 选中即写入剪贴板',
  'terminal.rightClickPaste': 'TerminalPane onContextMenu → 直接粘贴而不弹菜单',
  'terminal.scrollback': '同上（term.options.scrollback）',
  'terminal.bell': 'TerminalPane onBell + VNC 查看器 BELL → sound 时发声、visual 时提示',
  'terminal.colorScheme': 'TerminalPane themeFor() → 三套内置配色，热切换',
  'terminal.linkDetection': 'TerminalPane 挂/卸 WebLinksAddon（热开关）',

  // ── 命令补全（消费点在主进程引擎） ──
  'completion.enabled': 'main services/completion/engine.ts（开关）',
  'completion.specCompletion': 'main services/completion/engine.ts（补全来源开关）',
  'completion.historyCompletion': 'main services/completion/engine.ts（补全来源开关）',
  'completion.generatorCompletion': 'main services/completion/engine.ts（生成式补全开关）',
  'completion.aiSuggestion': 'main services/completion/engine.ts（?? 前缀通道）',
  'completion.debounceMs': 'main 返回给渲染层，TerminalPane 用它做输入防抖',
  'completion.maxSuggestions': 'main services/completion/engine.ts（候选上限）',

  // ── AI（消费点在主进程护栏与对话服务） ──
  'ai.mode': 'main services/ai/chat.ts（四种模式）',
  'ai.allowExecution': 'main services/ai/guard.ts（未开启时只给建议，不执行）',
  'ai.riskPolicy.confirmSudo': 'main services/ai/guard.ts（sudo 确认策略）',
  'ai.limits.maxRounds': 'main services/ai/guard.ts（三重上限之一）',
  'ai.limits.maxCommands': 'main services/ai/guard.ts（三重上限之一）',
  'ai.limits.maxTargets': 'main services/ai/guard.ts（三重上限之一）',

  // ── 文件传输 ──
  'transfer.maxInflightPerConnection': 'main services/sftp/transfer.ts（并发闸门）',
  'transfer.progressThrottleMs': 'main services/sftp/transfer.ts（进度节流）',
  'transfer.conflictPolicy': 'main transfer 引擎 + 渲染层 SFTP 上传/下载弹窗（显示当前策略）',
  'transfer.preservePermissions': 'main services/sftp/transfer.ts',
  'transfer.preserveTimestamps': 'main services/sftp/transfer.ts',

  // ── 同步 ──
  'sync.enabled': 'main services/sync/index.ts（启用门控）',
  'sync.autoSync': 'main services/sync/index.ts（自动同步）',
  'sync.endpoint': 'main services/sync/index.ts（后端地址）+ 渲染层同步面板可编辑',
  'sync.conflictPolicy': 'main services/sync/index.ts（冲突策略）',
  'sync.scopes.connections': 'main services/sync/index.ts（同步范围）',
  'sync.scopes.groups': 'main services/sync/index.ts（同步范围）',
  'sync.scopes.notes': 'main services/sync/index.ts（同步范围）',
  'sync.scopes.settings': 'main services/sync/index.ts（同步范围）',
}

/**
 * 已知**暂无消费者**的设置路径 → 未生效原因 + 归属。
 *
 * 这里每一条都是"用户拨了不会有反应"的项，所以宁可从面板移除也不该留着骗人。
 * 目前为空的含义是：**面板上每一项都真的有消费点**。
 */
export const PENDING_CONSUMERS: Record<string, string> = {
  // 主进程侧正在实现（lead 负责）；完成前这几项目前**仍显示在面板上**，
  // 但已在这一版由主进程 consuming —— 若长期未接，应改为移除或显著标注"未生效"。
  'app.restoreLastSession': '主进程启动恢复会话（lead 实现中）',
  'app.minimizeToTray': '主进程托盘行为（lead 实现中）',
  'app.showTrayIcon': '主进程托盘图标（lead 实现中）',
  'app.autoCheckUpdate': '主进程更新检查（lead 实现中）',
  'app.updateChannel': '主进程更新通道（lead 实现中）',
  'app.openAtLogin': 'services/system applyRuntimeSettings() → app.setLoginItemSettings；设置写入后经 IPC 钩子立即重应用',
  'app.confirmOnClose': 'main/index.ts 窗口 close 处理器 → dialog.showMessageBox（默认落在「取消」，避免误关）',
  'app.hardwareAcceleration': 'services/system applyEarlySettings() → app.disableHardwareAcceleration()（**必须在 ready 之前**，故需重启生效）',
  'app.dailyBackup': 'services/system startDailyBackup() → 启动后 1 分钟首备、之后每 24 小时；未解锁时明确跳过',

  // ── 锁定与备份 ──
  'security.autoLockMinutes': 'services/system startAutoLock() → powerMonitor.getSystemIdleTime() 每 15s 检查，到点 store.lock() 并发 SECURITY_LOCKED',
  'security.backupRetentionDays': 'services/system pruneBackups() → 只清理本应用生成的备份文件（前缀+后缀双匹配，绝不误删目录里其它文件）',
  'sync.scopes.credentials': '凭证同步范围（lead 实现中）',
}
