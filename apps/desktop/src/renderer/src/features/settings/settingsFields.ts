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
import { THEME_PRESETS } from '../../theme/presets'

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

export const SECTION_META: Record<SettingsSection, { label: string; icon: string; blurb: string }> = {
  app: { label: '外观与通用', icon: 'eye', blurb: '主题、语言与启动行为' },
  terminal: { label: '终端行为', icon: 'terminal', blurb: '复制粘贴、回看、响铃与链接' },
  termStyle: { label: '终端美化', icon: 'palette', blurb: '渲染内核、字体、光标、配色与内边距' },
  highlights: { label: '高亮规则', icon: 'zap', blurb: '正则规则，命中的文本按规则着色' },
  hotkeys: { label: '快捷键', icon: 'sliders', blurb: '应用内与全局快捷键绑定' },
  completion: { label: '命令补全', icon: 'list', blurb: '补全来源、防抖与候选上限' },
  ai: { label: 'AI 助手', icon: 'activity', blurb: '交互模式、风险策略与执行上限' },
  transfer: { label: '文件传输', icon: 'download', blurb: '并发闸门、进度节流与冲突策略' },
  sync: { label: '同步与云端', icon: 'cloud', blurb: '零知识同步的开关与范围' },
  // 命名刻意与 vault 的「存储与安全」区分：这里只管**锁定行为与备份保留**，
  // vault 管**主密码与加解密**。两者混在一个分区里会让用户找不到东西。
  security: { label: '锁定与备份', icon: 'clock', blurb: '空闲自动锁定与备份保留' },
  vault: { label: '存储与安全', icon: 'lock', blurb: '主密码、凭据加密与锁定' },
}

export const SETTINGS_FIELDS: Record<
  Exclude<SettingsSection, 'highlights' | 'hotkeys' | 'vault'>,
  readonly FieldDef[]
