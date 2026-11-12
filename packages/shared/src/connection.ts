/**
 * 连接领域模型。
 *
 * 字段集来自对目标产品的实测（见 spec/connection-layer.md），但**命名自研**，
 * 且类型定义按我们自己的设计收敛——不与原产品的内部结构保持字节级一致。
 */

/** 连接协议种类 */
export type ConnectionKind = 'ssh' | 'rdp' | 'telnet' | 'tunnel' | 'vnc'

/** SSH 认证方式。实测原产品有 5 态，含引用式 identity。 */
export type SshAuthType =
  | 'password'
  | 'privateKey'
  /** 引用已存凭证，不内联密钥 */
  | 'identity'
  /** keyboard-interactive（含 2FA 交互） */
  | 'keyboardInteractive'
  /** 兼容旧命名的裸 keyboard */
  | 'keyboard'

export const SSH_AUTH_TYPES: readonly SshAuthType[] = [
  'password',
  'privateKey',
  'identity',
  'keyboardInteractive',
  'keyboard',
] as const

/** 认证尝试顺序（原产品可拖拽「认证顺序」） */
export interface AuthOrder {
  /** 优先尝试的方式，按顺序 */
  order: SshAuthType[]
}

/** 终端显示编码（乱码时可调） */
export type TerminalEncoding = 'utf-8' | 'gbk' | 'gb18030' | 'big5' | 'latin1' | 'euc-jp' | 'shift_jis'

/** 隧道 / 端口转发类型 */
export type ForwardType = 'local' | 'remote' | 'dynamic'

/** 代理类型（支持 socks4/5 与 http(s)） */
export type ProxyProtocol = 'socks5' | 'socks4' | 'http' | 'https'

export interface ProxyConfig {
  /** 形如 socks5://127.0.0.1:1080 */
  url: string
  protocol?: ProxyProtocol
  host?: string
  port?: number
  username?: string
  password?: string
}

/** SSH 算法偏好（留空 = 用库默认） */
export interface SshAlgorithms {
  kex?: string[]
  cipher?: string[]
  hostKey?: string[]
  hmac?: string[]
  compress?: string[]
}

/** keepalive 三层：传输层 / shell 层 / 转发层 */
export interface KeepaliveConfig {
  /** SSH 传输层心跳（ms），默认 5000 */
  transportIntervalMs?: number
  /** shell 层保活：往会话里发字符 */
  shell?: {
    text?: string
    intervalMs?: number
  }
  /** 转发层独立退避重连 */
  forwardBackoff?: {
    baseMs?: number
    maxMs?: number
    attempts?: number
  }
}

/** 通用连接选项 */
export interface ConnectOptions {
  /** 连接超时（ms） */
  timeoutMs?: number
  /** keepalive 配置 */
  keepalive?: KeepaliveConfig
  /** 算法偏好 */
  algorithms?: SshAlgorithms
  /** 终端 TERM 类型，空 = xterm-256color */
  term?: string
  /** COLORTERM，如 truecolor */
  colorTerm?: string
  /** 终端显示编码 */
  encoding?: TerminalEncoding
  /** 要监控的目录（变化事件） */
  watchDirs?: string[]
  /** X11 转发 */
  x11?: {
    enabled: boolean
    /** cookie 模式 */
    cookieMode?: string
  }
  /** 禁用代理（优先级最高，直接直连） */
  disableProxy?: boolean
  /** 关闭左侧目录与 pwd 联动（某些跳板机会因 pwd 断连） */
  disablePwdSync?: boolean
  /** 关闭列表监控 */
  disableListing?: boolean
}

/** SSH 连接定义 */
export interface SshConnection {
  kind: 'ssh'
  id: string
  name: string
  groupId?: string
  host: string
  port: number
  username: string
  authType: SshAuthType
  /** authType=password */
  password?: string
  /** authType=privateKey（PEM/OpenSSH 文本） */
  privateKey?: string
  /** 私钥口令 */
  passphrase?: string
  /** authType=identity：引用凭证库中的条目 */
  identityId?: string
  /** 认证顺序 */
  authOrder?: SshAuthType[]
  note?: string
  /** 跳板机链路，按顺序连接，第一项最先连（上限 20） */
  jumpChain?: JumpHop[]
  /** 代理（优先于跳板链生效） */
  proxy?: ProxyConfig
  options?: ConnectOptions
  /** 连接建立后执行的初始化脚本 */
  initScript?: string
  /** 存储位置 */
  storeType?: StoreType
  createdAt: string
  updatedAt: string
}

/** 跳板机一跳 */
export interface JumpHop {
  id: string
  name?: string
  host: string
  port: number
  username: string
  authType: SshAuthType
  privateKey?: string
  passphrase?: string
  password?: string
  identityId?: string
  /** 是否校验该跳板的主机指纹 */
  verifyHostKey?: boolean
}

/** RDP 连接 */
export interface RdpConnection {
  kind: 'rdp'
  id: string
  name: string
  groupId?: string
  host: string
  port: number
  username: string
  password?: string
  /** AD 域 / WORKGROUP */
  domain?: string
  note?: string
  /** 显示模式 */
  displayMode?: 'follow-window' | 'fixed-resolution'
  /** 固定分辨率（displayMode=fixed-resolution 时） */
  width?: number
  height?: number
  /** 画质：low | balanced | high */
  quality?: 'low' | 'balanced' | 'high'
  /** 剪贴板共享（文本） */
  clipboardShare?: boolean
  storeType?: StoreType
  createdAt: string
  updatedAt: string
}

