// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 递归 chmod 与「预备命令预览」测试。
 *
 * 递归 chmod 是**影响面很大**的操作（spec 自己写着"相当于 chmod -R"），
 * 所以这里重点不在"能不能改"，而在**边界**：
 * - 不勾递归时**绝不能**动子项
 * - **不跟随符号链接**（跟随会改到链接指向的目标，往往不是用户想动的路径）
 * - **拒绝在 `/` 上递归**
 * - 条目数有上限且**如实报告被截断**（悄悄少改 = 假的成功）
 * - 逐项失败要**收集**而不是中断
 */

import { describe, expect, it, vi } from 'vitest'
import { AppError } from '../../errors'
import type { SftpLike } from './browser'
import { chmodPath, planChmod } from './browser'

const DIR = 0o040000
const FILE = 0o100000
const LINK = 0o120000

interface FakeEntry {
  name: string
  type: number // 0o040000 目录 / 0o100000 文件 / 0o120000 链接
}

/** 用路径 → 子项表搭一棵假树；lstat 从表里推类型 */
function fakeTree(tree: Record<string, FakeEntry[]>): {
  sftp: SftpLike
  chmods: Array<{ path: string; mode: number }>
} {
  const typeOf = (p: string): number => {
    if (p === '/') return DIR | 0o755
    const parent = p.slice(0, p.lastIndexOf('/')) || '/'
    const name = p.slice(p.lastIndexOf('/') + 1)
    const found = (tree[parent] ?? []).find((e) => e.name === name)
    return (found?.type ?? FILE) | 0o644
  }
  const chmods: Array<{ path: string; mode: number }> = []
  const sftp = {
    lstat: (p: string, cb: (err: Error | null, stats?: unknown) => void) =>
      cb(null, {
        mode: typeOf(p),
        isDirectory: () => (typeOf(p) & 0o170000) === DIR,
        isFile: () => (typeOf(p) & 0o170000) === FILE,
        isSymbolicLink: () => (typeOf(p) & 0o170000) === LINK,
      }),
    readdir: (p: string, cb: (err: Error | null, list?: unknown) => void) =>
      cb(
        null,
        (tree[p] ?? []).map((e) => ({
          filename: e.name,
          attrs: {
            mode: e.type | 0o644,
            isDirectory: () => (e.type & 0o170000) === DIR,
          },
        })),
      ),
    chmod: (p: string, mode: number, cb: (err: Error | null) => void) => {
      chmods.push({ path: p, mode })
      cb(null)
    },
  } as unknown as SftpLike
  return { sftp, chmods }
}

const TREE = {
  '/': [{ name: 'app', type: DIR }],
  '/app': [
    { name: 'bin', type: DIR },
    { name: 'readme.txt', type: FILE },
    { name: 'link-to-etc', type: LINK },
  ],
  '/app/bin': [
    { name: 'run.sh', type: FILE },
    { name: 'start.sh', type: FILE },
  ],
}

