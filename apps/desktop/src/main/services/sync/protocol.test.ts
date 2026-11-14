// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * TSC/1 协议核测试。
 *
 * 两类用例，第二类才是重点：
 * 1. **对照冻结向量**（`docs/fixtures/tsc1-vectors.json`）—— 服务端是另一份独立实现，
 *    这份向量是两侧唯一的互操作保证。**首帧密文逐字节一致**是硬指标
 * 2. **负例**：篡改 / 重放 / 乱序 / 降级 / 低阶点 / 超长帧。
 *    对加密协议来说，**"该拒的有没有拒"比"该通的能不能通"更重要** ——
 *    一个全部接受的实现，正向用例会全绿。
 */

import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createPrivateKey, createPublicKey } from 'node:crypto'
import {
  HELLO_LEN,
  MAX_FRAME_BYTES,
  SERVER_HELLO_LEN,
  SERVER_HELLO_PREFIX_LEN,
  TSC_MAGIC,
  TSC_VERSION,
  buildHello,
  buildServerHello,
  deriveKeys,
  ed25519PrivateFromPkcs8,
  ed25519PublicFromRaw,
  fingerprintOf,
  open,
  parseServerHello,
  presentedFingerprint,
  seal,
  signTranscript,
  takeFrame,
  verifyAndDerive,
  x25519PrivateFromRaw,
} from './protocol'

/**
 * 从当前文件向上找到仓库根（认 `docs/fixtures/tsc1-vectors.json`）。
 *
 * 刻意**不数 `../` 层数**：目录一重构就会静默失效（我第一版就数错了，多上一层的 `apps/docs/...`）。
 */
function findFixture(): string {
  let dir = __dirname
  for (let i = 0; i < 10; i++) {
    const candidate = join(dir, 'docs/fixtures/tsc1-vectors.json')
    if (existsSync(candidate)) return candidate
    const parent = join(dir, '..')
    if (parent === dir) break
    dir = parent
  }
  throw new Error('找不到 docs/fixtures/tsc1-vectors.json（冻结向量必须在仓库里）')
}

/** 冻结向量 */
const V = JSON.parse(
  readFileSync(findFixture(), 'utf8'),
) as {
  inputs: Record<string, string>
  expected: Record<string, string>
  fingerprint: string
}

const b = (hex: string): Buffer => Buffer.from(hex, 'hex')

/** 由固定 seed 造 Ed25519 私钥（与生成向量时同一构造方式） */
function ed25519FromSeedByte(n: number) {
  const raw = Buffer.concat([
    Buffer.from('302e020100300506032b657004220420', 'hex'),
    Buffer.alloc(32, n),
  ])
  return ed25519PrivateFromPkcs8(raw)
}

describe('对照冻结向量（两侧唯一互操作保证）', () => {
  it('HELLO 字节布局与向量一致', () => {
    // 向量的 hello 里 timestamp 固定为 1700000000；这里直接比对结构而非 time
    const v = b(V.inputs.helloHex!)
    expect(v).toHaveLength(HELLO_LEN)
    expect(v[0]).toBe(TSC_MAGIC)
    expect(v[1]).toBe(TSC_VERSION)
    expect(v.readUInt16BE(2)).toBe(0)
    expect(v.subarray(8, 40).toString('hex')).toBe(V.inputs.clientRandomHex)
    expect(v.subarray(40, 72).toString('hex')).toBe(V.inputs.clientEphPubHex)
  })

  it('★ 会话密钥与向量逐字节一致（c2s / s2c）', () => {
    const keys = deriveKeys(
      b(V.inputs.helloHex!),
      b(V.inputs.serverHelloPrefixHex!),
      x25519PrivateFromRaw(b(V.inputs.clientEphPrivHex!)),
      b(V.inputs.serverEphPubHex!),
    )
    expect(keys.shared.toString('hex')).toBe(V.expected.sharedSecretHex)
    expect(keys.transcriptHash.toString('hex')).toBe(V.expected.transcriptSha256Hex)
    expect(keys.c2sKey.toString('hex')).toBe(V.expected.c2sKeyHex)
    expect(keys.s2cKey.toString('hex')).toBe(V.expected.s2cKeyHex)
  })

  it('★ 首帧密文逐字节一致（seq=0 的 c2s 与 s2c）', () => {
    const keys = deriveKeys(
      b(V.inputs.helloHex!),
      b(V.inputs.serverHelloPrefixHex!),
      x25519PrivateFromRaw(b(V.inputs.clientEphPrivHex!)),
      b(V.inputs.serverEphPubHex!),
    )
    expect(seal(keys.c2sKey, 'c2s', 0n, Buffer.from('hello')).toString('hex')).toBe(
      V.expected.firstFrameC2sHex,
    )
    expect(seal(keys.s2cKey, 's2c', 0n, Buffer.from('world')).toString('hex')).toBe(
      V.expected.firstFrameS2cHex,
    )
  })

  it('服务端签名可被钉扎公钥验过（用向量里的私钥重签，结果一致）', () => {
    const sig = signTranscript(
      b(V.inputs.helloHex!),
      b(V.inputs.serverHelloPrefixHex!),
      ed25519FromSeedByte(0x33),
    )
    // Ed25519 是确定性签名：同一输入同一密钥必得同一签名
    expect(sig.toString('hex')).toBe(V.expected.signatureHex)
  })

  it('指纹格式与向量一致（8 组 4 字符，便于口述核对）', () => {
    const fp = fingerprintOf(b(V.inputs.serverIdentityPubHex!))
    expect(fp.replace(/ /g, '')).toBe(V.fingerprint)
    expect(fp.split(' ')).toHaveLength(8)
  })
})

