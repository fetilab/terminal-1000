#!/usr/bin/env node
// //SPDX-License-Identifier: GPL-3.0-or-later
// 终端 TUI / 光标 / 动态背景 / 真实窗格 无头验收（真实应用 + 真实内核 + 真实设置链）：
//   1. KERNEL-TUI    altscreen + 滚动区域（DECSTBM/SU/SD/IL/DL）→ 引擎网格必须与内核一致；
//                    alt 屏彩色内容退出后必须零残留像素（htop 色块残留回归）
//   2. CURSOR-CLICK  kitty 式拖尾：动画中拖尾 quad 在跑且与光标连成一块（不自交），
//                    收敛后像素级扫描全屏只有光标一处
//   3. DYNBG-CHAIN   动态背景：设置 → 纯色/TS 脚本 → DOM/像素断言 + 画布 alpha 联动 + 毛玻璃
//   4. DYNBG-BOOT    重启后设置持久化且启动即生效（挂载时序回归）
//   5. REAL-PANE     真实窗格端到端：应用主题深浅切换时终端配色必须保持、历史文字必须可见，
//                    背景色必须透过真实终端画布可见，模拟鼠标点击不炸
// 数据目录用 T1000_TEST_USERDATA 隔离，绝不碰用户真实数据。
import { spawn } from 'node:child_process'
import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const DESKTOP = '/home/mosfet/dsh1/terminal-1000/apps/desktop'
const CDP_PORT = 9226
const TEST_USERDATA = '/home/mosfet/dsh1/_tmp/t1000-verify-userdata'
const SHOTS = '/home/mosfet/dsh1/_shots'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let xvfbLog = ''

/**
 * 计算样式里的颜色 alpha 解析器（注入到页面里用）。
 *
 * Chromium 对 color-mix() 的结果输出的是 `color(srgb 0.91 0.92 0.95 / 0.46)`，
 * 只认 `rgba()` 的解析器会把它当成"不透明"或"解析失败 → a=0"。上一版探针
 * 正是因此把 `.term-panes` 的 46% 表面色算成 0，链路合成恒为 0 而误报 PASS ——
 * 用户实机看到的「终端还是叠加颜色」就是这么漏出去的。这里三种语法全覆盖。
 */
const ALPHA_PARSER = `
  const parseAlpha = (css) => {
    const s = String(css || '').trim()
    if (!s || s === 'transparent') return 0
    let m = s.match(/^rgba?\\(([^)]+)\\)$/)
    if (m) {
      const parts = m[1].split(/[,\\/]/).map((x) => parseFloat(x)).filter((x) => !Number.isNaN(x))
      if (parts.length >= 4) return parts[3]
      return 1
    }
    m = s.match(/^color\\([^)]*\\/\\s*([\\d.]+)\\s*\\)$/)
    if (m) return parseFloat(m[1])
    if (s.startsWith('color(')) return 1
    return 1
  }
`

