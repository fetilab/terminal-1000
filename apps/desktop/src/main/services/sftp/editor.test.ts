// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 远端编辑写回测试。
 *
 * 这个模块存在的唯一目的就是补上"改动不回传"那个静默丢数据的洞，
 * 所以测试要钉住的是**改动到底有没有到远端**，以及**失败时有没有被说出来**：
 * 一个"写回失败但不报错"的实现，和"根本没写回"对用户是一样的。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Events } from '@t1000/shared'
import { RemoteEditorRegistry, hashContent, type EditorSession } from './editor'
import type { SftpLike } from './browser'

let dir: string
let localPath: string

/** 假 SFTP：记录写入内容；stat 返回可配的 mtime */
function fakeSftp(options: { mtime?: number; failWrite?: boolean } = {}): {
  sftp: SftpLike
  writes: Array<{ path: string; data: Buffer }>
} {
  const writes: Array<{ path: string; data: Buffer }> = []
  const sftp = {
    stat: (_p: string, cb: (err: Error | null, stats?: unknown) => void) => {
      cb(null, {
        size: 0,
        mtime: options.mtime ?? 0,
        mode: 0o644,
        uid: 0,
        gid: 0,
        isDirectory: () => false,
        isFile: () => true,
        isSymbolicLink: () => false,
      })
    },
    writeFile: (p: string, data: Buffer, cb: (err: Error | null) => void) => {
      if (options.failWrite === true) {
        cb(new Error('SFTP 写失败：permission denied'))
        return
      }
      writes.push({ path: p, data })
      cb(null)
    },
    lstat: (_p: string, cb: (err: Error | null, stats?: unknown) => void) => cb(null, null),
    readdir: (_p: string, cb: (err: Error | null, list?: unknown) => void) => cb(null, []),
  } as unknown as SftpLike
  return { sftp, writes }
}

function makeRegistry(sftp: SftpLike): {
  registry: RemoteEditorRegistry
  events: Array<{ event: string; payload: unknown }>
} {
  const events: Array<{ event: string; payload: unknown }> = []
  const registry = new RemoteEditorRegistry({
    sftpFor: async () => sftp,
    emit: (event, payload) => events.push({ event, payload }),
  })
  return { registry, events }
}

function session(overrides: Partial<EditorSession> = {}): EditorSession {
  return {
    editId: 'edit-1',
    sessionId: 'sess-1',
    remotePath: '/remote/app.conf',
    localPath,
    remoteMtimeAtOpen: 1000,
    lastHash: hashContent('原始内容'),
    startedAt: Date.now(),
    ...overrides,
  }
}

