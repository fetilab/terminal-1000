import { Z as getConnection, r as reactExports, u as useStoreShallow, i as invoke, j as jsxRuntimeExports, f as Banner, ai as Section, G as Switch, F as Field, ag as TextArea, z as Select, T as TextInput, B as Badge, I as Icon, n as IconButton, h as Button, a as actions, t as toast, aB as saveConnection, az as newConnectionId, M as Modal, x as connectionAddress, C as Checkbox, e as errorText } from "./index-CwfghMy4.js";
import "./ConnectionsSidebar-ByKnWd2L.js";
const SSH_AUTH_TYPES = [
  "password",
  "privateKey",
  "identity",
  "keyboardInteractive",
  "keyboard"
];
const DEFAULT_PORTS = { telnet: 23, rdp: 3389, vnc: 5900, tunnel: 0 };
const KIND_LABEL = {
  telnet: "Telnet",
  rdp: "RDP",
  vnc: "VNC",
  tunnel: "隧道"
};
const GROUPS_FIELD = {
  path: "groupId",
  label: "分组",
  kind: "select",
  source: "groups"
};
function commonSections(kind) {
  return [
    {
      title: "基本信息",
      fields: [
        { path: "name", label: "名称", kind: "text", required: true, placeholder: "例如：core-switch-01" },
        GROUPS_FIELD,
        {
          path: "host",
          label: "主机地址",
          kind: "text",
          required: true,
          placeholder: "10.0.0.5 或 device.internal"
        },
        {
          path: "port",
          label: "端口",
          kind: "number",
          required: true,
          min: 1,
          max: 65535,
          placeholder: String(DEFAULT_PORTS[kind])
        },
        { path: "note", label: "备注", kind: "textarea", wide: true }
      ]
    }
  ];
}
const SPECS = {
  telnet: [
    ...commonSections("telnet"),
    {
      title: "登录（设备需要时再填）",
      fields: [
        {
          path: "username",
          label: "用户名",
          kind: "text",
          hint: "多数网络设备是连上后再交互输入，这里可留空"
        },
        { path: "password", label: "密码", kind: "password" }
      ]
    },
    {
      title: "连接选项",
      fields: [
        { path: "options.timeoutMs", label: "连接超时 (ms)", kind: "number", min: 1e3, max: 6e5, step: 1e3 },
        {
          path: "options.term",
          label: "终端类型 TERM",
          kind: "text",
          hint: "对端请求 TTYPE 时回答的值",
          placeholder: "xterm-256color"
        },
        { path: "options.cols", label: "初始列数", kind: "number", min: 20, max: 500 },
        { path: "options.rows", label: "初始行数", kind: "number", min: 5, max: 300 }
      ]
    }
  ],
  rdp: [
    ...commonSections("rdp"),
    {
      title: "登录",
      fields: [
        { path: "username", label: "用户名", kind: "text", required: true },
        { path: "password", label: "密码", kind: "password", hint: "留空则连接时再问" },
        { path: "domain", label: "域 / WORKGROUP", kind: "text", placeholder: "AD 域或 WORKGROUP" }
      ]
    },
    {
      title: "显示",
      fields: [
        {
          path: "displayMode",
          label: "显示模式",
          kind: "select",
          options: [
            { value: "follow-window", label: "跟随窗口" },
            { value: "fixed-resolution", label: "固定分辨率" }
          ]
        },
        {
          path: "width",
          label: "宽度 (px)",
          kind: "number",
          min: 320,
          max: 8192,
          when: (d) => d.displayMode === "fixed-resolution"
        },
        {
          path: "height",
          label: "高度 (px)",
          kind: "number",
          min: 240,
          max: 8192,
          when: (d) => d.displayMode === "fixed-resolution"
        },
        {
          path: "quality",
          label: "画质",
          kind: "select",
          options: [
            { value: "low", label: "低（省带宽）" },
            { value: "balanced", label: "均衡" },
            { value: "high", label: "高" }
          ]
        },
        { path: "clipboardShare", label: "共享剪贴板（文本）", kind: "switch" }
      ]
    }
  ],
  vnc: [
    ...commonSections("vnc"),
    {
      title: "认证",
      fields: [
        {
          path: "authType",
          label: "认证方式",
          kind: "select",
          options: [
            { value: "vnc-password", label: "VNC 密码" },
            { value: "none", label: "无认证" }
          ]
        },
        {
          path: "password",
          label: "密码",
          kind: "password",
          when: (d) => d.authType !== "none"
        }
      ]
    },
    {
      title: "会话行为",
      fields: [
        {
          path: "viewOnly",
          label: "只读（只看画面，不回送键鼠）",
          kind: "switch",
          hint: "开启后本机不会向远端发送任何键鼠事件 —— 适合旁观排障"
        },
        { path: "shared", label: "允许多客户端共享同一会话", kind: "switch" },
        { path: "scaleViewport", label: "缩放视口", kind: "switch" },
        { path: "clipViewport", label: "裁剪视口", kind: "switch" }
      ]
    },
    {
      title: "画质",
      fields: [
        {
          path: "qualityLevel",
          label: "清晰度 0–9",
          kind: "number",
          min: 0,
          max: 9,
          hint: "推荐 6；越大越清晰、越费带宽"
        },
        {
          path: "compressionLevel",
          label: "压缩强度 0–9",
          kind: "number",
          min: 0,
          max: 9,
          hint: "推荐 2；越大越省带宽、越吃 CPU"
        }
      ]
    }
  ],
  tunnel: [
    {
      title: "基本信息",
      fields: [
        { path: "name", label: "名称", kind: "text", required: true, placeholder: "例如：grafana-3000" },
        GROUPS_FIELD,
        {
          path: "serverId",
          label: "承载的 SSH 服务器",
          kind: "select",
          required: true,
          source: "sshConnections",
          hint: "隧道通过这台已配置的服务器转发；没有可选服务器时请先建一条 SSH 连接"
        },
        {
          path: "type",
          label: "转发类型",
          kind: "select",
          options: [
            { value: "local", label: "本地转发（-L）：本机端口 → 远端可达的目标" },
            { value: "remote", label: "远程转发（-R）：远端端口 → 本机可达的目标" },
            { value: "dynamic", label: "动态代理（-D，SOCKS5）" }
          ]
        }
      ]
    },
    {
      title: "监听与目标",
      fields: [
        { path: "localHost", label: "本地监听地址", kind: "text", placeholder: "127.0.0.1" },
        { path: "localPort", label: "本地监听端口", kind: "number", required: true, min: 1, max: 65535 },
        {
          path: "remoteHost",
          label: "远端主机",
          kind: "text",
          placeholder: "127.0.0.1",
          when: (d) => d.type !== "dynamic"
        },
        {
          path: "remotePort",
          label: "远端端口",
          kind: "number",
          min: 1,
          max: 65535,
          when: (d) => d.type !== "dynamic"
        }
      ]
    },
    {
      title: "其他",
      fields: [
        { path: "autoReconnect", label: "断开后自动重连", kind: "switch" },
        { path: "note", label: "备注", kind: "textarea", wide: true }
      ]
    }
  ]
};
function readPath(obj, path) {
  let cur = obj;
  for (const part of path.split(".")) {
    if (typeof cur !== "object" || cur === null) return void 0;
    cur = cur[part];
  }
  return cur;
}
function assignPath(obj, path, value) {
  const parts = path.split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const key = parts[i] ?? "";
    if (typeof cur[key] !== "object" || cur[key] === null) cur[key] = {};
    cur = cur[key];
  }
  cur[parts[parts.length - 1] ?? ""] = value;
}
function draftFrom(kind, existing) {
  const d = {};
  if (!existing) {
    assignPath(d, "name", "");
    assignPath(d, "groupId", "");
    assignPath(d, "host", "");
    assignPath(d, "port", DEFAULT_PORTS[kind]);
    assignPath(d, "note", "");
    if (kind === "telnet") {
      assignPath(d, "username", "");
      assignPath(d, "password", "");
      assignPath(d, "options.timeoutMs", 2e4);
      assignPath(d, "options.term", "");
      assignPath(d, "options.cols", 80);
      assignPath(d, "options.rows", 24);
    }
    if (kind === "rdp") {
      assignPath(d, "username", "");
      assignPath(d, "displayMode", "follow-window");
      assignPath(d, "width", 1920);
      assignPath(d, "height", 1080);
      assignPath(d, "quality", "balanced");
      assignPath(d, "clipboardShare", true);
    }
    if (kind === "vnc") {
      assignPath(d, "authType", "vnc-password");
      assignPath(d, "scaleViewport", true);
      assignPath(d, "qualityLevel", 6);
      assignPath(d, "compressionLevel", 2);
    }
    if (kind === "tunnel") {
      assignPath(d, "type", "local");
      assignPath(d, "localHost", "127.0.0.1");
      assignPath(d, "localPort", "");
      assignPath(d, "remoteHost", "127.0.0.1");
      assignPath(d, "remotePort", "");
      assignPath(d, "autoReconnect", true);
    }
    return d;
  }
  const conn = existing;
  d.name = conn.name;
  d.groupId = conn.groupId ?? "";
  d.host = conn.host;
  d.port = conn.port;
  d.note = conn.note ?? "";
  if (kind === "telnet") {
    const c = existing;
    d.username = c.username ?? "";
    d.password = c.password ?? "";
    d["options.timeoutMs"] = c.options?.timeoutMs ?? 2e4;
    d["options.term"] = c.options?.term ?? "";
    d["options.cols"] = c.options?.cols ?? 80;
    d["options.rows"] = c.options?.rows ?? 24;
  }
  if (kind === "rdp") {
    d.username = conn.username ?? "";
    d.password = conn.password ?? "";
    d.domain = conn.domain ?? "";
    d.displayMode = conn.displayMode ?? "follow-window";
    d.width = conn.width ?? 1920;
    d.height = conn.height ?? 1080;
    d.quality = conn.quality ?? "balanced";
    d.clipboardShare = conn.clipboardShare ?? true;
  }
  if (kind === "vnc") {
    d.authType = conn.authType ?? "vnc-password";
    d.password = conn.password ?? "";
    d.viewOnly = conn.viewOnly ?? false;
    d.shared = conn.shared ?? false;
    d.scaleViewport = conn.scaleViewport ?? true;
    d.clipViewport = conn.clipViewport ?? false;
    d.qualityLevel = conn.qualityLevel ?? 6;
    d.compressionLevel = conn.compressionLevel ?? 2;
  }
  if (kind === "tunnel") {
    d.serverId = conn.serverId ?? "";
    d.type = conn.type ?? "local";
    d.localHost = conn.localHost ?? "127.0.0.1";
    d.localPort = conn.localPort ?? 0;
    d.remoteHost = conn.remoteHost ?? "127.0.0.1";
    d.remotePort = conn.remotePort ?? 0;
    d.autoReconnect = conn.autoReconnect ?? true;
  }
  return d;
}
const num$1 = (v) => {
  if (v === "" || v === void 0 || v === null) return void 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : void 0;
};
function ProtocolForm({ kind, existingId }) {
  const existing = existingId ? getConnection(existingId) : void 0;
  const [draft, setDraft] = reactExports.useState(() => draftFrom(kind, existing));
  const [errors, setErrors] = reactExports.useState({});
  const [saving, setSaving] = reactExports.useState(false);
  const [templates, setTemplates] = reactExports.useState([]);
  const [rules, setRules] = reactExports.useState(
    () => existing?.keyMapping?.rules ?? []
  );
  const [keyMappingEnabled, setKeyMappingEnabled] = reactExports.useState(
    () => existing?.keyMapping?.enabled ?? false
  );
  const [templateId, setTemplateId] = reactExports.useState(
    () => existing?.keyMapping?.template ?? "standard"
  );
  const { groups, connections } = useStoreShallow((s) => ({
    groups: s.groups,
    connections: s.connections
  }));
  reactExports.useEffect(() => {
    if (kind !== "telnet") return;
    void (async () => {
      try {
        const res = await invoke("telnet", "list", {});
        setTemplates(res?.templates ?? []);
      } catch {
        setTemplates([]);
      }
    })();
  }, [kind]);
  const set = reactExports.useCallback((path, value) => {
    setDraft((d) => {
      const next = { ...d };
      assignPath(next, path, value);
      return next;
    });
    setErrors((e) => {
      if (!e[path]) return e;
      const next = { ...e };
      delete next[path];
      return next;
    });
  }, []);
  const flatGroups = reactExports.useMemo(() => {
    const out = [];
    const walk = (nodes, depth) => {
      for (const n of nodes) {
        out.push({ value: n.id, label: `${"　".repeat(depth)}${n.name}` });
        walk(n.children, depth + 1);
      }
    };
    walk(groups, 0);
    return out;
  }, [groups]);
  const sshConnections = reactExports.useMemo(
    () => connections.filter((c) => c.kind === "ssh").map((c) => ({ value: c.id, label: `${c.name} (${c.host})` })),
    [connections]
  );
  const optionsFor = (f) => {
    if (f.options) return f.options;
    if (f.source === "groups") return [{ value: "", label: "（未分组）" }, ...flatGroups];
    if (f.source === "sshConnections")
      return [{ value: "", label: sshConnections.length ? "（选择服务器）" : "（没有可用的 SSH 连接）" }, ...sshConnections];
    return [];
  };
  const applyTemplate = (id) => {
    setTemplateId(id);
    const tpl = templates.find((t) => t.id === id);
    setRules(tpl ? tpl.rules.map((r) => ({ ...r })) : []);
  };
  const validate = () => {
    const next = {};
    if (!String(draft.name ?? "").trim()) next.name = "名称不能为空";
    if (kind !== "tunnel") {
      if (!String(draft.host ?? "").trim()) next.host = "主机地址不能为空";
      const port = num$1(draft.port);
      if (port === void 0 || port < 1 || port > 65535) next.port = "端口需在 1–65535 之间";
    }
    if (kind === "rdp" && !String(draft.username ?? "").trim()) next.username = "RDP 需要用户名";
    if (kind === "rdp" && draft.displayMode === "fixed-resolution") {
      const w = num$1(draft.width);
      const h = num$1(draft.height);
      if (w === void 0 || w < 320 || w > 8192) next.width = "宽度需在 320–8192 之间";
      if (h === void 0 || h < 240 || h > 8192) next.height = "高度需在 240–8192 之间";
    }
    if (kind === "tunnel") {
      if (!String(draft.serverId ?? "").trim()) next.serverId = "必须选择承载的 SSH 服务器";
      const lp = num$1(draft.localPort);
      if (lp === void 0 || lp < 1 || lp > 65535) next.localPort = "本地端口需在 1–65535 之间";
      if (draft.type !== "dynamic") {
        const rp = num$1(draft.remotePort);
        if (rp === void 0 || rp < 1 || rp > 65535) next.remotePort = "远端端口需在 1–65535 之间";
        if (!String(draft.remoteHost ?? "").trim()) next.remoteHost = "远端主机不能为空";
      }
    }
    if (kind === "vnc") {
      for (const key of ["qualityLevel", "compressionLevel"]) {
        const v = num$1(draft[key]);
        if (v !== void 0 && (v < 0 || v > 9)) next[key] = "取值范围 0–9";
      }
    }
    setErrors(next);
    return Object.keys(next).length === 0;
  };
  const build = () => {
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const id = existing?.id ?? newConnectionId();
    const base = {
      id,
      name: String(draft.name ?? "").trim(),
      ...String(draft.groupId ?? "") ? { groupId: String(draft.groupId) } : {},
      note: String(draft.note ?? "") || void 0,
      storeType: "local",
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    };
    const omitUndefined = (o) => {
      const bag = o;
      for (const k of Object.keys(bag)) if (bag[k] === void 0) delete bag[k];
      return o;
    };
    if (kind === "telnet") {
      const conn = omitUndefined({
        ...base,
        kind: "telnet",
        host: String(draft.host ?? "").trim(),
        port: num$1(draft.port) ?? 23,
        username: String(draft.username ?? "") || void 0,
        password: String(draft.password ?? "") || void 0,
        options: {
          timeoutMs: num$1(draft["options.timeoutMs"]),
          term: String(draft["options.term"] ?? "") || void 0,
          cols: num$1(draft["options.cols"]),
          rows: num$1(draft["options.rows"])
        },
        keyMapping: {
          enabled: keyMappingEnabled,
          template: templateId,
          ...rules.length > 0 ? { rules } : {}
        }
      });
      return conn;
    }
    if (kind === "rdp") {
      return omitUndefined({
        ...base,
        kind: "rdp",
        host: String(draft.host ?? "").trim(),
        port: num$1(draft.port) ?? 3389,
        username: String(draft.username ?? "").trim(),
        password: String(draft.password ?? "") || void 0,
        domain: String(draft.domain ?? "") || void 0,
        displayMode: draft.displayMode ?? "follow-window",
        ...draft.displayMode === "fixed-resolution" ? { width: num$1(draft.width), height: num$1(draft.height) } : {},
        quality: draft.quality ?? "balanced",
        clipboardShare: draft.clipboardShare === true
      });
    }
    if (kind === "vnc") {
      return omitUndefined({
        ...base,
        kind: "vnc",
        host: String(draft.host ?? "").trim(),
        port: num$1(draft.port) ?? 5900,
        authType: draft.authType ?? "vnc-password",
        password: String(draft.password ?? "") || void 0,
        viewOnly: draft.viewOnly === true,
        shared: draft.shared === true,
        scaleViewport: draft.scaleViewport === true,
        clipViewport: draft.clipViewport === true,
        qualityLevel: num$1(draft.qualityLevel) ?? 6,
        compressionLevel: num$1(draft.compressionLevel) ?? 2
      });
    }
    return omitUndefined({
      ...base,
      kind: "tunnel",
      serverId: String(draft.serverId ?? "").trim(),
      type: draft.type ?? "local",
      localHost: String(draft.localHost ?? "127.0.0.1").trim(),
      localPort: num$1(draft.localPort) ?? 0,
      remoteHost: String(draft.remoteHost ?? "").trim(),
      remotePort: num$1(draft.remotePort) ?? 0,
      autoReconnect: draft.autoReconnect === true
    });
  };
  const submit = async () => {
    if (!validate()) {
      toast.warn("还有字段没填对，已标红");
      return;
    }
    setSaving(true);
    const ok = await saveConnection(build());
    setSaving(false);
    if (ok) toast.ok(existing ? `已保存「${String(draft.name)}」` : `已创建「${String(draft.name)}」`);
  };
  const sections = SPECS[kind];
  return /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { children: [
    kind === "rdp" ? /* @__PURE__ */ jsxRuntimeExports.jsx("div", { style: { marginBottom: 14 }, children: /* @__PURE__ */ jsxRuntimeExports.jsx(Banner, { tone: "warn", children: "RDP 通过**外部 xfreerdp 进程**打开，画面在**独立窗口**中显示，不会嵌在标签页里。 若本机缺少 FreeRDP，连接时会返回 UNSUPPORTED 并在提示里附带安装命令。" }) }) : null,
    kind === "tunnel" && sshConnections.length === 0 ? /* @__PURE__ */ jsxRuntimeExports.jsx("div", { style: { marginBottom: 14 }, children: /* @__PURE__ */ jsxRuntimeExports.jsx(Banner, { tone: "warn", children: "还没有 SSH 连接可作为隧道载体。隧道必须依附一条 SSH 服务器，请先创建 SSH 连接。" }) }) : null,
    sections.map((section) => /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx(Section, { children: section.title }),
      /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "t-grid t-grid--2 form-section-body", children: section.fields.filter((f) => !f.when || f.when(draft)).map((f) => {
        const value = readPath(draft, f.path);
        const err = errors[f.path];
        if (f.kind === "switch") {
          return /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "settings-switch-row", children: [
            /* @__PURE__ */ jsxRuntimeExports.jsx(
              Switch,
              {
                checked: value === true,
                onChange: (v) => set(f.path, v),
                label: f.label
              }
            ),
            f.hint ? /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "t-field__hint", children: f.hint }) : null
          ] }, f.path);
        }
        if (f.kind === "textarea") {
          return /* @__PURE__ */ jsxRuntimeExports.jsx(Field, { label: f.label, hint: f.hint, error: err, className: f.wide ? "t-grid__span2" : void 0, children: /* @__PURE__ */ jsxRuntimeExports.jsx(TextArea, { value: String(value ?? ""), rows: 2, onChange: (e) => set(f.path, e.target.value) }) }, f.path);
        }
        return /* @__PURE__ */ jsxRuntimeExports.jsx(Field, { label: f.label, hint: f.hint, error: err, className: f.wide ? "t-grid__span2" : void 0, children: f.kind === "select" ? /* @__PURE__ */ jsxRuntimeExports.jsx(
          Select,
          {
            value: String(value ?? ""),
            options: optionsFor(f),
            onChange: (e) => set(f.path, e.target.value),
            invalid: Boolean(err)
          }
        ) : /* @__PURE__ */ jsxRuntimeExports.jsx(
          TextInput,
          {
            type: f.kind === "password" ? "password" : f.kind === "number" ? "number" : "text",
            value: value === void 0 || value === null ? "" : String(value),
            mono: f.kind === "number" || f.path === "host",
            placeholder: f.placeholder,
            invalid: Boolean(err),
            autoComplete: f.kind === "password" ? "off" : void 0,
            onChange: (e) => set(f.path, f.kind === "number" ? e.target.value : e.target.value)
          }
        ) }, f.path);
      }) })
    ] }, section.title)),
    kind === "telnet" ? /* @__PURE__ */ jsxRuntimeExports.jsxs(jsxRuntimeExports.Fragment, { children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx(Section, { right: templates.length > 0 ? /* @__PURE__ */ jsxRuntimeExports.jsxs(Badge, { children: [
        templates.length,
        " 个模板"
      ] }) : void 0, children: "按键映射" }),
      /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "form-section-body", style: { display: "flex", flexDirection: "column", gap: 12 }, children: [
        /* @__PURE__ */ jsxRuntimeExports.jsx(
          Switch,
          {
            checked: keyMappingEnabled,
            onChange: setKeyMappingEnabled,
            label: "启用按键映射（网络设备键位适配）"
          }
        ),
        keyMappingEnabled ? /* @__PURE__ */ jsxRuntimeExports.jsxs(jsxRuntimeExports.Fragment, { children: [
          /* @__PURE__ */ jsxRuntimeExports.jsx(
            Field,
            {
              label: "预设模板",
              hint: "模板由主进程提供，选中后会把模板规则填入下方，可继续修改",
              children: /* @__PURE__ */ jsxRuntimeExports.jsx(
                Select,
                {
                  value: templateId,
                  options: templates.length === 0 ? [{ value: "standard", label: "标准模式" }] : templates.map((t) => ({ value: t.id, label: `${t.name} —— ${t.description}` })),
                  onChange: (e) => applyTemplate(e.target.value)
                }
              )
            }
          ),
          /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "keymap-list", children: [
            rules.length === 0 ? /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "t-field__hint", children: "当前模板不做任何转换（原始按键直通）。" }) : rules.map((r, i) => /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "keymap-row", children: [
              /* @__PURE__ */ jsxRuntimeExports.jsx(
                TextInput,
                {
                  className: "keymap-row__from",
                  value: r.from,
                  mono: true,
                  "aria-label": "源按键",
                  onChange: (e) => setRules(rules.map((x, j) => j === i ? { ...x, from: e.target.value } : x))
                }
              ),
              /* @__PURE__ */ jsxRuntimeExports.jsx(Icon, { name: "chevron-right", size: 12 }),
              /* @__PURE__ */ jsxRuntimeExports.jsx(
                TextInput,
                {
                  className: "keymap-row__to",
                  value: r.to,
                  mono: true,
                  "aria-label": "发送的字节",
                  onChange: (e) => setRules(rules.map((x, j) => j === i ? { ...x, to: e.target.value } : x))
                }
              ),
              /* @__PURE__ */ jsxRuntimeExports.jsx(
                IconButton,
                {
                  icon: "trash",
                  label: "删除该条映射",
                  size: 12,
                  tone: "danger",
                  onClick: () => setRules(rules.filter((_, j) => j !== i))
                }
              )
            ] }, `${r.from}-${i}`)),
            /* @__PURE__ */ jsxRuntimeExports.jsx("div", { children: /* @__PURE__ */ jsxRuntimeExports.jsx(
              Button,
              {
                size: "sm",
                variant: "outline",
                icon: "plus",
                onClick: () => setRules([...rules, { from: "", to: "" }]),
                children: "新增映射"
              }
            ) })
          ] }),
          /* @__PURE__ */ jsxRuntimeExports.jsxs("p", { className: "t-field__hint", style: { margin: 0 }, children: [
            "右侧「发送的字节」支持转义序列：",
            /* @__PURE__ */ jsxRuntimeExports.jsx("code", { className: "mono", children: "\\r" }),
            "、",
            /* @__PURE__ */ jsxRuntimeExports.jsx("code", { className: "mono", children: "\\n" }),
            "、",
            /* @__PURE__ */ jsxRuntimeExports.jsx("code", { className: "mono", children: "\\t" }),
            "、",
            /* @__PURE__ */ jsxRuntimeExports.jsx("code", { className: "mono", children: "\\e" }),
            "、",
            /* @__PURE__ */ jsxRuntimeExports.jsx("code", { className: "mono", children: "\\xHH" }),
            "。 例如退格发 DEL 写 ",
            /* @__PURE__ */ jsxRuntimeExports.jsx("code", { className: "mono", children: "\\x7f" }),
            "， 方向键上写 ",
            /* @__PURE__ */ jsxRuntimeExports.jsx("code", { className: "mono", children: "\\x1bOA" }),
            "。"
          ] })
        ] }) : null
      ] })
    ] }) : null,
    /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { style: { display: "flex", alignItems: "center", gap: 8, marginTop: 22 }, children: [
      /* @__PURE__ */ jsxRuntimeExports.jsxs("span", { className: "form-footer-hint", children: [
        "协议 ",
        /* @__PURE__ */ jsxRuntimeExports.jsx("b", { children: KIND_LABEL[kind] }),
        existing ? " · 编辑已有连接" : " · 新建"
      ] }),
      /* @__PURE__ */ jsxRuntimeExports.jsx("div", { style: { flex: 1 } }),
      /* @__PURE__ */ jsxRuntimeExports.jsx(Button, { variant: "ghost", onClick: () => actions.closeEditor(), children: "取消" }),
      /* @__PURE__ */ jsxRuntimeExports.jsx(Button, { variant: "primary", loading: saving, onClick: () => void submit(), children: existing ? "保存" : "创建" })
    ] })
  ] });
}
const AUTH_LABELS = {
  password: "密码",
  privateKey: "私钥",
  identity: "引用凭证",
  keyboardInteractive: "交互式（含 2FA）",
  keyboard: "keyboard（兼容旧命名）"
};
const ENCODINGS = [
  "utf-8",
  "gbk",
  "gb18030",
  "big5",
  "latin1",
  "euc-jp",
  "shift_jis"
];
function emptyDraft() {
  return {
    name: "",
    groupId: "",
    host: "",
    port: "22",
    username: "",
    authType: "password",
    password: "",
    privateKey: "",
    passphrase: "",
    identityId: "",
    authOrder: [],
    note: "",
    storeType: "local",
    timeoutMs: "15000",
    keepaliveMs: "5000",
    shellText: "",
    shellIntervalMs: "",
    encoding: "utf-8",
    term: "",
    colorTerm: "",
    disableProxy: false,
    disablePwdSync: false,
    disableListing: false,
    x11Enabled: false,
    x11CookieMode: "",
    proxyUrl: "",
    proxyProtocol: "",
    proxyHost: "",
    proxyPort: "",
    proxyUsername: "",
    proxyPassword: "",
    kex: "",
    cipher: "",
    hostKey: "",
    hmac: "",
    compress: "",
    initScript: "",
    jumps: []
  };
}
const splitList = (text) => {
  const parts = text.split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean);
  return parts.length > 0 ? parts : void 0;
};
const joinList = (list) => (list ?? []).join(", ");
function num(value) {
  const n = Number(value);
  return value.trim() !== "" && Number.isFinite(n) ? n : void 0;
}
function toDraft(conn) {
  const base = emptyDraft();
  const opt = conn.options;
  return {
    ...base,
    name: conn.name,
    groupId: conn.groupId ?? "",
    host: conn.host,
    port: String(conn.port),
    username: conn.username,
    authType: conn.authType,
    password: conn.password ?? "",
    privateKey: conn.privateKey ?? "",
    passphrase: conn.passphrase ?? "",
    identityId: conn.identityId ?? "",
    authOrder: conn.authOrder ?? [],
    note: conn.note ?? "",
    storeType: conn.storeType ?? "local",
    timeoutMs: opt?.timeoutMs === void 0 ? "" : String(opt.timeoutMs),
    keepaliveMs: opt?.keepalive?.transportIntervalMs === void 0 ? "5000" : String(opt.keepalive.transportIntervalMs),
    shellText: opt?.keepalive?.shell?.text ?? "",
    shellIntervalMs: opt?.keepalive?.shell?.intervalMs === void 0 ? "" : String(opt.keepalive.shell.intervalMs),
    encoding: opt?.encoding ?? "utf-8",
    term: opt?.term ?? "",
    colorTerm: opt?.colorTerm ?? "",
    disableProxy: opt?.disableProxy ?? false,
    disablePwdSync: opt?.disablePwdSync ?? false,
    disableListing: opt?.disableListing ?? false,
    x11Enabled: opt?.x11?.enabled ?? false,
    x11CookieMode: opt?.x11?.cookieMode ?? "",
    proxyUrl: conn.proxy?.url ?? "",
    proxyProtocol: conn.proxy?.protocol ?? "",
    proxyHost: conn.proxy?.host ?? "",
    proxyPort: conn.proxy?.port === void 0 ? "" : String(conn.proxy.port),
    proxyUsername: conn.proxy?.username ?? "",
    proxyPassword: conn.proxy?.password ?? "",
    kex: joinList(opt?.algorithms?.kex),
    cipher: joinList(opt?.algorithms?.cipher),
    hostKey: joinList(opt?.algorithms?.hostKey),
    hmac: joinList(opt?.algorithms?.hmac),
    compress: joinList(opt?.algorithms?.compress),
    initScript: conn.initScript ?? "",
    jumps: (conn.jumpChain ?? []).map((hop, i) => ({
      key: hop.id || `hop-${i}`,
      name: hop.name ?? "",
      host: hop.host,
      port: String(hop.port),
      username: hop.username,
      authType: hop.authType,
      password: hop.password ?? "",
      privateKey: hop.privateKey ?? "",
      passphrase: hop.passphrase ?? "",
      verifyHostKey: hop.verifyHostKey ?? true
    }))
  };
}
function buildConnection(draft, existing, id) {
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const algorithms = {
    ...splitList(draft.kex) ? { kex: splitList(draft.kex) } : {},
    ...splitList(draft.cipher) ? { cipher: splitList(draft.cipher) } : {},
    ...splitList(draft.hostKey) ? { hostKey: splitList(draft.hostKey) } : {},
    ...splitList(draft.hmac) ? { hmac: splitList(draft.hmac) } : {},
    ...splitList(draft.compress) ? { compress: splitList(draft.compress) } : {}
  };
  const keepalive = {
    ...num(draft.keepaliveMs) === void 0 ? {} : { transportIntervalMs: num(draft.keepaliveMs) },
    ...draft.shellText || draft.shellIntervalMs ? {
      shell: {
        ...draft.shellText ? { text: draft.shellText } : {},
        ...num(draft.shellIntervalMs) === void 0 ? {} : { intervalMs: num(draft.shellIntervalMs) }
      }
    } : {}
  };
  const proxy = draft.proxyUrl || draft.proxyHost ? {
    url: draft.proxyUrl,
    ...draft.proxyProtocol ? { protocol: draft.proxyProtocol } : {},
    ...draft.proxyHost ? { host: draft.proxyHost } : {},
    ...num(draft.proxyPort) === void 0 ? {} : { port: num(draft.proxyPort) },
    ...draft.proxyUsername ? { username: draft.proxyUsername } : {},
    ...draft.proxyPassword ? { password: draft.proxyPassword } : {}
  } : void 0;
  const jumpChain = draft.jumps.filter((j) => j.host.trim().length > 0).map((j) => ({
    id: j.key,
    host: j.host.trim(),
    port: num(j.port) ?? 22,
    username: j.username.trim(),
    authType: j.authType,
    ...j.name ? { name: j.name } : {},
    ...j.password ? { password: j.password } : {},
    ...j.privateKey ? { privateKey: j.privateKey } : {},
    ...j.passphrase ? { passphrase: j.passphrase } : {},
    verifyHostKey: j.verifyHostKey
  }));
  return {
    kind: "ssh",
    id,
    name: draft.name.trim(),
    ...draft.groupId ? { groupId: draft.groupId } : {},
    host: draft.host.trim(),
    port: num(draft.port) ?? 22,
    username: draft.username.trim(),
    authType: draft.authType,
    ...draft.authType === "password" && draft.password ? { password: draft.password } : {},
    ...draft.authType === "privateKey" && draft.privateKey ? { privateKey: draft.privateKey, passphrase: draft.passphrase } : {},
    ...draft.authType === "identity" && draft.identityId ? { identityId: draft.identityId } : {},
    ...draft.authOrder.length > 0 ? { authOrder: draft.authOrder } : {},
    ...draft.note ? { note: draft.note } : {},
    ...proxy ? { proxy } : {},
    ...jumpChain.length > 0 ? { jumpChain } : {},
    options: {
      ...num(draft.timeoutMs) === void 0 ? {} : { timeoutMs: num(draft.timeoutMs) },
      keepalive,
      ...Object.keys(algorithms).length > 0 ? { algorithms } : {},
      ...draft.term ? { term: draft.term } : {},
      ...draft.colorTerm ? { colorTerm: draft.colorTerm } : {},
      encoding: draft.encoding,
      ...draft.disableProxy ? { disableProxy: true } : {},
      ...draft.disablePwdSync ? { disablePwdSync: true } : {},
      ...draft.disableListing ? { disableListing: true } : {},
      ...draft.x11Enabled ? { x11: { enabled: true, ...draft.x11CookieMode ? { cookieMode: draft.x11CookieMode } : {} } } : {}
    },
    ...draft.initScript ? { initScript: draft.initScript } : {},
    storeType: draft.storeType,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now
  };
}
function AuthOrderEditor({
  value,
  onChange
}) {
  const available = SSH_AUTH_TYPES.filter((t) => !value.includes(t));
  const move = (index, delta) => {
    const next = [...value];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    const [item] = next.splice(index, 1);
    if (item) next.splice(target, 0, item);
    onChange(next);
  };
  return /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { style: { display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }, children: [
    value.length === 0 ? /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "t-field__hint", children: "未指定（按库默认顺序尝试）" }) : value.map((t, i) => /* @__PURE__ */ jsxRuntimeExports.jsxs("span", { className: "t-badge t-badge--accent", style: { gap: 2, paddingRight: 3 }, children: [
      i + 1,
      ". ",
      AUTH_LABELS[t],
      /* @__PURE__ */ jsxRuntimeExports.jsx(
        "button",
        {
          type: "button",
          className: "t-iconbtn",
          style: { width: 18, height: 18 },
          "aria-label": `上移 ${AUTH_LABELS[t]}`,
          onClick: () => move(i, -1),
          children: /* @__PURE__ */ jsxRuntimeExports.jsx(Icon, { name: "chevron-left", size: 11 })
        }
      ),
      /* @__PURE__ */ jsxRuntimeExports.jsx(
        "button",
        {
          type: "button",
          className: "t-iconbtn",
          style: { width: 18, height: 18 },
          "aria-label": `下移 ${AUTH_LABELS[t]}`,
          onClick: () => move(i, 1),
          children: /* @__PURE__ */ jsxRuntimeExports.jsx(Icon, { name: "chevron-right", size: 11 })
        }
      ),
      /* @__PURE__ */ jsxRuntimeExports.jsx(
        "button",
        {
          type: "button",
          className: "t-iconbtn t-iconbtn--danger",
          style: { width: 18, height: 18 },
          "aria-label": `移除 ${AUTH_LABELS[t]}`,
          onClick: () => onChange(value.filter((x) => x !== t)),
          children: /* @__PURE__ */ jsxRuntimeExports.jsx(Icon, { name: "close", size: 11 })
        }
      )
    ] }, t)),
    available.length > 0 ? /* @__PURE__ */ jsxRuntimeExports.jsx(
      Select,
      {
        value: "",
        style: { width: 150, height: 26 },
        onChange: (e) => {
          const t = e.target.value;
          if (t) onChange([...value, t]);
        },
        options: [
          { value: "", label: "+ 添加认证方式" },
          ...available.map((t) => ({ value: t, label: AUTH_LABELS[t] }))
        ]
      }
    ) : null
  ] });
}
function ConnectionForm() {
  const { editing, groups, saving } = useStoreShallow((s) => ({
    editing: s.editing,
    groups: s.groups,
    saving: s.saving
  }));
  const existing = editing?.mode === "edit" ? getConnection(editing.id) : void 0;
  const targetKind = existing?.kind ?? editing?.kind ?? "ssh";
  const isSsh = targetKind === "ssh";
  const closeEditor = reactExports.useCallback(() => actions.closeEditor(), []);
  const [draft, setDraft] = reactExports.useState(
    () => existing && existing.kind === "ssh" ? toDraft(existing) : emptyDraft()
  );
  const [errors, setErrors] = reactExports.useState({});
  const [testResult, setTestResult] = reactExports.useState(null);
  const [testing, setTesting] = reactExports.useState(false);
  const patch = (key, value) => {
    setDraft((d) => ({ ...d, [key]: value }));
    setErrors((e) => e[key] ? { ...e, [key]: void 0 } : e);
  };
  const flatGroups = reactExports.useMemo(() => {
    const out = [];
    const walk = (nodes, depth) => {
      for (const n of nodes) {
        out.push({ value: n.id, label: `${"　".repeat(depth)}${n.name}` });
        walk(n.children, depth + 1);
      }
    };
    walk(groups, 0);
    return out;
  }, [groups]);
  const validate = () => {
    const next = {};
    if (!draft.name.trim()) next.name = "名称不能为空";
    if (!draft.host.trim()) next.host = "主机地址不能为空";
    const port = num(draft.port);
    if (port === void 0 || port < 1 || port > 65535) next.port = "端口需在 1-65535 之间";
    if (!draft.username.trim()) next.username = "登录用户不能为空";
    if (draft.authType === "privateKey" && !draft.privateKey.trim()) next.privateKey = "请粘贴私钥内容";
    if (draft.authType === "identity" && !draft.identityId.trim()) next.identityId = "请填写凭证 ID";
    setErrors(next);
    return Object.keys(next).length === 0;
  };
  const onSave = async () => {
    if (!isSsh) {
      toast.warn("当前版本只实现了 SSH 表单，其他协议请等后续版本");
      return;
    }
    if (!validate()) return;
    const id = existing?.id ?? newConnectionId();
    const built = buildConnection(draft, existing, id);
    const merged = {
      ...built,
      ...existing?.favorite === void 0 ? {} : { favorite: existing.favorite },
      ...existing?.lastUsedAt === void 0 ? {} : { lastUsedAt: existing.lastUsedAt },
      ...existing?.useCount === void 0 ? {} : { useCount: existing.useCount }
    };
    const ok = await saveConnection(merged);
    if (ok) toast.ok(existing ? `已保存「${merged.name}」` : `已创建「${merged.name}」`);
  };
  const onTest = async () => {
    if (!validate()) return;
    setTesting(true);
    setTestResult(null);
    const built = buildConnection(draft, existing, existing?.id ?? "test-only");
    const started = performance.now();
    try {
      const res = await invoke(
        "ssh",
        "testConnection",
        { connection: built }
      );
      const ms = Math.round(performance.now() - started);
      const detail = res && typeof res === "object" && "message" in res && typeof res.message === "string" ? res.message : "认证通过，可以建立会话";
      setTestResult({ ok: true, text: `${detail}（往返 ${ms} ms）` });
    } catch (err) {
      const ms = Math.round(performance.now() - started);
      setTestResult({ ok: false, text: `${errorText(err)}（耗时 ${ms} ms）` });
    } finally {
      setTesting(false);
    }
  };
  reactExports.useEffect(() => {
    setTestResult(null);
  }, [draft.host, draft.port, draft.username, draft.authType]);
  if (!isSsh) {
    return /* @__PURE__ */ jsxRuntimeExports.jsx(
      Modal,
      {
        open: true,
        title: existing ? `编辑连接 · ${existing.name}` : `新建 ${targetKind.toUpperCase()} 连接`,
        subtitle: existing ? connectionAddress(existing) : "字段按该协议的契约填写；带 * 的为必填",
        onClose: closeEditor,
        children: /* @__PURE__ */ jsxRuntimeExports.jsx(ProtocolForm, { kind: targetKind, existingId: existing?.id })
      }
    );
  }
  const showPassword = draft.authType === "password";
  const showKey = draft.authType === "privateKey";
  const showIdentity = draft.authType === "identity";
  return /* @__PURE__ */ jsxRuntimeExports.jsxs(
    Modal,
    {
      open: true,
      title: existing ? `编辑连接 · ${existing.name}` : "新建 SSH 连接",
      subtitle: existing ? connectionAddress(existing) : "按分区填写，带 * 的为必填",
      onClose: closeEditor,
      footer: /* @__PURE__ */ jsxRuntimeExports.jsxs(jsxRuntimeExports.Fragment, { children: [
        /* @__PURE__ */ jsxRuntimeExports.jsx(Button, { variant: "outline", icon: "route", loading: testing, onClick: () => void onTest(), children: "测试连接" }),
        /* @__PURE__ */ jsxRuntimeExports.jsxs("span", { className: "form-footer-hint", children: [
          draft.jumps.length > 0 ? `经 ${draft.jumps.length} 跳跳板` : "直连",
          draft.proxyUrl ? " · 走代理" : ""
        ] }),
        /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "t-modal__footer-spacer" }),
        /* @__PURE__ */ jsxRuntimeExports.jsx(Button, { variant: "ghost", onClick: () => actions.closeEditor(), children: "取消" }),
        /* @__PURE__ */ jsxRuntimeExports.jsx(Button, { variant: "primary", loading: saving, onClick: () => void onSave(), children: existing ? "保存" : "创建" })
      ] }),
      children: [
        /* @__PURE__ */ jsxRuntimeExports.jsx(Section, { children: "基本信息" }),
        /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "t-grid t-grid--2 form-section-body", children: [
          /* @__PURE__ */ jsxRuntimeExports.jsx(Field, { label: "名称", required: true, error: errors.name, children: /* @__PURE__ */ jsxRuntimeExports.jsx(
            TextInput,
            {
              value: draft.name,
              placeholder: "例如：prod-web-01",
              invalid: Boolean(errors.name),
              onChange: (e) => patch("name", e.target.value)
            }
          ) }),
          /* @__PURE__ */ jsxRuntimeExports.jsx(Field, { label: "分组", children: /* @__PURE__ */ jsxRuntimeExports.jsx(
            Select,
            {
              value: draft.groupId,
              onChange: (e) => patch("groupId", e.target.value),
              options: [{ value: "", label: "（未分组）" }, ...flatGroups]
            }
          ) }),
          /* @__PURE__ */ jsxRuntimeExports.jsx(Field, { label: "主机地址", required: true, error: errors.host, className: "t-grid__span2", children: /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "t-inputgroup", children: [
            /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "t-inputgroup__grow", children: /* @__PURE__ */ jsxRuntimeExports.jsx(
              TextInput,
              {
                value: draft.host,
                mono: true,
                placeholder: "10.0.0.12 或 db.internal",
                invalid: Boolean(errors.host),
                onChange: (e) => patch("host", e.target.value)
              }
            ) }),
            /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "t-inputgroup__port", children: /* @__PURE__ */ jsxRuntimeExports.jsx(
              TextInput,
              {
                value: draft.port,
                mono: true,
                inputMode: "numeric",
                placeholder: "22",
                invalid: Boolean(errors.port),
                onChange: (e) => patch("port", e.target.value)
              }
            ) })
          ] }) }),
          /* @__PURE__ */ jsxRuntimeExports.jsx(Field, { label: "登录用户", required: true, error: errors.username, children: /* @__PURE__ */ jsxRuntimeExports.jsx(
            TextInput,
            {
              value: draft.username,
              mono: true,
              placeholder: "root",
              invalid: Boolean(errors.username),
              onChange: (e) => patch("username", e.target.value)
            }
          ) }),
          /* @__PURE__ */ jsxRuntimeExports.jsx(Field, { label: "验证方式", hint: "决定下方需要填写哪类凭据", children: /* @__PURE__ */ jsxRuntimeExports.jsx(
            Select,
            {
              value: draft.authType,
              onChange: (e) => patch("authType", e.target.value),
              options: SSH_AUTH_TYPES.map((t) => ({ value: t, label: AUTH_LABELS[t] }))
            }
          ) }),
          showPassword ? /* @__PURE__ */ jsxRuntimeExports.jsx(Field, { label: "密码", className: "t-grid__span2", hint: "保存在本地库中，由主密码加密", children: /* @__PURE__ */ jsxRuntimeExports.jsx(
            TextInput,
            {
              type: "password",
              value: draft.password,
              autoComplete: "off",
              onChange: (e) => patch("password", e.target.value)
            }
          ) }) : null,
          showKey ? /* @__PURE__ */ jsxRuntimeExports.jsxs(jsxRuntimeExports.Fragment, { children: [
            /* @__PURE__ */ jsxRuntimeExports.jsx(Field, { label: "私钥", required: true, error: errors.privateKey, className: "t-grid__span2", hint: "PEM 或 OpenSSH 格式文本", children: /* @__PURE__ */ jsxRuntimeExports.jsx(
              TextArea,
              {
                value: draft.privateKey,
                mono: true,
                rows: 5,
                placeholder: "-----BEGIN OPENSSH PRIVATE KEY-----",
                invalid: Boolean(errors.privateKey),
                onChange: (e) => patch("privateKey", e.target.value)
              }
            ) }),
            /* @__PURE__ */ jsxRuntimeExports.jsx(Field, { label: "私钥口令", className: "t-grid__span2", children: /* @__PURE__ */ jsxRuntimeExports.jsx(
              TextInput,
              {
                type: "password",
                value: draft.passphrase,
                autoComplete: "off",
                onChange: (e) => patch("passphrase", e.target.value)
              }
            ) })
          ] }) : null,
          showIdentity ? /* @__PURE__ */ jsxRuntimeExports.jsx(Field, { label: "凭证 ID", required: true, error: errors.identityId, className: "t-grid__span2", hint: "引用凭证库中的条目，不在此处内联密钥", children: /* @__PURE__ */ jsxRuntimeExports.jsx(
            TextInput,
            {
              value: draft.identityId,
              mono: true,
              onChange: (e) => patch("identityId", e.target.value)
            }
          ) }) : null,
          /* @__PURE__ */ jsxRuntimeExports.jsx(Field, { label: "认证顺序", className: "t-grid__span2", hint: "留空则使用库默认顺序；可拖拽式调整（用箭头按钮）", children: /* @__PURE__ */ jsxRuntimeExports.jsx(AuthOrderEditor, { value: draft.authOrder, onChange: (v) => patch("authOrder", v) }) }),
          /* @__PURE__ */ jsxRuntimeExports.jsx(Field, { label: "主机备注", className: "t-grid__span2", children: /* @__PURE__ */ jsxRuntimeExports.jsx(
            TextArea,
            {
              value: draft.note,
              rows: 2,
              placeholder: "记录这台机器的用途、变更注意事项…",
              onChange: (e) => patch("note", e.target.value)
            }
          ) }),
          /* @__PURE__ */ jsxRuntimeExports.jsx(Field, { label: "连接超时 (ms)", children: /* @__PURE__ */ jsxRuntimeExports.jsx(
            TextInput,
            {
              value: draft.timeoutMs,
              mono: true,
              inputMode: "numeric",
              onChange: (e) => patch("timeoutMs", e.target.value)
            }
          ) }),
          /* @__PURE__ */ jsxRuntimeExports.jsx(Field, { label: "传输层心跳 (ms)", hint: "默认 5000；设为 0 关闭", children: /* @__PURE__ */ jsxRuntimeExports.jsx(
            TextInput,
            {
              value: draft.keepaliveMs,
              mono: true,
              inputMode: "numeric",
              onChange: (e) => patch("keepaliveMs", e.target.value)
            }
          ) }),
          /* @__PURE__ */ jsxRuntimeExports.jsx(Field, { label: "存储位置", children: /* @__PURE__ */ jsxRuntimeExports.jsx(
            Select,
            {
              value: draft.storeType,
              onChange: (e) => patch("storeType", e.target.value),
              options: [
                { value: "local", label: "本地仓库" },
                { value: "cloud", label: "云端仓库（需先配置同步）" }
              ]
            }
          ) })
        ] }),
        /* @__PURE__ */ jsxRuntimeExports.jsx(Section, { children: "连接设置" }),
        /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "t-grid t-grid--2 form-section-body", children: [
          /* @__PURE__ */ jsxRuntimeExports.jsx(
            Field,
            {
              label: "终端显示编码",
              hint: "⚠️ 尚未生效：主进程目前把 SSH/PTY 输出固定按 UTF-8 解码，非 UTF-8 的远端会乱码。这里保留字段是为了主进程改造后即可生效（需改为传原始字节）。",
              children: /* @__PURE__ */ jsxRuntimeExports.jsx(
                Select,
                {
                  value: draft.encoding,
                  onChange: (e) => patch("encoding", e.target.value),
                  options: ENCODINGS.map((enc) => ({ value: enc, label: enc }))
                }
              )
            }
          ),
          /* @__PURE__ */ jsxRuntimeExports.jsx(Field, { label: "终端类型 TERM", hint: "留空使用 xterm-256color", children: /* @__PURE__ */ jsxRuntimeExports.jsx(
            TextInput,
            {
              value: draft.term,
              mono: true,
              placeholder: "xterm-256color",
              onChange: (e) => patch("term", e.target.value)
            }
          ) }),
          /* @__PURE__ */ jsxRuntimeExports.jsx(Field, { label: "COLORTERM", hint: "如 truecolor", children: /* @__PURE__ */ jsxRuntimeExports.jsx(
            TextInput,
            {
              value: draft.colorTerm,
              mono: true,
              onChange: (e) => patch("colorTerm", e.target.value)
            }
          ) }),
          /* @__PURE__ */ jsxRuntimeExports.jsx(Field, { label: "Shell 层保活", hint: "定期往会话里发送字符，防止中间设备掐连接", children: /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "t-inputgroup", children: [
            /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "t-inputgroup__grow", children: /* @__PURE__ */ jsxRuntimeExports.jsx(
              TextInput,
              {
                value: draft.shellText,
                mono: true,
                placeholder: "发送的字符",
                onChange: (e) => patch("shellText", e.target.value)
              }
            ) }),
            /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "t-inputgroup__port", children: /* @__PURE__ */ jsxRuntimeExports.jsx(
              TextInput,
              {
                value: draft.shellIntervalMs,
                mono: true,
                placeholder: "ms",
                onChange: (e) => patch("shellIntervalMs", e.target.value)
              }
            ) })
          ] }) }),
          /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "t-grid t-grid--2 t-grid__span2", style: { gap: 10 }, children: [
            /* @__PURE__ */ jsxRuntimeExports.jsx(
              Switch,
              {
                checked: draft.disableProxy,
                onChange: (v) => patch("disableProxy", v),
                label: "禁用代理（优先直连）"
              }
            ),
            /* @__PURE__ */ jsxRuntimeExports.jsx(
              Switch,
              {
                checked: draft.disableListing,
                onChange: (v) => patch("disableListing", v),
                label: "禁止列表监控"
              }
            ),
            /* @__PURE__ */ jsxRuntimeExports.jsx(
              Switch,
              {
                checked: draft.disablePwdSync,
                onChange: (v) => patch("disablePwdSync", v),
                label: "禁用 pwd 自动跳转"
              }
            ),
            /* @__PURE__ */ jsxRuntimeExports.jsx(
              Switch,
              {
                checked: draft.x11Enabled,
                onChange: (v) => patch("x11Enabled", v),
                label: "启用 X11 转发"
              }
            )
          ] }),
          draft.x11Enabled ? /* @__PURE__ */ jsxRuntimeExports.jsx(Field, { label: "X11 Cookie 模式", className: "t-grid__span2", children: /* @__PURE__ */ jsxRuntimeExports.jsx(
            TextInput,
            {
              value: draft.x11CookieMode,
              mono: true,
              onChange: (e) => patch("x11CookieMode", e.target.value)
            }
          ) }) : null
        ] }),
        /* @__PURE__ */ jsxRuntimeExports.jsx(Section, { right: /* @__PURE__ */ jsxRuntimeExports.jsxs(Badge, { children: [
          draft.jumps.length,
          " / 20"
        ] }), children: "跳板机链路" }),
        /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "form-section-body form-jump", children: [
          /* @__PURE__ */ jsxRuntimeExports.jsx("p", { className: "t-field__hint", style: { margin: 0 }, children: "按顺序逐跳连接，第一项最先连。最多 20 跳。" }),
          draft.jumps.map((hop, i) => /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "form-jump__hop", children: [
            /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "form-jump__index", children: i + 1 }),
            /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "form-jump__grid", children: [
              /* @__PURE__ */ jsxRuntimeExports.jsx(
                TextInput,
                {
                  value: hop.host,
                  mono: true,
                  placeholder: "跳板地址",
                  onChange: (e) => patch(
                    "jumps",
                    draft.jumps.map((h) => h.key === hop.key ? { ...h, host: e.target.value } : h)
                  )
                }
              ),
              /* @__PURE__ */ jsxRuntimeExports.jsx(
                TextInput,
                {
                  value: hop.port,
                  mono: true,
                  placeholder: "22",
                  onChange: (e) => patch(
                    "jumps",
                    draft.jumps.map((h) => h.key === hop.key ? { ...h, port: e.target.value } : h)
                  )
                }
              ),
              /* @__PURE__ */ jsxRuntimeExports.jsx(
                TextInput,
                {
                  value: hop.username,
                  mono: true,
                  placeholder: "用户",
                  onChange: (e) => patch(
                    "jumps",
                    draft.jumps.map((h) => h.key === hop.key ? { ...h, username: e.target.value } : h)
                  )
                }
              ),
              /* @__PURE__ */ jsxRuntimeExports.jsx(
                Select,
                {
                  value: hop.authType,
                  onChange: (e) => patch(
                    "jumps",
                    draft.jumps.map(
                      (h) => h.key === hop.key ? { ...h, authType: e.target.value } : h
                    )
                  ),
                  options: SSH_AUTH_TYPES.map((t) => ({ value: t, label: AUTH_LABELS[t] }))
                }
              ),
              /* @__PURE__ */ jsxRuntimeExports.jsx(
                TextInput,
                {
                  type: "password",
                  value: hop.authType === "privateKey" ? hop.passphrase : hop.password,
                  placeholder: hop.authType === "privateKey" ? "私钥口令（可选）" : "密码（可选）",
                  onChange: (e) => patch(
                    "jumps",
                    draft.jumps.map(
                      (h) => h.key === hop.key ? hop.authType === "privateKey" ? { ...h, passphrase: e.target.value } : { ...h, password: e.target.value } : h
                    )
                  )
                }
              ),
              /* @__PURE__ */ jsxRuntimeExports.jsx(
                Checkbox,
                {
                  checked: hop.verifyHostKey,
                  label: "校验主机指纹",
                  onChange: (v) => patch(
                    "jumps",
                    draft.jumps.map((h) => h.key === hop.key ? { ...h, verifyHostKey: v } : h)
                  )
                }
              )
            ] }),
            /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "form-jump__actions", children: [
              /* @__PURE__ */ jsxRuntimeExports.jsx(
                Button,
                {
                  size: "sm",
                  variant: "ghost",
                  icon: "chevron-left",
                  disabled: i === 0,
                  title: "上移",
                  onClick: () => {
                    const next = [...draft.jumps];
                    const prev = next[i - 1];
                    const cur = next[i];
                    if (!prev || !cur) return;
                    next[i - 1] = cur;
                    next[i] = prev;
                    patch("jumps", next);
                  }
                }
              ),
              /* @__PURE__ */ jsxRuntimeExports.jsx(
                Button,
                {
                  size: "sm",
                  variant: "ghost",
                  icon: "chevron-right",
                  disabled: i === draft.jumps.length - 1,
                  title: "下移",
                  onClick: () => {
                    const next = [...draft.jumps];
                    const nxt = next[i + 1];
                    const cur = next[i];
                    if (!nxt || !cur) return;
                    next[i + 1] = cur;
                    next[i] = nxt;
                    patch("jumps", next);
                  }
                }
              ),
              /* @__PURE__ */ jsxRuntimeExports.jsx(
                Button,
                {
                  size: "sm",
                  variant: "danger",
                  icon: "trash",
                  title: "删除该跳",
                  onClick: () => patch("jumps", draft.jumps.filter((h) => h.key !== hop.key))
                }
              )
            ] })
          ] }, hop.key)),
          /* @__PURE__ */ jsxRuntimeExports.jsx("div", { children: /* @__PURE__ */ jsxRuntimeExports.jsx(
            Button,
            {
              size: "sm",
              variant: "outline",
              icon: "plus",
              disabled: draft.jumps.length >= 20,
              onClick: () => patch("jumps", [
                ...draft.jumps,
                {
                  key: `hop-${Date.now()}-${draft.jumps.length}`,
                  name: "",
                  host: "",
                  port: "22",
                  username: "",
                  authType: "password",
                  password: "",
                  privateKey: "",
                  passphrase: "",
                  verifyHostKey: true
                }
              ]),
              children: "添加跳板"
            }
          ) })
        ] }),
        /* @__PURE__ */ jsxRuntimeExports.jsx(Section, { children: "代理设置" }),
        /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "t-grid t-grid--2 form-section-body", children: [
          /* @__PURE__ */ jsxRuntimeExports.jsx(Field, { label: "代理地址", className: "t-grid__span2", hint: "形如 socks5://127.0.0.1:1080；代理优先于跳板链", children: /* @__PURE__ */ jsxRuntimeExports.jsx(
            TextInput,
            {
              value: draft.proxyUrl,
              mono: true,
              placeholder: "socks5://127.0.0.1:1080",
              onChange: (e) => patch("proxyUrl", e.target.value)
            }
          ) }),
          /* @__PURE__ */ jsxRuntimeExports.jsx(Field, { label: "协议", children: /* @__PURE__ */ jsxRuntimeExports.jsx(
            Select,
            {
              value: draft.proxyProtocol,
              onChange: (e) => patch("proxyProtocol", e.target.value),
              options: [
                { value: "", label: "从地址推断" },
                { value: "socks5", label: "SOCKS5" },
                { value: "socks4", label: "SOCKS4" },
                { value: "http", label: "HTTP" },
                { value: "https", label: "HTTPS" }
              ]
            }
          ) }),
          /* @__PURE__ */ jsxRuntimeExports.jsx(Field, { label: "主机 / 端口", children: /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "t-inputgroup", children: [
            /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "t-inputgroup__grow", children: /* @__PURE__ */ jsxRuntimeExports.jsx(
              TextInput,
              {
                value: draft.proxyHost,
                mono: true,
                onChange: (e) => patch("proxyHost", e.target.value)
              }
            ) }),
            /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "t-inputgroup__port", children: /* @__PURE__ */ jsxRuntimeExports.jsx(
              TextInput,
              {
                value: draft.proxyPort,
                mono: true,
                onChange: (e) => patch("proxyPort", e.target.value)
              }
            ) })
          ] }) }),
          /* @__PURE__ */ jsxRuntimeExports.jsx(Field, { label: "代理用户名", children: /* @__PURE__ */ jsxRuntimeExports.jsx(
            TextInput,
            {
              value: draft.proxyUsername,
              onChange: (e) => patch("proxyUsername", e.target.value)
            }
          ) }),
          /* @__PURE__ */ jsxRuntimeExports.jsx(Field, { label: "代理密码", children: /* @__PURE__ */ jsxRuntimeExports.jsx(
            TextInput,
            {
              type: "password",
              value: draft.proxyPassword,
              autoComplete: "off",
              onChange: (e) => patch("proxyPassword", e.target.value)
            }
          ) })
        ] }),
        /* @__PURE__ */ jsxRuntimeExports.jsx(Section, { children: "其他设置（算法偏好）" }),
        /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "t-grid t-grid--2 form-section-body", children: [
          /* @__PURE__ */ jsxRuntimeExports.jsx(Field, { label: "密钥交换算法 (KEX)", hint: "逗号分隔；留空使用库默认", children: /* @__PURE__ */ jsxRuntimeExports.jsx(TextInput, { value: draft.kex, mono: true, onChange: (e) => patch("kex", e.target.value) }) }),
          /* @__PURE__ */ jsxRuntimeExports.jsx(Field, { label: "Cipher 算法", children: /* @__PURE__ */ jsxRuntimeExports.jsx(TextInput, { value: draft.cipher, mono: true, onChange: (e) => patch("cipher", e.target.value) }) }),
          /* @__PURE__ */ jsxRuntimeExports.jsx(Field, { label: "主机密钥算法", children: /* @__PURE__ */ jsxRuntimeExports.jsx(TextInput, { value: draft.hostKey, mono: true, onChange: (e) => patch("hostKey", e.target.value) }) }),
          /* @__PURE__ */ jsxRuntimeExports.jsx(Field, { label: "MAC 算法", children: /* @__PURE__ */ jsxRuntimeExports.jsx(TextInput, { value: draft.hmac, mono: true, onChange: (e) => patch("hmac", e.target.value) }) }),
          /* @__PURE__ */ jsxRuntimeExports.jsx(Field, { label: "压缩算法", className: "t-grid__span2", children: /* @__PURE__ */ jsxRuntimeExports.jsx(TextInput, { value: draft.compress, mono: true, onChange: (e) => patch("compress", e.target.value) }) })
        ] }),
        /* @__PURE__ */ jsxRuntimeExports.jsx(Section, { children: "初始化" }),
        /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "form-section-body", children: /* @__PURE__ */ jsxRuntimeExports.jsx(
          Field,
          {
            label: "连接后自动执行的脚本",
            hint: "会话建立后逐行发送，用于设置环境变量、切换目录等",
            children: /* @__PURE__ */ jsxRuntimeExports.jsx(
              TextArea,
              {
                value: draft.initScript,
                mono: true,
                rows: 5,
                placeholder: 'cd /srv/app\nexport PS1="\\u@\\h:\\w$ "\\n',
                onChange: (e) => patch("initScript", e.target.value)
              }
            )
          }
        ) }),
        testResult ? /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "form-testresult", children: /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: `t-banner${testResult.ok ? "" : " t-banner--error"}`, children: [
          /* @__PURE__ */ jsxRuntimeExports.jsx(Icon, { name: testResult.ok ? "check-circle" : "alert-circle", size: 15 }),
          /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "t-banner__body", children: [
            testResult.ok ? "测试通过：" : "测试失败：",
            testResult.text
          ] })
        ] }) }) : null,
        existing ? /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "meta-line", style: { marginTop: 14 }, children: [
          /* @__PURE__ */ jsxRuntimeExports.jsxs("span", { children: [
            "ID ",
            existing.id
          ] }),
          /* @__PURE__ */ jsxRuntimeExports.jsxs("span", { children: [
            "创建于 ",
            new Date(existing.createdAt).toLocaleString("zh-CN")
          ] })
        ] }) : null
      ]
    }
  );
}
export {
  ConnectionForm as default
};
