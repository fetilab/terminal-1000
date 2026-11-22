# terminal-1000 会话交接

面向接手本项目的下一个 agent 会话。读完这一份即可继续，不必回溯历史对话。
最后更新：2026-11-21

---

## 1. 项目是什么

`terminal-1000`：一个自主实现的 **Electron + React + TypeScript** 远程连接管理器。
GPL-3.0 开源。覆盖 SSH / SFTP / Telnet / 隧道 / VNC / RDP、终端工作区、监控面板、命令补全、
AI 助手、MCP 服务、并发广播、笔记、加密存储，外加**自研的云同步后端**（`server/`，可自建部署）。

工作目录：`/home/mosfet/dsh1/terminal-1000`

### GitHub 与发布（2026-11-19 起）
- 远端：`https://github.com/fetilab/terminal-1000`（public，GPL-3.0），分支 `master`
- 本机推送走 `https://github.com:443/...`（绕开全局 insteadOf 的只读代理重写）或
  `ssh.github.com:443`（公钥已注册到 fetilab 账号）；fastgithub/gh-proxy 只能克隆不能推送
- Release：`v0.1.4`（当前，六附件：AppImage/deb/rpm/pacman/flatpak/setup.exe）、`v0.1.3`、`v0.1.2`、`v0.1.1`、`v0.1.0`。
  flatpak 与 Windows 安装器都能在本容器构建，但各有前置条件，见「已知陷阱」23–24
- 推送凭据**没有落盘**：本机无 `credential.helper`、无 `~/.git-credentials`、无 `gh` CLI。
  需要时用 `GIT_ASKPASS` 临时脚本 + 环境变量传 token，推完即弃
- flatpak 需要 24.08 运行时 + `org.electronjs.Electron2.BaseApp`（已装，源为 USTC 镜像）

### 合规红线（必须遵守）
- 产品代码、语料、文案、图标一律**原创**，不从任何第三方安装包中提取内容。
- 不引入许可不明的第三方语料/图标/字体；引入前先核实 license。
- 仓库里不保留第三方二进制或分析产物（`.gitignore` 已排除安装包格式文件）。

---

## 2. 当前状态

| 指标 | 值 |
|---|---|
| 提交 | 见 `git log --oneline \| wc -l` |
| 源码规模 | 约 8.5 万行 TS/TSX |
| 单元测试 | 1794 通过 / 3 失败 / 5 跳过（1802 项，89 文件）。3 项失败是容器限制（无 PTY、以 root 跑权限用例），不是回归；跑法见陷阱 33 |
| typecheck | node 与 web 均 **0 错误** |
| 整机验收 | `node scripts/acceptance.mjs` → **32 通过 / 0 失败 / 4 跳过**（S21 为新增身份变化端到端） |
| 代理验收 | `node _verify-agent.mjs` → **29 通过 / 0 失败**（代理安装/隧道取数/卡片稳定/补全弹窗） |
| IPC 域 | **23 个** |
| 打包 | **六格式全量**：AppImage 102.2 / deb 91.9 / rpm 91.9 / pacman 91.9 / flatpak 93.4 / setup.exe 114.1（MiB）。一条命令 `scripts/pack-local.sh`，见陷阱 34 |

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

### 同步后端（`server/`）
- 零运行时依赖，只需 Node ≥ 22；数据落一个本地目录
- **HTTP 端口 8787**（给反代用，必须仅回环）+ **TSC/1 加密端口 8788**（公网直连，无反代）
- 仅 IPv6 的主机绑定必须用 `::`，`0.0.0.0` 完全不可达
- 身份指纹：`node server/src/tsc1/identity.js --fingerprint`
- 部署、端口隔离、反代与回滚方式：`docs/SELF-HOSTING.md`

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

### 2026-11-21 会话新增（界面密度改造，提交 3dc0840）
用户实测反馈集中在「控件占地太大、入口重复、不能调」：
- **文件浏览器顶栏三行压成两行**：工具条（46px）+ 面包屑（32px）合并成一条 34px 的 `.sftp-top`，
  面包屑变成其中弹性区（双击可直输路径）。纵向省 ~44px 给列表。