describe('远端编辑写回', () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 't1000-edit-'))
    localPath = join(dir, 'app.conf')
    writeFileSync(localPath, '原始内容')
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('★ 本地改动被写回远端（这正是此前完全缺失的一环）', async () => {
    const { sftp, writes } = fakeSftp({ mtime: 1000 })
    const { registry, events } = makeRegistry(sftp)
    registry.open(session())

    writeFileSync(localPath, '改过的内容')
    const r = await registry.save('edit-1', 'manual')

    expect(r.skipped).toBe(false)
    expect(writes).toHaveLength(1)
    expect(writes[0]!.path).toBe('/remote/app.conf')
    expect(writes[0]!.data.toString('utf8')).toBe('改过的内容')
    // 成功要有事件（界面据此提示"已保存到远端"）
    expect(events.map((e) => e.event)).toContain(Events.SFTP_EDIT_SAVED)
  })

  it('★ 内容没变时跳过写回（编辑器可能只是 touch 了一下）', async () => {
    const { sftp, writes } = fakeSftp({ mtime: 1000 })
    const { registry } = makeRegistry(sftp)
    registry.open(session())

    // 内容与 lastHash 一致
    const r = await registry.save('edit-1', 'manual')
    expect(r.skipped).toBe(true)
    expect(writes).toHaveLength(0)
  })

  it('★ 写回失败必须报出来（否则用户以为存到远端了 —— 正是本次要修的毛病）', async () => {
    const { sftp } = fakeSftp({ mtime: 1000, failWrite: true })
    const { registry, events } = makeRegistry(sftp)
    registry.open(session())
    writeFileSync(localPath, '新内容')

    await expect(registry.save('edit-1', 'manual')).rejects.toThrow(/permission denied/)

    const err = events.find((e) => e.event === Events.SFTP_EDIT_ERROR)
    expect(err, '写回失败必须发 SFTP_EDIT_ERROR').toBeTruthy()
    const payload = err!.payload as { message: string }
    expect(payload.message).toMatch(/写回远端失败/)
    // 还要告诉用户本地副本在哪，别让改动无处可寻
    expect(payload.message).toContain(localPath)
  })

  it('★ 远端在编辑期间被改过 → 仍然写，但标记出来（不静默覆盖别人的修改）', async () => {
    // 物化时 mtime=1000，现在远端已变成 99999
    const { sftp, writes } = fakeSftp({ mtime: 99_999 })
    const { registry, events } = makeRegistry(sftp)
    registry.open(session({ remoteMtimeAtOpen: 1000 }))
    writeFileSync(localPath, '我改的')

    const r = await registry.save('edit-1', 'manual')
    expect(r.remoteChangedSinceOpen).toBe(true)
    expect(writes).toHaveLength(1) // 仍然写：用户的编辑是明确意图
    const saved = events.find((e) => e.event === Events.SFTP_EDIT_SAVED)!
    expect((saved.payload as { remoteChangedSinceOpen: boolean }).remoteChangedSinceOpen).toBe(true)
  })

  it('本地副本被删掉 → 明确报错，且提示"未写回"', async () => {
    const { sftp, writes } = fakeSftp({ mtime: 1000 })
    const { registry, events } = makeRegistry(sftp)
    registry.open(session())
    rmSync(localPath)

    await expect(registry.save('edit-1', 'manual')).rejects.toThrow(/副本不存在/)
    expect(writes).toHaveLength(0)
    expect((events.find((e) => e.event === Events.SFTP_EDIT_ERROR)!.payload as { message: string }).message).toMatch(
      /未写回远端/,
    )
  })

  it('★ 超出大小上限时拒绝写回并说明（不要把远端文件写坏）', async () => {
    const { sftp, writes } = fakeSftp({ mtime: 1000 })
    const { registry, events } = makeRegistry(sftp)
    registry.open(session())
    writeFileSync(localPath, Buffer.alloc(9 * 1024 * 1024)) // 超过 8MB

    await expect(registry.save('edit-1', 'manual')).rejects.toThrow(/过大/)
    expect(writes).toHaveLength(0)
    expect(events.map((e) => e.event)).toContain(Events.SFTP_EDIT_ERROR)
  })

  it('★ 自动写回：本地文件变化后触发（防抖），不需要用户手动调', async () => {
    const { sftp, writes } = fakeSftp({ mtime: 1000 })
    const { registry, events } = makeRegistry(sftp)
    registry.open(session())

    writeFileSync(localPath, '自动写回的内容')
    // 等防抖窗口过去
    await vi.waitFor(
      () => {
        expect(writes.length).toBeGreaterThan(0)
      },
      { timeout: 3000, interval: 100 },
    )
    expect(writes[0]!.data.toString('utf8')).toBe('自动写回的内容')
    const saved = events.find((e) => e.event === Events.SFTP_EDIT_SAVED)!
    expect((saved.payload as { reason: string }).reason).toBe('auto')
  })

  it('关闭编辑会话后不再监听（不留孤儿监听）', async () => {
    const { sftp, writes } = fakeSftp({ mtime: 1000 })
    const { registry } = makeRegistry(sftp)
    registry.open(session())
    expect(registry.close('edit-1')).toBe(true)
    expect(registry.list()).toHaveLength(0)

    writeFileSync(localPath, '关闭后的改动')
    await new Promise((r) => setTimeout(r, 900))
    expect(writes, '关掉后不应再自动写回').toHaveLength(0)
  })

  it('★ 会话断开时清掉它的编辑会话（否则监听留着、写回必然失败）', async () => {
    const { sftp } = fakeSftp({ mtime: 1000 })
    const { registry } = makeRegistry(sftp)
    registry.open(session({ editId: 'a', sessionId: 's1' }))
    registry.open(session({ editId: 'b', sessionId: 's1' }))
    registry.open(session({ editId: 'c', sessionId: 's2' }))

    expect(registry.closeBySession('s1')).toBe(2)
    expect(registry.list().map((s) => s.editId)).toEqual(['c'])
  })

  it('未知 editId 报明确错误', async () => {
    const { sftp } = fakeSftp()
    const { registry } = makeRegistry(sftp)
    await expect(registry.save('nope', 'manual')).rejects.toThrow(/编辑会话不存在/)
  })

  it('连续改动只在防抖后写一次（不把编辑器的一串写事件都传一遍）', async () => {
    const { sftp, writes } = fakeSftp({ mtime: 1000 })
    const { registry } = makeRegistry(sftp)
    registry.open(session())

    for (let i = 0; i < 5; i++) {
      writeFileSync(localPath, `内容-${i}`)
      await new Promise((r) => setTimeout(r, 30))
    }
    await new Promise((r) => setTimeout(r, 1200))
    expect(writes).toHaveLength(1)
    expect(writes[0]!.data.toString('utf8')).toBe('内容-4')
  })
})
