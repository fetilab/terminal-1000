// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 快速命令的 IPC 封装。
 *
 * 把 19 个动作的**确切入参**收敛到一个文件里，而不是散在组件中：
 * 主进程的 zod schema 用 `id`/`targetId`/`ids` 这类名字，很容易在调用点写错
 * （上一轮 `ptyId` vs `sessionId` 就是这么把本地终端打字吞掉的）。
 *
 * `quickcmd` 已在 `IPC_DOMAINS` + `Actions.quickcmd` 登记，直接调用即可。
 * （类型本身仍在主进程侧，渲染层这份镜像待上移；domain 已经不需要绕了。）
 */

import { invoke } from '../../lib/ipc'
import type {
  AnalyzeResult,
  CommandWithPath,
  ExecuteOutcome,
  ParameterDialogData,
  PasteOutcome,
  QuickCommandRecord,
  QuickGroupRecord,
  QuickLibraryResponse,
  RenderOutcome,
  VariablePreview,
  ParamHistoryData,
} from './quickcmdTypes'

function call<R>(action: string, payload: unknown): Promise<R> {
  // `quickcmd` 已在 IPC_DOMAINS / Actions.quickcmd 里，直接传字面量即可
  return invoke<'quickcmd', string, unknown, R>('quickcmd', action, payload)
}

export const quickcmd = {
  list: () => call<QuickLibraryResponse>('list', {}),
  listGroups: () => call<QuickGroupRecord[]>('listGroups', {}),

  save: (input: {
    id?: string
    groupId?: string | null
    name: string
    command: string
    note?: string
  }) => call<QuickCommandRecord>('save', input),

  /** 注意是 `ids` 数组，不是单个 id */
  remove: (ids: string[]) => call<{ removed: number }>('delete', { ids }),

  /** 命令与分组共用：kind 决定 targetId 的含义（命令看 groupId，分组看 parentId） */
  move: (input: {
    kind: 'command' | 'group'
    id: string
    targetId: string | null
    index?: number
  }) => call<unknown>('move', input),

  reorder: (parentId: string | null, orderedIds: string[]) =>
    call<unknown>('reorder', { parentId, orderedIds }),

  saveGroup: (input: { id?: string; parentId?: string | null; name: string }) =>
    call<QuickGroupRecord>('saveGroup', input),

  /** `previewGroupDelete` 是删除分组的二次确认数据源 */
  previewGroupDelete: (id: string) =>
    call<{ groups: number; commands: number }>('previewGroupDelete', { id }),

  deleteGroup: (id: string) =>
    call<{ removedGroups: number; removedCommands: number }>('deleteGroup', { id }),

  /** 后端 search 已支持拼音首字母（`qd` → 前端） */
  search: (query: string) => call<CommandWithPath[]>('search', { query }),

  render: (input: { commandId?: string; command?: string; params?: Record<string, string> }) =>
    call<RenderOutcome>('render', input),

  parameterDialog: (input: { commandId?: string; command?: string }) =>
    call<ParameterDialogData>('parameterDialog', input),

  execute: (input: {
    sessionId: string
    commandId?: string
    command?: string
    params?: Record<string, string>
  }) => call<ExecuteOutcome>('execute', input),

  /** 只取渲染结果、不发送 —— 供"粘贴到终端输入框" */
  paste: (input: { commandId?: string; command?: string; params?: Record<string, string> }) =>
    call<PasteOutcome>('paste', input),

  analyze: (command: string) => call<AnalyzeResult>('analyze', { command }),

  variables: () => call<VariablePreview[]>('variables', {}),

  history: (name?: string, limit?: number) =>
    call<ParamHistoryData | { name: string; values: string[] }>(
      'history',
      name === undefined ? {} : { name, ...(limit === undefined ? {} : { limit }) },
    ) as Promise<ParamHistoryData>,

  clearHistory: (name?: string) => call<unknown>('clearHistory', name === undefined ? {} : { name }),

  storage: () => call<{ kind: string }>('storage', {}),
}
