// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 本地 shell 探测与 profile。
 *
 * 查找与解析规则：
 * - shell 查找目录序 `/bin, /usr/bin, /usr/local/bin, /opt/homebrew/bin`
 * - 平台默认：darwin → `$SHELL || /bin/zsh`，其它 → `$SHELL || /bin/sh`
 * - `resolveShell`：空 → 平台默认；Windows 原样；绝对路径直接用；
 *   否则先比对 `os.userInfo().shell` 的 basename，再在查找目录里找，找不到原样返回
 * - env：`TERM`（可覆盖，默认 xterm-256color）、`COLORTERM`（默认 truecolor）、
 *   POSIX 下扩充 PATH
 *
 * 这里不直接 import fs/os 之外的运行时：探测所需的三种能力（读文件 / 判存在 /
 * 取环境变量）都通过 `ShellDetectIo` 注入，单测可以完全脱离真实系统。
 */

import { basename } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { userInfo } from 'node:os'

/** 本地终端明确支持的 shell 名 */
export const SUPPORTED_SHELLS = [
  'bash',
  'zsh',
  'fish',
  'sh',
  'dash',
  'ash',
  'ksh',
  'pwsh',
  'powershell',
] as const

/** 查找 shell 的目录顺序（与规格一致） */
export const SHELL_SEARCH_DIRS = ['/bin', '/usr/bin', '/usr/local/bin', '/opt/homebrew/bin'] as const

/** POSIX 下 PATH 需要补齐的目录（GUI 启动时 PATH 常常很贫瘠） */
export const PATH_EXTRA_DIRS = [
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '/usr/bin',
  '/bin',
  '/usr/sbin',
  '/sbin',
] as const

export const SHELLS_FILE = '/etc/shells'
export const DEFAULT_TERM = 'xterm-256color'
export const DEFAULT_COLORTERM = 'truecolor'

/** `/etc/shells` 缺失或为空时的兜底探测路径 */
export const COMMON_SHELL_PATHS = [
  '/bin/sh',
  '/bin/bash',
  '/bin/dash',
  '/bin/ash',
  '/bin/ksh',
  '/bin/zsh',
  '/bin/fish',
  '/usr/bin/sh',
  '/usr/bin/bash',
  '/usr/bin/dash',
  '/usr/bin/zsh',
  '/usr/bin/fish',
  '/usr/bin/ksh',
  '/usr/local/bin/bash',
  '/usr/local/bin/zsh',
  '/usr/local/bin/fish',
  '/opt/homebrew/bin/bash',
  '/opt/homebrew/bin/zsh',
  '/opt/homebrew/bin/fish',
] as const

export interface ShellInfo {
  path: string
  /** 文件名，如 bash / zsh */
  name: string
  /** 是否在本地终端明确支持的列表内 */
  supported: boolean
}

/** 探测所需的系统能力（可注入，便于单测） */
export interface ShellDetectIo {
  platform: NodeJS.Platform
  /** 读文本文件；不存在或不可读返回 null */
  readFile(path: string): string | null
  /** 路径是否存在（可执行文件判断） */
  exists(path: string): boolean
  env(name: string): string | undefined
  /** os.userInfo().shell（可能取不到） */
  userShell?: string
}

const SUPPORTED_ORDER: readonly string[] = SUPPORTED_SHELLS

function isSupportedShell(name: string): boolean {
  return SUPPORTED_ORDER.includes(name)
}

/** 显示名（仅用于 UI，避免出现 bash 这种裸标识） */
function displayName(name: string): string {
  switch (name) {
    case 'bash':
      return 'Bash'
    case 'zsh':
      return 'Zsh'
    case 'fish':
      return 'Fish'
    case 'dash':
      return 'Dash'
    case 'ash':
      return 'Ash'
    case 'ksh':
      return 'Ksh'
    case 'pwsh':
      return 'PowerShell'
    case 'powershell':
      return 'Windows PowerShell'
    default:
      return name
  }
}

/**
 * 解析 `/etc/shells`：忽略注释/空行，只接受绝对路径，按路径去重。
 */
export function parseShellsFile(content: string): ShellInfo[] {
  const seen = new Set<string>()
  const out: ShellInfo[] = []
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line.length === 0 || line.startsWith('#')) continue
    // 行内可能有注释，取第一个空白分隔的 token
    const path = line.split(/\s+/)[0] ?? ''
    if (!path.startsWith('/')) continue
    if (seen.has(path)) continue
    seen.add(path)
    const name = basename(path)
    out.push({ path, name, supported: isSupportedShell(name) })
  }
  return out
}

/** 平台默认 shell（规格 §5.4） */
export function platformDefaultShell(io: Pick<ShellDetectIo, 'platform' | 'env'>): string {
  if (io.platform === 'win32') {
    return io.env('COMSPEC')?.trim() || 'powershell.exe'
  }
  const fromEnv = io.env('SHELL')?.trim()
  if (fromEnv) return fromEnv
  return io.platform === 'darwin' ? '/bin/zsh' : '/bin/sh'
}

