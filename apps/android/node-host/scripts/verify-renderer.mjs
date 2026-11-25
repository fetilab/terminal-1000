// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 渲染层端到端验收：**真实界面 + 真实 bridge.js + 真实 node-host**。
 *
 * 为什么不能只验 node-host 就收工：
 * 主进程能响应 IPC，不代表渲染层能在"没有 preload"的环境里跑起来 ——
 * 渲染层依赖 `window.t1000` 的**同步可得性**（`platform` 在首屏渲染前就要读到）、
 * 事件订阅的时机、以及 CSP 是否允许连 `ws://127.0.0.1`。
 *
 * 这里的做法与 Android 上完全一致：
 * - 用 HTTP 提供渲染层产物（对应 WebViewAssetLoader 的 https 伪源）；
 * - 在页面**任何脚本之前**注入 bridge.js（对应 addDocumentStartJavaScript）；
 * - 把 CSP 的 `connect-src` 放宽到回环 WS（Android 构建同样要做，见 build.mjs）。
 *
 * 用 Electron 只当"一个能跑 WebGL 的 Chromium"，不加载任何 Electron 主进程代码。
 */

import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { extname, join, resolve, dirname } from 'node:path'
import { WebSocket } from 'ws'

const HERE = dirname(new URL(import.meta.url).pathname)
const ROOT = resolve(HERE, '..')
const REPO = resolve(ROOT, '../../..')
const WORK = '/home/mosfet/dsh1/_tools/t1000-renderer'
const RENDERER = join(REPO, 'apps/desktop/out/renderer')
const ELECTRON = join(REPO, 'apps/desktop/node_modules/electron/dist/electron')
const SHOTS = '/home/mosfet/dsh1/_shots'
const TOKEN = 'renderer-token-' + Math.random().toString(36).slice(2, 10)

