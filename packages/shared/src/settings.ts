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
  /**
   * 有新版本时的提示方式。
   *
   * 与 `autoCheckUpdate` 的关系：后者决定**检查不检查**，本项决定**检查到之后怎么提示**。
   * 因此"不检查更新"= `autoCheckUpdate: false`；本项在那种情况下无意义。
   *
   * - `prompt`：有更新就提示（默认）
   * - `silent`：只记录，不打扰（用户主动去"检查更新"时才看得到）
   */
  updatePromptMode: 'prompt' | 'silent'
  /** 匿名使用统计（默认关闭） */
  telemetry: boolean
  /** 开机自启（登录时启动） */
  openAtLogin: boolean
  /** 关闭窗口前二次确认 */
  confirmOnClose: boolean
  /**
   * 硬件加速（重启生效）。
   *
   * 注意：`app.disableHardwareAcceleration()` **必须在应用 ready 之前调用**，
   * 所以它在启动最早期被读取并应用（见 main/index.ts），运行时改动只能等下次启动。
   */
  hardwareAcceleration: boolean
  /** 每日自动备份（保留 N 天，见 security.backupRetentionDays） */
  dailyBackup: boolean
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
  /**
   * 中键粘贴（X11 PRIMARY selection）。
   *
   * 与 kitty 的 `middle release ungrabbed paste_from_selection` 默认映射一致：
   * X11 上中键粘贴是几十年来的肌肉记忆，**默认开启**；不想要的（尤其是会
   * 误触中键的触控板用户）在这里关掉。
   */
  middleClickPaste: boolean
  /**
   * 有选区时 `Ctrl+C` 复制（而不是发 SIGINT）。
   *
   * **默认关闭**：`Ctrl+C` 首先属于终端里的程序（中断）。Windows Terminal 与
   * VS Code 会「有选区就复制」，但那会让习惯了 SIGINT 的人（vim、make、ssh）
   * 偶尔复制到半截内容却中断不了任务 —— 这种抢占必须是用户自己选的。
   */
  copyOnCtrlC: boolean
  /**
   * `Ctrl+V` 直接粘贴。
   *
   * **默认关闭**：Linux 上 `Ctrl+V` 是 vim 的块选择、emacs 的 quoted-insert，
   * 抢走会让这些程序用不了。想要 Windows Terminal 的手感再打开。
   */
  pasteOnCtrlV: boolean
  /** 滚动回看行数 */
  scrollback: number
  /**
   * 行间斑马纹（交替行底色）。
   *
   * 仅 **DOM 渲染器**能实现（canvas/webgl 把整屏画在位图上，没有逐行元素）；
   * 渲染层会做运行时检测，不支持时如实提示而不是让开关点了没反应。
   */
  zebraStripes: boolean
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

  // ── 渲染与美化（0.2.0 起） ─────────────────────────────

  /**
   * 渲染后端。
   *
   * - `kitty`：kitty 的 VT 内核（kitty-vt-wasm，在 Worker 里跑）+ 自绘 WebGL2 渲染器；
   * - `xterm`：旧的 xterm.js 引擎，作为兜底保留（WebGL 不可用/内核加载失败时自动回落）。
   */
  renderer: 'kitty' | 'xterm'
  /** 常规字重（100–900，实际效果取决于字体是否有对应字面） */
  fontWeight: number
  /** 粗体字重 */
  boldWeight: number
  /** OpenType 特性，例如 `ss01`、`calt`、`zero` */
  fontFeatures: string[]
  /** 连字（`liga`/`calt`）。仅 kitty 渲染器生效，按「整行同一样式」成段成形 */
  ligatures: boolean
  /** 终端内边距（CSS px，四边相同） */
  padding: number
  /** 背景不透明度（0–1，1 = 不透明） */
  backgroundOpacity: number
  /** 光标不透明度（0–1） */
  cursorOpacity: number
  /** 失焦时的光标形状 */
  cursorInactiveStyle: 'outline' | 'block' | 'beam' | 'underline' | 'none'
  /** 滚轮倍率（一格滚几行） */
  wheelMultiplier: number
  /** 选区背景色 `#RRGGBB` */
  selectionBackground: string
  /** 选区前景色 `#RRGGBB` */
  selectionForeground: string
  /** 下划线颜色 `#RRGGBB`；空串表示跟随前景色 */
  underlineColor: string
  /** kitty 图形协议（在终端里显示图片） */
  kittyGraphics: boolean
  /**
   * 光标拖尾（kitty `cursor_trail`）。
   *
   * 光标平滑滑向新位置，跨格移动（≥2 格）时在途经位置留下一串渐隐残影。
   * 0 = 关闭；推荐 3（kitty 默认也是 3 档深度）。仅 kitty 渲染器生效。
   */
  /** kitty cursor_trail：光标停留 N 毫秒后拖尾开始追赶（0 关闭） */
  cursorTrail: number
  /** 16 色调色板，`#RRGGBB` × 16（顺序同 ANSI：black,red,green,yellow,blue,magenta,cyan,white, bright×8） */
  palette: string[]
  /**
   * 向 PTY 申请的 `TERM`。
   *
   * `xterm-kitty` 才会让远端启用 kitty 键盘协议（CSI u）与图形协议；
   * 兼容性优先时可退回 `xterm-256color`。
   */
  termType: string
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
  /**
   * 传输方式。**必须显式选择，不做自动回退** —— 见 `docs/SYNC-SECURE-CHANNEL.md` §3.3.1。
   *
   * 理由：只要允许"TSC/1 失败就退回明文 HTTP"，攻击者只需阻断握手即可降级成功，
   * 整个加密层就只是装饰；而且那是**静默失败**（用户以为在加密通道里）。
   *
   * - `tsc1`：加密通道（公网直连的唯一正确选择）
   * - `http`：明文，**仅允许用于回环**（本机开发/兼容）
   */
  transport?: 'http' | 'tsc1'
  /**
   * TSC/1 服务端钉扎（首次连接由用户**显式确认**指纹后写入）。
   *
   * 两个字段都要：`fingerprint` 用于可读比对，`publicKey` 用于验签 ——
   * 只比指纹不够（验签用的是对端出示的公钥）。见 `services/sync/channel.ts` 的注释。
   */
  /**
   * 显式 `null` 表示"已清除钉扎"。
   *
   * 设置深合并会跳过 `undefined`，因此清除必须写 `null` ——
   * 写 `undefined` 会让旧钉扎继续生效。
   */
  pin?: { fingerprint: string; publicKey: string } | null
  /** 访问令牌（本地加密存放） */
  token?: string
  /**
   * 同步口令（即「仓库密码」）。
   *
   * **必须与访问口令分开**：添加了新设备时，新设备只需要这个口令就能解密
   * 云端数据，而不需要知道登录口令；反之重置登录口令也不影响已有数据。
   *
   * 它同样以主密码加密后存放（不要明文落盘）。
   */
  passphrase?: string
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
/**
 * 会话录制设置。
 *
 * 注意 `enabled` **默认 false**：录制产物会原样落盘终端输出（可能含口令、token），
 * 不能默认替用户开启。
 */