/**
 * 探测可用 shell：`/etc/shells` 优先，再用常见路径兜底；
 * 只保留真实存在的文件，并按「支持列表顺序 → 路径」稳定排序，按名字去重
 * （/bin/bash 与 /usr/bin/bash 往往指向同一个文件，不该出现两遍）。
 */
export function detectShells(io: ShellDetectIo): ShellInfo[] {
  const candidates: ShellInfo[] = []

  const content = io.readFile(SHELLS_FILE)
  if (content) candidates.push(...parseShellsFile(content))

  for (const path of COMMON_SHELL_PATHS) {
    const name = basename(path)
    candidates.push({ path, name, supported: isSupportedShell(name) })
  }

  const byName = new Map<string, ShellInfo>()
  for (const candidate of candidates) {
    if (!io.exists(candidate.path)) continue
    const existing = byName.get(candidate.name)
    if (existing) continue
    byName.set(candidate.name, candidate)
  }

  return [...byName.values()].sort((a, b) => {
    const ai = SUPPORTED_ORDER.indexOf(a.name)
    const bi = SUPPORTED_ORDER.indexOf(b.name)
    const ar = ai < 0 ? Number.MAX_SAFE_INTEGER : ai
    const br = bi < 0 ? Number.MAX_SAFE_INTEGER : bi
    if (ar !== br) return ar - br
    return a.path.localeCompare(b.path)
  })
}

/**
 * 把用户给的 shell（可能是空、别名或绝对路径）解析成可 spawn 的路径。
 * 解析不出来时**原样返回**，让 spawn 抛出明确错误，而不是悄悄换一个 shell。
 */
export function resolveShell(
  requested: string | undefined,
  io: ShellDetectIo,
  shells: readonly ShellInfo[] = detectShells(io),
): string {
  const req = requested?.trim() ?? ''
  if (req.length === 0) return platformDefaultShell(io)
  if (io.platform === 'win32') return req
  if (req.startsWith('/')) return req

  // 与当前用户登录 shell 同名 → 直接用登录 shell 的完整路径
  const userShell = io.userShell?.trim()
  if (userShell) {
    if (basename(userShell) === req) return userShell
  }

  // 已探测到的同名 shell
  const known = shells.find((s) => s.name === req)
  if (known) return known.path

  // 再按查找目录序找
  for (const dir of SHELL_SEARCH_DIRS) {
    const path = `${dir}/${req}`
    if (io.exists(path)) return path
  }
  return req
}

/**
 * 组装 PTY 环境变量。
 * - TERM：显式传入 > 继承的 TERM > xterm-256color
 * - COLORTERM：显式传入 > 继承的 COLORTERM > truecolor
 * - POSIX：补齐 PATH 里缺失的标准目录（只追加，不抢占已有顺序）
 */
export function buildShellEnv(
  base: Record<string, string | undefined>,
  options: { term?: string; colorTerm?: string } = {},
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(base)) {
    if (key.length === 0 || value === undefined) continue
    env[key] = value
  }

  env['TERM'] = options.term?.trim() || env['TERM']?.trim() || DEFAULT_TERM
  env['COLORTERM'] = options.colorTerm?.trim() || env['COLORTERM'] || DEFAULT_COLORTERM

  if (platform !== 'win32') {
    env['PATH'] = extendPosixPath(env['PATH'])
  }
  return env
}

function extendPosixPath(current: string | undefined): string {
  const parts = (current ?? '').split(':').filter((p) => p.length > 0)
  for (const dir of PATH_EXTRA_DIRS) {
    if (!parts.includes(dir)) parts.push(dir)
  }
  return parts.join(':')
}

/** 终端 profile：一套可直接 spawn 的 shell + 参数 + 环境覆盖 */
export interface PtyProfile {
  id: string
  name: string
  shell: string
  args: string[]
  env?: Record<string, string>
  cwd?: string
}

/**
 * 内置 profile：一个「默认」（平台默认 shell）+ 每个探测到的受支持 shell 各一个。
 */
export function defaultProfiles(
  shells: readonly ShellInfo[],
  io: Pick<ShellDetectIo, 'platform' | 'env'>,
): PtyProfile[] {
  const profiles: PtyProfile[] = [
    {
      id: 'default',
      name: '默认 Shell',
      shell: platformDefaultShell(io),
      args: [],
    },
  ]

  const seen = new Set<string>(['default'])
  for (const shell of shells) {
    if (!shell.supported) continue
    if (seen.has(shell.name)) continue
    seen.add(shell.name)
    profiles.push({
      id: shell.name,
      name: displayName(shell.name),
      shell: shell.path,
      args: [],
    })
  }
  return profiles
}

/** 进程内默认真实实现 */
export function nodeShellIo(): ShellDetectIo {
  let cachedUserShell: string | undefined
  let userShellRead = false

  return {
    platform: process.platform,
    readFile: (path) => {
      try {
        return readFileSync(path, 'utf8')
      } catch {
        return null
      }
    },
    exists: (path) => existsSync(path),
    env: (name) => process.env[name],
    get userShell() {
      if (!userShellRead) {
        userShellRead = true
        try {
          cachedUserShell = userInfo().shell ?? undefined
        } catch {
          cachedUserShell = undefined
        }
      }
      return cachedUserShell
    },
  }
}
