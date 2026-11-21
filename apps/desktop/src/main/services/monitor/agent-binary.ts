// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 内嵌的监控代理二进制（多架构）。
 *
 * 打包后位于 `resources/agent/`，开发态位于 `apps/desktop/build/agent/`。
 * 每份都是 `gzip -9` 过的单个静态可执行文件 —— 上传前在本地解压（Node 的 zlib），
 * 服务器上**不需要** gunzip，也不需要 python、Go、glibc。
 *
 * 架构选择靠远端 `uname -m`：x86_64 → amd64、aarch64 → arm64、armv7l → arm。
 * 认不出的架构返回 null，调用方据此回退到脚本模式并如实告诉用户。
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { gunzipSync } from 'node:zlib'

export type AgentArch = 'amd64' | 'arm64' | 'arm'

/** 内置了哪些架构（与 agent/build.sh 的默认目标一致） */
export const AGENT_ARCHES: readonly AgentArch[] = ['amd64', 'arm64', 'arm']

/** 远端 `uname -m` → 内置产物名；不支持则 null */
export function resolveArch(unameMachine: string | null | undefined): AgentArch | null {
  const raw = (unameMachine ?? '').trim().toLowerCase()
  if (raw === 'x86_64' || raw === 'amd64') return 'amd64'
  if (raw === 'aarch64' || raw === 'arm64') return 'arm64'
  // armv7l / armv6l / armhf / armv8l（32 位用户态）都跑 GOARM=7 的产物
  if (raw === 'armv7l' || raw === 'armv7' || raw === 'armv6l' || raw === 'armv8l' || raw === 'armhf' || raw === 'arm') {
    return 'arm'
  }
  return null
}

/**
 * 产物所在目录。
 *
 * 刻意**不 import electron 的 app**：这个模块要在纯 Node 的单测里跑，
 * 那时 `app` 是 undefined，整个安装路径就没法测了。
 * 改成「打包目录里真有 agent/ 就用它，否则用仓库里的 build/agent」——
 * 打包态 resources/agent 一定存在，开发态与测试态都落到 build/agent。
 */
export function agentAssetDir(): string {
  // 打包态：resources/agent
  const packaged = process.resourcesPath ? join(process.resourcesPath, 'agent') : ''
  if (packaged && existsSync(packaged)) return packaged

  // 开发/测试态：从几个可能的起点向上找 `build/agent`。
  // 不写死层数 —— 同一份代码在 electron 产物（out/main）、vitest（src 深处）、
  // 以及 cwd 三种起点下的相对深度都不一样。
  const starts = [process.cwd(), typeof __dirname === 'string' ? __dirname : '']
  for (const start of starts) {
    if (!start) continue
    let dir = resolve(start)
    for (let i = 0; i < 6; i++) {
      const candidate = join(dir, 'build', 'agent')
      if (existsSync(candidate)) return candidate
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  }
  return join(process.cwd(), 'build', 'agent')
}

export function agentAssetPath(arch: AgentArch): string {
  return join(agentAssetDir(), `t1000-agent-linux-${arch}.gz`)
}

/** 该架构的产物是否随包提供 */
export function hasAgentBinary(arch: AgentArch): boolean {
  return existsSync(agentAssetPath(arch))
}

/**
 * 读出解压后的二进制。
 *
 * 解压放本地做：远端只收到最终的可执行文件，少一个 `gunzip` 依赖
 * （busybox 有，但没必要赌）。
 */
export function readAgentBinary(arch: AgentArch): Buffer {
  const path = agentAssetPath(arch)
  if (!existsSync(path)) {
    throw new Error(`安装包内缺少 ${arch} 架构的监控代理（${path}），请重新打包`)
  }
  return gunzipSync(readFileSync(path))
}
