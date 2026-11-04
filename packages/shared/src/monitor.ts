/**
 * 服务器监控指标模型。
 *
 * 采集方式：把随包分发的 POSIX shell 脚本推到远端临时目录执行，
 * 解析其 JSON 输出。**不需要在远端安装 agent**。
 */

/** 监控卡片种类 */
export type MonitorCardKind = 'system' | 'cpu' | 'memory' | 'network' | 'disk' | 'process' | 'gpu'

/** 采集优先级：不同指标的刷新成本差异很大，分档轮询 */
export type MonitorTier = 'fast' | 'medium' | 'slow'

export interface SystemMetrics {
  hostname?: string
  distro?: string
  release?: string
  kernel?: string
  arch?: string
  timezone?: string
  uptimeSeconds?: number
  /** 登录用户数 */
  users?: number
  /** 负载 */
  loadAvg?: [number, number, number]
}

export interface CpuCoreMetrics {
  /** 核心序号 */
  index: number
  /** 使用率百分比 0..100 */
  usage: number
  /** 频率 MHz（可选） */
  mhz?: number
}

export interface CpuMetrics {
  /** 总体使用率 0..100 */
  usage: number
  /** 逐核使用率 */
  cores: CpuCoreMetrics[]
  /** 型号 */
  model?: string
  /** 逻辑核数 */
  logicalCount?: number
  /** 物理核数 */
  physicalCount?: number
  /** 温度（摄氏度，可选） */
  temperatureC?: number
}

export interface MemoryMetrics {
  totalBytes: number
  usedBytes: number
  freeBytes: number
  /** 缓存/缓冲 */
  cachedBytes?: number
  /** swap */
  swapTotalBytes?: number
  swapUsedBytes?: number
}

export interface NetworkInterfaceMetrics {
  name: string
  rxBytes: number
  txBytes: number
  /** 接收速率 B/s */
  rxSpeed?: number
  /** 发送速率 B/s */
  txSpeed?: number
}

export interface NetworkMetrics {
  interfaces: NetworkInterfaceMetrics[]
  rxTotalBytes: number
  txTotalBytes: number
  rxSpeed: number
  txSpeed: number
}

export interface DiskPartitionMetrics {
  /** 挂载点 */
  mount: string
  /** 设备 */
  device?: string
  /** 文件系统类型 */
  fsType?: string
  totalBytes: number
  usedBytes: number
  availableBytes: number
  /** 已用百分比 */
  usedPercent: number
  /** 读速率 B/s */
  readSpeed?: number
  /** 写速率 B/s */
  writeSpeed?: number
}

export interface DiskMetrics {
  partitions: DiskPartitionMetrics[]
  readSpeed: number
  writeSpeed: number
}

export interface ProcessMetrics {
  pid: number
  /** 进程名 / 命令行（截断） */
  command: string
  /** CPU 百分比 */
  cpu: number
  /** 内存百分比 */
  memory: number
  user?: string
  state?: string
}

export interface GpuMetrics {
  index: number
  name: string
  /** 使用率 0..100 */
  utilization?: number
  /** 显存总量/已用（字节） */
  memoryTotalBytes?: number
  memoryUsedBytes?: number
  temperatureC?: number
}

/** 一次采集的完整快照（各卡片可缺失，取决于启用的卡片） */
export interface MonitorSnapshot {
  sessionId: string
  /** 采集时刻（ISO8601） */
  at: string
  /** 本次采集耗时 ms */
  elapsedMs?: number
  system?: SystemMetrics
  cpu?: CpuMetrics
  memory?: MemoryMetrics
  network?: NetworkMetrics
  disk?: DiskMetrics
  /** top 进程（默认按 CPU 降序，取前 N） */
  processes?: ProcessMetrics[]
  gpu?: GpuMetrics[]
  /** 采集过程中出现的非致命错误（模块级） */
  warnings?: string[]
}

/** 卡片开关配置：关掉的卡片不会触发对应采集命令 */
export interface MonitorCardConfig {
  kind: MonitorCardKind
  enabled: boolean
  /** 排序 */
  order: number
  /** 刷新分档 */
  tier: MonitorTier
}

/** 监控会话配置 */
export interface MonitorSettings {
  cards: MonitorCardConfig[]
  /** 进程列表条数上限 */
  processLimit: number
  /** 连续失败多少次后自动暂停 */
  failurePauseThreshold: number
}

/** 各档刷新间隔（ms），最小 3000 */
export const MONITOR_TIER_INTERVALS: Record<MonitorTier, number> = {
  fast: 3000,
  medium: 10000,
  slow: 30000,
}

/** 延迟探测结果哨兵：不可达 */
export const LATENCY_UNREACHABLE = 9999
