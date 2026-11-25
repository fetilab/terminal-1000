// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * `app` 模块的 Android 实现。
 *
 * 关键差异（与 Electron 对比）：
 * - **没有安装目录/资源包的概念**：`getAppPath()` 返回只读资源目录（APK assets
 *   解出的那份），`process.resourcesPath` 也指向同一处 —— 主进程用它找
 *   kitty wasm 与内置背景脚本，这条链路必须通。
 * - **路径全部由 Kotlin 注入**：Android 的私有目录不能靠猜。
 * - **退出语义**：`quit()` 会先走一遍 `before-quit`（主进程在这里做资源清理，
 *   会 preventDefault 然后异步清理完再调一次），清理完才真正通知原生退出。
 */

import { dirname, join } from 'node:path'
import { APP_VERSION, HOME_DIR, RESOURCES_DIR, USER_DATA_DIR, TEST_HOOK } from '../env'
import { Emitter } from './emitter'
import { native } from './native'

export type PathKey =
  | 'userData'
  | 'appData'
  | 'home'
  | 'exe'
  | 'temp'
  | 'logs'
  | 'sessionData'

class AppShim extends Emitter {
  private paths = new Map<PathKey, string>()
  private readyResolve: (() => void) | null = null
  private readyPromise: Promise<void>
  private quitting = false
  private hardwareAccelerationDisabled = false

  readonly name = 'terminal-1000'
  readonly isPackaged = true

  constructor() {
    super()
    this.readyPromise = new Promise<void>((resolve) => {
      this.readyResolve = resolve
    })

    this.paths.set('userData', USER_DATA_DIR)
    // appData 是"系统配置根"，我们需要它是 userData 的父级，
    // 这样主进程的 resolveDataDir() 算出来正好等于 USER_DATA_DIR
    this.paths.set('appData', HOME_DIR)
    this.paths.set('home', HOME_DIR)
    this.paths.set('exe', process.execPath)
    this.paths.set('temp', process.env['T1000_TEMP'] ?? join(HOME_DIR, 'tmp'))
    this.paths.set('logs', join(USER_DATA_DIR, 'logs'))
    this.paths.set('sessionData', USER_DATA_DIR)
  }

  /** 由 entry.ts 在 WS 服务就绪后调用 */
  markReady(): void {
    this.readyResolve?.()
    this.readyResolve = null
  }

  whenReady(): Promise<void> {
    return this.readyPromise
  }

  getPath(key: PathKey | string): string {
    const v = this.paths.get(key as PathKey)
    if (v) return v
    // 未知 key：回退到 home，绝不返回空串（空串 join 后会变成相对路径，
    // 数据会落到 cwd —— 那是"配置丢失"类故障的经典成因）
    console.warn(`[app] getPath('${String(key)}') 未知，回退到 home`)
    return HOME_DIR
  }

  setPath(key: PathKey | string, value: string): void {
    this.paths.set(key as PathKey, value)
  }

  getName(): string {
    return this.name
  }

  getVersion(): string {
    return APP_VERSION
  }

  getAppPath(): string {
    // 主进程用它找 vendor/kitty-vt-wasm 与 resources/background-scripts
    return RESOURCES_DIR
  }

  getLocale(): string {
    return process.env['T1000_LOCALE'] ?? 'zh-CN'
  }

  getSystemLocale(): string {
    return this.getLocale()
  }

  isReady(): boolean {
    return this.readyResolve === null
  }

  /** 单实例锁：Android 上一个 App 本来就只有一份进程，恒为 true */
  requestSingleInstanceLock(): boolean {
    return true
  }

  releaseSingleInstanceLock(): void {
    /* 无操作 */
  }

  disableHardwareAcceleration(): void {
    // WebView 的硬件加速由 Kotlin 侧控制；这里只记录，避免主进程以为设置了却没人理
    this.hardwareAccelerationDisabled = true
    console.log('[app] disableHardwareAcceleration 已记录（实际由 WebView 决定）')
  }

  isHardwareAccelerationDisabled(): boolean {
    return this.hardwareAccelerationDisabled
  }

  setLoginItemSettings(): void {
    // Android 没有"开机自启"这个概念（由系统与用户设置决定），静默忽略
  }

  getLoginItemSettings(): { openAtLogin: boolean } {
    return { openAtLogin: false }
  }

  setBadgeCount(): boolean {
    return false
  }

  setAppUserModelId(): void {
    /* Windows 专有 */
  }

  showAboutPanel(): void {
    /* 无原生关于面板 */
  }

  focus(): void {
    void native.call('window.focus', {}, null).catch(() => undefined)
  }

  hide(): void {
    void native.call('window.hide', {}, null).catch(() => undefined)
  }

  /**
   * 退出。会先发 `before-quit`（主进程在这里异步清理并可能拦截），
   * 未被拦截时通知原生结束进程。
   */
  quit(): void {
    if (this.quitting) return
    const event = {
      prevented: false,
      preventDefault(): void {
        event.prevented = true
      },
    }
    this.emit('before-quit', event)
    if (event.prevented) {
      console.log('[app] before-quit 被拦截：等待清理完成后再次调用 quit()')
      return
    }
    this.exit(0)
  }

  exit(code = 0): void {
    this.quitting = true
    this.emit('will-quit')
    void native.call('app.exit', { code }, null).catch(() => undefined)
    // 兜底：原生侧没响应（或本机调试没接壳）时也必须退出，
    // 否则清理完成后进程会挂在那里，用户看到"关不掉"
    setTimeout(() => {
      process.exit(code)
    }, 300).unref?.()
  }

  relaunch(): void {
    void native.call('app.relaunch', {}, null).catch(() => undefined)
  }

  /** 测试钩子标记（对齐桌面端 --t1000-testhook） */
  get testHook(): boolean {
    return TEST_HOOK
  }

  /** 诊断信息：原生侧打印用 */
  describe(): Record<string, unknown> {
    return {
      home: HOME_DIR,
      userData: this.getPath('userData'),
      resources: RESOURCES_DIR,
      execPath: process.execPath,
      node: process.versions.node,
      platform: process.platform,
      arch: process.arch,
      appPathDirname: dirname(this.getAppPath()),
    }
  }
}

export const app = new AppShim()
