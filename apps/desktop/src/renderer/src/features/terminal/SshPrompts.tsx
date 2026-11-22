// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * SSH 交互弹窗：**主机指纹确认** 与 **交互式认证**。
 *
 * 为什么这两块必须存在（不是"锦上添花"）：
 * 主进程在遇到未知主机时会 emit `SSH_HOST_KEY_ASK` 并**挂起握手等 UI 回话**
 * （`ssh.verifyHostKey`），键盘交互认证同理等 `ssh.respondAuth`。
 * 渲染层之前**完全没订阅**这两个事件 —— 于是连接一台新主机会一路卡到
 * "Timed out while waiting for handshake"，看起来像网络问题，实际是没人回答询问。
 * 这是实测发现的：同一台测试主机用 ssh2 客户端 141ms 就 ready，走 app 却超时。
 *
 * 安全措辞按"可能被中间人"写，而不是轻描淡写的"指纹变了"：
 * `mismatch=true` 意味着**这台主机的密钥和之前记录的不一样**，
 * 要么对方重装了系统，要么有人在中间。必须让用户明确选择，且默认不提供"总是接受"。
 */

import { useCallback, useEffect, useState } from 'react'
import { Events } from '@t1000/shared'
import { Badge, Banner } from '../../components/Feedback'
import { Button } from '../../components/Button'
import { Field, TextInput } from '../../components/Form'
import { Icon } from '../../components/Icon'
import { Modal } from '../../components/Modal'
import { toast } from '../../components/Toast'
import { invoke, subscribe } from '../../lib/ipc'
import { errorText } from '../../lib/format'
import { copyText } from '../../lib/clipboard'

interface HostKeyAsk {
  requestId: string
  sessionId: string
  host: string
  port: number
  keyType: string
  fingerprint: string
  mismatch: boolean
}

interface AuthPrompt {
  requestId: string
  sessionId: string
  name: string
  instructions: string
  prompts: Array<{ prompt: string; echo: boolean }>
}

