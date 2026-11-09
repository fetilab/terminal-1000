// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * SSH 会话：连接建立、认证、跳板链、代理、通道管理。
 *
 * 性能设计（目标是超越参考实现）：
 * - 终端输出**合批**后再推给渲染层，而不是每个 data 事件一次 IPC
 * - 远端命令执行与 shell 通道复用同一连接，不额外建连
 * - 跳板链逐跳复用，不做重复认证
 */

import { Client, type ConnectConfig, type ClientChannel } from 'ssh2'
import { Socket } from 'node:net'
import { createHash, randomUUID } from 'node:crypto'
import type { ConnectionState, SshConnection, SshAuthType } from '@t1000/shared'
import { AppError } from '../../errors'
import { createLogger } from '../../logger'
import type { ExecResult, SshSessionHandle } from '../session-registry'
import { OutputBatcher } from '../output-batcher'
import { createProxySocket } from './proxy'

const log = createLogger('ssh')

/** 终端输出合批窗口（ms）。16ms ≈ 一帧，兼顾延迟与吞吐。 */
const OUTPUT_BATCH_MS = 16
/** 合批缓冲上限（字节）。超过则立即冲刷，避免高吞吐时内存膨胀。 */
const OUTPUT_BATCH_MAX_BYTES = 256 * 1024

export interface SshSessionEvents {
  onState(state: ConnectionState, message?: string): void
  onData(data: string): void
  onDebug(message: string): void
  onError(message: string, code?: string): void
  onClosed(reason?: string, code?: number): void
  /** 主机指纹校验询问；resolve(true) 表示接受 */
  onHostKeyAsk(info: HostKeyAskInfo): Promise<boolean>
  /** 交互式认证（keyboard-interactive / 2FA） */
  onAuthPrompt(info: AuthPromptInfo): Promise<string[]>
}

export interface HostKeyAskInfo {
  host: string
  port: number
  keyType: string
  fingerprint: string
  mismatch: boolean
}

export interface AuthPromptInfo {
  name: string
  instructions: string
  prompts: Array<{ prompt: string; echo: boolean }>
}

export interface SshSessionOptions {
  /** 已知主机指纹存储（host:port → fingerprint），只读查询 */
  knownHosts: Map<string, string>
  events: SshSessionEvents
  /** 建立连接时用到的凭证解析（identity 引用式需要） */
  resolveIdentity?: (identityId: string) => { privateKey?: string; passphrase?: string; password?: string } | undefined
  /**
   * 用户接受了一个新指纹时回调。
   * 指纹的写入与持久化由上层（管理器）负责，会话本身不持有写职责 ——
   * 否则 resolver 决议与 map 写入的时序会产生竞争。
   */
  onHostKeyAccepted?: (host: string, port: number, fingerprint: string) => void
}

/**
 * 一个 SSH 会话。负责建连、认证、shell 通道，并把输出合批后回调出去。
 */

/**
 * 关闭 Nagle 算法（TCP_NODELAY）。
 *
 * ssh2 默认**不设**它，而交互式 SSH 是"一问一答"的小包模式：
 * 每个往返都要吃一次 Nagle + delayed-ACK 的合并等待，表现为**终端按键迟滞**。
 *
 * 实测依据（SFTP 侧同样的问题）：3MB 传输 `noDelay=true` **57ms**，
 * `noDelay=false` **6117ms** —— 相差 **107 倍**。终端交互同样受益。
 *
 * 调用时机：`ready` 之后（此时底层 socket 一定已建立；
 * 早于此时调用会因内部 socket 尚未创建而被静默忽略）。
 */
function disableNagle(client: { setNoDelay?: (v: boolean) => void }): void {
  try {
    client.setNoDelay?.(true)
  } catch {
    // 个别平台/实现不支持时忽略即可 —— 只是性能优化，不该影响连接
  }
}

