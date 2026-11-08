// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 解析器单测：词法、缩进块归属、通配符语义、Include 展开与防循环、行号准确性。
 *
 * 全部走内存 IO，不碰真实文件系统。
 */

import { describe, expect, it } from 'vitest'
import {
  isWildcardOnly,
  matchHostPattern,
  parseSshConfig,
  resolveHosts,
  resolveOneHost,
  type ParseIo,
} from './sshconfig'

/** 内存文件系统 IO */
export function memIo(files: Record<string, string>, home = '/home/tester'): ParseIo {
  /** 展开 ~，并把相对路径按 `base` 解析（对齐 node:path.resolve 的语义） */
  const normalize = (p: string, base = '/'): string => {
    if (p === '~') return home
    let out = p.startsWith('~/') ? `${home}/${p.slice(2)}` : p
    if (!out.startsWith('/')) {
      // 相对路径：接到 base 上，并规范化掉 . / .. 与重复斜杠
      out = `${base.replace(/\/+$/, '')}/${out}`
    }
    const parts: string[] = []
    for (const seg of out.split('/')) {
      if (seg === '' || seg === '.') continue
      if (seg === '..') parts.pop()
      else parts.push(seg)
    }
    return `/${parts.join('/')}`
  }

  return {
    readFile: (p) => {
      const key = normalize(p)
      return Object.prototype.hasOwnProperty.call(files, key) ? files[key]! : null
    },
    readDir: (p) => {
      const dir = normalize(p).replace(/\/+$/, '')
      const prefix = `${dir}/`
      const names = new Set<string>()
      for (const f of Object.keys(files)) {
        if (!f.startsWith(prefix)) continue
        const rest = f.slice(prefix.length)
        const first = rest.split('/')[0]
        if (first) names.add(first)
      }
      return names.size > 0 ? [...names] : null
    },
    paths: {
      // 相对路径按 base 解析 —— 这正是 "Include conf.d/x.conf" 的语义来源
      resolve: (p, base) => normalize(p, base),
      dirname: (p) => {
        const n = normalize(p)
        const i = n.lastIndexOf('/')
        return i <= 0 ? '/' : n.slice(0, i)
      },
      isAbsolute: (p) => normalize(p).startsWith('/'),
      glob: (pattern) => {
        const p = normalize(pattern)
        const re = new RegExp(
          `^${p
            .split('')
            .map((c) => (c === '*' ? '[^/]*' : c === '?' ? '[^/]' : c.replace(/[.+^${}()|[\]\\]/g, '\\$&')))
            .join('')}$`,
        )
        return Object.keys(files).filter((f) => re.test(f))
      },
      isDirectory: (p) => {
        const dir = normalize(p).replace(/\/+$/, '')
        const prefix = `${dir}/`
        return Object.keys(files).some((f) => f.startsWith(prefix))
      },
    },
    home,
  }
}

/** 解析一段内联配置（写成 /home/tester/.ssh/config） */
function parseInline(text: string, extra: Record<string, string> = {}) {
  const path = '/home/tester/.ssh/config'
  const io = memIo({ [path]: text, ...extra })
  return { parsed: parseSshConfig(path, io), io }
}

