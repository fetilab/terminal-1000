import { createHash, randomUUID } from "node:crypto";
import * as fsp from "node:fs/promises";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, join, sep } from "node:path";
import { homedir, tmpdir } from "node:os";
import { z } from "zod";
import { A as AppError, E as Events, c as createLogger, g as getWritable, s as subscribeSessionClosed, i as requireSession } from "../index.js";
import * as fs from "node:fs";
import { watch, existsSync, statSync, readFileSync } from "node:fs";
import "electron";
import "node:child_process";
import "node:net";
import "node:url";
import "better-sqlite3";
const NUL = "\0";
function reject(message, detail) {
  throw AppError.badRequest(message, detail);
}
function normalizeRemotePath(input, base = "/") {
  if (typeof input !== "string") reject("远端路径必须是字符串");
  if (input.length === 0) reject("远端路径不能为空");
  if (input.includes(NUL)) reject("远端路径包含非法字符 NUL");
  const absolute = input.startsWith("/");
  const rawSegments = absolute ? input.split("/") : joinSegments(base, input).split("/");
  const out = [];
  for (const seg of rawSegments) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (out.length === 0) {
        reject(`远端路径越界（试图逃出根目录）: ${input}`);
      }
      out.pop();
      continue;
    }
    out.push(seg);
  }
  return out.length === 0 ? "/" : `/${out.join("/")}`;
}
function joinRemotePath(...parts) {
  if (parts.length === 0) return "/";
  return normalizeRemotePath(joinSegments(...parts));
}
function joinSegments(...parts) {
  return parts.filter((p) => p !== "").map((p, i) => i === 0 ? p : p.replace(/^\/+/, "")).join("/");
}
function dirnameRemotePath(input) {
  const p = normalizeRemotePath(input);
  if (p === "/") return "/";
  const idx = p.lastIndexOf("/");
  return idx <= 0 ? "/" : p.slice(0, idx);
}
function basenameRemotePath(input) {
  const p = normalizeRemotePath(input);
  if (p === "/") return "/";
  return p.slice(p.lastIndexOf("/") + 1);
}
function assertSafeRemoteName(name) {
  if (typeof name !== "string") reject("远端名称必须是字符串");
  if (name.length === 0) reject("远端名称不能为空");
  if (name === "." || name === "..") reject(`远端名称不合法: ${name}`);
  if (name.includes("/")) reject(`远端名称不能包含 '/' : ${name}`);
  if (name.includes(NUL)) reject("远端名称包含非法字符 NUL");
  return name;
}
function numberedName(name, n) {
  assertSafeRemoteName(name);
  const dot = name.lastIndexOf(".");
  const hasExt = dot > 0 && dot < name.length - 1;
  if (!hasExt) return `${name} (${n})`;
  return `${name.slice(0, dot)} (${n})${name.slice(dot)}`;
}
function parseMode(input) {
  if (typeof input === "number") {
    if (!Number.isInteger(input) || input < 0 || input > 4095) {
      reject(`权限值不合法: ${input}`);
    }
    return input;
  }
  if (typeof input !== "string" || input.trim() === "") reject("权限值不能为空");
  const text = input.trim();
  const normalized = text.startsWith("0o") || text.startsWith("0O") ? text.slice(2) : text;
  if (!/^[0-7]{3,4}$/.test(normalized)) reject(`权限值不合法: ${input}`);
  return parseInt(normalized, 8);
}
function formatPermissions(mode) {
  const bits = mode & 511;
  const chars = ["---", "--x", "-w-", "-wx", "r--", "r-x", "rw-", "rwx"];
  return [6, 3, 0].map((shift) => chars[bits >> shift & 7] ?? "---").join("");
}
const MAX_REMOTE_READ_BYTES = 8 * 1024 * 1024;
function toSftpLike(wrapper) {
  return wrapper;
}
function promisifyVoid(call) {
  return new Promise((resolve, reject2) => {
    call((err) => err ? reject2(err) : resolve());
  });
}
function promisify(call) {
  return new Promise((resolve, reject2) => {
    call((err, value) => err ? reject2(err) : resolve(value));
  });
}
const sftpFs = {
  readdir: (s, p) => promisify((cb) => s.readdir(p, cb)),
  stat: (s, p) => promisify((cb) => s.stat(p, cb)),
  lstat: (s, p) => promisify((cb) => s.lstat(p, cb)),
  mkdir: (s, p, mode) => promisifyVoid((cb) => s.mkdir(p, mode === void 0 ? {} : { mode }, cb)),
  rmdir: (s, p) => promisifyVoid((cb) => s.rmdir(p, cb)),
  unlink: (s, p) => promisifyVoid((cb) => s.unlink(p, cb)),
  rename: (s, from, to) => promisifyVoid((cb) => s.rename(from, to, cb)),
  chmod: (s, p, mode) => promisifyVoid((cb) => s.chmod(p, mode, cb)),
  readFile: (s, p) => promisify((cb) => s.readFile(p, cb)),
  writeFile: (s, p, data) => promisifyVoid((cb) => s.writeFile(p, data, cb)),
  open: (s, p, mode) => promisify((cb) => s.open(p, mode, cb)),
  close: (s, h) => promisifyVoid((cb) => s.close(h, cb)),
  write: (s, h, b, off, len, pos) => promisifyVoid((cb) => s.write(h, b, off, len, pos, cb)),
  utimes: (s, p, atime, mtime) => {
    if (!s.utimes) return Promise.resolve();
    return promisifyVoid((cb) => s.utimes?.(p, atime, mtime, cb));
  },
  read: (s, h, b, off, len, pos) => new Promise((resolve, reject2) => {
    s.read(h, b, off, len, pos, (err, bytesRead) => err ? reject2(err) : resolve(bytesRead));
  })
};
function entryTypeOf(stats) {
  if (stats.isDirectory()) return "directory";
  if (stats.isSymbolicLink()) return "symlink";
  if (stats.isFile()) return "file";
  return "other";
}
function isSymlinkMode(mode) {
  return (mode & 61440) === 40960;
}
function toRemoteEntry(path, attrs, longname = "") {
  return {
    name: basenameRemotePath(path),
    path,
    type: entryTypeOf(attrs),
    size: attrs.size,
    mtime: attrs.mtime,
    mode: attrs.mode & 4095,
    permissions: formatPermissions(attrs.mode),
    uid: attrs.uid,
    gid: attrs.gid,
    longname
  };
}
async function listDirectory(sftp, remotePath2, options = {}) {
  const dir = normalizeRemotePath(remotePath2);
  const list = await sftpFs.readdir(sftp, dir);
  const entries = [];
  for (const item of list) {
    if (item.filename === "." || item.filename === "..") continue;
    if (!options.showHidden && item.filename.startsWith(".")) continue;
    const child = dir === "/" ? `/${item.filename}` : `${dir}/${item.filename}`;
    entries.push(toRemoteEntry(child, item.attrs, item.longname ?? ""));
  }
  entries.sort((a, b) => {
    const aDir = a.type === "directory" ? 0 : 1;
    const bDir = b.type === "directory" ? 0 : 1;
    if (aDir !== bDir) return aDir - bDir;
    return a.name.localeCompare(b.name, void 0, { numeric: true, sensitivity: "base" });
  });
  return entries;
}
async function statPath(sftp, remotePath2) {
  const p = normalizeRemotePath(remotePath2);
  const stats = await sftpFs.stat(sftp, p);
  return toRemoteEntry(p, stats);
}
async function pathExists(sftp, remotePath2) {
  try {
    await sftpFs.stat(sftp, normalizeRemotePath(remotePath2));
    return true;
  } catch (err) {
    if (isNoSuchFile(err)) return false;
    throw err;
  }
}
function isNoSuchFile(err) {
  const code = err?.code;
  if (code === 2 || code === "2" || code === "ENOENT" || code === "NO_SUCH_FILE") return true;
  const msg = err instanceof Error ? err.message : String(err);
  return /no such file/i.test(msg);
}
async function makeDirectory(sftp, remotePath2, mode) {
  const p = normalizeRemotePath(remotePath2);
  if (p === "/") throw AppError.badRequest("根目录已存在");
  const parsedMode = mode === void 0 ? void 0 : parseMode(mode);
  if (await pathExists(sftp, p)) {
    throw AppError.conflict(`目录已存在: ${p}`);
  }
  await sftpFs.mkdir(sftp, p, parsedMode);
  if (parsedMode !== void 0) await sftpFs.chmod(sftp, p, parsedMode);
  return statPath(sftp, p);
}
async function ensureRemoteDirectory(sftp, remotePath2, mode) {
  const target = normalizeRemotePath(remotePath2);
  if (target === "/") return "/";
  const segments = target.split("/").filter((s) => s !== "");
  let current = "";
  for (const seg of segments) {
    current += `/${seg}`;
    try {
      const stats = await sftpFs.stat(sftp, current);
      if (!stats.isDirectory()) {
        throw AppError.conflict(`路径已存在且不是目录: ${current}`);
      }
    } catch (err) {
      if (err instanceof AppError) throw err;
      if (!isNoSuchFile(err)) throw err;
      try {
        await sftpFs.mkdir(sftp, current, mode);
      } catch (mkErr) {
        if (isNoSuchFile(mkErr)) throw mkErr;
        const stats = await sftpFs.stat(sftp, current).catch(() => null);
        if (!stats?.isDirectory()) throw mkErr;
      }
    }
  }
  return target;
}
async function renamePath(sftp, from, to, options = {}) {
  const src = normalizeRemotePath(from);
  const dest = normalizeRemotePath(to);
  if (src === dest) return;
  if (dest === "/") throw AppError.badRequest("不能把路径重命名为根目录");
  if (await pathExists(sftp, dest)) {
    if (!options.overwrite) throw AppError.conflict(`目标已存在: ${dest}`);
    await removePath(sftp, dest, { recursive: true });
  }
  await sftpFs.rename(sftp, src, dest);
}
async function removePath(sftp, remotePath2, options = {}) {
  const p = normalizeRemotePath(remotePath2);
  if (p === "/") throw AppError.forbidden("拒绝删除根目录");
  const stats = await sftpFs.lstat(sftp, p);
  if (stats.isDirectory()) {
    if (!options.recursive) {
      await sftpFs.rmdir(sftp, p);
      return;
    }
    await removeDirectoryRecursive(sftp, p);
    return;
  }
  await sftpFs.unlink(sftp, p);
}
async function removeDirectoryRecursive(sftp, dir) {
  const list = await sftpFs.readdir(sftp, dir);
  for (const item of list) {
    if (item.filename === "." || item.filename === "..") continue;
    const child = dir === "/" ? `/${item.filename}` : `${dir}/${item.filename}`;
    const modeIsDir = (item.attrs.mode & 61440) === 16384;
    const isDir = typeof item.attrs.isDirectory === "function" ? item.attrs.isDirectory() : modeIsDir;
    const isLink = (item.attrs.mode & 61440) === 40960;
    if (isDir && !isLink) {
      await removeDirectoryRecursive(sftp, child);
    } else {
      await sftpFs.unlink(sftp, child);
    }
  }
  await sftpFs.rmdir(sftp, dir);
}
const MAX_CHMOD_ENTRIES = 5e3;
const MAX_PREVIEW_COMMANDS = 50;
function dirExecWarning(mode, recursive) {
  if (!recursive) return void 0;
  if ((mode & 73) !== 0) return void 0;
  return "该权限不含目录的执行位（x）：递归后**目录会变得无法进入**，其中所有文件也会随之不可访问（`chmod -R` 的固有行为）。若要保留可访问性，目录通常需要至少 700（如 755/750）。";
}
async function planChmod(sftp, remotePath2, mode, options = {}) {
  const p = normalizeRemotePath(remotePath2);
  const octal = parseMode(mode).toString(8).padStart(3, "0");
  const recursive = options.recursive === true;
  const stats = await sftpFs.lstat(sftp, p);
  const modeIsDir = (stats.mode & 61440) === 16384;
  const isDir = typeof stats.isDirectory === "function" ? stats.isDirectory() : modeIsDir;
  const isLink = (stats.mode & 61440) === 40960;
  if (!isDir || isLink || !recursive) {
    const summary2 = `chmod ${octal} ${p}`;
    const w2 = dirExecWarning(parseMode(mode), false);
    return {
      summary: summary2,
      entries: [p],
      commands: [summary2],
      truncated: false,
      ...w2 === void 0 ? {} : { warning: w2 }
    };
  }
  if (p === "/") throw AppError.forbidden("拒绝对根目录执行递归 chmod");
  const entries = [p];
  let truncated = false;
  const walk = async (dir) => {
    if (truncated) return;
    const list = await sftpFs.readdir(sftp, dir);
    for (const item of list) {
      if (item.filename === "." || item.filename === "..") continue;
      if (entries.length >= MAX_CHMOD_ENTRIES) {
        truncated = true;
        return;
      }
      const child = dir === "/" ? `/${item.filename}` : `${dir}/${item.filename}`;
      entries.push(child);
      const childMode = item.attrs.mode & 61440;
      const childIsDir = typeof item.attrs.isDirectory === "function" ? item.attrs.isDirectory() : childMode === 16384;
      const childIsLink = childMode === 40960;
      if (childIsDir && !childIsLink) await walk(child);
    }
  };
  await walk(p);
  const summary = `chmod -R ${octal} ${p}`;
  const commands = entries.slice(0, MAX_PREVIEW_COMMANDS).map((e) => `chmod ${octal} ${e}`);
  const w = dirExecWarning(parseMode(mode), true);
  return {
    summary,
    entries,
    commands,
    truncated,
    ...w === void 0 ? {} : { warning: w }
  };
}
async function chmodPath(sftp, remotePath2, mode, options = {}) {
  const numeric = parseMode(mode);
  const plan = await planChmod(sftp, remotePath2, numeric, options);
  const failed = [];
  let changed = 0;
  for (const entry of plan.entries) {
    try {
      await sftpFs.chmod(sftp, entry, numeric);
      changed += 1;
    } catch (err) {
      failed.push({ path: entry, message: err instanceof Error ? err.message : String(err) });
    }
  }
  return {
    changed,
    failed,
    commands: plan.commands,
    summary: plan.summary,
    truncated: plan.truncated,
    ...plan.warning === void 0 ? {} : { warning: plan.warning }
  };
}
async function readRemoteTextFile(sftp, remotePath2, options = {}) {
  const p = normalizeRemotePath(remotePath2);
  const max = options.maxBytes ?? MAX_REMOTE_READ_BYTES;
  const stats = await sftpFs.stat(sftp, p);
  if (stats.isDirectory()) throw AppError.badRequest(`目标是目录，不能按文件读取: ${p}`);
  if (stats.size > max) {
    throw AppError.badRequest(`文件过大（${stats.size} 字节 > 上限 ${max} 字节），已拒绝读取`, {
      size: stats.size,
      maxBytes: max
    });
  }
  const data = await sftpFs.readFile(sftp, p);
  return {
    path: p,
    content: data.toString("utf8"),
    size: data.length,
    mtime: stats.mtime,
    mode: stats.mode & 4095
  };
}
async function writeRemoteTextFile(sftp, remotePath2, content) {
  const p = normalizeRemotePath(remotePath2);
  const data = typeof content === "string" ? Buffer.from(content, "utf8") : content;
  await sftpFs.writeFile(sftp, p, data);
  return { path: p, size: data.length };
}
async function remoteHome(sftp) {
  if (!sftp.realpath) return "/";
  try {
    const abs = await promisify((cb) => sftp.realpath?.(".", cb));
    return normalizeRemotePath(abs);
  } catch {
    return "/";
  }
}
async function scanRemoteTree(sftp, root, options = {}) {
  const base = normalizeRemotePath(root);
  const progressEvery = options.progressEvery ?? 200;
  const maxDepth = options.maxDepth ?? 64;
  const maxEntries = options.maxEntries ?? 1e6;
  const files = [];
  const dirs = [];
  let bytesTotal = 0;
  let scanned = 0;
  const rootStats = await sftpFs.stat(sftp, base);
  if (!rootStats.isDirectory()) {
    files.push({ relativePath: basenameRemotePath(base), absolutePath: base, size: rootStats.size, mtime: rootStats.mtime, mode: rootStats.mode & 4095 });
    return { root: base, files, dirs, filesTotal: 1, bytesTotal: rootStats.size };
  }
  const stack = [
    { abs: base, rel: "", depth: 0 }
  ];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) break;
    if (options.isCancelled?.()) throw new CancelledScanError();
    if (current.depth > maxDepth) {
      throw new AppError("BAD_REQUEST", `目录层级超过上限 ${maxDepth}，已中止扫描: ${current.abs}`);
    }
    const list = await sftpFs.readdir(sftp, current.abs);
    for (const item of list) {
      if (item.filename === "." || item.filename === "..") continue;
      scanned++;
      if (scanned > maxEntries) {
        throw AppError.badRequest(`扫描条目超过上限 ${maxEntries}，已中止: ${base}`);
      }
      const abs = current.abs === "/" ? `/${item.filename}` : `${current.abs}/${item.filename}`;
      const rel = current.rel === "" ? item.filename : `${current.rel}/${item.filename}`;
      const mode = item.attrs.mode;
      const isLink = isSymlinkMode(mode);
      const isDir = (mode & 61440) === 16384;
      if (isDir && !isLink) {
        dirs.push(rel);
        stack.push({ abs, rel, depth: current.depth + 1 });
      } else {
        files.push({ relativePath: rel, absolutePath: abs, size: item.attrs.size, mtime: item.attrs.mtime, mode: mode & 4095 });
        bytesTotal += item.attrs.size;
      }
      if (scanned % progressEvery === 0) {
        options.onProgress?.({ files: files.length, bytes: bytesTotal, dirs: dirs.length, current: abs });
      }
    }
  }
  options.onProgress?.({ files: files.length, bytes: bytesTotal, dirs: dirs.length, current: base });
  return { root: base, files, dirs, filesTotal: files.length, bytesTotal };
}
class CancelledScanError extends Error {
  constructor() {
    super("目录扫描已取消");
    this.name = "CancelledScanError";
  }
}
const log$1 = createLogger("sftp-editor");
const SAVE_DEBOUNCE_MS = 400;
const MAX_WRITE_BYTES = 8 * 1024 * 1024;
function hashContent(data) {
  return createHash("sha256").update(data).digest("hex");
}
class RemoteEditorRegistry {
  constructor(deps) {
    this.deps = deps;
    this.sessions = /* @__PURE__ */ new Map();
    this.watchers = /* @__PURE__ */ new Map();
    this.timers = /* @__PURE__ */ new Map();
  }
  /** 登记一个编辑会话并开始监听本地副本 */
  open(session) {
    this.sessions.set(session.editId, session);
    this.watch(session);
  }
  get(editId) {
    return this.sessions.get(editId);
  }
  list() {
    return [...this.sessions.values()];
  }
  /** 结束编辑会话：停掉监听与计时器 */
  close(editId) {
    const session = this.sessions.get(editId);
    if (!session) return false;
    const w = this.watchers.get(editId);
    if (w) {
      try {
        w.close();
      } catch {
      }
    }
    const t = this.timers.get(editId);
    if (t) clearTimeout(t);
    this.watchers.delete(editId);
    this.timers.delete(editId);
    this.sessions.delete(editId);
    return true;
  }
  /** 会话断开时清掉它的所有编辑会话（否则监听会留着，写回必然失败） */
  closeBySession(sessionId2) {
    let n = 0;
    for (const s of [...this.sessions.values()]) {
      if (s.sessionId === sessionId2) {
        this.close(s.editId);
        n += 1;
      }
    }
    return n;
  }
  closeAll() {
    for (const id of [...this.sessions.keys()]) this.close(id);
  }
  watch(session) {
    try {
      const w = watch(session.localPath, () => this.scheduleSave(session.editId));
      w.on("error", (err) => {
        log$1.warn(`编辑副本监听失败: ${session.localPath}`, err);
        this.deps.emit(Events.SFTP_EDIT_ERROR, {
          editId: session.editId,
          remotePath: session.remotePath,
          message: `无法监听本地副本（${err.message}）——改动不会自动写回远端`
        });
      });
      this.watchers.set(session.editId, w);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log$1.warn("无法监听编辑副本", err);
      this.deps.emit(Events.SFTP_EDIT_ERROR, {
        editId: session.editId,
        remotePath: session.remotePath,
        message: `无法监听本地副本（${message}）——改动不会自动写回远端；可手动调用保存`
      });
    }
  }
  scheduleSave(editId) {
    const existing = this.timers.get(editId);
    if (existing) clearTimeout(existing);
    const t = setTimeout(() => {
      this.timers.delete(editId);
      void this.save(editId, "auto").catch((err) => {
        log$1.debug(`自动写回未成功（已发事件告知）: ${editId}`, err);
        if (!existsSync(this.sessions.get(editId)?.localPath ?? "")) {
          this.close(editId);
        }
      });
    }, SAVE_DEBOUNCE_MS);
    this.timers.set(editId, t);
  }
  /**
   * 写回远端。
   *
   * @param reason `auto` 自动（本地变更触发）/ `manual` 用户显式保存
   */
  async save(editId, reason = "manual") {
    const session = this.sessions.get(editId);
    if (!session) throw new Error(`编辑会话不存在或已结束: ${editId}`);
    if (!existsSync(session.localPath)) {
      this.deps.emit(Events.SFTP_EDIT_ERROR, {
        editId,
        remotePath: session.remotePath,
        message: "本地编辑副本已不存在（可能被临时目录清理）——未写回远端"
      });
      throw new Error("本地编辑副本不存在");
    }
    const stat = statSync(session.localPath);
    if (!stat.isFile()) throw new Error("本地编辑副本不是文件");
    if (stat.size > MAX_WRITE_BYTES) {
      const message = `编辑副本过大（${stat.size} 字节 > 上限 ${MAX_WRITE_BYTES}），已拒绝写回`;
      this.deps.emit(Events.SFTP_EDIT_ERROR, { editId, remotePath: session.remotePath, message });
      throw new Error(message);
    }
    const data = readFileSync(session.localPath);
    const hash = hashContent(data);
    if (hash === session.lastHash) {
      return { bytes: 0, skipped: true, remoteChangedSinceOpen: false };
    }
    const sftp = await this.deps.sftpFor(session.sessionId);
    let remoteChangedSinceOpen = false;
    try {
      const remote = await statPath(sftp, session.remotePath);
      remoteChangedSinceOpen = Math.abs(remote.mtime - session.remoteMtimeAtOpen) > 1e3;
    } catch {
      remoteChangedSinceOpen = true;
    }
    try {
      const result = await writeRemoteTextFile(sftp, session.remotePath, data);
      session.lastHash = hash;
      this.deps.emit(Events.SFTP_EDIT_SAVED, {
        editId,
        sessionId: session.sessionId,
        remotePath: session.remotePath,
        bytes: result.size,
        at: Date.now(),
        reason,
        remoteChangedSinceOpen
      });
      log$1.info(
        `编辑改动已写回 ${session.remotePath}（${result.size} 字节，${reason}，远端期间被改过=${remoteChangedSinceOpen}）`
      );
      return { bytes: result.size, skipped: false, remoteChangedSinceOpen };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.deps.emit(Events.SFTP_EDIT_ERROR, {
        editId,
        sessionId: session.sessionId,
        remotePath: session.remotePath,
        message: `写回远端失败：${message}（本地副本仍保留在 ${session.localPath}）`
      });
      log$1.warn(`写回失败 ${session.remotePath}`, err);
      throw err;
    }
  }
}
function isLocalSession(sessionId2) {
  return getWritable(sessionId2)?.kind === "pty";
}
function resolveLocalPath(input) {
  if (input === "~" || input === "/~" || input === ".") return homedir();
  if (input.startsWith("~/")) return underHome(input.slice(2));
  if (input.startsWith("/~/")) return underHome(input.slice(3));
  return input;
}
function underHome(rest) {
  const home = homedir().replace(/\/+$/, "");
  return rest === "" ? home : `${home}/${rest}`;
}
function toSftpStats(s) {
  return {
    mode: s.mode,
    uid: s.uid,
    gid: s.gid,
    size: s.size,
    atime: Math.floor(s.atimeMs / 1e3),
    mtime: Math.floor(s.mtimeMs / 1e3),
    isDirectory: () => s.isDirectory(),
    isFile: () => s.isFile(),
    isSymbolicLink: () => s.isSymbolicLink()
  };
}
function longnameOf(path, s) {
  const kind = s.isDirectory() ? "d" : s.isSymbolicLink() ? "l" : s.isFile() ? "-" : "?";
  return `${kind}${formatPermissions(s.mode)} 1 ${s.uid} ${s.gid} ${s.size} ${basename(path)}`;
}
function readdirLocal(dir, cb) {
  fs.readdir(dir, { withFileTypes: true }, (err, dirents) => {
    if (err) {
      cb(err, void 0);
      return;
    }
    if (dirents.length === 0) {
      cb(void 0, []);
      return;
    }
    const out = new Array(dirents.length);
    let pending = dirents.length;
    let failed = false;
    dirents.forEach((dirent, index) => {
      const child = dir === "/" ? `/${dirent.name}` : `${dir}/${dirent.name}`;
      fs.lstat(child, (statErr, stats) => {
        if (failed) return;
        if (statErr) {
          failed = true;
          cb(statErr, void 0);
          return;
        }
        out[index] = {
          filename: dirent.name,
          longname: longnameOf(child, stats),
          attrs: toSftpStats(stats)
        };
        pending -= 1;
        if (pending === 0) cb(void 0, out);
      });
    });
  });
}
const HANDLE_PREFIX = "t1000-fd:";
function encodeHandle(fd) {
  return Buffer.from(`${HANDLE_PREFIX}${fd}`, "utf8");
}
function decodeHandle(handle) {
  const text = handle.toString("utf8");
  const fd = Number(text.slice(HANDLE_PREFIX.length));
  if (!text.startsWith(HANDLE_PREFIX) || !Number.isInteger(fd) || fd < 0) {
    throw new Error("非法的本地文件句柄");
  }
  return fd;
}
function guarded(cb, fn) {
  try {
    fn();
  } catch (err) {
    cb(err instanceof Error ? err : new Error(String(err)));
  }
}
function noop() {
}
function createLocalSftpLike() {
  return {
    readdir(location, cb) {
      readdirLocal(resolveLocalPath(location), cb);
    },
    stat(path, cb) {
      fs.stat(resolveLocalPath(path), (err, stats) => {
        if (err) {
          cb(err, void 0);
          return;
        }
        cb(void 0, toSftpStats(stats));
      });
    },
    lstat(path, cb) {
      fs.lstat(resolveLocalPath(path), (err, stats) => {
        if (err) {
          cb(err, void 0);
          return;
        }
        cb(void 0, toSftpStats(stats));
      });
    },
    mkdir(path, attributes, cb) {
      fs.mkdir(resolveLocalPath(path), { mode: attributes.mode }, (err) => cb(err ?? void 0));
    },
    rmdir(path, cb) {
      fs.rmdir(resolveLocalPath(path), (err) => cb(err ?? void 0));
    },
    unlink(path, cb) {
      fs.unlink(resolveLocalPath(path), (err) => cb(err ?? void 0));
    },
    rename(srcPath, destPath, cb) {
      fs.rename(resolveLocalPath(srcPath), resolveLocalPath(destPath), (err) => cb(err ?? void 0));
    },
    chmod(path, mode, cb) {
      fs.chmod(resolveLocalPath(path), mode, (err) => cb(err ?? void 0));
    },
    readFile(path, cb) {
      fs.readFile(resolveLocalPath(path), (err, data) => {
        if (err) {
          cb(err, void 0);
          return;
        }
        cb(void 0, data);
      });
    },
    writeFile(path, data, cb) {
      fs.writeFile(resolveLocalPath(path), data, (err) => (cb ?? noop)(err ?? void 0));
    },
    open(path, mode, cb) {
      fs.open(resolveLocalPath(path), mode, (err, fd) => {
        if (err) {
          cb(err, void 0);
          return;
        }
        cb(void 0, encodeHandle(fd));
      });
    },
    close(handle, cb) {
      guarded(
        (err) => cb(err ?? void 0),
        () => fs.close(decodeHandle(handle), (err) => cb(err ?? void 0))
      );
    },
    read(handle, buffer, offset, length, position, cb) {
      guarded(
        (err) => cb(err ?? void 0, 0, buffer),
        () => fs.read(decodeHandle(handle), buffer, offset, length, position, (err, bytesRead) => {
          cb(err ?? void 0, err ? 0 : bytesRead, buffer);
        })
      );
    },
    write(handle, buffer, offset, length, position, cb) {
      guarded(
        (err) => cb(err ?? void 0),
        () => fs.write(
          decodeHandle(handle),
          buffer,
          offset,
          length,
          position,
          (err) => cb(err ?? void 0)
        )
      );
    },
    realpath(path, cb) {
      fs.realpath(resolveLocalPath(path), (err, absPath) => {
        if (err) {
          cb(err, void 0);
          return;
        }
        cb(void 0, absPath);
      });
    },
    utimes(path, atime, mtime, cb) {
      fs.utimes(resolveLocalPath(path), atime, mtime, (err) => cb(err ?? void 0));
    },
    end() {
    }
  };
}
const DEFAULT_CHUNK_SIZE = 64 * 1024;
const CANCEL_ACK_DELAY_MS = 100;
const MAX_TRACKED_FILES = 200;
const DEFAULT_MAX_TASKS = 500;
const DEFAULT_SETTINGS = {
  maxInflightPerConnection: 4,
  progressThrottleMs: 200,
  conflictPolicy: "ask",
  preservePermissions: false,
  preserveTimestamps: false
};
class CancelledTransferError extends Error {
  constructor() {
    super("传输已取消");
    this.name = "CancelledTransferError";
  }
}
const nodeLocalIo = {
  async stat(p) {
    const s = await fsp.stat(p);
    return {
      size: s.size,
      mtimeMs: s.mtimeMs,
      mode: s.mode,
      isDirectory: () => s.isDirectory(),
      isFile: () => s.isFile(),
      isSymbolicLink: () => s.isSymbolicLink()
    };
  },
  async readdir(p) {
    const list = await fsp.readdir(p, { withFileTypes: true });
    return list.map((d) => ({
      name: d.name,
      isDirectory: () => d.isDirectory(),
      isFile: () => d.isFile(),
      isSymbolicLink: () => d.isSymbolicLink()
    }));
  },
  async open(p, flags) {
    const handle = await fsp.open(p, flags);
    return {
      read: async (buffer, offset, length, position) => (await handle.read(buffer, offset, length, position)).bytesRead,
      write: async (buffer, offset, length, position) => {
        await handle.write(buffer, offset, length, position);
      },
      close: () => handle.close(),
      stat: async () => {
        const s = await handle.stat();
        return { size: s.size, mode: s.mode };
      }
    };
  },
  async mkdir(p) {
    await fsp.mkdir(p, { recursive: true });
  },
  async unlink(p) {
    await fsp.unlink(p);
  },
  async chmod(p, mode) {
    await fsp.chmod(p, mode);
  },
  async utimes(p, atime, mtime) {
    await fsp.utimes(p, atime, mtime);
  }
};
class TransferGate {
  constructor(limit, onBusyChange, onIdleDrained) {
    this.limit = limit;
    this.onBusyChange = onBusyChange;
    this.onIdleDrained = onIdleDrained;
    this.active = 0;
    this.queue = [];
  }
  get running() {
    return this.active;
  }
  get waiting() {
    return this.queue.length;
  }
  /**
   * 取一个槽位。
   * @returns 释放函数；若等待期间被取消则返回 null（此时未占用槽位）
   */
  async acquire(signal) {
    if (signal?.cancelled) return null;
    if (this.active < this.limit) {
      this.active++;
      if (this.active === 1) this.onBusyChange(true);
      return this.makeRelease();
    }
    const waiter = {
      ...signal ? { signal } : {},
      granted: false,
      cancelled: false,
      wake: () => {
      }
    };
    await new Promise((resolve) => {
      waiter.wake = resolve;
      this.queue.push(waiter);
    });
    if (!waiter.granted) return null;
    return this.makeRelease();
  }
  /** 把等待队列里对应信号的等待者标记取消并唤醒（不占槽位） */
  cancelWaiter(signal) {
    for (const waiter of this.queue) {
      if (waiter.signal === signal && !waiter.cancelled) {
        waiter.cancelled = true;
        waiter.wake();
      }
    }
  }
  makeRelease() {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      if (this.active < 0) this.active = 0;
      if (this.active === 0) {
        this.onBusyChange(false);
        this.onIdleDrained?.();
      }
      this.pump();
    };
  }
  /** 有空槽就把等待队列里还没被取消的人放进来 */
  pump() {
    while (this.active < this.limit && this.queue.length > 0) {
      const waiter = this.queue.shift();
      if (!waiter) return;
      if (waiter.cancelled || waiter.signal?.cancelled) {
        waiter.cancelled = true;
        waiter.wake();
        continue;
      }
      waiter.granted = true;
      this.active++;
      if (this.active === 1) this.onBusyChange(true);
      waiter.wake();
    }
  }
}
class TransferEngine {
  constructor(options) {
    this.tasks = /* @__PURE__ */ new Map();
    this.order = [];
    this.gates = /* @__PURE__ */ new Map();
    this.emit = options.emit;
    this.resolveSftp = options.resolveSftp;
    this.settings = { ...DEFAULT_SETTINGS, ...options.settings };
    this.local = options.local ?? nodeLocalIo;
    this.now = options.now ?? (() => Date.now());
    this.schedule = options.schedule ?? ((fn, ms) => setTimeout(fn, ms));
    if (options.onConflict) this.onConflict = options.onConflict;
    this.chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
    this.maxTasks = options.maxTasks ?? DEFAULT_MAX_TASKS;
    if (options.logger) this.logger = options.logger;
    this.scanProgressEvery = options.scanProgressEvery ?? 200;
  }
  /** 运行时替换事件发送器（IPC 上下文可能在首次调用前还没准备好） */
  setEmitter(emit) {
    this.emit = emit;
  }
  // -------------------------------------------------------------------------
  // 对外 API
  // -------------------------------------------------------------------------
  /**
   * 提交一个传输任务。立即返回任务快照，执行在后台推进。
   * 参数非法（路径为空 / 越界）时同步抛错，让 IPC 边界直接返回 BAD_REQUEST。
   */
  submit(request) {
    if (!request.sessionId) throw AppError.badRequest("缺少 sessionId");
    if (request.direction !== "upload" && request.direction !== "download") {
      throw AppError.badRequest(`未知传输方向: ${String(request.direction)}`);
    }
    if (!request.sourcePath) throw AppError.badRequest("源路径不能为空");
    if (!request.targetPath) throw AppError.badRequest("目标路径不能为空");
    const id = randomUUID();
    const task = {
      id,
      sessionId: request.sessionId,
      direction: request.direction,
      state: "queued",
      sourcePath: request.sourcePath,
      targetPath: request.targetPath,
      createdAt: new Date(this.now()).toISOString(),
      recursive: request.recursive ?? false,
      filesTotal: 0,
      filesDone: 0,
      bytesTotal: 0,
      bytesDone: 0,
      speed: 0,
      conflictPolicy: request.conflictPolicy ?? this.settings.conflictPolicy,
      resume: request.resume ?? false,
      files: []
    };
    const internal = {
      task,
      signal: { cancelled: false },
      settled: false,
      finishNotified: false,
      startedAtMs: 0,
      lastProgressAt: Number.NEGATIVE_INFINITY,
      preservePermissions: request.preservePermissions ?? this.settings.preservePermissions,
      preserveTimestamps: request.preserveTimestamps ?? this.settings.preserveTimestamps
    };
    this.tasks.set(id, internal);
    this.order.push(id);
    this.trimHistory();
    void this.run(internal, request);
    return snapshot(task);
  }
  /** 按 transferId 精确取消 */
  cancel(transferId) {
    const internal = this.tasks.get(transferId);
    if (!internal || internal.settled) return false;
    internal.signal.cancelled = true;
    internal.task.state = "cancelling";
    for (const gate of this.gates.values()) gate.cancelWaiter(internal.signal);
    return true;
  }
  /** 列出任务（可按会话过滤） */
  listTransfers(sessionId2) {
    const out = [];
    for (const id of this.order) {
      const internal = this.tasks.get(id);
      if (!internal) continue;
      if (sessionId2 && internal.task.sessionId !== sessionId2) continue;
      out.push(snapshot(internal.task));
    }
    return out;
  }
  getTask(transferId) {
    const internal = this.tasks.get(transferId);
    return internal ? snapshot(internal.task) : void 0;
  }
  /** 测试与关停用：某会话是否还有活跃任务 */
  hasActive(sessionId2) {
    for (const internal of this.tasks.values()) {
      if (sessionId2 && internal.task.sessionId !== sessionId2) continue;
      if (!internal.settled) return true;
    }
    return false;
  }
  // -------------------------------------------------------------------------
  // 任务执行
  // -------------------------------------------------------------------------
  async run(internal, request) {
    const { task } = internal;
    internal.startedAtMs = this.now();
    task.startedAt = new Date(this.now()).toISOString();
    try {
      if (request.direction === "upload") {
        await this.runUpload(internal, request);
      } else {
        await this.runDownload(internal, request);
      }
      this.finishSuccess(internal);
    } catch (err) {
      if (err instanceof CancelledTransferError || err instanceof CancelledScanError) {
        this.finishCancelled(internal);
        return;
      }
      this.finishFailed(internal, err);
    }
  }
  // ------------------------------- 上传 ------------------------------------
  async runUpload(internal, request) {
    const { task } = internal;
    const sftp = await this.resolveSftpFor(internal);
    const sourceStats = await this.local.stat(request.sourcePath).catch((err) => {
      throw AppError.notFound(`本地源路径不可用: ${request.sourcePath}（${errorMessage(err)}）`);
    });
    if (sourceStats.isDirectory()) {
      if (!request.recursive) {
        throw AppError.badRequest(`源是目录，需要 recursive=true: ${request.sourcePath}`);
      }
      task.state = "scanning";
      const tree = await this.withSlot(internal, () => this.scanLocalTree(internal, request.sourcePath));
      task.filesTotal = tree.filesTotal;
      task.bytesTotal = tree.bytesTotal;
      this.emitDirScanned(internal, request.sourcePath, tree.filesTotal, tree.bytesTotal);
      task.state = "running";
      const destRoot2 = await this.resolveDestRoot(internal, sftp, {
        sourceName: basename(request.sourcePath),
        rawTarget: request.targetPath,
        sourceIsDir: true,
        targetRawLooksLikeDir: request.targetPath.endsWith("/")
      });
      await this.withSlot(internal, async () => {
        await ensureRemoteDirectory(sftp, destRoot2);
        for (const rel of tree.dirs) {
          this.throwIfCancelled(internal);
          await ensureRemoteDirectory(sftp, joinRemotePath(destRoot2, rel));
        }
      });
      for (const file of tree.files) {
        this.throwIfCancelled(internal);
        const dest = joinRemotePath(destRoot2, file.relativePath);
        await this.transferOneUpload(internal, sftp, file.absolutePath, dest, {
          size: file.size,
          mode: file.mode,
          mtimeMs: file.mtimeMs
        });
      }
      return;
    }
    task.state = "running";
    const destRoot = await this.resolveDestRoot(internal, sftp, {
      sourceName: basename(request.sourcePath),
      rawTarget: request.targetPath,
      sourceIsDir: false,
      targetRawLooksLikeDir: request.targetPath.endsWith("/")
    });
    await this.transferOneUpload(internal, sftp, request.sourcePath, destRoot, {
      size: sourceStats.size,
      mode: sourceStats.mode,
      mtimeMs: sourceStats.mtimeMs
    });
  }
  /** 上传单个文件（含续传/冲突/权限保留） */
  async transferOneUpload(internal, sftp, localPath, remotePathRaw, meta) {
    const { task } = internal;
    let remotePath2 = normalizeRemotePath(remotePathRaw);
    let offset = 0;
    let openMode = "w";
    const remoteStats = await this.statOrNull(sftp, remotePath2);
    if (task.resume && remoteStats && !remoteStats.isDirectory()) {
      if (remoteStats.size <= meta.size) {
        offset = remoteStats.size;
        openMode = "a";
      }
    } else if (remoteStats) {
      const decision = await this.resolveConflict(internal, remotePath2, localPath);
      if (decision === "skip") {
        this.recordFile(internal, remotePath2, localPath, meta.size, 0, "succeeded", "已跳过（目标已存在）");
        task.filesTotal = Math.max(task.filesTotal, task.filesDone + 1);
        return;
      }
      if (decision === "rename") {
        const renamed = await this.nextFreeRemoteName(sftp, remotePath2);
        remotePath2 = renamed;
        this.logger?.warn(`目标已存在，重命名为 ${renamed}`);
      } else {
        if (!remoteStats.isDirectory()) await sftpFs.unlink(sftp, remotePath2);
        else throw AppError.conflict(`目标已存在且是目录: ${remotePath2}`);
      }
    }
    const fileEntry = this.beginFile(internal, remotePath2, localPath, meta.size);
    if (task.filesTotal === 0) task.filesTotal = 1;
    const release = await this.gateFor(task.sessionId).acquire(internal.signal);
    if (!release) throw new CancelledTransferError();
    let localHandle = null;
    let remoteHandle = null;
    try {
      localHandle = await this.local.open(localPath, "r");
      remoteHandle = await sftpFs.open(sftp, remotePath2, openMode);
      const buffer = Buffer.allocUnsafe(this.chunkSize);
      let position = offset;
      while (position < meta.size) {
        this.throwIfCancelled(internal);
        const want = Math.min(this.chunkSize, meta.size - position);
        const bytesRead = await localHandle.read(buffer, 0, want, position);
        if (bytesRead <= 0) break;
        await sftpFs.write(sftp, remoteHandle, buffer, 0, bytesRead, position);
        position += bytesRead;
        this.reportFileProgress(internal, remotePath2, position, meta.size);
      }
      if (internal.preservePermissions) {
        await sftpFs.chmod(sftp, remotePath2, meta.mode & 4095).catch((err) => {
          this.logger?.warn(`保留远端权限失败: ${remotePath2}`, err);
        });
      }
      if (internal.preserveTimestamps && sftp.utimes) {
        const seconds = meta.mtimeMs / 1e3;
        await sftpFs.utimes(sftp, remotePath2, seconds, seconds).catch((err) => {
          this.logger?.warn(`保留远端时间戳失败: ${remotePath2}`, err);
        });
      }
      this.completeFile(internal, fileEntry, meta.size);
      this.reportFileProgress(internal, remotePath2, meta.size, meta.size, true, task.bytesDone);
    } finally {
      if (remoteHandle) await sftpFs.close(sftp, remoteHandle).catch(() => {
      });
      if (localHandle) await localHandle.close().catch(() => {
      });
      release();
    }
  }
  // ------------------------------- 下载 ------------------------------------
  async runDownload(internal, request) {
    const { task } = internal;
    const sftp = await this.resolveSftpFor(internal);
    const remoteSource = normalizeRemotePath(request.sourcePath);
    const sourceStats = await this.statOrNull(sftp, remoteSource);
    if (!sourceStats) throw AppError.notFound(`远端源路径不存在: ${remoteSource}`);
    if (sourceStats.isDirectory()) {
      if (!request.recursive) {
        throw AppError.badRequest(`源是目录，需要 recursive=true: ${remoteSource}`);
      }
      task.state = "scanning";
      const tree = await this.withSlot(
        internal,
        () => scanRemoteTree(sftp, remoteSource, {
          progressEvery: this.scanProgressEvery,
          isCancelled: () => internal.signal.cancelled,
          onProgress: (p) => this.emitDirScanned(internal, remoteSource, p.files, p.bytes)
        })
      );
      task.filesTotal = tree.filesTotal;
      task.bytesTotal = tree.bytesTotal;
      this.emitDirScanned(internal, remoteSource, tree.filesTotal, tree.bytesTotal);
      task.state = "running";
      const destRoot = await this.resolveDestRootLocal(internal, {
        sourceName: basenameRemotePath(remoteSource),
        rawTarget: request.targetPath,
        sourceIsDir: true,
        targetRawLooksLikeDir: request.targetPath.endsWith("/")
      });
      await this.local.mkdir(destRoot);
      for (const rel of tree.dirs) {
        this.throwIfCancelled(internal);
        await this.local.mkdir(joinLocalRelative(destRoot, rel));
      }
      for (const file of tree.files) {
        this.throwIfCancelled(internal);
        const dest2 = joinLocalRelative(destRoot, file.relativePath);
        await this.transferOneDownload(internal, sftp, file, dest2);
      }
      return;
    }
    task.state = "running";
    const dest = await this.resolveDestRootLocal(internal, {
      sourceName: basenameRemotePath(remoteSource),
      rawTarget: request.targetPath,
      sourceIsDir: false,
      targetRawLooksLikeDir: request.targetPath.endsWith("/")
    });
    const fileInfo = {
      relativePath: basenameRemotePath(remoteSource),
      absolutePath: remoteSource,
      size: sourceStats.size,
      mtime: sourceStats.mtime,
      mode: sourceStats.mode & 4095
    };
    await this.transferOneDownload(internal, sftp, fileInfo, dest);
  }
  /** 下载单个文件（含续传/冲突/权限保留） */
  async transferOneDownload(internal, sftp, file, localPathRaw) {
    const { task } = internal;
    let localPath = localPathRaw;
    let offset = 0;
    let openMode = "w";
    const localStats = await this.local.stat(localPath).catch(() => null);
    if (task.resume && localStats && !localStats.isDirectory()) {
      if (localStats.size <= file.size) {
        offset = localStats.size;
        openMode = "a";
      }
    } else if (localStats) {
      const decision = await this.resolveConflict(internal, localPath, file.absolutePath);
      if (decision === "skip") {
        this.recordFile(internal, file.absolutePath, localPath, file.size, 0, "succeeded", "已跳过（目标已存在）");
        task.filesTotal = Math.max(task.filesTotal, task.filesDone + 1);
        return;
      }
      if (decision === "rename") {
        localPath = this.nextFreeLocalName(localPath, await this.siblingNames(localPath));
      } else {
        if (localStats.isDirectory()) {
          throw AppError.conflict(`本地目标已存在且是目录: ${localPath}`);
        }
        await this.local.unlink(localPath);
      }
    }
    const fileEntry = this.beginFile(internal, file.absolutePath, localPath, file.size);
    if (task.filesTotal === 0) task.filesTotal = 1;
    const release = await this.gateFor(task.sessionId).acquire(internal.signal);
    if (!release) throw new CancelledTransferError();
    let localHandle = null;
    let remoteHandle = null;
    try {
      await this.local.mkdir(dirnameLocal(localPath));
      localHandle = await this.local.open(localPath, openMode);
      remoteHandle = await sftpFs.open(sftp, file.absolutePath, "r");
      const buffer = Buffer.allocUnsafe(this.chunkSize);
      let position = offset;
      while (position < file.size) {
        this.throwIfCancelled(internal);
        const want = Math.min(this.chunkSize, file.size - position);
        const bytesRead = await sftpFs.read(sftp, remoteHandle, buffer, 0, want, position);
        if (bytesRead <= 0) break;
        await localHandle.write(buffer, 0, bytesRead, position);
        position += bytesRead;
        this.reportFileProgress(internal, file.absolutePath, position, file.size);
      }
      if (internal.preservePermissions && this.local.chmod) {
        await this.local.chmod(localPath, file.mode & 4095).catch((err) => {
          this.logger?.warn(`保留本地权限失败: ${localPath}`, err);
        });
      }
      if (internal.preserveTimestamps && this.local.utimes) {
        const seconds = file.mtime;
        await this.local.utimes(localPath, seconds, seconds).catch((err) => {
          this.logger?.warn(`保留本地时间戳失败: ${localPath}`, err);
        });
      }
      this.completeFile(internal, fileEntry, file.size);
      this.reportFileProgress(internal, file.absolutePath, file.size, file.size, true, task.bytesDone);
    } finally {
      if (remoteHandle) await sftpFs.close(sftp, remoteHandle).catch(() => {
      });
      if (localHandle) await localHandle.close().catch(() => {
      });
      release();
    }
  }
  // ------------------------------ 目录扫描 ---------------------------------
  /** 本地目录递归扫描（显式栈，符号链接当文件读取，不跟进） */
  async scanLocalTree(internal, root) {
    const files = [];
    const dirs = [];
    let bytesTotal = 0;
    let scanned = 0;
    const stack = [{ abs: root, rel: "" }];
    while (stack.length > 0) {
      this.throwIfCancelled(internal);
      const current = stack.pop();
      if (!current) break;
      const entries = await this.local.readdir(current.abs);
      for (const entry of entries) {
        this.throwIfCancelled(internal);
        scanned++;
        const abs = join(current.abs, entry.name);
        const rel = current.rel === "" ? entry.name : `${current.rel}/${entry.name}`;
        if (entry.isDirectory() && !entry.isSymbolicLink()) {
          dirs.push(rel);
          stack.push({ abs, rel });
        } else {
          const stats = await this.local.stat(abs);
          if (stats.isDirectory()) continue;
          files.push({ relativePath: rel, absolutePath: abs, size: stats.size, mtimeMs: stats.mtimeMs, mode: stats.mode });
          bytesTotal += stats.size;
        }
        if (scanned % this.scanProgressEvery === 0) {
          this.emitDirScanned(internal, root, files.length, bytesTotal);
        }
      }
    }
    return { root, dirs, files, filesTotal: files.length, bytesTotal };
  }
  // ------------------------------ 冲突处理 ---------------------------------
  async resolveConflict(internal, targetPath, sourcePath) {
    const policy = internal.task.conflictPolicy;
    if (policy === "overwrite") return "overwrite";
    if (policy === "skip") return "skip";
    if (policy === "rename") return "rename";
    if (this.onConflict) {
      const decided = await this.onConflict({
        sessionId: internal.task.sessionId,
        direction: internal.task.direction,
        targetPath,
        sourcePath,
        filesDone: internal.task.filesDone
      });
      if (decided === "ask") throw AppError.conflict(`目标已存在且未选择处理方式: ${targetPath}`);
      return decided === "overwrite" || decided === "skip" || decided === "rename" ? decided : "overwrite";
    }
    throw AppError.conflict(`目标已存在: ${targetPath}（conflictPolicy=ask 需要上层决策）`);
  }
  async nextFreeRemoteName(sftp, remotePath2) {
    const dir = dirnameRemotePath(remotePath2);
    const name = basenameRemotePath(remotePath2);
    for (let i = 1; i <= 1e4; i++) {
      const numbered = numberedName(name, i);
      if (!await pathExists(sftp, joinRemotePath(dir, numbered))) {
        return joinRemotePath(dir, numbered);
      }
    }
    throw AppError.conflict(`无法为 ${remotePath2} 生成可用的重命名`);
  }
  nextFreeLocalName(localPath, siblings) {
    const dir = dirnameLocal(localPath);
    const name = basename(localPath);
    for (let i = 1; i <= 1e4; i++) {
      const numbered = numberedName(name, i);
      if (!siblings.has(numbered)) return join(dir, numbered);
    }
    throw AppError.conflict(`无法为 ${localPath} 生成可用的重命名`);
  }
  async siblingNames(localPath) {
    const dir = dirnameLocal(localPath);
    const entries = await this.local.readdir(dir).catch(() => []);
    return new Set(entries.map((e) => e.name));
  }
  // --------------------------- 目标路径解析 --------------------------------
  /**
   * 目的路径规则（与 scp/cp 一致）：
   * - 目标已存在（或用户以 `/` 结尾指明目录）→ 在目标目录下用源的名字；
   * - 否则目标路径就是源在目的端的最终路径。
   */
  async resolveDestRoot(internal, sftp, args) {
    const target = normalizeRemotePath(args.rawTarget);
    const stats = await this.statOrNull(sftp, target);
    const intoDir = args.targetRawLooksLikeDir || stats?.isDirectory() === true;
    if (intoDir) return joinRemotePath(target, args.sourceName);
    void args.sourceIsDir;
    return target;
  }
  async resolveDestRootLocal(internal, args) {
    const target = args.rawTarget;
    const stats = await this.local.stat(target).catch(() => null);
    const intoDir = args.targetRawLooksLikeDir || stats?.isDirectory() === true;
    if (intoDir) return join(target, args.sourceName);
    void args.sourceIsDir;
    return target;
  }
  // ------------------------------ 状态与事件 -------------------------------
  beginFile(internal, remotePath2, localPath, size) {
    const entry = {
      remotePath: remotePath2,
      localPath,
      size,
      transferred: 0,
      state: "running"
    };
    const files = internal.task.files ?? (internal.task.files = []);
    files.push(entry);
    if (files.length > MAX_TRACKED_FILES) files.shift();
    return entry;
  }
  completeFile(internal, entry, size) {
    entry.transferred = size;
    entry.state = "succeeded";
    internal.task.filesDone++;
    internal.task.bytesDone += size;
  }
  /** 跳过/失败也记一条明细，UI 才能解释"为什么总数对不上" */
  recordFile(internal, remotePath2, localPath, size, transferred, state, note) {
    const entry = {
      remotePath: remotePath2,
      localPath,
      size,
      transferred,
      state,
      ...note ? { error: note } : {}
    };
    const files = internal.task.files ?? (internal.task.files = []);
    files.push(entry);
    if (files.length > MAX_TRACKED_FILES) files.shift();
    internal.task.filesDone++;
  }
  /**
   * 进度事件节流：默认 200ms 一次（性能关键，参考实现同值）。
   * `force` 用于文件完成/任务结束时的收尾事件，保证 UI 拿到准确的终值。
   */
  reportFileProgress(internal, file, fileTransferred, fileTotal, force = false, doneOverride) {
    const now = this.now();
    if (!force && now - internal.lastProgressAt < this.settings.progressThrottleMs) return;
    internal.lastProgressAt = now;
    const task = internal.task;
    const done = doneOverride ?? task.bytesDone + fileTransferred;
    const elapsedSec = Math.max(0, (now - internal.startedAtMs) / 1e3);
    const speed = elapsedSec > 0 ? done / elapsedSec : 0;
    task.speed = Math.round(speed);
    if (speed > 0 && task.bytesTotal > 0) {
      task.etaSeconds = Math.max(0, Math.round((task.bytesTotal - done) / speed));
    }
    this.emit(Events.SFTP_TRANSFER_PROGRESS, {
      transferId: task.id,
      sessionId: task.sessionId,
      direction: task.direction,
      file,
      transferredBytes: fileTransferred,
      totalBytes: fileTotal,
      filesDone: task.filesDone,
      filesTotal: task.filesTotal,
      speed: task.speed
    });
  }
  emitDirScanned(internal, path, files, bytes) {
    this.emit(Events.SFTP_DIR_SCANNED, {
      sessionId: internal.task.sessionId,
      path,
      files,
      bytes
    });
  }
  finishSuccess(internal) {
    if (internal.settled) return;
    internal.settled = true;
    const task = internal.task;
    task.state = "succeeded";
    task.finishedAt = new Date(this.now()).toISOString();
    this.emitFinished(internal);
  }
  finishFailed(internal, err) {
    if (internal.settled) return;
    internal.settled = true;
    const task = internal.task;
    task.state = "failed";
    task.error = errorMessage(err);
    task.finishedAt = new Date(this.now()).toISOString();
    this.emit(Events.SFTP_TRANSFER_ERROR, {
      transferId: task.id,
      sessionId: task.sessionId,
      message: task.error
    });
  }
  finishCancelled(internal) {
    if (internal.settled) return;
    internal.settled = true;
    const task = internal.task;
    task.state = "cancelled";
    task.finishedAt = new Date(this.now()).toISOString();
    this.schedule(() => this.emitFinished(internal), CANCEL_ACK_DELAY_MS);
  }
  emitFinished(internal) {
    if (internal.finishNotified) return;
    internal.finishNotified = true;
    const task = internal.task;
    this.emit(Events.SFTP_TRANSFER_FINISHED, {
      transferId: task.id,
      sessionId: task.sessionId,
      direction: task.direction,
      files: task.filesDone,
      bytes: task.bytesDone,
      durationMs: Math.max(0, this.now() - internal.startedAtMs)
    });
  }
  // ------------------------------ 基础设施 ---------------------------------
  async resolveSftpFor(internal) {
    try {
      return await this.resolveSftp(internal.task.sessionId);
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw AppError.notConnected(`SFTP 通道不可用: ${errorMessage(err)}`);
    }
  }
  gateFor(sessionId2) {
    let gate = this.gates.get(sessionId2);
    if (!gate) {
      gate = new TransferGate(this.settings.maxInflightPerConnection, (busy) => {
        this.emit(Events.SFTP_BUSY, { sessionId: sessionId2, busy });
      });
      this.gates.set(sessionId2, gate);
    }
    return gate;
  }
  async withSlot(internal, fn) {
    const release = await this.gateFor(internal.task.sessionId).acquire(internal.signal);
    if (!release) throw new CancelledTransferError();
    try {
      return await fn();
    } finally {
      release();
    }
  }
  throwIfCancelled(internal) {
    if (internal.signal.cancelled) throw new CancelledTransferError();
  }
  async statOrNull(sftp, path) {
    const p = normalizeRemotePath(path);
    try {
      return await sftpFs.stat(sftp, p);
    } catch (err) {
      if (isNoSuchFile(err)) return null;
      throw err;
    }
  }
  trimHistory() {
    while (this.order.length > this.maxTasks) {
      const oldest = this.order[0];
      if (oldest === void 0) break;
      const internal = this.tasks.get(oldest);
      if (internal && !internal.settled) break;
      this.order.shift();
      this.tasks.delete(oldest);
      if (internal) this.maybeDisposeGate(internal.task.sessionId);
    }
  }
  /** 某会话已无任务时释放闸门，避免长时间运行后 Map 无限增长 */
  maybeDisposeGate(sessionId2) {
    for (const internal of this.tasks.values()) {
      if (internal.task.sessionId === sessionId2) return;
    }
    this.gates.delete(sessionId2);
  }
}
function snapshot(task) {
  return {
    ...task,
    ...task.files ? { files: task.files.map((f) => ({ ...f })) } : {}
  };
}
function errorMessage(err) {
  return err instanceof Error ? err.message : String(err);
}
function joinLocalRelative(root, relativePath) {
  const safe = relativePath.split("/").filter((s) => s !== "" && s !== "." && s !== "..");
  return join(root, ...safe);
}
function dirnameLocal(p) {
  const idx = p.lastIndexOf(sep);
  if (idx <= 0) return p.startsWith(sep) ? sep : ".";
  return p.slice(0, idx);
}
const log = createLogger("sftp");
const sessionId = z.string().min(1, "缺少 sessionId");
const remotePath = z.string().min(1, "路径不能为空");
const modeSchema = z.union([z.number().int(), z.string().min(1)]);
const conflictPolicy = z.enum(["ask", "overwrite", "skip", "rename"]);
const listSchema = z.object({ sessionId, path: remotePath, showHidden: z.boolean().optional() });
const statSchema = z.object({ sessionId, path: remotePath });
const mkdirSchema = z.object({ sessionId, path: remotePath, mode: modeSchema.optional() });
const renameSchema = z.object({
  sessionId,
  from: remotePath,
  to: remotePath,
  overwrite: z.boolean().optional()
});
const removeSchema = z.object({ sessionId, path: remotePath, recursive: z.boolean().optional() });
const chmodSchema = z.object({
  sessionId,
  path: remotePath,
  mode: modeSchema,
  /** 目录递归（等价 chmod -R）；不勾只改目录自身 */
  recursive: z.boolean().optional()
});
const homeSchema = z.object({ sessionId });
const readFileSchema = z.object({
  sessionId,
  path: remotePath,
  maxBytes: z.number().int().positive().optional()
});
const writeFileSchema = z.object({ sessionId, path: remotePath, content: z.string() });
const transferSchema = z.object({
  sessionId,
  direction: z.enum(["upload", "download"]),
  sourcePath: z.string().min(1, "源路径不能为空"),
  targetPath: z.string().min(1, "目标路径不能为空"),
  recursive: z.boolean().optional(),
  conflictPolicy: conflictPolicy.optional(),
  resume: z.boolean().optional(),
  preservePermissions: z.boolean().optional(),
  preserveTimestamps: z.boolean().optional()
});
const cancelTransferSchema = z.object({ transferId: z.string().min(1) });
const listTransfersSchema = z.object({ sessionId: sessionId.optional() });
const openEditorSchema = z.object({ sessionId, path: remotePath });
const channels = /* @__PURE__ */ new Map();
let editors = null;
function editorRegistry(ctx) {
  if (!editors) {
    const registry = new RemoteEditorRegistry({
      sftpFor,
      // 断言只放在**这一个接线点**：事件的载荷对象在 editor.ts 里按契约构造，
      // 这里只是把"具体事件名 + 对应载荷"这层关系交给运行期（TS 无法在此处收窄）。
      emit: (event, payload) => ctx.emit(event, payload)
    });
    subscribeSessionClosed((sessionId2) => {
      const n = registry.closeBySession(sessionId2);
      if (n > 0) log.info(`会话 ${sessionId2} 断开，已结束 ${n} 个远端编辑会话`);
    });
    editors = { registry, ctx };
  }
  return editors;
}
function requireSessionOrThrow(id) {
  try {
    return requireSession(id);
  } catch (err) {
    throw AppError.notConnected(err instanceof Error ? err.message : "会话不存在或已断开");
  }
}
function sftpFor(id) {
  if (isLocalSession(id)) return Promise.resolve(createLocalSftpLike());
  const cached = channels.get(id);
  if (cached) return cached.then(toSftpLike);
  const handle = requireSessionOrThrow(id);
  try {
    ;
    handle.client.setNoDelay?.(true);
  } catch {
  }
  const pending = new Promise((resolve, reject2) => {
    handle.client.sftp((err, sftp) => {
      if (err) reject2(AppError.notConnected(`打开 SFTP 通道失败: ${err.message}`));
      else resolve(sftp);
    });
  });
  channels.set(id, pending);
  void pending.then((wrapper) => {
    const drop = () => {
      if (channels.get(id) === pending) channels.delete(id);
    };
    wrapper.once("end", drop);
    wrapper.once("close", drop);
  }).catch(() => {
    if (channels.get(id) === pending) channels.delete(id);
  });
  return pending.then(toSftpLike);
}
let engine = null;
function engineFor(ctx) {
  if (!engine) {
    engine = new TransferEngine({
      emit: ctx.emit,
      resolveSftp: sftpFor,
      logger: ctx.logger
    });
  } else {
    engine.setEmitter(ctx.emit);
  }
  return engine;
}
const sftpHandlers = {
  list: async (payload) => {
    const { sessionId: id, path, showHidden } = listSchema.parse(payload);
    const sftp = await sftpFor(id);
    return listDirectory(sftp, path, { showHidden: showHidden ?? false });
  },
  stat: async (payload) => {
    const { sessionId: id, path } = statSchema.parse(payload);
    return statPath(await sftpFor(id), path);
  },
  mkdir: async (payload) => {
    const { sessionId: id, path, mode } = mkdirSchema.parse(payload);
    return makeDirectory(await sftpFor(id), path, mode);
  },
  rename: async (payload) => {
    const { sessionId: id, from, to, overwrite } = renameSchema.parse(payload);
    await renamePath(await sftpFor(id), from, to, { overwrite: overwrite ?? false });
    return { from, to, renamed: true };
  },
  remove: async (payload) => {
    const { sessionId: id, path, recursive } = removeSchema.parse(payload);
    await removePath(await sftpFor(id), path, { recursive: recursive ?? false });
    return { path, removed: true };
  },
  /**
   * 改权限（支持递归）。
   *
   * 返回**逐项结果**而不是只回一个 ok：一棵树里个别文件没权限是常事，
   * 只报"成功"会让用户以为全改了。`commands`/`summary` 同时供界面展示实际执行了什么。
   */
  chmod: async (payload) => {
    const { sessionId: id, path, mode, recursive } = chmodSchema.parse(payload);
    const result = await chmodPath(await sftpFor(id), path, mode, { recursive: recursive ?? false });
    return { path, mode, ...result };
  },
  /** 预备命令预览：**只算不改**（spec 要求执行前能看到会动哪些路径） */
  previewChmod: async (payload) => {
    const { sessionId: id, path, mode, recursive } = chmodSchema.parse(payload);
    return planChmod(await sftpFor(id), path, mode, { recursive: recursive ?? false });
  },
  home: async (payload) => {
    const { sessionId: id } = homeSchema.parse(payload);
    const sftp = await sftpFor(id);
    return { path: await remoteHome(sftp) };
  },
  readFile: async (payload) => {
    const { sessionId: id, path, maxBytes } = readFileSchema.parse(payload);
    const sftp = await sftpFor(id);
    return readRemoteTextFile(sftp, path, maxBytes === void 0 ? {} : { maxBytes });
  },
  writeFile: async (payload) => {
    const { sessionId: id, path, content } = writeFileSchema.parse(payload);
    const sftp = await sftpFor(id);
    return writeRemoteTextFile(sftp, path, content);
  },
  upload: (payload, ctx) => {
    const req = transferSchema.parse(payload);
    return engineFor(ctx).submit(req);
  },
  download: (payload, ctx) => {
    const req = transferSchema.parse(payload);
    return engineFor(ctx).submit(req);
  },
  cancelTransfer: (payload, ctx) => {
    const { transferId } = cancelTransferSchema.parse(payload);
    return { transferId, cancelled: engineFor(ctx).cancel(transferId) };
  },
  listTransfers: (payload, ctx) => {
    const { sessionId: id } = listTransfersSchema.parse(payload);
    return engineFor(ctx).listTransfers(id);
  },
  /**
   * 远端编辑入口：把远端文件物化到系统临时目录，返回本地路径供编辑器打开。
   *
   * 用 os.tmpdir() 而不是应用数据目录 —— 编辑副本是易失的中间产物，
   * 不该进入用户数据目录、也不该被备份/同步带走。
   */
  openEditor: async (payload, ctx) => {
    const { sessionId: id, path } = openEditorSchema.parse(payload);
    const sftp = await sftpFor(id);
    const file = await readRemoteTextFile(sftp, path);
    const dir = join(tmpdir(), "t1000-remote-edit", id);
    await mkdir(dir, { recursive: true });
    const localPath = join(dir, basename(file.path));
    await writeFile(localPath, file.content, "utf8");
    const editId = randomUUID();
    const result = {
      remotePath: file.path,
      localPath,
      size: file.size,
      mtime: file.mtime,
      mode: file.mode,
      /** 每次编辑会话一个 id，供上层关联保存动作 */
      editId
    };
    const { registry } = editorRegistry(ctx);
    registry.open({
      editId,
      sessionId: id,
      remotePath: file.path,
      localPath,
      remoteMtimeAtOpen: file.mtime,
      // 记下物化时的内容摘要：写回时内容没变就跳过，避免编辑器"只是碰了一下"也传一遍
      lastHash: hashContent(file.content),
      startedAt: Date.now()
    });
    return result;
  },
  /** 手动写回（用户在编辑器里保存后由界面调用；自动写回由监听触发） */
  saveEditor: async (payload, ctx) => {
    const parsed = z.object({ editId: z.string().min(1) }).parse(payload);
    const { registry } = editorRegistry(ctx);
    return registry.save(parsed.editId, "manual");
  },
  /** 结束编辑会话：停掉本地监听（否则监听会一直留着，写回必然失败） */
  closeEditor: (payload, ctx) => {
    const parsed = z.object({ editId: z.string().min(1) }).parse(payload);
    const { registry } = editorRegistry(ctx);
    return { editId: parsed.editId, closed: registry.close(parsed.editId) };
  }
};
export {
  sftpHandlers
};
