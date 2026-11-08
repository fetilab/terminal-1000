// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 非 SSH 协议的表单（Telnet / RDP / VNC / 隧道）。
 *
 * 设计：**字段表驱动**。五种协议共用同一套表单外壳，按 kind 取不同的字段组，
 * 而不是复制五份 JSX —— 新增字段只要加一行声明，校验/回填/保存逻辑全都不用动。
 *
 * 字段严格按 `packages/shared/src/connection.ts` 的契约，不自造字段：
 * 主进程的 zod schema 是 `.passthrough()` 但 RDP 的 username / 隧道的 serverId 等
 * 都是 min(1) 必填，form 侧先校验一遍能避免"保存时才报错"。
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import type {
  Connection,
  ConnectionGroup,
  ForwardType,
  StoreType,
  TelnetConnection,
} from '@t1000/shared'
import { Button, IconButton, Section } from '../../components/Button'
import { Badge, Banner } from '../../components/Feedback'
import { Checkbox, Field, Select, Switch, TextArea, TextInput } from '../../components/Form'
import { Icon } from '../../components/Icon'
import { toast } from '../../components/Toast'
import { invoke } from '../../lib/ipc'
import { errorText } from '../../lib/format'
import {
  actions,
  getConnection,
  newConnectionId,
  saveConnection,
  useStoreShallow,
  type GroupNode,
  type UiConnection,
} from '../../lib/store'
import './connections.css'

export type ProtocolKind = 'telnet' | 'rdp' | 'vnc' | 'tunnel'

const DEFAULT_PORTS: Record<ProtocolKind, number> = { telnet: 23, rdp: 3389, vnc: 5900, tunnel: 0 }

const KIND_LABEL: Record<ProtocolKind, string> = {
  telnet: 'Telnet',
  rdp: 'RDP',
  vnc: 'VNC',
  tunnel: '隧道',
}

/* ── 字段声明 ─────────────────────────────────── */

type FieldKind = 'text' | 'password' | 'number' | 'switch' | 'select' | 'textarea'

interface FieldSpec {
  path: string
  label: string
  kind: FieldKind
  hint?: string
  required?: boolean
  placeholder?: string
  min?: number
  max?: number
  step?: number
  options?: ReadonlyArray<{ value: string; label: string }>
  /** 动态选项来源 */
  source?: 'groups' | 'sshConnections' | 'telnetTemplates'
  wide?: boolean
  /** 条件显示 */
  when?: (d: Draft) => boolean
  /** 只读展示（如从别处推导出的值） */
  readOnly?: boolean
}

interface SectionSpec {
  title: string
  fields: FieldSpec[]
}

type Draft = Record<string, unknown>

const GROUPS_FIELD: FieldSpec = {
  path: 'groupId',
  label: '分组',
  kind: 'select',
  source: 'groups',
}

function commonSections(kind: ProtocolKind): SectionSpec[] {
  return [
    {
      title: '基本信息',
      fields: [
        { path: 'name', label: '名称', kind: 'text', required: true, placeholder: '例如：core-switch-01' },
        GROUPS_FIELD,
        {
          path: 'host',
          label: '主机地址',
          kind: 'text',
          required: true,
          placeholder: '10.0.0.5 或 device.internal',
        },
        {
          path: 'port',
          label: '端口',
          kind: 'number',
          required: true,
          min: 1,
          max: 65535,
          placeholder: String(DEFAULT_PORTS[kind]),
        },
        { path: 'note', label: '备注', kind: 'textarea', wide: true },
      ],
    },
  ]
}