> = {
  app: [
    { path: 'app.theme', label: '主题', kind: 'select', options: THEME_OPTIONS, hint: '跟随系统明暗，或固定深浅' },
    {
      path: 'app.appearance.preset',
      label: '配色预设',
      kind: 'select',
      options: THEME_PRESETS.map((p) => ({ value: p.id, label: p.label })),
      hint: '在明暗之上再叠一套自研配色；默认「冷青」与历史观感一致',
    },
    {
      path: 'app.appearance.backgroundImage',
      label: '背景图',
      kind: 'text',
      wide: true,
      hint: '本地图片绝对路径（也可用 file:/data: 链接）。刻意不支持 http(s)：背景图不应发起外部请求',
    },
    {
      path: 'app.appearance.backgroundOpacity',
      label: '背景图可见度',
      kind: 'number',
      min: 0,
      max: 1,
      step: 0.05,
      hint: '仅在设置了背景图时生效',
    },
    {
      path: 'app.appearance.opacity',
      label: '界面不透明度',
      kind: 'number',
      min: 0.5,
      max: 1,
      step: 0.05,
      hint: '越低，背景图透出越多；1 = 实心',
    },
    {
      path: 'app.appearance.scale',
      label: '界面缩放',
      kind: 'number',
      min: 0.8,
      max: 1.4,
      step: 0.05,
      hint: '整体放大/缩小界面（0.8 ~ 1.4）',
    },
    { path: 'app.restoreLastSession', label: '启动时恢复上次会话', kind: 'switch', hint: '只恢复界面状态，不会自动重连主机' },
    { path: 'app.minimizeToTray', label: '关闭窗口时最小化到托盘', kind: 'switch' },
    { path: 'app.showTrayIcon', label: '显示托盘图标', kind: 'switch' },
    { path: 'app.autoCheckUpdate', label: '自动检查更新', kind: 'switch', hint: '启动时检查；关闭后完全不再检查' },
    {
      path: 'app.updatePromptMode',
      label: '有新版本时',
      kind: 'select',
      hint: '仅在上面开启"自动检查更新"时有意义',
      options: [
        { value: 'prompt', label: '提示我' },
        { value: 'silent', label: '静默（我自己去看）' },
      ],
    },
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
    { path: 'app.openAtLogin', label: '开机自启', kind: 'switch', hint: '登录系统时自动启动' },
    { path: 'app.confirmOnClose', label: '关闭窗口前确认', kind: 'switch', hint: '避免误关' },
    {
      path: 'app.hardwareAcceleration',
      label: '硬件加速',
      kind: 'switch',
      hint: '关闭可解决个别显卡/驱动的花屏问题；**需重启生效**（画面变慢是正常代价）',
    },
    {
      path: 'app.dailyBackup',
      label: '每日自动备份',
      kind: 'switch',
      hint: '需要本地库已解锁；备份保留天数见「安全与锁屏」',
    },
  ],

  security: [
    {
      path: 'security.autoLockMinutes',
      label: '空闲自动锁定',
      kind: 'select',
      hint: '按**系统级空闲**判定 —— 离开电脑（哪怕窗口失焦）也会计时',
      options: [
        { value: '0', label: '不自动锁定' },
        { value: '1', label: '1 分钟' },
        { value: '5', label: '5 分钟' },
        { value: '15', label: '15 分钟' },
        { value: '30', label: '30 分钟' },
      ],
    },
    {
      path: 'security.backupRetentionDays',
      label: '备份保留天数',
      kind: 'number',
      hint: '超过天数的自动备份会被清理（只清理本应用生成的备份文件）',
    },
  ],

  terminal: [
    { path: 'terminal.copyOnSelect', label: '选中即复制', kind: 'switch' },
    { path: 'terminal.rightClickPaste', label: '右键粘贴', kind: 'switch' },
    { path: 'terminal.scrollback', label: '回看行数', kind: 'number', min: 100, max: 200000, step: 1000, hint: '越大越占内存' },
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
    { path: 'terminal.linkDetection', label: '识别终端内链接', kind: 'switch' },
  ],

  // 0.2.0 新增：终端美化独立分区。视觉相关的所有项都收拢在这里，
  // 改任何一项都会热更新到已打开的终端，无需重连。
  termStyle: [
    {
      path: 'terminal.renderer',
      label: '渲染内核',
      kind: 'select',
      caution: true,
      options: [
        { value: 'kitty', label: 'kitty 内核 + WebGL2（默认）' },
        { value: 'xterm', label: '传统 xterm' },
      ],
      hint: 'kitty 内核支持 Kitty 键盘/图形协议与五种下划线样式；个别环境渲染异常时自动回落 xterm，也可在此手动切回',
    },
    { path: 'terminal.fontFamily', label: '字体', kind: 'text', wide: true, hint: 'CSS font-family 列表，按顺序回退；emoji/Nerd Font 由系统自动补齐' },
    { path: 'terminal.fontSize', label: '字号 (px)', kind: 'number', min: 8, max: 32, step: 1 },
    { path: 'terminal.lineHeight', label: '行高倍数', kind: 'number', min: 1, max: 2, step: 0.05 },
    { path: 'terminal.letterSpacing', label: '字距 (px)', kind: 'number', min: -2, max: 4, step: 0.5 },
    { path: 'terminal.fontWeight', label: '常规字重', kind: 'number', min: 100, max: 900, step: 50, hint: '可变字体生效；静态字体只有 400/700 两档' },
    { path: 'terminal.boldWeight', label: '粗体字重', kind: 'number', min: 100, max: 900, step: 50 },
    { path: 'terminal.ligatures', label: '连字', kind: 'switch', hint: '-> => != === 等自动成形；仅 kitty 内核' },
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
    {
      path: 'terminal.cursorInactiveStyle',
      label: '失焦光标形状',
      kind: 'select',
      options: [
        { value: 'outline', label: '空心' },
        { value: 'block', label: '方块' },
        { value: 'underline', label: '下划线' },
        { value: 'bar', label: '竖线' },
        { value: 'none', label: '隐藏' },
      ],
    },
    { path: 'terminal.cursorBlink', label: '光标闪烁', kind: 'switch' },
    { path: 'terminal.cursorOpacity', label: '光标不透明度', kind: 'number', min: 0.1, max: 1, step: 0.05 },
    {
      path: 'terminal.colorScheme',
      label: '配色主题',
      kind: 'select',
      hint: '内置三套；改完立即生效',
      options: [
        { value: 'default-dark', label: '深色（默认）' },
        { value: 'light', label: '浅色' },
        { value: 'high-contrast', label: '高对比' },
      ],
    },
    { path: 'terminal.padding', label: '内边距 (px)', kind: 'number', min: 0, max: 32, step: 1 },
    { path: 'terminal.backgroundOpacity', label: '终端背景不透明度', kind: 'number', min: 0.1, max: 1, step: 0.05, hint: '调低可透出窗口背景/背景图' },
    { path: 'terminal.selectionBackground', label: '选区底色', kind: 'text', hint: '十六进制颜色，如 #3ec9d6；留空用配色方案默认' },
    { path: 'terminal.selectionForeground', label: '选区文字色', kind: 'text', hint: '留空保持文字原色' },
    { path: 'terminal.underlineColor', label: '下划线颜色', kind: 'text', hint: '留空跟随文字色' },
    { path: 'terminal.wheelMultiplier', label: '滚轮速度', kind: 'number', min: 1, max: 10, step: 1, hint: '每次滚动的行数' },
    { path: 'terminal.zebraStripes', label: '行间斑马纹', kind: 'switch', hint: '交替行浅底色，便于横向读数' },
    { path: 'terminal.kittyGraphics', label: 'Kitty 图形协议', kind: 'switch', hint: '允许远端在终端里显示图片；仅 kitty 内核' },
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
    {
      // 用户语料文件的最小示例（与内置 specs/ 相同的紧凑格式，字段全部可选）：
      // {
      //   "t1000demo": {
      //     "brief": "示例命令",
      //     "category": "system",
      //     "opts": [["--hello", "打招呼"]],
      //     "subs": [["add", "添加一条记录"]]
      //   }
      // }
      path: 'completion.corpusFile',
      label: '补全语料文件',
      kind: 'text',
      wide: true,
      hint:
        '自建命令语料（JSON）的绝对路径，与内置语料合并，同名命令覆盖内置。' +
        '格式：{ "命令名": { "brief": "简述", "category": "files|text|process|network|system|package|container|vcs|security", ' +
        '"opts": [["-l", "长格式"]], "subs": [["add", "说明"]] } }，字段均可选。' +
        '文件缺失或非法时自动只用内置语料，原因会写入日志',
    },
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
    {
      path: 'sync.transport',
      label: '传输方式',
      kind: 'select',
      hint:
        'TSC/1 为加密通道，公网直连必须用它；明文 HTTP 仅允许回环地址，' +
        '指向非回环地址会被拒绝（PLAINTEXT_NOT_ALLOWED）。不提供自动回退。',
      options: [
        { value: 'tsc1', label: 'TSC/1 加密通道（推荐）' },
        { value: 'http', label: '明文 HTTP（仅回环）' },
      ],
    },
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
