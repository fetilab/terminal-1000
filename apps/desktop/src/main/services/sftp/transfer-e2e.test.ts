// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 传输引擎的**真实协议 + 真实文件系统**端到端测试。
 *
 * 这里能验证 FakeSftp 验证不了的东西：
 * 跨多个 chunk 的大文件字节一致性、真实并发（服务端观测到的同时打开句柄数）、
 * 断点续传在真实 O_APPEND 语义下的正确性、取消后的真实残留状态、真实错误码。
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Events } from '@t1000/shared'
import type { EventEmitterFn } from '../../ipc/router'
import { TransferEngine } from './transfer'
import { connectTestSftpClient, type TestSftpConnection } from './test-sftp-client'
import { startTestSftpServer, type TestSftpServer } from './test-sftp-server'

let server: TestSftpServer
let conn: TestSftpConnection
let localRoot: string

interface Emitted {
  event: string
  payload: Record<string, unknown>
}

function harness(options: { maxInflightPerConnection?: number; chunkSize?: number } = {}): {
  engine: TransferEngine
  events: Emitted[]
  eventsOf(event: string): Emitted[]
} {
  const events: Emitted[] = []
  const emit = ((event: string, payload: Record<string, unknown>) => {
    events.push({ event, payload })
  }) as unknown as EventEmitterFn
  const engine = new TransferEngine({
    emit,
    resolveSftp: async () => conn.sftp,
    ...(options.maxInflightPerConnection === undefined
      ? {}
      : { settings: { maxInflightPerConnection: options.maxInflightPerConnection } }),
    ...(options.chunkSize === undefined ? {} : { chunkSize: options.chunkSize }),
    // 取消的 100ms 结束事件用短延迟，避免测试留长定时器
    schedule: (fn) => setTimeout(fn, 1),
  })
  return { engine, events, eventsOf: (e) => events.filter((x) => x.event === e) }
}

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled'])

async function waitFor(cond: () => boolean, timeoutMs = 20_000, label = '条件'): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`等待「${label}」超时`)
    await new Promise((r) => setTimeout(r, 5))
  }
}

async function waitDone(engine: TransferEngine, id: string): Promise<void> {
  await waitFor(() => TERMINAL.has(engine.getTask(id)?.state ?? 'queued'), 20_000, '传输结束')
}

function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex')
}

function hashOfFile(path: string): string {
  return sha256(readFileSync(path))
}

beforeAll(async () => {
  server = await startTestSftpServer()
  conn = await connectTestSftpClient(server)
  localRoot = mkdtempSync(join(tmpdir(), 't1000-sftp-local-'))
})

