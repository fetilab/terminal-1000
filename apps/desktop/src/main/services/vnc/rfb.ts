// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * RFB 3.8 客户端协议实现（**纯逻辑，不依赖 socket**）。
 *
 * 与 `services/telnet/protocol.ts` 同样的分层：这里只做「字节流进 → 事件出」，
 * 网络由 `index.ts` 负责。因此握手、像素格式、编码解码、输入事件编码
 * 全部可以用手写字节流单测，不需要真实 VNC 服务端。
 *
 * 覆盖范围（按任务书要求）：
 * - 版本协商（3.8；同时兼容 3.7 的安全类型列表与 3.3 的 4 字节安全类型）
 * - 安全类型：None / VNC Authentication（DES，**每字节位序反转**）
 * - ClientInit（shared 标志）→ ServerInit（宽高 + 像素格式 + 桌面名）
 * - 像素格式：统一请求 32bpp true colour（redShift16/greenShift8/blueShift0）；
 *   服务端给别的格式时用 SetPixelFormat 请求转换，而不是自己解析各种古怪格式
 * - 编码：Raw / CopyRect / Hextile（解码）+ DesktopSize / LastRect 伪编码
 * - 输入：PointerEvent / KeyEvent（X11 keysym）/ ClientCutText
 *
 * ★ 为什么自己实现 DES（而不是用 node:crypto 的 des-ecb）：
 *   OpenSSL 3 把 DES 移到了 legacy provider，默认 provider 里没有 ——
 *   `createCipheriv('des-ecb')` 会直接抛 `ERR_OSSL_EVP_UNSUPPORTED`
 *   （实测 Node v24 + OpenSSL 3.5：`getCiphers()` 里连 'des-ecb' 都不存在）。
 *   靠 `--openssl-legacy-provider` 启动参数能绕过，但那要改应用启动配置、且各平台不可控。
 *   VNC 认证只需要「单块 DES 加密」，于是这里按 FIPS 46-3 自带一份纯 TS 实现：
 *   零 provider 依赖、各平台一致，位序处理也完全显式。
 *
 * ★ DES 位序的坑（本文件 `vncDesKey`）：
 *   VNC 认证用口令的 8 字节做 DES 密钥，但**每个字节的 8 个 bit 要反转**
 *   （bit0↔bit7 …）。这是 RFB 实现最经典的错误：不反转时服务端只会回
 *   "认证失败"，看起来像密码错，极难排查。`rfb.test.ts` 里有独立实现的位序校验。
 */

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 我们支持的版本（响应串） */
export const RFB_VERSION_3_8 = 'RFB 003.008\n'
/** 安全类型 */
export const SECURITY_TYPE_INVALID = 0
export const SECURITY_NONE = 1
export const SECURITY_VNC_AUTH = 2
/** SecurityResult 取值 */
export const SECURITY_RESULT_OK = 0
export const SECURITY_RESULT_FAILED = 1

/** 真实编码 */
export const ENCODING_RAW = 0
export const ENCODING_COPY_RECT = 1
export const ENCODING_HEXTILE = 5
/** 伪编码（负数用 int32 表示） */
export const PSEUDO_ENCODING_DESKTOP_SIZE = -223
export const PSEUDO_ENCODING_LAST_RECT = -224
export const PSEUDO_ENCODING_COMPRESS_LEVEL = -247
export const PSEUDO_ENCODING_QUALITY_LEVEL = -256

/** 客户端 → 服务端 消息类型 */
export const CLIENT_SET_PIXEL_FORMAT = 0
export const CLIENT_SET_ENCODINGS = 2
export const CLIENT_FB_UPDATE_REQUEST = 3
export const CLIENT_KEY_EVENT = 4
export const CLIENT_POINTER_EVENT = 5
export const CLIENT_CUT_TEXT = 6

/** 服务端 → 客户端 消息类型 */
export const SERVER_FB_UPDATE = 0
export const SERVER_SET_COLOUR_MAP = 1
export const SERVER_BELL = 2
export const SERVER_CUT_TEXT = 3

/**
 * 字符串（桌面名 / 剪贴板）长度上限。
 * 远端长度字段不可信：没有上限时一个畸形报文就能让主进程分配几个 GB。
 */
export const MAX_RFB_STRING_BYTES = 8 * 1024 * 1024

/** 一帧最多多少矩形（防御畸形报文） */
/**
 * 单帧矩形数上限（安全阀，不是协议真值）。
 *
 * 定得比"理论最大值"宽松：Hextile 按 16x16 分块，1280x800 满屏可达 4000 个矩形，
 * 4096 太贴边。这里只用于防止畸形流把内存打爆。
 */
export const MAX_RECTS_PER_UPDATE = 65535

/** 常用 X11 keysym（UI 侧一般自己算，这里给一组便于直接调用/测试） */
export const KEYSYM = {
  Backspace: 0xff08,
  Tab: 0xff09,
  Enter: 0xff0d,
  Escape: 0xff1b,
  Insert: 0xff63,
  Delete: 0xffff,
  Home: 0xff50,
  End: 0xff57,
  PageUp: 0xff55,
  PageDown: 0xff56,
  Left: 0xff51,
  Up: 0xff52,
  Right: 0xff53,
  Down: 0xff54,
  F1: 0xffbe,
  F2: 0xffbf,
  F3: 0xffc0,
  F4: 0xffc1,
  F5: 0xffc2,
  F6: 0xffc3,
  F7: 0xffc4,
  F8: 0xffc5,
  F9: 0xffc6,
  F10: 0xffc7,
  F11: 0xffc8,
  F12: 0xffc9,
  ShiftLeft: 0xffe1,
  ShiftRight: 0xffe2,
  ControlLeft: 0xffe3,
  ControlRight: 0xffe4,
  AltLeft: 0xffe9,
  AltRight: 0xffea,
  MetaLeft: 0xffeb,
  MetaRight: 0xffec,
} as const

// ---------------------------------------------------------------------------
// 像素格式
// ---------------------------------------------------------------------------

