// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * VNC 会话管理单测：用**假 socket** 驱动完整 RFB 握手与帧更新，不连任何真实服务端。
 *
 * 这里验证的是「socket 壳 + 事件转换」这一层：状态流转、事件载荷形状、
 * viewOnly 门控、握手超时、断开清理 —— 协议细节在 rfb.test.ts。
 */

import { describe, expect, it } from 'vitest'
import type { ConnectionState, VncConnection } from '@t1000/shared'
import { AppError } from '../../errors'
import {
  VncManager,
  type RfbSocket,
  type VncEventSink,
  type VncFrame,
  type VncTimer,
} from './index'
import { PREFERRED_PIXEL_FORMAT, encodePixelFormat, vncEncryptChallenge } from './rfb'

// ---------------------------------------------------------------------------
// 假 socket
// ---------------------------------------------------------------------------

class FakeSocket {
  readonly written: Buffer[] = []
  ended = false
  destroyed = false
  private readonly listeners = new Map<string, Array<(arg?: never) => void>>()

  write(data: Buffer): boolean {
    this.written.push(Buffer.from(data))
    return true
  }

  end(): void {
    this.ended = true
  }

  destroy(): void {
    this.destroyed = true
    this.emit('close')
  }

  on(event: string, listener: (arg?: never) => void): this {
    const list = this.listeners.get(event) ?? []
    list.push(listener)
    this.listeners.set(event, list)
    return this
  }

  emit(event: 'connect' | 'data' | 'error' | 'close', arg?: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) {
      ;(listener as unknown as (value?: unknown) => void)(arg)
    }
  }

  /** 本次写入的全部字节拼起来（便于断言握手报文） */
  allWritten(): Buffer {
    return Buffer.concat(this.written)
  }
}

/** 手动定时器：用于精确触发握手超时 */
class FakeTimer implements VncTimer {
  private seq = 0
  private readonly callbacks = new Map<number, () => void>()

  setTimeout(fn: () => void, _ms: number): unknown {
    const id = ++this.seq
    this.callbacks.set(id, fn)
    return id
  }

  clearTimeout(handle: unknown): void {
    if (typeof handle === 'number') this.callbacks.delete(handle)
  }

  get pending(): number {
    return this.callbacks.size
  }

  fire(): void {
    const fns = [...this.callbacks.values()]
    this.callbacks.clear()
    for (const fn of fns) fn()
  }
}

interface Recorder extends VncEventSink {
  states: Array<{ sessionId: string; state: ConnectionState; message?: string }>
  frames: Array<{ sessionId: string; frame: VncFrame }>
  clips: Array<{ sessionId: string; text: string }>
  bells: string[]
  errors: Array<{ sessionId: string; message: string }>
}

function recorder(): Recorder {
  const states: Recorder['states'] = []
  const frames: Recorder['frames'] = []
  const clips: Recorder['clips'] = []
  const bells: string[] = []
  const errors: Recorder['errors'] = []
  return {
    states,
    frames,
    clips,
    bells,
    errors,
    state: (sessionId, state, message) =>
      states.push(message === undefined ? { sessionId, state } : { sessionId, state, message }),
    frame: (sessionId, frame) => frames.push({ sessionId, frame }),
    clipboard: (sessionId, text) => clips.push({ sessionId, text }),
    bell: (sessionId) => bells.push(sessionId),
    error: (sessionId, message) => errors.push({ sessionId, message }),
  }
}

