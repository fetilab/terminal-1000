// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 浏览层单测：列目录/stat/建目录/重命名/删除/chmod/读写/递归扫描。
 * 全部用手写假 SFTP，不连真实主机。
 */

import { describe, expect, it } from 'vitest'
import {
  CancelledScanError,
  chmodPath,
  ensureRemoteDirectory,
  listDirectory,
  lstatPath,
  makeDirectory,
  pathExists,
  readRemoteTextFile,
  rebaseRelativePath,
  removePath,
  remoteHome,
  renamePath,
  scanRemoteTree,
  statPath,
  writeRemoteTextFile,
  type SftpEntry,
  type SftpLike,
  type SftpStats,
} from './browser'

const DIR = 0o040000 | 0o755
const FILE = 0o100000 | 0o644
const LINK = 0o120000 | 0o777

/** 在 void 方法里安排延时回调：直接 `return later(...)` 会把 Timeout 值当返回值 */
const later = (fn: () => void, ms = 0): void => {
  setTimeout(fn, ms)
}

function stats(mode: number, size: number, mtime = 0): SftpStats {
  return {
    mode,
    uid: 0,
    gid: 0,
    size,
    atime: mtime,
    mtime,
    isDirectory: () => (mode & 0o170000) === 0o040000,
    isFile: () => (mode & 0o170000) === 0o100000,
    isSymbolicLink: () => (mode & 0o170000) === 0o120000,
  }
}

function noEnt(what: string): Error {
  const err = new Error(`No such file: ${what}`)
  ;(err as { code?: number }).code = 2
  return err
}

/** 紧凑的内存假远端：文件/目录/符号链接三张表 + 模式表 */
class SmallSftp implements SftpLike {
  readonly files = new Map<string, Buffer>()
  readonly dirs = new Set<string>(['/'])
  readonly links = new Set<string>()
  readonly modes = new Map<string, number>()
  readonly unlinked: string[] = []
  readonly mkdirs: string[] = []
  readonly renames: Array<{ from: string; to: string }> = []
  readonly chmods: Array<{ path: string; mode: number }> = []

  addDir(path: string): this {
    let cur = ''
    for (const p of path.split('/').filter((s) => s !== '')) {
      cur += `/${p}`
      this.dirs.add(cur)
      if (!this.modes.has(cur)) this.modes.set(cur, DIR)
    }
    return this
  }

  addFile(path: string, content: string | Buffer): this {
    this.files.set(path, Buffer.from(content))
    if (!this.modes.has(path)) this.modes.set(path, FILE)
    const idx = path.lastIndexOf('/')
    if (idx > 0) this.addDir(path.slice(0, idx))
    return this
  }

  addSymlink(path: string): this {
    this.links.add(path)
    this.modes.set(path, LINK)
    const idx = path.lastIndexOf('/')
    if (idx > 0) this.addDir(path.slice(0, idx))
    return this
  }

  private at(path: string): SftpStats | null {
    const mode = this.modes.get(path)
    if (mode === undefined) return null
    return stats(mode, this.files.get(path)?.length ?? 0)
  }

  readdir(location: string, cb: (err: Error | undefined, list: SftpEntry[]) => void): void {
    if (!this.dirs.has(location)) return later(() => cb(noEnt(location), []), 0)
    const prefix = location === '/' ? '/' : `${location}/`
    const names = new Set<string>()
    for (const d of this.dirs) if (d.startsWith(prefix)) names.add(d.slice(prefix.length))
    for (const f of this.files.keys()) if (f.startsWith(prefix)) names.add(f.slice(prefix.length))
    for (const l of this.links) if (l.startsWith(prefix)) names.add(l.slice(prefix.length))

    const out: SftpEntry[] = []
    for (const name of names) {
      if (name === '' || name.includes('/')) continue
      const full = location === '/' ? `/${name}` : `${location}/${name}`
      out.push({ filename: name, longname: `- ${name}`, attrs: this.at(full) ?? stats(FILE, 0) })
    }
    setTimeout(() => cb(undefined, out), 0)
  }

  stat(p: string, cb: (err: Error | undefined, s: SftpStats) => void): void {
    const s = this.at(p)
    setTimeout(() => (s ? cb(undefined, s) : cb(noEnt(p), stats(FILE, 0))), 0)
  }

