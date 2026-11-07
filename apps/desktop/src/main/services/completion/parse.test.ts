// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 命令行解析单测（纯函数，不碰语料、不碰文件系统）。
 * 覆盖验收点：光标位置、引号内、管道后、多空格。
 */

import { describe, expect, it } from 'vitest'
import { isEnvAssignment, parseCommandLine } from './engine'

describe('parseCommandLine / 基本 token 切分', () => {
  it('行首：处于命令位置', () => {
    const ctx = parseCommandLine('')
    expect(ctx.token).toBe('')
    expect(ctx.atCommandPosition).toBe(true)
    expect(ctx.command).toBeNull()
    expect(ctx.expecting).toBe('command')
    expect(ctx.aiPrefix).toBe(false)
  })

  it('命令名后跟选项', () => {
    const ctx = parseCommandLine('ls -la')
    expect(ctx.command).toBe('ls')
    expect(ctx.token).toBe('-la')
    expect(ctx.tokenStart).toBe(3)
    expect(ctx.atCommandPosition).toBe(false)
    expect(ctx.expecting).toBe('option')
    expect(ctx.argIndex).toBe(0)
  })

  it('命令名后有空格：token 为空，属于参数位置', () => {
    const ctx = parseCommandLine('ls ')
    expect(ctx.command).toBe('ls')
    expect(ctx.token).toBe('')
    expect(ctx.expecting).toBe('argument')
    expect(ctx.atCommandPosition).toBe(false)
  })

  it('多空格不产生空 token，tokenStart 指向真实起点', () => {
    const ctx = parseCommandLine('ls    -l')
    expect(ctx.tokens).toEqual(['ls'])
    expect(ctx.token).toBe('-l')
    expect(ctx.tokenStart).toBe(6)
  })

  it('光标在行中间（token 只取光标之前的部分）', () => {
    const ctx = parseCommandLine('git checkout main', 8)
    expect(ctx.before).toBe('git chec')
    expect(ctx.after).toBe('kout main')
    expect(ctx.command).toBe('git')
    expect(ctx.token).toBe('chec')
    expect(ctx.tokenStart).toBe(4)
    // 替换范围覆盖整个 token
    expect(ctx.replaceEnd).toBe(12)
  })

  it('光标为 0 时等价于空行', () => {
    const ctx = parseCommandLine('ls -la', 0)
    expect(ctx.token).toBe('')
    expect(ctx.atCommandPosition).toBe(true)
  })

  it('光标越界被夹到行尾', () => {
    const ctx = parseCommandLine('ls', 999)
    expect(ctx.before).toBe('ls')
    expect(ctx.after).toBe('')
    // 未提交的 token 仍在「命令名位置」上：此时补的就是命令名本身
    expect(ctx.atCommandPosition).toBe(true)
    expect(ctx.command).toBeNull()
    expect(ctx.token).toBe('ls')
  })

  it('反斜杠转义的空格不切分 token', () => {
    const ctx = parseCommandLine('echo a\\ b')
    expect(ctx.command).toBe('echo')
    expect(ctx.token).toBe('a b')
  })
})

describe('parseCommandLine / 引号', () => {
  it('双引号未闭合：token 是引号内内容，起点在引号之后', () => {
    const ctx = parseCommandLine('echo "hello wo')
    expect(ctx.quote).toBe('"')
    expect(ctx.token).toBe('hello wo')
    expect(ctx.tokenStart).toBe(6)
    expect(ctx.command).toBe('echo')
  })

  it('单引号未闭合', () => {
    const ctx = parseCommandLine("echo 'a b")
    expect(ctx.quote).toBe("'")
    expect(ctx.token).toBe('a b')
    expect(ctx.tokenStart).toBe(6)
  })

  it('引号内不因管道/空格切 token', () => {
    const ctx = parseCommandLine('echo "a | b c')
    expect(ctx.quote).toBe('"')
    expect(ctx.token).toBe('a | b c')
    expect(ctx.atCommandPosition).toBe(false)
  })

  it('引号闭合后 token 结算，回到参数位置', () => {
    const ctx = parseCommandLine('echo "hello world" ')
    expect(ctx.quote).toBeNull()
    expect(ctx.token).toBe('')
    expect(ctx.tokens).toEqual(['echo', 'hello world'])
    expect(ctx.argIndex).toBe(1)
  })

  it('双引号内的 \\" 不结束引号', () => {
    const ctx = parseCommandLine('echo "a\\"b')
    expect(ctx.quote).toBe('"')
    expect(ctx.token).toBe('a"b')
  })
})

