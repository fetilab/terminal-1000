// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * VNC 端到端（**默认运行**）：真实 loopback TCP + 仓库内 RFB 服务端夹具。
 *
 * 与 `vnc.e2e.test.ts` 的分工：
 * - 本文件默认跑，确定性地覆盖握手 / 认证 / 帧缓冲 / 剪贴板 / 输入的**完整链路**，
 *   不依赖任何外部机器，也不发起对外网络连接（夹具只监听 127.0.0.1）。
 * - `vnc.e2e.test.ts` 保留 `T1000_VNC_E2E` 门控，继续用于真实服务端（tigervnc）验收。
 *
 * DES 独立的锚点：VNC 认证的期望应答常量由 PyCryptodome（独立于本仓库的实现）算出，
 * 见 `INDEPENDENT_VNC_AUTH_RESPONSE`；产品侧 DES 另有 OpenSSL 参考向量单测。
 */

import { afterEach, describe, expect, it } from 'vitest'
import type { ConnectionState, VncConnection } from '@t1000/shared'
import { VncManager, type VncEventSink, type VncFrame } from './index'
import { RfbServerFixture, type FixtureRect } from '../../../../test-fixtures/rfb-server-fixture'

// ---------------------------------------------------------------------------
// 脚手架
// ---------------------------------------------------------------------------

/**
 * PyCryptodome 独立计算的 VNC 认证应答：
 * password='secret'、challenge=0102030405060708090a0b0c0d0e0f10
 * 密钥 = 口令补零到 8 字节后每字节位序反转（cea6c64ea62e0000）。
 */
const INDEPENDENT_VNC_AUTH_RESPONSE = 'f673f0480e266b44506989354479bd95'

function vncConnection(patch: Partial<VncConnection> = {}): VncConnection {
  const now = '2026-01-01T00:00:00.000Z'
  return {
    kind: 'vnc',
    id: 'fixture-vnc',
    name: 'fixture',
    host: '127.0.0.1',
    port: 5900,
    authType: 'none',
    shared: true,
    createdAt: now,
    updatedAt: now,
    ...patch,
  }
}

interface Harness {
  manager: VncManager
  sessionId: string
  states: Array<{ state: ConnectionState; message?: string }>
  frames: VncFrame[]
  bells: number
  clipboards: string[]
  errors: string[]
}

const fixtures: RfbServerFixture[] = []
const managers: VncManager[] = []

afterEach(async () => {
  for (const manager of managers.splice(0)) manager.shutdown()
  for (const fixture of fixtures.splice(0)) await fixture.close()
})

function connectTo(fixture: RfbServerFixture, patch: Partial<VncConnection> = {}): Harness {
  const states: Harness['states'] = []
  const frames: VncFrame[] = []
  const clipboards: string[] = []
  const errors: string[] = []
  const harness: Harness = {
    manager: undefined as unknown as VncManager,
    sessionId: '',
    states,
    frames,
    bells: 0,
    clipboards,
    errors,
  }

  const sink: VncEventSink = {
    state(_id, state, message) {
      states.push(message === undefined ? { state } : { state, message })
    },
    frame(_id, frame) {
      frames.push(frame)
    },
    clipboard(_id, text) {
      clipboards.push(text)
    },
    bell() {
      harness.bells += 1
    },
    error(_id, message) {
      errors.push(message)
    },
  }

  const manager = new VncManager({ sink })
  managers.push(manager)
  harness.manager = manager
  harness.sessionId = manager.connect(vncConnection({ port: fixture.port, ...patch })).sessionId
  return harness
}

async function waitFor(predicate: () => boolean, what: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`等待超时：${what}`)
}

function isTerminal(state: ConnectionState): boolean {
  return state === 'failed' || state === 'disconnected'
}