const SPECS: Record<ProtocolKind, SectionSpec[]> = {
  telnet: [
    ...commonSections('telnet'),
    {
      title: '登录（设备需要时再填）',
      fields: [
        {
          path: 'username',
          label: '用户名',
          kind: 'text',
          hint: '多数网络设备是连上后再交互输入，这里可留空',
        },
        { path: 'password', label: '密码', kind: 'password' },
      ],
    },
    {
      title: '连接选项',
      fields: [
        { path: 'options.timeoutMs', label: '连接超时 (ms)', kind: 'number', min: 1000, max: 600000, step: 1000 },
        {
          path: 'options.term',
          label: '终端类型 TERM',
          kind: 'text',
          hint: '对端请求 TTYPE 时回答的值',
          placeholder: 'xterm-256color',
        },
        { path: 'options.cols', label: '初始列数', kind: 'number', min: 20, max: 500 },
        { path: 'options.rows', label: '初始行数', kind: 'number', min: 5, max: 300 },
      ],
    },
  ],

  rdp: [
    ...commonSections('rdp'),
    {
      title: '登录',
      fields: [
        { path: 'username', label: '用户名', kind: 'text', required: true },
        { path: 'password', label: '密码', kind: 'password', hint: '留空则连接时再问' },
        { path: 'domain', label: '域 / WORKGROUP', kind: 'text', placeholder: 'AD 域或 WORKGROUP' },
      ],
    },
    {
      title: '显示',
      fields: [
        {
          path: 'displayMode',
          label: '显示模式',
          kind: 'select',
          options: [
            { value: 'follow-window', label: '跟随窗口' },
            { value: 'fixed-resolution', label: '固定分辨率' },
          ],
        },
        {
          path: 'width',
          label: '宽度 (px)',
          kind: 'number',
          min: 320,
          max: 8192,
          when: (d) => d.displayMode === 'fixed-resolution',
        },
        {
          path: 'height',
          label: '高度 (px)',
          kind: 'number',
          min: 240,
          max: 8192,
          when: (d) => d.displayMode === 'fixed-resolution',
        },
        {
          path: 'quality',
          label: '画质',
          kind: 'select',
          options: [
            { value: 'low', label: '低（省带宽）' },
            { value: 'balanced', label: '均衡' },
            { value: 'high', label: '高' },
          ],
        },
        { path: 'clipboardShare', label: '共享剪贴板（文本）', kind: 'switch' },
      ],
    },
  ],

  vnc: [
    ...commonSections('vnc'),
    {
      title: '认证',
      fields: [
        {
          path: 'authType',
          label: '认证方式',
          kind: 'select',
          options: [
            { value: 'vnc-password', label: 'VNC 密码' },
            { value: 'none', label: '无认证' },
          ],
        },
        {
          path: 'password',
          label: '密码',
          kind: 'password',
          when: (d) => d.authType !== 'none',
        },
      ],
    },
    {
      title: '会话行为',
      fields: [
        {
          path: 'viewOnly',
          label: '只读（只看画面，不回送键鼠）',
          kind: 'switch',
          hint: '开启后本机不会向远端发送任何键鼠事件 —— 适合旁观排障',
        },
        { path: 'shared', label: '允许多客户端共享同一会话', kind: 'switch' },
        { path: 'scaleViewport', label: '缩放视口', kind: 'switch' },
        { path: 'clipViewport', label: '裁剪视口', kind: 'switch' },
      ],
    },
    {
      title: '画质',
      fields: [
        {
          path: 'qualityLevel',
          label: '清晰度 0–9',
          kind: 'number',
          min: 0,
          max: 9,
          hint: '推荐 6；越大越清晰、越费带宽',
        },
        {
          path: 'compressionLevel',
          label: '压缩强度 0–9',
          kind: 'number',
          min: 0,
          max: 9,
          hint: '推荐 2；越大越省带宽、越吃 CPU',
        },
      ],
    },
  ],

  tunnel: [
    {
      title: '基本信息',
      fields: [
        { path: 'name', label: '名称', kind: 'text', required: true, placeholder: '例如：grafana-3000' },
        GROUPS_FIELD,
        {
          path: 'serverId',
          label: '承载的 SSH 服务器',
          kind: 'select',
          required: true,
          source: 'sshConnections',
          hint: '隧道通过这台已配置的服务器转发；没有可选服务器时请先建一条 SSH 连接',
        },
        {
          path: 'type',
          label: '转发类型',
          kind: 'select',
          options: [
            { value: 'local', label: '本地转发（-L）：本机端口 → 远端可达的目标' },
            { value: 'remote', label: '远程转发（-R）：远端端口 → 本机可达的目标' },
            { value: 'dynamic', label: '动态代理（-D，SOCKS5）' },
          ],
        },
      ],
    },
    {
      title: '监听与目标',
      fields: [
        { path: 'localHost', label: '本地监听地址', kind: 'text', placeholder: '127.0.0.1' },
        { path: 'localPort', label: '本地监听端口', kind: 'number', required: true, min: 1, max: 65535 },
        {
          path: 'remoteHost',
          label: '远端主机',
          kind: 'text',
          placeholder: '127.0.0.1',
          when: (d) => d.type !== 'dynamic',
        },
        {
          path: 'remotePort',
          label: '远端端口',
          kind: 'number',
          min: 1,
          max: 65535,
          when: (d) => d.type !== 'dynamic',
        },
      ],
    },
    {
      title: '其他',
      fields: [
        { path: 'autoReconnect', label: '断开后自动重连', kind: 'switch' },
        { path: 'note', label: '备注', kind: 'textarea', wide: true },
      ],
    },
  ],
}

