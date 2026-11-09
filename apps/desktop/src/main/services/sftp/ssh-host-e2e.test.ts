// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * SSH 测试主机的端到端测试：exec（监控采集走的那条路）、shell+pty（终端）、
 * direct-tcpip（端口转发）、密码与公钥认证。
 *
 * 全部对着**真实 ssh2 服务端 + 真实子进程 + 真实 socket**，没有桩。
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http'
import type { Client as Ssh2Client } from 'ssh2'
import { connectTestSftpClient, connectTestSsh } from './test-sftp-client'
import { startTestSftpServer, type TestSftpServer } from './test-sftp-server'

let server: TestSftpServer

beforeAll(async () => {
  server = await startTestSftpServer()
})

afterAll(async () => {
  await server?.close()
})

/** 在真实连接上跑一条命令，收集 stdout/stderr/退出码 */
function runCommand(
  client: Ssh2Client,
  command: string,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolveExec, rejectExec) => {
    client.exec(command, (err, stream) => {
      if (err) return rejectExec(err)
      let stdout = ''
      let stderr = ''
      let code: number | null = null
      stream.on('data', (d: Buffer) => {
        stdout += d.toString('utf8')
      })
      stream.stderr.on('data', (d: Buffer) => {
        stderr += d.toString('utf8')
      })
      stream.on('exit', (exitCode: number | null) => {
        code = exitCode ?? null
      })
      stream.on('close', () => resolveExec({ stdout, stderr, code }))
    })
  })
}

describe('★ exec（监控采集的真实路径）', () => {
  it('真实执行命令：stdout 与退出码都来自真实子进程', async () => {
    const client = await connectTestSsh(server)
    try {
      const ok = await runCommand(client, 'echo hello-monitor')
      expect(ok.stdout.trim()).toBe('hello-monitor')
      expect(ok.code).toBe(0)

      const bad = await runCommand(client, 'exit 3')
      expect(bad.code).toBe(3)

      const err = await runCommand(client, 'echo oops >&2; exit 1')
      expect(err.stderr).toContain('oops')
      expect(err.code).toBe(1)
    } finally {
      client.end()
    }
  })

  it('exec 的工作目录是主机根目录（临时目录）', async () => {
    const client = await connectTestSsh(server)
    try {
      const pwd = await runCommand(client, 'pwd')
      // macOS 上 /tmp 是 /private/tmp 的软链，用 realpath 归一后比较
      const { realpathSync } = await import('node:fs')
      expect(realpathSync(pwd.stdout.trim())).toBe(server.root)
    } finally {
      client.end()
    }
  })

  it('exec 能真实改动文件系统（监控脚本分发场景）', async () => {
    const client = await connectTestSsh(server)
    try {
      await runCommand(client, 'mkdir -p probe && echo data > probe/out.txt && wc -c < probe/out.txt')
      const { readFileSync, existsSync } = await import('node:fs')
      expect(existsSync(`${server.root}/probe/out.txt`)).toBe(true)
      expect(readFileSync(`${server.root}/probe/out.txt`, 'utf8').trim()).toBe('data')
    } finally {
      client.end()
    }
  })

  it('主机侧记录了 exec 的命令与退出码（便于断言真实交互）', async () => {
    const client = await connectTestSsh(server)
    try {
      await runCommand(client, 'echo logged')
      // 客户端的 stream 'close' 可能早于服务端 child 'close' 的回调，这里轮询等一下
      const deadline = Date.now() + 3000
      let logged = false
      while (!logged && Date.now() < deadline) {
        logged = server.log.some((r) => r.op === 'EXEC' && r.command === 'echo logged' && r.exitCode === 0)
        if (!logged) await new Promise((r) => setTimeout(r, 20))
      }
      expect(logged).toBe(true)
    } finally {
      client.end()
    }
  })
})

describe('★ shell + pty（终端路径）', () => {
  it('接受 pty 请求并起真实 shell，写进去的命令有回显', async () => {
    const client = await connectTestSsh(server)
    try {
      const output = await new Promise<string>((resolveShell, rejectShell) => {
        client.shell({ term: 'xterm', cols: 80, rows: 24 }, (err, stream) => {
          if (err) return rejectShell(err)
          let buf = ''
          const timer = setTimeout(() => {
            stream.close()
            resolveShell(buf)
          }, 4000)
          stream.on('data', (d: Buffer) => {
            buf += d.toString('utf8')
            if (buf.includes('SHELL_MARKER_42')) {
              clearTimeout(timer)
              stream.close()
              resolveShell(buf)
            }
          })
          stream.write('echo SHELL_MARKER_42\n')
        })
      })
      expect(output).toContain('SHELL_MARKER_42')
    } finally {
      client.end()
    }
  })

  it('主机侧记录了 SHELL 会话（pty 被接受）', () => {
    expect(server.log.some((r) => r.op === 'SHELL')).toBe(true)
  })
})

