// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 浏览层的**真实协议**端到端测试。
 *
 * 与 `browser.test.ts`（手写 SmallSftp 桩）互补：这里起真实 ssh2 Server + 真实 SFTP 子系统，
 * 底层是真实临时目录，客户端是真实 ssh2 Client 走真实 socket。
 * 因此它能发现"我们对 SFTP 协议本身的理解偏差"（报文结构、错误码、readdir 语义…）。
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync, symlinkSync, lstatSync } from 'node:fs'
import { join } from 'node:path'
import {
  chmodPath,
  ensureRemoteDirectory,
  listDirectory,
  lstatPath,
  makeDirectory,
  pathExists,
  readRemoteTextFile,
  remoteHome,
  removePath,
  renamePath,
  scanRemoteTree,
  sftpFs,
  statPath,
  writeRemoteTextFile,
} from './browser'
import { connectTestSftpClient, type TestSftpConnection } from './test-sftp-client'
import { startTestSftpServer, type TestSftpServer } from './test-sftp-server'

let server: TestSftpServer
let conn: TestSftpConnection

beforeAll(async () => {
  server = await startTestSftpServer()
  conn = await connectTestSftpClient(server)

  // 真实文件系统夹具
  mkdirSync(join(server.root, 'docs'))
  writeFileSync(join(server.root, 'a.txt'), 'hello')          // 5 字节
  writeFileSync(join(server.root, 'docs', 'b.txt'), 'world!') // 6 字节
  writeFileSync(join(server.root, '.hidden'), 'secret')
  symlinkSync('a.txt', join(server.root, 'link-to-a'))
  symlinkSync('docs', join(server.root, 'link-to-docs'))
})

afterAll(async () => {
  await conn?.close()
  await server?.close()
})

describe('真实服务端：列目录（含符号链接与隐藏文件）', () => {
  it('条目的类型/大小/时间戳与真实 stat 一致', async () => {
    const entries = await listDirectory(conn.sftp, '/')
    const names = entries.map((e) => e.name)
    // 默认隐藏以 . 开头的条目
    expect(names).not.toContain('.hidden')
    expect(names).toContain('a.txt')
    expect(names).toContain('docs')

    const a = entries.find((e) => e.name === 'a.txt')!
    const realA = statSync(join(server.root, 'a.txt'))
    expect(a.type).toBe('file')
    expect(a.size).toBe(realA.size)
    expect(a.mode).toBe(realA.mode & 0o7777)
    expect(a.permissions).toHaveLength(9)
    expect(a.mtime).toBe(Math.floor(realA.mtimeMs / 1000))
    // longname 来自真实服务端（我们只透传，不自己拼）
    expect(a.longname).toContain('a.txt')

    const docs = entries.find((e) => e.name === 'docs')!
    expect(docs.type).toBe('directory')
    expect(docs.size).toBe(statSync(join(server.root, 'docs')).size)
  })

  it('符号链接被识别为 symlink（readdir 用的是 lstat 语义，不能跟进）', async () => {
    const entries = await listDirectory(conn.sftp, '/', { showHidden: true })
    const link = entries.find((e) => e.name === 'link-to-a')!
    expect(link.type).toBe('symlink')
    // 真实 lstat 的 size 是链接自身长度（'a.txt' = 5），不是目标文件大小
    expect(link.size).toBe(lstatSync(join(server.root, 'link-to-a')).size)

    const dirLink = entries.find((e) => e.name === 'link-to-docs')!
    expect(dirLink.type).toBe('symlink')
  })

  it('showHidden=true 时包含点文件', async () => {
    const entries = await listDirectory(conn.sftp, '/', { showHidden: true })
    expect(entries.map((e) => e.name)).toContain('.hidden')
  })

  it('目录排在前、名称自然序（真实服务端条目顺序不可依赖）', async () => {
    const entries = await listDirectory(conn.sftp, '/', { showHidden: true })
    const firstFileIndex = entries.findIndex((e) => e.type !== 'directory')
    const lastDirIndex = entries.map((e) => e.type).lastIndexOf('directory')
    expect(lastDirIndex).toBeLessThan(firstFileIndex)
  })
})

describe('真实服务端：stat / lstat / pathExists', () => {
  it('statPath 跟随符号链接，lstatPath 不跟随', async () => {
    const viaStat = await statPath(conn.sftp, '/link-to-a')
    expect(viaStat.type).toBe('file')
    expect(viaStat.size).toBe(5)

    const viaLstat = await lstatPath(conn.sftp, '/link-to-a')
    expect(viaLstat.type).toBe('symlink')
  })

  it('pathExists 正确区分"不存在"与其它错误（依赖真实 NO_SUCH_FILE=2）', async () => {
    expect(await pathExists(conn.sftp, '/a.txt')).toBe(true)
    expect(await pathExists(conn.sftp, '/nope.txt')).toBe(false)
    expect(await pathExists(conn.sftp, '/docs/b.txt')).toBe(true)
  })
})