/** 确保测试跑在 Xvfb 虚拟显示里——Xvfb 掉了绝不回退主屏（Electron 会连 :0 弹窗） */
async function ensureXvfb() {
  for (let i = 0; i < 10; i++) {
    try {
      const r = spawn('xdpyinfo', ['-display', ':97'], { stdio: 'ignore' })
      const ok = await new Promise((res) => r.on('exit', (c) => res(c === 0)))
      if (ok) return
    } catch {}
    // 清掉僵死 socket（Xvfb 被杀后 /tmp/.X11-unix/X97 残留会让新实例绑定失败）
    try {
      spawn('rm', ['-f', '/tmp/.X11-unix/X97'], { stdio: 'ignore' })
    } catch {}
    const xvfb = spawn('Xvfb', [':97', '-screen', '0', '1600x1000x24'])
    xvfb.stderr.on('data', (d) => (xvfbLog += d))
    await sleep(800)
  }
  throw new Error('Xvfb :97 无法启动：' + xvfbLog.slice(-200))
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
  async eval(expression, awaitPromise = false) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true })
    if (r.exceptionDetails) throw new Error('页面异常: ' + JSON.stringify(r.exceptionDetails).slice(0, 400))
    return r?.result?.value
  }
  async shot(name) {
    const s = await this.send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(join(SHOTS, name), Buffer.from(s.data, 'base64'))
  }
  /** Xvfb 无头环境里模拟真实鼠标（点击/移动），走 CDP 输入链路 */
  async mouse(type, x, y, opts = {}) {
    await this.send('Input.dispatchMouseEvent', {
      type,
      x,
      y,
      button: opts.button ?? 'left',
      clickCount: opts.clickCount ?? (type === 'mousePressed' || type === 'mouseReleased' ? 1 : undefined),
      buttons: opts.buttons ?? 0,
    })
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

/* ── 像素扫描工具：整画布找指定颜色连通块 ──
 * 注意：WebGL 画布 preserveDrawingBuffer=false，跨任务直接 drawImage 会读到
 * 空缓冲（clear 全透明后尤其如此）——必须先在**同一任务**里同步 render() */
function scanBlobsExpr(canvasExpr, rgb, { tol = 20, minArea = 40, renderExpr = `window.__kittyDemoEngine?.renderer?.render?.()` } = {}) {
  return `(() => {
    ${renderExpr}
    const glc = ${canvasExpr}
    if (!glc) return { blobs: [], missing: true }
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
      if (area >= ${minArea}) blobs.push({ x: x0, y: y0, w: x1-x0+1, h: y1-y0+1, area })
    }
    return { blobs, W, H }
  })()`
}

/** 读指定画布的背景 alpha：取非零 alpha 的众数（网格边距是清屏透明区，跳过） */
async function canvasBgAlpha(cdp, canvasExpr, renderExpr) {
  return cdp.eval(`(() => {
    ${renderExpr ?? `window.__kittyDemoEngine?.renderer?.render?.()`}
    const glc = ${canvasExpr}
    if (!glc) return -1
    const c2 = document.createElement('canvas')
    c2.width = glc.width; c2.height = glc.height
    const ctx = c2.getContext('2d')
    ctx.drawImage(glc, 0, 0)
    const img = ctx.getImageData(0, 0, c2.width, c2.height)
    const hist = new Map()
    for (let p = 0; p < c2.width*c2.height; p++) {
      const a = img.data[p*4+3]
      if (a === 0) continue
      hist.set(a, (hist.get(a) ?? 0) + 1)
    }
    let best = -1, bestN = 0
    for (const [a, n] of hist) if (n > bestN) { best = a; bestN = n }
    return best
  })()`)
}

/**
 * 画布 alpha 分布：{clear, film, opaque} 三档占比。
 *
 * 不能用「出现次数最多的非零 alpha」：终端底色透明（alpha=0）时会被跳过，
 * 而文字笔画是 255 且往往像素最多，于是"透明"被误判成"不透明"。
 */
async function canvasAlphaProfile(cdp, canvasExpr, renderExpr) {
  return cdp.eval(`(() => {
    ${renderExpr ?? `window.__kittyDemoEngine?.renderer?.render?.()`}
    const glc = ${canvasExpr}
    if (!glc) return null
    const c2 = document.createElement('canvas')
    c2.width = glc.width; c2.height = glc.height
    const ctx = c2.getContext('2d')
    ctx.drawImage(glc, 0, 0)
    const d = ctx.getImageData(0, 0, c2.width, c2.height).data
    const total = c2.width * c2.height
    let clear = 0, film = 0, opaque = 0
    for (let i = 3; i < d.length; i += 4) {
      const a = d[i]
      if (a <= 2) clear++
      else if (a >= 250) opaque++
      else film++
    }
    return { clear: +(clear / total).toFixed(4), film: +(film / total).toFixed(4), opaque: +(opaque / total).toFixed(4), w: c2.width, h: c2.height }
  })()`)
}

/* ── 探针 1：内核级 altscreen + 滚动区域 + 彩色残留 ── */
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

  // alt 屏彩色残留：再进 alt 屏铺两种唯一真彩色块（先重置滚动区域——
  // DECSTBM 在主/备屏之间共享），退出后画布上必须 0 残留像素
  //（htop/vim 退出后色块残留在主屏 = 「双光标/色块」类回归的另一个来源）
  await cdp.eval(`window.__kittyDemoEngine.write('\\x1b[?1049h\\x1b[0r\\x1b[2J\\x1b[H\\x1b[48;2;18;52;86m        \\x1b[48;2;180;60;20m        \\x1b[0m')`)
  await sleep(300)
  const inAlt = await cdp.eval(scanBlobsExpr(`document.querySelector('#kitty-demo canvas')`, [18, 52, 86], { tol: 8, minArea: 30 }))
  await cdp.eval(`window.__kittyDemoEngine.write('\\x1b[?1049l')`)
  await sleep(500)
  const afterExit = await cdp.eval(scanBlobsExpr(`document.querySelector('#kitty-demo canvas')`, [18, 52, 86], { tol: 8, minArea: 30 }))
  const residueOk = inAlt.blobs.length >= 1 && afterExit.blobs.length === 0
  await cdp.shot('tui-altscreen.png')
  await cdp.shot('tui-residue-check.png')
  console.log(`KERNEL-TUI: ${baseOk && suOk && sdOk && dlOk && restoreOk && residueOk ? 'PASS' : 'FAIL'} (铺屏=${baseOk} SU=${suOk} SD=${sdOk} DL=${dlOk} 出alt恢复=${restoreOk} 彩色残留=${residueOk})`)
  if (!baseOk) console.log('  base =', JSON.stringify(s1))
  if (!suOk) console.log('  su   =', JSON.stringify(s2))
  if (!sdOk) console.log('  sd   =', JSON.stringify(s3))
  if (!dlOk) console.log('  dl   =', JSON.stringify(s4))
  if (!restoreOk) console.log('  rst  =', JSON.stringify(s5))
  if (!residueOk) console.log('  residue inAlt =', JSON.stringify(inAlt.blobs), 'afterExit =', JSON.stringify(afterExit.blobs))
  return baseOk && suOk && sdOk && dlOk && restoreOk && residueOk
}

