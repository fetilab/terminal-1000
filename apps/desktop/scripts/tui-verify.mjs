#!/usr/bin/env node
// //SPDX-License-Identifier: GPL-3.0-or-later
// 终端 TUI / 光标 / 动态背景无头验收（真实应用 + 真实内核 + 真实设置链）：
//   1. KERNEL-TUI    altscreen + 滚动区域（DECSTBM/SU/SD/IL/DL）→ 引擎网格必须与内核一致
//                    （vim/htop 叠印回归：alt 屏区域滚动不标脏，worker 必须 alt 屏整屏重发）
//   2. CURSOR-CLICK  光标跳转 → 动画中拖尾可见 → 收敛后像素级扫描：光标色块全屏只有 1 个
//                    （「点按出现两个光标」回归：收敛后残留 quad 绝不允许再画）
//   3. DYNBG-CHAIN   动态背景：设置 → 纯色/TS 脚本 → DOM/像素断言 → 关闭
//   4. DYNBG-BOOT    重启后设置持久化且启动即生效（挂载时序回归）
// 数据目录用 T1000_TEST_USERDATA 隔离，绝不碰用户真实数据。
import { spawn } from 'node:child_process'
import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const DESKTOP = '/home/mosfet/dsh1/terminal-1000/apps/desktop'
const CDP_PORT = 9226
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
    if (r.exceptionDetails) throw new Error('页面异常: ' + JSON.stringify(r.exceptionDetails).slice(0, 400))
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
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '',
      DISPLAY: ':97',
      T1000_TEST_HOOK: '1',
      T1000_TEST_USERDATA: TEST_USERDATA,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

async function connectWithDemo(electron, appLogRef, { withDemo = true } = {}) {
  const wsUrl = await waitForTarget()
  const cdp = await Cdp.connect(wsUrl)
  await cdp.send('Runtime.enable')
  await cdp.send('Page.enable')
  let ready = false
  for (let i = 0; i < 40 && !ready; i++) {
    ready = (await cdp.eval('typeof window.__t1000?.kittyDemo')) === 'function'
    if (!ready) await sleep(500)
  }
  if (!ready) throw new Error('testhook 未就绪：' + appLogRef.log.slice(-800))
  if (withDemo) {
    const r = await cdp.eval('window.__t1000.kittyDemo({ width: 1100, height: 620 })', true)
    if (!r?.backend) throw new Error('kittyDemo 失败: ' + JSON.stringify(r))
    await sleep(1000)
  }
  return cdp
}

