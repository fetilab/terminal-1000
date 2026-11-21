// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 监控采集调度器。
 *
 * 性能设计（对应 docs/PERFORMANCE-GOALS.md §5 监控采集）：
 * - **分档轮询**：fast 3s / medium 10s / slow 30s，同一次到期的档**合并成一条命令**，
 *   减少 SSH 往返；到点判定用「上次真正跑到该档的时刻」，不会因为慢档拖累快档。
 * - **脚本只上传一次**：`ensureInstalled` 先比对远端 VERSION，一致就再不碰远端文件。
 * - **关掉的卡片不产生命令**：模块列表由启用卡片推导；一个都没启用时**完全不 exec**。
 * - **订阅合并**：同一会话并发要快照时复用同一个 in-flight promise，不重复采集。
 * - **连续失败自动暂停**：默认 3 次（可配），暂停后清掉定时器，发 MONITOR_STATUS。
 * - 定时器节拍取「已启用卡片里最快的档」，只有 slow 卡片时就不会 3s 一次空转。
 */

import {
  MONITOR_TIER_INTERVALS,
  type MonitorCardConfig,
  type MonitorCardKind,
  type MonitorSettings,
  type MonitorSnapshot,
  type MonitorTier,
} from '@t1000/shared'
import type { ExecResult } from '../session-registry'
import { parseCollectorOutput } from './parser'
import {
  DEFAULT_FAILURE_PAUSE_THRESHOLD,
  DEFAULT_PROCESS_LIMIT,
  INSTALL_OK_SENTINEL,
  collectCommand,
  installCommand,
  modulesForCards,
  needsInstall,
  parseRemoteVersion,
  versionCheckCommand,
  type MonitorModule,
} from './scripts'

/** 档位优先级顺序：同一拍里 fast 先被采（也决定命令里模块的顺序） */
export const TIER_ORDER: readonly MonitorTier[] = ['fast', 'medium', 'slow']
/** 没有任何可用档位时的兜底节拍 */
export const BASE_TICK_MS = MONITOR_TIER_INTERVALS.fast
/** 定时器最小间隔：避免「档位已到期」时立刻重排造成的忙等 */
export const MIN_TICK_MS = 250

/** 脚本安装/版本探测的超时 */
export const INSTALL_TIMEOUT_MS = 10_000
/** 单次采集的超时（脚本内部 cpu 冷启动最多 sleep 0.2s） */
export const COLLECT_TIMEOUT_MS = 8_000

export type MonitorStatus = 'starting' | 'running' | 'paused' | 'stopped'

/** 采集通道：只依赖「在某个会话上跑一条命令」这一件事，便于单测注入 */
export interface CollectorTransport {
  exec(sessionId: string, command: string, timeoutMs?: number): Promise<ExecResult>
  /**
   * 代理通道（可选）。
   *
   * 返回 null 表示这台服务器没有可用代理（没装 / 没 python3 / 用户拒绝），
   * 采集器会**自动回退**到 exec 脚本模式 —— 代理是加速手段，不是前提条件。
   */
  agentSample?(
    sessionId: string,
    modules: readonly string[],
    options: { processLimit: number },
  ): Promise<{ json: string; version: string } | null>
}

