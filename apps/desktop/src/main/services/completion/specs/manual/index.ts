// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 命令手册语料的入口：核心（含示例的详版）+ 其余（用途/语法/安装方式）。
 *
 * 分层理由：示例是最费工夫也最有用的部分，先把最常用的做扎实；
 * 其余命令保证"能搜到、能看用途与语法"，后续可逐条补示例而不用改结构。
 *
 * 内容全部自撰（见 core.ts / rest.ts 的说明），未使用任何第三方语料。
 */

import type { ManualEntry } from '../types'
import { MANUAL_CORE } from './core'
import { MANUAL_REST } from './rest'

/**
 * 命令名 → 手册条目。
 * core 放在后面覆盖同名条目：同一命令若两边都有，以含示例的详版为准。
 */
export const MANUAL_BY_NAME: ReadonlyMap<string, ManualEntry> = new Map([
  ...Object.entries(MANUAL_REST),
  ...Object.entries(MANUAL_CORE),
])

/** 有示例（详版）的命令数 */
export const MANUAL_CORE_SIZE = Object.keys(MANUAL_CORE).length
/** 手册条目总数 */
export const MANUAL_SIZE = MANUAL_BY_NAME.size

export function manualFor(name: string): ManualEntry | undefined {
  return MANUAL_BY_NAME.get(name)
}