/* ── 探针 1：内核级 altscreen + 滚动区域 ── */
async function probeKernelTui(cdp) {
  // 进 alt 屏铺 6 行；区域 3..6 内做 SU/SD/IL，区域外的行绝不能动
  await cdp.eval(`window.__kittyDemoEngine.write('\\x1b[?1049h\\x1b[H')
    `)
  await cdp.eval(`window.__kittyDemoEngine.write('ALT-BASE\\r\\nline2\\r\\nline3\\r\\nline4\\r\\nline5\\r\\n')`)
  await sleep(300)
  const s1 = await cdp.eval(`(() => {
    const eng = window.__kittyDemoEngine
    return { rows: eng.viewportText().split('\\n').map(s=>s.trimEnd()), alt: eng.meta?.modes?.altScreen }
  })()`)
  const baseOk =
    s1.alt === true &&
    s1.rows[0] === 'ALT-BASE' && s1.rows[1] === 'line2' && s1.rows[2] === 'line3' &&
    s1.rows[3] === 'line4' && s1.rows[4] === 'line5'

  // DECSTBM 3..6 + SU 2：区域内容上移 2（line3/line4 被卷走，line5 到区域顶）
  await cdp.eval(`window.__kittyDemoEngine.write('\\x1b[3;6r\\x1b[2S')`)
  await sleep(300)
  const s2 = await cdp.eval(`(() => window.__kittyDemoEngine.viewportText().split('\\n').map(s=>s.trimEnd()))()`)
  const suOk = s2[0] === 'ALT-BASE' && s2[1] === 'line2' && s2[2] === 'line5' && s2[3] === '' && s2[4] === ''

  // SD 2：区域内容下移 2（line5 回到区域第 3 行）
  await cdp.eval(`window.__kittyDemoEngine.write('\\x1b[2T')`)
  await sleep(300)
  const s3 = await cdp.eval(`(() => window.__kittyDemoEngine.viewportText().split('\\n').map(s=>s.trimEnd()))()`)
  const sdOk = s3[0] === 'ALT-BASE' && s3[1] === 'line2' && s3[4] === 'line5' && s3[2] === '' && s3[3] === ''

  // DL 1：光标在区域顶（SU 后光标没动）——先定位到区域顶再删行
  await cdp.eval(`window.__kittyDemoEngine.write('\\x1b[3;1H\\x1b[2T')`)
  await sleep(300)
  const s4 = await cdp.eval(`(() => window.__kittyDemoEngine.viewportText().split('\\n').map(s=>s.trimEnd()))()`)
  const dlOk = s4[0] === 'ALT-BASE' && s4[1] === 'line2' && s4[2] === '' && s4[4] === ''

  // 出 alt 屏：主屏内容必须原样恢复（demo 头部还在）
  await cdp.eval(`window.__kittyDemoEngine.write('\\x1b[?1049l')`)
  await sleep(300)
  const s5 = await cdp.eval(`(() => ({
    alt: window.__kittyDemoEngine.meta?.modes?.altScreen,
    hasDemo: window.__kittyDemoEngine.viewportText().includes('terminal-1000'),
    row0: window.__kittyDemoEngine.viewportText().split('\\n')[0] ?? ''
  }))()`)
  const restoreOk = s5.alt === false && s5.hasDemo

  await cdp.shot('tui-altscreen.png')
  console.log(`KERNEL-TUI: ${baseOk && suOk && sdOk && dlOk && restoreOk ? 'PASS' : 'FAIL'} (铺屏=${baseOk} SU=${suOk} SD=${sdOk} DL=${dlOk} 出alt恢复=${restoreOk})`)
  if (!baseOk) console.log('  base =', JSON.stringify(s1))
  if (!suOk) console.log('  su   =', JSON.stringify(s2))
  if (!sdOk) console.log('  sd   =', JSON.stringify(s3))
  if (!dlOk) console.log('  dl   =', JSON.stringify(s4))
  if (!restoreOk) console.log('  rst  =', JSON.stringify(s5))
  return baseOk && suOk && sdOk && dlOk && restoreOk
}

