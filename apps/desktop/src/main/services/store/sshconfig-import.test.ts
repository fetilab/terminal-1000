// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 转换层与导入编排的单测：ProxyJump 多跳、私钥读取、dryRun、三种冲突策略、
 * unsupported 上报、以及"导入后敏感字段确实被加密"。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Connection } from '@t1000/shared'
import { parseSshConfig } from './sshconfig'
import { buildImportEntries, parseJumpSpec } from './sshconfig-import'
import { importOpenSshConfig, nextAvailableName, type ConnectionSink } from './sshconfig-service'
import { memIo } from './sshconfig.test'
import { StoreDb } from './db'
import { Repository } from './repository'
import { LOCKED_MASK, Vault, deriveKey, isCiphertext } from './crypto'
import { STORE_KEYS } from './db'

const CONFIG = '/home/tester/.ssh/config'
const HOME = '/home/tester'

/**
 * 取连接的"目标主机"。
 *
 * `Connection` 是五态联合，`TunnelConnection` 没有 `host`（它用 localHost/remoteHost），
 * 所以不能直接 `conn.host`。统一走这个收窄 helper——项目里 sync.test.ts 也是这么做的。
 */
function hostOf(conn: Connection): string {
  return conn.kind === 'tunnel' ? conn.localHost : conn.host
}

/** 构造 parse+build 的便捷入口 */
function build(text: string, extra: Record<string, string> = {}) {
  const io = memIo({ [CONFIG]: text, ...extra }, HOME)
  const parsed = parseSshConfig(CONFIG, io)
  return { ...buildImportEntries(parsed, io), parsed, io }
}

/** 内存 sink（不涉及加密），用于纯粹测冲突策略 */
function memSink(initial: Connection[] = []): ConnectionSink & { saved: Connection[] } {
  const saved: Connection[] = [...initial]
  return {
    saved,
    listConnections: () => saved,
    saveConnection(input: Connection) {
      const idx = saved.findIndex((c) => c.id === input.id)
      if (idx >= 0) saved[idx] = input
      else saved.push(input)
      return input
    },
  }
}

