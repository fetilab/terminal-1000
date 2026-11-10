/**
 * IPC 契约：单一通道 + 域/动作路由。
 *
 * 设计要点
 * - 只有一条 Electron IPC 通道（`t1000`），避免通道名散落各处。
 * - 载荷统一 `{ domain, action, payload }`，主进程按 domain 分派到 handler。
 * - 入参在 handler 边界用 zod 校验；这里给出信封与各域的 schema 定义位置。
 */

import { z } from 'zod'

/** 唯一的 IPC 通道名 */
export const IPC_CHANNEL = 't1000' as const

/** IPC 域（与主进程服务边界一一对应，见 ARCHITECTURE.md §3） */
export const IPC_DOMAINS = [
  'app',
  'store',
  'credential',
  'ssh',
  'sftp',
  'forward',
  'pty',
  'telnet',
  'vnc',
  'rdp',
  'monitor',
  'notes',
  'completion',
  'ai',
  'mcp',
  'sessionlog',
  'settings',
  'sync',
  'hotkey',
  'broadcast',
  'quickcmd',
  'system',
] as const

export type IpcDomain = (typeof IPC_DOMAINS)[number]

/** 请求信封 */
export interface IpcRequest<D extends IpcDomain = IpcDomain, A extends string = string, P = unknown> {
  domain: D
  action: A
  payload: P
}

/** 成功响应 */
export interface IpcOk<T> {
  ok: true
  data: T
}

/** 失败响应：code 稳定可判，message 面向用户 */
export interface IpcErr {
  ok: false
  error: {
    code: IpcErrorCode
    message: string
    /** 可选的补充数据（如 zod 的 issues） */
    detail?: unknown
  }
}

export type IpcResponse<T> = IpcOk<T> | IpcErr

/** 稳定错误码 */
export type IpcErrorCode =
  | 'BAD_REQUEST'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_CONNECTED'
  | 'TIMEOUT'
  | 'UNSUPPORTED'
  | 'INTERNAL'

export const ipcRequestSchema = z.object({
  domain: z.enum(IPC_DOMAINS),
  action: z.string().min(1),
  payload: z.unknown(),
})

/** 构造请求（渲染侧用，保证类型收敛） */
export function ipcRequest<D extends IpcDomain, A extends string, P>(
  domain: D,
  action: A,
  payload: P,
): IpcRequest<D, A, P> {
  return { domain, action, payload }
}

/**
 * 各域动作名。集中登记以免拼写漂移；新增动作先加这里。
 */
export const Actions = {
  app: [
    'getInfo',
    'getPaths',
    'openExternal',
    'showItemInFolder',
    'quit',
    'relaunch',
    // 延迟探测：ping 单个目标；pingMany 一次探一批（列表刷新用，避免 N 次 IPC 往返）
    'ping',
    'pingMany',
    // 本机文件对话框与默认程序打开（Electron 32+ 渲染层拿不到 File.path，必须主进程做）
    'pickLocalPath',
    'openPath',
  ] as const,

  store: [
    'listConnections',
    'getConnection',
    'saveConnection',
    'deleteConnection',
    'moveConnection',
    'listGroups',
    'saveGroup',
    'deleteGroup',
    'exportBackup',
    'importBackup',
    'setMasterPassword',
    'unlock',
    'lock',
    'isUnlocked',
    'search',
    /** 解析 ~/.ssh/config 并批量导入连接（与 importBackup 是两件事） */
    'importOpenSsh',
  ] as const,

  credential: ['list', 'get', 'save', 'delete'] as const,

  ssh: [
    'connect',
    'disconnect',
    'listSessions',
    'write',
    'resize',
    'verifyHostKey',
    'respondAuth',
    'testConnection',
    'reconnect',
    'setEncoding',
  ] as const,

  sftp: [
    'list',
    'stat',
    'mkdir',
    'rename',
    'remove',
    'chmod',
    'home',
    'readFile',
    'writeFile',
    'upload',
    'download',
    'cancelTransfer',
    'listTransfers',
    'openEditor',
    // 远端目录监听（轮询实现；SFTP 协议本身无 watch 能力）
    'watch',
    'unwatch',
  ] as const,

  forward: ['open', 'close', 'list'] as const,

  pty: ['open', 'close', 'write', 'resize', 'list', 'listProfiles', 'listShells'] as const,

  telnet: ['connect', 'disconnect', 'write'] as const,

  vnc: ['connect', 'disconnect', 'sendPointer', 'sendKey'] as const,

  rdp: ['connect', 'disconnect', 'sendResize'] as const,

  monitor: ['start', 'stop', 'getSnapshot', 'listCards', 'setCards', 'refresh'] as const,

  notes: [
    'list',
    'get',
    'save',
    'delete',
    'restore',
    'purge',
    'listFolders',
    'saveFolder',
    'deleteFolder',
  ] as const,

  completion: [
    'complete',
    'settings',
    'setSettings',
    'listSpecs',
    /** 命令搜索 / 离线命令手册：查用途、安装方式、语法、参数与示例 */
    'search',
  ] as const,

  ai: ['listChats', 'getChat', 'send', 'cancel', 'deleteChat', 'listProviders', 'setProvider'] as const,

  mcp: [
    'status',
    'start',
    'stop',
    'listTools',
    'setPolicy',
    // 客户端令牌管理：明文令牌只在 createClient 返回一次，之后只有摘要
    'listClients',
    'createClient',
    'revokeClient',
  ] as const,

  sessionlog: [
    'start',
    'stop',
    'list',
    'read',
    'delete',
    /** 读回放帧（按时间区间取，不一次塞整场录制） */
    'replay',
    /** 录制设置（间隔/自动压缩/是否录制） */
    'getSettings',
    'setSettings',
  ] as const,

  settings: ['getAll', 'get', 'set', 'reset'] as const,

  sync: ['status', 'login', 'logout', 'push', 'pull', 'resolveConflict'] as const,

  broadcast: [
    /** 用一批已打开的会话建立广播组 */
    'create',
    /** 解散广播组（不影响会话本身） */
    'dissolve',
    'add',
    'remove',
    /** 切换独立 / 广播模式 */
    'setMode',
    /** 广播输入（广播模式下由渲染层把任意终端的输入发到这里） */
    'send',
    'list',
    'status',
  ] as const,

  system: [
    /** 立即锁定本地库（与自动锁屏共用事件） */
    'lockNow',
    /** 立即执行一次备份 */
    'backupNow',
    /** 列出已有备份（供恢复界面用） */
    'listBackups',
    /** 设置变更后重新应用运行期系统项（如开机自启） */
    'applyRuntime',
  ] as const,

  quickcmd: [
    'list',
    'listGroups',
    'save',
    'delete',
    'move',
    'reorder',
    'saveGroup',
    'deleteGroup',
    'previewGroupDelete',
    'search',
    'render',
    'parameterDialog',
    'execute',
    'paste',
    'analyze',
    'variables',
    'history',
    'clearHistory',
    'storage',
  ] as const,

  hotkey: [
    /** 列出全部绑定及其实时注册状态（是否被别的程序占用等） */
    'list',
    /** 重新从设置读取并注册（设置里改完快捷键后调用） */
    'reload',
    /** 只改一条绑定并立即生效 */
    'setBinding',
    /** 恢复默认快捷键 */
    'reset',
  ] as const,
} as const

export type DomainAction<D extends IpcDomain> = (typeof Actions)[D][number]