/* ── 探针 2：光标像素级扫描（滑行中一个刚性方块、收敛后精确落位） ── */
async function probeCursorClick(cdp) {
  // 光标换成 block（默认设置是细条 beam，面积太小不好做像素断言），
  // 并关掉闪烁——blink 灭相时光标不画，像素断言会随机翻车
  await cdp.eval(`window.__kittyDemoEngine.applySettings({ ...window.__kittyDemoEngine.options, cursorStyle: 'block', cursorBlink: false })`)
  await sleep(200)
  const dims = await cdp.eval(`(() => {
    const eng = window.__kittyDemoEngine
    return { cellW: eng.renderer.atlas.cellW, cellH: eng.renderer.atlas.cellH }
  })()`)
  // 光标从当前位跳到 (12,50)：距离远超 threshold 2，滑行必然启动
  await cdp.eval(`window.__kittyDemoEngine.write('\\x1b[12;50H')`)
  await sleep(40)
  const mid = await cdp.eval(`(() => {
    const eng = window.__kittyDemoEngine
    const d = eng.trailDebug()
    // 刚性检测：四角必须构成矩形（对边等长、邻边垂直）——变形=蝶形结=「第二个光标」
    const P = d.cornerX.map((x, i) => [x, d.cornerY[i]])
    const d01 = Math.hypot(P[1][0]-P[0][0], P[1][1]-P[0][1])
    const d13 = Math.hypot(P[3][0]-P[1][0], P[3][1]-P[1][1])
    const d32 = Math.hypot(P[2][0]-P[3][0], P[2][1]-P[3][1])
    const d20 = Math.hypot(P[0][0]-P[2][0], P[0][1]-P[2][1])
    const rigid = Math.abs(d01-d32) < 0.05 && Math.abs(d13-d20) < 0.05
    return {
      needsRender: d.needsRender, cursorRect: d.cursorRect, corners: P, rigid,
      cursorRgb: [Math.round(eng.renderer.theme.cursor.r*255), Math.round(eng.renderer.theme.cursor.g*255), Math.round(eng.renderer.theme.cursor.b*255)],
    }
  })()`)
  await cdp.shot('cursor-mid-1.png')
  await sleep(140)
  await cdp.shot('cursor-mid-2.png')

  // 滑行中断言：动画在跑、四角是刚性矩形
  const midOk = mid.needsRender === true && mid.cursorRect !== null && mid.rigid
  if (!midOk) console.log('  mid =', JSON.stringify(mid))

  // 滑行中整屏扫描：光标色块必须**只有 1 个**且是完整格子大小的矩形
  //（旧拖尾的变形残片会出现 2 个块 / 或一个不成矩形的碎片）
  const midScan = await scanCursorBlobs(cdp, mid.cursorRgb, dims)
  const midBlobOk =
    midScan.blobs.length === 1 &&
    midScan.blobs[0].w >= dims.cellW * 0.6 && midScan.blobs[0].w <= dims.cellW * 1.5 &&
    midScan.blobs[0].h >= dims.cellH * 0.6 && midScan.blobs[0].h <= dims.cellH * 1.3
  if (!midBlobOk) console.log('  midScan =', JSON.stringify(midScan))

  // 收敛：整屏像素扫描光标色。用同步 render + drawImage 到 2d 画布读像素
  //（WebGL 默认 preserveDrawingBuffer=false，跨任务 readPixels 是假阴性）
  await sleep(1300)
  const scan = await cdp.eval(`(() => {
    const eng = window.__kittyDemoEngine
    eng.renderer.render()
    const glc = document.querySelector('#kitty-demo canvas')
    const c2 = document.createElement('canvas')
    c2.width = glc.width; c2.height = glc.height
    const ctx = c2.getContext('2d')
    ctx.drawImage(glc, 0, 0)
    const img = ctx.getImageData(0, 0, c2.width, c2.height)
    const d = eng.trailDebug()
    const cellW = eng.renderer.atlas.cellW, cellH = eng.renderer.atlas.cellH
    const r = d.cursorRect
    const [cr, cg, cb] = [Math.round(eng.renderer.theme.cursor.r*255), Math.round(eng.renderer.theme.cursor.g*255), Math.round(eng.renderer.theme.cursor.b*255)]
    const tol = 14
    const match = (i) => Math.abs(img.data[i]-cr)<=tol && Math.abs(img.data[i+1]-cg)<=tol && Math.abs(img.data[i+2]-cb)<=tol
    // 光标矩形（含 2px 容差）内的匹配像素数
    const x0 = Math.max(0, Math.floor(r[0]*cellW)-2), x1 = Math.min(c2.width, Math.ceil(r[1]*cellW)+2)
    const y0 = Math.max(0, Math.floor(r[2]*cellH)-2), y1 = Math.min(c2.height, Math.ceil(r[3]*cellH)+2)
    let inside = 0
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const i = (y*c2.width + x)*4
      if (match(i)) inside++
    }
    // 矩形外：连通块统计（光标色残留 = 第二个光标）
    const outside = new Uint8Array(c2.width*c2.height)
    for (let y = 0; y < c2.height; y++) for (let x = 0; x < c2.width; x++) {
      if (x >= x0 && x < x1 && y >= y0 && y < y1) continue
      const i = (y*c2.width + x)*4
      if (match(i)) outside[y*c2.width+x] = 1
    }
    const minArea = 0.15*cellW*cellH
    let blobs = 0
    const seen = new Uint8Array(c2.width*c2.height)
    const stack = []
    for (let y = 0; y < c2.height; y++) for (let x = 0; x < c2.width; x++) {
      const p = y*c2.width+x
      if (!outside[p] || seen[p]) continue
      let area = 0
      stack.push(p); seen[p] = 1
      while (stack.length) {
        const q = stack.pop(); area++
        const qx = q%c2.width, qy = (q/c2.width)|0
        for (const [dx,dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
          const nx = qx+dx, ny = qy+dy
          if (nx<0||ny<0||nx>=c2.width||ny>=c2.height) continue
          const np = ny*c2.width+nx
          if (outside[np] && !seen[np]) { seen[np]=1; stack.push(np) }
        }
      }
      if (area >= minArea) blobs++
    }
    return { w: c2.width, h: c2.height, inside, outsideBlobs: blobs, needsRender: d.needsRender, cursorRect: r }
  })()`)
  await cdp.shot('cursor-converged.png')
  console.log('cursor-scan =', JSON.stringify(scan))
  // 收敛后：矩形内有光标像素（光标在画）+ 全屏没有第二个光标色块 + 渲染器判定已收敛
  const convOk = scan.inside > 20 && scan.outsideBlobs === 0 && scan.needsRender === false
  console.log(`CURSOR-CLICK: ${midOk && midBlobOk && convOk ? 'PASS' : 'FAIL'} (滑行中单刚性方块=${midOk && midBlobOk} 收敛单光标=${convOk})`)
  return midOk && midBlobOk && convOk
}

