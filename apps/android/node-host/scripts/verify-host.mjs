// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * node-host 端到端验收（无需 Android 设备）。
 *
 * 验证四件事，任一不通过都说明移植层有硬伤：
 *
 * 1. **主进程能在真 Node 上启动**（不是 Electron 的 Node，是系统 Node 22）；
 * 2. **IPC 域可用**：设置读写、kitty wasm 读取、连接列表、存储落库；
 * 3. **事件会推到前端**：改设置后前端能收到 SETTINGS_CHANGED（这是
 *    0.2.8 修的广播链路，Android 上必须同样成立）；
 * 4. **反向 RPC 通**：模拟 Kotlin 壳连 `/native`，验证剪贴板这类
 *    "只有原生侧能做"的能力真的能往返。
 *
 * 跑法：`node scripts/verify-host.mjs`
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { WebSocket } from 'ws'

const HERE = dirname(new URL(import.meta.url).pathname)
const ROOT = resolve(HERE, '..')
const WORK = '/home/mosfet/dsh1/_tools/t1000-verify'

const HOME_DIR = join(WORK, 'home')
const USERDATA = join(HOME_DIR, 'terminal-1000')
const TMP = join(WORK, 'tmp')
const RESOURCES = join(ROOT, '../app/src/main/assets/resources')
const TOKEN = 'verify-token-' + Math.random().toString(36).slice(2, 10)

const pass = []
const fail = []

function ok(msg) {
  pass.push(msg)
  console.log(`  ✓ ${msg}`)
}
function bad(msg) {
  fail.push(msg)
  console.log(`  ✗ ${msg}`)
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

/** 极简 IPC 客户端（与渲染层注入的 bridge.js 同协议） */
class IpcClient {
  constructor(port) {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/ipc?token=${encodeURIComponent(TOKEN)}`)
    this.nextId = 1
    this.pending = new Map()
    this.events = []
    this.ready = new Promise((res, rej) => {
      this.ws.on('open', res)
      this.ws.on('error', rej)
    })
    this.ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString())
      if (msg.type === 'response') {
        const p = this.pending.get(msg.id)
        if (p) {
          this.pending.delete(msg.id)
          p(msg.res)
        }
      } else if (msg.type === 'event') {
        this.events.push(msg)
      }
    })
  }

  invoke(domain, action, payload = {}) {
    const id = this.nextId++
    return new Promise((resolveP) => {
      this.pending.set(id, resolveP)
      this.ws.send(JSON.stringify({ type: 'invoke', id, req: { domain, action, payload } }))
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          resolveP({ ok: false, error: { code: 'TIMEOUT', message: 'test timeout' } })
        }
      }, 20000)
    })
  }

  close() {
    try {
      this.ws.close()
    } catch {
      /* 忽略 */
    }
  }
}

/**
 * 模拟 Kotlin 壳：连 `/native`，把收到的每个方法都"实现"掉并回包，
 * 同时记录下来 —— 这样既能验证通路，也能验证 Node 侧真的按协议发。
 */
class FakeNativeShell {
  constructor(port) {
    this.calls = []
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/native?token=${encodeURIComponent(TOKEN)}`)
    this.ready = new Promise((res, rej) => {
      this.ws.on('open', res)
      this.ws.on('error', rej)
    })
    this.ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString())
      if (typeof msg.id !== 'number') return
      this.calls.push({ method: msg.method, params: msg.params })
      const data = this.answer(msg.method, msg.params)
      this.ws.send(JSON.stringify({ id: msg.id, ok: true, data }))
    })
  }

  answer(method, params) {
    switch (method) {
      case 'clipboard.read':
        return { text: this.clipboardText ?? '' }
      case 'clipboard.write':
        this.clipboardText = params.text
        return { ok: true }
      case 'dialog.open':
        return { canceled: false, paths: ['/sdcard/Download/picked.txt'] }
      case 'dialog.message':
        return { response: 0 }
      case 'shell.openExternal':
        return { ok: true }
      case 'window.load':
        return { ok: true }
      default:
        return { ok: true }
    }
  }

  /** 上报屏幕尺寸（Node 侧窗口模拟要用） */
  reportScreen(screen) {
    this.ws.send(JSON.stringify({ type: 'screen', screen }))
  }

  close() {
    try {
      this.ws.close()
    } catch {
      /* 忽略 */
    }
  }
}

