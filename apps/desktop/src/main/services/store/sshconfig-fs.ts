// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * `ParseIo` 的真实文件系统实现。
 *
 * 单独成文件的原因：`sshconfig.ts` / `sshconfig-import.ts` / `sshconfig-service.ts`
 * 都是**纯逻辑**（不 import node:fs），这样才能在单测里注入内存实现；
 * 所有真实读盘行为集中在这里，一目了然、也便于审计权限处理。
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import type { ParseIo } from './sshconfig'

/** 展开开头的 `~`（只处理 `~` 与 `~/x`，不处理 `~user`） */
export function expandTilde(path: string, home: string): string {
  if (path === '~') return home
  if (path.startsWith('~/')) return join(home, path.slice(2))
  return path
}

/** 默认的 home 目录 */
export function defaultHome(): string {
  return homedir()
}

/** 默认的配置文件路径 */
export function defaultSshConfigPath(home = defaultHome()): string {
  return join(home, '.ssh', 'config')
}

/**
 * 有权限/IO 问题时返回 null 而不是抛错 —— 调用方据此把
 * 「私钥读不出来」降级为 warning（这是任务的明确要求）。
 */
function safeReadFile(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

function safeReadDir(path: string): string[] | null {
  try {
    return readdirSync(path)
  } catch {
    return null
  }
}

function safeIsDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/**
 * 把 glob 展开成文件列表。
 *
 * 只支持 `*` 与 `?`（OpenSSH 的 Include 就用这两种），
 * 逐段展开目录树中的一层，不做 `**` 递归。
 */
function globFiles(pattern: string): string[] {
  const segments = pattern.split('/').filter((s) => s !== '')
  const absolute = pattern.startsWith('/')
  let bases: string[] = absolute ? ['/'] : ['.']

  for (const segment of segments) {
    const next: string[] = []
    const hasMagic = /[*?]/.test(segment)

    for (const base of bases) {
      if (!hasMagic) {
        next.push(join(base, segment))
        continue
      }
      const entries = safeReadDir(base)
      if (entries === null) continue
      const re = globSegmentToRegExp(segment)
      for (const entry of entries) {
        if (entry.startsWith('.')) continue // glob 默认不匹配隐藏文件
        if (re.test(entry)) next.push(join(base, entry))
      }
    }
    bases = next
  }

  return bases.filter((p) => existsSync(p) && !safeIsDirectory(p))
}

/** 单段 glob → 正则（* 不跨 /，? 匹配单字符） */
function globSegmentToRegExp(segment: string): RegExp {
  let out = '^'
  for (const ch of segment) {
    if (ch === '*') out += '[^/]*'
    else if (ch === '?') out += '[^/]'
    else out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  out += '$'
  return new RegExp(out)
}

/** 构造真实的 ParseIo */
export function createParseIo(home = defaultHome()): ParseIo {
  return {
    readFile: (path) => {
      const resolved = expandTilde(path, home)
      return safeReadFile(resolved)
    },
    readDir: (path) => safeReadDir(expandTilde(path, home)),
    paths: {
      resolve: (path, base) => {
        const expanded = expandTilde(path, home)
        if (isAbsolute(expanded)) return resolve(expanded)
        return resolve(base, expanded)
      },
      dirname: (path) => dirname(path),
      isAbsolute: (path) => isAbsolute(expandTilde(path, home)),
      glob: (pattern) => globFiles(expandTilde(pattern, home)),
      isDirectory: (path) => safeIsDirectory(expandTilde(path, home)),
    },
    home,
  }
}
