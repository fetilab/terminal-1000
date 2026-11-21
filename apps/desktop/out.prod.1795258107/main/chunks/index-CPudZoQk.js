import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, join } from "node:path";
import { z } from "zod";
import { A as AppError, p as parseInput, E as Events } from "../index.js";
import "electron";
import "node:net";
import "node:url";
import "better-sqlite3";
import "node:os";
import "node:fs/promises";
import __cjs_mod__ from "node:module";
const __filename = import.meta.filename;
const __dirname = import.meta.dirname;
const require2 = __cjs_mod__.createRequire(import.meta.url);
const RDP_BINARY_CANDIDATES = ["xfreerdp", "xfreerdp3", "wlfreerdp", "freerdp"];
function rdpInstallHint() {
  return [
    "未检测到 FreeRDP（xfreerdp），无法打开 RDP 会话。请先安装后再试：",
    "  Debian/Ubuntu: sudo apt install freerdp2-x11",
    "  Fedora/RHEL:   sudo dnf install freerdp",
    "  Arch:          sudo pacman -S freerdp"
  ].join("\n");
}
function explainRdpExit(executable, code, lifetimeMs) {
  const quickDeath = lifetimeMs < 3e3;
  const name = basename(executable);
  if (quickDeath && name.startsWith("wlfreerdp")) {
    return "\n提示：wlfreerdp 是 **Wayland** 客户端，当前会话不是 Wayland（或显示未转发）时会立刻退出。在 X11 下请改用 xfreerdp（Debian/Ubuntu 装 freerdp-x11，Fedora 装 freerdp）";
  }
  if (quickDeath && (code === 126 || code === 127)) {
    return "\n提示：退出码 126/127 表示二进制无法执行或找不到，通常是缺依赖或安装不完整";
  }
  if (quickDeath && code === 255) {
    return "\n提示：客户端启动后立即退出，通常是**显示环境**问题（未找到可用的 DISPLAY/wayland），而不是网络或凭据问题";
  }
  return "";
}
const RDP_DEFAULT_PORT = 3389;
const RDP_DEFAULT_WIDTH = 1280;
const RDP_DEFAULT_HEIGHT = 800;
function buildRdpArgs(connection, options = {}) {
  const args = [];
  const port = connection.port > 0 ? connection.port : RDP_DEFAULT_PORT;
  args.push(`/v:${connection.host}:${port}`);
  args.push(`/u:${connection.username}`);
  if (connection.domain !== void 0 && connection.domain !== "") {
    args.push(`/d:${connection.domain}`);
  }
  args.push(`/p:${connection.password ?? ""}`);
  args.push("/cert:ignore");
  const explicitWidth = options.width ?? connection.width;
  const explicitHeight = options.height ?? connection.height;
  const hasSize = explicitWidth !== void 0 && explicitHeight !== void 0;
  const fixed = hasSize && (connection.displayMode === "fixed-resolution" || options.forceFixedSize === true);
  if (options.fullscreen === true) {
    args.push("/f");
  }
  if (fixed) {
    args.push(`/size:${Math.trunc(explicitWidth)}x${Math.trunc(explicitHeight)}`);
  } else {
    args.push(`/size:${RDP_DEFAULT_WIDTH}x${RDP_DEFAULT_HEIGHT}`);
    args.push("/dynamic-resolution");
  }
  const quality = connection.quality ?? "balanced";
  if (quality === "low") {
    args.push("/bpp:16");
    args.push("/network:modem");
  } else if (quality === "high") {
    args.push("/bpp:32");
    args.push("/network:lan");
  } else {
    args.push("/bpp:24");
    args.push("/network:broadband");
  }
  args.push(connection.clipboardShare === true ? "/clipboard" : "-clipboard");
  return args;
}
function findRdpBinary(env = process.env, exists = defaultExecutableExists) {
  const pathValue = env["PATH"] ?? "";
  const dirs = pathValue.split(":").filter((dir) => dir.length > 0);
  for (const candidate of RDP_BINARY_CANDIDATES) {
    for (const dir of dirs) {
      const full = join(dir, candidate);
      if (exists(full)) return full;
    }
  }
  return null;
}
function defaultExecutableExists(path) {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
class RdpManager {
  constructor(options) {
    this.sessions = /* @__PURE__ */ new Map();
    this.sink = options.sink;
    this.findBinary = options.findBinary ?? (() => findRdpBinary());
    this.spawnProcess = options.spawn ?? ((file, args) => spawn(file, [...args], {
      // 早先这里是 'ignore'：结果 xfreerdp 的报错全被丢掉，
      // 用户只看到一个退出码（例如 145），无人能判断原因。
      // 改成捕获 stderr —— 客户端几乎总是把失败原因写在 stderr 上。
      stdio: ["ignore", "ignore", "pipe"]
    }));
  }
  list() {
    return [...this.sessions.values()].map((s) => ({
      sessionId: s.sessionId,
      state: s.state,
      host: s.connection.host,
      executable: basename(s.executable)
    }));
  }
  /** 探测可执行文件；找不到抛**可操作**的错误 */
  detectBinary() {
    const file = this.findBinary();
    if (file === null) {
      throw AppError.unsupported(rdpInstallHint());
    }
    return file;
  }
  connect(connection, options = {}) {
    const executable = this.detectBinary();
    const args = buildRdpArgs(connection, options);
    const sessionId = randomUUID();
    const child = this.spawnProcess(executable, args);
    const session = {
      sessionId,
      connection,
      options,
      child,
      executable,
      startedAt: Date.now(),
      stderrTail: [],
      state: "connecting",
      stopping: false,
      generation: 0
    };
    this.sessions.set(sessionId, session);
    this.sink.state(sessionId, "connecting");
    this.setState(session, "ready");
    this.watch(session, child);
    return { sessionId, executable, args };
  }
  disconnect(sessionId) {
    const session = this.require(sessionId);
    session.stopping = true;
    try {
      session.child.kill("SIGTERM");
    } catch {
    }
    this.sessions.delete(sessionId);
    this.setState(session, "disconnected");
    return true;
  }
  /**
   * 改分辨率：外部窗口无法原地改，**重启查看器进程**。
   *
   * 行为要明确（汇报里也提了）：用户点"改分辨率"会拿到一个**新窗口**，
   * 旧窗口关闭；RDP 会话本身会重连。返回 restarted=true 便于 UI 提示。
   */
  sendResize(sessionId, width, height) {
    const session = this.require(sessionId);
    const nextWidth = Math.max(320, Math.trunc(width));
    const nextHeight = Math.max(240, Math.trunc(height));
    session.stopping = true;
    session.generation += 1;
    try {
      session.child.kill("SIGTERM");
    } catch {
    }
    const options = {
      ...session.options,
      width: nextWidth,
      height: nextHeight,
      forceFixedSize: true
    };
    const args = buildRdpArgs(session.connection, options);
    const child = this.spawnProcess(session.executable, args);
    session.options = options;
    session.stopping = false;
    session.child = child;
    session.state = "connecting";
    this.sink.state(session.sessionId, "connecting", "分辨率变更：正在重启远程桌面窗口");
    this.setState(session, "ready");
    this.watch(session, child);
    return { sessionId, width: nextWidth, height: nextHeight, restarted: true };
  }
  shutdown() {
    for (const session of this.sessions.values()) {
      session.stopping = true;
      try {
        session.child.kill("SIGTERM");
      } catch {
      }
    }
    this.sessions.clear();
  }
  // -------------------------------------------------------------- 内部
  require(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) throw AppError.notFound(`RDP 会话不存在或已关闭: ${sessionId}`);
    return session;
  }
  watch(session, child) {
    const generation = session.generation;
    let exited = false;
    child.on("error", (err) => {
      if (exited || this.isStale(session, generation)) return;
      this.sink.state(session.sessionId, "failed", err.message);
      session.state = "failed";
    });
    child.stderr?.on("data", (chunk) => {
      const text = String(chunk);
      for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (trimmed.length === 0) continue;
        session.stderrTail.push(trimmed);
        if (session.stderrTail.length > 8) session.stderrTail.shift();
      }
    });
    child.on("exit", (code, signal) => {
      if (exited) return;
      exited = true;
      if (this.isStale(session, generation)) return;
      if (session.stopping) return;
      const crashed = code !== 0;
      session.stopping = true;
      session.state = "disconnected";
      this.sessions.delete(session.sessionId);
      this.sink.state(
        session.sessionId,
        "disconnected",
        crashed ? `远程桌面进程异常退出（code=${String(code)}）` + explainRdpExit(session.executable, code, Date.now() - session.startedAt) + // 附上客户端自己的报错 —— 比任何我们自己猜的解释都准
        (session.stderrTail.length > 0 ? `
客户端输出：${session.stderrTail.slice(-3).join(" | ")}` : "") : void 0
      );
      this.sink.exit(session.sessionId, {
        code,
        signal: signal === null ? null : String(signal),
        crashed
      });
    });
  }
  /** 重启后旧进程的 exit 事件不应影响新进程的状态 */
  isStale(session, generation) {
    return session.generation !== generation;
  }
  setState(session, state, message) {
    session.state = state;
    if (message === void 0) this.sink.state(session.sessionId, state);
    else this.sink.state(session.sessionId, state, message);
  }
}
const rdpConnectionSchema = z.object({
  kind: z.literal("rdp"),
  id: z.string().min(1),
  name: z.string(),
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  username: z.string().min(1),
  password: z.string().optional(),
  domain: z.string().optional(),
  displayMode: z.enum(["follow-window", "fixed-resolution"]).optional(),
  width: z.number().int().min(320).max(8192).optional(),
  height: z.number().int().min(240).max(8192).optional(),
  quality: z.enum(["low", "balanced", "high"]).optional(),
  clipboardShare: z.boolean().optional(),
  createdAt: z.string(),
  updatedAt: z.string()
}).passthrough();
const connectSchema = z.object({
  connection: rdpConnectionSchema,
  fullscreen: z.boolean().optional(),
  width: z.number().int().min(320).max(8192).optional(),
  height: z.number().int().min(240).max(8192).optional()
});
const sessionSchema = z.object({ sessionId: z.string().min(1) });
const resizeSchema = z.object({
  sessionId: z.string().min(1),
  width: z.number().int().min(320).max(8192),
  height: z.number().int().min(240).max(8192)
});
function sinkFromContext(getCtx) {
  return {
    state: (sessionId, state, message) => {
      const ctx = getCtx();
      if (!ctx) return;
      ctx.emit(
        Events.RDP_STATE,
        message === void 0 ? { sessionId, state } : { sessionId, state, message }
      );
    },
    exit: (sessionId, info) => {
      getCtx()?.emit(Events.RDP_EXIT, { sessionId, ...info });
    }
  };
}
let manager = null;
let activeCtx = null;
function shutdownRdp() {
  manager?.shutdown();
  manager = null;
}
function setRdpManagerForTests(next) {
  manager = next;
}
function getManager(ctx) {
  activeCtx = ctx;
  manager ??= new RdpManager({ sink: sinkFromContext(() => activeCtx) });
  return manager;
}
const rdpHandlers = {
  connect: (payload, ctx) => {
    const { connection, fullscreen, width, height } = parseInput(connectSchema, payload);
    const options = {
      ...fullscreen === void 0 ? {} : { fullscreen },
      ...width === void 0 ? {} : { width },
      ...height === void 0 ? {} : { height }
    };
    return getManager(ctx).connect(connection, options);
  },
  disconnect: (payload, ctx) => {
    const { sessionId } = parseInput(sessionSchema, payload);
    return { sessionId, disconnected: getManager(ctx).disconnect(sessionId) };
  },
  /** 改分辨率 = 重启外部查看器（外部窗口无法原地改，见文件头说明） */
  sendResize: (payload, ctx) => {
    const { sessionId, width, height } = parseInput(resizeSchema, payload);
    return getManager(ctx).sendResize(sessionId, width, height);
  }
};
export {
  RDP_BINARY_CANDIDATES,
  RDP_DEFAULT_HEIGHT,
  RDP_DEFAULT_PORT,
  RDP_DEFAULT_WIDTH,
  RdpManager,
  buildRdpArgs,
  explainRdpExit,
  findRdpBinary,
  rdpHandlers,
  rdpInstallHint,
  setRdpManagerForTests,
  shutdownRdp
};
