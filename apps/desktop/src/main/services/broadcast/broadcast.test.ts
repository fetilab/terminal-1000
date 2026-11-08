// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 并发广播测试。
 *
 * 广播最容易出的问题是**"以为发出去了其实没有"**（某个成员断开了/只读），
 * 所以下面覆盖的重点是：部分失败必须被逐条报出来，而不是静默跳过。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Events } from '@t1000/shared'
import type { IpcContext } from '../../ipc/router'
import {
  clearSessions,
  registerWritable,
  unregisterWritable,
  type WritableSession,
} from '../session-registry'
import { broadcastHandlers, onSessionClosed, shutdownBroadcast } from './index'

/** 造一个记录写入内容的假会话 */
function fakeSession(
  sessionId: string,
  opts: { title?: string; canWrite?: boolean; failOnWrite?: boolean } = {},
): WritableSession & { received: string[] } {
  const received: string[] = []
  const session: WritableSession & { received: string[] } = {
    sessionId,
    kind: 'ssh',
    title: opts.title ?? sessionId,
    received,
    write: (data: string) => {
      if (opts.failOnWrite) throw new Error('连接已断开')
      received.push(data)
    },
    canWrite: () => opts.canWrite ?? true,
  }
  registerWritable(session)
  return session
}

/** 假 ctx：只用到 emit */
function makeCtx(): IpcContext & { emitted: Array<{ event: string; payload: unknown }> } {
  const emitted: Array<{ event: string; payload: unknown }> = []
  return {
    emitted,
    emit: (event: string, payload: unknown) => {
      emitted.push({ event, payload })
    },
  } as unknown as IpcContext & { emitted: Array<{ event: string; payload: unknown }> }
}

const call = <T>(action: keyof typeof broadcastHandlers, payload: unknown, ctx: IpcContext): T =>
  broadcastHandlers[action]!(payload, ctx) as T

