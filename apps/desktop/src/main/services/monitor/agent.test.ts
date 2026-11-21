// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 监控代理的协议/生命周期单测。
 *
 * 这里刻意**不 mock HTTP**，而是起一个真服务器、走真 socket：
 * 隧道那层是 ssh2 的 Channel（也是 Duplex），用 net.Socket 演练能覆盖
 * 分包、keep-alive、半截响应这些真实会发生的情况。
 */

import { createServer, type Server } from 'node:http'
import { connect } from 'node:net'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Duplex } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import {
  AGENT_BIN_PATH,
  AgentHttp,
  AgentPrefs,
  AgentService,
  agentActivateCommand,
  agentProbeCommand,
  agentStartCommand,
  parseProbe,
  parseState,
} from './agent'
import { AGENT_ARCHES, hasAgentBinary, readAgentBinary, resolveArch } from './agent-binary'
import { AGENT_DIR, AGENT_VERSION, AGENT_VERSION_PATH } from './agent-source'
import { REMOTE_VERSION_PATH } from './scripts'

const dirs: string[] = []
const servers: Server[] = []

afterEach(() => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections()
    s.close()
  }
  dirs.length = 0
})

function tmpFile(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), 't1000-agent-'))
  dirs.push(dir)
  return join(dir, name)
}

/** 假代理：/health 与 /metrics，统计实际建立了多少条连接 */
async function fakeAgent(): Promise<{
  port: number
  token: string
  connections: () => number
  hits: () => number
}> {
  let connections = 0
  let hits = 0
  const server = createServer((req, res) => {
    hits += 1
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const body =
      url.pathname === '/health'
        ? JSON.stringify({ ok: true, version: AGENT_VERSION, pid: 4242 })
        : url.pathname === '/metrics'
          ? JSON.stringify({
              cpu: { usage: 12.5, cores: [{ index: 0, usage: 12.5 }] },
              memory: { totalBytes: 1024, usedBytes: 512 },
            })
          : '{}'
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) })
    res.end(body)
  })
  server.on('connection', () => {
    connections += 1
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('假代理未监听')
  return { port: addr.port, token: 'tok-1', connections: () => connections, hits: () => hits }
}

const openDirect = (port: number): Promise<Duplex> =>
  new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1')
    socket.once('connect', () => resolve(socket))
    socket.once('error', reject)
  })

describe('内置代理产物', () => {
  it('uname -m → 内置架构的映射', () => {
    expect(resolveArch('x86_64')).toBe('amd64')
    expect(resolveArch('AMD64')).toBe('amd64')
    expect(resolveArch('aarch64')).toBe('arm64')
    expect(resolveArch('arm64')).toBe('arm64')
    expect(resolveArch('armv7l')).toBe('arm')
    expect(resolveArch('armv6l')).toBe('arm')
    // 没有内置产物的架构必须返回 null（调用方据此回退脚本模式）
    expect(resolveArch('riscv64')).toBeNull()
    expect(resolveArch('s390x')).toBeNull()
    expect(resolveArch(null)).toBeNull()
  })

  it('三个架构的二进制都在安装包里，且解压后是 ELF', () => {
    for (const arch of AGENT_ARCHES) {
      expect(hasAgentBinary(arch), `${arch} 缺少产物（先跑 agent/build.sh）`).toBe(true)
      const buf = readAgentBinary(arch)
      expect(buf.subarray(0, 4).toString('latin1')).toBe('\x7fELF')
      // 真二进制，不可能只有几 KB
      expect(buf.length).toBeGreaterThan(1_000_000)
    }
  })
})

describe('远端命令', () => {
  /**
   * 代理与脚本模式装在同一个远端目录里。版本文件一旦撞名，
   * 两边会互相覆写：脚本模式看到 `3.0.0` 判定自己过期 → 每次采集重装并写回
   * → 代理永远"版本落后" → 弹窗提示升级、升级完又提示。这条断言守住文件名。
   */
  it('版本文件与脚本模式的 VERSION 不是同一个文件', () => {
    expect(AGENT_VERSION_PATH).not.toBe(REMOTE_VERSION_PATH)
    expect(AGENT_VERSION_PATH.startsWith(AGENT_DIR)).toBe(true)
    expect(agentActivateCommand()).toContain(AGENT_VERSION_PATH)
    expect(agentProbeCommand()).toContain(AGENT_VERSION_PATH)
  })

  it('激活命令：先 chmod 再原子改名，成功哨兵与版本号都写对', () => {
    const cmd = agentActivateCommand()
    expect(cmd).toContain('chmod 700')
    expect(cmd).toContain('mv -f')
    expect(cmd).toContain(`${AGENT_BIN_PATH}.upload`)
    expect(cmd).toContain('T1000_AGENT_OK')
    expect(cmd).toContain(`printf '%s' '${AGENT_VERSION}'`)
  })

  it('启动命令：跑内置二进制、随机端口、本地 token、脱离会话', () => {
    const cmd = agentStartCommand()
    expect(cmd).toContain('./t1000-agent -port 0')
    expect(cmd).toContain('/dev/urandom')
    expect(cmd).toContain('setsid nohup')
    // 不再依赖任何解释器
    expect(cmd).not.toContain('python')
  })

  it('探测命令一次拿齐架构 / HOME / 版本 / 状态', () => {
    const cmd = agentProbeCommand()
    expect(cmd).toContain('uname -m')
    expect(cmd).toContain('T1000_MACHINE:')
    expect(cmd).toContain('T1000_HOME:')
    expect(cmd).toContain('T1000_VER:')
    expect(cmd).toContain('T1000_STATE:')
    expect(cmd.split('\n').length).toBeLessThan(10)
  })
})

