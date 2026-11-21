// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 远端监控代理的生命周期 + **经 SSH 隧道**的采集通道。
 *
 * ## 为什么是隧道，而不是再开一个端口
 * 代理只监听服务器上的 `127.0.0.1`，桌面端用 ssh2 的 `direct-tcpip`
 * （也就是 `ssh -L` 背后那条通道）连过去取数据。好处是：
 * - 服务器**不需要开放任何入站端口**，也不改防火墙；
 * - 鉴权沿用 SSH 本身，不用再维护一套代理的账号体系；
 * - 连接断开 → 隧道自然消失，不会留一个"谁都能连"的本地端口。
 *
 * ## 一次采集的耗时
 * - 脚本模式：每次 `exec` 一个 `sh`，重新读 /proc，速率靠两次采样 + 临时文件；
 * - 代理模式：一条 keep-alive 连接上的 `GET /metrics`，计数器在内存里，速率是真实增量。
 * 常驻通道 + 内存计数器是这个模块存在的全部理由。
 */

import type { Duplex } from 'node:stream'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { getSession, requireSession } from '../session-registry'
import {
  AGENT_DIR,
  AGENT_IDLE_SECONDS,
  AGENT_LOG_PATH,
  AGENT_STATE_PATH,
  AGENT_VERSION,
  AGENT_VERSION_PATH,
} from './agent-source'
import { readAgentBinary, resolveArch, type AgentArch } from './agent-binary'

/** 远端可执行文件（静态二进制，不依赖 python / glibc） */
export const AGENT_BIN_PATH = `${AGENT_DIR}/t1000-agent`
/** 上传中的临时名：写完再原子改名，避免远端跑到半个文件 */
const AGENT_UPLOAD_PATH = `${AGENT_BIN_PATH}.upload`

/** 探测/安装的超时 */
const PROBE_TIMEOUT_MS = 8_000
const INSTALL_TIMEOUT_MS = 20_000
/** 一次 /metrics 的超时（含代理内部 120ms 的 CPU 采样） */
const SAMPLE_TIMEOUT_MS = 6_000
/** /health 的超时：它必须快，否则会话断开的判定会拖住每一拍 */
const HEALTH_TIMEOUT_MS = 2_500

/** 探测结果缓存（避免每拍都 exec 一次） */
const PROBE_TTL_MS = 30_000
/** 判定"没有代理"后的静默期：这段时间内直接走脚本模式，不再探测 */
const UNAVAILABLE_TTL_MS = 60_000
/** 运行中的通道多久复查一次健康 */
const HEALTH_TTL_MS = 8_000

export type AgentDecision = 'installed' | 'declined' | 'never'

export interface AgentState {
  port: number
  pid: number
  token: string
  version: string
  startedAt?: number
}

export interface AgentProbe {
  /** 远端 `uname -m` 原样（amd64 / aarch64 / armv7l …） */
  machine: string | null
  /** 映射到内置产物后的架构；null = 这个架构没有随包提供 */
  arch: AgentArch | null
  /** 远端 $HOME：上传与启动都用它拼绝对路径 */
  home: string | null
  /** 二进制与 VERSION 都在 */
  installed: boolean
  version: string | null
  /** 代理自己写的状态文件（端口 / token / pid） */
  state: AgentState | null
  /** 用户上次的选择（用于决定要不要弹窗） */
  decision: AgentDecision | 'ask'
}

/* ── 远端命令 ───────────────────────────────────────────────────────────── */

/**
 * 探测命令：一次 exec 同时拿到 python 路径、已装版本、运行状态。
 * 旧脚本模式要 3 次往返，这里压成 1 次。
 */
export function agentProbeCommand(): string {
  return [
    `printf 'T1000_MACHINE:'; uname -m 2>/dev/null || printf 'unknown'; printf '\\n'`,
    `printf 'T1000_HOME:%s\\n' "$HOME"`,
    `printf 'T1000_VER:'; "${AGENT_BIN_PATH}" -version 2>/dev/null || cat "${AGENT_VERSION_PATH}" 2>/dev/null || printf 'none'; printf '\\n'`,
    `printf 'T1000_STATE:'; cat "${AGENT_STATE_PATH}" 2>/dev/null || printf '{}'; printf '\\n'`,
    `printf 'T1000_END\\n'`,
  ].join('\n')
}