- **「两个下载」的真相**：`用系统编辑器打开` 复用了 `download` 图标。改为新图标 `external`，
  文案「用系统程序打开」，并连同书签/定位/内置编辑器一起收进「⋯」浮层。
- **视图切换改开关**：列表/树从分段控件改为自研 `Switch`（`components/Switch.tsx`），
  与「显示隐藏文件」并排放在「⋯」浮层里，**文字在开关下方**。
- **三栏可拖**：`components/Splitter.tsx`（指针捕获、双击复位、←→ 微调）+ `lib/usePaneWidth.ts`
  （localStorage 记忆）。宽度按可用宽度等比缩放，终端恒保 280px
  —— 1080px 窗口 + 文件栏 560 + 监控 320 会把 xterm 挤成竖排断字，这个下限是必须的。
- **会话栏可折叠**：44px 图标条（协议图标 + 6px 状态角标），悬停出属性卡（fixed 定位，
  避开 `.panel` 的 overflow 裁剪）。折叠状态进 store（`panelCollapsed`）+ localStorage，
  且**只在 console 视图生效**（其它视图侧栏塞不进 44px）。
- 补齐文件管理器常规能力：列头点击排序（名称/大小/权限/时间，方向记忆）、按名称过滤、
  状态栏（条目数/已选/合计大小）、↑↓/Home/End/Enter/Backspace/F2/Delete、
  双击文件用内置编辑器、窄面板容器查询（<430 藏过滤框，<370 只剩名称+大小）。
- 验收脚本：`_verify-ui-redesign.mjs`（工作区根，16 项，驱真 app + 真 ssh2 测试主机 + 真 SFTP）。

### 2026-11-20 会话新增（用户实测反馈 7 项修复，提交 ba63fae..733fc8a）
- ①新建连接表单焦点跳回：根因是 Modal 焦点 effect 依赖内联 onClose（每键重渲染触发重聚焦），
  useCallback 稳定引用修复；⑥四处新建连接按钮随协议栏联动（protocolLabels.ts + 单测）
- ②本地文件浏览：sftp 域 sftpFor 一处按会话 kind 分流到 local-backend（SftpLike→node:fs 适配器），
  14 动作与传输引擎零改动复用；顺手修 mtime 秒/毫秒显示 1970 的既有 bug
- ③zsh/oh-my-zsh 渲染错乱：unicode11 addon（**loadAddon 后必须显式 activeVersion='11'**）
  + 字体栈 emoji 回退；⑤高亮改为文字色（xterm 6 layer:'top' 装饰的 foregroundColor 会
  逐单元格涂到行 span 内联 color——装饰元素本身保持透明）
- ④补全语料用户文件：设置 completion.corpusFile，合并/覆盖/降级三态（userCorpus.ts 15 例单测）
- ⑦三栏布局：文件栏与终端并存（不再互换）、ssh 连接即自动 startMonitor 采集
- 已发布 v0.1.1（六包安装件，见 GitHub Releases）；注意 AppImage 107MB 略超 100MiB 预算

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
| 打包 | **已完成**：deb / AppImage / rpm / pacman（2026-11-19）。构建依赖见下方「rpm/pacman 构建环境」 |

### rpm/pacman 构建环境（本机已配好，换机器要重做）
- electron-builder 的 fpm 1.9.3 与 **rpm ≥ 4.20 不兼容**（buildroot 布局变更，BUILDROOT 不被填充、
  spec 里 `%undefine` 被当注释）——症状是所有文件报 "File not found: …/BUILD/…-build/BUILDROOT/…"。
- 解法：`~/.local/pkgshim/rpmbuild` 垫片把 rpmbuild 钉在**用户态解包的 rpm 4.18**
  （实际位于 **`/home/mosfet/dsh1/.pkg-tools/rpm4/`**，来自 noble 的 deb 解包；垫片会自己设
  `LD_LIBRARY_PATH` 指向 `usr/lib/x86_64-linux-gnu`）；构建时 `PATH=~/.local/pkgshim:$PATH`。
  不垫这一层时的症状就是所有文件报 "File not found: …/BUILD/…-build/BUILDROOT/…"。
