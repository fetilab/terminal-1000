// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 会话日志：录制列表 + 内容查看。
 *
 * 三个要点：
 * 1. **敏感信息提示不省**：命令里出现的密码、token、私钥片段会**原样落盘**，
 *    这是会话日志的固有性质（它记录的就是原始输出）。界面上必须明说，
 *    并在删除时保持同样直白。
 * 2. **分页要区分方向**：`read` 返回 `hasMoreBefore` / `hasMoreAfter`，
 *    不能只看 `hasMore` —— 从尾部读时"有更多"指的是更早的内容（向上翻），
 *    搞混会让上下翻页按钮同时变灰或同时可点。
 * 3. 一次读取有上限（主进程 256KB），所以不要试图"全量加载"。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { Button, IconButton } from '../../components/Button'
import { Badge, Banner, EmptyState, Loading } from '../../components/Feedback'
import { Icon } from '../../components/Icon'
import { Modal } from '../../components/Modal'
import { toast } from '../../components/Toast'
import { formatBytes, formatDate, formatRelativeTime } from '../../lib/format'
import {
  deleteSessionLog,
  loadRecordingSettings,
  loadSessionLogs,
  readSessionLog,
  saveRecordingSettings,
  stopSessionLog,
  useStoreShallow,
  type LogReadResult,
  type RecordingSummary,
} from '../../lib/store'
import { Switch, TextInput } from '../../components/Form'
import { Section } from '../../components/Button'
import { ReplayPlayer } from './ReplayPlayer'
import './sessionlog.css'

const READ_LIMIT = 256 * 1024

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length
}

/* ── 侧栏 ─────────────────────────────────────── */

export function SessionLogSidebar(): React.JSX.Element {
  const { logs, active } = useStoreShallow((s) => ({
    logs: s.sessionLogs,
    active: s.activeRecordings,
  }))

  return (
    <aside className="panel" aria-label="会话日志">
      <header className="panel-header">
        <span className="panel-title">会话日志</span>
        <IconButton icon="refresh" label="刷新" onClick={() => void loadSessionLogs()} />
      </header>
      <div className="panel-body">
        <div className="tree">
          <div className="tree__section">正在录制（{active.length}）</div>
          {active.length === 0 ? (
            <div className="tree__empty">没有正在录制的会话。在终端里右键可以开始记录。</div>
          ) : (
            active.map((r) => (
              <div className="log-active" key={r.logId}>
                <span className="rec-dot" aria-label="录制中" />
                <div className="log-active__body">
                  <div className="log-active__title">{r.title}</div>
                  <div className="log-active__meta">
                    {formatBytes(r.bytes)} · {formatRelativeTime(r.startedAt)}
                  </div>
                  {r.bytes === 0 ? (
                    <div className="log-active__warn">尚未收到任何输出</div>
                  ) : null}
                </div>
                <IconButton
                  icon="stop"
                  label={`停止记录 ${r.title}`}
                  size={12}
                  tone="danger"
                  onClick={() => void stopSessionLog(r.sessionId)}
                />
              </div>
            ))
          )}

          <div className="tree__section">已保存（{logs.length}）</div>
          {logs.length === 0 ? (
            <div className="tree__empty">还没有保存的日志。</div>
          ) : (
            <div className="log-summary">
              最早 {formatRelativeTime(logs[logs.length - 1]?.startedAt)}
              <br />
              最新 {formatRelativeTime(logs[0]?.startedAt)}
            </div>
          )}
        </div>
      </div>
      <div className="panel-footer">
        <Button
          size="sm"
          variant="outline"
          icon="stop"
          disabled={active.length === 0}
          style={{ flex: 1 }}
          onClick={() => void stopSessionLog()}
        >
          停止全部录制
        </Button>
      </div>
    </aside>
  )
}

/* ── 内容查看器 ───────────────────────────────── */

