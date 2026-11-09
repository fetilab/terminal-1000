// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 服务层单测（spec §6 的端到端语义）：多级分组、级联删除、执行逐行发送、
 * 历史回填、拼音搜索、拖拽排序持久化。
 *
 * 用内存存储端口，不碰 SQLite / 用户数据目录；不连真实主机。
 */

import { describe, expect, it } from 'vitest'
import { QuickCmdService, getQuickCmdService, configureQuickCmd, resetQuickCmd, quickcmdHandlers, type QuickCmdDeps } from './index'
import { MemoryQuickCmdStore } from './store-port'
import type { VariableContext } from './variables'

const FIXED = new Date(2025, 10, 29, 14, 30, 45)

interface Sent {
  sessionId: string
  data: string
}

function makeService(overrides: Partial<QuickCmdDeps> = {}): {
  service: QuickCmdService
  store: MemoryQuickCmdStore
  sent: Sent[]
} {
  const store = new MemoryQuickCmdStore()
  const sent: Sent[] = []
  let ids = 0
  let clock = FIXED.getTime()
  const context: VariableContext = {
    now: FIXED,
    randomString: (n) => 'R'.repeat(n),
    uuid: () => 'uuid-fixed',
    clipboard: 'clip',
    password: 'p@ss',
    hostname: 'dev-box',
    username: 'mosfet',
    localIp: '192.168.1.20',
  }
  const service = new QuickCmdService({
    store,
    sendToSession: (sessionId, data) => {
      sent.push({ sessionId, data })
    },
    variableContext: () => context,
    now: () => clock,
    idFactory: () => `id-${++ids}`,
    historyOptions: { perParamLimit: 5, maxAgeMs: 90 * 24 * 3600 * 1000 },
    ...overrides,
  })
  // 让时间可推进（用于历史排序）
  void (() => {
    clock += 0
  })
  return { service, store, sent }
}

describe('命令 CRUD', () => {
  it('新建命令：必填校验、初始 order、出现在树里', () => {
    const { service } = makeService()
    const created = service.saveCommand({ name: '查看磁盘', command: 'df -h' })
    expect(created).toMatchObject({ name: '查看磁盘', command: 'df -h', groupId: null, order: 0 })

    const { tree } = service.list()
    expect(tree.totalCommands).toBe(1)
    expect(tree.roots.map((n) => n.id)).toEqual([created.id])
  })

  it('名称/命令为空直接拒绝', () => {
    const { service } = makeService()
    expect(() => service.saveCommand({ name: '  ', command: 'df' })).toThrow(/名称不能为空/)
    expect(() => service.saveCommand({ name: 'x', command: '   ' })).toThrow(/命令内容不能为空/)
  })

  it('分组不存在时报 NOT_FOUND', () => {
    const { service } = makeService()
    expect(() => service.saveCommand({ name: 'x', command: 'ls', groupId: 'ghost' })).toThrow(/分组不存在/)
  })

  it('更新命令保留 id 与 createdAt，刷新 updatedAt', () => {
    const { service } = makeService()
    const created = service.saveCommand({ name: 'a', command: 'ls' })
    const updated = service.saveCommand({ id: created.id, name: 'b', command: 'ls -la' })
    expect(updated.id).toBe(created.id)
    expect(updated.createdAt).toBe(created.createdAt)
    expect(updated.name).toBe('b')
    expect(service.list().commands).toHaveLength(1)
  })

  it('多选删除', () => {
    const { service } = makeService()
    const a = service.saveCommand({ name: 'a', command: 'a' })
    const b = service.saveCommand({ name: 'b', command: 'b' })
    service.saveCommand({ name: 'c', command: 'c' })
    expect(service.deleteCommands([a.id, b.id])).toEqual({ deleted: 2 })
    expect(service.list().commands.map((c) => c.name)).toEqual(['c'])
    // 删除不存在的 id 不报错
    expect(service.deleteCommands(['ghost'])).toEqual({ deleted: 0 })
  })
})

