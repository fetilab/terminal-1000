# 自建同步后端部署指南

同步是可选功能：不部署就是纯本地应用。部署后**服务端只存密文**，密钥不出客户端。

本文按「单机 + 反代 + systemd」的中小规模场景写，把**必须注意的地方**列清楚；
具体的域名、路径、证书按你自己的环境替换。

---

## 1. 部署形态

| 项 | 说明 |
|---|---|
| 程序 | `server/` 源码直接部署，**零运行时依赖**（只需 Node ≥ 22） |
| 数据 | 一个本地目录（建议独立盘/独立分区），存账号、令牌、密文 blob |
| 服务 | 一个 systemd unit，`Restart=on-failure` |
| 端口 | `8787` 给反代用（**仅回环**）；`8788` 是 TSC/1 加密通道（可公网直连） |

目录布局示例（`$APP` / `$DATA` 自定）：

```
$APP/        # server/ 源码
$DATA/       # 数据目录（账号、令牌摘要、blob、身份私钥）
$DATA/identity.key   # TSC/1 服务端身份私钥，务必 0600
```

## 2. 监听地址：IPv6 主机必须绑 `::`

```
T1000_HOST=::     # 双栈「全接口」，等价于 IPv4 的 0.0.0.0
```

如果你的主机**域名只解析到公网 IPv6**，绑 `0.0.0.0` 会让服务看起来起来了、
却在 v6 上完全不可达。Node 在 `::` 上是双栈的，同时接受 v4 与 v6 连接。

## 3. 端口隔离：为什么必须做

反代场景下后端绑在 `::`，如果不加限制，`8787` 就会以**明文 HTTP** 暴露到公网 ——
登录口令在登录瞬间明文过网。

用**一张独立的 nft 表**把 8787 限制成仅回环可达（不动宿主已有的规则集）：

```bash
nft list table inet t1000_guard
#   tcp dport 8787 ip  saddr != 127.0.0.1 drop
#   tcp dport 8787 ip6 saddr != ::1     drop
```

出错时整体回滚一条命令：

```bash
systemctl stop t1000-port-guard   # 或 nft delete table inet t1000_guard
```

> 规则只匹配 8787，不影响同机上其它服务（443 上的反代等）。

## 4. 反向代理

任意支持 TLS 与 WebSocket 无关转发的反代都行（Nginx / Caddy / 面板网关 / 容器里的网关）。
要点：

1. 前端域名 → 你自己的域名，开启 TLS
2. 后端地址 → `http://127.0.0.1:8787`（或 `http://[::1]:8787`）
3. 请求体上限 **≥ 256MB**（同步快照可能较大；后端自身上限由 `T1000_MAX_BODY_BYTES` 控制，默认 256MB）
4. 带上 `X-Forwarded-For`、`X-Forwarded-Proto`

### `T1000_TRUST_PROXY` 什么时候能开

反代之后后端看到的连接都来自 `127.0.0.1`。不采信 `X-Forwarded-For` 的话，
限流会按**同一个 IP** 计数 —— **一个攻击者打几次失败就能把全体用户锁死**。

但只有**确认该端口仅对反代开放**（第 3 节的隔离到位）时才能开：

- ✅ 端口仅回环可达 → 外部无法直连，也就无法伪造 `X-Forwarded-For`
- ❌ 端口可被直连 → 伪造 `X-Forwarded-For` 即可绕过限流，**比不开更糟**

## 5. 客户端配置

应用内「设置 → 同步」填三样：

- **服务地址**：`https://<你的域名>`
- **登录口令**：访问同步服务用（与数据加密无关）
- **同步口令（仓库密码）**：加解密云端数据。**新设备只需这一个口令**即可解密云端数据；
  忘记它 = 云端数据无法恢复（服务端也帮不了你，这是零知识的代价）

## 6. 安全性质（为什么这样暴露是可接受的）

同步载荷由**客户端零知识加密**：服务端只存密文、**不持有解密密钥**
（密钥由「同步口令 / 仓库密码」派生，只在本机）。即使服务器被完全攻破：

- ✅ **数据内容不会泄露**（拿到的是无法解开的密文）
- ⚠️ 登录口令仍在登录瞬间经过传输链路 → **必须走 TLS 反代或加密通道**
- ⚠️ 令牌被窃取者可**篡改/删除**密文（数据丢失风险，非泄密）

已实现的应用层防护：

| 防护 | 说明 |
|---|---|
| 口令 scrypt + 每账号独立 salt | 账号不存在时也做等价开销派生，**防响应时间枚举用户** |
| 登录失败不区分原因 | 「用户不存在」与「口令错」返回完全相同的响应体 |
| **请求限流 + 失败锁定** | 按 `IP` 与 `IP+账号` 双 key；连续失败指数退避，上限 1 小时 |
| 令牌只存 sha256 摘要 | 存储泄露也无法直接使用；30 天过期；可即时撤销 |
| 用户名与 blob 名哈希后落路径 | 从根上堵死 `../` 穿越 |
| 多租户隔离 | B 既看不到也读不到 A 的 blob（即使知道名字） |
| 安全响应头 | `nosniff` / `DENY` / `no-referrer` / `no-store`；经反代时附 HSTS |
| 原子写 | 临时文件 + rename：中途断电宁可保留旧版本，不写出半个文件 |
| 访问日志不记请求体 | 避免把密文或口令写进日志；认证事件只记 IP + 用户名 |

