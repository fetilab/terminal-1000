// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * Telnet 协议状态机测试。
 *
 * 这是纯逻辑（不碰网络），也是最容易出错的部分：
 * 协商没处理对，用户终端里就会出现 `^[ÿû` 乱码，或者"连上了但键盘没反应"。
 */

import { describe, expect, it } from 'vitest'
import { DO, DONT, IAC, OPT, SB, SE, WILL, WONT, applyKeyMapping, unescapeKeys, TelnetProtocol } from './protocol'

/** 便捷构造 */
const bytes = (...b: number[]): Buffer => Buffer.from(b)

/**
 * 从字节流里解出 NAWS 子协商的 (cols, rows)。
 * 直接按下标切片太容易错位（IAC 转义会改变长度），这里按协议正经解析：
 * 找 `IAC SB 31 ... IAC SE`，中间的载荷把 `IAC IAC` 还原成单个 0xFF。
 */
function decodeNaws(out: number[]): { cols: number; rows: number } | undefined {
  const start = out.findIndex((b, i) => b === IAC && out[i + 1] === SB && out[i + 2] === OPT.WINDOW_SIZE)
  if (start === -1) return undefined

  const payload: number[] = []
  for (let i = start + 3; i < out.length; i++) {
    if (out[i] === IAC) {
      if (out[i + 1] === IAC) {
        payload.push(IAC)
        i += 1
        continue
      }
      break // IAC SE 结束
    }
    payload.push(out[i]!)
  }
  if (payload.length < 4) return undefined
  return {
    cols: (payload[0]! << 8) | payload[1]!,
    rows: (payload[2]! << 8) | payload[3]!,
  }
}

describe('数据透传与 IAC 转义', () => {
  it('普通数据原样透出', () => {
    const p = new TelnetProtocol()
    expect(p.process(Buffer.from('hello\r\n')).toString()).toBe('hello\r\n')
  })

  it('★ 协商字节不会污染终端显示', () => {
    const p = new TelnetProtocol()
    const out = p.process(bytes(IAC, WILL, OPT.ECHO, 0x61, 0x62))
    // 只有 'ab' 是数据，协商被吃掉
    expect(out.toString()).toBe('ab')
  })

  it('转义的 0xFF（IAC IAC）还原成单个 0xFF', () => {
    const p = new TelnetProtocol()
    const out = p.process(bytes(0x41, IAC, IAC, 0x42))
    expect([...out]).toEqual([0x41, 0xff, 0x42])
  })

  it('跨 chunk 截断的协商序列也能正确处理（状态跨调用保持）', () => {
    const p = new TelnetProtocol()
    expect(p.process(bytes(IAC)).length).toBe(0)
    expect(p.process(bytes(WILL)).length).toBe(0)
    expect(p.process(bytes(OPT.ECHO)).length).toBe(0)
    expect(p.process(Buffer.from('x')).toString()).toBe('x')
  })
})

describe('选项协商', () => {
  it('接受对端的 WILL ECHO / SGA（回 DO）', () => {
    const p = new TelnetProtocol()
    p.process(bytes(IAC, WILL, OPT.ECHO))
    expect([...p.drainOutbox()]).toEqual([IAC, DO, OPT.ECHO])

    p.process(bytes(IAC, WILL, OPT.SUPPRESS_GO_AHEAD))
    expect([...p.drainOutbox()]).toEqual([IAC, DO, OPT.SUPPRESS_GO_AHEAD])
  })

  it('★ 拒绝用不上的选项（回 DONT），避免引入未实现的语义', () => {
    const p = new TelnetProtocol()
    p.process(bytes(IAC, WILL, OPT.ENVIRON))
    expect([...p.drainOutbox()]).toEqual([IAC, DONT, OPT.ENVIRON])
  })

  it('对端 DO 终端类型时接受并回 WILL', () => {
    const p = new TelnetProtocol()
    p.process(bytes(IAC, DO, OPT.TERMINAL_TYPE))
    expect([...p.drainOutbox()]).toEqual([IAC, WILL, OPT.TERMINAL_TYPE])
  })

  it('对端 DO 未知选项时回 WONT', () => {
    const p = new TelnetProtocol()
    p.process(bytes(IAC, DO, OPT.REMOTE_FLOW_CONTROL))
    expect([...p.drainOutbox()]).toEqual([IAC, WONT, OPT.REMOTE_FLOW_CONTROL])
  })

  it('已拒绝的选项保留在对端状态里不重复协商（WONT 清态）', () => {
    const p = new TelnetProtocol()
    p.process(bytes(IAC, WILL, OPT.ENVIRON)) // 我们回 DONT
    p.drainOutbox()
    p.process(bytes(IAC, WONT, OPT.ENVIRON))
    expect(p.state().remote).not.toContain(OPT.ENVIRON)
  })

  it('协商事件被记录（供诊断"连上但键盘没反应"）', () => {
    const events: Array<{ optionName: string; accepted: boolean; direction: string }> = []
    const p = new TelnetProtocol({ onNegotiation: (e) => events.push(e) })

    p.process(bytes(IAC, WILL, OPT.ECHO))
    p.process(bytes(IAC, WILL, OPT.ENVIRON))

    expect(events).toHaveLength(2)
    expect(events[0]).toMatchObject({ optionName: 'ECHO', accepted: true, direction: 'remote' })
    expect(events[1]).toMatchObject({ optionName: 'ENVIRON', accepted: false, direction: 'remote' })
  })
})