function sshConn(name: string, id = `id-${name}`): Connection {
  return {
    kind: 'ssh',
    id,
    name,
    host: '1.1.1.1',
    port: 22,
    username: 'u',
    authType: 'password',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
}

describe('parseJumpSpec：ProxyJump 单条目解析', () => {
  it('裸主机名', () => {
    expect(parseJumpSpec('bastion')).toEqual({ host: 'bastion' })
  })

  it('user@host', () => {
    expect(parseJumpSpec('alice@bastion')).toEqual({ host: 'bastion', username: 'alice' })
  })

  it('user@host:port', () => {
    expect(parseJumpSpec('alice@bastion:2222')).toEqual({
      host: 'bastion',
      username: 'alice',
      port: 2222,
    })
  })

  it('host:port（无用户名）', () => {
    expect(parseJumpSpec('bastion:2200')).toEqual({ host: 'bastion', port: 2200 })
  })

  it('IPv6 方括号写法 [::1]:2222', () => {
    expect(parseJumpSpec('[::1]:2222')).toEqual({ host: '::1', port: 2222 })
    expect(parseJumpSpec('[2001:db8::1]')).toEqual({ host: '2001:db8::1' })
  })

  it('裸 IPv6（含冒号但不是端口）整体当主机名', () => {
    expect(parseJumpSpec('2001:db8::1')).toEqual({ host: '2001:db8::1' })
  })

  it('引号包裹', () => {
    expect(parseJumpSpec('"alice@bastion"')).toEqual({ host: 'bastion', username: 'alice' })
  })

  it('空串返回 null', () => {
    expect(parseJumpSpec('')).toBeNull()
    expect(parseJumpSpec('   ')).toBeNull()
  })
})

describe('ProxyJump → 跳板链', () => {
  it('单跳映射为一个 JumpHop', () => {
    const { entries } = build(['Host web', '  HostName 10.0.0.1', '  ProxyJump bastion'].join('\n'))
    const web = entries[0]!
    expect(web.jumpChain).toHaveLength(1)
    expect(web.jumpChain[0]!.host).toBe('bastion')
    expect(web.jumpChain[0]!.port).toBe(22)
    expect(web.jumpChain[0]!.id).toBeTruthy() // 每跳都有 id
  })

  it('多跳 `a,b` 按顺序映射', () => {
    const { entries } = build(
      ['Host web', '  ProxyJump alice@bastion:2200,bob@inner:22'].join('\n'),
    )
    const chain = entries[0]!.jumpChain
    expect(chain).toHaveLength(2)
    expect(chain[0]!).toMatchObject({ host: 'bastion', port: 2200, username: 'alice' })
    expect(chain[1]!).toMatchObject({ host: 'inner', port: 22, username: 'bob' })
  })

  it('`ProxyJump none` 表示显式禁用跳板', () => {
    const { entries } = build(['Host web', '  ProxyJump none'].join('\n'))
    expect(entries[0]!.jumpChain).toEqual([])
  })

  it('跳板在 config 里有定义时，内联补全它的 HostName/User/私钥', () => {
    const { entries } = build(
      [
        'Host bastion',
        '  HostName bastion.example.com',
        '  User jumpuser',
        '  IdentityFile ~/.ssh/bastion_key',
        '',
        'Host web',
        '  HostName 10.0.0.1',
        '  User webuser',
        '  ProxyJump bastion',
      ].join('\n'),
      { '/home/tester/.ssh/bastion_key': 'BASTION-KEY-CONTENT' },
    )

    const web = entries.find((e) => e.name === 'web')!
    const hop = web.jumpChain[0]!
    // 用的是 HostName 而不是别名
    expect(hop.host).toBe('bastion.example.com')
    expect(hop.username).toBe('jumpuser')
    expect(hop.privateKey).toBe('BASTION-KEY-CONTENT')
    expect(hop.authType).toBe('privateKey')
  })

  it('跳板无法解析时进 warnings 而非崩溃', () => {
    const { entries } = build(['Host web', '  ProxyJump "unclosed'].join('\n'))
    expect(entries[0]!.jumpChain).toEqual([])
  })
})

describe('IdentityFile → privateKey', () => {
  it('读到私钥内容并切到 privateKey 认证', () => {
    const { entries } = build(['Host web', '  IdentityFile ~/.ssh/id_ed25519'].join('\n'), {
      '/home/tester/.ssh/id_ed25519': '-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END-----\n',
    })
    const web = entries[0]!
    expect(web.privateKey).toContain('BEGIN OPENSSH PRIVATE KEY')
    expect(web.privateKeyPath).toBe('~/.ssh/id_ed25519')
  })

  it('私钥读不出来 → 只 warning，不抛错，且指明是哪一条', () => {
    const { entries } = build(['Host web', '  IdentityFile ~/.ssh/missing_key'].join('\n'))
    const web = entries[0]!
    expect(web.privateKey).toBeUndefined()
    expect(web.warnings.some((w) => w.includes('私钥不可读'))).toBe(true)
    expect(web.warnings.some((w) => w.includes('missing_key'))).toBe(true)
    // 条目本身仍然产出
    expect(entries).toHaveLength(1)
  })

  it('IdentityFile none 被忽略', () => {
    const { entries } = build(['Host web', '  IdentityFile none'].join('\n'))
    const web = entries[0]!
    expect(web.privateKey).toBeUndefined()
    // 不应产生任何"私钥"相关的警告
    expect(web.warnings.filter((w) => w.includes('私钥'))).toEqual([])
  })

  it('多个 IdentityFile：取第一个并提示', () => {
    const { entries } = build(
      ['Host web', '  IdentityFile ~/.ssh/k1', '  IdentityFile ~/.ssh/k2'].join('\n'),
      { '/home/tester/.ssh/k1': 'KEY1', '/home/tester/.ssh/k2': 'KEY2' },
    )
    expect(entries[0]!.privateKey).toBe('KEY1')
    expect(entries[0]!.warnings.some((w) => w.includes('2 个 IdentityFile'))).toBe(true)
  })
})

describe('HostName / Port / User 映射', () => {
  it('HostName 缺失时用别名当主机名并 warning', () => {
    const { entries } = build(['Host myalias', '  User u'].join('\n'))
    expect(entries[0]!.host).toBe('myalias')
    expect(entries[0]!.impliedHostName).toBe(true)
    expect(entries[0]!.warnings.some((w) => w.includes('未指定 HostName'))).toBe(true)
  })

  it('Port 非法时回落 22 并 warning', () => {
    const { entries } = build(['Host web', '  Port not-a-number'].join('\n'))
    expect(entries[0]!.port).toBe(22)
    expect(entries[0]!.warnings.some((w) => w.includes('Port 不是合法数字'))).toBe(true)
  })

  it('Port 正常解析', () => {
    const { entries } = build(['Host web', '  Port 2222'].join('\n'))
    expect(entries[0]!.port).toBe(2222)
  })

  it('User 缺失时不臆造本地用户名，只留 warning', () => {
    const { entries } = build(['Host web', '  HostName 1.1.1.1'].join('\n'))
    expect(entries[0]!.username).toBeUndefined()
  })
})

describe('unsupported 如实上报', () => {
  it('未知指令进 unsupported，带 host 与原因', () => {
    const { unsupported } = build(['Host web', '  WeirdDirective foo'].join('\n'))
    const item = unsupported.find((u) => u.directive === 'weirddirective')
    expect(item).toBeDefined()
    expect(item!.host).toBe('web')
    expect(item!.reason).toBeTruthy()
  })

  it('已知但不映射的指令给出具体原因（ProxyCommand 等）', () => {
    const { unsupported } = build(['Host web', '  ProxyCommand nc %h %p'].join('\n'))
    const pc = unsupported.find((u) => u.directive === 'proxycommand')
    expect(pc).toBeDefined()
    expect(pc!.reason).toContain('ProxyCommand')
  })

  it('已支持的指令不进 unsupported', () => {
    const { unsupported } = build(
      ['Host web', '  HostName 1.1.1.1', '  User u', '  Port 22', '  IdentityFile none'].join('\n'),
    )
    expect(unsupported.filter((u) => u.directive === 'hostname')).toEqual([])
    expect(unsupported.filter((u) => u.directive === 'user')).toEqual([])
  })

  it('同一 host 的同一指令只上报一次', () => {
    const { unsupported } = build(['Host web', '  Weird 1', '  Weird 2', '  Weird 3'].join('\n'))
    expect(unsupported.filter((u) => u.directive === 'weird')).toHaveLength(1)
  })

  it('ProxyCommand 会额外进该条目的 warnings', () => {
    const { entries } = build(['Host web', '  ProxyCommand nc %h %p'].join('\n'))
    expect(entries[0]!.warnings.some((w) => w.includes('ProxyCommand'))).toBe(true)
  })
})

describe('importOpenSshConfig：dryRun 与冲突策略', () => {
  const baseConfig = ['Host web', '  HostName 10.0.0.1', '  User u'].join('\n')

  it('dryRun 完全不写库', () => {
    const io = memIo({ [CONFIG]: baseConfig }, HOME)
    const sink = memSink()

    const result = importOpenSshConfig({ path: CONFIG, io, sink, dryRun: true })

    expect(result.dryRun).toBe(true)
    expect(result.parsed).toBe(1)
    expect(result.entries).toHaveLength(1) // 仍给出预览
    expect(sink.saved).toEqual([]) // 但一条都没写
    expect(sink.listConnections()).toEqual([])
  })

  it('dryRun 也会预演冲突计数（UI 需要提前告诉用户）', () => {
    const io = memIo({ [CONFIG]: baseConfig }, HOME)
    const sink = memSink([sshConn('web')])

    const result = importOpenSshConfig({ path: CONFIG, io, sink, dryRun: true, conflictPolicy: 'skip' })
    expect(result.skipped).toBe(1)
    expect(result.created).toBe(0)
    expect(sink.saved).toHaveLength(1) // 没写
  })

  it('非 dryRun 真正写库', () => {
    const io = memIo({ [CONFIG]: baseConfig }, HOME)
    const sink = memSink()

    const result = importOpenSshConfig({ path: CONFIG, io, sink })

    expect(result.created).toBe(1)
    expect(sink.saved).toHaveLength(1)
    expect(sink.saved[0]!.name).toBe('web')
  })

  it('conflictPolicy=skip：同名跳过并计数', () => {
    const io = memIo({ [CONFIG]: baseConfig }, HOME)
    const sink = memSink([sshConn('web')])

    const result = importOpenSshConfig({ path: CONFIG, io, sink, conflictPolicy: 'skip' })

    expect(result.skipped).toBe(1)
    expect(result.created).toBe(0)
    expect(result.renamed).toBe(0)
    expect(result.overwritten).toBe(0)
    expect(sink.saved).toHaveLength(1) // 没动
  })

  it('conflictPolicy=rename：生成 "web (2)" 并计数', () => {
    const io = memIo({ [CONFIG]: baseConfig }, HOME)
    const sink = memSink([sshConn('web')])

    const result = importOpenSshConfig({ path: CONFIG, io, sink, conflictPolicy: 'rename' })

    expect(result.renamed).toBe(1)
    expect(result.created).toBe(0)
    expect(result.skipped).toBe(0)
    expect(sink.saved.map((c) => c.name).sort()).toEqual(['web', 'web (2)'])
    expect(result.entries[0]!.name).toBe('web (2)')
  })

  it('conflictPolicy=overwrite：覆盖已有连接并计数', () => {
    const io = memIo({ [CONFIG]: baseConfig }, HOME)
    const existing = sshConn('web', 'fixed-id')
    const sink = memSink([existing])

    const result = importOpenSshConfig({ path: CONFIG, io, sink, conflictPolicy: 'overwrite' })

    expect(result.overwritten).toBe(1)
    expect(result.created).toBe(0)
    expect(sink.saved).toHaveLength(1) // 没新增
    expect(sink.saved[0]!.id).toBe('fixed-id') // 沿用原 id，引用不断
    expect(hostOf(sink.saved[0]!)).toBe('10.0.0.1') // 值被更新
  })

  it('rename 时重名递进到 (3)', () => {
    const io = memIo({ [CONFIG]: baseConfig }, HOME)
    const sink = memSink([sshConn('web'), sshConn('web (2)')])

    const result = importOpenSshConfig({ path: CONFIG, io, sink, conflictPolicy: 'rename' })
    expect(result.entries[0]!.name).toBe('web (3)')
  })

  it('rename 在 dryRun 下也不会与同批次内其它条目撞名', () => {
    const io = memIo({ [CONFIG]: baseConfig }, HOME)
    const sink = memSink([sshConn('web')])

    const result = importOpenSshConfig({ path: CONFIG, io, sink, conflictPolicy: 'rename', dryRun: true })
    expect(result.entries[0]!.name).toBe('web (2)')
  })

  it('默认策略是 skip', () => {
    const io = memIo({ [CONFIG]: baseConfig }, HOME)
    const sink = memSink([sshConn('web')])
    const result = importOpenSshConfig({ path: CONFIG, io, sink })
    expect(result.skipped).toBe(1)
  })

  it('无冲突时三种策略行为一致（都新建）', () => {
    for (const policy of ['skip', 'rename', 'overwrite'] as const) {
      const io = memIo({ [CONFIG]: baseConfig }, HOME)
      const sink = memSink()
      const result = importOpenSshConfig({ path: CONFIG, io, sink, conflictPolicy: policy })
      expect(result.created).toBe(1)
      expect(result.entries[0]!.name).toBe('web')
    }
  })

  it('parsed 反映解析出的 Host 数，含被跳过的', () => {
    const io = memIo(
      { [CONFIG]: ['Host a', 'Host b', 'Host *', '  User d'].join('\n') },
      HOME,
    )
    const sink = memSink()
    const result = importOpenSshConfig({ path: CONFIG, io, sink })
    expect(result.parsed).toBe(2) // a、b；Host * 不算
  })

  it('errors 带行号与文本', () => {
    const io = memIo({ [CONFIG]: ['Host a', '  HostName "bad'].join('\n') }, HOME)
    const sink = memSink()
    const result = importOpenSshConfig({ path: CONFIG, io, sink })
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]!.line).toBe(2)
  })

  it('nextAvailableName 基本行为', () => {
    expect(nextAvailableName('x', new Set())).toBe('x (2)')
    expect(nextAvailableName('x', new Set(['x (2)']))).toBe('x (3)')
  })
})

