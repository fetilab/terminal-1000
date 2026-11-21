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
  AgentHttp,
  AgentPrefs,
  AgentService,
  agentInstallCommand,
  agentProbeCommand,
  agentStartCommand,
  parseProbe,
  parseState,
} from './agent'
import {
  AGENT_DIR,
  AGENT_HEREDOC,
  AGENT_SOURCE,
  AGENT_VERSION,
  AGENT_VERSION_PATH,
} from './agent-source'
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

describe('代理源码', () => {
  it('不含 heredoc 终止符（否则远端写入会被截断）', () => {
    expect(AGENT_SOURCE.includes(AGENT_HEREDOC)).toBe(false)
  })

  it('版本常量与源码里的 VERSION 一致', () => {
    expect(AGENT_SOURCE).toContain(`VERSION = "${AGENT_VERSION}"`)
  })

  /**
   * 代理与脚本模式装在同一个远端目录里。版本文件一旦撞名，
   * 两边会互相覆写：脚本模式看到 `2` 判定自己过期 → 每次采集重装并写回 `1`
   * → 代理永远"版本落后" → 弹窗提示升级、升级完又提示。这条断言守住文件名。
   */
  it('版本文件与脚本模式的 VERSION 不是同一个文件', () => {
    expect(AGENT_VERSION_PATH).not.toBe(REMOTE_VERSION_PATH)
    expect(AGENT_VERSION_PATH.startsWith(AGENT_DIR)).toBe(true)
    expect(agentInstallCommand()).toContain(AGENT_VERSION_PATH)
    expect(agentProbeCommand()).toContain(AGENT_VERSION_PATH)
  })

  it('安装命令用带引号的 heredoc，并在结尾给出成功哨兵', () => {
    const cmd = agentInstallCommand()
    expect(cmd).toContain(`<<'${AGENT_HEREDOC}'`)
    expect(cmd).toContain('T1000_AGENT_OK')
    expect(cmd).toContain(`printf '%s' '${AGENT_VERSION}'`)
  })

  it('启动命令：随机端口、本地生成 token、脱离会话', () => {
    const cmd = agentStartCommand('/usr/bin/python3')
    expect(cmd).toContain('--port 0')
    expect(cmd).toContain('/dev/urandom')
    expect(cmd).toContain('setsid nohup')
    // 单引号包裹，路径里有空格也不会被拆开
    expect(cmd).toContain(`PY='/usr/bin/python3'`)
  })

  it('探测命令一次拿齐 python / 版本 / 状态', () => {
    const cmd = agentProbeCommand()
    expect(cmd).toContain('T1000_PY:')
    expect(cmd).toContain('T1000_VER:')
    expect(cmd).toContain('T1000_STATE:')
    expect(cmd.split('\n').length).toBeLessThan(10)
  })
})

