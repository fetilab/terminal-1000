/**
 * 主进程 → 渲染进程 的流式事件。
 *
 * 事件名统一 SCREAMING_SNAKE，按域前缀。终端输出、传输进度、监控更新
 * 这类高频数据必须走事件（不能走 request/response）。
 */

import type { ConnectionState, TerminalEncoding } from './connection'
import type { MonitorSnapshot } from './monitor'
import type { Settings } from './settings'

/** 事件名常量 */
export const Events = {
  // 应用
  APP_READY: 'APP_READY',
  APP_THEME_CHANGED: 'APP_THEME_CHANGED',

  // SSH 会话
  SSH_STATE: 'SSH_STATE',
  SSH_DATA: 'SSH_DATA',
  SSH_DEBUG: 'SSH_DEBUG',
  SSH_ERROR: 'SSH_ERROR',
  SSH_HOST_KEY_ASK: 'SSH_HOST_KEY_ASK',
  SSH_AUTH_PROMPT: 'SSH_AUTH_PROMPT',
  SSH_AUTH_RESULT: 'SSH_AUTH_RESULT',
  SSH_CLOSED: 'SSH_CLOSED',

  // SFTP
  SFTP_BUSY: 'SFTP_BUSY',
  SFTP_TRANSFER_PROGRESS: 'SFTP_TRANSFER_PROGRESS',
  SFTP_TRANSFER_FINISHED: 'SFTP_TRANSFER_FINISHED',
  SFTP_TRANSFER_ERROR: 'SFTP_TRANSFER_ERROR',
  SFTP_DIR_SCANNED: 'SFTP_DIR_SCANNED',
  SFTP_WATCH_EVENT: 'SFTP_WATCH_EVENT',
  /** Shell Integration：命令开始（OSC 133 B） */
  SHELL_COMMAND_START: 'SHELL_COMMAND_START',
  /** Shell Integration：命令结束（OSC 133 D，带退出码） */
  SHELL_COMMAND_END: 'SHELL_COMMAND_END',
  /** 远端编辑的改动已写回远端 */
  SFTP_EDIT_SAVED: 'SFTP_EDIT_SAVED',
  /** 远端编辑写回/监听失败（必须让用户知道，否则他以为存到远端了） */
  SFTP_EDIT_ERROR: 'SFTP_EDIT_ERROR',

  // 端口转发
  FORWARD_STATE: 'FORWARD_STATE',
  FORWARD_INFO: 'FORWARD_INFO',
  FORWARD_WARN: 'FORWARD_WARN',
  FORWARD_ERROR: 'FORWARD_ERROR',

  // 本地终端
  PTY_DATA: 'PTY_DATA',
  PTY_EXIT: 'PTY_EXIT',

  // 监控
  MONITOR_SNAPSHOT: 'MONITOR_SNAPSHOT',
  MONITOR_STATUS: 'MONITOR_STATUS',
  MONITOR_ERROR: 'MONITOR_ERROR',

  // 快捷键
  HOTKEY_TRIGGERED: 'HOTKEY_TRIGGERED',
  HOTKEY_STATUS: 'HOTKEY_STATUS',

  // 设置
  SETTINGS_CHANGED: 'SETTINGS_CHANGED',

  // Telnet
  TELNET_DATA: 'TELNET_DATA',
  TELNET_STATE: 'TELNET_STATE',
  TELNET_CLOSED: 'TELNET_CLOSED',
  TELNET_NEGOTIATION: 'TELNET_NEGOTIATION',

  // 并发广播
  BROADCAST_STATE: 'BROADCAST_STATE',
  /** 某个成员写入失败（广播的"部分失败"必须让用户看得见） */
  BROADCAST_ERROR: 'BROADCAST_ERROR',

  // 安全 / 锁屏
  SECURITY_LOCKED: 'SECURITY_LOCKED',
  SECURITY_UNLOCKED: 'SECURITY_UNLOCKED',
  /** 备份结果（供界面如实显示成功/失败，而不是静默） */
  BACKUP_RESULT: 'BACKUP_RESULT',

  // VNC（RFB）
  VNC_STATE: 'VNC_STATE',
  VNC_FRAME: 'VNC_FRAME',
  VNC_CLIPBOARD: 'VNC_CLIPBOARD',
  VNC_BELL: 'VNC_BELL',
  VNC_ERROR: 'VNC_ERROR',

  // RDP（外部 FreeRDP 进程方案）
  RDP_STATE: 'RDP_STATE',
  RDP_EXIT: 'RDP_EXIT',

  // AI
  AI_DELTA: 'AI_DELTA',
  AI_TOOL_CALL: 'AI_TOOL_CALL',
  AI_TOOL_RESULT: 'AI_TOOL_RESULT',
  AI_DONE: 'AI_DONE',
  AI_ERROR: 'AI_ERROR',

  // 同步
  SYNC_STATE: 'SYNC_STATE',
  SYNC_PROGRESS: 'SYNC_PROGRESS',
} as const

