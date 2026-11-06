// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 监控面板。
 *
 * 数据来源只有一条：`MONITOR_SNAPSHOT` 事件（由主进程采集后批量推送）。
 * 面板自身不发起轮询，也不做任何采集——「关掉某个卡片就不产生对应采集命令」
 * 这条性能要求在 store 的 startMonitor 里通过 cards 参数表达。
 *
 * 走势图用自研 SVG 实现，不引图表库：这里只需要「一条折线 + 面积填充」，
 * 引一个重图表库会直接吃掉渲染层的首屏预算。
 */

import { memo, useMemo } from 'react'
import type {
  CpuMetrics,
  DiskMetrics,
  GpuMetrics,
  MemoryMetrics,
  MonitorCardKind,
  MonitorSnapshot,
  NetworkMetrics,
  ProcessMetrics,
  SystemMetrics,
} from '@t1000/shared'
import { Icon, type IconName } from '../../components/Icon'
import { IconButton } from '../../components/Button'
import { Badge, EmptyState } from '../../components/Feedback'
import { VirtualList } from '../../components/VirtualList'
import {
  formatBytes,
  formatFrequency,
  formatPercent,
  formatRelativeTime,
  formatSpeed,
  formatTemperature,
  formatUptime,
} from '../../lib/format'
import { actions, useStoreShallow } from '../../lib/store'
import './monitor.css'

const CARD_ICON: Record<MonitorCardKind, IconName> = {
  system: 'server',
  cpu: 'cpu',
  memory: 'memory',
  network: 'network',
  disk: 'disk',
  process: 'list',
  gpu: 'activity',
}

const CARD_TITLE: Record<MonitorCardKind, string> = {
  system: '系统',
  cpu: 'CPU',
  memory: '内存',
  network: '网络',
  disk: '磁盘',
  process: '进程',
  gpu: 'GPU',
}

/* ── 通用件 ────────────────────────────────────── */

function Card({
  kind,
  extra,
  children,
}: {
  kind: MonitorCardKind
  extra?: React.ReactNode
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <section className="mcard" aria-label={CARD_TITLE[kind]}>
      <header className="mcard__head">
        <Icon name={CARD_ICON[kind]} size={14} />
        <span className="mcard__head-title">{CARD_TITLE[kind]}</span>
        {extra}
      </header>
      <div className="mcard__body">{children}</div>
    </section>
  )
}

function barTone(percent: number): string {
  if (percent >= 90) return ' bar__fill--danger'
  if (percent >= 75) return ' bar__fill--warn'
  return ''
}

function MetricBar({
  label,
  value,
  detail,
  percent,
}: {
  label: React.ReactNode
  value: React.ReactNode
  detail?: React.ReactNode
  percent: number
}): React.JSX.Element {
  const clamped = Math.min(100, Math.max(0, percent))
  return (
    <div className="metric">
      <div className="metric__top">
        <span className="metric__label">{label}</span>
        <span className="metric__value">{value}</span>
        {detail ? <span className="metric__sub">{detail}</span> : null}
      </div>
      <div
        className="bar"
        role="progressbar"
        aria-valuenow={Math.round(clamped)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={typeof label === 'string' ? label : undefined}
      >
        <div className={`bar__fill${barTone(clamped)}`} style={{ width: `${clamped}%` }} />
      </div>
    </div>
  )
}

/** 轻量折线 + 面积图，纯 SVG。 */
const Sparkline = memo(function Sparkline({
  values,
  max = 100,
  height = 34,
}: {
  values: number[]
  max?: number
  height?: number
}): React.JSX.Element {
  const width = 260
  const path = useMemo(() => {
    if (values.length < 2) return { line: '', area: '' }
    const step = width / (values.length - 1)
    const safeMax = max <= 0 ? 1 : max
    const points = values.map((v, i) => {
      const x = i * step
      const y = height - (Math.min(safeMax, Math.max(0, v)) / safeMax) * (height - 3) - 1.5
      return `${x.toFixed(1)},${y.toFixed(1)}`
    })
    const line = `M${points.join(' L')}`
    const area = `${line} L${width},${height} L0,${height} Z`
    return { line, area }
  }, [values, max, height])

  if (!path.line) {
    return <div className="metric__sub">采样中…</div>
  }

  return (
    <svg className="spark" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden>
      <defs>
        <linearGradient id="t1000-spark" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--t1000-accent)" stopOpacity="0.32" />
          <stop offset="100%" stopColor="var(--t1000-accent)" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={path.area} fill="url(#t1000-spark)" />
      <path d={path.line} fill="none" stroke="var(--t1000-accent)" strokeWidth="1.4" />
    </svg>
  )
})

