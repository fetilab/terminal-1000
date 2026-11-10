// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * system 域：操作系统层面的应用行为。
 *
 * 覆盖 spec §20 的 P1「系统配置」与「安全」两类：
 * - **硬件加速**（必须在 ready 之前应用，运行期改动只能等重启）
 * - **开机自启**
 * - **自动锁屏**（空闲计时 → 锁定本地库）
 * - **每日自动备份 + 保留 N 天**
 *
 * 为什么单独一个域而不是塞进 app 域：这些是**宿主行为**（登录项/GPU/空闲计时/定时任务），
 * 与 IPC 应用域（窗口、路径、外部打开）职责不同，混在一起会让两边都难读。
 */

import { app, powerMonitor } from 'electron'
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { Events } from '@t1000/shared'
import { createLogger } from '../../logger'
import { getSettings } from '../settings'
import { getStoreService } from '../store'
import { BACKUP_EXTENSION } from '../store/backup'
import { parseInput } from '../../errors'
import type { IpcContext, IpcHandler } from '../../ipc/router'

const log = createLogger('system')

/**
 * 备份文件的识别方式：**只按扩展名判定**，且扩展名取自 store 的单一事实来源。
 *
 * ⚠️ 我第一版自己编了个 `t1000-backup-` 前缀，而 store 实际产出的文件名是
 * `20261110173938.v1.backup.t1000.enc` —— 前缀根本对不上，后果是
 * **备份列表永远为空、保留策略永远不清理**（两处都静默失效，界面看不出问题）。
 * 这类"自己发明命名约定而不去读对方的常量"的错误，只能靠**真实运行**抓出来。
 */
const BACKUP_SUFFIX = BACKUP_EXTENSION

/**
 * 备份文件名必须**完全匹配** store 的生成格式：`<14 位时间戳>.v<版本><扩展名>`。
 *
 * 为什么不用"只判扩展名"：那样一个恰好后缀同名的用户文件会被当成备份并被清理。
 * 也不自己发明前缀（我第一版编的 `t1000-backup-` 与真实名对不上，导致
 * 列表恒空、保留策略恒不生效）。**从对方常量与真实产物反推格式**，才两者都稳。
 */
export const BACKUP_NAME_PATTERN = /^\d{14}\.v\d+\.backup\.t1000\.enc$/

/** 判定某个文件名是否是本应用生成的备份 */
export function isBackupFileName(name: string): boolean {
  return name.endsWith(BACKUP_SUFFIX) && BACKUP_NAME_PATTERN.test(name)
}

/** 空闲检查间隔：15 秒足够精确，又不至于频繁唤醒 CPU */
const IDLE_POLL_MS = 15_000

// ── 1. 硬件加速（必须在 ready 之前）────────────────────

/**
 * 在应用 ready **之前**应用那些"只能早设"的开关。
 *
 * `app.disableHardwareAcceleration()` 只在 ready 前生效；放到 ready 之后再调是空操作，
 * 用户会以为设置没生效。所以这个函数要在 `bootstrap()` 之前调用。
 *
 * 读设置需要访问本地库；这一步在 ready 前也能跑（`app.getPath('userData')` 此时可用）。
 * 但如果**读失败**（例如库被锁、路径异常），必须**放行默认值**而不是让应用起不来 ——
 * 一个显示设置不该阻止启动。
 */
export function applyEarlySettings(): void {
  let hardwareAcceleration = true
  try {
    hardwareAcceleration = getSettings().app?.hardwareAcceleration ?? true
  } catch (err) {
    log.warn('读取硬件加速设置失败，按默认（开启）处理', err)
  }

  if (!hardwareAcceleration) {
    try {
      app.disableHardwareAcceleration()
      log.info('已禁用硬件加速（该设置需重启生效）')
    } catch (err) {
      log.warn('禁用硬件加速失败', err)
    }
  }
}

// ── 2. 运行期系统设置 ─────────────────────────────────

/** 应用"ready 之后才能改"的系统设置（开机自启）。幂等。 */
export function applyRuntimeSettings(): void {
  try {
    const openAtLogin = getSettings().app?.openAtLogin ?? false
    // 注意：Linux 下该 API 依赖桌面环境的 autostart 机制，失败不应影响应用
    app.setLoginItemSettings({ openAtLogin })
  } catch (err) {
    log.warn('应用开机自启设置失败（不影响使用）', err)
  }
}

// ── 3. 自动锁屏 ───────────────────────────────────────

let idleTimer: NodeJS.Timeout | null = null
let lastNotifiedLock = false

