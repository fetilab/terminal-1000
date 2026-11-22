// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 快捷键命令表 + 分发。
 *
 * ## 为什么要有这一层
 *
 * 快捷键**全部**来自设置里的 `hotkeys`（`HotkeyBinding[]`），主进程通过
 * `before-input-event` 捕获后发 `HOTKEY_TRIGGERED` 事件。但在 0.2.5 之前，
 * 渲染层**没有任何地方订阅这个事件** —— 于是「设置 → 快捷键」里绑的键按下去
 * 什么都不会发生，而真正生效的是一批写死在组件里的组合键。
 *
 * 写死的那批有两类毛病：
 * 1. 会从终端程序手里抢键（`Ctrl+K` 是 readline 的 kill-line、`Ctrl+Space`
 *    是 emacs 的 set-mark、`Ctrl+1` 之类在部分程序里也有用）；
 * 2. 用户改不了，也关不掉。
 *
 * 现在统一走这里：**命令名是唯一的契约**，绑定与开关由设置决定。
 * 应用级命令（切视图、搜索、设置）直接改 store；
 * 终端级命令（查找、清屏、补全）通过 `CustomEvent` 交给**当前聚焦的窗格**，
 * 避免多窗格同时响应。
 */

import { actions, closeTab, openLocalTerminal, setTabLayout, getState } from './store'

/** 命令 id → 人话（设置界面与命令面板共用，避免两处措辞不一致） */
export const COMMAND_LABELS: Record<string, string> = {
  'terminal.newTab': '新建会话标签',
  'terminal.closeTab': '关闭当前标签',
  'terminal.find': '终端内查找',
  'terminal.clear': '清屏',
  'terminal.splitHorizontal': '左右分屏',
  'terminal.splitVertical': '上下分屏',
  'terminal.completion': '触发命令补全',
  'app.openSettings': '打开设置',
  'app.globalSearch': '全局搜索',
  'app.view.connections': '切换到连接中心',
  'app.view.console': '切换到终端',
  'app.view.notes': '切换到笔记',
  'app.view.tools': '切换到工具箱',
  'app.view.ai': '切换到 AI 助手',
  'app.view.services': '切换到服务',
  'app.view.logs': '切换到日志',
  'app.toggleWindow': '显示 / 隐藏主窗口',
}

/** 需要窗格自己处理（而不是应用级）的命令 */
const PANE_COMMANDS = new Set([
  'terminal.find',
  'terminal.clear',
  'terminal.completion',
])

const VIEW_COMMANDS: Record<string, Parameters<typeof actions.setView>[0]> = {
  'app.view.connections': 'connections',
  'app.view.console': 'console',
  'app.view.notes': 'notes',
  'app.view.tools': 'tools',
  'app.view.ai': 'ai',
  'app.view.services': 'services',
  'app.view.logs': 'logs',
}

/**
 * 终端窗格监听的内部事件名。
 *
 * detail 里带**当前激活标签**：多窗格（分屏）同时挂了这个监听，
 * 只有「焦点所在窗格」或「激活标签里的窗格」才该响应 ——
 * 否则按一次"查找"，左右两半屏一起弹查找框。
 */
export interface PaneCommandDetail {
  command: string
  tabId: string | null
}

export const PANE_COMMAND_EVENT = 't1000:command'

/**
 * 执行一条命令。
 *
 * 返回是否被处理 —— 让调用方（设置界面的"试运行"、快捷键冲突提示）能如实反馈，
 * 而不是静默什么都没发生。
 */
export function runCommand(command: string): boolean {
  if (PANE_COMMANDS.has(command)) {
    // 窗格命令只对终端有意义：用户在别的视图按了查找/清屏，先把控制台亮出来，
    // 否则命令作用在一个 display:none 的窗格上，看起来就是"按了没反应"
    if (getState().view !== 'console') actions.setView('console')
    // 只发给激活标签：焦点在其内部的窗格接手；没有焦点就让激活标签的第一个
    // 窗格接手（见 TerminalPane 的监听逻辑）。app.toggleWindow 不经过这里 ——
    // 它是窗口管理操作，主进程在 emitTriggered 里就地执行。
    const detail: PaneCommandDetail & { handled?: boolean } = {
      command,
      tabId: getState().activeTabId,
      handled: false,
    }
    window.dispatchEvent(new CustomEvent(PANE_COMMAND_EVENT, { detail }))
    return true
  }

  switch (command) {
    case 'terminal.newTab':
      void openLocalTerminal()
      return true

    case 'terminal.closeTab': {
      const id = getState().activeTabId
      if (id) closeTab(id)
      return Boolean(id)
    }

    case 'terminal.splitHorizontal':
    case 'terminal.splitVertical': {
      const id = getState().activeTabId
      if (!id) return false
      setTabLayout(id, command === 'terminal.splitHorizontal' ? 'hsplit' : 'vsplit')
      return true
    }

    case 'app.openSettings':
      actions.setView('settings')
      return true

    case 'app.globalSearch':
      actions.toggleGlobalSearch()
      return true

    default: {
      const view = VIEW_COMMANDS[command]
      if (!view) return false
      actions.setView(view)
      return true
    }
  }
}
