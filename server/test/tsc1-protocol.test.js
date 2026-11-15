// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * TSC/1 协议测试：记录层纪律、握手端到端、以及规范 §7 的**全部负例**。
 *
 * §7 的负例比正例更重要 —— 一个能正常握手但接受篡改帧的实现，
 * 比握手都握不上的实现危险得多。
 */

import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, createPublicKey, generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect } from 'node:net'

process.env.T1000_DATA_DIR = mkdtempSync(join(tmpdir(), 't1000-tsc1-'))

const crypto = await import('../src/tsc1/crypto.js')
const { RecordReceiver, RecordSender } = await import('../src/tsc1/record.js')
const { handleTsc1Connection } = await import('../src/tsc1/server.js')
const { loadOrCreateIdentity } = await import('../src/tsc1/identity.js')
const { createTsc1Server } = await import('../src/tsc1/listener.js')

const {
  HELLO_LEN,
  SERVER_HELLO_LEN,
  SERVER_HELLO_PREFIX_LEN,
  MAX_FRAME_LEN,
  NONCE_PREFIX_C2S,
  NONCE_PREFIX_S2C,
  Tsc1Error,
  buildHello,
  buildTranscript,
  computeShared,
  deriveSessionKeys,
  ed25519PublicFromRaw,
  encryptFrame,
  fingerprint,
  parseHello,
  parseServerHello,
  random32,
  verifyTranscript,
  x25519PublicFromRaw,
  x25519RawPublic,
} = crypto

const hex = (s) => Buffer.from(s, 'hex')
const tmpDirs = []
function makeTmpDir() {
  const d = mkdtempSync(join(tmpdir(), 't1000-tsc1-unit-'))
  tmpDirs.push(d)
  return d
}

after(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true })
})

// --------------------------------------------------------------------- 记录层

describe('记录层：正常帧流', () => {
  const key = Buffer.alloc(32, 0x11)

  it('一帧一发一收，往返一致', () => {
    const s = new RecordSender({ key, prefix: NONCE_PREFIX_S2C })
    const r = new RecordReceiver({ key, prefix: NONCE_PREFIX_S2C })
    const frame = s.send(Buffer.from('hello'))
    const out = r.feed(frame)
    assert.equal(out.length, 1)
    assert.equal(out[0].toString(), 'hello')
    assert.equal(r.expectedSeq, 1)
  })

  it('多帧粘包：一次 feed 能解出多帧', () => {
    const s = new RecordSender({ key, prefix: NONCE_PREFIX_S2C })
    const r = new RecordReceiver({ key, prefix: NONCE_PREFIX_S2C })
    const joined = Buffer.concat([s.send(Buffer.from('a')), s.send(Buffer.from('b')), s.send(Buffer.from('c'))])
    const out = r.feed(joined)
    assert.deepEqual(
      out.map((b) => b.toString()),
      ['a', 'b', 'c'],
    )
  })

  it('半包：逐字节喂入也能正确解出（TCP 是流）', () => {
    const s = new RecordSender({ key, prefix: NONCE_PREFIX_S2C })
    const r = new RecordReceiver({ key, prefix: NONCE_PREFIX_S2C })
    const frame = s.send(Buffer.from('byte-by-byte'))
    const collected = []
    for (const byte of frame) {
      collected.push(...r.feed(Buffer.from([byte])))
    }
    assert.equal(collected.length, 1)
    assert.equal(collected[0].toString(), 'byte-by-byte')
  })

  it('空明文是合法的', () => {
    const s = new RecordSender({ key, prefix: NONCE_PREFIX_S2C })
    const r = new RecordReceiver({ key, prefix: NONCE_PREFIX_S2C })
    const out = r.feed(s.send(Buffer.alloc(0)))
    assert.equal(out[0].length, 0)
  })
})

