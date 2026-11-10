#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors
//
// 整机验收运行：对**真实运行的应用**逐条核对 spec 的验收标准。
//
// 为什么要它：单元测试只能证明"各模块自己没问题"，证明不了"整机接起来是对的"。
// 本轮已经三次出现"单测全绿、真实环境全挂"（VNC numRects、RDP 缺 /p:、forward 的 id 错配），
// 所以需要一层"对着真实 app 的验收"。
//
// 用法：
//   1) 先起显示（无头环境）：Xvfb :97 -screen 0 1440x900x24 &
//   2) DISPLAY=:97 node scripts/acceptance.mjs
//   脚本自己会拉起 electron（CDP 端口 9226）、跑完验收、打印逐条结论、然后退出。
//
// 驱动方式：通过 CDP 调 `window.t1000.invoke(domain, action, payload)` ——
// 这是**真实的 IPC 链路**（真 preload → 真主进程 → 真服务），不是直接调内部函数。
// 比盲点 DOM 可靠得多，且能覆盖到 UI 之外的契约行为。
//
// 需要真实 SSH 主机的条目（终端/跳板机/SFTP/转发/监控/广播）在本脚本里标为
// SKIP 并给出原因，等 `scripts/ssh-test-host.mjs` 就绪后可补上。

import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { createServer, connect as netConnect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const DESKTOP = new URL('..', import.meta.url).pathname
const REPO_ROOT = new URL('../../..', import.meta.url).pathname
const CDP_PORT = Number(process.env.T1000_CDP_PORT ?? 9226)
const PROFILE = mkdtempSync(join(tmpdir(), 't1000-acceptance-'))

const results = []
function record(id, title, status, detail = '') {
  results.push({ id, title, status, detail })
  const icon = status === 'PASS' ? '✅' : status === 'FAIL' ? '❌' : '⏭️'
  console.log(`${icon} [${id}] ${title}${detail ? ` — ${detail}` : ''}`)
  return status
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 等 CDP 起来并拿到页面 target 的 ws url */
async function waitForTarget(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)
      const list = await res.json()
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (page) return page.webSocketDebuggerUrl
    } catch {
      /* 还没起来 */
    }
    await sleep(400)
  }
  throw new Error('CDP target 未就绪')
}

/** 极简 CDP 客户端（Node 22 自带 WebSocket，零依赖） */
class Cdp {
  #ws
  #id = 0
  #pending = new Map()

  static async connect(url) {
    const c = new Cdp()
    c.#ws = new WebSocket(url)
    await new Promise((resolve, reject) => {
      c.#ws.addEventListener('open', resolve, { once: true })
      c.#ws.addEventListener('error', reject, { once: true })
    })
    c.#ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data)
      const p = c.#pending.get(msg.id)
      if (p) {
        c.#pending.delete(msg.id)
        msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result)
      }
    })
    return c
  }

  send(method, params = {}) {
    const id = ++this.#id
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject })
      this.#ws.send(JSON.stringify({ id, method, params }))
    })
  }

  /** 在页面里求值，返回 JSON 化的结果 */
  async eval(expression) {
    const res = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    })
    if (res.exceptionDetails) {
      throw new Error(res.exceptionDetails.exception?.description ?? '页面内求值抛错')
    }
    return res.result?.value
  }

  close() {
    try {
      this.#ws.close()
    } catch {
      /* 忽略 */
    }
  }
}

/** 调 IPC 并解包：失败时抛出带错误码的异常，便于断言 */
const INVOKE = (domain, action, payload) =>
  `(async () => {
     const r = await window.t1000.invoke(${JSON.stringify(domain)}, ${JSON.stringify(action)}, ${JSON.stringify(payload ?? null)});
     if (!r || r.ok !== true) throw new Error('IPC 失败: ' + JSON.stringify(r && r.error));
     return r.data;
   })()`

/**
 * 启动仓库自带的 SSH 测试主机（真实 ssh2 服务端 + 真实子进程 + 真实文件系统），
 * 从它的 stdout 里解析出端口与凭据。
 */
