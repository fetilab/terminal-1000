# terminal-1000 同步后端 —— 部署记录（192.168.1.187）

## 部署内容

| 项 | 位置 |
|---|---|
| 程序 | `/mnt/hdd-btrfs/terminal-1000/app/`（源码直接部署，**零运行时依赖**） |
| 数据 | `/mnt/hdd-btrfs/terminal-1000/data/`（1TB 机械盘） |
| 服务 | systemd `terminal-1000-sync.service`（enabled，`Restart=on-failure`） |
| 端口隔离 | systemd `t1000-port-guard.service`（enabled，开机自动生效） |
| 访问路径 | 反代域名 `https://mc.mosfetech.de5.net` → 本机 `127.0.0.1:8787` |

## 网络与监听

服务器**域名只解析到公网 IPv6**（`2409:8a20:445:66c0:802b:b587:f37:ad67`），
但主机本身同时有 IPv4 私网地址。因此：

- `T1000_HOST=::` —— IPv6 下的"全接口"（等价于 IPv4 的 `0.0.0.0`）。
  **注意：仅当主机真的只有 IPv6 时 `0.0.0.0` 是无效的**，必须用 `::`，
  否则服务看起来启动了却在 v6 上完全不可达。
- Node 在 `::` 上是**双栈**的，同时接受 IPv4 与 IPv6 连接。

## 端口隔离（重要）

`t1000-port-guard.service` 通过**一张独立的 nft 表**把 8787 限制为**仅回环可达**：

```bash
nft list table inet t1000_guard
#   tcp dport 8787 ip  saddr != 127.0.0.1 drop
#   tcp dport 8787 ip6 saddr != ::1     drop
```

**为什么必须隔离**：后端绑在 `::`，不加限制就会以**明文 HTTP** 暴露到公网 ——
登录口令会在登录瞬间明文过网。正常访问一律走反代（本机回环转发）。

**为什么用独立表**：完全不触碰宿主、Docker、Lucky 已有的规则（`/goodluck/lucky.conf` 那套）。
出错时一条命令整体回滚：

```bash
systemctl stop t1000-port-guard   # 或 nft delete table inet t1000_guard
```

> 已确认隔离规则只匹配 8787，**不影响 Lucky（443）与其它服务**。
> （Lucky 对裸 IP 访问 443 无响应是它按域名/SNI 路由的既有行为，与此规则无关。）

## 反向代理：在 Lucky 里加一条规则

反代软件是 **Lucky**（跑在 Docker 里：`/app/lucky -runInDocker -c /goodluck/lucky.conf`），
它是 GUI 管理的，**不要去手改它的配置文件**。请在 Lucky 的 Web 界面里：

1. 进入 **反向代理 → 添加规则**
2. **前端域名**：`mc.mosfetech.de5.net`
3. **后端地址**：`http://127.0.0.1:8787`（或 `http://[::1]:8787`，两者都可达）
4. 开启 **TLS**（Lucky 可自动申请/续期证书）
5. 建议同时设置：
   - 请求体上限（`client_max_body_size` 等价项）→ **≥ 256MB**（同步快照可能较大；
     后端自身上限由 `T1000_MAX_BODY_BYTES` 控制，默认 256MB）
   - 转发头：`X-Forwarded-For`、`X-Forwarded-Proto`（Lucky 通常默认带上）

### 反代生效后：可选地开启真实客户端 IP 统计
反代之后，后端看到的连接都来自本机回环，**限流会按同一个 IP 计数**
（一个滥用者可能影响所有人 —— 是可用性问题，不是绕过）。

若希望按真实客户端 IP 限流，在 unit 里加上：
```
Environment=T1000_TRUST_PROXY=1
```
⚠️ **前提是 8787 必须只对反代开放（本部署已满足）**。
如果 8787 还能被直连，`X-Forwarded-For` 可被伪造 → 攻击者每次换个假 IP 就绕过了限流，
**比不开更糟**。

## 安全性质（为什么这样暴露是可接受的）

同步载荷由**客户端零知识加密**：服务端只存密文、**不持有解密密钥**
（密钥由「同步口令 / 仓库密码」派生，只在本机）。因此即使服务器被完全攻破：

- ✅ **数据内容不会泄露**（拿到的是无法解开的密文）
- ⚠️ 登录口令仍在登录瞬间经过传输链路 → **必须走 TLS 反代**（本部署路径即如此）
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

## 运维命令

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

## 客户端配置（terminal-1000 应用内）

「设置 → 同步」填服务地址与两个口令：

- **服务地址**：`https://mc.mosfetech.de5.net`
- **登录口令**：用于访问同步服务（与数据加密无关）
- **同步口令（仓库密码）**：用于加解密云端数据。**新设备只需这一个口令**即可解密云端数据；
  忘记它 = 云端数据无法恢复（服务端也帮不了你，这是零知识的代价）

## 已知边界

- RDP 走外部 `xfreerdp` 进程（画面在独立窗口），非参考产品那种"嵌进自己窗口"
- VNC 的 `scaleViewport` / `clipViewport` 由渲染层实现
- 未验证项：SFTP 真实读写、VNC/SSH 真实内容录制的端到端（本机缺可连主机/网络设备）
