// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 把采集脚本的 stdout 解析成 MonitorSnapshot。
 *
 * 解析原则：**远端环境不可信，任何一处坏数据都不许抛异常**。
 * - JSON 前后可能混有 shell / 工具噪声（`ps: bad -o argument` 之类），先整体解析，
 *   失败再退化为「取第一个 `{` 到最后一个 `}` 的子串」。
 * - 字段做别名容忍（`command`/`cmd`/`comm`/`args`、`cpu`/`pcpu`、`memory`/`mem`/`%mem`…），
 *   数字允许是字符串（含 `%`、千分位），负值/NaN 一律归零。
 * - 缺字段只会变成 `warnings`，不会变成异常或半截对象。
 */

import type {
  CpuCoreMetrics,
  CpuMetrics,
  DiskMetrics,
  DiskPartitionMetrics,
  GpuMetrics,
  MemoryMetrics,
  MonitorSnapshot,
  NetworkInterfaceMetrics,
  NetworkMetrics,
  ProcessMetrics,
  SystemMetrics,
} from '@t1000/shared'
import { MONITOR_MODULES } from './scripts'

export interface ParseCollectorInput {
  sessionId: string
  stdout: string
  /** 本次采集耗时（含脚本上传/网络往返） */
  elapsedMs?: number
  /** 本次实际请求的模块，用于对「没返回数据」给出警告 */
  requestedModules?: readonly string[]
  /** 采集时刻；缺省用本地当前时间 */
  at?: string
}

export interface ExtractedPayload {
  value: Record<string, unknown> | null
  warning?: string
}

/** 从可能夹带噪声的输出里抠出 JSON 对象 */
export function extractJsonObject(stdout: string): ExtractedPayload {
  const text = stdout.trim()
  if (text.length === 0) return { value: null, warning: '采集输出为空' }

  const direct = tryParse(text)
  if (direct !== NOT_JSON) {
    return isRecord(direct)
      ? { value: direct }
      : { value: null, warning: '采集输出不是 JSON 对象' }
  }

  // 退一步：截取最外层花括号
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start >= 0 && end > start) {
    const sliced = tryParse(text.slice(start, end + 1))
    if (sliced !== NOT_JSON) {
      return isRecord(sliced)
        ? { value: sliced }
        : { value: null, warning: '采集输出不是 JSON 对象' }
    }
  }
  return { value: null, warning: '采集输出不是合法 JSON' }
}

/** 解析一次采集输出（永不抛异常） */
export function parseCollectorOutput(input: ParseCollectorInput): MonitorSnapshot {
  const warnings: string[] = []
  const snapshot: MonitorSnapshot = {
    sessionId: input.sessionId,
    at: input.at ?? new Date().toISOString(),
  }
  if (input.elapsedMs !== undefined) {
    snapshot.elapsedMs = Math.max(0, Math.round(input.elapsedMs))
  }

  const extracted = extractJsonObject(input.stdout)
  const payload = extracted.value
  if (!payload) {
    if (extracted.warning) warnings.push(extracted.warning)
    snapshot.warnings = warnings
    return snapshot
  }

  for (const w of asArray(payload['warnings'])) {
    const s = asString(w)
    if (s) warnings.push(s)
  }

  const root = unwrapPayload(payload)

  const system = pickField('system', root, parseSystem(root['system']), warnings)
  if (system) snapshot.system = system

  const cpu = pickField('cpu', root, parseCpu(root['cpu']), warnings)
  if (cpu) snapshot.cpu = cpu

  const memory = pickField('memory', root, parseMemory(root['memory']), warnings)
  if (memory) snapshot.memory = memory

  const network = pickField('network', root, parseNetwork(root['network']), warnings)
  if (network) snapshot.network = network

  const disk = pickField('disk', root, parseDisk(root['disk']), warnings)
  if (disk) snapshot.disk = disk

  const processes = pickField(
    'process',
    root,
    parseProcesses(root['process'] ?? root['processes']),
    warnings,
  )
  if (processes) snapshot.processes = processes

  const gpu = pickField('gpu', root, parseGpu(root['gpu']), warnings)
  if (gpu) snapshot.gpu = gpu

  for (const mod of input.requestedModules ?? []) {
    if (root[mod] === undefined || root[mod] === null) {
      warnings.push(`模块 ${mod} 未返回数据`)
    }
  }

  if (warnings.length > 0) snapshot.warnings = warnings
  return snapshot
}

