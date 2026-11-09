// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 模板解析/渲染单测：`${{}}` 语法、参数与动态变量的区分、**边界情况**、多行逐行发送。
 */

import { describe, expect, it } from 'vitest'
import {
  parameterNamesOf,
  parseTemplate,
  renderLines,
  renderTemplate,
  splitLines,
  templateTags,
  variableNamesOf,
} from './template'
import type { VariableContext } from './variables'

const FIXED = new Date(2025, 10, 29, 14, 30, 45)
const ctx: VariableContext = { now: FIXED, randomString: (n) => 'R'.repeat(n), uuid: () => 'U' }

describe('parseTemplate：区分动态变量与自定义参数', () => {
  it('内置名字 → variable；其它名字 → parameter', () => {
    const parsed = parseTemplate('backup_${{database}}_${{date:YYYYMMDD}}.sql')
    expect(variableNamesOf(parsed)).toEqual(['date'])
    expect(parsed.parameterNames).toEqual(['database'])
    expect(parsed.variables[0]).toMatchObject({ kind: 'variable', name: 'date', format: 'YYYYMMDD' })
    expect(parsed.parameters[0]).toMatchObject({ kind: 'parameter', name: 'database' })
  })

  it('返回下标与原始文本（编辑器高亮/替换要用）', () => {
    const cmd = 'echo ${{host}}'
    const parsed = parseTemplate(cmd)
    const token = parsed.tokens[0]!
    expect(token.raw).toBe('${{host}}')
    expect(cmd.slice(token.start, token.end)).toBe('${{host}}')
  })

  it('中文变量名被当作参数（v5.2.47 起支持）', () => {
    const parsed = parseTemplate('grep ${{关键字}} /var/log/syslog')
    expect(parsed.parameterNames).toEqual(['关键字'])
    expect(parsed.parameters[0]?.kind).toBe('parameter')
  })

  it('同名参数重复出现：只提示一次，但每次都记录 token', () => {
    const parsed = parseTemplate('cp ${{file}} /backup/${{file}}.bak')
    expect(parsed.parameterNames).toEqual(['file'])
    expect(parsed.parameters).toHaveLength(2)
    const tags = templateTags(parsed)
    expect(tags).toHaveLength(1)
    expect(tags[0]).toMatchObject({ name: 'file', kind: 'parameter', count: 2 })
  })

  it('动态变量重复出现同样合并计数', () => {
    const tags = templateTags(parseTemplate('echo ${{date}} ${{date}}'))
    expect(tags).toHaveLength(1)
    expect(tags[0]).toMatchObject({ name: 'date', kind: 'variable', count: 2 })
  })

  it('parameterNamesOf 便捷函数', () => {
    expect(parameterNamesOf('a ${{x}} b ${{y}} c ${{x}}')).toEqual(['x', 'y'])
    expect(parameterNamesOf('echo hello')).toEqual([])
  })
})

describe('★ 边界情况（不能猜、不能崩）', () => {
  it('未闭合 `${{name` → 无 token，标记 hasUnclosed，渲染保持原样', () => {
    const cmd = 'echo ${{unclosed'
    const parsed = parseTemplate(cmd)
    expect(parsed.tokens).toEqual([])
    expect(parsed.hasUnclosed).toBe(true)
    expect(renderTemplate(cmd, { context: ctx }).text).toBe(cmd)

    // 未闭合之后即使有合法占位符也不再解析（避免半截字符串被吃掉）
    const mixed = 'echo ${{oops then ${{date}}'
    expect(parseTemplate(mixed).tokens).toEqual([])
  })

  it('空名字 `${{}}` 与缺名字 `${{:fmt}}` → 字面量', () => {
    for (const cmd of ['echo ${{}}', 'echo ${{:YYYY}}', 'echo ${{   }}']) {
      const parsed = parseTemplate(cmd)
      expect(parsed.tokens, cmd).toEqual([])
      expect(renderTemplate(cmd, { context: ctx }).text, cmd).toBe(cmd)
    }
  })

  it('非法名字（含空格/点/$）→ 字面量，不被当成参数', () => {
    for (const cmd of ['echo ${{a b}}', 'echo ${{a.b}}', 'echo ${{a$b}}']) {
      expect(parseTemplate(cmd).tokens, cmd).toEqual([])
    }
  })

  it('嵌套写法不会死循环，整体按字面量处理', () => {
    const cmd = 'echo ${{a${{b}}}}'
    const parsed = parseTemplate(cmd)
    // 第一段 name='a${{b' 非法 → 跳过；不会无限循环
    expect(parsed.tokens).toEqual([])
  })

  it('普通 `$` 与 `{` 不受影响', () => {
    const cmd = 'echo $HOME ${PATH} $ {x}'
    expect(parseTemplate(cmd).tokens).toEqual([])
    expect(renderTemplate(cmd).text).toBe(cmd)
  })

  it('多个合法占位符之间的字面量原样保留', () => {
    const parsed = parseTemplate('a${{x}}b${{y}}c')
    expect(parsed.tokens).toHaveLength(2)
    expect(renderTemplate('a${{x}}b${{y}}c', { params: { x: '1', y: '2' } }).text).toBe('a1b2c')
  })
})