describe('握手解析的负例', () => {
  const validPrefix = b(V.inputs.serverHelloPrefixHex!)
  const fullHello = Buffer.concat([validPrefix, Buffer.alloc(64)])

  it('长度不对 → 拒绝', () => {
    expect(() => parseServerHello(fullHello.subarray(0, 100))).toThrow(/长度/)
  })

  it('★ 版本号被改成 2 → 拒绝（明确禁止降级）', () => {
    const bad = Buffer.from(fullHello)
    bad[1] = 2
    expect(() => parseServerHello(bad)).toThrow(/版本不支持/)
  })

  it('保留位非 0 → 拒绝', () => {
    const bad = Buffer.from(fullHello)
    bad.writeUInt16BE(1, 2)
    expect(() => parseServerHello(bad)).toThrow(/保留位/)
  })

  it('magic 不对 → 拒绝（对面可能不是本协议）', () => {
    const bad = Buffer.from(fullHello)
    bad[0] = 0x47 // 'G'
    expect(() => parseServerHello(bad)).toThrow(/magic/)
  })

  it('★ v2 布局：identity_pub 落在 [68,100)，签名落在 [100,164)', () => {
    const sh = parseServerHello(fullHello)
    expect(sh.identityPub).toHaveLength(32)
    expect(sh.identityPub.toString('hex')).toBe(V.inputs.serverIdentityPubHex)
    expect(sh.signature).toHaveLength(64)
    expect(SERVER_HELLO_LEN).toBe(164)
    expect(SERVER_HELLO_PREFIX_LEN).toBe(100)
  })
})

