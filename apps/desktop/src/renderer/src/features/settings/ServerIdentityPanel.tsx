// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 同步传输方式与服务端身份确认。
 *
 * 契约（主进程已实现，界面只消费）：
 * - `sync.setTransport({ transport })`；`http` 仅回环可用，非回环会被拒：
 *   `FORBIDDEN` + `detail.code === 'PLAINTEXT_NOT_ALLOWED'`。
 * - `sync.inspectServer()` 只握手不发送数据，返回 `{ fingerprint, publicKey }`；
 *   它**不校验钉扎**，所以未信任时也能拿到指纹用于核对。
 * - `sync.trustServer({ fingerprint, publicKey })`；两者必须来自同一次探测。
 * - `sync.forgetServer()` 清钉扎并关闭已建连接。
 * - 登录被拒时：`UNAUTHORIZED` + `detail.code === 'UNTRUSTED_SERVER'`（带 `detail.fingerprint`）；
 *   `FORBIDDEN` + `detail.code === 'SERVER_IDENTITY_CHANGED'`（带 `expected` / `actual`）。
 *
 * 指纹格式由 `fingerprintOf` 决定：sha256 前 32 个 hex 字符，按 4 字符分组 —— 共 8 组，
 * 便于电话/聊天里口述核对。这里再分组一次是为了容忍上游去掉空格的写法。
 */

import { useCallback, useEffect, useState } from 'react'
import { Badge, Banner, Loading } from '../../components/Feedback'
import { Button } from '../../components/Button'
import { Field, TextInput } from '../../components/Form'
import { Icon } from '../../components/Icon'
import { toast } from '../../components/Toast'
import { invoke } from '../../lib/ipc'
import { classifySyncError, formatFingerprint, type SyncErrorInfo } from './syncError'
import './settings.css'

// 外部服务面板从这里取分类器与类型，保持既有引用路径稳定
export { classifySyncError, formatFingerprint }
export type { SyncErrorInfo }

export interface SyncStatusView {
  transport: 'http' | 'tsc1'
  pinned: boolean
  pinnedFingerprint: string | null
  endpoint: string
  loggedIn: boolean
}

/** 明文传输只允许回环：与主进程 `isLoopbackHost` 的判定保持一致 */
function isLoopbackEndpoint(endpoint: string): boolean {
  if (!endpoint) return false
  try {
    const host = new URL(endpoint.includes('://') ? endpoint : `http://${endpoint}`).hostname
    return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]'
  } catch {
    return false
  }
}

export interface ServerIdentityPanelProps {
  /** 外部服务面板在登录失败后传入，用于"失败即进入确认流程" */
  initialFingerprint?: string | undefined
  /**
   * 登录失败时的归类结果。
   * 身份变化（`SERVER_IDENTITY_CHANGED`）必须由本面板渲染**常驻告警**并带上
   * expected/actual —— 只弹一个 toast 会被划过去。
   */
  initialError?: SyncErrorInfo | undefined
  /** 钉扎变化后通知外层刷新状态 */
  onChanged?: (() => void) | undefined
}

