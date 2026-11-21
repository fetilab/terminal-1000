import { r as reactExports, i as invoke, e as errorText, t as toast, j as jsxRuntimeExports, M as Modal, f as Banner, h as Button, L as Loading, I as Icon, B as Badge, U as subscribe, a0 as Events, al as formatBytes, n as IconButton, F as Field, T as TextInput, C as Checkbox, J as EmptyState, ak as formatDate, u as useStoreShallow, a as actions } from "./index-CwfghMy4.js";
import { C as CodeEditor } from "./CodeEditor-_oooyGAs.js";
import { C as ContextMenu } from "./TerminalWorkspace-CI71ZCOG.js";
import { V as VirtualList } from "./VirtualList-CIIV3xPp.js";
/* empty css               */
import "./highlights-DAa5Pc3k.js";
/* empty css                  */
const BY_FILENAME = {
  dockerfile: "dockerfile",
  containerfile: "dockerfile",
  makefile: "makefile",
  gnumakefile: "makefile",
  "cmakelists.txt": "plaintext",
  ".bashrc": "shell",
  ".bash_profile": "shell",
  ".profile": "shell",
  ".zshrc": "shell",
  ".env": "ini",
  "nginx.conf": "ini",
  "httpd.conf": "ini",
  "my.cnf": "ini",
  ".gitignore": "plaintext",
  "crontab": "shell"
};
const BY_PREFIX = [
  ["dockerfile", "dockerfile"],
  ["makefile", "makefile"],
  ["cmakelists", "plaintext"]
];
const BY_EXT = {
  // shell 与脚本
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  ksh: "shell",
  fish: "shell",
  bat: "bat",
  cmd: "bat",
  ps1: "powershell",
  psm1: "powershell",
  // 语言
  py: "python",
  pyw: "python",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "javascript",
  ts: "typescript",
  tsx: "typescript",
  java: "java",
  go: "go",
  rs: "rust",
  c: "cpp",
  h: "cpp",
  hpp: "cpp",
  cc: "cpp",
  cpp: "cpp",
  cxx: "cpp",
  cs: "csharp",
  php: "php",
  rb: "ruby",
  lua: "lua",
  pl: "perl",
  pm: "perl",
  r: "r",
  dart: "dart",
  kt: "kotlin",
  swift: "swift",
  scala: "scala",
  clj: "clojure",
  fs: "fsharp",
  jl: "julia",
  pas: "pascal",
  // 配置与数据
  json: "javascript",
  // 见文件尾说明：用 JS 的 tokenizer 覆盖 JSON 的着色
  jsonc: "javascript",
  yaml: "yaml",
  yml: "yaml",
  ini: "ini",
  conf: "ini",
  cfg: "ini",
  cnf: "ini",
  properties: "ini",
  env: "ini",
  service: "ini",
  toml: "ini",
  // 标记与文档
  md: "markdown",
  markdown: "markdown",
  // 前端
  xml: "xml",
  html: "html",
  htm: "html",
  css: "css",
  scss: "scss",
  less: "less",
  vue: "html",
  // 查询与协议
  sql: "sql",
  graphql: "graphql",
  gql: "graphql",
  hcl: "hcl",
  tf: "hcl",
  proto: "plaintext",
  log: "plaintext",
  txt: "plaintext",
  csv: "plaintext"
};
function languageForFile(filename) {
  const base = (filename.split("/").pop() ?? filename).trim();
  if (!base) return "plaintext";
  const lower = base.toLowerCase();
  const exact = BY_FILENAME[lower];
  if (exact) return exact;
  for (const [prefix, lang] of BY_PREFIX) {
    if (lower.startsWith(prefix)) return lang;
  }
  const dot = lower.lastIndexOf(".");
  if (dot < 0) return "plaintext";
  const ext = lower.slice(dot + 1);
  return BY_EXT[ext] ?? "plaintext";
}
const LANGUAGE_LABEL = {
  shell: "Shell",
  python: "Python",
  javascript: "JavaScript（含 JSON）",
  typescript: "TypeScript",
  yaml: "YAML",
  ini: "INI / 配置",
  markdown: "Markdown",
  dockerfile: "Dockerfile",
  makefile: "Makefile",
  xml: "XML",
  css: "CSS",
  scss: "SCSS",
  less: "Less",
  html: "HTML",
  sql: "SQL",
  cpp: "C / C++",
  csharp: "C#",
  go: "Go",
  rust: "Rust",
  java: "Java",
  lua: "Lua",
  powershell: "PowerShell",
  bat: "批处理",
  php: "PHP",
  ruby: "Ruby",
  perl: "Perl",
  r: "R",
  dart: "Dart",
  kotlin: "Kotlin",
  swift: "Swift",
  scala: "Scala",
  clojure: "Clojure",
  fsharp: "F#",
  julia: "Julia",
  pascal: "Pascal",
  graphql: "GraphQL",
  hcl: "HCL / Terraform",
  plaintext: "纯文本"
};
function RemoteEditor({ sessionId, path, onClose, onSaved }) {
  const [content, setContent] = reactExports.useState("");
  const [original, setOriginal] = reactExports.useState("");
  const [mtimeAtOpen, setMtimeAtOpen] = reactExports.useState(null);
  const [state, setState] = reactExports.useState("loading");
  const [error, setError] = reactExports.useState(null);
  const [saving, setSaving] = reactExports.useState(false);
  const [conflict, setConflict] = reactExports.useState(null);
  const filename = path.split("/").pop() ?? path;
  const language = languageForFile(filename);
  reactExports.useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await invoke(
          "sftp",
          "readFile",
          { sessionId, path }
        );
        if (cancelled) return;
        setContent(res.content);
        setOriginal(res.content);
        setMtimeAtOpen(res.mtime);
        setState("ready");
        if (res.truncated) {
          setError("文件太大，只读取了一部分 —— 直接保存会把远端截断，请改用系统编辑器或下载后再编辑。");
        }
      } catch (err) {
        if (!cancelled) {
          setError(errorText(err));
          setState("failed");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId, path]);
  const dirty = content !== original;
  const doSave = reactExports.useCallback(async () => {
    setSaving(true);
    try {
      const res = await invoke(
        "sftp",
        "writeFile",
        { sessionId, path, content }
      );
      setOriginal(content);
      toast.ok(`已保存到远端：${path}（${res?.bytes ?? content.length} 字节）`);
      onSaved?.();
    } catch (err) {
      toast.error(`保存到远端失败：${errorText(err)}`);
      setError(`保存失败：${errorText(err)}`);
    } finally {
      setSaving(false);
    }
  }, [sessionId, path, content, onSaved]);
  const save = reactExports.useCallback(async () => {
    if (!dirty) {
      toast.info("内容没有变化");
      return;
    }
    setConflict(null);
    try {
      const st = await invoke("sftp", "stat", {
        sessionId,
        path
      });
      if (mtimeAtOpen !== null && st.mtime !== mtimeAtOpen) {
        setConflict(
          "这个文件在你编辑期间被改过（远端 mtime 变了）。继续保存会**覆盖别人的修改**；建议先取消、重新打开确认差异。"
        );
        return;
      }
    } catch {
    }
    await doSave();
  }, [dirty, sessionId, path, mtimeAtOpen, doSave]);
  return /* @__PURE__ */ jsxRuntimeExports.jsxs(
    Modal,
    {
      open: true,
      size: "lg",
      title: `编辑 ${filename}`,
      subtitle: path,
      onClose,
      footer: /* @__PURE__ */ jsxRuntimeExports.jsxs(jsxRuntimeExports.Fragment, { children: [
        dirty ? /* @__PURE__ */ jsxRuntimeExports.jsx(Badge, { tone: "warn", children: "未保存" }) : /* @__PURE__ */ jsxRuntimeExports.jsx(Badge, { tone: "ok", children: "已同步" }),
        /* @__PURE__ */ jsxRuntimeExports.jsxs("span", { className: "form-footer-hint", children: [
          LANGUAGE_LABEL[language] ?? language,
          " · 保存写回远端"
        ] }),
        /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "t-modal__footer-spacer" }),
        /* @__PURE__ */ jsxRuntimeExports.jsx(Button, { variant: "ghost", onClick: onClose, children: "关闭" }),
        /* @__PURE__ */ jsxRuntimeExports.jsx(Button, { variant: "primary", loading: saving, disabled: !dirty || state !== "ready", onClick: () => void save(), children: "保存到远端" })
      ] }),
      children: [
        error ? /* @__PURE__ */ jsxRuntimeExports.jsx("div", { style: { marginBottom: 12 }, children: /* @__PURE__ */ jsxRuntimeExports.jsx(Banner, { tone: "error", children: error }) }) : null,
        conflict ? /* @__PURE__ */ jsxRuntimeExports.jsx("div", { style: { marginBottom: 12 }, children: /* @__PURE__ */ jsxRuntimeExports.jsx(
          Banner,
          {
            tone: "warn",
            actions: /* @__PURE__ */ jsxRuntimeExports.jsx(
              Button,
              {
                size: "sm",
                variant: "danger",
                onClick: () => {
                  setConflict(null);
                  void doSave();
                },
                children: "仍然覆盖"
              }
            ),
            children: conflict
          }
        ) }) : null,
        state === "loading" ? /* @__PURE__ */ jsxRuntimeExports.jsx(Loading, { text: "读取远端文件…" }) : /* @__PURE__ */ jsxRuntimeExports.jsx(
          CodeEditor,
          {
            value: content,
            language,
            height: 460,
            ariaLabel: `编辑 ${filename}`,
            onChange: setContent,
            onSave: () => void save(),
            statusLeft: /* @__PURE__ */ jsxRuntimeExports.jsxs(jsxRuntimeExports.Fragment, { children: [
              /* @__PURE__ */ jsxRuntimeExports.jsx(Icon, { name: "server", size: 12 }),
              " 远端 · ",
              path
            ] })
          }
        )
      ]
    }
  );
}
const KEY = "t1000.sftpBookmarks.v1";
function readAll() {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (b) => typeof b === "object" && b !== null && typeof b.id === "string" && typeof b.connectionId === "string" && typeof b.path === "string"
    );
  } catch {
    return [];
  }
}
function writeAll(list) {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
  }
}
function listBookmarks(connectionId) {
  if (!connectionId) return [];
  return readAll().filter((b) => b.connectionId === connectionId).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
function addBookmark(connectionId, path, name) {
  const all = readAll();
  const existing = all.find((b) => b.connectionId === connectionId && b.path === path);
  if (existing) return existing;
  const seg = path.split("/").filter(Boolean).pop();
  const item = {
    id: `bm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    connectionId,
    name: (name?.trim() || seg || path || "/").slice(0, 60),
    path: path || "/",
    createdAt: (/* @__PURE__ */ new Date()).toISOString()
  };
  writeAll([...all, item]);
  return item;
}
function removeBookmark(id) {
  writeAll(readAll().filter((b) => b.id !== id));
}
function renameBookmark(id, name) {
  writeAll(
    readAll().map((b) => b.id === id ? { ...b, name: name.trim().slice(0, 60) || b.name } : b)
  );
}
function Switch({
  checked,
  onChange,
  label,
  disabled = false,
  size = "md",
  id
}) {
  return /* @__PURE__ */ jsxRuntimeExports.jsx(
    "button",
    {
      type: "button",
      id,
      role: "switch",
      "aria-checked": checked,
      "aria-label": label,
      title: label,
      disabled,
      className: `t-toggle t-toggle--${size}${checked ? " t-toggle--on" : ""}`,
      onClick: () => onChange(!checked),
      children: /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "t-toggle__thumb", "aria-hidden": true })
    }
  );
}
function modeToOctal(mode) {
  return (mode & 511).toString(8).padStart(3, "0");
}
function octalToMode(text) {
  const trimmed = text.trim();
  if (!/^[0-7]{3,4}$/.test(trimmed)) return void 0;
  return Number.parseInt(trimmed, 8);
}
function joinRemote(dir, name) {
  if (dir === "/" || dir === "") return `/${name}`;
  return `${dir.replace(/\/+$/, "")}/${name}`;
}
function parentRemote(path) {
  const trimmed = path.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  if (idx <= 0) return "/";
  return trimmed.slice(0, idx);
}
function breadcrumbSegments(path) {
  const parts = path.split("/").filter(Boolean);
  const out = [{ label: "/", path: "/" }];
  let acc = "";
  for (const p of parts) {
    acc += `/${p}`;
    out.push({ label: p, path: acc });
  }
  return out;
}
function entryIconType(entry) {
  if (entry.type === "directory") return "folder";
  if (entry.type === "symlink") return "link";
  return "file";
}
let items = [];
const listeners = /* @__PURE__ */ new Set();
function emit() {
  for (const l of listeners) l();
}
function subscribeStore(listener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
function snapshot() {
  return items;
}
function upsert(id, patch) {
  const idx = items.findIndex((t) => t.transferId === id);
  if (idx === -1) {
    items = [patch, ...items].slice(0, 200);
  } else {
    const next = items.slice();
    next[idx] = { ...next[idx], ...patch };
    items = next;
  }
  emit();
}
const RETENTION_MS = 5 * 6e4;
function prune() {
  const now = Date.now();
  const next = items.filter(
    (t) => t.status === "running" || !t.finishedAt || now - t.finishedAt < RETENTION_MS
  );
  if (next.length !== items.length) {
    items = next;
    emit();
  }
}
function clearFinished() {
  items = items.filter((t) => t.status === "running");
  emit();
}
function useTransfers() {
  return reactExports.useSyncExternalStore(subscribeStore, snapshot, snapshot);
}
let wired = false;
function wireTransferEvents() {
  if (wired) return;
  wired = true;
  subscribe(Events.SFTP_TRANSFER_PROGRESS, (p) => {
    upsert(p.transferId, {
      transferId: p.transferId,
      sessionId: p.sessionId,
      direction: p.direction,
      file: p.file,
      transferredBytes: p.transferredBytes,
      totalBytes: p.totalBytes,
      ...p.filesDone === void 0 ? {} : { filesDone: p.filesDone },
      ...p.filesTotal === void 0 ? {} : { filesTotal: p.filesTotal },
      ...p.speed === void 0 ? {} : { speed: p.speed },
      status: "running"
    });
  });
  subscribe(Events.SFTP_DIR_SCANNED, (p) => {
    const target = items.find((t) => t.sessionId === p.sessionId && t.status === "running");
    if (!target) return;
    upsert(target.transferId, {
      transferId: target.transferId,
      scanning: { path: p.path, files: p.files, bytes: p.bytes }
    });
  });
  subscribe(Events.SFTP_TRANSFER_FINISHED, (p) => {
    upsert(p.transferId, {
      transferId: p.transferId,
      sessionId: p.sessionId,
      direction: p.direction,
      status: "finished",
      finishedAt: Date.now(),
      scanning: null
    });
    const summary = p;
    const extra = summary.skipped || summary.failed ? `（跳过 ${summary.skipped ?? 0}，失败 ${summary.failed ?? 0}）` : "";
    toast.ok(
      `${p.direction === "upload" ? "上传" : "下载"}完成：${p.files} 个文件 · ${formatBytes(p.bytes)}${extra}`
    );
    prune();
  });
  subscribe(Events.SFTP_TRANSFER_ERROR, (p) => {
    upsert(p.transferId, {
      transferId: p.transferId,
      sessionId: p.sessionId,
      status: "failed",
      message: p.message,
      finishedAt: Date.now(),
      scanning: null,
      ...p.file ? { file: p.file } : {}
    });
    toast.error(`传输失败${p.file ? `（${p.file}）` : ""}：${p.message}`);
  });
}
function markCancelled(transferId) {
  upsert(transferId, { transferId, status: "cancelled", finishedAt: Date.now() });
}
function createBatchReport(kind, entries, note) {
  return {
    kind,
    items: entries.map((e) => ({
      path: e.path,
      name: e.name,
      isDirectory: e.type === "directory",
      status: "pending"
    })),
    startedAt: Date.now(),
    ...note === void 0 ? {} : { note }
  };
}
function markItem(report, path, patch) {
  let touched = false;
  const items2 = report.items.map((item) => {
    if (item.path !== path) return item;
    touched = true;
    return { ...item, ...patch };
  });
  if (!touched) return report;
  return { ...report, items: items2 };
}
function markItemByTransfer(report, transferId, patch) {
  const index = report.items.findIndex((i) => i.transferId === transferId);
  if (index === -1) return report;
  const items2 = report.items.slice();
  const current = items2[index];
  if (!current) return report;
  items2[index] = { ...current, ...patch };
  return { ...report, items: items2 };
}
function finishReport(report) {
  return report.finishedAt === void 0 ? { ...report, finishedAt: Date.now() } : report;
}
function batchCounts(report) {
  let ok = 0;
  let failed = 0;
  let pending = 0;
  let running = 0;
  let submitted = 0;
  for (const item of report.items) {
    if (item.status === "ok") ok++;
    else if (item.status === "failed") failed++;
    else if (item.status === "pending") pending++;
    else if (item.status === "running") running++;
    else submitted++;
  }
  return {
    total: report.items.length,
    ok,
    failed,
    pending,
    running,
    submitted,
    settled: pending === 0 && running === 0
  };
}
const KIND_LABEL = {
  download: "下载",
  delete: "删除",
  chmod: "改权限"
};
function formatBatchSummary(report) {
  const c = batchCounts(report);
  const label = KIND_LABEL[report.kind];
  const parts = [`成功 ${c.ok}`];
  if (c.failed > 0) parts.push(`失败 ${c.failed}`);
  if (c.submitted > 0) parts.push(`进行中 ${c.submitted}`);
  if (c.pending > 0 || c.running > 0) parts.push(`待处理 ${c.pending + c.running}`);
  return `${label}：${parts.join(" / ")} / 共 ${c.total}`;
}
function batchFailureLines(report) {
  return report.items.filter((i) => i.status === "failed").map((i) => `${i.name}：${i.error ?? "未知原因"}`);
}
function hasFailures(report) {
  return report.items.some((i) => i.status === "failed");
}
function chmodStepOutcome(result) {
  const changed = result.changed;
  const details = result.failed.map((f) => `${f.path}: ${f.message}`);
  if (result.failed.length === 0) {
    return { changed, ...details.length > 0 ? { details } : {} };
  }
  return {
    changed,
    details,
    error: `${result.failed.length} 项失败（已改 ${changed} 项）`
  };
}
const STATUS_LABEL = {
  pending: "待处理",
  running: "进行中",
  submitted: "已提交",
  ok: "成功",
  failed: "失败"
};
function statusIcon(status) {
  switch (status) {
    case "ok":
      return { name: "check", className: "sftp-batch__icon sftp-batch__icon--ok" };
    case "failed":
      return { name: "close", className: "sftp-batch__icon sftp-batch__icon--failed" };
    case "running":
      return { name: "refresh", className: "sftp-batch__icon sftp-batch__icon--busy" };
    default:
      return { name: "clock", className: "sftp-batch__icon sftp-batch__icon--idle" };
  }
}
function BatchPanel({
  report,
  onClose
}) {
  const counts = batchCounts(report);
  const failed = hasFailures(report);
  const ordered = [...report.items].sort((a, b) => {
    const rank = (i) => i.status === "failed" ? 0 : i.status === "ok" ? 2 : 1;
    return rank(a) - rank(b);
  });
  return /* @__PURE__ */ jsxRuntimeExports.jsxs(
    "section",
    {
      className: `sftp-batch${failed ? " sftp-batch--has-failure" : ""}`,
      "data-testid": "batch-panel",
      "data-batch-kind": report.kind,
      "data-batch-total": counts.total,
      "data-batch-ok": counts.ok,
      "data-batch-failed": counts.failed,
      "aria-label": "批量操作结果",
      children: [
        /* @__PURE__ */ jsxRuntimeExports.jsxs("header", { className: "sftp-batch__head", children: [
          /* @__PURE__ */ jsxRuntimeExports.jsx(Icon, { name: failed ? "info" : "check", size: 13 }),
          /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "sftp-batch__title", "data-testid": "batch-summary", children: formatBatchSummary(report) }),
          failed ? /* @__PURE__ */ jsxRuntimeExports.jsxs("span", { className: "sftp-batch__warn", "data-testid": "batch-failed-count", children: [
            "有 ",
            counts.failed,
            " 项未成功"
          ] }) : null,
          /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "t-toolbar__spacer" }),
          /* @__PURE__ */ jsxRuntimeExports.jsx(IconButton, { icon: "close", label: "关闭批量结果", size: 12, onClick: onClose })
        ] }),
        report.note ? /* @__PURE__ */ jsxRuntimeExports.jsx("p", { className: "sftp-batch__note", children: report.note }) : null,
        /* @__PURE__ */ jsxRuntimeExports.jsx("ul", { className: "sftp-batch__list", children: ordered.map((item) => {
          const icon = statusIcon(item.status);
          return /* @__PURE__ */ jsxRuntimeExports.jsxs(
            "li",
            {
              className: "sftp-batch__row",
              "data-testid": "batch-item",
              "data-path": item.path,
              "data-status": item.status,
              children: [
                /* @__PURE__ */ jsxRuntimeExports.jsx(Icon, { name: icon.name, size: 12, className: icon.className }),
                /* @__PURE__ */ jsxRuntimeExports.jsxs("span", { className: "sftp-batch__name", title: item.path, children: [
                  item.name,
                  item.isDirectory ? /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "sftp-batch__dir", children: "目录" }) : null
                ] }),
                /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "sftp-batch__status", children: item.status === "ok" && item.changed !== void 0 ? `成功 · 改动 ${item.changed} 项` : STATUS_LABEL[item.status] }),
                item.status === "failed" ? /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "sftp-batch__reason", title: item.error ?? "未知原因", children: item.error ?? "未知原因" }) : null,
                item.details && item.details.length > 0 ? /* @__PURE__ */ jsxRuntimeExports.jsxs("ul", { className: "sftp-batch__details", "data-testid": "batch-item-detail", children: [
                  item.details.slice(0, 5).map((d) => /* @__PURE__ */ jsxRuntimeExports.jsx("li", { title: d, children: d }, d)),
                  item.details.length > 5 ? /* @__PURE__ */ jsxRuntimeExports.jsxs("li", { children: [
                    "…还有 ",
                    item.details.length - 5,
                    " 项"
                  ] }) : null
                ] }) : null
              ]
            },
            item.path
          );
        }) })
      ]
    }
  );
}
const MAX_SHOWN_COMMANDS = 50;
function withEmphasis(text) {
  return text.split("**").map(
    (part, i) => i % 2 === 1 ? /* @__PURE__ */ jsxRuntimeExports.jsx("strong", { children: part }, i) : /* @__PURE__ */ jsxRuntimeExports.jsx("span", { children: part }, i)
  );
}
function ChmodDialog({
  open,
  targets,
  initialMode,
  preview,
  onRun,
  onClose
}) {
  const [modeText, setModeText] = reactExports.useState(initialMode ?? "");
  const [recursive, setRecursive] = reactExports.useState(false);
  const [plans, setPlans] = reactExports.useState([]);
  const [planning, setPlanning] = reactExports.useState(false);
  const [planError, setPlanError] = reactExports.useState(null);
  const seq = reactExports.useRef(0);
  const hasDir = targets.some((t) => t.type === "directory");
  const mode = octalToMode(modeText);
  reactExports.useEffect(() => {
    if (!open) return;
    setModeText(initialMode ?? "");
    setRecursive(false);
    setPlans([]);
    setPlanError(null);
  }, [open, initialMode]);
  reactExports.useEffect(() => {
    if (!open || mode === void 0 || targets.length === 0) {
      setPlans([]);
      return;
    }
    const mySeq = ++seq.current;
    setPlanning(true);
    setPlanError(null);
    void (async () => {
      try {
        const next = [];
        for (const t of targets) {
          next.push(await preview(t.path, mode, recursive));
        }
        if (mySeq !== seq.current) return;
        setPlans(next);
      } catch (err) {
        if (mySeq !== seq.current) return;
        setPlanError(err instanceof Error ? err.message : String(err));
        setPlans([]);
      } finally {
        if (mySeq === seq.current) setPlanning(false);
      }
    })();
  }, [open, mode, recursive, targets, preview]);
  const aggregate = reactExports.useMemo(() => {
    const entries = plans.reduce((n, p) => n + p.entries.length, 0);
    const truncated = plans.some((p) => p.truncated);
    const warnings = [...new Set(plans.map((p) => p.warning).filter((w) => Boolean(w)))];
    const commands = [];
    for (const p of plans) {
      for (const c of p.commands) {
        if (commands.length >= MAX_SHOWN_COMMANDS) break;
        commands.push(c);
      }
    }
    const totalCommands = plans.reduce((n, p) => n + p.entries.length, 0);
    return { entries, truncated, warnings, commands, totalCommands };
  }, [plans]);
  const title = targets.length === 1 ? `修改权限 · ${targets[0]?.name ?? ""}` : `批量改权限（${targets.length} 项）`;
  return /* @__PURE__ */ jsxRuntimeExports.jsx(
    Modal,
    {
      open,
      title,
      onClose,
      footer: /* @__PURE__ */ jsxRuntimeExports.jsxs(jsxRuntimeExports.Fragment, { children: [
        /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "t-modal__footer-spacer" }),
        /* @__PURE__ */ jsxRuntimeExports.jsx(Button, { variant: "ghost", onClick: onClose, children: "取消" }),
        /* @__PURE__ */ jsxRuntimeExports.jsx(
          Button,
          {
            variant: "primary",
            "data-testid": "chmod-run",
            disabled: mode === void 0,
            onClick: () => {
              if (mode === void 0) return;
              onRun(mode, recursive);
            },
            children: recursive ? `递归执行${aggregate.entries > 0 ? `（${aggregate.entries} 项）` : ""}` : "执行"
          }
        )
      ] }),
      children: /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "t-grid", children: [
        /* @__PURE__ */ jsxRuntimeExports.jsx(Field, { label: "八进制权限（如 644 / 755）", required: true, children: /* @__PURE__ */ jsxRuntimeExports.jsx(
          TextInput,
          {
            mono: true,
            autoFocus: true,
            "data-testid": "chmod-mode",
            value: modeText,
            placeholder: "644 / 755",
            onChange: (e) => setModeText(e.target.value)
          }
        ) }),
        hasDir ? (
          // Checkbox 的 props 是封闭接口（不转发 data-*），所以把锚点放在外层容器上；
          // 勾选框本身是 label 里的隐藏 input，程序化点击 input 即可触发 onChange。
          /* @__PURE__ */ jsxRuntimeExports.jsx("div", { "data-testid": "chmod-recursive", children: /* @__PURE__ */ jsxRuntimeExports.jsx(
            Checkbox,
            {
              checked: recursive,
              onChange: setRecursive,
              label: "递归应用到目录内的所有内容（等价 chmod -R）"
            }
          ) })
        ) : null,
        aggregate.warnings.map((w) => /* @__PURE__ */ jsxRuntimeExports.jsx(Banner, { tone: "error", children: /* @__PURE__ */ jsxRuntimeExports.jsxs("span", { "data-testid": "chmod-warning", children: [
          "⚠ 危险：",
          withEmphasis(w)
        ] }) }, w)),
        /* @__PURE__ */ jsxRuntimeExports.jsx(
          Field,
          {
            label: "预备执行命令",
            hint: /* @__PURE__ */ jsxRuntimeExports.jsxs(jsxRuntimeExports.Fragment, { children: [
              "执行前先算清楚会动哪些路径。",
              recursive ? "符号链接不跟随（与 chmod -R 一致），链接自身会被改；根目录上不允许递归。" : ""
            ] }),
            aside: planning ? /* @__PURE__ */ jsxRuntimeExports.jsx(Badge, { tone: "outline", children: "计算中…" }) : null,
            children: planError ? /* @__PURE__ */ jsxRuntimeExports.jsxs("span", { className: "t-field__hint", "data-testid": "chmod-plan-error", children: [
              "预览失败：",
              planError,
              "（可仍然执行，结果会逐项报告）"
            ] }) : plans.length === 0 ? /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "t-field__hint", "data-testid": "chmod-plan-empty", children: mode === void 0 ? "填入合法权限后显示将要执行的命令" : "正在计算…" }) : /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "sftp-chmod__plan", "data-testid": "chmod-plan", children: [
              plans.map((p, i) => /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "sftp-chmod__plan-row", children: [
                /* @__PURE__ */ jsxRuntimeExports.jsx("code", { className: "mono", "data-testid": "chmod-plan-summary", children: p.summary }),
                /* @__PURE__ */ jsxRuntimeExports.jsxs("span", { className: "sftp-chmod__count", children: [
                  p.entries.length,
                  " 项"
                ] })
              ] }, targets[i]?.path ?? i)),
              aggregate.truncated ? /* @__PURE__ */ jsxRuntimeExports.jsxs("span", { className: "sftp-chmod__truncated", "data-testid": "chmod-plan-truncated", children: [
                "⚠ 条目数超过主进程上限（5000），已截断 —— ",
                /* @__PURE__ */ jsxRuntimeExports.jsx("b", { children: "执行时也只会处理已列出的部分" }),
                "。"
              ] }) : null,
              /* @__PURE__ */ jsxRuntimeExports.jsxs("details", { className: "sftp-chmod__details", "data-testid": "chmod-commands", children: [
                /* @__PURE__ */ jsxRuntimeExports.jsxs("summary", { children: [
                  "命令明细（显示 ",
                  aggregate.commands.length,
                  " / ",
                  aggregate.totalCommands,
                  " 条）"
                ] }),
                /* @__PURE__ */ jsxRuntimeExports.jsx("ul", { children: aggregate.commands.map((c) => /* @__PURE__ */ jsxRuntimeExports.jsx("li", { children: /* @__PURE__ */ jsxRuntimeExports.jsx("code", { className: "mono", children: c }) }, c)) }),
                aggregate.totalCommands > aggregate.commands.length ? /* @__PURE__ */ jsxRuntimeExports.jsxs("span", { className: "t-field__hint", children: [
                  "共 ",
                  aggregate.totalCommands,
                  " 项，此处显示前 ",
                  aggregate.commands.length,
                  " 条"
                ] }) : null
              ] })
            ] })
          }
        ),
        /* @__PURE__ */ jsxRuntimeExports.jsxs("span", { className: "t-field__hint", "data-testid": "chmod-impact", children: [
          "将影响 ",
          aggregate.entries > 0 ? aggregate.entries : targets.length,
          " 项",
          targets.length > 1 ? `（${targets.length} 个目标）` : ""
        ] })
      ] })
    }
  );
}
const EMPTY_SELECTION = { ids: [], anchor: null };
function unique(ids) {
  return [...new Set(ids)];
}
function clickSelection(state, orderedIds, id, mods = {}) {
  const additive = mods.ctrl === true || mods.meta === true;
  if (mods.shift === true) {
    const anchor = state.anchor ?? id;
    const from = orderedIds.indexOf(anchor);
    const to = orderedIds.indexOf(id);
    if (from === -1 || to === -1) return { ids: [id], anchor: id };
    const [start, end] = from <= to ? [from, to] : [to, from];
    const range = orderedIds.slice(start, end + 1);
    return {
      ids: additive ? unique([...state.ids, ...range]) : unique(range),
      // 连选不改锚点，用户才能反复调整范围
      anchor
    };
  }
  if (additive) {
    const has = state.ids.includes(id);
    const ids = has ? state.ids.filter((x) => x !== id) : [...state.ids, id];
    return { ids, anchor: id };
  }
  return { ids: [id], anchor: id };
}
function selectAll(orderedIds) {
  return { ids: unique(orderedIds), anchor: orderedIds[0] ?? null };
}
function clearSelection() {
  return EMPTY_SELECTION;
}
function isSelected(state, id) {
  return state.ids.includes(id);
}
function selectedEntries(entries, state) {
  const wanted = new Set(state.ids);
  return entries.filter((e) => wanted.has(e.path));
}
function countDirectories(entries) {
  return entries.filter((e) => e.type === "directory").length;
}
function sortEntries(entries, opts = {}) {
  const key = opts.key ?? "name";
  const sign = opts.dir === "desc" ? -1 : 1;
  const compare = (a, b) => {
    switch (key) {
      case "size":
        return (a.size ?? 0) - (b.size ?? 0);
      case "mtime":
        return (a.mtime ?? 0) - (b.mtime ?? 0);
      case "perm":
        return (a.permissions ?? "").localeCompare(b.permissions ?? "", "zh-CN");
      case "name":
      default:
        return a.name.localeCompare(b.name, "zh-CN");
    }
  };
  return entries.slice().sort((a, b) => {
    const da = a.type === "directory" ? 0 : 1;
    const db = b.type === "directory" ? 0 : 1;
    if (da !== db) return da - db;
    const result = compare(a, b) * sign;
    return result !== 0 ? result : a.name.localeCompare(b.name, "zh-CN");
  });
}
function filterEntries(entries, query) {
  const q = query.trim().toLowerCase();
  if (q === "") return entries;
  return entries.filter((e) => e.name.toLowerCase().includes(q));
}
function isSelfOrDescendant(path, ancestor) {
  if (path === ancestor) return true;
  if (ancestor === "/") return path.startsWith("/");
  const base = ancestor.endsWith("/") ? ancestor.slice(0, -1) : ancestor;
  if (base === "") return false;
  return path.startsWith(`${base}/`);
}
function ancestorsOf(path) {
  if (!path.startsWith("/")) return [];
  const parts = path.split("/").filter(Boolean);
  if (parts.length === 0) return [];
  const out = ["/"];
  let acc = "";
  for (let i = 0; i < parts.length - 1; i++) {
    acc += `/${parts[i]}`;
    out.push(acc);
  }
  return out;
}
function withDir(cache, path, entries) {
  return { ...cache, [path]: entries };
}
function dropDir(cache, path) {
  if (cache[path] === void 0) return cache;
  const next = { ...cache };
  delete next[path];
  return next;
}
function expandPaths(expanded, paths) {
  if (paths.length === 0) return new Set(expanded);
  const next = new Set(expanded);
  for (const p of paths) next.add(p);
  return next;
}
function collapsePath(expanded, path) {
  if (!expanded.has(path)) return new Set(expanded);
  const next = new Set(expanded);
  next.delete(path);
  return next;
}
function toggleExpanded(expanded, path) {
  return expanded.has(path) ? collapsePath(expanded, path) : expandPaths(expanded, [path]);
}
const STATUS_SUFFIX = "\0status";
function flattenTree(options) {
  const maxDepth = options.maxDepth ?? 64;
  const out = [];
  const walk = (items2, depth) => {
    for (const entry of sortEntries(items2)) {
      const isDirectory = entry.type === "directory";
      const expanded = isDirectory && options.expanded.has(entry.path);
      out.push({
        key: entry.path,
        kind: "entry",
        path: entry.path,
        depth,
        isDirectory,
        expanded,
        entry
      });
      if (!expanded || depth + 1 > maxDepth) continue;
      const children = options.childrenOf(entry.path);
      if (children === void 0) {
        const state = options.statusOf?.(entry.path);
        const status = state?.status ?? "loading";
        out.push({
          key: `${entry.path}${STATUS_SUFFIX}`,
          kind: "status",
          path: entry.path,
          depth: depth + 1,
          isDirectory: false,
          expanded: false,
          entry: null,
          status,
          ...state?.message === void 0 ? {} : { message: state.message }
        });
        continue;
      }
      walk(children, depth + 1);
    }
  };
  walk(options.roots, 0);
  return out;
}
function treeKeyIntent(ctx) {
  const entries = ctx.rows.filter((r) => r.kind === "entry");
  const index = ctx.activeKey === null ? -1 : entries.findIndex((r) => r.key === ctx.activeKey);
  const active = index >= 0 ? entries[index] : void 0;
  const additive = ctx.ctrlKey === true || ctx.metaKey === true;
  switch (ctx.key) {
    case "ArrowDown":
    case "ArrowUp": {
      if (entries.length === 0) return { kind: "ignore" };
      let target;
      if (index < 0) {
        target = ctx.key === "ArrowDown" ? entries[0] : entries[entries.length - 1];
      } else {
        const next = ctx.key === "ArrowDown" ? index + 1 : index - 1;
        target = entries[Math.min(Math.max(next, 0), entries.length - 1)];
      }
      if (!target || target.key === ctx.activeKey) return { kind: "ignore" };
      return { kind: "move", key: target.key };
    }
    case "Home":
    case "End": {
      if (entries.length === 0) return { kind: "ignore" };
      const target = ctx.key === "Home" ? entries[0] : entries[entries.length - 1];
      if (!target || target.key === ctx.activeKey) return { kind: "ignore" };
      return { kind: "move", key: target.key };
    }
    case "ArrowRight": {
      if (!active || !active.isDirectory) return { kind: "ignore" };
      if (!active.expanded) return { kind: "expand", path: active.path };
      const child = entries.slice(index + 1).find((r) => r.depth > active.depth);
      return child ? { kind: "move", key: child.key } : { kind: "ignore" };
    }
    case "ArrowLeft": {
      if (!active) return { kind: "ignore" };
      if (active.isDirectory && active.expanded) return { kind: "collapse", path: active.path };
      let parent;
      for (let i = index - 1; i >= 0; i--) {
        const row = entries[i];
        if (row && row.depth < active.depth) {
          parent = row;
          break;
        }
      }
      if (!parent) return { kind: "ignore" };
      return { kind: "move", key: parent.key };
    }
    case "Enter":
    case "Return":
      return active ? { kind: "activate", key: active.key, path: active.path, isDirectory: active.isDirectory } : { kind: "ignore" };
    case " ":
      if (!active || !active.isDirectory) return { kind: "ignore" };
      return active.expanded ? { kind: "collapse", path: active.path } : { kind: "expand", path: active.path };
    case "a":
    case "A":
      return additive ? { kind: "selectAll" } : { kind: "ignore" };
    case "Escape":
      return { kind: "clear" };
    default:
      return { kind: "ignore" };
  }
}
function statusRow(row, onRetry) {
  const indent = { paddingLeft: 14 + row.depth * 14 };
  if (row.status === "error") {
    return /* @__PURE__ */ jsxRuntimeExports.jsxs(
      "div",
      {
        className: "sftp-tree__status sftp-tree__status--error",
        style: indent,
        "data-testid": "sftp-tree-status",
        "data-path": row.path,
        children: [
          /* @__PURE__ */ jsxRuntimeExports.jsx(Icon, { name: "alert-triangle", size: 12 }),
          /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "sftp-tree__status-text", title: row.message, children: row.message ?? "读取失败" }),
          /* @__PURE__ */ jsxRuntimeExports.jsx("button", { type: "button", className: "sftp-tree__retry", onClick: () => onRetry(row), children: "重试" })
        ]
      }
    );
  }
  return /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "sftp-tree__status", style: indent, "data-testid": "sftp-tree-status", "data-path": row.path, children: [
    /* @__PURE__ */ jsxRuntimeExports.jsx(Icon, { name: "clock", size: 12 }),
    /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "sftp-tree__status-text", children: "读取中…" })
  ] });
}
function SftpTree({
  rows,
  selection,
  activeKey,
  loading,
  emptyText,
  onRowClick,
  onRowDoubleClick,
  onToggle,
  onContextMenu,
  onKeyDown,
  onBlankMouseDown,
  onRetry
}) {
  const renderRow = (row) => {
    if (row.kind === "status") return statusRow(row, onRetry);
    const entry = row.entry;
    if (!entry) return /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "sftp-tree__status", style: { paddingLeft: 14 + row.depth * 14 } });
    const selected = isSelected(selection, entry.path);
    const kind = entryIconType(entry);
    const active = activeKey === row.key;
    return /* @__PURE__ */ jsxRuntimeExports.jsxs(
      "div",
      {
        className: `sftp-row sftp-tree__row${selected ? " sftp-row--selected" : ""}${active ? " sftp-tree__row--active" : ""}`,
        "data-testid": "sftp-tree-row",
        "data-path": entry.path,
        "data-entry-type": entry.type,
        "data-tree-key": row.key,
        role: "treeitem",
        "aria-selected": selected,
        "aria-level": row.depth + 1,
        "aria-expanded": row.isDirectory ? row.expanded : void 0,
        onClick: (e) => onRowClick(row, { ctrl: e.ctrlKey, meta: e.metaKey, shift: e.shiftKey }),
        onDoubleClick: () => onRowDoubleClick(row),
        onContextMenu: (e) => {
          e.preventDefault();
          onContextMenu(row, e.clientX, e.clientY);
        },
        children: [
          /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "sftp-row__name", style: { paddingLeft: row.depth * 14 }, children: [
            row.isDirectory ? /* @__PURE__ */ jsxRuntimeExports.jsx(
              "button",
              {
                type: "button",
                className: "sftp-tree__twisty",
                "data-testid": "sftp-tree-toggle",
                "aria-label": `${row.expanded ? "折叠" : "展开"} ${entry.name}`,
                onClick: (e) => {
                  e.stopPropagation();
                  onToggle(row);
                },
                onDoubleClick: (e) => e.stopPropagation(),
                children: /* @__PURE__ */ jsxRuntimeExports.jsx(Icon, { name: row.expanded ? "chevron-down" : "chevron-right", size: 12 })
              }
            ) : /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "sftp-tree__spacer", "aria-hidden": "true" }),
            /* @__PURE__ */ jsxRuntimeExports.jsx(
              Icon,
              {
                name: kind === "folder" ? row.expanded ? "folder-open" : "folder" : kind === "link" ? "connections" : "notes",
                size: 13
              }
            ),
            /* @__PURE__ */ jsxRuntimeExports.jsx("span", { title: entry.name, children: entry.name }),
            kind === "link" ? /* @__PURE__ */ jsxRuntimeExports.jsx(Badge, { tone: "outline", children: "软链" }) : null
          ] }),
          /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "sftp-row__num", style: { textAlign: "right" }, children: row.isDirectory ? "—" : formatBytes(entry.size) }),
          /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "sftp-row__perm", children: entry.permissions }),
          /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "sftp-row__num", children: formatDate(new Date(entry.mtime * 1e3).toISOString()) })
        ]
      }
    );
  };
  return /* @__PURE__ */ jsxRuntimeExports.jsx(
    "div",
    {
      className: "sftp-list sftp-tree",
      "data-testid": "sftp-tree",
      tabIndex: 0,
      role: "tree",
      "aria-multiselectable": true,
      "aria-label": "远端目录树",
      onKeyDown,
      onMouseDown: (e) => {
        const el = e.currentTarget;
        if (document.activeElement !== el) el.focus();
        if (!e.target.closest('[data-testid="sftp-tree-row"]')) onBlankMouseDown();
      },
      children: rows.length === 0 ? loading ? /* @__PURE__ */ jsxRuntimeExports.jsx(Loading, { text: "读取目录…" }) : /* @__PURE__ */ jsxRuntimeExports.jsx(EmptyState, { icon: "folder", title: "没有可展开的目录", text: emptyText }) : /* @__PURE__ */ jsxRuntimeExports.jsx(
        VirtualList,
        {
          items: rows,
          rowHeight: 30,
          className: "sftp-scroll",
          getKey: (r) => r.key,
          renderRow
        }
      )
    }
  );
}
const LOCAL_DIR_KEY = "t1000:sftp-local-dir";
const VIEW_KEY = "t1000:sftp-view";
const SORT_KEY = "t1000:sftp-sort";
const HEAD_COLS = [
  { key: "name", label: "名称" },
  { key: "size", label: "大小", align: "right" },
  { key: "perm", label: "权限" },
  { key: "mtime", label: "修改时间" }
];
const EMPTY_ENTRIES = [];
function rememberedViewMode() {
  try {
    return localStorage.getItem(VIEW_KEY) === "tree" ? "tree" : "list";
  } catch {
    return "list";
  }
}
function rememberedSort() {
  try {
    const raw = localStorage.getItem(SORT_KEY);
    if (!raw) return { key: "name", dir: "asc" };
    const parsed = JSON.parse(raw);
    const key = HEAD_COLS.some((c) => c.key === parsed.key) ? parsed.key : "name";
    return { key, dir: parsed.dir === "desc" ? "desc" : "asc" };
  } catch {
    return { key: "name", dir: "asc" };
  }
}
function rememberSort(key, dir) {
  try {
    localStorage.setItem(SORT_KEY, JSON.stringify({ key, dir }));
  } catch {
  }
}
function rememberViewMode(mode) {
  try {
    localStorage.setItem(VIEW_KEY, mode);
  } catch {
  }
}
function withoutKey(record, key) {
  if (!(key in record)) return record;
  const next = { ...record };
  delete next[key];
  return next;
}
function rememberedLocalDir() {
  try {
    return localStorage.getItem(LOCAL_DIR_KEY) ?? "";
  } catch {
    return "";
  }
}
function rememberLocalDir(dir) {
  try {
    localStorage.setItem(LOCAL_DIR_KEY, dir);
  } catch {
  }
}
function TransferRow({ item }) {
  const percent = item.totalBytes > 0 ? Math.min(100, item.transferredBytes / item.totalBytes * 100) : 0;
  const done = item.status !== "running";
  return /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: `tx${item.status === "failed" ? " tx--failed" : ""}${item.status === "finished" ? " tx--finished" : ""}`, children: [
    /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "tx__top", children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx(Icon, { name: item.direction === "upload" ? "upload" : "download", size: 12 }),
      /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "tx__file", title: item.file, children: item.file }),
      /* @__PURE__ */ jsxRuntimeExports.jsxs("span", { className: "tx__nums", children: [
        formatBytes(item.transferredBytes),
        " / ",
        formatBytes(item.totalBytes),
        item.speed ? ` · ${formatBytes(item.speed)}/s` : ""
      ] }),
      item.status === "failed" ? /* @__PURE__ */ jsxRuntimeExports.jsx(Badge, { tone: "danger", children: "失败" }) : null,
      item.status === "cancelled" ? /* @__PURE__ */ jsxRuntimeExports.jsx(Badge, { tone: "warn", children: "已取消" }) : null,
      item.status === "finished" ? /* @__PURE__ */ jsxRuntimeExports.jsx(Badge, { tone: "ok", children: "完成" }) : null,
      !done ? /* @__PURE__ */ jsxRuntimeExports.jsx(
        IconButton,
        {
          icon: "close",
          label: "取消传输",
          size: 12,
          tone: "danger",
          onClick: () => {
            void invoke(
              "sftp",
              "cancelTransfer",
              { transferId: item.transferId }
            ).then(() => markCancelled(item.transferId)).catch((err) => toast.error(`取消失败：${errorText(err)}`));
          }
        }
      ) : null
    ] }),
    !done ? /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "bar", style: { marginTop: 5 }, children: /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: `bar__fill${percent >= 90 ? " bar__fill--warn" : ""}`, style: { width: `${percent}%` } }) }) : null,
    item.scanning ? /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "tx__scan", children: [
      "正在扫描 ",
      item.scanning.path,
      " · 已发现 ",
      item.scanning.files,
      " 个文件 /",
      " ",
      formatBytes(item.scanning.bytes)
    ] }) : null,
    item.message ? /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "t-field__error", children: item.message }) : null,
    item.filesTotal && item.filesTotal > 1 ? /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "metric__sub", children: [
      "文件 ",
      item.filesDone ?? 0,
      "/",
      item.filesTotal
    ] }) : null
  ] });
}
function TransferQueue({ sessionId }) {
  const all = useTransfers();
  const mine = all.filter((t) => t.sessionId === sessionId);
  const [collapsed, setCollapsed] = reactExports.useState(false);
  if (mine.length === 0) return null;
  const running = mine.filter((t) => t.status === "running").length;
  return /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "sftp-queue", children: [
    /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "sftp-queue__head", children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx(Icon, { name: "download", size: 13 }),
      "传输队列",
      /* @__PURE__ */ jsxRuntimeExports.jsx(Badge, { tone: running > 0 ? "accent" : "default", children: running > 0 ? `${running} 进行中` : `${mine.length} 条` }),
      /* @__PURE__ */ jsxRuntimeExports.jsx("div", { style: { flex: 1 } }),
      /* @__PURE__ */ jsxRuntimeExports.jsx(
        IconButton,
        {
          icon: "trash",
          label: "清除已结束的条目",
          size: 12,
          onClick: () => clearFinished()
        }
      ),
      /* @__PURE__ */ jsxRuntimeExports.jsx(
        IconButton,
        {
          icon: collapsed ? "chevron-right" : "chevron-down",
          label: collapsed ? "展开" : "收起",
          size: 12,
          onClick: () => setCollapsed((v) => !v)
        }
      )
    ] }),
    !collapsed ? /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "sftp-queue__body", children: mine.map((t) => /* @__PURE__ */ jsxRuntimeExports.jsx(TransferRow, { item: t }, t.transferId)) }) : null
  ] });
}
function Prompt({
  open,
  title,
  label,
  hint,
  initial = "",
  placeholder,
  confirmText = "确定",
  danger = false,
  onClose,
  onSubmit
}) {
  const [value, setValue] = reactExports.useState(initial);
  reactExports.useEffect(() => {
    if (open) setValue(initial);
  }, [open, initial]);
  return /* @__PURE__ */ jsxRuntimeExports.jsx(
    Modal,
    {
      open,
      size: "sm",
      title,
      onClose,
      footer: /* @__PURE__ */ jsxRuntimeExports.jsxs(jsxRuntimeExports.Fragment, { children: [
        /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "t-modal__footer-spacer" }),
        /* @__PURE__ */ jsxRuntimeExports.jsx(Button, { variant: "ghost", onClick: onClose, children: "取消" }),
        /* @__PURE__ */ jsxRuntimeExports.jsx(
          Button,
          {
            variant: danger ? "danger" : "primary",
            onClick: () => {
              void onSubmit(value);
            },
            children: confirmText
          }
        )
      ] }),
      children: /* @__PURE__ */ jsxRuntimeExports.jsx(Field, { label, hint, children: /* @__PURE__ */ jsxRuntimeExports.jsx(
        TextInput,
        {
          value,
          placeholder,
          autoFocus: true,
          onChange: (e) => setValue(e.target.value),
          onKeyDown: (e) => {
            if (e.key === "Enter") void onSubmit(value);
          }
        }
      ) })
    }
  );
}
function SftpBrowser({ sessionId, title }) {
  const [cwd, setCwd] = reactExports.useState("");
  const { connectionId, terminalCwd } = useStoreShallow((s) => {
    const tab = s.tabs.find((t) => t.sessionId === sessionId);
    return {
      connectionId: tab?.connectionId,
      terminalCwd: sessionId ? s.sessionCwd[sessionId] : void 0
    };
  });
  const [bookmarks, setBookmarks] = reactExports.useState([]);
  const [editingPath, setEditingPath] = reactExports.useState(null);
  const [bmDialog, setBmDialog] = reactExports.useState(null);
  const [dirs, setDirs] = reactExports.useState({});
  const [loading, setLoading] = reactExports.useState(false);
  const [error, setError] = reactExports.useState(null);
  const [selection, setSelection] = reactExports.useState(EMPTY_SELECTION);
  const [batchReport, setBatchReport] = reactExports.useState(null);
  const [batchDeleteOpen, setBatchDeleteOpen] = reactExports.useState(false);
  const [batchChmodOpen, setBatchChmodOpen] = reactExports.useState(false);
  const [batchDownloadOpen, setBatchDownloadOpen] = reactExports.useState(false);
  const [showHidden, setShowHidden] = reactExports.useState(false);
  const [sort, setSort] = reactExports.useState(rememberedSort);
  const [filter, setFilter] = reactExports.useState("");
  const [moreOpen, setMoreOpen] = reactExports.useState(false);
  const [pathEdit, setPathEdit] = reactExports.useState(null);
  const [viewMode, setViewMode] = reactExports.useState(rememberedViewMode);
  const [treeRoot, setTreeRoot] = reactExports.useState("");
  const [expanded, setExpanded] = reactExports.useState(() => /* @__PURE__ */ new Set());
  const [dirLoading, setDirLoading] = reactExports.useState(() => /* @__PURE__ */ new Set());
  const [dirErrors, setDirErrors] = reactExports.useState({});
  const [activeKey, setActiveKey] = reactExports.useState(null);
  const [menu, setMenu] = reactExports.useState(null);
  const [mkdir, setMkdir] = reactExports.useState(false);
  const [renameTarget, setRenameTarget] = reactExports.useState(null);
  const [chmodTarget, setChmodTarget] = reactExports.useState(null);
  const [deleteTarget, setDeleteTarget] = reactExports.useState(null);
  const [uploadOpen, setUploadOpen] = reactExports.useState(false);
  const [downloadTarget, setDownloadTarget] = reactExports.useState(null);
  const [localDir, setLocalDir] = reactExports.useState(rememberedLocalDir);
  const [localFiles, setLocalFiles] = reactExports.useState([]);
  const [recursive, setRecursive] = reactExports.useState(true);
  const conflictPolicy = useStoreShallow((s) => ({ v: s.transferConflictPolicy })).v;
  const seq = reactExports.useRef(0);
  const showHiddenRef = reactExports.useRef(showHidden);
  showHiddenRef.current = showHidden;
  const dirsRef = reactExports.useRef(dirs);
  dirsRef.current = dirs;
  const expandedRef = reactExports.useRef(expanded);
  expandedRef.current = expanded;
  const inflight = reactExports.useRef(/* @__PURE__ */ new Set());
  reactExports.useEffect(() => {
    wireTransferEvents();
  }, []);
  reactExports.useEffect(() => {
    const offOk = subscribe(Events.SFTP_TRANSFER_FINISHED, (p) => {
      setBatchReport((prev) => prev ? markItemByTransfer(prev, p.transferId, { status: "ok" }) : prev);
    });
    const offErr = subscribe(Events.SFTP_TRANSFER_ERROR, (p) => {
      setBatchReport(
        (prev) => prev ? markItemByTransfer(prev, p.transferId, { status: "failed", error: p.message }) : prev
      );
    });
    return () => {
      offOk();
      offErr();
    };
  }, []);
  const load = reactExports.useCallback(
    async (path) => {
      if (!sessionId) return;
      const mySeq = ++seq.current;
      setLoading(true);
      setError(null);
      try {
        const list = await invoke(
          "sftp",
          "list",
          { sessionId, path, showHidden: showHiddenRef.current }
        );
        if (mySeq !== seq.current) return;
        setDirs((prev) => withDir(prev, path, Array.isArray(list) ? list : []));
        setDirErrors((prev) => withoutKey(prev, path));
        setCwd(path);
      } catch (err) {
        if (mySeq !== seq.current) return;
        const message = errorText(err);
        setError(message);
        setDirs((prev) => dropDir(prev, path));
        setDirErrors((prev) => ({ ...prev, [path]: message }));
      } finally {
        if (mySeq === seq.current) setLoading(false);
      }
    },
    [sessionId]
  );
  const fetchDir = reactExports.useCallback(
    async (path) => {
      if (!sessionId) return;
      if (inflight.current.has(path)) return;
      inflight.current.add(path);
      setDirLoading((prev) => new Set(prev).add(path));
      setDirErrors((prev) => withoutKey(prev, path));
      try {
        const list = await invoke(
          "sftp",
          "list",
          { sessionId, path, showHidden: showHiddenRef.current }
        );
        setDirs((prev) => withDir(prev, path, Array.isArray(list) ? list : []));
      } catch (err) {
        const message = errorText(err);
        setDirErrors((prev) => ({ ...prev, [path]: message }));
      } finally {
        inflight.current.delete(path);
        setDirLoading((prev) => {
          if (!prev.has(path)) return prev;
          const next = new Set(prev);
          next.delete(path);
          return next;
        });
      }
    },
    [sessionId]
  );
  reactExports.useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await invoke(
          "sftp",
          "home",
          { sessionId }
        );
        if (!cancelled && res?.path) {
          setTreeRoot(res.path);
          void load(res.path);
        }
      } catch (err) {
        if (!cancelled) {
          setError(errorText(err));
          setTreeRoot("/");
          void load("/");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId, load]);
  const hiddenRef = reactExports.useRef(showHidden);
  reactExports.useEffect(() => {
    if (hiddenRef.current === showHidden) return;
    hiddenRef.current = showHidden;
    setDirs({});
    setDirErrors({});
    inflight.current.clear();
    const targets = /* @__PURE__ */ new Set();
    if (cwd) targets.add(cwd);
    if (treeRoot) targets.add(treeRoot);
    for (const p of expandedRef.current) targets.add(p);
    if (cwd) void load(cwd);
    for (const p of targets) {
      if (p !== cwd) void fetchDir(p);
    }
  }, [showHidden, cwd, treeRoot, load, fetchDir]);
  const cwdEntries = dirs[cwd] ?? EMPTY_ENTRIES;
  const sorted = reactExports.useMemo(
    () => sortEntries(filterEntries(cwdEntries, filter), { key: sort.key, dir: sort.dir }),
    [cwdEntries, filter, sort]
  );
  const visibleBytes = reactExports.useMemo(
    () => sorted.reduce((n, e) => n + (e.type === "directory" ? 0 : e.size ?? 0), 0),
    [sorted]
  );
  const treeRootEntries = reactExports.useMemo(
    () => sortEntries(dirs[treeRoot] ?? EMPTY_ENTRIES, { key: sort.key, dir: sort.dir }),
    [dirs, treeRoot, sort]
  );
  const treeRows = reactExports.useMemo(
    () => flattenTree({
      roots: treeRootEntries,
      expanded,
      childrenOf: (path) => dirs[path],
      statusOf: (path) => {
        const message = dirErrors[path];
        if (message !== void 0) return { status: "error", message };
        return dirLoading.has(path) ? { status: "loading" } : void 0;
      }
    }),
    [treeRootEntries, expanded, dirs, dirErrors, dirLoading]
  );
  const knownEntries = reactExports.useMemo(() => {
    const out = [];
    const seen = /* @__PURE__ */ new Set();
    const add = (list) => {
      for (const entry of list ?? []) {
        if (seen.has(entry.path)) continue;
        seen.add(entry.path);
        out.push(entry);
      }
    };
    add(sorted);
    for (const list of Object.values(dirs)) add(list);
    return out;
  }, [sorted, dirs]);
  const entryByPath = reactExports.useMemo(() => new Map(knownEntries.map((e) => [e.path, e])), [knownEntries]);
  const selectedPath = selection.ids.length === 1 ? selection.ids[0] ?? null : null;
  const selected = selectedPath;
  const selectedEntry = selected ? entryByPath.get(selected) ?? null : null;
  const pickedEntries = reactExports.useMemo(() => selectedEntries(knownEntries, selection), [knownEntries, selection]);
  const pickedDirs = countDirectories(pickedEntries);
  const multiSelecting = selection.ids.length >= 2;
  reactExports.useEffect(() => {
    const offSaved = subscribe(Events.SFTP_EDIT_SAVED, (p) => {
      if (p.sessionId !== sessionId) return;
      if (p.remoteChangedSinceOpen) {
        toast.warn(`已写回 ${p.remotePath}，但该文件在你编辑期间被改过 —— 可能覆盖了别人的修改。`);
      } else {
        toast.ok(`已写回远端：${p.remotePath}（${p.bytes} 字节）`);
      }
      reload();
    });
    const offErr = subscribe(Events.SFTP_EDIT_ERROR, (p) => {
      if (p.sessionId !== void 0 && p.sessionId !== sessionId) return;
      toast.error(`写回远端失败：${p.remotePath} — ${p.message}`);
    });
    return () => {
      offSaved();
      offErr();
    };
  }, [sessionId]);
  const refreshBookmarks = reactExports.useCallback(() => {
    setBookmarks(listBookmarks(connectionId));
  }, [connectionId]);
  reactExports.useEffect(() => {
    refreshBookmarks();
  }, [refreshBookmarks]);
  const locateToTerminal = reactExports.useCallback(() => {
    if (!sessionId) return;
    void (async () => {
      let target = terminalCwd;
      let getCwdError = null;
      try {
        const res = await invoke("ssh", "getCwd", { sessionId });
        if (res?.cwd) target = res.cwd;
        else if (!target) {
          toast.info(res?.reason ?? "还没拿到终端的当前目录。");
          return;
        }
      } catch (err) {
        getCwdError = errorText(err);
        console.warn("[sftp] 定位：ssh.getCwd 调用失败，回退到渲染层 OSC 7 值", err);
      }
      if (!target) {
        toast.info(
          getCwdError ? `拿不到终端当前目录，且主进程查询失败：${getCwdError}` : "还没拿到终端的当前目录：需要远端 shell 发 OSC 7 才能识别（bash 可在 PROMPT_COMMAND 里输出，zsh/fish 常见配置自带）。也可以在下方书签里手动收藏常用目录。"
        );
        return;
      }
      void load(target);
    })();
  }, [sessionId, terminalCwd, load]);
  const reload = () => {
    if (cwd) void load(cwd);
  };
  const submitUpload = async () => {
    if (!sessionId || localFiles.length === 0) return;
    const paths = localFiles.slice();
    rememberLocalDir(paths[0]?.split("/").slice(0, -1).join("/") ?? "");
    setUploadOpen(false);
    let ok = 0;
    for (const src of paths) {
      const name = src.split("/").filter(Boolean).pop() ?? "";
      try {
        await invoke("sftp", "upload", {
          sessionId,
          direction: "upload",
          sourcePath: src,
          targetPath: joinRemote(cwd, name),
          recursive,
          conflictPolicy
        });
        ok += 1;
      } catch (err) {
        toast.error(`上传提交失败（${name}）：${errorText(err)}`);
      }
    }
    if (ok > 0) toast.info(`已提交 ${ok} 个上传任务`);
    setLocalFiles([]);
  };
  const submitDownload = async (dir) => {
    if (!sessionId || !downloadTarget || !dir.trim()) return;
    rememberLocalDir(dir.trim());
    setLocalDir(dir.trim());
    setDownloadTarget(null);
    try {
      await invoke("sftp", "download", {
        sessionId,
        direction: "download",
        sourcePath: downloadTarget.path,
        targetPath: `${dir.trim().replace(/\/+$/, "")}/${downloadTarget.name}`,
        recursive: downloadTarget.type === "directory",
        conflictPolicy
      });
      toast.info(`已提交下载：${downloadTarget.name}`);
    } catch (err) {
      toast.error(`下载提交失败：${errorText(err)}`);
    }
  };
  const pickLocal = async (mode, multiple) => {
    try {
      const res = await invoke("app", "pickLocalPath", {
        mode,
        multiple,
        ...mode === "file" ? { title: "选择要上传的本地文件" } : { title: "选择下载保存目录" },
        ...localDir ? { defaultPath: localDir } : {}
      });
      if (res?.canceled) return [];
      return res?.paths ?? [];
    } catch (err) {
      toast.error(`打开文件选择器失败：${errorText(err)}`);
      return [];
    }
  };
  const openRemoteEditor = async (entry) => {
    if (!sessionId) return;
    try {
      const res = await invoke(
        "sftp",
        "openEditor",
        { sessionId, path: entry.path }
      );
      await invoke("app", "openPath", {
        path: res.localPath
      });
      toast.ok(`已用系统编辑器打开：${res.localPath}`);
    } catch (err) {
      toast.error(`打开失败：${errorText(err)}`);
    }
  };
  const runBatch = reactExports.useCallback(
    async (kind, targets, note, run) => {
      let report = createBatchReport(kind, targets, note);
      setBatchReport(report);
      for (const entry of targets) {
        report = markItem(report, entry.path, { status: "running" });
        setBatchReport(report);
        try {
          const outcome = await run(entry);
          if (typeof outcome === "string") {
            report = markItem(report, entry.path, { status: "submitted", transferId: outcome });
          } else if (outcome && typeof outcome === "object") {
            const extra = {
              ...outcome.changed === void 0 ? {} : { changed: outcome.changed },
              ...outcome.details === void 0 ? {} : { details: outcome.details }
            };
            report = outcome.error ? markItem(report, entry.path, { status: "failed", error: outcome.error, ...extra }) : markItem(report, entry.path, { status: "ok", ...extra });
          } else {
            report = markItem(report, entry.path, { status: "ok" });
          }
        } catch (err) {
          report = markItem(report, entry.path, { status: "failed", error: errorText(err) });
        }
        setBatchReport(report);
      }
      report = finishReport(report);
      setBatchReport(report);
      const summary = formatBatchSummary(report);
      if (hasFailures(report)) {
        toast.warn(`${summary}｜${batchFailureLines(report).join("；")}`);
      } else {
        toast.ok(summary);
      }
      return report;
    },
    []
  );
  const runBatchDownload = (dir) => {
    if (!sessionId) return;
    const targets = pickedEntries.slice();
    const target = dir.trim().replace(/\/+$/, "");
    if (target === "" || targets.length === 0) return;
    rememberLocalDir(target);
    setLocalDir(target);
    setBatchDownloadOpen(false);
    setSelection(clearSelection());
    void runBatch("download", targets, "目录会递归下载；每一项的最终结果见下方传输队列与本面板", async (entry) => {
      const res = await invoke(
        "sftp",
        "download",
        {
          sessionId,
          direction: "download",
          sourcePath: entry.path,
          targetPath: `${target}/${entry.name}`,
          recursive: entry.type === "directory",
          conflictPolicy
        }
      );
      return res?.id;
    });
  };
  const runBatchDelete = () => {
    if (!sessionId) return;
    const targets = pickedEntries.slice();
    const dirs2 = countDirectories(targets);
    setBatchDeleteOpen(false);
    setSelection(clearSelection());
    void runBatch(
      "delete",
      targets,
      dirs2 > 0 ? `其中 ${dirs2} 个目录会连同全部内容一起删除（递归，不可恢复）` : void 0,
      async (entry) => {
        await invoke("sftp", "remove", {
          sessionId,
          path: entry.path,
          recursive: entry.type === "directory"
        });
      }
    ).then(() => reload());
  };
  const previewChmodFor = reactExports.useCallback(
    async (path, mode, recursive2) => {
      if (!sessionId) throw new Error("会话不存在或已断开");
      return invoke(
        "sftp",
        "previewChmod",
        { sessionId, path, mode, recursive: recursive2 }
      );
    },
    [sessionId]
  );
  const runChmod = (mode, recursive2, targets) => {
    if (!sessionId || targets.length === 0) return;
    const dirs2 = countDirectories(targets);
    setChmodTarget(null);
    setBatchChmodOpen(false);
    if (targets.length > 1) setSelection(clearSelection());
    const note = recursive2 ? `递归应用到目录内全部内容（符号链接不跟随，链接自身会改）；共 ${targets.length} 个目标${dirs2 > 0 ? `，其中 ${dirs2} 个目录` : ""}` : dirs2 > 0 ? `未勾递归：${dirs2} 个目录只改目录自身（不进入其中）` : void 0;
    void runBatch("chmod", targets, note, async (entry) => {
      const res = await invoke("sftp", "chmod", {
        sessionId,
        path: entry.path,
        mode,
        recursive: recursive2
      });
      return chmodStepOutcome(res);
    }).then(() => reload());
  };
  const expandNode = reactExports.useCallback(
    (path) => {
      setExpanded((prev) => expandPaths(prev, [path]));
      if (dirsRef.current[path] === void 0) void fetchDir(path);
    },
    [fetchDir]
  );
  const collapseNode = reactExports.useCallback((path) => {
    setExpanded((prev) => collapsePath(prev, path));
  }, []);
  const toggleNode = reactExports.useCallback(
    (path) => {
      const willExpand = !expandedRef.current.has(path);
      setExpanded((prev) => toggleExpanded(prev, path));
      if (willExpand && dirsRef.current[path] === void 0) void fetchDir(path);
    },
    [fetchDir]
  );
  const openDir = reactExports.useCallback(
    (path) => {
      expandNode(path);
      void load(path);
    },
    [expandNode, load]
  );
  const revealPath = reactExports.useCallback(
    async (path) => {
      if (!treeRoot || path === treeRoot) {
        setActiveKey(null);
        return;
      }
      const chain = ancestorsOf(path).filter((p) => isSelfOrDescendant(p, treeRoot));
      if (chain.length > 0) setExpanded((prev) => expandPaths(prev, chain));
      for (const dir of chain) {
        if (dirsRef.current[dir] === void 0) await fetchDir(dir);
      }
      setActiveKey(path);
    },
    [treeRoot, fetchDir]
  );
  const toggleSort = reactExports.useCallback(
    (key) => {
      if (key === sort.key) {
        const dir2 = sort.dir === "asc" ? "desc" : "asc";
        setSort({ key, dir: dir2 });
        rememberSort(key, dir2);
        return;
      }
      const dir = key === "name" || key === "perm" ? "asc" : "desc";
      setSort({ key, dir });
      rememberSort(key, dir);
    },
    [sort]
  );
  const moveListSelection = (move) => {
    if (sorted.length === 0) return;
    let idx;
    if (move === "first") idx = 0;
    else if (move === "last") idx = sorted.length - 1;
    else {
      const cur = selection.anchor ? sorted.findIndex((e) => e.path === selection.anchor) : -1;
      const base = cur < 0 ? move > 0 ? -1 : 0 : cur;
      idx = Math.min(sorted.length - 1, Math.max(0, base + move));
    }
    const target = sorted[idx];
    if (!target) return;
    setSelection({ ids: [target.path], anchor: target.path });
    requestAnimationFrame(() => {
      document.querySelector(`[data-testid="sftp-row"][data-path="${CSS.escape(target.path)}"]`)?.scrollIntoView({ block: "nearest" });
    });
  };
  const switchView = reactExports.useCallback(
    (mode) => {
      setViewMode(mode);
      rememberViewMode(mode);
      if (mode === "tree") {
        if (cwd) void revealPath(cwd);
      } else {
        setActiveKey(null);
      }
    },
    [cwd, revealPath]
  );
  const onTreeRowClick = reactExports.useCallback(
    (row, mods) => {
      const ordered = treeRows.filter((r) => r.kind === "entry").map((r) => r.path);
      setSelection((prev) => clickSelection(prev, ordered, row.path, mods));
      setActiveKey(row.key);
    },
    [treeRows]
  );
  const onTreeActivate = reactExports.useCallback(
    (row) => {
      if (row.kind !== "entry" || !row.entry) return;
      if (row.isDirectory) openDir(row.path);
      else setActiveKey(row.key);
    },
    [openDir]
  );
  const onTreeKeyDown = reactExports.useCallback(
    (e) => {
      const intent = treeKeyIntent({
        key: e.key,
        ctrlKey: e.ctrlKey,
        metaKey: e.metaKey,
        shiftKey: e.shiftKey,
        rows: treeRows,
        activeKey
      });
      switch (intent.kind) {
        case "ignore":
          return;
        case "move":
          e.preventDefault();
          e.stopPropagation();
          setActiveKey(intent.key);
          return;
        case "expand":
          e.preventDefault();
          e.stopPropagation();
          expandNode(intent.path);
          return;
        case "collapse":
          e.preventDefault();
          e.stopPropagation();
          collapseNode(intent.path);
          return;
        case "activate":
          e.preventDefault();
          e.stopPropagation();
          if (intent.isDirectory) openDir(intent.path);
          else setActiveKey(intent.key);
          return;
        case "selectAll":
          e.preventDefault();
          e.stopPropagation();
          setSelection(selectAll(treeRows.filter((r) => r.kind === "entry").map((r) => r.path)));
          return;
        case "clear":
          e.preventDefault();
          e.stopPropagation();
          setSelection(clearSelection());
          return;
      }
    },
    [treeRows, activeKey, expandNode, collapseNode, openDir]
  );
  const openRowMenu = reactExports.useCallback((entry, x, y) => {
    setSelection((prev) => prev.ids.includes(entry.path) ? prev : { ids: [entry.path], anchor: entry.path });
    setMenu({ x, y, entry });
  }, []);
  const menuTargets = reactExports.useMemo(() => {
    if (!menu) return [];
    if (selection.ids.length >= 2 && selection.ids.includes(menu.entry.path)) return pickedEntries;
    return [menu.entry];
  }, [menu, selection, pickedEntries]);
  const menuItems = reactExports.useMemo(() => {
    if (!menu) return [];
    const many = menuTargets.length;
    const single = many === 1 ? menuTargets[0] : void 0;
    const items2 = [];
    if (single) {
      items2.push({
        id: "open",
        label: single.type === "directory" ? "打开目录" : "用内置编辑器打开",
        icon: single.type === "directory" ? "folder-open" : "edit",
        onSelect: () => {
          if (single.type === "directory") openDir(single.path);
          else setEditingPath(single.path);
        }
      });
      items2.push({ id: "download", label: "下载", icon: "download", onSelect: () => setDownloadTarget(single) });
      items2.push({ id: "rename", label: "重命名", icon: "edit", onSelect: () => setRenameTarget(single) });
    } else {
      items2.push({
        id: "batch-download",
        label: `批量下载（${many} 项）`,
        icon: "download",
        onSelect: () => setBatchDownloadOpen(true)
      });
    }
    items2.push({
      id: "chmod",
      label: many > 1 ? `批量改权限（${many} 项）` : "权限",
      icon: "sliders",
      separatorBefore: true,
      onSelect: () => {
        if (many > 1) setBatchChmodOpen(true);
        else if (single) setChmodTarget(single);
      }
    });
    items2.push({
      id: "delete",
      label: many > 1 ? `批量删除（${many} 项）` : "删除",
      icon: "trash",
      danger: true,
      onSelect: () => {
        if (many > 1) setBatchDeleteOpen(true);
        else if (single) setDeleteTarget(single);
      }
    });
    items2.push({
      id: "copy-path",
      label: many > 1 ? `复制 ${many} 个路径` : "复制路径",
      icon: "copy",
      separatorBefore: true,
      onSelect: () => {
        if (!navigator.clipboard) {
          toast.error("当前环境不支持剪贴板");
          return;
        }
        void navigator.clipboard.writeText(menuTargets.map((e) => e.path).join("\n")).then(() => toast.ok("已复制路径")).catch(() => toast.error("复制路径失败"));
      }
    });
    return items2;
  }, [menu, menuTargets, openDir]);
  if (!sessionId) {
    return /* @__PURE__ */ jsxRuntimeExports.jsx("main", { className: "content", "aria-label": "文件", children: /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "conn-empty", children: /* @__PURE__ */ jsxRuntimeExports.jsx(
      EmptyState,
      {
        icon: "folder",
        title: "没有可浏览的会话",
        text: "SFTP 依附于一个已建立的 SSH 会话。先在连接中心连上一台服务器，再回到这里浏览远端文件。",
        actions: /* @__PURE__ */ jsxRuntimeExports.jsx(Button, { variant: "primary", icon: "connections", onClick: () => actions.setView("connections"), children: "去连接中心" })
      }
    ) }) });
  }
  return /* @__PURE__ */ jsxRuntimeExports.jsxs("main", { className: "content sftp-root", "aria-label": `${title} 文件`, children: [
    bookmarks.length > 0 ? /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "sftp-bookmarks", "aria-label": "目录书签", children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx(Icon, { name: "star", size: 12 }),
      bookmarks.map((b) => /* @__PURE__ */ jsxRuntimeExports.jsxs("span", { className: `sftp-bm${b.path === cwd ? " sftp-bm--active" : ""}`, children: [
        /* @__PURE__ */ jsxRuntimeExports.jsx(
          "button",
          {
            type: "button",
            className: "sftp-bm__go",
            title: b.path,
            onClick: () => void load(b.path),
            onContextMenu: (e) => {
              e.preventDefault();
              setBmDialog({ mode: "rename", id: b.id, path: b.path, name: b.name });
            },
            children: b.name
          }
        ),
        /* @__PURE__ */ jsxRuntimeExports.jsx(
          "button",
          {
            type: "button",
            className: "sftp-bm__del",
            "aria-label": `删除书签 ${b.name}`,
            onClick: () => {
              removeBookmark(b.id);
              refreshBookmarks();
              toast.ok(`已删除书签「${b.name}」`);
            },
            children: /* @__PURE__ */ jsxRuntimeExports.jsx(Icon, { name: "close", size: 10 })
          }
        )
      ] }, b.id)),
      /* @__PURE__ */ jsxRuntimeExports.jsx(
        "span",
        {
          className: "sftp-bookmarks__note",
          title: "书签保存在本机存储里，不会同步到其它设备，也不随本地库备份导出",
          children: "仅本机保存，不参与同步"
        }
      )
    ] }) : null,
    /* @__PURE__ */ jsxRuntimeExports.jsxs(
      "div",
      {
        className: "sftp-top",
        role: "toolbar",
        "aria-label": "文件浏览工具条",
        onKeyDown: (e) => {
          if (e.key === "Escape" && moreOpen) {
            e.stopPropagation();
            setMoreOpen(false);
          }
        },
        children: [
          /* @__PURE__ */ jsxRuntimeExports.jsx(
            IconButton,
            {
              className: "sftp-top__ib",
              icon: "chevron-left",
              label: "上一级",
              disabled: !cwd || cwd === "/",
              onClick: () => void load(parentRemote(cwd))
            }
          ),
          /* @__PURE__ */ jsxRuntimeExports.jsx(IconButton, { className: "sftp-top__ib", icon: "home", label: "主目录", onClick: () => void load("~") }),
          /* @__PURE__ */ jsxRuntimeExports.jsx(IconButton, { className: "sftp-top__ib", icon: "refresh", label: "刷新", loading, onClick: reload }),
          /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "t-toolbar__divider" }),
          pathEdit !== null ? /* @__PURE__ */ jsxRuntimeExports.jsx(
            "form",
            {
              className: "sftp-pathedit",
              onSubmit: (e) => {
                e.preventDefault();
                const target = pathEdit.trim();
                setPathEdit(null);
                if (target) void load(target);
              },
              children: /* @__PURE__ */ jsxRuntimeExports.jsx(
                "input",
                {
                  autoFocus: true,
                  className: "sftp-pathedit__input",
                  value: pathEdit,
                  "aria-label": "输入目录路径",
                  placeholder: "/var/log 或 ~",
                  spellCheck: false,
                  onChange: (e) => setPathEdit(e.target.value),
                  onKeyDown: (e) => {
                    if (e.key === "Escape") {
                      e.preventDefault();
                      e.stopPropagation();
                      setPathEdit(null);
                    }
                  }
                }
              )
            }
          ) : /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "sftp-crumbs", onDoubleClick: () => setPathEdit(cwd || ""), title: "双击可直接输入路径", children: breadcrumbSegments(cwd || "/").map((seg, i, arr) => /* @__PURE__ */ jsxRuntimeExports.jsxs("span", { className: "sftp-crumb__wrap", children: [
            /* @__PURE__ */ jsxRuntimeExports.jsx(
              "button",
              {
                type: "button",
                className: `sftp-crumb${i === arr.length - 1 ? " sftp-crumb--last" : ""}`,
                onClick: () => void load(seg.path),
                children: seg.label
              }
            ),
            i < arr.length - 1 ? /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "sftp-crumb__sep", children: "/" }) : null
          ] }, seg.path)) }),
          /* @__PURE__ */ jsxRuntimeExports.jsx(
            "input",
            {
              className: "sftp-filter",
              value: filter,
              placeholder: "过滤…",
              "aria-label": "按名称过滤当前目录",
              spellCheck: false,
              onChange: (e) => setFilter(e.target.value),
              onKeyDown: (e) => {
                if (e.key === "Escape") {
                  e.stopPropagation();
                  setFilter("");
                }
              }
            }
          ),
          /* @__PURE__ */ jsxRuntimeExports.jsx(IconButton, { className: "sftp-top__ib", icon: "folder", label: "新建文件夹", onClick: () => setMkdir(true) }),
          /* @__PURE__ */ jsxRuntimeExports.jsx(
            IconButton,
            {
              className: "sftp-top__ib",
              icon: "upload",
              label: "上传",
              onClick: () => {
                setLocalFiles([]);
                setUploadOpen(true);
              }
            }
          ),
          /* @__PURE__ */ jsxRuntimeExports.jsx(
            IconButton,
            {
              className: "sftp-top__ib",
              icon: "download",
              label: "下载（选中项）",
              disabled: !selectedEntry,
              onClick: () => {
                if (selectedEntry) setDownloadTarget(selectedEntry);
              }
            }
          ),
          /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "sftp-top__more", children: [
            /* @__PURE__ */ jsxRuntimeExports.jsx(
              IconButton,
              {
                icon: "more",
                label: "更多：视图、显示与低频操作",
                tone: moreOpen ? "accent" : "default",
                "aria-haspopup": "dialog",
                "aria-expanded": moreOpen,
                onClick: () => setMoreOpen((v) => !v)
              }
            ),
            moreOpen ? /* @__PURE__ */ jsxRuntimeExports.jsxs(jsxRuntimeExports.Fragment, { children: [
              /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "sftp-pop__scrim", onMouseDown: () => setMoreOpen(false) }),
              /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "sftp-pop", role: "dialog", "aria-label": "视图与显示选项", children: [
                /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "sftp-pop__cells", "data-testid": "sftp-view-toggle", children: [
                  /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "sftp-pop__cell", children: [
                    /* @__PURE__ */ jsxRuntimeExports.jsx(
                      Switch,
                      {
                        checked: viewMode === "tree",
                        onChange: (next) => switchView(next ? "tree" : "list"),
                        label: "树视图"
                      }
                    ),
                    /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "sftp-pop__cap", children: viewMode === "tree" ? "树视图" : "列表视图" })
                  ] }),
                  /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "sftp-pop__cell", children: [
                    /* @__PURE__ */ jsxRuntimeExports.jsx(Switch, { checked: showHidden, onChange: setShowHidden, label: "显示隐藏文件" }),
                    /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "sftp-pop__cap", children: "显示隐藏" })
                  ] })
                ] }),
                /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "sftp-pop__sep" }),
                /* @__PURE__ */ jsxRuntimeExports.jsxs(
                  "button",
                  {
                    type: "button",
                    className: "sftp-pop__item",
                    onClick: () => {
                      setMoreOpen(false);
                      setPathEdit(cwd || "");
                    },
                    children: [
                      /* @__PURE__ */ jsxRuntimeExports.jsx(Icon, { name: "edit", size: 13 }),
                      /* @__PURE__ */ jsxRuntimeExports.jsx("span", { children: "输入路径…" }),
                      /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "sftp-pop__hint", children: "双击面包屑" })
                    ]
                  }
                ),
                /* @__PURE__ */ jsxRuntimeExports.jsxs(
                  "button",
                  {
                    type: "button",
                    className: "sftp-pop__item",
                    onClick: () => {
                      setMoreOpen(false);
                      locateToTerminal();
                    },
                    children: [
                      /* @__PURE__ */ jsxRuntimeExports.jsx(Icon, { name: "route", size: 13 }),
                      /* @__PURE__ */ jsxRuntimeExports.jsx("span", { children: "定位到终端目录" }),
                      /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "sftp-pop__hint", children: "OSC 7" })
                    ]
                  }
                ),
                /* @__PURE__ */ jsxRuntimeExports.jsxs(
                  "button",
                  {
                    type: "button",
                    className: "sftp-pop__item",
                    onClick: () => {
                      setMoreOpen(false);
                      setBmDialog({
                        mode: "add",
                        path: cwd,
                        name: cwd.split("/").filter(Boolean).pop() ?? "/"
                      });
                    },
                    disabled: !cwd,
                    children: [
                      /* @__PURE__ */ jsxRuntimeExports.jsx(Icon, { name: "star", size: 13 }),
                      /* @__PURE__ */ jsxRuntimeExports.jsx("span", { children: "当前目录加为书签" })
                    ]
                  }
                ),
                /* @__PURE__ */ jsxRuntimeExports.jsxs(
                  "button",
                  {
                    type: "button",
                    className: "sftp-pop__item",
                    disabled: !selectedEntry || selectedEntry.type === "directory",
                    onClick: () => {
                      setMoreOpen(false);
                      if (selectedEntry) setEditingPath(selectedEntry.path);
                    },
                    children: [
                      /* @__PURE__ */ jsxRuntimeExports.jsx(Icon, { name: "notes", size: 13 }),
                      /* @__PURE__ */ jsxRuntimeExports.jsx("span", { children: "用内置编辑器打开" })
                    ]
                  }
                ),
                /* @__PURE__ */ jsxRuntimeExports.jsxs(
                  "button",
                  {
                    type: "button",
                    className: "sftp-pop__item",
                    disabled: !selectedEntry || selectedEntry.type === "directory",
                    onClick: () => {
                      setMoreOpen(false);
                      if (selectedEntry) void openRemoteEditor(selectedEntry);
                    },
                    children: [
                      /* @__PURE__ */ jsxRuntimeExports.jsx(Icon, { name: "external", size: 13 }),
                      /* @__PURE__ */ jsxRuntimeExports.jsx("span", { children: "用系统程序打开" })
                    ]
                  }
                )
              ] })
            ] }) : null
          ] })
        ]
      }
    ),
    error ? /* @__PURE__ */ jsxRuntimeExports.jsx("div", { style: { padding: "10px 12px 0" }, children: /* @__PURE__ */ jsxRuntimeExports.jsx(Banner, { tone: "error", actions: /* @__PURE__ */ jsxRuntimeExports.jsx(Button, { size: "sm", onClick: reload, children: "重试" }), children: error }) }) : null,
    /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "sftp-head", role: "row", children: HEAD_COLS.map((col) => {
      const active = sort.key === col.key;
      return /* @__PURE__ */ jsxRuntimeExports.jsxs(
        "button",
        {
          type: "button",
          role: "columnheader",
          "aria-sort": active ? sort.dir === "asc" ? "ascending" : "descending" : "none",
          className: `sftp-head__btn${active ? " sftp-head__btn--on" : ""}${col.align === "right" ? " sftp-head__btn--right" : ""}`,
          onClick: () => toggleSort(col.key),
          children: [
            /* @__PURE__ */ jsxRuntimeExports.jsx("span", { children: col.label }),
            active ? /* @__PURE__ */ jsxRuntimeExports.jsx(Icon, { name: sort.dir === "asc" ? "chevron-up" : "chevron-down", size: 10 }) : null
          ]
        },
        col.key
      );
    }) }),
    viewMode === "list" ? /* @__PURE__ */ jsxRuntimeExports.jsx(
      "div",
      {
        className: "sftp-list",
        "data-testid": "sftp-list",
        tabIndex: 0,
        role: "listbox",
        "aria-multiselectable": true,
        onKeyDown: (e) => {
          const mod = e.ctrlKey || e.metaKey;
          if (mod && (e.key === "a" || e.key === "A")) {
            e.preventDefault();
            e.stopPropagation();
            setSelection(selectAll(sorted.map((x) => x.path)));
            return;
          }
          if (e.key === "Escape") {
            e.preventDefault();
            setSelection(clearSelection());
            return;
          }
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            e.stopPropagation();
            moveListSelection(e.key === "ArrowDown" ? 1 : -1);
            return;
          }
          if (e.key === "Home" || e.key === "End") {
            e.preventDefault();
            e.stopPropagation();
            moveListSelection(e.key === "Home" ? "first" : "last");
            return;
          }
          if (e.key === "Enter") {
            if (!selectedEntry) return;
            e.preventDefault();
            e.stopPropagation();
            if (selectedEntry.type === "directory") void load(selectedEntry.path);
            else setEditingPath(selectedEntry.path);
            return;
          }
          if (e.key === "Backspace") {
            e.preventDefault();
            e.stopPropagation();
            if (cwd && cwd !== "/") void load(parentRemote(cwd));
            return;
          }
          if (e.key === "F2") {
            if (!selectedEntry) return;
            e.preventDefault();
            e.stopPropagation();
            setRenameTarget(selectedEntry);
            return;
          }
          if (e.key === "Delete") {
            e.preventDefault();
            e.stopPropagation();
            if (multiSelecting) setBatchDeleteOpen(true);
            else if (selectedEntry) setDeleteTarget(selectedEntry);
          }
        },
        onMouseDown: (e) => {
          const el = e.currentTarget;
          if (document.activeElement !== el) el.focus();
          if (!e.target.closest('[data-testid="sftp-row"]')) {
            setSelection(clearSelection());
          }
        },
        children: loading && sorted.length === 0 ? /* @__PURE__ */ jsxRuntimeExports.jsx(Loading, { text: "读取目录…" }) : sorted.length === 0 && !error ? filter.trim() === "" ? /* @__PURE__ */ jsxRuntimeExports.jsx(EmptyState, { icon: "folder", title: "空目录", text: "这个目录下没有可显示的内容。" }) : /* @__PURE__ */ jsxRuntimeExports.jsx(
          EmptyState,
          {
            icon: "filter",
            title: "没有匹配项",
            text: `当前目录里没有名称包含「${filter.trim()}」的条目。`,
            actions: /* @__PURE__ */ jsxRuntimeExports.jsx(Button, { size: "sm", variant: "outline", onClick: () => setFilter(""), children: "清除过滤" })
          }
        ) : /* @__PURE__ */ jsxRuntimeExports.jsx(
          VirtualList,
          {
            items: sorted,
            rowHeight: 30,
            className: "sftp-scroll",
            getKey: (e) => e.path,
            renderRow: (entry) => {
              const kind = entryIconType(entry);
              const isDir = entry.type === "directory";
              return /* @__PURE__ */ jsxRuntimeExports.jsxs(
                "div",
                {
                  className: `sftp-row${isSelected(selection, entry.path) ? " sftp-row--selected" : ""}`,
                  "data-testid": "sftp-row",
                  "data-path": entry.path,
                  "data-entry-type": entry.type,
                  "aria-selected": isSelected(selection, entry.path),
                  onClick: (e) => {
                    setSelection(
                      (prev) => clickSelection(prev, sorted.map((x) => x.path), entry.path, {
                        ctrl: e.ctrlKey,
                        meta: e.metaKey,
                        shift: e.shiftKey
                      })
                    );
                  },
                  onDoubleClick: () => {
                    if (selection.ids.length > 1) return;
                    if (isDir) void load(entry.path);
                    else setEditingPath(entry.path);
                  },
                  onContextMenu: (e) => {
                    e.preventDefault();
                    openRowMenu(entry, e.clientX, e.clientY);
                  },
                  children: [
                    /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: `sftp-row__name${isDir ? " sftp-row__name--dir" : kind === "link" ? " sftp-row__name--link" : ""}`, children: [
                      /* @__PURE__ */ jsxRuntimeExports.jsx(Icon, { name: kind === "folder" ? "folder" : kind === "link" ? "connections" : "notes", size: 13 }),
                      /* @__PURE__ */ jsxRuntimeExports.jsx("span", { title: entry.name, children: entry.name }),
                      kind === "link" ? /* @__PURE__ */ jsxRuntimeExports.jsx(Badge, { tone: "outline", children: "软链" }) : null
                    ] }),
                    /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "sftp-row__num", style: { textAlign: "right" }, children: isDir ? "—" : formatBytes(entry.size) }),
                    /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "sftp-row__perm", children: entry.permissions }),
                    /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "sftp-row__num", children: formatDate(new Date(entry.mtime * 1e3).toISOString()) })
                  ]
                }
              );
            }
          }
        )
      }
    ) : /* @__PURE__ */ jsxRuntimeExports.jsx(
      SftpTree,
      {
        rows: treeRows,
        selection,
        activeKey,
        loading: loading && treeRootEntries.length === 0,
        emptyText: treeRoot ? `「${treeRoot}」下没有可显示的内容。` : "还没有拿到远端主目录。",
        onRowClick: onTreeRowClick,
        onRowDoubleClick: onTreeActivate,
        onToggle: (row) => toggleNode(row.path),
        onContextMenu: (row, x, y) => {
          if (row.entry) openRowMenu(row.entry, x, y);
        },
        onKeyDown: onTreeKeyDown,
        onBlankMouseDown: () => setSelection(clearSelection()),
        onRetry: (row) => void fetchDir(row.path)
      }
    ),
    /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "sftp-status", role: "status", "aria-live": "polite", children: [
      /* @__PURE__ */ jsxRuntimeExports.jsxs("span", { "data-testid": "sftp-count", children: [
        sorted.length,
        " 项",
        filter.trim() === "" ? "" : ` / 共 ${cwdEntries.length}`
      ] }),
      selection.ids.length > 0 ? /* @__PURE__ */ jsxRuntimeExports.jsxs("span", { className: "sftp-status__sel", children: [
        "已选 ",
        selection.ids.length
      ] }) : null,
      /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "sftp-status__spacer" }),
      /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "sftp-status__num", title: "当前可见文件的大小合计（不含目录）", children: formatBytes(visibleBytes) })
    ] }),
    multiSelecting ? /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "sftp-queue__head sftp-batchbar", "data-testid": "batch-toolbar", children: [
      /* @__PURE__ */ jsxRuntimeExports.jsxs("span", { className: "tx__file", "data-testid": "batch-selection-count", children: [
        "已选 ",
        selection.ids.length,
        " 项",
        pickedDirs > 0 ? `（含 ${pickedDirs} 个目录）` : ""
      ] }),
      /* @__PURE__ */ jsxRuntimeExports.jsx(
        Button,
        {
          size: "sm",
          variant: "ghost",
          icon: "download",
          "data-testid": "batch-download",
          onClick: () => {
            setLocalFiles([]);
            setBatchDownloadOpen(true);
          },
          children: "批量下载"
        }
      ),
      /* @__PURE__ */ jsxRuntimeExports.jsx(
        Button,
        {
          size: "sm",
          variant: "ghost",
          icon: "sliders",
          "data-testid": "batch-chmod",
          onClick: () => setBatchChmodOpen(true),
          children: "批量改权限"
        }
      ),
      /* @__PURE__ */ jsxRuntimeExports.jsx(
        Button,
        {
          size: "sm",
          variant: "danger",
          icon: "trash",
          "data-testid": "batch-delete",
          onClick: () => setBatchDeleteOpen(true),
          children: "批量删除"
        }
      ),
      /* @__PURE__ */ jsxRuntimeExports.jsx(
        IconButton,
        {
          icon: "close",
          label: "清除选择",
          "data-testid": "batch-clear",
          onClick: () => setSelection(clearSelection())
        }
      )
    ] }) : selected ? /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "sftp-queue__head", children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "tx__file", title: selected, children: selected }),
      /* @__PURE__ */ jsxRuntimeExports.jsx(Button, { size: "sm", variant: "ghost", icon: "edit", onClick: () => {
        if (selectedEntry) setRenameTarget(selectedEntry);
      }, children: "重命名" }),
      /* @__PURE__ */ jsxRuntimeExports.jsx(Button, { size: "sm", variant: "ghost", icon: "sliders", onClick: () => {
        if (selectedEntry) setChmodTarget(selectedEntry);
      }, children: "权限" }),
      /* @__PURE__ */ jsxRuntimeExports.jsx(Button, { size: "sm", variant: "danger", icon: "trash", onClick: () => {
        if (selectedEntry) setDeleteTarget(selectedEntry);
      }, children: "删除" }),
      /* @__PURE__ */ jsxRuntimeExports.jsx(IconButton, { icon: "close", label: "取消选择", onClick: () => setSelection(clearSelection()) })
    ] }) : null,
    batchReport ? /* @__PURE__ */ jsxRuntimeExports.jsx(BatchPanel, { report: batchReport, onClose: () => setBatchReport(null) }) : null,
    /* @__PURE__ */ jsxRuntimeExports.jsx(TransferQueue, { sessionId }),
    /* @__PURE__ */ jsxRuntimeExports.jsx(
      Prompt,
      {
        open: mkdir,
        title: "新建文件夹",
        label: "文件夹名",
        initial: "",
        onClose: () => setMkdir(false),
        onSubmit: async (name) => {
          if (!name.trim()) return;
          try {
            await invoke("sftp", "mkdir", {
              sessionId,
              path: joinRemote(cwd, name.trim())
            });
            setMkdir(false);
            reload();
          } catch (err) {
            toast.error(`创建失败：${errorText(err)}`);
          }
        }
      }
    ),
    /* @__PURE__ */ jsxRuntimeExports.jsx(
      Prompt,
      {
        open: renameTarget !== null,
        title: "重命名",
        label: "新名称",
        initial: renameTarget?.name ?? "",
        onClose: () => setRenameTarget(null),
        onSubmit: async (name) => {
          if (!renameTarget || !name.trim()) return;
          try {
            await invoke("sftp", "rename", {
              sessionId,
              from: renameTarget.path,
              to: joinRemote(parentRemote(renameTarget.path), name.trim()),
              overwrite: false
            });
            setRenameTarget(null);
            setSelection(clearSelection());
            reload();
          } catch (err) {
            toast.error(`重命名失败：${errorText(err)}`);
          }
        }
      }
    ),
    /* @__PURE__ */ jsxRuntimeExports.jsx(
      ChmodDialog,
      {
        open: chmodTarget !== null,
        targets: chmodTarget ? [chmodTarget] : [],
        initialMode: chmodTarget ? modeToOctal(chmodTarget.mode) : void 0,
        preview: previewChmodFor,
        onClose: () => setChmodTarget(null),
        onRun: (mode, recursive2) => runChmod(mode, recursive2, chmodTarget ? [chmodTarget] : [])
      }
    ),
    /* @__PURE__ */ jsxRuntimeExports.jsx(
      Modal,
      {
        open: deleteTarget !== null,
        size: "sm",
        title: "删除远端条目",
        onClose: () => setDeleteTarget(null),
        footer: /* @__PURE__ */ jsxRuntimeExports.jsxs(jsxRuntimeExports.Fragment, { children: [
          /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "t-modal__footer-spacer" }),
          /* @__PURE__ */ jsxRuntimeExports.jsx(Button, { variant: "ghost", onClick: () => setDeleteTarget(null), children: "取消" }),
          /* @__PURE__ */ jsxRuntimeExports.jsx(
            Button,
            {
              variant: "danger",
              onClick: async () => {
                if (!deleteTarget) return;
                try {
                  await invoke("sftp", "remove", {
                    sessionId,
                    path: deleteTarget.path,
                    recursive: deleteTarget.type === "directory"
                  });
                  toast.ok(`已删除 ${deleteTarget.name}`);
                  setDeleteTarget(null);
                  setSelection(clearSelection());
                  reload();
                } catch (err) {
                  toast.error(`删除失败：${errorText(err)}`);
                }
              },
              children: "删除"
            }
          )
        ] }),
        children: /* @__PURE__ */ jsxRuntimeExports.jsxs("p", { className: "t-field__hint", style: { marginTop: 0 }, children: [
          "将删除 ",
          /* @__PURE__ */ jsxRuntimeExports.jsx("code", { className: "mono", children: deleteTarget?.path }),
          deleteTarget?.type === "directory" ? "（目录及其全部内容）" : "",
          "。 这是**不可恢复**的远端操作，不走废纸篓。"
        ] })
      }
    ),
    /* @__PURE__ */ jsxRuntimeExports.jsx(
      Modal,
      {
        open: uploadOpen,
        title: "上传到远端",
        onClose: () => setUploadOpen(false),
        footer: /* @__PURE__ */ jsxRuntimeExports.jsxs(jsxRuntimeExports.Fragment, { children: [
          /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "t-modal__footer-spacer" }),
          /* @__PURE__ */ jsxRuntimeExports.jsx(Button, { variant: "ghost", onClick: () => setUploadOpen(false), children: "取消" }),
          /* @__PURE__ */ jsxRuntimeExports.jsx(Button, { variant: "primary", icon: "upload", disabled: localFiles.length === 0, onClick: () => void submitUpload(), children: "开始上传" })
        ] }),
        children: /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "t-grid", children: [
          /* @__PURE__ */ jsxRuntimeExports.jsx(
            Field,
            {
              label: "本地文件",
              required: true,
              hint: "用选择按钮挑文件（支持多选）；也可直接手填绝对路径后回车追加。",
              aside: /* @__PURE__ */ jsxRuntimeExports.jsx(
                Button,
                {
                  size: "sm",
                  variant: "outline",
                  icon: "folder",
                  onClick: () => {
                    void pickLocal("file", true).then((paths) => {
                      if (paths.length > 0) setLocalFiles((prev) => [.../* @__PURE__ */ new Set([...prev, ...paths])]);
                    });
                  },
                  children: "选择文件"
                }
              ),
              children: /* @__PURE__ */ jsxRuntimeExports.jsx(
                TextInput,
                {
                  mono: true,
                  placeholder: "选择文件，或粘贴路径后回车",
                  onKeyDown: (e) => {
                    if (e.key !== "Enter") return;
                    const v = e.currentTarget.value.trim();
                    if (!v) return;
                    setLocalFiles((prev) => [.../* @__PURE__ */ new Set([...prev, v])]);
                    e.currentTarget.value = "";
                  }
                }
              )
            }
          ),
          localFiles.length > 0 ? /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "sftp-picked", children: localFiles.map((f) => /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "sftp-picked__row", children: [
            /* @__PURE__ */ jsxRuntimeExports.jsx(Icon, { name: "notes", size: 12 }),
            /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "mono", title: f, children: f }),
            /* @__PURE__ */ jsxRuntimeExports.jsx(
              IconButton,
              {
                icon: "close",
                label: `移除 ${f}`,
                size: 12,
                onClick: () => setLocalFiles((prev) => prev.filter((x) => x !== f))
              }
            )
          ] }, f)) }) : null,
          /* @__PURE__ */ jsxRuntimeExports.jsx(Field, { label: "远端目标目录", children: /* @__PURE__ */ jsxRuntimeExports.jsx(TextInput, { value: cwd, mono: true, readOnly: true }) }),
          /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { style: { display: "flex", gap: 18, alignItems: "center" }, children: [
            /* @__PURE__ */ jsxRuntimeExports.jsx(Checkbox, { checked: recursive, onChange: setRecursive, label: "目录递归上传" }),
            /* @__PURE__ */ jsxRuntimeExports.jsxs("span", { className: "t-field__hint", children: [
              "同名冲突策略：",
              /* @__PURE__ */ jsxRuntimeExports.jsx(Badge, { tone: "outline", children: conflictPolicy }),
              "（在设置 → 文件传输里改）"
            ] })
          ] })
        ] })
      }
    ),
    /* @__PURE__ */ jsxRuntimeExports.jsx(
      Modal,
      {
        open: downloadTarget !== null,
        title: `下载 ${downloadTarget?.name ?? ""}`,
        onClose: () => setDownloadTarget(null),
        footer: /* @__PURE__ */ jsxRuntimeExports.jsxs(jsxRuntimeExports.Fragment, { children: [
          /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "t-modal__footer-spacer" }),
          /* @__PURE__ */ jsxRuntimeExports.jsx(Button, { variant: "ghost", onClick: () => setDownloadTarget(null), children: "取消" }),
          /* @__PURE__ */ jsxRuntimeExports.jsx(Button, { variant: "primary", icon: "download", disabled: !localDir.trim(), onClick: () => void submitDownload(localDir), children: "开始下载" })
        ] }),
        children: /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "t-grid", children: [
          /* @__PURE__ */ jsxRuntimeExports.jsx(
            Field,
            {
              label: "保存到本地目录",
              required: true,
              hint: "用选择按钮挑目录；也会记住上次选择。",
              aside: /* @__PURE__ */ jsxRuntimeExports.jsx(
                Button,
                {
                  size: "sm",
                  variant: "outline",
                  icon: "folder",
                  onClick: () => {
                    void pickLocal("directory", false).then((paths) => {
                      if (paths[0]) setLocalDir(paths[0]);
                    });
                  },
                  children: "选择目录"
                }
              ),
              children: /* @__PURE__ */ jsxRuntimeExports.jsx(TextInput, { value: localDir, mono: true, placeholder: "/home/you/Downloads", onChange: (e) => setLocalDir(e.target.value) })
            }
          ),
          /* @__PURE__ */ jsxRuntimeExports.jsx(Field, { label: "远端源", children: /* @__PURE__ */ jsxRuntimeExports.jsx(TextInput, { value: downloadTarget?.path ?? "", mono: true, readOnly: true }) }),
          /* @__PURE__ */ jsxRuntimeExports.jsxs("span", { className: "t-field__hint", children: [
            downloadTarget?.type === "directory" ? "目录会递归下载。" : "",
            "同名冲突策略：",
            /* @__PURE__ */ jsxRuntimeExports.jsx(Badge, { tone: "outline", children: conflictPolicy })
          ] })
        ] })
      }
    ),
    /* @__PURE__ */ jsxRuntimeExports.jsxs(
      Modal,
      {
        open: batchDeleteOpen,
        size: "sm",
        title: `批量删除 ${pickedEntries.length} 项`,
        onClose: () => setBatchDeleteOpen(false),
        footer: /* @__PURE__ */ jsxRuntimeExports.jsxs(jsxRuntimeExports.Fragment, { children: [
          /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "t-modal__footer-spacer" }),
          /* @__PURE__ */ jsxRuntimeExports.jsx(Button, { variant: "ghost", onClick: () => setBatchDeleteOpen(false), children: "取消" }),
          /* @__PURE__ */ jsxRuntimeExports.jsxs(Button, { variant: "danger", "data-testid": "batch-delete-confirm", onClick: runBatchDelete, children: [
            "删除 ",
            pickedEntries.length,
            " 项"
          ] })
        ] }),
        children: [
          /* @__PURE__ */ jsxRuntimeExports.jsxs("p", { className: "t-field__hint", style: { marginTop: 0 }, children: [
            "将删除以下 ",
            /* @__PURE__ */ jsxRuntimeExports.jsx("b", { "data-testid": "batch-delete-count", children: pickedEntries.length }),
            " 项",
            pickedDirs > 0 ? `，其中 ${pickedDirs} 个目录会连同**全部内容**一起删除（递归）` : "",
            "："
          ] }),
          /* @__PURE__ */ jsxRuntimeExports.jsx("ul", { className: "sftp-batch__preview", children: pickedEntries.slice(0, 15).map((e) => /* @__PURE__ */ jsxRuntimeExports.jsxs("li", { children: [
            /* @__PURE__ */ jsxRuntimeExports.jsx("code", { className: "mono", children: e.path }),
            e.type === "directory" ? /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "sftp-batch__dir", children: "目录·递归" }) : null
          ] }, e.path)) }),
          pickedEntries.length > 15 ? /* @__PURE__ */ jsxRuntimeExports.jsxs("p", { className: "t-field__hint", children: [
            "…还有 ",
            pickedEntries.length - 15,
            " 项（完整清单见执行结果面板）"
          ] }) : null,
          /* @__PURE__ */ jsxRuntimeExports.jsx("p", { className: "t-field__hint", children: "这是**不可恢复**的远端操作，不走废纸篓。" })
        ]
      }
    ),
    /* @__PURE__ */ jsxRuntimeExports.jsx(
      ChmodDialog,
      {
        open: batchChmodOpen,
        targets: pickedEntries,
        preview: previewChmodFor,
        onClose: () => setBatchChmodOpen(false),
        onRun: (mode, recursive2) => runChmod(mode, recursive2, pickedEntries)
      }
    ),
    /* @__PURE__ */ jsxRuntimeExports.jsx(
      Modal,
      {
        open: batchDownloadOpen,
        title: `批量下载 ${pickedEntries.length} 项`,
        onClose: () => setBatchDownloadOpen(false),
        footer: /* @__PURE__ */ jsxRuntimeExports.jsxs(jsxRuntimeExports.Fragment, { children: [
          /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "t-modal__footer-spacer" }),
          /* @__PURE__ */ jsxRuntimeExports.jsx(Button, { variant: "ghost", onClick: () => setBatchDownloadOpen(false), children: "取消" }),
          /* @__PURE__ */ jsxRuntimeExports.jsx(
            Button,
            {
              variant: "primary",
              icon: "download",
              "data-testid": "batch-download-confirm",
              disabled: !localDir.trim() || pickedEntries.length === 0,
              onClick: () => runBatchDownload(localDir),
              children: "开始下载"
            }
          )
        ] }),
        children: /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "t-grid", children: [
          /* @__PURE__ */ jsxRuntimeExports.jsx(
            Field,
            {
              label: "保存到本地目录",
              required: true,
              hint: "每一项都会放到这个目录下（目录递归）。也会记住上次选择。",
              aside: /* @__PURE__ */ jsxRuntimeExports.jsx(
                Button,
                {
                  size: "sm",
                  variant: "outline",
                  icon: "folder",
                  onClick: () => {
                    void pickLocal("directory", false).then((paths) => {
                      if (paths[0]) setLocalDir(paths[0]);
                    });
                  },
                  children: "选择目录"
                }
              ),
              children: /* @__PURE__ */ jsxRuntimeExports.jsx(TextInput, { value: localDir, mono: true, placeholder: "/home/you/Downloads", onChange: (e) => setLocalDir(e.target.value) })
            }
          ),
          /* @__PURE__ */ jsxRuntimeExports.jsx(Field, { label: `远端源（${pickedEntries.length} 项）`, children: /* @__PURE__ */ jsxRuntimeExports.jsx("ul", { className: "sftp-batch__preview", children: pickedEntries.slice(0, 15).map((e) => /* @__PURE__ */ jsxRuntimeExports.jsxs("li", { children: [
            /* @__PURE__ */ jsxRuntimeExports.jsx("code", { className: "mono", children: e.path }),
            e.type === "directory" ? /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "sftp-batch__dir", children: "目录·递归" }) : null
          ] }, e.path)) }) }),
          /* @__PURE__ */ jsxRuntimeExports.jsxs("span", { className: "t-field__hint", children: [
            "同名冲突策略：",
            /* @__PURE__ */ jsxRuntimeExports.jsx(Badge, { tone: "outline", children: conflictPolicy }),
            "（在设置 → 文件传输里改）"
          ] })
        ] })
      }
    ),
    editingPath && sessionId ? /* @__PURE__ */ jsxRuntimeExports.jsx(
      RemoteEditor,
      {
        sessionId,
        path: editingPath,
        onClose: () => setEditingPath(null),
        onSaved: () => reload()
      }
    ) : null,
    /* @__PURE__ */ jsxRuntimeExports.jsx(
      ContextMenu,
      {
        open: menu !== null,
        x: menu?.x ?? 0,
        y: menu?.y ?? 0,
        items: menuItems,
        onClose: () => setMenu(null)
      }
    ),
    bmDialog ? /* @__PURE__ */ jsxRuntimeExports.jsx(
      Modal,
      {
        open: true,
        size: "sm",
        title: bmDialog.mode === "add" ? "添加目录书签" : "重命名书签",
        onClose: () => setBmDialog(null),
        footer: /* @__PURE__ */ jsxRuntimeExports.jsxs(jsxRuntimeExports.Fragment, { children: [
          /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "t-modal__footer-spacer" }),
          /* @__PURE__ */ jsxRuntimeExports.jsx(Button, { variant: "ghost", onClick: () => setBmDialog(null), children: "取消" }),
          /* @__PURE__ */ jsxRuntimeExports.jsx(
            Button,
            {
              variant: "primary",
              onClick: () => {
                const name = bmDialog.name.trim();
                if (bmDialog.mode === "add") {
                  if (!connectionId) {
                    toast.error("这条会话还没有对应连接，无法保存书签");
                    return;
                  }
                  addBookmark(connectionId, bmDialog.path, name);
                  toast.ok(`已收藏「${name || bmDialog.path}」`);
                } else if (bmDialog.id) {
                  renameBookmark(bmDialog.id, name);
                }
                refreshBookmarks();
                setBmDialog(null);
              },
              children: "保存"
            }
          )
        ] }),
        children: /* @__PURE__ */ jsxRuntimeExports.jsx(Field, { label: "书签名称", hint: `目录：${bmDialog.path}`, children: /* @__PURE__ */ jsxRuntimeExports.jsx(
          TextInput,
          {
            value: bmDialog.name,
            autoFocus: true,
            onChange: (e) => setBmDialog({ ...bmDialog, name: e.target.value }),
            onKeyDown: (e) => {
              if (e.key === "Enter") {
                const name = bmDialog.name.trim();
                if (bmDialog.mode === "add" && connectionId) addBookmark(connectionId, bmDialog.path, name);
                else if (bmDialog.id) renameBookmark(bmDialog.id, name);
                refreshBookmarks();
                setBmDialog(null);
              }
            }
          }
        ) })
      }
    ) : null
  ] });
}
export {
  SftpBrowser as default
};
