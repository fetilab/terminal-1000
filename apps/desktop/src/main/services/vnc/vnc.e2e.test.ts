// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * VNC **真实服务端**端到端验证。
 *
 * 与同目录的单元测试不同：这里连的是一个**真实运行的 RFB 服务端**，
 * 走真实的 TCP、真实握手、真实 VNC 认证（DES）、真实帧缓冲更新。
 *
 * 默认**跳过**（需要外部环境），用环境变量开启：
 *
 *   T1000_VNC_E2E=192.168.1.187:5901 T1000_VNC_PASSWORD=xxxxxxxx \
 *     pnpm exec vitest run src/main/services/vnc/vnc.e2e.test.ts
 *
 * 为什么做成门控测试而不是普通脚本：它在仓库里可被发现、可重复运行，
 * 又不会让日常 `pnpm test` 依赖外部机器。
 *
 * 本机实测环境（192.168.1.187）：tigervnc-standalone-server 1.15.0 起在 :1（5901），
 * 会话为 LXQt，分辨率 1280x800。
 */

import { describe, expect, it } from 'vitest'
import { writeFileSync } from 'node:fs'
import type { ConnectionState } from '@t1000/shared'
import { VncManager, type VncEventSink, type VncFrame } from './index'

const target = process.env.T1000_VNC_E2E
const password = process.env.T1000_VNC_PASSWORD ?? ''

/** 有真实目标才跑；没有就整体跳过（不报失败，避免 CI 依赖外部机器） */
const d = target ? describe : describe.skip

/** 把若干帧矩形合成到一张 RGBA 画布（模拟渲染层要做的事） */
class Canvas {
  readonly rgba: Uint8Array
  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    this.rgba = new Uint8Array(width * height * 4)
  }

  applyFrame(frame: VncFrame): void {
    for (const r of frame.rects) {
      if (r.copyFrom) {
        // CopyRect：从画布自身搬运（后端不持有帧缓冲，这是 RFB 的设计本意）
        const src = this.snapshot(r.copyFrom.x, r.copyFrom.y, r.width, r.height)
        this.blit(src, r.x, r.y, r.width, r.height)
        continue
      }
      if (!r.pixels) continue
      const buf = Buffer.from(r.pixels, 'base64')
      for (let row = 0; row < r.height; row++) {
        for (let col = 0; col < r.width; col++) {
          const s = (row * r.width + col) * 4
          const dx = r.x + col
          const dy = r.y + row
          if (dx < 0 || dy < 0 || dx >= this.width || dy >= this.height) continue
          const t = (dy * this.width + dx) * 4
          // RFB 默认像素格式是 BGRA，ImageData/RGBA 需要换位
          this.rgba[t] = buf[s + 2]! // R
          this.rgba[t + 1] = buf[s + 1]! // G
          this.rgba[t + 2] = buf[s]! // B
          this.rgba[t + 3] = 255
        }
      }
    }
  }

  private snapshot(x: number, y: number, w: number, h: number): Uint8Array {
    const out = new Uint8Array(w * h * 4)
    for (let row = 0; row < h; row++) {
      for (let col = 0; col < w; col++) {
        const sx = x + col
        const sy = y + row
        if (sx < 0 || sy < 0 || sx >= this.width || sy >= this.height) continue
        const s = (sy * this.width + sx) * 4
        const t = (row * w + col) * 4
        out.set(this.rgba.subarray(s, s + 4), t)
      }
    }
    return out
  }

  private blit(src: Uint8Array, x: number, y: number, w: number, h: number): void {
    for (let row = 0; row < h; row++) {
      for (let col = 0; col < w; col++) {
        const dx = x + col
        const dy = y + row
        if (dx < 0 || dy < 0 || dx >= this.width || dy >= this.height) continue
        const s = (row * w + col) * 4
        const t = (dy * this.width + dx) * 4
        this.rgba.set(src.subarray(s, s + 4), t)
      }
    }
  }

  /** 统计非黑像素比例（用于判断"真的画出了东西"而不是一片空白） */
  nonBlackRatio(): number {
    let n = 0
    for (let i = 0; i < this.rgba.length; i += 4) {
      if (this.rgba[i]! > 8 || this.rgba[i + 1]! > 8 || this.rgba[i + 2]! > 8) n++
    }
    return n / (this.width * this.height)
  }

  /** 输出 PPM（trivial 格式），便于用 ImageMagick 转 PNG 肉眼确认 */
  toPpm(): Buffer {
    const header = Buffer.from(`P6\n${this.width} ${this.height}\n255\n`, 'ascii')
    const body = Buffer.alloc(this.width * this.height * 3)
    for (let i = 0, j = 0; i < this.rgba.length; i += 4, j += 3) {
      body[j] = this.rgba[i]!
      body[j + 1] = this.rgba[i + 1]!
      body[j + 2] = this.rgba[i + 2]!
    }
    return Buffer.concat([header, body])
  }
}

