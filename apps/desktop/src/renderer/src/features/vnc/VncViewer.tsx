// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * VNC 画面查看器。
 *
 * ## 帧路由（最重要的一条）
 * `VNC_FRAME` 是**每帧一条**的高频事件。它**绝不进全局 store** ——
 * 否则每帧都会让整棵树参与一次状态比对，画面必卡死。
 * 这里组件自己订阅，并且**用 rAF 合帧**：事件到达只入队，下一帧一次性画完。
 * 一次 rAF 里画 N 个矩形，比每个事件各画一次快得多，也不会撕裂。
 *
 * ## 为什么 CopyRect 必须自己搬
 * RFB 的设计是「服务端只告诉你"这块内容等于画布上另一块"」，**服务端不持有帧缓冲**。
 * 所以收到 `copyFrom` 时要在**自己的画布上**把源矩形搬到目标位置
 * （`drawImage` 从同一 canvas 取源，规范保证先复制源区域再绘制）。
 * 指望后端给完整画面是错的 —— 那样带宽会翻几十倍。
 *
 * ## 像素格式
 * `pixels` 是 **32bpp little-endian BGRA**，而 `ImageData` 要 **RGBA**，
 * 所以必须把每像素的 B 与 R 换位（A 保持，交给浏览器做合成）。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Events, type ConnectionState } from '@t1000/shared'
import { Badge, Banner, EmptyState } from '../../components/Feedback'
import { Button, IconButton } from '../../components/Button'
import { Icon } from '../../components/Icon'
import { toast } from '../../components/Toast'
import { invoke, subscribe } from '../../lib/ipc'
import { errorText } from '../../lib/format'
import { useStoreShallow } from '../../lib/store'
import './vnc.css'

interface FrameRect {
  x: number
  y: number
  width: number
  height: number
  pixels?: string
  copyFrom?: { x: number; y: number }
}

interface FrameMsg {
  sessionId: string
  framebufferWidth: number
  framebufferHeight: number
  rects: FrameRect[]
}

const STATE_LABEL: Record<string, string> = {
  idle: '空闲',
  connecting: '连接中',
  authenticating: '认证中',
  'verifying-host-key': '校验主机指纹',
  ready: '已连接',
  disconnected: '已断开',
  failed: '失败',
}

/* ── base64 → BGRA 字节 ───────────────────────── */

function base64ToBytes(b64: string): Uint8ClampedArray {
  const bin = atob(b64)
  const out = new Uint8ClampedArray(bin.length)
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i)
  return out
}

/** BGRA → RGBA（原地换位，只换 B 与 R；A 交给浏览器） */
function bgraToRgbaInPlace(bytes: Uint8ClampedArray): void {
  for (let i = 0; i + 3 < bytes.length; i += 4) {
    const b = bytes[i] ?? 0
    bytes[i] = bytes[i + 2] ?? 0
    bytes[i + 2] = b
  }
}

/* ── X11 keysym ───────────────────────────────── */

/**
 * DOM 键 → X11 keysym。
 *
 * RFB 的键盘事件要的是 **keysym**（X11 的键符号），不是 DOM 的 keyCode，
 * 两者数值不同，直接发 keyCode 在远端会打出完全错误的字符。
 */
const SPECIAL_KEYSYMS: Record<string, number> = {
  Backspace: 0xff08,
  Tab: 0xff09,
  Enter: 0xff0d,
  Escape: 0xff1b,
  Delete: 0xffff,
  Insert: 0xff63,
  Home: 0xff50,
  End: 0xff57,
  PageUp: 0xff55,
  PageDown: 0xff56,
  ArrowLeft: 0xff51,
  ArrowUp: 0xff52,
  ArrowRight: 0xff53,
  ArrowDown: 0xff54,
  Shift: 0xffe1,
  Control: 0xffe3,
  Alt: 0xffe9,
  Meta: 0xffe7,
  CapsLock: 0xffe5,
  F1: 0xffbe,
  F2: 0xffbf,
  F3: 0xffc0,
  F4: 0xffc1,
  F5: 0xffc2,
  F6: 0xffc3,
  F7: 0xffc4,
  F8: 0xffc5,
  F9: 0xffc6,
  F10: 0xffc7,
  F11: 0xffc8,
  F12: 0xffc9,
}

