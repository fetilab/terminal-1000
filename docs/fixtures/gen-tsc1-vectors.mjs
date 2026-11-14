// TSC/1 冻结测试向量生成器（确定性：所有输入钉死）
// 用法：node docs/fixtures/gen-tsc1-vectors.mjs > docs/fixtures/tsc1-vectors.json
// ⚠️ 生成后**冻结**：两侧实现都对照它断言。改协议才重新生成。
import { createPrivateKey, createPublicKey, diffieHellman, sign, hkdfSync, createHash, createCipheriv } from 'node:crypto'

const b64u = (b) => Buffer.from(b).toString('base64url')
const seed = (n) => Buffer.alloc(32, n)

function x25519FromSeed(n) {
  const d = seed(n)
  const priv = createPrivateKey({
    key: Buffer.concat([Buffer.from('302e020100300506032b656e04220420', 'hex'), d]),
    format: 'der', type: 'pkcs8',
  })
  return { d, priv, x: Buffer.from(createPublicKey(priv).export({ format: 'jwk' }).x, 'base64url') }
}
function ed25519FromSeed(n) {
  const priv = createPrivateKey({
    key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed(n)]),
    format: 'der', type: 'pkcs8',
  })
  return { priv, pub: Buffer.from(createPublicKey(priv).export({ format: 'jwk' }).x, 'base64url') }
}

const clientEph = x25519FromSeed(0x11)
const serverEph = x25519FromSeed(0x22)
const serverId = ed25519FromSeed(0x33)
const clientRandom = seed(0x44)
const serverRandom = seed(0x55)

// HELLO: 1+1+2+4+32+32 = 72
const hello = Buffer.alloc(72)
hello[0] = 0x54; hello[1] = 1; hello.writeUInt16BE(0, 2); hello.writeUInt32BE(1700000000, 4)
clientRandom.copy(hello, 8); clientEph.x.copy(hello, 40)

// SERVER_HELLO 前缀: 1+1+2+32+32+32 = 100（含 identity_pub），签名 64 → 总 164
const prefix = Buffer.alloc(100)
prefix[0] = 0x54; prefix[1] = 1; prefix.writeUInt16BE(0, 2)
serverRandom.copy(prefix, 4); serverEph.x.copy(prefix, 36); serverId.pub.copy(prefix, 68)

const transcript = Buffer.concat([hello, prefix])
const transcriptHash = createHash('sha256').update(transcript).digest()
const signedDigest = createHash('sha256').update('TSC/1 server-hello').update(transcript).digest()
const signature = sign(null, signedDigest, serverId.priv)

const shared = diffieHellman({ privateKey: clientEph.priv, publicKey: serverEph.priv })
const derive = (info) => Buffer.from(hkdfSync('sha256', shared, transcriptHash, Buffer.from(info), 32))
const c2sKey = derive('TSC/1 c2s'); const s2cKey = derive('TSC/1 s2c')

// 帧: [u32 len][u64 seq] + nonce(12, 含 4 字节方向前缀) + ct + tag(16)
function frame(key, dirPrefix, seq, plaintext) {
  const nonce = Buffer.alloc(12)
  const p = Buffer.alloc(4); p.writeUInt32BE(dirPrefix, 0); nonce.set(p, 0)
  const s = Buffer.alloc(8); s.writeBigUInt64BE(BigInt(seq), 0); nonce.set(s, 4)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const body = Buffer.concat([nonce, ct, cipher.getAuthTag()])
  const head = Buffer.alloc(12); head.writeUInt32BE(body.length, 0); head.writeBigUInt64BE(BigInt(seq), 4)
  return Buffer.concat([head, body])
}

console.log(JSON.stringify({
  _note: 'TSC/1 固定测试向量（v2：SERVER_HELLO 含 identity_pub）。两侧实现必须得到完全相同的值。冻结，勿手改。',
  protocol: 'TSC/1',
  layout: { helloLen: 72, serverHelloPrefixLen: 100, serverHelloLen: 164, sigOffset: 100, identityPubOffset: 68 },
  inputs: {
    clientRandomHex: clientRandom.toString('hex'),
    serverRandomHex: serverRandom.toString('hex'),
    clientEphPrivHex: clientEph.d.toString('hex'),
    clientEphPubHex: clientEph.x.toString('hex'),
    serverEphPrivHex: serverEph.d.toString('hex'),
    serverEphPubHex: serverEph.x.toString('hex'),
    serverIdentitySeedByte: 0x33,
    serverIdentityPubHex: serverId.pub.toString('hex'),
    helloHex: hello.toString('hex'),
    serverHelloPrefixHex: prefix.toString('hex'),
  },
  expected: {
    transcriptSha256Hex: transcriptHash.toString('hex'),
    signedDigestHex: signedDigest.toString('hex'),
    signatureHex: signature.toString('hex'),
    sharedSecretHex: shared.toString('hex'),
    c2sKeyHex: c2sKey.toString('hex'),
    s2cKeyHex: s2cKey.toString('hex'),
    firstFrameC2sHex: frame(c2sKey, 1, 0, Buffer.from('hello')).toString('hex'),
    firstFrameS2cHex: frame(s2cKey, 2, 0, Buffer.from('world')).toString('hex'),
  },
  fingerprint: createHash('sha256').update(serverId.pub).digest('hex').slice(0, 32),
}, null, 2))
