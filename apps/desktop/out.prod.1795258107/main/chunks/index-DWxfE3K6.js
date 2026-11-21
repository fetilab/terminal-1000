import { randomUUID } from "node:crypto";
import { z } from "zod";
import { p as parseInput, A as AppError, g as getWritable, E as Events, l as listWritables, u as unregisterWritable, c as createLogger } from "../index.js";
import "electron";
import "node:path";
import "node:fs";
import "node:child_process";
import "node:net";
import "node:url";
import "better-sqlite3";
import "node:os";
import "node:fs/promises";
const log = createLogger("broadcast");
const groups = /* @__PURE__ */ new Map();
let activeCtx = null;
function toView(group) {
  return {
    groupId: group.groupId,
    name: group.name,
    mode: group.mode,
    createdAt: new Date(group.createdAt).toISOString(),
    members: group.sessionIds.map((sessionId) => {
      const writable = getWritable(sessionId);
      return {
        sessionId,
        kind: writable?.kind ?? "ssh",
        title: writable?.title ?? sessionId,
        writable: writable ? writable.canWrite() : false
      };
    })
  };
}
function listViews() {
  return [...groups.values()].map(toView);
}
function broadcast() {
  activeCtx?.emit(Events.BROADCAST_STATE, { groups: listViews() });
}
function requireGroup(groupId) {
  const g = groups.get(groupId);
  if (!g) throw AppError.notFound(`广播组不存在: ${groupId}`);
  return g;
}
function onSessionClosed(sessionId) {
  let changed = false;
  for (const group of groups.values()) {
    const idx = group.sessionIds.indexOf(sessionId);
    if (idx >= 0) {
      group.sessionIds.splice(idx, 1);
      changed = true;
    }
  }
  for (const [id, group] of groups) {
    if (group.sessionIds.length === 0) {
      groups.delete(id);
      log.info(`广播组 ${group.name} 成员已全部断开，自动解散`);
      changed = true;
    }
  }
  unregisterWritable(sessionId);
  if (changed) broadcast();
}
function shutdownBroadcast() {
  groups.clear();
  activeCtx = null;
}
const createSchema = z.object({
  sessionIds: z.array(z.string().min(1)).min(1).max(64),
  name: z.string().max(100).optional(),
  /** 建组即进入广播模式（多选连接"一次打开"时的常见诉求） */
  mode: z.enum(["independent", "broadcast"]).optional()
});
const groupIdSchema = z.object({ groupId: z.string().min(1) });
const modifySchema = z.object({
  groupId: z.string().min(1),
  sessionIds: z.array(z.string().min(1)).min(1).max(64)
});
const setModeSchema = z.object({
  groupId: z.string().min(1),
  mode: z.enum(["independent", "broadcast"])
});
const sendSchema = z.object({
  groupId: z.string().min(1),
  /** 要广播的原始输入（含控制字符，如 \r） */
  data: z.string().max(64 * 1024)
});
const broadcastHandlers = {
  create: (payload, ctx) => {
    activeCtx = ctx;
    const { sessionIds, name, mode } = parseInput(createSchema, payload);
    const unique = [...new Set(sessionIds)];
    const known = new Set(listWritables().map((w) => w.sessionId));
    const unknown = unique.filter((id) => !known.has(id));
    if (unknown.length === unique.length) {
      throw AppError.notFound("这些会话当前都不可写入（可能已断开）");
    }
    const group = {
      groupId: randomUUID(),
      name: name ?? `${unique.length} 台会话`,
      mode: mode ?? "independent",
      sessionIds: unique,
      createdAt: Date.now()
    };
    groups.set(group.groupId, group);
    broadcast();
    return { group: toView(group), skipped: unknown };
  },
  dissolve: (payload, ctx) => {
    activeCtx = ctx;
    const { groupId } = parseInput(groupIdSchema, payload);
    const group = requireGroup(groupId);
    groups.delete(groupId);
    broadcast();
    return { dissolved: true, groupId, name: group.name };
  },
  add: (payload, ctx) => {
    activeCtx = ctx;
    const { groupId, sessionIds } = parseInput(modifySchema, payload);
    const group = requireGroup(groupId);
    for (const id of sessionIds) {
      if (!group.sessionIds.includes(id)) group.sessionIds.push(id);
    }
    broadcast();
    return { group: toView(group) };
  },
  remove: (payload, ctx) => {
    activeCtx = ctx;
    const { groupId, sessionIds } = parseInput(modifySchema, payload);
    const group = requireGroup(groupId);
    group.sessionIds = group.sessionIds.filter((id) => !sessionIds.includes(id));
    if (group.sessionIds.length === 0) {
      groups.delete(groupId);
    }
    broadcast();
    return { group: group.sessionIds.length > 0 ? toView(group) : null };
  },
  setMode: (payload, ctx) => {
    activeCtx = ctx;
    const { groupId, mode } = parseInput(setModeSchema, payload);
    const group = requireGroup(groupId);
    group.mode = mode;
    broadcast();
    log.info(`广播组 ${group.name} 切换到${mode === "broadcast" ? "广播" : "独立"}模式`);
    return { group: toView(group) };
  },
  /**
   * 广播一段输入。
   *
   * 独立模式下**直接拒绝**而不是静默什么都不做 ——
   * 否则 UI 出错时会表现为"输入丢了"，难以定位。
   */
  send: (payload, ctx) => {
    activeCtx = ctx;
    const { groupId, data } = parseInput(sendSchema, payload);
    const group = requireGroup(groupId);
    if (group.mode !== "broadcast") {
      throw AppError.badRequest("当前为独立模式，未开启广播");
    }
    const delivered = [];
    const skipped = [];
    for (const sessionId of group.sessionIds) {
      const target = getWritable(sessionId);
      if (!target) {
        skipped.push({ sessionId, title: sessionId, message: "会话不存在或已断开" });
        continue;
      }
      if (!target.canWrite()) {
        skipped.push({ sessionId, title: target.title, message: "当前不可写入" });
        continue;
      }
      try {
        target.write(data);
        delivered.push(sessionId);
      } catch (err) {
        skipped.push({
          sessionId,
          title: target.title,
          message: err instanceof Error ? err.message : "写入失败"
        });
      }
    }
    for (const s of skipped) {
      ctx.emit(Events.BROADCAST_ERROR, {
        groupId,
        sessionId: s.sessionId,
        title: s.title,
        message: s.message
      });
    }
    return { delivered: delivered.length, skipped: skipped.length, details: skipped };
  },
  list: () => listViews(),
  status: (payload) => {
    const { groupId } = parseInput(groupIdSchema, payload);
    return toView(requireGroup(groupId));
  }
};
export {
  broadcastHandlers,
  onSessionClosed,
  shutdownBroadcast
};
