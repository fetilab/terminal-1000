import { r as reactExports, i as invoke, e as errorText, j as jsxRuntimeExports, L as Loading, f as Banner, h as Button, ai as Section, B as Badge, n as IconButton, t as toast, F as Field, T as TextInput, z as Select, I as Icon, ak as formatDate, M as Modal, C as Checkbox } from "./index-C6luzS_t.js";
const POLICY_OPTIONS = {
  execution: [
    { value: "confirm", label: "每次确认（默认）" },
    { value: "direct", label: "直接执行" }
  ],
  sudo: [
    { value: "deny", label: "禁止（默认）" },
    { value: "confirm", label: "需要确认" },
    { value: "direct", label: "直接执行" }
  ],
  workspace: [
    { value: "deny", label: "禁止（默认）" },
    { value: "confirm", label: "需要确认" },
    { value: "direct", label: "直接执行" }
  ]
};
function McpPanel() {
  const [status, setStatus] = reactExports.useState(null);
  const [tools, setTools] = reactExports.useState([]);
  const [loading, setLoading] = reactExports.useState(true);
  const [error, setError] = reactExports.useState(null);
  const [busy, setBusy] = reactExports.useState(false);
  const [restartNeeded, setRestartNeeded] = reactExports.useState(false);
  const [issued, setIssued] = reactExports.useState(null);
  const [createOpen, setCreateOpen] = reactExports.useState(false);
  const [newName, setNewName] = reactExports.useState("");
  const [newSudo, setNewSudo] = reactExports.useState(false);
  const [newWorkspace, setNewWorkspace] = reactExports.useState(false);
  const [draft, setDraft] = reactExports.useState(null);
  const [dirsText, setDirsText] = reactExports.useState("");
  const [enabledTools, setEnabledTools] = reactExports.useState([]);
  const refresh = reactExports.useCallback(async () => {
    try {
      const st = await invoke("mcp", "status", {});
      setStatus(st);
      setDraft(st.policy);
      setDirsText((st.policy.allowedLocalDirs ?? []).join("\n"));
      setEnabledTools(st.policy.enabledTools ?? []);
      setError(null);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setLoading(false);
    }
  }, []);
  const loadTools = reactExports.useCallback(async () => {
    try {
      const res = await invoke(
        "mcp",
        "listTools",
        {}
      );
      setTools(res?.tools ?? []);
    } catch {
      setTools([]);
    }
  }, []);
  reactExports.useEffect(() => {
    void refresh();
    void loadTools();
  }, [refresh, loadTools]);
  const toggleServer = async () => {
    if (!status) return;
    setBusy(true);
    try {
      if (status.running) {
        await invoke("mcp", "stop", {});
        toast.ok("MCP 服务已停止");
      } else {
        await invoke("mcp", "start", {});
        toast.ok("MCP 服务已启动");
      }
      await refresh();
    } catch (err) {
      toast.error(`${status.running ? "停止" : "启动"}失败：${errorText(err)}`);
    } finally {
      setBusy(false);
    }
  };
  const savePolicy = async () => {
    if (!draft) return;
    setBusy(true);
    try {
      const res = await invoke("mcp", "setPolicy", {
        listenHost: draft.listenHost,
        port: draft.port,
        executionPolicy: draft.executionPolicy,
        sudoPolicy: draft.sudoPolicy,
        workspacePolicy: draft.workspacePolicy,
        allowedServerIds: draft.allowedServerIds,
        allowedLocalDirs: dirsText.split("\n").map((s) => s.trim()).filter(Boolean),
        enabledTools,
        defaultTimeoutMs: draft.defaultTimeoutMs,
        maxTimeoutMs: draft.maxTimeoutMs
      });
      setDraft(res.policy);
      setRestartNeeded(res.restartRequired);
      await refresh();
      await loadTools();
      toast.ok(res.restartRequired ? "策略已保存 —— 监听地址/端口变更需要重启服务才生效" : "策略已保存");
    } catch (err) {
      toast.error(`保存失败：${errorText(err)}`);
    } finally {
      setBusy(false);
    }
  };
  const createClient = async () => {
    if (!newName.trim()) return;
    try {
      const res = await invoke(
        "mcp",
        "createClient",
        {
          name: newName.trim(),
          allowSudo: newSudo,
          allowWorkspace: newWorkspace
        }
      );
      setCreateOpen(false);
      setNewName("");
      setNewSudo(false);
      setNewWorkspace(false);
      const token = res.client?.token;
      if (token) {
        setIssued({ name: res.client.name, token });
      } else {
        toast.warn("服务端未返回明文令牌，请查看主进程日志");
      }
      await refresh();
    } catch (err) {
      toast.error(`创建失败：${errorText(err)}`);
    }
  };
  if (loading && !status) return /* @__PURE__ */ jsxRuntimeExports.jsx(Loading, { text: "读取 MCP 状态…" });
  if (error && !status) {
    return /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "svc-body", children: /* @__PURE__ */ jsxRuntimeExports.jsx(Banner, { tone: "error", actions: /* @__PURE__ */ jsxRuntimeExports.jsx(Button, { size: "sm", onClick: () => void refresh(), children: "重试" }), children: error }) });
  }
  if (!status || !draft) return /* @__PURE__ */ jsxRuntimeExports.jsx("div", {});
  const grouped = tools.reduce((acc, t) => {
    acc[t.group] = [...acc[t.group] ?? [], t];
    return acc;
  }, {});
  return /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "content-scroll svc-body", children: [
    /* @__PURE__ */ jsxRuntimeExports.jsx(Section, { children: "服务状态" }),
    /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { style: { display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 12 }, children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx(Badge, { tone: status.running ? "ok" : "default", children: status.running ? "运行中" : "已停止" }),
      /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "mono", style: { fontSize: 12 }, children: status.endpoint }),
      /* @__PURE__ */ jsxRuntimeExports.jsx(
        IconButton,
        {
          icon: "copy",
          label: "复制端点地址",
          onClick: () => {
            void navigator.clipboard.writeText(status.endpoint);
            toast.ok("已复制端点地址");
          }
        }
      ),
      /* @__PURE__ */ jsxRuntimeExports.jsx("div", { style: { flex: 1 } }),
      /* @__PURE__ */ jsxRuntimeExports.jsx(
        Button,
        {
          variant: status.running ? "outline" : "primary",
          icon: status.running ? "close" : "power",
          loading: busy,
          onClick: () => void toggleServer(),
          children: status.running ? "停止服务" : "启动服务"
        }
      )
    ] }),
    restartNeeded ? /* @__PURE__ */ jsxRuntimeExports.jsx("div", { style: { marginBottom: 12 }, children: /* @__PURE__ */ jsxRuntimeExports.jsx(Banner, { tone: "warn", children: "监听地址或端口已修改，需要**重启 MCP 服务**后才生效。" }) }) : null,
    /* @__PURE__ */ jsxRuntimeExports.jsx(Section, { children: "访问策略" }),
    /* @__PURE__ */ jsxRuntimeExports.jsx("p", { className: "t-field__hint", style: { marginTop: 0 }, children: "默认最保守：只监听回环、执行需确认、禁止 sudo、禁止工作区操作、服务器与目录白名单为空。 放宽任何一项都会让 MCP 客户端获得更强的能力，请确认你信任调用方。" }),
    /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "t-grid t-grid--2", style: { marginTop: 10 }, children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx(
        Field,
        {
          label: "监听地址",
          hint: "保持 127.0.0.1 最安全；改成 0.0.0.0 会让局域网可访问",
          aside: draft.listenHost !== "127.0.0.1" ? /* @__PURE__ */ jsxRuntimeExports.jsx(Badge, { tone: "danger", children: "已暴露" }) : void 0,
          children: /* @__PURE__ */ jsxRuntimeExports.jsx(
            TextInput,
            {
              value: draft.listenHost,
              mono: true,
              onChange: (e) => setDraft({ ...draft, listenHost: e.target.value })
            }
          )
        }
      ),
      /* @__PURE__ */ jsxRuntimeExports.jsx(Field, { label: "端口", children: /* @__PURE__ */ jsxRuntimeExports.jsx(
        TextInput,
        {
          type: "number",
          mono: true,
          value: String(draft.port),
          onChange: (e) => setDraft({ ...draft, port: Number(e.target.value) || 0 })
        }
      ) }),
      /* @__PURE__ */ jsxRuntimeExports.jsx(Field, { label: "命令执行", children: /* @__PURE__ */ jsxRuntimeExports.jsx(
        Select,
        {
          value: draft.executionPolicy,
          options: POLICY_OPTIONS.execution,
          onChange: (e) => setDraft({ ...draft, executionPolicy: e.target.value })
        }
      ) }),
      /* @__PURE__ */ jsxRuntimeExports.jsx(Field, { label: "sudo", children: /* @__PURE__ */ jsxRuntimeExports.jsx(
        Select,
        {
          value: draft.sudoPolicy,
          options: POLICY_OPTIONS.sudo,
          onChange: (e) => setDraft({ ...draft, sudoPolicy: e.target.value })
        }
      ) }),
      /* @__PURE__ */ jsxRuntimeExports.jsx(Field, { label: "工作区操作", children: /* @__PURE__ */ jsxRuntimeExports.jsx(
        Select,
        {
          value: draft.workspacePolicy,
          options: POLICY_OPTIONS.workspace,
          onChange: (e) => setDraft({ ...draft, workspacePolicy: e.target.value })
        }
      ) }),
      /* @__PURE__ */ jsxRuntimeExports.jsx(Field, { label: "可见服务器范围", children: /* @__PURE__ */ jsxRuntimeExports.jsx(
        Select,
        {
          value: Array.isArray(draft.allowedServerIds) ? "restricted" : "all",
          options: [
            { value: "restricted", label: "仅白名单内（推荐）" },
            { value: "all", label: "全部服务器（不推荐）" }
          ],
          onChange: (e) => setDraft({ ...draft, allowedServerIds: e.target.value === "all" ? "all" : [] })
        }
      ) }),
      /* @__PURE__ */ jsxRuntimeExports.jsx(Field, { label: "命令默认超时 (ms)", children: /* @__PURE__ */ jsxRuntimeExports.jsx(
        TextInput,
        {
          type: "number",
          mono: true,
          value: String(draft.defaultTimeoutMs),
          onChange: (e) => setDraft({ ...draft, defaultTimeoutMs: Number(e.target.value) || 0 })
        }
      ) }),
      /* @__PURE__ */ jsxRuntimeExports.jsx(Field, { label: "命令超时上限 (ms)", children: /* @__PURE__ */ jsxRuntimeExports.jsx(
        TextInput,
        {
          type: "number",
          mono: true,
          value: String(draft.maxTimeoutMs),
          onChange: (e) => setDraft({ ...draft, maxTimeoutMs: Number(e.target.value) || 0 })
        }
      ) }),
      /* @__PURE__ */ jsxRuntimeExports.jsx(
        Field,
        {
          label: "允许访问的本地目录",
          className: "t-grid__span2",
          hint: "每行一个绝对路径；留空表示不允许任何本地目录（路径校验用 realpath，防 .. 与软链绕过）",
          children: /* @__PURE__ */ jsxRuntimeExports.jsx(
            "textarea",
            {
              className: "t-textarea t-textarea--mono",
              rows: 3,
              value: dirsText,
              onChange: (e) => setDirsText(e.target.value)
            }
          )
        }
      )
    ] }),
    /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { style: { marginTop: 10, display: "flex", gap: 8 }, children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx(Button, { variant: "primary", icon: "check", loading: busy, onClick: () => void savePolicy(), children: "保存策略" }),
      /* @__PURE__ */ jsxRuntimeExports.jsx(
        Button,
        {
          variant: "ghost",
          onClick: () => setDraft({
            listenHost: "127.0.0.1",
            port: draft.port,
            executionPolicy: "confirm",
            sudoPolicy: "deny",
            workspacePolicy: "deny",
            allowedServerIds: [],
            allowedLocalDirs: [],
            defaultTimeoutMs: 6e4,
            maxTimeoutMs: 6e5,
            enabledTools: []
          }),
          children: "恢复最保守默认"
        }
      )
    ] }),
    /* @__PURE__ */ jsxRuntimeExports.jsx(Section, { right: /* @__PURE__ */ jsxRuntimeExports.jsxs(Badge, { children: [
      status.clients.length,
      " 个"
    ] }), children: "访问令牌" }),
    /* @__PURE__ */ jsxRuntimeExports.jsx("div", { style: { marginBottom: 10 }, children: /* @__PURE__ */ jsxRuntimeExports.jsx(Button, { variant: "outline", icon: "key", onClick: () => setCreateOpen(true), children: "新建客户端令牌" }) }),
    status.clients.length === 0 ? /* @__PURE__ */ jsxRuntimeExports.jsx("p", { className: "t-field__hint", children: "还没有任何客户端。MCP 客户端必须带 Bearer 令牌才能调用工具。" }) : status.clients.map((c) => /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: `svc-client${c.revoked ? " svc-client--revoked" : ""}`, children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx(Icon, { name: "key", size: 15 }),
      /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "svc-client__body", children: [
        /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "svc-client__name", children: c.name }),
        /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "svc-client__meta", children: [
          formatDate(c.createdAt),
          " · ",
          c.allowSudo ? "可 sudo" : "无 sudo",
          " ·",
          " ",
          c.allowWorkspace ? "可工作区" : "无工作区"
        ] })
      ] }),
      c.revoked ? /* @__PURE__ */ jsxRuntimeExports.jsx(Badge, { tone: "warn", children: "已吊销" }) : /* @__PURE__ */ jsxRuntimeExports.jsx(
        Button,
        {
          size: "sm",
          variant: "danger",
          icon: "trash",
          onClick: () => {
            void invoke(
              "mcp",
              "revokeClient",
              { clientId: c.id }
            ).then(() => {
              toast.ok(`已吊销「${c.name}」`);
              return refresh();
            }).catch((err) => toast.error(`吊销失败：${errorText(err)}`));
          },
          children: "吊销"
        }
      )
    ] }, c.id)),
    /* @__PURE__ */ jsxRuntimeExports.jsx(Section, { right: /* @__PURE__ */ jsxRuntimeExports.jsxs(Badge, { children: [
      status.tools.length,
      " 项启用"
    ] }), children: "暴露的工具" }),
    Object.entries(grouped).map(([group, list]) => /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { style: { marginBottom: 12 }, children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "t-field__label", style: { marginBottom: 6 }, children: group }),
      /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "svc-tools", children: list.map((t) => /* @__PURE__ */ jsxRuntimeExports.jsxs(
        "span",
        {
          className: `svc-tool${t.enabled ? "" : " svc-tool--off"}${t.requiresSudo ? " svc-tool--sudo" : ""}`,
          title: `${t.description}${t.requiresSudo ? " · 需要 sudo 授权" : ""}`,
          children: [
            t.name,
            t.requiresSudo ? /* @__PURE__ */ jsxRuntimeExports.jsx(Icon, { name: "shield", size: 11 }) : null
          ]
        },
        t.name
      )) })
    ] }, group)),
    /* @__PURE__ */ jsxRuntimeExports.jsx(
      Modal,
      {
        open: createOpen,
        size: "sm",
        title: "新建客户端令牌",
        onClose: () => setCreateOpen(false),
        footer: /* @__PURE__ */ jsxRuntimeExports.jsxs(jsxRuntimeExports.Fragment, { children: [
          /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "t-modal__footer-spacer" }),
          /* @__PURE__ */ jsxRuntimeExports.jsx(Button, { variant: "ghost", onClick: () => setCreateOpen(false), children: "取消" }),
          /* @__PURE__ */ jsxRuntimeExports.jsx(Button, { variant: "primary", disabled: !newName.trim(), onClick: () => void createClient(), children: "生成令牌" })
        ] }),
        children: /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "t-grid", children: [
          /* @__PURE__ */ jsxRuntimeExports.jsx(Field, { label: "客户端名称", required: true, hint: "用于在列表里辨认是哪台设备/哪个工具", children: /* @__PURE__ */ jsxRuntimeExports.jsx(
            TextInput,
            {
              value: newName,
              autoFocus: true,
              placeholder: "例如：claude-desktop",
              onChange: (e) => setNewName(e.target.value)
            }
          ) }),
          /* @__PURE__ */ jsxRuntimeExports.jsx(Checkbox, { checked: newSudo, onChange: setNewSudo, label: "允许该令牌使用 sudo（还需全局 sudo 策略允许）" }),
          /* @__PURE__ */ jsxRuntimeExports.jsx(Checkbox, { checked: newWorkspace, onChange: setNewWorkspace, label: "允许该令牌操作工作区" })
        ] })
      }
    ),
    /* @__PURE__ */ jsxRuntimeExports.jsx(
      Modal,
      {
        open: issued !== null,
        size: "md",
        title: "令牌已生成 —— 请立即保存",
        closeOnOverlay: false,
        onClose: () => setIssued(null),
        footer: /* @__PURE__ */ jsxRuntimeExports.jsxs(jsxRuntimeExports.Fragment, { children: [
          /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "t-modal__footer-spacer" }),
          /* @__PURE__ */ jsxRuntimeExports.jsx(
            Button,
            {
              variant: "outline",
              icon: "copy",
              onClick: () => {
                if (!issued) return;
                void navigator.clipboard.writeText(issued.token);
                toast.ok("已复制令牌");
              },
              children: "复制令牌"
            }
          ),
          /* @__PURE__ */ jsxRuntimeExports.jsx(
            Button,
            {
              variant: "primary",
              onClick: () => {
                setIssued(null);
                toast.info("令牌窗口已关闭，之后无法再次查看");
              },
              children: "我已保存，关闭"
            }
          )
        ] }),
        children: issued ? /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "svc-token", children: [
          /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { style: { display: "flex", alignItems: "center", gap: 8 }, children: [
            /* @__PURE__ */ jsxRuntimeExports.jsx(Icon, { name: "alert-triangle", size: 16 }),
            /* @__PURE__ */ jsxRuntimeExports.jsx("b", { children: "这是唯一一次能看到明文令牌的机会" })
          ] }),
          /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "t-field__hint", style: { color: "inherit" }, children: "服务端只保存它的 SHA-256 摘要，关闭本窗口后**无法再次取回**。 如果丢失，只能吊销后重新生成。" }),
          /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "svc-token__value", children: /* @__PURE__ */ jsxRuntimeExports.jsx("code", { children: issued.token }) }),
          /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "t-field__hint", style: { color: "inherit" }, children: [
            "客户端「",
            issued.name,
            "」调用时需带上：",
            /* @__PURE__ */ jsxRuntimeExports.jsx("br", {}),
            /* @__PURE__ */ jsxRuntimeExports.jsx("code", { className: "mono", children: "Authorization: Bearer <令牌>" })
          ] })
        ] }) : null
      }
    )
  ] });
}
export {
  McpPanel as default
};
