import { u as useStoreShallow, r as reactExports, e as errorText, a as actions, s as setActiveTab, j as jsxRuntimeExports, I as Icon, B as Badge, i as invoke, c as connectTo, o as openNote } from "./index-CwfghMy4.js";
import { S as SECTION_META, a as SETTINGS_FIELDS } from "./settingsFields-CuEHNuxM.js";
const GROUP_ORDER = ["会话", "连接", "分组", "笔记", "设置"];
const PER_GROUP = 6;
async function searchConnections(keyword) {
  try {
    const list = await invoke(
      "store",
      "search",
      { keyword, limit: PER_GROUP * 2 }
    );
    return (Array.isArray(list) ? list : []).slice(0, PER_GROUP).map((c) => ({
      id: `conn-${c.id}`,
      group: "连接",
      title: c.name,
      subtitle: `${c.kind.toUpperCase()} · ${"host" in c ? String(c.host) : ""}${"port" in c ? `:${String(c.port)}` : ""}`,
      icon: c.kind === "ssh" ? "terminal" : c.kind === "vnc" ? "eye" : "server",
      run: () => void connectTo(c)
    }));
  } catch {
    return [];
  }
}
async function searchNotes(keyword) {
  try {
    const list = await invoke("notes", "list", {
      keyword
    });
    return (Array.isArray(list) ? list : []).slice(0, PER_GROUP).map((n) => ({
      id: `note-${n.id}`,
      group: "笔记",
      title: n.title || "（无标题）",
      subtitle: n.folderId ? "已归类" : "未归类",
      icon: "notes",
      run: () => {
        actions.setView("notes");
        void openNote(n.id);
      }
    }));
  } catch {
    return [];
  }
}
function GlobalSearch({ onClose }) {
  const { tabs, groups } = useStoreShallow((s) => ({ tabs: s.tabs, groups: s.groups }));
  const [query, setQuery] = reactExports.useState("");
  const [remote, setRemote] = reactExports.useState({ conn: [], notes: [] });
  const [loading, setLoading] = reactExports.useState(false);
  const [cursor, setCursor] = reactExports.useState(0);
  const [error, setError] = reactExports.useState(null);
  const inputRef = reactExports.useRef(null);
  const seqRef = reactExports.useRef(0);
  const listRef = reactExports.useRef(null);
  reactExports.useEffect(() => {
    inputRef.current?.focus();
  }, []);
  reactExports.useEffect(() => {
    const q = query.trim();
    if (!q) {
      setRemote({ conn: [], notes: [] });
      setError(null);
      return;
    }
    const seq = ++seqRef.current;
    setLoading(true);
    const t = window.setTimeout(() => {
      void Promise.all([searchConnections(q), searchNotes(q)]).then(([conn, notes]) => {
        if (seq !== seqRef.current) return;
        setRemote({ conn, notes });
        setError(null);
      }).catch((e) => {
        if (seq === seqRef.current) setError(errorText(e));
      }).finally(() => {
        if (seq === seqRef.current) setLoading(false);
      });
    }, 180);
    return () => window.clearTimeout(t);
  }, [query]);
  const localHits = reactExports.useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const hits = [];
    for (const tab of tabs.slice(0, PER_GROUP)) {
      if (!tab.title.toLowerCase().includes(q) && !(tab.subtitle ?? "").toLowerCase().includes(q)) continue;
      hits.push({
        id: `tab-${tab.tabId}`,
        group: "会话",
        title: tab.title,
        subtitle: `${tab.subtitle ?? ""}${tab.state === "ready" ? " · 已连接" : ` · ${tab.state}`}`,
        icon: "console",
        run: () => {
          actions.setView("console");
          setActiveTab(tab.tabId);
        }
      });
    }
    for (const g of groups) {
      if (!g.name.toLowerCase().includes(q)) continue;
      hits.push({
        id: `group-${g.id}`,
        group: "分组",
        title: g.name,
        subtitle: "在连接中心按该分组筛选",
        icon: "folder",
        run: () => {
          actions.setView("connections");
          actions.setFilter(g.id);
        }
      });
    }
    for (const [section, meta] of Object.entries(SECTION_META)) {
      const fields = section === "highlights" || section === "hotkeys" || section === "vault" ? [] : SETTINGS_FIELDS[section] ?? [];
      for (const f of fields) {
        const hay = `${f.label} ${f.hint ?? ""} ${f.path}`.toLowerCase();
        if (!hay.includes(q)) continue;
        hits.push({
          id: `set-${f.path}`,
          group: "设置",
          title: f.label,
          subtitle: `${meta.label} · ${f.path}`,
          icon: "settings",
          run: () => {
            actions.setView("settings");
            actions.setSettingsSection(section);
          }
        });
        if (hits.filter((h) => h.group === "设置").length >= PER_GROUP) break;
      }
      if (meta.label.toLowerCase().includes(q) && !hits.some((h) => h.id === `setsec-${section}`)) {
        hits.push({
          id: `setsec-${section}`,
          group: "设置",
          title: meta.label,
          subtitle: meta.blurb,
          icon: "settings",
          run: () => {
            actions.setView("settings");
            actions.setSettingsSection(section);
          }
        });
      }
    }
    return hits;
  }, [query, tabs, groups]);
  const grouped = reactExports.useMemo(() => {
    const all = [...remote.conn, ...localHits, ...remote.notes];
    const byGroup = /* @__PURE__ */ new Map();
    for (const h of all) {
      const list = byGroup.get(h.group) ?? [];
      list.push(h);
      byGroup.set(h.group, list);
    }
    return GROUP_ORDER.map((g) => ({ group: g, hits: byGroup.get(g) ?? [] })).filter(
      (x) => x.hits.length > 0
    );
  }, [remote, localHits]);
  const flat = reactExports.useMemo(() => grouped.flatMap((g) => g.hits), [grouped]);
  reactExports.useEffect(() => {
    setCursor(0);
  }, [query]);
  reactExports.useEffect(() => {
    listRef.current?.querySelector(".gs-item--active")?.scrollIntoView({ block: "nearest" });
  }, [cursor]);
  const runHit = reactExports.useCallback(
    (hit) => {
      if (!hit) return;
      onClose();
      void Promise.resolve(hit.run()).catch((e) => errorText(e));
    },
    [onClose]
  );
  const onKeyDown = (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setCursor((c) => flat.length === 0 ? 0 : (c + 1) % flat.length);
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setCursor((c) => flat.length === 0 ? 0 : (c - 1 + flat.length) % flat.length);
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      runHit(flat[cursor]);
    }
  };
  const hasQuery = query.trim().length > 0;
  let flatIndex = -1;
  return /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "gs-backdrop", onMouseDown: onClose, role: "presentation", children: /* @__PURE__ */ jsxRuntimeExports.jsxs(
    "div",
    {
      className: "gs",
      role: "dialog",
      "aria-modal": "true",
      "aria-label": "全局搜索",
      onMouseDown: (e) => e.stopPropagation(),
      onKeyDown,
      children: [
        /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "gs__input-row", children: [
          /* @__PURE__ */ jsxRuntimeExports.jsx(Icon, { name: "search", size: 16 }),
          /* @__PURE__ */ jsxRuntimeExports.jsx(
            "input",
            {
              ref: inputRef,
              className: "gs__input",
              value: query,
              placeholder: "搜索连接、分组、笔记、设置、当前会话…",
              "aria-label": "全局搜索",
              onChange: (e) => setQuery(e.target.value)
            }
          ),
          loading ? /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "gs__spinner", "aria-hidden": true }) : null,
          query ? /* @__PURE__ */ jsxRuntimeExports.jsx("button", { type: "button", className: "gs__clear", "aria-label": "清空", onClick: () => setQuery(""), children: /* @__PURE__ */ jsxRuntimeExports.jsx(Icon, { name: "close", size: 13 }) }) : /* @__PURE__ */ jsxRuntimeExports.jsx("kbd", { className: "t-kbd", children: "Esc" })
        ] }),
        /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "gs__list", ref: listRef, children: [
          error ? /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "gs__err", children: error }) : null,
          !hasQuery ? /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "gs__guide", children: [
            /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "gs__guide-title", children: "搜索范围" }),
            /* @__PURE__ */ jsxRuntimeExports.jsxs("ul", { children: [
              /* @__PURE__ */ jsxRuntimeExports.jsxs("li", { children: [
                /* @__PURE__ */ jsxRuntimeExports.jsx("b", { children: "连接" }),
                " —— 按名称、主机检索，回车直接连接"
              ] }),
              /* @__PURE__ */ jsxRuntimeExports.jsxs("li", { children: [
                /* @__PURE__ */ jsxRuntimeExports.jsx("b", { children: "分组" }),
                " —— 跳到连接中心并按该分组筛选"
              ] }),
              /* @__PURE__ */ jsxRuntimeExports.jsxs("li", { children: [
                /* @__PURE__ */ jsxRuntimeExports.jsx("b", { children: "笔记" }),
                " —— 按标题与正文检索，回车打开该笔记"
              ] }),
              /* @__PURE__ */ jsxRuntimeExports.jsxs("li", { children: [
                /* @__PURE__ */ jsxRuntimeExports.jsx("b", { children: "设置" }),
                " —— 按名称检索设置项，回车跳到对应分区"
              ] }),
              /* @__PURE__ */ jsxRuntimeExports.jsxs("li", { children: [
                /* @__PURE__ */ jsxRuntimeExports.jsx("b", { children: "会话" }),
                " —— 切到已经打开的标签"
              ] })
            ] }),
            /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "gs__guide-foot", children: [
              /* @__PURE__ */ jsxRuntimeExports.jsx("kbd", { className: "t-kbd", children: "↑" }),
              /* @__PURE__ */ jsxRuntimeExports.jsx("kbd", { className: "t-kbd", children: "↓" }),
              " 选择 · ",
              /* @__PURE__ */ jsxRuntimeExports.jsx("kbd", { className: "t-kbd", children: "Enter" }),
              " 执行 ·",
              " ",
              /* @__PURE__ */ jsxRuntimeExports.jsx("kbd", { className: "t-kbd", children: "Esc" }),
              " 关闭"
            ] })
          ] }) : flat.length === 0 && !loading ? /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "gs__empty", children: [
            "没有匹配「",
            query.trim(),
            "」的结果"
          ] }) : grouped.map(({ group, hits }) => /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "gs__group", children: [
            /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "gs__group-title", children: [
              group,
              /* @__PURE__ */ jsxRuntimeExports.jsx(Badge, { tone: "outline", children: hits.length })
            ] }),
            hits.map((h) => {
              flatIndex += 1;
              const active = flatIndex === cursor;
              const idx = flatIndex;
              return /* @__PURE__ */ jsxRuntimeExports.jsxs(
                "button",
                {
                  type: "button",
                  className: `gs-item${active ? " gs-item--active" : ""}`,
                  onMouseEnter: () => setCursor(idx),
                  onClick: () => runHit(h),
                  children: [
                    /* @__PURE__ */ jsxRuntimeExports.jsx(Icon, { name: h.icon, size: 15 }),
                    /* @__PURE__ */ jsxRuntimeExports.jsxs("span", { className: "gs-item__body", children: [
                      /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "gs-item__title", children: h.title }),
                      h.subtitle ? /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "gs-item__sub", children: h.subtitle }) : null
                    ] }),
                    active ? /* @__PURE__ */ jsxRuntimeExports.jsx("kbd", { className: "t-kbd", children: "Enter" }) : null
                  ]
                },
                h.id
              );
            })
          ] }, group))
        ] })
      ]
    }
  ) });
}
export {
  GlobalSearch,
  GlobalSearch as default
};
