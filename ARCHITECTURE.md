# terminal-1000 架构

> 一个自主实现的终端与远程连接管理器：代码、文案、图标与插画全部原创，
> 不包含也不链接任何第三方专有软件的代码、二进制或美术资源。
> 本文只讲工程结构与模块边界。

## 1. 技术栈（已定）

| 层 | 选型 |
|---|---|
| 壳 | Electron 最新稳定版 |
| 构建 | `electron-vite`（同时管 main / preload / renderer 三个 target） |
| 语言 | TypeScript（strict） |
| UI | React 18 + Vite |
| 包管理 | pnpm workspace（monorepo） |
| 终端 | `@xterm/xterm` + addon fit / search / web-links |
| SSH/SFTP | `ssh2`（上游开源版）+ `socks` |
| 本地 PTY | `node-pty` |
| DB | `better-sqlite3` |
| 加密 | `argon2`（主密码派生）+ AES-256-GCM（node:crypto） |
| 编辑器 | `monaco-editor` |
| 校验 | `zod`（IPC 边界 + 配置解析） |

> 原生模块（node-pty / better-sqlite3 / argon2）需 `electron-rebuild`。

## 2. 目录结构

以下是**上传到仓库的源码目录**（构建产物 `out/`、`release/` 与依赖 `node_modules/` 不入库）：

```
terminal-1000/
├── package.json                 # workspace root + 顶层脚本
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── README.md / ARCHITECTURE.md / SECURITY.md / CONTRIBUTING.md
├── CHANGELOG.md / CODE_OF_CONDUCT.md / HANDOFF.md
├── packages/
│   └── shared/                  # ★ 全局契约：类型 / IPC 通道 / 常量 / zod schema
│       └── src/                 # connection、sftp、monitor、settings、kitty、mcp…
├── apps/
│   └── desktop/                 # Electron 应用（唯一可执行产物）
│       ├── electron.vite.config.ts   # main / preload / renderer 三段构建
│       ├── electron-builder.yml      # 六格式打包配置
│       ├── tsconfig.{node,web}.json
│       ├── build/               # 打包资源：图标、desktop 文件、flatpak/pacman 元数据
│       ├── resources/           # 运行期随包资源
│       ├── vendor/              # 内置第三方运行时（kitty-vt-wasm）
│       ├── agent/               # 远端监控采集器（Go，独立编译）
│       ├── scripts/             # 应用级构建/验收脚本
│       ├── test-fixtures/       # 测试夹具（SSH/VNC 等协议样本）
│       └── src/
│           ├── main/            # 主进程
│           │   ├── index.ts     # 生命周期
│           │   ├── window.ts / tray.ts / icon.ts
│           │   ├── paths.ts / dataDir.ts / logger.ts / errors.ts
│           │   ├── ipc/         # 统一路由 + 按域拆分的 handler
│           │   └── services/    # 业务服务（见 §3）
│           ├── preload/         # contextBridge 暴露的 API
│           └── renderer/src/    # React 界面
│               ├── app/         # 布局、路由、全局状态
│               ├── features/    # 按功能域切分（terminal / sftp / settings / …）
│               ├── components/  # 通用组件
│               ├── styles/      # 设计变量与全局样式
│               ├── theme/       # 配色与外观计算
│               └── lib/         # store、IPC 客户端等
├── server/                      # 可选的云同步后端（零依赖纯 JS，含 test/）
├── scripts/                     # 仓库级脚本：六格式打包、发布、SSH 测试主机
├── docs/                        # 工程文档（同步协议、部署、性能目标、脚本指南）
└── docs/fixtures/               # 文档引用的协议样例
```

## 3. 主进程服务边界（每个服务一个目录，互不越界）

| 服务 | 职责 | 关键依赖 |
|---|---|---|
| `store` | SQLite KV + 实体仓储 + 主密码加密 + 备份导入导出 | better-sqlite3, argon2 |
| `ssh` | SSH 会话：5 态认证、跳板链、代理、算法、keepalive、重连 | ssh2, socks |
| `sftp` | 文件浏览 / 上传下载 / 递归 / 进度 / 取消 / 权限 / 远端编辑 | ssh2 sftp |
| `forward` | 端口转发：本地 / 远程 / 动态(SOCKS5)，自动重连 | ssh2 |
| `pty` | 本地终端 PTY + Shell Integration | node-pty |
| `telnet` | Telnet 会话 + 按键映射 | node:net |
| `vnc` | VNC 代理与协议桥 | (自研) |
| `rdp` | RDP：拉起 FreeRDP 进程并嵌入 | child_process |
| `monitor` | 远端采集脚本分发 + 定时采集 + 指标缓存 | ssh（复用连接） |
| `notes` | Markdown 笔记 CRUD + 废纸篓 + 关联连接 | store |
| `completion` | 命令补全引擎（spec 语料 + 历史 + 动态变量） | 自研语料 |
| `ai` | AI 助手（BYO-key）+ 风险黑白名单 + 三重上限 | openai/anthropic SDK |
| `mcp` | MCP 服务端（HTTP + 工具暴露 + 策略） | @modelcontextprotocol/sdk |
| `sessionlog` | 会话日志/录制 | fs |
| `hotkey` | 全局快捷键双通道 | Electron |
| `sync` | 与自建后端同步（零知识加密） | server/ |

**边界纪律**：服务之间只通过 `packages/shared` 的类型交互；跨服务调用走显式注入，不直接 import 别的服务内部文件。

## 4. IPC 契约

- 单一通道 `terminal-1000`，载荷 `{ domain, action, payload }`，主进程按 domain 路由到 handler
- 所有入参出参用 **zod schema** 校验（在 `packages/shared/src/ipc.ts` 定义）
- 主 → 渲染方向的流式事件（终端输出、传输进度、监控更新）走 `EventEmitter` → `webContents.send`
- 事件名统一 `SCREAMING_SNAKE`，前缀按域（如 `SSH_*`、`SFTP_*`、`MONITOR_*`、`FORWARD_*`）

## 5. 数据与加密

- 单库 `local-store.db`，泛型 KV 表 `local_store(store_key, item_id, payload, updated_at, created_at)`
- 实体后缀区分：`Server` / `ServerStatus` / `Group` / `Note` / `Credential` / `AIChat` / `Settings`
- **主密码**：argon2id 派生 → AES-256-GCM 加密敏感字段（password / privateKey / passphrase）
- 备份文件：自有格式（magic `T1000_BACKUP`、版本号、PBKDF2/AES-GCM 信封），
  只读写本格式，不解析任何其它软件的备份
- 云同步保持**零知识**：服务端只存密文，密钥不出本机

## 6. 自建同步后端（server/）

- 部署目标：`192.168.1.187`，数据目录 `/mnt/hdd-btrfs/terminal-1000`
- 职责最小化：账号 + 密文 blob 的版本化存储 + 拉取，**不解密、不索引明文**
- 传输：HTTPS + Bearer token；冲突按 `updated_at` + 版本向量处理

## 7. 开发纪律

1. **每个模块必须有类型 + 至少一个可运行的验证**（单元测试或可复现命令），不能只写代码不验证
2. 文案、图标、插画一律原创，**不得**从任何第三方安装包中提取
3. withfig / 命令手册等第三方语料**先核实 license**，默认不打包，改用自建或明确许可的语料
4. 提交前跑 `pnpm typecheck` + `pnpm test`
