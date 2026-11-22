// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 快速命令的**系统内置动态变量**（spec §6.3）。
 *
 * 全部是纯函数：时间、随机、UUID、剪贴板、主机信息都由 `VariableContext` 注入，
 * 单测可以完全确定（不用 mock 时钟、不用真的读剪贴板）。
 *
 * 「当前值预览」是 spec 的硬要求 —— 用户看不到预览就不敢用变量，
 * 所以 `variablePreview()` / `listVariablePreviews()` 是这一层的一等公民；
 * 机密变量（password）预览时打码，但仍告诉 UI「有值」。
 */

import { randomUUID, randomBytes } from 'node:crypto'
import { hostname as osHostname, networkInterfaces, userInfo } from 'node:os'

export interface VariableContext {
  now?: Date
  /** 生成随机字符串（默认 crypto） */
  randomString?: (length: number) => string
  uuid?: () => string
  /** 系统剪贴板内容（主进程注入；没有则为空） */
  clipboard?: string
  /** 当前 SSH 连接的登录密码（机密） */
  password?: string
  hostname?: string
  username?: string
  /** 本机 IP（取第一个非回环 IPv4） */
  localIp?: string
}

export interface VariableDef {
  name: string
  description: string
  /** 默认格式（展示用，如 YYYY-MM-DD） */
  defaultFormat: string
  /** 示例输出（文档/占位） */
  example: string
  /** 变量值是否机密：预览需打码、不写历史 */
  secret?: boolean
  /** 支持的格式说明 */
  formats?: string
}

/** 内置变量表（spec §6.3 的 8 个 + 任务要求的主机名/用户名/本机 IP） */
export const DYNAMIC_VARIABLES: readonly VariableDef[] = [
  {
    name: 'date',
    description: '当前日期',
    defaultFormat: 'YYYY-MM-DD',
    example: '2025-11-29',
    formats: 'YYYY / YY / MM / DD / YYYYMMDD / YYYY-MM',
  },
  {
    name: 'time',
    description: '当前时间',
    defaultFormat: 'HH:mm:ss',
    example: '14:30:45',
    formats: 'HH / mm / ss / HHmmss',
  },
  {
    name: 'timestamp',
    description: 'Unix 时间戳（秒）',
    defaultFormat: '-',
    example: '1732869000',
  },
  {
    name: 'week',
    description: '一年中的第几周（ISO 周）',
    defaultFormat: '-',
    example: '48',
  },
  {
    name: 'uuid',
    description: '生成 UUID（v4）',
    defaultFormat: '-',
    example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
  },
  {
    name: 'random',
    description: '生成随机字符串',
    defaultFormat: '6',
    example: 'xK9mPq',
    formats: 'random:N（默认 6，范围 1-64）',
  },
  {
    name: 'clipboard',
    description: '获取系统剪贴板内容',
    defaultFormat: '-',
    example: '（剪贴板文本）',
  },
  {
    name: 'password',
    description: '当前 SSH 连接的登录密码',
    defaultFormat: '-',
    example: '（自动填充）',
    secret: true,
  },
  // —— 以下为任务要求补充的常用变量（参考实现文档未列出，但同属"系统内置"语义）——
  {
    name: 'hostname',
    description: '本机主机名',
    defaultFormat: '-',
    example: 'dev-workstation',
  },
  {
    name: 'username',
    description: '本机登录用户名',
    defaultFormat: '-',
    example: 'mosfet',
  },
  {
    name: 'ip',
    description: '本机 IP 地址（第一个非回环 IPv4）',
    defaultFormat: '-',
    example: '192.0.2.20',
  },
]

const VARIABLE_NAMES = new Set(DYNAMIC_VARIABLES.map((v) => v.name))

/** 该名字是否是内置动态变量（决定它是"绿色标签"还是"蓝色自定义参数"） */
export function isDynamicVariable(name: string): boolean {
  return VARIABLE_NAMES.has(name.trim())
}

export function getVariableDef(name: string): VariableDef | undefined {
  const key = name.trim()
  return DYNAMIC_VARIABLES.find((v) => v.name === key)
}

// ---------------------------------------------------------------------------
// 求值
// ---------------------------------------------------------------------------

const RANDOM_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'

function defaultRandomString(length: number): string {
  const bytes = randomBytes(length)
  let out = ''
  for (let i = 0; i < length; i++) {
    out += RANDOM_CHARS[(bytes[i] ?? 0) % RANDOM_CHARS.length]
  }
  return out
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, '0')
}

/** ISO-8601 周数（一年中的第几周） */
export function isoWeek(date: Date): number {
  const target = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()))
  const dayNum = (target.getUTCDay() + 6) % 7 // 周一=0
  target.setUTCDate(target.getUTCDate() - dayNum + 3) // 该周周四
  const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4))
  const firstDayNum = (firstThursday.getUTCDay() + 6) % 7
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNum + 3)
  const diff = target.getTime() - firstThursday.getTime()
  return 1 + Math.round(diff / (7 * 24 * 3600 * 1000))
}

