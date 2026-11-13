// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * SFTP 文件浏览与基础操作。
 *
 * 这里**只依赖 `SftpLike`**（本文件定义的 SFTP 最小子集接口），而不是 ssh2 的
 * `SFTPWrapper`：一是重载签名让结构匹配很啰嗦，二是单测可以用一个手写的假对象
 * 精确控制每个回调的时序与错误，不用起真主机。
 * 真实对象在边界处一次性收窄（见 `toSftpLike`）。
 */

import type { SFTPWrapper } from 'ssh2'
import type {
  RemoteEntry,
  RemoteEntryType,
  RemoteFileInfo,
  RemoteTextFile,
  RemoteTree,
  RemoteWriteResult,
} from '@t1000/shared'
import { AppError } from '../../errors'
import {
  basenameRemotePath,
  formatPermissions,
  isInsideRemotePath,
  normalizeRemotePath,
  parseMode,
} from './paths'

/** 单次读取远端文件的上限（编辑器场景）：超过直接报错，避免打爆主进程内存 */
export const MAX_REMOTE_READ_BYTES = 8 * 1024 * 1024

/** SFTP attrs 中我们真正用到的那部分（ssh2 的 Stats 结构上满足它） */
export interface SftpStats {
  mode: number
  uid: number
  gid: number
  size: number
  atime: number
  mtime: number
  isDirectory(): boolean
  isFile(): boolean
  isSymbolicLink(): boolean
}

/** SFTP readdir 返回的条目（ssh2 的 FileEntryWithStats 结构上满足它） */
export interface SftpEntry {
  filename: string
  longname: string
  attrs: SftpStats
}

type ErrCb = (err?: Error | null) => void
type ValCb<T> = (err: Error | undefined, value: T) => void

/**
 * 用到的 SFTP 方法子集。全部是回调式（与 ssh2 一致），
 * 这样假对象不需要实现 EventEmitter / 流。
 */
export interface SftpLike {
  readdir(location: string, cb: (err: Error | undefined, list: SftpEntry[]) => void): void
  stat(path: string, cb: (err: Error | undefined, stats: SftpStats) => void): void
  lstat(path: string, cb: (err: Error | undefined, stats: SftpStats) => void): void
  mkdir(path: string, attributes: { mode?: number }, cb: ErrCb): void
  rmdir(path: string, cb: ErrCb): void
  unlink(path: string, cb: ErrCb): void
  rename(srcPath: string, destPath: string, cb: ErrCb): void
  chmod(path: string, mode: number, cb: ErrCb): void
  readFile(path: string, cb: (err: Error | undefined, data: Buffer) => void): void
  writeFile(path: string, data: Buffer, cb?: ErrCb): void
  open(path: string, mode: string, cb: (err: Error | undefined, handle: Buffer) => void): void
  close(handle: Buffer, cb: ErrCb): void
  read(
    handle: Buffer,
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
    cb: (err: Error | undefined, bytesRead: number, buffer: Buffer) => void,
  ): void
  write(
    handle: Buffer,
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
    cb: ErrCb,
  ): void
  realpath?(path: string, cb: (err: Error | undefined, absPath: string) => void): void
  /** 保留时间戳时用；并非所有服务端/包装都实现，故可选 */
  utimes?(path: string, atime: number | Date, mtime: number | Date, cb: ErrCb): void
  end?(): void
}

/**
 * 把 ssh2 的 SFTPWrapper 收窄成 SftpLike。
 * 重载签名使 TS 的结构比较不可靠，这里显式断言一次，之后所有调用都受接口约束。
 */
export function toSftpLike(wrapper: SFTPWrapper): SftpLike {
  return wrapper as unknown as SftpLike
}

// ---------------------------------------------------------------------------
// 回调 → Promise
// ---------------------------------------------------------------------------

function promisifyVoid(call: (cb: ErrCb) => void): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    call((err) => (err ? reject(err) : resolve()))
  })
}

function promisify<T>(call: (cb: ValCb<T>) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    call((err, value) => (err ? reject(err) : resolve(value)))
  })
}

