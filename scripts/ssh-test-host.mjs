#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 独立运行的「SSH 测试主机」入口（**仅测试用，不在产品运行路径里**）。
 *
 * 为什么需要它：开发机没有 sshd，而用户服务器的口令认证关闭、密钥也不被接受，
 * 于是「真实 app 连真实主机」这条验收链路一直缺主机。这个脚本把一个**进程内主机**
 * 拉起来（真实 SSH 协议 + 真实 SFTP + 真实 exec/shell + direct-tcpip 转发），
 * 让 app 直接连 127.0.0.1:<port> 做端到端验收。
 *
 * 用法：
 *   node scripts/ssh-test-host.mjs
 *   node scripts/ssh-test-host.mjs --root /tmp/my-workspace --shell /bin/sh
 *
 * 运行依赖：Node ≥ 22.6（用内置 TypeScript 类型擦除直接跑 .ts 夹具；Node 24 默认开启）。
 * 只监听 127.0.0.1，Ctrl-C 退出会关掉服务并清理临时目录。
 */

const moduleUrl = new URL(
  '../apps/desktop/src/main/services/sftp/test-sftp-server.ts',
  import.meta.url,
)

function argValue(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

const { startTestSshHost } = await import(moduleUrl.href)

const root = argValue('--root')
const shell = argValue('--shell')

const host = await startTestSshHost({
  ...(root === undefined ? {} : { root }),
  ...(shell === undefined ? {} : { shell }),
})

const { credentials } = host
const line = '─'.repeat(64)
console.log(line)
console.log('  SSH 测试主机已启动（真实 ssh2 服务端，仅监听回环）')
console.log(line)
console.log(`  host        : ${credentials.host}`)
console.log(`  port        : ${credentials.port}`)
console.log(`  username    : ${credentials.username}`)
console.log(`  password    : ${credentials.password}`)
console.log(`  workspace   : ${host.root}`)
console.log(`  端点        : ${credentials.host}:${credentials.port}（SSH + SFTP 同端口）`)
console.log('  能力        : sftp / exec / shell(+pty) / direct-tcpip / password+publickey')
console.log('  公钥认证私钥 : 见下方 privateKey（PEM, PKCS#1）')
console.log(line)
console.log(credentials.privateKey.trimEnd())
console.log(line)
console.log('  Ctrl-C 退出（会关闭服务并清理临时工作目录）')
console.log(line)

let shuttingDown = false
async function shutdown() {
  if (shuttingDown) return
  shuttingDown = true
  try {
    await host.close()
  } catch {
    /* 退出阶段忽略清理错误 */
  }
  process.exit(0)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
