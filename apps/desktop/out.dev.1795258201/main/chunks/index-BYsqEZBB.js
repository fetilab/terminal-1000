import { randomUUID } from "node:crypto";
import { z } from "zod";
import { p as parseInput, A as AppError, k as getStoreService, S as STORE_KEYS, c as createLogger } from "../index.js";
import "electron";
import "node:path";
import "node:fs";
import "node:child_process";
import "node:net";
import "node:url";
import "better-sqlite3";
import "node:os";
import "node:fs/promises";
const log = createLogger("notes");
const EXCERPT_LENGTH = 160;
function nowIso() {
  return (/* @__PURE__ */ new Date()).toISOString();
}
function readAllNotes() {
  const db = getStoreService().db;
  const rows = db.listIds(STORE_KEYS.note);
  const out = [];
  for (const row of rows) {
    const full = db.get(STORE_KEYS.note, row.item_id);
    if (!full) continue;
    try {
      out.push(JSON.parse(full.payload));
    } catch (err) {
      log.warn(`笔记 ${row.item_id} 损坏，已跳过`, err);
    }
  }
  return out;
}
function readNote(id) {
  const row = getStoreService().db.get(STORE_KEYS.note, id);
  if (!row) return void 0;
  try {
    return JSON.parse(row.payload);
  } catch (err) {
    throw AppError.internal(`笔记数据损坏: ${id}`, err);
  }
}
function writeNote(note) {
  getStoreService().db.put(STORE_KEYS.note, note.id, JSON.stringify(note), Date.now());
}
function readAllFolders() {
  const db = getStoreService().db;
  const rows = db.listIds(STORE_KEYS.noteFolder);
  const out = [];
  for (const row of rows) {
    const full = db.get(STORE_KEYS.noteFolder, row.item_id);
    if (!full) continue;
    try {
      out.push(JSON.parse(full.payload));
    } catch {
    }
  }
  return out.sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
}
function toSummary(note) {
  const content = note.content ?? "";
  return {
    id: note.id,
    title: note.title,
    ...note.folderId ? { folderId: note.folderId } : {},
    ...note.connectionId ? { connectionId: note.connectionId } : {},
    ...note.groupId ? { groupId: note.groupId } : {},
    ...note.tags ? { tags: note.tags } : {},
    ...note.favorite !== void 0 ? { favorite: note.favorite } : {},
    ...note.trashed !== void 0 ? { trashed: note.trashed } : {},
    ...note.deletedAt ? { deletedAt: note.deletedAt } : {},
    contentLength: content.length,
    excerpt: content.replace(/\s+/g, " ").slice(0, EXCERPT_LENGTH),
    createdAt: note.createdAt,
    updatedAt: note.updatedAt
  };
}
function collectFolderSubtree(folders, rootId) {
  const ids = /* @__PURE__ */ new Set([rootId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const f of folders) {
      if (f.parentId && ids.has(f.parentId) && !ids.has(f.id)) {
        ids.add(f.id);
        grew = true;
      }
    }
  }
  return ids;
}
const idSchema = z.object({ id: z.string().min(1) });
const listSchema = z.object({
  /** 只看废纸篓 */
  trashed: z.boolean().optional(),
  folderId: z.string().optional(),
  connectionId: z.string().optional(),
  groupId: z.string().optional(),
  /** 关键词过滤（标题 + 正文） */
  keyword: z.string().optional(),
  favoritesOnly: z.boolean().optional(),
  limit: z.number().int().positive().max(5e3).optional()
}).optional();
const saveSchema = z.object({
  id: z.string().optional(),
  title: z.string().max(500).optional(),
  content: z.string().optional(),
  folderId: z.string().nullable().optional(),
  connectionId: z.string().nullable().optional(),
  groupId: z.string().nullable().optional(),
  tags: z.array(z.string()).optional(),
  favorite: z.boolean().optional()
});
const folderSchema = z.object({
  id: z.string().optional(),
  name: z.string().min(1).max(200),
  parentId: z.string().nullable().optional(),
  sortOrder: z.number().int().optional()
});
const notesHandlers = {
  /** 列表：返回不含正文的摘要 */
  list: (payload) => {
    const opts = parseInput(listSchema, payload ?? {});
    let notes = readAllNotes();
    const wantTrashed = opts?.trashed === true;
    notes = notes.filter((n) => Boolean(n.trashed) === wantTrashed);
    if (opts?.folderId) notes = notes.filter((n) => n.folderId === opts.folderId);
    if (opts?.connectionId) notes = notes.filter((n) => n.connectionId === opts.connectionId);
    if (opts?.groupId) notes = notes.filter((n) => n.groupId === opts.groupId);
    if (opts?.favoritesOnly) notes = notes.filter((n) => n.favorite === true);
    if (opts?.keyword) {
      const kw = opts.keyword.toLowerCase();
      notes = notes.filter(
        (n) => n.title.toLowerCase().includes(kw) || (n.content ?? "").toLowerCase().includes(kw)
      );
    }
    notes.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    if (opts?.limit) notes = notes.slice(0, opts.limit);
    return notes.map(toSummary);
  },
  get: (payload) => {
    const { id } = parseInput(idSchema, payload);
    const note = readNote(id);
    if (!note) throw AppError.notFound(`笔记不存在: ${id}`);
    return note;
  },
  /** 新建或更新（有 id 即更新） */
  save: (payload) => {
    const input = parseInput(saveSchema, payload);
    const ts = nowIso();
    if (input.id) {
      const existing = readNote(input.id);
      if (!existing) throw AppError.notFound(`笔记不存在: ${input.id}`);
      const next = {
        ...existing,
        ...input.title !== void 0 ? { title: input.title } : {},
        ...input.content !== void 0 ? { content: input.content } : {},
        ...input.tags !== void 0 ? { tags: input.tags } : {},
        ...input.favorite !== void 0 ? { favorite: input.favorite } : {},
        ...input.folderId !== void 0 ? { folderId: input.folderId ?? void 0 } : {},
        ...input.connectionId !== void 0 ? { connectionId: input.connectionId ?? void 0 } : {},
        ...input.groupId !== void 0 ? { groupId: input.groupId ?? void 0 } : {},
        updatedAt: ts
      };
      pruneUndefined(next);
      writeNote(next);
      return next;
    }
    const note = {
      id: randomUUID(),
      title: input.title ?? "未命名笔记",
      content: input.content ?? "",
      ...input.folderId ? { folderId: input.folderId } : {},
      ...input.connectionId ? { connectionId: input.connectionId } : {},
      ...input.groupId ? { groupId: input.groupId } : {},
      ...input.tags ? { tags: input.tags } : {},
      favorite: input.favorite ?? false,
      trashed: false,
      createdAt: ts,
      updatedAt: ts
    };
    pruneUndefined(note);
    writeNote(note);
    return note;
  },
  /** 软删除：移入废纸篓 */
  delete: (payload) => {
    const { id } = parseInput(idSchema, payload);
    const note = readNote(id);
    if (!note) throw AppError.notFound(`笔记不存在: ${id}`);
    const next = { ...note, trashed: true, deletedAt: nowIso(), updatedAt: nowIso() };
    writeNote(next);
    return { trashed: true, id };
  },
  /** 从废纸篓恢复 */
  restore: (payload) => {
    const { id } = parseInput(idSchema, payload);
    const note = readNote(id);
    if (!note) throw AppError.notFound(`笔记不存在: ${id}`);
    if (!note.trashed) throw AppError.badRequest("该笔记不在废纸篓中");
    const next = { ...note, trashed: false, updatedAt: nowIso() };
    delete next.deletedAt;
    writeNote(next);
    return next;
  },
  /** 彻底删除（不可恢复） */
  purge: (payload) => {
    const { id } = parseInput(idSchema, payload);
    const note = readNote(id);
    if (!note) throw AppError.notFound(`笔记不存在: ${id}`);
    getStoreService().db.delete(STORE_KEYS.note, id);
    return { purged: true, id };
  },
  // ── 文件夹 ────────────────────────────────────────
  listFolders: () => readAllFolders(),
  saveFolder: (payload) => {
    const input = parseInput(folderSchema, payload);
    const folders = readAllFolders();
    const ts = nowIso();
    if (input.id) {
      const idx = folders.findIndex((f) => f.id === input.id);
      if (idx === -1) throw AppError.notFound(`文件夹不存在: ${input.id}`);
      const existing = folders[idx];
      const next = {
        ...existing,
        name: input.name,
        ...input.parentId !== void 0 ? { parentId: input.parentId ?? void 0 } : {},
        ...input.sortOrder !== void 0 ? { sortOrder: input.sortOrder } : {},
        updatedAt: ts
      };
      pruneUndefined(next);
      getStoreService().db.put(STORE_KEYS.noteFolder, next.id, JSON.stringify(next), Date.now());
      return next;
    }
    const folder = {
      id: randomUUID(),
      name: input.name,
      ...input.parentId ? { parentId: input.parentId } : {},
      sortOrder: input.sortOrder ?? folders.length,
      createdAt: ts,
      updatedAt: ts
    };
    pruneUndefined(folder);
    getStoreService().db.put(STORE_KEYS.noteFolder, folder.id, JSON.stringify(folder), Date.now());
    return folder;
  },
  /** 删除文件夹：子文件夹一并删除，其中的笔记回到未分类（不随删除丢失） */
  deleteFolder: (payload) => {
    const { id } = parseInput(idSchema, payload);
    const folders = readAllFolders();
    if (!folders.some((f) => f.id === id)) throw AppError.notFound(`文件夹不存在: ${id}`);
    const doomed = collectFolderSubtree(folders, id);
    let detached = 0;
    for (const note of readAllNotes()) {
      if (note.folderId && doomed.has(note.folderId)) {
        const next = { ...note, updatedAt: nowIso() };
        delete next.folderId;
        writeNote(next);
        detached += 1;
      }
    }
    const db = getStoreService().db;
    for (const fid of doomed) db.delete(STORE_KEYS.noteFolder, fid);
    return { deletedFolders: [...doomed], detachedNotes: detached };
  }
};
function pruneUndefined(obj) {
  const rec = obj;
  for (const [k, v] of Object.entries(rec)) {
    if (v === void 0) {
      delete rec[k];
    } else if (typeof v === "object" && v !== null && !Array.isArray(v)) {
      pruneUndefined(v);
    }
  }
}
export {
  notesHandlers
};
