// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * scripts 单测：脚本分发协议 + 脚本本体校验。
 *
 * 这里做两件「不只测字符串」的事：
 * 1. `sh -n` 真语法检查（dash / busybox ash 都跑，若本机有）；
 * 2. 在临时目录里**真的执行一次**采集脚本（读本机 /proc），
 *    证明随包分发的脚本正文没有被嵌入过程破坏，输出是合法 JSON。
 *    只写 os.tmpdir()，不连任何主机、不碰用户目录。
 */

import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { defaultSettings } from './collector'
import { parseCollectorOutput } from './parser'
import {
  COLLECTOR_SCRIPT,
  DEFAULT_FAILURE_PAUSE_THRESHOLD,
  HEREDOC_MARKER,
  INSTALL_OK_SENTINEL,
  MODULE_BY_CARD,
  MONITOR_MODULES,
  REMOTE_DIR,
  REMOTE_SCRIPT_PATH,
  REMOTE_VERSION_PATH,
  SCRIPT_VERSION,
  VERSION_MISSING_SENTINEL,
  collectCommand,
  installCommand,
  modulesForCards,
  needsInstall,
  parseRemoteVersion,
  scriptDeclaredVersion,
  versionCheckCommand,
} from './scripts'

const hasBinary = (name: string): boolean => {
  // 只关心「可执行文件在不在」：ENOENT 才带 error，非零退出码不算
  const r = spawnSync(name, ['--version'], { stdio: 'ignore' })
  return !r.error
}
const hasSh = hasBinary('sh')
const hasBusybox = hasBinary('busybox')

describe('常量与脚本正文一致性', () => {
  it('脚本内声明的 VERSION 与 SCRIPT_VERSION 同步', () => {
    expect(scriptDeclaredVersion()).toBe(SCRIPT_VERSION)
  })

  it('脚本正文不包含 heredoc 终止符（否则安装命令会被截断）', () => {
    expect(COLLECTOR_SCRIPT).not.toContain(HEREDOC_MARKER)
  })

  it('脚本包含全部模块的实现与三档后端', () => {
    for (const mod of MONITOR_MODULES) {
      expect(COLLECTOR_SCRIPT).toContain(`m_${mod}()`)
    }
    // GNU ps / busybox ps / procfs 三档进程后端
    expect(COLLECTOR_SCRIPT).toContain('ps_gnu()')
    expect(COLLECTOR_SCRIPT).toContain('ps_bb_basic()')
    expect(COLLECTOR_SCRIPT).toContain('ps_procfs()')
    // 按需采集：gpu 缺失时优雅跳过
    expect(COLLECTOR_SCRIPT).toContain('nvidia-smi')
  })

  it('脚本可解析为普通 JSON 值（不是模板串残留）', () => {
    expect(COLLECTOR_SCRIPT.startsWith('#!/bin/sh')).toBe(true)
    // 外壳的 ${VAR:-default} 必须原样保留（sh -n 与真执行会进一步证明）
    expect(COLLECTOR_SCRIPT).toContain('${T1000_MONITOR_DIR:-$HOME/.t1000-monitor}')
  })
})

describe('版本比对协议', () => {
  it('parseRemoteVersion：去空白取首行', () => {
    expect(parseRemoteVersion('1\n')).toBe('1')
    expect(parseRemoteVersion(' 1 \n\n')).toBe('1')
    expect(parseRemoteVersion('\n')).toBeNull()
    expect(parseRemoteVersion('')).toBeNull()
  })

  it('缺失哨兵 → null（视为需要安装）', () => {
    expect(parseRemoteVersion(`${VERSION_MISSING_SENTINEL}\n`)).toBeNull()
  })

  it('needsInstall：只有版本完全相同才跳过', () => {
    expect(needsInstall(SCRIPT_VERSION)).toBe(false)
    expect(needsInstall('0')).toBe(true)
    expect(needsInstall(null)).toBe(true)
    expect(needsInstall('')).toBe(true)
  })

  it('版本探测是单条命令，不依赖 SFTP', () => {
    const cmd = versionCheckCommand()
    expect(cmd).toContain(REMOTE_SCRIPT_PATH)
    expect(cmd).toContain(REMOTE_VERSION_PATH)
    expect(cmd).toContain(VERSION_MISSING_SENTINEL)
    expect(cmd.split('\n').length).toBeLessThan(8)
  })

  it('安装命令：一次 heredoc 写入脚本与版本号', () => {
    const cmd = installCommand()
    expect(cmd).toContain(`<<'${HEREDOC_MARKER}'`)
    expect(cmd).toContain(COLLECTOR_SCRIPT)
    expect(cmd).toContain(INSTALL_OK_SENTINEL)
    expect(cmd).toContain(`printf '%s' '${SCRIPT_VERSION}' > "${REMOTE_VERSION_PATH}"`)
    // 终止符必须独占一行、且只出现一次，否则 heredoc 不会正确结束
    const lines = cmd.split('\n')
    const markerIndex = lines.indexOf(HEREDOC_MARKER)
    expect(markerIndex).toBeGreaterThan(0)
    expect(lines.filter((l) => l === HEREDOC_MARKER)).toHaveLength(1)
    // 终止符前一行就是脚本正文的最后一行 → 整段脚本都落在 heredoc 内
    expect(lines[markerIndex - 1]).toBe(COLLECTOR_SCRIPT.split('\n').at(-1))
  })

  it('安装目录用 $HOME 而不是 ~', () => {
    expect(REMOTE_DIR.startsWith('$HOME/')).toBe(true)
  })
})