const pass = []
const fail = []
const ok = (m) => {
  pass.push(m)
  console.log(`  ✓ ${m}`)
}
const bad = (m) => {
  fail.push(m)
  console.log(`  ✗ ${m}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.ico': 'image/x-icon',
  '.map': 'application/json',
}

async function main() {
  console.log('=== 渲染层端到端验收 ===\n')

  if (!existsSync(join(RENDERER, 'index.html'))) {
    console.error('渲染层产物不存在，请先在 apps/desktop 跑 pnpm build')
    process.exit(1)
  }
  if (existsSync(WORK)) rmSync(WORK, { recursive: true, force: true })
  mkdirSync(WORK, { recursive: true })
  mkdirSync(SHOTS, { recursive: true })

  /* ── 1. node host ── */
  console.log('A 启动 node host')
  const home = join(WORK, 'home')
  const env = {
    ...process.env,
    T1000_HOME: home,
    T1000_USERDATA: join(home, 'terminal-1000'),
    T1000_TEMP: join(WORK, 'tmp'),
    T1000_RESOURCES: join(ROOT, '../app/src/main/assets/resources'),
    T1000_TOKEN: TOKEN,
    T1000_PORT: '0',
    T1000_VERSION: '0.2.8',
    T1000_LOG_LEVEL: 'warn',
  }
  mkdirSync(env.T1000_TEMP, { recursive: true })

  const host = spawn(process.execPath, [join(ROOT, 'dist/node-host.mjs')], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const hostLogs = []
  host.stdout.on('data', (d) => hostLogs.push(d.toString()))
  host.stderr.on('data', (d) => hostLogs.push(d.toString()))

  const bridgeFile = join(home, 'bridge.json')
  let bridge = null
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (existsSync(bridgeFile)) {
      try {
        bridge = JSON.parse(readFileSync(bridgeFile, 'utf8'))
        if (bridge.port) break
      } catch {
        /* 半写状态 */
      }
    }
    await sleep(150)
  }
  if (!bridge?.port) {
    bad('node host 未启动')
    console.log(hostLogs.join(''))
    host.kill('SIGKILL')
    process.exit(1)
  }
  ok(`node host 就绪（端口 ${bridge.port}）`)

  /* ── 2. 静态服务器（扮演 WebViewAssetLoader） ── */
  const bridgeJs = readFileSync(join(ROOT, '../app/src/main/assets/inject/bridge.js'), 'utf8')

  const server = createServer((req, res) => {
    const url = (req.url ?? '/').split('?')[0]

    // 桥脚本：把配置拼在前面（与 Kotlin 侧 addDocumentStartJavaScript 完全一致的做法）
    if (url === '/__t1000_bridge.js') {
      res.writeHead(200, { 'Content-Type': MIME['.js'] })
      const config = `window.__T1000_CONFIG__ = ${JSON.stringify({
        port: bridge.port,
        token: TOKEN,
        testHook: false,
      })};\n`
      res.end(config + bridgeJs)
      return
    }

    let file = url === '/' ? '/index.html' : url
    const full = join(RENDERER, file)
    if (!existsSync(full)) {
      res.writeHead(404).end('not found')
      return
    }

    if (file.endsWith('index.html')) {
      let html = readFileSync(full, 'utf8')
      // 放宽 CSP：允许连回环 WS（Android 构建时由 build.mjs 做同样的替换）
      html = html.replace(
        /content="default-src[^"]*"/,
        'content="default-src \'self\'; script-src \'self\' blob:; worker-src \'self\' blob:; style-src \'self\' \'unsafe-inline\'; img-src \'self\' data: blob:; font-src \'self\' data:; connect-src \'self\' ws://127.0.0.1:* http://127.0.0.1:*"',
      )
      // 桥必须在业务脚本之前执行
      html = html.replace('<head>', '<head>\n    <script src="/__t1000_bridge.js"></script>')
      res.writeHead(200, { 'Content-Type': MIME['.html'] })
      res.end(html)
      return
    }

    res.writeHead(200, { 'Content-Type': MIME[extname(full)] ?? 'application/octet-stream' })
    res.end(readFileSync(full))
  })

  const httpPort = await new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)))
  ok(`静态服务器就绪（端口 ${httpPort}，扮演 WebViewAssetLoader）`)

  /* ── 3. Chromium（Electron 只作浏览器用） ── */
  console.log('\nB 用真实 Chromium 加载界面')
  const electronMain = join(WORK, 'browser.cjs')
  writeFileSync(
    electronMain,
    `
const { app, BrowserWindow } = require('electron')
const fs = require('fs')
app.commandLine.appendSwitch('remote-debugging-port', '9333')
app.commandLine.appendSwitch('enable-unsafe-swiftshader')
app.disableHardwareAcceleration()
app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 1280, height: 800,
    // 必须 show:true：隐藏窗口在 Xvfb 下完成不了首次合成，
    // capturePage 会拿到空图（之前踩过）
    show: true,
    webPreferences: { offscreen: false, contextIsolation: true, nodeIntegration: false },
  })
  win.loadURL(process.env.T1000_PAGE_URL)
  setTimeout(async () => {
    try {
      const img = await win.webContents.capturePage()
      fs.writeFileSync(process.env.T1000_SHOT, img.toPNG())
      console.log('SHOT_OK')
    } catch (e) {
      console.error('SHOT_FAIL', e && e.message)
    }
    setTimeout(() => app.exit(0), 300)
  }, Number(process.env.T1000_SHOT_DELAY || '9000'))
})
`,
  )

  const xvfb = spawn('Xvfb', [':95', '-screen', '0', '1280x800x24'], { stdio: 'ignore' })
  await sleep(1200)

  const browserEnv = {
    ...process.env,
    DISPLAY: ':95',
    T1000_PAGE_URL: `http://127.0.0.1:${httpPort}/`,
    T1000_SHOT: join(SHOTS, 'android-renderer.png'),
    T1000_SHOT_DELAY: '10000',
  }
  delete browserEnv.ELECTRON_RUN_AS_NODE
  delete browserEnv.NODE_OPTIONS

  const browser = spawn(ELECTRON, ['--no-sandbox', electronMain], {
    env: browserEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const browserLogs = []
  browser.stdout.on('data', (d) => browserLogs.push(d.toString()))
  browser.stderr.on('data', (d) => browserLogs.push(d.toString()))

  /* ── 4. CDP 检查 ── */
  let cdpUrl = null
  const cdpDeadline = Date.now() + 20_000
  while (Date.now() < cdpDeadline) {
    try {
      const r = await fetch('http://127.0.0.1:9333/json/list')
      const list = await r.json()
      const page = list.find((t) => t.type === 'page' && t.url.includes('127.0.0.1'))
      if (page?.webSocketDebuggerUrl) {
        cdpUrl = page.webSocketDebuggerUrl
        break
      }
    } catch {
      /* 还没起来 */
    }
    await sleep(300)
  }
  if (!cdpUrl) {
    bad('CDP 未就绪，无法检查页面')
    console.log(browserLogs.join('').slice(-2000))
  } else {
    ok('CDP 已连接')

    const ws = new WebSocket(cdpUrl)
    await new Promise((r, j) => {
      ws.on('open', r)
      ws.on('error', j)
    })
    let msgId = 1
    const pending = new Map()
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString())
      if (m.id && pending.has(m.id)) {
        pending.get(m.id)(m)
        pending.delete(m.id)
      }
    })
    const evaluate = (expression, awaitPromise = true) =>
      new Promise((resolveP) => {
        const id = msgId++
        pending.set(id, (m) => resolveP(m.result?.result?.value ?? m.result))
        ws.send(
          JSON.stringify({
            id,
            method: 'Runtime.evaluate',
            params: { expression, awaitPromise, returnByValue: true },
          }),
        )
      })

    // 等界面挂载（渲染层首屏要做一次设置读取）
    await sleep(4000)

    const hasBridge = await evaluate('typeof window.t1000')
    if (hasBridge === 'object') ok('window.t1000 已注入（对象类型正确）')
    else bad(`window.t1000 注入失败：${hasBridge}`)

    const platform = await evaluate('window.t1000 && window.t1000.platform')
    if (platform === 'linux') {
      // 本机验证时 bridge 报的是它自己的 platform 常量 'android'（注入脚本里写死的）
      // —— 这里接受 android，代表桥的语义正确
      ok(`platform 同步可得：${platform}`)
    } else if (platform) {
      ok(`platform 同步可得：${platform}`)
    } else {
      bad('platform 读不到')
    }

    const invokeWorks = await evaluate(
      `window.t1000.invoke('app','getInfo',{}).then(r => JSON.stringify({ok:r.ok, platform:r.data&&r.data.platform, node:r.data&&r.data.node}))`,
    )
    if (String(invokeWorks).includes('"ok":true')) ok(`渲染层 invoke 往返正常：${invokeWorks}`)
    else bad(`渲染层 invoke 失败：${invokeWorks}`)

    const settingsOk = await evaluate(
      `window.t1000.invoke('settings','getAll',{}).then(r => r.ok && r.data && r.data.ai && r.data.ai.assistantName)`,
    )
    if (settingsOk) ok(`渲染层读到设置：助手称呼「${settingsOk}」`)
    else bad(`渲染层读设置失败：${settingsOk}`)

    // 界面是否真的渲染出来了
    const rootInfo = await evaluate(
      `JSON.stringify({ children: document.getElementById('root')?.children.length ?? 0, text: (document.body.innerText||'').slice(0,120) })`,
    )
    try {
      const parsed = JSON.parse(rootInfo)
      if (parsed.children > 0) ok(`React 已挂载（root 有 ${parsed.children} 个子节点）`)
      else bad('React 没有挂载（root 为空）')
      if (parsed.text && parsed.text.length > 0) {
        ok(`界面有可见文案：${JSON.stringify(parsed.text.replace(/\s+/g, ' ').slice(0, 60))}`)
      } else {
        bad('界面上没有任何文案（可能白屏）')
      }
    } catch {
      bad(`读取 DOM 状态失败：${rootInfo}`)
    }

    // 关键：终端 wasm 是否能通过桥拿到（Android 上没有 node_modules，只能走这条）
    const wasmOk = await evaluate(
      `window.t1000.invoke('app','kittyWasm',{}).then(r => r.ok ? r.data.bytes : ('err:'+(r.error&&r.error.message)))`,
    )
    if (typeof wasmOk === 'number' && wasmOk > 300000) ok(`渲染层拿到 kitty wasm：${wasmOk} 字节`)
    else bad(`渲染层取 wasm 失败：${wasmOk}`)

    // 截图：用 CDP 直接抓，比等 Electron 的 capturePage 可靠
    // （后者依赖窗口真的完成一次合成，在 offscreen/Xvfb 下经常拿不到）
    const shot = await new Promise((resolveP) => {
      const id = msgId++
      pending.set(id, (m) => resolveP(m.result?.data ?? null))
      ws.send(JSON.stringify({ id, method: 'Page.captureScreenshot', params: { format: 'png' } }))
    })
    if (shot) {
      writeFileSync(join(SHOTS, 'android-renderer.png'), Buffer.from(shot, 'base64'))
      ok('已截图')
    } else {
      console.log('  (截图失败，跳过)')
    }

    ws.close()
  }

  await new Promise((r) => {
    browser.on('exit', r)
    setTimeout(() => {
      browser.kill('SIGKILL')
      r()
    }, 15000)
  })
  xvfb.kill('SIGKILL')
  server.close()
  host.kill('SIGKILL')

  console.log('\n=== 结果 ===')
  console.log(`通过 ${pass.length} 项，失败 ${fail.length} 项`)
  if (existsSync(join(SHOTS, 'android-renderer.png'))) console.log(`截图：${join(SHOTS, 'android-renderer.png')}`)
  if (fail.length > 0) {
    console.log('\n失败项：')
    for (const f of fail) console.log(`  - ${f}`)
    console.log('\n--- browser 日志 ---')
    console.log(browserLogs.join('').slice(-2500))
    process.exit(1)
  }
  process.exit(0)
}

main().catch((e) => {
  console.error('验收异常:', e)
  process.exit(1)
})
