#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
//
// 自检：**有没有产品源码被 .gitignore 静默排除**。
//
// 为什么需要它：`git status` **看不见被 ignore 的文件**，所以一个过宽的忽略模式
// 会让整块源码"看起来正常提交了、实际从来没进过版本控制" —— 而它不报任何错。
// 实测踩过：`.gitignore` 里的裸模式 `notes/` 匹配**任意层级**的 notes 目录，
// 于是 `services/notes/`（后端）与 `features/notes/`（整个笔记 UI）**从未进过 git**。
// 那和"文件被删"的暴露面一样大，却完全看不见。
//
// 判据：把"被忽略的文件"按路径过滤到产品源码目录（apps/ packages/ server/），
// 排除构建产物与依赖目录后**必须为空**。
//
// 用法：node scripts/check-ignored-source.mjs   （退出码非 0 = 有源码被忽略）

import { execFileSync } from 'node:child_process'

/** 产品源码所在的顶层目录 */
const SOURCE_ROOTS = ['apps/', 'packages/', 'server/', 'scripts/']
/** 本来就该忽略的（依赖、构建产物、打包输出） */
const ALLOWED = [
  /node_modules\//,
  /\/out\//,
  /\/dist\//,
  /\/release\//,
  /\/\.vite/,
  /\/coverage\//,
  /\.tsbuildinfo$/,
]

let raw = ''
try {
  raw = execFileSync('git', ['ls-files', '--others', '--ignored', '--exclude-standard'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
} catch (err) {
  console.error('无法执行 git ls-files：', err instanceof Error ? err.message : err)
  process.exit(2)
}

const offenders = raw
  .split('\n')
  .map((l) => l.trim())
  .filter((l) => l !== '')
  .filter((l) => SOURCE_ROOTS.some((r) => l.startsWith(r)))
  .filter((l) => !ALLOWED.some((re) => re.test(l)))

if (offenders.length === 0) {
  console.log('✅ 没有产品源码被 .gitignore 排除')
  process.exit(0)
}

console.error(`❌ 有 ${offenders.length} 个产品源码文件被 .gitignore 排除（它们不在版本控制里）：`)
for (const f of offenders.slice(0, 40)) {
  let why = ''
  try {
    why = execFileSync('git', ['check-ignore', '-v', f], { encoding: 'utf8' }).trim()
  } catch {
    /* 取不到原因也无妨 */
  }
  console.error(`   ${f}${why ? `\n      ← ${why}` : ''}`)
}
if (offenders.length > 40) console.error(`   …还有 ${offenders.length - 40} 个`)
console.error('\n修法：把过宽的忽略模式锚定到仓库根（如 `notes/` → `/notes/`），或删掉它。')
process.exit(1)