/* ── 取值/赋值 ────────────────────────────────── */

function readPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj
  for (const part of path.split('.')) {
    if (typeof cur !== 'object' || cur === null) return undefined
    cur = (cur as Record<string, unknown>)[part]
  }
  return cur
}

function assignPath(obj: Draft, path: string, value: unknown): void {
  const parts = path.split('.')
  let cur: Record<string, unknown> = obj
  for (let i = 0; i < parts.length - 1; i += 1) {
    const key = parts[i] ?? ''
    if (typeof cur[key] !== 'object' || cur[key] === null) cur[key] = {}
    cur = cur[key] as Record<string, unknown>
  }
  cur[parts[parts.length - 1] ?? ''] = value
}

function draftFrom(kind: ProtocolKind, existing: UiConnection | undefined): Draft {
  const d: Draft = {}
  if (!existing) {
    assignPath(d, 'name', '')
    assignPath(d, 'groupId', '')
    assignPath(d, 'host', '')
    assignPath(d, 'port', DEFAULT_PORTS[kind])
    assignPath(d, 'note', '')
    if (kind === 'telnet') {
      assignPath(d, 'username', '')
      assignPath(d, 'password', '')
      assignPath(d, 'options.timeoutMs', 20000)
      assignPath(d, 'options.term', '')
      assignPath(d, 'options.cols', 80)
      assignPath(d, 'options.rows', 24)
    }
    if (kind === 'rdp') {
      assignPath(d, 'username', '')
      assignPath(d, 'displayMode', 'follow-window')
      assignPath(d, 'width', 1920)
      assignPath(d, 'height', 1080)
      assignPath(d, 'quality', 'balanced')
      assignPath(d, 'clipboardShare', true)
    }
    if (kind === 'vnc') {
      assignPath(d, 'authType', 'vnc-password')
      assignPath(d, 'scaleViewport', true)
      assignPath(d, 'qualityLevel', 6)
      assignPath(d, 'compressionLevel', 2)
    }
    if (kind === 'tunnel') {
      assignPath(d, 'type', 'local')
      assignPath(d, 'localHost', '127.0.0.1')
      // 端口留空而不是预填 0：0 是无效端口，预填会让人以为"已经填好了"，
      // 提交时才被校验拦下 —— 空值 + 必需校验的提示更直接
      assignPath(d, 'localPort', '')
      assignPath(d, 'remoteHost', '127.0.0.1')
      assignPath(d, 'remotePort', '')
      assignPath(d, 'autoReconnect', true)
    }
    return d
  }

  const conn = existing as unknown as Record<string, unknown>
  d.name = conn.name
  d.groupId = conn.groupId ?? ''
  d.host = conn.host
  d.port = conn.port
  d.note = conn.note ?? ''
  if (kind === 'telnet') {
    const c = existing as TelnetConnection
    d.username = c.username ?? ''
    d.password = c.password ?? ''
    d['options.timeoutMs'] = c.options?.timeoutMs ?? 20000
    d['options.term'] = c.options?.term ?? ''
    d['options.cols'] = c.options?.cols ?? 80
    d['options.rows'] = c.options?.rows ?? 24
  }
  if (kind === 'rdp') {
    d.username = conn.username ?? ''
    d.password = conn.password ?? ''
    d.domain = conn.domain ?? ''
    d.displayMode = conn.displayMode ?? 'follow-window'
    d.width = conn.width ?? 1920
    d.height = conn.height ?? 1080
    d.quality = conn.quality ?? 'balanced'
    d.clipboardShare = conn.clipboardShare ?? true
  }
  if (kind === 'vnc') {
    d.authType = conn.authType ?? 'vnc-password'
    d.password = conn.password ?? ''
    d.viewOnly = conn.viewOnly ?? false
    d.shared = conn.shared ?? false
    d.scaleViewport = conn.scaleViewport ?? true
    d.clipViewport = conn.clipViewport ?? false
    d.qualityLevel = conn.qualityLevel ?? 6
    d.compressionLevel = conn.compressionLevel ?? 2
  }
  if (kind === 'tunnel') {
    d.serverId = conn.serverId ?? ''
    d.type = conn.type ?? 'local'
    d.localHost = conn.localHost ?? '127.0.0.1'
    d.localPort = conn.localPort ?? 0
    d.remoteHost = conn.remoteHost ?? '127.0.0.1'
    d.remotePort = conn.remotePort ?? 0
    d.autoReconnect = conn.autoReconnect ?? true
  }
  return d
}