function setup(options: { authType?: 'none' | 'vnc-password'; password?: string; viewOnly?: boolean } = {}) {
  const sink = recorder()
  const timer = new FakeTimer()
  const sockets: FakeSocket[] = []
  const manager = new VncManager({
    sink,
    timer,
    createSocket: () => {
      const socket = new FakeSocket()
      sockets.push(socket)
      return socket as unknown as RfbSocket
    },
  })
  const connection: VncConnection = {
    kind: 'vnc',
    id: 'v1',
    name: 'test',
    host: '127.0.0.1',
    port: 5900,
    authType: options.authType ?? 'none',
    ...(options.password === undefined ? {} : { password: options.password }),
    ...(options.viewOnly === undefined ? {} : { viewOnly: options.viewOnly }),
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
  return { manager, sink, timer, sockets, connection }
}

// ---------------------------------------------------------------------------
// 样本字节流
// ---------------------------------------------------------------------------

const serverVersion = (): Buffer => Buffer.from('RFB 003.008\n', 'latin1')

function serverInit(width: number, height: number, name = 'desk'): Buffer {
  const nameBuf = Buffer.from(name, 'utf8')
  const buf = Buffer.alloc(24 + nameBuf.length)
  buf.writeUInt16BE(width, 0)
  buf.writeUInt16BE(height, 2)
  encodePixelFormat(PREFERRED_PIXEL_FORMAT).copy(buf, 4)
  buf.writeUInt32BE(nameBuf.length, 20)
  nameBuf.copy(buf, 24)
  return buf
}

function securityResultOk(): Buffer {
  return Buffer.from([0, 0, 0, 0])
}

/** 32bpp BGRA 小端像素 */
const bgra = (r: number, g: number, b: number): Buffer => Buffer.from([b, g, r, 0])

function rawFrame(x: number, y: number, w: number, h: number, pixels: Buffer): Buffer {
  const header = Buffer.alloc(4 + 12)
  header.writeUInt8(0, 0)
  header.writeUInt16BE(1, 2)
  header.writeUInt16BE(x, 4)
  header.writeUInt16BE(y, 6)
  header.writeUInt16BE(w, 8)
  header.writeUInt16BE(h, 10)
  header.writeInt32BE(0, 12) // Raw
  return Buffer.concat([header, pixels])
}

/** 走完「None 认证」握手 */
function driveHandshake(socket: FakeSocket): void {
  socket.emit('data', serverVersion())
  socket.emit('data', Buffer.from([1, 1])) // 1 个安全类型：None
  socket.emit('data', securityResultOk())
  socket.emit('data', serverInit(640, 480, 'my-desktop'))
}

// ---------------------------------------------------------------------------
// 状态与握手
// ---------------------------------------------------------------------------

describe('VncManager：连接与状态流转', () => {
  it('connect 返回 sessionId，并依次上报 connecting → authenticating → ready', () => {
    const { manager, sink, sockets, connection } = setup()
    const { sessionId } = manager.connect(connection)
    expect(sessionId).toMatch(/[0-9a-f-]{36}/)

    driveHandshake(sockets[0] as FakeSocket)
    expect(sink.states.map((s) => s.state)).toEqual(['connecting', 'authenticating', 'ready'])
    expect(manager.list()[0]).toMatchObject({ sessionId, state: 'ready', host: '127.0.0.1', port: 5900 })
  })

  it('握手期间写出的报文包含版本、ClientInit、SetEncodings 与首次帧请求', () => {
    const { manager, sockets, connection } = setup()
    manager.connect(connection)
    driveHandshake(sockets[0] as FakeSocket)

    const written = (sockets[0] as FakeSocket).allWritten()
    expect(written.subarray(0, 12).toString('latin1')).toBe('RFB 003.008\n')
    expect(written.includes(Buffer.from([1]))).toBe(true) // ClientInit(shared=1)
    // SetEncodings 报文类型 2
    expect(written.some((byte) => byte === 2)).toBe(true)
  })

  it('VNC 口令认证：写出 16 字节 DES 应答', () => {
    const { manager, sockets, connection } = setup({ authType: 'vnc-password', password: 's3cret' })
    manager.connect(connection)
    const socket = sockets[0] as FakeSocket

    socket.emit('data', serverVersion())
    socket.emit('data', Buffer.from([1, 2])) // 只提供 VNC Auth
    const challenge = Buffer.from('0123456789abcdef', 'latin1')
    socket.emit('data', challenge)

    const written = socket.allWritten()
    const expected = vncEncryptChallenge('s3cret', challenge)
    expect(written.subarray(written.length - 16)).toEqual(expected)
  })

  it('握手超时 → VNC_ERROR + failed（不会永远停在 connecting）', () => {
    const { manager, sink, timer, connection } = setup()
    manager.connect(connection)
    expect(timer.pending).toBe(1)

    timer.fire()
    expect(sink.errors[0]?.message).toContain('握手超时')
    expect(sink.states.map((s) => s.state)).toContain('failed')
  })

  it('socket 报错 → VNC_ERROR + failed', () => {
    const { manager, sink, sockets, connection } = setup()
    manager.connect(connection)
    ;(sockets[0] as FakeSocket).emit('error', new Error('ECONNREFUSED'))

    expect(sink.errors[0]?.message).toBe('ECONNREFUSED')
    expect(sink.states.at(-1)).toMatchObject({ state: 'failed' })
  })

  it('服务端主动关闭 → disconnected', () => {
    const { manager, sink, sockets, connection } = setup()
    manager.connect(connection)
    driveHandshake(sockets[0] as FakeSocket)
    ;(sockets[0] as FakeSocket).emit('close')

    expect(sink.states.at(-1)?.state).toBe('disconnected')
    expect(manager.list()).toHaveLength(0)
  })

  it('disconnect 会销毁 socket 并移除会话', () => {
    const { manager, sink, sockets, connection } = setup()
    const { sessionId } = manager.connect(connection)
    driveHandshake(sockets[0] as FakeSocket)

    expect(manager.disconnect(sessionId)).toBe(true)
    expect((sockets[0] as FakeSocket).destroyed).toBe(true)
    expect(sink.states.at(-1)?.state).toBe('disconnected')
    expect(manager.list()).toHaveLength(0)
  })

  it('未知 sessionId → NOT_FOUND', () => {
    const { manager } = setup()
    try {
      manager.sendPointer('nope', 0, 0, 0)
      throw new Error('应当抛错')
    } catch (err) {
      expect(err).toBeInstanceOf(AppError)
      expect((err as AppError).code).toBe('NOT_FOUND')
    }
  })
})

// ---------------------------------------------------------------------------
// 帧与输入
// ---------------------------------------------------------------------------

describe('VncManager：帧与输入', () => {
  it('Raw 帧 → VNC_FRAME 载荷（像素 base64）', () => {
    const { manager, sink, sockets, connection } = setup()
    manager.connect(connection)
    const socket = sockets[0] as FakeSocket
    driveHandshake(socket)

    const px = Buffer.concat([bgra(255, 0, 0), bgra(0, 255, 0)])
    socket.emit('data', rawFrame(10, 20, 2, 1, px))

    const frame = sink.frames[0]?.frame
    expect(frame?.framebufferWidth).toBe(640)
    expect(frame?.framebufferHeight).toBe(480)
    expect(frame?.rects).toHaveLength(1)
    expect(frame?.rects[0]).toMatchObject({ x: 10, y: 20, width: 2, height: 1 })
    expect(Buffer.from(frame?.rects[0]?.pixels ?? '', 'base64')).toEqual(px)
  })

  it('CopyRect 帧 → copyFrom（无像素，搬运交给渲染层）', () => {
    const { manager, sink, sockets, connection } = setup()
    manager.connect(connection)
    const socket = sockets[0] as FakeSocket
    driveHandshake(socket)

    const buf = Buffer.alloc(4 + 12 + 4)
    buf.writeUInt8(0, 0)
    buf.writeUInt16BE(1, 2)
    buf.writeUInt16BE(100, 4)
    buf.writeUInt16BE(50, 6)
    buf.writeUInt16BE(30, 8)
    buf.writeUInt16BE(20, 10)
    buf.writeInt32BE(1, 12) // CopyRect
    buf.writeUInt16BE(7, 16)
    buf.writeUInt16BE(9, 18)
    socket.emit('data', buf)

    const rect = sink.frames[0]?.frame.rects[0]
    expect(rect?.copyFrom).toEqual({ x: 7, y: 9 })
    expect(rect?.pixels).toBeUndefined()
  })

  it('Bell / ServerCutText → VNC_BELL / VNC_CLIPBOARD', () => {
    const { manager, sink, sockets, connection } = setup()
    manager.connect(connection)
    const socket = sockets[0] as FakeSocket
    driveHandshake(socket)

    socket.emit('data', Buffer.from([2]))
    expect(sink.bells).toHaveLength(1)

    const text = Buffer.from('远端剪贴板', 'utf8')
    const cut = Buffer.alloc(8 + text.length)
    cut.writeUInt8(3, 0)
    cut.writeUInt32BE(text.length, 4)
    text.copy(cut, 8)
    socket.emit('data', cut)
    expect(sink.clips[0]?.text).toBe('远端剪贴板')
  })

  it('sendPointer / sendKey 写出正确报文', () => {
    const { manager, sockets, connection } = setup()
    const { sessionId } = manager.connect(connection)
    const socket = sockets[0] as FakeSocket
    driveHandshake(socket)
    socket.written.length = 0

    expect(manager.sendPointer(sessionId, 1, 100, 200)).toEqual({ sent: true })
    expect(manager.sendKey(sessionId, true, 0xff0d)).toEqual({ sent: true })

    const written = socket.allWritten()
    expect(written.readUInt8(0)).toBe(5) // PointerEvent
    expect(written.readUInt16BE(2)).toBe(100)
    expect(written.readUInt8(6)).toBe(4) // KeyEvent
    expect(written.readUInt32BE(10)).toBe(0xff0d)
  })

  it('★ viewOnly：不发任何键鼠（也不写 socket）', () => {
    const { manager, sockets, connection } = setup({ viewOnly: true })
    const { sessionId } = manager.connect(connection)
    const socket = sockets[0] as FakeSocket
    driveHandshake(socket)
    socket.written.length = 0

    expect(manager.sendPointer(sessionId, 1, 5, 5)).toEqual({ sent: false, ignored: 'viewOnly' })
    expect(manager.sendKey(sessionId, true, 0x41)).toEqual({ sent: false, ignored: 'viewOnly' })
    expect(socket.written).toHaveLength(0)
  })

  it('未就绪时输入被忽略并说明原因（不静默丢弃）', () => {
    const { manager, connection } = setup()
    const { sessionId } = manager.connect(connection)
    const result = manager.sendPointer(sessionId, 1, 1, 1)
    expect(result.sent).toBe(false)
    expect(result.ignored).toContain('未就绪')
  })

  it('sendClipboard 写出 ClientCutText', () => {
    const { manager, sockets, connection } = setup()
    const { sessionId } = manager.connect(connection)
    const socket = sockets[0] as FakeSocket
    driveHandshake(socket)
    socket.written.length = 0

    expect(manager.sendClipboard(sessionId, 'clip')).toEqual({ sent: true })
    const written = socket.allWritten()
    expect(written.readUInt8(0)).toBe(6)
    expect(written.readUInt32BE(4)).toBe(4)
  })

  it('协议级错误（不支持的编码）→ VNC_ERROR + failed', () => {
    const { manager, sink, sockets, connection } = setup()
    manager.connect(connection)
    const socket = sockets[0] as FakeSocket
    driveHandshake(socket)

    // 矩形编码 7（Tight）未实现
    const buf = Buffer.alloc(4 + 12)
    buf.writeUInt8(0, 0)
    buf.writeUInt16BE(1, 2)
    buf.writeInt32BE(7, 12)
    socket.emit('data', buf)

    expect(sink.errors.at(-1)?.message).toContain('不支持的编码')
    expect(sink.states.at(-1)?.state).toBe('failed')
  })

  it('shutdown 关闭全部会话', () => {
    const { manager, sockets, connection } = setup()
    manager.connect(connection)
    manager.connect(connection)
    driveHandshake(sockets[0] as FakeSocket)

    manager.shutdown()
    expect(manager.list()).toHaveLength(0)
    expect(sockets.every((s) => s.destroyed)).toBe(true)
  })
})
