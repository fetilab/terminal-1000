// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

/**
 * `@t1000/shared` 是「源码即产物」的 workspace 包（main 指向 .ts），
 * 不能外置给 Node 运行时加载，必须打包进 bundle —— 故从 externalize 中排除。
 */
const SHARED = '@t1000/shared'
const externalize = () => externalizeDepsPlugin({ exclude: [SHARED] })

const sharedAlias = {
  [SHARED]: resolve(__dirname, '../../packages/shared/src/index.ts'),
  /**
   * kitty 内核以 vendor 形式随仓库走（`vendor/kitty-vt-wasm`）。
   *
   * 为什么不走 node_modules：pnpm 在这个环境里对 `@xterm/*` 之类的大包做 copyfile 会
   * EPERM（overlay fs + copy_file_range），装不上；vendor 目录同时解决了"打包后
   * 依赖树里找不到 wasm"的问题。
   */
  'kitty-vt-wasm': resolve(__dirname, 'vendor/kitty-vt-wasm/dist/index.js'),
}

export default defineConfig({
  main: {
    plugins: [externalize()],
    resolve: {
      alias: {
        ...sharedAlias,
        '@main': resolve(__dirname, 'src/main'),
      },
    },
    build: {
      // 不用 vite 的「先清空 outDir」：它会 rmSync 整个目录，沙箱的安全删除守卫会拦下
      // 批量删除（>50 个文件）。打包脚本改为「先 mv 到一边再构建」，同样干净且可回滚。
      emptyOutDir: false,
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/main/index.ts') },
      },
    },
  },
  preload: {
    plugins: [externalize()],
    resolve: {
      alias: sharedAlias,
    },
    build: {
      emptyOutDir: false,
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    plugins: [react()],
    resolve: {
      alias: {
        ...sharedAlias,
        '@renderer': resolve(__dirname, 'src/renderer/src'),
      },
    },
    build: {
      emptyOutDir: false,
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/renderer/index.html') },
      },
    },
  },
})
