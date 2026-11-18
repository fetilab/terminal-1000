# terminal-1000 会话交接

面向接手本项目的下一个 agent 会话。读完这一份即可继续，不必回溯历史对话。
最后更新：2026-11-18

---

## 1. 项目是什么

`terminal-1000`：功能对齐 **XTerminal 5.8.6** 的独立 **Electron + React + TypeScript** 远程连接管理器。
GPL-3.0 开源。覆盖 SSH / SFTP / Telnet / 隧道 / VNC / RDP、终端工作区、监控面板、命令补全、
AI 助手、MCP 服务、并发广播、笔记、加密存储，外加**自研的云同步后端**（部署在 `192.168.1.187`）。

工作目录：`/home/mosfet/dsh1/terminal-1000`

### 合规红线（必须遵守）
- **绝不把 `research/` 下的任何内容写进产品**：那是逆向材料（原软件解包、文档摘录）。
  产品代码、语料、文案、图标一律**自研**。
- `research/` 与 `spec/` 已在 `.gitignore` 里。**不要**为了"方便"把它们加进版本控制。
- 不引入许可不明的第三方语料/图标/字体。

---

## 2. 当前状态

| 指标 | 值 |
|---|---|
| 提交 | 见 `git log --oneline \| wc -l` |
| 源码规模 | 约 8.5 万行 TS/TSX |
| 单元测试 | `pnpm test` 全绿（约 1702 项，83 文件） |
| typecheck | node 与 web 均 **0 错误** |
| 整机验收 | `node scripts/acceptance.mjs` → **32 通过 / 0 失败 / 4 跳过**（S21 为新增身份变化端到端） |
| IPC 域 | **23 个** |
| 打包 | deb / AppImage；deb 约 93.4 MiB（预算 ≤100 MiB）；**rpm/pacman 未做** |

### 复现验证（三条命令）
```bash
cd /home/mosfet/dsh1/terminal-1000/apps/desktop
pnpm test                                    # 单元测试
pnpm typecheck                               # 类型检查
Xvfb :75 -screen 0 1280x800x24 &             # 验收需要 X
pnpm build && DISPLAY=:75 node scripts/acceptance.mjs
```

---

## 3. 仓库结构

```
apps/desktop/             Electron 应用
  src/main/               主进程：23 个 IPC 域（services/<域>/index.ts 导出 <域>Handlers）
  src/renderer/           渲染层：features/<功能>/
  scripts/acceptance.mjs  整机验收（通过 CDP 驱动真实应用）
packages/shared/          ★ 冻结契约：ipc.ts / events.ts / connection.ts / settings.ts / completion.ts
server/                   ★ 零依赖纯 JS 同步后端（部署在 .187），含 src/tsc1/ 加密通道
scripts/                 测试夹具（ssh-test-host.mjs 等）
docs/                    架构、性能目标、部署、协议规范
spec/                    功能规格（gitignore）
research/                逆向材料（gitignore，绝不入库、绝不抄）
```

### 契约纪律（本项目的核心约束）
1. **`packages/shared` 由 lead 独占修改**。队友需要扩展契约时**先报告**，不要自行改。
2. **新增 IPC 域必须同时改两处**：`IPC_DOMAINS` 数组 **和** `Actions` 表。
   只加一处会导致调用被 router 直接拒绝（历史上踩过：界面做好了但动作不可达）。
3. **域要注册**：`registerLazyDomain('<域>', ...)`，只有 `app` 是 eager。
4. **新增设置字段必须同时进字段注册表** `src/renderer/src/features/settings/settingsFields.ts`，
   否则设置不生效（有测试 `settingsFields.test.ts` 会红）。
5. **跨服务调用走显式注入**，不要 import 别的服务内部实现（`configureAi` / `configureCompletionAi` 是范例）。
6. **新增实体要同时改** `services/store/db.ts` 与 `services/store/backup.ts` 的 `storeKeyAlias`。

---

## 4. 运行环境

### 本机
- Node ≥ 24，pnpm 11，monorepo（`pnpm-workspace.yaml`）
- 无头 UI：`Xvfb :75 -screen 0 1280x800x24 &`，Electron 必须带 `--no-sandbox --ozone-platform=x11`

### 服务器 `192.168.1.187`
- **仅 IPv6**：绑定必须用 `::`，`0.0.0.0` 完全不可达
- 域名 `mc.mosfetech.de5.net`（IPv6 解析到该机）
- 数据盘 `/mnt/hdd-btrfs`（1TB 机械盘），同步数据在 `/mnt/hdd-btrfs/terminal-1000/data`
- 同步后端 systemd 服务：`terminal-1000-sync`
- **HTTP 端口 8787**（给反代用，仅回环）+ **TSC/1 加密端口 8788**（公网直连，无反代）
- TSC/1 身份指纹：`4844 72aa 4517 f615 edae a7a4 d86c acff`
  （查看当前值：`node server/src/tsc1/identity.js --fingerprint`，需在有身份的机器上跑）
