// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 回环 WebSocket 桥。
 *
 * 两条通道，职责不重叠：
 *
 * | 路径 | 对端 | 作用 |
 * |---|---|---|
 * | `/ipc` | WebView | 替代 `ipcRenderer.invoke/on`：请求-响应 + 事件推送 |
 * | `/native` | Kotlin 壳 | 反向 RPC：文件选择器、剪贴板、Intent、进程退出 |
 *
 * 为什么用 WebSocket 而不是 `addJavascriptInterface`：
 * - WebView 的 JS 接口调用是**同步阻塞**主线程的，且传参会被转成字符串，
 *   大载荷（终端输出、wasm 字节）会把 UI 卡住；
 * - WS 天然支持流式与并发请求，且渲染层注入的代码里可以直接用原生
 *   `WebSocket`，不需要为每次调用穿越 JNI；
 * - 请求可以带 id 并发，`ipcRenderer.invoke` 的 Promise 语义能原样保留。
 *
 * 安全：只 bind `127.0.0.1`，且必须携带 token（Kotlin 启动时生成的一次性随机串）。
 * Android 上任何 App 都能连 loopback，没有 token 等于把整台设备的 SSH 凭据
 * 暴露给同机任意程序。token 校验失败直接 destroy socket，不回任何信息。
 */

import { createServer, type Server } from 'node:http'
import { WebSocketServer, type WebSocket } from 'ws'
import { IPC_CHANNEL } from '@t1000/shared'
import { BRIDGE_PORT, BRIDGE_TOKEN } from '../env'
import { invokeChannel } from '../shim/ipc'
import { setEventSink } from '../shim/outbound'
import { native } from '../shim/native'

interface WebviewMessage {
  type?: string
  id?: number
  req?: unknown
}

const webviewClients = new Set<WebSocket>()

let httpServer: Server | null = null

/** 解析 query 里的 token（不依赖 URL 解析失败就放弃） */
function tokenOf(url: string): string | null {
  const q = url.indexOf('?')
  if (q < 0) return null
  const params = new URLSearchParams(url.slice(q + 1))
  return params.get('token')
}

function pathOf(url: string): string {
  const q = url.indexOf('?')
  return q < 0 ? url : url.slice(0, q)
}

function rejectUpgrade(socket: NodeJS.WritableStream & { destroy?: () => void }): void {
  // 不写任何 HTTP 响应体：连错误细节都不给，避免被用来探测
  socket.destroy?.()
}

async function handleWebviewMessage(socket: WebSocket, raw: string): Promise<void> {
  let msg: WebviewMessage
  try {
    msg = JSON.parse(raw) as WebviewMessage
  } catch {
    return
  }
  if (msg.type !== 'invoke' || typeof msg.id !== 'number') return

  const id = msg.id
  let res: unknown
  try {
    res = await invokeChannel(IPC_CHANNEL, [msg.req])
  } catch (err) {
    res = {
      ok: false,
      error: {
        code: 'INTERNAL',
        message: err instanceof Error ? err.message : String(err),
      },
    }
  }
  if (socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify({ type: 'response', id, res }))
  }
}

/**
 * 启动桥。
 *
 * @returns 实际监听端口（传 0 时由系统分配）
 */
export async function startBridge(): Promise<number> {
  const server = createServer((_req, res) => {
    // HTTP 面不提供任何内容：只有 WS 升级是合法入口
    res.writeHead(404).end()
  })
  httpServer = server

  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 })

  server.on('upgrade', (req, socket, head) => {
    const url = req.url ?? '/'
    if (tokenOf(url) !== BRIDGE_TOKEN) {
      console.warn('[bridge] 拒绝了一个 token 不匹配的连接')
      rejectUpgrade(socket)
      return
    }

    const path = pathOf(url)
    if (path !== '/ipc' && path !== '/native') {
      rejectUpgrade(socket)
      return
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      if (path === '/ipc') {
        webviewClients.add(ws)
        console.log(`[bridge] WebView 已连接（当前 ${webviewClients.size} 条）`)
        ws.on('message', (data: Buffer | string) => {
          void handleWebviewMessage(ws, data.toString())
        })
        ws.on('close', () => {
          webviewClients.delete(ws)
          console.log(`[bridge] WebView 断开（剩 ${webviewClients.size} 条）`)
        })
        ws.on('error', (err: Error) => console.error('[bridge] WebView 通道错误:', err.message))
      } else {
        console.log('[bridge] Kotlin 原生通道已连接')
        native.attach(ws)
      }
    })
  })

  // 事件出口：主进程所有 webContents.send / broadcast 最终都到这里
  setEventSink((event, payload) => {
    const frame = JSON.stringify({ type: 'event', event, payload })
    for (const ws of webviewClients) {
      if (ws.readyState === ws.OPEN) ws.send(frame)
    }
  })

  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject)
    // 只绑回环：绝不对局域网暴露（平板经常连公共 Wi-Fi）
    server.listen(BRIDGE_PORT, '127.0.0.1', () => {
      const addr = server.address()
      if (addr && typeof addr === 'object') resolve(addr.port)
      else reject(new Error('无法获取桥的监听端口'))
    })
  })

  console.log(`[bridge] 监听 127.0.0.1:${port}`)
  return port
}

export async function stopBridge(): Promise<void> {
  for (const ws of webviewClients) {
    try {
      ws.close()
    } catch {
      /* 已关闭 */
    }
  }
  webviewClients.clear()
  setEventSink(null)
  await new Promise<void>((resolve) => {
    if (!httpServer) return resolve()
    httpServer.close(() => resolve())
    httpServer = null
  })
}

/** 诊断用：当前有几条 WebView 连接 */
export function webviewConnectionCount(): number {
  return webviewClients.size
}