/**
 * 启动空闲自动锁屏。
 *
 * 用 `powerMonitor.getSystemIdleTime()`（**系统级**空闲秒数）而不是自己在渲染层数事件：
 * 后者在窗口失焦/最小化时就不准了，而"人离开电脑"恰恰就发生在那种时刻。
 */
export function startAutoLock(ctx: IpcContext): void {
  stopAutoLock()

  idleTimer = setInterval(() => {
    try {
      const minutes = getSettings().security?.autoLockMinutes ?? 0
      if (minutes <= 0) return

      const store = getStoreService()
      // 未解锁时无所谓"再锁一次"
      if (!store.isUnlocked()) return

      const idleSeconds = powerMonitor.getSystemIdleTime()
      if (idleSeconds < minutes * 60) return

      store.lock()
      if (!lastNotifiedLock) {
        lastNotifiedLock = true
        log.info(`空闲 ${idleSeconds}s 达到阈值 ${minutes} 分钟，已锁定本地库`)
        ctx.emit(Events.SECURITY_LOCKED, { reason: 'idle', idleSeconds })
      }
    } catch (err) {
      // 定时任务里的异常不该把计时器打掉
      log.warn('自动锁屏检查失败', err)
    }
  }, IDLE_POLL_MS)

  // 计时器不该阻止进程退出
  idleTimer.unref?.()
}

export function stopAutoLock(): void {
  if (idleTimer) clearInterval(idleTimer)
  idleTimer = null
}

/** 手动锁定（设置里的「立即锁定」走这条，以便与自动锁屏共用事件） */
export function lockNow(ctx: IpcContext, reason: 'idle' | 'manual' = 'manual'): void {
  const store = getStoreService()
  const wasUnlocked = store.isUnlocked()
  store.lock()
  lastNotifiedLock = false
  if (wasUnlocked) ctx.emit(Events.SECURITY_LOCKED, { reason })
}

/** 解锁后清掉"已通知"标记，使下一次空闲能再次触发 */
export function onUnlocked(ctx: IpcContext): void {
  lastNotifiedLock = false
  ctx.emit(Events.SECURITY_UNLOCKED, {})
}

// ── 4. 每日自动备份 + 保留 N 天 ───────────────────────

/**
 * 执行一次备份，并按保留天数清理旧文件。
 *
 * 设计取舍：**不做"每天固定时刻"的调度器**，而是在启动后延迟执行一次，
 * 之后每 24 小时一次。理由：桌面应用经常不是常驻的，固定时刻可能永远等不到；
 * 而"距上次备份超过 24 小时就备一次"在任何使用节奏下都能覆盖到。
 */