/** 上传完成后的激活：加执行位 → 原子改名 → 写版本号 */
export function agentActivateCommand(): string {
  return [
    `chmod 700 "${AGENT_UPLOAD_PATH}" && mv -f "${AGENT_UPLOAD_PATH}" "${AGENT_BIN_PATH}"`,
    `printf '%s' '${AGENT_VERSION}' > "${AGENT_VERSION_PATH}"`,
    `printf 'T1000_AGENT_OK\\n'`,
  ].join('\n')
}

/**
 * 启动命令。
 *
 * 细节：
 * - `--port 0` 让内核挑端口，避免和服务器上的服务撞车；实际端口由代理写进状态文件。
 * - token 在服务器本地生成（`/dev/urandom`），**不经过命令行参数之外的任何地方**；
 *   状态文件 `0600`，同机其他用户读不到。
 * - 脱离会话：`setsid`（没有就 nohup），stdin 接 /dev/null，输出进日志。
 *   否则 SSH 通道一关，代理会被 SIGHUP 带走。
 * - 起来后轮询状态文件（最多 ~5s），把 JSON 直接带回来，省掉一次读文件往返。
 */
export function agentStartCommand(): string {
  return [
    `cd "${AGENT_DIR}" || { printf 'T1000_AGENT_ERR:no-dir\\n'; exit 0; }`,
    `rm -f agent-state.json`,
    `TOKEN=$(od -An -N16 -tx1 /dev/urandom 2>/dev/null | tr -d '[:space:]')`,
    `[ -n "$TOKEN" ] || TOKEN=$(date +%s 2>/dev/null)$RANDOM`,
    `if command -v setsid >/dev/null 2>&1; then`,
    `  setsid nohup ./t1000-agent -port 0 -state agent-state.json -token "$TOKEN" -idle ${AGENT_IDLE_SECONDS} > agent.log 2>&1 < /dev/null &`,
    `else`,
    `  nohup ./t1000-agent -port 0 -state agent-state.json -token "$TOKEN" -idle ${AGENT_IDLE_SECONDS} > agent.log 2>&1 < /dev/null &`,
    `fi`,
    `i=0`,
    `while [ $i -lt 25 ]; do [ -s agent-state.json ] && break; sleep 0.2 2>/dev/null || sleep 1; i=$((i+1)); done`,
    `cat agent-state.json 2>/dev/null || printf 'T1000_AGENT_ERR:no-state\\n'`,
  ].join('\n')
}

/** 停止（保留文件）；uninstall=true 时连文件一起删 */
export function agentStopCommand(pid: number, uninstall = false): string {
  const lines = [
    `kill ${pid} 2>/dev/null || true`,
    `rm -f "${AGENT_STATE_PATH}"`,
  ]
  if (uninstall) {
    lines.push(`rm -f "${AGENT_BIN_PATH}" "${AGENT_UPLOAD_PATH}" "${AGENT_VERSION_PATH}" "${AGENT_LOG_PATH}"`)
    lines.push(`rmdir "${AGENT_DIR}" 2>/dev/null || true`)
  }
  lines.push(`printf 'T1000_AGENT_STOPPED\\n'`)
  return lines.join('\n')
}

/** 单引号包裹，处理值里本身带单引号的情况 */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

export function parseProbe(stdout: string): Omit<AgentProbe, 'decision'> {
  const field = (prefix: string): string =>
    (stdout.split(/\r?\n/).find((l) => l.startsWith(prefix)) ?? '').slice(prefix.length).trim()

  const machine = field('T1000_MACHINE:') || null
  const home = field('T1000_HOME:') || null
  const versionRaw = field('T1000_VER:')
  const version = versionRaw && versionRaw !== 'none' ? versionRaw : null

  let state: AgentState | null = null
  const rawState = field('T1000_STATE:')
  if (rawState && rawState !== '{}') {
    try {
      const parsed = JSON.parse(rawState) as Partial<AgentState>
      if (
        typeof parsed.port === 'number' &&
        typeof parsed.pid === 'number' &&
        typeof parsed.token === 'string'
      ) {
        state = {
          port: parsed.port,
          pid: parsed.pid,
          token: parsed.token,
          version: typeof parsed.version === 'string' ? parsed.version : '',
          ...(typeof parsed.startedAt === 'number' ? { startedAt: parsed.startedAt } : {}),
        }
      }
    } catch {
      state = null
    }
  }

  return {
    machine,
    arch: resolveArch(machine),
    home,
    installed: version !== null,
    version,
    state,
  }
}

/* ── 隧道 HTTP 客户端 ───────────────────────────────────────────────────── */

export interface HttpResponse {
  status: number
  body: string
}

