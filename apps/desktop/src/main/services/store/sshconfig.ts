// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * OpenSSH `~/.ssh/config` 解析器与连接转换。
 *
 * **本文件是纯逻辑**：不碰文件系统、不认识 Electron、不抛 AppError。
 * 需要读盘的部分（Include 展开、IdentityFile 读取）由调用方通过 `ReadFile` 注入，
 * 这样解析器可以完整单测，也天然支持走内存文件系统。
 *
 * 语法依据 OpenSSH 的 `ssh_config(5)`，实现范围见 SUPPORTED_DIRECTIVES。
 */

/** 读取一个文本文件；返回 null 表示"存在但读不了"（权限等） */
export type ReadFile = (path: string) => string | null

/** 列目录；返回 null 表示不是目录或读不了 */
export type ReadDir = (path: string) => string[] | null

/** 路径判断（纯字符串层面，避免解析器依赖 node:path 的语义细节） */
export interface PathOps {
  /** 解析 ~ 与相对路径 */
  resolve(path: string, base: string): string
  /** 取目录名 */
  dirname(path: string): string
  /** 判断是否绝对路径 */
  isAbsolute(path: string): boolean
  /** 把 glob 展开成匹配的文件列表（支持 * 和 ?） */
  glob(pattern: string): string[]
  /** 目录是否存在且为目录 */
  isDirectory(path: string): boolean
}

/** 解析器需要的外部能力（测试可注入内存实现） */
export interface ParseIo {
  readFile: ReadFile
  readDir: ReadDir
  paths: PathOps
  /** 用户 home 目录，用于展开 `~` */
  home: string
}

/** 一条语法/语义问题（行号 1-based，指原始文件里的行） */
export interface ParseError {
  /** 文件路径（Include 展开后可能是别的文件） */
  file: string
  /** 1-based 行号 */
  line: number
  message: string
  /** 出问题的原始行文本（trim 后） */
  text: string
}

/** 一个 Host 段 */
export interface HostBlock {
  /** 原始模式列表，如 ['web-*', 'www'] */
  patterns: string[]
  /** 指令名（小写）→ 值（可重复的指令保留全部，按出现顺序） */
  directives: Map<string, string[]>
  /** 该段第一行所在文件与行号（诊断用） */
  file: string
  line: number
  /** 是否来自 Include 进来的文件 */
  included: boolean
}

/** 解析结果 */
export interface ParsedConfig {
  /** 按文件出现顺序的 Host 段（含通配符段） */
  blocks: HostBlock[]
  errors: ParseError[]
  /** 实际读过的文件（去重，按读取顺序） */
  files: string[]
}

/** 支持解析的指令（其余进 unsupported） */
export const SUPPORTED_DIRECTIVES: readonly string[] = [
  'host',
  'hostname',
  'port',
  'user',
  'identityfile',
  'proxyjump',
  'proxycommand',
  'identitiesonly',
  'forwardagent',
  'include',
  'addkeystoagent',
  'connecttimeout',
  'serveraliveinterval',
  'serveralivecountmax',
  'compression',
  'stricthostkeychecking',
  'usekeychain',
] as const

/**
 * 已知但**故意不映射**到我们契约的指令 → 说明原因。
 * 这些不当作"未知指令"报错，而是给出准确的"为什么没导入"。
 */
export const KNOWN_UNMAPPED: Record<string, string> = {
  proxycommand: '暂不支持 ProxyCommand 形式的代理（需要任意外部命令执行）',
  connecttimeout: '连接超时已由连接选项统一管理，未映射',
  serveraliveinterval: 'keepalive 由连接选项统一管理，未逐项映射',
  serveralivecountmax: 'keepalive 由连接选项统一管理，未逐项映射',
  compression: '压缩开关未映射到连接选项',
  stricthostkeychecking: '主机指纹校验策略暂不支持按连接配置',
  addkeystoagent: 'SSH agent 行为未映射',
  usekeychain: 'macOS Keychain 集成不适用',
} as const

/** 指令是否是"每个值都算一个"的累加型（IdentityFile 可多次出现） */
const ACCUMULATIVE = new Set(['identityfile', 'include'])

/** 布尔型指令的真值写法 */
const TRUTHY = new Set(['yes', 'true', 'on', '1'])
const FALSY = new Set(['no', 'false', 'off', '0'])

/**
 * 解析一批配置文件。
 *
 * @param entryPath 入口文件（通常是 ~/.ssh/config）
 */
export function parseSshConfig(entryPath: string, io: ParseIo): ParsedConfig {
  const result: ParsedConfig = { blocks: [], errors: [], files: [] }

  // 防循环 include：
  // - `active` 是当前 include 链上的文件（同一条链重复出现 = 真循环）
  // - `readOnce` 保证同一文件只被解析一次（菱形 include 不重复产出 Host）
  const active = new Set<string>()
  const readOnce = new Set<string>()

  parseFile(entryPath, io, result, active, readOnce, /* included */ false, /* depth */ 0)
  return result
}

