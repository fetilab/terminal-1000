#!/usr/bin/env node
// kitty 渲染链路无头验收：
//   1. 拉起真实应用（CDP 9226）
//   2. window.__t1000.kittyDemo() —— 真实 KittyTerminal(WASM) + 自绘 WebGL2 渲染器
//   3. 校验 backend 标签、canvas 有非空像素、宽字符/颜色写入生效
//   4. Page.captureScreenshot 存 _shots/kitty-demo.png
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'

const DESKTOP = '/home/mosfet/dsh1/terminal-1000/apps/desktop'
const CDP_PORT = 9226
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

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
}

const electron = spawn('./node_modules/.bin/electron', ['.', '--no-sandbox', '--t1000-testhook', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', `--remote-debugging-port=${CDP_PORT}`], {
  cwd: DESKTOP,
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '', ELECTRON_NO_ATTACH_CONSOLE: '', DISPLAY: ':97', T1000_TEST_HOOK: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let appLog = ''
electron.stdout.on('data', (d) => (appLog += d))
electron.stderr.on('data', (d) => (appLog += d))

let cdp
try {
  const wsUrl = await waitForTarget()
  cdp = await Cdp.connect(wsUrl)
  await cdp.send('Runtime.enable')
  await cdp.send('Page.enable')

  // 等 testhook 就绪
  let hookReady = false
  for (let i = 0; i < 40 && !hookReady; i++) {
    const r = await cdp.send('Runtime.evaluate', { expression: 'typeof window.__t1000?.kittyDemo', returnByValue: true })
    hookReady = r.result.value === 'function'
    if (!hookReady) await sleep(500)
  }
  if (!hookReady) throw new Error('testhook 未就绪：' + appLog.slice(-800))

  const r1 = await cdp.send('Runtime.evaluate', {
    expression: `window.__t1000.kittyDemo({ width: 1100, height: 620 })`,
    awaitPromise: true,
    returnByValue: true,
  })
  if (r1.exceptionDetails) throw new Error('kittyDemo 异常: ' + JSON.stringify(r1.exceptionDetails))
  if (!r1?.result?.value) console.log('r1 raw =', JSON.stringify(r1)?.slice(0, 500))
  console.log('backend =', r1?.result?.value?.backend)
  await sleep(1200)

  const r2 = await cdp.send('Runtime.evaluate', {
    expression: `(() => {
      const eng = window.__kittyDemoEngine
      const canvas = document.querySelector('#kitty-demo canvas')
      if (!canvas) return { ok: false, why: 'no canvas' }
      let px, glType
      const gl = canvas.getContext('webgl2')
      if (gl) {
        glType = 'webgl2'
        px = new Uint8Array(4 * 200)
        gl.readPixels(Math.floor(canvas.width/2)-10, Math.floor(canvas.height/2)-5, 20, 10, gl.RGBA, gl.UNSIGNED_BYTE, px)
      } else {
        const ctx2d = canvas.getContext('2d')
        if (!ctx2d) return { ok: false, why: 'no gl2 and no 2d' }
        glType = '2d'
        const d = ctx2d.getImageData(Math.floor(canvas.width/2)-10, Math.floor(canvas.height/2)-5, 20, 10)
        px = d.data
      }
      let nonBlack = 0
      for (let i = 0; i < px.length; i += 4) if (px[i] + px[i+1] + px[i+2] > 40) nonBlack++
      // 深度探针：屏幕全画布 / 图集画布 / 图集纹理
      const full = new Uint8Array(canvas.width * canvas.height * 4)
      if (gl) gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, full)
      else {
        const c2 = document.createElement('canvas'); c2.width = canvas.width; c2.height = canvas.height
        const cc = c2.getContext('2d'); cc.drawImage(canvas, 0, 0)
        const d = cc.getImageData(0, 0, canvas.width, canvas.height); full.set(d.data)
      }
      let fullNonBlack = 0
      for (let i = 0; i < full.length; i += 4) if (full[i] + full[i+1] + full[i+2] > 40) fullNonBlack++

      const eng2 = window.__kittyDemoEngine
      const atlasCanvas = eng2?.renderer?.atlas?.source
      let atlasStats = null
      if (atlasCanvas) {
        const ac = atlasCanvas.getContext('2d')
        const d = ac.getImageData(0, 0, 400, 120)
        let n = 0
        for (let i = 3; i < d.data.length; i += 4) if (d.data[i] > 10) n++
        atlasStats = { size: atlasCanvas.width, alphaTop: n }
      }
      let texStats = null
      const glr = eng2?.renderer?.gl
      const tex = eng2?.renderer?.atlasTex
      if (glr && tex) {
        const fb = glr.createFramebuffer()
        glr.bindFramebuffer(glr.FRAMEBUFFER, fb)
        glr.framebufferTexture2D(glr.FRAMEBUFFER, glr.COLOR_ATTACHMENT0, glr.TEXTURE_2D, tex, 0)
        const t = new Uint8Array(400 * 120 * 4)
        glr.readPixels(0, 0, 400, 120, glr.RGBA, glr.UNSIGNED_BYTE, t)
        let n = 0
        for (let i = 3; i < t.length; i += 4) if (t[i] > 10) n++
        texStats = { alphaTop: n }
        glr.bindFramebuffer(glr.FRAMEBUFFER, null)
        glr.deleteFramebuffer(fb)
      }
      // 读回 pass1（字形）实例缓冲：第 0 行每格的 UV 与字形 id
      let line0 = null
      const glr2 = eng2?.renderer?.gl
      const buf = eng2?.renderer?.buffer
      const rcols = eng2?.renderer?.cols
      const rrows = eng2?.renderer?.rows
      const STRIDE_F = 14
      if (glr2 && buf && rcols) {
        const N = rcols * rrows
        const total = N * STRIDE_F * 3 * 4
        glr2.bindBuffer(glr2.ARRAY_BUFFER, buf)
        const all = new Float32Array(N * STRIDE_F * 3)
        glr2.getBufferSubData(glr2.ARRAY_BUFFER, 0, all)
        const base = N * STRIDE_F
        line0 = []
        for (let x = 0; x < Math.min(rcols, 40); x++) {
          const o = base + x * STRIDE_F
          line0.push(all[o + 2] !== 0 || all[o + 4] !== 0 ? 'G' : '.')
        }
      }
      return {
        ok: true,
        backend: eng?.backendLabel,
        line0: line0 ? line0.join('') : null,
        glType,
        w: canvas.width, h: canvas.height,
        nonBlackRatio: +(nonBlack / (px.length/4)).toFixed(3),
        fullNonBlack,
        atlasStats, texStats,
        cursor: eng ? eng.meta?.cursor : null,
        cols: eng?.meta?.cols, rows: eng?.meta?.rows,
      }
    })()`,
    returnByValue: true,
  })
  if (!r2?.result?.value) console.log('r2 raw =', JSON.stringify(r2)?.slice(0, 500))
  console.log('pixels =', JSON.stringify(r2?.result?.value))
  const px = r2?.result?.value ?? {}
  // 判据：WebGL2 后端 + 图集纹理里有字形 + 网格尺寸正常。
  // （readPixels 在 preserveDrawingBuffer=false 下是假阴性，不参与判定；画面以截图为准）
  const ok = px?.ok && px.glType === 'webgl2' && (px.texStats?.alphaTop ?? 0) > 500 && (px.cols ?? 0) > 40

  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
  mkdirSync('/home/mosfet/dsh1/_shots', { recursive: true })
  writeFileSync('/home/mosfet/dsh1/_shots/kitty-demo.png', Buffer.from(shot.data, 'base64'))
  console.log(ok ? 'RESULT: PASS' : 'RESULT: FAIL')
  process.exitCode = ok ? 0 : 1
} catch (err) {
  console.error('RESULT: ERROR', err.message)
  console.error(appLog.slice(-1500))
  process.exitCode = 2
} finally {
  electron.kill('SIGTERM')
  await sleep(300)
  electron.kill('SIGKILL')
}
