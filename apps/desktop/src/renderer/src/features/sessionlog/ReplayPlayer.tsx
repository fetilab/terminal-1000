// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 会话录制回放播放器。
 *
 * ## 必须先理解的一件事：我们存的是「输出流」，不是「屏幕快照」
 * 主进程没有 VT 仿真器，所以**屏幕是渲染层用 xterm 重放出来的**。
 * 直接后果：**拖拽跳转不是 O(1) 取快照，而是"从 0 快速重放到目标点"**（O(之前所有帧)）。
 * 所以实现上分两条路径：
 * - **顺序播放**：按 `(tMs 差)/speed` 定时写入，只改定时器就能暂停/变速；
 * - **跳转/后退**：清屏 → **关掉定时器瞬时写入**到目标点 → 再从那里继续。
 *   这条路径对长录制会明显慢，界面上如实提示，而不是假装能瞬间跳。
 *
 * 另外两条来自录制侧的约束：
 * - 播放前按录制时的 `cols`/`rows` resize，否则重排与录制时不一致；
 * - `compressed` 由主进程透明解压，UI 不用管。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReplayFrame, SessionLogReplay } from '@t1000/shared'
import { Badge, Banner, Loading } from '../../components/Feedback'
import { Button, IconButton } from '../../components/Button'
import { Icon } from '../../components/Icon'
import { toast } from '../../components/Toast'
import { invoke } from '../../lib/ipc'
import { errorText } from '../../lib/format'
import './sessionlog.css'

/** 分页拉取的上限：避免一场超大录制把内存吃穿 */
const PAGE_LIMIT = 20000
const MAX_PAGES = 60

const SPEEDS = [0.5, 1, 2, 4] as const

function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

export interface ReplayPlayerProps {
  logId: string
  title: string
  onClose: () => void
}