// ── 各字段解析 ────────────────────────────────────────────────────────────

function parseSystem(raw: unknown): SystemMetrics | undefined {
  if (!isRecord(raw)) return undefined
  const out: SystemMetrics = {}
  const hostname = asString(raw['hostname'] ?? raw['host'])
  const distro = asString(raw['distro'] ?? raw['id'] ?? raw['system'])
  const release = asString(raw['release'] ?? raw['version'] ?? raw['versionId'])
  const kernel = asString(raw['kernel'] ?? raw['releaseName'])
  const arch = asString(raw['arch'] ?? raw['architecture'])
  const timezone = asString(raw['timezone'] ?? raw['tz'])
  const uptimeSeconds = asInt(raw['uptimeSeconds'] ?? raw['uptime'])
  const users = asInt(raw['users'] ?? raw['userCount'])
  const loadAvg = parseLoadAvg(raw['loadAvg'] ?? raw['load'])

  if (hostname !== undefined) out.hostname = hostname
  if (distro !== undefined) out.distro = distro
  if (release !== undefined) out.release = release
  if (kernel !== undefined) out.kernel = kernel
  if (arch !== undefined) out.arch = arch
  if (timezone !== undefined) out.timezone = timezone
  if (uptimeSeconds !== undefined && uptimeSeconds >= 0) out.uptimeSeconds = uptimeSeconds
  if (users !== undefined && users >= 0) out.users = users
  if (loadAvg !== undefined) out.loadAvg = loadAvg

  return Object.keys(out).length > 0 ? out : undefined
}

function parseLoadAvg(raw: unknown): [number, number, number] | undefined {
  let parts: unknown[]
  if (Array.isArray(raw)) parts = raw
  else if (typeof raw === 'string') parts = raw.trim().split(/\s+/)
  else return undefined

  const nums: number[] = []
  for (const p of parts) {
    const n = asNumber(p)
    if (n !== undefined) nums.push(n < 0 ? 0 : n)
  }
  if (nums.length === 0) return undefined
  return [nums[0] ?? 0, nums[1] ?? 0, nums[2] ?? 0]
}

function parseCpu(raw: unknown): CpuMetrics | undefined {
  if (!isRecord(raw)) return undefined

  const cores: CpuCoreMetrics[] = []
  asArray(raw['cores'] ?? raw['cpus'] ?? raw['core']).forEach((item, i) => {
    const core = parseCore(item, i)
    if (core) cores.push(core)
  })
  cores.sort((a, b) => a.index - b.index)

  let usage = asNumber(raw['usage'] ?? raw['usagePercent'] ?? raw['load'])
  if (usage === undefined && cores.length > 0) {
    usage = cores.reduce((sum, c) => sum + c.usage, 0) / cores.length
  }
  if (usage === undefined && cores.length === 0) return undefined

  const out: CpuMetrics = { usage: clampPercent(usage ?? 0), cores }
  const model = asString(raw['model'] ?? raw['modelName'])
  const logicalCount = asInt(raw['logicalCount'] ?? raw['logical'] ?? raw['coresCount'])
  const physicalCount = asInt(raw['physicalCount'] ?? raw['physical'])
  const temperatureC = asNumber(raw['temperatureC'] ?? raw['temperature'])
  if (model !== undefined) out.model = model
  if (logicalCount !== undefined && logicalCount > 0) out.logicalCount = logicalCount
  if (physicalCount !== undefined && physicalCount > 0) out.physicalCount = physicalCount
  if (temperatureC !== undefined && temperatureC > -273) out.temperatureC = temperatureC
  return out
}

