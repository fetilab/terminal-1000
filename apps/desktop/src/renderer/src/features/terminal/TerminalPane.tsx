// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 终端窗格：xterm 集成 + 背压。
 *
 * ## 背压为什么必须自己做
 * PTY 的产出速度可以远超渲染层消费速度（`yes` 打满 CPU 时轻松 10MB/s+）。
 * 如果每条 SSH_DATA 都直接 `term.write()`，xterm 内部队列会无限膨胀，
 * 最终表现为输入卡死、内存暴涨。正确做法是**用 write 的回调串行化**：
 * 一次只允许一个未完成的 write，完成后再把期间积压的数据合并成一批写下去。
 *
 * 这样还有第二个好处：积压的多个小 chunk 会被合并成一次大 write，
 * xterm 的解析器按批处理，吞吐显著高于逐条写入。
 *
 * ## xterm 懒加载
 * `@xterm/xterm` 与四个 addon（fit / search / weblinks / unicode11）都用动态 import，
 * 只有真正打开终端时才加载，满足「Monaco / xterm 懒加载，未打开相关面板不加载」的性能要求。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import '@xterm/xterm/css/xterm.css'
import type { Terminal } from '@xterm/xterm'
import type { FitAddon } from '@xterm/addon-fit'
import type { SearchAddon } from '@xterm/addon-search'
import type { Unicode11Addon } from '@xterm/addon-unicode11'
import { Events, type PublicProvider } from '@t1000/shared'
import { Icon } from '../../components/Icon'
import { Badge } from '../../components/Feedback'
import { IconButton } from '../../components/Button'
import { invoke, subscribe } from '../../lib/ipc'
import type { TabKind } from '../../lib/store'
import {
  actions,
  broadcastGroupOf,
  closeTab,
  connectTo,
  getConnection,
  setTabLayout,
  setSessionCwd,
  loadSessionLogs,
  sendBroadcast,
  recordingOf,
  startSessionLog,
  stopSessionLog,
  useStoreShallow,
  type TerminalTab,
} from '../../lib/store'
import { ContextMenu, type ContextMenuItem } from '../../components/ContextMenu'
import { toast } from '../../components/Toast'
import { errorText } from '../../lib/format'
import {
  LineTracker,
  applyCandidate,
  type CompletionCandidate,
  type CompletionResult,
} from './completion'
import { CompletionPopup } from './CompletionPopup'
import { cellsFor, normalizeHexColor, segmentHighlightStyle, segmentText } from './highlights'
import './terminal.css'
import './completion.css'

/** 积压上限：超过就丢弃并在终端里明确告知，绝不无声无息地胀内存 */
const MAX_BUFFER_CHARS = 4 * 1024 * 1024

/**
 * 字体栈的 emoji 回退。
 *
 * 终端主字体（JetBrains Mono 等编程字体）没有 emoji 字形，没有回退就会画豆腐块（□）。
 * 只负责"把字形画出来"；emoji 占几格由 unicode11 插件的宽度表决定——两者缺一不可。
 * 用户字体栈里已含 emoji 字体时不重复追加。
 */
const EMOJI_FALLBACK_FONTS = '"Noto Color Emoji", "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol"'
const withEmojiFallback = (fontFamily: string): string =>
  /emoji/i.test(fontFamily) ? fontFamily : `${fontFamily}, ${EMOJI_FALLBACK_FONTS}`

/**
 * 带背压的写入器。
 *
 * 状态机很简单：`writing=false` 时把队列整体合并成一次 write，
 * 写入回调返回前不再发起新的 write —— 这就是背压的全部。
 */
class BackpressureWriter {
  private term: Terminal | null = null
  private queue: string[] = []
  private buffered = 0
  private writing = false
  private dropped = 0

  attach(term: Terminal): void {
    this.term = term
    this.drain()
  }

  detach(): void {
    this.term = null
    this.queue = []
    this.buffered = 0
    this.writing = false
  }

  /** 累计被丢弃的字符数，供状态栏展示 */
  get droppedChars(): number {
    return this.dropped
  }

  get pendingChars(): number {
    return this.buffered
  }

  push(data: string): void {
    if (data.length === 0) return
    this.buffered += data.length
    if (this.buffered > MAX_BUFFER_CHARS) {
      this.dropped += this.buffered
      this.queue = []
      this.buffered = 0
      this.queue.push(
        '\r\n\x1b[33m[输出过快，渲染层已丢弃积压内容以保持可交互]\x1b[0m\r\n',
      )
    } else {
      this.queue.push(data)
    }
    this.drain()
  }

  private drain(): void {
    const term = this.term
    if (!term || this.writing || this.queue.length === 0) return
    // 合并：把当前所有积压一次性交给 xterm，减少解析器调用次数
    const batch = this.queue.join('')
    this.queue = []
    this.buffered = 0
    this.writing = true
    term.write(batch, () => {
      this.writing = false
      this.drain()
    })
  }
}


/**
 * 终端 → 会话的载荷。
 *
 * ⚠️ 域的字段名**不一样**：ssh / telnet 用 `sessionId`，pty 用 `ptyId`。
 * 之前这里统一发 `sessionId`，导致本地终端每次按键都被 zod 校验拒绝、
 * 又被 catch 吞掉 —— 表现是"终端能显示、但打字没反应"，
 * 而且录制出来是 0 字节（shell 根本没收到输入）。
 */
function sessionPayload(
  kind: TabKind,
  sessionId: string,
  extra: Record<string, unknown>,
): Record<string, unknown> {
  // 只有本地终端用 ptyId；其余域（ssh/telnet，以及不会走到这里的 vnc/rdp/tunnel）都用 sessionId
  return kind === 'local' ? { ptyId: sessionId, ...extra } : { sessionId, ...extra }
}