export type EventName = (typeof Events)[keyof typeof Events]

/** 事件载荷映射 */
export interface EventPayloads {
  [Events.APP_READY]: { version: string; paths: AppPaths }
  [Events.APP_THEME_CHANGED]: { theme: 'light' | 'dark' | 'system' }

  [Events.SSH_STATE]: { sessionId: string; state: ConnectionState; message?: string }
  [Events.SSH_DATA]: { sessionId: string; data: string }
  [Events.SSH_DEBUG]: { sessionId: string; message: string }
  [Events.SSH_ERROR]: { sessionId: string; message: string; code?: string }
  [Events.SSH_HOST_KEY_ASK]: {
    requestId: string
    sessionId: string
    host: string
    port: number
    keyType: string
    fingerprint: string
    /** 是否与已知指纹冲突（可能是中间人） */
    mismatch: boolean
  }
  [Events.SSH_AUTH_PROMPT]: {
    requestId: string
    sessionId: string
    name: string
    instructions: string
    prompts: Array<{ prompt: string; echo: boolean }>
  }
  [Events.SSH_AUTH_RESULT]: { sessionId: string; method: string; success: boolean }
  [Events.SSH_CLOSED]: { sessionId: string; reason?: string; code?: number }

  [Events.SFTP_BUSY]: { sessionId: string; busy: boolean }
  [Events.SFTP_TRANSFER_PROGRESS]: {
    transferId: string
    sessionId: string
    direction: 'upload' | 'download'
    /** 当前文件 */
    file: string
    transferredBytes: number
    totalBytes: number
    /** 目录递归时的整体进度 */
    filesDone?: number
    filesTotal?: number
    /** 速度 B/s */
    speed?: number
  }
  [Events.SFTP_TRANSFER_FINISHED]: {
    transferId: string
    sessionId: string
    direction: 'upload' | 'download'
    files: number
    bytes: number
    durationMs: number
  }
  [Events.SFTP_TRANSFER_ERROR]: { transferId: string; sessionId: string; file?: string; message: string }
  [Events.SFTP_DIR_SCANNED]: { sessionId: string; path: string; files: number; bytes: number }
  [Events.SHELL_COMMAND_START]: {
    sessionId: string
    blockId: number
    commandLine?: string
    startedAt: number
  }
  /**
   * 命令结束。`exitCode` 为 `null` 表示**命令结束但没有退出码**
   * （shell 没发 `D;<n>`）—— 不要把它当成 0，那会把失败当成功。
   */
  [Events.SHELL_COMMAND_END]: {
    sessionId: string
    blockId: number
    exitCode: number | null
    commandLine?: string
    startedAt: number
    endedAt: number
    durationMs: number
  }

