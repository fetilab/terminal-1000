// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 真机/模拟器验收：通过 WebView 的 CDP 通道驱动**已经跑在 Android 上**的界面。
 *
 * 与 verify-renderer.mjs 的区别：
 * - 那个脚本在开发机上用 Electron 当 Chromium，验证"渲染层能在没有 preload 的
 *   环境里跑起来"；
 * - 这个脚本连的是设备上真实的 WebView（`adb forward tcp:9222
 *   localabstract:webview_devtools_remote_<pid>`），验证的是**整条链路**：
 *   WebView → 回环 WS → node-host → 主进程 → SQLite/SQL 与资源路径，
 *   以及 Kotlin 壳注入的桥配置是否正确。
 *
 * 用法：
 *   1. 设备/模拟器上启动 App；
 *   2. adb forward tcp:9222 localabstract:webview_devtools_remote_<pid>
 *   3. node scripts/verify-device.mjs [--cdp http://127.0.0.1:9222] [--shot out.png]
 *
 * 退出码非 0 表示有用例失败，可直接进 CI。
 */

import { writeFileSync } from 'node:fs'
import { WebSocket } from 'ws'

const args = process.argv.slice(2)
const argOf = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}

const CDP = argOf('--cdp', process.env.T1000_CDP || 'http://127.0.0.1:9222')
const SHOT = argOf('--shot', '')