describe('身份校验的负例（v2：用对端出示的 identity_pub 验签 + 调用方比对指纹）', () => {
  function handshake() {
    const serverHello = parseServerHello(
      Buffer.concat([b(V.inputs.serverHelloPrefixHex!), b(V.expected.signatureHex!)]),
    )
    return verifyAndDerive({
      hello: b(V.inputs.helloHex!),
      serverHello,
      clientEphPrivate: x25519PrivateFromRaw(b(V.inputs.clientEphPrivHex!)),
    })
  }

  it('正确签名 → 通过并派生出向量里的密钥', () => {
    expect(handshake().c2sKey.toString('hex')).toBe(V.expected.c2sKeyHex)
  })

  it('★ 对端出示的身份公钥指纹与钉扎值一致（TOFU 的比对点）', () => {
    const sh = parseServerHello(
      Buffer.concat([b(V.inputs.serverHelloPrefixHex!), b(V.expected.signatureHex!)]),
    )
    expect(presentedFingerprint(sh).replace(/ /g, '')).toBe(V.fingerprint)
  })

  it('★ 签名被篡改一个字节 → 必须拒绝', () => {
    const sig = Buffer.from(b(V.expected.signatureHex!))
    sig[10] = (sig[10]! ^ 0xff) & 0xff
    const serverHello = parseServerHello(
      Buffer.concat([b(V.inputs.serverHelloPrefixHex!), sig]),
    )
    expect(() =>
      verifyAndDerive({
        hello: b(V.inputs.helloHex!),
        serverHello,
        clientEphPrivate: x25519PrivateFromRaw(b(V.inputs.clientEphPrivHex!)),
      }),
    ).toThrow(/签名校验失败/)
  })

  it('★ server_random 被改 → 签名不再匹配（转录被覆盖）', () => {
    const prefix = Buffer.from(b(V.inputs.serverHelloPrefixHex!))
    prefix[4] = (prefix[4]! ^ 0x01) & 0xff
    const serverHello = parseServerHello(Buffer.concat([prefix, b(V.expected.signatureHex!)]))
    expect(() =>
      verifyAndDerive({
        hello: b(V.inputs.helloHex!),
        serverHello,
        clientEphPrivate: x25519PrivateFromRaw(b(V.inputs.clientEphPrivHex!)),
      }),
    ).toThrow(/签名校验失败/)
  })

  it('★★ identity_pub 被换成别人的 → 签名必失效（证明签名覆盖了身份）', () => {
    // 这条最要紧：如果签名不覆盖 identity_pub，攻击者就能换掉身份公钥而签名依旧有效 ——
    // 那样"钉扎"就成了纸糊的。
    const prefix = Buffer.from(b(V.inputs.serverHelloPrefixHex!))
    const otherPub = Buffer.from(
      (createPublicKey(ed25519FromSeedByte(0x99)).export({ format: 'jwk' }) as { x: string }).x,
      'base64url',
    )
    otherPub.copy(prefix, 68) // 替换 identity_pub
    const serverHello = parseServerHello(Buffer.concat([prefix, b(V.expected.signatureHex!)]))
    expect(() =>
      verifyAndDerive({
        hello: b(V.inputs.helloHex!),
        serverHello,
        clientEphPrivate: x25519PrivateFromRaw(b(V.inputs.clientEphPrivHex!)),
      }),
    ).toThrow(/签名校验失败/)
    // 同时：指纹变了 → 调用方的钉扎比对会拒绝（两道防线各自独立生效）
    expect(presentedFingerprint(serverHello).replace(/ /g, '')).not.toBe(V.fingerprint)
  })
})

describe('记录层负例', () => {
  const key = b(V.expected.c2sKeyHex!)

  it('正常往返', () => {
    const frame = seal(key, 'c2s', 0n, Buffer.from('payload'))
    const opened = open(key, 'c2s', 0n, frame)
    expect(opened.plaintext.toString()).toBe('payload')
  })

  it('★ 篡改密文一个字节 → GCM 校验失败', () => {
    const frame = seal(key, 'c2s', 0n, Buffer.from('payload'))
    frame[frame.length - 5] = (frame[frame.length - 5]! ^ 0xff) & 0xff
    expect(() => open(key, 'c2s', 0n, frame)).toThrow()
  })

  it('★ 重放（同一帧喂两次）→ 第二次因序号不符被拒', () => {
    const frame = seal(key, 'c2s', 0n, Buffer.from('x'))
    open(key, 'c2s', 0n, frame)
    expect(() => open(key, 'c2s', 1n, frame)).toThrow(/序号不连续|重放/)
  })

  it('★ 乱序（先给 seq=1 再给 seq=0）→ 被拒', () => {
    const f1 = seal(key, 'c2s', 1n, Buffer.from('x'))
    expect(() => open(key, 'c2s', 0n, f1)).toThrow(/序号不连续/)
  })

  it('★ 序号被篡改 → nonce 不匹配，拒绝', () => {
    const frame = seal(key, 'c2s', 5n, Buffer.from('x'))
    frame.writeBigUInt64BE(6n, 8)
    expect(() => open(key, 'c2s', 6n, frame)).toThrow(/nonce|序号/)
  })

  it('★ 长度字段被改大 → 拒绝（不给"分配了才发现不对"的机会）', () => {
    const frame = seal(key, 'c2s', 0n, Buffer.from('x'))
    frame.writeUInt32BE(frame.length + 100, 0)
    expect(() => open(key, 'c2s', 0n, frame)).toThrow(/长度/)
  })

  it('★ 声明超长帧 → 拒绝（内存耗尽入口）', () => {
    const huge = Buffer.alloc(12)
    huge.writeUInt32BE(MAX_FRAME_BYTES + 1, 0)
    expect(() => takeFrame(huge)).toThrow(/帧过大/)
  })

  it('★ 用错方向的密钥 → 拒绝（c2s 的帧不能用 s2c 的密钥开）', () => {
    const frame = seal(key, 'c2s', 0n, Buffer.from('x'))
    expect(() => open(b(V.expected.s2cKeyHex!), 'c2s', 0n, frame)).toThrow()
  })

  it('★ 两个方向各自 seq 独立（互不干扰）', () => {
    const s2c = b(V.expected.s2cKeyHex!)
    const f1 = seal(key, 'c2s', 0n, Buffer.from('a'))
    const f2 = seal(s2c, 's2c', 0n, Buffer.from('b'))
    // 两个方向都用 seq=0，各自的 nonce 前缀不同 → 不会撞
    expect(open(key, 'c2s', 0n, f1).plaintext.toString()).toBe('a')
    expect(open(s2c, 's2c', 0n, f2).plaintext.toString()).toBe('b')
  })

  it('takeFrame 只切完整帧，半截返回 null', () => {
    const frame = seal(key, 'c2s', 0n, Buffer.from('hello'))
    expect(takeFrame(frame.subarray(0, 10))).toBeNull()
    const r = takeFrame(Buffer.concat([frame, Buffer.from([1, 2, 3])]))
    expect(r?.frame.toString('hex')).toBe(frame.toString('hex'))
    expect(r?.rest.length).toBe(3)
  })
})

