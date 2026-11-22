// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * RDP 会话视图。
 *
 * **它不是画面**：RDP 走外部 `xfreerdp` 进程，画面在**它自己的窗口**里，
 * 标签页里放不下（也和 SSH 内嵌终端不是一回事）。
 *
 * 所以这个视图的职责只有一个：**把边界如实讲清楚**，并提供能操作的东西
 * （重启查看器尺寸、断开、复制安装命令），而不是留一块黑屏让用户以为崩了。
 */

import { useEffect, useState } from 'react'
import { Events } from '@t1000/shared'
import { Badge, Banner } from '../../components/Feedback'
import { Button, IconButton } from '../../components/Button'
import { Icon } from '../../components/Icon'
import { toast } from '../../components/Toast'
import { invoke, subscribe } from '../../lib/ipc'
import { errorText } from '../../lib/format'
import { copyText } from '../../lib/clipboard'

export interface RdpViewProps {
  sessionId: string | undefined
  title: string
  host: string
  width: number
  height: number
  /** 连接阶段的错误（UNSUPPORTED 时带安装命令），原样展示 */
  errorMessage?: string
}

export function RdpView({
  sessionId,
  title,
  host,
  width,
  height,
  errorMessage,
}: RdpViewProps): React.JSX.Element {
  const [exit, setExit] = useState<{
    code: number | null
    signal: string | null
    crashed: boolean
  } | null>(null)
  const [restarting, setRestarting] = useState(false)
  const [size, setSize] = useState({ w: width, h: height })

  useEffect(() => {
    if (!sessionId) return
    return subscribe(Events.RDP_EXIT, (p) => {
      setExit({ code: p.code, signal: p.signal, crashed: p.crashed })
    })
  }, [sessionId])

  const missingBinary = Boolean(errorMessage && /xfreerdp|freerdp/i.test(errorMessage))

  const applyResize = async (): Promise<void> => {
    if (!sessionId) return
    setRestarting(true)
    try {
      const res = await invoke<'rdp', 'sendResize', Record<string, unknown>, { restarted?: boolean }>(
        'rdp',
        'sendResize',
        { sessionId, width: size.w, height: size.h },
      )
      // 外部窗口无法原地改分辨率，后端是**重启查看器进程**实现的，必须告诉用户
      toast.info(res?.restarted ? '正在重启远程桌面窗口（外部窗口无法原地改分辨率）' : '已发送尺寸')
    } catch (err) {
      toast.error(`调整尺寸失败：${errorText(err)}`)
    } finally {
      setTimeout(() => setRestarting(false), 1500)
    }
  }

  return (
    <div className="content" aria-label={`RDP ${title}`}>
      <div className="t-toolbar">
        <Icon name="server" size={15} />
        <span className="panel-title">{title}</span>
        <Badge tone={errorMessage ? 'danger' : exit?.crashed ? 'danger' : exit ? 'default' : 'ok'}>
          {errorMessage ? '启动失败' : exit?.crashed ? '异常退出' : exit ? '已关闭' : '运行中'}
        </Badge>
        <div className="t-toolbar__spacer" />
        <Button
          size="sm"
          variant="ghost"
          icon="refresh"
          loading={restarting}
          disabled={!sessionId}
          onClick={() => void applyResize()}
        >
          应用新的窗口尺寸
        </Button>
      </div>

      <div className="content-scroll" style={{ padding: 18, maxWidth: 780 }}>
        {errorMessage ? (
          <div style={{ marginBottom: 16 }}>
            <Banner
              tone="error"
              actions={
                <Button
                  size="sm"
                  variant="outline"
                  icon="copy"
                  onClick={() => {
                    void copyText(errorMessage)
                    toast.ok('已复制错误信息（含安装命令）')
                  }}
                >
                  复制
                </Button>
              }
            >
              {errorMessage}
            </Banner>
          </div>
        ) : null}

        {/* 状态卡：明确告诉用户画面在哪，避免对着这块区域等黑屏 */}
        <div className="settings-switch-row" style={{ gap: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14, fontWeight: 650 }}>
            <Icon name="eye" size={16} />
            {errorMessage ? '未启动' : exit ? '已结束' : '画面已在独立窗口打开'}
          </div>
          <div className="t-field__hint" style={{ lineHeight: 1.7 }}>
            RDP 通过**外部 xfreerdp 进程**运行，
            <b>画面在它自己的窗口里，不会嵌入本标签页</b>。
            如果你没看到那个窗口，可能被最小化或被其它窗口挡住；
            关闭那个窗口即视为结束会话。
            {missingBinary ? ' 当前错误看起来是缺少 FreeRDP，请按上面的命令安装后重试。' : ''}
          </div>
        </div>

        <div className="kv" style={{ gridTemplateColumns: '120px minmax(0, 1fr)', marginTop: 16 }}>
          <div style={{ display: 'contents' }}>
            <span className="kv__k">目标</span>
            <span className="kv__v mono">{host}</span>
          </div>
          <div style={{ display: 'contents' }}>
            <span className="kv__k">会话 ID</span>
            <span className="kv__v mono">{sessionId ?? '（未建立）'}</span>
          </div>
          <div style={{ display: 'contents' }}>
            <span className="kv__k">窗口尺寸</span>
            <span className="kv__v">
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                <input
                  className="t-input"
                  style={{ width: 90, height: 28 }}
                  type="number"
                  value={size.w}
                  aria-label="宽度"
                  onChange={(e) => setSize((s) => ({ ...s, w: Number(e.target.value) || 0 }))}
                />
                ×
                <input
                  className="t-input"
                  style={{ width: 90, height: 28 }}
                  type="number"
                  value={size.h}
                  aria-label="高度"
                  onChange={(e) => setSize((s) => ({ ...s, h: Number(e.target.value) || 0 }))}
                />
                <IconButton
                  icon="check"
                  label="应用尺寸（会重启查看器进程）"
                  loading={restarting}
                  onClick={() => void applyResize()}
                />
              </span>
            </span>
          </div>
        </div>

        {exit ? (
          <div style={{ marginTop: 16 }}>
            {/* 「用户关窗口」和「崩了」是两种事，措辞必须不同 */}
            <Banner tone={exit.crashed ? 'error' : 'info'}>
              {exit.crashed
                ? `远程桌面进程异常退出（code ${exit.code ?? '—'}${exit.signal === null ? '' : `, signal ${exit.signal}`}）。可能是参数不被 FreeRDP 接受或连接中断。`
                : '远程桌面窗口已由用户关闭，会话结束。'}
            </Banner>
          </div>
        ) : null}

        <p className="t-field__hint" style={{ marginTop: 18 }}>
          说明：本次不做内嵌画面。把外部窗口的画面搬进标签页需要 RDP 协议级实现或窗口嵌入
          （X11 下还要处理无边框重定向），属于独立课题，不在本轮范围。
        </p>
      </div>
    </div>
  )
}

export default RdpView