describe('词法：写法兼容', () => {
  it('支持 `Key Value` 与 `Key=Value` 两种写法', () => {
    const { parsed } = parseInline(
      ['Host a', '  HostName 1.2.3.4', '  Port 2222', '', 'Host b', '  HostName=5.6.7.8', '  Port=22'].join('\n'),
    )
    const hosts = resolveHosts(parsed.blocks)
    const a = hosts.find((h) => h.name === 'a')!
    const b = hosts.find((h) => h.name === 'b')!

    expect(a.directives.get('hostname')).toBe('1.2.3.4')
    expect(a.directives.get('port')).toBe('2222')
    expect(b.directives.get('hostname')).toBe('5.6.7.8')
    expect(b.directives.get('port')).toBe('22')
  })

  it('Key = Value（等号两侧带空格）也能解析', () => {
    const { parsed } = parseInline(['Host a', '  HostName = 9.9.9.9'].join('\n'))
    expect(resolveHosts(parsed.blocks)[0]!.directives.get('hostname')).toBe('9.9.9.9')
  })

  it('指令名大小写不敏感', () => {
    const { parsed } = parseInline(['HOST a', '  HOSTNAME 1.1.1.1', '  USER root'].join('\n'))
    const h = resolveHosts(parsed.blocks)[0]!
    expect(h.directives.get('hostname')).toBe('1.1.1.1')
    expect(h.directives.get('user')).toBe('root')
  })

  it('引号包裹的值（单引号、双引号、含空格）', () => {
    const { parsed } = parseInline(
      ['Host quoted', '  HostName "1.2.3.4"', "  User 'my user'", '  IdentityFile "/path/with space/id_rsa"'].join('\n'),
    )
    const h = resolveHosts(parsed.blocks)[0]!
    expect(h.directives.get('hostname')).toBe('1.2.3.4')
    expect(h.directives.get('user')).toBe('my user')
    expect(h.directives.get('identityfile')).toBe('/path/with space/id_rsa')
  })

  it('双引号内的 \\" 转义', () => {
    const { parsed } = parseInline(['Host e', '  User "a\\"b"'].join('\n'))
    expect(resolveHosts(parsed.blocks)[0]!.directives.get('user')).toBe('a"b')
  })

  it('整行注释与行尾注释都被忽略', () => {
    const { parsed } = parseInline(
      ['# 这是整行注释', 'Host a  # 行尾注释', '  HostName 1.2.3.4   # 又一个', '  # 缩进的注释'].join('\n'),
    )
    const h = resolveHosts(parsed.blocks)[0]!
    expect(h.name).toBe('a')
    expect(h.directives.get('hostname')).toBe('1.2.3.4')
    expect(parsed.errors).toEqual([])
  })

  it('值里的 # 不被当注释（前面无空白）', () => {
    const { parsed } = parseInline(['Host a', '  User foo#bar'].join('\n'))
    expect(resolveHosts(parsed.blocks)[0]!.directives.get('user')).toBe('foo#bar')
  })

  it('缩进块语义：Host 之后直到下一个 Host 都归属它', () => {
    const { parsed } = parseInline(
      ['Host a', '  HostName 1.1.1.1', '  User ua', '', '# 空行与注释不打断', '  Port 2200', 'Host b', '  HostName 2.2.2.2'].join('\n'),
    )
    const hosts = resolveHosts(parsed.blocks)
    const a = hosts.find((h) => h.name === 'a')!
    const b = hosts.find((h) => h.name === 'b')!

    expect(a.directives.get('port')).toBe('2200')
    expect(a.directives.get('user')).toBe('ua')
    // b 不能沾到 a 的任何值
    expect(b.directives.get('port')).toBeUndefined()
    expect(b.directives.get('user')).toBeUndefined()
    expect(b.directives.get('hostname')).toBe('2.2.2.2')
  })

  it('没有缩进也能正确归属（缩进不是必需的）', () => {
    const { parsed } = parseInline(['Host a', 'HostName 1.1.1.1', 'User ua'].join('\n'))
    const h = resolveHosts(parsed.blocks)[0]!
    expect(h.directives.get('hostname')).toBe('1.1.1.1')
    expect(h.directives.get('user')).toBe('ua')
  })

  it('多别名：`Host a b c` 拆成三个模式', () => {
    const { parsed } = parseInline(['Host a b c', '  User shared'].join('\n'))
    expect(parsed.blocks[0]!.patterns).toEqual(['a', 'b', 'c'])

    const hosts = resolveHosts(parsed.blocks)
    expect(hosts.map((h) => h.name)).toEqual(['a', 'b', 'c'])
    // 三个别名共享同一套指令
    for (const h of hosts) expect(h.directives.get('user')).toBe('shared')
  })

  it('逗号分隔的别名也支持', () => {
    const { parsed } = parseInline(['Host a,b', '  User u'].join('\n'))
    expect(parsed.blocks[0]!.patterns).toEqual(['a', 'b'])
  })

  it('CRLF 换行不影响解析', () => {
    const { parsed } = parseInline('Host a\r\n  HostName 1.1.1.1\r\n  User u\r\n')
    const h = resolveHosts(parsed.blocks)[0]!
    expect(h.directives.get('hostname')).toBe('1.1.1.1')
    expect(h.directives.get('user')).toBe('u')
  })

  it('累加型指令 IdentityFile 保留多个值', () => {
    const { parsed } = parseInline(
      ['Host a', '  IdentityFile ~/.ssh/id_rsa', '  IdentityFile ~/.ssh/id_ed25519'].join('\n'),
    )
    expect(parsed.blocks[0]!.directives.get('identityfile')).toEqual([
      '~/.ssh/id_rsa',
      '~/.ssh/id_ed25519',
    ])
  })
})

