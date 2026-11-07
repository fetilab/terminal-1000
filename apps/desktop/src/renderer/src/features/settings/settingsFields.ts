// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 设置字段的**声明式**描述。
 *
 * 设置项有几十个，但形态只有「开关 / 下拉 / 数字 / 文本」四种。
 * 与其为每一项手写 JSX，不如把「路径 + 标签 + 形态」声明成数据，
 * 由一个通用渲染器统一渲染 —— 新增设置项只需加一行。
 *
 * `path` 就是 `settings.set` 需要的点分路径，直接透传，不做二次映射。
 */

import type { Settings } from '@t1000/shared'
import type { SettingsSectionId } from '../../lib/store'

/** 分区联合类型定义在 lib/store（唯一真源），这里只是别名，避免两份定义漂移 */
export type SettingsSection = SettingsSectionId

export interface SelectOption {
  value: string
  label: string
}

export interface FieldDef {
  /** 点分路径，如 'terminal.fontSize' */
  path: string
  label: string
  hint?: string
  kind: 'text' | 'number' | 'switch' | 'select'
  options?: readonly SelectOption[]
  min?: number
  max?: number
  step?: number
  /** 占满两列（长文本、字体名这类） */
  wide?: boolean
  /** 危险/需要强调说明的项 */
  caution?: boolean
}

const THEME_OPTIONS: readonly SelectOption[] = [
  { value: 'system', label: '跟随系统' },
  { value: 'dark', label: '深色' },
  { value: 'light', label: '浅色' },
]

const ENCODINGS = ['utf-8', 'gbk', 'gb18030', 'big5', 'latin1', 'euc-jp', 'shift_jis'] as const

export const SECTION_META: Record<SettingsSection, { label: string; icon: string; blurb: string }> = {
  app: { label: '外观与通用', icon: 'eye', blurb: '主题、语言与启动行为' },
  terminal: { label: '终端行为', icon: 'terminal', blurb: '字体、光标、回看与编码' },
  highlights: { label: '高亮规则', icon: 'zap', blurb: '正则规则，命中的文本按规则着色' },
  hotkeys: { label: '快捷键', icon: 'sliders', blurb: '应用内与全局快捷键绑定' },
  completion: { label: '命令补全', icon: 'list', blurb: '补全来源、防抖与候选上限' },
  ai: { label: 'AI 助手', icon: 'activity', blurb: '交互模式、风险策略与执行上限' },
  transfer: { label: '文件传输', icon: 'download', blurb: '并发闸门、进度节流与冲突策略' },
  sync: { label: '同步与云端', icon: 'cloud', blurb: '零知识同步的开关与范围' },
}

