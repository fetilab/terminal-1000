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
 * `@xterm/xterm` 与三个 addon 都用动态 import，只有真正打开终端时才加载，
 * 满足「Monaco / xterm 懒加载，未打开相关面板不加载」的性能要求。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import '@xterm/xterm/css/xterm.css'
import type { Terminal } from '@xterm/xterm'
import type { FitAddon } from '@xterm/addon-fit'
import type { SearchAddon } from '@xterm/addon-search'
import { Events } from '@t1000/shared'
import { Icon } from '../../components/Icon'
import { Badge } from '../../components/Feedback'
import { IconButton } from '../../components/Button'
import { invoke, subscribe } from '../../lib/ipc'
import type { TabKind } from '../../lib/store'
import {
  actions,
  broadcastGroupOf,
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
import './terminal.css'
import './completion.css'

/** 积压上限：超过就丢弃并在终端里明确告知，绝不无声无息地胀内存 */
const MAX_BUFFER_CHARS = 4 * 1024 * 1024

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
        const [{ Terminal: XTerm }, { FitAddon: Fit }, { SearchAddon: Search }, { WebLinksAddon: Links }] =
          await Promise.all([
            import('@xterm/xterm'),
            import('@xterm/addon-fit'),
            import('@xterm/addon-search'),
            import('@xterm/addon-web-links'),
          ])
        if (disposed) return

        const term = new XTerm({
          fontFamily:
            "'JetBrains Mono', 'Cascadia Code', Menlo, Consolas, 'Noto Sans Mono', monospace",
          fontSize: 13,
          lineHeight: 1.22,
          letterSpacing: 0,
          cursorBlink: true,
          cursorStyle: 'bar',
          scrollback: 8000,
          allowProposedApi: true,
          convertEol: false,
          macOptionIsMeta: true,
          theme: resolvedTheme === 'light' ? TERMINAL_THEME_LIGHT : TERMINAL_THEME,
        })
        const fit = new Fit()
        const search = new Search()
        term.loadAddon(fit)
        term.loadAddon(search)
        // 链接点击交给主进程用系统浏览器打开（app.openExternal 内置协议白名单校验），
        // 避免渲染层自己 window.open 出一个裸的 Electron 窗口。
        term.loadAddon(
          new Links((event, uri) => {
            event.preventDefault()
            void invoke<'app', 'openExternal', { url: string }, unknown>('app', 'openExternal', {
              url: uri,
            }).catch(() => undefined)
          }),
        )
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

  /* ── 主题热切换 ───────────────────────────────── */
  useEffect(() => {
    const term = termRef.current
    if (!term) return
    // 只换主题，不重建实例 —— 重建会丢掉滚动回看与远端状态
    term.options.theme = resolvedTheme === 'light' ? TERMINAL_THEME_LIGHT : TERMINAL_THEME
  }, [resolvedTheme, ready])

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
        void navigator.clipboard.readText().then((text) => {
          if (text) term.paste(text)
        })
        return
      }
      if (e.ctrlKey && !e.shiftKey && (e.key === 'l' || e.key === 'L')) {
        // Ctrl+L 交给远端 shell 处理（清屏），这里不拦截
        return
      }
    },
    [],
  )

  /** 终端右键菜单。录制启停放在这里，和参考产品的位置一致，用户有肌肉记忆。 */
  const menuItems = (): ContextMenuItem[] => {
    const term = termRef.current
    const hasSelection = Boolean(term?.getSelection())
    return [
      {
        id: 'copy',
        label: '复制',
        icon: 'copy',
        hint: 'Ctrl+Shift+C',
        disabled: !hasSelection,
        onSelect: () => {
          const sel = term?.getSelection()
          if (sel) void navigator.clipboard.writeText(sel)
        },
      },
      {
        id: 'paste',
        label: '粘贴',
        icon: 'download',
        hint: 'Ctrl+Shift+V',
        onSelect: () => {
          void navigator.clipboard.readText().then((text) => {
            if (text) termRef.current?.paste(text)
          })
        },
      },
      { id: 'find', label: '查找', icon: 'search', hint: 'Ctrl+Shift+F', onSelect: () => setFindOpen(true) },
      { id: 'clear', label: '清屏', icon: 'close', onSelect: () => termRef.current?.clear() },
      {
        id: 'record',
        separatorBefore: true,
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