async function main() {
  console.log('=== node-host 端到端验收 ===\n')

  // 干净环境：残留的库会让"默认值"断言失真（旧配置里可能已落库别的值）
  if (existsSync(WORK)) rmSync(WORK, { recursive: true, force: true })
  for (const d of [HOME_DIR, TMP, USERDATA]) mkdirSync(d, { recursive: true })

  const env = {
    ...process.env,
    T1000_HOME: HOME_DIR,
    T1000_USERDATA: USERDATA,
    T1000_TEMP: TMP,
    T1000_RESOURCES: RESOURCES,
    T1000_TOKEN: TOKEN,
    T1000_PORT: '0',
    T1000_VERSION: '0.2.8',
    T1000_LOG_LEVEL: 'warn',
  }

  console.log('A 启动 node host')
  const child = spawn(process.execPath, [join(ROOT, 'dist/node-host.mjs')], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const logs = []
  child.stdout.on('data', (d) => logs.push(d.toString()))
  child.stderr.on('data', (d) => logs.push(d.toString()))

  let exited = false
  child.on('exit', (code) => {
    exited = true
    if (code !== 0 && code !== null) console.log(`  (进程退出 code=${code})`)
  })

  // 等 bridge.json（Kotlin 侧用同样的等待策略）
  const bridgeFile = join(HOME_DIR, 'bridge.json')
  const deadline = Date.now() + 30_000
  let bridge = null
  while (Date.now() < deadline) {
    if (existsSync(bridgeFile)) {
      try {
        bridge = JSON.parse(readFileSync(bridgeFile, 'utf8'))
        if (bridge.port) break
      } catch {
        /* 写了一半，稍后重试 */
      }
    }
    await sleep(150)
  }
  if (!bridge?.port) {
    bad('node host 未启动（30s 内没拿到 bridge.json）')
    console.log(logs.join(''))
    child.kill('SIGKILL')
    process.exit(1)
  }
  ok(`node host 已启动，桥端口 ${bridge.port}，pid ${bridge.pid}`)

  const shell = new FakeNativeShell(bridge.port)
  await shell.ready
  ok('模拟 Kotlin 壳已连上 /native')
  shell.reportScreen({ width: 1280, height: 800, density: 2 })
  await sleep(200)

  const ipc = new IpcClient(bridge.port)
  await ipc.ready
  ok('WebView 侧 IPC 客户端已连上 /ipc')

  /* ── B. 基础 IPC ── */
  console.log('\nB 基础 IPC 域')
  const info = await ipc.invoke('app', 'getInfo')
  if (info.ok && info.data?.platform === 'android') {
    ok(`app.getInfo：platform=android, node=${info.data.node}, 版本=${info.data.version}`)
  } else {
    // 本机验证跑在 linux 上，platform 必然是 linux —— 这里验的是"能响应"而非平台值
    if (info.ok) ok(`app.getInfo 响应正常（本机 platform=${info.data.platform}，安卓上为 android）`)
    else bad(`app.getInfo 失败：${JSON.stringify(info.error)}`)
  }

  const paths = await ipc.invoke('app', 'getPaths')
  if (paths.ok && paths.data?.userData === USERDATA) {
    ok(`app.getPaths：数据目录正确（${paths.data.userData}）`)
  } else {
    bad(`app.getPaths 数据目录不对：${JSON.stringify(paths.data ?? paths.error)}`)
  }

  const settings = await ipc.invoke('settings', 'getAll')
  if (settings.ok && settings.data?.ai?.assistantName) {
    ok(`settings.getAll：助手称呼「${settings.data.ai.assistantName}」`)
  } else {
    bad(`settings.getAll 失败或缺少 assistantName：${JSON.stringify(settings)}`)
  }

  /* ── C. 资源定位（kitty wasm 走 process.resourcesPath） ── */
  console.log('\nC 资源定位')
  const wasm = await ipc.invoke('app', 'kittyWasm')
  if (wasm.ok && wasm.data?.bytes > 300_000) {
    ok(`app.kittyWasm：读到 ${(wasm.data.bytes / 1024).toFixed(0)} KB（process.resourcesPath 生效）`)
  } else {
    bad(`app.kittyWasm 失败：${JSON.stringify(wasm.error ?? wasm.data)?.slice(0, 200)}`)
  }

  const scripts = await ipc.invoke('app', 'listBackgroundScripts')
  if (scripts.ok && Array.isArray(scripts.data?.scripts) && scripts.data.scripts.length > 0) {
    ok(`app.listBackgroundScripts：${scripts.data.scripts.join(', ')}`)
  } else {
    bad(`app.listBackgroundScripts 失败：${JSON.stringify(scripts.error ?? scripts.data)}`)
  }

  /* ── D. 设置写入 + 事件广播（0.2.8 的广播链路） ── */
  console.log('\nD 设置写入与事件广播')
  ipc.events.length = 0
  const setRes = await ipc.invoke('settings', 'set', { path: 'terminal.fontSize', value: 17 })
  if (setRes.ok) ok('settings.set 写入成功')
  else bad(`settings.set 失败：${JSON.stringify(setRes.error)}`)

  await sleep(400)
  const changed = ipc.events.find((e) => e.event === 'SETTINGS_CHANGED')
  if (changed) ok(`收到 SETTINGS_CHANGED 事件（path=${changed.payload?.path ?? '?'}）`)
  else bad(`没收到 SETTINGS_CHANGED，收到的事件：${ipc.events.map((e) => e.event).join(',') || '(无)'}`)

  const after = await ipc.invoke('settings', 'getAll')
  if (after.ok && after.data?.terminal?.fontSize === 17) ok('设置已持久化（重新读取得到 17）')
  else bad(`设置未持久化：${after.data?.terminal?.fontSize}`)
  if (after.ok && after.data?.terminal?.copyOnCtrlC === false) {
    ok('剪贴板键位默认值正确（Ctrl+C 不抢占）')
  } else {
    bad(`copyOnCtrlC 默认值异常：${after.data?.terminal?.copyOnCtrlC}`)
  }

  /* ── E. 存储域（better-sqlite3 在 Android 上是最难的一环） ── */
  console.log('\nE 存储域（SQLite）')
  const list = await ipc.invoke('store', 'listConnections')
  if (list.ok && Array.isArray(list.data)) {
    ok(`store.listConnections：${list.data.length} 条连接（库已建表）`)
  } else {
    bad(`store.listConnections 失败：${JSON.stringify(list.error)}`)
  }

  const saved = await ipc.invoke('store', 'saveConnection', {
    kind: 'telnet',
    id: 'verify-1',
    name: '验证用',
    host: '127.0.0.1',
    port: 23,
    username: 'root',
    password: 'pw-123',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  })
  if (saved.ok) ok('store.saveConnection：写入成功（含加密字段）')
  else bad(`store.saveConnection 失败：${JSON.stringify(saved.error)}`)

  const reread = await ipc.invoke('store', 'listConnections')
  if (reread.ok && reread.data?.some?.((c) => c.id === 'verify-1')) {
    ok('store.listConnections：读回了刚写入的连接')
  } else {
    bad('写入的连接没有读回')
  }

  /* ── F. 反向 RPC（交给 Kotlin 的原生能力） ── */
  console.log('\nF 原生能力反向 RPC')
  shell.calls.length = 0
  const clipWrite = await ipc.invoke('clipboard', 'write', { text: '从终端复制的内容' })
  if (clipWrite.ok) {
    const call = shell.calls.find((c) => c.method === 'clipboard.write')
    if (call && call.params.text === '从终端复制的内容') ok('clipboard.write 已转到原生（参数正确）')
    else bad(`原生没收到正确的剪贴板写入：${JSON.stringify(shell.calls)}`)
  } else {
    bad(`clipboard.write 失败：${JSON.stringify(clipWrite.error)}`)
  }

  const clipRead = await ipc.invoke('clipboard', 'read')
  if (clipRead.ok && clipRead.data?.text === '从终端复制的内容') {
    ok('clipboard.read 读回原生侧写入的内容（双向通）')
  } else {
    bad(`clipboard.read 读回失败：${JSON.stringify(clipRead.data ?? clipRead.error)}`)
  }

  /* ── G. 退出流程 ── */
  console.log('\nG 退出流程')
  const quit = await ipc.invoke('app', 'quit')
  if (quit.ok) ok('app.quit 已受理（走 before-quit 清理流程）')
  else bad(`app.quit 失败：${JSON.stringify(quit.error)}`)

  const exitDeadline = Date.now() + 8000
  while (Date.now() < exitDeadline && !exited) await sleep(200)
  if (exited) ok('进程已退出（清理流程跑完，未挂死）')
  else {
    bad('进程在 8s 内没有退出')
    child.kill('SIGKILL')
  }

  ipc.close()
  shell.close()

  /* ── 汇总 ── */
  console.log('\n=== 结果 ===')
  console.log(`通过 ${pass.length} 项，失败 ${fail.length} 项`)
  if (fail.length > 0) {
    console.log('\n失败项：')
    for (const f of fail) console.log(`  - ${f}`)
    console.log('\n--- host 日志 ---')
    console.log(logs.join('').slice(-3000))
    process.exit(1)
  }
  console.log('\n全部通过。node-host 在真 Node 上完整可用。')
  process.exit(0)
}

main().catch((err) => {
  console.error('验收脚本异常:', err)
  process.exit(1)
})
