/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (C) 2026 terminal-1000 contributors
 *
 * 渲染层的桥（替代 Electron preload 的 contextBridge）。
 *
 * 在 WebView 里于**任何页面脚本之前**注入：Kotlin 用
 * `WebViewCompat.addDocumentStartJavaScript()` 把它塞进去，并把
 * `__T1000_CONFIG__` 替换成真实的 `{ port, token, testHook }`。
 *
 * 契约与 preload 完全一致（见 apps/desktop/src/preload/index.ts）：
 *   invoke(domain, action, payload) -> Promise<IpcResponse>
 *   on(event, listener)             -> unsubscribe
 *   platform                        -> 同步可得
 *
 * 两个刻意的设计：
 * 1. **不抛错，只返回失败响应**。渲染层大量代码是
 *    `const r = await invoke(...); if (!r.ok) ...`，如果这里 reject，
 *    那些地方会变成未捕获异常而不是走它们的错误分支。
 * 2. **自动重连**。Node 侧可能因为内存压力被系统回收重启，
 *    重连后渲染层不必刷新页面就能继续用（请求会排队等待）。
 */
;(function () {
  'use strict'

  var CFG = window.__T1000_CONFIG__ || {}

  /**
   * 配置必须**每次连接时重读**，不能在脚本加载时缓存。
   *
   * 原因：端口是 Node 起来之后才知道的（由系统分配，写进 bridge.json），
   * 而 Nodse 进程被系统回收重启后端口还会变。桥脚本在文档开始执行，
   * 那一刻 window.__T1000_CONFIG__ 可能是空的；如果此时把 PORT 存成变量，
   * 后面就算 Kotlin 把配置补上也没用了 —— 表现为"界面全是空列表 +
   * 控制台一行 '桥配置缺失'"，而 Node 其实活得好好的。
   */
  function config() {
    var c = window.__T1000_CONFIG__ || CFG || {}
    return { port: c.port, token: c.token, testHook: c.testHook }
  }

  function ipcUrl() {
    var c = config()
    return 'ws://127.0.0.1:' + c.port + '/ipc?token=' + encodeURIComponent(c.token || '')
  }

  var ws = null
  var nextId = 1
  var pending = {}
  var listeners = {}
  var outbox = []
  var connected = false
  var reconnectDelay = 200
  var warnedNoPort = false

  /** 请求超时：比主进程最长动作（备份/大批量 ping）略宽裕 */
  var INVOKE_TIMEOUT_MS = 120000

  function connect() {
    if (!config().port) {
      // 没有端口说明壳还没把配置注进来（Node 还在启动）。给一行能看懂的日志，
      // 然后退避重试 —— 不 return 死等，否则配置补上了也连不上。
      if (!warnedNoPort) {
        warnedNoPort = true
        console.error('[t1000] 桥配置暂缺（等待 Node 端口就绪），稍后自动重试')
      }
      scheduleReconnect()
      return
    }
    try {
      ws = new WebSocket(ipcUrl())
    } catch (err) {
      console.error('[t1000] 建立桥连接失败:', err)
      scheduleReconnect()
      return
    }

    ws.onopen = function () {
      connected = true
      reconnectDelay = 200
      var queued = outbox
      outbox = []
      for (var i = 0; i < queued.length; i++) ws.send(queued[i])
    }

    ws.onmessage = function (ev) {
      var msg
      try {
        msg = JSON.parse(ev.data)
      } catch (e) {
        return
      }
      if (msg.type === 'response') {
        var entry = pending[msg.id]
        if (!entry) return
        delete pending[msg.id]
        if (entry.timer) clearTimeout(entry.timer)
        entry.resolve(msg.res)
        return
      }
      if (msg.type === 'event') {
        var set = listeners[msg.event]
        if (!set) return
        for (var i = 0; i < set.length; i++) {
          try {
            set[i](msg.payload)
          } catch (err) {
            // 单个订阅者出错不该影响其它订阅者（终端数据流有多个消费方）
            console.error('[t1000] 事件 ' + msg.event + ' 的监听器抛错:', err)
          }
        }
      }
    }

    ws.onclose = function () {
      connected = false
      ws = null
      scheduleReconnect()
    }

    ws.onerror = function () {
      // onerror 后一定跟着 onclose，重连逻辑放 onclose 里即可
    }
  }

  function scheduleReconnect() {
    // 指数退避，封顶 3s：Node 重启通常在 1s 内完成，太快会刷日志
    setTimeout(connect, reconnectDelay)
    reconnectDelay = Math.min(reconnectDelay * 2, 3000)
  }

  function send(text) {
    if (connected && ws && ws.readyState === 1) ws.send(text)
    else outbox.push(text)
  }

  function invoke(domain, action, payload) {
    return new Promise(function (resolve) {
      var id = nextId++
      var timer = setTimeout(function () {
        if (!pending[id]) return
        delete pending[id]
        resolve({
          ok: false,
          error: { code: 'TIMEOUT', message: '主进程响应超时（' + domain + '.' + action + '）' },
        })
      }, INVOKE_TIMEOUT_MS)

      pending[id] = { resolve: resolve, timer: timer }
      send(JSON.stringify({ type: 'invoke', id: id, req: { domain: domain, action: action, payload: payload } }))
    })
  }

  function on(event, listener) {
    var set = listeners[event]
    if (!set) {
      set = []
      listeners[event] = set
    }
    set.push(listener)
    return function unsubscribe() {
      var idx = set.indexOf(listener)
      if (idx >= 0) set.splice(idx, 1)
    }
  }

  var bridge = {
    invoke: invoke,
    on: on,
    // 渲染层用它做平台分支（如隐藏"最小化到托盘"这类桌面专有项）
    platform: 'android',
    /** 运行时读取，与 port/token 同理：配置可能晚于本脚本注入 */
    get testHook() {
      return config().testHook === true
    },
    /** 诊断用：桥当前是否连着（设置页"诊断"可以读它） */
    get connected() {
      return connected
    },
  }

  // 冻结：渲染层不该改写桥本身（改写只会让问题更难查）
  try {
    Object.freeze(bridge)
  } catch (e) {
    /* 忽略 */
  }

  window.t1000 = bridge

  connect()

  // 页面卸载时主动断开，避免 WebView 反复创建导致旧连接堆积
  window.addEventListener('pagehide', function () {
    if (ws) {
      try {
        ws.close()
      } catch (e) {
        /* 忽略 */
      }
    }
  })
})()
