// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * MCP 策略单测：安全默认、路径白名单（含**真实符号链接绕过**）、令牌、工具注册表。
 * 路径测试在 os.tmpdir() 里造真实目录与软链，不碰用户数据目录。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  DEFAULT_MCP_POLICY,
  MCP_TOOLS,
  PathAccessError,
  TokenRegistry,
  assertLocalPathAllowed,
  assertServerAllowed,
  digestToken,
  enabledToolDefs,
  extractBearer,
  isLoopbackHost,
  isServerAllowed,
  looksLikeTraversal,
  normalizePolicy,
  withAllowedDirs,
  withAllowedServers,
  withEnabledTools,
} from './policy'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 't1000-mcp-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('安全默认（必须最保守）', () => {
  it('默认只听回环、无服务器、无目录、每次确认、sudo 禁用', () => {
    const p = normalizePolicy(undefined)
    expect(p.listenHost).toBe('127.0.0.1')
    expect(isLoopbackHost(p.listenHost)).toBe(true)
    expect(p.executionPolicy).toBe('confirm')
    expect(p.sudoPolicy).toBe('deny')
    expect(p.workspacePolicy).toBe('confirm')
    expect(p.allowedServerIds).toEqual([])
    expect(p.allowedLocalDirs).toEqual([])
    expect(p.port).toBe(12335)
    expect(p.defaultTimeoutMs).toBe(60_000)
    expect(p.maxTimeoutMs).toBe(600_000)
  })

  it('端口非法直接拒绝（不自动换端口）', () => {
    expect(() => normalizePolicy({ port: 80 })).toThrow(/1024-65535/)
    expect(() => normalizePolicy({ port: 70000 })).toThrow(/1024-65535/)
    expect(() => normalizePolicy({ port: 12335.5 })).toThrow(/1024-65535/)
    expect(normalizePolicy({ port: 12335 }).port).toBe(12335)
  })

  it('超时被夹到合理区间且 max >= default', () => {
    const p = normalizePolicy({ defaultTimeoutMs: 10, maxTimeoutMs: 5 })
    expect(p.defaultTimeoutMs).toBeGreaterThanOrEqual(1000)
    expect(p.maxTimeoutMs).toBeGreaterThanOrEqual(p.defaultTimeoutMs)
    expect(normalizePolicy({ defaultTimeoutMs: 9_999_999 }).maxTimeoutMs).toBe(600_000)
  })

  it('服务器/目录去重；目录规范化为绝对路径', () => {
    const p = normalizePolicy({ allowedServerIds: ['s1', 's1', 's2'], allowedLocalDirs: [root, root] })
    expect(p.allowedServerIds).toEqual(['s1', 's2'])
    expect(p.allowedLocalDirs).toEqual([resolve(root)])
  })

  it('isLoopbackHost 只认回环', () => {
    expect(isLoopbackHost('localhost')).toBe(true)
    expect(isLoopbackHost('::1')).toBe(true)
    expect(isLoopbackHost('0.0.0.0')).toBe(false)
    expect(isLoopbackHost('192.0.2.5')).toBe(false)
  })
})

describe('服务器白名单', () => {
  it('默认不暴露任何服务器', () => {
    const p = normalizePolicy(undefined)
    expect(isServerAllowed('s1', p)).toBe(false)
    expect(() => assertServerAllowed('s1', p)).toThrow(/未被授权/)
  })

  it('指定服务器只放行命中的 id（新增连接不会自动获得权限）', () => {
    const p = withAllowedServers(normalizePolicy(undefined), ['s1'])
    expect(isServerAllowed('s1', p)).toBe(true)
    expect(isServerAllowed('s2', p)).toBe(false)
  })

  it("'all' 放行全部（不推荐的显式选择）", () => {
    const p = withAllowedServers(normalizePolicy(undefined), 'all')
    expect(isServerAllowed('anything', p)).toBe(true)
  })
})

