// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * sftp 域 IPC 入口：把浏览/传输能力暴露成 Actions.sftp 的 14 个动作。
 *
 * 职责边界：
 * - 这里只做 **参数校验（zod）+ 会话取用 + 结果整形**；
 * - 具体文件语义在 browser.ts（浏览/权限/读写），传输语义在 transfer.ts（队列/并发/进度/取消）；
 * - 取 SSH 会话走中立契约 `requireSession`，不 import ssh 服务内部实现。
 *
 * 通道缓存：SFTP 子系统通道按会话复用（每次 sftp() 都开新通道既慢又浪费），
 * 通道 end/close 时清缓存，避免复用已死通道。
 */

import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { tmpdir } from 'node:os'
import { z } from 'zod'
import type { SFTPWrapper } from 'ssh2'
import type { OpenEditorResult } from '@t1000/shared'
import type { IpcContext, IpcHandler } from '../../ipc/router'
import { AppError } from '../../errors'
import { requireSession } from '../session-registry'
import {
  chmodPath,
  listDirectory,
  makeDirectory,
  readRemoteTextFile,
  removePath,
  remoteHome,
  renamePath,
  statPath,
  toSftpLike,
  writeRemoteTextFile,
  type SftpLike,
} from './browser'
import { TransferEngine } from './transfer'

// 编辑器相关形状的唯一定义处在 shared；这里再导出一次保持既有路径可用
export type { OpenEditorResult, RemoteTextFile, RemoteWriteResult } from '@t1000/shared'

// ---------------------------------------------------------------------------
// 参数校验
// ---------------------------------------------------------------------------

const sessionId = z.string().min(1, '缺少 sessionId')
const remotePath = z.string().min(1, '路径不能为空')
const modeSchema = z.union([z.number().int(), z.string().min(1)])
const conflictPolicy = z.enum(['ask', 'overwrite', 'skip', 'rename'])

const listSchema = z.object({ sessionId, path: remotePath, showHidden: z.boolean().optional() })
const statSchema = z.object({ sessionId, path: remotePath })
const mkdirSchema = z.object({ sessionId, path: remotePath, mode: modeSchema.optional() })
const renameSchema = z.object({
  sessionId,
  from: remotePath,
  to: remotePath,
  overwrite: z.boolean().optional(),
})
const removeSchema = z.object({ sessionId, path: remotePath, recursive: z.boolean().optional() })
const chmodSchema = z.object({ sessionId, path: remotePath, mode: modeSchema })
const homeSchema = z.object({ sessionId })
const readFileSchema = z.object({
  sessionId,
  path: remotePath,
  maxBytes: z.number().int().positive().optional(),
})
const writeFileSchema = z.object({ sessionId, path: remotePath, content: z.string() })
const transferSchema = z.object({
  sessionId,
  direction: z.enum(['upload', 'download']),
  sourcePath: z.string().min(1, '源路径不能为空'),
  targetPath: z.string().min(1, '目标路径不能为空'),
  recursive: z.boolean().optional(),
  conflictPolicy: conflictPolicy.optional(),
  resume: z.boolean().optional(),
  preservePermissions: z.boolean().optional(),
  preserveTimestamps: z.boolean().optional(),
})
const cancelTransferSchema = z.object({ transferId: z.string().min(1) })
const listTransfersSchema = z.object({ sessionId: sessionId.optional() })
const openEditorSchema = z.object({ sessionId, path: remotePath })

// ---------------------------------------------------------------------------
// 会话与通道
// ---------------------------------------------------------------------------

const channels = new Map<string, Promise<SFTPWrapper>>()

function requireSessionOrThrow(id: string) {
  try {
    return requireSession(id)
  } catch (err) {
    throw AppError.notConnected(err instanceof Error ? err.message : '会话不存在或已断开')
  }
}

/** 取（或建立）该会话的 SFTP 通道 */
function sftpFor(id: string): Promise<SftpLike> {
  const cached = channels.get(id)
  if (cached) return cached.then(toSftpLike)

  const handle = requireSessionOrThrow(id)
  const pending = new Promise<SFTPWrapper>((resolve, reject) => {
    handle.client.sftp((err, sftp) => {
      if (err) reject(AppError.notConnected(`打开 SFTP 通道失败: ${err.message}`))
      else resolve(sftp)
    })
  })

  channels.set(id, pending)
  void pending
    .then((wrapper) => {
      // 通道结束/出错即失效；下一次调用按需重开
      const drop = (): void => {
        if (channels.get(id) === pending) channels.delete(id)
      }
      wrapper.once('end', drop)
      wrapper.once('close', drop)
    })
    .catch(() => {
      if (channels.get(id) === pending) channels.delete(id)
    })

  return pending.then(toSftpLike)
}