describe('语法错误：行号必须准确', () => {
  it('引号未闭合 → 报告正确行号', () => {
    const { parsed } = parseInline(
      ['Host a', '  HostName "unterminated', '  User u'].join('\n'),
    )
    expect(parsed.errors).toHaveLength(1)
    expect(parsed.errors[0]!.line).toBe(2) // 第 2 行
    expect(parsed.errors[0]!.message).toContain('引号未闭合')
    expect(parsed.errors[0]!.text).toContain('unterminated')
  })

  it('缺少指令名 → 报告正确行号', () => {
    const { parsed } = parseInline(['Host a', '  User u', '=', '  Port 22'].join('\n'))
    expect(parsed.errors).toHaveLength(1)
    expect(parsed.errors[0]!.line).toBe(3)
  })

  it('Host 缺模式 → 报告正确行号', () => {
    const { parsed } = parseInline(['# c', 'Host', '  User u'].join('\n'))
    expect(parsed.errors).toHaveLength(1)
    expect(parsed.errors[0]!.line).toBe(2)
    expect(parsed.errors[0]!.message).toContain('缺少匹配模式')
  })

  it('多处错误各自带自己的行号', () => {
    const { parsed } = parseInline(
      ['Host a', '  HostName "bad', '  User ok', '  User "also-bad', 'Host b'].join('\n'),
    )
    expect(parsed.errors.map((e) => e.line)).toEqual([2, 4])
  })

  it('注释行与空行不产生错误', () => {
    const { parsed } = parseInline(['# only a comment', '', '   ', 'Host a'].join('\n'))
    expect(parsed.errors).toEqual([])
  })

  it('错误行文本是 trim 后的原文', () => {
    const { parsed } = parseInline(['Host a', '      HostName "x'].join('\n'))
    expect(parsed.errors[0]!.text).toBe('HostName "x')
  })
})

describe('通配符匹配语义', () => {
  it('matchHostPattern：字面量、* 、?', () => {
    expect(matchHostPattern('web', 'web')).toBe(true)
    expect(matchHostPattern('web', 'web2')).toBe(false)
    expect(matchHostPattern('*', 'anything')).toBe(true)
    expect(matchHostPattern('web-*', 'web-01')).toBe(true)
    expect(matchHostPattern('web-*', 'db-01')).toBe(false)
    expect(matchHostPattern('web?', 'web1')).toBe(true)
    expect(matchHostPattern('web?', 'web12')).toBe(false)
    expect(matchHostPattern('*.example.com', 'a.example.com')).toBe(true)
    expect(matchHostPattern('*.example.com', 'example.com')).toBe(false)
  })

  it('大小写不敏感', () => {
    expect(matchHostPattern('WEB-*', 'web-01')).toBe(true)
    expect(matchHostPattern('web-*', 'WEB-01')).toBe(true)
  })

  it('正则元字符按字面量处理（不被当模式）', () => {
    // 如果实现里用了未转义的正则，'.' 会匹配任意字符，这里必须为 false
    expect(matchHostPattern('a.b', 'axb')).toBe(false)
    expect(matchHostPattern('a.b', 'a.b')).toBe(true)
    expect(matchHostPattern('a+b', 'aab')).toBe(false)
    expect(matchHostPattern('(x)', '(x)')).toBe(true)
  })

  it('末尾 * 与中间 *', () => {
    expect(matchHostPattern('a*', 'a')).toBe(true)
    expect(matchHostPattern('a*c', 'abbbc')).toBe(true)
    expect(matchHostPattern('a*c', 'abbb')).toBe(false)
  })

  it('isWildcardOnly 判定默认值段', () => {
    expect(isWildcardOnly(['*'])).toBe(true)
    expect(isWildcardOnly(['*.example.com'])).toBe(true)
    expect(isWildcardOnly(['web?'])).toBe(true)
    expect(isWildcardOnly(['web', '*'])).toBe(false)
    expect(isWildcardOnly([])).toBe(false)
  })
})

