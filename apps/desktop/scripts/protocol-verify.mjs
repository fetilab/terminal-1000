#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 协议矩阵验收（六种协议 + 本地终端，**全走真实链路**）。
 *
 * 为什么要这个脚本：单测覆盖的是各服务模块内部的逻辑，但"用户点连接之后
 * 到底通不通"是跨层的（渲染层 invoke → IPC 路由 → 协议服务 → 真实 socket）。
 * 这里把整条链路跑一遍，并给出一张可核对的矩阵表。
 *
 * 五种真实对端（全部只监听 127.0.0.1，不联网）：
 *  - SSH / SFTP / direct-tcpip：`services/sftp/test-sftp-server.ts` 里的
 *    ssh2 真实服务端（真实 SSH 协议、真实 SFTP 子系统、真实 exec/shell/转发）
 *  - VNC：`test-fixtures/rfb-server-fixture.ts`（真实 RFB 握手 + 帧缓冲更新）
 *  - Telnet：本文件内的极简 telnetd（真实 IAC 协商 + 登录提示符）
 *  - RDP：`test-fixtures/fake-freerdp`（真实子进程 + 真实 argv；因为 RDP 客户端
 *    是外部的 FreeRDP，本仓库只负责探测/参数映射/生命周期）
 *  - 端口转发的目标：本文件内的 HTTP 服务器，隧道打通后用 fetch 真穿一次
 *
 * 用法：
 *   node --experimental-transform-types scripts/protocol-verify.mjs
 *   T1000_KEEP=1 node ... scripts/protocol-verify.mjs   # 失败时留下 userdata 现场
 *
 * 依赖已构建的主进程产物（apps/desktop/out）——脚本用 `electron .` 起的是
 * 构建后的应用，不是 dev server。所以先 `npx electron-vite build`。
 */

import { register } from 'node:module'
import { spawn } from 'node:child_process'
import { createServer as createHttpServer } from 'node:http'
import { createServer as createTcpServer } from 'node:net'
import { mkdirSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

register('./esm-ts-loader.mjs', import.meta.url)

const HERE = dirname(fileURLToPath(import.meta.url))
const DESKTOP = join(HERE, '..')
const CDP_PORT = Number(process.env['T1000_CDP'] ?? 9263)
const DISPLAY = process.env['T1000_DISPLAY'] ?? ':96'
const USERDATA = process.env['T1000_UD'] ?? '/home/mosfet/dsh1/_tmp/ud-proto'
const KEEP = process.env['T1000_KEEP'] === '1'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── 结果记录 ────────────────────────────────────────────────────────────
const rows = []
let failed = 0
function record(name, ok, detail) {
  rows.push({ name, ok, detail })
  if (!ok) failed += 1
  console.log(`  ${ok ? '\u2713' : '\u2717'} ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}
function section(title) {
  console.log(`\n${title}`)
}

// ── 服务器 ──────────────────────────────────────────────────────────────

/** 端口转发目标：一个只回答固定字符串的 HTTP 服务 */
async function startHttpTarget() {
  const server = createHttpServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end(`TUNNEL-OK ${req.url ?? '/'}`)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  return {
    port: typeof address === 'object' && address !== null ? address.port : 0,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
}

/**
 * 极简 telnetd：真实 IAC 协商 + `login:` / `Password:` 提示符 + 登录后的 shell 回显。
 *
 * 只做自动登录验收需要的那部分：
 *  - 协商字符模式与回显（WILL ECHO / WILL SGA），这与真实网络设备的首包一致；
 *  - 收到行以后记录到 `received`，供断言"凭据真的发到了设备"；
 *  - 登录成功后发一个提示符，后续输入原样回显（证明写通道通）。
 */
async function startTelnetMock() {
  const IAC = 255
  const WILL = 251
  const DO = 253
  const ECHO = 1
  const SGA = 3
  const NAWS = 31

  const state = { received: [], loggedIn: false, echo: '' }

  const server = createTcpServer((socket) => {
    socket.write(Buffer.from([IAC, WILL, ECHO, IAC, WILL, SGA, IAC, DO, NAWS, IAC, DO, SGA]))
    socket.write('OpenWrt 23.05 (e2e mock)\r\nlogin: ')

    let line = ''
    let stage = 'user'
    // IAC 状态机：只按"3 字节一组"跳是不够的 —— 子协商（IAC SB … IAC SE）
    // 是变长的，里面还可能出现 0xFF。用状态机剥才干净。
    let iac = 0 // 0=普通 1=收到 IAC 2=选项命令（WILL/WONT/DO/DONT） 3=SB 内 4=SB 内收到 IAC
    socket.on('data', (chunk) => {
      const plain = []
      for (const byte of chunk) {
        if (iac === 1) {
          if (byte === 250) iac = 3 // SB
          else if (byte === 251 || byte === 252 || byte === 253 || byte === 254) iac = 2
          else if (byte === 255) {
            plain.push(byte === 255 ? 0xff : byte)
            iac = 0
          } else iac = 0
          continue
        }
        if (iac === 2) {
          iac = 0
          continue
        }
        if (iac === 3) {
          if (byte === 255) iac = 4
          continue
        }
        if (iac === 4) {
          iac = byte === 240 ? 0 : 3 // IAC SE 结束子协商
          continue
        }
        if (byte === 255) {
          iac = 1
          continue
        }
        plain.push(byte)
      }
      const text = Buffer.from(plain).toString('utf8')
      if (text === '') return
      state.received.push(text)
      for (const ch of text) {
        if (ch === '\r' || ch === '\n') {
          if (line === '') continue
          if (stage === 'user') {
            state.user = line
            stage = 'pass'
            socket.write('\r\nPassword: ')
          } else if (stage === 'pass') {
            state.password = line
            stage = 'shell'
            state.loggedIn = true
            socket.write('\r\nBusyBox v1.36.1\r\nroot@OpenWrt:~# ')
          } else {
            // shell 阶段：回显收到的命令并给出结果
            state.echo += line
            if (line.includes('TELNET-OK')) {
              socket.write(`\r\nTELNET-OK\r\nroot@OpenWrt:~# `)
            } else {
              socket.write(`\r\nroot@OpenWrt:~# `)
            }
          }
          line = ''
        } else {
          line += ch
        }
      }
    })
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  return {
    port: typeof address === 'object' && address !== null ? address.port : 0,
    state,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
}

