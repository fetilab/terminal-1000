// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * `~/.ssh/config` → `SshConnection` 的转换与落库。
 *
 * 分三层，每层都能单独测：
 * 1. `parseSshConfig`（sshconfig.ts）—— 纯文本 → HostBlock[]
 * 2. `buildImportEntries` —— HostBlock[] → 待导入条目（读私钥、解析 ProxyJump）
 * 3. `importOpenSsh`（本文件末尾）—— 处理冲突策略并写库
 */

import { randomUUID } from 'node:crypto'
import type { JumpHop, SshConnection } from '@t1000/shared'
import type { ParseIo, ParsedConfig } from './sshconfig'
import {
  KNOWN_UNMAPPED,
  SUPPORTED_DIRECTIVES,
  getBool,
  getDirective,
  getInt,
  resolveHosts,
  type EffectiveHost,
} from './sshconfig'

/** 未被映射的指令 */
export interface UnsupportedItem {
  directive: string
  host?: string
  reason: string
}

/** 解析出的一个待导入条目 */
export interface ImportEntry {
  /** 建议的连接名（配置里的 Host 别名） */
  name: string
  host: string
  port: number
  username?: string
  /** HostName 缺失时为 true（用别名当主机名） */
  impliedHostName: boolean
  privateKey?: string
  privateKeyPath?: string
  jumpChain: JumpHop[]
  proxyCommand?: string
  identitiesOnly?: boolean
  forwardAgent?: boolean
  warnings: string[]
}

/** 转换结果 */
export interface BuildResult {
  entries: ImportEntry[]
  unsupported: UnsupportedItem[]
}

/**
 * 把解析结果转换成待导入条目。
 *
 * 不写库、不抛业务异常：读不到私钥只往 `warnings` 里记一条。
 */
export function buildImportEntries(parsed: ParsedConfig, io: ParseIo): BuildResult {
  const hosts = resolveHosts(parsed.blocks)

  // 跳板补全用：别名 → 生效配置。跳板通常是独立的一个 Host 段，
  // 不在当前 Host 的 matchedBlocks 里，所以需要全量索引。
  const byName = new Map<string, EffectiveHost>()
  for (const h of hosts) byName.set(h.name.toLowerCase(), h)

  const entries: ImportEntry[] = []
  const unsupported: UnsupportedItem[] = []
  // 同一个 host 的同一指令只报一次 unsupported，避免刷屏
  const reported = new Set<string>()

  for (const host of hosts) {
    const entry = buildEntry(host, io, byName)

    // 收集未支持项：遍历该 Host 命中的段里出现过的所有指令
    for (const [directive] of host.directives) {
      if (SUPPORTED_DIRECTIVES.includes(directive)) continue
      const dedupeKey = `${host.name}\u0000${directive}`
      if (reported.has(dedupeKey)) continue
      reported.add(dedupeKey)
      unsupported.push({
        directive,
        host: host.name,
        reason: KNOWN_UNMAPPED[directive] ?? '本版本未支持该指令，未导入其语义',
      })
    }

    // 已知但不映射的指令（如 ProxyCommand）单独提示
    for (const [directive, reason] of Object.entries(KNOWN_UNMAPPED)) {
      if (!host.directives.has(directive)) continue
      if (directive === 'proxycommand') {
        // ProxyCommand 的值要带到条目上，供 UI 提示"这条需要手工配代理"
        entry.warnings.push(`ProxyCommand 未映射：${reason}`)
      }
      const dedupeKey = `${host.name}\u0000known:${directive}`
      if (reported.has(dedupeKey)) continue
      reported.add(dedupeKey)
      unsupported.push({ directive, host: host.name, reason })
    }

    entries.push(entry)
  }

  return { entries, unsupported }
}

