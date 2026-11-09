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
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const DESKTOP = new URL('..', import.meta.url).pathname
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

    // 需要真实 SSH 主机的条目
    for (const [id, title] of [
      ['1', 'SSH 连接出终端'],
      ['2', '跳板机链路 + SOCKS5 代理'],
      ['3', '终端搜索/复制/字体/编码/多标签/分屏'],
      ['4', 'SFTP 上传下载（含递归/进度/取消）'],
      ['5', '端口转发实际生效（本地/远程/动态）'],
      ['9', 'AI 助手配 key 对话 + 风险命令拦截'],
      ['11', '列表 ping 延迟与硬件信息 + 监控卡片出数据'],
      ['13', '并发广播一次输入多处执行'],
    ]) {
      record(id, title, 'SKIP', '需要真实 SSH 主机（scripts/ssh-test-host.mjs 就绪后补）')
    }

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
    stop()
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