describe('★ 本地路径校验（防 .. 与符号链接绕过）', () => {
  it('未配置目录时一律拒绝', async () => {
    await expect(assertLocalPathAllowed(join(root, 'a'), normalizePolicy(undefined))).rejects.toThrow(
      /未配置允许访问的本地目录/,
    )
  })

  it('白名单内的真实文件放行，并返回 realpath', async () => {
    const allowed = join(root, 'allowed')
    mkdirSync(allowed)
    writeFileSync(join(allowed, 'ok.txt'), 'hi')
    const p = withAllowedDirs(normalizePolicy(undefined), [allowed])

    const real = await assertLocalPathAllowed(join(allowed, 'ok.txt'), p, { mustExist: true })
    expect(real).toBe(join(resolve(allowed), 'ok.txt'))
  })

  it('`..` 穿越被拒（无论目标是否存在）', async () => {
    const allowed = join(root, 'allowed')
    const outside = join(root, 'outside')
    mkdirSync(allowed)
    mkdirSync(outside)
    writeFileSync(join(outside, 'secret.txt'), 'secret')
    const p = withAllowedDirs(normalizePolicy(undefined), [allowed])

    await expect(
      assertLocalPathAllowed(join(allowed, '..', 'outside', 'secret.txt'), p, { mustExist: true }),
    ).rejects.toThrow(PathAccessError)
    // 写目标（父目录存在）同样被拒
    await expect(
      assertLocalPathAllowed(join(allowed, '..', 'outside', 'new.txt'), p),
    ).rejects.toThrow(/路径越出允许范围|父目录/)
    // 注意用字面量：path.join('a','..','b') 会直接把 .. 规约掉，测不出预检
    expect(looksLikeTraversal('a/../b')).toBe(true)
    expect(looksLikeTraversal('/a/../../etc')).toBe(true)
    expect(looksLikeTraversal('/a/b')).toBe(false)
  })

  it('★ 白名单目录内的软链指向外部 → 拒绝（realpath 判定，不是字符串匹配）', async () => {
    const allowed = join(root, 'allowed')
    const outside = join(root, 'outside')
    mkdirSync(allowed)
    mkdirSync(outside)
    writeFileSync(join(outside, 'secret.txt'), 'secret')
    // 在允许目录里放一个指向外部的软链
    symlinkSync(outside, join(allowed, 'escape'))
    symlinkSync(join(outside, 'secret.txt'), join(allowed, 'secret-link.txt'))

    const p = withAllowedDirs(normalizePolicy(undefined), [allowed])

    // 字符串前缀看起来"在 allowed 里"，但实际解析到外部
    expect(join(allowed, 'escape', 'secret.txt').startsWith(allowed)).toBe(true)
    await expect(
      assertLocalPathAllowed(join(allowed, 'escape', 'secret.txt'), p, { mustExist: true }),
    ).rejects.toThrow(/路径越出允许范围/)
    await expect(
      assertLocalPathAllowed(join(allowed, 'secret-link.txt'), p, { mustExist: true }),
    ).rejects.toThrow(/路径越出允许范围/)
    // 通过软链目录写新文件也被拒
    await expect(
      assertLocalPathAllowed(join(allowed, 'escape', 'new.txt'), p),
    ).rejects.toThrow(/路径越出允许范围/)
  })

  it('软链指向白名单内部时放行（不能把正常软链也误杀）', async () => {
    const allowed = join(root, 'allowed')
    const inner = join(root, 'allowed', 'inner')
    mkdirSync(inner, { recursive: true })
    writeFileSync(join(inner, 'file.txt'), 'x')
    symlinkSync(inner, join(allowed, 'link-inner'))
    const p = withAllowedDirs(normalizePolicy(undefined), [allowed])

    const real = await assertLocalPathAllowed(join(allowed, 'link-inner', 'file.txt'), p, { mustExist: true })
    expect(real).toBe(join(inner, 'file.txt'))
  })

  it('不存在的路径（写目标）：父目录在范围内则放行，父目录在范围外则拒绝', async () => {
    const allowed = join(root, 'allowed')
    mkdirSync(allowed)
    const p = withAllowedDirs(normalizePolicy(undefined), [allowed])

    const target = await assertLocalPathAllowed(join(allowed, 'new.txt'), p)
    expect(target).toBe(join(resolve(allowed), 'new.txt'))

    await expect(assertLocalPathAllowed(join(root, 'nope', 'new.txt'), p)).rejects.toThrow()
  })

  it('拒绝 NUL 与空路径', async () => {
    const p = withAllowedDirs(normalizePolicy(undefined), [root])
    await expect(assertLocalPathAllowed('', p)).rejects.toThrow(/不能为空/)
    await expect(assertLocalPathAllowed('a\0b', p)).rejects.toThrow(/NUL/)
  })

  it('父目录是软链指向外部 → 拒绝（写目标场景）', async () => {
    const allowed = join(root, 'allowed')
    const outside = join(root, 'outside')
    mkdirSync(allowed)
    mkdirSync(outside)
    symlinkSync(outside, join(allowed, 'outlink'))
    const p = withAllowedDirs(normalizePolicy(undefined), [allowed])

    await expect(assertLocalPathAllowed(join(allowed, 'outlink', 'x.txt'), p)).rejects.toThrow(
      /路径越出允许范围/,
    )
  })
})