const num = (v: unknown): number | undefined => {
  if (v === '' || v === undefined || v === null) return undefined
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}

/* ── 组件 ─────────────────────────────────────── */

export interface ProtocolFormProps {
  kind: ProtocolKind
  /** 编辑态传入；新建时 undefined */
  existingId?: string
}

export default function ProtocolForm({ kind, existingId }: ProtocolFormProps): React.JSX.Element {
  const existing = existingId ? getConnection(existingId) : undefined
  const [draft, setDraft] = useState<Draft>(() => draftFrom(kind, existing))
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [templates, setTemplates] = useState<Array<{ id: string; name: string; description: string; rules: Array<{ from: string; to: string }> }>>([])
  const [rules, setRules] = useState<Array<{ from: string; to: string }>>(
    () => (existing as TelnetConnection | undefined)?.keyMapping?.rules ?? [],
  )
  const [keyMappingEnabled, setKeyMappingEnabled] = useState<boolean>(
    () => (existing as TelnetConnection | undefined)?.keyMapping?.enabled ?? false,
  )
  const [templateId, setTemplateId] = useState<string>(
    () => (existing as TelnetConnection | undefined)?.keyMapping?.template ?? 'standard',
  )

  const { groups, connections } = useStoreShallow((s) => ({
    groups: s.groups,
    connections: s.connections,
  }))

  // Telnet 按键映射模板从主进程取，不在前端硬编码一份（否则两边迟早不一致）
  useEffect(() => {
    if (kind !== 'telnet') return
    void (async () => {
      try {
        const res = await invoke<
          'telnet',
          'list',
          Record<string, never>,
          { templates: Array<{ id: string; name: string; description: string; rules: Array<{ from: string; to: string }> }> }
        >('telnet', 'list', {})
        setTemplates(res?.templates ?? [])
      } catch {
        setTemplates([])
      }
    })()
  }, [kind])

  const set = useCallback((path: string, value: unknown) => {
    setDraft((d) => {
      const next = { ...d }
      assignPath(next, path, value)
      return next
    })
    setErrors((e) => {
      if (!e[path]) return e
      const next = { ...e }
      delete next[path]
      return next
    })
  }, [])

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

  const sshConnections = useMemo(
    () => connections.filter((c) => c.kind === 'ssh').map((c) => ({ value: c.id, label: `${c.name} (${c.host})` })),
    [connections],
  )

  const optionsFor = (f: FieldSpec): ReadonlyArray<{ value: string; label: string }> => {
    if (f.options) return f.options
    if (f.source === 'groups') return [{ value: '', label: '（未分组）' }, ...flatGroups]
    if (f.source === 'sshConnections')
      return [{ value: '', label: sshConnections.length ? '（选择服务器）' : '（没有可用的 SSH 连接）' }, ...sshConnections]
    return []
  }

  const applyTemplate = (id: string): void => {
    setTemplateId(id)
    const tpl = templates.find((t) => t.id === id)
    // 模板自带 rules（空数组 = 不做转换）；用户随后可继续微调
    setRules(tpl ? tpl.rules.map((r) => ({ ...r })) : [])
  }

  const validate = (): boolean => {
    const next: Record<string, string> = {}
    if (!String(draft.name ?? '').trim()) next.name = '名称不能为空'

    if (kind !== 'tunnel') {
      if (!String(draft.host ?? '').trim()) next.host = '主机地址不能为空'
      const port = num(draft.port)
      if (port === undefined || port < 1 || port > 65535) next.port = '端口需在 1–65535 之间'
    }

    if (kind === 'rdp' && !String(draft.username ?? '').trim()) next.username = 'RDP 需要用户名'

    if (kind === 'rdp' && draft.displayMode === 'fixed-resolution') {
      const w = num(draft.width)
      const h = num(draft.height)
      if (w === undefined || w < 320 || w > 8192) next.width = '宽度需在 320–8192 之间'
      if (h === undefined || h < 240 || h > 8192) next.height = '高度需在 240–8192 之间'
    }

    if (kind === 'tunnel') {
      if (!String(draft.serverId ?? '').trim()) next.serverId = '必须选择承载的 SSH 服务器'
      const lp = num(draft.localPort)
      if (lp === undefined || lp < 1 || lp > 65535) next.localPort = '本地端口需在 1–65535 之间'
      if (draft.type !== 'dynamic') {
        const rp = num(draft.remotePort)
        if (rp === undefined || rp < 1 || rp > 65535) next.remotePort = '远端端口需在 1–65535 之间'
        if (!String(draft.remoteHost ?? '').trim()) next.remoteHost = '远端主机不能为空'
      }
    }

    if (kind === 'vnc') {
      for (const key of ['qualityLevel', 'compressionLevel']) {
        const v = num(draft[key])
        if (v !== undefined && (v < 0 || v > 9)) next[key] = '取值范围 0–9'
      }
    }

    setErrors(next)
    return Object.keys(next).length === 0
  }

  const build = (): Connection => {
    const now = new Date().toISOString()
    const id = existing?.id ?? newConnectionId()
    const base = {
      id,
      name: String(draft.name ?? '').trim(),
      ...(String(draft.groupId ?? '') ? { groupId: String(draft.groupId) } : {}),
      note: String(draft.note ?? '') || undefined,
      storeType: 'local' as StoreType,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    }
    /**
     * 去掉值为 undefined 的键：契约类型里可选字段是 `?: T` 而不是 `| undefined`，
     * 直接塞 undefined 会让落盘 JSON 里出现 `"password": null` 之类的脏数据。
     * 约束用 `object`（不是 Record）—— 领域类型没有索引签名，用 Record 会被拒。
     */
    const omitUndefined = <T extends object>(o: T): T => {
      const bag = o as Record<string, unknown>
      for (const k of Object.keys(bag)) if (bag[k] === undefined) delete bag[k]
      return o
    }

    if (kind === 'telnet') {
      const conn: TelnetConnection = omitUndefined({
        ...base,
        kind: 'telnet' as const,
        host: String(draft.host ?? '').trim(),
        port: num(draft.port) ?? 23,
        username: String(draft.username ?? '') || undefined,
        password: String(draft.password ?? '') || undefined,
        options: {
          timeoutMs: num(draft['options.timeoutMs']),
          term: String(draft['options.term'] ?? '') || undefined,
          cols: num(draft['options.cols']),
          rows: num(draft['options.rows']),
        },
        keyMapping: {
          enabled: keyMappingEnabled,
          template: templateId,
          ...(rules.length > 0 ? { rules } : {}),
        },
      } as unknown as TelnetConnection)
      return conn
    }

    if (kind === 'rdp') {
      return omitUndefined({
        ...base,
        kind: 'rdp' as const,
        host: String(draft.host ?? '').trim(),
        port: num(draft.port) ?? 3389,
        username: String(draft.username ?? '').trim(),
        password: String(draft.password ?? '') || undefined,
        domain: String(draft.domain ?? '') || undefined,
        displayMode: (draft.displayMode as 'follow-window' | 'fixed-resolution') ?? 'follow-window',
        ...(draft.displayMode === 'fixed-resolution'
          ? { width: num(draft.width), height: num(draft.height) }
          : {}),
        quality: (draft.quality as 'low' | 'balanced' | 'high') ?? 'balanced',
        clipboardShare: draft.clipboardShare === true,
      }) as unknown as Connection
    }

    if (kind === 'vnc') {
      return omitUndefined({
        ...base,
        kind: 'vnc' as const,
        host: String(draft.host ?? '').trim(),
        port: num(draft.port) ?? 5900,
        authType: (draft.authType as 'vnc-password' | 'none') ?? 'vnc-password',
        password: String(draft.password ?? '') || undefined,
        viewOnly: draft.viewOnly === true,
        shared: draft.shared === true,
        scaleViewport: draft.scaleViewport === true,
        clipViewport: draft.clipViewport === true,
        qualityLevel: num(draft.qualityLevel) ?? 6,
        compressionLevel: num(draft.compressionLevel) ?? 2,
      }) as unknown as Connection
    }

    /**
     * ⚠️ 隧道要额外带 `host` / `port`。
     *
     * `TunnelConnection` 契约里**没有** host/port（它用 localHost/localPort/
     * remoteHost/remotePort），但 store 域的 `connectionInputSchema` 是**通用**的：
     * 它对所有 kind 都要求 `host: min(1)` 与 `port: 1..65535`，
     * 所以不带这两个字段会被 zod 拒掉（实测报 `host: Required; port: Required`）。
     *
     * 这里用「本地监听地址/端口」镜像一份，纯粹为了过 store 的通用校验；
     * 读取路径（connectionAddress / connectionHost）对 tunnel 走的是 localHost/remoteHost，
     * 不会用到这两个镜像值。**这属于主进程 schema 需要按 kind 分化的问题**，已反馈，
     * 修好后应删掉这两行。
     */
    const tunnelMirror = {
      host: String(draft.localHost ?? '127.0.0.1').trim() || '127.0.0.1',
      port: num(draft.localPort) ?? 1,
    }

    return omitUndefined({
      ...base,
      ...tunnelMirror,
      kind: 'tunnel' as const,
      serverId: String(draft.serverId ?? '').trim(),
      type: (draft.type as ForwardType) ?? 'local',
      localHost: String(draft.localHost ?? '127.0.0.1').trim(),
      localPort: num(draft.localPort) ?? 0,
      remoteHost: String(draft.remoteHost ?? '').trim(),
      remotePort: num(draft.remotePort) ?? 0,
      autoReconnect: draft.autoReconnect === true,
    }) as unknown as Connection
  }

  const submit = async (): Promise<void> => {
    if (!validate()) {
      toast.warn('还有字段没填对，已标红')
      return
    }
    setSaving(true)
    const ok = await saveConnection(build() as UiConnection)
    setSaving(false)
    if (ok) toast.ok(existing ? `已保存「${String(draft.name)}」` : `已创建「${String(draft.name)}」`)
  }

  const sections = SPECS[kind]

  return (
    <div>
      {kind === 'rdp' ? (
        <div style={{ marginBottom: 14 }}>
          <Banner tone="warn">
            RDP 通过**外部 xfreerdp 进程**打开，画面在**独立窗口**中显示，不会嵌在标签页里。
            若本机缺少 FreeRDP，连接时会返回 UNSUPPORTED 并在提示里附带安装命令。
          </Banner>
        </div>
      ) : null}

      {kind === 'tunnel' && sshConnections.length === 0 ? (
        <div style={{ marginBottom: 14 }}>
          <Banner tone="warn">
            还没有 SSH 连接可作为隧道载体。隧道必须依附一条 SSH 服务器，请先创建 SSH 连接。
          </Banner>
        </div>
      ) : null}

      {sections.map((section) => (
        <div key={section.title}>
          <Section>{section.title}</Section>
          <div className="t-grid t-grid--2 form-section-body">
            {section.fields
              .filter((f) => !f.when || f.when(draft))
              .map((f) => {
                const value = readPath(draft, f.path)
                const err = errors[f.path]
                if (f.kind === 'switch') {
                  return (
                    <div className="settings-switch-row" key={f.path}>
                      <Switch
                        checked={value === true}
                        onChange={(v) => set(f.path, v)}
                        label={f.label}
                      />
                      {f.hint ? <div className="t-field__hint">{f.hint}</div> : null}
                    </div>
                  )
                }
                if (f.kind === 'textarea') {
                  return (
                    <Field key={f.path} label={f.label} hint={f.hint} error={err} className={f.wide ? 't-grid__span2' : undefined}>
                      <TextArea value={String(value ?? '')} rows={2} onChange={(e) => set(f.path, e.target.value)} />
                    </Field>
                  )
                }
                return (
                  <Field key={f.path} label={f.label} hint={f.hint} error={err} className={f.wide ? 't-grid__span2' : undefined}>
                    {f.kind === 'select' ? (
                      <Select
                        value={String(value ?? '')}
                        options={optionsFor(f)}
                        onChange={(e) => set(f.path, e.target.value)}
                        invalid={Boolean(err)}
                      />
                    ) : (
                      <TextInput
                        type={f.kind === 'password' ? 'password' : f.kind === 'number' ? 'number' : 'text'}
                        value={value === undefined || value === null ? '' : String(value)}
                        mono={f.kind === 'number' || f.path === 'host'}
                        placeholder={f.placeholder}
                        invalid={Boolean(err)}
                        autoComplete={f.kind === 'password' ? 'off' : undefined}
                        onChange={(e) => set(f.path, f.kind === 'number' ? e.target.value : e.target.value)}
                      />
                    )}
                  </Field>
                )
              })}
          </div>
        </div>
      ))}

      {/* Telnet 按键映射：模板来自主进程，rules 可继续微调 */}
      {kind === 'telnet' ? (
        <>
          <Section right={templates.length > 0 ? <Badge>{templates.length} 个模板</Badge> : undefined}>
            按键映射
          </Section>
          <div className="form-section-body" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <Switch
              checked={keyMappingEnabled}
              onChange={setKeyMappingEnabled}
              label="启用按键映射（网络设备键位适配）"
            />
            {keyMappingEnabled ? (
              <>
                <Field
                  label="预设模板"
                  hint="模板由主进程提供，选中后会把模板规则填入下方，可继续修改"
                >
                  <Select
                    value={templateId}
                    options={
                      templates.length === 0
                        ? [{ value: 'standard', label: '标准模式' }]
                        : templates.map((t) => ({ value: t.id, label: `${t.name} —— ${t.description}` }))
                    }
                    onChange={(e) => applyTemplate(e.target.value)}
                  />
                </Field>

                <div className="keymap-list">
                  {rules.length === 0 ? (
                    <div className="t-field__hint">当前模板不做任何转换（原始按键直通）。</div>
                  ) : (
                    rules.map((r, i) => (
                      <div className="keymap-row" key={`${r.from}-${i}`}>
                        <TextInput
                          className="keymap-row__from"
                          value={r.from}
                          mono
                          aria-label="源按键"
                          onChange={(e) =>
                            setRules(rules.map((x, j) => (j === i ? { ...x, from: e.target.value } : x)))
                          }
                        />
                        <Icon name="chevron-right" size={12} />
                        <TextInput
                          className="keymap-row__to"
                          value={r.to}
                          mono
                          aria-label="发送的字节"
                          onChange={(e) =>
                            setRules(rules.map((x, j) => (j === i ? { ...x, to: e.target.value } : x)))
                          }
                        />
                        <IconButton
                          icon="trash"
                          label="删除该条映射"
                          size={12}
                          tone="danger"
                          onClick={() => setRules(rules.filter((_, j) => j !== i))}
                        />
                      </div>
                    ))
                  )}
                  <div>
                    <Button
                      size="sm"
                      variant="outline"
                      icon="plus"
                      onClick={() => setRules([...rules, { from: '', to: '' }])}
                    >
                      新增映射
                    </Button>
                  </div>
                </div>

                <p className="t-field__hint" style={{ margin: 0 }}>
                  右侧「发送的字节」支持转义序列：<code className="mono">\r</code>、
                  <code className="mono">\n</code>、<code className="mono">\t</code>、
                  <code className="mono">\e</code>、<code className="mono">\xHH</code>。
                  例如退格发 DEL 写 <code className="mono">\x7f</code>，
                  方向键上写 <code className="mono">\x1bOA</code>。
                </p>
              </>
            ) : null}
          </div>
        </>
      ) : null}

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 22 }}>
        <span className="form-footer-hint">
          协议 <b>{KIND_LABEL[kind]}</b>
          {existing ? ' · 编辑已有连接' : ' · 新建'}
        </span>
        <div style={{ flex: 1 }} />
        <Button variant="ghost" onClick={() => actions.closeEditor()}>
          取消
        </Button>
        <Button variant="primary" loading={saving} onClick={() => void submit()}>
          {existing ? '保存' : '创建'}
        </Button>
      </div>
    </div>
  )
}