// ---------------------------------------------------------------------------
// 传输引擎（进程内单例：队列/取消需要跨调用共享状态）
// ---------------------------------------------------------------------------

let engine: TransferEngine | null = null

function engineFor(ctx: IpcContext): TransferEngine {
  if (!engine) {
    engine = new TransferEngine({
      emit: ctx.emit,
      resolveSftp: sftpFor,
      logger: ctx.logger,
    })
  } else {
    // 上下文可能在引擎创建后才拿到最终广播函数
    engine.setEmitter(ctx.emit)
  }
  return engine
}

/** 测试自检：当前 sftp 域持有的传输引擎（未创建时为 null） */
export function getTransferEngine(): TransferEngine | null {
  return engine
}

// ---------------------------------------------------------------------------
// Handler 表
// ---------------------------------------------------------------------------

export const sftpHandlers: Record<string, IpcHandler> = {
  list: async (payload) => {
    const { sessionId: id, path, showHidden } = listSchema.parse(payload)
    const sftp = await sftpFor(id)
    return listDirectory(sftp, path, { showHidden: showHidden ?? false })
  },

  stat: async (payload) => {
    const { sessionId: id, path } = statSchema.parse(payload)
    return statPath(await sftpFor(id), path)
  },

  mkdir: async (payload) => {
    const { sessionId: id, path, mode } = mkdirSchema.parse(payload)
    return makeDirectory(await sftpFor(id), path, mode)
  },

  rename: async (payload) => {
    const { sessionId: id, from, to, overwrite } = renameSchema.parse(payload)
    await renamePath(await sftpFor(id), from, to, { overwrite: overwrite ?? false })
    return { from, to, renamed: true }
  },

  remove: async (payload) => {
    const { sessionId: id, path, recursive } = removeSchema.parse(payload)
    await removePath(await sftpFor(id), path, { recursive: recursive ?? false })
    return { path, removed: true }
  },

  chmod: async (payload) => {
    const { sessionId: id, path, mode } = chmodSchema.parse(payload)
    await chmodPath(await sftpFor(id), path, mode)
    return { path, mode }
  },

  home: async (payload) => {
    const { sessionId: id } = homeSchema.parse(payload)
    const sftp = await sftpFor(id)
    return { path: await remoteHome(sftp) }
  },

  readFile: async (payload) => {
    const { sessionId: id, path, maxBytes } = readFileSchema.parse(payload)
    const sftp = await sftpFor(id)
    return readRemoteTextFile(sftp, path, maxBytes === undefined ? {} : { maxBytes })
  },

  writeFile: async (payload) => {
    const { sessionId: id, path, content } = writeFileSchema.parse(payload)
    const sftp = await sftpFor(id)
    return writeRemoteTextFile(sftp, path, content)
  },

  upload: (payload, ctx) => {
    const req = transferSchema.parse(payload)
    return engineFor(ctx).submit(req)
  },

  download: (payload, ctx) => {
    const req = transferSchema.parse(payload)
    return engineFor(ctx).submit(req)
  },

  cancelTransfer: (payload, ctx) => {
    const { transferId } = cancelTransferSchema.parse(payload)
    return { transferId, cancelled: engineFor(ctx).cancel(transferId) }
  },

  listTransfers: (payload, ctx) => {
    const { sessionId: id } = listTransfersSchema.parse(payload)
    return engineFor(ctx).listTransfers(id)
  },

  /**
   * 远端编辑入口：把远端文件物化到系统临时目录，返回本地路径供编辑器打开。
   *
   * 用 os.tmpdir() 而不是应用数据目录 —— 编辑副本是易失的中间产物，
   * 不该进入用户数据目录、也不该被备份/同步带走。
   */
  openEditor: async (payload) => {
    const { sessionId: id, path } = openEditorSchema.parse(payload)
    const sftp = await sftpFor(id)
    const file = await readRemoteTextFile(sftp, path)

    const dir = join(tmpdir(), 't1000-remote-edit', id)
    await mkdir(dir, { recursive: true })
    const localPath = join(dir, basename(file.path))
    await writeFile(localPath, file.content, 'utf8')

    // 显式标注为 shared 契约：主进程返回值与 UI 类型对不上时编译期就会报错
    const result: OpenEditorResult = {
      remotePath: file.path,
      localPath,
      size: file.size,
      mtime: file.mtime,
      mode: file.mode,
      /** 每次编辑会话一个 id，供上层关联保存动作 */
      editId: randomUUID(),
    }
    return result
  },
}

/** 测试或会话断开时清理通道缓存 */
export function clearSftpChannels(sessionId?: string): void {
  if (sessionId) channels.delete(sessionId)
  else channels.clear()
}