export const sftpFs = {
  readdir: (s: SftpLike, p: string): Promise<SftpEntry[]> => promisify((cb) => s.readdir(p, cb)),
  stat: (s: SftpLike, p: string): Promise<SftpStats> => promisify((cb) => s.stat(p, cb)),
  lstat: (s: SftpLike, p: string): Promise<SftpStats> => promisify((cb) => s.lstat(p, cb)),
  mkdir: (s: SftpLike, p: string, mode?: number): Promise<void> =>
    promisifyVoid((cb) => s.mkdir(p, mode === undefined ? {} : { mode }, cb)),
  rmdir: (s: SftpLike, p: string): Promise<void> => promisifyVoid((cb) => s.rmdir(p, cb)),
  unlink: (s: SftpLike, p: string): Promise<void> => promisifyVoid((cb) => s.unlink(p, cb)),
  rename: (s: SftpLike, from: string, to: string): Promise<void> =>
    promisifyVoid((cb) => s.rename(from, to, cb)),
  chmod: (s: SftpLike, p: string, mode: number): Promise<void> =>
    promisifyVoid((cb) => s.chmod(p, mode, cb)),
  readFile: (s: SftpLike, p: string): Promise<Buffer> => promisify((cb) => s.readFile(p, cb)),
  writeFile: (s: SftpLike, p: string, data: Buffer): Promise<void> =>
    promisifyVoid((cb) => s.writeFile(p, data, cb)),
  open: (s: SftpLike, p: string, mode: string): Promise<Buffer> =>
    promisify((cb) => s.open(p, mode, cb)),
  close: (s: SftpLike, h: Buffer): Promise<void> => promisifyVoid((cb) => s.close(h, cb)),
  write: (s: SftpLike, h: Buffer, b: Buffer, off: number, len: number, pos: number): Promise<void> =>
    promisifyVoid((cb) => s.write(h, b, off, len, pos, cb)),
  utimes: (s: SftpLike, p: string, atime: number, mtime: number): Promise<void> => {
    if (!s.utimes) return Promise.resolve()
    return promisifyVoid((cb) => s.utimes?.(p, atime, mtime, cb))
  },
  read: (
    s: SftpLike,
    h: Buffer,
    b: Buffer,
    off: number,
    len: number,
    pos: number,
  ): Promise<number> =>
    new Promise<number>((resolve, reject) => {
      s.read(h, b, off, len, pos, (err, bytesRead) => (err ? reject(err) : resolve(bytesRead)))
    }),
} as const

// ---------------------------------------------------------------------------
// 业务级操作
// ---------------------------------------------------------------------------

// 这些形状的**唯一定义处**已上移到 `@t1000/shared`（渲染层同样从那里取类型，
// 不再各写一份镜像声明）。这里再导出一次，保持既有 `./browser` import 路径可用。
export type { RemoteEntry, RemoteEntryType, RemoteFileInfo, RemoteTextFile, RemoteTree, RemoteWriteResult }

export function entryTypeOf(stats: SftpStats): RemoteEntryType {
  if (stats.isDirectory()) return 'directory'
  if (stats.isSymbolicLink()) return 'symlink'
  if (stats.isFile()) return 'file'
  return 'other'
}

/** 由 attrs 的模式位判断是否为符号链接（readdir 的 attrs 不一定带方法语义） */
export function isSymlinkMode(mode: number): boolean {
  return (mode & 0o170000) === 0o120000
}

function toRemoteEntry(path: string, attrs: SftpStats, longname = ''): RemoteEntry {
  return {
    name: basenameRemotePath(path),
    path,
    type: entryTypeOf(attrs),
    size: attrs.size,
    mtime: attrs.mtime,
    mode: attrs.mode & 0o7777,
    permissions: formatPermissions(attrs.mode),
    uid: attrs.uid,
    gid: attrs.gid,
    longname,
  }
}

/**
 * 列目录。默认隐藏以 `.` 开头的条目（与主流文件管理器一致），
 * `showHidden: true` 时全部返回。排序：目录在前，然后按名字自然序。
 */