/**
 * 从剪贴板粘贴到终端。
 *
 * 读剪贴板可能因为权限被拒 —— **不能静默什么都不做**，
 * 那会让用户以为"右键/快捷键坏了"（跟之前 pty 载荷被空 catch 吞掉是同一类坑）。
 */
function pasteFromClipboard(target: Terminal | null): void {
  void navigator.clipboard
    .readText()
    .then((text) => {
      if (text) target?.paste(text)
      else toast.info('剪贴板是空的，没有可粘贴的内容')
    })
    .catch(() => toast.warn('读取剪贴板失败：系统可能未授予剪贴板权限'))
}

const TERMINAL_THEME = {
  background: '#0d0f14',
  foreground: '#e4e7ee',
  cursor: '#3ec9d6',
  cursorAccent: '#0d0f14',
  selectionBackground: 'rgba(62, 201, 214, 0.28)',
  black: '#1e222b',
  red: '#e5484d',
  green: '#46b17b',
  yellow: '#d9a441',
  blue: '#6f8dff',
  magenta: '#b48ce0',
  cyan: '#3ec9d6',
  white: '#c6ccd8',
  brightBlack: '#4c5361',
  brightRed: '#ff6b6f',
  brightGreen: '#63d29a',
  brightYellow: '#f0c065',
  brightBlue: '#8fa6ff',
  brightMagenta: '#cfa8f0',
  brightCyan: '#63dde8',
  brightWhite: '#f2f4f8',
} as const

/** 高对比配色：给弱视/强光环境用，前景纯白、背景近黑 */
const TERMINAL_THEME_HC = {
  ...TERMINAL_THEME,
  background: '#000000',
  foreground: '#ffffff',
  cursor: '#ffff00',
  selectionBackground: 'rgba(255, 255, 0, 0.32)',
  brightBlack: '#8a8a8a',
} as const

/**
 * 选配色。
 *
 * 语义：`default-dark` 是"跟随应用主题"（应用切浅色时终端也跟着浅），
 * 另外两套是**显式覆盖** —— 用户既然挑了就照他挑的来。
 */
/**
 * 解析 OSC 7 载荷：`file://hostname/path`（也容忍 `file:///path`）。
 * 返回解码后的路径；无法解析返回 null。
 */
function parseOsc7(data: string): string | null {
  const raw = data.trim()
  const withoutScheme = raw.startsWith('file://') ? raw.slice('file://'.length) : raw
  // 跳过 host 部分：第一个 `/` 之后才是路径
  const slash = withoutScheme.indexOf('/')
  if (slash < 0) return null
  const path = withoutScheme.slice(slash)
  try {
    return decodeURIComponent(path) || null
  } catch {
    return path || null
  }
}

function themeFor(colorScheme: string, resolved: 'light' | 'dark'): import('@xterm/xterm').ITheme {
  if (colorScheme === 'light') return TERMINAL_THEME_LIGHT
  if (colorScheme === 'high-contrast') return TERMINAL_THEME_HC
  return resolved === 'light' ? TERMINAL_THEME_LIGHT : TERMINAL_THEME
}

/** 浅色下的终端配色：底色与整体主题一致，前景用深色保证对比度 */
const TERMINAL_THEME_LIGHT = {
  ...TERMINAL_THEME,
  background: '#fbfcfe',
  foreground: '#1b2029',
  cursor: '#12909e',
  cursorAccent: '#fbfcfe',
  selectionBackground: 'rgba(18, 144, 158, 0.24)',
} as const

export interface TerminalPaneProps {
  tab: TerminalTab
  /** 该窗格当前是否可见（不可见的窗格只保留状态，不渲染尺寸） */
  visible: boolean
}

