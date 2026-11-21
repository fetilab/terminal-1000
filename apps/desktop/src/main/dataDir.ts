// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 数据目录的解析与迁移（**纯逻辑，不 import electron**，便于单测）。
 *
 * 为什么需要这个模块：
 *
 * 原先数据目录直接取 `app.getPath('userData')`，而这个值等于
 * `<系统配置目录>/<app.getName()>` —— 名字来自 package.json 的 `name`/`productName`。
 * 这带来两种「升级即丢设置」的真实故障：
 *
 * 1. **开发态与打包态名字不同**（`@t1000/desktop` vs `terminal-1000`），
 *    两边的库压根不是同一个文件；
 * 2. 一旦打包配置里的名字变了（或某个 target 改写了 metadata），新版本就会
 *    开一个全新的空库，用户看见的就是「设置全没了」，但旧数据其实还躺在旧目录里。
 *
 * 还有一种更糟的形态：应用以只读安装目录为工作目录运行、或被人为指定了
 * `userData`，数据落进**安装目录**，那么任何一次覆盖安装都会连库一起删掉。
 *
 * 因此这里做三件事：
 * - 目录名**钉死**成 `terminal-1000`，不再跟随 package.json；
 * - 目录**绝不允许落在安装目录里**（落进去就强制搬到系统配置目录）；
 * - 首次启动时把旧位置的数据**复制**过来（只复制、不删除原目录）。
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'

/** 目录名常量。**改这个值等于让所有老用户丢数据**，除非同时加迁移。 */
export const APP_DIR_NAME = 'terminal-1000'

/** 需要迁移的文件（库本体 + 主进程的小状态文件） */
export const MIGRATE_FILES = [
  'local-store.db',
  'local-store.db-wal',
  'local-store.db-shm',
  'known-hosts.json',
  'window-bounds.json',
] as const

/** 需要迁移的子目录（用户可见的内容都在这里） */
export const MIGRATE_DIRS = [
  'notes',
  'session-log',
  'watch',
  'backgrounds',
  'backups',
  'logs',
] as const

/**
 * Chromium 的 localStorage 也一并搬走：界面偏好（分栏宽度、折叠状态、排序方式）
 * 存在那里，不搬的话用户会觉得「设置还是丢了」。
 */
export const MIGRATE_PROFILE_DIRS = ['Local Storage'] as const

export interface ResolveDataDirInput {
  platform: NodeJS.Platform
  /** 系统配置根目录：Linux `~/.config`、Windows `%APPDATA%`、macOS `~/Library/Application Support` */
  appData: string
  /** 用户主目录，仅在 appData 缺失时兜底 */
  home: string
  /** 可执行文件所在目录（安装目录） */
  exeDir: string
}

export interface ResolveDataDirResult {
  dir: string
  /** 计算结果落在安装目录里被强制改写时，这里给出原始值（用于日志/告知用户） */
  relocatedFrom?: string
}

/**
 * 判断 child 是否位于 parent 内（同路径也算）。做了 resolve 与大小写规整，
 * 避免 `C:\App` 与 `c:\app\` 这种写法差异导致漏判。
 */
export function isInside(child: string, parent: string): boolean {
  if (!child || !parent) return false
  const c = normalize(resolve(child))
  const p = normalize(resolve(parent))
  if (c === p) return true
  return c.startsWith(p.endsWith(sep) ? p : p + sep)
}

function normalize(p: string): string {
  // Windows 路径大小写不敏感；其它平台保持原样（大小写敏感）
  return process.platform === 'win32' ? p.toLowerCase() : p
}

/**
 * 解析数据目录。规则很简单：**永远是系统配置目录 + 固定名**。
 *
 * 唯一的分支是「结果落在安装目录里」—— 这只会发生在 `appData` 被人为指到
 * 安装目录（便携模式误配置、或启动器把 XDG_CONFIG_HOME 设成相对路径）时，
 * 此时退回 `~/.terminal-1000` 并记录原始值，绝不让库文件住在会被覆盖安装清掉的目录。
 */
export function resolveDataDir(input: ResolveDataDirInput): ResolveDataDirResult {
  const appData = input.appData && isAbsolute(input.appData) ? input.appData : ''
  const base = appData || fallbackConfigHome(input.platform, input.home)
  const candidate = join(base, APP_DIR_NAME)

  if (input.exeDir && isInside(candidate, input.exeDir)) {
    // 落到安装目录 → 换到主目录下（不会被安装器覆盖的位置）
    return { dir: join(input.home, `.${APP_DIR_NAME}`), relocatedFrom: candidate }
  }
  return { dir: candidate }
}

function fallbackConfigHome(platform: NodeJS.Platform, home: string): string {
  if (platform === 'win32') return join(home, 'AppData', 'Roaming')
  if (platform === 'darwin') return join(home, 'Library', 'Application Support')
  return join(home, '.config')
}

/**
 * 旧版本可能用过的数据目录（按可信度排序）。
 *
 * 前两个是 `app.getName()` 曾经取到的值；后两个是「数据被写进安装目录」的形态。
 */
