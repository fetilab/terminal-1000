// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 同步面板。
 *
 * 这个面板最重要的事不是按钮，而是**把两个口令讲清楚**：
 *   登录口令 —— 证明「你是谁」（服务端账号）
 *   同步口令（仓库密码）—— 用来**加解密云端数据**，服务端拿不到
 * 两者混为一谈是这类产品最常见的误解，所以这里用并排卡片显式区分，
 * 并在「新建/换设备」时把同步口令单独拎出来。
 *
 * 零知识意味着：忘记同步口令 = 云端数据无法解密（服务端也没有）。
 */

import { useCallback, useEffect, useState } from 'react'
import { Events } from '@t1000/shared'
import { Button, Section } from '../../components/Button'
import { Badge, Banner, EmptyState, Loading } from '../../components/Feedback'
import { Field, Switch, TextInput } from '../../components/Form'
import { Icon } from '../../components/Icon'
import { toast } from '../../components/Toast'
import { invoke, subscribe } from '../../lib/ipc'
import {
  ServerIdentityPanel,
  classifySyncError,
  type SyncErrorInfo,
} from '../settings/ServerIdentityPanel'
import { errorText, formatRelativeTime } from '../../lib/format'
import { IpcCallError } from '../../lib/ipc'
import { actions } from '../../lib/store'

interface SyncStatus {
  enabled: boolean
  endpoint: string
  autoSync: boolean
  loggedIn: boolean
  state: 'idle' | 'syncing' | 'offline' | 'error'
  lastSyncAt: string | null
  lastVersion: number | null
  lastError: string | null
  conflictPolicy: string
  /** 传输方式：http 仅回环，tsc1 为加密通道 */
  transport: 'http' | 'tsc1'
  pinned: boolean
  pinnedFingerprint: string | null
}

