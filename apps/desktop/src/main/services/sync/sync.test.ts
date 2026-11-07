// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 同步客户端端到端测试。
 *
 * **起真实的后端**（同一仓库的 server/）而不是 mock fetch：
 * 鉴权、版本冲突、密文往返这些只有在真实 HTTP 上才暴露得出来，
 * 也顺便验证了客户端与后端两侧的契约一致。
 *
 * 关于"多客户端"：sync 的内存状态是模块级单例（生产下每个应用实例一份），
 * 所以测试里用 _resetSyncStateForTests / _setLastVersionForTests 显式模拟
 * "另一个实例"与"过期的客户端"，而不是依赖隐式共享状态。
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Connection, SshConnection } from '@t1000/shared'
import { StoreService, setStoreService } from '../store'
import { getSettings, resetSettingsCache, updateSettings } from '../settings'
import { _resetSyncStateForTests, _setLastVersionForTests, syncHandlers } from './index'

// ── 启动真实后端 ──────────────────────────────────────

const serverDataDir = mkdtempSync(join(tmpdir(), 't1000-sync-client-'))
process.env.T1000_DATA_DIR = serverDataDir

// 动态 import：必须在设置 T1000_DATA_DIR 之后。
// 路径层级：sync → services → main → src → desktop → apps → 仓库根（6 层）
const { createServer } = await import('../../../../../../server/src/index.js')

interface MiniServer {
  listen(port: number, host: string, cb: () => void): void
  close(cb: () => void): void
  address(): { port: number } | string | null
}

let server: MiniServer
let endpointUrl: string

const MASTER_PASSWORD = 'master-password-1'
const USER_PASSWORD = 'passw0rd-strong'
/** 同步口令（仓库密码）—— 与登录口令独立 */
const SYNC_PASSPHRASE = 'sync-passphrase-1'

/** IPC 上下文替身 */
const ctx = {
  logger: { debug() {}, info() {}, warn() {}, error() {} },
  paths: {
    userData: '/tmp',
    dbFile: ':memory:',
    notesDir: '/tmp',
    sessionLogDir: '/tmp',
    watchDir: '/tmp',
    bgImagesDir: '/tmp',
    backupDir: '/tmp',
    logDir: '/tmp',
  },
  emit() {},
} as never

const call = <T = unknown>(action: string, payload?: unknown): Promise<T> => {
  const handler = syncHandlers[action]
  if (!handler) throw new Error(`未实现: ${action}`)
  return Promise.resolve(handler(payload, ctx) as T)
}

/** 建一个已解锁的独立库（代表一台机器） */
function makeUnlockedStore(): StoreService {
  const store = new StoreService(':memory:')
  store.unlock(MASTER_PASSWORD)
  return store
}

/** 模拟"切到另一个应用实例"：换库 + 清空内存同步状态 */
function useClient(store: StoreService): void {
  setStoreService(store)
  _resetSyncStateForTests()
  // 设置也存放在 store 的 KV 里：换库必须一并清掉 settings 的内存缓存，
  // 否则会读到上一个库的设置（含被旧主密钥封装的令牌/口令，必然解不开）。
  resetSettingsCache()
}

/**
 * 取连接的"目标主机"。
 *
 * `Connection` 是五态联合，隧道用 localHost/remoteHost，没有 host 字段；
 * 直接 `c.host` 会在隧道成员上编译失败。集中收窄一次，别到处写 `'host' in c`。
 */
function hostOf(conn: Connection): string {
  return conn.kind === 'tunnel' ? conn.localHost : conn.host
}

function sampleConnection(id: string, host: string): SshConnection {
  const now = new Date().toISOString()
  return {
    kind: 'ssh',
    id,
    name: `host-${id}`,
    host,
    port: 22,
    username: 'tester',
    authType: 'password',
    password: 'secret-password',
    createdAt: now,
    updatedAt: now,
  }
}

let userSeq = 0
function uniqueUser(prefix: string): string {
  userSeq += 1
  return `${prefix}-${userSeq}`
}