export function runBackup(ctx: IpcContext, backupDir: string): void {
  void (async () => {
    try {
      const settings = getSettings()
      if (settings.app?.dailyBackup === false) return

      const store = getStoreService()
      // 未解锁时**无法**导出可跨设备还原的备份（敏感字段需要主密钥解密后再重加密），
      // 这时明确跳过而不是写出一个字段解不开的备份。
      if (!store.isUnlocked()) {
        log.info('本地库未解锁，跳过本次自动备份')
        return
      }

      if (!existsSync(backupDir)) mkdirSync(backupDir, { recursive: true })

      const result = store.exportBackupToFile({ backupDir })
      const pruned = pruneBackups(backupDir, settings.security?.backupRetentionDays ?? 7)

      log.info(`自动备份完成：${result.fileName}（${Math.round(result.bytes / 1024)}KB），清理旧备份 ${pruned} 个`)
      ctx.emit(Events.BACKUP_RESULT, {
        ok: true,
        filePath: result.filePath,
        bytes: result.bytes,
        pruned,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log.warn('自动备份失败', err)
      // 失败**必须让用户知道**：备份是数据安全项，静默失败等于没有备份
      ctx.emit(Events.BACKUP_RESULT, { ok: false, message })
    }
  })()
}

/**
 * 按保留天数清理旧备份。
 *
 * 只删**自己生成的**文件（前缀 + 后缀匹配），绝不动目录里的其它东西 ——
 * 备份目录可能被用户塞了别的文件，误删是灾难性的。
 *
 * @returns 删除数量
 */
export function pruneBackups(backupDir: string, retentionDays: number): number {
  if (!existsSync(backupDir)) return 0
  const cutoff = Date.now() - Math.max(1, retentionDays) * 24 * 60 * 60 * 1000

  let pruned = 0
  for (const name of readdirSync(backupDir)) {
    if (!isBackupFileName(name)) continue
    const full = join(backupDir, name)
    try {
      const stat = statSync(full)
      if (!stat.isFile()) continue
      if (stat.mtimeMs < cutoff) {
        unlinkSync(full)
        pruned += 1
      }
    } catch (err) {
      log.warn(`清理旧备份失败: ${name}`, err)
    }
  }
  return pruned
}

/**
 * 判断"是否该备份了"。
 *
 * **不看内存里的时间戳，而看磁盘上最新备份的 mtime** —— 这样它是**自描述**的：
 * 重启应用、换进程、甚至用户手动删过备份，判断都仍然正确，不需要额外持久化状态。
 *
 * @returns 该备份时返回 true
 */
export function isBackupDue(backupDir: string, intervalMs = 24 * 60 * 60 * 1000): boolean {
  if (!existsSync(backupDir)) return true
  let newest = 0
  for (const name of readdirSync(backupDir)) {
    if (!isBackupFileName(name)) continue
    try {
      const s = statSync(join(backupDir, name))
      if (s.isFile() && s.mtimeMs > newest) newest = s.mtimeMs
    } catch {
      /* 读不到就跳过这个文件 */
    }
  }
  if (newest === 0) return true
  return Date.now() - newest >= intervalMs
}

/**
 * 启动每日备份调度。
 *
 * ⚠️ 这里刻意**不用"启动后延迟一次 + 每 24 小时一次"** 的写法 ——
 * 那样会在一个很常见的情形下彻底失效：**首次触发时本地库还没解锁**
 * （用户还没输主密码），于是被跳过，下一次要再等 24 小时。
 * 我第一版就是那么写的，被整机验收抓出来：日志里连续出现"未解锁，跳过本次自动备份"，
 * 备份目录始终是空的 —— 也就是**每日备份在常见使用下根本不会执行**。
 *
 * 改成**周期检查是否到期**：每 10 分钟看一次"最新备份是否已超过 24 小时"，
 * 且只在本地库已解锁时执行。这样无论用户何时解锁，都能在 10 分钟内补上，
 * 且不会因为反复检查而重复备份（到期判断基于磁盘状态）。
 */
export function startDailyBackup(ctx: IpcContext, backupDir: string): NodeJS.Timeout {
  const CHECK_MS = 10 * 60 * 1000
  const timer = setInterval(() => {
    try {
      const settings = getSettings()
      if (settings.app?.dailyBackup === false) return
      const days = Math.max(1, settings.security?.backupRetentionDays ?? 7)
      // 到期判断按 24 小时；保留策略单独按用户配置的天数
      if (!isBackupDue(backupDir)) return
      if (!getStoreService().isUnlocked()) return // 未解锁：本次不备，下个周期再试
      runBackup(ctx, backupDir)
    } catch (err) {
      log.warn('备份到期检查失败', err)
    }
  }, CHECK_MS)
  timer.unref?.()

  // 启动时若"确实到期"且已解锁，也先试一次（覆盖"上次备份已超过 24 小时"的场景）；
  // 未解锁则交给上面的周期检查，不会被吞掉。
  const first = setTimeout(() => {
    try {
      const settings = getSettings()
      if (settings.app?.dailyBackup === false) return
      if (!isBackupDue(backupDir)) return
      if (!getStoreService().isUnlocked()) {
        log.info('本地库尚未解锁，本次跳过；将在解锁后的下一个检查周期补做')
        return
      }
      runBackup(ctx, backupDir)
    } catch (err) {
      log.warn('启动备份检查失败', err)
    }
  }, 30_000)
  first.unref?.()

  return timer
}

/** 应用退出时清理计时器 */
export function shutdownSystem(): void {
  stopAutoLock()
}

// ── IPC ─────────────────────────────────────────────

const emptySchema = z.object({})

export const systemHandlers: Record<string, IpcHandler> = {
  lockNow: (_payload, ctx) => {
    lockNow(ctx, 'manual')
    return { locked: true }
  },

  backupNow: (payload, ctx) => {
    const { dir } = parseInput(z.object({ dir: z.string().min(1) }), payload)
    runBackup(ctx, dir)
    return { started: true }
  },

  /** 列出已有备份（按时间倒序），供恢复界面展示 */
  listBackups: (payload) => {
    const { dir } = parseInput(z.object({ dir: z.string().min(1) }), payload)
    if (!existsSync(dir)) return { backups: [] }
    const backups = readdirSync(dir)
      .filter((n) => isBackupFileName(n))
      .map((name) => {
        const full = join(dir, name)
        let size = 0
        let mtimeMs = 0
        try {
          const s = statSync(full)
          size = s.size
          mtimeMs = s.mtimeMs
        } catch {
          /* 读不到就留 0，仍列出以便用户看到异常文件 */
        }
        return { name, path: full, size, mtimeMs }
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
    return { backups }
  },

  applyRuntime: () => {
    applyRuntimeSettings()
    return { applied: true }
  },
}