/* ── 各卡片 ────────────────────────────────────── */

function SystemCard({ data }: { data: SystemMetrics }): React.JSX.Element {
  const rows: Array<[string, React.ReactNode]> = [
    ['主机名', data.hostname ?? '—'],
    ['发行版', data.distro ?? '—'],
    ['内核', data.kernel ?? '—'],
    ['架构', data.arch ?? '—'],
    ['时区', data.timezone ?? '—'],
    ['运行时长', formatUptime(data.uptimeSeconds)],
    ['登录用户', data.users === undefined ? '—' : `${data.users} 人`],
    [
      '负载',
      data.loadAvg ? data.loadAvg.map((n) => n.toFixed(2)).join(' / ') : '—',
    ],
  ]
  return (
    <Card kind="system">
      <div className="kv">
        {rows.map(([k, v]) => (
          <div key={k} style={{ display: 'contents' }}>
            <span className="kv__k">{k}</span>
            <span className="kv__v">{v}</span>
          </div>
        ))}
      </div>
    </Card>
  )
}

function CpuCard({ data, history }: { data: CpuMetrics; history: number[] }): React.JSX.Element {
  return (
    <Card
      kind="cpu"
      extra={data.temperatureC === undefined ? null : <Badge tone="warn">{formatTemperature(data.temperatureC)}</Badge>}
    >
      <MetricBar
        label={data.model ?? '总体使用率'}
        value={formatPercent(data.usage, 1)}
        detail={
          data.logicalCount === undefined
            ? undefined
            : `${data.physicalCount ?? '—'} 物理 / ${data.logicalCount} 逻辑`
        }
        percent={data.usage}
      />
      <Sparkline values={history} max={100} />
      {data.cores.length > 0 ? (
        <div className="cores">
          {data.cores.map((c) => (
            <div className="core" key={c.index} title={`核心 ${c.index} · ${formatPercent(c.usage, 1)} · ${formatFrequency(c.mhz)}`}>
              <div className="core__fill" style={{ height: `${Math.min(100, Math.max(0, c.usage))}%` }} />
              <span className="core__text">{Math.round(c.usage)}</span>
            </div>
          ))}
        </div>
      ) : null}
    </Card>
  )
}

function MemoryCard({ data }: { data: MemoryMetrics }): React.JSX.Element {
  const usedPercent = data.totalBytes > 0 ? (data.usedBytes / data.totalBytes) * 100 : 0
  const swapPercent =
    data.swapTotalBytes && data.swapTotalBytes > 0
      ? ((data.swapUsedBytes ?? 0) / data.swapTotalBytes) * 100
      : 0
  return (
    <Card kind="memory">
      <MetricBar
        label="内存"
        value={formatBytes(data.usedBytes)}
        detail={`/ ${formatBytes(data.totalBytes)}`}
        percent={usedPercent}
      />
      {data.cachedBytes !== undefined ? (
        <div className="metric__sub">缓存 {formatBytes(data.cachedBytes)}</div>
      ) : null}
      {data.swapTotalBytes ? (
        <MetricBar
          label="Swap"
          value={formatBytes(data.swapUsedBytes)}
          detail={`/ ${formatBytes(data.swapTotalBytes)}`}
          percent={swapPercent}
        />
      ) : null}
    </Card>
  )
}

