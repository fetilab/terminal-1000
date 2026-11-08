// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * RFB 协议单测：**全部用手写字节流**，不连任何真实 VNC 服务端。
 *
 * 覆盖验收项：握手字节流构造与解析（含 DES 位序反转）、安全类型协商、
 * ServerInit 解析、Raw/CopyRect/Hextile 解码、输入事件编码、分片喂入不误解析。
 */

import { describe, expect, it } from 'vitest'
import {
  CLIENT_CUT_TEXT,
  CLIENT_FB_UPDATE_REQUEST,
  CLIENT_KEY_EVENT,
  CLIENT_POINTER_EVENT,
  CLIENT_SET_ENCODINGS,
  CLIENT_SET_PIXEL_FORMAT,
  ENCODING_COPY_RECT,
  ENCODING_RAW,
  PREFERRED_PIXEL_FORMAT,
  PSEUDO_ENCODING_COMPRESS_LEVEL,
  PSEUDO_ENCODING_QUALITY_LEVEL,
  RFB_VERSION_3_8,
  RfbByteReader,
  RfbProtocol,
  SECURITY_NONE,
  SECURITY_VNC_AUTH,
  decodeHextile,
  decodePixelFormat,
  encodePixelFormat,
  pixelFormatEquals,
  desDecryptBlock,
  desEncryptBlock,
  reverseBits8,
  vncDecryptChallenge,
  vncDesKey,
  vncEncryptChallenge,
  type RfbEvent,
  type RfbPixelFormat,
  type RfbProtocolOptions,
} from './rfb'

// ---------------------------------------------------------------------------
// 样本构造
// ---------------------------------------------------------------------------

const serverVersion = (minor: number): Buffer => Buffer.from(`RFB 003.00${minor}\n`, 'latin1')

const securityList = (types: number[]): Buffer =>
  Buffer.concat([Buffer.from([types.length]), Buffer.from(types)])

/** SecurityResult(4 字节) + 可选原因字符串 */
function securityResult(ok: boolean, reason?: string): Buffer {
  const head = Buffer.alloc(4)
  head.writeUInt32BE(ok ? 0 : 1, 0)
  if (reason === undefined) return head
  const text = Buffer.from(reason, 'utf8')
  const len = Buffer.alloc(4)
  len.writeUInt32BE(text.length, 0)
  return Buffer.concat([head, len, text])
}

/** ServerInit：宽高(4) + 像素格式(16) + 名字长度(4) + 名字 */
function serverInit(
  width: number,
  height: number,
  format: RfbPixelFormat,
  name = 'test-desktop',
): Buffer {
  const nameBuf = Buffer.from(name, 'utf8')
  const buf = Buffer.alloc(24 + nameBuf.length)
  buf.writeUInt16BE(width, 0)
  buf.writeUInt16BE(height, 2)
  encodePixelFormat(format).copy(buf, 4)
  buf.writeUInt32BE(nameBuf.length, 20)
  nameBuf.copy(buf, 24)
  return buf
}