function parseCore(raw: unknown, fallbackIndex: number): CpuCoreMetrics | undefined {
  if (typeof raw === 'number') {
    const n = asNumber(raw)
    return n === undefined ? undefined : { index: fallbackIndex, usage: clampPercent(n) }
  }
  if (!isRecord(raw)) return undefined
  const index = asInt(raw['index'] ?? raw['cpu'] ?? raw['id']) ?? fallbackIndex
  const usage = asNumber(raw['usage'] ?? raw['load'] ?? raw['percent'] ?? raw['usagePercent'])
  if (usage === undefined) return undefined
  const core: CpuCoreMetrics = { index: index < 0 ? fallbackIndex : index, usage: clampPercent(usage) }
  const mhz = asNumber(raw['mhz'] ?? raw['cpu MHz'] ?? raw['frequency'])
  if (mhz !== undefined && mhz > 0) core.mhz = mhz
  return core
}

function parseMemory(raw: unknown): MemoryMetrics | undefined {
  if (!isRecord(raw)) return undefined
  const total = asNonNeg(raw['totalBytes'] ?? raw['total'])
  if (total <= 0) return undefined

  const out: MemoryMetrics = {
    totalBytes: total,
    usedBytes: Math.min(asNonNeg(raw['usedBytes'] ?? raw['used']), total),
    freeBytes: Math.min(asNonNeg(raw['freeBytes'] ?? raw['free']), total),
  }
  const cached = asNumber(raw['cachedBytes'] ?? raw['cached'] ?? raw['buffcache'])
  if (cached !== undefined && cached > 0) out.cachedBytes = cached

  const swapTotal = asNumber(raw['swapTotalBytes'] ?? raw['swapTotal'])
  if (swapTotal !== undefined && swapTotal > 0) {
    out.swapTotalBytes = swapTotal
    const swapUsed = asNumber(raw['swapUsedBytes'] ?? raw['swapUsed'])
    if (swapUsed !== undefined) {
      out.swapUsedBytes = Math.min(Math.max(0, swapUsed), swapTotal)
    }
  }
  return out
}

function parseNetwork(raw: unknown): NetworkMetrics | undefined {
  if (!isRecord(raw)) return undefined

  const interfaces: NetworkInterfaceMetrics[] = []
  for (const item of asArray(raw['interfaces'] ?? raw['ifaces'])) {
    const iface = parseInterface(item)
    if (iface) interfaces.push(iface)
  }

  const rxTotalBytes = asNonNeg(
    raw['rxTotalBytes'] ?? raw['rxTotal'],
    interfaces.reduce((s, i) => s + i.rxBytes, 0),
  )
  const txTotalBytes = asNonNeg(
    raw['txTotalBytes'] ?? raw['txTotal'],
    interfaces.reduce((s, i) => s + i.txBytes, 0),
  )
  const rxSpeed = asNonNeg(
    raw['rxSpeed'] ?? raw['rxBytesPerSec'],
    interfaces.reduce((s, i) => s + (i.rxSpeed ?? 0), 0),
  )
  const txSpeed = asNonNeg(
    raw['txSpeed'] ?? raw['txBytesPerSec'],
    interfaces.reduce((s, i) => s + (i.txSpeed ?? 0), 0),
  )
  return { interfaces, rxTotalBytes, txTotalBytes, rxSpeed, txSpeed }
}

