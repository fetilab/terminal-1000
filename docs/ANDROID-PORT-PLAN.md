# 安卓平板端移植方案（Android Tablet Port Plan）

> 目标：**功能不缩水、效果不打折**。这份文档先定架构，再定里程碑；
> 末尾列四个必须由产品/技术负责人拍板的决策点。

## 1. 现状盘点（方案的事实依据）

| 层 | 体量 | 平台耦合度 |
|---|---|---|
| 主进程 `apps/desktop/src/main` | 37,500 行 TS | 低。Electron 只出现在 **10 个文件**（窗口/托盘/热键/剪贴板/对话框/更新器） |
| 渲染层 `apps/desktop/src/renderer` | 32,449 行 TS/TSX | **零**。无 `node:`、无 `electron`、无 `process.platform` 分支 |
| 契约层 `packages/shared` | 2,776 行 | 零 |
| 测试 | 27,101 行（1,862 个用例） | 协议/存储/渲染层用例不依赖 GUI，可直接复用 |

关键事实：

1. **渲染层是干净的**：所有能力都经 `window.t1000.invoke(domain, action, payload)` 与
   `.on(event, listener)` 两个方法。换掉 preload 桥，32k 行 UI 原样跑。
2. **主进程只有 10 处 Electron 依赖**：`app / BrowserWindow / ipcMain / dialog / shell /
   clipboard / Tray / Menu / nativeImage / globalShortcut / powerMonitor / screen`。
3. **加密零原生依赖**：主密码派生是 Node 内置 `scryptSync`，字段加密是 `crypto`
   的 AES-256-GCM（不是 argon2）。整个 store 域在 Node-on-Android 上可直接跑，
   **数据库格式与桌面端完全一致**（迁移/备份/云同步天然互通）。
4. **原生模块只有两个**：`better-sqlite3`、`node-pty`。其余全纯 JS
   （`ssh2`、`socks`、`zod`、`iconv-lite`），WASM 部分（`kitty-vt-wasm` 自研 C→WASM）
   与 WebGL2 终端引擎在 Android WebView 里可直接运行。
5. **外部依赖只有一处**：RDP 拉起 `xfreerdp` 独立窗口 —— Android 上不存在该二进制，
   必须换实现（方案见 §5.4）。
6. **监控 agent 是静态 Go 二进制**（linux/arm64 已有），Android arm64 可执行，
   但受 Android 10+ 的 W^X 限制（不能从可写目录 exec）——需以 `lib*.so` 形式随包。

## 2. 路线对比

| 维度 | A. Node 运行时 + WebView | B. Tauri v2 + Rust 后端 | C. Kotlin/Compose 全新前端 |
|---|---|---|---|
| 后端复用 | **≈90%**（3.3 万行现成） | 0%（3.7 万行重写） | 0% |
| 前端复用 | **100%**（32k 行原样） | 100%（WebView） | 0%（重写） |
| 终端引擎 | 现成（WebGL2 + WASM VT） | 现成 | 需重建（最难点） |
| 工作量（到功能对等） | **6–8 周** | 4–6 个月 | 5–8 个月 |
| APK 体积 | ≈130–150 MB（arm64 单 ABI，含 Alpine rootfs） | ≈18 MB | ≈25 MB |
| 原生能力（SAF/后台/通知） | 需写 Kotlin 桥（中等） | 插件生态现成（优） | 最优 |
| 长期维护风险 | 嵌入式 Node 版本需自行跟进（社区已有 22/24 构建） | 低 | 低 |
| 测试资产复用 | **全部**（协议/存储/UI 逻辑） | 仅协议向量 | 无 |

**决策：路线 A（已拍板，2026-11-24）。** 理由：功能对等速度最快、回归风险最低，
且**架构上不锁死**——只要把平台能力抽成适配层（§5.2），未来若需要路线 B，
可以逐域替换后端而不动 UI。

