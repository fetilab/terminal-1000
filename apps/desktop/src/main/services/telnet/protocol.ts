// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * Telnet 协议处理（RFC 854 / 855 / 857 / 1073 / 1091）。
 *
 * 纯逻辑、不依赖网络 —— 便于单测，也便于把"协商没谈拢"这类问题定位清楚。
 *
 * 核心是 IAC 状态机：把选项协商从数据流里剥掉，只把**真正的数据显示给用户**，
 * 同时按规则应答对端请求。若不处理，用户会在终端里看到 `^[ÿü^[ÿý...` 这类乱码。
 */

/** 命令字节 */
export const IAC = 255
export const DONT = 254
export const DO = 253
export const WONT = 252
export const WILL = 251
export const SB = 250
export const SE = 240

/** 我们支持/关切的选项 */
export const OPT = {
  BINARY: 0,
  ECHO: 1,
  SUPPRESS_GO_AHEAD: 3,
  STATUS: 5,
  TIMING_MARK: 6,
  TERMINAL_TYPE: 24,
  WINDOW_SIZE: 31,
  TERMINAL_SPEED: 32,
  REMOTE_FLOW_CONTROL: 33,
  LINEMODE: 34,
  ENVIRON: 36,
} as const

const OPTION_NAMES: Record<number, string> = {
  0: 'BINARY',
  1: 'ECHO',
  3: 'SUPPRESS-GO-AHEAD',
  5: 'STATUS',
  6: 'TIMING-MARK',
  24: 'TERMINAL-TYPE',
  31: 'NAWS(窗口大小)',
  32: 'TERMINAL-SPEED',
  33: 'REMOTE-FLOW-CONTROL',
  34: 'LINEMODE',
  36: 'ENVIRON',
}

export function optionName(code: number): string {
  return OPTION_NAMES[code] ?? `OPTION-${code}`
}

/** 子协商：终端类型 */
const TTYPE_IS = 0
const TTYPE_SEND = 1

export interface NegotiationEvent {
  option: number
  optionName: string
  direction: 'local' | 'remote'
  accepted: boolean
  detail?: string
}

export interface TelnetProtocolOptions {
  /** 上报的终端类型（对端问 TTYPE 时回答） */
  terminalType?: string
  /** 初始窗口大小；对端请求 NAWS 时上报，之后可用 setWindowSize 更新 */
  cols?: number
  rows?: number
  /** 协商事件回调（诊断用） */
  onNegotiation?: (event: NegotiationEvent) => void
}

/** 状态机的阶段 */
type Phase = 'data' | 'iac' | 'negotiate' | 'sbOption' | 'sbData' | 'sbIac'

/**
 * Telnet 协议处理器。
 *
 * 策略说明（决定了它与各种服务端的兼容性）：
 * - **只接受少数必要选项**：SGA（提升交互感）、TTYPE（对端要知道终端类型）、NAWS（窗口大小）
 * - ECHO 让**对端**回显（绝大多数服务端/网络设备都这么做）；
 *   若我们自己回显会与对端重复显示
 * - 其它一律拒绝（WONT/DONT）—— Telnet 选项成百上千，全接受会引入一堆未实现的语义
 */
export class TelnetProtocol {
  private phase: Phase = 'data'
  private pendingCommand = 0
  private pendingOption = 0
  private sbBuffer: number[] = []

  private cols: number
  private rows: number
  private readonly terminalType: string

  /** 已生效的选项集合 */
  private readonly localEnabled = new Set<number>()
  private readonly remoteEnabled = new Set<number>()

  /** 协商事件累积（供测试与诊断读取） */
  readonly negotiations: NegotiationEvent[] = []

  /** 需要发回的应答字节（由调用方取出并写入 socket） */
  private outbox: number[] = []

  constructor(private readonly options: TelnetProtocolOptions = {}) {
    this.terminalType = options.terminalType ?? 'xterm-256color'
    this.cols = options.cols ?? 80
    this.rows = options.rows ?? 24
  }