afterAll(async () => {
  await conn?.close()
  await server?.close()
  rmSync(localRoot, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------

describe('★ 大文件上传（跨多个 chunk，真实字节比对）', () => {
  it('3MB 文件上传后磁盘字节与源完全一致', async () => {
    const size = 3 * 1024 * 1024 + 12345 // 故意不整除，覆盖最后一截不完整的 chunk
    const payload = randomBytes(size)
    const localPath = join(localRoot, 'big.bin')
    writeFileSync(localPath, payload)

    const { engine, eventsOf } = harness({ chunkSize: 64 * 1024 })
    const task = engine.submit({
      sessionId: 's1',
      direction: 'upload',
      sourcePath: localPath,
      targetPath: '/big.bin',
    })
    await waitDone(engine, task.id)

    const state = engine.getTask(task.id)
    expect(state?.state).toBe('succeeded')
    expect(state?.bytesDone).toBe(size)

    const remotePath = join(server.root, 'big.bin')
    expect(statSync(remotePath).size).toBe(size)
    // 逐字节一致（hash 比对比 readFileSync 相等更省内存）
    expect(hashOfFile(remotePath)).toBe(sha256(payload))

    // 确实走了多轮真实 WRITE（不是一次性写入）
    const writes = server.log.filter((r) => r.op === 'WRITE' && r.path?.endsWith('big.bin'))
    expect(writes.length).toBeGreaterThan(10)
    expect(eventsOf(Events.SFTP_TRANSFER_FINISHED)).toHaveLength(1)
  })

  it('下载 3MB 文件：本地字节与远端一致', async () => {
    const payload = randomBytes(3 * 1024 * 1024 + 777)
    writeFileSync(join(server.root, 'dl.bin'), payload)

    const target = join(localRoot, 'dl.bin')
    const { engine } = harness({ chunkSize: 64 * 1024 })
    const task = engine.submit({
      sessionId: 's1',
      direction: 'download',
      sourcePath: '/dl.bin',
      targetPath: target,
    })
    await waitDone(engine, task.id)

    expect(engine.getTask(task.id)?.state).toBe('succeeded')
    expect(statSync(target).size).toBe(payload.length)
    expect(hashOfFile(target)).toBe(sha256(payload))
  })
})

describe('★ 目录递归（结构与每个文件的内容都要对）', () => {
  it('递归上传多层嵌套目录，远端结构与 hash 完全一致', async () => {
    const src = join(localRoot, 'tree')
    mkdirSync(join(src, 'a/b/c'), { recursive: true })
    const files: Record<string, Buffer> = {
      'root.txt': Buffer.from('ROOT'),
      'a/one.txt': randomBytes(70_000),
      'a/b/two.bin': randomBytes(200_000),
      'a/b/c/three.txt': Buffer.from('THREE'),
    }
    for (const [rel, content] of Object.entries(files)) {
      writeFileSync(join(src, rel), content)
    }

    const { engine, eventsOf } = harness()
    const task = engine.submit({
      sessionId: 's1',
      direction: 'upload',
      sourcePath: src,
      targetPath: '/uploaded',
      recursive: true,
    })
    await waitDone(engine, task.id)

    const state = engine.getTask(task.id)
    expect(state?.state).toBe('succeeded')
    expect(state?.filesTotal).toBe(4)

    // 目标 /uploaded 不存在 → 直接作为目录根（scp 语义）
    for (const [rel, content] of Object.entries(files)) {
      const remote = join(server.root, 'uploaded', rel)
      expect(existsSync(remote), rel).toBe(true)
      expect(hashOfFile(remote), rel).toBe(sha256(content))
    }
    expect(statSync(join(server.root, 'uploaded/a/b/c')).isDirectory()).toBe(true)

    const scanned = eventsOf(Events.SFTP_DIR_SCANNED)
    expect(scanned.at(-1)?.payload).toMatchObject({ files: 4 })
  })

  it('递归下载多层目录，本地结构与 hash 完全一致', async () => {
    mkdirSync(join(server.root, 'remote-tree/x/y'), { recursive: true })
    const files: Record<string, Buffer> = {
      'top.txt': Buffer.from('TOP'),
      'x/mid.bin': randomBytes(150_000),
      'x/y/leaf.txt': Buffer.from('LEAF'),
    }
    for (const [rel, content] of Object.entries(files)) {
      writeFileSync(join(server.root, 'remote-tree', rel), content)
    }

    const target = join(localRoot, 'downloaded')
    mkdirSync(target, { recursive: true })

    const { engine } = harness()
    const task = engine.submit({
      sessionId: 's1',
      direction: 'download',
      sourcePath: '/remote-tree',
      targetPath: target,
      recursive: true,
    })
    await waitDone(engine, task.id)

    expect(engine.getTask(task.id)?.state).toBe('succeeded')
    for (const [rel, content] of Object.entries(files)) {
      const local = join(target, 'remote-tree', rel)
      expect(existsSync(local), rel).toBe(true)
      expect(hashOfFile(local), rel).toBe(sha256(content))
    }
  })
})

describe('★ 并发（真实服务端观测）', () => {
  it('8 个并发上传：并发不超过 4、且内容不串', async () => {
    const count = 8
    const sources: Array<{ local: string; remote: string; hash: string }> = []
    for (let i = 0; i < count; i++) {
      const payload = randomBytes(400_000 + i * 1000) // 每个文件长度不同，串数据必被发现
      const local = join(localRoot, `c${i}.bin`)
      writeFileSync(local, payload)
      sources.push({ local, remote: `/conc/c${i}.bin`, hash: sha256(payload) })
    }
    mkdirSync(join(server.root, 'conc'))

    const { engine } = harness({ maxInflightPerConnection: 4, chunkSize: 32 * 1024 })
    const ids = sources.map(
      (s) => engine.submit({ sessionId: 's1', direction: 'upload', sourcePath: s.local, targetPath: s.remote }).id,
    )
    await waitFor(
      () => ids.every((id) => TERMINAL.has(engine.getTask(id)?.state ?? 'queued')),
      30_000,
      '并发上传结束',
    )

    for (const id of ids) expect(engine.getTask(id)?.state).toBe('succeeded')
    for (const s of sources) {
      expect(hashOfFile(join(server.root, s.remote.replace(/^\//, ''))), s.remote).toBe(s.hash)
    }
    // 真实服务端侧观测到的同时打开文件数 ≤ 闸门上限
    expect(server.maxConcurrentOpens).toBeLessThanOrEqual(4)
    expect(server.maxConcurrentOpens).toBeGreaterThan(1)
  })
})

describe('★ 取消与续传（真实 O_APPEND 语义）', () => {
  it('中途取消 → 远端只留半截；随后 resume 上传补齐且 hash 正确', async () => {
    const size = 4 * 1024 * 1024
    const payload = randomBytes(size)
    const localPath = join(localRoot, 'resumable.bin')
    writeFileSync(localPath, payload)

    // 小 chunk 让传输有足够多的分块，取消能稳定落在中途
    const { engine, eventsOf } = harness({ chunkSize: 16 * 1024 })
    const first = engine.submit({
      sessionId: 's1',
      direction: 'upload',
      sourcePath: localPath,
      targetPath: '/resumable.bin',
    })

    // 收到第一条进度就取消（此时已有一个 chunk 落盘）
    await waitFor(() => eventsOf(Events.SFTP_TRANSFER_PROGRESS).length > 0, 10_000, '首个进度事件')
    expect(engine.cancel(first.id)).toBe(true)
    await waitFor(() => engine.getTask(first.id)?.state === 'cancelled', 10_000, '状态变为 cancelled')

    const partial = join(server.root, 'resumable.bin')
    const partialSize = existsSync(partial) ? statSync(partial).size : 0
    // 行为被明确记录：取消会留下**部分文件**（这正是续传的前提），不假装什么都没发生
    expect(partialSize).toBeLessThan(size)
    expect(partialSize).toBeGreaterThan(0)
    // 已写入的部分必须与源文件**前缀一致**（不能是错位数据）
    expect(hashOfFile(partial)).toBe(sha256(payload.subarray(0, partialSize)))

    // 续传：从已传字节继续，最终必须与源完全一致
    const second = engine.submit({
      sessionId: 's1',
      direction: 'upload',
      sourcePath: localPath,
      targetPath: '/resumable.bin',
      resume: true,
    })
    await waitDone(engine, second.id)
    expect(engine.getTask(second.id)?.state).toBe('succeeded')
    expect(statSync(partial).size).toBe(size)
    expect(hashOfFile(partial)).toBe(sha256(payload))
  })

  it('取消后不再有新的写入（取消是生效的，不是只改状态）', async () => {
    const localPath = join(localRoot, 'cancel2.bin')
    writeFileSync(localPath, randomBytes(2 * 1024 * 1024))

    const { engine, eventsOf } = harness({ chunkSize: 16 * 1024 })
    const task = engine.submit({
      sessionId: 's1',
      direction: 'upload',
      sourcePath: localPath,
      targetPath: '/cancel2.bin',
    })
    await waitFor(() => eventsOf(Events.SFTP_TRANSFER_PROGRESS).length > 0, 10_000, '首个进度事件')
    engine.cancel(task.id)
    await waitFor(() => engine.getTask(task.id)?.state === 'cancelled', 10_000, '取消完成')

    const writesAtCancel = server.log.filter((r) => r.op === 'WRITE' && r.path?.endsWith('cancel2.bin')).length
    await new Promise((r) => setTimeout(r, 200))
    const writesAfter = server.log.filter((r) => r.op === 'WRITE' && r.path?.endsWith('cancel2.bin')).length
    expect(writesAfter).toBe(writesAtCancel)
  })
})

describe('真实服务端：冲突与权限', () => {
  it('conflict skip/rename/overwrite 在真实文件系统上的结果', async () => {
    writeFileSync(join(server.root, 'exists.txt'), 'OLD')
    const localPath = join(localRoot, 'photo.txt')
    writeFileSync(localPath, 'NEW')

    // skip
    const skip = harness()
    const t1 = skip.engine.submit({
      sessionId: 's1',
      direction: 'upload',
      sourcePath: localPath,
      targetPath: '/exists.txt',
      conflictPolicy: 'skip',
    })
    await waitDone(skip.engine, t1.id)
    expect(readFileSync(join(server.root, 'exists.txt'), 'utf8')).toBe('OLD')

    // rename → 真实出现 name (1).ext
    const rename = harness()
    const t2 = rename.engine.submit({
      sessionId: 's1',
      direction: 'upload',
      sourcePath: localPath,
      targetPath: '/exists.txt',
      conflictPolicy: 'rename',
    })
    await waitDone(rename.engine, t2.id)
    expect(readFileSync(join(server.root, 'exists (1).txt'), 'utf8')).toBe('NEW')
    expect(readFileSync(join(server.root, 'exists.txt'), 'utf8')).toBe('OLD')

    // overwrite
    const overwrite = harness()
    const t3 = overwrite.engine.submit({
      sessionId: 's1',
      direction: 'upload',
      sourcePath: localPath,
      targetPath: '/exists.txt',
      conflictPolicy: 'overwrite',
    })
    await waitDone(overwrite.engine, t3.id)
    expect(readFileSync(join(server.root, 'exists.txt'), 'utf8')).toBe('NEW')
  })

  it('preservePermissions 递归上传时逐文件 chmod（真实 mode 位）', async () => {
    const src = join(localRoot, 'perm-tree')
    mkdirSync(join(src, 'sub'), { recursive: true })
    writeFileSync(join(src, 'a.sh'), '#!/bin/sh\necho hi\n')
    writeFileSync(join(src, 'sub/b.txt'), 'b')
    if (process.platform !== 'win32') {
      require('node:fs').chmodSync(join(src, 'a.sh'), 0o750)
      require('node:fs').chmodSync(join(src, 'sub/b.txt'), 0o600)
    }

    const { engine } = harness()
    const task = engine.submit({
      sessionId: 's1',
      direction: 'upload',
      sourcePath: src,
      targetPath: '/perm-uploaded',
      recursive: true,
      preservePermissions: true,
    })
    await waitDone(engine, task.id)
    expect(engine.getTask(task.id)?.state).toBe('succeeded')

    if (process.platform !== 'win32') {
      expect(statSync(join(server.root, 'perm-uploaded/a.sh')).mode & 0o777).toBe(0o750)
      expect(statSync(join(server.root, 'perm-uploaded/sub/b.txt')).mode & 0o777).toBe(0o600)
    }
  })
})

describe('真实服务端：错误路径', () => {
  it('下载不存在的远端文件 → 任务失败，错误来自真实服务端', async () => {
    const before = server.log.length
    const { engine, eventsOf } = harness()
    const task = engine.submit({
      sessionId: 's1',
      direction: 'download',
      sourcePath: '/no-such-file.bin',
      targetPath: join(localRoot, 'no-such.bin'),
    })
    await waitDone(engine, task.id)

    expect(engine.getTask(task.id)?.state).toBe('failed')
    expect(eventsOf(Events.SFTP_TRANSFER_ERROR)).toHaveLength(1)
    // 不误判为成功：本地不应留下"成功"的产物
    expect(existsSync(join(localRoot, 'no-such.bin'))).toBe(false)

    const touched = server.log.slice(before)
    expect(touched.some((r) => r.status === 2)).toBe(true) // NO_SUCH_FILE 来自服务端
  })

  it('上传到只读远端目录 → 失败且错误码来自服务端', async () => {
    const roDir = join(server.root, 'ro-upload')
    mkdirSync(roDir)
    require('node:fs').chmodSync(roDir, 0o500)
    const localPath = join(localRoot, 'ro-src.txt')
    writeFileSync(localPath, 'x')

    try {
      const before = server.log.length
      const { engine } = harness()
      const task = engine.submit({
        sessionId: 's1',
        direction: 'upload',
        sourcePath: localPath,
        targetPath: '/ro-upload/out.txt',
      })
      await waitDone(engine, task.id)
      expect(engine.getTask(task.id)?.state).toBe('failed')
      const open = server.log.slice(before).find((r) => r.op === 'OPEN')
      expect(open?.status).toBe(3) // PERMISSION_DENIED 来自服务端
      expect(existsSync(join(roDir, 'out.txt'))).toBe(false)
    } finally {
      require('node:fs').chmodSync(roDir, 0o700)
    }
  })
})
