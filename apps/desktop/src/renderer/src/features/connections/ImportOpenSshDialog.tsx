// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 导入 OpenSSH 配置（`~/.ssh/config`）。
 *
 * 两步走：**先 dryRun 预览 → 再确认导入**。预览不写库，所以能先让用户看清
 * "到底会带过来什么、什么没带过来"。
 *
 * 三处刻意设计：
 * 1. **`unsupported` 与 `errors` 如实展示**（后者带行号）—— 只报"导入了 N 条"
 *    会让用户以为配置完整迁移了，而实际上 `ProxyCommand` 这类指令根本没被带过来；
 * 2. **必须先解锁**：未解锁时导入会让私钥被静默丢弃，后端已改成 fail-fast 抛
 *    UNAUTHORIZED —— 界面上先解锁再导入，而不是让用户撞一次错误；
 * 3. 冲突策略默认 `skip`（最保守），不让导入意外覆盖已有连接。
 */

import { useCallback, useEffect, useState } from 'react'
import { Badge, Banner, Loading } from '../../components/Feedback'
import { Button } from '../../components/Button'
import { Field, Select, TextInput } from '../../components/Form'
import { Icon } from '../../components/Icon'
import { Modal } from '../../components/Modal'
import { toast } from '../../components/Toast'
import { invoke } from '../../lib/ipc'
import { errorText } from '../../lib/format'
import { loadConnections } from '../../lib/store'
import { ensureUnlocked } from '../../lib/vault'
import './connections.css'

interface ImportEntry {
  name: string
  host: string
  port: number
  username?: string
  warnings?: string[]
}

interface UnsupportedItem {
  directive: string
  host?: string
  reason?: string
}

interface ImportError {
  line: number
  message: string
  text?: string
}

interface ImportResult {
  source: string
  parsed: number
  created: number
  skipped: number
  renamed: number
  overwritten: number
  dryRun: boolean
  entries: ImportEntry[]
  unsupported: UnsupportedItem[]
  errors: ImportError[]
}

const POLICY_OPTIONS = [
  { value: 'skip', label: '跳过同名连接（默认，最保守）' },
  { value: 'rename', label: '重命名后导入（保留两边）' },
  { value: 'overwrite', label: '覆盖同名连接' },
]

export interface ImportOpenSshDialogProps {
  onClose: () => void
}