/* ── 探针 2：光标像素级扫描（kitty 式拖尾动画 + 收敛后单光标） ── */
async function probeCursorClick(cdp) {
  // 光标换成 block（默认设置是细条 beam，面积太小不好做像素断言），
  // 并关掉闪烁——blink 灭相时光标不画，像素断言会随机翻车
  await cdp.eval(`window.__kittyDemoEngine.applySettings({ ...window.__kittyDemoEngine.options, cursorStyle: 'block', cursorBlink: false })`)
  await sleep(200)
  const dims = await cdp.eval(`(() => ({
    cellW: window.__kittyDemoEngine.renderer.atlas.cellW,
    cellH: window.__kittyDemoEngine.renderer.atlas.cellH,
  }))()`)
  // 光标从当前位跳到 (12,50)：距离远超 threshold 2，拖尾必然启动
  await cdp.eval(`window.__kittyDemoEngine.write('\\x1b[12;50H')`)
  await sleep(40)
  const mid = await cdp.eval(`(() => {
    const eng = window.__kittyDemoEngine
    const d = eng.trailDebug()
    const c = eng.renderer.theme.cursor
    // 四边形自交检测（叉积符号）：0-1 边与 3-2 边、0-3 边与 1-2 边都不许相交
    const ori = (a, b, p) => (b[0]-a[0])*(p[1]-a[1]) - (b[1]-a[1])*(p[0]-a[0])
    const seg = (a, b, c, d) => {
      const d1 = ori(a, b, c), d2 = ori(a, b, d), d3 = ori(c, d, a), d4 = ori(c, d, b)
      return ((d1>0) !== (d2>0)) && ((d3>0) !== (d4>0))
    }
    const P = d.cornerX.map((x, i) => [x, d.cornerY[i]])
    const crossed = seg(P[0], P[1], P[3], P[2]) || seg(P[0], P[3], P[1], P[2])
    return {
      needsRender: d.needsRender, opacity: d.opacity,
      cursorRect: d.cursorRect, corners: P, crossed, cursorQuads: d.cursorQuads,
      cursorRgb: [Math.round(c.r*255), Math.round(c.g*255), Math.round(c.b*255)],
    }
  })()`)
  await cdp.shot('cursor-mid-1.png')
  await sleep(140)
  await cdp.shot('cursor-mid-2.png')

  // 动画中断言：拖尾在跑、角落后、四边形不许自交（蝶形结 = 「两个光标」的来源）、
  // 光标本体同时在真实位置绘制（kitty 原版语义）
  const midOk = mid.needsRender === true && mid.opacity > 0 && mid.cursorRect !== null && mid.crossed === false && mid.cursorQuads >= 1
  if (!midOk) console.log('  mid =', JSON.stringify(mid))

  // 动画中整屏扫描：光标色（拖尾拉丝与光标同色）只能连成**一个**连通块；
  // 断成两块 = 「两个光标」回归
  const midScan = await cdp.eval(scanBlobsExpr(`document.querySelector('#kitty-demo canvas')`, mid.cursorRgb, {
    tol: 20,
    minArea: Math.round(0.4 * dims.cellW * dims.cellH),
  }))
  const midBlobOk = midScan.blobs.length <= 1
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
  console.log(`CURSOR-CLICK: ${midOk && midBlobOk && convOk ? 'PASS' : 'FAIL'} (动画中拖尾=${midOk} 拖尾连续=${midBlobOk} 收敛单光标=${convOk})`)
  return midOk && midBlobOk && convOk
}