/** 可注入时钟：单测用假定时器驱动分档调度 */
export interface CollectorClock {
  now(): number
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export const systemClock: CollectorClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

export interface CollectorEvents {
  onSnapshot(sessionId: string, snapshot: MonitorSnapshot): void
  onStatus(sessionId: string, status: MonitorStatus, message?: string): void
  onError(sessionId: string, message: string): void
}

export interface StartOptions {
  cards?: readonly MonitorCardConfig[]
  processLimit?: number
  failurePauseThreshold?: number
}

/** 默认卡片配置：CPU 走快档，磁盘/GPU 走慢档（采集成本差异大） */
export const DEFAULT_CARDS: readonly MonitorCardConfig[] = [
  { kind: 'system', enabled: true, order: 0, tier: 'medium' },
  { kind: 'cpu', enabled: true, order: 1, tier: 'fast' },
  { kind: 'memory', enabled: true, order: 2, tier: 'medium' },
  { kind: 'network', enabled: true, order: 3, tier: 'medium' },
  { kind: 'disk', enabled: true, order: 4, tier: 'slow' },
  { kind: 'process', enabled: true, order: 5, tier: 'medium' },
  { kind: 'gpu', enabled: true, order: 6, tier: 'slow' },
]

/** 卡片 → 快照字段名。process 卡片的数据在 `processes` 下（历史命名，不动它以免破坏契约）。 */
const SNAPSHOT_KEY_BY_CARD: Record<MonitorCardKind, keyof MonitorSnapshot> = {
  system: 'system',
  cpu: 'cpu',
  memory: 'memory',
  network: 'network',
  disk: 'disk',
  process: 'processes',
  gpu: 'gpu',
}

export function defaultSettings(): MonitorSettings {
  return {
    cards: DEFAULT_CARDS.map((c) => ({ ...c })),
    processLimit: DEFAULT_PROCESS_LIMIT,
    failurePauseThreshold: DEFAULT_FAILURE_PAUSE_THRESHOLD,
  }
}

interface SessionState {
  sessionId: string
  settings: MonitorSettings
  status: MonitorStatus
  /** 定时器句柄（未知类型以兼容注入时钟） */
  timer: unknown
  /** 进行中的采集；并发请求合并到它 */
  inFlight: Promise<MonitorSnapshot> | null
  failures: number
  /** 远端脚本已确认是最新版本 */
  installed: boolean
  /** 各档上次真正跑到的时刻 */
  lastRun: Record<MonitorTier, number>
  lastSnapshot: MonitorSnapshot | null
  lastSnapshotAt: number
  /**
   * 合并后的快照。
   *
   * 分档采集下，一次只采一个档位（fast 只有 cpu、slow 只有 disk/gpu）。
   * 如果直接把这一拍的快照推给 UI，面板上**没被采到的卡片会整体消失**，
   * 3 秒后 CPU 闪一下、10 秒后内存闪一下 —— 这就是"卡片显示不稳定"的根因。
   * 所以每拍都并到这份合并快照上，推给 UI 的永远是"已知的全部模块"。
   */
  merged: MonitorSnapshot | null
  /** 当前走代理还是脚本（首次采集时判定，失败会自动回退） */
  source: 'agent' | 'script'
}

export class MonitorCollector {
  private readonly sessions = new Map<string, SessionState>()
  private baseSettings: MonitorSettings = defaultSettings()
  private disposed = false

  constructor(
    private readonly transport: CollectorTransport,
    private readonly events: CollectorEvents,
    private readonly clock: CollectorClock = systemClock,
  ) {}

  // ── 查询 ────────────────────────────────────────────────────────────────

  /** 已登记会话的状态；未登记返回 'idle' */
  getStatus(sessionId: string): MonitorStatus | 'idle' {
    return this.sessions.get(sessionId)?.status ?? 'idle'
  }

  /** 会话配置优先；未登记则给默认配置的副本 */
  getSettings(sessionId?: string): MonitorSettings {
    const st = sessionId ? this.sessions.get(sessionId) : undefined
    return cloneSettings(st?.settings ?? this.baseSettings)
  }

  /** 最近一次快照（不触发采集） */
  peek(sessionId: string): MonitorSnapshot | null {
    return this.sessions.get(sessionId)?.lastSnapshot ?? null
  }

  // ── 配置 ────────────────────────────────────────────────────────────────

