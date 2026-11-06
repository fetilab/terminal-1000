// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 安装后自动把原生模块重建为 **Electron ABI**。
 *
 * 为什么必须自动化：`pnpm install` 会按**当前 Node 的 ABI** 重编原生模块，
 * 而 Electron 内嵌的是另一个 Node。ABI 不符时应用启动即 SIGSEGV 且**没有任何堆栈**，
 * 排查成本极高（本项目已因此浪费两轮）。
 *
 * 现状（Electron 45 / better-sqlite3 13）：
 * - better-sqlite3 13 是 **N-API**，同一份二进制在 Node 与 Electron 下都能用，
 *   所以它不需要重建 —— 这一点很重要，否则 vitest（跑在 Node 下）会挂。
 * - node-pty **不是** N-API，必须按 Electron ABI 重建。
 * - cpu-features 是 ssh2 的可选加速模块，同样需要重建。
 *
 * 本脚本只重建需要重建的模块，并在失败时**不让 install 整体失败**
 * （离线/无头环境下仍可开发，只是运行 app 前需手动执行 `pnpm run rebuild:native`）。
 */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'

/** 只重建非 N-API 的模块；better-sqlite3 走 N-API 预编译，重建反而会破坏 vitest */
const MODULES_TO_REBUILD = ['node-pty', 'cpu-features']

const isCI = process.env.CI === 'true'
const skip = process.env.T1000_SKIP_NATIVE_REBUILD === '1'

if (skip) {
  console.log('[rebuild-native] T1000_SKIP_NATIVE_REBUILD=1，跳过')
  process.exit(0)
}

// electron-builder 在 .bin 下；未安装（如只装 production 依赖）则跳过
const eb = 'electron-builder'
const hasElectronBuilder = existsSync(new URL('../node_modules/.bin/electron-builder', import.meta.url))

if (!hasElectronBuilder) {
  console.log('[rebuild-native] 未找到 electron-builder，跳过重建')
  process.exit(0)
}

console.log(`[rebuild-native] 为 Electron ABI 重建: ${MODULES_TO_REBUILD.join(', ')}`)

const result = spawnSync(eb, ['install-app-deps'], {
  stdio: 'inherit',
  cwd: new URL('..', import.meta.url).pathname,
  env: {
    ...process.env,
    // 国内网络下 electronjs.org 常常超时；不设镜像会导致重建失败
    ELECTRON_MIRROR: process.env.ELECTRON_MIRROR ?? 'https://npmmirror.com/mirrors/electron/',
    ELECTRON_BUILDER_BINARIES_MIRROR:
      process.env.ELECTRON_BUILDER_BINARIES_MIRROR ?? 'https://npmmirror.com/mirrors/electron-builder-binaries/',
  },
})

if (result.status !== 0) {
  const hint = '原生模块重建失败。运行 app 前请手动执行: pnpm --filter @t1000/desktop run rebuild:native'
  if (isCI) {
    console.error(`[rebuild-native] ${hint}`)
    process.exit(1) // CI 上必须失败，避免产出坏包
  }
  console.warn(`[rebuild-native] ${hint}`)
  // 本地开发不阻断 install
  process.exit(0)
}

console.log('[rebuild-native] 完成')