export default function SyncPanel(): React.JSX.Element {
  const [status, setStatus] = useState<SyncStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [progress, setProgress] = useState<{ phase: string; done: number; total: number } | null>(null)
  const [conflict, setConflict] = useState<string | null>(null)
  /** 登录被拒时带过来的指纹；非空即展开服务端身份确认流程 */
  const [identityFingerprint, setIdentityFingerprint] = useState<string | null>(null)
  /** 登录失败的归类结果（身份变化要渲染成常驻告警，而不是只弹 toast） */
  const [identityError, setIdentityError] = useState<SyncErrorInfo | null>(null)

  const [endpoint, setEndpoint] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [passphrase, setPassphrase] = useState('')
  const [register, setRegister] = useState(false)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const res = await invoke<'sync', 'status', Record<string, never>, SyncStatus>('sync', 'status', {})
      setStatus(res)
      setEndpoint((prev) => prev || res.endpoint || '')
      setError(null)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
    const offState = subscribe(Events.SYNC_STATE, () => void refresh())
    const offProgress = subscribe(Events.SYNC_PROGRESS, (p) => {
      setProgress({ phase: p.phase, done: p.done, total: p.total })
    })
    return () => {
      offState()
      offProgress()
    }
  }, [refresh])

  const doLogin = async (): Promise<void> => {
    if (!endpoint.trim() || !username.trim() || !password) {
      toast.warn('后端地址、用户名、登录口令都要填')
      return
    }
    setBusy(true)
    try {
      const res = await invoke<
        'sync',
        'login',
        Record<string, unknown>,
        { username: string; remoteVersion: number | null; hasPassphrase: boolean }
      >('sync', 'login', {
        endpoint: endpoint.trim(),
        username: username.trim(),
        password,
        register,
        // 同步口令单独传；它就是解密云端数据的那把钥匙
        ...(passphrase ? { passphrase } : {}),
      })
      setPassword('')
      setPassphrase('')
      toast.ok(
        `已登录 ${res.username}${res.hasPassphrase ? '' : '；尚未设置同步口令，push 前需要先设置'}`,
      )
      await refresh()
    } catch (err) {
      handleSyncFailure(err, '登录')
    } finally {
      setBusy(false)
    }
  }

  /**
   * 同步操作失败的统一处理。
   *
   * 身份类错误必须在**任何**同步操作上都能变成常驻告警 —— 推送/拉取同样会撞上
   * 身份变化，只在登录处处理会漏掉它们。
   */
  const handleSyncFailure = useCallback((err: unknown, what: string): void => {
    const info = classifySyncError(err)
    if (info.kind === 'untrusted-server') {
      setIdentityFingerprint(info.fingerprint ?? '')
      setIdentityError(info)
      toast.warn('该同步服务端身份尚未确认，请先核对指纹')
      return
    }
    if (info.kind === 'identity-changed') {
      setIdentityFingerprint('')
      setIdentityError(info)
      toast.error('服务端身份与已记录的不一致，可能是中间人攻击，请先核对')
      return
    }
    if (info.kind === 'plaintext-not-allowed') {
      toast.error('明文传输被拒绝：请在设置里把传输方式改为 TSC/1')
      return
    }
    toast.error(`${what}失败：${errorText(err)}`)
  }, [])

  const doPush = async (force = false): Promise<void> => {
    setBusy(true)
    setConflict(null)
    try {
      await invoke<'sync', 'push', Record<string, unknown>, unknown>('sync', 'push', force ? { force } : {})
      toast.ok('已推送到云端')
      await refresh()
    } catch (err) {
      if (err instanceof IpcCallError && err.code === 'CONFLICT') {
        // 冲突不是"出错了"，而是需要用户做选择；用可操作的状态呈现而不是一句报错
        setConflict(err.message)
      } else if (err instanceof IpcCallError && (err.code === 'BAD_REQUEST' || err.code === 'UNAUTHORIZED')) {
        toast.warn(err.message)
        setConflict(null)
      } else {
        handleSyncFailure(err, '推送')
      }
    } finally {
      setBusy(false)
    }
  }

  const doPull = async (): Promise<void> => {
    setBusy(true)
    try {
      await invoke<'sync', 'pull', Record<string, unknown>, unknown>('sync', 'pull', { mode: 'merge' })
      toast.ok('已从云端拉取并合并')
      await refresh()
    } catch (err) {
      handleSyncFailure(err, '拉取')
    } finally {
      setBusy(false)
    }
  }

  const resolve = async (keep: 'local' | 'remote'): Promise<void> => {
    setBusy(true)
    try {
      await invoke<'sync', 'resolveConflict', Record<string, unknown>, unknown>('sync', 'resolveConflict', {
        keep,
      })
      toast.ok(keep === 'local' ? '已保留本地并覆盖云端' : '已采用远端并覆盖本地')
      setConflict(null)
      await refresh()
    } catch (err) {
      toast.error(`处置失败：${errorText(err)}`)
    } finally {
      setBusy(false)
    }
  }

  if (loading && !status) return <Loading text="读取同步状态…" />
  if (error && !status) {
    return (
      <div className="svc-body">
        <Banner tone="error" actions={<Button size="sm" onClick={() => void refresh()}>重试</Button>}>
          {error}
        </Banner>
      </div>
    )
  }
  if (!status) return <div />

  return (
    <div className="content-scroll svc-body">
      {/* ── 两个口令：本面板的核心概念 ── */}
      <Section>两个口令是两回事</Section>
      <div className="svc-passwords">
        <div className="svc-pass">
          <div className="svc-pass__head">
            <Icon name="user" size={14} />
            登录口令
          </div>
          <div className="svc-pass__what">
            证明「你是谁」。只用于登录自建同步后端，服务端保存的是它的哈希。
          </div>
          <div className="svc-pass__warn">忘了可以找服务端重置，不影响已有数据。</div>
        </div>
        <div className="svc-pass svc-pass--key">
          <div className="svc-pass__head">
            <Icon name="key" size={14} />
            同步口令（仓库密码）
          </div>
          <div className="svc-pass__what">
            <b>新设备用这个口令解密云端数据。</b>数据在本机加密后才上传，服务端只有密文。
          </div>
          <div className="svc-pass__warn">
            它只存在本机、服务端拿不到。<b>一旦忘记，云端数据无法解密</b>——这是零知识的代价，不是缺陷。
          </div>
        </div>
      </div>

      {/* ── 登录 ── */}
      <Section>账号与后端</Section>
      {status.loggedIn ? (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
            <Badge tone="ok">已登录</Badge>
            <span className="mono" style={{ fontSize: 12 }}>
              {status.endpoint || '（未设置地址）'}
            </span>
            <div style={{ flex: 1 }} />
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                void invoke<'sync', 'logout', Record<string, never>, unknown>('sync', 'logout', {})
                  .then(() => {
                    toast.ok('已退出登录')
                    return refresh()
                  })
                  .catch((err: unknown) => toast.error(`退出失败：${errorText(err)}`))
              }}
            >
              退出登录
            </Button>
          </div>
        </>
      ) : (
        <div className="t-grid t-grid--2" style={{ marginBottom: 8 }}>
          <Field label="后端地址" required className="t-grid__span2">
            <TextInput
              value={endpoint}
              mono
              placeholder="https://sync.example.com"
              onChange={(e) => setEndpoint(e.target.value)}
            />
          </Field>
          <Field label="用户名" required>
            <TextInput value={username} onChange={(e) => setUsername(e.target.value)} />
          </Field>
          <Field label="登录口令" required hint="证明身份用，不是加密口令">
            <TextInput
              type="password"
              value={password}
              autoComplete="off"
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
          <Field
            label="同步口令（仓库密码）"
            className="t-grid__span2"
            hint="至少 8 位。它就是加密/解密云端数据的钥匙；首次可在此设置，之后在新设备上必须填同一个才能解密。"
          >
            <TextInput
              type="password"
              value={passphrase}
              autoComplete="off"
              placeholder="留空表示沿用本机已保存的口令"
              onChange={(e) => setPassphrase(e.target.value)}
            />
          </Field>
          <div style={{ display: 'flex', alignItems: 'center', gap: 18 }}>
            <Switch checked={register} onChange={setRegister} label="没有账号，先注册" />
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <Button variant="primary" icon="cloud" loading={busy} onClick={() => void doLogin()}>
              {register ? '注册并登录' : '登录'}
            </Button>
          </div>
        </div>
      )}

      {/* ── 冲突处置 ── */}
      {conflict ? (
        <div style={{ margin: '14px 0' }}>
          <Banner
            tone="warn"
            actions={
              <>
                <Button size="sm" variant="outline" loading={busy} onClick={() => void resolve('local')}>
                  保留本地
                </Button>
                <Button size="sm" variant="outline" loading={busy} onClick={() => void resolve('remote')}>
                  采用远端
                </Button>
              </>
            }
          >
            云端与本机都有改动，自动合并被拒绝：{conflict}
            <br />
            选择「保留本地」会用本机数据覆盖云端；「采用远端」会用云端数据覆盖本机。
          </Banner>
        </div>
      ) : null}

      {/* 未钉扎 / 身份变化时展开：探测、核对、信任都在这里完成。
          放在登录条件**之外** —— 未登录时同样需要它（未钉扎登录失败正是从这里继续）。 */}
      {identityFingerprint !== null || (status && !status.pinned) ? (
        <div style={{ marginBottom: 14 }}>
          <Section>服务端身份确认</Section>
          <ServerIdentityPanel
            initialFingerprint={identityFingerprint ?? undefined}
            initialError={identityError ?? undefined}
            onChanged={() => {
              setIdentityFingerprint(null)
              setIdentityError(null)
              void refresh()
            }}
          />
        </div>
      ) : null}

      {/* ── 同步操作 ── */}
      <Section>同步</Section>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
        <Badge tone={status.state === 'error' ? 'danger' : status.state === 'syncing' ? 'accent' : 'default'}>
          {status.state}
        </Badge>
        <span className="metric__sub">
          上次同步 {status.lastSyncAt ? formatRelativeTime(status.lastSyncAt) : '从未'}
          {status.lastVersion === null ? '' : ` · 远端版本 ${status.lastVersion}`}
        </span>
        <div style={{ flex: 1 }} />
        <Button
          size="sm"
          variant="outline"
          icon="upload"
          loading={busy}
          disabled={!status.loggedIn}
          onClick={() => void doPush()}
        >
          推送
        </Button>
        <Button
          size="sm"
          variant="outline"
          icon="download"
          loading={busy}
          disabled={!status.loggedIn}
          onClick={() => void doPull()}
        >
          拉取
        </Button>
        <Button size="sm" variant="ghost" icon="refresh" onClick={() => void refresh()}>
          刷新状态
        </Button>
      </div>

      {progress ? (
        <div className="metric">
          <div className="metric__top">
            <span className="metric__label">{progress.phase === 'push' ? '上传中' : '下载中'}</span>
            <span className="metric__value">
              {progress.done}/{progress.total}
            </span>
          </div>
          <div className="bar">
            <div
              className="bar__fill"
              style={{ width: `${progress.total > 0 ? (progress.done / progress.total) * 100 : 0}%` }}
            />
          </div>
        </div>
      ) : null}

      {status.lastError ? (
        <div style={{ marginTop: 12 }}>
          <Banner tone="warn">上次错误：{status.lastError}</Banner>
        </div>
      ) : null}

      {!status.loggedIn ? (
        <div style={{ marginTop: 16 }}>
          <EmptyState
            icon="cloud"
            title="还没有连接同步后端"
            text="同步是可选的：全部数据本来就在本机 SQLite 里。启用后，服务端只保存密文、无法索引你的内容。"
          />
        </div>
      ) : (
        <div style={{ marginTop: 14 }}>
          <Button size="sm" variant="ghost" icon="settings" onClick={() => actions.setView('settings')}>
            去设置里调整自动同步与同步范围
          </Button>
        </div>
      )}
    </div>
  )
}