  lstat(p: string, cb: (err: Error | undefined, s: SftpStats) => void): void {
    this.stat(p, cb)
  }

  mkdir(p: string, _a: { mode?: number }, cb: (err?: Error | null) => void): void {
    if (this.dirs.has(p) || this.files.has(p)) {
      const err = new Error('File exists')
      ;(err as { code?: number }).code = 4
      return later(() => cb(err), 0)
    }
    this.mkdirs.push(p)
    this.addDir(p)
    setTimeout(() => cb(), 0)
  }

  rmdir(p: string, cb: (err?: Error | null) => void): void {
    for (const k of [...this.files.keys(), ...this.links, ...this.dirs]) {
      if (k !== p && k.startsWith(`${p}/`)) return later(() => cb(new Error('Directory not empty')), 0)
    }
    this.dirs.delete(p)
    this.modes.delete(p)
    setTimeout(() => cb(), 0)
  }

  unlink(p: string, cb: (err?: Error | null) => void): void {
    if (this.links.delete(p)) {
      this.modes.delete(p)
      this.unlinked.push(p)
      return later(() => cb(), 0)
    }
    if (!this.files.delete(p)) return later(() => cb(noEnt(p)), 0)
    this.modes.delete(p)
    this.unlinked.push(p)
    setTimeout(() => cb(), 0)
  }

  rename(from: string, to: string, cb: (err?: Error | null) => void): void {
    const f = this.files.get(from)
    if (f) {
      this.files.delete(from)
      this.files.set(to, f)
    } else {
      this.dirs.delete(from)
      this.addDir(to)
    }
    const mode = this.modes.get(from)
    this.modes.delete(from)
    if (mode !== undefined) this.modes.set(to, mode)
    this.renames.push({ from, to })
    setTimeout(() => cb(), 0)
  }

  chmod(p: string, mode: number, cb: (err?: Error | null) => void): void {
    this.chmods.push({ path: p, mode })
    const cur = this.modes.get(p)
    if (cur !== undefined) this.modes.set(p, (cur & 0o170000) | (mode & 0o7777))
    setTimeout(() => cb(), 0)
  }

  readFile(p: string, cb: (err: Error | undefined, data: Buffer) => void): void {
    const f = this.files.get(p)
    setTimeout(() => (f ? cb(undefined, Buffer.from(f)) : cb(noEnt(p), Buffer.alloc(0))), 0)
  }

  writeFile(p: string, data: Buffer, cb?: (err?: Error | null) => void): void {
    this.files.set(p, Buffer.from(data))
    if (!this.modes.has(p)) this.modes.set(p, FILE)
    setTimeout(() => cb?.(), 0)
  }

  open(p: string, _mode: string, cb: (err: Error | undefined, handle: Buffer) => void): void {
    setTimeout(() => cb(undefined, Buffer.from(String(this.files.get(p)?.length ?? 0))), 0)
  }

  close(_h: Buffer, cb: (err?: Error | null) => void): void {
    setTimeout(() => cb(), 0)
  }

  read(
    _h: Buffer,
    buffer: Buffer,
    offset: number,
    length: number,
    _position: number,
    cb: (err: Error | undefined, bytesRead: number, buffer: Buffer) => void,
  ): void {
    setTimeout(() => cb(undefined, Math.min(length, buffer.length - offset), buffer), 0)
  }

  write(
    _h: Buffer,
    _b: Buffer,
    _o: number,
    _l: number,
    _p: number,
    cb: (err?: Error | null) => void,
  ): void {
    setTimeout(() => cb(), 0)
  }

  realpath(_p: string, cb: (err: Error | undefined, absPath: string) => void): void {
    setTimeout(() => cb(undefined, '/home/dev'), 0)
  }
}

async function expectReject(p: Promise<unknown>, re: RegExp): Promise<void> {
  await expect(p).rejects.toThrow(re)
}

