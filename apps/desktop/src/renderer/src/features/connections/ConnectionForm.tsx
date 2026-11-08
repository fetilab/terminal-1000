// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * SSH 连接编辑表单（6 分区）。
 *
 * 结构对齐 spec/00-overview.md §2.3 的字段字典：
 * 基本信息 / 连接设置 / 跳板机 / 代理 / 其他算法 / 初始化脚本。
 *
 * 设计取舍：
 * - 表单状态是**扁平 draft**，不与 SshConnection 的嵌套结构一一对应，
 *   因为嵌套结构里 options / keepalive / proxy 层级太深，直接双向绑定会很啰嗦；
 *   提交时再组装成契约类型。
 * - 所有数字输入以 string 保存，避免「用户删光输入框」时被 Number('') = 0 吃掉。
 */

import { useEffect, useMemo, useState } from 'react'
import {
  SSH_AUTH_TYPES,
  type ConnectionGroup,
  type ProxyProtocol,
  type SshAuthType,
  type SshConnection,
  type StoreType,
  type TerminalEncoding,
} from '@t1000/shared'
import { Button, Section } from '../../components/Button'
import { Badge } from '../../components/Feedback'
import { Checkbox, Field, Select, Switch, TextArea, TextInput } from '../../components/Form'
import { Icon } from '../../components/Icon'
import { Modal } from '../../components/Modal'
import { toast } from '../../components/Toast'
import { invoke } from '../../lib/ipc'
import { errorText } from '../../lib/format'
import {
  actions,
  connectionAddress,
  getConnection,
  newConnectionId,
  saveConnection,
  useStoreShallow,
  type GroupNode,
  type UiConnection,
} from '../../lib/store'
import ProtocolForm, { type ProtocolKind } from './ProtocolForm'
import './connections.css'

const AUTH_LABELS: Record<SshAuthType, string> = {
  password: '密码',
  privateKey: '私钥',
  identity: '引用凭证',
  keyboardInteractive: '交互式（含 2FA）',
  keyboard: 'keyboard（兼容旧命名）',
}

const ENCODINGS: readonly TerminalEncoding[] = [
  'utf-8',
  'gbk',
  'gb18030',
  'big5',
  'latin1',
  'euc-jp',
  'shift_jis',
]

interface JumpDraft {
  key: string
  name: string
  host: string
  port: string
  username: string
  authType: SshAuthType
  password: string
  privateKey: string
  passphrase: string
  verifyHostKey: boolean
}

interface Draft {
  name: string
  groupId: string
  host: string
  port: string
  username: string
  authType: SshAuthType
  password: string
  privateKey: string
  passphrase: string
  identityId: string
  authOrder: SshAuthType[]
  note: string
  storeType: StoreType
  timeoutMs: string
  keepaliveMs: string
  shellText: string
  shellIntervalMs: string
  encoding: TerminalEncoding
  term: string
  colorTerm: string
  disableProxy: boolean
  disablePwdSync: boolean
  disableListing: boolean
  x11Enabled: boolean
  x11CookieMode: string
  proxyUrl: string
  proxyProtocol: ProxyProtocol | ''
  proxyHost: string
  proxyPort: string
  proxyUsername: string
  proxyPassword: string
  kex: string
  cipher: string
  hostKey: string
  hmac: string
  compress: string
  initScript: string
  jumps: JumpDraft[]
}

function emptyDraft(): Draft {
  return {
    name: '',
    groupId: '',
    host: '',
    port: '22',
    username: '',
    authType: 'password',
    password: '',
    privateKey: '',
    passphrase: '',
    identityId: '',
    authOrder: [],
    note: '',
    storeType: 'local',
    timeoutMs: '15000',
    keepaliveMs: '5000',
    shellText: '',
    shellIntervalMs: '',
    encoding: 'utf-8',
    term: '',
    colorTerm: '',
    disableProxy: false,
    disablePwdSync: false,
    disableListing: false,
    x11Enabled: false,
    x11CookieMode: '',
    proxyUrl: '',
    proxyProtocol: '',
    proxyHost: '',
    proxyPort: '',
    proxyUsername: '',
    proxyPassword: '',
    kex: '',
    cipher: '',
    hostKey: '',
    hmac: '',
    compress: '',
    initScript: '',
    jumps: [],
  }
}

const splitList = (text: string): string[] | undefined => {
  const parts = text
    .split(/[,，\s]+/)
    .map((s) => s.trim())
    .filter(Boolean)
  return parts.length > 0 ? parts : undefined
}