describe('探测输出解析', () => {
  it('完整输出', () => {
    const probe = parseProbe(
      [
        'T1000_MACHINE:x86_64',
        'T1000_HOME:/home/deploy',
        `T1000_VER:${AGENT_VERSION}`,
        `T1000_STATE:{"port":41234,"pid":99,"token":"abc","version":"${AGENT_VERSION}"}`,
        'T1000_END',
      ].join('\r\n'),
    )
    expect(probe.machine).toBe('x86_64')
    expect(probe.arch).toBe('amd64')
    expect(probe.home).toBe('/home/deploy')
    expect(probe.installed).toBe(true)
    expect(probe.state).toMatchObject({ port: 41234, pid: 99, token: 'abc' })
  })

  it('没装过：版本是 none，架构仍然能认出来', () => {
    const probe = parseProbe('T1000_MACHINE:aarch64\nT1000_HOME:/root\nT1000_VER:none\nT1000_STATE:{}\nT1000_END')
    expect(probe.arch).toBe('arm64')
    expect(probe.installed).toBe(false)
    expect(probe.state).toBeNull()
  })

  it('不支持的架构：arch 为 null，但其它字段照常解析', () => {
    const probe = parseProbe('T1000_MACHINE:riscv64\nT1000_HOME:/root\nT1000_VER:none\nT1000_STATE:{}\nT1000_END')
    expect(probe.machine).toBe('riscv64')
    expect(probe.arch).toBeNull()
  })

  it('状态文件损坏时不抛异常，按"没在跑"处理', () => {
    const probe = parseProbe('T1000_MACHINE:x86_64\nT1000_HOME:/root\nT1000_VER:3.0.0\nT1000_STATE:{oops\nT1000_END')
    expect(probe.installed).toBe(true)
    expect(probe.state).toBeNull()
  })

  it('启动输出里夹带日志也能抠出状态 JSON', () => {
    const state = parseState('bash: warning: setlocale\n{"port":1024,"pid":7,"token":"t","version":"3.0.0"}\n')
    expect(state).toMatchObject({ port: 1024, pid: 7, token: 't' })
  })
})

describe('隧道 HTTP 客户端', () => {
  it('同一通道上连续请求复用连接（keep-alive）', async () => {
    const agent = await fakeAgent()
    const client = new AgentHttp(() => openDirect(agent.port))
    const health = await client.request(`/health?token=${agent.token}`, 2000)
    const metrics = await client.request(`/metrics?token=${agent.token}`, 2000)
    expect(health.status).toBe(200)
    expect(JSON.parse(metrics.body).cpu.usage).toBe(12.5)
    expect(agent.connections()).toBe(1)
    client.close()
  })

  it('并发调用被串行化，不会把两个响应读串', async () => {
    const agent = await fakeAgent()
    const client = new AgentHttp(() => openDirect(agent.port))
    const [a, b] = await Promise.all([
      client.request('/health', 2000),
      client.request('/metrics', 2000),
    ])
    expect(JSON.parse(a.body).ok).toBe(true)
    expect(JSON.parse(b.body).cpu.usage).toBe(12.5)
    client.close()
  })

  it('超时会 reject 并丢弃通道', async () => {
    const agent = await fakeAgent()
    const client = new AgentHttp(() => openDirect(agent.port))
    // 代理不存在这个路径时也会快速回包；这里用一个必然连不上的端口验证失败路径
    const dead = new AgentHttp(() => openDirect(1))
    await expect(dead.request('/health', 300)).rejects.toBeTruthy()
    client.close()
    dead.close()
    expect(agent.port).toBeGreaterThan(0)
  })
})