  /**
   * 更新卡片配置。带 sessionId 时只作用于该会话；否则更新默认值
   * （已登记的会话保持自己的配置，新会话继承默认值）。
   *
   * 配置生效是**即时**的，不允许"改完开关要等下一次重连"：
   * - 关掉的卡片立刻从合并快照里摘掉（否则会停在上一次的旧数据上）；
   * - 正在采集的会话重排档位并立刻补采一次，新开的卡片不用等 30 秒。
   */
  setCards(cards: readonly MonitorCardConfig[], sessionId?: string): MonitorSettings {
    const normalized = cards.map((c) => ({ ...c }))
    const st = sessionId ? this.sessions.get(sessionId) : undefined
    if (st) {
      st.settings.cards = normalized
      this.pruneDisabled(st)
      if (st.status === 'running' || st.status === 'starting') {
        st.lastRun = { fast: 0, medium: 0, slow: 0 }
        this.schedule(st)
        void this.collectOnce(st, TIER_ORDER).catch(() => undefined)
      }
      return cloneSettings(st.settings)
    }
    this.baseSettings.cards = normalized
    return cloneSettings(this.baseSettings)
  }

  /** 关掉的卡片不该继续显示上一次的数据（那是"关不掉"的错觉） */
  private pruneDisabled(st: SessionState): void {
    const merged = st.merged
    if (!merged) return
    const snapshot = merged as unknown as Record<string, unknown>
    for (const card of st.settings.cards) {
      if (card.enabled) continue
      delete snapshot[SNAPSHOT_KEY_BY_CARD[card.kind]]
    }
    st.lastSnapshot = merged
  }

  // ── 生命周期 ─────────────────────────────────────────────────────────────

  /**
   * 启动监控：重置失败计数 → 立刻采一次（含脚本安装）→ 排入分档调度。
   * 首次采集覆盖全部档位；失败不向调用方抛（通过 events 上报，含自动暂停）。
   */
  async start(sessionId: string, options: StartOptions = {}): Promise<MonitorSnapshot | null> {
    if (this.disposed) return null
    const st = this.ensure(sessionId, options)
    if (st.status === 'running' || st.status === 'starting') {
      this.schedule(st)
      return st.lastSnapshot
    }

    st.failures = 0
    st.status = 'starting'
    this.events.onStatus(sessionId, 'starting')
    this.schedule(st)

    try {
      return await this.collectOnce(st, TIER_ORDER)
    } catch {
      // 已由 fail() 计入失败并可能触发暂停
      return null
    }
  }

  stop(sessionId: string): void {
    const st = this.sessions.get(sessionId)
    if (!st) return
    this.clearTimer(st)
    st.status = 'stopped'
    this.events.onStatus(sessionId, 'stopped')
  }

  /** 彻底移除会话状态（会话断开时调用，避免状态泄漏） */
  forget(sessionId: string): void {
    const st = this.sessions.get(sessionId)
    if (st) this.clearTimer(st)
    this.sessions.delete(sessionId)
  }

  dispose(): void {
    this.disposed = true
    for (const st of this.sessions.values()) this.clearTimer(st)
    this.sessions.clear()
  }

  // ── 取快照 ───────────────────────────────────────────────────────────────

  /**
   * 取快照。默认优先用缓存（一个快档周期内视为新鲜），
   * 并发调用合并到同一次采集；paused/stopped 且无缓存时返回空快照而不打扰远端。
   */
  async snapshot(sessionId: string, options: { force?: boolean } = {}): Promise<MonitorSnapshot> {
    const st = this.ensure(sessionId)
    if (st.inFlight) return st.inFlight
    if (options.force) return this.collectOnce(st, TIER_ORDER)

    if (st.lastSnapshot && this.clock.now() - st.lastSnapshotAt < MONITOR_TIER_INTERVALS.fast) {
      return st.lastSnapshot
    }
    if (st.status === 'paused' || st.status === 'stopped') {
      return st.lastSnapshot ?? emptySnapshot(sessionId, nowIso(this.clock), '监控未运行，暂无快照')
    }
    return this.collectOnce(st, TIER_ORDER)
  }

  /** 手动刷新：清失败计数；若已暂停则恢复调度（用户显式要求继续） */
  async refresh(sessionId: string): Promise<MonitorSnapshot> {
    const st = this.ensure(sessionId)
    st.failures = 0
    if (st.status === 'paused') {
      st.status = 'running'
      this.events.onStatus(sessionId, 'running', '手动刷新，已恢复采集')
    }
    this.schedule(st)
    return this.collectOnce(st, TIER_ORDER)
  }

