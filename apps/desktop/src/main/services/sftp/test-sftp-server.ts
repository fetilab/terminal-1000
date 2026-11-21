// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * ⚠ 仅供测试使用：进程内的**真实 ssh2 SFTP 服务端**。
 *
 * 为什么需要它：`FakeSftp`（transfer.test.ts 里的手写桩）是按"我们理解的接口"实现的，
 * 因此永远发现不了**我们对 SFTP 协议本身的理解偏差**。这里起一个真 Server，
 * 走真实 socket、真实 SFTP 报文、真实文件系统（mkdtemp 出来的临时目录），
 * 让 sftp 模块以真实客户端身份连上去跑完整链路。
 *
 * 协议实现依据 ssh2 1.17 的 `lib/protocol/SFTP.js`（事件名/参数/状态码均为权威来源）：
 * - 请求事件统一大写，形如 `OPEN(reqid, filename, flags, attrs)`
 * - 回包：`handle/data/name/attrs/status`
 * - 状态码：OK=0 EOF=1 NO_SUCH_FILE=2 PERMISSION_DENIED=3 FAILURE=4 OP_UNSUPPORTED=8
 *
 * 安全语义与真实服务端一致：客户端看到的 `/` 就是 root（chroot 式映射），
 * 越出 root 的路径一律 PERMISSION_DENIED。
 */