/* ── 探针 3+4：动态背景（链路 + alpha 联动 + 毛玻璃 + 重启持久化） ── */
async function probeDynbgChain(cdp) {
  // 与设置 UI 完全同路径（SettingsView.update：IPC set → 全量文档 → applyAppearance）
  const set = (path, value) =>
    cdp.eval(`window.__t1000.setAppearance(${JSON.stringify(path)}, ${JSON.stringify(value)})`, true)
  const dom = () =>
    cdp.eval(`(() => {
      const alphaOf = (css) => {
        const t = String(css || '').trim()
        if (!t || t === 'transparent') return 0
        let m = t.match(/^rgba?\\(([^)]+)\\)$/)
        if (m) {
          const parts = m[1].split(/[,\\/]/).map((x) => parseFloat(x)).filter((x) => !Number.isNaN(x))
          return parts.length >= 4 ? parts[3] : 1
        }
        m = t.match(/\\/\\s*([\\d.]+)\\s*\\)$/)
        if (m) return parseFloat(m[1])
        return 1
      }
      const el = document.querySelector('.t1000-dynbg')
      const colorEl = document.querySelector('.t1000-dynbg--color')
      const pick = (sel) => {
        const e = document.querySelector(sel)
        return e ? +alphaOf(getComputedStyle(e).backgroundColor).toFixed(3) : null
      }
      return {
        hasClass: document.body.classList.contains('t1000-has-dynbg'),
        hasBg: document.body.classList.contains('t1000-has-bg'),
        hasMedia: document.body.classList.contains('t1000-has-media'),
        layer: el !== null,
        colorEl: colorEl !== null,
        colorCss: colorEl ? getComputedStyle(colorEl).backgroundColor : null,
        opacityCss: el ? getComputedStyle(el).opacity : null,
        canvas: el?.querySelector('canvas') !== null,
        surfaceAlphaCss: document.documentElement.style.getPropertyValue('--t1000-surface-alpha'),
        contentAlpha: pick('.content'),
        railAlpha: pick('.rail'),
        menuAlpha: pick('.ctxmenu'),
        scrimOpacity: parseFloat(getComputedStyle(document.body, '::after').opacity) || 0,
      }
    })()`)

  const near = (a, b, tol = 0.015) => Math.abs(a - b) <= tol

  // ① 纯色背景 + 面板/侧栏 50%：变量与实测必须一致
  await set('app.appearance.backgroundOpacity', 1)
  await set('app.appearance.panelOpacity', 0.5)
  await set('app.appearance.sidebarOpacity', 0.5)
  await set('app.appearance.backgroundColor', '#c0392b')
  await set('app.appearance.backgroundType', 'color')
  await sleep(450)
  const c1 = await dom()
  const colorOk =
    c1.hasClass && c1.hasMedia && c1.layer && c1.colorEl && c1.colorCss === 'rgb(192, 57, 43)' &&
    parseFloat(c1.opacityCss) === 1 &&
    c1.surfaceAlphaCss.trim() === '50.0%' &&
    near(c1.contentAlpha, 0.5) && near(c1.railAlpha, 0.5)
  await cdp.shot('dynbg-color.png')

  // ② 终端画布：有媒体时 alpha 必须是 0（完全透出 .content 的面板色），
  //    无媒体时实色。演示引擎直接设 settings.backgroundOpacity 验证清屏通路。
  await cdp.eval(`window.__kittyDemoEngine.applySettings({ ...window.__kittyDemoEngine.options, backgroundOpacity: 0 })`)
  await sleep(200)
  const profOn = await canvasAlphaProfile(cdp, `document.querySelector('#kitty-demo canvas')`)
  const glass = await cdp.eval(`(() => {
    const el = document.querySelector('#kitty-demo .kitty-surface')
    return el ? (getComputedStyle(el).backdropFilter || getComputedStyle(el).webkitBackdropFilter || 'none') : null
  })()`)
  // 透明档：底色必须完全透明（film≈0），只剩字形的不透明像素
  const alphaOnOk = profOn && profOn.film < 0.02 && profOn.opaque < 0.4
  // 终端区域**不允许**有第二层模糊：模糊只来自背景层 --t1000-bg-blur
  const glassOk = glass === 'none'
  await cdp.eval(`window.__kittyDemoEngine.applySettings({ ...window.__kittyDemoEngine.options, backgroundOpacity: 1 })`)
  await sleep(200)
  const profOff = await canvasAlphaProfile(cdp, `document.querySelector('#kitty-demo canvas')`)
  const alphaOffOk = profOff && profOff.opaque > 0.85
  console.log(`  canvas alpha: 透明档=${JSON.stringify(profOn)} 终端二次模糊=${glass} (必须 none) 实色档=${JSON.stringify(profOff)}`)

  // ③ 图片类型：静态层 + has-bg；媒体层自身不透明度 = backgroundOpacity
  await set('app.appearance.backgroundType', 'image')
  await set('app.appearance.backgroundImage', '/home/mosfet/dsh1/_tmp/t1000-test-bg.png')
  await sleep(450)
  const cImg = await cdp.eval(`(() => {
    const root = document.documentElement
    const v = root.style.getPropertyValue('--t1000-bg-image')
    return {
      hasBgClass: document.body.classList.contains('t1000-has-bg'),
      cssVar: v.startsWith('url("file:///home/mosfet/dsh1/_tmp/t1000-test-bg.png")'),
      imgOpacity: parseFloat(root.style.getPropertyValue('--t1000-bg-image-opacity')),
      dynGone: document.querySelector('.t1000-dynbg') === null,
    }
  })()`)
  const imageOk = cImg.hasBgClass && cImg.cssVar && cImg.dynGone && cImg.imgOpacity === 1
  await cdp.shot('dynbg-image.png')

  // ④ 面板 80%：.content 与 .rail 实测必须都是 80%（终端画布透出的就是这层）
  await set('app.appearance.panelOpacity', 0.8)
  await set('app.appearance.sidebarOpacity', 0.8)
  await sleep(450)
  const cDef = await dom()
  const defaultVisOk = near(cDef.contentAlpha, 0.8) && near(cDef.railAlpha, 0.8) && cDef.hasMedia
  await cdp.shot('dynbg-default-vis.png')

  // ⑤ 背景不透明度推到 0：媒体层整体隐藏（has-* 全撤、遮罩归零、图片 none）
  await set('app.appearance.backgroundOpacity', 0)
  await sleep(450)
  const cZero = await cdp.eval(`(() => {
    const root = document.documentElement
    return {
      hasBgClass: document.body.classList.contains('t1000-has-bg'),
      hasMediaClass: document.body.classList.contains('t1000-has-media'),
      imgNone: root.style.getPropertyValue('--t1000-bg-image') === 'none',
      scrimOpacity: parseFloat(getComputedStyle(document.body, '::after').opacity) || 0,
    }
  })()`)
  const zeroHiddenOk = !cZero.hasBgClass && !cZero.hasMediaClass && cZero.imgNone && cZero.scrimOpacity < 0.01

  // ⑥ 背景模糊：变量 + body::before 实际吃到 blur()
  await set('app.appearance.backgroundOpacity', 1)
  await set('app.appearance.backgroundImage', '/home/mosfet/dsh1/_tmp/t1000-test-bg.png')
  await set('app.appearance.backgroundBlur', 20)
  await sleep(450)
  const cBlur = await cdp.eval(`(() => {
    const root = document.documentElement
    const filter = getComputedStyle(document.body, '::before').filter
    return { cssVar: root.style.getPropertyValue('--t1000-bg-blur'), filter }
  })()`)
  const blurOk = cBlur.cssVar === '20px' && String(cBlur.filter).includes('blur(20px)')
  await cdp.shot('dynbg-blur.png')

  // ⑦ 浮层分组：menuOpacity 只影响菜单与浮层（默认实色，调低才透）
  const overlayProbe = await cdp.eval(`(() => {
    const mk = (cls) => { const d = document.createElement('div'); d.className = cls; document.body.appendChild(d); return d }
    const a = mk('ctxmenu'); const b = mk('completion')
    return { exists: true }
  })()`)
  await set('app.appearance.menuOpacity', 0.6)
  await sleep(450)
  const menuAlphaLow = await cdp.eval(`(() => {
    const el = document.querySelector('.ctxmenu')
    const bg = getComputedStyle(el).backgroundColor
    const m = bg.match(/\\/\\s*([\\d.]+)\\s*\\)$/)
    return m ? parseFloat(m[1]) : 1
  })()`)
  await set('app.appearance.menuOpacity', 1)
  await sleep(400)
  const overlaySolidOk = overlayProbe.exists && near(menuAlphaLow, 0.6, 0.05)

  // 恢复给后续探针用
  await set('app.appearance.backgroundBlur', 5)
  await set('app.appearance.backgroundOpacity', 1)
  await set('app.appearance.backgroundImage', '')

  // ⑧ 脚本背景：真的在画（非黑像素）
  await set('app.appearance.backgroundType', 'script')
  await set('app.appearance.backgroundScript', 'matrix')
  await sleep(1200)
  const c2 = await dom()
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

  // ⑨ 关闭：所有动态层与 media 类撤掉；面板 alpha 不受背景开关影响
  await set('app.appearance.backgroundType', 'none')
  await sleep(450)
  const c3 = await dom()
  const offOk = !c3.hasClass && !c3.layer && !c3.hasMedia && near(c3.contentAlpha, 0.8)

  console.log(`DYNBG-CHAIN: ${colorOk && alphaOnOk && glassOk && alphaOffOk && imageOk && defaultVisOk && zeroHiddenOk && blurOk && overlaySolidOk && scriptOk && offOk ? 'PASS' : 'FAIL'} (纯色分组联动=${colorOk} 画布透明/实色=${alphaOnOk && alphaOffOk} 无二次模糊=${glassOk} 图片=${imageOk} 面板80%=${defaultVisOk} 不透明度0隐藏=${zeroHiddenOk} 背景模糊=${blurOk} 浮层分组=${overlaySolidOk} 脚本=${scriptOk} 关闭=${offOk})`)
  console.log('  color dom =', JSON.stringify(c1))
  console.log('  image dom =', JSON.stringify(cImg), 'zero =', JSON.stringify(cZero))
  console.log('  script dom =', JSON.stringify(c2), 'pixels =', JSON.stringify(pixels))
  console.log('  off dom =', JSON.stringify(c3), 'menuAlphaLow =', menuAlphaLow)
  return colorOk && alphaOnOk && glassOk && alphaOffOk && imageOk && defaultVisOk && zeroHiddenOk && blurOk && overlaySolidOk && scriptOk && offOk
}