export interface RfbPixelFormat {
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

/**
 * 我们统一请求的像素格式：32bpp / depth24 / 小端 / true colour，
 * 内存里就是 BGRA 字节序（值 = R<<16 | G<<8 | B）—— 渲染层可直接塞进 ImageData。
 */
export const PREFERRED_PIXEL_FORMAT: RfbPixelFormat = {
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

/** 每像素字节数（RFB 允许非整字节 bpp，向上取整） */
export function pixelSize(format: RfbPixelFormat): number {
  return Math.ceil(format.bitsPerPixel / 8)
}

export function pixelFormatEquals(a: RfbPixelFormat, b: RfbPixelFormat): boolean {
  return (
    a.bitsPerPixel === b.bitsPerPixel &&
    a.depth === b.depth &&
    a.bigEndian === b.bigEndian &&
    a.trueColour === b.trueColour &&
    a.redMax === b.redMax &&
    a.greenMax === b.greenMax &&
    a.blueMax === b.blueMax &&
    a.redShift === b.redShift &&
    a.greenShift === b.greenShift &&
    a.blueShift === b.blueShift
  )
}

/** 编码 16 字节像素格式（SetPixelFormat / ServerInit 共用） */
export function encodePixelFormat(format: RfbPixelFormat): Buffer {
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
  // 13..15 padding，已是 0
  return buf
}

export function decodePixelFormat(buf: Buffer, offset = 0): RfbPixelFormat {
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

// ---------------------------------------------------------------------------
// VNC Authentication（DES + 位序反转）
// ---------------------------------------------------------------------------

/**
 * 反转一个字节的 8 个 bit（bit0↔bit7、bit1↔bit6 …）。
 *
 * 用「先用掩码交换半字节、再交换 2 位、再交换相邻位」的蝴蝶操作实现；
 * 测试里用 `toString(2)` 字符串反转的独立写法交叉验证，避免自证。
 */
export function reverseBits8(value: number): number {
  let b = value & 0xff
  b = ((b & 0xf0) >> 4) | ((b & 0x0f) << 4)
  b = ((b & 0xcc) >> 2) | ((b & 0x33) << 2)
  b = ((b & 0xaa) >> 1) | ((b & 0x55) << 1)
  return b & 0xff
}

/**
 * 口令 → DES 密钥（8 字节，**每字节位序反转**）。
 *
 * 超长口令截断到 8 字节，不足补 0 —— 与 RFB 规范一致（VNC 口令最多 8 字节）。
 */
export function vncDesKey(password: string | Buffer): Buffer {
  const raw = Buffer.isBuffer(password) ? password : Buffer.from(password, 'utf8')
  const key = Buffer.alloc(8)
  raw.copy(key, 0, 0, Math.min(8, raw.length))
  for (let i = 0; i < 8; i += 1) {
    key.writeUInt8(reverseBits8(key.readUInt8(i)), i)
  }
  return key
}

/**
 * 用口令加密 16 字节 challenge（DES-ECB，无填充）。
 *
 * 这是 VNC 认证的应答；服务端用同样的约定解密后比对口令。
 * 位序忘反转 → 服务端解出来是另一个口令 → 回 SecurityResult=failed（"认证被拒"）。
 */
export function vncEncryptChallenge(password: string, challenge: Buffer): Buffer {
  if (challenge.length !== 16) {
    throw new Error(`VNC challenge 必须是 16 字节，收到 ${challenge.length}`)
  }
  // 16 字节 = 两个 DES 块（ECB，无填充）
  const key = vncDesKey(password)
  return Buffer.concat([
    desEncryptBlock(key, challenge.subarray(0, 8)),
    desEncryptBlock(key, challenge.subarray(8, 16)),
  ])
}

/** DES 加密一个 8 字节块（VNC 只用得到这一种方向） */
export function desEncryptBlock(key: Buffer, block: Buffer): Buffer {
  return desCrypt(key, block, false)
}

/** DES 解密一个 8 字节块（对称性校验与服务端模拟用） */
export function desDecryptBlock(key: Buffer, block: Buffer): Buffer {
  return desCrypt(key, block, true)
}

/** 与 `vncEncryptChallenge` 对称的解密（仅测试与诊断用，服务端才真的需要） */
export function vncDecryptChallenge(password: string, encrypted: Buffer): Buffer {
  const key = vncDesKey(password)
  const out = Buffer.alloc(encrypted.length)
  for (let offset = 0; offset + 8 <= encrypted.length; offset += 8) {
    desDecryptBlock(key, encrypted.subarray(offset, offset + 8)).copy(out, offset)
  }
  return out
}

// ---------------------------------------------------------------------------
// 纯 TS DES（FIPS 46-3）；只做 ECB 单块，够 VNC 认证用
// ---------------------------------------------------------------------------

/* 标准置换表；位序按规范从 1 开始计（MSB 为 1） */
const DES_IP: readonly number[] = [
  58, 50, 42, 34, 26, 18, 10, 2, 60, 52, 44, 36, 28, 20, 12, 4,
  62, 54, 46, 38, 30, 22, 14, 6, 64, 56, 48, 40, 32, 24, 16, 8,
  57, 49, 41, 33, 25, 17, 9, 1, 59, 51, 43, 35, 27, 19, 11, 3,
  61, 53, 45, 37, 29, 21, 13, 5, 63, 55, 47, 39, 31, 23, 15, 7,
]
const DES_FP: readonly number[] = [
  40, 8, 48, 16, 56, 24, 64, 32, 39, 7, 47, 15, 55, 23, 63, 31,
  38, 6, 46, 14, 54, 22, 62, 30, 37, 5, 45, 13, 53, 21, 61, 29,
  36, 4, 44, 12, 52, 20, 60, 28, 35, 3, 43, 11, 51, 19, 59, 27,
  34, 2, 42, 10, 50, 18, 58, 26, 33, 1, 41, 9, 49, 17, 57, 25,
]
const DES_E: readonly number[] = [
  32, 1, 2, 3, 4, 5, 4, 5, 6, 7, 8, 9, 8, 9, 10, 11, 12, 13, 12, 13, 14, 15, 16, 17,
  16, 17, 18, 19, 20, 21, 20, 21, 22, 23, 24, 25, 24, 25, 26, 27, 28, 29, 28, 29, 30, 31, 32, 1,
]
const DES_P: readonly number[] = [
  16, 7, 20, 21, 29, 12, 28, 17, 1, 15, 23, 26, 5, 18, 31, 10,
  2, 8, 24, 14, 32, 27, 3, 9, 19, 13, 30, 6, 22, 11, 4, 25,
]
const DES_PC1: readonly number[] = [
  57, 49, 41, 33, 25, 17, 9, 1, 58, 50, 42, 34, 26, 18, 10, 2,
  59, 51, 43, 35, 27, 19, 11, 3, 60, 52, 44, 36, 63, 55, 47, 39,
  31, 23, 15, 7, 62, 54, 46, 38, 30, 22, 14, 6, 61, 53, 45, 37,
  29, 21, 13, 5, 28, 20, 12, 4,
]
const DES_PC2: readonly number[] = [
  14, 17, 11, 24, 1, 5, 3, 28, 15, 6, 21, 10, 23, 19, 12, 4,
  26, 8, 16, 7, 27, 20, 13, 2, 41, 52, 31, 37, 47, 55, 30, 40,
  51, 45, 33, 48, 44, 49, 39, 56, 34, 53, 46, 42, 50, 36, 29, 32,
]
const DES_SHIFTS: readonly number[] = [1, 1, 2, 2, 2, 2, 2, 2, 1, 2, 2, 2, 2, 2, 2, 1]
const DES_SBOX: readonly (readonly number[])[] = [
  [
    14, 4, 13, 1, 2, 15, 11, 8, 3, 10, 6, 12, 5, 9, 0, 7,
    0, 15, 7, 4, 14, 2, 13, 1, 10, 6, 12, 11, 9, 5, 3, 8,
    4, 1, 14, 8, 13, 6, 2, 11, 15, 12, 9, 7, 3, 10, 5, 0,
    15, 12, 8, 2, 4, 9, 1, 7, 5, 11, 3, 14, 10, 0, 6, 13,
  ],
  [
    15, 1, 8, 14, 6, 11, 3, 4, 9, 7, 2, 13, 12, 0, 5, 10,
    3, 13, 4, 7, 15, 2, 8, 14, 12, 0, 1, 10, 6, 9, 11, 5,
    0, 14, 7, 11, 10, 4, 13, 1, 5, 8, 12, 6, 9, 3, 2, 15,
    13, 8, 10, 1, 3, 15, 4, 2, 11, 6, 7, 12, 0, 5, 14, 9,
  ],
  [
    10, 0, 9, 14, 6, 3, 15, 5, 1, 13, 12, 7, 11, 4, 2, 8,
    13, 7, 0, 9, 3, 4, 6, 10, 2, 8, 5, 14, 12, 11, 15, 1,
    13, 6, 4, 9, 8, 15, 3, 0, 11, 1, 2, 12, 5, 10, 14, 7,
    1, 10, 13, 0, 6, 9, 8, 7, 4, 15, 14, 3, 11, 5, 2, 12,
  ],
  [
    7, 13, 14, 3, 0, 6, 9, 10, 1, 2, 8, 5, 11, 12, 4, 15,
    13, 8, 11, 5, 6, 15, 0, 3, 4, 7, 2, 12, 1, 10, 14, 9,
    10, 6, 9, 0, 12, 11, 7, 13, 15, 1, 3, 14, 5, 2, 8, 4,
    3, 15, 0, 6, 10, 1, 13, 8, 9, 4, 5, 11, 12, 7, 2, 14,
  ],
  [
    2, 12, 4, 1, 7, 10, 11, 6, 8, 5, 3, 15, 13, 0, 14, 9,
    14, 11, 2, 12, 4, 7, 13, 1, 5, 0, 15, 10, 3, 9, 8, 6,
    4, 2, 1, 11, 10, 13, 7, 8, 15, 9, 12, 5, 6, 3, 0, 14,
    11, 8, 12, 7, 1, 14, 2, 13, 6, 15, 0, 9, 10, 4, 5, 3,
  ],
  [
    12, 1, 10, 15, 9, 2, 6, 8, 0, 13, 3, 4, 14, 7, 5, 11,
    10, 15, 4, 2, 7, 12, 9, 5, 6, 1, 13, 14, 0, 11, 3, 8,
    9, 14, 15, 5, 2, 8, 12, 3, 7, 0, 4, 10, 1, 13, 11, 6,
    4, 3, 2, 12, 9, 5, 15, 10, 11, 14, 1, 7, 6, 0, 8, 13,
  ],
  [
    4, 11, 2, 14, 15, 0, 8, 13, 3, 12, 9, 7, 5, 10, 6, 1,
    13, 0, 11, 7, 4, 9, 1, 10, 14, 3, 5, 12, 2, 15, 8, 6,
    1, 4, 11, 13, 12, 3, 7, 14, 10, 15, 6, 8, 0, 5, 9, 2,
    6, 11, 13, 8, 1, 4, 10, 7, 9, 5, 0, 15, 14, 2, 3, 12,
  ],
  [
    13, 2, 8, 4, 6, 15, 11, 1, 10, 9, 3, 14, 5, 0, 12, 7,
    1, 15, 13, 8, 10, 3, 7, 4, 12, 5, 6, 11, 0, 14, 9, 2,
    7, 11, 4, 1, 9, 12, 14, 2, 0, 6, 10, 13, 15, 3, 5, 8,
    2, 1, 14, 7, 4, 10, 8, 13, 15, 12, 9, 0, 3, 5, 6, 11,
  ],
]

/** 1-based 位置置换：pos 表示「输入从 MSB 起第 pos 位」 */
function desPermute(input: bigint, table: readonly number[], inputBits: number): bigint {
  let out = 0n
  for (const pos of table) {
    out = (out << 1n) | ((input >> BigInt(inputBits - pos)) & 1n)
  }
  return out
}

function desSubkeys(key: bigint): bigint[] {
  const permuted = desPermute(key, DES_PC1, 64) // 56 bit
  let c = permuted >> 28n
  let d = permuted & 0x0fffffffn
  const subkeys: bigint[] = []
  for (let round = 0; round < 16; round += 1) {
    const shift = BigInt(DES_SHIFTS[round] as number)
    c = ((c << shift) | (c >> (28n - shift))) & 0x0fffffffn
    d = ((d << shift) | (d >> (28n - shift))) & 0x0fffffffn
    subkeys.push(desPermute((c << 28n) | d, DES_PC2, 56))
  }
  return subkeys
}

function desFeistel(half: bigint, subkey: bigint): bigint {
  const expanded = desPermute(half, DES_E, 32) ^ subkey
  let substituted = 0n
  for (let box = 0; box < 8; box += 1) {
    const chunk = Number((expanded >> BigInt(42 - 6 * box)) & 0x3fn)
    const row = ((chunk & 0x20) >> 4) | (chunk & 0x01)
    const col = (chunk >> 1) & 0x0f
    const value = DES_SBOX[box]?.[row * 16 + col]
    substituted = (substituted << 4n) | BigInt(value ?? 0)
  }
  return desPermute(substituted, DES_P, 32)
}

/** 单块 DES（64 bit ↔ 8 字节，ECB，无填充） */
function desCrypt(key: Buffer, block: Buffer, decrypt: boolean): Buffer {
  if (key.length !== 8) throw new Error(`DES 密钥必须是 8 字节，收到 ${key.length}`)
  if (block.length !== 8) throw new Error(`DES 数据块必须是 8 字节，收到 ${block.length}`)

  const subkeys = desSubkeys(BigInt(`0x${key.toString('hex')}`))
  const input = BigInt(`0x${block.toString('hex')}`)
  const permuted = desPermute(input, DES_IP, 64)
  let left = permuted >> 32n
  let right = permuted & 0xffffffffn

  for (let round = 0; round < 16; round += 1) {
    const subkey = subkeys[decrypt ? 15 - round : round] as bigint
    const f = desFeistel(right, subkey)
    const nextLeft = right
    const nextRight = left ^ f
    left = nextLeft
    right = nextRight
  }

  // 末置换前交换左右（preoutput = R16 L16）
  const preoutput = (right << 32n) | left
  const out = desPermute(preoutput, DES_FP, 64)
  const hex = out.toString(16).padStart(16, '0')
  return Buffer.from(hex, 'hex')
}

// ---------------------------------------------------------------------------
// 事件与状态
// ---------------------------------------------------------------------------

export type RfbPhase =
  | 'version'
  | 'security'
  | 'security33'
  | 'challenge'
  | 'securityResult'
  | 'serverInit'
  | 'ready'
  | 'closed'

export interface RfbScreen {
  width: number
  height: number
  name: string
  pixelFormat: RfbPixelFormat
}

/** 一个已解码的更新矩形（CopyRect 只给源坐标，由渲染层在画布上搬） */
export interface RfbRect {
  x: number
  y: number
  width: number
  height: number
  encoding: number
  /** Raw / Hextile：32bpp BGRA 像素（长度 = width*height*pixelSize） */
  pixels?: Buffer
  /** CopyRect：源矩形左上角 */
  copyFrom?: { x: number; y: number }
}

export type RfbEvent =
  | { type: 'version'; serverVersion: string; clientVersion: string }
  | { type: 'security'; securityType: number; fromList: boolean }
  | { type: 'securityResult'; ok: boolean; reason?: string }
  | { type: 'serverInit'; screen: RfbScreen }
  | { type: 'desktopSize'; width: number; height: number }
  | {
      type: 'frame'
      rects: RfbRect[]
      framebufferWidth: number
      framebufferHeight: number
    }
  | { type: 'bell' }
  | { type: 'clipboard'; text: string }
  | { type: 'error'; message: string }

// ---------------------------------------------------------------------------
// 字节读取器（游标式；不够读时返回 null，由调用方回滚）
// ---------------------------------------------------------------------------

export class RfbByteReader {
  offset: number

  constructor(
    private readonly buf: Buffer,
    offset = 0,
  ) {
    this.offset = offset
  }

  get remaining(): number {
    return this.buf.length - this.offset
  }

  need(bytes: number): boolean {
    return this.remaining >= bytes
  }

  u8(): number {
    const value = this.buf.readUInt8(this.offset)
    this.offset += 1
    return value
  }

  u16(): number {
    const value = this.buf.readUInt16BE(this.offset)
    this.offset += 2
    return value
  }

  i32(): number {
    const value = this.buf.readInt32BE(this.offset)
    this.offset += 4
    return value
  }

  u32(): number {
    const value = this.buf.readUInt32BE(this.offset)
    this.offset += 4
    return value
  }

  bytes(length: number): Buffer {
    const out = this.buf.subarray(this.offset, this.offset + length)
    this.offset += length
    return out
  }

  skip(length: number): void {
    this.offset += length
  }
}

// ---------------------------------------------------------------------------
// 协议状态机
// ---------------------------------------------------------------------------

export interface RfbProtocolOptions {
  /** 认证方式（来自连接配置）：none 或 vnc-password */
  authType?: 'none' | 'vnc-password'
  password?: string
  /** ClientInit 的 shared 标志（连接配置里的 shared） */
  shared?: boolean
  /** 画面清晰度 0..9 → QualityLevel 伪编码 */
  qualityLevel?: number
  /** 压缩强度 0..9 → CompressLevel 伪编码 */
  compressionLevel?: number
  /** 期望的客户端编码列表（默认 CopyRect + Hextile + Raw） */
  encodings?: readonly number[]
}

/** 解析结果类型 */
type ParseOutcome = 'ok' | 'need-more'

export class RfbProtocol {
  // 显式标注为 Buffer（而不是让 TS 推断成 Buffer<ArrayBuffer>）：
  // subarray/concat 返回的是 Buffer<ArrayBufferLike>，推断型字段接不住
  private buffer: Buffer = Buffer.alloc(0)
  private phase: RfbPhase = 'version'
  private readonly outbox: Buffer[] = []

  private serverVersion = ''
  private negotiatedMinor = 8
  private securityType = 0
  private screen: RfbScreen | null = null
  private format: RfbPixelFormat = PREFERRED_PIXEL_FORMAT

  constructor(private readonly options: RfbProtocolOptions = {}) {}

  get currentPhase(): RfbPhase {
    return this.phase
  }

  get screenInfo(): RfbScreen | null {
    return this.screen
  }

  /** 当前生效的像素格式（ServerInit 之后就是服务端给的那个） */
  get pixelFormat(): RfbPixelFormat {
    return this.format
  }

  /** 取走待发送字节（交给 socket 写） */
  drainOutbox(): Buffer {
    if (this.outbox.length === 0) return Buffer.alloc(0)
    const merged = Buffer.concat(this.outbox)
    this.outbox.length = 0
    return merged
  }

  /**
   * 喂入服务端字节流，返回本次能解析出的完整事件。
   * 半截报文会留在内部缓冲里等下一个 chunk（不会误解析）。
   */
  feed(chunk: Buffer): RfbEvent[] {
    if (chunk.length > 0) {
      this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk])
    }
    const events: RfbEvent[] = []
    let consumed = 0

    while (this.phase !== 'closed') {
      const reader = new RfbByteReader(this.buffer, consumed)
      const outcome = this.parseOne(reader, events)
      if (outcome === 'need-more') break
      if (reader.offset <= consumed) break // 防御：没有前进就退出，避免死循环
      consumed = reader.offset
    }

    if (consumed > 0) this.buffer = this.buffer.subarray(consumed)
    return events
  }

  // -------------------------------------------------------------- 客户端消息

  /** 请求帧缓冲更新（incremental=true 时只要变化区域） */
  /** 当前阶段（诊断用：握手卡住时能一眼看出停在哪一步） */
  phaseName(): string {
    return this.phase
  }

  requestFramebufferUpdate(options: { incremental?: boolean } = {}): void {
    const screen = this.screen
    const width = screen?.width ?? 0
    const height = screen?.height ?? 0
    const buf = Buffer.alloc(10)
    buf.writeUInt8(CLIENT_FB_UPDATE_REQUEST, 0)
    buf.writeUInt8(options.incremental === true ? 1 : 0, 1)
    // x / y / width / height
    buf.writeUInt16BE(0, 2)
    buf.writeUInt16BE(0, 4)
    buf.writeUInt16BE(width, 6)
    buf.writeUInt16BE(height, 8)
    this.outbox.push(buf)
  }

  /** 鼠标事件：buttonMask 位 0..7 = 左/中/右/滚上/滚下/…，坐标是远端像素坐标 */
  sendPointer(buttonMask: number, x: number, y: number): void {
    const buf = Buffer.alloc(6)
    buf.writeUInt8(CLIENT_POINTER_EVENT, 0)
    buf.writeUInt8(buttonMask & 0xff, 1)
    buf.writeUInt16BE(clampU16(x), 2)
    buf.writeUInt16BE(clampU16(y), 4)
    this.outbox.push(buf)
  }

  /** 键盘事件：key 是 X11 keysym */
  sendKey(down: boolean, key: number): void {
    const buf = Buffer.alloc(8)
    buf.writeUInt8(CLIENT_KEY_EVENT, 0)
    buf.writeUInt8(down ? 1 : 0, 1)
    buf.writeUInt8(0, 2)
    buf.writeUInt8(0, 3)
    buf.writeUInt32BE(key >>> 0, 4)
    this.outbox.push(buf)
  }

  /** 把本地剪贴板文本发给服务端（Latin-1 语义，按 UTF-8 发送是常见做法） */
  sendClientCutText(text: string): void {
    const payload = Buffer.from(text, 'utf8')
    const buf = Buffer.alloc(8 + payload.length)
    buf.writeUInt8(CLIENT_CUT_TEXT, 0)
    buf.writeUInt32BE(payload.length, 4)
    payload.copy(buf, 8)
    this.outbox.push(buf)
  }

  // -------------------------------------------------------------- 解析

  private parseOne(reader: RfbByteReader, events: RfbEvent[]): ParseOutcome {
    switch (this.phase) {
      case 'version':
        return this.parseVersion(reader, events)
      case 'security':
        return this.parseSecurityList(reader, events)
      case 'security33':
        return this.parseSecurity33(reader, events)
      case 'challenge':
        return this.parseChallenge(reader, events)
      case 'securityResult':
        return this.parseSecurityResult(reader, events)
      case 'serverInit':
        return this.parseServerInit(reader, events)
      case 'ready':
        return this.parseServerMessage(reader, events)
      case 'closed':
        return 'need-more'
    }
  }

  private parseVersion(reader: RfbByteReader, events: RfbEvent[]): ParseOutcome {
    if (!reader.need(12)) return 'need-more'
    const text = reader.bytes(12).toString('latin1')
    const match = /^RFB (\d{3})\.(\d{3})\n$/.exec(text)
    if (!match) {
      events.push({ type: 'error', message: `无法识别的 RFB 版本串: ${JSON.stringify(text)}` })
      this.phase = 'closed'
      return 'ok'
    }

    this.serverVersion = text
    const minor = Number(match[2])
    this.negotiatedMinor = Math.min(minor, 8)
    // 服务端版本高于我们时回落 3.8；低于时按服务端的版本通信（3.3/3.7 的差异在安全阶段）
    const clientVersion = minor >= 8 ? RFB_VERSION_3_8 : `RFB 003.${match[2]}\n`
    this.outbox.push(Buffer.from(clientVersion, 'latin1'))
    events.push({ type: 'version', serverVersion: text, clientVersion })

    // 3.3 用「4 字节安全类型」，3.7+ 用「数量 + 列表」
    this.phase = minor >= 7 ? 'security' : 'security33'
    return 'ok'
  }

  private parseSecurityList(reader: RfbByteReader, events: RfbEvent[]): ParseOutcome {
    if (!reader.need(1)) return 'need-more'
    const count = reader.u8()
    if (count === 0) {
      // 服务端拒绝：后面跟原因字符串
      const reason = this.tryReadReason(reader)
      events.push({
        type: 'error',
        message: `服务端拒绝了连接${reason === undefined ? '' : `：${reason}`}`,
      })
      this.phase = 'closed'
      return 'ok'
    }
    if (!reader.need(count)) return 'need-more'

    const offered: number[] = []
    for (let i = 0; i < count; i += 1) offered.push(reader.u8())

    const wanted = this.selectSecurityType(offered)
    if (wanted === null) {
      events.push({
        type: 'error',
        message: `服务端不支持可用的安全类型（提供 ${offered.join(',')}，本端配置 ${this.options.authType ?? 'none'}）`,
      })
      this.phase = 'closed'
      return 'ok'
    }
    if (wanted === SECURITY_VNC_AUTH && !this.options.password) {
      events.push({ type: 'error', message: '服务端要求 VNC 口令认证，但未配置口令' })
      this.phase = 'closed'
      return 'ok'
    }

    this.securityType = wanted
    this.outbox.push(Buffer.from([wanted]))
    events.push({ type: 'security', securityType: wanted, fromList: true })

    if (wanted === SECURITY_VNC_AUTH) {
      this.phase = 'challenge'
    } else if (this.negotiatedMinor >= 8) {
      // 3.8 起，即使 None 也会回 SecurityResult
      this.phase = 'securityResult'
    } else {
      // 3.7 及更早：None 之后直接 ClientInit（等服务端发 SecurityResult 会死等）
      this.queueClientInit()
      this.phase = 'serverInit'
    }
    return 'ok'
  }

  /** 兼容 3.3：直接一个 4 字节安全类型 */
  private parseSecurity33(reader: RfbByteReader, events: RfbEvent[]): ParseOutcome {
    if (!reader.need(4)) return 'need-more'
    const type = reader.u32()
    if (type === SECURITY_TYPE_INVALID) {
      events.push({ type: 'error', message: '服务端拒绝了连接（安全类型无效）' })
      this.phase = 'closed'
      return 'ok'
    }
    this.securityType = type
    events.push({ type: 'security', securityType: type, fromList: false })

    if (type === SECURITY_VNC_AUTH) {
      if (!this.options.password) {
        events.push({ type: 'error', message: '服务端要求 VNC 口令认证，但未配置口令' })
        this.phase = 'closed'
        return 'ok'
      }
      this.phase = 'challenge'
      return 'ok'
    }
    if (type === SECURITY_NONE) {
      // 3.3/3.7 的 None 不发送 SecurityResult，直接进入 ClientInit
      this.queueClientInit()
      this.phase = 'serverInit'
      return 'ok'
    }
    events.push({ type: 'error', message: `不支持的安全类型: ${type}` })
    this.phase = 'closed'
    return 'ok'
  }

  private parseChallenge(reader: RfbByteReader, events: RfbEvent[]): ParseOutcome {
    if (!reader.need(16)) return 'need-more'
    const challenge = Buffer.from(reader.bytes(16)) // 复制，避免持有大缓冲
    const password = this.options.password ?? ''
    this.outbox.push(vncEncryptChallenge(password, challenge))
    // 3.8 之后 VNC Auth 也会回 SecurityResult
    this.phase = 'securityResult'
    void events
    return 'ok'
  }

  private parseSecurityResult(reader: RfbByteReader, events: RfbEvent[]): ParseOutcome {
    if (!reader.need(4)) return 'need-more'
    const result = reader.u32()
    const ok = result === SECURITY_RESULT_OK
    const reason = ok ? undefined : this.tryReadReason(reader)
    events.push({
      type: 'securityResult',
      ok,
      ...(reason === undefined ? {} : { reason }),
    })

    if (!ok) {
      events.push({
        type: 'error',
        message: `VNC 认证失败${reason === undefined ? '' : `：${reason}`}（口令错误，或口令位序实现有误）`,
      })
      this.phase = 'closed'
      return 'ok'
    }

    // None 且 3.8：也要读 SecurityResult；通过后进入 ClientInit
    this.queueClientInit()
    this.phase = 'serverInit'
    return 'ok'
  }

  private parseServerInit(reader: RfbByteReader, events: RfbEvent[]): ParseOutcome {
    if (!reader.need(24)) return 'need-more'
    const width = reader.u16()
    const height = reader.u16()
    const pixelFormat = decodePixelFormat(reader.bytes(16))
    const nameLength = reader.u32()
    if (nameLength > MAX_RFB_STRING_BYTES) {
      events.push({ type: 'error', message: `桌面名长度异常: ${nameLength}` })
      this.phase = 'closed'
      return 'ok'
    }
    if (!reader.need(nameLength)) return 'need-more'
    const name = reader.bytes(nameLength).toString('utf8')

    this.format = pixelFormat
    this.screen = { width, height, name, pixelFormat }
    events.push({ type: 'serverInit', screen: this.screen })

    // 服务端给的格式不是我们想要的 → 请求转换（而不是自己解析各种古怪格式）
    if (!pixelFormatEquals(pixelFormat, PREFERRED_PIXEL_FORMAT) || !pixelFormat.trueColour) {
      this.queueSetPixelFormat(PREFERRED_PIXEL_FORMAT)
      this.format = PREFERRED_PIXEL_FORMAT
    }
    this.queueSetEncodings()
    this.requestFramebufferUpdate({ incremental: false })
    this.phase = 'ready'
    return 'ok'
  }

  private parseServerMessage(reader: RfbByteReader, events: RfbEvent[]): ParseOutcome {
    if (!reader.need(1)) return 'need-more'
    const type = reader.u8()

    if (type === SERVER_FB_UPDATE) {
      return this.parseFramebufferUpdate(reader, events)
    }
    if (type === SERVER_BELL) {
      events.push({ type: 'bell' })
      return 'ok'
    }
    if (type === SERVER_CUT_TEXT) {
      if (!reader.need(7)) return 'need-more'
      reader.skip(3)
      const length = reader.u32()
      if (length > MAX_RFB_STRING_BYTES) {
        events.push({ type: 'error', message: `剪贴板长度异常: ${length}` })
        this.phase = 'closed'
        return 'ok'
      }
      if (!reader.need(length)) return 'need-more'
      const text = reader.bytes(length).toString('utf8')
      events.push({ type: 'clipboard', text })
      return 'ok'
    }
    if (type === SERVER_SET_COLOUR_MAP) {
      // 我们只请求 true colour，服务端理论上不会发；真发了就跳过
      if (!reader.need(5)) return 'need-more'
      reader.skip(3)
      const count = reader.u16()
      if (!reader.need(count * 6)) return 'need-more'
      reader.skip(count * 6)
      return 'ok'
    }

    events.push({ type: 'error', message: `未知的服务端消息类型: ${type}` })
    this.phase = 'closed'
    return 'ok'
  }

  /**
   * FramebufferUpdate：0 + padding + 矩形数 + 每个矩形。
   * 支持 Raw / CopyRect / Hextile，以及 DesktopSize / LastRect 伪编码。
   */
  private parseFramebufferUpdate(reader: RfbByteReader, events: RfbEvent[]): ParseOutcome {
    if (!reader.need(3)) return 'need-more'
    reader.skip(1)
    const rectCount = reader.u16()

    /**
     * `0xFFFF` 不是异常值，而是**"矩形数未知，以 LastRect 伪编码结束"的约定**。
     *
     * 真实服务端会这么发：本机对 tigervnc-standalone-server 1.15 实测抓到过
     * （1280x800、Hextile，首帧 `00 00 FF FF`）。手工构造的测试向量不会包含它 ——
     * 这正是必须连真实服务端才能发现的协议行为。
     *
     * 此前这里把 0xFFFF 直接当"矩形数异常"报错并关连接，
     * 结果是**握手完全成功、却一帧都收不到**，且报错信息指向"矩形数"而非根因。
     */
    const unknownRectCount = rectCount === 0xffff

    const rects: RfbRect[] = []
    /**
     * 未知个数时靠 LastRect 结束；`limit` 只是**安全阀**，避免畸形流把内存打爆。
     *
     * 注意这里**不再对"已知个数"做上限检查**：该字段是 uint16，
     * 范围天然就是 0..65535（其中 0xFFFF 已被解释为"未知"），
     * 任何 `> MAX` 的阈值都不可达 —— 写了也是死代码。
     * 上限只对"未知个数"这条路径有意义。
     */
    const limit = unknownRectCount ? MAX_RECTS_PER_UPDATE : rectCount
    let sawLastRect = false

    for (let i = 0; i < limit; i += 1) {
      if (!reader.need(12)) {
        return RfbProtocol.incomplete()
      }
      const x = reader.u16()
      const y = reader.u16()
      const width = reader.u16()
      const height = reader.u16()
      const encoding = reader.i32()

      if (encoding === PSEUDO_ENCODING_DESKTOP_SIZE) {
        if (!this.screen) {
          events.push({ type: 'error', message: '在 ServerInit 之前收到 DesktopSize' })
          this.phase = 'closed'
          return 'ok'
        }
        this.screen = { ...this.screen, width, height }
        events.push({ type: 'desktopSize', width, height })
        continue
      }
      if (encoding === PSEUDO_ENCODING_LAST_RECT) {
        // 提前结束矩形列表：这是"矩形数未知"时唯一的结束标志（TightVNC/TigerVNC 扩展）
        sawLastRect = true
        break
      }

      if (encoding === ENCODING_RAW) {
        const size = width * height * pixelSize(this.format)
        if (!reader.need(size)) return RfbProtocol.incomplete()
        rects.push({ x, y, width, height, encoding, pixels: Buffer.from(reader.bytes(size)) })
        continue
      }

      if (encoding === ENCODING_COPY_RECT) {
        if (!reader.need(4)) return RfbProtocol.incomplete()
        const srcX = reader.u16()
        const srcY = reader.u16()
        rects.push({ x, y, width, height, encoding, copyFrom: { x: srcX, y: srcY } })
        continue
      }

      if (encoding === ENCODING_HEXTILE) {
        const decoded = decodeHextile(reader, this.format, width, height)
        if (decoded === null) return RfbProtocol.incomplete()
        rects.push({ x, y, width, height, encoding, pixels: decoded })
        continue
      }

      events.push({ type: 'error', message: `不支持的编码: ${encoding}（矩形 ${x},${y} ${width}x${height}）` })
      this.phase = 'closed'
      return 'ok'
    }

    // 声明"个数未知"却始终没给 LastRect —— 此时游标停在半截流里，
    // 继续解析后续消息必然错位。宁可控告失败，也不要静默产出错乱画面。
    if (unknownRectCount && !sawLastRect) {
      events.push({
        type: 'error',
        message: `服务端声明矩形数未知（0xFFFF）但未发送 LastRect，已处理 ${limit} 个矩形后放弃`,
      })
      this.phase = 'closed'
      return 'ok'
    }

    const screen = this.screen
    events.push({
      type: 'frame',
      rects,
      framebufferWidth: screen?.width ?? 0,
      framebufferHeight: screen?.height ?? 0,
    })

    // 继续请求增量更新，否则服务端发完这一帧就停了
    this.requestFramebufferUpdate({ incremental: true })
    return 'ok'
  }

  /**
   * 报文不完整：返回 need-more 等更多字节。
   *
   * `feed()` 只在 parseOne 成功时才推进已消费偏移，因此这里**不需要**手动回滚游标；
   * 下一个 chunk 到达时会从整条 FramebufferUpdate 的开头重新解析（半截矩形不会被误当完整）。
   */
  private static incomplete(): ParseOutcome {
    return 'need-more'
  }

  // -------------------------------------------------------------- 内部

  private selectSecurityType(offered: readonly number[]): number | null {
    const preferNone = this.options.authType === 'none'
    const order = preferNone ? [SECURITY_NONE, SECURITY_VNC_AUTH] : [SECURITY_VNC_AUTH, SECURITY_NONE]
    for (const type of order) {
      if (offered.includes(type)) return type
    }
    return null
  }

  private queueClientInit(): void {
    this.outbox.push(Buffer.from([this.options.shared === false ? 0 : 1]))
  }

  private queueSetPixelFormat(format: RfbPixelFormat): void {
    const buf = Buffer.alloc(20)
    buf.writeUInt8(CLIENT_SET_PIXEL_FORMAT, 0)
    encodePixelFormat(format).copy(buf, 4)
    this.outbox.push(buf)
  }

  /**
   * SetEncodings：真实编码 + 伪编码。
   *
   * QualityLevel(-256) / CompressLevel(-247) 是**带 4 字节参数的伪编码**：
   * 在列表里就是「编码号 + 参数值」两个 4 字节。
   */
  private queueSetEncodings(): void {
    const items: Buffer[] = []
    const encodings = this.options.encodings ?? [ENCODING_COPY_RECT, ENCODING_HEXTILE, ENCODING_RAW]

    for (const encoding of encodings) {
      const buf = Buffer.alloc(4)
      buf.writeInt32BE(encoding, 0)
      items.push(buf)
    }

    const quality = clampLevel(this.options.qualityLevel)
    if (quality !== null) {
      items.push(pseudoEncoding(PSEUDO_ENCODING_QUALITY_LEVEL, quality))
    }
    const compression = clampLevel(this.options.compressionLevel)
    if (compression !== null) {
      items.push(pseudoEncoding(PSEUDO_ENCODING_COMPRESS_LEVEL, compression))
    }
    // 让服务端把「尺寸变化」与「矩形列表结束」也告诉我们
    items.push(pseudoEncoding(PSEUDO_ENCODING_DESKTOP_SIZE))
    items.push(pseudoEncoding(PSEUDO_ENCODING_LAST_RECT))

    const count = items.length
    const header = Buffer.alloc(4)
    header.writeUInt8(CLIENT_SET_ENCODINGS, 0)
    header.writeUInt16BE(count, 2)
    this.outbox.push(Buffer.concat([header, ...items]))
  }

  /** 尽力读取失败原因字符串（3.8 的失败响应会跟一段原因文本） */
  private tryReadReason(reader: RfbByteReader): string | undefined {
    if (!reader.need(4)) return undefined
    const length = reader.u32()
    if (length === 0 || length > MAX_RFB_STRING_BYTES || !reader.need(length)) return undefined
    return reader.bytes(length).toString('utf8')
  }
}

/** 伪编码：4 字节编码号（可选跟 4 字节参数） */
function pseudoEncoding(encoding: number, value?: number): Buffer {
  if (value === undefined) {
    const buf = Buffer.alloc(4)
    buf.writeInt32BE(encoding, 0)
    return buf
  }
  const buf = Buffer.alloc(8)
  buf.writeInt32BE(encoding, 0)
  buf.writeInt32BE(value, 4)
  return buf
}

function clampLevel(value: number | undefined): number | null {
  if (value === undefined || !Number.isFinite(value)) return null
  return Math.max(0, Math.min(9, Math.trunc(value)))
}

function clampU16(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(65535, Math.trunc(value)))
}