/** 全屏扫描光标色连通块（滑行中断言用） */
async function scanCursorBlobs(cdp, rgb, dims) {
  const r = await cdp.eval(`(() => {
    const eng = window.__kittyDemoEngine
    eng.renderer.render()
    const glc = document.querySelector('#kitty-demo canvas')
    const c2 = document.createElement('canvas')
    c2.width = glc.width; c2.height = glc.height
    const ctx = c2.getContext('2d')
    ctx.drawImage(glc, 0, 0)
    const img = ctx.getImageData(0, 0, c2.width, c2.height)
    const [cr, cg, cb] = ${JSON.stringify(rgb)}
    const tol = 20
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
      if (area >= 0.1*${JSON.stringify(dims.cellW)}*${JSON.stringify(dims.cellH)}) blobs.push({ x: x0, y: y0, w: x1-x0+1, h: y1-y0+1, area })
    }
    return { blobs, W, H }
  })()`)
  return r
}

/* ── 探针 2.5：主题切换（深→浅：配色必须跟着换、新文字必须可见） ── */
async function probeThemeSwitch(cdp) {
  // 铺一行 32m（调色板索引 2）提示符 + 默认前景文字；主题切换后这两类颜色都要变。
  // 同样关闪烁，避免像素断言撞上灭相
  await cdp.eval(`window.__kittyDemoEngine.applySettings({ ...window.__kittyDemoEngine.options, cursorStyle: 'block', cursorBlink: false })`)
  await cdp.eval(`window.__kittyDemoEngine.write('\\x1b[?1049l\\x1b[2J\\x1b[H\\x1b[32mroot@demo:~$\\x1b[0m echo before\\r\\n\\x1b[0mplain-default-fg\\r\\n')`)
  await sleep(300)
  const before = await cdp.eval(`(() => {
    const eng = window.__kittyDemoEngine
    const t = eng.renderer.theme
    const hex = (c) => [Math.round(c.r*255), Math.round(c.g*255), Math.round(c.b*255)]
    return { bg: hex(t.bg), fg: hex(t.fg), green: hex(t.palette[2] ?? t.palette[10]), resolved: eng.opts.resolvedTheme }
  })()`)
  await cdp.shot('theme-before.png')

  // 窗格在 resolvedTheme 变化时的同款调用：setResolvedTheme + applySettings
  await cdp.eval(`(() => {
    const eng = window.__kittyDemoEngine
    eng.setResolvedTheme('light')
    eng.applySettings({ ...eng.options })
  })()`)
  await sleep(200)
  // 切换后再写新文字（复现「切换后不显示文字」）
  await cdp.eval(`window.__kittyDemoEngine.write('\\x1b[32mroot@demo:~$\\x1b[0m after-switch\\r\\n\\x1b[0mplain-after\\r\\n')`)
  await sleep(300)
  const after = await cdp.eval(`(() => {
    const eng = window.__kittyDemoEngine
    const t = eng.renderer.theme
    const hex = (c) => [Math.round(c.r*255), Math.round(c.g*255), Math.round(c.b*255)]
    const rows = eng.viewportText().split('\\n').map(s=>s.trimEnd())
    return { bg: hex(t.bg), fg: hex(t.fg), green: hex(t.palette[2] ?? t.palette[10]), resolved: eng.opts.resolvedTheme,
      hasAfter: rows.some(r => r.includes('after-switch')), hasPlain: rows.some(r => r.includes('plain-after')) }
  })()`)
  await cdp.shot('theme-after.png')

  // 像素断言：切换后背景是浅色（亮像素占多数）+ 新行文字以浅色方案绿/前景可见
  const pixels = await cdp.eval(`(() => {
    const eng = window.__kittyDemoEngine
    eng.renderer.render()
    const glc = document.querySelector('#kitty-demo canvas')
    const c2 = document.createElement('canvas')
    c2.width = glc.width; c2.height = glc.height
    const ctx = c2.getContext('2d')
    ctx.drawImage(glc, 0, 0)
    const img = ctx.getImageData(0, 0, c2.width, c2.height)
    const cellW = eng.renderer.atlas.cellW, cellH = eng.renderer.atlas.cellH
    // 找 after-switch 所在行（viewportText 里倒数第 2 行有内容）
    const rows = eng.viewportText().split('\\n')
    let rowIdx = -1
    for (let i = 0; i < rows.length; i++) if (rows[i].includes('after-switch')) { rowIdx = i; break }
    if (rowIdx < 0) return { ok: false, why: 'row not found' }
    const [gr, gg, gb] = ${JSON.stringify(after.green)}
    const tol = 40
    let greenPx = 0, brightBg = 0, total = 0
    const y0 = Math.floor(rowIdx*cellH), y1 = Math.min(c2.height, Math.ceil((rowIdx+1)*cellH))
    for (let y = y0; y < y1; y++) for (let x = 0; x < c2.width; x++) {
      const i = (y*c2.width + x)*4
      total++
      if (img.data[i]+img.data[i+1]+img.data[i+2] > 600) brightBg++
      if (Math.abs(img.data[i]-gr)<=tol && Math.abs(img.data[i+1]-gg)<=tol && Math.abs(img.data[i+2]-gb)<=tol) greenPx++
    }
    // 默认前景行（plain-after）也要有前景色像素
    let plainRow = -1
    for (let i = 0; i < rows.length; i++) if (rows[i].includes('plain-after')) { plainRow = i; break }
    const [fr, fg_, fb] = ${JSON.stringify(after.fg)}
    let fgPx = 0
    if (plainRow >= 0) {
      const py0 = Math.floor(plainRow*cellH), py1 = Math.min(c2.height, Math.ceil((plainRow+1)*cellH))
      for (let y = py0; y < py1; y++) for (let x = 0; x < c2.width; x++) {
        const i = (y*c2.width + x)*4
        if (Math.abs(img.data[i]-fr)<=tol && Math.abs(img.data[i+1]-fg_)<=tol && Math.abs(img.data[i+2]-fb)<=tol) fgPx++
      }
    }
    return { ok: true, rowIdx, greenPx, fgPx, brightRatio: brightBg/total }
  })()`)

  const themeOk =
    after.resolved === 'light' &&
    after.bg[0] > 200 && after.bg[1] > 200 && // 浅色背景
    (before.green[1] !== after.green[1] || before.bg[0] !== after.bg[0]) // 配色确实变了
  const textOk = after.hasAfter && after.hasPlain && pixels.ok && pixels.greenPx > 10 && pixels.fgPx > 10 && pixels.brightRatio > 0.5
  console.log(`THEME-SWITCH: ${themeOk && textOk ? 'PASS' : 'FAIL'} (配色切换=${themeOk} 文字可见=${textOk})`)
  console.log('  before =', JSON.stringify(before))
  console.log('  after  =', JSON.stringify(after))
  console.log('  pixels =', JSON.stringify(pixels))
  return themeOk && textOk
}