  // ── 调度 ────────────────────────────────────────────────────────────────

  private ensure(sessionId: string, options: StartOptions = {}): SessionState {
    let st = this.sessions.get(sessionId)
    if (!st) {
      st = {
        sessionId,
        settings: cloneSettings(this.baseSettings),
        status: 'stopped',
        timer: null,
        inFlight: null,
        failures: 0,
        installed: false,
        lastRun: { fast: 0, medium: 0, slow: 0 },
        lastSnapshot: null,
        lastSnapshotAt: 0,
        merged: null,
        source: 'script',
      }
      this.sessions.set(sessionId, st)
    }

    if (options.cards) st.settings.cards = options.cards.map((c) => ({ ...c }))
    if (options.processLimit !== undefined) {
      st.settings.processLimit = clampInt(options.processLimit, 1, 200)
    }
    if (options.failurePauseThreshold !== undefined) {
      st.settings.failurePauseThreshold = clampInt(options.failurePauseThreshold, 1, 100)
    }
    return st
  }

  private schedule(st: SessionState): void {
    if (this.disposed || st.timer !== null) return
    if (st.status === 'paused' || st.status === 'stopped') return
    st.timer = this.clock.setTimeout(() => {
      st.timer = null
      this.tick(st)
    }, this.nextDelay(st))
  }

  private tick(st: SessionState): void {
    if (this.disposed) return
    if (st.status === 'paused' || st.status === 'stopped') return

    this.schedule(st)
    if (st.inFlight) return // 上一轮还没回来，本拍跳过（下一拍会补上仍然到期的档）

    const tiers = this.dueTiers(st)
    if (tiers.length === 0) return
    void this.collectOnce(st, tiers).catch(() => {
      /* 失败已在 fail() 里上报 */
    })
  }

  /** 已到期（该跑）的档位，按 fast → medium → slow 优先级返回 */
  private dueTiers(st: SessionState): MonitorTier[] {
    const now = this.clock.now()
    const due: MonitorTier[] = []
    for (const tier of TIER_ORDER) {
      if (now - st.lastRun[tier] >= MONITOR_TIER_INTERVALS[tier]) due.push(tier)
    }
    return due
  }

  /**
   * 下一次唤醒的延迟 = 最近一个到期档位还剩多久。
   *
   * 用「最早到期时间」而不是固定 3s 节拍，是为了让 10s / 30s 档准点触发
   * （固定节拍会把 10s 档拖到 12s）。已到期（remaining ≤ 0）时给一个最小间隔，
   * 防止在 in-flight 期间忙等。
   */
  private nextDelay(st: SessionState): number {
    const now = this.clock.now()
    let min = Number.POSITIVE_INFINITY
    for (const tier of TIER_ORDER) {
      if (!this.tierEnabled(st, tier)) continue
      const remaining = MONITOR_TIER_INTERVALS[tier] - (now - st.lastRun[tier])
      min = Math.min(min, remaining)
    }
    if (!Number.isFinite(min)) return BASE_TICK_MS
    return Math.min(Math.max(min, MIN_TICK_MS), MONITOR_TIER_INTERVALS.slow)
  }

  /** 该档位下是否还有启用的卡片（没有就不必为它安排唤醒） */
  private tierEnabled(st: SessionState, tier: MonitorTier): boolean {
    return st.settings.cards.some((c) => c.enabled && c.tier === tier)
  }

  private recordRun(st: SessionState, tiers: readonly MonitorTier[]): void {
    const now = this.clock.now()
    for (const tier of tiers) st.lastRun[tier] = now
  }

  private clearTimer(st: SessionState): void {
    if (st.timer === null) return
    this.clock.clearTimeout(st.timer)
    st.timer = null
  }

  private modulesForTiers(st: SessionState, tiers: readonly MonitorTier[]): MonitorModule[] {
    const enabled = st.settings.cards.filter((c) => c.enabled && tiers.includes(c.tier))
    return modulesForCards(enabled)
  }

