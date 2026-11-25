// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * `node-pty` 的 Android 替身。
 *
 * 真 node-pty 是 NAN 原生模块：必须按目标 Node 的 NODE_MODULE_VERSION 编译，
 * 且需要那个版本 Node 的完整头文件。Android 上的 Node 来自 Termux，
 * 包里不带头文件 —— 走 addon 等于把移植绑死在一个拿不到的 ABI 上。
 *
 * 所以真实的 pty 在**原生层**：`libt1000pty.so` 直接调 bionic 的
 * openpty/forkpty（见 app/src/main/cpp/t1000_pty.c），本文件只做协议适配，
 * 把 `spawn/onData/write/resize/kill` 翻译成 `/native` 通道上的 RPC。
 *
 * 数据通道的选择：
 * - 输出走原生推送（`pty.data`，base64 原始字节）→ 这里用 StringDecoder
 *   跨帧拼接 UTF-8，避免一个汉字被切成两半时变成替换字符；
 * - 输入走 RPC（`pty.write`）。
 */

import { StringDecoder } from 'node:string_decoder'
import { native } from './native'

/** 信号名 → 数字。Node 侧传的是 'SIGTERM' 这类字符串，原生侧要 int */
const SIGNALS: Record<string, number> = {
  SIGHUP: 1,
  SIGINT: 2,
  SIGQUIT: 3,
  SIGKILL: 9,
  SIGUSR1: 10,
  SIGUSR2: 12,
  SIGTERM: 15,
  SIGWINCH: 28,
}

export interface IPtyForkOptions {
  name?: string
  cols?: number
  rows?: number
  cwd?: string
  env?: Record<string, string>
  encoding?: string | null
}

export interface IExitEvent {
  exitCode: number
  signal?: number
}

export interface IPty {
  readonly pid: number
  readonly process: string
  onData(listener: (data: string) => void): { dispose: () => void }
  onExit(listener: (e: IExitEvent) => void): { dispose: () => void }
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(signal?: string): void
  pause(): void
  resume(): void
  destroy(): void
}

interface Session {
  id: string
  pid: number
  file: string
  decoder: StringDecoder
  dataListeners: Array<(data: string) => void>
  exitListeners: Array<(e: IExitEvent) => void>
  /** spawn 到调用方挂上 onData 之间可能已经有输出（shell 的提示符），先攒着 */
  early: string[]
  exited: boolean
  paused: boolean
}

const sessions = new Map<string, Session>()
let seq = 0
let routed = false

/** 单一入口把原生推送分发给各会话 —— 只注册一次，避免监听器随会话数增长 */
function ensureRouter(): void {
  if (routed) return
  routed = true

  native.on('pty.data', (msg: Record<string, unknown>) => {
    const id = String(msg['id'] ?? '')
    const s = sessions.get(id)
    if (!s) return
    const b64 = String(msg['data'] ?? '')
    if (!b64) return
    const text = s.decoder.write(Buffer.from(b64, 'base64'))
    if (!text) return
    if (s.paused) return
    if (s.dataListeners.length === 0) {
      // 还没有监听者：留住最近 64KB，等 onData 挂上再一次性吐出。
      // 上限防止 shell 一启动就狂打印 + 调用方迟迟不订阅导致内存涨。
      s.early.push(text)
      let total = s.early.reduce((n, t) => n + t.length, 0)
      while (total > 64 * 1024 && s.early.length > 1) {
        total -= s.early.shift()!.length
      }
      return
    }
    for (const cb of s.dataListeners) {
      try {
        cb(text)
      } catch (err) {
        console.error('[node-pty] onData 回调抛错:', err)
      }
    }
  })

  native.on('pty.exit', (msg: Record<string, unknown>) => {
    const id = String(msg['id'] ?? '')
    const s = sessions.get(id)
    if (!s || s.exited) return
    s.exited = true

    // 收尾：把解码器里剩的半个字符吐出来，再通知退出
    const tail = s.decoder.end()
    if (tail && s.dataListeners.length > 0) {
      for (const cb of s.dataListeners) {
        try {
          cb(tail)
        } catch {
          /* 忽略 */
        }
      }
    }
    sessions.delete(id)

    const event: IExitEvent = {
      exitCode: Number(msg['exitCode'] ?? 0),
      ...(typeof msg['signal'] === 'number' ? { signal: Number(msg['signal']) } : {}),
    }
    for (const cb of s.exitListeners) {
      try {
        cb(event)
      } catch (err) {
        console.error('[node-pty] onExit 回调抛错:', err)
      }
    }
  })
}