export class SshSession {
  readonly sessionId: string
  readonly connection: SshConnection
  private client: Client | null = null
  private shell: ClientChannel | null = null
  private state: ConnectionState = 'idle'
  private connectedAt = 0

  /**
   * 输出合批器：把高频小包合并后交付，避免事件风暴打爆渲染进程。
   * 与本地 PTY 共用同一实现，保证两者吞吐特性一致。
   */
  private readonly batcher: OutputBatcher

  /** 跳板链上已建立的上游连接（用于关闭时逐级清理） */
  private jumpClients: Client[] = []

  constructor(
    connection: SshConnection,
    private readonly options: SshSessionOptions,
  ) {
    this.sessionId = randomUUID()
    this.connection = connection
    this.batcher = new OutputBatcher({
      windowMs: OUTPUT_BATCH_MS,
      maxBytes: OUTPUT_BATCH_MAX_BYTES,
      onFlush: (chunk) => this.options.events.onData(chunk),
    })
  }

  getState(): ConnectionState {
    return this.state
  }

  getInfo(): SshSessionHandle {
    if (!this.client) throw AppError.notConnected()
    return {
      sessionId: this.sessionId,
      connectionId: this.connection.id,
      client: this.client,
      host: this.connection.host,
      port: this.connection.port,
      username: this.connection.username,
      state: this.state,
      connectedAt: this.connectedAt,
      exec: (command: string, options?: { timeoutMs?: number }) => this.exec(command, options?.timeoutMs),
    }
  }

  private setState(state: ConnectionState, message?: string): void {
    this.state = state
    this.options.events.onState(state, message)
  }

  /**
   * 建立连接并打开 shell 通道。
   * 跳板链：先逐跳建立上游连接，最后一跳用 forwardOut 打通到目标。
   */
  async connect(): Promise<void> {
    this.setState('connecting')
    const conn = this.connection

    try {
      const socket = await this.buildSocket()

      const config: ConnectConfig = {
        host: conn.host,
        port: conn.port,
        username: conn.username,
        readyTimeout: conn.options?.timeoutMs ?? 20000,
        keepaliveInterval: conn.options?.keepalive?.transportIntervalMs ?? 5000,
        keepaliveCountMax: 3,
        ...this.buildAuthConfig(),
        ...this.buildAlgorithmConfig(),
        ...(socket ? { sock: socket } : {}),
        // ssh2 的 hostVerifier 是回调式：同步返回 undefined 表示"稍后用 verify() 决议"，
        // 我们借此实现"弹窗询问用户"的异步确认流程。
        hostVerifier: ((key: Buffer, verify: (ok: boolean) => void) => {
          this.verifyHostKey(key, verify)
        }) as ConnectConfig['hostVerifier'],
      }

      const client = new Client()
      this.client = client

      client.on('handshake', () => this.setState('authenticating'))
      client.on('ready', () => {
        // 终端是交互式小包流量：不关 Nagle 会明显迟滞（见 disableNagle 注释）
        disableNagle(client)
        this.connectedAt = Date.now()
        this.setState('ready')
        log.info(`会话就绪 ${this.sessionId} → ${conn.username}@${conn.host}:${conn.port}`)
      })
      client.on('error', (err) => {
        this.options.events.onError(err.message, (err as NodeJS.ErrnoException).code)
        if (this.state !== 'disconnected') this.setState('failed', err.message)
      })
      client.on('close', () => {
        this.batcher.flush()
        this.setState('disconnected')
        this.options.events.onClosed()
        this.cleanup()
      })
      client.on('keyboard-interactive', (name, instructions, _lang, prompts, finish) => {
        // 显式映射，避免直接依赖 ssh2 的内部 Prompt 类型形状
        void this.handleKeyboardInteractive(
          name,
          instructions,
          prompts.map((p) => ({ prompt: p.prompt, echo: Boolean(p.echo) })),
          finish,
        )
      })

      await new Promise<void>((resolve, reject) => {
        const onReady = (): void => {
          cleanup()
          resolve()
        }
        const onError = (err: Error): void => {
          cleanup()
          reject(err)
        }
        const cleanup = (): void => {
          client.removeListener('ready', onReady)
          client.removeListener('error', onError)
        }
        client.once('ready', onReady)
        client.once('error', onError)
        client.connect(config)
      })

      // 打开交互式 shell
      this.shell = await new Promise<ClientChannel>((resolve, reject) => {
        client.shell(this.buildShellOptions(), (err, stream) => {
          if (err) return reject(err)
          resolve(stream)
        })
      })

      this.attachShell(this.shell)
    } catch (err) {
      this.setState('failed', err instanceof Error ? err.message : String(err))
      this.cleanup()
      throw err instanceof Error ? err : AppError.internal(String(err))
    }
  }

