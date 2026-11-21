import { connect } from "node:net";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { p as parseInput, A as AppError, u as unregisterWritable, E as Events, r as registerWritable, c as createLogger } from "../index.js";
import { O as OutputBatcher } from "./output-batcher-DY0csVMw.js";
import "electron";
import "node:path";
import "node:fs";
import "node:child_process";
import "node:url";
import "better-sqlite3";
import "node:os";
import "node:fs/promises";
const IAC = 255;
const DONT = 254;
const DO = 253;
const WONT = 252;
const WILL = 251;
const SB = 250;
const SE = 240;
const OPT = {
  BINARY: 0,
  ECHO: 1,
  SUPPRESS_GO_AHEAD: 3,
  TERMINAL_TYPE: 24,
  WINDOW_SIZE: 31
};
const OPTION_NAMES = {
  0: "BINARY",
  1: "ECHO",
  3: "SUPPRESS-GO-AHEAD",
  5: "STATUS",
  6: "TIMING-MARK",
  24: "TERMINAL-TYPE",
  31: "NAWS(窗口大小)",
  32: "TERMINAL-SPEED",
  33: "REMOTE-FLOW-CONTROL",
  34: "LINEMODE",
  36: "ENVIRON"
};
function optionName(code) {
  return OPTION_NAMES[code] ?? `OPTION-${code}`;
}
const TTYPE_IS = 0;
const TTYPE_SEND = 1;
class TelnetProtocol {
  constructor(options = {}) {
    this.options = options;
    this.phase = "data";
    this.pendingCommand = 0;
    this.pendingOption = 0;
    this.sbBuffer = [];
    this.localEnabled = /* @__PURE__ */ new Set();
    this.remoteEnabled = /* @__PURE__ */ new Set();
    this.negotiations = [];
    this.outbox = [];
    this.terminalType = options.terminalType ?? "xterm-256color";
    this.cols = options.cols ?? 80;
    this.rows = options.rows ?? 24;
  }
  /** 取走待发送的应答字节 */
  drainOutbox() {
    const buf = Buffer.from(this.outbox);
    this.outbox = [];
    return buf;
  }
  /**
   * 更新窗口大小。
   *
   * NAWS 是「对端要求**我们**上报尺寸」（对端发 DO NAWS，我们回 WILL 并发送），
   * 所以门控条件是 **localEnabled** 而不是 remoteEnabled —— 后者表示"对端自己会做这件事"。
   * 搞反会导致尺寸永远不上报，服务端一直按 80x24 排版。
   */
  setWindowSize(cols, rows) {
    this.cols = cols;
    this.rows = rows;
    if (this.localEnabled.has(OPT.WINDOW_SIZE)) {
      return Buffer.from(this.buildWindowSize());
    }
    return Buffer.alloc(0);
  }
  /**
   * 处理一段来自服务端的字节，返回**应当显示给用户的数据**。
   * 协商字节被剥离，不会污染终端显示。
   */
  process(input) {
    const out = [];
    for (const byte of input) {
      switch (this.phase) {
        case "data":
          if (byte === IAC) this.phase = "iac";
          else out.push(byte);
          break;
        case "iac":
          if (byte === IAC) {
            out.push(IAC);
            this.phase = "data";
          } else if (byte === WILL || byte === WONT || byte === DO || byte === DONT) {
            this.pendingCommand = byte;
            this.phase = "negotiate";
          } else if (byte === SB) {
            this.sbBuffer = [];
            this.phase = "sbOption";
          } else {
            this.phase = "data";
          }
          break;
        case "negotiate": {
          this.handleNegotiation(this.pendingCommand, byte);
          this.phase = "data";
          break;
        }
        case "sbOption":
          this.pendingOption = byte;
          this.sbBuffer = [];
          this.phase = "sbData";
          break;
        case "sbData":
          if (byte === IAC) this.phase = "sbIac";
          else this.sbBuffer.push(byte);
          break;
        case "sbIac":
          if (byte === SE) {
            this.handleSubnegotiation(this.pendingOption, this.sbBuffer);
            this.phase = "data";
          } else if (byte === IAC) {
            this.sbBuffer.push(IAC);
            this.phase = "sbData";
          } else {
            this.sbBuffer.push(byte);
            this.phase = "sbData";
          }
          break;
      }
    }
    return Buffer.from(out);
  }
  /** 处理 WILL/WONT/DO/DONT */
  handleNegotiation(command, option) {
    if (command === WILL) {
      const accept = option === OPT.SUPPRESS_GO_AHEAD || option === OPT.ECHO || option === OPT.BINARY;
      if (accept) {
        this.remoteEnabled.add(option);
        this.outbox.push(IAC, DO, option);
      } else {
        this.outbox.push(IAC, DONT, option);
      }
      this.record(option, "remote", accept);
      return;
    }
    if (command === WONT) {
      this.remoteEnabled.delete(option);
      this.record(option, "remote", false, "对端拒绝");
      return;
    }
    if (command === DO) {
      if (option === OPT.TERMINAL_TYPE || option === OPT.WINDOW_SIZE) {
        this.localEnabled.add(option);
        this.outbox.push(IAC, WILL, option);
        if (option === OPT.WINDOW_SIZE) {
          this.outbox.push(...this.buildWindowSize());
        }
      } else if (option === OPT.SUPPRESS_GO_AHEAD || option === OPT.BINARY) {
        this.localEnabled.add(option);
        this.outbox.push(IAC, WILL, option);
      } else {
        this.outbox.push(IAC, WONT, option);
      }
      this.record(option, "local", this.localEnabled.has(option));
      return;
    }
    if (command === DONT) {
      this.localEnabled.delete(option);
      this.record(option, "local", false, "对端禁止");
    }
  }
  /** 处理子协商（目前只做 TTYPE 应答；NAWS 是单向上报，无需应答） */
  handleSubnegotiation(option, payload) {
    if (option === OPT.TERMINAL_TYPE && payload[0] === TTYPE_SEND) {
      const name = Buffer.from(this.terminalType, "ascii");
      this.outbox.push(IAC, SB, OPT.TERMINAL_TYPE, TTYPE_IS, ...name, IAC, SE);
      this.record(option, "local", true, `上报终端类型 ${this.terminalType}`);
      return;
    }
    this.record(option, "local", false, "未处理的子协商");
  }
  buildWindowSize() {
    const escape = (n) => {
      const hi = n >> 8 & 255;
      const lo = n & 255;
      const enc = (b) => b === IAC ? [IAC, IAC] : [b];
      return [...enc(hi), ...enc(lo)];
    };
    return [IAC, SB, OPT.WINDOW_SIZE, ...escape(this.cols), ...escape(this.rows), IAC, SE];
  }
  record(option, direction, accepted, detail) {
    const event = {
      option,
      optionName: optionName(option),
      direction,
      accepted,
      ...detail !== void 0 ? { detail } : {}
    };
    this.negotiations.push(event);
    this.options.onNegotiation?.(event);
  }
  /** 当前已启用的选项（测试与诊断） */
  state() {
    return { local: [...this.localEnabled], remote: [...this.remoteEnabled] };
  }
}
function unescapeKeys(raw) {
  const out = [];
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch !== "\\") {
      out.push(...Buffer.from(ch, "utf8"));
      continue;
    }
    const next = raw[i + 1];
    if (next === void 0) {
      out.push(92);
      break;
    }
    i += 1;
    switch (next) {
      case "n":
        out.push(10);
        break;
      case "r":
        out.push(13);
        break;
      case "t":
        out.push(9);
        break;
      case "e":
      case "x":
        if (next === "e") {
          out.push(27);
          break;
        }
        {
          const hex = raw.slice(i + 1, i + 3);
          if (/^[0-9a-fA-F]{2}$/.test(hex)) {
            out.push(parseInt(hex, 16));
            i += 2;
          } else {
            out.push(120);
          }
        }
        break;
      case "\\":
        out.push(92);
        break;
      default:
        out.push(...Buffer.from(next, "utf8"));
    }
  }
  return Buffer.from(out);
}
function applyKeyMapping(input, rules) {
  if (!rules || rules.length === 0) return Buffer.from(input, "utf8");
  let result = input;
  for (const rule of rules) {
    if (!rule.from) continue;
    if (result.includes(rule.from)) {
      result = result.split(rule.from).join(rule.to);
    }
  }
  return unescapeKeys(result);
}
const log = createLogger("telnet");
const BATCH_MS = 16;
const BATCH_MAX_BYTES = 256 * 1024;
const sessions = /* @__PURE__ */ new Map();
let activeCtx = null;
function emitState(session, state, message) {
  session.state = state;
  activeCtx?.emit(Events.TELNET_STATE, {
    sessionId: session.sessionId,
    state,
    ...message ? { message } : {}
  });
}
function connectSession(connection, ctx) {
  activeCtx = ctx;
  return new Promise((resolve, reject) => {
    const sessionId = randomUUID();
    const socket = connect({ host: connection.host, port: connection.port });
    const batcher = new OutputBatcher({
      windowMs: BATCH_MS,
      maxBytes: BATCH_MAX_BYTES,
      onFlush: (chunk) => {
        activeCtx?.emit(Events.TELNET_DATA, { sessionId, data: chunk });
      }
    });
    const protocol = new TelnetProtocol({
      onNegotiation: (event) => {
        activeCtx?.emit(Events.TELNET_NEGOTIATION, { sessionId, ...event });
      },
      // 连接级选项（终端类型/尺寸）会影响对端排版，必须透传给协议层
      ...connection.options?.term !== void 0 ? { terminalType: connection.options.term } : {},
      ...connection.options?.cols !== void 0 ? { cols: connection.options.cols } : {},
      ...connection.options?.rows !== void 0 ? { rows: connection.options.rows } : {}
    });
    const keyRules = connection.keyMapping?.rules;
    const session = {
      sessionId,
      connection,
      socket,
      protocol,
      batcher,
      state: "connecting",
      keyRules: connection.keyMapping?.enabled && keyRules && keyRules.length > 0 ? keyRules.map((r) => ({ from: r.from, to: r.to })) : void 0
    };
    sessions.set(sessionId, session);
    registerWritable({
      sessionId,
      kind: "telnet",
      title: connection.name,
      // 复用与 telnet.write 同一路径：按键映射必须一致，
      // 否则广播出去的键位与手动输入不同（网络设备上会表现为"广播时退格变怪字符"）
      write: (data) => {
        if (socket.destroyed) throw new Error("连接已断开");
        socket.write(applyKeyMapping(data, session.keyRules));
      },
      canWrite: () => socket.writable === true && !socket.destroyed
    });
    let settled = false;
    const fail = (message) => {
      if (settled) return;
      settled = true;
      sessions.delete(sessionId);
      emitState(session, "failed", message);
      reject(AppError.internal(message));
    };
    socket.setTimeout(connection.options?.timeoutMs ?? 2e4, () => {
      fail(`Telnet 连接超时（${connection.host}:${connection.port}）`);
      socket.destroy();
    });
    socket.once("connect", () => {
      socket.setTimeout(0);
      emitState(session, "ready");
      log.info(`Telnet 会话就绪 ${sessionId} → ${connection.host}:${connection.port}`);
      resolve(sessionId);
    });
    socket.on("data", (chunk) => {
      const plain = protocol.process(chunk);
      if (plain.length > 0) batcher.push(plain.toString("utf8"));
      const reply = protocol.drainOutbox();
      if (reply.length > 0 && !socket.destroyed) socket.write(reply);
    });
    socket.on("error", (err) => {
      if (session.state === "ready") {
        emitState(session, "failed", err.message);
      } else {
        fail(err.code ? `${err.code}: ${err.message}` : err.message);
      }
    });
    socket.on("close", () => {
      unregisterWritable(sessionId);
      batcher.dispose({ flushFirst: true });
      sessions.delete(sessionId);
      emitState(session, "disconnected");
      activeCtx?.emit(Events.TELNET_CLOSED, { sessionId, reason: "远端关闭连接" });
    });
  });
}
const connectionSchema = z.object({
  kind: z.literal("telnet"),
  id: z.string().min(1),
  name: z.string(),
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  username: z.string().optional(),
  password: z.string().optional(),
  note: z.string().optional(),
  keyMapping: z.object({
    enabled: z.boolean(),
    template: z.string().optional(),
    rules: z.array(z.object({ from: z.string(), to: z.string() })).optional()
  }).optional(),
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
const KEY_MAPPING_TEMPLATES = [
  {
    id: "standard",
    name: "标准模式",
    description: "默认按键映射，不做任何转换",
    rules: []
  },
  {
    id: "backspace-del",
    name: "Backspace 发送 DEL",
    description: "部分交换机/路由器把退格认成 DEL(0x7f)",
    rules: [{ from: "\b", to: "\\x7f" }]
  },
  {
    id: "no-arrow-keys",
    name: "方向键转为 VT100 序列",
    description: "当设备不认应用模式方向键时使用",
    rules: [
      { from: "\x1B[A", to: "\\x1bOA" },
      { from: "\x1B[B", to: "\\x1bOB" },
      { from: "\x1B[C", to: "\\x1bOC" },
      { from: "\x1B[D", to: "\\x1bOD" }
    ]
  }
];
const telnetHandlers = {
  connect: (payload, ctx) => {
    const { connection } = parseInput(connectSchema, payload);
    return connectSession(connection, ctx).then((sessionId) => ({ sessionId }));
  },
  disconnect: (payload, ctx) => {
    const { sessionId } = parseInput(sessionIdSchema, payload);
    const session = sessions.get(sessionId);
    if (!session) return { disconnected: false };
    try {
      session.socket.destroy();
    } catch {
    }
    session.batcher.dispose({ flushFirst: true });
    unregisterWritable(sessionId);
    sessions.delete(sessionId);
    emitState(session, "disconnected");
    ctx.emit(Events.TELNET_CLOSED, { sessionId, reason: "用户断开" });
    return { disconnected: true };
  },
  /** 发送按键：应用按键映射后再写 */
  write: (payload) => {
    const { sessionId, data } = parseInput(writeSchema, payload);
    const session = sessions.get(sessionId);
    if (!session) throw AppError.notConnected(`Telnet 会话不存在: ${sessionId}`);
    if (session.socket.destroyed) throw AppError.notConnected("连接已断开");
    const bytes = applyKeyMapping(data, session.keyRules);
    session.socket.write(bytes);
    return { written: bytes.length };
  },
  /** 窗口大小变化 → 若对端启用了 NAWS 则上报 */
  resize: (payload) => {
    const { sessionId, cols, rows } = parseInput(resizeSchema, payload);
    const session = sessions.get(sessionId);
    if (!session) return { resized: false };
    const payloadBytes = session.protocol.setWindowSize(cols, rows);
    if (payloadBytes.length > 0 && !session.socket.destroyed) {
      session.socket.write(payloadBytes);
    }
    return { resized: true, reported: payloadBytes.length > 0 };
  },
  /** 列出活跃连接与可选按键映射模板 */
  list: () => ({
    sessions: [...sessions.values()].map((s) => ({
      sessionId: s.sessionId,
      name: s.connection.name,
      host: s.connection.host,
      port: s.connection.port,
      state: s.state,
      negotiations: s.protocol.negotiations.slice(-20)
    })),
    templates: KEY_MAPPING_TEMPLATES
  })
};
function shutdownTelnet() {
  for (const s of sessions.values()) {
    try {
      s.socket.destroy();
    } catch {
    }
    s.batcher.dispose();
  }
  sessions.clear();
}
export {
  KEY_MAPPING_TEMPLATES,
  shutdownTelnet,
  telnetHandlers
};
