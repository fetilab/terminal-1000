import { randomUUID } from "node:crypto";
import { connect } from "node:net";
import { z } from "zod";
import { A as AppError, p as parseInput, E as Events } from "../index.js";
import "electron";
import "node:path";
import "node:fs";
import "node:child_process";
import "node:url";
import "better-sqlite3";
import "node:os";
import "node:fs/promises";
import __cjs_mod__ from "node:module";
const __filename = import.meta.filename;
const __dirname = import.meta.dirname;
const require2 = __cjs_mod__.createRequire(import.meta.url);
const RFB_VERSION_3_8 = "RFB 003.008\n";
const SECURITY_TYPE_INVALID = 0;
const SECURITY_NONE = 1;
const SECURITY_VNC_AUTH = 2;
const SECURITY_RESULT_OK = 0;
const ENCODING_RAW = 0;
const ENCODING_COPY_RECT = 1;
const ENCODING_HEXTILE = 5;
const PSEUDO_ENCODING_DESKTOP_SIZE = -223;
const PSEUDO_ENCODING_LAST_RECT = -224;
const PSEUDO_ENCODING_COMPRESS_LEVEL = -247;
const PSEUDO_ENCODING_QUALITY_LEVEL = -256;
const CLIENT_SET_PIXEL_FORMAT = 0;
const CLIENT_SET_ENCODINGS = 2;
const CLIENT_FB_UPDATE_REQUEST = 3;
const CLIENT_KEY_EVENT = 4;
const CLIENT_POINTER_EVENT = 5;
const CLIENT_CUT_TEXT = 6;
const SERVER_FB_UPDATE = 0;
const SERVER_SET_COLOUR_MAP = 1;
const SERVER_BELL = 2;
const SERVER_CUT_TEXT = 3;
const MAX_RFB_STRING_BYTES = 8 * 1024 * 1024;
const MAX_RECTS_PER_UPDATE = 65535;
const PREFERRED_PIXEL_FORMAT = {
  bitsPerPixel: 32,
  depth: 24,
  bigEndian: false,
  trueColour: true,
  redMax: 255,
  greenMax: 255,
  blueMax: 255,
  redShift: 16,
  greenShift: 8,
  blueShift: 0
};
function pixelSize(format) {
  return Math.ceil(format.bitsPerPixel / 8);
}
function pixelFormatEquals(a, b) {
  return a.bitsPerPixel === b.bitsPerPixel && a.depth === b.depth && a.bigEndian === b.bigEndian && a.trueColour === b.trueColour && a.redMax === b.redMax && a.greenMax === b.greenMax && a.blueMax === b.blueMax && a.redShift === b.redShift && a.greenShift === b.greenShift && a.blueShift === b.blueShift;
}
function encodePixelFormat(format) {
  const buf = Buffer.alloc(16);
  buf.writeUInt8(format.bitsPerPixel & 255, 0);
  buf.writeUInt8(format.depth & 255, 1);
  buf.writeUInt8(format.bigEndian ? 1 : 0, 2);
  buf.writeUInt8(format.trueColour ? 1 : 0, 3);
  buf.writeUInt16BE(format.redMax & 65535, 4);
  buf.writeUInt16BE(format.greenMax & 65535, 6);
  buf.writeUInt16BE(format.blueMax & 65535, 8);
  buf.writeUInt8(format.redShift & 255, 10);
  buf.writeUInt8(format.greenShift & 255, 11);
  buf.writeUInt8(format.blueShift & 255, 12);
  return buf;
}
function decodePixelFormat(buf, offset = 0) {
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
    blueShift: buf.readUInt8(offset + 12)
  };
}
function reverseBits8(value) {
  let b = value & 255;
  b = (b & 240) >> 4 | (b & 15) << 4;
  b = (b & 204) >> 2 | (b & 51) << 2;
  b = (b & 170) >> 1 | (b & 85) << 1;
  return b & 255;
}
function vncDesKey(password) {
  const raw = Buffer.isBuffer(password) ? password : Buffer.from(password, "utf8");
  const key = Buffer.alloc(8);
  raw.copy(key, 0, 0, Math.min(8, raw.length));
  for (let i = 0; i < 8; i += 1) {
    key.writeUInt8(reverseBits8(key.readUInt8(i)), i);
  }
  return key;
}
function vncEncryptChallenge(password, challenge) {
  if (challenge.length !== 16) {
    throw new Error(`VNC challenge 必须是 16 字节，收到 ${challenge.length}`);
  }
  const key = vncDesKey(password);
  return Buffer.concat([
    desEncryptBlock(key, challenge.subarray(0, 8)),
    desEncryptBlock(key, challenge.subarray(8, 16))
  ]);
}
function desEncryptBlock(key, block) {
  return desCrypt(key, block);
}
const DES_IP = [
  58,
  50,
  42,
  34,
  26,
  18,
  10,
  2,
  60,
  52,
  44,
  36,
  28,
  20,
  12,
  4,
  62,
  54,
  46,
  38,
  30,
  22,
  14,
  6,
  64,
  56,
  48,
  40,
  32,
  24,
  16,
  8,
  57,
  49,
  41,
  33,
  25,
  17,
  9,
  1,
  59,
  51,
  43,
  35,
  27,
  19,
  11,
  3,
  61,
  53,
  45,
  37,
  29,
  21,
  13,
  5,
  63,
  55,
  47,
  39,
  31,
  23,
  15,
  7
];
const DES_FP = [
  40,
  8,
  48,
  16,
  56,
  24,
  64,
  32,
  39,
  7,
  47,
  15,
  55,
  23,
  63,
  31,
  38,
  6,
  46,
  14,
  54,
  22,
  62,
  30,
  37,
  5,
  45,
  13,
  53,
  21,
  61,
  29,
  36,
  4,
  44,
  12,
  52,
  20,
  60,
  28,
  35,
  3,
  43,
  11,
  51,
  19,
  59,
  27,
  34,
  2,
  42,
  10,
  50,
  18,
  58,
  26,
  33,
  1,
  41,
  9,
  49,
  17,
  57,
  25
];
const DES_E = [
  32,
  1,
  2,
  3,
  4,
  5,
  4,
  5,
  6,
  7,
  8,
  9,
  8,
  9,
  10,
  11,
  12,
  13,
  12,
  13,
  14,
  15,
  16,
  17,
  16,
  17,
  18,
  19,
  20,
  21,
  20,
  21,
  22,
  23,
  24,
  25,
  24,
  25,
  26,
  27,
  28,
  29,
  28,
  29,
  30,
  31,
  32,
  1
];
const DES_P = [
  16,
  7,
  20,
  21,
  29,
  12,
  28,
  17,
  1,
  15,
  23,
  26,
  5,
  18,
  31,
  10,
  2,
  8,
  24,
  14,
  32,
  27,
  3,
  9,
  19,
  13,
  30,
  6,
  22,
  11,
  4,
  25
];
const DES_PC1 = [
  57,
  49,
  41,
  33,
  25,
  17,
  9,
  1,
  58,
  50,
  42,
  34,
  26,
  18,
  10,
  2,
  59,
  51,
  43,
  35,
  27,
  19,
  11,
  3,
  60,
  52,
  44,
  36,
  63,
  55,
  47,
  39,
  31,
  23,
  15,
  7,
  62,
  54,
  46,
  38,
  30,
  22,
  14,
  6,
  61,
  53,
  45,
  37,
  29,
  21,
  13,
  5,
  28,
  20,
  12,
  4
];
const DES_PC2 = [
  14,
  17,
  11,
  24,
  1,
  5,
  3,
  28,
  15,
  6,
  21,
  10,
  23,
  19,
  12,
  4,
  26,
  8,
  16,
  7,
  27,
  20,
  13,
  2,
  41,
  52,
  31,
  37,
  47,
  55,
  30,
  40,
  51,
  45,
  33,
  48,
  44,
  49,
  39,
  56,
  34,
  53,
  46,
  42,
  50,
  36,
  29,
  32
];
const DES_SHIFTS = [1, 1, 2, 2, 2, 2, 2, 2, 1, 2, 2, 2, 2, 2, 2, 1];
const DES_SBOX = [
  [
    14,
    4,
    13,
    1,
    2,
    15,
    11,
    8,
    3,
    10,
    6,
    12,
    5,
    9,
    0,
    7,
    0,
    15,
    7,
    4,
    14,
    2,
    13,
    1,
    10,
    6,
    12,
    11,
    9,
    5,
    3,
    8,
    4,
    1,
    14,
    8,
    13,
    6,
    2,
    11,
    15,
    12,
    9,
    7,
    3,
    10,
    5,
    0,
    15,
    12,
    8,
    2,
    4,
    9,
    1,
    7,
    5,
    11,
    3,
    14,
    10,
    0,
    6,
    13
  ],
  [
    15,
    1,
    8,
    14,
    6,
    11,
    3,
    4,
    9,
    7,
    2,
    13,
    12,
    0,
    5,
    10,
    3,
    13,
    4,
    7,
    15,
    2,
    8,
    14,
    12,
    0,
    1,
    10,
    6,
    9,
    11,
    5,
    0,
    14,
    7,
    11,
    10,
    4,
    13,
    1,
    5,
    8,
    12,
    6,
    9,
    3,
    2,
    15,
    13,
    8,
    10,
    1,
    3,
    15,
    4,
    2,
    11,
    6,
    7,
    12,
    0,
    5,
    14,
    9
  ],
  [
    10,
    0,
    9,
    14,
    6,
    3,
    15,
    5,
    1,
    13,
    12,
    7,
    11,
    4,
    2,
    8,
    13,
    7,
    0,
    9,
    3,
    4,
    6,
    10,
    2,
    8,
    5,
    14,
    12,
    11,
    15,
    1,
    13,
    6,
    4,
    9,
    8,
    15,
    3,
    0,
    11,
    1,
    2,
    12,
    5,
    10,
    14,
    7,
    1,
    10,
    13,
    0,
    6,
    9,
    8,
    7,
    4,
    15,
    14,
    3,
    11,
    5,
    2,
    12
  ],
  [
    7,
    13,
    14,
    3,
    0,
    6,
    9,
    10,
    1,
    2,
    8,
    5,
    11,
    12,
    4,
    15,
    13,
    8,
    11,
    5,
    6,
    15,
    0,
    3,
    4,
    7,
    2,
    12,
    1,
    10,
    14,
    9,
    10,
    6,
    9,
    0,
    12,
    11,
    7,
    13,
    15,
    1,
    3,
    14,
    5,
    2,
    8,
    4,
    3,
    15,
    0,
    6,
    10,
    1,
    13,
    8,
    9,
    4,
    5,
    11,
    12,
    7,
    2,
    14
  ],
  [
    2,
    12,
    4,
    1,
    7,
    10,
    11,
    6,
    8,
    5,
    3,
    15,
    13,
    0,
    14,
    9,
    14,
    11,
    2,
    12,
    4,
    7,
    13,
    1,
    5,
    0,
    15,
    10,
    3,
    9,
    8,
    6,
    4,
    2,
    1,
    11,
    10,
    13,
    7,
    8,
    15,
    9,
    12,
    5,
    6,
    3,
    0,
    14,
    11,
    8,
    12,
    7,
    1,
    14,
    2,
    13,
    6,
    15,
    0,
    9,
    10,
    4,
    5,
    3
  ],
  [
    12,
    1,
    10,
    15,
    9,
    2,
    6,
    8,
    0,
    13,
    3,
    4,
    14,
    7,
    5,
    11,
    10,
    15,
    4,
    2,
    7,
    12,
    9,
    5,
    6,
    1,
    13,
    14,
    0,
    11,
    3,
    8,
    9,
    14,
    15,
    5,
    2,
    8,
    12,
    3,
    7,
    0,
    4,
    10,
    1,
    13,
    11,
    6,
    4,
    3,
    2,
    12,
    9,
    5,
    15,
    10,
    11,
    14,
    1,
    7,
    6,
    0,
    8,
    13
  ],
  [
    4,
    11,
    2,
    14,
    15,
    0,
    8,
    13,
    3,
    12,
    9,
    7,
    5,
    10,
    6,
    1,
    13,
    0,
    11,
    7,
    4,
    9,
    1,
    10,
    14,
    3,
    5,
    12,
    2,
    15,
    8,
    6,
    1,
    4,
    11,
    13,
    12,
    3,
    7,
    14,
    10,
    15,
    6,
    8,
    0,
    5,
    9,
    2,
    6,
    11,
    13,
    8,
    1,
    4,
    10,
    7,
    9,
    5,
    0,
    15,
    14,
    2,
    3,
    12
  ],
  [
    13,
    2,
    8,
    4,
    6,
    15,
    11,
    1,
    10,
    9,
    3,
    14,
    5,
    0,
    12,
    7,
    1,
    15,
    13,
    8,
    10,
    3,
    7,
    4,
    12,
    5,
    6,
    11,
    0,
    14,
    9,
    2,
    7,
    11,
    4,
    1,
    9,
    12,
    14,
    2,
    0,
    6,
    10,
    13,
    15,
    3,
    5,
    8,
    2,
    1,
    14,
    7,
    4,
    10,
    8,
    13,
    15,
    12,
    9,
    0,
    3,
    5,
    6,
    11
  ]
];
function desPermute(input, table, inputBits) {
  let out = 0n;
  for (const pos of table) {
    out = out << 1n | input >> BigInt(inputBits - pos) & 1n;
  }
  return out;
}
function desSubkeys(key) {
  const permuted = desPermute(key, DES_PC1, 64);
  let c = permuted >> 28n;
  let d = permuted & 0x0fffffffn;
  const subkeys = [];
  for (let round = 0; round < 16; round += 1) {
    const shift = BigInt(DES_SHIFTS[round]);
    c = (c << shift | c >> 28n - shift) & 0x0fffffffn;
    d = (d << shift | d >> 28n - shift) & 0x0fffffffn;
    subkeys.push(desPermute(c << 28n | d, DES_PC2, 56));
  }
  return subkeys;
}
function desFeistel(half, subkey) {
  const expanded = desPermute(half, DES_E, 32) ^ subkey;
  let substituted = 0n;
  for (let box = 0; box < 8; box += 1) {
    const chunk = Number(expanded >> BigInt(42 - 6 * box) & 0x3fn);
    const row = (chunk & 32) >> 4 | chunk & 1;
    const col = chunk >> 1 & 15;
    const value = DES_SBOX[box]?.[row * 16 + col];
    substituted = substituted << 4n | BigInt(value ?? 0);
  }
  return desPermute(substituted, DES_P, 32);
}
function desCrypt(key, block, decrypt) {
  if (key.length !== 8) throw new Error(`DES 密钥必须是 8 字节，收到 ${key.length}`);
  if (block.length !== 8) throw new Error(`DES 数据块必须是 8 字节，收到 ${block.length}`);
  const subkeys = desSubkeys(BigInt(`0x${key.toString("hex")}`));
  const input = BigInt(`0x${block.toString("hex")}`);
  const permuted = desPermute(input, DES_IP, 64);
  let left = permuted >> 32n;
  let right = permuted & 0xffffffffn;
  for (let round = 0; round < 16; round += 1) {
    const subkey = subkeys[round];
    const f = desFeistel(right, subkey);
    const nextLeft = right;
    const nextRight = left ^ f;
    left = nextLeft;
    right = nextRight;
  }
  const preoutput = right << 32n | left;
  const out = desPermute(preoutput, DES_FP, 64);
  const hex = out.toString(16).padStart(16, "0");
  return Buffer.from(hex, "hex");
}
class RfbByteReader {
  constructor(buf, offset = 0) {
    this.buf = buf;
    this.offset = offset;
  }
  get remaining() {
    return this.buf.length - this.offset;
  }
  need(bytes) {
    return this.remaining >= bytes;
  }
  u8() {
    const value = this.buf.readUInt8(this.offset);
    this.offset += 1;
    return value;
  }
  u16() {
    const value = this.buf.readUInt16BE(this.offset);
    this.offset += 2;
    return value;
  }
  i32() {
    const value = this.buf.readInt32BE(this.offset);
    this.offset += 4;
    return value;
  }
  u32() {
    const value = this.buf.readUInt32BE(this.offset);
    this.offset += 4;
    return value;
  }
  bytes(length) {
    const out = this.buf.subarray(this.offset, this.offset + length);
    this.offset += length;
    return out;
  }
  skip(length) {
    this.offset += length;
  }
}
class RfbProtocol {
  constructor(options = {}) {
    this.options = options;
    this.buffer = Buffer.alloc(0);
    this.phase = "version";
    this.outbox = [];
    this.serverVersion = "";
    this.negotiatedMinor = 8;
    this.securityType = 0;
    this.screen = null;
    this.format = PREFERRED_PIXEL_FORMAT;
  }
  get currentPhase() {
    return this.phase;
  }
  get screenInfo() {
    return this.screen;
  }
  /** 当前生效的像素格式（ServerInit 之后就是服务端给的那个） */
  get pixelFormat() {
    return this.format;
  }
  /** 取走待发送字节（交给 socket 写） */
  drainOutbox() {
    if (this.outbox.length === 0) return Buffer.alloc(0);
    const merged = Buffer.concat(this.outbox);
    this.outbox.length = 0;
    return merged;
  }
  /**
   * 喂入服务端字节流，返回本次能解析出的完整事件。
   * 半截报文会留在内部缓冲里等下一个 chunk（不会误解析）。
   */
  feed(chunk) {
    if (chunk.length > 0) {
      this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    }
    const events = [];
    let consumed = 0;
    while (this.phase !== "closed") {
      const reader = new RfbByteReader(this.buffer, consumed);
      const outcome = this.parseOne(reader, events);
      if (outcome === "need-more") break;
      if (reader.offset <= consumed) break;
      consumed = reader.offset;
    }
    if (consumed > 0) this.buffer = this.buffer.subarray(consumed);
    return events;
  }
  // -------------------------------------------------------------- 客户端消息
  /** 请求帧缓冲更新（incremental=true 时只要变化区域） */
  /** 当前阶段（诊断用：握手卡住时能一眼看出停在哪一步） */
  phaseName() {
    return this.phase;
  }
  requestFramebufferUpdate(options = {}) {
    const screen = this.screen;
    const width = screen?.width ?? 0;
    const height = screen?.height ?? 0;
    const buf = Buffer.alloc(10);
    buf.writeUInt8(CLIENT_FB_UPDATE_REQUEST, 0);
    buf.writeUInt8(options.incremental === true ? 1 : 0, 1);
    buf.writeUInt16BE(0, 2);
    buf.writeUInt16BE(0, 4);
    buf.writeUInt16BE(width, 6);
    buf.writeUInt16BE(height, 8);
    this.outbox.push(buf);
  }
  /** 鼠标事件：buttonMask 位 0..7 = 左/中/右/滚上/滚下/…，坐标是远端像素坐标 */
  sendPointer(buttonMask, x, y) {
    const buf = Buffer.alloc(6);
    buf.writeUInt8(CLIENT_POINTER_EVENT, 0);
    buf.writeUInt8(buttonMask & 255, 1);
    buf.writeUInt16BE(clampU16(x), 2);
    buf.writeUInt16BE(clampU16(y), 4);
    this.outbox.push(buf);
  }
  /** 键盘事件：key 是 X11 keysym */
  sendKey(down, key) {
    const buf = Buffer.alloc(8);
    buf.writeUInt8(CLIENT_KEY_EVENT, 0);
    buf.writeUInt8(down ? 1 : 0, 1);
    buf.writeUInt8(0, 2);
    buf.writeUInt8(0, 3);
    buf.writeUInt32BE(key >>> 0, 4);
    this.outbox.push(buf);
  }
  /** 把本地剪贴板文本发给服务端（Latin-1 语义，按 UTF-8 发送是常见做法） */
  sendClientCutText(text) {
    const payload = Buffer.from(text, "utf8");
    const buf = Buffer.alloc(8 + payload.length);
    buf.writeUInt8(CLIENT_CUT_TEXT, 0);
    buf.writeUInt32BE(payload.length, 4);
    payload.copy(buf, 8);
    this.outbox.push(buf);
  }
  // -------------------------------------------------------------- 解析
  parseOne(reader, events) {
    switch (this.phase) {
      case "version":
        return this.parseVersion(reader, events);
      case "security":
        return this.parseSecurityList(reader, events);
      case "security33":
        return this.parseSecurity33(reader, events);
      case "challenge":
        return this.parseChallenge(reader, events);
      case "securityResult":
        return this.parseSecurityResult(reader, events);
      case "serverInit":
        return this.parseServerInit(reader, events);
      case "ready":
        return this.parseServerMessage(reader, events);
      case "closed":
        return "need-more";
    }
  }
  parseVersion(reader, events) {
    if (!reader.need(12)) return "need-more";
    const text = reader.bytes(12).toString("latin1");
    const match = /^RFB (\d{3})\.(\d{3})\n$/.exec(text);
    if (!match) {
      events.push({ type: "error", message: `无法识别的 RFB 版本串: ${JSON.stringify(text)}` });
      this.phase = "closed";
      return "ok";
    }
    this.serverVersion = text;
    const minor = Number(match[2]);
    this.negotiatedMinor = Math.min(minor, 8);
    const clientVersion = minor >= 8 ? RFB_VERSION_3_8 : `RFB 003.${match[2]}
`;
    this.outbox.push(Buffer.from(clientVersion, "latin1"));
    events.push({ type: "version", serverVersion: text, clientVersion });
    this.phase = minor >= 7 ? "security" : "security33";
    return "ok";
  }
  parseSecurityList(reader, events) {
    if (!reader.need(1)) return "need-more";
    const count = reader.u8();
    if (count === 0) {
      const reason = this.tryReadReason(reader);
      events.push({
        type: "error",
        message: `服务端拒绝了连接${reason === void 0 ? "" : `：${reason}`}`
      });
      this.phase = "closed";
      return "ok";
    }
    if (!reader.need(count)) return "need-more";
    const offered = [];
    for (let i = 0; i < count; i += 1) offered.push(reader.u8());
    const wanted = this.selectSecurityType(offered);
    if (wanted === null) {
      events.push({
        type: "error",
        message: `服务端不支持可用的安全类型（提供 ${offered.join(",")}，本端配置 ${this.options.authType ?? "none"}）`
      });
      this.phase = "closed";
      return "ok";
    }
    if (wanted === SECURITY_VNC_AUTH && !this.options.password) {
      events.push({ type: "error", message: "服务端要求 VNC 口令认证，但未配置口令" });
      this.phase = "closed";
      return "ok";
    }
    this.securityType = wanted;
    this.outbox.push(Buffer.from([wanted]));
    events.push({ type: "security", securityType: wanted, fromList: true });
    if (wanted === SECURITY_VNC_AUTH) {
      this.phase = "challenge";
    } else if (this.negotiatedMinor >= 8) {
      this.phase = "securityResult";
    } else {
      this.queueClientInit();
      this.phase = "serverInit";
    }
    return "ok";
  }
  /** 兼容 3.3：直接一个 4 字节安全类型 */
  parseSecurity33(reader, events) {
    if (!reader.need(4)) return "need-more";
    const type = reader.u32();
    if (type === SECURITY_TYPE_INVALID) {
      events.push({ type: "error", message: "服务端拒绝了连接（安全类型无效）" });
      this.phase = "closed";
      return "ok";
    }
    this.securityType = type;
    events.push({ type: "security", securityType: type, fromList: false });
    if (type === SECURITY_VNC_AUTH) {
      if (!this.options.password) {
        events.push({ type: "error", message: "服务端要求 VNC 口令认证，但未配置口令" });
        this.phase = "closed";
        return "ok";
      }
      this.phase = "challenge";
      return "ok";
    }
    if (type === SECURITY_NONE) {
      this.queueClientInit();
      this.phase = "serverInit";
      return "ok";
    }
    events.push({ type: "error", message: `不支持的安全类型: ${type}` });
    this.phase = "closed";
    return "ok";
  }
  parseChallenge(reader, events) {
    if (!reader.need(16)) return "need-more";
    const challenge = Buffer.from(reader.bytes(16));
    const password = this.options.password ?? "";
    this.outbox.push(vncEncryptChallenge(password, challenge));
    this.phase = "securityResult";
    return "ok";
  }
  parseSecurityResult(reader, events) {
    if (!reader.need(4)) return "need-more";
    const result = reader.u32();
    const ok = result === SECURITY_RESULT_OK;
    const reason = ok ? void 0 : this.tryReadReason(reader);
    events.push({
      type: "securityResult",
      ok,
      ...reason === void 0 ? {} : { reason }
    });
    if (!ok) {
      events.push({
        type: "error",
        message: `VNC 认证失败${reason === void 0 ? "" : `：${reason}`}（口令错误，或口令位序实现有误）`
      });
      this.phase = "closed";
      return "ok";
    }
    this.queueClientInit();
    this.phase = "serverInit";
    return "ok";
  }
  parseServerInit(reader, events) {
    if (!reader.need(24)) return "need-more";
    const width = reader.u16();
    const height = reader.u16();
    const pixelFormat = decodePixelFormat(reader.bytes(16));
    const nameLength = reader.u32();
    if (nameLength > MAX_RFB_STRING_BYTES) {
      events.push({ type: "error", message: `桌面名长度异常: ${nameLength}` });
      this.phase = "closed";
      return "ok";
    }
    if (!reader.need(nameLength)) return "need-more";
    const name = reader.bytes(nameLength).toString("utf8");
    this.format = pixelFormat;
    this.screen = { width, height, name, pixelFormat };
    events.push({ type: "serverInit", screen: this.screen });
    if (!pixelFormatEquals(pixelFormat, PREFERRED_PIXEL_FORMAT) || !pixelFormat.trueColour) {
      this.queueSetPixelFormat(PREFERRED_PIXEL_FORMAT);
      this.format = PREFERRED_PIXEL_FORMAT;
    }
    this.queueSetEncodings();
    this.requestFramebufferUpdate({ incremental: false });
    this.phase = "ready";
    return "ok";
  }
  parseServerMessage(reader, events) {
    if (!reader.need(1)) return "need-more";
    const type = reader.u8();
    if (type === SERVER_FB_UPDATE) {
      return this.parseFramebufferUpdate(reader, events);
    }
    if (type === SERVER_BELL) {
      events.push({ type: "bell" });
      return "ok";
    }
    if (type === SERVER_CUT_TEXT) {
      if (!reader.need(7)) return "need-more";
      reader.skip(3);
      const length = reader.u32();
      if (length > MAX_RFB_STRING_BYTES) {
        events.push({ type: "error", message: `剪贴板长度异常: ${length}` });
        this.phase = "closed";
        return "ok";
      }
      if (!reader.need(length)) return "need-more";
      const text = reader.bytes(length).toString("utf8");
      events.push({ type: "clipboard", text });
      return "ok";
    }
    if (type === SERVER_SET_COLOUR_MAP) {
      if (!reader.need(5)) return "need-more";
      reader.skip(3);
      const count = reader.u16();
      if (!reader.need(count * 6)) return "need-more";
      reader.skip(count * 6);
      return "ok";
    }
    events.push({ type: "error", message: `未知的服务端消息类型: ${type}` });
    this.phase = "closed";
    return "ok";
  }
  /**
   * FramebufferUpdate：0 + padding + 矩形数 + 每个矩形。
   * 支持 Raw / CopyRect / Hextile，以及 DesktopSize / LastRect 伪编码。
   */
  parseFramebufferUpdate(reader, events) {
    if (!reader.need(3)) return "need-more";
    reader.skip(1);
    const rectCount = reader.u16();
    const unknownRectCount = rectCount === 65535;
    const rects = [];
    const limit = unknownRectCount ? MAX_RECTS_PER_UPDATE : rectCount;
    let sawLastRect = false;
    for (let i = 0; i < limit; i += 1) {
      if (!reader.need(12)) {
        return RfbProtocol.incomplete();
      }
      const x = reader.u16();
      const y = reader.u16();
      const width = reader.u16();
      const height = reader.u16();
      const encoding = reader.i32();
      if (encoding === PSEUDO_ENCODING_DESKTOP_SIZE) {
        if (!this.screen) {
          events.push({ type: "error", message: "在 ServerInit 之前收到 DesktopSize" });
          this.phase = "closed";
          return "ok";
        }
        this.screen = { ...this.screen, width, height };
        events.push({ type: "desktopSize", width, height });
        continue;
      }
      if (encoding === PSEUDO_ENCODING_LAST_RECT) {
        sawLastRect = true;
        break;
      }
      if (encoding === ENCODING_RAW) {
        const size = width * height * pixelSize(this.format);
        if (!reader.need(size)) return RfbProtocol.incomplete();
        rects.push({ x, y, width, height, encoding, pixels: Buffer.from(reader.bytes(size)) });
        continue;
      }
      if (encoding === ENCODING_COPY_RECT) {
        if (!reader.need(4)) return RfbProtocol.incomplete();
        const srcX = reader.u16();
        const srcY = reader.u16();
        rects.push({ x, y, width, height, encoding, copyFrom: { x: srcX, y: srcY } });
        continue;
      }
      if (encoding === ENCODING_HEXTILE) {
        const decoded = decodeHextile(reader, this.format, width, height);
        if (decoded === null) return RfbProtocol.incomplete();
        rects.push({ x, y, width, height, encoding, pixels: decoded });
        continue;
      }
      events.push({ type: "error", message: `不支持的编码: ${encoding}（矩形 ${x},${y} ${width}x${height}）` });
      this.phase = "closed";
      return "ok";
    }
    if (unknownRectCount && !sawLastRect) {
      events.push({
        type: "error",
        message: `服务端声明矩形数未知（0xFFFF）但未发送 LastRect，已处理 ${limit} 个矩形后放弃`
      });
      this.phase = "closed";
      return "ok";
    }
    const screen = this.screen;
    events.push({
      type: "frame",
      rects,
      framebufferWidth: screen?.width ?? 0,
      framebufferHeight: screen?.height ?? 0
    });
    this.requestFramebufferUpdate({ incremental: true });
    return "ok";
  }
  /**
   * 报文不完整：返回 need-more 等更多字节。
   *
   * `feed()` 只在 parseOne 成功时才推进已消费偏移，因此这里**不需要**手动回滚游标；
   * 下一个 chunk 到达时会从整条 FramebufferUpdate 的开头重新解析（半截矩形不会被误当完整）。
   */
  static incomplete() {
    return "need-more";
  }
  // -------------------------------------------------------------- 内部
  selectSecurityType(offered) {
    const preferNone = this.options.authType === "none";
    const order = preferNone ? [SECURITY_NONE, SECURITY_VNC_AUTH] : [SECURITY_VNC_AUTH, SECURITY_NONE];
    for (const type of order) {
      if (offered.includes(type)) return type;
    }
    return null;
  }
  queueClientInit() {
    this.outbox.push(Buffer.from([this.options.shared === false ? 0 : 1]));
  }
  queueSetPixelFormat(format) {
    const buf = Buffer.alloc(20);
    buf.writeUInt8(CLIENT_SET_PIXEL_FORMAT, 0);
    encodePixelFormat(format).copy(buf, 4);
    this.outbox.push(buf);
  }
  /**
   * SetEncodings：真实编码 + 伪编码。
   *
   * QualityLevel(-256) / CompressLevel(-247) 是**带 4 字节参数的伪编码**：
   * 在列表里就是「编码号 + 参数值」两个 4 字节。
   */
  queueSetEncodings() {
    const items = [];
    const encodings = this.options.encodings ?? [ENCODING_COPY_RECT, ENCODING_HEXTILE, ENCODING_RAW];
    for (const encoding of encodings) {
      const buf = Buffer.alloc(4);
      buf.writeInt32BE(encoding, 0);
      items.push(buf);
    }
    const quality = clampLevel(this.options.qualityLevel);
    if (quality !== null) {
      items.push(pseudoEncoding(PSEUDO_ENCODING_QUALITY_LEVEL, quality));
    }
    const compression = clampLevel(this.options.compressionLevel);
    if (compression !== null) {
      items.push(pseudoEncoding(PSEUDO_ENCODING_COMPRESS_LEVEL, compression));
    }
    items.push(pseudoEncoding(PSEUDO_ENCODING_DESKTOP_SIZE));
    items.push(pseudoEncoding(PSEUDO_ENCODING_LAST_RECT));
    const count = items.length;
    const header = Buffer.alloc(4);
    header.writeUInt8(CLIENT_SET_ENCODINGS, 0);
    header.writeUInt16BE(count, 2);
    this.outbox.push(Buffer.concat([header, ...items]));
  }
  /** 尽力读取失败原因字符串（3.8 的失败响应会跟一段原因文本） */
  tryReadReason(reader) {
    if (!reader.need(4)) return void 0;
    const length = reader.u32();
    if (length === 0 || length > MAX_RFB_STRING_BYTES || !reader.need(length)) return void 0;
    return reader.bytes(length).toString("utf8");
  }
}
function pseudoEncoding(encoding, value) {
  if (value === void 0) {
    const buf2 = Buffer.alloc(4);
    buf2.writeInt32BE(encoding, 0);
    return buf2;
  }
  const buf = Buffer.alloc(8);
  buf.writeInt32BE(encoding, 0);
  buf.writeInt32BE(value, 4);
  return buf;
}
function clampLevel(value) {
  if (value === void 0 || !Number.isFinite(value)) return null;
  return Math.max(0, Math.min(9, Math.trunc(value)));
}
function clampU16(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(65535, Math.trunc(value)));
}
const HEXTILE_TILE = 16;
const RAW_TILE = 1;
const BG_SPECIFIED = 2;
const FG_SPECIFIED = 4;
const ANY_SUBRECTS = 8;
const SUBRECTS_COLOURED = 16;
function decodeHextile(reader, format, width, height) {
  const px = pixelSize(format);
  const out = Buffer.alloc(width * height * px);
  let background = Buffer.alloc(px);
  let foreground = Buffer.alloc(px);
  for (let tileY = 0; tileY < height; tileY += HEXTILE_TILE) {
    const tileHeight = Math.min(HEXTILE_TILE, height - tileY);
    for (let tileX = 0; tileX < width; tileX += HEXTILE_TILE) {
      const tileWidth = Math.min(HEXTILE_TILE, width - tileX);
      if (!reader.need(1)) return null;
      const subencoding = reader.u8();
      if ((subencoding & RAW_TILE) !== 0) {
        const size = tileWidth * tileHeight * px;
        if (!reader.need(size)) return null;
        const raw = reader.bytes(size);
        for (let row = 0; row < tileHeight; row += 1) {
          raw.copy(
            out,
            ((tileY + row) * width + tileX) * px,
            row * tileWidth * px,
            (row + 1) * tileWidth * px
          );
        }
        continue;
      }
      if ((subencoding & BG_SPECIFIED) !== 0) {
        if (!reader.need(px)) return null;
        background = Buffer.from(reader.bytes(px));
      }
      if ((subencoding & FG_SPECIFIED) !== 0) {
        if (!reader.need(px)) return null;
        foreground = Buffer.from(reader.bytes(px));
      }
      for (let row = 0; row < tileHeight; row += 1) {
        for (let col = 0; col < tileWidth; col += 1) {
          background.copy(out, ((tileY + row) * width + tileX + col) * px);
        }
      }
      if ((subencoding & ANY_SUBRECTS) === 0) continue;
      if (!reader.need(1)) return null;
      const subrectCount = reader.u8();
      for (let s = 0; s < subrectCount; s += 1) {
        let colour = foreground;
        if ((subencoding & SUBRECTS_COLOURED) !== 0) {
          if (!reader.need(px)) return null;
          colour = Buffer.from(reader.bytes(px));
        }
        if (!reader.need(2)) return null;
        const xy = reader.u8();
        const wh = reader.u8();
        const subX = xy >> 4 & 15;
        const subY = xy & 15;
        const subWidth = (wh >> 4 & 15) + 1;
        const subHeight = (wh & 15) + 1;
        for (let row = 0; row < subHeight; row += 1) {
          for (let col = 0; col < subWidth; col += 1) {
            const px_x = tileX + subX + col;
            const px_y = tileY + subY + row;
            if (px_x >= tileX + tileWidth || px_y >= tileY + tileHeight) continue;
            colour.copy(out, (px_y * width + px_x) * px);
          }
        }
      }
    }
  }
  return out;
}
const systemVncTimer = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle)
};
const VNC_HANDSHAKE_TIMEOUT_MS = 15e3;
class VncManager {
  constructor(options) {
    this.sessions = /* @__PURE__ */ new Map();
    this.sink = options.sink;
    this.createSocket = options.createSocket ?? (({ host, port }) => connect({ host, port }));
    this.timer = options.timer ?? systemVncTimer;
    this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? VNC_HANDSHAKE_TIMEOUT_MS;
  }
  list() {
    return [...this.sessions.values()].map((s) => ({
      sessionId: s.sessionId,
      state: s.state,
      host: s.connection.host,
      port: s.connection.port
    }));
  }
  /** 建立连接并开始 RFB 握手；立即返回 sessionId（画面/尺寸随后由事件推送） */
  connect(connection) {
    const sessionId = randomUUID();
    const protocol = new RfbProtocol({
      authType: connection.authType === "vnc-password" ? "vnc-password" : "none",
      ...connection.password === void 0 ? {} : { password: connection.password },
      shared: connection.shared !== false,
      ...connection.qualityLevel === void 0 ? {} : { qualityLevel: connection.qualityLevel },
      ...connection.compressionLevel === void 0 ? {} : { compressionLevel: connection.compressionLevel }
    });
    const socket = this.createSocket({ host: connection.host, port: connection.port });
    const session = {
      sessionId,
      connection,
      socket,
      protocol,
      state: "connecting",
      closed: false,
      handshakeTimer: null
    };
    this.sessions.set(sessionId, session);
    this.setState(session, "connecting");
    session.handshakeTimer = this.timer.setTimeout(() => {
      if (session.state === "ready" || session.closed) return;
      this.fail(session, `RFB 握手超时（${this.handshakeTimeoutMs}ms）`);
    }, this.handshakeTimeoutMs);
    socket.on("connect", () => {
      this.setState(session, "connecting");
    });
    socket.on("data", (chunk) => this.onData(session, chunk));
    socket.on("error", (err) => this.fail(session, err.message));
    socket.on("close", () => this.onClose(session));
    return { sessionId, viewOnly: connection.viewOnly === true };
  }
  disconnect(sessionId) {
    const session = this.require(sessionId);
    this.cleanup(session);
    this.setState(session, "disconnected");
    return true;
  }
  /** 鼠标事件；viewOnly 时忽略 */
  sendPointer(sessionId, buttonMask, x, y) {
    const session = this.require(sessionId);
    if (session.connection.viewOnly === true) return { sent: false, ignored: "viewOnly" };
    if (session.state !== "ready") return { sent: false, ignored: `会话未就绪（${session.state}）` };
    session.protocol.sendPointer(buttonMask, x, y);
    this.flush(session);
    return { sent: true };
  }
  /** 键盘事件；viewOnly 时忽略 */
  sendKey(sessionId, down, keysym) {
    const session = this.require(sessionId);
    if (session.connection.viewOnly === true) return { sent: false, ignored: "viewOnly" };
    if (session.state !== "ready") return { sent: false, ignored: `会话未就绪（${session.state}）` };
    session.protocol.sendKey(down, keysym);
    this.flush(session);
    return { sent: true };
  }
  /** 把本地剪贴板发给远端（UI 主动调用；不在 Actions.vnc 里，先作为能力暴露） */
  sendClipboard(sessionId, text) {
    const session = this.require(sessionId);
    if (session.connection.viewOnly === true) return { sent: false };
    session.protocol.sendClientCutText(text);
    this.flush(session);
    return { sent: true };
  }
  shutdown() {
    for (const session of this.sessions.values()) {
      this.cleanup(session);
      session.state = "disconnected";
    }
    this.sessions.clear();
  }
  // -------------------------------------------------------------- 内部
  require(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) throw AppError.notFound(`VNC 会话不存在或已断开: ${sessionId}`);
    return session;
  }
  setState(session, state, message) {
    session.state = state;
    if (message === void 0) this.sink.state(session.sessionId, state);
    else this.sink.state(session.sessionId, state, message);
  }
  onData(session, chunk) {
    if (session.closed) return;
    let events;
    try {
      events = session.protocol.feed(chunk);
    } catch (err) {
      this.fail(session, err instanceof Error ? err.message : String(err));
      return;
    }
    for (const event of events) this.dispatch(session, event);
    this.flush(session);
  }
  dispatch(session, event) {
    switch (event.type) {
      case "version":
        break;
      case "security":
        this.setState(session, "authenticating");
        break;
      case "securityResult":
        if (!event.ok) {
          this.fail(
            session,
            `VNC 认证失败${event.reason === void 0 ? "" : `：${event.reason}`}`
          );
        }
        break;
      case "serverInit":
        this.clearHandshakeTimer(session);
        this.setState(session, "ready");
        break;
      case "desktopSize":
        break;
      case "frame":
        this.sink.frame(session.sessionId, {
          framebufferWidth: event.framebufferWidth,
          framebufferHeight: event.framebufferHeight,
          rects: event.rects.map(
            (rect) => rect.pixels === void 0 ? {
              x: rect.x,
              y: rect.y,
              width: rect.width,
              height: rect.height,
              ...rect.copyFrom === void 0 ? {} : { copyFrom: rect.copyFrom }
            } : {
              x: rect.x,
              y: rect.y,
              width: rect.width,
              height: rect.height,
              pixels: rect.pixels.toString("base64")
            }
          )
        });
        break;
      case "bell":
        this.sink.bell(session.sessionId);
        break;
      case "clipboard":
        this.sink.clipboard(session.sessionId, event.text);
        break;
      case "error":
        this.fail(session, event.message);
        break;
    }
  }
  flush(session) {
    const out = session.protocol.drainOutbox();
    if (out.length === 0 || session.closed) return;
    try {
      session.socket.write(out);
    } catch (err) {
      this.fail(session, err instanceof Error ? err.message : String(err));
    }
  }
  fail(session, message) {
    if (session.closed) return;
    this.sink.error(session.sessionId, message);
    this.cleanup(session);
    this.setState(session, "failed", message);
  }
  onClose(session) {
    if (session.closed) return;
    this.clearHandshakeTimer(session);
    session.closed = true;
    if (session.state !== "failed") this.setState(session, "disconnected");
    this.sessions.delete(session.sessionId);
  }
  cleanup(session) {
    this.clearHandshakeTimer(session);
    if (session.closed) return;
    session.closed = true;
    try {
      session.socket.end();
      session.socket.destroy();
    } catch {
    }
    this.sessions.delete(session.sessionId);
  }
  clearHandshakeTimer(session) {
    if (session.handshakeTimer === null) return;
    this.timer.clearTimeout(session.handshakeTimer);
    session.handshakeTimer = null;
  }
}
const vncConnectionSchema = z.object({
  kind: z.literal("vnc"),
  id: z.string().min(1),
  name: z.string(),
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  authType: z.enum(["vnc-password", "none"]).optional(),
  password: z.string().optional(),
  viewOnly: z.boolean().optional(),
  shared: z.boolean().optional(),
  scaleViewport: z.boolean().optional(),
  clipViewport: z.boolean().optional(),
  qualityLevel: z.number().int().min(0).max(9).optional(),
  compressionLevel: z.number().int().min(0).max(9).optional(),
  createdAt: z.string(),
  updatedAt: z.string()
}).passthrough();
const connectSchema = z.object({ connection: vncConnectionSchema });
const sessionSchema = z.object({ sessionId: z.string().min(1) });
const pointerSchema = z.object({
  sessionId: z.string().min(1),
  buttonMask: z.number().int().min(0).max(255),
  x: z.number().int(),
  y: z.number().int()
});
const keySchema = z.object({
  sessionId: z.string().min(1),
  down: z.boolean(),
  /** X11 keysym */
  keysym: z.number().int().min(0)
});
function sinkFromContext(getCtx) {
  return {
    state: (sessionId, state, message) => {
      const ctx = getCtx();
      if (!ctx) return;
      ctx.emit(
        Events.VNC_STATE,
        message === void 0 ? { sessionId, state } : { sessionId, state, message }
      );
    },
    frame: (sessionId, frame) => {
      getCtx()?.emit(Events.VNC_FRAME, { sessionId, ...frame });
    },
    clipboard: (sessionId, text) => {
      getCtx()?.emit(Events.VNC_CLIPBOARD, { sessionId, text });
    },
    bell: (sessionId) => {
      getCtx()?.emit(Events.VNC_BELL, { sessionId });
    },
    error: (sessionId, message) => {
      getCtx()?.emit(Events.VNC_ERROR, { sessionId, message });
    }
  };
}
let manager = null;
let activeCtx = null;
function shutdownVnc() {
  manager?.shutdown();
  manager = null;
}
function setVncManagerForTests(next) {
  manager = next;
}
function getManager(ctx) {
  activeCtx = ctx;
  manager ??= new VncManager({ sink: sinkFromContext(() => activeCtx) });
  return manager;
}
const vncHandlers = {
  connect: (payload, ctx) => {
    const { connection } = parseInput(connectSchema, payload);
    const result = getManager(ctx).connect(connection);
    return {
      ...result,
      scaleViewport: connection.scaleViewport === true,
      clipViewport: connection.clipViewport === true
    };
  },
  disconnect: (payload, ctx) => {
    const { sessionId } = parseInput(sessionSchema, payload);
    return { sessionId, disconnected: getManager(ctx).disconnect(sessionId) };
  },
  sendPointer: (payload, ctx) => {
    const { sessionId, buttonMask, x, y } = parseInput(pointerSchema, payload);
    return getManager(ctx).sendPointer(sessionId, buttonMask, x, y);
  },
  sendKey: (payload, ctx) => {
    const { sessionId, down, keysym } = parseInput(keySchema, payload);
    return getManager(ctx).sendKey(sessionId, down, keysym);
  }
};
export {
  VNC_HANDSHAKE_TIMEOUT_MS,
  VncManager,
  setVncManagerForTests,
  shutdownVnc,
  systemVncTimer,
  vncHandlers
};