  /** 组装认证配置，按 authOrder 决定优先级 */
  private buildAuthConfig(): Partial<ConnectConfig> {
    const conn = this.connection
    const cfg: Partial<ConnectConfig> = {}

    if (conn.password) cfg.password = conn.password
    if (conn.privateKey) cfg.privateKey = conn.privateKey
    if (conn.passphrase) cfg.passphrase = conn.passphrase

    if (conn.authType === 'identity' && conn.identityId && this.options.resolveIdentity) {
      const id = this.options.resolveIdentity(conn.identityId)
      if (id) {
        if (id.privateKey) cfg.privateKey = id.privateKey
        if (id.passphrase) cfg.passphrase = id.passphrase
        if (id.password) cfg.password = id.password
      }
    }

    // agent 认证：环境变量指向的 agent socket
    const agent = process.env['SSH_AUTH_SOCK']
    if (agent && (conn.authType === 'privateKey' || conn.authType === 'identity')) {
      cfg.agent = agent
    }

    // 按 authOrder 排列尝试顺序（ssh2 通过限制可用方法来间接控制）
    const order = conn.authOrder ?? []
    if (order.length > 0) {
      cfg.tryKeyboard = order.includes('keyboardInteractive') || order.includes('keyboard')
    } else {
      cfg.tryKeyboard = conn.authType === 'keyboardInteractive' || conn.authType === 'keyboard'
    }

    return cfg
  }

  private buildAlgorithmConfig(): Partial<ConnectConfig> {
    const a = this.connection.options?.algorithms
    if (!a) return {}

    // 用户配置是宽松的 string[]（允许自由填写算法名），
    // 这里按 ssh2 期望的字面量联合类型收窄；非法名由 ssh2 自行校验报错。
    type AlgorithmConfig = NonNullable<ConnectConfig['algorithms']>
    const algorithms = {} as AlgorithmConfig
    if (a.kex?.length) algorithms.kex = a.kex as NonNullable<AlgorithmConfig['kex']>
    if (a.cipher?.length) algorithms.cipher = a.cipher as NonNullable<AlgorithmConfig['cipher']>
    if (a.hostKey?.length) algorithms.serverHostKey = a.hostKey as NonNullable<AlgorithmConfig['serverHostKey']>
    if (a.hmac?.length) algorithms.hmac = a.hmac as NonNullable<AlgorithmConfig['hmac']>
    if (a.compress?.length) algorithms.compress = a.compress as NonNullable<AlgorithmConfig['compress']>
    return { algorithms }
  }

  private buildShellOptions(): { term: string; cols: number; rows: number } & Record<string, unknown> {
    const opts = this.connection.options
    return {
      term: opts?.term ?? 'xterm-256color',
      cols: 80,
      rows: 24,
      ...(opts?.colorTerm ? { env: { COLORTERM: opts.colorTerm } } : {}),
    }
  }