describe('令牌', () => {
  it('创建只回一次明文，列表里只有摘要字段被剥离', () => {
    const registry = new TokenRegistry()
    const { client, token } = registry.createClient('Codex', { allowSudo: true })

    expect(token).toMatch(/^[A-Za-z0-9_-]{20,}$/)
    expect(client).not.toHaveProperty('tokenDigest')
    expect(registry.list()[0]).not.toHaveProperty('tokenDigest')
    // 摘要确实能在内部对上
    expect(registry.verify(token)?.id).toBe(client.id)
  })

  it('没有/错误/伪造令牌都被拒', () => {
    const registry = new TokenRegistry()
    registry.createClient('claude')
    expect(registry.verify(undefined)).toBeUndefined()
    expect(registry.verify('')).toBeUndefined()
    expect(registry.verify('wrong-token')).toBeUndefined()
    expect(registry.verify(digestToken('x'))).toBeUndefined()
  })

  it('撤销后立即失效', () => {
    const registry = new TokenRegistry()
    const { client, token } = registry.createClient('Codex')
    expect(registry.verify(token)).toBeDefined()
    expect(registry.revoke(client.id)).toBe(true)
    expect(registry.verify(token)).toBeUndefined()
    expect(registry.revoke(client.id)).toBe(false)
  })

  it('extractBearer 解析大小写与空白', () => {
    expect(extractBearer('Bearer abc')).toBe('abc')
    expect(extractBearer('bearer   abc  ')).toBe('abc')
    expect(extractBearer('Basic abc')).toBeUndefined()
    expect(extractBearer(undefined)).toBeUndefined()
  })
})

describe('工具注册表', () => {
  it('全部工具都用 t1000_ 前缀且覆盖四组', () => {
    const groups = new Set(MCP_TOOLS.map((t) => t.group))
    expect(groups).toEqual(new Set(['workspace', 'ssh', 'files', 'transfer']))
    for (const tool of MCP_TOOLS) expect(tool.name.startsWith('t1000_')).toBe(true)
    expect(MCP_TOOLS.map((t) => t.name)).toContain('t1000_ssh_list_servers')
    expect(MCP_TOOLS.map((t) => t.name)).toContain('t1000_ssh_exec')
    expect(MCP_TOOLS.map((t) => t.name)).toContain('t1000_ssh_sudo_exec')
  })

  it('enabledTools 为空 = 全部；过滤生效；全滤空时至少保留一个', () => {
    const all = enabledToolDefs(normalizePolicy(undefined))
    expect(all.length).toBe(MCP_TOOLS.length)

    const only = enabledToolDefs(withEnabledTools(normalizePolicy(undefined), ['t1000_ssh_exec']))
    expect(only.map((t) => t.name)).toEqual(['t1000_ssh_exec'])

    const noneMatch = enabledToolDefs(
      normalizePolicy({ ...DEFAULT_MCP_POLICY, enabledTools: ['t1000_not_exists'] }),
    )
    expect(noneMatch).toHaveLength(1)
  })

  it('withEnabledTools 拒绝未知工具名', () => {
    expect(() => withEnabledTools(normalizePolicy(undefined), ['nope'])).toThrow(/未知的 MCP 工具/)
  })
})