describe('renderTemplate', () => {
  it('替换动态变量（按格式）与自定义参数', () => {
    const result = renderTemplate('backup_${{database}}_${{date:YYYYMMDD}}_${{random:4}}.sql', {
      context: ctx,
      params: { database: 'mydb' },
    })
    expect(result.text).toBe('backup_mydb_20251129_RRRR.sql')
    expect(result.missingParams).toEqual([])
  })

  it('★ 缺参数时保留占位符并报告缺哪些（PREVIEW 要如实显示）', () => {
    const result = renderTemplate('mysql -u ${{user}} -p${{dbpass}} ${{database}}', {
      context: ctx,
    })
    expect(result.missingParams).toEqual(['user', 'dbpass', 'database'])
    expect(result.text).toContain('${{user}}')
    expect(result.text).toContain('${{database}}')
  })

  it('password 是**动态变量**（绿色标签），不是自定义参数', () => {
    const parsed = parseTemplate('mysqldump -u ${{user}} -p${{password}} ${{database}}')
    // 只有 user/database 需要用户填，password 由系统填充
    expect(parsed.parameterNames).toEqual(['user', 'database'])
    expect(variableNamesOf(parsed)).toEqual(['password'])
  })

  it('空字符串是合法值（与"未提供"区分开）', () => {
    const result = renderTemplate('x=${{v}};', { params: { v: '' } })
    expect(result.text).toBe('x=;')
    expect(result.missingParams).toEqual([])
  })

  it('password 动态变量被替换为真实值', () => {
    const result = renderTemplate('mysqldump -p${{password}} db', {
      context: { ...ctx, password: 'p@ss' },
    })
    expect(result.text).toBe('mysqldump -pp@ss db')
  })

  it('同一个参数多处出现时全部替换', () => {
    const result = renderTemplate('cp ${{file}} /bk/${{file}}.bak', { params: { file: 'a.txt' } })
    expect(result.text).toBe('cp a.txt /bk/a.txt.bak')
  })

  it('spec 的 tar 示例逐字可用', () => {
    const result = renderTemplate('tar -czf /backup/logs_${{date:YYYYMMDD}}_${{time:HHmmss}}.tar.gz /var/log/', {
      context: ctx,
    })
    expect(result.text).toBe('tar -czf /backup/logs_20251129_143045.tar.gz /var/log/')
  })
})

describe('多行命令（逐行发送）', () => {
  it('splitLines 去掉空行与行首尾空白，兼容 CRLF', () => {
    expect(splitLines('cd /var/log\n\n  ls -la  \r\ntail -n 5 syslog\n')).toEqual([
      'cd /var/log',
      'ls -la',
      'tail -n 5 syslog',
    ])
  })

  it('renderLines 先渲染再逐行拆分', () => {
    const { lines, missingParams } = renderLines('cd /${{dir}}\nls -la\n\necho ${{date}}', {
      context: ctx,
      params: { dir: 'var' },
    })
    expect(lines).toEqual(['cd /var', 'ls -la', 'echo 2025-11-29'])
    expect(missingParams).toEqual([])
  })

  it('多行里缺参数时整体报告（不会漏掉第二行的参数）', () => {
    const { lines, missingParams } = renderLines('echo ${{a}}\necho ${{b}}')
    expect(lines).toHaveLength(2)
    expect(missingParams).toEqual(['a', 'b'])
  })
})