/**
 * 在一条流上跑 HTTP/1.1 keep-alive 的最小客户端。
 *
 * 只实现 GET + Content-Length 响应（代理就是这么回包的）。不引 node:http：
 * 它需要一个 socket 句柄，而 SSH 通道是 ssh2 的 Channel（Duplex），
 * 硬塞进去反而要伪造一堆事件。
 */
export class AgentHttp {
  private socket: Duplex | null = null
  private buffer = Buffer.alloc(0)
  private queue: Promise<unknown> = Promise.resolve()
  private closed = false
  /**
   * 当前等待响应的请求。
   *
   * ⚠️ 这里必须是**一个**当前请求，不能每个请求各挂一个 `data` 监听器：
   * keep-alive 下上一条请求的监听器不会自己消失，它会把下一条响应读走并
   * 消耗掉缓冲区，于是"第二次请求永远超时"——这个 bug 在单测里一跑就现形。
   */
  private pending: { onData: () => void; fail: (err: Error) => void } | null = null

  constructor(private readonly open: () => Promise<Duplex>) {}

  private async connected(): Promise<Duplex> {
    if (this.socket) return this.socket
    const sock = await this.open()
    this.socket = sock
    this.buffer = Buffer.alloc(0)
    sock.on('data', (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk])
      this.pending?.onData()
    })
    sock.on('close', () => {
      this.pending?.fail(new Error('代理通道已断开'))
      this.destroy()
    })
    sock.on('error', (err: Error) => {
      this.pending?.fail(err)
      this.destroy()
    })
    return sock
  }

  private destroy(): void {
    this.socket?.destroy()
    this.socket = null
    this.buffer = Buffer.alloc(0)
    this.pending = null
  }

  close(): void {
    this.closed = true
    this.destroy()
  }

  /** 串行执行：同一个通道上不并发请求（响应无法区分归属） */
  request(path: string, timeoutMs: number): Promise<HttpResponse> {
    const run = this.queue.then(() => this.doRequest(path, timeoutMs))
    this.queue = run.catch(() => undefined)
    return run
  }

  private async doRequest(path: string, timeoutMs: number): Promise<HttpResponse> {
    if (this.closed) throw new Error('通道已关闭')
    const sock = await this.connected()

    return new Promise<HttpResponse>((resolve, reject) => {
      let settled = false
      const entry = {
        onData: (): void => waitForResponse(),
        fail: (err: Error): void => finish(err),
      }
      const finish = (err: Error | null, value?: HttpResponse): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (this.pending === entry) this.pending = null
        if (err) {
          // 通道上的任何异常都按"这条连接不可再用"处理，下次请求重新建通道
          this.destroy()
          reject(err)
        } else if (value) {
          resolve(value)
        }
      }

      const timer = setTimeout(() => finish(new Error(`代理响应超时 (${timeoutMs}ms)`)), timeoutMs)

      const waitForResponse = (): void => {
        if (settled) return
        const sep = this.buffer.indexOf('\r\n\r\n')
        if (sep < 0) {
          if (this.buffer.length > 64 * 1024) finish(new Error('代理响应头过大'))
          return
        }
        const head = this.buffer.subarray(0, sep).toString('latin1')
        const lines = head.split('\r\n')
        const status = Number(lines[0]?.split(' ')[1] ?? 0)
        let length = 0
        for (const line of lines.slice(1)) {
          const idx = line.indexOf(':')
          if (idx < 0) continue
          if (line.slice(0, idx).trim().toLowerCase() === 'content-length') {
            length = Number(line.slice(idx + 1).trim())
          }
        }
        const bodyStart = sep + 4
        if (this.buffer.length < bodyStart + length) return

        const body = this.buffer.subarray(bodyStart, bodyStart + length).toString('utf8')
        // 保留多出来的字节：keep-alive 下一条响应可能已经贴在后面
        this.buffer = this.buffer.subarray(bodyStart + length)
        finish(null, { status, body })
      }

      this.pending = entry
      sock.write(
        `GET ${path} HTTP/1.1\r\n` +
          'Host: 127.0.0.1\r\n' +
          'Accept: application/json\r\n' +
          'Connection: keep-alive\r\n\r\n',
      )
      waitForResponse()
    })
  }
}

/* ── 每个会话的代理运行时 ───────────────────────────────────────────────── */

interface Runtime {
  sessionId: string
  port: number
  token: string
  pid: number
  client: AgentHttp
  version: string
  healthyAt: number
}