function parseInterface(raw: unknown): NetworkInterfaceMetrics | undefined {
  if (!isRecord(raw)) return undefined
  const name = asString(raw['name'] ?? raw['interface'] ?? raw['iface'])
  if (name === undefined) return undefined
  const out: NetworkInterfaceMetrics = {
    name,
    rxBytes: asNonNeg(raw['rxBytes'] ?? raw['rx']),
    txBytes: asNonNeg(raw['txBytes'] ?? raw['tx']),
  }
  const rxSpeed = asNumber(raw['rxSpeed'] ?? raw['rxBytesPerSec'])
  const txSpeed = asNumber(raw['txSpeed'] ?? raw['txBytesPerSec'])
  if (rxSpeed !== undefined && rxSpeed >= 0) out.rxSpeed = rxSpeed
  if (txSpeed !== undefined && txSpeed >= 0) out.txSpeed = txSpeed
  return out
}

function parseDisk(raw: unknown): DiskMetrics | undefined {
  if (!isRecord(raw)) return undefined

  const partitions: DiskPartitionMetrics[] = []
  for (const item of asArray(raw['partitions'] ?? raw['fs'] ?? raw['mounts'])) {
    const part = parsePartition(item)
    if (part) partitions.push(part)
  }
  if (partitions.length === 0) return undefined

  return {
    partitions,
    readSpeed: asNonNeg(raw['readSpeed'] ?? raw['readBytesPerSec']),
    writeSpeed: asNonNeg(raw['writeSpeed'] ?? raw['writeBytesPerSec']),
  }
}

function parsePartition(raw: unknown): DiskPartitionMetrics | undefined {
  if (!isRecord(raw)) return undefined
  const mount = asString(raw['mount'] ?? raw['mountPoint'] ?? raw['target'] ?? raw['mountedOn'])
  if (mount === undefined) return undefined

  const totalBytes = asNonNeg(raw['totalBytes'] ?? raw['total'] ?? raw['size'])
  const usedBytes = asNonNeg(raw['usedBytes'] ?? raw['used'])
  const availableBytes = asNonNeg(raw['availableBytes'] ?? raw['available'] ?? raw['avail'])

  let usedPercent = asNumber(raw['usedPercent'] ?? raw['percent'] ?? raw['usePct'])
  if (usedPercent === undefined) {
    usedPercent = totalBytes > 0 ? (usedBytes * 100) / totalBytes : 0
  }

  const out: DiskPartitionMetrics = {
    mount,
    totalBytes,
    usedBytes,
    availableBytes,
    usedPercent: clampPercent(usedPercent),
  }
  const device = asString(raw['device'] ?? raw['filesystem'] ?? raw['source'])
  const fsType = asString(raw['fsType'] ?? raw['type'] ?? raw['fstype'])
  const readSpeed = asNumber(raw['readSpeed'])
  const writeSpeed = asNumber(raw['writeSpeed'])
  if (device !== undefined) out.device = device
  if (fsType !== undefined) out.fsType = fsType
  if (readSpeed !== undefined && readSpeed >= 0) out.readSpeed = readSpeed
  if (writeSpeed !== undefined && writeSpeed >= 0) out.writeSpeed = writeSpeed
  return out
}

function parseProcesses(raw: unknown): ProcessMetrics[] | undefined {
  if (raw === undefined) return undefined
  if (!Array.isArray(raw)) return undefined

  const parsed: ProcessMetrics[] = []
  for (const item of raw) {
    const proc = parseProcess(item)
    if (proc) parsed.push(proc)
  }
  // 契约是「默认按 CPU 降序」；同值时保持原顺序（稳定排序）
  return parsed
    .map((p, i) => ({ p, i }))
    .sort((a, b) => b.p.cpu - a.p.cpu || a.i - b.i)
    .map(({ p }) => p)
}

function parseProcess(raw: unknown): ProcessMetrics | undefined {
  if (!isRecord(raw)) return undefined
  const pid = asInt(raw['pid'] ?? raw['PID'])
  if (pid === undefined || pid < 0) return undefined

  const out: ProcessMetrics = {
    pid,
    command:
      asString(raw['command'] ?? raw['cmd'] ?? raw['comm'] ?? raw['args'] ?? raw['name']) ??
      String(pid),
    // 多核下 top 系工具的单进程 CPU 可以 >100%，这里不裁剪，保留原意
    cpu: Math.max(0, asNumber(raw['cpu'] ?? raw['pcpu'] ?? raw['%cpu']) ?? 0),
    memory: clampPercent(asNumber(raw['memory'] ?? raw['mem'] ?? raw['%mem'] ?? raw['pmem']) ?? 0),
  }
  const user = asString(raw['user'] ?? raw['username'] ?? raw['owner'])
  const state = asString(raw['state'] ?? raw['stat'] ?? raw['status'])
  if (user !== undefined) out.user = user
  if (state !== undefined) out.state = state
  return out
}

