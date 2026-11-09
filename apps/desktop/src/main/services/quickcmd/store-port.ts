// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 快速命令的**持久化端口**（本地镜像语义，全部同步）。
 *
 * 为什么是同步的：本地库就是同步 KV（SQLite），而**云端库的正确形态是离线优先** ——
 * 读写打本地镜像、同步在后台跑。把端口定义成"本地镜像"而不是"远端 API"，
 * 带来两个好处：
 * 1. 服务层与 UI 完全同步、无 await 抖动，也不会出现"忘了 await 写入"的漏写 bug；
 * 2. 将来接云端只需实现本接口（`kind: 'cloud'`）：内部写本地 + 入队同步，
 *    服务层与 UI 一行都不用改 —— 这就是云端库的接入点。
 *
 * - 本地库实现见 `services/store/quickcmd.ts`（复用 store 的 KV + 字段加密）
 * - 测试与"无数据库"降级用 `MemoryQuickCmdStore`
 */

import type { ParamHistoryData } from './history'
import type { QuickCommandRecord, QuickGroupRecord, QuickLibrary } from './tree'

export type QuickCmdStoreKind = 'local' | 'cloud'

export interface QuickCmdStorePort {
  readonly kind: QuickCmdStoreKind
  loadLibrary(): QuickLibrary
  saveCommand(command: QuickCommandRecord): void
  deleteCommand(id: string): void
  saveGroup(group: QuickGroupRecord): void
  deleteGroup(id: string): void
  loadHistory(): ParamHistoryData
  saveHistory(data: ParamHistoryData): void
}

/** 内存实现：单测用，也可作为"存储不可用"时的降级 */
export class MemoryQuickCmdStore implements QuickCmdStorePort {
  readonly kind: QuickCmdStoreKind = 'local'
  private commands = new Map<string, QuickCommandRecord>()
  private groups = new Map<string, QuickGroupRecord>()
  private history: ParamHistoryData = {}

  /** 测试用：模拟写入失败 */
  failNextWrite?: Error

  private maybeFail(): void {
    if (this.failNextWrite) {
      const err = this.failNextWrite
      this.failNextWrite = undefined
      throw err
    }
  }

  loadLibrary(): QuickLibrary {
    return {
      commands: [...this.commands.values()].map((c) => ({ ...c })),
      groups: [...this.groups.values()].map((g) => ({ ...g })),
    }
  }

  saveCommand(command: QuickCommandRecord): void {
    this.maybeFail()
    this.commands.set(command.id, { ...command })
  }

  deleteCommand(id: string): void {
    this.maybeFail()
    this.commands.delete(id)
  }

  saveGroup(group: QuickGroupRecord): void {
    this.maybeFail()
    this.groups.set(group.id, { ...group })
  }

  deleteGroup(id: string): void {
    this.maybeFail()
    this.groups.delete(id)
  }

  loadHistory(): ParamHistoryData {
    return structuredClone(this.history)
  }

  saveHistory(data: ParamHistoryData): void {
    this.maybeFail()
    this.history = structuredClone(data)
  }
}