describe('导入后的连接确实被加密存储', () => {
  let db: StoreDb
  let vault: Vault
  let repo: Repository

  beforeEach(() => {
    db = new StoreDb(':memory:')
    vault = new Vault()
    vault.unlockWithKey(deriveKey('master', Buffer.alloc(16, 5)))
    repo = new Repository(db, () => vault.currentKey())
  })

  afterEach(() => db.close())

  it('私钥以密文落库，读回是明文', () => {
    const io = memIo(
      { [CONFIG]: ['Host web', '  HostName 1.1.1.1', '  IdentityFile ~/.ssh/k'].join('\n'),
        '/home/tester/.ssh/k': 'MY-SUPER-SECRET-KEY' },
      HOME,
    )

    const result = importOpenSshConfig({ path: CONFIG, io, sink: repo })
    expect(result.created).toBe(1)

    // 原始行里绝不能出现私钥明文
    const row = repo.readRow(STORE_KEYS.server, result.entries[0]!.name === 'web' ? (repo.listConnections()[0] as { id: string }).id : '')
    expect(row).toBeDefined()
    expect(row!.payload).not.toContain('MY-SUPER-SECRET-KEY')

    const stored = repo.listConnections()[0] as { privateKey?: string }
    expect(isCiphertext(JSON.parse(row!.payload).privateKey)).toBe(true)
    expect(stored.privateKey).toBe('MY-SUPER-SECRET-KEY') // 解锁态读回明文
  })

  it('跳板的私钥同样被加密', () => {
    const io = memIo(
      {
        [CONFIG]: [
          'Host bastion',
          '  HostName b.example.com',
          '  User jump',
          '  IdentityFile ~/.ssh/bkey',
          'Host web',
          '  HostName 10.0.0.1',
          '  ProxyJump bastion',
        ].join('\n'),
        '/home/tester/.ssh/bkey': 'BASTION-SECRET',
      },
      HOME,
    )

    importOpenSshConfig({ path: CONFIG, io, sink: repo })

    const web = repo.listConnections().find((c) => c.name === 'web') as {
      jumpChain?: Array<{ privateKey?: string }>
    }
    expect(web.jumpChain![0]!.privateKey).toBe('BASTION-SECRET')

    // 库里是密文
    const id = (repo.listConnections().find((c) => c.name === 'web') as { id: string }).id
    const row = repo.readRow(STORE_KEYS.server, id)!
    expect(row.payload).not.toContain('BASTION-SECRET')
  })

  it('锁定后私钥读作掩码', () => {
    const io = memIo(
      { [CONFIG]: ['Host web', '  IdentityFile ~/.ssh/k'].join('\n'),
        '/home/tester/.ssh/k': 'SECRET' },
      HOME,
    )
    importOpenSshConfig({ path: CONFIG, io, sink: repo })
    vault.lock()

    const stored = repo.listConnections()[0] as { privateKey?: string }
    expect(stored.privateKey).toBe(LOCKED_MASK)
  })
})
