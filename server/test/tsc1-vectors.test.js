// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * TSC/1 冻结向量对照测试（规范 §7 第 8 条）。
 *
 * 这是服务端与客户端**两份独立实现之间唯一的互操作保证**。
 *
 * 本文件刻意分两层：
 * 1. **独立复算层**：只用 node:crypto 原语、按规范 §3.3/§3.4 手写推导，
 *    不 import 被测实现 —— 用来确认「向量本身自洽可信」。
 * 2. **实现对照层**：用 `src/tsc1/crypto.js` 走完整流程，与向量逐字节比对。
 *
 * 两层都过，才能说明"实现正确"且"向量可信"，而不是自己证明自己。
 *
 * 向量布局：v2（helloLen 72 / serverHelloPrefixLen 100 / serverHelloLen 164 /
 * sigOffset 100 / identityPubOffset 68）。
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  hkdfSync,
  verify as edVerify,
} from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const VECTORS = JSON.parse(readFileSync(join(here, '../../docs/fixtures/tsc1-vectors.json'), 'utf8'))

const hex = (s) => Buffer.from(s, 'hex')

const X25519_PKCS8 = Buffer.from('302e020100300506032b656e04220420', 'hex')
const X25519_SPKI = Buffer.from('302a300506032b656e032100', 'hex')
const ED25519_SPKI = Buffer.from('302a300506032b6570032100', 'hex')

const x25519Priv = (raw) => createPrivateKey({ key: Buffer.concat([X25519_PKCS8, raw]), format: 'der', type: 'pkcs8' })
const x25519Pub = (raw) => createPublicKey({ key: Buffer.concat([X25519_SPKI, raw]), format: 'der', type: 'spki' })
const ed25519Pub = (raw) => createPublicKey({ key: Buffer.concat([ED25519_SPKI, raw]), format: 'der', type: 'spki' })

