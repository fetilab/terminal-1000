import { existsSync, readFileSync, statSync } from "node:fs";
import { userInfo, homedir } from "node:os";
import { z } from "zod";
import { h as getCwd, E as Events, u as unregisterWritable, j as publishSessionClosed, e as publishSessionData, r as registerWritable, A as AppError } from "../index.js";
import { O as OutputBatcher } from "./output-batcher-DY0csVMw.js";
import { basename } from "node:path";
import "electron";
import "node:child_process";
import "node:net";
import "node:url";
import "better-sqlite3";
import "node:crypto";
import "node:fs/promises";
import __cjs_mod__ from "node:module";
const __filename = import.meta.filename;
const __dirname = import.meta.dirname;
const require2 = __cjs_mod__.createRequire(import.meta.url);
const SUPPORTED_SHELLS = [
  "bash",
  "zsh",
  "fish",
  "sh",
  "dash",
  "ash",
  "ksh",
  "pwsh",
  "powershell"
];
const SHELL_SEARCH_DIRS = ["/bin", "/usr/bin", "/usr/local/bin", "/opt/homebrew/bin"];
const PATH_EXTRA_DIRS = [
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
  "/usr/sbin",
  "/sbin"
];
const SHELLS_FILE = "/etc/shells";
const DEFAULT_TERM = "xterm-256color";
const DEFAULT_COLORTERM = "truecolor";
const COMMON_SHELL_PATHS = [
  "/bin/sh",
  "/bin/bash",
  "/bin/dash",
  "/bin/ash",
  "/bin/ksh",
  "/bin/zsh",
  "/bin/fish",
  "/usr/bin/sh",
  "/usr/bin/bash",
  "/usr/bin/dash",
  "/usr/bin/zsh",
  "/usr/bin/fish",
  "/usr/bin/ksh",
  "/usr/local/bin/bash",
  "/usr/local/bin/zsh",
  "/usr/local/bin/fish",
  "/opt/homebrew/bin/bash",
  "/opt/homebrew/bin/zsh",
  "/opt/homebrew/bin/fish"
];
const SUPPORTED_ORDER = SUPPORTED_SHELLS;
function isSupportedShell(name) {
  return SUPPORTED_ORDER.includes(name);
}
function displayName(name) {
  switch (name) {
    case "bash":
      return "Bash";
    case "zsh":
      return "Zsh";
    case "fish":
      return "Fish";
    case "dash":
      return "Dash";
    case "ash":
      return "Ash";
    case "ksh":
      return "Ksh";
    case "pwsh":
      return "PowerShell";
    case "powershell":
      return "Windows PowerShell";
    default:
      return name;
  }
}
function parseShellsFile(content) {
  const seen = /* @__PURE__ */ new Set();
  const out = [];
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const path = line.split(/\s+/)[0] ?? "";
    if (!path.startsWith("/")) continue;
    if (seen.has(path)) continue;
    seen.add(path);
    const name = basename(path);
    out.push({ path, name, supported: isSupportedShell(name) });
  }
  return out;
}
function platformDefaultShell(io) {
  if (io.platform === "win32") {
    return io.env("COMSPEC")?.trim() || "powershell.exe";
  }
  const fromEnv = io.env("SHELL")?.trim();
  if (fromEnv) return fromEnv;
  return io.platform === "darwin" ? "/bin/zsh" : "/bin/sh";
}
function detectShells(io) {
  const candidates = [];
  const content = io.readFile(SHELLS_FILE);
  if (content) candidates.push(...parseShellsFile(content));
  for (const path of COMMON_SHELL_PATHS) {
    const name = basename(path);
    candidates.push({ path, name, supported: isSupportedShell(name) });
  }
  const byName = /* @__PURE__ */ new Map();
  for (const candidate of candidates) {
    if (!io.exists(candidate.path)) continue;
    const existing = byName.get(candidate.name);
    if (existing) continue;
    byName.set(candidate.name, candidate);
  }
  return [...byName.values()].sort((a, b) => {
    const ai = SUPPORTED_ORDER.indexOf(a.name);
    const bi = SUPPORTED_ORDER.indexOf(b.name);
    const ar = ai < 0 ? Number.MAX_SAFE_INTEGER : ai;
    const br = bi < 0 ? Number.MAX_SAFE_INTEGER : bi;
    if (ar !== br) return ar - br;
    return a.path.localeCompare(b.path);
  });
}
function resolveShell(requested, io, shells = detectShells(io)) {
  const req = requested?.trim() ?? "";
  if (req.length === 0) return platformDefaultShell(io);
  if (io.platform === "win32") return req;
  if (req.startsWith("/")) return req;
  const userShell = io.userShell?.trim();
  if (userShell) {
    if (basename(userShell) === req) return userShell;
  }
  const known = shells.find((s) => s.name === req);
  if (known) return known.path;
  for (const dir of SHELL_SEARCH_DIRS) {
    const path = `${dir}/${req}`;
    if (io.exists(path)) return path;
  }
  return req;
}
function buildShellEnv(base, options = {}, platform = process.platform) {
  const env = {};
  for (const [key, value] of Object.entries(base)) {
    if (key.length === 0 || value === void 0) continue;
    env[key] = value;
  }
  env["TERM"] = options.term?.trim() || env["TERM"]?.trim() || DEFAULT_TERM;
  env["COLORTERM"] = options.colorTerm?.trim() || env["COLORTERM"] || DEFAULT_COLORTERM;
  if (platform !== "win32") {
    env["PATH"] = extendPosixPath(env["PATH"]);
  }
  return env;
}
function extendPosixPath(current) {
  const parts = (current ?? "").split(":").filter((p) => p.length > 0);
  for (const dir of PATH_EXTRA_DIRS) {
    if (!parts.includes(dir)) parts.push(dir);
  }
  return parts.join(":");
}
function defaultProfiles(shells, io) {
  const profiles = [
    {
      id: "default",
      name: "默认 Shell",
      shell: platformDefaultShell(io),
      args: []
    }
  ];
  const seen = /* @__PURE__ */ new Set(["default"]);
  for (const shell of shells) {
    if (!shell.supported) continue;
    if (seen.has(shell.name)) continue;
    seen.add(shell.name);
    profiles.push({
      id: shell.name,
      name: displayName(shell.name),
      shell: shell.path,
      args: []
    });
  }
  return profiles;
}
function nodeShellIo() {
  let cachedUserShell;
  let userShellRead = false;
  return {
    platform: process.platform,
    readFile: (path) => {
      try {
        return readFileSync(path, "utf8");
      } catch {
        return null;
      }
    },
    exists: (path) => existsSync(path),
    env: (name) => process.env[name],
    get userShell() {
      if (!userShellRead) {
        userShellRead = true;
        try {
          cachedUserShell = userInfo().shell ?? void 0;
        } catch {
          cachedUserShell = void 0;
        }
      }
      return cachedUserShell;
    }
  };
}
const PTY_BATCH_MS = 16;
const PTY_BATCH_MAX_BYTES = 256 * 1024;
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
async function loadNodePty() {
  const mod = await import("node-pty");
  const wrapper = mod;
  return wrapper.default ?? mod;
}
function createNodePtySpawner(loader = loadNodePty) {
  return async (file, args, options) => {
    const pty = await loader();
    const proc = pty.spawn(file, [...args], {
      name: options.name,
      cwd: options.cwd,
      env: options.env,
      cols: options.cols,
      rows: options.rows,
      encoding: "utf8"
    });
    const toText = (data) => {
      if (typeof data === "string") return data;
      if (Buffer.isBuffer(data)) return data.toString("utf8");
      return String(data);
    };
    return {
      pid: proc.pid,
      onData: (cb) => {
        proc.onData((data) => cb(toText(data)));
      },
      onExit: (cb) => {
        proc.onExit((event) => {
          cb(
            event.signal === void 0 ? { exitCode: event.exitCode } : { exitCode: event.exitCode, signal: event.signal }
          );
        });
      },
      write: (data) => proc.write(data),
      resize: (cols, rows) => proc.resize(cols, rows),
      kill: (signal) => {
        if (signal === void 0) proc.kill();
        else proc.kill(signal);
      }
    };
  };
}
class PtyManager {
  constructor(events, options = {}) {
    this.events = events;
    this.sessions = /* @__PURE__ */ new Map();
    this.spawner = options.spawner ?? createNodePtySpawner();
    this.batchWindowMs = options.batchWindowMs ?? PTY_BATCH_MS;
    this.batchMaxBytes = options.batchMaxBytes ?? PTY_BATCH_MAX_BYTES;
    this.io = options.io ?? nodeShellIo();
    this.baseEnv = options.env ?? process.env;
    this.home = options.homeDir ?? safeHomedir();
    this.cwdExists = options.cwdExists ?? (() => true);
    this.idFactory = options.idFactory ?? defaultIdFactory();
    this.now = options.now ?? (() => Date.now());
  }
  listShells() {
    return detectShells(this.io);
  }
  listProfiles() {
    return defaultProfiles(this.listShells(), this.io);
  }
  list() {
    return [...this.sessions.values()].map((entry) => ({ ...entry.info }));
  }
  get(ptyId) {
    const entry = this.sessions.get(ptyId);
    return entry ? { ...entry.info } : void 0;
  }
  async open(request = {}) {
    const shells = detectShells(this.io);
    const profiles = defaultProfiles(shells, this.io);
    let profile;
    if (request.profileId) {
      profile = profiles.find((p) => p.id === request.profileId);
      if (!profile) throw AppError.badRequest(`未知的终端配置: ${request.profileId}`);
    }
    const shell = resolveShell(request.shell ?? profile?.shell, this.io, shells);
    const args = [...request.args ?? profile?.args ?? []];
    const requestedCwd = request.cwd?.trim();
    let cwd = requestedCwd && requestedCwd.length > 0 ? requestedCwd : this.home;
    let cwdFallback = false;
    if (!this.cwdExists(cwd)) {
      cwd = this.home;
      cwdFallback = true;
    }
    const cols = clampInt(request.cols ?? DEFAULT_COLS, 2, 1e3);
    const rows = clampInt(request.rows ?? DEFAULT_ROWS, 1, 1e3);
    const env = buildShellEnv(
      { ...this.baseEnv, ...request.env ?? {} },
      {
        term: request.term ?? DEFAULT_TERM,
        ...request.colorTerm === void 0 ? {} : { colorTerm: request.colorTerm }
      },
      this.io.platform
    );
    const ptyId = this.idFactory();
    const proc = await this.spawner(shell, args, {
      name: env["TERM"] ?? DEFAULT_TERM,
      cwd,
      env,
      cols,
      rows
    });
    const batcher = new OutputBatcher({
      windowMs: this.batchWindowMs,
      maxBytes: this.batchMaxBytes,
      onFlush: (data) => this.events.onData(ptyId, data)
    });
    const info = {
      ptyId,
      pid: proc.pid,
      shell,
      cwd,
      cols,
      rows,
      cwdFallback,
      ...profile ? { profileId: profile.id } : {},
      startedAt: this.now()
    };
    this.sessions.set(ptyId, { info, proc, batcher });
    this.events.onSpawn(ptyId, (data) => proc.write(data));
    proc.onData((data) => batcher.push(data));
    proc.onExit((event) => {
      batcher.dispose({ flushFirst: true });
      this.sessions.delete(ptyId);
      if (event.signal === void 0) this.events.onExit(ptyId, event.exitCode);
      else this.events.onExit(ptyId, event.exitCode, event.signal);
    });
    return {
      ptyId,
      pid: proc.pid,
      shell,
      cwd,
      cols,
      rows,
      cwdFallback,
      ...profile ? { profileId: profile.id } : {}
    };
  }
  write(ptyId, data) {
    this.require(ptyId).proc.write(data);
  }
  resize(ptyId, cols, rows) {
    const entry = this.require(ptyId);
    const nextCols = clampInt(cols, 2, 1e3);
    const nextRows = clampInt(rows, 1, 1e3);
    entry.proc.resize(nextCols, nextRows);
    entry.info.cols = nextCols;
    entry.info.rows = nextRows;
  }
  close(ptyId) {
    const entry = this.sessions.get(ptyId);
    if (!entry) return false;
    this.sessions.delete(ptyId);
    entry.batcher.dispose({ flushFirst: true });
    try {
      entry.proc.kill();
    } catch {
    }
    return true;
  }
  disposeAll() {
    for (const ptyId of [...this.sessions.keys()]) {
      this.close(ptyId);
    }
  }
  require(ptyId) {
    const entry = this.sessions.get(ptyId);
    if (!entry) throw AppError.notFound(`终端不存在或已关闭: ${ptyId}`);
    return entry;
  }
}
let manager = null;
let activeCtx = null;
function getManager(ctx) {
  activeCtx = ctx;
  if (manager) return manager;
  manager = new PtyManager(
    {
      // 本地终端也可参与广播（批量在本机+多台远机同时执行时有用）
      onSpawn: (ptyId, writeToProc) => {
        registerWritable({
          sessionId: ptyId,
          kind: "pty",
          title: `本地终端 ${ptyId.slice(0, 8)}`,
          write: (data) => writeToProc(data),
          canWrite: () => true
        });
      },
      onData: (ptyId, data) => {
        activeCtx?.emit(Events.PTY_DATA, { ptyId, data });
        publishSessionData(ptyId, data);
      },
      onExit: (ptyId, exitCode, signal) => {
        activeCtx?.emit(Events.PTY_EXIT, {
          ptyId,
          exitCode,
          ...signal === void 0 ? {} : { signal }
        });
        unregisterWritable(ptyId);
        publishSessionClosed(ptyId);
      }
    },
    { cwdExists: (path) => defaultCwdExists(path) }
  );
  return manager;
}
const openSchema = z.object({
  shell: z.string().min(1).optional(),
  args: z.array(z.string()).optional(),
  cwd: z.string().min(1).optional(),
  env: z.record(z.string()).optional(),
  cols: z.number().int().min(2).max(1e3).optional(),
  rows: z.number().int().min(1).max(1e3).optional(),
  term: z.string().min(1).optional(),
  colorTerm: z.string().min(1).optional(),
  profileId: z.string().min(1).optional()
});
const ptyIdSchema = z.object({ ptyId: z.string().min(1) });
const writeSchema = z.object({
  ptyId: z.string().min(1),
  data: z.string()
});
const resizeSchema = z.object({
  ptyId: z.string().min(1),
  cols: z.number().int().min(2).max(1e3),
  rows: z.number().int().min(1).max(1e3)
});
const ptyHandlers = {
  /** 本地终端当前目录：与 SSH 走同一套 OSC 7 跟踪（能力一致） */
  getCwd: (payload) => {
    const { ptyId } = ptyIdSchema.parse(payload);
    const cwd = getCwd(ptyId);
    if (cwd !== null) return { cwd, source: "osc7" };
    return {
      cwd: null,
      reason: "还没拿到终端的当前目录（shell 需要发 OSC 7；zsh/fish 常见配置自带）"
    };
  },
  open: (payload, ctx) => getManager(ctx).open(openSchema.parse(payload ?? {})),
  close: (payload, ctx) => {
    const { ptyId } = ptyIdSchema.parse(payload);
    return { ptyId, closed: getManager(ctx).close(ptyId) };
  },
  write: (payload, ctx) => {
    const { ptyId, data } = writeSchema.parse(payload);
    getManager(ctx).write(ptyId, data);
    return { ptyId, written: data.length };
  },
  resize: (payload, ctx) => {
    const { ptyId, cols, rows } = resizeSchema.parse(payload);
    getManager(ctx).resize(ptyId, cols, rows);
    return { ptyId, cols, rows };
  },
  list: (_payload, ctx) => getManager(ctx).list(),
  listProfiles: (_payload, ctx) => getManager(ctx).listProfiles(),
  listShells: (_payload, ctx) => getManager(ctx).listShells()
};
function defaultIdFactory() {
  let seq = 0;
  return () => {
    seq += 1;
    return `pty-${Date.now().toString(36)}-${seq.toString(36)}`;
  };
}
function safeHomedir() {
  try {
    return homedir();
  } catch {
    return "/";
  }
}
function clampInt(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}
function defaultCwdExists(path) {
  try {
    return existsSync(path) && statSync(path).isDirectory();
  } catch {
    return false;
  }
}
export {
  DEFAULT_COLS,
  DEFAULT_ROWS,
  PTY_BATCH_MAX_BYTES,
  PTY_BATCH_MS,
  PtyManager,
  createNodePtySpawner,
  ptyHandlers
};