export async function listDirectory(
  sftp: SftpLike,
  remotePath: string,
  options: { showHidden?: boolean } = {},
): Promise<RemoteEntry[]> {
  const dir = normalizeRemotePath(remotePath)
  const list = await sftpFs.readdir(sftp, dir)

  const entries: RemoteEntry[] = []
  for (const item of list) {
    // `name === '.'` / `'..'` 不该出现在 SFTP 结果里，出现了也过滤掉
    if (item.filename === '.' || item.filename === '..') continue
    if (!options.showHidden && item.filename.startsWith('.')) continue
    const child = dir === '/' ? `/${item.filename}` : `${dir}/${item.filename}`
    entries.push(toRemoteEntry(child, item.attrs, item.longname ?? ''))
  }

  entries.sort((a, b) => {
    const aDir = a.type === 'directory' ? 0 : 1
    const bDir = b.type === 'directory' ? 0 : 1
    if (aDir !== bDir) return aDir - bDir
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
  })
  return entries
}

/** stat（跟随符号链接） */
export async function statPath(sftp: SftpLike, remotePath: string): Promise<RemoteEntry> {
  const p = normalizeRemotePath(remotePath)
  const stats = await sftpFs.stat(sftp, p)
  return toRemoteEntry(p, stats)
}

/** lstat（不跟随符号链接） */
export async function lstatPath(sftp: SftpLike, remotePath: string): Promise<RemoteEntry> {
  const p = normalizeRemotePath(remotePath)
  const stats = await sftpFs.lstat(sftp, p)
  return toRemoteEntry(p, stats)
}

/** 判断路径是否存在（不区分"不存在"与"权限不足"，后者按不存在处理会误判，故显式区分） */
export async function pathExists(sftp: SftpLike, remotePath: string): Promise<boolean> {
  try {
    await sftpFs.stat(sftp, normalizeRemotePath(remotePath))
    return true
  } catch (err) {
    if (isNoSuchFile(err)) return false
    throw err
  }
}

export function isNoSuchFile(err: unknown): boolean {
  // SFTP 服务端返回的 code 可能是数字（SSH_FX_NO_SUCH_FILE=2）也可能是字符串
  const code = (err as { code?: string | number } | undefined)?.code
  if (code === 2 || code === '2' || code === 'ENOENT' || code === 'NO_SUCH_FILE') return true
  const msg = err instanceof Error ? err.message : String(err)
  return /no such file/i.test(msg)
}

/**
 * 新建目录（单层）。已存在 → CONFLICT（调用方决定是否忽略）。
 * 给了 mode 时补一次 chmod —— SFTP mkdir 的 attrs 并非所有服务端都遵守。
 */
export async function makeDirectory(
  sftp: SftpLike,
  remotePath: string,
  mode?: number | string,
): Promise<RemoteEntry> {
  const p = normalizeRemotePath(remotePath)
  if (p === '/') throw AppError.badRequest('根目录已存在')
  const parsedMode = mode === undefined ? undefined : parseMode(mode)

  if (await pathExists(sftp, p)) {
    throw AppError.conflict(`目录已存在: ${p}`)
  }
  await sftpFs.mkdir(sftp, p, parsedMode)
  if (parsedMode !== undefined) await sftpFs.chmod(sftp, p, parsedMode)
  return statPath(sftp, p)
}

/**
 * 递归建目录（mkdir -p）。已存在则视为成功（不报冲突），
 * 因为递归上传时目标目录树多半已存在一部分。
 */
export async function ensureRemoteDirectory(
  sftp: SftpLike,
  remotePath: string,
  mode?: number,
): Promise<string> {
  const target = normalizeRemotePath(remotePath)
  if (target === '/') return '/'

  const segments = target.split('/').filter((s) => s !== '')
  let current = ''
  for (const seg of segments) {
    current += `/${seg}`
    try {
      const stats = await sftpFs.stat(sftp, current)
      if (!stats.isDirectory()) {
        throw AppError.conflict(`路径已存在且不是目录: ${current}`)
      }
    } catch (err) {
      if (err instanceof AppError) throw err
      if (!isNoSuchFile(err)) throw err
      try {
        await sftpFs.mkdir(sftp, current, mode)
      } catch (mkErr) {
        // 并发下可能别人刚好建好；再 stat 一次确认，确实是目录就放行
        if (isNoSuchFile(mkErr)) throw mkErr
        const stats = await sftpFs.stat(sftp, current).catch(() => null)
        if (!stats?.isDirectory()) throw mkErr
      }
    }
  }
  return target
}

