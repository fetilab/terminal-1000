import { app, nativeImage, BrowserWindow, shell, screen, dialog, Tray, Menu, globalShortcut, powerMonitor, ipcMain } from "electron";
import { isAbsolute, join, resolve, sep, dirname } from "node:path";
import { z } from "zod";
import { mkdirSync, existsSync, statSync, writeFileSync, readdirSync, readFileSync, copyFileSync, appendFileSync, unlinkSync } from "node:fs";
import { spawn } from "node:child_process";
import { connect } from "node:net";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { randomBytes, createCipheriv, createDecipheriv, scryptSync, timingSafeEqual, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { readFile } from "node:fs/promises";
import __cjs_mod__ from "node:module";
const __filename = import.meta.filename;
const __dirname = import.meta.dirname;
const require2 = __cjs_mod__.createRequire(import.meta.url);
const AI_TRAILING_RE = /[^\s?]\?\?$/;
const AI_PREFIX_RE = /^\s*\?\?(\s|$)/;
function detectAiSuggestion(line) {
  return AI_PREFIX_RE.test(line) || AI_TRAILING_RE.test(line);
}
function stripAiMarker(line) {
  if (AI_PREFIX_RE.test(line)) return line.replace(/^\s*\?\?\s*/, "");
  if (AI_TRAILING_RE.test(line)) return line.replace(/\s*\?\?$/, "");
  return line;
}
const Events = {
  // 应用
  APP_READY: "APP_READY",
  APP_THEME_CHANGED: "APP_THEME_CHANGED",
  // SSH 会话
  SSH_STATE: "SSH_STATE",
  SSH_DATA: "SSH_DATA",
  SSH_DEBUG: "SSH_DEBUG",
  SSH_ERROR: "SSH_ERROR",
  SSH_HOST_KEY_ASK: "SSH_HOST_KEY_ASK",
  SSH_AUTH_PROMPT: "SSH_AUTH_PROMPT",
  SSH_AUTH_RESULT: "SSH_AUTH_RESULT",
  SSH_CLOSED: "SSH_CLOSED",
  // SFTP
  SFTP_BUSY: "SFTP_BUSY",
  SFTP_TRANSFER_PROGRESS: "SFTP_TRANSFER_PROGRESS",
  SFTP_TRANSFER_FINISHED: "SFTP_TRANSFER_FINISHED",
  SFTP_TRANSFER_ERROR: "SFTP_TRANSFER_ERROR",
  SFTP_DIR_SCANNED: "SFTP_DIR_SCANNED",
  SFTP_WATCH_EVENT: "SFTP_WATCH_EVENT",
  /** Shell Integration：命令开始（OSC 133 B） */
  SHELL_COMMAND_START: "SHELL_COMMAND_START",
  /** Shell Integration：命令结束（OSC 133 D，带退出码） */
  SHELL_COMMAND_END: "SHELL_COMMAND_END",
  /** 远端编辑的改动已写回远端 */
  SFTP_EDIT_SAVED: "SFTP_EDIT_SAVED",
  /** 远端编辑写回/监听失败（必须让用户知道，否则他以为存到远端了） */
  SFTP_EDIT_ERROR: "SFTP_EDIT_ERROR",
  // 端口转发
  FORWARD_STATE: "FORWARD_STATE",
  FORWARD_INFO: "FORWARD_INFO",
  FORWARD_WARN: "FORWARD_WARN",
  FORWARD_ERROR: "FORWARD_ERROR",
  // 本地终端
  PTY_DATA: "PTY_DATA",
  PTY_EXIT: "PTY_EXIT",
  // 监控
  MONITOR_SNAPSHOT: "MONITOR_SNAPSHOT",
  MONITOR_STATUS: "MONITOR_STATUS",
  MONITOR_ERROR: "MONITOR_ERROR",
  // 快捷键
  HOTKEY_TRIGGERED: "HOTKEY_TRIGGERED",
  HOTKEY_STATUS: "HOTKEY_STATUS",
  // Telnet
  TELNET_DATA: "TELNET_DATA",
  TELNET_STATE: "TELNET_STATE",
  TELNET_CLOSED: "TELNET_CLOSED",
  TELNET_NEGOTIATION: "TELNET_NEGOTIATION",
  // 并发广播
  BROADCAST_STATE: "BROADCAST_STATE",
  /** 某个成员写入失败（广播的"部分失败"必须让用户看得见） */
  BROADCAST_ERROR: "BROADCAST_ERROR",
  // 安全 / 锁屏
  SECURITY_LOCKED: "SECURITY_LOCKED",
  SECURITY_UNLOCKED: "SECURITY_UNLOCKED",
  /** 备份结果（供界面如实显示成功/失败，而不是静默） */
  BACKUP_RESULT: "BACKUP_RESULT",
  // VNC（RFB）
  VNC_STATE: "VNC_STATE",
  VNC_FRAME: "VNC_FRAME",
  VNC_CLIPBOARD: "VNC_CLIPBOARD",
  VNC_BELL: "VNC_BELL",
  VNC_ERROR: "VNC_ERROR",
  // RDP（外部 FreeRDP 进程方案）
  RDP_STATE: "RDP_STATE",
  RDP_EXIT: "RDP_EXIT",
  // AI
  AI_DELTA: "AI_DELTA",
  AI_TOOL_CALL: "AI_TOOL_CALL",
  AI_TOOL_RESULT: "AI_TOOL_RESULT",
  AI_DONE: "AI_DONE",
  AI_ERROR: "AI_ERROR",
  // 同步
  SYNC_STATE: "SYNC_STATE",
  SYNC_PROGRESS: "SYNC_PROGRESS"
};
const IPC_CHANNEL = "t1000";
const IPC_DOMAINS = [
  "app",
  "store",
  "ssh",
  "sftp",
  "forward",
  "pty",
  "telnet",
  "vnc",
  "rdp",
  "monitor",
  "notes",
  "completion",
  "ai",
  "mcp",
  "sessionlog",
  "settings",
  "sync",
  "hotkey",
  "broadcast",
  "quickcmd",
  "system",
  "update",
  "shellIntegration"
];
const ipcRequestSchema = z.object({
  domain: z.enum(IPC_DOMAINS),
  action: z.string().min(1),
  payload: z.unknown()
});
const MONITOR_TIER_INTERVALS = {
  fast: 3e3,
  medium: 1e4,
  slow: 3e4
};
const LATENCY_UNREACHABLE = 9999;
class AppError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.detail = detail;
  }
  static badRequest(message, detail) {
    return new AppError("BAD_REQUEST", message, detail);
  }
  static notFound(message) {
    return new AppError("NOT_FOUND", message);
  }
  static conflict(message) {
    return new AppError("CONFLICT", message);
  }
  static unauthorized(message = "未授权") {
    return new AppError("UNAUTHORIZED", message);
  }
  static forbidden(message = "操作被拒绝") {
    return new AppError("FORBIDDEN", message);
  }
  static notConnected(message = "连接未建立") {
    return new AppError("NOT_CONNECTED", message);
  }
  static timeout(message = "操作超时") {
    return new AppError("TIMEOUT", message);
  }
  static unsupported(message) {
    return new AppError("UNSUPPORTED", message);
  }
  static internal(message, detail) {
    return new AppError("INTERNAL", message, detail);
  }
}
function toAppError(err) {
  if (err instanceof AppError) return err;
  if (isZodError(err)) {
    const detail = err.issues.map((i) => ({
      path: i.path.join("."),
      message: i.message,
      code: i.code
    }));
    const first = detail[0];
    const summary = first ? `${first.path || "<root>"}: ${first.message}` : "入参校验失败";
    return AppError.badRequest(`入参不合法 — ${summary}`, detail);
  }
  if (err instanceof Error) return AppError.internal(err.message);
  return AppError.internal(String(err));
}
function parseInput$1(schema, payload) {
  const result = schema.safeParse(payload);
  if (!result.success) throw toAppError(result.error);
  return result.data;
}
function isZodError(err) {
  if (typeof err !== "object" || err === null) return false;
  const e = err;
  if (e.name !== "ZodError") return false;
  return Array.isArray(e.issues);
}
const APP_DIR_NAME = "terminal-1000";
const MIGRATE_FILES = [
  "local-store.db",
  "local-store.db-wal",
  "local-store.db-shm",
  "known-hosts.json",
  "window-bounds.json"
];
const MIGRATE_DIRS = [
  "notes",
  "session-log",
  "watch",
  "backgrounds",
  "backups",
  "logs"
];
const MIGRATE_PROFILE_DIRS = ["Local Storage"];
function isInside(child, parent) {
  if (!child || !parent) return false;
  const c = normalize(resolve(child));
  const p = normalize(resolve(parent));
  if (c === p) return true;
  return c.startsWith(p.endsWith(sep) ? p : p + sep);
}
function normalize(p) {
  return process.platform === "win32" ? p.toLowerCase() : p;
}
function resolveDataDir(input) {
  const appData = input.appData && isAbsolute(input.appData) ? input.appData : "";
  const base = appData || fallbackConfigHome(input.platform, input.home);
  const candidate = join(base, APP_DIR_NAME);
  if (input.exeDir && isInside(candidate, input.exeDir)) {
    return { dir: join(input.home, `.${APP_DIR_NAME}`), relocatedFrom: candidate };
  }
  return { dir: candidate };
}
function fallbackConfigHome(platform, home) {
  if (platform === "win32") return join(home, "AppData", "Roaming");
  if (platform === "darwin") return join(home, "Library", "Application Support");
  return join(home, ".config");
}
function legacyCandidates(input) {
  const out = [];
  const push = (p) => {
    if (!p) return;
    if (!out.some((x) => resolve(x) === resolve(p))) out.push(p);
  };
  push(input.previousUserData);
  push(join(input.appData, "@t1000", "desktop"));
  push(join(input.appData, "@t1000desktop"));
  push(join(input.exeDir, "userData"));
  push(input.exeDir);
  return out;
}
const EMPTY_REPORT = { from: null, items: [], failed: [] };
function hasExistingStore(dir) {
  return existsSync(join(dir, "local-store.db"));
}
function scoreCandidate(dir) {
  if (!existsSync(dir)) return 0;
  let score = 0;
  if (existsSync(join(dir, "local-store.db"))) score += 100;
  if (existsSync(join(dir, "known-hosts.json"))) score += 20;
  if (existsSync(join(dir, "window-bounds.json"))) score += 5;
  for (const d of [...MIGRATE_DIRS, ...MIGRATE_PROFILE_DIRS]) {
    if (existsSync(join(dir, d))) score += 3;
  }
  return score;
}
function migrateDataDir(target, candidates2) {
  if (hasExistingStore(target)) return { ...EMPTY_REPORT };
  const ranked = candidates2.filter((c) => resolve(c) !== resolve(target)).map((c) => ({ dir: c, score: scoreCandidate(c) })).filter((c) => c.score > 0).sort((a, b) => b.score - a.score);
  const best = ranked[0];
  if (!best) return { ...EMPTY_REPORT };
  mkdirSync(target, { recursive: true });
  const items = [];
  const failed = [];
  for (const name of [...MIGRATE_FILES, ...MIGRATE_DIRS, ...MIGRATE_PROFILE_DIRS]) {
    const src = join(best.dir, name);
    if (!existsSync(src)) continue;
    const dst = join(target, name);
    if (existsSync(dst)) continue;
    try {
      const st = statSync(src);
      if (st.isDirectory()) {
        copyDir(src, dst);
        items.push({ name, kind: "dir" });
      } else {
        copyFile(src, dst);
        items.push({ name, kind: "file" });
      }
    } catch {
      failed.push(name);
    }
  }
  try {
    writeFileSync(
      join(target, "migration.json"),
      JSON.stringify(
        {
          from: best.dir,
          at: (/* @__PURE__ */ new Date()).toISOString(),
          appVersion: process.env.npm_package_version ?? null,
          items: items.map((i) => i.name),
          failed
        },
        null,
        2
      )
    );
  } catch {
  }
  return { from: best.dir, items, failed };
}
function copyFile(src, dst) {
  mkdirSync(dirname(dst), { recursive: true });
  try {
    copyFileSync(src, dst);
  } catch {
    writeFileSync(dst, readFileSync(src));
  }
}
function copyDir(src, dst) {
  mkdirSync(dst, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const s = join(src, entry.name);
    const d = join(dst, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else if (entry.isSymbolicLink()) {
      try {
        writeFileSync(d, readFileSync(s));
      } catch {
      }
    } else copyFile(s, d);
  }
}
let cached = null;
let prepared = null;
function prepareDataDir() {
  if (prepared) return prepared;
  const previous = app.getPath("userData");
  const appData = safePath("appData");
  const home = safePath("home");
  const exeDir = dirname(safePath("exe"));
  const { dir, relocatedFrom } = resolveDataDir({
    platform: process.platform,
    appData,
    home,
    exeDir
  });
  if (resolvePath$1(previous) !== resolvePath$1(dir)) {
    app.setPath("userData", dir);
  }
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const migration = migrateDataDir(
    dir,
    legacyCandidates({ appData, exeDir, previousUserData: previous })
  );
  prepared = { dir, previous, relocatedFrom, migration, exeDir };
  return prepared;
}
function safePath(key2) {
  try {
    return app.getPath(key2);
  } catch {
    return key2 === "exe" ? process.execPath : "";
  }
}
function resolvePath$1(p) {
  return p.replace(/[\\/]+$/, "");
}
function getAppPaths() {
  if (cached) return cached;
  const userData = prepareDataDir().dir;
  const paths = {
    userData,
    dbFile: join(userData, "local-store.db"),
    notesDir: join(userData, "notes"),
    sessionLogDir: join(userData, "session-log"),
    watchDir: join(userData, "watch"),
    bgImagesDir: join(userData, "backgrounds"),
    backupDir: join(userData, "backups"),
    logDir: join(userData, "logs")
  };
  for (const dir of [
    paths.notesDir,
    paths.sessionLogDir,
    paths.watchDir,
    paths.bgImagesDir,
    paths.backupDir,
    paths.logDir
  ]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
  cached = paths;
  return paths;
}
const LEVEL_ORDER = { debug: 10, info: 20, warn: 30, error: 40 };
const minLevel = process.env.T1000_LOG_LEVEL ?? "info";
let logFile = null;
function getLogFile() {
  if (!logFile) {
    const d = /* @__PURE__ */ new Date();
    const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
    logFile = join(getAppPaths().logDir, `main-${stamp}.log`);
  }
  return logFile;
}
function format(level, scope, message) {
  return `[${(/* @__PURE__ */ new Date()).toISOString()}] [${level.toUpperCase()}] [${scope}] ${message}`;
}
function write(level, scope, message, extra) {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return;
  const line = format(level, scope, message);
  const suffix = extra === void 0 ? "" : ` ${safeStringify(extra)}`;
  if (level === "error") console.error(line + suffix);
  else if (level === "warn") console.warn(line + suffix);
  else console.log(line + suffix);
  try {
    appendFileSync(getLogFile(), line + suffix + "\n");
  } catch {
  }
}
function safeStringify(value) {
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
function createLogger(scope) {
  return {
    debug: (m, e) => write("debug", scope, m, e),
    info: (m, e) => write("info", scope, m, e),
    warn: (m, e) => write("warn", scope, m, e),
    error: (m, e) => write("error", scope, m, e)
  };
}
const registry = /* @__PURE__ */ new Map();
const lazyDomains = /* @__PURE__ */ new Map();
const pendingLoads = /* @__PURE__ */ new Map();
function key(domain, action) {
  return `${domain}.${action}`;
}
function registerDomain(domain, handlers) {
  for (const [action, fn] of Object.entries(handlers)) {
    const k = key(domain, action);
    if (registry.has(k)) {
      throw new Error(`IPC handler 重复注册: ${k}`);
    }
    registry.set(k, fn);
  }
}
function registerLazyDomain(domain, loader) {
  lazyDomains.set(domain, loader);
}
async function ensureDomainLoaded(domain) {
  const loader = lazyDomains.get(domain);
  if (!loader) return;
  const inflight = pendingLoads.get(domain);
  if (inflight) {
    await inflight;
    return;
  }
  const loading = (async () => {
    const handlers = await loader();
    if (!registry.has(key(domain, Object.keys(handlers)[0] ?? ""))) {
      registerDomain(domain, handlers);
    }
    lazyDomains.delete(domain);
    pendingLoads.delete(domain);
  })();
  pendingLoads.set(domain, loading);
  await loading;
}
function listRegistered() {
  return [...registry.keys()].sort();
}
function listLazyDomains() {
  return [...lazyDomains.keys()].sort();
}
async function dispatch(raw, ctx) {
  let parsed;
  try {
    parsed = ipcRequestSchema.parse(raw);
  } catch (err) {
    return fail(AppError.badRequest("IPC 请求格式不合法", err));
  }
  try {
    await ensureDomainLoaded(parsed.domain);
  } catch (err) {
    return fail(AppError.internal(`加载 IPC 域失败: ${parsed.domain}`, err));
  }
  const handler = registry.get(key(parsed.domain, parsed.action));
  if (!handler) {
    return fail(AppError.unsupported(`未实现的动作: ${key(parsed.domain, parsed.action)}`));
  }
  try {
    const data = await handler(parsed.payload, ctx);
    return { ok: true, data };
  } catch (err) {
    const appErr = toAppError(err);
    if (appErr.code === "INTERNAL") {
      ctx.logger.error(`${key(parsed.domain, parsed.action)} 失败`, err);
    } else {
      ctx.logger.warn(`${key(parsed.domain, parsed.action)} 拒绝: ${appErr.code} ${appErr.message}`);
    }
    return fail(appErr);
  }
}
function fail(err) {
  return {
    ok: false,
    error: {
      code: err.code,
      message: err.message,
      ...err.detail === void 0 ? {} : { detail: err.detail }
    }
  };
}
function createIpcContext(emit) {
  return {
    logger: createLogger("ipc"),
    paths: getAppPaths(),
    emit
  };
}
const log$8 = createLogger("ping");
function pingTcp(host, port, timeoutMs) {
  return new Promise((resolve2) => {
    const started = Date.now();
    let settled = false;
    let socket = null;
    const done = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket?.destroy();
      resolve2(result);
    };
    const timer = setTimeout(() => {
      done({
        host,
        port,
        reachable: false,
        latencyMs: LATENCY_UNREACHABLE,
        method: "tcp",
        reason: `TCP 握手超时 (${timeoutMs}ms)`
      });
    }, timeoutMs);
    try {
      socket = connect({ host, port });
    } catch (err) {
      done({
        host,
        port,
        reachable: false,
        latencyMs: LATENCY_UNREACHABLE,
        method: "tcp",
        reason: err instanceof Error ? err.message : String(err)
      });
      return;
    }
    socket.once("connect", () => {
      done({ host, port, reachable: true, latencyMs: Date.now() - started, method: "tcp" });
    });
    socket.once("error", (err) => {
      done({
        host,
        port,
        reachable: false,
        latencyMs: LATENCY_UNREACHABLE,
        method: "tcp",
        reason: err.code ? `${err.code}` : err.message
      });
    });
  });
}
function pingIcmp(host, timeoutMs) {
  return new Promise((resolve2) => {
    const started = Date.now();
    const seconds = Math.max(1, Math.ceil(timeoutMs / 1e3));
    const args = process.platform === "win32" ? ["-n", "1", "-w", String(timeoutMs), host] : ["-n", "-c", "1", "-W", String(seconds), host];
    let child;
    try {
      child = spawn("ping", args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      resolve2({
        host,
        reachable: false,
        latencyMs: LATENCY_UNREACHABLE,
        method: "none",
        reason: "ping 命令不可用"
      });
      return;
    }
    let out = "";
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill();
      } catch {
      }
      resolve2(result);
    };
    const timer = setTimeout(() => {
      done({
        host,
        reachable: false,
        latencyMs: LATENCY_UNREACHABLE,
        method: "icmp",
        reason: `ICMP 超时 (${timeoutMs}ms)`
      });
    }, timeoutMs + 500);
    child.stdout?.on("data", (d) => {
      out += d.toString();
    });
    child.on("error", () => {
      done({
        host,
        reachable: false,
        latencyMs: LATENCY_UNREACHABLE,
        method: "none",
        reason: "ping 执行失败"
      });
    });
    child.on("close", (code) => {
      if (code !== 0) {
        done({
          host,
          reachable: false,
          latencyMs: LATENCY_UNREACHABLE,
          method: "icmp",
          reason: "ICMP 不可达"
        });
        return;
      }
      const m = /time[=<]\s*([\d.]+)\s*ms/i.exec(out);
      const latency = m?.[1] ? Number(m[1]) : Date.now() - started;
      done({ host, reachable: true, latencyMs: latency, method: "icmp" });
    });
  });
}
async function pingTarget(host, port, options = {}) {
  const timeoutMs = options.timeoutMs ?? 2e3;
  if (!host) {
    return {
      host,
      ...port !== void 0 ? { port } : {},
      reachable: false,
      latencyMs: LATENCY_UNREACHABLE,
      method: "none",
      reason: "主机为空"
    };
  }
  if (port !== void 0 && port > 0) {
    const tcp = await pingTcp(host, port, timeoutMs);
    if (tcp.reachable) return tcp;
    if (options.allowIcmpFallback === false) return tcp;
    const icmp = await pingIcmp(host, timeoutMs);
    if (icmp.reachable) return { ...icmp, port };
    return tcp;
  }
  if (options.allowIcmpFallback === false) {
    return {
      host,
      reachable: false,
      latencyMs: LATENCY_UNREACHABLE,
      method: "none",
      reason: "未提供端口且已禁用 ICMP"
    };
  }
  return pingIcmp(host, timeoutMs);
}
async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const runner = async () => {
    for (; ; ) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await worker(items[i], i);
    }
  };
  const runners = Array.from({ length: Math.min(limit, items.length) }, () => runner());
  await Promise.all(runners);
  return results;
}
async function pingMany(targets, options = {}) {
  const concurrency = options.concurrency ?? 16;
  const budgetMs = options.budgetMs ?? 5e3;
  const deadline = Date.now() + budgetMs;
  const results = await mapWithConcurrency(targets, concurrency, async (t) => {
    if (Date.now() > deadline) {
      return {
        host: t.host,
        ...t.port !== void 0 ? { port: t.port } : {},
        reachable: false,
        latencyMs: LATENCY_UNREACHABLE,
        method: "none",
        reason: "超出批量探测预算，未测"
      };
    }
    return pingTarget(t.host, t.port, options);
  });
  log$8.debug(`批量探测 ${targets.length} 个目标，可达 ${results.filter((r) => r.reachable).length} 个`);
  return results;
}
const here = fileURLToPath(new URL(".", import.meta.url));
function candidates(name) {
  if (app.isPackaged) return [join(process.resourcesPath, name)];
  return [join(here, "../../build", name), join(here, "../../../build", name)];
}
function appIconPath() {
  return candidates("icon.png").find((p) => existsSync(p)) ?? null;
}
function trayIconPath() {
  return candidates("tray.png").find((p) => existsSync(p)) ?? null;
}
function trayIcon() {
  const p = trayIconPath();
  if (!p) return null;
  const img = nativeImage.createFromPath(p);
  if (img.isEmpty()) return null;
  const size = process.platform === "darwin" ? 18 : 20;
  return img.resize({ width: size, height: size, quality: "best" });
}
const log$7 = createLogger("window");
const __dirname_ = fileURLToPath(new URL(".", import.meta.url));
const windows = /* @__PURE__ */ new Set();
function broadcast(event, payload) {
  for (const win of windows) {
    if (!win.isDestroyed()) {
      win.webContents.send(event, payload);
    }
  }
}
function getMainWindow() {
  return [...windows][0] ?? null;
}
let boundsFile = "";
function setWindowBoundsFile(file) {
  boundsFile = file;
}
function loadWindowBounds() {
  if (!boundsFile || !existsSync(boundsFile)) return void 0;
  try {
    const raw = JSON.parse(readFileSync(boundsFile, "utf8"));
    if (typeof raw.x !== "number" || typeof raw.y !== "number" || typeof raw.width !== "number" || typeof raw.height !== "number") {
      return void 0;
    }
    const visible = screen.getAllDisplays().some((d) => {
      const a = d.workArea;
      return raw.x < a.x + a.width && raw.x + raw.width > a.x && raw.y < a.y + a.height && raw.y + raw.height > a.y;
    });
    if (!visible) {
      log$7.info("上次的窗口位置已不在任何显示器内，回退到默认位置");
      return { ...raw, x: void 0, y: void 0 };
    }
    return raw;
  } catch (err) {
    log$7.warn("读取窗口位置失败，使用默认值", err);
    return void 0;
  }
}
function saveWindowBounds(win) {
  if (!boundsFile || win.isDestroyed()) return;
  try {
    const maximized = win.isMaximized();
    const b = maximized ? win.getNormalBounds() : win.getBounds();
    const payload = { x: b.x, y: b.y, width: b.width, height: b.height, maximized };
    writeFileSync(boundsFile, JSON.stringify(payload));
  } catch (err) {
    log$7.warn("保存窗口位置失败", err);
  }
}
function createWindow(options = {}) {
  const saved = options.restoreBounds === false ? void 0 : loadWindowBounds();
  const win = new BrowserWindow({
    ...saved?.x !== void 0 && saved?.y !== void 0 ? { x: saved.x, y: saved.y, width: saved.width, height: saved.height } : { width: 1440, height: 900 },
    minWidth: 900,
    minHeight: 600,
    show: options.show ?? false,
    autoHideMenuBar: true,
    backgroundColor: "#1a1a1a",
    title: "terminal-1000",
    // Linux/Windows 的窗口与任务栏图标；取不到就不设（用可执行文件自带图标）
    ...appIconPath() ? { icon: appIconPath() } : {},
    webPreferences: {
      preload: join(__dirname_, "../preload/index.mjs"),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      // 终端需要持续的定时器精度，后台节流交给应用自己判断
      backgroundThrottling: false
    }
  });
  windows.add(win);
  win.once("ready-to-show", () => {
    log$7.info("窗口 ready-to-show");
    if (options.show ?? true) {
      win.show();
      log$7.info("窗口已显示");
    }
  });
  win.webContents.on("did-fail-load", (_e, code, desc, url) => {
    log$7.error(`渲染层加载失败 ${code} ${desc} ${url}`);
  });
  win.webContents.on("render-process-gone", (_e, details) => {
    log$7.error(`渲染进程退出: ${JSON.stringify(details)}`);
  });
  win.webContents.on("preload-error", (_e, preloadPath, error) => {
    log$7.error(`preload 加载失败 ${preloadPath}: ${error.message}`);
  });
  let saveTimer;
  const scheduleSave = () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => saveWindowBounds(win), 500);
  };
  win.on("resize", scheduleSave);
  win.on("move", scheduleSave);
  win.on("maximize", scheduleSave);
  win.on("unmaximize", scheduleSave);
  win.on("close", () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveWindowBounds(win);
  });
  win.on("closed", () => {
    windows.delete(win);
  });
  if (saved?.maximized) win.maximize();
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  const devUrl = options.rendererUrl ?? process.env["ELECTRON_RENDERER_URL"];
  if (devUrl) {
    void win.loadURL(devUrl);
    log$7.info(`加载开发地址 ${devUrl}`);
  } else {
    void win.loadFile(join(__dirname_, "../renderer/index.html"));
  }
  return win;
}
const openExternalSchema = z.object({
  url: z.string().url()
});
const pickLocalPathSchema = z.object({
  mode: z.enum(["file", "directory"]).default("file"),
  multiple: z.boolean().optional(),
  /** 对话框标题（本地化文案由渲染层给） */
  title: z.string().max(200).optional(),
  /** 初始目录；越权/不存在时由系统自行回退 */
  defaultPath: z.string().max(4096).optional(),
  /** 文件过滤，如 [{name:'文本', extensions:['txt']}] */
  filters: z.array(z.object({ name: z.string().max(100), extensions: z.array(z.string().max(20)).max(50) })).max(20).optional()
});
const openPathSchema = z.object({
  path: z.string().min(1)
});
const showItemSchema = z.object({
  path: z.string().min(1)
});
const pingSchema = z.object({
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535).optional(),
  timeoutMs: z.number().int().positive().max(3e4).optional()
});
const pingManySchema = z.object({
  targets: z.array(
    z.object({
      host: z.string().min(1),
      port: z.number().int().min(1).max(65535).optional()
    })
  ).max(2e3),
  timeoutMs: z.number().int().positive().max(3e4).optional(),
  budgetMs: z.number().int().positive().max(12e4).optional(),
  concurrency: z.number().int().positive().max(256).optional()
});
function kittyWasmPath() {
  const candidates2 = [];
  if (process.resourcesPath) candidates2.push(join(process.resourcesPath, "kitty-vt.wasm"));
  candidates2.push(join(app.getAppPath(), "vendor", "kitty-vt-wasm", "dist", "kitty-vt.wasm"));
  let dir = __dirname;
  for (let i = 0; i < 6; i += 1) {
    candidates2.push(join(dir, "vendor", "kitty-vt-wasm", "dist", "kitty-vt.wasm"));
    candidates2.push(join(dir, "apps", "desktop", "vendor", "kitty-vt-wasm", "dist", "kitty-vt.wasm"));
    dir = dirname(dir);
  }
  for (const c of candidates2) {
    if (existsSync(c)) return resolve(c);
  }
  return null;
}
const ALLOWED_PROTOCOLS = /* @__PURE__ */ new Set(["http:", "https:", "mailto:"]);
const appHandlers = {
  /**
   * 返回 kitty 内核的 wasm 字节（base64）。
   *
   * 为什么不让 Worker 自己 `fetch()`：打包后页面是 `file://`，`fetch` 会被同源策略挡掉；
   * 走主进程读盘再交给 Worker，是在两种形态下都稳定的一条路。
   */
  kittyWasm: () => {
    const file = kittyWasmPath();
    if (!file) throw new AppError("NOT_FOUND", "找不到 kitty 内核（kitty-vt.wasm），安装包可能不完整");
    const buf = readFileSync(file);
    return { base64: buf.toString("base64"), bytes: buf.byteLength, path: file };
  },
  getInfo: () => ({
    name: app.getName(),
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    locale: app.getLocale()
  }),
  getPaths: (_payload, ctx) => ctx.paths,
  openExternal: async (payload) => {
    const { url } = openExternalSchema.parse(payload);
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      throw AppError.badRequest("URL 不合法");
    }
    if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
      throw AppError.forbidden(`不允许打开该协议: ${parsed.protocol}`);
    }
    await shell.openExternal(url);
    return { opened: true };
  },
  showItemInFolder: (payload) => {
    const { path } = parseInput$1(showItemSchema, payload);
    shell.showItemInFolder(path);
    return { shown: true };
  },
  /** 探测单个目标的可达性与时延 */
  ping: (payload) => {
    const { host, port, timeoutMs } = parseInput$1(pingSchema, payload);
    return pingTarget(host, port, timeoutMs !== void 0 ? { timeoutMs } : {});
  },
  /**
   * 批量探测（连接列表刷新延迟列用）。
   * 一次 IPC 拿回整批结果，并有整批预算兜底，避免个别不可达主机拖住界面。
   */
  pingMany: (payload) => {
    const { targets, timeoutMs, budgetMs, concurrency } = parseInput$1(pingManySchema, payload);
    const options = {
      ...timeoutMs !== void 0 ? { timeoutMs } : {},
      ...budgetMs !== void 0 ? { budgetMs } : {},
      ...concurrency !== void 0 ? { concurrency } : {}
    };
    return pingMany(targets, options);
  },
  /**
   * 打开本机文件/目录选择对话框，返回**绝对路径**。
   *
   * 为什么必须由主进程做：Electron 32+ 移除了 `File.path`，
   * 渲染层拿到 `File` 对象也读不出本地绝对路径（安全收紧），
   * 于是"选择上传文件"这类操作在渲染层无法自行完成。
   *
   * 返回 `canceled` 而不是抛错：用户取消是正常操作，不该当异常处理。
   */
  pickLocalPath: async (payload) => {
    const input = parseInput$1(pickLocalPathSchema, payload ?? {});
    const parent = getMainWindow();
    const properties = [
      input.mode === "directory" ? "openDirectory" : "openFile"
    ];
    if (input.multiple && input.mode === "file") properties.push("multiSelections");
    const options = {
      properties,
      ...input.title !== void 0 ? { title: input.title } : {},
      ...input.defaultPath !== void 0 ? { defaultPath: input.defaultPath } : {},
      ...input.filters !== void 0 ? { filters: input.filters } : {}
    };
    const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
    return {
      canceled: result.canceled,
      paths: result.filePaths
    };
  },
  /**
   * 用系统默认程序打开一个本地路径。
   * SFTP 的"在线编辑"把远端文件物化到临时文件后，用它直接打开编辑器。
   * 返回失败原因（`shell.openPath` 用非空字符串表示错误，不抛异常）。
   */
  openPath: async (payload) => {
    const { path } = parseInput$1(openPathSchema, payload);
    const error = await shell.openPath(path);
    if (error) throw AppError.badRequest(`无法打开该路径：${error}`);
    return { opened: true, path };
  },
  quit: () => {
    app.quit();
    return { quitting: true };
  },
  relaunch: () => {
    app.relaunch();
    app.exit(0);
    return { relaunching: true };
  }
};
const log$6 = createLogger("ipc-setup");
function registerAllHandlers() {
  registerDomain("app", appHandlers);
  registerLazyDomain("store", async () => (await Promise.resolve().then(() => index$7)).storeHandlers);
  registerLazyDomain("ssh", async () => (await import("./chunks/index-ByvnNeZh.js")).sshHandlers);
  registerLazyDomain("sftp", async () => (await import("./chunks/index-97h54Vl0.js")).sftpHandlers);
  registerLazyDomain("monitor", async () => (await import("./chunks/index-Cis_wmGk.js")).monitorHandlers);
  registerLazyDomain("pty", async () => (await import("./chunks/index-DLYbY0hx.js")).ptyHandlers);
  registerLazyDomain("forward", async () => (await import("./chunks/index-CQa6d2IF.js")).forwardHandlers);
  registerLazyDomain("settings", async () => (await Promise.resolve().then(() => index$6)).settingsHandlers);
  registerLazyDomain("notes", async () => (await import("./chunks/index-BYsqEZBB.js")).notesHandlers);
  registerLazyDomain("sync", async () => (await import("./chunks/index-Drf9dC2O.js")).syncHandlers);
  registerLazyDomain(
    "completion",
    async () => (await Promise.resolve().then(() => index$3)).completionHandlers
  );
  registerLazyDomain("ai", async () => (await Promise.resolve().then(() => index$4)).aiHandlers);
  registerLazyDomain("mcp", async () => (await import("./chunks/index-BYonbDPB.js")).mcpHandlers);
  registerLazyDomain("hotkey", async () => (await Promise.resolve().then(() => index$5)).hotkeyHandlers);
  registerLazyDomain(
    "sessionlog",
    async () => (await import("./chunks/index-CSJqPZ2i.js")).sessionlogHandlers
  );
  registerLazyDomain("telnet", async () => (await import("./chunks/index-BGpKzYuF.js")).telnetHandlers);
  registerLazyDomain("vnc", async () => (await import("./chunks/index-CdvD37C-.js")).vncHandlers);
  registerLazyDomain("rdp", async () => (await import("./chunks/index-CPudZoQk.js")).rdpHandlers);
  registerLazyDomain(
    "broadcast",
    async () => (await import("./chunks/index-DWxfE3K6.js")).broadcastHandlers
  );
  registerLazyDomain("quickcmd", async () => (await import("./chunks/index-Cke3wxEz.js")).quickcmdHandlers);
  registerLazyDomain("system", async () => (await Promise.resolve().then(() => index)).systemHandlers);
  registerLazyDomain(
    "shellIntegration",
    async () => (await Promise.resolve().then(() => index$2)).shellIntegrationHandlers
  );
  registerLazyDomain("update", async () => (await Promise.resolve().then(() => index$1)).updateHandlers);
  log$6.info(
    `IPC 就绪：立即注册 ${listRegistered().length} 个动作；${listLazyDomains().length} 个域按首次调用懒加载`
  );
}
const log$5 = createLogger("tray");
let tray = null;
function buildIcon() {
  const real = trayIcon();
  if (real) return real;
  const size = 16;
  const buf = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    const x = i % size;
    const y = Math.floor(i / size);
    const edge = x === 0 || y === 0 || x === size - 1 || y === size - 1;
    const inner = x > 3 && y > 3 && x < size - 4 && y < size - 4;
    const on = edge || inner;
    buf[i * 4 + 0] = on ? 47 : 0;
    buf[i * 4 + 1] = on ? 176 : 0;
    buf[i * 4 + 2] = on ? 168 : 0;
    buf[i * 4 + 3] = on ? 255 : 0;
  }
  return nativeImage.createFromBuffer(buf, { width: size, height: size });
}
function syncTray(enabled, options, onCheckUpdate) {
  if (!enabled) {
    destroyTray();
    return false;
  }
  if (tray) return true;
  try {
    tray = new Tray(buildIcon());
    tray.setToolTip("terminal-1000");
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: "显示主窗口", click: () => options.showWindow() },
        { type: "separator" },
        {
          label: "检查更新…",
          click: () => {
            void onCheckUpdate?.();
          }
        },
        { type: "separator" },
        { label: "退出 terminal-1000", click: () => options.quit() }
      ])
    );
    tray.on("click", () => options.showWindow());
    log$5.info("系统托盘已启用");
    return true;
  } catch (err) {
    tray = null;
    log$5.warn(`系统托盘不可用（已降级为无托盘）: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}
function destroyTray() {
  if (!tray) return;
  try {
    tray.destroy();
  } catch {
  }
  tray = null;
}
function hasTray() {
  return tray !== null;
}
function markQuitting() {
}
function storeKeyOf(entity) {
  return `GeneralDatabaseLocalImp-${entity}DatabaseLocalImp`;
}
const STORE_KEYS = {
  server: storeKeyOf("Server"),
  group: storeKeyOf("Group"),
  credential: storeKeyOf("Credential"),
  settings: storeKeyOf("Settings"),
  aiChat: storeKeyOf("AIChat"),
  note: storeKeyOf("Note"),
  noteFolder: storeKeyOf("NoteFolder"),
  sessionLog: storeKeyOf("SessionLog"),
  quickCommand: storeKeyOf("QuickCommand"),
  quickCommandGroup: storeKeyOf("QuickCommandGroup"),
  quickCommandParamHistory: storeKeyOf("QuickCommandParamHistory"),
  layout: storeKeyOf("Layout")
};
const META_KV_TABLE = "store_meta";
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS local_store (
  store_key  TEXT    NOT NULL,
  item_id    TEXT    NOT NULL,
  payload    TEXT    NOT NULL,
  updated_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (store_key, item_id)
);
-- 列表按「最近更新」排序是高频路径，单独建索引避免全表排序
CREATE INDEX IF NOT EXISTS idx_local_store_updated
  ON local_store (store_key, updated_at DESC);

CREATE TABLE IF NOT EXISTS ${META_KV_TABLE} (
  key   TEXT NOT NULL PRIMARY KEY,
  value TEXT NOT NULL
);
`;
const SCHEMA_VERSION = 1;
class StoreDb {
  constructor(file, options = {}) {
    this.closed = false;
    this.file = file;
    this.raw = new Database(file, { readonly: options.readonly ?? false });
    this.applyPragmas();
    if (!options.readonly) {
      this.raw.exec(SCHEMA_SQL);
      this.migrate();
    }
    this.stmts = this.prepareStatements();
  }
  /**
   * 连接级 PRAGMA。注意：`:memory:` 库不支持 WAL（SQLite 会静默回落到 memory
   * journal），这里不报错——单测就是用内存库跑的。
   */
  applyPragmas() {
    this.raw.pragma("journal_mode = WAL");
    this.raw.pragma("synchronous = NORMAL");
    this.raw.pragma("foreign_keys = ON");
    this.raw.pragma("temp_store = MEMORY");
    this.raw.pragma("busy_timeout = 5000");
    this.raw.pragma("cache_size = -16000");
  }
  migrate() {
    const current = this.getMetaNumber("schema_version", 0);
    if (current >= SCHEMA_VERSION) return;
    this.raw.prepare(`INSERT INTO ${META_KV_TABLE} (key, value) VALUES (?, ?)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run("schema_version", String(SCHEMA_VERSION));
  }
  /** 迁移期用的一次性 prepare（此时 stmts 还没建好） */
  getMetaNumber(key2, fallback) {
    const row = this.raw.prepare(`SELECT value FROM ${META_KV_TABLE} WHERE key = ?`).get(key2);
    if (!row) return fallback;
    const n = Number.parseInt(row.value, 10);
    return Number.isFinite(n) ? n : fallback;
  }
  /** 一次性把全部语句编译好并常驻（热路径零 prepare 开销） */
  prepareStatements() {
    const raw = this.raw;
    return {
      selectOne: raw.prepare(
        `SELECT store_key, item_id, payload, updated_at, created_at
           FROM local_store WHERE store_key = ? AND item_id = ?`
      ),
      selectIds: raw.prepare(
        `SELECT item_id, updated_at, created_at
           FROM local_store WHERE store_key = ? ORDER BY updated_at DESC, item_id ASC`
      ),
      selectRecentIds: raw.prepare(
        `SELECT item_id, updated_at, created_at
           FROM local_store WHERE store_key = ? AND updated_at >= ?
           ORDER BY updated_at DESC LIMIT 200`
      ),
      countByKey: raw.prepare(
        `SELECT COUNT(*) AS n FROM local_store WHERE store_key = ?`
      ),
      // created_at 用 CASE 保住首次写入的时间戳，updated_at 每次覆盖
      upsert: raw.prepare(
        `INSERT INTO local_store (store_key, item_id, payload, updated_at, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(store_key, item_id) DO UPDATE SET
           payload    = excluded.payload,
           updated_at = excluded.updated_at,
           created_at = local_store.created_at`
      ),
      deleteOne: raw.prepare(
        `DELETE FROM local_store WHERE store_key = ? AND item_id = ?`
      ),
      deleteByKey: raw.prepare(`DELETE FROM local_store WHERE store_key = ?`),
      searchPayload: raw.prepare(
        `SELECT store_key, item_id, payload, updated_at, created_at
           FROM local_store
          WHERE store_key = ? AND payload LIKE ? COLLATE NOCASE
          ORDER BY updated_at DESC LIMIT ?`
      ),
      selectAllPayload: raw.prepare(
        `SELECT store_key, item_id, payload, updated_at, created_at
           FROM local_store WHERE store_key = ? ORDER BY item_id ASC`
      ),
      deleteAll: raw.prepare(`DELETE FROM local_store`),
      countAll: raw.prepare(`SELECT COUNT(*) AS n FROM local_store`),
      selectMeta: raw.prepare(
        `SELECT value FROM ${META_KV_TABLE} WHERE key = ?`
      ),
      upsertMeta: raw.prepare(
        `INSERT INTO ${META_KV_TABLE} (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      ),
      deleteMeta: raw.prepare(`DELETE FROM ${META_KV_TABLE} WHERE key = ?`)
    };
  }
  /** 读单行；不存在返回 undefined */
  get(storeKey, itemId) {
    return this.stmts.selectOne.get(storeKey, itemId);
  }
  /** 只读索引列（列表路径：不反序列化 payload） */
  listIds(storeKey) {
    return this.stmts.selectIds.all(storeKey);
  }
  count(storeKey) {
    return this.stmts.countByKey.get(storeKey)?.n ?? 0;
  }
  /** 写入一行（upsert），created_at 已存在时保留原值 */
  put(storeKey, itemId, payload, now) {
    this.stmts.upsert.run(storeKey, itemId, payload, now, now);
  }
  /**
   * 批量写入，单事务包裹。
   * 1000 条时比逐条 run 快一个数量级（省掉 1000 次隐式事务提交）。
   */
  putMany(rows, now) {
    const upsert = this.stmts.upsert;
    const tx = this.raw.transaction((items) => {
      for (const item of items) {
        upsert.run(item.storeKey, item.itemId, item.payload, now, now);
      }
    });
    tx(rows);
  }
  /** 单事务执行任意写操作（导出/导入用） */
  transaction(fn) {
    return this.raw.transaction(fn)();
  }
  delete(storeKey, itemId) {
    this.stmts.deleteOne.run(storeKey, itemId);
  }
  deleteAllOf(storeKey) {
    this.stmts.deleteByKey.run(storeKey);
  }
  getMeta(key2) {
    return this.stmts.selectMeta.get(key2)?.value;
  }
  setMeta(key2, value) {
    this.stmts.upsertMeta.run(key2, value);
  }
  /**
   * WAL 检查点：把 -wal 内容合并回主库文件。
   * 备份导出前调用，保证拷走的是完整数据。
   */
  checkpoint() {
    if (this.file === ":memory:") return;
    try {
      this.raw.pragma("wal_checkpoint(TRUNCATE)");
    } catch {
    }
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.raw.close();
  }
}
const LEGACY_DB_RELATIVE = ["xterminal", "sqlite", "local-store.db"];
const KEY_RE = /^(?:[0-9a-f]{16,32}-)?GeneralDatabaseLocalImp-([A-Za-z]+)DatabaseLocalImp$/;
const META_FLAG = "legacy_import_v1";
function str(v) {
  return typeof v === "string" && v.length > 0 ? v : void 0;
}
function num(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : void 0;
}
function mapSsh(payload) {
  const host = str(payload.host);
  if (!host) return null;
  const out = {
    kind: "ssh",
    id: str(payload._id),
    name: str(payload.title) ?? host,
    host,
    port: num(payload.port) ?? 22,
    username: str(payload.username) ?? "root",
    authType: str(payload.authType) ?? "password",
    storeType: "local",
    createdAt: str(payload.createdAt) ?? (/* @__PURE__ */ new Date()).toISOString(),
    updatedAt: str(payload.updatedAt) ?? (/* @__PURE__ */ new Date()).toISOString()
  };
  for (const k of ["password", "privateKey", "passphrase", "note"]) {
    const v = str(payload[k]);
    if (v !== void 0) out[k] = v;
  }
  const identityId = str(payload.identityId) ?? str(payload.credentialId);
  if (identityId) {
    out.identityId = identityId;
    out.authType = out.authType === "privateKey" ? "identity" : out.authType;
  }
  return out;
}
function mapRdp(payload) {
  const auth = payload.authDecrypted ?? {};
  const host = str(auth.address) ?? str(payload.host);
  if (!host) return null;
  const out = {
    kind: "rdp",
    id: str(payload._id),
    name: str(payload.title) ?? host,
    host,
    port: num(auth.port) ?? num(payload.port) ?? 3389,
    username: str(auth.username) ?? str(payload.username) ?? "",
    storeType: "local",
    createdAt: str(payload.createdAt) ?? (/* @__PURE__ */ new Date()).toISOString(),
    updatedAt: str(payload.updatedAt) ?? (/* @__PURE__ */ new Date()).toISOString()
  };
  const password = str(auth.password) ?? str(payload.password);
  if (password) out.password = password;
  if (auth.enableClipboard === true) out.clipboardShare = true;
  const quality = str(auth.renderQualityMode);
  if (quality === "low" || quality === "balanced" || quality === "high") out.quality = quality;
  const note = str(payload.note);
  if (note) out.note = note;
  return out;
}
function mapGroup(payload) {
  const name = str(payload.title) ?? str(payload.name);
  if (!name) return null;
  const out = {
    id: str(payload._id) ?? str(payload.id),
    name,
    createdAt: str(payload.createdAt) ?? (/* @__PURE__ */ new Date()).toISOString(),
    updatedAt: str(payload.updatedAt) ?? (/* @__PURE__ */ new Date()).toISOString()
  };
  const parentId = str(payload.parentId) ?? str(payload.parent);
  if (parentId) out.parentId = parentId;
  return out;
}
const MAPPERS = {
  Server: { storeKey: STORE_KEYS.server, map: mapSsh },
  Rdp: { storeKey: STORE_KEYS.server, map: mapRdp },
  Group: { storeKey: STORE_KEYS.group, map: mapGroup }
};
const OMIT_REASONS = {
  AIChat: "消息结构（segments）与本项目（ChatMessage）差异过大，导入会静默损坏，暂不迁移",
  ServerStatus: "运行时监控快照，属临时数据，无需迁移",
  SessionLog: "会话日志属临时数据，无需迁移",
  Settings: "原产品的设置项命名与本项目完全不同，无法安全映射",
  Credential: "凭证行可能被旧产品加密，格式未知，暂不迁移"
};
function importLegacyReferenceStores(db, appData) {
  if (db.getMeta(META_FLAG) !== void 0) return null;
  const source = join(appData, ...LEGACY_DB_RELATIVE);
  if (!existsSync(source)) {
    db.setMeta(META_FLAG, JSON.stringify({ source, found: false, at: (/* @__PURE__ */ new Date()).toISOString() }));
    return null;
  }
  const report = { source, imported: {}, skipped: 0, omitted: {}, errors: [] };
  let rows;
  try {
    const legacy = new Database(source, { readonly: true, fileMustExist: true });
    try {
      rows = legacy.prepare("SELECT store_key AS storeKey, item_id AS itemId, payload AS payload FROM local_store").all();
    } finally {
      legacy.close();
    }
  } catch (err) {
    report.errors.push(`打开旧库失败：${err instanceof Error ? err.message : String(err)}`);
    db.setMeta(META_FLAG, JSON.stringify({ ...report, at: (/* @__PURE__ */ new Date()).toISOString() }));
    return report;
  }
  const now = Date.now();
  for (const row of rows) {
    const m = KEY_RE.exec(row.storeKey);
    if (!m) {
      report.skipped += 1;
      continue;
    }
    const entity = m[1];
    if (!entity) {
      report.skipped += 1;
      continue;
    }
    const reason = OMIT_REASONS[entity];
    if (reason) {
      report.omitted[entity] = reason;
      report.skipped += 1;
      continue;
    }
    const entry = MAPPERS[entity];
    if (!entry) {
      report.skipped += 1;
      continue;
    }
    let parsed;
    try {
      parsed = JSON.parse(row.payload);
    } catch (err) {
      report.errors.push(`解析 ${entity}/${row.itemId} 失败：${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    const mapped = entry.map(parsed);
    if (!mapped || typeof mapped.id !== "string") {
      report.skipped += 1;
      continue;
    }
    if (db.get(entry.storeKey, mapped.id)) {
      report.skipped += 1;
      continue;
    }
    try {
      db.put(entry.storeKey, mapped.id, JSON.stringify(mapped), now);
      report.imported[entity] = (report.imported[entity] ?? 0) + 1;
    } catch (err) {
      report.errors.push(`写入 ${entity}/${mapped.id} 失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }
  db.setMeta(META_FLAG, JSON.stringify({ ...report, at: (/* @__PURE__ */ new Date()).toISOString() }));
  if (Object.keys(report.imported).length > 0) {
    let removedDemo = 0;
    for (const key2 of [STORE_KEYS.server, STORE_KEYS.group]) {
      for (const idx of db.listIds(key2)) {
        if (idx.item_id.startsWith("demo-")) {
          db.delete(key2, idx.item_id);
          removedDemo += 1;
        }
      }
    }
    if (removedDemo > 0) report.omitted["demo"] = `已清除 ${removedDemo} 条历史演示数据`;
  }
  return report;
}
const CIPHER_VERSION = "v1";
const SCRYPT_PARAMS = {
  /** CPU/内存开销，必须是 2 的幂 */
  N: 16384,
  /** 块大小 */
  r: 8,
  /** 并行度（Node 的 scrypt 只支持 p=1 的高效实现[1]，此处固定 1） */
  p: 1,
  /** 派生密钥长度（AES-256 需要 32 字节） */
  keylen: 32,
  /** scrypt 内部内存上限，N*r*128 = 16 MiB，留一倍余量 */
  maxmem: 64 * 1024 * 1024
};
const SALT_BYTES = 16;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const LOCKED_MASK = "__LOCKED__";
const ENCRYPTED_FIELD_NAMES = [
  "password",
  "privateKey",
  "passphrase",
  "apiKey",
  "token"
];
function isCiphertext(value) {
  return typeof value === "string" && value.startsWith(`${CIPHER_VERSION}:`);
}
function isLockedMask(value) {
  return value === LOCKED_MASK;
}
function deriveKey(password, salt) {
  return scryptSync(password, salt, SCRYPT_PARAMS.keylen, {
    N: SCRYPT_PARAMS.N,
    r: SCRYPT_PARAMS.r,
    p: SCRYPT_PARAMS.p,
    maxmem: SCRYPT_PARAMS.maxmem
  });
}
function encryptWithKey(key2, plaintext) {
  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key2, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    CIPHER_VERSION,
    salt.toString("base64"),
    iv.toString("base64"),
    tag.toString("base64"),
    ciphertext.toString("base64")
  ].join(":");
}
function decryptWithKey(key2, blob) {
  const parts = blob.split(":");
  if (parts.length !== 5) {
    throw new Error("密文格式不合法：期望 5 段");
  }
  const [version, saltB64, ivB64, tagB64, cipherB64] = parts;
  if (version !== CIPHER_VERSION) {
    throw new Error(`不支持的密文版本: ${version}`);
  }
  const iv = Buffer.from(ivB64, "base64");
  const tag = Buffer.from(tagB64, "base64");
  const ciphertext = Buffer.from(cipherB64, "base64");
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new Error("密文格式不合法：IV 或认证标签长度错误");
  }
  const decipher = createDecipheriv("aes-256-gcm", key2, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
class Vault {
  constructor() {
    this.key = null;
  }
  /** 主密码是否已设置（区分「首次设置」与「解锁」语义） */
  isInitialized() {
    return this.key !== null;
  }
  isUnlocked() {
    return this.key !== null;
  }
  /** 取当前密钥；未解锁时返回 null（调用方据此写掩码） */
  currentKey() {
    return this.key;
  }
  /** 解锁：装填派生密钥 */
  unlockWithKey(key2) {
    this.lock();
    this.key = key2;
  }
  /** 锁定：覆写并丢弃密钥 */
  lock() {
    if (this.key) {
      this.key.fill(0);
      this.key = null;
    }
  }
}
function createVerifier(password) {
  const salt = randomBytes(SALT_BYTES);
  const verifier = deriveKey(password, salt);
  const out = `${salt.toString("base64")}:${verifier.toString("base64")}`;
  verifier.fill(0);
  return out;
}
function verifyAndDerive(password, record) {
  const parts = record.split(":");
  if (parts.length !== 2) return null;
  const [saltB64, verifierB64] = parts;
  let salt;
  let expected;
  try {
    salt = Buffer.from(saltB64, "base64");
    expected = Buffer.from(verifierB64, "base64");
  } catch {
    return null;
  }
  if (salt.length === 0 || expected.length !== SCRYPT_PARAMS.keylen) return null;
  const actual = deriveKey(password, salt);
  const ok = safeEqual(actual, expected);
  if (!ok) {
    actual.fill(0);
    return null;
  }
  return actual;
}
function isSensitiveKey(key2) {
  return ENCRYPTED_FIELD_NAMES.includes(key2);
}
class Repository {
  constructor(db, key2) {
    this.db = db;
    this.key = key2;
  }
  // ---------------------------------------------------------------- 通用 KV
  /** 读原始行（未做任何加解密处理；db 层单测与调试用） */
  readRow(storeKey, itemId) {
    return this.db.get(storeKey, itemId);
  }
  /** 写原始行 */
  writeRow(storeKey, itemId, payload, now) {
    this.db.put(storeKey, itemId, JSON.stringify(payload), now);
  }
  // ------------------------------------------- 字段编解码入口（备份/同步复用）
  /**
   * 用**显式指定的密钥**解开 payload 里的敏感字段。
   *
   * 用途：跨设备迁移时，导出侧先用本机主密钥解开、再用备份口令派生的密钥重新加密；
   * 导入侧反向。内部直接复用下面 `decryptSensitiveWith` 那套按
   * `ENCRYPTED_FIELD_NAMES` 的递归扫描，**不另造字段清单** ——
   * 跳板链每一跳的 password/passphrase、代理密码、凭证、AI apiKey 全部自动覆盖。
   *
   * 解不开（密钥不匹配 / 数据损坏）会抛出，由调用方决定降级策略。
   */
  decryptFields(payload, key2) {
    return this.decryptSensitiveWith(payload, key2);
  }
  /**
   * 用显式指定的密钥加密 payload 里的敏感字段。
   * 已是密文的字段原样保留（避免二次加密）；`__LOCKED__` 掩码会被丢弃（掩码不是密码）。
   */
  encryptFields(payload, key2) {
    return this.encryptSensitive(payload, key2);
  }
  // ------------------------------------------------------------ 加解密核心
  /**
   * 把对象里的敏感字段加密（写路径）。
   * 已经是密文的原样保留——避免「读回密文再存一遍」造成二次加密。
   */
  encryptSensitive(value, key2) {
    if (value === null || typeof value !== "object") return value;
    if (Array.isArray(value)) {
      return value.map((item) => this.encryptSensitive(item, key2));
    }
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (isSensitiveKey(k) && typeof v === "string" && v.length > 0) {
        out[k] = isCiphertext(v) ? v : encryptWithKey(key2, v);
      } else if (isSensitiveKey(k) && isLockedMask(v)) {
        continue;
      } else {
        out[k] = this.encryptSensitive(v, key2);
      }
    }
    return out;
  }
  /**
   * 把对象里的敏感字段解密（读路径）。
   * - 已解锁：解密成功返回明文；解不开（密钥不对/数据损坏）降级为掩码，不抛。
   * - 未锁定但字段是明文（历史数据）：原样返回。
   */
  decryptSensitive(value, key2) {
    if (value === null || typeof value !== "object") return value;
    if (Array.isArray(value)) {
      return value.map((item) => this.decryptSensitive(item, key2));
    }
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (isSensitiveKey(k) && typeof v === "string") {
        out[k] = this.decryptField(v, key2);
      } else {
        out[k] = this.decryptSensitive(v, key2);
      }
    }
    return out;
  }
  /** 单字段解密；拿不到密钥或解不开 → 掩码 */
  decryptField(value, key2) {
    if (!isCiphertext(value)) {
      return key2 ? value : LOCKED_MASK;
    }
    if (!key2) return LOCKED_MASK;
    try {
      return decryptWithKey(key2, value);
    } catch {
      return LOCKED_MASK;
    }
  }
  /** 反序列化 + 按需解密 */
  hydrate(row) {
    const parsed = JSON.parse(row.payload);
    return this.decryptSensitive(parsed, this.key());
  }
  /**
   * 序列化 + 按需加密。
   *
   * @param previous 磁盘上原有的 payload（**仍是密文**）。
   *   锁定态下写入时，入参里的敏感字段是 `__LOCKED__` 掩码——它代表
   *   "渲染层没改过这个字段"，此时必须**从 previous 里把原密文原样搬过来**，
   *   而不是丢掉。否则锁定态下一次无关的改名就会永久抹掉用户保存的密码。
   */
  dehydrate(payload, previous) {
    const key2 = this.key();
    if (key2) return JSON.stringify(this.encryptSensitive(payload, key2));
    return JSON.stringify(preserveMaskedCiphertext(payload, previous));
  }
  /** 取出磁盘上某行已解析的原始 payload（密文态）；不存在返回 undefined */
  rawPayload(storeKey, itemId) {
    const row = this.db.get(storeKey, itemId);
    if (!row) return void 0;
    try {
      return JSON.parse(row.payload);
    } catch {
      return void 0;
    }
  }
  // ------------------------------------------------------------ 连接 CRUD
  /** 全部连接（列表路径：只取索引列 + 逐行反序列化，不解密无关字段） */
  listConnections() {
    const rows = this.db.listIds(STORE_KEYS.server);
    const out = [];
    for (const idx of rows) {
      const row = this.db.get(STORE_KEYS.server, idx.item_id);
      if (!row) continue;
      out.push(this.hydrate(row));
    }
    return out;
  }
  /** 单条连接；不存在返回 undefined */
  getConnection(id) {
    const row = this.db.get(STORE_KEYS.server, id);
    return row ? this.hydrate(row) : void 0;
  }
  /**
   * 保存连接（新建或更新）。
   * - 新建：补 createdAt / updatedAt
   * - 更新：保留原 createdAt，刷新 updatedAt
   * - 已存在的密文字段在 payload 里仍是密文（hydrate 给的是明文，
   *   渲染层回存的是明文），这里统一重新加密
   */
  saveConnection(input, now) {
    const previous = this.rawPayload(STORE_KEYS.server, input.id);
    const existing = previous;
    const saved = {
      ...input,
      // 用 || 而不是 ??：空字符串同样视为"没给值"，应当回落到 now
      createdAt: existing?.createdAt || input.createdAt || now,
      updatedAt: now
    };
    this.db.put(STORE_KEYS.server, saved.id, this.dehydrate(saved, previous), Date.now());
    return this.hydrate(this.db.get(STORE_KEYS.server, saved.id));
  }
  /** 删除连接；返回是否真的删掉了 */
  deleteConnection(id) {
    const exists = this.db.get(STORE_KEYS.server, id) !== void 0;
    if (exists) this.db.delete(STORE_KEYS.server, id);
    return exists;
  }
  /**
   * 移动连接：改 groupId（传 undefined/null 视为移出分组）。
   * 只重写目标行，不触发全表写。
   */
  moveConnection(id, groupId, now) {
    const current = this.getConnection(id);
    if (!current) return void 0;
    const moved = { ...current, updatedAt: now };
    if (groupId === void 0) {
      delete moved.groupId;
    } else {
      moved.groupId = groupId;
    }
    this.db.put(STORE_KEYS.server, id, this.dehydrate(moved, this.rawPayload(STORE_KEYS.server, id)), Date.now());
    return this.hydrate(this.db.get(STORE_KEYS.server, id));
  }
  // ------------------------------------------------------------ 分组 CRUD
  listGroups() {
    const rows = this.db.listIds(STORE_KEYS.group);
    const out = [];
    for (const idx of rows) {
      const row = this.db.get(STORE_KEYS.group, idx.item_id);
      if (!row) continue;
      out.push(this.hydrate(row));
    }
    return out;
  }
  getGroup(id) {
    const row = this.db.get(STORE_KEYS.group, id);
    return row ? this.hydrate(row) : void 0;
  }
  saveGroup(input, now) {
    const previous = this.rawPayload(STORE_KEYS.group, input.id);
    const existing = previous;
    const saved = {
      ...input,
      createdAt: existing?.createdAt || input.createdAt || now,
      updatedAt: now
    };
    this.db.put(STORE_KEYS.group, saved.id, this.dehydrate(saved, previous), Date.now());
    return this.hydrate(this.db.get(STORE_KEYS.group, saved.id));
  }
  /**
   * 删除分组。
   * `cascade=true`（默认）连子分组一起删，并把孤儿连接的 groupId 清掉；
   * `cascade=false` 时把子分组挂到被删分组的父级（提升一层）。
   */
  // ── 工作区布局 ─────────────────────────────────────
  listLayouts() {
    const rows = this.db.listIds(STORE_KEYS.layout);
    const out = [];
    for (const idx of rows) {
      const row = this.db.get(STORE_KEYS.layout, idx.item_id);
      if (!row) continue;
      out.push(this.hydrate(row));
    }
    return out;
  }
  getLayout(id) {
    const row = this.db.get(STORE_KEYS.layout, id);
    return row ? this.hydrate(row) : void 0;
  }
  /** 取某连接的布局（不含模板） */
  getLayoutForConnection(connectionId) {
    return this.listLayouts().find((l) => !l.isTemplate && l.connectionId === connectionId);
  }
  saveLayout(input, now) {
    const previous = this.rawPayload(STORE_KEYS.layout, input.id);
    const existing = previous;
    const saved = {
      ...input,
      createdAt: existing?.createdAt || input.createdAt || now,
      updatedAt: now
    };
    this.db.put(STORE_KEYS.layout, saved.id, this.dehydrate(saved, previous), Date.now());
    return this.hydrate(this.db.get(STORE_KEYS.layout, saved.id));
  }
  deleteLayout(id) {
    if (!this.db.get(STORE_KEYS.layout, id)) return false;
    this.db.delete(STORE_KEYS.layout, id);
    return true;
  }
  deleteGroup(id, cascade = true) {
    const groups = this.listGroups();
    const target = groups.find((g) => g.id === id);
    if (!target) return { deletedGroups: [], affectedConnections: 0 };
    const toDelete = /* @__PURE__ */ new Set([id]);
    if (cascade) {
      let frontier = [id];
      while (frontier.length > 0) {
        const next = [];
        for (const g of groups) {
          if (g.parentId !== void 0 && frontier.includes(g.parentId) && !toDelete.has(g.id)) {
            toDelete.add(g.id);
            next.push(g.id);
          }
        }
        frontier = next;
      }
    }
    const affected = this.listConnections().filter(
      (c) => c.groupId !== void 0 && toDelete.has(c.groupId)
    );
    const now = Date.now();
    this.db.transaction(() => {
      for (const gid of toDelete) {
        this.db.delete(STORE_KEYS.group, gid);
      }
      if (!cascade) {
        for (const g of groups) {
          if (g.parentId === id && !toDelete.has(g.id)) {
            const reparented = { ...g, updatedAt: new Date(now).toISOString() };
            delete reparented.parentId;
            if (target.parentId !== void 0) reparented.parentId = target.parentId;
            this.db.put(
              STORE_KEYS.group,
              g.id,
              this.dehydrate(reparented, this.rawPayload(STORE_KEYS.group, g.id)),
              now
            );
          }
        }
      }
      for (const conn of affected) {
        const next = { ...conn, updatedAt: new Date(now).toISOString() };
        delete next.groupId;
        this.db.put(
          STORE_KEYS.server,
          conn.id,
          this.dehydrate(next, this.rawPayload(STORE_KEYS.server, conn.id)),
          now
        );
      }
    });
    return { deletedGroups: [...toDelete], affectedConnections: affected.length };
  }
  /**
   * 构建分组树。
   * 一次取全部分组 + 一次取全部连接的分组归属，在内存里组装（O(n)）。
   * 孤儿分组（parentId 指向不存在的组）挂到根，避免整棵树丢失。
   */
  buildGroupTree() {
    const groups = this.listGroups();
    const nodes = /* @__PURE__ */ new Map();
    for (const g of groups) {
      nodes.set(g.id, { ...g, children: [], connectionCount: 0 });
    }
    for (const conn of this.listConnections()) {
      if (conn.groupId === void 0) continue;
      const node = nodes.get(conn.groupId);
      if (node) node.connectionCount += 1;
    }
    const roots = [];
    for (const g of groups) {
      const node = nodes.get(g.id);
      const parent = g.parentId === void 0 ? void 0 : nodes.get(g.parentId);
      if (parent) parent.children.push(node);
      else roots.push(node);
    }
    const bySort = (a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name);
    const sortDeep = (list) => {
      list.sort(bySort);
      for (const n of list) sortDeep(n.children);
      return list;
    };
    return sortDeep(roots);
  }
  // ------------------------------------------------------------ 凭证 CRUD
  listCredentials() {
    const rows = this.db.listIds(STORE_KEYS.credential);
    const out = [];
    for (const idx of rows) {
      const row = this.db.get(STORE_KEYS.credential, idx.item_id);
      if (!row) continue;
      out.push(this.hydrate(row));
    }
    return out;
  }
  getCredential(id) {
    const row = this.db.get(STORE_KEYS.credential, id);
    return row ? this.hydrate(row) : void 0;
  }
  saveCredential(input, now) {
    const previous = this.rawPayload(STORE_KEYS.credential, input.id);
    const existing = previous;
    const saved = {
      ...input,
      createdAt: existing?.createdAt || input.createdAt || now,
      updatedAt: now
    };
    this.db.put(STORE_KEYS.credential, saved.id, this.dehydrate(saved, previous), Date.now());
    return this.hydrate(this.db.get(STORE_KEYS.credential, saved.id));
  }
  // ---------------------------------------------------------------- 搜索
  /**
   * 关键词搜索。
   *
   * 两阶段：先在 SQL 里用 LIKE 粗筛（不反序列化不匹配的行），再对候选行做
   * 结构化匹配。1000 条连接时这一层能把 JSON.parse 次数从 O(n) 降到 O(hits)。
   *
   * 注意：payload 里密码是密文，搜索**不会**匹配到密码明文——
   * 这既是性能设计也是安全特性。
   */
  search(keyword, limit = 100) {
    const trimmed = keyword.trim();
    if (trimmed.length === 0) return [];
    const pattern = `%${escapeLike(trimmed)}%`;
    const rows = this.db.stmts.searchPayload.all(STORE_KEYS.server, pattern, limit);
    const lower = trimmed.toLowerCase();
    const out = [];
    for (const row of rows) {
      const conn = this.hydrate(row);
      if (matchesConnection(conn, lower)) out.push(conn);
    }
    return out;
  }
  // ------------------------------------------------------------ 密文轮换
  /**
   * 用新密钥重新加密所有密文字段（改主密码时调用）。
   *
   * 必须在**已持有旧密钥**的前提下调用：先解密出明文，再用新密钥加密。
   * 整体放在一个事务里，失败则全部回滚，不会出现半新半旧的密文。
   *
   * @returns 重新加密的行数
   */
  reencryptAll(oldKey, newKey) {
    const entities = [STORE_KEYS.server, STORE_KEYS.group, STORE_KEYS.credential, STORE_KEYS.settings, STORE_KEYS.aiChat];
    let touched = 0;
    this.db.transaction(() => {
      for (const storeKey of entities) {
        const rows = this.db.stmts.selectAllPayload.all(storeKey);
        for (const row of rows) {
          const parsed = JSON.parse(row.payload);
          if (!hasCiphertext(parsed)) continue;
          const plain = this.decryptSensitiveWith(parsed, oldKey);
          const reencrypted = this.encryptSensitive(plain, newKey);
          this.db.put(storeKey, row.item_id, JSON.stringify(reencrypted), row.updated_at);
          touched += 1;
        }
      }
    });
    return touched;
  }
  /** 与 decryptSensitive 同逻辑，但显式指定密钥（轮换用） */
  decryptSensitiveWith(value, key2) {
    if (value === null || typeof value !== "object") return value;
    if (Array.isArray(value)) return value.map((item) => this.decryptSensitiveWith(item, key2));
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (isSensitiveKey(k) && typeof v === "string" && isCiphertext(v)) {
        out[k] = decryptWithKey(key2, v);
      } else {
        out[k] = this.decryptSensitiveWith(v, key2);
      }
    }
    return out;
  }
}
function hasCiphertext(value) {
  if (typeof value === "string") return isCiphertext(value);
  if (value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(hasCiphertext);
  return Object.values(value).some(hasCiphertext);
}
function preserveMaskedCiphertext(value, previous) {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    const prevArr = Array.isArray(previous) ? previous : [];
    return value.map((item, i) => preserveMaskedCiphertext(item, prevArr[i]));
  }
  const prevObj = previous !== null && typeof previous === "object" && !Array.isArray(previous) ? previous : void 0;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (isSensitiveKey(k) && isLockedMask(v)) {
      const prev = prevObj?.[k];
      if (typeof prev === "string" && isCiphertext(prev)) out[k] = prev;
      continue;
    }
    if (isSensitiveKey(k) && v === void 0) {
      continue;
    }
    out[k] = preserveMaskedCiphertext(v, prevObj?.[k]);
  }
  return out;
}
function matchesConnection(conn, lower) {
  const haystack = [conn.id, conn.name];
  const maybeHost = conn.host;
  if (typeof maybeHost === "string") haystack.push(maybeHost);
  const maybeUsername = conn.username;
  if (typeof maybeUsername === "string") haystack.push(maybeUsername);
  const maybeNote = conn.note;
  if (typeof maybeNote === "string") haystack.push(maybeNote);
  for (const field of haystack) {
    if (field.toLowerCase().includes(lower)) return true;
  }
  return false;
}
function escapeLike(input) {
  return input.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}
const BACKUP_MAGIC = "T1000_BACKUP";
const BACKUP_VERSION = 1;
const BACKUP_EXTENSION = ".backup.t1000.enc";
function backupFileName(now = /* @__PURE__ */ new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  return `${stamp}.v${BACKUP_VERSION}${BACKUP_EXTENSION}`;
}
function exportBackup(db, options = {}) {
  db.checkpoint();
  const storeKeys = options.entities ? options.entities.map((entity) => STORE_KEYS[storeKeyAlias(entity)]) : Object.values(STORE_KEYS);
  const passphrase = options.passphrase !== void 0 && options.passphrase.length > 0 ? options.passphrase : void 0;
  const codec = options.fieldCodec;
  const masterKey = options.masterKey ?? null;
  let fieldKey = null;
  let fieldSalt = null;
  if (passphrase !== void 0 && codec !== void 0) {
    if (masterKey === null) {
      throw new BackupLockedError(
        "未解锁：无法导出可跨设备使用的备份，请先解锁主密码库后再导出"
      );
    }
    fieldSalt = randomBytes(SALT_BYTES);
    fieldKey = deriveKey(passphrase, fieldSalt);
  }
  const content = {
    exportedAt: (/* @__PURE__ */ new Date()).toISOString(),
    entities: {}
  };
  const counts = {};
  for (const storeKey of storeKeys) {
    const rows = db.stmts.selectAllPayload.all(storeKey);
    content.entities[storeKey] = rows.map((r) => {
      const parsed = JSON.parse(r.payload);
      const payload = fieldKey !== null && codec !== void 0 && masterKey !== null ? codec.encryptFields(codec.decryptFields(parsed, masterKey), fieldKey) : parsed;
      return {
        itemId: r.item_id,
        payload,
        updatedAt: r.updated_at,
        createdAt: r.created_at
      };
    });
    counts[storeKey] = rows.length;
  }
  const salt = randomBytes(SALT_BYTES);
  const key2 = resolveKey(options.passphrase, options.key, salt);
  const iv = randomBytes(IV_BYTES);
  const plaintext = Buffer.from(JSON.stringify(content), "utf8");
  const cipher = createCipheriv("aes-256-gcm", key2, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  if (!options.key) key2.fill(0);
  const envelope = {
    magic: BACKUP_MAGIC,
    version: BACKUP_VERSION,
    createdAt: content.exportedAt,
    cipher: `aes-256-gcm/${CIPHER_VERSION}`,
    kdf: { algo: "scrypt", N: 16384, r: 8, p: 1 },
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    payload: ciphertext.toString("base64"),
    meta: {
      counts,
      // 自描述：有 fieldSalt 就代表敏感字段是用备份口令加密的
      ...fieldSalt === null ? {} : { fieldSalt: fieldSalt.toString("base64"), portableFields: true }
    }
  };
  const json = Buffer.from(JSON.stringify(envelope), "utf8");
  const data = Buffer.concat([
    Buffer.from(`${BACKUP_MAGIC}
`, "utf8"),
    Buffer.from(json.toString("base64"), "utf8"),
    Buffer.from("\n", "utf8")
  ]);
  return { data, fileName: backupFileName(options.now), envelope };
}
function parseBackup(data, options = {}) {
  const text = typeof data === "string" ? data : data.toString("utf8");
  const newlineIdx = text.indexOf("\n");
  if (newlineIdx < 0) {
    throw new BackupFormatError("备份文件缺少头部：不是 terminal-1000 备份格式");
  }
  const header = text.slice(0, newlineIdx).trim();
  if (header !== BACKUP_MAGIC) {
    throw new BackupFormatError(`备份文件 magic 不匹配：期望 ${BACKUP_MAGIC}`);
  }
  const b64 = text.slice(newlineIdx + 1).trim();
  let envelope;
  try {
    const json = Buffer.from(b64, "base64").toString("utf8");
    envelope = JSON.parse(json);
  } catch {
    throw new BackupFormatError("备份文件信封不是合法 JSON");
  }
  if (envelope.magic !== BACKUP_MAGIC) {
    throw new BackupFormatError("备份信封 magic 字段不匹配");
  }
  if (typeof envelope.version !== "number" || envelope.version !== BACKUP_VERSION) {
    throw new BackupFormatError(
      `不支持的备份版本: ${String(envelope.version)}（当前支持 ${BACKUP_VERSION}）`
    );
  }
  if (envelope.kdf?.algo !== "scrypt") {
    throw new BackupFormatError(`不支持的 KDF: ${String(envelope.kdf?.algo)}`);
  }
  const salt = Buffer.from(envelope.salt, "base64");
  const iv = Buffer.from(envelope.iv, "base64");
  const tag = Buffer.from(envelope.tag, "base64");
  const ciphertext = Buffer.from(envelope.payload, "base64");
  if (salt.length !== SALT_BYTES || iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new BackupFormatError("备份文件字段长度不合法（salt / iv / tag）");
  }
  const key2 = resolveKey(options.passphrase, options.key, salt);
  let plaintext;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key2, iv);
    decipher.setAuthTag(tag);
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new BackupDecryptError("备份解密失败：口令错误或文件已被篡改");
  } finally {
    if (!options.key) key2.fill(0);
  }
  let content;
  try {
    content = JSON.parse(plaintext.toString("utf8"));
  } catch {
    throw new BackupFormatError("备份明文内容不是合法 JSON");
  }
  if (typeof content !== "object" || content === null || typeof content.entities !== "object") {
    throw new BackupFormatError("备份明文结构不合法：缺少 entities");
  }
  return { envelope, content };
}
function importBackup(db, data, options = {}) {
  const { envelope, content } = parseBackup(data, options);
  const mode = options.mode ?? "replace";
  const fieldSaltB64 = envelope.meta?.fieldSalt;
  const codec = options.fieldCodec;
  let fieldKey = null;
  let masterKey = null;
  if (typeof fieldSaltB64 === "string" && fieldSaltB64.length > 0) {
    if (codec === void 0) {
      throw new BackupConfigError("导入该备份需要字段编解码器（内部接线缺失）");
    }
    const passphrase = options.passphrase;
    if (passphrase === void 0 || passphrase.length === 0) {
      throw new BackupConfigError("备份中的凭据由备份口令加密，导入时必须提供该口令");
    }
    masterKey = options.masterKey ?? null;
    if (masterKey === null) {
      throw new BackupLockedError(
        "未解锁：无法导入可跨设备的备份（需要把凭据重新加密到本机），请先解锁主密码库后再导入"
      );
    }
    fieldKey = deriveKey(passphrase, Buffer.from(fieldSaltB64, "base64"));
  }
  const imported = {};
  let skipped = 0;
  let total = 0;
  db.transaction(() => {
    if (mode === "replace") {
      db.stmts.deleteAll.run();
    }
    for (const [storeKey, rows] of Object.entries(content.entities)) {
      let count = 0;
      for (const row of rows) {
        if (typeof row.itemId !== "string" || row.itemId.length === 0) continue;
        if (mode === "merge") {
          const existing = db.get(storeKey, row.itemId);
          if (existing && existing.updated_at > row.updatedAt) {
            skipped += 1;
            continue;
          }
        }
        let payload = row.payload;
        if (fieldKey !== null && masterKey !== null && codec !== void 0) {
          try {
            payload = codec.encryptFields(codec.decryptFields(row.payload, fieldKey), masterKey);
          } catch {
            payload = row.payload;
          }
        }
        db.stmts.upsert.run(
          storeKey,
          row.itemId,
          JSON.stringify(payload),
          row.updatedAt,
          row.createdAt
        );
        count += 1;
        total += 1;
      }
      imported[storeKey] = count;
    }
  });
  return { mode, imported, skipped, total };
}
class BackupFormatError extends Error {
  constructor(message) {
    super(message);
    this.kind = "format";
    this.name = "BackupFormatError";
  }
}
class BackupDecryptError extends Error {
  constructor(message) {
    super(message);
    this.kind = "decrypt";
    this.name = "BackupDecryptError";
  }
}
class BackupLockedError extends Error {
  constructor(message) {
    super(message);
    this.kind = "locked";
    this.name = "BackupLockedError";
  }
}
class BackupConfigError extends Error {
  constructor(message) {
    super(message);
    this.kind = "config";
    this.name = "BackupConfigError";
  }
}
function storeKeyAlias(entity) {
  switch (entity) {
    case "Server":
      return "server";
    case "Group":
      return "group";
    case "Credential":
      return "credential";
    case "Settings":
      return "settings";
    case "AIChat":
      return "aiChat";
    case "Note":
      return "note";
    case "NoteFolder":
      return "noteFolder";
    case "SessionLog":
      return "sessionLog";
    case "QuickCommand":
      return "quickCommand";
    case "QuickCommandGroup":
      return "quickCommandGroup";
    case "QuickCommandParamHistory":
      return "quickCommandParamHistory";
    case "Layout":
      return "layout";
  }
}
function resolveKey(passphrase, key2, salt) {
  if (key2) return key2;
  if (passphrase && passphrase.length > 0) return deriveKey(passphrase, salt);
  throw new BackupFormatError("缺少备份口令：导出或导入都需要口令或已解锁的主密码");
}
function expandTilde(path, home) {
  if (path === "~") return home;
  if (path.startsWith("~/")) return join(home, path.slice(2));
  return path;
}
function defaultHome() {
  return homedir();
}
function defaultSshConfigPath(home = defaultHome()) {
  return join(home, ".ssh", "config");
}
function safeReadFile(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}
function safeReadDir(path) {
  try {
    return readdirSync(path);
  } catch {
    return null;
  }
}
function safeIsDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
function globFiles(pattern) {
  const segments = pattern.split("/").filter((s) => s !== "");
  const absolute = pattern.startsWith("/");
  let bases = absolute ? ["/"] : ["."];
  for (const segment of segments) {
    const next = [];
    const hasMagic = /[*?]/.test(segment);
    for (const base of bases) {
      if (!hasMagic) {
        next.push(join(base, segment));
        continue;
      }
      const entries = safeReadDir(base);
      if (entries === null) continue;
      const re = globSegmentToRegExp(segment);
      for (const entry of entries) {
        if (entry.startsWith(".")) continue;
        if (re.test(entry)) next.push(join(base, entry));
      }
    }
    bases = next;
  }
  return bases.filter((p) => existsSync(p) && !safeIsDirectory(p));
}
function globSegmentToRegExp(segment) {
  let out = "^";
  for (const ch of segment) {
    if (ch === "*") out += "[^/]*";
    else if (ch === "?") out += "[^/]";
    else out += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  out += "$";
  return new RegExp(out);
}
function createParseIo(home = defaultHome()) {
  return {
    readFile: (path) => {
      const resolved = expandTilde(path, home);
      return safeReadFile(resolved);
    },
    readDir: (path) => safeReadDir(expandTilde(path, home)),
    paths: {
      resolve: (path, base) => {
        const expanded = expandTilde(path, home);
        if (isAbsolute(expanded)) return resolve(expanded);
        return resolve(base, expanded);
      },
      dirname: (path) => dirname(path),
      isAbsolute: (path) => isAbsolute(expandTilde(path, home)),
      glob: (pattern) => globFiles(expandTilde(pattern, home)),
      isDirectory: (path) => safeIsDirectory(expandTilde(path, home))
    },
    home
  };
}
const SUPPORTED_DIRECTIVES = [
  "host",
  "hostname",
  "port",
  "user",
  "identityfile",
  "proxyjump",
  "proxycommand",
  "identitiesonly",
  "forwardagent",
  "include",
  "addkeystoagent",
  "connecttimeout",
  "serveraliveinterval",
  "serveralivecountmax",
  "compression",
  "stricthostkeychecking",
  "usekeychain"
];
const KNOWN_UNMAPPED = {
  proxycommand: "暂不支持 ProxyCommand 形式的代理（需要任意外部命令执行）",
  connecttimeout: "连接超时已由连接选项统一管理，未映射",
  serveraliveinterval: "keepalive 由连接选项统一管理，未逐项映射",
  serveralivecountmax: "keepalive 由连接选项统一管理，未逐项映射",
  compression: "压缩开关未映射到连接选项",
  stricthostkeychecking: "主机指纹校验策略暂不支持按连接配置",
  addkeystoagent: "SSH agent 行为未映射",
  usekeychain: "macOS Keychain 集成不适用"
};
const ACCUMULATIVE = /* @__PURE__ */ new Set(["identityfile", "include"]);
const TRUTHY = /* @__PURE__ */ new Set(["yes", "true", "on", "1"]);
const FALSY = /* @__PURE__ */ new Set(["no", "false", "off", "0"]);
function parseSshConfig(entryPath, io) {
  const result = { blocks: [], errors: [], files: [] };
  const active = /* @__PURE__ */ new Set();
  const readOnce = /* @__PURE__ */ new Set();
  parseFile(
    entryPath,
    io,
    result,
    active,
    readOnce,
    /* included */
    false,
    /* depth */
    0
  );
  return result;
}
const MAX_INCLUDE_DEPTH = 32;
function parseFile(filePath, io, result, active, readOnce, included, depth) {
  const resolved = io.paths.resolve(filePath, io.home);
  if (active.has(resolved)) {
    result.errors.push({
      file: resolved,
      line: 0,
      message: `检测到循环 Include，已跳过：${resolved}`,
      text: ""
    });
    return;
  }
  if (readOnce.has(resolved)) return;
  if (depth > MAX_INCLUDE_DEPTH) {
    result.errors.push({
      file: resolved,
      line: 0,
      message: `Include 嵌套过深（>${MAX_INCLUDE_DEPTH}），已停止展开`,
      text: ""
    });
    return;
  }
  const text = io.readFile(resolved);
  if (text === null) {
    if (!included) return;
    result.errors.push({
      file: resolved,
      line: 0,
      message: `Include 的文件无法读取：${resolved}`,
      text: ""
    });
    return;
  }
  readOnce.add(resolved);
  active.add(resolved);
  result.files.push(resolved);
  const lines = text.split(/\r?\n/);
  let current = null;
  for (let i = 0; i < lines.length; i += 1) {
    const lineNo = i + 1;
    const raw = lines[i] ?? "";
    const parsed = parseLine(raw);
    if (parsed.kind === "blank") continue;
    if (parsed.kind === "error") {
      result.errors.push({ file: resolved, line: lineNo, message: parsed.message, text: raw.trim() });
      continue;
    }
    const { key: key2, value } = parsed;
    if (key2 === "host") {
      const patterns = splitPatterns(value);
      if (patterns.length === 0) {
        result.errors.push({
          file: resolved,
          line: lineNo,
          message: "Host 指令缺少匹配模式",
          text: raw.trim()
        });
        current = { patterns: [], directives: /* @__PURE__ */ new Map(), file: resolved, line: lineNo, included };
        result.blocks.push(current);
        continue;
      }
      current = { patterns, directives: /* @__PURE__ */ new Map(), file: resolved, line: lineNo, included };
      result.blocks.push(current);
      continue;
    }
    if (key2 === "include") {
      const targets = splitWords(value);
      for (const target of targets) {
        for (const expanded of expandInclude(target, resolved, io)) {
          parseFile(expanded, io, result, active, readOnce, true, depth + 1);
        }
      }
      continue;
    }
    if (current === null) {
      current = { patterns: ["*"], directives: /* @__PURE__ */ new Map(), file: resolved, line: lineNo, included };
      result.blocks.push(current);
    }
    addDirective(current, key2, value);
  }
  active.delete(resolved);
}
function addDirective(block, key2, value) {
  const existing = block.directives.get(key2);
  if (existing && ACCUMULATIVE.has(key2)) {
    existing.push(value);
    return;
  }
  if (existing) {
    block.directives.set(key2, [value]);
    return;
  }
  block.directives.set(key2, [value]);
}
function parseLine(raw) {
  let s = raw;
  s = stripComment(s).trim();
  if (s === "") return { kind: "blank" };
  let key2 = "";
  let i = 0;
  while (i < s.length && !/[\s=]/.test(s[i])) {
    key2 += s[i];
    i += 1;
  }
  if (key2 === "") {
    return { kind: "error", message: "无法识别的行（缺少指令名）" };
  }
  while (i < s.length && /\s/.test(s[i])) i += 1;
  if (s[i] === "=") {
    i += 1;
    while (i < s.length && /\s/.test(s[i])) i += 1;
  }
  const rest = s.slice(i);
  const unquoted = unquote(rest);
  if (unquoted === null) {
    return { kind: "error", message: "引号未闭合" };
  }
  return { kind: "ok", key: key2.toLowerCase(), value: unquoted };
}
function stripComment(s) {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (ch === "\\") {
      i += 1;
      continue;
    }
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (ch === "#" && !inSingle && !inDouble) {
      if (i === 0 || /\s/.test(s[i - 1])) return s.slice(0, i);
    }
  }
  return s;
}
function unquote(s) {
  const trimmed = s.trim();
  if (trimmed === "") return "";
  const first = trimmed[0];
  if (first !== '"' && first !== "'") return trimmed;
  let out = "";
  for (let i = 1; i < trimmed.length; i += 1) {
    const ch = trimmed[i];
    if (ch === "\\" && first === '"' && i + 1 < trimmed.length) {
      out += trimmed[i + 1];
      i += 1;
      continue;
    }
    if (ch === first) return out;
    out += ch;
  }
  return null;
}
function splitWords(s) {
  const out = [];
  let cur = "";
  let inSingle = false;
  let inDouble = false;
  let started = false;
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (ch === "\\" && inDouble && i + 1 < s.length) {
      cur += s[i + 1];
      i += 1;
      started = true;
      continue;
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      started = true;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      started = true;
      continue;
    }
    if (/\s/.test(ch) && !inSingle && !inDouble) {
      if (started) out.push(cur);
      cur = "";
      started = false;
      continue;
    }
    cur += ch;
    started = true;
  }
  if (started) out.push(cur);
  return out;
}
function splitPatterns(value) {
  return splitWords(value).flatMap((w) => w.split(",")).map((w) => w.trim()).filter((w) => w !== "");
}
function expandInclude(target, baseFile, io) {
  const resolved = io.paths.resolve(target, io.paths.dirname(baseFile));
  if (io.paths.isDirectory(resolved)) {
    const entries = io.readDir(resolved) ?? [];
    return entries.filter((e) => !e.startsWith(".")).filter((e) => !/[~]$/.test(e) && !/\.(bak|old|orig|swp|tmp)$/.test(e)).sort().map((e) => `${resolved.replace(/\/+$/, "")}/${e}`);
  }
  if (/[*?]/.test(resolved)) {
    const matched = io.paths.glob(resolved);
    return [...matched].sort();
  }
  return [resolved];
}
function matchHostPattern(pattern, host) {
  const p = pattern.toLowerCase();
  const h = host.toLowerCase();
  return matchFrom(p, 0, h, 0);
}
function matchFrom(p, pi, h, hi) {
  while (pi < p.length) {
    const pc = p[pi];
    if (pc === "*") {
      let next = pi;
      while (next < p.length && p[next] === "*") next += 1;
      if (next === p.length) return true;
      for (let skip = hi; skip <= h.length; skip += 1) {
        if (matchFrom(p, next, h, skip)) return true;
      }
      return false;
    }
    if (pc === "?") {
      if (hi >= h.length) return false;
      pi += 1;
      hi += 1;
      continue;
    }
    if (hi >= h.length || p[pi] !== h[hi]) return false;
    pi += 1;
    hi += 1;
  }
  return hi === h.length;
}
function isWildcardOnly(patterns) {
  return patterns.length > 0 && patterns.every((p) => /[*?]/.test(p));
}
function resolveHosts(blocks) {
  const names = [];
  const seen = /* @__PURE__ */ new Set();
  for (const block of blocks) {
    for (const pattern of block.patterns) {
      if (isWildcardOnly([pattern])) continue;
      const key2 = pattern.toLowerCase();
      if (seen.has(key2)) continue;
      seen.add(key2);
      names.push(pattern);
    }
  }
  return names.map((name) => resolveOneHost(name, blocks));
}
function resolveOneHost(name, blocks) {
  const directives = /* @__PURE__ */ new Map();
  const matchedBlocks = [];
  const fromDefaults = /* @__PURE__ */ new Set();
  for (const block of blocks) {
    const matched = block.patterns.some((p) => matchHostPattern(p, name));
    if (!matched) continue;
    matchedBlocks.push(block);
    const wildcardOnly = isWildcardOnly(block.patterns);
    for (const [key2, values] of block.directives) {
      if (directives.has(key2)) continue;
      const first = values[0];
      if (first === void 0) continue;
      directives.set(key2, first);
      if (wildcardOnly) fromDefaults.add(key2);
    }
  }
  return { name, directives, matchedBlocks, fromDefaults };
}
function getDirective(host, key2) {
  return host.directives.get(key2.toLowerCase());
}
function getBool(host, key2, fallback) {
  const raw = getDirective(host, key2);
  if (raw === void 0) return fallback;
  const v = raw.toLowerCase();
  if (TRUTHY.has(v)) return true;
  if (FALSY.has(v)) return false;
  return fallback;
}
function getInt(host, key2) {
  const raw = getDirective(host, key2);
  if (raw === void 0) return void 0;
  const n = Number.parseInt(raw.replace(/^\+/, ""), 10);
  return Number.isFinite(n) ? n : void 0;
}
function buildImportEntries(parsed, io) {
  const hosts = resolveHosts(parsed.blocks);
  const byName = /* @__PURE__ */ new Map();
  for (const h of hosts) byName.set(h.name.toLowerCase(), h);
  const entries = [];
  const unsupported = [];
  const reported = /* @__PURE__ */ new Set();
  for (const host of hosts) {
    const entry = buildEntry(host, io, byName);
    for (const [directive] of host.directives) {
      if (SUPPORTED_DIRECTIVES.includes(directive)) continue;
      const dedupeKey = `${host.name}\0${directive}`;
      if (reported.has(dedupeKey)) continue;
      reported.add(dedupeKey);
      unsupported.push({
        directive,
        host: host.name,
        reason: KNOWN_UNMAPPED[directive] ?? "本版本未支持该指令，未导入其语义"
      });
    }
    for (const [directive, reason] of Object.entries(KNOWN_UNMAPPED)) {
      if (!host.directives.has(directive)) continue;
      if (directive === "proxycommand") {
        entry.warnings.push(`ProxyCommand 未映射：${reason}`);
      }
      const dedupeKey = `${host.name}\0known:${directive}`;
      if (reported.has(dedupeKey)) continue;
      reported.add(dedupeKey);
      unsupported.push({ directive, host: host.name, reason });
    }
    entries.push(entry);
  }
  return { entries, unsupported };
}
function buildEntry(host, io, byName) {
  const warnings = [];
  const rawHostName = getDirective(host, "hostname");
  const impliedHostName = rawHostName === void 0;
  const targetHost = rawHostName ?? host.name;
  if (impliedHostName) {
    warnings.push(`未指定 HostName，已用别名 "${host.name}" 作为主机名`);
  }
  const port = getInt(host, "port") ?? 22;
  if (getDirective(host, "port") !== void 0 && getInt(host, "port") === void 0) {
    warnings.push(`Port 不是合法数字："${getDirective(host, "port")}"，已回落为 22`);
  }
  const username = getDirective(host, "user");
  const identityFiles = collectIdentityFiles(host);
  let privateKey;
  let privateKeyPath;
  if (identityFiles.length > 0) {
    const first = identityFiles[0];
    privateKeyPath = first;
    const content = readIdentity(first, io);
    if (content === null) {
      warnings.push(`私钥不可读，已跳过：${first}`);
    } else {
      privateKey = content;
    }
    if (identityFiles.length > 1) {
      warnings.push(
        `配置了 ${identityFiles.length} 个 IdentityFile，仅导入第一个（${first}）`
      );
    }
  }
  const jumpChain = buildJumpChain(host, io, byName, warnings);
  const identitiesOnly = host.directives.has("identitiesonly") ? getBool(host, "identitiesonly", false) : void 0;
  const forwardAgent = host.directives.has("forwardagent") ? getBool(host, "forwardagent", false) : void 0;
  const entry = {
    name: host.name,
    host: targetHost,
    port,
    jumpChain,
    impliedHostName,
    warnings
  };
  if (username !== void 0) entry.username = username;
  if (privateKey !== void 0) entry.privateKey = privateKey;
  if (privateKeyPath !== void 0) entry.privateKeyPath = privateKeyPath;
  if (identitiesOnly !== void 0) entry.identitiesOnly = identitiesOnly;
  if (forwardAgent !== void 0) entry.forwardAgent = forwardAgent;
  const proxyCommand = getDirective(host, "proxycommand");
  if (proxyCommand !== void 0) entry.proxyCommand = proxyCommand;
  return entry;
}
function collectIdentityFiles(host) {
  const out = [];
  for (const block of host.matchedBlocks) {
    const values = block.directives.get("identityfile");
    if (!values) continue;
    for (const v of values) {
      if (v.trim() === "" || v.toLowerCase() === "none") continue;
      if (!out.includes(v)) out.push(v);
    }
  }
  return out;
}
function readIdentity(path, io) {
  const resolved = io.paths.resolve(path, io.home);
  const content = io.readFile(resolved);
  if (content === null) return null;
  return content;
}
function buildJumpChain(host, io, byName, warnings) {
  const raw = getDirective(host, "proxyjump");
  if (raw === void 0) return [];
  const trimmed = raw.trim();
  if (trimmed === "" || trimmed.toLowerCase() === "none") return [];
  const hops = [];
  const specs = trimmed.split(",");
  for (const spec of specs) {
    const s = spec.trim();
    if (s === "") continue;
    const parsed = parseJumpSpec(s);
    if (!parsed) {
      warnings.push(`ProxyJump 条目无法解析，已跳过："${s}"`);
      continue;
    }
    const inlineBlock = byName.get(parsed.host.toLowerCase());
    const inline = inlineBlock ? buildInlineJump(inlineBlock, io) : void 0;
    const username = parsed.username ?? inline?.username ?? "";
    const hop = {
      id: randomUUID(),
      name: inline?.name ?? parsed.host,
      host: inline?.host ?? parsed.host,
      port: parsed.port ?? inline?.port ?? 22,
      username,
      authType: inline?.privateKey !== void 0 ? "privateKey" : "password",
      // 跳板默认校验指纹（安全默认），与 SshConnection 的默认行为一致
      verifyHostKey: true
    };
    if (inline?.privateKey !== void 0) {
      hop.privateKey = inline.privateKey;
      if (inline.passphrase !== void 0) hop.passphrase = inline.passphrase;
    }
    if (username === "") {
      warnings.push(`跳板 ${parsed.host} 未提供用户名（config 里也没有对应 Host 定义）`);
    }
    hops.push(hop);
  }
  return hops;
}
function isBareIpv6(value) {
  if (value.includes("::")) return true;
  const colons = (value.match(/:/g) ?? []).length;
  return colons >= 2;
}
function parseJumpSpec(spec) {
  let rest = spec.trim();
  if (rest === "") return null;
  if (rest.startsWith('"') && rest.endsWith('"') && rest.length >= 2 || rest.startsWith("'") && rest.endsWith("'") && rest.length >= 2) {
    rest = rest.slice(1, -1);
  }
  let username;
  const at = rest.lastIndexOf("@");
  if (at >= 0) {
    username = rest.slice(0, at);
    rest = rest.slice(at + 1);
  }
  let host = rest;
  let port;
  if (rest.startsWith("[")) {
    const close = rest.indexOf("]");
    if (close < 0) return null;
    host = rest.slice(1, close);
    const tail = rest.slice(close + 1);
    if (tail.startsWith(":")) {
      const p = Number.parseInt(tail.slice(1), 10);
      if (Number.isFinite(p)) port = p;
    }
  } else if (!isBareIpv6(rest)) {
    const colon = rest.lastIndexOf(":");
    if (colon >= 0) {
      const maybePort = rest.slice(colon + 1);
      if (/^\d+$/.test(maybePort) && !rest.slice(0, colon).endsWith(":")) {
        host = rest.slice(0, colon);
        const p = Number.parseInt(maybePort, 10);
        if (Number.isFinite(p)) port = p;
      }
    }
  }
  if (host === "") return null;
  const out = { host };
  if (username !== void 0 && username !== "") out.username = username;
  if (port !== void 0) out.port = port;
  return out;
}
function buildInlineJump(block, io) {
  const hostName = getDirective(block, "hostname") ?? block.name;
  const port = getInt(block, "port") ?? 22;
  const username = getDirective(block, "user");
  const out = { name: block.name, host: hostName, port };
  if (username !== void 0) out.username = username;
  const identityFiles = collectIdentityFiles(block);
  const first = identityFiles[0];
  if (first !== void 0) {
    const content = readIdentity(first, io);
    if (content !== null) {
      out.privateKey = content;
    }
  }
  return out;
}
function importOpenSshConfig(options) {
  const { path, io, sink } = options;
  const dryRun = options.dryRun ?? false;
  const policy = options.conflictPolicy ?? "skip";
  const nowFn = options.now ?? (() => /* @__PURE__ */ new Date());
  const parsedConfig = parseSshConfig(path, io);
  const { entries, unsupported } = buildImportEntries(parsedConfig, io);
  const result = {
    source: path,
    parsed: entries.length,
    created: 0,
    skipped: 0,
    renamed: 0,
    overwritten: 0,
    dryRun,
    entries: [],
    unsupported,
    errors: parsedConfig.errors.map((e) => ({
      line: e.line,
      message: e.message,
      // 出错行文本里带上文件名，Include 场景下才知道是哪个文件出的问题
      text: e.file === parsedConfig.files[0] ? e.text : `${e.text}  (${e.file})`
    }))
  };
  const existing = sink.listConnections();
  const existingNames = /* @__PURE__ */ new Map();
  for (const conn of existing) {
    existingNames.set(conn.name.toLowerCase(), conn);
  }
  const usedNames = new Set(existingNames.keys());
  for (const entry of entries) {
    const view = {
      name: entry.name,
      host: entry.host,
      port: entry.port
    };
    if (entry.username !== void 0) view.username = entry.username;
    if (entry.warnings.length > 0) view.warnings = [...entry.warnings];
    const finalName = resolveName(entry.name, { existingNames, usedNames, policy, view });
    if (finalName === null) {
      result.skipped += 1;
      result.entries.push(view);
      continue;
    }
    view.name = finalName;
    result.entries.push(view);
    usedNames.add(finalName.toLowerCase());
    if (finalName.toLowerCase() !== entry.name.toLowerCase()) {
      result.renamed += 1;
    } else if (existingNames.has(finalName.toLowerCase())) {
      result.overwritten += 1;
    } else {
      result.created += 1;
    }
    if (dryRun) continue;
    const now = nowFn().toISOString();
    const target = existingNames.get(finalName.toLowerCase());
    const connection = toConnection(entry, {
      id: target?.id ?? randomUUID(),
      name: finalName,
      now,
      createdAt: target?.createdAt ?? now
    });
    const saved = sink.saveConnection(connection, now);
    existingNames.set(saved.name.toLowerCase(), saved);
  }
  return result;
}
function resolveName(original, ctx) {
  const key2 = original.toLowerCase();
  const conflicts = ctx.existingNames.has(key2) || ctx.usedNames.has(key2);
  if (!conflicts) return original;
  switch (ctx.policy) {
    case "skip":
      return null;
    case "overwrite":
      return original;
    case "rename": {
      const renamed = nextAvailableName(original, ctx.usedNames);
      ctx.view.warnings = [...ctx.view.warnings ?? [], `名称冲突，已重命名为 "${renamed}"`];
      return renamed;
    }
  }
}
function nextAvailableName(base, used) {
  for (let i = 2; i < 1e3; i += 1) {
    const candidate = `${base} (${i})`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
  return `${base} (${randomUUID().slice(0, 8)})`;
}
function toConnection(entry, meta) {
  const conn = {
    kind: "ssh",
    id: meta.id,
    name: meta.name,
    host: entry.host,
    port: entry.port,
    username: entry.username ?? "",
    // 有私钥就按私钥认证，否则密码认证（导入后由用户补密码）
    authType: entry.privateKey !== void 0 ? "privateKey" : "password",
    createdAt: meta.createdAt,
    updatedAt: meta.now
  };
  if (entry.privateKey !== void 0) conn.privateKey = entry.privateKey;
  if (entry.username === void 0) {
    conn.note = "从 OpenSSH 配置导入，未指定 User";
  }
  if (entry.jumpChain.length > 0) conn.jumpChain = entry.jumpChain;
  return conn;
}
const META_VERIFIER = "master_password_verifier";
const MAX_SPLIT_DEPTH = 8;
const layoutTabSchema = z.object({
  connectionId: z.string().min(1),
  title: z.string().optional()
});
const makeSplitNodeSchema = (depth) => z.lazy(
  () => z.union([
    z.object({ kind: z.literal("leaf"), tabIndex: z.number().int().min(0) }),
    z.object({
      kind: z.literal("split"),
      direction: z.enum(["horizontal", "vertical"]),
      ratio: z.number().min(0).max(1),
      first: depth <= 0 ? z.never() : makeSplitNodeSchema(depth - 1),
      second: depth <= 0 ? z.never() : makeSplitNodeSchema(depth - 1)
    })
  ])
);
const layoutSchema = z.object({
  id: z.string().min(1),
  connectionId: z.string().optional(),
  name: z.string().max(200).optional(),
  isTemplate: z.boolean(),
  tabs: z.array(layoutTabSchema).max(64),
  split: makeSplitNodeSchema(MAX_SPLIT_DEPTH).nullable().optional(),
  panels: z.object({
    left: z.boolean().optional(),
    right: z.boolean().optional(),
    bottom: z.boolean().optional()
  }).optional(),
  createdAt: z.string(),
  updatedAt: z.string()
});
const idSchema = z.string().min(1, "id 不能为空");
const connectionKindSchema = z.enum(["ssh", "rdp", "telnet", "tunnel", "vnc"]);
const groupKindSchema = z.enum(["ssh", "rdp", "telnet", "tunnel", "vnc", "mixed"]);
const storeTypeSchema = z.enum(["local", "cloud"]);
z.enum(["password", "privateKey", "identity", "keyboardInteractive", "keyboard"]);
const connectionInputSchema = z.object({
  id: idSchema,
  name: z.string().min(1, "名称不能为空").max(200),
  kind: connectionKindSchema,
  /**
   * 主机与端口在**公共部分必须可选**。
   *
   * 原因：隧道连接（`TunnelConnection`）用的是 localHost/localPort/remoteHost/remotePort，
   * **契约里根本没有 host/port**。此前公共部分强制要求它们，
   * 导致隧道连接一律保存失败（报 `host: Required; port: Required`）。
   * 必需性改由下面的 superRefine 按 kind 分别判定。
   */
  host: z.string().min(1, "主机不能为空").max(255).optional(),
  port: z.number().int().min(1).max(65535).optional(),
  groupId: z.string().min(1).optional(),
  username: z.string().max(255).optional(),
  storeType: storeTypeSchema.optional()
}).passthrough().superRefine((value, ctx) => {
  const requireField = (field, message) => {
    const v = value[field];
    if (v === void 0 || v === null || v === "") {
      ctx.addIssue({ code: "custom", path: [field], message });
    }
  };
  if (value.kind === "tunnel") {
    requireField("serverId", "必须指定承载隧道的 SSH 连接");
    requireField("localHost", "本机监听地址不能为空");
    requireField("localPort", "本机监听端口不能为空");
    requireField("remoteHost", "远端地址不能为空");
    requireField("remotePort", "远端端口不能为空");
    return;
  }
  requireField("host", "主机不能为空");
  requireField("port", "端口不能为空");
});
const groupInputSchema = z.object({
  id: idSchema,
  name: z.string().min(1, "分组名不能为空").max(200),
  parentId: z.string().min(1).optional(),
  kind: groupKindSchema,
  sortOrder: z.number().int().optional(),
  storeType: storeTypeSchema.optional()
}).passthrough();
const credentialInputSchema = z.object({
  id: idSchema,
  name: z.string().min(1, "凭证名不能为空").max(200),
  username: z.string().max(255).optional(),
  password: z.string().optional(),
  privateKey: z.string().optional(),
  passphrase: z.string().optional(),
  note: z.string().optional()
}).passthrough();
const masterPasswordSchema = z.object({
  /** 改密码时提供旧密码；首次设置时省略 */
  oldPassword: z.string().min(1).optional(),
  newPassword: z.string().min(8, "主密码至少 8 位")
});
const unlockSchema = z.object({
  password: z.string().min(1, "主密码不能为空")
});
const exportBackupSchema = z.object({
  /** 备份口令；省略则用当前主密码派生的密钥 */
  passphrase: z.string().min(1).optional(),
  /** 输出目录；省略则用 ctx.paths.backupDir */
  dir: z.string().min(1).optional(),
  filePath: z.string().min(1).optional()
});
const importBackupSchema = z.object({
  data: z.union([z.string().min(1), z.instanceof(Buffer)]),
  passphrase: z.string().min(1).optional(),
  mode: z.enum(["replace", "merge"]).optional()
});
const searchSchema$1 = z.object({
  keyword: z.string().min(1, "搜索词不能为空").max(200),
  limit: z.number().int().min(1).max(1e3).optional()
});
const connectionIdSchema = z.object({ id: idSchema });
const moveConnectionSchema = z.object({
  id: idSchema,
  /** null / 省略 = 移出分组 */
  groupId: z.string().min(1).nullable().optional()
});
const deleteGroupSchema = z.object({
  id: idSchema,
  /** false = 子分组提升一层，连接移出分组 */
  cascade: z.boolean().optional()
});
const importOpenSshSchema = z.object({
  /** 配置文件路径；省略则用 ~/.ssh/config */
  path: z.string().min(1).optional(),
  /** 只解析不写库（UI 预览用） */
  dryRun: z.boolean().optional(),
  /** 同名连接的处理方式 */
  conflictPolicy: z.enum(["skip", "rename", "overwrite"]).optional()
});
function parseInput(schema, payload) {
  const result = schema.safeParse(payload);
  if (!result.success) {
    const issues = result.error.issues.map((i) => ({
      path: i.path.join("."),
      message: i.message
    }));
    throw AppError.badRequest(`参数校验失败: ${issues.map((i) => `${i.path}: ${i.message}`).join("; ")}`, issues);
  }
  return result.data;
}
class StoreService {
  constructor(dbFile = ":memory:", vault = new Vault()) {
    this.db = typeof dbFile === "string" ? new StoreDb(dbFile) : dbFile;
    this.vault = vault;
    this.repo = new Repository(this.db, () => this.vault.currentKey());
  }
  // ------------------------------------------------------------- 主密码
  /** 是否已经设置过主密码 */
  isInitialized() {
    return this.db.getMeta(META_VERIFIER) !== void 0;
  }
  isUnlocked() {
    return this.vault.isUnlocked();
  }
  /**
   * 解锁。校验记录不存在时视为「首次设置」（用 newPassword 语义）。
   *
   * @returns 是否成功
   */
  unlock(password) {
    const record = this.db.getMeta(META_VERIFIER);
    if (record === void 0) {
      this.setMasterPassword(password);
      return true;
    }
    const key2 = verifyAndDerive(password, record);
    if (!key2) return false;
    this.vault.unlockWithKey(key2);
    return true;
  }
  lock() {
    this.vault.lock();
  }
  /**
   * 设置 / 修改主密码。
   *
   * 已初始化时必须提供正确的旧密码；修改时**重加密全部密文字段**，
   * 整个过程在一个事务里，失败回滚（不会出现半加密状态）。
   */
  setMasterPassword(newPassword, oldPassword) {
    const record = this.db.getMeta(META_VERIFIER);
    if (record === void 0) {
      const { key: key2, verifier } = deriveNewCredentials(newPassword);
      this.vault.unlockWithKey(key2);
      this.db.setMeta(META_VERIFIER, verifier);
      return { reencrypted: 0, created: true };
    }
    if (oldPassword === void 0) {
      throw AppError.badRequest("修改主密码需要提供旧密码");
    }
    const oldKey = verifyAndDerive(oldPassword, record);
    if (!oldKey) {
      throw AppError.unauthorized("旧主密码不正确");
    }
    this.vault.unlockWithKey(oldKey);
    const { key: newKey, verifier: newVerifierRecord } = deriveNewCredentials(newPassword);
    const reencrypted = this.repo.reencryptAll(oldKey, newKey);
    this.db.transaction(() => {
      this.db.setMeta(META_VERIFIER, newVerifierRecord);
    });
    this.vault.unlockWithKey(newKey);
    return { reencrypted, created: false };
  }
  // --------------------------------------------------------------- 连接
  listConnections() {
    return this.repo.listConnections();
  }
  getConnection(id) {
    const conn = this.repo.getConnection(id);
    if (!conn) throw AppError.notFound(`连接不存在: ${id}`);
    return conn;
  }
  saveConnection(input) {
    const now = (/* @__PURE__ */ new Date()).toISOString();
    return this.repo.saveConnection(input, now);
  }
  deleteConnection(id) {
    const deleted = this.repo.deleteConnection(id);
    if (!deleted) throw AppError.notFound(`连接不存在: ${id}`);
    return { deleted };
  }
  moveConnection(id, groupId) {
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const target = groupId === null ? void 0 : groupId;
    if (target !== void 0 && !this.repo.getGroup(target)) {
      throw AppError.notFound(`分组不存在: ${target}`);
    }
    const moved = this.repo.moveConnection(id, target, now);
    if (!moved) throw AppError.notFound(`连接不存在: ${id}`);
    return moved;
  }
  // --------------------------------------------------------------- 分组
  /** 工作区布局（按连接独立；isTemplate 的用于跨连接复用） */
  listLayouts() {
    return this.repo.listLayouts();
  }
  saveLayout(input) {
    if (!input.id) throw new Error("布局缺少 id");
    return this.repo.saveLayout(input, (/* @__PURE__ */ new Date()).toISOString());
  }
  deleteLayout(id) {
    return this.repo.deleteLayout(id);
  }
  listGroups() {
    return this.repo.listGroups();
  }
  /** 分组树（含直属连接数） */
  listGroupTree() {
    return this.repo.buildGroupTree();
  }
  saveGroup(input) {
    if (input.parentId !== void 0) {
      if (input.parentId === input.id) throw AppError.badRequest("分组不能以自己为父级");
      if (!this.repo.getGroup(input.parentId)) {
        throw AppError.notFound(`父分组不存在: ${input.parentId}`);
      }
    }
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const normalized = { ...input, sortOrder: input.sortOrder ?? 0 };
    return this.repo.saveGroup(normalized, now);
  }
  deleteGroup(id, cascade = true) {
    const result = this.repo.deleteGroup(id, cascade);
    if (result.deletedGroups.length === 0) throw AppError.notFound(`分组不存在: ${id}`);
    return result;
  }
  // --------------------------------------------------------------- 凭证
  listCredentials() {
    return this.repo.listCredentials();
  }
  saveCredential(input) {
    return this.repo.saveCredential(input, (/* @__PURE__ */ new Date()).toISOString());
  }
  // --------------------------------------------------------------- 搜索
  search(keyword, limit) {
    return this.repo.search(keyword, limit);
  }
  // --------------------------------------------------- 导入 OpenSSH 配置
  /**
   * 解析 `~/.ssh/config` 并批量导入连接。
   *
   * 与 `importBackup` 是**两件事**：这里读的是用户既有的 OpenSSH 明文配置，
   * 产出的是普通连接（敏感字段仍然走 Repository 的加密路径落库）。
   *
   * @param params.path 默认 `~/.ssh/config`；不存在时报明确错误
   * @param params.dryRun true 时只解析不写库，供 UI 预览
   */
  importOpenSsh(params = {}) {
    const home = params.home ?? defaultHome();
    const path = params.path ?? defaultSshConfigPath(home);
    const io = params.io ?? createParseIo(home);
    const resolvedPath = io.paths.resolve(path, home);
    const absolutePath = resolvedPath.startsWith("/") ? resolvedPath : path;
    if (io.readFile(resolvedPath) === null) {
      const dirReadable = io.paths.isDirectory(io.paths.dirname(resolvedPath));
      throw AppError.notFound(
        dirReadable ? `未找到 ${absolutePath}（若文件确实存在，请检查读取权限）` : `未找到 ${absolutePath}`
      );
    }
    const dryRun = params.dryRun ?? false;
    if (!dryRun && !this.isUnlocked()) {
      throw AppError.unauthorized("导入 OpenSSH 配置需要先解锁（私钥需要加密存储）");
    }
    const result = importOpenSshConfig({
      path,
      dryRun,
      ...params.conflictPolicy === void 0 ? {} : { conflictPolicy: params.conflictPolicy },
      io,
      sink: this.repo
    });
    const missingKeys = result.entries.filter((e) => e.warnings?.some((w) => w.includes("私钥不可读"))).map((e) => e.name);
    return { ...result, missingKeys };
  }
  // --------------------------------------------------------------- 备份
  /**
   * 导出加密备份并落盘。
   *
   * 密钥优先级：`passphrase` > 已解锁的主密码。
   * 两者都没有时拒绝（不能导出明文备份——那等于把密码库摊开在磁盘上）。
   */
  exportBackupToFile(params) {
    const { data, fileName, counts } = this.renderBackup(params.passphrase);
    const target = params.filePath ?? join(params.dir ?? params.backupDir, fileName);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, data, { mode: 384 });
    return { fileName, filePath: target, bytes: data.byteLength, counts };
  }
  /**
   * 生成备份字节（不落盘，测试与同步模块复用）。
   *
   * 带口令时会把敏感字段从「本机主密钥」迁移到「备份口令派生的字段密钥」，
   * 这样备份才能跨设备还原凭据（不带口令的本地备份行为不变）。
   * 未解锁时无法完成字段迁移，直接报错而不是写出一个凭据解不开的备份。
   */
  renderBackup(passphrase, entities) {
    const key2 = this.resolveExportKey(passphrase);
    try {
      const { data, fileName, envelope } = exportBackup(this.db, {
        ...passphrase === void 0 ? {} : { passphrase },
        ...passphrase === void 0 && key2 ? { key: key2 } : {},
        ...entities === void 0 ? {} : { entities },
        // 字段级编解码复用 repository 的递归扫描（不另造字段清单）
        fieldCodec: this.repo,
        masterKey: this.vault.currentKey()
      });
      return { data, fileName, counts: envelope.meta?.counts ?? {} };
    } catch (err) {
      throw this.toBackupError(err);
    }
  }
  /** 导入备份（带口令的备份会把凭据重新加密到本机主密钥后再落库） */
  importBackup(data, options = {}) {
    const key2 = this.resolveExportKey(options.passphrase);
    try {
      return importBackup(this.db, data, {
        ...options.passphrase === void 0 ? {} : { passphrase: options.passphrase },
        ...options.passphrase === void 0 && key2 ? { key: key2 } : {},
        ...options.mode === void 0 ? {} : { mode: options.mode },
        fieldCodec: this.repo,
        masterKey: this.vault.currentKey()
      });
    } catch (err) {
      throw this.toBackupError(err);
    }
  }
  /** 备份层错误 → 带语义的 IPC 错误码 */
  toBackupError(err) {
    if (err instanceof BackupFormatError) return AppError.badRequest(err.message);
    if (err instanceof BackupDecryptError) return AppError.unauthorized(err.message);
    if (err instanceof BackupLockedError) return AppError.unauthorized(err.message);
    if (err instanceof BackupConfigError) return AppError.internal(err.message);
    if (err instanceof AppError) return err;
    return AppError.internal(err instanceof Error ? err.message : String(err));
  }
  /** 备份文件名（渲染层预览用） */
  suggestBackupFileName() {
    return backupFileName();
  }
  /**
   * 用主密码密钥封装任意字符串。
   *
   * 用途：那些不属于「连接/凭证」实体、但同样是机密的少量数据
   * （例如同步服务的访问令牌）。设置文档是无需解锁即可读的，
   * 令牌绝不能明文躺在里面。
   *
   * 未解锁时抛错 —— 调用方应把它当作「需要用户解锁」处理，而不是降级明文存储。
   */
  sealValue(plain) {
    const key2 = this.vault.currentKey();
    if (!key2) throw AppError.unauthorized("未解锁，无法加密数据");
    return encryptWithKey(key2, plain);
  }
  /** 解开 sealValue 的结果；未解锁或密文损坏都抛错（不返回空串，避免静默失败） */
  openValue(sealed) {
    const key2 = this.vault.currentKey();
    if (!key2) throw AppError.unauthorized("未解锁，无法解密数据");
    if (!isCiphertext(sealed)) {
      throw AppError.badRequest("数据不是本机封装的密文");
    }
    return decryptWithKey(key2, sealed);
  }
  /** 导出密钥：口令优先，否则用已解锁的主密码密钥；都没有则拒绝 */
  resolveExportKey(passphrase) {
    if (passphrase !== void 0) return null;
    const key2 = this.vault.currentKey();
    if (!key2) {
      throw AppError.unauthorized("未解锁且未提供备份口令，无法导出加密备份");
    }
    return key2;
  }
  close() {
    this.vault.lock();
    this.db.close();
  }
}
function deriveNewCredentials(password) {
  const verifier = createVerifier(password);
  const key2 = verifyAndDerive(password, verifier);
  if (!key2) throw AppError.internal("主密码派生失败");
  return { key: key2, verifier };
}
let service$1 = null;
function getStoreService(dbFile) {
  if (!service$1) {
    service$1 = new StoreService(":memory:");
  }
  return service$1;
}
function ensureService(ctx) {
  if (!service$1) {
    service$1 = new StoreService(ctx.paths.dbFile);
    if (ctx.paths.dbFile !== ":memory:" && ctx.paths.userData) {
      try {
        const report = importLegacyReferenceStores(service$1.db, dirname(ctx.paths.userData));
        if (report) {
          const n = Object.entries(report.imported).map(([k, v]) => `${k}:${v}`).join(" ");
          if (n) console.info(`[store] 已从旧版数据导入：${n}（跳过 ${report.skipped}）`);
          for (const e of report.errors) console.warn(`[store] 旧数据导入告警：${e}`);
        }
      } catch (err) {
        console.warn("[store] 旧数据导入失败（不影响使用）：", err);
      }
    }
  }
  return service$1;
}
const storeHandlers = {
  // ------------------------------------------------------------- 连接
  listConnections: (_payload, ctx) => ensureService(ctx).listConnections(),
  getConnection: (payload, ctx) => {
    const { id } = parseInput(connectionIdSchema, payload);
    return ensureService(ctx).getConnection(id);
  },
  saveConnection: (payload, ctx) => {
    const input = parseInput(connectionInputSchema, payload);
    return ensureService(ctx).saveConnection(input);
  },
  deleteConnection: (payload, ctx) => {
    const { id } = parseInput(connectionIdSchema, payload);
    return ensureService(ctx).deleteConnection(id);
  },
  moveConnection: (payload, ctx) => {
    const { id, groupId } = parseInput(moveConnectionSchema, payload);
    return ensureService(ctx).moveConnection(id, groupId);
  },
  // ------------------------------------------------------------- 分组
  listLayouts: (_payload, ctx) => ({ layouts: ensureService(ctx).listLayouts() }),
  saveLayout: (payload, ctx) => {
    const { layout } = parseInput(z.object({ layout: layoutSchema }), payload);
    return ensureService(ctx).saveLayout(layout);
  },
  deleteLayout: (payload, ctx) => {
    const { id } = parseInput(z.object({ id: z.string().min(1) }), payload);
    return { id, deleted: ensureService(ctx).deleteLayout(id) };
  },
  listGroups: (_payload, ctx) => ensureService(ctx).listGroupTree(),
  saveGroup: (payload, ctx) => {
    const input = parseInput(groupInputSchema, payload);
    return ensureService(ctx).saveGroup(input);
  },
  deleteGroup: (payload, ctx) => {
    const { id, cascade } = parseInput(deleteGroupSchema, payload);
    return ensureService(ctx).deleteGroup(id, cascade ?? true);
  },
  // ------------------------------------------------------------- 凭证
  listCredentials: (_payload, ctx) => ensureService(ctx).listCredentials(),
  saveCredential: (payload, ctx) => {
    const input = parseInput(credentialInputSchema, payload);
    return ensureService(ctx).saveCredential(input);
  },
  // ------------------------------------------------------------- 备份
  exportBackup: (payload, ctx) => {
    const opts = parseInput(exportBackupSchema, payload ?? {});
    const svc = ensureService(ctx);
    return svc.exportBackupToFile({
      ...opts.passphrase === void 0 ? {} : { passphrase: opts.passphrase },
      ...opts.dir === void 0 ? {} : { dir: opts.dir },
      ...opts.filePath === void 0 ? {} : { filePath: opts.filePath },
      backupDir: ctx.paths.backupDir
    });
  },
  importBackup: (payload, ctx) => {
    const opts = parseInput(importBackupSchema, payload);
    const svc = ensureService(ctx);
    return svc.importBackup(opts.data, {
      ...opts.passphrase === void 0 ? {} : { passphrase: opts.passphrase },
      ...opts.mode === void 0 ? {} : { mode: opts.mode }
    });
  },
  // ------------------------------------------------------------- 主密码
  setMasterPassword: (payload, ctx) => {
    const { oldPassword, newPassword } = parseInput(masterPasswordSchema, payload);
    return ensureService(ctx).setMasterPassword(newPassword, oldPassword);
  },
  unlock: (payload, ctx) => {
    const { password } = parseInput(unlockSchema, payload);
    const ok = ensureService(ctx).unlock(password);
    if (!ok) throw AppError.unauthorized("主密码不正确");
    return { unlocked: true };
  },
  lock: (_payload, ctx) => {
    ensureService(ctx).lock();
    return { unlocked: false };
  },
  isUnlocked: (_payload, ctx) => {
    const svc = ensureService(ctx);
    return { unlocked: svc.isUnlocked(), initialized: svc.isInitialized() };
  },
  // ------------------------------------------------------------- 搜索
  search: (payload, ctx) => {
    const { keyword, limit } = parseInput(searchSchema$1, payload);
    return ensureService(ctx).search(keyword, limit);
  },
  // --------------------------------------------- 导入 OpenSSH 配置（~/.ssh/config）
  importOpenSsh: (payload, ctx) => {
    const opts = parseInput(importOpenSshSchema, payload ?? {});
    return ensureService(ctx).importOpenSsh({
      ...opts.path === void 0 ? {} : { path: opts.path },
      ...opts.dryRun === void 0 ? {} : { dryRun: opts.dryRun },
      ...opts.conflictPolicy === void 0 ? {} : { conflictPolicy: opts.conflictPolicy }
    });
  }
};
const index$7 = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  CIPHER_VERSION,
  StoreService,
  decryptWithKey,
  getStoreService,
  isCiphertext,
  isLockedMask,
  storeHandlers
}, Symbol.toStringTag, { value: "Module" }));
const log$4 = createLogger("settings");
const SETTINGS_ITEM_ID = "app";
const SETTINGS_VERSION = 1;
const DEFAULT_APP_SETTINGS = {
  theme: "system",
  language: "zh-CN",
  restoreLastSession: true,
  minimizeToTray: false,
  showTrayIcon: true,
  autoCheckUpdate: true,
  updateChannel: "stable",
  // 默认提示（不打扰与有更新知道之间，选让用户知道）
  updatePromptMode: "prompt",
  // 遥测默认关闭（隐私优先）
  telemetry: false,
  // 开机自启默认关闭（不替用户决定开机行为）
  openAtLogin: false,
  // 关闭确认默认关闭（不额外打断）
  confirmOnClose: false,
  // 硬件加速默认开启（关掉会明显变慢，只有兼容性问题时才需要关）
  hardwareAcceleration: true,
  // 每日自动备份默认开启：这是**数据安全**项，默认保护更划算
  dailyBackup: true
};
const DEFAULT_SECURITY_SETTINGS = {
  // 默认不自动锁：不替用户决定"多久没操作就锁屏"
  autoLockMinutes: 0,
  // spec：备份保留 7 天
  backupRetentionDays: 7
};
const DEFAULT_TERMINAL_SETTINGS = {
  fontFamily: "'JetBrains Mono', 'Cascadia Code', Menlo, Consolas, monospace",
  fontSize: 13,
  lineHeight: 1.2,
  letterSpacing: 0,
  cursorStyle: "block",
  cursorBlink: true,
  copyOnSelect: false,
  rightClickPaste: false,
  scrollback: 1e4,
  // 默认关闭：斑马纹是辅助，不该替用户改变默认观感
  zebraStripes: false,
  wrapLines: true,
  bell: "none",
  defaultEncoding: "utf-8",
  colorScheme: "default-dark",
  linkDetection: true,
  // 0.2.0：kitty 内核 + 自绘 WebGL2。失败会自动回落 xterm（窗格会提示原因）
  renderer: "kitty",
  fontWeight: 450,
  boldWeight: 700,
  fontFeatures: [],
  ligatures: true,
  padding: 6,
  backgroundOpacity: 1,
  cursorOpacity: 1,
  cursorInactiveStyle: "outline",
  wheelMultiplier: 3,
  selectionBackground: "#3ec9d6",
  selectionForeground: "#0d0f14",
  underlineColor: "",
  kittyGraphics: true,
  // 空数组 = 用配色方案自带的 16 色
  palette: [],
  termType: "xterm-kitty"
};
const DEFAULT_COMPLETION_SETTINGS$1 = {
  enabled: true,
  specCompletion: true,
  historyCompletion: true,
  // 生成式补全会起后台进程，默认关闭
  generatorCompletion: false,
  aiSuggestion: false,
  debounceMs: 80,
  maxSuggestions: 20
};
const DEFAULT_AI_SETTINGS = {
  providers: [],
  mode: "chat",
  // 默认不允许执行命令（安全默认，用户显式开启）
  allowExecution: false,
  riskPolicy: {
    readOnlyAllowlist: [],
    dangerousDenylist: [],
    confirmSudo: true
  },
  limits: {
    maxRounds: 20,
    maxCommands: 50,
    maxTargets: 5
  }
};
const DEFAULT_TRANSFER_SETTINGS = {
  maxInflightPerConnection: 4,
  progressThrottleMs: 200,
  conflictPolicy: "ask",
  preservePermissions: true,
  preserveTimestamps: false
};
const DEFAULT_SYNC_SETTINGS = {
  enabled: false,
  autoSync: false,
  conflictPolicy: "keep-newest",
  scopes: {
    connections: true,
    groups: true,
    credentials: true,
    notes: true,
    settings: true
  }
};
const DEFAULT_HIGHLIGHTS = [
  {
    id: "builtin-error",
    name: "错误关键字",
    pattern: "\\b(error|failed|fatal|exception|denied|refused)\\b",
    flags: "gi",
    foreground: "#e5484d",
    priority: 10,
    enabled: true,
    builtin: true
  },
  {
    id: "builtin-warn",
    name: "警告关键字",
    pattern: "\\b(warn|warning|deprecated|retry)\\b",
    flags: "gi",
    foreground: "#d9a441",
    priority: 9,
    enabled: true,
    builtin: true
  },
  {
    id: "builtin-ok",
    name: "成功关键字",
    pattern: "\\b(ok|success|done|passed|active\\s*\\(running\\))\\b",
    flags: "gi",
    foreground: "#46b17b",
    priority: 8,
    enabled: true,
    builtin: true
  },
  {
    id: "builtin-ip",
    name: "IPv4 地址",
    pattern: "\\b(?:\\d{1,3}\\.){3}\\d{1,3}\\b",
    flags: "g",
    foreground: "#3ec9d6",
    priority: 6,
    enabled: true,
    builtin: true
  }
];
const DEFAULT_HOTKEYS = [
  { id: "hk-new-tab", command: "terminal.newTab", accelerator: "Ctrl+Shift+T", global: false, enabled: true },
  { id: "hk-close-tab", command: "terminal.closeTab", accelerator: "Ctrl+Shift+W", global: false, enabled: true },
  { id: "hk-find", command: "terminal.find", accelerator: "Ctrl+Shift+F", global: false, enabled: true },
  { id: "hk-clear", command: "terminal.clear", accelerator: "Ctrl+Shift+L", global: false, enabled: true },
  { id: "hk-split-h", command: "terminal.splitHorizontal", accelerator: "Ctrl+Shift+D", global: false, enabled: true },
  { id: "hk-split-v", command: "terminal.splitVertical", accelerator: "Ctrl+Shift+E", global: false, enabled: true },
  { id: "hk-toggle-window", command: "app.toggleWindow", accelerator: "Ctrl+Shift+Space", global: true, enabled: false }
];
function defaultSettings() {
  return {
    app: { ...DEFAULT_APP_SETTINGS },
    security: { ...DEFAULT_SECURITY_SETTINGS },
    terminal: { ...DEFAULT_TERMINAL_SETTINGS },
    completion: { ...DEFAULT_COMPLETION_SETTINGS$1 },
    highlights: DEFAULT_HIGHLIGHTS.map((r) => ({ ...r })),
    ai: structuredClone(DEFAULT_AI_SETTINGS),
    transfer: { ...DEFAULT_TRANSFER_SETTINGS },
    hotkeys: DEFAULT_HOTKEYS.map((k) => ({ ...k })),
    sync: structuredClone(DEFAULT_SYNC_SETTINGS)
  };
}
const isPlainObject$1 = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
function deepMerge(base, patch) {
  if (!isPlainObject$1(base) || !isPlainObject$1(patch)) {
    return patch === void 0 ? base : patch;
  }
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v === void 0) continue;
    const cur = out[k];
    out[k] = isPlainObject$1(cur) && isPlainObject$1(v) ? deepMerge(cur, v) : v;
  }
  return out;
}
function getPath(obj, path) {
  const parts = path.split(".").filter(Boolean);
  let cur = obj;
  for (const p of parts) {
    if (!isPlainObject$1(cur)) return void 0;
    cur = cur[p];
  }
  return cur;
}
function setPath(obj, path, value) {
  const parts = path.split(".").filter(Boolean);
  if (parts.length === 0) throw AppError.badRequest("设置路径不能为空");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i];
    const next = cur[p];
    if (!isPlainObject$1(next)) {
      cur[p] = {};
    }
    cur = cur[p];
  }
  cur[parts[parts.length - 1]] = value;
}
function readDoc() {
  const db = getStoreService().db;
  const row = db.get(storeKeyOf("Settings"), SETTINGS_ITEM_ID);
  if (!row) return defaultSettings();
  try {
    const parsed = JSON.parse(row.payload);
    return deepMerge(defaultSettings(), parsed.data ?? {});
  } catch (err) {
    log$4.warn("设置文档损坏，回退默认值", err);
    return defaultSettings();
  }
}
function writeDoc(settings2) {
  const db = getStoreService().db;
  const doc = { version: SETTINGS_VERSION, data: settings2 };
  const now = Date.now();
  db.put(storeKeyOf("Settings"), SETTINGS_ITEM_ID, JSON.stringify(doc), now);
}
let cache = null;
function getSettings() {
  if (!cache) cache = readDoc();
  return cache;
}
function updateSettings(patch) {
  const next = deepMerge(getSettings(), patch);
  writeDoc(next);
  cache = next;
  return next;
}
function resetSettingsCache() {
  cache = null;
}
const RECORDING_SETTINGS_GROUP = "sessionRecording";
function readRecordingSettings() {
  const raw = getSettings()[RECORDING_SETTINGS_GROUP];
  return isPlainObject$1(raw) ? raw : void 0;
}
function updateRecordingSettings(patch) {
  const current = getSettings();
  const existing = current[RECORDING_SETTINGS_GROUP];
  const group = isPlainObject$1(existing) ? existing : {};
  const nextGroup = { ...group, ...patch };
  const next = { ...current, [RECORDING_SETTINGS_GROUP]: nextGroup };
  writeDoc(next);
  cache = next;
  return nextGroup;
}
const setSchema = z.object({
  path: z.string().min(1),
  value: z.unknown()
});
const getSchema = z.object({
  path: z.string().min(1)
});
const resetSchema = z.object({
  /** 只重置某一棵子树；不传则全量重置 */
  section: z.enum(["app", "terminal", "completion", "highlights", "ai", "transfer", "hotkeys", "sync"]).optional()
});
const settingsHandlers = {
  getAll: () => getSettings(),
  get: (payload) => {
    const { path } = parseInput$1(getSchema, payload);
    return { path, value: getPath(getSettings(), path) };
  },
  /** 按点分路径写入；只覆盖该路径，其余保持不变 */
  set: (payload) => {
    const { path, value } = parseInput$1(setSchema, payload);
    const current = getSettings();
    const patch = {};
    setPath(patch, path, value);
    const next = deepMerge(current, patch);
    writeDoc(next);
    cache = next;
    log$4.debug(`设置已更新: ${path}`);
    return next;
  },
  reset: (payload) => {
    const { section } = parseInput$1(resetSchema, payload ?? {});
    const defaults = defaultSettings();
    let next;
    if (section) {
      next = { ...getSettings(), [section]: defaults[section] };
    } else {
      next = defaults;
    }
    writeDoc(next);
    cache = next;
    log$4.info(section ? `设置已重置: ${section}` : "设置已全量重置");
    return next;
  }
};
const index$6 = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  DEFAULT_AI_SETTINGS,
  DEFAULT_APP_SETTINGS,
  DEFAULT_COMPLETION_SETTINGS: DEFAULT_COMPLETION_SETTINGS$1,
  DEFAULT_HIGHLIGHTS,
  DEFAULT_HOTKEYS,
  DEFAULT_SECURITY_SETTINGS,
  DEFAULT_SYNC_SETTINGS,
  DEFAULT_TERMINAL_SETTINGS,
  DEFAULT_TRANSFER_SETTINGS,
  RECORDING_SETTINGS_GROUP,
  deepMerge,
  defaultSettings,
  getSettings,
  readRecordingSettings,
  resetSettingsCache,
  settingsHandlers,
  updateRecordingSettings,
  updateSettings
}, Symbol.toStringTag, { value: "Module" }));
const MODIFIER_ALIASES = {
  ctrl: "Ctrl",
  control: "Ctrl",
  cmd: "Cmd",
  command: "Cmd",
  meta: "Cmd",
  super: "Super",
  alt: "Alt",
  option: "Alt",
  opt: "Alt",
  shift: "Shift"
};
const KEY_ALIASES = {
  return: "Enter",
  esc: "Escape",
  space: "Space",
  del: "Delete"
};
const MODIFIER_ORDER = ["Ctrl", "Cmd", "Super", "Alt", "Shift"];
function normalizeKey(raw) {
  const t = raw.trim();
  if (/^f([1-9]|1[0-9]|2[0-4])$/i.test(t)) return t.toUpperCase();
  if (t.length === 1) return t.toUpperCase();
  return t.charAt(0).toUpperCase() + t.slice(1);
}
function normalizeAccelerator(raw) {
  const trimmed = raw.trim();
  if (!trimmed) return void 0;
  const parts = trimmed.split("+").map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return void 0;
  const modifiers = /* @__PURE__ */ new Set();
  let key2;
  for (const part of parts) {
    const lower = part.toLowerCase();
    const modAlias = MODIFIER_ALIASES[lower];
    if (modAlias) {
      modifiers.add(modAlias);
      continue;
    }
    key2 = KEY_ALIASES[lower] ?? normalizeKey(part);
  }
  if (!key2) return void 0;
  if (modifiers.size === 0) return void 0;
  const ordered = MODIFIER_ORDER.filter((m) => modifiers.has(m));
  return [...ordered, key2].join("+");
}
function findConflicts(bindings) {
  const byAccel = /* @__PURE__ */ new Map();
  for (const b of bindings) {
    if (!b.enabled || !b.accelerator) continue;
    const norm = normalizeAccelerator(b.accelerator);
    if (!norm) continue;
    const list = byAccel.get(norm) ?? [];
    list.push(b.id);
    byAccel.set(norm, list);
  }
  return byAccel;
}
const INPUT_KEY_ALIASES = {
  enter: ["enter", "return"],
  escape: ["escape", "esc"],
  space: [" ", "space"],
  delete: ["delete", "del"],
  backspace: ["backspace"],
  tab: ["tab"],
  up: ["arrowup", "up"],
  down: ["arrowdown", "down"],
  left: ["arrowleft", "left"],
  right: ["arrowright", "right"],
  pageup: ["pageup"],
  pagedown: ["pagedown"],
  home: ["home"],
  end: ["end"]
};
function matchesInput(input, accel) {
  const parts = accel.split("+");
  const key2 = (parts[parts.length - 1] ?? "").toLowerCase();
  if (input.control !== parts.includes("Ctrl")) return false;
  if (input.alt !== parts.includes("Alt")) return false;
  if (input.shift !== parts.includes("Shift")) return false;
  if (input.meta !== (parts.includes("Cmd") || parts.includes("Super"))) return false;
  const inputKey = (input.key ?? "").toLowerCase();
  if (inputKey === key2) return true;
  const alts = INPUT_KEY_ALIASES[key2];
  return alts ? alts.includes(inputKey) : false;
}
const log$3 = createLogger("hotkey");
let registrations = /* @__PURE__ */ new Map();
const inputListeners = /* @__PURE__ */ new WeakMap();
let activeCtx$1 = null;
function emitTriggered(ctx, binding, source) {
  ctx.emit(Events.HOTKEY_TRIGGERED, {
    bindingId: binding.id,
    command: binding.command,
    source
  });
}
function unregisterAll() {
  try {
    globalShortcut.unregisterAll();
  } catch (err) {
    log$3.warn("注销全局快捷键失败", err);
  }
  for (const win of BrowserWindow.getAllWindows()) {
    const listener = inputListeners.get(win);
    if (listener) {
      win.webContents.removeListener("before-input-event", listener);
      inputListeners.delete(win);
    }
  }
  registrations = /* @__PURE__ */ new Map();
}
function registerFromSettings(ctx) {
  activeCtx$1 = ctx;
  unregisterAll();
  const bindings = getSettings().hotkeys ?? [];
  const next = /* @__PURE__ */ new Map();
  const conflicts = findConflicts(bindings);
  for (const binding of bindings) {
    const accel = binding.accelerator ? normalizeAccelerator(binding.accelerator) : void 0;
    const base = {
      bindingId: binding.id,
      command: binding.command,
      ...binding.accelerator !== void 0 ? { accelerator: binding.accelerator } : {},
      global: binding.global,
      enabled: binding.enabled,
      registered: false
    };
    if (!binding.enabled) {
      next.set(binding.id, { ...base, error: "已禁用" });
      continue;
    }
    if (!accel) {
      next.set(binding.id, { ...base, error: "无效的快捷键（必须含修饰键，如 Ctrl/Alt/Shift/Cmd）" });
      continue;
    }
    const sharingIds = conflicts.get(accel);
    if (sharingIds && sharingIds.length > 1) {
      next.set(binding.id, {
        ...base,
        error: `与其他快捷键冲突：${sharingIds.filter((id) => id !== binding.id).join(", ")}`
      });
      continue;
    }
    if (binding.global) {
      try {
        const ok = globalShortcut.register(accel, () => {
          if (activeCtx$1) emitTriggered(activeCtx$1, binding, "global");
        });
        next.set(
          binding.id,
          ok ? { ...base, accelerator: accel, registered: true } : { ...base, accelerator: accel, error: "该快捷键已被系统或其它程序占用" }
        );
      } catch (err) {
        next.set(binding.id, {
          ...base,
          accelerator: accel,
          error: err instanceof Error ? err.message : "注册失败"
        });
      }
    } else {
      let attached = false;
      for (const win of BrowserWindow.getAllWindows()) {
        attachInApp(win, accel, binding);
        attached = true;
      }
      next.set(
        binding.id,
        attached ? { ...base, accelerator: accel, registered: true } : { ...base, accelerator: accel, error: "当前没有可用窗口" }
      );
    }
  }
  registrations = next;
  const list = [...next.values()];
  const failed = list.filter((r) => !r.registered && r.enabled).length;
  log$3.info(`快捷键已加载：${list.filter((r) => r.registered).length} 个生效${failed > 0 ? `，${failed} 个未生效` : ""}`);
  ctx.emit(Events.HOTKEY_STATUS, { registrations: list });
  return list;
}
function attachInApp(win, accel, binding) {
  const existing = inputListeners.get(win);
  if (existing) {
    win.webContents.removeListener("before-input-event", existing);
    inputListeners.delete(win);
  }
  const listener = (_e, input) => {
    if (!activeCtx$1) return;
    if (matchesInput(input, accel)) {
      emitTriggered(activeCtx$1, binding, "in-app");
    }
  };
  win.webContents.on("before-input-event", listener);
  inputListeners.set(win, listener);
}
function shutdownHotkeys() {
  unregisterAll();
}
const setBindingSchema = z.object({
  id: z.string().min(1),
  accelerator: z.string().nullable().optional(),
  global: z.boolean().optional(),
  enabled: z.boolean().optional()
});
const hotkeyHandlers = {
  list: (_payload, ctx) => {
    if (registrations.size === 0) return registerFromSettings(ctx);
    return [...registrations.values()];
  },
  reload: (_payload, ctx) => registerFromSettings(ctx),
  /** 改一条绑定并立即生效（返回新的注册状态） */
  setBinding: (payload, ctx) => {
    const patch = parseInput$1(setBindingSchema, payload);
    const bindings = getSettings().hotkeys ?? [];
    const idx = bindings.findIndex((b) => b.id === patch.id);
    if (idx === -1) throw AppError.notFound(`快捷键绑定不存在: ${patch.id}`);
    const current = bindings[idx];
    const updated = {
      ...current,
      ...patch.accelerator !== void 0 ? patch.accelerator === null ? { accelerator: void 0 } : { accelerator: patch.accelerator } : {},
      ...patch.global !== void 0 ? { global: patch.global } : {},
      ...patch.enabled !== void 0 ? { enabled: patch.enabled } : {}
    };
    if (updated.accelerator) {
      const norm = normalizeAccelerator(updated.accelerator);
      if (!norm) {
        throw AppError.badRequest("无效的快捷键：必须包含修饰键（Ctrl/Alt/Shift/Cmd）");
      }
      updated.accelerator = norm;
    }
    const nextBindings = [...bindings];
    nextBindings[idx] = updated;
    updateSettings({ hotkeys: nextBindings });
    return { registrations: registerFromSettings(ctx), binding: updated };
  },
  reset: (_payload, ctx) => {
    updateSettings({ hotkeys: DEFAULT_HOTKEYS.map((k) => ({ ...k })) });
    return { registrations: registerFromSettings(ctx) };
  }
};
const index$5 = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  attachInApp,
  findConflicts,
  hotkeyHandlers,
  matchesInput,
  normalizeAccelerator,
  registerFromSettings,
  shutdownHotkeys,
  unregisterAll
}, Symbol.toStringTag, { value: "Module" }));
const sessions = /* @__PURE__ */ new Map();
function registerSession(handle) {
  sessions.set(handle.sessionId, handle);
}
function unregisterSession(sessionId) {
  const existed = sessions.delete(sessionId);
  if (existed) publishSessionClosed(sessionId);
}
const closedListeners = /* @__PURE__ */ new Set();
function subscribeSessionClosed(listener) {
  closedListeners.add(listener);
  return () => {
    closedListeners.delete(listener);
  };
}
function publishSessionClosed(sessionId) {
  dataListeners.delete(sessionId);
  for (const listener of closedListeners) {
    try {
      listener(sessionId);
    } catch {
    }
  }
}
function getSession(sessionId) {
  return sessions.get(sessionId);
}
function requireSession(sessionId) {
  const s = sessions.get(sessionId);
  if (!s) throw new Error(`会话不存在或已断开: ${sessionId}`);
  return s;
}
function listSessions() {
  return [...sessions.values()];
}
const dataListeners = /* @__PURE__ */ new Map();
function subscribeSessionData(sessionId, listener) {
  let set = dataListeners.get(sessionId);
  if (!set) {
    set = /* @__PURE__ */ new Set();
    dataListeners.set(sessionId, set);
  }
  set.add(listener);
  return () => {
    const current = dataListeners.get(sessionId);
    if (!current) return;
    current.delete(listener);
    if (current.size === 0) dataListeners.delete(sessionId);
  };
}
const allDataListeners = /* @__PURE__ */ new Set();
function subscribeAllSessionData(listener) {
  allDataListeners.add(listener);
  return () => {
    allDataListeners.delete(listener);
  };
}
function publishSessionData(sessionId, chunk) {
  for (const listener of allDataListeners) {
    try {
      listener(sessionId, chunk);
    } catch {
    }
  }
  const set = dataListeners.get(sessionId);
  if (!set || set.size === 0) return;
  for (const listener of set) {
    try {
      listener(chunk);
    } catch {
    }
  }
}
const writables = /* @__PURE__ */ new Map();
function registerWritable(session) {
  writables.set(session.sessionId, session);
}
function unregisterWritable(sessionId) {
  writables.delete(sessionId);
}
function getWritable(sessionId) {
  return writables.get(sessionId);
}
function listWritables() {
  return [...writables.values()];
}
const DEFAULT_LIMITS = {
  maxRounds: 20,
  maxCommands: 50,
  maxTargets: 5
};
const READ_ONLY_PREFIXES = [
  // 文件与目录（只读查看）
  "ls",
  "dir",
  "vdir",
  "tree",
  "stat",
  "file",
  "readlink",
  "realpath",
  "basename",
  "dirname",
  "cat",
  "tac",
  "head",
  "tail",
  "nl",
  "less",
  "more",
  "view",
  "zcat",
  "zless",
  "bzcat",
  "xzcat",
  "wc",
  "sort",
  "uniq",
  "cut",
  "paste",
  "join",
  "comm",
  "tr",
  "fold",
  "fmt",
  "pr",
  "column",
  "cmp",
  "diff",
  "sdiff",
  "vimdiff",
  "md5sum",
  "sha1sum",
  "sha256sum",
  "sha512sum",
  "cksum",
  "b2sum",
  "xxd",
  "hexdump",
  "od",
  "strings",
  "objdump",
  "nm",
  "readelf",
  "ldd",
  "find",
  "locate",
  "mlocate",
  "which",
  "whereis",
  "type",
  "command -v",
  "du",
  "df",
  "dutree",
  "lsattr",
  "getfacl",
  "getfattr",
  "attr",
  // 文本检索/处理（不含写回）
  "grep",
  "egrep",
  "fgrep",
  "rgrep",
  "rg",
  "ag",
  "ack",
  "sed",
  "awk",
  "gawk",
  "mawk",
  "perl",
  // 进程 / 系统
  "ps",
  "pstree",
  "pgrep",
  "pidof",
  "top -b",
  "htop -b",
  "free",
  "vmstat",
  "iostat",
  "mpstat",
  "sar",
  "uptime",
  "w",
  "who",
  "whoami",
  "id",
  "groups",
  "last",
  "lastlog",
  "users",
  "finger",
  "nproc",
  "arch",
  "uname",
  "hostname",
  "hostnamectl status",
  "timedatectl status",
  "locale",
  "localectl status",
  "date",
  "cal",
  "uptime",
  "lscpu",
  "lsmem",
  "lsblk",
  "lspci",
  "lsusb",
  "lsmod",
  "lshw",
  "dmidecode",
  "hwinfo",
  "dmesg",
  "journalctl",
  "sysctl -a",
  "sysctl --all",
  "ulimit -a",
  "umask",
  "sensors",
  "nvidia-smi",
  "nvidia-smi -q",
  "smartctl -a",
  "smartctl -i",
  "smartctl -H",
  "env",
  "printenv",
  "set -o",
  "tty",
  "stty -a",
  "echo",
  "printf",
  "seq",
  "expr",
  "bc",
  "test",
  "[",
  "true",
  "false",
  "sleep",
  "jobs",
  "history",
  "alias",
  "help",
  // 存储 / 挂载（只读查询）
  "mount",
  "findmnt",
  "blkid",
  "lsblk -f",
  "quota",
  "lvs",
  "vgs",
  "pvs",
  "pvdisplay",
  "vgdisplay",
  "lvdisplay",
  "lvm lvs",
  "lvm vgs",
  "lvm pvs",
  "mdadm --detail",
  // 网络（只读查询）
  "ip addr",
  "ip a",
  "ip link",
  "ip route",
  "ip r",
  "ip neigh",
  "ip netns list",
  "ip -s link",
  "ifconfig",
  "route",
  "arp",
  "ss",
  "netstat",
  "lsof",
  "fuser",
  "netplan get",
  "ping",
  "ping6",
  "traceroute",
  "tracepath",
  "mtr",
  "dig",
  "nslookup",
  "host",
  "getent hosts",
  "curl -I",
  "curl --head",
  "wget --spider",
  // 服务与日志（只读子命令）
  "systemctl status",
  "systemctl show",
  "systemctl list-units",
  "systemctl list-unit-files",
  "systemctl list-timers",
  "systemctl is-active",
  "systemctl is-enabled",
  "systemctl cat",
  "service --status-all",
  "systemd-analyze",
  "systemd-analyze blame",
  "systemd-cgls",
  "systemd-cgtop",
  "loginctl list-sessions",
  "loginctl show-session",
  // 包管理（只查询）
  "apt list",
  "apt-cache",
  "apt show",
  "dpkg -l",
  "dpkg --list",
  "dpkg -s",
  "dpkg -L",
  "rpm -q",
  "rpm -qa",
  "yum list",
  "yum info",
  "dnf list",
  "dnf info",
  "dnf repoquery",
  "pacman -Q",
  "pacman -Qi",
  "pacman -Ql",
  "pacman -Ss",
  "zypper search",
  "zypper info",
  "snap list",
  "flatpak list",
  "pip list",
  "pip show",
  "pip freeze",
  "pip3 list",
  "pip3 show",
  "npm ls",
  "npm list",
  "npm view",
  "npm outdated",
  "yarn list",
  "pnpm list",
  "gem list",
  "composer show",
  "cargo search",
  "go list",
  "go version",
  "go env",
  // 开发工具（只查询/构建预演）
  "git status",
  "git log",
  "git diff",
  "git show",
  "git branch",
  "git remote",
  "git tag",
  "git describe",
  "git rev-parse",
  "git config --get",
  "git config --list",
  "git blame",
  "git shortlog",
  "git reflog",
  "git stash list",
  "git ls-files",
  "git ls-remote",
  "svn status",
  "svn info",
  "svn log",
  "hg status",
  "hg log",
  "python --version",
  "python3 --version",
  "python -V",
  "python3 -V",
  "node --version",
  "node -v",
  "npm --version",
  "pnpm --version",
  "yarn --version",
  "ruby --version",
  "php --version",
  "java -version",
  "javac -version",
  "go version",
  "rustc --version",
  "cargo --version",
  "gcc --version",
  "g++ --version",
  "clang --version",
  "make -n",
  "make --dry-run",
  "cmake --version",
  "cmake -LA",
  "pkg-config --list-all",
  "ldconfig -p",
  "docker ps",
  "docker images",
  "docker inspect",
  "docker logs",
  "docker version",
  "docker info",
  "docker stats --no-stream",
  "docker network ls",
  "docker volume ls",
  "podman ps",
  "podman images",
  "podman inspect",
  "podman logs",
  "kubectl get",
  "kubectl describe",
  "kubectl logs",
  "kubectl version",
  "kubectl cluster-info",
  "kubectl config view",
  "kubectl api-resources",
  "helm list",
  "helm status",
  "helm get",
  "terraform plan",
  "terraform show",
  "terraform output",
  "terraform state list",
  "ansible --version",
  "ansible-doc",
  "ansible-inventory --list",
  "ansible-playbook --check",
  "ansible-playbook --syntax-check",
  "vault status",
  "consul members",
  "nomad status",
  // 容器/虚拟化只读
  "virsh list",
  "virsh dominfo",
  "virsh domstate",
  "virsh net-list",
  "virsh pool-list",
  "qemu-img info",
  "vboxmanage list",
  "vboxmanage showvminfo"
];
const DANGEROUS_COMMANDS = /* @__PURE__ */ new Set([
  // 删除 / 磁盘 / 分区
  "rm",
  "rmdir",
  "shred",
  "truncate",
  "dd",
  "mkfs",
  "mke2fs",
  "fdisk",
  "sfdisk",
  "cfdisk",
  "parted",
  "gdisk",
  "sgdisk",
  "wipefs",
  "blkdiscard",
  "hdparm",
  "tune2fs",
  "losetup",
  // 网络与防火墙
  "iptables",
  "ip6tables",
  "nft",
  "ufw",
  "firewall-cmd",
  "ebtables",
  "arptables",
  "nc",
  "netcat",
  "ncat",
  "socat",
  "telnet",
  "ssh",
  "scp",
  "sftp",
  "rsync",
  "rdesktop",
  "nmap",
  "masscan",
  "hydra",
  "john",
  "aircrack-ng",
  // 电源与内核
  "shutdown",
  "reboot",
  "poweroff",
  "halt",
  "init",
  "telinit",
  "kexec",
  "modprobe",
  "insmod",
  "rmmod",
  "depmod",
  "kmod",
  "swapon",
  "swapoff",
  "umount",
  // 权限与账户
  "chmod",
  "chown",
  "chgrp",
  "chattr",
  "setfacl",
  "setfattr",
  "usermod",
  "useradd",
  "adduser",
  "userdel",
  "deluser",
  "groupadd",
  "groupdel",
  "gpasswd",
  "passwd",
  "chpasswd",
  "chsh",
  "chfn",
  "vipw",
  "vigr",
  "visudo",
  "shadowconfig",
  "setenforce",
  "aa-disable",
  "aa-complain",
  "nologin",
  // 进程与调度
  "kill",
  "killall",
  "pkill",
  "renice",
  "systemd-run",
  "crontab",
  "at",
  "batch",
  // 任意代码执行 / 解释器内联
  "eval",
  "exec",
  "source",
  "bash",
  "sh",
  "zsh",
  "dash",
  "ksh",
  "csh",
  "fish",
  "caffeinate",
  // 容器与编排（无粒度规则的，保守当危险）
  "nerdctl",
  "ansible-playbook",
  "vboxmanage",
  "virsh",
  "docker-compose"
]);
const SUBCOMMAND_RULES = {
  systemctl: {
    dangerous: [
      "start",
      "stop",
      "restart",
      "reload",
      "reload-or-restart",
      "enable",
      "disable",
      "mask",
      "unmask",
      "daemon-reload",
      "kill",
      "isolate",
      "set-property",
      "edit",
      "reset-failed",
      "suspend",
      "hibernate",
      "poweroff",
      "reboot",
      "emergency",
      "rescue"
    ]
  },
  service: { dangerous: ["start", "stop", "restart", "reload", "force-reload"] },
  sysctl: { dangerous: ["-w", "--write", "-p", "--load"] },
  mount: { dangerous: ["-o", "--options", "-a", "--all", "-t", "--types"] },
  "git": {
    dangerous: [
      "push",
      "reset",
      "clean",
      "checkout",
      "switch",
      "restore",
      "revert",
      "rebase",
      "merge",
      "commit",
      "add",
      "rm",
      "mv",
      "tag",
      "branch -D",
      "branch -d",
      "stash drop",
      "stash pop",
      "gc",
      "filter-branch",
      "update-ref",
      "config",
      "remote add",
      "remote remove",
      "init",
      "clone",
      "fetch",
      "pull",
      "apply",
      "am",
      "cherry-pick"
    ]
  },
  kubectl: {
    dangerous: [
      "apply",
      "delete",
      "create",
      "replace",
      "patch",
      "edit",
      "scale",
      "rollout",
      "exec",
      "cp",
      "drain",
      "cordon",
      "uncordon",
      "taint",
      "label",
      "annotate",
      "set",
      "run",
      "expose",
      "port-forward",
      "attach",
      "debug"
    ]
  },
  helm: { dangerous: ["install", "upgrade", "uninstall", "delete", "rollback", "repo add", "repo remove"] },
  terraform: { dangerous: ["apply", "destroy", "import", "taint", "untaint", "state rm", "state push", "init"] },
  docker: {
    dangerous: [
      "run",
      "exec",
      "rm",
      "rmi",
      "stop",
      "kill",
      "restart",
      "start",
      "create",
      "build",
      "push",
      "pull",
      "commit",
      "tag",
      "save",
      "load",
      "system prune",
      "volume rm",
      "network rm",
      "compose",
      "swarm",
      "service",
      "stack",
      "update",
      "pause",
      "unpause",
      "attach",
      "cp"
    ]
  },
  pacman: { dangerous: ["-S", "-R", "-U", "-Sy", "-Syu", "--sync", "--remove", "--upgrade"] },
  "apt": { dangerous: ["install", "remove", "purge", "upgrade", "dist-upgrade", "autoremove", "update"] },
  "apt-get": { dangerous: ["install", "remove", "purge", "upgrade", "dist-upgrade", "autoremove", "update"] },
  dnf: { dangerous: ["install", "remove", "erase", "upgrade", "update", "autoremove"] },
  yum: { dangerous: ["install", "remove", "erase", "update", "upgrade"] },
  npm: { dangerous: ["install", "i", "uninstall", "remove", "rm", "update", "publish", "link", "run"] },
  pnpm: { dangerous: ["install", "i", "add", "remove", "rm", "update", "up", "publish", "link", "run"] },
  pip: { dangerous: ["install", "uninstall", "download"] },
  pip3: { dangerous: ["install", "uninstall", "download"] },
  gem: { dangerous: ["install", "uninstall", "update"] },
  podman: {
    dangerous: [
      "run",
      "exec",
      "rm",
      "rmi",
      "stop",
      "kill",
      "restart",
      "start",
      "create",
      "build",
      "push",
      "pull",
      "commit",
      "tag",
      "save",
      "load",
      "system prune",
      "volume rm",
      "network rm",
      "compose",
      "pod",
      "generate",
      "update",
      "pause",
      "unpause",
      "attach",
      "cp"
    ]
  },
  dpkg: { dangerous: ["-i", "--install", "-r", "--remove", "-P", "--purge", "-x", "--unpack", "--configure", "--unpack"] },
  rpm: { dangerous: ["-i", "-U", "-e", "-F", "--install", "--upgrade", "--erase", "--freshen"] },
  snap: { dangerous: ["install", "remove", "refresh", "revert", "disable", "enable", "set"] },
  yarn: { dangerous: ["install", "add", "remove", "upgrade", "publish", "run", "create", "global"] },
  zypper: { dangerous: ["install", "remove", "update", "dup", "in", "rm", "up", "addrepo", "removerepo"] },
  composer: { dangerous: ["install", "require", "update", "remove", "global"] },
  cargo: { dangerous: ["install", "uninstall", "publish", "add", "remove", "update", "run"] },
  go: { dangerous: ["install", "get", "run", "generate", "clean"] },
  ansible: { dangerous: ["-m", "--module-name", "run"] }
};
const DANGEROUS_PATTERNS = [
  // 递归/强制删除与递归改权限
  { re: /\brm\s+(-[A-Za-z]*[rR][A-Za-z]*f|-[A-Za-z]*f[A-Za-z]*[rR]|-[rR]\b|--recursive|--force)/, reason: "递归/强制删除（rm -r / -f）" },
  { re: /\bchmod\s+(-[A-Za-z]*R|--recursive)/, reason: "递归改权限（chmod -R）" },
  { re: /\bchown\s+(-[A-Za-z]*R|--recursive)/, reason: "递归改属主（chown -R）" },
  { re: /\bchgrp\s+(-[A-Za-z]*R|--recursive)/, reason: "递归改属组（chgrp -R）" },
  // 就地写回
  { re: /\bsed\s+(-[A-Za-z]*i|--in-place)/, reason: "sed 就地写回（-i）" },
  { re: /\bsort\s+(-o|--output)\b/, reason: "sort 输出覆盖文件（-o）" },
  { re: /\bjournalctl\b.*--(vacuum|rotate|flush)/, reason: "journalctl 清理/转储日志" },
  { re: /\bsmartctl\b.*\s-t\b/, reason: "smartctl 自检会改动磁盘状态" },
  // 写入重定向 / 追加（只在分段里出现即可疑）
  // 只排除 `N>&M`（fd 复制，如 2>&1）；`1>file` 是真写文件，必须命中
  { re: />>?(?!&)/, reason: "输出重定向写入（> / >>）" },
  // find 本身只读，但 -delete/-exec 会写文件或执行任意命令
  { re: /\bfind\b.*\s-(delete|exec|execdir|ok|okdir|fprint|fprintf|fls|fprint0)\b/, reason: "find 带写入/执行动作（-delete / -exec）" },
  { re: /\btee\b/, reason: "tee 写入文件" },
  { re: /\btruncate\b/, reason: "truncate 截断文件" },
  // 下载后直接执行
  { re: /\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(ba|z|d)?sh\b/, reason: "下载内容直接交给 shell 执行" },
  { re: /\b(curl|wget)\b.*\s(-o|--output|-O)\b/, reason: "curl/wget 写出文件" },
  // 提权与任意执行
  // 注意：sudo 本身不作为危险模式 —— 它由 allowSudo/confirmSudo 单独把关
  // （否则 `sudo systemctl status` 这种只读提权会被 allowDangerous 二次拦住）。
  { re: /\bsu\s+(-|root)\b/, reason: "su 切换用户" },
  { re: /\bdoas\b/, reason: "doas 提权" },
  // 解释器内联执行：等于任意代码执行
  { re: /\b(python3?|perl|ruby|node|lua|php)\s+-[ce]\b/, reason: "解释器内联执行（-c/-e）" },
  { re: /\b(bash|sh|zsh|dash|ksh)\s+-c\b/, reason: "shell -c 内联执行" },
  // 危险系统操作
  { re: /\bkill\s+-(9|KILL)\b/, reason: "强制杀掉进程（kill -9）" },
  { re: /\b(poweroff|reboot|shutdown|halt)\b/, reason: "关机/重启" },
  { re: /\bsystemctl\s+(stop|restart|disable|mask|daemon-reload)\b/, reason: "停止/重启/禁用系统服务" },
  { re: /\bmv\s+.*\s\/(etc|boot|usr|var|bin|sbin|lib)\b/, reason: "移动系统关键目录内容" },
  { re: /\bcp\s+.*\s\/(etc|boot|usr|bin|sbin|lib)\b/, reason: "写入系统关键目录" },
  { re: /\bhistory\s+-c\b/, reason: "清空命令历史（破坏审计）" },
  { re: /\b(auditctl|ausearch)\b/, reason: "改动审计子系统" }
];
const ALWAYS_DENY_PATTERNS = [
  { re: /:\s*\(\s*\)\s*\{.*\}\s*;\s*:/, reason: "fork 炸弹" },
  { re: /\brm\s+(-[A-Za-z]*\s+)*\/(\s|$)/, reason: "删除根目录" },
  { re: /\brm\s+(-[A-Za-z]*\s+)*\/\*(\s|$)/, reason: "删除根目录全部内容" },
  { re: /\bdd\b.*\bof=\/dev\/(sd|nvme|vd|hd|mmcblk)/, reason: "直接写入块设备" },
  { re: /\bmkfs(\.[a-z0-9]+)?\b/, reason: "格式化文件系统" },
  { re: /\bwipefs\b|\bblkdiscard\b/, reason: "擦除设备签名" },
  { re: /\b(shutdown|reboot|poweroff|halt)\b/, reason: "关机/重启" },
  { re: />\s*\/dev\/(sd|nvme|vd|hd|mmcblk)/, reason: "重定向写入块设备" },
  { re: /\bmv\s+\/[^\s]*\s+\/dev\/null/, reason: "把系统路径移入 /dev/null" }
];
function scanShell(command) {
  const segments = [];
  let current = "";
  let quote = null;
  let escaped = false;
  let hasRedirection = false;
  let hasSubstitution = false;
  let hasBackground = false;
  const push = () => {
    const trimmed = current.trim();
    if (trimmed !== "") segments.push(trimmed);
    current = "";
  };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i] ?? "";
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      current += ch;
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "`") hasSubstitution = true;
    if (ch === "$" && command[i + 1] === "(") hasSubstitution = true;
    if (ch === ">" && command[i + 1] !== "&") hasRedirection = true;
    if (ch === "\n" || ch === ";") {
      push();
      continue;
    }
    if (ch === "|") {
      push();
      if (command[i + 1] === "|") i++;
      continue;
    }
    if (ch === "&") {
      hasBackground = true;
      push();
      if (command[i + 1] === "&") i++;
      continue;
    }
    current += ch;
  }
  push();
  if (segments.length === 0 && command.trim() !== "") segments.push(command.trim());
  return { segments, hasRedirection, hasSubstitution, hasBackground };
}
function commandNameOf(segment) {
  const tokens = segment.trim().split(/\s+/).filter((t) => t !== "");
  let i = 0;
  let sudo = false;
  while (i < tokens.length) {
    const t = tokens[i] ?? "";
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) {
      i++;
      continue;
    }
    if (t === "sudo" || t === "doas") {
      sudo = true;
      i++;
      while (i < tokens.length && (tokens[i] ?? "").startsWith("-")) {
        const opt = tokens[i] ?? "";
        i++;
        if (opt === "-u" || opt === "--user" || opt === "-g" || opt === "-p") i++;
      }
      continue;
    }
    if (t === "command" || t === "builtin" || t === "nohup" || t === "time") {
      i++;
      continue;
    }
    break;
  }
  const name = tokens[i] ?? "";
  return { name, rest: tokens.slice(i + 1), sudo, tail: tokens.slice(i).join(" ") };
}
function effectivePolicyFrom(settings2) {
  const ai = settings2 ?? void 0;
  return {
    allowExecution: ai?.allowExecution ?? false,
    mode: ai?.mode ?? "chat",
    extraReadOnly: ai?.riskPolicy?.readOnlyAllowlist ?? [],
    extraDangerous: ai?.riskPolicy?.dangerousDenylist ?? [],
    confirmSudo: ai?.riskPolicy?.confirmSudo ?? true,
    // allowDangerous / allowSudo 不在 AiSettings 里：默认关闭，需上层显式注入
    allowDangerous: false,
    allowSudo: false,
    limits: {
      maxRounds: ai?.limits?.maxRounds ?? DEFAULT_LIMITS.maxRounds,
      maxCommands: ai?.limits?.maxCommands ?? DEFAULT_LIMITS.maxCommands,
      maxTargets: ai?.limits?.maxTargets ?? DEFAULT_LIMITS.maxTargets
    }
  };
}
function classifySegment(segment, policy) {
  const reasons = [];
  for (const { re, reason } of ALWAYS_DENY_PATTERNS) {
    if (re.test(segment)) {
      return { risk: "dangerous", reasons: [reason], sudo: false, alwaysDeny: true };
    }
  }
  const { name, rest, sudo, tail } = commandNameOf(segment);
  const normalized = segment.trim().replace(/\s+/g, " ");
  for (const extra of policy.extraDangerous) {
    const e = extra.trim();
    if (e !== "" && normalized.includes(e)) {
      reasons.push(`命中用户黑名单: ${e}`);
    }
  }
  for (const { re, reason } of DANGEROUS_PATTERNS) {
    if (re.test(segment)) reasons.push(reason);
  }
  if (name === "") {
    return { risk: reasons.length > 0 ? "dangerous" : "read-only", reasons, sudo, alwaysDeny: false };
  }
  if (DANGEROUS_COMMANDS.has(name)) {
    reasons.push(`危险命令: ${name}`);
    return { risk: "dangerous", reasons, sudo, alwaysDeny: false };
  }
  const sub = SUBCOMMAND_RULES[name];
  if (sub) {
    const subcommand = rest[0] ?? "";
    if (sub.dangerous.includes(subcommand)) {
      reasons.push(`危险子命令: ${name} ${subcommand}`);
      return { risk: "dangerous", reasons, sudo, alwaysDeny: false };
    }
  }
  if (reasons.length > 0) return { risk: "dangerous", reasons, sudo, alwaysDeny: false };
  const candidate = tail.trim().replace(/\s+/g, " ");
  const prefixes = [...policy.extraReadOnly, ...READ_ONLY_PREFIXES];
  for (const prefix of prefixes) {
    const p = prefix.trim();
    if (p === "") continue;
    if (candidate === p || candidate.startsWith(`${p} `)) {
      return { risk: "read-only", reasons: [], sudo, alwaysDeny: false };
    }
  }
  return { risk: "unknown", reasons: [`未在白名单中的命令: ${name}`], sudo, alwaysDeny: false };
}
function evaluateCommand(command, policy) {
  const trimmed = command.trim();
  if (trimmed === "") {
    return {
      risk: "unknown",
      baseRisk: "unknown",
      segments: [],
      reasons: ["空命令"],
      sudo: false,
      alwaysDeny: false,
      unsafeConstruct: false
    };
  }
  const scan = scanShell(trimmed);
  const reasons = [];
  let risk = "read-only";
  let sudo = false;
  let alwaysDeny = false;
  const rank = { "read-only": 0, unknown: 1, dangerous: 2 };
  const bump = (next) => {
    if (rank[next] > rank[risk]) risk = next;
  };
  for (const { re, reason } of ALWAYS_DENY_PATTERNS) {
    if (re.test(trimmed)) {
      alwaysDeny = true;
      risk = "dangerous";
      if (!reasons.includes(reason)) reasons.push(reason);
    }
  }
  for (const segment of scan.segments) {
    const r = classifySegment(segment, policy);
    sudo = sudo || r.sudo || /(^|\s)sudo(\s|$)/.test(segment);
    alwaysDeny = alwaysDeny || r.alwaysDeny;
    for (const reason of r.reasons) if (!reasons.includes(reason)) reasons.push(reason);
    bump(r.risk);
  }
  const baseRisk = alwaysDeny ? "dangerous" : risk;
  const unsafeConstruct = scan.hasRedirection || scan.hasSubstitution || scan.hasBackground;
  if (unsafeConstruct) {
    if (scan.hasRedirection) bump("dangerous");
    else bump("unknown");
    if (scan.hasSubstitution) reasons.push("包含命令替换（$() 或反引号）");
    if (scan.hasBackground) reasons.push("包含后台执行（&）");
  }
  if (sudo) bump("dangerous");
  return { risk, baseRisk, segments: scan.segments, reasons, sudo, alwaysDeny, unsafeConstruct };
}
function planCommandExecution(args) {
  const evaluation = evaluateCommand(args.command, args.policy);
  const { policy } = args;
  if (!policy.allowExecution) {
    return { action: "suggest", risk: evaluation.risk, reason: "未开启 AI 执行命令，仅返回建议" };
  }
  if (policy.mode === "chat") {
    return { action: "suggest", risk: evaluation.risk, reason: "chat 模式只对话，不执行命令" };
  }
  if (evaluation.alwaysDeny) {
    return {
      action: "deny",
      risk: evaluation.risk,
      reason: `永久禁止执行：${evaluation.reasons.join("、") || "高危操作"}`,
      alwaysDeny: true
    };
  }
  if (evaluation.sudo) {
    if (!policy.allowSudo) {
      return {
        action: "deny",
        risk: "dangerous",
        reason: "sudo 未授权（需在设置与令牌中同时开启）",
        alwaysDeny: false
      };
    }
    if (policy.confirmSudo || policy.mode === "confirm") {
      return { action: "confirm", risk: "dangerous", reason: "sudo 命令需要人工确认", alwaysDeny: false };
    }
  }
  const risk = evaluation.sudo ? evaluation.baseRisk : evaluation.risk;
  switch (risk) {
    case "dangerous":
      if (policy.allowDangerous) {
        return policy.mode === "confirm" ? { action: "confirm", risk: "dangerous", reason: "危险命令（已放开黑名单）仍需确认", alwaysDeny: false } : { action: "execute", risk: "dangerous", reason: "用户已显式放开危险黑名单" };
      }
      return {
        action: "deny",
        risk: "dangerous",
        reason: `危险命令，已拒绝：${evaluation.reasons.join("、") || "命中黑名单"}`,
        alwaysDeny: false
      };
    case "unknown":
      return {
        action: "confirm",
        risk: "unknown",
        reason: `命令不在只读白名单中，需要确认：${evaluation.reasons.join("、")}`,
        alwaysDeny: false
      };
    case "read-only":
      if (policy.mode === "confirm") {
        return { action: "confirm", risk: "read-only", reason: "confirm 模式：每步都确认", alwaysDeny: false };
      }
      return { action: "execute", risk: "read-only", reason: "只读命令，已放行" };
  }
}
class AiLimitError extends Error {
  constructor(kind, message, usage, limits) {
    super(message);
    this.kind = kind;
    this.usage = usage;
    this.limits = limits;
    this.name = "AiLimitError";
  }
}
class AiGuard {
  constructor(limits = DEFAULT_LIMITS) {
    this.limits = limits;
    this.rounds = 0;
    this.commands = 0;
    this.targets = /* @__PURE__ */ new Set();
  }
  /** 开始新一轮：超过 maxRounds 抛错 */
  startRound() {
    this.rounds++;
    if (this.rounds > this.limits.maxRounds) {
      throw new AiLimitError(
        "rounds",
        `已达对话轮数上限（${this.limits.maxRounds}），已停止`,
        this.usage(),
        this.limits
      );
    }
  }
  /**
   * 记录一次命令执行前的用量。目标集合按 sessionId 去重（maxTargets = 涉及主机数）。
   * 超限抛错，且此时**不应**执行命令。
   */
  recordCommand(target) {
    this.commands++;
    if (this.commands > this.limits.maxCommands) {
      throw new AiLimitError(
        "commands",
        `已达累计命令数上限（${this.limits.maxCommands}），已停止`,
        this.usage(),
        this.limits
      );
    }
    if (target !== "" && !this.targets.has(target) && this.targets.size >= this.limits.maxTargets) {
      throw new AiLimitError(
        "targets",
        `已达涉及主机数上限（${this.limits.maxTargets}），已停止`,
        this.usage(),
        this.limits
      );
    }
    if (target !== "") this.targets.add(target);
  }
  usage() {
    return { rounds: this.rounds, commands: this.commands, targets: this.targets.size };
  }
  targetIds() {
    return [...this.targets];
  }
  remaining() {
    return {
      rounds: Math.max(0, this.limits.maxRounds - this.rounds),
      commands: Math.max(0, this.limits.maxCommands - this.commands),
      targets: Math.max(0, this.limits.maxTargets - this.targets.size)
    };
  }
}
class AuditLog {
  constructor(capacity = 1e3, sink) {
    this.capacity = capacity;
    this.sink = sink;
    this.entries = [];
    this.seq = 0;
  }
  record(entry) {
    const full = {
      ...entry,
      id: `audit-${++this.seq}`,
      timestamp: entry.timestamp ?? (/* @__PURE__ */ new Date()).toISOString()
    };
    this.entries.push(full);
    if (this.entries.length > this.capacity) this.entries.shift();
    try {
      this.sink?.(full);
    } catch {
    }
    return full;
  }
  /** 最近的审计条目（新的在后） */
  list(limit = 100) {
    return limit >= this.entries.length ? [...this.entries] : this.entries.slice(-limit);
  }
  get size() {
    return this.entries.length;
  }
  clear() {
    this.entries.length = 0;
  }
}
class SseParser {
  constructor() {
    this.buffer = "";
  }
  /** 喂入一段文本，返回因此**完整**的事件（未完成的留在内部缓冲） */
  push(chunk) {
    this.buffer += chunk;
    const events = [];
    let index2 = this.buffer.search(/\r?\n\r?\n/);
    while (index2 !== -1) {
      const raw = this.buffer.slice(0, index2);
      const match = /\r?\n\r?\n/.exec(this.buffer.slice(index2));
      const consumed = index2 + (match?.[0]?.length ?? 2);
      this.buffer = this.buffer.slice(consumed);
      const parsed = parseSseBlock(raw);
      if (parsed) events.push(parsed);
      index2 = this.buffer.search(/\r?\n\r?\n/);
    }
    return events;
  }
  /** 流结束时调用：把没有空行结尾的最后一帧也吐出来（不少服务端发完就不补空行） */
  flush() {
    const rest = this.buffer;
    this.buffer = "";
    const parsed = parseSseBlock(rest);
    return parsed ? [parsed] : [];
  }
}
function parseSseBlock(raw) {
  if (raw.trim() === "") return null;
  let event;
  const dataLines = [];
  for (const line of raw.split(/\r?\n/)) {
    if (line === "" || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") dataLines.push(value);
    else if (field === "event") event = value;
  }
  if (dataLines.length === 0 && event === void 0) return null;
  return { ...event === void 0 ? {} : { event }, data: dataLines.join("\n") };
}
function parseToolArguments(raw) {
  if (!raw || raw.trim() === "") return {};
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed;
    }
    return { value: parsed };
  } catch {
    return {};
  }
}
function resolveEndpoint(baseUrl, kind) {
  const trimmed = baseUrl.replace(/\/+$/, "");
  if (kind === "anthropic") {
    return trimmed.endsWith("/messages") ? trimmed : `${trimmed}/v1/messages`;
  }
  if (trimmed.endsWith("/chat/completions")) return trimmed;
  if (/\/v\d+$/.test(trimmed)) return `${trimmed}/chat/completions`;
  return `${trimmed}/v1/chat/completions`;
}
function toOpenAiTools(tools) {
  return tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parameters }
  }));
}
function toAnthropicTools(tools) {
  return tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
}
function buildOpenAiBody(config, messages, tools, mode) {
  const body = {
    model: config.model,
    stream: true,
    messages: messages.map((m) => {
      if (m.role === "tool") {
        return { role: "tool", tool_call_id: m.toolCallId ?? "", content: m.content };
      }
      if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
        return {
          role: "assistant",
          content: m.content === "" ? null : m.content,
          tool_calls: m.toolCalls.map((c) => ({
            id: c.id,
            type: "function",
            function: { name: c.name, arguments: c.arguments }
          }))
        };
      }
      return { role: m.role, content: m.content };
    })
  };
  if (tools.length > 0) {
    body.tools = toOpenAiTools(tools);
    body.tool_choice = "auto";
  }
  if (typeof config.temperature === "number") body.temperature = config.temperature;
  if (typeof config.maxTokens === "number") body.max_tokens = config.maxTokens;
  if (mode === "thinking" || config.extendedThinking) body.reasoning_effort = "medium";
  return body;
}
function buildAnthropicBody(config, messages, tools, mode) {
  const systemParts = messages.filter((m) => m.role === "system").map((m) => m.content);
  const rest = messages.filter((m) => m.role !== "system");
  const body = {
    model: config.model,
    stream: true,
    // Anthropic 的 max_tokens 必填
    max_tokens: config.maxTokens ?? 4096,
    messages: rest.map((m) => {
      if (m.role === "tool") {
        return {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: m.toolCallId ?? "", content: m.content }
          ]
        };
      }
      if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
        const content = [];
        if (m.content !== "") content.push({ type: "text", text: m.content });
        for (const c of m.toolCalls) {
          content.push({ type: "tool_use", id: c.id, name: c.name, input: parseToolArguments(c.arguments) });
        }
        return { role: "assistant", content };
      }
      return { role: m.role, content: m.content };
    })
  };
  if (systemParts.length > 0) body.system = systemParts.join("\n\n");
  if (tools.length > 0) body.tools = toAnthropicTools(tools);
  if (typeof config.temperature === "number") body.temperature = config.temperature;
  if (mode === "thinking" || config.extendedThinking) {
    body.thinking = { type: "enabled", budget_tokens: 2048 };
  }
  return body;
}
function createProviderClient(config, deps) {
  const kind = config.kind;
  return {
    kind,
    async streamChat({ messages, tools = [], mode, signal, callbacks }) {
      if (!config.apiKey) {
        throw AppError.unauthorized(`供应商「${config.name}」未配置 API Key`);
      }
      const endpoint = resolveEndpoint(config.baseUrl, kind);
      const body = kind === "anthropic" ? buildAnthropicBody(config, messages, tools, mode) : buildOpenAiBody(config, messages, tools, mode);
      const headers = {
        "content-type": "application/json",
        accept: "text/event-stream",
        ...kind === "anthropic" ? { "x-api-key": config.apiKey, "anthropic-version": "2023-06-01" } : { authorization: `Bearer ${config.apiKey}` }
      };
      let response;
      try {
        response = await deps.fetch(endpoint, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          ...signal ? { signal } : {}
        });
      } catch (err) {
        throw AppError.internal(
          `连接供应商失败: ${err instanceof Error ? err.message : String(err)}`
        );
      }
      if (!response.ok) {
        const detail = await safeText(response);
        const message = `供应商返回 ${response.status}${detail ? `: ${truncate$1(detail, 300)}` : ""}`;
        if (response.status === 401 || response.status === 403) throw AppError.unauthorized(message);
        if (response.status === 429) throw AppError.timeout(message);
        throw AppError.internal(message);
      }
      return kind === "anthropic" ? consumeAnthropic(response, callbacks) : consumeOpenAi(response, callbacks);
    }
  };
}
async function safeText(response) {
  try {
    return await response.text();
  } catch {
    return "";
  }
}
function truncate$1(text, max) {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}
async function* bodyChunks(response) {
  const body = response.body;
  if (!body) return;
  const decoder = new TextDecoder();
  for await (const chunk of body) {
    yield typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
  }
}
function asRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : null;
}
async function consumeOpenAi(response, callbacks) {
  const parser = new SseParser();
  const toolAcc = {};
  let text = "";
  let finishReason;
  const usage = {};
  const handle = (data) => {
    if (data.trim() === "[DONE]") return true;
    let json;
    try {
      json = asRecord(JSON.parse(data));
    } catch {
      return false;
    }
    if (!json) return false;
    const usageRecord = asRecord(json["usage"]);
    if (usageRecord) {
      const input = usageRecord["prompt_tokens"] ?? usageRecord["input_tokens"];
      const output = usageRecord["completion_tokens"] ?? usageRecord["output_tokens"];
      if (typeof input === "number") usage.inputTokens = input;
      if (typeof output === "number") usage.outputTokens = output;
      callbacks?.onUsage?.({ ...usage });
    }
    const choices = json["choices"];
    if (!Array.isArray(choices)) return false;
    const choice = asRecord(choices[0]);
    if (!choice) return false;
    if (typeof choice["finish_reason"] === "string") finishReason = choice["finish_reason"];
    const delta = asRecord(choice["delta"]);
    if (!delta) return false;
    const content = delta["content"];
    if (typeof content === "string" && content !== "") {
      text += content;
      callbacks?.onText?.(content);
    }
    const toolCalls = delta["tool_calls"];
    if (Array.isArray(toolCalls)) {
      for (const raw of toolCalls) {
        const call = asRecord(raw);
        if (!call) continue;
        const index2 = typeof call["index"] === "number" ? call["index"] : 0;
        const slot = toolAcc[index2] ??= { id: "", name: "", args: "" };
        if (typeof call["id"] === "string" && call["id"] !== "") slot.id = call["id"];
        const fn = asRecord(call["function"]);
        if (fn) {
          if (typeof fn["name"] === "string" && fn["name"] !== "") slot.name = fn["name"];
          if (typeof fn["arguments"] === "string") slot.args += fn["arguments"];
        }
      }
    }
    return false;
  };
  for await (const chunk of bodyChunks(response)) {
    for (const event of parser.push(chunk)) {
      if (handle(event.data)) return finalizeOpenAi(toolAcc, text, usage, finishReason, callbacks);
    }
  }
  for (const event of parser.flush()) {
    handle(event.data);
  }
  return finalizeOpenAi(toolAcc, text, usage, finishReason, callbacks);
}
function finalizeOpenAi(toolAcc, text, usage, finishReason, callbacks) {
  const toolCalls = [];
  for (const key2 of Object.keys(toolAcc)) {
    const slot = toolAcc[Number(key2)];
    if (!slot || slot.name === "") continue;
    const call = {
      id: slot.id || `call_${key2}`,
      name: slot.name,
      arguments: slot.args
    };
    toolCalls.push(call);
    callbacks?.onToolCall?.(call);
  }
  return { text, toolCalls, usage, ...finishReason === void 0 ? {} : { finishReason } };
}
async function consumeAnthropic(response, callbacks) {
  const parser = new SseParser();
  const blocks = /* @__PURE__ */ new Map();
  let text = "";
  const usage = {};
  let finishReason;
  const handle = (event) => {
    let json;
    try {
      json = asRecord(JSON.parse(event.data));
    } catch {
      return;
    }
    if (!json) return;
    const type = typeof json["type"] === "string" ? json["type"] : event.event;
    if (type === "message_start") {
      const message = asRecord(json["message"]);
      const u = message ? asRecord(message["usage"]) : null;
      const input = u?.["input_tokens"];
      if (typeof input === "number") {
        usage.inputTokens = input;
        callbacks?.onUsage?.({ ...usage });
      }
      return;
    }
    if (type === "content_block_start") {
      const index2 = typeof json["index"] === "number" ? json["index"] : 0;
      const block = asRecord(json["content_block"]);
      if (block && block["type"] === "tool_use") {
        blocks.set(index2, {
          id: typeof block["id"] === "string" ? block["id"] : "",
          name: typeof block["name"] === "string" ? block["name"] : "",
          args: ""
        });
      }
      return;
    }
    if (type === "content_block_delta") {
      const index2 = typeof json["index"] === "number" ? json["index"] : 0;
      const delta = asRecord(json["delta"]);
      if (!delta) return;
      if (delta["type"] === "text_delta" && typeof delta["text"] === "string") {
        text += delta["text"];
        callbacks?.onText?.(delta["text"]);
      } else if (delta["type"] === "input_json_delta" && typeof delta["partial_json"] === "string") {
        const slot = blocks.get(index2);
        if (slot) slot.args += delta["partial_json"];
      }
      return;
    }
    if (type === "message_delta") {
      const delta = asRecord(json["delta"]);
      if (delta && typeof delta["stop_reason"] === "string") finishReason = delta["stop_reason"];
      const u = asRecord(json["usage"]);
      const output = u?.["output_tokens"];
      if (typeof output === "number") {
        usage.outputTokens = output;
        callbacks?.onUsage?.({ ...usage });
      }
    }
  };
  for await (const chunk of bodyChunks(response)) {
    for (const event of parser.push(chunk)) handle(event);
  }
  for (const event of parser.flush()) handle(event);
  const toolCalls = [];
  for (const [, slot] of [...blocks.entries()].sort((a, b) => a[0] - b[0])) {
    const call = {
      id: slot.id || `toolu_${toolCalls.length}`,
      name: slot.name,
      arguments: slot.args
    };
    if (call.name === "") continue;
    toolCalls.push(call);
    callbacks?.onToolCall?.(call);
  }
  return { text, toolCalls, usage, ...finishReason === void 0 ? {} : { finishReason } };
}
const globalFetch = (url, init) => globalThis.fetch(url, init);
const MAX_CHATS = 100;
const MAX_MESSAGES_PER_CHAT = 200;
const MAX_TOOL_ITERATIONS = 8;
const SAFE_DEFAULT_SETTINGS = {
  providers: [],
  mode: "chat",
  allowExecution: false,
  riskPolicy: { readOnlyAllowlist: [], dangerousDenylist: [], confirmSudo: true },
  limits: { maxRounds: 20, maxCommands: 50, maxTargets: 5 }
};
const AI_TOOLS = [
  {
    name: "t1000_ssh_list_sessions",
    description: "列出当前已建立、可执行命令的 SSH 会话（返回 sessionId 供其它工具使用）",
    parameters: { type: "object", properties: {}, additionalProperties: false }
  },
  {
    name: "t1000_ssh_exec",
    description: "在一个已建立的 SSH 会话上非交互执行一条命令，返回退出码与输出。只读命令会被直接放行，危险命令会被拒绝或要求确认。",
    parameters: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "t1000_ssh_list_sessions 返回的会话 id" },
        command: { type: "string", description: "要执行的命令（不要带 sudo）" },
        timeoutMs: { type: "number", description: "超时毫秒，默认 60000" }
      },
      required: ["sessionId", "command"],
      additionalProperties: false
    }
  },
  {
    name: "t1000_ssh_sudo_exec",
    description: "以 sudo 执行一条命令（命令中不要写 sudo）。需要用户显式允许 sudo，且默认还需要人工确认。",
    parameters: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        command: { type: "string", description: "要提权执行的命令，不要带 sudo 前缀" }
      },
      required: ["sessionId", "command"],
      additionalProperties: false
    }
  },
  {
    name: "t1000_ssh_read_file",
    description: "读取远端文本文件内容（有大小上限）",
    parameters: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        path: { type: "string", description: "远端绝对路径" }
      },
      required: ["sessionId", "path"],
      additionalProperties: false
    }
  }
];
function chatPolicyFrom(settings2) {
  return { ...effectivePolicyFrom(settings2), allowSudo: true, allowDangerous: false };
}
class ChatService {
  constructor(deps) {
    this.chats = /* @__PURE__ */ new Map();
    this.order = [];
    this.active = /* @__PURE__ */ new Map();
    this.deps = deps;
    this.audit = new AuditLog(1e3, deps.auditSink);
  }
  settings() {
    return this.deps.getSettings?.() ?? SAFE_DEFAULT_SETTINGS;
  }
  listChats() {
    return this.order.map((id) => this.chats.get(id)).filter((c) => c !== void 0).map((c) => ({ id: c.id, title: c.title, createdAt: c.createdAt, updatedAt: c.updatedAt }));
  }
  getChat(id) {
    const chat = this.chats.get(id);
    if (chat) this.ensureMessageIdentity(chat);
    return chat;
  }
  deleteChat(id) {
    this.cancel(id);
    const existed = this.chats.delete(id);
    const idx = this.order.indexOf(id);
    if (idx >= 0) this.order.splice(idx, 1);
    return existed;
  }
  createChat(title = "新会话") {
    const now = this.timestamp();
    const chat = {
      id: randomUUID(),
      title,
      createdAt: now,
      updatedAt: now,
      messages: [],
      usage: {}
    };
    this.chats.set(chat.id, chat);
    this.order.push(chat.id);
    while (this.order.length > MAX_CHATS) {
      const oldest = this.order.shift();
      if (oldest !== void 0) this.chats.delete(oldest);
    }
    return chat;
  }
  /** 运行时替换事件发送器（IPC 上下文可能在服务创建后才就绪） */
  setEmitter(emit) {
    this.deps.emit = emit;
  }
  /** 取消该会话正在进行的请求（abort 会让流式循环尽快退出） */
  cancel(chatId2) {
    const controller = this.active.get(chatId2);
    if (!controller) return false;
    controller.abort();
    this.active.delete(chatId2);
    return true;
  }
  /** 最近审计（供 UI 展示"AI 做过什么"） */
  auditEntries(limit = 100) {
    return this.audit.list(limit);
  }
  /**
   * 发送一条用户消息并跑完整个（可能的）工具调用循环。
   * 流式增量与工具事件通过 emit 推送；返回时本轮已结束。
   */
  async send(args) {
    const text = args.text?.trim() ?? "";
    if (text === "") throw AppError.badRequest("消息不能为空");
    const settings2 = this.settings();
    const provider = this.deps.getProvider?.(args.providerId);
    if (!provider) {
      throw AppError.badRequest("未配置 AI 供应商（请在设置中填写 API Key 与模型）");
    }
    let session;
    if (args.chatId !== void 0) {
      const existing = this.chats.get(args.chatId);
      if (!existing) throw AppError.notFound(`AI 会话不存在: ${args.chatId}`);
      session = existing;
    } else {
      session = this.createChat();
    }
    if (session.title === "新会话" && session.messages.length === 0) {
      session.title = text.slice(0, 40);
    }
    this.ensureMessageIdentity(session);
    const controller = new AbortController();
    this.active.set(session.id, controller);
    const policy = chatPolicyFrom(settings2);
    const guard = new AiGuard(policy.limits);
    const client = createProviderClient(provider, { fetch: this.deps.fetch ?? globalFetch });
    const userMessage = {
      id: randomUUID(),
      role: "user",
      content: text,
      createdAt: this.timestamp()
    };
    this.pushMessage(session, userMessage);
    let messageId = randomUUID();
    let answer = "";
    let toolCallCount = 0;
    try {
      guard.startRound();
      for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
        if (controller.signal.aborted) break;
        messageId = randomUUID();
        const result = await client.streamChat({
          messages: session.messages,
          tools: [...AI_TOOLS],
          mode: settings2.mode,
          signal: controller.signal,
          callbacks: {
            onText: (delta) => {
              answer += delta;
              this.emit(Events.AI_DELTA, { chatId: session.id, messageId, text: delta });
            },
            onUsage: (usage) => {
              session.usage = { ...session.usage, ...usage };
            }
          }
        });
        this.pushMessage(session, {
          id: messageId,
          role: "assistant",
          content: result.text,
          createdAt: this.timestamp(),
          ...result.toolCalls.length > 0 ? { toolCalls: result.toolCalls } : {}
        });
        if (result.text !== "") answer = result.text === answer ? answer : result.text;
        if (result.toolCalls.length === 0) break;
        if (controller.signal.aborted) break;
        for (const call of result.toolCalls) {
          toolCallCount++;
          const toolResult = await this.runTool(call, session, guard, policy, messageId);
          this.emit(Events.AI_TOOL_RESULT, {
            chatId: session.id,
            messageId,
            tool: call.name,
            result: toolResult.summary,
            isError: toolResult.isError
          });
          this.pushMessage(session, {
            id: randomUUID(),
            role: "tool",
            content: toolResult.content,
            createdAt: this.timestamp(),
            toolCallId: call.id,
            name: call.name
          });
        }
        guard.startRound();
      }
      session.updatedAt = this.timestamp();
      this.emit(Events.AI_DONE, {
        chatId: session.id,
        messageId,
        usage: {
          ...session.usage.inputTokens === void 0 ? {} : { inputTokens: session.usage.inputTokens },
          ...session.usage.outputTokens === void 0 ? {} : { outputTokens: session.usage.outputTokens }
        }
      });
      return { chatId: session.id, messageId, text: answer, toolCalls: toolCallCount };
    } catch (err) {
      if (isAbort(err) || controller.signal.aborted) {
        this.emit(Events.AI_DONE, { chatId: session.id, messageId });
        return { chatId: session.id, messageId, text: answer, toolCalls: toolCallCount };
      }
      const message = err instanceof AiLimitError ? err.message : errorMessage(err);
      this.emit(Events.AI_ERROR, { chatId: session.id, message });
      throw err instanceof AppError ? err : AppError.internal(message);
    } finally {
      this.active.delete(session.id);
    }
  }
  // -------------------------------------------------------------------------
  /** 执行一次工具调用：护栏决策 → 上限 → 审计 → 执行 */
  async runTool(call, session, guard, policy, messageId) {
    const args = parseToolArguments(call.arguments);
    if (call.name === "t1000_ssh_list_sessions") {
      const sessions2 = this.deps.listSessions?.() ?? [];
      return {
        // content 给模型（含 host/user），summary 给 UI（只留 id，不把连接信息刷进事件流）
        content: JSON.stringify(sessions2),
        summary: { sessions: sessions2.length, ids: sessions2.map((s) => s.sessionId) },
        isError: false
      };
    }
    if (call.name === "t1000_ssh_read_file") {
      const sessionId2 = String(args["sessionId"] ?? "");
      const path = String(args["path"] ?? "");
      if (sessionId2 === "" || path === "") {
        return { content: "参数不完整：需要 sessionId 与 path", summary: { error: "bad-args" }, isError: true };
      }
      guard.recordCommand(sessionId2);
      this.audit.record({
        phase: "before",
        actor: "ai-assistant",
        chatId: session.id,
        sessionId: sessionId2,
        target: sessionId2,
        command: `read-file ${path}`,
        decision: "executed",
        risk: "read-only"
      });
      if (!this.deps.readRemoteFile) {
        return { content: "当前未提供远端文件读取能力", summary: { error: "unsupported" }, isError: true };
      }
      try {
        const content = await this.deps.readRemoteFile(sessionId2, path);
        return { content, summary: { path, bytes: content.length }, isError: false };
      } catch (err) {
        const message = errorMessage(err);
        this.audit.record({
          phase: "after",
          actor: "ai-assistant",
          chatId: session.id,
          sessionId: sessionId2,
          command: `read-file ${path}`,
          decision: "failed",
          risk: "read-only",
          error: message
        });
        return { content: `读取失败: ${message}`, summary: { error: message }, isError: true };
      }
    }
    if (call.name !== "t1000_ssh_exec" && call.name !== "t1000_ssh_sudo_exec") {
      return { content: `未知工具: ${call.name}`, summary: { error: "unknown-tool" }, isError: true };
    }
    const sessionId = String(args["sessionId"] ?? "");
    const rawCommand = String(args["command"] ?? "").trim();
    if (sessionId === "" || rawCommand === "") {
      return { content: "参数不完整：需要 sessionId 与 command", summary: { error: "bad-args" }, isError: true };
    }
    const command = call.name === "t1000_ssh_sudo_exec" ? `sudo ${rawCommand}` : rawCommand;
    const plan = planCommandExecution({ command, policy });
    this.emit(Events.AI_TOOL_CALL, {
      chatId: session.id,
      messageId: session.id,
      tool: call.name,
      args: { sessionId, command: rawCommand }
    });
    if (plan.action !== "execute") {
      const decision = plan.action === "deny" ? "rejected" : "suggested";
      this.audit.record({
        phase: "before",
        actor: "ai-assistant",
        chatId: session.id,
        sessionId,
        target: sessionId,
        command,
        decision,
        risk: plan.risk,
        reason: plan.reason
      });
      const prefix = plan.action === "suggest" ? "未执行（仅建议）" : plan.action === "confirm" ? "未执行（需要人工确认）" : "已拒绝";
      return {
        content: `${prefix}：${command}
原因：${plan.reason}`,
        summary: { decision: plan.action, reason: plan.reason, risk: plan.risk },
        isError: plan.action === "deny"
      };
    }
    guard.recordCommand(sessionId);
    const started = this.deps.now?.() ?? Date.now();
    this.audit.record({
      phase: "before",
      actor: "ai-assistant",
      chatId: session.id,
      sessionId,
      target: sessionId,
      command,
      decision: "executed",
      risk: plan.risk,
      reason: plan.reason
    });
    if (!this.deps.exec) {
      return { content: "当前未提供命令执行能力", summary: { error: "unsupported" }, isError: true };
    }
    const timeoutMs = numberOr(args["timeoutMs"], 6e4, 6e5);
    try {
      const outcome = await this.deps.exec(sessionId, command, { timeoutMs });
      const durationMs = (this.deps.now?.() ?? Date.now()) - started;
      this.audit.record({
        phase: "after",
        actor: "ai-assistant",
        chatId: session.id,
        sessionId,
        target: sessionId,
        command,
        decision: "executed",
        risk: plan.risk,
        exitCode: outcome.code,
        durationMs
      });
      return {
        content: formatExecOutcome(outcome),
        summary: { exitCode: outcome.code, durationMs },
        // 非零退出码算工具错误，让模型知道要处理
        isError: outcome.code !== 0
      };
    } catch (err) {
      const message = errorMessage(err);
      this.audit.record({
        phase: "after",
        actor: "ai-assistant",
        chatId: session.id,
        sessionId,
        target: sessionId,
        command,
        decision: "failed",
        risk: plan.risk,
        error: message,
        durationMs: (this.deps.now?.() ?? Date.now()) - started
      });
      return { content: `执行失败: ${message}`, summary: { error: message }, isError: true };
    }
  }
  /** 统一的时间戳来源（`deps.now` 可注入，便于测试固定时间） */
  timestamp() {
    return new Date(this.deps.now?.() ?? Date.now()).toISOString();
  }
  /**
   * 给历史消息补齐稳定身份（旧数据没有 id/createdAt）。
   *
   * 按 `chatId:序号` 派生并**就地固化**，因此：
   * - 同一会话多次读取得到完全相同的 id（否则 UI 每次刷新 key 都在变，等于没修）；
   * - 之后即使触及消息数上限被裁剪，已固化的 id 也不会漂移。
   */
  ensureMessageIdentity(chat) {
    chat.messages.forEach((message, index2) => {
      if (typeof message.id !== "string" || message.id.length === 0) {
        message.id = `${chat.id}:${index2}`;
      }
      if (typeof message.createdAt !== "string" || message.createdAt.length === 0) {
        message.createdAt = chat.createdAt;
      }
    });
  }
  pushMessage(session, message) {
    this.ensureMessageIdentity(session);
    if (typeof message.id !== "string" || message.id.length === 0) message.id = randomUUID();
    if (typeof message.createdAt !== "string" || message.createdAt.length === 0) {
      message.createdAt = this.timestamp();
    }
    session.messages.push(message);
    if (session.messages.length > MAX_MESSAGES_PER_CHAT) {
      session.messages.splice(0, session.messages.length - MAX_MESSAGES_PER_CHAT);
    }
  }
  emit(event, payload) {
    this.deps.emit(event, payload);
  }
}
function errorMessage(err) {
  return err instanceof Error ? err.message : String(err);
}
function isAbort(err) {
  return err instanceof Error && (err.name === "AbortError" || /aborted/i.test(err.message));
}
function numberOr(value, fallback, max) {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), max);
}
function formatExecOutcome(outcome) {
  const parts = [`exitCode=${outcome.code}`];
  if (outcome.stdout !== "") parts.push(`stdout:
${truncate(outcome.stdout, 8e3)}`);
  if (outcome.stderr !== "") parts.push(`stderr:
${truncate(outcome.stderr, 4e3)}`);
  return parts.join("\n");
}
function truncate(text, max) {
  return text.length <= max ? text : `${text.slice(0, max)}
…（已截断，共 ${text.length} 字符）`;
}
const SUGGEST_TIMEOUT_MS = 8e3;
const HARD_LIMIT = 10;
const FENCE_RE = /^\s*```/;
const BULLET_RE = /^\s*(?:[-*•]|\d+[.)])\s+/;
const BACKTICK_WRAP_RE = /^`+|`+$/g;
function buildSuggestPrompt(query, limit) {
  const n = Math.max(1, Math.min(HARD_LIMIT, limit));
  return [
    {
      role: "system",
      content: [
        "你是 shell 命令助手。用户给出一个命令片段，你要补全成可直接执行的完整命令。",
        `最多给出 ${n} 条，按推荐程度排序。`,
        "输出格式（必须严格遵守）：",
        "- 每行一条完整命令，不要编号、不要项目符号、不要解释、不要 markdown 代码块",
        '- 若某条命令需要说明，在同一行的最后用 " | " 分隔一句很短的说明',
        "- 不要输出任何多余的文字"
      ].join("\n")
    },
    { role: "user", content: query.trim() }
  ];
}
function parseCommandSuggestions(text, limit) {
  const max = Math.max(1, Math.min(HARD_LIMIT, limit));
  const out = [];
  const seen = /* @__PURE__ */ new Set();
  for (const rawLine of text.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (line === "") continue;
    if (FENCE_RE.test(line)) continue;
    line = line.replace(BULLET_RE, "").trim();
    if (line === "") continue;
    line = line.replace(BACKTICK_WRAP_RE, "").trim();
    if (line === "") continue;
    let command = line;
    let description;
    const sep2 = line.indexOf(" | ");
    if (sep2 > 0) {
      command = line.slice(0, sep2).trim();
      const desc = line.slice(sep2 + 3).trim();
      if (desc !== "") description = desc;
    }
    if (command === "" || command.length > 500) continue;
    if (/^(以下是|下面是|说明[:：]|注意[:：])/.test(command)) continue;
    if (/[。；]$/.test(command) && !command.includes(" --")) continue;
    const key2 = command.toLowerCase();
    if (seen.has(key2)) continue;
    seen.add(key2);
    out.push(description === void 0 ? { command } : { command, description });
    if (out.length >= max) break;
  }
  return out;
}
const NO_PROVIDER_MESSAGE = "AI 建议需要先配置 AI 供应商：请打开「设置 > AI 助手」，选择供应商并填写 API Key 后重试";
function missingApiKeyMessage(providerName) {
  return `供应商「${providerName}」未配置 API Key：请打开「设置 > AI 助手」填写后重试`;
}
const MAX_AI_READ_BYTES = 2 * 1024 * 1024;
const SAFE_SETTINGS = {
  providers: [],
  mode: "chat",
  allowExecution: false,
  riskPolicy: { readOnlyAllowlist: [], dangerousDenylist: [], confirmSudo: true },
  limits: { maxRounds: 20, maxCommands: 50, maxTargets: 5 }
};
let runtime = {};
let activeProviderOverride;
function configureAi(next) {
  runtime = { ...runtime, ...next };
}
async function suggestCommands(input, limit) {
  const provider = findProvider();
  if (!provider) throw AppError.badRequest(NO_PROVIDER_MESSAGE);
  if (!provider.apiKey) throw AppError.badRequest(missingApiKeyMessage(provider.name));
  const client = createProviderClient(provider, { fetch: runtime.fetch ?? globalFetch });
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const messages = buildSuggestPrompt(input.query, limit).map((turn, i) => ({
    id: `suggest-${i}`,
    role: turn.role,
    content: turn.content,
    createdAt: now
  }));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SUGGEST_TIMEOUT_MS);
  try {
    const result = await client.streamChat({ messages, signal: controller.signal });
    return parseCommandSuggestions(result.text, limit);
  } catch (err) {
    if (controller.signal.aborted) {
      throw AppError.internal(
        `AI 建议在 ${Math.round(SUGGEST_TIMEOUT_MS / 1e3)} 秒内没有返回。AI 建议对延迟很敏感（补全弹窗会一直等），建议在「设置 > AI 助手」里为它改用**响应更快的模型**（推理型模型往往会先"想"很久）；也可以换个说法再试`
      );
    }
    throw err instanceof AppError ? err : AppError.internal(
      `AI 建议调用失败：${err instanceof Error ? err.message : String(err)}`
    );
  } finally {
    clearTimeout(timer);
  }
}
function settings() {
  return runtime.getSettings?.() ?? SAFE_SETTINGS;
}
function findProvider(id) {
  const s = settings();
  const all = s.providers;
  const wanted = id ?? activeProviderOverride ?? s.activeProviderId;
  if (wanted !== void 0) {
    const hit = all.find((p) => p.id === wanted);
    if (hit) return hit;
  }
  return all[0];
}
const defaultExec = async (sessionId, command, options) => {
  let session;
  try {
    session = requireSession(sessionId);
  } catch (err) {
    throw AppError.notConnected(err instanceof Error ? err.message : "会话不存在或已断开");
  }
  return session.exec(command, { timeoutMs: options?.timeoutMs ?? 6e4 });
};
const defaultListSessions = () => listSessions().map((s) => ({
  sessionId: s.sessionId,
  host: s.host,
  username: s.username,
  connectionId: s.connectionId
}));
const defaultReadRemoteFile = async (sessionId, path, maxBytes = MAX_AI_READ_BYTES) => {
  let session;
  try {
    session = requireSession(sessionId);
  } catch (err) {
    throw AppError.notConnected(err instanceof Error ? err.message : "会话不存在或已断开");
  }
  const sftp = await new Promise((resolve2, reject) => {
    session.client.sftp((err, wrapper) => {
      if (err) reject(AppError.notConnected(`打开 SFTP 通道失败: ${err.message}`));
      else resolve2(wrapper);
    });
  });
  return new Promise((resolve2, reject) => {
    sftp.stat(path, (statErr, stats) => {
      if (statErr) return reject(AppError.notFound(`远端文件不可读: ${path}`));
      if (stats.size > maxBytes) {
        return reject(AppError.badRequest(`文件过大（${stats.size} > ${maxBytes} 字节），已拒绝读取`));
      }
      sftp.readFile(path, (readErr, data) => {
        if (readErr) return reject(AppError.internal(`读取失败: ${readErr.message}`));
        resolve2(data.toString("utf8"));
      });
    });
  });
};
let service = null;
function chatService(ctx) {
  if (!service) {
    service = new ChatService({
      emit: ctx.emit,
      getSettings: settings,
      getProvider: findProvider,
      listProviders: () => settings().providers,
      fetch: runtime.fetch ?? globalFetch,
      exec: runtime.exec ?? defaultExec,
      listSessions: runtime.listSessions ?? defaultListSessions,
      readRemoteFile: runtime.readRemoteFile ?? defaultReadRemoteFile,
      ...runtime.auditSink ? { auditSink: runtime.auditSink } : {}
    });
  } else {
    service.setEmitter(ctx.emit);
  }
  return service;
}
const chatId = z.string().min(1, "缺少 chatId");
const sendSchema = z.object({
  chatId: chatId.optional(),
  text: z.string().min(1, "消息不能为空"),
  providerId: z.string().min(1).optional()
});
const getChatSchema = z.object({ chatId });
const cancelSchema = z.object({ chatId });
const deleteChatSchema = z.object({ chatId });
const setProviderSchema = z.object({ providerId: z.string().min(1) });
function publicProvider(p) {
  return {
    id: p.id,
    name: p.name,
    kind: p.kind,
    baseUrl: p.baseUrl,
    model: p.model,
    hasApiKey: typeof p.apiKey === "string" && p.apiKey !== "",
    ...p.extendedThinking === void 0 ? {} : { extendedThinking: p.extendedThinking },
    ...p.temperature === void 0 ? {} : { temperature: p.temperature },
    ...p.maxTokens === void 0 ? {} : { maxTokens: p.maxTokens }
  };
}
const aiHandlers = {
  listChats: (_payload, ctx) => chatService(ctx).listChats(),
  getChat: (payload, ctx) => {
    const { chatId: id } = parseInput$1(getChatSchema, payload);
    const chat = chatService(ctx).getChat(id);
    if (!chat) throw AppError.notFound(`AI 会话不存在: ${id}`);
    return chat;
  },
  send: (payload, ctx) => {
    const { chatId: id, text, providerId } = parseInput$1(sendSchema, payload);
    return chatService(ctx).send({
      ...id === void 0 ? {} : { chatId: id },
      text,
      ...providerId === void 0 ? {} : { providerId }
    });
  },
  cancel: (payload, ctx) => {
    const { chatId: id } = parseInput$1(cancelSchema, payload);
    return { chatId: id, cancelled: chatService(ctx).cancel(id) };
  },
  deleteChat: (payload, ctx) => {
    const { chatId: id } = parseInput$1(deleteChatSchema, payload);
    return { chatId: id, deleted: chatService(ctx).deleteChat(id) };
  },
  /** 只回可公开字段；apiKey 永不出主进程 */
  listProviders: () => ({ providers: settings().providers.map(publicProvider) }),
  setProvider: (payload) => {
    const { providerId } = parseInput$1(setProviderSchema, payload);
    if (!settings().providers.some((p) => p.id === providerId)) {
      throw AppError.notFound(`供应商不存在: ${providerId}`);
    }
    activeProviderOverride = providerId;
    runtime.setActiveProvider?.(providerId);
    return { providerId };
  }
};
const index$4 = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  aiHandlers,
  configureAi,
  suggestCommands
}, Symbol.toStringTag, { value: "Module" }));
const COMMAND_CATEGORIES = [
  "files",
  "text",
  "process",
  "network",
  "system",
  "package",
  "container",
  "vcs",
  "security"
];
const CATEGORY_LABELS = {
  files: "文件与目录",
  text: "文本处理",
  process: "进程与资源",
  network: "网络",
  system: "系统与 Shell",
  package: "包管理与构建",
  container: "容器与虚拟化",
  vcs: "版本控制",
  security: "安全与密钥"
};
function manualFromRow(row) {
  const [purpose, usage, install] = row;
  return install === void 0 ? { purpose, usage } : { purpose, usage, install };
}
function applyManual(spec, manual) {
  spec.purpose = manual.purpose;
  spec.usage = manual.usage;
  if (manual.install !== void 0 && manual.install !== "") spec.install = manual.install;
  if (manual.examples !== void 0 && manual.examples.length > 0) {
    spec.examples = manual.examples.map(([command, description]) => ({ command, description }));
  }
  if (manual.shortcuts !== void 0 && manual.shortcuts.length > 0) {
    spec.shortcuts = manual.shortcuts.map(([key2, description]) => ({ key: key2, description }));
  }
  return spec;
}
function isSafeSpecName(name) {
  if (name.length === 0 || name.length > 200) return false;
  if (name.includes("/") || name.includes("\\") || name.includes("\0")) return false;
  if (name === "." || name === "..") return false;
  return /^[A-Za-z0-9@._+-]+$/.test(name);
}
function normalizeSpec(name, rows) {
  const options = (rows.opts ?? []).map((row) => {
    const [optName, description, arg] = row;
    if (arg === void 0 || arg.trim().length === 0) return { name: optName, description };
    return { name: optName, description, arg };
  });
  const spec = { name, options };
  if (rows.subs && rows.subs.length > 0) {
    spec.subcommands = rows.subs.map(([subName, description]) => ({ name: subName, description }));
  }
  if (rows.example !== void 0) spec.example = rows.example;
  if (rows.purpose !== void 0 || rows.usage !== void 0) {
    applyManual(spec, {
      purpose: rows.purpose ?? "",
      usage: rows.usage ?? "",
      ...rows.install === void 0 ? {} : { install: rows.install },
      ...rows.examples === void 0 ? {} : { examples: rows.examples },
      ...rows.shortcuts === void 0 ? {} : { shortcuts: rows.shortcuts }
    });
  }
  return spec;
}
const ROWS$1 = [
  // ── 文件与目录 ────────────────────────────────────────────────────────────
  ["ls", "列出目录内容", "files"],
  ["cp", "复制文件或目录", "files"],
  ["mv", "移动或重命名文件", "files"],
  ["rm", "删除文件或目录", "files"],
  ["mkdir", "创建目录", "files"],
  ["rmdir", "删除空目录", "files"],
  ["ln", "创建硬链接或符号链接", "files"],
  ["touch", "创建空文件或更新时间戳", "files"],
  ["stat", "显示文件详细状态", "files"],
  ["file", "探测文件类型", "files"],
  ["find", "按条件查找文件", "files"],
  ["locate", "从数据库快速查找文件", "files"],
  ["tree", "以树形展示目录", "files"],
  ["du", "统计目录占用空间", "files"],
  ["df", "查看文件系统使用情况", "files"],
  ["dd", "按块复制与转换数据", "files"],
  ["rsync", "增量同步文件", "files"],
  ["tar", "打包与解包归档", "files"],
  ["gzip", "gzip 压缩", "files"],
  ["gunzip", "解压 gzip 文件", "files"],
  ["xz", "xz 压缩与解压", "files"],
  ["zip", "创建 zip 压缩包", "files"],
  ["unzip", "解压 zip 压缩包", "files"],
  ["mount", "挂载文件系统", "files"],
  ["umount", "卸载文件系统", "files"],
  ["chmod", "修改文件权限", "files"],
  ["chown", "修改文件属主", "files"],
  ["chgrp", "修改文件属组", "files"],
  ["realpath", "规范化绝对路径", "files"],
  ["basename", "取路径的文件名部分", "files"],
  ["dirname", "取路径的目录部分", "files"],
  ["readlink", "显示符号链接目标", "files"],
  ["mktemp", "创建临时文件或目录", "files"],
  ["shred", "安全擦除文件内容", "files"],
  ["truncate", "调整文件大小", "files"],
  ["sync", "把缓存刷入磁盘", "files"],
  // ── 文本处理 ──────────────────────────────────────────────────────────────
  ["cat", "拼接并输出文件内容", "text"],
  ["tac", "反向输出文件内容", "text"],
  ["head", "输出文件开头部分", "text"],
  ["tail", "输出文件末尾或跟踪增长", "text"],
  ["less", "分页浏览文件", "text"],
  ["grep", "按模式搜索文本", "text"],
  ["rg", "ripgrep 递归快速搜索", "text"],
  ["sed", "流式文本替换与编辑", "text"],
  ["awk", "按列处理结构化文本", "text"],
  ["cut", "按分隔符截取列", "text"],
  ["sort", "排序文本行", "text"],
  ["uniq", "去除相邻重复行", "text"],
  ["tr", "转换或删除字符", "text"],
  ["wc", "统计行数词数字节", "text"],
  ["tee", "同时写文件与标准输出", "text"],
  ["xargs", "把标准输入转成命令参数", "text"],
  ["diff", "比较两个文件的差异", "text"],
  ["patch", "按补丁文件修改内容", "text"],
  ["comm", "比较两个已排序文件", "text"],
  ["join", "按公共字段连接两个文件", "text"],
  ["paste", "按列合并文件", "text"],
  ["split", "拆分大文件", "text"],
  ["nl", "带行号输出文本", "text"],
  ["fold", "按宽度折行", "text"],
  ["column", "把文本排成对齐的列", "text"],
  ["rev", "逐行反转字符顺序", "text"],
  ["strings", "提取二进制中的可打印串", "text"],
  ["base64", "base64 编解码", "text"],
  ["md5sum", "计算 MD5 校验值", "text"],
  ["sha256sum", "计算 SHA-256 校验值", "text"],
  ["iconv", "转换字符编码", "text"],
  ["jq", "处理 JSON 数据", "text"],
  // ── 进程与资源 ────────────────────────────────────────────────────────────
  ["ps", "查看进程快照", "process"],
  ["top", "实时查看进程与负载", "process"],
  ["htop", "交互式进程查看器", "process"],
  ["kill", "向进程发送信号", "process"],
  ["killall", "按名字结束进程", "process"],
  ["pkill", "按模式结束进程", "process"],
  ["pgrep", "按模式查找进程号", "process"],
  ["nice", "以指定优先级启动进程", "process"],
  ["renice", "调整运行中进程的优先级", "process"],
  ["nohup", "忽略挂断信号运行命令", "process"],
  ["jobs", "查看当前 shell 的后台任务", "process"],
  ["bg", "把任务放到后台运行", "process"],
  ["fg", "把任务调到前台运行", "process"],
  ["sleep", "延时指定时间", "process"],
  ["timeout", "限时运行命令", "process"],
  ["watch", "周期性重复执行命令", "process"],
  ["strace", "跟踪系统调用", "process"],
  ["lsof", "列出打开的文件与端口", "process"],
  ["pidof", "按程序名查进程号", "process"],
  ["free", "查看内存与交换分区", "process"],
  ["vmstat", "查看虚拟内存与 IO 统计", "process"],
  ["iostat", "查看磁盘 IO 统计", "process"],
  ["uptime", "查看运行时长与平均负载", "process"],
  ["crontab", "管理定时任务", "process"],
  ["at", "安排一次性定时任务", "process"],
  // ── 网络 ──────────────────────────────────────────────────────────────────
  ["ping", "测试网络连通性", "network"],
  ["traceroute", "跟踪数据包路由路径", "network"],
  ["mtr", "路由跟踪与丢包统计", "network"],
  ["dig", "查询 DNS 记录", "network"],
  ["nslookup", "交互式查询 DNS", "network"],
  ["host", "简单 DNS 查询", "network"],
  ["curl", "用 URL 传输数据", "network"],
  ["wget", "下载文件", "network"],
  ["nc", "netcat 读写 TCP/UDP", "network"],
  ["ssh", "远程登录执行命令", "network"],
  ["scp", "基于 SSH 复制文件", "network"],
  ["sftp", "基于 SSH 的文件传输", "network"],
  ["ip", "查看与配置网络接口", "network", true],
  ["ifconfig", "查看与配置网卡", "network"],
  ["route", "查看与修改路由表", "network"],
  ["ss", "查看套接字与监听端口", "network"],
  ["netstat", "查看网络连接与统计", "network"],
  ["arp", "查看 ARP 缓存", "network"],
  ["tcpdump", "抓取网络数据包", "network"],
  ["nmap", "扫描主机与端口", "network"],
  ["iperf3", "测量网络带宽", "network"],
  ["whois", "查询域名注册信息", "network"],
  ["ufw", "Ubuntu 防火墙管理", "network", true],
  ["iptables", "配置内核包过滤规则", "network", true],
  ["socat", "多功能数据流中继", "network"],
  // ── 系统与 Shell ──────────────────────────────────────────────────────────
  ["uname", "显示内核与系统信息", "system"],
  ["hostname", "显示或设置主机名", "system"],
  ["hostnamectl", "管理主机名与系统标识", "system"],
  ["date", "显示或设置系统时间", "system"],
  ["timedatectl", "管理时间与时区", "system"],
  ["whoami", "显示当前用户名", "system"],
  ["id", "显示用户与组标识", "system"],
  ["groups", "显示用户所属组", "system"],
  ["who", "显示当前登录用户", "system"],
  ["w", "显示登录用户及活动", "system"],
  ["last", "显示登录历史", "system"],
  ["dmesg", "查看内核环形缓冲日志", "system"],
  ["journalctl", "查询 systemd 日志", "system"],
  ["systemctl", "管理系统服务与单元", "system", true],
  ["service", "以 SysV 方式管理服务", "system"],
  ["shutdown", "关机或重启", "system"],
  ["reboot", "重启系统", "system"],
  ["su", "切换用户身份", "system"],
  ["sudo", "以其它身份执行命令", "system"],
  ["env", "查看或在自定义环境中运行", "system"],
  ["alias", "定义命令别名", "system"],
  ["history", "查看命令历史", "system"],
  ["ulimit", "查看或设置资源上限", "system"],
  ["sysctl", "读写内核运行参数", "system"],
  ["lsmod", "列出已加载内核模块", "system"],
  ["modprobe", "加载或卸载内核模块", "system"],
  ["lspci", "列出 PCI 设备", "system"],
  ["lsusb", "列出 USB 设备", "system"],
  ["lsblk", "列出块设备与分区", "system"],
  ["blkid", "查看块设备属性", "system"],
  ["fdisk", "管理磁盘分区表", "system"],
  ["lscpu", "显示 CPU 架构信息", "system"],
  ["nproc", "显示可用 CPU 核心数", "system"],
  ["clear", "清屏", "system"],
  ["echo", "输出文本", "system"],
  ["printf", "按格式输出文本", "system"],
  ["read", "从标准输入读入一行", "system"],
  ["expr", "计算表达式", "system"],
  ["bc", "任意精度计算器", "system"],
  ["seq", "生成数字序列", "system"],
  ["yes", "重复输出一个字符串", "system"],
  ["test", "判断表达式真假", "system"],
  ["which", "定位命令的完整路径", "system"],
  ["whereis", "查找命令与手册位置", "system"],
  ["type", "判断名字是命令还是别名", "system"],
  ["man", "查看命令手册", "system"],
  ["tty", "显示当前终端设备", "system"],
  // ── 包管理与构建 ──────────────────────────────────────────────────────────
  ["apt", "Debian 系包管理", "package", true],
  ["apt-get", "Debian 系包管理（稳定接口）", "package", true],
  ["dpkg", "底层 deb 包管理", "package"],
  ["dnf", "Fedora 系包管理", "package", true],
  ["yum", "RHEL 系包管理", "package", true],
  ["rpm", "底层 rpm 包管理", "package"],
  ["pacman", "Arch 系包管理", "package", true],
  ["apk", "Alpine 包管理", "package", true],
  ["snap", "Snap 包管理", "package", true],
  ["pip", "Python 包管理", "package", true],
  ["npm", "Node 包管理", "package", true],
  ["yarn", "Node 包管理（yarn）", "package", true],
  ["pnpm", "Node 包管理（pnpm）", "package", true],
  ["cargo", "Rust 包管理与构建", "package", true],
  ["go", "Go 工具链", "package", true],
  ["make", "按 Makefile 构建", "package"],
  ["cmake", "跨平台构建配置", "package"],
  ["gcc", "GNU C 编译器", "package"],
  ["g++", "GNU C++ 编译器", "package"],
  ["clang", "LLVM C/C++ 编译器", "package"],
  ["nm", "列出目标文件符号", "package"],
  ["objdump", "反汇编目标文件", "package"],
  ["gdb", "GNU 调试器", "package"],
  ["valgrind", "内存与性能分析", "package"],
  ["perf", "Linux 性能分析工具", "package", true],
  // ── 容器与虚拟化 ──────────────────────────────────────────────────────────
  ["docker", "容器管理", "container", true],
  ["docker-compose", "编排多个容器", "container", true],
  ["kubectl", "Kubernetes 集群操作", "container", true],
  ["podman", "无守护进程容器管理", "container", true],
  ["helm", "Kubernetes 包管理", "container", true],
  ["minikube", "本地 Kubernetes 集群", "container", true],
  ["kind", "用容器跑 K8s 集群", "container", true],
  ["ctr", "containerd 命令行", "container", true],
  ["lxc", "系统容器管理", "container", true],
  ["virsh", "管理 libvirt 虚拟机", "container", true],
  // ── 版本控制 ──────────────────────────────────────────────────────────────
  ["git", "分布式版本控制", "vcs", true],
  ["gh", "GitHub 命令行", "vcs", true],
  ["svn", "Subversion 版本控制", "vcs", true],
  ["hg", "Mercurial 版本控制", "vcs", true],
  // ── 安全与密钥 ────────────────────────────────────────────────────────────
  ["ssh-keygen", "生成与管理 SSH 密钥", "security"],
  ["ssh-add", "把私钥加入 agent", "security"],
  ["ssh-agent", "SSH 密钥代理", "security"],
  ["ssh-copy-id", "把公钥安装到远端", "security"],
  ["ssh-keyscan", "收集远端主机公钥", "security"],
  // gpg 的操作是长选项而非子命令（--list-keys 等），因此不标 hasSubcommands
  ["gpg", "GnuPG 加解密与签名", "security"],
  ["openssl", "加密工具箱", "security", true],
  ["passwd", "修改账户密码", "security"],
  ["usermod", "修改用户账户属性", "security"],
  ["useradd", "创建用户账户", "security"]
];
const CATALOG = ROWS$1.map(([name, brief, category, hasSubs]) => {
  const entry = { name, brief, category };
  if (hasSubs === true) entry.hasSubcommands = true;
  return entry;
});
const CATALOG_BY_NAME = new Map(
  CATALOG.map((entry) => [entry.name, entry])
);
const CATEGORY_LOADERS = {
  files: () => import("./chunks/files-HsJ85WfJ.js").then((m) => m.FILES_SPECS),
  text: () => import("./chunks/text-_t0oYy5Y.js").then((m) => m.TEXT_SPECS),
  process: () => import("./chunks/process-CHQ8lZax.js").then((m) => m.PROCESS_SPECS),
  network: () => import("./chunks/network-CJCifGBu.js").then((m) => m.NETWORK_SPECS),
  system: () => import("./chunks/system-DpzP4eI2.js").then((m) => m.SYSTEM_SPECS),
  package: () => import("./chunks/package-Co5S0vSy.js").then((m) => m.PACKAGE_SPECS),
  container: () => import("./chunks/container-B88eIAfs.js").then((m) => m.CONTAINER_SPECS),
  vcs: () => import("./chunks/vcs-2AuYXZTv.js").then((m) => m.VCS_SPECS),
  security: () => import("./chunks/security-IkMqdj-o.js").then((m) => m.SECURITY_SPECS)
};
const MANUAL_CORE = {
  // ── 文件与目录 ─────────────────────────────────────────────────────────────
  ls: {
    purpose: "列出目录内容：文件名、权限、大小、时间",
    usage: "ls [选项]... [文件]...",
    install: "系统自带（coreutils）",
    examples: [
      ["ls -lh", "长格式 + 易读单位，日常最常用"],
      ["ls -la", "连以 . 开头的隐藏文件一起列"],
      ["ls -lt | head", "按修改时间倒序，看最近改过什么"]
    ]
  },
  cp: {
    purpose: "复制文件或目录",
    usage: "cp [选项]... 源... 目标",
    install: "系统自带（coreutils）",
    examples: [
      ["cp -r src/ dst/", "递归复制整个目录"],
      ["cp -a src/ dst/", "归档复制：保留权限、属主、时间戳、软链"],
      ["cp -u *.log /backup/", "只复制比目标更新的文件"]
    ]
  },
  mv: {
    purpose: "移动文件/目录，或重命名",
    usage: "mv [选项]... 源... 目标",
    install: "系统自带（coreutils）",
    examples: [
      ["mv old.txt new.txt", "重命名"],
      ["mv -i a.txt /tmp/", "覆盖前先询问"],
      ["mv *.jpg ~/Pictures/", "批量移动"]
    ]
  },
  rm: {
    purpose: "删除文件或目录（不可恢复，谨慎）",
    usage: "rm [选项]... 文件...",
    install: "系统自带（coreutils）",
    examples: [
      ["rm file.txt", "删除文件"],
      ["rm -r dir/", "递归删除目录及其内容"],
      ["rm -rf dir/", "递归且不询问（危险：先确认路径）"]
    ]
  },
  mkdir: {
    purpose: "创建目录",
    usage: "mkdir [选项]... 目录...",
    install: "系统自带（coreutils）",
    examples: [
      ["mkdir -p a/b/c", "一次性建多级目录（父目录不存在也能建）"],
      ["mkdir -m 700 private", "建目录并直接指定权限"]
    ]
  },
  find: {
    purpose: "按条件递归查找文件，可对结果执行命令",
    usage: "find [路径...] [表达式]",
    install: "系统自带（findutils）",
    examples: [
      ['find . -name "*.log"', "按名字查找（区分大小写）"],
      ["find /var -type f -size +100M", "找大于 100MB 的普通文件"],
      ['find . -name "*.tmp" -delete', "查出并删除（先用 -print 确认）"],
      ["find . -mtime -1 -type f", "找最近 1 天修改过的文件"]
    ]
  },
  tar: {
    purpose: "打包/解包归档（常配合 gzip/xz 压缩）",
    usage: "tar [选项]... [归档文件] [文件...]",
    install: "系统自带（tar）",
    examples: [
      ["tar -czf out.tar.gz dir/", "打包并用 gzip 压缩"],
      ["tar -xzf out.tar.gz -C /tmp/", "解压到指定目录"],
      ["tar -tzf out.tar.gz | head", "只看压缩包内容（不解压）"]
    ]
  },
  rsync: {
    purpose: "增量同步文件：只传差异，支持远端与断点续传",
    usage: "rsync [选项]... 源... 目标",
    install: "系统自带（rsync，部分最小系统需 apt install rsync）",
    examples: [
      ["rsync -av src/ dst/", "归档同步并显示过程（注意 src/ 结尾斜杠的语义）"],
      ["rsync -avz -e ssh dir/ user@host:/data/", "经 SSH 同步并压缩传输"],
      ["rsync -av --delete src/ dst/", "让目标与源完全一致（会删掉目标多余文件）"],
      ["rsync -avn src/ dst/", "演练：只显示会做什么，不实际改动"]
    ]
  },
  chmod: {
    purpose: "修改文件权限（读/写/执行）",
    usage: "chmod [选项]... 模式 文件...",
    install: "系统自带（coreutils）",
    examples: [
      ["chmod +x script.sh", "加执行权限"],
      ["chmod 644 file", "属主可读写，其他人只读"],
      ["chmod -R 755 dir/", "递归设置目录权限"]
    ]
  },
  du: {
    purpose: "统计目录/文件占用空间",
    usage: "du [选项]... [文件]...",
    install: "系统自带（coreutils）",
    examples: [
      ["du -sh *", "每个条目只显示总计（找谁占地方）"],
      ["du -h --max-depth=1 /var", "只看 /var 下一层各目录大小"],
      ["du -ah dir | sort -h | tail", "按大小排序找最大的文件"]
    ]
  },
  df: {
    purpose: "查看各文件系统的容量与剩余空间",
    usage: "df [选项]... [文件]...",
    install: "系统自带（coreutils）",
    examples: [
      ["df -h", "易读单位看各挂载点使用率"],
      ["df -hT", "同时显示文件系统类型"],
      ["df -i", "查看 inode 是否用尽（小文件很多时会遇到）"]
    ]
  },
  ln: {
    purpose: "创建硬链接或符号链接（软链）",
    usage: "ln [选项]... 目标 链接名",
    install: "系统自带（coreutils）",
    examples: [
      ["ln -s /opt/app/v2 current", "建软链（最常用）"],
      ["ln -sfn /opt/app/v3 current", "原子替换已有软链"],
      ["ln file hardlink", "建硬链接（同分区、不能指向目录）"]
    ]
  },
  touch: {
    purpose: "创建空文件，或更新访问/修改时间",
    usage: "touch [选项]... 文件...",
    install: "系统自带（coreutils）",
    examples: [
      ["touch new.txt", "文件不存在则建空文件"],
      ['touch -d "2026-01-01" file', "把时间戳改成指定值"],
      ["touch -r ref.txt target", "用参考文件的时间戳"]
    ]
  },
  gzip: {
    purpose: "gzip 压缩/解压单个文件（会替换原文件）",
    usage: "gzip [选项]... [文件]...",
    install: "系统自带（gzip）",
    examples: [
      ["gzip -k big.log", "压缩并保留原文件"],
      ["gzip -d big.log.gz", "解压（等价 gunzip）"],
      ["gzip -9 big.log", "最高压缩比（更慢）"]
    ]
  },
  // ── 文本处理 ───────────────────────────────────────────────────────────────
  grep: {
    purpose: "按模式搜索文本，可递归、可统计、可只看文件名",
    usage: "grep [选项]... 模式 [文件]...",
    install: "系统自带（grep）",
    examples: [
      ['grep -rn "TODO" src/', "递归搜索并显示行号"],
      ["grep -i error app.log", "忽略大小写"],
      ['grep -v "^#" conf | grep .', "排除注释行与空行"],
      ["grep -C 3 panic syslog", "显示匹配行的上下文各 3 行"]
    ]
  },
  sed: {
    purpose: "流式文本编辑：替换、删除、按行号取行",
    usage: "sed [选项]... 脚本 [文件]...",
    install: "系统自带（sed）",
    examples: [
      ['sed -i "s/old/new/g" file', "就地全局替换（-i 直接改文件）"],
      ['sed -n "10,20p" file', "只打印第 10-20 行"],
      ['sed "/^#/d" conf', "删除以 # 开头的行"]
    ]
  },
  awk: {
    purpose: "按列处理结构化文本：筛选、统计、汇总",
    usage: "awk [选项] 模式 {动作} [文件]...",
    install: "系统自带（awk / gawk / mawk）",
    examples: [
      ['awk -F: "{print $1}" /etc/passwd', "按冒号分隔取第一列"],
      ['awk "{sum+=$1} END{print sum}" nums.txt', "求第一列之和"],
      ['awk "$9>0 {print $3, $9}" f.txt', "带条件筛选并打印指定列"]
    ]
  },
  cat: {
    purpose: "输出文件内容，或拼接多个文件",
    usage: "cat [选项]... [文件]...",
    install: "系统自带（coreutils）",
    examples: [
      ["cat -n file", "带行号输出"],
      ["cat a.txt b.txt > all.txt", "拼接多个文件"],
      ["cat > note.txt <<EOF ... EOF", "配合 heredoc 写入多行内容"]
    ]
  },
  head: {
    purpose: "只输出文件开头（默认 10 行）",
    usage: "head [选项]... [文件]...",
    install: "系统自带（coreutils）",
    examples: [
      ["head -n 50 app.log", "看前 50 行"],
      ["head -c 200 bin", "看前 200 字节"],
      ["zcat big.gz | head", "看压缩文件开头（不解压到磁盘）"]
    ]
  },
  tail: {
    purpose: "输出文件末尾，或实时跟踪新增日志",
    usage: "tail [选项]... [文件]...",
    install: "系统自带（coreutils）",
    examples: [
      ["tail -n 100 app.log", "看最后 100 行"],
      ["tail -f app.log", "实时跟读（排障最常用）"],
      ["tail -F app.log", "跟读且日志轮转后自动重开"]
    ],
    shortcuts: [["Ctrl+C", "停止跟读并退出"]]
  },
  less: {
    purpose: "分页浏览大文件（不会一次读入内存）",
    usage: "less [选项]... [文件]...",
    install: "系统自带（less）",
    examples: [
      ["less +F app.log", "以跟读模式打开（类似 tail -f，Ctrl+C 退出跟读）"],
      ["less -N file", "显示行号"],
      ["ps aux | less", "翻阅长输出"]
    ],
    shortcuts: [
      ["空格 / b", "向下/向上一屏"],
      ["g / G", "跳到文件开头 / 结尾"],
      ["/ 与 ?", "向下 / 向上搜索"],
      ["n / N", "跳到下一个 / 上一个匹配"],
      ["q", "退出"]
    ]
  },
  sort: {
    purpose: "按行排序（可数值、可指定字段、可去重）",
    usage: "sort [选项]... [文件]...",
    install: "系统自带（coreutils）",
    examples: [
      ["sort -h sizes.txt", "按易读大小排序"],
      ["sort -t: -k3 -n /etc/passwd", "按第 3 列数值排序"],
      ["sort -u names.txt", "排序并去重"]
    ]
  },
  uniq: {
    purpose: "去除**相邻**重复行，常与 sort 连用",
    usage: "uniq [选项]... [输入文件] [输出文件]",
    install: "系统自带（coreutils）",
    examples: [
      ["sort names.txt | uniq", "先排序再整体去重"],
      ["sort log | uniq -c | sort -nr", "统计每行出现次数并倒序（Top N 神器）"],
      ["uniq -d file", "只看重复过的行"]
    ]
  },
  cut: {
    purpose: "按分隔符或位置切出指定列",
    usage: "cut [选项]... [文件]...",
    install: "系统自带（coreutils）",
    examples: [
      ["cut -d: -f1,3 /etc/passwd", "按冒号取第 1、3 列"],
      ["cut -c1-8 file", "按字符位置取前 8 个字符"],
      ["ps aux | cut -c1-20", "截取输出的前 20 列"]
    ]
  },
  tr: {
    purpose: "字符级转换/删除（常用来处理大小写与空白）",
    usage: "tr [选项]... 字符集1 [字符集2]",
    install: "系统自带（coreutils）",
    examples: [
      ['tr "a-z" "A-Z" < in > out', "转大写"],
      ['tr -d "\\r" < dos.txt > unix.txt', "删掉 Windows 换行里的 \\r"],
      ['tr -s " " < messy.txt', "把连续空格压成一个"]
    ]
  },
  wc: {
    purpose: "统计行数、词数、字节数",
    usage: "wc [选项]... [文件]...",
    install: "系统自带（coreutils）",
    examples: [
      ["wc -l file", "只数行数"],
      ['grep -c "" file', "（参考）统计行数的另一种写法"],
      ['find . -name "*.ts" | wc -l', "统计文件个数"]
    ]
  },
  xargs: {
    purpose: "把标准输入转成命令行参数（配合 find/grep 批量执行）",
    usage: "xargs [选项]... 命令 [初始参数]",
    install: "系统自带（findutils）",
    examples: [
      ['find . -name "*.tmp" | xargs rm -f', "批量删除（路径含空格时用 -0 配合）"],
      ["ls *.log | xargs -n1 -I{} gzip {}", "逐个压缩"],
      ["find . -type f -print0 | xargs -0 grep -l TODO", "处理含空格文件名"]
    ]
  },
  diff: {
    purpose: "比较两个文件/目录的差异",
    usage: "diff [选项]... 文件1 文件2",
    install: "系统自带（diffutils）",
    examples: [
      ["diff -u old.conf new.conf", "统一格式输出（可直接喂给 patch）"],
      ["diff -rq dir1 dir2", "只报告目录里哪些文件不同"],
      ["diff <(sort a) <(sort b)", "比较两份排序后的内容"]
    ]
  },
  jq: {
    purpose: "解析与筛选 JSON（命令行里的 JSON 瑞士军刀）",
    usage: "jq [选项]... 过滤器 [文件]...",
    install: "需安装：apt install jq",
    examples: [
      ['jq "." data.json', "美化输出"],
      ['jq -r ".items[].name" data.json', "取数组里每项的 name（原始文本）"],
      ['jq ".[] | select(.score > 60)" data.json', "按条件筛选对象"],
      ['curl -s api | jq ".data.id"', "与 curl 连用取字段"]
    ]
  },
  tee: {
    purpose: "把输出同时写到文件和屏幕（常用来边看边存日志）",
    usage: "命令 | tee [选项]... [文件]...",
    install: "系统自带（coreutils）",
    examples: [
      ["make 2>&1 | tee build.log", "编译输出同时存盘"],
      ["echo x | sudo tee /etc/conf.d/app", "以 root 权限写入受保护路径"],
      ["cmd | tee -a app.log", "追加而不是覆盖"]
    ]
  },
  // ── 进程与资源 ─────────────────────────────────────────────────────────────
  ps: {
    purpose: "查看进程快照（谁在跑、占多少 CPU/内存）",
    usage: "ps [选项]...",
    install: "系统自带（procps）",
    examples: [
      ["ps aux", "BSD 风格列出全部进程"],
      ["ps -eo pid,pcpu,pmem,args --sort=-pcpu | head", "按 CPU 占用倒序看前几名"],
      ["ps -ef | grep nginx", "找特定服务的进程"]
    ]
  },
  top: {
    purpose: "实时查看进程与系统负载（默认每 3 秒刷新）",
    usage: "top [选项]...",
    install: "系统自带（procps）",
    examples: [
      ["top -o %CPU", "按 CPU 排序启动"],
      ["top -u www-data", "只看某个用户的进程"],
      ["top -b -n1 | head -20", "批处理输出一次（便于脚本采集）"]
    ],
    shortcuts: [
      ["q", "退出"],
      ["h", "帮助"],
      ["k", "按 PID 结束进程（会提示输入信号）"],
      ["M / P", "按内存 / CPU 排序"],
      ["1", "展开/收起每个 CPU 核心"]
    ]
  },
  htop: {
    purpose: "更友好的交互式进程查看器（树形、可鼠标、可搜索）",
    usage: "htop [选项]...",
    install: "需安装：apt install htop",
    examples: [
      ["htop -u root", "只看 root 的进程"],
      ["htop -t", "以树形展示父子进程"]
    ],
    shortcuts: [
      ["F3 / F4", "搜索 / 过滤进程"],
      ["F5", "切换树形视图"],
      ["F6", "选择排序字段"],
      ["F9", "结束选中进程（可选信号）"],
      ["q", "退出"]
    ]
  },
  kill: {
    purpose: "给进程发信号（默认 SIGTERM 优雅结束）",
    usage: "kill [-信号] PID...",
    install: "系统自带（coreutils）",
    examples: [
      ["kill 1234", "优雅结束（进程可自行清理）"],
      ["kill -9 1234", "强制杀死（不给清理机会）"],
      ["kill -HUP 1234", "让进程重载配置（很多服务支持）"],
      ['pkill -f "python worker.py"', "按命令行匹配（参考 pkill）"]
    ]
  },
  free: {
    purpose: "查看内存与 swap 使用情况",
    usage: "free [选项]...",
    install: "系统自带（procps）",
    examples: [
      ["free -h", "易读单位"],
      ["free -m -s 2", "每 2 秒刷新一次（MB）"],
      ['free -h | awk "NR==2{print $7}"', "取 available 列（真正可用内存）"]
    ]
  },
  lsof: {
    purpose: "查看进程打开了哪些文件/端口（排查占用与句柄泄漏）",
    usage: "lsof [选项]... [名字...]",
    install: "需安装：apt install lsof",
    examples: [
      ["lsof -i :8080", "谁占用了 8080 端口"],
      ["lsof -p 1234", "某进程打开了哪些文件"],
      ["lsof +D /data", "目录下哪些文件正被打开"],
      ["lsof -u www-data | wc -l", "统计该用户的文件句柄数"]
    ]
  },
  crontab: {
    purpose: "管理当前用户的定时任务（cron 表达式）",
    usage: "crontab [-u 用户] [-l|-e|-r]",
    install: "系统自带（cron / cronie）",
    examples: [
      ["crontab -l", "列出当前任务"],
      ["crontab -e", "编辑任务（保存即生效）"],
      ["0 3 * * * /opt/backup.sh >> /var/log/backup.log 2>&1", "每天 3 点跑备份并记录日志"]
    ]
  },
  watch: {
    purpose: "周期性重复执行命令并全屏显示结果",
    usage: "watch [选项]... 命令",
    install: "系统自带（procps）",
    examples: [
      ['watch -n 1 "df -h /"', "每秒看一次根分区剩余空间"],
      ['watch -d -n 2 "ss -s"', "高亮变化部分"],
      ['watch "ls -l /var/log | tail"', "盯目录变化"]
    ],
    shortcuts: [["Ctrl+C", "退出"]]
  },
  nohup: {
    purpose: "让命令忽略挂断信号，退出终端后继续运行",
    usage: "nohup 命令 [参数]... &",
    install: "系统自带（coreutils）",
    examples: [
      ["nohup ./server > server.log 2>&1 &", "后台常驻并把输出写日志"],
      ["nohup rsync -av big/ /backup/ &", "长任务挂后台"]
    ]
  },
  timeout: {
    purpose: "给命令设置最长运行时间，超时自动终止",
    usage: "timeout [选项] 时长 命令 [参数]...",
    install: "系统自带（coreutils）",
    examples: [
      ["timeout 10 ping -c 100 host", "最多跑 10 秒"],
      ["timeout -s KILL 30 ./flaky.sh", "超时后强制杀死"],
      ['timeout 5 bash -c "cmd1 && cmd2"', "给整串命令设时限"]
    ]
  },
  // ── 网络 ───────────────────────────────────────────────────────────────────
  ssh: {
    purpose: "远程登录，或执行远端命令、做端口转发",
    usage: "ssh [选项]... [用户@]主机 [命令]",
    install: "系统自带（openssh-client）",
    examples: [
      ["ssh user@host", "登录远程主机"],
      ['ssh -p 2222 user@host "uptime"', "指定端口并执行一条命令"],
      ["ssh -i ~/.ssh/id_ed25519 user@host", "用指定私钥登录"],
      ["ssh -L 8080:127.0.0.1:80 user@host", "本地端口转发到远端"],
      ["ssh -J jump@bastion user@host", "经跳板机连接"]
    ]
  },
  scp: {
    purpose: "基于 SSH 在本地与远端之间复制文件",
    usage: "scp [选项]... 源... 目标",
    install: "系统自带（openssh-client）",
    examples: [
      ["scp file.txt user@host:/data/", "上传文件"],
      ["scp -r dir/ user@host:/data/", "上传整个目录"],
      ["scp -P 2222 user@host:/var/log/app.log .", "指定端口下载（注意 -P 大写）"]
    ]
  },
  curl: {
    purpose: "用 URL 传输数据：调接口、下载、看响应头",
    usage: "curl [选项]... URL...",
    install: "系统自带（curl，部分最小系统需安装）",
    examples: [
      ["curl -i https://example.com", "连响应头一起看"],
      ['curl -X POST -H "Content-Type: application/json" -d "{\\"a\\":1}" url', "发 JSON POST"],
      ["curl -s url | jq .", "静默 + 解析 JSON"],
      ["curl -L -o file.tar.gz url", "跟随重定向下载"],
      ['curl -H "Authorization: Bearer $TOKEN" url', "带认证头"]
    ]
  },
  wget: {
    purpose: "下载文件，支持断点续传与递归抓取",
    usage: "wget [选项]... URL...",
    install: "需安装：apt install wget",
    examples: [
      ["wget url", "下载到当前目录"],
      ["wget -c url", "断点续传"],
      ["wget -O name.tar.gz url", "指定保存文件名"],
      ["wget --limit-rate=200k url", "限速下载"]
    ]
  },
  ping: {
    purpose: "测试网络连通性与往返延迟",
    usage: "ping [选项]... 主机",
    install: "系统自带（iputils-ping）",
    examples: [
      ["ping -c 4 host", "只发 4 个包（脚本里别用无限 ping）"],
      ["ping -i 0.2 -c 10 host", "间隔 0.2 秒发 10 个包"],
      ["ping -s 1400 -M do host", "探测 MTU（不分片）"]
    ],
    shortcuts: [["Ctrl+C", "停止并打印统计"]]
  },
  netstat: {
    purpose: "查看网络连接、监听端口与统计（旧工具，新系统多用 ss）",
    usage: "netstat [选项]...",
    install: "需安装：apt install net-tools",
    examples: [
      ["netstat -tulnp", "列出监听的 TCP/UDP 端口与进程"],
      ["netstat -an | grep ESTABLISHED | wc -l", "统计已建立连接数"],
      ["netstat -rn", "查看路由表"]
    ]
  },
  ss: {
    purpose: "查看套接字与监听端口（netstat 的现代替代，更快）",
    usage: "ss [选项]... [过滤]",
    install: "系统自带（iproute2）",
    examples: [
      ["ss -tulnp", "监听端口 + 进程（排障首选）"],
      ["ss -tan state established", "只看已建立连接"],
      ["ss -s", "按协议汇总连接数"],
      ["ss -tnp dst :443", "看连到 443 的进程"]
    ]
  },
  dig: {
    purpose: "查询 DNS 记录（比 nslookup 更详细可控）",
    usage: "dig [@DNS服务器] 名字 [类型]",
    install: "需安装：apt install dnsutils",
    examples: [
      ["dig example.com", "查 A 记录"],
      ["dig +short example.com", "只输出结果"],
      ["dig @8.8.8.8 example.com MX", "指定 DNS 服务器查 MX"],
      ["dig +trace example.com", "从根开始跟踪解析链路"]
    ]
  },
  ip: {
    purpose: "查看与配置网络接口、地址、路由（iproute2 套件）",
    usage: "ip [选项] 对象 { 命令 }",
    install: "系统自带（iproute2）",
    examples: [
      ["ip -br a", "简洁列出所有网卡与地址"],
      ["ip route", "查看路由表"],
      ["ip link set eth0 up", "启用网卡（需 root）"],
      ["ip a add 192.168.1.10/24 dev eth0", "临时加地址"]
    ]
  },
  nc: {
    purpose: "netcat：读写 TCP/UDP，做端口探测与简易传文件",
    usage: "nc [选项] 主机 端口",
    install: "需安装：apt install netcat-openbsd",
    examples: [
      ["nc -zv host 22", "探测端口是否开放"],
      ["nc -l 9000", "本机监听 9000（另一端 nc host 9000 即可对话）"],
      ["nc -zv host 1-1000 2>&1 | grep succeeded", "扫描端口段"]
    ]
  },
  traceroute: {
    purpose: "跟踪数据包到目标经过的路由跳",
    usage: "traceroute [选项] 主机",
    install: "需安装：apt install traceroute",
    examples: [
      ["traceroute example.com", "看路径（默认 UDP）"],
      ["traceroute -T -p 443 example.com", "用 TCP 443 探测（穿透常见过滤）"],
      ["traceroute -n example.com", "不解析域名，更快"]
    ]
  },
  tcpdump: {
    purpose: "抓取网络数据包并做协议分析",
    usage: "tcpdump [选项] [表达式]",
    install: "需安装：apt install tcpdump",
    examples: [
      ["tcpdump -i any -nn port 80", "抓 80 端口流量（不解析名字）"],
      ["tcpdump -i eth0 -w cap.pcap", "存成 pcap 供 Wireshark 分析"],
      ["tcpdump -i any -A -s0 port 8080", "以 ASCII 显示载荷"]
    ],
    shortcuts: [["Ctrl+C", "停止抓包并打印统计"]]
  },
  // ── 系统与 Shell ───────────────────────────────────────────────────────────
  systemctl: {
    purpose: "管理 systemd 服务与单元（systemd 系统的服务控制入口）",
    usage: "systemctl [选项] 子命令 [单元...]",
    install: "系统自带（systemd）",
    examples: [
      ["systemctl status nginx", "看服务状态与最近日志"],
      ["sudo systemctl restart nginx", "重启服务"],
      ["sudo systemctl enable --now nginx", "设为开机自启并立刻启动"],
      ["systemctl list-units --failed", "列出启动失败的单元"],
      ["journalctl -u nginx -f", "跟读该服务日志（参考 journalctl）"]
    ]
  },
  journalctl: {
    purpose: "查询 systemd 日志（可按单元/时间/优先级过滤）",
    usage: "journalctl [选项]...",
    install: "系统自带（systemd）",
    examples: [
      ["journalctl -u nginx -n 100", "看某服务最近 100 行"],
      ["journalctl -u nginx -f", "实时跟读"],
      ['journalctl --since "1 hour ago" -p err', "看最近一小时错误级日志"],
      ["journalctl -b -k", "本次启动的内核日志"]
    ],
    shortcuts: [
      ["q", "退出（分页器里）"],
      ["空格 / b", "翻页"],
      ["/ 与 n", "搜索与下一个匹配"]
    ]
  },
  date: {
    purpose: "显示或设置系统时间，也可做时间格式转换",
    usage: "date [选项]... [+格式]",
    install: "系统自带（coreutils）",
    examples: [
      ["date +%F_%T", "格式化成 2026-01-01_12:00:00"],
      ['date -d "yesterday" +%F', "算昨天的日期"],
      ["date -d @1700000000", "把时间戳转成可读时间"],
      ["date -u", "以 UTC 显示"]
    ]
  },
  uname: {
    purpose: "显示内核与系统架构信息",
    usage: "uname [选项]...",
    install: "系统自带（coreutils）",
    examples: [
      ["uname -a", "全部信息"],
      ["uname -r", "只看内核版本"],
      ["uname -m", "看架构（x86_64 / aarch64）"]
    ]
  },
  sudo: {
    purpose: "以其它身份（默认 root）执行命令",
    usage: "sudo [选项] 命令",
    install: "系统自带（sudo）",
    examples: [
      ["sudo systemctl restart nginx", "以 root 执行"],
      ["sudo -u postgres psql", "以指定用户执行"],
      ["sudo -i", "切到 root 的登录 shell"],
      ["sudo visudo", "安全地编辑 sudoers（别直接用 vi 改）"]
    ]
  },
  man: {
    purpose: "查看命令手册（离线最权威的用法来源）",
    usage: "man [章节] 命令",
    install: "系统自带（man-db）",
    examples: [
      ["man ls", "查看 ls 手册"],
      ["man 5 crontab", "查第 5 章（文件格式）"],
      ['man -k "copy files"', "按关键词搜索手册"],
      ["man -w ls", "只显示手册文件路径"]
    ],
    shortcuts: [
      ["空格 / b", "翻页"],
      ["/ 与 n", "搜索与下一个匹配"],
      ["g / G", "开头 / 结尾"],
      ["q", "退出"]
    ]
  },
  lsblk: {
    purpose: "树形列出块设备与分区（看盘和挂载关系）",
    usage: "lsblk [选项]...",
    install: "系统自带（util-linux）",
    examples: [
      ["lsblk", "设备树"],
      ["lsblk -f", "带文件系统类型/UUID/挂载点"],
      ["lsblk -o NAME,SIZE,TYPE,MOUNTPOINT", "自定义列"],
      ["lsblk -J | jq .", "JSON 输出便于解析"]
    ]
  },
  // ── 包管理与构建 ───────────────────────────────────────────────────────────
  apt: {
    purpose: "Debian/Ubuntu 包管理：安装、升级、卸载、搜索",
    usage: "apt [选项] 子命令 [包名...]",
    install: "系统自带（Debian 系）",
    examples: [
      ["sudo apt update", "刷新索引（装包前先做）"],
      ["sudo apt install htop", "安装"],
      ["apt search ripgrep", "搜索包"],
      ["sudo apt remove --purge pkg", "卸载并清配置"],
      ["apt list --upgradable", "看有哪些可升级"]
    ]
  },
  pip: {
    purpose: "Python 包管理",
    usage: "pip [选项] 子命令 [包...]",
    install: "系统自带（或 apt install python3-pip）",
    examples: [
      ["pip install requests", "安装"],
      ["pip install -r requirements.txt", "按清单安装"],
      ["pip install --user pkg", "装到用户目录（不用 sudo）"],
      ["pip list --outdated", "看可升级的包"]
    ]
  },
  npm: {
    purpose: "Node.js 包管理与脚本运行",
    usage: "npm [选项] 子命令 [包...]",
    install: "需安装 Node.js（nodejs.org 或 nvm）",
    examples: [
      ["npm install", "按 package.json 装依赖"],
      ["npm ci", "按 lock 文件干净安装（CI 推荐）"],
      ["npm run build", "执行 package.json 里的脚本"],
      ["npm install -g pnpm", "全局安装命令行工具"]
    ]
  },
  make: {
    purpose: "按 Makefile 执行构建目标",
    usage: "make [选项]... [目标]...",
    install: "系统自带（make，部分系统需 apt install build-essential）",
    examples: [
      ["make -j$(nproc)", "并行编译（按核数）"],
      ["make -n install", "只打印将要执行的命令"],
      ["make clean && make", "先清理再构建"],
      ["make -C src", "在指定目录里构建"]
    ]
  },
  gcc: {
    purpose: "GNU C 编译器",
    usage: "gcc [选项] 源文件...",
    install: "需安装：apt install build-essential",
    examples: [
      ["gcc -Wall -O2 -o app main.c", "常用告警 + 二级优化编译"],
      ["gcc -c -g main.c", "只编译成带调试信息的 .o"],
      ["gcc -I/usr/local/include -L/usr/local/lib -lm main.c", "指定头文件/库路径并链接"]
    ]
  },
  // ── 容器与虚拟化 ───────────────────────────────────────────────────────────
  docker: {
    purpose: "容器管理：拉镜像、跑容器、看日志、进容器",
    usage: "docker [选项] 子命令 [参数]",
    install: "需安装：见 docker.com 官方脚本或 apt install docker.io",
    examples: [
      ["docker ps -a", "列出容器（含已退出）"],
      ["docker run -d -p 8080:80 --name web nginx", "后台跑并映射端口"],
      ["docker exec -it web bash", "进容器开 shell"],
      ["docker logs -f web", "跟读容器日志"],
      ["docker system df", "看磁盘占用（清理前先看）"],
      ["docker stats", "实时资源占用"]
    ]
  },
  "docker-compose": {
    purpose: "用 compose 文件编排多个容器",
    usage: "docker compose [选项] 子命令 [服务...]",
    install: "需安装：docker compose plugin 或 apt install docker-compose",
    examples: [
      ["docker compose up -d", "后台拉起整套服务"],
      ["docker compose logs -f web", "跟读某服务日志"],
      ["docker compose down", "停掉并删除容器/网络"],
      ["docker compose config", "校验并打印最终配置"]
    ]
  },
  kubectl: {
    purpose: "Kubernetes 集群操作：查资源、看日志、进 Pod",
    usage: "kubectl [选项] 子命令 [类型] [名字]",
    install: "需安装：kubectl 官方二进制（kubernetes.io）",
    examples: [
      ["kubectl get pods -A", "看所有命名空间的 Pod"],
      ["kubectl -n prod logs -f deploy/api", "跟读某 Deployment 的日志"],
      ["kubectl exec -it pod -- sh", "进容器"],
      ["kubectl describe pod name", "看事件与状态（排障首选）"],
      ["kubectl apply -f deploy.yaml", "按清单创建/更新"]
    ]
  },
  helm: {
    purpose: "Kubernetes 的包管理（chart 安装与升级）",
    usage: "helm [选项] 子命令 [参数]",
    install: "需安装：helm 官方脚本（helm.sh）",
    examples: [
      ["helm list -A", "列出所有 release"],
      ["helm install my-app ./chart -f values.yaml", "安装"],
      ["helm upgrade my-app ./chart --set image.tag=v2", "升级并覆盖单个值"],
      ["helm template ./chart", "本地渲染看最终 YAML"]
    ]
  },
  // ── 版本控制 ───────────────────────────────────────────────────────────────
  git: {
    purpose: "分布式版本控制：提交、分支、合并、与远端同步",
    usage: "git [选项] 子命令 [参数]",
    install: "系统自带或 apt install git",
    examples: [
      ["git status -sb", "看改动与分支状态"],
      ['git add -A && git commit -m "msg"', "暂存全部并提交"],
      ["git switch -c feature/x", "建并切换分支"],
      ["git log --oneline --graph -20", "看最近 20 条提交图"],
      ["git diff --staged", "看已暂存但未提交的改动"],
      ["git pull --rebase", "拉取并用变基代替合并"]
    ]
  },
  gh: {
    purpose: "GitHub 命令行：PR、Issue、Actions、发布",
    usage: "gh [子命令] [参数]",
    install: "需安装：gh 官方包（cli.github.com）",
    examples: [
      ["gh pr list", "列出 PR"],
      ["gh pr create --fill", "用提交信息快速开 PR"],
      ["gh run list --limit 5", "看最近的工作流运行"],
      ["gh repo clone owner/repo", "克隆仓库"]
    ]
  },
  // ── 安全与密钥 ─────────────────────────────────────────────────────────────
  "ssh-keygen": {
    purpose: "生成与管理 SSH 密钥对",
    usage: "ssh-keygen [选项]...",
    install: "系统自带（openssh-client）",
    examples: [
      ['ssh-keygen -t ed25519 -C "me@example.com"', "生成现代推荐算法密钥"],
      ["ssh-keygen -t rsa -b 4096", "生成 4096 位 RSA（兼容老系统）"],
      ["ssh-keygen -p -f ~/.ssh/id_ed25519", "修改已有私钥的口令"],
      ["ssh-keygen -R host", "从 known_hosts 移除某主机（换了指纹时）"]
    ]
  },
  openssl: {
    purpose: "加密工具箱：证书、摘要、加解密、连接测试",
    usage: "openssl 子命令 [选项]...",
    install: "系统自带（openssl）",
    examples: [
      ["openssl req -x509 -newkey rsa:4096 -days 365 -nodes -keyout k.pem -out c.pem", "生成自签证书"],
      ["openssl x509 -in c.pem -noout -text", "查看证书内容"],
      ["openssl dgst -sha256 file", "计算摘要"],
      ["openssl s_client -connect host:443 -servername host", "检查 TLS 证书与握手"],
      ["openssl rand -hex 32", "生成 32 字节随机串"]
    ]
  },
  gpg: {
    purpose: "GnuPG：加解密、签名、密钥管理",
    usage: "gpg [选项]... [文件]...",
    install: "系统自带或 apt install gnupg",
    examples: [
      ["gpg --list-keys", "列出公钥"],
      ["gpg --gen-key", "生成密钥对（交互）"],
      ["gpg -e -r UID file", "用对方公钥加密"],
      ["gpg -d file.gpg", "解密"],
      ["gpg --verify file.sig file", "校验签名"]
    ]
  }
};
const ROWS = [
  // ── 文件与目录 ─────────────────────────────────────────────────────────────
  ["rmdir", "删除空目录（比 rm -r 更安全）", "rmdir [选项]... 目录...", "系统自带（coreutils）"],
  ["stat", "显示文件/文件系统的详细状态", "stat [选项]... 文件...", "系统自带（coreutils）"],
  ["file", "探测文件类型（不看扩展名）", "file [选项]... 文件...", "系统自带（file）"],
  ["locate", "从预建数据库里按名字快速找文件", "locate [选项] 模式", "需安装：apt install mlocate"],
  ["tree", "以树形展示目录结构", "tree [选项]... [目录]", "需安装：apt install tree"],
  ["dd", "按块复制/转换数据（做镜像、测速）", "dd if=输入 of=输出 [参数]", "系统自带（coreutils）"],
  ["gunzip", "解压 .gz（等价 gzip -d）", "gunzip [选项]... 文件.gz", "系统自带（gzip）"],
  ["xz", "xz 压缩/解压（比 gzip 更小更慢）", "xz [选项]... [文件]...", "系统自带（xz-utils）"],
  ["zip", "创建 zip 压缩包（与 Windows 通用）", "zip [选项] 包名.zip 文件...", "需安装：apt install zip"],
  ["unzip", "解压 zip 包", "unzip [选项] 包名.zip [-d 目录]", "需安装：apt install unzip"],
  ["mount", "挂载文件系统/设备到目录", "mount [选项] [-t 类型] 设备 目录", "系统自带（util-linux）"],
  ["umount", "卸载已挂载的文件系统", "umount [选项] 设备|目录", "系统自带（util-linux）"],
  ["chown", "修改文件属主（可同时改属组）", "chown [选项]... 用户[:组] 文件...", "系统自带（coreutils）"],
  ["chgrp", "修改文件属组", "chgrp [选项]... 组 文件...", "系统自带（coreutils）"],
  ["realpath", "把路径规范化成绝对路径（解析 . 与 ..）", "realpath [选项]... 文件...", "系统自带（coreutils）"],
  ["basename", "取路径的最后一段（文件名）", "basename 路径 [后缀]", "系统自带（coreutils）"],
  ["dirname", "取路径的目录部分", "dirname 路径...", "系统自带（coreutils）"],
  ["readlink", "显示软链指向的目标", "readlink [选项]... 文件...", "系统自带（coreutils）"],
  ["mktemp", "安全地创建临时文件/目录", "mktemp [选项]... [模板]", "系统自带（coreutils）"],
  ["shred", "反复覆写文件后再删除（防恢复）", "shred [选项]... 文件...", "系统自带（coreutils）"],
  ["truncate", "把文件截断或扩展到指定大小", "truncate [选项]... 文件...", "系统自带（coreutils）"],
  ["sync", "把内存中的脏页刷入磁盘", "sync [选项]...", "系统自带（coreutils）"],
  // ── 文本处理 ───────────────────────────────────────────────────────────────
  ["tac", "按行倒序输出文件", "tac [选项]... [文件]...", "系统自带（coreutils）"],
  ["rg", "ripgrep：递归搜索，默认忽略 .gitignore、速度极快", "rg [选项] 模式 [路径]", "需安装：apt install ripgrep"],
  ["patch", "按 diff 补丁修改文件", "patch [选项] [原文件] [补丁]", "系统自带（patch）"],
  ["comm", "逐行比较两个**已排序**文件", "comm [选项] 文件1 文件2", "系统自带（coreutils）"],
  ["join", "按公共字段连接两个已排序文件", "join [选项] 文件1 文件2", "系统自带（coreutils）"],
  ["paste", "把多个文件按列合并", "paste [选项]... [文件]...", "系统自带（coreutils）"],
  ["split", "把大文件按大小/行数拆分", "split [选项] 文件 [前缀]", "系统自带（coreutils）"],
  ["nl", "带行号输出（可只给非空行编号）", "nl [选项]... [文件]...", "系统自带（coreutils）"],
  ["fold", "按宽度折行", "fold [选项]... [文件]...", "系统自带（coreutils）"],
  ["column", "把文本排成对齐的表格", "column [选项] [文件]...", "系统自带（bsdmainutils / util-linux）"],
  ["rev", "逐行反转字符顺序", "rev [文件]...", "系统自带（util-linux）"],
  ["strings", "从二进制里提取可打印字符串", "strings [选项] 文件...", "系统自带（binutils）"],
  ["base64", "base64 编码/解码", "base64 [选项] [文件]", "系统自带（coreutils）"],
  ["md5sum", "计算/校验 MD5 摘要", "md5sum [选项]... [文件]...", "系统自带（coreutils）"],
  ["sha256sum", "计算/校验 SHA-256 摘要（校验下载文件首选）", "sha256sum [选项]... [文件]...", "系统自带（coreutils）"],
  ["iconv", "转换文本编码（如 GBK ↔ UTF-8）", "iconv -f 源编码 -t 目标编码 [文件]", "系统自带（glibc）"],
  // ── 进程与资源 ─────────────────────────────────────────────────────────────
  ["killall", "按进程名结束所有同名进程", "killall [选项] 名字...", "系统自带（psmisc）"],
  ["pkill", "按名字/命令行模式结束进程", "pkill [选项] 模式", "系统自带（procps）"],
  ["pgrep", "按模式查找进程号（不杀，只查）", "pgrep [选项] 模式", "系统自带（procps）"],
  ["nice", "以指定优先级启动新进程", "nice [-n 调整值] 命令", "系统自带（coreutils）"],
  ["renice", "调整已运行进程的优先级", "renice -n 值 -p PID...", "系统自带（util-linux）"],
  ["jobs", "查看当前 shell 的后台任务", "jobs [选项] [作业号]", "Shell 内置"],
  ["bg", "把挂起的任务放到后台继续跑", "bg [%作业号]", "Shell 内置"],
  ["fg", "把后台任务调回前台", "fg [%作业号]", "Shell 内置"],
  ["sleep", "延时指定时间（脚本里等待用）", "sleep 时长[后缀s|m|h|d]", "系统自带（coreutils）"],
  ["strace", "跟踪进程的系统调用（排障利器）", "strace [选项] 命令 | -p PID", "需安装：apt install strace"],
  ["pidof", "按程序名查进程号", "pidof [选项] 程序名", "系统自带（sysvinit-utils）"],
  ["vmstat", "查看虚拟内存、CPU 与 IO 概览", "vmstat [间隔 [次数]]", "系统自带（procps）"],
  ["iostat", "查看磁盘 IO 与 CPU 统计", "iostat [选项] [间隔 [次数]]", "需安装：apt install sysstat"],
  ["uptime", "查看运行时长与平均负载", "uptime [选项]", "系统自带（procps）"],
  ["at", "安排一次性的定时任务", "at [选项] 时间", "需安装：apt install at"],
  // ── 网络 ───────────────────────────────────────────────────────────────────
  ["mtr", "把 ping 与 traceroute 合起来：持续看每跳丢包", "mtr [选项] 主机", "需安装：apt install mtr-tiny"],
  ["nslookup", "交互式查询 DNS（简单直接）", "nslookup [选项] 名字 [服务器]", "需安装：apt install dnsutils"],
  ["host", "简短 DNS 查询", "host [选项] 名字 [服务器]", "需安装：apt install bind9-host"],
  ["sftp", "基于 SSH 的交互式文件传输", "sftp [选项] [用户@]主机", "系统自带（openssh-client）"],
  ["ifconfig", "查看/配置网卡（旧工具，新系统用 ip）", "ifconfig [网卡] [参数]", "需安装：apt install net-tools"],
  ["route", "查看/修改路由表（旧工具，新系统用 ip route）", "route [选项] [add|del ...]", "需安装：apt install net-tools"],
  ["arp", "查看/修改 ARP 邻居缓存", "arp [选项] [主机名]", "需安装：apt install net-tools"],
  ["nmap", "扫描主机与端口，识别服务", "nmap [选项] 目标...", "需安装：apt install nmap"],
  ["iperf3", "测量两台机器之间的带宽", "iperf3 -s | -c 主机 [选项]", "需安装：apt install iperf3"],
  ["whois", "查询域名/IP 的注册信息", "whois [选项] 对象", "需安装：apt install whois"],
  ["ufw", "Ubuntu 简化防火墙管理", "ufw [子命令] [规则]", "系统自带或 apt install ufw"],
  ["iptables", "内核包过滤规则（底层防火墙）", "iptables [-t 表] 链 规则", "系统自带（iptables）"],
  ["socat", "多功能数据流中继（调试网络协议很好用）", "socat [选项] 地址1 地址2", "需安装：apt install socat"],
  // ── 系统与 Shell ───────────────────────────────────────────────────────────
  ["hostname", "显示或临时设置主机名", "hostname [选项] [新名字]", "系统自带（hostname）"],
  ["hostnamectl", "查看/设置主机名与系统标识（systemd）", "hostnamectl [子命令] [参数]", "系统自带（systemd）"],
  ["timedatectl", "查看/设置时间、时区与网络校时", "timedatectl [子命令] [参数]", "系统自带（systemd）"],
  ["whoami", "显示当前有效用户名", "whoami", "系统自带（coreutils）"],
  ["id", "显示当前用户的 UID/GID 与所属组", "id [选项] [用户]", "系统自带（coreutils）"],
  ["groups", "显示某用户所属的组", "groups [用户]...", "系统自带（coreutils）"],
  ["who", "显示当前登录的用户", "who [选项]", "系统自带（coreutils）"],
  ["w", "显示登录用户及其正在做什么", "w [选项] [用户]", "系统自带（procps）"],
  ["last", "查看登录历史（含重启记录）", "last [选项] [用户]", "系统自带（util-linux）"],
  ["dmesg", "查看内核环形缓冲（硬件/驱动报错在这里）", "dmesg [选项]", "系统自带（util-linux）"],
  ["service", "SysV 风格的服务控制（转发到 systemctl）", "service 服务名 {start|stop|restart|status}", "系统自带（init-system-helpers）"],
  ["shutdown", "关机或重启（可定时并广播）", "shutdown [选项] 时间 [消息]", "系统自带（systemd）"],
  ["reboot", "重启系统", "reboot [选项]", "系统自带（systemd）"],
  ["su", "切换到另一个用户（默认 root）", "su [选项] [用户]", "系统自带（util-linux）"],
  ["env", "在自定义环境下运行命令，或打印环境变量", "env [选项] [变量=值]... [命令]", "系统自带（coreutils）"],
  ["alias", "定义/查看命令别名", "alias [名字[=值]]", "Shell 内置"],
  ["history", "查看或操作命令历史", "history [选项] [条数]", "Shell 内置"],
  ["ulimit", "查看/设置当前 shell 的资源上限", "ulimit [选项] [值]", "Shell 内置"],
  ["sysctl", "读写内核运行参数（网络/内存调优）", "sysctl [选项] 变量[=值]", "系统自带（procps）"],
  ["lsmod", "列出已加载的内核模块", "lsmod", "系统自带（kmod）"],
  ["modprobe", "加载/卸载内核模块（含依赖）", "modprobe [选项] 模块 [参数]", "系统自带（kmod）"],
  ["lspci", "列出 PCI 设备（认显卡/网卡型号）", "lspci [选项]", "需安装：apt install pciutils"],
  ["lsusb", "列出 USB 设备", "lsusb [选项]", "需安装：apt install usbutils"],
  ["blkid", "查看块设备的 UUID/类型/标签", "blkid [选项] [设备]", "系统自带（util-linux）"],
  ["fdisk", "管理磁盘分区表（MBR/GPT）", "fdisk [选项] 设备", "系统自带（util-linux）"],
  ["lscpu", "查看 CPU 架构、核数、缓存等信息", "lscpu [选项]", "系统自带（util-linux）"],
  ["nproc", "打印可用 CPU 核心数（脚本里常用）", "nproc [选项]", "系统自带（coreutils）"],
  ["clear", "清屏", "clear [选项]", "系统自带（ncurses-bin）"],
  ["echo", "输出文本/变量", "echo [选项]... [字符串]...", "Shell 内置"],
  ["printf", "按格式输出（比 echo 可控）", "printf 格式 [参数]...", "Shell 内置"],
  ["read", "从标准输入读一行到变量", "read [选项] 变量...", "Shell 内置"],
  ["expr", "表达式求值（旧式算术/字符串判断）", "expr 表达式", "系统自带（coreutils）"],
  ["bc", "任意精度计算器（可脚本化）", "bc [选项] [文件]", "需安装：apt install bc"],
  ["seq", "生成数字序列", "seq [选项] 末数 | 首数 末数 [步长]", "系统自带（coreutils）"],
  ["yes", "重复输出一个字符串（自动回答 y）", "yes [字符串]", "系统自带（coreutils）"],
  ["test", "条件判断（if 用的就是它）", "test 表达式 / [ 表达式 ]", "Shell 内置"],
  ["which", "显示命令的完整路径", "which [选项] 命令...", "系统自带（debianutils）"],
  ["whereis", "查找命令的二进制/手册/源码位置", "whereis [选项] 名字...", "需安装：apt install util-linux"],
  ["type", "判断名字是内置命令、别名还是外部程序", "type [选项] 名字...", "Shell 内置"],
  ["tty", "显示当前终端设备名", "tty [选项]", "系统自带（coreutils）"],
  // ── 包管理与构建 ───────────────────────────────────────────────────────────
  ["apt-get", "apt 的稳定脚本接口（老系统/脚本里更常见）", "apt-get [选项] 子命令 [包...]", "系统自带（Debian 系）"],
  ["dpkg", "底层 deb 包管理（装本地 .deb、查包内文件）", "dpkg [选项] 动作 [包]", "系统自带（Debian 系）"],
  ["dnf", "Fedora/RHEL8+ 包管理", "dnf [选项] 子命令 [包...]", "系统自带（Fedora/RHEL）"],
  ["yum", "RHEL/CentOS 7 及更早的包管理", "yum [选项] 子命令 [包...]", "系统自带（RHEL/CentOS）"],
  ["rpm", "底层 rpm 包管理", "rpm [选项] 动作 [包]", "系统自带（RHEL 系）"],
  ["pacman", "Arch 系包管理", "pacman [选项] 动作 [包...]", "系统自带（Arch）"],
  ["apk", "Alpine 包管理", "apk [选项] 子命令 [包...]", "系统自带（Alpine）"],
  ["snap", "Snap 沙箱化包管理", "snap [选项] 子命令 [包]", "需安装：apt install snapd"],
  ["yarn", "Node 包管理（yarn）", "yarn [子命令] [包...]", "需先装 Node.js"],
  ["pnpm", "Node 包管理（pnpm，磁盘占用小）", "pnpm [子命令] [包...]", "需先装 Node.js"],
  ["cargo", "Rust 包管理与构建", "cargo [子命令] [选项]", "需安装：Rust 工具链（rustup）"],
  ["go", "Go 工具链：构建、测试、拉依赖", "go [子命令] [参数]", "需安装：Go 官方包"],
  ["cmake", "跨平台构建配置：生成 Makefile/工程文件", "cmake [选项] 源码目录", "需安装：apt install cmake"],
  ["g++", "GNU C++ 编译器", "g++ [选项] 源文件...", "需安装：apt install build-essential"],
  ["clang", "LLVM 的 C/C++ 编译器（报错更友好）", "clang [选项] 源文件...", "需安装：apt install clang"],
  ["nm", "列出目标文件/可执行文件里的符号", "nm [选项] 文件...", "系统自带（binutils）"],
  ["objdump", "反汇编与查看目标文件结构", "objdump [选项] 文件...", "系统自带（binutils）"],
  ["gdb", "GNU 调试器：断点、单步、看栈", "gdb [选项] [程序 [core|PID]]", "需安装：apt install gdb"],
  ["valgrind", "内存泄漏/越界检测（跑得慢但准）", "valgrind [选项] 程序 [参数]", "需安装：apt install valgrind"],
  ["perf", "Linux 性能分析：采样热点、看计数器", "perf 子命令 [选项]", "需安装：apt install linux-tools-common"],
  // ── 容器与虚拟化 ───────────────────────────────────────────────────────────
  ["podman", "无守护进程的容器管理（兼容 docker 命令）", "podman [选项] 子命令 [参数]", "需安装：apt install podman"],
  ["minikube", "在本机跑一个单节点 Kubernetes 集群", "minikube [选项] 子命令", "需安装：minikube 官方二进制"],
  ["kind", "用 Docker 容器当节点跑 K8s 集群", "kind [选项] 子命令", "需安装：kind 官方二进制"],
  ["ctr", "containerd 的底层命令行", "ctr [选项] 子命令 [参数]", "系统自带（containerd）"],
  ["lxc", "系统级容器（比 docker 更像轻量虚拟机）", "lxc [子命令] [参数]", "需安装：apt install lxc"],
  ["virsh", "管理 libvirt/KVM 虚拟机", "virsh [选项] 子命令 [域]", "需安装：apt install libvirt-clients"],
  // ── 版本控制 ───────────────────────────────────────────────────────────────
  ["svn", "Subversion 集中式版本控制", "svn 子命令 [参数]", "需安装：apt install subversion"],
  ["hg", "Mercurial 分布式版本控制", "hg 子命令 [参数]", "需安装：apt install mercurial"],
  // ── 安全与密钥 ─────────────────────────────────────────────────────────────
  ["ssh-add", "把私钥加入 ssh-agent（免重复输口令）", "ssh-add [选项] [私钥...]", "系统自带（openssh-client）"],
  ["ssh-agent", "SSH 密钥代理进程", 'ssh-agent [选项] / eval "$(ssh-agent -s)"', "系统自带（openssh-client）"],
  ["ssh-copy-id", "把本机公钥安装到远端 authorized_keys", "ssh-copy-id [-i 公钥] [用户@]主机", "系统自带（openssh-client）"],
  ["ssh-keyscan", "收集远端主机公钥（预填 known_hosts）", "ssh-keyscan [选项] 主机...", "系统自带（openssh-client）"],
  ["passwd", "修改账户口令", "passwd [选项] [用户]", "系统自带（passwd）"],
  ["usermod", "修改用户账户属性（组、家目录、shell）", "usermod [选项] 用户", "系统自带（passwd）"],
  ["useradd", "创建用户账户", "useradd [选项] 用户", "系统自带（passwd）"]
];
const MANUAL_REST = Object.fromEntries(
  ROWS.map(([name, purpose, usage, install]) => [
    name,
    manualFromRow(
      install === void 0 ? [purpose, usage] : [purpose, usage, install]
    )
  ])
);
const MANUAL_BY_NAME = new Map([
  ...Object.entries(MANUAL_REST),
  ...Object.entries(MANUAL_CORE)
]);
Object.keys(MANUAL_CORE).length;
MANUAL_BY_NAME.size;
function formatUserCorpusProblem(problem) {
  return `${problem.command}: ${problem.detail}`;
}
const isPlainObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
function isStringPair(row) {
  return Array.isArray(row) && row.length === 2 && typeof row[0] === "string" && typeof row[1] === "string";
}
function isOptionRow(row) {
  return Array.isArray(row) && (row.length === 2 || row.length === 3) && typeof row[0] === "string" && typeof row[1] === "string" && (row.length === 2 || typeof row[2] === "string");
}
function parseOptionRow(row) {
  const [name, description, arg] = row;
  if (arg === void 0 || arg.trim().length === 0) return { name, description };
  return { name, description, arg };
}
function parseUserCorpus(text) {
  const specs = /* @__PURE__ */ new Map();
  const indexEntries = /* @__PURE__ */ new Map();
  const problems = [];
  const fail2 = (command, detail) => {
    problems.push({ command, detail });
  };
  let root;
  try {
    root = JSON.parse(text);
  } catch (err) {
    fail2("<文件>", `不是合法 JSON：${err instanceof Error ? err.message : String(err)}`);
    return { specs, indexEntries, problems };
  }
  if (!isPlainObject(root)) {
    fail2("<文件>", "顶层必须是 JSON 对象（命令名 → 条目）");
    return { specs, indexEntries, problems };
  }
  for (const [name, raw] of Object.entries(root)) {
    if (!isSafeSpecName(name)) {
      fail2(name, "命令名不合法（只允许字母数字与 @._+-，且不含路径分隔符）");
      continue;
    }
    if (!isPlainObject(raw)) {
      fail2(name, "条目必须是对象（字段：brief / category / opts / subs / example / purpose / install / usage / examples / shortcuts）");
      continue;
    }
    const entry = raw;
    let invalid = false;
    const bad = (field, expect) => {
      invalid = true;
      fail2(name, `字段 ${field} ${expect}`);
    };
    let brief;
    if (entry.brief !== void 0) {
      if (typeof entry.brief !== "string") bad("brief", "必须是字符串");
      else brief = entry.brief;
    }
    let category;
    if (entry.category !== void 0) {
      if (typeof entry.category !== "string" || !COMMAND_CATEGORIES.includes(entry.category)) {
        bad("category", `必须是 ${COMMAND_CATEGORIES.join(" / ")} 之一`);
      } else {
        category = entry.category;
      }
    }
    let options;
    if (entry.opts !== void 0) {
      const optsError = "必须是数组，元素为 [选项, 说明] 或 [选项, 说明, 参数占位]";
      if (!Array.isArray(entry.opts)) {
        bad("opts", optsError);
      } else {
        const rows = [];
        let ok = true;
        for (const row of entry.opts) {
          if (!isOptionRow(row)) {
            bad("opts", optsError);
            ok = false;
            break;
          }
          rows.push(parseOptionRow(row));
        }
        if (ok) options = rows;
      }
    }
    let subcommands;
    if (entry.subs !== void 0) {
      const subsError = "必须是数组，元素为 [子命令, 说明]";
      if (!Array.isArray(entry.subs)) {
        bad("subs", subsError);
      } else {
        const rows = [];
        let ok = true;
        for (const row of entry.subs) {
          if (!isStringPair(row)) {
            bad("subs", subsError);
            ok = false;
            break;
          }
          rows.push({ name: row[0], description: row[1] });
        }
        if (ok) subcommands = rows;
      }
    }
    let example;
    if (entry.example !== void 0) {
      if (typeof entry.example !== "string") bad("example", "必须是字符串");
      else example = entry.example;
    }
    let purpose;
    if (entry.purpose !== void 0) {
      if (typeof entry.purpose !== "string") bad("purpose", "必须是字符串");
      else purpose = entry.purpose;
    }
    let install;
    if (entry.install !== void 0) {
      if (typeof entry.install !== "string") bad("install", "必须是字符串");
      else install = entry.install;
    }
    let usage;
    if (entry.usage !== void 0) {
      if (typeof entry.usage !== "string") bad("usage", "必须是字符串");
      else usage = entry.usage;
    }
    let examples;
    if (entry.examples !== void 0) {
      const examplesError = "必须是数组，元素为 [命令, 说明]";
      if (!Array.isArray(entry.examples)) {
        bad("examples", examplesError);
      } else {
        const rows = [];
        let ok = true;
        for (const row of entry.examples) {
          if (!isStringPair(row)) {
            bad("examples", examplesError);
            ok = false;
            break;
          }
          rows.push({ command: row[0], description: row[1] });
        }
        if (ok) examples = rows;
      }
    }
    let shortcuts;
    if (entry.shortcuts !== void 0) {
      const shortcutsError = "必须是数组，元素为 [按键, 说明]";
      if (!Array.isArray(entry.shortcuts)) {
        bad("shortcuts", shortcutsError);
      } else {
        const rows = [];
        let ok = true;
        for (const row of entry.shortcuts) {
          if (!isStringPair(row)) {
            bad("shortcuts", shortcutsError);
            ok = false;
            break;
          }
          rows.push({ key: row[0], description: row[1] });
        }
        if (ok) shortcuts = rows;
      }
    }
    if (invalid) continue;
    const spec = { name, options: options ?? [] };
    if (subcommands !== void 0 && subcommands.length > 0) spec.subcommands = subcommands;
    if (example !== void 0) spec.example = example;
    if (purpose !== void 0) spec.purpose = purpose;
    if (install !== void 0) spec.install = install;
    if (usage !== void 0) spec.usage = usage;
    if (examples !== void 0) spec.examples = examples;
    if (shortcuts !== void 0) spec.shortcuts = shortcuts;
    specs.set(name, spec);
    indexEntries.set(name, {
      ...brief !== void 0 ? { brief } : {},
      ...category !== void 0 ? { category } : {},
      ...subcommands !== void 0 ? { hasSubcommands: subcommands.length > 0 } : {}
    });
  }
  return { specs, indexEntries, problems };
}
function mergeIndexEntries(builtin, user) {
  if (user.size === 0) return [...builtin];
  const out = builtin.map((entry) => ({ ...entry }));
  const positions = new Map(out.map((entry, index2) => [entry.name, index2]));
  for (const [name, userEntry] of user) {
    const position = positions.get(name);
    if (position !== void 0) {
      const current = out[position];
      out[position] = {
        ...current,
        ...userEntry.brief !== void 0 ? { brief: userEntry.brief } : {},
        ...userEntry.category !== void 0 ? { category: userEntry.category } : {},
        ...userEntry.hasSubcommands !== void 0 ? { hasSubcommands: userEntry.hasSubcommands } : {}
      };
    } else {
      positions.set(name, out.length);
      const appended = {
        name,
        brief: userEntry.brief ?? "",
        category: userEntry.category ?? "system"
      };
      if (userEntry.hasSubcommands !== void 0) appended.hasSubcommands = userEntry.hasSubcommands;
      out.push(appended);
    }
  }
  return out;
}
async function loadUserCorpus(path, io) {
  let text;
  try {
    text = await io.readFile(path);
  } catch (err) {
    return { state: "error", detail: err instanceof Error ? err.message : String(err) };
  }
  if (text === null) return { state: "missing" };
  const parsed = parseUserCorpus(text);
  if (parsed.specs.size === 0 && parsed.problems.length > 0) {
    return { state: "invalid", problems: parsed.problems };
  }
  return {
    state: "ok",
    layer: { specs: parsed.specs, indexEntries: parsed.indexEntries },
    userCommands: parsed.specs.size,
    problems: parsed.problems
  };
}
class LruCache {
  constructor(maxSize) {
    this.maxSize = maxSize;
    this.entries = /* @__PURE__ */ new Map();
    this.evictions = 0;
    if (maxSize <= 0) throw new Error("LruCache 容量必须为正数");
  }
  get size() {
    return this.entries.size;
  }
  get evictionCount() {
    return this.evictions;
  }
  has(key2) {
    return this.entries.has(key2);
  }
  get(key2) {
    const value = this.entries.get(key2);
    if (value === void 0) return void 0;
    this.entries.delete(key2);
    this.entries.set(key2, value);
    return value;
  }
  set(key2, value) {
    if (this.entries.has(key2)) this.entries.delete(key2);
    this.entries.set(key2, value);
    while (this.entries.size > this.maxSize) {
      const oldest = this.entries.keys().next();
      if (oldest.done === true) break;
      this.entries.delete(oldest.value);
      this.evictions += 1;
    }
  }
  clear() {
    this.entries.clear();
  }
  /** 当前键（按最近使用从旧到新）——测试用 */
  keys() {
    return [...this.entries.keys()];
  }
}
class TrieNode {
  constructor() {
    this.children = /* @__PURE__ */ new Map();
    this.values = null;
  }
}
class PrefixIndex {
  constructor() {
    this.root = new TrieNode();
    this.count = 0;
  }
  get size() {
    return this.count;
  }
  insert(key2, value) {
    let node = this.root;
    for (const ch of key2.toLowerCase()) {
      let next = node.children.get(ch);
      if (next === void 0) {
        next = new TrieNode();
        node.children.set(ch, next);
      }
      node = next;
    }
    (node.values ??= []).push(value);
    this.count += 1;
  }
  /** 收集所有以 prefix 开头的值（大小写不敏感），最多 limit 个 */
  withPrefix(prefix, limit = Number.MAX_SAFE_INTEGER) {
    let node = this.root;
    for (const ch of prefix.toLowerCase()) {
      const next = node.children.get(ch);
      if (next === void 0) return [];
      node = next;
    }
    const out = [];
    this.collect(node, out, limit);
    return out;
  }
  collect(node, out, limit) {
    if (out.length >= limit) return;
    if (node.values) {
      for (const value of node.values) {
        if (out.length >= limit) return;
        out.push(value);
      }
    }
    for (const child of node.children.values()) {
      this.collect(child, out, limit);
      if (out.length >= limit) return;
    }
  }
}
function bundledSpecSource() {
  return {
    loadIndex: () => Promise.resolve(CATALOG),
    loadSpec: async (name) => {
      const entry = CATALOG_BY_NAME.get(name);
      if (entry === void 0) return null;
      const details = await CATEGORY_LOADERS[entry.category]();
      const rows = details[name];
      return rows === void 0 ? null : normalizeSpec(name, rows);
    },
    /**
     * 一次加载全部明细：只 import 用到的分类模块（同一分类复用同一个 module promise），
     * 因此 9 个分类模块最多各加载一次。
     */
    loadAllSpecs: async () => {
      const specs = [];
      for (const category of COMMAND_CATEGORIES) {
        const details = await CATEGORY_LOADERS[category]();
        for (const [name, rows] of Object.entries(details)) specs.push(normalizeSpec(name, rows));
      }
      return specs;
    }
  };
}
function buildMatchText(entry, spec) {
  const parts = [entry.name, entry.brief];
  if (spec.purpose !== void 0) parts.push(spec.purpose);
  if (spec.usage !== void 0) parts.push(spec.usage);
  for (const option of spec.options) {
    parts.push(option.name, option.description);
    if (option.arg !== void 0) parts.push(option.arg);
  }
  for (const sub of spec.subcommands ?? []) parts.push(sub.name, sub.description);
  for (const example of spec.examples ?? []) parts.push(example.command, example.description);
  return parts.join(" ").toLowerCase();
}
const DEFAULT_SPEC_CACHE_SIZE = 64;
const DEFAULT_NEGATIVE_TTL_MS = 3e4;
class CompletionCorpus {
  constructor(source, options = {}) {
    this.source = source;
    this.negativeUntil = /* @__PURE__ */ new Map();
    this.docsPromise = null;
    this.docsCache = [];
    this.indexPromise = null;
    this.cachedIndex = null;
    this.byName = null;
    this.prefix = null;
    this.userLayer = null;
    this.counters = {
      specLoads: 0,
      specCacheHits: 0,
      specCacheMisses: 0,
      negativeCacheHits: 0
    };
    this.specCache = new LruCache(
      options.specCacheSize ?? DEFAULT_SPEC_CACHE_SIZE
    );
    this.negativeTtlMs = options.negativeTtlMs ?? DEFAULT_NEGATIVE_TTL_MS;
    this.now = options.now ?? (() => Date.now());
  }
  /**
   * 设置/移除用户语料层（null = 移除）。
   *
   * 层一换，索引/spec/搜索文档的全部缓存作废：下次访问按新层重建。
   * 用户层条目**不经** LRU/负缓存——同名命令整体覆盖内置明细，重载以层为单位整体替换。
   */
  setUserLayer(layer) {
    this.userLayer = layer;
    this.specCache.clear();
    this.negativeUntil.clear();
    this.docsPromise = null;
    this.docsCache = [];
    this.cachedIndex = null;
    this.indexPromise = null;
    this.byName = null;
    this.prefix = null;
  }
  /** 索引（首屏唯一加载项），只读一次 */
  async index() {
    if (this.cachedIndex) return this.cachedIndex;
    this.indexPromise ??= this.source.loadIndex().then((entries) => {
      const merged = this.userLayer === null ? entries : mergeIndexEntries(entries, this.userLayer.indexEntries);
      this.cachedIndex = merged;
      this.byName = new Map(merged.map((e) => [e.name, e]));
      const trie = new PrefixIndex();
      for (const entry of merged) trie.insert(entry.name, entry);
      this.prefix = trie;
      return merged;
    });
    return this.indexPromise;
  }
  get indexLoaded() {
    return this.cachedIndex !== null;
  }
  /** 索引里的条目（需要先 await index()） */
  entry(name) {
    return this.byName?.get(name);
  }
  /** 前缀匹配命令名；索引未加载时返回空数组 */
  commandsWithPrefix(prefix, limit) {
    return this.prefix?.withPrefix(prefix, limit) ?? [];
  }
  /**
   * 命令手册/搜索索引（**首次使用时一次性构建，之后常驻**）。
   *
   * 代价与取舍（写清楚，不悄悄退化成"启动全加载"）：
   * - 搜索要扫用途/选项描述才能正确排序，因此这一步会把**全部明细**读进来
   *   （内置语料 9 个分类模块，实测见 search.test.ts 的耗时/规模断言）；
   * - 但它**不在启动路径**上：没有任何搜索/手册请求时，一个分类模块都不会被 import；
   * - 构建后常驻内存，后续搜索零额外加载。
   */
  async docs() {
    if (this.docsPromise === null) {
      this.docsPromise = this.buildDocs().then((docs) => {
        this.docsCache = docs;
        return docs;
      });
    }
    return this.docsPromise;
  }
  get docsBuilt() {
    return this.docsPromise !== null;
  }
  async buildDocs() {
    const entries = await this.index();
    const specs = this.source.loadAllSpecs ? await this.source.loadAllSpecs() : (await Promise.all(entries.map((e) => this.spec(e.name)))).filter(
      (s) => s !== null
    );
    const byName = new Map(specs.map((spec) => [spec.name, spec]));
    if (this.userLayer !== null) {
      for (const [name, userSpec] of this.userLayer.specs) byName.set(name, userSpec);
    }
    return entries.map((entry) => {
      const base = byName.get(entry.name);
      const merged = base === void 0 ? { name: entry.name, options: [] } : { ...base };
      if (this.userLayer?.specs.has(entry.name) !== true) {
        const manual = MANUAL_BY_NAME.get(entry.name);
        if (manual) applyManual(merged, manual);
      }
      const doc = {
        name: entry.name,
        brief: entry.brief,
        category: entry.category,
        categoryLabel: CATEGORY_LABELS[entry.category],
        options: merged.options,
        matchText: buildMatchText(entry, merged),
        matchPrimary: `${entry.name} ${entry.brief} ${merged.purpose ?? ""}`.toLowerCase()
      };
      if (merged.purpose !== void 0) doc.purpose = merged.purpose;
      if (merged.install !== void 0) doc.install = merged.install;
      if (merged.usage !== void 0) doc.usage = merged.usage;
      if (merged.examples !== void 0) doc.examples = merged.examples;
      if (merged.shortcuts !== void 0) doc.shortcuts = merged.shortcuts;
      if (merged.subcommands !== void 0 && merged.subcommands.length > 0) {
        doc.subcommands = merged.subcommands;
      }
      return doc;
    });
  }
  /** 单条命令详情：用户层（同名覆盖） → LRU → 负缓存 → 源加载 */
  async spec(name) {
    const userSpec = this.userLayer?.specs.get(name);
    if (userSpec !== void 0) return userSpec;
    const cached2 = this.specCache.get(name);
    if (cached2 !== void 0) {
      this.counters.specCacheHits += 1;
      return cached2;
    }
    this.counters.specCacheMisses += 1;
    const until = this.negativeUntil.get(name);
    if (until !== void 0) {
      if (until > this.now()) {
        this.counters.negativeCacheHits += 1;
        return null;
      }
      this.negativeUntil.delete(name);
    }
    this.counters.specLoads += 1;
    const spec = await this.source.loadSpec(name);
    if (spec === null) {
      if (this.negativeTtlMs > 0) this.negativeUntil.set(name, this.now() + this.negativeTtlMs);
      return null;
    }
    this.specCache.set(name, spec);
    return spec;
  }
  /** 清空缓存（用户更新语料后调用） */
  clearCache() {
    this.specCache.clear();
    this.negativeUntil.clear();
  }
  stats() {
    return {
      indexLoaded: this.cachedIndex !== null,
      indexSize: this.cachedIndex?.length ?? 0,
      specLoads: this.counters.specLoads,
      specCacheHits: this.counters.specCacheHits,
      specCacheMisses: this.counters.specCacheMisses,
      negativeCacheHits: this.counters.negativeCacheHits,
      evictions: this.specCache.evictionCount,
      cacheSize: this.specCache.size,
      docsBuilt: this.docsPromise !== null,
      docsSize: this.docsCache.length
    };
  }
}
const SEARCH_DEFAULT_LIMIT = 20;
const SEARCH_MAX_LIMIT = 100;
const SEARCH_SCORES = {
  exact: 1e3,
  prefix: 800,
  contains: 600,
  text: 400
};
function scoreDoc(doc, query) {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return null;
  const name = doc.name.toLowerCase();
  if (name === q) return { kind: "exact", score: SEARCH_SCORES.exact };
  if (name.startsWith(q)) return { kind: "prefix", score: SEARCH_SCORES.prefix - name.length };
  if (name.includes(q)) return { kind: "contains", score: SEARCH_SCORES.contains - name.length };
  if (doc.matchText.includes(q)) {
    const bonus = doc.matchPrimary.includes(q) ? 30 : 10;
    return { kind: "text", score: SEARCH_SCORES.text - name.length + bonus };
  }
  return null;
}
function searchCommands(docs, query, limit = SEARCH_DEFAULT_LIMIT) {
  const trimmed = query.trim();
  const capped = clampLimit(limit);
  if (trimmed.length === 0) return { query: trimmed, results: [], truncated: false };
  const scored = [];
  for (const doc of docs) {
    const match = scoreDoc(doc, trimmed);
    if (match !== null) scored.push({ doc, ...match });
  }
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.doc.name.length !== b.doc.name.length) return a.doc.name.length - b.doc.name.length;
    return a.doc.name.localeCompare(b.doc.name);
  });
  return {
    query: trimmed,
    results: scored.slice(0, capped).map((entry) => toSearchItem(entry.doc)),
    truncated: scored.length > capped
  };
}
function toSearchItem(doc) {
  const item = { name: doc.name };
  const summary = doc.purpose ?? doc.brief;
  if (summary !== "") item.summary = summary;
  item.category = doc.categoryLabel;
  if (doc.install !== void 0 && doc.install !== "") item.install = doc.install;
  if (doc.usage !== void 0 && doc.usage !== "") item.usage = doc.usage;
  if (doc.options.length > 0) {
    item.options = doc.options.map(
      (option) => option.arg === void 0 || option.arg === "" ? { name: option.name, description: option.description } : { name: option.name, description: option.description, arg: option.arg }
    );
  }
  if (doc.subcommands !== void 0 && doc.subcommands.length > 0) {
    item.subcommands = doc.subcommands.map((sub) => ({
      name: sub.name,
      description: sub.description
    }));
  }
  if (doc.examples !== void 0 && doc.examples.length > 0) {
    item.examples = doc.examples.map((example) => ({
      command: example.command,
      description: example.description
    }));
  }
  if (doc.shortcuts !== void 0 && doc.shortcuts.length > 0) {
    item.shortcuts = doc.shortcuts.map((shortcut) => ({
      key: shortcut.key,
      description: shortcut.description
    }));
  }
  return item;
}
function clampLimit(limit) {
  if (!Number.isFinite(limit)) return SEARCH_DEFAULT_LIMIT;
  return Math.min(SEARCH_MAX_LIMIT, Math.max(1, Math.trunc(limit)));
}
function createAiSuggestionProvider(suggester) {
  return {
    suggest: async (input, limit) => {
      const items = await suggester.suggestCommands(
        { query: input.query, context: input.context },
        limit
      );
      return items.filter((item) => typeof item.command === "string" && item.command.trim().length > 0).slice(0, Math.max(0, limit)).map((item, index2) => ({
        value: item.command.trim(),
        ...item.description === void 0 ? {} : { description: item.description },
        kind: "ai",
        // 保持 AI 给出的顺序（分越高越靠前）
        score: 900 - index2,
        matchKind: "exact"
      }));
    }
  };
}
const DEFAULT_COMPLETION_SETTINGS = {
  enabled: true,
  specCompletion: true,
  historyCompletion: true,
  // 脚本生成式补全默认关闭（Beta，会起后台进程）
  generatorCompletion: false,
  aiSuggestion: true,
  debounceMs: 120,
  maxSuggestions: 20
};
const KIND_ICONS = {
  command: "📀",
  subcommand: "📦",
  option: "🔗",
  history: "🕘",
  directory: "📁"
};
const COMMAND_SEPARATORS = /* @__PURE__ */ new Set(["|", "||", "&&", ";", "&", "(", "\n"]);
const REDIRECTIONS = /* @__PURE__ */ new Set([">", ">>", "<", "<<", "2>", "2>>", "&>"]);
/* @__PURE__ */ new Set([...COMMAND_SEPARATORS, ...REDIRECTIONS, ")"]);
const WHITESPACE = /[ \t]/;
const DELIMITERS = /[ \t|;&()<>]/;
function isEnvAssignment(token) {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(token);
}
function parseCommandLine(line, cursor) {
  const limit = cursor === void 0 ? line.length : Math.max(0, Math.min(cursor, line.length));
  const before = line.slice(0, limit);
  const after = line.slice(limit);
  const tokens = [];
  const usedOptions = [];
  let current = "";
  let tokenStart = -1;
  let quote = null;
  let quoteStart = -1;
  let nextIsCommand = true;
  let command = null;
  let argIndex = 0;
  const commit = () => {
    if (current.length === 0) {
      tokenStart = -1;
      return;
    }
    const value = current;
    tokens.push(value);
    if (value.startsWith("-") && value.length > 1) usedOptions.push(value);
    if (nextIsCommand) {
      if (!isEnvAssignment(value)) {
        command = value;
        nextIsCommand = false;
      }
    } else if (!value.startsWith("-")) {
      argIndex += 1;
    }
    current = "";
    tokenStart = -1;
  };
  let i = 0;
  while (i < before.length) {
    const ch = before[i];
    if (quote !== null) {
      if (ch === "\\" && quote === '"' && i + 1 < before.length) {
        current += before[i + 1];
        i += 2;
        continue;
      }
      if (ch === quote) {
        quote = null;
        i += 1;
        continue;
      }
      current += ch;
      i += 1;
      continue;
    }
    if (ch === "'" || ch === '"') {
      if (current.length === 0) tokenStart = i;
      quote = ch;
      quoteStart = i;
      i += 1;
      continue;
    }
    if (ch === "\\" && i + 1 < before.length) {
      if (current.length === 0) tokenStart = i;
      current += before[i + 1];
      i += 2;
      continue;
    }
    if (WHITESPACE.test(ch)) {
      commit();
      i += 1;
      continue;
    }
    if (DELIMITERS.test(ch)) {
      commit();
      let op = ch;
      const two = before.slice(i, i + 2);
      const three = before.slice(i, i + 3);
      if (three === "2>>" || three === "&>>") op = three;
      else if (two === "||" || two === "&&" || two === ">>" || two === "<<" || two === "2>" || two === "&>") op = two;
      tokens.push(op);
      i += op.length;
      if (COMMAND_SEPARATORS.has(op)) {
        nextIsCommand = true;
        command = null;
        argIndex = 0;
      } else {
        nextIsCommand = false;
      }
      continue;
    }
    if (current.length === 0) tokenStart = i;
    current += ch;
    i += 1;
  }
  const atCommandPosition = nextIsCommand;
  const inQuote = quote !== null;
  const effectiveTokenStart = inQuote ? quoteStart + 1 : tokenStart < 0 ? before.length : tokenStart;
  let replaceEnd = limit;
  while (replaceEnd < line.length) {
    const ch = line[replaceEnd];
    if (DELIMITERS.test(ch)) break;
    replaceEnd += 1;
  }
  const expecting = atCommandPosition ? "command" : current.startsWith("-") ? "option" : "argument";
  return {
    before,
    after,
    token: current,
    tokenStart: effectiveTokenStart,
    replaceEnd,
    tokens,
    quote: inQuote ? quote : null,
    atCommandPosition,
    command: atCommandPosition ? null : command,
    argIndex,
    expecting,
    usedOptions,
    aiPrefix: detectAiSuggestion(before)
  };
}
function isSubsequence(token, target) {
  if (token.length === 0) return true;
  let ti = 0;
  for (let i = 0; i < target.length && ti < token.length; i++) {
    if (target[i] === token[ti]) ti += 1;
  }
  return ti === token.length;
}
function matchCandidate(target, token) {
  if (token.length === 0) return { matchKind: "prefix", score: 800 };
  const lowerTarget = target.toLowerCase();
  const lowerToken = token.toLowerCase();
  if (lowerTarget === lowerToken) return { matchKind: "exact", score: 1e3 };
  if (lowerTarget.startsWith(lowerToken)) {
    return { matchKind: "prefix", score: 800 - Math.min(200, target.length) };
  }
  if (lowerToken.length >= 2 && isSubsequence(lowerToken, lowerTarget)) {
    return { matchKind: "fuzzy", score: 300 - Math.min(200, target.length) };
  }
  return null;
}
function sortCandidates(candidates2) {
  return candidates2.map((candidate, index2) => ({ candidate, index: index2 })).sort((a, b) => {
    if (b.candidate.score !== a.candidate.score) return b.candidate.score - a.candidate.score;
    const av = a.candidate.value;
    const bv = b.candidate.value;
    if (av.length !== bv.length) return av.length - bv.length;
    const byValue = av.localeCompare(bv);
    if (byValue !== 0) return byValue;
    return a.index - b.index;
  }).map(({ candidate }) => candidate);
}
function dedupeCandidates(candidates2) {
  const best = /* @__PURE__ */ new Map();
  for (const candidate of candidates2) {
    if (candidate.value.length === 0) continue;
    const existing = best.get(candidate.value);
    if (existing === void 0 || candidate.score > existing.score) {
      best.set(candidate.value, candidate);
    }
  }
  return [...best.values()];
}
const FUZZY_SCAN_LIMIT = 2e4;
function buildPopularity(history) {
  const counts = /* @__PURE__ */ new Map();
  for (const raw of history) {
    const entry = typeof raw === "string" ? { line: raw } : raw;
    let command;
    for (const part of entry.line.trim().split(/\s+/)) {
      if (part.length === 0 || isEnvAssignment(part)) continue;
      command = part;
      break;
    }
    if (command === void 0) continue;
    counts.set(command, (counts.get(command) ?? 0) + (entry.count ?? 1));
  }
  return counts;
}
class CompletionEngine {
  constructor(options) {
    this.options = options;
    this.popularity = /* @__PURE__ */ new Map();
    this.settings = { ...DEFAULT_COMPLETION_SETTINGS, ...options.settings };
    this.generators = options.generators ?? [];
  }
  getSettings() {
    return { ...this.settings };
  }
  /** 局部更新设置（setSettings 用） */
  setSettings(patch) {
    this.settings = { ...this.settings, ...patch };
    return this.getSettings();
  }
  get corpus() {
    return this.options.corpus;
  }
  refreshPopularity(history) {
    const counts = buildPopularity(history);
    if (this.options.popularity) {
      for (const [name, weight] of this.options.popularity) {
        counts.set(name, (counts.get(name) ?? 0) + weight);
      }
    }
    this.popularity = counts;
  }
  /** 语料索引（listSpecs 用） */
  async listSpecs() {
    return this.options.corpus.index();
  }
  /**
   * 命令搜索 / 离线命令手册（spec 验收标准第 8 条）。
   *
   * 索引由 corpus 在**首次搜索时一次性构建**并常驻（不在启动路径上）；
   * 没有搜索/手册请求时，一个明细分类模块都不会被 import。
   */
  async search(query, limit) {
    const trimmed = query.trim();
    if (trimmed.length === 0) return { query: trimmed, results: [], truncated: false };
    const docs = await this.options.corpus.docs();
    return searchCommands(docs, trimmed, limit);
  }
  /** 搜索索引是否已构建（自检与测试用） */
  get searchIndexBuilt() {
    return this.options.corpus.docsBuilt;
  }
  async complete(request) {
    const started = performance.now();
    const context = parseCommandLine(request.line, request.cursor);
    if (this.options.settingsProvider) {
      try {
        this.settings = { ...this.settings, ...this.options.settingsProvider() };
      } catch {
      }
      try {
        await this.options.onSettingsRefreshed?.();
      } catch {
      }
    }
    const limit = request.limit ?? this.settings.maxSuggestions;
    const cwd = request.cwd ?? "/";
    const notes = [];
    if (!this.settings.enabled) {
      return this.buildResult([], context, started, null, false, ["补全总开关已关闭"]);
    }
    if (request.history) this.refreshPopularity(request.history);
    const wantsAi = request.aiPrefix === true || context.aiPrefix === true;
    let aiTurnedOff = false;
    if (wantsAi && request.aiPrefix !== false) {
      if (!this.settings.aiSuggestion) {
        notes.push("「AI 建议（??）」已在「设置 > 补全」里关闭，本次按普通补全处理");
        aiTurnedOff = true;
      } else {
        const provider = this.options.aiProvider;
        const query = stripAiMarker(context.before);
        if (!provider) {
          const note = "AI 建议需要先配置 AI 供应商：请打开「设置 > AI 助手」，选择供应商并填写 API Key 后重试";
          notes.push(note);
          const info = this.noteCandidate(context, "AI 建议不可用", note);
          return this.buildResult(info === null ? [] : [info], context, started, null, true, notes);
        }
        try {
          const aiCandidates = await provider.suggest({ query, line: query, context }, limit);
          const usable = aiCandidates.filter((c) => (c.value ?? "").trim().length > 0);
          if (usable.length === 0) {
            const note = "AI 没有返回可用的命令建议：可换个说法再试";
            notes.push(note);
            const info = this.noteCandidate(context, "AI 没有给出建议", note);
            return this.buildResult(
              info === null ? [] : [info],
              context,
              started,
              null,
              true,
              notes
            );
          }
          return this.buildResult(usable, context, started, null, true, notes);
        } catch (err) {
          const note = err instanceof Error ? err.message : String(err);
          notes.push(note);
          const info = this.noteCandidate(context, "AI 建议请求失败", note);
          return this.buildResult(info === null ? [] : [info], context, started, null, true, notes);
        }
      }
    }
    const collected = [];
    let specName = null;
    if (this.settings.specCompletion) {
      if (context.atCommandPosition) {
        collected.push(...await this.commandCandidates(context, limit));
      } else if (context.command) {
        await this.options.corpus.index();
        const entry = this.options.corpus.entry(context.command);
        if (entry) {
          specName = entry.name;
          const spec = await this.options.corpus.spec(entry.name);
          if (spec) collected.push(...this.specCandidates(context, spec, limit));
        }
      }
    }
    if (this.settings.historyCompletion && request.history) {
      collected.push(...this.historyCandidates(context, request.history, limit));
    }
    if (this.settings.generatorCompletion) {
      for (const generator of this.generators) {
        if (!generator.applies(context)) continue;
        collected.push(...await generator.generate(context, { limit, cwd }));
      }
    }
    const candidates2 = sortCandidates(dedupeCandidates(collected)).slice(0, Math.max(0, limit));
    let finalCandidates = candidates2;
    if (aiTurnedOff && finalCandidates.length === 0) {
      const info = this.noteCandidate(
        context,
        "AI 建议未生效",
        "「AI 建议（??）」已在「设置 > 补全」里关闭，本次按普通补全处理；没有找到匹配的命令"
      );
      if (info !== null) finalCandidates = [...finalCandidates, info];
    }
    return this.buildResult(finalCandidates, context, started, specName, false, notes);
  }
  // ── 命令名 ──────────────────────────────────────────────────────────────
  async commandCandidates(context, limit) {
    const corpus = this.options.corpus;
    const index2 = await corpus.index();
    const token = context.token;
    const prefixEntries = corpus.commandsWithPrefix(token, limit * 4);
    let entries = prefixEntries;
    if (token.length >= 2 && index2.length <= FUZZY_SCAN_LIMIT) {
      const known = new Set(prefixEntries.map((e) => e.name));
      const lower = token.toLowerCase();
      const fuzzy = [];
      for (const candidate of index2) {
        if (known.has(candidate.name)) continue;
        if (isSubsequence(lower, candidate.name.toLowerCase())) {
          fuzzy.push(candidate);
          if (fuzzy.length >= limit * 2) break;
        }
      }
      if (fuzzy.length > 0) entries = [...prefixEntries, ...fuzzy];
    }
    const popularity = this.popularity;
    const out = [];
    for (const entry of entries) {
      const match = matchCandidate(entry.name, token);
      if (!match) continue;
      const boost = popularity.get(entry.name) ?? 0;
      out.push({
        value: entry.name,
        description: entry.brief,
        kind: "command",
        icon: KIND_ICONS.command,
        score: match.score + Math.min(100, boost * 5),
        matchKind: match.matchKind
      });
    }
    return out.slice(0, limit * 4);
  }
  // ── 子命令 / 选项 ───────────────────────────────────────────────────────
  specCandidates(context, spec, limit) {
    const out = [];
    const token = context.token;
    const wantsOption = context.expecting === "option";
    const offerSubcommands = !wantsOption && context.argIndex === 0 && (spec.subcommands?.length ?? 0) > 0;
    if (offerSubcommands) {
      for (const sub of spec.subcommands ?? []) {
        const match = matchCandidate(sub.name, token);
        if (!match) continue;
        out.push({
          value: sub.name,
          description: sub.description,
          kind: "subcommand",
          icon: KIND_ICONS.subcommand,
          score: match.score,
          matchKind: match.matchKind
        });
      }
    }
    if (wantsOption || token.length === 0) {
      const used = new Set(context.usedOptions);
      for (const option of spec.options) {
        if (used.has(option.name)) continue;
        const match = matchCandidate(option.name, token);
        if (!match) continue;
        out.push({
          value: option.name,
          description: option.arg === void 0 ? option.description : `${option.description} <${option.arg}>`,
          kind: "option",
          icon: KIND_ICONS.option,
          score: match.score - 50,
          // 选项略低于同名子命令
          matchKind: match.matchKind
        });
      }
    }
    return out.slice(0, limit * 4);
  }
  // ── 历史 ────────────────────────────────────────────────────────────────
  historyCandidates(context, history, limit) {
    const prefix = context.before.replace(/^\s+/, "");
    if (prefix.length === 0) return [];
    const lowerPrefix = prefix.toLowerCase();
    const out = [];
    for (let i = 0; i < history.length; i++) {
      const raw = history[i];
      if (raw === void 0) continue;
      const entry = typeof raw === "string" ? { line: raw } : raw;
      const line = entry.line.trim();
      if (line.length === 0) continue;
      if (!line.toLowerCase().startsWith(lowerPrefix)) continue;
      if (line === prefix) continue;
      const count = entry.count ?? 1;
      out.push({
        value: line,
        label: line,
        description: `历史命令 · 使用 ${count} 次`,
        kind: "history",
        icon: KIND_ICONS.history,
        // 频次主导排序（同频时越靠前越新）
        score: 500 + Math.min(400, count * 20) - Math.min(40, i),
        matchKind: "prefix"
      });
      if (out.length >= limit * 4) break;
    }
    return out;
  }
  /**
   * 造一条"纯提示"候选。
   *
   * 为什么需要：现有界面**只在有候选时**弹层。若失败时只往 `notes` 写一句说明，
   * 用户什么都看不到（等于静默）。所以补一条候选把说明带出来。
   *
   * `value` 取**原样 token** —— 接受它等于不改动命令行，是个安全的"无操作"候选。
   */
  noteCandidate(context, title, note) {
    const start = context.tokenStart >= 0 ? context.tokenStart : context.replaceEnd;
    const end = Math.max(start, context.replaceEnd);
    const original = context.before.slice(start, end);
    return {
      value: original,
      label: title,
      description: note,
      kind: "ai",
      score: 0,
      matchKind: "exact"
    };
  }
  buildResult(candidates2, context, startedAt, specName, aiRequested, notes) {
    const result = {
      candidates: [...candidates2],
      context,
      elapsedMs: performance.now() - startedAt,
      specName,
      debounceMs: this.settings.debounceMs,
      aiRequested
    };
    if (notes.length > 0) result.notes = [...notes];
    return result;
  }
}
function createDirectoryGenerator(io) {
  return {
    name: "directory",
    applies: (context) => context.command === "cd" && !context.token.startsWith("-"),
    generate: (context, request) => {
      const limit = request.limit;
      const token = context.token;
      const slash = token.lastIndexOf("/");
      const dirPart = slash >= 0 ? token.slice(0, slash + 1) : "";
      const namePart = slash >= 0 ? token.slice(slash + 1) : token;
      const baseDir = dirPart.length === 0 ? request.cwd : resolvePath(request.cwd, dirPart);
      const entries = io.listDir(baseDir);
      if (entries === null) return Promise.resolve([]);
      const out = [];
      for (const entry of entries) {
        const full = dirPart.length === 0 ? entry : `${dirPart}${entry}`;
        const match = matchCandidate(entry, namePart);
        if (!match) continue;
        const path = resolvePath(request.cwd, full);
        if (!io.isDir(path)) continue;
        out.push({
          value: `${full}/`,
          description: "目录",
          kind: "directory",
          icon: KIND_ICONS.directory,
          score: match.score,
          matchKind: match.matchKind
        });
        if (out.length >= limit) break;
      }
      return Promise.resolve(out);
    }
  };
}
function resolvePath(cwd, target) {
  if (target.startsWith("/")) return normalizeSlashes(target);
  const base = cwd.endsWith("/") ? cwd.slice(0, -1) : cwd;
  return normalizeSlashes(`${base}/${target}`);
}
function normalizeSlashes(path) {
  return path.replace(/\/{2,}/g, "/");
}
let engine = null;
let activeCtx = null;
let aiProvider = null;
let settingsReader = null;
function configureCompletionAi(provider) {
  aiProvider = provider;
  engine = null;
}
function configureCompletionSettings(reader) {
  settingsReader = reader;
  engine = null;
}
function getEngine(ctx) {
  activeCtx = ctx;
  if (engine) return engine;
  const corpus = new CompletionCorpus(bundledSpecSource(), {
    specCacheSize: DEFAULT_SPEC_CACHE_SIZE,
    negativeTtlMs: DEFAULT_NEGATIVE_TTL_MS
  });
  activeCorpus = corpus;
  appliedCorpusFile = void 0;
  engine = new CompletionEngine({
    corpus,
    // AI 建议通道（未注入时为 null → 引擎会给出"请去设置填 API Key"的可操作提示）
    ...aiProvider === null ? {} : { aiProvider },
    ...settingsReader === null ? {} : { settingsProvider: settingsReader },
    // 设置变更钩子：completion.corpusFile 改动后的下一次 complete 自动重载用户语料
    onSettingsRefreshed: () => syncUserCorpus(),
    // 「脚本生成式补全（Beta）」：cd 的目录候选，默认关闭（见 CompletionSettings）
    generators: [
      createDirectoryGenerator({
        listDir: (path) => {
          try {
            return readdirSync(path);
          } catch {
            return null;
          }
        },
        isDir: (path) => {
          try {
            return statSync(path).isDirectory();
          } catch {
            return false;
          }
        }
      })
    ]
  });
  return engine;
}
const realUserCorpusIo = {
  readFile: async (path) => {
    try {
      return await readFile(path, "utf8");
    } catch (err) {
      if (err?.code === "ENOENT") return null;
      throw err;
    }
  }
};
let activeCorpus = null;
let appliedCorpusFile = void 0;
function corpusFilePathFromSettings() {
  if (settingsReader === null) return null;
  try {
    const raw = settingsReader().corpusFile;
    if (typeof raw !== "string") return null;
    const trimmed = raw.trim();
    return trimmed.length === 0 ? null : trimmed;
  } catch {
    return null;
  }
}
async function applyUserCorpus(corpus, path) {
  if (path === null) {
    corpus.setUserLayer(null);
    return;
  }
  const result = await loadUserCorpus(path, realUserCorpusIo);
  switch (result.state) {
    case "ok": {
      corpus.setUserLayer(result.layer);
      ({
        state: "ok",
        path,
        userCommands: result.userCommands,
        ...result.problems.length > 0 ? { problems: result.problems.map(formatUserCorpusProblem) } : {}
      });
      activeCtx?.logger.info(
        `用户补全语料已加载：${result.userCommands} 条命令（${path}）` + (result.problems.length > 0 ? `；丢弃 ${result.problems.length} 条非法条目` : "")
      );
      break;
    }
    case "missing":
      corpus.setUserLayer(null);
      activeCtx?.logger.warn(`补全语料文件不存在：${path}（已降级为仅内置语料）`);
      break;
    case "invalid": {
      corpus.setUserLayer(null);
      const problems = result.problems.map(formatUserCorpusProblem);
      activeCtx?.logger.warn(`补全语料文件非法：${path}（已降级为仅内置语料）— ${problems.join("；")}`);
      break;
    }
    case "error":
      corpus.setUserLayer(null);
      ({ state: "error", path, detail: result.detail });
      activeCtx?.logger.warn(`补全语料文件读取失败：${path}（${result.detail}；已降级为仅内置语料）`);
      break;
  }
}
async function syncUserCorpus() {
  const path = corpusFilePathFromSettings();
  if (appliedCorpusFile === path) return;
  const corpus = activeCorpus;
  if (corpus === null) return;
  appliedCorpusFile = path;
  try {
    await applyUserCorpus(corpus, path);
  } catch (err) {
    ({
      state: "error",
      path,
      detail: err instanceof Error ? err.message : String(err)
    });
  }
}
const historyEntrySchema = z.union([
  z.string(),
  z.object({
    line: z.string(),
    count: z.number().int().min(1).optional()
  })
]);
const completeSchema = z.object({
  line: z.string(),
  /** 渲染层置位的"本次是 `??` AI 请求"信号（主进程自己也会从行文本识别） */
  aiPrefix: z.boolean().optional(),
  cursor: z.number().int().min(0).optional(),
  history: z.array(historyEntrySchema).max(5e3).optional(),
  limit: z.number().int().min(1).max(200).optional(),
  cwd: z.string().optional()
});
const searchSchema = z.object({
  query: z.string(),
  limit: z.number().int().min(1).max(100).optional()
});
const settingsPatchSchema = z.object({
  enabled: z.boolean().optional(),
  specCompletion: z.boolean().optional(),
  historyCompletion: z.boolean().optional(),
  generatorCompletion: z.boolean().optional(),
  aiSuggestion: z.boolean().optional(),
  debounceMs: z.number().int().min(0).max(5e3).optional(),
  maxSuggestions: z.number().int().min(1).max(200).optional()
});
const completionHandlers = {
  /** 计算补全候选 */
  complete: async (payload, ctx) => {
    const request = completeSchema.parse(payload ?? {});
    return getEngine(ctx).complete(request);
  },
  settings: (_payload, ctx) => {
    const current = getEngine(ctx).getSettings();
    return current;
  },
  /** 局部更新设置（只覆盖传了的字段） */
  setSettings: (payload, ctx) => {
    const patch = settingsPatchSchema.parse(payload ?? {});
    return getEngine(ctx).setSettings(patch);
  },
  /** 语料索引（命令名 + 简述），供设置页/文档展示 */
  listSpecs: async (_payload, ctx) => {
    await syncUserCorpus();
    const entries = await getEngine(ctx).listSpecs();
    return { total: entries.length, entries };
  },
  /**
   * 命令搜索：输入命令名/用途关键词，返回候选 + 手册字段（用途/安装/语法/参数/示例/快捷键）。
   * 只提供参考，不向终端发送任何内容。
   */
  search: async (payload, ctx) => {
    const { query, limit } = searchSchema.parse(payload ?? {});
    await syncUserCorpus();
    return getEngine(ctx).search(query, limit);
  }
};
const index$3 = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  completionHandlers,
  configureCompletionAi,
  configureCompletionSettings,
  syncUserCorpus
}, Symbol.toStringTag, { value: "Module" }));
const MAX_COMMAND_BLOCKS = 500;
const DEFAULT_BLOCK_LIMIT = 50;
const MAX_BLOCK_LIMIT = 500;
const KINDS = /* @__PURE__ */ new Set(["A", "B", "C", "D", "P"]);
function parseOsc133(payload) {
  const parts = payload.split(";");
  if (parts[0] !== "133") return null;
  const kind = parts[1];
  if (kind === void 0 || !KINDS.has(kind)) return null;
  if (kind === "D") {
    const raw = parts[2];
    if (raw === void 0 || raw === "") return { kind: "D", exitCode: null };
    const code = Number.parseInt(raw, 10);
    return { kind: "D", exitCode: Number.isFinite(code) ? code : null };
  }
  return { kind };
}
const states$1 = /* @__PURE__ */ new Map();
function stateFor$1(sessionId) {
  let s = states$1.get(sessionId);
  if (!s) {
    s = {
      blocks: [],
      nextId: 1,
      total: 0,
      open: null,
      sawOsc133: false,
      sawData: false,
      lastActivityAt: 0
    };
    states$1.set(sessionId, s);
  }
  return s;
}
function applyBackspaces(text) {
  let out = "";
  for (const ch of text) {
    if (ch === "" || ch === "\b") out = out.slice(0, -1);
    else out += ch;
  }
  return out;
}
function cleanCommandLine(raw) {
  return (applyBackspaces(raw).replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g, "").replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\x1b[@-Z\\-_]/g, "").replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "").replace(/\r/g, "").split("\n").map((line) => line.trim()).filter((line) => line.length > 0).pop() ?? "").trim();
}
function applyOsc133(sessionId, parsed, emit, now = Date.now()) {
  const s = stateFor$1(sessionId);
  s.sawOsc133 = true;
  s.lastActivityAt = now;
  const open = s.open;
  switch (parsed.kind) {
    case "A": {
      if (open !== null && open.started) finalize(sessionId, s, open, null, emit, now);
      s.open = null;
      return;
    }
    case "B": {
      if (s.open === null) {
        s.open = { id: s.nextId++, started: false, input: "" };
      }
      s.open.submittedAt = now;
      s.open.input = "";
      return;
    }
    case "C": {
      const target = s.open ?? { id: s.nextId++, started: false, input: "" };
      s.open = target;
      target.outputStart = now;
      if (!target.started) {
        target.started = true;
        target.startedAt = now;
        emit?.({
          type: "start",
          sessionId,
          blockId: target.id,
          ...cleanCommandLine(target.input) === "" ? {} : { commandLine: cleanCommandLine(target.input) },
          startedAt: now
        });
      }
      return;
    }
    case "D": {
      const target = s.open ?? { id: s.nextId++, started: false, input: "" };
      s.open = null;
      if (!target.started) {
        target.started = true;
        target.startedAt = now;
        emit?.({
          type: "start",
          sessionId,
          blockId: target.id,
          ...cleanCommandLine(target.input) === "" ? {} : { commandLine: cleanCommandLine(target.input) },
          startedAt: now
        });
      }
      finalize(sessionId, s, target, parsed.exitCode ?? null, emit, now);
      return;
    }
    case "P":
      return;
  }
}
function finalize(sessionId, s, open, exitCode, emit, now) {
  const commandLine = cleanCommandLine(open.input);
  const block = {
    id: open.id,
    startedAt: open.startedAt ?? now,
    ...open.submittedAt === void 0 ? {} : { submittedAt: open.submittedAt },
    ...open.outputStart === void 0 ? {} : { outputStart: open.outputStart },
    ...commandLine === "" ? {} : { commandLine },
    exitCode,
    endedAt: now
  };
  s.blocks.push(block);
  s.total += 1;
  if (s.blocks.length > MAX_COMMAND_BLOCKS) {
    s.blocks.splice(0, s.blocks.length - MAX_COMMAND_BLOCKS);
  }
  emit?.({
    type: "end",
    sessionId,
    blockId: block.id,
    exitCode,
    ...block.commandLine === void 0 ? {} : { commandLine: block.commandLine },
    startedAt: block.startedAt,
    endedAt: now,
    durationMs: Math.max(0, now - block.startedAt)
  });
}
function feedPlainText(sessionId, text, now = Date.now()) {
  const s = stateFor$1(sessionId);
  s.sawData = true;
  s.lastActivityAt = now;
  if (s.open !== null && s.open.started === false && s.open.submittedAt !== void 0) {
    const room = 4096 - s.open.input.length;
    if (room > 0) s.open.input += text.slice(0, room);
  }
}
function markSessionData(sessionId, now = Date.now()) {
  const s = stateFor$1(sessionId);
  s.sawData = true;
  s.lastActivityAt = now;
}
function shellIntegrationReason(state) {
  if (state === void 0 || !state.sawData) {
    return "这个会话还没有输出，暂时读不到命令块；先执行一条命令再试";
  }
  if (!state.sawOsc133) {
    return '该会话的 shell 没有发送 OSC 133（Shell Integration 未启用），因此读不到命令块与退出码。zsh / fish 的常见配置自带；bash 需要在 PROMPT_COMMAND 里输出 OSC 133 序列。可手动验证：printf "\\033]133;D;0\\007"';
  }
  return "Shell Integration 已启用，但本会话还没有跑完任何命令";
}
function listCommandBlocks(sessionId, limit = DEFAULT_BLOCK_LIMIT) {
  const state = states$1.get(sessionId);
  const capped = Math.min(MAX_BLOCK_LIMIT, Math.max(1, Math.trunc(limit) || DEFAULT_BLOCK_LIMIT));
  if (state === void 0) {
    return {
      sessionId,
      blocks: [],
      total: 0,
      truncated: false,
      shellIntegration: false,
      reason: shellIntegrationReason(void 0)
    };
  }
  const all = state.blocks;
  const start = Math.max(0, all.length - capped);
  const blocks = all.slice(start);
  const result = {
    sessionId,
    blocks,
    total: state.total,
    // 两种情况都算截断：本次 limit 截了，或历史上被上限淘汰过
    truncated: start > 0 || state.total > all.length,
    shellIntegration: state.sawOsc133
  };
  if (blocks.length === 0) result.reason = shellIntegrationReason(state);
  return result;
}
function forgetCommandBlocks(sessionId) {
  states$1.delete(sessionId);
}
function createShellIntegrationEmitter(emit) {
  return (event) => {
    if (event.type === "start") {
      emit(Events.SHELL_COMMAND_START, {
        sessionId: event.sessionId,
        blockId: event.blockId,
        ...event.commandLine === void 0 ? {} : { commandLine: event.commandLine },
        startedAt: event.startedAt
      });
      return;
    }
    emit(Events.SHELL_COMMAND_END, {
      sessionId: event.sessionId,
      blockId: event.blockId,
      exitCode: event.exitCode,
      ...event.commandLine === void 0 ? {} : { commandLine: event.commandLine },
      startedAt: event.startedAt,
      endedAt: event.endedAt,
      durationMs: event.durationMs
    });
  };
}
const listSchema = z.object({
  sessionId: z.string().min(1),
  limit: z.number().int().min(1).max(MAX_BLOCK_LIMIT).optional()
});
const shellIntegrationHandlers = {
  /**
   * 读取某会话的命令块（含退出码）。
   *
   * **拿不到时不是空数组了事**：`blocks` 为空且带 `reason`（可操作说明，
   * 例如"该 shell 没发 OSC 133，bash 需在 PROMPT_COMMAND 里输出"），
   * 调用方必须把 reason 转达给用户，不要显示成"没有命令"。
   */
  listCommandBlocks: (payload) => {
    const { sessionId, limit } = parseInput$1(listSchema, payload);
    return listCommandBlocks(sessionId, limit ?? DEFAULT_BLOCK_LIMIT);
  }
};
let shellEmitter = null;
function setShellIntegrationEmitter(next) {
  shellEmitter = next;
}
const states = /* @__PURE__ */ new Map();
const OSC_INTRO = "\x1B]";
const BEL = "\x07";
const ST = "\x1B\\";
const MAX_BUFFER = 4096;
function trailingIntroPrefix(text) {
  if (text.endsWith("\x1B")) return "\x1B";
  return "";
}
function stateFor(sessionId) {
  let s = states.get(sessionId);
  if (!s) {
    s = { buffer: "", inOsc: false, cwd: null };
    states.set(sessionId, s);
  }
  return s;
}
function parseOsc7(payload) {
  const idx = payload.indexOf(";");
  if (idx < 0) return null;
  if (payload.slice(0, idx) !== "7") return null;
  let rest = payload.slice(idx + 1);
  const scheme = "file://";
  if (!rest.startsWith(scheme)) return null;
  rest = rest.slice(scheme.length);
  const slash = rest.indexOf("/");
  if (slash < 0) return null;
  const path = rest.slice(slash);
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}
function feedSessionData(sessionId, chunk) {
  const s = stateFor(sessionId);
  if (chunk.length > 0) markSessionData(sessionId);
  let text = s.buffer + chunk;
  if (!s.inOsc && !text.includes(OSC_INTRO)) {
    const tail = trailingIntroPrefix(text);
    s.inOsc = false;
    s.buffer = tail;
    const plain = tail.length > 0 ? text.slice(0, text.length - tail.length) : text;
    if (plain.length > 0) feedPlainText(sessionId, plain);
    else markSessionData(sessionId);
    return;
  }
  let cursor = 0;
  s.inOsc = false;
  s.buffer = "";
  for (; ; ) {
    const start = text.indexOf(OSC_INTRO, cursor);
    if (start < 0) break;
    const bel = text.indexOf(BEL, start + OSC_INTRO.length);
    const st = text.indexOf(ST, start + OSC_INTRO.length);
    let end = -1;
    let endLen = 1;
    if (bel >= 0 && (st < 0 || bel < st)) {
      end = bel;
      endLen = BEL.length;
    } else if (st >= 0) {
      end = st;
      endLen = ST.length;
    }
    if (end < 0) {
      if (start > cursor) feedPlainText(sessionId, text.slice(cursor, start));
      const tail = text.slice(start);
      s.inOsc = true;
      s.buffer = tail.length > MAX_BUFFER ? "" : tail;
      return;
    }
    const payload = text.slice(start + OSC_INTRO.length, end);
    if (start > cursor) feedPlainText(sessionId, text.slice(cursor, start));
    const cwd = parseOsc7(payload);
    if (cwd !== null) s.cwd = cwd;
    const osc133 = parseOsc133(payload);
    if (osc133 !== null) applyOsc133(sessionId, osc133, shellEmitter ?? void 0);
    cursor = end + endLen;
  }
  const lastIntro = text.lastIndexOf(OSC_INTRO);
  if (lastIntro >= cursor) {
    if (lastIntro > cursor) feedPlainText(sessionId, text.slice(cursor, lastIntro));
    const tail = text.slice(lastIntro);
    s.inOsc = true;
    s.buffer = tail.length > MAX_BUFFER ? "" : tail;
  } else {
    const rest = text.slice(cursor);
    const tail = trailingIntroPrefix(rest);
    const plain = tail.length > 0 ? rest.slice(0, rest.length - tail.length) : rest;
    if (plain.length > 0) feedPlainText(sessionId, plain);
    if (tail.length > 0) {
      s.inOsc = false;
      s.buffer = tail;
    } else {
      markSessionData(sessionId);
    }
  }
}
function getCwd(sessionId) {
  return states.get(sessionId)?.cwd ?? null;
}
function forgetSession(sessionId) {
  states.delete(sessionId);
  forgetCommandBlocks(sessionId);
}
let installed = false;
function installCwdTracking() {
  if (installed) return () => {
  };
  installed = true;
  const offData = subscribeAllSessionData((sessionId, chunk) => {
    feedSessionData(sessionId, chunk);
  });
  const offClosed = subscribeSessionClosed((sessionId) => {
    forgetSession(sessionId);
  });
  return () => {
    offData();
    offClosed();
    installed = false;
  };
}
const index$2 = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  DEFAULT_BLOCK_LIMIT,
  MAX_BLOCK_LIMIT,
  MAX_COMMAND_BLOCKS,
  applyOsc133,
  cleanCommandLine,
  createShellIntegrationEmitter,
  feedPlainText,
  feedSessionData,
  forgetCommandBlocks,
  forgetSession,
  getCwd,
  installCwdTracking,
  listCommandBlocks,
  markSessionData,
  parseOsc133,
  parseOsc7,
  setShellIntegrationEmitter,
  shellIntegrationHandlers,
  shellIntegrationReason
}, Symbol.toStringTag, { value: "Module" }));
const log$2 = createLogger("update");
const MAX_MANIFEST_BYTES = 1024 * 1024;
const FETCH_TIMEOUT_MS = 1e4;
function resolveUpdateSource() {
  const fromEnv = process.env.T1000_UPDATE_URL;
  if (typeof fromEnv === "string" && fromEnv.trim() !== "") return fromEnv.trim();
  return null;
}
function isAllowedUpdateUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "更新源不是合法 URL" };
  }
  if (url.protocol === "https:") return { ok: true };
  if (url.protocol === "http:") {
    const h = url.hostname;
    const loopback = h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "[::1]";
    return loopback ? { ok: true } : { ok: false, reason: "更新源必须使用 https（明文通道会让更新路径暴露给中间人）" };
  }
  return { ok: false, reason: `不支持的协议：${url.protocol}` };
}
function compareVersions(a, b) {
  const split = (v) => {
    const [core, ...rest] = v.trim().replace(/^v/, "").split("-");
    const nums = (core ?? "").split(".").map((s) => {
      const n = Number.parseInt(s, 10);
      return Number.isFinite(n) ? n : 0;
    });
    return { nums, pre: rest.length > 0 ? rest.join("-") : null };
  };
  const A = split(a);
  const B = split(b);
  const len = Math.max(A.nums.length, B.nums.length);
  for (let i = 0; i < len; i += 1) {
    const x = A.nums[i] ?? 0;
    const y = B.nums[i] ?? 0;
    if (x !== y) return x - y;
  }
  if (A.pre === null && B.pre === null) return 0;
  if (A.pre === null) return 1;
  if (B.pre === null) return -1;
  return A.pre === B.pre ? 0 : A.pre > B.pre ? 1 : -1;
}
const channelEntrySchema = z.object({
  version: z.string().min(1),
  notes: z.string().optional(),
  url: z.string().optional(),
  publishedAt: z.string().optional()
});
function parseManifest(raw, channel) {
  if (raw === null || typeof raw !== "object") return null;
  const obj = raw;
  const channels = obj["channels"];
  if (channels !== null && typeof channels === "object") {
    const entry = channels[channel];
    const parsed = channelEntrySchema.safeParse(entry);
    if (!parsed.success) return null;
    const out2 = {
      version: parsed.data.version
    };
    if (parsed.data.notes !== void 0) out2.notes = parsed.data.notes;
    if (parsed.data.url !== void 0) out2.url = parsed.data.url;
    if (parsed.data.publishedAt !== void 0) out2.publishedAt = parsed.data.publishedAt;
    return out2;
  }
  const flat = channelEntrySchema.safeParse(obj);
  if (!flat.success) return null;
  const out = {
    version: flat.data.version
  };
  if (flat.data.notes !== void 0) out.notes = flat.data.notes;
  if (flat.data.url !== void 0) out.url = flat.data.url;
  if (flat.data.publishedAt !== void 0) out.publishedAt = flat.data.publishedAt;
  return out;
}
let lastResult = null;
function getLastUpdateResult() {
  return lastResult;
}
async function checkForUpdate(channel) {
  const current = app.getVersion();
  const source = resolveUpdateSource();
  if (source === null) {
    const result = {
      current,
      latest: null,
      hasUpdate: false,
      channel,
      source: null,
      reason: "尚未配置更新源，无法检查更新（本项目开源后可由发行方或自建源提供；设置环境变量 T1000_UPDATE_URL 指向版本清单）"
    };
    lastResult = result;
    return result;
  }
  const allowed = isAllowedUpdateUrl(source);
  if (!allowed.ok) {
    const result = {
      current,
      latest: null,
      hasUpdate: false,
      channel,
      source,
      reason: `更新源不可用：${allowed.reason ?? "地址不合法"}`
    };
    lastResult = result;
    return result;
  }
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let res;
    try {
      res = await fetch(source, {
        signal: controller.signal,
        headers: { accept: "application/json" },
        redirect: "follow"
      });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      throw new Error(`更新源返回 HTTP ${res.status}`);
    }
    const text = await res.text();
    if (text.length > MAX_MANIFEST_BYTES) {
      throw new Error("更新清单异常大，已拒绝解析");
    }
    const entry = parseManifest(JSON.parse(text), channel);
    if (entry === null) {
      throw new Error("更新清单格式无法识别（需要 {channels:{...}} 或 {version,...}）");
    }
    const safeUrl = entry.url !== void 0 && isAllowedUpdateUrl(entry.url).ok ? entry.url : void 0;
    const hasUpdate = compareVersions(entry.version, current) > 0;
    const result = {
      current,
      latest: entry.version,
      hasUpdate,
      channel,
      source
    };
    if (entry.notes !== void 0) result.notes = entry.notes;
    if (safeUrl !== void 0) result.downloadUrl = safeUrl;
    if (entry.publishedAt !== void 0) result.publishedAt = entry.publishedAt;
    lastResult = result;
    log$2.info(`检查更新完成：当前 ${current} / 最新 ${entry.version}（${channel}），有更新=${hasUpdate}`);
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const result = {
      current,
      latest: null,
      hasUpdate: false,
      channel,
      source,
      // 失败**不能**当成"已是最新"：那会让用户以为一切正常
      reason: `检查更新失败：${message}`
    };
    lastResult = result;
    log$2.warn("检查更新失败", err);
    return result;
  }
}
function scheduleStartupCheck() {
  setTimeout(() => {
    try {
      const settings2 = getSettings();
      if (settings2.app?.autoCheckUpdate === false) return;
      const channel = settings2.app?.updateChannel ?? "stable";
      void checkForUpdate(channel);
    } catch (err) {
      log$2.warn("启动检查更新失败", err);
    }
  }, 8e3).unref?.();
}
const checkSchema = z.object({ channel: z.enum(["stable", "beta", "dev"]).optional() });
const openSchema = z.object({ url: z.string().min(1) });
const updateHandlers = {
  /** 当前版本与上次检查结果（不发网络请求） */
  getInfo: () => {
    let channel = "stable";
    try {
      channel = getSettings().app?.updateChannel ?? "stable";
    } catch {
    }
    return { current: app.getVersion(), channel, last: lastResult };
  },
  /** 主动检查更新（走网络） */
  check: async (payload) => {
    const { channel } = parseInput$1(checkSchema, payload ?? {});
    const effChannel = channel ?? (() => {
      try {
        return getSettings().app?.updateChannel ?? "stable";
      } catch {
        return "stable";
      }
    })();
    return checkForUpdate(effChannel);
  },
  /** 用系统浏览器打开下载页（**不自动下载/安装**） */
  openDownload: async (payload) => {
    const { url } = parseInput$1(openSchema, payload);
    const allowed = isAllowedUpdateUrl(url);
    if (!allowed.ok) throw new Error(allowed.reason ?? "地址不被允许");
    await shell.openExternal(url);
    return { opened: true };
  }
};
const index$1 = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  checkForUpdate,
  compareVersions,
  getLastUpdateResult,
  isAllowedUpdateUrl,
  parseManifest,
  resolveUpdateSource,
  scheduleStartupCheck,
  updateHandlers
}, Symbol.toStringTag, { value: "Module" }));
const log$1 = createLogger("system");
const BACKUP_SUFFIX = BACKUP_EXTENSION;
const BACKUP_NAME_PATTERN = /^\d{14}\.v\d+\.backup\.t1000\.enc$/;
function isBackupFileName(name) {
  return name.endsWith(BACKUP_SUFFIX) && BACKUP_NAME_PATTERN.test(name);
}
const IDLE_POLL_MS = 15e3;
function applyEarlySettings() {
  let hardwareAcceleration = true;
  try {
    hardwareAcceleration = getSettings().app?.hardwareAcceleration ?? true;
  } catch (err) {
    log$1.warn("读取硬件加速设置失败，按默认（开启）处理", err);
  }
  if (!hardwareAcceleration) {
    try {
      app.disableHardwareAcceleration();
      log$1.info("已禁用硬件加速（该设置需重启生效）");
    } catch (err) {
      log$1.warn("禁用硬件加速失败", err);
    }
  }
}
function applyRuntimeSettings() {
  try {
    const openAtLogin = getSettings().app?.openAtLogin ?? false;
    app.setLoginItemSettings({ openAtLogin });
  } catch (err) {
    log$1.warn("应用开机自启设置失败（不影响使用）", err);
  }
}
let idleTimer = null;
let lastNotifiedLock = false;
function startAutoLock(ctx) {
  stopAutoLock();
  idleTimer = setInterval(() => {
    try {
      const minutes = getSettings().security?.autoLockMinutes ?? 0;
      if (minutes <= 0) return;
      const store = getStoreService();
      if (!store.isUnlocked()) return;
      const idleSeconds = powerMonitor.getSystemIdleTime();
      if (idleSeconds < minutes * 60) return;
      store.lock();
      if (!lastNotifiedLock) {
        lastNotifiedLock = true;
        log$1.info(`空闲 ${idleSeconds}s 达到阈值 ${minutes} 分钟，已锁定本地库`);
        ctx.emit(Events.SECURITY_LOCKED, { reason: "idle", idleSeconds });
      }
    } catch (err) {
      log$1.warn("自动锁屏检查失败", err);
    }
  }, IDLE_POLL_MS);
  idleTimer.unref?.();
}
function stopAutoLock() {
  if (idleTimer) clearInterval(idleTimer);
  idleTimer = null;
}
function lockNow(ctx, reason = "manual") {
  const store = getStoreService();
  const wasUnlocked = store.isUnlocked();
  store.lock();
  lastNotifiedLock = false;
  if (wasUnlocked) ctx.emit(Events.SECURITY_LOCKED, { reason });
}
function runBackup(ctx, backupDir) {
  void (async () => {
    try {
      const settings2 = getSettings();
      if (settings2.app?.dailyBackup === false) return;
      const store = getStoreService();
      if (!store.isUnlocked()) {
        log$1.info("本地库未解锁，跳过本次自动备份");
        return;
      }
      if (!existsSync(backupDir)) mkdirSync(backupDir, { recursive: true });
      const result = store.exportBackupToFile({ backupDir });
      const pruned = pruneBackups(backupDir, settings2.security?.backupRetentionDays ?? 7);
      log$1.info(`自动备份完成：${result.fileName}（${Math.round(result.bytes / 1024)}KB），清理旧备份 ${pruned} 个`);
      ctx.emit(Events.BACKUP_RESULT, {
        ok: true,
        filePath: result.filePath,
        bytes: result.bytes,
        pruned
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log$1.warn("自动备份失败", err);
      ctx.emit(Events.BACKUP_RESULT, { ok: false, message });
    }
  })();
}
function pruneBackups(backupDir, retentionDays) {
  if (!existsSync(backupDir)) return 0;
  const cutoff = Date.now() - Math.max(1, retentionDays) * 24 * 60 * 60 * 1e3;
  let pruned = 0;
  for (const name of readdirSync(backupDir)) {
    if (!isBackupFileName(name)) continue;
    const full = join(backupDir, name);
    try {
      const stat = statSync(full);
      if (!stat.isFile()) continue;
      if (stat.mtimeMs < cutoff) {
        unlinkSync(full);
        pruned += 1;
      }
    } catch (err) {
      log$1.warn(`清理旧备份失败: ${name}`, err);
    }
  }
  return pruned;
}
function isBackupDue(backupDir, intervalMs = 24 * 60 * 60 * 1e3) {
  if (!existsSync(backupDir)) return true;
  let newest = 0;
  for (const name of readdirSync(backupDir)) {
    if (!isBackupFileName(name)) continue;
    try {
      const s = statSync(join(backupDir, name));
      if (s.isFile() && s.mtimeMs > newest) newest = s.mtimeMs;
    } catch {
    }
  }
  if (newest === 0) return true;
  return Date.now() - newest >= intervalMs;
}
function startDailyBackup(ctx, backupDir) {
  const CHECK_MS = 10 * 60 * 1e3;
  const timer = setInterval(() => {
    try {
      const settings2 = getSettings();
      if (settings2.app?.dailyBackup === false) return;
      const days = Math.max(1, settings2.security?.backupRetentionDays ?? 7);
      if (!isBackupDue(backupDir)) return;
      if (!getStoreService().isUnlocked()) return;
      runBackup(ctx, backupDir);
    } catch (err) {
      log$1.warn("备份到期检查失败", err);
    }
  }, CHECK_MS);
  timer.unref?.();
  const first = setTimeout(() => {
    try {
      const settings2 = getSettings();
      if (settings2.app?.dailyBackup === false) return;
      if (!isBackupDue(backupDir)) return;
      if (!getStoreService().isUnlocked()) {
        log$1.info("本地库尚未解锁，本次跳过；将在解锁后的下一个检查周期补做");
        return;
      }
      runBackup(ctx, backupDir);
    } catch (err) {
      log$1.warn("启动备份检查失败", err);
    }
  }, 3e4);
  first.unref?.();
  return timer;
}
function shutdownSystem() {
  stopAutoLock();
}
z.object({});
const systemHandlers = {
  lockNow: (_payload, ctx) => {
    lockNow(ctx, "manual");
    return { locked: true };
  },
  backupNow: (payload, ctx) => {
    const { dir } = parseInput$1(z.object({ dir: z.string().min(1) }), payload);
    runBackup(ctx, dir);
    return { started: true };
  },
  /** 列出已有备份（按时间倒序），供恢复界面展示 */
  listBackups: (payload) => {
    const { dir } = parseInput$1(z.object({ dir: z.string().min(1) }), payload);
    if (!existsSync(dir)) return { backups: [] };
    const backups = readdirSync(dir).filter((n) => isBackupFileName(n)).map((name) => {
      const full = join(dir, name);
      let size = 0;
      let mtimeMs = 0;
      try {
        const s = statSync(full);
        size = s.size;
        mtimeMs = s.mtimeMs;
      } catch {
      }
      return { name, path: full, size, mtimeMs };
    }).sort((a, b) => b.mtimeMs - a.mtimeMs);
    return { backups };
  },
  applyRuntime: () => {
    applyRuntimeSettings();
    return { applied: true };
  }
};
const index = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  BACKUP_NAME_PATTERN,
  applyEarlySettings,
  applyRuntimeSettings,
  isBackupDue,
  isBackupFileName,
  lockNow,
  pruneBackups,
  runBackup,
  shutdownSystem,
  startAutoLock,
  startDailyBackup,
  stopAutoLock,
  systemHandlers
}, Symbol.toStringTag, { value: "Module" }));
const log = createLogger("bootstrap");
const dataDir = prepareDataDir();
log.info(`数据目录: ${dataDir.dir}`);
if (dataDir.previous !== dataDir.dir) {
  log.info(`已从 Electron 默认目录切换: ${dataDir.previous}`);
}
if (dataDir.relocatedFrom) {
  log.warn(`数据目录不能位于安装目录内，已改到 ${dataDir.dir}（原 ${dataDir.relocatedFrom}）`);
}
if (dataDir.migration.from) {
  const names = dataDir.migration.items.map((i) => i.name).join(", ");
  log.info(`已迁移旧数据: ${dataDir.migration.from} → ${dataDir.dir}（${names || "无内容"}）`);
  if (dataDir.migration.failed.length > 0) {
    log.warn(`迁移中以下项失败（原目录保留）: ${dataDir.migration.failed.join(", ")}`);
  }
}
applyEarlySettings();
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const win = getMainWindow();
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
}
function installIpcBridge(ctx) {
  ipcMain.handle(IPC_CHANNEL, async (_event, raw) => {
    const res = await dispatch(raw, ctx);
    if (isSettingsWrite(raw) && !res?.error) {
      applyTraySettings();
      applyRuntimeSettings();
    }
    return res;
  });
  log.info(`IPC 通道就绪: ${IPC_CHANNEL}`);
}
function isSettingsWrite(raw) {
  const req = raw;
  return req?.domain === "settings" && (req.action === "set" || req.action === "reset");
}
async function bootstrap() {
  const paths = getAppPaths();
  setWindowBoundsFile(join(paths.userData, "window-bounds.json"));
  const ctx = createIpcContext(broadcast);
  installIpcBridge(ctx);
  registerAllHandlers();
  applyRuntimeSettings();
  const mainWindow = createWindow();
  configureCompletionAi(
    createAiSuggestionProvider({
      suggestCommands: (input, limit) => suggestCommands({ query: input.query }, limit)
    })
  );
  configureCompletionSettings(() => getSettings().completion);
  configureAi({
    getSettings: () => getSettings().ai,
    // 选中的供应商要**落库**，否则重启后又回到第一个
    setActiveProvider: (providerId) => {
      updateSettings({ ai: { activeProviderId: providerId } });
    }
  });
  installCwdTracking();
  setShellIntegrationEmitter(createShellIntegrationEmitter(ctx.emit));
  scheduleStartupCheck();
  startAutoLock(ctx);
  startDailyBackup(ctx, paths.backupDir);
  applyTraySettings();
  subscribeSessionClosed((sessionId) => {
    void import("./chunks/index-DWxfE3K6.js").then((m) => m.onSessionClosed(sessionId)).catch((err) => log.warn("清理广播组成员时出错", err));
  });
  try {
    registerFromSettings(ctx);
  } catch (err) {
    log.warn("快捷键初始化失败", err);
  }
  let allowClose = false;
  mainWindow.on("close", (event) => {
    if (allowClose) return;
    event.preventDefault();
    void (async () => {
      try {
        const { getSettings: getSettings2 } = await Promise.resolve().then(() => index$6);
        const appSettings = getSettings2().app;
        if (appSettings?.confirmOnClose === true) {
          const { dialog: dialog2 } = await import("electron");
          const { response } = await dialog2.showMessageBox(mainWindow, {
            type: "question",
            buttons: ["关闭", "取消"],
            defaultId: 1,
            // 默认落在"取消"：避免一个回车就把窗口关了
            cancelId: 1,
            title: "确认关闭",
            message: "确定要关闭 terminal-1000 吗？",
            detail: "正在运行的终端会话会被断开。"
          });
          if (response !== 0) {
            log.info("用户在关闭确认中选择了取消");
            return;
          }
        }
        const minimize = appSettings?.minimizeToTray ?? false;
        if (minimize && hasTray()) {
          mainWindow.hide();
          log.info("窗口已最小化到托盘");
          return;
        }
      } catch (err) {
        log.warn("读取关闭相关设置失败，按直接退出处理", err);
      }
      allowClose = true;
      mainWindow.close();
    })();
  });
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
      try {
        registerFromSettings(ctx);
      } catch (err) {
        log.warn("新窗口快捷键注册失败", err);
      }
    }
  });
}
if (gotLock) {
  app.whenReady().then(bootstrap).catch((err) => {
    log.error("启动失败", err);
    app.exit(1);
  });
} else {
  log.info("已有实例在运行，本次启动退出并聚焦既有窗口");
}
function applyTraySettings() {
  void (async () => {
    try {
      const { getSettings: getSettings2 } = await Promise.resolve().then(() => index$6);
      const appSettings = getSettings2().app;
      syncTray(
        appSettings?.showTrayIcon ?? false,
        {
          showWindow: () => {
            const w = getMainWindow();
            if (!w) return;
            if (w.isMinimized()) w.restore();
            w.show();
            w.focus();
          },
          quit: () => {
            markQuitting();
            app.quit();
          }
        },
        // 「检查更新」由调用方注入：托盘只放菜单项，业务与设置面板共用同一服务
        () => {
          void (async () => {
            try {
              const [{ checkForUpdate: checkForUpdate2 }, { getSettings: getSettings3 }] = await Promise.all([
                Promise.resolve().then(() => index$1),
                Promise.resolve().then(() => index$6)
              ]);
              const channel = getSettings3().app?.updateChannel ?? "stable";
              const r = await checkForUpdate2(channel);
              const { dialog: dialog2 } = await import("electron");
              const w = getMainWindow();
              const body = r.hasUpdate ? `发现新版本 ${r.latest}（当前 ${r.current}）${r.notes ? `

${r.notes}` : ""}` : r.reason ?? `已是最新版本（当前 ${r.current}）`;
              const opts = {
                type: r.hasUpdate ? "info" : "info",
                title: "检查更新",
                message: r.hasUpdate ? "有可用更新" : "检查更新",
                detail: body,
                buttons: r.hasUpdate && r.downloadUrl ? ["打开发布页", "关闭"] : ["关闭"],
                defaultId: 0,
                cancelId: r.hasUpdate && r.downloadUrl ? 1 : 0
              };
              const { response } = w ? await dialog2.showMessageBox(w, opts) : await dialog2.showMessageBox(opts);
              if (response === 0 && r.downloadUrl) {
                void (await import("electron")).shell.openExternal(r.downloadUrl);
              }
            } catch (err) {
              log.warn("托盘检查更新失败", err);
            }
          })();
        }
      );
    } catch (err) {
      log.warn("同步托盘设置失败", err);
    }
  })();
}
async function shutdownServices() {
  destroyTray();
  shutdownSystem();
  const tasks = [
    {
      // 全局热键会占用系统级按键，不注销会留给下一个进程一个"死键"
      label: "注销快捷键",
      run: () => shutdownHotkeys()
    },
    {
      // Telnet 是裸 socket，不主动销毁会留下半开连接
      label: "关闭 Telnet 会话",
      run: async () => (await import("./chunks/index-BGpKzYuF.js")).shutdownTelnet()
    },
    {
      label: "关闭 VNC 会话",
      run: async () => (await import("./chunks/index-CdvD37C-.js")).shutdownVnc()
    },
    {
      // RDP 要 SIGTERM 掉外部查看器进程，否则会留下无人管理的窗口
      label: "关闭 RDP 查看器",
      run: async () => (await import("./chunks/index-CPudZoQk.js")).shutdownRdp()
    },
    {
      label: "清理广播组",
      run: async () => (await import("./chunks/index-DWxfE3K6.js")).shutdownBroadcast()
    },
    {
      label: "关闭隧道",
      run: async () => (await import("./chunks/index-CQa6d2IF.js")).shutdownForwards()
    },
    {
      label: "断开 SSH 会话",
      run: async () => (await import("./chunks/index-ByvnNeZh.js")).shutdownSsh()
    }
  ];
  for (const task of tasks) {
    try {
      await task.run();
    } catch (err) {
      log.warn(`${task.label}时出错`, err);
    }
  }
}
let cleanupDone = false;
app.on("before-quit", (event) => {
  if (cleanupDone) return;
  event.preventDefault();
  void shutdownServices().finally(() => {
    cleanupDone = true;
    app.quit();
  });
});
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
process.on("uncaughtException", (err) => {
  log.error("uncaughtException", err);
});
process.on("unhandledRejection", (reason) => {
  log.error("unhandledRejection", reason);
});
export {
  AppError as A,
  Events as E,
  MONITOR_TIER_INTERVALS as M,
  STORE_KEYS as S,
  getSession as a,
  listSessions as b,
  createLogger as c,
  unregisterSession as d,
  publishSessionData as e,
  registerSession as f,
  getWritable as g,
  getCwd as h,
  requireSession as i,
  publishSessionClosed as j,
  getStoreService as k,
  listWritables as l,
  getSettings as m,
  updateSettings as n,
  readRecordingSettings as o,
  parseInput$1 as p,
  updateRecordingSettings as q,
  registerWritable as r,
  subscribeSessionClosed as s,
  subscribeSessionData as t,
  unregisterWritable as u
};
