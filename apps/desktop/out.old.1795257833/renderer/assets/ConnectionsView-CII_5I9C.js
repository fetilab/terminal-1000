const __vite__mapDeps=(i,m=__vite__mapDeps,d=(m.f||(m.f=["./ConnectionForm-a_G18MTu.js","./index-CwfghMy4.js","./index-DD-jW_Hd.css","./ConnectionsSidebar-ByKnWd2L.js","./ConnectionsSidebar-C7RO018R.css"])))=>i.map(i=>d[i]);
import { j as jsxRuntimeExports, I as Icon, u as useStoreShallow, a as actions, h as Button, k as duplicateConnections, t as toast, l as connectManyAsGroup, m as deleteConnections, n as IconButton, C as Checkbox, r as reactExports, p as isFavorite, q as connectionUsername, v as toggleFavorite, S as StatusDot, w as pingLabel, x as connectionAddress, B as Badge, y as formatRelativeTime, c as connectTo, i as invoke, M as Modal, f as Banner, F as Field, T as TextInput, z as Select, L as Loading, e as errorText, A as ensureUnlocked, D as loadConnections, E as useStore, G as Switch, H as probeLatency, J as EmptyState, K as selectVisibleConnections, N as selectProtocolCounts, _ as __vitePreload } from "./index-CwfghMy4.js";
import { V as VirtualList } from "./VirtualList-CIIV3xPp.js";
import { C as CONNECTION_DND_TYPE, P as PROTOCOLS, c as createConnectionLabel, p as protocolLabel } from "./ConnectionsSidebar-ByKnWd2L.js";
function Segmented({
  items,
  value,
  onChange,
  bare = false,
  ariaLabel,
  children
}) {
  const onKeyDown = (e) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    const enabled = items.filter((i) => !i.disabled);
    if (enabled.length === 0) return;
    const idx = enabled.findIndex((i) => i.value === value);
    const next = e.key === "ArrowRight" ? idx + 1 : idx - 1;
    const target = enabled[(next + enabled.length) % enabled.length];
    if (target) onChange(target.value);
  };
  return /* @__PURE__ */ jsxRuntimeExports.jsxs(
    "div",
    {
      className: "t-segmented",
      role: "tablist",
      "aria-label": ariaLabel,
      onKeyDown,
      style: bare ? { background: "transparent", border: "none", padding: 0 } : void 0,
      children: [
        items.map((item) => {
          const active = item.value === value;
          const classes = ["t-segmented__item"];
          if (active) classes.push("t-segmented__item--active");
          return /* @__PURE__ */ jsxRuntimeExports.jsxs(
            "button",
            {
              type: "button",
              role: "tab",
              "aria-selected": active,
              disabled: item.disabled,
              tabIndex: active ? 0 : -1,
              className: classes.join(" "),
              onClick: () => onChange(item.value),
              children: [
                item.icon ? /* @__PURE__ */ jsxRuntimeExports.jsx(Icon, { name: item.icon, size: 14 }) : null,
                item.label,
                item.count !== void 0 ? /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "t-segmented__count", children: item.count }) : null
              ]
            },
            item.value
          );
        }),
        children
      ]
    }
  );
}
const KIND_ICON = {
  ssh: "terminal",
  rdp: "server",
  telnet: "server",
  tunnel: "route",
  vnc: "eye"
};
const KIND_LABEL = {
  ssh: "SSH",
  rdp: "RDP",
  telnet: "Telnet",
  tunnel: "隧道",
  vnc: "VNC"
};
const STATE_TEXT = {
  connecting: "连接中",
  authenticating: "认证中",
  "verifying-host-key": "校验指纹",
  ready: "已连接",
  disconnected: "已断开",
  failed: "失败"
};
function ListHeader({
  sortKey,
  sortDir,
  allSelected,
  someSelected,
  showInfo,
  onSelectAll
}) {
  const sortButton = (key, label) => {
    const active = sortKey === key;
    return /* @__PURE__ */ jsxRuntimeExports.jsxs(
      "button",
      {
        type: "button",
        className: `connlist__sort${active ? " connlist__sort--on" : ""}`,
        onClick: () => actions.setSort(key),
        title: `按${label}排序`,
        children: [
          label,
          active ? /* @__PURE__ */ jsxRuntimeExports.jsx(Icon, { name: sortDir === "asc" ? "chevron-down" : "chevron-right", size: 12 }) : null
        ]
      }
    );
  };
  return /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: `connlist__head connlist__grid${showInfo ? "" : " connlist__grid--nodetail"}`, children: [
    /* @__PURE__ */ jsxRuntimeExports.jsx(
      Checkbox,
      {
        bare: true,
        checked: allSelected,
        indeterminate: someSelected && !allSelected,
        ariaLabel: "全选",
        onChange: onSelectAll
      }
    ),
    /* @__PURE__ */ jsxRuntimeExports.jsx("span", { "aria-hidden": true }),
    sortButton("status", "状态"),
    sortButton("name", "名称"),
    sortButton("address", "地址"),
    showInfo ? /* @__PURE__ */ jsxRuntimeExports.jsx("span", { children: "详情" }) : null,
    /* @__PURE__ */ jsxRuntimeExports.jsx("span", { style: { textAlign: "right" }, children: "操作" })
  ] });
}
const Row = reactExports.memo(function Row2({ conn, selected, showInfo, ping, sessionState }) {
  const favorite = isFavorite(conn);
  const user = connectionUsername(conn);
  return /* @__PURE__ */ jsxRuntimeExports.jsxs(
    "div",
    {
      className: `connlist__row connlist__grid${showInfo ? "" : " connlist__grid--nodetail"}${selected ? " connlist__row--selected" : ""}`,
      draggable: true,
      onDragStart: (e) => {
        e.dataTransfer.setData(CONNECTION_DND_TYPE, conn.id);
        e.dataTransfer.effectAllowed = "move";
      },
      onDoubleClick: (e) => {
        if (e.target instanceof HTMLElement && e.target.closest("button, input, a, select")) return;
        void connectTo(conn);
      },
      children: [
        /* @__PURE__ */ jsxRuntimeExports.jsx(Checkbox, { bare: true, checked: selected, ariaLabel: `选择 ${conn.name}`, onChange: () => actions.toggleSelect(conn.id) }),
        /* @__PURE__ */ jsxRuntimeExports.jsx(
          IconButton,
          {
            icon: favorite ? "star-filled" : "star",
            label: favorite ? "取消收藏" : "加入收藏",
            size: 14,
            tone: favorite ? "on" : "default",
            onClick: () => toggleFavorite(conn.id)
          }
        ),
        /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "connlist__status", children: sessionState ? /* @__PURE__ */ jsxRuntimeExports.jsxs(jsxRuntimeExports.Fragment, { children: [
          /* @__PURE__ */ jsxRuntimeExports.jsx(
            StatusDot,
            {
              tone: sessionState === "ready" ? "ok" : sessionState === "failed" ? "danger" : "accent",
              pulse: sessionState === "connecting" || sessionState === "authenticating",
              label: STATE_TEXT[sessionState] ?? sessionState
            }
          ),
          /* @__PURE__ */ jsxRuntimeExports.jsx("span", { children: STATE_TEXT[sessionState] ?? sessionState })
        ] }) : /* @__PURE__ */ jsxRuntimeExports.jsxs(jsxRuntimeExports.Fragment, { children: [
          /* @__PURE__ */ jsxRuntimeExports.jsx(
            StatusDot,
            {
              tone: ping ? ping.reachable ? "ok" : "danger" : "muted",
              label: ping ? pingLabel(ping) : "未探测"
            }
          ),
          /* @__PURE__ */ jsxRuntimeExports.jsx(
            "span",
            {
              title: ping ? `${ping.method.toUpperCase()}${ping.reason ? ` · ${ping.reason}` : ""}` : "空闲。点工具条「探测延迟」测量",
              children: pingLabel(ping)
            }
          )
        ] }) }),
        /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "connlist__name", children: [
          /* @__PURE__ */ jsxRuntimeExports.jsx(Icon, { name: KIND_ICON[conn.kind], size: 15 }),
          /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { style: { minWidth: 0 }, children: [
            /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "connlist__name-text", title: conn.name, children: conn.name }),
            conn.note ? /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "connlist__note", title: conn.note, children: conn.note }) : null
          ] })
        ] }),
        /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "connlist__addr", title: connectionAddress(conn), children: connectionAddress(conn) }),
        showInfo ? /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "connlist__meta", children: [
          /* @__PURE__ */ jsxRuntimeExports.jsx(Badge, { tone: "outline", children: KIND_LABEL[conn.kind] }),
          user ? /* @__PURE__ */ jsxRuntimeExports.jsx(Badge, { children: user }) : null,
          conn.lastUsedAt ? /* @__PURE__ */ jsxRuntimeExports.jsxs(Badge, { tone: "accent", children: [
            "最近 ",
            formatRelativeTime(conn.lastUsedAt)
          ] }) : null
        ] }) : null,
        /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: `connlist__actions${selected ? " connlist__actions--pinned" : ""}`, children: [
          /* @__PURE__ */ jsxRuntimeExports.jsx(
            Button,
            {
              size: "sm",
              variant: "primary",
              disabled: false,
              title: "打开终端",
              onClick: () => void connectTo(conn),
              children: "连接"
            }
          ),
          /* @__PURE__ */ jsxRuntimeExports.jsx(IconButton, { icon: "edit", label: "编辑", onClick: () => actions.openEdit(conn.id) }),
          /* @__PURE__ */ jsxRuntimeExports.jsx(
            IconButton,
            {
              icon: "more",
              label: "更多操作",
              onClick: () => {
                actions.setSelection([conn.id]);
              }
            }
          )
        ] })
      ]
    }
  );
});
function ConnectionList({ items, showInfo }) {
  const { selected, tabs, pings } = useStoreShallow((s) => ({
    selected: s.selected,
    tabs: s.tabs,
    pings: s.pings
  }));
  const selectedSet = new Set(selected);
  const allSelected = items.length > 0 && items.every((c) => selectedSet.has(c.id));
  const someSelected = selected.length > 0;
  const sort = useStoreShallow((s) => ({ sortKey: s.sortKey, sortDir: s.sortDir }));
  const sessionStateOf = (connectionId) => {
    const tab = tabs.find((t) => t.connectionId === connectionId && t.state !== "idle");
    return tab?.state;
  };
  return /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "connlist", children: [
    /* @__PURE__ */ jsxRuntimeExports.jsx(
      ListHeader,
      {
        sortKey: sort.sortKey,
        sortDir: sort.sortDir,
        allSelected,
        someSelected,
        showInfo,
        onSelectAll: (checked) => {
          if (checked) actions.setSelection(items.map((c) => c.id));
          else actions.clearSelection();
        }
      }
    ),
    someSelected ? /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "connlist__bulk", children: [
      /* @__PURE__ */ jsxRuntimeExports.jsxs("span", { className: "connlist__bulk-count", children: [
        "已选 ",
        selected.length,
        " 项"
      ] }),
      /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "connlist__bulk-spacer" }),
      /* @__PURE__ */ jsxRuntimeExports.jsx(Button, { size: "sm", icon: "cloud", onClick: () => void duplicateConnections(selected), children: "复制" }),
      /* @__PURE__ */ jsxRuntimeExports.jsx(Button, { size: "sm", icon: "download", onClick: () => actions.setView("settings"), children: "导出" }),
      /* @__PURE__ */ jsxRuntimeExports.jsx(
        Button,
        {
          size: "sm",
          icon: "zap",
          onClick: () => {
            const targets = items.filter(
              (c) => selectedSet.has(c.id) && (c.kind === "ssh" || c.kind === "telnet")
            );
            if (targets.length === 0) {
              toast.warn("所选里没有可打开终端的 SSH / Telnet 连接");
              return;
            }
            actions.clearSelection();
            void connectManyAsGroup(targets);
          },
          children: "并发连接"
        }
      ),
      /* @__PURE__ */ jsxRuntimeExports.jsx(Button, { size: "sm", variant: "danger", icon: "trash", onClick: () => void deleteConnections(selected), children: "删除" }),
      /* @__PURE__ */ jsxRuntimeExports.jsx(IconButton, { icon: "close", label: "取消选择", onClick: () => actions.clearSelection() })
    ] }) : null,
    /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "connlist__body", children: /* @__PURE__ */ jsxRuntimeExports.jsx(
      VirtualList,
      {
        items,
        rowHeight: 46,
        className: "connlist__list",
        role: "grid",
        getKey: (c) => c.id,
        renderRow: (conn) => /* @__PURE__ */ jsxRuntimeExports.jsx(
          Row,
          {
            conn,
            selected: selectedSet.has(conn.id),
            showInfo,
            ping: pings[conn.id],
            sessionState: sessionStateOf(conn.id)
          }
        )
      }
    ) })
  ] });
}
const POLICY_OPTIONS = [
  { value: "skip", label: "跳过同名连接（默认，最保守）" },
  { value: "rename", label: "重命名后导入（保留两边）" },
  { value: "overwrite", label: "覆盖同名连接" }
];
function ImportOpenSshDialog({ onClose }) {
  const [path, setPath] = reactExports.useState("");
  const [policy, setPolicy] = reactExports.useState("skip");
  const [preview, setPreview] = reactExports.useState(null);
  const [result, setResult] = reactExports.useState(null);
  const [busy, setBusy] = reactExports.useState(false);
  const [error, setError] = reactExports.useState(null);
  const [lock, setLock] = reactExports.useState(null);
  const checkLock = reactExports.useCallback(async () => {
    try {
      const res = await invoke("store", "isUnlocked", {});
      setLock(res);
    } catch {
      setLock(null);
    }
  }, []);
  reactExports.useEffect(() => {
    void checkLock();
  }, [checkLock]);
  const doPreview = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await invoke(
        "store",
        "importOpenSsh",
        {
          ...path.trim() ? { path: path.trim() } : {},
          dryRun: true,
          conflictPolicy: policy
        }
      );
      setPreview(res);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  const doImport = async () => {
    const ok = await ensureUnlocked("导入 OpenSSH 配置会把私钥写入本地库，需要先解锁。");
    if (!ok) {
      toast.warn("未解锁本地库，导入已取消（避免私钥被丢弃）");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await invoke(
        "store",
        "importOpenSsh",
        {
          ...path.trim() ? { path: path.trim() } : {},
          conflictPolicy: policy
        }
      );
      setResult(res);
      await loadConnections(true);
      toast.ok(
        `导入完成：新增 ${res.created}，跳过 ${res.skipped}，重命名 ${res.renamed}，覆盖 ${res.overwritten}`
      );
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  const shown = result ?? preview;
  const locked = lock !== null && !lock.unlocked;
  return /* @__PURE__ */ jsxRuntimeExports.jsxs(
    Modal,
    {
      open: true,
      size: "lg",
      title: "导入 OpenSSH 配置",
      subtitle: "先预览、再导入；不会修改你的 ~/.ssh/config",
      onClose,
      footer: /* @__PURE__ */ jsxRuntimeExports.jsxs(jsxRuntimeExports.Fragment, { children: [
        shown ? /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "form-footer-hint", children: shown.dryRun ? "这是预览，尚未写入" : `已写入：新增 ${shown.created} 条` }) : null,
        /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "t-modal__footer-spacer" }),
        /* @__PURE__ */ jsxRuntimeExports.jsx(Button, { variant: "ghost", onClick: onClose, children: "关闭" }),
        /* @__PURE__ */ jsxRuntimeExports.jsx(Button, { variant: "outline", icon: "search", loading: busy, onClick: () => void doPreview(), children: preview ? "重新预览" : "预览" }),
        /* @__PURE__ */ jsxRuntimeExports.jsx(
          Button,
          {
            variant: "primary",
            icon: "download",
            loading: busy,
            disabled: !preview || result !== null,
            onClick: () => void doImport(),
            children: "确认导入"
          }
        )
      ] }),
      children: [
        locked ? /* @__PURE__ */ jsxRuntimeExports.jsx("div", { style: { marginBottom: 14 }, children: /* @__PURE__ */ jsxRuntimeExports.jsxs(Banner, { tone: "info", children: [
          "本地库当前**已锁定**。点「确认导入」会先引导你",
          lock && !lock.initialized ? "创建主密码" : "解锁",
          "—— 未解锁时导入会让私钥被丢弃，所以后端改成直接报错而不是静默丢弃。 预览不受影响，可以先看完再决定。"
        ] }) }) : null,
        /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "t-grid t-grid--2", children: [
          /* @__PURE__ */ jsxRuntimeExports.jsx(
            Field,
            {
              label: "配置文件路径",
              hint: "留空则读取 ~/.ssh/config。也可以指向任意一份 OpenSSH 格式的配置。",
              children: /* @__PURE__ */ jsxRuntimeExports.jsx(
                TextInput,
                {
                  value: path,
                  mono: true,
                  placeholder: "~/.ssh/config",
                  onChange: (e) => setPath(e.target.value)
                }
              )
            }
          ),
          /* @__PURE__ */ jsxRuntimeExports.jsx(Field, { label: "同名连接的处理方式", hint: "默认跳过，避免意外覆盖已有连接", children: /* @__PURE__ */ jsxRuntimeExports.jsx(Select, { value: policy, onChange: (e) => setPolicy(e.target.value), options: POLICY_OPTIONS }) })
        ] }),
        error ? /* @__PURE__ */ jsxRuntimeExports.jsx("div", { style: { marginTop: 14 }, children: /* @__PURE__ */ jsxRuntimeExports.jsx(Banner, { tone: "error", children: error }) }) : null,
        busy && !shown ? /* @__PURE__ */ jsxRuntimeExports.jsx(Loading, { text: "解析中…" }) : null,
        shown ? /* @__PURE__ */ jsxRuntimeExports.jsxs(jsxRuntimeExports.Fragment, { children: [
          /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { style: { display: "flex", gap: 8, flexWrap: "wrap", marginTop: 16, alignItems: "center" }, children: [
            /* @__PURE__ */ jsxRuntimeExports.jsxs(Badge, { tone: "accent", children: [
              "解析到 ",
              shown.parsed,
              " 个 Host"
            ] }),
            shown.dryRun ? /* @__PURE__ */ jsxRuntimeExports.jsx(Badge, { children: "预览（未写入）" }) : /* @__PURE__ */ jsxRuntimeExports.jsxs(jsxRuntimeExports.Fragment, { children: [
              /* @__PURE__ */ jsxRuntimeExports.jsxs(Badge, { tone: "ok", children: [
                "新增 ",
                shown.created
              ] }),
              shown.skipped > 0 ? /* @__PURE__ */ jsxRuntimeExports.jsxs(Badge, { tone: "warn", children: [
                "跳过 ",
                shown.skipped
              ] }) : null,
              shown.renamed > 0 ? /* @__PURE__ */ jsxRuntimeExports.jsxs(Badge, { children: [
                "重命名 ",
                shown.renamed
              ] }) : null,
              shown.overwritten > 0 ? /* @__PURE__ */ jsxRuntimeExports.jsxs(Badge, { tone: "warn", children: [
                "覆盖 ",
                shown.overwritten
              ] }) : null
            ] }),
            /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "metric__sub mono", children: shown.source })
          ] }),
          shown.entries.length > 0 ? /* @__PURE__ */ jsxRuntimeExports.jsxs(jsxRuntimeExports.Fragment, { children: [
            /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "t-field__label", style: { marginTop: 16, marginBottom: 5 }, children: "将导入的连接" }),
            /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "sshimp__list", children: shown.entries.map((e) => /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "sshimp__row", children: [
              /* @__PURE__ */ jsxRuntimeExports.jsx("span", { children: e.name }),
              /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "mono", children: e.host }),
              /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "mono", children: e.port }),
              e.username ? /* @__PURE__ */ jsxRuntimeExports.jsxs("span", { className: "t-field__hint", children: [
                "用户 ",
                e.username
              ] }) : null,
              e.warnings && e.warnings.length > 0 ? /* @__PURE__ */ jsxRuntimeExports.jsxs("span", { className: "t-field__hint", style: { gridColumn: "1 / -1" }, children: [
                "⚠ ",
                e.warnings.join("；")
              ] }) : null
            ] }, `${e.name}-${e.host}`)) })
          ] }) : null,
          shown.unsupported.length > 0 ? /* @__PURE__ */ jsxRuntimeExports.jsxs(jsxRuntimeExports.Fragment, { children: [
            /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "t-field__label", style: { marginTop: 16, marginBottom: 5 }, children: [
              /* @__PURE__ */ jsxRuntimeExports.jsx(Icon, { name: "alert-triangle", size: 12 }),
              " 未支持的指令（",
              shown.unsupported.length,
              "）"
            ] }),
            /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "sshimp__list", children: shown.unsupported.map((u, i) => /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "sshimp__row sshimp__row--bad", children: [
              /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "mono", children: u.directive }),
              /* @__PURE__ */ jsxRuntimeExports.jsx("span", { children: u.host ?? "（全局）" }),
              /* @__PURE__ */ jsxRuntimeExports.jsx("span", {}),
              u.reason ? /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "t-field__hint", style: { gridColumn: "1 / -1" }, children: u.reason }) : null
            ] }, `${u.directive}-${i}`)) }),
            /* @__PURE__ */ jsxRuntimeExports.jsx("p", { className: "t-field__hint", children: "这些指令的语义**没有被导入**，对应连接可能需要手工补齐。" })
          ] }) : null,
          shown.errors.length > 0 ? /* @__PURE__ */ jsxRuntimeExports.jsxs(jsxRuntimeExports.Fragment, { children: [
            /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "t-field__label", style: { marginTop: 16, marginBottom: 5 }, children: [
              /* @__PURE__ */ jsxRuntimeExports.jsx(Icon, { name: "alert-circle", size: 12 }),
              " 解析错误（",
              shown.errors.length,
              "）"
            ] }),
            /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "sshimp__list", children: shown.errors.map((e, i) => /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "sshimp__row sshimp__row--bad", children: [
              /* @__PURE__ */ jsxRuntimeExports.jsxs("span", { children: [
                "第 ",
                e.line,
                " 行"
              ] }),
              /* @__PURE__ */ jsxRuntimeExports.jsx("span", { style: { gridColumn: "2 / -1" }, children: e.message }),
              e.text ? /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "mono", style: { gridColumn: "1 / -1" }, children: e.text }) : null
            ] }, `${e.line}-${i}`)) })
          ] }) : null,
          shown.entries.length === 0 ? /* @__PURE__ */ jsxRuntimeExports.jsx("p", { className: "t-field__hint", style: { marginTop: 14 }, children: "没有解析到任何 Host。请确认路径正确、且文件里有 `Host` 段。" }) : null
        ] }) : null
      ]
    }
  );
}
const ConnectionForm = reactExports.lazy(() => __vitePreload(() => import("./ConnectionForm-a_G18MTu.js"), true ? __vite__mapDeps([0,1,2,3,4]) : void 0, import.meta.url));
function ConnectionsView() {
  const { query, filter, showInfo, protocol, loading, loaded, backendReady, backendError, editing, busy, pingBusy } = useStoreShallow((s) => ({
    query: s.query,
    filter: s.filter,
    showInfo: s.showInfo,
    protocol: s.protocol,
    loading: s.loading,
    loaded: s.loaded,
    backendReady: s.backendReady,
    backendError: s.backendError,
    editing: s.editing,
    busy: s.busy,
    pingBusy: s.pingBusy
  }));
  const { items, totalInProtocol } = useStore(selectVisibleConnections);
  const counts = useStore(selectProtocolCounts);
  const [importOpen, setImportOpen] = reactExports.useState(false);
  const hasAny = counts.ssh + counts.rdp + counts.telnet + counts.tunnel + counts.vnc > 0;
  const filtered = filter !== "__all__" || query.trim().length > 0;
  const segments = reactExports.useMemo(
    () => PROTOCOLS.map((p) => ({ value: p.value, label: p.label, count: counts[p.value] })),
    [counts]
  );
  return /* @__PURE__ */ jsxRuntimeExports.jsxs("main", { className: "content", "aria-label": "连接列表", children: [
    /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "connlist__protocols", children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx(
        Segmented,
        {
          items: segments,
          value: protocol,
          onChange: (v) => actions.setProtocol(v),
          ariaLabel: "连接协议"
        }
      ),
      /* @__PURE__ */ jsxRuntimeExports.jsx("div", { style: { flex: 1 } })
    ] }),
    /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "t-toolbar", children: [
      /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "t-search", children: [
        /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "t-search__icon", children: /* @__PURE__ */ jsxRuntimeExports.jsxs("svg", { width: "14", height: "14", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.9", strokeLinecap: "round", children: [
          /* @__PURE__ */ jsxRuntimeExports.jsx("circle", { cx: "11", cy: "11", r: "6.2" }),
          /* @__PURE__ */ jsxRuntimeExports.jsx("path", { d: "M15.7 15.7l4.3 4.3" })
        ] }) }),
        /* @__PURE__ */ jsxRuntimeExports.jsx(
          "input",
          {
            className: "t-input",
            value: query,
            placeholder: "搜索名称、地址、用户或备注…",
            "aria-label": "搜索连接",
            onChange: (e) => actions.setQuery(e.target.value)
          }
        ),
        query ? /* @__PURE__ */ jsxRuntimeExports.jsx(
          "button",
          {
            type: "button",
            className: "t-iconbtn t-search__clear",
            "aria-label": "清空搜索",
            onClick: () => actions.setQuery(""),
            children: "✕"
          }
        ) : null
      ] }),
      /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "t-toolbar__spacer" }),
      /* @__PURE__ */ jsxRuntimeExports.jsx(Switch, { checked: showInfo, onChange: () => actions.toggleShowInfo(), label: "详情列" }),
      /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "t-toolbar__divider" }),
      /* @__PURE__ */ jsxRuntimeExports.jsx(
        Button,
        {
          size: "sm",
          variant: "ghost",
          icon: "activity",
          loading: pingBusy,
          title: "对当前列表做一次延迟探测（15 秒内不会重复探测）",
          onClick: () => void probeLatency(void 0, true),
          children: "探测延迟"
        }
      ),
      /* @__PURE__ */ jsxRuntimeExports.jsx(
        Button,
        {
          size: "sm",
          variant: "ghost",
          icon: "refresh",
          loading,
          onClick: () => {
            void loadConnections(true);
            void probeLatency();
          },
          children: "刷新"
        }
      ),
      /* @__PURE__ */ jsxRuntimeExports.jsx(Button, { size: "sm", variant: "outline", icon: "upload", onClick: () => setImportOpen(true), children: "导入配置" }),
      /* @__PURE__ */ jsxRuntimeExports.jsx(Button, { size: "sm", variant: "primary", icon: "plus", onClick: () => actions.openCreate(protocol), children: createConnectionLabel(protocol) })
    ] }),
    busy ? /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "connlist__bulk", children: [
      /* @__PURE__ */ jsxRuntimeExports.jsxs("span", { className: "connlist__bulk-count", children: [
        busy.label,
        " ",
        busy.done,
        "/",
        busy.total
      ] }),
      /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "connlist__bulk-spacer" })
    ] }) : null,
    !backendReady && loaded ? /* @__PURE__ */ jsxRuntimeExports.jsx("div", { style: { padding: "10px 12px 0" }, children: /* @__PURE__ */ jsxRuntimeExports.jsxs(Banner, { tone: "warn", actions: /* @__PURE__ */ jsxRuntimeExports.jsx(Button, { size: "sm", onClick: () => void loadConnections(true), children: "重试" }), children: [
      "存储服务暂时不可用",
      backendError ? `（${backendError}）` : "",
      "。可以继续浏览界面，但改动不会落库。"
    ] }) }) : null,
    loading && !loaded ? /* @__PURE__ */ jsxRuntimeExports.jsx(Loading, { text: "正在读取连接…" }) : !hasAny ? /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "conn-empty", children: /* @__PURE__ */ jsxRuntimeExports.jsx(
      EmptyState,
      {
        icon: "server",
        title: "还没有任何连接",
        text: `点「${createConnectionLabel(protocol)}」。填好地址、端口与凭据后保存，双击列表项即可打开终端。`,
        actions: /* @__PURE__ */ jsxRuntimeExports.jsxs(jsxRuntimeExports.Fragment, { children: [
          /* @__PURE__ */ jsxRuntimeExports.jsx(Button, { variant: "primary", icon: "plus", onClick: () => actions.openCreate(protocol), children: createConnectionLabel(protocol) }),
          null
        ] })
      }
    ) }) : items.length === 0 ? /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "conn-empty", children: /* @__PURE__ */ jsxRuntimeExports.jsx(
      EmptyState,
      {
        icon: "filter",
        title: "没有匹配的连接",
        text: filtered ? "当前的分组筛选或搜索条件下没有结果。" : `${protocolLabel(protocol)} 分类下还没有连接。`,
        actions: /* @__PURE__ */ jsxRuntimeExports.jsxs(jsxRuntimeExports.Fragment, { children: [
          filtered ? /* @__PURE__ */ jsxRuntimeExports.jsx(
            Button,
            {
              variant: "outline",
              onClick: () => {
                actions.setFilter("__all__");
                actions.setQuery("");
              },
              children: "清除筛选"
            }
          ) : null,
          /* @__PURE__ */ jsxRuntimeExports.jsx(Button, { variant: "primary", icon: "plus", onClick: () => actions.openCreate(protocol), children: createConnectionLabel(protocol) })
        ] })
      }
    ) }) : /* @__PURE__ */ jsxRuntimeExports.jsx(ConnectionList, { items, showInfo }),
    editing ? /* @__PURE__ */ jsxRuntimeExports.jsx(reactExports.Suspense, { fallback: /* @__PURE__ */ jsxRuntimeExports.jsx(Loading, { text: "正在载入表单…" }), children: /* @__PURE__ */ jsxRuntimeExports.jsx(ConnectionForm, {}) }) : null,
    importOpen ? /* @__PURE__ */ jsxRuntimeExports.jsx(reactExports.Suspense, { fallback: /* @__PURE__ */ jsxRuntimeExports.jsx(Loading, { text: "载入导入器…" }), children: /* @__PURE__ */ jsxRuntimeExports.jsx(ImportOpenSshDialog, { onClose: () => setImportOpen(false) }) }) : null,
    /* @__PURE__ */ jsxRuntimeExports.jsxs("span", { className: "sr-only", "aria-live": "polite", children: [
      "共 ",
      totalInProtocol,
      " 条连接，当前显示 ",
      items.length,
      " 条"
    ] })
  ] });
}
export {
  ConnectionsView as default
};