describe('TSC/1 冻结向量：独立复算（不使用被测实现）', () => {
  const I = VECTORS.inputs
  const E = VECTORS.expected

  it('元信息与 v2 布局声明正确', () => {
    assert.equal(VECTORS.protocol, 'TSC/1')
    assert.deepEqual(VECTORS.layout, {
      helloLen: 72,
      serverHelloPrefixLen: 100,
      serverHelloLen: 164,
      sigOffset: 100,
      identityPubOffset: 68,
    })
    assert.equal(hex(I.helloHex).length, VECTORS.layout.helloLen)
    assert.equal(hex(I.serverHelloPrefixHex).length, VECTORS.layout.serverHelloPrefixLen)
  })

  it('HELLO 的字段落在规范声明的偏移上', () => {
    const hello = hex(I.helloHex)
    assert.equal(hello.readUInt8(0), 0x54, 'magic')
    assert.equal(hello.readUInt8(1), 0x01, 'version')
    assert.equal(hello.readUInt16BE(2), 0, 'reserved')
    assert.equal(hello.subarray(8, 40).toString('hex'), I.clientRandomHex)
    assert.equal(hello.subarray(40, 72).toString('hex'), I.clientEphPubHex)
  })

  it('SERVER_HELLO 前缀含 identity_pub，且落在 [68,100)', () => {
    const prefix = hex(I.serverHelloPrefixHex)
    assert.equal(prefix.subarray(4, 36).toString('hex'), I.serverRandomHex)
    assert.equal(prefix.subarray(36, 68).toString('hex'), I.serverEphPubHex)
    assert.equal(
      prefix.subarray(VECTORS.layout.identityPubOffset, VECTORS.layout.sigOffset).toString('hex'),
      I.serverIdentityPubHex,
      'identity_pub 必须位于 [68,100)',
    )
  })

  it('两个临时公钥确实由各自的临时私钥导出', () => {
    const cliPub = createPublicKey(x25519Priv(hex(I.clientEphPrivHex))).export({ format: 'der', type: 'spki' })
    const srvPub = createPublicKey(x25519Priv(hex(I.serverEphPrivHex))).export({ format: 'der', type: 'spki' })
    assert.equal(cliPub.subarray(-32).toString('hex'), I.clientEphPubHex)
    assert.equal(srvPub.subarray(-32).toString('hex'), I.serverEphPubHex)
  })

  it('共享密钥两侧独立算出且相同，且非全零', () => {
    const fromServer = diffieHellman({
      privateKey: x25519Priv(hex(I.serverEphPrivHex)),
      publicKey: x25519Pub(hex(I.clientEphPubHex)),
    })
    const fromClient = diffieHellman({
      privateKey: x25519Priv(hex(I.clientEphPrivHex)),
      publicKey: x25519Pub(hex(I.serverEphPubHex)),
    })
    assert.equal(fromServer.toString('hex'), E.sharedSecretHex)
    assert.equal(fromClient.toString('hex'), E.sharedSecretHex, '反向也必须得到同一个 shared')
    assert.notEqual(E.sharedSecretHex, '0'.repeat(64), '向量里的 shared 不能是全零')
  })

  it('transcript 哈希 = SHA256(hello || serverHelloPrefix)', () => {
    const transcript = Buffer.concat([hex(I.helloHex), hex(I.serverHelloPrefixHex)])
    assert.equal(createHash('sha256').update(transcript).digest('hex'), E.transcriptSha256Hex)
  })

  it('被签名摘要是 SHA256("TSC/1 server-hello" || transcript)', () => {
    const transcript = Buffer.concat([hex(I.helloHex), hex(I.serverHelloPrefixHex)])
    const digest = createHash('sha256').update(Buffer.from('TSC/1 server-hello')).update(transcript).digest()
    assert.equal(digest.toString('hex'), E.signedDigestHex)
  })

  it('签名可用向量里的身份公钥验签通过', () => {
    const transcript = Buffer.concat([hex(I.helloHex), hex(I.serverHelloPrefixHex)])
    const digest = createHash('sha256').update(Buffer.from('TSC/1 server-hello')).update(transcript).digest()
    assert.equal(edVerify(null, digest, ed25519Pub(hex(I.serverIdentityPubHex)), hex(E.signatureHex)), true)
  })

  it('c2s / s2c 密钥可独立推出，且两者不同', () => {
    const shared = hex(E.sharedSecretHex)
    const th = hex(E.transcriptSha256Hex)
    const c2s = Buffer.from(hkdfSync('sha256', shared, th, Buffer.from('TSC/1 c2s'), 32))
    const s2c = Buffer.from(hkdfSync('sha256', shared, th, Buffer.from('TSC/1 s2c'), 32))
    assert.equal(c2s.toString('hex'), E.c2sKeyHex)
    assert.equal(s2c.toString('hex'), E.s2cKeyHex)
    assert.notEqual(E.c2sKeyHex, E.s2cKeyHex)
  })

  it('指纹 = SHA256(身份公钥) 前 16 字节，8 组 4 字符', () => {
    const fp = createHash('sha256').update(hex(I.serverIdentityPubHex)).digest().subarray(0, 16).toString('hex')
    assert.equal(fp.replace(/(.{4})(?=.)/g, '$1 '), VECTORS.fingerprint)
    assert.equal(VECTORS.fingerprint.replace(/ /g, '').length, 32)
  })

  it('首帧布局符合 §4，且能独立解密成预期明文', () => {
    const f = hex(E.firstFrameC2sHex)
    assert.equal(f.readUInt32BE(0), f.length - 12, 'length = 帧总长 - (4+8)')
    assert.equal(f.readBigUInt64BE(4), 0n, 'seq 从 0 开始')
    assert.equal(f.subarray(12, 16).toString('hex'), '00000001', 'c2s nonce 前缀')
    assert.equal(f.subarray(16, 24).toString('hex'), '0000000000000000', 'nonce 内嵌 seq')

    const d = createDecipheriv('aes-256-gcm', hex(E.c2sKeyHex), f.subarray(12, 24))
    d.setAuthTag(f.subarray(f.length - 16))
    const pt = Buffer.concat([d.update(f.subarray(24, f.length - 16)), d.final()])
    assert.equal(pt.toString('utf8'), 'hello')

    const g = hex(E.firstFrameS2cHex)
    assert.equal(g.subarray(12, 16).toString('hex'), '00000002', 's2c nonce 前缀')
    const d2 = createDecipheriv('aes-256-gcm', hex(E.s2cKeyHex), g.subarray(12, 24))
    d2.setAuthTag(g.subarray(g.length - 16))
    assert.equal(Buffer.concat([d2.update(g.subarray(24, g.length - 16)), d2.final()]).toString('utf8'), 'world')
  })
})

