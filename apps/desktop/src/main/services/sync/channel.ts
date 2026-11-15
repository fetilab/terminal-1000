// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * TSC/1 通道（客户端侧）：在一条 TCP 连接上完成握手，之后所有应用层消息走加密帧。
 *
 * 协议核在 `./protocol`（纯函数、有冻结向量对照）；这里只负责**连接、读写、配对**。
 *
 * 三条纪律（都是"错了会静默降级"的地方）：
 * 1. **握手任何一步失败就断开** —— 绝不重试成明文（TSC/1 与 HTTP 不能互相 fallback）
 * 2. **帧序号不连续就断开** —— 见 protocol 的 `open()`
 * 3. **钉扎不一致就断开** —— 由 `onPin` 决策；默认策略是"拒绝且不发送任何应用数据"
 */

import { connect, type Socket } from 'node:net'
import {
  HELLO_LEN,
  SERVER_HELLO_LEN,
  buildHello,
  fingerprintOf,
  generateEphemeral,
  ed25519PublicFromRaw,
  open as openFrame,
  parseServerHello,
  seal,
  takeFrame,
  verifyAndDerive,
  type DerivedKeys,
} from './protocol'

/** 单条连接的握手超时 */
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000
/** 单个请求的响应超时 */
const DEFAULT_REQUEST_TIMEOUT_MS = 20_000

export interface SecureChannelOptions {
  host: string
  port: number
  /** 已钉扎的指纹（hex，无空格）。未提供 = 首次连接（TOFU） */
  pinnedFingerprint?: string | undefined
  /**
   * 已钉扎的身份公钥（Ed25519，32 字节原始）。
   *
   * 指纹与公钥都要给：指纹用于**比对**（可读、可核对），公钥用于**验签**。
   * 分开传是刻意的 —— 免得有人以为"指纹对了就不用验签"。
   */
  pinnedPublicKey?: Buffer | undefined
  /**
   * 指纹决策回调。
   *
   * - `isNew=true`：首次连接（TOFU），返回 false 则不建立连接
   * - `isNew=false` 且 `fingerprint !== pinnedFingerprint`：**指纹变了**，
   *   返回 true 才继续（界面必须显著告警，措辞按"可能被中间人"来写）
   *
   * 默认实现：首次接受并记录；**指纹不一致一律拒绝**。
   */
  onPin?: (info: {
    fingerprint: string
    isNew: boolean
    pinned?: string | undefined
    /** 对端出示的公钥与钉扎的**字节**不一致（比指纹更严的一条判据） */
    keyMismatch?: boolean
  }) => boolean
  handshakeTimeoutMs?: number
  requestTimeoutMs?: number
}

export class SecureChannelError extends Error {
  constructor(
    message: string,
    readonly kind: 'connect' | 'handshake' | 'pin' | 'protocol' | 'timeout' | 'closed',
    /** kind 为 'pin' 时对端出示的指纹（32 位十六进制，无空格） */
    readonly fingerprint?: string,
    /**
     * kind 为 'pin' 且调用方**提供了钉扎**、但对端与之不符时为 true。
     *
     * 与"未钉扎"必须区分：前者可能是中间人，提示用户"核对后信任"等于邀请他信任错误的密钥。
     */
    readonly identityChanged?: boolean,
    /** identityChanged 为 true 时调用方记录的指纹 */
    readonly expectedFingerprint?: string,
  ) {
    super(message)
    this.name = 'SecureChannelError'
  }
}

interface Pending {
  resolve: (v: { status: number; body: unknown }) => void
  reject: (e: Error) => void
  timer: NodeJS.Timeout
}

export class SecureChannel {
  private socket: Socket
  private keys: DerivedKeys
  /** 本机（c2s）已发送的帧序号 */
  private sendSeq = 0n
  /** 对端（s2c）期望收到的下一个帧序号 */
  private recvSeq = 0n
  private readBuf: Buffer = Buffer.alloc(0)
  private pending = new Map<number, Pending>()
  private nextId = 1
  private closed = false
  /** 记录握手时对端出示的指纹，便于上层写入钉扎 */
  readonly peerFingerprint: string
  /** 对端出示的身份公钥（TOFU 确认后由上层存为钉扎；验签也正是用它） */
  readonly peerIdentityPub: Buffer

