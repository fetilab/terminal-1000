// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 防回归：**设置面板不能说谎**。
 *
 * 背景：settingsFields 曾声明 49 个设置项，其中 14 项零消费者 ——
 * 用户拨了开关什么都不发生。这类问题靠人记不住（漏 14 项就是这么来的），
 * 所以固化成测试：
 *
 * 1. settingsFields 里出现的每个路径，必须要么在 `SETTINGS_CONSUMERS`（有消费点），
 *    要么在 `PENDING_CONSUMERS`（显式白名单 + 原因）。→ 新增设置漏接线直接红。
 * 2. 白名单里的键必须**仍然存在**于 settingsFields（防止补完接线后忘记挪走、
 *    或删了设置项却留下死白名单）。
 * 3. 两个清单不得重叠（一个项不能既"已消费"又"待消费"）。
 * 4. 源码扫描：除 settings 自身目录外，字段名至少被引用一次 ——
 *    这条是启发式的（名字相同不等于真的读了设置），但能抓到手滑写错路径名的情形；
 *    真正的保障是第 1 条。
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { PENDING_CONSUMERS, SETTINGS_CONSUMERS } from './settingsConsumers'

const HERE = dirname(fileURLToPath(import.meta.url))
/** apps/desktop/src —— settings → features → src → renderer → src → apps/desktop/src 共 5 级 */
const SRC_ROOT = resolve(HERE, '../../../../')
/** 仓库根的 packages/shared/src —— 再上两级到仓库根 */
const SHARED_ROOT = resolve(HERE, '../../../../../../../packages/shared/src')

/** 从 settingsFields.ts 文本里抽出全部声明路径（避免为测试引入运行时依赖） */
function declaredPaths(): string[] {
  const text = readFileSync(join(HERE, 'settingsFields.ts'), 'utf8')
  return [...text.matchAll(/path:\s*'([^']+)'/g)].map((m) => m[1] ?? '').filter(Boolean)
}

/** 收集某目录下所有 ts/tsx 文件（跳过 node_modules） */
function collectSources(dir: string, acc: string[] = []): string[] {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    // packages/shared 在只跑 desktop 包时可能不在预期相对位置：跳过而不是让测试崩
    return acc
  }
  for (const name of entries) {
    if (name === 'node_modules' || name === 'dist' || name === 'out') continue
    const full = join(dir, name)
    let st: ReturnType<typeof statSync>
    try {
      st = statSync(full)
    } catch {
      continue
    }
    if (st.isDirectory()) collectSources(full, acc)
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) acc.push(full)
  }
  return acc
}

describe('设置项必须有消费者', () => {
  const paths = declaredPaths()

  it('至少声明了设置项（防御：解析逻辑坏掉时不要静默通过）', () => {
    expect(paths.length).toBeGreaterThan(20)
  })

  it('每个设置路径都在「已消费」或「待消费白名单」里', () => {
    const uncovered = paths.filter(
      (p) => !(p in SETTINGS_CONSUMERS) && !(p in PENDING_CONSUMERS),
    )
    // 失败信息要直接可抄：告诉作者该做哪件事
    expect(
      uncovered,
      `以下设置项没有任何消费者登记。要么补上消费点并写进 SETTINGS_CONSUMERS，` +
        `要么写进 PENDING_CONSUMERS 说明原因（更推荐直接从面板移除）：\n  ${uncovered.join('\n  ')}`,
    ).toEqual([])
  })

  it('白名单里的项必须仍然真的存在（防止补完接线忘记挪走 / 删了设置留死白名单）', () => {
    const declared = new Set(paths)
    const stale = Object.keys(PENDING_CONSUMERS).filter((p) => !declared.has(p))
    expect(
      stale,
      `PENDING_CONSUMERS 里有已不存在的设置项，请删除这些条目：\n  ${stale.join('\n  ')}`,
    ).toEqual([])
  })

  it('两个清单不得重叠', () => {
    const overlap = Object.keys(SETTINGS_CONSUMERS).filter((p) => p in PENDING_CONSUMERS)
    expect(overlap, `同一项不能既算已消费又算待消费：\n  ${overlap.join('\n  ')}`).toEqual([])
  })

  it('已消费清单里的项也必须在 settingsFields 里存在', () => {
    const declared = new Set(paths)
    const phantom = Object.keys(SETTINGS_CONSUMERS).filter((p) => !declared.has(p))
    expect(phantom, `SETTINGS_CONSUMERS 引用了不存在的设置项：\n  ${phantom.join('\n  ')}`).toEqual([])
  })

  it('源码扫描的根目录必须真实存在（防止路径写错导致扫描静默为空）', () => {
    // 这条是防守测试自己：目录写错时 collectSources 会返回空数组而让后面的断言"通过"
    expect(collectSources(SRC_ROOT).length, `SRC_ROOT 扫不到源码：${SRC_ROOT}`).toBeGreaterThan(50)
    expect(collectSources(SHARED_ROOT).length, `SHARED_ROOT 扫不到源码：${SHARED_ROOT}`).toBeGreaterThan(5)
  })

  it('源码里确实引用了这些字段名（启发式，抓路径名手滑）', () => {
    const files = [...collectSources(SRC_ROOT), ...collectSources(SHARED_ROOT)]
    // settings 目录自身不算消费者（面板声明自己当然引用自己）
    const outside = files.filter((f) => !f.includes('/features/settings/'))
    const haystack = outside.map((f) => readFileSync(f, 'utf8')).join('\n')

    const missing = paths
      .filter((p) => !(p in PENDING_CONSUMERS))
      .filter((p) => {
        const leaf = p.split('.').pop() ?? p
        return !new RegExp(`\\b${leaf}\\b`).test(haystack)
      })

    expect(
      missing,
      `以下设置项在源码里找不到任何引用（名字可能写错了，或消费点已被删）：\n  ${missing.join('\n  ')}`,
    ).toEqual([])
  })
})
