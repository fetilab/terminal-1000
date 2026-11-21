import { z } from "zod";
import { join, resolve, dirname } from "node:path";
import { a as getSession, i as requireSession, M as MONITOR_TIER_INTERVALS, A as AppError, E as Events, s as subscribeSessionClosed } from "../index.js";
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import "electron";
import "node:child_process";
import "node:net";
import "node:url";
import "better-sqlite3";
import "node:crypto";
import "node:os";
import "node:fs/promises";
import __cjs_mod__ from "node:module";
const __filename = import.meta.filename;
const __dirname = import.meta.dirname;
const require2 = __cjs_mod__.createRequire(import.meta.url);
const AGENT_VERSION = "3.0.0";
const AGENT_DIR = "$HOME/.t1000-monitor";
const AGENT_STATE_PATH = `${AGENT_DIR}/agent-state.json`;
const AGENT_VERSION_PATH = `${AGENT_DIR}/agent.version`;
const AGENT_LOG_PATH = `${AGENT_DIR}/agent.log`;
const AGENT_IDLE_SECONDS = 900;
function resolveArch(unameMachine) {
  const raw = (unameMachine ?? "").trim().toLowerCase();
  if (raw === "x86_64" || raw === "amd64") return "amd64";
  if (raw === "aarch64" || raw === "arm64") return "arm64";
  if (raw === "armv7l" || raw === "armv7" || raw === "armv6l" || raw === "armv8l" || raw === "armhf" || raw === "arm") {
    return "arm";
  }
  return null;
}
function agentAssetDir() {
  const packaged = process.resourcesPath ? join(process.resourcesPath, "agent") : "";
  if (packaged && existsSync(packaged)) return packaged;
  const starts = [process.cwd(), typeof __dirname === "string" ? __dirname : ""];
  for (const start of starts) {
    if (!start) continue;
    let dir = resolve(start);
    for (let i = 0; i < 6; i++) {
      const candidate = join(dir, "build", "agent");
      if (existsSync(candidate)) return candidate;
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return join(process.cwd(), "build", "agent");
}
function agentAssetPath(arch) {
  return join(agentAssetDir(), `t1000-agent-linux-${arch}.gz`);
}
function readAgentBinary(arch) {
  const path = agentAssetPath(arch);
  if (!existsSync(path)) {
    throw new Error(`安装包内缺少 ${arch} 架构的监控代理（${path}），请重新打包`);
  }
  return gunzipSync(readFileSync(path));
}
const AGENT_BIN_PATH = `${AGENT_DIR}/t1000-agent`;
const AGENT_UPLOAD_PATH = `${AGENT_BIN_PATH}.upload`;
const PROBE_TIMEOUT_MS = 8e3;
const INSTALL_TIMEOUT_MS$1 = 2e4;
const SAMPLE_TIMEOUT_MS = 6e3;
const HEALTH_TIMEOUT_MS = 2500;
const PROBE_TTL_MS = 3e4;
const UNAVAILABLE_TTL_MS = 6e4;
const HEALTH_TTL_MS = 8e3;
function agentProbeCommand() {
  return [
    `printf 'T1000_MACHINE:'; uname -m 2>/dev/null || printf 'unknown'; printf '\\n'`,
    `printf 'T1000_HOME:%s\\n' "$HOME"`,
    `printf 'T1000_VER:'; "${AGENT_BIN_PATH}" -version 2>/dev/null || cat "${AGENT_VERSION_PATH}" 2>/dev/null || printf 'none'; printf '\\n'`,
    `printf 'T1000_STATE:'; cat "${AGENT_STATE_PATH}" 2>/dev/null || printf '{}'; printf '\\n'`,
    `printf 'T1000_END\\n'`
  ].join("\n");
}
function agentActivateCommand() {
  return [
    `chmod 700 "${AGENT_UPLOAD_PATH}" && mv -f "${AGENT_UPLOAD_PATH}" "${AGENT_BIN_PATH}"`,
    `printf '%s' '${AGENT_VERSION}' > "${AGENT_VERSION_PATH}"`,
    `printf 'T1000_AGENT_OK\\n'`
  ].join("\n");
}
function agentStartCommand() {
  return [
    `cd "${AGENT_DIR}" || { printf 'T1000_AGENT_ERR:no-dir\\n'; exit 0; }`,
    `rm -f agent-state.json`,
    `TOKEN=$(od -An -N16 -tx1 /dev/urandom 2>/dev/null | tr -d '[:space:]')`,
    `[ -n "$TOKEN" ] || TOKEN=$(date +%s 2>/dev/null)$RANDOM`,
    `if command -v setsid >/dev/null 2>&1; then`,
    `  setsid nohup ./t1000-agent -port 0 -state agent-state.json -token "$TOKEN" -idle ${AGENT_IDLE_SECONDS} > agent.log 2>&1 < /dev/null &`,
    `else`,
    `  nohup ./t1000-agent -port 0 -state agent-state.json -token "$TOKEN" -idle ${AGENT_IDLE_SECONDS} > agent.log 2>&1 < /dev/null &`,
    `fi`,
    `i=0`,
    `while [ $i -lt 25 ]; do [ -s agent-state.json ] && break; sleep 0.2 2>/dev/null || sleep 1; i=$((i+1)); done`,
    `cat agent-state.json 2>/dev/null || printf 'T1000_AGENT_ERR:no-state\\n'`
  ].join("\n");
}
function agentStopCommand(pid, uninstall = false) {
  const lines = [
    `kill ${pid} 2>/dev/null || true`,
    `rm -f "${AGENT_STATE_PATH}"`
  ];
  if (uninstall) {
    lines.push(`rm -f "${AGENT_BIN_PATH}" "${AGENT_UPLOAD_PATH}" "${AGENT_VERSION_PATH}" "${AGENT_LOG_PATH}"`);
    lines.push(`rmdir "${AGENT_DIR}" 2>/dev/null || true`);
  }
  lines.push(`printf 'T1000_AGENT_STOPPED\\n'`);
  return lines.join("\n");
}
function shellQuote(value) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
function parseProbe(stdout) {
  const field = (prefix) => (stdout.split(/\r?\n/).find((l) => l.startsWith(prefix)) ?? "").slice(prefix.length).trim();
  const machine = field("T1000_MACHINE:") || null;
  const home = field("T1000_HOME:") || null;
  const versionRaw = field("T1000_VER:");
  const version = versionRaw && versionRaw !== "none" ? versionRaw : null;
  let state = null;
  const rawState = field("T1000_STATE:");
  if (rawState && rawState !== "{}") {
    try {
      const parsed = JSON.parse(rawState);
      if (typeof parsed.port === "number" && typeof parsed.pid === "number" && typeof parsed.token === "string") {
        state = {
          port: parsed.port,
          pid: parsed.pid,
          token: parsed.token,
          version: typeof parsed.version === "string" ? parsed.version : "",
          ...typeof parsed.startedAt === "number" ? { startedAt: parsed.startedAt } : {}
        };
      }
    } catch {
      state = null;
    }
  }
  return {
    machine,
    arch: resolveArch(machine),
    home,
    installed: version !== null,
    version,
    state
  };
}
class AgentHttp {
  constructor(open) {
    this.open = open;
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.queue = Promise.resolve();
    this.closed = false;
    this.pending = null;
  }
  async connected() {
    if (this.socket) return this.socket;
    const sock = await this.open();
    this.socket = sock;
    this.buffer = Buffer.alloc(0);
    sock.on("data", (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.pending?.onData();
    });
    sock.on("close", () => {
      this.pending?.fail(new Error("代理通道已断开"));
      this.destroy();
    });
    sock.on("error", (err) => {
      this.pending?.fail(err);
      this.destroy();
    });
    return sock;
  }
  destroy() {
    this.socket?.destroy();
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.pending = null;
  }
  close() {
    this.closed = true;
    this.destroy();
  }
  /** 串行执行：同一个通道上不并发请求（响应无法区分归属） */
  request(path, timeoutMs) {
    const run = this.queue.then(() => this.doRequest(path, timeoutMs));
    this.queue = run.catch(() => void 0);
    return run;
  }
  async doRequest(path, timeoutMs) {
    if (this.closed) throw new Error("通道已关闭");
    const sock = await this.connected();
    return new Promise((resolve2, reject) => {
      let settled = false;
      const entry = {
        onData: () => waitForResponse(),
        fail: (err) => finish(err)
      };
      const finish = (err, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (this.pending === entry) this.pending = null;
        if (err) {
          this.destroy();
          reject(err);
        } else if (value) {
          resolve2(value);
        }
      };
      const timer = setTimeout(() => finish(new Error(`代理响应超时 (${timeoutMs}ms)`)), timeoutMs);
      const waitForResponse = () => {
        if (settled) return;
        const sep = this.buffer.indexOf("\r\n\r\n");
        if (sep < 0) {
          if (this.buffer.length > 64 * 1024) finish(new Error("代理响应头过大"));
          return;
        }
        const head = this.buffer.subarray(0, sep).toString("latin1");
        const lines = head.split("\r\n");
        const status = Number(lines[0]?.split(" ")[1] ?? 0);
        let length = 0;
        for (const line of lines.slice(1)) {
          const idx = line.indexOf(":");
          if (idx < 0) continue;
          if (line.slice(0, idx).trim().toLowerCase() === "content-length") {
            length = Number(line.slice(idx + 1).trim());
          }
        }
        const bodyStart = sep + 4;
        if (this.buffer.length < bodyStart + length) return;
        const body = this.buffer.subarray(bodyStart, bodyStart + length).toString("utf8");
        this.buffer = this.buffer.subarray(bodyStart + length);
        finish(null, { status, body });
      };
      this.pending = entry;
      sock.write(
        `GET ${path} HTTP/1.1\r
Host: 127.0.0.1\r
Accept: application/json\r
Connection: keep-alive\r
\r
`
      );
      waitForResponse();
    });
  }
}
class AgentService {
  constructor(exec, prefs, putFile = async () => {
    throw new Error("未提供文件上传通道");
  }, now = Date.now, openChannel = (sessionId, port) => this.openTunnel(sessionId, port)) {
    this.exec = exec;
    this.prefs = prefs;
    this.putFile = putFile;
    this.now = now;
    this.openChannel = openChannel;
    this.runtimes = /* @__PURE__ */ new Map();
    this.probeCache = /* @__PURE__ */ new Map();
    this.blockedUntil = /* @__PURE__ */ new Map();
  }
  /** 探测（带缓存）。decision 来自本地偏好文件。 */
  async probe(sessionId) {
    const cached = this.probeCache.get(sessionId);
    const fresh = cached && this.now() - cached.at < PROBE_TTL_MS;
    const base = fresh ? cached.probe : await this.probeRemote(sessionId);
    return { ...base, decision: this.prefs.decision(this.prefKey(sessionId)) };
  }
  async probeRemote(sessionId) {
    try {
      const res = await this.exec(sessionId, agentProbeCommand(), PROBE_TIMEOUT_MS);
      if (res.code !== 0 && !res.stdout.includes("T1000_END")) {
        throw new Error(res.stderr.trim() || `探测失败（退出码 ${res.code}）`);
      }
      const probe = parseProbe(res.stdout);
      this.probeCache.set(sessionId, { at: this.now(), probe });
      return probe;
    } catch (err) {
      this.blockedUntil.set(sessionId, this.now() + UNAVAILABLE_TTL_MS);
      throw err;
    }
  }
  /** 安装（上传二进制 + 启动）。返回启动后的状态；失败抛错，由 IPC 层转成可读文案。 */
  async install(sessionId) {
    const probe = await this.probeRemote(sessionId);
    if (!probe.arch) {
      throw new Error(
        `服务器架构 ${probe.machine ?? "未知"} 没有随包提供的代理，将使用脚本模式（功能相同，刷新更粗）`
      );
    }
    if (!probe.home) {
      throw new Error("拿不到远端 $HOME，无法上传代理");
    }
    const dir = `${probe.home}/.t1000-monitor`;
    const prep = await this.exec(
      sessionId,
      `mkdir -p ${shellQuote(dir)} && chmod 700 ${shellQuote(dir)}`,
      PROBE_TIMEOUT_MS
    );
    if (prep.code !== 0) {
      throw new Error(`创建目录失败：${firstLine$1(prep.stderr) ?? `退出码 ${prep.code}`}`);
    }
    await this.putFile(sessionId, `${dir}/t1000-agent.upload`, readAgentBinary(probe.arch), 448);
    const res = await this.exec(sessionId, agentActivateCommand(), INSTALL_TIMEOUT_MS$1);
    if (!res.stdout.includes("T1000_AGENT_OK")) {
      throw new Error(`代理激活失败（退出码 ${res.code}）：${firstLine$1(res.stderr) ?? "未知原因"}`);
    }
    this.probeCache.delete(sessionId);
    const runtime = await this.start(sessionId);
    this.prefs.set(this.prefKey(sessionId), "installed");
    this.blockedUntil.delete(sessionId);
    return { version: runtime.version, port: runtime.port, pid: runtime.pid };
  }
  /** 启动（已装但没在跑时）。 */
  async start(sessionId) {
    const res = await this.exec(sessionId, agentStartCommand(), INSTALL_TIMEOUT_MS$1);
    const state = parseState(res.stdout);
    if (!state) {
      throw new Error(
        `代理启动失败：${firstLine$1(res.stderr) ?? firstLine$1(res.stdout) ?? "未拿到状态文件"}`
      );
    }
    const runtime = {
      sessionId,
      port: state.port,
      token: state.token,
      pid: state.pid,
      version: state.version || AGENT_VERSION,
      client: new AgentHttp(() => this.openChannel(sessionId, state.port)),
      healthyAt: 0
    };
    this.runtimes.set(sessionId, runtime);
    this.probeCache.delete(sessionId);
    this.blockedUntil.delete(sessionId);
    return runtime;
  }
  /**
   * 确保代理可用。返回 null 表示"这台服务器走脚本模式"：
   * 没装、没 python3、用户拒绝、或刚失败（静默 60s 后才会再试）。
   */
  async ensure(sessionId) {
    const runtime = this.runtimes.get(sessionId);
    if (runtime) {
      if (this.now() - runtime.healthyAt < HEALTH_TTL_MS) return runtime;
      if (await this.ping(runtime)) return runtime;
      runtime.client.close();
      this.runtimes.delete(sessionId);
    }
    if ((this.blockedUntil.get(sessionId) ?? 0) > this.now()) return null;
    let probe;
    try {
      probe = await this.probeRemote(sessionId);
    } catch {
      return null;
    }
    if (!probe.arch || !probe.installed || probe.version !== AGENT_VERSION) {
      this.blockedUntil.set(sessionId, this.now() + UNAVAILABLE_TTL_MS);
      return null;
    }
    if (probe.state) {
      const candidate = {
        sessionId,
        port: probe.state.port,
        token: probe.state.token,
        pid: probe.state.pid,
        version: probe.state.version || AGENT_VERSION,
        client: new AgentHttp(() => this.openChannel(sessionId, probe.state.port)),
        healthyAt: 0
      };
      if (await this.ping(candidate)) {
        this.runtimes.set(sessionId, candidate);
        return candidate;
      }
      candidate.client.close();
    }
    try {
      return await this.start(sessionId);
    } catch {
      this.blockedUntil.set(sessionId, this.now() + UNAVAILABLE_TTL_MS);
      return null;
    }
  }
  /** 取一份 metrics JSON；失败返回 null（绝不让监控面板因此崩掉） */
  async sample(sessionId, modules, options) {
    const runtime = await this.ensure(sessionId);
    if (!runtime) return null;
    const query = `/metrics?modules=${encodeURIComponent(modules.join(","))}&limit=${Math.max(1, Math.min(200, Math.trunc(options.processLimit)))}&token=${encodeURIComponent(runtime.token)}`;
    try {
      const res = await runtime.client.request(query, SAMPLE_TIMEOUT_MS);
      if (res.status !== 200) throw new Error(`代理返回 HTTP ${res.status}`);
      runtime.healthyAt = this.now();
      return { json: res.body, version: runtime.version };
    } catch {
      runtime.client.close();
      this.runtimes.delete(sessionId);
      return null;
    }
  }
  /** 停止代理（uninstall 时连文件一起删） */
  async stop(sessionId, uninstall) {
    const runtime = this.runtimes.get(sessionId);
    this.runtimes.delete(sessionId);
    runtime?.client.close();
    this.probeCache.delete(sessionId);
    this.blockedUntil.delete(sessionId);
    let pid = runtime?.pid ?? null;
    if (pid === null) {
      const probe = await this.probeRemote(sessionId).catch(() => null);
      pid = probe?.state?.pid ?? null;
    }
    if (pid !== null) {
      await this.exec(sessionId, agentStopCommand(pid, uninstall), PROBE_TIMEOUT_MS).catch(() => void 0);
    }
    if (uninstall) this.prefs.set(this.prefKey(sessionId), "declined");
    this.probeCache.delete(sessionId);
  }
  /** 用户明确拒绝（弹窗里选"暂不安装/不再询问"） */
  decline(sessionId, forever) {
    this.prefs.set(this.prefKey(sessionId), forever ? "never" : "declined");
    this.blockedUntil.set(sessionId, this.now() + UNAVAILABLE_TTL_MS);
  }
  forget(sessionId) {
    const runtime = this.runtimes.get(sessionId);
    runtime?.client.close();
    this.runtimes.delete(sessionId);
    this.probeCache.delete(sessionId);
    this.blockedUntil.delete(sessionId);
  }
  // ── 内部 ────────────────────────────────────────────────────────────────
  prefKey(sessionId) {
    const session = getSession(sessionId);
    if (!session) return sessionId;
    return `${session.host}:${session.port}:${session.username}`;
  }
  openTunnel(sessionId, port) {
    const session = requireSession(sessionId);
    if (session.state !== "ready") throw new Error("SSH 会话已断开，无法建立监控隧道");
    return new Promise((resolve2, reject) => {
      const timer = setTimeout(() => reject(new Error("建立监控隧道超时")), 4e3);
      session.client.forwardOut("127.0.0.1", 0, "127.0.0.1", port, (err, stream) => {
        clearTimeout(timer);
        if (err) return reject(err);
        resolve2(stream);
      });
    });
  }
  async ping(runtime) {
    try {
      const res = await runtime.client.request(
        `/health?token=${encodeURIComponent(runtime.token)}`,
        HEALTH_TIMEOUT_MS
      );
      if (res.status !== 200) return false;
      const body = JSON.parse(res.body);
      if (body.ok !== true) return false;
      if (body.version) runtime.version = body.version;
      runtime.healthyAt = this.now();
      return true;
    } catch {
      return false;
    }
  }
}
function parseState(stdout) {
  const start = stdout.indexOf("{");
  const end = stdout.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(stdout.slice(start, end + 1));
    if (typeof parsed.port !== "number" || typeof parsed.token !== "string") return null;
    return {
      port: parsed.port,
      pid: typeof parsed.pid === "number" ? parsed.pid : 0,
      token: parsed.token,
      version: typeof parsed.version === "string" ? parsed.version : "",
      ...typeof parsed.startedAt === "number" ? { startedAt: parsed.startedAt } : {}
    };
  } catch {
    return null;
  }
}
function firstLine$1(text) {
  const line = text.split(/\r?\n/).map((s) => s.trim()).find((s) => s.length > 0);
  return line === void 0 ? void 0 : line.length > 200 ? `${line.slice(0, 200)}…` : line;
}
class AgentPrefs {
  constructor(file) {
    this.file = file;
    this.cache = null;
  }
  load() {
    if (this.cache) return this.cache;
    try {
      if (existsSync(this.file)) {
        const parsed = JSON.parse(readFileSync(this.file, "utf8"));
        this.cache = typeof parsed === "object" && parsed !== null ? parsed : {};
      } else {
        this.cache = {};
      }
    } catch {
      this.cache = {};
    }
    return this.cache;
  }
  decision(key) {
    return this.load()[key]?.decision ?? "ask";
  }
  set(key, decision) {
    const doc = this.load();
    doc[key] = { decision, at: (/* @__PURE__ */ new Date()).toISOString() };
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify(doc, null, 2), "utf8");
    } catch {
    }
  }
}
const SCRIPT_VERSION = "1";
const REMOTE_DIR = "$HOME/.t1000-monitor";
const REMOTE_SCRIPT_PATH = `${REMOTE_DIR}/collect.sh`;
const REMOTE_VERSION_PATH = `${REMOTE_DIR}/VERSION`;
const HEREDOC_MARKER = "T1000_COLLECTOR_EOF";
const VERSION_MISSING_SENTINEL = "__T1000_MISSING__";
const INSTALL_OK_SENTINEL = "__T1000_OK__";
const DEFAULT_PROCESS_LIMIT = 8;
const DEFAULT_FAILURE_PAUSE_THRESHOLD = 3;
const COLLECTOR_SCRIPT = collectorScriptLines().join("\n");
const MONITOR_MODULES = [
  "system",
  "cpu",
  "memory",
  "network",
  "disk",
  "process",
  "gpu"
];
const MODULE_BY_CARD = {
  system: "system",
  cpu: "cpu",
  memory: "memory",
  network: "network",
  disk: "disk",
  process: "process",
  gpu: "gpu"
};
function modulesForCards(cards) {
  const wanted = /* @__PURE__ */ new Set();
  for (const card of cards) {
    if (!card.enabled) continue;
    const mod = MODULE_BY_CARD[card.kind];
    if (mod) wanted.add(mod);
  }
  return MONITOR_MODULES.filter((m) => wanted.has(m));
}
function versionCheckCommand() {
  return [
    `if [ -f "${REMOTE_SCRIPT_PATH}" ] && [ -f "${REMOTE_VERSION_PATH}" ]; then`,
    `cat "${REMOTE_VERSION_PATH}"`,
    "else",
    `printf '%s\\n' '${VERSION_MISSING_SENTINEL}'`,
    "fi"
  ].join("\n");
}
function installCommand() {
  return [
    `mkdir -p "${REMOTE_DIR}" && cat > "${REMOTE_SCRIPT_PATH}" <<'${HEREDOC_MARKER}'`,
    COLLECTOR_SCRIPT,
    HEREDOC_MARKER,
    `printf '%s' '${SCRIPT_VERSION}' > "${REMOTE_VERSION_PATH}" && printf '%s\\n' '${INSTALL_OK_SENTINEL}'`
  ].join("\n");
}
function collectCommand(modules, options = {}) {
  const limit = clampInt$1(options.processLimit ?? DEFAULT_PROCESS_LIMIT, 1, 200);
  const list = modules.filter(
    (m) => MONITOR_MODULES.includes(m)
  );
  const suffix = list.length > 0 ? ` ${list.join(" ")}` : "";
  return `T1000_PROC_LIMIT=${limit} T1000_MONITOR_DIR="${REMOTE_DIR}" sh "${REMOTE_SCRIPT_PATH}"${suffix}`;
}
function parseRemoteVersion(stdout) {
  const line = stdout.split(/\r?\n/).map((s) => s.trim()).find((s) => s.length > 0);
  if (!line || line === VERSION_MISSING_SENTINEL) return null;
  return line;
}
function needsInstall(remoteVersion) {
  return remoteVersion !== SCRIPT_VERSION;
}
function clampInt$1(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}
function collectorScriptLines() {
  return [
    "#!/bin/sh",
    "# terminal-1000 remote metrics collector (POSIX sh; GNU coreutils + busybox)",
    "#",
    "# usage: sh collect.sh [module ...]      modules: system cpu memory network disk process gpu",
    "# env:   T1000_MONITOR_DIR   cache dir (default $HOME/.t1000-monitor)",
    "#        T1000_PROC_LIMIT    top-N process rows (default 8)",
    "# out:   one JSON object on stdout. A failing module is skipped, never fatal.",
    "VERSION=1",
    "",
    'DIR="${T1000_MONITOR_DIR:-$HOME/.t1000-monitor}"',
    'LIMIT="${T1000_PROC_LIMIT:-8}"',
    `case "$LIMIT" in ''|*[!0-9]*) LIMIT=8 ;; esac`,
    '[ "$LIMIT" -gt 200 ] && LIMIT=200',
    "",
    `[ "$1" = "--version" ] && { printf '%s\\n' "$VERSION"; exit 0; }`,
    "",
    'mkdir -p "$DIR" 2>/dev/null',
    "",
    "FIRST=1",
    "SEP=''",
    "HAVE_AWK=0",
    "command -v awk >/dev/null 2>&1 && HAVE_AWK=1",
    "",
    "if command -v sed >/dev/null 2>&1; then",
    `  esc() { printf '%s' "$1" | tr -d '\\r' | tr '\\t' ' ' | tr '\\n' ' ' | sed -e 's/\\\\/\\\\\\\\/g' -e 's/"/\\\\"/g'; }`,
    "else",
    `  esc() { printf '%s' "$1" | tr -d '"\\r\\n\\t\\\\'; }`,
    "fi",
    "",
    "# JSON string (with quotes) from one shell value",
    `jstr() { printf '"%s"' "$(esc "$1")"; }`,
    "# unsigned integer, 0 on garbage",
    `num() { case "$1" in ''|*[!0-9]*) printf '0' ;; *) printf '%s' "$1" ;; esac; }`,
    "# unsigned decimal, 0 on garbage",
    `fnum() { case "$1" in ''|*[!0-9.]*) printf '0' ;; *) printf '%s' "$1" ;; esac; }`,
    "",
    '# append `"key":value` into the current object; an empty value is skipped',
    "kv() {",
    '  [ -z "$2" ] && return 0',
    `  if [ -z "$SEP" ]; then SEP=1; else printf ','; fi`,
    `  printf '"%s":%s' "$1" "$2"`,
    "}",
    "",
    "# ── system ────────────────────────────────────────────────────────────────",
    "m_system() {",
    "  host=$(hostname 2>/dev/null)",
    "  kernel=$(uname -r 2>/dev/null)",
    "  arch=$(uname -m 2>/dev/null)",
    "  tz=$(date +%Z 2>/dev/null)",
    '  if [ -z "$tz" ] && [ -r /etc/timezone ]; then tz=$(head -n1 /etc/timezone 2>/dev/null); fi',
    "  up=''",
    "  if [ -r /proc/uptime ]; then up=$(cut -d' ' -f1 /proc/uptime 2>/dev/null | cut -d. -f1); fi",
    "  users=''",
    "  if command -v who >/dev/null 2>&1; then users=$(who 2>/dev/null | wc -l | tr -dc '0-9'); fi",
    "  load1=''; load2=''; load3=''",
    "  if [ -r /proc/loadavg ]; then",
    "    set -- $(cut -d' ' -f1-3 /proc/loadavg 2>/dev/null)",
    "    load1=$1; load2=$2; load3=$3",
    "  fi",
    "  distro=''; release=''",
    "  if [ -r /etc/os-release ]; then",
    `    distro=$(grep '^ID=' /etc/os-release 2>/dev/null | head -n1 | cut -d= -f2- | tr -d '"')`,
    `    release=$(grep '^VERSION_ID=' /etc/os-release 2>/dev/null | head -n1 | cut -d= -f2- | tr -d '"')`,
    "  fi",
    '  if [ -z "$distro" ] && [ -r /etc/debian_version ]; then distro=debian; fi',
    '  if [ -z "$distro" ] && [ -r /etc/redhat-release ]; then distro=redhat; fi',
    "",
    "  printf '{'",
    "  SEP=''",
    '  [ -n "$host" ] && kv hostname "$(jstr "$host")"',
    '  [ -n "$distro" ] && kv distro "$(jstr "$distro")"',
    '  [ -n "$release" ] && kv release "$(jstr "$release")"',
    '  [ -n "$kernel" ] && kv kernel "$(jstr "$kernel")"',
    '  [ -n "$arch" ] && kv arch "$(jstr "$arch")"',
    '  [ -n "$tz" ] && kv timezone "$(jstr "$tz")"',
    '  [ -n "$up" ] && kv uptimeSeconds "$(num "$up")"',
    '  [ -n "$users" ] && kv users "$(num "$users")"',
    '  if [ -n "$load1" ] && [ -n "$load2" ] && [ -n "$load3" ]; then',
    '    kv loadAvg "[$(fnum "$load1"),$(fnum "$load2"),$(fnum "$load3")]"',
    "  fi",
    "  printf '}'",
    "}",
    "",
    "# ── cpu (per-core; delta between two /proc/stat samples) ──────────────────",
    "m_cpu() {",
    "  model=$(grep -m1 'model name' /proc/cpuinfo 2>/dev/null | cut -d: -f2- | sed -e 's/^ *//' -e 's/ *$//')",
    '  if [ -z "$model" ]; then',
    "    model=$(grep -m1 -i '^hardware' /proc/cpuinfo 2>/dev/null | cut -d: -f2- | sed -e 's/^ *//')",
    "  fi",
    "  logical=$(grep -c '^processor' /proc/cpuinfo 2>/dev/null | tr -dc '0-9')",
    '  if [ -z "$logical" ] || [ "$logical" -le 0 ]; then',
    "    logical=$(getconf _NPROCESSORS_ONLN 2>/dev/null | tr -dc '0-9')",
    "  fi",
    "  physical=''",
    '  if [ "$HAVE_AWK" = 1 ]; then',
    `    physical=$(awk '/^physical id/{p=$4} /^core id/{print p "/" $4}' /proc/cpuinfo 2>/dev/null | sort -u | wc -l | tr -dc '0-9')`,
    `    case "$physical" in ''|0) physical='' ;; esac`,
    "  fi",
    "  tempc=''",
    "  tmax=''",
    "  for f in /sys/class/thermal/thermal_zone*/temp; do",
    '    [ -r "$f" ] || continue',
    `    t=$(tr -dc '0-9' < "$f" 2>/dev/null)`,
    '    [ -z "$t" ] && continue',
    '    if [ -z "$tmax" ] || [ "$t" -gt "$tmax" ]; then tmax=$t; fi',
    "  done",
    '  if [ -n "$tmax" ]; then',
    '    if [ "$HAVE_AWK" = 1 ]; then',
    `      tempc=$(awk -v t="$tmax" 'BEGIN{printf "%.1f", t/1000}')`,
    "    else",
    "      tempc=$((tmax / 1000))",
    "    fi",
    "  fi",
    "",
    "  nowline=$(grep '^cpu' /proc/stat 2>/dev/null)",
    "  prevline=''",
    '  prevfile="$DIR/.cpu.prev"',
    '  if [ -s "$prevfile" ]; then prevline=$(cat "$prevfile" 2>/dev/null); fi',
    '  if [ -z "$prevline" ]; then',
    "    sleep 0.2 2>/dev/null || sleep 1",
    "    prevline=$nowline",
    "    nowline=$(grep '^cpu' /proc/stat 2>/dev/null)",
    "  fi",
    `  printf '%s\\n' "$nowline" > "$prevfile" 2>/dev/null`,
    "",
    "  cores='[]'",
    "  usagetotal=''",
    '  if [ "$HAVE_AWK" = 1 ] && [ -n "$prevline" ] && [ -n "$nowline" ]; then',
    `    printf '%s\\n' "$prevline" > "$DIR/.cpu.a" 2>/dev/null`,
    `    printf '%s\\n' "$nowline" > "$DIR/.cpu.b" 2>/dev/null`,
    `    agg=$(paste -d' ' "$DIR/.cpu.a" "$DIR/.cpu.b" 2>/dev/null | awk '`,
    "      function pct(t, i,   v) {",
    '        if (t <= 0) return "0.0"',
    "        v = (t - i) * 100 / t",
    "        if (v < 0) v = 0",
    "        if (v > 100) v = 100",
    '        return sprintf("%.1f", v)',
    "      }",
    "      {",
    "        half = int((NF - 2) / 2)",
    "        if (half < 1) next",
    "        m = (half > 8) ? 8 : half",
    "        t1 = 0; i1 = 0; t2 = 0; i2 = 0",
    "        for (k = 0; k < m; k++) { v = $(2 + k); t1 += v; if (k == 3 || k == 4) i1 += v }",
    "        for (k = 0; k < m; k++) { v = $(half + 3 + k); t2 += v; if (k == 3 || k == 4) i2 += v }",
    '        if ($1 == "cpu") { printf("TOTAL %s\\n", pct(t2 - t1, i2 - i1)) }',
    '        else { idx = $1; sub(/^cpu/, "", idx); printf("CORE %d %s\\n", idx, pct(t2 - t1, i2 - i1)) }',
    "      }')",
    '    if [ -n "$agg" ]; then',
    `      usagetotal=$(printf '%s\\n' "$agg" | awk '/^TOTAL/{print $2; exit}')`,
    `      cjson=$(printf '%s\\n' "$agg" | awk '/^CORE/{printf "%s{\\"index\\":%d,\\"usage\\":%s}", (c++ ? "," : ""), $2, $3}')`,
    '      cores="[$cjson]"',
    "    fi",
    "  fi",
    "",
    "  printf '{'",
    "  SEP=''",
    '  kv usage "$(fnum "$usagetotal")"',
    '  kv cores "$cores"',
    '  [ -n "$model" ] && kv model "$(jstr "$model")"',
    '  [ -n "$logical" ] && kv logicalCount "$(num "$logical")"',
    '  [ -n "$physical" ] && kv physicalCount "$(num "$physical")"',
    '  [ -n "$tempc" ] && kv temperatureC "$(fnum "$tempc")"',
    "  printf '}'",
    "}",
    "",
    "# ── memory ────────────────────────────────────────────────────────────────",
    "m_memory() {",
    "  [ -r /proc/meminfo ] || return 0",
    `  vals=$(awk '/^(MemTotal|MemFree|Buffers|Cached|SReclaimable|SwapTotal|SwapFree):/{n=$1; sub(/:$/,"",n); printf "%s %s\\n", n, $2}' /proc/meminfo 2>/dev/null)`,
    "  totalK=''; freeK=''; buffK=''; cacheK=''; srecK=''; swapTotK=''; swapFreeK=''",
    "  while read -r k v; do",
    '    case "$k" in',
    "      MemTotal) totalK=$v ;;",
    "      MemFree) freeK=$v ;;",
    "      Buffers) buffK=$v ;;",
    "      Cached) cacheK=$v ;;",
    "      SReclaimable) srecK=$v ;;",
    "      SwapTotal) swapTotK=$v ;;",
    "      SwapFree) swapFreeK=$v ;;",
    "    esac",
    "  done <<EOF",
    "$vals",
    "EOF",
    '  total=$(num "$totalK")',
    '  [ "$total" -gt 0 ] || return 0',
    '  free_m=$(num "$freeK"); buff=$(num "$buffK"); cache=$(num "$cacheK"); srec=$(num "$srecK")',
    "  cached=$(( (buff + cache + srec) * 1024 ))",
    "  usedk=$(( total - free_m - buff - cache - srec ))",
    '  [ "$usedk" -lt 0 ] && usedk=0',
    '  swapt=$(num "$swapTotK"); swapf=$(num "$swapFreeK")',
    "  swusedk=$(( swapt - swapf ))",
    '  [ "$swusedk" -lt 0 ] && swusedk=0',
    "",
    "  printf '{'",
    "  SEP=''",
    '  kv totalBytes "$(( total * 1024 ))"',
    '  kv usedBytes "$(( usedk * 1024 ))"',
    '  kv freeBytes "$(( free_m * 1024 ))"',
    '  [ "$cached" -gt 0 ] && kv cachedBytes "$cached"',
    '  if [ "$swapt" -gt 0 ]; then',
    '    kv swapTotalBytes "$(( swapt * 1024 ))"',
    '    kv swapUsedBytes "$(( swusedk * 1024 ))"',
    "  fi",
    "  printf '}'",
    "}",
    "",
    "# ── network (rates from cached counters) ──────────────────────────────────",
    "m_network() {",
    "  [ -r /proc/net/dev ] || return 0",
    "  raw=$(awk '",
    "    NR > 2 {",
    "      line = $0",
    '      sub(/^[ \\t]+/, "", line)',
    '      i = index(line, ":")',
    "      if (i == 0) next",
    "      name = substr(line, 1, i - 1)",
    "      rest = substr(line, i + 1)",
    '      sub(/^[ \\t]+/, "", rest)',
    '      split(rest, f, " ")',
    '      if (name == "lo" || name == "docker0" || name ~ /^veth/) next',
    "      print name, f[1], f[9]",
    "    }' /proc/net/dev 2>/dev/null)",
    '  [ -z "$raw" ] && return 0',
    "",
    '  now_ts=$(num "$(date +%s 2>/dev/null)")',
    "  prev_ts=0",
    '  [ -s "$DIR/.net.ts" ] && prev_ts=$(num "$(cat "$DIR/.net.ts" 2>/dev/null)")',
    "  prevdata=''",
    '  [ -s "$DIR/.net.prev" ] && prevdata=$(cat "$DIR/.net.prev" 2>/dev/null)',
    `  printf '%s' "$now_ts" > "$DIR/.net.ts" 2>/dev/null`,
    `  printf '%s\\n' "$raw" > "$DIR/.net.prev" 2>/dev/null`,
    "  dt=$(( now_ts - prev_ts ))",
    "",
    "  ifaces=''; rxtot=0; txtot=0; rxspd=0; txspd=0",
    "  while read -r name rx tx; do",
    '    [ -z "$name" ] && continue',
    '    rx=$(num "$rx"); tx=$(num "$tx")',
    "    rxtot=$(( rxtot + rx )); txtot=$(( txtot + tx ))",
    "    irx=''; itx=''",
    '    if [ "$dt" -gt 0 ] && [ -n "$prevdata" ]; then',
    `      p=$(printf '%s\\n' "$prevdata" | grep "^$name " | head -n1)`,
    '      if [ -n "$p" ]; then',
    "        set -- $p",
    '        prx=$(num "$2"); ptx=$(num "$3")',
    "        drx=$(( rx - prx )); dtx=$(( tx - ptx ))",
    '        [ "$drx" -lt 0 ] && drx=0',
    '        [ "$dtx" -lt 0 ] && dtx=0',
    "        irx=$(( drx / dt )); itx=$(( dtx / dt ))",
    "        rxspd=$(( rxspd + irx )); txspd=$(( txspd + itx ))",
    "      fi",
    "    fi",
    '    item="{\\"name\\":$(jstr "$name"),\\"rxBytes\\":$rx,\\"txBytes\\":$tx"',
    '    [ -n "$irx" ] && item="$item,\\"rxSpeed\\":$irx,\\"txSpeed\\":$itx"',
    '    item="$item}"',
    '    if [ -z "$ifaces" ]; then ifaces=$item; else ifaces="$ifaces,$item"; fi',
    "  done <<EOF",
    "$raw",
    "EOF",
    "",
    "  printf '{'",
    "  SEP=''",
    '  kv interfaces "[$ifaces]"',
    '  kv rxTotalBytes "$rxtot"',
    '  kv txTotalBytes "$txtot"',
    '  kv rxSpeed "$rxspd"',
    '  kv txSpeed "$txspd"',
    "  printf '}'",
    "}",
    "",
    "# base device name: sda1 -> sda, nvme0n1p2 -> nvme0n1, mmcblk0p1 -> mmcblk0",
    `devbase_awk='function b(nm){ if(nm ~ /^nvme[0-9]+n[0-9]+/){match(nm,/^nvme[0-9]+n[0-9]+/);return substr(nm,1,RLENGTH)} if(nm ~ /^mmcblk[0-9]+/){match(nm,/^mmcblk[0-9]+/);return substr(nm,1,RLENGTH)} if(nm ~ /^[a-z]+[0-9]+$/){sub(/[0-9]+$/,"",nm)} return nm }'`,
    "devbase() {",
    `  [ "$HAVE_AWK" = 1 ] || { printf '%s' "$1"; return 0; }`,
    `  printf '%s' "$1" | awk "$devbase_awk"' { print b($1) }' 2>/dev/null`,
    "}",
    "",
    "# ── disk (per-partition usage + device throughput) ────────────────────────",
    "m_disk() {",
    "  spd=''",
    "  readspeed=0; writespeed=0",
    '  if [ "$HAVE_AWK" = 1 ] && [ -r /proc/diskstats ]; then',
    '    now_ts=$(num "$(date +%s 2>/dev/null)")',
    "    prev_ts=0",
    '    [ -s "$DIR/.disk.ts" ] && prev_ts=$(num "$(cat "$DIR/.disk.ts" 2>/dev/null)")',
    "    prevdata=''",
    '    [ -s "$DIR/.disk.prev" ] && prevdata=$(cat "$DIR/.disk.prev" 2>/dev/null)',
    "    cur=$(awk '$3 ~ /^(sd|vd|hd|xvd|nvme|mmcblk|loop)/ { print $3, $6, $10 }' /proc/diskstats 2>/dev/null)",
    `    printf '%s' "$now_ts" > "$DIR/.disk.ts" 2>/dev/null`,
    `    printf '%s\\n' "$cur" > "$DIR/.disk.prev" 2>/dev/null`,
    "    dt=$(( now_ts - prev_ts ))",
    '    if [ "$dt" -gt 0 ] && [ -n "$prevdata" ] && [ -n "$cur" ]; then',
    `      printf '%s\\n' "$prevdata" > "$DIR/.disk.p" 2>/dev/null`,
    `      printf '%s\\n' "$cur" > "$DIR/.disk.c" 2>/dev/null`,
    `      spd=$(awk -v dt="$dt" "$devbase_awk"'`,
    "        NR == FNR { bb = b($1); if ($1 == bb) { pr[bb] = $2; pw[bb] = $3 } next }",
    '        { bb = b($1); if ($1 == bb) { dr = $2 - pr[bb]; dw = $3 - pw[bb]; if (dr < 0) dr = 0; if (dw < 0) dw = 0; printf "%s %d %d\\n", bb, dr * 512 / dt, dw * 512 / dt } }',
    `      ' "$DIR/.disk.p" "$DIR/.disk.c" 2>/dev/null)`,
    '      if [ -n "$spd" ]; then',
    `        readspeed=$(printf '%s\\n' "$spd" | awk '{ s += $2 } END { printf "%d", s + 0 }')`,
    `        writespeed=$(printf '%s\\n' "$spd" | awk '{ s += $3 } END { printf "%d", s + 0 }')`,
    "      fi",
    "    fi",
    "  fi",
    "",
    "  parts=''",
    "  dfout=$(df -kP 2>/dev/null | tail -n +2)",
    "  while read -r dev kb used avail cap mount; do",
    '    [ -z "$mount" ] && continue',
    '    kb=$(num "$kb"); used=$(num "$used"); avail=$(num "$avail")',
    '    [ "$kb" -gt 0 ] || continue',
    "    typ=''",
    `    [ -r /proc/mounts ] && typ=$(awk -v m="$mount" '$2 == m { print $3; exit }' /proc/mounts 2>/dev/null)`,
    '    case "$typ" in tmpfs|devtmpfs|squashfs|efivarfs) continue ;; esac',
    `    pct=$(num "$(printf '%s' "$cap" | tr -dc '0-9')")`,
    '    [ "$pct" -gt 0 ] || pct=$(( used * 100 / kb ))',
    '    [ "$pct" -gt 100 ] && pct=100',
    "    rs=''; ws=''",
    '    if [ -n "$spd" ]; then',
    '      base=$(devbase "$(basename "$dev")")',
    '      if [ -n "$base" ]; then',
    `        row=$(printf '%s\\n' "$spd" | grep "^$base " | head -n1)`,
    '        if [ -n "$row" ]; then set -- $row; rs=$(num "$2"); ws=$(num "$3"); fi',
    "      fi",
    "    fi",
    '    item="{\\"mount\\":$(jstr "$mount"),\\"device\\":$(jstr "$dev"),\\"fsType\\":$(jstr "$typ"),\\"totalBytes\\":$(( kb * 1024 )),\\"usedBytes\\":$(( used * 1024 )),\\"availableBytes\\":$(( avail * 1024 )),\\"usedPercent\\":$pct"',
    '    [ -n "$rs" ] && item="$item,\\"readSpeed\\":$rs,\\"writeSpeed\\":$ws"',
    '    item="$item}"',
    '    if [ -z "$parts" ]; then parts=$item; else parts="$parts,$item"; fi',
    "  done <<EOF",
    "$dfout",
    "EOF",
    "",
    "  printf '{'",
    "  SEP=''",
    '  kv partitions "[$parts]"',
    '  kv readSpeed "$readspeed"',
    '  kv writeSpeed "$writespeed"',
    "  printf '}'",
    "}",
    "",
    "# ── process (GNU ps / busybox ps / procfs backends) ───────────────────────",
    `awk_esc='function esc(s){ gsub(/\\\\/,"\\\\\\\\",s); gsub(/"/,"\\\\\\"",s); gsub(/\\r/,"",s); return s }`,
    "function kb(v,   n, u) {",
    '  if (v == "") return 0',
    "  n = v + 0",
    "  u = substr(v, length(v), 1)",
    '  if (u == "m" || u == "M") return n * 1024',
    '  if (u == "g" || u == "G") return n * 1024 * 1024',
    '  if (u == "t" || u == "T") return n * 1024 * 1024 * 1024',
    "  return n",
    "}'",
    "",
    "# GNU ps / procps: pcpu is reported directly (may exceed 100 on multi-core)",
    "ps_gnu() {",
    "  out=$(ps -eww -o pid=,stat=,pcpu=,rss=,user=,args= 2>/dev/null)",
    '  [ -z "$out" ] && return 0',
    `  set -- $(printf '%s\\n' "$out" | head -n1)`,
    `  case "\${1:-}" in ''|*[!0-9]*) return 0 ;; esac`,
    "  [ $# -ge 6 ] || return 0",
    `  printf '%s\\n' "$out" | awk -v mt="$memtotal" "$awk_esc"'`,
    "    /^[ \\t]*[0-9]+[ \\t]/ {",
    "      pid = $1; state = $2; cpu = $3 + 0; rss = kb($4); user = $5",
    '      cmd = ""; for (i = 6; i <= NF; i++) cmd = cmd (i > 6 ? " " : "") $i',
    "      if (length(cmd) > 160) cmd = substr(cmd, 1, 160)",
    "      mem = (mt > 0) ? rss * 100 / mt : 0",
    '      printf "%.1f\\t%d\\t%.1f\\t%s\\t%s\\t%s\\n", cpu, pid, mem, esc(user), esc(state), esc(cmd)',
    "    }' 2>/dev/null",
    "}",
    "",
    "# busybox ps with a `time` column (CPU% from cumulative CPU time deltas)",
    `ps_time_awk="$awk_esc"'`,
    "  function secs(t,   n, a, d) {",
    '    if (t == "") return 0',
    "    r = 0",
    '    if (index(t, "-") > 0) { n = split(t, d, "-"); r = d[1] * 86400; t = d[2] }',
    '    n = split(t, a, ":")',
    "    if (n == 3) return r + a[1] * 3600 + a[2] * 60 + a[3]",
    "    if (n == 2) return r + a[1] * 60 + a[2]",
    "    return r + t",
    "  }",
    '  BEGIN { while ((getline line < pf) > 0) { split(line, p, " "); prev[p[1]] = secs(p[2]) } close(pf) }',
    "  /^[ \\t]*[0-9]+[ \\t]/ {",
    "    pid = $1; state = $2; rss = kb($3); t = $4; user = $5",
    '    cmd = ""; for (i = 6; i <= NF; i++) cmd = cmd (i > 6 ? " " : "") $i',
    "    if (length(cmd) > 160) cmd = substr(cmd, 1, 160)",
    "    cur = secs(t); cpu = 0",
    "    if ((pid in prev) && dt > 0) { cpu = (cur - prev[pid]) * 100 / dt; if (cpu < 0) cpu = 0 }",
    "    mem = (mt > 0) ? rss * 100 / mt : 0",
    '    printf "%.1f\\t%d\\t%.1f\\t%s\\t%s\\t%s\\n", cpu, pid, mem, esc(user), esc(state), esc(cmd)',
    "  }'",
    "",
    "ps_bb_time() {",
    "  out=$(ps -o pid=,stat=,rss=,time=,user=,args= 2>/dev/null)",
    '  [ -z "$out" ] && return 0',
    `  set -- $(printf '%s\\n' "$out" | head -n1)`,
    `  case "\${1:-}" in ''|*[!0-9]*) return 0 ;; esac`,
    "  [ $# -ge 5 ] || return 0",
    '  now_ts=$(num "$(date +%s 2>/dev/null)")',
    "  prev_ts=0",
    '  [ -s "$DIR/.procb.ts" ] && prev_ts=$(num "$(cat "$DIR/.procb.ts" 2>/dev/null)")',
    "  dt=$(( now_ts - prev_ts ))",
    `  printf '%s' "$now_ts" > "$DIR/.procb.ts" 2>/dev/null`,
    '  oldf="$DIR/.procb.old"',
    '  rm -f "$oldf" 2>/dev/null',
    '  [ -s "$DIR/.procb.prev" ] && mv "$DIR/.procb.prev" "$oldf" 2>/dev/null',
    `  printf '%s\\n' "$out" | awk '{ print $1, $4 }' > "$DIR/.procb.prev" 2>/dev/null`,
    `  printf '%s\\n' "$out" | awk -v mt="$memtotal" -v dt="$dt" -v pf="$oldf" "$ps_time_awk" 2>/dev/null`,
    "}",
    "",
    "# busybox ps without CPU time (busybox >= 1.3x dropped `time` from -o):",
    "# pid/stat/rss/user/args still work, CPU is reported as 0 and the list is",
    "# ordered by memory instead (see the multi-key sort in m_process).",
    "ps_bb_basic() {",
    "  out=$(ps -o pid=,stat=,rss=,user=,args= 2>/dev/null)",
    '  if [ -z "$out" ]; then',
    "    out=$(ps -o pid,stat,rss,user,args 2>/dev/null | tail -n +2)",
    "  fi",
    '  [ -z "$out" ] && return 0',
    `  set -- $(printf '%s\\n' "$out" | head -n1)`,
    `  case "\${1:-}" in ''|*[!0-9]*) return 0 ;; esac`,
    "  [ $# -ge 5 ] || return 0",
    `  printf '%s\\n' "$out" | awk -v mt="$memtotal" "$awk_esc"'`,
    "    /^[ \\t]*[0-9]+[ \\t]/ {",
    "      pid = $1; state = $2; rss = kb($3); user = $4",
    '      cmd = ""; for (i = 5; i <= NF; i++) cmd = cmd (i > 5 ? " " : "") $i',
    "      if (length(cmd) > 160) cmd = substr(cmd, 1, 160)",
    "      mem = (mt > 0) ? rss * 100 / mt : 0",
    '      printf "0.0\\t%d\\t%.1f\\t%s\\t%s\\t%s\\n", pid, mem, esc(user), esc(state), esc(cmd)',
    "    }' 2>/dev/null",
    "}",
    "",
    "# last resort: walk /proc/[0-9]*/stat directly (needs no ps at all)",
    "ps_procfs() {",
    '  clk=$(num "$(getconf CLK_TCK 2>/dev/null)"); [ "$clk" -gt 0 ] || clk=100',
    '  pg=$(num "$(getconf PAGESIZE 2>/dev/null)"); [ "$pg" -gt 0 ] || pg=4096',
    '  now_ts=$(num "$(date +%s 2>/dev/null)")',
    "  prev_ts=0",
    '  [ -s "$DIR/.procf.ts" ] && prev_ts=$(num "$(cat "$DIR/.procf.ts" 2>/dev/null)")',
    "  dt=$(( now_ts - prev_ts ))",
    `  printf '%s' "$now_ts" > "$DIR/.procf.ts" 2>/dev/null`,
    `  awk -v mt="$memtotal" -v clk="$clk" -v pg="$pg" -v dt="$dt" -v pf="$DIR/.procf.prev" "$awk_esc"'`,
    '    BEGIN { while ((getline line < pf) > 0) { split(line, p, " "); prev[p[1]] = p[2] + 0 } close(pf) }',
    "    {",
    "      raw = $0",
    "      pid = $1",
    "      body = raw",
    '      sub(/^[0-9]+ \\([^)]*\\) /, "", body)',
    '      split(body, f, " ")',
    "      state = f[1]; ut = f[12]; st = f[13]; rss = f[22]",
    '      if (pid == "" || state == "" || ut == "") next',
    "      ticks = ut + st",
    "      cpu = 0",
    "      if (dt > 0 && (pid in prev)) { cpu = (ticks - prev[pid]) * 100 / dt / clk; if (cpu < 0) cpu = 0 }",
    "      mem = (mt > 0) ? (rss + 0) * pg / 1024 * 100 / mt : 0",
    "      comm = raw",
    '      sub(/^[0-9]+ \\(/, "", comm)',
    '      sub(/\\) .*$/, "", comm)',
    '      printf "%.1f\\t%d\\t%.1f\\t\\t%s\\t%s\\n", cpu, pid, mem, esc(state), esc(comm)',
    "      print pid, ticks > pf",
    "    }' /proc/[0-9]*/stat 2>/dev/null",
    "}",
    "",
    "m_process() {",
    `  memtotal=$(num "$(awk '/^MemTotal:/{ print $2; exit }' /proc/meminfo 2>/dev/null)")`,
    '  cached=$(cat "$DIR/.proc.backend" 2>/dev/null)',
    "  rows=''",
    '  case "$cached" in',
    "    gnu) rows=$(ps_gnu) ;;",
    "    bbtime) rows=$(ps_bb_time) ;;",
    "    procfs) rows=$(ps_procfs) ;;",
    "    bbbasic) rows=$(ps_bb_basic) ;;",
    "  esac",
    '  if [ -z "$rows" ]; then',
    "    be=''",
    '    rows=$(ps_gnu); [ -n "$rows" ] && be=gnu',
    '    if [ -z "$rows" ]; then rows=$(ps_bb_time); [ -n "$rows" ] && be=bbtime; fi',
    '    if [ -z "$rows" ]; then rows=$(ps_procfs); [ -n "$rows" ] && be=procfs; fi',
    '    if [ -z "$rows" ]; then rows=$(ps_bb_basic); [ -n "$rows" ] && be=bbbasic; fi',
    `    [ -n "$be" ] && printf '%s' "$be" > "$DIR/.proc.backend" 2>/dev/null`,
    "  fi",
    '  [ -z "$rows" ] && return 0',
    "",
    `  sorted=$(printf '%s\\n' "$rows" | sort -t'	' -k1,1nr -k3,3nr 2>/dev/null)`,
    `  [ -z "$sorted" ] && sorted=$(printf '%s\\n' "$rows" | sort -t'	' -k1,1 -nr 2>/dev/null)`,
    '  [ -z "$sorted" ] && sorted=$rows',
    `  json=$(printf '%s\\n' "$sorted" | head -n "$LIMIT" | awk -F'\\t' "$awk_esc"'`,
    "    {",
    '      printf "%s{\\"pid\\":%d,\\"command\\":\\"%s\\",\\"cpu\\":%.1f,\\"memory\\":%.1f", (NR > 1 ? "," : ""), $2, esc($6), $1, $3',
    '      if ($4 != "") printf ",\\"user\\":\\"%s\\"", esc($4)',
    '      if ($5 != "") printf ",\\"state\\":\\"%s\\"", esc($5)',
    '      printf "}"',
    "    }' 2>/dev/null)",
    '  [ -z "$json" ] && return 0',
    `  printf '[%s]' "$json"`,
    "}",
    "",
    "# ── gpu (nvidia-smi; absent => module absent) ─────────────────────────────",
    "m_gpu() {",
    "  command -v nvidia-smi >/dev/null 2>&1 || return 0",
    "  csv=$(nvidia-smi --query-gpu=index,name,utilization.gpu,memory.total,memory.used,temperature.gpu --format=csv,noheader,nounits 2>/dev/null)",
    '  [ -z "$csv" ] && return 0',
    `  json=$(printf '%s\\n' "$csv" | awk -F', *' "$awk_esc"'`,
    "    NF >= 4 {",
    '      printf "%s{\\"index\\":%d,\\"name\\":\\"%s\\"", (NR > 1 ? "," : ""), $1, esc($2)',
    '      if ($3 != "" && $3 != "[N/A]") printf ",\\"utilization\\":%.1f", $3',
    '      if ($4 != "" && $4 != "[N/A]") printf ",\\"memoryTotalBytes\\":%d", $4 * 1048576',
    '      if ($5 != "" && $5 != "[N/A]") printf ",\\"memoryUsedBytes\\":%d", $5 * 1048576',
    '      if ($6 != "" && $6 != "[N/A]") printf ",\\"temperatureC\\":%.1f", $6',
    '      printf "}"',
    "    }' 2>/dev/null)",
    '  [ -z "$json" ] && return 0',
    `  printf '[%s]' "$json"`,
    "}",
    "",
    "# ── dispatch ──────────────────────────────────────────────────────────────",
    "emit() {",
    '  [ -z "$2" ] && return 0',
    `  if [ "$FIRST" = 1 ]; then FIRST=0; else printf ','; fi`,
    `  printf '"%s":%s' "$1" "$2"`,
    "}",
    "",
    "printf '{'",
    'for m in "$@"; do',
    "  v=''",
    '  case "$m" in',
    "    system) v=$(m_system) ;;",
    "    cpu) v=$(m_cpu) ;;",
    "    memory) v=$(m_memory) ;;",
    "    network) v=$(m_network) ;;",
    "    disk) v=$(m_disk) ;;",
    "    process) v=$(m_process) ;;",
    "    gpu) v=$(m_gpu) ;;",
    "  esac",
    '  emit "$m" "$v"',
    "done",
    "printf '}\\n'"
  ];
}
function extractJsonObject(stdout) {
  const text = stdout.trim();
  if (text.length === 0) return { value: null, warning: "采集输出为空" };
  const direct = tryParse(text);
  if (direct !== NOT_JSON) {
    return isRecord(direct) ? { value: direct } : { value: null, warning: "采集输出不是 JSON 对象" };
  }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    const sliced = tryParse(text.slice(start, end + 1));
    if (sliced !== NOT_JSON) {
      return isRecord(sliced) ? { value: sliced } : { value: null, warning: "采集输出不是 JSON 对象" };
    }
  }
  return { value: null, warning: "采集输出不是合法 JSON" };
}
function parseCollectorOutput(input) {
  const warnings = [];
  const snapshot = {
    sessionId: input.sessionId,
    at: input.at ?? (/* @__PURE__ */ new Date()).toISOString()
  };
  if (input.elapsedMs !== void 0) {
    snapshot.elapsedMs = Math.max(0, Math.round(input.elapsedMs));
  }
  const extracted = extractJsonObject(input.stdout);
  const payload = extracted.value;
  if (!payload) {
    if (extracted.warning) warnings.push(extracted.warning);
    snapshot.warnings = warnings;
    return snapshot;
  }
  for (const w of asArray(payload["warnings"])) {
    const s = asString(w);
    if (s) warnings.push(s);
  }
  const root = unwrapPayload(payload);
  const system = pickField("system", root, parseSystem(root["system"]), warnings);
  if (system) snapshot.system = system;
  const cpu = pickField("cpu", root, parseCpu(root["cpu"]), warnings);
  if (cpu) snapshot.cpu = cpu;
  const memory = pickField("memory", root, parseMemory(root["memory"]), warnings);
  if (memory) snapshot.memory = memory;
  const network = pickField("network", root, parseNetwork(root["network"]), warnings);
  if (network) snapshot.network = network;
  const disk = pickField("disk", root, parseDisk(root["disk"]), warnings);
  if (disk) snapshot.disk = disk;
  const processes = pickField(
    "process",
    root,
    parseProcesses(root["process"] ?? root["processes"]),
    warnings
  );
  if (processes) snapshot.processes = processes;
  const gpu = pickField("gpu", root, parseGpu(root["gpu"]), warnings);
  if (gpu) snapshot.gpu = gpu;
  for (const mod of input.requestedModules ?? []) {
    if (root[mod] === void 0 || root[mod] === null) {
      warnings.push(`模块 ${mod} 未返回数据`);
    }
  }
  if (warnings.length > 0) snapshot.warnings = warnings;
  return snapshot;
}
function parseSystem(raw) {
  if (!isRecord(raw)) return void 0;
  const out = {};
  const hostname = asString(raw["hostname"] ?? raw["host"]);
  const distro = asString(raw["distro"] ?? raw["id"] ?? raw["system"]);
  const release = asString(raw["release"] ?? raw["version"] ?? raw["versionId"]);
  const kernel = asString(raw["kernel"] ?? raw["releaseName"]);
  const arch = asString(raw["arch"] ?? raw["architecture"]);
  const timezone = asString(raw["timezone"] ?? raw["tz"]);
  const uptimeSeconds = asInt(raw["uptimeSeconds"] ?? raw["uptime"]);
  const users = asInt(raw["users"] ?? raw["userCount"]);
  const loadAvg = parseLoadAvg(raw["loadAvg"] ?? raw["load"]);
  if (hostname !== void 0) out.hostname = hostname;
  if (distro !== void 0) out.distro = distro;
  if (release !== void 0) out.release = release;
  if (kernel !== void 0) out.kernel = kernel;
  if (arch !== void 0) out.arch = arch;
  if (timezone !== void 0) out.timezone = timezone;
  if (uptimeSeconds !== void 0 && uptimeSeconds >= 0) out.uptimeSeconds = uptimeSeconds;
  if (users !== void 0 && users >= 0) out.users = users;
  if (loadAvg !== void 0) out.loadAvg = loadAvg;
  return Object.keys(out).length > 0 ? out : void 0;
}
function parseLoadAvg(raw) {
  let parts;
  if (Array.isArray(raw)) parts = raw;
  else if (typeof raw === "string") parts = raw.trim().split(/\s+/);
  else return void 0;
  const nums = [];
  for (const p of parts) {
    const n = asNumber(p);
    if (n !== void 0) nums.push(n < 0 ? 0 : n);
  }
  if (nums.length === 0) return void 0;
  return [nums[0] ?? 0, nums[1] ?? 0, nums[2] ?? 0];
}
function parseCpu(raw) {
  if (!isRecord(raw)) return void 0;
  const cores = [];
  asArray(raw["cores"] ?? raw["cpus"] ?? raw["core"]).forEach((item, i) => {
    const core = parseCore(item, i);
    if (core) cores.push(core);
  });
  cores.sort((a, b) => a.index - b.index);
  let usage = asNumber(raw["usage"] ?? raw["usagePercent"] ?? raw["load"]);
  if (usage === void 0 && cores.length > 0) {
    usage = cores.reduce((sum, c) => sum + c.usage, 0) / cores.length;
  }
  if (usage === void 0 && cores.length === 0) return void 0;
  const out = { usage: clampPercent(usage ?? 0), cores };
  const model = asString(raw["model"] ?? raw["modelName"]);
  const logicalCount = asInt(raw["logicalCount"] ?? raw["logical"] ?? raw["coresCount"]);
  const physicalCount = asInt(raw["physicalCount"] ?? raw["physical"]);
  const temperatureC = asNumber(raw["temperatureC"] ?? raw["temperature"]);
  if (model !== void 0) out.model = model;
  if (logicalCount !== void 0 && logicalCount > 0) out.logicalCount = logicalCount;
  if (physicalCount !== void 0 && physicalCount > 0) out.physicalCount = physicalCount;
  if (temperatureC !== void 0 && temperatureC > -273) out.temperatureC = temperatureC;
  return out;
}
function parseCore(raw, fallbackIndex) {
  if (typeof raw === "number") {
    const n = asNumber(raw);
    return n === void 0 ? void 0 : { index: fallbackIndex, usage: clampPercent(n) };
  }
  if (!isRecord(raw)) return void 0;
  const index = asInt(raw["index"] ?? raw["cpu"] ?? raw["id"]) ?? fallbackIndex;
  const usage = asNumber(raw["usage"] ?? raw["load"] ?? raw["percent"] ?? raw["usagePercent"]);
  if (usage === void 0) return void 0;
  const core = { index: index < 0 ? fallbackIndex : index, usage: clampPercent(usage) };
  const mhz = asNumber(raw["mhz"] ?? raw["cpu MHz"] ?? raw["frequency"]);
  if (mhz !== void 0 && mhz > 0) core.mhz = mhz;
  return core;
}
function parseMemory(raw) {
  if (!isRecord(raw)) return void 0;
  const total = asNonNeg(raw["totalBytes"] ?? raw["total"]);
  if (total <= 0) return void 0;
  const out = {
    totalBytes: total,
    usedBytes: Math.min(asNonNeg(raw["usedBytes"] ?? raw["used"]), total),
    freeBytes: Math.min(asNonNeg(raw["freeBytes"] ?? raw["free"]), total)
  };
  const cached = asNumber(raw["cachedBytes"] ?? raw["cached"] ?? raw["buffcache"]);
  if (cached !== void 0 && cached > 0) out.cachedBytes = cached;
  const swapTotal = asNumber(raw["swapTotalBytes"] ?? raw["swapTotal"]);
  if (swapTotal !== void 0 && swapTotal > 0) {
    out.swapTotalBytes = swapTotal;
    const swapUsed = asNumber(raw["swapUsedBytes"] ?? raw["swapUsed"]);
    if (swapUsed !== void 0) {
      out.swapUsedBytes = Math.min(Math.max(0, swapUsed), swapTotal);
    }
  }
  return out;
}
function parseNetwork(raw) {
  if (!isRecord(raw)) return void 0;
  const interfaces = [];
  for (const item of asArray(raw["interfaces"] ?? raw["ifaces"])) {
    const iface = parseInterface(item);
    if (iface) interfaces.push(iface);
  }
  const rxTotalBytes = asNonNeg(
    raw["rxTotalBytes"] ?? raw["rxTotal"],
    interfaces.reduce((s, i) => s + i.rxBytes, 0)
  );
  const txTotalBytes = asNonNeg(
    raw["txTotalBytes"] ?? raw["txTotal"],
    interfaces.reduce((s, i) => s + i.txBytes, 0)
  );
  const rxSpeed = asNonNeg(
    raw["rxSpeed"] ?? raw["rxBytesPerSec"],
    interfaces.reduce((s, i) => s + (i.rxSpeed ?? 0), 0)
  );
  const txSpeed = asNonNeg(
    raw["txSpeed"] ?? raw["txBytesPerSec"],
    interfaces.reduce((s, i) => s + (i.txSpeed ?? 0), 0)
  );
  return { interfaces, rxTotalBytes, txTotalBytes, rxSpeed, txSpeed };
}
function parseInterface(raw) {
  if (!isRecord(raw)) return void 0;
  const name = asString(raw["name"] ?? raw["interface"] ?? raw["iface"]);
  if (name === void 0) return void 0;
  const out = {
    name,
    rxBytes: asNonNeg(raw["rxBytes"] ?? raw["rx"]),
    txBytes: asNonNeg(raw["txBytes"] ?? raw["tx"])
  };
  const rxSpeed = asNumber(raw["rxSpeed"] ?? raw["rxBytesPerSec"]);
  const txSpeed = asNumber(raw["txSpeed"] ?? raw["txBytesPerSec"]);
  if (rxSpeed !== void 0 && rxSpeed >= 0) out.rxSpeed = rxSpeed;
  if (txSpeed !== void 0 && txSpeed >= 0) out.txSpeed = txSpeed;
  return out;
}
function parseDisk(raw) {
  if (!isRecord(raw)) return void 0;
  const partitions = [];
  for (const item of asArray(raw["partitions"] ?? raw["fs"] ?? raw["mounts"])) {
    const part = parsePartition(item);
    if (part) partitions.push(part);
  }
  if (partitions.length === 0) return void 0;
  return {
    partitions,
    readSpeed: asNonNeg(raw["readSpeed"] ?? raw["readBytesPerSec"]),
    writeSpeed: asNonNeg(raw["writeSpeed"] ?? raw["writeBytesPerSec"])
  };
}
function parsePartition(raw) {
  if (!isRecord(raw)) return void 0;
  const mount = asString(raw["mount"] ?? raw["mountPoint"] ?? raw["target"] ?? raw["mountedOn"]);
  if (mount === void 0) return void 0;
  const totalBytes = asNonNeg(raw["totalBytes"] ?? raw["total"] ?? raw["size"]);
  const usedBytes = asNonNeg(raw["usedBytes"] ?? raw["used"]);
  const availableBytes = asNonNeg(raw["availableBytes"] ?? raw["available"] ?? raw["avail"]);
  let usedPercent = asNumber(raw["usedPercent"] ?? raw["percent"] ?? raw["usePct"]);
  if (usedPercent === void 0) {
    usedPercent = totalBytes > 0 ? usedBytes * 100 / totalBytes : 0;
  }
  const out = {
    mount,
    totalBytes,
    usedBytes,
    availableBytes,
    usedPercent: clampPercent(usedPercent)
  };
  const device = asString(raw["device"] ?? raw["filesystem"] ?? raw["source"]);
  const fsType = asString(raw["fsType"] ?? raw["type"] ?? raw["fstype"]);
  const readSpeed = asNumber(raw["readSpeed"]);
  const writeSpeed = asNumber(raw["writeSpeed"]);
  if (device !== void 0) out.device = device;
  if (fsType !== void 0) out.fsType = fsType;
  if (readSpeed !== void 0 && readSpeed >= 0) out.readSpeed = readSpeed;
  if (writeSpeed !== void 0 && writeSpeed >= 0) out.writeSpeed = writeSpeed;
  return out;
}
function parseProcesses(raw) {
  if (raw === void 0) return void 0;
  if (!Array.isArray(raw)) return void 0;
  const parsed = [];
  for (const item of raw) {
    const proc = parseProcess(item);
    if (proc) parsed.push(proc);
  }
  return parsed.map((p, i) => ({ p, i })).sort((a, b) => b.p.cpu - a.p.cpu || a.i - b.i).map(({ p }) => p);
}
function parseProcess(raw) {
  if (!isRecord(raw)) return void 0;
  const pid = asInt(raw["pid"] ?? raw["PID"]);
  if (pid === void 0 || pid < 0) return void 0;
  const out = {
    pid,
    command: asString(raw["command"] ?? raw["cmd"] ?? raw["comm"] ?? raw["args"] ?? raw["name"]) ?? String(pid),
    // 多核下 top 系工具的单进程 CPU 可以 >100%，这里不裁剪，保留原意
    cpu: Math.max(0, asNumber(raw["cpu"] ?? raw["pcpu"] ?? raw["%cpu"]) ?? 0),
    memory: clampPercent(asNumber(raw["memory"] ?? raw["mem"] ?? raw["%mem"] ?? raw["pmem"]) ?? 0)
  };
  const user = asString(raw["user"] ?? raw["username"] ?? raw["owner"]);
  const state = asString(raw["state"] ?? raw["stat"] ?? raw["status"]);
  if (user !== void 0) out.user = user;
  if (state !== void 0) out.state = state;
  return out;
}
function parseGpu(raw) {
  if (!Array.isArray(raw)) return void 0;
  const out = [];
  raw.forEach((item, i) => {
    if (!isRecord(item)) return;
    const index = asInt(item["index"] ?? item["id"]) ?? i;
    const name = asString(item["name"] ?? item["model"]) ?? `GPU ${index}`;
    const gpu = { index: index < 0 ? i : index, name };
    const utilization = asNumber(item["utilization"] ?? item["usage"] ?? item["gpuUtil"]);
    const memoryTotalBytes = asNumber(item["memoryTotalBytes"] ?? item["memoryTotal"]);
    const memoryUsedBytes = asNumber(item["memoryUsedBytes"] ?? item["memoryUsed"]);
    const temperatureC = asNumber(item["temperatureC"] ?? item["temperature"]);
    if (utilization !== void 0 && utilization >= 0) gpu.utilization = clampPercent(utilization);
    if (memoryTotalBytes !== void 0 && memoryTotalBytes >= 0) {
      gpu.memoryTotalBytes = memoryTotalBytes;
    }
    if (memoryUsedBytes !== void 0 && memoryUsedBytes >= 0) {
      gpu.memoryUsedBytes = memoryUsedBytes;
    }
    if (temperatureC !== void 0 && temperatureC > -273) gpu.temperatureC = temperatureC;
    out.push(gpu);
  });
  return out;
}
const NOT_JSON = Symbol("not-json");
function tryParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return NOT_JSON;
  }
}
function pickField(moduleKey, root, parsed, warnings) {
  if (parsed !== void 0) return parsed;
  const raw = root[moduleKey];
  if (raw !== void 0 && raw !== null) warnings.push(`模块 ${moduleKey} 内容无法解析`);
  return void 0;
}
function unwrapPayload(root) {
  const keys = MONITOR_MODULES;
  if (keys.some((k) => k in root)) return root;
  for (const wrapper of ["data", "result", "payload", "stats"]) {
    const inner = root[wrapper];
    if (isRecord(inner) && keys.some((k) => k in inner)) return inner;
  }
  return root;
}
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function asArray(value) {
  return Array.isArray(value) ? value : [];
}
function asNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : void 0;
  if (typeof value === "string") {
    const cleaned = value.replace(/[,\s%]/g, "");
    if (cleaned.length === 0) return void 0;
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : void 0;
  }
  return void 0;
}
function asNonNeg(value, fallback = 0) {
  const n = asNumber(value);
  if (n === void 0 || n < 0) return fallback;
  return n;
}
function asInt(value) {
  const n = asNumber(value);
  return n === void 0 ? void 0 : Math.trunc(n);
}
function asString(value) {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : void 0;
  }
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return void 0;
}
function clampPercent(n) {
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(100, n);
}
const TIER_ORDER = ["fast", "medium", "slow"];
const BASE_TICK_MS = MONITOR_TIER_INTERVALS.fast;
const MIN_TICK_MS = 250;
const INSTALL_TIMEOUT_MS = 1e4;
const COLLECT_TIMEOUT_MS = 8e3;
const systemClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle)
};
const DEFAULT_CARDS = [
  { kind: "system", enabled: true, order: 0, tier: "medium" },
  { kind: "cpu", enabled: true, order: 1, tier: "fast" },
  { kind: "memory", enabled: true, order: 2, tier: "medium" },
  { kind: "network", enabled: true, order: 3, tier: "medium" },
  { kind: "disk", enabled: true, order: 4, tier: "slow" },
  { kind: "process", enabled: true, order: 5, tier: "medium" },
  { kind: "gpu", enabled: true, order: 6, tier: "slow" }
];
const SNAPSHOT_KEY_BY_CARD = {
  system: "system",
  cpu: "cpu",
  memory: "memory",
  network: "network",
  disk: "disk",
  process: "processes",
  gpu: "gpu"
};
function defaultSettings() {
  return {
    cards: DEFAULT_CARDS.map((c) => ({ ...c })),
    processLimit: DEFAULT_PROCESS_LIMIT,
    failurePauseThreshold: DEFAULT_FAILURE_PAUSE_THRESHOLD
  };
}
class MonitorCollector {
  constructor(transport, events, clock = systemClock) {
    this.transport = transport;
    this.events = events;
    this.clock = clock;
    this.sessions = /* @__PURE__ */ new Map();
    this.baseSettings = defaultSettings();
    this.disposed = false;
    this.lastSampleMs = 0;
  }
  // ── 查询 ────────────────────────────────────────────────────────────────
  /** 已登记会话的状态；未登记返回 'idle' */
  getStatus(sessionId) {
    return this.sessions.get(sessionId)?.status ?? "idle";
  }
  /** 会话配置优先；未登记则给默认配置的副本 */
  getSettings(sessionId) {
    const st = sessionId ? this.sessions.get(sessionId) : void 0;
    return cloneSettings(st?.settings ?? this.baseSettings);
  }
  /** 最近一次快照（不触发采集） */
  peek(sessionId) {
    return this.sessions.get(sessionId)?.lastSnapshot ?? null;
  }
  // ── 配置 ────────────────────────────────────────────────────────────────
  /**
   * 更新卡片配置。带 sessionId 时只作用于该会话；否则更新默认值
   * （已登记的会话保持自己的配置，新会话继承默认值）。
   *
   * 配置生效是**即时**的，不允许"改完开关要等下一次重连"：
   * - 关掉的卡片立刻从合并快照里摘掉（否则会停在上一次的旧数据上）；
   * - 正在采集的会话重排档位并立刻补采一次，新开的卡片不用等 30 秒。
   */
  setCards(cards, sessionId) {
    const normalized = cards.map((c) => ({ ...c }));
    const st = sessionId ? this.sessions.get(sessionId) : void 0;
    if (st) {
      st.settings.cards = normalized;
      this.pruneDisabled(st);
      if (st.status === "running" || st.status === "starting") {
        st.lastRun = { fast: 0, medium: 0, slow: 0 };
        this.schedule(st);
        void this.collectOnce(st, TIER_ORDER).catch(() => void 0);
      }
      return cloneSettings(st.settings);
    }
    this.baseSettings.cards = normalized;
    return cloneSettings(this.baseSettings);
  }
  /** 关掉的卡片不该继续显示上一次的数据（那是"关不掉"的错觉） */
  pruneDisabled(st) {
    const merged = st.merged;
    if (!merged) return;
    const snapshot = merged;
    for (const card of st.settings.cards) {
      if (card.enabled) continue;
      delete snapshot[SNAPSHOT_KEY_BY_CARD[card.kind]];
    }
    st.lastSnapshot = merged;
  }
  // ── 生命周期 ─────────────────────────────────────────────────────────────
  /**
   * 启动监控：重置失败计数 → 立刻采一次（含脚本安装）→ 排入分档调度。
   * 首次采集覆盖全部档位；失败不向调用方抛（通过 events 上报，含自动暂停）。
   */
  async start(sessionId, options = {}) {
    if (this.disposed) return null;
    const st = this.ensure(sessionId, options);
    if (st.status === "running" || st.status === "starting") {
      this.schedule(st);
      return st.lastSnapshot;
    }
    st.failures = 0;
    st.status = "starting";
    this.events.onStatus(sessionId, "starting");
    this.schedule(st);
    try {
      return await this.collectOnce(st, TIER_ORDER);
    } catch {
      return null;
    }
  }
  stop(sessionId) {
    const st = this.sessions.get(sessionId);
    if (!st) return;
    this.clearTimer(st);
    st.status = "stopped";
    this.events.onStatus(sessionId, "stopped");
  }
  /** 彻底移除会话状态（会话断开时调用，避免状态泄漏） */
  forget(sessionId) {
    const st = this.sessions.get(sessionId);
    if (st) this.clearTimer(st);
    this.sessions.delete(sessionId);
  }
  dispose() {
    this.disposed = true;
    for (const st of this.sessions.values()) this.clearTimer(st);
    this.sessions.clear();
  }
  // ── 取快照 ───────────────────────────────────────────────────────────────
  /**
   * 取快照。默认优先用缓存（一个快档周期内视为新鲜），
   * 并发调用合并到同一次采集；paused/stopped 且无缓存时返回空快照而不打扰远端。
   */
  async snapshot(sessionId, options = {}) {
    const st = this.ensure(sessionId);
    if (st.inFlight) return st.inFlight;
    if (options.force) return this.collectOnce(st, TIER_ORDER);
    if (st.lastSnapshot && this.clock.now() - st.lastSnapshotAt < MONITOR_TIER_INTERVALS.fast) {
      return st.lastSnapshot;
    }
    if (st.status === "paused" || st.status === "stopped") {
      return st.lastSnapshot ?? emptySnapshot$1(sessionId, nowIso(this.clock), "监控未运行，暂无快照");
    }
    return this.collectOnce(st, TIER_ORDER);
  }
  /** 手动刷新：清失败计数；若已暂停则恢复调度（用户显式要求继续） */
  async refresh(sessionId) {
    const st = this.ensure(sessionId);
    st.failures = 0;
    if (st.status === "paused") {
      st.status = "running";
      this.events.onStatus(sessionId, "running", "手动刷新，已恢复采集");
    }
    this.schedule(st);
    return this.collectOnce(st, TIER_ORDER);
  }
  // ── 调度 ────────────────────────────────────────────────────────────────
  ensure(sessionId, options = {}) {
    let st = this.sessions.get(sessionId);
    if (!st) {
      st = {
        sessionId,
        settings: cloneSettings(this.baseSettings),
        status: "stopped",
        timer: null,
        inFlight: null,
        failures: 0,
        installed: false,
        lastRun: { fast: 0, medium: 0, slow: 0 },
        lastSnapshot: null,
        lastSnapshotAt: 0,
        merged: null,
        source: "script"
      };
      this.sessions.set(sessionId, st);
    }
    if (options.cards) st.settings.cards = options.cards.map((c) => ({ ...c }));
    if (options.processLimit !== void 0) {
      st.settings.processLimit = clampInt(options.processLimit, 1, 200);
    }
    if (options.failurePauseThreshold !== void 0) {
      st.settings.failurePauseThreshold = clampInt(options.failurePauseThreshold, 1, 100);
    }
    return st;
  }
  schedule(st) {
    if (this.disposed || st.timer !== null) return;
    if (st.status === "paused" || st.status === "stopped") return;
    st.timer = this.clock.setTimeout(() => {
      st.timer = null;
      this.tick(st);
    }, this.nextDelay(st));
  }
  tick(st) {
    if (this.disposed) return;
    if (st.status === "paused" || st.status === "stopped") return;
    this.schedule(st);
    if (st.inFlight) return;
    const tiers = this.dueTiers(st);
    if (tiers.length === 0) return;
    void this.collectOnce(st, tiers).catch(() => {
    });
  }
  /** 已到期（该跑）的档位，按 fast → medium → slow 优先级返回 */
  dueTiers(st) {
    const now = this.clock.now();
    const due = [];
    for (const tier of TIER_ORDER) {
      if (now - st.lastRun[tier] >= MONITOR_TIER_INTERVALS[tier]) due.push(tier);
    }
    return due;
  }
  /**
   * 下一次唤醒的延迟 = 最近一个到期档位还剩多久。
   *
   * 用「最早到期时间」而不是固定 3s 节拍，是为了让 10s / 30s 档准点触发
   * （固定节拍会把 10s 档拖到 12s）。已到期（remaining ≤ 0）时给一个最小间隔，
   * 防止在 in-flight 期间忙等。
   */
  nextDelay(st) {
    const now = this.clock.now();
    let min = Number.POSITIVE_INFINITY;
    for (const tier of TIER_ORDER) {
      if (!this.tierEnabled(st, tier)) continue;
      const remaining = MONITOR_TIER_INTERVALS[tier] - (now - st.lastRun[tier]);
      min = Math.min(min, remaining);
    }
    if (!Number.isFinite(min)) return BASE_TICK_MS;
    return Math.min(Math.max(min, MIN_TICK_MS), MONITOR_TIER_INTERVALS.slow);
  }
  /** 该档位下是否还有启用的卡片（没有就不必为它安排唤醒） */
  tierEnabled(st, tier) {
    return st.settings.cards.some((c) => c.enabled && c.tier === tier);
  }
  recordRun(st, tiers) {
    const now = this.clock.now();
    for (const tier of tiers) st.lastRun[tier] = now;
  }
  clearTimer(st) {
    if (st.timer === null) return;
    this.clock.clearTimeout(st.timer);
    st.timer = null;
  }
  modulesForTiers(st, tiers) {
    const enabled = st.settings.cards.filter((c) => c.enabled && tiers.includes(c.tier));
    return modulesForCards(enabled);
  }
  // ── 采集 ────────────────────────────────────────────────────────────────
  /**
   * 发起一次采集；已有 in-flight 时直接复用它（订阅合并）。
   * 失败时 promise 会 reject（调用方决定吞还是上报），不产生未处理 rejection。
   */
  collectOnce(st, tiers) {
    if (st.inFlight) return st.inFlight;
    const run = this.runCollection(st, tiers);
    st.inFlight = run;
    void run.then(
      () => {
        if (st.inFlight === run) st.inFlight = null;
      },
      () => {
        if (st.inFlight === run) st.inFlight = null;
      }
    );
    return run;
  }
  async runCollection(st, tiers) {
    const startedAt = this.clock.now();
    this.recordRun(st, tiers);
    try {
      const modules = this.modulesForTiers(st, tiers);
      if (modules.length === 0) {
        return emptySnapshot$1(st.sessionId, nowIso(this.clock), "没有启用的监控卡片，未执行采集");
      }
      const collected = await this.collectPayload(st, modules, startedAt);
      const snapshot = parseCollectorOutput({
        sessionId: st.sessionId,
        stdout: collected.stdout,
        elapsedMs: this.clock.now() - startedAt,
        requestedModules: modules,
        at: nowIso(this.clock)
      });
      snapshot.source = collected.source;
      if (collected.agentVersion) snapshot.agentVersion = collected.agentVersion;
      const stderrNote = firstLine(collected.stderr ?? "");
      if (stderrNote) {
        snapshot.warnings = [...snapshot.warnings ?? [], stderrNote];
      }
      const merged = this.mergeSnapshot(st, snapshot);
      this.succeed(st, merged);
      return merged;
    } catch (err) {
      this.fail(st, err);
      throw err;
    }
  }
  /**
   * 取一次原始输出：**优先代理，拿不到就回退脚本**。
   *
   * 代理失败不能变成"监控坏了"——服务器没 python3、用户拒绝安装、
   * 代理被系统清理掉，都是正常情况，脚本模式一直可用。
   */
  async collectPayload(st, modules, startedAt) {
    if (this.transport.agentSample) {
      const sampled = await this.transport.agentSample(st.sessionId, modules, { processLimit: st.settings.processLimit }).catch(() => null);
      if (sampled) {
        st.source = "agent";
        this.lastSampleMs = this.clock.now() - startedAt;
        return {
          stdout: sampled.json,
          source: "agent",
          agentVersion: sampled.version
        };
      }
      st.source = "script";
    }
    await this.ensureInstalled(st);
    const result = await this.transport.exec(
      st.sessionId,
      collectCommand(modules, { processLimit: st.settings.processLimit }),
      COLLECT_TIMEOUT_MS
    );
    this.lastSampleMs = this.clock.now() - startedAt;
    return { stdout: result.stdout, stderr: result.stderr, source: "script" };
  }
  getLastSampleMs() {
    return this.lastSampleMs;
  }
  /**
   * 把本拍结果并到"已知的全部模块"上。
   *
   * 合并方向刻意是**本拍覆盖旧值**（而不是反过来）：磁盘用量、进程列表
   * 可能会变小/变短，沿用旧值会给出错误信息。只有本拍没采的模块才保留旧值。
   */
  mergeSnapshot(st, incoming) {
    const prev = st.merged;
    const pick = (next, old) => next ?? old;
    const merged = {
      sessionId: incoming.sessionId,
      at: incoming.at,
      ...incoming.elapsedMs === void 0 ? {} : { elapsedMs: incoming.elapsedMs },
      ...incoming.source === void 0 ? {} : { source: incoming.source },
      ...incoming.agentVersion === void 0 ? {} : { agentVersion: incoming.agentVersion }
    };
    const system = pick(incoming.system, prev?.system);
    const cpu = pick(incoming.cpu, prev?.cpu);
    const memory = pick(incoming.memory, prev?.memory);
    const network = pick(incoming.network, prev?.network);
    const disk = pick(incoming.disk, prev?.disk);
    const processes = pick(incoming.processes, prev?.processes);
    const gpu = pick(incoming.gpu, prev?.gpu);
    if (system) merged.system = system;
    if (cpu) merged.cpu = cpu;
    if (memory) merged.memory = memory;
    if (network) merged.network = network;
    if (disk) merged.disk = disk;
    if (processes) merged.processes = processes;
    if (gpu) merged.gpu = gpu;
    if (incoming.warnings && incoming.warnings.length > 0) merged.warnings = incoming.warnings;
    st.merged = merged;
    return merged;
  }
  /**
   * 脚本分发：只有远端 VERSION 与本地不一致（或文件缺失）才上传。
   * 一致时**只花一次 exec** 读版本号，之后 `installed` 缓存住，连版本号都不用再读。
   */
  async ensureInstalled(st) {
    if (st.installed) return;
    const check = await this.transport.exec(st.sessionId, versionCheckCommand(), INSTALL_TIMEOUT_MS);
    if (!needsInstall(parseRemoteVersion(check.stdout))) {
      st.installed = true;
      return;
    }
    const install = await this.transport.exec(st.sessionId, installCommand(), INSTALL_TIMEOUT_MS);
    if (!install.stdout.includes(INSTALL_OK_SENTINEL)) {
      throw new Error(`采集脚本安装失败（退出码 ${install.code}）`);
    }
    st.installed = true;
  }
  succeed(st, snapshot) {
    st.failures = 0;
    st.lastSnapshot = snapshot;
    st.lastSnapshotAt = this.clock.now();
    if (st.status === "starting") {
      st.status = "running";
      this.events.onStatus(st.sessionId, "running");
    }
    this.events.onSnapshot(st.sessionId, snapshot);
  }
  fail(st, err) {
    const message = err instanceof Error ? err.message : String(err);
    st.failures += 1;
    this.events.onError(st.sessionId, message);
    if (st.failures >= st.settings.failurePauseThreshold) {
      st.status = "paused";
      this.clearTimer(st);
      this.events.onStatus(
        st.sessionId,
        "paused",
        `连续 ${st.failures} 次采集失败，已自动暂停`
      );
    }
  }
}
function cloneSettings(settings) {
  return {
    cards: settings.cards.map((c) => ({ ...c })),
    processLimit: settings.processLimit,
    failurePauseThreshold: settings.failurePauseThreshold
  };
}
function nowIso(clock) {
  return new Date(clock.now()).toISOString();
}
function emptySnapshot$1(sessionId, at, warning) {
  return { sessionId, at, warnings: [warning] };
}
function firstLine(text) {
  const line = text.split(/\r?\n/).map((s) => s.trim()).find((s) => s.length > 0);
  if (!line) return void 0;
  return line.length > 200 ? `${line.slice(0, 200)}…` : line;
}
function clampInt(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}
let collector = null;
let agentService = null;
let activeCtx = null;
let closedSubscribed = false;
async function putRemoteFile(sessionId, remotePath, data, mode) {
  const { client } = requireSessionOrThrow(sessionId);
  const sftp = await new Promise((resolve2, reject) => {
    client.sftp((err, handle) => err ? reject(err) : resolve2(handle));
  });
  try {
    await new Promise((resolve2, reject) => {
      const stream = sftp.createWriteStream(remotePath, { mode, autoClose: true });
      stream.on("close", () => resolve2());
      stream.on("error", reject);
      stream.end(data);
    });
  } finally {
    sftp.end();
  }
}
function requireSessionOrThrow(sessionId) {
  try {
    return requireSession(sessionId);
  } catch (err) {
    throw AppError.notConnected(err instanceof Error ? err.message : String(err));
  }
}
function getCollector(ctx) {
  activeCtx = ctx;
  if (collector) return collector;
  const transport = {
    exec: (sessionId, command, timeoutMs) => {
      const session = requireSessionOrThrow(sessionId);
      return session.exec(command, timeoutMs === void 0 ? void 0 : { timeoutMs });
    },
    // 代理优先；AgentService 自己负责"没装就返回 null"，采集器据此回退脚本
    agentSample: (sessionId, modules, options) => getAgentService(ctx).sample(sessionId, modules, options)
  };
  collector = new MonitorCollector(transport, {
    onSnapshot: (sessionId, snapshot) => {
      activeCtx?.emit(Events.MONITOR_SNAPSHOT, { sessionId, snapshot });
    },
    onStatus: (sessionId, status, message) => {
      activeCtx?.emit(Events.MONITOR_STATUS, {
        sessionId,
        status,
        ...message === void 0 ? {} : { message }
      });
    },
    onError: (sessionId, message) => {
      activeCtx?.emit(Events.MONITOR_ERROR, { sessionId, message });
    }
  });
  if (!closedSubscribed) {
    closedSubscribed = true;
    subscribeSessionClosed((sessionId) => {
      collector?.forget(sessionId);
      agentService?.forget(sessionId);
    });
  }
  return collector;
}
function getAgentService(ctx) {
  if (agentService) return agentService;
  agentService = new AgentService(
    (sessionId, command, timeoutMs) => requireSessionOrThrow(sessionId).exec(command, timeoutMs === void 0 ? void 0 : { timeoutMs }),
    new AgentPrefs(join(ctx.paths.userData, "monitor-agents.json")),
    (sessionId, remotePath, data, mode) => putRemoteFile(sessionId, remotePath, data, mode)
  );
  return agentService;
}
const cardSchema = z.object({
  kind: z.enum(["system", "cpu", "memory", "network", "disk", "process", "gpu"]),
  enabled: z.boolean(),
  order: z.number().int(),
  tier: z.enum(["fast", "medium", "slow"])
});
const startSchema = z.object({
  sessionId: z.string().min(1),
  cards: z.array(cardSchema).max(32).optional(),
  processLimit: z.number().int().min(1).max(200).optional(),
  failurePauseThreshold: z.number().int().min(1).max(100).optional()
});
const sessionSchema = z.object({ sessionId: z.string().min(1) });
const snapshotSchema = z.object({
  sessionId: z.string().min(1),
  force: z.boolean().optional()
});
const cardsQuerySchema = z.object({ sessionId: z.string().min(1).optional() });
const setCardsSchema = z.object({
  sessionId: z.string().min(1).optional(),
  cards: z.array(cardSchema).max(32)
});
const declineSchema = z.object({
  sessionId: z.string().min(1),
  forever: z.boolean().optional()
});
const monitorHandlers = {
  /** 开始监控（幂等：重复 start 返回当前快照） */
  start: async (payload, ctx) => {
    const { sessionId, cards, processLimit, failurePauseThreshold } = startSchema.parse(payload);
    const target = getCollector(ctx);
    requireSessionOrThrow(sessionId);
    const settings = {
      ...cards === void 0 ? {} : { cards },
      ...processLimit === void 0 ? {} : { processLimit },
      ...failurePauseThreshold === void 0 ? {} : { failurePauseThreshold }
    };
    const snapshot = await target.start(sessionId, settings);
    return { sessionId, status: target.getStatus(sessionId), snapshot };
  },
  stop: (payload, ctx) => {
    const { sessionId } = sessionSchema.parse(payload);
    const target = getCollector(ctx);
    target.stop(sessionId);
    return { sessionId, status: target.getStatus(sessionId) };
  },
  /** 取当前快照：默认吃缓存（一个快档周期内），force 时强制重新采集 */
  getSnapshot: async (payload, ctx) => {
    const { sessionId, force } = snapshotSchema.parse(payload);
    const target = getCollector(ctx);
    if (force === true) {
      requireSessionOrThrow(sessionId);
      return target.snapshot(sessionId, { force: true });
    }
    const cached = target.peek(sessionId);
    if (cached) return cached;
    if (target.getStatus(sessionId) === "idle") return emptySnapshot(sessionId);
    return target.snapshot(sessionId);
  },
  listCards: (payload, ctx) => {
    const { sessionId } = cardsQuerySchema.parse(payload ?? {});
    return getCollector(ctx).getSettings(sessionId);
  },
  setCards: (payload, ctx) => {
    const { sessionId, cards } = setCardsSchema.parse(payload);
    return getCollector(ctx).setCards(cards, sessionId);
  },
  /** 手动刷新：清失败计数，已暂停则恢复调度 */
  refresh: async (payload, ctx) => {
    const { sessionId } = sessionSchema.parse(payload);
    requireSessionOrThrow(sessionId);
    return getCollector(ctx).refresh(sessionId);
  },
  /**
   * 探测远端监控代理。
   *
   * UI 在连接成功后调用：`installed=false && decision='ask'` 就弹窗问用户装不装。
   * 只探测，不安装 —— 装软件这种事必须用户点头。
   */
  probeAgent: async (payload, ctx) => {
    const { sessionId } = sessionSchema.parse(payload);
    const session = requireSessionOrThrow(sessionId);
    const probe = await getAgentService(ctx).probe(sessionId);
    return {
      ...probe,
      /**
       * sessionId 必须回传：渲染层拿到的是这一份，弹窗里的「安装 / 暂不 / 不再询问」
       * 都要靠它去调后续 IPC。少这个字段，点安装就是 `sessionId: Required`。
       */
      sessionId,
      host: session.host,
      port: session.port ?? null,
      username: session.username,
      /** 代理版本落后时也算"需要升级"，UI 文案不同 */
      needsUpgrade: probe.installed && probe.version !== null && probe.version !== AGENT_VERSION,
      agentVersion: AGENT_VERSION
    };
  },
  /** 安装并启动代理（用户点了"安装并启用"） */
  installAgent: async (payload, ctx) => {
    const { sessionId } = sessionSchema.parse(payload);
    requireSessionOrThrow(sessionId);
    const result = await getAgentService(ctx).install(sessionId);
    return { ...result, tunnel: "ssh-direct-tcpip" };
  },
  /** 停止代理（保留文件，下次连接会自动再启动） */
  stopAgent: async (payload, ctx) => {
    const { sessionId } = sessionSchema.parse(payload);
    requireSessionOrThrow(sessionId);
    await getAgentService(ctx).stop(sessionId, false);
    return { stopped: true };
  },
  /** 卸载代理（删文件 + 停止 + 记住"不再安装"） */
  uninstallAgent: async (payload, ctx) => {
    const { sessionId } = sessionSchema.parse(payload);
    requireSessionOrThrow(sessionId);
    await getAgentService(ctx).stop(sessionId, true);
    return { uninstalled: true };
  },
  /** 用户拒绝安装：forever=true 对应"不再询问这台服务器" */
  declineAgent: (payload, ctx) => {
    const { sessionId, forever } = declineSchema.parse(payload);
    getAgentService(ctx).decline(sessionId, forever === true);
    return { declined: true, forever };
  }
};
function emptySnapshot(sessionId) {
  return {
    sessionId,
    at: (/* @__PURE__ */ new Date()).toISOString(),
    warnings: ["该会话尚未开始监控"]
  };
}
export {
  monitorHandlers
};
