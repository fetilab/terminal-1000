// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * SFTP 面向 UI 的数据形状（主进程返回值 ↔ 渲染层展示的唯一契约）。
 *
 * 为什么在这里：这些形状原先只定义在主进程 `services/sftp/browser.ts`，
 * 渲染层因此各写了一份**镜像声明**——镜像没有编译期保护，主进程改字段时
 * 渲染层照旧编译通过，只会在运行期显示错数据。上移后双方都从这里取类型。
 *
 * 边界（刻意不在这里的东西）：
 * - `SftpLike` / `SftpStats` / `SftpEntry`：ssh2 `SFTPWrapper` 的鸭子类型，
 *   属于主进程的传输实现细节，**不能**放进 shared（否则渲染层会间接依赖 ssh2）。
 * - 本文件**零 import**：不依赖 node / electron / ssh2，也不含任何运行时代码。
 */

/** 远端条目类型 */
export type RemoteEntryType = 'file' | 'directory' | 'symlink' | 'other'

/** 目录列表项（IPC 返回给渲染层的形状） */
export interface RemoteEntry {
  /** 名字（不含目录部分） */
  name: string
  /** 规范化后的绝对路径 */
  path: string
  type: RemoteEntryType
  size: number
  mtime: number
  /** 数字权限位（低 12 位） */
  mode: number
  /** rwxr-xr-x 形式 */
  permissions: string
  uid: number
  gid: number
  /** ls -l 风格的长名称，UI 可直接展示 */
  longname: string
}

/** 递归扫描清单里的单个文件（相对路径 + 元信息） */
export interface RemoteFileInfo {
  /** 相对 root 的相对路径（POSIX 分隔符，无前导斜杠） */
  relativePath: string
  /** 绝对路径 */
  absolutePath: string
  size: number
  mtime: number
  mode: number
}

/** 递归扫描出的一棵远端文件树（传输前的"先扫描后执行"清单） */
export interface RemoteTree {
  /** 根目录（规范化后的绝对路径） */
  root: string
  /** 所有待传输文件 */
  files: RemoteFileInfo[]
  /** 需要创建的目录（相对 root，按深度升序） */
  dirs: string[]
  filesTotal: number
  bytesTotal: number
}

/** 读到的远端文本文件（编辑器用） */
export interface RemoteTextFile {
  path: string
  content: string
  size: number
  mtime: number
  mode: number
}

/** 文本写回结果 */
export interface RemoteWriteResult {
  path: string
  size: number
}

/** 远端编辑：物化到本机临时目录后的结果 */
export interface OpenEditorResult {
  remotePath: string
  /** 物化到本机临时目录的副本路径 */
  localPath: string
  size: number
  mtime: number
  mode: number
  /** 每次编辑会话一个 id，供上层关联保存动作 */
  editId: string
}

// ---------------------------------------------------------------------------
// 权限修改（递归 chmod 与「预备执行命令」）
// ---------------------------------------------------------------------------

/**
 * 预备执行的权限修改计划 —— **只算不改**。
 *
 * spec 要求执行前有「预备执行命令区域」：让用户看清到底会动哪些路径。
 * 对 `chmod -R` 这种影响面大的操作，这比事后补救重要。
 */
export interface ChmodPlan {
  /** 一行汇总，等价于 shell 里的 chmod（如 `chmod -R 755 /tmp/a`） */
  summary: string
  /** 将要改动的条目（含目录/文件自身），按遍历顺序 */
  entries: string[]
  /** 列给用户看的明细命令（有上限） */
  commands: string[]
  /** 是否因为超过上限被截断（**必须如实告知**，否则就是给了个假的成功） */
  truncated: boolean
  /**
   * 危险提示（有值时界面应显著展示）。
   *
   * 目前只报一种最容易被踩的情形：**递归时把目录的可执行位也去掉了** ——
   * 目录没有 x 位就进不去，整棵子树会立刻不可访问（`chmod -R` 的固有行为）。
   */
  warning?: string
}

/** 权限修改的执行结果（逐项，因为部分失败是常态） */
export interface ChmodResult {
  /** 成功改动的条目数 */
  changed: number
  /** 失败的条目与原因 */
  failed: Array<{ path: string; message: string }>
  /** 实际执行的命令（截断到预览上限） */
  commands: string[]
  summary: string
  truncated: boolean
  warning?: string
}