  private constructor(
    socket: Socket,
    keys: DerivedKeys,
    peerFingerprint: string,
    peerIdentityPub: Buffer,
  ) {
    this.socket = socket
    this.keys = keys
    this.peerFingerprint = peerFingerprint
    this.peerIdentityPub = peerIdentityPub
    socket.on('data', (chunk) => this.onData(chunk))
    socket.on('error', (err) => this.failAll(new SecureChannelError(`连接错误: ${err.message}`, 'connect')))
    socket.on('close', () => {
      this.closed = true
      this.failAll(new SecureChannelError('连接已关闭', 'closed'))
    })
  }

  /**
   * 建立连接并完成握手。
   *
   * **注意**：即使握手成功，服务端身份也可能只是"首次见到"（TOFU）。
   * 真正的信任来自用户带外核对指纹 —— 这个函数只能保证"与出示该指纹的对端
   * 完成了一次未被人篡改的密钥协商"。
   */
  static async connect(options: SecureChannelOptions): Promise<SecureChannel> {
    const handshakeTimeout = options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS
    const socket = await new Promise<Socket>((resolve, reject) => {
      const s = connect(options.port, options.host)
      const timer = setTimeout(() => {
        s.destroy()
        reject(new SecureChannelError(`连接 ${options.host}:${options.port} 超时`, 'timeout'))
      }, handshakeTimeout)
      s.once('connect', () => {
        clearTimeout(timer)
        resolve(s)
      })
      s.once('error', (err) => {
        clearTimeout(timer)
        reject(new SecureChannelError(`无法连接 ${options.host}:${options.port}: ${err.message}`, 'connect'))
      })
    })

    try {
      const ephemeral = generateEphemeral()
      const hello = buildHello(ephemeral.random, ephemeral.publicRaw)

      // 先发 HELLO，再收满 132 字节 SERVER_HELLO
      await new Promise<void>((resolve, reject) => {
        socket.write(hello, (err) => (err ? reject(err) : resolve()))
      })
      const serverHelloBytes = await readExactly(socket, SERVER_HELLO_LEN, handshakeTimeout)
      const serverHello = parseServerHello(serverHelloBytes)

      // v2：对端**必须**出示身份公钥（否则 TOFU 无从谈起 —— 见规范 §3.2）
      const presentedFp = fingerprintOf(serverHello.identityPub).replace(/ /g, '')
      const pinnedFp = options.pinnedFingerprint?.replace(/ /g, '')
      const decide = options.onPin ?? defaultPinDecision
      const isNew = pinnedFp === undefined

      // 钉扎比对：指纹与公钥字节都要比。
      // 验签使用对端出示的 identity_pub，签名有效仅说明对方持有该公钥的私钥，
      // 不足以确认它就是已钉扎的那一把。
      const keyMismatch =
        pinnedFp !== undefined &&
        options.pinnedPublicKey !== undefined &&
        !serverHello.identityPub.equals(options.pinnedPublicKey)
      const pinChanged = !isNew && (presentedFp !== pinnedFp || keyMismatch)
      if (pinChanged) {
        const allowed = decide({
          fingerprint: presentedFp,
          isNew: false,
          pinned: pinnedFp,
          keyMismatch,
        })
        if (!allowed) {
          throw new SecureChannelError(
            `服务端身份与已记录的不一致（可能被中间人）：\n  已记录指纹 ${pinnedFp}\n  本次指纹 ${presentedFp}` +
              (keyMismatch ? '\n  （公钥字节也不一致）' : ''),
            'pin',
            presentedFp,
            true,
            pinnedFp,
          )
        }
      } else if (isNew) {
        // 首次连接由 onPin 显式决定；默认策略拒绝（规范 §5）。
        const accepted = decide({ fingerprint: presentedFp, isNew: true })
        if (!accepted) {
          throw new SecureChannelError(
            `服务端首次连接（未钉扎）。指纹：${fingerprintOf(serverHello.identityPub)} —— 请核对后接受`,
            'pin',
            presentedFp,
          )
        }
        // 接受 TOFU：签名仍照验（证明对方持有该公钥的私钥），但**没有钉扎可比**
        // —— 这正是 TOFU 的边界，安全性来自用户对指纹的带外核对。
      }

      // 临时私钥到此为止：之后不再需要（前向保密）
      // 验签（用**对端出示的**身份公钥）：证明"对方持有该公钥对应的私钥"。
      // 它与上面的钉扎比对是**互补**的两步：签名防冒名，钉扎防换人。
      const keys = verifyAndDerive({
        hello,
        serverHello,
        clientEphPrivate: ephemeral.privateKey,
      })

      // 临时私钥到此为止：之后不再需要（前向保密）
      return new SecureChannel(socket, keys, presentedFp, serverHello.identityPub)
    } catch (err) {
      socket.destroy()
      if (err instanceof SecureChannelError) throw err
      throw new SecureChannelError(
        `握手失败：${err instanceof Error ? err.message : String(err)}`,
        'handshake',
      )
    }
  }