/** 把若干帧矩形合成到 RGBA 画布（BGRA → RGBA 换位；CopyRect 从画布自身搬运） */
class RgbaCanvas {
  readonly rgba: Uint8Array

  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    this.rgba = new Uint8Array(width * height * 4)
  }

  applyFrame(frame: VncFrame): void {
    for (const rect of frame.rects) {
      if (rect.copyFrom !== undefined) {
        const src = this.snapshot(rect.copyFrom.x, rect.copyFrom.y, rect.width, rect.height)
        this.blit(src, rect.x, rect.y, rect.width, rect.height)
        continue
      }
      if (rect.pixels === undefined) continue
      const buf = Buffer.from(rect.pixels, 'base64')
      for (let row = 0; row < rect.height; row += 1) {
        for (let col = 0; col < rect.width; col += 1) {
          const s = (row * rect.width + col) * 4
          const dx = rect.x + col
          const dy = rect.y + row
          if (dx < 0 || dy < 0 || dx >= this.width || dy >= this.height) continue
          const t = (dy * this.width + dx) * 4
          this.rgba[t] = buf[s + 2] as number
          this.rgba[t + 1] = buf[s + 1] as number
          this.rgba[t + 2] = buf[s] as number
          this.rgba[t + 3] = 255
        }
      }
    }
  }

  pixelAt(x: number, y: number): [number, number, number] {
    const t = (y * this.width + x) * 4
    return [this.rgba[t] as number, this.rgba[t + 1] as number, this.rgba[t + 2] as number]
  }

  private snapshot(x: number, y: number, w: number, h: number): Uint8Array {
    const out = new Uint8Array(w * h * 4)
    for (let row = 0; row < h; row += 1) {
      for (let col = 0; col < w; col += 1) {
        const sx = x + col
        const sy = y + row
        if (sx < 0 || sy < 0 || sx >= this.width || sy >= this.height) continue
        out.set(this.rgba.subarray((sy * this.width + sx) * 4, (sy * this.width + sx) * 4 + 4), (row * w + col) * 4)
      }
    }
    return out
  }

  private blit(src: Uint8Array, x: number, y: number, w: number, h: number): void {
    for (let row = 0; row < h; row += 1) {
      for (let col = 0; col < w; col += 1) {
        const dx = x + col
        const dy = y + row
        if (dx < 0 || dy < 0 || dx >= this.width || dy >= this.height) continue
        const s = (row * w + col) * 4
        this.rgba.set(src.subarray(s, s + 4), (dy * this.width + dx) * 4)
      }
    }
  }
}

// ---------------------------------------------------------------------------

