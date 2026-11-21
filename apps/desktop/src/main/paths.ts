// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

import { app } from 'electron'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { AppPaths } from '@t1000/shared'
import {
  APP_DIR_NAME,
  legacyCandidates,
  migrateDataDir,
  resolveDataDir,
  type MigrateReport,
} from './dataDir'

let cached: AppPaths | null = null

export interface DataDirInfo {
  dir: string
  /** 覆盖前 Electron 自己算出来的目录（通常和 dir 相同，dev 下会是 `@t1000/desktop`） */
  previous: string
  /** 结果原本落在安装目录里、被强制改写时给出原值 */
  relocatedFrom?: string
  migration: MigrateReport
  /** 安装目录（用于「数据是否在安装目录里」的自检提示） */
  exeDir: string
}

let prepared: DataDirInfo | null = null

/**
 * 解析并**钉住**数据目录，然后做一次性的旧数据迁移。
 *
 * 必须在任何 `app.getPath('userData')` 消费者之前调用 —— 具体是
 * `index.ts` 里 `applyEarlySettings()` 之前、单实例锁之前。
 * 由于 `getAppPaths()` 也会惰性调用它，即使有人改了启动顺序也不会读到错的目录。
 *
 * 幂等：重复调用返回同一份结果，不会重复迁移。
 */
export function prepareDataDir(): DataDirInfo {
  if (prepared) return prepared

  const previous = app.getPath('userData')
  const appData = safePath('appData')
  const home = safePath('home')
  const exeDir = dirname(safePath('exe'))

  const { dir, relocatedFrom } = resolveDataDir({
    platform: process.platform,
    appData,
    home,
    exeDir,
  })

  // 目录名钉死，不再跟随 app.getName()/package.json 的 name。
  // 两条路径相同时 setPath 是空操作，无需判断；但显式写出来更好读。
  if (resolvePath(previous) !== resolvePath(dir)) {
    app.setPath('userData', dir)
  }

  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

  const migration = migrateDataDir(
    dir,
    legacyCandidates({ appData, exeDir, previousUserData: previous }),
  )

  prepared = { dir, previous, relocatedFrom, migration, exeDir }
  return prepared
}

function safePath(key: 'appData' | 'home' | 'exe'): string {
  try {
    return app.getPath(key)
  } catch {
    // ready 之前个别路径在异常环境下取不到，退回一个不会造成破坏的值
    return key === 'exe' ? process.execPath : ''
  }
}

function resolvePath(p: string): string {
  return p.replace(/[\\/]+$/, '')
}

/**
 * 解析应用数据目录。所有需要持久化的路径都从这里取，避免散落的 join()。
 * 目录在首次访问时创建。
 *
 * ⚠️ 数据目录**只能是系统配置目录**（Linux `~/.config/terminal-1000`、
 * Windows `%APPDATA%\terminal-1000`）。绝不要改成安装目录或 `process.cwd()`：
 * 覆盖安装会连库一起删掉，用户看到的就是「升级后设置全丢」。
 * 解析规则与旧数据迁移见 `dataDir.ts`。
 */
export function getAppPaths(): AppPaths {
  if (cached) return cached

  const userData = prepareDataDir().dir
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
  prepared = null
}

export { APP_DIR_NAME }
