// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 分类 → 详情模块的**惰性加载器**。
 *
 * 这里的 `import()` 都是静态字面量，打包器能据此做按类代码分割：
 * 只有某个命令真的被命中，才会加载它所属分类的那一个模块。
 * 首屏只加载 `../catalog`（命令名 + 简述），不碰本文件中的任何一个模块。
 */

import type { CommandCategory, SpecRows } from '../types'

export type CategoryDetails = Record<string, SpecRows>

/** 分类 → 惰性加载器 */
export const CATEGORY_LOADERS: Record<CommandCategory, () => Promise<CategoryDetails>> = {
  files: () => import('./files').then((m) => m.FILES_SPECS),
  text: () => import('./text').then((m) => m.TEXT_SPECS),
  process: () => import('./process').then((m) => m.PROCESS_SPECS),
  network: () => import('./network').then((m) => m.NETWORK_SPECS),
  system: () => import('./system').then((m) => m.SYSTEM_SPECS),
  package: () => import('./package').then((m) => m.PACKAGE_SPECS),
  container: () => import('./container').then((m) => m.CONTAINER_SPECS),
  vcs: () => import('./vcs').then((m) => m.VCS_SPECS),
  security: () => import('./security').then((m) => m.SECURITY_SPECS),
}
