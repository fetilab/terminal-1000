// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 锁屏遮罩。
 *
 * ## 一条硬要求：锁定后**不能泄露任何数据**
 * 所以这里不是"半透明蒙一层"，而是：
 * 1. 遮罩本身**完全不透明**；
 * 2. 同时把 `.app-shell` 整体 `visibility: hidden` —— 底下的连接名、主机、终端内容
 *    既不参与绘制、也不可被焦点命中，截图里更不会露出来。
 *    用 `visibility` 而不是卸载组件，是为了让 xterm / 会话状态**活下来**，
 *    解锁后不用重连 —— 安全性与可用性都保住。
 *
 * ## 为什么由事件驱动
 * 自动锁屏的空闲计时在主进程（`powerMonitor` 是系统级空闲，窗口失焦时渲染层数不准），
 * 渲染层只监听 `SECURITY_LOCKED` / `SECURITY_UNLOCKED`，不自己数时间。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { Badge, Banner } from '../../components/Feedback'
import { Button } from '../../components/Button'
import { Field, TextInput } from '../../components/Form'
import { Icon } from '../../components/Icon'
import { errorText } from '../../lib/format'
import { getVaultState, setMasterPassword, unlockVault, type VaultState } from '../../lib/vault'
import './security.css'

export interface LockScreenProps {
  /** 'idle' = 空闲自动锁；'manual' = 用户点了立即锁定 */
  reason: 'idle' | 'manual'
  idleSeconds?: number
  onUnlocked: () => void
}

function formatIdle(seconds: number | undefined): string {
  if (seconds === undefined) return ''
  if (seconds < 60) return `（已空闲 ${seconds} 秒）`
  const m = Math.floor(seconds / 60)
  return `（已空闲 ${m} 分钟）`
}

export function LockScreen({ reason, idleSeconds, onUnlocked }: LockScreenProps): React.JSX.Element {
  const [pw, setPw] = useState('')
  const [pw2, setPw2] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [state, setState] = useState<VaultState | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    void getVaultState().then(setState)
    inputRef.current?.focus()
  }, [])

  const creating = state !== null && !state.initialized

  const submit = useCallback(async () => {
    if (busy) return
    setBusy(true)
    setErr(null)
    try {
      if (creating) {
        if (pw.length < 8) {
          setErr('主密码至少 8 位')
          return
        }
        if (pw !== pw2) {
          setErr('两次输入的密码不一致')
          return
        }
        await setMasterPassword(pw)
      } else {
        if (!pw) {
          setErr('请输入主密码')
          return
        }
        const res = await unlockVault(pw)
        const ok =
          res !== null && typeof res === 'object' && 'unlocked' in res
            ? Boolean((res as { unlocked?: boolean }).unlocked)
            : true
        if (!ok) {
          // 密码错要有**明确反馈**：清空输入、聚焦、给出可读的错因
          setPw('')
          setErr('主密码不正确')
          inputRef.current?.focus()
          return
        }
      }
      onUnlocked()
    } catch (e) {
      setErr(errorText(e))
    } finally {
      setBusy(false)
    }
  }, [busy, creating, pw, pw2, onUnlocked])

  return (
    <div className="lockscreen" role="dialog" aria-modal="true" aria-label="已锁定">
      <div className="lockscreen__card">
        <div className="lockscreen__brand">
          <span className="lockscreen__logo">
            <Icon name="lock" size={22} />
          </span>
          <div>
            <div className="lockscreen__title">已锁定</div>
            <div className="lockscreen__sub">
              {reason === 'idle' ? `因空闲自动锁定${formatIdle(idleSeconds)}` : '已手动锁定'}
            </div>
          </div>
        </div>

        <div className="lockscreen__hint">
          输入主密码解锁。本地库中的连接凭据已加密，解锁后本次运行期间不再询问。
        </div>

        {creating ? (
          <Banner tone="warn">
            还没有设置主密码，先创建一个 —— 用于加密保存的连接凭据。
            <b>忘记后无法恢复。</b>
          </Banner>
        ) : null}

        <div className="lockscreen__form">
          <Field label="主密码" error={err} required>
            <TextInput
              ref={inputRef}
              type="password"
              autoComplete="current-password"
              value={pw}
              placeholder={creating ? '至少 8 位' : ''}
              onChange={(e) => {
                setPw(e.target.value)
                setErr(null)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !creating) void submit()
              }}
            />
          </Field>
          {creating ? (
            <Field label="再输入一次" required>
              <TextInput
                type="password"
                autoComplete="new-password"
                value={pw2}
                onChange={(e) => {
                  setPw2(e.target.value)
                  setErr(null)
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void submit()
                }}
              />
            </Field>
          ) : null}
          <Button variant="primary" loading={busy} onClick={() => void submit()}>
            {creating ? '创建并解锁' : '解锁'}
          </Button>
        </div>

        <div className="lockscreen__foot">
          <Badge tone="outline">
            <Icon name="shield" size={11} /> scrypt 派生密钥
          </Badge>
          <span>主密码不会被保存，也不会离开这台机器</span>
        </div>
      </div>
    </div>
  )
}

export default LockScreen