  /** 取走待发送的应答字节 */
  drainOutbox(): Buffer {
    const buf = Buffer.from(this.outbox)
    this.outbox = []
    return buf
  }

  /**
   * 更新窗口大小。
   *
   * NAWS 是「对端要求**我们**上报尺寸」（对端发 DO NAWS，我们回 WILL 并发送），
   * 所以门控条件是 **localEnabled** 而不是 remoteEnabled —— 后者表示"对端自己会做这件事"。
   * 搞反会导致尺寸永远不上报，服务端一直按 80x24 排版。
   */
  setWindowSize(cols: number, rows: number): Buffer {
    this.cols = cols
    this.rows = rows
    if (this.localEnabled.has(OPT.WINDOW_SIZE)) {
      // buildWindowSize 产出的是字节数组（便于直接拼进 outbox），这里转成 Buffer 交给调用方写 socket
      return Buffer.from(this.buildWindowSize())
    }
    return Buffer.alloc(0)
  }

  /**
   * 处理一段来自服务端的字节，返回**应当显示给用户的数据**。
   * 协商字节被剥离，不会污染终端显示。
   */
  process(input: Buffer): Buffer {
    const out: number[] = []

    for (const byte of input) {
      switch (this.phase) {
        case 'data':
          if (byte === IAC) this.phase = 'iac'
          else out.push(byte)
          break

        case 'iac':
          if (byte === IAC) {
            // 转义的 0xFF，表示字面量 0xFF
            out.push(IAC)
            this.phase = 'data'
          } else if (byte === WILL || byte === WONT || byte === DO || byte === DONT) {
            this.pendingCommand = byte
            this.phase = 'negotiate'
          } else if (byte === SB) {
            this.sbBuffer = []
            this.phase = 'sbOption'
          } else {
            // 其它两字节命令（GA/NOP 等）：忽略但回到数据态
            this.phase = 'data'
          }
          break

        case 'negotiate': {
          this.handleNegotiation(this.pendingCommand, byte)
          this.phase = 'data'
          break
        }

        case 'sbOption':
          this.pendingOption = byte
          this.sbBuffer = []
          this.phase = 'sbData'
          break

        case 'sbData':
          if (byte === IAC) this.phase = 'sbIac'
          else this.sbBuffer.push(byte)
          break

        case 'sbIac':
          if (byte === SE) {
            this.handleSubnegotiation(this.pendingOption, this.sbBuffer)
            this.phase = 'data'
          } else if (byte === IAC) {
            this.sbBuffer.push(IAC)
            this.phase = 'sbData'
          } else {
            this.sbBuffer.push(byte)
            this.phase = 'sbData'
          }
          break
      }
    }

    return Buffer.from(out)
  }

  /** 处理 WILL/WONT/DO/DONT */
  private handleNegotiation(command: number, option: number): void {
    if (command === WILL) {
      // 对端愿意启用某选项 —— 我们只接受确实用得上的
      const accept = option === OPT.SUPPRESS_GO_AHEAD || option === OPT.ECHO || option === OPT.BINARY
      if (accept) {
        this.remoteEnabled.add(option)
        this.outbox.push(IAC, DO, option)
      } else {
        this.outbox.push(IAC, DONT, option)
      }
      this.record(option, 'remote', accept)
      return
    }

    if (command === WONT) {
      this.remoteEnabled.delete(option)
      this.record(option, 'remote', false, '对端拒绝')
      return
    }

    if (command === DO) {
      // 对端要求我们启用某选项
      if (option === OPT.TERMINAL_TYPE || option === OPT.WINDOW_SIZE) {
        this.localEnabled.add(option)
        this.outbox.push(IAC, WILL, option)
        // NAWS 启用后立刻上报当前尺寸，否则对端按 80x24 排版
        if (option === OPT.WINDOW_SIZE) {
          this.outbox.push(...this.buildWindowSize())
        }
      } else if (option === OPT.SUPPRESS_GO_AHEAD || option === OPT.BINARY) {
        this.localEnabled.add(option)
        this.outbox.push(IAC, WILL, option)
      } else {
        this.outbox.push(IAC, WONT, option)
      }
      this.record(option, 'local', this.localEnabled.has(option))
      return
    }

    if (command === DONT) {
      this.localEnabled.delete(option)
      this.record(option, 'local', false, '对端禁止')
    }
  }

