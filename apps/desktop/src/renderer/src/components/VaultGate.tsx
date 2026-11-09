// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 主密码对话框宿主。
 *
 * 挂在应用根部，监听 `ensureUnlocked()` 的请求，按状态给两种界面：
 * - **未初始化** → 创建主密码：两次输入 + 强度提示 + **明确的后果**
 *   （忘记无法恢复；我们不保存它，也无法帮你重置）
 * - **已锁定** → 解锁：单输入框，密码错有明确反馈
 *
 * 刻意**不提供"跳过"**：跳过就等于所有涉密功能不可用，用户会以为产品坏了。
 * 如果用户不想设，那他要的是"不做这些操作"，而不是"设一个假的"。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { Badge, Banner } from './Feedback'
import { Button } from './Button'
import { Field, TextInput } from './Form'
import { Icon } from './Icon'
import { Modal } from './Modal'
import { toast } from './Toast'
import { errorText } from '../lib/format'
import {
  getVaultState,
  registerVaultPrompt,
  setMasterPassword,
  unlockVault,
  type VaultState,
} from '../lib/vault'

/** 粗略的强度提示：只给方向，不做虚假的"安全评分" */
function strengthHint(pw: string): { label: string; tone: 'danger' | 'warn' | 'ok' } {
  if (pw.length < 8) return { label: '太短（至少 8 位）', tone: 'danger' }
  let score = 0
  if (pw.length >= 12) score += 1
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) score += 1
  if (/\d/.test(pw)) score += 1
  if (/[^A-Za-z0-9]/.test(pw)) score += 1
  if (score <= 1) return { label: '偏弱：建议加长或混用大小写/数字/符号', tone: 'warn' }
  if (score <= 2) return { label: '一般', tone: 'warn' }
  return { label: '较强', tone: 'ok' }
}

export function VaultGate(): React.JSX.Element | null {
  const [state, setState] = useState<VaultState | null>(null)
  const [reason, setReason] = useState<string | undefined>(undefined)
  const [pw, setPw] = useState('')
  const [pw2, setPw2] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const resolverRef = useRef<((ok: boolean) => void) | null>(null)

  /** 关闭并回答调用方：true 才表示可以继续 */
  const settle = useCallback((ok: boolean) => {
    resolverRef.current?.(ok)
    resolverRef.current = null
    setState(null)
    setPw('')
    setPw2('')
    setErr(null)
  }, [])

  useEffect(() => {
    registerVaultPrompt((st, why) => {
      return new Promise<boolean>((resolve) => {
        // 前一次还没回答就再来的请求：直接把旧的判为取消，避免 Promise 悬挂
        resolverRef.current?.(false)
        resolverRef.current = resolve
        setPw('')
        setPw2('')
        setErr(null)
        setReason(why)
        setState(st)
      })
    })
    return () => registerVaultPrompt(null)
  }, [])

  const submit = async (): Promise<void> => {
    if (!state) return
    setBusy(true)
    setErr(null)
    try {
      if (!state.initialized) {
        if (pw.length < 8) {
          setErr('主密码至少 8 位')
          return
        }
        if (pw !== pw2) {
          setErr('两次输入的密码不一致')
          return
        }
        await setMasterPassword(pw)
        toast.ok('主密码已设置，本地库已解锁')
      } else {
        if (!pw) {
          setErr('请输入主密码')
          return
        }
        const res = await unlockVault(pw)
        // 后端 unlock 失败时返回 { unlocked: false }，不是抛错 —— 两种都要当失败处理
        const ok =
          res !== null && typeof res === 'object' && 'unlocked' in res
            ? Boolean((res as { unlocked?: boolean }).unlocked)
            : true
        if (!ok) {
          setErr('主密码不正确')
          return
        }
        toast.ok('本地库已解锁')
      }
      settle(true)
      // 对话框关掉之后刷新状态缓存，避免下一处又弹一次
      void getVaultState()
    } catch (e) {
      setErr(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  if (!state) return null

  const creating = !state.initialized
  const hint = creating ? strengthHint(pw) : null

  return (
    <Modal
      open
      size="sm"
      title={creating ? '设置主密码' : '解锁本地库'}
      subtitle={creating ? '用于加密你保存的连接凭据' : '本地库处于锁定状态'}
      onClose={() => settle(false)}
      footer={
        <>
          <div className="t-modal__footer-spacer" />
          <Button variant="ghost" onClick={() => settle(false)}>
            取消
          </Button>
          <Button variant="primary" loading={busy} onClick={() => void submit()}>
            {creating ? '创建并解锁' : '解锁'}
          </Button>
        </>
      }
    >
      {reason ? (
        <div style={{ marginBottom: 12 }}>
          <Banner tone="info">{reason}</Banner>
        </div>
      ) : null}

      {creating ? (
        <Banner tone="warn">
          <b>这个密码忘记后无法恢复。</b>
          我们不保存它、也无法帮你重置 —— 一旦忘记，已加密保存的凭据将无法读出。
          建议用一句你记得住的长口令，或存进你的密码管理器。
        </Banner>
      ) : (
        <p className="t-field__hint" style={{ marginTop: 0 }}>
          主密码只在解锁时使用，不会被保存。解锁后本次运行期间的涉密操作不再询问。
        </p>
      )}

      <div style={{ marginTop: 12 }}>
        <Field label={creating ? '主密码' : '主密码'} error={err} required>
          <TextInput
            type="password"
            autoFocus
            autoComplete="new-password"
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
          <>
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
            {pw ? (
              <div style={{ marginTop: -4, display: 'flex', alignItems: 'center', gap: 6 }}>
                <Badge tone={hint?.tone === 'ok' ? 'ok' : hint?.tone === 'warn' ? 'warn' : 'danger'}>
                  强度：{hint?.label}
                </Badge>
                {pw2 && pw !== pw2 ? <span className="t-field__error">两次输入不一致</span> : null}
              </div>
            ) : null}
          </>
        ) : null}
      </div>

      <p className="t-field__hint" style={{ marginTop: 12 }}>
        <Icon name="lock" size={12} /> 密码经 scrypt 派生出密钥，只用于加解密本地库中的机密字段
        （SSH 口令、私钥口令、同步口令等）。
      </p>
    </Modal>
  )
}

export default VaultGate