function parseGpu(raw: unknown): GpuMetrics[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const out: GpuMetrics[] = []
  raw.forEach((item, i) => {
    if (!isRecord(item)) return
    const index = asInt(item['index'] ?? item['id']) ?? i
    const name = asString(item['name'] ?? item['model']) ?? `GPU ${index}`
    const gpu: GpuMetrics = { index: index < 0 ? i : index, name }
    const utilization = asNumber(item['utilization'] ?? item['usage'] ?? item['gpuUtil'])
    const memoryTotalBytes = asNumber(item['memoryTotalBytes'] ?? item['memoryTotal'])
    const memoryUsedBytes = asNumber(item['memoryUsedBytes'] ?? item['memoryUsed'])
    const temperatureC = asNumber(item['temperatureC'] ?? item['temperature'])
    if (utilization !== undefined && utilization >= 0) gpu.utilization = clampPercent(utilization)
    if (memoryTotalBytes !== undefined && memoryTotalBytes >= 0) {
      gpu.memoryTotalBytes = memoryTotalBytes
    }
    if (memoryUsedBytes !== undefined && memoryUsedBytes >= 0) {
      gpu.memoryUsedBytes = memoryUsedBytes
    }
    if (temperatureC !== undefined && temperatureC > -273) gpu.temperatureC = temperatureC
    out.push(gpu)
  })
  return out
}

// ── 基础工具 ──────────────────────────────────────────────────────────────

const NOT_JSON = Symbol('not-json')

function tryParse(text: string): unknown | typeof NOT_JSON {
  try {
    return JSON.parse(text)
  } catch {
    return NOT_JSON
  }
}

/**
 * 收录一个模块的解析结果，并区分两种「没有数据」：
 * - 键不存在 → 由 requestedModules 循环报「未返回数据」
 * - 键存在但解析不出可用对象 → 这里报「内容无法解析」
 */
function pickField<T>(
  moduleKey: string,
  root: Record<string, unknown>,
  parsed: T | undefined,
  warnings: string[],
): T | undefined {
  if (parsed !== undefined) return parsed
  const raw = root[moduleKey]
  if (raw !== undefined && raw !== null) warnings.push(`模块 ${moduleKey} 内容无法解析`)
  return undefined
}

function unwrapPayload(root: Record<string, unknown>): Record<string, unknown> {
  const keys: readonly string[] = MONITOR_MODULES
  if (keys.some((k) => k in root)) return root
  for (const wrapper of ['data', 'result', 'payload', 'stats'] as const) {
    const inner = root[wrapper]
    if (isRecord(inner) && keys.some((k) => k in inner)) return inner
  }
  return root
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value === 'string') {
    const cleaned = value.replace(/[,\s%]/g, '')
    if (cleaned.length === 0) return undefined
    const n = Number(cleaned)
    return Number.isFinite(n) ? n : undefined
  }
  return undefined
}

function asNonNeg(value: unknown, fallback = 0): number {
  const n = asNumber(value)
  if (n === undefined || n < 0) return fallback
  return n
}

function asInt(value: unknown): number | undefined {
  const n = asNumber(value)
  return n === undefined ? undefined : Math.trunc(n)
}

function asString(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed.length > 0 ? trimmed : undefined
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return undefined
}

function clampPercent(n: number): number {
  if (!Number.isFinite(n) || n < 0) return 0
  return Math.min(100, n)
}
