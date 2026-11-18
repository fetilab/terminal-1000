// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * SFTP 浏览器：面包屑 + 虚拟化列表 + 文件操作 + 传输队列。
 *
 * ## 本地路径选择
 * 上传/下载需要**本地绝对路径**，渲染层的 `<input type="file">` 拿不到（Electron 32+
 * 移除了 `File.path`），所以走主进程的 `app.pickLocalPath`（原生对话框）。
 * 用户取消返回 `{canceled:true}` 而不是抛错 —— 取消是正常操作，不弹错误。
 * 仍保留手填输入框作为兜底（例如已知路径、或对话框在某些环境下不可用）。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Events } from '@t1000/shared'
import { invoke, subscribe } from '../../lib/ipc'
import { errorText, formatBytes, formatDate } from '../../lib/format'
import { actions, useStoreShallow } from '../../lib/store'
import { RemoteEditor } from '../editor/RemoteEditor'
import {
  addBookmark,
  listBookmarks,
  removeBookmark,
  renameBookmark,
  type SftpBookmark,
} from './bookmarks'
import { Button, IconButton } from '../../components/Button'
import { Badge, Banner, EmptyState, Loading } from '../../components/Feedback'
import { Checkbox, Field, TextInput } from '../../components/Form'
import { Icon } from '../../components/Icon'
import { ContextMenu, type ContextMenuItem } from '../../components/ContextMenu'
import { Modal } from '../../components/Modal'
import { Segmented } from '../../components/Segmented'
import { toast } from '../../components/Toast'
import { VirtualList } from '../../components/VirtualList'
import {
  breadcrumbSegments,
  entryIconType,
  joinRemote,
  modeToOctal,
  octalToMode,
  parentRemote,
  type ChmodPlanResult,
  type ChmodRunResult,
  type OpenEditorResult,
  type RemoteEntry,
} from './sftpTypes'
import { markCancelled, useTransfers, wireTransferEvents, clearFinished, type TransferItem } from './transferStore'
import { BatchPanel } from './BatchPanel'
import { ChmodDialog } from './ChmodDialog'
import {
  batchCounts,
  batchFailureLines,
  chmodStepOutcome,
  createBatchReport,
  finishReport,
  formatBatchSummary,
  hasFailures,
  markItem,
  markItemByTransfer,
  type BatchKind,
  type BatchReport,
} from './batchOps'
import {
  clearSelection,
  clickSelection,
  countDirectories,
  EMPTY_SELECTION,
  isSelected,
  selectAll,
  selectedEntries,
  type ClickMods,
  type SelectionState,
} from './selection'
import {
  ancestorsOf,
  collapsePath,
  dropDir,
  expandPaths,
  flattenTree,
  isSelfOrDescendant,
  sortEntries,
  toggleExpanded,
  treeKeyIntent,
  withDir,
  type DirCache,
  type TreeNode,
} from './treeModel'
import { SftpTree } from './SftpTree'
import './sftp.css'

const LOCAL_DIR_KEY = 't1000:sftp-local-dir'
const VIEW_KEY = 't1000:sftp-view'

/**
 * 视图模式。列表是既有主视图，树是按需懒加载的目录导航视图；
 * 两者共用同一份目录缓存、排序、选择与动作处理，不做并行实现。
 */
type SftpViewMode = 'list' | 'tree'

/** 稳定空数组：避免 `dirs[cwd] ?? []` 每次都产生新引用，把下游 memo 全部打穿 */
const EMPTY_ENTRIES: readonly RemoteEntry[] = []

function rememberedViewMode(): SftpViewMode {
  try {
    return localStorage.getItem(VIEW_KEY) === 'tree' ? 'tree' : 'list'
  } catch {
    return 'list'
  }
}

function rememberViewMode(mode: SftpViewMode): void {
  try {
    localStorage.setItem(VIEW_KEY, mode)
  } catch {
    /* 无痕模式下忽略 */
  }
}

/** 删掉一个键并返回新对象（不改原对象）；键不存在时原样返回，避免无意义重渲染 */
function withoutKey<T>(record: Readonly<Record<string, T>>, key: string): Record<string, T> {
  if (!(key in record)) return record as Record<string, T>
  const next: Record<string, T> = { ...record }
  delete next[key]
  return next
}

function rememberedLocalDir(): string {
  try {
    return localStorage.getItem(LOCAL_DIR_KEY) ?? ''
  } catch {
    return ''
  }
}

function rememberLocalDir(dir: string): void {
  try {
    localStorage.setItem(LOCAL_DIR_KEY, dir)
  } catch {
    /* 无痕模式下忽略 */
  }
}

/* ── 传输队列 ─────────────────────────────────── */

function TransferRow({ item }: { item: TransferItem }): React.JSX.Element {
  const percent =
    item.totalBytes > 0 ? Math.min(100, (item.transferredBytes / item.totalBytes) * 100) : 0
  const done = item.status !== 'running'

  return (
    <div className={`tx${item.status === 'failed' ? ' tx--failed' : ''}${item.status === 'finished' ? ' tx--finished' : ''}`}>
      <div className="tx__top">
        <Icon name={item.direction === 'upload' ? 'upload' : 'download'} size={12} />
        <span className="tx__file" title={item.file}>
          {item.file}
        </span>
        <span className="tx__nums">
          {formatBytes(item.transferredBytes)} / {formatBytes(item.totalBytes)}
          {item.speed ? ` · ${formatBytes(item.speed)}/s` : ''}
        </span>
        {item.status === 'failed' ? <Badge tone="danger">失败</Badge> : null}
        {item.status === 'cancelled' ? <Badge tone="warn">已取消</Badge> : null}
        {item.status === 'finished' ? <Badge tone="ok">完成</Badge> : null}
        {!done ? (
          <IconButton
            icon="close"
            label="取消传输"
            size={12}
            tone="danger"
            onClick={() => {
              void invoke<'sftp', 'cancelTransfer', { transferId: string }, unknown>(
                'sftp',
                'cancelTransfer',
                { transferId: item.transferId },
              )
                .then(() => markCancelled(item.transferId))
                .catch((err: unknown) => toast.error(`取消失败：${errorText(err)}`))
            }}
          />
        ) : null}
      </div>
      {!done ? (
        <div className="bar" style={{ marginTop: 5 }}>
          <div className={`bar__fill${percent >= 90 ? ' bar__fill--warn' : ''}`} style={{ width: `${percent}%` }} />
        </div>
      ) : null}
      {item.scanning ? (
        <div className="tx__scan">
          正在扫描 {item.scanning.path} · 已发现 {item.scanning.files} 个文件 /{' '}
          {formatBytes(item.scanning.bytes)}
        </div>
      ) : null}
      {item.message ? <div className="t-field__error">{item.message}</div> : null}
      {item.filesTotal && item.filesTotal > 1 ? (
        <div className="metric__sub">
          文件 {item.filesDone ?? 0}/{item.filesTotal}
        </div>
      ) : null}
    </div>
  )
}

function TransferQueue({ sessionId }: { sessionId: string }): React.JSX.Element | null {
  const all = useTransfers()
  const mine = all.filter((t) => t.sessionId === sessionId)
  const [collapsed, setCollapsed] = useState(false)
  if (mine.length === 0) return null

  const running = mine.filter((t) => t.status === 'running').length

  return (
    <div className="sftp-queue">
      <div className="sftp-queue__head">
        <Icon name="download" size={13} />
        传输队列
        <Badge tone={running > 0 ? 'accent' : 'default'}>
          {running > 0 ? `${running} 进行中` : `${mine.length} 条`}
        </Badge>
        <div style={{ flex: 1 }} />
        <IconButton
          icon="trash"
          label="清除已结束的条目"
          size={12}
          onClick={() => clearFinished()}
        />
        <IconButton
          icon={collapsed ? 'chevron-right' : 'chevron-down'}
          label={collapsed ? '展开' : '收起'}
          size={12}
          onClick={() => setCollapsed((v) => !v)}
        />
      </div>
      {!collapsed ? (
        <div className="sftp-queue__body">
          {mine.map((t) => (
            <TransferRow key={t.transferId} item={t} />
          ))}
        </div>
      ) : null}
    </div>
  )
}