describe('真实服务端：建目录 / 改名 / 删除', () => {
  it('mkdir 真实落盘；重复建报冲突（真实 EEXIST）', async () => {
    await makeDirectory(conn.sftp, '/newdir')
    expect(existsSync(join(server.root, 'newdir'))).toBe(true)
    expect(statSync(join(server.root, 'newdir')).isDirectory()).toBe(true)

    const created = await makeDirectory(conn.sftp, '/newdir/with-mode', 0o700)
    expect(existsSync(join(server.root, 'newdir/with-mode'))).toBe(true)
    if (process.platform !== 'win32') {
      expect(statSync(join(server.root, 'newdir/with-mode')).mode & 0o777).toBe(0o700)
    }
    expect(created.type).toBe('directory')

    await expect(makeDirectory(conn.sftp, '/newdir')).rejects.toThrow()
  })

  it('ensureRemoteDirectory 递归建多级目录且幂等', async () => {
    const created = await ensureRemoteDirectory(conn.sftp, '/deep/a/b/c')
    expect(created).toBe('/deep/a/b/c')
    expect(statSync(join(server.root, 'deep/a/b/c')).isDirectory()).toBe(true)
    await ensureRemoteDirectory(conn.sftp, '/deep/a/b/c') // 幂等
    expect(existsSync(join(server.root, 'deep/a'))).toBe(true)
  })

  it('rename 真实改名；目标已存在时报冲突；overwrite 才能替换', async () => {
    writeFileSync(join(server.root, 'r1.txt'), 'one')
    writeFileSync(join(server.root, 'r2.txt'), 'two')

    await expect(renamePath(conn.sftp, '/r1.txt', '/r2.txt')).rejects.toThrow()
    expect(readFileSync(join(server.root, 'r2.txt'), 'utf8')).toBe('two')

    await renamePath(conn.sftp, '/r1.txt', '/r2.txt', { overwrite: true })
    expect(readFileSync(join(server.root, 'r2.txt'), 'utf8')).toBe('one')
    expect(existsSync(join(server.root, 'r1.txt'))).toBe(false)

    await renamePath(conn.sftp, '/r2.txt', '/r3.txt')
    expect(existsSync(join(server.root, 'r3.txt'))).toBe(true)
  })

  it('删除文件 / 非空目录必须递归 / 递归删除整棵树', async () => {
    writeFileSync(join(server.root, 'gone.txt'), 'x')
    await removePath(conn.sftp, '/gone.txt')
    expect(existsSync(join(server.root, 'gone.txt'))).toBe(false)

    mkdirSync(join(server.root, 'tree/sub'), { recursive: true })
    writeFileSync(join(server.root, 'tree/sub/f.txt'), 'y')
    // 非递归删非空目录 → 真实服务端回 FAILURE
    await expect(removePath(conn.sftp, '/tree')).rejects.toThrow()
    expect(existsSync(join(server.root, 'tree/sub/f.txt'))).toBe(true)

    await removePath(conn.sftp, '/tree', { recursive: true })
    expect(existsSync(join(server.root, 'tree'))).toBe(false)
  })

  it('删除符号链接只删链接本身（不删目标）', async () => {
    symlinkSync('a.txt', join(server.root, 'tmp-link'))
    await removePath(conn.sftp, '/tmp-link')
    expect(existsSync(join(server.root, 'tmp-link'))).toBe(false)
    expect(existsSync(join(server.root, 'a.txt'))).toBe(true)
  })

  it('拒绝删除根目录（本地防护，不发请求）', async () => {
    const before = server.log.length
    await expect(removePath(conn.sftp, '/', { recursive: true })).rejects.toThrow(/根目录/)
    expect(server.log.length).toBe(before)
  })
})

describe('真实服务端：权限（chmod）', () => {
  it('chmod 真实改变 mode 位', async () => {
    writeFileSync(join(server.root, 'perm.txt'), 'p')
    await chmodPath(conn.sftp, '/perm.txt', '600')
    if (process.platform !== 'win32') {
      expect(statSync(join(server.root, 'perm.txt')).mode & 0o777).toBe(0o600)
    }
    // 我们模块读回的 permissions 也要反映真实变化
    const entry = await statPath(conn.sftp, '/perm.txt')
    expect(entry.mode).toBe(statSync(join(server.root, 'perm.txt')).mode & 0o7777)
  })
})

