// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 本地文件系统后端单测：用临时目录构造一棵真实目录树，
 * 通过业务函数（listDirectory/chmodPath/…）驱动 fs 后端，验证映射语义。
 *
 * 覆盖点：
 * - 列目录的条目形状（类型/大小/权限/mtime 秒/uid/gid）与隐藏过滤、排序；
 * - `~`/`.` 的 home 映射（主目录按钮与 sftp.home 的路径）；
 * - 建目录/重命名/删除（含递归与根目录保护）/chmod/读写；
 * - handle 读写（TransferEngine 的传输路径走的就是 open/read/write/close）；
 * - 会话判别 isLocalSession（pty→本地、ssh→非本地、未知→非本地）。
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { homedir } from 'node:os'
import {
  chmodPath,
  listDirectory,
  makeDirectory,
  pathExists,
  readRemoteTextFile,
  remoteHome,
  removePath,
  renamePath,
  sftpFs,
  statPath,
  writeRemoteTextFile,
} from './browser'
import { createLocalSftpLike, isLocalSession, resolveLocalPath } from './local-backend'
import { registerWritable, unregisterWritable } from '../session-registry'

let root = ''
const sftp = createLocalSftpLike()

beforeAll(() => {
  root = fs.mkdtempSync(join(tmpdir(), 't1000-local-sftp-'))
  // 一棵小树：文件/子目录/隐藏文件/符号链接；模式显式 chmod，摆脱 umask 影响
  fs.writeFileSync(join(root, 'alpha.txt'), 'hello')
  fs.writeFileSync(join(root, 'beta.log'), 'x'.repeat(300))
  fs.mkdirSync(join(root, 'sub'))
  fs.writeFileSync(join(root, 'sub', 'inner.txt'), 'inner')
  fs.writeFileSync(join(root, '.hidden'), 'h')
  fs.symlinkSync(join(root, 'alpha.txt'), join(root, 'link-to-alpha'))
  fs.chmodSync(join(root, 'alpha.txt'), 0o640)
  fs.chmodSync(join(root, 'beta.log'), 0o600)
  fs.chmodSync(join(root, 'sub'), 0o750)
})

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('isLocalSession', () => {
  it('pty 会话为 true，ssh 会话与未知会话为 false', () => {
    registerWritable({
      sessionId: 'local-backend-pty',
      kind: 'pty',
      title: '本地终端',
      write: () => {},
      canWrite: () => true,
    })
    registerWritable({
      sessionId: 'local-backend-ssh',
      kind: 'ssh',
      title: '远端',
      write: () => {},
      canWrite: () => true,
    })
    expect(isLocalSession('local-backend-pty')).toBe(true)
    expect(isLocalSession('local-backend-ssh')).toBe(false)
    expect(isLocalSession('no-such-session')).toBe(false)
    unregisterWritable('local-backend-pty')
    unregisterWritable('local-backend-ssh')
  })
})

describe('resolveLocalPath', () => {
  it('`~`、`/~` 与 `.` 映射到 home；`/~/x` 挂到 home 下；绝对路径原样透传', () => {
    const home = homedir()
    expect(resolveLocalPath('~')).toBe(home)
    expect(resolveLocalPath('/~')).toBe(home)
    expect(resolveLocalPath('.')).toBe(home)
    expect(resolveLocalPath('/~/docs/a.txt')).toBe(`${home}/docs/a.txt`)
    expect(resolveLocalPath('/etc/hosts')).toBe('/etc/hosts')
  })
})

describe('listDirectory（经业务函数走本地后端）', () => {
  it('列出全部条目，类型/大小/权限/mtime(秒)/uid/gid 与 fs.stat 一致', async () => {
    const entries = await listDirectory(sftp, root, { showHidden: true })
    const names = entries.map((e) => e.name)
    // 目录排最前，其余按名字自然序
    expect(names).toEqual(['sub', '.hidden', 'alpha.txt', 'beta.log', 'link-to-alpha'])

    const byName = new Map(entries.map((e) => [e.name, e]))
    const realAlpha = fs.statSync(join(root, 'alpha.txt'))
    const alpha = byName.get('alpha.txt')
    expect(alpha?.type).toBe('file')
    expect(alpha?.size).toBe(5)
    expect(alpha?.permissions).toBe('rw-r-----')
    expect(alpha?.mtime).toBe(Math.floor(realAlpha.mtimeMs / 1000))
    expect(alpha?.uid).toBe(realAlpha.uid)
    expect(alpha?.gid).toBe(realAlpha.gid)
    expect(alpha?.path).toBe(`${root}/alpha.txt`)

    const sub = byName.get('sub')
    expect(sub?.type).toBe('directory')
    const link = byName.get('link-to-alpha')
    // readdir 的 attrs 按 lstat 取：链接本身是 symlink，不跟随到目标文件
    expect(link?.type).toBe('symlink')

    // 目录排在前、其余按名字序（listDirectory 的固定排序）
    expect(entries[0]?.name).toBe('sub')
  })

  it('默认隐藏以 . 开头的条目', async () => {
    const entries = await listDirectory(sftp, root)
    expect(entries.map((e) => e.name)).not.toContain('.hidden')
  })

  it('`~` 路径映射到本机 home（主目录按钮传的就是 `~`）', async () => {
    // 归一化后 `~` 变成 `/~`，后端要把它映射回 home 再交给 fs
    const entries = await listDirectory(sftp, '~')
    const homeNames = new Set(fs.readdirSync(homedir()))
    for (const entry of entries) {
      expect(homeNames.has(entry.name)).toBe(true)
    }
  })

  it('home 动作（realpath）返回本机 home 而不是进程 cwd', async () => {
    const home = await remoteHome(sftp)
    expect(home === '/' || home === homedir().replace(/\/+$/, '')).toBe(true)
  })
})