describe('子协商', () => {
  it('★ 对端请求终端类型时上报配置的类型', () => {
    const p = new TelnetProtocol({ terminalType: 'xterm-256color' })
    p.process(bytes(IAC, SB, OPT.TERMINAL_TYPE, 1, IAC, SE))

    const out = [...p.drainOutbox()]
    expect(out.slice(0, 4)).toEqual([IAC, SB, OPT.TERMINAL_TYPE, 0])
    const nameEnd = out.indexOf(IAC, 4)
    expect(Buffer.from(out.slice(4, nameEnd)).toString()).toBe('xterm-256color')
    expect(out.slice(nameEnd)).toEqual([IAC, SE])
  })

  it('未知子协商被忽略且不破坏后续数据', () => {
    const p = new TelnetProtocol()
    p.process(bytes(IAC, SB, OPT.STATUS, 1, 2, 3, IAC, SE))
    expect(p.process(Buffer.from('ok')).toString()).toBe('ok')
  })
})

describe('窗口大小（NAWS）', () => {
  it('对端启用 NAWS 后立即上报当前尺寸', () => {
    const p = new TelnetProtocol({ cols: 100, rows: 30 })
    p.process(bytes(IAC, DO, OPT.WINDOW_SIZE))
    const out = [...p.drainOutbox()]

    // WILL WINDOW_SIZE 之后紧跟 NAWS 子协商
    expect(out.slice(0, 3)).toEqual([IAC, WILL, OPT.WINDOW_SIZE])
    expect(decodeNaws(out)).toEqual({ cols: 100, rows: 30 })
  })

  it('★ 尺寸含 255 时按协议转义为 IAC IAC', () => {
    const p = new TelnetProtocol({ cols: 255, rows: 24 })
    p.process(bytes(IAC, DO, OPT.WINDOW_SIZE))
    const out = [...p.drainOutbox()]

    // cols=255 → hi=0x00, lo=0xFF → 0xFF 必须转义成 IAC IAC。
    // 若不转义，接收端会把裸 0xFF 当成 IAC，后续解析全乱。
    expect(decodeNaws(out)).toEqual({ cols: 255, rows: 24 })
    // 同时确认转义确实发生了（原始字节里出现连续的 IAC IAC）
    expect(out.join(',')).toContain(`${IAC},${IAC}`)
  })

  it('对端未启用 NAWS 时 setWindowSize 不产生流量', () => {
    const p = new TelnetProtocol()
    expect(p.setWindowSize(120, 40).length).toBe(0)
  })

  it('启用后 setWindowSize 会生成上报', () => {
    const p = new TelnetProtocol({ cols: 80, rows: 24 })
    p.process(bytes(IAC, DO, OPT.WINDOW_SIZE))
    p.drainOutbox()

    const out = [...p.setWindowSize(120, 40)]
    expect(out.length).toBeGreaterThan(0)
    expect(decodeNaws(out)).toEqual({ cols: 120, rows: 40 })
  })
})

describe('unescapeKeys', () => {
  it('解释常见转义', () => {
    expect([...unescapeKeys('\\r\\n')]).toEqual([0x0d, 0x0a])
    expect([...unescapeKeys('\\t')]).toEqual([0x09])
    expect([...unescapeKeys('\\e')]).toEqual([0x1b])
    expect([...unescapeKeys('\\\\')]).toEqual([0x5c])
  })

  it('解释十六进制转义', () => {
    expect([...unescapeKeys('\\x7f')]).toEqual([0x7f])
    expect([...unescapeKeys('\\x1bOA')]).toEqual([0x1b, 0x4f, 0x41])
  })

  it('普通字符按 UTF-8 编码', () => {
    expect([...unescapeKeys('中')]).toEqual([...Buffer.from('中', 'utf8')])
  })

  it('非法十六进制退化为字面 x', () => {
    expect([...unescapeKeys('\\xZZ')]).toEqual([...Buffer.from('xZZ')])
  })

  it('结尾孤立反斜杠不丢字符', () => {
    expect([...unescapeKeys('ab\\')]).toEqual([0x61, 0x62, 0x5c])
  })
})

describe('applyKeyMapping', () => {
  it('无规则时原样 UTF-8 编码', () => {
    expect(applyKeyMapping('ls\r', undefined).toString()).toBe('ls\r')
    expect(applyKeyMapping('ls\r', []).toString()).toBe('ls\r')
  })

  it('★ 按规则替换（网络设备键位适配的典型用法）', () => {
    // Backspace(0x08) → DEL(0x7f)
    const out = applyKeyMapping('\b', [{ from: '\b', to: '\\x7f' }])
    expect([...out]).toEqual([0x7f])
  })

  it('替换所有出现处，而不只是第一处', () => {
    const out = applyKeyMapping('a\ba\b', [{ from: '\b', to: '\\x7f' }])
    expect([...out]).toEqual([0x61, 0x7f, 0x61, 0x7f])
  })

  it('方向键转 VT100 序列', () => {
    const rules = [{ from: '\u001b[A', to: '\\x1bOA' }]
    expect([...applyKeyMapping('\u001b[A', rules)]).toEqual([0x1b, 0x4f, 0x41])
  })

  it('from 为空的规则被跳过（不产生无限替换）', () => {
    const out = applyKeyMapping('ab', [{ from: '', to: 'X' }])
    expect(out.toString()).toBe('ab')
  })
})
