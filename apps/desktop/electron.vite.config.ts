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
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/renderer/index.html') },
      },
    },
  },
})