describe('VNC 端到端（进程内 RFB 服务端夹具，默认运行）', () => {
  it('None 安全类型：握手 → ServerInit → Raw 首帧，并按 32bpp BGRA 还原画面', async () => {
    const fixture = await RfbServerFixture.start({ width: 64, height: 48, name: 'none-desktop' })
    fixtures.push(fixture)
    // 夹具只绑回环：这条测试不依赖也不暴露任何对外网络
    expect(fixture.address).toBe('127.0.0.1')

    const h = connectTo(fixture, { authType: 'none', shared: true })
    await waitFor(() => h.states.some((s) => s.state === 'ready'), '握手完成')
    await waitFor(() => h.frames.length >= 1, '首帧')

    // 线路层：版本串、安全类型、shared 标志
    expect(fixture.clientVersions).toEqual(['RFB 003.008\n'])
    expect(fixture.securitySelections).toEqual([1])
    expect(fixture.clientInitShared).toEqual([true])
    expect(h.errors).toEqual([])

    // SetEncodings：Raw / CopyRect / Hextile + DesktopSize / LastRect 伪编码
    expect(fixture.requestedEncodings).toEqual([1, 5, 0, -223, -224])
    // 首次请求是整屏非增量
    expect(fixture.fbUpdateRequests[0]).toEqual({
      incremental: false,
      x: 0,
      y: 0,
      width: 64,
      height: 48,
    })

    const first = h.frames[0]!
    expect(first.framebufferWidth).toBe(64)
    expect(first.framebufferHeight).toBe(48)
    expect(first.rects).toHaveLength(1)

    const canvas = new RgbaCanvas(first.framebufferWidth, first.framebufferHeight)
    canvas.applyFrame(first)
    expect(canvas.pixelAt(0, 0)).toEqual([0x20, 0x40, 0x80])
    expect(canvas.pixelAt(63, 47)).toEqual([0x20, 0x40, 0x80])

    // 收到帧后客户端会继续要增量更新（否则服务端发完一帧就停）
    await waitFor(() => fixture.fbUpdateRequests.some((r) => r.incremental), '增量更新请求')
    expect(h.manager.list()[0]?.state).toBe('ready')
  })

  it('VNC 认证（DES challenge/response）：应答与独立实现完全一致', async () => {
    const fixture = await RfbServerFixture.start({ password: 'secret' })
    fixtures.push(fixture)

    const h = connectTo(fixture, { authType: 'vnc-password', password: 'secret' })
    await waitFor(() => h.states.some((s) => s.state === 'ready'), '认证后 ready')

    expect(fixture.securitySelections).toEqual([2])
    expect(fixture.authFailures).toBe(0)
    expect(fixture.authResponses).toHaveLength(1)
    // 独立（PyCryptodome）算出的期望应答
    expect(fixture.authResponses[0]!.toString('hex')).toBe(INDEPENDENT_VNC_AUTH_RESPONSE)
    expect(h.errors).toEqual([])
    // 认证阶段必须经过 authenticating
    expect(h.states.map((s) => s.state)).toContain('authenticating')
  })

  it('★ 口令错误：认证失败如实上报（带服务端原因），绝不进入 ready', async () => {
    const fixture = await RfbServerFixture.start({ password: 'secret' })
    fixtures.push(fixture)

    const h = connectTo(fixture, { authType: 'vnc-password', password: 'wrong-password' })
    await waitFor(() => h.states.some((s) => isTerminal(s.state)), '认证失败终止')

    expect(fixture.authFailures).toBe(1)
    expect(fixture.authResponses[0]!.toString('hex')).not.toBe(INDEPENDENT_VNC_AUTH_RESPONSE)
    expect(h.states.some((s) => s.state === 'ready')).toBe(false)
    expect(h.states[h.states.length - 1]?.state).toBe('failed')
    expect(h.errors[0]).toMatch(/认证失败/)
    expect(h.errors[0]).toMatch(/Authentication failure/)
  })

  it('服务端给 16bpp 时：客户端回 SetPixelFormat(32bpp)，其后 Raw 按其请求格式解析', async () => {
    const { FIXTURE_FORMAT_16BPP } = await import('../../../../test-fixtures/rfb-server-fixture')
    const fixture = await RfbServerFixture.start({ width: 32, height: 24, pixelFormat: FIXTURE_FORMAT_16BPP })
    fixtures.push(fixture)

    const h = connectTo(fixture, { authType: 'none' })
    await waitFor(() => h.frames.length >= 1, '首帧')

    expect(fixture.pixelFormatRequests).toHaveLength(1)
    const requested = fixture.pixelFormatRequests[0]!
    expect(requested.bitsPerPixel).toBe(32)
    expect(requested.depth).toBe(24)
    expect(requested.bigEndian).toBe(false)
    expect(requested.trueColour).toBe(true)
    expect([requested.redMax, requested.greenMax, requested.blueMax]).toEqual([255, 255, 255])
    expect([requested.redShift, requested.greenShift, requested.blueShift]).toEqual([16, 8, 0])

    const first = h.frames[0]!
    const rect = first.rects[0]!
    expect(Buffer.from(rect.pixels ?? '', 'base64')).toHaveLength(32 * 24 * 4)
    const canvas = new RgbaCanvas(32, 24)
    canvas.applyFrame(first)
    expect(canvas.pixelAt(31, 23)).toEqual([0x20, 0x40, 0x80])
    expect(h.errors).toEqual([])
  })

  it('CopyRect：只携带源坐标，渲染层在自身画布上搬运', async () => {
    const rects: FixtureRect[] = [
      { kind: 'raw', x: 0, y: 0, width: 16, height: 16, color: { r: 255, g: 0, b: 0 } },
      { kind: 'raw', x: 32, y: 0, width: 16, height: 16, color: { r: 0, g: 0, b: 255 } },
    ]
    const fixture = await RfbServerFixture.start({ width: 64, height: 32, initialRects: rects })
    fixtures.push(fixture)

    const h = connectTo(fixture, { authType: 'none' })
    await waitFor(() => h.frames.length >= 1, '首帧')

    const canvas = new RgbaCanvas(64, 32)
    canvas.applyFrame(h.frames[0]!)
    expect(canvas.pixelAt(0, 0)).toEqual([255, 0, 0])
    expect(canvas.pixelAt(32, 0)).toEqual([0, 0, 255])

    fixture.sendUpdate([{ kind: 'copyRect', x: 32, y: 0, width: 16, height: 16, srcX: 0, srcY: 0 }])
    await waitFor(() => h.frames.length >= 2, 'CopyRect 帧')

    const copy = h.frames[1]!.rects[0]!
    expect(copy.copyFrom).toEqual({ x: 0, y: 0 })
    expect(copy.pixels).toBeUndefined()
    canvas.applyFrame(h.frames[1]!)
    expect(canvas.pixelAt(32, 0)).toEqual([255, 0, 0])
    expect(canvas.pixelAt(47, 15)).toEqual([255, 0, 0])
  })

  it('矩形数 0xFFFF + LastRect：真实服务端（TigerVNC）的结束约定', async () => {
    const rects: FixtureRect[] = [
      { kind: 'raw', x: 0, y: 0, width: 8, height: 8, color: { r: 10, g: 20, b: 30 } },
      { kind: 'raw', x: 8, y: 0, width: 8, height: 8, color: { r: 40, g: 50, b: 60 } },
    ]
    const fixture = await RfbServerFixture.start({ width: 16, height: 8, useLastRect: true, initialRects: rects })
    fixtures.push(fixture)

    const h = connectTo(fixture, { authType: 'none' })
    await waitFor(() => h.frames.length >= 1, 'LastRect 结束的首帧')

    expect(h.frames[0]!.rects).toHaveLength(2)
    expect(h.errors).toEqual([])
  })

  it('画质/压缩伪编码：QualityLevel / CompressLevel 及其参数确实上线', async () => {
    const fixture = await RfbServerFixture.start()
    fixtures.push(fixture)

    const h = connectTo(fixture, { authType: 'none', qualityLevel: 7, compressionLevel: 3 })
    await waitFor(() => fixture.requestedEncodings.length > 0, 'SetEncodings')

    expect(fixture.requestedEncodings).toEqual([1, 5, 0, -256, -247, -223, -224])
    expect(fixture.encodingLevels).toEqual([
      { encoding: -256, value: 7 },
      { encoding: -247, value: 3 },
    ])
    expect(h.errors).toEqual([])
  })

  it('剪贴板双向：ServerCutText → clipboard 事件；ClientCutText → 服务端按 UTF-8 长度收全', async () => {
    const fixture = await RfbServerFixture.start()
    fixtures.push(fixture)

    const h = connectTo(fixture, { authType: 'none' })
    await waitFor(() => h.states.some((s) => s.state === 'ready'), 'ready')

    const remoteText = '远端剪贴板 ✓ 多字节'
    fixture.sendCutText(remoteText)
    await waitFor(() => h.clipboards.length >= 1, 'ServerCutText')
    expect(h.clipboards[0]).toBe(remoteText)

    const localText = '本地→远端 ✓ 剪贴板'
    expect(h.manager.sendClipboard(h.sessionId, localText)).toEqual({ sent: true })
    await waitFor(() => fixture.cutTexts.length >= 1, 'ClientCutText')
    // 长度字段按字节数（多字节字符不能被按字符截断）
    expect(fixture.cutTexts[0]).toBe(localText)
    expect(Buffer.byteLength(localText, 'utf8')).toBeGreaterThan(localText.length)
  })

  it('Bell 与输入事件：PointerEvent / KeyEvent 的线上字形正确', async () => {
    const fixture = await RfbServerFixture.start()
    fixtures.push(fixture)

    const h = connectTo(fixture, { authType: 'none' })
    await waitFor(() => h.states.some((s) => s.state === 'ready'), 'ready')

    fixture.sendBell()
    await waitFor(() => h.bells >= 1, 'Bell')

    expect(h.manager.sendPointer(h.sessionId, 0b00000101, 12, 34)).toEqual({ sent: true })
    await waitFor(() => fixture.pointerEvents.length >= 1, 'PointerEvent')
    expect(fixture.pointerEvents[0]).toEqual({ buttonMask: 0b00000101, x: 12, y: 34 })

    expect(h.manager.sendKey(h.sessionId, true, 0xff0d)).toEqual({ sent: true })
    expect(h.manager.sendKey(h.sessionId, false, 0xff0d)).toEqual({ sent: true })
    await waitFor(() => fixture.keyEvents.length >= 2, 'KeyEvent')
    expect(fixture.keyEvents).toEqual([
      { down: true, keysym: 0xff0d },
      { down: false, keysym: 0xff0d },
    ])
    expect(h.errors).toEqual([])
  })

  it('viewOnly：键鼠与剪贴板都被忽略，且一个字节也不上线', async () => {
    const fixture = await RfbServerFixture.start()
    fixtures.push(fixture)

    const h = connectTo(fixture, { authType: 'none', viewOnly: true })
    await waitFor(() => h.states.some((s) => s.state === 'ready'), 'ready')

    expect(h.manager.sendPointer(h.sessionId, 1, 5, 5)).toEqual({ sent: false, ignored: 'viewOnly' })
    expect(h.manager.sendKey(h.sessionId, true, 0x41)).toEqual({ sent: false, ignored: 'viewOnly' })
    expect(h.manager.sendClipboard(h.sessionId, '不应发出')).toEqual({ sent: false })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(fixture.pointerEvents).toEqual([])
    expect(fixture.keyEvents).toEqual([])
    expect(fixture.cutTexts).toEqual([])
  })

  it('服务端主动断开：客户端如实上报 disconnected（不误报 failed）', async () => {
    const fixture = await RfbServerFixture.start()
    fixtures.push(fixture)

    const h = connectTo(fixture, { authType: 'none' })
    await waitFor(() => h.states.some((s) => s.state === 'ready'), 'ready')

    fixture.dropConnections()
    await waitFor(() => h.states.some((s) => s.state === 'disconnected'), 'disconnected')
    expect(h.states.some((s) => s.state === 'failed')).toBe(false)
  })
})
