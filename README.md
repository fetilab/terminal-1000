# terminal-1000

> 现代跨平台终端与远程连接管理器 —— SSH / SFTP / Telnet / 隧道 / VNC / RDP 统一在一个界面里。

**terminal-1000** 把终端、文件传输、端口转发、图形远程桌面和服务器监控整合到一个桌面应用，
面向需要管理多台服务器的开发者与运维人员。

**许可证：[GPL-3.0](LICENSE)** · 当前版本：**v0.2.4**

---

## 下载与安装

全部安装包在本仓库的 [Releases](../../releases) 提供，同样可以用下面的打包命令自行构建：

| 格式 | 适用 | 说明 |
|---|---|---|
| `.deb` | Debian / Ubuntu 及衍生 | 约 93 MiB，`sudo apt install ./terminal-1000_0.2.4_amd64.deb` |
| `.rpm` | Fedora / openSUSE / RHEL 系 | 约 92 MiB，`sudo dnf install ./terminal-1000-0.2.4.x86_64.rpm` |
| `.pacman` | Arch / Manjaro | 约 94 MiB，`sudo pacman -U terminal-1000-0.2.4.pacman` |
| `.AppImage` | 任意发行版 | 免安装，`chmod +x` 后直接运行 |
| `.flatpak` | 支持 Flatpak 的环境 | `flatpak install ./terminal-1000-0.2.4-x86_64.flatpak` |
| `.exe` | Windows 10+ | **实验性**，见下方说明 |

