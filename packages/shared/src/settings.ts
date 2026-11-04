// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/** 界面主题 */
export type ThemeMode = 'light' | 'dark' | 'system'

/** 语言 */
export type Language = 'zh-CN' | 'en-US'

/** 应用级设置 */
export interface AppSettings {
  theme: ThemeMode
  language: Language
  /** 启动时打开上次的会话 */
  restoreLastSession: boolean
  /** 关闭窗口时最小化到托盘而非退出 */
  minimizeToTray: boolean
  /** 托盘图标 */
  showTrayIcon: boolean
  /** 检查更新 */
  autoCheckUpdate: boolean
  /** 更新通道 */
  updateChannel: 'stable' | 'beta' | 'dev'
  /** 匿名使用统计（默认关闭） */
  telemetry: boolean
}

/** 终端外观与行为 */
export interface TerminalSettings {
  fontFamily: string
  fontSize: number
  lineHeight: number
  letterSpacing: number
  cursorStyle: 'block' | 'underline' | 'bar'
  cursorBlink: boolean
  /** 选中即复制 */
  copyOnSelect: boolean
  /** 右键粘贴 */
  rightClickPaste: boolean
  /** 滚动回看行数 */
  scrollback: number
  /** 自动换行 */
  wrapLines: boolean
  /** 响铃 */
  bell: 'none' | 'sound' | 'visual'
  /** 默认编码 */
  defaultEncoding: string
  /** 配色主题 id */
  colorScheme: string
  /** 终端内超链接可点击 */
  linkDetection: boolean
}

/** 补全系统设置 */
export interface CompletionSettings {
  enabled: boolean
  /** 命令语料补全 */
  specCompletion: boolean
  /** 历史命令补全 */
  historyCompletion: boolean
  /** 脚本生成式补全（Beta，会起后台进程） */
  generatorCompletion: boolean
  /** 使用 AI 建议（`??` 前缀） */
  aiSuggestion: boolean
  /** 输入防抖（ms） */
  debounceMs: number
  /** 候选条数上限 */
  maxSuggestions: number
}

/** 高亮规则（正则引擎） */
export interface HighlightRule {
  id: string
  name: string
  /** 正则（字符串形式，运行时编译） */
  pattern: string
  flags?: string
  foreground?: string
  background?: string
  bold?: boolean
  italic?: boolean
  underline?: boolean
  /** 数值越大优先级越高 */
  priority: number
  enabled: boolean
  /** 是否内置预设（内置项不可删除） */
  builtin?: boolean
}

/** AI 供应商配置（BYO-key） */
export interface AiProviderConfig {
  id: string
  name: string
  /** 兼容接口类型 */
  kind: 'openai' | 'anthropic'
  baseUrl: string
  apiKey?: string
  model: string
  /** 是否启用扩展思考 */
  extendedThinking?: boolean
  /** 温度 */
  temperature?: number
  maxTokens?: number
}

/** AI 助手行为设置 */
export interface AiSettings {
  providers: AiProviderConfig[]
  /** 当前使用的供应商 id */
  activeProviderId?: string
  /** 交互模式 */
  mode: 'chat' | 'assistant' | 'confirm' | 'thinking'
  /** 是否允许执行命令 */
  allowExecution: boolean
  /** 允许执行时的风险策略 */
  riskPolicy: {
    /** 直接执行的只读命令白名单（前缀匹配） */
    readOnlyAllowlist: string[]
    /** 需二次确认的命令黑名单 */
    dangerousDenylist: string[]
    /** 需要 sudo 时单独确认 */
    confirmSudo: boolean
  }
  /** 执行上限（防止失控） */
  limits: {
    maxRounds: number
    maxCommands: number
    maxTargets: number
  }
}

/** 文件传输设置 */
export interface TransferSettings {
  /** 单连接并发传输数 */
  maxInflightPerConnection: number
  /** 进度事件节流（ms） */
  progressThrottleMs: number
  /** 覆盖策略 */
  conflictPolicy: 'ask' | 'overwrite' | 'skip' | 'rename'
  /** 保留文件权限 */
  preservePermissions: boolean
  /** 保留时间戳 */
  preserveTimestamps: boolean
}

/** 快捷键绑定 */
export interface HotkeyBinding {
  id: string
  /** 命令 id（动作名） */
  command: string
  /** Electron accelerator 语法，如 'Ctrl+Shift+T' */
  accelerator?: string
  /** 是否注册为全局快捷键（应用未聚焦也生效） */
  global: boolean
  enabled: boolean
}

/** 同步设置（自建后端，零知识） */
export interface SyncSettings {
  enabled: boolean
  /** 后端地址 */
  endpoint?: string
  /** 访问令牌（本地加密存放） */
  token?: string
  /** 自动同步 */
  autoSync: boolean
  /** 冲突策略 */
  conflictPolicy: 'keep-local' | 'keep-remote' | 'keep-newest' | 'ask'
  /** 同步哪些实体 */
  scopes: {
    connections: boolean
    groups: boolean
    credentials: boolean
    notes: boolean
    settings: boolean
  }
}

/** 设置总集 */
export interface Settings {
  app: AppSettings
  terminal: TerminalSettings
  completion: CompletionSettings
  highlights: HighlightRule[]
  ai: AiSettings
  transfer: TransferSettings
  hotkeys: HotkeyBinding[]
  sync: SyncSettings
}

/** 设置键路径（用于 get/set 单点读写），形如 'terminal.fontSize' */
export type SettingsPath = string