describe('parseCommandLine / 管道与分隔符', () => {
  it('管道后有空格：新命令位置', () => {
    const ctx = parseCommandLine('ls | gr')
    expect(ctx.token).toBe('gr')
    expect(ctx.atCommandPosition).toBe(true)
    expect(ctx.command).toBeNull()
    expect(ctx.expecting).toBe('command')
    expect(ctx.tokens).toEqual(['ls', '|'])
  })

  it('管道无空格也能切分（ls|gr）', () => {
    const ctx = parseCommandLine('ls|gr')
    expect(ctx.tokens).toEqual(['ls', '|'])
    expect(ctx.token).toBe('gr')
    expect(ctx.atCommandPosition).toBe(true)
  })

  it('管道后的命令与选项', () => {
    // 行尾有空格 → 'x' 已被提交，argIndex 才算数
    const ctx = parseCommandLine('ls | grep -i x ')
    expect(ctx.tokens).toEqual(['ls', '|', 'grep', '-i', 'x'])
    expect(ctx.command).toBe('grep')
    expect(ctx.token).toBe('')
    expect(ctx.argIndex).toBe(1)
    expect(ctx.usedOptions).toEqual(['-i'])
  })

  it('尚未提交的参数不计入 argIndex', () => {
    const ctx = parseCommandLine('ls | grep -i x')
    expect(ctx.token).toBe('x')
    expect(ctx.argIndex).toBe(0)
  })

  it('&& 之后是新命令位置', () => {
    const ctx = parseCommandLine('cd /tmp && ls -')
    expect(ctx.command).toBe('ls')
    expect(ctx.token).toBe('-')
    expect(ctx.expecting).toBe('option')
    expect(ctx.tokens).toEqual(['cd', '/tmp', '&&', 'ls'])
  })

  it('分号之后是新命令位置', () => {
    const ctx = parseCommandLine('cd /tmp; git st')
    expect(ctx.command).toBe('git')
    expect(ctx.token).toBe('st')
    expect(ctx.atCommandPosition).toBe(false)
  })

  it('三个管道符中的 || 被整体识别', () => {
    const ctx = parseCommandLine('false || ls')
    expect(ctx.tokens).toEqual(['false', '||']) // 'ls' 仍是未提交的当前 token
    expect(ctx.token).toBe('ls')
    // || 之后是命令位置，因此此刻补的是命令名（command 只在 token 提交后才有值）
    expect(ctx.atCommandPosition).toBe(true)
    expect(ctx.command).toBeNull()
    expect(ctx.expecting).toBe('command')
  })

  it('重定向之后不是命令位置', () => {
    const ctx = parseCommandLine('echo hi > out')
    expect(ctx.command).toBe('echo')
    expect(ctx.token).toBe('out')
    expect(ctx.atCommandPosition).toBe(false)
    expect(ctx.expecting).toBe('argument')
  })

  it('比较操作符 > 被当作重定向（不是管道）', () => {
    const ctx = parseCommandLine('sort file >> sorted.txt')
    expect(ctx.tokens).toEqual(['sort', 'file', '>>'])
    expect(ctx.token).toBe('sorted.txt')
    expect(ctx.atCommandPosition).toBe(false)
  })
})

describe('parseCommandLine / 其它', () => {
  it('KEY=VALUE 前置赋值不算命令名', () => {
    const ctx = parseCommandLine('FOO=bar ls -l')
    expect(ctx.command).toBe('ls')
    expect(ctx.token).toBe('-l')
    expect(ctx.tokens).toEqual(['FOO=bar', 'ls'])
  })

  it('只有环境变量赋值时仍在命令位置', () => {
    const ctx = parseCommandLine('FOO=bar ')
    expect(ctx.command).toBeNull()
    expect(ctx.atCommandPosition).toBe(true)
  })

  it('参数计数忽略选项', () => {
    const ctx = parseCommandLine('cp -r src dst ')
    expect(ctx.command).toBe('cp')
    expect(ctx.argIndex).toBe(2)
  })

  it('已输入的选项被收集（用于候选去重）', () => {
    const ctx = parseCommandLine('ls -l -a x')
    expect(ctx.usedOptions).toEqual(['-l', '-a'])
  })

  it('?? 前缀识别（AI 通道）', () => {
    expect(parseCommandLine('?? 怎么列目录').aiPrefix).toBe(true)
    expect(parseCommandLine('??').aiPrefix).toBe(true)
    expect(parseCommandLine('  ?? x').aiPrefix).toBe(true)
    expect(parseCommandLine('?x').aiPrefix).toBe(false)
    expect(parseCommandLine('echo ??').aiPrefix).toBe(false)
  })

  it('isEnvAssignment', () => {
    expect(isEnvAssignment('FOO=1')).toBe(true)
    expect(isEnvAssignment('_A=b')).toBe(true)
    expect(isEnvAssignment('1FOO=b')).toBe(false)
    expect(isEnvAssignment('ls')).toBe(false)
  })
})
