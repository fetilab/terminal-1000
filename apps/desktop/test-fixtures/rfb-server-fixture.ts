// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 最小进程内 RFB 3.8 服务端夹具（**仅测试使用；产品代码不得依赖本文件**）。
 *
 * 目的：让 `services/vnc` 的端到端验证在没有外部 VNC 服务端时也能真跑 ——
 * 真实 loopback TCP、真实握手、真实 VNC 认证（DES）、真实帧缓冲更新与剪贴板。
 * 只监听 `127.0.0.1`（端口 0 由内核分配），不向外发起任何连接。
 *
 * 为什么是独立实现而不是复用 `services/vnc/rfb.ts` 的常量与编解码：
 * 夹具与客户端**两侧各自按 RFC 6143 写死常量**，才能暴露"两侧同时对、但都抄错"
 * 的漂移。像素格式编解码同样本地实现；唯一复用的是 DES 解密（`vncDecryptChallenge`，
 * 该函数在 `rfb.test.ts` 里已被 OpenSSL 参考向量独立校验），因为服务端确实需要它
 * 才能判断"客户端应答解出来是不是这段 challenge"。
 *
 * 覆盖的线上行为：
 * - ProtocolVersion 握手（只发 3.8）
 * - 安全类型列表：None(1) / VNC Authentication(2)
 * - VNC 认证：16 字节 challenge → 校验 DES 应答 → SecurityResult（失败带原因文本）
 * - ClientInit(shared) → ServerInit（宽高 + 像素格式 + 桌面名）
 * - SetPixelFormat / SetEncodings（含 QualityLevel / CompressLevel 带参伪编码）
 * - FramebufferUpdateRequest → Raw / CopyRect / DesktopSize / LastRect(0xFFFF 计数)
 * - Bell / ServerCutText；并记录 ClientCutText / PointerEvent / KeyEvent
 */

import { createServer, type Server, type Socket } from 'node:net'
import { vncDecryptChallenge } from '../src/main/services/vnc/rfb'

// ---------------------------------------------------------------------------
// 协议常量（RFC 6143；刻意不复用产品常量）
// ---------------------------------------------------------------------------

const RFB_VERSION_3_8 = 'RFB 003.008\n'

const SEC_NONE = 1
const SEC_VNC_AUTH = 2

const ENC_RAW = 0
const ENC_COPY_RECT = 1
const ENC_DESKTOP_SIZE = -223
const ENC_LAST_RECT = -224
const ENC_QUALITY_LEVEL = -256
const ENC_COMPRESS_LEVEL = -247

const CLIENT_SET_PIXEL_FORMAT = 0
const CLIENT_SET_ENCODINGS = 2
const CLIENT_FB_UPDATE_REQUEST = 3
const CLIENT_KEY_EVENT = 4
const CLIENT_POINTER_EVENT = 5
const CLIENT_CUT_TEXT = 6

const SERVER_FB_UPDATE = 0
const SERVER_BELL = 2
const SERVER_CUT_TEXT = 3

/** 固定 challenge：让"DES 应答"可以在测试里断言成常量 */
export const DEFAULT_CHALLENGE = Buffer.from('0102030405060708090a0b0c0d0e0f10', 'hex')

// ---------------------------------------------------------------------------
// 像素格式
// ---------------------------------------------------------------------------

export interface FixturePixelFormat {
  bitsPerPixel: number
  depth: number
  bigEndian: boolean
  trueColour: boolean
  redMax: number
  greenMax: number
  blueMax: number
  redShift: number
  greenShift: number
  blueShift: number
}

/** 与服务端默认一致的 32bpp true colour（BGRA 字节序） */
export const FIXTURE_FORMAT_32BPP: FixturePixelFormat = {
  bitsPerPixel: 32,
  depth: 24,
  bigEndian: false,
  trueColour: true,
  redMax: 255,
  greenMax: 255,
  blueMax: 255,
  redShift: 16,
  greenShift: 8,
  blueShift: 0,
}

/** 客户端从不会请求、需要我们发 SetPixelFormat 的 16bpp 格式（用于验证转换路径） */
export const FIXTURE_FORMAT_16BPP: FixturePixelFormat = {
  bitsPerPixel: 16,
  depth: 16,
  bigEndian: false,
  trueColour: true,
  redMax: 31,
  greenMax: 63,
  blueMax: 31,
  redShift: 11,
  greenShift: 5,
  blueShift: 0,
}