/** 与服务端给的不同格式（16bpp，用于验证会请求转换） */
const SERVER_16BPP: RfbPixelFormat = {
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

/** FramebufferUpdate：类型 0 + padding + 矩形数 */
function fbUpdate(rects: Buffer[], count = rects.length): Buffer {
  const head = Buffer.alloc(4)
  head.writeUInt8(0, 0)
  head.writeUInt16BE(count, 2)
  return Buffer.concat([head, ...rects])
}

function rectHeader(x: number, y: number, w: number, h: number, encoding: number): Buffer {
  const buf = Buffer.alloc(12)
  buf.writeUInt16BE(x, 0)
  buf.writeUInt16BE(y, 2)
  buf.writeUInt16BE(w, 4)
  buf.writeUInt16BE(h, 6)
  buf.writeInt32BE(encoding, 8)
  return buf
}

/** 32bpp 小端 BGRA 像素 */
const bgra = (r: number, g: number, b: number): Buffer => Buffer.from([b, g, r, 0])

/** 走完握手，返回 ready 状态的协议实例与累积事件 */
function handshake(
  options: RfbProtocolOptions = {},
): { protocol: RfbProtocol; events: RfbEvent[] } {
  const protocol = new RfbProtocol(options)
  const events: RfbEvent[] = []
  events.push(...protocol.feed(serverVersion(8)))
  protocol.drainOutbox()
  events.push(...protocol.feed(securityList([SECURITY_NONE])))
  protocol.drainOutbox()
  events.push(...protocol.feed(securityResult(true)))
  protocol.drainOutbox()
  events.push(...protocol.feed(serverInit(800, 600, PREFERRED_PIXEL_FORMAT)))
  return { protocol, events }
}

/** 解析 SetEncodings 报文，验证编码列表与伪编码参数 */
function parseSetEncodings(buf: Buffer): { count: number; encodings: number[]; pseudo: Map<number, number> } {
  const count = buf.readUInt16BE(2)
  const encodings: number[] = []
  const pseudo = new Map<number, number>()
  let offset = 4
  for (let i = 0; i < count; i += 1) {
    const value = buf.readInt32BE(offset)
    offset += 4
    encodings.push(value)
    // TightVNC 约定：这两个伪编码后面跟 4 字节参数
    if (value === PSEUDO_ENCODING_QUALITY_LEVEL || value === PSEUDO_ENCODING_COMPRESS_LEVEL) {
      pseudo.set(value, buf.readInt32BE(offset))
      offset += 4
    }
  }
  return { count, encodings, pseudo }
}

// ---------------------------------------------------------------------------
// ★ VNC 认证的 DES 位序（本任务最经典的坑）
// ---------------------------------------------------------------------------

/**
 * 位序反转的**独立实现**：先转二进制字符串、反转、再转回数字。
 * 与 `reverseBits8` 的掩码/蝴蝶操作完全不同的写法，用于交叉验证而不是自证。
 */
function reverseBitsReference(value: number): number {
  return Number.parseInt(value.toString(2).padStart(8, '0').split('').reverse().join(''), 2)
}

describe('纯 TS DES：与 OpenSSL 参考向量逐条一致', () => {
  /**
   * 参考密文用 `node --openssl-legacy-provider` + createCipheriv('des-ecb') 生成
   * （OpenSSL 3 的默认 provider 已移除 DES，所以这里把结果固化成 KAT，
   *  让测试既能在没有 legacy provider 的环境跑，又能证明自研 DES 是对的）。
   */
  const VECTORS: ReadonlyArray<readonly [string, string, string]> = [
    ['133457799BBCDFF1', '0123456789ABCDEF', '85E813540F0AB405'], // FIPS 46-3 经典向量
    ['0000000000000000', '0000000000000000', '8CA64DE9C1B123A7'],
    ['FFFFFFFFFFFFFFFF', 'FFFFFFFFFFFFFFFF', '7359B2163E4EDC58'],
    ['0123456789ABCDEF', 'FEDCBA9876543210', '12C626AF058B433B'],
    ['0123456789abcdef', '0000000000000000', 'D5D44FF720683D0D'],
    ['0000000000000000', 'FFFFFFFFFFFFFFFF', '355550B2150E2451'],
    ['deadbeefcafebabe', '1122334455667788', 'DF3C9A9A4CB6FDF2'],
    ['7f8c9d2e4b6a1035', 'a1b2c3d4e5f60718', '3E312A7F26F599D0'],
  ]

  it('加密结果与 OpenSSL 完全一致', () => {
    for (const [key, plain, cipher] of VECTORS) {
      const out = desEncryptBlock(Buffer.from(key, 'hex'), Buffer.from(plain, 'hex'))
      expect(out.toString('hex').toUpperCase(), `key=${key} plain=${plain}`).toBe(cipher)
    }
  })

  it('解密是加密的逆运算', () => {
    for (const [key, plain, cipher] of VECTORS) {
      const back = desDecryptBlock(Buffer.from(key, 'hex'), Buffer.from(cipher, 'hex'))
      expect(back.toString('hex').toUpperCase()).toBe(plain.toUpperCase())
    }
  })

  it('密钥/数据块长度不对时报错', () => {
    expect(() => desEncryptBlock(Buffer.alloc(7), Buffer.alloc(8))).toThrow(/密钥/)
    expect(() => desEncryptBlock(Buffer.alloc(8), Buffer.alloc(7))).toThrow(/数据块/)
  })

  it('16 字节 challenge = 两个 ECB 块（与逐块加密一致）', () => {
    const challenge = Buffer.from('0123456789abcdef', 'latin1')
    const response = vncEncryptChallenge('s3cret', challenge)
    const key = vncDesKey('s3cret')
    expect(response.subarray(0, 8)).toEqual(desEncryptBlock(key, challenge.subarray(0, 8)))
    expect(response.subarray(8, 16)).toEqual(desEncryptBlock(key, challenge.subarray(8, 16)))
  })
})

describe('VNC 认证：DES 密钥的位序反转', () => {
  it('位序反转与独立实现一致（全 256 个取值）', () => {
    for (let v = 0; v < 256; v += 1) {
      expect(reverseBits8(v), `value=${v}`).toBe(reverseBitsReference(v))
    }
  })

  it('典型值：bit0↔bit7', () => {
    expect(reverseBits8(0x01)).toBe(0x80)
    expect(reverseBits8(0x80)).toBe(0x01)
    expect(reverseBits8(0xf0)).toBe(0x0f)
    expect(reverseBits8(0x00)).toBe(0x00)
    expect(reverseBits8(0xff)).toBe(0xff)
  })

  it('DES 密钥 = 口令补零到 8 字节 + 每字节位序反转', () => {
    const password = 'abcdefgh'
    const key = vncDesKey(password)
    expect(key).toHaveLength(8)
    for (let i = 0; i < 8; i += 1) {
      expect(key.readUInt8(i)).toBe(reverseBitsReference(password.charCodeAt(i)))
    }

    // 短口令补 0（0 反转后仍是 0）
    const short = vncDesKey('ab')
    expect(short.subarray(0, 2)).toEqual(
      Buffer.from([reverseBitsReference(0x61), reverseBitsReference(0x62)]),
    )
    expect(short.subarray(2)).toEqual(Buffer.alloc(6))

    // 超长口令截断到 8 字节（RFC 规定 VNC 口令最长 8 字节）
    expect(vncDesKey('abcdefghijkl')).toEqual(vncDesKey('abcdefgh'))
  })

  it('challenge 加解密往返（16 字节 DES-ECB，无填充）', () => {
    const challenge = Buffer.from('0123456789abcdef', 'latin1')
    const response = vncEncryptChallenge('s3cret', challenge)
    expect(response).toHaveLength(16)
    expect(vncDecryptChallenge('s3cret', response)).toEqual(challenge)
  })

  it('challenge 长度不是 16 字节时报错', () => {
    expect(() => vncEncryptChallenge('pw', Buffer.alloc(8))).toThrow(/16 字节/)
  })

  it('★ 位序忘反转 → 服务端解出来是别的口令（表现为"认证被拒"而非报错）', () => {
    const password = 's3cret'
    const challenge = Buffer.from('0123456789abcdef', 'latin1')
    const response = vncEncryptChallenge(password, challenge)

    // 正确约定：解回原 challenge
    expect(vncDecryptChallenge(password, response)).toEqual(challenge)

    // 错误约定：直接用口令字节当 DES 密钥（不反转位序）
    const naiveKey = Buffer.alloc(8)
    Buffer.from(password, 'utf8').copy(naiveKey)
    expect(naiveKey).not.toEqual(vncDesKey(password)) // 两者确实不同

    const wrong = Buffer.concat([
      desDecryptBlock(naiveKey, response.subarray(0, 8)),
      desDecryptBlock(naiveKey, response.subarray(8, 16)),
    ])
    expect(wrong).not.toEqual(challenge)

    // 即：服务端解出来的口令不同 → 只会回 SecurityResult=failed（"认证被拒"），
    // 客户端无从判断是口令错还是位序实现错 —— 这就是这个坑难查的原因。
  })

  it('服务端用正确约定时，本实现的应答能被解开', () => {
    // 模拟服务端：生成 challenge → 用本实现的应答 → 用它自己的（正确）密钥解开比对
    const challenge = Buffer.from('VNCCHALLENGE1234', 'latin1')
    const response = vncEncryptChallenge('hunter2', challenge)
    expect(response).not.toEqual(challenge) // 确实是密文
    expect(vncDecryptChallenge('hunter2', response)).toEqual(challenge)
    // 错误口令解出来不是原 challenge
    expect(vncDecryptChallenge('hunter3', response)).not.toEqual(challenge)
  })
})

// ---------------------------------------------------------------------------
// 握手
// ---------------------------------------------------------------------------

describe('RFB 握手', () => {
  it('版本协商：3.8 服务端 → 回 3.8', () => {
    const protocol = new RfbProtocol()
    const events = protocol.feed(serverVersion(8))
    expect(events[0]).toEqual({
      type: 'version',
      serverVersion: 'RFB 003.008\n',
      clientVersion: RFB_VERSION_3_8,
    })
    expect(protocol.drainOutbox()).toEqual(Buffer.from(RFB_VERSION_3_8, 'latin1'))
    expect(protocol.currentPhase).toBe('security')
  })

  it('版本协商：3.7 服务端 → 回落 3.7（用安全类型列表）', () => {
    const protocol = new RfbProtocol()
    protocol.feed(serverVersion(7))
    expect(protocol.drainOutbox()).toEqual(Buffer.from('RFB 003.007\n', 'latin1'))
    expect(protocol.currentPhase).toBe('security')
  })

  it('版本协商：3.3 服务端 → 回落 3.3（用 4 字节安全类型）', () => {
    const protocol = new RfbProtocol()
    protocol.feed(serverVersion(3))
    protocol.drainOutbox()
    expect(protocol.currentPhase).toBe('security33')

    const events = protocol.feed(Buffer.from([0, 0, 0, SECURITY_NONE]))
    expect(events.some((e) => e.type === 'security')).toBe(true)
    // 3.3 的 None 不发 SecurityResult，直接 ClientInit
    expect(protocol.currentPhase).toBe('serverInit')
    expect(protocol.drainOutbox()).toEqual(Buffer.from([1])) // shared 默认 true
  })

  it('版本串非法 → 明确报错并关闭', () => {
    const protocol = new RfbProtocol()
    const events = protocol.feed(Buffer.from('HTTP/1.1 200\n', 'latin1'))
    expect(events[0]).toMatchObject({ type: 'error' })
    expect(protocol.currentPhase).toBe('closed')
  })

  it('安全类型列表：配置 vnc-password 时优先选 VNC 认证', () => {
    const protocol = new RfbProtocol({ authType: 'vnc-password', password: 'pw' })
    protocol.feed(serverVersion(8))
    protocol.drainOutbox()
    const events = protocol.feed(securityList([SECURITY_NONE, SECURITY_VNC_AUTH]))
    expect(events[0]).toMatchObject({ type: 'security', securityType: SECURITY_VNC_AUTH })
    expect(protocol.drainOutbox()).toEqual(Buffer.from([SECURITY_VNC_AUTH]))
    expect(protocol.currentPhase).toBe('challenge')
  })

  it('安全类型列表：配置 none 时优先选 None', () => {
    const protocol = new RfbProtocol({ authType: 'none' })
    protocol.feed(serverVersion(8))
    protocol.drainOutbox()
    const events = protocol.feed(securityList([SECURITY_VNC_AUTH, SECURITY_NONE]))
    expect(events[0]).toMatchObject({ type: 'security', securityType: SECURITY_NONE })
    expect(protocol.currentPhase).toBe('securityResult') // 3.8 即使 None 也回 SecurityResult
  })

  it('服务端只提供不可用类型 → 报错（附提供列表）', () => {
    const protocol = new RfbProtocol({ authType: 'vnc-password', password: 'pw' })
    protocol.feed(serverVersion(8))
    protocol.drainOutbox()
    const events = protocol.feed(securityList([8])) // 8 = 未知类型
    expect(events[0]).toMatchObject({ type: 'error' })
    expect(String((events[0] as { message: string }).message)).toContain('安全类型')
    expect(protocol.currentPhase).toBe('closed')
  })

  it('服务端要求口令但本地没配 → 明确报错（不是静默失败）', () => {
    const protocol = new RfbProtocol({ authType: 'none' }) // 未提供 password
    protocol.feed(serverVersion(8))
    protocol.drainOutbox()
    const events = protocol.feed(securityList([SECURITY_VNC_AUTH]))
    expect(events[0]).toMatchObject({ type: 'error' })
    expect(String((events[0] as { message: string }).message)).toContain('未配置口令')
  })

  it('安全类型数量为 0 → 服务端拒绝，读原因字符串', () => {
    const protocol = new RfbProtocol()
    protocol.feed(serverVersion(8))
    protocol.drainOutbox()
    const rejected = Buffer.concat([
      Buffer.from([0]),
      ((): Buffer => {
        const text = Buffer.from('too many clients', 'utf8')
        const len = Buffer.alloc(4)
        len.writeUInt32BE(text.length, 0)
        return Buffer.concat([len, text])
      })(),
    ])
    const out = protocol.feed(rejected)
    expect(out[0]).toMatchObject({ type: 'error' })
    expect(String((out[0] as { message: string }).message)).toContain('too many clients')
  })

  it('VNC 认证：challenge → 16 字节应答（DES）', () => {
    const protocol = new RfbProtocol({ authType: 'vnc-password', password: 's3cret' })
    protocol.feed(serverVersion(8))
    protocol.drainOutbox()
    protocol.feed(securityList([SECURITY_VNC_AUTH]))
    protocol.drainOutbox()

    const challenge = Buffer.from('0123456789abcdef', 'latin1')
    const events = protocol.feed(challenge)
    expect(events).toEqual([])
    expect(protocol.drainOutbox()).toEqual(vncEncryptChallenge('s3cret', challenge))
    expect(protocol.currentPhase).toBe('securityResult')
  })

  it('SecurityResult 失败 → 读原因并报错', () => {
    const protocol = new RfbProtocol({ authType: 'vnc-password', password: 'bad' })
    protocol.feed(serverVersion(8))
    protocol.drainOutbox()
    protocol.feed(securityList([SECURITY_VNC_AUTH]))
    protocol.drainOutbox()
    protocol.feed(Buffer.from('0123456789abcdef', 'latin1'))
    protocol.drainOutbox()

    const events = protocol.feed(securityResult(false, 'Authentication failure'))
    expect(events[0]).toMatchObject({ type: 'securityResult', ok: false, reason: 'Authentication failure' })
    expect(events[1]).toMatchObject({ type: 'error' })
    expect(protocol.currentPhase).toBe('closed')
  })

  it('ClientInit 的 shared 标志来自配置', () => {
    const shared = new RfbProtocol({ shared: true })
    shared.feed(serverVersion(8))
    shared.drainOutbox()
    shared.feed(securityList([SECURITY_NONE]))
    shared.drainOutbox()
    shared.feed(securityResult(true))
    expect(shared.drainOutbox()).toEqual(Buffer.from([1]))

    const exclusive = new RfbProtocol({ shared: false })
    exclusive.feed(serverVersion(8))
    exclusive.drainOutbox()
    exclusive.feed(securityList([SECURITY_NONE]))
    exclusive.drainOutbox()
    exclusive.feed(securityResult(true))
    expect(exclusive.drainOutbox()).toEqual(Buffer.from([0]))
  })
})

describe('ServerInit 与像素格式', () => {
  it('解析宽高/名字/像素格式，并发出后续请求', () => {
    const protocol = new RfbProtocol({ qualityLevel: 6, compressionLevel: 2 })
    protocol.feed(serverVersion(8))
    protocol.drainOutbox()
    protocol.feed(securityList([SECURITY_NONE]))
    protocol.drainOutbox()
    protocol.feed(securityResult(true))
    protocol.drainOutbox()

    const events = protocol.feed(serverInit(1280, 720, PREFERRED_PIXEL_FORMAT, '我的桌面'))
    expect(events[0]).toMatchObject({
      type: 'serverInit',
      screen: { width: 1280, height: 720, name: '我的桌面' },
    })
    expect(protocol.currentPhase).toBe('ready')

    const out = protocol.drainOutbox()
    // 服务端格式 == 首选格式 → 不发 SetPixelFormat
    expect(out.readUInt8(0)).toBe(CLIENT_SET_ENCODINGS)

    const setEncodings = out.subarray(0, 4 + 36)
    const parsed = parseSetEncodings(setEncodings)
    expect(parsed.encodings).toContain(ENCODING_COPY_RECT)
    expect(parsed.encodings).toContain(ENCODING_RAW)
    // 伪编码参数真的带上了
    expect(parsed.pseudo.get(PSEUDO_ENCODING_QUALITY_LEVEL)).toBe(6)
    expect(parsed.pseudo.get(PSEUDO_ENCODING_COMPRESS_LEVEL)).toBe(2)

    // 末尾是首次（非增量）帧请求
    const tail = out.subarray(out.length - 10)
    expect(tail.readUInt8(0)).toBe(CLIENT_FB_UPDATE_REQUEST)
    expect(tail.readUInt8(1)).toBe(0) // incremental = false
    expect(tail.readUInt16BE(6)).toBe(1280)
    expect(tail.readUInt16BE(8)).toBe(720)
  })

  it('服务端给 16bpp 时请求转换到 32bpp true colour', () => {
    const protocol = new RfbProtocol()
    protocol.feed(serverVersion(8))
    protocol.drainOutbox()
    protocol.feed(securityList([SECURITY_NONE]))
    protocol.drainOutbox()
    protocol.feed(securityResult(true))
    protocol.drainOutbox()

    protocol.feed(serverInit(640, 480, SERVER_16BPP))
    const out = protocol.drainOutbox()
    expect(out.readUInt8(0)).toBe(CLIENT_SET_PIXEL_FORMAT)

    const requested = decodePixelFormat(out, 4)
    expect(requested).toEqual(PREFERRED_PIXEL_FORMAT)
    expect(pixelFormatEquals(protocol.pixelFormat, PREFERRED_PIXEL_FORMAT)).toBe(true)
  })

  it('桌面名为 UTF-8 多字节时长度按字节算', () => {
    const protocol = new RfbProtocol()
    protocol.feed(serverVersion(8))
    protocol.drainOutbox()
    protocol.feed(securityList([SECURITY_NONE]))
    protocol.drainOutbox()
    protocol.feed(securityResult(true))
    protocol.drainOutbox()

    const events = protocol.feed(serverInit(10, 10, PREFERRED_PIXEL_FORMAT, '桌面-α'))
    expect(events[0]).toMatchObject({ type: 'serverInit', screen: { name: '桌面-α' } })
  })

  it('桌面名长度异常（超过上限）→ 报错而不是分配大内存', () => {
    const protocol = new RfbProtocol()
    protocol.feed(serverVersion(8))
    protocol.drainOutbox()
    protocol.feed(securityList([SECURITY_NONE]))
    protocol.drainOutbox()
    protocol.feed(securityResult(true))
    protocol.drainOutbox()

    const bad = Buffer.alloc(24)
    bad.writeUInt16BE(10, 0)
    bad.writeUInt16BE(10, 2)
    encodePixelFormat(PREFERRED_PIXEL_FORMAT).copy(bad, 4)
    bad.writeUInt32BE(0xffffffff, 20) // 4GB 的名字
    const events = protocol.feed(bad)
    expect(events[0]).toMatchObject({ type: 'error' })
    expect(protocol.currentPhase).toBe('closed')
  })
})

// ---------------------------------------------------------------------------
// 帧缓冲更新
// ---------------------------------------------------------------------------

describe('FramebufferUpdate 解码', () => {
  it('Raw：像素原样给出', () => {
    const { protocol } = handshake()
    protocol.drainOutbox()

    const px = Buffer.concat([bgra(255, 0, 0), bgra(0, 255, 0)]) // 2x1
    const update = fbUpdate([Buffer.concat([rectHeader(5, 6, 2, 1, ENCODING_RAW), px])])
    const events = protocol.feed(update)

    const frame = events.find((e) => e.type === 'frame')
    expect(frame).toBeDefined()
    const rect = (frame as { rects: Array<{ x: number; pixels?: Buffer }> }).rects[0]
    expect(rect?.x).toBe(5)
    expect(rect?.pixels).toEqual(px)

    // 处理后自动请求增量更新
    const out = protocol.drainOutbox()
    expect(out.readUInt8(0)).toBe(CLIENT_FB_UPDATE_REQUEST)
    expect(out.readUInt8(1)).toBe(1) // incremental
  })

  it('CopyRect：只给源坐标（搬运交给渲染层）', () => {
    const { protocol } = handshake()
    protocol.drainOutbox()

    const header = rectHeader(100, 50, 30, 20, ENCODING_COPY_RECT)
    const src = Buffer.alloc(4)
    src.writeUInt16BE(10, 0)
    src.writeUInt16BE(20, 2)
    const events = protocol.feed(fbUpdate([Buffer.concat([header, src])]))

    const frame = events.find((e) => e.type === 'frame') as {
      rects: Array<{ copyFrom?: { x: number; y: number }; pixels?: Buffer }>
    }
    expect(frame.rects[0]?.copyFrom).toEqual({ x: 10, y: 20 })
    expect(frame.rects[0]?.pixels).toBeUndefined()
  })

  it('多个矩形按顺序解码', () => {
    const { protocol } = handshake()
    protocol.drainOutbox()

    const raw1 = Buffer.concat([rectHeader(0, 0, 1, 1, ENCODING_RAW), bgra(1, 2, 3)])
    const copy = rectHeader(1, 0, 1, 1, ENCODING_COPY_RECT)
    const src = Buffer.alloc(4)
    src.writeUInt16BE(0, 0)
    src.writeUInt16BE(0, 2)
    const raw2 = Buffer.concat([rectHeader(2, 0, 1, 1, ENCODING_RAW), bgra(4, 5, 6)])

    const events = protocol.feed(fbUpdate([raw1, Buffer.concat([copy, src]), raw2]))
    const frame = events.find((e) => e.type === 'frame') as { rects: unknown[] }
    expect(frame.rects).toHaveLength(3)
  })

  it('LastRect 伪编码提前结束矩形列表', () => {
    const { protocol } = handshake()
    protocol.drainOutbox()

    const raw = Buffer.concat([rectHeader(0, 0, 1, 1, ENCODING_RAW), bgra(1, 1, 1)])
    // 声明 3 个矩形，但第二个就是 LastRect
    const update = fbUpdate([raw, rectHeader(0, 0, 0, 0, -224), raw], 3)
    const events = protocol.feed(update)
    const frame = events.find((e) => e.type === 'frame') as { rects: unknown[] }
    expect(frame.rects).toHaveLength(1) // LastRect 之后的不再解析
  })

  it('DesktopSize 伪编码更新画面尺寸', () => {
    const { protocol } = handshake()
    protocol.drainOutbox()

    const events = protocol.feed(fbUpdate([rectHeader(0, 0, 1024, 768, -223)]))
    expect(events.some((e) => e.type === 'desktopSize')).toBe(true)
    const frame = events.find((e) => e.type === 'frame') as {
      framebufferWidth: number
      framebufferHeight: number
    }
    expect(frame.framebufferWidth).toBe(1024)
    expect(frame.framebufferHeight).toBe(768)
  })

  it('不支持的编码 → 明确报错（而不是静默丢帧）', () => {
    const { protocol } = handshake()
    protocol.drainOutbox()
    const events = protocol.feed(fbUpdate([rectHeader(0, 0, 1, 1, 7)])) // 7 = Tight
    expect(events[0]).toMatchObject({ type: 'error' })
    expect(String((events[0] as { message: string }).message)).toContain('不支持的编码')
  })

  it('Bell / ServerCutText / SetColourMapEntries', () => {
    const { protocol } = handshake()
    protocol.drainOutbox()

    expect(protocol.feed(Buffer.from([2]))).toEqual([{ type: 'bell' }])

    const text = Buffer.from('剪贴板内容', 'utf8')
    const cut = Buffer.alloc(8 + text.length)
    cut.writeUInt8(3, 0)
    cut.writeUInt32BE(text.length, 4)
    text.copy(cut, 8)
    expect(protocol.feed(cut)).toEqual([{ type: 'clipboard', text: '剪贴板内容' }])

    // SetColourMapEntries：直接跳过（我们只要 true colour）
    const map = Buffer.alloc(1 + 3 + 2 + 6)
    map.writeUInt8(1, 0)
    map.writeUInt16BE(1, 4)
    expect(protocol.feed(map)).toEqual([])
  })
})

describe('Hextile 解码', () => {
  it('背景 + 前景 + 单色子矩形', () => {
    const bg = bgra(0, 0, 0)
    const fg = bgra(255, 255, 0)
    const payload = Buffer.concat([
      Buffer.from([2 | 4 | 8]), // BG_SPECIFIED | FG_SPECIFIED | ANY_SUBRECTS
      bg,
      fg,
      Buffer.from([1]), // 1 个子矩形
      Buffer.from([0x00, 0x10]), // xy=0,0  wh=(2-1)x(1-1) → 2x1
    ])

    const reader = new RfbByteReader(payload)
    const out = decodeHextile(reader, PREFERRED_PIXEL_FORMAT, 16, 16)
    expect(out).not.toBeNull()
    const pixels = out as Buffer
    expect(pixels).toHaveLength(16 * 16 * 4)
    // (0,0) 与 (1,0) 是前景
    expect(pixels.subarray(0, 4)).toEqual(fg)
    expect(pixels.subarray(4, 8)).toEqual(fg)
    // (2,0) 起是背景
    expect(pixels.subarray(8, 12)).toEqual(bg)
    // 第二行整行背景
    expect(pixels.subarray(16 * 4, 32 * 4)).toEqual(
      Buffer.concat(Array.from({ length: 16 }, () => bg)),
    )
  })

  it('Raw tile 直接搬像素', () => {
    const tile = Buffer.concat([bgra(1, 0, 0), bgra(2, 0, 0)]) // 2x1 的 raw tile 数据
    const payload = Buffer.concat([Buffer.from([1]), tile])
    const reader = new RfbByteReader(payload)
    const out = decodeHextile(reader, PREFERRED_PIXEL_FORMAT, 2, 1)
    expect(out).toEqual(tile)
  })

  it('未指定背景的 tile 沿用上一个 tile 的背景（规范要求）', () => {
    const bg = bgra(9, 9, 9)
    const payload = Buffer.concat([
      Buffer.from([2]), // tile1: 只有背景色
      bg,
      Buffer.from([0]), // tile2: 什么都不指定 → 铺 tile1 的背景
    ])
    const reader = new RfbByteReader(payload)
    const out = decodeHextile(reader, PREFERRED_PIXEL_FORMAT, 32, 16) as Buffer
    // 第二个 tile（x=16..31）应全是 bg
    expect(out.subarray(16 * 4, 32 * 4)).toEqual(
      Buffer.concat(Array.from({ length: 16 }, () => bg)),
    )
  })

  it('缓冲不足时返回 null（由调用方等更多字节）', () => {
    const payload = Buffer.concat([Buffer.from([1]), bgra(1, 1, 1)]) // 声明 raw 但只给 1 个像素
    const reader = new RfbByteReader(payload)
    expect(decodeHextile(reader, PREFERRED_PIXEL_FORMAT, 4, 1)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 输入事件编码
// ---------------------------------------------------------------------------

describe('客户端消息编码', () => {
  it('PointerEvent 布局', () => {
    const protocol = new RfbProtocol()
    protocol.sendPointer(0b101, 300, 400)
    const buf = protocol.drainOutbox()
    expect(buf).toHaveLength(6)
    expect(buf.readUInt8(0)).toBe(CLIENT_POINTER_EVENT)
    expect(buf.readUInt8(1)).toBe(0b101)
    expect(buf.readUInt16BE(2)).toBe(300)
    expect(buf.readUInt16BE(4)).toBe(400)
  })

  it('PointerEvent 坐标越界被夹到 0..65535', () => {
    const protocol = new RfbProtocol()
    protocol.sendPointer(0, -5, 999999)
    const buf = protocol.drainOutbox()
    expect(buf.readUInt16BE(2)).toBe(0)
    expect(buf.readUInt16BE(4)).toBe(65535)
  })

  it('KeyEvent 布局（X11 keysym）', () => {
    const protocol = new RfbProtocol()
    protocol.sendKey(true, 0xff0d) // Enter
    protocol.sendKey(false, 0xff0d)
    const buf = protocol.drainOutbox()
    expect(buf).toHaveLength(16)
    expect(buf.readUInt8(0)).toBe(CLIENT_KEY_EVENT)
    expect(buf.readUInt8(1)).toBe(1)
    expect(buf.readUInt32BE(4)).toBe(0xff0d)
    expect(buf.readUInt8(8)).toBe(CLIENT_KEY_EVENT)
    expect(buf.readUInt8(9)).toBe(0)
  })

  it('ClientCutText 布局', () => {
    const protocol = new RfbProtocol()
    protocol.sendClientCutText('hi')
    const buf = protocol.drainOutbox()
    expect(buf.readUInt8(0)).toBe(CLIENT_CUT_TEXT)
    expect(buf.readUInt32BE(4)).toBe(2)
    expect(buf.subarray(8)).toEqual(Buffer.from('hi', 'utf8'))
  })

  it('FramebufferUpdateRequest 布局', () => {
    const protocol = new RfbProtocol()
    protocol.requestFramebufferUpdate({ incremental: true })
    const buf = protocol.drainOutbox()
    expect(buf).toHaveLength(10)
    expect(buf.readUInt8(0)).toBe(CLIENT_FB_UPDATE_REQUEST)
    expect(buf.readUInt8(1)).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// 分片健壮性
// ---------------------------------------------------------------------------

describe('分片喂入', () => {
  it('一字节一字节喂入与一次性喂入产生同样的事件', () => {
    const challenge = Buffer.from('0123456789abcdef', 'latin1')
    const px = Buffer.concat([bgra(255, 0, 0), bgra(0, 0, 255)])
    const full = Buffer.concat([
      serverVersion(8),
      securityList([SECURITY_VNC_AUTH]),
      challenge,
      securityResult(true),
      serverInit(2, 1, PREFERRED_PIXEL_FORMAT, 'tiny'),
      fbUpdate([Buffer.concat([rectHeader(0, 0, 2, 1, ENCODING_RAW), px])]),
    ])

    const whole = new RfbProtocol({ authType: 'vnc-password', password: 'pw' })
    const wholeEvents = whole.feed(full)

    const piecemeal = new RfbProtocol({ authType: 'vnc-password', password: 'pw' })
    const pieceEvents: RfbEvent[] = []
    for (let i = 0; i < full.length; i += 1) {
      pieceEvents.push(...piecemeal.feed(full.subarray(i, i + 1)))
    }

    expect(pieceEvents.map((e) => e.type)).toEqual(wholeEvents.map((e) => e.type))
    const frameWhole = wholeEvents.find((e) => e.type === 'frame') as { rects: unknown[] }
    const framePiece = pieceEvents.find((e) => e.type === 'frame') as { rects: unknown[] }
    expect(framePiece.rects).toHaveLength(frameWhole.rects.length)
    expect(piecemeal.currentPhase).toBe('ready')
  })

  it('半截矩形不会被当成完整帧', () => {
    const { protocol } = handshake()
    protocol.drainOutbox()

    const px = Buffer.concat([bgra(1, 1, 1), bgra(2, 2, 2)]) // 需要 8 字节
    const update = fbUpdate([Buffer.concat([rectHeader(0, 0, 2, 1, ENCODING_RAW), px])])

    // 先喂一半（矩形数据缺 1 字节）
    const partial = protocol.feed(update.subarray(0, update.length - 1))
    expect(partial.some((e) => e.type === 'frame')).toBe(false)

    // 补上最后一字节 → 这次才出帧
    const rest = protocol.feed(update.subarray(update.length - 1))
    expect(rest.some((e) => e.type === 'frame')).toBe(true)
  })
})