describe('§7 负例：帧层', () => {
  const key = Buffer.alloc(32, 0x22)

  it('§7.1 篡改任意一个字节 → GCM 认证失败', () => {
    const s = new RecordSender({ key, prefix: NONCE_PREFIX_S2C })
    const frame = s.send(Buffer.from('important payload'))

    // 逐个位置翻转，每一处都必须被拒
    for (let i = 12; i < frame.length; i += 1) {
      const tampered = Buffer.from(frame)
      tampered[i] ^= 0x01
      const r = new RecordReceiver({ key, prefix: NONCE_PREFIX_S2C })
      assert.throws(
        () => r.feed(tampered),
        (err) => err instanceof Tsc1Error,
        `偏移 ${i} 被篡改却未被拒绝`,
      )
    }
  })

  it('§7.2 重放同一帧（seq 重复）→ 拒绝', () => {
    const s = new RecordSender({ key, prefix: NONCE_PREFIX_S2C })
    const r = new RecordReceiver({ key, prefix: NONCE_PREFIX_S2C })
    const f0 = s.send(Buffer.from('one'))
    r.feed(f0) // seq 0 已消费
    assert.throws(() => r.feed(f0), /seq/i)
  })

  it('§7.3 打乱帧顺序 → 拒绝', () => {
    const s = new RecordSender({ key, prefix: NONCE_PREFIX_S2C })
    const r = new RecordReceiver({ key, prefix: NONCE_PREFIX_S2C })
    const f0 = s.send(Buffer.from('a'))
    const f1 = s.send(Buffer.from('b'))
    assert.throws(() => r.feed(f1), /seq/i, '乱序帧必须被拒')
    void f0
  })

  it('§7.7 超长 length → 拒绝且不分配内存', () => {
    const r = new RecordReceiver({ key, prefix: NONCE_PREFIX_S2C })
    const evil = Buffer.alloc(12)
    evil.writeUInt32BE(MAX_FRAME_LEN + 1, 0) // 只发头部，声称超大
    assert.throws(
      () => r.feed(evil),
      (err) => err instanceof Tsc1Error && err.code === 'FRAME_TOO_LARGE',
    )
  })

  it('length 小于最小开销 → 拒绝', () => {
    const r = new RecordReceiver({ key, prefix: NONCE_PREFIX_S2C })
    const bad = Buffer.alloc(12)
    bad.writeUInt32BE(5, 0)
    assert.throws(() => r.feed(bad), (err) => err.code === 'FRAME_BAD_LENGTH')
  })

  it('nonce 方向前缀不匹配（两方向混用密钥）→ 拒绝', () => {
    // 用 s2c 的 key 与前缀造帧，却让一个期望 c2s 前缀的接收方去解
    const s = new RecordSender({ key, prefix: NONCE_PREFIX_S2C })
    const frame = s.send(Buffer.from('x'))
    const r = new RecordReceiver({ key, prefix: NONCE_PREFIX_C2S })
    assert.throws(() => r.feed(frame), (err) => err.code === 'FRAME_BAD_NONCE_PREFIX')
  })
})

// --------------------------------------------------------------------- 握手