describe('★ 多级分组与级联删除', () => {
  it('支持多级嵌套：数据库 / MySQL / 备份', () => {
    const { service } = makeService()
    const db = service.saveGroup({ name: '数据库' })
    const mysql = service.saveGroup({ name: 'MySQL', parentId: db.id })
    const backup = service.saveCommand({ name: '备份', command: 'mysqldump ...', groupId: mysql.id })

    const { tree } = service.list()
    const dbNode = tree.roots.find((n) => n.id === db.id)
    if (dbNode?.kind !== 'group') throw new Error('unreachable')
    const mysqlNode = dbNode.children.find((c) => c.id === mysql.id)
    if (mysqlNode?.kind !== 'group') throw new Error('unreachable')
    expect(mysqlNode.children.map((c) => c.id)).toEqual([backup.id])
    expect(dbNode.commandCount).toBe(1)
    expect(service.groupPathOf(mysql.id)).toEqual(['数据库', 'MySQL'])
  })

  it('分组名校验与父分组校验', () => {
    const { service } = makeService()
    expect(() => service.saveGroup({ name: ' ' })).toThrow(/分组名称不能为空/)
    expect(() => service.saveGroup({ name: 'x', parentId: 'ghost' })).toThrow(/父分组不存在/)
  })

  it('不允许把分组挂到自己的子分组下（防环）', () => {
    const { service } = makeService()
    const parent = service.saveGroup({ name: 'P' })
    const child = service.saveGroup({ name: 'C', parentId: parent.id })
    expect(() => service.saveGroup({ id: parent.id, name: 'P', parentId: child.id })).toThrow(/形成环/)
  })

  it('★ 删除分组级联删除子分组与组内命令（并支持删除前预览）', () => {
    const { service } = makeService()
    const db = service.saveGroup({ name: '数据库' })
    const mysql = service.saveGroup({ name: 'MySQL', parentId: db.id })
    service.saveCommand({ name: '备份', command: 'dump', groupId: mysql.id })
    service.saveCommand({ name: '恢复', command: 'restore', groupId: mysql.id })
    const keep = service.saveGroup({ name: 'Web' })
    service.saveCommand({ name: '重启', command: 'reload', groupId: keep.id })

    expect(service.previewGroupDelete(db.id)).toEqual({ groups: 2, commands: 2 })

    const result = service.deleteGroup(db.id)
    expect(result).toEqual({ removedGroups: 2, removedCommands: 2 })

    const { commands, groups } = service.list()
    expect(groups.map((g) => g.id)).toEqual([keep.id])
    expect(commands.map((c) => c.name)).toEqual(['重启'])
  })

  it('删除不存在的分组报 NOT_FOUND', () => {
    const { service } = makeService()
    expect(() => service.deleteGroup('ghost')).toThrow(/分组不存在/)
  })
})

describe('★ 拖拽移动与排序（并持久化）', () => {
  it('moveCommand 换组，重新加载后仍在目标组', () => {
    const store = new MemoryQuickCmdStore()
    let ids = 0
    const make = (): QuickCmdService =>
      new QuickCmdService({ store, idFactory: () => `id-${++ids}`, now: () => FIXED.getTime() })

    const svc1 = make()
    const group = svc1.saveGroup({ name: 'Web' })
    const cmd = svc1.saveCommand({ name: '重启', command: 'reload' })
    svc1.moveCommand(cmd.id, group.id)

    // 模拟"重启应用"：新服务实例读同一个 store
    const svc2 = new QuickCmdService({ store, now: () => FIXED.getTime() })
    expect(svc2.getCommand(cmd.id)?.groupId).toBe(group.id)
  })

  it('reorder 按给定顺序持久化 order', () => {
    const store = new MemoryQuickCmdStore()
    let ids = 0
    const svc = new QuickCmdService({ store, idFactory: () => `id-${++ids}`, now: () => FIXED.getTime() })
    const a = svc.saveCommand({ name: 'A', command: 'a' })
    const b = svc.saveCommand({ name: 'B', command: 'b' })
    const c = svc.saveCommand({ name: 'C', command: 'c' })

    svc.reorder(null, [c.id, a.id, b.id])
    expect(svc.tree().roots.map((n) => n.id)).toEqual([c.id, a.id, b.id])

    const reloaded = new QuickCmdService({ store, now: () => FIXED.getTime() })
    expect(reloaded.tree().roots.map((n) => n.id)).toEqual([c.id, a.id, b.id])
  })

  it('reorder 拒绝不属于该层级的节点', () => {
    const { service } = makeService()
    const parent = service.saveGroup({ name: 'P' })
    service.saveGroup({ name: 'C', parentId: parent.id })
    // 顶层排序里出现"某个子分组"的 id → 必须拒绝，避免把别的层级顺序搅乱
    const child = service.listGroups().find((g) => g.parentId === parent.id)!
    expect(() => service.reorder(null, [child.id])).toThrow(/不在该分组下/)
    expect(() => service.reorder(null, ['ghost'])).toThrow(/不在该分组下/)
  })
})

