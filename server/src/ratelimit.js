// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 限流与失败锁定。
 *
 * 为什么必须有：一旦服务暴露到公网，`/login` 就是**最低成本的暴力破解入口** ——
 * scrypt 虽然让每次尝试变慢（约 30-50ms），但攻击者可以并发打，
 * 且大量尝试本身就是一种资源消耗（把我们 CPU 打满 = 拒绝服务）。
 *
 * 两层防护：
 * 1. **滑动窗口限流**：按 key（IP / IP+账号）限制单位时间内的请求数
 * 2. **失败锁定 + 指数退避**：连续失败后锁定该 key 一段时间，且逐次加长
 *
 * 设计取舍：
 * - 内存态（进程内）。后端是单实例、数据量小，够用；重启后计数清零是可接受的
 * - **不区分"账号不存在"与"口令错"**（accounts 那边已保证），这里也不能通过
 *   锁定行为泄露账号是否存在 —— 所以锁定 key 同时看 IP 与 IP+账号，
 *   但对不存在的账号也照常计数
 * - 定期清理过期条目，避免内存无限增长（攻击者可用海量 IP 打）
 */

/**
 * 配置（可用环境变量覆盖）。
 * 之所以做成可配置：自动化测试会从同一 IP 连发大量认证请求，
 * 若不调高就会把自己的测试锁死 —— 但**默认值必须保持严格**。
 */
function envInt(name, fallback) {
  const raw = process.env[name]
  const n = raw ? Number(raw) : NaN
  return Number.isInteger(n) && n > 0 ? n : fallback
}

/** 滑动窗口配置 */
const WINDOW_MS = envInt('T1000_RATE_WINDOW_MS', 60_000)
const MAX_ATTEMPTS_PER_WINDOW = envInt('T1000_RATE_MAX_ATTEMPTS', 10)

/** 锁定配置：连续失败达阈值后锁定，且每次再犯翻倍（上限 60 分钟） */
const LOCK_THRESHOLD = envInt('T1000_LOCK_THRESHOLD', 5)
const BASE_LOCK_MS = envInt('T1000_LOCK_BASE_MS', 60_000)
const MAX_LOCK_MS = envInt('T1000_LOCK_MAX_MS', 60 * 60_000)

/** 单条记录 */
class Bucket {
  constructor(now) {
    /** 窗口内的尝试时间戳（毫秒） */
    this.attempts = []
    /** 连续失败次数 */
    this.failures = 0
    /** 锁定到期时间 */
    this.lockedUntil = 0
    /** 上次访问，用于清理 */
    this.touchedAt = now
  }
}

const buckets = new Map()

function bucketFor(key, now) {
  let b = buckets.get(key)
  if (!b) {
    b = new Bucket(now)
    buckets.set(key, b)
  }
  b.touchedAt = now
  return b
}

/**
 * 惰性清理：条目闲置超过"窗口与最长锁定中的较大者"且当前未锁定时移除。
 *
 * 注意比较的是**两个时长**（空闲时长 vs 阈值），不是"空闲时长 vs 时间戳" ——
 * 后者只在大时间戳下碰巧成立，用假时钟测试时会立刻暴露（桶被误删 → 限流失效）。
 */
function sweep(now) {
  const maxIdle = Math.max(WINDOW_MS, MAX_LOCK_MS)
  for (const [key, b] of buckets) {
    const idle = now - b.touchedAt
    const unlocked = b.lockedUntil <= now
    if (idle > maxIdle && unlocked) buckets.delete(key)
  }
}

let lastSweep = 0
function maybeSweep(now) {
  // 每 60 秒清一次，避免每次请求都遍历
  if (now - lastSweep > 60_000) {
    lastSweep = now
    sweep(now)
  }
}

/**
 * 检查某 key 现在是否允许尝试。
 * @returns {{ allowed: boolean, retryAfterSec?: number, reason?: string }}
 */
export function checkAllowed(key, now = Date.now()) {
  maybeSweep(now)
  const b = buckets.get(key)
  if (!b) return { allowed: true }

  if (b.lockedUntil > now) {
    return {
      allowed: false,
      retryAfterSec: Math.ceil((b.lockedUntil - now) / 1000),
      reason: 'locked',
    }
  }

  // 滑动窗口：只保留窗口内的尝试
  b.attempts = b.attempts.filter((t) => now - t < WINDOW_MS)
  if (b.attempts.length >= MAX_ATTEMPTS_PER_WINDOW) {
    const oldest = b.attempts[0]
    return {
      allowed: false,
      retryAfterSec: Math.max(1, Math.ceil((WINDOW_MS - (now - oldest)) / 1000)),
      reason: 'rate_limited',
    }
  }

  return { allowed: true }
}

/**
 * 记录一次尝试。
 * @param success 成功则清空失败计数（但不影响滑动窗口，防止"打对了就无限试探"）
 */
export function recordAttempt(key, success, now = Date.now()) {
  const b = bucketFor(key, now)
  b.attempts.push(now)
  // 窗口内的尝试也不该无限增长
  if (b.attempts.length > MAX_ATTEMPTS_PER_WINDOW * 4) {
    b.attempts = b.attempts.slice(-MAX_ATTEMPTS_PER_WINDOW * 4)
  }

  if (success) {
    b.failures = 0
    // **不解除已有锁定**：若成功即解锁，攻击者只要在锁定期内猜中一次就能绕过限流，
    // 而这恰恰是暴力破解的目标。锁定必须走完它的时长。
    // （正常情况下 locked 的 key 在 enforceRateLimit 阶段就被拦住，根本到不了 handler，
    //   这里只是保证语义在任何调用顺序下都安全。）
    return { locked: b.lockedUntil > now }
  }

  b.failures += 1
  if (b.failures >= LOCK_THRESHOLD) {
    // 指数退避：第 5 次失败锁 1 分钟，第 6 次 2 分钟……上限 1 小时
    const over = b.failures - LOCK_THRESHOLD
    const lockMs = Math.min(BASE_LOCK_MS * 2 ** over, MAX_LOCK_MS)
    b.lockedUntil = now + lockMs
    return { locked: true, retryAfterSec: Math.ceil(lockMs / 1000), failures: b.failures }
  }

  return { locked: false, remaining: LOCK_THRESHOLD - b.failures }
}

/** 测试用：清空所有计数 */
export function _resetForTests() {
  buckets.clear()
  lastSweep = 0
}

export const _internals = { WINDOW_MS, MAX_ATTEMPTS_PER_WINDOW, LOCK_THRESHOLD, BASE_LOCK_MS, MAX_LOCK_MS }