describe('listDirectory', () => {
  it('目录在前、名字自然序，默认过滤隐藏项', async () => {
    const s = new SmallSftp()
      .addFile('/d/b.txt', 'b')
      .addFile('/d/a10.txt', 'a')
      .addFile('/d/a2.txt', 'a')
      .addFile('/d/.hidden', 'h')
      .addDir('/d/zdir')

    const list = await listDirectory(s, '/d')
    expect(list.map((e) => e.name)).toEqual(['zdir', 'a2.txt', 'a10.txt', 'b.txt'])
    expect(list[0]?.type).toBe('directory')
    expect(list[1]?.permissions).toBe('rw-r--r--')
    expect(list[1]?.path).toBe('/d/a2.txt')
  })

  it('showHidden=true 时包含点文件', async () => {
    const s = new SmallSftp().addFile('/d/.hidden', 'h').addFile('/d/vis', 'v')
    const list = await listDirectory(s, '/d', { showHidden: true })
    expect(list.map((e) => e.name)).toContain('.hidden')
  })

  it('规范化路径并跟随到子目录', async () => {
    const s = new SmallSftp().addFile('/d/sub/x', 'x')
    const list = await listDirectory(s, '/d//sub/./')
    expect(list.map((e) => e.name)).toEqual(['x'])
    expect(list[0]?.path).toBe('/d/sub/x')
  })
})

describe('statPath / lstatPath / pathExists', () => {
  it('返回类型、大小与权限', async () => {
    const s = new SmallSftp().addFile('/d/f.txt', 'hello')
    const st = await statPath(s, '/d/f.txt')
    expect(st).toMatchObject({ name: 'f.txt', type: 'file', size: 5, permissions: 'rw-r--r--' })

    const link = await lstatPath(new SmallSftp().addSymlink('/d/l'), '/d/l')
    expect(link.type).toBe('symlink')
  })

  it('pathExists 区分不存在与其它错误', async () => {
    const s = new SmallSftp().addFile('/d/f.txt', 'x')
    expect(await pathExists(s, '/d/f.txt')).toBe(true)
    expect(await pathExists(s, '/d/nope')).toBe(false)
  })
})

describe('makeDirectory / ensureRemoteDirectory', () => {
  it('mkdir 已存在时报冲突', async () => {
    const s = new SmallSftp().addDir('/d')
    await expectReject(makeDirectory(s, '/d'), /已存在/)
    await expectReject(makeDirectory(s, '/'), /根目录/)
  })

  it('ensureRemoteDirectory 递归建目录且幂等', async () => {
    const s = new SmallSftp()
    const created = await ensureRemoteDirectory(s, '/a/b/c')
    expect(created).toBe('/a/b/c')
    expect(s.dirs.has('/a/b/c')).toBe(true)
    expect(s.dirs.has('/a')).toBe(true)

    const before = s.mkdirs.length
    await ensureRemoteDirectory(s, '/a/b/c')
    expect(s.mkdirs.length).toBe(before)
  })

  it('ensureRemoteDirectory 遇到同名文件时报冲突', async () => {
    const s = new SmallSftp().addFile('/a/b', 'file')
    await expectReject(ensureRemoteDirectory(s, '/a/b/c'), /不是目录/)
  })
})

describe('renamePath / removePath', () => {
  it('目标已存在默认报冲突，overwrite 时替换', async () => {
    const s = new SmallSftp().addFile('/d/a', 'A').addFile('/d/b', 'B')
    await expectReject(renamePath(s, '/d/a', '/d/b'), /已存在/)

    await renamePath(s, '/d/a', '/d/b', { overwrite: true })
    expect(s.files.get('/d/b')?.toString()).toBe('A')
    expect(s.files.has('/d/a')).toBe(false)
  })

  it('同路径重命名是 no-op', async () => {
    const s = new SmallSftp().addFile('/d/a', 'A')
    await renamePath(s, '/d/a', '/d/a')
    expect(s.renames.length).toBe(0)
  })

  it('拒绝把路径重命名为根目录', async () => {
    const s = new SmallSftp().addFile('/d/a', 'A')
    await expectReject(renamePath(s, '/d/a', '/'), /根目录/)
  })

  it('删除文件与空目录；非递归删非空目录失败；递归删除整棵树', async () => {
    const s = new SmallSftp()
      .addFile('/tree/a.txt', 'A')
      .addFile('/tree/sub/b.txt', 'B')
      .addSymlink('/tree/link')

    await removePath(s, '/tree/a.txt')
    expect(s.unlinked).toContain('/tree/a.txt')

    await expectReject(removePath(s, '/tree'), /not empty/i)

    await removePath(s, '/tree', { recursive: true })
    expect(s.dirs.has('/tree/sub')).toBe(false)
    expect(s.dirs.has('/tree')).toBe(false)
    expect(s.unlinked).toContain('/tree/link')
  })

  it('拒绝删除根目录', async () => {
    await expectReject(removePath(new SmallSftp(), '/', { recursive: true }), /根目录/)
  })
})

