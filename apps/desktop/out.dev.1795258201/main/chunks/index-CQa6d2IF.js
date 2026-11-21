import { z } from "zod";
import { A as AppError, c as createLogger, a as getSession, b as listSessions, E as Events } from "../index.js";
import { createServer, connect } from "node:net";
import { randomUUID } from "node:crypto";
import "electron";
import "node:path";
import "node:fs";
import "node:child_process";
import "node:url";
import "better-sqlite3";
import "node:os";
import "node:fs/promises";
const log$1 = createLogger("forward");
const DEFAULT_RECONNECT = { baseMs: 1e3, maxMs: 3e4, attempts: 10 };
function resolveCarrierSession(serverId) {
  const direct = getSession(serverId);
  if (direct && direct.state === "ready") return direct;
  const byConnection = listSessions().find(
    (s) => s.connectionId === serverId && s.state === "ready"
  );
  if (byConnection) return byConnection;
  throw new Error(
    `没有可用的 SSH 会话承载该隧道（承载服务器：${serverId}）。请先连接到该服务器，再启动隧道。`
  );
}
class Tunnel {
  constructor(config, events, reconnect = DEFAULT_RECONNECT) {
    this.config = config;
    this.events = events;
    this.reconnect = reconnect;
    this.state = "idle";
    this.server = null;
    this.boundPort = 0;
    this.attempt = 0;
    this.reconnectTimer = null;
    this.closedByUser = false;
    this.sockets = /* @__PURE__ */ new Set();
    this.remoteCleanup = null;
    this.tunnelId = randomUUID();
  }
  getState() {
    return this.state;
  }
  getBoundPort() {
    return this.boundPort;
  }
  setState(state, message) {
    this.state = state;
    this.events.onState(this.tunnelId, state, message);
  }
  async open() {
    this.closedByUser = false;
    try {
      await this.start();
    } catch (err) {
      this.setState("failed", err instanceof Error ? err.message : String(err));
      throw err;
    }
  }
  async start() {
    const c = this.config;
    this.setState("connecting");
    switch (c.type) {
      case "local":
        await this.startLocal();
        break;
      case "remote":
        await this.startRemote();
        break;
      case "dynamic":
        await this.startDynamic();
        break;
      default:
        throw AppError.unsupported(`不支持的转发类型: ${String(c.type)}`);
    }
    this.attempt = 0;
    this.setState("ready");
    const desc = c.type === "remote" ? `远端 ${c.remoteHost}:${this.boundPort || c.remotePort} → 本机 ${c.localHost}:${c.localPort}` : c.type === "dynamic" ? `SOCKS5 监听 ${c.localHost}:${this.boundPort}` : `本机 ${c.localHost}:${this.boundPort} → ${c.remoteHost}:${c.remotePort}`;
    this.events.onInfo(this.tunnelId, `隧道已就绪：${desc}`);
    log$1.info(`隧道就绪 ${this.tunnelId} (${c.type}) ${desc}`);
  }
  /** local/remote 必须有远端目标；缺了要给明确错误（而不是拿 '' 去连） */
  requireRemoteTarget() {
    const host = this.config.remoteHost;
    const port = this.config.remotePort;
    const portInvalid = port === void 0 || port === 0 && this.config.type !== "remote";
    if (host === void 0 || host === "" || portInvalid) {
      throw new Error(
        `${this.config.type} 转发需要远端主机与端口（当前 remoteHost=${JSON.stringify(host)} remotePort=${String(port)}）`
      );
    }
    return { host, port };
  }
  async startLocal() {
    const c = this.config;
    const target = this.requireRemoteTarget();
    const session = resolveCarrierSession(c.serverId);
    const server = createServer((local) => {
      this.trackSocket(local);
      session.client.forwardOut(
        c.localHost || "127.0.0.1",
        this.boundPort || 0,
        target.host,
        target.port,
        (err, stream) => {
          if (err) {
            this.events.onError(this.tunnelId, `转发失败: ${err.message}`);
            local.destroy();
            return;
          }
          local.pipe(stream);
          stream.pipe(local);
          const cleanup = () => {
            local.destroy();
            try {
              ;
              stream.end?.();
            } catch {
            }
          };
          local.on("close", cleanup);
          local.on("error", cleanup);
          stream.on?.("close", cleanup);
          stream.on?.("error", cleanup);
        }
      );
    });
    await this.listen(server, c.localHost, c.localPort);
    this.server = server;
  }
  /** 远程转发：请求远端监听，收到连接时转回本机目标 */
  async startRemote() {
    const c = this.config;
    const target = this.requireRemoteTarget();
    const session = resolveCarrierSession(c.serverId);
    await new Promise((resolve, reject) => {
      session.client.forwardIn(target.host, target.port, (err, realPort) => {
        if (err) return reject(AppError.internal(`远端监听失败: ${err.message}`));
        if (typeof realPort === "number" && realPort > 0) this.boundPort = realPort;
        resolve();
      });
    });
    const onTcpConnection = (_info, accept, rejectConn) => {
      const local = connect(c.localPort, c.localHost || "127.0.0.1");
      this.trackSocket(local);
      local.on("connect", () => {
        const stream = accept();
        local.pipe(stream);
        stream.pipe(local);
        const cleanup = () => {
          local.destroy();
          try {
            stream.end();
          } catch {
          }
        };
        local.on("close", cleanup);
        local.on("error", cleanup);
        stream.on("close", cleanup);
        stream.on("error", cleanup);
      });
      local.on("error", (err) => {
        this.events.onWarn(this.tunnelId, `本机目标不可达 ${c.localHost}:${c.localPort} — ${err.message}`);
        try {
          rejectConn();
        } catch {
        }
      });
    };
    session.client.on("tcp connection", onTcpConnection);
    this.remoteCleanup = () => {
      session.client.removeListener("tcp connection", onTcpConnection);
      try {
        session.client.unforwardIn(target.host, target.port, () => {
        });
      } catch {
      }
    };
  }
  /** 动态转发：本地起一个 SOCKS5 服务，按请求目标经 SSH 出站 */
  async startDynamic() {
    const c = this.config;
    const session = resolveCarrierSession(c.serverId);
    const server = createServer((client) => {
      this.trackSocket(client);
      handleSocks5(
        client,
        (targetHost, targetPort) => new Promise((resolve, reject) => {
          session.client.forwardOut("127.0.0.1", 0, targetHost, targetPort, (err, stream) => {
            if (err) return reject(err);
            resolve(stream);
          });
        })
      );
    });
    await this.listen(server, c.localHost, c.localPort);
    this.server = server;
  }
  /** 监听并在端口冲突时给出明确错误 */
  listen(server, host, port) {
    return new Promise((resolve, reject) => {
      const onError = (err) => {
        server.removeListener("listening", onListening);
        if (err.code === "EADDRINUSE") {
          reject(AppError.conflict(`端口已被占用: ${host}:${port}`));
        } else if (err.code === "EACCES") {
          reject(AppError.forbidden(`无权限监听 ${host}:${port}（<1024 需要特权）`));
        } else {
          reject(AppError.internal(`监听失败: ${err.message}`));
        }
      };
      const onListening = () => {
        server.removeListener("error", onError);
        const addr = server.address();
        if (addr && typeof addr === "object") this.boundPort = addr.port;
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(port, host || "127.0.0.1");
    });
  }
  trackSocket(sock) {
    this.sockets.add(sock);
    const forget = () => {
      this.sockets.delete(sock);
    };
    sock.on("close", forget);
    sock.on("error", forget);
  }
  /**
   * 隧道断开：按指数退避重连。
   * 用户主动 close() 时不重连。
   */
  scheduleReconnect(reason) {
    if (this.closedByUser) return;
    if (!this.config.autoReconnect) {
      this.setState("failed", reason);
      return;
    }
    if (this.attempt >= this.reconnect.attempts) {
      this.setState("failed", `${reason}（已重试 ${this.attempt} 次，放弃）`);
      return;
    }
    this.attempt += 1;
    const delay = Math.min(this.reconnect.baseMs * 2 ** (this.attempt - 1), this.reconnect.maxMs);
    this.setState("reconnecting", `${reason} — ${Math.round(delay / 1e3)}s 后第 ${this.attempt} 次重试`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.restart();
    }, delay);
  }
  async restart() {
    this.teardown();
    try {
      await this.start();
    } catch (err) {
      this.scheduleReconnect(err instanceof Error ? err.message : String(err));
    }
  }
  /** 资源清理（不改变用户意图标记） */
  teardown() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    for (const s of this.sockets) s.destroy();
    this.sockets.clear();
    if (this.server) {
      this.server.close();
      this.server = null;
    }
    if (this.remoteCleanup) {
      this.remoteCleanup();
      this.remoteCleanup = null;
    }
  }
  /** 用户主动关闭 */
  close() {
    this.closedByUser = true;
    this.teardown();
    this.setState("closed");
    log$1.info(`隧道已关闭 ${this.tunnelId}`);
  }
}
function handleSocks5(socket, open) {
  let stage = "greeting";
  socket.on("data", (chunk) => {
    if (stage === "greeting") {
      if (chunk.length < 2 || chunk[0] !== 5) {
        socket.destroy();
        return;
      }
      const nmethods = chunk[1] ?? 0;
      if (chunk.length < 2 + nmethods) {
        socket.write(Buffer.from([5, 0]));
        return;
      }
      socket.write(Buffer.from([5, 0]));
      stage = "request";
      const rest = chunk.subarray(2 + nmethods);
      if (rest.length > 0) void handleRequest(rest);
      return;
    }
    if (stage === "request") {
      void handleRequest(chunk);
    }
  });
  async function handleRequest(buf) {
    stage = "done";
    if (buf.length < 7 || buf[0] !== 5 || buf[1] !== 1) {
      socket.write(Buffer.from([5, 7, 0, 1, 0, 0, 0, 0, 0, 0]));
      socket.destroy();
      return;
    }
    const atyp = buf[3];
    let host = "";
    let portOffset = 0;
    if (atyp === 1) {
      if (buf.length < 10) return fail(8);
      host = `${buf[4]}.${buf[5]}.${buf[6]}.${buf[7]}`;
      portOffset = 8;
    } else if (atyp === 3) {
      const len = buf[4] ?? 0;
      if (buf.length < 5 + len + 2) return fail(8);
      host = buf.subarray(5, 5 + len).toString("utf8");
      portOffset = 5 + len;
    } else if (atyp === 4) {
      if (buf.length < 22) return fail(8);
      const parts = [];
      for (let i = 0; i < 8; i++) parts.push(((buf[4 + i * 2] ?? 0) << 8 | (buf[5 + i * 2] ?? 0)).toString(16));
      host = parts.join(":");
      portOffset = 20;
    } else {
      return fail(8);
    }
    const port = (buf[portOffset] ?? 0) << 8 | (buf[portOffset + 1] ?? 0);
    try {
      const stream = await open(host, port);
      socket.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
      socket.removeAllListeners("data");
      socket.pipe(stream);
      stream.pipe(socket);
      const cleanup = () => {
        socket.destroy();
        try {
          stream.end();
        } catch {
        }
      };
      socket.on("close", cleanup);
      socket.on("error", cleanup);
      stream.on("close", cleanup);
      stream.on("error", cleanup);
    } catch {
      fail(5);
    }
  }
  function fail(code) {
    try {
      socket.write(Buffer.from([5, code, 0, 1, 0, 0, 0, 0, 0, 0]));
    } catch {
    }
    socket.destroy();
  }
}
function quickFillTemplates() {
  return [
    { label: "动态代理 (SOCKS5 1080)", type: "dynamic", localHost: "127.0.0.1", localPort: 1080, remoteHost: "", remotePort: 0 },
    { label: "本地转发 MySQL 3306 → 3307", type: "local", localHost: "127.0.0.1", localPort: 3307, remoteHost: "127.0.0.1", remotePort: 3306 },
    { label: "本地转发 Web 80 → 8080", type: "local", localHost: "127.0.0.1", localPort: 8080, remoteHost: "127.0.0.1", remotePort: 80 },
    { label: "远程转发 服务器9000 → 本机3000", type: "remote", localHost: "127.0.0.1", localPort: 3e3, remoteHost: "127.0.0.1", remotePort: 9e3 }
  ];
}
const log = createLogger("forward-ipc");
const tunnels = /* @__PURE__ */ new Map();
const configs = /* @__PURE__ */ new Map();
function toConnectionState(state) {
  switch (state) {
    case "ready":
      return "ready";
    case "connecting":
      return "connecting";
    case "reconnecting":
      return "connecting";
    case "failed":
      return "failed";
    case "closed":
    case "idle":
    default:
      return "disconnected";
  }
}
function makeTunnel(config, ctx) {
  return new Tunnel(config, {
    onState: (id, state, message) => {
      ctx.emit(Events.FORWARD_STATE, {
        forwardId: id,
        state: toConnectionState(state),
        ...message ? { message } : {}
      });
    },
    onInfo: (id, message) => ctx.emit(Events.FORWARD_INFO, { forwardId: id, message }),
    onWarn: (id, message) => ctx.emit(Events.FORWARD_WARN, { forwardId: id, message }),
    onError: (id, message) => ctx.emit(Events.FORWARD_ERROR, { forwardId: id, message })
  });
}
function shutdownForwards() {
  for (const t of tunnels.values()) t.close();
  tunnels.clear();
  configs.clear();
}
const tunnelSchema = z.object({
  kind: z.literal("tunnel"),
  id: z.string().min(1),
  name: z.string(),
  serverId: z.string().min(1),
  type: z.enum(["local", "remote", "dynamic"]),
  localHost: z.string(),
  localPort: z.number().int().min(0).max(65535),
  // 对 dynamic 无意义，故可选；由下面的 superRefine 按类型要求
  remoteHost: z.string().optional(),
  remotePort: z.number().int().min(0).max(65535).optional(),
  autoReconnect: z.boolean(),
  note: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string()
}).superRefine((v, ctx) => {
  if (v.type === "dynamic") return;
  if (v.remoteHost === void 0 || v.remoteHost.trim() === "") {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["remoteHost"], message: "该转发类型需要远端主机" });
  }
  if (v.remotePort === void 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["remotePort"], message: "该转发类型需要远端端口" });
    return;
  }
  if (v.type === "local" && v.remotePort === 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["remotePort"], message: "本地转发需要远端端口" });
  }
});
const openSchema = z.object({ tunnel: tunnelSchema });
const tunnelIdSchema = z.object({ tunnelId: z.string().min(1) });
const forwardHandlers = {
  /** 打开隧道：返回运行时 tunnelId 与实际监听端口 */
  open: async (payload, ctx) => {
    const { tunnel: config } = openSchema.parse(payload);
    const tunnel = makeTunnel(
      {
        ...config,
        remoteHost: config.remoteHost ?? "",
        remotePort: config.remotePort ?? 0
      },
      ctx
    );
    tunnels.set(tunnel.tunnelId, tunnel);
    configs.set(tunnel.tunnelId, config);
    try {
      await tunnel.open();
    } catch (err) {
      tunnels.delete(tunnel.tunnelId);
      configs.delete(tunnel.tunnelId);
      throw err;
    }
    log.info(`隧道已打开 ${tunnel.tunnelId} type=${config.type}`);
    return { tunnelId: tunnel.tunnelId, boundPort: tunnel.getBoundPort() };
  },
  close: (payload, ctx) => {
    const { tunnelId } = tunnelIdSchema.parse(payload);
    const tunnel = tunnels.get(tunnelId);
    if (tunnel) {
      tunnel.close();
      tunnels.delete(tunnelId);
      configs.delete(tunnelId);
      ctx.emit(Events.FORWARD_STATE, { forwardId: tunnelId, state: "disconnected" });
    }
    return { closed: true };
  },
  /** 列出活跃隧道的运行时状态 */
  list: () => [...tunnels.entries()].map(([tunnelId, tunnel]) => {
    const config = configs.get(tunnelId);
    return {
      tunnelId,
      configId: config?.id ?? "",
      name: config?.name ?? "",
      type: config?.type ?? "local",
      state: tunnel.getState(),
      boundPort: tunnel.getBoundPort(),
      localHost: config?.localHost ?? "",
      localPort: config?.localPort ?? 0,
      remoteHost: config?.remoteHost ?? "",
      remotePort: config?.remotePort ?? 0
    };
  }),
  /** 快速填充模板（UI 用） */
  templates: () => quickFillTemplates()
};
export {
  forwardHandlers,
  shutdownForwards
};