> **升级不会丢数据**：设置、连接、凭据、笔记都存在系统配置目录里（见
> [数据存放位置](#数据存放位置)），不在安装目录内。覆盖安装只替换程序文件；
> 旧版本若把数据存在过别的位置，首次启动会自动**复制**过来，原目录保留不删。

> **Windows 包现状**：安装器可构建，但应用的原生模块（node-pty / better-sqlite3）目前只在
> Linux ABI 下重建，未做 win32 交叉编译。Windows 用户请先用 WSL 或等待正式的
> Windows CI 产物（见 [CONTRIBUTING.md](CONTRIBUTING.md) 的 CI 计划）。

**系统要求**：Linux x86-64（GTK3 / libnotify / NSS）/ Windows 10+。首次启动会要求设置主密码，
用于加密本机保存的全部服务器凭证。

---

## 项目性质声明

terminal-1000 是一个**独立实现**的开源项目。它**不是**任何商业软件的衍生作品：

- 本项目不包含、不复制、不链接任何第三方专有软件的代码、二进制、图标、插画或文案
- 项目的功能范围参考了同类工具的公开文档与用户可见行为，**实现全部自主完成**
- 与本项目功能相近的任何商业产品**均无关联、未获其授权、也不为其背书**；反之亦然

## 功能

### 连接管理
- 多协议统一管理：SSH / SFTP / Telnet / 隧道（端口转发）/ VNC / RDP
- 多级分组、收藏、最近、常用视图；按延迟与信息排序
- 批量操作：导出、复制、删除、并发连接
- 连接导入（OpenSSH config 等）

### SSH
- 认证方式：密码、私钥（含口令）、登录凭证引用、keyboard-interactive（含 2FA）
- 自定义认证尝试顺序
- 多跳跳板机链路（逐跳代理与指纹校验）
- 代理：SOCKS4/5、HTTP(S)
- 算法偏好：KEX / Cipher / HostKey / HMAC
- 三层保活：传输层心跳、shell 层保活、转发层退避重连
- X11 转发
- 主机密钥指纹校验（首次确认 + 变更告警）

### 终端
- 多标签、水平/垂直分屏
- **kitty 渲染内核**（详见下文[终端渲染内核](#终端渲染内核kitty)）
- Shell Integration：命令块、退出码、当前目录
- 命令补全：语料 + 历史 + 动态变量
- 快捷命令（支持 `${{变量:格式}}` 动态变量）
- 终端显示编码切换（UTF-8 / GBK / Big5 …）
- 可自定义高亮规则（正则 + 颜色 + 优先级）
- 会话日志记录
- 并发广播：一次输入，多台服务器同时执行

### 文件传输
- 图形化 SFTP 浏览器，拖拽上传下载
- 目录递归传输、进度显示、可取消
- 冲突处理与权限管理
- 远端文件在线编辑

### 端口转发
- 本地转发 / 远程转发 / 动态代理（SOCKS5）
- 可视化状态管理与自动重连

### 图形远程桌面
- RDP 与 VNC
- 缩放 / 全屏 / 剪贴板共享 / 只读模式 / 多客户端共享

### 本地终端
- 无需远程连接即可操作本机 Shell
- Bash / Zsh / PowerShell 等
- 与 SSH 终端共享分屏、主题与命令块能力

### 服务器监控
- CPU（逐核）、内存、磁盘（分区级读写）、网络、进程、GPU（NVIDIA / AMD）
- **两种采集通道**，自动选择：
  - **常驻代理**（推荐）：连接成功后询问是否安装一个单文件 Python 3 代理
    （`~/.t1000-monitor/agent.py`，仅标准库）。它常驻远端、计数器留在内存里，
    速率是真增量；桌面端经 **SSH 隧道**（`direct-tcpip`）访问它的 `127.0.0.1` 端口，
    服务器**不用开任何入站端口**、不用改防火墙。请求带 token 校验，状态文件 `0600`；
    空闲 15 分钟自动退出；面板里「卸载代理」一键停止并删文件。
  - **脚本模式**（兼容）：服务器没有 python3、或你选择不装时自动回退，
    每拍在远端执行一段随包分发的 shell 脚本。功能相同，只是刷新更粗、开销更大。
- 卡片可开关，关闭即停止对应采集；采不到数据的卡片会说明原因（没有 GPU 驱动等），不会整块消失

### 安全与数据
- 主密码派生密钥（argon2id）+ AES-256-GCM 加密存储凭证
- 数据本地 SQLite，凭证不上传
- 加密备份导入导出
- 云同步（可选、自建后端、**零知识**：服务端只存密文，密钥不出本机）

### 同步通道的安全模型（TSC/1）

多端同步默认走自研的 **TSC/1 加密通道**（`docs/SYNC-SECURE-CHANNEL.md`），三条不变量：

1. **零知识**：数据在本机用「同步口令」加密后才上传；服务端被攻破也只是密文泄露，
   与备份文件被拿走同级。同步口令与服务端账号口令是两个独立的口令。
2. **SSH 式信任（TOFU）**：首次连接核对服务端身份指纹（应用内只读探测，不带任何数据），
   核对后**钉扎**；之后每次连接校验对端出示的身份，不符立即拒绝。
3. **身份变化 ≠ 首次连接**：已钉扎的服务端换了身份时，界面给出的是**常驻的中间人告警**
   （附已记录/本次收到两个指纹），而不是"请核对后信任"——这两件事被混淆等于引导用户
   信任攻击者的密钥。此路径有端到端验收（`scripts/acceptance.mjs` 的 S21）盯防。

握手失败**永不退回明文 HTTP**（规范 §3.3.1）：有退路就有降级攻击。

### 自建同步后端

同步是可选功能；不配置就是纯本地应用。要启用时自己跑 `server/`（零依赖纯 JS）：

```bash
cd server && node src/index.js   # 默认 HTTP 8787（仅回环）+ TSC/1 8788（可公网）
```

- 只依赖 Node ≥ 22，无 npm 依赖；数据落本地目录，账号/令牌/密文 blob 三类记录
- 单机部署、反代、systemd 与指纹核对流程见 [docs/DEPLOYMENT-192.168.1.187.md](docs/DEPLOYMENT-192.168.1.187.md)
- 协议规范与威胁模型见 [docs/SYNC-SECURE-CHANNEL.md](docs/SYNC-SECURE-CHANNEL.md)

### 扩展
- AI 助手（BYO-key，支持 OpenAI / Anthropic 兼容接口）
  - 命令解释、生成、错误诊断
  - 风险命令黑白名单 + 执行次数上限
- MCP 服务：向外部 AI 客户端暴露受策略约束的工具

### 外观与美化
- 背景可播放：**纯色 / 图片 / 视频 / TS 脚本**
- 三个内置脚本开箱即用：`matrix` 代码雨、`donut` 旋转甜甜圈、`snow` 下雪
- 自带帧率上限与错误围栏；脚本怎么写见 [docs/background-scripts.md](docs/background-scripts.md)
- 毛玻璃与透明度按**本软件的窗口分区**调节（不是通用模板）：
  - **背景**：壁纸自身不透明度 / 壁纸高斯模糊 / 背景遮罩（浅色盖白、深色盖黑）
  - **窗口区域**：主区域（终端 / 文件浏览 / 监控）、侧边栏（图标栏 + 会话列表）
  - **浮层**：弹窗与设置窗口、菜单与命令补全、输入框、代码块与编辑器
  - **质感**：毛玻璃强度、强调色浓度、界面缩放
- 一条硬规则：**一个区域只有一层半透明底色**。底色只画在 `.rail` / `.panel` / `.content`
  三个区域容器上，区域内部再满幅的容器一律透明、靠 1px 边框分层；毛玻璃也只挂在这三处。
  否则 72% 叠 72% 会变成 92%，屏幕上就是「有的地方透、有的地方发白」。
- 终端画布的透明度与「主区域」读同一个值（有壁纸时完全透明、透出主区域那一层），
  所以终端和两侧从机制上不可能再脱节。

## 终端渲染内核（kitty）

终端默认使用 **kitty 的 VT 内核 + 自研 WebGL2 渲染器**（可一键回退 xterm.js）。
这不是"套壳 xterm"，而是一条完整的 kitty 渲染管线移植：

- **内核**：`kitty-vt-wasm`（kitty 的 VT 解析器编译产物）跑在 Worker 里，支持
  Kitty 键盘协议（CSI u）、kitty 图形协议、完整 SGR 集；图形协议的图片
  （PNG / RGBA 原始像素 / 分块传输 / zlib 压缩 / z 分层 / 随内容滚动）由渲染器落进网格。
- **字形**：Canvas 光栅化的 glyph atlas，粗体/斜体四变体、连字（liga/calt 按整段成形）、
  组合字符、宽字符（CJK 占两格）。为了让小字号也干净，图集做了三件事：
  - **横向贴合**：每个字形按自己的自然宽度缩放到正好一格（CJK 缩放到两格）。
    等宽字体的步进很少是整数（12px 下 7.22px），直接塞进 7px 的格子会把右边切掉一条
    —— 那就是"边缘像被抠过"的来源；缩放在 3% 以内，肉眼看不出来，但裁切和缝隙都没了。
  - **制表/块/阴影几何绘制**：`─│┌┐└┘├┤┬┴┼` 与粗体/双线版本、`█▀▄▌▐` 与 1/8 分块、
    `░▒▓` 不查字体，直接按格子坐标画矩形。任何字号下框线严丝合缝、块是真正实心。
  - **笔画加黑**：canvas 的 `fillText` 没有 hinting，12px 下一条竖线的覆盖率常常只有
    60%，落在两个像素上就是"两条灰边"。图集光栅化后按覆盖度曲线（小字 k=1.3）抬中段，
    笔画变实而字重不变。
- **文本装饰**：五种下划线（直/双/波浪/点/虚）+ 删除线 + SGR 58 下划线颜色，
  粗细与位置跟 kitty `cursor_underline_thickness` 同源。
- **光标**：block / beam / underline，失焦按 `cursor_inactive_style` 降级；
  **拖尾与原版逐行同源**——kitty `cursor_trail.c` 的移植：4 个角各自指数缓动追赶光标
  （`cursor_trail_decay` 按方向点积插值快慢衰减）、`cursor_trail` 毫秒门控、
  `cursor_trail_start_threshold` 启动阈值；光标本体永远画在真实位置、shader 按包围盒
  遮罩拖尾，任何时刻**只有一个光标**。
  闪烁遵循 kitty 的语义：**有活动（按键 / 输出 / 光标跳动）时立刻点亮并重新计时**，
  所以敲字、翻历史时不会出现"光标正好在灭的相位里、一动就看不见"；
  静止 15 秒后停止闪烁转常亮。设置 → 终端美化 → 光标 里的「光标闪烁」关掉即**常亮**。
- **选区/搜索/高亮**：WebGL 里的三段实例化 pass（背景/字形/装饰），脏行增量上传，
  40×120 网格满帧只有 5 次 draw call。
- **回看**：滚动回看不打断内核会话；切页隐藏（display:none + 停帧）而不卸载，
  历史与光标原样保留。


## 技术栈

Electron · React · TypeScript · xterm.js · ssh2 · node-pty · better-sqlite3 · Monaco

详见 [ARCHITECTURE.md](ARCHITECTURE.md)。

## 开发

```bash
# 需要 Node >= 22 与 pnpm
corepack enable
pnpm install
pnpm dev        # 启动开发模式
pnpm build      # 构建
pnpm typecheck  # 类型检查
pnpm test       # 单元测试（1700+ 项）
```

原生模块（node-pty / better-sqlite3 / argon2）需针对 Electron ABI 重编译，`pnpm install` 后会自动执行。

### 整机验收

本项目有一条**对真实运行应用**的整机验收（通过 CDP 驱动真实 Electron，不是 mock），
当前 32 通过 / 0 失败 / 4 跳过（跳过原因在脚本里逐条写明）：

```bash
cd apps/desktop
Xvfb :75 -screen 0 1280x800x24 &           # 无头环境需要 X
pnpm build && DISPLAY=:75 node scripts/acceptance.mjs
```

另有针对真实 SSH 测试主机的门控测试（`scripts/ssh-test-host.mjs`）与
同步加密通道的真机验收（需部署后端），VNC/RDP 有进程内协议夹具覆盖、不依赖外部机器。

### 打包

```bash
cd apps/desktop
pnpm dist                        # 默认：deb + AppImage
pnpm exec electron-builder --linux rpm pacman flatpak   # 其余 Linux 目标
pnpm exec electron-builder --win nsis                   # Windows 安装器（实验性，见上文）
```

产物在 `apps/desktop/release/`。注意 rpm 构建依赖 fpm 1.9.3，它与 rpm ≥ 4.20 的
rpmbuild 不兼容，需要把 `rpmbuild` 钉在 4.x 旧版（本机的垫片方案见 HANDOFF.md）。

### 目录结构

```
terminal-1000/
├── apps/desktop/            Electron 应用（唯一可执行产物）
│   ├── src/main/            主进程：IPC 路由 + 各业务服务（ssh / sftp / pty / store …）
│   ├── src/preload/         contextBridge 暴露的 API
│   ├── src/renderer/src/    React 界面（app / features / components / styles / theme）
│   ├── agent/               远端监控采集器（Go，独立编译）
│   ├── build/               打包资源：图标、desktop 文件、flatpak / pacman 元数据
│   ├── vendor/              内置第三方运行时（kitty-vt-wasm）
│   └── scripts/             应用级构建与验收脚本
├── packages/shared/         全局类型与 IPC 契约（冻结，改动需评估影响）
├── server/                  可选的同步后端（零依赖纯 JS，含 test/）
├── scripts/                 仓库级脚本：六格式打包、发布、SSH 测试主机
└── docs/                    工程文档：同步协议、部署、性能目标、背景脚本指南
```

构建产物 `out/`、`release/` 与依赖 `node_modules/` 不入库。更细的分层与模块边界见
[ARCHITECTURE.md](ARCHITECTURE.md)。

## 数据存放位置

所有持久化数据都在**系统配置目录**，不在安装目录里 —— 升级 / 覆盖安装只替换程序文件，
不会碰这些数据；卸载也不会自动删除。

| 平台 | 路径 |
|---|---|
| Linux | `~/.config/terminal-1000/`（Flatpak：`~/.var/app/io.github.terminal1000/config/terminal-1000/`） |
| Windows | `%APPDATA%\terminal-1000\` |
| macOS | `~/Library/Application Support/terminal-1000/` |

目录内主要有：

| 条目 | 内容 |
|---|---|
| `local-store.db` | 连接、分组、设置、笔记、快捷命令、布局（凭据字段加密） |
| `notes/`、`session-log/`、`backups/`、`backgrounds/`、`logs/` | 笔记附件、会话录制、每日备份、背景图、运行日志 |
| `known-hosts.json`、`window-bounds.json` | 主机指纹（TOFU）、窗口位置与大小 |
| `migration.json` | 若发生过旧目录迁移，这里记录来源目录与迁移项 |

几点约定：

- 目录名**固定**为 `terminal-1000`，不随应用显示名变化 —— 改名不搬家，避免"设置凭空消失"。
- 目录**不会**落在安装目录内；若运行环境让系统配置目录指向安装目录，启动时会强制改到
  安全位置并写日志。
- 备份与迁移都是**复制**语义：识别到旧位置的数据时复制到新位置，**原目录保留**，
  确认无误后可自行删除。
- 设置 → 应用 → **存储位置** 里可以直接看到当前实际使用的路径，并一键打开。

## 安全

这个程序会**在本机保存服务器口令、私钥与同步凭据**，并且自带一个可对公网暴露的同步后端。
安全边界、已明确的取舍、以及**漏洞报告方式**见 [SECURITY.md](SECURITY.md)。

⚠️ 提交 issue 或演示时**永远不要粘贴真实凭据** —— 见 [行为准则](CODE_OF_CONDUCT.md) 中本项目特有的一节。

## 文档

| 文档 | 内容 |
| --- | --- |
| [ARCHITECTURE.md](ARCHITECTURE.md) | 进程边界、IPC 契约、服务分层 |
| [CHANGELOG.md](CHANGELOG.md) | 变更记录（修复类条目尽量写明「现象 → 根因」） |
| [SECURITY.md](SECURITY.md) | 安全模型、已知边界、漏洞报告 |
| [CONTRIBUTING.md](CONTRIBUTING.md) | 开发环境、提交规范、许可证头 |
| [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) | 行为准则 |
| [docs/](docs/) | 同步协议规范（TSC/1）、部署手册、性能目标 |
| [docs/background-scripts.md](docs/background-scripts.md) | 动态背景 TS 脚本开发指南（契约、内置示例、发布） |

## 贡献

欢迎提交 Issue 与 Pull Request。提交前请确保：

1. `pnpm typecheck` 与 `pnpm test` 通过
2. 新增功能附带测试或可复现的验证步骤
3. **不要**引入任何第三方的专有代码、二进制或未明确许可的语料资源
4. 新文件使用项目的许可证头（见 [CONTRIBUTING.md](CONTRIBUTING.md)）
5. **修复类提交请在信息里写清「现象 → 根因」**，而不只写"修复了 X" ——
   本项目有一批缺陷属于"看起来正常、实际从未生效"，根因比结论对后来者有用得多
6. 涉及安全边界的改动请一并更新 [SECURITY.md](SECURITY.md)

所有贡献默认以 GPL-3.0 授权。

## 许可证

本项目以 **GNU General Public License v3.0** 发布，全文见 [LICENSE](LICENSE)。

```
terminal-1000 — terminal and remote connection manager
Copyright (C) 2026 terminal-1000 contributors

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.

You should have received a copy of the GNU General Public License
along with this program.  If not, see <https://www.gnu.org/licenses/>.
```