describe('chmod / 读写文件', () => {
  it('chmod 接受八进制字符串', async () => {
    const s = new SmallSftp().addFile('/d/f', 'x')
    await chmodPath(s, '/d/f', '600')
    expect(s.chmods[0]).toEqual({ path: '/d/f', mode: 0o600 })
  })

  it('读写文本文件往返一致', async () => {
    const s = new SmallSftp().addDir('/d')
    const written = await writeRemoteTextFile(s, '/d/f.txt', '你好\nworld')
    expect(written.size).toBe(Buffer.byteLength('你好\nworld'))

    const read = await readRemoteTextFile(s, '/d/f.txt')
    expect(read.content).toBe('你好\nworld')
    expect(read.path).toBe('/d/f.txt')
  })

  it('超过上限拒绝读取（不静默截断）；目录不可按文件读', async () => {
    const s = new SmallSftp().addFile('/d/big', 'x'.repeat(100)).addDir('/d/dir')
    await expectReject(readRemoteTextFile(s, '/d/big', { maxBytes: 10 }), /文件过大/)
    await expectReject(readRemoteTextFile(s, '/d/dir'), /不能按文件读取/)
  })

  it('remoteHome 用 realpath 结果', async () => {
    expect(await remoteHome(new SmallSftp())).toBe('/home/dev')
  })
})

describe('scanRemoteTree', () => {
  it('统计文件数/字节数/子目录，且不跟进符号链接', async () => {
    const s = new SmallSftp()
      .addFile('/r/a.txt', 'AAAA')
      .addFile('/r/sub/b.txt', 'BB')
      .addSymlink('/r/link-to-dir')

    const progress: Array<{ files: number; bytes: number }> = []
    const tree = await scanRemoteTree(s, '/r', {
      progressEvery: 1,
      onProgress: (p) => progress.push({ files: p.files, bytes: p.bytes }),
    })

    expect(tree.filesTotal).toBe(3) // a.txt + sub/b.txt + 符号链接（当文件，不跟进）
    expect(tree.bytesTotal).toBe(6)
    expect(tree.dirs).toEqual(['sub'])
    expect(tree.files.find((f) => f.relativePath === 'sub/b.txt')?.absolutePath).toBe('/r/sub/b.txt')
    expect(progress.length).toBeGreaterThan(0)
  })

  it('单文件也可扫描（返回自身）', async () => {
    const s = new SmallSftp().addFile('/r/only.txt', 'XYZ')
    const tree = await scanRemoteTree(s, '/r/only.txt')
    expect(tree.filesTotal).toBe(1)
    expect(tree.files[0]?.relativePath).toBe('only.txt')
    expect(tree.bytesTotal).toBe(3)
  })

  it('isCancelled 返回 true 时抛出 CancelledScanError', async () => {
    const s = new SmallSftp().addFile('/r/a', 'A')
    await expectReject(scanRemoteTree(s, '/r', { isCancelled: () => true }), /扫描已取消/)
    await expect(
      scanRemoteTree(s, '/r', { isCancelled: () => true }),
    ).rejects.toBeInstanceOf(CancelledScanError)
  })

  it('超过深度上限时报错而不是无限递归', async () => {
    const s = new SmallSftp().addFile('/r/a/b/c/d.txt', 'x')
    await expectReject(scanRemoteTree(s, '/r', { maxDepth: 1 }), /层级超过上限/)
  })

  it('超过条目上限时报错', async () => {
    const s = new SmallSftp().addFile('/r/a', 'a').addFile('/r/b', 'b')
    await expectReject(scanRemoteTree(s, '/r', { maxEntries: 1 }), /超过上限/)
  })
})

describe('rebaseRelativePath', () => {
  it('把相对路径挂到目标根下', () => {
    expect(rebaseRelativePath('/dst', 'a/b.txt')).toBe('/dst/a/b.txt')
    expect(rebaseRelativePath('/dst', 'a/../b.txt')).toBe('/dst/b.txt')
  })

  it('拒绝相对路径里的危险段', () => {
    expect(() => rebaseRelativePath('/dst', '../etc/passwd')).toThrow(/越出目标目录/)
  })
})