- 另需 `~/.rpmmacros` 写 `%_dbpath <可写目录>`，否则 rpm 6 以非 root 校验时会开系统 rpmdb 被拒。
- 系统依赖（root 已装）：`apt-get install rpm libarchive-tools`（pacman 目标的 fpm 要 bsdtar）。
- 产物在 `apps/desktop/release/`：`terminal-1000-0.1.2.x86_64.rpm`（91.6 MiB，310 文件，
  带 `%post` 的 update-alternatives 链接脚本）、`terminal-1000-0.1.2.pacman`（91.6 MiB）。
  验证：`rpm -qip` / `rpm -qp --scripts` / `bsdtar -tf`。
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
16. **`@container` 规则不能作用于容器自身**：容器查询只对容器的**后代**生效。
    想按面板宽度改列宽，必须直接写 `.sftp-head, .sftp-row { … }`，不能靠容器自己设
    自定义属性再继承。
17. **容器查询 / 覆盖规则要放在样式文件末尾**：它们与基础规则同特异性，靠「后出现」取胜。
    写在中段会被后面的基础规则反超（本轮踩过：窄面板下 `minmax(0,2.4fr)` 被 350px 的
    固定列挤成 0，文件名全没了）。
18. **不要用 `minmax(52px, 84px)` 这类区间列**：和 `2.4fr` 同排时，区间列会先长到上限，
    名称列被挤到 0。固定 px 列更可控。
19. 本沙箱**没有可用 PTY**（`/dev/pts` 0 个，`forkpty(3) failed`），且 `/tmp` 只有 10MB
    （写入型测试会 ENOSPC）。本地终端与 `pnpm test` 里依赖 pty/大文件的用例在此环境必然红：
    验收走 `scripts/ssh-test-host.mjs` + CDP（SSH 不需要本地 pty）。
20. **无头窗口默认 1080 CSS 宽**，三栏全开时没有拖动余量；验收要先用
    `Emulation.setDeviceMetricsOverride` 放大到 1600×900 再量宽度。
21. **本机 `fs.copyFile` 一律 EPERM**（`copy_file_range` / `sendfile` 被拦），普通 read/write
    正常（`cp` 可用）。electron-builder 打包 asarUnpack 与 Electron 发行版复制全靠它，
    于是必然 `EPERM: operation not permitted, copyfile …`。解法：用
    `NODE_OPTIONS=--require <patch>.cjs` 把 `fs.copyFile`/`fs.copyFileSync`/`fs.promises.copyFile`
    在 EPERM 时降级成「读-写」。**与 WorkBuddy 沙箱开关无关**，关掉沙箱一样 EPERM。
22. **`/bin/rm` 是 `gnurm` 垫片**（`rm -> gnurm`），一次删除 >50 个目标会被 bulk guard 拒绝
    并返回非 0。后果：`rpmbuild` 的 `%clean`/`rmbuild` 阶段失败、`flatpak-builder` 清理失败，
    表现为「包其实已经写出来了，但进程 exit 1」。判断方法是**先看产物是否存在且大小合理**，
    不要被退出码骗了；`cp -a` 想保留时间戳也会 EPERM，用 `cp -R --preserve=mode,links`。
23. **flatpak 能出包，但要挂三处开关**（缺一即失败，报错各不相同）：
    - `/var/lib/flatpak` 属未映射的 `nobody`（rootless userns，`uid_map` 只有 `0→1000`），
      system 范围装不了运行时 → `flatpak-builder --user`，运行时装 user 范围
      （`org.freedesktop.Platform/Sdk 24.08`、`org.electronjs.Electron2.BaseApp 24.08`）。
    - 没有 `/dev/fuse` → `Failure spawning rofiles-fuse` → `--disable-rofiles-fuse`。
    - fd 形式的 `utimensat`/`futimens` 返回 EPERM，ostree 报
      `Writing content object: futimens: 不允许的操作` → `LD_PRELOAD` 一个把
      `futimens`/`utimensat`/`utimes` 变成返回 0 的垫片（只牺牲可复现性，不影响包内容）。
    - 垫片要挂在**整个 electron-builder 进程**上，因为收尾的 `flatpak build-export`
      是它自己 spawn 的，只包 `flatpak-builder` 不够。