function Viewer({ log }: { log: RecordingSummary }): React.JSX.Element {
  const [page, setPage] = useState<LogReadResult | null>(null)
  const [loading, setLoading] = useState(false)
  const scrollerRef = useRef<HTMLPreElement | null>(null)

  const load = useCallback(
    async (opts: { offset?: number; fromEnd?: boolean }) => {
      setLoading(true)
      const res = await readSessionLog(log.logId, { limit: READ_LIMIT, ...opts })
      setLoading(false)
      if (res) {
        setPage(res)
        requestAnimationFrame(() => {
          const el = scrollerRef.current
          if (!el) return
          // 从尾部加载时停在末尾（最新内容）；向更早翻时停在顶部，阅读顺序才自然
          el.scrollTop = opts.fromEnd ? el.scrollHeight : 0
        })
      }
    },
    [log.logId],
  )

  // 打开某条日志时默认读尾部（最新）
  useEffect(() => {
    setPage(null)
    void load({ fromEnd: true })
  }, [load])

  const canUp = page?.hasMoreBefore === true
  const canDown = page?.hasMoreAfter === true
  const startOffset = page?.offset ?? 0
  const endOffset = page ? page.offset + byteLength(page.content) : 0

  return (
    <div className="log-viewer">
      <div className="log-viewer__head">
        <Icon name="notes" size={14} />
        <span className="log-viewer__title">{log.title}</span>
        <Badge tone="outline">{formatBytes(log.sizeBytes)}</Badge>
        {log.hasRecording ? (
          <Badge tone="accent">
            含录制 {log.frames ?? 0} 帧
            {log.recBytes ? ` · ${formatBytes(log.recBytes)}` : ''}
            {log.compressed ? '（已压缩）' : ''}
          </Badge>
        ) : (
          <Badge tone="warn">无录制数据</Badge>
        )}
        {log.skippedTicks ? <Badge>增量跳过 {log.skippedTicks}</Badge> : null}
        {log.hasTiming ? <Badge tone="accent">含时间线</Badge> : null}
        {log.stopReason ? (
          <Badge tone={log.stopReason.includes('上限') ? 'warn' : 'default'}>{log.stopReason}</Badge>
        ) : null}
        <div style={{ flex: 1 }} />
        <span className="metric__sub">
          {formatDate(log.startedAt)}
          {log.stoppedAt ? ` → ${formatDate(log.stoppedAt)}` : ''}
        </span>
        <IconButton icon="refresh" label="重新从尾部加载" onClick={() => void load({ fromEnd: true })} />
      </div>

      <div className="log-viewer__pager">
        <Button
          size="sm"
          variant="ghost"
          icon="chevron-down"
          disabled={!canUp || loading}
          title={canUp ? '加载更早的内容' : '已经是最早的内容'}
          onClick={() => void load({ offset: Math.max(0, startOffset - READ_LIMIT) })}
        >
          更早
        </Button>
        <span className="metric__sub">
          {formatBytes(startOffset)} – {formatBytes(endOffset)} / {formatBytes(page?.totalBytes ?? log.sizeBytes)}
        </span>
        <Button
          size="sm"
          variant="ghost"
          icon="chevron-right"
          disabled={!canDown || loading}
          title={canDown ? '加载更新的内容' : '已经是最新的内容'}
          onClick={() => void load({ offset: endOffset })}
        >
          更新
        </Button>
      </div>

      {loading && !page ? (
        <Loading text="读取日志…" />
      ) : (
        <pre className="log-viewer__text" ref={scrollerRef}>
          {page?.content || '（空日志）'}
        </pre>
      )}
    </div>
  )
}

/* ── 主视图 ───────────────────────────────────── */