> 说明：官方 `nodejs-mobile` 停留在 Node 18（有 16KB page size 修复），但社区已产出
> Node 22 / 24 的 libnode 构建（`OpenFlun/nodejs-mobile`、`TryQuiet` 的 24.22.1 构建，
> 均为 arm64 + 16KB 对齐）。我们用 Node 22 LTS 构建，脚本化源码编译，产物入库校验哈希。

## 3. 目标架构

```
┌───────────────────────────────────────────────────────────┐
│ Android App (Kotlin, minSdk 26 / target 最新)              │
│                                                           │
│  ┌─────────────────────┐      ┌────────────────────────┐  │
│  │ Activity + WebView  │◄────►│  Bridge (Kotlin)       │  │
│  │ React 渲染层(原样)   │ JSON │  · 127.0.0.1 回环 WS    │  │
│  │ WebGL2 终端引擎      │  WS  │  · 一次性 token 鉴权    │  │
│  └─────────────────────┘      │  · SAF / 通知 / 分享     │  │
│                               └──────────┬─────────────┘  │
│                                          │ JNI             │
│  ┌───────────────────────────────────────▼─────────────┐  │
│  │ libnode (Node 22, arm64)                            │  │
│  │  · 现有 main 进程 bundle（3.3 万行，几乎原样）        │  │
│  │  · platform/ 适配层替换 Electron API                 │  │
│  │  · better-sqlite3 / node-pty（NDK 重编译）           │  │
│  └─────────────────────────────────────────────────────┘  │
│                                                           │
│  ForegroundService（会话保活 + 通知）                       │
└───────────────────────────────────────────────────────────┘
```

### 3.1 桥接协议（复用现有契约，零改动）

- 桌面：`preload/index.ts` 用 `ipcRenderer.invoke` + `ipcRenderer.on`。
- Android：新增 `apps/mobile/src/bridge/`，把同一份 `invoke(domain, action, payload)` /
  `on(event, listener)` 实现为 **loopback WebSocket**（`127.0.0.1:<随机端口>`，
  握手带一次性 token，仅监听回环、进程内启动即关闭外部访问）。
- 渲染层只新增一个 `bridge.ts` 入口做运行时分发：`window.t1000 ?? connectWsBridge()`。
  **不改任何业务组件。**
- 事件流（`SSH_DATA`、`TELNET_DATA`、`MONITOR_*`）天然适合 WS；批量参数沿用现有
  `OutputBatcher`（16ms / 256KB），避免高频小包。

### 3.2 平台适配层 `platform/`（必须新建，这是移植的主工作量）

把 10 处 Electron 依赖抽成接口，桌面实现保留、Android 另写一份：

| 能力 | 桌面实现 | Android 实现 |
|---|---|---|
| 剪贴板 | `clipboard` | Kotlin `ClipboardManager`（经桥） |
| 文件选择/保存 | `dialog.showOpenDialog` | SAF `ACTION_OPEN_DOCUMENT`（Kotlin） |
| 打开外部链接/文件 | `shell.openExternal` | `Intent.ACTION_VIEW` + `FileProvider` |
| 通知 | `Notification` | `NotificationCompat` + 渠道 |
| 窗口/焦点 | `BrowserWindow` | 无（Activity 生命周期） |
| 托盘 | `Tray` | 无（常驻通知替代） |
| 全局热键 | `globalShortcut` | 外接键盘捕获（`onKeyDown` 兜底） |
| 电源状态 | `powerMonitor` | `PowerManager`（Doze 白名单引导） |
| 自动更新 | `autoUpdater` | 下载 APK + `PackageInstaller` |
| 系统信息 | `os.*` | `Build.*`（Kotlin 侧） |

### 3.3 目录规划

```
apps/
├── desktop/            # 现状不动
└── android/
    ├── app/            # Kotlin 壳：Activity、WebView、Bridge、Service、SAF
    │   └── src/main/jniLibs/arm64-v8a/libnode.so
    ├── node/           # 打包进 assets 的 Node 侧产物
    │   ├── dist/       # main bundle（由 electron-vite 的 node target 复用构建）
    │   ├── node_modules/  # better-sqlite3.node / pty.node（arm64）
    │   └── assets/     # kitty-vt.wasm、背景脚本、agent 二进制
    └── scripts/        # libnode 构建、NDK 重编译、APK 打包、CDP 验收
```