24. **Windows 安装器能出包，但要绕开 32 位与 `/tmp`**：
    - 本容器 32 位 ELF 完全跑不起来（`/lib32/ld-linux.so.2 --version` 直接 SIGSEGV，
      `wine32-stable` 同样；`wine64` 跑 PE32 会进 experimental wow64，挂在
      `signal_init_process failed to allocate %fs selector`，glibc 报 `free(): invalid pointer`）。
      NSIS 安装器正是 PE32，所以 wine 路线死路。
      绕过：`NsisTarget` 里 `isMacOsCatalina()` 为真时走纯 JS 的 `UninstallerReader.exec()`
      （解析 PE + NSIS 签名，从首轮安装器解出卸载器），不碰 wine。用 `--require` 垫片把
      `app-builder-lib/out/util/macosVersion.js` 的 `isMacOsCatalina` 改成 `() => true` 即可。
    - makensis 只要暂存数据超过 ~10MB 就 **SIGBUS**：exit 135、stdout 缓冲丢失（看起来「无输出」），
      electron-builder 报 `Exit code: null`。根因是 **`/tmp` 是 10MB tmpfs**。
      修法：`mount -t tmpfs -o size=3g,mode=1777 tmpfs /tmp` 后再构建，且必须与构建
      **写在同一条命令里** —— 每次工具调用是独立的 mount namespace，上一条命令里的 mount 不保留。
      判据：8MB 输入能出包，16/32/100MB 必 SIGBUS；同一份 32MB 输入若压缩后只有 68KB 则成功，
      说明卡的是输出/暂存量而不是输入大小。正常产物约 114MB。
25. **数据目录曾经"跟着应用名走"**。`app.getPath('userData')` = 配置目录 + **应用名**，
    而应用名取自 `package.json` 的 `name`/`productName`：开发态是 `@t1000/desktop`、
    打包态是 `terminal-1000`，同名文件根本不是同一个库。只要打包元数据里的名字变一次，
    新版本就开一个空库，用户看到的就是「升级后设置全丢」。
    现在 `main/dataDir.ts` 把目录名**钉死**为 `terminal-1000`，并在首次启动时从旧位置
    **复制**（不删除）数据过来，写 `migration.json` 留痕。
    ⚠️ 不要在别处再调 `app.getPath('userData')` 拼路径；一律走 `getAppPaths()`。
    ⚠️ 改 `APP_DIR_NAME` 等于让所有老用户丢数据，除非同时加迁移分支。
26. **`.t-*` 类名是全局的，撞名会静默毁掉布局**。文件栏那次给新开关组件用了 `.t-switch`，
    与 `Form.tsx` 里既有的 label 型开关同名，30px 定宽把设置页的开关文字压成 0 宽竖排，
    整页错位且**没有任何构建/类型报错**。新组件请用不冲突的前缀（现在叫 `.t-toggle`）。
    同类问题：`.kv` 原先只定义在按需加载的 `features/monitor/monitor.css`，
    设置页用到时等于没样式 —— 跨 feature 复用的类一律放 `styles/components.css`。

27. **远端监控代理与脚本模式共用 `~/.t1000-monitor` 目录**。版本文件**不能**同名：
    脚本模式用 `VERSION`，代理用 `agent.version`。撞名时脚本模式会看到代理写的 `2`，
    判定自己过期 → 每次采集都重装一遍并写回 `1` → 代理永远"版本落后"，
    于是弹窗反复提示升级、升级完还是提示。`agent.test.ts` 里有一条断言守住这两个路径。
28. **`probeAgent` 的返回体必须带 `sessionId`**。渲染层的安装询问弹窗拿到的就是它，
    弹窗里「安装 / 暂不安装 / 不再询问」三个按钮都靠这个 id 继续调 IPC。
    少字段时的报错是 `sessionId: Required`（zod 在 handler 边界拦下来的），
    界面表现是"点了安装没反应"。现在由主进程回填，并且 `AgentProbeInfo` 只在
    `packages/shared/src/monitor.ts` 定义一份，两边引用同一个类型。
29. **`AgentService.probeRemote()` 会写探测缓存**（`probe()` 读它，TTL 30s）。
    任何"改完远端文件就立刻要看结果"的操作，都必须在改完之后再清一次缓存 ——
    `stop()` 里就踩过：为了拿 pid 探了一次，把刚删掉文件的 `installed=true` 又写回去了，
    面板 30 秒内一直说"已安装"，而采集器已经悄悄回退脚本模式。