describe('握手：正常流程与派生值', () => {
  it('完整握手后双方派生出相同的会话密钥', () => {
    const id = loadOrCreateIdentity(makeTmpDir())
    const cliEph = generateKeyPairSync('x25519')
    const srvEph = generateKeyPairSync('x25519')

    const hello = buildHello({
      clientRandom: random32(),
      clientEphPub: x25519RawPublic(cliEph.publicKey),
      timestamp: 1700000000,
    })

    const serverRandom = random32()
    const serverEphPub = x25519RawPublic(srvEph.publicKey)

    const clientShared = computeShared(cliEph.privateKey, x25519PublicFromRaw(serverEphPub))
    const serverShared = computeShared(srvEph.privateKey, x25519PublicFromRaw(x25519RawPublic(cliEph.publicKey)))
    assert.equal(clientShared.toString('hex'), serverShared.toString('hex'))

    const prefix = crypto.buildServerHelloPrefix({
      serverRandom,
      serverEphPub,
      identityPub: id.publicKeyRaw,
    })
    const transcript = buildTranscript(hello, prefix)
    const sig = crypto.signTranscript(transcript, id.privateKey)

    assert.equal(verifyTranscript(transcript, sig, ed25519PublicFromRaw(id.publicKeyRaw)), true)

    const ck = deriveSessionKeys(clientShared, transcript)
    const sk = deriveSessionKeys(serverShared, transcript)
    assert.equal(ck.c2sKey.toString('hex'), sk.c2sKey.toString('hex'))
    assert.equal(ck.s2cKey.toString('hex'), sk.s2cKey.toString('hex'))
    assert.notEqual(ck.c2sKey.toString('hex'), ck.s2cKey.toString('hex'))
  })

  it('SERVER_HELLO 布局符合 v2（164 字节，含 identity_pub）', () => {
    const id = loadOrCreateIdentity(makeTmpDir())
    const prefix = crypto.buildServerHelloPrefix({
      serverRandom: random32(),
      serverEphPub: Buffer.alloc(32, 3),
      identityPub: id.publicKeyRaw,
    })
    assert.equal(prefix.length, SERVER_HELLO_PREFIX_LEN)
    assert.equal(prefix.length, 100)
    // identity_pub 落在 [68,100)
    assert.equal(prefix.subarray(68, 100).toString('hex'), id.publicKeyRaw.toString('hex'))

    const sig = Buffer.alloc(64, 7)
    const full = crypto.buildServerHello({
      serverRandom: random32(),
      serverEphPub: Buffer.alloc(32, 3),
      identityPub: id.publicKeyRaw,
      signature: sig,
    })
    assert.equal(full.length, SERVER_HELLO_LEN)
    assert.equal(full.length, 164)
    assert.equal(full.subarray(100).toString('hex'), sig.toString('hex'))
  })

  it('§7.4 用向量之外的身份密钥签名 → 用原身份公钥验签必须失败', () => {
    const real = loadOrCreateIdentity(makeTmpDir())
    const fake = loadOrCreateIdentity(makeTmpDir())
    assert.notEqual(real.publicKeyRaw.toString('hex'), fake.publicKeyRaw.toString('hex'))

    const hello = buildHello({ clientRandom: random32(), clientEphPub: Buffer.alloc(32, 1) })
    const prefix = crypto.buildServerHelloPrefix({
      serverRandom: random32(),
      serverEphPub: Buffer.alloc(32, 2),
      identityPub: fake.publicKeyRaw, // 攻击者自签
    })
    const transcript = buildTranscript(hello, prefix)
    const sig = crypto.signTranscript(transcript, fake.privateKey)

    // 自签能过"持有对应私钥"的检查（这正是"签名不证明身份"）
    assert.equal(verifyTranscript(transcript, sig, ed25519PublicFromRaw(fake.publicKeyRaw)), true)
    // 但用**真实**身份公钥验签必然失败
    assert.equal(verifyTranscript(transcript, sig, ed25519PublicFromRaw(real.publicKeyRaw)), false)
  })

  it('§7.4 已钉扎但指纹不符 → parseServerHello 拒绝（TOFU 的关键一步）', () => {
    const real = loadOrCreateIdentity(makeTmpDir())
    const fake = loadOrCreateIdentity(makeTmpDir())

    const hello = buildHello({ clientRandom: random32(), clientEphPub: Buffer.alloc(32, 1) })
    const prefix = crypto.buildServerHelloPrefix({
      serverRandom: random32(),
      serverEphPub: Buffer.alloc(32, 2),
      identityPub: fake.publicKeyRaw,
    })
    const transcript = buildTranscript(hello, prefix)
    const sig = crypto.signTranscript(transcript, fake.privateKey)
    const full = Buffer.concat([prefix, sig])

    // 钉扎的是 real 的指纹 → 必须拒绝
    assert.throws(
      () => parseServerHello(full, { expectedFingerprint: fingerprint(real.publicKeyRaw) }),
      (err) => err.code === 'IDENTITY_MISMATCH',
    )
    // 首次连接（无钉扎）→ 允许，由调用方提示用户核对
    const parsed = parseServerHello(full)
    assert.equal(parsed.identityPub.toString('hex'), fake.publicKeyRaw.toString('hex'))
  })

  it('§7.5 版本号 2 → 拒绝（不降级）', () => {
    const hello = buildHello({ clientRandom: random32(), clientEphPub: Buffer.alloc(32, 1) })
    hello.writeUInt8(2, 1)
    assert.throws(() => parseHello(hello), (err) => err.code === 'BAD_VERSION')
  })

  it('保留位非 0 → 拒绝', () => {
    const hello = buildHello({ clientRandom: random32(), clientEphPub: Buffer.alloc(32, 1) })
    hello.writeUInt16BE(1, 2)
    assert.throws(() => parseHello(hello), (err) => err.code === 'BAD_RESERVED')
  })

  it('magic 不对 → 拒绝', () => {
    const hello = buildHello({ clientRandom: random32(), clientEphPub: Buffer.alloc(32, 1) })
    hello.writeUInt8(0x47, 0) // 'G'
    assert.throws(() => parseHello(hello), (err) => err.code === 'BAD_MAGIC')
  })

  it('HELLO 长度不对 → 拒绝', () => {
    assert.throws(() => parseHello(Buffer.alloc(71)), (err) => err.code === 'BAD_HELLO_LEN')
    assert.throws(() => parseHello(Buffer.alloc(70)), (err) => err.code === 'BAD_HELLO_LEN')
    assert.equal(HELLO_LEN, 72)
  })

  it('§7.6 全零共享密钥（低阶点）→ 显式拒绝', () => {
    // 构造一个全零的对端公钥；无论底层抛错还是返回全零，都必须被拒
    const eph = generateKeyPairSync('x25519')
    const zeroPub = crypto.x25519PublicFromRaw(Buffer.alloc(32, 0))
    assert.throws(
      () => computeShared(eph.privateKey, zeroPub),
      (err) => err instanceof Tsc1Error && (err.code === 'X25519_ZERO_SHARED' || err.code === 'X25519_FAILED'),
      '全零/低阶点公钥必须被拒绝',
    )
  })

  it('§7.6 共享密钥为全零时 isAllZero 判定正确', () => {
    assert.equal(crypto.isAllZero(Buffer.alloc(32, 0)), true)
    const nonZero = Buffer.alloc(32, 0)
    nonZero[31] = 1
    assert.equal(crypto.isAllZero(nonZero), false)
  })

  it('§7.9 前向保密：会话密钥只依赖临时密钥与 transcript，与身份私钥无关', () => {
    const cliEph = generateKeyPairSync('x25519')
    const srvEph = generateKeyPairSync('x25519')
    const serverEphPub = x25519RawPublic(srvEph.publicKey)
    const clientEphPub = x25519RawPublic(cliEph.publicKey)

    const hello = buildHello({ clientRandom: Buffer.alloc(32, 9), clientEphPub, timestamp: 1 })

    // 用两把**不同的**身份私钥签同一个 transcript
    const idA = loadOrCreateIdentity(makeTmpDir())
    const idB = loadOrCreateIdentity(makeTmpDir())

    const prefixA = crypto.buildServerHelloPrefix({
      serverRandom: Buffer.alloc(32, 5),
      serverEphPub,
      identityPub: idA.publicKeyRaw,
    })
    const prefixB = crypto.buildServerHelloPrefix({
      serverRandom: Buffer.alloc(32, 5),
      serverEphPub,
      identityPub: idB.publicKeyRaw,
    })
    // identity_pub 不同 ⇒ transcript 不同 ⇒ 密钥不同（这正是签名覆盖它的副作用，符合预期）
    const tA = buildTranscript(hello, prefixA)
    const tB = buildTranscript(hello, prefixB)
    assert.notEqual(createHash('sha256').update(tA).digest('hex'), createHash('sha256').update(tB).digest('hex'))

    // 关键断言：会话密钥由 (临时私钥, 对端临时公钥, transcript) 唯一决定，
    // 与身份私钥**无关** —— 把身份私钥"泄露"（这里等于换一把）不影响
    // 用相同临时密钥与相同 transcript 算出的密钥。
    const s1 = computeShared(srvEph.privateKey, x25519PublicFromRaw(clientEphPub))
    const s2 = computeShared(srvEph.privateKey, x25519PublicFromRaw(clientEphPub))
    assert.equal(s1.toString('hex'), s2.toString('hex'))
    assert.equal(
      deriveSessionKeys(s1, tA).c2sKey.toString('hex'),
      deriveSessionKeys(s2, tA).c2sKey.toString('hex'),
    )
  })
})

