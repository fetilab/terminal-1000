// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 密码生成器（纯逻辑，与 React 解耦以便单测）。
 *
 * 从 `ToolsView.tsx` 里抽出来的原因有两个，第二个才是关键：
 * 1. spec 验收第 7 条要求「密码生成器参数与熵值正确」——而它此前**零测试**
 * 2. 抽出来一测就发现：**「排除易混淆字符」那个开关什么都不做**（见下）
 *
 * 原实现的字符集字面量**本身就已经去掉了易混淆字符**
 * （`abcdefghijkmnopqrstuvwxyz` 没有 `l`、`ABC…` 没有 `I`/`O`、`23456789` 没有 `0`/`1`），
 * 之后再 `replace(AMBIGUOUS, '')` 自然什么都替换不到 —— 于是"开启"与"关闭"产出**完全相同**的
 * 字符集，那个复选框是个摆设。
 *
 * 现在字符集是**完整**的，是否剔除由开关决定 —— 开关才真的有意义。
 */

/** 完整字符集（含易混淆字符）。是否剔除交给 `excludeAmbiguous` 决定。 */
export const CHARSETS = {
  lower: 'abcdefghijklmnopqrstuvwxyz',
  upper: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  digit: '0123456789',
  symbol: '!@#$%^&*()-_=+[]{};:,.?',
} as const

/**
 * 易混淆字符：数字 0/1、大小写 I/l、小写 o 与大写 O。
 * 用正则 + `/g` —— 用字符串的话 `String.replace` 只会替换**第一处**（或整段子串），
 * 这正是上面那个"开关无效"问题的同源陷阱，写的时候要留意。
 */
export const AMBIGUOUS = /[Il1O0o]/g

/** 长度下限/上限（与界面滑块一致） */
export const MIN_LENGTH = 4
export const MAX_LENGTH = 128

export interface CharsetOptions {
  lower: boolean
  upper: boolean
  digit: boolean
  symbol: boolean
  excludeAmbiguous: boolean
}

/** 按选项拼出实际使用的字符集 */
export function buildPool(options: CharsetOptions): string {
  let pool = ''
  if (options.lower) pool += CHARSETS.lower
  if (options.upper) pool += CHARSETS.upper
  if (options.digit) pool += CHARSETS.digit
  if (options.symbol) pool += CHARSETS.symbol
  return options.excludeAmbiguous ? pool.replace(AMBIGUOUS, '') : pool
}

/** 把用户输入的长度夹到合法区间（界面与逻辑必须用**同一个**结果，见 entropyBits 注释） */
export function clampLength(length: number): number {
  if (!Number.isFinite(length)) return MIN_LENGTH
  return Math.max(MIN_LENGTH, Math.min(MAX_LENGTH, Math.trunc(length)))
}

/** 注入式随机源，便于测试（默认用 crypto） */
export type RandomSource = (max: number) => number

/**
 * `[0, max)` 的无偏随机整数。
 *
 * 用**拒绝采样**消除取模偏差：直接 `rand % max` 在 max 不整除 2^32 时
 * 会让小余数出现得更频繁。`limit` 是能整除 max 的最大区间上界，落在其外的样本丢弃重来。
 */
export function randomInt(max: number, source?: RandomSource): number {
  if (max <= 1) return 0
  if (source) return source(max)
  const limit = Math.floor(0xffffffff / max) * max
  const buf = new Uint32Array(1)
  for (;;) {
    crypto.getRandomValues(buf)
    const v = buf[0] ?? 0
    if (v < limit) return v % max
  }
}

/** 生成密码；`pool` 应当已经过 `buildPool`（本函数不再二次清洗，避免"清洗了两次"的误解） */
export function generate(length: number, pool: string, source?: RandomSource): string {
  const n = clampLength(length)
  if (pool.length === 0) return ''
  let out = ''
  for (let i = 0; i < n; i += 1) out += pool[randomInt(pool.length, source)]
  return out
}

/**
 * 熵 = 长度 × log2(字符集大小)，单位 bit。
 *
 * ⚠️ 调用方**必须传入用于生成的那个长度**（即 `clampLength` 之后的值）。
 * 原实现显示熵时用未夹取的 `length`、生成时用 `Math.max(4, Math.min(128, length))`，
 * 一旦长度越界，**显示出来的熵就与实际密码不符**（会虚高）。
 */
export function entropyBits(length: number, poolSize: number): number {
  if (poolSize <= 1) return 0
  return Math.round(clampLength(length) * Math.log2(poolSize))
}

/** 强度文案（阈值与界面一致） */
export function strengthOf(bits: number): { label: string; tone: 'ok' | 'warn' | 'danger' } {
  if (bits >= 128) return { label: '很强', tone: 'ok' }
  if (bits >= 90) return { label: '强', tone: 'ok' }
  if (bits >= 60) return { label: '中等', tone: 'warn' }
  return { label: '偏弱', tone: 'danger' }
}