export function ReplayPlayer({ logId, title, onClose }: ReplayPlayerProps): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const termRef = useRef<import('@xterm/xterm').Terminal | null>(null)
  const [ready, setReady] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [frames, setFrames] = useState<ReplayFrame[]>([])
  const [meta, setMeta] = useState<SessionLogReplay | null>(null)
  const [truncated, setTruncated] = useState(false)
  const [loading, setLoading] = useState(true)

  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState<number>(1)
  const [cursorMs, setCursorMs] = useState(0)

  /** 下一条要写入的帧下标 */
  const idxRef = useRef(0)
  const timerRef = useRef<number | undefined>(undefined)
  /** 播放锚点：墙钟与素材时间的对应关系，变速时重新锚定 */
  const anchorRef = useRef<{ wall: number; tMs: number }>({ wall: 0, tMs: 0 })
  const speedRef = useRef(speed)
  speedRef.current = speed
  const framesRef = useRef(frames)
  framesRef.current = frames

  /* ── 拉取整条时间线 ───────────────────────────── */

  useEffect(() => {
    let cancelled = false
    void (async () => {
      setLoading(true)
      try {
        const all: ReplayFrame[] = []
        let from = 0
        let first: SessionLogReplay | null = null
        for (let page = 0; page < MAX_PAGES; page += 1) {
          const res = await invoke<'sessionlog', 'replay', Record<string, unknown>, SessionLogReplay>(
            'sessionlog',
            'replay',
            { logId, fromMs: from, limit: PAGE_LIMIT },
          )
          if (cancelled) return
          if (!first) first = res
          all.push(...(res.frames ?? []))
          if (!res.hasMore) break
          const last = res.frames?.[res.frames.length - 1]
          const nextFrom = (res.toMs ?? last?.tMs ?? from) + (last ? 1 : 0)
          if (nextFrom <= from) break
          from = nextFrom
          if (page === MAX_PAGES - 1) setTruncated(true)
        }
        if (cancelled) return
        setFrames(all)
        setMeta(first)
      } catch (err) {
        if (!cancelled) setError(errorText(err))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [logId])

  /* ── 建立只读 xterm ──────────────────────────── */

  useEffect(() => {
    const host = hostRef.current
    if (!host || loading) return
    let disposed = false
    void (async () => {
      try {
        const { Terminal } = await import('@xterm/xterm')
        await import('@xterm/xterm/css/xterm.css')
        if (disposed) return
        const term = new Terminal({
          // 录制回放是"看"，所以不接收输入、不要光标闪烁
          disableStdin: true,
          cursorBlink: false,
          scrollback: 20000,
          fontSize: 12,
          fontFamily: "'JetBrains Mono', Menlo, Consolas, monospace",
          theme: { background: '#0d0f14', foreground: '#e4e7ee' },
        })
        term.open(host)
        // ⚠️ 必须按录制时的尺寸，否则换行位置与录制时不一致
        if (meta?.cols && meta?.rows) term.resize(meta.cols, meta.rows)
        termRef.current = term
        setReady(true)
      } catch (err) {
        if (!disposed) setError(errorText(err))
      }
    })()
    return () => {
      disposed = true
      termRef.current?.dispose()
      termRef.current = null
      setReady(false)
    }
  }, [loading, meta?.cols, meta?.rows])

  /* ── 播放引擎 ─────────────────────────────────── */

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      window.clearTimeout(timerRef.current)
      timerRef.current = undefined
    }
  }, [])

  /** 从当前游标继续排程下一帧 */
  const schedule = useCallback(() => {
    clearTimer()
    const term = termRef.current
    if (!term) return
    const next = framesRef.current[idxRef.current]
    if (!next) {
      setPlaying(false)
      return
    }
    const elapsed = performance.now() - anchorRef.current.wall
    const due = (next.tMs - anchorRef.current.tMs) / speedRef.current - elapsed
    timerRef.current = window.setTimeout(
      () => {
        term.write(next.data)
        idxRef.current += 1
        setCursorMs(next.tMs)
        schedule()
      },
      Math.max(0, due),
    )
  }, [clearTimer])

  const play = useCallback(() => {
    if (framesRef.current.length === 0) return
    if (idxRef.current >= framesRef.current.length) {
      // 播完了：从头再来
      idxRef.current = 0
      termRef.current?.reset()
      setCursorMs(0)
    }
    anchorRef.current = { wall: performance.now(), tMs: cursorMs }
    setPlaying(true)
    schedule()
  }, [cursorMs, schedule])

  const pause = useCallback(() => {
    clearTimer()
    setPlaying(false)
  }, [clearTimer])

  /**
   * 跳转/后退：**瞬时重放**（不做任何定时）。
   * 这正是"我们存的是输出流"带来的代价，界面上有明确提示。
   */
  const seek = useCallback(
    (targetMs: number) => {
      const term = termRef.current
      if (!term) return
      clearTimer()
      setPlaying(false)
      term.reset()
      const list = framesRef.current
      let i = 0
      for (; i < list.length; i += 1) {
        const f = list[i]
        if (!f || f.tMs > targetMs) break
        term.write(f.data)
      }
      idxRef.current = i
      setCursorMs(targetMs)
    },
    [clearTimer],
  )

  /** 逐帧：前进直接写下一帧；后退只能重建（O(n)） */
  const stepFrame = useCallback(
    (dir: 1 | -1) => {
      const term = termRef.current
      if (!term) return
      if (dir === 1) {
        const next = framesRef.current[idxRef.current]
        if (!next) return
        term.write(next.data)
        idxRef.current += 1
        setCursorMs(next.tMs)
        return
      }
      const prevIndex = Math.max(0, idxRef.current - 2)
      const prev = framesRef.current[prevIndex]
      seek(prev ? prev.tMs : 0)
    },
    [seek],
  )

  useEffect(() => clearTimer, [clearTimer])

  // 变速：重新锚定，已排程的定时器作废
  useEffect(() => {
    if (!playing) return
    anchorRef.current = { wall: performance.now(), tMs: cursorMs }
    schedule()
    // cursorMs 故意不进依赖：变速不该因为游标变化重排
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [speed])

  const totalMs = meta?.totalMs ?? 0
  const percent = totalMs > 0 ? Math.min(100, (cursorMs / totalMs) * 100) : 0
  const ticks = frames.length

  const seekHint = useMemo(
    () => (ticks > 20000 ? '这段录制很长，跳转需要从头重放，可能等几秒' : null),
    [ticks],
  )

  if (loading) return <Loading text="正在读取录制…" />

  return (
    <div className="replay">
      <div className="t-toolbar">
        <Icon name="eye" size={15} />
        <span className="panel-title">回放 · {title}</span>
        {meta?.compressed ? <Badge tone="outline">已压缩（自动解压）</Badge> : null}
        {meta?.cols && meta?.rows ? <Badge tone="outline">{meta.cols}×{meta.rows}</Badge> : null}
        <span className="term-toolbar__meta">
          {ticks} 帧 · {formatClock(totalMs)}
          {truncated ? '（仅载入前若干帧）' : ''}
        </span>
        <div className="t-toolbar__spacer" />
        <Button size="sm" variant="ghost" icon="chevron-left" onClick={onClose}>
          返回日志
        </Button>
      </div>

      {error ? (
        <div style={{ padding: '10px 12px 0' }}>
          <Banner tone="error">{error}</Banner>
        </div>
      ) : null}

      {ticks === 0 && !error ? (
        <div style={{ padding: '10px 12px 0' }}>
          <Banner tone="warn">
            这份日志没有录制数据（只有文本日志）。录制需要在会话期间开启，且录制设置为启用状态。
          </Banner>
        </div>
      ) : null}

      {/* 如实说明跳转代价：它是 O(之前帧数)，不是瞬间快照 */}
      <div className="replay__note">
        <Icon name="info" size={12} />
        录制存的是**带时间戳的输出流**，屏幕由这里重放得到。
        因此**拖拽跳转 = 从开头快速重放到目标点**（不是瞬间取快照）
        {seekHint ? `；${seekHint}` : '。'}
      </div>

      <div className="replay__stage">
        <div ref={hostRef} className="replay__term" />
      </div>

      <div className="replay__controls">
        <IconButton
          icon={playing ? 'stop' : 'power'}
          label={playing ? '暂停' : '播放'}
          tone={playing ? 'danger' : 'accent'}
          onClick={() => (playing ? pause() : play())}
        />
        <IconButton icon="chevron-left" label="后退一帧" onClick={() => stepFrame(-1)} />
        <IconButton icon="chevron-right" label="前进一帧" onClick={() => stepFrame(1)} />
        <IconButton icon="refresh" label="回到开头" onClick={() => seek(0)} />

        <span className="replay__clock">{formatClock(cursorMs)}</span>
        <input
          className="replay__range"
          type="range"
          min={0}
          max={Math.max(totalMs, 1)}
          value={cursorMs}
          aria-label="回放进度"
          // 拖拽过程只更新显示；松手才真正重放（避免拖动时反复 O(n) 重放）
          onChange={(e) => setCursorMs(Number(e.target.value))}
          onMouseUp={(e) => seek(Number(e.currentTarget.value))}
          onKeyUp={(e) => seek(Number(e.currentTarget.value))}
        />
        <span className="replay__clock">{formatClock(totalMs)}</span>

        <div className="t-toolbar__divider" />
        <div className="t-segmented" role="tablist" aria-label="播放速度">
          {SPEEDS.map((sp) => (
            <button
              key={sp}
              type="button"
              role="tab"
              aria-selected={sp === speed}
              className={`t-segmented__item${sp === speed ? ' t-segmented__item--active' : ''}`}
              onClick={() => setSpeed(sp)}
            >
              {sp}×
            </button>
          ))}
        </div>
        <div style={{ flex: 1 }} />
        <span className="metric__sub">进度 {percent.toFixed(0)}%</span>
      </div>
    </div>
  )
}

export default ReplayPlayer
