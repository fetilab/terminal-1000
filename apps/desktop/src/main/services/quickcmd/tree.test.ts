// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 分组树单测：多级嵌套、级联删除、拖拽移动/排序、防成环。
 */

import { describe, expect, it } from 'vitest'
import {
  buildTree,
  cascadeDeleteGroup,
  cascadePreview,
  descendantGroupIds,
  isAncestor,
  moveCommand,
  moveGroup,
  nextOrder,
  reorderSiblings,
  type QuickCommandRecord,
  type QuickGroupRecord,
  type QuickLibrary,
} from './tree'

function group(id: string, parentId: string | null, name: string, order = 0): QuickGroupRecord {
  return { id, parentId, name, order, createdAt: 't', updatedAt: 't' }
}

function command(id: string, groupId: string | null, name: string, order = 0): QuickCommandRecord {
  return { id, groupId, name, command: `echo ${name}`, order, createdAt: 't', updatedAt: 't' }
}

/** 树：db/{mysql, pg}，web/{nginx}，根下有个 orphan 命令 */
function sample(): QuickLibrary {
  return {
    groups: [
      group('db', null, '数据库', 0),
      group('mysql', 'db', 'MySQL', 0),
      group('pg', 'db', 'PostgreSQL', 1),
      group('web', null, 'Web', 1),
      group('nginx', 'web', 'Nginx', 0),
    ],
    commands: [
      command('c1', 'mysql', '备份', 0),
      command('c2', 'mysql', '恢复', 1),
      command('c3', 'pg', '备份', 0),
      command('c4', 'nginx', '重启', 0),
      command('c5', null, '查看负载', 0),
    ],
  }
}

function ids(nodes: ReturnType<typeof buildTree>['roots']): string[] {
  return nodes.map((n) => n.id)
}

describe('buildTree', () => {
  it('多级嵌套：子分组挂在父分组下，命令挂到所属分组', () => {
    const tree = buildTree(sample())
    // 根上同时有分组与未分组命令，二者按 order 混排；这里只断言成员与结构
    expect(ids(tree.roots).sort()).toEqual(['c5', 'db', 'web'])

    const db = tree.roots.find((n) => n.id === 'db')
    expect(db?.kind).toBe('group')
    if (db?.kind !== 'group') throw new Error('unreachable')
    expect(db.children.map((c) => c.id)).toEqual(['mysql', 'pg'])
    expect(db.commandCount).toBe(3) // c1,c2 (mysql) + c3 (pg)

    const mysql = db.children.find((c) => c.id === 'mysql')
    if (mysql?.kind !== 'group') throw new Error('unreachable')
    expect(mysql.children.map((c) => c.id)).toEqual(['c1', 'c2'])
    expect(mysql.commandCount).toBe(2)
  })

  it('统计总数', () => {
    const tree = buildTree(sample())
    expect(tree.totalCommands).toBe(5)
    expect(tree.totalGroups).toBe(5)
  })

  it('同级按 order 排序，order 相同按名称', () => {
    const lib: QuickLibrary = {
      groups: [group('b', null, 'B', 0), group('a', null, 'A', 0), group('c', null, 'C', 1)],
      commands: [],
    }
    expect(buildTree(lib).roots.map((n) => n.id)).toEqual(['a', 'b', 'c'])
  })

  it('父分组缺失的孤儿节点挂到根（不整棵树消失）', () => {
    const lib: QuickLibrary = {
      groups: [group('orphan', 'missing', '孤儿组'), group('ok', null, '正常组')],
      commands: [command('x', 'missing', '孤儿命令')],
    }
    const tree = buildTree(lib)
    expect(ids(tree.roots).sort()).toEqual(['ok', 'orphan', 'x'])
  })

  it('空库返回空树', () => {
    expect(buildTree({ groups: [], commands: [] })).toMatchObject({ roots: [], totalCommands: 0, totalGroups: 0 })
  })
})

describe('descendantGroupIds / isAncestor', () => {
  it('包含自身与所有后代', () => {
    const lib = sample()
    expect(descendantGroupIds(lib.groups, 'db').sort()).toEqual(['db', 'mysql', 'pg'])
    expect(descendantGroupIds(lib.groups, 'mysql')).toEqual(['mysql'])
  })

  it('isAncestor 判断祖先关系', () => {
    const lib = sample()
    expect(isAncestor(lib.groups, 'db', 'mysql')).toBe(true)
    expect(isAncestor(lib.groups, 'db', 'pg')).toBe(true)
    expect(isAncestor(lib.groups, 'mysql', 'db')).toBe(false)
    expect(isAncestor(lib.groups, 'web', 'mysql')).toBe(false)
  })

  it('数据成环时不死循环', () => {
    const cyclic: QuickGroupRecord[] = [group('a', 'b', 'A'), group('b', 'a', 'B')]
    expect(() => isAncestor(cyclic, 'a', 'b')).not.toThrow()
  })
})

