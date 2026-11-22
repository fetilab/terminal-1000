#!/usr/bin/env node
// 复现探针：主题切换丢文字 + altscreen 快速移动光标后残影
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const DESKTOP = '/home/mosfet/dsh1/terminal-1000/apps/desktop'
const CDP_PORT = 9227
const TEST_USERDATA = '/home/mosfet/dsh1/_tmp/t1000-verify-userdata'
const SHOTS = '/home/mosfet/dsh1/_shots'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

class Cdp {
  static async connect(url) {
    const c = new Cdp()
    c.ws = new WebSocket(url)
    await new Promise((res, rej) => {
      c.ws.addEventListener('open', res, { once: true })
      c.ws.addEventListener('error', rej, { once: true })
    })
    c.ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data)
      const p = c.pending.get(msg.id)
      if (p) {
        c.pending.delete(msg.id)
        msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result)
      }
    })
    return c
  }
  ws = null
  id = 0
  pending = new Map()
  send(method, params = {}) {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          reject(new Error(`${method} 超时`))
        }
      }, 20000)
    })
  }
  async eval(expression, awaitPromise = false) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true })
    if (r.exceptionDetails) throw new Error('页面异常: ' + JSON.stringify(r.exceptionDetails).slice(0, 600))
    return r?.result?.value
  }
  async shot(name) {
    const s = await this.send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(join(SHOTS, name), Buffer.from(s.data, 'base64'))
  }
}

async function waitForTarget(timeoutMs = 40000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)
      const list = await res.json()
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (page) return page.webSocketDebuggerUrl
    } catch {}
    await sleep(400)
  }
  throw new Error('CDP target 未就绪')
}