export function SshPrompts(): React.JSX.Element | null {
  const [hostKey, setHostKey] = useState<HostKeyAsk | null>(null)
  const [auth, setAuth] = useState<AuthPrompt | null>(null)
  const [answers, setAnswers] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    const offHost = subscribe(Events.SSH_HOST_KEY_ASK, (p: HostKeyAsk) => {
      setHostKey(p)
    })
    const offAuth = subscribe(Events.SSH_AUTH_PROMPT, (p: AuthPrompt) => {
      setAuth(p)
      setAnswers(new Array(p.prompts.length).fill(''))
      setErr(null)
    })
    return () => {
      offHost()
      offAuth()
    }
  }, [])

  const answerHostKey = useCallback(
    async (accepted: boolean) => {
      const ask = hostKey
      if (!ask) return
      setBusy(true)
      try {
        await invoke<'ssh', 'verifyHostKey', { requestId: string; accepted: boolean }, unknown>(
          'ssh',
          'verifyHostKey',
          { requestId: ask.requestId, accepted },
        )
        setHostKey(null)
        toast[accepted ? 'ok' : 'warn'](accepted ? '已接受该主机指纹' : '已拒绝连接')
      } catch (e) {
        setErr(errorText(e))
      } finally {
        setBusy(false)
      }
    },
    [hostKey],
  )

  const answerAuth = useCallback(async () => {
    const ask = auth
    if (!ask) return
    setBusy(true)
    setErr(null)
    try {
      // 顺序必须与 prompts 一致：主进程按 z.array(z.string()) 顺序消费
      await invoke<'ssh', 'respondAuth', { requestId: string; responses: string[] }, unknown>(
        'ssh',
        'respondAuth',
        { requestId: ask.requestId, responses: answers },
      )
      setAuth(null)
    } catch (e) {
      setErr(errorText(e))
    } finally {
      setBusy(false)
    }
  }, [auth, answers])

  // 指纹确认优先显示：没有它连接根本走不下去
  if (hostKey) {
    return (
      <Modal
        open
        size="md"
        title={hostKey.mismatch ? '主机指纹不匹配' : '确认主机指纹'}
        subtitle={`${hostKey.host}:${hostKey.port}`}
        onClose={() => void answerHostKey(false)}
        footer={
          <>
            <div className="t-modal__footer-spacer" />
            <Button variant="ghost" loading={busy} onClick={() => void answerHostKey(false)}>
              拒绝
            </Button>
            <Button
              variant={hostKey.mismatch ? 'danger' : 'primary'}
              loading={busy}
              onClick={() => void answerHostKey(true)}
            >
              {hostKey.mismatch ? '仍然接受（风险自负）' : '接受并保存'}
            </Button>
          </>
        }
      >
        {hostKey.mismatch ? (
          <Banner tone="error">
            ⚠️ <b>这台主机提供的密钥与已记录的不一致。</b>
            可能对方重装了系统或换了密钥，也<b>可能有人在中间转发你的连接（中间人攻击）</b>。
            在弄清原因之前，不要接受。
            如果确认是自己重装了服务器，可以在设置里清除该主机的已知指纹后重新连接。
          </Banner>
        ) : (
          <Banner tone="warn">
            这是第一次连接 <b>{hostKey.host}</b>。请核对下面的指纹与你服务器的实际指纹是否一致
            （可在服务器上执行 <code className="mono">ssh-keygen -lf /etc/ssh/ssh_host_*_key.pub</code> 查看）。
            接受后会保存，之后不再询问。
          </Banner>
        )}

        <div className="kv" style={{ gridTemplateColumns: '96px minmax(0,1fr)', marginTop: 14 }}>
          <span className="kv__k">主机</span>
          <span className="kv__v mono">
            {hostKey.host}:{hostKey.port}
          </span>
          <span className="kv__k">密钥类型</span>
          <span className="kv__v mono">{hostKey.keyType}</span>
          <span className="kv__k">指纹</span>
          <span className="kv__v mono" style={{ overflowWrap: 'anywhere' }}>
            {hostKey.fingerprint}
          </span>
        </div>

        <div style={{ marginTop: 10 }}>
          <Button
            size="sm"
            variant="outline"
            icon="copy"
            onClick={() => {
              void copyText(hostKey.fingerprint)
              toast.ok('指纹已复制')
            }}
          >
            复制指纹
          </Button>
        </div>

        {err ? (
          <div style={{ marginTop: 12 }}>
            <Banner tone="error">{err}</Banner>
          </div>
        ) : null}
      </Modal>
    )
  }

  if (auth) {
    return (
      <Modal
        open
        size="sm"
        title={`需要回答服务器询问`}
        subtitle={`${auth.name}${auth.instructions ? ` · ${auth.instructions}` : ''}`}
        onClose={() => {
          // 关掉视为提交空响应：让后端按失败处理，而不是把连接挂死
          void answerAuth()
        }}
        footer={
          <>
            <div className="t-modal__footer-spacer" />
            <Button variant="primary" loading={busy} onClick={() => void answerAuth()}>
              提交
            </Button>
          </>
        }
      >
        <Banner tone="info">
          服务器要求交互式认证（keyboard-interactive）。这里输入的内容会按顺序提交给服务器。
        </Banner>
        <div style={{ marginTop: 12 }}>
          {auth.prompts.map((p, i) => (
            <Field key={`${p.prompt}-${i}`} label={p.prompt || `第 ${i + 1} 项`} required>
              <TextInput
                type={p.echo ? 'text' : 'password'}
                autoFocus={i === 0}
                autoComplete="off"
                value={answers[i] ?? ''}
                onChange={(e) =>
                  setAnswers((prev) => {
                    const next = [...prev]
                    next[i] = e.target.value
                    return next
                  })
                }
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void answerAuth()
                }}
              />
            </Field>
          ))}
        </div>
        {err ? (
          <div style={{ marginTop: 8 }}>
            <Banner tone="error">{err}</Banner>
          </div>
        ) : null}
      </Modal>
    )
  }

  return null
}

export default SshPrompts