d('VNC 真实服务端端到端', () => {
  it(
    '完成真实 RFB 握手 + 认证 + 收到帧缓冲，并能合成出画面',
    async () => {
      const [host, portStr] = target!.split(':')
      const port = Number(portStr)

      const states: Array<{ state: ConnectionState; message?: string }> = []
      const frames: VncFrame[] = []
      const errors: string[] = []

      let resolveReady: (() => void) | undefined
      let resolveFrame: (() => void) | undefined
      const ready = new Promise<void>((r) => (resolveReady = r))
      const gotFrame = new Promise<void>((r) => (resolveFrame = r))

      const sink: VncEventSink = {
        state(sessionId, state, message) {
          states.push(message === undefined ? { state } : { state, message })
          if (state === 'ready') resolveReady?.()
          if (state === 'failed' || state === 'disconnected') resolveReady?.()
        },
        frame(sessionId, frame) {
          frames.push(frame)
          resolveFrame?.()
        },
        clipboard() {},
        bell() {},
        error(sessionId, message) {
          errors.push(message)
        },
      }

      // 打开 T1000_VNC_DEBUG=1 时记录真实字节流（诊断"握手成功但收不到帧"这类问题）
      const debug = process.env.T1000_VNC_DEBUG === '1'
      const createSocket = debug
        ? (opts: { host: string; port: number }) => {
            const s = new (require('node:net').Socket)()
            const origWrite = s.write.bind(s)
            let sent = 0
            let recv = 0
            s.write = ((data: Buffer, ...rest: unknown[]) => {
              sent += Buffer.byteLength(data as never)
              const head = Buffer.from(data as never).subarray(0, Math.min(12, Buffer.byteLength(data as never)))
              // eslint-disable-next-line no-console
              console.log(`  → 发送 ${Buffer.byteLength(data as never)}B [${head.toString('hex')}] (累计 ${sent})`)
              return origWrite(data, ...(rest as never[]))
            }) as never
            s.on('data', (d: Buffer) => {
              recv += d.length
              // eslint-disable-next-line no-console
              console.log(`  ← 收到 ${d.length}B [${d.subarray(0, Math.min(12, d.length)).toString('hex')}] (累计 ${recv})`)
            })
            s.connect(opts.port, opts.host)
            return s as never
          }
        : undefined

      const manager = new VncManager({ sink, ...(createSocket ? { createSocket } : {}) })
      const { sessionId } = manager.connect({
        kind: 'vnc',
        id: 'e2e-vnc',
        name: 'e2e',
        host: host!,
        port,
        authType: password ? 'vnc-password' : 'none',
        ...(password ? { password } : {}),
        shared: true,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      })

      // 等握手完成（ready 或 failed 都会 resolve，由断言区分）
      await Promise.race([
        ready,
        new Promise((_, rej) => setTimeout(() => rej(new Error('握手超时（15s）')), 15_000)),
      ])

      const finalState = states[states.length - 1]
      expect(
        finalState?.state,
        `握手未成功：${JSON.stringify(states)} 错误=${errors.join('|')}`,
      ).toBe('ready')

      // 等第一帧（服务端在收到 FramebufferUpdateRequest 后才会发）
      await Promise.race([
        gotFrame,
        new Promise((_, rej) => setTimeout(() => rej(new Error('等待首帧超时（20s）')), 20_000)),
      ])

      const first = frames[0]!
      expect(first.framebufferWidth).toBeGreaterThan(0)
      expect(first.framebufferHeight).toBeGreaterThan(0)
      expect(first.rects.length).toBeGreaterThan(0)

      const canvas = new Canvas(first.framebufferWidth, first.framebufferHeight)
      for (const f of frames) canvas.applyFrame(f)

      // 真实桌面上一定不是纯黑（LXQt 面板/壁纸）
      const ratio = canvas.nonBlackRatio()
      expect(ratio, `画面几乎全黑（非黑像素占比 ${ratio.toFixed(4)}），可能帧解析有问题`).toBeGreaterThan(0.05)

      // 落盘供肉眼确认
      const out = process.env.T1000_VNC_E2E_OUT ?? '/tmp/t1000-vnc-e2e.ppm'
      writeFileSync(out, canvas.toPpm())

      // eslint-disable-next-line no-console
      console.log(
        `[VNC E2E] ${host}:${port} → 分辨率 ${first.framebufferWidth}x${first.framebufferHeight}，` +
          `收到 ${frames.length} 帧 / ${frames.reduce((n, f) => n + f.rects.length, 0)} 个矩形，` +
          `非黑像素占比 ${(ratio * 100).toFixed(1)}%，画面已写入 ${out}`,
      )

      manager.disconnect(sessionId)
    },
    60_000,
  )
})