describe('真实服务端：读写文本', () => {
  it('写文件真实落盘，读回来一致', async () => {
    const content = 'line1\nline2\n中文\n'
    const written = await writeRemoteTextFile(conn.sftp, '/text.txt', content)
    expect(written.size).toBe(Buffer.byteLength(content))
    expect(readFileSync(join(server.root, 'text.txt'), 'utf8')).toBe(content)

    const read = await readRemoteTextFile(conn.sftp, '/text.txt')
    expect(read.content).toBe(content)
    expect(read.size).toBe(Buffer.byteLength(content))
  })

  it('超过上限拒绝读取（不静默截断）', async () => {
    writeFileSync(join(server.root, 'big.txt'), 'x'.repeat(1000))
    await expect(readRemoteTextFile(conn.sftp, '/big.txt', { maxBytes: 10 })).rejects.toThrow(/文件过大/)
  })

  it('目录不能按文件读', async () => {
    await expect(readRemoteTextFile(conn.sftp, '/docs')).rejects.toThrow(/不能按文件读取/)
  })

  it('remoteHome 通过真实 REALPATH 得到 "/"', async () => {
    expect(await remoteHome(conn.sftp)).toBe('/')
  })
})

describe('真实服务端：错误语义（码来自服务端而非我们猜测）', () => {
  it('读不存在的文件：服务端回 NO_SUCH_FILE(2)，我们不以成功收场', async () => {
    const before = server.log.length
    await expect(readRemoteTextFile(conn.sftp, '/definitely-missing')).rejects.toThrow()

    const stat = server.log.slice(before).find((r) => r.op === 'STAT')
    expect(stat?.status).toBe(2) // 真实服务端给的状态码
    // 我们的 isNoSuchFile 认得出它 → pathExists 返回 false 而不是抛错
    expect(await pathExists(conn.sftp, '/definitely-missing')).toBe(false)
  })

  it('删非空目录：服务端回非 OK，我们报错而不是"删成功"', async () => {
    mkdirSync(join(server.root, 'nonempty'), { recursive: true })
    writeFileSync(join(server.root, 'nonempty/keep.txt'), 'k')

    const before = server.log.length
    await expect(removePath(conn.sftp, '/nonempty')).rejects.toThrow()
    const rmdir = server.log.slice(before).find((r) => r.op === 'RMDIR')
    expect(rmdir?.status).not.toBe(0)
    // 文件必须还在（没有被误删）
    expect(existsSync(join(server.root, 'nonempty/keep.txt'))).toBe(true)
  })

  it('在只读目录里建文件：服务端回 PERMISSION_DENIED(3)', async () => {
    const roDir = join(server.root, 'readonly')
    mkdirSync(roDir)
    chmodSync(roDir, 0o500) // r-x：不可写

    const before = server.log.length
    try {
      await expect(writeRemoteTextFile(conn.sftp, '/readonly/nope.txt', 'x')).rejects.toThrow()
      const open = server.log.slice(before).find((r) => r.op === 'OPEN')
      expect(open?.status).toBe(3)
    } finally {
      chmodSync(roDir, 0o700) // 让清理能删掉它
    }
  })

  it('raw 层请求越出 root 的路径：真实服务端拒绝（证明夹具是 chroot 式隔离）', async () => {
    // 我们模块的 normalizeRemotePath 会先拦掉，这里刻意绕过它直接打协议层
    await expect(sftpFs.stat(conn.sftp, '/../escape')).rejects.toThrow()
    const denied = server.log.filter((r) => r.op === 'STAT' && r.status === 3)
    expect(denied.length).toBeGreaterThan(0)
  })
})

describe('真实服务端：递归扫描', () => {
  it('统计文件数/字节数与真实磁盘一致，且不跟进符号链接', async () => {
    mkdirSync(join(server.root, 'scan/x/y'), { recursive: true })
    writeFileSync(join(server.root, 'scan/1.txt'), 'AAAA')
    writeFileSync(join(server.root, 'scan/x/2.txt'), 'BB')
    writeFileSync(join(server.root, 'scan/x/y/3.txt'), 'C')
    symlinkSync(join(server.root, 'scan/x'), join(server.root, 'scan/cyclic'))

    const tree = await scanRemoteTree(conn.sftp, '/scan')
    expect(tree.filesTotal).toBe(4) // 3 个文件 + 1 个符号链接（当文件，不递归跟进）
    expect(tree.bytesTotal).toBe(4 + 2 + 1 + lstatSync(join(server.root, 'scan/cyclic')).size)
    expect(tree.dirs.sort()).toEqual(['x', 'x/y'])
    expect(tree.files.map((f) => f.relativePath).sort()).toEqual(['1.txt', 'cyclic', 'x/2.txt', 'x/y/3.txt'])
  })

  it('单文件扫描返回自身', async () => {
    const tree = await scanRemoteTree(conn.sftp, '/a.txt')
    expect(tree.filesTotal).toBe(1)
    expect(tree.bytesTotal).toBe(5)
    expect(tree.files[0]?.absolutePath).toBe('/a.txt')
  })
})