// ── Xvfb ────────────────────────────────────────────────────────────────
async function ensureXvfb() {
  for (let i = 0; i < 10; i += 1) {
    const probe = spawn('xdpyinfo', ['-display', DISPLAY], { stdio: 'ignore' })
    const ok = await new Promise((resolve) => probe.on('exit', (code) => resolve(code === 0)))
    if (ok) return
    spawn('Xvfb', [DISPLAY, '-screen', '0', '1600x1000x24'], { stdio: 'ignore' })
    await sleep(900)
  }
  throw new Error(`Xvfb ${DISPLAY} 起不来`)
}

// ── CDP ─────────────────────────────────────────────────────────────────
class Cdp {
  static async connect(url) {
    const c = new Cdp()
    c.ws = new WebSocket(url)
    await new Promise((resolve, reject) => {
      c.ws.addEventListener('open', resolve, { once: true })
      c.ws.addEventListener('error', reject, { once: true })
    })
    c.ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data)
      const p = c.pending.get(m.id)
      if (!p) return
      c.pending.delete(m.id)
      if (m.error) p.reject(new Error(m.error.message))
      else p.resolve(m.result)
    })
    return c
  }

  ws = null
  id = 0
  pending = new Map()

  send(method, params = {}) {
    const id = (this.id += 1)
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
      setTimeout(() => {
        if (!this.pending.has(id)) return
        this.pending.delete(id)
        reject(new Error(`${method} 超时`))
      }, 40000)
    })
  }

  async eval(expression, awaitPromise = true) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise,
      returnByValue: true,
    })
    if (r.exceptionDetails) {
      throw new Error(`页面异常: ${JSON.stringify(r.exceptionDetails).slice(0, 600)}`)
    }
    return r?.result?.value
  }
}

async function waitTarget() {
  const deadline = Date.now() + 60000
  while (Date.now() < deadline) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (page) return page.webSocketDebuggerUrl
    } catch {
      /* 还没起来 */
    }
    await sleep(400)
  }
  throw new Error('CDP 未就绪')
}