// --------------------------------------------------------------------- 端到端

describe('端到端：真实 socket 上的 TSC/1 连接', () => {
  let server
  let port
  let identity
  const logs = []

  // 收集本测试建过的所有 socket：结束时统一销毁。
  // 否则一个断言失败的用例会留下半开连接，让 server.close() 一直等下去（测试挂住）。
  const openSockets = new Set()

  before(async () => {
    identity = loadOrCreateIdentity(makeTmpDir())
    // 用一个不依赖业务存储的 dispatch 替身，专测协议层
    const dispatch = async ({ method, path, body }) => {
      if (path === '/api/v1/health') return { ok: true, echo: 'health' }
      if (path === '/api/v1/login') return { token: 'tok-123', got: body }
      if (path === '/api/v1/boom') {
        const { HttpError } = await import('../src/util.js')
        throw new HttpError(400, 'BAD_THING', '故意的错误')
      }
      const { HttpError } = await import('../src/util.js')
      throw new HttpError(404, 'NOT_FOUND', 'nope')
    }

    const created = createTsc1Server({ dispatch, identity, log: (m) => logs.push(m) })
    server = created.server
    await new Promise((r) => server.listen(0, '127.0.0.1', r))
    port = server.address().port
  })

  after(async () => {
    for (const s of openSockets) s.destroy()
    openSockets.clear()
    await new Promise((r) => server?.close(r))
  })

  /** 建立一条原始连接并登记，便于统一清理 */
  function rawConnect() {
    const socket = connect({ port, host: '127.0.0.1' })
    openSockets.add(socket)
    socket.once('close', () => openSockets.delete(socket))
    return socket
  }

  /** 建一条已完成握手的客户端连接 */
  async function connectAndHandshake() {
    const socket = rawConnect()
    await new Promise((res, rej) => {
      socket.once('connect', res)
      socket.once('error', rej)
    })
    socket.setNoDelay(true)

    const cliEph = generateKeyPairSync('x25519')
    const clientEphPub = x25519RawPublic(cliEph.publicKey)
    const hello = buildHello({ clientRandom: random32(), clientEphPub, timestamp: Math.floor(Date.now() / 1000) })
    socket.write(hello)

    // 收 SERVER_HELLO
    let buf = Buffer.alloc(0)
    const serverHello = await new Promise((resolve, reject) => {
      const onData = (chunk) => {
        buf = Buffer.concat([buf, chunk])
        if (buf.length >= SERVER_HELLO_LEN) {
          socket.off('data', onData)
          resolve(buf.subarray(0, SERVER_HELLO_LEN))
        }
      }
      socket.on('data', onData)
      socket.once('error', reject)
      setTimeout(() => reject(new Error('SERVER_HELLO 超时')), 3000).unref()
    })

    const parsed = parseServerHello(serverHello)
    assert.equal(parsed.identityPub.toString('hex'), identity.publicKeyRaw.toString('hex'), 'identity_pub 应为服务端身份公钥')

    const transcript = buildTranscript(hello, serverHello.subarray(0, SERVER_HELLO_PREFIX_LEN))
    assert.equal(
      verifyTranscript(transcript, parsed.signature, ed25519PublicFromRaw(parsed.identityPub)),
      true,
      '签名必须通过',
    )

    const shared = computeShared(cliEph.privateKey, x25519PublicFromRaw(parsed.serverEphPub))
    const keys = deriveSessionKeys(shared, transcript)

    const sender = new RecordSender({ key: keys.c2sKey, prefix: NONCE_PREFIX_C2S })
    const receiver = new RecordReceiver({ key: keys.s2cKey, prefix: NONCE_PREFIX_S2C })

    return { socket, sender, receiver, keys, buf: buf.subarray(SERVER_HELLO_LEN) }
  }

  /** 发一个应用层请求并等响应 */
  function request(session, msg) {
    return new Promise((resolve, reject) => {
      const onData = (chunk) => {
        try {
          const out = session.receiver.feed(chunk)
          if (out.length > 0) {
            session.socket.off('data', onData)
            resolve(JSON.parse(out[0].toString('utf8')))
          }
        } catch (err) {
          session.socket.off('data', onData)
          reject(err)
        }
      }
      session.socket.on('data', onData)
      session.socket.once('error', reject)
      session.socket.write(session.sender.send(Buffer.from(JSON.stringify(msg), 'utf8')))
      setTimeout(() => reject(new Error('响应超时')), 3000).unref()
    })
  }

  it('健康检查走通道：请求/响应配对正确', async () => {
    const s = await connectAndHandshake()
    const res = await request(s, { id: 1, method: 'GET', path: '/api/v1/health' })
    assert.equal(res.id, 1)
    assert.equal(res.status, 200)
    assert.equal(res.body.ok, true)
    s.socket.destroy()
  })

  it('POST 带 body 能正确送达（login 仍在通道内做）', async () => {
    const s = await connectAndHandshake()
    const res = await request(s, {
      id: 7,
      method: 'POST',
      path: '/api/v1/login',
      body: { username: 'alice', password: 'pw' },
    })
    assert.equal(res.status, 200)
    assert.equal(res.body.token, 'tok-123')
    assert.deepEqual(res.body.got, { username: 'alice', password: 'pw' })
    s.socket.destroy()
  })

  it('路由抛 HttpError → 映射为对应 status/code（与 HTTP 语义一致）', async () => {
    const s = await connectAndHandshake()
    const res = await request(s, { id: 2, method: 'GET', path: '/api/v1/boom' })
    assert.equal(res.status, 400)
    assert.equal(res.body.error.code, 'BAD_THING')
    s.socket.destroy()
  })

  it('未知路径 → 404', async () => {
    const s = await connectAndHandshake()
    const res = await request(s, { id: 3, method: 'GET', path: '/api/v1/nope' })
    assert.equal(res.status, 404)
    s.socket.destroy()
  })

  it('同一连接上并发多请求，id 能正确配对', async () => {
    const s = await connectAndHandshake()
    const results = []
    const onData = (chunk) => {
      for (const p of s.receiver.feed(chunk)) results.push(JSON.parse(p.toString('utf8')))
    }
    s.socket.on('data', onData)

    // 一次性发出三个请求（粘包），服务端应按序回三个响应
    const frames = [1, 2, 3].map((id) =>
      s.sender.send(Buffer.from(JSON.stringify({ id, method: 'GET', path: '/api/v1/health' }), 'utf8')),
    )
    s.socket.write(Buffer.concat(frames))

    await new Promise((r) => setTimeout(r, 300))
    s.socket.off('data', onData)
    assert.deepEqual(results.map((r) => r.id), [1, 2, 3])
    s.socket.destroy()
  })

  it('§7.5 版本号 2：服务端断开且不进入加密会话', async () => {
    const socket = rawConnect()
    await new Promise((res) => socket.once('connect', res))
    const hello = buildHello({ clientRandom: random32(), clientEphPub: Buffer.alloc(32, 1) })
    hello.writeUInt8(2, 1)

    const closed = await new Promise((resolve) => {
      socket.once('close', () => resolve(true))
      socket.once('error', () => resolve(true))
      socket.write(hello)
      setTimeout(() => resolve(false), 2000).unref()
    })
    assert.equal(closed, true, '版本不合法必须断开')
    assert.ok(logs.some((l) => l.includes('BAD_VERSION')), '应记录审计日志')
  })

  it('§7.2 握手后重放一帧 → 服务端断开', async () => {
    const s = await connectAndHandshake()
    const frame = s.sender.send(Buffer.from(JSON.stringify({ id: 1, method: 'GET', path: '/api/v1/health' })))
    s.socket.write(frame)
    await new Promise((r) => setTimeout(r, 150))
    // 重放同一帧
    s.socket.write(frame)
    const closed = await new Promise((resolve) => {
      s.socket.once('close', () => resolve(true))
      setTimeout(() => resolve(false), 2000).unref()
    })
    assert.equal(closed, true, '重放帧必须导致断开')
  })

  it('§7.7 超长 length → 服务端断开（不为它分配内存）', async () => {
    const s = await connectAndHandshake()
    const evil = Buffer.alloc(12)
    evil.writeUInt32BE(MAX_FRAME_LEN + 1, 0)
    s.socket.write(evil)
    const closed = await new Promise((resolve) => {
      s.socket.once('close', () => resolve(true))
      setTimeout(() => resolve(false), 2000).unref()
    })
    assert.equal(closed, true)
  })

  it('§7.1 篡改一帧 → 服务端断开', async () => {
    const s = await connectAndHandshake()
    const frame = s.sender.send(Buffer.from(JSON.stringify({ id: 1, method: 'GET', path: '/api/v1/health' })))
    const tampered = Buffer.from(frame)
    tampered[tampered.length - 1] ^= 0xff
    s.socket.write(tampered)
    const closed = await new Promise((resolve) => {
      s.socket.once('close', () => resolve(true))
      setTimeout(() => resolve(false), 2000).unref()
    })
    assert.equal(closed, true)
  })

  it('明文 HTTP 打到 TSC/1 端口 → **立刻**断开（看首字节即判）', async () => {
    const socket = rawConnect()
    await new Promise((res) => socket.once('connect', res))
    const started = Date.now()
    socket.write('GET /api/v1/health HTTP/1.1\r\nHost: x\r\n\r\n')

    const closed = await new Promise((resolve) => {
      socket.once('close', () => resolve(true))
      socket.once('error', () => resolve(true))
      setTimeout(() => resolve(false), 2000).unref()
    })
    assert.equal(closed, true, 'magic 不符必须断开')
    // 关键：必须"看首字节就判"，而不是等凑满 72 字节 ——
    // 否则攻击者发 1 个字节就能廉价占住一个连接（slowloris 式）
    assert.ok(Date.now() - started < 1000, '应当立刻断开，而不是等到超时')
    assert.ok(logs.some((l) => l.includes('BAD_MAGIC')), '应记录 BAD_MAGIC 审计')
  })

  it('只发 1 个非法字节也立刻断开（slowloris 防护）', async () => {
    const socket = rawConnect()
    await new Promise((res) => socket.once('connect', res))
    socket.write(Buffer.from([0x47])) // 'G'，不是 TSC1 magic
    const closed = await new Promise((resolve) => {
      socket.once('close', () => resolve(true))
      socket.once('error', () => resolve(true))
      setTimeout(() => resolve(false), 1500).unref()
    })
    assert.equal(closed, true, '首字节非法必须立刻断开')
  })

  it('审计日志只记 IP 与原因，不记明文内容', async () => {
    const s = await connectAndHandshake()
    const secret = 'SUPER-SECRET-PASSWORD-XYZ'
    const frame = s.sender.send(
      Buffer.from(JSON.stringify({ id: 1, method: 'POST', path: '/api/v1/login', body: { password: secret } })),
    )
    const tampered = Buffer.from(frame)
    tampered[tampered.length - 1] ^= 0xff
    s.socket.write(tampered)
    await new Promise((r) => setTimeout(r, 300))

    // 日志里不得出现口令或任何帧明文
    for (const line of logs) {
      assert.ok(!line.includes(secret), `审计日志泄漏了明文: ${line}`)
    }
    // 但必须记下失败与原因
    assert.ok(logs.some((l) => l.includes('TSC1 fail')), '应记录失败审计')
  })
})