  // ── 采集 ────────────────────────────────────────────────────────────────

  /**
   * 发起一次采集；已有 in-flight 时直接复用它（订阅合并）。
   * 失败时 promise 会 reject（调用方决定吞还是上报），不产生未处理 rejection。
   */
  private collectOnce(
    st: SessionState,
    tiers: readonly MonitorTier[],
  ): Promise<MonitorSnapshot> {
    if (st.inFlight) return st.inFlight

    const run = this.runCollection(st, tiers)
    st.inFlight = run
    void run.then(
      () => {
        if (st.inFlight === run) st.inFlight = null
      },
      () => {
        if (st.inFlight === run) st.inFlight = null
      },
    )
    return run
  }

  private async runCollection(
    st: SessionState,
    tiers: readonly MonitorTier[],
  ): Promise<MonitorSnapshot> {
    const startedAt = this.clock.now()
    // 「已尝试」在动手前就记下：失败也按正常档位节奏重试，不会因为档位一直
    // 处于「已到期」而被立即重排成忙等。
    this.recordRun(st, tiers)
    try {
      const modules = this.modulesForTiers(st, tiers)

      // 一张卡片都没开：不产生任何远端命令（连版本探测都省掉）
      if (modules.length === 0) {
        return emptySnapshot(st.sessionId, nowIso(this.clock), '没有启用的监控卡片，未执行采集')
      }

      const collected = await this.collectPayload(st, modules, startedAt)

      const snapshot = parseCollectorOutput({
        sessionId: st.sessionId,
        stdout: collected.stdout,
        elapsedMs: this.clock.now() - startedAt,
        requestedModules: modules,
        at: nowIso(this.clock),
      })
      snapshot.source = collected.source
      if (collected.agentVersion) snapshot.agentVersion = collected.agentVersion

      // stderr 通常是权限/命令缺失类噪声，作为警告保留（不致命）
      const stderrNote = firstLine(collected.stderr ?? '')
      if (stderrNote) {
        snapshot.warnings = [...(snapshot.warnings ?? []), stderrNote]
      }

      const merged = this.mergeSnapshot(st, snapshot)
      this.succeed(st, merged)
      return merged
    } catch (err) {
      this.fail(st, err)
      throw err
    }
  }

  /**
   * 取一次原始输出：**优先代理，拿不到就回退脚本**。
   *
   * 代理失败不能变成"监控坏了"——服务器没 python3、用户拒绝安装、
   * 代理被系统清理掉，都是正常情况，脚本模式一直可用。
   */
  private async collectPayload(
    st: SessionState,
    modules: readonly string[],
    startedAt: number,
  ): Promise<{ stdout: string; stderr?: string; source: 'agent' | 'script'; agentVersion?: string }> {
    if (this.transport.agentSample) {
      const sampled = await this.transport
        .agentSample(st.sessionId, modules, { processLimit: st.settings.processLimit })
        .catch(() => null)
      if (sampled) {
        st.source = 'agent'
        this.lastSampleMs = this.clock.now() - startedAt
        return {
          stdout: sampled.json,
          source: 'agent',
          agentVersion: sampled.version,
        }
      }
      st.source = 'script'
    }

    await this.ensureInstalled(st)
    const result = await this.transport.exec(
      st.sessionId,
      collectCommand(modules, { processLimit: st.settings.processLimit }),
      COLLECT_TIMEOUT_MS,
    )
    this.lastSampleMs = this.clock.now() - startedAt
    return { stdout: result.stdout, stderr: result.stderr, source: 'script' }
  }

  /** 最近一次原始采集耗时（代理模式下它就是隧道的往返，用作健康度参考） */
  private lastSampleMs = 0

  getLastSampleMs(): number {
    return this.lastSampleMs
  }

