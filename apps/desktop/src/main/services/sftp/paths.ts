// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 远端路径规范化与安全校验。
 *
 * 远端路径是 **POSIX 语义**（SFTP 协议如此），因此这里不使用 node:path：
 * `path.win32` / 平台相关的分隔符会让行为随宿主变化，安全边界不能依赖宿主。
 *
 * 核心规则：
 * - 结果永远是绝对路径，且不含尾随斜杠（根除外）。
 * - `.` 段被丢弃；`..` 段先规约，**一旦越过根目录立即拒绝**（路径穿越）。
 * - 相对路径按 `base`（默认根）解析，便于把 UI 传来的相对名字挂到会话 home 下。
 *
 * 为什么"规约内部 `..`"而不是"见到 `..` 就拒绝"：
 * 规约是用户直觉（`/a/b/../c` == `/a/c`），也不会产生绕过；
 * 真正的危险只有"逃出根"，那一种情况我们拒绝。两者兼顾。
 */

import { AppError } from '../../errors'

/** NUL 会截断底层 C 字符串，必须显式拒绝 */
const NUL = '\0'

function reject(message: string, detail?: unknown): never {
  throw AppError.badRequest(message, detail)
}

/**
 * 把远端路径规范化成安全的绝对 POSIX 路径。
 *
 * @throws AppError('BAD_REQUEST') 路径为空 / 含 NUL / 试图逃出根目录
 */
export function normalizeRemotePath(input: string, base = '/'): string {
  if (typeof input !== 'string') reject('远端路径必须是字符串')
  if (input.length === 0) reject('远端路径不能为空')
  if (input.includes(NUL)) reject('远端路径包含非法字符 NUL')

  const absolute = input.startsWith('/')
  const rawSegments = absolute ? input.split('/') : joinSegments(base, input).split('/')

  const out: string[] = []
  for (const seg of rawSegments) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      if (out.length === 0) {
        reject(`远端路径越界（试图逃出根目录）: ${input}`)
      }
      out.pop()
      continue
    }
    out.push(seg)
  }

  return out.length === 0 ? '/' : `/${out.join('/')}`
}

/** 拼接若干路径段（各段可以是相对/绝对），再整体规范化 */
export function joinRemotePath(...parts: string[]): string {
  if (parts.length === 0) return '/'
  return normalizeRemotePath(joinSegments(...parts))
}

function joinSegments(...parts: string[]): string {
  return parts
    .filter((p) => p !== '')
    .map((p, i) => (i === 0 ? p : p.replace(/^\/+/, '')))
    .join('/')
}

/** 去掉最后一段，返回父目录（根目录的父目录仍是根） */
export function dirnameRemotePath(input: string): string {
  const p = normalizeRemotePath(input)
  if (p === '/') return '/'
  const idx = p.lastIndexOf('/')
  return idx <= 0 ? '/' : p.slice(0, idx)
}

/** 取最后一段；根目录返回 '/' */
export function basenameRemotePath(input: string): string {
  const p = normalizeRemotePath(input)
  if (p === '/') return '/'
  return p.slice(p.lastIndexOf('/') + 1)
}

/** child 是否等于 parent 或位于 parent 之下（两者都会先规范化） */
export function isInsideRemotePath(parent: string, child: string): boolean {
  const p = normalizeRemotePath(parent)
  const c = normalizeRemotePath(child)
  if (p === '/') return true
  return c === p || c.startsWith(`${p}/`)
}

/**
 * 校验单个路径段（新建目录 / 重命名目标的名字，不是完整路径）。
 * 名字里带 `/` 意味着调用方把路径当名字传了，必须拒绝而不是静默拼接。
 */
export function assertSafeRemoteName(name: string): string {
  if (typeof name !== 'string') reject('远端名称必须是字符串')
  if (name.length === 0) reject('远端名称不能为空')
  if (name === '.' || name === '..') reject(`远端名称不合法: ${name}`)
  if (name.includes('/')) reject(`远端名称不能包含 '/' : ${name}`)
  if (name.includes(NUL)) reject('远端名称包含非法字符 NUL')
  return name
}

/**
 * 冲突时生成 `name (n).ext` 形式的新名字。
 * 点开头且无其它点视为无扩展名（`.bashrc` → `.bashrc (1)`）；
 * 最后一个点前面没有内容也视为无扩展名（`noext` / `a.` 边界）。
 */
export function numberedName(name: string, n: number): string {
  assertSafeRemoteName(name)
  const dot = name.lastIndexOf('.')
  const hasExt = dot > 0 && dot < name.length - 1
  if (!hasExt) return `${name} (${n})`
  return `${name.slice(0, dot)} (${n})${name.slice(dot)}`
}

/**
 * 在"已存在"的名字里挑一个可用的编号名。
 * @param exists 判断某个名字是否已被占用
 */
export function nextAvailableName(
  name: string,
  exists: (candidate: string) => boolean,
  limit = 10_000,
): string {
  for (let i = 1; i <= limit; i++) {
    const candidate = numberedName(name, i)
    if (!exists(candidate)) return candidate
  }
  throw AppError.conflict(`无法为 ${name} 找到可用的重命名（已尝试 ${limit} 次）`)
}

/** 把 `755` / `0o755` / `0755` 这类输入归一化成 chmod 用的数字；非法则抛错 */
export function parseMode(input: number | string): number {
  if (typeof input === 'number') {
    if (!Number.isInteger(input) || input < 0 || input > 0o7777) {
      reject(`权限值不合法: ${input}`)
    }
    return input
  }
  if (typeof input !== 'string' || input.trim() === '') reject('权限值不能为空')
  const text = input.trim()
  // 以 0 开头按八进制理解（0755 / 0o755），否则也按八进制（755 表示 rwxr-xr-x）
  const normalized = text.startsWith('0o') || text.startsWith('0O') ? text.slice(2) : text
  if (!/^[0-7]{3,4}$/.test(normalized)) reject(`权限值不合法: ${input}`)
  return parseInt(normalized, 8)
}

/** 权限位 → `rwxr-xr-x` 形式（列表展示用） */
export function formatPermissions(mode: number): string {
  const bits = mode & 0o777
  const chars = ['---', '--x', '-w-', '-wx', 'r--', 'r-x', 'rw-', 'rwx']
  return [6, 3, 0].map((shift) => chars[(bits >> shift) & 0o7] ?? '---').join('')
}