const pass = []
const fail = []
const ok = (m) => {
  pass.push(m)
  console.log(`  ✓ ${m}`)
}
const bad = (m, detail) => {
  fail.push(m + (detail ? `：${detail}` : ''))
  console.log(`  ✗ ${m}${detail ? `：${detail}` : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 连上页面 target，返回一个极简 CDP 客户端 */
async function connect() {
  const res = await fetch(`${CDP}/json`)
  const targets = await res.json()
  const page = targets.find((t) => t.type === 'page')
  if (!page) throw new Error('没有找到 WebView 页面（App 是否在前台？）')

  const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false })
  await new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })

  let id = 0
  const pending = new Map()
  const consoleErrors = []

  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString())
    if (msg.id && pending.has(msg.id)) {
      const { resolve: r } = pending.get(msg.id)
      pending.delete(msg.id)
      r(msg)
      return
    }
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      consoleErrors.push(
        msg.params.args
          .map((a) => a.value ?? a.description ?? a.type)
          .join(' ')
          .slice(0, 300),
      )
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      consoleErrors.push('uncaught: ' + (msg.params.exceptionDetails?.text ?? '') )
    }
  })

  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const mid = ++id
      pending.set(mid, { resolve })
      ws.send(JSON.stringify({ id: mid, method, params }))
    })

  await send('Runtime.enable')
  await send('Page.enable')

  /** 在页面里求值（支持 await），返回反序列化后的值 */
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    })
    if (r.result?.exceptionDetails) {
      throw new Error(r.result.exceptionDetails.text + ' ' + (r.result.exceptionDetails.exception?.description ?? ''))
    }
    if (r.error) throw new Error(r.error.message)
    return r.result?.result?.value
  }

  return { ws, send, evaluate, consoleErrors, page }
}

/** 生成一段"调 IPC 并返回结果"的表达式 */
const ipc = (domain, action, payload = '{}') =>
  `(async () => { const r = await window.t1000.invoke(${JSON.stringify(domain)}, ${JSON.stringify(action)}, ${payload}); return r })()`

/** 轮询等页面里的某个表达式变真 */
async function waitFor(c, expression, timeoutMs = 10000, intervalMs = 200) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const v = await c.evaluate(expression)
    if (v) return v
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  return null
}

/**
 * 本地终端：这是整个移植里唯一"没有现成实现可复用"的部分。
 *
 * 桌面端靠 node-pty（NAN 原生模块）。Android 上的 Node 来自 Termux、不带头文件，
 * addon 路线走不通，所以真实 pty 在原生层（libt1000pty.so → bionic forkpty），
 * Node 侧只有一个转接替身。这里逐层验收：探测 shell → 开会话 → 输入输出往返
 * → 改尺寸 → 关闭并拿到退出事件。
 */
async function verifyPty(c) {
  const shellsRes = await c.evaluate(ipc('pty', 'listShells'))
  // listShells 直接返回数组（不是 {sessions} 这类包一层）
  const found = Array.isArray(shellsRes?.data) ? shellsRes.data : []
  // Android 上 /bin 是指向 /system/bin 的软链，两条路径都对；
  // 探测按名字去重，先命中的是 /bin/sh，所以不能只认 /system/bin
  const shPaths = found.map((s) => String(s.path ?? s))
  const hasSystem = shPaths.some((p) => p === '/system/bin/sh' || p === '/bin/sh')
  hasSystem
    ? ok(`pty.listShells 找到 ${found.length} 个：${shPaths.join(', ')}`)
    : bad('没发现 Android 系统 shell', JSON.stringify(shellsRes).slice(0, 300))

  // 先挂事件监听，再开会话：shell 的提示符可能在 open 返回之前就刷出来了
  await c.evaluate(`(() => {
    window.__ptyTest = { data: '', exits: [], id: null }
    window.t1000.on('PTY_DATA', (e) => {
      if (!window.__ptyTest.id || e.ptyId === window.__ptyTest.id) window.__ptyTest.data += e.data
    })
    window.t1000.on('PTY_EXIT', (e) => { window.__ptyTest.exits.push(e) })
    return true
  })()`)

  // 显式指定系统 shell：这一节验的是原生 pty 本身（链路 + 流控 + 信号），
  // 走 proot 会引入 alpine 的启动开销与额外变量。Alpine 在 G2 单独验。
  const openRes = await c.evaluate(
    ipc('pty', 'open', JSON.stringify({ shell: '/system/bin/sh', cols: 100, rows: 30 })),
  )
  // open 返回的是扁平的 PtyOpenResult
  const info = openRes?.data
  const ptyId = info?.ptyId
  if (!openRes?.ok || !ptyId) {
    bad('pty.open 失败（原生 pty 起不来）', JSON.stringify(openRes).slice(0, 400))
    return
  }
  await c.evaluate(`window.__ptyTest.id = ${JSON.stringify(ptyId)}; true`)
  ok(`pty.open 成功：${ptyId} pid=${info.pid} shell=${info.shell} ${info.cols}x${info.rows}`)

  // 提示符应该自己刷出来（证明读取线程 → 原生通道 → 渲染层这条链路是通的）
  const banner = await waitFor(c, 'window.__ptyTest.data.length > 0', 6000)
  banner ? ok(`收到 shell 输出 ${String(banner)} 字节`) : bad('6 秒内没有收到任何 pty 输出')

  // 输入 → 执行 → 回显：用 $((6*7)) 让 shell 自己算一遍，
  // 避免"只是把输入回显了"这种假通过
  await c.evaluate(
    ipc('pty', 'write', JSON.stringify({ ptyId, data: "printf 'T1000-%s\\n' $((6*7))\r" })),
  )
  const marker = await waitFor(c, "window.__ptyTest.data.includes('T1000-42')", 8000)
  marker ? ok('输入往返正常（shell 执行命令并把结果回显）') : bad('命令没有回显', '（收到：' + (await c.evaluate('window.__ptyTest.data.slice(-200)')) + '）')

  const resized = await c.evaluate(ipc('pty', 'resize', JSON.stringify({ ptyId, cols: 132, rows: 43 })))
  resized?.ok ? ok('pty.resize 成功') : bad('pty.resize 失败', JSON.stringify(resized).slice(0, 200))

  // 关闭：必须收到退出事件，否则界面上的终端会一直挂着"运行中"
  await c.evaluate(ipc('pty', 'close', JSON.stringify({ ptyId })))
  const exited = await waitFor(c, 'window.__ptyTest.exits.length > 0', 8000)
  exited
    ? ok(`pty.close 后收到退出事件 ${JSON.stringify(await c.evaluate('window.__ptyTest.exits[0]'))}`)
    : bad('关闭后没有退出事件（会话状态会卡住）')
}

/**
 * Alpine（proot）环境验收。
 *
 * 这一节回答三个问题，缺一不可：
 * 1. **profile 有没有**：rootfs 解包好了、proot 与 loader 都在 nativeLibraryDir；
 * 2. **proot 起得来**：libproot.so 能 exec、loader 能被它找到、依赖库能解析；
 * 3. **guest 里是真 Alpine**：不是宿主 shell 伪装 —— 用 `cat /etc/alpine-release`
 *    读文件内容来判断，而不是看 `uname`（uname 在 proot 里返回宿主内核，
 *    拿它当判据会"用 mksh 也能通过"）。
 */
async function verifyAlpine(c) {
  const profilesRes = await c.evaluate(ipc('pty', 'listProfiles'))
  const profiles = Array.isArray(profilesRes?.data) ? profilesRes.data : []
  const alpine = profiles.find((p) => p?.id === 'alpine')
  if (!alpine) {
    bad(
      'pty.listProfiles 里没有 Alpine 配置',
      '（rootfs 没解包好，或 libproot.so / libproot-loader.so 不在 nativeLibraryDir）',
    )
    return
  }
  ok(`Alpine 配置存在：${alpine.name} shell=${alpine.shell}`)
  alpine.shell.endsWith('libproot.so')
    ? ok('Alpine 用的是 proot（不是宿主 shell 冒充）')
    : bad('Alpine 配置的 shell 不是 proot', String(alpine.shell))

  // 先挂监听再开会话：proot 的启动输出可能早于 open 返回
  await c.evaluate(`(() => {
    window.__alpineTest = { data: '', exits: [], id: null }
    window.t1000.on('PTY_DATA', (e) => {
      if (!window.__alpineTest.id || e.ptyId === window.__alpineTest.id) window.__alpineTest.data += e.data
    })
    window.t1000.on('PTY_EXIT', (e) => { window.__alpineTest.exits.push(e) })
    return true
  })()`)

  // 不带 shell 参数：Android 上应默认选 Alpine（rootfs 没就绪才回退系统 shell）
  const openRes = await c.evaluate(ipc('pty', 'open', JSON.stringify({ cols: 100, rows: 30 })))
  const info = openRes?.data
  const ptyId = info?.ptyId
  if (!openRes?.ok || !ptyId) {
    bad('Alpine 终端打不开', JSON.stringify(openRes).slice(0, 400))
    return
  }
  await c.evaluate(`window.__alpineTest.id = ${JSON.stringify(ptyId)}; true`)
  ok(`默认本地终端走的是 ${info.shell.split('/').pop()}（pid=${info.pid}）`)

  const started = await waitFor(c, 'window.__alpineTest.data.length > 0', 20000)
  started ? ok(`proot 启动并产生输出 ${started} 字节`) : bad('20 秒内 proot 没有任何输出')

  // 读 guest 里的真实文件：这是"真的进了 Alpine"最硬的证据。
  //
  // 每个值都带独立前缀。不能用「按 sentinel 切分再取前半段」那种写法：
  // 终端会把敲进去的命令回显一遍，于是 sentinel 在回显里就出现了一次，
  // split() 恰好把真正的输出全切掉，断言只能拿到命令原文。
  // 换成 `sed 's/^/TAG:/'` 把标记打在**数据行首**，解析就与回显无关。
  await c.evaluate(
    ipc('pty', 'write', JSON.stringify({
      ptyId,
      data:
        "sed 's/^/T1000-VER:/' /etc/alpine-release; " +
        "echo T1000-UID:$(id -u); " +
        'echo T1000-ALPINE-OK\r',
    })),
  )
  const rel = await waitFor(c, 'window.__alpineTest.data.includes("T1000-ALPINE-OK")', 20000)
  const dump = String(await c.evaluate('window.__alpineTest.data'))
  if (rel) {
    const version = /T1000-VER:(\d+\.\d+\.\d+)/.exec(dump)
    version
      ? ok(`guest 是 Alpine ${version[1]}（cat /etc/alpine-release 读到了）`)
      : bad('guest 里读不到 /etc/alpine-release', dump.slice(-300))
    // fake root：proot -0 让 id -u 返回 0，`apk add` 才不需要 sudo
    const uid = /T1000-UID:(\d+)/.exec(dump)
    uid && uid[1] === '0'
      ? ok('guest 内 id -u = 0（proot 的假 root 生效）')
      : bad('guest 内不是 root', dump.slice(-300))
  } else {
    bad('Alpine 终端没有响应命令', dump.slice(-300))
  }

  // apk 是 Alpine 的包管理器：能跑说明动态链接、/proc、musl 一整套都是通的
  await c.evaluate(ipc('pty', 'write', JSON.stringify({ ptyId, data: "apk --version 2>&1 | head -1; echo T1000-APK-DONE\r" })))
  const apkDone = await waitFor(c, 'window.__alpineTest.data.includes("T1000-APK-DONE")', 20000)
  const apkOut = String(await c.evaluate('window.__alpineTest.data'))
  if (apkDone && /apk-tools/i.test(apkOut)) ok('apk 包管理器可用（apk-tools 已就绪）')
  else if (apkDone) bad('apk 不可用', apkOut.slice(-200))
  else bad('apk --version 无响应')

  await c.evaluate(ipc('pty', 'close', JSON.stringify({ ptyId })))
  const exited = await waitFor(c, 'window.__alpineTest.exits.length > 0', 20000)
  exited
    ? ok(`Alpine 会话正常退出 ${JSON.stringify(await c.evaluate('window.__alpineTest.exits[0]'))}`)
    : bad('关闭 Alpine 会话后没有退出事件（proot 可能留下了孤儿进程）')
}

async function main() {
  console.log('=== Android 真机验收（WebView + 回环桥 + 主进程）===\n')
  const c = await connect()
  console.log(`  页面: ${c.page.title} — ${c.page.url}\n`)

  console.log('A 桥注入与平台识别')
  const platform = await c.evaluate('window.t1000 && window.t1000.platform')
  platform === 'android' ? ok(`window.t1000.platform = ${platform}`) : bad('桥未注入', String(platform))

  const hasInvoke = await c.evaluate('typeof window.t1000.invoke === "function"')
  hasInvoke ? ok('invoke 是函数（不是占位对象）') : bad('invoke 不可用')

  console.log('\nB 基础 IPC 域')
  const info = await c.evaluate(ipc('app', 'getInfo'))
  if (info?.ok) {
    const p = info.data?.platform ?? info.data?.info?.platform
    p === 'android' ? ok(`app.getInfo → platform=${p}`) : bad('getInfo 平台不对', JSON.stringify(info.data).slice(0, 200))
  } else {
    bad('app.getInfo 失败', JSON.stringify(info).slice(0, 200))
  }

  const paths = await c.evaluate(ipc('app', 'getPaths'))
  if (paths?.ok) {
    const ud = paths.data?.userData ?? paths.data?.paths?.userData ?? ''
    // 注意：正则字面量不能写在行首 —— 上一行结尾是表达式，JS 会把 `/` 当除号
    const udOk = /dev\.t1000\.android/.test(ud)
    udOk ? ok(`app.getPaths 数据目录在应用私有目录：${ud}`) : bad('数据目录不对', String(ud))
  } else {
    bad('app.getPaths 失败', JSON.stringify(paths).slice(0, 200))
  }

  console.log('\nC 资源定位（process.resourcesPath 伪造是否生效）')
  const wasm = await c.evaluate(ipc('app', 'kittyWasm'))
  if (wasm?.ok) {
    const size = wasm.data?.size ?? wasm.data?.bytes ?? wasm.data?.length ?? 0
    size > 100_000 ? ok(`app.kittyWasm 读到 ${Math.round(size / 1024)} KB`) : bad('wasm 太小或路径不对', JSON.stringify(wasm.data).slice(0, 200))
  } else {
    bad('app.kittyWasm 失败', JSON.stringify(wasm).slice(0, 200))
  }

  console.log('\nD 设置域（读 + 写 + 持久化）')
  const settings = await c.evaluate(ipc('settings', 'getAll'))
  settings?.ok ? ok('settings.getAll 可读') : bad('settings.getAll 失败', JSON.stringify(settings).slice(0, 200))

  const written = await c.evaluate(ipc('settings', 'set', JSON.stringify({ path: 'terminal.fontSize', value: 18 })))
  written?.ok ? ok('settings.set 写入成功') : bad('settings.set 失败', JSON.stringify(written).slice(0, 200))
  const reread = await c.evaluate(ipc('settings', 'getAll'))
  const fs18 = JSON.stringify(reread?.data ?? {}).includes('18')
  fs18 ? ok('设置持久化（重新读取得到 18）') : bad('设置未持久化')

  console.log('\nE 存储域（Android 上跑的是 node:sqlite，不是 better-sqlite3）')
  const testId = 'verify-' + Date.now()
  const conn = JSON.stringify({
    kind: 'ssh',
    id: testId,
    name: '验收连接（请忽略）',
    host: '192.0.2.10', // RFC 5737 文档保留段，不指向任何真实主机
    port: 22,
    username: 'verify',
    authType: 'password',
    password: 'not-a-real-password',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  })
  // 注意：store.saveConnection 的 payload 就是连接对象本身（不是 { connection }），
  // 写错会被 zod 打回"id/name/kind Required"——看起来像桥断了，其实只是形状不对
  const saved = await c.evaluate(ipc('store', 'saveConnection', conn))
  if (saved?.ok) {
    ok('store.saveConnection 写入成功（SQLite 建表 + upsert）')
    const list = await c.evaluate(ipc('store', 'listConnections'))
    const arr = list?.data?.connections ?? list?.data ?? []
    const found = Array.isArray(arr) && arr.some((x) => x.id === testId)
    found ? ok(`store.listConnections 读回 ${arr.length} 条，含刚写入的`) : bad('写入后读不回来', JSON.stringify(list).slice(0, 300))
    // 清理：不留脏数据给用户
    const del = await c.evaluate(ipc('store', 'deleteConnection', `{ id: ${JSON.stringify(testId)} }`))
    del?.ok ? ok('store.deleteConnection 清理完成') : bad('清理失败（会留一条测试数据）', JSON.stringify(del).slice(0, 200))
  } else {
    bad('store.saveConnection 失败（SQLite 桥没通？）', JSON.stringify(saved).slice(0, 300))
  }

  console.log('\nF 界面渲染')
  const text = await c.evaluate('document.body.innerText')
  const hasUi = typeof text === 'string' && text.length > 20
  hasUi ? ok(`界面有可见文案（${text.replace(/\s+/g, ' ').slice(0, 40)}…）`) : bad('界面空白')
  const railed = await c.evaluate('!!document.querySelector(".rail") || !!document.querySelector("#root > *")')
  railed ? ok('React 已挂载（存在根节点结构）') : bad('React 未挂载')

  console.log('\nG 本地终端（原生 pty）')
  await verifyPty(c)

  console.log('\nG2 Alpine（proot + rootfs）')
  await verifyAlpine(c)

  console.log('\nH 运行时错误')
  const errs = c.consoleErrors.filter((e) => !/favicon/i.test(e))
  errs.length === 0 ? ok('控制台没有 error 级输出') : bad(`控制台有 ${errs.length} 条 error`, errs.slice(0, 3).join(' | '))

  if (SHOT) {
    const shot = await c.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
    const data = shot.result?.data
    if (data) {
      writeFileSync(SHOT, Buffer.from(data, 'base64'))
      ok(`已截图 ${SHOT}`)
    } else {
      bad('截图失败')
    }
  }

  c.ws.close()

  console.log('\n=== 结果 ===')
  console.log(`通过 ${pass.length} 项，失败 ${fail.length} 项`)
  if (fail.length) {
    console.log('\n失败项：')
    for (const f of fail) console.log('  - ' + f)
    process.exit(1)
  }
  console.log('\n全部通过。整条链路（WebView → 桥 → node-host → 主进程）可用。')
}

main().catch((err) => {
  console.error('验收脚本异常:', err)
  process.exit(2)
})