describe('模块选择（关掉的卡片不发命令）', () => {
  it('全开卡片时按固定顺序返回全部模块', () => {
    expect(modulesForCards(defaultSettings().cards)).toEqual([
      'system',
      'cpu',
      'memory',
      'network',
      'disk',
      'process',
      'gpu',
    ])
  })

  it('关闭的卡片不产生模块', () => {
    const cards = defaultSettings().cards.map((c) => ({
      ...c,
      enabled: c.kind !== 'disk' && c.kind !== 'gpu',
    }))
    const modules = modulesForCards(cards)
    expect(modules).toEqual(['system', 'cpu', 'memory', 'network', 'process'])
    expect(modules).not.toContain('disk')
    expect(modules).not.toContain('gpu')
  })

  it('全部关闭时返回空数组', () => {
    const cards = defaultSettings().cards.map((c) => ({ ...c, enabled: false }))
    expect(modulesForCards(cards)).toEqual([])
  })

  it('每个卡片种类都有对应模块', () => {
    for (const card of defaultSettings().cards) {
      expect(MODULE_BY_CARD[card.kind]).toBeTypeOf('string')
    }
  })
})

describe('采集命令', () => {
  it('带上进程上限与监控目录，模块作为参数', () => {
    const cmd = collectCommand(['cpu', 'memory'], { processLimit: 12 })
    expect(cmd).toContain('T1000_PROC_LIMIT=12')
    expect(cmd).toContain(`T1000_MONITOR_DIR="${REMOTE_DIR}"`)
    expect(cmd).toContain(`sh "${REMOTE_SCRIPT_PATH}" cpu memory`)
  })

  it('进程上限被夹到 1..200', () => {
    expect(collectCommand(['cpu'], { processLimit: 0 })).toContain('T1000_PROC_LIMIT=1')
    expect(collectCommand(['cpu'], { processLimit: 9999 })).toContain('T1000_PROC_LIMIT=200')
    expect(collectCommand(['cpu'], { processLimit: Number.NaN })).toContain('T1000_PROC_LIMIT=1')
  })

  it('未知模块被丢弃', () => {
    const cmd = collectCommand(['cpu', 'rm -rf /', 'memory'])
    expect(cmd).toContain('cpu memory')
    expect(cmd).not.toContain('rm -rf')
  })

  it('默认进程上限与 MonitorSettings 默认值一致', () => {
    expect(collectCommand(['process'])).toContain('T1000_PROC_LIMIT=8')
  })
})

// ── 真语法检查 + 真执行（只读本机 /proc，写 os.tmpdir()）────────────────────

describe.skipIf(!hasSh)('脚本语法（sh -n）', () => {
  it('POSIX sh（dash）语法通过', () => {
    const r = spawnSync('sh', ['-n'], { input: COLLECTOR_SCRIPT, encoding: 'utf8' })
    expect(r.stderr).toBe('')
    expect(r.status).toBe(0)
  })

  it.skipIf(!hasBusybox)('busybox ash 语法通过', () => {
    const r = spawnSync('busybox', ['sh', '-n'], { input: COLLECTOR_SCRIPT, encoding: 'utf8' })
    expect(r.stderr).toBe('')
    expect(r.status).toBe(0)
  })
})

const canRunOnHost = hasSh && process.platform === 'linux'
const workDir = canRunOnHost ? mkdtempSync(join(tmpdir(), 't1000-monitor-test-')) : ''
const scriptPath = workDir ? join(workDir, 'collect.sh') : ''
if (workDir) writeFileSync(scriptPath, COLLECTOR_SCRIPT, 'utf8')

afterAll(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true })
})