  /**
   * 把本拍结果并到"已知的全部模块"上。
   *
   * 合并方向刻意是**本拍覆盖旧值**（而不是反过来）：磁盘用量、进程列表
   * 可能会变小/变短，沿用旧值会给出错误信息。只有本拍没采的模块才保留旧值。
   */
  private mergeSnapshot(st: SessionState, incoming: MonitorSnapshot): MonitorSnapshot {
    const prev = st.merged
    const pick = <T>(next: T | undefined, old: T | undefined): T | undefined => next ?? old
    const merged: MonitorSnapshot = {
      sessionId: incoming.sessionId,
      at: incoming.at,
      ...(incoming.elapsedMs === undefined ? {} : { elapsedMs: incoming.elapsedMs }),
      ...(incoming.source === undefined ? {} : { source: incoming.source }),
      ...(incoming.agentVersion === undefined ? {} : { agentVersion: incoming.agentVersion }),
    }
    const system = pick(incoming.system, prev?.system)
    const cpu = pick(incoming.cpu, prev?.cpu)
    const memory = pick(incoming.memory, prev?.memory)
    const network = pick(incoming.network, prev?.network)
    const disk = pick(incoming.disk, prev?.disk)
    const processes = pick(incoming.processes, prev?.processes)
    const gpu = pick(incoming.gpu, prev?.gpu)
    if (system) merged.system = system
    if (cpu) merged.cpu = cpu
    if (memory) merged.memory = memory
    if (network) merged.network = network
    if (disk) merged.disk = disk
    if (processes) merged.processes = processes
    if (gpu) merged.gpu = gpu
    if (incoming.warnings && incoming.warnings.length > 0) merged.warnings = incoming.warnings
    st.merged = merged
    return merged
  }

  /**
   * 脚本分发：只有远端 VERSION 与本地不一致（或文件缺失）才上传。
   * 一致时**只花一次 exec** 读版本号，之后 `installed` 缓存住，连版本号都不用再读。
   */
  private async ensureInstalled(st: SessionState): Promise<void> {
    if (st.installed) return

    const check = await this.transport.exec(st.sessionId, versionCheckCommand(), INSTALL_TIMEOUT_MS)
    if (!needsInstall(parseRemoteVersion(check.stdout))) {
      st.installed = true
      return
    }

    const install = await this.transport.exec(st.sessionId, installCommand(), INSTALL_TIMEOUT_MS)
    if (!install.stdout.includes(INSTALL_OK_SENTINEL)) {
      throw new Error(`采集脚本安装失败（退出码 ${install.code}）`)
    }
    st.installed = true
  }

  private succeed(st: SessionState, snapshot: MonitorSnapshot): void {
    st.failures = 0
    st.lastSnapshot = snapshot
    st.lastSnapshotAt = this.clock.now()
    if (st.status === 'starting') {
      st.status = 'running'
      this.events.onStatus(st.sessionId, 'running')
    }
    this.events.onSnapshot(st.sessionId, snapshot)
  }

  private fail(st: SessionState, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err)
    st.failures += 1
    this.events.onError(st.sessionId, message)

    if (st.failures >= st.settings.failurePauseThreshold) {
      st.status = 'paused'
      this.clearTimer(st)
      this.events.onStatus(
        st.sessionId,
        'paused',
        `连续 ${st.failures} 次采集失败，已自动暂停`,
      )
    }
  }
}

// ── 工具 ──────────────────────────────────────────────────────────────────

function cloneSettings(settings: MonitorSettings): MonitorSettings {
  return {
    cards: settings.cards.map((c) => ({ ...c })),
    processLimit: settings.processLimit,
    failurePauseThreshold: settings.failurePauseThreshold,
  }
}

function nowIso(clock: CollectorClock): string {
  return new Date(clock.now()).toISOString()
}

function emptySnapshot(sessionId: string, at: string, warning: string): MonitorSnapshot {
  return { sessionId, at, warnings: [warning] }
}

function firstLine(text: string): string | undefined {
  const line = text
    .split(/\r?\n/)
    .map((s) => s.trim())
    .find((s) => s.length > 0)
  if (!line) return undefined
  return line.length > 200 ? `${line.slice(0, 200)}…` : line
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, Math.trunc(value)))
}