/**
 * 重命名/移动。默认不覆盖已存在的目标（返回 CONFLICT），
 * 因为底层 POSIX rename 会静默覆盖，而"重命名"在 UI 上是无歧义操作，
 * 静默丢文件比报错糟糕得多。
 */
export async function renamePath(
  sftp: SftpLike,
  from: string,
  to: string,
  options: { overwrite?: boolean } = {},
): Promise<void> {
  const src = normalizeRemotePath(from)
  const dest = normalizeRemotePath(to)
  if (src === dest) return
  if (dest === '/') throw AppError.badRequest('不能把路径重命名为根目录')
  if (await pathExists(sftp, dest)) {
    if (!options.overwrite) throw AppError.conflict(`目标已存在: ${dest}`)
    await removePath(sftp, dest, { recursive: true })
  }
  await sftpFs.rename(sftp, src, dest)
}

/**
 * 删除文件或目录。目录必须显式 `recursive: true` 才会递归（防止误删整棵树）。
 * 符号链接一律 unlink（不跟随进目标），这也是 rm 的语义。
 */
export async function removePath(
  sftp: SftpLike,
  remotePath: string,
  options: { recursive?: boolean } = {},
): Promise<void> {
  const p = normalizeRemotePath(remotePath)
  if (p === '/') throw AppError.forbidden('拒绝删除根目录')

  const stats = await sftpFs.lstat(sftp, p)
  if (stats.isDirectory()) {
    if (!options.recursive) {
      // 不递归：直接 rmdir，非空时由服务端报错
      await sftpFs.rmdir(sftp, p)
      return
    }
    await removeDirectoryRecursive(sftp, p)
    return
  }
  await sftpFs.unlink(sftp, p)
}

async function removeDirectoryRecursive(sftp: SftpLike, dir: string): Promise<void> {
  const list = await sftpFs.readdir(sftp, dir)
  for (const item of list) {
    if (item.filename === '.' || item.filename === '..') continue
    const child = dir === '/' ? `/${item.filename}` : `${dir}/${item.filename}`
    // attrs 的 isDirectory 方法在部分服务端实现里缺失，模式位兜底
    const modeIsDir = (item.attrs.mode & 0o170000) === 0o040000
    const isDir = typeof item.attrs.isDirectory === 'function' ? item.attrs.isDirectory() : modeIsDir
    const isLink = (item.attrs.mode & 0o170000) === 0o120000
    if (isDir && !isLink) {
      await removeDirectoryRecursive(sftp, child)
    } else {
      await sftpFs.unlink(sftp, child)
    }
  }
  await sftpFs.rmdir(sftp, dir)
}

/**
 * 递归 chmod 的条目上限。
 *
 * 远端目录动辄上万项，无上限地走完整棵树会让界面卡住、也让"预备命令"列出几万行。
 * 超限时**明确告知被截断**，而不是悄悄少改一部分（那等于给了用户一个假的成功）。
 */
const MAX_CHMOD_ENTRIES = 5000

/** 「预备命令」里最多列几条明细（其余用汇总行说明） */
const MAX_PREVIEW_COMMANDS = 50

export interface ChmodPlan {
  /** 一行汇总，等价于 shell 里的 chmod（如 `chmod -R 755 /tmp/a`） */
  summary: string
  /** 将要改动的条目（含目录/文件自身），按遍历顺序 */
  entries: string[]
  /** 列给用户看的明细命令（最多 MAX_PREVIEW_COMMANDS 条） */
  commands: string[]
  /** 是否因为超过上限被截断 */
  truncated: boolean
  /**
   * 危险提示（有值时界面应当显著展示）。
   *
   * 目前只报一种最容易被踩的情形：**递归时把目录的可执行位也去掉了**。
   * 目录没有 x 位就**进不去**，整棵子树会立刻变得不可访问 ——
   * GNU `chmod -R` 也是这个行为，但用户往往到"目录打不开"时才意识到。
   */
  warning?: string
}

