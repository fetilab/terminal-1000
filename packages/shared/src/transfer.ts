// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/** 传输方向 */
export type TransferDirection = 'upload' | 'download'

/** 传输任务状态 */
export type TransferState =
  | 'queued'
  | 'scanning'
  | 'running'
  | 'paused'
  | 'cancelling'
  | 'cancelled'
  | 'succeeded'
  | 'failed'

/** 冲突处理策略 */
export type ConflictPolicy = 'ask' | 'overwrite' | 'skip' | 'rename'

/** 单个文件条目 */
export interface TransferFile {
  /** 远端路径 */
  remotePath: string
  /** 本地路径 */
  localPath: string
  size: number
  transferred: number
  state: TransferState
  error?: string
}

/** 一个传输任务（一次上传/下载操作，可能是文件也可能是目录） */
export interface TransferTask {
  id: string
  sessionId: string
  direction: TransferDirection
  state: TransferState
  /** 顶层路径（用户操作的对象） */
  sourcePath: string
  targetPath: string
  createdAt: string
  startedAt?: string
  finishedAt?: string
  /** 是否目录递归 */
  recursive: boolean
  /** 扫描出的文件总数 */
  filesTotal: number
  filesDone: number
  /** 总字节数 */
  bytesTotal: number
  bytesDone: number
  /** 当前速度 B/s */
  speed: number
  /** 剩余秒数（估算） */
  etaSeconds?: number
  /** 冲突策略 */
  conflictPolicy: ConflictPolicy
  /** 是否断点续传 */
  resume: boolean
  /** 已完成的文件明细（可选，大目录时截断） */
  files?: TransferFile[]
  error?: string
}

/** 上传/下载请求参数 */
export interface TransferRequest {
  sessionId: string
  direction: TransferDirection
  /** 上传时为本地路径，下载时为远端路径 */
  sourcePath: string
  /** 上传时为远端路径，下载时为本地路径 */
  targetPath: string
  recursive?: boolean
  conflictPolicy?: ConflictPolicy
  resume?: boolean
  /** 保留权限 */
  preservePermissions?: boolean
  /** 保留时间戳 */
  preserveTimestamps?: boolean
}

/** 传输完成统计 */
export interface TransferSummary {
  transferId: string
  files: number
  bytes: number
  durationMs: number
  skipped: number
  failed: number
}