export interface AgentSampleOptions {
  processLimit: number
}

/**
 * 代理服务（单例）。
 *
 * 调用方只需要三个方法：
 * - `probe()`：给 UI 判断"要不要问用户装不装"；
 * - `install()`：安装并启动；
 * - `sample()`：拿一份 JSON（拿不到就返回 null，调用方回退脚本模式）。
 */
export class AgentService {
  private readonly runtimes = new Map<string, Runtime>()
  private readonly probeCache = new Map<string, { at: number; probe: Omit<AgentProbe, 'decision'> }>()
  private readonly blockedUntil = new Map<string, number>()

  constructor(
    private readonly exec: (
      sessionId: string,
      command: string,
      timeoutMs?: number,
    ) => Promise<{ stdout: string; stderr: string; code: number }>,
    private readonly prefs: AgentPrefs,
    /**
     * 把一段字节写到远端文件（实现走 SFTP）。
     * 为什么不用 base64 + heredoc：二进制 5MB，base64 后 7MB，
     * 远超命令行的 ARG_MAX（通常 2MB），根本传不过去。
     */
    private readonly putFile: (
      sessionId: string,
      remotePath: string,
      data: Buffer,
      mode: number,
    ) => Promise<void> = async () => {
      throw new Error('未提供文件上传通道')
    },
    private readonly now: () => number = Date.now,
    /** 建立隧道通道；单测注入直连（生产走 SSH direct-tcpip） */
    private readonly openChannel: (sessionId: string, port: number) => Promise<Duplex> = (sessionId, port) =>
      this.openTunnel(sessionId, port),
  ) {}

  /** 探测（带缓存）。decision 来自本地偏好文件。 */
  async probe(sessionId: string): Promise<AgentProbe> {
    const cached = this.probeCache.get(sessionId)
    const fresh = cached && this.now() - cached.at < PROBE_TTL_MS
    const base = fresh ? cached.probe : await this.probeRemote(sessionId)
    return { ...base, decision: this.prefs.decision(this.prefKey(sessionId)) }
  }

  private async probeRemote(sessionId: string): Promise<Omit<AgentProbe, 'decision'>> {
    try {
      const res = await this.exec(sessionId, agentProbeCommand(), PROBE_TIMEOUT_MS)
      if (res.code !== 0 && !res.stdout.includes('T1000_END')) {
        throw new Error(res.stderr.trim() || `探测失败（退出码 ${res.code}）`)
      }
      const probe = parseProbe(res.stdout)
      this.probeCache.set(sessionId, { at: this.now(), probe })
      return probe
    } catch (err) {
      this.blockedUntil.set(sessionId, this.now() + UNAVAILABLE_TTL_MS)
      throw err
    }
  }

  /** 安装（上传二进制 + 启动）。返回启动后的状态；失败抛错，由 IPC 层转成可读文案。 */
  async install(sessionId: string): Promise<{ version: string; port: number; pid: number }> {
    const probe = await this.probeRemote(sessionId)
    if (!probe.arch) {
      throw new Error(
        `服务器架构 ${probe.machine ?? '未知'} 没有随包提供的代理，将使用脚本模式（功能相同，刷新更粗）`,
      )
    }
    if (!probe.home) {
      throw new Error('拿不到远端 $HOME，无法上传代理')
    }

    const dir = `${probe.home}/.t1000-monitor`
    const prep = await this.exec(
      sessionId,
      `mkdir -p ${shellQuote(dir)} && chmod 700 ${shellQuote(dir)}`,
      PROBE_TIMEOUT_MS,
    )
    if (prep.code !== 0) {
      throw new Error(`创建目录失败：${firstLine(prep.stderr) ?? `退出码 ${prep.code}`}`)
    }

    // 先传到 .upload，再 chmod + 原子改名：远端永远不会执行到半个文件
    await this.putFile(sessionId, `${dir}/t1000-agent.upload`, readAgentBinary(probe.arch), 0o700)

    const res = await this.exec(sessionId, agentActivateCommand(), INSTALL_TIMEOUT_MS)
    if (!res.stdout.includes('T1000_AGENT_OK')) {
      throw new Error(`代理激活失败（退出码 ${res.code}）：${firstLine(res.stderr) ?? '未知原因'}`)
    }
    this.probeCache.delete(sessionId)
    const runtime = await this.start(sessionId)
    this.prefs.set(this.prefKey(sessionId), 'installed')
    this.blockedUntil.delete(sessionId)
    return { version: runtime.version, port: runtime.port, pid: runtime.pid }
  }