describe('stat / pathExists', () => {
  it('stat 返回与 fs 一致的条目；不存在的路径可判别', async () => {
    const entry = await statPath(sftp, join(root, 'alpha.txt'))
    expect(entry.type).toBe('file')
    expect(entry.size).toBe(5)
    expect(await pathExists(sftp, join(root, 'alpha.txt'))).toBe(true)
    expect(await pathExists(sftp, join(root, 'nope.txt'))).toBe(false)
  })
})

describe('makeDirectory / renamePath / removePath', () => {
  it('建目录后可见；重复建目录报冲突', async () => {
    const created = await makeDirectory(sftp, join(root, 'made'))
    expect(created.type).toBe('directory')
    await expect(makeDirectory(sftp, join(root, 'made'))).rejects.toThrow(/目录已存在/)
    expect(fs.existsSync(join(root, 'made'))).toBe(true)
    fs.rmdirSync(join(root, 'made'))
  })

  it('重命名成功；目标已存在且未勾覆盖时报冲突', async () => {
    fs.writeFileSync(join(root, 'rn-src'), 'a')
    await renamePath(sftp, join(root, 'rn-src'), join(root, 'rn-dst'))
    expect(fs.existsSync(join(root, 'rn-src'))).toBe(false)
    expect(fs.readFileSync(join(root, 'rn-dst'), 'utf8')).toBe('a')

    fs.writeFileSync(join(root, 'rn-occupied'), 'b')
    await expect(
      renamePath(sftp, join(root, 'rn-dst'), join(root, 'rn-occupied')),
    ).rejects.toThrow(/目标已存在/)
    // 原文件仍在（没有静默覆盖）
    expect(fs.readFileSync(join(root, 'rn-dst'), 'utf8')).toBe('a')
    fs.rmSync(join(root, 'rn-dst'))
    fs.rmSync(join(root, 'rn-occupied'))
  })

  it('非递归删除非空目录报错；递归删除整棵子树；拒绝删根目录', async () => {
    const tree = join(root, 'rm-tree')
    fs.mkdirSync(join(tree, 'deep'), { recursive: true })
    fs.writeFileSync(join(tree, 'a.txt'), 'a')
    fs.writeFileSync(join(tree, 'deep', 'b.txt'), 'b')

    await expect(removePath(sftp, tree, { recursive: false })).rejects.toThrow(/ENOTEMPTY/)
    await removePath(sftp, tree, { recursive: true })
    expect(fs.existsSync(tree)).toBe(false)

    await expect(removePath(sftp, '/', { recursive: false })).rejects.toThrow(/拒绝删除根目录/)
  })
})

describe('chmodPath', () => {
  it('改权限生效（测试进程属主，允许 chmod）', async () => {
    const target = join(root, 'beta.log')
    const result = await chmodPath(sftp, target, 0o604)
    expect(result.changed).toBe(1)
    expect(result.failed).toEqual([])
    expect((fs.statSync(target).mode & 0o777) === 0o604).toBe(true)
    fs.chmodSync(target, 0o600)
  })
})

describe('readRemoteTextFile / writeRemoteTextFile', () => {
  it('读写回环一致；超过 maxBytes 拒绝读取', async () => {
    const target = join(root, 'io.txt')
    const written = await writeRemoteTextFile(sftp, target, '中文内容 ok')
    expect(written.size).toBe(Buffer.byteLength('中文内容 ok'))
    const read = await readRemoteTextFile(sftp, target)
    expect(read.content).toBe('中文内容 ok')

    await expect(readRemoteTextFile(sftp, target, { maxBytes: 2 })).rejects.toThrow(/文件过大/)
    fs.rmSync(target)
  })
})

describe('handle 读写（TransferEngine 的传输路径）', () => {
  it('open/read/write/close 走本机 fd，句柄 Buffer 编码透明', async () => {
    const target = join(root, 'handle.bin')
    const handle = await sftpFs.open(sftp, target, 'w')
    const payload = Buffer.from('chunk-one')
    await sftpFs.write(sftp, handle, payload, 0, payload.length, 0)
    await sftpFs.close(sftp, handle)

    const readHandle = await sftpFs.open(sftp, target, 'r')
    const buffer = Buffer.alloc(payload.length)
    const bytesRead = await sftpFs.read(sftp, readHandle, buffer, 0, buffer.length, 0)
    await sftpFs.close(sftp, readHandle)
    expect(bytesRead).toBe(payload.length)
    expect(buffer.toString('utf8')).toBe('chunk-one')
    fs.rmSync(target)
  })

  it('非法句柄显式报错，不静默错写', async () => {
    const bogus = Buffer.from('not-a-handle', 'utf8')
    await expect(sftpFs.close(sftp, bogus)).rejects.toThrow(/非法的本地文件句柄/)
  })
})
