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
import { invoke } from '../../lib/ipc'
import { errorText, formatBytes, formatDate } from '../../lib/format'
import { actions, useStoreShallow } from '../../lib/store'
import { Button, IconButton } from '../../components/Button'
import { Badge, Banner, EmptyState, Loading } from '../../components/Feedback'
import { Checkbox, Field, TextInput } from '../../components/Form'
import { Icon } from '../../components/Icon'
import { Modal } from '../../components/Modal'
import { toast } from '../../components/Toast'
import { VirtualList } from '../../components/VirtualList'
import {
  breadcrumbSegments,
  entryIconType,
  joinRemote,
  modeToOctal,
  octalToMode,
  parentRemote,
  type OpenEditorResult,
  type RemoteEntry,
} from './sftpTypes'
import { markCancelled, useTransfers, wireTransferEvents, clearFinished, type TransferItem } from './transferStore'
import './sftp.css'

const LOCAL_DIR_KEY = 't1000:sftp-local-dir'

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
  const [entries, setEntries] = useState<RemoteEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [showHidden, setShowHidden] = useState(false)

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

  useEffect(() => {
    wireTransferEvents()
  }, [])

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
          { sessionId, path, showHidden },
        )
        // 丢弃过期响应：快速点面包屑时先发的可能后到
        if (mySeq !== seq.current) return
        setEntries(Array.isArray(list) ? list : [])
        setCwd(path)
      } catch (err) {
        if (mySeq !== seq.current) return
        setError(errorText(err))
        setEntries([])
      } finally {
        if (mySeq === seq.current) setLoading(false)
      }
    },
    [sessionId, showHidden],
  )

  // 首次进入：先问远端 home，避免猜错起始目录
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
        if (!cancelled && res?.path) void load(res.path)
      } catch (err) {
        if (!cancelled) {
          setError(errorText(err))
          void load('/')
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [sessionId, load])

  const sorted = useMemo(() => {
    const copy = entries.slice()
    copy.sort((a, b) => {
      // 目录永远排在文件前面，再按名字排
      const da = a.type === 'directory' ? 0 : 1
      const db = b.type === 'directory' ? 0 : 1
      if (da !== db) return da - db
      return a.name.localeCompare(b.name, 'zh-CN')
    })
    return copy
  }, [entries])

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
      <div className="t-toolbar">
        <IconButton icon="chevron-left" label="上一级" disabled={!cwd || cwd === '/'} onClick={() => void load(parentRemote(cwd))} />
        <IconButton icon="home" label="主目录" onClick={() => void load('~')} />
        <IconButton icon="refresh" label="刷新" loading={loading} onClick={reload} />
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
          disabled={!selected}
          onClick={() => {
            const entry = entries.find((e) => e.path === selected)
            if (entry) setDownloadTarget(entry)
          }}
        />
        <IconButton
          icon="edit"
          label="用系统编辑器打开（物化到本地临时文件）"
          disabled={!selected}
          onClick={() => {
            const entry = entries.find((e) => e.path === selected)
            if (entry) void openRemoteEditor(entry)
          }}
        />
        <div className="t-toolbar__spacer" />
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

      <div className="sftp-list">
        {loading && entries.length === 0 ? (
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
                  className={`sftp-row${selected === entry.path ? ' sftp-row--selected' : ''}`}
                  onClick={() => setSelected(entry.path)}
                  onDoubleClick={() => {
                    if (isDir) void load(entry.path)
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

      {selected ? (
        <div className="sftp-queue__head">
          <span className="tx__file" title={selected}>
            {selected}
          </span>
          <Button size="sm" variant="ghost" icon="edit" onClick={() => {
            const e = entries.find((x) => x.path === selected)
            if (e) setRenameTarget(e)
          }}>
            重命名
          </Button>
          <Button size="sm" variant="ghost" icon="sliders" onClick={() => {
            const e = entries.find((x) => x.path === selected)
            if (e) setChmodTarget(e)
          }}>
            权限
          </Button>
          <Button size="sm" variant="danger" icon="trash" onClick={() => {
            const e = entries.find((x) => x.path === selected)
            if (e) setDeleteTarget(e)
          }}>
            删除
          </Button>
          <IconButton icon="close" label="取消选择" onClick={() => setSelected(null)} />
        </div>
      ) : null}

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
            setSelected(null)
            reload()
          } catch (err) {
            toast.error(`重命名失败：${errorText(err)}`)
          }
        }}
      />

      <Prompt
        open={chmodTarget !== null}
        title="修改权限"
        label="八进制权限（如 644 / 755）"
        initial={chmodTarget ? modeToOctal(chmodTarget.mode) : ''}
        onClose={() => setChmodTarget(null)}
        onSubmit={async (value) => {
          if (!chmodTarget) return
          const mode = octalToMode(value)
          if (mode === undefined) {
            toast.warn('权限必须是 3~4 位八进制数字，例如 644')
            return
          }
          try {
            await invoke<'sftp', 'chmod', Record<string, unknown>, unknown>('sftp', 'chmod', {
              sessionId,
              path: chmodTarget.path,
              mode,
            })
            setChmodTarget(null)
            reload()
          } catch (err) {
            toast.error(`改权限失败：${errorText(err)}`)
          }
        }}
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
                  setSelected(null)
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
    </main>
  )
}
