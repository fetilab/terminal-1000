// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

import { app } from 'electron'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { AppPaths } from '@t1000/shared'

let cached: AppPaths | null = null

/**
 * 解析应用数据目录。所有需要持久化的路径都从这里取，避免散落的 join()。
 * 目录在首次访问时创建。
 */
export function getAppPaths(): AppPaths {
  if (cached) return cached

  const userData = app.getPath('userData')
  const paths: AppPaths = {
    userData,
    dbFile: join(userData, 'local-store.db'),
    notesDir: join(userData, 'notes'),
    sessionLogDir: join(userData, 'session-log'),
    watchDir: join(userData, 'watch'),
    bgImagesDir: join(userData, 'backgrounds'),
    backupDir: join(userData, 'backups'),
    logDir: join(userData, 'logs'),
  }

  for (const dir of [
    paths.notesDir,
    paths.sessionLogDir,
    paths.watchDir,
    paths.bgImagesDir,
    paths.backupDir,
    paths.logDir,
  ]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  }

  cached = paths
  return paths
}

/** 测试或多实例场景下重置缓存 */
export function resetPathsCache(): void {
  cached = null
}