  /** 处理子协商（目前只做 TTYPE 应答；NAWS 是单向上报，无需应答） */
  private handleSubnegotiation(option: number, payload: number[]): void {
    if (option === OPT.TERMINAL_TYPE && payload[0] === TTYPE_SEND) {
      const name = Buffer.from(this.terminalType, 'ascii')
      this.outbox.push(IAC, SB, OPT.TERMINAL_TYPE, TTYPE_IS, ...name, IAC, SE)
      this.record(option, 'local', true, `上报终端类型 ${this.terminalType}`)
      return
    }
    this.record(option, 'local', false, '未处理的子协商')
  }

  private buildWindowSize(): number[] {
    // NAWS 载荷是 16 位大端，且数值 255 必须转义为 IAC IAC
    const escape = (n: number): number[] => {
      const hi = (n >> 8) & 0xff
      const lo = n & 0xff
      const enc = (b: number): number[] => (b === IAC ? [IAC, IAC] : [b])
      return [...enc(hi), ...enc(lo)]
    }
    return [IAC, SB, OPT.WINDOW_SIZE, ...escape(this.cols), ...escape(this.rows), IAC, SE]
  }

  private record(option: number, direction: 'local' | 'remote', accepted: boolean, detail?: string): void {
    const event: NegotiationEvent = {
      option,
      optionName: optionName(option),
      direction,
      accepted,
      ...(detail !== undefined ? { detail } : {}),
    }
    this.negotiations.push(event)
    this.options.onNegotiation?.(event)
  }

  /** 当前已启用的选项（测试与诊断） */
  state(): { local: number[]; remote: number[] } {
    return { local: [...this.localEnabled], remote: [...this.remoteEnabled] }
  }
}

// ── 按键映射 ─────────────────────────────────────────

export interface KeyMappingRule {
  from: string
  /** 要发送的实际字节（支持 \r \n \x1b 等转义） */
  to: string
}

/**
 * 解释按键映射里的转义序列。
 * 用户在配置里写 `\x1b[A` 这种是常见需求（网络设备的自定义键）。
 */
export function unescapeKeys(raw: string): Buffer {
  const out: number[] = []
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!
    if (ch !== '\\') {
      out.push(...Buffer.from(ch, 'utf8'))
      continue
    }
    const next = raw[i + 1]
    if (next === undefined) {
      out.push(0x5c)
      break
    }
    i += 1
    switch (next) {
      case 'n':
        out.push(0x0a)
        break
      case 'r':
        out.push(0x0d)
        break
      case 't':
        out.push(0x09)
        break
      case 'e':
      case 'x':
        if (next === 'e') {
          out.push(0x1b)
          break
        }
        // \xHH
        {
          const hex = raw.slice(i + 1, i + 3)
          if (/^[0-9a-fA-F]{2}$/.test(hex)) {
            out.push(parseInt(hex, 16))
            i += 2
          } else {
            out.push(0x78)
          }
        }
        break
      case '\\':
        out.push(0x5c)
        break
      default:
        out.push(...Buffer.from(next, 'utf8'))
    }
  }
  return Buffer.from(out)
}

/**
 * 应用按键映射。
 *
 * 语义：把用户按下的**字面字符串**替换为映射后的字节。
 * 例如网络设备把 Backspace 认成 `\x7f`，用户配 `{from:'\x08', to:'\x7f'}`。
 * 映射按顺序应用，先匹配先替换。
 */
export function applyKeyMapping(input: string, rules: readonly KeyMappingRule[] | undefined): Buffer {
  if (!rules || rules.length === 0) return Buffer.from(input, 'utf8')

  let result = input
  for (const rule of rules) {
    if (!rule.from) continue
    if (result.includes(rule.from)) {
      result = result.split(rule.from).join(rule.to)
    }
  }
  return unescapeKeys(result)
}