// ---------------------------------------------------------------------------
// Hextile 解码（RFC 6143 §7.7.4）
// ---------------------------------------------------------------------------

const HEXTILE_TILE = 16
const RAW_TILE = 1
const BG_SPECIFIED = 2
const FG_SPECIFIED = 4
const ANY_SUBRECTS = 8
const SUBRECTS_COLOURED = 16

/**
 * 解码 Hextile 矩形。
 *
 * 返回 null 表示「当前缓冲还不够一个完整矩形」，调用方需回滚游标等更多字节。
 * 输出是整块 `width*height*pixelSize` 的像素缓冲（渲染层不关心 tile 结构）。
 */
export function decodeHextile(
  reader: RfbByteReader,
  format: RfbPixelFormat,
  width: number,
  height: number,
): Buffer | null {
  const px = pixelSize(format)
  const out = Buffer.alloc(width * height * px)
  let background = Buffer.alloc(px)
  let foreground = Buffer.alloc(px)

  for (let tileY = 0; tileY < height; tileY += HEXTILE_TILE) {
    const tileHeight = Math.min(HEXTILE_TILE, height - tileY)
    for (let tileX = 0; tileX < width; tileX += HEXTILE_TILE) {
      const tileWidth = Math.min(HEXTILE_TILE, width - tileX)

      if (!reader.need(1)) return null
      const subencoding = reader.u8()

      if ((subencoding & RAW_TILE) !== 0) {
        const size = tileWidth * tileHeight * px
        if (!reader.need(size)) return null
        const raw = reader.bytes(size)
        for (let row = 0; row < tileHeight; row += 1) {
          raw.copy(
            out,
            ((tileY + row) * width + tileX) * px,
            row * tileWidth * px,
            (row + 1) * tileWidth * px,
          )
        }
        continue
      }

      if ((subencoding & BG_SPECIFIED) !== 0) {
        if (!reader.need(px)) return null
        background = Buffer.from(reader.bytes(px))
      }
      if ((subencoding & FG_SPECIFIED) !== 0) {
        if (!reader.need(px)) return null
        foreground = Buffer.from(reader.bytes(px))
      }

      // 先用背景色铺满 tile（未指定背景时沿用上一个 tile 的背景，符合规范）
      for (let row = 0; row < tileHeight; row += 1) {
        for (let col = 0; col < tileWidth; col += 1) {
          background.copy(out, ((tileY + row) * width + tileX + col) * px)
        }
      }

      if ((subencoding & ANY_SUBRECTS) === 0) continue

      if (!reader.need(1)) return null
      const subrectCount = reader.u8()

      for (let s = 0; s < subrectCount; s += 1) {
        let colour = foreground
        if ((subencoding & SUBRECTS_COLOURED) !== 0) {
          if (!reader.need(px)) return null
          colour = Buffer.from(reader.bytes(px))
        }
        if (!reader.need(2)) return null
        const xy = reader.u8()
        const wh = reader.u8()
        const subX = (xy >> 4) & 0x0f
        const subY = xy & 0x0f
        const subWidth = ((wh >> 4) & 0x0f) + 1
        const subHeight = (wh & 0x0f) + 1

        for (let row = 0; row < subHeight; row += 1) {
          for (let col = 0; col < subWidth; col += 1) {
            const px_x = tileX + subX + col
            const px_y = tileY + subY + row
            if (px_x >= tileX + tileWidth || px_y >= tileY + tileHeight) continue
            colour.copy(out, (px_y * width + px_x) * px)
          }
        }
      }
    }
  }
  return out
}