const joinList = (list: string[] | undefined): string => (list ?? []).join(', ')

function num(value: string): number | undefined {
  const n = Number(value)
  return value.trim() !== '' && Number.isFinite(n) ? n : undefined
}

function toDraft(conn: UiConnection & { kind: 'ssh' }): Draft {
  const base = emptyDraft()
  const opt = conn.options
  return {
    ...base,
    name: conn.name,
    groupId: conn.groupId ?? '',
    host: conn.host,
    port: String(conn.port),
    username: conn.username,
    authType: conn.authType,
    password: conn.password ?? '',
    privateKey: conn.privateKey ?? '',
    passphrase: conn.passphrase ?? '',
    identityId: conn.identityId ?? '',
    authOrder: conn.authOrder ?? [],
    note: conn.note ?? '',
    storeType: conn.storeType ?? 'local',
    timeoutMs: opt?.timeoutMs === undefined ? '' : String(opt.timeoutMs),
    keepaliveMs:
      opt?.keepalive?.transportIntervalMs === undefined ? '5000' : String(opt.keepalive.transportIntervalMs),
    shellText: opt?.keepalive?.shell?.text ?? '',
    shellIntervalMs:
      opt?.keepalive?.shell?.intervalMs === undefined ? '' : String(opt.keepalive.shell.intervalMs),
    encoding: opt?.encoding ?? 'utf-8',
    term: opt?.term ?? '',
    colorTerm: opt?.colorTerm ?? '',
    disableProxy: opt?.disableProxy ?? false,
    disablePwdSync: opt?.disablePwdSync ?? false,
    disableListing: opt?.disableListing ?? false,
    x11Enabled: opt?.x11?.enabled ?? false,
    x11CookieMode: opt?.x11?.cookieMode ?? '',
    proxyUrl: conn.proxy?.url ?? '',
    proxyProtocol: conn.proxy?.protocol ?? '',
    proxyHost: conn.proxy?.host ?? '',
    proxyPort: conn.proxy?.port === undefined ? '' : String(conn.proxy.port),
    proxyUsername: conn.proxy?.username ?? '',
    proxyPassword: conn.proxy?.password ?? '',
    kex: joinList(opt?.algorithms?.kex),
    cipher: joinList(opt?.algorithms?.cipher),
    hostKey: joinList(opt?.algorithms?.hostKey),
    hmac: joinList(opt?.algorithms?.hmac),
    compress: joinList(opt?.algorithms?.compress),
    initScript: conn.initScript ?? '',
    jumps: (conn.jumpChain ?? []).map((hop, i) => ({
      key: hop.id || `hop-${i}`,
      name: hop.name ?? '',
      host: hop.host,
      port: String(hop.port),
      username: hop.username,
      authType: hop.authType,
      password: hop.password ?? '',
      privateKey: hop.privateKey ?? '',
      passphrase: hop.passphrase ?? '',
      verifyHostKey: hop.verifyHostKey ?? true,
    })),
  }
}