  /**
   * **探测**：连上去握手、拿到对端身份，但**不建立可用的长期通道**。
   *
   * 用途是信任引导（TOFU）——用户需要先看到指纹才能决定是否信任，
   * 而"看到指纹"本身就必须先连一次。探测完立即关闭，不发送任何应用数据。
   */
  static async probe(
    host: string,
    port: number,
    timeoutMs = DEFAULT_HANDSHAKE_TIMEOUT_MS,
  ): Promise<{ fingerprint: string; publicKey: Buffer }> {
    const ch = await SecureChannel.connect({
      host,
      port,
      handshakeTimeoutMs: timeoutMs,
      // 探测模式：接受首次连接（否则拿不到指纹），但**用完即关、不发数据**
      onPin: (info) => info.isNew,
    })
    const fps = ch.peerFingerprint
    const pub = Buffer.from(ch.peerIdentityPub)
    ch.close()
    return { fingerprint: fps, publicKey: pub }
  }

  /** 发一个请求并等响应；`id` 用于并发配对 */
  request(
    path: string,
    options: { method?: string; body?: unknown; token?: string } = {},
  ): Promise<{ status: number; body: unknown }> {
    if (this.closed) {
      return Promise.reject(new SecureChannelError('连接已关闭', 'closed'))
    }
    const id = this.nextId++
    // 规范 §6.1：应用层只识别 headers.authorization，服务端丢弃其余头。
    const payload = Buffer.from(
      JSON.stringify({
        id,
        method: options.method ?? 'GET',
        path,
        ...(options.token === undefined
          ? {}
          : { headers: { authorization: `Bearer ${options.token}` } }),
        ...(options.body === undefined ? {} : { body: options.body }),
      }),
      'utf8',
    )

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new SecureChannelError(`请求超时：${path}`, 'timeout'))
      }, DEFAULT_REQUEST_TIMEOUT_MS)
      this.pending.set(id, { resolve, reject, timer })
      try {
        this.writeFrame(payload)
      } catch (err) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })
  }

  close(): void {
    this.closed = true
    try {
      this.socket.end()
    } catch {
      /* 已关闭 */
    }
  }

  // ── 内部 ──────────────────────────────────────────

  private writeFrame(plaintext: Buffer): void {
    const frame = seal(this.keys.c2sKey, 'c2s', this.sendSeq, plaintext)
    this.sendSeq += 1n
    this.socket.write(frame)
  }

  private onData(chunk: Buffer): void {
    if (this.closed) return
    this.readBuf = Buffer.concat([this.readBuf, chunk])

    for (;;) {
      let taken: { frame: Buffer; rest: Buffer } | null
      try {
        taken = takeFrame(this.readBuf)
      } catch (err) {
        // 帧头声明的长度超限 —— 不分配内存，直接断开
        this.abort(new SecureChannelError(err instanceof Error ? err.message : String(err), 'protocol'))
        return
      }
      if (!taken) return
      this.readBuf = taken.rest

      let plaintext: Buffer
      try {
        plaintext = openFrame(this.keys.s2cKey, 's2c', this.recvSeq, taken.frame).plaintext
        this.recvSeq += 1n
      } catch (err) {
        // 解密失败/序号不连续 → **必须断开**。跳过或忽略等于接受了一个被篡改的流。
        this.abort(new SecureChannelError(`帧校验失败: ${err instanceof Error ? err.message : String(err)}`, 'protocol'))
        return
      }

      this.handleMessage(plaintext)
    }
  }

  private handleMessage(plaintext: Buffer): void {
    let msg: { id?: unknown; status?: unknown; body?: unknown }
    try {
      msg = JSON.parse(plaintext.toString('utf8')) as typeof msg
    } catch {
      this.abort(new SecureChannelError('收到非 JSON 的应用层消息', 'protocol'))
      return
    }
    if (typeof msg.id !== 'number') {
      this.abort(new SecureChannelError('响应缺少 id，无法与请求配对', 'protocol'))
      return
    }
    const p = this.pending.get(msg.id)
    if (!p) {
      // 未知 id：可能是重复响应。不致命，但记录后忽略（不能因为一个孤儿响应把连接打断）
      return
    }
    this.pending.delete(msg.id)
    clearTimeout(p.timer)
    p.resolve({ status: typeof msg.status === 'number' ? msg.status : 0, body: msg.body })
  }

  private abort(err: Error): void {
    this.closed = true
    this.failAll(err)
    try {
      this.socket.destroy()
    } catch {
      /* 已销毁 */
    }
  }

  private failAll(err: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer)
      p.reject(err)
    }
    this.pending.clear()
  }
}