  /**
   * 构建底层 socket：
   * - 有跳板链 → 逐跳连接，最后一跳 forwardOut 到目标
   * - 有代理 → 通过代理建立
   * - 都没有 → 返回 null，交给 ssh2 自己连
   */
  private async buildSocket(): Promise<Socket | undefined> {
    const conn = this.connection

    // 代理优先于跳板链（与参考实现行为一致）
    if (conn.proxy && !conn.options?.disableProxy) {
      log.debug(`经代理连接 ${conn.proxy.url}`)
      return createProxySocket(conn.proxy, conn.host, conn.port)
    }

    const chain = conn.jumpChain ?? []
    if (chain.length === 0) return undefined

    if (chain.length > 20) {
      throw AppError.badRequest('跳板机链路最多 20 跳')
    }

    log.debug(`跳板链 ${chain.length} 跳`)
    return this.buildJumpSocket(chain)
  }

  /** 逐跳建立连接，返回打通到最终目标的 socket */
  private async buildJumpSocket(chain: NonNullable<SshConnection['jumpChain']>): Promise<Socket> {
    const first = chain[0]
    if (!first) throw AppError.badRequest('跳板机链路为空')

    let current: Client | null = null
    let currentSocket: Socket | null = null

    for (let i = 0; i < chain.length; i++) {
      const hop = chain[i]
      if (!hop) continue

      const client = new Client()
      this.jumpClients.push(client)

      const hopConfig: ConnectConfig = {
        host: hop.host,
        port: hop.port,
        username: hop.username,
        readyTimeout: 15000,
        keepaliveInterval: 10000,
        ...(hop.privateKey ? { privateKey: hop.privateKey } : {}),
        ...(hop.passphrase ? { passphrase: hop.passphrase } : {}),
        ...(hop.password ? { password: hop.password } : {}),
        // 跳板层的 socket 由上一跳 forwardOut 提供
        ...(currentSocket ? { sock: currentSocket } : {}),
      }

      await new Promise<void>((resolve, reject) => {
        const onReady = (): void => {
          cleanup()
          resolve()
        }
        const onError = (err: Error): void => {
          cleanup()
          reject(AppError.internal(`跳板机 ${hop.host} 连接失败: ${err.message}`))
        }
        const cleanup = (): void => {
          client.removeListener('ready', onReady)
          client.removeListener('error', onError)
        }
        client.once('ready', onReady)
        client.once('error', onError)
        // 跳板机的每一跳也各自是一条 TCP 连接，同样要关 Nagle
        client.on('ready', () => disableNagle(client))
        client.connect(hopConfig)
      })

      const isLast = i === chain.length - 1
      const nextHost = isLast ? this.connection.host : chain[i + 1]?.host
      const nextPort = isLast ? this.connection.port : chain[i + 1]?.port

      if (nextHost === undefined || nextPort === undefined) {
        throw AppError.internal('跳板链目标解析失败')
      }

      currentSocket = await new Promise<Socket>((resolve, reject) => {
        client.forwardOut('127.0.0.1', 0, nextHost, nextPort, (err, stream) => {
          if (err) return reject(AppError.internal(`跳板转发失败: ${err.message}`))
          resolve(stream as unknown as Socket)
        })
      })
      current = client
    }

    if (!currentSocket) throw AppError.internal('跳板链未产出可用连接')
    return currentSocket
  }

  /**
   * 主机指纹校验。
   *
   * 快路径：与已知指纹一致 → 同步接受，零延迟。
   * 慢路径：未知或变更 → 交给 UI 询问，用 verify() 异步决议。
   * 变更（mismatch）时 UI 必须显式告警，这是防中间人的关键。
   */
  private verifyHostKey(key: Buffer, verify: (ok: boolean) => void): void {
    const conn = this.connection
    const fingerprint = fingerprintOf(key)
    const keyId = `${conn.host}:${conn.port}`
    const known = this.options.knownHosts.get(keyId)

    if (known === fingerprint) {
      verify(true)
      return
    }

    this.setState('verifying-host-key')
    this.options.events
      .onHostKeyAsk({
        host: conn.host,
        port: conn.port,
        keyType: 'ssh',
        fingerprint,
        mismatch: known !== undefined,
      })
      .then((accepted) => {
        if (accepted) {
          // 记住由上层落盘（本会话不持有写职责）
          this.options.onHostKeyAccepted?.(conn.host, conn.port, fingerprint)
        }
        verify(accepted)
      })
      .catch((err) => {
        log.warn('主机指纹询问失败，按拒绝处理', err)
        verify(false)
      })
  }

