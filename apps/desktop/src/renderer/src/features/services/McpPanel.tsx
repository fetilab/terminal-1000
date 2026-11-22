// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * MCP 服务与令牌管理。
 *
 * 两处刻意设计：
 * 1. **明文令牌只出现一次**：`createClient` 返回后服务端只留 sha256 摘要。
 *    所以这里做成一次性展示 + 复制 + 醒目警告，关闭后无法再取回——
 *    假装"以后还能查"才是害用户。
 * 2. **默认最保守**：只监听回环、执行策略 confirm、sudo deny、工作区 deny、
 *    服务器与目录白名单为空。任何放宽都要用户显式操作，并在改动监听地址/端口时
 *    明确提示「需要重启才生效」。
 */

import { useCallback, useEffect, useState } from 'react'
import { Button, IconButton, Section } from '../../components/Button'
import { Badge, Banner, Loading } from '../../components/Feedback'
import { Checkbox, Field, Select, Switch, TextInput } from '../../components/Form'
import { Icon } from '../../components/Icon'
import { Modal } from '../../components/Modal'
import { toast } from '../../components/Toast'
import { invoke } from '../../lib/ipc'
import { errorText, formatDate } from '../../lib/format'

import type {
  McpPolicy,
  McpStatus,
  McpToolView,
  PublicMcpClient,
} from '@t1000/shared'
import { copyText } from '../../lib/clipboard'

/** 新建令牌时主进程会**只在这一次**回传明文 token，之后只有摘要 */
interface CreatedClientResponse {
  client: PublicMcpClient & { token?: string }
  notice?: string
}

const POLICY_OPTIONS = {
  execution: [
    { value: 'confirm', label: '每次确认（默认）' },
    { value: 'direct', label: '直接执行' },
  ],
  sudo: [
    { value: 'deny', label: '禁止（默认）' },
    { value: 'confirm', label: '需要确认' },
    { value: 'direct', label: '直接执行' },
  ],
  workspace: [
    { value: 'deny', label: '禁止（默认）' },
    { value: 'confirm', label: '需要确认' },
    { value: 'direct', label: '直接执行' },
  ],
}