export function ImportOpenSshDialog({ onClose }: ImportOpenSshDialogProps): React.JSX.Element {
  const [path, setPath] = useState('')
  const [policy, setPolicy] = useState('skip')
  const [preview, setPreview] = useState<ImportResult | null>(null)
  const [result, setResult] = useState<ImportResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // 锁定状态：未解锁时导入会把私钥丢掉（后端 fail-fast），所以先查、先提示
  const [lock, setLock] = useState<{ unlocked: boolean; initialized: boolean } | null>(null)

  const checkLock = useCallback(async () => {
    try {
      const res = await invoke<
        'store',
        'isUnlocked',
        Record<string, never>,
        { unlocked: boolean; initialized: boolean }
      >('store', 'isUnlocked', {})
      setLock(res)
    } catch {
      setLock(null)
    }
  }, [])

  useEffect(() => {
    void checkLock()
  }, [checkLock])

  const doPreview = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const res = await invoke<'store', 'importOpenSsh', Record<string, unknown>, ImportResult>(
        'store',
        'importOpenSsh',
        {
          ...(path.trim() ? { path: path.trim() } : {}),
          dryRun: true,
          conflictPolicy: policy,
        },
      )
      setPreview(res)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  const doImport = async (): Promise<void> => {
    // 先过主密码闸门：未解锁时**就地弹窗**（创建主密码 / 解锁），
    // 而不是让用户对着置灰的按钮猜为什么不能点。
    const ok = await ensureUnlocked('导入 OpenSSH 配置会把私钥写入本地库，需要先解锁。')
    if (!ok) {
      toast.warn('未解锁本地库，导入已取消（避免私钥被丢弃）')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const res = await invoke<'store', 'importOpenSsh', Record<string, unknown>, ImportResult>(
        'store',
        'importOpenSsh',
        {
          ...(path.trim() ? { path: path.trim() } : {}),
          conflictPolicy: policy,
        },
      )
      setResult(res)
      await loadConnections(true)
      toast.ok(
        `导入完成：新增 ${res.created}，跳过 ${res.skipped}，重命名 ${res.renamed}，覆盖 ${res.overwritten}`,
      )
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  const shown = result ?? preview
  const locked = lock !== null && !lock.unlocked

  return (
    <Modal
      open
      size="lg"
      title="导入 OpenSSH 配置"
      subtitle="先预览、再导入；不会修改你的 ~/.ssh/config"
      onClose={onClose}
      footer={
        <>
          {shown ? (
            <span className="form-footer-hint">
              {shown.dryRun ? '这是预览，尚未写入' : `已写入：新增 ${shown.created} 条`}
            </span>
          ) : null}
          <div className="t-modal__footer-spacer" />
          <Button variant="ghost" onClick={onClose}>
            关闭
          </Button>
          <Button variant="outline" icon="search" loading={busy} onClick={() => void doPreview()}>
            {preview ? '重新预览' : '预览'}
          </Button>
          <Button
            variant="primary"
            icon="download"
            loading={busy}
            disabled={!preview || result !== null}
            onClick={() => void doImport()}
          >
            确认导入
          </Button>
        </>
      }
    >
      {locked ? (
        <div style={{ marginBottom: 14 }}>
          <Banner tone="info">
            本地库当前**已锁定**。点「确认导入」会先引导你
            {lock && !lock.initialized ? '创建主密码' : '解锁'}
            —— 未解锁时导入会让私钥被丢弃，所以后端改成直接报错而不是静默丢弃。
            预览不受影响，可以先看完再决定。
          </Banner>
        </div>
      ) : null}

      <div className="t-grid t-grid--2">
        <Field
          label="配置文件路径"
          hint="留空则读取 ~/.ssh/config。也可以指向任意一份 OpenSSH 格式的配置。"
        >
          <TextInput
            value={path}
            mono
            placeholder="~/.ssh/config"
            onChange={(e) => setPath(e.target.value)}
          />
        </Field>
        <Field label="同名连接的处理方式" hint="默认跳过，避免意外覆盖已有连接">
          <Select value={policy} onChange={(e) => setPolicy(e.target.value)} options={POLICY_OPTIONS} />
        </Field>
      </div>

      {error ? (
        <div style={{ marginTop: 14 }}>
          <Banner tone="error">{error}</Banner>
        </div>
      ) : null}

      {busy && !shown ? <Loading text="解析中…" /> : null}

      {shown ? (
        <>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 16, alignItems: 'center' }}>
            <Badge tone="accent">解析到 {shown.parsed} 个 Host</Badge>
            {shown.dryRun ? (
              <Badge>预览（未写入）</Badge>
            ) : (
              <>
                <Badge tone="ok">新增 {shown.created}</Badge>
                {shown.skipped > 0 ? <Badge tone="warn">跳过 {shown.skipped}</Badge> : null}
                {shown.renamed > 0 ? <Badge>重命名 {shown.renamed}</Badge> : null}
                {shown.overwritten > 0 ? <Badge tone="warn">覆盖 {shown.overwritten}</Badge> : null}
              </>
            )}
            <span className="metric__sub mono">{shown.source}</span>
          </div>

          {shown.entries.length > 0 ? (
            <>
              <div className="t-field__label" style={{ marginTop: 16, marginBottom: 5 }}>
                将导入的连接
              </div>
              <div className="sshimp__list">
                {shown.entries.map((e) => (
                  <div className="sshimp__row" key={`${e.name}-${e.host}`}>
                    <span>{e.name}</span>
                    <span className="mono">{e.host}</span>
                    <span className="mono">{e.port}</span>
                    {e.username ? (
                      <span className="t-field__hint">用户 {e.username}</span>
                    ) : null}
                    {e.warnings && e.warnings.length > 0 ? (
                      <span className="t-field__hint" style={{ gridColumn: '1 / -1' }}>
                        ⚠ {e.warnings.join('；')}
                      </span>
                    ) : null}
                  </div>
                ))}
              </div>
            </>
          ) : null}

          {/* 未支持的指令：必须如实列出，否则用户以为配置完整迁移了 */}
          {shown.unsupported.length > 0 ? (
            <>
              <div className="t-field__label" style={{ marginTop: 16, marginBottom: 5 }}>
                <Icon name="alert-triangle" size={12} /> 未支持的指令（{shown.unsupported.length}）
              </div>
              <div className="sshimp__list">
                {shown.unsupported.map((u, i) => (
                  <div className="sshimp__row sshimp__row--bad" key={`${u.directive}-${i}`}>
                    <span className="mono">{u.directive}</span>
                    <span>{u.host ?? '（全局）'}</span>
                    <span />
                    {u.reason ? (
                      <span className="t-field__hint" style={{ gridColumn: '1 / -1' }}>
                        {u.reason}
                      </span>
                    ) : null}
                  </div>
                ))}
              </div>
              <p className="t-field__hint">
                这些指令的语义**没有被导入**，对应连接可能需要手工补齐。
              </p>
            </>
          ) : null}

          {/* 语法错误：带行号，用户能直接去文件里定位 */}
          {shown.errors.length > 0 ? (
            <>
              <div className="t-field__label" style={{ marginTop: 16, marginBottom: 5 }}>
                <Icon name="alert-circle" size={12} /> 解析错误（{shown.errors.length}）
              </div>
              <div className="sshimp__list">
                {shown.errors.map((e, i) => (
                  <div className="sshimp__row sshimp__row--bad" key={`${e.line}-${i}`}>
                    <span>第 {e.line} 行</span>
                    <span style={{ gridColumn: '2 / -1' }}>{e.message}</span>
                    {e.text ? (
                      <span className="mono" style={{ gridColumn: '1 / -1' }}>
                        {e.text}
                      </span>
                    ) : null}
                  </div>
                ))}
              </div>
            </>
          ) : null}

          {shown.entries.length === 0 ? (
            <p className="t-field__hint" style={{ marginTop: 14 }}>
              没有解析到任何 Host。请确认路径正确、且文件里有 `Host` 段。
            </p>
          ) : null}
        </>
      ) : null}
    </Modal>
  )
}

export default ImportOpenSshDialog