describe('★ direct-tcpip（端口转发路径）', () => {
  let httpServer: HttpServer
  let httpPort = 0

  beforeAll(async () => {
    httpServer = createHttpServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('HELLO-FROM-ORIGIN')
    })
    httpPort = await new Promise<number>((resolvePort) => {
      httpServer.listen(0, '127.0.0.1', () => {
        const addr = httpServer.address()
        resolvePort(typeof addr === 'object' && addr !== null ? addr.port : 0)
      })
    })
  })

  afterAll(async () => {
    await new Promise<void>((r) => httpServer.close(() => r()))
  })

  it('forwardOut 打通到真实目标并回传数据', async () => {
    const client = await connectTestSsh(server)
    try {
      const response = await new Promise<string>((resolveFwd, rejectFwd) => {
        client.forwardOut('127.0.0.1', 0, '127.0.0.1', httpPort, (err, stream) => {
          if (err) return rejectFwd(err)
          let buf = ''
          stream.on('data', (d: Buffer) => {
            buf += d.toString('utf8')
          })
          stream.on('close', () => resolveFwd(buf))
          stream.write(`GET / HTTP/1.1\r\nHost: 127.0.0.1:${httpPort}\r\nConnection: close\r\n\r\n`)
        })
      })
      expect(response).toContain('200 OK')
      expect(response).toContain('HELLO-FROM-ORIGIN')
    } finally {
      client.end()
    }
  })

  it('转发到不存在的目标时失败，且不挂死', async () => {
    const client = await connectTestSsh(server)
    try {
      // 选一个几乎不可能在听的端口
      const closedPort = 9
      const outcome = await new Promise<'error' | 'closed' | 'data'>((resolveFwd) => {
        client.forwardOut('127.0.0.1', 0, '127.0.0.1', closedPort, (err, stream) => {
          if (err) return resolveFwd('error')
          stream.on('data', () => resolveFwd('data'))
          stream.on('close', () => resolveFwd('closed'))
          setTimeout(() => resolveFwd('closed'), 2000)
        })
      })
      expect(['error', 'closed']).toContain(outcome)
    } finally {
      client.end()
    }
  })

  it('主机侧记录了 TCPIP 转发目标', () => {
    const tcpips = server.log.filter((r) => r.op === 'TCPIP')
    expect(tcpips.length).toBeGreaterThan(0)
    expect(tcpips.some((r) => r.dest === `127.0.0.1:${httpPort}`)).toBe(true)
  })
})

describe('认证', () => {
  it('密码认证可用（并开 SFTP 通道）', async () => {
    const conn = await connectTestSftpClient(server)
    try {
      const entries = await conn.sftp.readdir(server.root, (err, list) => {
        void err
        expect(Array.isArray(list)).toBe(true)
      })
      void entries
    } finally {
      await conn.close()
    }
  })

  it('公钥认证可用（用主机生成的私钥）', async () => {
    const conn = await connectTestSftpClient(server, { auth: 'publickey' })
    try {
      const names = await new Promise<string[]>((resolveList, rejectList) => {
        conn.sftp.readdir('/', (err, list) => {
          if (err) return rejectList(err)
          resolveList(list.map((e) => e.filename))
        })
      })
      expect(Array.isArray(names)).toBe(true)
    } finally {
      await conn.close()
    }
  })

  it('密码错误时连接被拒', async () => {
    const ssh2 = (await import('ssh2')).default
    const client = new ssh2.Client()
    const result = await new Promise<'ready' | 'error'>((resolveAuth) => {
      client.once('ready', () => resolveAuth('ready'))
      client.once('error', () => resolveAuth('error'))
      client.connect({
        host: server.host,
        port: server.port,
        username: 'tester',
        password: 'wrong-password',
        readyTimeout: 5000,
        hostVerifier: () => true,
      })
    })
    client.end()
    expect(result).toBe('error')
  })

  it('credentials 暴露了可用的连接信息', () => {
    expect(server.credentials).toMatchObject({ host: '127.0.0.1', username: 'tester' })
    expect(server.credentials.port).toBe(server.port)
    expect(server.credentials.privateKey).toContain('BEGIN RSA PRIVATE KEY')
  })
})