describe('默认值段语义：Host * 提供兜底，具体 Host 优先', () => {
  it('Host * 不生成连接（它是默认值段）', () => {
    const { parsed } = parseInline(['Host *', '  User defaultuser', '  Port 22'].join('\n'))
    const hosts = resolveHosts(parsed.blocks)
    expect(hosts).toEqual([]) // 没有具体 Host → 没有连接
  })

  it('具体 Host 未指定的值从 Host * 继承', () => {
    const { parsed } = parseInline(
      ['Host *', '  User fallback', '  Port 2200', '', 'Host web', '  HostName 1.1.1.1'].join('\n'),
    )
    const web = resolveHosts(parsed.blocks).find((h) => h.name === 'web')!
    expect(web.directives.get('user')).toBe('fallback')
    expect(web.directives.get('port')).toBe('2200')
    expect(web.directives.get('hostname')).toBe('1.1.1.1')
    expect(web.fromDefaults.has('user')).toBe(true)
    expect(web.fromDefaults.has('hostname')).toBe(false)
  })

  /**
   * 以下是本模块**最容易写错**的一组语义，期望值不是猜的，
   * 而是用真实 OpenSSH 对照标定的：
   *
   *   $ ssh -F ./cfg -G web
   *
   * OpenSSH 的规则是纯粹的 **first obtained wins**（按文件顺序扫描，先得到的值生效），
   * 与"哪个 Host 段更具体"**无关**。所以 `Host *` 写在前面时，它的值会压过
   * 后面具体 Host 的值——这与很多人的直觉相反，但确实是 ssh 的行为。
   */
  it('Host * 写在前面时，它的值压过后面具体 Host 的值（真实 ssh 行为）', () => {
    const { parsed } = parseInline(
      ['Host *', '  User fallback', '  Port 2200', '', 'Host web', '  HostName 1.1.1.1', '  User webuser'].join('\n'),
    )
    const web = resolveHosts(parsed.blocks).find((h) => h.name === 'web')!

    // 对照 `ssh -G web`：user=fallback port=2200 hostname=1.1.1.1
    expect(web.directives.get('user')).toBe('fallback')
    expect(web.directives.get('port')).toBe('2200')
    // web 段独有的 hostname 正常生效
    expect(web.directives.get('hostname')).toBe('1.1.1.1')
  })

  it('具体 Host 写在前面时它的值胜出，后面的 Host * 只补空缺（真实 ssh 行为）', () => {
    const { parsed } = parseInline(
      ['Host web', '  User webuser', '', 'Host *', '  User fallback', '  Port 9999'].join('\n'),
    )
    const web = resolveHosts(parsed.blocks).find((h) => h.name === 'web')!

    // 对照 `ssh -G web`：user=webuser port=9999
    expect(web.directives.get('user')).toBe('webuser') // 具体值保住
    expect(web.directives.get('port')).toBe('9999') // 未指定的仍继承
  })

  it('通配段在中间时，前后具体 Host 的行为正确', () => {
    const { parsed } = parseInline(
      ['Host before', '  Port 1111', 'Host *', '  Port 2222', '  User u', 'Host after', '  Port 3333'].join('\n'),
    )
    const hosts = resolveHosts(parsed.blocks)
    const before = hosts.find((h) => h.name === 'before')!
    const after = hosts.find((h) => h.name === 'after')!

    // 对照 `ssh -G before` → user=u port=1111
    expect(before.directives.get('port')).toBe('1111') // 在 * 之前 → 自己胜出
    expect(before.directives.get('user')).toBe('u') // 从后面的 * 继承

    // 对照 `ssh -G after` → user=u port=**2222**
    // 关键：after 自己的 Port 3333 反而**没生效**，因为前面的 `Host *` 已经给了 2222。
    // 这正是 first-wins 的反直觉之处，也是最容易实现错的地方。
    expect(after.directives.get('port')).toBe('2222')
    expect(after.directives.get('user')).toBe('u')
  })

  it('只含通配符的多个段都不生成连接', () => {
    const { parsed } = parseInline(
      ['Host *', '  User u1', 'Host *.internal', '  User u2', 'Host 10.*', '  User u3'].join('\n'),
    )
    expect(resolveHosts(parsed.blocks)).toEqual([])
  })

  it('`Host *` 与具体 Host 混在同一个多别名段里时，该段算具体段', () => {
    const { parsed } = parseInline(['Host web *', '  User u'].join('\n'))
    // 段里有具体名字 web，所以不是纯默认段
    const hosts = resolveHosts(parsed.blocks)
    expect(hosts.map((h) => h.name)).toEqual(['web'])
  })

  it('更宽的通配段写在前面时胜出，即使后面有更具体的匹配段（真实 ssh 行为）', () => {
    const { parsed } = parseInline(
      ['Host *.internal', '  User internal-user', 'Host db.internal', '  User db-user'].join('\n'),
    )
    const db = resolveHosts(parsed.blocks).find((h) => h.name === 'db.internal')!

    // 对照 `ssh -G db.internal` → user=internal-user
    // `*.internal` 在前，先给了 user，因此胜过后面更具体的 db.internal
    expect(db.directives.get('user')).toBe('internal-user')
  })

  it('把具体段写在通配段之前，具体值才胜出（实践中的正确写法）', () => {
    const { parsed } = parseInline(
      ['Host db.internal', '  User db-user', 'Host *.internal', '  User internal-user'].join('\n'),
    )
    const db = resolveHosts(parsed.blocks).find((h) => h.name === 'db.internal')!
    expect(db.directives.get('user')).toBe('db-user')
    // 未被覆盖的键仍从通配段继承
    const other = resolveHosts(parsed.blocks).find((h) => h.name === '*.internal')
    expect(other).toBeUndefined() // 纯通配段不生成连接
  })

  it('同一别名出现在多个段时只产出一次，且取最先出现的值', () => {
    const { parsed } = parseInline(['Host web', '  User first', 'Host web', '  User second'].join('\n'))
    const hosts = resolveHosts(parsed.blocks)
    expect(hosts).toHaveLength(1)
    expect(hosts[0]!.directives.get('user')).toBe('first')
  })
})

