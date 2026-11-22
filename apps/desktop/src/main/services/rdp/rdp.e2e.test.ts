// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * RDP **真机**验证。
 *
 * 我们的 RDP 实现刻意很薄：**不自己实现 RDP 协议**，而是拉起外部 FreeRDP 客户端
 * （画面出现在它自己的独立窗口）。所以我们自己负责的部分是：
 * 二进制探测 → 参数映射 → 进程生命周期与状态上报 → 缺客户端时的可操作提示。
 *
 * 本文件验证的就是这几件事在**真实机器**上的行为。
 *
 * 两段：
 * 1. **始终运行**：真实探测本机有没有 FreeRDP 客户端；
 *    若没有，断言给出的提示是**可操作**的（含安装命令）—— 这条路径用户一定会遇到。
 * 2. **门控**（`T1000_RDP_E2E=host:port`）：对真实 xrdp 服务端发起启动，
 *    验证进程真的被拉起、以及退出状态被如实上报。
 *
 * 实测环境：本地主机部署了 xrdp 0.10.1（3389）。
 *
 * 注意：本机（开发机）目前**只有 Wayland 版 `wlfreerdp`，没有 X11 版 `xfreerdp`**。
 * 我们的无头验证环境是 Xvfb（X11），所以真实"弹出窗口"那一步需要先装 `freerdp-x11`。
 * 在装上之前，第 2 段会走"缺客户端"分支并**如实断言该分支的行为**，而不是假装通过。
 */

import { describe, expect, it } from 'vitest'
import { RDP_BINARY_CANDIDATES, RdpManager, findRdpBinary, rdpInstallHint, type RdpEventSink } from './index'

describe('RDP 真机环境探测', () => {
  it('报告本机实际可用的 FreeRDP 客户端（真实探测，不是 mock）', () => {
    const found = findRdpBinary()
    // eslint-disable-next-line no-console
    console.log(
      `[RDP] 候选 ${RDP_BINARY_CANDIDATES.join(' / ')} → ` +
        (found ? `找到 ${found}` : '一个都没找到'),
    )
    // 不强制要求存在（不同机器环境不同），但必须给出确定结论而不是抛错
    expect(found === null || typeof found === 'string').toBe(true)
  })

  it('★ 缺客户端时给出的是可操作提示（含安装命令），而不是笼统失败', () => {
    const hint = rdpInstallHint()
    expect(hint.length).toBeGreaterThan(0)
    // 必须能照着装：至少给出一种包管理器命令
    expect(hint).toMatch(/apt|dnf|pacman|zypper/)
    // 必须说明"未检测到"这个前因，否则用户不知道为什么要装
    expect(hint).toMatch(/未检测到|未找到/)
  })
})

const target = process.env.T1000_RDP_E2E
const d = target ? describe : describe.skip

d('RDP 对真实服务端启动', () => {
  it(
    '真实拉起外部客户端并如实上报生命周期',
    async () => {
      const [host, portStr] = target!.split(':')
      const port = Number(portStr)

      const states: Array<{ state: string; message?: string }> = []
      const exits: Array<{ code: number | null; signal: string | null; crashed: boolean }> = []
      const errors: string[] = []

      const sink: RdpEventSink = {
        state(_id, state, message) {
          states.push(message === undefined ? { state } : { state, message })
        },
        exit(_id, info) {
          exits.push(info)
        },
      }

      const manager = new RdpManager({ sink })
      const binary = findRdpBinary()

      if (!binary) {
        // 没有客户端：必须抛 UNSUPPORTED 且带安装命令 ——
        // 这是**真实会发生的路径**，不能静默失败
        let caught: unknown
        try {
          manager.connect({
            kind: 'rdp',
            id: 'e2e-rdp',
            name: 'e2e',
            host: host!,
            port,
            username: 'rdp-user',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          })
        } catch (err) {
          caught = err
        }
        expect(caught, '没有 FreeRDP 时 connect 必须报错，而不是假装连上了').toBeDefined()
        const message = caught instanceof Error ? caught.message : String(caught)
        expect(message).toMatch(/FreeRDP|xfreerdp/)
        expect(message).toMatch(/apt|dnf|pacman/)
        // eslint-disable-next-line no-console
        console.log(`[RDP E2E] 本机缺客户端，已如实报错：\n${message}`)
        return
      }

      // 有客户端：真拉起，连真实服务端
      manager.connect({
        kind: 'rdp',
        id: 'e2e-rdp',
        name: 'e2e',
        host: host!,
        port,
        username: 'rdp-user',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      })

      await new Promise((r) => setTimeout(r, 3000))

      const started = states.some((s) => s.state === 'connecting' || s.state === 'ready')
      expect(started, `未观察到启动状态：${JSON.stringify(states)}`).toBe(true)

      const alive = manager.list().length > 0
      if (alive) {
        // 进程还活着：主动结束，验证**不会**被误报成崩溃
        for (const s of manager.list()) manager.disconnect(s.sessionId)
        await new Promise((r) => setTimeout(r, 800))
        for (const e of exits) {
          expect(e.crashed, `主动断开不应被报成崩溃：${JSON.stringify(e)}`).toBe(false)
        }
      } else {
        // 进程已自己退出：此时 crashed=true 是**正确**的，但要保证
        // ① 退出码被如实上报 ② 状态信息里给出可操作的原因（而不是只有一个数字）
        expect(exits.length, `进程已退出但未上报 exit：${JSON.stringify(states)}`).toBeGreaterThan(0)
        const last = exits[exits.length - 1]!
        expect(last.crashed).toBe(true)
        expect(last.code, '退出码必须如实上报').not.toBeNull()
        const msg = states.map((s) => s.message ?? '').join('\n')
        expect(msg, `异常退出应给出原因，实际：${msg}`).toMatch(/异常退出|提示/)
        // eslint-disable-next-line no-console
        console.log(`[RDP E2E] 客户端 ${binary} 秒退(code=${last.code})，已如实上报并附原因:\n${msg}`)
      }
    },
    30_000,
  )
})