function buildConnection(draft: Draft, existing: UiConnection | undefined, id: string): SshConnection {
  const now = new Date().toISOString()
  const algorithms = {
    ...(splitList(draft.kex) ? { kex: splitList(draft.kex) } : {}),
    ...(splitList(draft.cipher) ? { cipher: splitList(draft.cipher) } : {}),
    ...(splitList(draft.hostKey) ? { hostKey: splitList(draft.hostKey) } : {}),
    ...(splitList(draft.hmac) ? { hmac: splitList(draft.hmac) } : {}),
    ...(splitList(draft.compress) ? { compress: splitList(draft.compress) } : {}),
  }

  const keepalive = {
    ...(num(draft.keepaliveMs) === undefined ? {} : { transportIntervalMs: num(draft.keepaliveMs) }),
    ...(draft.shellText || draft.shellIntervalMs
      ? {
          shell: {
            ...(draft.shellText ? { text: draft.shellText } : {}),
            ...(num(draft.shellIntervalMs) === undefined
              ? {}
              : { intervalMs: num(draft.shellIntervalMs) }),
          },
        }
      : {}),
  }

  const proxy =
    draft.proxyUrl || draft.proxyHost
      ? {
          url: draft.proxyUrl,
          ...(draft.proxyProtocol ? { protocol: draft.proxyProtocol } : {}),
          ...(draft.proxyHost ? { host: draft.proxyHost } : {}),
          ...(num(draft.proxyPort) === undefined ? {} : { port: num(draft.proxyPort) }),
          ...(draft.proxyUsername ? { username: draft.proxyUsername } : {}),
          ...(draft.proxyPassword ? { password: draft.proxyPassword } : {}),
        }
      : undefined

  const jumpChain = draft.jumps
    .filter((j) => j.host.trim().length > 0)
    .map((j) => ({
      id: j.key,
      host: j.host.trim(),
      port: num(j.port) ?? 22,
      username: j.username.trim(),
      authType: j.authType,
      ...(j.name ? { name: j.name } : {}),
      ...(j.password ? { password: j.password } : {}),
      ...(j.privateKey ? { privateKey: j.privateKey } : {}),
      ...(j.passphrase ? { passphrase: j.passphrase } : {}),
      verifyHostKey: j.verifyHostKey,
    }))

  return {
    kind: 'ssh',
    id,
    name: draft.name.trim(),
    ...(draft.groupId ? { groupId: draft.groupId } : {}),
    host: draft.host.trim(),
    port: num(draft.port) ?? 22,
    username: draft.username.trim(),
    authType: draft.authType,
    ...(draft.authType === 'password' && draft.password ? { password: draft.password } : {}),
    ...(draft.authType === 'privateKey' && draft.privateKey
      ? { privateKey: draft.privateKey, passphrase: draft.passphrase }
      : {}),
    ...(draft.authType === 'identity' && draft.identityId ? { identityId: draft.identityId } : {}),
    ...(draft.authOrder.length > 0 ? { authOrder: draft.authOrder } : {}),
    ...(draft.note ? { note: draft.note } : {}),
    ...(proxy ? { proxy } : {}),
    ...(jumpChain.length > 0 ? { jumpChain } : {}),
    options: {
      ...(num(draft.timeoutMs) === undefined ? {} : { timeoutMs: num(draft.timeoutMs) }),
      keepalive,
      ...(Object.keys(algorithms).length > 0 ? { algorithms } : {}),
      ...(draft.term ? { term: draft.term } : {}),
      ...(draft.colorTerm ? { colorTerm: draft.colorTerm } : {}),
      encoding: draft.encoding,
      ...(draft.disableProxy ? { disableProxy: true } : {}),
      ...(draft.disablePwdSync ? { disablePwdSync: true } : {}),
      ...(draft.disableListing ? { disableListing: true } : {}),
      ...(draft.x11Enabled
        ? { x11: { enabled: true, ...(draft.x11CookieMode ? { cookieMode: draft.x11CookieMode } : {}) } }
        : {}),
    },
    ...(draft.initScript ? { initScript: draft.initScript } : {}),
    storeType: draft.storeType,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  }
}

/* ── 认证顺序编辑器 ─────────────────────────────── */

function AuthOrderEditor({
  value,
  onChange,
}: {
  value: SshAuthType[]
  onChange: (next: SshAuthType[]) => void
}): React.JSX.Element {
  const available = SSH_AUTH_TYPES.filter((t) => !value.includes(t))
  const move = (index: number, delta: number): void => {
    const next = [...value]
    const target = index + delta
    if (target < 0 || target >= next.length) return
    const [item] = next.splice(index, 1)
    if (item) next.splice(target, 0, item)
    onChange(next)
  }
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
      {value.length === 0 ? (
        <span className="t-field__hint">未指定（按库默认顺序尝试）</span>
      ) : (
        value.map((t, i) => (
          <span key={t} className="t-badge t-badge--accent" style={{ gap: 2, paddingRight: 3 }}>
            {i + 1}. {AUTH_LABELS[t]}
            <button
              type="button"
              className="t-iconbtn"
              style={{ width: 18, height: 18 }}
              aria-label={`上移 ${AUTH_LABELS[t]}`}
              onClick={() => move(i, -1)}
            >
              <Icon name="chevron-left" size={11} />
            </button>
            <button
              type="button"
              className="t-iconbtn"
              style={{ width: 18, height: 18 }}
              aria-label={`下移 ${AUTH_LABELS[t]}`}
              onClick={() => move(i, 1)}
            >
              <Icon name="chevron-right" size={11} />
            </button>
            <button
              type="button"
              className="t-iconbtn t-iconbtn--danger"
              style={{ width: 18, height: 18 }}
              aria-label={`移除 ${AUTH_LABELS[t]}`}
              onClick={() => onChange(value.filter((x) => x !== t))}
            >
              <Icon name="close" size={11} />
            </button>
          </span>
        ))
      )}
      {available.length > 0 ? (
        <Select
          value=""
          style={{ width: 150, height: 26 }}
          onChange={(e) => {
            const t = e.target.value as SshAuthType
            if (t) onChange([...value, t])
          }}
          options={[
            { value: '', label: '+ 添加认证方式' },
            ...available.map((t) => ({ value: t, label: AUTH_LABELS[t] })),
          ]}
        />
      ) : null}
    </div>
  )
}