function toKeysym(e: React.KeyboardEvent): number | null {
  const special = SPECIAL_KEYSYMS[e.key]
  if (special !== undefined) return special
  // 可打印字符：Latin-1 范围内 keysym == 码点（超出范围时用 Unicode keysym 约定 0x01000000|cp）
  if (e.key.length === 1) {
    const cp = e.key.codePointAt(0)
    if (cp === undefined) return null
    return cp < 0x100 ? cp : 0x01000000 | cp
  }
  return null
}

/** RFB 按钮位掩码：bit0 左、bit1 中、bit2 右 */
function toButtonMask(buttons: number): number {
  let mask = 0
  if (buttons & 1) mask |= 1
  if (buttons & 4) mask |= 2
  if (buttons & 2) mask |= 4
  return mask
}

export interface VncViewerProps {
  sessionId: string | undefined
  title: string
  /** 只读：一个输入事件都不发 */
  viewOnly: boolean
  scaleViewport: boolean
  clipViewport: boolean
}

export function VncViewer({
  sessionId,
  title,
  viewOnly,
  scaleViewport,
  clipViewport,
}: VncViewerProps): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const ctxRef = useRef<CanvasRenderingContext2D | null>(null)
  /** 远端尺寸；画布按原尺寸，显示缩放交给 CSS */
  const sizeRef = useRef<{ w: number; h: number }>({ w: 0, h: 0 })
  /** 待绘制队列：事件只入队，rAF 里一次性画完 */
  const queueRef = useRef<FrameRect[]>([])
  const rafRef = useRef(0)

  const [state, setState] = useState<ConnectionState>('connecting')
  const [message, setMessage] = useState<string | null>(null)
  const [size, setSize] = useState<{ w: number; h: number } | null>(null)
  const [stats, setStats] = useState({ frames: 0, rects: 0 })
  const [clipboard, setClipboard] = useState<string | null>(null)

  const bellMode = useStoreShallow((s) => ({ bell: s.bellMode })).bell

  /* ── 绘制 ─────────────────────────────────────── */

  const flush = useCallback(() => {
    rafRef.current = 0
    const ctx = ctxRef.current
    const canvas = canvasRef.current
    const rects = queueRef.current
    if (!ctx || !canvas || rects.length === 0) return
    queueRef.current = []

    let drawn = 0
    for (const r of rects) {
      try {
        if (r.pixels) {
          const bytes = base64ToBytes(r.pixels)
          bgraToRgbaInPlace(bytes)
          // 用 createImageData + set，而不是 new ImageData(bytes,...)：
          // 后者在 TS 5.9 的 typed-array 泛型下类型不兼容（Uint8ClampedArray<ArrayBufferLike>），
          // 而且 createImageData 由实现分配缓冲，也更贴近 2D 上下文的用法
          const img = ctx.createImageData(r.width, r.height)
          img.data.set(bytes)
          ctx.putImageData(img, r.x, r.y)
          drawn += 1
        } else if (r.copyFrom) {
          // 从**自身画布**取源区域搬到目标位置。
          // 规范保证先复制源区域再绘制，所以源目标重叠也安全（Chromium 实测正确）。
          ctx.drawImage(
            canvas,
            r.copyFrom.x,
            r.copyFrom.y,
            r.width,
            r.height,
            r.x,
            r.y,
            r.width,
            r.height,
          )
          drawn += 1
        }
      } catch {
        // 单个矩形坏掉（尺寸不匹配/数据截断）不该整帧失败
      }
    }
    setStats((s) => ({ frames: s.frames + 1, rects: s.rects + drawn }))
  }, [])

  const enqueue = useCallback(
    (rects: FrameRect[]) => {
      queueRef.current.push(...rects)
      if (rafRef.current === 0) rafRef.current = requestAnimationFrame(flush)
    },
    [flush],
  )

  /* ── 订阅帧（高频路径，不进 store） ───────────── */

  useEffect(() => {
    if (!sessionId) return
    return subscribe(Events.VNC_FRAME, (p: FrameMsg) => {
      if (p.sessionId !== sessionId) return
      const cur = sizeRef.current
      if (cur.w !== p.framebufferWidth || cur.h !== p.framebufferHeight) {
        // 尺寸变化：重建画布（会清空内容，服务端随后会补全屏帧）
        sizeRef.current = { w: p.framebufferWidth, h: p.framebufferHeight }
        const canvas = canvasRef.current
        if (canvas) {
          canvas.width = p.framebufferWidth
          canvas.height = p.framebufferHeight
          ctxRef.current = canvas.getContext('2d')
        }
        setSize({ w: p.framebufferWidth, h: p.framebufferHeight })
      }
      enqueue(p.rects ?? [])
    })
  }, [sessionId, enqueue])

  useEffect(
    () => () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
    },
    [],
  )

  /* ── 状态/错误/剪贴板/响铃 ───────────────────── */

  useEffect(() => {
    if (!sessionId) return
    const offs = [
      subscribe(Events.VNC_STATE, (p) => {
        if (p.sessionId !== sessionId) return
        setState(p.state)
        setMessage(p.message ?? null)
      }),
      subscribe(Events.VNC_ERROR, (p) => {
        if (p.sessionId !== sessionId) return
        setState('failed')
        setMessage(p.message)
      }),
      subscribe(Events.VNC_CLIPBOARD, (p) => {
        if (p.sessionId !== sessionId) return
        setClipboard(p.text)
      }),
      subscribe(Events.VNC_BELL, (p) => {
        if (p.sessionId !== sessionId) return
        // 响铃默认关（有些用户很烦意外响铃），只在设置里开了才真的响
        if (bellMode === 'sound') {
          try {
            const Ctx =
              window.AudioContext ??
              (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
            if (Ctx) {
              const ac = new Ctx()
              const osc = ac.createOscillator()
              const gain = ac.createGain()
              gain.gain.value = 0.04
              osc.frequency.value = 800
              osc.connect(gain).connect(ac.destination)
              osc.start()
              osc.stop(ac.currentTime + 0.08)
            }
          } catch {
            /* 响铃失败无所谓 */
          }
        }
        setMessage('远端发出响铃')
      }),
    ]
    return () => {
      for (const off of offs) off()
    }
  }, [sessionId, bellMode])

  /* ── 输入转发 ─────────────────────────────────── */

  /** 画布坐标：把 DOM 坐标换算回**帧缓冲坐标**（画布可能被 CSS 缩放） */
  const toFb = (e: React.MouseEvent<HTMLCanvasElement>): { x: number; y: number } | null => {
    const canvas = canvasRef.current
    if (!canvas) return null
    const rect = canvas.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return null
    const x = Math.floor(((e.clientX - rect.left) / rect.width) * canvas.width)
    const y = Math.floor(((e.clientY - rect.top) / rect.height) * canvas.height)
    return {
      x: Math.max(0, Math.min(canvas.width - 1, x)),
      y: Math.max(0, Math.min(canvas.height - 1, y)),
    }
  }

  const pointer = (e: React.MouseEvent<HTMLCanvasElement>): void => {
    if (viewOnly || !sessionId) return
    const pos = toFb(e)
    if (!pos) return
    void invoke<'vnc', 'sendPointer', Record<string, unknown>, unknown>('vnc', 'sendPointer', {
      sessionId,
      buttonMask: toButtonMask(e.buttons),
      x: pos.x,
      y: pos.y,
    }).catch(() => undefined)
  }

  const onKey = (e: React.KeyboardEvent, down: boolean): void => {
    if (viewOnly || !sessionId) return
    const keysym = toKeysym(e)
    if (keysym === null) return
    e.preventDefault()
    void invoke<'vnc', 'sendKey', Record<string, unknown>, unknown>('vnc', 'sendKey', {
      sessionId,
      keysym,
      down,
    }).catch(() => undefined)
  }

  /* ── 显示尺寸 ─────────────────────────────────── */

  const canvasStyle = useMemo<React.CSSProperties>(() => {
    if (!size) return {}
    if (clipViewport) return { maxWidth: '100%', maxHeight: '100%' }
    if (scaleViewport) return { width: '100%', height: 'auto' }
    return {}
  }, [size, clipViewport, scaleViewport])

  const ready = state === 'ready'

  return (
    <div className="vnc">
      <div className="t-toolbar">
        <Icon name="eye" size={15} />
        <span className="panel-title">{title}</span>
        <Badge tone={ready ? 'ok' : state === 'failed' ? 'danger' : 'accent'}>
          {STATE_LABEL[state] ?? state}
        </Badge>
        {viewOnly ? <Badge tone="warn">只读（不回送键鼠）</Badge> : null}
        {size ? (
          <span className="term-toolbar__meta">
            {size.w}×{size.h} · 已渲染 {stats.frames} 帧 / {stats.rects} 矩形
          </span>
        ) : null}
        <div className="t-toolbar__spacer" />
        {clipboard !== null ? (
          <Button
            size="sm"
            variant="outline"
            icon="copy"
            title={clipboard.slice(0, 120)}
            onClick={() => {
              void navigator.clipboard.writeText(clipboard)
              toast.ok('已复制远端剪贴板内容')
            }}
          >
            取回剪贴板
          </Button>
        ) : null}
        <IconButton icon="refresh" label="重新连接" onClick={() => window.location.reload()} />
      </div>

      {state === 'failed' ? (
        <div style={{ padding: '10px 12px 0' }}>
          <Banner tone="error">连接失败：{message ?? '未知原因'}</Banner>
        </div>
      ) : null}

      <div className="vnc-stage">
        {/*
          画布尺寸 = 远端帧缓冲尺寸（原尺寸），显示缩放交给 CSS：
          这样 CopyRect / putImageData 的坐标与远端完全一致，不需要到处换算缩放。
        */}
        <canvas
          ref={canvasRef}
          className={`vnc-canvas${ready ? '' : ' vnc-canvas--hidden'}`}
          style={canvasStyle}
          tabIndex={0}
          onMouseDown={(e) => {
            e.currentTarget.focus()
            pointer(e)
          }}
          onMouseUp={pointer}
          onMouseMove={(e) => {
            // 只在按下状态逐像素上报：松开时移动鼠标没必要打爆 IPC
            if (e.buttons !== 0) pointer(e)
          }}
          onContextMenu={(e) => e.preventDefault()}
          onKeyDown={(e) => onKey(e, true)}
          onKeyUp={(e) => onKey(e, false)}
        />

        {!ready ? (
          <div className="vnc-overlay">
            {state === 'failed' ? (
              <EmptyState
                icon="alert-triangle"
                title="画面不可用"
                text={message ?? '连接失败或已断开。'}
              />
            ) : (
              <div className="t-loading">
                <span className="t-spinner" aria-hidden />
                <span>{STATE_LABEL[state] ?? state}…</span>
              </div>
            )}
          </div>
        ) : null}
      </div>

      <div className="term-pane__status">
        <span>{viewOnly ? '只读模式：不会发送任何键鼠事件' : '鼠标键盘已转发（X11 keysym）'}</span>
        <div style={{ flex: 1 }} />
        <span>缩放 {scaleViewport ? '自适应' : '原始'} · {clipViewport ? '裁剪' : '不裁剪'}</span>
      </div>
    </div>
  )
}

/** 连接一个 VNC 连接并返回 sessionId（供工作区调用） */
export async function connectVnc(connection: unknown): Promise<{
  sessionId: string
  scaleViewport: boolean
  clipViewport: boolean
} | null> {
  try {
    const res = await invoke<
      'vnc',
      'connect',
      { connection: unknown },
      { sessionId: string; scaleViewport?: boolean; clipViewport?: boolean }
    >('vnc', 'connect', { connection })
    return {
      sessionId: res.sessionId,
      scaleViewport: res.scaleViewport === true,
      clipViewport: res.clipViewport === true,
    }
  } catch (err) {
    toast.error(`VNC 连接失败：${errorText(err)}`)
    return null
  }
}

export default VncViewer