/** include 嵌套深度上限（防御性；正常配置远达不到） */
const MAX_INCLUDE_DEPTH = 32

function parseFile(
  filePath: string,
  io: ParseIo,
  result: ParsedConfig,
  active: Set<string>,
  readOnce: Set<string>,
  included: boolean,
  depth: number,
): void {
  const resolved = io.paths.resolve(filePath, io.home)

  if (active.has(resolved)) {
    // 循环 include：记一条 error 后正常返回，绝不递归下去
    result.errors.push({
      file: resolved,
      line: 0,
      message: `检测到循环 Include，已跳过：${resolved}`,
      text: '',
    })
    return
  }
  if (readOnce.has(resolved)) return
  if (depth > MAX_INCLUDE_DEPTH) {
    result.errors.push({
      file: resolved,
      line: 0,
      message: `Include 嵌套过深（>${MAX_INCLUDE_DEPTH}），已停止展开`,
      text: '',
    })
    return
  }

  const text = io.readFile(resolved)
  if (text === null) {
    // 入口文件读不到由调用方负责报明确错误；include 目标读不到只记一条 error
    if (!included) return
    result.errors.push({
      file: resolved,
      line: 0,
      message: `Include 的文件无法读取：${resolved}`,
      text: '',
    })
    return
  }

  readOnce.add(resolved)
  active.add(resolved)
  result.files.push(resolved)

  const lines = text.split(/\r?\n/)
  let current: HostBlock | null = null

  for (let i = 0; i < lines.length; i += 1) {
    const lineNo = i + 1
    const raw = lines[i] ?? ''
    const parsed = parseLine(raw)

    if (parsed.kind === 'blank') continue

    if (parsed.kind === 'error') {
      result.errors.push({ file: resolved, line: lineNo, message: parsed.message, text: raw.trim() })
      continue
    }

    const { key, value } = parsed

    if (key === 'host') {
      const patterns = splitPatterns(value)
      if (patterns.length === 0) {
        result.errors.push({
          file: resolved,
          line: lineNo,
          message: 'Host 指令缺少匹配模式',
          text: raw.trim(),
        })
        // 仍然开一个空段，让后续指令有归属，避免误挂到上一个 Host
        current = { patterns: [], directives: new Map(), file: resolved, line: lineNo, included }
        result.blocks.push(current)
        continue
      }
      current = { patterns, directives: new Map(), file: resolved, line: lineNo, included }
      result.blocks.push(current)
      continue
    }

    if (key === 'include') {
      // Include 在文件顺序上就地展开；展开进来的 Host 段按顺序插在当前位置之后，
      // 这与 OpenSSH 的语义一致（后出现的 Host 段优先级更高）。
      const targets = splitWords(value)
      for (const target of targets) {
        for (const expanded of expandInclude(target, resolved, io)) {
          parseFile(expanded, io, result, active, readOnce, true, depth + 1)
        }
      }
      continue
    }

    if (current === null) {
      // 出现在任何 Host 段之前的指令：OpenSSH 里是全局默认值。
      // 我们用一个隐式的 `Host *` 段来承载它，保证语义不丢。
      current = { patterns: ['*'], directives: new Map(), file: resolved, line: lineNo, included }
      result.blocks.push(current)
    }

    addDirective(current, key, value)
  }

  active.delete(resolved)
}

/** 把指令写进段（累加型保留多值） */
function addDirective(block: HostBlock, key: string, value: string): void {
  const existing = block.directives.get(key)
  if (existing && ACCUMULATIVE.has(key)) {
    existing.push(value)
    return
  }
  if (existing) {
    // 非累加型：同一段内后写的覆盖先写的（OpenSSH：first-obtained wins，
    // 但在同一个 Host 段内重复时，后者覆盖前者是更符合直觉且无歧义的近似）
    block.directives.set(key, [value])
    return
  }
  block.directives.set(key, [value])
}

// ------------------------------------------------------------------ 词法

type LineToken =
  | { kind: 'blank' }
  | { kind: 'error'; message: string }
  | { kind: 'ok'; key: string; value: string }

/**
 * 解析一行：处理注释、`Key=Value` / `Key Value`、引号。
 *
 * 行号由调用方维护，这里只关心内容。
 */
