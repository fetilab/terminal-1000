// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 主密码闸门。
 *
 * 为什么做成"按需弹窗"而不是"置灰 + 一句提示"：
 * 置灰只会把人挡在门外——用户看到的是"这个按钮不能点"，而不是"我需要先设个主密码"。
 * 所有需要密钥的操作（导入 OpenSSH、保存带口令的连接、同步…）都先过 `ensureUnlocked()`：
 * 已解锁就直接过；没解锁就**就地弹窗**引导，而不是让功能静默不可用。
 *
 * 这里用"注册回调"的方式把 UI 和调用方解耦：调用方只 `await ensureUnlocked()`，
 * 由挂在应用根部的 `<VaultGate/>` 负责真正渲染对话框。
 */

import type { IpcDomain } from '@t1000/shared'
import { invoke } from './ipc'

export interface VaultState {
  unlocked: boolean
  initialized: boolean
}

type PromptHandler = (state: VaultState, reason?: string) => Promise<boolean>

let promptHandler: PromptHandler | null = null

/** 由 `<VaultGate/>` 在挂载时注册 */
export function registerVaultPrompt(fn: PromptHandler | null): void {
  promptHandler = fn
}

/** 读当前主密码状态；查询失败时按"不拦路"处理，避免因探测失败把功能锁死 */
export async function getVaultState(): Promise<VaultState> {
  try {
    return await invoke<'store', 'isUnlocked', Record<string, never>, VaultState>(
      'store',
      'isUnlocked',
      {},
    )
  } catch {
    return { unlocked: true, initialized: true }
  }
}

/**
 * 需要密钥的操作前调用。
 * 返回 true = 可以继续；false = 用户取消或没有可用的提示 UI（此时调用方应当中止操作，
 * **绝不能**当作"没解锁也能继续"——否则就是私钥被静默丢弃那个 bug）。
 */
export async function ensureUnlocked(reason?: string): Promise<boolean> {
  const state = await getVaultState()
  if (state.unlocked) return true
  if (!promptHandler) return false
  return promptHandler(state, reason)
}

/** 设置主密码（首次创建）。至少 8 位由主进程校验。 */
export async function setMasterPassword(
  newPassword: string,
  oldPassword?: string,
): Promise<{ reencrypted: number; created: boolean }> {
  return invoke<'store', 'setMasterPassword', Record<string, unknown>, { reencrypted: number; created: boolean }>(
    'store',
    'setMasterPassword',
    oldPassword === undefined ? { newPassword } : { newPassword, oldPassword },
  )
}

export async function unlockVault(password: string): Promise<unknown> {
  return invoke<'store', 'unlock', { password: string }, unknown>('store', 'unlock', { password })
}

export async function lockVault(): Promise<unknown> {
  // lock 的 domain 可能是 store；如果主进程没提供就由调用方兜底提示
  return invoke('store' as IpcDomain, 'lock', {}) as Promise<unknown>
}