describe('★ 拼音搜索', () => {
  it('输入 qd 命中「前端构建」（spec 示例）', () => {
    const { service } = makeService()
    const target = service.saveCommand({ name: '前端构建', command: 'npm run build' })
    service.saveCommand({ name: '数据库备份', command: 'pg_dump' })

    const hits = service.search('qd')
    expect(hits.map((h) => h.id)).toEqual([target.id])
  })

  it('搜索结果带分组路径面包屑', () => {
    const { service } = makeService()
    const db = service.saveGroup({ name: '数据库' })
    const mysql = service.saveGroup({ name: 'MySQL', parentId: db.id })
    service.saveCommand({ name: '备份', command: 'dump', groupId: mysql.id })

    const hits = service.search('bf')
    expect(hits[0]?.groupPath).toEqual(['数据库', 'MySQL'])
  })

  it('空查询返回全部', () => {
    const { service } = makeService()
    service.saveCommand({ name: 'a', command: 'a' })
    service.saveCommand({ name: 'b', command: 'b' })
    expect(service.search('')).toHaveLength(2)
  })
})

describe('★ 渲染 / 参数填写 / 历史回填', () => {
  const TAR = 'tar -czf /backup/logs_${{date:YYYYMMDD}}_${{time:HHmmss}}_${{env}}.tar.gz /var/log/'

  it('render 替换动态变量与参数，给出标签与 PREVIEW', () => {
    const { service } = makeService()
    const out = service.render({ command: TAR, params: { env: 'prod' } })
    expect(out.text).toBe('tar -czf /backup/logs_20251129_143045_prod.tar.gz /var/log/')
    expect(out.missingParams).toEqual([])
    // 绿=变量、蓝=参数
    const kinds = Object.fromEntries(out.tags.map((t) => [t.name, t.kind]))
    expect(kinds['date']).toBe('variable')
    expect(kinds['time']).toBe('variable')
    expect(kinds['env']).toBe('parameter')
    expect(out.variables.map((v) => v.name)).toEqual(['date', 'time'])
    expect(out.variables[0]?.value).toBe('20251129')
  })

  it('缺参数时保留占位符并列出（PREVIEW 如实显示）', () => {
    const { service } = makeService()
    const out = service.render({ command: TAR })
    expect(out.missingParams).toEqual(['env'])
    expect(out.text).toContain('${{env}}')
  })

  it('未闭合 `${{` 会被标记（UI 可提示少写了 }}）', () => {
    const { service } = makeService()
    const out = service.render({ command: 'echo ${{oops' })
    expect(out.hasUnclosed).toBe(true)
    expect(out.text).toBe('echo ${{oops')
  })

  it('analyze 给编辑器实时标签', () => {
    const { service } = makeService()
    const out = service.analyze('echo ${{date}} ${{host}} ${{host}}')
    expect(out.parameterNames).toEqual(['host'])
    const hostTag = out.tags.find((t) => t.name === 'host')
    expect(hostTag).toMatchObject({ kind: 'parameter', count: 2 })
  })

  it('★ parameterDialog 提供历史预填与 recent 列表', () => {
    const { service, sent } = makeService()
    service.saveCommand({ name: '连接', command: 'ssh ${{user}}@${{host}}' })

    // 先执行一次，产生历史
    return service
      .execute({ sessionId: 's1', command: 'ssh ${{user}}@${{host}}', params: { user: 'root', host: 'web-1' } })
      .then(() => {
        expect(sent).toHaveLength(1)
        const dialog = service.parameterDialog({ command: 'ssh ${{user}}@${{host}}' })
        expect(dialog.parameters).toEqual(['user', 'host'])
        expect(dialog.prefill).toEqual({ user: 'root', host: 'web-1' })
        expect(dialog.recent['user']).toEqual(['root'])
        // 变量面板带当前值预览
        expect(dialog.variables.find((v) => v.name === 'date')?.value).toBe('2025-11-29')
      })
  })

  it('★ 同一参数名跨命令共享历史（spec §6.4）', async () => {
    const { service } = makeService()
    await service.execute({ sessionId: 's1', command: 'mysqldump ${{database}}', params: { database: 'shop' } })
    // 另一条命令用同名参数，能拿到上次的值
    const dialog = service.parameterDialog({ command: 'pg_dump ${{database}} > /tmp/${{database}}.sql' })
    expect(dialog.prefill['database']).toBe('shop')
    expect(dialog.parameters).toEqual(['database'])
  })

  it('动态变量不进历史（password/date 不落库）', async () => {
    const { service } = makeService()
    await service.execute({
      sessionId: 's1',
      command: 'mysql -p${{password}} -u ${{user}}',
      params: { user: 'root', password: 'should-not-be-recorded' },
    })
    expect(service.historyFor('password')).toEqual([])
    expect(service.historyFor('date')).toEqual([])
    expect(service.historyFor('user')).toEqual(['root'])
  })

  it('clearHistory 清空', async () => {
    const { service } = makeService()
    await service.execute({ sessionId: 's1', command: 'echo ${{x}}', params: { x: '1' } })
    expect(service.historyFor('x')).toEqual(['1'])
    service.clearHistory('x')
    expect(service.historyFor('x')).toEqual([])
  })
})