/** 目录缺少可执行位时的措辞 */
function dirExecWarning(mode: number, recursive: boolean): string | undefined {
  if (!recursive) return undefined
  if ((mode & 0o111) !== 0) return undefined
  return (
    '该权限不含目录的执行位（x）：递归后**目录会变得无法进入**，' +
    '其中所有文件也会随之不可访问（`chmod -R` 的固有行为）。' +
    '若要保留可访问性，目录通常需要至少 700（如 755/750）。'
  )
}

/**
 * **只计算不执行**：算出"将要改哪些、执行什么命令"。
 *
 * 这是 spec 要求的「预备执行命令区域」的数据来源 —— 用户在按下执行之前，
 * 应当能看清到底会动哪些路径。对 `chmod -R` 这种影响面大的操作，这比事后补救重要。
 */
export async function planChmod(
  sftp: SftpLike,
  remotePath: string,
  mode: number | string,
  options: { recursive?: boolean } = {},
): Promise<ChmodPlan> {
  const p = normalizeRemotePath(remotePath)
  const octal = parseMode(mode).toString(8).padStart(3, '0')
  const recursive = options.recursive === true

  const stats = await sftpFs.lstat(sftp, p)
  const modeIsDir = (stats.mode & 0o170000) === 0o040000
  const isDir = typeof stats.isDirectory === 'function' ? stats.isDirectory() : modeIsDir
  const isLink = (stats.mode & 0o170000) === 0o120000

  // 非目录、或没勾递归 → 只动这一个
  if (!isDir || isLink || !recursive) {
    const summary = `chmod ${octal} ${p}`
    const w = dirExecWarning(parseMode(mode), false)
    return {
      summary,
      entries: [p],
      commands: [summary],
      truncated: false,
      ...(w === undefined ? {} : { warning: w }),
    }
  }

  // 拒绝在根目录上递归：`chmod -R /` 会把整台机器搞坏，和 removePath 拒绝删根同理
  if (p === '/') throw AppError.forbidden('拒绝对根目录执行递归 chmod')

  const entries: string[] = [p]
  let truncated = false
  const walk = async (dir: string): Promise<void> => {
    if (truncated) return
    const list = await sftpFs.readdir(sftp, dir)
    for (const item of list) {
      if (item.filename === '.' || item.filename === '..') continue
      if (entries.length >= MAX_CHMOD_ENTRIES) {
        truncated = true
        return
      }
      const child = dir === '/' ? `/${item.filename}` : `${dir}/${item.filename}`
      entries.push(child)
      const childMode = item.attrs.mode & 0o170000
      const childIsDir =
        typeof item.attrs.isDirectory === 'function' ? item.attrs.isDirectory() : childMode === 0o040000
      // **符号链接不跟进去**（与 chmod -R 默认行为一致）：跟进去会改到链接指向的目标，
      // 那往往不是用户想动的路径。
      const childIsLink = childMode === 0o120000
      if (childIsDir && !childIsLink) await walk(child)
    }
  }
  await walk(p)

  const summary = `chmod -R ${octal} ${p}`
  const commands = entries.slice(0, MAX_PREVIEW_COMMANDS).map((e) => `chmod ${octal} ${e}`)
  const w = dirExecWarning(parseMode(mode), true)
  return {
    summary,
    entries,
    commands,
    truncated,
    ...(w === undefined ? {} : { warning: w }),
  }
}

export interface ChmodResult {
  /** 成功改动的条目数 */
  changed: number
  /** 失败的条目与原因（部分失败是常态，必须逐项报） */
  failed: Array<{ path: string; message: string }>
  /** 实际执行的命令（截断到预览上限） */
  commands: string[]
  summary: string
  truncated: boolean
  /** 危险提示（透传自预览计划） */
  warning?: string
}