- 部署细节与回滚方式：`docs/DEPLOYMENT-192.168.1.187.md`
- **不要动** Lucky 反代与 Docker/1Panel 的配置
- 80 端口被 ISP 封；**443 无证书**，所以外网走 `http://<域名>:8787`（明文，仅本地/回环允许）
  或 `tsc1://<域名>:8788`（加密）

### 远程执行（dsh-remote）—— 有陷阱
绑定机器后**所有 bash 命令都在远端执行**，而远端那份目录是**旧的同步镜像**。
- **动手前 `remote_machine status`**，办完**立刻 unbind**（不靠记忆）
- **绑机期间不要用 bash 改本地文件**（文件操作用 read/write/edit 工具）
- **绑机前先 commit** —— 出过一次 41 个文件被旧镜像回退的事故，HEAD 救回了绝大多数
- 症状识别：`git status` 说"不是 git 仓库"、`node_modules` 空、文件属主变 root → **先查绑定状态**

---

## 5. 已完成

### 主进程（23 个域）
store（scrypt+AES-256-GCM 字段级加密、备份、布局）、ssh、sftp（含断点续传、递归、远端编辑回写、递归 chmod）、
telnet、forward（本地/远程/动态三类隧道）、pty、vnc、rdp、monitor、notes、completion（自建语料）、
ai（BYO-key + 护栏）、mcp（Streaming HTTP + Bearer + 白名单）、sessionlog、settings、sync、
hotkey、broadcast、quickcmd、system、update、shellIntegration（OSC 133 命令块）。

### 加密同步通道 TSC/1（自研协议）
- 规范：`docs/SYNC-SECURE-CHANNEL.md`（**改协议必须先改它**）
- 冻结向量：`docs/fixtures/tsc1-vectors.json` + 生成器 `docs/fixtures/gen-tsc1-vectors.mjs`
  **向量是两侧独立实现的唯一互操作保证，不要手改**
- 服务端 `server/src/tsc1/`（零依赖 JS，103 测试）
- 客户端 `apps/desktop/src/main/services/sync/{protocol,channel,channel-pool}.ts`
- 信任模型是 **SSH 式 TOFU**：`inspectServer`（只握手拿指纹）→ 用户带外核对 → `trustServer` 钉扎
- **硬性禁止**"握手失败退回明文 HTTP"（规范 §3.3.1）