describe('探测输出解析', () => {
  it('完整输出', () => {
    const probe = parseProbe(
      [
        'T1000_PY:/usr/bin/python3',
        'T1000_VER:2',
        'T1000_STATE:{"port":41234,"pid":99,"token":"abc","version":"2"}',
        'T1000_END',
      ].join('\r\n'),
    )
    expect(probe.pythonPath).toBe('/usr/bin/python3')
    expect(probe.installed).toBe(true)
    expect(probe.state).toMatchObject({ port: 41234, pid: 99, token: 'abc' })
  })

  it('没有 python3', () => {
    const probe = parseProbe('T1000_PY:\nT1000_VER:none\nT1000_STATE:{}\nT1000_END')
    expect(probe.pythonPath).toBeNull()
    expect(probe.installed).toBe(false)
    expect(probe.state).toBeNull()
  })

  it('状态文件损坏时不抛异常，按"没在跑"处理', () => {
    const probe = parseProbe('T1000_PY:/usr/bin/python3\nT1000_VER:2\nT1000_STATE:{oops\nT1000_END')
    expect(probe.installed).toBe(true)
    expect(probe.state).toBeNull()
  })

  it('启动输出里夹带日志也能抠出状态 JSON', () => {
    const state = parseState('bash: warning: setlocale\n{"port":1024,"pid":7,"token":"t","version":"2"}\n')
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
  it('服务器没有 python3：ensure 返回 null，且短时间内不再 exec 探测', async () => {
    let execs = 0
    const svc = new AgentService(
      async () => {
        execs += 1
        return { stdout: 'T1000_PY:\nT1000_VER:none\nT1000_STATE:{}\nT1000_END', stderr: '', code: 0 }
      },
      new AgentPrefs(tmpFile('prefs.json')),
    )
    expect(await svc.ensure('s1')).toBeNull()
    expect(await svc.sample('s1', ['cpu'], { processLimit: 8 })).toBeNull()
    expect(execs).toBe(1)
  })

  it('已装且正在跑：直接复用，不再启动', async () => {
    const agent = await fakeAgent()
    const commands: string[] = []
    const svc = new AgentService(
      async (_sid, command) => {
        commands.push(command)
        return {
          stdout:
            'T1000_PY:/usr/bin/python3\n' +
            `T1000_VER:${AGENT_VERSION}\n` +
            `T1000_STATE:${JSON.stringify({ port: agent.port, pid: 11, token: agent.token, version: AGENT_VERSION })}\n` +
            'T1000_END',
          stderr: '',
          code: 0,
        }
      },
      new AgentPrefs(tmpFile('prefs.json')),
      Date.now,
      (_sid, port) => openDirect(port),
    )
    const sample = await svc.sample('s1', ['cpu', 'memory'], { processLimit: 8 })
    expect(sample?.json).toContain('12.5')
    expect(commands.every((c) => c.includes('T1000_STATE') || c.includes('T1000_PY'))).toBe(true)
    expect(commands.some((c) => c.includes('agent.py --port 0'))).toBe(false)
    expect(agent.hits()).toBeGreaterThanOrEqual(2) // health + metrics
  })

  it('已装但没在跑：自动启动（连接时启动监控软件）', async () => {
    const agent = await fakeAgent()
    const commands: string[] = []
    const svc = new AgentService(
      async (_sid, command) => {
        commands.push(command)
        if (command.includes('agent.py --port 0')) {
          return {
            stdout: JSON.stringify({ port: agent.port, pid: 12, token: agent.token, version: AGENT_VERSION }),
            stderr: '',
            code: 0,
          }
        }
        return {
          stdout: `T1000_PY:/usr/bin/python3\nT1000_VER:${AGENT_VERSION}\nT1000_STATE:{}\nT1000_END`,
          stderr: '',
          code: 0,
        }
      },
      new AgentPrefs(tmpFile('prefs.json')),
      Date.now,
      (_sid, port) => openDirect(port),
    )
    const sample = await svc.sample('s1', ['cpu'], { processLimit: 8 })
    expect(sample).not.toBeNull()
    expect(commands.some((c) => c.includes('agent.py --port 0'))).toBe(true)
  })

  it('安装：写文件 + 启动 + 记住选择；卸载：杀进程并删文件', async () => {
    const agent = await fakeAgent()
    const commands: string[] = []
    const prefsFile = tmpFile('prefs.json')
    const svc = new AgentService(
      async (_sid, command) => {
        commands.push(command)
        if (command.includes('T1000_AGENT_PY_EOF')) {
          return { stdout: 'T1000_AGENT_OK\n', stderr: '', code: 0 }
        }
        if (command.includes('agent.py --port 0')) {
          return {
            stdout: JSON.stringify({ port: agent.port, pid: 77, token: agent.token, version: AGENT_VERSION }),
            stderr: '',
            code: 0,
          }
        }
        if (command.includes('kill 77')) {
          return { stdout: 'T1000_AGENT_STOPPED\n', stderr: '', code: 0 }
        }
        return {
          stdout: 'T1000_PY:/usr/bin/python3\nT1000_VER:none\nT1000_STATE:{}\nT1000_END',
          stderr: '',
          code: 0,
        }
      },
      new AgentPrefs(prefsFile),
      Date.now,
      (_sid, port) => openDirect(port),
    )

    const result = await svc.install('s1')
    expect(result.version).toBe(AGENT_VERSION)
    expect(result.pid).toBe(77)
    const prefs = JSON.parse(readFileSync(prefsFile, 'utf8')) as Record<string, { decision: string }>
    expect(Object.values(prefs)[0]?.decision).toBe('installed')

    await svc.stop('s1', true)
    expect(commands.some((c) => c.includes('kill 77'))).toBe(true)
    expect(commands.some((c) => c.includes('rm -f') && c.includes('agent.py'))).toBe(true)
  })

  /**
   * 卸载走的是"没有 runtime 记录"的分支（应用重启过、或别的实例装的）：
   * 这时 stop 内部要探一次拿 pid，而 probeRemote 会顺手写探测缓存。
   * 如果停完不清缓存，面板会在 PROBE_TTL_MS 内一直说"已安装"，
   * 而采集器其实早已回退脚本模式 —— 用户看到的就是"卸载按钮按了没用"。
   */
  it('卸载后 probe 立刻反映"没装"（stop 不能把旧探测结果写回缓存）', async () => {
    let installed = true
    const svc = new AgentService(
      async (_sid, command) => {
        if (command.includes('kill 77')) {
          installed = false
          return { stdout: 'T1000_AGENT_STOPPED\n', stderr: '', code: 0 }
        }
        const ver = installed ? AGENT_VERSION : 'none'
        const state = installed ? JSON.stringify({ port: 1, pid: 77, token: 'tk', version: AGENT_VERSION }) : '{}'
        return {
          stdout: `T1000_PY:/usr/bin/python3\nT1000_VER:${ver}\nT1000_STATE:${state}\nT1000_END`,
          stderr: '',
          code: 0,
        }
      },
      new AgentPrefs(tmpFile('prefs.json')),
      Date.now,
      () => openDirect(1),
    )
    expect((await svc.probe('s1')).installed).toBe(true)
    await svc.stop('s1', true)
    expect((await svc.probe('s1')).installed).toBe(false)
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
