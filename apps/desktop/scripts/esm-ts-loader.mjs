// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 极小的 ESM 解析钩子：给**相对导入**补扩展名。
 *
 * 为什么需要：仓库里的 TS 源文件走 vite/vitest 的解析规则，允许 `./vnc/rfb`
 * 这种省略扩展名的写法；而用 `node` 直接跑（脚本类验收工具）时 ESM 解析器
 * 要求写全扩展名，否则 ERR_MODULE_NOT_FOUND。
 *
 * 只影响"相对路径 + 无扩展名"的情况，包导入与已带扩展名的路径原样放行，
 * 因此不会掩盖真正的路径错误（补全失败会把原始错误抛出去）。
 */

const CANDIDATES = ['.ts', '.tsx', '.mts', '.js', '.mjs', '/index.ts', '/index.js']

export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context)
  } catch (err) {
    const relative = specifier.startsWith('./') || specifier.startsWith('../')
    const hasExt = /\.[cm]?[jt]sx?$/i.test(specifier)
    if (!relative || hasExt) throw err
    for (const suffix of CANDIDATES) {
      try {
        return await nextResolve(specifier + suffix, context)
      } catch {
        /* 试下一个后缀 */
      }
    }
    throw err
  }
}
