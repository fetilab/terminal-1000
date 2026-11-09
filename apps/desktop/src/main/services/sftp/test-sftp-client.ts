// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * ⚠ 仅供测试使用：连接 `test-sftp-server.ts`（真实 SSH 测试主机）的真实 ssh2 客户端。
 *
 * 单独成一个文件，是为了让 **主机那一侧保持零相对依赖**
 * （`test-sftp-server.ts` 只依赖 node 内置模块与 ssh2，因此能被 `node xxx.ts` 独立运行）。
 */

import ssh2 from 'ssh2'
import type { Client as Ssh2Client, SFTPWrapper } from 'ssh2'
import { toSftpLike, type SftpLike } from './browser'
import { TEST_SFTP_PASSWORD, type TestSftpServer } from './test-sftp-server'

const { Client } = ssh2

export interface TestSftpConnection {
  client: Ssh2Client
  /** 我们的模块使用的收窄接口，但底层是**真实 ssh2 客户端 + 真实 socket** */
  sftp: SftpLike
  close(): Promise<void>
}

export interface ConnectOptions {
  /** 是否关闭 Nagle（默认 true；关掉可复现"每个往返 ~125ms"的慢路径） */
  noDelay?: boolean
  /** 认证方式（默认密码；publickey 用主机生成的私钥） */
  auth?: 'password' | 'publickey'
}

/** 用真实 ssh2 Client 连到测试主机，拿到真实的客户端 SFTPWrapper */
export async function connectTestSftpClient(
  server: TestSftpServer,
  options: ConnectOptions = {},
): Promise<TestSftpConnection> {
  const useNoDelay = options.noDelay ?? true
  const client = new Client()

  await new Promise<void>((resolveReady, rejectReady) => {
    // 注意：必须在 ready（socket 已存在）之后再 setNoDelay —— connect 之前 _sock 还是 null，
    // 那时候调用是静默 no-op（第一版就踩了这个，延迟只降了一半）
    client.once('ready', () => {
      // 默认开启（与真实 sshd 行为一致）；测试可关掉以度量"不设 noDelay"的代价
      client.setNoDelay(useNoDelay)
      resolveReady()
    })
    client.once('error', (err) => rejectReady(err))
    client.connect({
      host: server.host,
      port: server.port,
      username: server.credentials.username,
      ...(options.auth === 'publickey'
        ? { privateKey: server.credentials.privateKey }
        : { password: TEST_SFTP_PASSWORD }),
      readyTimeout: 10_000,
      // 测试里不校验主机指纹（hostKey 每次都是新生成的）
      hostVerifier: () => true,
    })
  })

  const wrapper = await new Promise<SFTPWrapper>((resolveSftp, rejectSftp) => {
    client.sftp((err, sftp) => (err ? rejectSftp(err) : resolveSftp(sftp)))
  })

  return {
    client,
    sftp: toSftpLike(wrapper),
    async close(): Promise<void> {
      client.end()
    },
  }
}

/** 只建 SSH 连接、不开 SFTP 通道（exec / shell / 转发测试用） */
export async function connectTestSsh(
  server: TestSftpServer,
  options: ConnectOptions = {},
): Promise<Ssh2Client> {
  const client = new Client()
  await new Promise<void>((resolveReady, rejectReady) => {
    client.once('ready', () => {
      client.setNoDelay(options.noDelay ?? true)
      resolveReady()
    })
    client.once('error', (err) => rejectReady(err))
    client.connect({
      host: server.host,
      port: server.port,
      username: server.credentials.username,
      ...(options.auth === 'publickey'
        ? { privateKey: server.credentials.privateKey }
        : { password: TEST_SFTP_PASSWORD }),
      readyTimeout: 10_000,
      hostVerifier: () => true,
    })
  })
  return client
}
