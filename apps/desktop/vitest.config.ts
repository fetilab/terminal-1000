// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * vitest 配置。
 *
 * 只跑 **main 进程里不依赖 Electron 的纯逻辑**（store 域是第一个）。
 * 需要 Electron 运行时的模块（paths / logger / window）不在测试范围内：
 * 它们要么在 node 下 import 就炸，要么测了也没有意义。
 *
 * 环境用 node：better-sqlite3 是原生模块，必须跑在 node 环境而不是 jsdom。
 */

import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      // 与 tsconfig.node.json 的 paths 保持一致
      '@t1000/shared': `${here}../../packages/shared/src/index.ts`,
      '@main': `${here}src/main`,
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // 单测全部用 :memory: 或 os.tmpdir()，不碰真实用户目录
    testTimeout: 20_000,
    hookTimeout: 20_000,
    // 原生模块在同一进程里更稳；并行 worker 反而容易被 sqlite 文件锁干扰
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
})