/* ── 输入弹窗 ─────────────────────────────────── */

interface PromptProps {
  open: boolean
  title: string
  label: string
  hint?: string
  initial?: string
  placeholder?: string
  confirmText?: string
  danger?: boolean
  onClose: () => void
  onSubmit: (value: string) => void | Promise<void>
}

function Prompt({
  open,
  title,
  label,
  hint,
  initial = '',
  placeholder,
  confirmText = '确定',
  danger = false,
  onClose,
  onSubmit,
}: PromptProps): React.JSX.Element {
  const [value, setValue] = useState(initial)
  useEffect(() => {
    if (open) setValue(initial)
  }, [open, initial])

  return (
    <Modal
      open={open}
      size="sm"
      title={title}
      onClose={onClose}
      footer={
        <>
          <div className="t-modal__footer-spacer" />
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button
            variant={danger ? 'danger' : 'primary'}
            onClick={() => {
              void onSubmit(value)
            }}
          >
            {confirmText}
          </Button>
        </>
      }
    >
      <Field label={label} hint={hint}>
        <TextInput
          value={value}
          placeholder={placeholder}
          autoFocus
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void onSubmit(value)
          }}
        />
      </Field>
    </Modal>
  )
}

/* ── 主组件 ───────────────────────────────────── */

export interface SftpBrowserProps {
  sessionId: string | undefined
  title: string
}