/* ── 主表单 ─────────────────────────────────────── */

export default function ConnectionForm(): React.JSX.Element {
  const { editing, groups, saving } = useStoreShallow((s) => ({
    editing: s.editing,
    groups: s.groups,
    saving: s.saving,
  }))

  const existing = editing?.mode === 'edit' ? getConnection(editing.id) : undefined
  /**
   * 目标协议。
   * 之前只看 `existing`，导致从 Telnet/RDP/VNC/隧道 标签点「新建连接」时
   * `existing` 是 undefined → 一律走 SSH 分支，**建出来的其实是 SSH 连接**。
   * 正确来源是：编辑看已有连接的 kind，新建看 editing.kind（由当前协议标签传入）。
   */
  const targetKind = existing?.kind ?? editing?.kind ?? 'ssh'
  const isSsh = targetKind === 'ssh'

  const [draft, setDraft] = useState<Draft>(() =>
    existing && existing.kind === 'ssh' ? toDraft(existing) : emptyDraft(),
  )
  const [errors, setErrors] = useState<Partial<Record<keyof Draft, string>>>({})
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null)
  const [testing, setTesting] = useState(false)

  const patch = <K extends keyof Draft>(key: K, value: Draft[K]): void => {
    setDraft((d) => ({ ...d, [key]: value }))
    setErrors((e) => (e[key] ? { ...e, [key]: undefined } : e))
  }

  const flatGroups = useMemo(() => {
    const out: Array<{ value: string; label: string }> = []
    const walk = (nodes: GroupNode[], depth: number): void => {
      for (const n of nodes) {
        out.push({ value: n.id, label: `${'　'.repeat(depth)}${n.name}` })
        walk(n.children, depth + 1)
      }
    }
    walk(groups, 0)
    return out
  }, [groups])

  const validate = (): boolean => {
    const next: Partial<Record<keyof Draft, string>> = {}
    if (!draft.name.trim()) next.name = '名称不能为空'
    if (!draft.host.trim()) next.host = '主机地址不能为空'
    const port = num(draft.port)
    if (port === undefined || port < 1 || port > 65535) next.port = '端口需在 1-65535 之间'
    if (!draft.username.trim()) next.username = '登录用户不能为空'
    if (draft.authType === 'privateKey' && !draft.privateKey.trim()) next.privateKey = '请粘贴私钥内容'
    if (draft.authType === 'identity' && !draft.identityId.trim()) next.identityId = '请填写凭证 ID'
    setErrors(next)
    return Object.keys(next).length === 0
  }

  const onSave = async (): Promise<void> => {
    if (!isSsh) {
      toast.warn('当前版本只实现了 SSH 表单，其他协议请等后续版本')
      return
    }
    if (!validate()) return
    const id = existing?.id ?? newConnectionId()
    const built = buildConnection(draft, existing, id)
    const merged: UiConnection = {
      ...built,
      ...(existing?.favorite === undefined ? {} : { favorite: existing.favorite }),
      ...(existing?.lastUsedAt === undefined ? {} : { lastUsedAt: existing.lastUsedAt }),
      ...(existing?.useCount === undefined ? {} : { useCount: existing.useCount }),
    }
    const ok = await saveConnection(merged)
    if (ok) toast.ok(existing ? `已保存「${merged.name}」` : `已创建「${merged.name}」`)
  }

  const onTest = async (): Promise<void> => {
    if (!validate()) return
    setTesting(true)
    setTestResult(null)
    const built = buildConnection(draft, existing, existing?.id ?? 'test-only')
    const started = performance.now()
    try {
      const res = await invoke<'ssh', 'testConnection', { connection: SshConnection }, unknown>(
        'ssh',
        'testConnection',
        { connection: built },
      )
      const ms = Math.round(performance.now() - started)
      const detail =
        res && typeof res === 'object' && 'message' in res && typeof res.message === 'string'
          ? res.message
          : '认证通过，可以建立会话'
      setTestResult({ ok: true, text: `${detail}（往返 ${ms} ms）` })
    } catch (err) {
      const ms = Math.round(performance.now() - started)
      setTestResult({ ok: false, text: `${errorText(err)}（耗时 ${ms} ms）` })
    } finally {
      setTesting(false)
    }
  }

  useEffect(() => {
    setTestResult(null)
  }, [draft.host, draft.port, draft.username, draft.authType])

  // 非 SSH 走同一套表单外壳（字段表驱动），按 kind 切换字段组
  if (!isSsh) {
    return (
      <Modal
        open
        title={existing ? `编辑连接 · ${existing.name}` : `新建 ${targetKind.toUpperCase()} 连接`}
        subtitle={
          existing
            ? connectionAddress(existing)
            : '字段按该协议的契约填写；带 * 的为必填'
        }
        onClose={() => actions.closeEditor()}
      >
        <ProtocolForm kind={targetKind as ProtocolKind} existingId={existing?.id} />
      </Modal>
    )
  }

  const showPassword = draft.authType === 'password'
  const showKey = draft.authType === 'privateKey'
  const showIdentity = draft.authType === 'identity'

  return (
    <Modal
      open
      title={existing ? `编辑连接 · ${existing.name}` : '新建 SSH 连接'}
      subtitle={existing ? connectionAddress(existing) : '按分区填写，带 * 的为必填'}
      onClose={() => actions.closeEditor()}
      footer={
        <>
          <Button variant="outline" icon="route" loading={testing} onClick={() => void onTest()}>
            测试连接
          </Button>
          <span className="form-footer-hint">
            {draft.jumps.length > 0 ? `经 ${draft.jumps.length} 跳跳板` : '直连'}
            {draft.proxyUrl ? ' · 走代理' : ''}
          </span>
          <div className="t-modal__footer-spacer" />
          <Button variant="ghost" onClick={() => actions.closeEditor()}>
            取消
          </Button>
          <Button variant="primary" loading={saving} onClick={() => void onSave()}>
            {existing ? '保存' : '创建'}
          </Button>
        </>
      }
    >
      {/* ── 1. 基本信息 ───────────────────────── */}
      <Section>基本信息</Section>
      <div className="t-grid t-grid--2 form-section-body">
        <Field label="名称" required error={errors.name}>
          <TextInput
            value={draft.name}
            placeholder="例如：prod-web-01"
            invalid={Boolean(errors.name)}
            onChange={(e) => patch('name', e.target.value)}
          />
        </Field>
        <Field label="分组">
          <Select
            value={draft.groupId}
            onChange={(e) => patch('groupId', e.target.value)}
            options={[{ value: '', label: '（未分组）' }, ...flatGroups]}
          />
        </Field>

        <Field label="主机地址" required error={errors.host} className="t-grid__span2">
          <div className="t-inputgroup">
            <div className="t-inputgroup__grow">
              <TextInput
                value={draft.host}
                mono
                placeholder="10.0.0.12 或 db.internal"
                invalid={Boolean(errors.host)}
                onChange={(e) => patch('host', e.target.value)}
              />
            </div>
            <div className="t-inputgroup__port">
              <TextInput
                value={draft.port}
                mono
                inputMode="numeric"
                placeholder="22"
                invalid={Boolean(errors.port)}
                onChange={(e) => patch('port', e.target.value)}
              />
            </div>
          </div>
        </Field>

        <Field label="登录用户" required error={errors.username}>
          <TextInput
            value={draft.username}
            mono
            placeholder="root"
            invalid={Boolean(errors.username)}
            onChange={(e) => patch('username', e.target.value)}
          />
        </Field>
        <Field label="验证方式" hint="决定下方需要填写哪类凭据">
          <Select
            value={draft.authType}
            onChange={(e) => patch('authType', e.target.value as SshAuthType)}
            options={SSH_AUTH_TYPES.map((t) => ({ value: t, label: AUTH_LABELS[t] }))}
          />
        </Field>

        {showPassword ? (
          <Field label="密码" className="t-grid__span2" hint="保存在本地库中，由主密码加密">
            <TextInput
              type="password"
              value={draft.password}
              autoComplete="off"
              onChange={(e) => patch('password', e.target.value)}
            />
          </Field>
        ) : null}

        {showKey ? (
          <>
            <Field label="私钥" required error={errors.privateKey} className="t-grid__span2" hint="PEM 或 OpenSSH 格式文本">
              <TextArea
                value={draft.privateKey}
                mono
                rows={5}
                placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                invalid={Boolean(errors.privateKey)}
                onChange={(e) => patch('privateKey', e.target.value)}
              />
            </Field>
            <Field label="私钥口令" className="t-grid__span2">
              <TextInput
                type="password"
                value={draft.passphrase}
                autoComplete="off"
                onChange={(e) => patch('passphrase', e.target.value)}
              />
            </Field>
          </>
        ) : null}

        {showIdentity ? (
          <Field label="凭证 ID" required error={errors.identityId} className="t-grid__span2" hint="引用凭证库中的条目，不在此处内联密钥">
            <TextInput
              value={draft.identityId}
              mono
              onChange={(e) => patch('identityId', e.target.value)}
            />
          </Field>
        ) : null}

        <Field label="认证顺序" className="t-grid__span2" hint="留空则使用库默认顺序；可拖拽式调整（用箭头按钮）">
          <AuthOrderEditor value={draft.authOrder} onChange={(v) => patch('authOrder', v)} />
        </Field>

        <Field label="主机备注" className="t-grid__span2">
          <TextArea
            value={draft.note}
            rows={2}
            placeholder="记录这台机器的用途、变更注意事项…"
            onChange={(e) => patch('note', e.target.value)}
          />
        </Field>

        <Field label="连接超时 (ms)">
          <TextInput
            value={draft.timeoutMs}
            mono
            inputMode="numeric"
            onChange={(e) => patch('timeoutMs', e.target.value)}
          />
        </Field>
        <Field label="传输层心跳 (ms)" hint="默认 5000；设为 0 关闭">
          <TextInput
            value={draft.keepaliveMs}
            mono
            inputMode="numeric"
            onChange={(e) => patch('keepaliveMs', e.target.value)}
          />
        </Field>
        <Field label="存储位置">
          <Select
            value={draft.storeType}
            onChange={(e) => patch('storeType', e.target.value as StoreType)}
            options={[
              { value: 'local', label: '本地仓库' },
              { value: 'cloud', label: '云端仓库（需先配置同步）' },
            ]}
          />
        </Field>
      </div>

      {/* ── 2. 连接设置 ───────────────────────── */}
      <Section>连接设置</Section>
      <div className="t-grid t-grid--2 form-section-body">
        <Field label="终端显示编码">
          <Select
            value={draft.encoding}
            onChange={(e) => patch('encoding', e.target.value as TerminalEncoding)}
            options={ENCODINGS.map((enc) => ({ value: enc, label: enc }))}
          />
        </Field>
        <Field label="终端类型 TERM" hint="留空使用 xterm-256color">
          <TextInput
            value={draft.term}
            mono
            placeholder="xterm-256color"
            onChange={(e) => patch('term', e.target.value)}
          />
        </Field>
        <Field label="COLORTERM" hint="如 truecolor">
          <TextInput
            value={draft.colorTerm}
            mono
            onChange={(e) => patch('colorTerm', e.target.value)}
          />
        </Field>
        <Field label="Shell 层保活" hint="定期往会话里发送字符，防止中间设备掐连接">
          <div className="t-inputgroup">
            <div className="t-inputgroup__grow">
              <TextInput
                value={draft.shellText}
                mono
                placeholder="发送的字符"
                onChange={(e) => patch('shellText', e.target.value)}
              />
            </div>
            <div className="t-inputgroup__port">
              <TextInput
                value={draft.shellIntervalMs}
                mono
                placeholder="ms"
                onChange={(e) => patch('shellIntervalMs', e.target.value)}
              />
            </div>
          </div>
        </Field>

        <div className="t-grid t-grid--2 t-grid__span2" style={{ gap: 10 }}>
          <Switch
            checked={draft.disableProxy}
            onChange={(v) => patch('disableProxy', v)}
            label="禁用代理（优先直连）"
          />
          <Switch
            checked={draft.disableListing}
            onChange={(v) => patch('disableListing', v)}
            label="禁止列表监控"
          />
          <Switch
            checked={draft.disablePwdSync}
            onChange={(v) => patch('disablePwdSync', v)}
            label="禁用 pwd 自动跳转"
          />
          <Switch
            checked={draft.x11Enabled}
            onChange={(v) => patch('x11Enabled', v)}
            label="启用 X11 转发"
          />
        </div>
        {draft.x11Enabled ? (
          <Field label="X11 Cookie 模式" className="t-grid__span2">
            <TextInput
              value={draft.x11CookieMode}
              mono
              onChange={(e) => patch('x11CookieMode', e.target.value)}
            />
          </Field>
        ) : null}
      </div>

      {/* ── 3. 跳板机 ─────────────────────────── */}
      <Section right={<Badge>{draft.jumps.length} / 20</Badge>}>跳板机链路</Section>
      <div className="form-section-body form-jump">
        <p className="t-field__hint" style={{ margin: 0 }}>
          按顺序逐跳连接，第一项最先连。最多 20 跳。
        </p>
        {draft.jumps.map((hop, i) => (
          <div className="form-jump__hop" key={hop.key}>
            <span className="form-jump__index">{i + 1}</span>
            <div className="form-jump__grid">
              <TextInput
                value={hop.host}
                mono
                placeholder="跳板地址"
                onChange={(e) =>
                  patch(
                    'jumps',
                    draft.jumps.map((h) => (h.key === hop.key ? { ...h, host: e.target.value } : h)),
                  )
                }
              />
              <TextInput
                value={hop.port}
                mono
                placeholder="22"
                onChange={(e) =>
                  patch(
                    'jumps',
                    draft.jumps.map((h) => (h.key === hop.key ? { ...h, port: e.target.value } : h)),
                  )
                }
              />
              <TextInput
                value={hop.username}
                mono
                placeholder="用户"
                onChange={(e) =>
                  patch(
                    'jumps',
                    draft.jumps.map((h) => (h.key === hop.key ? { ...h, username: e.target.value } : h)),
                  )
                }
              />
              <Select
                value={hop.authType}
                onChange={(e) =>
                  patch(
                    'jumps',
                    draft.jumps.map((h) =>
                      h.key === hop.key ? { ...h, authType: e.target.value as SshAuthType } : h,
                    ),
                  )
                }
                options={SSH_AUTH_TYPES.map((t) => ({ value: t, label: AUTH_LABELS[t] }))}
              />
              <TextInput
                type="password"
                value={hop.authType === 'privateKey' ? hop.passphrase : hop.password}
                placeholder={hop.authType === 'privateKey' ? '私钥口令（可选）' : '密码（可选）'}
                onChange={(e) =>
                  patch(
                    'jumps',
                    draft.jumps.map((h) =>
                      h.key === hop.key
                        ? hop.authType === 'privateKey'
                          ? { ...h, passphrase: e.target.value }
                          : { ...h, password: e.target.value }
                        : h,
                    ),
                  )
                }
              />
              <Checkbox
                checked={hop.verifyHostKey}
                label="校验主机指纹"
                onChange={(v) =>
                  patch(
                    'jumps',
                    draft.jumps.map((h) => (h.key === hop.key ? { ...h, verifyHostKey: v } : h)),
                  )
                }
              />
            </div>
            <div className="form-jump__actions">
              <Button
                size="sm"
                variant="ghost"
                icon="chevron-left"
                disabled={i === 0}
                title="上移"
                onClick={() => {
                  const next = [...draft.jumps]
                  const prev = next[i - 1]
                  const cur = next[i]
                  if (!prev || !cur) return
                  next[i - 1] = cur
                  next[i] = prev
                  patch('jumps', next)
                }}
              />
              <Button
                size="sm"
                variant="ghost"
                icon="chevron-right"
                disabled={i === draft.jumps.length - 1}
                title="下移"
                onClick={() => {
                  const next = [...draft.jumps]
                  const nxt = next[i + 1]
                  const cur = next[i]
                  if (!nxt || !cur) return
                  next[i + 1] = cur
                  next[i] = nxt
                  patch('jumps', next)
                }}
              />
              <Button
                size="sm"
                variant="danger"
                icon="trash"
                title="删除该跳"
                onClick={() => patch('jumps', draft.jumps.filter((h) => h.key !== hop.key))}
              />
            </div>
          </div>
        ))}
        <div>
          <Button
            size="sm"
            variant="outline"
            icon="plus"
            disabled={draft.jumps.length >= 20}
            onClick={() =>
              patch('jumps', [
                ...draft.jumps,
                {
                  key: `hop-${Date.now()}-${draft.jumps.length}`,
                  name: '',
                  host: '',
                  port: '22',
                  username: '',
                  authType: 'password',
                  password: '',
                  privateKey: '',
                  passphrase: '',
                  verifyHostKey: true,
                },
              ])
            }
          >
            添加跳板
          </Button>
        </div>
      </div>

      {/* ── 4. 代理 ───────────────────────────── */}
      <Section>代理设置</Section>
      <div className="t-grid t-grid--2 form-section-body">
        <Field label="代理地址" className="t-grid__span2" hint="形如 socks5://127.0.0.1:1080；代理优先于跳板链">
          <TextInput
            value={draft.proxyUrl}
            mono
            placeholder="socks5://127.0.0.1:1080"
            onChange={(e) => patch('proxyUrl', e.target.value)}
          />
        </Field>
        <Field label="协议">
          <Select
            value={draft.proxyProtocol}
            onChange={(e) => patch('proxyProtocol', e.target.value as ProxyProtocol | '')}
            options={[
              { value: '', label: '从地址推断' },
              { value: 'socks5', label: 'SOCKS5' },
              { value: 'socks4', label: 'SOCKS4' },
              { value: 'http', label: 'HTTP' },
              { value: 'https', label: 'HTTPS' },
            ]}
          />
        </Field>
        <Field label="主机 / 端口">
          <div className="t-inputgroup">
            <div className="t-inputgroup__grow">
              <TextInput
                value={draft.proxyHost}
                mono
                onChange={(e) => patch('proxyHost', e.target.value)}
              />
            </div>
            <div className="t-inputgroup__port">
              <TextInput
                value={draft.proxyPort}
                mono
                onChange={(e) => patch('proxyPort', e.target.value)}
              />
            </div>
          </div>
        </Field>
        <Field label="代理用户名">
          <TextInput
            value={draft.proxyUsername}
            onChange={(e) => patch('proxyUsername', e.target.value)}
          />
        </Field>
        <Field label="代理密码">
          <TextInput
            type="password"
            value={draft.proxyPassword}
            autoComplete="off"
            onChange={(e) => patch('proxyPassword', e.target.value)}
          />
        </Field>
      </div>

      {/* ── 5. 其他算法 ───────────────────────── */}
      <Section>其他设置（算法偏好）</Section>
      <div className="t-grid t-grid--2 form-section-body">
        <Field label="密钥交换算法 (KEX)" hint="逗号分隔；留空使用库默认">
          <TextInput value={draft.kex} mono onChange={(e) => patch('kex', e.target.value)} />
        </Field>
        <Field label="Cipher 算法">
          <TextInput value={draft.cipher} mono onChange={(e) => patch('cipher', e.target.value)} />
        </Field>
        <Field label="主机密钥算法">
          <TextInput value={draft.hostKey} mono onChange={(e) => patch('hostKey', e.target.value)} />
        </Field>
        <Field label="MAC 算法">
          <TextInput value={draft.hmac} mono onChange={(e) => patch('hmac', e.target.value)} />
        </Field>
        <Field label="压缩算法" className="t-grid__span2">
          <TextInput value={draft.compress} mono onChange={(e) => patch('compress', e.target.value)} />
        </Field>
      </div>

      {/* ── 6. 初始化 ─────────────────────────── */}
      <Section>初始化</Section>
      <div className="form-section-body">
        <Field
          label="连接后自动执行的脚本"
          hint="会话建立后逐行发送，用于设置环境变量、切换目录等"
        >
          <TextArea
            value={draft.initScript}
            mono
            rows={5}
            placeholder={'cd /srv/app\nexport PS1="\\u@\\h:\\w$ "\\n'}
            onChange={(e) => patch('initScript', e.target.value)}
          />
        </Field>
      </div>

      {testResult ? (
        <div className="form-testresult">
          <div className={`t-banner${testResult.ok ? '' : ' t-banner--error'}`}>
            <Icon name={testResult.ok ? 'check-circle' : 'alert-circle'} size={15} />
            <div className="t-banner__body">
              {testResult.ok ? '测试通过：' : '测试失败：'}
              {testResult.text}
            </div>
          </div>
        </div>
      ) : null}

      {existing ? (
        <div className="meta-line" style={{ marginTop: 14 }}>
          <span>ID {existing.id}</span>
          <span>创建于 {new Date(existing.createdAt).toLocaleString('zh-CN')}</span>
        </div>
      ) : null}
    </Modal>
  )
}