export function ServerIdentityPanel({
  initialFingerprint,
  initialError,
  onChanged,
}: ServerIdentityPanelProps): React.JSX.Element {
  const [status, setStatus] = useState<SyncStatusView | null>(null)
  const [probed, setProbed] = useState<{ fingerprint: string; publicKey: string } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [warning, setWarning] = useState<SyncErrorInfo | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await invoke<'sync', 'status', Record<string, never>, SyncStatusView>(
        'sync',
        'status',
        {},
      )
      setStatus(res)
    } catch (err) {
      setWarning(classifySyncError(err))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  // 登录被判定为"未钉扎"时，主进程会把指纹放在 detail 里 —— 直接带进确认流程
  useEffect(() => {
    if (initialFingerprint) {
      setProbed({ fingerprint: initialFingerprint, publicKey: '' })
    }
  }, [initialFingerprint])

  // 登录失败的结构化结果：身份变化要变成常驻告警（含 expected/actual），不只是一条 toast
  useEffect(() => {
    if (initialError && initialError.kind !== 'other') setWarning(initialError)
  }, [initialError])

  const setTransport = async (transport: 'http' | 'tsc1'): Promise<void> => {
    setBusy('transport')
    try {
      await invoke<'sync', 'setTransport', { transport: string }, unknown>('sync', 'setTransport', {
        transport,
      })
      await load()
      onChanged?.()
    } catch (err) {
      setWarning(classifySyncError(err))
    } finally {
      setBusy(null)
    }
  }

  const probe = async (): Promise<void> => {
    setBusy('probe')
    setWarning(null)
    try {
      const res = await invoke<
        'sync',
        'inspectServer',
        Record<string, never>,
        { fingerprint: string; publicKey: string }
      >('sync', 'inspectServer', {})
      setProbed(res)
    } catch (err) {
      setWarning(classifySyncError(err))
    } finally {
      setBusy(null)
    }
  }

  const trust = async (): Promise<void> => {
    if (!probed?.publicKey) {
      // 只从错误里拿到指纹时没有公钥，必须重新探测一次（两者必须同源）
      await probe()
      return
    }
    setBusy('trust')
    try {
      await invoke<'sync', 'trustServer', Record<string, unknown>, unknown>('sync', 'trustServer', {
        fingerprint: probed.fingerprint,
        publicKey: probed.publicKey,
      })
      toast.ok('已信任该服务端身份')
      setProbed(null)
      setWarning(null)
      await load()
      onChanged?.()
    } catch (err) {
      setWarning(classifySyncError(err))
    } finally {
      setBusy(null)
    }
  }

  const forget = async (): Promise<void> => {
    setBusy('forget')
    try {
      await invoke<'sync', 'forgetServer', Record<string, never>, unknown>('sync', 'forgetServer', {})
      toast.ok('已清除钉扎，下次连接需要重新确认身份')
      setProbed(null)
      await load()
      onChanged?.()
    } catch (err) {
      setWarning(classifySyncError(err))
    } finally {
      setBusy(null)
    }
  }

  if (!status) return <Loading text="读取同步状态…" />

  const transport = status.transport

  return (
    <>
      {/* 这里不重复放选择控件：`sync.transport` 已登记在字段注册表里（上方可选），
          面板只负责把后果讲清楚，并在明文+非回环时给一键修正。 */}
      <div className="synctransport-summary">
        <span className="synctransport-summary__label">当前传输方式</span>
        {transport === 'tsc1' ? (
          <Badge tone="ok">TSC/1 加密通道</Badge>
        ) : (
          <Badge tone="warn">明文 HTTP（仅回环）</Badge>
        )}
      </div>

      {transport === 'http' && !isLoopbackEndpoint(status.endpoint) ? (
        <Banner
          tone="error"
          actions={
            <Button
              size="sm"
              variant="primary"
              loading={busy === 'transport'}
              onClick={() => void setTransport('tsc1')}
            >
              改为 TSC/1
            </Button>
          }
        >
          后端地址 <code className="mono">{status.endpoint || '（未设置）'}</code> 不是回环地址，
          明文传输会被主进程拒绝（<code className="mono">PLAINTEXT_NOT_ALLOWED</code>）：
          登录口令与会话令牌会在公网明文传输。
        </Banner>
      ) : null}

      {warning?.kind === 'plaintext-not-allowed' ? (
        <Banner tone="error">
          明文传输被拒绝：{warning.message}
        </Banner>
      ) : null}

      {warning?.kind === 'identity-changed' ? (
        <Banner tone="error">
          <b>服务端身份与已记录的不一致，可能是中间人攻击。</b>
          <br />
          已记录：<code className="mono">{formatFingerprint(warning.expected ?? '')}</code>
          <br />
          本次收到：<code className="mono">{formatFingerprint(warning.actual ?? '')}</code>
          <br />
          若你无法确认服务端确实更换过密钥，请停止同步并检查网络链路；只有在你亲自确认过后，
          才应重新探测并更新钉扎。
        </Banner>
      ) : null}

      <div className="t-field__label" style={{ marginTop: 14 }}>
        服务端身份
        {status.pinned ? (
          <Badge tone="ok">已钉扎</Badge>
        ) : (
          <Badge tone="warn">未确认</Badge>
        )}
      </div>

      {status.pinned ? (
        <>
          <div className="synckey">
            <span className="synckey__label">已记录指纹</span>
            <code className="synckey__value">{formatFingerprint(status.pinnedFingerprint ?? '')}</code>
          </div>
          <p className="t-field__hint">
            连接时会校验服务端出示的身份。清除钉扎后，下次连接需要重新核对指纹。
          </p>
          <div className="settings-actions">
            <Button
              variant="outline"
              icon="refresh"
              loading={busy === 'probe'}
              onClick={() => void probe()}
            >
              重新探测
            </Button>
            <Button variant="danger" icon="trash" loading={busy === 'forget'} onClick={() => void forget()}>
              清除钉扎
            </Button>
          </div>
        </>
      ) : (
        <>
          <p className="t-field__hint">
            首次连接前需要确认服务端身份。探测只建立握手、不发送任何数据。
          </p>
          <div className="settings-actions">
            <Button
              variant="primary"
              icon="search"
              loading={busy === 'probe'}
              onClick={() => void probe()}
            >
              探测服务端身份
            </Button>
          </div>
        </>
      )}

      {probed ? (
        <div className="syncfingerprint">
          <div className="syncfingerprint__head">
            <Icon name="shield" size={13} />
            本次探测到的指纹
          </div>
          <div className="syncfingerprint__grid">
            {formatFingerprint(probed.fingerprint)
              .split(' ')
              .map((group, i) => (
                <span className="syncfingerprint__group" key={`${group}-${i}`}>
                  {group}
                </span>
              ))}
          </div>
          <p className="t-field__hint">
            请在<b>服务器本机的同步服务日志</b>里核对同一指纹（服务端启动/建连时会打印自己的身份指纹）。
            一致即可信任；不一致说明你连的不是那台服务器。
          </p>
          <div className="settings-actions">
            <Button
              variant="primary"
              icon="check"
              loading={busy === 'trust'}
              disabled={!probed.publicKey}
              onClick={() => void trust()}
            >
              {probed.publicKey ? '信任此服务器' : '重新探测后信任'}
            </Button>
            {probed.publicKey ? (
              <Button
                variant="ghost"
                icon="copy"
                onClick={() => {
                  void navigator.clipboard.writeText(formatFingerprint(probed.fingerprint))
                  toast.ok('指纹已复制')
                }}
              >
                复制指纹
              </Button>
            ) : null}
            <Button variant="ghost" onClick={() => setProbed(null)}>
              放弃
            </Button>
          </div>
        </div>
      ) : null}

      {warning?.kind === 'untrusted-server' ? (
        <Banner tone="warn">
          服务端身份尚未确认：{warning.message}
        </Banner>
      ) : null}
    </>
  )
}

export default ServerIdentityPanel