/**
 * 修改权限位（支持递归）。
 *
 * 语义对齐 `chmod -R`：**目录自身也改**，符号链接不跟随。
 * 逐项执行并**收集失败**而不是遇到第一个错就中断 —— 一棵树里个别文件没权限是常事，
 * 中断会让"改了一半"的状态更难排查。
 */
export async function chmodPath(
  sftp: SftpLike,
  remotePath: string,
  mode: number | string,
  options: { recursive?: boolean } = {},
): Promise<ChmodResult> {
  const numeric = parseMode(mode)
  const plan = await planChmod(sftp, remotePath, numeric, options)
  const failed: Array<{ path: string; message: string }> = []
  let changed = 0

  for (const entry of plan.entries) {
    try {
      await sftpFs.chmod(sftp, entry, numeric)
      changed += 1
    } catch (err) {
      failed.push({ path: entry, message: err instanceof Error ? err.message : String(err) })
    }
  }

  return {
    changed,
    failed,
    commands: plan.commands,
    summary: plan.summary,
    truncated: plan.truncated,
    ...(plan.warning === undefined ? {} : { warning: plan.warning }),
  }
}

/**
 * 读文本文件（编辑器用）。
 * 超过 maxBytes 直接报错而不是截断 —— 静默截断会让用户保存时毁掉文件。
 */
export async function readRemoteTextFile(
  sftp: SftpLike,
  remotePath: string,
  options: { maxBytes?: number } = {},
): Promise<RemoteTextFile> {
  const p = normalizeRemotePath(remotePath)
  const max = options.maxBytes ?? MAX_REMOTE_READ_BYTES
  const stats = await sftpFs.stat(sftp, p)
  if (stats.isDirectory()) throw AppError.badRequest(`目标是目录，不能按文件读取: ${p}`)
  if (stats.size > max) {
    throw AppError.badRequest(`文件过大（${stats.size} 字节 > 上限 ${max} 字节），已拒绝读取`, {
      size: stats.size,
      maxBytes: max,
    })
  }
  const data = await sftpFs.readFile(sftp, p)
  return {
    path: p,
    content: data.toString('utf8'),
    size: data.length,
    mtime: stats.mtime,
    mode: stats.mode & 0o7777,
  }
}

/** 写文本文件（编辑器保存）。整体一次写入，编辑器场景内容不会很大。 */
export async function writeRemoteTextFile(
  sftp: SftpLike,
  remotePath: string,
  content: string | Buffer,
): Promise<RemoteWriteResult> {
  const p = normalizeRemotePath(remotePath)
  const data = typeof content === 'string' ? Buffer.from(content, 'utf8') : content
  await sftpFs.writeFile(sftp, p, data)
  return { path: p, size: data.length }
}

/** 会话 home 目录（SFTP 的 realpath('.') 通常就是 home；不支持时退回 /） */
export async function remoteHome(sftp: SftpLike): Promise<string> {
  if (!sftp.realpath) return '/'
  try {
    const abs = await promisify<string>((cb) => sftp.realpath?.('.', cb))
    return normalizeRemotePath(abs)
  } catch {
    return '/'
  }
}

/**
 * 递归扫描远端目录，产出传输清单。
 *
 * 性能设计（对应 PERFORMANCE-GOALS「大目录扫描有进度反馈」）：
 * - 逐条目回调 `onProgress`，由调用方按时间/条数节流后发事件；
 * - 目录用显式栈而不是递归调用，10 万层深也不会爆栈；
 * - 符号链接不跟进（既防环，也符合"扫描待传输文件"的直觉）；
 * - 目录深度上限兜底，异常挂载不会让扫描永不结束。
 */