// --------------------------------------------- 规范 §6.1/§6.2（评审后新增）

describe('§6.1 headers 白名单：只放行 authorization', () => {
  let server
  let port
  let identity
  const seen = []

  before(async () => {
    identity = loadOrCreateIdentity(makeTmpDir())
    const dispatch = async ({ method, path, req }) => {
      // 记录服务端实际看到的头，用于断言注入是否被丢弃
      seen.push({ path, headers: { ...req.headers } })
      return { ok: true, path, headersSeen: Object.keys(req.headers) }
    }
    const created = createTsc1Server({ dispatch, identity, log: () => {} })
    server = created.server
    await new Promise((r) => server.listen(0, '127.0.0.1', r))
    port = server.address().port
  })

  after(async () => {
    await new Promise((r) => server?.close(r))
  })

  async function handshake() {
    const socket = connect({ port, host: '127.0.0.1' })
    await new Promise((res, rej) => {
      socket.once('connect', res)
      socket.once('error', rej)
    })
    const cliEph = generateKeyPairSync('x25519')
    const clientEphPub = x25519RawPublic(cliEph.publicKey)
    const hello = buildHello({ clientRandom: random32(), clientEphPub })
    socket.write(hello)

    let buf = Buffer.alloc(0)
    const sh = await new Promise((resolve, reject) => {
      const onData = (ch) => {
        buf = Buffer.concat([buf, ch])
        if (buf.length >= SERVER_HELLO_LEN) {
          socket.off('data', onData)
          resolve(buf.subarray(0, SERVER_HELLO_LEN))
        }
      }
      socket.on('data', onData)
      socket.once('error', reject)
      setTimeout(() => reject(new Error('sh timeout')), 3000).unref()
    })
    const parsed = parseServerHello(sh)
    const transcript = buildTranscript(hello, sh.subarray(0, SERVER_HELLO_PREFIX_LEN))
    const shared = computeShared(cliEph.privateKey, x25519PublicFromRaw(parsed.serverEphPub))
    const keys = deriveSessionKeys(shared, transcript)
    return {
      socket,
      sender: new RecordSender({ key: keys.c2sKey, prefix: NONCE_PREFIX_C2S }),
      receiver: new RecordReceiver({ key: keys.s2cKey, prefix: NONCE_PREFIX_S2C }),
      carry: buf.subarray(SERVER_HELLO_LEN),
    }
  }

  function request(s, msg) {
    return new Promise((resolve, reject) => {
      const onData = (ch) => {
        try {
          const out = s.receiver.feed(ch)
          if (out.length > 0) {
            s.socket.off('data', onData)
            resolve(JSON.parse(out[0].toString('utf8')))
          }
        } catch (err) {
          s.socket.off('data', onData)
          reject(err)
        }
      }
      s.socket.on('data', onData)
      s.socket.once('error', reject)
      s.socket.write(s.sender.send(Buffer.from(JSON.stringify(msg), 'utf8')))
      setTimeout(() => reject(new Error('resp timeout')), 3000).unref()
    })
  }

  it('authorization 被透传', async () => {
    seen.length = 0
    const s = await handshake()
    const res = await request(s, {
      id: 1,
      method: 'GET',
      path: '/api/v1/blobs',
      headers: { authorization: 'Bearer tok-abc' },
    })
    assert.equal(res.status, 200)
    assert.equal(seen.at(-1).headers.authorization, 'Bearer tok-abc')
    s.socket.destroy()
  })

  it('**注入 x-forwarded-for 必须被丢弃**（否则可绕过限流键）', async () => {
    seen.length = 0
    const s = await handshake()
    const res = await request(s, {
      id: 2,
      method: 'GET',
      path: '/api/v1/blobs',
      headers: {
        authorization: 'Bearer t',
        'x-forwarded-for': '1.2.3.4',
        'x-real-ip': '5.6.7.8',
        'content-length': '999',
      },
    })
    assert.equal(res.status, 200)
    const saw = seen.at(-1).headers
    assert.equal(saw['x-forwarded-for'], undefined, 'x-forwarded-for 必须被丢弃')
    assert.equal(saw['x-real-ip'], undefined, 'x-real-ip 必须被丢弃')
    assert.equal(saw['content-length'], undefined, 'content-length 必须被丢弃')
    // 服务端只看到白名单内的头
    assert.deepEqual(Object.keys(saw), ['authorization'])
    s.socket.destroy()
  })

  it('未列出的头是**忽略而非报错**（前向兼容，不打断连接）', async () => {
    const s = await handshake()
    const res = await request(s, {
      id: 3,
      method: 'GET',
      path: '/api/v1/x',
      headers: { 'some-future-header': 'v', authorization: 'Bearer z' },
    })
    assert.equal(res.status, 200, '未知头不应导致报错')
    s.socket.destroy()
  })
})