function parseLine(raw: string): LineToken {
  let s = raw

  // 去掉行尾注释：`#` 出现在引号之外且位于行首或前面是空白时才算注释。
  // OpenSSH 的注释规则：以 # 开头（忽略前导空白）的行为注释；
  // 行尾 `#` 只有在被空白分隔时才常见，这里按"引号外的 # 且前一个字符是空白"处理。
  s = stripComment(s).trim()
  if (s === '') return { kind: 'blank' }

  // 拆出 key
  let key = ''
  let i = 0
  while (i < s.length && !/[\s=]/.test(s[i]!)) {
    key += s[i]
    i += 1
  }
  if (key === '') {
    return { kind: 'error', message: '无法识别的行（缺少指令名）' }
  }

  // 跳过 key 之后的空白与可选的 '='
  while (i < s.length && /\s/.test(s[i]!)) i += 1
  if (s[i] === '=') {
    i += 1
    while (i < s.length && /\s/.test(s[i]!)) i += 1
  }

  const rest = s.slice(i)
  const unquoted = unquote(rest)
  if (unquoted === null) {
    return { kind: 'error', message: '引号未闭合' }
  }

  return { kind: 'ok', key: key.toLowerCase(), value: unquoted }
}

/** 去掉引号外的注释部分 */
function stripComment(s: string): string {
  let inSingle = false
  let inDouble = false
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i]!
    if (ch === '\\') {
      i += 1
      continue
    }
    if (ch === "'" && !inDouble) inSingle = !inSingle
    else if (ch === '"' && !inSingle) inDouble = !inDouble
    else if (ch === '#' && !inSingle && !inDouble) {
      // 行首的 # 一定是注释；行中的 # 只有前面是空白才算注释，
      // 这样 `ProxyCommand ssh -W %h:%p #tag` 之类不会被误解——
      // 但也保证 `User foo#bar` 里的 # 保留（它是值的一部分）。
      if (i === 0 || /\s/.test(s[i - 1]!)) return s.slice(0, i)
    }
  }
  return s
}

/**
 * 去掉包裹的引号。
 * 返回 null 表示引号未闭合（语法错误）。
 */
function unquote(s: string): string | null {
  const trimmed = s.trim()
  if (trimmed === '') return ''

  const first = trimmed[0]!
  if (first !== '"' && first !== "'") return trimmed

  // 找到配对的结束引号
  let out = ''
  for (let i = 1; i < trimmed.length; i += 1) {
    const ch = trimmed[i]!
    if (ch === '\\' && first === '"' && i + 1 < trimmed.length) {
      out += trimmed[i + 1]
      i += 1
      continue
    }
    if (ch === first) return out
    out += ch
  }
  return null
}

/** 按空白拆分（尊重引号），用于 `Host a b c` / `Include a b` */
export function splitWords(s: string): string[] {
  const out: string[] = []
  let cur = ''
  let inSingle = false
  let inDouble = false
  let started = false

  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i]!
    if (ch === '\\' && inDouble && i + 1 < s.length) {
      cur += s[i + 1]
      i += 1
      started = true
      continue
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle
      started = true
      continue
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble
      started = true
      continue
    }
    if (/\s/.test(ch) && !inSingle && !inDouble) {
      if (started) out.push(cur)
      cur = ''
      started = false
      continue
    }
    cur += ch
    started = true
  }
  if (started) out.push(cur)
  return out
}

/** Host 模式拆分：逗号与空白都算分隔符 */
function splitPatterns(value: string): string[] {
  return splitWords(value)
    .flatMap((w) => w.split(','))
    .map((w) => w.trim())
    .filter((w) => w !== '')
}

// -------------------------------------------------------------- Include 展开

/**
 * 把一个 Include 参数展开成实际文件列表。
 *
 * 支持三类目标（OpenSSH 都允许）：
 * - 具体文件
 * - 目录（读目录下所有文件，跳过 . / .. / 隐藏文件与备份文件）
 * - 通配符（交给 io.paths.glob）
 */
function expandInclude(target: string, baseFile: string, io: ParseIo): string[] {
  const resolved = io.paths.resolve(target, io.paths.dirname(baseFile))

  if (io.paths.isDirectory(resolved)) {
    const entries = io.readDir(resolved) ?? []
    return entries
      .filter((e) => !e.startsWith('.'))
      // 编辑器/备份残留常见后缀，OpenSSH 的目录 include 也会跳过这些
      .filter((e) => !/[~]$/.test(e) && !/\.(bak|old|orig|swp|tmp)$/.test(e))
      .sort()
      .map((e) => `${resolved.replace(/\/+$/, '')}/${e}`)
  }

  // 含通配符：让 glob 决定
  if (/[*?]/.test(resolved)) {
    const matched = io.paths.glob(resolved)
    // glob 结果排序，保证多次解析顺序稳定（进而让测试可复现）
    return [...matched].sort()
  }

  return [resolved]
}

// ---------------------------------------------------------------- 通配符匹配

/**
 * OpenSSH 的 Host 模式匹配（`*` 与 `?`，大小写不敏感）。
 *
 * 手写而非转成正则：`*`/`?` 之外的所有字符都必须按**字面量**处理，
 * 用正则要把 `.` `+` `(` 等全部转义一遍，反而更容易出错。
 */