## 4. 功能对等清单（验收基线）

| 域 | 桌面现状 | 安卓方案 | 风险 |
|---|---|---|---|
| 本地终端 PTY | node-pty + 用户 shell | node-pty(NDK) + **proot/Alpine**（回退系统 sh） | 中（见 §5.2） |
| SSH | ssh2（含跳板/代理/端口转发/主机会话复用） | 原样（纯 JS） | 低 |
| SFTP + 本地栏 | ssh2 sftp + `node:fs` | SFTP 原样；本地栏走 SAF 或应用沙盒 | **中高**（见 §5.1） |
| Telnet | 自研 + 自动登录 | 原样 | 低 |
| VNC | 自研 RFB over `net` | 原样 | 低 |
| RDP | 外部 xfreerdp 独立窗口 | IronRDP-WASM + 本机 TCP↔WS 桥 | **高**（见 §5.4） |
| 隧道转发 | `net` 监听/连接 | 原样（回环免 root） | 低 |
| 监控 | Go agent 推送 + 解析 | agent 以 `lib*.so` 随包，从 `nativeLibraryDir` exec | 中 |
| 补全引擎 | 6k 行，读系统文件 | 原样（Android 文件树不同，需补 toybox 路径表） | 中 |
| AI 助手 | HTTPS + 流式 | 原样（前台服务保活） | 低 |
| 云同步 | 自建 blob API | 原样 | 低 |
| 会话录制 | .rec 文件 | 原样（应用私有目录） | 低 |
| MCP 服务 | 本机 HTTP | 原样（回环可监听） | 低 |
| 设置/备份/主密码 | SQLite + scrypt | **格式完全一致** | 低 |
| 快速命令/便签/高亮 | 纯逻辑 | 原样 | 低 |
| 外观（模糊/透明度） | CSS + `backdrop-filter` | WebView 支持；性能需实测降级策略 | 中 |

## 5. 安卓特有难题与解法

### 5.1 本地文件访问（SFTP 本地栏、导入密钥、导出备份）
Android 10+ 分区存储：不能用 `node:fs` 随便读 `/sdcard`。
- **主路径**：Kotlin 侧接 SAF（`DocumentFile`），以「虚拟文件系统」桥暴露给 node：
  `list/read/write/rename/delete/stat` 六个原子操作，sftp 的本地 backend 换成该实现。
- **次路径**：应用私有目录（`filesDir`）全功能可用，用于会话录制、备份导出。
- 拒绝方案：`MANAGE_EXTERNAL_STORAGE`（Play 审核高风险、用户观感差）。

### 5.2 本地 Shell 底座：内置 proot + Alpine（已拍板）

**目标**：与桌面端体验一致 —— bash/zsh/git/python/apk 包管理全都能用。

构成与体积预算（arm64 单 ABI）：

| 组件 | 体积 | 说明 |
|---|---|---|
| `libproot.so`（随 jniLibs） | ≈1 MB | C 实现，需 NDK 源码编译（F-Droid 要求，见 §7） |
| `alpine-minirootfs`（assets 内 tar.gz） | ≈4 MB | 首次启动解压到 `filesDir/rootfs`（≈10 MB） |
| 预装工具集（bash/coreutils/git/openssh/nano/python-mini） | ≈70 MB | 打包时用 apk 预装后重新压成 rootfs 镜像 |
| 合计新增 | **≈75–90 MB** | APK 总体积 ≈130–150 MB |

实现要点：
1. **解压时机**：首次进入本地终端时解压（放前台服务里，带进度），失败可重试；
   成功后写版本戳，升级时按戳重建（保留用户 `$HOME` 覆盖层）。
2. **执行方式**：`proot --link2symlink -0 -r <rootfs> -b /dev -b /proc -b /sys
   -b /storage/emulated/0:/sdcard -w /root /usr/bin/env -i HOME=/root
   PATH=/usr/local/sbin:... /bin/bash -l`。
