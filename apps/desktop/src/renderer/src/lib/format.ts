// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/** 展示层格式化。所有函数都对缺失值做兜底，绝不在渲染路径上抛错。 */

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'] as const

/** 字节数 → 人类可读。用 1024 进制，保留 1 位小数（<10 时）。 */
export function formatBytes(bytes: number | undefined, fractionDigits?: number): string {
  if (bytes === undefined || bytes === null || !Number.isFinite(bytes)) return '—'
  if (bytes < 0) return '—'
  if (bytes === 0) return '0 B'
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024
    unit += 1
  }
  const digits = fractionDigits ?? (value < 10 ? 1 : 0)
  return `${value.toFixed(digits)} ${UNITS[unit]}`
}

/** B/s 速率。 */
export function formatSpeed(bytesPerSecond: number | undefined): string {
  if (bytesPerSecond === undefined || !Number.isFinite(bytesPerSecond)) return '—'
  return `${formatBytes(bytesPerSecond, bytesPerSecond < 10 * 1024 ? 1 : 0)}/s`
}

/** 秒 → 「3天4小时」这类紧凑表达。 */
export function formatUptime(seconds: number | undefined): string {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return '—'
  const d = Math.floor(seconds / 86400)
  const h = Math.floor((seconds % 86400) / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  if (d > 0) return `${d} 天 ${h} 小时`
  if (h > 0) return `${h} 小时 ${m} 分`
  if (m > 0) return `${m} 分`
  return `${Math.floor(seconds)} 秒`
}

const RTF = new Intl.RelativeTimeFormat('zh-CN', { numeric: 'auto' })

/** ISO 时间 → 相对时间（「3 分钟前」）。 */
export function formatRelativeTime(iso: string | undefined, now = Date.now()): string {
  if (!iso) return '—'
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return '—'
  const diffMs = t - now
  const abs = Math.abs(diffMs)
  if (abs < 60_000) return '刚刚'
  if (abs < 3_600_000) return RTF.format(Math.round(diffMs / 60_000), 'minute')
  if (abs < 86_400_000) return RTF.format(Math.round(diffMs / 3_600_000), 'hour')
  if (abs < 30 * 86_400_000) return RTF.format(Math.round(diffMs / 86_400_000), 'day')
  return formatDate(iso)
}

/** ISO 时间 → 「2026-11-05 21:30」。 */
export function formatDate(iso: string | undefined): string {
  if (!iso) return '—'
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return '—'
  const d = new Date(t)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 毫秒 → 延迟展示；9999（LATENCY_UNREACHABLE 哨兵）显示为不可达。 */
export function formatLatency(ms: number | undefined): string {
  if (ms === undefined) return '—'
  if (!Number.isFinite(ms)) return '—'
  if (ms >= 9999) return '超时'
  return `${Math.round(ms)} ms`
}

/** 百分比，钳制到 0..100。 */
export function formatPercent(value: number | undefined, digits = 0): string {
  if (value === undefined || !Number.isFinite(value)) return '—'
  const clamped = Math.min(100, Math.max(0, value))
  return `${clamped.toFixed(digits)}%`
}

/** 频率 MHz → 「3.6 GHz」 */
export function formatFrequency(mhz: number | undefined): string {
  if (mhz === undefined || !Number.isFinite(mhz) || mhz <= 0) return '—'
  return mhz >= 1000 ? `${(mhz / 1000).toFixed(2)} GHz` : `${Math.round(mhz)} MHz`
}

/** 温度 */
export function formatTemperature(c: number | undefined): string {
  if (c === undefined || !Number.isFinite(c)) return '—'
  return `${Math.round(c)}°C`
}

/** 主机地址展示：host:port，端口为默认值时省略。 */
export function formatAddress(host: string | undefined, port: number | undefined, defaultPort?: number): string {
  if (!host) return '—'
  if (port === undefined || port === defaultPort) return host
  return `${host}:${port}`
}

/** 命令/路径截断：保留头尾，中间省略。 */
export function truncateMiddle(text: string, max = 48): string {
  if (text.length <= max) return text
  const head = Math.ceil((max - 1) / 2)
  const tail = Math.floor((max - 1) / 2)
  return `${text.slice(0, head)}…${text.slice(text.length - tail)}`
}

/** 路径最后一段（用于面包屑/标题）。 */
export function basename(path: string): string {
  const trimmed = path.replace(/[/\\]+$/, '')
  const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed
}

/** 把错误对象转成可展示文案（IPC 错误已带面向用户的信息）。 */
export function errorText(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  try {
    return JSON.stringify(err)
  } catch {
    return String(err)
  }
}