export function matchHostPattern(pattern: string, host: string): boolean {
  const p = pattern.toLowerCase()
  const h = host.toLowerCase()
  return matchFrom(p, 0, h, 0)
}

function matchFrom(p: string, pi: number, h: string, hi: number): boolean {
  while (pi < p.length) {
    const pc = p[pi]!
    if (pc === '*') {
      // 连续的 * 等价于一个
      let next = pi
      while (next < p.length && p[next] === '*') next += 1
      if (next === p.length) return true // 末尾 * 匹配一切
      for (let skip = hi; skip <= h.length; skip += 1) {
        if (matchFrom(p, next, h, skip)) return true
      }
      return false
    }
    if (pc === '?') {
      if (hi >= h.length) return false
      pi += 1
      hi += 1
      continue
    }
    if (hi >= h.length || p[pi] !== h[hi]) return false
    pi += 1
    hi += 1
  }
  return hi === h.length
}

/** 段是否只由通配模式组成（= 默认值段，不生成连接） */
export function isWildcardOnly(patterns: readonly string[]): boolean {
  return patterns.length > 0 && patterns.every((p) => /[*?]/.test(p))
}

/**
 * 解析出「每个具体 Host」的最终生效值。
 *
 * OpenSSH 的规则（ssh_config(5)）：**首次获得的值生效**（first obtained wins），
 * 文件按顺序扫描，更早出现的 Host 段优先。
 * 因此 `Host web` 段写在 `Host *` 之前时，它的值就覆盖 `Host *` 的默认值。
 *
 * 同时提供 `defaults`：只由通配段提供、未被具体段覆盖的键，
 * 供调用方了解"兜底值"来自哪里。
 */
export interface EffectiveHost {
  /** 该 Host 的名字（配置文件里写的那个别名） */
  name: string
  /** 生效指令（已按 first-wins 合并） */
  directives: Map<string, string>
  /** 该 Host 命中的段（按文件顺序） */
  matchedBlocks: HostBlock[]
  /** 值只来自通配段（即"继承默认值"）的键 */
  fromDefaults: Set<string>
}

/**
 * 扫描全部 Host 段，产出「具体 Host → 生效配置」。
 *
 * @param blocks 解析结果里的全部段（含通配段）
 */
export function resolveHosts(blocks: readonly HostBlock[]): EffectiveHost[] {
  // 1) 收集所有具体 Host 名（保持出现顺序、去重）
  const names: string[] = []
  const seen = new Set<string>()
  for (const block of blocks) {
    for (const pattern of block.patterns) {
      if (isWildcardOnly([pattern])) continue
      const key = pattern.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      names.push(pattern)
    }
  }

  // 2) 对每个具体 Host 做 first-wins 合并
  return names.map((name) => resolveOneHost(name, blocks))
}

/** 单个 Host 的合并（导出以便测试与增量复用） */
export function resolveOneHost(name: string, blocks: readonly HostBlock[]): EffectiveHost {
  const directives = new Map<string, string>()
  const matchedBlocks: HostBlock[] = []
  const fromDefaults = new Set<string>()

  for (const block of blocks) {
    const matched = block.patterns.some((p) => matchHostPattern(p, name))
    if (!matched) continue
    matchedBlocks.push(block)

    const wildcardOnly = isWildcardOnly(block.patterns)
    for (const [key, values] of block.directives) {
      // first-wins：已有值就不覆盖
      if (directives.has(key)) continue
      const first = values[0]
      if (first === undefined) continue
      directives.set(key, first)
      if (wildcardOnly) fromDefaults.add(key)
    }
  }

  return { name, directives, matchedBlocks, fromDefaults }
}

// -------------------------------------------------------------- 指令取值助手

export function getDirective(host: EffectiveHost, key: string): string | undefined {
  return host.directives.get(key.toLowerCase())
}

export function getBool(host: EffectiveHost, key: string, fallback: boolean): boolean {
  const raw = getDirective(host, key)
  if (raw === undefined) return fallback
  const v = raw.toLowerCase()
  if (TRUTHY.has(v)) return true
  if (FALSY.has(v)) return false
  return fallback
}

/** 取整数值（非法值回落到 fallback，并附带一个 warning 由调用方决定是否上报） */
export function getInt(host: EffectiveHost, key: string): number | undefined {
  const raw = getDirective(host, key)
  if (raw === undefined) return undefined
  // 支持前导 + 号（OpenSSH 允许 `Port +22` 这种写法表示"在默认值上累加"，
  // 我们没有可累加的上下文，按字面数值处理）
  const n = Number.parseInt(raw.replace(/^\+/, ''), 10)
  return Number.isFinite(n) ? n : undefined
}