export async function scanRemoteTree(
  sftp: SftpLike,
  root: string,
  options: {
    /** 每扫到这么多条目回调一次（默认 200） */
    progressEvery?: number
    onProgress?: (scanned: { files: number; bytes: number; dirs: number; current: string }) => void
    /** 目录深度上限，默认 64 */
    maxDepth?: number
    /** 取消信号：返回 true 时扫描尽快中止 */
    isCancelled?: () => boolean
    /** 单个根目录下扫描条目数上限（防御性，默认 1_000_000） */
    maxEntries?: number
  } = {},
): Promise<RemoteTree> {
  const base = normalizeRemotePath(root)
  const progressEvery = options.progressEvery ?? 200
  const maxDepth = options.maxDepth ?? 64
  const maxEntries = options.maxEntries ?? 1_000_000

  const files: RemoteFileInfo[] = []
  const dirs: string[] = []
  let bytesTotal = 0
  let scanned = 0

  const rootStats = await sftpFs.stat(sftp, base)
  if (!rootStats.isDirectory()) {
    // 单文件：清单只有它自己
    files.push({ relativePath: basenameRemotePath(base), absolutePath: base, size: rootStats.size, mtime: rootStats.mtime, mode: rootStats.mode & 0o7777 })
    return { root: base, files, dirs, filesTotal: 1, bytesTotal: rootStats.size }
  }

  /** 显式栈：待扫描目录（绝对路径, 相对 root, 深度） */
  const stack: Array<{ abs: string; rel: string; depth: number }> = [
    { abs: base, rel: '', depth: 0 },
  ]

  while (stack.length > 0) {
    const current = stack.pop()
    if (!current) break
    if (options.isCancelled?.()) throw new CancelledScanError()
    if (current.depth > maxDepth) {
      throw new AppError('BAD_REQUEST', `目录层级超过上限 ${maxDepth}，已中止扫描: ${current.abs}`)
    }

    const list = await sftpFs.readdir(sftp, current.abs)
    for (const item of list) {
      if (item.filename === '.' || item.filename === '..') continue
      scanned++
      if (scanned > maxEntries) {
        throw AppError.badRequest(`扫描条目超过上限 ${maxEntries}，已中止: ${base}`)
      }

      const abs = current.abs === '/' ? `/${item.filename}` : `${current.abs}/${item.filename}`
      const rel = current.rel === '' ? item.filename : `${current.rel}/${item.filename}`
      const mode = item.attrs.mode
      const isLink = isSymlinkMode(mode)
      const isDir = (mode & 0o170000) === 0o040000

      if (isDir && !isLink) {
        dirs.push(rel)
        stack.push({ abs, rel, depth: current.depth + 1 })
      } else {
        files.push({ relativePath: rel, absolutePath: abs, size: item.attrs.size, mtime: item.attrs.mtime, mode: mode & 0o7777 })
        bytesTotal += item.attrs.size
      }

      if (scanned % progressEvery === 0) {
        options.onProgress?.({ files: files.length, bytes: bytesTotal, dirs: dirs.length, current: abs })
      }
    }
  }

  options.onProgress?.({ files: files.length, bytes: bytesTotal, dirs: dirs.length, current: base })
  return { root: base, files, dirs, filesTotal: files.length, bytesTotal }
}

/** 扫描被取消时抛出的内部信号（transfer 层转成 cancelled 状态） */
export class CancelledScanError extends Error {
  constructor() {
    super('目录扫描已取消')
    this.name = 'CancelledScanError'
  }
}

/**
 * 把相对路径挂到目标根目录下（上传/下载时把扫描结果的相对路径映射成绝对路径）。
 *
 * 与朴素拼接的区别：这里做完整规范化，并**强制结果仍在 root 之内** ——
 * 扫描结果理论上不会含 `..`，但一旦外部把不受控字符串喂进来，
 * 只做拼接就会写出到 root 之外，所以越界必须拒绝而不是"规约到根"。
 */
export function rebaseRelativePath(root: string, relativePath: string): string {
  const base = normalizeRemotePath(root)
  const joined = base === '/' ? `/${relativePath}` : `${base}/${relativePath}`
  const result = normalizeRemotePath(joined)
  if (!isInsideRemotePath(base, result)) {
    throw AppError.badRequest(`相对路径越出目标目录: ${relativePath}`)
  }
  return result
}