export function TerminalPane({ tab, visible }: TerminalPaneProps): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const searchRef = useRef<SearchAddon | null>(null)
  const writerRef = useRef<BackpressureWriter>(new BackpressureWriter())
  const tabRef = useRef(tab)
  tabRef.current = tab

  const [ready, setReady] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [findOpen, setFindOpen] = useState(false)
  /** 右键菜单位置；null 表示关闭 */
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const [findText, setFindText] = useState('')
  const [dims, setDims] = useState<{ cols: number; rows: number } | null>(null)

  /* ── 补全 ── */
  const trackerRef = useRef(new LineTracker())
  /** 已执行的命令行（回车提交的），作为历史补全的数据源 */
  const historyRef = useRef<string[]>([])
  const [completion, setCompletion] = useState<CompletionResult | null>(null)
  const [selected, setSelected] = useState(0)
  const completionSeq = useRef(0)
  /** 写入失败只提示一次 */
  const writeWarnedRef = useRef(false)
  const debounceTimer = useRef<number | undefined>(undefined)
  /** 防抖时长来自主进程返回的 debounceMs，不硬编码 */
  const debounceMsRef = useRef(80)

  // 首次可见前不创建 xterm：隐藏容器尺寸为 0，此时 open() 会得到畸形布局
  const resolvedTheme = useStoreShallow((s) => ({ resolvedTheme: s.resolvedTheme })).resolvedTheme
  const sessionCwd = useStoreShallow((s) => ({
    v: tab.sessionId ? s.sessionCwd[tab.sessionId] : undefined,
  })).v
  // 终端外观/行为设置：从 store 读，改动即时热更新到已打开的 xterm
  const termCfg = useStoreShallow((s) => ({ t: s.terminalSettings })).t
  // 斑马纹是正式设置项（shared TerminalSettings.zebraStripes），随热更新生效
  const toolbarVisible = useStoreShallow((s) => ({ v: s.toolbarVisible })).v
  const zebra = termCfg.zebraStripes
  /** 只有 DOM 渲染器才有逐行 DOM；canvas/webgl 下这个开关无效，要如实说明 */
  const [zebraSupported, setZebraSupported] = useState(true)
  /** WebLinksAddon 的构造器：热更新时要用它重新挂载 */
  const linksCtorRef = useRef<typeof import('@xterm/addon-web-links').WebLinksAddon | null>(null)
  const linksAddonRef = useRef<import('@xterm/addon-web-links').WebLinksAddon | null>(null)
  /** 创建与事件回调里要读最新设置，但那些闭包不该因为设置变化而重建 */
  const sessionIdRef = useRef(tab.sessionId)
  sessionIdRef.current = tab.sessionId
  // 高亮规则：从 store 读，改规则即时生效（已打印的行不回溯）
  const highlightRules = useStoreShallow((s) => ({ r: s.highlightRules })).r
  const highlightRulesRef = useRef(highlightRules)
  highlightRulesRef.current = highlightRules
  const termSettingsRef = useRef(termCfg)
  termSettingsRef.current = termCfg
  const resolvedThemeRef = useRef(resolvedTheme)
  resolvedThemeRef.current = resolvedTheme
  // 录制状态来自全局 store（低频），终端标签/状态栏据此显示红点
  const recording = useStoreShallow((s) => ({
    rec: s.activeRecordings.find((r) => r.sessionId === tab.sessionId),
  })).rec
  const negotiations = useStoreShallow((s) => ({
    list: tab.sessionId ? s.negotiations[tab.sessionId] : undefined,
  })).list
  const [negOpen, setNegOpen] = useState(false)
  const [everVisible, setEverVisible] = useState(visible)
  useEffect(() => {
    if (visible) setEverVisible(true)
  }, [visible])

  /* ── 补全 ─────────────────────────────────────── */

  const closeCompletion = useCallback(() => {
    window.clearTimeout(debounceTimer.current)
    completionSeq.current += 1 // 让在途请求的结果作废
    setCompletion(null)
    setSelected(0)
  }, [])

  const requestCompletion = useCallback(async () => {
    const tab = tabRef.current
    if (!tab.sessionId) return
    const tracker = trackerRef.current
    const line = tracker.line
    // 本地跟踪不可靠（出现过方向键等）或行为空时不弹
    if (!tracker.isReliable || line.trim().length === 0) {
      setCompletion(null)
      return
    }
    const seq = ++completionSeq.current
    try {
      const res = await invoke<'completion', 'complete', Record<string, unknown>, CompletionResult>(
        'completion',
        'complete',
        {
          line,
          cursor: tracker.cursor,
          history: historyRef.current.slice(-200),
        },
      )
      // 丢弃过期响应：快速输入时先发的可能后到
      if (seq !== completionSeq.current) return
      debounceMsRef.current = res.debounceMs ?? debounceMsRef.current
      if (!res.candidates || res.candidates.length === 0) {
        setCompletion(null)
        return
      }
      setCompletion(res)
      setSelected(0)
    } catch {
      // 补全服务不可用不该打断输入
      if (seq === completionSeq.current) setCompletion(null)
    }
  }, [])

  const scheduleCompletion = useCallback(() => {
    window.clearTimeout(debounceTimer.current)
    debounceTimer.current = window.setTimeout(() => void requestCompletion(), debounceMsRef.current)
  }, [requestCompletion])

  const acceptCandidate = useCallback(
    (index: number) => {
      const res = completion
      const candidate: CompletionCandidate | undefined = res?.candidates[index]
      const tab = tabRef.current
      if (!res || !candidate || !tab.sessionId) return
      const applied = applyCandidate(trackerRef.current.line, res.context, candidate)
      // 本地跟踪缓冲与实际命令行对齐，否则下一次补全会基于旧的 token 计算
      trackerRef.current.reset()
      trackerRef.current.consume(applied.line)
      closeCompletion()
      const domain = tab.kind === 'ssh' ? 'ssh' : 'pty'
      void invoke(domain, 'write', sessionPayload(tab.kind, tab.sessionId, { data: applied.payload })).catch(
        () => undefined,
      )
    },
    [completion, closeCompletion],
  )

  /* ── 创建终端 ─────────────────────────────────── */
  useEffect(() => {
    if (!everVisible) return
    const host = hostRef.current
    if (!host) return
    let disposed = false
    const cleanups: Array<() => void> = []
    const writer = writerRef.current

    void (async () => {
      try {
        const [
          { Terminal: XTerm },
          { FitAddon: Fit },
          { SearchAddon: Search },
          { WebLinksAddon: Links },
          { Unicode11Addon: Unicode11 },
        ] = await Promise.all([
          import('@xterm/xterm'),
          import('@xterm/addon-fit'),
          import('@xterm/addon-search'),
          import('@xterm/addon-web-links'),
          import('@xterm/addon-unicode11'),
        ])
        if (disposed) return

        // 初值全部来自 settings.terminal（不再是硬编码），随后的改动由热更新 effect 负责
        const st = termSettingsRef.current
        const term = new XTerm({
          fontFamily: withEmojiFallback(st.fontFamily),
          fontSize: st.fontSize,
          lineHeight: st.lineHeight,
          letterSpacing: st.letterSpacing,
          cursorBlink: st.cursorBlink,
          cursorStyle: st.cursorStyle,
          scrollback: st.scrollback,
          allowProposedApi: true,
          convertEol: false,
          macOptionIsMeta: true,
          theme: themeFor(st.colorScheme, resolvedThemeRef.current),
        })
        const fit = new Fit()
        const search = new Search()
        // unicode11：Unicode 11 宽字符规则。必须在任何数据写入前加载——
        // oh-my-zsh 主题的 emoji/图标宽度由它决定，缺了它 emoji 按窄字符排，
        // 提示符从第一个 emoji 起整体错位（彩色块散落）。
        // ⚠️ loadAddon 只**注册** provider（register 不改 activeVersion），
        // 不显式切换的话 xterm 仍用内置 Unicode 6 表 —— 实测 ✅/⚡ 等仍按 1 格排。
        term.loadAddon(new Unicode11())
        term.unicode.activeVersion = '11'
        term.loadAddon(fit)
        term.loadAddon(search)
        // 链接点击交给主进程用系统浏览器打开（app.openExternal 内置协议白名单校验），
        // 避免渲染层自己 window.open 出一个裸的 Electron 窗口。
        linksCtorRef.current = Links
        const makeLinks = (): import('@xterm/addon-web-links').WebLinksAddon =>
          new Links((event, uri) => {
            event.preventDefault()
            void invoke<'app', 'openExternal', { url: string }, unknown>('app', 'openExternal', {
              url: uri,
            }).catch(() => undefined)
          })

        // 设置里关掉链接识别就不挂这个 addon（可热开关，见下方 effect）
        if (st.linkDetection) {
          const addon = makeLinks()
          linksAddonRef.current = addon
          term.loadAddon(addon)
        }
        term.open(host)

        termRef.current = term
        fitRef.current = fit
        searchRef.current = search
        writer.attach(term)
        setReady(true)

        // 尺寸变化 → 通知主进程，让远端 PTY 的 winsize 跟上
        const resizeSub = term.onResize(({ cols, rows }) => {
          setDims({ cols, rows })
          const current = tabRef.current
          if (!current.sessionId) return
          const domain = current.kind === 'ssh' ? 'ssh' : 'pty'
          void invoke(domain, 'resize', sessionPayload(current.kind, current.sessionId, { cols, rows })).catch(
            () => undefined,
          )
        })
        cleanups.push(() => resizeSub.dispose())

        // 键盘输入 → 会话
        const dataSub = term.onData((data) => {
          const current = tabRef.current
          // 先更新本地命令行跟踪，再决定是否触发补全
          const tracker = trackerRef.current
          const before = tracker.line
          tracker.consume(data)

          if (data === '\r' || data === '\n') {
            // 回车：提交的行进历史，并关掉弹窗
            const submitted = before.trim()
            if (submitted) {
              historyRef.current = [...historyRef.current.filter((h) => h !== submitted), submitted].slice(-500)
            }
            closeCompletion()
          } else if (data.length > 0) {
            scheduleCompletion()
          }

          if (!current.sessionId) return

          // 广播路由：只有「广播模式」才走 send（后端会写所有成员，包括本机），
          // 独立模式一律单发 —— 绝不能在这里"猜"，否则用户以为输入丢了。
          const group = broadcastGroupOf(current.sessionId)
          if (group && group.mode === 'broadcast') {
            void sendBroadcast(group.groupId, data)
            return
          }

          const domain = current.kind === 'ssh' ? 'ssh' : current.kind === 'telnet' ? 'telnet' : 'pty'
          void invoke(domain, 'write', sessionPayload(current.kind, current.sessionId, { data })).catch(
            (err: unknown) => {
              // 终端写入失败是严重状况（用户会以为"键盘坏了"），不能静默：
              // 每个会话只提示一次，避免刷屏
              if (writeWarnedRef.current) return
              writeWarnedRef.current = true
              toast.error(`终端写入失败：${errorText(err)}`)
            },
          )
        })
        cleanups.push(() => dataSub.dispose())

        // 「选中即复制」：设置开启时，选中一次就把内容放到剪贴板
        const selSub = term.onSelectionChange(() => {
          if (!termSettingsRef.current.copyOnSelect) return
          const sel = term.getSelection()
          if (sel) void navigator.clipboard.writeText(sel).catch(() => undefined)
        })
        cleanups.push(() => selSub.dispose())

        // 响铃：xterm 自己不会发声，按设置决定"出声 / 闪一下 / 不管"
        const bellSub = term.onBell(() => {
          const mode = termSettingsRef.current.bell
          if (mode === 'none') return
          if (mode === 'sound') {
            try {
              const Ctx =
                window.AudioContext ??
                (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
              if (Ctx) {
                const ac = new Ctx()
                const osc = ac.createOscillator()
                const gain = ac.createGain()
                gain.gain.value = 0.03
                osc.frequency.value = 760
                osc.connect(gain).connect(ac.destination)
                osc.start()
                osc.stop(ac.currentTime + 0.07)
              }
            } catch {
              /* 发声失败无所谓 */
            }
            return
          }
          // visual：闪一下画面边缘，不打断阅读
          const el = hostRef.current
          if (!el) return
          el.classList.add('term-bell-flash')
          window.setTimeout(() => el.classList.remove('term-bell-flash'), 160)
        })
        cleanups.push(() => bellSub.dispose())

        /**
         * OSC 7：远端 shell 报告当前目录（`\x1b]7;file://host/path\x07`）。
         * 主进程没有 cwd 动作，所以在这里解析 —— SFTP 的「定位到终端目录」靠它。
         * 拿不到（shell 没配）时 SFTP 侧会明确提示，而不是点了没反应。
         */
        const oscSub = term.parser.registerOscHandler(7, (data: string) => {
          const sid = sessionIdRef.current
          const path = parseOsc7(data)
          if (path && sid) setSessionCwd(sid, path)
          return false // 不拦截，其它处理器仍可看到
        })
        cleanups.push(() => oscSub.dispose())

        /**
         * 高亮规则在终端里的应用点。
         *
         * 语义与设置里的预览**完全一致**：都调 `segmentText()`（同一份切分算法）
         * 和 `segmentHighlightStyle()`（同一个"命中 → 颜色"映射，文字变色）。
         *
         * 落地方式由 xterm 6.0.0 的实测能力决定：
         * - DOM 渲染器会把 `layer: 'top'` 装饰的 `foregroundColor` **逐单元格涂到
         *   文字上**（`forEachDecorationAtCell` → 行 span 的内联 color）；
         *   它只接受 `#RRGGBB`，且颜色 getter 对非法值抛异常且无兜底——
         *   所以必须过 `normalizeHexColor()`，解析不了就放弃该命中；
         * - 装饰元素本身保持透明（只挡指针事件），不写任何颜色；
         * - `x`/`width` 单位是**单元格**，规则按**字符**匹配，用 `cellsFor()` 换算
         *   （其宽度表与 unicode11 插件同源）；
         * - 只处理**已完成的行**（光标行还在输出），即"只对新渲染字符生效"，
         *   不重刷整个回滚缓冲。
         */
        const decorations: Array<import('@xterm/xterm').IDecoration> = []
        let lastScannedY = -1

        const applyHighlights = (): void => {
          const rules = highlightRulesRef.current
          if (!rules || rules.length === 0) return
          const buf = term.buffer.active
          const curY = buf.baseY + buf.cursorY
          if (lastScannedY < 0) lastScannedY = Math.max(0, curY - 1) // 首次不回溯已有内容
          if (curY <= lastScannedY) {
            lastScannedY = curY
            return
          }
          for (let y = lastScannedY; y < curY; y += 1) {
            const line = buf.getLine(y)
            if (!line) continue
            const text = line.translateToString(true)
            if (!text) continue
            for (const seg of segmentText(text, rules)) {
              if (!seg.rule) continue
              const style = segmentHighlightStyle(seg.rule)
              if (style.color === undefined) continue
              const fg = normalizeHexColor(style.color)
              if (!fg) continue // 颜色不合规就放弃，绝不能把原始字符串传给 registerDecoration
              const x = cellsFor(text, seg.start)
              const width = Math.max(1, cellsFor(text, seg.end) - x)
              const marker = term.registerMarker(y - curY)
              if (!marker) continue
              const deco = term.registerDecoration({
                marker,
                anchor: 'left',
                x,
                width,
                height: 1,
                layer: 'top',
                foregroundColor: fg,
              })
              if (!deco) {
                marker.dispose()
                continue
              }
              deco.onRender((el: HTMLElement) => {
                // 颜色由 xterm 涂在命中单元格的文字上（见上），装饰元素保持透明
                el.textContent = ''
                el.style.pointerEvents = 'none'
              })
              decorations.push(deco)
              deco.onDispose(() => {
                const i = decorations.indexOf(deco)
                if (i >= 0) decorations.splice(i, 1)
              })
            }
          }
          lastScannedY = curY
        }

        const writeSub = term.onWriteParsed(applyHighlights)
        cleanups.push(() => {
          writeSub.dispose()
          for (const d of decorations) d.dispose()
          decorations.length = 0
        })

        // 立即做一次 fit，把真实尺寸报上去
        requestAnimationFrame(() => {
          if (disposed) return
          fitSafely(host, fit)
          term.focus()
        })
      } catch (err) {
        if (!disposed) {
          setError(err instanceof Error ? err.message : String(err))
        }
      }
    })()

    return () => {
      disposed = true
      for (const fn of cleanups) fn()
      window.clearTimeout(debounceTimer.current)
      writer.detach()
      termRef.current?.dispose()
      termRef.current = null
      fitRef.current = null
      searchRef.current = null
      setReady(false)
    }
  }, [everVisible, tab.tabId])

  const fitSafely = (host: HTMLElement, fit: FitAddon): void => {
    // 容器不可见时尺寸为 0，fit 会算出 0 列 0 行；直接跳过，等可见了再算
    if (host.clientWidth < 40 || host.clientHeight < 24) return
    try {
      fit.fit()
    } catch {
      /* xterm 在极端尺寸下会抛，忽略即可，下一次 resize 会纠正 */
    }
  }

  /* ── 行间斑马纹 ───────────────────────────────── */
  useEffect(() => {
    const el = hostRef.current
    if (!el) return
    const rows = el.querySelector('.xterm-rows')
    // DOM 渲染器会生成 .xterm-rows>div；canvas/webgl 用 <canvas>，没有逐行 DOM
    setZebraSupported(Boolean(rows))
    el.classList.toggle('term-zebra', zebra && Boolean(rows))
  }, [zebra, ready])

  /* ── 设置热更新 ───────────────────────────────── */
  /**
   * 改设置要**即时生效**，不能等下次新建终端。
   * xterm 的多数外观项都是可写的 `term.options.X`，直接赋值即可；
   * 只有 addon 需要自己挂/卸（链接识别）。
   */
  useEffect(() => {
    const term = termRef.current
    if (!term) return
    term.options.fontFamily = withEmojiFallback(termCfg.fontFamily)
    term.options.fontSize = termCfg.fontSize
    term.options.lineHeight = termCfg.lineHeight
    term.options.letterSpacing = termCfg.letterSpacing
    term.options.cursorBlink = termCfg.cursorBlink
    term.options.cursorStyle = termCfg.cursorStyle
    term.options.scrollback = termCfg.scrollback
    term.options.theme = themeFor(termCfg.colorScheme, resolvedTheme)

    // 链接识别：开关切换时挂/卸 addon
    const ctor = linksCtorRef.current
    if (ctor) {
      if (termCfg.linkDetection && !linksAddonRef.current) {
        const addon = new ctor((event, uri) => {
          event.preventDefault()
          void invoke<'app', 'openExternal', { url: string }, unknown>('app', 'openExternal', {
            url: uri,
          }).catch(() => undefined)
        })
        linksAddonRef.current = addon
        term.loadAddon(addon)
      } else if (!termCfg.linkDetection && linksAddonRef.current) {
        linksAddonRef.current.dispose()
        linksAddonRef.current = null
      }
    }
  }, [termCfg, resolvedTheme, ready])

  /* ── 尺寸跟踪 ─────────────────────────────────── */
  useEffect(() => {
    const host = hostRef.current
    const fit = fitRef.current
    if (!host || !fit) return
    const ro = new ResizeObserver(() => fitSafely(host, fit))
    ro.observe(host)
    return () => ro.disconnect()
  }, [ready, visible])

  // 从隐藏切回可见时必须重新 fit：隐藏期间容器尺寸是 0，之前的尺寸已经不对了
  useEffect(() => {
    if (!visible || !ready) return
    const host = hostRef.current
    const fit = fitRef.current
    if (!host || !fit) return
    const raf = requestAnimationFrame(() => {
      fitSafely(host, fit)
      termRef.current?.focus()
    })
    return () => cancelAnimationFrame(raf)
  }, [visible, ready])

  /* ── 数据订阅（高频路径，不进 store） ──────────── */
  useEffect(() => {
    const sessionId = tab.sessionId
    if (!sessionId) return
    const writer = writerRef.current
    if (tab.kind === 'local') {
      return subscribe(Events.PTY_DATA, (p) => {
        if (p.ptyId !== sessionId) return
        writer.push(p.data)
      })
    }
    if (tab.kind === 'telnet') {
      return subscribe(Events.TELNET_DATA, (p) => {
        if (p.sessionId !== sessionId) return
        writer.push(p.data)
      })
    }
    return subscribe(Events.SSH_DATA, (p) => {
      if (p.sessionId !== sessionId) return
      writer.push(p.data)
    })
  }, [tab.sessionId, tab.kind])

  /* ── 快捷键 ───────────────────────────────────── */
  // 捕获阶段处理：这些键必须先被弹窗消费掉，否则会被 xterm 送进远端 shell
  const onKeyDownCapture = useCallback(
    (e: React.KeyboardEvent) => {
      if (!completion) return
      const count = completion.candidates.length
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault()
          e.stopPropagation()
          setSelected((i) => (count === 0 ? 0 : (i + 1) % count))
          return
        case 'ArrowUp':
          e.preventDefault()
          e.stopPropagation()
          setSelected((i) => (count === 0 ? 0 : (i - 1 + count) % count))
          return
        case 'Tab':
          e.preventDefault()
          e.stopPropagation()
          acceptCandidate(selected)
          return
        case 'Escape':
          e.preventDefault()
          e.stopPropagation()
          closeCompletion()
          return
        default:
          return
      }
    },
    [completion, selected, acceptCandidate, closeCompletion],
  )

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const term = termRef.current
      if (!term) return
      if (e.ctrlKey && e.shiftKey && (e.key === 'F' || e.key === 'f')) {
        e.preventDefault()
        setFindOpen(true)
        return
      }
      // Ctrl+Space：手动触发补全（终端用户的肌肉记忆）
      if (e.ctrlKey && e.key === ' ') {
        e.preventDefault()
        void requestCompletion()
        return
      }
      if (e.ctrlKey && e.shiftKey && (e.key === 'C' || e.key === 'c')) {
        const sel = term.getSelection()
        if (sel) {
          e.preventDefault()
          void navigator.clipboard.writeText(sel)
        }
        return
      }
      if (e.ctrlKey && e.shiftKey && (e.key === 'V' || e.key === 'v')) {
        e.preventDefault()
        pasteFromClipboard(term)
        return
      }
      if (e.ctrlKey && !e.shiftKey && (e.key === 'l' || e.key === 'L')) {
        // Ctrl+L 交给远端 shell 处理（清屏），这里不拦截
        return
      }
    },
    [],
  )

  /**
   * 终端右键菜单。
   *
   * spec 第 243 行列了 **12 项**，这里逐项落地（外加我们自己的查找/录制/日志）：
   * 打开工具条、复制、粘贴、清屏、到底部、水平切分、垂直切分、重新连接终端、
   * 翻译、问问小易、复制并粘贴、复制并搜索。
   *
   * 两条纪律：
   * - **无选区就禁用**（并说明原因），不让用户点了没反应；
   * - **未配置 AI 时给可操作提示**（照 `services/ai/suggest.ts` 的措辞），不要静默。
   */
  const menuItems = (): ContextMenuItem[] => {
    const term = termRef.current
    const selection = term?.getSelection() ?? ''
    // 用 trim 后的长度判断，不是 length > 0：拖到空白区会得到一串空格，
    // 那时"复制/翻译"其实无事可做 —— 按 length>0 放行就会**静默无反应**。
    const hasSelection = selection.trim().length > 0
    const NO_SEL = '先在终端里选中文本（拖选或双击词）'

    const copySelection = (): void => {
      if (selection) void navigator.clipboard.writeText(selection)
    }

    /** 重新连接：关掉旧标签再连一次，复用既有的标签/事件管线（不自己造会话） */
    const reconnect = async (): Promise<void> => {
      const conn = getConnection(tab.connectionId)
      if (!conn) {
        toast.error('找不到这条连接（可能已被删除），无法重连')
        return
      }
      closeTab(tab.tabId)
      await connectTo(conn)
    }

    /**
     * 把选区发给 AI。两个刻意的做法：
     * 1. **先查供应商**再发送 —— 没配就地给可操作提示，而不是发出去等报错；
     * 2. **长选区截断并说明**，不把整屏几千字塞进请求。
     */
    const AI_MAX_CHARS = 4000
    const askAi = async (instruction: string): Promise<void> => {
      if (!selection.trim()) return
      let usable = false
      try {
        const list = await invoke<'ai', 'listProviders', Record<string, never>, PublicProvider[]>(
          'ai',
          'listProviders',
          {},
        )
        usable = (list ?? []).some((p) => p.hasApiKey)
      } catch {
        usable = false
      }
      if (!usable) {
        toast.error(
          'AI 建议需要先配置 AI 供应商：请打开「设置 > AI 助手」，选择供应商并填写 API Key 后重试',
        )
        return
      }
      const truncated = selection.length > AI_MAX_CHARS
      const body = truncated ? selection.slice(0, AI_MAX_CHARS) : selection
      const text =
        `${instruction}\n\n\`\`\`\n${body}\n\`\`\`` +
        (truncated ? `\n\n（原文 ${selection.length} 字符，已截断到 ${AI_MAX_CHARS} 字符）` : '')
      try {
        await invoke<'ai', 'send', { text: string }, unknown>('ai', 'send', { text })
        actions.setView('ai')
        toast.ok(truncated ? '已发给 AI 助手（选区较长，已截断）' : '已发给 AI 助手')
      } catch (err) {
        toast.error(
          `AI 请求失败：${errorText(err)} —— 可在「设置 > AI 助手」检查供应商与 API Key`,
        )
      }
    }

    return [
      {
        id: 'toolbar',
        label: toolbarVisible ? '隐藏工具条' : '打开工具条',
        icon: 'sliders',
        hint: 'Ctrl+Shift+T',
        onSelect: () => actions.toggleToolbar(),
      },
      {
        id: 'copy',
        label: '复制',
        icon: 'copy',
        hint: 'Ctrl+Shift+C',
        disabled: !hasSelection,
        title: hasSelection ? undefined : NO_SEL,
        onSelect: copySelection,
      },
      {
        id: 'paste',
        label: '粘贴',
        icon: 'download',
        hint: 'Ctrl+Shift+V',
        onSelect: () => pasteFromClipboard(termRef.current),
      },
      {
        id: 'copy-paste',
        label: '复制并粘贴',
        icon: 'copy',
        hint: '把输出直接当输入',
        disabled: !hasSelection,
        title: hasSelection ? undefined : NO_SEL,
        onSelect: () => {
          copySelection()
          // 同时写剪贴板 + 直接喂给会话：前者让用户还能粘到别处，后者是"把输出当输入"的本意
          if (selection) termRef.current?.paste(selection)
        },
      },
      {
        id: 'copy-search',
        label: '复制并搜索',
        icon: 'search',
        disabled: !hasSelection,
        title: hasSelection ? undefined : NO_SEL,
        onSelect: () => {
          copySelection()
          // **不做正则转义**：查找走 @xterm/addon-search 的默认模式，它是**字面量**匹配
          // （未传 regex:true）。转义反而会把 `a.b` 变成搜含反斜杠的字面串。
          setFindText(selection)
          setFindOpen(true)
          if (searchRef.current && selection) {
            searchRef.current.findNext(selection, { incremental: false })
          }
        },
      },
      { id: 'clear', label: '清屏', icon: 'close', hint: 'Ctrl+Shift+L', onSelect: () => termRef.current?.clear() },
      {
        id: 'bottom',
        label: '到底部',
        icon: 'chevron-down',
        hint: '回到最新输出',
        onSelect: () => termRef.current?.scrollToBottom(),
      },
      {
        id: 'split-h',
        separatorBefore: true,
        label: '水平切分',
        icon: 'split-h',
        onSelect: () => setTabLayout(tab.tabId, 'hsplit'),
      },
      {
        id: 'split-v',
        label: '垂直切分',
        icon: 'split-v',
        onSelect: () => setTabLayout(tab.tabId, 'vsplit'),
      },
      {
        id: 'reconnect',
        label: '重新连接终端',
        icon: 'refresh',
        disabled: tab.kind === 'local',
        title: tab.kind === 'local' ? '本地终端没有远端会话可重连；请新建一个终端' : undefined,
        onSelect: () => void reconnect(),
      },
      {
        id: 'translate',
        separatorBefore: true,
        label: '翻译（发给 AI）',
        icon: 'globe',
        disabled: !hasSelection,
        title: hasSelection ? undefined : NO_SEL,
        onSelect: () => void askAi('把下面这段终端输出翻译成中文，只给译文，技术名词保留原文。'),
      },
      {
        id: 'ask-ai',
        label: '问问小易',
        icon: 'zap',
        disabled: !hasSelection,
        title: hasSelection ? undefined : NO_SEL,
        onSelect: () =>
          void askAi('解释下面这段终端输出：它在说什么、有没有问题、需要我做什么。'),
      },
      { id: 'find', separatorBefore: true, label: '查找', icon: 'search', hint: 'Ctrl+Shift+F', onSelect: () => setFindOpen(true) },
      {
        id: 'record',
        // 本地终端也已支持：pty 服务现在会把输出 publishSessionData 到 session-registry
        // （此前只有 SSH 在 publish，本地终端录制会静默产出 0 字节空文件）
        label: recording ? '停止记录日志' : '开始记录日志',
        icon: recording ? 'stop' : 'record',
        danger: Boolean(recording),
        disabled: !tab.sessionId,
        onSelect: () => {
          if (!tab.sessionId) return
          if (recording) void stopSessionLog(tab.sessionId)
          else void startSessionLog(tab.sessionId, tab.title)
        },
      },
      {
        id: 'logs',
        label: recording ? '查看日志列表' : '查看已有日志',
        icon: 'notes',
        onSelect: () => {
          void loadSessionLogs()
          actions.setView('logs')
        },
      },
    ]
  }

  const onFind = (direction: 'next' | 'prev'): void => {
    const search = searchRef.current
    if (!search || !findText) return
    const opts = { incremental: true, caseSensitive: false }
    if (direction === 'next') search.findNext(findText, opts)
    else search.findPrevious(findText, opts)
  }

  const stateLabel: Record<string, string> = {
    idle: '空闲',
    connecting: '连接中',
    authenticating: '认证中',
    'verifying-host-key': '校验主机指纹',
    ready: '已就绪',
    disconnected: '已断开',
    failed: '连接失败',
  }

  return (
    <div
      className="term-pane"
      onKeyDown={onKeyDown}
      onKeyDownCapture={onKeyDownCapture}
      onContextMenu={(e) => {
        // 接管右键：xterm 没有自带的上下文菜单，这里给出终端该有的操作
        e.preventDefault()
        setMenu({ x: e.clientX, y: e.clientY })
      }}
    >
      <div
        ref={hostRef}
        className="term-pane__surface"
        onClick={() => termRef.current?.focus()}
        data-testid="terminal-surface"
      />

      <ContextMenu
        open={menu !== null}
        x={menu?.x ?? 0}
        y={menu?.y ?? 0}
        items={menuItems()}
        onClose={() => setMenu(null)}
      />

      {completion ? (
        <CompletionPopup
          candidates={completion.candidates}
          selected={selected}
          elapsedMs={completion.elapsedMs}
          specName={completion.specName}
          aiRequested={completion.aiRequested}
          onHover={setSelected}
          onAccept={acceptCandidate}
        />
      ) : null}

      {findOpen ? (
        <div className="term-find" role="search">
          <input
            className="t-input"
            autoFocus
            value={findText}
            placeholder="在终端中查找…"
            aria-label="终端内查找"
            onChange={(e) => {
              setFindText(e.target.value)
              const search = searchRef.current
              if (search && e.target.value) search.findNext(e.target.value, { incremental: true })
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                onFind(e.shiftKey ? 'prev' : 'next')
              } else if (e.key === 'Escape') {
                setFindOpen(false)
                termRef.current?.focus()
              }
            }}
          />
          <IconButton icon="chevron-left" label="上一个" onClick={() => onFind('prev')} />
          <IconButton icon="chevron-right" label="下一个" onClick={() => onFind('next')} />
          <IconButton
            icon="close"
            label="关闭查找"
            onClick={() => {
              setFindOpen(false)
              termRef.current?.focus()
            }}
          />
        </div>
      ) : null}

      {!ready && !error ? (
        <div className="term-pane__overlay">
          <div className="t-loading">
            <span className="t-spinner" aria-hidden />
            <span>正在准备终端…</span>
          </div>
        </div>
      ) : null}

      {error ? (
        <div className="term-pane__overlay">
          <div className="t-empty">
            <div className="t-empty__art">
              <Icon name="alert-triangle" size={24} />
            </div>
            <div className="t-empty__title">终端组件加载失败</div>
            <div className="t-empty__text">{error}</div>
          </div>
        </div>
      ) : null}

      {tab.kind === 'telnet' ? (
        <div className={`telnet-neg${negOpen ? ' telnet-neg--open' : ''}`}>
          <button type="button" className="telnet-neg__head" onClick={() => setNegOpen((v) => !v)}>
            <Icon name={negOpen ? 'chevron-down' : 'chevron-right'} size={12} />
            <Icon name="route" size={12} />
            选项协商
            {negotiations && negotiations.length > 0 ? (
              <Badge tone="outline">{negotiations.length}</Badge>
            ) : null}
            {negotiations && negotiations.some((n) => !n.accepted) ? (
              <Badge tone="warn">有未接受的选项</Badge>
            ) : null}
            <span className="telnet-neg__hint">
              连上但键盘没反应时，先看这里——多半是协商没谈拢
            </span>
          </button>
          {negOpen ? (
            <div className="telnet-neg__body">
              {!negotiations || negotiations.length === 0 ? (
                <div className="telnet-neg__empty">还没有协商记录。</div>
              ) : (
                negotiations.map((n, i) => (
                  <div className="telnet-neg__row" key={`${n.option}-${n.at}-${i}`}>
                    <span className="telnet-neg__dir">{n.direction === 'local' ? '本机' : '远端'}</span>
                    <span className="telnet-neg__name">
                      {n.optionName} <span className="telnet-neg__num">#{n.option}</span>
                    </span>
                    <Badge tone={n.accepted ? 'ok' : 'warn'}>{n.accepted ? '已接受' : '拒绝/未接受'}</Badge>
                    {n.detail ? <span className="telnet-neg__detail">{n.detail}</span> : null}
                  </div>
                ))
              )}
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="term-pane__status">
        {recording ? (
          <span className="term-pane__rec" title={`正在记录日志（${recording.logId}）`}>
            <span className="rec-dot" />
            录制中
          </span>
        ) : null}
        <span>{stateLabel[tab.state] ?? tab.state}</span>
        {tab.message ? <span title={tab.message}>· {tab.message}</span> : null}
        {/* 开了斑马纹但当前渲染器做不出行背景：如实说明，不让用户以为开关坏了 */}
        {zebra && !zebraSupported ? (
          <span className="term-pane__cwd" title="行间斑马纹需要 xterm 的 DOM 渲染器（逐行元素）；canvas/webgl 渲染器把整屏画在位图上，无法做行背景">
            · 斑马纹不可用（当前渲染器非 DOM）
          </span>
        ) : null}
        {/* 远端 cwd（来自 OSC 7）：SFTP 的「定位到终端目录」用的就是它，
            显示出来用户才知道"能不能定位、定位到哪" */}
        {sessionCwd ? (
          <span className="term-pane__cwd" title={`远端当前目录：${sessionCwd}（来自 shell 的 OSC 7 报告）`}>
            · {sessionCwd}
          </span>
        ) : null}
        <div style={{ flex: 1 }} />
        <span>编码 {tab.encoding}</span>
        {dims ? (
          <span>
            {dims.cols}×{dims.rows}
          </span>
        ) : null}
        <IconButton
          icon="search"
          label="查找 (Ctrl+Shift+F)"
          size={12}
          onClick={() => setFindOpen((v) => !v)}
        />
        <IconButton
          icon="copy"
          label="复制选中内容"
          size={12}
          onClick={() => {
            const sel = termRef.current?.getSelection()
            if (sel) void navigator.clipboard.writeText(sel)
          }}
        />
        <IconButton icon="close" label="清屏" size={12} onClick={() => termRef.current?.clear()} />
      </div>
    </div>
  )
}
