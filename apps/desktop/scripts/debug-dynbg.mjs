#!/usr/bin/env node
// 调试：动态背景脚本装载失败的 console 输出
import { spawn } from 'node:child_process'
const DESKTOP = '/home/mosfet/dsh1/terminal-1000/apps/desktop'
const CDP_PORT = 9226
const TEST_USERDATA = '/home/mosfet/dsh1/_tmp/t1000-verify-userdata'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitForTarget() {
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)
      const page = (await res.json()).find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (page) return page.webSocketDebuggerUrl
    } catch {}
    await sleep(400)
  }
  throw new Error('no target')
}

const electron = spawn('./node_modules/.bin/electron', ['.', '--no-sandbox', '--t1000-testhook', '--enable-unsafe-swiftshader', `--remote-debugging-port=${CDP_PORT}`], {
  cwd: DESKTOP,
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '', DISPLAY: ':97', T1000_TEST_HOOK: '1', T1000_TEST_USERDATA: TEST_USERDATA },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let appLog = ''
electron.stdout.on('data', (d) => (appLog += d))
electron.stderr.on('data', (d) => (appLog += d))

try {
  const ws = new WebSocket(await waitForTarget())
  await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }) })
  let id = 0
  const pending = new Map()
  const logs = []
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.method === 'Runtime.consoleAPICalled') {
      logs.push(msg.params.type + ': ' + msg.params.args.map((a) => a.value ?? a.description ?? '').join(' '))
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      logs.push('EXCEPTION: ' + JSON.stringify(msg.params.exceptionDetails).slice(0, 500))
    }
    const p = pending.get(msg.id)
    if (p) { pending.delete(msg.id); msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result) }
  })
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const i = ++id
    pending.set(i, { resolve, reject })
    ws.send(JSON.stringify({ id: i, method, params }))
    setTimeout(() => reject(new Error(method + ' timeout')), 15000)
  })
  await send('Runtime.enable')
  await send('Page.enable')
  for (let i = 0; i < 40; i++) {
    const r = await send('Runtime.evaluate', { expression: 'typeof window.__t1000?.kittyDemo', returnByValue: true })
    if (r.result.value === 'function') break
    await sleep(500)
  }
  await send('Runtime.evaluate', { expression: `window.__t1000.setAppearance('app.appearance.backgroundType','script').then(()=>window.__t1000.setAppearance('app.appearance.backgroundScript','matrix'))`, awaitPromise: true })
  await sleep(2500)
  const state = await send('Runtime.evaluate', { expression: `(() => {
    const el = document.querySelector('.t1000-dynbg')
    const cv = el?.querySelector('canvas')
    return { layer: !!el, canvas: !!cv, w: cv?.width, h: cv?.height }
  })()`, returnByValue: true })
  console.log('state =', JSON.stringify(state.result.value))
  console.log('--- console ---')
  for (const l of logs.filter((l) => l.includes('背景') || l.includes('EXCEPTION') || l.includes('error'))) console.log(l)
} catch (err) {
  console.error('DEBUG ERROR', err.message)
  console.error(appLog.slice(-800))
} finally {
  electron.kill('SIGKILL')
}