/**
 * 起一个 pty 会话。
 *
 * 与 node-pty 的差异：**返回 Promise**。桌面端 node-pty 的 spawn 是同步的
 * （底层 forkpty 一次系统调用），而这里要过一次原生通道。主进程的
 * `createNodePtySpawner` 本身是 async 的，它已经用 `await` 兼容两种形态。
 */
export async function spawn(
  file: string,
  args: string[] | readonly string[],
  options: IPtyForkOptions = {},
): Promise<IPty> {
  ensureRouter()

  const id = `pty-${process.pid}-${++seq}`
  const cols = options.cols ?? 80
  const rows = options.rows ?? 24

  const data = await native.call<{ pid: number }>('pty.spawn', {
    id,
    file,
    args: [...args],
    cwd: options.cwd ?? '',
    env: options.env ?? {},
    cols,
    rows,
  })

  const session: Session = {
    id,
    pid: Number(data?.pid ?? -1),
    file,
    decoder: new StringDecoder('utf8'),
    dataListeners: [],
    exitListeners: [],
    early: [],
    exited: false,
    paused: false,
  }
  sessions.set(id, session)

  const pty: IPty = {
    get pid() {
      return session.pid
    },
    process: file,
    onData(listener) {
      session.dataListeners.push(listener)
      // 把早到的输出补发出去（shell 的 banner / 提示符往往就在这段里）
      if (session.early.length > 0) {
        const buffered = session.early.join('')
        session.early.length = 0
        queueMicrotask(() => {
          try {
            listener(buffered)
          } catch (err) {
            console.error('[node-pty] onData 回调抛错:', err)
          }
        })
      }
      return {
        dispose: () => {
          const i = session.dataListeners.indexOf(listener)
          if (i >= 0) session.dataListeners.splice(i, 1)
        },
      }
    },
    onExit(listener) {
      session.exitListeners.push(listener)
      return {
        dispose: () => {
          const i = session.exitListeners.indexOf(listener)
          if (i >= 0) session.exitListeners.splice(i, 1)
        },
      }
    },
    write(input: string) {
      if (session.exited || input.length === 0) return
      const payload = Buffer.from(input, 'utf8').toString('base64')
      // 不等回包：键盘输入是高频路径，等 RPC 会引入可感知的延迟。
      // 真正的失败（会话已死）由 exit 事件告知，不需要每次按键都确认。
      void native.call('pty.write', { id, data: payload }, null).catch(() => {})
    },
    resize(nextCols: number, nextRows: number) {
      if (session.exited) return
      void native.call('pty.resize', { id, cols: nextCols, rows: nextRows }, null).catch(() => {})
    },
    kill(signal?: string) {
      // 与 node-pty 一致：不给信号时发 **SIGHUP**（不是 SIGTERM）。
      // 交互式 shell 会忽略 SIGTERM（那是"请优雅退出"，shell 认为自己在等命令），
      // 只有 SIGHUP 才是"终端没了"的语义，shell 收到才会真的走。
      const num = signal === undefined ? SIGNALS['SIGHUP'] : (SIGNALS[signal.toUpperCase()] ?? 15)
      void native.call('pty.kill', { id, signal: num }, null).catch(() => {})
    },
    pause() {
      // 原生侧目前不做读暂停；置位后丢弃新到数据即可（xterm 的流控语义）
      session.paused = true
    },
    resume() {
      session.paused = false
    },
    destroy() {
      if (session.exited) return
      session.exited = true
      sessions.delete(id)
      void native.call('pty.kill', { id, signal: 9 }, null).catch(() => {})
    },
  }

  return pty
}

/** 与 node-pty 同名的导出，方便主进程无感替换 */
export const pty = { spawn }
export default { spawn }
