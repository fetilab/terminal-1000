import { dirname, join } from "node:path";
import { z } from "zod";
import { A as AppError, c as createLogger, d as unregisterSession, u as unregisterWritable, e as publishSessionData, f as registerSession, r as registerWritable, b as listSessions, h as getCwd, E as Events } from "../index.js";
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { Client } from "ssh2";
import { randomUUID, createHash } from "node:crypto";
import { O as OutputBatcher } from "./output-batcher-DY0csVMw.js";
import { Socket } from "node:net";
import { connect } from "node:tls";
import "electron";
import "node:child_process";
import "node:url";
import "better-sqlite3";
import "node:os";
import "node:fs/promises";
function createProxySocket(proxy, targetHost, targetPort) {
  const parsed = parseProxyUrl(proxy);
  return new ProxyTunnel(parsed, targetHost, targetPort).connect();
}
function parseProxyUrl(proxy) {
  let url;
  try {
    url = new URL(proxy.url);
  } catch {
    const portMatch = /:(\d+)(?:[/?#]|$)/.exec(proxy.url);
    if (portMatch?.[1]) {
      const raw = Number(portMatch[1]);
      if (Number.isInteger(raw) && (raw <= 0 || raw > 65535)) {
        throw AppError.badRequest(`代理端口不合法: ${portMatch[1]}（有效范围 1-65535）`);
      }
    }
    throw AppError.badRequest(`代理地址不合法: ${proxy.url}`);
  }
  const protocol = url.protocol.replace(":", "");
  if (!["socks5", "socks4", "http", "https"].includes(protocol)) {
    throw AppError.unsupported(`不支持的代理协议: ${protocol}`);
  }
  const port = url.port ? Number(url.port) : protocol === "socks5" || protocol === "socks4" ? 1080 : protocol === "https" ? 443 : 8080;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw AppError.badRequest(`代理端口不合法: ${url.port}`);
  }
  return {
    protocol,
    host: url.hostname,
    port,
    ...url.username ? { username: decodeURIComponent(url.username) } : {},
    ...url.password ? { password: decodeURIComponent(url.password) } : {}
  };
}
class ProxyTunnel {
  constructor(proxy, targetHost, targetPort) {
    this.proxy = proxy;
    this.targetHost = targetHost;
    this.targetPort = targetPort;
    this.socket = null;
  }
  connect() {
    const p = this.proxy;
    if (p.protocol === "https") {
      const sock2 = connect({ host: p.host, port: p.port, servername: p.host });
      this.socket = sock2;
      sock2.once("secureConnect", () => this.handshakeHttp(p.username, p.password));
      sock2.once("error", () => {
      });
      return sock2;
    }
    const sock = new Socket();
    this.socket = sock;
    sock.once("connect", () => {
      if (p.protocol === "socks5") this.handshakeSocks5(p.username, p.password);
      else if (p.protocol === "socks4") this.handshakeSocks4();
      else this.handshakeHttp(p.username, p.password);
    });
    sock.connect(p.port, p.host);
    return sock;
  }
  fail(message, code) {
    this.socket?.destroy(new AppError("INTERNAL", `${message} (${code})`));
  }
  /** SOCKS5：版本协商 → 认证 → CONNECT */
  handshakeSocks5(username, password) {
    const sock = this.socket;
    if (!sock) return;
    const useAuth = Boolean(username);
    const greeting = useAuth ? Buffer.from([5, 2, 0, 2]) : Buffer.from([5, 1, 0]);
    sock.write(greeting);
    const onGreeting = (data) => {
      if (data.length < 2 || data[0] !== 5) {
        return this.fail("SOCKS5 协商失败", "BAD_VERSION");
      }
      const method = data[1];
      if (method === 2) {
        if (!username) return this.fail("代理要求用户名密码", "AUTH_REQUIRED");
        const u = Buffer.from(username, "utf8");
        const p = Buffer.from(password ?? "", "utf8");
        sock.write(Buffer.concat([Buffer.from([1, u.length]), u, Buffer.from([p.length]), p]));
        sock.once("data", (d) => {
          if (d.length < 2 || d[1] !== 0) return this.fail("代理认证失败", "AUTH_FAILED");
          this.socks5Connect();
        });
        return;
      }
      if (method !== 0) return this.fail("代理不接受可用认证方式", "NO_ACCEPTABLE_METHOD");
      this.socks5Connect();
    };
    sock.once("data", onGreeting);
  }
  socks5Connect() {
    const sock = this.socket;
    if (!sock) return;
    const addr = encodeSocks5Target(this.targetHost, this.targetPort);
    sock.write(Buffer.concat([Buffer.from([5, 1, 0]), addr]));
    sock.once("data", (data) => {
      if (data.length < 2) return this.fail("SOCKS5 响应过短", "SHORT_RESPONSE");
      if (data[1] !== 0) {
        return this.fail(`SOCKS5 连接被拒 (reply=${data[1]})`, "CONNECT_REFUSED");
      }
      sock.removeAllListeners("data");
    });
  }
  /** SOCKS4 / 4a */
  handshakeSocks4() {
    const sock = this.socket;
    if (!sock) return;
    const isV4Addr = /^\d{1,3}(\.\d{1,3}){3}$/.test(this.targetHost);
    let request;
    if (isV4Addr) {
      request = Buffer.concat([
        Buffer.from([4, 1]),
        Buffer.from([this.targetPort >> 8, this.targetPort & 255]),
        Buffer.from(this.targetHost.split(".").map((n) => Number(n))),
        Buffer.from([0])
        // 空 userid
      ]);
    } else {
      request = Buffer.concat([
        Buffer.from([4, 1]),
        Buffer.from([this.targetPort >> 8, this.targetPort & 255]),
        Buffer.from([0, 0, 0, 1]),
        Buffer.from([0]),
        Buffer.from(this.targetHost, "utf8"),
        Buffer.from([0])
      ]);
    }
    sock.write(request);
    sock.once("data", (data) => {
      if (data.length < 2) return this.fail("SOCKS4 响应过短", "SHORT_RESPONSE");
      if (data[1] !== 90) return this.fail(`SOCKS4 连接被拒 (code=${data[1]})`, "CONNECT_REFUSED");
      sock.removeAllListeners("data");
    });
  }
  /** HTTP CONNECT */
  handshakeHttp(username, password) {
    const sock = this.socket;
    if (!sock) return;
    const hostHeader = this.targetHost.includes(":") && !this.targetHost.startsWith("[") ? `[${this.targetHost}]:${this.targetPort}` : `${this.targetHost}:${this.targetPort}`;
    const lines = [`CONNECT ${hostHeader} HTTP/1.1`, `Host: ${hostHeader}`, "Proxy-Connection: keep-alive"];
    if (username) {
      const token = Buffer.from(`${username}:${password ?? ""}`, "utf8").toString("base64");
      lines.push(`Proxy-Authorization: Basic ${token}`);
    }
    lines.push("", "");
    sock.write(lines.join("\r\n"));
    let buf = "";
    const onData = (chunk) => {
      buf += chunk.toString("latin1");
      const end = buf.indexOf("\r\n\r\n");
      if (end === -1) {
        if (buf.length > 64 * 1024) this.fail("代理响应头过大", "HEADER_TOO_LARGE");
        return;
      }
      sock.removeListener("data", onData);
      const statusLine = buf.split("\r\n", 1)[0] ?? "";
      const m = /^HTTP\/\d\.\d\s+(\d{3})/.exec(statusLine);
      if (!m) return this.fail("代理响应格式异常", "BAD_RESPONSE");
      const code = Number(m[1]);
      if (code !== 200) return this.fail(`代理 CONNECT 失败 HTTP ${code}`, `HTTP_${code}`);
    };
    sock.on("data", onData);
  }
}
function encodeSocks5Target(host, port) {
  const portBuf = Buffer.from([port >> 8, port & 255]);
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    return Buffer.concat([Buffer.from([1]), Buffer.from(host.split(".").map(Number)), portBuf]);
  }
  if (host.includes(":")) {
    const groups = expandIpv6(host);
    if (groups) {
      return Buffer.concat([Buffer.from([4]), Buffer.from(groups), portBuf]);
    }
  }
  const name = Buffer.from(host, "utf8");
  if (name.length > 255) throw AppError.badRequest("域名过长");
  return Buffer.concat([Buffer.from([3, name.length]), name, portBuf]);
}
function expandIpv6(host) {
  const parts = host.split("::");
  if (parts.length > 2) return null;
  const head = parts[0] ? parts[0].split(":") : [];
  const tail = parts.length === 2 && parts[1] ? parts[1].split(":") : [];
  const missing = 8 - head.length - tail.length;
  if (missing < 0) return null;
  const groups = [...head, ...Array(missing).fill("0"), ...tail];
  if (groups.length !== 8) return null;
  const bytes = [];
  for (const g of groups) {
    const n = parseInt(g || "0", 16);
    if (!Number.isFinite(n) || n < 0 || n > 65535) return null;
    bytes.push(n >> 8, n & 255);
  }
  return bytes;
}
const log$2 = createLogger("ssh");
const OUTPUT_BATCH_MS = 16;
const OUTPUT_BATCH_MAX_BYTES = 256 * 1024;
function disableNagle(client) {
  try {
    client.setNoDelay?.(true);
  } catch {
  }
}
class SshSession {
  constructor(connection, options) {
    this.options = options;
    this.client = null;
    this.shell = null;
    this.state = "idle";
    this.connectedAt = 0;
    this.jumpClients = [];
    this.sessionId = randomUUID();
    this.connection = connection;
    this.batcher = new OutputBatcher({
      windowMs: OUTPUT_BATCH_MS,
      maxBytes: OUTPUT_BATCH_MAX_BYTES,
      onFlush: (chunk) => this.options.events.onData(chunk)
    });
  }
  getState() {
    return this.state;
  }
  getInfo() {
    if (!this.client) throw AppError.notConnected();
    return {
      sessionId: this.sessionId,
      connectionId: this.connection.id,
      client: this.client,
      host: this.connection.host,
      port: this.connection.port,
      username: this.connection.username,
      state: this.state,
      connectedAt: this.connectedAt,
      exec: (command, options) => this.exec(command, options?.timeoutMs)
    };
  }
  setState(state, message) {
    this.state = state;
    this.options.events.onState(state, message);
  }
  /**
   * 建立连接并打开 shell 通道。
   * 跳板链：先逐跳建立上游连接，最后一跳用 forwardOut 打通到目标。
   */
  async connect() {
    this.setState("connecting");
    const conn = this.connection;
    try {
      const socket = await this.buildSocket();
      const config = {
        host: conn.host,
        port: conn.port,
        username: conn.username,
        readyTimeout: conn.options?.timeoutMs ?? 2e4,
        keepaliveInterval: conn.options?.keepalive?.transportIntervalMs ?? 5e3,
        keepaliveCountMax: 3,
        ...this.buildAuthConfig(),
        ...this.buildAlgorithmConfig(),
        ...socket ? { sock: socket } : {},
        // ssh2 的 hostVerifier 是回调式：同步返回 undefined 表示"稍后用 verify() 决议"，
        // 我们借此实现"弹窗询问用户"的异步确认流程。
        hostVerifier: (key, verify) => {
          this.verifyHostKey(key, verify);
        }
      };
      const client = new Client();
      this.client = client;
      client.on("handshake", () => this.setState("authenticating"));
      client.on("ready", () => {
        disableNagle(client);
        this.connectedAt = Date.now();
        this.setState("ready");
        log$2.info(`会话就绪 ${this.sessionId} → ${conn.username}@${conn.host}:${conn.port}`);
      });
      client.on("error", (err) => {
        this.options.events.onError(err.message, err.code);
        if (this.state !== "disconnected") this.setState("failed", err.message);
      });
      client.on("close", () => {
        this.batcher.flush();
        this.setState("disconnected");
        this.options.events.onClosed();
        this.cleanup();
      });
      client.on("keyboard-interactive", (name, instructions, _lang, prompts, finish) => {
        void this.handleKeyboardInteractive(
          name,
          instructions,
          prompts.map((p) => ({ prompt: p.prompt, echo: Boolean(p.echo) })),
          finish
        );
      });
      await new Promise((resolve, reject) => {
        const onReady = () => {
          cleanup();
          resolve();
        };
        const onError = (err) => {
          cleanup();
          reject(err);
        };
        const cleanup = () => {
          client.removeListener("ready", onReady);
          client.removeListener("error", onError);
        };
        client.once("ready", onReady);
        client.once("error", onError);
        client.connect(config);
      });
      this.shell = await new Promise((resolve, reject) => {
        client.shell(this.buildShellOptions(), (err, stream) => {
          if (err) return reject(err);
          resolve(stream);
        });
      });
      this.attachShell(this.shell);
    } catch (err) {
      this.setState("failed", err instanceof Error ? err.message : String(err));
      this.cleanup();
      throw err instanceof Error ? err : AppError.internal(String(err));
    }
  }
  /** 组装认证配置，按 authOrder 决定优先级 */
  buildAuthConfig() {
    const conn = this.connection;
    const cfg = {};
    if (conn.password) cfg.password = conn.password;
    if (conn.privateKey) cfg.privateKey = conn.privateKey;
    if (conn.passphrase) cfg.passphrase = conn.passphrase;
    if (conn.authType === "identity" && conn.identityId && this.options.resolveIdentity) {
      const id = this.options.resolveIdentity(conn.identityId);
      if (id) {
        if (id.privateKey) cfg.privateKey = id.privateKey;
        if (id.passphrase) cfg.passphrase = id.passphrase;
        if (id.password) cfg.password = id.password;
      }
    }
    const agent = process.env["SSH_AUTH_SOCK"];
    if (agent && (conn.authType === "privateKey" || conn.authType === "identity")) {
      cfg.agent = agent;
    }
    const order = conn.authOrder ?? [];
    if (order.length > 0) {
      cfg.tryKeyboard = order.includes("keyboardInteractive") || order.includes("keyboard");
    } else {
      cfg.tryKeyboard = conn.authType === "keyboardInteractive" || conn.authType === "keyboard";
    }
    return cfg;
  }
  buildAlgorithmConfig() {
    const a = this.connection.options?.algorithms;
    if (!a) return {};
    const algorithms = {};
    if (a.kex?.length) algorithms.kex = a.kex;
    if (a.cipher?.length) algorithms.cipher = a.cipher;
    if (a.hostKey?.length) algorithms.serverHostKey = a.hostKey;
    if (a.hmac?.length) algorithms.hmac = a.hmac;
    if (a.compress?.length) algorithms.compress = a.compress;
    return { algorithms };
  }
  buildShellOptions() {
    const opts = this.connection.options;
    return {
      term: opts?.term ?? "xterm-256color",
      cols: 80,
      rows: 24,
      ...opts?.colorTerm ? { env: { COLORTERM: opts.colorTerm } } : {}
    };
  }
  /**
   * 构建底层 socket：
   * - 有跳板链 → 逐跳连接，最后一跳 forwardOut 到目标
   * - 有代理 → 通过代理建立
   * - 都没有 → 返回 null，交给 ssh2 自己连
   */
  async buildSocket() {
    const conn = this.connection;
    if (conn.proxy && !conn.options?.disableProxy) {
      log$2.debug(`经代理连接 ${conn.proxy.url}`);
      return createProxySocket(conn.proxy, conn.host, conn.port);
    }
    const chain = conn.jumpChain ?? [];
    if (chain.length === 0) return void 0;
    if (chain.length > 20) {
      throw AppError.badRequest("跳板机链路最多 20 跳");
    }
    log$2.debug(`跳板链 ${chain.length} 跳`);
    return this.buildJumpSocket(chain);
  }
  /** 逐跳建立连接，返回打通到最终目标的 socket */
  async buildJumpSocket(chain) {
    const first = chain[0];
    if (!first) throw AppError.badRequest("跳板机链路为空");
    let currentSocket = null;
    for (let i = 0; i < chain.length; i++) {
      const hop = chain[i];
      if (!hop) continue;
      const client = new Client();
      this.jumpClients.push(client);
      const hopConfig = {
        host: hop.host,
        port: hop.port,
        username: hop.username,
        readyTimeout: 15e3,
        keepaliveInterval: 1e4,
        ...hop.privateKey ? { privateKey: hop.privateKey } : {},
        ...hop.passphrase ? { passphrase: hop.passphrase } : {},
        ...hop.password ? { password: hop.password } : {},
        // 跳板层的 socket 由上一跳 forwardOut 提供
        ...currentSocket ? { sock: currentSocket } : {}
      };
      await new Promise((resolve, reject) => {
        const onReady = () => {
          cleanup();
          resolve();
        };
        const onError = (err) => {
          cleanup();
          reject(AppError.internal(`跳板机 ${hop.host} 连接失败: ${err.message}`));
        };
        const cleanup = () => {
          client.removeListener("ready", onReady);
          client.removeListener("error", onError);
        };
        client.once("ready", onReady);
        client.once("error", onError);
        client.on("ready", () => disableNagle(client));
        client.connect(hopConfig);
      });
      const isLast = i === chain.length - 1;
      const nextHost = isLast ? this.connection.host : chain[i + 1]?.host;
      const nextPort = isLast ? this.connection.port : chain[i + 1]?.port;
      if (nextHost === void 0 || nextPort === void 0) {
        throw AppError.internal("跳板链目标解析失败");
      }
      currentSocket = await new Promise((resolve, reject) => {
        client.forwardOut("127.0.0.1", 0, nextHost, nextPort, (err, stream) => {
          if (err) return reject(AppError.internal(`跳板转发失败: ${err.message}`));
          resolve(stream);
        });
      });
    }
    if (!currentSocket) throw AppError.internal("跳板链未产出可用连接");
    return currentSocket;
  }
  /**
   * 主机指纹校验。
   *
   * 快路径：与已知指纹一致 → 同步接受，零延迟。
   * 慢路径：未知或变更 → 交给 UI 询问，用 verify() 异步决议。
   * 变更（mismatch）时 UI 必须显式告警，这是防中间人的关键。
   */
  verifyHostKey(key, verify) {
    const conn = this.connection;
    const fingerprint = fingerprintOf(key);
    const keyId = `${conn.host}:${conn.port}`;
    const known = this.options.knownHosts.get(keyId);
    if (known === fingerprint) {
      verify(true);
      return;
    }
    this.setState("verifying-host-key");
    this.options.events.onHostKeyAsk({
      host: conn.host,
      port: conn.port,
      keyType: "ssh",
      fingerprint,
      mismatch: known !== void 0
    }).then((accepted) => {
      if (accepted) {
        this.options.onHostKeyAccepted?.(conn.host, conn.port, fingerprint);
      }
      verify(accepted);
    }).catch((err) => {
      log$2.warn("主机指纹询问失败，按拒绝处理", err);
      verify(false);
    });
  }
  /** keyboard-interactive 认证（含 2FA 场景） */
  async handleKeyboardInteractive(name, instructions, prompts, finish) {
    try {
      const responses = await this.options.events.onAuthPrompt({ name, instructions, prompts });
      finish(responses);
    } catch (err) {
      log$2.warn("交互式认证被中止", err);
      finish([]);
    }
  }
  attachShell(shell) {
    shell.on("data", (chunk) => {
      this.batcher.push(chunk.toString("utf8"));
    });
    shell.stderr?.on("data", (chunk) => {
      this.batcher.push(chunk.toString("utf8"));
    });
    shell.on("close", () => {
      this.batcher.flush();
    });
  }
  /** 向 shell 写入数据 */
  write(data) {
    if (!this.shell) throw AppError.notConnected();
    this.shell.write(data);
  }
  /** 调整远端 PTY 尺寸 */
  resize(cols, rows) {
    if (!this.shell) return;
    this.shell.setWindow(rows, cols, 0, 0);
  }
  /**
   * 在已有连接上执行远端命令（监控采集、目录扫描等复用）。
   * 超时后强制结束，避免悬挂。
   */
  async exec(command, timeoutMs = 15e3) {
    const client = this.client;
    if (!client) throw AppError.notConnected();
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(AppError.timeout(`远端命令超时 (${timeoutMs}ms)`));
      }, timeoutMs);
      client.exec(command, (err, stream) => {
        if (err) {
          clearTimeout(timer);
          if (!settled) {
            settled = true;
            reject(err);
          }
          return;
        }
        let stdout = "";
        let stderr = "";
        let code = -1;
        stream.on("data", (d) => {
          stdout += d.toString("utf8");
        });
        stream.stderr.on("data", (d) => {
          stderr += d.toString("utf8");
        });
        stream.on("exit", (exitCode) => {
          if (typeof exitCode === "number") code = exitCode;
        });
        stream.on("close", () => {
          clearTimeout(timer);
          if (settled) return;
          settled = true;
          resolve({ stdout, stderr, code });
        });
      });
    });
  }
  /** 主动断开 */
  disconnect() {
    this.batcher.flush();
    try {
      this.shell?.end();
    } catch {
    }
    try {
      this.client?.end();
    } catch {
    }
    this.cleanup();
    this.setState("disconnected");
  }
  /** 清理跳板链等上游资源 */
  cleanup() {
    this.batcher.dispose();
    for (const c of this.jumpClients) {
      try {
        c.end();
      } catch {
      }
    }
    this.jumpClients = [];
    this.shell = null;
  }
}
function fingerprintOf(key) {
  return "SHA256:" + createHash("sha256").update(key).digest("base64").replace(/=+$/, "");
}
const log$1 = createLogger("ssh-manager");
const INTERACTION_TIMEOUT_MS = 12e4;
class SshManager {
  constructor(events, knownHostsFile, resolveIdentity) {
    this.events = events;
    this.knownHostsFile = knownHostsFile;
    this.resolveIdentity = resolveIdentity;
    this.sessions = /* @__PURE__ */ new Map();
    this.knownHosts = /* @__PURE__ */ new Map();
    this.pendingHostKey = /* @__PURE__ */ new Map();
    this.pendingAuth = /* @__PURE__ */ new Map();
    this.loadKnownHosts();
  }
  // ── 已知主机指纹持久化 ────────────────────────────────
  loadKnownHosts() {
    try {
      if (!existsSync(this.knownHostsFile)) return;
      const raw = readFileSync(this.knownHostsFile, "utf8");
      const obj = JSON.parse(raw);
      this.knownHosts = new Map(Object.entries(obj));
      log$1.debug(`已加载 ${this.knownHosts.size} 条主机指纹`);
    } catch (err) {
      log$1.warn("主机指纹文件损坏，忽略", err);
      this.knownHosts = /* @__PURE__ */ new Map();
    }
  }
  saveKnownHosts() {
    try {
      const dir = dirname(this.knownHostsFile);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const obj = Object.fromEntries(this.knownHosts);
      writeFileSync(this.knownHostsFile, JSON.stringify(obj, null, 2), { mode: 384 });
    } catch (err) {
      log$1.warn("主机指纹保存失败", err);
    }
  }
  /** 记录一个已确认的主机指纹 */
  rememberHostKey(host, port, fingerprint) {
    this.knownHosts.set(`${host}:${port}`, fingerprint);
    this.saveKnownHosts();
  }
  /** 移除一条主机指纹（用户主动"忘记"时） */
  forgetHostKey(host, port) {
    if (this.knownHosts.delete(`${host}:${port}`)) this.saveKnownHosts();
  }
  listKnownHosts() {
    return [...this.knownHosts.entries()].map(([host, fingerprint]) => ({ host, fingerprint }));
  }
  // ── 交互请求决议 ─────────────────────────────────────
  /** 由 IPC 层在用户做出选择后调用 */
  resolveHostKeyAsk(requestId, accepted) {
    const p = this.pendingHostKey.get(requestId);
    if (!p) return;
    clearTimeout(p.timer);
    this.pendingHostKey.delete(requestId);
    p.resolve(accepted);
  }
  /** 会话在用户接受新指纹后回调，由管理器统一落盘 */
  handleHostKeyAccepted(host, port, fingerprint) {
    this.knownHosts.set(`${host}:${port}`, fingerprint);
    this.saveKnownHosts();
    log$1.info(`已信任主机指纹 ${host}:${port}`);
  }
  /** 由 IPC 层在用户填写交互式认证后调用 */
  resolveAuthPrompt(requestId, responses) {
    const p = this.pendingAuth.get(requestId);
    if (!p) return;
    clearTimeout(p.timer);
    this.pendingAuth.delete(requestId);
    p.resolve(responses);
  }
  newRequestId() {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }
  // ── 会话生命周期 ─────────────────────────────────────
  /**
   * 建立连接。
   * @returns sessionId
   */
  async connect(connection) {
    if (!connection.host) throw AppError.badRequest("主机地址不能为空");
    if (!connection.username) throw AppError.badRequest("用户名不能为空");
    const session = new SshSession(connection, {
      knownHosts: this.knownHosts,
      ...this.resolveIdentity ? { resolveIdentity: this.resolveIdentity } : {},
      onHostKeyAccepted: (host, port, fingerprint) => {
        this.handleHostKeyAccepted(host, port, fingerprint);
      },
      events: {
        onState: (state, message) => {
          this.events.onState(session.sessionId, state, message);
        },
        onData: (data) => {
          this.events.onData(session.sessionId, data);
          publishSessionData(session.sessionId, data);
        },
        onDebug: (message) => {
          this.events.onDebug(session.sessionId, message);
        },
        onError: (message, code) => {
          this.events.onError(session.sessionId, message, code);
        },
        onClosed: (reason, code) => {
          unregisterSession(session.sessionId);
          unregisterWritable(session.sessionId);
          this.sessions.delete(session.sessionId);
          this.events.onClosed(session.sessionId, reason, code);
        },
        // 会话层 await 这两个回调的返回值；
        // 挂起由管理器持有，决议走 resolveHostKeyAsk / resolveAuthPrompt
        onHostKeyAsk: (info) => this.askHostKey(session.sessionId, info),
        onAuthPrompt: (info) => this.askAuth(session.sessionId, info)
      }
    });
    this.sessions.set(session.sessionId, session);
    try {
      await session.connect();
      registerSession(session.getInfo());
      {
        const info = session.getInfo();
        registerWritable({
          sessionId: session.sessionId,
          kind: "ssh",
          title: `${info.username}@${info.host}`,
          write: (data) => session.write(data),
          // 仅 ready 可写：连接中/已断开会静默丢输入，广播必须先剔除
          canWrite: () => session.getInfo().state === "ready"
        });
      }
      return session.sessionId;
    } catch (err) {
      this.sessions.delete(session.sessionId);
      throw err;
    }
  }
  askHostKey(sessionId, info) {
    const requestId = this.newRequestId();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingHostKey.delete(requestId);
        log$1.warn(`主机指纹询问超时，按拒绝处理 ${info.host}:${info.port}`);
        resolve(false);
      }, INTERACTION_TIMEOUT_MS);
      this.pendingHostKey.set(requestId, { resolve, timer });
      this.events.onHostKeyAsk(requestId, sessionId, info);
    });
  }
  askAuth(sessionId, info) {
    const requestId = this.newRequestId();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingAuth.delete(requestId);
        resolve([]);
      }, INTERACTION_TIMEOUT_MS);
      this.pendingAuth.set(requestId, { resolve, timer });
      this.events.onAuthPrompt(requestId, sessionId, info);
    });
  }
  getSession(sessionId) {
    return this.sessions.get(sessionId);
  }
  requireSession(sessionId) {
    const s = this.sessions.get(sessionId);
    if (!s) throw AppError.notConnected(`会话不存在: ${sessionId}`);
    return s;
  }
  /** 已建立会话的只读信息（不含底层 client） */
  listSessions() {
    return listSessions().map((s) => ({
      sessionId: s.sessionId,
      connectionId: s.connectionId,
      state: s.state,
      host: s.host
    }));
  }
  write(sessionId, data) {
    this.requireSession(sessionId).write(data);
  }
  resize(sessionId, cols, rows) {
    this.requireSession(sessionId).resize(cols, rows);
  }
  disconnect(sessionId) {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    s.disconnect();
    this.sessions.delete(sessionId);
    unregisterSession(sessionId);
  }
  /** 关闭全部会话（应用退出时调用） */
  disconnectAll() {
    for (const id of [...this.sessions.keys()]) {
      this.disconnect(id);
    }
  }
  /**
   * 测试连接（不打开 shell，只验证可达与认证）。
   * 用于连接表单的"测试连接"按钮。
   */
  async testConnection(connection) {
    const started = Date.now();
    const session = new SshSession(
      { ...connection, name: `__test__${connection.name}` },
      {
        knownHosts: this.knownHosts,
        ...this.resolveIdentity ? { resolveIdentity: this.resolveIdentity } : {},
        events: {
          onState: () => {
          },
          onData: () => {
          },
          onDebug: () => {
          },
          onError: () => {
          },
          onClosed: () => {
          },
          onHostKeyAsk: async (info) => {
            if (!info.mismatch) this.rememberHostKey(info.host, info.port, info.fingerprint);
            return !info.mismatch;
          },
          onAuthPrompt: async () => []
        }
      }
    );
    try {
      await session.connect();
      const latencyMs = Date.now() - started;
      session.disconnect();
      return { ok: true, message: "连接成功", latencyMs };
    } catch (err) {
      try {
        session.disconnect();
      } catch {
      }
      return {
        ok: false,
        message: err instanceof Error ? err.message : String(err),
        latencyMs: Date.now() - started
      };
    }
  }
}
const log = createLogger("ssh-ipc");
let manager = null;
let activeCtx = null;
function getManager(ctx) {
  activeCtx = ctx;
  if (manager) return manager;
  manager = new SshManager(
    {
      onState: (sessionId, state, message) => {
        activeCtx?.emit(Events.SSH_STATE, { sessionId, state, ...message ? { message } : {} });
      },
      onData: (sessionId, data) => {
        activeCtx?.emit(Events.SSH_DATA, { sessionId, data });
      },
      onDebug: (sessionId, message) => {
        activeCtx?.emit(Events.SSH_DEBUG, { sessionId, message });
      },
      onError: (sessionId, message, code) => {
        activeCtx?.emit(Events.SSH_ERROR, { sessionId, message, ...code ? { code } : {} });
      },
      onClosed: (sessionId, reason, code) => {
        activeCtx?.emit(Events.SSH_CLOSED, {
          sessionId,
          ...reason ? { reason } : {},
          ...code !== void 0 ? { code } : {}
        });
      },
      // 单向通知：挂起状态由管理器持有，UI 通过 verifyHostKey 动作回填
      onHostKeyAsk: (requestId, sessionId, info) => {
        activeCtx?.emit(Events.SSH_HOST_KEY_ASK, { requestId, sessionId, ...info });
      },
      onAuthPrompt: (requestId, sessionId, info) => {
        activeCtx?.emit(Events.SSH_AUTH_PROMPT, { requestId, sessionId, ...info });
      }
    },
    join(ctx.paths.userData, "known-hosts.json")
  );
  log.info("SSH 管理器已初始化");
  return manager;
}
function shutdownSsh() {
  manager?.disconnectAll();
  manager = null;
}
const connectionSchema = z.object({
  kind: z.literal("ssh"),
  id: z.string().min(1),
  name: z.string(),
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  username: z.string().min(1),
  authType: z.enum(["password", "privateKey", "identity", "keyboardInteractive", "keyboard"]),
  password: z.string().optional(),
  privateKey: z.string().optional(),
  passphrase: z.string().optional(),
  identityId: z.string().optional(),
  jumpChain: z.array(
    z.object({
      id: z.string(),
      host: z.string().min(1),
      port: z.number().int().min(1).max(65535),
      username: z.string().min(1),
      authType: z.enum(["password", "privateKey", "identity", "keyboardInteractive", "keyboard"]),
      privateKey: z.string().optional(),
      passphrase: z.string().optional(),
      password: z.string().optional(),
      identityId: z.string().optional(),
      name: z.string().optional(),
      verifyHostKey: z.boolean().optional()
    })
  ).max(20).optional(),
  options: z.object({
    timeoutMs: z.number().int().positive().optional(),
    term: z.string().optional(),
    colorTerm: z.string().optional(),
    encoding: z.string().optional(),
    disableProxy: z.boolean().optional(),
    disablePwdSync: z.boolean().optional(),
    disableListing: z.boolean().optional(),
    watchDirs: z.array(z.string()).optional(),
    keepalive: z.object({
      transportIntervalMs: z.number().int().optional(),
      shell: z.object({ text: z.string().optional(), intervalMs: z.number().int().optional() }).optional(),
      forwardBackoff: z.object({
        baseMs: z.number().int().optional(),
        maxMs: z.number().int().optional(),
        attempts: z.number().int().optional()
      }).optional()
    }).optional(),
    algorithms: z.object({
      kex: z.array(z.string()).optional(),
      cipher: z.array(z.string()).optional(),
      hostKey: z.array(z.string()).optional(),
      hmac: z.array(z.string()).optional(),
      compress: z.array(z.string()).optional()
    }).optional(),
    x11: z.object({ enabled: z.boolean(), cookieMode: z.string().optional() }).optional()
  }).optional(),
  proxy: z.object({
    url: z.string().min(1),
    protocol: z.enum(["socks5", "socks4", "http", "https"]).optional()
  }).optional(),
  note: z.string().optional(),
  storeType: z.enum(["local", "cloud"]).optional(),
  createdAt: z.string(),
  updatedAt: z.string()
}).passthrough();
const connectSchema = z.object({ connection: connectionSchema });
const sessionIdSchema = z.object({ sessionId: z.string().min(1) });
const writeSchema = z.object({ sessionId: z.string().min(1), data: z.string() });
const resizeSchema = z.object({
  sessionId: z.string().min(1),
  cols: z.number().int().positive(),
  rows: z.number().int().positive()
});
const resolveHostKeySchema = z.object({
  requestId: z.string().min(1),
  accepted: z.boolean()
});
const resolveAuthSchema = z.object({
  requestId: z.string().min(1),
  responses: z.array(z.string())
});
const setEncodingSchema = z.object({
  sessionId: z.string().min(1),
  encoding: z.string().min(1)
});
const sshHandlers = {
  /**
   * 读取交互式 shell 的当前目录（来自主进程解析的 OSC 7，见 services/session-cwd）。
   *
   * 因为那个模块用**全局数据挂钩**覆盖所有会话类型，消费方**何时来问都有值**。
   * 拿不到时返回 `cwd: null` + `reason`，让界面能**如实说明原因**
   * （而不是"点了没反应"——那对用户是最差的结果）。
   */
  getCwd: (payload) => {
    const { sessionId } = sessionIdSchema.parse(payload);
    const cwd = getCwd(sessionId);
    if (cwd !== null) return { cwd, source: "osc7" };
    return {
      cwd: null,
      reason: "还没拿到终端的当前目录：需要远端 shell 发 OSC 7 才能识别（bash 可在 PROMPT_COMMAND 里输出，zsh/fish 常见配置自带）"
    };
  },
  connect: async (payload, ctx) => {
    const { connection } = connectSchema.parse(payload);
    const sessionId = await getManager(ctx).connect(connection);
    return { sessionId };
  },
  disconnect: (payload, ctx) => {
    const { sessionId } = sessionIdSchema.parse(payload);
    getManager(ctx).disconnect(sessionId);
    return { disconnected: true };
  },
  listSessions: (_payload, ctx) => getManager(ctx).listSessions(),
  write: (payload, ctx) => {
    const { sessionId, data } = writeSchema.parse(payload);
    getManager(ctx).write(sessionId, data);
    return { written: data.length };
  },
  resize: (payload, ctx) => {
    const { sessionId, cols, rows } = resizeSchema.parse(payload);
    getManager(ctx).resize(sessionId, cols, rows);
    return { resized: true };
  },
  /** UI 对主机指纹询问做出决定（由管理器唯一持有挂起状态） */
  verifyHostKey: (payload, ctx) => {
    const { requestId, accepted } = resolveHostKeySchema.parse(payload);
    getManager(ctx).resolveHostKeyAsk(requestId, accepted);
    return { resolved: true };
  },
  /** UI 提交交互式认证响应 */
  respondAuth: (payload, ctx) => {
    const { requestId, responses } = resolveAuthSchema.parse(payload);
    getManager(ctx).resolveAuthPrompt(requestId, responses);
    return { resolved: true };
  },
  /** 测试连接：只验证可达与认证，不打开 shell */
  testConnection: async (payload, ctx) => {
    const { connection } = connectSchema.parse(payload);
    return getManager(ctx).testConnection(connection);
  },
  reconnect: async (payload, ctx) => {
    const { connection } = connectSchema.parse(payload);
    const sessionId = await getManager(ctx).connect(connection);
    return { sessionId };
  },
  /**
   * 记录会话解码编码。
   * 实际字节→字符的转换在渲染层完成（xterm 收到的是字符串）；
   * 此处保存以便重连时沿用同一编码。
   */
  setEncoding: (payload) => {
    const { sessionId, encoding } = setEncodingSchema.parse(payload);
    if (encoding.trim().length === 0) throw AppError.badRequest("编码不能为空");
    return { sessionId, encoding, applied: true };
  }
};
export {
  shutdownSsh,
  sshHandlers
};