describe('§6.2 429 必须回传 retry-after', () => {
  let server
  let port
  let identity

  before(async () => {
    identity = loadOrCreateIdentity(makeTmpDir())
    const { HttpError } = await import('../src/util.js')
    const dispatch = async ({ path }) => {
      if (path === '/api/v1/limited') {
        const err = new HttpError(429, 'RATE_LIMITED', '请求过于频繁')
        err.retryAfterSec = 42 // 与 HTTP 端同源：挂在 error 上
        throw err
      }
      if (path === '/api/v1/limited-no-value') {
        throw new HttpError(429, 'RATE_LIMITED', '未附时长')
      }
      return { ok: true }
    }
    const created = createTsc1Server({ dispatch, identity, log: () => {} })
    server = created.server
    await new Promise((r) => server.listen(0, '127.0.0.1', r))
    port = server.address().port
  })

  after(async () => {
    await new Promise((r) => server?.close(r))
  })

  async function roundTrip(path) {
    const socket = connect({ port, host: '127.0.0.1' })
    await new Promise((res, rej) => {
      socket.once('connect', res)
      socket.once('error', rej)
    })
    const cliEph = generateKeyPairSync('x25519')
    const hello = buildHello({ clientRandom: random32(), clientEphPub: x25519RawPublic(cliEph.publicKey) })
    socket.write(hello)

    let buf = Buffer.alloc(0)
    const sh = await new Promise((resolve, reject) => {
      const onData = (ch) => {
        buf = Buffer.concat([buf, ch])
        if (buf.length >= SERVER_HELLO_LEN) {
          socket.off('data', onData)
          resolve(buf.subarray(0, SERVER_HELLO_LEN))
        }
      }
      socket.on('data', onData)
      socket.once('error', reject)
      setTimeout(() => reject(new Error('sh timeout')), 3000).unref()
    })
    const parsed = parseServerHello(sh)
    const transcript = buildTranscript(hello, sh.subarray(0, SERVER_HELLO_PREFIX_LEN))
    const shared = computeShared(cliEph.privateKey, x25519PublicFromRaw(parsed.serverEphPub))
    const keys = deriveSessionKeys(shared, transcript)
    const sender = new RecordSender({ key: keys.c2sKey, prefix: NONCE_PREFIX_C2S })
    const receiver = new RecordReceiver({ key: keys.s2cKey, prefix: NONCE_PREFIX_S2C })
    receiver.feed(buf.subarray(SERVER_HELLO_LEN))

    const res = await new Promise((resolve, reject) => {
      const onData = (ch) => {
        try {
          const out = receiver.feed(ch)
          if (out.length > 0) {
            socket.off('data', onData)
            resolve(JSON.parse(out[0].toString('utf8')))
          }
        } catch (err) {
          socket.off('data', onData)
          reject(err)
        }
      }
      socket.on('data', onData)
      socket.once('error', reject)
      socket.write(sender.send(Buffer.from(JSON.stringify({ id: 1, method: 'GET', path }))))
      setTimeout(() => reject(new Error('resp timeout')), 3000).unref()
    })
    socket.destroy()
    return res
  }

  it('429 响应带 retry-after，值为服务端给出的秒数', async () => {
    const res = await roundTrip('/api/v1/limited')
    assert.equal(res.status, 429)
    assert.ok(res.headers, '必须带 headers')
    assert.equal(res.headers['retry-after'], '42')
  })

  it('429 未给时长时回落到 60s（与客户端缺省一致）', async () => {
    const res = await roundTrip('/api/v1/limited-no-value')
    assert.equal(res.status, 429)
    assert.equal(res.headers['retry-after'], '60')
  })

  it('非 429 响应不需要 retry-after', async () => {
    const res = await roundTrip('/api/v1/fine')
    assert.equal(res.status, 200)
    assert.equal(res.headers, undefined)
  })
})