export default function McpPanel(): React.JSX.Element {
  const [status, setStatus] = useState<McpStatus | null>(null)
  const [tools, setTools] = useState<McpToolView[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [restartNeeded, setRestartNeeded] = useState(false)

  // 一次性令牌
  const [issued, setIssued] = useState<{ name: string; token: string } | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [newName, setNewName] = useState('')
  const [newSudo, setNewSudo] = useState(false)
  const [newWorkspace, setNewWorkspace] = useState(false)

  // 策略草稿
  const [draft, setDraft] = useState<McpPolicy | null>(null)
  const [dirsText, setDirsText] = useState('')
  /** 启用的工具名；留空 = 全部启用（语义由主进程解释） */
  const [enabledTools, setEnabledTools] = useState<string[]>([])

  const refresh = useCallback(async () => {
    try {
      const st = await invoke<'mcp', 'status', Record<string, never>, McpStatus>('mcp', 'status', {})
      setStatus(st)
      setDraft(st.policy)
      setDirsText((st.policy.allowedLocalDirs ?? []).join('\n'))
      setEnabledTools(st.policy.enabledTools ?? [])
      setError(null)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setLoading(false)
    }
  }, [])

  const loadTools = useCallback(async () => {
    try {
      const res = await invoke<'mcp', 'listTools', Record<string, never>, { tools: McpToolView[] }>(
        'mcp',
        'listTools',
        {},
      )
      setTools(res?.tools ?? [])
    } catch {
      setTools([])
    }
  }, [])

  useEffect(() => {
    void refresh()
    void loadTools()
  }, [refresh, loadTools])

  const toggleServer = async (): Promise<void> => {
    if (!status) return
    setBusy(true)
    try {
      if (status.running) {
        await invoke<'mcp', 'stop', Record<string, never>, unknown>('mcp', 'stop', {})
        toast.ok('MCP 服务已停止')
      } else {
        await invoke<'mcp', 'start', Record<string, never>, unknown>('mcp', 'start', {})
        toast.ok('MCP 服务已启动')
      }
      await refresh()
    } catch (err) {
      toast.error(`${status.running ? '停止' : '启动'}失败：${errorText(err)}`)
    } finally {
      setBusy(false)
    }
  }

  const savePolicy = async (): Promise<void> => {
    if (!draft) return
    setBusy(true)
    try {
      const res = await invoke<
        'mcp',
        'setPolicy',
        Record<string, unknown>,
        { policy: McpPolicy; restartRequired: boolean; running: boolean }
      >('mcp', 'setPolicy', {
        listenHost: draft.listenHost,
        port: draft.port,
        executionPolicy: draft.executionPolicy,
        sudoPolicy: draft.sudoPolicy,
        workspacePolicy: draft.workspacePolicy,
        allowedServerIds: draft.allowedServerIds,
        allowedLocalDirs: dirsText
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean),
        enabledTools,
        defaultTimeoutMs: draft.defaultTimeoutMs,
        maxTimeoutMs: draft.maxTimeoutMs,
      })
      setDraft(res.policy)
      setRestartNeeded(res.restartRequired)
      await refresh()
      await loadTools()
      toast.ok(res.restartRequired ? '策略已保存 —— 监听地址/端口变更需要重启服务才生效' : '策略已保存')
    } catch (err) {
      toast.error(`保存失败：${errorText(err)}`)
    } finally {
      setBusy(false)
    }
  }

  const createClient = async (): Promise<void> => {
    if (!newName.trim()) return
    try {
      const res = await invoke<'mcp', 'createClient', Record<string, unknown>, CreatedClientResponse>(
        'mcp',
        'createClient',
        {
        name: newName.trim(),
        allowSudo: newSudo,
        allowWorkspace: newWorkspace,
      })
      setCreateOpen(false)
      setNewName('')
      setNewSudo(false)
      setNewWorkspace(false)
      const token = res.client?.token
      if (token) {
        // 只在这里展示一次；关闭弹窗后无法再取回
        setIssued({ name: res.client.name, token })
      } else {
        toast.warn('服务端未返回明文令牌，请查看主进程日志')
      }
      await refresh()
    } catch (err) {
      toast.error(`创建失败：${errorText(err)}`)
    }
  }

  if (loading && !status) return <Loading text="读取 MCP 状态…" />
  if (error && !status) {
    return (
      <div className="svc-body">
        <Banner tone="error" actions={<Button size="sm" onClick={() => void refresh()}>重试</Button>}>
          {error}
        </Banner>
      </div>
    )
  }
  if (!status || !draft) return <div />

  const grouped = tools.reduce<Record<string, McpToolView[]>>((acc, t) => {
    acc[t.group] = [...(acc[t.group] ?? []), t]
    return acc
  }, {})

  return (
    <div className="content-scroll svc-body">
      <Section>服务状态</Section>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
        <Badge tone={status.running ? 'ok' : 'default'}>{status.running ? '运行中' : '已停止'}</Badge>
        <span className="mono" style={{ fontSize: 12 }}>
          {status.endpoint}
        </span>
        <IconButton
          icon="copy"
          label="复制端点地址"
          onClick={() => {
            void copyText(status.endpoint)
            toast.ok('已复制端点地址')
          }}
        />
        <div style={{ flex: 1 }} />
        <Button
          variant={status.running ? 'outline' : 'primary'}
          icon={status.running ? 'close' : 'power'}
          loading={busy}
          onClick={() => void toggleServer()}
        >
          {status.running ? '停止服务' : '启动服务'}
        </Button>
      </div>

      {restartNeeded ? (
        <div style={{ marginBottom: 12 }}>
          <Banner tone="warn">监听地址或端口已修改，需要**重启 MCP 服务**后才生效。</Banner>
        </div>
      ) : null}

      {/* ── 策略 ── */}
      <Section>访问策略</Section>
      <p className="t-field__hint" style={{ marginTop: 0 }}>
        默认最保守：只监听回环、执行需确认、禁止 sudo、禁止工作区操作、服务器与目录白名单为空。
        放宽任何一项都会让 MCP 客户端获得更强的能力，请确认你信任调用方。
      </p>
      <div className="t-grid t-grid--2" style={{ marginTop: 10 }}>
        <Field
          label="监听地址"
          hint="保持 127.0.0.1 最安全；改成 0.0.0.0 会让局域网可访问"
          aside={draft.listenHost !== '127.0.0.1' ? <Badge tone="danger">已暴露</Badge> : undefined}
        >
          <TextInput
            value={draft.listenHost}
            mono
            onChange={(e) => setDraft({ ...draft, listenHost: e.target.value })}
          />
        </Field>
        <Field label="端口">
          <TextInput
            type="number"
            mono
            value={String(draft.port)}
            onChange={(e) => setDraft({ ...draft, port: Number(e.target.value) || 0 })}
          />
        </Field>
        <Field label="命令执行">
          <Select
            value={draft.executionPolicy}
            options={POLICY_OPTIONS.execution}
            onChange={(e) =>
              setDraft({ ...draft, executionPolicy: e.target.value as McpPolicy['executionPolicy'] })
            }
          />
        </Field>
        <Field label="sudo">
          <Select
            value={draft.sudoPolicy}
            options={POLICY_OPTIONS.sudo}
            onChange={(e) => setDraft({ ...draft, sudoPolicy: e.target.value as McpPolicy['sudoPolicy'] })}
          />
        </Field>
        <Field label="工作区操作">
          <Select
            value={draft.workspacePolicy}
            options={POLICY_OPTIONS.workspace}
            onChange={(e) =>
              setDraft({ ...draft, workspacePolicy: e.target.value as McpPolicy['workspacePolicy'] })
            }
          />
        </Field>
        <Field label="可见服务器范围">
          <Select
            value={Array.isArray(draft.allowedServerIds) ? 'restricted' : 'all'}
            options={[
              { value: 'restricted', label: '仅白名单内（推荐）' },
              { value: 'all', label: '全部服务器（不推荐）' },
            ]}
            onChange={(e) =>
              setDraft({ ...draft, allowedServerIds: e.target.value === 'all' ? 'all' : [] })
            }
          />
        </Field>
        <Field label="命令默认超时 (ms)">
          <TextInput
            type="number"
            mono
            value={String(draft.defaultTimeoutMs)}
            onChange={(e) => setDraft({ ...draft, defaultTimeoutMs: Number(e.target.value) || 0 })}
          />
        </Field>
        <Field label="命令超时上限 (ms)">
          <TextInput
            type="number"
            mono
            value={String(draft.maxTimeoutMs)}
            onChange={(e) => setDraft({ ...draft, maxTimeoutMs: Number(e.target.value) || 0 })}
          />
        </Field>
        <Field
          label="允许访问的本地目录"
          className="t-grid__span2"
          hint="每行一个绝对路径；留空表示不允许任何本地目录（路径校验用 realpath，防 .. 与软链绕过）"
        >
          <textarea
            className="t-textarea t-textarea--mono"
            rows={3}
            value={dirsText}
            onChange={(e) => setDirsText(e.target.value)}
          />
        </Field>
      </div>
      <div style={{ marginTop: 10, display: 'flex', gap: 8 }}>
        <Button variant="primary" icon="check" loading={busy} onClick={() => void savePolicy()}>
          保存策略
        </Button>
        <Button
          variant="ghost"
          onClick={() =>
            setDraft({
              listenHost: '127.0.0.1',
              port: draft.port,
              executionPolicy: 'confirm',
              sudoPolicy: 'deny',
              workspacePolicy: 'deny',
              allowedServerIds: [],
              allowedLocalDirs: [],
              defaultTimeoutMs: 60000,
              maxTimeoutMs: 600000,
              enabledTools: [],
            })
          }
        >
          恢复最保守默认
        </Button>
      </div>

      {/* ── 令牌 ── */}
      <Section right={<Badge>{status.clients.length} 个</Badge>}>访问令牌</Section>
      <div style={{ marginBottom: 10 }}>
        <Button variant="outline" icon="key" onClick={() => setCreateOpen(true)}>
          新建客户端令牌
        </Button>
      </div>

      {status.clients.length === 0 ? (
        <p className="t-field__hint">还没有任何客户端。MCP 客户端必须带 Bearer 令牌才能调用工具。</p>
      ) : (
        status.clients.map((c) => (
          <div className={`svc-client${c.revoked ? ' svc-client--revoked' : ''}`} key={c.id}>
            <Icon name="key" size={15} />
            <div className="svc-client__body">
              <div className="svc-client__name">{c.name}</div>
              <div className="svc-client__meta">
                {formatDate(c.createdAt)} · {c.allowSudo ? '可 sudo' : '无 sudo'} ·{' '}
                {c.allowWorkspace ? '可工作区' : '无工作区'}
              </div>
            </div>
            {c.revoked ? (
              <Badge tone="warn">已吊销</Badge>
            ) : (
              <Button
                size="sm"
                variant="danger"
                icon="trash"
                onClick={() => {
                  void invoke<'mcp', 'revokeClient', { clientId: string }, unknown>(
                    'mcp',
                    'revokeClient',
                    { clientId: c.id },
                  )
                    .then(() => {
                      toast.ok(`已吊销「${c.name}」`)
                      return refresh()
                    })
                    .catch((err: unknown) => toast.error(`吊销失败：${errorText(err)}`))
                }}
              >
                吊销
              </Button>
            )}
          </div>
        ))
      )}

      {/* ── 工具清单 ── */}
      <Section right={<Badge>{status.tools.length} 项启用</Badge>}>暴露的工具</Section>
      {Object.entries(grouped).map(([group, list]) => (
        <div key={group} style={{ marginBottom: 12 }}>
          <div className="t-field__label" style={{ marginBottom: 6 }}>
            {group}
          </div>
          <div className="svc-tools">
            {list.map((t) => (
              <span
                key={t.name}
                className={`svc-tool${t.enabled ? '' : ' svc-tool--off'}${t.requiresSudo ? ' svc-tool--sudo' : ''}`}
                title={`${t.description}${t.requiresSudo ? ' · 需要 sudo 授权' : ''}`}
              >
                {t.name}
                {t.requiresSudo ? <Icon name="shield" size={11} /> : null}
              </span>
            ))}
          </div>
        </div>
      ))}

      {/* ── 新建客户端 ── */}
      <Modal
        open={createOpen}
        size="sm"
        title="新建客户端令牌"
        onClose={() => setCreateOpen(false)}
        footer={
          <>
            <div className="t-modal__footer-spacer" />
            <Button variant="ghost" onClick={() => setCreateOpen(false)}>
              取消
            </Button>
            <Button variant="primary" disabled={!newName.trim()} onClick={() => void createClient()}>
              生成令牌
            </Button>
          </>
        }
      >
        <div className="t-grid">
          <Field label="客户端名称" required hint="用于在列表里辨认是哪台设备/哪个工具">
            <TextInput
              value={newName}
              autoFocus
              placeholder="例如：claude-desktop"
              onChange={(e) => setNewName(e.target.value)}
            />
          </Field>
          <Checkbox checked={newSudo} onChange={setNewSudo} label="允许该令牌使用 sudo（还需全局 sudo 策略允许）" />
          <Checkbox checked={newWorkspace} onChange={setNewWorkspace} label="允许该令牌操作工作区" />
        </div>
      </Modal>

      {/* ── 一次性令牌展示 ── */}
      <Modal
        open={issued !== null}
        size="md"
        title="令牌已生成 —— 请立即保存"
        closeOnOverlay={false}
        onClose={() => setIssued(null)}
        footer={
          <>
            <div className="t-modal__footer-spacer" />
            <Button
              variant="outline"
              icon="copy"
              onClick={() => {
                if (!issued) return
                void copyText(issued.token)
                toast.ok('已复制令牌')
              }}
            >
              复制令牌
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                setIssued(null)
                toast.info('令牌窗口已关闭，之后无法再次查看')
              }}
            >
              我已保存，关闭
            </Button>
          </>
        }
      >
        {issued ? (
          <div className="svc-token">
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Icon name="alert-triangle" size={16} />
              <b>这是唯一一次能看到明文令牌的机会</b>
            </div>
            <div className="t-field__hint" style={{ color: 'inherit' }}>
              服务端只保存它的 SHA-256 摘要，关闭本窗口后**无法再次取回**。
              如果丢失，只能吊销后重新生成。
            </div>
            <div className="svc-token__value">
              <code>{issued.token}</code>
            </div>
            <div className="t-field__hint" style={{ color: 'inherit' }}>
              客户端「{issued.name}」调用时需带上：<br />
              <code className="mono">Authorization: Bearer &lt;令牌&gt;</code>
            </div>
          </div>
        ) : null}
      </Modal>
    </div>
  )
}
