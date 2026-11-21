import { i as invoke, r as reactExports, j as jsxRuntimeExports, M as Modal, F as Field, T as TextInput, z as Select, ag as TextArea, h as Button, B as Badge, f as Banner, I as Icon, t as toast, e as errorText, aC as writeToSession, L as Loading, u as useStoreShallow, n as IconButton, J as EmptyState } from "./index-C6luzS_t.js";
import { C as ContextMenu } from "./TerminalWorkspace-_KbH417l.js";
/* empty css               */
import "./highlights-DAa5Pc3k.js";
/* empty css                  */
function call(action, payload) {
  return invoke("quickcmd", action, payload);
}
const quickcmd = {
  list: () => call("list", {}),
  listGroups: () => call("listGroups", {}),
  save: (input) => call("save", input),
  /** 注意是 `ids` 数组，不是单个 id */
  remove: (ids) => call("delete", { ids }),
  /** 命令与分组共用：kind 决定 targetId 的含义（命令看 groupId，分组看 parentId） */
  move: (input) => call("move", input),
  reorder: (parentId, orderedIds) => call("reorder", { parentId, orderedIds }),
  saveGroup: (input) => call("saveGroup", input),
  /** `previewGroupDelete` 是删除分组的二次确认数据源 */
  previewGroupDelete: (id) => call("previewGroupDelete", { id }),
  deleteGroup: (id) => call("deleteGroup", { id }),
  /** 后端 search 已支持拼音首字母（`qd` → 前端） */
  search: (query) => call("search", { query }),
  render: (input) => call("render", input),
  parameterDialog: (input) => call("parameterDialog", input),
  execute: (input) => call("execute", input),
  /** 只取渲染结果、不发送 —— 供"粘贴到终端输入框" */
  paste: (input) => call("paste", input),
  analyze: (command) => call("analyze", { command }),
  variables: () => call("variables", {}),
  history: (name, limit) => call(
    "history",
    name === void 0 ? {} : { name, ...limit === void 0 ? {} : { limit } }
  ),
  clearHistory: (name) => call("clearHistory", name === void 0 ? {} : { name }),
  storage: () => call("storage", {})
};
const PARAM_SYNTAX = "${{参数名}}";
const VAR_SYNTAX = "${{date}}";
const OPEN_BRACE2 = "${{";
function QuickCommandEditor({
  mode,
  groupId,
  command,
  onClose,
  onSaved
}) {
  const [name, setName] = reactExports.useState(command?.name ?? "");
  const [body, setBody] = reactExports.useState(command?.command ?? "");
  const [note, setNote] = reactExports.useState(command?.note ?? "");
  const [targetGroup, setTargetGroup] = reactExports.useState(command?.groupId ?? groupId ?? "");
  const [groups, setGroups] = reactExports.useState([]);
  const [tags, setTags] = reactExports.useState(null);
  const [vars, setVars] = reactExports.useState([]);
  const [showVars, setShowVars] = reactExports.useState(false);
  const [err, setErr] = reactExports.useState(null);
  const [saving, setSaving] = reactExports.useState(false);
  const areaRef = reactExports.useRef(null);
  reactExports.useEffect(() => {
    void quickcmd.listGroups().then((g) => setGroups(g ?? [])).catch(() => setGroups([]));
    void quickcmd.variables().then((v) => setVars(v ?? [])).catch(() => setVars([]));
  }, []);
  reactExports.useEffect(() => {
    const t = window.setTimeout(() => {
      if (!body.trim()) {
        setTags(null);
        return;
      }
      void quickcmd.analyze(body).then(setTags).catch(() => setTags(null));
    }, 250);
    return () => window.clearTimeout(t);
  }, [body]);
  const insert = reactExports.useCallback((snippet) => {
    const el = areaRef.current;
    if (!el) {
      setBody((b) => b + snippet);
      return;
    }
    const start = el.selectionStart;
    const end = el.selectionEnd;
    setBody((b) => b.slice(0, start) + snippet + b.slice(end));
    requestAnimationFrame(() => {
      el.focus();
      el.selectionStart = el.selectionEnd = start + snippet.length;
    });
  }, []);
  const submit = async () => {
    if (!name.trim()) {
      setErr("命令名称不能为空");
      return;
    }
    if (!body.trim()) {
      setErr("命令内容不能为空");
      return;
    }
    setSaving(true);
    try {
      await quickcmd.save({
        ...command ? { id: command.id } : {},
        groupId: targetGroup === "" ? null : targetGroup,
        name: name.trim(),
        command: body,
        ...note.trim() ? { note: note.trim() } : {}
      });
      toast.ok(mode === "create" ? `已创建「${name.trim()}」` : `已保存「${name.trim()}」`);
      await onSaved();
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setSaving(false);
    }
  };
  const paramNames = tags?.parameterNames ?? [];
  const varTags = (tags?.tags ?? []).filter((t) => t.kind === "variable");
  const lineCount = body.split("\n").filter((l) => l.trim() !== "").length;
  return /* @__PURE__ */ jsxRuntimeExports.jsxs(
    Modal,
    {
      open: true,
      title: mode === "create" ? "新建快速命令" : `编辑「${command?.name ?? ""}」`,
      subtitle: "支持参数占位符与变量占位符（含格式）；动态变量见下方辅助面板",
      onClose,
      footer: /* @__PURE__ */ jsxRuntimeExports.jsxs(jsxRuntimeExports.Fragment, { children: [
        /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "form-footer-hint", children: lineCount > 1 ? `${lineCount} 行 —— 执行时逐行发送` : "单行命令" }),
        /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "t-modal__footer-spacer" }),
        /* @__PURE__ */ jsxRuntimeExports.jsx(Button, { variant: "ghost", onClick: onClose, children: "取消" }),
        /* @__PURE__ */ jsxRuntimeExports.jsx(Button, { variant: "primary", loading: saving, onClick: () => void submit(), children: mode === "create" ? "创建" : "保存" })
      ] }),
      children: [
        /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "t-grid t-grid--2", children: [
          /* @__PURE__ */ jsxRuntimeExports.jsx(Field, { label: "名称", required: true, error: err, children: /* @__PURE__ */ jsxRuntimeExports.jsx(
            TextInput,
            {
              value: name,
              autoFocus: true,
              placeholder: "例如：查看磁盘占用",
              onChange: (e) => {
                setName(e.target.value);
                setErr(null);
              }
            }
          ) }),
          /* @__PURE__ */ jsxRuntimeExports.jsx(Field, { label: "分组", children: /* @__PURE__ */ jsxRuntimeExports.jsx(
            Select,
            {
              value: targetGroup,
              onChange: (e) => setTargetGroup(e.target.value),
              options: [
                { value: "", label: "（未分组）" },
                ...groups.map((g) => ({ value: g.id, label: g.name }))
              ]
            }
          ) }),
          /* @__PURE__ */ jsxRuntimeExports.jsx(
            Field,
            {
              label: "命令内容",
              required: true,
              className: "t-grid__span2",
              hint: "多行会在执行时逐行发送；换行即分次输入",
              aside: /* @__PURE__ */ jsxRuntimeExports.jsx(Button, { size: "sm", variant: "ghost", icon: "zap", onClick: () => setShowVars((v) => !v), children: showVars ? "收起变量" : "变量辅助" }),
              children: /* @__PURE__ */ jsxRuntimeExports.jsx(
                TextArea,
                {
                  ref: areaRef,
                  className: "note-editor__body",
                  style: { minHeight: 130 },
                  value: body,
                  mono: true,
                  placeholder: "例如：\ncd ${{目录}}\nls -lh",
                  onChange: (e) => setBody(e.target.value)
                }
              )
            }
          ),
          /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "t-grid__span2", children: [
            /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "t-field__label", style: { marginBottom: 5 }, children: [
              "识别到的占位符",
              paramNames.length > 0 ? /* @__PURE__ */ jsxRuntimeExports.jsxs(Badge, { tone: "accent", children: [
                paramNames.length,
                " 个参数"
              ] }) : null,
              varTags.length > 0 ? /* @__PURE__ */ jsxRuntimeExports.jsxs(Badge, { tone: "ok", children: [
                varTags.length,
                " 个变量"
              ] }) : null
            ] }),
            /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "qc-edit__param-preview", children: [
              !tags || tags.tags.length === 0 ? /* @__PURE__ */ jsxRuntimeExports.jsxs("span", { className: "t-field__hint", children: [
                "还没有占位符。用 ",
                PARAM_SYNTAX,
                " 表示参数，用 ",
                VAR_SYNTAX,
                " 表示动态变量。"
              ] }) : tags.tags.map((t, i) => /* @__PURE__ */ jsxRuntimeExports.jsxs("span", { className: `qc-tag qc-tag--${t.kind === "parameter" ? "param" : "var"}`, children: [
                t.kind === "parameter" ? "参数" : "变量",
                " ",
                t.name,
                t.format ? `:${t.format}` : ""
              ] }, `${t.raw}-${i}`)),
              tags?.hasUnclosed ? /* @__PURE__ */ jsxRuntimeExports.jsxs("span", { className: "qc-tag qc-tag--bad", children: [
                "有未闭合的 ",
                OPEN_BRACE2
              ] }) : null
            ] })
          ] }),
          showVars ? /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "t-grid__span2", children: [
            /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "t-field__label", style: { marginBottom: 5 }, children: "动态变量（点击插入）" }),
            /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "qc-vars", children: vars.length === 0 ? /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "t-field__hint", children: "没有可用变量（变量服务未就绪）。" }) : vars.map((v) => /* @__PURE__ */ jsxRuntimeExports.jsxs(
              "button",
              {
                type: "button",
                className: "qc-var",
                title: `${v.description}${v.format ? ` · 格式 ${v.format}` : ""}`,
                onClick: () => insert(`\${{${v.name}}}`),
                children: [
                  /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "qc-var__name", children: `\${{${v.name}}}` }),
                  /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "qc-var__desc", children: v.description }),
                  /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: `qc-var__value${v.hasValue ? "" : " qc-var__value--none"}`, children: v.hasValue ? v.value : "（当前无值）" }),
                  v.masked ? /* @__PURE__ */ jsxRuntimeExports.jsx(Badge, { tone: "warn", children: "已打码" }) : null
                ]
              },
              v.name
            )) })
          ] }) : null,
          /* @__PURE__ */ jsxRuntimeExports.jsx(Field, { label: "备注", className: "t-grid__span2", children: /* @__PURE__ */ jsxRuntimeExports.jsx(TextInput, { value: note, onChange: (e) => setNote(e.target.value) }) })
        ] }),
        tags?.hasUnclosed ? /* @__PURE__ */ jsxRuntimeExports.jsx("div", { style: { marginTop: 12 }, children: /* @__PURE__ */ jsxRuntimeExports.jsxs(Banner, { tone: "warn", children: [
          "命令里有未闭合的 ",
          /* @__PURE__ */ jsxRuntimeExports.jsx("code", { className: "mono", children: OPEN_BRACE2 }),
          "—— 这样的片段不会被当作占位符替换，会原样发送。请补上两个右花括号。"
        ] }) }) : null,
        /* @__PURE__ */ jsxRuntimeExports.jsxs("p", { className: "t-field__hint", style: { marginTop: 12 }, children: [
          /* @__PURE__ */ jsxRuntimeExports.jsx(Icon, { name: "info", size: 12 }),
          " 变量在**执行时**才求值（时间、主机名、剪贴板等）， 所以命令里存的是占位符而不是当时的值。"
        ] })
      ]
    }
  );
}
function ParamDialog({
  commandId,
  name,
  mode,
  sessionId,
  sessionKind,
  onClose,
  onDone
}) {
  const [data, setData] = reactExports.useState(null);
  const [values, setValues] = reactExports.useState({});
  const [preview, setPreview] = reactExports.useState(null);
  const [busy, setBusy] = reactExports.useState(false);
  const [err, setErr] = reactExports.useState(null);
  reactExports.useEffect(() => {
    void (async () => {
      try {
        const d = await quickcmd.parameterDialog({ commandId });
        setData(d);
        setValues({ ...d.recentValues ?? {} });
      } catch (e) {
        setErr(errorText(e));
      }
    })();
  }, [commandId]);
  reactExports.useEffect(() => {
    void quickcmd.render({ commandId, params: values }).then(setPreview).catch(() => setPreview(null));
  }, [commandId, values]);
  const missing = reactExports.useMemo(
    () => (preview?.missingParams ?? data?.parameters ?? []).filter((p) => !values[p]?.trim()),
    [preview, data, values]
  );
  const confirm = reactExports.useCallback(async () => {
    if (missing.length > 0) {
      toast.warn(`还有 ${missing.length} 个参数没填：${missing.join("、")}`);
      return;
    }
    setBusy(true);
    try {
      if (mode === "execute") {
        const res = await quickcmd.execute({ sessionId, commandId, params: values });
        await onDone(`已发送「${name}」：${res?.sent ?? 0} 行（逐行发送）`);
      } else {
        const res = await quickcmd.paste({ commandId, params: values });
        await writeToSession(sessionKind, sessionId, res?.text ?? "");
        await onDone(`已粘贴到终端输入框（未执行）：「${name}」`);
      }
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  }, [missing, mode, sessionId, commandId, values, name, sessionKind, onDone]);
  return /* @__PURE__ */ jsxRuntimeExports.jsxs(
    Modal,
    {
      open: true,
      size: "md",
      title: `填写参数 · ${name}`,
      subtitle: mode === "execute" ? "填完后逐行发送到当前会话" : "填完后只粘贴到输入框，不会执行",
      onClose,
      footer: /* @__PURE__ */ jsxRuntimeExports.jsxs(jsxRuntimeExports.Fragment, { children: [
        missing.length > 0 ? /* @__PURE__ */ jsxRuntimeExports.jsxs("span", { className: "t-field__error", children: [
          "还缺 ",
          missing.join("、")
        ] }) : /* @__PURE__ */ jsxRuntimeExports.jsxs("span", { className: "form-footer-hint", children: [
          preview?.lines.length ?? 0,
          " 行"
        ] }),
        /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "t-modal__footer-spacer" }),
        /* @__PURE__ */ jsxRuntimeExports.jsx(Button, { variant: "ghost", onClick: onClose, children: "取消" }),
        /* @__PURE__ */ jsxRuntimeExports.jsx(Button, { variant: "primary", loading: busy, disabled: missing.length > 0, onClick: () => void confirm(), children: mode === "execute" ? "发送" : "粘贴" })
      ] }),
      children: [
        err ? /* @__PURE__ */ jsxRuntimeExports.jsx("div", { style: { marginBottom: 12 }, children: /* @__PURE__ */ jsxRuntimeExports.jsx(Banner, { tone: "error", children: err }) }) : null,
        !data ? /* @__PURE__ */ jsxRuntimeExports.jsx(Loading, { text: "读取参数…" }) : data.parameters.length === 0 ? /* @__PURE__ */ jsxRuntimeExports.jsx("p", { className: "t-field__hint", children: "这条命令没有参数，直接执行即可。" }) : /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "t-grid", children: data.parameters.map((p) => {
          const history = data.history?.[p] ?? [];
          return /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { children: [
            /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "qc-param-row", children: [
              /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "qc-param-row__name", children: `\${{${p}}}` }),
              /* @__PURE__ */ jsxRuntimeExports.jsx(Field, { label: "", hint: "", children: /* @__PURE__ */ jsxRuntimeExports.jsx(
                TextInput,
                {
                  value: values[p] ?? "",
                  autoFocus: p === data.parameters[0],
                  placeholder: data.recentValues?.[p] ? `上次：${data.recentValues[p]}` : `填写 ${p}`,
                  onChange: (e) => setValues((v) => ({ ...v, [p]: e.target.value })),
                  onKeyDown: (e) => {
                    if (e.key === "Enter" && missing.length === 0) void confirm();
                  }
                }
              ) })
            ] }),
            history.length > 0 ? /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "qc-param-history", children: [
              /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "t-field__hint", children: "历史：" }),
              history.slice(0, 6).map((h) => /* @__PURE__ */ jsxRuntimeExports.jsx("button", { type: "button", onClick: () => setValues((v) => ({ ...v, [p]: h })), children: h }, h))
            ] }) : null
          ] }, p);
        }) }),
        preview ? /* @__PURE__ */ jsxRuntimeExports.jsxs(jsxRuntimeExports.Fragment, { children: [
          /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "t-field__label", style: { marginTop: 16, marginBottom: 5 }, children: [
            "渲染预览",
            preview.variables.length > 0 ? /* @__PURE__ */ jsxRuntimeExports.jsxs(Badge, { tone: "ok", children: [
              preview.variables.length,
              " 个变量已求值"
            ] }) : null,
            preview.lines.length > 1 ? /* @__PURE__ */ jsxRuntimeExports.jsxs(Badge, { tone: "accent", children: [
              preview.lines.length,
              " 行"
            ] }) : null
          ] }),
          /* @__PURE__ */ jsxRuntimeExports.jsx("pre", { className: "qc-preview", children: preview.text || "（空）" }),
          preview.variables.some((v) => v.masked) ? /* @__PURE__ */ jsxRuntimeExports.jsx("p", { className: "t-field__hint", children: "预览里的机密变量（如 password）是打码后的显示值；**实际发送时会用真实值**。" }) : null
        ] }) : null
      ]
    }
  );
}
function QuickCommandPanel() {
  const { sessionId, kind } = useStoreShallow((s) => {
    const tab = s.tabs.find((t) => t.tabId === s.activeTabId);
    return { sessionId: tab?.sessionId, kind: tab?.kind ?? "ssh" };
  });
  const [tree, setTree] = reactExports.useState([]);
  const [totals, setTotals] = reactExports.useState({ commands: 0, groups: 0 });
  const [loading, setLoading] = reactExports.useState(true);
  const [error, setError] = reactExports.useState(null);
  const [query, setQuery] = reactExports.useState("");
  const [results, setResults] = reactExports.useState([]);
  const [expanded, setExpanded] = reactExports.useState(/* @__PURE__ */ new Set());
  const [menu, setMenu] = reactExports.useState(null);
  const [editor, setEditor] = reactExports.useState(null);
  const [paramFor, setParamFor] = reactExports.useState(null);
  const [groupDialog, setGroupDialog] = reactExports.useState(
    null
  );
  const [deleteGroup, setDeleteGroup] = reactExports.useState(null);
  const [dropTarget, setDropTarget] = reactExports.useState(null);
  const dragRef = reactExports.useRef(null);
  const reload = reactExports.useCallback(async () => {
    try {
      const res = await quickcmd.list();
      const roots = res?.tree?.roots;
      setTree(Array.isArray(roots) ? roots : []);
      setTotals({
        commands: res?.tree?.totalCommands ?? 0,
        groups: res?.tree?.totalGroups ?? 0
      });
      setError(null);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setLoading(false);
    }
  }, []);
  reactExports.useEffect(() => {
    void reload();
  }, [reload]);
  reactExports.useEffect(() => {
    const q = query.trim();
    if (!q) {
      setResults([]);
      return;
    }
    const t = window.setTimeout(() => {
      void quickcmd.search(q).then((r) => setResults(r ?? [])).catch(() => setResults([]));
    }, 200);
    return () => window.clearTimeout(t);
  }, [query]);
  const hasParams = (command) => /\$\{\{/.test(command);
  const runCommand = reactExports.useCallback(
    async (node, mode) => {
      if (!sessionId) {
        toast.warn("先打开一个会话，快速命令需要发送到终端");
        return;
      }
      if (hasParams(node.command)) {
        setParamFor({ commandId: node.id, name: node.name, mode });
        return;
      }
      const lines = node.command.split("\n").filter((l) => l.trim() !== "");
      try {
        if (mode === "execute") {
          const res = await quickcmd.execute({ sessionId, commandId: node.id });
          toast.ok(`已发送「${node.name}」：${res?.sent ?? lines.length} 行（逐行发送）`);
        } else {
          const res = await quickcmd.paste({ commandId: node.id });
          await writeToSession(kind, sessionId, res?.text ?? node.command);
          toast.ok(`已粘贴到终端输入框（未执行）：${res?.lines.length ?? lines.length} 行`);
        }
      } catch (err) {
        toast.error(`${mode === "execute" ? "执行" : "粘贴"}失败：${errorText(err)}`);
      }
    },
    [sessionId, kind]
  );
  const removeCommand = reactExports.useCallback(
    async (node) => {
      try {
        await quickcmd.remove([node.id]);
        toast.ok(`已删除「${node.name}」`);
        await reload();
      } catch (err) {
        toast.error(`删除失败：${errorText(err)}`);
      }
    },
    [reload]
  );
  const askDeleteGroup = reactExports.useCallback(async (group) => {
    try {
      const preview = await quickcmd.previewGroupDelete(group.id);
      setDeleteGroup({ group, preview });
    } catch (err) {
      toast.error(`读取待删内容失败：${errorText(err)}`);
    }
  }, []);
  const onDrop = reactExports.useCallback(
    async (target) => {
      const drag = dragRef.current;
      dragRef.current = null;
      setDropTarget(null);
      if (!drag || drag.kind === target.kind && drag.id === target.id) return;
      try {
        if (drag.kind === "command") {
          if (target.kind === "group") {
            await quickcmd.move({ kind: "command", id: drag.id, targetId: target.id });
          } else {
            const parent = findParentId(tree, target.id);
            await quickcmd.move({ kind: "command", id: drag.id, targetId: parent, index: indexOf(tree, target.id) });
          }
        } else {
          if (target.kind !== "group") return;
          await quickcmd.move({ kind: "group", id: drag.id, targetId: target.id });
        }
        await reload();
      } catch (err) {
        toast.error(`移动失败：${errorText(err)}`);
      }
    },
    [tree, reload]
  );
  const menuItems = (node) => {
    if (node.kind === "group") {
      return [
        { id: "newcmd", label: "在此分组新建命令", icon: "plus", onSelect: () => setEditor({ mode: "create", groupId: node.id }) },
        { id: "newsub", label: "新建子分组", icon: "folder", onSelect: () => setGroupDialog({ parentId: node.id }) },
        {
          id: "rename",
          label: "重命名分组",
          icon: "edit",
          separatorBefore: true,
          onSelect: () => setGroupDialog({ parentId: node.parentId, group: node })
        },
        { id: "del", label: "删除分组…", icon: "trash", danger: true, onSelect: () => void askDeleteGroup(node) }
      ];
    }
    return [
      { id: "run", label: "立即执行", icon: "zap", onSelect: () => void runCommand(node, "execute") },
      { id: "paste", label: "粘贴到终端（不执行）", icon: "download", onSelect: () => void runCommand(node, "paste") },
      {
        id: "copy",
        label: "复制命令",
        icon: "copy",
        onSelect: () => {
          void navigator.clipboard.writeText(node.command);
          toast.ok("命令已复制到剪贴板");
        }
      },
      {
        id: "edit",
        label: "编辑",
        icon: "edit",
        separatorBefore: true,
        onSelect: () => setEditor({ mode: "edit", groupId: node.groupId, command: toRecord(node) })
      },
      { id: "del", label: "删除命令", icon: "trash", danger: true, onSelect: () => void removeCommand(node) }
    ];
  };
  const searchMode = query.trim().length > 0;
  const nodes = reactExports.useMemo(
    () => searchMode ? [] : flatten(tree, expanded),
    [tree, expanded, searchMode]
  );
  return /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "qc", children: [
    /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "qc__search", children: /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "t-search", style: { maxWidth: "100%" }, children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "t-search__icon", children: /* @__PURE__ */ jsxRuntimeExports.jsx(Icon, { name: "search", size: 14 }) }),
      /* @__PURE__ */ jsxRuntimeExports.jsx(
        "input",
        {
          className: "t-input",
          value: query,
          placeholder: "搜索命令或拼音首字母（qd → 前端）",
          "aria-label": "搜索快速命令",
          onChange: (e) => setQuery(e.target.value)
        }
      ),
      query ? /* @__PURE__ */ jsxRuntimeExports.jsx(IconButton, { className: "t-search__clear", icon: "close", label: "清空", onClick: () => setQuery("") }) : null
    ] }) }),
    /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "qc__body", children: error ? /* @__PURE__ */ jsxRuntimeExports.jsx("div", { style: { padding: 8 }, children: /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "t-banner t-banner--error", children: error }) }) : loading ? /* @__PURE__ */ jsxRuntimeExports.jsx(Loading, { text: "读取快速命令…" }) : searchMode ? results.length === 0 ? /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "qc__empty", children: [
      "没有匹配「",
      query.trim(),
      "」的命令"
    ] }) : /* @__PURE__ */ jsxRuntimeExports.jsxs(jsxRuntimeExports.Fragment, { children: [
      /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "qc__empty", style: { textAlign: "left", padding: "6px 8px" }, children: [
        results.length,
        " 条结果（支持拼音首字母）"
      ] }),
      results.map((r) => /* @__PURE__ */ jsxRuntimeExports.jsxs(
        "button",
        {
          type: "button",
          className: "qc-row",
          title: r.command,
          onClick: () => void runCommand(r, "execute"),
          onContextMenu: (e) => {
            e.preventDefault();
            setMenu({ x: e.clientX, y: e.clientY, node: toNode(r) });
          },
          children: [
            /* @__PURE__ */ jsxRuntimeExports.jsx(Icon, { name: "zap", size: 13 }),
            /* @__PURE__ */ jsxRuntimeExports.jsxs("span", { className: "qc-row__label", children: [
              r.name,
              r.groupPath.length > 0 ? /* @__PURE__ */ jsxRuntimeExports.jsxs("span", { className: "qc-row__count", children: [
                " · ",
                r.groupPath.join(" / ")
              ] }) : null
            ] }),
            r.command.includes("\n") ? /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "qc-row__multi", children: "多行" }) : null,
            hasParams(r.command) ? /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "qc-row__param", children: "参数" }) : null
          ]
        },
        r.id
      ))
    ] }) : nodes.length === 0 ? /* @__PURE__ */ jsxRuntimeExports.jsx(
      EmptyState,
      {
        icon: "zap",
        title: "还没有快速命令",
        text: "把常用的排查命令存进来，之后一键发送到当前会话。支持分组、多行、${{参数}} 与动态变量。",
        actions: /* @__PURE__ */ jsxRuntimeExports.jsxs(jsxRuntimeExports.Fragment, { children: [
          /* @__PURE__ */ jsxRuntimeExports.jsx(Button, { variant: "primary", icon: "plus", onClick: () => setEditor({ mode: "create", groupId: null }), children: "新建命令" }),
          /* @__PURE__ */ jsxRuntimeExports.jsx(Button, { variant: "outline", icon: "folder", onClick: () => setGroupDialog({ parentId: null }), children: "新建分组" })
        ] })
      }
    ) : nodes.map(({ node, depth }) => /* @__PURE__ */ jsxRuntimeExports.jsx(
      TreeRow,
      {
        node,
        depth,
        expanded: expanded.has(node.id),
        dropTarget,
        onToggle: () => setExpanded((prev) => {
          const next = new Set(prev);
          if (next.has(node.id)) next.delete(node.id);
          else next.add(node.id);
          return next;
        }),
        onRun: () => {
          if (node.kind === "command") void runCommand(node, "execute");
        },
        onContextMenu: (x, y) => setMenu({ x, y, node }),
        onDragStart: () => {
          dragRef.current = { kind: node.kind, id: node.id };
        },
        onDragOver: (position) => {
          const drag = dragRef.current;
          if (!drag) return;
          if (drag.id === node.id) return;
          setDropTarget({ kind: node.kind, id: node.id, position });
        },
        onDrop: () => {
          const pos = dropTarget;
          if (pos) void onDrop(pos);
        },
        onDragEnd: () => {
          dragRef.current = null;
          setDropTarget(null);
        }
      },
      node.id
    )) }),
    /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "panel-footer", children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx(IconButton, { icon: "folder", label: "新建分组", onClick: () => setGroupDialog({ parentId: null }) }),
      /* @__PURE__ */ jsxRuntimeExports.jsx(
        Button,
        {
          size: "sm",
          variant: "outline",
          icon: "plus",
          style: { flex: 1 },
          onClick: () => setEditor({ mode: "create", groupId: null }),
          children: "新建命令"
        }
      )
    ] }),
    /* @__PURE__ */ jsxRuntimeExports.jsx(
      ContextMenu,
      {
        open: menu !== null,
        x: menu?.x ?? 0,
        y: menu?.y ?? 0,
        items: menu ? menuItems(menu.node) : [],
        onClose: () => setMenu(null)
      }
    ),
    editor ? /* @__PURE__ */ jsxRuntimeExports.jsx(
      QuickCommandEditor,
      {
        mode: editor.mode,
        groupId: editor.groupId,
        ...editor.command === void 0 ? {} : { command: editor.command },
        onClose: () => setEditor(null),
        onSaved: async () => {
          setEditor(null);
          await reload();
        }
      }
    ) : null,
    groupDialog ? /* @__PURE__ */ jsxRuntimeExports.jsx(
      GroupDialog,
      {
        parentId: groupDialog.parentId,
        ...groupDialog.group === void 0 ? {} : { group: groupDialog.group },
        onClose: () => setGroupDialog(null),
        onSaved: async () => {
          setGroupDialog(null);
          await reload();
        }
      }
    ) : null,
    paramFor ? /* @__PURE__ */ jsxRuntimeExports.jsx(
      ParamDialog,
      {
        commandId: paramFor.commandId,
        name: paramFor.name,
        mode: paramFor.mode,
        sessionId: sessionId ?? "",
        sessionKind: kind,
        onClose: () => setParamFor(null),
        onDone: async (msg) => {
          setParamFor(null);
          toast.ok(msg);
          await reload();
        }
      }
    ) : null,
    /* @__PURE__ */ jsxRuntimeExports.jsxs(
      Modal,
      {
        open: deleteGroup !== null,
        size: "sm",
        title: "删除分组",
        onClose: () => setDeleteGroup(null),
        footer: /* @__PURE__ */ jsxRuntimeExports.jsxs(jsxRuntimeExports.Fragment, { children: [
          /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "t-modal__footer-spacer" }),
          /* @__PURE__ */ jsxRuntimeExports.jsx(Button, { variant: "ghost", onClick: () => setDeleteGroup(null), children: "取消" }),
          /* @__PURE__ */ jsxRuntimeExports.jsx(
            Button,
            {
              variant: "danger",
              onClick: async () => {
                if (!deleteGroup) return;
                try {
                  const res = await quickcmd.deleteGroup(deleteGroup.group.id);
                  toast.ok(`已删除 ${res.removedGroups} 个分组、${res.removedCommands} 条命令`);
                  setDeleteGroup(null);
                  await reload();
                } catch (err) {
                  toast.error(`删除失败：${errorText(err)}`);
                }
              },
              children: "确认删除"
            }
          )
        ] }),
        children: [
          /* @__PURE__ */ jsxRuntimeExports.jsxs("p", { className: "t-field__hint", style: { marginTop: 0 }, children: [
            "将删除分组 ",
            /* @__PURE__ */ jsxRuntimeExports.jsx("b", { children: deleteGroup?.group.name }),
            deleteGroup && deleteGroup.group.children.length > 0 ? " 及其子分组" : "",
            "。"
          ] }),
          /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "t-banner t-banner--warn", style: { marginTop: 8 }, children: [
            "⚠️ 会**同时删除组内所有命令**：将删除 ",
            /* @__PURE__ */ jsxRuntimeExports.jsx("b", { children: deleteGroup?.preview.groups ?? 0 }),
            " 个分组、",
            /* @__PURE__ */ jsxRuntimeExports.jsx("b", { children: deleteGroup?.preview.commands ?? 0 }),
            " 条命令。此操作不可撤销。"
          ] })
        ]
      }
    )
  ] });
}
function TreeRow({
  node,
  depth,
  expanded,
  dropTarget,
  onToggle,
  onRun,
  onContextMenu,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd
}) {
  const isGroup = node.kind === "group";
  const dropClass = dropTarget && dropTarget.id === node.id ? dropTarget.position === "into" ? " qc-row--drop-into" : " qc-row--drop-before" : "";
  return /* @__PURE__ */ jsxRuntimeExports.jsxs(
    "button",
    {
      type: "button",
      className: `qc-row${dropClass}`,
      style: { paddingLeft: 7 + depth * 13 },
      draggable: true,
      title: isGroup ? node.name : node.command,
      onClick: () => isGroup ? onToggle() : void onRun(),
      onDoubleClick: () => {
        onContextMenu(0, 0);
      },
      onContextMenu: (e) => {
        e.preventDefault();
        onContextMenu(e.clientX, e.clientY);
      },
      onDragStart,
      onDragOver: (e) => {
        e.preventDefault();
        const r = e.currentTarget.getBoundingClientRect();
        const intoGroup = isGroup && e.clientY - r.top > r.height / 2;
        onDragOver(intoGroup ? "into" : "before");
      },
      onDrop: (e) => {
        e.preventDefault();
        onDrop();
      },
      onDragEnd,
      children: [
        /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: `qc-row__twisty${isGroup ? "" : " tree__twisty--leaf"}`, "aria-hidden": true, children: isGroup ? /* @__PURE__ */ jsxRuntimeExports.jsx(Icon, { name: expanded ? "chevron-down" : "chevron-right", size: 12 }) : null }),
        /* @__PURE__ */ jsxRuntimeExports.jsx(Icon, { name: isGroup ? "folder" : "zap", size: 13 }),
        /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "qc-row__label", children: node.name }),
        isGroup ? /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "qc-row__count", children: node.commandCount }) : null,
        !isGroup && node.command.includes("\n") ? /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "qc-row__multi", children: "多行" }) : null,
        !isGroup && /\$\{\{/.test(node.command) ? /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "qc-row__param", children: "参数" }) : null
      ]
    }
  );
}
function flatten(nodes, expanded, depth = 0) {
  const out = [];
  for (const n of nodes) {
    out.push({ node: n, depth });
    if (n.kind === "group" && expanded.has(n.id)) out.push(...flatten(n.children, expanded, depth + 1));
  }
  return out;
}
function findParentId(nodes, id, parent = null) {
  for (const n of nodes) {
    if (n.id === id) return parent;
    if (n.kind === "group") {
      const found = findParentId(n.children, id, n.id);
      if (found !== null) return found;
    }
  }
  return parent;
}
function indexOf(nodes, id) {
  const i = nodes.findIndex((n) => n.id === id);
  return i < 0 ? 0 : i;
}
function toNode(c) {
  return {
    kind: "command",
    id: c.id,
    name: c.name,
    command: c.command,
    ...c.note === void 0 ? {} : { note: c.note },
    order: c.order,
    groupId: c.groupId
  };
}
function toRecord(n) {
  return {
    id: n.id,
    groupId: n.groupId,
    name: n.name,
    command: n.command,
    ...n.note === void 0 ? {} : { note: n.note },
    order: n.order,
    createdAt: "",
    updatedAt: ""
  };
}
function GroupDialog({
  parentId,
  group,
  onClose,
  onSaved
}) {
  const [name, setName] = reactExports.useState(group?.name ?? "");
  const [err, setErr] = reactExports.useState(null);
  const submit = async () => {
    if (!name.trim()) {
      setErr("分组名不能为空");
      return;
    }
    try {
      await quickcmd.saveGroup({
        ...group ? { id: group.id } : {},
        parentId: group ? group.parentId : parentId,
        name: name.trim()
      });
      await onSaved();
    } catch (e) {
      setErr(errorText(e));
    }
  };
  return /* @__PURE__ */ jsxRuntimeExports.jsx(
    Modal,
    {
      open: true,
      size: "sm",
      title: group ? "重命名分组" : "新建分组",
      onClose,
      footer: /* @__PURE__ */ jsxRuntimeExports.jsxs(jsxRuntimeExports.Fragment, { children: [
        /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "t-modal__footer-spacer" }),
        /* @__PURE__ */ jsxRuntimeExports.jsx(Button, { variant: "ghost", onClick: onClose, children: "取消" }),
        /* @__PURE__ */ jsxRuntimeExports.jsx(Button, { variant: "primary", onClick: () => void submit(), children: group ? "保存" : "创建" })
      ] }),
      children: /* @__PURE__ */ jsxRuntimeExports.jsx(Field, { label: "分组名称", required: true, error: err, children: /* @__PURE__ */ jsxRuntimeExports.jsx(
        TextInput,
        {
          value: name,
          autoFocus: true,
          placeholder: "例如：前端 / 数据库运维",
          onChange: (e) => {
            setName(e.target.value);
            setErr(null);
          },
          onKeyDown: (e) => {
            if (e.key === "Enter") void submit();
          }
        }
      ) })
    }
  );
}
export {
  QuickCommandPanel,
  QuickCommandPanel as default
};
