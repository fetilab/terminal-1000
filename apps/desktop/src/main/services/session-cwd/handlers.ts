// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * shellIntegration 域的 IPC 接入。
 *
 * 只有读取类动作：命令块由解析器在后台维护（`installCwdTracking()` 一次订阅覆盖所有会话），
 * 渲染层/AI 随时来问即可，不需要"开始/停止"的生命周期。
 */

import { z } from 'zod'
import { parseInput } from '../../errors'
import type { IpcHandler } from '../../ipc/router'
import { DEFAULT_BLOCK_LIMIT, MAX_BLOCK_LIMIT, listCommandBlocks } from './command-blocks'

const listSchema = z.object({
  sessionId: z.string().min(1),
  limit: z.number().int().min(1).max(MAX_BLOCK_LIMIT).optional(),
})

export const shellIntegrationHandlers: Record<string, IpcHandler> = {
  /**
   * 读取某会话的命令块（含退出码）。
   *
   * **拿不到时不是空数组了事**：`blocks` 为空且带 `reason`（可操作说明，
   * 例如"该 shell 没发 OSC 133，bash 需在 PROMPT_COMMAND 里输出"），
   * 调用方必须把 reason 转达给用户，不要显示成"没有命令"。
   */
  listCommandBlocks: (payload) => {
    const { sessionId, limit } = parseInput(listSchema, payload)
    return listCommandBlocks(sessionId, limit ?? DEFAULT_BLOCK_LIMIT)
  },
}