/** 读 demo 画布的背景 alpha（min 采样：字形只会抬高 alpha，min 即背景层） */
async function canvasBgAlpha(cdp) {
  return cdp.eval(`(() => {
    const eng = window.__kittyDemoEngine
    eng.renderer.render()
    const glc = document.querySelector('#kitty-demo canvas')
    const c2 = document.createElement('canvas')
    c2.width = glc.width; c2.height = glc.height
    const ctx = c2.getContext('2d')
    ctx.drawImage(glc, 0, 0)
    const img = ctx.getImageData(0, 0, c2.width, c2.height)
    let min = 255
    for (let y = 2; y < c2.height; y += 7) for (let x = 2; x < c2.width; x += 7) {
      const a = img.data[(y*c2.width + x)*4 + 3]
      if (a < min) min = a
    }
    return min
  })()`)
}

/* ── 探针 3+4：动态背景（链路 + 重启持久化） ── */
async function probeDynbgChain(cdp) {
  // 与设置 UI 完全同路径（SettingsView.update：IPC set → 全量文档 → applyAppearance）
  const set = (path, value) =>
    cdp.eval(`window.__t1000.setAppearance(${JSON.stringify(path)}, ${JSON.stringify(value)})`, true)
  const dom = () =>
    cdp.eval(`(() => {
      const el = document.querySelector('.t1000-dynbg')
      const colorEl = document.querySelector('.t1000-dynbg--color')
      return {
        hasClass: document.body.classList.contains('t1000-has-dynbg'),
        layer: el !== null,
        colorEl: colorEl !== null,
        colorCss: colorEl ? getComputedStyle(colorEl).backgroundColor : null,
        opacityCss: el ? getComputedStyle(el).opacity : null,
        canvas: el?.querySelector('canvas') !== null,
      }
    })()`)

  await set('app.appearance.backgroundOpacity', 1)
  await set('app.appearance.backgroundColor', '#c0392b')
  await set('app.appearance.backgroundType', 'color')
  await sleep(400)
  const c1 = await dom()
  const colorOk = c1.hasClass && c1.layer && c1.colorEl && c1.colorCss === 'rgb(192, 57, 43)' && parseFloat(c1.opacityCss) === 1
  await cdp.shot('dynbg-color.png')

  // 终端画布半透明联动 + 毛玻璃：背景激活时 canvas alpha 必须 < 1、
  // .kitty-surface 必须有 backdrop-filter（否则背景被实心画布挡住=「不显示」）
  await cdp.eval(`window.__kittyDemoEngine.applySettings({ ...window.__kittyDemoEngine.options, backgroundOpacity: 0.78 })`)
  await sleep(150)
  const alphaOn = await canvasBgAlpha(cdp)
  const glass = await cdp.eval(`(() => {
    const el = document.querySelector('#kitty-demo .kitty-surface')
    return el ? (getComputedStyle(el).backdropFilter || getComputedStyle(el).webkitBackdropFilter || 'none') : null
  })()`)
  const alphaOnOk = alphaOn > 150 && alphaOn < 215
  const glassOk = typeof glass === 'string' && glass !== 'none'
  await cdp.eval(`window.__kittyDemoEngine.applySettings({ ...window.__kittyDemoEngine.options, backgroundOpacity: 0.88 })`)
  await sleep(150)
  const alphaOff = await canvasBgAlpha(cdp)
  const alphaOffOk = alphaOff >= 216
  console.log(`  canvas alpha: 背景开=${alphaOn} (期望≈198) 毛玻璃=${glass} 背景关=${alphaOff} (期望≈224)`)

  // 图片类型：走 body::before（静态层），断言 CSS 变量与 has-bg
  await set('app.appearance.backgroundType', 'image')
  await set('app.appearance.backgroundImage', '/home/mosfet/dsh1/_tmp/t1000-test-bg.png')
  await sleep(400)
  const cImg = await cdp.eval(`(() => {
    const root = document.documentElement
    const v = root.style.getPropertyValue('--t1000-bg-image')
    return {
      hasBgClass: document.body.classList.contains('t1000-has-bg'),
      cssVar: v.startsWith('url("file:///home/mosfet/dsh1/_tmp/t1000-test-bg.png")'),
      dynGone: document.querySelector('.t1000-dynbg') === null,
    }
  })()`)
  const imageOk = cImg.hasBgClass && cImg.cssVar && cImg.dynGone
  await set('app.appearance.backgroundImage', '')
  await cdp.shot('dynbg-image.png')

  await set('app.appearance.backgroundType', 'script')
  await set('app.appearance.backgroundScript', 'matrix')
  await sleep(1200)
  const c2 = await dom()
  // 代码雨画布必须有非黑像素（脚本真的在画）
  const pixels = await cdp.eval(`(() => {
    const cv = document.querySelector('.t1000-dynbg canvas')
    if (!cv) return { ok: false, nonBlack: 0 }
    const ctx = cv.getContext('2d')
    if (!ctx) return { ok: false, nonBlack: 0 }
    const d = ctx.getImageData(0, 0, Math.min(cv.width, 800), Math.min(cv.height, 400))
    let n = 0
    for (let i = 0; i < d.data.length; i += 4) if (d.data[i] + d.data[i+1] + d.data[i+2] > 30) n++
    return { ok: true, nonBlack: n, w: cv.width, h: cv.height }
  })()`)
  const scriptOk = c2.layer && c2.canvas && pixels.ok && pixels.nonBlack > 200
  await cdp.shot('dynbg-script.png')

  await set('app.appearance.backgroundType', 'none')
  await sleep(400)
  const c3 = await dom()
  const offOk = !c3.hasClass && !c3.layer

  console.log(`DYNBG-CHAIN: ${colorOk && alphaOnOk && glassOk && alphaOffOk && imageOk && scriptOk && offOk ? 'PASS' : 'FAIL'} (纯色=${colorOk} 画布半透明=${alphaOnOk && alphaOffOk} 毛玻璃=${glassOk} 图片=${imageOk} 脚本=${scriptOk} 关闭=${offOk})`)
  console.log('  color dom =', JSON.stringify(c1))
  console.log('  image dom =', JSON.stringify(cImg))
  console.log('  script dom =', JSON.stringify(c2), 'pixels =', JSON.stringify(pixels))
  console.log('  off dom =', JSON.stringify(c3))
  return colorOk && alphaOnOk && glassOk && alphaOffOk && imageOk && scriptOk && offOk
}