### 渲染层
连接中心（分组树/搜索/批量）、终端工作区（xterm 6 + 分屏 + 12 项右键菜单 + 高亮装饰）、
SFTP 浏览器（多选/批量/chmod 对话框/书签/**树/列表双视图**）、Monaco 编辑器（笔记 + 远端文件，懒加载）、
监控面板、笔记、设置面板（含同步传输方式与指纹确认、外观：预设/背景图/透明度/缩放）、全局搜索、锁屏遮罩。

### 2026-11-18 会话新增（4 项任务全绿，提交 8f3d2aa..86d1937）
- **task-35 关闭**：`apps/desktop/test-fixtures/` 进程内 RFB 3.8 服务端 + 假 FreeRDP 客户端夹具；
  VNC 11 项 + RDP 10 项夹具测试默认运行（真机门控保留）。DES 期望值由 PyCryptodome 独立算出。
- **task-37 关闭**：`classifySyncError`/`formatFingerprint` 拆到 `syncError.ts` 并补 8 项单测；
  删除从错误文案正则抠指纹的兜底；acceptance 新增 **S21**（真起两台不同身份 TSC/1 服务端 →
  钉扎 A 指向 B → 真实 UI 登录 → 断言常驻中间人告警含 expected/actual 且未误判）。
- **P2 外观**：`theme/{color,presets,appearance}.ts` 纯函数层 + 5 套自研预设 × 明暗；
  `app.appearance.*` 五字段全注册（面板不说谎约束）；背景图只允许本地来源；无会员门控；
  theme.test.ts 13 项（WCAG AA 对比度、默认预设与 global.css 防漂移）。
- **P2 SFTP 树视图**：SftpBrowser 树/列表切换（记忆于 localStorage），树锚定远端 home、
  懒加载 + 与列表**共享同一份目录缓存**（一致性是结构保证）；treeModel 纯函数 40 项单测。

---

## 6. 剩余工作

### 明确未完成
| 项 | 说明 |
|---|---|
| 打包 | 只有 deb/AppImage，未做 rpm/pacman（electron-builder 加 target 即可，需验证 rpmbuild/系统依赖） |
| P2 记账本 | 方向 A（spec 未细化，做之前先与用户对齐） |
| VNC / RDP 真机交互 | 夹具端到端已覆盖协议层；真实 tigervnc/xrdp 的真机门控测试保留（需外部机器，用户曾授权临时装 .187） |

### 4 项 SKIP 的验收条目
见 `apps/desktop/scripts/acceptance.mjs` 中 `record(..., 'SKIP', ...)` 的位置（密码生成器[7]、
终端搜索/分屏[3]、SOCKS5[2b]、AI 真实对话[9]），多数因缺真实服务端。

---

## 7. 已知陷阱（都踩过）

1. **`updateSettings` 深度合并会跳过 `undefined`**：清除某个字段必须写 `null`，否则旧值存活
   （`forgetServer` 就栽在这里）。
2. **不要从错误文案里正则解析机器字段**：改用带结构的错误对象。指纹每 4 位含空格，
   曾经的正则永不匹配，导致错误码到不了渲染层。
3. **测试换 store 后设置会回到默认值**：设置文档属于当前 store；测试里换库必须重设传输等字段。
4. **`.gitignore` 用裸模式会误伤源码**：`notes/` 曾匹配任意层级，导致整个笔记域从未入库。
   改忽略规则后跑 `pnpm check:ignored`（有自检脚本）。
5. **xterm 6 的 DOM 渲染器不通过 `scrollHeight` 暴露回滚缓冲**：用可见行范围判断滚动位置。
6. **`@xterm/addon-search` 默认是字面量匹配**：搜索词不要转义正则，否则搜不到。
7. **`monaco-editor` 必须在 devDependencies**：放 dependencies 会进 asar，deb 从 93MiB 涨到 111MB。
8. **`forwarded-tcpip` 的 boundAddr/boundPort 要回客户端请求时的值**，回本地监听地址会被拒绝开通道。
9. **`remotePort: 0`（ssh -R 服务端分配端口）** 的实际端口只在 `forwardIn` 回调里返回。
10. **验收 `S18b` 曾长期 SKIP**，真实原因是测试主机没实现 `tcpip-forward`（已修）。
11. **"最严重的情况"与"最无害的情况"不能共用一个错误码**：身份不符（可能中间人）与首次连接
    曾是同一个 `UNTRUSTED_SERVER`，界面于是把中间人告警渲染成"请核对后信任"。
    分类错误优先于措辞问题 —— 先怀疑 code 分得对不对。
12. **同步网络调用抛错要落状态**：`call()` 抛错若不兜底，`state` 停在 `syncing`，
    界面看起来像还在同步（已用 `callWithStateFallback` 统一处理）。
13. **沙箱里的后台进程不跨命令存活**（bwrap `--die-with-parent`）：Xvfb/Electron 必须与
    验收脚本在**同一次 bash 调用**里起跑，"先起 Xvfb 再下一次调用跑验收"必挂
    （症状：CDP target 未就绪）。
14. **沙箱内 /tmp 不与宿主共享**，写进去的探针/截图下次调用就没了；临时脚本放工作区，
    验收截图要么读完即用、要么拷回仓库外的工作区路径。
15. **图标栏按钮只渲染 SVG**，标签在 `aria-label`/`title` —— CDP 驱动外壳导航必须用
    `button[aria-label="外部服务"]`，按 textContent 找永远匹配不上（S21 曾因此连挂三轮）。

---

## 8. 协作方式

- **任务板**：`team_task_list` / `team_task_get` / `team_task_update`
  （`claim` 用最新 revision；被外部重置时先 `get` 刷新再 `claim`）
- **写范围**：创建任务时在 `write_scopes` 写明，避免多人改同一文件
- **提交纪律**：完成一块就提交（工作只存在工作区时，一次误操作就没了）
- **汇报要求**：给出可核对证据（命令输出、截图、字节数），**未验证的明确说未验证**
- 队友名单见 `list_agents`

### 沟通与产出规范
- 注释与文档只写**非显然契约**（前置条件、副作用、失败模式、安全不变量），
  **不写推理过程、不写"我第一版错在哪"、不写测试叙述**；不用装饰性 emoji。
- 中文界面（spec 规定首版可仅中文）。
- 报告 bug 时给出复现命令与期望/实际。

---

## 9. 常用命令

```bash
# 仓库
cd /home/mosfet/dsh1/terminal-1000
git log --oneline | head -20
pnpm check:ignored                            # 检查是否有产品源码被 .gitignore 排除

# 应用
cd apps/desktop
pnpm test                                     # 单元测试
pnpm typecheck                                # 类型检查
pnpm build                                    # 构建（验收前必须成功，否则跑的是旧产物）
T1000_TSC1_E2E=mc.mosfetech.de5.net:8788 \
  pnpm vitest run src/main/services/sync/channel.remote.test.ts   # 加密通道真机验收

# 整机验收（需要 X）
Xvfb :75 -screen 0 1280x800x24 &
DISPLAY=:75 node scripts/acceptance.mjs

# 真实 SSH 测试主机（打印 host/port/凭据，真实文件系统）
node scripts/ssh-test-host.mjs --root /tmp/x

# 安全清理本会话起的 Electron（勿用 pkill -x electron，会误杀用户其它 Electron 应用）
bash scripts/kill-my-electron.sh
```

---

## 10. 接手后的第一件事

1. `cd /home/mosfet/dsh1/terminal-1000 && git log --oneline | head -5 && git status`
2. `cd apps/desktop && pnpm test && pnpm typecheck` —— 确认基线是绿的
3. `team_task_list` 看未完成任务；`list_agents` 看有没有活跃队友
4. 读 `spec/official-features.md` §20 的优先级表（功能基线）
5. 从 `task-35` / `task-37` 或 P2 清单里挑一项继续