export function legacyCandidates(input: {
  appData: string
  exeDir: string
  previousUserData?: string
}): string[] {
  const out: string[] = []
  const push = (p: string | undefined): void => {
    if (!p) return
    if (!out.some((x) => resolve(x) === resolve(p))) out.push(p)
  }
  // 1. Electron 自己算出来的 userData（就是本次要覆盖掉的那个值）
  push(input.previousUserData)
  // 2. 带 scope 的旧名字：`<config>/@t1000/desktop`（Linux 是两层目录）
  push(join(input.appData, '@t1000', 'desktop'))
  // 3. Electron 把 `/` 换成 `desktop` 后的扁平写法
  push(join(input.appData, '@t1000desktop'))
  // 4. 安装目录里的残留（覆盖安装前唯一能救回来的机会）
  push(join(input.exeDir, 'userData'))
  push(input.exeDir)
  return out
}

export interface MigrateItem {
  name: string
  kind: 'file' | 'dir'
}

export interface MigrateReport {
  /** 实际发生迁移的源目录；没迁移时为 null */
  from: string | null
  items: MigrateItem[]
  /** 迁移中失败但不应阻断启动的项 */
  failed: string[]
}

const EMPTY_REPORT: MigrateReport = { from: null, items: [], failed: [] }

/** 目标目录里是否已经有库（有就说明不是首次启动，绝不能再覆盖） */
export function hasExistingStore(dir: string): boolean {
  return existsSync(join(dir, 'local-store.db'))
}

/**
 * 打分：判断某个候选目录里到底有没有「我们的数据」。
 * 只认库文件与明确归属我们的文件名/目录名，避免把别人的 Chromium 配置搬进来。
 */
export function scoreCandidate(dir: string): number {
  if (!existsSync(dir)) return 0
  let score = 0
  if (existsSync(join(dir, 'local-store.db'))) score += 100
  if (existsSync(join(dir, 'known-hosts.json'))) score += 20
  if (existsSync(join(dir, 'window-bounds.json'))) score += 5
  for (const d of [...MIGRATE_DIRS, ...MIGRATE_PROFILE_DIRS]) {
    if (existsSync(join(dir, d))) score += 3
  }
  return score
}

/**
 * 把旧目录的数据复制到目标目录。
 *
 * 语义刻意保守：
 * - 目标已有 `local-store.db` → 直接跳过（幂等，重复启动不会互相污染）；
 * - 只复制**目标里还不存在**的项（不做合并、不覆盖）；
 * - **不删除源目录**（用户自己确认没问题后再手动清）。
 */
export function migrateDataDir(target: string, candidates: readonly string[]): MigrateReport {
  if (hasExistingStore(target)) return { ...EMPTY_REPORT }

  const ranked = candidates
    .filter((c) => resolve(c) !== resolve(target))
    .map((c) => ({ dir: c, score: scoreCandidate(c) }))
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score)

  const best = ranked[0]
  if (!best) return { ...EMPTY_REPORT }

  mkdirSync(target, { recursive: true })
  const items: MigrateItem[] = []
  const failed: string[] = []

  for (const name of [...MIGRATE_FILES, ...MIGRATE_DIRS, ...MIGRATE_PROFILE_DIRS]) {
    const src = join(best.dir, name)
    if (!existsSync(src)) continue
    const dst = join(target, name)
    if (existsSync(dst)) continue
    try {
      const st = statSync(src)
      if (st.isDirectory()) {
        copyDir(src, dst)
        items.push({ name, kind: 'dir' })
      } else {
        copyFile(src, dst)
        items.push({ name, kind: 'file' })
      }
    } catch {
      failed.push(name)
    }
  }

  // 迁移记录：出问题时能直接看出「数据从哪来」，也避免以后重复迁移
  try {
    writeFileSync(
      join(target, 'migration.json'),
      JSON.stringify(
        {
          from: best.dir,
          at: new Date().toISOString(),
          appVersion: process.env.npm_package_version ?? null,
          items: items.map((i) => i.name),
          failed,
        },
        null,
        2,
      ),
    )
  } catch {
    /* 记录失败不影响迁移结果 */
  }

  return { from: best.dir, items, failed }
}

/**
 * 复制单个文件。
 *
 * 不用 `copyFileSync` 一把梭：某些内核/沙箱下 `copy_file_range` 会被拒（EPERM），
 * 而普通读写在同样的环境里是好的。这里做一次降级，保证迁移不会因为环境怪癖失败。
 */
export function copyFile(src: string, dst: string): void {
  mkdirSync(dirname(dst), { recursive: true })
  try {
    copyFileSync(src, dst)
  } catch {
    writeFileSync(dst, readFileSync(src))
  }
}

/** 递归复制目录（同样不走 copyFileSync 的聚合快路径） */
export function copyDir(src: string, dst: string): void {
  mkdirSync(dst, { recursive: true })
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const s = join(src, entry.name)
    const d = join(dst, entry.name)
    if (entry.isDirectory()) copyDir(s, d)
    else if (entry.isSymbolicLink()) {
      // 符号链接按内容复制：跨机器/跨盘迁移时保留链接容易变成死链
      try {
        writeFileSync(d, readFileSync(s))
      } catch {
        /* 读不到就跳过该项 */
      }
    } else copyFile(s, d)
  }
}