function startSshHost() {
  return new Promise((resolve, reject) => {
    const root = mkdtempSync(join(tmpdir(), 't1000-sshroot-'))
    const child = spawn('node', ['scripts/ssh-test-host.mjs', '--root', root], {
      cwd: REPO_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    })
    let buf = ''
    const timer = setTimeout(() => reject(new Error('测试主机启动超时')), 20000)
    const onData = (chunk) => {
      buf += chunk.toString()
      const port = buf.match(/port\s*:\s*(\d+)/)?.[1]
      const password = buf.match(/password\s*:\s*(\S+)/)?.[1]
      const username = buf.match(/username\s*:\s*(\S+)/)?.[1]
      if (port && username && password) {
        clearTimeout(timer)
        resolve({
          host: '127.0.0.1',
          port: Number(port),
          username,
          password,
          workspace: root,
          stop: () => {
            try { process.kill(-child.pid, 'SIGTERM') } catch { /* 已退出 */ }
            rmSync(root, { recursive: true, force: true })
          },
        })
      }
    }
    child.stdout.on('data', onData)
    child.on('error', (e) => { clearTimeout(timer); reject(e) })
  })
}

async function main() {
  if (!process.env.DISPLAY) throw new Error('需要 DISPLAY（无头环境请先起 Xvfb）')

  const app = spawn(
    './node_modules/.bin/electron',
    [
      '.',
      '--no-sandbox',
      // 必须带：否则 Electron 45 走 Wayland，窗口不出现在 Xvfb 上
      '--ozone-platform=x11',
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${PROFILE}`,
    ],
    { cwd: DESKTOP, stdio: 'ignore', detached: true },
  )
  const stop = () => {
    try {
      process.kill(-app.pid, 'SIGTERM')
    } catch {
      /* 已退出 */
    }
    rmSync(PROFILE, { recursive: true, force: true })
  }

  try {
    const wsUrl = await waitForTarget()
    const cdp = await Cdp.connect(wsUrl)
    await cdp.send('Runtime.enable')

    // 等渲染层把 IPC 桥挂上
    for (let i = 0; i < 40; i++) {
      const ready = await cdp.eval('typeof window.t1000?.invoke === "function"').catch(() => false)
      if (ready) break
      await sleep(300)
    }
    if (!(await cdp.eval('typeof window.t1000?.invoke === "function"'))) {
      throw new Error('window.t1000 未就绪（preload 没挂上？）')
    }

    // ── 先解锁/设主密码：多数数据类条目依赖它 ──
    const unlocked = await cdp.eval(INVOKE('store', 'isUnlocked', {}))
    if (!unlocked) {
      await cdp.eval(INVOKE('store', 'setMasterPassword', { password: 'Acceptance#2026' }))
    }

    // ════════ 第 6 条：笔记创建/编辑/搜索，废纸篓可恢复 ════════
    try {
      const note = await cdp.eval(
        // 入参是**扁平**的（id/title/content），不是 {note:{...}} —— 核对过 saveSchema
        INVOKE('notes', 'save', { title: '验收笔记-可搜索关键词ZQX', content: '# 标题\n正文内容' }),
      )
      const list = await cdp.eval(INVOKE('notes', 'list', {}))
      const found = JSON.stringify(list).includes('笔记') || JSON.stringify(list).includes(note?.id ?? '@@')
      await cdp.eval(INVOKE('notes', 'delete', { id: note.id }))
      const trash = await cdp.eval(INVOKE('notes', 'list', { trashed: true }))
      const inTrash = JSON.stringify(trash).includes(note.id)
      await cdp.eval(INVOKE('notes', 'restore', { id: note.id }))
      const afterRestore = await cdp.eval(INVOKE('notes', 'list', {}))
      const restored = JSON.stringify(afterRestore).includes(note.id)
      record(
        '6',
        '笔记：创建/列表/删除入废纸篓/恢复',
        found && inTrash && restored ? 'PASS' : 'FAIL',
        `创建=${found} 废纸篓=${inTrash} 恢复=${restored}`,
      )
    } catch (err) {
      record('6', '笔记：创建/列表/删除入废纸篓/恢复', 'FAIL', String(err.message ?? err))
    }

    // ════════ 第 7 条：密码生成器 ════════
    // 生成器与熵值计算**完全在渲染层**（features/tools/ToolsView.tsx），主进程没有对应动作，
    // 因此本脚本无法经 IPC 验证它 —— 它需要的是**单元测试**（正在补），不是端到端。
    record('7', '密码生成器参数与熵值', 'SKIP', '逻辑在渲染层，应由单元测试覆盖（正在补），非本脚本范围')

    // ════════ 第 8 条：命令搜索可离线查用法 ════════
    try {
      const r = await cdp.eval(INVOKE('completion', 'search', { query: 'tar' }))
      const top = r?.results?.[0]
      const ok = Boolean(top?.name === 'tar' && top?.usage && top?.summary)
      record('8', '命令搜索：能查到用法/语法/用途', ok ? 'PASS' : 'FAIL', `命中 ${r?.results?.length ?? 0} 条，首条 ${top?.name ?? '无'}`)
      const zh = await cdp.eval(INVOKE('completion', 'search', { query: '压缩' }))
      record('8b', '命令搜索：中文描述可搜到', (zh?.results?.length ?? 0) > 0 ? 'PASS' : 'FAIL', `命中 ${zh?.results?.length ?? 0} 条`)
    } catch (err) {
      record('8', '命令搜索', 'FAIL', String(err.message ?? err))
    }

    // ════════ 第 12 条：命令补全能返回候选 ════════
    try {
      const r = await cdp.eval(INVOKE('completion', 'complete', { line: 'git ', cursor: 4 }))
      const n = r?.candidates?.length ?? r?.results?.length ?? 0
      record('12', '命令补全：返回候选', n > 0 ? 'PASS' : 'FAIL', `候选 ${n} 条`)
    } catch (err) {
      record('12', '命令补全', 'FAIL', String(err.message ?? err))
    }

    // ════════ 第 10 条（部分）：加密存储 + 备份导出/导入 ════════
    try {
      const conn = await cdp.eval(
        // 入参就是连接本身（connectionInputSchema 直接解析 payload），不是 {connection}；
        // 且 **id 必填** —— 由界面侧生成（renderer 的 newConnectionId() 用 crypto 随机 12 字节）。
        `(async () => {
           const id = Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, '0')).join('');
           const r = await window.t1000.invoke('store', 'saveConnection', {
             kind: 'ssh', id, name: '验收-加密存储', host: '192.0.2.77', port: 22,
             username: 'u', password: 'Secret#123', createdAt: '', updatedAt: '',
           });
           if (!r || r.ok !== true) throw new Error('IPC 失败: ' + JSON.stringify(r && r.error));
           return r.data;
         })()`,
      )
      // 锁定后应读不到明文口令
      await cdp.eval(INVOKE('store', 'lock', {}))
      const locked = await cdp.eval(INVOKE('store', 'getConnection', { id: conn.id }))
      const masked = JSON.stringify(locked).includes('Secret#123') === false
      // 解锁后能读回
      await cdp.eval(INVOKE('store', 'unlock', { password: 'Acceptance#2026' }))
      const back = await cdp.eval(INVOKE('store', 'getConnection', { id: conn.id }))
      const readable = JSON.stringify(back).includes('Secret#123')
      record(
        '10',
        '加密存储：锁定态不泄露明文、解锁后可读回',
        masked && readable ? 'PASS' : 'FAIL',
        `锁定屏蔽=${masked} 解锁可读=${readable}`,
      )
    } catch (err) {
      record('10', '加密存储', 'FAIL', String(err.message ?? err))
    }

    // ── 其余：设置持久化 / 同步状态 / MCP / 快捷键 / 广播 ──
    try {
      await cdp.eval(INVOKE('settings', 'set', { path: 'terminal.fontSize', value: 17 }))
      const s = await cdp.eval(INVOKE('settings', 'get', { path: 'terminal.fontSize' }))
      const v = s?.value ?? s
      record('S1', '设置读写（界面持久化基础）', v === 17 ? 'PASS' : 'FAIL', `读回 ${JSON.stringify(v)}`)
    } catch (err) {
      record('S1', '设置读写', 'FAIL', String(err.message ?? err))
    }

    // ── 系统域：备份真的产出、备份列表可读、设置分区存在 ──
    try {
      const backupDir = join(PROFILE, 'backups')
      // 捕获备份事件，失败时能把**真实原因**带出来（否则只能看到"0 个文件"）
      await cdp.eval(`(() => {
        window.__accBackup = null;
        window.t1000.on('BACKUP_RESULT', (p) => { window.__accBackup = p; });
        return true;
      })()`)
      const started = await cdp.eval(INVOKE('system', 'backupNow', { dir: backupDir }))
      // 备份是异步的（导出 + 清理），等它落盘
      let backups = []
      for (let i = 0; i < 40; i++) {
        await sleep(250)
        const r = await cdp.eval(INVOKE('system', 'listBackups', { dir: backupDir }))
        backups = r?.backups ?? []
        if (backups.length > 0) break
      }
      const first = backups[0]
      const evt = await cdp.eval('JSON.stringify(window.__accBackup || null)')
      record('S10', '每日备份：真的产出备份文件（可读回大小）',
        backups.length > 0 && (first?.size ?? 0) > 0 ? 'PASS' : 'FAIL',
        `备份 ${backups.length} 个，最新 ${first?.name?.slice(0, 40) ?? '无'} / ${first?.size ?? 0} 字节；事件=${evt}`)
    } catch (err) {
      record('S10', '每日备份', 'FAIL', String(err.message ?? err))
    }

    try {
      // 自动锁屏的阈值语义：设置可读可写（真实空闲触发需要等人离开，不适合自动化）
      await cdp.eval(INVOKE('settings', 'set', { path: 'security.autoLockMinutes', value: 5 }))
      const v = await cdp.eval(INVOKE('settings', 'get', { path: 'security.autoLockMinutes' }))
      const got = v?.value ?? v
      record('S11', '锁定设置可读写（空闲自动锁定的配置面）', got === 5 ? 'PASS' : 'FAIL', `读回 ${JSON.stringify(got)}`)
    } catch (err) {
      record('S11', '锁定设置', 'FAIL', String(err.message ?? err))
    }

    try {
      await cdp.eval(INVOKE('system', 'lockNow', {}))
      // ⚠️ `store.isUnlocked` 返回的是 **{unlocked, initialized}** 而不是布尔
      // （我第一版直接和 false 比较，于是拿到了 "[object Object]"）
      const st = await cdp.eval(INVOKE('store', 'isUnlocked', {}))
      record('S12', '立即锁定：调用后本地库确实已锁定',
        st?.unlocked === false ? 'PASS' : 'FAIL', `unlocked=${st?.unlocked} initialized=${st?.initialized}`)
      // 还原，避免影响后续条目
      await cdp.eval(INVOKE('store', 'unlock', { password: 'Acceptance#2026' }))
    } catch (err) {
      record('S12', '立即锁定', 'FAIL', String(err.message ?? err))
    }

    for (const [id, title, domain, action] of [
      ['S2', '同步域可用（status）', 'sync', 'status'],
      ['S3', 'MCP 域可用（status）', 'mcp', 'status'],
      ['S4', '快捷键域可用（list）', 'hotkey', 'list'],
      ['S5', '广播域可用（list）', 'broadcast', 'list'],
      ['S6', '会话日志域可用（list）', 'sessionlog', 'list'],
      ['S7', '快速命令域可用（list）', 'quickcmd', 'list'],
      ['S8', '端口转发域可用（list）', 'forward', 'list'],
      ['S9', '监控域可用（listCards）', 'monitor', 'listCards'],
    ]) {
      try {
        await cdp.eval(INVOKE(domain, action, {}))
        record(id, title, 'PASS')
      } catch (err) {
        record(id, title, 'FAIL', String(err.message ?? err))
      }
    }

    // ════════════════════════════════════════════════════════════
    // 以下条目需要**真实 SSH 主机**：用仓库自带的 SSH 测试主机
    // （scripts/ssh-test-host.mjs：真实 ssh2 服务端 + 真实子进程 + 真实文件系统）
    // ════════════════════════════════════════════════════════════
    let sshHost = null
    try {
      sshHost = await startSshHost()
      globalThis.__sshHostStop = sshHost.stop
    } catch (err) {
      console.log(`\n⚠️ SSH 测试主机未启动（${err.message}），跳过依赖它的条目`)
    }

    if (sshHost) {
      const { host, port, username, password, workspace } = sshHost
      /** 页内收集某个会话的输出（通过真实 SSH_DATA 事件） */
      const collect = async (sessionId, holdMs) => {
        await cdp.eval(`(() => {
          window.__acc = window.__acc || {};
          if (!window.__acc['${sessionId}']) {
            window.__acc['${sessionId}'] = '';
            window.t1000.on('SSH_DATA', (p) => {
              if (p && p.sessionId === '${sessionId}') window.__acc['${sessionId}'] += p.data;
            });
          }
          return true;
        })()`)
        await sleep(holdMs)
        return cdp.eval(`window.__acc['${sessionId}'] || ''`)
      }

      /**
       * 等**真实弹窗**出现并点它。
       *
       * ⚠️ 这里刻意**不替产品自动应答**（早先我脚本看到 `SSH_HOST_KEY_ASK` 就自己调
       * `ssh.verifyHostKey`）：那样会让"渲染层根本没订阅该事件"这个**阻断性缺陷**
       * 被验收掩盖成绿灯 —— 而真实用户连任何新主机都会卡到握手超时。
       * 夹具只应"操作产品"，不应"代替产品"。
       */
      const clickByText = async (includes, timeoutMs = 15000) => {
        const ok = await cdp.eval(`(async () => {
          const deadline = Date.now() + ${timeoutMs};
          while (Date.now() < deadline) {
            const btn = [...document.querySelectorAll('button')]
              .find((b) => (b.textContent || '').includes(${JSON.stringify(includes)}) && !b.disabled);
            if (btn) { btn.click(); return true; }
            await new Promise((r) => setTimeout(r, 200));
          }
          return false;
        })()`)
        return ok === true
      }
      /** 等某个标题的弹窗出现（证明 UI 真的在处理该询问） */
      const waitForDialog = async (titleIncludes, timeoutMs = 15000) => {
        const found = await cdp.eval(`(async () => {
          const deadline = Date.now() + ${timeoutMs};
          while (Date.now() < deadline) {
            const t = document.body.innerText || '';
            if (t.includes(${JSON.stringify(titleIncludes)})) return true;
            await new Promise((r) => setTimeout(r, 200));
          }
          return false;
        })()`)
        return found === true
      }
      /** 从弹窗正文里把指纹抠出来当证据 */
      const readFingerprint = async () =>
        cdp.eval(`(document.body.innerText || '').match(/SHA256:[A-Za-z0-9+/=]+/)?.[0] ?? ''`)

      const sshConnection = {
        kind: 'ssh',
        id: `acc-${Date.now().toString(16)}`,
        name: '验收-SSH 测试主机',
        host,
        port,
        username,
        authType: 'password',
        password,
        createdAt: '',
        updatedAt: '',
      }

      // ════ 第 1 条：SSH 连接出终端（真实握手 + 真实命令回显 + **真实指纹弹窗**）════
      let sessionId = null
      try {
        // connect 是异步的：它会等在 UI 应答指纹后才完成，所以这里**不 await**，
        // 而是并行去等弹窗（否则会卡在超时上，正是真实用户遇到的现象）
        const connectPromise = cdp.eval(INVOKE('ssh', 'connect', { connection: sshConnection }))

        const dialogShown = await waitForDialog('主机指纹')
        const fingerprint = dialogShown ? await readFingerprint() : ''
        const accepted = dialogShown ? await clickByText('接受并保存') : false

        const res = await connectPromise
        sessionId = res?.sessionId

        const out = await (async () => {
          await collect(sessionId, 1000)
          await cdp.eval(INVOKE('ssh', 'write', { sessionId, data: 'echo ACCEPT_TERMINAL_OK\n' }))
          return collect(sessionId, 2500)
        })()

        const echoed = typeof out === 'string' && out.includes('ACCEPT_TERMINAL_OK')
        record('1', 'SSH 连接出终端（真实握手 + 真实命令回显）',
          dialogShown && accepted && echoed ? 'PASS' : 'FAIL',
          `指纹弹窗=${dialogShown} 已接受=${accepted} 回显=${echoed} 指纹=${fingerprint.slice(0, 30) || '—'}`)
      } catch (err) {
        record('1', 'SSH 连接出终端', 'FAIL', String(err.message ?? err))
      }

      // ════ 第 11 条：监控面板（真实 exec 采集）════
      try {
        await cdp.eval(INVOKE('monitor', 'start', { sessionId }))
        // 真实形状是 { sessionId, at, system?, cpu?, memory?, network?, disk?, processes? }
        // —— 没有 `cards` 字段（我第一版按印象写的，于是误判成"0 张卡片"）
        const snap = await cdp.eval(INVOKE('monitor', 'getSnapshot', { sessionId, force: true }))
        const sections = ['system', 'cpu', 'memory', 'network', 'disk', 'processes'].filter(
          (k) => snap?.[k] !== undefined,
        )
        const cpu = snap?.cpu
        const mem = snap?.memory
        const detail = [
          `分区 ${sections.join('/') || '无'}`,
          cpu ? `CPU ${cpu.usagePercent ?? cpu.usage ?? '—'}%` : '',
          mem ? `内存 ${mem.usedPercent ?? mem.used ?? '—'}%` : '',
          `进程 ${snap?.processes?.length ?? 0} 个`,
        ]
          .filter(Boolean)
          .join('，')
        record('11', '监控面板：真实 exec 采集出数据', sections.length > 0 ? 'PASS' : 'FAIL', detail)
      } catch (err) {
        record('11', '监控面板', 'FAIL', String(err.message ?? err))
      }

      // ════ 第 4 条：SFTP 上传下载（真实协议 + 真实磁盘）════
      try {
        const localFile = join(PROFILE, 'acc-upload.bin')
        const payload = Buffer.alloc(256 * 1024)
        for (let i = 0; i < payload.length; i++) payload[i] = i % 251
        writeFileSync(localFile, payload)
        // ⚠️ 远端路径是**相对 SFTP 根**的：测试主机把 `--root` 作为 SFTP 根，
        // 所以远端应写 `/acc-upload.bin`，而不是宿主机上的绝对路径（我第一版就错在这，
        // 结果文件写到了 workspace 之外→核对时"找不到文件"）。
        const remotePath = '/acc-upload.bin'

        const up = await cdp.eval(INVOKE('sftp', 'upload', {
          sessionId, direction: 'upload', sourcePath: localFile, targetPath: remotePath,
        }))
        // 等传输完成（事件驱动；这里轮询 listTransfers 到终态）
        let done = false
        for (let i = 0; i < 40 && !done; i++) {
          await sleep(250)
          const list = await cdp.eval(INVOKE('sftp', 'listTransfers', { sessionId }))
          const t0 = (list?.transfers ?? list ?? []).find?.((x) => x.transferId === up?.transferId)
          if (t0 && ['done', 'completed', 'finished', 'failed', 'cancelled'].includes(t0.state)) done = true
        }
        // 用真实文件系统核对：字节必须完全一致
        const hostSidePath = join(workspace, 'acc-upload.bin')
        const remoteBytes = existsSync(hostSidePath) ? readFileSync(hostSidePath) : null
        const sameSize = remoteBytes?.length === payload.length
        const sameHash = remoteBytes ? remoteBytes.equals(payload) : false

        // 下载回来再比对
        const backPath = join(PROFILE, 'acc-download.bin')
        const down = await cdp.eval(INVOKE('sftp', 'download', {
          sessionId, direction: 'download', sourcePath: remotePath, targetPath: backPath,
        }))
        // ⚠️ 必须等**传输到终态**，不能只等"文件出现" —— 文件一创建就存在了，
        // 此时内容还在写，比对必然失败（我第一版就偷懒只等 existsSync，于是出现间歇失败）。
        for (let i = 0; i < 60; i++) {
          await sleep(250)
          const list = await cdp.eval(INVOKE('sftp', 'listTransfers', { sessionId }))
          const d0 = (list?.transfers ?? list ?? []).find?.((x) => x.transferId === down?.transferId)
          if (d0 && ['done', 'completed', 'finished', 'failed', 'cancelled'].includes(d0.state)) break
        }
        await sleep(200) // 给落盘的最后一小段留出时间
        const back = existsSync(backPath) ? readFileSync(backPath) : null
        const roundTrip = back ? back.equals(payload) : false

        record('4', 'SFTP 上传下载：真实磁盘字节一致（256KB）',
          sameHash && roundTrip ? 'PASS' : 'FAIL',
          `远端大小一致=${sameSize} 远端内容一致=${sameHash} 往返一致=${roundTrip}`)
      } catch (err) {
        record('4', 'SFTP 上传下载', 'FAIL', String(err.message ?? err))
      }

      // ════ 第 5 条：端口转发**真的转发**（本机 TCP → SSH → 远端 TCP）════
      try {
        // 起一个本机 echo 服务当作"远端目标"
        const echo = createServer((sock) => sock.pipe(sock))
        await new Promise((r) => echo.listen(0, '127.0.0.1', r))
        const echoPort = echo.address().port

        const opened = await cdp.eval(INVOKE('forward', 'open', {
          tunnel: {
            kind: 'tunnel', id: `tun-${Date.now().toString(16)}`, name: '验收-本地转发',
            // serverId 传**会话 id**：这正是本轮修好的解析（也支持连接 id）
            serverId: sessionId,
            type: 'local', localHost: '127.0.0.1', localPort: 0,
            remoteHost: '127.0.0.1', remotePort: echoPort,
            autoReconnect: false, createdAt: '', updatedAt: '',
          },
        }))
        const boundPort = opened?.boundPort ?? opened?.port
        // 从 Node 侧真实连入被转发的端口
        const echoed = await new Promise((resolve, reject) => {
          const s = netConnect(boundPort, '127.0.0.1')
          let got = ''
          s.setTimeout(4000)
          s.on('connect', () => s.write('FORWARD_OK'))
          s.on('data', (d) => (got += d.toString()))
          s.on('timeout', () => { s.destroy(); reject(new Error(`转发读回超时（已收到 ${got}）`)) })
          s.on('error', reject)
          setTimeout(() => { s.destroy(); resolve(got) }, 1200)
        })
        echo.close()
        record('5', '端口转发：数据真的经 SSH 隧道往返',
          echoed.includes('FORWARD_OK') ? 'PASS' : 'FAIL',
          `本地:${boundPort} → SSH → 远端:${echoPort}，读回 ${JSON.stringify(echoed)}`)
      } catch (err) {
        record('5', '端口转发', 'FAIL', String(err.message ?? err))
      }

      // ════ 第 13 条：并发广播（一次输入，多会话都收到）════
      try {
        const c2 = { ...sshConnection, id: `acc2-${Date.now().toString(16)}`, name: '验收-第二台' }
        const s2 = (await cdp.eval(INVOKE('ssh', 'connect', { connection: c2 })))?.sessionId
        await collect(s2, 800)
        const group = await cdp.eval(INVOKE('broadcast', 'create', { sessionIds: [sessionId, s2], mode: 'broadcast' }))
        const gid = group?.group?.groupId
        const sent = await cdp.eval(INVOKE('broadcast', 'send', { groupId: gid, data: 'echo BCAST_OK\n' }))
        const out1 = await collect(sessionId, 2000)
        const out2 = await collect(s2, 500)
        const both = out1.includes('BCAST_OK') && out2.includes('BCAST_OK')
        record('13', '并发广播：一次输入多处执行',
          both && (sent?.delivered ?? 0) >= 2 ? 'PASS' : 'FAIL',
          `delivered=${sent?.delivered} skipped=${sent?.skipped} 会话1=${out1.includes('BCAST_OK')} 会话2=${out2.includes('BCAST_OK')}`)
      } catch (err) {
        record('13', '并发广播', 'FAIL', String(err.message ?? err))
      }

      // ════ 第 2 条：跳板机链路（经测试主机自身再跳一次）════
      try {
        const jumped = await cdp.eval(INVOKE('ssh', 'connect', {
          connection: {
            ...sshConnection,
            id: `acc-jump-${Date.now().toString(16)}`,
            name: '验收-经跳板机',
            jumpChain: [{
              id: 'hop-1', name: 'hop', host, port, username, authType: 'password', password,
            }],
          },
        }))
        const jid = jumped?.sessionId
        await collect(jid, 1000)
        await cdp.eval(INVOKE('ssh', 'write', { sessionId: jid, data: 'echo JUMP_OK\n' }))
        const jout = await collect(jid, 2500)
        record('2', '跳板机链路：经一跳建立会话',
          jout.includes('JUMP_OK') ? 'PASS' : 'FAIL',
          jout.includes('JUMP_OK') ? '经跳板机连上并收到回显' : `未见回显：${JSON.stringify(jout.slice(0, 120))}`)
      } catch (err) {
        record('2', '跳板机链路', 'FAIL', String(err.message ?? err))
      }

      // ── 纯 UI 层 / 需要外部服务的条目，如实标注 ──
      record('3', '终端搜索/复制/字体/编码/多标签/分屏', 'SKIP',
        '属渲染层交互（已在 UI 侧单独自验），非本脚本的 IPC 链路范围')
      record('2b', 'SOCKS5 代理', 'SKIP', '需要一个外部 SOCKS5 服务端，测试主机不提供')
      record('9', 'AI 助手配 key 对话 + 风险命令拦截', 'SKIP',
        '需要真实 AI 供应商 key（护栏本身已有单测覆盖）')
    }

    // ── 截图（主界面 + 工具页）──
    // ── 截图（主界面 + 工具页）──
    try {
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
      const { writeFileSync } = await import('node:fs')
      writeFileSync('/tmp/acceptance-main.png', Buffer.from(shot.data, 'base64'))
      console.log('\n📸 主界面截图: /tmp/acceptance-main.png')
    } catch {
      /* 截图失败不影响结论 */
    }

    cdp.close()
  } finally {
    // 顺序很重要：**先退出应用，再拆掉 SSH 测试主机**。
    // 反过来等于"把远端从应用脚下抽走" —— 应用在退出路径上还要处理一堆
    // 已经断掉的会话/通道，多了一类无关的失败面（我第一版就是反的）。
    stop()
    await sleep(500)
    globalThis.__sshHostStop?.()
  }

  const fail = results.filter((r) => r.status === 'FAIL')
  const pass = results.filter((r) => r.status === 'PASS')
  const skip = results.filter((r) => r.status === 'SKIP')
  console.log(
    `\n===== 验收汇总：通过 ${pass.length} / 失败 ${fail.length} / 跳过 ${skip.length} =====`,
  )
  if (fail.length > 0) {
    console.log('失败项：')
    for (const f of fail) console.log(`  ❌ [${f.id}] ${f.title} — ${f.detail}`)
    process.exitCode = 1
  }
}

main().catch((err) => {
  console.error('验收运行失败：', err)
  process.exitCode = 1
})