describe('sync 端到端（真实后端）', () => {
  beforeAll(async () => {
    server = createServer() as unknown as MiniServer
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const addr = server.address()
    if (!addr || typeof addr === 'string') throw new Error('无法获取后端端口')
    endpointUrl = `http://127.0.0.1:${addr.port}`
  }, 20_000)

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(resolve))
    rmSync(serverDataDir, { recursive: true, force: true })
  })

  beforeEach(() => {
    useClient(makeUnlockedStore())
    updateSettings({ sync: { endpoint: endpointUrl, enabled: true, token: '' } })
  })

  afterEach(() => {
    setStoreService(null)
    resetSettingsCache()
    _resetSyncStateForTests()
  })

  it('status 初始为未登录', async () => {
    const s = await call<{ loggedIn: boolean; endpoint: string; state: string }>('status', {})
    expect(s.loggedIn).toBe(false)
    expect(s.endpoint).toBe(endpointUrl)
    expect(s.state).toBe('idle')
  })

  it('★ 令牌以密文存放，不是明文', async () => {
    await call('login', {
      endpoint: endpointUrl,
      username: uniqueUser('tokenuser'),
      password: USER_PASSWORD, passphrase: SYNC_PASSPHRASE,
      register: true,
    })

    const s = await call<{ loggedIn: boolean }>('status', {})
    expect(s.loggedIn).toBe(true)

    const stored = getSettings().sync.token
    expect(stored).toBeTruthy()
    // 本机封装的密文格式：v1:salt:iv:tag:cipher
    expect(stored!.startsWith('v1:')).toBe(true)
    // 状态接口绝不回传令牌本身
    expect(JSON.stringify(s)).not.toContain(stored)
  })

  it('登录失败抛错', async () => {
    const user = uniqueUser('wrongpass')
    await call('login', { endpoint: endpointUrl, username: user, password: USER_PASSWORD, passphrase: SYNC_PASSPHRASE, register: true })
    await expect(call('login', { endpoint: endpointUrl, username: user, password: 'totally-wrong' })).rejects.toThrow()
  })

  it('未登录时 push/pull 拒绝', async () => {
    await expect(call('pull', {})).rejects.toThrow(/未登录/)
  })

  it('★ push → pull 往返：换一台机器也能拿到数据（含加密字段）', async () => {
    // 机器 A：写入两条连接并上传
    const machineA = makeUnlockedStore()
    useClient(machineA)
    machineA.saveConnection(sampleConnection('c1', '10.0.0.1'))
    machineA.saveConnection(sampleConnection('c2', '10.0.0.2'))

    const user = uniqueUser('roundtrip')
    await call('login', { endpoint: endpointUrl, username: user, password: USER_PASSWORD, passphrase: SYNC_PASSPHRASE, register: true })

    const pushed = await call<{ version: number; bytes: number }>('push', {})
    expect(pushed.version).toBe(1)
    expect(pushed.bytes).toBeGreaterThan(0)

    // 机器 B：全新空库（另一台设备）。它没有 A 的令牌，必须自己登录；
    // 但只要知道同一个同步口令，就能解开云端密文 —— 这正是"仓库密码"的意义。
    const machineB = makeUnlockedStore()
    useClient(machineB)
    await call('login', {
      endpoint: endpointUrl,
      username: user,
      password: USER_PASSWORD,
      passphrase: SYNC_PASSPHRASE,
    })

    const pulled = await call<{ version: number }>('pull', { mode: 'replace' })
    expect(pulled.version).toBe(1)

    const conns = machineB.listConnections()
    expect(conns).toHaveLength(2)
    expect(conns.map(hostOf).sort()).toEqual(['10.0.0.1', '10.0.0.2'])
    // 说明：这里只断言"数据被搬运成功"（非敏感字段）。
    // 敏感字段的跨设备可读性由下面那条用例单独看护。
  })

  /**
   * 跨设备凭据可移植性。
   *
   * 曾是已知缺陷：备份信封用同步口令加密，但信封内的敏感字段
   * 仍是**各机主密钥**的字段级密文，换设备导入后解不开 → 凭据静默失效。
   * 修复后：带口令导出时把敏感字段用主密钥解密、再用备份密钥重新加密；
   * 导入时反向操作，落到目标机器自己的主密钥之下。
   *
   * 本用例当初以 `it.fails` 标记该缺陷；修复后它"意外通过"而变红，
   * 正是预留的信号 —— 现已转正为普通用例。
   */
  it('★ 跨设备同步后敏感字段可读回原值（曾为缺陷，已修复）', async () => {
    const machineA = makeUnlockedStore()
    useClient(machineA)
    machineA.saveConnection(sampleConnection('cred', '10.1.1.1'))

    const user = uniqueUser('credential-portability')
    await call('login', {
      endpoint: endpointUrl,
      username: user,
      password: USER_PASSWORD,
      passphrase: SYNC_PASSPHRASE,
      register: true,
    })
    await call('push', {})

    // 另一台机器（不同主密钥），同一同步口令
    const machineB = makeUnlockedStore()
    useClient(machineB)
    await call('login', {
      endpoint: endpointUrl,
      username: user,
      password: USER_PASSWORD,
      passphrase: SYNC_PASSPHRASE,
    })
    await call('pull', { mode: 'replace' })

    const migrated = machineB.listConnections().find((c) => hostOf(c) === '10.1.1.1') as SshConnection
    expect(migrated.password).toBe('secret-password')
  })

  it('连续 push 递增版本号', async () => {
    const user = uniqueUser('versioner')
    await call('login', { endpoint: endpointUrl, username: user, password: USER_PASSWORD, passphrase: SYNC_PASSPHRASE, register: true })

    const first = await call<{ version: number }>('push', {})
    const second = await call<{ version: number }>('push', {})
    expect(first.version).toBe(1)
    expect(second.version).toBe(2)
  })

  it('远端无快照时 pull 明确报错', async () => {
    await call('login', {
      endpoint: endpointUrl,
      username: uniqueUser('emptyuser'),
      password: USER_PASSWORD, passphrase: SYNC_PASSPHRASE,
      register: true,
    })
    await expect(call('pull', {})).rejects.toThrow(/还没有快照/)
  })

  it('★ 过期客户端 push 触发冲突；keep=local 可强制覆盖', async () => {
    const user = uniqueUser('conflicted')
    await call('login', { endpoint: endpointUrl, username: user, password: USER_PASSWORD, passphrase: SYNC_PASSPHRASE, register: true })
    await call('push', {}) // v1

    // 模拟"别人又推了一版"：直接伪造本地已知版本为旧值
    _setLastVersionForTests(1)
    // 服务端推进到 v2（由另一个实例完成）
    const other = makeUnlockedStore()
    useClient(other)
    await call('login', { endpoint: endpointUrl, username: user, password: USER_PASSWORD, passphrase: SYNC_PASSPHRASE })
    await call('push', {}) // v2

    // 回到过期客户端（它仍认为远端是 v1）
    _setLastVersionForTests(1)
    await expect(call('push', {})).rejects.toThrow(/冲突/)

    // keep=local → 强制覆盖，成功
    const resolved = await call<{ resolved: string; version: number }>('resolveConflict', { keep: 'local' })
    expect(resolved.resolved).toBe('local')
    expect(resolved.version).toBeGreaterThanOrEqual(3)
  })

  it('★ keep=remote 用远端覆盖本地', async () => {
    const user = uniqueUser('remote-wins')

    // 先由"别的机器"推一份只有 8.8.8.8 的快照
    const otherMachine = makeUnlockedStore()
    useClient(otherMachine)
    otherMachine.saveConnection(sampleConnection('remote-only', '8.8.8.8'))
    await call('login', { endpoint: endpointUrl, username: user, password: USER_PASSWORD, passphrase: SYNC_PASSPHRASE, register: true })
    await call('push', {})

    // 本机有另一条数据，但选择远端优先
    const localMachine = makeUnlockedStore()
    useClient(localMachine)
    localMachine.saveConnection(sampleConnection('local-only', '9.9.9.9'))
    await call('login', { endpoint: endpointUrl, username: user, password: USER_PASSWORD, passphrase: SYNC_PASSPHRASE })
    await call('resolveConflict', { keep: 'remote' })

    const hosts = localMachine.listConnections().map(hostOf)
    expect(hosts).toContain('8.8.8.8')
    expect(hosts).not.toContain('9.9.9.9')
  })

  it('登录后会与服务端对齐版本认知（切换账号不会误判冲突）', async () => {
    const user = uniqueUser('aligned')
    await call('login', { endpoint: endpointUrl, username: user, password: USER_PASSWORD, passphrase: SYNC_PASSPHRASE, register: true })
    await call('push', {}) // v1

    // 另一次登录应自动读到远端 v1，随后基于正确版本提交不会冲突
    _resetSyncStateForTests()
    const login = await call<{ remoteVersion: number }>('login', {
      endpoint: endpointUrl,
      username: user,
      password: USER_PASSWORD, passphrase: SYNC_PASSPHRASE,
    })
    expect(login.remoteVersion).toBe(1)

    const pushed = await call<{ version: number }>('push', {})
    expect(pushed.version).toBe(2)
  })

  it('登出清空令牌并使接口拒绝', async () => {
    await call('login', {
      endpoint: endpointUrl,
      username: uniqueUser('logout-sync'),
      password: USER_PASSWORD, passphrase: SYNC_PASSPHRASE,
      register: true,
    })
    await call('logout', {})

    const s = await call<{ loggedIn: boolean }>('status', {})
    expect(s.loggedIn).toBe(false)
    expect(getSettings().sync.token).toBe('')
    await expect(call('push', {})).rejects.toThrow(/未登录/)
  })

  it('未登录时即使地址为空也先报未登录（错误优先级明确）', async () => {
    updateSettings({ sync: { endpoint: '' } })
    await expect(call('push', {})).rejects.toThrow(/未登录/)
  })

  it('非 http(s) 的服务地址被拒绝（防协议走私）', async () => {
    await expect(
      call('login', { endpoint: 'file:///etc/passwd', username: 'x', password: USER_PASSWORD, passphrase: SYNC_PASSPHRASE }),
    ).rejects.toThrow(/http\(s\)|不合法/)
  })

  it('非法地址不会被当作可用端点', async () => {
    updateSettings({ sync: { endpoint: 'not-a-url' } })
    await expect(
      call('login', { endpoint: 'not-a-url', username: 'x', password: USER_PASSWORD, passphrase: SYNC_PASSPHRASE }),
    ).rejects.toThrow(/不合法/)
  })
})