/** 在页面里放一个 invoke 包装 + 事件收集器（所有断言都从这两个入口取数据） */
const INJECT = `(() => {
  const ev = { pty: [], ssh: [], sshState: [], telnet: [], telnetState: [],
               vnc: [], vncState: [], rdp: [], rdpState: [], hostkey: [] }
  window.__ev = ev
  const push = (key) => (payload) => { ev[key].push(payload) }
  window.t1000.on('PTY_DATA', push('pty'))
  window.t1000.on('SSH_DATA', push('ssh'))
  window.t1000.on('SSH_STATE', push('sshState'))
  window.t1000.on('TELNET_DATA', push('telnet'))
  window.t1000.on('TELNET_STATE', push('telnetState'))
  window.t1000.on('VNC_FRAME', push('vnc'))
  window.t1000.on('VNC_STATE', push('vncState'))
  window.t1000.on('RDP_STATE', push('rdpState'))
  window.t1000.on('RDP_EXIT', push('rdp'))
  window.t1000.on('SSH_HOST_KEY_ASK', push('hostkey'))
  window.__call = async (d, a, p) => {
    const r = await window.t1000.invoke(d, a, p)
    if (!r || r.ok !== true) throw new Error(d + '.' + a + ' → ' + JSON.stringify(r).slice(0, 400))
    return r.data
  }
  window.__text = (key) => ev[key].map((x) => x.data).join('')
  // 未知主机指纹会让 ssh2 一直等 hostVerifier 回调（表现为 "Timed out while
  // waiting for handshake"）。真实 UI 会弹窗让用户确认，这里自动接受一次。
  window.__acceptHostKeys = async () => {
    for (const ask of ev.hostkey) {
      if (ask.__done) continue
      ask.__done = true
      await window.__call('ssh', 'verifyHostKey', { requestId: ask.requestId, accepted: true })
    }
    return ev.hostkey.length
  }
  return true
})()`

const CONN_TIME = '2026-01-01T00:00:00.000Z'

