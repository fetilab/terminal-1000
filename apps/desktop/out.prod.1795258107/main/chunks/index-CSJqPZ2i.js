import { createWriteStream, createReadStream, existsSync, mkdirSync, writeFileSync, readdirSync, readFileSync, statSync, openSync, readSync, closeSync, unlinkSync } from "node:fs";
import { join, basename } from "node:path";
import { z } from "zod";
import { unlink, stat } from "node:fs/promises";
import { createGunzip, createGzip } from "node:zlib";
import { pipeline } from "node:stream/promises";
import { p as parseInput, o as readRecordingSettings, q as updateRecordingSettings, s as subscribeSessionClosed, A as AppError, t as subscribeSessionData, c as createLogger } from "../index.js";
import "electron";
import "node:child_process";
import "node:net";
import "node:url";
import "better-sqlite3";
import "node:crypto";
import "node:os";
const MIN_INTERVAL_MS = 1e3;
const MAX_INTERVAL_MS = 60 * 60 * 1e3;
const DEFAULT_RECORDING_SETTINGS = {
  enabled: false,
  intervalMs: 5e3,
  autoCompress: true
};
function normalizeRecordingSettings(patch, base = DEFAULT_RECORDING_SETTINGS) {
  const out = { ...base };
  if (patch === null || typeof patch !== "object") return out;
  const raw = patch;
  if (typeof raw["enabled"] === "boolean") out.enabled = raw["enabled"];
  if (typeof raw["autoCompress"] === "boolean") out.autoCompress = raw["autoCompress"];
  if (raw["intervalMs"] !== void 0) out.intervalMs = clampInterval(raw["intervalMs"]);
  return out;
}
function clampInterval(value) {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return DEFAULT_RECORDING_SETTINGS.intervalMs;
  return Math.min(MAX_INTERVAL_MS, Math.max(MIN_INTERVAL_MS, Math.trunc(n)));
}
const RECORDING_FORMAT_VERSION = 1;
function encodeHeader(header) {
  return `${JSON.stringify(header)}
`;
}
function encodeFrame(frame) {
  return `${JSON.stringify({ t: frame.t, d: frame.d })}
`;
}
function parseRecordingLine(line) {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const obj = parsed;
  if (obj["kind"] === "session-recording") {
    if (typeof obj["logId"] !== "string" || typeof obj["sessionId"] !== "string") return null;
    const header = {
      v: typeof obj["v"] === "number" ? obj["v"] : RECORDING_FORMAT_VERSION,
      kind: "session-recording",
      logId: obj["logId"],
      sessionId: obj["sessionId"],
      title: typeof obj["title"] === "string" ? obj["title"] : obj["sessionId"],
      startedAt: typeof obj["startedAt"] === "string" ? obj["startedAt"] : (/* @__PURE__ */ new Date(0)).toISOString(),
      intervalMs: typeof obj["intervalMs"] === "number" ? obj["intervalMs"] : 0
    };
    if (typeof obj["cols"] === "number") header.cols = obj["cols"];
    if (typeof obj["rows"] === "number") header.rows = obj["rows"];
    return { kind: "header", header };
  }
  if (typeof obj["t"] === "number" && typeof obj["d"] === "string") {
    return { kind: "frame", frame: { t: obj["t"], d: obj["d"] } };
  }
  return null;
}
async function gzipFile(src, dst) {
  await pipeline(createReadStream(src), createGzip({ level: 6 }), createWriteStream(dst));
  const { size } = await stat(dst);
  return size;
}
const systemRecordingTimer = {
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (handle) => clearInterval(handle)
};
class RecordingWriter {
  constructor(options) {
    this.stream = null;
    this.handle = null;
    this.buffer = [];
    this.bufferedCount = 0;
    this.frameCount = 0;
    this.skipped = 0;
    this.bytes = 0;
    this.stopped = false;
    this.startedAtMs = 0;
    this.lastFrameT = 0;
    this.pending = [];
    this.path = options.path;
    this.intervalMs = clampInterval(options.intervalMs);
    this.clock = options.clock ?? (() => Date.now());
    this.timer = options.timer ?? systemRecordingTimer;
    this.createStream = options.createStream ?? ((p) => createWriteStream(p, { flags: "w" }));
    this.onError = options.onError ?? (() => {
    });
    this.header = {
      v: RECORDING_FORMAT_VERSION,
      kind: "session-recording",
      ...options.header,
      intervalMs: this.intervalMs
    };
  }
  get filePath() {
    return this.path;
  }
  get frames() {
    return this.frameCount;
  }
  get skippedTicks() {
    return this.skipped;
  }
  get pendingChars() {
    return this.bufferedCount;
  }
  get isStopped() {
    return this.stopped;
  }
  /** 打开文件、写 header、启动定时合并 */
  start() {
    if (this.stream !== null) return;
    this.startedAtMs = this.clock();
    const stream = this.createStream(this.path);
    stream.on("error", (err) => this.onError(err));
    this.stream = stream;
    this.write(encodeHeader(this.header));
    this.handle = this.timer.setInterval(() => {
      this.tick();
    }, this.intervalMs);
  }
  /** 缓冲一段输出（不立刻落盘：等间隔合并成帧） */
  push(chunk) {
    if (this.stopped || chunk.length === 0) return;
    this.buffer.push(chunk);
    this.bufferedCount += chunk.length;
  }
  /**
   * 一个间隔到点：有内容才写帧。
   *
   * **缓冲为空 → 跳过**：这就是 spec 说的"仅保存与上一帧不同的内容（增量录制）"。
   * 返回 'skipped' 时调用方可以据此统计（`skippedTicks`）。
   */
  tick() {
    if (this.stopped) return "skipped";
    if (this.bufferedCount === 0) {
      this.skipped += 1;
      return "skipped";
    }
    const data = this.buffer.join("");
    this.buffer.length = 0;
    this.bufferedCount = 0;
    const t = Math.max(0, this.clock() - this.startedAtMs);
    this.write(encodeFrame({ t, d: data }));
    this.frameCount += 1;
    this.lastFrameT = t;
    return "written";
  }
  /** 结束录制：补最后一帧 → 关闭流 →（可选）压缩 */
  async stop(options = {}) {
    if (this.stopped) return this.summary(false);
    if (this.bufferedCount > 0) this.tick();
    this.clearTimer();
    await this.flush();
    await this.close();
    this.stopped = true;
    let compressed = false;
    let gzPath;
    let gzBytes;
    if (options.compress === true && this.bytes > 0) {
      const target = `${this.path}.gz`;
      try {
        gzBytes = await gzipFile(this.path, target);
        await unlink(this.path);
        compressed = true;
        gzPath = target;
      } catch (err) {
        this.onError(err instanceof Error ? err : new Error(String(err)));
      }
    }
    return this.summary(compressed, gzPath, gzBytes);
  }
  /**
   * 等到已提交的写入真正落盘。
   *
   * WriteStream 内部有缓冲，`write()` 返回时数据可能还没到磁盘 ——
   * 录制中要读文件（测试、以及"边录边看"）就必须先 flush。
   */
  async flush() {
    const waiting = this.pending;
    this.pending = [];
    await Promise.all(waiting);
  }
  /** 不关闭流的快照信息（录制中也可读） */
  liveStats() {
    return {
      frames: this.frameCount,
      skippedTicks: this.skipped,
      bytes: this.bytes,
      pendingChars: this.bufferedCount
    };
  }
  summary(compressed, gzPath, gzBytes) {
    const out = {
      path: this.path,
      frames: this.frameCount,
      skippedTicks: this.skipped,
      bytes: this.bytes,
      durationMs: Math.max(this.lastFrameT, this.clock() - this.startedAtMs),
      compressed
    };
    if (gzPath !== void 0) out.gzPath = gzPath;
    if (gzBytes !== void 0) out.gzBytes = gzBytes;
    return out;
  }
  write(line) {
    const stream = this.stream;
    if (stream === null) return;
    this.bytes += Buffer.byteLength(line);
    this.pending.push(
      new Promise((resolve) => {
        try {
          stream.write(line, () => resolve());
        } catch (err) {
          this.onError(err instanceof Error ? err : new Error(String(err)));
          resolve();
        }
      })
    );
  }
  clearTimer() {
    if (this.handle === null) return;
    this.timer.clearInterval(this.handle);
    this.handle = null;
  }
  close() {
    const stream = this.stream;
    this.stream = null;
    if (stream === null) return Promise.resolve();
    return new Promise((resolve) => {
      try {
        stream.end(() => resolve());
      } catch {
        resolve();
      }
    });
  }
}
async function readRecordingLines(filePath, onLine, compressed) {
  const source = compressed ? createReadStream(filePath).pipe(createGunzip()) : createReadStream(filePath);
  let carry = "";
  for await (const chunk of source) {
    carry += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    let index = carry.indexOf("\n");
    while (index >= 0) {
      const line = carry.slice(0, index);
      carry = carry.slice(index + 1);
      const parsed = parseRecordingLine(line);
      if (parsed !== null) onLine(parsed);
      index = carry.indexOf("\n");
    }
  }
  const last = parseRecordingLine(carry);
  if (last !== null) onLine(last);
}
const log = createLogger("sessionlog");
function maxLogBytes() {
  const raw = process.env.T1000_MAX_SESSIONLOG_BYTES;
  const n = raw ? Number(raw) : 64 * 1024 * 1024;
  return Number.isFinite(n) && n > 0 ? n : 64 * 1024 * 1024;
}
const DEFAULT_READ_LIMIT = 256 * 1024;
function safeFileSegment(raw, fallback) {
  const cleaned = raw.replace(/[/\\:*?"<>|\u0000-\u001f]/g, "_").replace(/\.{2,}/g, "_").replace(/\s+/g, "_").slice(0, 60).trim();
  return cleaned.length > 0 ? cleaned : fallback;
}
function timestamp(d = /* @__PURE__ */ new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
class SessionLogService {
  constructor(logDir, options = {}) {
    this.logDir = logDir;
    this.options = options;
    this.recordings = /* @__PURE__ */ new Map();
    this.lastStopped = [];
    if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });
  }
  /** 当前生效的录制设置（外部输入一律过 normalize，间隔 <1s 会被抬到 1s） */
  recordingSettings() {
    return normalizeRecordingSettings(this.options.loadSettings?.() ?? DEFAULT_RECORDING_SETTINGS);
  }
  metaPath(logId) {
    return join(this.logDir, `${logId}.meta.json`);
  }
  writeMeta(meta) {
    try {
      writeFileSync(this.metaPath(meta.logId), JSON.stringify(meta, null, 2));
    } catch (err) {
      log.warn("写入日志元信息失败", err);
    }
  }
  /**
   * 开始录制。
   * @returns logId（供 stop / read / delete 使用）
   */
  start(sessionId, title, startOptions = {}) {
    if (this.recordings.has(sessionId)) {
      throw AppError.conflict("该会话已在录制中");
    }
    const logId = `${timestamp()}-${safeFileSegment(title ?? sessionId, "session")}-${sessionId.slice(0, 8)}`;
    const logPath = join(this.logDir, `${logId}.log`);
    const timingPath = join(this.logDir, `${logId}.timing`);
    const settings = this.recordingSettings();
    const wantSnapshot = settings.enabled || startOptions.snapshot === true;
    const recPath = join(this.logDir, `${logId}.rec`);
    const startedAt = this.options.now?.() ?? Date.now();
    const recording = {
      logId,
      sessionId,
      title: title ?? sessionId,
      logPath,
      timingPath,
      recPath: wantSnapshot ? recPath : "",
      logStream: createWriteStream(logPath, { flags: "a" }),
      timingStream: createWriteStream(timingPath, { flags: "a" }),
      writer: null,
      intervalMs: settings.intervalMs,
      startedAt,
      bytes: 0,
      stopped: false,
      unsubscribe: () => {
      }
    };
    if (wantSnapshot) {
      const writer = new RecordingWriter({
        path: recPath,
        intervalMs: settings.intervalMs,
        header: {
          logId,
          sessionId,
          title: recording.title,
          startedAt: new Date(startedAt).toISOString(),
          ...startOptions.cols === void 0 ? {} : { cols: startOptions.cols },
          ...startOptions.rows === void 0 ? {} : { rows: startOptions.rows }
        },
        ...this.options.now === void 0 ? {} : { clock: this.options.now },
        ...this.options.timer === void 0 ? {} : { timer: this.options.timer },
        onError: (err) => {
          log.warn(`快照录制写入失败（停止录制）: ${err.message}`);
          this.stop(sessionId, `快照写入失败：${err.message}`);
        }
      });
      writer.start();
      recording.writer = writer;
    }
    const onStreamError = (err) => {
      if (recording.stopped) return;
      log.warn(`录制写入失败（停止录制）: ${err.message}`);
      this.stop(sessionId, `写入失败：${err.message}`);
    };
    recording.logStream.on("error", onStreamError);
    recording.timingStream.on("error", onStreamError);
    recording.unsubscribe = subscribeSessionData(sessionId, (chunk) => {
      this.append(recording, chunk);
    });
    this.recordings.set(sessionId, recording);
    this.writeMeta({
      logId,
      sessionId,
      title: recording.title,
      startedAt: new Date(startedAt).toISOString(),
      bytes: 0
    });
    log.info(
      `开始录制会话 ${sessionId} → ${basename(logPath)}${wantSnapshot ? `（快照，间隔 ${settings.intervalMs}ms）` : ""}`
    );
    return wantSnapshot ? { logId, logPath, recPath, frames: 0 } : { logId, logPath };
  }
  /** 追加一段输出（含上限保护） */
  append(recording, chunk) {
    if (recording.stopped || chunk.length === 0) return;
    const limit = maxLogBytes();
    if (recording.bytes + chunk.length > limit) {
      this.stop(recording.sessionId, `已达大小上限 ${Math.round(limit / 1024 / 1024)}MB，自动停止`);
      return;
    }
    recording.bytes += chunk.length;
    recording.logStream.write(chunk);
    recording.writer?.push(chunk);
    recording.timingStream.write(`${JSON.stringify({ t: Date.now() - recording.startedAt, n: chunk.length })}
`);
  }
  /**
   * 停止录制（不传 sessionId 则停全部）。
   *
   * 保持**同步**契约（既有调用方如 ssh 断开时是 fire-and-forget）：
   * 文本日志与元信息立刻落盘；快照的补帧/压缩是异步的，由 `finalize()` 完成。
   * 需要拿到压缩结果时用 `stopAndFinalize()`。
   */
  stop(sessionId, reason = "用户停止") {
    const pending = this.finalize(sessionId, reason);
    pending.catch((err) => log.warn("录制收尾失败", err));
    return { stopped: this.lastStopped };
  }
  /** 停止并等待快照收尾（补最后一帧 + 可选压缩）完成 */
  async stopAndFinalize(sessionId, reason = "用户停止") {
    return this.finalize(sessionId, reason);
  }
  async finalize(sessionId, reason) {
    const targets = sessionId ? [sessionId] : [...this.recordings.keys()];
    const stopped = [];
    const summaries = [];
    const settings = this.recordingSettings();
    const pending = [];
    for (const id of targets) {
      const rec = this.recordings.get(id);
      if (!rec || rec.stopped) continue;
      rec.stopped = true;
      rec.unsubscribe();
      try {
        rec.logStream.end();
        rec.timingStream.end();
      } catch {
      }
      const writer = rec.writer;
      const meta = {
        logId: rec.logId,
        sessionId: rec.sessionId,
        title: rec.title,
        startedAt: new Date(rec.startedAt).toISOString(),
        stoppedAt: (/* @__PURE__ */ new Date()).toISOString(),
        bytes: rec.bytes,
        stopReason: reason,
        ...writer === null ? {} : { intervalMs: rec.intervalMs, ...writer.liveStats() }
      };
      this.writeMeta(meta);
      if (writer !== null) {
        const done = writer.stop({ compress: settings.autoCompress }).then((summary) => {
          summaries.push(summary);
          this.writeMeta({
            ...meta,
            frames: summary.frames,
            skippedTicks: summary.skippedTicks,
            recBytes: summary.gzBytes === void 0 ? summary.bytes : summary.bytes,
            ...summary.gzBytes === void 0 ? {} : { gzBytes: summary.gzBytes },
            compressed: summary.compressed
          });
          log.info(
            `快照收尾 ${rec.logId}：${summary.frames} 帧 / 跳过 ${summary.skippedTicks} 次 / ${summary.bytes} 字节${summary.compressed ? ` → ${summary.gzBytes} 字节（gzip）` : ""}`
          );
        }).catch((err) => {
          log.warn("快照收尾失败（保留 .rec）", err);
        });
        pending.push(done);
      }
      this.recordings.delete(id);
      stopped.push(rec.logId);
      log.info(`停止录制 ${rec.logId}（${reason}，${rec.bytes} 字节）`);
    }
    this.lastStopped = stopped;
    await Promise.all(pending);
    return { stopped, recordings: summaries };
  }
  /** 会话断开时自动收尾（由 ssh 服务在会话关闭时调用） */
  stopBySession(sessionId) {
    this.stop(sessionId, "会话已断开");
  }
  /** 正在录制的会话 */
  active() {
    return [...this.recordings.values()].map((r) => {
      const stats = r.writer?.liveStats();
      return {
        sessionId: r.sessionId,
        logId: r.logId,
        title: r.title,
        bytes: r.bytes,
        startedAt: new Date(r.startedAt).toISOString(),
        recording: r.writer !== null,
        frames: stats?.frames ?? 0,
        skippedTicks: stats?.skippedTicks ?? 0
      };
    });
  }
  /** 列出已保存的日志（按开始时间倒序） */
  list() {
    let files = [];
    try {
      files = readdirSync(this.logDir);
    } catch {
      return [];
    }
    const metas = [];
    for (const f of files) {
      if (!f.endsWith(".meta.json")) continue;
      try {
        const meta = JSON.parse(readFileSync(join(this.logDir, f), "utf8"));
        const logFile = join(this.logDir, `${meta.logId}.log`);
        const timingFile = join(this.logDir, `${meta.logId}.timing`);
        const recFile = join(this.logDir, `${meta.logId}.rec`);
        const gzFile = join(this.logDir, `${meta.logId}.rec.gz`);
        const hasGz = existsSync(gzFile);
        const hasRec = existsSync(recFile);
        metas.push({
          ...meta,
          sizeBytes: existsSync(logFile) ? statSync(logFile).size : 0,
          hasTiming: existsSync(timingFile),
          hasRecording: hasRec || hasGz,
          recBytes: hasGz ? statSync(gzFile).size : hasRec ? statSync(recFile).size : 0
        });
      } catch {
      }
    }
    return metas.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }
  /**
   * 读取日志内容。
   * 默认从**末尾**往回读（终端场景通常关心最近发生了什么），
   * 并限制单次返回量，避免把几十 MB 一次性推给渲染层。
   */
  read(logId, options = {}) {
    const logPath = join(this.logDir, `${safeFileSegment(logId, "")}.log`);
    const exact = join(this.logDir, `${logId}.log`);
    const target = existsSync(exact) ? exact : logPath;
    if (!existsSync(target)) throw AppError.notFound(`日志不存在: ${logId}`);
    const totalBytes = statSync(target).size;
    const limit = options.limit ?? DEFAULT_READ_LIMIT;
    const fromEnd = options.fromEnd ?? true;
    let start;
    if (fromEnd) {
      const tailStart = Math.max(0, totalBytes - limit);
      start = options.offset !== void 0 ? Math.max(0, Math.min(options.offset, totalBytes)) : tailStart;
    } else {
      start = Math.max(0, options.offset ?? 0);
    }
    const end = Math.min(totalBytes, start + limit);
    const fd = openSync(target, "r");
    try {
      const buf = Buffer.alloc(end - start);
      readSync(fd, buf, 0, buf.length, start);
      const hasMoreBefore = start > 0;
      const hasMoreAfter = end < totalBytes;
      return {
        logId,
        content: buf.toString("utf8"),
        offset: start,
        totalBytes,
        hasMoreBefore,
        hasMoreAfter,
        hasMore: hasMoreBefore || hasMoreAfter
      };
    } finally {
      closeSync(fd);
    }
  }
  /** 删除日志（连同时间线与元信息） */
  /**
   * 回放数据读取：按**时间区间**取快照帧（不把整场录制塞给渲染层）。
   *
   * - `fromMs` / `toMs`：相对录制开始的毫秒区间（闭开区间 [from, to)）
   * - `limit`：本次最多返回多少帧（默认 2000，上限 20000）；超出时 `hasMore=true`
   * - `totalMs`：整场录制的总时长（渲染层用它画进度条）
   *
   * 实现是流式扫一遍文件：内存只保留窗口内的帧（有 limit 上限），
   * 时间轴信息在全扫描中得到。`.rec` 与 `.rec.gz` 都能读。
   */
  async replay(logId, options = {}) {
    const { filePath, compressed } = this.locateRecording(logId);
    const fromMs = Math.max(0, options.fromMs ?? 0);
    const toMs = options.toMs === void 0 ? null : Math.max(0, options.toMs);
    const limit = Math.min(2e4, Math.max(1, Math.trunc(options.limit ?? 2e3)));
    const frames = [];
    let frameCount = 0;
    let totalMs = 0;
    let hasMore = false;
    let header = { intervalMs: 0 };
    await readRecordingLines(
      filePath,
      (line) => {
        if (line.kind === "header") {
          header = {
            intervalMs: line.header.intervalMs,
            ...line.header.cols === void 0 ? {} : { cols: line.header.cols },
            ...line.header.rows === void 0 ? {} : { rows: line.header.rows }
          };
          return;
        }
        const { t, d } = line.frame;
        if (t > totalMs) totalMs = t;
        if (t < fromMs) return;
        if (toMs !== null && t >= toMs) return;
        frameCount += 1;
        if (frames.length < limit) frames.push({ tMs: t, data: d });
        else hasMore = true;
      },
      compressed
    );
    return {
      logId,
      frames,
      fromMs,
      toMs,
      totalMs,
      frameCount,
      hasMore,
      intervalMs: header.intervalMs,
      ...header.cols === void 0 ? {} : { cols: header.cols },
      ...header.rows === void 0 ? {} : { rows: header.rows },
      compressed,
      path: filePath
    };
  }
  /** 找到某场录制的快照文件（优先压缩版）；没有则报 NOT_FOUND */
  locateRecording(logId) {
    const gz = join(this.logDir, `${logId}.rec.gz`);
    if (existsSync(gz)) return { filePath: gz, compressed: true };
    const rec = join(this.logDir, `${logId}.rec`);
    if (existsSync(rec)) return { filePath: rec, compressed: false };
    throw AppError.notFound(`该录制没有快照数据: ${logId}`);
  }
  remove(logId) {
    const files = [
      `${logId}.log`,
      `${logId}.timing`,
      `${logId}.rec`,
      `${logId}.rec.gz`,
      `${logId}.meta.json`
    ];
    let deleted = false;
    for (const f of files) {
      const p = join(this.logDir, f);
      if (existsSync(p)) {
        try {
          unlinkSync(p);
          deleted = true;
        } catch (err) {
          log.warn(`删除失败 ${p}`, err);
        }
      }
    }
    if (!deleted) throw AppError.notFound(`日志不存在: ${logId}`);
    return { deleted: true };
  }
}
let service = null;
function readRecordingSettingsFromSettings() {
  try {
    return normalizeRecordingSettings(readRecordingSettings());
  } catch {
    return DEFAULT_RECORDING_SETTINGS;
  }
}
function updateRecordingSettingsFromSettings(patch) {
  const next = normalizeRecordingSettings({ ...readRecordingSettings(), ...patch });
  updateRecordingSettings({ ...next });
  return next;
}
let closedWired = false;
function getSessionLogService(logDir) {
  if (!service) {
    service = new SessionLogService(logDir, {
      // 录制设置存在设置域文档里（`sessionRecording` 分组）。
      // 延迟到调用时读取，避免模块加载期就去碰 store。
      loadSettings: () => readRecordingSettingsFromSettings()
    });
    if (!closedWired) {
      subscribeSessionClosed((sessionId) => {
        service?.stopBySession(sessionId);
      });
      closedWired = true;
    }
  }
  return service;
}
const startSchema = z.object({
  sessionId: z.string().min(1),
  cols: z.number().int().min(1).max(1e4).optional(),
  rows: z.number().int().min(1).max(1e4).optional(),
  /** 显式要求录制快照（即使设置里"是否录制"为关） */
  snapshot: z.boolean().optional(),
  title: z.string().max(200).optional()
});
const stopSchema = z.object({ sessionId: z.string().min(1).optional() });
const listSchema = z.object({});
const readSchema = z.object({
  logId: z.string().min(1),
  offset: z.number().int().min(0).optional(),
  limit: z.number().int().positive().max(16 * 1024 * 1024).optional(),
  fromEnd: z.boolean().optional()
});
const deleteSchema = z.object({ logId: z.string().min(1) });
const replaySchema = z.object({
  logId: z.string().min(1),
  fromMs: z.number().int().min(0).optional(),
  toMs: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).max(2e4).optional()
});
const recordingSettingsSchema = z.object({
  /** 是否录制终端数据 */
  enabled: z.boolean().optional(),
  /** 快照间隔（毫秒）；<1000 会被抬到 1000 */
  intervalMs: z.number().int().optional(),
  /** 停止录制时自动压缩 */
  autoCompress: z.boolean().optional()
});
const sessionlogHandlers = {
  start: (payload, ctx) => {
    const { sessionId, title, cols, rows, snapshot } = parseInput(startSchema, payload);
    return getSessionLogService(ctx.paths.sessionLogDir).start(sessionId, title, {
      ...cols === void 0 ? {} : { cols },
      ...rows === void 0 ? {} : { rows },
      ...snapshot === void 0 ? {} : { snapshot }
    });
  },
  /** 停止并**等待**快照收尾（补帧 + 可选压缩）完成，返回每场录制的汇总 */
  stop: async (payload, ctx) => {
    const { sessionId } = parseInput(stopSchema, payload ?? {});
    return getSessionLogService(ctx.paths.sessionLogDir).stopAndFinalize(sessionId);
  },
  /** 列出已保存日志 + 正在录制的会话 */
  list: (payload, ctx) => {
    parseInput(listSchema, payload ?? {});
    const svc = getSessionLogService(ctx.paths.sessionLogDir);
    return { logs: svc.list(), active: svc.active() };
  },
  read: (payload, ctx) => {
    const { logId, offset, limit, fromEnd } = parseInput(readSchema, payload);
    return getSessionLogService(ctx.paths.sessionLogDir).read(logId, {
      ...offset !== void 0 ? { offset } : {},
      ...limit !== void 0 ? { limit } : {},
      ...fromEnd !== void 0 ? { fromEnd } : {}
    });
  },
  delete: (payload, ctx) => {
    const { logId } = parseInput(deleteSchema, payload);
    return getSessionLogService(ctx.paths.sessionLogDir).remove(logId);
  },
  /**
   * 回放：按时间区间取快照帧（播放/暂停/拖拽/逐帧/变速都由渲染层实现，
   * 主进程只负责"给我某个时间区间的帧"）。
   */
  replay: (payload, ctx) => {
    const { logId, fromMs, toMs, limit } = parseInput(replaySchema, payload);
    return getSessionLogService(ctx.paths.sessionLogDir).replay(logId, {
      ...fromMs === void 0 ? {} : { fromMs },
      ...toMs === void 0 ? {} : { toMs },
      ...limit === void 0 ? {} : { limit }
    });
  },
  /** 读录制设置（间隔下限、自动压缩、是否录制） */
  getSettings: (_payload, ctx) => {
    return getSessionLogService(ctx.paths.sessionLogDir).recordingSettings();
  },
  /** 改录制设置（间隔 <1000ms 会被抬到 1000ms） */
  setSettings: (payload, ctx) => {
    const patch = parseInput(recordingSettingsSchema, payload ?? {});
    return updateRecordingSettingsFromSettings(patch);
  }
};
export {
  SessionLogService,
  getSessionLogService,
  sessionlogHandlers
};