/**
 * 默认钉扎策略：指纹或公钥字节任一项不符即拒绝，首次连接亦拒绝。
 *
 * 验签使用对端出示的公钥，签名有效不能确认它就是已钉扎的那一把，因此需比对公钥字节。
 * 首次连接由 onPin 显式接受（规范 §5）。
 */
function defaultPinDecision(info: {
  fingerprint: string
  isNew: boolean
  pinned?: string | undefined
  keyMismatch?: boolean
}): boolean {
  if (info.isNew) return false
  if (info.keyMismatch === true) return false
  return info.fingerprint === info.pinned
}

/** 从 socket 读满 n 字节（TCP 会分片，不能假设一次 read 就够） */
function readExactly(socket: Socket, n: number, timeoutMs: number): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    let buf = Buffer.alloc(0)
    const timer = setTimeout(() => {
      cleanup()
      reject(new SecureChannelError(`读取握手数据超时（已收到 ${buf.length}/${n} 字节）`, 'timeout'))
    }, timeoutMs)

    const onData = (chunk: Buffer): void => {
      buf = Buffer.concat([buf, chunk])
      if (buf.length >= n) {
        cleanup()
        // 多出来的字节交回 socket（理论上握手阶段不会有多余数据，但不要吞掉）
        if (buf.length > n) socket.unshift(buf.subarray(n))
        resolve(buf.subarray(0, n))
      }
    }
    const onErr = (err: Error): void => {
      cleanup()
      reject(new SecureChannelError(`握手期间连接出错: ${err.message}`, 'handshake'))
    }
    const cleanup = (): void => {
      clearTimeout(timer)
      socket.removeListener('data', onData)
      socket.removeListener('error', onErr)
    }
    socket.on('data', onData)
    socket.on('error', onErr)
  })
}

export { HELLO_LEN, SERVER_HELLO_LEN, ed25519PublicFromRaw }
