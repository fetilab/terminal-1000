import { z } from "zod";
import { A as AppError, p as parseInput } from "../index.js";
import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { realpath } from "node:fs/promises";
import { resolve, sep, dirname, join } from "node:path";
import { createServer } from "node:http";
import "electron";
import "node:fs";
import "node:child_process";
import "node:net";
import "node:url";
import "better-sqlite3";
import "node:os";
const DEFAULT_MCP_POLICY = {
  listenHost: "127.0.0.1",
  port: 12335,
  executionPolicy: "confirm",
  sudoPolicy: "deny",
  workspacePolicy: "confirm",
  allowedServerIds: [],
  allowedLocalDirs: [],
  defaultTimeoutMs: 6e4,
  maxTimeoutMs: 6e5,
  enabledTools: []
  // 空 = 全部工具（由 enabledToolDefs 解释）
};
const MIN_PORT = 1024;
const MAX_PORT = 65535;
function normalizePolicy(patch) {
  const merged = { ...DEFAULT_MCP_POLICY, ...patch ?? {} };
  const port = Number(merged.port);
  if (!Number.isInteger(port) || port < MIN_PORT || port > MAX_PORT) {
    throw AppError.badRequest(`MCP 端口必须是 ${MIN_PORT}-${MAX_PORT} 的整数（收到 ${String(merged.port)}）`);
  }
  const host = String(merged.listenHost).trim();
  if (host === "") throw AppError.badRequest("MCP 监听地址不能为空");
  const rawMax = Number(merged.maxTimeoutMs);
  const maxTimeoutMs = Number.isFinite(rawMax) ? Math.min(Math.max(Math.floor(rawMax), 1e3), 6e5) : 6e5;
  const rawDefault = Number(merged.defaultTimeoutMs);
  const defaultTimeoutMs = Number.isFinite(rawDefault) ? Math.min(Math.max(Math.floor(rawDefault), 1e3), maxTimeoutMs) : Math.min(6e4, maxTimeoutMs);
  const allowedServerIds = merged.allowedServerIds === "all" ? "all" : [...new Set((merged.allowedServerIds ?? []).map((s) => String(s)).filter((s) => s !== ""))];
  const allowedLocalDirs = [...new Set((merged.allowedLocalDirs ?? []).map((d) => String(d)).filter((d) => d !== ""))];
  const enabledTools = [...new Set((merged.enabledTools ?? []).map((t) => String(t)).filter((t) => t !== ""))];
  return {
    ...merged,
    listenHost: host,
    port,
    allowedServerIds,
    allowedLocalDirs,
    enabledTools,
    defaultTimeoutMs,
    maxTimeoutMs
  };
}
function isLoopbackHost(host) {
  return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
}
function isServerAllowed(serverId, policy2) {
  if (policy2.allowedServerIds === "all") return true;
  return policy2.allowedServerIds.includes(serverId);
}
function assertServerAllowed(serverId, policy2) {
  if (!isServerAllowed(serverId, policy2)) {
    throw new AppError("FORBIDDEN", `该 SSH 服务器未被授权访问: ${serverId}`);
  }
}
class PathAccessError extends Error {
  constructor(message) {
    super(message);
    this.name = "PathAccessError";
  }
}
async function assertLocalPathAllowed(candidate, policy2, options = {}) {
  if (typeof candidate !== "string" || candidate.trim() === "") {
    throw new PathAccessError("路径不能为空");
  }
  if (candidate.includes("\0")) throw new PathAccessError("路径包含非法字符 NUL");
  if (policy2.allowedLocalDirs.length === 0) {
    throw new PathAccessError("未配置允许访问的本地目录");
  }
  const roots = [];
  for (const dir of policy2.allowedLocalDirs) {
    try {
      roots.push(await realpath(dir));
    } catch {
    }
  }
  if (roots.length === 0) throw new PathAccessError("允许访问的目录均不可用");
  const absolute = resolve(candidate);
  let real;
  if (options.mustExist) {
    try {
      real = await realpath(absolute);
    } catch {
      throw new PathAccessError(`路径不存在或不可访问: ${candidate}`);
    }
  } else {
    const base = absolute.slice(absolute.lastIndexOf(sep) + 1);
    if (base === "" || base === "." || base === "..") {
      throw new PathAccessError(`目标文件名不合法: ${candidate}`);
    }
    try {
      const parent = await realpath(dirname(absolute));
      real = join(parent, base);
    } catch {
      throw new PathAccessError(`父目录不存在或不可访问: ${candidate}`);
    }
  }
  const inside = roots.some((root) => real === root || real.startsWith(root.endsWith(sep) ? root : root + sep));
  if (!inside) throw new PathAccessError(`路径越出允许范围: ${candidate}`);
  return real;
}
function digestToken(token) {
  return createHash("sha256").update(token, "utf8").digest("hex");
}
function extractBearer(header) {
  if (typeof header !== "string") return void 0;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() || void 0;
}
function safeEqualDigest(a, b) {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
class TokenRegistry {
  constructor() {
    this.clients = /* @__PURE__ */ new Map();
  }
  /** 创建令牌：返回值中的 token 只应展示一次 */
  createClient(name, options = {}) {
    const token = randomBytes(32).toString("base64url");
    const client = {
      id: `mcp-${randomBytes(6).toString("hex")}`,
      name: name.trim() === "" ? "未命名客户端" : name.trim(),
      tokenDigest: digestToken(token),
      allowSudo: options.allowSudo ?? false,
      allowWorkspace: options.allowWorkspace ?? false,
      createdAt: new Date(options.now?.() ?? Date.now()).toISOString(),
      revoked: false
    };
    this.clients.set(client.id, client);
    return { client: stripDigest(client), token };
  }
  /** 校验 Bearer 令牌；未命中或已撤销返回 undefined */
  verify(token) {
    if (typeof token !== "string" || token === "") return void 0;
    const digest = digestToken(token);
    for (const client of this.clients.values()) {
      if (client.revoked) continue;
      if (safeEqualDigest(client.tokenDigest, digest)) return client;
    }
    return void 0;
  }
  revoke(clientId) {
    const client = this.clients.get(clientId);
    if (!client || client.revoked) return false;
    client.revoked = true;
    return true;
  }
  list() {
    return [...this.clients.values()].map(stripDigest);
  }
  get size() {
    return this.clients.size;
  }
  clear() {
    this.clients.clear();
  }
}
function stripDigest(client) {
  const { tokenDigest: _tokenDigest, ...rest } = client;
  return rest;
}
const obj = (properties, required = []) => ({ type: "object", properties, required, additionalProperties: false });
const MCP_TOOLS = [
  // ── 工作区 ───────────────────────────────────────────
  {
    name: "t1000_workspace_list",
    group: "workspace",
    description: "浏览工作区已有的连接、分组、快速命令与笔记",
    parameters: obj({ kind: { type: "string", enum: ["connections", "groups", "notes", "snippets"] } }, ["kind"]),
    requiresWorkspace: true
  },
  {
    name: "t1000_workspace_save",
    group: "workspace",
    description: "创建或更新工作区数据（更新需提供已有 id；不会返回已保存的密码/私钥）",
    parameters: obj({
      kind: { type: "string", enum: ["connection", "note", "snippet", "group"] },
      id: { type: "string", description: "更新时提供；创建时省略" },
      data: { type: "object" }
    }, ["kind", "data"]),
    requiresWorkspace: true
  },
  // ── SSH ─────────────────────────────────────────────
  {
    name: "t1000_ssh_list_servers",
    group: "ssh",
    description: "列出被授权访问的 SSH 服务器（拿 serverId 供其它工具使用）",
    parameters: obj({})
  },
  {
    name: "t1000_ssh_exec",
    group: "ssh",
    description: "在指定服务器上非交互执行一条命令，返回退出码与输出（默认超时 60s，上限 600s）",
    parameters: obj({
      serverId: { type: "string" },
      command: { type: "string" },
      timeoutSec: { type: "number" },
      cwd: { type: "string" }
    }, ["serverId", "command"])
  },
  {
    name: "t1000_ssh_sudo_exec",
    group: "ssh",
    description: "以 sudo 执行命令（命令中不要写 sudo，也不要传密码）。需全局 sudo 策略与令牌权限同时允许",
    parameters: obj({
      serverId: { type: "string" },
      command: { type: "string" },
      timeoutSec: { type: "number" }
    }, ["serverId", "command"]),
    requiresSudo: true
  },
  // ── 远程文件 ─────────────────────────────────────────
  {
    name: "t1000_sftp_list",
    group: "files",
    description: "列出远端目录内容",
    parameters: obj({ serverId: { type: "string" }, path: { type: "string" } }, ["serverId", "path"])
  },
  {
    name: "t1000_sftp_stat",
    group: "files",
    description: "查看远端路径的元数据",
    parameters: obj({ serverId: { type: "string" }, path: { type: "string" } }, ["serverId", "path"])
  },
  {
    name: "t1000_sftp_read_text",
    group: "files",
    description: "读取远端文本文件（有大小上限）",
    parameters: obj({ serverId: { type: "string" }, path: { type: "string" } }, ["serverId", "path"])
  },
  {
    name: "t1000_sftp_write_text",
    group: "files",
    description: "写入远端文本文件",
    parameters: obj({ serverId: { type: "string" }, path: { type: "string" }, content: { type: "string" } }, ["serverId", "path", "content"])
  },
  // ── 文件传输 ─────────────────────────────────────────
  {
    name: "t1000_transfer_upload",
    group: "transfer",
    description: "上传本地文件到远端（本地源路径受目录白名单限制）",
    parameters: obj({
      serverId: { type: "string" },
      localPath: { type: "string" },
      remotePath: { type: "string" },
      recursive: { type: "boolean" }
    }, ["serverId", "localPath", "remotePath"]),
    needsLocalDirs: true
  },
  {
    name: "t1000_transfer_download",
    group: "transfer",
    description: "下载远端文件到本地（本地目标路径受目录白名单限制）",
    parameters: obj({
      serverId: { type: "string" },
      remotePath: { type: "string" },
      localPath: { type: "string" },
      recursive: { type: "boolean" }
    }, ["serverId", "remotePath", "localPath"]),
    needsLocalDirs: true
  },
  {
    name: "t1000_transfer_list",
    group: "transfer",
    description: "查看传输任务状态",
    parameters: obj({ serverId: { type: "string" } })
  },
  {
    name: "t1000_transfer_cancel",
    group: "transfer",
    description: "取消一个传输任务",
    parameters: obj({ transferId: { type: "string" } }, ["transferId"])
  }
];
function enabledToolDefs(policy2) {
  const all = [...MCP_TOOLS];
  if (policy2.enabledTools.length === 0) return all;
  const wanted = new Set(policy2.enabledTools);
  const filtered = all.filter((t) => wanted.has(t.name));
  return filtered.length > 0 ? filtered : all.slice(0, 1);
}
function withEnabledTools(policy2, names) {
  const unique = [...new Set(names.map((n) => String(n).trim()).filter((n) => n !== ""))];
  for (const name of unique) {
    if (!MCP_TOOLS.some((t) => t.name === name)) {
      throw AppError.badRequest(`未知的 MCP 工具: ${name}`);
    }
  }
  return normalizePolicy({ ...policy2, enabledTools: unique });
}
const MAX_BODY_BYTES = 1024 * 1024;
const MCP_PATH = "/mcp";
const PROTOCOL_VERSION = "2024-11-05";
class McpServer {
  constructor(options) {
    this.server = null;
    this.sockets = /* @__PURE__ */ new Set();
    this.boundPort = 0;
    this.policy = options.policy;
    this.tokens = options.tokens;
    if (options.runtime) this.runtime = options.runtime;
    else this.runtime = {};
    if (options.onConfirm) this.onConfirm = options.onConfirm;
    this.now = options.now ?? (() => Date.now());
    this.log = options.log ?? (() => {
    });
  }
  /** 测试注入用：设置未提供 runtime 时使用 */
  setRuntime(runtime2) {
    this.runtime = { ...this.runtime, ...runtime2 };
  }
  getRuntime() {
    return this.runtime;
  }
  setConfirmationHandler(handler) {
    if (handler) this.onConfirm = handler;
    else delete this.onConfirm;
  }
  getPolicy() {
    return this.policy;
  }
  setPolicy(policy2) {
    this.policy = policy2;
  }
  status() {
    const port = this.server ? this.boundPort : this.policy.port;
    return {
      running: this.server !== null,
      host: this.policy.listenHost,
      port,
      endpoint: `http://${this.policy.listenHost === "0.0.0.0" ? "127.0.0.1" : this.policy.listenHost}:${port}${MCP_PATH}`,
      clients: this.tokens.list().filter((c) => !c.revoked).length,
      tools: enabledToolDefs(this.policy).map((t) => t.name),
      policy: this.policy
    };
  }
  /**
   * 启动 HTTP 服务。
   * 端口被占用时抛 CONFLICT 且**不自动换端口**（与参考实现一致，避免用户连错地址）。
   */
  async start() {
    if (this.server) return this.status();
    const server2 = createServer((req, res) => {
      void this.handleHttp(req, res);
    });
    server2.on("connection", (socket) => {
      this.sockets.add(socket);
      socket.on("close", () => this.sockets.delete(socket));
    });
    await new Promise((resolve2, reject) => {
      const onError = (err) => {
        server2.removeListener("listening", onListening);
        if (err.code === "EADDRINUSE") {
          reject(AppError.conflict(`MCP 端口被占用: ${this.policy.port}（不会自动换端口，请改端口后重试）`));
        } else {
          reject(AppError.internal(`MCP 启动失败: ${err.message}`));
        }
      };
      const onListening = () => {
        server2.removeListener("error", onError);
        resolve2();
      };
      server2.once("error", onError);
      server2.once("listening", onListening);
      server2.listen(this.policy.port, this.policy.listenHost);
    });
    const address = server2.address();
    this.boundPort = typeof address === "object" && address !== null ? address.port : this.policy.port;
    this.server = server2;
    this.log(`MCP 已监听 ${this.policy.listenHost}:${this.boundPort}${MCP_PATH}`);
    return this.status();
  }
  /** 停止服务并关闭所有连接（含 keep-alive，避免测试/退出时挂住） */
  async stop() {
    const server2 = this.server;
    this.server = null;
    if (!server2) return;
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    await new Promise((resolve2) => {
      server2.close(() => resolve2());
      setTimeout(resolve2, 500).unref?.();
    });
    this.log("MCP 已停止");
  }
  // -------------------------------------------------------------------------
  // HTTP 传输层
  // -------------------------------------------------------------------------
  async handleHttp(req, res) {
    try {
      const url = req.url ?? "/";
      if (!url.startsWith(MCP_PATH)) {
        return sendJson(res, 404, { error: "not found" });
      }
      if (req.method !== "POST") {
        res.setHeader("allow", "POST");
        return sendJson(res, 405, { error: "method not allowed" });
      }
      if (!this.hostAllowed(req)) {
        return sendJson(res, 403, { error: "invalid host header" });
      }
      const client = this.tokens.verify(extractBearer(firstHeader(req.headers["authorization"])));
      if (!client) {
        res.setHeader("www-authenticate", "Bearer");
        return sendJson(res, 401, { error: "unauthorized" });
      }
      let body;
      try {
        body = await readBody(req);
      } catch (err) {
        const message = err instanceof AppError ? err.message : "读取请求体失败";
        return sendJson(res, err instanceof AppError && err.code === "BAD_REQUEST" ? 413 : 400, { error: message });
      }
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        return sendJson(res, 200, rpcError(null, -32700, "Parse error"));
      }
      const isNotification = parsed.id === void 0 || parsed.id === null;
      const response = await this.handleRpc(parsed, client);
      if (isNotification) {
        res.statusCode = 202;
        res.end();
        return;
      }
      sendJson(res, 200, response);
    } catch (err) {
      this.log(`MCP 请求处理异常: ${err instanceof Error ? err.message : String(err)}`);
      if (!res.headersSent) sendJson(res, 500, { error: "internal error" });
      else res.end();
    }
  }
  /** 回环监听时校验 Host，防 DNS rebinding 把浏览器指向本机服务 */
  hostAllowed(req) {
    if (!isLoopbackHost(this.policy.listenHost)) return true;
    const host = firstHeader(req.headers["host"]);
    if (!host) return false;
    const hostname = host.startsWith("[") ? host.slice(1, host.indexOf("]")) : host.split(":")[0];
    return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
  }
  // -------------------------------------------------------------------------
  // JSON-RPC 处理（可独立单测）
  // -------------------------------------------------------------------------
  async handleRpc(request, client) {
    const id = request.id ?? null;
    const method = request.method;
    if (typeof method !== "string" || method === "") {
      return rpcError(id, -32600, "Invalid Request");
    }
    switch (method) {
      case "initialize":
        return rpcResult(id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "terminal-1000", version: "0.1.0" }
        });
      case "notifications/initialized":
      case "notifications/cancelled":
        return rpcResult(id, {});
      case "ping":
        return rpcResult(id, {});
      case "tools/list":
        return rpcResult(id, {
          tools: enabledToolDefs(this.policy).map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.parameters
          }))
        });
      case "tools/call": {
        const params = asRecord(request.params);
        const name = typeof params?.["name"] === "string" ? params["name"] : "";
        if (name === "") return rpcError(id, -32602, "Invalid params: missing tool name");
        const args = asRecord(params?.["arguments"]) ?? {};
        const result = await this.callTool(name, args, client);
        return rpcResult(id, result);
      }
      default:
        return rpcError(id, -32601, `Method not found: ${method}`);
    }
  }
  // -------------------------------------------------------------------------
  // 工具执行（策略在这里生效）
  // -------------------------------------------------------------------------
  /** 执行工具；任何拒绝都以 isError 结果返回，不抛给传输层 */
  async callTool(name, args, client) {
    const def = enabledToolDefs(this.policy).find((t) => t.name === name);
    if (!def) {
      return toolError(`工具未启用或不存在: ${name}`);
    }
    if (def.requiresWorkspace) {
      if (this.policy.workspacePolicy === "deny") {
        return toolError("工作区管理已被禁用（workspacePolicy=deny）");
      }
      if (!client.allowWorkspace) {
        return toolError("该客户端令牌未开启「允许工作区管理」");
      }
    }
    if (def.requiresSudo) {
      if (this.policy.sudoPolicy === "deny") {
        return toolError("sudo 已被禁用（sudoPolicy=deny）");
      }
      if (!client.allowSudo) {
        return toolError("该客户端令牌未开启「允许 sudo」");
      }
    }
    const serverId = typeof args["serverId"] === "string" ? args["serverId"] : void 0;
    if (requiresServerId(def) && serverId === void 0) {
      return toolError(`缺少 serverId（先用 t1000_ssh_list_servers 获取）`);
    }
    if (serverId !== void 0) {
      try {
        assertServerAllowed(serverId, this.policy);
      } catch (err) {
        return toolError(err instanceof Error ? err.message : "服务器未被授权");
      }
    }
    if (def.needsLocalDirs) {
      const localPath = args["localPath"];
      if (typeof localPath !== "string") return toolError("缺少 localPath");
      try {
        await assertLocalPathAllowed(localPath, this.policy, {
          // 上传源必须存在；下载目标按"可创建"校验
          mustExist: def.name === "t1000_transfer_upload"
        });
      } catch (err) {
        return toolError(err instanceof PathAccessError ? err.message : "本地路径不被允许");
      }
    }
    const needsConfirm = def.requiresSudo ? this.policy.sudoPolicy === "confirm" : this.policy.executionPolicy === "confirm";
    if (needsConfirm) {
      const approved = await this.confirm({
        clientId: client.id,
        clientName: client.name,
        operation: def.name,
        ...serverId === void 0 ? {} : { serverId },
        ...typeof args["command"] === "string" ? { command: args["command"] } : {},
        ...typeof args["path"] === "string" ? { path: args["path"] } : {},
        ...typeof args["cwd"] === "string" ? { cwd: args["cwd"] } : {}
      });
      if (!approved) {
        return toolError("需要用户确认，已拒绝执行（未获确认）");
      }
    }
    try {
      return await this.dispatch(def, args, serverId);
    } catch (err) {
      if (err instanceof AppError) return toolError(err.message);
      return toolError(err instanceof Error ? err.message : String(err));
    }
  }
  async confirm(req) {
    if (!this.onConfirm) return false;
    try {
      return await this.onConfirm(req);
    } catch {
      return false;
    }
  }
  async dispatch(def, args, serverId) {
    const timeoutMs = this.resolveTimeout(args["timeoutSec"]);
    switch (def.name) {
      case "t1000_ssh_list_servers": {
        const all = this.runtime.listServers?.() ?? [];
        const visible = all.filter((s) => this.policy.allowedServerIds === "all" || this.policy.allowedServerIds.includes(s.serverId));
        return toolOk(JSON.stringify(visible));
      }
      case "t1000_ssh_exec": {
        const command = requireString(args, "command");
        if (!this.runtime.exec) return toolError("当前未接入命令执行能力");
        const outcome = await this.runtime.exec(serverId, command, { timeoutMs });
        return toolOk(formatOutcome(outcome), outcome.code !== 0);
      }
      case "t1000_ssh_sudo_exec": {
        const command = requireString(args, "command");
        if (!this.runtime.exec) return toolError("当前未接入命令执行能力");
        const outcome = await this.runtime.exec(serverId, `sudo ${command}`, { timeoutMs });
        return toolOk(formatOutcome(outcome), outcome.code !== 0);
      }
      case "t1000_sftp_list": {
        if (!this.runtime.sftpList) return toolError("当前未接入远程文件能力");
        return toolOk(JSON.stringify(await this.runtime.sftpList(serverId, requireString(args, "path"))));
      }
      case "t1000_sftp_stat": {
        if (!this.runtime.sftpStat) return toolError("当前未接入远程文件能力");
        return toolOk(JSON.stringify(await this.runtime.sftpStat(serverId, requireString(args, "path"))));
      }
      case "t1000_sftp_read_text": {
        if (!this.runtime.sftpReadText) return toolError("当前未接入远程文件能力");
        return toolOk(await this.runtime.sftpReadText(serverId, requireString(args, "path")));
      }
      case "t1000_sftp_write_text": {
        if (!this.runtime.sftpWriteText) return toolError("当前未接入远程文件能力");
        await this.runtime.sftpWriteText(serverId, requireString(args, "path"), requireString(args, "content"));
        return toolOk("已写入");
      }
      case "t1000_transfer_upload": {
        if (!this.runtime.transferUpload) return toolError("当前未接入文件传输能力");
        const result = await this.runtime.transferUpload({
          serverId,
          localPath: requireString(args, "localPath"),
          remotePath: requireString(args, "remotePath"),
          recursive: args["recursive"] === true
        });
        return toolOk(JSON.stringify(result));
      }
      case "t1000_transfer_download": {
        if (!this.runtime.transferDownload) return toolError("当前未接入文件传输能力");
        const result = await this.runtime.transferDownload({
          serverId,
          remotePath: requireString(args, "remotePath"),
          localPath: requireString(args, "localPath"),
          recursive: args["recursive"] === true
        });
        return toolOk(JSON.stringify(result));
      }
      case "t1000_transfer_list": {
        if (!this.runtime.transferList) return toolError("当前未接入文件传输能力");
        return toolOk(JSON.stringify(await this.runtime.transferList(serverId)));
      }
      case "t1000_transfer_cancel": {
        if (!this.runtime.transferCancel) return toolError("当前未接入文件传输能力");
        return toolOk(JSON.stringify(await this.runtime.transferCancel(requireString(args, "transferId"))));
      }
      case "t1000_workspace_list": {
        if (!this.runtime.workspaceList) return toolError("当前未接入工作区能力");
        return toolOk(JSON.stringify(await this.runtime.workspaceList(requireString(args, "kind"))));
      }
      case "t1000_workspace_save": {
        if (!this.runtime.workspaceSave) return toolError("当前未接入工作区能力");
        const data = asRecord(args["data"]);
        if (!data) return toolError("data 必须是对象");
        const id = typeof args["id"] === "string" ? args["id"] : void 0;
        return toolOk(JSON.stringify(await this.runtime.workspaceSave(requireString(args, "kind"), id, data)));
      }
      default:
        return toolError(`工具未实现: ${def.name}`);
    }
  }
  /** 超时：默认值 → 请求值 → 上限裁剪 */
  resolveTimeout(timeoutSec) {
    const requested = typeof timeoutSec === "number" && Number.isFinite(timeoutSec) ? timeoutSec * 1e3 : void 0;
    if (requested === void 0) return this.policy.defaultTimeoutMs;
    return Math.min(Math.max(Math.floor(requested), 1e3), this.policy.maxTimeoutMs);
  }
}
function requiresServerId(def) {
  const required = def.parameters["required"];
  return Array.isArray(required) && required.includes("serverId");
}
function requireString(args, key) {
  const value = args[key];
  if (typeof value !== "string" || value === "") {
    throw AppError.badRequest(`缺少参数 ${key}`);
  }
  return value;
}
function toolOk(text, isError = false) {
  return { content: [{ type: "text", text }], ...isError ? { isError: true } : {} };
}
function toolError(text) {
  return { content: [{ type: "text", text }], isError: true };
}
function formatOutcome(outcome) {
  const parts = [`exitCode=${outcome.code}`];
  if (outcome.durationMs !== void 0) parts.push(`durationMs=${outcome.durationMs}`);
  if (outcome.stdout !== "") parts.push(`stdout:
${outcome.stdout}`);
  if (outcome.stderr !== "") parts.push(`stderr:
${outcome.stderr}`);
  return parts.join("\n");
}
function asRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : null;
}
function firstHeader(value) {
  if (Array.isArray(value)) return value[0];
  return value;
}
function rpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}
function rpcError(id, code, message, data) {
  return { jsonrpc: "2.0", id, error: { code, message, ...{} } };
}
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("content-length", Buffer.byteLength(body));
  res.end(body);
}
async function readBody(req) {
  return new Promise((resolve2, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(AppError.badRequest("请求体过大"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve2(Buffer.concat(chunks).toString("utf8")));
    req.on("error", (err) => reject(err));
  });
}
const tokens = new TokenRegistry();
let policy = normalizePolicy(void 0);
let runtime = {};
let server = null;
function requireServer() {
  if (!server) {
    server = new McpServer({
      policy,
      tokens,
      runtime,
      log: (message) => logger?.(message)
    });
  }
  return server;
}
let logger;
function createMcpClient(name, options = {}) {
  return tokens.createClient(name, options);
}
function revokeMcpClient(clientId) {
  return tokens.revoke(clientId);
}
const policyPatchSchema = z.object({
  listenHost: z.string().min(1).optional(),
  port: z.number().int().optional(),
  executionPolicy: z.enum(["confirm", "direct"]).optional(),
  sudoPolicy: z.enum(["deny", "confirm", "direct"]).optional(),
  workspacePolicy: z.enum(["deny", "confirm", "direct"]).optional(),
  allowedServerIds: z.union([z.array(z.string()), z.literal("all")]).optional(),
  allowedLocalDirs: z.array(z.string()).optional(),
  enabledTools: z.array(z.string()).optional(),
  defaultTimeoutMs: z.number().int().optional(),
  maxTimeoutMs: z.number().int().optional()
});
const createClientSchema = z.object({
  name: z.string().min(1).max(100),
  /** 是否允许该客户端执行 sudo 命令（默认否 —— 安全默认） */
  allowSudo: z.boolean().optional(),
  /** 是否允许该客户端操作工作区（默认否） */
  allowWorkspace: z.boolean().optional()
});
const revokeClientSchema = z.object({
  clientId: z.string().min(1)
});
function applyPolicyPatch(patch) {
  const next = normalizePolicy({ ...policy, ...patch });
  return patch.enabledTools === void 0 ? next : withEnabledTools(next, patch.enabledTools);
}
const mcpHandlers = {
  status: () => {
    const s = requireServer();
    const view = { ...s.status(), clients: tokens.list() };
    return view;
  },
  start: async (payload) => {
    const patch = payload === void 0 || payload === null ? {} : parseInput(policyPatchSchema, payload);
    if (Object.keys(patch).length > 0) {
      policy = applyPolicyPatch(patch);
      requireServer().setPolicy(policy);
    }
    await requireServer().setRuntime(runtime);
    const status = await requireServer().start();
    const view = { ...status, clients: tokens.list() };
    return view;
  },
  stop: async () => {
    await requireServer().stop();
    return { running: false };
  },
  listTools: () => {
    const enabled = new Set(enabledToolDefs(policy).map((t) => t.name));
    const view = {
      tools: MCP_TOOLS.map((t) => ({
        name: t.name,
        group: t.group,
        description: t.description,
        inputSchema: t.parameters,
        enabled: enabled.has(t.name),
        requiresSudo: t.requiresSudo === true,
        requiresWorkspace: t.requiresWorkspace === true
      })),
      // 至少要保留一个工具：这里告诉 UI 当前生效的那一个
      effective: [...enabled]
    };
    return view;
  },
  setPolicy: (payload) => {
    const patch = parseInput(policyPatchSchema, payload);
    const before = policy;
    policy = applyPolicyPatch(patch);
    const s = requireServer();
    s.setPolicy(policy);
    const hostOrPortChanged = before.listenHost !== policy.listenHost || before.port !== policy.port;
    return {
      policy,
      // 运行中改地址/端口必须重启才生效（不自动重启，避免悄悄中断客户端）
      restartRequired: hostOrPortChanged && s.status().running,
      running: s.status().running
    };
  },
  /** 列出已授权的 MCP 客户端（只回摘要，不回令牌明文） */
  listClients: () => tokens.list(),
  /**
   * 新建 MCP 客户端并返回**一次性的令牌明文**。
   * 之后服务端只保留其 sha256 摘要，无法再次取回 —— 这与访问令牌的最佳实践一致。
   */
  createClient: (payload) => {
    const { name, allowSudo, allowWorkspace } = parseInput(createClientSchema, payload);
    const created = createMcpClient(name, {
      ...allowSudo !== void 0 ? { allowSudo } : {},
      ...allowWorkspace !== void 0 ? { allowWorkspace } : {}
    });
    return {
      client: created,
      // 明确提示：这是唯一一次能看到明文令牌
      notice: "请立即保存该令牌，服务端只保存摘要，之后无法再次查看。"
    };
  },
  revokeClient: (payload) => {
    const { clientId } = parseInput(revokeClientSchema, payload);
    const revoked = revokeMcpClient(clientId);
    if (!revoked) throw AppError.notFound(`MCP 客户端不存在: ${clientId}`);
    return { revoked: true, clientId };
  }
};
export {
  DEFAULT_MCP_POLICY,
  createMcpClient,
  mcpHandlers,
  revokeMcpClient
};