3. **进程启动**：node-pty 直接 spawn `libproot.so`（exec 自 `nativeLibraryDir`，
   绕开 Android 10+ 的 W^X 限制，与监控 agent 同一手法）。
4. **持久化**：`$HOME` 与 `/etc` 映射到应用私有目录的覆盖层，升级 rootfs 不丢配置。
5. **降级**：proot 启动失败（极少数 ROM 限制 ptrace）时自动回退到 `/system/bin/sh`，
   并在设置页说明原因，而不是让本地终端直接不可用。
6. **浏览器/包管理**：`apk add` 走 Alpine 官方源，需应用具备网络权限即可；
   下载的包落在 rootfs 内，受应用存储配额约束。

替代路径（不选，备查）：渐进下载 rootfs 体积最优但多一套下载链路；复用 Termux
零体积但体验割裂、卸载即失效。

### 5.3 终端交互（触摸）
- 现有的 WebGL2 引擎保留，新增触摸层：单指滚动惯性、双指缩放字号、
  长按选区 + 拖动调整把手、双击选词、三指粘贴（可配）。
- 现有右键菜单 → 长按菜单，复用同一 `ContextMenu` 组件。
- 悬停类交互（终端链接提示、工具条 hover）改为「点击展开」。

### 5.4 RDP（唯一必须换实现的协议）
- 方案：**IronRDP-WASM**（Rust→WASM，画 Canvas、支持剪贴板与文件传输），
  网络走本机 Node 的 `net` 做 TCP↔WS 桥（RDCleanPath），无需外部进程。
- 收益：桌面端后续也可切到同一实现，RDP 不再依赖 `xfreerdp` 安装。
- 代价：多 3~5 MB WASM；NLA/CredSSP 边角兼容需真机回归。

### 5.5 后台保活与省电
- `ForegroundService`（`dataSync|connectedDevice`）+ 常驻通知显示活跃会话数。
- 用户引导加入电池优化白名单；Doze 下用 `setExactAndAllowWhileIdle` 心跳兜底。
- 系统杀进程后：会话不可恢复（与桌面关机一致），但**连接配置与布局持久化**。

### 5.6 监控 agent 的 W^X 限制
Android 10+ 禁止从可写目录 exec。解法：agent 命名 `libt1000agent.so` 放入
`jniLibs/arm64-v8a/`，安装后位于只读 `nativeLibraryDir`，可正常 exec。

### 5.7 设备形态：平板横屏专享（已拍板）

- 锁定 `sensorLandscape`，保留桌面端三栏布局与信息密度。
- 视口覆盖 1280×800 → 2960×1848（8–13 寸）；最小宽度 960dp 时侧栏折叠为图标条
  （复用桌面端现有折叠能力，不做新布局）。
- 双输入：外接键盘走现有热键表（`onKeyDown` 捕获，替代 `globalShortcut`）；
  纯触控用软键盘扩展键条 + 长按菜单。
- 不做紧凑手机布局；竖屏提示旋转。

### 5.8 分发：自签 APK + F-Droid 双轨（已拍板）

- **主渠道（GitHub Release 自签 APK）**：应用内检查更新 → 下载 → `PackageInstaller`
  安装；版本号与桌面端同一套语义版本。
- **F-Droid 渠道**：提供纯开源构建配方（metadata/`fdroid build`），要求
  所有二进制可在其构建环境中从源码产出（见 §7 风险项），且不含任何追踪/闭源组件。
- 两套产物共用同一份代码，仅构建参数（签名、渠道标识）不同；CI 分别打包并各自冒烟。
- 签名：`keystore` 与口令走环境变量，不入库（与桌面端发布流程一致）。

## 6. 里程碑