function NetworkCard({ data }: { data: NetworkMetrics }): React.JSX.Element {
  return (
    <Card kind="network">
      <div className="metric">
        <div className="metric__top">
          <span className="metric__label">↓ 接收</span>
          <span className="metric__value">{formatSpeed(data.rxSpeed)}</span>
        </div>
        <div className="metric__sub">累计 {formatBytes(data.rxTotalBytes)}</div>
      </div>
      <div className="metric">
        <div className="metric__top">
          <span className="metric__label">↑ 发送</span>
          <span className="metric__value">{formatSpeed(data.txSpeed)}</span>
        </div>
        <div className="metric__sub">累计 {formatBytes(data.txTotalBytes)}</div>
      </div>
      {data.interfaces.length > 0 ? (
        <div className="kv" style={{ marginTop: 2 }}>
          {data.interfaces.slice(0, 6).map((nic) => (
            <div key={nic.name} style={{ display: 'contents' }}>
              <span className="kv__k">{nic.name}</span>
              <span className="kv__v">
                ↓{formatSpeed(nic.rxSpeed ?? 0)} ↑{formatSpeed(nic.txSpeed ?? 0)}
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </Card>
  )
}

function DiskCard({ data }: { data: DiskMetrics }): React.JSX.Element {
  return (
    <Card kind="disk">
      {data.partitions.map((p) => (
        <MetricBar
          key={p.mount}
          label={p.mount}
          value={formatPercent(p.usedPercent, 0)}
          detail={`${formatBytes(p.usedBytes)} / ${formatBytes(p.totalBytes)}`}
          percent={p.usedPercent}
        />
      ))}
      {data.partitions.length === 0 ? <div className="metric__sub">未采集到分区信息</div> : null}
    </Card>
  )
}

function ProcessCard({ data }: { data: ProcessMetrics[] }): React.JSX.Element {
  return (
    <Card kind="process" extra={<Badge>{data.length}</Badge>}>
      <div className="proc__row proc__head">
        <span>PID</span>
        <span>命令</span>
        <span className="proc__num">CPU</span>
        <span className="proc__num">内存</span>
      </div>
      {/* 进程数可能上千，走虚拟滚动，避免一次挂载上千个 DOM 节点 */}
      <VirtualList
        items={data}
        rowHeight={24}
        threshold={40}
        overscan={8}
        className="proc__list"
        getKey={(p, i) => `${p.pid}-${i}`}
        renderRow={(p) => (
          <div className="proc__row" title={`${p.command}${p.user ? ` · ${p.user}` : ''}`}>
            <span className="proc__pid">{p.pid}</span>
            <span className="proc__cmd">{p.command}</span>
            <span className="proc__num">{p.cpu.toFixed(1)}%</span>
            <span className="proc__num">{p.memory.toFixed(1)}%</span>
          </div>
        )}
      />
    </Card>
  )
}

function GpuCard({ data }: { data: GpuMetrics[] }): React.JSX.Element {
  return (
    <Card kind="gpu">
      {data.map((gpu) => (
        <div className="metric" key={gpu.index}>
          <div className="metric__top">
            <span className="metric__label">{gpu.name}</span>
            <span className="metric__value">
              {gpu.utilization === undefined ? '—' : formatPercent(gpu.utilization)}
            </span>
          </div>
          {gpu.memoryTotalBytes ? (
            <div className="metric__sub">
              显存 {formatBytes(gpu.memoryUsedBytes)} / {formatBytes(gpu.memoryTotalBytes)}
              {gpu.temperatureC === undefined ? '' : ` · ${formatTemperature(gpu.temperatureC)}`}
            </div>
          ) : null}
        </div>
      ))}
    </Card>
  )
}

/* ── 面板 ──────────────────────────────────────── */

/** CPU 走势历史保留最近 N 个采样点。 */
const HISTORY_LEN = 48

export interface MonitorPanelProps {
  sessionId: string | undefined
  title: string
  onClose: () => void
}

export function MonitorPanel({ sessionId, title, onClose }: MonitorPanelProps): React.JSX.Element {
  const { snapshot, status, cards, cpuHistory } = useStoreShallow((s) => {
    const snap = sessionId ? s.snapshots[sessionId] : undefined
    const hist = sessionId ? s.cpuHistory[sessionId] : undefined
    return {
      snapshot: snap,
      status: sessionId ? s.monitorStatus[sessionId] : undefined,
      cards: s.monitorCards,
      cpuHistory: hist,
    }
  })

  const enabled = cards.filter((c) => c.enabled).sort((a, b) => a.order - b.order)

  return (
    <aside className="monitor" aria-label="服务器监控">
      <header className="monitor__head">
        <Icon name="activity" size={15} />
        <span className="monitor__title">监控 · {title}</span>
        {status ? (
          <Badge tone={status === 'running' ? 'ok' : status === 'unavailable' ? 'warn' : 'default'}>
            {status === 'running'
              ? '采集中'
              : status === 'starting'
                ? '启动中'
                : status === 'paused'
                  ? '已暂停'
                  : status === 'unavailable'
                    ? '不可用'
                    : '已停止'}
          </Badge>
        ) : null}
        <IconButton icon="close" label="关闭监控面板" onClick={onClose} />
      </header>

      <div className="monitor__body">
        {!sessionId ? (
          <EmptyState icon="activity" title="没有活动会话" text="先连接一台服务器，再打开监控面板。" />
        ) : status === 'unavailable' ? (
          <EmptyState
            icon="alert-triangle"
            title="监控采集不可用"
            text="主进程的监控服务尚未就绪（或该会话不支持脚本采集）。面板会在服务上线后自动恢复。"
          />
        ) : !snapshot ? (
          <EmptyState
            icon="clock"
            title="等待首次采集"
            text={`已启用 ${enabled.length} 个卡片。首个采样周期结束后这里会出现数据。`}
          />
        ) : (
          <>
            <div className="metric__sub">
              采集于 {formatRelativeTime(snapshot.at)}
              {snapshot.elapsedMs === undefined ? '' : ` · 耗时 ${snapshot.elapsedMs} ms`}
              {snapshot.warnings && snapshot.warnings.length > 0
                ? ` · ${snapshot.warnings.length} 项告警`
                : ''}
            </div>
            {enabled.map((card) => {
              switch (card.kind) {
                case 'system':
                  return snapshot.system ? <SystemCard key={card.kind} data={snapshot.system} /> : null
                case 'cpu':
                  return snapshot.cpu ? (
                    <CpuCard key={card.kind} data={snapshot.cpu} history={cpuHistory ?? []} />
                  ) : null
                case 'memory':
                  return snapshot.memory ? <MemoryCard key={card.kind} data={snapshot.memory} /> : null
                case 'network':
                  return snapshot.network ? <NetworkCard key={card.kind} data={snapshot.network} /> : null
                case 'disk':
                  return snapshot.disk ? <DiskCard key={card.kind} data={snapshot.disk} /> : null
                case 'process':
                  return snapshot.processes ? (
                    <ProcessCard key={card.kind} data={snapshot.processes} />
                  ) : null
                case 'gpu':
                  return snapshot.gpu ? <GpuCard key={card.kind} data={snapshot.gpu} /> : null
                default:
                  return null
              }
            })}

            <div className="mcard">
              <header className="mcard__head">
                <Icon name="sliders" size={14} />
                <span className="mcard__head-title">卡片开关</span>
              </header>
              <div className="mcard__body">
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {cards
                    .slice()
                    .sort((a, b) => a.order - b.order)
                    .map((c) => (
                      <button
                        key={c.kind}
                        type="button"
                        className={`t-badge${c.enabled ? ' t-badge--accent' : ''}`}
                        style={{ cursor: 'pointer', border: '1px solid transparent' }}
                        aria-pressed={c.enabled}
                        onClick={() => actions.toggleMonitorCard(c.kind)}
                      >
                        {CARD_TITLE[c.kind]}
                      </button>
                    ))}
                </div>
                <div className="metric__sub">关闭的卡片不会产生对应的采集命令。</div>
              </div>
            </div>
          </>
        )}
      </div>
    </aside>
  )
}

export default MonitorPanel

export type { MonitorSnapshot }
