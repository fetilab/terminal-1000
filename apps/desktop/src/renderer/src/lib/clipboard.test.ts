// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 剪贴板入口的策略测试。
 *
 * 这里守的不是"能不能复制"，而是**回退顺序**：
 * 1. 一律先走主进程（唯一不受 document 焦点 / clipboard-read 权限限制的路径）；
 * 2. 只有 IPC 失败（单测、浏览器预览、主进程未注册该域）才回退 HTML API；
 * 3. 两路都失败时**不抛错**，返回空串/静默 —— 调用方在菜单里，抛出去只会变成
 *    一个没人处理的 rejection。
 */

import { describe, expect, it, vi, beforeEach } from 'vitest'

const invokeMock = vi.hoisted(() => vi.fn())

vi.mock('./ipc', () => ({ invoke: invokeMock }))

const { copyText, readClipboardText, readSelectionText, copyToSelection } = await import('./clipboard')

const navClipboard = {
  writeText: vi.fn(async () => undefined),
  readText: vi.fn(async () => 'NAV'),
}

beforeEach(() => {
  invokeMock.mockReset()
  navClipboard.writeText.mockClear()
  navClipboard.readText.mockClear()
  vi.stubGlobal('navigator', { clipboard: navClipboard })
})

describe('copyText', () => {
  it('走主进程，不碰 navigator', async () => {
    invokeMock.mockResolvedValue({ ok: true })
    await copyText('hello')
    expect(invokeMock).toHaveBeenCalledWith('clipboard', 'write', { text: 'hello' })
    expect(navClipboard.writeText).not.toHaveBeenCalled()
  })

  it('主进程失败时回退 HTML API', async () => {
    invokeMock.mockRejectedValue(new Error('no bridge'))
    await copyText('hello')
    expect(navClipboard.writeText).toHaveBeenCalledWith('hello')
  })

  it('空串直接返回（不写空内容盖掉用户剪贴板）', async () => {
    await copyText('')
    expect(invokeMock).not.toHaveBeenCalled()
    expect(navClipboard.writeText).not.toHaveBeenCalled()
  })
})

describe('readClipboardText', () => {
  it('优先主进程', async () => {
    invokeMock.mockResolvedValue({ text: 'ipc' })
    await expect(readClipboardText()).resolves.toBe('ipc')
    expect(navClipboard.readText).not.toHaveBeenCalled()
  })

  it('主进程不可用时回退 HTML API', async () => {
    invokeMock.mockRejectedValue(new Error('no bridge'))
    await expect(readClipboardText()).resolves.toBe('NAV')
  })

  it('两路都失败时返回空串而不是抛错', async () => {
    invokeMock.mockRejectedValue(new Error('no bridge'))
    navClipboard.readText.mockRejectedValueOnce(new Error('Document is not focused'))
    await expect(readClipboardText()).resolves.toBe('')
  })
})

describe('readSelectionText / copyToSelection', () => {
  it('读 PRIMARY 走 readSelection', async () => {
    invokeMock.mockResolvedValue({ text: 'sel' })
    await expect(readSelectionText()).resolves.toBe('sel')
    expect(invokeMock).toHaveBeenCalledWith('clipboard', 'readSelection', {})
  })

  it('读不到时返回空串', async () => {
    invokeMock.mockRejectedValue(new Error('no bridge'))
    await expect(readSelectionText()).resolves.toBe('')
  })

  it('写 PRIMARY 失败不抛错（selection 只是锦上添花）', async () => {
    invokeMock.mockRejectedValue(new Error('no bridge'))
    await expect(copyToSelection('x')).resolves.toBeUndefined()
  })
})