describe('planChmod —— 只算不改', () => {
  it('不勾递归：只动目录自身（绝不碰子项）', async () => {
    const { sftp, chmods } = fakeTree(TREE)
    const plan = await planChmod(sftp, '/app', '755')
    expect(plan.entries).toEqual(['/app'])
    expect(plan.summary).toBe('chmod 755 /app')
    expect(chmods, '计划阶段不应真的改权限').toHaveLength(0)
  })

  it('★ 勾递归：目录自身 + 所有后代都进计划', async () => {
    const { sftp } = fakeTree(TREE)
    const plan = await planChmod(sftp, '/app', '755', { recursive: true })
    expect(plan.entries).toContain('/app')
    expect(plan.entries).toContain('/app/bin')
    expect(plan.entries).toContain('/app/bin/run.sh')
    expect(plan.entries).toContain('/app/readme.txt')
    // 汇总行等价于 shell
    expect(plan.summary).toBe('chmod -R 755 /app')
    // 明细命令与条目对应
    expect(plan.commands[0]).toBe('chmod 755 /app')
  })

  it('★ 不跟随符号链接（跟随会改到链接指向的目标）', async () => {
    const { sftp } = fakeTree({
      ...TREE,
      // 若实现跟随了链接，就会去读 /app/link-to-etc 这个"目录"
      '/app/link-to-etc': [{ name: 'passwd', type: FILE }],
    })
    const plan = await planChmod(sftp, '/app', '755', { recursive: true })
    // 链接自身会被 chmod（与 chmod -R 一致），但**不应走进它**
    expect(plan.entries).toContain('/app/link-to-etc')
    expect(plan.entries, '不应跟随链接进入目标').not.toContain('/app/link-to-etc/passwd')
  })

  it('★ 拒绝在根目录上递归（chmod -R / 会把整台机器搞坏）', async () => {
    const { sftp } = fakeTree(TREE)
    const err = await planChmod(sftp, '/', '755', { recursive: true }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(AppError)
    expect((err as AppError).message).toMatch(/根目录/)
  })

  it('根目录**非递归**是允许的（只改 / 自己）', async () => {
    const { sftp } = fakeTree(TREE)
    const plan = await planChmod(sftp, '/', '755')
    expect(plan.entries).toEqual(['/'])
  })

  it('接受 0o755 / "755" / "0755" 三种写法，命令里统一成三位八进制', async () => {
    const { sftp } = fakeTree(TREE)
    expect((await planChmod(sftp, '/app', 0o755)).summary).toBe('chmod 755 /app')
    expect((await planChmod(sftp, '/app', '755')).summary).toBe('chmod 755 /app')
    expect((await planChmod(sftp, '/app', '0755')).summary).toBe('chmod 755 /app')
  })

  it('★ 超过条目上限时如实标记 truncated（不悄悄少改）', async () => {
    // 造一个大目录：一个目录里 6000 个文件
    const big: Record<string, FakeEntry[]> = {
      '/': [{ name: 'big', type: DIR }],
      '/big': Array.from({ length: 6000 }, (_, i) => ({ name: `f${i}`, type: FILE })),
    }
    const { sftp } = fakeTree(big)
    const plan = await planChmod(sftp, '/big', '644', { recursive: true })
    expect(plan.truncated, '必须标记被截断').toBe(true)
    expect(plan.entries.length).toBeLessThanOrEqual(5000)
  })

  it('普通文件走单条路径（不管 recursive 标志）', async () => {
    const { sftp } = fakeTree(TREE)
    const plan = await planChmod(sftp, '/app/readme.txt', '600', { recursive: true })
    expect(plan.entries).toEqual(['/app/readme.txt'])
    expect(plan.summary).toBe('chmod 600 /app/readme.txt')
  })
})

describe('chmodPath —— 执行', () => {
  it('递归执行会改到每一个条目', async () => {
    const { sftp, chmods } = fakeTree(TREE)
    const r = await chmodPath(sftp, '/app', '750', { recursive: true })
    expect(r.changed).toBe(chmods.length)
    expect(r.failed).toEqual([])
    expect(chmods.every((c) => c.mode === 0o750)).toBe(true)
    expect(chmods.map((c) => c.path)).toContain('/app/bin/start.sh')
  })

  it('★ 逐项失败要收集而不是中断（树里个别文件没权限是常事）', async () => {
    const { sftp } = fakeTree(TREE)
    const failing = {
      ...(sftp as unknown as Record<string, unknown>),
      chmod: (p: string, _mode: number, cb: (err: Error | null) => void) => {
        cb(p.endsWith('readme.txt') ? new Error('permission denied') : null)
      },
    } as unknown as SftpLike

    const r = await chmodPath(failing, '/app', '700', { recursive: true })
    expect(r.failed).toHaveLength(1)
    expect(r.failed[0]!.path).toBe('/app/readme.txt')
    expect(r.failed[0]!.message).toMatch(/permission denied/)
    // 其它条目仍然改了 —— 不因为一个失败就整批放弃
    expect(r.changed).toBeGreaterThan(1)
  })

  it('返回实际执行的命令与汇总（供界面展示"到底做了什么"）', async () => {
    const { sftp } = fakeTree(TREE)
    const r = await chmodPath(sftp, '/app', '755', { recursive: true })
    expect(r.summary).toBe('chmod -R 755 /app')
    expect(r.commands.length).toBeGreaterThan(0)
  })
})