async function main() {
  mkdirSync('/home/mosfet/dsh1/_tmp', { recursive: true })
  await ensureXvfb()
  rmSync(USERDATA, { recursive: true, force: true })

  // ── 起真实对端 ──
  const { startTestSshHost } = await import('../src/main/services/sftp/test-sftp-server.ts')
  const { RfbServerFixture } = await import('../test-fixtures/rfb-server-fixture.ts')

  const sshHost = await startTestSshHost({})
  const vnc = await RfbServerFixture.start({ width: 320, height: 240, password: 'secret' })
  const httpTarget = await startHttpTarget()
  const telnet = await startTelnetMock()

  console.log(`SSH  127.0.0.1:${sshHost.port}（ssh2 真实服务端，root=${sshHost.root}）`)
  console.log(`VNC  127.0.0.1:${vnc.port}（RFB 夹具 320x240，DES 认证）`)
  console.log(`HTTP 127.0.0.1:${httpTarget.port}（隧道目标）`)
  console.log(`TELNET 127.0.0.1:${telnet.port}（IAC + 登录提示符）`)

  const rdpRecord = join('/home/mosfet/dsh1/_tmp', 'rdp-calls.jsonl')
  rmSync(rdpRecord, { force: true })

  const fakeBin = join(DESKTOP, 'test-fixtures', 'fake-freerdp', 'bin')
  const electron = spawn(
    './node_modules/.bin/electron',
    [
      '.',
      '--no-sandbox',
      '--t1000-testhook',
      '--enable-unsafe-swiftshader',
      '--ignore-gpu-blocklist',
      `--remote-debugging-port=${CDP_PORT}`,
    ],
    {
      cwd: DESKTOP,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '',
        DISPLAY,
        T1000_TEST_HOOK: '1',
        T1000_TEST_USERDATA: USERDATA,
        // 让 findRdpBinary 选中夹具；resident 模式模拟"客户端驻留中"
        PATH: `${fakeBin}:${process.env['PATH'] ?? ''}`,
        T1000_FAKE_RDP_RECORD: rdpRecord,
        T1000_FAKE_RDP_MODE: 'resident',
        T1000_FAKE_RDP_MAX_MS: '120000',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  electron.stdout.on('data', () => {})
  electron.stderr.on('data', () => {})

  let cdp
  try {
    cdp = await Cdp.connect(await waitTarget())
    await cdp.send('Runtime.enable')
    await cdp.send('Page.enable')

    // 等渲染层把桥挂上
    for (let i = 0; i < 60; i += 1) {
      const ready = await cdp.eval('typeof window.t1000?.invoke === "function"', false)
      if (ready) break
      await sleep(500)
    }
    await cdp.eval(INJECT, false)

    const call = (domain, action, payload) =>
      cdp.eval(`window.__call(${JSON.stringify(domain)}, ${JSON.stringify(action)}, ${JSON.stringify(payload)})`)
    const text = (key) => cdp.eval(`window.__text(${JSON.stringify(key)})`)
    const states = (key) => cdp.eval(`window.__ev[${JSON.stringify(key)}]`)

    const waitUntil = async (fn, ms, label) => {
      const deadline = Date.now() + ms
      while (Date.now() < deadline) {
        if (await fn()) return true
        await sleep(250)
      }
      return false
    }

    /**
     * 发起 ssh.connect 并处理"未知主机指纹"。
     *
     * 不能直接 await：主进程会停在 hostVerifier 上等 UI 决议，ssh2 到点就抛
     * "Timed out while waiting for handshake"。所以先把 promise 挂到 window 上，
     * 轮询接受指纹，再看结果。
     */
    const connectSsh = async (callFn, connection) => {
      await cdp.eval(
        `window.__sshResult = null;
         window.__sshPending = window.__call('ssh','connect',${JSON.stringify({
           connection,
           cols: 100,
           rows: 30,
         })}).then((r) => { window.__sshResult = { ok: true, data: r } },
                   (e) => { window.__sshResult = { ok: false, error: String(e) } });
         true`,
        false,
      )
      const deadline = Date.now() + 30000
      while (Date.now() < deadline) {
        await cdp.eval('window.__acceptHostKeys()')
        const result = await cdp.eval('window.__sshResult ?? null', false)
        if (result) {
          if (!result.ok) throw new Error(result.error)
          return result.data
        }
        await sleep(250)
      }
      throw new Error('ssh.connect 30 秒内没有结果')
    }

    // ── 1. 本地终端（pty） ───────────────────────────────────────────
    section('1 本地终端（node-pty）')
    const profiles = await call('pty', 'listProfiles', {})
    const profileList = Array.isArray(profiles) ? profiles : (profiles?.profiles ?? [])
    record('pty.listProfiles 返回可用 shell', profileList.length > 0, `${profileList.length} 个`)

    const pty = await call('pty', 'open', { cols: 100, rows: 30 })
    record('pty.open 拿到 ptyId', typeof pty?.ptyId === 'string', pty?.ptyId)
    await call('pty', 'write', { ptyId: pty.ptyId, data: 'echo PTY-OK\r' })
    const ptyOk = await waitUntil(async () => (await text('pty')).includes('PTY-OK'), 15000, 'pty')
    record('终端里执行 echo 有回显', ptyOk, ptyOk ? 'PTY-OK' : '超时')
    await call('pty', 'close', { ptyId: pty.ptyId })

    // ── 2. SSH 终端 ─────────────────────────────────────────────────
    section('2 SSH（ssh2 真实服务端）')
    const sshConnection = {
      kind: 'ssh',
      id: 'e2e-ssh',
      name: 'e2e-ssh',
      host: sshHost.credentials.host,
      port: sshHost.credentials.port,
      username: sshHost.credentials.username,
      authType: 'password',
      password: sshHost.credentials.password,
      createdAt: CONN_TIME,
      updatedAt: CONN_TIME,
    }
    const ssh = await connectSsh(call, sshConnection)
    const sshSession = ssh?.sessionId
    record('ssh.connect 拿到 sessionId', typeof sshSession === 'string', sshSession)

    const sshUp = await waitUntil(async () => {
      const list = await states('sshState')
      return (list ?? []).some((x) => x.sessionId === sshSession && x.state === 'ready')
    }, 20000, 'ssh')
    record('SSH 状态变为 ready', sshUp)

    await call('ssh', 'write', { sessionId: sshSession, data: 'echo SSH-OK\r' })
    const sshOk = await waitUntil(async () => (await text('ssh')).includes('SSH-OK'), 15000, 'ssh')
    record('SSH 终端执行命令有输出', sshOk, sshOk ? 'SSH-OK' : '超时')

    // ── 3. SFTP（复用同一条 SSH 会话） ───────────────────────────────
    section('3 SFTP（同一会话上的真实 SFTP 子系统）')
    // 夹具把 127.0.0.1 的 SFTP 根映射成它自己的临时目录（guest 里看到的是 '/'），
    // 所以准备文件要用**宿主侧真实路径**，而读写命令用 guest 路径。
    const { writeFileSync } = await import('node:fs')
    writeFileSync(join(sshHost.root, 'seed.txt'), 'seed\n')

    const home = await call('sftp', 'home', { sessionId: sshSession })
    record('sftp.home 返回远端家目录', typeof home?.path === 'string', home?.path)

    const listing = await call('sftp', 'list', {
      sessionId: sshSession,
      path: home?.path ?? '/',
      showHidden: true,
    })
    const entries = Array.isArray(listing) ? listing : (listing?.entries ?? [])
    record('sftp.list 返回目录项', entries.length > 0, `${entries.length} 项`)

    const guestProbe = '/e2e-upload.txt'
    await call('sftp', 'writeFile', {
      sessionId: sshSession,
      path: guestProbe,
      content: 'sftp-roundtrip-中文\n',
    })
    const roundTrip = await call('sftp', 'readFile', { sessionId: sshSession, path: guestProbe })
    record(
      'SFTP 写入→读回内容一致',
      String(roundTrip?.content ?? '').includes('sftp-roundtrip-中文'),
      JSON.stringify(roundTrip?.content ?? '').slice(0, 40),
    )
    const onDisk = readFileSync(join(sshHost.root, 'e2e-upload.txt'), 'utf8')
    record('SFTP 写到的确实是宿主磁盘上的文件', onDisk.includes('sftp-roundtrip-中文'))

    // ── 4. 端口转发（direct-tcpip 穿 SSH） ──────────────────────────
    section('4 端口转发（ssh -L，真穿一次 HTTP）')
    const tunnel = {
      kind: 'tunnel',
      id: 'e2e-tunnel',
      name: 'e2e-tunnel',
      host: '0.0.0.0',
      port: 0,
      serverId: 'e2e-ssh',
      type: 'local',
      localHost: '127.0.0.1',
      localPort: 0,
      remoteHost: '127.0.0.1',
      remotePort: httpTarget.port,
      autoReconnect: false,
      createdAt: CONN_TIME,
      updatedAt: CONN_TIME,
    }
    const opened = await call('forward', 'open', { tunnel })
    const boundPort = opened?.boundPort
    record('forward.open 拿到监听端口', typeof boundPort === 'number' && boundPort > 0, String(boundPort))

    let tunnelBody = ''
    if (typeof boundPort === 'number' && boundPort > 0) {
      for (let i = 0; i < 20; i += 1) {
        try {
          const res = await fetch(`http://127.0.0.1:${boundPort}/through-tunnel`)
          tunnelBody = await res.text()
          break
        } catch {
          await sleep(300)
        }
      }
    }
    record('经隧道取回 HTTP 响应', tunnelBody.includes('TUNNEL-OK'), tunnelBody.slice(0, 40))
    if (opened?.tunnelId) await call('forward', 'close', { tunnelId: opened.tunnelId })

    // ── 5. Telnet（IAC + 自动登录） ─────────────────────────────────
    section('5 Telnet（真实 IAC 协商 + 凭据自动应答）')
    const telnetConn = {
      kind: 'telnet',
      id: 'e2e-telnet',
      name: 'e2e-telnet',
      host: '127.0.0.1',
      port: telnet.port,
      username: 'admin',
      password: 'admin123',
      keyMapping: { enabled: false },
      createdAt: CONN_TIME,
      updatedAt: CONN_TIME,
    }
    const tel = await call('telnet', 'connect', { connection: telnetConn, cols: 100, rows: 30 })
    const telSession = tel?.sessionId
    record('telnet.connect 拿到 sessionId', typeof telSession === 'string', telSession)

    const telLogin = await waitUntil(async () => telnet.state.loggedIn, 20000, 'telnet')
    record('设备侧收到用户名+密码并放行', telLogin, `user=${telnet.state.user} pass=${telnet.state.password}`)
    record('凭据与表单一致（不是掩码）', telnet.state.user === 'admin' && telnet.state.password === 'admin123')

    const telPrompt = await waitUntil(async () => (await text('telnet')).includes('root@OpenWrt'), 15000, 'telnet')
    record('终端收到登录后提示符', telPrompt)
    await call('telnet', 'write', { sessionId: telSession, data: 'echo TELNET-OK\r' })
    const telOk = await waitUntil(async () => (await text('telnet')).includes('TELNET-OK'), 15000, 'telnet')
    record('telnet 写通道通（命令有回显）', telOk)

    // ── 6. VNC（RFB 握手 + 首帧） ───────────────────────────────────
    section('6 VNC（真实 RFB 握手 + DES 认证 + 帧更新）')
    const vncConn = {
      kind: 'vnc',
      id: 'e2e-vnc',
      name: 'e2e-vnc',
      host: '127.0.0.1',
      port: vnc.port,
      authType: 'vnc-password',
      password: 'secret',
      shared: true,
      createdAt: CONN_TIME,
      updatedAt: CONN_TIME,
    }
    const vs = await call('vnc', 'connect', { connection: vncConn })
    const vncSession = vs?.sessionId
    record('vnc.connect 拿到 sessionId', typeof vncSession === 'string', vncSession)

    const vncUp = await waitUntil(async () => {
      const list = await states('vncState')
      return (list ?? []).some((x) => x.sessionId === vncSession && x.state === 'ready')
    }, 20000, 'vnc')
    record('VNC 状态变为 ready', vncUp)
    record('服务端接受了 DES 认证应答', vnc.authResponses.length > 0 && vnc.authFailures === 0)

    vnc.sendUpdate()
    const frame = await waitUntil(async () => {
      const list = await states('vnc')
      return (list ?? []).some((x) => x.sessionId === vncSession && (x.rects ?? []).length > 0)
    }, 15000, 'vnc')
    record('收到 VNC 帧（含像素矩形）', frame)
    await call('vnc', 'sendPointer', { sessionId: vncSession, x: 10, y: 12, buttonMask: 0 })
    await sleep(300)
    record('指针事件到达服务端', vnc.pointerEvents.length > 0, JSON.stringify(vnc.pointerEvents.at(-1) ?? null))
    await call('vnc', 'disconnect', { sessionId: vncSession })

    // ── 7. RDP（外部 FreeRDP：探测 + argv + 生命周期） ──────────────
    section('7 RDP（FreeRDP 探测 + 参数映射 + 进程生命周期）')
    const rdpConn = {
      kind: 'rdp',
      id: 'e2e-rdp',
      name: 'e2e-rdp',
      host: '127.0.0.1',
      port: 3389,
      username: 'e2e-user',
      domain: 'E2E',
      displayMode: 'follow-window',
      quality: 'balanced',
      clipboardShare: false,
      createdAt: CONN_TIME,
      updatedAt: CONN_TIME,
    }
    const rd = await call('rdp', 'connect', { connection: rdpConn })
    const rdpSession = rd?.sessionId
    record('rdp.connect 拿到 sessionId', typeof rdpSession === 'string', rdpSession)
    record(
      '探测到的是夹具 FreeRDP（不是系统里的）',
      String(rd?.executable ?? '').includes('fake-freerdp'),
      rd?.executable,
    )
    record(
      '参数映射：/v:host:port 与 /u:、/cert:ignore 都在',
      Array.isArray(rd?.args) &&
        rd.args.includes('/v:127.0.0.1:3389') &&
        rd.args.includes('/u:e2e-user') &&
        rd.args.includes('/cert:ignore'),
      (rd?.args ?? []).slice(0, 4).join(' '),
    )

    const rdpUp = await waitUntil(async () => {
      const list = await states('rdpState')
      return (list ?? []).some((x) => x.sessionId === rdpSession && x.state === 'ready')
    }, 20000, 'rdp')
    record('RDP 状态变为 ready（客户端驻留中）', rdpUp)

    // 子进程是异步写的，读记录前给它一点时间（写文件在 client.mjs 的最开头）
    let argv = []
    for (let i = 0; i < 20 && argv.length === 0; i += 1) {
      if (existsSync(rdpRecord)) {
        const lines = readFileSync(rdpRecord, 'utf8').trim().split('\n').filter(Boolean)
        if (lines.length > 0) argv = JSON.parse(lines.at(-1)).argv
      }
      if (argv.length === 0) await sleep(150)
    }
    record('子进程真的收到了这组参数（进程边界取证）', argv.includes('/v:127.0.0.1:3389'), argv.slice(0, 4).join(' '))
    await call('rdp', 'disconnect', { sessionId: rdpSession })
    await call('ssh', 'disconnect', { sessionId: sshSession })
  } finally {
    cdp?.ws?.close()
    electron.kill('SIGTERM')
    await sleep(400)
    await Promise.allSettled([sshHost.close(), vnc.close(), httpTarget.close(), telnet.close()])
    if (!KEEP && failed === 0) rmSync(USERDATA, { recursive: true, force: true })
  }

  // ── 汇总 ────────────────────────────────────────────────────────────────
  console.log('\n=== 协议矩阵 ===')
  for (const row of rows) console.log(`${row.ok ? 'PASS' : 'FAIL'}  ${row.name}`)
  console.log(`\n通过 ${rows.length - failed} 项，失败 ${failed} 项`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('验收崩溃:', err)
  process.exit(2)
})