  [Events.SFTP_EDIT_SAVED]: {
    editId: string
    sessionId: string
    remotePath: string
    bytes: number
    at: number
    /** auto=本地变更触发；manual=用户显式保存 */
    reason: 'auto' | 'manual'
    /**
     * 远端文件在"物化 → 写回"期间被改过。
     * 我们仍然写（用户的编辑是明确意图），但界面应当提示**可能覆盖了别人的修改**。
     */
    remoteChangedSinceOpen: boolean
  }
  [Events.SFTP_EDIT_ERROR]: {
    editId: string
    sessionId?: string
    remotePath: string
    message: string
  }

  [Events.SFTP_WATCH_EVENT]: {
    sessionId: string
    path: string
    change: 'created' | 'updated' | 'deleted'
  }

  [Events.FORWARD_STATE]: { forwardId: string; state: ConnectionState; message?: string }
  [Events.FORWARD_INFO]: { forwardId: string; message: string }
  [Events.FORWARD_WARN]: { forwardId: string; message: string }
  [Events.FORWARD_ERROR]: { forwardId: string; message: string }

  [Events.TELNET_DATA]: { sessionId: string; data: string }
  [Events.TELNET_STATE]: { sessionId: string; state: ConnectionState; message?: string }
  [Events.TELNET_CLOSED]: { sessionId: string; reason?: string }
  /**
   * 选项协商摘要（诊断用）。
   * Telnet 的"连上却键盘无反应"绝大多数是协商没谈拢；
   * 把协商过程暴露出来能直接定位，而不是靠猜。
   */
  [Events.TELNET_NEGOTIATION]: {
    sessionId: string
    option: number
    optionName: string
    direction: 'local' | 'remote'
    accepted: boolean
    detail?: string
  }

  /** 广播组状态（成员变动 / 模式切换） */
  [Events.BROADCAST_STATE]: { groups: BroadcastGroupView[] }
  /**
   * 广播写入失败。
   *
   * 广播的语义是"一次输入多处执行"，但各成员响应时间与可用性不同 ——
   * **部分失败必须逐条报出来**，不能让用户以为所有服务器都执行了。
   */
  [Events.BROADCAST_ERROR]: {
    groupId: string
    sessionId: string
    title: string
    message: string
  }

  /** 本地库被锁定（自动锁屏或手动）——渲染层据此弹出遮罩 */
  [Events.SECURITY_LOCKED]: {
    /** 锁定原因 */
    reason: 'idle' | 'manual'
    /** 空闲了多少秒（idle 时才有） */
    idleSeconds?: number
  }
  [Events.SECURITY_UNLOCKED]: Record<string, never>
  [Events.BACKUP_RESULT]: {
    ok: boolean
    filePath?: string
    bytes?: number
    /** 本次清理掉的旧备份数 */
    pruned?: number
    message?: string
  }

  [Events.VNC_STATE]: { sessionId: string; state: ConnectionState; message?: string }
  /**
   * 一帧画面更新。
   *
   * RFB 本质是**增量矩形**更新，所以按 rect 列表给而不是整屏 buffer：
   * 只传真正变化的矩形，带宽与渲染成本都更小。
   */
  [Events.VNC_FRAME]: {
    sessionId: string
    /** 远端完整画面尺寸（缩放/裁剪由渲染层决定） */
    framebufferWidth: number
    framebufferHeight: number
    rects: Array<{
      x: number
      y: number
      width: number
      height: number
      /** 32bpp little-endian BGRA 的 base64（redShift=16 / greenShift=8 / blueShift=0） */
      pixels?: string
      /**
       * CopyRect：源矩形左上角。
       * 后端**不持有帧缓冲**，所以搬运必须由渲染层在自己画布上完成 ——
       * 这也是 RFB 的设计本意。
       */
      copyFrom?: { x: number; y: number }
    }>
  }
  [Events.VNC_CLIPBOARD]: { sessionId: string; text: string }
  [Events.VNC_BELL]: { sessionId: string }
  [Events.VNC_ERROR]: { sessionId: string; message: string }