export default function SessionLogView(): React.JSX.Element {
  const { logs, active, loading, ready, error } = useStoreShallow((s) => ({
    logs: s.sessionLogs,
    active: s.activeRecordings,
    loading: s.logsLoading,
    ready: s.logsReady,
    error: s.logsError,
  }))
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [replayId, setReplayId] = useState<string | null>(null)
  const [pendingDelete, setPendingDelete] = useState<RecordingSummary | null>(null)
  const recording = useStoreShallow((s) => ({ cfg: s.recordingSettings })).cfg

  useEffect(() => {
    void loadRecordingSettings()
  }, [])

  useEffect(() => {
    void loadSessionLogs()
  }, [])

  const selected = logs.find((l) => l.logId === selectedId) ?? null
  const replayTarget = logs.find((l) => l.logId === replayId) ?? null

  return (
    <main className="content" aria-label="会话日志">
      <div className="t-toolbar">
        <Icon name="notes" size={15} />
        <span className="panel-title">会话日志</span>
        <Badge>{logs.length} 份</Badge>
        {active.length > 0 ? (
          <Badge tone="danger">
            <span className="rec-dot" /> {active.length} 个录制中
          </Badge>
        ) : null}
        <div className="t-toolbar__spacer" />
        <IconButton icon="refresh" label="刷新列表" loading={loading} onClick={() => void loadSessionLogs()} />
      </div>

      {/* 敏感信息提示：始终可见，不做成可关闭的 toast */}
      <div style={{ padding: '10px 12px 0' }}>
        <Banner tone="warn">
          日志记录的是**终端的原始输出**：命令里出现过的密码、token、私钥片段都会原样落盘。
          分享或上传日志前请先自行检查与脱敏。
        </Banner>
      </div>

      {recording ? (
        <>
          <Section right={<Badge tone={recording.enabled ? 'accent' : 'default'}>{recording.enabled ? '允许录制' : '未启用'}</Badge>}>
            录制设置
          </Section>
          <div className="rec-settings">
            <div className="settings-switch-row">
              <Switch
                checked={recording.enabled}
                onChange={(v) => void saveRecordingSettings({ enabled: v })}
                label="允许录制（默认关闭）"
              />
              <div className="t-field__hint">
                录制会把终端输出**原样**写进快照文件，可能含口令与 token。
                默认关闭是刻意的：不该替用户决定留痕。
              </div>
            </div>
            <div className="settings-switch-row">
              <Switch
                checked={recording.autoCompress}
                onChange={(v) => void saveRecordingSettings({ autoCompress: v })}
                label="结束后自动压缩"
              />
              <div className="t-field__hint">实测可减少约 89% 体积，代价是停止时多等一点。</div>
            </div>
            <div className="settings-switch-row">
              <label className="t-field__label" htmlFor="rec-interval">快照间隔 (ms)</label>
              <TextInput
                id="rec-interval"
                type="number"
                mono
                value={String(recording.intervalMs)}
                onChange={(e) => void saveRecordingSettings({ intervalMs: Number(e.target.value) || 1000 })}
              />
              <div className="t-field__hint">最小 1000ms；填更小的值会被自动抬到 1000。</div>
            </div>
          </div>
        </>
      ) : null}

      {!ready && error ? (
        <div style={{ padding: '10px 12px 0' }}>
          <Banner tone="error">{error}</Banner>
        </div>
      ) : null}

      <div className="log-split">
        <div className="log-list">
          {logs.length === 0 ? (
            <EmptyState
              icon="notes"
              title="还没有日志"
              text="在终端里右键选择「开始记录日志」，或直接开始一段需要留痕的操作。录制中的会话会实时出现在左侧。"
            />
          ) : (
            logs.map((log) => (
              <div
                key={log.logId}
                className={`log-item${log.logId === selectedId ? ' log-item--active' : ''}`}
                role="button"
                tabIndex={0}
                onClick={() => setSelectedId(log.logId)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') setSelectedId(log.logId)
                }}
              >
                <div className="log-item__head">
                  <Icon name="notes" size={12} />
                  <span className="log-item__title">{log.title}</span>
                </div>
                <div className="log-item__meta">
                  <span>{formatDate(log.startedAt)}</span>
                  <span>{formatBytes(log.sizeBytes)}</span>
                  {log.hasRecording ? <span>{log.frames ?? 0} 帧</span> : <span>无录制</span>}
                  {log.stopReason ? <span>{log.stopReason}</span> : null}
                </div>
                <div className="log-item__actions">
                  <IconButton
                    icon="eye"
                    label={
                      log.hasRecording
                        ? `回放 ${log.title}`
                        : `${log.title} 无录制数据（仅文本日志），无法回放`
                    }
                    size={12}
                    tone={log.hasRecording ? 'accent' : 'default'}
                    disabled={!log.hasRecording}
                    onClick={(e) => {
                      e.stopPropagation()
                      setReplayId(log.logId)
                    }}
                  />
                  <IconButton
                    icon="trash"
                    label={`删除 ${log.title}`}
                    size={12}
                    tone="danger"
                    onClick={(e) => {
                      e.stopPropagation()
                      setPendingDelete(log)
                    }}
                  />
                </div>
              </div>
            ))
          )}
        </div>

        <div className="log-detail">
          {replayTarget ? (
            <ReplayPlayer
              logId={replayTarget.logId}
              title={replayTarget.title}
              onClose={() => setReplayId(null)}
            />
          ) : selected ? (
            <Viewer log={selected} key={selected.logId} />
          ) : (
            <EmptyState
              icon="search"
              title={logs.length === 0 ? '没有可查看的日志' : '选择左侧的一份日志'}
              text="内容按 256KB 分块加载，可以从尾部往前翻，不会一次性把几十兆推给界面。"
            />
          )}
        </div>
      </div>

      <Modal
        open={pendingDelete !== null}
        size="sm"
        title="删除日志"
        onClose={() => setPendingDelete(null)}
        footer={
          <>
            <div className="t-modal__footer-spacer" />
            <Button variant="ghost" onClick={() => setPendingDelete(null)}>
              取消
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                if (!pendingDelete) return
                void deleteSessionLog(pendingDelete.logId).then(() => {
                  if (selectedId === pendingDelete.logId) setSelectedId(null)
                  setPendingDelete(null)
                  toast.info('日志已从磁盘删除，不可恢复')
                })
              }}
            >
              删除
            </Button>
          </>
        }
      >
        <p className="t-field__hint" style={{ marginTop: 0 }}>
          将删除 <b>{pendingDelete?.title}</b>（{formatBytes(pendingDelete?.sizeBytes ?? 0)}）的
          .log、.timing 与 .meta.json 三个文件，**不可恢复**。
        </p>
      </Modal>
    </main>
  )
}