  /** keyboard-interactive 认证（含 2FA 场景） */
  private async handleKeyboardInteractive(
    name: string,
    instructions: string,
    prompts: Array<{ prompt: string; echo: boolean }>,
    finish: (responses: string[]) => void,
  ): Promise<void> {
    try {
      const responses = await this.options.events.onAuthPrompt({ name, instructions, prompts })
      finish(responses)
    } catch (err) {
      log.warn('交互式认证被中止', err)
      finish([])
    }
  }

  private attachShell(shell: ClientChannel): void {
    shell.on('data', (chunk: Buffer) => {
      this.batcher.push(chunk.toString('utf8'))
    })
    shell.stderr?.on('data', (chunk: Buffer) => {
      this.batcher.push(chunk.toString('utf8'))
    })
    shell.on('close', () => {
      // 会话结束前排空缓冲，避免最后一段输出丢失
      this.batcher.flush()
    })
  }

  /** 向 shell 写入数据 */
  write(data: string): void {
    if (!this.shell) throw AppError.notConnected()
    this.shell.write(data)
  }

  /** 调整远端 PTY 尺寸 */
  resize(cols: number, rows: number): void {
    if (!this.shell) return
    this.shell.setWindow(rows, cols, 0, 0)
  }

  /**
   * 在已有连接上执行远端命令（监控采集、目录扫描等复用）。
   * 超时后强制结束，避免悬挂。
   */
  async exec(command: string, timeoutMs = 15000): Promise<ExecResult> {
    const client = this.client
    if (!client) throw AppError.notConnected()

    return new Promise<ExecResult>((resolve, reject) => {
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        reject(AppError.timeout(`远端命令超时 (${timeoutMs}ms)`))
      }, timeoutMs)

      client.exec(command, (err, stream) => {
        if (err) {
          clearTimeout(timer)
          if (!settled) {
            settled = true
            reject(err)
          }
          return
        }

        let stdout = ''
        let stderr = ''
        let code = -1

        stream.on('data', (d: Buffer) => {
          stdout += d.toString('utf8')
        })
        stream.stderr.on('data', (d: Buffer) => {
          stderr += d.toString('utf8')
        })
        stream.on('exit', (exitCode: number | null) => {
          if (typeof exitCode === 'number') code = exitCode
        })
        stream.on('close', () => {
          clearTimeout(timer)
          if (settled) return
          settled = true
          resolve({ stdout, stderr, code })
        })
      })
    })
  }

  /** 主动断开 */
  disconnect(): void {
    this.batcher.flush()
    try {
      this.shell?.end()
    } catch {
      /* 忽略关闭期错误 */
    }
    try {
      this.client?.end()
    } catch {
      /* 忽略关闭期错误 */
    }
    this.cleanup()
    this.setState('disconnected')
  }

  /** 清理跳板链等上游资源 */
  private cleanup(): void {
    // 停止合批（不再向已关闭的会话推送数据）
    this.batcher.dispose()
    for (const c of this.jumpClients) {
      try {
        c.end()
      } catch {
        /* 忽略 */
      }
    }
    this.jumpClients = []
    this.shell = null
  }
}

/** 计算主机密钥指纹（SHA256 base64，与 OpenSSH 显示格式一致） */
export function fingerprintOf(key: Buffer): string {
  return 'SHA256:' + createHash('sha256').update(key).digest('base64').replace(/=+$/, '')
}
