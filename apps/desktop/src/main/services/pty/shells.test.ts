// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * shells 单测：全部通过注入的假 io 完成，不读真实 /etc/shells、不碰真实文件系统。
 */

import { describe, expect, it } from 'vitest'
import {
  DEFAULT_COLORTERM,
  DEFAULT_TERM,
  PATH_EXTRA_DIRS,
  SHELLS_FILE,
  buildShellEnv,
  defaultProfiles,
  detectShells,
  parseShellsFile,
  platformDefaultShell,
  resolveShell,
  type ShellDetectIo,
} from './shells'

interface FakeIoOptions {
  platform?: NodeJS.Platform
  /** /etc/shells 的内容；null = 文件不存在 */
  shellsFile?: string | null
  /** 认为「存在」的路径 */
  existing?: string[]
  env?: Record<string, string>
  userShell?: string
}

function fakeIo(options: FakeIoOptions = {}): ShellDetectIo {
  const existing = new Set(options.existing ?? [])
  const envMap = options.env ?? {}
  return {
    platform: options.platform ?? 'linux',
    readFile: (path) => (path === SHELLS_FILE ? (options.shellsFile ?? null) : null),
    exists: (path) => existing.has(path),
    env: (name) => envMap[name],
    ...(options.userShell === undefined ? {} : { userShell: options.userShell }),
  }
}

describe('parseShellsFile', () => {
  const content = [
    '# /etc/shells: valid login shells',
    '/bin/sh',
    '/bin/bash',
    '/bin/dash',
    '/usr/bin/fish   # 行内注释',
    '/bin/zsh',
    '/bin/sh',
    'not-a-path',
    '   ',
    '/usr/bin/nologin',
    '/usr/bin/bash',
  ].join('\n')

  const parsed = parseShellsFile(content)

  it('忽略注释、空行与非绝对路径', () => {
    expect(parsed.map((s) => s.path)).toEqual([
      '/bin/sh',
      '/bin/bash',
      '/bin/dash',
      '/usr/bin/fish',
      '/bin/zsh',
      '/usr/bin/nologin',
      '/usr/bin/bash',
    ])
  })

  it('按路径去重', () => {
    const paths = parsed.map((s) => s.path)
    expect(new Set(paths).size).toBe(paths.length)
  })

  it('提取 name 并标记是否受支持', () => {
    expect(parsed[1]).toEqual({ path: '/bin/bash', name: 'bash', supported: true })
    expect(parsed[3]).toEqual({ path: '/usr/bin/fish', name: 'fish', supported: true })
    const nologin = parsed.find((s) => s.name === 'nologin')
    expect(nologin?.supported).toBe(false)
  })

  it('空内容返回空数组', () => {
    expect(parseShellsFile('')).toEqual([])
    expect(parseShellsFile('\n\n# only comments\n')).toEqual([])
  })
})

describe('platformDefaultShell', () => {
  it('linux 无 SHELL 时退回 /bin/sh', () => {
    expect(platformDefaultShell(fakeIo({ platform: 'linux' }))).toBe('/bin/sh')
  })

  it('尊重 $SHELL', () => {
    expect(platformDefaultShell(fakeIo({ env: { SHELL: '/usr/bin/zsh' } }))).toBe('/usr/bin/zsh')
  })

  it('darwin 无 SHELL 时退回 /bin/zsh', () => {
    expect(platformDefaultShell(fakeIo({ platform: 'darwin' }))).toBe('/bin/zsh')
  })

  it('win32 用 COMSPEC，缺失则 powershell.exe', () => {
    expect(platformDefaultShell(fakeIo({ platform: 'win32', env: { COMSPEC: 'C:\\cmd.exe' } }))).toBe(
      'C:\\cmd.exe',
    )
    expect(platformDefaultShell(fakeIo({ platform: 'win32' }))).toBe('powershell.exe')
  })
})

describe('detectShells', () => {
  it('只保留真实存在的 shell，按支持列表顺序排序', () => {
    const io = fakeIo({
      shellsFile: '/bin/zsh\n/bin/bash\n/bin/nologin\n',
      existing: ['/bin/zsh', '/bin/bash', '/bin/nologin'],
    })
    expect(detectShells(io).map((s) => s.name)).toEqual(['bash', 'zsh', 'nologin'])
    expect(detectShells(io).at(-1)?.supported).toBe(false)
  })

  it('同名 shell 只出现一次（/bin/bash 与 /usr/bin/bash 合并）', () => {
    const io = fakeIo({
      shellsFile: '/bin/bash\n/usr/bin/bash\n',
      existing: ['/bin/bash', '/usr/bin/bash'],
    })
    const shells = detectShells(io)
    expect(shells.filter((s) => s.name === 'bash')).toHaveLength(1)
  })

  it('/etc/shells 缺失时用常见路径兜底', () => {
    const io = fakeIo({ shellsFile: null, existing: ['/usr/bin/fish', '/bin/dash'] })
    expect(detectShells(io).map((s) => s.name)).toEqual(['fish', 'dash'])
  })

  it('什么都不存在时返回空数组', () => {
    expect(detectShells(fakeIo({ shellsFile: null }))).toEqual([])
  })
})