import ssh2 from 'ssh2'
import type { ServerConfig } from 'ssh2'
import { generateKeyPairSync } from 'node:crypto'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import * as fs from 'node:fs'
import { connect as netConnect, createServer as netCreateServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'

// ⚠ 用 default import 取实现：ssh2 是 CJS，Node 的 ESM 命名导出探测对它不可靠
// （`import { Server } from 'ssh2'` 在 vite/vitest 下能过、在 `node xxx.ts` 下直接语法报错）。
// 这样这个文件既能被 vitest 引，也能被 `node --experimental-strip-types` 独立运行。
const { Server } = ssh2

export const TEST_SFTP_PASSWORD = 'test-secret'

/** SFTP 状态码（与 ssh2 内部一致；不从 ssh2 导入是因为它没导出这张表） */
export const SFTP_STATUS = {
  OK: 0,
  EOF: 1,
  NO_SUCH_FILE: 2,
  PERMISSION_DENIED: 3,
  FAILURE: 4,
  OP_UNSUPPORTED: 8,
} as const

/** ssh2 的 OPEN 标志位 */
export const SFTP_OPEN = {
  READ: 0x00000001,
  WRITE: 0x00000002,
  APPEND: 0x00000004,
  CREAT: 0x00000008,
  TRUNC: 0x00000010,
  EXCL: 0x00000020,
} as const

interface WireAttrs {
  mode?: number
  uid?: number
  gid?: number
  size?: number
  atime?: number
  mtime?: number
}

interface WireName {
  filename: string
  longname: string
  attrs: WireAttrs
}

/**
 * 服务端接受的 SFTP 对象（ssh2 的类型只覆盖客户端侧，这里按协议补齐）。
 * 刻意**不 extends SFTPWrapper**：客户端的 on() 重载与这里的请求事件签名冲突。
 */
interface ServerSftp {
  on(event: 'OPEN', cb: (reqid: number, filename: string, flags: number, attrs: WireAttrs) => void): this
  on(event: 'READ', cb: (reqid: number, handle: Buffer, offset: number, length: number) => void): this
  on(event: 'WRITE', cb: (reqid: number, handle: Buffer, offset: number, data: Buffer) => void): this
  on(event: 'CLOSE', cb: (reqid: number, handle: Buffer) => void): this
  on(event: 'FSTAT', cb: (reqid: number, handle: Buffer) => void): this
  on(event: 'STAT', cb: (reqid: number, path: string) => void): this
  on(event: 'LSTAT', cb: (reqid: number, path: string) => void): this
  on(event: 'SETSTAT', cb: (reqid: number, path: string, attrs: WireAttrs) => void): this
  on(event: 'FSETSTAT', cb: (reqid: number, handle: Buffer, attrs: WireAttrs) => void): this
  on(event: 'OPENDIR', cb: (reqid: number, path: string) => void): this
  on(event: 'READDIR', cb: (reqid: number, handle: Buffer) => void): this
  on(event: 'REMOVE', cb: (reqid: number, path: string) => void): this
  on(event: 'MKDIR', cb: (reqid: number, path: string, attrs: WireAttrs) => void): this
  on(event: 'RMDIR', cb: (reqid: number, path: string) => void): this
  on(event: 'RENAME', cb: (reqid: number, oldPath: string, newPath: string) => void): this
  on(event: 'REALPATH', cb: (reqid: number, path: string) => void): this
  on(event: 'READLINK', cb: (reqid: number, path: string) => void): this
  on(event: 'SYMLINK', cb: (reqid: number, linkPath: string, targetPath: string) => void): this
  handle(reqid: number, handle: Buffer): void
  data(reqid: number, data: Buffer): void
  name(reqid: number, names: WireName[]): void
  attrs(reqid: number, attrs: WireAttrs): void
  status(reqid: number, code: number, message?: string): void
}

interface OpenHandle {
  fd: number
  path: string
  mode: string
}

interface DirHandle {
  path: string
  entries: WireName[]
  /** READDIR 会被客户端反复调用直到 EOF；第一遍给数据，之后给 EOF */
  served: boolean
}

export interface SftpRequestLog {
  op: string
  path?: string
  /** 本请求最终回给客户端的状态码（用来证明"错误来自服务端"） */
  status?: number
  bytes?: number
  /** exec 执行的命令 */
  command?: string
  /** direct-tcpip 的目标 host:port */
  dest?: string
  /** exec/shell 子进程退出码 */
  exitCode?: number
}

export interface TestSftpServer {
  host: string
  port: number
  /** 真实文件系统根目录（客户端看到的 `/`） */
  root: string
  /** 服务端侧收到并应答过的请求（断言真实协议交互用） */
  log: SftpRequestLog[]
  /** 观测到的最大并发文件句柄数 */
  readonly maxConcurrentOpens: number
  /** 连接凭据（独立运行时打印给使用者；privateKey 可直接用于公钥认证） */
  readonly credentials: TestSshCredentials
  close(): Promise<void>
}

export interface TestSshCredentials {
  host: string
  port: number
  username: string
  password: string
  /** 生成的客户端私钥（PEM, PKCS#1），可用公钥认证登录 */
  privateKey: string
}

/** 语义化别名：这是一台完整 SSH 测试主机，不只是 SFTP */
export type TestSshHost = TestSftpServer

/** 把 errno 映射成 SFTP 状态码（模拟真实服务端的错误语义） */
function statusForError(err: unknown): { code: number; message: string } {
  const e = err as NodeJS.ErrnoException
  switch (e?.code) {
    case 'ENOENT':
      return { code: SFTP_STATUS.NO_SUCH_FILE, message: 'No such file' }
    case 'EACCES':
    case 'EPERM':
    case 'EROFS':
      return { code: SFTP_STATUS.PERMISSION_DENIED, message: 'Permission denied' }
    case 'EEXIST':
    case 'ENOTEMPTY':
    case 'EISDIR':
    case 'ENOTDIR':
    case 'EINVAL':
      return { code: SFTP_STATUS.FAILURE, message: e.message ?? 'Failure' }
    default:
      return { code: SFTP_STATUS.FAILURE, message: e?.message ?? 'Failure' }
  }
}

function toWireAttrs(st: fs.Stats): WireAttrs {
  return {
    mode: st.mode,
    uid: st.uid,
    gid: st.gid,
    size: st.size,
    // SFTP 的 atime/mtime 是**秒**（客户端会原样放进 Stats）
    atime: Math.floor(st.atimeMs / 1000),
    mtime: Math.floor(st.mtimeMs / 1000),
  }
}

const PERM_CHARS = ['---', '--x', '-w-', '-wx', 'r--', 'r-x', 'rw-', 'rwx']

function modeString(mode: number): string {
  const type = (mode & 0o170000) === 0o040000 ? 'd' : (mode & 0o170000) === 0o120000 ? 'l' : '-'
  const bits = mode & 0o777
  const perm = [6, 3, 0].map((shift) => PERM_CHARS[(bits >> shift) & 0o7] ?? '---').join('')
  return `${type}${perm}`
}

/** 造一个 ls -l 风格 longname（我们的模块会把 longname 透传给 UI） */
function longnameOf(name: string, st: fs.Stats): string {
  const date = new Date(st.mtimeMs).toISOString().slice(0, 16).replace('T', ' ')
  return `${modeString(st.mode)} 1 0 0 ${st.size} ${date} ${name}`
}

/**
 * 启动真实 SFTP 服务端。
 * 调用方负责 `close()`（会关服务端、删临时目录）。
 */
export async function startTestSftpServer(
  options: {
    root?: string
    /** 接受任意公钥（测试主机默认接受，方便验收直接连） */
    acceptAnyPublicKey?: boolean
    /** shell 子进程（默认 bash，缺失时退回 sh） */
    shell?: string
  } = {},
): Promise<TestSftpServer> {
  const root = options.root ?? mkdtempSync(join(tmpdir(), 't1000-sftp-srv-'))
  const realRoot = fs.realpathSync(root)
  const log: SftpRequestLog[] = []

  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
  })

  /** 服务端观测到的最大并发打开数（由每个会话的闭包写入） */
  const counters = { maxOpens: 0 }

  const acceptAnyPublicKey = options.acceptAnyPublicKey ?? true
  const shellBin = options.shell ?? (fs.existsSync('/bin/bash') ? '/bin/bash' : 'sh')

  // 客户端私钥：独立运行时打印出去，验收可以直接用公钥认证登录
  const { privateKey: clientPrivateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
  })

  const config: ServerConfig = { hostKeys: [privateKey] }
  const server = new Server(config, (client) => {
    // 真实 sshd 会设 TCP_NODELAY；ssh2 默认不设，于是**每个请求往返都吃一次
    // Nagle + delayed-ACK（实测 ~250ms/次）**，大文件测试会慢到几十秒并假性超时。
    ;(client as unknown as { setNoDelay?: (v: boolean) => void }).setNoDelay?.(true)

    client.on('authentication', (ctx) => {
      if (ctx.method === 'password' && ctx.password === TEST_SFTP_PASSWORD) {
        ctx.accept()
        return
      }
      if (ctx.method === 'publickey' && acceptAnyPublicKey) {
        // 测试主机刻意接受任意公钥（本地回环、临时进程）；需要"钉死某把密钥"时把
        // acceptAnyPublicKey 设为 false，此时公钥认证一律拒绝，只认密码。
        ctx.accept()
        return
      }
      // 先让客户端知道我们支持哪些方式（显式收敛成 AuthenticationType 联合，避免推断成 string[]）
      const methods: Array<'password' | 'publickey'> = acceptAnyPublicKey
        ? ['password', 'publickey']
        : ['password']
      ctx.reject(methods)
    })

    /** direct-tcpip：端口转发（本地转发 / SOCKS 动态转发都走这里） */
    client.on('tcpip', (accept, reject, info: { destIP?: string; destPort?: number; srcIP?: string; srcPort?: number }) => {
      const dest = `${info?.destIP ?? '?'}:${info?.destPort ?? '?'}`
      let stream
      try {
        stream = accept()
      } catch {
        return
      }
      const socket = netConnect({ host: info?.destIP ?? '127.0.0.1', port: info?.destPort ?? 0 })
      socket.on('connect', () => {
        log.push({ op: 'TCPIP', dest, status: SFTP_STATUS.OK })
        stream.pipe(socket).pipe(stream)
      })
      socket.on('error', (err) => {
        log.push({ op: 'TCPIP', dest, status: SFTP_STATUS.FAILURE })
        try {
          reject?.()
        } catch {
          /* 已 accept 过就不能 reject 了 */
        }
        void err
      })
      stream.on('close', () => socket.destroy())
    })

    client.on('ready', () => {
      /**
       * 远程转发（`ssh -R`）：客户端请求在服务端监听 bindAddr:bindPort，
       * 服务端接受后在本地监听，并把每个入站连接经 `forwarded-tcpip` 通道回连客户端。
       *
       * ssh2 服务端只把请求抛出 `request` 事件，监听与回连由使用方实现；
       * 不实现时客户端收到的回复是 FAILURE，`ssh -R` 因此不可用。
       */
      const remoteForwards = new Map<string, ReturnType<typeof netCreateServer>>()
      const forwardKey = (addr: string, port: number): string => `${addr}:${port}`

      client.on('request', (accept, reject, name, info) => {
        if (name !== 'tcpip-forward' && name !== 'cancel-tcpip-forward') {
          if (name !== 'no-more-sessions@openssh.com') reject?.()
          return
        }

        const bindAddr = typeof info?.bindAddr === 'string' ? info.bindAddr : '127.0.0.1'
        const bindPort = typeof info?.bindPort === 'number' ? info.bindPort : 0
        // 只监听回环：测试机不应对局域网暴露端口，请求其它地址一律拒绝
        const listenHost = '127.0.0.1'

        if (name === 'cancel-tcpip-forward') {
          const existing = remoteForwards.get(forwardKey(bindAddr, bindPort))
          if (existing) {
            existing.close()
            remoteForwards.delete(forwardKey(bindAddr, bindPort))
            accept?.()
          } else {
            reject?.()
          }
          return
        }

        if (bindAddr !== '127.0.0.1' && bindAddr !== 'localhost' && bindAddr !== '') {
          log.push({ op: 'TCPIP-FORWARD', dest: `${bindAddr}:${bindPort}`, status: SFTP_STATUS.FAILURE })
          reject?.()
          return
        }

        const forwardServer = netCreateServer((inbound) => {
          const bound = forwardServer.address()
          const boundPort = typeof bound === 'object' && bound !== null ? bound.port : bindPort
          // boundAddr/boundPort 必须回客户端**请求时记录**的值（请求地址 + 分配到的端口），
          // 客户端按这两个字段匹配自己发起的远程转发；填本地监听地址会匹配失败并被拒绝开通道。
          client.forwardOut(
            bindAddr,
            boundPort,
            inbound.remoteAddress ?? '127.0.0.1',
            inbound.remotePort ?? 0,
            (err, stream) => {
              if (err) {
                inbound.destroy()
                return
              }
              inbound.pipe(stream).pipe(inbound)
              stream.on('close', () => inbound.destroy())
              inbound.on('close', () => stream.destroy())
            },
          )
        })

        forwardServer.on('error', () => {
          log.push({ op: 'TCPIP-FORWARD', dest: `${bindAddr}:${bindPort}`, status: SFTP_STATUS.FAILURE })
          reject?.()
        })

        forwardServer.listen(bindPort, listenHost, () => {
          const bound = forwardServer.address()
          const boundPort = typeof bound === 'object' && bound !== null ? bound.port : bindPort
          remoteForwards.set(forwardKey(bindAddr, boundPort), forwardServer)
          remoteForwards.set(forwardKey(bindAddr, bindPort), forwardServer)
          log.push({ op: 'TCPIP-FORWARD', dest: `${listenHost}:${boundPort}`, status: SFTP_STATUS.OK })
          // 请求 0 端口时须回传实际端口，否则客户端无法得知要连哪里
          accept?.(bindPort === 0 ? boundPort : undefined)
        })
      })

      client.on('session', (accept) => {
        const session = accept()

        /** 客户端看到的绝对路径 → 真实本地路径（chroot 式，越界直接拒） */
        const mapPath = (remote: string): string => {
          const cleaned = remote === '' ? '/' : remote
          const rel = cleaned.replace(/^\/+/, '')
          const local = resolve(realRoot, rel)
          if (local !== realRoot && !local.startsWith(realRoot + sep)) {
            throw Object.assign(new Error('path escapes root'), { code: 'EACCES' })
          }
          return local
        }

        const openHandles = new Map<number, OpenHandle>()
        const dirHandles = new Map<number, DirHandle>()
        let nextHandle = 1
        /** 真实并发度量：同时打开的文件句柄数 = 同时在传的文件数 */
        let activeOpens = 0
        let maxActiveOpens = 0

        const makeHandle = (): Buffer => {
          const buf = Buffer.alloc(4)
          buf.writeUInt32BE(nextHandle++, 0)
          return buf
        }
        const handleId = (h: Buffer): number => h.readUInt32BE(0)

        session.on('sftp', (acceptSftp: () => ServerSftp) => {
          const sftp = acceptSftp()

          /** 统一收口状态码记录，方便测试断言"错误码来自服务端" */
          const respond = (
            reqid: number,
            op: string,
            code: number,
            path?: string,
            bytes?: number,
          ): void => {
            log.push({ op, ...(path === undefined ? {} : { path }), status: code, ...(bytes === undefined ? {} : { bytes }) })
            sftp.status(reqid, code)
          }
          const fail = (reqid: number, op: string, err: unknown, path?: string): void => {
            const { code, message } = statusForError(err)
            log.push({ op, ...(path === undefined ? {} : { path }), status: code })
            sftp.status(reqid, code, message)
          }

          // ── 打开文件 ────────────────────────────────────────────────
          sftp.on('OPEN', (reqid, filename, flags, attrs) => {
            const local = ((): string => {
              try {
                return mapPath(filename)
              } catch (err) {
                fail(reqid, 'OPEN', err, filename)
                return ''
              }
            })()
            if (local === '') return

            if ((flags & SFTP_OPEN.EXCL) !== 0 && fs.existsSync(local)) {
              log.push({ op: 'OPEN', path: filename, status: SFTP_STATUS.FAILURE })
              sftp.status(reqid, SFTP_STATUS.FAILURE, 'File exists')
              return
            }

            let mode = 'r'
            if ((flags & SFTP_OPEN.TRUNC) !== 0) mode = (flags & SFTP_OPEN.READ) !== 0 ? 'w+' : 'w'
            else if ((flags & SFTP_OPEN.APPEND) !== 0) mode = (flags & SFTP_OPEN.READ) !== 0 ? 'a+' : 'a'
            else if ((flags & SFTP_OPEN.WRITE) !== 0) mode = (flags & SFTP_OPEN.READ) !== 0 ? 'r+' : 'w'

            let nodeFlags = 0
            if (mode === 'r') nodeFlags = fs.constants.O_RDONLY
            else if (mode === 'w') nodeFlags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC
            else if (mode === 'w+') nodeFlags = fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC
            else if (mode === 'a') nodeFlags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND
            else if (mode === 'a+') nodeFlags = fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_APPEND
            else nodeFlags = fs.constants.O_RDWR

            const createMode = attrs.mode === undefined ? 0o644 : attrs.mode & 0o7777

            try {
              const fd = fs.openSync(local, nodeFlags, createMode)
              // umask 会削掉权限位；真实服务端在 CREATE 时会按请求的 mode 落盘
              if ((flags & SFTP_OPEN.CREAT) !== 0 && attrs.mode !== undefined) {
                fs.fchmodSync(fd, createMode)
              }
              const id = nextHandle
              const handle = makeHandle()
              openHandles.set(id, { fd, path: local, mode })
              activeOpens++
              maxActiveOpens = Math.max(maxActiveOpens, activeOpens)
              counters.maxOpens = Math.max(counters.maxOpens, maxActiveOpens)
              log.push({ op: 'OPEN', path: filename, status: SFTP_STATUS.OK })
              sftp.handle(reqid, handle)
            } catch (err) {
              fail(reqid, 'OPEN', err, filename)
            }
          })

          // ── 读 ────────────────────────────────────────────────────
          sftp.on('READ', (reqid, handle, offset, length) => {
            const h = openHandles.get(handleId(handle))
            if (!h) {
              log.push({ op: 'READ', status: SFTP_STATUS.FAILURE })
              sftp.status(reqid, SFTP_STATUS.FAILURE, 'Invalid handle')
              return
            }
            try {
              const buffer = Buffer.alloc(length)
              const bytesRead = fs.readSync(h.fd, buffer, 0, length, offset)
              if (bytesRead === 0) {
                log.push({ op: 'READ', path: h.path, status: SFTP_STATUS.EOF })
                sftp.status(reqid, SFTP_STATUS.EOF)
                return
              }
              log.push({ op: 'READ', path: h.path, status: SFTP_STATUS.OK, bytes: bytesRead })
              sftp.data(reqid, buffer.subarray(0, bytesRead))
            } catch (err) {
              fail(reqid, 'READ', err, h.path)
            }
          })

          // ── 写 ────────────────────────────────────────────────────
          sftp.on('WRITE', (reqid, handle, offset, data) => {
            const h = openHandles.get(handleId(handle))
            if (!h) {
              log.push({ op: 'WRITE', status: SFTP_STATUS.FAILURE })
              sftp.status(reqid, SFTP_STATUS.FAILURE, 'Invalid handle')
              return
            }
            try {
              fs.writeSync(h.fd, data, 0, data.length, offset)
              respond(reqid, 'WRITE', SFTP_STATUS.OK, h.path, data.length)
            } catch (err) {
              fail(reqid, 'WRITE', err, h.path)
            }
          })

          /**
           * CLOSE 要同时接受**文件句柄与目录句柄**：
           * ssh2 客户端的 readdir 在收到 EOF 后会 close 目录句柄，若这里回 FAILURE，
           * readdir 会整体失败（第一次真实跑就会暴露这个问题）。
           */
          sftp.on('CLOSE', (reqid, handle) => {
            const id = handleId(handle)
            const h = openHandles.get(id)
            if (h) {
              openHandles.delete(id)
              activeOpens = Math.max(0, activeOpens - 1)
              try {
                fs.closeSync(h.fd)
                respond(reqid, 'CLOSE', SFTP_STATUS.OK, h.path)
              } catch (err) {
                fail(reqid, 'CLOSE', err, h.path)
              }
              return
            }
            if (dirHandles.delete(id)) {
              respond(reqid, 'CLOSE', SFTP_STATUS.OK)
              return
            }
            respond(reqid, 'CLOSE', SFTP_STATUS.FAILURE)
          })

          // ── stat 家族 ─────────────────────────────────────────────
          const statLike = (
            reqid: number,
            op: string,
            remotePath: string,
            statFn: (p: string) => fs.Stats,
          ): void => {
            try {
              const local = mapPath(remotePath)
              const st = statFn(local)
              log.push({ op, path: remotePath, status: SFTP_STATUS.OK })
              sftp.attrs(reqid, toWireAttrs(st))
            } catch (err) {
              fail(reqid, op, err, remotePath)
            }
          }

          sftp.on('STAT', (reqid, path) => statLike(reqid, 'STAT', path, fs.statSync))
          sftp.on('LSTAT', (reqid, path) => statLike(reqid, 'LSTAT', path, fs.lstatSync))

          sftp.on('FSTAT', (reqid, handle) => {
            const h = openHandles.get(handleId(handle))
            if (!h) {
              log.push({ op: 'FSTAT', status: SFTP_STATUS.FAILURE })
              sftp.status(reqid, SFTP_STATUS.FAILURE, 'Invalid handle')
              return
            }
            try {
              const st = fs.fstatSync(h.fd)
              log.push({ op: 'FSTAT', path: h.path, status: SFTP_STATUS.OK })
              sftp.attrs(reqid, toWireAttrs(st))
            } catch (err) {
              fail(reqid, 'FSTAT', err, h.path)
            }
          })

          const applyAttrs = (local: string, attrs: WireAttrs, fd?: number): void => {
            if (attrs.mode !== undefined) {
              if (fd === undefined) fs.chmodSync(local, attrs.mode & 0o7777)
              else fs.fchmodSync(fd, attrs.mode & 0o7777)
            }
            if (attrs.atime !== undefined && attrs.mtime !== undefined) {
              fs.utimesSync(local, attrs.atime, attrs.mtime)
            }
          }

          sftp.on('SETSTAT', (reqid, path, attrs) => {
            try {
              const local = mapPath(path)
              applyAttrs(local, attrs)
              respond(reqid, 'SETSTAT', SFTP_STATUS.OK, path)
            } catch (err) {
              fail(reqid, 'SETSTAT', err, path)
            }
          })

          sftp.on('FSETSTAT', (reqid, handle, attrs) => {
            const h = openHandles.get(handleId(handle))
            if (!h) {
              log.push({ op: 'FSETSTAT', status: SFTP_STATUS.FAILURE })
              sftp.status(reqid, SFTP_STATUS.FAILURE, 'Invalid handle')
              return
            }
            try {
              applyAttrs(h.path, attrs, h.fd)
              respond(reqid, 'FSETSTAT', SFTP_STATUS.OK, h.path)
            } catch (err) {
              fail(reqid, 'FSETSTAT', err, h.path)
            }
          })

          // ── 目录 ──────────────────────────────────────────────────
          sftp.on('OPENDIR', (reqid, path) => {
            try {
              const local = mapPath(path)
              const dirents = fs.readdirSync(local, { withFileTypes: true })
              const entries: WireName[] = dirents.map((dirent) => {
                const childLocal = join(local, dirent.name)
                const st = fs.lstatSync(childLocal)
                return { filename: dirent.name, longname: longnameOf(dirent.name, st), attrs: toWireAttrs(st) }
              })
              const id = nextHandle
              const handle = makeHandle()
              dirHandles.set(id, { path: local, entries, served: false })
              log.push({ op: 'OPENDIR', path, status: SFTP_STATUS.OK })
              sftp.handle(reqid, handle)
            } catch (err) {
              fail(reqid, 'OPENDIR', err, path)
            }
          })

          sftp.on('READDIR', (reqid, handle) => {
            const d = dirHandles.get(handleId(handle))
            if (!d) {
              log.push({ op: 'READDIR', status: SFTP_STATUS.FAILURE })
              sftp.status(reqid, SFTP_STATUS.FAILURE, 'Invalid handle')
              return
            }
            if (d.served) {
              // 真实服务端在枚举结束后回 EOF；客户端据此停止循环
              log.push({ op: 'READDIR', path: d.path, status: SFTP_STATUS.EOF })
              sftp.status(reqid, SFTP_STATUS.EOF)
              return
            }
            d.served = true
            log.push({ op: 'READDIR', path: d.path, status: SFTP_STATUS.OK, bytes: d.entries.length })
            sftp.name(reqid, d.entries)
          })

          sftp.on('REMOVE', (reqid, path) => {
            try {
              fs.unlinkSync(mapPath(path))
              respond(reqid, 'REMOVE', SFTP_STATUS.OK, path)
            } catch (err) {
              fail(reqid, 'REMOVE', err, path)
            }
          })

          sftp.on('MKDIR', (reqid, path, attrs) => {
            try {
              const local = mapPath(path)
              fs.mkdirSync(local, { mode: attrs.mode === undefined ? 0o755 : attrs.mode & 0o7777 })
              respond(reqid, 'MKDIR', SFTP_STATUS.OK, path)
            } catch (err) {
              fail(reqid, 'MKDIR', err, path)
            }
          })

          sftp.on('RMDIR', (reqid, path) => {
            try {
              fs.rmdirSync(mapPath(path))
              respond(reqid, 'RMDIR', SFTP_STATUS.OK, path)
            } catch (err) {
              fail(reqid, 'RMDIR', err, path)
            }
          })

          sftp.on('RENAME', (reqid, oldPath, newPath) => {
            try {
              fs.renameSync(mapPath(oldPath), mapPath(newPath))
              respond(reqid, 'RENAME', SFTP_STATUS.OK, oldPath)
            } catch (err) {
              fail(reqid, 'RENAME', err, oldPath)
            }
          })

          sftp.on('REALPATH', (reqid, path) => {
            try {
              const local = mapPath(path)
              const realLocal = fs.existsSync(local) ? fs.realpathSync(local) : local
              const remote = realLocal === realRoot ? '/' : `/${realLocal.slice(realRoot.length + 1).split(sep).join('/')}`
              let st: fs.Stats | undefined
              try {
                st = fs.lstatSync(realLocal)
              } catch {
                st = undefined
              }
              log.push({ op: 'REALPATH', path, status: SFTP_STATUS.OK })
              sftp.name(reqid, [
                {
                  filename: remote,
                  longname: remote,
                  attrs: st ? toWireAttrs(st) : { mode: 0o040755, size: 0 },
                },
              ])
            } catch (err) {
              fail(reqid, 'REALPATH', err, path)
            }
          })

          sftp.on('READLINK', (reqid, path) => {
            try {
              const target = fs.readlinkSync(mapPath(path))
              log.push({ op: 'READLINK', path, status: SFTP_STATUS.OK })
              sftp.name(reqid, [{ filename: target, longname: target, attrs: {} }])
            } catch (err) {
              fail(reqid, 'READLINK', err, path)
            }
          })

          sftp.on('SYMLINK', (reqid, linkPath, targetPath) => {
            try {
              fs.symlinkSync(targetPath, mapPath(linkPath))
              respond(reqid, 'SYMLINK', SFTP_STATUS.OK, linkPath)
            } catch (err) {
              fail(reqid, 'SYMLINK', err, linkPath)
            }
          })
        })

        session.on('pty', (accept) => accept?.())
        session.on('window-change', (accept) => accept?.())

        /** 真实 shell：用 child_process 起一个交互式 shell，管道对接到通道 */
        session.on('shell', (accept) => {
          const stream = accept()
          const child: ChildProcessWithoutNullStreams = spawn(shellBin, [], {
            cwd: realRoot,
            env: { ...process.env, PS1: '', TERM: process.env.TERM ?? 'xterm' },
            stdio: 'pipe',
          })
          log.push({ op: 'SHELL', status: SFTP_STATUS.OK, command: shellBin })

          /**
           * 用管道代替 pty，就得自己补上内核 tty 做的两件事，否则界面像"死"的：
           * - **回显**：真实 pty 由 ECHO 标志回显输入。没有回显，客户端 xterm 的
           *   光标永远停在 (0,0)，终端里看不到自己敲了什么。
           * - **CR → NL**：终端回车发的是 `\r`，tty 的 ICRNL 会翻译成 `\n` 再交给 shell。
           *   少了这一步，bash 会把整行当成没结束的输入，一条命令都不会执行。
           * 这两点是**测试夹具**在补 tty 的课，产品代码不依赖它。
           */
          stream.on('data', (chunk: Buffer) => {
            const text = chunk.toString('utf8')
            try {
              stream.write(text.replace(/\r\n?/g, '\r\n'))
            } catch {
              /* 通道已关 */
            }
            child.stdin.write(text.replace(/\r\n?/g, '\n'))
          })
          // { end: false }：让孩子进程退出时的 stdout 结束**不要**顺手 end 掉通道，
          // 否则 exit-status 还没发出去通道就关了（exec 的退出码就是这么丢的）
          child.stdout.pipe(stream, { end: false })
          child.stderr.pipe(stream, { end: false })

          stream.on('close', () => child.kill())
          stream.on('end', () => child.kill())
          child.on('close', (code: number | null) => {
            log.push({ op: 'SHELL', status: SFTP_STATUS.OK, exitCode: code ?? 0 })
            try {
              stream.exit(code ?? 0)
              stream.end()
            } catch {
              /* 通道可能已被对端关掉 */
            }
          })
          child.on('error', () => {
            try {
              stream.exit(127)
              stream.end()
            } catch {
              /* ignore */
            }
          })
        })

        /** 真实 exec：`spawn(cmd, { shell: true })`，退出码与 stdout/stderr 都真实回传 */
        session.on('exec', (accept, _reject, info: { command?: string }) => {
          const command = info?.command ?? ''
          const stream = accept()
          const child: ChildProcessWithoutNullStreams = spawn(command, {
            shell: true,
            cwd: realRoot,
            env: process.env,
            stdio: 'pipe',
          })
          log.push({ op: 'EXEC', command, status: SFTP_STATUS.OK })

          // 同 shell：不能让 pipe 的自动 end 抢在 exit-status 前面
          child.stdout.pipe(stream, { end: false })
          child.stderr.pipe(stream.stderr, { end: false })

          stream.on('close', () => child.kill())
          child.on('close', (code: number | null) => {
            log.push({ op: 'EXEC', command, status: SFTP_STATUS.OK, exitCode: code ?? 0 })
            try {
              stream.exit(code ?? 0)
              stream.end()
            } catch {
              /* ignore */
            }
          })
          child.on('error', (err) => {
            log.push({ op: 'EXEC', command, status: SFTP_STATUS.FAILURE, exitCode: 127 })
            try {
              stream.stderr.write(String(err.message))
              stream.exit(127)
              stream.end()
            } catch {
              /* ignore */
            }
          })
        })
      })
    })
  })

  const port = await new Promise<number>((resolvePort, rejectPort) => {
    server.once('error', rejectPort)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (typeof address === 'object' && address !== null) resolvePort(address.port)
      else rejectPort(new Error('无法获得测试服务端端口'))
    })
  })

  return {
    host: '127.0.0.1',
    port,
    root: realRoot,
    log,
    /** 观测到的最大并发文件句柄数（验证并发闸门真的生效） */
    get maxConcurrentOpens(): number {
      return counters.maxOpens
    },
    credentials: {
      host: '127.0.0.1',
      port,
      username: 'tester',
      password: TEST_SFTP_PASSWORD,
      privateKey: clientPrivateKey,
    },
    async close(): Promise<void> {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
      // 只删自己建的临时目录
      if (options.root === undefined) rmSync(root, { recursive: true, force: true })
    },
  }
}



/** 语义化别名（这是完整 SSH 测试主机，不只是 SFTP） */
export const startTestSshHost = startTestSftpServer