export function encodeFixturePixelFormat(format: FixturePixelFormat): Buffer {
  const buf = Buffer.alloc(16)
  buf.writeUInt8(format.bitsPerPixel & 0xff, 0)
  buf.writeUInt8(format.depth & 0xff, 1)
  buf.writeUInt8(format.bigEndian ? 1 : 0, 2)
  buf.writeUInt8(format.trueColour ? 1 : 0, 3)
  buf.writeUInt16BE(format.redMax & 0xffff, 4)
  buf.writeUInt16BE(format.greenMax & 0xffff, 6)
  buf.writeUInt16BE(format.blueMax & 0xffff, 8)
  buf.writeUInt8(format.redShift & 0xff, 10)
  buf.writeUInt8(format.greenShift & 0xff, 11)
  buf.writeUInt8(format.blueShift & 0xff, 12)
  return buf
}

export function decodeFixturePixelFormat(buf: Buffer, offset = 0): FixturePixelFormat {
  return {
    bitsPerPixel: buf.readUInt8(offset),
    depth: buf.readUInt8(offset + 1),
    bigEndian: buf.readUInt8(offset + 2) !== 0,
    trueColour: buf.readUInt8(offset + 3) !== 0,
    redMax: buf.readUInt16BE(offset + 4),
    greenMax: buf.readUInt16BE(offset + 6),
    blueMax: buf.readUInt16BE(offset + 8),
    redShift: buf.readUInt8(offset + 10),
    greenShift: buf.readUInt8(offset + 11),
    blueShift: buf.readUInt8(offset + 12),
  }
}

export interface FixtureColor {
  r: number
  g: number
  b: number
}

/** 在给定格式下生成整块纯色像素（只支持 32bpp 小端与 16bpp 565） */
function solidPixels(width: number, height: number, color: FixtureColor, format: FixturePixelFormat): Buffer {
  const count = width * height
  if (format.bitsPerPixel === 32) {
    const out = Buffer.alloc(count * 4)
    for (let i = 0; i < count; i += 1) {
      out.writeUInt8(color.b & 0xff, i * 4)
      out.writeUInt8(color.g & 0xff, i * 4 + 1)
      out.writeUInt8(color.r & 0xff, i * 4 + 2)
      out.writeUInt8(0, i * 4 + 3)
    }
    return out
  }
  if (format.bitsPerPixel === 16) {
    const value = (((color.r >> 3) & 0x1f) << 11) | (((color.g >> 2) & 0x3f) << 5) | ((color.b >> 3) & 0x1f)
    const out = Buffer.alloc(count * 2)
    for (let i = 0; i < count; i += 1) out.writeUInt16LE(value, i * 2)
    return out
  }
  throw new Error(`夹具不支持 ${format.bitsPerPixel}bpp 的像素序列化`)
}

// ---------------------------------------------------------------------------
// 矩形描述
// ---------------------------------------------------------------------------

export type FixtureRect =
  | { kind: 'raw'; x: number; y: number; width: number; height: number; color: FixtureColor }
  | { kind: 'copyRect'; x: number; y: number; width: number; height: number; srcX: number; srcY: number }
  | { kind: 'desktopSize'; width: number; height: number }

export interface FixtureOptions {
  width?: number
  height?: number
  name?: string
  /** ServerInit 里通告的像素格式（默认 32bpp，客户端不会回 SetPixelFormat） */
  pixelFormat?: FixturePixelFormat
  /** 口令；提供后安全类型列表为 [VNC 认证, None] */
  password?: string
  /** 显式覆盖安全类型列表 */
  securityTypes?: number[]
  /** 固定 challenge（默认 `DEFAULT_CHALLENGE`） */
  challenge?: Buffer
  /** 自动应答前 N 个 FramebufferUpdateRequest（默认 1）；其余由测试显式 sendUpdate */
  autoRespond?: number
  /** 自动应答使用的矩形；缺省为整屏纯色 */
  initialRects?: FixtureRect[]
  /** 自动应答时用 `0xFFFF` 计数 + LastRect 结束（复现真实服务端行为） */
  useLastRect?: boolean
  /** 认证失败时返回的原因文本 */
  authFailureReason?: string
}

export interface FixtureFbUpdateRequest {
  incremental: boolean
  x: number
  y: number
  width: number
  height: number
}

