// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * Android node host 入口。
 *
 * 顺序是刻意编排的，每一步都有依赖：
 *
 * 1. **伪造 Electron 专属的全局量**（`process.resourcesPath`、`process.versions.electron`）。
 *    主进程会在模块顶层读它们，晚一步就会读到 undefined 并走错分支。
 * 2. **起回环桥**，拿到端口后立刻落盘 + 打印，让 Kotlin 能连上来。
 * 3. **才 import 主进程**。`main/index.ts` 的顶层代码会初始化数据目录、
 *    注入 store 单例、注册单实例锁 —— 这些必须在桥就绪后进行，
 *    否则 WebView 可能在处理器注册之前就发请求（虽然桥里会等，但顺序清楚更可靠）。
 * 4. **最后 markReady()** 放行 `app.whenReady()`，主进程开始 bootstrap、建窗口。
 *
 * 第 2 步与第 4 步之间那段"主进程 import"是同步执行的，所以 WebView 真正拿到
 * 响应之前，IPC 处理器一定已经注册完毕。
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { APP_VERSION, HOME_DIR, NATIVE_LIB_DIR, RESOURCES_DIR, TEST_HOOK, USER_DATA_DIR } from './env'

/* ── 1. 伪造 Electron 的全局量 ───────────────────────── */

/** 主进程用它定位 kitty-vt.wasm 与内置背景脚本 */
Object.defineProperty(process, 'resourcesPath', {
  value: RESOURCES_DIR,
  writable: false,
  configurable: true,
  enumerable: true,
})

/** `app.getInfo()` 会把它报给渲染层；给一个能自证来源的值而不是 undefined */
try {
  Object.defineProperty(process.versions, 'electron', {
    value: `android-shim/${APP_VERSION}`,
    writable: false,
    configurable: true,
    enumerable: true,
  })
} catch {
  /* 某些运行时禁止改写 versions，忽略即可（只是诊断信息） */
}

/** 临时目录：Android 的默认 /tmp 不存在，必须指向应用私有目录 */
const tmpDir = process.env['T1000_TEMP'] ?? join(HOME_DIR, 'tmp')
try {
  mkdirSync(tmpDir, { recursive: true })
} catch {
  /* 已存在 */
}
process.env['TMPDIR'] = tmpDir
process.env['TMP'] = tmpDir
process.env['TEMP'] = tmpDir

/** 让主进程里 `process.argv.includes('--t1000-testhook')` 的判断生效 */
if (TEST_HOOK) process.argv.push('--t1000-testhook')

/** 部分逻辑（shells/pty）按 TERM 决定颜色能力；Android 终端同样要 256 色 */
process.env['TERM'] = process.env['TERM'] ?? 'xterm-256color'

/* ── 2. 起桥 ─────────────────────────────────────────── */

const { startBridge } = await import('./bridge/server')
const { app } = await import('./shim/app')

const port = await startBridge()

/**
 * 把端口交给 Kotlin。
 *
 * 双通道交付（文件 + stdout）：
 * - **文件**是主要途径：Kotlin 轮询等待它出现，不依赖子进程输出缓冲，
 *   也不怕日志里混进别的内容；
 * - **stdout 标记行**是给人看的（`adb logcat` 里能直接看到端口），
 *   同时充当日志与状态的锚点。
 */
try {
  mkdirSync(USER_DATA_DIR, { recursive: true })
  writeFileSync(
    join(HOME_DIR, 'bridge.json'),
    JSON.stringify(
      {
        port,
        token: process.env['T1000_TOKEN'],
        pid: process.pid,
        version: APP_VERSION,
        startedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
    { mode: 0o600 },
  )
} catch (err) {
  console.error('[entry] 写入 bridge.json 失败（Kotlin 将无法连接）:', err)
}

// 这一行是 Kotlin 侧解析的锚点，格式不要随意改动
console.log(`T1000_BRIDGE_READY ${JSON.stringify({ port, pid: process.pid, version: APP_VERSION })}`)

console.log(
  `[entry] node ${process.versions.node} ${process.platform}/${process.arch} | ` +
    `home=${HOME_DIR} | resources=${RESOURCES_DIR} | nativeLib=${NATIVE_LIB_DIR || '(未设置)'}`,
)

/* ── 3. 载入主进程 ───────────────────────────────────── */

try {
  await import('../../../desktop/src/main/index')
  console.log('[entry] 主进程模块已载入')
} catch (err) {
  console.error('[entry] 主进程载入失败:', err)
  // 主进程起不来时保留桥在线：Kotlin 侧能通过 /native 拿到错误并显示给用户，
  // 而不是看到一个白屏加一条"进程已退出"
  process.exitCode = 1
  throw err
}

/* ── 4. 放行 bootstrap ──────────────────────────────── */

app.markReady()

// 未捕获异常不要静默吞掉（主进程自己也挂了处理器，这里兜住载入阶段的）
process.on('uncaughtException', (err) => {
  console.error('[entry] uncaughtException', err)
})
process.on('unhandledRejection', (reason) => {
  console.error('[entry] unhandledRejection', reason)
})

// 退出前尽力关掉监听端口（清理钩子由主进程的 before-quit 负责业务侧）
process.on('SIGTERM', () => {
  console.log('[entry] 收到 SIGTERM')
  app.quit()
})
process.on('SIGINT', () => {
  app.quit()
})