describe('resolveShell', () => {
  const io = fakeIo({
    shellsFile: '/bin/bash\n',
    existing: ['/bin/bash', '/usr/bin/zsh'],
    env: { SHELL: '/bin/bash' },
    userShell: '/bin/bash',
  })

  it('空 / 纯空白 → 平台默认 shell', () => {
    expect(resolveShell(undefined, io)).toBe('/bin/bash') // $SHELL 存在
    expect(resolveShell('   ', io)).toBe('/bin/bash')
    expect(resolveShell(undefined, fakeIo({ env: {} }))).toBe('/bin/sh')
  })

  it('绝对路径原样使用', () => {
    expect(resolveShell('/usr/bin/zsh', io)).toBe('/usr/bin/zsh')
    expect(resolveShell('/opt/custom/myshell', io)).toBe('/opt/custom/myshell')
  })

  it('与登录 shell 同名 → 用登录 shell 的完整路径', () => {
    const io2 = fakeIo({ userShell: '/usr/local/bin/bash', env: {} })
    expect(resolveShell('bash', io2)).toBe('/usr/local/bin/bash')
  })

  it('别名在探测结果 / 查找目录里命中', () => {
    expect(resolveShell('zsh', io)).toBe('/usr/bin/zsh')
    const io3 = fakeIo({ existing: ['/usr/local/bin/fish'], env: {} })
    expect(resolveShell('fish', io3)).toBe('/usr/local/bin/fish')
  })

  it('完全找不到时原样返回（让 spawn 报明确错误）', () => {
    expect(resolveShell('myshell', io)).toBe('myshell')
  })

  it('Windows 原样返回', () => {
    const win = fakeIo({ platform: 'win32', env: {} })
    expect(resolveShell('bash', win)).toBe('bash')
    expect(resolveShell(undefined, win)).toBe('powershell.exe')
  })
})

describe('buildShellEnv', () => {
  it('注入 TERM / COLORTERM 默认值', () => {
    const env = buildShellEnv({}, {}, 'linux')
    expect(env['TERM']).toBe(DEFAULT_TERM)
    expect(env['COLORTERM']).toBe(DEFAULT_COLORTERM)
  })

  it('显式指定优先，其次继承，最后默认', () => {
    expect(buildShellEnv({ TERM: 'screen' }, { term: 'vt100' }, 'linux')['TERM']).toBe('vt100')
    expect(buildShellEnv({ TERM: 'screen' }, {}, 'linux')['TERM']).toBe('screen')
    expect(buildShellEnv({ COLORTERM: '24bit' }, {}, 'linux')['COLORTERM']).toBe('24bit')
    expect(buildShellEnv({}, { colorTerm: 'truecolor' }, 'linux')['COLORTERM']).toBe('truecolor')
  })

  it('POSIX 下补齐 PATH 且不重复已有目录', () => {
    const env = buildShellEnv({ PATH: '/usr/bin:/bin' }, {}, 'linux')
    const parts = (env['PATH'] ?? '').split(':')
    for (const dir of PATH_EXTRA_DIRS) expect(parts).toContain(dir)
    expect(parts.filter((p) => p === '/usr/bin')).toHaveLength(1)
    expect(parts.filter((p) => p === '/bin')).toHaveLength(1)
  })

  it('原 PATH 的顺序不被抢占（只追加缺失项）', () => {
    const env = buildShellEnv({ PATH: '/custom/bin:/usr/bin' }, {}, 'linux')
    expect((env['PATH'] ?? '').startsWith('/custom/bin:/usr/bin')).toBe(true)
  })

  it('Windows 不动 PATH', () => {
    const env = buildShellEnv({ PATH: 'C:\\Windows' }, {}, 'win32')
    expect(env['PATH']).toBe('C:\\Windows')
  })

  it('跳过空键与 undefined 值', () => {
    const env = buildShellEnv({ '': 'x', FOO: undefined, BAR: 'ok' }, {}, 'linux')
    expect(env['FOO']).toBeUndefined()
    expect(env['']).toBeUndefined()
    expect(env['BAR']).toBe('ok')
  })
})

describe('defaultProfiles', () => {
  const io = fakeIo({
    shellsFile: '/bin/bash\n/bin/zsh\n',
    existing: ['/bin/bash', '/bin/zsh'],
  })

  const shells = detectShells(io)

  it('默认 profile 在最前，且用平台默认 shell', () => {
    const profiles = defaultProfiles(shells, io)
    expect(profiles[0]).toEqual({ id: 'default', name: '默认 Shell', shell: '/bin/sh', args: [] })
  })

  it('每个受支持 shell 一个 profile，带可读名字', () => {
    const profiles = defaultProfiles(shells, io)
    expect(profiles.map((p) => p.id)).toEqual(['default', 'bash', 'zsh'])
    expect(profiles.find((p) => p.id === 'zsh')?.name).toBe('Zsh')
    expect(profiles.find((p) => p.id === 'bash')?.shell).toBe('/bin/bash')
  })

  it('不受支持的 shell 不生成 profile', () => {
    const io2 = fakeIo({ shellsFile: '/usr/bin/nologin\n', existing: ['/usr/bin/nologin'] })
    const profiles = defaultProfiles(detectShells(io2), io2)
    expect(profiles.map((p) => p.id)).toEqual(['default'])
  })
})