  [Events.RDP_STATE]: { sessionId: string; state: ConnectionState; message?: string }
  [Events.RDP_EXIT]: {
    sessionId: string
    code: number | null
    signal: string | null
    /** 非正常退出（用于区分"用户关窗口"与"崩了"） */
    crashed: boolean
  }

  /** 快捷键被触发：渲染层据此执行对应命令 */
  [Events.HOTKEY_TRIGGERED]: {
    bindingId: string
    command: string
    /** 触发来源：全局快捷键（应用未聚焦也生效）还是应用内按键 */
    source: 'global' | 'in-app'
  }
  /** 注册状态变更（占用冲突等），用于设置界面如实展示 */
  [Events.HOTKEY_STATUS]: { registrations: HotkeyRegistration[] }

  /**
   * 设置变更广播：任何写方（设置界面、其它服务、迁移）改完设置都发。
   * 渲染层据此热更新 store —— 没有它，绕过设置界面直接 IPC 写设置
   * （同步、自动化探针、未来的 MCP 工具）时已打开的终端不会收到新值。
   */
  [Events.SETTINGS_CHANGED]: { path: string; settings: Settings }

  [Events.PTY_DATA]: { ptyId: string; data: string }
  [Events.PTY_EXIT]: { ptyId: string; exitCode: number; signal?: number }

  [Events.MONITOR_SNAPSHOT]: { sessionId: string; snapshot: MonitorSnapshot }
  [Events.MONITOR_STATUS]: { sessionId: string; status: 'starting' | 'running' | 'paused' | 'stopped'; message?: string }
  [Events.MONITOR_ERROR]: { sessionId: string; message: string }

  [Events.AI_DELTA]: { chatId: string; messageId: string; text: string }
  [Events.AI_TOOL_CALL]: { chatId: string; messageId: string; tool: string; args: unknown }
  [Events.AI_TOOL_RESULT]: { chatId: string; messageId: string; tool: string; result: unknown; isError?: boolean }
  [Events.AI_DONE]: { chatId: string; messageId: string; usage?: { inputTokens?: number; outputTokens?: number } }
  [Events.AI_ERROR]: { chatId: string; message: string }

  [Events.SYNC_STATE]: { state: 'idle' | 'syncing' | 'offline' | 'error'; message?: string }
  [Events.SYNC_PROGRESS]: { phase: 'push' | 'pull'; done: number; total: number }
}

/** 广播组成员（给 UI 的视图） */
export interface BroadcastMemberView {
  sessionId: string
  kind: 'ssh' | 'pty' | 'telnet'
  title: string
  /** 当前是否可写；false 时 UI 应标灰并说明原因 */
  writable: boolean
}

/** 广播组（给 UI 的视图） */
export interface BroadcastGroupView {
  groupId: string
  name: string
  mode: 'independent' | 'broadcast'
  members: BroadcastMemberView[]
  createdAt: string
}

/** 快捷键注册状态（供设置界面如实显示，而不是假装成功） */
export interface HotkeyRegistration {
  /** HotkeyBinding.id */
  bindingId: string
  /** 命令 id，如 terminal.newTab */
  command: string
  accelerator?: string
  global: boolean
  enabled: boolean
  /** 是否已成功注册到系统/应用 */
  registered: boolean
  /**
   * 注册失败原因。
   * 最常见的是 `accelerator 已被其它程序占用` —— 必须如实告知，
   * 否则用户会以为按了没反应是自己按错了。
   */
  error?: string
}

/** 应用数据目录（由主进程解析后告知渲染进程） */
export interface AppPaths {
  userData: string
  dbFile: string
  notesDir: string
  sessionLogDir: string
  watchDir: string
  bgImagesDir: string
  backupDir: string
  logDir: string
}

/** 终端编码变更事件的便捷类型（供渲染层订阅使用） */
export interface EncodingChange {
  sessionId: string
  encoding: TerminalEncoding
}
