// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 本地文件系统后端：把 `SftpLike`（ssh2 SFTP 的回调式最小子集）映射到 node:fs。
 *
 * 为什么长这样：sftp 域的全部业务函数（listDirectory/chmodPath/TransferEngine/…）
 * 只依赖 `SftpLike`，因此本地终端（PTY 会话）只需要一个 fs 实现的 `SftpLike`，
 * 浏览/传输/编辑/权限在本地会话上原样复用，不另起第二套实现。
 *
 * 语义对齐（与 SSH 路径一致，刻意不做"本地特色"）：
 * - 入参路径是 `normalizeRemotePath` 的产物（POSIX 规范形、绝对）。`~` 与 `/~`
 *   前缀映射到本机 home —— 渲染层主目录按钮传的是 `~`；`realpath('.')` 同理
 *   （SFTP 语义里 realpath('.') 是服务端起始目录，即 home）。
 * - readdir 的 attrs 按 lstat 取（符号链接不跟随），与 SFTP readdir 的 attrs 一致；
 * - mtime/atime 单位是**秒**（SFTP 线路协议的单位，browser-e2e 按此断言）。
 *
 * 边界：
 * - 只支持 POSIX 宿主：Windows 盘符路径过不了 `normalizeRemotePath`（远端路径模型
 *   就是 POSIX 的），本地终端当前也只在 POSIX 上提供。
 * - 后端就是本机文件系统，不做额外沙箱（它本来就是本地终端）；
 *   删除/覆盖类危险操作的确认沿用渲染层既有流程。
 */

import * as fs from 'node:fs'
import { basename } from 'node:path'
import { homedir } from 'node:os'
import { getWritable } from '../session-registry'
import type { SftpEntry, SftpLike, SftpStats } from './browser'
import { formatPermissions } from './paths'

/** 该会话是否是本地终端（PTY）。会话不存在、或已退出（writable 已注销）返回 false */
export function isLocalSession(sessionId: string): boolean {
  return getWritable(sessionId)?.kind === 'pty'
}

/**
 * SftpLike 收到的路径 → 本机实际路径。
 * 只做 `~`/`.` 的 home 映射，其余原样透传（POSIX 绝对路径在 Linux/macOS 上即本机路径）。
 */
export function resolveLocalPath(input: string): string {
  if (input === '~' || input === '/~' || input === '.') return homedir()
  if (input.startsWith('~/')) return underHome(input.slice(2))
  if (input.startsWith('/~/')) return underHome(input.slice(3))
  return input
}

function underHome(rest: string): string {
  const home = homedir().replace(/\/+$/, '')
  return rest === '' ? home : `${home}/${rest}`
}

/** fs.Stats → SFTP attrs 形状（方法需绑定，时间取整为秒） */
function toSftpStats(s: fs.Stats): SftpStats {
  return {
    mode: s.mode,
    uid: s.uid,
    gid: s.gid,
    size: s.size,
    atime: Math.floor(s.atimeMs / 1000),
    mtime: Math.floor(s.mtimeMs / 1000),
    isDirectory: () => s.isDirectory(),
    isFile: () => s.isFile(),
    isSymbolicLink: () => s.isSymbolicLink(),
  }
}

/** ls -l 风格的长名称（当前 UI 未展示，但 RemoteEntry 契约要求携带） */
function longnameOf(path: string, s: fs.Stats): string {
  const kind = s.isDirectory() ? 'd' : s.isSymbolicLink() ? 'l' : s.isFile() ? '-' : '?'
  return `${kind}${formatPermissions(s.mode)} 1 ${s.uid} ${s.gid} ${s.size} ${basename(path)}`
}

/**
 * 列目录：Dirent 逐项 lstat 组装 SFTP 形状的 attrs。
 * 任一项 lstat 失败即整体失败（目录在读取中途被改属正常错误，与 SFTP 行为一致）。
 */
function readdirLocal(dir: string, cb: (err: Error | undefined, list: SftpEntry[]) => void): void {
  fs.readdir(dir, { withFileTypes: true }, (err, dirents) => {
    if (err) {
      // 错误分支的 value 永不被消费（消费方 promisify 先 reject），never 占位即可
      cb(err, undefined as never)
      return
    }
    if (dirents.length === 0) {
      cb(undefined, [])
      return
    }
    const out: SftpEntry[] = new Array(dirents.length)
    let pending = dirents.length
    let failed = false
    dirents.forEach((dirent, index) => {
      const child = dir === '/' ? `/${dirent.name}` : `${dir}/${dirent.name}`
      fs.lstat(child, (statErr, stats) => {
        if (failed) return
        if (statErr) {
          failed = true
          cb(statErr, undefined as never)
          return
        }
        out[index] = {
          filename: dirent.name,
          longname: longnameOf(child, stats),
          attrs: toSftpStats(stats),
        }
        pending -= 1
        if (pending === 0) cb(undefined, out)
      })
    })
  })
}