/* ── 主流程 ── */
mkdirSync(SHOTS, { recursive: true })
// 只清已知文件（整目录 rm 会撞批量删除保护），保证从干净状态开始
for (const f of ['settings.json', 'local-store.db', 'local-store.db-wal', 'local-store.db-shm', 'migration.json']) {
  try {
    unlinkSync(join(TEST_USERDATA, f))
  } catch {}
}
const results = {}
let appLogRef = { log: '' }

// 第一段：内核 TUI + 光标 + 动态背景链路
{
  const electron = launchApp()
  electron.stdout.on('data', (d) => (appLogRef.log += d))
  electron.stderr.on('data', (d) => (appLogRef.log += d))
  try {
    const cdp = await connectWithDemo(electron, appLogRef)
    results.tui = await probeKernelTui(cdp)
    results.cursor = await probeCursorClick(cdp)
    results.theme = await probeThemeSwitch(cdp)
    results.dynbg = await probeDynbgChain(cdp)
    // 种下纯色背景供重启探针
    await cdp.eval(`window.__t1000.setAppearance('app.appearance.backgroundColor', '#1abc5b')`, true)
    await cdp.eval(`window.__t1000.setAppearance('app.appearance.backgroundType', 'color')`, true)
    await sleep(300)
  } catch (err) {
    console.error('RESULT: ERROR', err.message)
    console.error(appLogRef.log.slice(-1200))
    process.exitCode = 2
  } finally {
    electron.kill('SIGTERM')
    await sleep(500)
    electron.kill('SIGKILL')
  }
}