## 7. 运维命令

```bash
systemctl status terminal-1000-sync
journalctl -u terminal-1000-sync -f          # 实时日志（含 AUTH 审计行）
systemctl restart terminal-1000-sync         # 改配置后必须 restart

# 限流参数（按需在 unit 里覆盖；默认已够严格）
#   T1000_RATE_WINDOW_MS=60000    滑动窗口
#   T1000_RATE_MAX_ATTEMPTS=10    窗口内最大尝试
#   T1000_LOCK_THRESHOLD=5        连续失败达几次开始锁定
#   T1000_LOCK_BASE_MS=60000      首次锁定时长（之后翻倍）
#   T1000_LOCK_MAX_MS=3600000     锁定上限

# 端口隔离
nft list table inet t1000_guard
systemctl restart t1000-port-guard
```

## 8. 上线自检清单

| 检查项 | 期望 |
|---|---|
| 服务状态 | `active` + `enabled`；`kill -9` 后能自动拉起 |
| 监听 | `*:8787` 双栈（v4 + v6 均可达） |
| 健康检查 | `{"ok":true,...}`（回环 v4 与 v6 都能通） |
| 安全响应头 | `nosniff` / `DENY` / `no-referrer` / `no-store` / HSTS 全部返回 |
| 限流 | 连续 5 次失败后第 6 次返回 **429 + `retry-after: 60`** |
| 限流隔离性 | 换一个客户端 IP 仍是 401（**未被误锁**） |
| 端口隔离 | 从外部访问 `:8787` 被丢包；回环正常 |
| 开机自启 | 端口隔离 unit = `enabled` |
| 数据落盘 | 重启后 blob 仍在，且旧版本不被半个文件覆盖 |

### 部署时容易踩的坑

- **同步只上传了一部分文件**：漏一个 `import` 就会以
  `SyntaxError: does not provide an export named ...` 启动失败。
  部署后**逐个文件校验关键符号**，不要假设同步成功。
- **改动被静默覆盖**：某些远端同步/镜像手段会把旧版本拉回本地。
  规避：**部署前先 commit**，或用版本化的发布包而不是「直接改线上文件」。

---

## 9. TSC/1 加密通道（可选）

### 为什么需要它

后端要**直连公网**（无证书、或 443 不可用）时，明文 HTTP 会让登录口令与会话令牌裸奔。
数据本身已是零知识密文，所以要保护的是**认证链路**。
协议见 [`SYNC-SECURE-CHANNEL.md`](SYNC-SECURE-CHANNEL.md)。

### 配置

| 项 | 值 |
|---|---|
| 端口 | **8788**（独立于 8787） |
| 监听 | `::` |
| 身份私钥 | `$DATA/identity.key`（0600） |
| 身份指纹 | `node server/src/tsc1/identity.js --fingerprint` 查看 |

**为什么必须独立端口**：8787 是给反代用的、且「仅回环」正是 HTTP 侧
`T1000_TRUST_PROXY=1`（采信 X-Forwarded-For）得以安全的前提；
而加密通道必须能公网直连。放同一端口就得放开 8787，等于同时废掉
HTTP 的明文口令保护与 XFF 可信前提。**该端口前面没有反代，因此绝不采信 XFF。**

用 drop-in 启用（不改原 unit，便于回滚）：

```ini
# /etc/systemd/system/terminal-1000-sync.service.d/tsc1.conf
[Service]
Environment=T1000_TSC1_ENABLE=1
Environment=T1000_TSC1_PORT=8788
Environment=T1000_TSC1_HOST=::
```

回滚：删掉该文件 → `systemctl daemon-reload && systemctl restart terminal-1000-sync`

### 验收（可真机复跑）

```bash
cd apps/desktop
T1000_TSC1_E2E=<你的域名>:8788 pnpm vitest run src/main/services/sync/channel.remote.test.ts
```

覆盖：探测身份拿指纹（与服务端日志一致）→ 注册 → 推送 → **拉回逐字节一致**
→ **无令牌仍 401**（加密不替代认证）→ 指纹不符被拒。

### 客户端接线

- 设置：`sync.transport: 'tsc1'`（**显式**，规范 §3.3.1 禁止自动回退）+ `sync.pin`
- 信任流程：`sync.inspectServer`（只握手拿指纹）→ 用户带外核对 → `sync.trustServer`
- **非回环 + 明文 HTTP 会被直接拒绝**（`PLAINTEXT_NOT_ALLOWED`）