/** 单个 Host → 条目 */
function buildEntry(
  host: EffectiveHost,
  io: ParseIo,
  byName: ReadonlyMap<string, EffectiveHost>,
): ImportEntry {
  const warnings: string[] = []

  const rawHostName = getDirective(host, 'hostname')
  const impliedHostName = rawHostName === undefined
  // HostName 缺失时，OpenSSH 用配置里的别名当目标主机名，这里保持一致
  const targetHost = rawHostName ?? host.name
  if (impliedHostName) {
    warnings.push(`未指定 HostName，已用别名 "${host.name}" 作为主机名`)
  }

  const port = getInt(host, 'port') ?? 22
  if (getDirective(host, 'port') !== undefined && getInt(host, 'port') === undefined) {
    warnings.push(`Port 不是合法数字："${getDirective(host, 'port')}"，已回落为 22`)
  }

  const username = getDirective(host, 'user')

  // 私钥：IdentityFile 可多次出现，但我们的契约只放一把 → 取第一把，其余进 warning
  const identityFiles = collectIdentityFiles(host)
  let privateKey: string | undefined
  let privateKeyPath: string | undefined

  if (identityFiles.length > 0) {
    const first = identityFiles[0]!
    privateKeyPath = first
    const content = readIdentity(first, io)
    if (content === null) {
      // 关键要求：读不出来只警告，不中断
      warnings.push(`私钥不可读，已跳过：${first}`)
    } else {
      privateKey = content
    }
    if (identityFiles.length > 1) {
      warnings.push(
        `配置了 ${identityFiles.length} 个 IdentityFile，仅导入第一个（${first}）`,
      )
    }
  }

  const jumpChain = buildJumpChain(host, io, byName, warnings)

  const identitiesOnly = host.directives.has('identitiesonly')
    ? getBool(host, 'identitiesonly', false)
    : undefined
  const forwardAgent = host.directives.has('forwardagent')
    ? getBool(host, 'forwardagent', false)
    : undefined

  const entry: ImportEntry = {
    name: host.name,
    host: targetHost,
    port,
    jumpChain,
    impliedHostName,
    warnings,
  }
  if (username !== undefined) entry.username = username
  if (privateKey !== undefined) entry.privateKey = privateKey
  if (privateKeyPath !== undefined) entry.privateKeyPath = privateKeyPath
  if (identitiesOnly !== undefined) entry.identitiesOnly = identitiesOnly
  if (forwardAgent !== undefined) entry.forwardAgent = forwardAgent

  const proxyCommand = getDirective(host, 'proxycommand')
  if (proxyCommand !== undefined) entry.proxyCommand = proxyCommand

  return entry
}

/** 收集 IdentityFile（含 `~` 展开与引号已处理的路径） */
function collectIdentityFiles(host: EffectiveHost): string[] {
  const out: string[] = []
  for (const block of host.matchedBlocks) {
    const values = block.directives.get('identityfile')
    if (!values) continue
    for (const v of values) {
      if (v.trim() === '' || v.toLowerCase() === 'none') continue
      if (!out.includes(v)) out.push(v)
    }
  }
  // 注意：这里要按 first-wins 语义取"第一个匹配段里的第一个值"，
  // 但 IdentityFile 是累加型，OpenSSH 会把所有匹配段的都试一遍。
  // 我们用 matchedBlocks 的顺序（文件顺序），因此 out[0] 就是优先级最高的一把。
  return out
}

/** 读私钥内容；返回 null 表示不可读 */
function readIdentity(path: string, io: ParseIo): string | null {
  const resolved = io.paths.resolve(path, io.home)
  const content = io.readFile(resolved)
  if (content === null) return null
  return content
}

/**
 * ProxyJump → JumpHop[]。
 *
 * 支持两种写法：
 * - `ProxyJump bastion`（单跳）
 * - `ProxyJump alice@bastion:2222,bob@inner:22`（多跳，逗号分隔，按顺序）
 * - `ProxyJump none` → 显式禁用跳板
 */
function buildJumpChain(
  host: EffectiveHost,
  io: ParseIo,
  byName: ReadonlyMap<string, EffectiveHost>,
  warnings: string[],
): JumpHop[] {
  const raw = getDirective(host, 'proxyjump')
  if (raw === undefined) return []

  const trimmed = raw.trim()
  if (trimmed === '' || trimmed.toLowerCase() === 'none') return []

  const hops: JumpHop[] = []
  const specs = trimmed.split(',')

  for (const spec of specs) {
    const s = spec.trim()
    if (s === '') continue

    const parsed = parseJumpSpec(s)
    if (!parsed) {
      warnings.push(`ProxyJump 条目无法解析，已跳过："${s}"`)
      continue
    }

    // 跳板的私钥/用户名：`ssh -J` 会去 config 里找同名 Host 并套用它的设置。
    // 这里做一次内联补全，让导入后的连接**脱离原 config 文件也能用**。
    const inlineBlock = byName.get(parsed.host.toLowerCase())
    const inline = inlineBlock ? buildInlineJump(inlineBlock, io) : undefined

    const username = parsed.username ?? inline?.username ?? ''
    const hop: JumpHop = {
      id: randomUUID(),
      name: inline?.name ?? parsed.host,
      host: inline?.host ?? parsed.host,
      port: parsed.port ?? inline?.port ?? 22,
      username,
      authType: inline?.privateKey !== undefined ? 'privateKey' : 'password',
      // 跳板默认校验指纹（安全默认），与 SshConnection 的默认行为一致
      verifyHostKey: true,
    }

    if (inline?.privateKey !== undefined) {
      hop.privateKey = inline.privateKey
      if (inline.passphrase !== undefined) hop.passphrase = inline.passphrase
    }
    if (username === '') {
      warnings.push(`跳板 ${parsed.host} 未提供用户名（config 里也没有对应 Host 定义）`)
    }

    hops.push(hop)
  }

  return hops
}