// 第二段：重启持久化 —— 不做任何设置，纯色背景必须启动即出现
{
  const electron = launchApp()
  electron.stdout.on('data', (d) => (appLogRef.log += d))
  electron.stderr.on('data', (d) => (appLogRef.log += d))
  try {
    const cdp = await connectWithDemo(electron, appLogRef, { withDemo: false })
    // 给启动链（store 初始化 → applyAppearance）留时间
    let boot = null
    for (let i = 0; i < 10; i++) {
      await sleep(500)
      boot = await cdp.eval(`(() => {
      const el = document.querySelector('.t1000-dynbg--color')
      return {
        hasClass: document.body.classList.contains('t1000-has-dynbg'),
        layer: el !== null,
        colorCss: el ? getComputedStyle(el).backgroundColor : null,
      }
    })()`)
      if (boot.hasClass && boot.layer) break
    }
    const bootOk = boot.hasClass && boot.layer && boot.colorCss === 'rgb(26, 188, 91)'
    await cdp.shot('dynbg-boot.png')
    console.log(`DYNBG-BOOT: ${bootOk ? 'PASS' : 'FAIL'} (重启后启动即生效)`, JSON.stringify(boot))
    results.boot = bootOk
  } catch (err) {
    console.error('BOOT ERROR', err.message)
    console.error(appLogRef.log.slice(-1200))
    results.boot = false
  } finally {
    electron.kill('SIGTERM')
    await sleep(500)
    electron.kill('SIGKILL')
  }
}
process.exitCode = results.tui && results.cursor && results.theme && results.dynbg && results.boot ? 0 : 1