/**
 * 按格式串替换日期/时间 token。
 * 支持 YYYY YY MM DD HH mm ss；未识别的字符原样保留（所以分隔符随便写）。
 */
export function formatDateTime(date: Date, format: string): string {
  const tokens: Record<string, string> = {
    YYYY: String(date.getFullYear()),
    YY: pad(date.getFullYear() % 100),
    MM: pad(date.getMonth() + 1),
    DD: pad(date.getDate()),
    HH: pad(date.getHours()),
    mm: pad(date.getMinutes()),
    ss: pad(date.getSeconds()),
  }
  return format.replace(/YYYY|YY|MM|DD|HH|mm|ss/g, (token) => tokens[token] ?? token)
}

function resolveLocalIp(): string {
  try {
    const interfaces = networkInterfaces()
    for (const list of Object.values(interfaces)) {
      for (const info of list ?? []) {
        if (info.family === 'IPv4' && !info.internal) return info.address
      }
    }
  } catch {
    /* 取不到就返回空串，不抛 */
  }
  return ''
}

function resolveDefault(name: string, ctx: VariableContext): string | undefined {
  switch (name) {
    case 'hostname':
      return ctx.hostname ?? (() => {
        try {
          return osHostname()
        } catch {
          return ''
        }
      })()
    case 'username':
      return ctx.username ?? (() => {
        try {
          return userInfo().username
        } catch {
          return ''
        }
      })()
    case 'ip':
      return ctx.localIp ?? resolveLocalIp()
    default:
      return undefined
  }
}

/**
 * 求值一个动态变量。
 *
 * @param name 变量名（date/time/...）
 * @param format `${{name:format}}` 里的格式部分；未给则用默认格式
 * @returns 生成的值；未知变量名返回空串（调用方应先用 isDynamicVariable 判定）
 */
export function evaluateVariable(name: string, format: string | undefined, ctx: VariableContext = {}): string {
  const key = name.trim()
  const now = ctx.now ?? new Date()
  const rng = ctx.randomString ?? defaultRandomString

  switch (key) {
    case 'date':
      return formatDateTime(now, format?.trim() || 'YYYY-MM-DD')
    case 'time':
      return formatDateTime(now, format?.trim() || 'HH:mm:ss')
    case 'timestamp':
      return String(Math.floor(now.getTime() / 1000))
    case 'week':
      return String(isoWeek(now))
    case 'uuid':
      return (ctx.uuid ?? randomUUID)()
    case 'random': {
      const requested = format?.trim() === undefined || format?.trim() === '' ? 6 : Number(format.trim())
      const length = Number.isFinite(requested) ? Math.min(Math.max(Math.floor(requested), 1), 64) : 6
      return rng(length)
    }
    case 'clipboard':
      return ctx.clipboard ?? ''
    case 'password':
      return ctx.password ?? ''
    default:
      return resolveDefault(key, ctx) ?? ''
  }
}

// ---------------------------------------------------------------------------
// 当前值预览（spec 硬要求）
// ---------------------------------------------------------------------------

export interface VariablePreview {
  name: string
  description: string
  /** 实际使用的格式（用户没写格式时是默认格式） */
  format: string
  /** 当前值；机密变量返回打码后的文本 */
  value: string
  /** 是否打码 */
  masked: boolean
  /** 是否有可用值（password/clipboard 可能为空） */
  hasValue: boolean
  /** 是否机密 */
  secret: boolean
}

const MASK = '••••••••'

/** 单个变量的当前值预览 */
export function variablePreview(
  def: VariableDef,
  ctx: VariableContext = {},
  format?: string,
): VariablePreview {
  const raw = evaluateVariable(def.name, format, ctx)
  if (def.secret) {
    return {
      name: def.name,
      description: def.description,
      format: format?.trim() || def.defaultFormat,
      value: raw === '' ? '' : MASK,
      masked: true,
      hasValue: raw !== '',
      secret: true,
    }
  }
  return {
    name: def.name,
    description: def.description,
    format: format?.trim() || def.defaultFormat,
    value: raw,
    masked: false,
    hasValue: raw !== '',
    secret: false,
  }
}

/** 变量辅助面板的完整数据（点 `?` 时展示） */
export function listVariablePreviews(ctx: VariableContext = {}): VariablePreview[] {
  return DYNAMIC_VARIABLES.map((def) => variablePreview(def, ctx))
}

/** 生成可插入编辑器的变量片段文本 */
export function variableSnippet(name: string, format?: string): string {
  return format === undefined || format === '' ? `\${{${name}}}` : `\${{${name}:${format}}}`
}