/* ── 探针 5：真实窗格端到端（主题保持 + 背景可见 + 模拟鼠标） ── */
async function probeRealPane(cdp) {
  // 打开真实窗格：demoSession 造一个 ready 状态的 tab，TerminalPane 走完整创建链路
  //（kitty 引擎 + WebGL 渲染器 + 设置/主题/外观全部真实 effect），与 demo 引擎无关
  await cdp.eval(`window.__t1000.demoSession()`)
  await sleep(500)
  let engineReady = false
  for (let i = 0; i < 24 && !engineReady; i++) {
    engineReady = (await cdp.eval('typeof window.__t1000PaneEngine?.write === "function"')) === true
    if (!engineReady) await sleep(300)
  }
  if (!engineReady) {
    console.log('REAL-PANE: FAIL (真实窗格引擎未创建)')
    return false
  }
  const paneCanvas = `document.querySelector('.term-pane .kitty-canvas')`
  const paneRender = `window.__t1000PaneEngine?.renderer?.render?.()`

  // 先强制深色作为基线（测试 userdata 启动时可能直接落在 light/system）
  await cdp.eval(`window.__t1000.setThemeMode('dark')`)
  await cdp.eval(`window.__t1000.setAppearance('app.appearance.backgroundType', 'none')`)
  await cdp.eval(`window.__t1000.setAppearance('app.appearance.panelOpacity', 0.72)`)
  await cdp.eval(`window.__t1000.setAppearance('app.appearance.sidebarOpacity', 0.72)`)
  await sleep(700)

  // 灌「历史」：调色板色 + 默认前景混排
  await cdp.eval(`window.__t1000PaneEngine.write('\\x1b[32mroot@pane:~$\\x1b[0m history-green-1\\r\\n\\x1b[34mroot@pane:~$\\x1b[0m history-blue-2\\r\\n\\x1b[0mplain-default-fg\\r\\n')`)
  await sleep(600)

  /** 画布上指定颜色的像素计数（不分连通块——字符笔画彼此独立，blob 面积会漏） */
  const countColor = (rgb) =>
    cdp.eval(`(() => {
      ${paneRender}
      const glc = ${paneCanvas}
      if (!glc) return -1
      const c2 = document.createElement('canvas')
      c2.width = glc.width; c2.height = glc.height
      const ctx = c2.getContext('2d')
      ctx.drawImage(glc, 0, 0)
      const img = ctx.getImageData(0, 0, c2.width, c2.height)
      const [cr, cg, cb] = ${JSON.stringify(rgb)}
      let n = 0
      for (let p = 0; p < c2.width*c2.height; p++) {
        const i = p*4
        if (Math.abs(img.data[i]-cr)<=45 && Math.abs(img.data[i+1]-cg)<=45 && Math.abs(img.data[i+2]-cb)<=45) n++
      }
      return n
    })()`)

  const before = await cdp.eval(`(() => {
    const eng = window.__t1000PaneEngine
    const t = eng.renderer.theme
    const hex = (c) => [Math.round(c.r*255), Math.round(c.g*255), Math.round(c.b*255)]
    return { bg: hex(t.bg), green: hex(t.palette[2]), resolved: eng.opts.resolvedTheme }
  })()`)
  const greenPxBefore = await countColor(before.green)
  await cdp.shot('pane-before-theme.png')

  // 切应用主题到浅色（store.applyTheme 真实路径）：终端配色跟随（深色=Mocha →
  // 明亮=Latte「稍微改一下」），历史文字必须原样可见（「切浅色吞字」回归）
  await cdp.eval(`window.__t1000.setThemeMode('light')`)
  await sleep(800)
  const after = await cdp.eval(`(() => {
    const eng = window.__t1000PaneEngine
    const t = eng.renderer.theme
    const hex = (c) => [Math.round(c.r*255), Math.round(c.g*255), Math.round(c.b*255)]
    const rows = eng.viewportText().split('\\n').map(s=>s.trimEnd()).filter(Boolean)
    return {
      bg: hex(t.bg), green: hex(t.palette[2]), resolved: eng.opts.resolvedTheme,
      appTheme: document.documentElement.dataset.theme,
      historyKept: rows.some(r => r.includes('history-green-1')) && rows.some(r => r.includes('plain-default-fg')),
    }
  })()`)
  await cdp.shot('pane-after-theme.png')
  const greenPxAfter = await countColor(after.green)
  // 明亮模式：配色切到浅色系列（bg 变亮、绿变 Latte），文字像素可见
  const themeKeepOk =
    after.appTheme === 'light' &&
    after.bg[0] > 200 && after.bg[1] > 200 &&
    JSON.stringify(after.green) !== JSON.stringify(before.green) &&
    after.historyKept
  // 明亮模式：配色切到浅色系列（bg 变亮、绿变 Latte），文字像素可见。
  // 阈值 60：一行提示符约 130~170 像素的绿笔画，取下限防抖动。
  const textVisibleOk = greenPxBefore > 60 && greenPxAfter > 60

  // 背景色透过真实窗格：画布 alpha ≈0.3 + **DOM 合成等价验证**。
  // 离屏渲染的 Page.captureScreenshot 不合成 fixed 全视口层（注入实验证实：
  // body/#root 级 fixed 红蓝层都 0 像素），合成像素无法在无头下取证；
  // 改为验证合成的全部要素：红层满视口且在内容之下 + 画布到红层之间
  // 每一层都半透明 —— 这些要素齐备时，真实（有头）合成必然透出红色。
  await cdp.eval(`window.__t1000.setAppearance('app.appearance.backgroundOpacity', 1)`)
  await cdp.eval(`window.__t1000.setAppearance('app.appearance.panelOpacity', 0.55)`)
  await cdp.eval(`window.__t1000.setAppearance('app.appearance.sidebarOpacity', 0.55)`)
  await cdp.eval(`window.__t1000.setAppearance('app.appearance.backgroundColor', '#c0392b')`)
  await cdp.eval(`window.__t1000.setAppearance('app.appearance.backgroundType', 'color')`)
  await sleep(900)
  const paneAlpha = await canvasBgAlpha(cdp, paneCanvas, paneRender)
  // 画布"薄膜"像素占比：可见度拉满时终端画布必须**完全没有半透明底色**
  // （等同 kitty background_opacity=0），只剩字形像素。少量 2~200 的像素
  // 来自文字抗锯齿边缘，正常应远低于 1%。
  const film = await cdp.eval(`(() => {
    ${paneRender}
    const glc = document.querySelector('.term-pane .kitty-canvas')
    if (!glc) return { ratio: 1, total: 0 }
    const c2 = document.createElement('canvas')
    c2.width = glc.width; c2.height = glc.height
    const ctx = c2.getContext('2d')
    ctx.drawImage(glc, 0, 0)
    const d = ctx.getImageData(0, 0, c2.width, c2.height).data
    let film = 0
    const total = c2.width * c2.height
    for (let i = 3; i < d.length; i += 4) if (d[i] > 2 && d[i] < 200) film++
    return { ratio: +(film / total).toFixed(5), total, film }
  })()`)
  const composite = await cdp.eval(`(() => {
    ${ALPHA_PARSER}
    const canvas = document.querySelector('.term-pane .kitty-canvas')
    const dyn = document.querySelector('.t1000-dynbg')
    if (!canvas || !dyn) return { ok: false, why: 'missing elements' }
    const dr = dyn.getBoundingClientRect()
    const coversViewport = dr.width >= window.innerWidth * 0.95 && dr.height >= window.innerHeight * 0.95
    const colorEl = dyn.querySelector('.t1000-dynbg--color')
    const redSet = colorEl && getComputedStyle(colorEl).backgroundColor === 'rgb(192, 57, 43)'
    const dynOpacity = parseFloat(getComputedStyle(dyn).opacity)
    // 画布 → body 之间的**累积合成 alpha**：1-∏(1-aᵢ)。
    // 上一版只查单层 a≥0.999 的实色层，且解析器不认 color(srgb …/a)，
    // 漏掉了「.term-panes 46% + 画布 + …」的级联 —— 终端叠加颜色的真正根因。
    // 媒体背景激活时这些中间层必须全部透明（合成 ≈0），画布 alpha 直接对背景层。
    // 只统计 canvas → .content 之间的层：这些**必须全透明**（一层负责底色）。
    // .content 自己就是那唯一一层，它的 alpha 必须等于 panelOpacity。
    const contentEl = document.querySelector('.content')
    const chainLayers = []
    let p = canvas.parentElement
    while (p) {
      if (contentEl && p === contentEl) break
      const cs = getComputedStyle(p)
      const a = parseAlpha(cs.backgroundColor) * (parseFloat(cs.opacity) || 1)
      if (a > 0.0005) chainLayers.push({ el: p.tagName + '.' + String(p.className || '').split(' ')[0], a: +a.toFixed(4), bg: cs.backgroundColor })
      if (p === document.body) break
      p = p.parentElement
    }
    const contentCs = contentEl ? getComputedStyle(contentEl) : null
    const contentAlpha = contentCs
      ? +(parseAlpha(contentCs.backgroundColor) * (parseFloat(contentCs.opacity) || 1)).toFixed(4)
      : 1
    const opaqueLayers = chainLayers.filter(l => l.a >= 0.999)
    let chainComposite = 1
    for (const l of chainLayers) chainComposite *= (1 - l.a)
    chainComposite = 1 - chainComposite
    // DOCUMENT_POSITION_FOLLOWING：canvas 在 dyn 之后 → dyn 在画布之前绘制（在下层）
    const dynBeforeContent = !!(dyn.compareDocumentPosition(canvas) & Node.DOCUMENT_POSITION_FOLLOWING)
    // 终端区域不允许第二层模糊：模糊只由背景层 --t1000-bg-blur 提供（全屏统一）。
    // 曾有 backdrop-filter: blur(14px)，导致中间糊成白雾、两侧清晰，且边缘被切。
    const ks = document.querySelector('.kitty-surface')
    const ksCs = ks ? getComputedStyle(ks) : null
    // 不只 .kitty-surface：终端子树里任何一层都不许有自己的模糊/滤镜，
    // 否则「中间糊、两侧清晰」的割裂会以别的形式复现。
    const paneEl = document.querySelector('.term-pane')
    let blurred = []
    if (paneEl) {
      for (const el of [paneEl, ...paneEl.querySelectorAll('*')]) {
        const cs = getComputedStyle(el)
        const bd = cs.backdropFilter || 'none'
        const ft = cs.filter || 'none'
        if (bd !== 'none' || ft !== 'none') {
          blurred.push(el.tagName.toLowerCase() + '.' + String(el.className || '').split(' ')[0] + ':' + (bd !== 'none' ? bd : ft))
        }
      }
    }
    const noSecondBlur = (!ksCs || (ksCs.backdropFilter || 'none') === 'none') && blurred.length === 0
    // .kitty-surface 必须严格贴合 .term-pane__surface：absolute;inset:0 一旦
    // 找不到定位祖先，就会以 .term-pane 为包含块、越界盖住底部状态栏。
    const sf = document.querySelector('.term-pane__surface')
    let surfaceFits = false
    if (ks && sf) {
      const kr = ks.getBoundingClientRect()
      const sr = sf.getBoundingClientRect()
      // inset:0 填充包含块的 padding box：底边应与 surface 底边重合（±1px），
      // 高度等于 clientHeight（含 padding），且绝不能越过状态栏。
      surfaceFits = Math.abs(kr.bottom - sr.bottom) <= 1.5 &&
        Math.abs(kr.height - sf.clientHeight) <= 1.5 &&
        kr.top >= sr.top - 0.5
    }
    return { coversViewport, redSet, dynOpacity, opaqueLayers, chainComposite: +chainComposite.toFixed(4), dynBeforeContent, noSecondBlur, surfaceFits, blurred, contentAlpha }
  })()`)
  const bgVisibleOk =
    // 终端画布上不能有任何半透明底色薄膜；中间容器累积合成必须≈0
    film.ratio < 0.01 &&
    composite.coversViewport &&
    composite.redSet &&
    composite.dynOpacity > 0.95 &&
    composite.opaqueLayers.length === 0 &&
    composite.chainComposite < 0.02 &&
    composite.dynBeforeContent &&
    composite.noSecondBlur &&
    composite.surfaceFits &&
    Math.abs(composite.contentAlpha - 0.55) <= 0.02
  await cdp.shot('pane-bg-red.png')

  // 模拟鼠标：真实点击终端区域（按下/抬起/移动），引擎必须存活且无异常
  const canvasBox = await cdp.eval(`(() => {
    const el = document.querySelector('.term-pane .kitty-canvas')
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: r.left, y: r.top, w: r.width, h: r.height }
  })()`)
  let mouseOk = false
  if (canvasBox && canvasBox.w > 100) {
    const cx = Math.round(canvasBox.x + canvasBox.w / 2)
    const cy = Math.round(canvasBox.y + canvasBox.h / 2)
    try {
      await cdp.mouse('mouseMoved', cx, cy)
      await cdp.mouse('mousePressed', cx, cy, { button: 'left', buttons: 1 })
      await cdp.mouse('mouseMoved', cx - 60, cy + 20, { buttons: 1 })
      await cdp.mouse('mouseReleased', cx - 60, cy + 20)
      await cdp.mouse('mouseMoved', cx + 80, cy - 30)
      await sleep(300)
      const alive = await cdp.eval(`Boolean(window.__t1000PaneEngine?.meta?.cols)`)
      mouseOk = alive === true
    } catch (e) {
      mouseOk = false
    }
  }
  await cdp.shot('pane-after-mouse.png')

  // 清理：主题回深色、背景关掉
  await cdp.eval(`window.__t1000.setThemeMode('dark')`)
  await cdp.eval(`window.__t1000.setAppearance('app.appearance.backgroundType', 'none')`)
  await cdp.eval(`window.__t1000.setAppearance('app.appearance.panelOpacity', 0.72)`)
  await cdp.eval(`window.__t1000.setAppearance('app.appearance.sidebarOpacity', 0.72)`)
  await sleep(300)

  console.log(`REAL-PANE: ${themeKeepOk && textVisibleOk && bgVisibleOk && mouseOk ? 'PASS' : 'FAIL'} (配色跟随=${themeKeepOk} 历史文字可见=${textVisibleOk} 背景透出=${bgVisibleOk} 无二次模糊=${composite.noSecondBlur} 画布贴合=${composite.surfaceFits} 模拟鼠标=${mouseOk})`)
  console.log('  before =', JSON.stringify(before), 'greenPxBefore =', greenPxBefore)
  console.log('  after  =', JSON.stringify(after), 'greenPxAfter =', greenPxAfter)
  console.log('  paneAlpha =', paneAlpha, 'film =', JSON.stringify(film), 'composite =', JSON.stringify(composite), 'greenPxBefore =', greenPxBefore, 'greenPxAfter =', greenPxAfter)
  return themeKeepOk && textVisibleOk && bgVisibleOk && mouseOk
}

/* ── 主流程 ── */
await ensureXvfb()
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

// 第三段：真实窗格端到端（独立实例，不建 demo 引擎避免画布混淆）
{
  const electron = launchApp()
  electron.stdout.on('data', (d) => (appLogRef.log += d))
  electron.stderr.on('data', (d) => (appLogRef.log += d))
  try {
    const cdp = await connectWithDemo(electron, appLogRef, { withDemo: false })
    results.realPane = await probeRealPane(cdp)
  } catch (err) {
    console.error('REAL-PANE ERROR', err.message)
    console.error(appLogRef.log.slice(-1200))
    results.realPane = false
  } finally {
    electron.kill('SIGTERM')
    await sleep(500)
    electron.kill('SIGKILL')
  }
}
process.exitCode = results.tui && results.cursor && results.dynbg && results.boot && results.realPane ? 0 : 1