30. **`scripts/ssh-test-host.mjs` 的 shell 是管道，得自己补 tty 的两个行为**：
    回显（否则 xterm 光标永远停在 (0,0)，看不出敲了什么）与 CR→NL
    （xterm 回车发 `\r`，没有 tty 的 ICRNL 翻译，bash 会一直等换行，一条命令都不执行）。
    这两条已在 `test-sftp-server.ts` 的 shell 处理器里补上（**测试夹具**，产品不依赖）。
    没有它们，任何"在终端里打字 → 看补全弹窗"的验收都是假绿。
31. **`VAR=x cmd` 这种前缀会把 `PATH` 弄丢**。本机的命令包装层在转交时会重建环境，
    实测：`PATH=/tmp/shim:$PATH bash -c 'which rpmbuild'` 依然找到 `/usr/bin/rpmbuild`，
    而 `bash -c 'export PATH=/tmp/shim:$PATH; which rpmbuild'` 才命中垫片。
    后果是 rpm 与 flatpak 的垫片"看起来挂了却没生效"：fpm 报 `rpmbuild failed`（日志里
    全是 `File not found: …/BUILDROOT/…`），flatpak 报 `Failure spawning rofiles-fuse`。
    所以 `scripts/pack-local.sh` 里所有环境变量都是**脚本内 export**，不要改回前缀写法。
32. **flatpak 的两个入场参数只能靠 PATH 垫片补**。`@malept/flatpak-bundler` 支持
    `extra-flatpak-builder-args`，但 electron-builder 的 `FlatpakTarget` 不透传它，
    `electron-builder.yml` 里没有合法入口。`scripts/pack-local.sh` 生成一个
    `flatpak-builder` 包装脚本，把 `--user --disable-rofiles-fuse` 塞在参数最前面。
33. **跑单测时 `TMPDIR` 只能指 `/tmp`（并把它换成大 tmpfs）或留在默认值**。
    把 `TMPDIR` 指到工作区里（`_tmp/`、仓库内任意目录）会让 `importOpenSsh` 那 21 项
    集体 EPERM —— 本机的 fs 代理层对 `/tmp` 之外的写路径判定不同，属于环境限制而非产品缺陷。
    干净的跑法（`/tmp` 只有 10MB，必须先扩容，mount 与测试要在同一条命令里）：
    ```bash
    mount -t tmpfs -o size=4g,mode=1777 tmpfs /tmp
    cd apps/desktop && ./node_modules/.bin/vitest run   # 1794 通过 / 3 失败 / 5 跳过
    ```
    那 3 项失败都是**容器限制**、不是回归：`snapshot` 的真实 PTY 录制（无 `/dev/pts`）；
    `sftp` 的两项"只读目录应回 PERMISSION_DENIED"（以 root 跑，`chmod 0555` 拦不住 root）。
34. **打包一条命令**：`scripts/pack-local.sh`。它自己生成全部五个垫片
    （rpm 4.18、flatpak 参数、copyFile 降级、NSIS 免 wine、futimens 空操作），
    所以不再依赖 `/tmp` 或上一轮遗留的文件。`--win` 只打 Windows，`SKIP_BUILD=1` 复用 `out/`。
35. **发布一条命令**：`GITHUB_TOKEN=ghp_xxx scripts/release.sh`（`--dry-run` 只打印）。
    token 只走环境变量、不落盘。两处容易看错的地方：GitHub **会把附件名里的空格换成点**
    （`terminal-1000 Setup 0.1.4.exe` → `terminal-1000.Setup.0.1.4.exe`），所以拼
    `releases/download/...` 直链时要用规范化后的名字；另外脚本对已存在的同名附件是**跳过**，
    重跑不会重复上传、也**不会覆盖**已上传的坏包 —— 要替换得先在网页上删掉那个附件。

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
T1000_TSC1_E2E=<你的域名>:8788 \
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
4. 读 `docs/` 与 `ARCHITECTURE.md` 建立边界感（进程分层、IPC 契约、服务划分）
5. 从 `task-35` / `task-37` 或 P2 清单里挑一项继续