export interface RecordingSettings {
  /** 是否录制（默认 false） */
  enabled: boolean
  /** 快照间隔（ms）。**最小 1000**，小于则被抬到 1000 */
  intervalMs: number
  /** 结束录制时自动 gzip 压缩（实测可减少约 89% 体积） */
  autoCompress: boolean
}

/** 回放的一帧：距录制开始的毫秒偏移 + 该时刻的输出增量 */
export interface ReplayFrame {
  tMs: number
  data: string
}

/**
 * 回放数据。
 *
 * ⚠️ 我们存的是**带时间戳的输出流**而非屏幕快照（主进程没有 VT 仿真器），
 * 屏幕由渲染层的 xterm 重放得到 —— 因此**拖拽跳转是"从 0 快速重放到目标点"，
 * 不是 O(1) 取快照**。UI 不要假设能瞬间跳到任意位置。
 */
export interface SessionLogReplay {
  logId: string
  frames: ReplayFrame[]
  fromMs: number
  toMs: number | null
  /** 整场录制的总时长（ms），用于进度条 */
  totalMs: number
  frameCount: number
  hasMore: boolean
  intervalMs: number
  /** 录制时的终端尺寸（播放前应先 resize，否则重排会不一致） */
  cols?: number
  rows?: number
  /** 是否已 gzip（主进程透明解压，UI 不用管） */
  compressed: boolean
  path: string
}

/** 一次录制的摘要（列表用） */
export interface RecordingSummary {
  logId: string
  sessionId: string
  title: string
  startedAt: string
  stoppedAt?: string
  stopReason?: string
  /** 文本日志字节数 */
  sizeBytes: number
  hasTiming: boolean
  hasRecording: boolean
  /** 快照文件字节数（压缩后为 .gz 大小） */
  recBytes?: number
  gzBytes?: number
  compressed?: boolean
  frames?: number
  /** 与上一帧相同而被跳过的 tick 数（增量录制省下来的量） */
  skippedTicks?: number
}

/**
 * 安全与锁屏设置。
 */
export interface SecuritySettings {
  /**
   * 空闲多少分钟后自动锁定。0 = 不自动锁。
   *
   * 允许值按 spec 为 1 / 5 / 15 / 30（0 表示关闭）。
   * 判定用 `powerMonitor.getSystemIdleTime()`（系统级空闲），
   * 而不是自己在渲染层数事件 —— 后者在窗口失焦时就不准了。
   */
  autoLockMinutes: 0 | 1 | 5 | 15 | 30
  /** 备份保留天数（配合 app.dailyBackup） */
  backupRetentionDays: number
}

export interface Settings {
  app: AppSettings
  terminal: TerminalSettings
  completion: CompletionSettings
  highlights: HighlightRule[]
  ai: AiSettings
  transfer: TransferSettings
  hotkeys: HotkeyBinding[]
  /** 会话录制（快照间隔 / 自动压缩 / 是否录制） */
  sessionRecording?: RecordingSettings
  /** 安全与锁屏 */
  security?: SecuritySettings
  sync: SyncSettings
}

/** 设置键路径（用于 get/set 单点读写），形如 'terminal.fontSize' */
export type SettingsPath = string