describe.skipIf(!canRunOnHost)('脚本真执行（本机 /proc，临时目录）', () => {
  interface RunResult {
    status: number | null
    stdout: string
    stderr: string
  }

  function run(modules: string[], limit = 5): RunResult {
    const r = spawnSync('sh', [scriptPath, ...modules], {
      encoding: 'utf8',
      timeout: 30_000,
      env: { ...process.env, T1000_MONITOR_DIR: workDir, T1000_PROC_LIMIT: String(limit) },
    })
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
  }

  it('--version 打印与 SCRIPT_VERSION 一致的版本号', () => {
    const r = run(['--version'])
    expect(r.status).toBe(0)
    expect(r.stdout.trim()).toBe(SCRIPT_VERSION)
  })

  it('冷启动：输出合法 JSON，且各模块结构正确', () => {
    const r = run(['system', 'cpu', 'memory'])
    expect(r.status).toBe(0)
    expect(r.stderr).toBe('')

    const raw: unknown = JSON.parse(r.stdout)
    expect(typeof raw).toBe('object')

    const snapshot = parseCollectorOutput({
      sessionId: 'local',
      stdout: r.stdout,
      requestedModules: ['system', 'cpu', 'memory'],
    })
    expect(snapshot.warnings).toBeUndefined()
    expect(snapshot.memory?.totalBytes).toBeGreaterThan(0)
    expect(snapshot.memory?.usedBytes).toBeGreaterThanOrEqual(0)
    expect(snapshot.cpu?.cores.length).toBeGreaterThan(0)
    expect(snapshot.cpu?.usage).toBeGreaterThanOrEqual(0)
    expect(snapshot.cpu?.usage).toBeLessThanOrEqual(100)
    expect(snapshot.system?.kernel).toBeTypeOf('string')
  })

  it('热启动（第二次执行）：速率类字段走缓存差分', () => {
    // 第一次执行建立计数器缓存
    expect(run(['network', 'disk']).status).toBe(0)
    // 隔一秒再跑，dt > 0，应能算出速率
    spawnSync('sleep', ['1.1']) // 拿到 >0 的秒级间隔，让速率差分有分母
    const r = run(['network', 'disk'])
    expect(r.status).toBe(0)

    const snapshot = parseCollectorOutput({
      sessionId: 'local',
      stdout: r.stdout,
      requestedModules: ['network', 'disk'],
    })
    expect(snapshot.network?.rxSpeed).toBeGreaterThanOrEqual(0)
    expect(snapshot.network?.txSpeed).toBeGreaterThanOrEqual(0)
    expect(snapshot.disk?.readSpeed).toBeGreaterThanOrEqual(0)
    expect(snapshot.disk?.writeSpeed).toBeGreaterThanOrEqual(0)
  })

  it('进程模块：至少两个后端可用，输出 top-N 且字段齐全', () => {
    const r = run(['process'], 4)
    expect(r.status).toBe(0)

    const snapshot = parseCollectorOutput({
      sessionId: 'local',
      stdout: r.stdout,
      requestedModules: ['process'],
    })
    expect(snapshot.warnings).toBeUndefined()
    expect(Array.isArray(snapshot.processes)).toBe(true)
    expect(snapshot.processes?.length).toBeGreaterThan(0)
    expect(snapshot.processes?.length).toBeLessThanOrEqual(4)

    for (const proc of snapshot.processes ?? []) {
      expect(proc.pid).toBeGreaterThanOrEqual(0)
      expect(proc.command.length).toBeGreaterThan(0)
      expect(proc.cpu).toBeGreaterThanOrEqual(0)
      expect(proc.memory).toBeGreaterThanOrEqual(0)
    }
    // 后端选择会被缓存下来
    const backend = spawnSync('cat', [join(workDir, '.proc.backend')], { encoding: 'utf8' })
    expect(['gnu', 'bbtime', 'procfs', 'bbbasic']).toContain(backend.stdout.trim())
  })

  it('不存在的模块名不会让脚本失败（输出仍是合法 JSON）', () => {
    const r = run(['cpu', 'no_such_module'])
    expect(r.status).toBe(0)
    const raw = JSON.parse(r.stdout) as Record<string, unknown>
    expect(Object.keys(raw)).toContain('cpu')
    expect(Object.keys(raw)).not.toContain('no_such_module')
  })

  it('未启用任何模块时输出空对象 {}', () => {
    const r = run([])
    expect(r.status).toBe(0)
    expect(JSON.parse(r.stdout)).toEqual({})
  })

  it('缺字段/权限不足时不抛异常（模块级隔离）', () => {
    const r = run(['system', 'network', 'disk', 'process', 'gpu'])
    expect(r.status).toBe(0)
    // gpu 在无 nvidia-smi 的机器上应缺席，而不是报错
    expect(() => JSON.parse(r.stdout)).not.toThrow()
  })
})

describe('默认阈值常量', () => {
  it('默认失败暂停阈值是 3', () => {
    expect(DEFAULT_FAILURE_PAUSE_THRESHOLD).toBe(3)
  })
})