| 阶段 | 内容 | 出口标准 |
|---|---|---|
| **M0 骨架**（≈1 周） | Kotlin 壳 + libnode + WS 桥 + 渲染层跑通首屏 | 平板启动看到界面，设置读写落库 |
| **M1 终端**（≈2 周） | PTY(NDK) + **proot/Alpine rootfs** + 触摸/软键盘 + 外观 | `bash -l` 可用，git/python 可跑；滚动/选区/粘贴全通 |
| **M2 协议栈**（≈1.5 周） | SSH/SFTP/Telnet/VNC/隧道 + 监控 agent | 与桌面同一套会话配置可互导，全部连通 |
| **M3 文件与安全**（≈1 周） | SAF 本地栏、主密码、备份导入导出 | 备份文件桌面↔安卓双向可读 |
| **M4 RDP + 收尾**（≈1.5 周） | IronRDP-WASM + 通知/分享/应用内更新 | 四个协议全绿 |
| **M5 打磨 + 双轨发布**（≈1.5 周） | 性能/电量/外接键盘 + F-Droid 构建配方 | 自签 APK 与应用商店配方均能出包，24h 稳定性 |

验收方式沿用桌面：**CDP 探针**（WebView 可远程调试）+ 真机/模拟器脚本化回归，
把 `_tmp/*-verify.mjs` 那套方法迁移过来，形成安卓侧 E2E 基线。

## 7. 风险清单

| 风险 | 影响 | 缓解 |
|---|---|---|
| libnode 版本/ABI 与原生模块不匹配 | 启动即崩 | 锁定 Node 22 + NAPI 版本，CI 校验 `process.versions` |
| better-sqlite3 / node-pty 的 Android 编译 | 阻塞 M1 | 先用 Termux 补丁集验证，CI 固化 NDK 版本 |
| WebView 版本碎片（国产 ROM） | WebGL2/WASM 缺失 | 内置 Chromium 兜底不可行 → 降级 canvas 渲染 + 功能门禁提示 |
| SAF 抽象性能（大目录） | 文件栏卡顿 | 分页 + 缓存 + 虚拟滚动（沿用现有列表组件） |
| RDP WASM 兼容性 | 部分 Windows 连不上 | 真机矩阵回归；保底提示改用其他协议 |
| 后台被杀 | 长任务中断 | 前台服务 + 白名单引导 + 明确文案 |
| **F-Droid 预编译二进制政策** | 无法上架 F-Droid | `libnode.so`、`libproot.so`、Alpine rootfs 均在 F-Droid 构建环境从源码产出：提供 `libnode` 源码构建脚本 + proot 源码（NDK 编译）+ rootfs 由 `apk` 源重建；若审核仍不接受 rootfs 预打包，则 F-Droid 版降级为系统 sh（并在应用内说明差异），自签版保留完整 proot |
| **proot 依赖 ptrace** | 少数 ROM 禁用 ptrace | 启动探测失败即回退系统 sh，设置页给出原因与替代方案 |
| **APK 体积（≈130–150MB）** | 用户下载门槛 | ABI 只发 arm64；rootfs 用 zstd 压缩；F-Droid 版可拆分为「基础包 + rootfs 扩展」 |

## 8. 已拍板的决策（2026-11-24）

| 决策 | 结论 |
|---|---|
| 技术路线 | **A：Node 运行时（libnode / Node 22 LTS）+ Android WebView**，复用现有 TS 后端与 React 界面 |
| 本地 Shell | **内置 proot + Alpine**：bash/zsh/git/python/apk 全可用；`$HOME` 用覆盖层持久化；失败回退系统 sh |
| 设备形态 | **平板横屏专享**：锁定横屏、三栏布局、外接键盘 + 触控扩展键条 |
| 分发 | **自签 APK（主）+ F-Droid（开源双轨）**；应用内更新走 `PackageInstaller` |

## 9. 开工前还需确认的实现级细节（M0 期间定即可，不阻塞启动）

1. **libnode 来源**：官方 18.20.4 + 16KB 修复 vs 社区 Node 22 构建。
   建议 Node 22（`OpenFlun/nodejs-mobile` 或 TryQuiet 同款构建），NDK r27 + 16KB 对齐。