  /** 启动（已装但没在跑时）。 */
  private async start(sessionId: string): Promise<Runtime> {
    const res = await this.exec(sessionId, agentStartCommand(), INSTALL_TIMEOUT_MS)
    const state = parseState(res.stdout)
    if (!state) {
      throw new Error(
        `代理启动失败：${firstLine(res.stderr) ?? firstLine(res.stdout) ?? '未拿到状态文件'}`,
      )
    }
    const runtime: Runtime = {
      sessionId,
      port: state.port,
      token: state.token,
      pid: state.pid,
      version: state.version || AGENT_VERSION,
      client: new AgentHttp(() => this.openChannel(sessionId, state.port)),
      healthyAt: 0,
    }
    this.runtimes.set(sessionId, runtime)
    this.probeCache.delete(sessionId)
    this.blockedUntil.delete(sessionId)
    return runtime
  }

  /**
   * 确保代理可用。返回 null 表示"这台服务器走脚本模式"：
   * 没装、没 python3、用户拒绝、或刚失败（静默 60s 后才会再试）。
   */
  async ensure(sessionId: string): Promise<Runtime | null> {
    const runtime = this.runtimes.get(sessionId)
    if (runtime) {
      if (this.now() - runtime.healthyAt < HEALTH_TTL_MS) return runtime
      if (await this.ping(runtime)) return runtime
      runtime.client.close()
      this.runtimes.delete(sessionId)
    }
    if ((this.blockedUntil.get(sessionId) ?? 0) > this.now()) return null

    let probe: Omit<AgentProbe, 'decision'>
    try {
      probe = await this.probeRemote(sessionId)
    } catch {
      return null
    }
    if (!probe.arch || !probe.installed || probe.version !== AGENT_VERSION) {
      this.blockedUntil.set(sessionId, this.now() + UNAVAILABLE_TTL_MS)
      return null
    }
    // 已装：复用正在跑的实例，健康检查不过就重启（服务器重启后 pid 已失效）
    if (probe.state) {
      const candidate: Runtime = {
        sessionId,
        port: probe.state.port,
        token: probe.state.token,
        pid: probe.state.pid,
        version: probe.state.version || AGENT_VERSION,
        client: new AgentHttp(() => this.openChannel(sessionId, probe.state!.port)),
        healthyAt: 0,
      }
      if (await this.ping(candidate)) {
        this.runtimes.set(sessionId, candidate)
        return candidate
      }
      candidate.client.close()
    }
    try {
      return await this.start(sessionId)
    } catch {
      this.blockedUntil.set(sessionId, this.now() + UNAVAILABLE_TTL_MS)
      return null
    }
  }

  /** 取一份 metrics JSON；失败返回 null（绝不让监控面板因此崩掉） */
  async sample(
    sessionId: string,
    modules: readonly string[],
    options: AgentSampleOptions,
  ): Promise<{ json: string; version: string } | null> {
    const runtime = await this.ensure(sessionId)
    if (!runtime) return null
    const query =
      `/metrics?modules=${encodeURIComponent(modules.join(','))}` +
      `&limit=${Math.max(1, Math.min(200, Math.trunc(options.processLimit)))}` +
      `&token=${encodeURIComponent(runtime.token)}`
    try {
      const res = await runtime.client.request(query, SAMPLE_TIMEOUT_MS)
      if (res.status !== 200) throw new Error(`代理返回 HTTP ${res.status}`)
      runtime.healthyAt = this.now()
      return { json: res.body, version: runtime.version }
    } catch {
      runtime.client.close()
      this.runtimes.delete(sessionId)
      return null
    }
  }

  /** 停止代理（uninstall 时连文件一起删） */
  async stop(sessionId: string, uninstall: boolean): Promise<void> {
    const runtime = this.runtimes.get(sessionId)
    this.runtimes.delete(sessionId)
    runtime?.client.close()
    this.probeCache.delete(sessionId)
    this.blockedUntil.delete(sessionId)

    let pid = runtime?.pid ?? null
    if (pid === null) {
      // 注意：probeRemote 会顺手写回探测缓存（这是它跟 probe 的分工）。
      // 停完必须再删一次，否则刚删掉文件的那份"installed=true"会在缓存里活满
      // PROBE_TTL_MS —— 表现就是"卸载了但面板还说已安装"，而采集器已经悄悄回退脚本模式。
      const probe = await this.probeRemote(sessionId).catch(() => null)
      pid = probe?.state?.pid ?? null
    }
    if (pid !== null) {
      await this.exec(sessionId, agentStopCommand(pid, uninstall), PROBE_TIMEOUT_MS).catch(() => undefined)
    }
    if (uninstall) this.prefs.set(this.prefKey(sessionId), 'declined')
    this.probeCache.delete(sessionId)
  }

