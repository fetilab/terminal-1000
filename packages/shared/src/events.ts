/**
 * 主进程 → 渲染进程 的流式事件。
 *
 * 事件名统一 SCREAMING_SNAKE，按域前缀。终端输出、传输进度、监控更新
 * 这类高频数据必须走事件（不能走 request/response）。
 */

import type { ConnectionState, TerminalEncoding } from './connection'
import type { MonitorSnapshot } from './monitor'

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
  [Events.SFTP_WATCH_EVENT]: {
    sessionId: string
    path: string
    change: 'created' | 'updated' | 'deleted'
  }

  [Events.FORWARD_STATE]: { forwardId: string; state: ConnectionState; message?: string }
  [Events.FORWARD_INFO]: { forwardId: string; message: string }
  [Events.FORWARD_WARN]: { forwardId: string; message: string }
  [Events.FORWARD_ERROR]: { forwardId: string; message: string }

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
