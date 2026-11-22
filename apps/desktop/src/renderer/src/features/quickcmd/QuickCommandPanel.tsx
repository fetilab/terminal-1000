// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 快速命令面板（终端左侧边栏）。
 *
 * spec §6 的要点都落在这一屏：
 * - 搜索**按名称或拼音首字母**（`qd` → 「前端」）—— 由后端 `search` 实现，前端不自己写拼音表
 * - 命令**可多行**，执行时**逐行发送**：树上给多行命令打标记，执行前也如实提示
 * - 删除分组必须说清「**会同时删除组内所有命令**」—— 用 `previewGroupDelete` 拿准确数量
 * - 参数 `${{名}}`：有参数则先弹填写窗
 * - 双击默认行为固定为「编辑」（可配置的设置在 spec 里，但设置项还没加，先定一个合理默认）
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Badge, EmptyState, Loading } from '../../components/Feedback'
import { Button, IconButton } from '../../components/Button'
import { Icon } from '../../components/Icon'
import { Modal } from '../../components/Modal'
import { Field, TextInput } from '../../components/Form'
import { ContextMenu, type ContextMenuItem } from '../../components/ContextMenu'
import { toast } from '../../components/Toast'
import { errorText } from '../../lib/format'
import { writeToSession, useStoreShallow, type TabKind } from '../../lib/store'
import { quickcmd } from './quickcmdApi'
import type {
  CommandNode,
  QuickTree,
  CommandWithPath,
  GroupTree,
  QuickCommandRecord,
  QuickGroupRecord,
  QuickNode,
} from './quickcmdTypes'
import { QuickCommandEditor } from './QuickCommandEditor'
import { ParamDialog } from './ParamDialog'
import './quickcmd.css'
import { copyText } from '../../lib/clipboard'

interface DropTarget {
  kind: 'command' | 'group'
  id: string
  /** 落在行上半部 = 插到它前面；落在分组行上 = 放进该组 */
  position: 'before' | 'into'
}