interface JumpSpec {
  username?: string
  host: string
  port?: number
}

/**
 * 判断是否是**未加方括号**的 IPv6 字面量。
 *
 * 判据：含 2 个及以上冒号（`host:port` 最多一个冒号），或含 `::` 压缩写法。
 * 这类输入里的冒号属于地址本身，不能当端口分隔符。
 * 带方括号的 `[::1]:22` 由上面的分支处理，不会走到这里。
 */
function isBareIpv6(value: string): boolean {
  if (value.includes('::')) return true
  const colons = (value.match(/:/g) ?? []).length
  return colons >= 2
}

/** 解析 `[user@]host[:port]`（host 可能被 [] 包裹） */
export function parseJumpSpec(spec: string): JumpSpec | null {
  let rest = spec.trim()
  if (rest === '') return null

  // 去掉 ProxyJump 里可能出现的引号
  if (
    (rest.startsWith('"') && rest.endsWith('"') && rest.length >= 2) ||
    (rest.startsWith("'") && rest.endsWith("'") && rest.length >= 2)
  ) {
    rest = rest.slice(1, -1)
  }

  let username: string | undefined
  const at = rest.lastIndexOf('@')
  if (at >= 0) {
    username = rest.slice(0, at)
    rest = rest.slice(at + 1)
  }

  let host = rest
  let port: number | undefined

  if (rest.startsWith('[')) {
    // [ipv6]:port
    const close = rest.indexOf(']')
    if (close < 0) return null
    host = rest.slice(1, close)
    const tail = rest.slice(close + 1)
    if (tail.startsWith(':')) {
      const p = Number.parseInt(tail.slice(1), 10)
      if (Number.isFinite(p)) port = p
    }
  } else if (!isBareIpv6(rest)) {
    // 只有"不是裸 IPv6"时才按 `host:port` 拆。
    // 裸 IPv6（如 2001:db8::1）里的冒号是地址分隔符，不是端口分隔符——
    // 若不排除，`2001:db8::1` 会被错误拆成 host=`2001:db8:` port=`1`。
    const colon = rest.lastIndexOf(':')
    if (colon >= 0) {
      const maybePort = rest.slice(colon + 1)
      // 双保险：冒号后必须全是数字，且剩余部分本身还得像个主机名
      if (/^\d+$/.test(maybePort) && !rest.slice(0, colon).endsWith(':')) {
        host = rest.slice(0, colon)
        const p = Number.parseInt(maybePort, 10)
        if (Number.isFinite(p)) port = p
      }
    }
  }

  if (host === '') return null
  const out: JumpSpec = { host }
  if (username !== undefined && username !== '') out.username = username
  if (port !== undefined) out.port = port
  return out
}

interface InlineJump {
  name: string
  host: string
  port: number
  username?: string
  privateKey?: string
  passphrase?: string
}

/**
 * 取跳板 Host 段的内联信息（HostName/Port/User/IdentityFile）。
 *
 * 只做一跳的浅查找，不递归跳板的跳板——递归链路由 OpenSSH 自己处理，
 * 我们导入时保持结果可预期。
 */
function buildInlineJump(block: EffectiveHost, io: ParseIo): InlineJump {
  const hostName = getDirective(block, 'hostname') ?? block.name
  const port = getInt(block, 'port') ?? 22
  const username = getDirective(block, 'user')

  const out: InlineJump = { name: block.name, host: hostName, port }
  if (username !== undefined) out.username = username

  const identityFiles = collectIdentityFiles(block)
  const first = identityFiles[0]
  if (first !== undefined) {
    const content = readIdentity(first, io)
    if (content !== null) {
      out.privateKey = content
      // 跳板的 passphrase 在 OpenSSH 里由 agent/Keychain 提供，config 无对应指令；
      // 这里不臆造值，让 UI 在导入后提示用户补。
    }
  }

  return out
}