interface Conn {
  socket: Socket
  buffer: Buffer
  stage: 'version' | 'security' | 'challenge' | 'clientInit' | 'ready' | 'closed'
  challenge: Buffer
  format: FixturePixelFormat
}

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

export class RfbServerFixture {
  // ---- 观测记录（测试断言用） ----
  connections = 0
  clientVersions: string[] = []
  /** 每个连接选中的安全类型 */
  securitySelections: number[] = []
  /** 每个连接 ClientInit 的 shared 标志 */
  clientInitShared: boolean[] = []
  /** 最后一次 SetEncodings 的编码列表（按顺序） */
  requestedEncodings: number[] = []
  /** QualityLevel / CompressLevel 伪编码携带的参数 */
  encodingLevels: Array<{ encoding: number; value: number }> = []
  pixelFormatRequests: FixturePixelFormat[] = []
  fbUpdateRequests: FixtureFbUpdateRequest[] = []
  pointerEvents: Array<{ buttonMask: number; x: number; y: number }> = []
  keyEvents: Array<{ down: boolean; keysym: number }> = []
  cutTexts: string[] = []
  /** 每个连接收到的 16 字节 DES 认证应答 */
  authResponses: Buffer[] = []
  authFailures = 0

  private readonly options: Required<Pick<FixtureOptions, 'width' | 'height' | 'name' | 'autoRespond' | 'useLastRect' | 'authFailureReason'>> &
    FixtureOptions
  private server: Server | null = null
  private readonly conns = new Set<Conn>()
  private autoResponded = 0
  private listeningPort = 0
  private listeningAddress = ''

  private constructor(options: FixtureOptions) {
    this.options = {
      width: 64,
      height: 48,
      name: 't1000-fixture',
      autoRespond: 1,
      useLastRect: false,
      authFailureReason: 'Authentication failure',
      ...options,
    }
  }

  static start(options: FixtureOptions = {}): Promise<RfbServerFixture> {
    const fixture = new RfbServerFixture(options)
    return fixture.listen().then(() => fixture)
  }

  get port(): number {
    return this.listeningPort
  }

  /** 实际监听的地址：测试据此断言夹具只绑回环、不对外暴露 */
  get address(): string {
    return this.listeningAddress
  }

  /** 当前还有一个处于 ready 阶段的连接 */
  get hasReadyConnection(): boolean {
    for (const conn of this.conns) if (conn.stage === 'ready') return true
    return false
  }

  /** 向所有 ready 连接发一帧更新 */
  sendUpdate(rects?: FixtureRect[], useLastRect?: boolean): void {
    const list = rects ?? this.options.initialRects ?? [
      { kind: 'raw' as const, x: 0, y: 0, width: this.options.width, height: this.options.height, color: { r: 0x20, g: 0x40, b: 0x80 } },
    ]
    const lastRect = useLastRect ?? this.options.useLastRect
    for (const conn of this.conns) {
      if (conn.stage !== 'ready') continue
      conn.socket.write(this.encodeUpdate(conn, list, lastRect))
    }
  }

  sendBell(): void {
    this.broadcast(Buffer.from([SERVER_BELL]))
  }

  sendCutText(text: string): void {
    const payload = Buffer.from(text, 'utf8')
    const header = Buffer.alloc(8)
    header.writeUInt8(SERVER_CUT_TEXT, 0)
    header.writeUInt32BE(payload.length, 4)
    this.broadcast(Buffer.concat([header, payload]))
  }

  /** 主动切断所有客户端（用于验证客户端对端关闭的上报） */
  dropConnections(): void {
    for (const conn of this.conns) {
      conn.stage = 'closed'
      conn.socket.destroy()
    }
    this.conns.clear()
  }

