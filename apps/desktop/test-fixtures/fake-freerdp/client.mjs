// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 假 FreeRDP 客户端夹具（**仅测试使用；产品代码不得依赖**）。
 *
 * 由 `bin/xfreerdp` / `wl-bin/wlfreerdp` 两个可执行外壳转发进来（测试时把对应目录
 * 注入 PATH，`findRdpBinary` 就会选中它）。它**从不联网**，只做两件事：
 *
 * 1. 把本次调用原样记录成一行 JSON 追加到 `T1000_FAKE_RDP_RECORD`：
 *    `invokedAs` / `argv` / `pid` / `cwd` / `display`。
 *    这样"参数映射"可以被断言在**真实进程边界**上，而不是只断言纯函数返回值。
 * 2. 按 `T1000_FAKE_RDP_MODE` 模拟生命周期：
 *    - `resident`（缺省 `exit`）：驻留，直到被杀或超过 `T1000_FAKE_RDP_MAX_MS`
 *    - `exit`：写完记录后按 `T1000_FAKE_RDP_CODE`（缺省 0）退出，可加 `T1000_FAKE_RDP_DELAY_MS`
 *    - `quick-exit`：立即按 `T1000_FAKE_RDP_CODE`（缺省 255）退出（"秒退"路径）
 *    `T1000_FAKE_RDP_STDERR` 会写到 stderr，用于验证失败原因被带进状态消息。
 */

import { appendFileSync, mkdirSync } from 'node:fs'
import { basename, dirname } from 'node:path'

// 外壳名由 shim 经环境变量带入：exec node 之后 argv[1] 会变成 client.mjs
const invokedAs = process.env.T1000_FAKE_RDP_INVOKED_AS ?? basename(process.argv[1] ?? '')
const argv = process.argv.slice(2)

const recordPath = process.env.T1000_FAKE_RDP_RECORD
if (recordPath !== undefined && recordPath !== '') {
  mkdirSync(dirname(recordPath), { recursive: true })
  appendFileSync(
    recordPath,
    `${JSON.stringify({
      invokedAs,
      argv,
      pid: process.pid,
      cwd: process.cwd(),
      display: process.env.DISPLAY ?? null,
    })}\n`,
  )
}

const stderrText = process.env.T1000_FAKE_RDP_STDERR
if (stderrText !== undefined && stderrText !== '') {
  process.stderr.write(stderrText.endsWith('\n') ? stderrText : `${stderrText}\n`)
}

const mode = process.env.T1000_FAKE_RDP_MODE ?? 'exit'
const rawCode = process.env.T1000_FAKE_RDP_CODE ?? (mode === 'quick-exit' ? '255' : '0')
const code = Number.parseInt(rawCode, 10)

if (mode === 'resident') {
  const maxMs = Number.parseInt(process.env.T1000_FAKE_RDP_MAX_MS ?? '30000', 10)
  // 兜底自杀，避免测试异常时留下孤儿进程
  const keeper = setInterval(() => {}, 1000)
  setTimeout(() => {
    clearInterval(keeper)
    process.exit(0)
  }, Number.isFinite(maxMs) ? maxMs : 30000).unref()
} else if (mode === 'quick-exit') {
  process.exit(Number.isFinite(code) ? code : 255)
} else {
  const delay = Number.parseInt(process.env.T1000_FAKE_RDP_DELAY_MS ?? '0', 10)
  const exitCode = Number.isFinite(code) ? code : 0
  if (Number.isFinite(delay) && delay > 0) setTimeout(() => process.exit(exitCode), delay)
  else process.exit(exitCode)
}