describe('并发广播', () => {
  let ctx: ReturnType<typeof makeCtx>

  beforeEach(() => {
    clearSessions()
    shutdownBroadcast()
    ctx = makeCtx()
  })

  it('用一批会话建立广播组，成员信息含标题与可写状态', () => {
    fakeSession('s1', { title: 'web-1' })
    fakeSession('s2', { title: 'web-2' })

    const { group } = call<{ group: { groupId: string; members: unknown[] } }>(
      'create',
      { sessionIds: ['s1', 's2'], name: 'web 组' },
      ctx,
    )

    expect(group.members).toHaveLength(2)
    expect(group).toMatchObject({ name: 'web 组', mode: 'independent' })
    expect((group.members[0] as { title: string }).title).toBe('web-1')
  })

  it('去重：同一会话传两次只算一个成员', () => {
    fakeSession('s1')
    const { group } = call<{ group: { members: unknown[] } }>('create', { sessionIds: ['s1', 's1'] }, ctx)
    expect(group.members).toHaveLength(1)
  })

  it('★ 全部会话都不可写时明确报错（而不是建一个发不出东西的组）', () => {
    expect(() => call('create', { sessionIds: ['ghost-1', 'ghost-2'] }, ctx)).toThrow(/不可写入/)
  })

  it('部分会话不存在时建组成功，但如实返回被跳过的成员', () => {
    fakeSession('s1')
    const res = call<{ group: unknown; skipped: string[] }>(
      'create',
      { sessionIds: ['s1', 'ghost'] },
      ctx,
    )
    expect(res.skipped).toEqual(['ghost'])
  })

  it('★ 独立模式下 send 直接拒绝（不能静默丢弃输入）', () => {
    fakeSession('s1')
    const { group } = call<{ group: { groupId: string } }>('create', { sessionIds: ['s1'] }, ctx)
    expect(() => call('send', { groupId: group.groupId, data: 'ls\r' }, ctx)).toThrow(/独立模式/)
  })

  it('★ 广播模式下一次输入写入所有成员（顺序一致）', () => {
    const a = fakeSession('s1')
    const b = fakeSession('s2')
    const c = fakeSession('s3')

    const { group } = call<{ group: { groupId: string } }>(
      'create',
      { sessionIds: ['s1', 's2', 's3'], mode: 'broadcast' },
      ctx,
    )
    const res = call<{ delivered: number; skipped: number }>(
      'send',
      { groupId: group.groupId, data: 'docker ps\r' },
      ctx,
    )

    expect(res).toMatchObject({ delivered: 3, skipped: 0 })
    expect(a.received).toEqual(['docker ps\r'])
    expect(b.received).toEqual(['docker ps\r'])
    expect(c.received).toEqual(['docker ps\r'])
  })

  it('★ 部分成员不可写时：计入 skipped 并发 BROADCAST_ERROR，不静默跳过', () => {
    fakeSession('s1')
    fakeSession('s2', { title: 'dead', canWrite: false })

    const { group } = call<{ group: { groupId: string } }>(
      'create',
      { sessionIds: ['s1', 's2'], mode: 'broadcast' },
      ctx,
    )
    const res = call<{ delivered: number; skipped: number; details: Array<{ message: string }> }>(
      'send',
      { groupId: group.groupId, data: 'x' },
      ctx,
    )

    expect(res.delivered).toBe(1)
    expect(res.skipped).toBe(1)
    expect(res.details[0]!.message).toContain('不可写入')

    const errors = ctx.emitted.filter((e) => e.event === Events.BROADCAST_ERROR)
    expect(errors).toHaveLength(1)
    expect((errors[0]!.payload as { title: string }).title).toBe('dead')
  })

  it('写入抛异常也计入 skipped 并带出原因，不影响其它成员', () => {
    const ok = fakeSession('s1')
    fakeSession('s2', { title: 'boom', failOnWrite: true })

    const { group } = call<{ group: { groupId: string } }>(
      'create',
      { sessionIds: ['s1', 's2'], mode: 'broadcast' },
      ctx,
    )
    const res = call<{ delivered: number; details: Array<{ message: string }> }>(
      'send',
      { groupId: group.groupId, data: 'y' },
      ctx,
    )

    expect(res.delivered).toBe(1)
    expect(ok.received).toEqual(['y'])
    expect(res.details[0]!.message).toBe('连接已断开')
  })

  it('会话中途消失（未登记）也如实报告', () => {
    fakeSession('s1')
    const { group } = call<{ group: { groupId: string } }>(
      'create',
      { sessionIds: ['s1'], mode: 'broadcast' },
      ctx,
    )
    // 模拟会话被销毁但组里还留着
    unregisterWritable('s1')

    const res = call<{ delivered: number; details: Array<{ message: string }> }>(
      'send',
      { groupId: group.groupId, data: 'z' },
      ctx,
    )
    expect(res.delivered).toBe(0)
    expect(res.details[0]!.message).toContain('已断开')
  })

  it('setMode 可来回切换', () => {
    fakeSession('s1')
    const { group } = call<{ group: { groupId: string } }>('create', { sessionIds: ['s1'] }, ctx)

    const on = call<{ group: { mode: string } }>(
      'setMode',
      { groupId: group.groupId, mode: 'broadcast' },
      ctx,
    )
    expect(on.group.mode).toBe('broadcast')

    const off = call<{ group: { mode: string } }>(
      'setMode',
      { groupId: group.groupId, mode: 'independent' },
      ctx,
    )
    expect(off.group.mode).toBe('independent')
  })

  it('add / remove 成员；移除到空自动解散', () => {
    fakeSession('s1')
    fakeSession('s2')
    const { group } = call<{ group: { groupId: string } }>('create', { sessionIds: ['s1'] }, ctx)

    const added = call<{ group: { members: unknown[] } }>(
      'add',
      { groupId: group.groupId, sessionIds: ['s2'] },
      ctx,
    )
    expect(added.group.members).toHaveLength(2)

    const removed = call<{ group: { members: unknown[] } | null }>(
      'remove',
      { groupId: group.groupId, sessionIds: ['s2'] },
      ctx,
    )
    expect(removed.group!.members).toHaveLength(1)

    const emptied = call<{ group: unknown | null }>(
      'remove',
      { groupId: group.groupId, sessionIds: ['s1'] },
      ctx,
    )
    expect(emptied.group).toBeNull()
    // 组已解散，再查应报不存在
    expect(() => call('status', { groupId: group.groupId }, ctx)).toThrow(/不存在/)
  })

  it('★ 会话关闭时自动摘除成员；成员清零则自动解散', () => {
    fakeSession('s1')
    fakeSession('s2')
    const { group } = call<{ group: { groupId: string } }>(
      'create',
      { sessionIds: ['s1', 's2'] },
      ctx,
    )

    onSessionClosed('s1')
    const after = call<{ members: unknown[] }>('status', { groupId: group.groupId }, ctx)
    expect(after.members).toHaveLength(1)

    onSessionClosed('s2')
    expect(() => call('status', { groupId: group.groupId }, ctx)).toThrow(/不存在/)
  })

  it('解散不存在的组报 NOT_FOUND', () => {
    expect(() => call('dissolve', { groupId: 'nope' }, ctx)).toThrow(/不存在/)
  })

  it('成员变动会广播 BROADCAST_STATE 给渲染层', () => {
    fakeSession('s1')
    call('create', { sessionIds: ['s1'] }, ctx)

    const states = ctx.emitted.filter((e) => e.event === Events.BROADCAST_STATE)
    expect(states.length).toBeGreaterThan(0)
    const last = states[states.length - 1]!.payload as { groups: unknown[] }
    expect(last.groups).toHaveLength(1)
  })

  it('list 返回全部组', () => {
    fakeSession('s1')
    fakeSession('s2')
    call('create', { sessionIds: ['s1'] }, ctx)
    call('create', { sessionIds: ['s2'] }, ctx)
    expect(call<unknown[]>('list', {}, ctx)).toHaveLength(2)
  })

  it('★ 超长输入被拒绝（防止一次广播打爆所有服务器）', () => {
    fakeSession('s1')
    const { group } = call<{ group: { groupId: string } }>(
      'create',
      { sessionIds: ['s1'], mode: 'broadcast' },
      ctx,
    )
    expect(() =>
      call('send', { groupId: group.groupId, data: 'x'.repeat(64 * 1024 + 1) }, ctx),
    ).toThrow()
  })
})