describe('低阶点防护', () => {
  it('★ 对端公钥是全零（低阶点）→ 必须拒绝，而不是"协商成功"', () => {
    // 两道防护：①底层抛错（Node 24/OpenSSL 3.5.9 实测如此）②显式检查全零（别的实现可能静默返回全零）。
    // 断言只认**归一化后的措辞**，不依赖具体 OpenSSL 版本的错误串。
    const clientPriv = x25519PrivateFromRaw(b(V.inputs.clientEphPrivHex!))
    expect(() =>
      deriveKeys(
        b(V.inputs.helloHex!),
        b(V.inputs.serverHelloPrefixHex!),
        clientPriv,
        Buffer.alloc(32), // 全零公钥
      ),
    ).toThrow(/低阶点/)
  })
})

describe('握手构造（服务端侧）', () => {
  it('buildHello 产出固定长度的合法头', () => {
    const hello = buildHello(Buffer.alloc(32, 7), Buffer.alloc(32, 8))
    expect(hello).toHaveLength(HELLO_LEN)
    expect(hello[0]).toBe(TSC_MAGIC)
    expect(hello[1]).toBe(TSC_VERSION)
    expect(hello.readUInt16BE(2)).toBe(0)
  })

  it('buildServerHello 的签名能被客户端验证（自洽往返）', () => {
    const identity = ed25519FromSeedByte(0x33)
    const hello = b(V.inputs.helloHex!)
    const sh = buildServerHello(
      hello,
      b(V.inputs.serverRandomHex!),
      b(V.inputs.serverEphPubHex!),
      identity,
    )
    expect(sh).toHaveLength(SERVER_HELLO_LEN)
    const parsed = parseServerHello(sh)
    // 身份公钥应被写进 [68,100)
    expect(parsed.identityPub.toString('hex')).toBe(V.inputs.serverIdentityPubHex)
    const keys = verifyAndDerive({
      hello,
      serverHello: parsed,
      clientEphPrivate: x25519PrivateFromRaw(b(V.inputs.clientEphPrivHex!)),
    })
    expect(keys.c2sKey.toString('hex')).toBe(V.expected.c2sKeyHex)
  })

  it('ed25519PublicFromRaw 与 X25519 不通用（类型不同，必须分开构造）', () => {
    // 这是一条"防止有人图省事混用"的断言
    expect(() => ed25519PublicFromRaw(b(V.inputs.serverEphPubHex!))).not.toThrow()
    const k = ed25519PublicFromRaw(b(V.inputs.serverEphPubHex!))
    expect((k.asymmetricKeyType ?? '').toLowerCase()).toContain('ed25519')
  })
})
