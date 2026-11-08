// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 隧道管理/状态视图。
 *
 * 隧道不是一个"会话画面"，而是**一条常驻的转发通道**：
 * 打开后本机/远端多了一个监听端口，断开则收回。
 * 所以这里呈现的是状态 + 起停，而不是终端。
 */

import { useState } from 'react'
import type { ConnectionState, TunnelConnection } from '@t1000/shared'
import { Badge, Banner } from '../../components/Feedback'
import { Button, IconButton } from '../../components/Button'
import { Icon } from '../../components/Icon'
import { toast } from '../../components/Toast'
import { invoke } from '../../lib/ipc'
import { errorText } from '../../lib/format'

const TYPE_LABEL: Record<TunnelConnection['type'], string> = {
  local: '本地转发 (-L)',
  remote: '远程转发 (-R)',
  dynamic: '动态代理 (-D, SOCKS5)',
}

const STATE_TONE: Record<string, 'ok' | 'accent' | 'warn' | 'danger' | 'default'> = {
  idle: 'default',
  connecting: 'accent',
  ready: 'ok',
  disconnected: 'warn',
  failed: 'danger',
}

export interface TunnelViewProps {
  sessionId: string | undefined
  connection: TunnelConnection
  state: ConnectionState | 'idle'
  message?: string
}

export function TunnelView({
  sessionId,
  connection,
  state,
  message,
}: TunnelViewProps): React.JSX.Element {
  const [busy, setBusy] = useState(false)

  const close = async (): Promise<void> => {
    if (!sessionId) return
    setBusy(true)
    try {
      await invoke<'forward', 'close', { tunnelId: string }, unknown>('forward', 'close', {
        tunnelId: sessionId,
      })
      toast.ok('隧道已关闭，监听端口已收回')
    } catch (err) {
      toast.error(`关闭失败：${errorText(err)}`)
    } finally {
      setBusy(false)
    }
  }

  const type = connection.type
  const rows: Array<[string, React.ReactNode]> = [
    ['类型', TYPE_LABEL[type] ?? type],
    ['承载服务器', connection.serverId],
    ['本机监听', `${connection.localHost}:${connection.localPort}`],
    ...(type === 'dynamic'
      ? ([['代理方式', 'SOCKS5（客户端自行决定目标）']] as Array<[string, React.ReactNode]>)
      : ([['远端目标', `${connection.remoteHost}:${connection.remotePort}`]] as Array<
          [string, React.ReactNode]
        >)),
    ['自动重连', connection.autoReconnect ? '已开启' : '关闭'],
    ['运行 ID', sessionId ?? '（未建立）'],
  ]

  return (
    <div className="content" aria-label={`隧道 ${connection.name}`}>
      <div className="t-toolbar">
        <Icon name="route" size={15} />
        <span className="panel-title">{connection.name}</span>
        <Badge tone={STATE_TONE[state] ?? 'default'}>
          {state === 'ready' ? '已就绪' : state === 'connecting' ? '打开中' : state === 'failed' ? '失败' : state}
        </Badge>
        <div className="t-toolbar__spacer" />
        <Button
          size="sm"
          variant="danger"
          icon="power"
          loading={busy}
          disabled={!sessionId || state === 'disconnected'}
          onClick={() => void close()}
        >
          关闭隧道
        </Button>
      </div>

      <div className="content-scroll" style={{ padding: 18, maxWidth: 720 }}>
        {state === 'failed' ? (
          <div style={{ marginBottom: 14 }}>
            <Banner tone="error">隧道打开失败：{message ?? '未知原因'}</Banner>
          </div>
        ) : null}
        {state === 'ready' && connection.autoReconnect ? (
          <div style={{ marginBottom: 14 }}>
            <Banner tone="info">
              已开启自动重连：意外断开后会按退避策略重建，无需手动干预。
            </Banner>
          </div>
        ) : null}

        <div className="kv" style={{ gridTemplateColumns: '120px minmax(0, 1fr)' }}>
          {rows.map(([k, v]) => (
            <div key={k} style={{ display: 'contents' }}>
              <span className="kv__k">{k}</span>
              <span className="kv__v mono" style={{ fontSize: 12 }}>
                {v}
              </span>
            </div>
          ))}
        </div>

        <p className="t-field__hint" style={{ marginTop: 18 }}>
          {type === 'local'
            ? `连接本机 ${connection.localHost}:${connection.localPort} 就等于连接远端的 ${connection.remoteHost}:${connection.remotePort}。`
            : type === 'remote'
              ? `连接远端 ${connection.remoteHost}:${connection.remotePort} 会被转发回本机的服务。`
              : `把本机 ${connection.localHost}:${connection.localPort} 当作 SOCKS5 代理使用，目标由客户端指定。`}
        </p>
        {state === 'disconnected' ? (
          <p className="t-field__hint">
            隧道已关闭。可以用连接列表的「连接」按钮重新打开。
          </p>
        ) : null}
      </div>
    </div>
  )
}

export default TunnelView