  /** 用户明确拒绝（弹窗里选"暂不安装/不再询问"） */
  decline(sessionId: string, forever: boolean): void {
    this.prefs.set(this.prefKey(sessionId), forever ? 'never' : 'declined')
    this.blockedUntil.set(sessionId, this.now() + UNAVAILABLE_TTL_MS)
  }

  forget(sessionId: string): void {
    const runtime = this.runtimes.get(sessionId)
    runtime?.client.close()
    this.runtimes.delete(sessionId)
    this.probeCache.delete(sessionId)
    this.blockedUntil.delete(sessionId)
  }

  // ── 内部 ────────────────────────────────────────────────────────────────

  private prefKey(sessionId: string): string {
    const session = getSession(sessionId)
    if (!session) return sessionId
    return `${session.host}:${session.port}:${session.username}`
  }

  private openTunnel(sessionId: string, port: number): Promise<Duplex> {
    const session = requireSession(sessionId)
    if (session.state !== 'ready') throw new Error('SSH 会话已断开，无法建立监控隧道')
    return new Promise<Duplex>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('建立监控隧道超时')), 4_000)
      session.client.forwardOut('127.0.0.1', 0, '127.0.0.1', port, (err, stream) => {
        clearTimeout(timer)
        if (err) return reject(err)
        resolve(stream as unknown as Duplex)
      })
    })
  }

  private async ping(runtime: Runtime): Promise<boolean> {
    try {
      const res = await runtime.client.request(
        `/health?token=${encodeURIComponent(runtime.token)}`,
        HEALTH_TIMEOUT_MS,
      )
      if (res.status !== 200) return false
      const body = JSON.parse(res.body) as { ok?: boolean; version?: string }
      if (body.ok !== true) return false
      if (body.version) runtime.version = body.version
      runtime.healthyAt = this.now()
      return true
    } catch {
      return false
    }
  }
}

/** 从启动命令输出里抠状态 JSON */
export function parseState(stdout: string): AgentState | null {
  const start = stdout.indexOf('{')
  const end = stdout.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    const parsed = JSON.parse(stdout.slice(start, end + 1)) as Partial<AgentState>
    if (typeof parsed.port !== 'number' || typeof parsed.token !== 'string') return null
    return {
      port: parsed.port,
      pid: typeof parsed.pid === 'number' ? parsed.pid : 0,
      token: parsed.token,
      version: typeof parsed.version === 'string' ? parsed.version : '',
      ...(typeof parsed.startedAt === 'number' ? { startedAt: parsed.startedAt } : {}),
    }
  } catch {
    return null
  }
}

function firstLine(text: string): string | undefined {
  const line = text
    .split(/\r?\n/)
    .map((s) => s.trim())
    .find((s) => s.length > 0)
  return line === undefined ? undefined : line.length > 200 ? `${line.slice(0, 200)}…` : line
}

/* ── 本地偏好（"这台服务器问过了"） ─────────────────────────────────────── */

interface PrefDoc {
  [key: string]: { decision: AgentDecision; at: string }
}

/**
 * 按 **host:port:username** 记住用户的选择。
 * 不按 connectionId：同一个服务器在连接库里可能有多条（不同分组/备注），
 * 按连接 id 记会重复问。
 */
export class AgentPrefs {
  private cache: PrefDoc | null = null

  constructor(private readonly file: string) {}

  private load(): PrefDoc {
    if (this.cache) return this.cache
    try {
      if (existsSync(this.file)) {
        const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as PrefDoc
        this.cache = typeof parsed === 'object' && parsed !== null ? parsed : {}
      } else {
        this.cache = {}
      }
    } catch {
      this.cache = {}
    }
    return this.cache
  }

  decision(key: string): AgentDecision | 'ask' {
    return this.load()[key]?.decision ?? 'ask'
  }

  set(key: string, decision: AgentDecision): void {
    const doc = this.load()
    doc[key] = { decision, at: new Date().toISOString() }
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      writeFileSync(this.file, JSON.stringify(doc, null, 2), 'utf8')
    } catch {
      // 偏好写不进去只影响"下次还问不问"，不该让安装流程失败
    }
  }
}
