import { randomUUID, randomBytes } from "node:crypto";
import { z } from "zod";
import { A as AppError, p as parseInput, g as getWritable } from "../index.js";
import { userInfo, hostname, networkInterfaces } from "node:os";
import "electron";
import "node:path";
import "node:fs";
import "node:child_process";
import "node:net";
import "node:url";
import "better-sqlite3";
import "node:fs/promises";
const DYNAMIC_VARIABLES = [
  {
    name: "date",
    description: "当前日期",
    defaultFormat: "YYYY-MM-DD",
    example: "2025-11-29",
    formats: "YYYY / YY / MM / DD / YYYYMMDD / YYYY-MM"
  },
  {
    name: "time",
    description: "当前时间",
    defaultFormat: "HH:mm:ss",
    example: "14:30:45",
    formats: "HH / mm / ss / HHmmss"
  },
  {
    name: "timestamp",
    description: "Unix 时间戳（秒）",
    defaultFormat: "-",
    example: "1732869000"
  },
  {
    name: "week",
    description: "一年中的第几周（ISO 周）",
    defaultFormat: "-",
    example: "48"
  },
  {
    name: "uuid",
    description: "生成 UUID（v4）",
    defaultFormat: "-",
    example: "a1b2c3d4-e5f6-7890-abcd-ef1234567890"
  },
  {
    name: "random",
    description: "生成随机字符串",
    defaultFormat: "6",
    example: "xK9mPq",
    formats: "random:N（默认 6，范围 1-64）"
  },
  {
    name: "clipboard",
    description: "获取系统剪贴板内容",
    defaultFormat: "-",
    example: "（剪贴板文本）"
  },
  {
    name: "password",
    description: "当前 SSH 连接的登录密码",
    defaultFormat: "-",
    example: "（自动填充）",
    secret: true
  },
  // —— 以下为任务要求补充的常用变量（参考实现文档未列出，但同属"系统内置"语义）——
  {
    name: "hostname",
    description: "本机主机名",
    defaultFormat: "-",
    example: "dev-workstation"
  },
  {
    name: "username",
    description: "本机登录用户名",
    defaultFormat: "-",
    example: "mosfet"
  },
  {
    name: "ip",
    description: "本机 IP 地址（第一个非回环 IPv4）",
    defaultFormat: "-",
    example: "192.168.1.20"
  }
];
const VARIABLE_NAMES = new Set(DYNAMIC_VARIABLES.map((v) => v.name));
function isDynamicVariable(name) {
  return VARIABLE_NAMES.has(name.trim());
}
function getVariableDef(name) {
  const key = name.trim();
  return DYNAMIC_VARIABLES.find((v) => v.name === key);
}
const RANDOM_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
function defaultRandomString(length) {
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) {
    out += RANDOM_CHARS[(bytes[i] ?? 0) % RANDOM_CHARS.length];
  }
  return out;
}
function pad(n, width = 2) {
  return String(n).padStart(width, "0");
}
function isoWeek(date) {
  const target = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = (target.getUTCDay() + 6) % 7;
  target.setUTCDate(target.getUTCDate() - dayNum + 3);
  const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
  const firstDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNum + 3);
  const diff = target.getTime() - firstThursday.getTime();
  return 1 + Math.round(diff / (7 * 24 * 3600 * 1e3));
}
function formatDateTime(date, format) {
  const tokens = {
    YYYY: String(date.getFullYear()),
    YY: pad(date.getFullYear() % 100),
    MM: pad(date.getMonth() + 1),
    DD: pad(date.getDate()),
    HH: pad(date.getHours()),
    mm: pad(date.getMinutes()),
    ss: pad(date.getSeconds())
  };
  return format.replace(/YYYY|YY|MM|DD|HH|mm|ss/g, (token) => tokens[token] ?? token);
}
function resolveLocalIp() {
  try {
    const interfaces = networkInterfaces();
    for (const list of Object.values(interfaces)) {
      for (const info of list ?? []) {
        if (info.family === "IPv4" && !info.internal) return info.address;
      }
    }
  } catch {
  }
  return "";
}
function resolveDefault(name, ctx) {
  switch (name) {
    case "hostname":
      return ctx.hostname ?? (() => {
        try {
          return hostname();
        } catch {
          return "";
        }
      })();
    case "username":
      return ctx.username ?? (() => {
        try {
          return userInfo().username;
        } catch {
          return "";
        }
      })();
    case "ip":
      return ctx.localIp ?? resolveLocalIp();
    default:
      return void 0;
  }
}
function evaluateVariable(name, format, ctx = {}) {
  const key = name.trim();
  const now = ctx.now ?? /* @__PURE__ */ new Date();
  const rng = ctx.randomString ?? defaultRandomString;
  switch (key) {
    case "date":
      return formatDateTime(now, format?.trim() || "YYYY-MM-DD");
    case "time":
      return formatDateTime(now, format?.trim() || "HH:mm:ss");
    case "timestamp":
      return String(Math.floor(now.getTime() / 1e3));
    case "week":
      return String(isoWeek(now));
    case "uuid":
      return (ctx.uuid ?? randomUUID)();
    case "random": {
      const requested = format?.trim() === void 0 || format?.trim() === "" ? 6 : Number(format.trim());
      const length = Number.isFinite(requested) ? Math.min(Math.max(Math.floor(requested), 1), 64) : 6;
      return rng(length);
    }
    case "clipboard":
      return ctx.clipboard ?? "";
    case "password":
      return ctx.password ?? "";
    default:
      return resolveDefault(key, ctx) ?? "";
  }
}
const MASK = "••••••••";
function variablePreview(def, ctx = {}, format) {
  const raw = evaluateVariable(def.name, format, ctx);
  if (def.secret) {
    return {
      name: def.name,
      description: def.description,
      format: format?.trim() || def.defaultFormat,
      value: raw === "" ? "" : MASK,
      masked: true,
      hasValue: raw !== "",
      secret: true
    };
  }
  return {
    name: def.name,
    description: def.description,
    format: format?.trim() || def.defaultFormat,
    value: raw,
    masked: false,
    hasValue: raw !== "",
    secret: false
  };
}
function listVariablePreviews(ctx = {}) {
  return DYNAMIC_VARIABLES.map((def) => variablePreview(def, ctx));
}
const DAY = 24 * 3600 * 1e3;
const DEFAULTS = { perParamLimit: 10, maxAgeMs: 90 * DAY };
class ParamHistory {
  constructor(options = {}) {
    this.data = {};
    this.perParamLimit = Math.max(1, options.perParamLimit ?? DEFAULTS.perParamLimit);
    this.maxAgeMs = Math.max(0, options.maxAgeMs ?? DEFAULTS.maxAgeMs);
    this.now = options.now ?? (() => Date.now());
  }
  /**
   * 记录一个参数值。
   * - 空值忽略（清空输入框不应污染历史）
   * - 同名值只保留最新一条（去重后置顶）
   * - 动态变量名直接忽略
   */
  record(name, value) {
    const key = name.trim();
    const trimmed = value;
    if (key === "" || trimmed.trim() === "") return;
    if (isDynamicVariable(key)) return;
    const list = this.data[key] ?? [];
    const kept = list.filter((entry) => entry.value !== trimmed);
    kept.unshift({ value: trimmed, usedAt: this.now() });
    this.data[key] = kept.slice(0, this.perParamLimit);
  }
  /** 批量记录一次执行填写的所有参数 */
  recordAll(values) {
    for (const [name, value] of Object.entries(values)) this.record(name, value);
  }
  /** 某参数的最近值（按最近使用排序，已过滤过期） */
  recent(name, limit) {
    const list = (this.data[name.trim()] ?? []).filter((entry) => !this.isExpired(entry));
    const sliced = limit === void 0 ? list : list.slice(0, Math.max(0, limit));
    return sliced.map((entry) => entry.value);
  }
  /** 回填用：某参数的**最新值**（没有则 undefined） */
  latest(name) {
    return this.recent(name, 1)[0];
  }
  /** 一次执行的所有参数预填值（前端填表用） */
  prefill(names) {
    const out = {};
    for (const name of names) {
      const value = this.latest(name);
      if (value !== void 0) out[name] = value;
    }
    return out;
  }
  /** 全量数据（持久化用；已剔除过期项） */
  all() {
    const out = {};
    for (const [name, list] of Object.entries(this.data)) {
      const kept = list.filter((entry) => !this.isExpired(entry));
      if (kept.length > 0) out[name] = kept.map((entry) => ({ ...entry }));
    }
    return out;
  }
  /** 从持久化数据恢复（过滤脏数据） */
  load(data) {
    if (!data || typeof data !== "object") return;
    const next = {};
    for (const [name, list] of Object.entries(data)) {
      if (typeof name !== "string" || name.trim() === "" || isDynamicVariable(name)) continue;
      if (!Array.isArray(list)) continue;
      const cleaned = [];
      for (const raw of list) {
        if (typeof raw !== "object" || raw === null) continue;
        const value = raw.value;
        const usedAt = raw.usedAt;
        if (typeof value !== "string" || value === "") continue;
        if (typeof usedAt !== "number" || !Number.isFinite(usedAt)) continue;
        cleaned.push({ value, usedAt });
      }
      cleaned.sort((a, b) => b.usedAt - a.usedAt);
      if (cleaned.length > 0) next[name] = cleaned.slice(0, this.perParamLimit);
    }
    this.data = next;
  }
  /** 清掉过期项，返回清理条数 */
  prune() {
    let removed = 0;
    for (const [name, list] of Object.entries(this.data)) {
      const kept = list.filter((entry) => !this.isExpired(entry));
      removed += list.length - kept.length;
      if (kept.length === 0) delete this.data[name];
      else this.data[name] = kept;
    }
    return removed;
  }
  /** 清空某个参数的历史，或不传参数清空全部 */
  clear(name) {
    if (name === void 0) {
      this.data = {};
      return;
    }
    delete this.data[name.trim()];
  }
  get size() {
    return Object.keys(this.data).length;
  }
  isExpired(entry) {
    return this.now() - entry.usedAt > this.maxAgeMs;
  }
}
const PINYIN_TABLE = {
  a: "阿啊安按案爱",
  b: "不部本表备版变步播包报白把百帮保北比边编标别病波补布并币必闭绑背被板崩半便",
  c: "测存错查参层次从出传车成程除初处串创磁词粗催才采菜残操草侧策差常场超朝潮彻沉陈称城承吃池迟持冲重抽储触川穿窗吹春纯此刺促存长插拆充",
  d: "的地大点电端段动定单打带代队对多度道到等低底第调丢东都读短断堆兑顿夺掉当但丁",
  e: "二额",
  f: "服分发方法放防复反非费封风否副负附番翻返犯饭泛房访飞废份丰峰浮符福富覆",
  g: "个管关高更工功公国过改干刚港告格各给根跟共沟构估古谷股故顾挂观官光广归规滚果隔盖固供",
  h: "和后会好环换回户化话还海含汉毫号合何核黑很红候忽湖互花华划画缓汇混活火或货恒函",
  j: "就进机记加检简建解接结计集技继家价间监见件健将交角脚叫教阶节界紧近经精警静究局举具据卷决绝军均键级截夹即剪兼",
  k: "可开看快空控口库客卡靠科壳课肯孔扣苦块宽况扩跨",
  l: "了里理力立联连流量路录列类来蓝览浪老乐冷离李历利例链良两亮临灵零领令留六龙楼漏旅率绿轮论落逻拉",
  m: "面码名明目密慢模某马埋买卖满忙毛么没美门们迷米免描秒民敏命摸默母",
  n: "你能内年女那南难脑呢念鸟您宁牛农弄努哪",
  o: "哦",
  p: "配平品批排盘判跑陪朋皮片票频评凭破普抛匹",
  q: "前起去全清请切区器权群其奇齐企启气弃汽千迁签强墙抢桥巧亲轻情穷求取缺确期嵌且",
  r: "人日如让认任热然容软若弱入仍",
  s: "数时上是生事设手收删速算所随素搜死四送松宋苏俗虽岁孙损缩锁署顺首识说色示索式属射受使",
  t: "他她它天通同头提体条特台太态谈弹探堂逃讨套题跳贴铁听停统投透图土推退吞托拖替填",
  w: "我为文无问完网位外万王往忘危微围维伟未稳握五午武务物误尾",
  x: "下小新想系信行修选许需序学西吸希息习喜细先显现线相香向项消效些写谢心辛星形性续宣寻询迅限析循响",
  y: "用一有要于与已也应压样页业移义引因银英影硬永优由邮游又余语域预元原员源远愿约月越云允运音映",
  z: "在做自字子最中主装状转注直知之支值只制质治致置终种周逐住抓专追准资总走租足阻组左作坐志真整展占再"
};
function buildIndex() {
  const charToInitial = /* @__PURE__ */ new Map();
  const conflicts = [];
  for (const [initial, chars] of Object.entries(PINYIN_TABLE)) {
    for (const char of chars) {
      const existing = charToInitial.get(char);
      if (existing === void 0) {
        charToInitial.set(char, initial);
      } else if (existing !== initial) {
        conflicts.push({ char, first: existing, ignored: initial });
      }
    }
  }
  return { charToInitial, conflicts };
}
const INDEX = buildIndex();
function initialOf(char) {
  return INDEX.charToInitial.get(char);
}
function isCjk(ch) {
  const code = ch.codePointAt(0) ?? 0;
  return code >= 13312 && code <= 40959;
}
function pinyinInitials(text) {
  let out = "";
  for (const ch of text) {
    const mapped = initialOf(ch);
    if (mapped !== void 0) {
      out += mapped;
      continue;
    }
    if (isCjk(ch)) continue;
    if (/[A-Za-z0-9]/.test(ch)) {
      out += ch.toLowerCase();
    }
  }
  return out;
}
function initialSegments(text) {
  const parts = text.split(/[^A-Za-z0-9\u3400-\u9fff]+/).filter((p) => p !== "");
  const segments = [];
  for (const part of parts) {
    const initials = pinyinInitials(part);
    if (initials !== "") segments.push(initials);
  }
  return segments;
}
function matchesPinyin(text, query) {
  const q = query.trim().toLowerCase();
  if (q === "") return true;
  const whole = pinyinInitials(text);
  if (whole.startsWith(q)) return true;
  return initialSegments(text).some((seg) => seg.startsWith(q));
}
function matchesPinyinSubsequence(text, query) {
  const q = query.trim().toLowerCase();
  if (q === "") return true;
  const whole = pinyinInitials(text);
  let i = 0;
  for (const ch of whole) {
    if (ch === q[i]) i++;
    if (i === q.length) return true;
  }
  return false;
}
function matchItem(item, query) {
  const q = query.trim().toLowerCase();
  if (q === "") return "exact";
  const name = item.name.toLowerCase();
  if (name.includes(q)) return "exact";
  if ((item.note ?? "").toLowerCase().includes(q)) return "fuzzy";
  if (matchesPinyin(item.name, query)) return "pinyin";
  if (matchesPinyinSubsequence(item.name, query)) return "fuzzy";
  return "none";
}
const KIND_RANK = { exact: 0, pinyin: 1, fuzzy: 2, none: 3 };
function searchItems(items, query) {
  const q = query.trim();
  if (q === "") return [...items];
  const scored = items.map((item) => ({ item, kind: matchItem(item, q) })).filter((entry) => entry.kind !== "none");
  scored.sort((a, b) => {
    const byKind = KIND_RANK[a.kind] - KIND_RANK[b.kind];
    if (byKind !== 0) return byKind;
    return a.item.name.localeCompare(b.item.name, "zh-Hans-CN");
  });
  return scored.map((entry) => entry.item);
}
class MemoryQuickCmdStore {
  constructor() {
    this.kind = "local";
    this.commands = /* @__PURE__ */ new Map();
    this.groups = /* @__PURE__ */ new Map();
    this.history = {};
  }
  maybeFail() {
    if (this.failNextWrite) {
      const err = this.failNextWrite;
      this.failNextWrite = void 0;
      throw err;
    }
  }
  loadLibrary() {
    return {
      commands: [...this.commands.values()].map((c) => ({ ...c })),
      groups: [...this.groups.values()].map((g) => ({ ...g }))
    };
  }
  saveCommand(command) {
    this.maybeFail();
    this.commands.set(command.id, { ...command });
  }
  deleteCommand(id) {
    this.maybeFail();
    this.commands.delete(id);
  }
  saveGroup(group) {
    this.maybeFail();
    this.groups.set(group.id, { ...group });
  }
  deleteGroup(id) {
    this.maybeFail();
    this.groups.delete(id);
  }
  loadHistory() {
    return structuredClone(this.history);
  }
  saveHistory(data) {
    this.maybeFail();
    this.history = structuredClone(data);
  }
}
function sortKey(name) {
  return `${pinyinInitials(name)}\0${name}`.toLowerCase();
}
function byOrderThenName(a, b) {
  if (a.order !== b.order) return a.order - b.order;
  const ka = sortKey(a.name);
  const kb = sortKey(b.name);
  if (ka !== kb) return ka < kb ? -1 : 1;
  return 0;
}
function buildTree(library) {
  const groupIds = new Set(library.groups.map((g) => g.id));
  const nodeById = /* @__PURE__ */ new Map();
  const roots = [];
  for (const group of library.groups) {
    nodeById.set(group.id, {
      kind: "group",
      id: group.id,
      name: group.name,
      order: group.order,
      parentId: group.parentId,
      children: [],
      commandCount: 0
    });
  }
  for (const node of nodeById.values()) {
    const parentId = node.parentId;
    if (parentId === null || !groupIds.has(parentId)) {
      roots.push(node);
      node.parentId = parentId === null ? null : null;
      continue;
    }
    nodeById.get(parentId)?.children.push(node);
  }
  for (const command of library.commands) {
    const node = {
      kind: "command",
      id: command.id,
      name: command.name,
      command: command.command,
      ...command.note === void 0 ? {} : { note: command.note },
      order: command.order,
      groupId: command.groupId
    };
    const parent = command.groupId === null ? void 0 : nodeById.get(command.groupId);
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  const sortRecursive = (node) => {
    node.children.sort(byOrderThenName);
    let count = 0;
    for (const child of node.children) {
      if (child.kind === "group") count += sortRecursive(child);
      else count += 1;
    }
    node.commandCount = count;
    return count;
  };
  for (const node of roots) if (node.kind === "group") sortRecursive(node);
  roots.sort(byOrderThenName);
  return { roots, totalCommands: library.commands.length, totalGroups: library.groups.length };
}
function descendantGroupIds(groups, groupId) {
  const result = [];
  const stack = [groupId];
  const childrenOf = /* @__PURE__ */ new Map();
  for (const g of groups) {
    const key = g.parentId;
    if (!childrenOf.has(key)) childrenOf.set(key, []);
    childrenOf.get(key)?.push(g.id);
  }
  const seen = /* @__PURE__ */ new Set();
  while (stack.length > 0) {
    const id = stack.pop();
    if (id === void 0 || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
    for (const child of childrenOf.get(id) ?? []) stack.push(child);
  }
  return result;
}
function isAncestor(groups, ancestorId, nodeId) {
  let current = nodeId;
  const byId = new Map(groups.map((g) => [g.id, g]));
  const guard = /* @__PURE__ */ new Set();
  while (current !== null) {
    if (guard.has(current)) return false;
    guard.add(current);
    const node = byId.get(current);
    if (!node) return false;
    if (node.parentId === ancestorId) return true;
    current = node.parentId;
  }
  return false;
}
function cascadeDeleteGroup(library, groupId) {
  if (!library.groups.some((g) => g.id === groupId)) {
    throw AppError.notFound(`分组不存在: ${groupId}`);
  }
  const doomedGroups = new Set(descendantGroupIds(library.groups, groupId));
  const removedCommandIds = library.commands.filter((c) => c.groupId !== null && doomedGroups.has(c.groupId)).map((c) => c.id);
  return {
    library: {
      groups: library.groups.filter((g) => !doomedGroups.has(g.id)),
      commands: library.commands.filter((c) => !removedCommandIds.includes(c.id))
    },
    removedGroupIds: [...doomedGroups],
    removedCommandIds
  };
}
function normalizeOrders(items, orderedIds) {
  const rank = new Map(orderedIds.map((id, index) => [id, index]));
  return items.map((item) => {
    const next = rank.get(item.id);
    return next === void 0 ? item : { ...item, order: next };
  });
}
function reorderSiblings(library, parentId, orderedIds) {
  const groups = library.groups.filter((g) => g.parentId === parentId);
  const commands = library.commands.filter((c) => c.groupId === parentId);
  const known = /* @__PURE__ */ new Set([...groups.map((g) => g.id), ...commands.map((c) => c.id)]);
  for (const id of orderedIds) {
    if (!known.has(id)) {
      throw AppError.badRequest(`节点 ${id} 不在该分组下，无法排序`);
    }
  }
  return {
    groups: normalizeOrders(library.groups, orderedIds),
    commands: normalizeOrders(library.commands, orderedIds)
  };
}
function moveCommand(library, commandId, targetGroupId, index) {
  const command = library.commands.find((c) => c.id === commandId);
  if (!command) throw AppError.notFound(`命令不存在: ${commandId}`);
  if (targetGroupId !== null && !library.groups.some((g) => g.id === targetGroupId)) {
    throw AppError.notFound(`分组不存在: ${targetGroupId}`);
  }
  const siblings = library.commands.filter((c) => c.groupId === targetGroupId && c.id !== commandId).sort(byOrderThenName).map((c) => c.id);
  const at = index === void 0 ? siblings.length : Math.min(Math.max(index, 0), siblings.length);
  siblings.splice(at, 0, commandId);
  const commands = library.commands.map((c) => c.id === commandId ? { ...c, groupId: targetGroupId } : c);
  return { groups: library.groups, commands: normalizeOrders(commands, siblings) };
}
function moveGroup(library, groupId, newParentId, index) {
  const group = library.groups.find((g) => g.id === groupId);
  if (!group) throw AppError.notFound(`分组不存在: ${groupId}`);
  if (newParentId !== null && !library.groups.some((g) => g.id === newParentId)) {
    throw AppError.notFound(`分组不存在: ${newParentId}`);
  }
  if (newParentId === groupId) {
    throw AppError.badRequest("不能把分组移动到自身之下");
  }
  if (newParentId !== null && isAncestor(library.groups, groupId, newParentId)) {
    throw AppError.badRequest("不能把分组移动到它的子分组之下（会形成环）");
  }
  const siblings = library.groups.filter((g) => g.parentId === newParentId && g.id !== groupId).sort(byOrderThenName).map((g) => g.id);
  const at = index === void 0 ? siblings.length : Math.min(Math.max(index, 0), siblings.length);
  siblings.splice(at, 0, groupId);
  const groups = library.groups.map((g) => g.id === groupId ? { ...g, parentId: newParentId } : g);
  return { groups: normalizeOrders(groups, siblings), commands: library.commands };
}
function nextOrder(library, parentId) {
  const orders = [
    ...library.groups.filter((g) => g.parentId === parentId).map((g) => g.order),
    ...library.commands.filter((c) => c.groupId === parentId).map((c) => c.order)
  ];
  return orders.length === 0 ? 0 : Math.max(...orders) + 1;
}
function cascadePreview(library, groupId) {
  const doomed = new Set(descendantGroupIds(library.groups, groupId));
  return {
    groups: doomed.size,
    commands: library.commands.filter((c) => c.groupId !== null && doomed.has(c.groupId)).length
  };
}
const VALID_NAME = /^[A-Za-z0-9_\u3400-\u9fff]+$/;
const OPEN = "${{";
const CLOSE = "}}";
function parseTemplate(command) {
  const tokens = [];
  let hasUnclosed = false;
  let cursor = 0;
  while (cursor < command.length) {
    const open = command.indexOf(OPEN, cursor);
    if (open === -1) break;
    const close = command.indexOf(CLOSE, open + OPEN.length);
    if (close === -1) {
      hasUnclosed = true;
      break;
    }
    const body = command.slice(open + OPEN.length, close);
    const colon = body.indexOf(":");
    const rawName = colon === -1 ? body : body.slice(0, colon);
    const rawFormat = colon === -1 ? void 0 : body.slice(colon + 1);
    const name = rawName.trim();
    const format = rawFormat?.trim();
    if (name === "" || !VALID_NAME.test(name)) {
      cursor = close + CLOSE.length;
      continue;
    }
    const kind = isDynamicVariable(name) ? "variable" : "parameter";
    const token = {
      kind,
      name,
      ...kind === "variable" && format !== void 0 && format !== "" ? { format } : {},
      raw: command.slice(open, close + CLOSE.length),
      start: open,
      end: close + CLOSE.length
    };
    tokens.push(token);
    cursor = close + CLOSE.length;
  }
  const variables = tokens.filter((t) => t.kind === "variable");
  const parameters = tokens.filter((t) => t.kind === "parameter");
  const parameterNames = [];
  for (const token of parameters) {
    if (!parameterNames.includes(token.name)) parameterNames.push(token.name);
  }
  return { tokens, variables, parameters, parameterNames, hasUnclosed };
}
function renderTemplate(command, values = {}) {
  const parsed = parseTemplate(command);
  const params = values.params ?? {};
  const context = values.context ?? {};
  const missing = [];
  let out = "";
  let last = 0;
  for (const token of parsed.tokens) {
    out += command.slice(last, token.start);
    if (token.kind === "variable") {
      out += evaluateVariable(token.name, token.format, context);
    } else {
      const value = params[token.name];
      if (value === void 0) {
        out += token.raw;
        if (!missing.includes(token.name)) missing.push(token.name);
      } else {
        out += value;
      }
    }
    last = token.end;
  }
  out += command.slice(last);
  return { text: out, missingParams: missing };
}
function splitLines(command) {
  return command.split(/\r?\n/).map((line) => line.replace(/\r$/, "").trim()).filter((line) => line !== "");
}
function renderLines(command, values = {}) {
  const rendered = renderTemplate(command, values);
  return { lines: splitLines(rendered.text), missingParams: rendered.missingParams };
}
function templateTags(parsed) {
  const tags = [];
  for (const token of parsed.tokens) {
    const existing = tags.find((t) => t.name === token.name && t.kind === token.kind);
    if (existing) {
      existing.count++;
      continue;
    }
    tags.push({
      name: token.name,
      kind: token.kind,
      ...token.format === void 0 ? {} : { format: token.format },
      count: 1
    });
  }
  return tags;
}
let deps = { store: new MemoryQuickCmdStore() };
let service = null;
function getQuickCmdService() {
  if (!service) service = new QuickCmdService(deps);
  return service;
}
async function defaultSendToSession(sessionId, data) {
  const target = getWritable(sessionId);
  if (!target) {
    throw AppError.notConnected(
      "该会话当前不可写入（未连接、已断开，或不支持输入）—— 请先连接终端再执行快速命令"
    );
  }
  if (!target.canWrite()) {
    throw AppError.notConnected(`会话「${target.title}」当前不可写入，请检查连接状态`);
  }
  target.write(data);
}
class QuickCmdService {
  constructor(options) {
    this.library = null;
    this.options = options;
    this.store = options.store;
    this.now = options.now ?? (() => Date.now());
    this.idFactory = options.idFactory ?? (() => randomUUID());
    this.history = new ParamHistory({ ...options.historyOptions ?? {}, now: this.now });
  }
  get storeKind() {
    return this.store.kind;
  }
  /** 载入库与历史（幂等；`reload()` 可强制刷新） */
  ensureLoaded() {
    if (this.library) return this.library;
    this.library = this.store.loadLibrary();
    this.history.load(this.store.loadHistory());
    return this.library;
  }
  async reload() {
    this.library = null;
    this.ensureLoaded();
  }
  timestamp() {
    return new Date(this.now()).toISOString();
  }
  // -------------------------------------------------------------------------
  // 读
  // -------------------------------------------------------------------------
  list() {
    const lib = this.ensureLoaded();
    return { commands: [...lib.commands], groups: [...lib.groups], tree: buildTree(lib) };
  }
  tree() {
    return buildTree(this.ensureLoaded());
  }
  listGroups() {
    return [...this.ensureLoaded().groups];
  }
  getCommand(id) {
    return this.ensureLoaded().commands.find((c) => c.id === id);
  }
  /** 分组路径面包屑（搜索结果展示 "数据库 / MySQL / 备份" 用） */
  groupPathOf(groupId) {
    const lib = this.ensureLoaded();
    const byId = new Map(lib.groups.map((g) => [g.id, g]));
    const path = [];
    let current = groupId === null ? null : byId.get(groupId) ?? null;
    const guard = /* @__PURE__ */ new Set();
    while (current && !guard.has(current.id)) {
      guard.add(current.id);
      path.unshift(current.name);
      current = current.parentId === null ? null : byId.get(current.parentId) ?? null;
    }
    return path;
  }
  /** 搜索：名称精确子串 > 拼音首字母 > 备注；空查询返回全部（按树序） */
  search(query) {
    const lib = this.ensureLoaded();
    const items = lib.commands.map((c) => ({ ...c }));
    const matched = searchItems(items, query);
    return matched.map((c) => ({ ...c, groupPath: this.groupPathOf(c.groupId) }));
  }
  /** 变量辅助面板：所有内置变量的说明/格式/**当前值预览** */
  variablePanel() {
    return listVariablePreviews(this.variableContext());
  }
  // -------------------------------------------------------------------------
  // 命令 CRUD
  // -------------------------------------------------------------------------
  saveCommand(input) {
    const lib = this.ensureLoaded();
    const name = input.name?.trim() ?? "";
    const command = input.command ?? "";
    if (name === "") throw AppError.badRequest("命令名称不能为空");
    if (command.trim() === "") throw AppError.badRequest("命令内容不能为空");
    const groupId = input.groupId ?? null;
    if (groupId !== null && !lib.groups.some((g) => g.id === groupId)) {
      throw AppError.notFound(`分组不存在: ${groupId}`);
    }
    const existing = input.id === void 0 ? void 0 : lib.commands.find((c) => c.id === input.id);
    const record = existing ? {
      ...existing,
      name,
      command,
      groupId,
      ...input.note === void 0 ? {} : { note: input.note },
      updatedAt: this.timestamp()
    } : {
      id: input.id ?? this.idFactory(),
      groupId,
      name,
      command,
      ...input.note === void 0 ? {} : { note: input.note },
      order: nextOrder(lib, groupId),
      createdAt: this.timestamp(),
      updatedAt: this.timestamp()
    };
    lib.commands = existing ? lib.commands.map((c) => c.id === record.id ? record : c) : [...lib.commands, record];
    this.store.saveCommand(record);
    return record;
  }
  /** 删除命令（支持多选删除，spec §6.2） */
  deleteCommands(ids) {
    const lib = this.ensureLoaded();
    const wanted = new Set(ids);
    const existing = lib.commands.filter((c) => wanted.has(c.id));
    lib.commands = lib.commands.filter((c) => !wanted.has(c.id));
    for (const command of existing) this.store.deleteCommand(command.id);
    return { deleted: existing.length };
  }
  /** 移动命令到目标分组（可指定落点） */
  moveCommand(commandId, targetGroupId, index) {
    const lib = this.ensureLoaded();
    const before = new Map(lib.commands.map((c) => [c.id, c.groupId]));
    const next = moveCommand(lib, commandId, targetGroupId, index);
    lib.commands = next.commands;
    const changed = lib.commands.filter((c) => c.groupId === targetGroupId || before.get(c.id) === targetGroupId);
    this.saveCommands(changed);
  }
  // -------------------------------------------------------------------------
  // 分组 CRUD
  // -------------------------------------------------------------------------
  saveGroup(input) {
    const lib = this.ensureLoaded();
    const name = input.name?.trim() ?? "";
    if (name === "") throw AppError.badRequest("分组名称不能为空");
    const parentId = input.parentId ?? null;
    if (parentId !== null && !lib.groups.some((g) => g.id === parentId)) {
      throw AppError.notFound(`父分组不存在: ${parentId}`);
    }
    const existing = input.id === void 0 ? void 0 : lib.groups.find((g) => g.id === input.id);
    if (existing && parentId !== null && (parentId === existing.id || this.isDescendant(existing.id, parentId))) {
      throw AppError.badRequest("不能把分组移动到它的子分组之下（会形成环）");
    }
    const record = existing ? { ...existing, name, parentId, updatedAt: this.timestamp() } : {
      id: input.id ?? this.idFactory(),
      parentId,
      name,
      order: nextOrder(lib, parentId),
      createdAt: this.timestamp(),
      updatedAt: this.timestamp()
    };
    lib.groups = existing ? lib.groups.map((g) => g.id === record.id ? record : g) : [...lib.groups, record];
    this.store.saveGroup(record);
    return record;
  }
  isDescendant(ancestorId, nodeId) {
    const lib = this.ensureLoaded();
    const byId = new Map(lib.groups.map((g) => [g.id, g]));
    let current = byId.get(nodeId)?.parentId ?? null;
    const guard = /* @__PURE__ */ new Set();
    while (current !== null && !guard.has(current)) {
      if (current === ancestorId) return true;
      guard.add(current);
      current = byId.get(current)?.parentId ?? null;
    }
    return false;
  }
  /** 删除分组前的提示：将删除多少分组/命令（UI 二次确认） */
  previewGroupDelete(groupId) {
    return cascadePreview(this.ensureLoaded(), groupId);
  }
  /** 删除分组 → 级联删除子分组与组内命令 */
  deleteGroup(groupId) {
    const lib = this.ensureLoaded();
    const result = cascadeDeleteGroup(lib, groupId);
    lib.groups = result.library.groups;
    lib.commands = result.library.commands;
    for (const id of result.removedCommandIds) this.store.deleteCommand(id);
    for (const id of result.removedGroupIds) this.store.deleteGroup(id);
    return { removedGroups: result.removedGroupIds.length, removedCommands: result.removedCommandIds.length };
  }
  moveGroup(groupId, newParentId, index) {
    const lib = this.ensureLoaded();
    const next = moveGroup(lib, groupId, newParentId, index);
    lib.groups = next.groups;
    this.saveGroups(lib.groups.filter((g) => g.parentId === newParentId || g.id === groupId));
  }
  /** 拖拽排序持久化：同级按给定顺序重排 */
  reorder(parentId, orderedIds) {
    const lib = this.ensureLoaded();
    const next = reorderSiblings(lib, parentId, orderedIds);
    lib.groups = next.groups;
    lib.commands = next.commands;
    this.saveGroups(lib.groups.filter((g) => g.parentId === parentId));
    this.saveCommands(lib.commands.filter((c) => c.groupId === parentId));
  }
  // -------------------------------------------------------------------------
  // 渲染 / 执行 / 粘贴
  // -------------------------------------------------------------------------
  /** 解析 + 渲染（不执行）：PREVIEW 区域与参数标签用 */
  render(input) {
    const command = this.resolveCommandText(input);
    const parsed = parseTemplate(command);
    const context = this.variableContext();
    const rendered = renderTemplate(command, {
      context,
      params: input.params ?? {}
    });
    return {
      text: rendered.text,
      lines: splitLines(rendered.text),
      missingParams: rendered.missingParams,
      // 预览要按**这个占位符实际用的格式**求值（${{date:YYYYMMDD}} 就显示 20251129）
      variables: parsed.variables.map((token) => {
        const def = getVariableDef(token.name);
        if (def) return variablePreview(def, context, token.format);
        return {
          name: token.name,
          description: token.name,
          format: token.format ?? "-",
          value: "",
          masked: false,
          hasValue: false,
          secret: false
        };
      }),
      tags: templateTags(parsed),
      hasUnclosed: parsed.hasUnclosed
    };
  }
  /** 参数填写窗口的数据：历史回填 + 最近值提示 + 变量预览 + 当前渲染 */
  parameterDialog(input) {
    const command = this.resolveCommandText(input);
    const parsed = parseTemplate(command);
    const names = parsed.parameterNames;
    const recent = {};
    for (const name of names) recent[name] = this.history.recent(name, 5);
    return {
      parameters: names,
      prefill: this.history.prefill(names),
      recent,
      variables: this.variablePanel(),
      tags: templateTags(parsed),
      preview: renderTemplate(command, { context: this.variableContext() }).text,
      missingParams: names
    };
  }
  /**
   * 执行：渲染 → 记录参数历史 → **逐行发送**到会话。
   * 缺参数直接拒绝（不允许把 `${{x}}` 原样打到终端上）。
   */
  async execute(input) {
    const command = this.resolveCommandText(input);
    const params = input.params ?? {};
    const rendered = renderLines(command, { context: this.variableContext(), params });
    if (rendered.missingParams.length > 0) {
      throw AppError.badRequest(`还有参数未填写: ${rendered.missingParams.join("、")}`);
    }
    if (rendered.lines.length === 0) throw AppError.badRequest("命令为空，没有可执行的内容");
    this.history.recordAll(params);
    this.store.saveHistory(this.history.all());
    const sender = this.options.sendToSession ?? defaultSendToSession;
    for (const line of rendered.lines) {
      await sender(input.sessionId, `${line}
`);
    }
    return { lines: rendered.lines, missingParams: [] };
  }
  /** 粘贴：只渲染，不发送（渲染层贴到终端或输入框） */
  paste(input) {
    const command = this.resolveCommandText(input);
    const params = input.params ?? {};
    const rendered = renderTemplate(command, { context: this.variableContext(), params });
    return { lines: splitLines(rendered.text), text: rendered.text, missingParams: rendered.missingParams };
  }
  /** 编辑器实时提示：识别到的参数标签（绿=变量/蓝=参数） */
  analyze(command) {
    const parsed = parseTemplate(command);
    return { tags: templateTags(parsed), parameterNames: parsed.parameterNames, hasUnclosed: parsed.hasUnclosed };
  }
  // -------------------------------------------------------------------------
  // 历史
  // -------------------------------------------------------------------------
  historyAll() {
    this.ensureLoaded();
    return this.history.all();
  }
  historyFor(name, limit) {
    this.ensureLoaded();
    return this.history.recent(name, limit);
  }
  clearHistory(name) {
    this.ensureLoaded();
    this.history.clear(name);
    this.store.saveHistory(this.history.all());
  }
  // -------------------------------------------------------------------------
  // 内部
  // -------------------------------------------------------------------------
  /** 动态变量上下文（实例级注入；未注入则用空上下文） */
  variableContext() {
    return this.options.variableContext?.() ?? {};
  }
  resolveCommandText(input) {
    if (input.command !== void 0) return input.command;
    if (input.commandId !== void 0) {
      const record = this.getCommand(input.commandId);
      if (!record) throw AppError.notFound(`命令不存在: ${input.commandId}`);
      return record.command;
    }
    throw AppError.badRequest("需要 commandId 或 command 之一");
  }
  saveCommands(commands) {
    for (const command of commands) this.store.saveCommand(command);
  }
  saveGroups(groups) {
    for (const group of groups) this.store.saveGroup(group);
  }
}
const idString = z.string().min(1);
const paramMap = z.record(z.string(), z.string());
const saveCommandSchema = z.object({
  id: idString.optional(),
  groupId: z.union([idString, z.null()]).optional(),
  name: z.string().min(1, "命令名称不能为空"),
  command: z.string().min(1, "命令内容不能为空"),
  note: z.string().optional()
});
const deleteCommandsSchema = z.object({ ids: z.array(idString).min(1) });
const saveGroupSchema = z.object({
  id: idString.optional(),
  parentId: z.union([idString, z.null()]).optional(),
  name: z.string().min(1, "分组名称不能为空")
});
const groupIdSchema = z.object({ id: idString });
const moveSchema = z.object({
  kind: z.enum(["command", "group"]),
  id: idString,
  /** 命令用 groupId，分组用 parentId；null = 根/顶层 */
  targetId: z.union([idString, z.null()]),
  index: z.number().int().min(0).optional()
});
const reorderSchema = z.object({ parentId: z.union([idString, z.null()]), orderedIds: z.array(idString) });
const searchSchema = z.object({ query: z.string() });
const renderSchema = z.object({
  commandId: idString.optional(),
  command: z.string().optional(),
  params: paramMap.optional()
});
const dialogSchema = z.object({ commandId: idString.optional(), command: z.string().optional() });
const executeSchema = z.object({
  sessionId: idString,
  commandId: idString.optional(),
  command: z.string().optional(),
  params: paramMap.optional()
});
const historySchema = z.object({ name: idString.optional(), limit: z.number().int().min(1).max(50).optional() });
const quickcmdHandlers = {
  list: () => getQuickCmdService().list(),
  listGroups: () => getQuickCmdService().listGroups(),
  save: (payload) => getQuickCmdService().saveCommand(parseInput(saveCommandSchema, payload)),
  delete: (payload) => {
    const { ids } = parseInput(deleteCommandsSchema, payload);
    return getQuickCmdService().deleteCommands(ids);
  },
  move: (payload) => {
    const { kind, id, targetId, index } = parseInput(moveSchema, payload);
    const svc = getQuickCmdService();
    if (kind === "command") svc.moveCommand(id, targetId, index);
    else svc.moveGroup(id, targetId, index);
    return { moved: true };
  },
  reorder: (payload) => {
    const { parentId, orderedIds } = parseInput(reorderSchema, payload);
    getQuickCmdService().reorder(parentId, orderedIds);
    return { reordered: orderedIds.length };
  },
  saveGroup: (payload) => getQuickCmdService().saveGroup(parseInput(saveGroupSchema, payload)),
  deleteGroup: (payload) => {
    const { id } = parseInput(groupIdSchema, payload);
    return getQuickCmdService().deleteGroup(id);
  },
  previewGroupDelete: (payload) => {
    const { id } = parseInput(groupIdSchema, payload);
    return getQuickCmdService().previewGroupDelete(id);
  },
  search: (payload) => {
    const { query } = parseInput(searchSchema, payload);
    return getQuickCmdService().search(query);
  },
  render: (payload) => getQuickCmdService().render(parseInput(renderSchema, payload)),
  parameterDialog: (payload) => getQuickCmdService().parameterDialog(parseInput(dialogSchema, payload)),
  execute: (payload) => getQuickCmdService().execute(parseInput(executeSchema, payload)),
  paste: (payload) => getQuickCmdService().paste(parseInput(renderSchema, payload)),
  analyze: (payload) => {
    const { command } = parseInput(z.object({ command: z.string() }), payload);
    return getQuickCmdService().analyze(command);
  },
  /** 变量辅助面板（含当前值预览） */
  variables: () => getQuickCmdService().variablePanel(),
  /** 历史（回填数据源） */
  history: (payload) => {
    const { name, limit } = parseInput(historySchema, payload ?? {});
    const svc = getQuickCmdService();
    return name === void 0 ? svc.historyAll() : { name, values: svc.historyFor(name, limit) };
  },
  clearHistory: (payload) => {
    const { name } = parseInput(historySchema, payload ?? {});
    getQuickCmdService().clearHistory(name);
    return { cleared: name ?? "all" };
  },
  /** 存储类型（本地库 / 将来的云端库） */
  storage: () => ({ kind: getQuickCmdService().storeKind })
};
export {
  MemoryQuickCmdStore,
  QuickCmdService,
  getQuickCmdService,
  isDynamicVariable,
  matchItem,
  matchesPinyin,
  quickcmdHandlers
};
