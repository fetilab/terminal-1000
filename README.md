# terminal-1000

> 现代跨平台终端与远程连接管理器 —— SSH / SFTP / Telnet / 隧道 / VNC / RDP 统一在一个界面里。

**terminal-1000** 把终端、文件传输、端口转发、图形远程桌面和服务器监控整合到一个桌面应用，
面向需要管理多台服务器的开发者与运维人员。

**许可证：[GPL-3.0](LICENSE)** · 状态：**开发中（尚未发布）**

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
- CPU（逐核）、内存、磁盘（分区级读写）、网络、进程
- 采集脚本随包分发，在远端执行，无需安装 agent
- 卡片可开关，关闭即停止对应采集

### 安全与数据
- 主密码派生密钥（argon2id）+ AES-256-GCM 加密存储凭证
- 数据本地 SQLite，凭证不上传
- 加密备份导入导出
- 云同步（可选、自建后端、**零知识**：服务端只存密文，密钥不出本机）

### 扩展
- AI 助手（BYO-key，支持 OpenAI / Anthropic 兼容接口）
  - 命令解释、生成、错误诊断
  - 风险命令黑白名单 + 执行次数上限
- MCP 服务：向外部 AI 客户端暴露受策略约束的工具

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
pnpm test       # 单元测试
```

原生模块（node-pty / better-sqlite3 / argon2）需针对 Electron ABI 重编译，`pnpm install` 后会自动执行。

### 目录结构

```
packages/shared     全局类型与 IPC 契约
apps/desktop        Electron 应用（main / preload / renderer）
server              可选的同步后端
```

## 数据存放位置

| 平台 | 路径 |
|---|---|
| Linux | `~/.config/terminal-1000/` |
| macOS | `~/Library/Application Support/terminal-1000/` |
| Windows | `%APPDATA%\terminal-1000\` |

## 贡献

欢迎提交 Issue 与 Pull Request。提交前请确保：

1. `pnpm typecheck` 与 `pnpm test` 通过
2. 新增功能附带测试或可复现的验证步骤
3. **不要**引入任何第三方的专有代码、二进制或未明确许可的语料资源
4. 新文件使用项目的许可证头（见 [CONTRIBUTING.md](CONTRIBUTING.md)）

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
