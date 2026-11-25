// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * Android 侧的运行环境描述。
 *
 * 全部由 Kotlin 壳通过环境变量注入（见 NodeService.kt）。集中在这里读一次，
 * 避免各处 process.env 散落 —— Android 上没有 Electron 的 app.getPath()，
 * 路径是唯一需要"外部告知"的东西。
 */

const env = process.env

function required(name: string): string {
  const v = env[name]
  if (!v) {
    // 缺关键环境说明不是被 Kotlin 壳拉起的。给一条能直接定位的报错，
    // 而不是让它退化成"数据写到奇怪的地方"。
    throw new Error(`缺少必需环境变量 ${name}：node host 必须由 Android 壳进程启动`)
  }
  return v
}

/** 应用私有根目录：`/data/data/<pkg>/files`（Kotlin 侧 filesDir） */
export const HOME_DIR = required('T1000_HOME')

/** 用户数据目录（库、设置、备份都在这里），默认 `<home>/terminal-1000` */
export const USER_DATA_DIR = env['T1000_USERDATA'] ?? `${HOME_DIR}/terminal-1000`

/**
 * 只读资源目录：APK assets 解出来的那份（wasm、内置背景脚本、图标）。
 *
 * 与 userData 分开是刻意的：资源随版本走、可被覆盖安装整体替换；
 * 用户数据必须跨升级保留。
 */
export const RESOURCES_DIR = env['T1000_RESOURCES'] ?? `${HOME_DIR}/resources`

/** 原生库目录（jniLibs 解压位置）：可执行文件与 .node 模块都在这里 */
export const NATIVE_LIB_DIR = env['T1000_NATIVE_LIB_DIR'] ?? ''

/** 回环桥监听端口（0 表示由系统分配，实际端口通过 T1000_PORT 传入） */
export const BRIDGE_PORT = Number(env['T1000_PORT'] ?? '0')

/** 桥的访问令牌：WebView 与 Kotlin 都必须带上，防止同机其它 App 连进来 */
export const BRIDGE_TOKEN = required('T1000_TOKEN')

export const APP_VERSION = env['T1000_VERSION'] ?? '0.0.0'

/** 是否处于自动化验收模式（等同于桌面端的 --t1000-testhook） */
export const TEST_HOOK = env['T1000_TEST_HOOK'] === '1'

/** 日志级别透传（默认 info） */
export const LOG_LEVEL = env['T1000_LOG_LEVEL'] ?? 'info'
