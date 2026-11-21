import { z } from "zod";
import { p as parseInput, A as AppError, m as getSettings, k as getStoreService, n as updateSettings, c as createLogger, E as Events } from "../index.js";
import { connect } from "node:net";
import { createHash, generateKeyPairSync, randomBytes, verify, createCipheriv, createDecipheriv, createPublicKey, diffieHellman, hkdfSync } from "node:crypto";
import "electron";
import "node:path";
import "node:fs";
import "node:child_process";
import "node:url";
import "better-sqlite3";
import "node:os";
import "node:fs/promises";
const TSC_MAGIC = 84;
const TSC_VERSION = 1;
const HELLO_LEN = 72;
const SERVER_HELLO_PREFIX_LEN = 100;
const SERVER_HELLO_LEN = SERVER_HELLO_PREFIX_LEN + 64;
const MAX_FRAME_BYTES = 16 * 1024 * 1024;
const NONCE_LEN = 12;
const TAG_LEN = 16;
const DIR_C2S = 1;
const DIR_S2C = 2;
const b64u = (b) => b.toString("base64url");
function x25519PublicFromRaw(raw) {
  if (raw.length !== 32) throw new Error("X25519 公钥必须是 32 字节");
  const der = Buffer.concat([Buffer.from("302a300506032b656e032100", "hex"), raw]);
  return createPublicKey({ key: der, format: "der", type: "spki" });
}
function x25519PublicRaw(key) {
  const jwk = key.export({ format: "jwk" });
  if (!jwk.x) throw new Error("无法导出 X25519 公钥");
  return Buffer.from(jwk.x, "base64url");
}
function ed25519PublicFromRaw(raw) {
  return createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: b64u(raw) }, format: "jwk" });
}
function generateEphemeral() {
  const { privateKey } = generateKeyPairSync("x25519");
  return { privateKey, publicRaw: x25519PublicRaw(privateKey), random: randomBytes(32) };
}
function buildHello(clientRandom, clientEphPub) {
  if (clientRandom.length !== 32) throw new Error("client_random 必须 32 字节");
  if (clientEphPub.length !== 32) throw new Error("client_eph_pub 必须 32 字节");
  const buf = Buffer.alloc(HELLO_LEN);
  buf[0] = TSC_MAGIC;
  buf[1] = TSC_VERSION;
  buf.writeUInt16BE(0, 2);
  buf.writeUInt32BE(Math.floor(Date.now() / 1e3), 4);
  clientRandom.copy(buf, 8);
  clientEphPub.copy(buf, 40);
  return buf;
}
function parseServerHello(buf) {
  if (buf.length !== SERVER_HELLO_LEN) {
    throw new Error(`SERVER_HELLO 长度不合法: ${buf.length}（应为 ${SERVER_HELLO_LEN}）`);
  }
  if (buf[0] !== TSC_MAGIC) throw new Error("SERVER_HELLO magic 不匹配（对面可能不是 TSC/1 服务）");
  if (buf[1] !== TSC_VERSION) {
    throw new Error(`协议版本不支持: ${buf[1]}（本机支持 ${TSC_VERSION}）`);
  }
  if (buf.readUInt16BE(2) !== 0) throw new Error("SERVER_HELLO 保留位必须为 0");
  return {
    serverRandom: buf.subarray(4, 36),
    serverEphPub: buf.subarray(36, 68),
    identityPub: buf.subarray(68, 100),
    signature: buf.subarray(100, 164)
  };
}
function verifyAndDerive(args) {
  const prefix = Buffer.alloc(SERVER_HELLO_PREFIX_LEN);
  prefix[0] = TSC_MAGIC;
  prefix[1] = TSC_VERSION;
  prefix.writeUInt16BE(0, 2);
  args.serverHello.serverRandom.copy(prefix, 4);
  args.serverHello.serverEphPub.copy(prefix, 36);
  args.serverHello.identityPub.copy(prefix, 68);
  const digest = createHash("sha256").update("TSC/1 server-hello").update(Buffer.concat([args.hello, prefix])).digest();
  const ok = verify(
    null,
    digest,
    ed25519PublicFromRaw(args.serverHello.identityPub),
    args.serverHello.signature
  );
  if (!ok) {
    throw new Error("服务端签名校验失败：对方无法证明持有其出示的身份私钥");
  }
  return deriveKeys(args.hello, prefix, args.clientEphPrivate, args.serverHello.serverEphPub);
}
function deriveKeys(hello, serverHelloPrefix, clientEphPrivate, serverEphPubRaw) {
  let shared;
  try {
    shared = diffieHellman({
      privateKey: clientEphPrivate,
      publicKey: x25519PublicFromRaw(serverEphPubRaw)
    });
  } catch (err) {
    throw new Error(
      `对端公钥不可用于密钥协商（低阶点或非法点），已拒绝：${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (shared.length !== 32) throw new Error("共享密钥长度异常");
  if (shared.every((b) => b === 0)) {
    throw new Error("共享密钥为全零：对端公钥是低阶点，已拒绝（可能是攻击）");
  }
  const transcript = Buffer.concat([hello, serverHelloPrefix]);
  const transcriptHash = createHash("sha256").update(transcript).digest();
  const derive = (info) => Buffer.from(hkdfSync("sha256", shared, transcriptHash, Buffer.from(info), 32));
  return {
    c2sKey: derive("TSC/1 c2s"),
    s2cKey: derive("TSC/1 s2c"),
    shared,
    transcriptHash
  };
}
function nonceFor(dir, seq) {
  const nonce = Buffer.alloc(NONCE_LEN);
  nonce.writeUInt32BE(dir, 0);
  nonce.writeBigUInt64BE(seq, 4);
  return nonce;
}
function seal(key, dir, seq, plaintext) {
  const dirNum = DIR_C2S;
  const nonce = nonceFor(dirNum, seq);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  const body = Buffer.concat([nonce, ct, tag]);
  const head = Buffer.alloc(12);
  head.writeUInt32BE(body.length, 0);
  head.writeBigUInt64BE(seq, 4);
  return Buffer.concat([head, body]);
}
function open(key, dir, expectedSeq, frame) {
  if (frame.length < 12 + NONCE_LEN + TAG_LEN) throw new Error("帧过短");
  const declared = frame.readUInt32BE(0);
  if (declared > MAX_FRAME_BYTES) throw new Error(`帧过大: ${declared} > ${MAX_FRAME_BYTES}`);
  if (declared !== frame.length - 12) throw new Error("帧长度字段与实际不符");
  const seq = frame.readBigUInt64BE(4);
  if (seq !== expectedSeq) {
    throw new Error(`帧序号不连续：期望 ${expectedSeq}，收到 ${seq}（可能被重放或乱序）`);
  }
  const nonce = frame.subarray(12, 12 + NONCE_LEN);
  const body = frame.subarray(12);
  const tag = body.subarray(body.length - TAG_LEN);
  const ct = body.subarray(NONCE_LEN, body.length - TAG_LEN);
  const dirNum = DIR_S2C;
  const expectedNonce = nonceFor(dirNum, seq);
  if (!nonce.equals(expectedNonce)) throw new Error("nonce 与序号不符（帧被改动过）");
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ct), decipher.final()]);
  return { seq, plaintext };
}
function takeFrame(buffer) {
  if (buffer.length < 12) return null;
  const declared = buffer.readUInt32BE(0);
  if (declared > MAX_FRAME_BYTES) throw new Error(`帧过大: ${declared} > ${MAX_FRAME_BYTES}`);
  const total = 12 + declared;
  if (buffer.length < total) return null;
  return { frame: buffer.subarray(0, total), rest: buffer.subarray(total) };
}
function fingerprintOf(publicKey) {
  const hex = createHash("sha256").update(publicKey).digest("hex").slice(0, 32);
  return (hex.match(/.{4}/g) ?? []).join(" ");
}
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 1e4;
const DEFAULT_REQUEST_TIMEOUT_MS = 2e4;
class SecureChannelError extends Error {
  constructor(message, kind, fingerprint, identityChanged, expectedFingerprint) {
    super(message);
    this.kind = kind;
    this.fingerprint = fingerprint;
    this.identityChanged = identityChanged;
    this.expectedFingerprint = expectedFingerprint;
    this.name = "SecureChannelError";
  }
}
class SecureChannel {
  constructor(socket, keys, peerFingerprint, peerIdentityPub) {
    this.sendSeq = 0n;
    this.recvSeq = 0n;
    this.readBuf = Buffer.alloc(0);
    this.pending = /* @__PURE__ */ new Map();
    this.nextId = 1;
    this.closed = false;
    this.socket = socket;
    this.keys = keys;
    this.peerFingerprint = peerFingerprint;
    this.peerIdentityPub = peerIdentityPub;
    socket.on("data", (chunk) => this.onData(chunk));
    socket.on("error", (err) => this.failAll(new SecureChannelError(`连接错误: ${err.message}`, "connect")));
    socket.on("close", () => {
      this.closed = true;
      this.failAll(new SecureChannelError("连接已关闭", "closed"));
    });
  }
  /**
   * 建立连接并完成握手。
   *
   * **注意**：即使握手成功，服务端身份也可能只是"首次见到"（TOFU）。
   * 真正的信任来自用户带外核对指纹 —— 这个函数只能保证"与出示该指纹的对端
   * 完成了一次未被人篡改的密钥协商"。
   */
  static async connect(options) {
    const handshakeTimeout = options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
    const socket = await new Promise((resolve, reject) => {
      const s = connect(options.port, options.host);
      const timer = setTimeout(() => {
        s.destroy();
        reject(new SecureChannelError(`连接 ${options.host}:${options.port} 超时`, "timeout"));
      }, handshakeTimeout);
      s.once("connect", () => {
        clearTimeout(timer);
        resolve(s);
      });
      s.once("error", (err) => {
        clearTimeout(timer);
        reject(new SecureChannelError(`无法连接 ${options.host}:${options.port}: ${err.message}`, "connect"));
      });
    });
    try {
      const ephemeral = generateEphemeral();
      const hello = buildHello(ephemeral.random, ephemeral.publicRaw);
      await new Promise((resolve, reject) => {
        socket.write(hello, (err) => err ? reject(err) : resolve());
      });
      const serverHelloBytes = await readExactly(socket, SERVER_HELLO_LEN, handshakeTimeout);
      const serverHello = parseServerHello(serverHelloBytes);
      const presentedFp = fingerprintOf(serverHello.identityPub).replace(/ /g, "");
      const pinnedFp = options.pinnedFingerprint?.replace(/ /g, "");
      const decide = options.onPin ?? defaultPinDecision;
      const isNew = pinnedFp === void 0;
      const keyMismatch = pinnedFp !== void 0 && options.pinnedPublicKey !== void 0 && !serverHello.identityPub.equals(options.pinnedPublicKey);
      const pinChanged = !isNew && (presentedFp !== pinnedFp || keyMismatch);
      if (pinChanged) {
        const allowed = decide({
          fingerprint: presentedFp,
          isNew: false,
          pinned: pinnedFp,
          keyMismatch
        });
        if (!allowed) {
          throw new SecureChannelError(
            `服务端身份与已记录的不一致（可能被中间人）：
  已记录指纹 ${pinnedFp}
  本次指纹 ${presentedFp}` + (keyMismatch ? "\n  （公钥字节也不一致）" : ""),
            "pin",
            presentedFp,
            true,
            pinnedFp
          );
        }
      } else if (isNew) {
        const accepted = decide({ fingerprint: presentedFp, isNew: true });
        if (!accepted) {
          throw new SecureChannelError(
            `服务端首次连接（未钉扎）。指纹：${fingerprintOf(serverHello.identityPub)} —— 请核对后接受`,
            "pin",
            presentedFp
          );
        }
      }
      const keys = verifyAndDerive({
        hello,
        serverHello,
        clientEphPrivate: ephemeral.privateKey
      });
      return new SecureChannel(socket, keys, presentedFp, serverHello.identityPub);
    } catch (err) {
      socket.destroy();
      if (err instanceof SecureChannelError) throw err;
      throw new SecureChannelError(
        `握手失败：${err instanceof Error ? err.message : String(err)}`,
        "handshake"
      );
    }
  }
  /**
   * **探测**：连上去握手、拿到对端身份，但**不建立可用的长期通道**。
   *
   * 用途是信任引导（TOFU）——用户需要先看到指纹才能决定是否信任，
   * 而"看到指纹"本身就必须先连一次。探测完立即关闭，不发送任何应用数据。
   */
  static async probe(host, port, timeoutMs = DEFAULT_HANDSHAKE_TIMEOUT_MS) {
    const ch = await SecureChannel.connect({
      host,
      port,
      handshakeTimeoutMs: timeoutMs,
      // 探测模式：接受首次连接（否则拿不到指纹），但**用完即关、不发数据**
      onPin: (info) => info.isNew
    });
    const fps = ch.peerFingerprint;
    const pub = Buffer.from(ch.peerIdentityPub);
    ch.close();
    return { fingerprint: fps, publicKey: pub };
  }
  /** 发一个请求并等响应；`id` 用于并发配对 */
  request(path, options = {}) {
    if (this.closed) {
      return Promise.reject(new SecureChannelError("连接已关闭", "closed"));
    }
    const id = this.nextId++;
    const payload = Buffer.from(
      JSON.stringify({
        id,
        method: options.method ?? "GET",
        path,
        ...options.token === void 0 ? {} : { headers: { authorization: `Bearer ${options.token}` } },
        ...options.body === void 0 ? {} : { body: options.body }
      }),
      "utf8"
    );
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new SecureChannelError(`请求超时：${path}`, "timeout"));
      }, DEFAULT_REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.writeFrame(payload);
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }
  close() {
    this.closed = true;
    try {
      this.socket.end();
    } catch {
    }
  }
  // ── 内部 ──────────────────────────────────────────
  writeFrame(plaintext) {
    const frame = seal(this.keys.c2sKey, "c2s", this.sendSeq, plaintext);
    this.sendSeq += 1n;
    this.socket.write(frame);
  }
  onData(chunk) {
    if (this.closed) return;
    this.readBuf = Buffer.concat([this.readBuf, chunk]);
    for (; ; ) {
      let taken;
      try {
        taken = takeFrame(this.readBuf);
      } catch (err) {
        this.abort(new SecureChannelError(err instanceof Error ? err.message : String(err), "protocol"));
        return;
      }
      if (!taken) return;
      this.readBuf = taken.rest;
      let plaintext;
      try {
        plaintext = open(this.keys.s2cKey, "s2c", this.recvSeq, taken.frame).plaintext;
        this.recvSeq += 1n;
      } catch (err) {
        this.abort(new SecureChannelError(`帧校验失败: ${err instanceof Error ? err.message : String(err)}`, "protocol"));
        return;
      }
      this.handleMessage(plaintext);
    }
  }
  handleMessage(plaintext) {
    let msg;
    try {
      msg = JSON.parse(plaintext.toString("utf8"));
    } catch {
      this.abort(new SecureChannelError("收到非 JSON 的应用层消息", "protocol"));
      return;
    }
    if (typeof msg.id !== "number") {
      this.abort(new SecureChannelError("响应缺少 id，无法与请求配对", "protocol"));
      return;
    }
    const p = this.pending.get(msg.id);
    if (!p) {
      return;
    }
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    p.resolve({ status: typeof msg.status === "number" ? msg.status : 0, body: msg.body });
  }
  abort(err) {
    this.closed = true;
    this.failAll(err);
    try {
      this.socket.destroy();
    } catch {
    }
  }
  failAll(err) {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }
}
function defaultPinDecision(info) {
  if (info.isNew) return false;
  if (info.keyMismatch === true) return false;
  return info.fingerprint === info.pinned;
}
function readExactly(socket, n, timeoutMs) {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const timer = setTimeout(() => {
      cleanup();
      reject(new SecureChannelError(`读取握手数据超时（已收到 ${buf.length}/${n} 字节）`, "timeout"));
    }, timeoutMs);
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length >= n) {
        cleanup();
        if (buf.length > n) socket.unshift(buf.subarray(n));
        resolve(buf.subarray(0, n));
      }
    };
    const onErr = (err) => {
      cleanup();
      reject(new SecureChannelError(`握手期间连接出错: ${err.message}`, "handshake"));
    };
    const cleanup = () => {
      clearTimeout(timer);
      socket.removeListener("data", onData);
      socket.removeListener("error", onErr);
    };
    socket.on("data", onData);
    socket.on("error", onErr);
  });
}
class UntrustedServerError extends Error {
  constructor(fingerprint) {
    super(
      `首次连接该同步服务端，需要你核对身份指纹：
  ${fingerprint}
请在另一条可信渠道（服务器本机日志）核对一致后再信任。`
    );
    this.fingerprint = fingerprint;
    this.code = "UNTRUSTED_SERVER";
    this.name = "UntrustedServerError";
  }
}
class ServerIdentityChangedError extends Error {
  constructor(expected, actual) {
    super(
      `同步服务端身份与已记录的不一致（可能为中间人，也可能服务端已更换密钥）：
  已记录 ${expected}
  本次收到 ${actual}
若确认服务端已更换密钥，需手动更新钉扎；否则应视为中间人并中止。`
    );
    this.expected = expected;
    this.actual = actual;
    this.code = "SERVER_IDENTITY_CHANGED";
    this.name = "ServerIdentityChangedError";
  }
}
const pool = /* @__PURE__ */ new Map();
function keyOf(host, port) {
  return `${host}:${port}`;
}
async function getChannel(host, port, pin) {
  const k = keyOf(host, port);
  const existing = pool.get(k);
  if (existing) return existing.channel;
  const options = {
    host,
    port,
    ...pin === void 0 ? {} : {
      pinnedFingerprint: pin.fingerprint,
      pinnedPublicKey: Buffer.from(pin.publicKey, "base64")
    },
    // 未钉扎与不一致都由调用方处理，这里一律不自动接受
    onPin: () => false
  };
  let channel;
  try {
    channel = await SecureChannel.connect(options);
  } catch (err) {
    if (err instanceof SecureChannelError && err.kind === "pin") {
      if (err.identityChanged === true && err.expectedFingerprint !== void 0) {
        throw new ServerIdentityChangedError(err.expectedFingerprint, err.fingerprint ?? "");
      }
      if (err.fingerprint !== void 0) throw new UntrustedServerError(err.fingerprint);
    }
    throw err;
  }
  if (pin !== void 0 && channel.peerFingerprint !== pin.fingerprint) {
    channel.close();
    throw new ServerIdentityChangedError(pin.fingerprint, channel.peerFingerprint);
  }
  pool.set(k, { channel, fingerprint: channel.peerFingerprint });
  return channel;
}
function closeAllChannels() {
  for (const [, p] of pool) p.channel.close();
  pool.clear();
}
const log = createLogger("sync");
const SNAPSHOT_BLOB = "snapshot";
const REQUEST_TIMEOUT_MS = 6e4;
const state = { state: "idle" };
function getSyncSettings() {
  return getSettings().sync;
}
function updateSyncSettings(patch) {
  updateSettings({ sync: patch });
}
function readToken() {
  const sealed = getSyncSettings().token;
  if (!sealed) return void 0;
  try {
    return getStoreService().openValue(sealed);
  } catch (err) {
    log.warn("同步令牌无法解开（未解锁或已损坏）", err);
    return void 0;
  }
}
function writeToken(token) {
  updateSyncSettings({ token: getStoreService().sealValue(token) });
}
function readPassphrase() {
  const sealed = getSyncSettings().passphrase;
  if (!sealed) return void 0;
  try {
    return getStoreService().openValue(sealed);
  } catch (err) {
    log.warn("同步口令无法解开（未解锁或已损坏）", err);
    return void 0;
  }
}
function writePassphrase(passphrase) {
  updateSyncSettings({ passphrase: getStoreService().sealValue(passphrase) });
}
function requirePassphrase() {
  const pass = readPassphrase();
  if (!pass) {
    throw AppError.badRequest(
      "未设置同步口令：请在同步设置里设置「仓库密码」后再同步（新设备用同一口令即可解密云端数据）"
    );
  }
  return pass;
}
function clearToken() {
  updateSyncSettings({ token: "" });
}
function endpoint() {
  const raw = getSyncSettings().endpoint;
  if (!raw) throw AppError.badRequest("未配置同步服务地址");
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw AppError.badRequest(`同步服务地址不合法: ${raw}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw AppError.badRequest("同步服务地址必须是 http(s)");
  }
  return url.toString().replace(/\/+$/, "");
}
function tsc1Target() {
  const raw = getSyncSettings().endpoint;
  if (!raw) throw AppError.badRequest("未配置同步服务地址");
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw AppError.badRequest(`同步服务地址不合法: ${raw}`);
  }
  const port = url.port === "" ? 0 : Number(url.port);
  if (!Number.isInteger(port) || port <= 0) {
    throw AppError.badRequest(
      "TSC/1 需要显式端口（例如 tsc1://host:8788）—— 加密通道与 HTTP 端口是分开的"
    );
  }
  return { host: url.hostname, port };
}
function isLoopbackHost(host) {
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]" || host.endsWith(".localhost");
}
async function callOverTsc1(path, options, settings) {
  const { host, port } = tsc1Target();
  let channel;
  try {
    channel = await getChannel(host, port, settings.pin ?? void 0);
  } catch (err) {
    if (err instanceof UntrustedServerError) {
      throw new AppError("UNAUTHORIZED", err.message, {
        code: err.code,
        fingerprint: err.fingerprint
      });
    }
    if (err instanceof ServerIdentityChangedError) {
      throw new AppError("FORBIDDEN", err.message, {
        code: err.code,
        expected: err.expected,
        actual: err.actual
      });
    }
    state.state = "offline";
    throw AppError.internal(
      `无法建立加密同步通道（${host}:${port}）：${err instanceof Error ? err.message : String(err)}
（不会退回明文 HTTP —— 见规范 §3.3.1）`
    );
  }
  const res = await channel.request(path, {
    method: options.method ?? "GET",
    ...options.body === void 0 ? {} : { body: options.body },
    ...options.token === void 0 ? {} : { token: options.token }
  });
  return { status: res.status, body: res.body };
}
async function call(path, options = {}) {
  const settings = getSyncSettings();
  const transport = settings.transport ?? "tsc1";
  if (transport === "tsc1") {
    return callOverTsc1(path, options, settings);
  }
  const url = new URL(endpoint());
  if (!isLoopbackHost(url.hostname)) {
    throw new AppError(
      "FORBIDDEN",
      `拒绝以明文 HTTP 连接非回环地址 ${url.hostname}：登录口令与会话令牌会在公网裸奔。
请在「设置 → 同步」把传输方式改为 TSC/1（加密通道），并填好它的端口与服务端指纹。`,
      { code: "PLAINTEXT_NOT_ALLOWED" }
    );
  }
  const fullUrl = `${endpoint()}${path}`;
  const headers = {};
  if (options.token) headers["authorization"] = `Bearer ${options.token}`;
  if (options.body !== void 0) headers["content-type"] = "application/json";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(fullUrl, {
      method: options.method ?? "GET",
      headers,
      ...options.body === void 0 ? {} : { body: JSON.stringify(options.body) },
      signal: controller.signal
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    state.state = "offline";
    throw AppError.internal(`无法连接同步服务: ${reason}`);
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : void 0;
  } catch {
    body = void 0;
  }
  return { status: res.status, body };
}
function toAppError(result, fallback) {
  const body = result.body;
  const code = body?.error?.code;
  const message = body?.error?.message ?? fallback;
  if (code === "VERSION_CONFLICT") return AppError.conflict(message);
  if (code === "INVALID_CREDENTIALS" || code === "UNAUTHORIZED" || code === "TOKEN_EXPIRED") {
    return AppError.unauthorized(message);
  }
  if (code === "NOT_FOUND") return AppError.notFound(message);
  if (result.status === 409) return AppError.conflict(message);
  if (result.status === 401) return AppError.unauthorized(message);
  if (result.status === 400) return AppError.badRequest(message);
  return AppError.internal(message);
}
function emitState(ctx) {
  ctx.emit(Events.SYNC_STATE, {
    state: state.state,
    ...state.lastError ? { message: state.lastError } : {}
  });
}
async function refreshRemoteVersion(token) {
  const result = await call("/api/v1/blobs", { token });
  if (result.status !== 200) return 0;
  const body = result.body;
  const snapshot = body.blobs?.find((b) => b.name === SNAPSHOT_BLOB);
  return snapshot?.version ?? 0;
}
async function pushSnapshot(ctx, options = {}) {
  const token = readToken();
  if (!token) throw AppError.unauthorized("未登录同步服务");
  const scopes = getSettings().sync?.scopes;
  const entities = [];
  if (scopes?.connections !== false) entities.push("Server");
  if (scopes?.groups !== false) entities.push("Group");
  if (scopes?.credentials !== false) entities.push("Credential");
  if (scopes?.notes !== false) entities.push("Note", "NoteFolder");
  if (scopes?.settings !== false) entities.push("Settings");
  if (entities.length === 0) {
    throw AppError.badRequest("同步范围全部关闭：请在同步设置里至少开启一项");
  }
  const { data, counts } = getStoreService().renderBackup(requirePassphrase(), entities);
  const ciphertext = data.toString("base64");
  state.state = "syncing";
  emitState(ctx);
  const result = await callWithStateFallback(ctx, `/api/v1/blobs/${SNAPSHOT_BLOB}`, {
    method: "PUT",
    token,
    body: {
      ciphertext,
      // 乐观并发：基于已知版本提交；force 时不带 baseVersion（强制覆盖）
      ...options.force ? {} : { baseVersion: state.lastVersion ?? 0 }
    }
  });
  if (result.status !== 200) {
    state.state = "error";
    const err = toAppError(result, "上传失败");
    state.lastError = err.message;
    emitState(ctx);
    throw err;
  }
  const body = result.body;
  state.lastVersion = body.version;
  state.state = "idle";
  state.lastSyncAt = (/* @__PURE__ */ new Date()).toISOString();
  state.lastError = void 0;
  emitState(ctx);
  log.info(`已上传快照 version=${body.version} bytes=${data.byteLength}`);
  return { version: body.version, bytes: data.byteLength, counts };
}
async function callWithStateFallback(ctx, path, options) {
  try {
    return await call(path, options);
  } catch (err) {
    state.state = "error";
    state.lastError = err instanceof Error ? err.message : String(err);
    emitState(ctx);
    throw err;
  }
}
async function pullSnapshot(ctx, options = {}) {
  const token = readToken();
  if (!token) throw AppError.unauthorized("未登录同步服务");
  state.state = "syncing";
  emitState(ctx);
  const result = await callWithStateFallback(ctx, `/api/v1/blobs/${SNAPSHOT_BLOB}`, { token });
  if (result.status === 404) {
    state.state = "idle";
    emitState(ctx);
    throw AppError.notFound("远端还没有快照，请先上传一次");
  }
  if (result.status !== 200) {
    state.state = "error";
    const err = toAppError(result, "下载失败");
    state.lastError = err.message;
    emitState(ctx);
    throw err;
  }
  const body = result.body;
  const data = Buffer.from(body.ciphertext, "base64");
  const imported = getStoreService().importBackup(data, {
    passphrase: requirePassphrase(),
    mode: options.mode ?? "merge"
  });
  state.lastVersion = body.version;
  state.state = "idle";
  state.lastSyncAt = (/* @__PURE__ */ new Date()).toISOString();
  state.lastError = void 0;
  emitState(ctx);
  log.info(`已拉取快照 version=${body.version}`);
  return { version: body.version, imported };
}
const statusSchema = z.object({}).optional();
const loginSchema = z.object({
  endpoint: z.string().min(1),
  username: z.string().min(1),
  password: z.string().min(1),
  /** 没有账号时先注册 */
  register: z.boolean().optional(),
  /**
   * 同步口令（仓库密码）。与登录口令相互独立：
   * 新设备只要知道它就能解密云端数据。首次设置后本地加密保存，之后可不传。
   */
  passphrase: z.string().min(8).optional()
});
const pushSchema = z.object({ force: z.boolean().optional() });
const pullSchema = z.object({ mode: z.enum(["replace", "merge"]).optional() });
const resolveSchema = z.object({
  /** 冲突时保留哪一侧 */
  keep: z.enum(["local", "remote"])
});
const syncHandlers = {
  /** 设置传输方式；显式指定，不按探测回退（规范 §3.3.1） */
  setTransport: (payload) => {
    const { transport } = parseInput(
      z.object({ transport: z.enum(["http", "tsc1"]) }),
      payload
    );
    updateSyncSettings({ transport });
    return { transport };
  },
  /**
   * 探测 TSC/1 服务端身份。
   *
   * 只做一次握手拿到指纹与公钥，**不发送任何应用数据**、也不写入钉扎 ——
   * 用户需要在另一条可信渠道（服务器本机日志）核对指纹后才调用 `trustServer`。
   */
  inspectServer: async () => {
    const { host, port } = tsc1Target();
    const probed = await SecureChannel.probe(host, port);
    return {
      fingerprint: probed.fingerprint,
      // 公钥回传是为了让界面能把它交给 trustServer；它本身不是秘密，
      // 但**指纹才是用户要核对的东西**
      publicKey: probed.publicKey.toString("base64")
    };
  },
  /** 用户确认指纹一致后写入钉扎 */
  trustServer: (payload) => {
    const { fingerprint, publicKey } = parseInput(
      z.object({ fingerprint: z.string().min(1), publicKey: z.string().min(1) }),
      payload
    );
    const expect = fingerprintOf(Buffer.from(publicKey, "base64")).replace(/ /g, "");
    if (expect !== fingerprint.replace(/ /g, "")) {
      throw AppError.badRequest("指纹与公钥不匹配（两者必须来自同一次探测）");
    }
    updateSyncSettings({ pin: { fingerprint: expect, publicKey } });
    state.state = "idle";
    return { pinned: true, fingerprint: expect };
  },
  /** 清除钉扎（服务端确实换了密钥时才用；之后会重新走首次连接流程） */
  forgetServer: () => {
    updateSyncSettings({ pin: null });
    closeAllChannels();
    return { pinned: false };
  },
  status: (payload) => {
    parseInput(statusSchema, payload ?? {});
    const settings = getSyncSettings();
    return {
      enabled: settings.enabled,
      endpoint: settings.endpoint ?? "",
      autoSync: settings.autoSync,
      /** 只回是否已登录，不回令牌本身 */
      loggedIn: Boolean(settings.token),
      state: state.state,
      lastSyncAt: state.lastSyncAt ?? null,
      lastVersion: state.lastVersion ?? null,
      lastError: state.lastError ?? null,
      conflictPolicy: settings.conflictPolicy,
      /**
       * 当前传输方式与钉扎状态；界面需展示，避免用户在未加密传输下同步。
       */
      transport: settings.transport ?? "tsc1",
      pinned: settings.pin != null,
      /** 已钉扎的指纹（可展示给用户核对；它本身不是秘密） */
      pinnedFingerprint: settings.pin?.fingerprint ?? null
    };
  },
  /** 登录（或注册后登录），成功即保存令牌与地址 */
  login: async (payload) => {
    const input = parseInput(loginSchema, payload);
    updateSyncSettings({ endpoint: input.endpoint, enabled: true });
    const path = input.register ? "/api/v1/register" : "/api/v1/login";
    const result = await call(path, {
      method: "POST",
      body: { username: input.username, password: input.password }
    });
    if (result.status !== 200) {
      throw toAppError(result, input.register ? "注册失败" : "登录失败");
    }
    const body = result.body;
    writeToken(body.token);
    if (input.passphrase) writePassphrase(input.passphrase);
    state.lastVersion = await refreshRemoteVersion(body.token);
    state.lastError = void 0;
    state.state = "idle";
    log.info(`同步已登录: ${body.username}（远端快照版本 ${state.lastVersion}）`);
    return {
      username: body.username,
      endpoint: input.endpoint,
      remoteVersion: state.lastVersion,
      hasPassphrase: Boolean(readPassphrase())
    };
  },
  logout: () => {
    const token = readToken();
    clearToken();
    state.lastVersion = void 0;
    if (token) {
      void call("/api/v1/logout", { method: "POST", token }).catch(() => {
      });
    }
    return { loggedOut: true };
  },
  push: (payload, ctx) => {
    const { force } = parseInput(pushSchema, payload ?? {});
    return pushSnapshot(ctx, force !== void 0 ? { force } : {});
  },
  pull: (payload, ctx) => {
    const { mode } = parseInput(pullSchema, payload ?? {});
    return pullSnapshot(ctx, mode !== void 0 ? { mode } : {});
  },
  /**
   * 冲突处置。
   * 本地保留 = 强制上传覆盖；远端优先 = 直接拉取覆盖本地。
   */
  resolveConflict: async (payload, ctx) => {
    const { keep } = parseInput(resolveSchema, payload);
    if (keep === "local") {
      const r2 = await pushSnapshot(ctx, { force: true });
      return { resolved: "local", version: r2.version };
    }
    const r = await pullSnapshot(ctx, { mode: "replace" });
    return { resolved: "remote", version: r.version };
  }
};
export {
  syncHandlers
};