  async close(): Promise<void> {
    this.dropConnections()
    const server = this.server
    this.server = null
    if (server === null) return
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  // -------------------------------------------------------------- 内部

  private listen(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const server = createServer((socket) => this.onConnection(socket))
      server.on('error', reject)
      // 只绑回环：夹具绝不对外监听，也不发起对外连接
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        if (address === null || typeof address === 'string') {
          reject(new Error('夹具未能取得监听端口'))
          return
        }
        this.server = server
        this.listeningPort = address.port
        this.listeningAddress = address.address
        resolve()
      })
    })
  }

  private onConnection(socket: Socket): void {
    socket.on('error', () => {
      /* 客户端主动断开：忽略 */
    })
    this.connections += 1
    const conn: Conn = {
      socket,
      buffer: Buffer.alloc(0),
      stage: 'version',
      challenge: this.options.challenge ?? DEFAULT_CHALLENGE,
      format: this.options.pixelFormat ?? FIXTURE_FORMAT_32BPP,
    }
    this.conns.add(conn)
    socket.on('data', (chunk) => {
      conn.buffer = Buffer.concat([conn.buffer, chunk])
      this.pump(conn)
    })
    socket.on('close', () => {
      conn.stage = 'closed'
      this.conns.delete(conn)
    })
    // RFB 由服务端先发版本串
    socket.write(RFB_VERSION_3_8)
  }

  private pump(conn: Conn): void {
    for (;;) {
      if (conn.stage === 'closed') return
      const used = this.tryStep(conn)
      if (used === 0) return
      conn.buffer = conn.buffer.subarray(used)
    }
  }

  /** 处理一条消息；字节不够时返回 0（不消费、不提交任何状态） */
  private tryStep(conn: Conn): number {
    switch (conn.stage) {
      case 'version': {
        if (conn.buffer.length < 12) return 0
        this.clientVersions.push(conn.buffer.subarray(0, 12).toString('latin1'))
        conn.stage = 'security'
        const offered = this.options.securityTypes ?? (this.options.password !== undefined ? [SEC_VNC_AUTH, SEC_NONE] : [SEC_NONE])
        conn.socket.write(Buffer.from([offered.length, ...offered]))
        return 12
      }

      case 'security': {
        if (conn.buffer.length < 1) return 0
        const selected = conn.buffer.readUInt8(0)
        this.securitySelections.push(selected)
        if (selected === SEC_VNC_AUTH && this.options.password !== undefined) {
          conn.socket.write(conn.challenge)
          conn.stage = 'challenge'
        } else if (selected === SEC_NONE) {
          conn.socket.write(this.securityResult(null))
          conn.stage = 'clientInit'
        } else {
          conn.socket.write(this.securityResult(this.options.authFailureReason))
          conn.stage = 'closed'
          conn.socket.end()
        }
        return 1
      }

      case 'challenge': {
        if (conn.buffer.length < 16) return 0
        const response = Buffer.from(conn.buffer.subarray(0, 16))
        this.authResponses.push(response)
        const decrypted = vncDecryptChallenge(this.options.password ?? '', response)
        const ok = decrypted.equals(conn.challenge)
        if (ok) {
          conn.socket.write(this.securityResult(null))
          conn.stage = 'clientInit'
        } else {
          this.authFailures += 1
          conn.socket.write(this.securityResult(this.options.authFailureReason))
          conn.stage = 'closed'
          conn.socket.end()
        }
        return 16
      }

      case 'clientInit': {
        if (conn.buffer.length < 1) return 0
        this.clientInitShared.push(conn.buffer.readUInt8(0) === 1)
        conn.socket.write(this.encodeServerInit(conn.format))
        conn.stage = 'ready'
        return 1
      }

      case 'ready':
        return this.tryClientMessage(conn)

      case 'closed':
        return 0
    }
  }

  private tryClientMessage(conn: Conn): number {
    const buf = conn.buffer
    if (buf.length < 1) return 0
    const type = buf.readUInt8(0)

    if (type === CLIENT_SET_PIXEL_FORMAT) {
      if (buf.length < 20) return 0
      const format = decodeFixturePixelFormat(buf, 4)
      this.pixelFormatRequests.push(format)
      conn.format = format
      return 20
    }

    if (type === CLIENT_SET_ENCODINGS) {
      if (buf.length < 4) return 0
      const count = buf.readUInt16BE(2)
      const encodings: number[] = []
      const levels: Array<{ encoding: number; value: number }> = []
      let offset = 4
      for (let i = 0; i < count; i += 1) {
        if (offset + 4 > buf.length) return 0
        const encoding = buf.readInt32BE(offset)
        offset += 4
        encodings.push(encoding)
        // QualityLevel / CompressLevel 是带 4 字节参数的伪编码（TightVNC 约定）
        if (encoding === ENC_QUALITY_LEVEL || encoding === ENC_COMPRESS_LEVEL) {
          if (offset + 4 > buf.length) return 0
          levels.push({ encoding, value: buf.readInt32BE(offset) })
          offset += 4
        }
      }
      this.requestedEncodings = encodings
      this.encodingLevels = levels
      return offset
    }

    if (type === CLIENT_FB_UPDATE_REQUEST) {
      if (buf.length < 10) return 0
      this.fbUpdateRequests.push({
        incremental: buf.readUInt8(1) === 1,
        x: buf.readUInt16BE(2),
        y: buf.readUInt16BE(4),
        width: buf.readUInt16BE(6),
        height: buf.readUInt16BE(8),
      })
      if (this.autoResponded < this.options.autoRespond) {
        this.autoResponded += 1
        this.sendUpdate()
      }
      return 10
    }

    if (type === CLIENT_KEY_EVENT) {
      if (buf.length < 8) return 0
      this.keyEvents.push({ down: buf.readUInt8(1) === 1, keysym: buf.readUInt32BE(4) })
      return 8
    }

    if (type === CLIENT_POINTER_EVENT) {
      if (buf.length < 6) return 0
      this.pointerEvents.push({
        buttonMask: buf.readUInt8(1),
        x: buf.readUInt16BE(2),
        y: buf.readUInt16BE(4),
      })
      return 6
    }

    if (type === CLIENT_CUT_TEXT) {
      if (buf.length < 8) return 0
      const length = buf.readUInt32BE(4)
      if (buf.length < 8 + length) return 0
      this.cutTexts.push(buf.subarray(8, 8 + length).toString('utf8'))
      return 8 + length
    }

    throw new Error(`夹具收到未知客户端消息类型: ${type}`)
  }

  private securityResult(reason: string | null): Buffer {
    const result = Buffer.alloc(4)
    result.writeUInt32BE(reason === null ? 0 : 1, 0)
    if (reason === null) return result
    const text = Buffer.from(reason, 'utf8')
    const length = Buffer.alloc(4)
    length.writeUInt32BE(text.length, 0)
    return Buffer.concat([result, length, text])
  }

  private encodeServerInit(format: FixturePixelFormat): Buffer {
    const name = Buffer.from(this.options.name, 'utf8')
    const head = Buffer.alloc(24)
    head.writeUInt16BE(this.options.width, 0)
    head.writeUInt16BE(this.options.height, 2)
    encodeFixturePixelFormat(format).copy(head, 4)
    head.writeUInt32BE(name.length, 20)
    return Buffer.concat([head, name])
  }

  private encodeUpdate(conn: Conn, rects: FixtureRect[], useLastRect: boolean): Buffer {
    const parts: Buffer[] = []
    const header = Buffer.alloc(4)
    header.writeUInt8(SERVER_FB_UPDATE, 0)
    header.writeUInt16BE(useLastRect ? 0xffff : rects.length, 2)
    parts.push(header)

    for (const rect of rects) {
      const head = Buffer.alloc(12)
      if (rect.kind === 'desktopSize') {
        head.writeUInt16BE(rect.width, 0)
        head.writeUInt16BE(rect.height, 2)
        head.writeUInt16BE(0, 4)
        head.writeUInt16BE(0, 6)
        head.writeInt32BE(ENC_DESKTOP_SIZE, 8)
        parts.push(head)
        continue
      }
      head.writeUInt16BE(rect.x, 0)
      head.writeUInt16BE(rect.y, 2)
      head.writeUInt16BE(rect.width, 4)
      head.writeUInt16BE(rect.height, 6)
      if (rect.kind === 'copyRect') {
        head.writeInt32BE(ENC_COPY_RECT, 8)
        const src = Buffer.alloc(4)
        src.writeUInt16BE(rect.srcX, 0)
        src.writeUInt16BE(rect.srcY, 2)
        parts.push(head, src)
      } else {
        head.writeInt32BE(ENC_RAW, 8)
        parts.push(head, solidPixels(rect.width, rect.height, rect.color, conn.format))
      }
    }

    if (useLastRect) {
      const last = Buffer.alloc(12)
      last.writeInt32BE(ENC_LAST_RECT, 8)
      parts.push(last)
    }
    return Buffer.concat(parts)
  }

  private broadcast(data: Buffer): void {
    for (const conn of this.conns) {
      if (conn.stage === 'ready') conn.socket.write(data)
    }
  }
}
