import { u as useStoreShallow, r as reactExports, j as jsxRuntimeExports, n as IconButton, D as loadConnections, f as Banner, a as actions, au as FILTER_ALL, av as FILTER_FAVORITE, aw as FILTER_RECENT, ax as FILTER_FREQUENT, ay as moveConnection, h as Button, I as Icon, M as Modal, F as Field, T as TextInput, z as Select, az as newConnectionId, aA as saveGroup } from "./index-CwfghMy4.js";
const PROTOCOLS = [
  { value: "ssh", label: "SSH" },
  { value: "rdp", label: "RDP" },
  { value: "telnet", label: "Telnet" },
  { value: "tunnel", label: "隧道" },
  { value: "vnc", label: "VNC" }
];
function protocolLabel(kind) {
  return PROTOCOLS.find((p) => p.value === kind)?.label ?? kind.toUpperCase();
}
function createConnectionLabel(kind) {
  const label = protocolLabel(kind);
  return /^[A-Za-z0-9-]+$/.test(label) ? `新建 ${label} 连接` : `新建${label}连接`;
}
const CONNECTION_DND_TYPE = "application/x-t1000-connection";
function useCounts() {
  const connections = useStoreShallow(
    reactExports.useMemo(() => (s) => ({ connections: s.connections }), [])
  ).connections;
  const protocol = useStoreShallow(
    reactExports.useMemo(() => (s) => ({ protocol: s.protocol }), [])
  ).protocol;
  return reactExports.useMemo(() => {
    const byGroup = /* @__PURE__ */ new Map();
    let all = 0;
    let favorite = 0;
    let recent = 0;
    let frequent = 0;
    const now = Date.now();
    for (const conn of connections) {
      if (conn.kind !== protocol) continue;
      all += 1;
      if (conn.favorite) favorite += 1;
      if (conn.lastUsedAt) {
        const t = Date.parse(conn.lastUsedAt);
        if (Number.isFinite(t) && now - t <= 7 * 864e5) recent += 1;
      }
      if (conn.useCount && conn.useCount > 0) frequent += 1;
      if (conn.groupId) byGroup.set(conn.groupId, (byGroup.get(conn.groupId) ?? 0) + 1);
    }
    return { all, favorite, recent, frequent, byGroup };
  }, [connections, protocol]);
}
function subtreeCount(node, byGroup) {
  let total = byGroup.get(node.id) ?? 0;
  for (const child of node.children) total += subtreeCount(child, byGroup);
  return total;
}
function FilterRow({ icon, label, count, active, onClick }) {
  return /* @__PURE__ */ jsxRuntimeExports.jsxs(
    "button",
    {
      type: "button",
      className: `tree__row${active ? " tree__row--active" : ""}`,
      onClick,
      "aria-current": active || void 0,
      children: [
        /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "tree__twisty tree__twisty--leaf", "aria-hidden": true, children: /* @__PURE__ */ jsxRuntimeExports.jsx(Icon, { name: "chevron-right", size: 12 }) }),
        /* @__PURE__ */ jsxRuntimeExports.jsx(Icon, { name: icon, size: 14 }),
        /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "tree__label", children: label }),
        /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "tree__count", children: count })
      ]
    }
  );
}
function GroupRow({
  node,
  depth,
  byGroup,
  filter,
  expanded,
  onToggle,
  onDropConnection
}) {
  const [dropActive, setDropActive] = reactExports.useState(false);
  const isOpen = expanded.has(node.id);
  const hasChildren = node.children.length > 0;
  const active = filter === node.id;
  const count = subtreeCount(node, byGroup);
  const onDragOver = (e) => {
    if (!e.dataTransfer.types.includes(CONNECTION_DND_TYPE)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDropActive(true);
  };
  return /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "tree__group", children: [
    /* @__PURE__ */ jsxRuntimeExports.jsx(
      "div",
      {
        onDragOver,
        onDragLeave: () => setDropActive(false),
        onDrop: (e) => {
          setDropActive(false);
          const id = e.dataTransfer.getData(CONNECTION_DND_TYPE);
          if (!id) return;
          e.preventDefault();
          onDropConnection(id, node.id);
        },
        children: /* @__PURE__ */ jsxRuntimeExports.jsxs(
          "div",
          {
            className: `tree__row${active ? " tree__row--active" : ""}${dropActive ? " tree__row--drop" : ""}`,
            style: { paddingLeft: 8 + depth * 13 },
            onClick: () => actions.setFilter(node.id),
            onKeyDown: (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                actions.setFilter(node.id);
              }
            },
            role: "treeitem",
            "aria-expanded": hasChildren ? isOpen : void 0,
            "aria-selected": active,
            tabIndex: 0,
            children: [
              /* @__PURE__ */ jsxRuntimeExports.jsx(
                "span",
                {
                  className: `tree__twisty${isOpen ? " tree__twisty--open" : ""}${hasChildren ? "" : " tree__twisty--leaf"}`,
                  "aria-hidden": true,
                  onClick: (e) => {
                    e.stopPropagation();
                    onToggle(node.id);
                  },
                  children: /* @__PURE__ */ jsxRuntimeExports.jsx(Icon, { name: "chevron-right", size: 12 })
                }
              ),
              /* @__PURE__ */ jsxRuntimeExports.jsx(Icon, { name: isOpen && hasChildren ? "folder-open" : "folder", size: 14 }),
              /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "tree__label", title: node.name, children: node.name }),
              /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "tree__count", children: count })
            ]
          }
        )
      }
    ),
    hasChildren && isOpen ? /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "tree__children", role: "group", children: node.children.map((child) => /* @__PURE__ */ jsxRuntimeExports.jsx(
      GroupRow,
      {
        node: child,
        depth: depth + 1,
        byGroup,
        filter,
        expanded,
        onToggle,
        onDropConnection
      },
      child.id
    )) }) : null
  ] });
}
function GroupDialog({
  open,
  groups,
  defaultParentId,
  onClose
}) {
  const [name, setName] = reactExports.useState("");
  const [parentId, setParentId] = reactExports.useState(defaultParentId ?? "");
  const [busy, setBusy] = reactExports.useState(false);
  const [error, setError] = reactExports.useState(null);
  const flat = reactExports.useMemo(() => {
    const out = [];
    const walk = (nodes, depth) => {
      for (const n of nodes) {
        out.push({ id: n.id, label: n.name, depth });
        walk(n.children, depth + 1);
      }
    };
    walk(groups, 0);
    return out;
  }, [groups]);
  const submit = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setError("分组名不能为空");
      return;
    }
    setBusy(true);
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const group = {
      id: newConnectionId(),
      name: trimmed,
      kind: "ssh",
      sortOrder: flat.length,
      storeType: "local",
      createdAt: now,
      updatedAt: now,
      ...parentId ? { parentId } : {}
    };
    const ok = await saveGroup(group);
    setBusy(false);
    if (ok) {
      setName("");
      onClose();
    } else {
      setError("保存失败，请检查存储是否可用");
    }
  };
  return /* @__PURE__ */ jsxRuntimeExports.jsx(
    Modal,
    {
      open,
      size: "sm",
      title: "新建分组",
      onClose,
      footer: /* @__PURE__ */ jsxRuntimeExports.jsxs(jsxRuntimeExports.Fragment, { children: [
        /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "t-modal__footer-spacer" }),
        /* @__PURE__ */ jsxRuntimeExports.jsx(Button, { variant: "ghost", onClick: onClose, children: "取消" }),
        /* @__PURE__ */ jsxRuntimeExports.jsx(Button, { variant: "primary", loading: busy, onClick: () => void submit(), children: "创建" })
      ] }),
      children: /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "t-grid", children: [
        /* @__PURE__ */ jsxRuntimeExports.jsx(Field, { label: "分组名称", required: true, error, children: /* @__PURE__ */ jsxRuntimeExports.jsx(
          TextInput,
          {
            value: name,
            placeholder: "例如：生产环境 / Web 集群",
            onChange: (e) => {
              setName(e.target.value);
              setError(null);
            },
            onKeyDown: (e) => {
              if (e.key === "Enter") void submit();
            }
          }
        ) }),
        /* @__PURE__ */ jsxRuntimeExports.jsx(Field, { label: "上级分组", hint: "留空则创建为顶层分组", children: /* @__PURE__ */ jsxRuntimeExports.jsx(
          Select,
          {
            value: parentId,
            onChange: (e) => setParentId(e.target.value),
            options: [
              { value: "", label: "（顶层）" },
              ...flat.map((g) => ({ value: g.id, label: `${"　".repeat(g.depth)}${g.label}` }))
            ]
          }
        ) })
      ] })
    }
  );
}
function ConnectionsSidebar() {
  const { groups, filter, protocol, backendReady, backendError, loaded } = useStoreShallow((s) => ({
    groups: s.groups,
    filter: s.filter,
    protocol: s.protocol,
    backendReady: s.backendReady,
    backendError: s.backendError,
    loaded: s.loaded
  }));
  const counts = useCounts();
  const [expanded, setExpanded] = reactExports.useState(/* @__PURE__ */ new Set());
  const [dialogOpen, setDialogOpen] = reactExports.useState(false);
  const toggle = (id) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const expandAll = () => {
    const ids = [];
    const walk = (nodes) => {
      for (const n of nodes) {
        if (n.children.length > 0) ids.push(n.id);
        walk(n.children);
      }
    };
    walk(groups);
    setExpanded(new Set(ids));
  };
  const collapseAll = () => setExpanded(/* @__PURE__ */ new Set());
  return /* @__PURE__ */ jsxRuntimeExports.jsxs("aside", { className: "panel", "aria-label": "连接分组", children: [
    /* @__PURE__ */ jsxRuntimeExports.jsxs("header", { className: "panel-header", children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "panel-title", children: "连接中心" }),
      /* @__PURE__ */ jsxRuntimeExports.jsx(IconButton, { icon: "refresh", label: "刷新列表", onClick: () => void loadConnections(true) })
    ] }),
    /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "panel-body", children: [
      !backendReady && loaded ? /* @__PURE__ */ jsxRuntimeExports.jsx("div", { style: { padding: 8 }, children: /* @__PURE__ */ jsxRuntimeExports.jsxs(Banner, { tone: "warn", children: [
        "存储服务不可用",
        backendError ? `：${backendError}` : "",
        /* @__PURE__ */ jsxRuntimeExports.jsx("br", {}),
        "当前展示的是内存数据，重启后不保留。"
      ] }) }) : null,
      /* @__PURE__ */ jsxRuntimeExports.jsxs("nav", { className: "tree", role: "tree", "aria-label": "分组树", children: [
        /* @__PURE__ */ jsxRuntimeExports.jsx(
          FilterRow,
          {
            icon: "server",
            label: "全部",
            count: counts.all,
            active: filter === FILTER_ALL,
            onClick: () => actions.setFilter(FILTER_ALL)
          }
        ),
        /* @__PURE__ */ jsxRuntimeExports.jsx(
          FilterRow,
          {
            icon: "star-filled",
            label: "收藏",
            count: counts.favorite,
            active: filter === FILTER_FAVORITE,
            onClick: () => actions.setFilter(FILTER_FAVORITE)
          }
        ),
        /* @__PURE__ */ jsxRuntimeExports.jsx(
          FilterRow,
          {
            icon: "clock",
            label: "最近",
            count: counts.recent,
            active: filter === FILTER_RECENT,
            onClick: () => actions.setFilter(FILTER_RECENT)
          }
        ),
        /* @__PURE__ */ jsxRuntimeExports.jsx(
          FilterRow,
          {
            icon: "zap",
            label: "常用",
            count: counts.frequent,
            active: filter === FILTER_FREQUENT,
            onClick: () => actions.setFilter(FILTER_FREQUENT)
          }
        ),
        /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "tree__section", children: "自定义分组" }),
        groups.length === 0 ? /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "tree__empty", children: "还没有分组。用下方「+ 分组」把连接按环境或用途归类。" }) : groups.map((node) => /* @__PURE__ */ jsxRuntimeExports.jsx(
          GroupRow,
          {
            node,
            depth: 0,
            byGroup: counts.byGroup,
            filter,
            expanded,
            onToggle: toggle,
            onDropConnection: (connectionId, groupId) => void moveConnection(connectionId, groupId)
          },
          node.id
        ))
      ] })
    ] }),
    /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "panel-footer", children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx(
        IconButton,
        {
          icon: "chevron-down",
          label: "全部折叠",
          onClick: () => {
            collapseAll();
          }
        }
      ),
      /* @__PURE__ */ jsxRuntimeExports.jsx(
        IconButton,
        {
          icon: "chevron-right",
          label: "全部展开",
          onClick: () => {
            expandAll();
          }
        }
      ),
      /* @__PURE__ */ jsxRuntimeExports.jsx("div", { style: { flex: 1 } }),
      /* @__PURE__ */ jsxRuntimeExports.jsx(IconButton, { icon: "folder", label: "新建分组", onClick: () => setDialogOpen(true) }),
      /* @__PURE__ */ jsxRuntimeExports.jsx(Button, { size: "sm", variant: "outline", icon: "plus", onClick: () => actions.openCreate(protocol), children: createConnectionLabel(protocol) })
    ] }),
    /* @__PURE__ */ jsxRuntimeExports.jsx(
      GroupDialog,
      {
        open: dialogOpen,
        groups,
        defaultParentId: null,
        onClose: () => setDialogOpen(false)
      }
    )
  ] });
}
const ConnectionsSidebar$1 = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  CONNECTION_DND_TYPE,
  ConnectionsSidebar
}, Symbol.toStringTag, { value: "Module" }));
export {
  CONNECTION_DND_TYPE as C,
  PROTOCOLS as P,
  ConnectionsSidebar$1 as a,
  createConnectionLabel as c,
  protocolLabel as p
};