function launchApp() {
  return spawn('./node_modules/.bin/electron', ['.', '--no-sandbox', '--t1000-testhook', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', `--remote-debugging-port=${CDP_PORT}`], {
    cwd: DESKTOP,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '', DISPLAY: ':97', T1000_TEST_HOOK: '1', T1000_TEST_USERDATA: TEST_USERDATA },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

// 像素扫描：找指定 RGB 的连通块（与 CURSOR-CLICK 同法），返回块列表 [{x,y,w,h,area}]
async function scanBlobs(cdp, rgb, { tol = 30 } = {}) {
  return cdp.eval(`(() => {
    const eng = window.__kittyDemoEngine
    eng.renderer.render()
    const glc = document.querySelector('#kitty-demo canvas')
    const c2 = document.createElement('canvas')
    c2.width = glc.width; c2.height = glc.height
    const ctx = c2.getContext('2d')
    ctx.drawImage(glc, 0, 0)
    const img = ctx.getImageData(0, 0, c2.width, c2.height)
    const [cr, cg, cb] = ${JSON.stringify(rgb)}
    const tol = ${tol}
    const match = (i) => Math.abs(img.data[i]-cr)<=tol && Math.abs(img.data[i+1]-cg)<=tol && Math.abs(img.data[i+2]-cb)<=tol
    const W = c2.width, H = c2.height
    const mark = new Uint8Array(W*H)
    for (let p = 0; p < W*H; p++) if (match(p*4)) mark[p] = 1
    const seen = new Uint8Array(W*H)
    const blobs = []
    const stack = []
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const p = y*W+x
      if (!mark[p] || seen[p]) continue
      let area = 0, x0 = x, x1 = x, y0 = y, y1 = y
      stack.push(p); seen[p] = 1
      while (stack.length) {
        const q = stack.pop(); area++
        const qx = q%W, qy = (q/W)|0
        if (qx<x0) x0=qx; if (qx>x1) x1=qx; if (qy<y0) y0=qy; if (qy>y1) y1=qy
        for (const [dx,dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
          const nx = qx+dx, ny = qy+dy
          if (nx<0||ny<0||nx>=W||ny>=H) continue
          const np = ny*W+nx
          if (mark[np] && !seen[np]) { seen[np]=1; stack.push(np) }
        }
      }
      if (area >= 40) blobs.push({ x: x0, y: y0, w: x1-x0+1, h: y1-y0+1, area })
    }
    return { blobs, W, H }
  })()`)
}

const themeDump = (cdp) =>
  cdp.eval(`(() => {
    const eng = window.__kittyDemoEngine
    const t = eng.renderer.theme
    const hex = (c) => '#' + [c.r,c.g,c.b].map(v=>Math.round(v*255).toString(16).padStart(2,'0')).join('') + '/' + c.a.toFixed(2)
    return {
      resolved: (eng.opts ?? {}).resolvedTheme,
      colorScheme: eng.options.colorScheme,
      bg: hex(t.bg), fg: hex(t.fg), cursor: hex(t.cursor),
      p10: hex(t.palette[10]),
      cursorRect: eng.trailDebug().cursorRect,
      trail: (() => { const d = eng.trailDebug(); return { n: d.needsRender, o: +d.opacity.toFixed(2), cx: d.cornerX.map(v=>+v.toFixed(1)), cy: d.cornerY.map(v=>+v.toFixed(1)) } })(),
    }
  })()`)

/* ── 主流程 ── */
mkdirSync(SHOTS, { recursive: true })
const electron = launchApp()
let log = ''
electron.stdout.on('data', (d) => (log += d))
electron.stderr.on('data', (d) => (log += d))
try {
  const wsUrl = await waitForTarget()
  const cdp = await Cdp.connect(wsUrl)
  await cdp.send('Runtime.enable')
  await cdp.send('Page.enable')
  let ready = false
  for (let i = 0; i < 40 && !ready; i++) {
    ready = (await cdp.eval('typeof window.__t1000?.kittyDemo')) === 'function'
    if (!ready) await sleep(500)
  }
  if (!ready) throw new Error('testhook 未就绪')
  await cdp.eval('window.__t1000.kittyDemo({ width: 900, height: 520 })', true)
  await sleep(800)

  console.log('== A: 基线 ==')
  console.log(JSON.stringify(await themeDump(cdp)))

  console.log('== B: 主题切换（真实流程：applySettings，resolvedTheme 停留 dark）==')
  await cdp.eval(`window.__kittyDemoEngine.write('\\x1b[32mroot@demo:~$\\x1b[0m echo hello\\r\\n')`)
  await sleep(300)
  await cdp.shot('dbg-theme-before.png')
  const before = await themeDump(cdp)
  console.log('before =', JSON.stringify(before))
  // 真实 app 在主题切换时只调 applySettings（TerminalPane effect），resolvedTheme 不会传进去
  await cdp.eval(`(() => { const eng = window.__kittyDemoEngine; eng.applySettings({ ...eng.options }) })()`)
  await sleep(300)
  const after = await themeDump(cdp)
  console.log('after(applySettings only) =', JSON.stringify(after))
  await cdp.shot('dbg-theme-after-stale.png')

  console.log('== B2: 修好后应走的流程：resolvedTheme=light + applySettings ==')
  await cdp.eval(`(() => { const eng = window.__kittyDemoEngine; eng.opts.resolvedTheme = 'light'; eng.applySettings({ ...eng.options }) })()`)
  await sleep(300)
  const after2 = await themeDump(cdp)
  console.log('after(resolved=light) =', JSON.stringify(after2))
  await cdp.shot('dbg-theme-after-fixed.png')

  // 写新文字（模拟切换后新输入），像素验证文字可见
  await cdp.eval(`window.__kittyDemoEngine.write('\\x1b[32mroot@demo:~$\\x1b[0m after-switch\\r\\n')`)
  await sleep(300)
  await cdp.shot('dbg-theme-newtext.png')

  console.log('== C: alt 屏快速移动光标 + 退出 ==')
  await cdp.eval(`window.__kittyDemoEngine.write('\\x1b[?1049h\\x1b[2J\\x1b[H\\x1b[44m  HTOP-SIM  \\x1b[0m\\r\\n\\r\\ncpu 10% \\\\r\\n')`)
  await sleep(200)
  // 快速连续跳光标（模拟 htop 刷新时光标移动）
  for (let i = 0; i < 12; i++) {
    const row = 2 + (i % 6)
    const col = 5 + ((i * 17) % 70)
    await cdp.eval(`window.__kittyDemoEngine.write('\\x1b[${row};${col}H')`)
    await sleep(30)
  }
  await cdp.shot('dbg-alt-fast-mid.png')
  const midTrail = await themeDump(cdp)
  console.log('mid trail =', JSON.stringify(midTrail.trail))
  const cur = midTrail.cursorRect
  if (cur) {
    const [r, g, b] = await cdp.eval(`(() => { const c = window.__kittyDemoEngine.renderer.theme.cursor; return [Math.round(c.r*255), Math.round(c.g*255), Math.round(c.b*255)] })()`)
    const midBlobs = await scanBlobs(cdp, [r, g, b])
    console.log('mid cursor-color blobs =', JSON.stringify(midBlobs.blobs))
  }
  await sleep(1200)
  const convTrail = await themeDump(cdp)
  console.log('converged trail =', JSON.stringify(convTrail.trail))

  // 退出 alt 屏 → 模拟 shell 打新提示符
  await cdp.eval(`window.__kittyDemoEngine.write('\\x1b[?1049l\\x1b[32mroot@demo:~$\\x1b[0m ')`)
  await sleep(200)
  await cdp.shot('dbg-alt-exit-early.png')
  await sleep(1300)
  await cdp.shot('dbg-alt-exit-conv.png')
  const exitState = await themeDump(cdp)
  console.log('exit trail =', JSON.stringify(exitState.trail))
  const cur2 = exitState.cursorRect
  if (cur2) {
    const [r2, g2, b2] = await cdp.eval(`(() => { const c = window.__kittyDemoEngine.renderer.theme.cursor; return [Math.round(c.r*255), Math.round(c.g*255), Math.round(c.b*255)] })()`)
    const blobs = await scanBlobs(cdp, [r2, g2, b2])
    console.log('exit cursor-color blobs =', JSON.stringify(blobs.blobs))
    const text = await cdp.eval(`window.__kittyDemoEngine.viewportText().split('\\n').map(s=>s.trimEnd()).filter(Boolean).slice(-4)`)
    console.log('last rows =', JSON.stringify(text))
  }
  await cdp.shot('dbg-final.png')
} catch (err) {
  console.error('ERROR', err.message)
  console.error(log.slice(-1000))
} finally {
  electron.kill('SIGTERM')
  await sleep(500)
  electron.kill('SIGKILL')
}