export function QuickCommandPanel(): React.JSX.Element {
  const { sessionId, kind } = useStoreShallow((s) => {
    const tab = s.tabs.find((t) => t.tabId === s.activeTabId)
    return { sessionId: tab?.sessionId, kind: (tab?.kind ?? 'ssh') as TabKind }
  })

  const [tree, setTree] = useState<QuickNode[]>([])
  const [totals, setTotals] = useState({ commands: 0, groups: 0 })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<CommandWithPath[]>([])
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  const [menu, setMenu] = useState<{ x: number; y: number; node: QuickNode } | null>(null)
  const [editor, setEditor] = useState<
    { mode: 'create' | 'edit'; groupId: string | null; command?: QuickCommandRecord } | null
  >(null)
  const [paramFor, setParamFor] = useState<
    { commandId: string; name: string; mode: 'execute' | 'paste' } | null
  >(null)
  const [groupDialog, setGroupDialog] = useState<{ parentId: string | null; group?: QuickGroupRecord } | null>(
    null,
  )
  const [deleteGroup, setDeleteGroup] = useState<{
    group: GroupTree
    preview: { groups: number; commands: number }
  } | null>(null)
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null)
  const dragRef = useRef<{ kind: 'command' | 'group'; id: string } | null>(null)

  const reload = useCallback(async () => {
    try {
      const res = await quickcmd.list()
      // `tree` 是 { roots, totalCommands, totalGroups } 不是数组；
      // 这里再兜一层 Array.isArray：契约形状变了要降级成空列表，而不是整块崩掉
      const roots = res?.tree?.roots
      setTree(Array.isArray(roots) ? roots : [])
      setTotals({
        commands: res?.tree?.totalCommands ?? 0,
        groups: res?.tree?.totalGroups ?? 0,
      })
      setError(null)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  // 搜索走后端（它已经实现了拼音首字母匹配）
  useEffect(() => {
    const q = query.trim()
    if (!q) {
      setResults([])
      return
    }
    const t = window.setTimeout(() => {
      void quickcmd
        .search(q)
        .then((r) => setResults(r ?? []))
        .catch(() => setResults([]))
    }, 200)
    return () => window.clearTimeout(t)
  }, [query])

  /** 命令里有没有参数占位符 —— 有就先弹填写窗，别直接发出去 */
  const hasParams = (command: string): boolean => /\$\{\{/.test(command)

  const runCommand = useCallback(
    async (node: { id: string; name: string; command: string }, mode: 'execute' | 'paste') => {
      if (!sessionId) {
        toast.warn('先打开一个会话，快速命令需要发送到终端')
        return
      }
      if (hasParams(node.command)) {
        // 交给参数窗，填完再真正发送
        setParamFor({ commandId: node.id, name: node.name, mode })
        return
      }
      const lines = node.command.split('\n').filter((l) => l.trim() !== '')
      try {
        if (mode === 'execute') {
          const res = await quickcmd.execute({ sessionId, commandId: node.id })
          toast.ok(`已发送「${node.name}」：${res?.sent ?? lines.length} 行（逐行发送）`)
        } else {
          const res = await quickcmd.paste({ commandId: node.id })
          // 粘贴到"输入框"= 只把文本送进终端、不回车，用户可以改完再执行
          await writeToSession(kind, sessionId, res?.text ?? node.command)
          toast.ok(`已粘贴到终端输入框（未执行）：${res?.lines.length ?? lines.length} 行`)
        }
      } catch (err) {
        toast.error(`${mode === 'execute' ? '执行' : '粘贴'}失败：${errorText(err)}`)
      }
    },
    [sessionId, kind],
  )

  const removeCommand = useCallback(
    async (node: CommandNode) => {
      try {
        await quickcmd.remove([node.id])
        toast.ok(`已删除「${node.name}」`)
        await reload()
      } catch (err) {
        toast.error(`删除失败：${errorText(err)}`)
      }
    },
    [reload],
  )

  const askDeleteGroup = useCallback(async (group: GroupTree) => {
    try {
      const preview = await quickcmd.previewGroupDelete(group.id)
      setDeleteGroup({ group, preview })
    } catch (err) {
      toast.error(`读取待删内容失败：${errorText(err)}`)
    }
  }, [])

  /* ── 拖拽：命令换组/组内排序；分组换父级 ── */

  const onDrop = useCallback(
    async (target: DropTarget) => {
      const drag = dragRef.current
      dragRef.current = null
      setDropTarget(null)
      if (!drag || (drag.kind === target.kind && drag.id === target.id)) return
      try {
        if (drag.kind === 'command') {
          // 命令：拖到分组行上 = 放进该组；拖到命令行上 = 放到同级
          if (target.kind === 'group') {
            await quickcmd.move({ kind: 'command', id: drag.id, targetId: target.id })
          } else {
            const parent = findParentId(tree, target.id)
            await quickcmd.move({ kind: 'command', id: drag.id, targetId: parent, index: indexOf(tree, target.id) })
          }
        } else {
          if (target.kind !== 'group') return
          await quickcmd.move({ kind: 'group', id: drag.id, targetId: target.id })
        }
        await reload()
      } catch (err) {
        toast.error(`移动失败：${errorText(err)}`)
      }
    },
    [tree, reload],
  )

  const menuItems = (node: QuickNode): ContextMenuItem[] => {
    if (node.kind === 'group') {
      return [
        { id: 'newcmd', label: '在此分组新建命令', icon: 'plus', onSelect: () => setEditor({ mode: 'create', groupId: node.id }) },
        { id: 'newsub', label: '新建子分组', icon: 'folder', onSelect: () => setGroupDialog({ parentId: node.id }) },
        {
          id: 'rename',
          label: '重命名分组',
          icon: 'edit',
          separatorBefore: true,
          onSelect: () => setGroupDialog({ parentId: node.parentId, group: node as unknown as QuickGroupRecord }),
        },
        { id: 'del', label: '删除分组…', icon: 'trash', danger: true, onSelect: () => void askDeleteGroup(node) },
      ]
    }
    return [
      { id: 'run', label: '立即执行', icon: 'zap', onSelect: () => void runCommand(node, 'execute') },
      { id: 'paste', label: '粘贴到终端（不执行）', icon: 'download', onSelect: () => void runCommand(node, 'paste') },
      {
        id: 'copy',
        label: '复制命令',
        icon: 'copy',
        onSelect: () => {
          void copyText(node.command).then(() => toast.ok('命令已复制到剪贴板'))
        },
      },
      {
        id: 'edit',
        label: '编辑',
        icon: 'edit',
        separatorBefore: true,
        onSelect: () => setEditor({ mode: 'edit', groupId: node.groupId, command: toRecord(node) }),
      },
      { id: 'del', label: '删除命令', icon: 'trash', danger: true, onSelect: () => void removeCommand(node) },
    ]
  }

  const searchMode = query.trim().length > 0
  const nodes: Array<{ node: QuickNode; depth: number }> = useMemo(
    () => (searchMode ? [] : flatten(tree, expanded)),
    [tree, expanded, searchMode],
  )

  return (
    <div className="qc">
      <div className="qc__search">
        <div className="t-search" style={{ maxWidth: '100%' }}>
          <span className="t-search__icon">
            <Icon name="search" size={14} />
          </span>
          <input
            className="t-input"
            value={query}
            placeholder="搜索命令或拼音首字母（qd → 前端）"
            aria-label="搜索快速命令"
            onChange={(e) => setQuery(e.target.value)}
          />
          {query ? <IconButton className="t-search__clear" icon="close" label="清空" onClick={() => setQuery('')} /> : null}
        </div>
      </div>

      <div className="qc__body">
        {error ? (
          <div style={{ padding: 8 }}>
            <div className="t-banner t-banner--error">{error}</div>
          </div>
        ) : loading ? (
          <Loading text="读取快速命令…" />
        ) : searchMode ? (
          results.length === 0 ? (
            <div className="qc__empty">没有匹配「{query.trim()}」的命令</div>
          ) : (
            <>
              <div className="qc__empty" style={{ textAlign: 'left', padding: '6px 8px' }}>
                {results.length} 条结果（支持拼音首字母）
              </div>
              {results.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  className="qc-row"
                  title={r.command}
                  onClick={() => void runCommand(r, 'execute')}
                  onContextMenu={(e) => {
                    e.preventDefault()
                    setMenu({ x: e.clientX, y: e.clientY, node: toNode(r) })
                  }}
                >
                  <Icon name="zap" size={13} />
                  <span className="qc-row__label">
                    {r.name}
                    {r.groupPath.length > 0 ? (
                      <span className="qc-row__count"> · {r.groupPath.join(' / ')}</span>
                    ) : null}
                  </span>
                  {r.command.includes('\n') ? <span className="qc-row__multi">多行</span> : null}
                  {hasParams(r.command) ? <span className="qc-row__param">参数</span> : null}
                </button>
              ))}
            </>
          )
        ) : nodes.length === 0 ? (
          <EmptyState
            icon="zap"
            title="还没有快速命令"
            text="把常用的排查命令存进来，之后一键发送到当前会话。支持分组、多行、${{参数}} 与动态变量。"
            actions={
              <>
                <Button variant="primary" icon="plus" onClick={() => setEditor({ mode: 'create', groupId: null })}>
                  新建命令
                </Button>
                <Button variant="outline" icon="folder" onClick={() => setGroupDialog({ parentId: null })}>
                  新建分组
                </Button>
              </>
            }
          />
        ) : (
          nodes.map(({ node, depth }) => (
            <TreeRow
              key={node.id}
              node={node}
              depth={depth}
              expanded={expanded.has(node.id)}
              dropTarget={dropTarget}
              onToggle={() =>
                setExpanded((prev) => {
                  const next = new Set(prev)
                  if (next.has(node.id)) next.delete(node.id)
                  else next.add(node.id)
                  return next
                })
              }
              onRun={() => {
                // 分组节点没有 command，只有命令才能执行
                if (node.kind === 'command') void runCommand(node, 'execute')
              }}
              onContextMenu={(x, y) => setMenu({ x, y, node })}
              onDragStart={() => {
                dragRef.current = { kind: node.kind, id: node.id }
              }}
              onDragOver={(position) => {
                const drag = dragRef.current
                if (!drag) return
                if (drag.id === node.id) return
                setDropTarget({ kind: node.kind, id: node.id, position })
              }}
              onDrop={() => {
                const pos = dropTarget
                if (pos) void onDrop(pos)
              }}
              onDragEnd={() => {
                dragRef.current = null
                setDropTarget(null)
              }}
            />
          ))
        )}
      </div>

      <div className="panel-footer">
        <IconButton icon="folder" label="新建分组" onClick={() => setGroupDialog({ parentId: null })} />
        <Button
          size="sm"
          variant="outline"
          icon="plus"
          style={{ flex: 1 }}
          onClick={() => setEditor({ mode: 'create', groupId: null })}
        >
          新建命令
        </Button>
      </div>

      <ContextMenu
        open={menu !== null}
        x={menu?.x ?? 0}
        y={menu?.y ?? 0}
        items={menu ? menuItems(menu.node) : []}
        onClose={() => setMenu(null)}
      />

      {editor ? (
        <QuickCommandEditor
          mode={editor.mode}
          groupId={editor.groupId}
          {...(editor.command === undefined ? {} : { command: editor.command })}
          onClose={() => setEditor(null)}
          onSaved={async () => {
            setEditor(null)
            await reload()
          }}
        />
      ) : null}

      {groupDialog ? (
        <GroupDialog
          parentId={groupDialog.parentId}
          {...(groupDialog.group === undefined ? {} : { group: groupDialog.group })}
          onClose={() => setGroupDialog(null)}
          onSaved={async () => {
            setGroupDialog(null)
            await reload()
          }}
        />
      ) : null}

      {paramFor ? (
        <ParamDialog
          commandId={paramFor.commandId}
          name={paramFor.name}
          mode={paramFor.mode}
          sessionId={sessionId ?? ''}
          sessionKind={kind}
          onClose={() => setParamFor(null)}
          onDone={async (msg) => {
            setParamFor(null)
            toast.ok(msg)
            await reload()
          }}
        />
      ) : null}

      {/* 删除分组：必须说清会连带删掉组内命令 */}
      <Modal
        open={deleteGroup !== null}
        size="sm"
        title="删除分组"
        onClose={() => setDeleteGroup(null)}
        footer={
          <>
            <div className="t-modal__footer-spacer" />
            <Button variant="ghost" onClick={() => setDeleteGroup(null)}>
              取消
            </Button>
            <Button
              variant="danger"
              onClick={async () => {
                if (!deleteGroup) return
                try {
                  const res = await quickcmd.deleteGroup(deleteGroup.group.id)
                  toast.ok(`已删除 ${res.removedGroups} 个分组、${res.removedCommands} 条命令`)
                  setDeleteGroup(null)
                  await reload()
                } catch (err) {
                  toast.error(`删除失败：${errorText(err)}`)
                }
              }}
            >
              确认删除
            </Button>
          </>
        }
      >
        <p className="t-field__hint" style={{ marginTop: 0 }}>
          将删除分组 <b>{deleteGroup?.group.name}</b>
          {deleteGroup && deleteGroup.group.children.length > 0 ? ' 及其子分组' : ''}。
        </p>
        <div className="t-banner t-banner--warn" style={{ marginTop: 8 }}>
          ⚠️ 会**同时删除组内所有命令**：将删除 <b>{deleteGroup?.preview.groups ?? 0}</b> 个分组、
          <b>{deleteGroup?.preview.commands ?? 0}</b> 条命令。此操作不可撤销。
        </div>
      </Modal>
    </div>
  )
}

/* ── 树 ────────────────────────────────────────── */

interface TreeRowProps {
  node: QuickNode
  depth: number
  expanded: boolean
  dropTarget: DropTarget | null
  onToggle: () => void
  onRun: () => void
  onContextMenu: (x: number, y: number) => void
  onDragStart: () => void
  onDragOver: (position: 'before' | 'into') => void
  onDrop: () => void
  onDragEnd: () => void
}

function TreeRow({
  node,
  depth,
  expanded,
  dropTarget,
  onToggle,
  onRun,
  onContextMenu,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
}: TreeRowProps): React.JSX.Element {
  const isGroup = node.kind === 'group'
  const dropClass =
    dropTarget && dropTarget.id === node.id
      ? dropTarget.position === 'into'
        ? ' qc-row--drop-into'
        : ' qc-row--drop-before'
      : ''
  return (
    <button
      type="button"
      className={`qc-row${dropClass}`}
      style={{ paddingLeft: 7 + depth * 13 }}
      draggable
      title={isGroup ? node.name : node.command}
      onClick={() => (isGroup ? onToggle() : void onRun())}
      onDoubleClick={() => {
        // 双击默认 = 编辑（spec 说可配置，设置项还没加，先固定这个合理默认）
        onContextMenu(0, 0)
      }}
      onContextMenu={(e) => {
        e.preventDefault()
        onContextMenu(e.clientX, e.clientY)
      }}
      onDragStart={onDragStart}
      onDragOver={(e) => {
        e.preventDefault()
        const r = e.currentTarget.getBoundingClientRect()
        // 分组行：中间区域=放进组；命令行：一律按"插到它前面"
        const intoGroup = isGroup && e.clientY - r.top > r.height / 2
        onDragOver(intoGroup ? 'into' : 'before')
      }}
      onDrop={(e) => {
        e.preventDefault()
        onDrop()
      }}
      onDragEnd={onDragEnd}
    >
      <span className={`qc-row__twisty${isGroup ? '' : ' tree__twisty--leaf'}`} aria-hidden>
        {isGroup ? <Icon name={expanded ? 'chevron-down' : 'chevron-right'} size={12} /> : null}
      </span>
      <Icon name={isGroup ? 'folder' : 'zap'} size={13} />
      <span className="qc-row__label">{node.name}</span>
      {isGroup ? <span className="qc-row__count">{node.commandCount}</span> : null}
      {!isGroup && node.command.includes('\n') ? <span className="qc-row__multi">多行</span> : null}
      {!isGroup && /\$\{\{/.test(node.command) ? <span className="qc-row__param">参数</span> : null}
    </button>
  )
}

/* ── 辅助 ──────────────────────────────────────── */

function flatten(nodes: QuickNode[], expanded: Set<string>, depth = 0): Array<{ node: QuickNode; depth: number }> {
  const out: Array<{ node: QuickNode; depth: number }> = []
  for (const n of nodes) {
    out.push({ node: n, depth })
    if (n.kind === 'group' && expanded.has(n.id)) out.push(...flatten(n.children, expanded, depth + 1))
  }
  return out
}

function findParentId(nodes: QuickNode[], id: string, parent: string | null = null): string | null {
  for (const n of nodes) {
    if (n.id === id) return parent
    if (n.kind === 'group') {
      const found = findParentId(n.children, id, n.id)
      if (found !== null) return found
      // 递归里没命中会返回 null，无法区分"没找到"和"父级是根"，这里用第二遍判断
    }
  }
  return parent
}

function indexOf(nodes: QuickNode[], id: string): number {
  const i = nodes.findIndex((n) => n.id === id)
  return i < 0 ? 0 : i
}

function toNode(c: CommandWithPath): CommandNode {
  return {
    kind: 'command',
    id: c.id,
    name: c.name,
    command: c.command,
    ...(c.note === undefined ? {} : { note: c.note }),
    order: c.order,
    groupId: c.groupId,
  }
}

function toRecord(n: CommandNode): QuickCommandRecord {
  return {
    id: n.id,
    groupId: n.groupId,
    name: n.name,
    command: n.command,
    ...(n.note === undefined ? {} : { note: n.note }),
    order: n.order,
    createdAt: '',
    updatedAt: '',
  }
}

/* ── 分组弹窗 ──────────────────────────────────── */

function GroupDialog({
  parentId,
  group,
  onClose,
  onSaved,
}: {
  parentId: string | null
  group?: QuickGroupRecord
  onClose: () => void
  onSaved: () => void | Promise<void>
}): React.JSX.Element {
  const [name, setName] = useState(group?.name ?? '')
  const [err, setErr] = useState<string | null>(null)
  const submit = async (): Promise<void> => {
    if (!name.trim()) {
      setErr('分组名不能为空')
      return
    }
    try {
      await quickcmd.saveGroup({
        ...(group ? { id: group.id } : {}),
        parentId: group ? group.parentId : parentId,
        name: name.trim(),
      })
      await onSaved()
    } catch (e) {
      setErr(errorText(e))
    }
  }
  return (
    <Modal
      open
      size="sm"
      title={group ? '重命名分组' : '新建分组'}
      onClose={onClose}
      footer={
        <>
          <div className="t-modal__footer-spacer" />
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" onClick={() => void submit()}>
            {group ? '保存' : '创建'}
          </Button>
        </>
      }
    >
      <Field label="分组名称" required error={err}>
        <TextInput
          value={name}
          autoFocus
          placeholder="例如：前端 / 数据库运维"
          onChange={(e) => {
            setName(e.target.value)
            setErr(null)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void submit()
          }}
        />
      </Field>
    </Modal>
  )
}

export default QuickCommandPanel