describe('★ 删除分组级联', () => {
  it('删除父分组会连子分组与组内命令一起删除', () => {
    const result = cascadeDeleteGroup(sample(), 'db')
    expect(result.removedGroupIds.sort()).toEqual(['db', 'mysql', 'pg'])
    expect(result.removedCommandIds.sort()).toEqual(['c1', 'c2', 'c3'])
    expect(result.library.groups.map((g) => g.id).sort()).toEqual(['nginx', 'web'])
    expect(result.library.commands.map((c) => c.id).sort()).toEqual(['c4', 'c5'])
  })

  it('删除子分组只影响它自己那一支', () => {
    const result = cascadeDeleteGroup(sample(), 'mysql')
    expect(result.removedGroupIds).toEqual(['mysql'])
    expect(result.removedCommandIds.sort()).toEqual(['c1', 'c2'])
    expect(result.library.groups.map((g) => g.id)).toContain('pg')
  })

  it('删除不存在的分组报 NOT_FOUND', () => {
    expect(() => cascadeDeleteGroup(sample(), 'nope')).toThrow(/分组不存在/)
  })

  it('cascadePreview 给出"将删除 N 条命令"（UI 二次确认用）', () => {
    expect(cascadePreview(sample(), 'db')).toEqual({ groups: 3, commands: 3 })
    expect(cascadePreview(sample(), 'nginx')).toEqual({ groups: 1, commands: 1 })
  })
})

describe('拖拽排序 / 移动', () => {
  it('reorderSiblings 按给定顺序重排并重置 order', () => {
    const next = reorderSiblings(sample(), null, ['web', 'db', 'c5'])
    const roots = buildTree(next).roots.map((n) => n.id)
    expect(roots).toEqual(['web', 'db', 'c5'])
    expect(next.groups.find((g) => g.id === 'web')?.order).toBe(0)
    expect(next.groups.find((g) => g.id === 'db')?.order).toBe(1)
  })

  it('reorderSiblings 拒绝不属于该分组的节点', () => {
    expect(() => reorderSiblings(sample(), null, ['mysql'])).toThrow(/不在该分组下/)
  })

  it('moveCommand 换组并放到指定下标', () => {
    const next = moveCommand(sample(), 'c5', 'mysql', 1)
    const mysql = buildTree(next).roots.find((n) => n.id === 'db')
    if (mysql?.kind !== 'group') throw new Error('unreachable')
    const sub = mysql.children.find((c) => c.id === 'mysql')
    if (sub?.kind !== 'group') throw new Error('unreachable')
    expect(sub.children.map((c) => c.id)).toEqual(['c1', 'c5', 'c2'])
    expect(next.commands.find((c) => c.id === 'c5')?.groupId).toBe('mysql')
  })

  it('moveCommand 移到根（groupId=null）', () => {
    const next = moveCommand(sample(), 'c1', null)
    expect(next.commands.find((c) => c.id === 'c1')?.groupId).toBeNull()
    const tree = buildTree(next)
    expect(tree.roots.map((n) => n.id)).toContain('c1')
  })

  it('moveCommand 目标分组不存在报 NOT_FOUND', () => {
    expect(() => moveCommand(sample(), 'c1', 'ghost')).toThrow(/分组不存在/)
  })

  it('moveGroup 换父分组', () => {
    const next = moveGroup(sample(), 'nginx', 'db', 0)
    const tree = buildTree(next)
    const db = tree.roots.find((n) => n.id === 'db')
    if (db?.kind !== 'group') throw new Error('unreachable')
    expect(db.children.map((c) => c.id)).toContain('nginx')
    expect(next.groups.find((g) => g.id === 'nginx')?.parentId).toBe('db')
  })

  it('★ moveGroup 拒绝移动到自身或其子分组之下（防环）', () => {
    expect(() => moveGroup(sample(), 'db', 'db')).toThrow(/自身/)
    expect(() => moveGroup(sample(), 'db', 'mysql')).toThrow(/形成环/)
  })

  it('nextOrder 给同级下一个可用序号', () => {
    expect(nextOrder(sample(), 'mysql')).toBe(2)
    expect(nextOrder(sample(), null)).toBe(2) // web(order1) + c5(order0)
    // pg 组里已有 c3(order 0) → 下一个是 1
    expect(nextOrder(sample(), 'pg')).toBe(1)
  })
})