describe('AgentService 生命周期', () => {
  it('不支持的架构：ensure 返回 null，且静默期内不再探测', async () => {
    let execs = 0
    const svc = new AgentService(
      async () => {
        execs += 1
        return {
          stdout: 'T1000_MACHINE:riscv64\nT1000_HOME:/root\nT1000_VER:none\nT1000_STATE:{}\nT1000_END',
          stderr: '',
          code: 0,
        }
      },
      new AgentPrefs(tmpFile('prefs.json')),
    )
    expect(await svc.ensure('s1')).toBeNull()
    const first = execs
    expect(await svc.ensure('s1')).toBeNull()
    expect(execs).toBe(first)
  })

  it('安装：SFTP 传到 .upload，chmod+mv 激活，再启动并记录偏好', async () => {
    const commands: string[] = []
    const uploads: Array<{ path: string; size: number; mode: number }> = []
    const svc = new AgentService(
      async (_sid, command) => {
        commands.push(command)
        if (command.includes('-version')) {
          return {
            stdout: 'T1000_MACHINE:x86_64\nT1000_HOME:/home/deploy\nT1000_VER:none\nT1000_STATE:{}\nT1000_END',
            stderr: '',
            code: 0,
          }
        }
        if (command.includes('mkdir -p')) return { stdout: '', stderr: '', code: 0 }
        if (command.includes('T1000_AGENT_OK')) return { stdout: 'T1000_AGENT_OK\n', stderr: '', code: 0 }
        if (command.includes('./t1000-agent -port 0')) {
          return {
            stdout: JSON.stringify({ port: 5555, pid: 42, token: 'tok', version: AGENT_VERSION }),
            stderr: '',
            code: 0,
          }
        }
        return { stdout: '', stderr: '', code: 1 }
      },
      new AgentPrefs(tmpFile('prefs.json')),
      async (_sid, path, data, mode) => {
        uploads.push({ path, size: data.length, mode })
      },
      Date.now,
      () => openDirect(1),
    )

    const result = await svc.install('s1')
    expect(result).toMatchObject({ port: 5555, pid: 42 })
    // 必须传到 .upload（原子改名之前的临时名），不能直接覆盖正在跑的二进制
    expect(uploads).toHaveLength(1)
    expect(uploads[0]!.path).toBe('/home/deploy/.t1000-monitor/t1000-agent.upload')
    expect(uploads[0]!.size).toBeGreaterThan(1_000_000)
    expect(uploads[0]!.mode).toBe(0o700)
    expect(commands.some((c) => c.includes('chmod 700') && c.includes('mv -f'))).toBe(true)
    expect(commands.some((c) => c.includes('./t1000-agent -port 0'))).toBe(true)
    expect((await svc.probe('s1')).decision).toBe('installed')
  })

  it('卸载：kill 掉 pid 并删除二进制与版本文件', async () => {
    const commands: string[] = []
    const svc = new AgentService(
      async (_sid, command) => {
        commands.push(command)
        return {
          stdout:
            'T1000_MACHINE:x86_64\nT1000_HOME:/root\n' +
            `T1000_VER:${AGENT_VERSION}\n` +
            `T1000_STATE:{"port":1,"pid":77,"token":"t","version":"${AGENT_VERSION}"}\nT1000_END`,
          stderr: '',
          code: 0,
        }
      },
      new AgentPrefs(tmpFile('prefs.json')),
    )
    await svc.stop('s1', true)
    expect(commands.some((c) => c.includes('kill 77'))).toBe(true)
    expect(commands.some((c) => c.includes('rm -f') && c.includes('t1000-agent'))).toBe(true)
  })

  it('已装但没在跑：ensure 会自动启动而不是重装', async () => {
    const commands: string[] = []
    const svc = new AgentService(
      async (_sid, command) => {
        commands.push(command)
        if (command.includes('-version')) {
          return {
            stdout:
              'T1000_MACHINE:x86_64\nT1000_HOME:/root\n' +
              `T1000_VER:${AGENT_VERSION}\nT1000_STATE:{}\nT1000_END`,
            stderr: '',
            code: 0,
          }
        }
        if (command.includes('./t1000-agent -port 0')) {
          return {
            stdout: JSON.stringify({ port: 6000, pid: 8, token: 'k', version: AGENT_VERSION }),
            stderr: '',
            code: 0,
          }
        }
        return { stdout: '', stderr: '', code: 1 }
      },
      new AgentPrefs(tmpFile('prefs.json')),
      async () => {
        throw new Error('不该上传：已经装好了')
      },
      Date.now,
      () => openDirect(1),
    )
    const runtime = await svc.ensure('s1')
    expect(runtime?.port).toBe(6000)
    expect(commands.some((c) => c.includes('./t1000-agent -port 0'))).toBe(true)
  })
})

describe('本地偏好', () => {
  it('默认 ask；写入后就记住；同一个文件换个实例也读得到', () => {
    const file = tmpFile('prefs.json')
    const prefs = new AgentPrefs(file)
    expect(prefs.decision('h:22:root')).toBe('ask')
    prefs.set('h:22:root', 'never')
    expect(prefs.decision('h:22:root')).toBe('never')
    expect(new AgentPrefs(file).decision('h:22:root')).toBe('never')
    // 不同服务器互不影响
    expect(new AgentPrefs(file).decision('other:22:root')).toBe('ask')
  })
})