/** Telnet 连接 */
export interface TelnetConnection {
  kind: 'telnet'
  id: string
  name: string
  groupId?: string
  host: string
  port: number
  username?: string
  password?: string
  note?: string
  /** 连接选项 */
  options?: {
    /** 连接超时（ms），默认 20000 */
    timeoutMs?: number
    /** 上报的终端类型（对端请求 TTYPE 时回答），默认 xterm-256color */
    term?: string
    /** 初始列数，默认 80 */
    cols?: number
    /** 初始行数，默认 24 */
    rows?: number
  }
  /** 按键映射（网络设备键位适配） */
  keyMapping?: {
    enabled: boolean
    /** 预设模板 id，如 'standard' */
    template?: string
    /** 自定义映射：源键 → 实际发送字节（支持转义序列） */
    rules?: Array<{ from: string; to: string }>
  }
  storeType?: StoreType
  createdAt: string
  updatedAt: string
}

/** 隧道 / 端口转发连接 */
export interface TunnelConnection {
  kind: 'tunnel'
  id: string
  name: string
  groupId?: string
  /** 承载这条隧道的 SSH 服务器 id */
  serverId: string
  type: ForwardType
  /** 本机监听 */
  localHost: string
  localPort: number
  /** 远端目标（local 转发时为目标；remote 转发时为远端监听） */
  remoteHost: string
  remotePort: number
  /** 意外断开后自动重连（仅本条隧道生效） */
  autoReconnect: boolean
  note?: string
  storeType?: StoreType
  createdAt: string
  updatedAt: string
}

/** VNC 连接 */
export interface VncConnection {
  kind: 'vnc'
  id: string
  name: string
  groupId?: string
  host: string
  port: number
  /** 认证方式 */
  authType?: 'vnc-password' | 'none'
  password?: string
  note?: string
  /** 只读：只看画面，不回送键鼠 */
  viewOnly?: boolean
  /** 允许多客户端共享同一会话 */
  shared?: boolean
  /** 缩放视口（窗口变化时自动缩放） */
  scaleViewport?: boolean
  /** 裁剪视口（窗口小于远端分辨率时裁剪） */
  clipViewport?: boolean
  /** 画面清晰度 0..9，推荐 6 */
  qualityLevel?: number
  /** 压缩强度 0..9，推荐 2 */
  compressionLevel?: number
  storeType?: StoreType
  createdAt: string
  updatedAt: string
}

/** 任意连接 */
export type Connection = SshConnection | RdpConnection | TelnetConnection | TunnelConnection | VncConnection

/** 存储位置：本地库 / 云端仓库 */
export type StoreType = 'local' | 'cloud'

/** 分组（支持多级） */
export interface ConnectionGroup {
  id: string
  name: string
  parentId?: string
  kind: ConnectionKind | 'mixed'
  sortOrder: number
  storeType?: StoreType
  createdAt: string
  updatedAt: string
}

/**
 * 分组树节点（含子节点与直属连接数）。
 *
 * 放在 shared 而非主进程内部：渲染层要递归渲染分组树，需要这个类型。
 * 主进程 `buildGroupTree()` 直接返回它，双方共用一份定义，避免各写一遍。
 */
export interface GroupTreeNode extends ConnectionGroup {
  children: GroupTreeNode[]
  /** 直属该分组（不含子分组）的连接数 */
  connectionCount: number
}

/** 登录凭证（可被 SSH 连接以 identity 方式引用） */
export interface Credential {
  id: string
  name: string
  username?: string
  password?: string
  privateKey?: string
  passphrase?: string
  note?: string
  createdAt: string
  updatedAt: string
}

/** 运行期连接状态 */
export type ConnectionState =
  | 'idle'
  | 'connecting'
  | 'authenticating'
  | 'verifying-host-key'
  | 'ready'
  | 'disconnected'
  | 'failed'

/** 已建立的会话句柄信息 */
export interface SessionInfo {
  sessionId: string
  connectionId: string
  kind: ConnectionKind
  state: ConnectionState
  /** 建立时间 */
  startedAt: string
  /** 远端信息（连接成功后回填） */
  remote?: {
    host?: string
    distro?: string
    release?: string
    kernel?: string
    timezone?: string
    uptimeSeconds?: number
  }
}

// ---------------------------------------------------------------------------
// 工作区布局（spec：分屏布局自动保存、按连接独立、可存为模板）
// ---------------------------------------------------------------------------

/** 布局里记录的一个标签页（只记"打开过什么"，**不表示要自动重连**） */
export interface LayoutTab {
  connectionId: string
  title?: string
}

/**
 * 分屏树。
 *
 * 用树而不是"几个格子"：嵌套分屏才表达得下（左右分屏里再上下分），
 * 而且 `ratio` 能保留用户拖出来的比例。
 */
export type LayoutSplitNode =
  | { kind: 'leaf'; /** 指向 layout.tabs 的下标 */ tabIndex: number }
  | {
      kind: 'split'
      direction: 'horizontal' | 'vertical'
      /** 第一块占的比例（0~1） */
      ratio: number
      first: LayoutSplitNode
      second: LayoutSplitNode
    }

export interface WorkspaceLayout {
  id: string
  /** 绑定到哪个连接；模板不绑定（undefined） */
  connectionId?: string
  /** 模板名（isTemplate 时有意义） */
  name?: string
  isTemplate: boolean
  tabs: LayoutTab[]
  /** 分屏树；null/undefined 表示单屏 */
  split?: LayoutSplitNode | null
  /** 侧边面板开合状态 */
  panels?: { left?: boolean; right?: boolean; bottom?: boolean }
  createdAt: string
  updatedAt: string
}