2. **最低支持版本**：建议 `minSdk 26`（Android 8.0），`targetSdk` 跟随当年最新。
3. **ABI 策略**：仅 `arm64-v8a`（平板基本全是 arm64），模拟器单独出 x86_64 调试包。
4. **画质降级阈值**：WebView 无 WebGL2 时降级 canvas 渲染（引擎已支持），
   并在设置页提供「性能模式」开关（关背景模糊 / 关动态背景）。
5. **F-Droid 版功能差异**：见 §7 风险表最后一条，M5 前给出最终取舍。

## 10. 实施进度与平台踩坑记录（持续更新）

### 10.1 已完成（2026-11-25）

| 项 | 状态 | 证据 |
|---|---|---|
| Kotlin 壳 + libnode + 回环 WS 双通道 | ✅ | 真机（模拟器）启动到首屏，桥 `/ipc` 与 `/native` 均连通 |
| electron 替身（14 个 API） | ✅ | 主进程 3.7 万行零改动跑通 |
| node:sqlite 替代 better-sqlite3 | ✅ | 连接增删改查往返通过（加密字段亦通） |
| 渲染层复用（同一份 vite 产物） | ✅ | 全界面可见、React 挂载、kitty 引擎接管终端 |
| **本地终端 PTY** | ✅ | `libt1000pty.so`（bionic forkpty）+ node-pty 替身；输入/回显/resize/退出全通 |
| 设备级 E2E 探针 | ✅ | `node-host/scripts/verify-device.mjs` 20 项全绿 |

尚未做：proot + Alpine rootfs（当前只有 `/system/bin/sh`）、SSH/SFTP/VNC/RDP 真连、
SAF 文件栏、主密码与备份、外接键盘映射、arm64 真机回归。

### 10.2 三个必须记住的平台差异

1. **不要用 `gl_VertexID` 去索引常量数组**（`QUAD[gl_VertexID]`）。
   桌面 Chromium 正确，Android WebView（ANGLE + SwiftShader）上动态下标返回垃圾值，
   六个顶点全部塌到同一点 → 三角形退化 → **整个终端一个字都画不出来，且没有任何 GL 报错**。
   已验证：同一程序改成顶点属性传位置即正常。kitty 渲染器已改为算术计算角点。

2. **Android 应用进程的 SIGHUP 是 `SIG_IGN`，且 `execve` 会继承它**。
   Zygote/ART 忽略 HUP 防止意外退出；fork 出来的 shell 因此从第一条指令起就忽略 SIGHUP，
   `kill -HUP` 完全无效（表现为"点了关闭，终端一直挂着"）。
   修复：子进程 `execve` 之前，把 1..NSIG 全部 `sigaction(SIG_DFL)` 并清空信号掩码。

3. **`Page.captureScreenshot` 拍不到 WebGL 画布**。
   CDP 截图里终端永远是空白，但设备上一切正常。
   验证终端"有没有画出来"必须用 `adb exec-out screencap -p`，
   或者直接在该上下文里 `gl.readPixels`（同一任务内，`preserveDrawingBuffer:false` 会丢帧）。

### 10.3 工程约定

- **资产版本戳要带 `lastUpdateTime`**：只比 `versionName:versionCode` 时，
  开发期 `install -r` 会一直命中旧资产（改了 node-host 却在设备上看到老行为）。
- **pty 的关闭是三步阶梯**：信号 → 关 master fd（内核送 EOF/HUP）→ 1.5s 后 SIGKILL。
  只发信号不行，只关 fd 也不行（另一个线程阻塞在 read 上时 close 不生效）。
- **原生库预编译进 jniLibs**，不引入 CMake/externalNativeBuild：
  `scripts/build-pty.sh` 用 NDK clang 直接出 `.so`，两个 ABI 各一份。
- **调试包的 testhook 需要显式开关**（`-Pt1000TestHook=true`），不能按
  `FLAG_DEBUGGABLE` 自动开：testhook 会隔离数据目录，用户装上就觉得"存不住东西"。