describe('Include：文件 / 目录 / 通配符 / 防循环', () => {
  it('Include 单个文件，Host 段就地展开', () => {
    const { parsed } = parseInline(
      ['Include ~/.ssh/extra', '', 'Host main', '  User main'].join('\n'),
      { '/home/tester/.ssh/extra': 'Host from-extra\n  User extra-user\n' },
    )
    const hosts = resolveHosts(parsed.blocks)
    expect(hosts.map((h) => h.name).sort()).toEqual(['from-extra', 'main'])
    expect(hosts.find((h) => h.name === 'from-extra')!.directives.get('user')).toBe('extra-user')
  })

  it('Include 目录：读目录下所有文件', () => {
    const { parsed } = parseInline(
      ['Include ~/.ssh/conf.d'].join('\n'),
      {
        '/home/tester/.ssh/conf.d/a.conf': 'Host alpha\n  User ua\n',
        '/home/tester/.ssh/conf.d/b.conf': 'Host beta\n  User ub\n',
      },
    )
    const hosts = resolveHosts(parsed.blocks)
    expect(hosts.map((h) => h.name).sort()).toEqual(['alpha', 'beta'])
  })

  it('Include 目录时跳过隐藏文件与备份残留', () => {
    const { parsed } = parseInline(
      ['Include ~/.ssh/conf.d'].join('\n'),
      {
        '/home/tester/.ssh/conf.d/real.conf': 'Host real\n',
        '/home/tester/.ssh/conf.d/.hidden': 'Host hidden\n',
        '/home/tester/.ssh/conf.d/old.conf.bak': 'Host backup\n',
        '/home/tester/.ssh/conf.d/x.conf~': 'Host tilde\n',
        '/home/tester/.ssh/conf.d/y.conf.swp': 'Host swp\n',
      },
    )
    expect(resolveHosts(parsed.blocks).map((h) => h.name)).toEqual(['real'])
  })

  it('Include 通配符展开多个文件', () => {
    const { parsed } = parseInline(
      ['Include ~/.ssh/conf.d/*.conf'].join('\n'),
      {
        '/home/tester/.ssh/conf.d/a.conf': 'Host a\n',
        '/home/tester/.ssh/conf.d/b.conf': 'Host b\n',
        '/home/tester/.ssh/conf.d/skip.txt': 'Host skipped\n',
      },
    )
    const names = resolveHosts(parsed.blocks).map((h) => h.name).sort()
    expect(names).toEqual(['a', 'b'])
  })

  it('Include 相对路径按「包含它的文件所在目录」解析', () => {
    const { parsed } = parseInline(
      ['Include conf.d/rel.conf'].join('\n'),
      { '/home/tester/.ssh/conf.d/rel.conf': 'Host rel\n' },
    )
    expect(resolveHosts(parsed.blocks).map((h) => h.name)).toEqual(['rel'])
  })

  it('**循环 Include 不死循环**（A include B，B include A）', () => {
    const { parsed } = parseInline(
      ['Include ~/.ssh/b.conf', 'Host a', '  User ua'].join('\n'),
      {
        '/home/tester/.ssh/b.conf': 'Include ~/.ssh/config\nHost b\n  User ub\n',
      },
    )
    // 能正常返回（没有栈溢出 / 不挂起），两个 Host 都解析到
    const names = resolveHosts(parsed.blocks).map((h) => h.name).sort()
    expect(names).toEqual(['a', 'b'])
    // 并且明确报告了循环
    expect(parsed.errors.some((e) => e.message.includes('循环 Include'))).toBe(true)
  })

  it('自 Include 自己也不死循环', () => {
    const { parsed } = parseInline(['Include ~/.ssh/config', 'Host self', '  User u'].join('\n'))
    expect(resolveHosts(parsed.blocks).map((h) => h.name)).toEqual(['self'])
    expect(parsed.errors.some((e) => e.message.includes('循环'))).toBe(true)
  })

  it('菱形 Include（同一文件被两条路径包含）只解析一次，Host 不重复', () => {
    const { parsed } = parseInline(
      ['Include ~/.ssh/x.conf', 'Include ~/.ssh/y.conf'].join('\n'),
      {
        '/home/tester/.ssh/x.conf': 'Include ~/.ssh/shared.conf\nHost xh\n',
        '/home/tester/.ssh/y.conf': 'Include ~/.ssh/shared.conf\nHost yh\n',
        '/home/tester/.ssh/shared.conf': 'Host shared\n  User shareduser\n',
      },
    )
    const names = resolveHosts(parsed.blocks).map((h) => h.name).sort()
    expect(names).toEqual(['shared', 'xh', 'yh']) // shared 只出现一次
  })

  it('Include 的文件不存在：记一条 error，不中断其它解析', () => {
    const { parsed } = parseInline(
      ['Include ~/.ssh/nope.conf', 'Host still-here', '  User u'].join('\n'),
    )
    const names = resolveHosts(parsed.blocks).map((h) => h.name)
    expect(names).toContain('still-here')
    expect(parsed.errors.some((e) => e.message.includes('无法读取'))).toBe(true)
  })

  it('Include 多目标（同一行多个）', () => {
    const { parsed } = parseInline(
      ['Include ~/.ssh/a.conf ~/.ssh/b.conf'].join('\n'),
      { '/home/tester/.ssh/a.conf': 'Host a\n', '/home/tester/.ssh/b.conf': 'Host b\n' },
    )
    expect(resolveHosts(parsed.blocks).map((h) => h.name).sort()).toEqual(['a', 'b'])
  })

  it('Include 进来的 Host 参与 first-wins 合并，且顺序在包含点之后', () => {
    const { parsed } = parseInline(
      ['Host web', '  User outer', 'Include ~/.ssh/inc.conf', 'Host *', '  User fallback'].join('\n'),
      { '/home/tester/.ssh/inc.conf': 'Host web\n  User inner\n' },
    )
    // 外层 web 先出现 → 它的值胜出
    const web = resolveHosts(parsed.blocks).find((h) => h.name === 'web')!
    expect(web.directives.get('user')).toBe('outer')
  })

  it('files 列表记录了实际读过的文件', () => {
    const { parsed } = parseInline(
      ['Include ~/.ssh/inc.conf', 'Host a'].join('\n'),
      { '/home/tester/.ssh/inc.conf': 'Host b\n' },
    )
    expect(parsed.files).toContain('/home/tester/.ssh/config')
    expect(parsed.files).toContain('/home/tester/.ssh/inc.conf')
  })
})

describe('Host 段之前的指令（全局默认）', () => {
  it('出现在任何 Host 之前的指令被当作 Host * 默认值', () => {
    const { parsed } = parseInline(
      ['User globaluser', 'Port 2222', '', 'Host web', '  HostName 1.1.1.1'].join('\n'),
    )
    const web = resolveHosts(parsed.blocks).find((h) => h.name === 'web')!
    expect(web.directives.get('user')).toBe('globaluser')
    expect(web.directives.get('port')).toBe('2222')
  })
})

describe('resolveOneHost 直接调用', () => {
  it('对未匹配任何段的 Host 返回空指令集', () => {
    const { parsed } = parseInline(['Host a', '  User ua'].join('\n'))
    const h = resolveOneHost('nonexistent', parsed.blocks)
    expect(h.directives.size).toBe(0)
    expect(h.matchedBlocks).toEqual([])
  })
})
