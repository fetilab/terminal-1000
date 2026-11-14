// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 远端文件的内置编辑器（Monaco）。
 *
 * ## 与「用系统编辑器打开」的关系
 * 两条路都保留，用途不同：
 * - **系统编辑器**（`sftp.openEditor` + `app.openPath`）：走主进程的编辑登记表，
 *   它监听本地副本、变更时**自动写回**（`SFTP_EDIT_SAVED` 的 reason='auto'）。
 *   适合"想用自己的 VSCode/vim 改"的用户。
 * - **内置编辑器**（本文件）：读远端内容 → Monaco 里改 → 显式保存回远端。
 *   适合"不想离开应用"的场景。用 `sftp.readFile` / `sftp.writeFile`。
 *
 * ⚠️ 内置这条路**没有**主进程那份"登记表"来比对远端是否被改过，
 * 所以我自己做了一次等价保护：打开时记下 `mtime`，保存**前**再查一次 ——
 * 不一致就明确问用户"远端在编辑期间被改过，继续保存会覆盖别人的修改"。
 * 比"写完了再提示"更早一步，避免已经覆盖了才发现。
 */

import { useCallback, useEffect, useState } from 'react'
import { Badge, Banner, Loading } from '../../components/Feedback'
import { Button } from '../../components/Button'
import { Icon } from '../../components/Icon'
import { Modal } from '../../components/Modal'
import { toast } from '../../components/Toast'
import { invoke } from '../../lib/ipc'
import { errorText } from '../../lib/format'
import { CodeEditor } from './CodeEditor'
import { LANGUAGE_LABEL, languageForFile } from './language'
import './editor.css'

interface RemoteFileRead {
  path: string
  content: string
  size: number
  mtime: number
  mode: number
  truncated?: boolean
}

interface RemoteStat {
  path: string
  size: number
  mtime: number
  isDirectory?: boolean
}

export interface RemoteEditorProps {
  sessionId: string
  path: string
  onClose: () => void
  /** 保存成功后通知外层刷新目录（大小/时间可能变了） */
  onSaved?: () => void
}

export function RemoteEditor({ sessionId, path, onClose, onSaved }: RemoteEditorProps): React.JSX.Element {
  const [content, setContent] = useState('')
  const [original, setOriginal] = useState('')
  const [mtimeAtOpen, setMtimeAtOpen] = useState<number | null>(null)
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [conflict, setConflict] = useState<string | null>(null)

  const filename = path.split('/').pop() ?? path
  const language = languageForFile(filename)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const res = await invoke<'sftp', 'readFile', Record<string, unknown>, RemoteFileRead>(
          'sftp',
          'readFile',
          { sessionId, path },
        )
        if (cancelled) return
        setContent(res.content)
        setOriginal(res.content)
        setMtimeAtOpen(res.mtime)
        setState('ready')
        if (res.truncated) {
          setError('文件太大，只读取了一部分 —— 直接保存会把远端截断，请改用系统编辑器或下载后再编辑。')
        }
      } catch (err) {
        if (!cancelled) {
          setError(errorText(err))
          setState('failed')
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [sessionId, path])

  const dirty = content !== original

  const doSave = useCallback(async () => {
    setSaving(true)
    try {
      const res = await invoke<'sftp', 'writeFile', Record<string, unknown>, { path: string; bytes: number }>(
        'sftp',
        'writeFile',
        { sessionId, path, content },
      )
      setOriginal(content)
      toast.ok(`已保存到远端：${path}（${res?.bytes ?? content.length} 字节）`)
      onSaved?.()
    } catch (err) {
      // 失败必须显眼
      toast.error(`保存到远端失败：${errorText(err)}`)
      setError(`保存失败：${errorText(err)}`)
    } finally {
      setSaving(false)
    }
  }, [sessionId, path, content, onSaved])

  /** 保存**前**比对远端 mtime：变了就先问，别先覆盖再提示 */
  const save = useCallback(async () => {
    if (!dirty) {
      toast.info('内容没有变化')
      return
    }
    setConflict(null)
    try {
      const st = await invoke<'sftp', 'stat', Record<string, unknown>, RemoteStat>('sftp', 'stat', {
        sessionId,
        path,
      })
      if (mtimeAtOpen !== null && st.mtime !== mtimeAtOpen) {
        setConflict(
          '这个文件在你编辑期间被改过（远端 mtime 变了）。继续保存会**覆盖别人的修改**；' +
            '建议先取消、重新打开确认差异。',
        )
        return
      }
    } catch {
      // 查不到 mtime 不阻塞保存：这只是一道额外保护，不是前置条件
    }
    await doSave()
  }, [dirty, sessionId, path, mtimeAtOpen, doSave])

  return (
    <Modal
      open
      size="lg"
      title={`编辑 ${filename}`}
      subtitle={path}
      onClose={onClose}
      footer={
        <>
          {dirty ? <Badge tone="warn">未保存</Badge> : <Badge tone="ok">已同步</Badge>}
          <span className="form-footer-hint">
            {LANGUAGE_LABEL[language] ?? language} · 保存写回远端
          </span>
          <div className="t-modal__footer-spacer" />
          <Button variant="ghost" onClick={onClose}>
            关闭
          </Button>
          <Button variant="primary" loading={saving} disabled={!dirty || state !== 'ready'} onClick={() => void save()}>
            保存到远端
          </Button>
        </>
      }
    >
      {error ? (
        <div style={{ marginBottom: 12 }}>
          <Banner tone="error">{error}</Banner>
        </div>
      ) : null}

      {conflict ? (
        <div style={{ marginBottom: 12 }}>
          <Banner
            tone="warn"
            actions={
              <Button
                size="sm"
                variant="danger"
                onClick={() => {
                  setConflict(null)
                  void doSave()
                }}
              >
                仍然覆盖
              </Button>
            }
          >
            {conflict}
          </Banner>
        </div>
      ) : null}

      {state === 'loading' ? (
        <Loading text="读取远端文件…" />
      ) : (
        <CodeEditor
          value={content}
          language={language}
          height={460}
          ariaLabel={`编辑 ${filename}`}
          onChange={setContent}
          onSave={() => void save()}
          statusLeft={
            <>
              <Icon name="server" size={12} /> 远端 · {path}
            </>
          }
        />
      )}
    </Modal>
  )
}

export default RemoteEditor