export default function SftpBrowser({ sessionId, title }: SftpBrowserProps): React.JSX.Element {
  const [cwd, setCwd] = useState('')
  // 书签按 connectionId 存（跨重连保留）；终端 cwd 来自 OSC 7（见 TerminalPane）
  const { connectionId, terminalCwd } = useStoreShallow((s) => {
    const tab = s.tabs.find((t) => t.sessionId === sessionId)
    return {
      connectionId: tab?.connectionId,
      terminalCwd: sessionId ? s.sessionCwd[sessionId] : undefined,
    }
  })
  const [bookmarks, setBookmarks] = useState<SftpBookmark[]>([])
  /** 内置编辑器：当前正在编辑的远端文件路径 */
  const [editingPath, setEditingPath] = useState<string | null>(null)
  const [bmDialog, setBmDialog] = useState<
    { mode: 'add' | 'rename'; id?: string; path: string; name: string } | null
  >(null)
  /**
   * 目录缓存：path → 已取回的条目。列表与树**共用同一份**，
   * 「同一目录在两种视图里条目一致」因此是结构上保证的，而不是两处各取一次再对齐。
   */
  const [dirs, setDirs] = useState<DirCache<RemoteEntry>>({})
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // 多选状态（含连选锚点）。单选值由它派生，保证既有单文件操作语义不变。
  const [selection, setSelection] = useState<SelectionState>(EMPTY_SELECTION)
  const [batchReport, setBatchReport] = useState<BatchReport | null>(null)
  const [batchDeleteOpen, setBatchDeleteOpen] = useState(false)
  const [batchChmodOpen, setBatchChmodOpen] = useState(false)
  const [batchDownloadOpen, setBatchDownloadOpen] = useState(false)
  const [showHidden, setShowHidden] = useState(false)

  const [viewMode, setViewMode] = useState<SftpViewMode>(rememberedViewMode)
  /** 树的固定锚点（远端 home）。树不随 cwd 重根，否则展开一个目录整棵树都会跳走 */
  const [treeRoot, setTreeRoot] = useState('')
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set<string>())
  /** 正在取子项的目录（展开时按需懒加载） */
  const [dirLoading, setDirLoading] = useState<ReadonlySet<string>>(() => new Set<string>())
  const [dirErrors, setDirErrors] = useState<Record<string, string>>({})
  /** 树里键盘活动行（与选中分开：方向键只移动它） */
  const [activeKey, setActiveKey] = useState<string | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; entry: RemoteEntry } | null>(null)

  const [mkdir, setMkdir] = useState(false)
  const [renameTarget, setRenameTarget] = useState<RemoteEntry | null>(null)
  const [chmodTarget, setChmodTarget] = useState<RemoteEntry | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<RemoteEntry | null>(null)
  const [uploadOpen, setUploadOpen] = useState(false)
  const [downloadTarget, setDownloadTarget] = useState<RemoteEntry | null>(null)

  const [localDir, setLocalDir] = useState(rememberedLocalDir)
  const [localFiles, setLocalFiles] = useState<string[]>([])
  const [recursive, setRecursive] = useState(true)

  const conflictPolicy = useStoreShallow((s) => ({ v: s.transferConflictPolicy })).v
  const seq = useRef(0)
  /**
   * 把 showHidden 放进 ref：`load` 的依赖里若含它，切换"显示隐藏"会让 home effect
   * 重新执行并把 cwd 重置回主目录。过滤条件的变化由下面的 effect 显式处理。
   */
  const showHiddenRef = useRef(showHidden)
  showHiddenRef.current = showHidden
  const dirsRef = useRef(dirs)
  dirsRef.current = dirs
  const expandedRef = useRef(expanded)
  expandedRef.current = expanded
  /** 同一目录的并发请求去重（展开 + 刷新可能同时落到一个目录） */
  const inflight = useRef(new Set<string>())

  useEffect(() => {
    wireTransferEvents()
  }, [])

  // 下载是**异步**的：submit 返回后 invoke 就结束了。批量面板要靠传输事件
  // 才知道每一项最终成功还是失败（失败原因也在这里），否则只会一直显示"已提交"。
  useEffect(() => {
    const offOk = subscribe(Events.SFTP_TRANSFER_FINISHED, (p) => {
      setBatchReport((prev) => (prev ? markItemByTransfer(prev, p.transferId, { status: 'ok' }) : prev))
    })
    const offErr = subscribe(Events.SFTP_TRANSFER_ERROR, (p) => {
      setBatchReport((prev) =>
        prev ? markItemByTransfer(prev, p.transferId, { status: 'failed', error: p.message }) : prev,
      )
    })
    return () => {
      offOk()
      offErr()
    }
  }, [])

  /**
   * 列表导航：取目录并把它设为 cwd（同时写进共享缓存）。
   * 只捕获一次请求（seq 全局递增）——快速点面包屑时先发后到的响应必须丢弃。
   */
  const load = useCallback(
    async (path: string) => {
      if (!sessionId) return
      const mySeq = ++seq.current
      setLoading(true)
      setError(null)
      try {
        const list = await invoke<'sftp', 'list', Record<string, unknown>, RemoteEntry[]>(
          'sftp',
          'list',
          { sessionId, path, showHidden: showHiddenRef.current },
        )
        // 丢弃过期响应：快速点面包屑时先发的可能后到
        if (mySeq !== seq.current) return
        setDirs((prev) => withDir(prev, path, Array.isArray(list) ? list : []))
        setDirErrors((prev) => withoutKey(prev, path))
        setCwd(path)
      } catch (err) {
        if (mySeq !== seq.current) return
        const message = errorText(err)
        setError(message)
        setDirs((prev) => dropDir(prev, path))
        setDirErrors((prev) => ({ ...prev, [path]: message }))
      } finally {
        if (mySeq === seq.current) setLoading(false)
      }
    },
    [sessionId],
  )

  /**
   * 树视图的按需懒加载：只写缓存，不动 cwd、不动 loading（那是列表导航的状态）。
   * 失败要落进 dirErrors —— 否则展开一个没权限的目录会永远停在"读取中…"。
   */
  const fetchDir = useCallback(
    async (path: string): Promise<void> => {
      if (!sessionId) return
      if (inflight.current.has(path)) return
      inflight.current.add(path)
      setDirLoading((prev) => new Set(prev).add(path))
      setDirErrors((prev) => withoutKey(prev, path))
      try {
        const list = await invoke<'sftp', 'list', Record<string, unknown>, RemoteEntry[]>(
          'sftp',
          'list',
          { sessionId, path, showHidden: showHiddenRef.current },
        )
        setDirs((prev) => withDir(prev, path, Array.isArray(list) ? list : []))
      } catch (err) {
        const message = errorText(err)
        setDirErrors((prev) => ({ ...prev, [path]: message }))
      } finally {
        inflight.current.delete(path)
        setDirLoading((prev) => {
          if (!prev.has(path)) return prev
          const next = new Set(prev)
          next.delete(path)
          return next
        })
      }
    },
    [sessionId],
  )

  // 首次进入：先问远端 home，避免猜错起始目录。树的锚点也用同一个值。
  useEffect(() => {
    if (!sessionId) return
    let cancelled = false
    void (async () => {
      try {
        const res = await invoke<'sftp', 'home', { sessionId: string }, { path: string }>(
          'sftp',
          'home',
          { sessionId },
        )
        if (!cancelled && res?.path) {
          setTreeRoot(res.path)
          void load(res.path)
        }
      } catch (err) {
        if (!cancelled) {
          setError(errorText(err))
          setTreeRoot('/')
          void load('/')
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [sessionId, load])

  /**
   * 「显示隐藏」切换后缓存整体失效：缓存里存的是旧过滤条件下的结果，混着用会让
   * 树和列表对同一目录给出**不同**条目。这里清空缓存并按当前需要重取（保留展开状态）。
   */
  const hiddenRef = useRef(showHidden)
  useEffect(() => {
    if (hiddenRef.current === showHidden) return
    hiddenRef.current = showHidden
    setDirs({})
    setDirErrors({})
    inflight.current.clear()
    const targets = new Set<string>()
    if (cwd) targets.add(cwd)
    if (treeRoot) targets.add(treeRoot)
    for (const p of expandedRef.current) targets.add(p)
    if (cwd) void load(cwd)
    for (const p of targets) {
      if (p !== cwd) void fetchDir(p)
    }
  }, [showHidden, cwd, treeRoot, load, fetchDir])

  const cwdEntries = dirs[cwd] ?? EMPTY_ENTRIES
  /** 列表行的排序。树也用 `sortEntries`，两个视图对同一目录的条目与顺序必然一致 */
  const sorted = useMemo(() => sortEntries(cwdEntries), [cwdEntries])

  const treeRootEntries = useMemo(() => sortEntries(dirs[treeRoot] ?? EMPTY_ENTRIES), [dirs, treeRoot])
  const treeRows = useMemo(
    () =>
      flattenTree<RemoteEntry>({
        roots: treeRootEntries,
        expanded,
        childrenOf: (path) => dirs[path],
        statusOf: (path) => {
          const message = dirErrors[path]
          if (message !== undefined) return { status: 'error' as const, message }
          return dirLoading.has(path) ? { status: 'loading' as const } : undefined
        },
      }),
    [treeRootEntries, expanded, dirs, dirErrors, dirLoading],
  )

  /**
   * 所有已知条目（当前目录 + 树里已加载的目录），按 path 去重、当前目录优先。
   * 树视图里选中的条目可能不在 cwd，单文件动作与批量操作必须能定位到它；
   * 列表视图下选择只可能来自 cwd，因此这里与原先的行为完全一致。
   */
  const knownEntries = useMemo(() => {
    const out: RemoteEntry[] = []
    const seen = new Set<string>()
    const add = (list: readonly RemoteEntry[] | undefined): void => {
      for (const entry of list ?? []) {
        if (seen.has(entry.path)) continue
        seen.add(entry.path)
        out.push(entry)
      }
    }
    add(sorted)
    for (const list of Object.values(dirs)) add(list)
    return out
  }, [sorted, dirs])

  const entryByPath = useMemo(() => new Map(knownEntries.map((e) => [e.path, e])), [knownEntries])

  /** 只有"恰好选中一项"才启用单文件操作；多选时不显示，避免误触单击动作 */
  const selectedPath = selection.ids.length === 1 ? (selection.ids[0] ?? null) : null
  const selected = selectedPath
  const selectedEntry = selected ? (entryByPath.get(selected) ?? null) : null
  const pickedEntries = useMemo(() => selectedEntries(knownEntries, selection), [knownEntries, selection])
  const pickedDirs = countDirectories(pickedEntries)
  const multiSelecting = selection.ids.length >= 2

  /**
   * 系统编辑器那条路的写回结果。
   * **失败必须显眼**（否则用户以为存上了）；`remoteChangedSinceOpen` 为真时
   * 要提示"可能覆盖了别人的修改"。
   */
  useEffect(() => {
    const offSaved = subscribe(Events.SFTP_EDIT_SAVED, (p) => {
      if (p.sessionId !== sessionId) return
      if (p.remoteChangedSinceOpen) {
        toast.warn(`已写回 ${p.remotePath}，但该文件在你编辑期间被改过 —— 可能覆盖了别人的修改。`)
      } else {
        toast.ok(`已写回远端：${p.remotePath}（${p.bytes} 字节）`)
      }
      reload()
    })
    const offErr = subscribe(Events.SFTP_EDIT_ERROR, (p) => {
      if (p.sessionId !== undefined && p.sessionId !== sessionId) return
      toast.error(`写回远端失败：${p.remotePath} — ${p.message}`)
    })
    return () => {
      offSaved()
      offErr()
    }
  }, [sessionId])

  const refreshBookmarks = useCallback((): void => {
    setBookmarks(listBookmarks(connectionId))
  }, [connectionId])

  useEffect(() => {
    refreshBookmarks()
  }, [refreshBookmarks])

  /**
   * 「定位到终端目录」。
   *
   * 我们**没有**主进程的 cwd 动作，这里的路径来自渲染层解析的 OSC 7。
   * 拿不到时要**说清楚为什么**（远端 shell 没发 OSC 7），
   * 而不是点了没反应 —— 那会让人以为是书签/定位功能坏了。
   */
  const locateToTerminal = useCallback((): void => {
    if (!sessionId) return
    void (async () => {
      // 优先主进程的权威值：`ssh.getCwd` 在主进程用全局会话订阅解析 OSC 7（跨 TCP 分块可靠），
      // 渲染层解析的那份只作兜底。
      let target = terminalCwd
      let getCwdError: string | null = null
      try {
        const res = await invoke<
          'ssh',
          'getCwd',
          { sessionId: string },
          { cwd: string | null; reason?: string }
        >('ssh', 'getCwd', { sessionId })
        if (res?.cwd) target = res.cwd
        else if (!target) {
          // 主进程给的原因比我写死的那句更准（它会说明具体缺什么）
          toast.info(res?.reason ?? '还没拿到终端的当前目录。')
          return
        }
      } catch (err) {
        // getCwd 不可用（例如更早的主进程）：落回 OSC 7 的值，别因此让按钮失灵。
        // 但**必须留痕** —— 静默 catch 会把"动作名写错/主进程没实现"伪装成
        // "远端 shell 没发 OSC 7"，排查方向直接跑偏。
        getCwdError = errorText(err)
        console.warn('[sftp] 定位：ssh.getCwd 调用失败，回退到渲染层 OSC 7 值', err)
      }
      if (!target) {
        toast.info(
          getCwdError
            ? `拿不到终端当前目录，且主进程查询失败：${getCwdError}`
            : '还没拿到终端的当前目录：需要远端 shell 发 OSC 7 才能识别（bash 可在 PROMPT_COMMAND 里输出，zsh/fish 常见配置自带）。也可以在下方书签里手动收藏常用目录。',
        )
        return
      }
      void load(target)
    })()
  }, [sessionId, terminalCwd, load])

  const reload = (): void => {
    if (cwd) void load(cwd)
  }

  const submitUpload = async (): Promise<void> => {
    if (!sessionId || localFiles.length === 0) return
    const paths = localFiles.slice()
    rememberLocalDir(paths[0]?.split('/').slice(0, -1).join('/') ?? '')
    setUploadOpen(false)
    let ok = 0
    for (const src of paths) {
      const name = src.split('/').filter(Boolean).pop() ?? ''
      try {
        await invoke<'sftp', 'upload', Record<string, unknown>, unknown>('sftp', 'upload', {
          sessionId,
          direction: 'upload',
          sourcePath: src,
          targetPath: joinRemote(cwd, name),
          recursive,
          conflictPolicy,
        })
        ok += 1
      } catch (err) {
        toast.error(`上传提交失败（${name}）：${errorText(err)}`)
      }
    }
    if (ok > 0) toast.info(`已提交 ${ok} 个上传任务`)
    setLocalFiles([])
  }

  const submitDownload = async (dir: string): Promise<void> => {
    if (!sessionId || !downloadTarget || !dir.trim()) return
    rememberLocalDir(dir.trim())
    setLocalDir(dir.trim())
    setDownloadTarget(null)
    try {
      await invoke<'sftp', 'download', Record<string, unknown>, unknown>('sftp', 'download', {
        sessionId,
        direction: 'download',
        sourcePath: downloadTarget.path,
        targetPath: `${dir.trim().replace(/\/+$/, '')}/${downloadTarget.name}`,
        recursive: downloadTarget.type === 'directory',
        conflictPolicy,
      })
      toast.info(`已提交下载：${downloadTarget.name}`)
    } catch (err) {
      toast.error(`下载提交失败：${errorText(err)}`)
    }
  }

  /** 打开主进程原生文件/目录选择器。取消是正常返回，不当异常。 */
  const pickLocal = async (mode: 'file' | 'directory', multiple: boolean): Promise<string[]> => {
    try {
      const res = await invoke<
        'app',
        'pickLocalPath',
        Record<string, unknown>,
        { canceled: boolean; paths: string[] }
      >('app', 'pickLocalPath', {
        mode,
        multiple,
        ...(mode === 'file'
          ? { title: '选择要上传的本地文件' }
          : { title: '选择下载保存目录' }),
        ...(localDir ? { defaultPath: localDir } : {}),
      })
      if (res?.canceled) return []
      return res?.paths ?? []
    } catch (err) {
      toast.error(`打开文件选择器失败：${errorText(err)}`)
      return []
    }
  }

  const openRemoteEditor = async (entry: RemoteEntry): Promise<void> => {
    if (!sessionId) return
    try {
      const res = await invoke<'sftp', 'openEditor', Record<string, unknown>, OpenEditorResult>(
        'sftp',
        'openEditor',
        { sessionId, path: entry.path },
      )
      // 物化到本地临时文件的用途就是「编辑」，所以直接交给系统默认程序打开，
      // 不再让用户去文件管理器里自己双击
      await invoke<'app', 'openPath', { path: string }, { opened: boolean }>('app', 'openPath', {
        path: res.localPath,
      })
      toast.ok(`已用系统编辑器打开：${res.localPath}`)
    } catch (err) {
      toast.error(`打开失败：${errorText(err)}`)
    }
  }

  /**
   * 批量任务统一执行壳：逐项记状态 → 结束**如实汇总**（成功几个、失败几个、原因）。
   * 三种批量操作共用它，避免各写一套导致口径不一致。
   * `run` 返回 transferId → 异步任务（下载）；返回带 changed/error 的对象 → chmod 的富结果。
   */
  const runBatch = useCallback(
    async (
      kind: BatchKind,
      targets: RemoteEntry[],
      note: string | undefined,
      run: (
        entry: RemoteEntry,
      ) => Promise<string | { changed?: number; details?: string[]; error?: string } | void>,
    ): Promise<BatchReport> => {
      let report = createBatchReport(kind, targets, note)
      setBatchReport(report)
      for (const entry of targets) {
        report = markItem(report, entry.path, { status: 'running' })
        setBatchReport(report)
        try {
          const outcome = await run(entry)
          if (typeof outcome === 'string') {
            // 异步任务（下载）：拿到 transferId，最终状态由传输事件改写
            report = markItem(report, entry.path, { status: 'submitted', transferId: outcome })
          } else if (outcome && typeof outcome === 'object') {
            // 富结果（chmod）：目标内部可能"改了 N 项、失败 M 项"，必须分别报出来
            const extra = {
              ...(outcome.changed === undefined ? {} : { changed: outcome.changed }),
              ...(outcome.details === undefined ? {} : { details: outcome.details }),
            }
            report = outcome.error
              ? markItem(report, entry.path, { status: 'failed', error: outcome.error, ...extra })
              : markItem(report, entry.path, { status: 'ok', ...extra })
          } else {
            report = markItem(report, entry.path, { status: 'ok' })
          }
        } catch (err) {
          report = markItem(report, entry.path, { status: 'failed', error: errorText(err) })
        }
        setBatchReport(report)
      }
      report = finishReport(report)
      setBatchReport(report)

      const summary = formatBatchSummary(report)
      if (hasFailures(report)) {
        // 部分失败绝不能只说"完成"：把失败项与原因一并抛给用户
        toast.warn(`${summary}｜${batchFailureLines(report).join('；')}`)
      } else {
        toast.ok(summary)
      }
      return report
    },
    [],
  )

  const runBatchDownload = (dir: string): void => {
    if (!sessionId) return
    const targets = pickedEntries.slice()
    const target = dir.trim().replace(/\/+$/, '')
    if (target === '' || targets.length === 0) return
    rememberLocalDir(target)
    setLocalDir(target)
    setBatchDownloadOpen(false)
    setSelection(clearSelection())
    void runBatch('download', targets, '目录会递归下载；每一项的最终结果见下方传输队列与本面板', async (entry) => {
      const res = await invoke<'sftp', 'download', Record<string, unknown>, { id?: string }>(
        'sftp',
        'download',
        {
          sessionId,
          direction: 'download',
          sourcePath: entry.path,
          targetPath: `${target}/${entry.name}`,
          recursive: entry.type === 'directory',
          conflictPolicy,
        },
      )
      return res?.id
    })
  }

  const runBatchDelete = (): void => {
    if (!sessionId) return
    const targets = pickedEntries.slice()
    const dirs = countDirectories(targets)
    setBatchDeleteOpen(false)
    setSelection(clearSelection())
    void runBatch(
      'delete',
      targets,
      dirs > 0 ? `其中 ${dirs} 个目录会连同全部内容一起删除（递归，不可恢复）` : undefined,
      async (entry) => {
        await invoke<'sftp', 'remove', Record<string, unknown>, unknown>('sftp', 'remove', {
          sessionId,
          path: entry.path,
          recursive: entry.type === 'directory',
        })
      },
    ).then(() => reload())
  }

  /** 预备预览（只算不改）：走主进程 previewChmod */
  const previewChmodFor = useCallback(
    async (path: string, mode: number, recursive: boolean): Promise<ChmodPlanResult> => {
      if (!sessionId) throw new Error('会话不存在或已断开')
      return invoke<'sftp', 'previewChmod', Record<string, unknown>, ChmodPlanResult>(
        'sftp',
        'previewChmod',
        { sessionId, path, mode, recursive },
      )
    },
    [sessionId],
  )

  /**
   * 改权限（单目标与批量共用同一条路径）：支持递归，并把主进程返回的
   * `changed` / `failed[]` 如实落到结果面板（一个目标内部也可能部分成功）。
   */
  const runChmod = (mode: number, recursive: boolean, targets: RemoteEntry[]): void => {
    if (!sessionId || targets.length === 0) return
    const dirs = countDirectories(targets)
    setChmodTarget(null)
    setBatchChmodOpen(false)
    if (targets.length > 1) setSelection(clearSelection())
    const note = recursive
      ? `递归应用到目录内全部内容（符号链接不跟随，链接自身会改）；共 ${targets.length} 个目标${
          dirs > 0 ? `，其中 ${dirs} 个目录` : ''
        }`
      : dirs > 0
        ? `未勾递归：${dirs} 个目录只改目录自身（不进入其中）`
        : undefined

    void runBatch('chmod', targets, note, async (entry) => {
      const res = await invoke<'sftp', 'chmod', Record<string, unknown>, ChmodRunResult>('sftp', 'chmod', {
        sessionId,
        path: entry.path,
        mode,
        recursive,
      })
      return chmodStepOutcome(res)
    }).then(() => reload())
  }

  /* ── 树视图：动作 / 键盘（与列表共用同一套选择状态与动作） ───────────── */

  const expandNode = useCallback(
    (path: string): void => {
      setExpanded((prev) => expandPaths(prev, [path]))
      if (dirsRef.current[path] === undefined) void fetchDir(path)
    },
    [fetchDir],
  )

  const collapseNode = useCallback((path: string): void => {
    setExpanded((prev) => collapsePath(prev, path))
  }, [])

  /** chevron 点击：切开展开态；展开时按需取子项（已缓存则不重复请求） */
  const toggleNode = useCallback(
    (path: string): void => {
      const willExpand = !expandedRef.current.has(path)
      setExpanded((prev) => toggleExpanded(prev, path))
      if (willExpand && dirsRef.current[path] === undefined) void fetchDir(path)
    },
    [fetchDir],
  )

  /** 打开目录：展开它并把列表导航过去 —— 与列表双击同一语义（同一个 load） */
  const openDir = useCallback(
    (path: string): void => {
      expandNode(path)
      void load(path)
    },
    [expandNode, load],
  )

  /**
   * 切到树视图时把 cwd 揭示出来：展开祖先链并按需取回缺失的祖先目录。
   * 只处理树锚点之下的祖先 —— 锚点之上的路径本来就不在这棵树里。
   */
  const revealPath = useCallback(
    async (path: string): Promise<void> => {
      if (!treeRoot || path === treeRoot) {
        setActiveKey(null)
        return
      }
      const chain = ancestorsOf(path).filter((p) => isSelfOrDescendant(p, treeRoot))
      if (chain.length > 0) setExpanded((prev) => expandPaths(prev, chain))
      for (const dir of chain) {
        if (dirsRef.current[dir] === undefined) await fetchDir(dir)
      }
      setActiveKey(path)
    },
    [treeRoot, fetchDir],
  )

  const switchView = useCallback(
    (mode: SftpViewMode): void => {
      setViewMode(mode)
      rememberViewMode(mode)
      if (mode === 'tree') {
        if (cwd) void revealPath(cwd)
      } else {
        setActiveKey(null)
      }
    },
    [cwd, revealPath],
  )

  const onTreeRowClick = useCallback(
    (row: TreeNode<RemoteEntry>, mods: ClickMods): void => {
      // 复用列表的多选状态机；连选范围按"当前可见的树行"计算
      const ordered = treeRows.filter((r) => r.kind === 'entry').map((r) => r.path)
      setSelection((prev) => clickSelection(prev, ordered, row.path, mods))
      setActiveKey(row.key)
    },
    [treeRows],
  )

  /** Enter / 双击目录：与列表双击一致；文件不静默调起编辑器 */
  const onTreeActivate = useCallback(
    (row: TreeNode<RemoteEntry>): void => {
      if (row.kind !== 'entry' || !row.entry) return
      if (row.isDirectory) openDir(row.path)
      else setActiveKey(row.key)
    },
    [openDir],
  )

  const onTreeKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>): void => {
      const intent = treeKeyIntent<RemoteEntry>({
        key: e.key,
        ctrlKey: e.ctrlKey,
        metaKey: e.metaKey,
        shiftKey: e.shiftKey,
        rows: treeRows,
        activeKey,
      })
      switch (intent.kind) {
        case 'ignore':
          // 未识别的按键原样放行，绝不 preventDefault：终端快捷键不受影响
          return
        case 'move':
          e.preventDefault()
          e.stopPropagation()
          setActiveKey(intent.key)
          return
        case 'expand':
          e.preventDefault()
          e.stopPropagation()
          expandNode(intent.path)
          return
        case 'collapse':
          e.preventDefault()
          e.stopPropagation()
          collapseNode(intent.path)
          return
        case 'activate':
          e.preventDefault()
          e.stopPropagation()
          if (intent.isDirectory) openDir(intent.path)
          else setActiveKey(intent.key)
          return
        case 'selectAll':
          e.preventDefault()
          e.stopPropagation()
          setSelection(selectAll(treeRows.filter((r) => r.kind === 'entry').map((r) => r.path)))
          return
        case 'clear':
          e.preventDefault()
          e.stopPropagation()
          setSelection(clearSelection())
          return
      }
    },
    [treeRows, activeKey, expandNode, collapseNode, openDir],
  )

  /**
   * 右键先选中目标再打开；菜单动作作用于"看得见的选择"，
   * 并且只调用工具栏/批量条在用的那些 setter —— 不另写一套动作逻辑。
   */
  const openRowMenu = useCallback((entry: RemoteEntry, x: number, y: number): void => {
    setSelection((prev) => (prev.ids.includes(entry.path) ? prev : { ids: [entry.path], anchor: entry.path }))
    setMenu({ x, y, entry })
  }, [])

  const menuTargets = useMemo((): RemoteEntry[] => {
    if (!menu) return []
    if (selection.ids.length >= 2 && selection.ids.includes(menu.entry.path)) return pickedEntries
    return [menu.entry]
  }, [menu, selection, pickedEntries])

  const menuItems = useMemo((): ContextMenuItem[] => {
    if (!menu) return []
    const many = menuTargets.length
    const single = many === 1 ? menuTargets[0] : undefined
    const items: ContextMenuItem[] = []
    if (single) {
      items.push({
        id: 'open',
        label: single.type === 'directory' ? '打开目录' : '用内置编辑器打开',
        icon: single.type === 'directory' ? 'folder-open' : 'edit',
        onSelect: () => {
          if (single.type === 'directory') openDir(single.path)
          else setEditingPath(single.path)
        },
      })
      items.push({ id: 'download', label: '下载', icon: 'download', onSelect: () => setDownloadTarget(single) })
      items.push({ id: 'rename', label: '重命名', icon: 'edit', onSelect: () => setRenameTarget(single) })
    } else {
      items.push({
        id: 'batch-download',
        label: `批量下载（${many} 项）`,
        icon: 'download',
        onSelect: () => setBatchDownloadOpen(true),
      })
    }
    items.push({
      id: 'chmod',
      label: many > 1 ? `批量改权限（${many} 项）` : '权限',
      icon: 'sliders',
      separatorBefore: true,
      onSelect: () => {
        if (many > 1) setBatchChmodOpen(true)
        else if (single) setChmodTarget(single)
      },
    })
    items.push({
      id: 'delete',
      label: many > 1 ? `批量删除（${many} 项）` : '删除',
      icon: 'trash',
      danger: true,
      onSelect: () => {
        if (many > 1) setBatchDeleteOpen(true)
        else if (single) setDeleteTarget(single)
      },
    })
    items.push({
      id: 'copy-path',
      label: many > 1 ? `复制 ${many} 个路径` : '复制路径',
      icon: 'copy',
      separatorBefore: true,
      onSelect: () => {
        if (!navigator.clipboard) {
          toast.error('当前环境不支持剪贴板')
          return
        }
        void navigator.clipboard
          .writeText(menuTargets.map((e) => e.path).join('\n'))
          .then(() => toast.ok('已复制路径'))
          .catch(() => toast.error('复制路径失败'))
      },
    })
    return items
    // openDir 的依赖已包含 load/expandNode；setter 均来自 useState，引用稳定
  }, [menu, menuTargets, openDir])

  if (!sessionId) {
    return (
      <main className="content" aria-label="文件">
        <div className="conn-empty">
          <EmptyState
            icon="folder"
            title="没有可浏览的会话"
            text="SFTP 依附于一个已建立的 SSH 会话。先在连接中心连上一台服务器，再回到这里浏览远端文件。"
            actions={
              <Button variant="primary" icon="connections" onClick={() => actions.setView('connections')}>
                去连接中心
              </Button>
            }
          />
        </div>
      </main>
    )
  }

  return (
    <main className="content" aria-label={`${title} 文件`}>
      {bookmarks.length > 0 ? (
        <div className="sftp-bookmarks" aria-label="目录书签">
          <Icon name="star" size={12} />
          {bookmarks.map((b) => (
            <span key={b.id} className={`sftp-bm${b.path === cwd ? ' sftp-bm--active' : ''}`}>
              <button
                type="button"
                className="sftp-bm__go"
                title={b.path}
                onClick={() => void load(b.path)}
                onContextMenu={(e) => {
                  e.preventDefault()
                  setBmDialog({ mode: 'rename', id: b.id, path: b.path, name: b.name })
                }}
              >
                {b.name}
              </button>
              <button
                type="button"
                className="sftp-bm__del"
                aria-label={`删除书签 ${b.name}`}
                onClick={() => {
                  removeBookmark(b.id)
                  refreshBookmarks()
                  toast.ok(`已删除书签「${b.name}」`)
                }}
              >
                <Icon name="close" size={10} />
              </button>
            </span>
          ))}
          {/* 如实告知存储范围：书签在 localStorage，不参与零知识同步、也不随备份走 */}
          <span
            className="sftp-bookmarks__note"
            title="书签保存在本机存储里，不会同步到其它设备，也不随本地库备份导出"
          >
            仅本机保存，不参与同步
          </span>
        </div>
      ) : null}
      <div className="t-toolbar">
        <IconButton icon="chevron-left" label="上一级" disabled={!cwd || cwd === '/'} onClick={() => void load(parentRemote(cwd))} />
        <IconButton icon="home" label="主目录" onClick={() => void load('~')} />
        <IconButton icon="refresh" label="刷新" loading={loading} onClick={reload} />
        <IconButton
          icon="route"
          label={
            terminalCwd
              ? `定位到终端目录（${terminalCwd}）`
              : '定位到终端目录（尚未拿到终端 cwd）'
          }
          onClick={locateToTerminal}
        />
        <IconButton
          icon="star"
          label="把当前目录加为书签"
          disabled={!cwd}
          onClick={() =>
            setBmDialog({
              mode: 'add',
              path: cwd,
              name: cwd.split('/').filter(Boolean).pop() ?? '/',
            })
          }
        />
        <div className="t-toolbar__divider" />
        <IconButton icon="folder" label="新建文件夹" onClick={() => setMkdir(true)} />
        <IconButton
          icon="upload"
          label="上传"
          onClick={() => {
            setLocalFiles([])
            setUploadOpen(true)
          }}
        />
        <IconButton
          icon="download"
          label="下载"
          disabled={!selectedEntry}
          onClick={() => {
            if (selectedEntry) setDownloadTarget(selectedEntry)
          }}
        />
        <IconButton
          icon="edit"
          label="用内置编辑器打开（语法高亮 + 查找替换）"
          disabled={!selectedEntry}
          onClick={() => {
            if (selectedEntry && !selectedEntry.name.endsWith('/')) setEditingPath(selectedEntry.path)
          }}
        />
        <IconButton
          icon="download"
          label="用系统编辑器打开（物化到本地临时文件）"
          disabled={!selectedEntry}
          onClick={() => {
            if (selectedEntry) void openRemoteEditor(selectedEntry)
          }}
        />
        <div className="t-toolbar__spacer" />
        <div data-testid="sftp-view-toggle">
          <Segmented
            bare
            ariaLabel="SFTP 视图模式"
            value={viewMode}
            onChange={switchView}
            items={[
              { value: 'list', label: '列表', icon: 'list' },
              { value: 'tree', label: '树', icon: 'folder-open' },
            ]}
          />
        </div>
        <label className="sftp-row__perm" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <Checkbox checked={showHidden} onChange={setShowHidden} ariaLabel="显示隐藏文件" bare />
          显示隐藏
        </label>
      </div>

      <div className="sftp-crumbs">
        {breadcrumbSegments(cwd || '/').map((seg, i, arr) => (
          <span key={seg.path} style={{ display: 'inline-flex', alignItems: 'center' }}>
            <button
              type="button"
              className={`sftp-crumb${i === arr.length - 1 ? ' sftp-crumb--last' : ''}`}
              onClick={() => void load(seg.path)}
            >
              {seg.label}
            </button>
            {i < arr.length - 1 ? <span className="sftp-crumb__sep">/</span> : null}
          </span>
        ))}
      </div>

      {error ? (
        <div style={{ padding: '10px 12px 0' }}>
          <Banner tone="error" actions={<Button size="sm" onClick={reload}>重试</Button>}>
            {error}
          </Banner>
        </div>
      ) : null}

      <div className="sftp-head">
        <span>名称</span>
        <span style={{ textAlign: 'right' }}>大小</span>
        <span>权限</span>
        <span>修改时间</span>
      </div>

      {viewMode === 'list' ? (
        <div
          className="sftp-list"
          data-testid="sftp-list"
          tabIndex={0}
          role="listbox"
          aria-multiselectable
          // 快捷键只在列表被聚焦/鼠标落在列表里时生效 —— 绝不抢终端的 Ctrl+A
          onKeyDown={(e) => {
            const mod = e.ctrlKey || e.metaKey
            if (mod && (e.key === 'a' || e.key === 'A')) {
              e.preventDefault()
              e.stopPropagation()
              setSelection(selectAll(sorted.map((x) => x.path)))
              return
            }
            if (e.key === 'Escape') {
              e.preventDefault()
              setSelection(clearSelection())
            }
          }}
          onMouseDown={(e) => {
            const el = e.currentTarget
            if (document.activeElement !== el) el.focus()
            // 空白处按下清除选择；用 closest 判断，兼容虚拟列表的内层滚动容器
            if (!(e.target as HTMLElement).closest('[data-testid="sftp-row"]')) {
              setSelection(clearSelection())
            }
          }}
        >
          {loading && sorted.length === 0 ? (
            <Loading text="读取目录…" />
          ) : sorted.length === 0 && !error ? (
            <EmptyState icon="folder" title="空目录" text="这个目录下没有可显示的内容。" />
          ) : (
            <VirtualList
              items={sorted}
              rowHeight={30}
              className="sftp-scroll"
              getKey={(e) => e.path}
              renderRow={(entry) => {
                const kind = entryIconType(entry)
                const isDir = entry.type === 'directory'
                return (
                  <div
                    className={`sftp-row${isSelected(selection, entry.path) ? ' sftp-row--selected' : ''}`}
                    data-testid="sftp-row"
                    data-path={entry.path}
                    data-entry-type={entry.type}
                    aria-selected={isSelected(selection, entry.path)}
                    // 单击只改选择，**不做默认动作** —— 否则 Ctrl 点十个就会打开/下载十个
                    onClick={(e) => {
                      setSelection((prev) =>
                        clickSelection(prev, sorted.map((x) => x.path), entry.path, {
                          ctrl: e.ctrlKey,
                          meta: e.metaKey,
                          shift: e.shiftKey,
                        }),
                      )
                    }}
                    onDoubleClick={() => {
                      // 双击打开仅限单选；连选过程中双击不触发
                      if (isDir && selection.ids.length <= 1) void load(entry.path)
                    }}
                    // 与树视图共用同一个右键菜单（同一批 setter，不存在两套动作）
                    onContextMenu={(e) => {
                      e.preventDefault()
                      openRowMenu(entry, e.clientX, e.clientY)
                    }}
                  >
                    <div className={`sftp-row__name${isDir ? ' sftp-row__name--dir' : kind === 'link' ? ' sftp-row__name--link' : ''}`}>
                      <Icon name={kind === 'folder' ? 'folder' : kind === 'link' ? 'connections' : 'notes'} size={13} />
                      <span title={entry.name}>{entry.name}</span>
                      {kind === 'link' ? <Badge tone="outline">软链</Badge> : null}
                    </div>
                    <span className="sftp-row__num" style={{ textAlign: 'right' }}>
                      {isDir ? '—' : formatBytes(entry.size)}
                    </span>
                    <span className="sftp-row__perm">{entry.permissions}</span>
                    <span className="sftp-row__num">{formatDate(new Date(entry.mtime).toISOString())}</span>
                  </div>
                )
              }}
            />
          )}
        </div>
      ) : (
        <SftpTree
          rows={treeRows}
          selection={selection}
          activeKey={activeKey}
          loading={loading && treeRootEntries.length === 0}
          emptyText={treeRoot ? `「${treeRoot}」下没有可显示的内容。` : '还没有拿到远端主目录。'}
          onRowClick={onTreeRowClick}
          onRowDoubleClick={onTreeActivate}
          onToggle={(row) => toggleNode(row.path)}
          onContextMenu={(row, x, y) => {
            if (row.entry) openRowMenu(row.entry, x, y)
          }}
          onKeyDown={onTreeKeyDown}
          onBlankMouseDown={() => setSelection(clearSelection())}
          onRetry={(row) => void fetchDir(row.path)}
        />
      )}

      {multiSelecting ? (
        <div className="sftp-queue__head sftp-batchbar" data-testid="batch-toolbar">
          <span className="tx__file" data-testid="batch-selection-count">
            已选 {selection.ids.length} 项{pickedDirs > 0 ? `（含 ${pickedDirs} 个目录）` : ''}
          </span>
          <Button
            size="sm"
            variant="ghost"
            icon="download"
            data-testid="batch-download"
            onClick={() => {
              setLocalFiles([])
              setBatchDownloadOpen(true)
            }}
          >
            批量下载
          </Button>
          <Button
            size="sm"
            variant="ghost"
            icon="sliders"
            data-testid="batch-chmod"
            onClick={() => setBatchChmodOpen(true)}
          >
            批量改权限
          </Button>
          <Button
            size="sm"
            variant="danger"
            icon="trash"
            data-testid="batch-delete"
            onClick={() => setBatchDeleteOpen(true)}
          >
            批量删除
          </Button>
          <IconButton
            icon="close"
            label="清除选择"
            data-testid="batch-clear"
            onClick={() => setSelection(clearSelection())}
          />
        </div>
      ) : selected ? (
        <div className="sftp-queue__head">
          <span className="tx__file" title={selected}>
            {selected}
          </span>
          <Button size="sm" variant="ghost" icon="edit" onClick={() => {
            if (selectedEntry) setRenameTarget(selectedEntry)
          }}>
            重命名
          </Button>
          <Button size="sm" variant="ghost" icon="sliders" onClick={() => {
            if (selectedEntry) setChmodTarget(selectedEntry)
          }}>
            权限
          </Button>
          <Button size="sm" variant="danger" icon="trash" onClick={() => {
            if (selectedEntry) setDeleteTarget(selectedEntry)
          }}>
            删除
          </Button>
          <IconButton icon="close" label="取消选择" onClick={() => setSelection(clearSelection())} />
        </div>
      ) : null}

      {batchReport ? <BatchPanel report={batchReport} onClose={() => setBatchReport(null)} /> : null}

      <TransferQueue sessionId={sessionId} />

      {/* ── 弹窗 ── */}
      <Prompt
        open={mkdir}
        title="新建文件夹"
        label="文件夹名"
        initial=""
        onClose={() => setMkdir(false)}
        onSubmit={async (name) => {
          if (!name.trim()) return
          try {
            await invoke<'sftp', 'mkdir', Record<string, unknown>, unknown>('sftp', 'mkdir', {
              sessionId,
              path: joinRemote(cwd, name.trim()),
            })
            setMkdir(false)
            reload()
          } catch (err) {
            toast.error(`创建失败：${errorText(err)}`)
          }
        }}
      />

      <Prompt
        open={renameTarget !== null}
        title="重命名"
        label="新名称"
        initial={renameTarget?.name ?? ''}
        onClose={() => setRenameTarget(null)}
        onSubmit={async (name) => {
          if (!renameTarget || !name.trim()) return
          try {
            await invoke<'sftp', 'rename', Record<string, unknown>, unknown>('sftp', 'rename', {
              sessionId,
              from: renameTarget.path,
              to: joinRemote(parentRemote(renameTarget.path), name.trim()),
              overwrite: false,
            })
            setRenameTarget(null)
            setSelection(clearSelection())
            reload()
          } catch (err) {
            toast.error(`重命名失败：${errorText(err)}`)
          }
        }}
      />

      <ChmodDialog
        open={chmodTarget !== null}
        targets={chmodTarget ? [chmodTarget] : []}
        initialMode={chmodTarget ? modeToOctal(chmodTarget.mode) : undefined}
        preview={previewChmodFor}
        onClose={() => setChmodTarget(null)}
        onRun={(mode, recursive) => runChmod(mode, recursive, chmodTarget ? [chmodTarget] : [])}
      />

      <Modal
        open={deleteTarget !== null}
        size="sm"
        title="删除远端条目"
        onClose={() => setDeleteTarget(null)}
        footer={
          <>
            <div className="t-modal__footer-spacer" />
            <Button variant="ghost" onClick={() => setDeleteTarget(null)}>
              取消
            </Button>
            <Button
              variant="danger"
              onClick={async () => {
                if (!deleteTarget) return
                try {
                  await invoke<'sftp', 'remove', Record<string, unknown>, unknown>('sftp', 'remove', {
                    sessionId,
                    path: deleteTarget.path,
                    recursive: deleteTarget.type === 'directory',
                  })
                  toast.ok(`已删除 ${deleteTarget.name}`)
                  setDeleteTarget(null)
                  setSelection(clearSelection())
                  reload()
                } catch (err) {
                  toast.error(`删除失败：${errorText(err)}`)
                }
              }}
            >
              删除
            </Button>
          </>
        }
      >
        <p className="t-field__hint" style={{ marginTop: 0 }}>
          将删除 <code className="mono">{deleteTarget?.path}</code>
          {deleteTarget?.type === 'directory' ? '（目录及其全部内容）' : ''}。
          这是**不可恢复**的远端操作，不走废纸篓。
        </p>
      </Modal>

      <Modal
        open={uploadOpen}
        title="上传到远端"
        onClose={() => setUploadOpen(false)}
        footer={
          <>
            <div className="t-modal__footer-spacer" />
            <Button variant="ghost" onClick={() => setUploadOpen(false)}>
              取消
            </Button>
            <Button variant="primary" icon="upload" disabled={localFiles.length === 0} onClick={() => void submitUpload()}>
              开始上传
            </Button>
          </>
        }
      >
        <div className="t-grid">
          <Field
            label="本地文件"
            required
            hint="用选择按钮挑文件（支持多选）；也可直接手填绝对路径后回车追加。"
            aside={
              <Button
                size="sm"
                variant="outline"
                icon="folder"
                onClick={() => {
                  void pickLocal('file', true).then((paths) => {
                    if (paths.length > 0) setLocalFiles((prev) => [...new Set([...prev, ...paths])])
                  })
                }}
              >
                选择文件
              </Button>
            }
          >
            <TextInput
              mono
              placeholder="选择文件，或粘贴路径后回车"
              onKeyDown={(e) => {
                if (e.key !== 'Enter') return
                const v = e.currentTarget.value.trim()
                if (!v) return
                setLocalFiles((prev) => [...new Set([...prev, v])])
                e.currentTarget.value = ''
              }}
            />
          </Field>
          {localFiles.length > 0 ? (
            <div className="sftp-picked">
              {localFiles.map((f) => (
                <div className="sftp-picked__row" key={f}>
                  <Icon name="notes" size={12} />
                  <span className="mono" title={f}>
                    {f}
                  </span>
                  <IconButton
                    icon="close"
                    label={`移除 ${f}`}
                    size={12}
                    onClick={() => setLocalFiles((prev) => prev.filter((x) => x !== f))}
                  />
                </div>
              ))}
            </div>
          ) : null}
          <Field label="远端目标目录">
            <TextInput value={cwd} mono readOnly />
          </Field>
          <div style={{ display: 'flex', gap: 18, alignItems: 'center' }}>
            <Checkbox checked={recursive} onChange={setRecursive} label="目录递归上传" />
            <span className="t-field__hint">
              同名冲突策略：<Badge tone="outline">{conflictPolicy}</Badge>（在设置 → 文件传输里改）
            </span>
          </div>
        </div>
      </Modal>

      <Modal
        open={downloadTarget !== null}
        title={`下载 ${downloadTarget?.name ?? ''}`}
        onClose={() => setDownloadTarget(null)}
        footer={
          <>
            <div className="t-modal__footer-spacer" />
            <Button variant="ghost" onClick={() => setDownloadTarget(null)}>
              取消
            </Button>
            <Button variant="primary" icon="download" disabled={!localDir.trim()} onClick={() => void submitDownload(localDir)}>
              开始下载
            </Button>
          </>
        }
      >
        <div className="t-grid">
          <Field
            label="保存到本地目录"
            required
            hint="用选择按钮挑目录；也会记住上次选择。"
            aside={
              <Button
                size="sm"
                variant="outline"
                icon="folder"
                onClick={() => {
                  void pickLocal('directory', false).then((paths) => {
                    if (paths[0]) setLocalDir(paths[0])
                  })
                }}
              >
                选择目录
              </Button>
            }
          >
            <TextInput value={localDir} mono placeholder="/home/you/Downloads" onChange={(e) => setLocalDir(e.target.value)} />
          </Field>
          <Field label="远端源">
            <TextInput value={downloadTarget?.path ?? ''} mono readOnly />
          </Field>
          <span className="t-field__hint">
            {downloadTarget?.type === 'directory' ? '目录会递归下载。' : ''}
            同名冲突策略：<Badge tone="outline">{conflictPolicy}</Badge>
          </span>
        </div>
      </Modal>
    
      {/* ── 批量：删除（二次确认，说清删哪些、多少、目录递归） ── */}
      <Modal
        open={batchDeleteOpen}
        size="sm"
        title={`批量删除 ${pickedEntries.length} 项`}
        onClose={() => setBatchDeleteOpen(false)}
        footer={
          <>
            <div className="t-modal__footer-spacer" />
            <Button variant="ghost" onClick={() => setBatchDeleteOpen(false)}>
              取消
            </Button>
            <Button variant="danger" data-testid="batch-delete-confirm" onClick={runBatchDelete}>
              删除 {pickedEntries.length} 项
            </Button>
          </>
        }
      >
        <p className="t-field__hint" style={{ marginTop: 0 }}>
          将删除以下 <b data-testid="batch-delete-count">{pickedEntries.length}</b> 项
          {pickedDirs > 0 ? `，其中 ${pickedDirs} 个目录会连同**全部内容**一起删除（递归）` : ''}：
        </p>
        <ul className="sftp-batch__preview">
          {pickedEntries.slice(0, 15).map((e) => (
            <li key={e.path}>
              <code className="mono">{e.path}</code>
              {e.type === 'directory' ? <span className="sftp-batch__dir">目录·递归</span> : null}
            </li>
          ))}
        </ul>
        {pickedEntries.length > 15 ? (
          <p className="t-field__hint">…还有 {pickedEntries.length - 15} 项（完整清单见执行结果面板）</p>
        ) : null}
        <p className="t-field__hint">这是**不可恢复**的远端操作，不走废纸篓。</p>
      </Modal>

      {/* ── 批量：改权限（含递归与预备命令预览） ── */}
      <ChmodDialog
        open={batchChmodOpen}
        targets={pickedEntries}
        preview={previewChmodFor}
        onClose={() => setBatchChmodOpen(false)}
        onRun={(mode, recursive) => runChmod(mode, recursive, pickedEntries)}
      />

      {/* ── 批量：下载 ── */}
      <Modal
        open={batchDownloadOpen}
        title={`批量下载 ${pickedEntries.length} 项`}
        onClose={() => setBatchDownloadOpen(false)}
        footer={
          <>
            <div className="t-modal__footer-spacer" />
            <Button variant="ghost" onClick={() => setBatchDownloadOpen(false)}>
              取消
            </Button>
            <Button
              variant="primary"
              icon="download"
              data-testid="batch-download-confirm"
              disabled={!localDir.trim() || pickedEntries.length === 0}
              onClick={() => runBatchDownload(localDir)}
            >
              开始下载
            </Button>
          </>
        }
      >
        <div className="t-grid">
          <Field
            label="保存到本地目录"
            required
            hint="每一项都会放到这个目录下（目录递归）。也会记住上次选择。"
            aside={
              <Button
                size="sm"
                variant="outline"
                icon="folder"
                onClick={() => {
                  void pickLocal('directory', false).then((paths) => {
                    if (paths[0]) setLocalDir(paths[0])
                  })
                }}
              >
                选择目录
              </Button>
            }
          >
            <TextInput value={localDir} mono placeholder="/home/you/Downloads" onChange={(e) => setLocalDir(e.target.value)} />
          </Field>
          <Field label={`远端源（${pickedEntries.length} 项）`}>
            <ul className="sftp-batch__preview">
              {pickedEntries.slice(0, 15).map((e) => (
                <li key={e.path}>
                  <code className="mono">{e.path}</code>
                  {e.type === 'directory' ? <span className="sftp-batch__dir">目录·递归</span> : null}
                </li>
              ))}
            </ul>
          </Field>
          <span className="t-field__hint">
            同名冲突策略：<Badge tone="outline">{conflictPolicy}</Badge>（在设置 → 文件传输里改）
          </span>
        </div>
      </Modal>

      {editingPath && sessionId ? (
        <RemoteEditor
          sessionId={sessionId}
          path={editingPath}
          onClose={() => setEditingPath(null)}
          onSaved={() => reload()}
        />
      ) : null}

      {/* 行右键菜单：列表与树共用（同一份菜单项构造） */}
      <ContextMenu
        open={menu !== null}
        x={menu?.x ?? 0}
        y={menu?.y ?? 0}
        items={menuItems}
        onClose={() => setMenu(null)}
      />

      {bmDialog ? (
        <Modal
          open
          size="sm"
          title={bmDialog.mode === 'add' ? '添加目录书签' : '重命名书签'}
          onClose={() => setBmDialog(null)}
          footer={
            <>
              <div className="t-modal__footer-spacer" />
              <Button variant="ghost" onClick={() => setBmDialog(null)}>
                取消
              </Button>
              <Button
                variant="primary"
                onClick={() => {
                  const name = bmDialog.name.trim()
                  if (bmDialog.mode === 'add') {
                    if (!connectionId) {
                      toast.error('这条会话还没有对应连接，无法保存书签')
                      return
                    }
                    addBookmark(connectionId, bmDialog.path, name)
                    toast.ok(`已收藏「${name || bmDialog.path}」`)
                  } else if (bmDialog.id) {
                    renameBookmark(bmDialog.id, name)
                  }
                  refreshBookmarks()
                  setBmDialog(null)
                }}
              >
                保存
              </Button>
            </>
          }
        >
          <Field label="书签名称" hint={`目录：${bmDialog.path}`}>
            <TextInput
              value={bmDialog.name}
              autoFocus
              onChange={(e) => setBmDialog({ ...bmDialog, name: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  const name = bmDialog.name.trim()
                  if (bmDialog.mode === 'add' && connectionId) addBookmark(connectionId, bmDialog.path, name)
                  else if (bmDialog.id) renameBookmark(bmDialog.id, name)
                  refreshBookmarks()
                  setBmDialog(null)
                }
              }}
            />
          </Field>
        </Modal>
      ) : null}
</main>
  )
}