// open/read/write/close 的句柄在 SFTP 里是 Buffer；fs 这边是数字 fd。
// 用带前缀的文本编码承载，非法句柄显式报错而不是当成 NaN 静默错写。
const HANDLE_PREFIX = 't1000-fd:'

function encodeHandle(fd: number): Buffer {
  return Buffer.from(`${HANDLE_PREFIX}${fd}`, 'utf8')
}

function decodeHandle(handle: Buffer): number {
  const text = handle.toString('utf8')
  const fd = Number(text.slice(HANDLE_PREFIX.length))
  if (!text.startsWith(HANDLE_PREFIX) || !Number.isInteger(fd) || fd < 0) {
    throw new Error('非法的本地文件句柄')
  }
  return fd
}

/** 本地 fs 的错误回调兜底（decodeHandle 可能抛错，不能让它变成同步异常逃出回调边界） */
function guarded(cb: (err: Error | undefined, ...rest: never[]) => void, fn: () => void): void {
  try {
    fn()
  } catch (err) {
    cb(err instanceof Error ? err : new Error(String(err)))
  }
}

function noop(): void {
  /* writeFile 的回调形参可省，fs 不接受 undefined，这里补一个空实现 */
}

/**
 * 创建本地文件系统后端。适配器无状态（句柄归调用方管理），每次取用新建一个即可。
 */
export function createLocalSftpLike(): SftpLike {
  return {
    readdir(location, cb) {
      readdirLocal(resolveLocalPath(location), cb)
    },

    stat(path, cb) {
      fs.stat(resolveLocalPath(path), (err, stats) => {
        if (err) {
          cb(err, undefined as never)
          return
        }
        cb(undefined, toSftpStats(stats))
      })
    },

    lstat(path, cb) {
      fs.lstat(resolveLocalPath(path), (err, stats) => {
        if (err) {
          cb(err, undefined as never)
          return
        }
        cb(undefined, toSftpStats(stats))
      })
    },

    mkdir(path, attributes, cb) {
      fs.mkdir(resolveLocalPath(path), { mode: attributes.mode }, (err) => cb(err ?? undefined))
    },

    rmdir(path, cb) {
      fs.rmdir(resolveLocalPath(path), (err) => cb(err ?? undefined))
    },

    unlink(path, cb) {
      fs.unlink(resolveLocalPath(path), (err) => cb(err ?? undefined))
    },

    rename(srcPath, destPath, cb) {
      fs.rename(resolveLocalPath(srcPath), resolveLocalPath(destPath), (err) => cb(err ?? undefined))
    },

    chmod(path, mode, cb) {
      fs.chmod(resolveLocalPath(path), mode, (err) => cb(err ?? undefined))
    },

    readFile(path, cb) {
      fs.readFile(resolveLocalPath(path), (err, data) => {
        if (err) {
          cb(err, undefined as never)
          return
        }
        cb(undefined, data)
      })
    },

    writeFile(path, data, cb) {
      fs.writeFile(resolveLocalPath(path), data, (err) => (cb ?? noop)(err ?? undefined))
    },

    open(path, mode, cb) {
      fs.open(resolveLocalPath(path), mode, (err, fd) => {
        if (err) {
          cb(err, undefined as never)
          return
        }
        cb(undefined, encodeHandle(fd))
      })
    },

    close(handle, cb) {
      guarded(
        (err) => cb(err ?? undefined),
        () => fs.close(decodeHandle(handle), (err) => cb(err ?? undefined)),
      )
    },

    read(handle, buffer, offset, length, position, cb) {
      guarded(
        (err) => cb(err ?? undefined, 0, buffer),
        () =>
          fs.read(decodeHandle(handle), buffer, offset, length, position, (err, bytesRead) => {
            cb(err ?? undefined, err ? 0 : bytesRead, buffer)
          }),
      )
    },

    write(handle, buffer, offset, length, position, cb) {
      guarded(
        (err) => cb(err ?? undefined),
        () =>
          fs.write(decodeHandle(handle), buffer, offset, length, position, (err) =>
            cb(err ?? undefined),
          ),
      )
    },

    realpath(path, cb) {
      fs.realpath(resolveLocalPath(path), (err, absPath) => {
        if (err) {
          cb(err, undefined as never)
          return
        }
        cb(undefined, absPath)
      })
    },

    utimes(path, atime, mtime, cb) {
      fs.utimes(resolveLocalPath(path), atime, mtime, (err) => cb(err ?? undefined))
    },

    end() {
      /* 无连接资源可释放；保留空实现以对齐 SftpLike 的可选 end */
    },
  }
}