describe('★ 执行：多行逐行发送', () => {
  it('多行命令逐行发送，每行一个换行', async () => {
    const { service, sent } = makeService()
    await service.execute({
      sessionId: 's7',
      command: 'cd /var/log\n\n  ls -la  \ntail -n 5 syslog',
    })
    expect(sent).toEqual([
      { sessionId: 's7', data: 'cd /var/log\n' },
      { sessionId: 's7', data: 'ls -la\n' },
      { sessionId: 's7', data: 'tail -n 5 syslog\n' },
    ])
  })

  it('缺参数时拒绝执行，且不发送任何内容', async () => {
    const { service, sent } = makeService()
    await expect(service.execute({ sessionId: 's1', command: 'ssh ${{user}}@${{host}}' })).rejects.toThrow(
      /还有参数未填写/,
    )
    expect(sent).toHaveLength(0)
  })

  it('空命令拒绝', async () => {
    const { service } = makeService()
    await expect(service.execute({ sessionId: 's1', command: '   \n  ' })).rejects.toThrow(/命令为空/)
  })

  it('按 commandId 执行已保存的命令', async () => {
    const { service, sent } = makeService()
    const cmd = service.saveCommand({ name: '看负载', command: 'uptime' })
    await service.execute({ sessionId: 's2', commandId: cmd.id })
    expect(sent).toEqual([{ sessionId: 's2', data: 'uptime\n' }])
  })

  it('paste 只渲染不发送（右键"粘贴到终端"）', () => {
    const { service, sent } = makeService()
    const out = service.paste({ command: 'echo ${{date}}', params: {} })
    expect(out.lines).toEqual(['echo 2025-11-29'])
    expect(sent).toHaveLength(0)
  })

  it('commandId 不存在报 NOT_FOUND', async () => {
    const { service } = makeService()
    await expect(service.execute({ sessionId: 's1', commandId: 'ghost' })).rejects.toThrow(/命令不存在/)
  })
})

describe('变量面板（当前值预览）', () => {
  it('返回所有内置变量，password 打码且标记有值', () => {
    const { service } = makeService()
    const panel = service.variablePanel()
    const password = panel.find((v) => v.name === 'password')
    expect(password?.masked).toBe(true)
    expect(password?.hasValue).toBe(true)
    expect(password?.value).not.toContain('p@ss')

    expect(panel.find((v) => v.name === 'date')?.value).toBe('2025-11-29')
    expect(panel.find((v) => v.name === 'hostname')?.value).toBe('dev-box')
    expect(panel.find((v) => v.name === 'ip')?.value).toBe('192.168.1.20')
  })
})

describe('IPC handler 表', () => {
  it('建议的动作名都已实现且可调用', async () => {
    resetQuickCmd()
    const store = new MemoryQuickCmdStore()
    configureQuickCmd({
      store,
      now: () => FIXED.getTime(),
      variableContext: () => ({ now: FIXED }),
    })
    const svc = getQuickCmdService()
    void svc

    const created = (await quickcmdHandlers['save']!(
      { name: '前端构建', command: 'npm run build' },
      {} as never,
    )) as { id: string }
    const listed = (await quickcmdHandlers['list']!({}, {} as never)) as { tree: { totalCommands: number } }
    expect(listed.tree.totalCommands).toBe(1)

    const found = (await quickcmdHandlers['search']!({ query: 'qd' }, {} as never)) as Array<{ id: string }>
    expect(found.map((f) => f.id)).toEqual([created.id])

    const rendered = (await quickcmdHandlers['render']!(
      { command: 'echo ${{date}}' },
      {} as never,
    )) as { text: string }
    expect(rendered.text).toBe('echo 2025-11-29')

    const removed = (await quickcmdHandlers['delete']!({ ids: [created.id] }, {} as never)) as { deleted: number }
    expect(removed.deleted).toBe(1)

    const storage = (await quickcmdHandlers['storage']!({}, {} as never)) as { kind: string }
    expect(storage.kind).toBe('local')
    resetQuickCmd()
  })

  it('参数非法时 handler 抛 BAD_REQUEST（信封校验）', async () => {
    resetQuickCmd()
    // 包一层：handler 里 parseInput 是同步抛错，直接传给 expect(...).rejects 会漏掉
    const call = (payload: unknown): Promise<unknown> => {
      try {
        return Promise.resolve(quickcmdHandlers['save']!(payload, {} as never))
      } catch (err) {
        return Promise.reject(err)
      }
    }
    await expect(call({ name: '' })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    resetQuickCmd()
  })
})