describe('TSC/1 冻结向量：与本实现逐字节对照', () => {
  it('握手派生出的全部值都与向量一致', async () => {
    const m = await import('../src/tsc1/crypto.js')
    const I = VECTORS.inputs
    const E = VECTORS.expected

    const hello = m.buildHello({
      clientRandom: hex(I.clientRandomHex),
      clientEphPub: hex(I.clientEphPubHex),
      timestamp: 1700000000,
    })
    assert.equal(hello.toString('hex'), I.helloHex, 'HELLO 字节不一致')

    const seed = Buffer.alloc(32, I.serverIdentitySeedByte)
    const idPubRaw = m.ed25519PublicRawFromSeed(seed)
    assert.equal(idPubRaw.toString('hex'), I.serverIdentityPubHex, '固定种子派生出的身份公钥与向量不符')

    const shPrefix = m.buildServerHelloPrefix({
      serverRandom: hex(I.serverRandomHex),
      serverEphPub: hex(I.serverEphPubHex),
      identityPub: idPubRaw,
    })
    assert.equal(shPrefix.toString('hex'), I.serverHelloPrefixHex, 'SERVER_HELLO 前缀字节不一致')

    const transcript = m.buildTranscript(hello, shPrefix)

    const shared = m.computeShared(x25519Priv(hex(I.serverEphPrivHex)), x25519Pub(hex(I.clientEphPubHex)))
    assert.equal(shared.toString('hex'), E.sharedSecretHex)

    const keys = m.deriveSessionKeys(shared, transcript)
    assert.equal(keys.transcriptHash.toString('hex'), E.transcriptSha256Hex)
    assert.equal(keys.c2sKey.toString('hex'), E.c2sKeyHex)
    assert.equal(keys.s2cKey.toString('hex'), E.s2cKeyHex)

    const sig = m.signTranscript(transcript, m.ed25519PrivateFromRaw(seed))
    assert.equal(sig.toString('hex'), E.signatureHex, '签名不一致')
    assert.equal(m.verifyTranscript(transcript, sig, m.ed25519PublicFromRaw(idPubRaw)), true)

    // 完整 SERVER_HELLO 的长度与签名偏移都要对
    const full = m.buildServerHello({
      serverRandom: hex(I.serverRandomHex),
      serverEphPub: hex(I.serverEphPubHex),
      identityPub: idPubRaw,
      signature: sig,
    })
    assert.equal(full.length, VECTORS.layout.serverHelloLen)
    assert.equal(full.subarray(VECTORS.layout.sigOffset).toString('hex'), E.signatureHex)

    // 解析回来各项一致（并用钉扎指纹校验通过）
    const parsed = m.parseServerHello(full, { expectedFingerprint: VECTORS.fingerprint })
    assert.equal(parsed.identityPub.toString('hex'), I.serverIdentityPubHex)
    assert.equal(parsed.serverEphPub.toString('hex'), I.serverEphPubHex)
  })

  it('首帧密文逐字节一致（硬指标）', async () => {
    const m = await import('../src/tsc1/crypto.js')
    const I = VECTORS.inputs
    const E = VECTORS.expected

    const transcript = m.buildTranscript(hex(I.helloHex), hex(I.serverHelloPrefixHex))
    const shared = m.computeShared(x25519Priv(hex(I.serverEphPrivHex)), x25519Pub(hex(I.clientEphPubHex)))
    const { c2sKey, s2cKey } = m.deriveSessionKeys(shared, transcript)

    const c2sFrame = m.encryptFrame({
      key: c2sKey,
      prefix: m.NONCE_PREFIX_C2S,
      seq: 0,
      plaintext: Buffer.from('hello'),
    })
    assert.equal(c2sFrame.toString('hex'), E.firstFrameC2sHex, 'c2s 首帧密文不一致')

    const s2cFrame = m.encryptFrame({
      key: s2cKey,
      prefix: m.NONCE_PREFIX_S2C,
      seq: 0,
      plaintext: Buffer.from('world'),
    })
    assert.equal(s2cFrame.toString('hex'), E.firstFrameS2cHex, 's2c 首帧密文不一致')
  })

  it('用向量的密钥能解开向量的帧（回环）', async () => {
    const m = await import('../src/tsc1/crypto.js')
    const E = VECTORS.expected

    const a = m.decryptFrame({
      key: hex(E.c2sKeyHex),
      prefix: m.NONCE_PREFIX_C2S,
      frame: hex(E.firstFrameC2sHex),
      expectedSeq: 0,
    })
    assert.equal(a.plaintext.toString('utf8'), 'hello')

    const b = m.decryptFrame({
      key: hex(E.s2cKeyHex),
      prefix: m.NONCE_PREFIX_S2C,
      frame: hex(E.firstFrameS2cHex),
      expectedSeq: 0,
    })
    assert.equal(b.plaintext.toString('utf8'), 'world')
  })

  it('钉扎不符时拒绝（TOFU 的关键一步）', async () => {
    const m = await import('../src/tsc1/crypto.js')
    const I = VECTORS.inputs
    const seed = Buffer.alloc(32, I.serverIdentitySeedByte)
    const idPubRaw = m.ed25519PublicRawFromSeed(seed)
    const full = m.buildServerHello({
      serverRandom: hex(I.serverRandomHex),
      serverEphPub: hex(I.serverEphPubHex),
      identityPub: idPubRaw,
      signature: hex(VECTORS.expected.signatureHex),
    })

    assert.throws(
      () => m.parseServerHello(full, { expectedFingerprint: 'dead beef dead beef dead beef dead beef' }),
      (err) => err.code === 'IDENTITY_MISMATCH',
    )
    assert.doesNotThrow(() => m.parseServerHello(full, { expectedFingerprint: VECTORS.fingerprint }))
  })
})