export const SETTINGS_FIELDS: Record<Exclude<SettingsSection, 'highlights' | 'hotkeys'>, readonly FieldDef[]> = {
  app: [
    { path: 'app.theme', label: '主题', kind: 'select', options: THEME_OPTIONS, hint: '浅色主题仍在打磨中' },
    {
      path: 'app.language',
      label: '界面语言',
      kind: 'select',
      options: [
        { value: 'zh-CN', label: '简体中文' },
        { value: 'en-US', label: 'English' },
      ],
      hint: '目前界面文案为中文，多语言资源尚未接入',
    },
    { path: 'app.restoreLastSession', label: '启动时恢复上次会话', kind: 'switch', hint: '只恢复界面状态，不会自动重连主机' },
    { path: 'app.minimizeToTray', label: '关闭窗口时最小化到托盘', kind: 'switch' },
    { path: 'app.showTrayIcon', label: '显示托盘图标', kind: 'switch' },
    { path: 'app.autoCheckUpdate', label: '自动检查更新', kind: 'switch' },
    {
      path: 'app.updateChannel',
      label: '更新通道',
      kind: 'select',
      options: [
        { value: 'stable', label: '稳定版' },
        { value: 'beta', label: '测试版' },
        { value: 'dev', label: '开发版' },
      ],
    },
    {
      path: 'app.telemetry',
      label: '匿名使用统计',
      kind: 'switch',
      hint: '默认关闭（隐私优先）。开启后也只上报聚合计数，不含命令与地址。',
    },
  ],

  terminal: [
    {
      path: 'terminal.fontFamily',
      label: '字体',
      kind: 'text',
      wide: true,
      hint: 'CSS font-family 列表，按顺序回退',
    },
    { path: 'terminal.fontSize', label: '字号 (px)', kind: 'number', min: 8, max: 32, step: 1 },
    { path: 'terminal.lineHeight', label: '行高倍数', kind: 'number', min: 1, max: 2, step: 0.05 },
    { path: 'terminal.letterSpacing', label: '字距 (px)', kind: 'number', min: -2, max: 4, step: 0.5 },
    {
      path: 'terminal.cursorStyle',
      label: '光标形状',
      kind: 'select',
      options: [
        { value: 'block', label: '方块' },
        { value: 'underline', label: '下划线' },
        { value: 'bar', label: '竖线' },
      ],
    },
    { path: 'terminal.cursorBlink', label: '光标闪烁', kind: 'switch' },
    { path: 'terminal.copyOnSelect', label: '选中即复制', kind: 'switch' },
    { path: 'terminal.rightClickPaste', label: '右键粘贴', kind: 'switch' },
    { path: 'terminal.scrollback', label: '回看行数', kind: 'number', min: 100, max: 200000, step: 1000, hint: '越大越占内存' },
    { path: 'terminal.wrapLines', label: '自动换行', kind: 'switch' },
    {
      path: 'terminal.bell',
      label: '响铃',
      kind: 'select',
      options: [
        { value: 'none', label: '不响' },
        { value: 'sound', label: '声音' },
        { value: 'visual', label: '视觉闪烁' },
      ],
    },
    {
      path: 'terminal.defaultEncoding',
      label: '默认编码',
      kind: 'select',
      options: ENCODINGS.map((e) => ({ value: e, label: e })),
    },
    { path: 'terminal.colorScheme', label: '配色主题', kind: 'text', hint: '内置 default-dark；自定义主题后续接入' },
    { path: 'terminal.linkDetection', label: '识别终端内链接', kind: 'switch' },
  ],

  completion: [
    { path: 'completion.enabled', label: '启用补全', kind: 'switch' },
    { path: 'completion.specCompletion', label: '命令语料补全', kind: 'switch' },
    { path: 'completion.historyCompletion', label: '历史命令补全', kind: 'switch' },
    {
      path: 'completion.generatorCompletion',
      label: '动态生成式补全（Beta）',
      kind: 'switch',
      caution: true,
      hint: '会在后台起进程（如 cd 后列目录），默认关闭',
    },
    { path: 'completion.aiSuggestion', label: '使用 AI 建议（?? 前缀）', kind: 'switch' },
    { path: 'completion.debounceMs', label: '输入防抖 (ms)', kind: 'number', min: 0, max: 1000, step: 10 },
    { path: 'completion.maxSuggestions', label: '候选上限', kind: 'number', min: 1, max: 100, step: 1 },
  ],

  ai: [
    {
      path: 'ai.mode',
      label: '交互模式',
      kind: 'select',
      options: [
        { value: 'chat', label: '只聊天' },
        { value: 'assistant', label: '自动协助' },
        { value: 'confirm', label: '每步确认' },
        { value: 'thinking', label: '扩展思考' },
      ],
    },
    {
      path: 'ai.allowExecution',
      label: '允许执行命令',
      kind: 'switch',
      caution: true,
      hint: '安全默认：关闭。关闭时助手只给建议，不会在远端执行任何命令。',
    },
    { path: 'ai.riskPolicy.confirmSudo', label: 'sudo 需单独确认', kind: 'switch' },
    { path: 'ai.limits.maxRounds', label: '对话轮数上限', kind: 'number', min: 1, max: 200, step: 1 },
    { path: 'ai.limits.maxCommands', label: '累计命令数上限', kind: 'number', min: 1, max: 1000, step: 1 },
    { path: 'ai.limits.maxTargets', label: '涉及主机数上限', kind: 'number', min: 1, max: 100, step: 1 },
  ],

  transfer: [
    {
      path: 'transfer.maxInflightPerConnection',
      label: '单连接并发传输数',
      kind: 'number',
      min: 1,
      max: 16,
      step: 1,
      hint: '并发越高越吃带宽与远端句柄',
    },
    { path: 'transfer.progressThrottleMs', label: '进度事件节流 (ms)', kind: 'number', min: 50, max: 2000, step: 50 },
    {
      path: 'transfer.conflictPolicy',
      label: '同名冲突处理',
      kind: 'select',
      options: [
        { value: 'ask', label: '每次询问' },
        { value: 'overwrite', label: '覆盖' },
        { value: 'skip', label: '跳过' },
        { value: 'rename', label: '重命名保留两者' },
      ],
    },
    { path: 'transfer.preservePermissions', label: '保留文件权限', kind: 'switch' },
    { path: 'transfer.preserveTimestamps', label: '保留时间戳', kind: 'switch' },
  ],

  sync: [
    { path: 'sync.enabled', label: '启用同步', kind: 'switch', hint: '服务端只存密文，密钥不出本机（零知识）' },
    { path: 'sync.autoSync', label: '自动同步', kind: 'switch' },
    { path: 'sync.endpoint', label: '后端地址', kind: 'text', wide: true },
    {
      path: 'sync.conflictPolicy',
      label: '冲突策略',
      kind: 'select',
      options: [
        { value: 'keep-newest', label: '保留较新' },
        { value: 'keep-local', label: '保留本地' },
        { value: 'keep-remote', label: '保留远端' },
        { value: 'ask', label: '每次询问' },
      ],
    },
    { path: 'sync.scopes.connections', label: '同步连接', kind: 'switch' },
    { path: 'sync.scopes.groups', label: '同步分组', kind: 'switch' },
    { path: 'sync.scopes.credentials', label: '同步凭证', kind: 'switch' },
    { path: 'sync.scopes.notes', label: '同步笔记', kind: 'switch' },
    { path: 'sync.scopes.settings', label: '同步设置', kind: 'switch' },
  ],
}

/** 读取点分路径的值（与主进程 getPath 同语义，仅用于展示） */
export function readPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj
  for (const part of path.split('.')) {
    if (typeof cur !== 'object' || cur === null) return undefined
    cur = (cur as Record<string, unknown>)[part]
  }
  return cur
}

/** 供「AI 供应商」等结构化区块做只读摘要 */
export function summarizeAi(settings: Settings): string {
  const providers = settings.ai.providers
  if (providers.length === 0) return '未配置任何供应商（BYO-key，密钥只存本机）'
  const active = providers.find((p) => p.id === settings.ai.activeProviderId)
  return `${providers.length} 个供应商${active ? `，当前使用「${active.name}」（${active.kind} · ${active.model}）` : ''}`
}
