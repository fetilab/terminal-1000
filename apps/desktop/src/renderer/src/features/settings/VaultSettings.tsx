// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 设置 → 存储与安全：主密码的主动管理入口。
 *
 * 这个分区是"用户可以主动来做这件事"的地方；而 `ensureUnlocked()` 是"用到时被引导过来"。
 * 两条路都要有：只有前者会让人不知道要去哪，只有后者则用户想主动改密码时无处可去。
 */

import { useCallback, useEffect, useState } from 'react'
import { Badge, Banner } from '../../components/Feedback'
import { Button, Section } from '../../components/Button'
import { Field, TextInput } from '../../components/Form'
import { Icon } from '../../components/Icon'
import { toast } from '../../components/Toast'
import { errorText } from '../../lib/format'
import { getVaultState, lockVault, setMasterPassword, unlockVault, type VaultState } from '../../lib/vault'

export function VaultSettings(): React.JSX.Element {
  const [state, setState] = useState<VaultState | null>(null)
  const [mode, setMode] = useState<'idle' | 'create' | 'change' | 'unlock'>('idle')
  const [oldPw, setOldPw] = useState('')
  const [newPw, setNewPw] = useState('')
  const [again, setAgain] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setState(await getVaultState())
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const reset = (): void => {
    setMode('idle')
    setOldPw('')
    setNewPw('')
    setAgain('')
    setErr(null)
  }

  const submit = async (): Promise<void> => {
    if (!state) return
    if (mode === 'unlock') {
      if (!oldPw) {
        setErr('请输入主密码')
        return
      }
      setBusy(true)
      try {
        const res = await unlockVault(oldPw)
        const ok =
          res !== null && typeof res === 'object' && 'unlocked' in res
            ? Boolean((res as { unlocked?: boolean }).unlocked)
            : true
        if (!ok) {
          setErr('主密码不正确')
          return
        }
        toast.ok('本地库已解锁')
        reset()
        await refresh()
      } catch (e) {
        setErr(errorText(e))
      } finally {
        setBusy(false)
      }
      return
    }

    if (newPw.length < 8) {
      setErr('主密码至少 8 位')
      return
    }
    if (newPw !== again) {
      setErr('两次输入的密码不一致')
      return
    }
    setBusy(true)
    try {
      const res = await setMasterPassword(
        newPw,
        mode === 'change' ? oldPw : undefined,
      )
      toast.ok(
        res.created
          ? '主密码已创建，本地库已解锁'
          : `主密码已修改（重新加密 ${res.reencrypted} 条凭据）`,
      )
      reset()
      await refresh()
    } catch (e) {
      setErr(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  if (!state) return <p className="t-field__hint">正在读取存储状态…</p>

  return (
    <>
      <Banner tone={state.unlocked ? 'info' : 'warn'}>
        {state.initialized
          ? state.unlocked
            ? '本地库已解锁。本次运行期间的涉密操作不会再询问主密码。'
            : '本地库已锁定。保存凭据、导入 OpenSSH 配置等操作会先要求解锁。'
          : '还没有设置主密码。设置后，保存的 SSH 口令 / 私钥口令 / 同步口令会加密落盘。'}
      </Banner>

      <Section right={<Badge tone={state.unlocked ? 'ok' : 'warn'}>{state.unlocked ? '已解锁' : '已锁定'}</Badge>}>
        主密码
      </Section>

      <div className="t-field__hint" style={{ lineHeight: 1.8 }}>
        <Icon name="lock" size={12} /> 主密码用 scrypt 派生密钥，**只用于加解密本地库里的机密字段**，
        不会被保存，也不会上传到任何地方。
        <br />
        ⚠️ <b>忘记后无法恢复</b> —— 我们无法帮你重置，已加密的凭据将读不出来。
      </div>

      {mode === 'idle' ? (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
          {!state.initialized ? (
            <Button variant="primary" icon="key" onClick={() => setMode('create')}>
              创建主密码
            </Button>
          ) : (
            <>
              {!state.unlocked ? (
                <Button variant="primary" icon="lock" onClick={() => setMode('unlock')}>
                  解锁
                </Button>
              ) : (
                <>
                  <Button variant="outline" icon="key" onClick={() => setMode('change')}>
                    修改主密码
                  </Button>
                  <Button
                    variant="outline"
                    icon="lock"
                    onClick={async () => {
                      try {
                        await lockVault()
                        toast.ok('已锁定本地库')
                        await refresh()
                      } catch (e) {
                        toast.error(`锁定失败：${errorText(e)}`)
                      }
                    }}
                  >
                    立即锁定
                  </Button>
                </>
              )}
            </>
          )}
        </div>
      ) : (
        <div style={{ marginTop: 12, maxWidth: 420 }}>
          {mode === 'change' || mode === 'unlock' ? (
            <Field label={mode === 'unlock' ? '主密码' : '当前主密码'} error={mode === 'unlock' ? err : null} required>
              <TextInput
                type="password"
                autoFocus
                autoComplete="current-password"
                value={oldPw}
                onChange={(e) => {
                  setOldPw(e.target.value)
                  setErr(null)
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && mode === 'unlock') void submit()
                }}
              />
            </Field>
          ) : null}

          {mode !== 'unlock' ? (
            <>
              <Field label={mode === 'create' ? '新主密码' : '新主密码'} error={err} required hint="至少 8 位">
                <TextInput
                  type="password"
                  autoFocus={mode === 'create'}
                  autoComplete="new-password"
                  value={newPw}
                  onChange={(e) => {
                    setNewPw(e.target.value)
                    setErr(null)
                  }}
                />
              </Field>
              <Field label="再输入一次" required>
                <TextInput
                  type="password"
                  autoComplete="new-password"
                  value={again}
                  onChange={(e) => {
                    setAgain(e.target.value)
                    setErr(null)
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void submit()
                  }}
                />
              </Field>
            </>
          ) : null}

          <div style={{ display: 'flex', gap: 8 }}>
            <Button variant="ghost" onClick={reset}>
              取消
            </Button>
            <Button variant="primary" loading={busy} onClick={() => void submit()}>
              {mode === 'create' ? '创建' : mode === 'change' ? '修改' : '解锁'}
            </Button>
          </div>
        </div>
      )}
    </>
  )
}

export default VaultSettings
