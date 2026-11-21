import { r as reactExports, i as invoke, e as errorText, j as jsxRuntimeExports, I as Icon, n as IconButton, B as Badge, J as EmptyState, L as Loading, h as Button, t as toast, u as useStoreShallow, a as actions, F as Field, G as Switch } from "./index-C6luzS_t.js";
const SEARCH_LIMIT = 40;
const DEBOUNCE_MS = 220;
function CopyButton({ text, label }) {
  return /* @__PURE__ */ jsxRuntimeExports.jsx(
    IconButton,
    {
      icon: "copy",
      label,
      size: 12,
      onClick: () => {
        void navigator.clipboard.writeText(text).then(
          () => toast.ok("已复制到剪贴板（不会发送到终端）"),
          () => toast.error("复制失败")
        );
      }
    }
  );
}
function Section({
  title,
  icon,
  children
}) {
  return /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "cm-section", children: [
    /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "cm-section__title", children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx(Icon, { name: icon, size: 12 }),
      title
    ] }),
    children
  ] });
}
function CommandManual() {
  const [query, setQuery] = reactExports.useState("");
  const [items, setItems] = reactExports.useState([]);
  const [truncated, setTruncated] = reactExports.useState(false);
  const [loading, setLoading] = reactExports.useState(false);
  const [error, setError] = reactExports.useState(null);
  const [selectedName, setSelectedName] = reactExports.useState(null);
  const inputRef = reactExports.useRef(null);
  const seqRef = reactExports.useRef(0);
  reactExports.useEffect(() => {
    inputRef.current?.focus();
  }, []);
  const run = reactExports.useCallback(async (q) => {
    const trimmed = q.trim();
    if (!trimmed) {
      setItems([]);
      setTruncated(false);
      setError(null);
      return;
    }
    const seq = ++seqRef.current;
    setLoading(true);
    try {
      const res = await invoke("completion", "search", { query: trimmed, limit: SEARCH_LIMIT });
      if (seq !== seqRef.current) return;
      setItems(Array.isArray(res?.results) ? res.results : []);
      setTruncated(res?.truncated === true);
      setError(null);
      setSelectedName(
        (prev) => prev && res.results.some((r) => r.name === prev) ? prev : res.results[0]?.name ?? null
      );
    } catch (err) {
      if (seq !== seqRef.current) return;
      setItems([]);
      setTruncated(false);
      setError(errorText(err));
    } finally {
      if (seq === seqRef.current) setLoading(false);
    }
  }, []);
  reactExports.useEffect(() => {
    const t = window.setTimeout(() => void run(query), DEBOUNCE_MS);
    return () => window.clearTimeout(t);
  }, [query, run]);
  const selected = reactExports.useMemo(
    () => items.find((i) => i.name === selectedName) ?? null,
    [items, selectedName]
  );
  const grouped = reactExports.useMemo(() => {
    const map = /* @__PURE__ */ new Map();
    for (const it of items) {
      const key = it.category ?? "未分类";
      const list = map.get(key);
      if (list) list.push(it);
      else map.set(key, [it]);
    }
    return [...map.entries()];
  }, [items]);
  return /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "cm", children: [
    /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "t-toolbar", children: [
      /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "t-search", style: { maxWidth: 420 }, children: [
        /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "t-search__icon", children: /* @__PURE__ */ jsxRuntimeExports.jsx(Icon, { name: "search", size: 14 }) }),
        /* @__PURE__ */ jsxRuntimeExports.jsx(
          "input",
          {
            ref: inputRef,
            className: "t-input",
            value: query,
            placeholder: "输入命令名，如 tar、journalctl、docker…",
            "aria-label": "搜索命令",
            onChange: (e) => setQuery(e.target.value)
          }
        ),
        query ? /* @__PURE__ */ jsxRuntimeExports.jsx(
          IconButton,
          {
            className: "t-search__clear",
            icon: "close",
            label: "清空",
            onClick: () => {
              setQuery("");
              inputRef.current?.focus();
            }
          }
        ) : null
      ] }),
      items.length > 0 ? /* @__PURE__ */ jsxRuntimeExports.jsxs(Badge, { children: [
        items.length,
        " 条"
      ] }) : null,
      truncated ? /* @__PURE__ */ jsxRuntimeExports.jsx(Badge, { tone: "warn", children: "还有更多（已截断）" }) : null,
      /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "t-toolbar__spacer" }),
      /* @__PURE__ */ jsxRuntimeExports.jsxs("span", { className: "t-field__hint", children: [
        /* @__PURE__ */ jsxRuntimeExports.jsx(Icon, { name: "info", size: 12 }),
        " 仅供查阅，不会自动发送到终端"
      ] })
    ] }),
    !query.trim() ? /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "conn-empty", children: /* @__PURE__ */ jsxRuntimeExports.jsx(
      EmptyState,
      {
        icon: "list",
        title: "输入命令名开始查询",
        text: "内置 214 条常用命令（9 个分类），其中 73 条带安装方式与示例，部分交互式命令还带常用快捷键。全部离线，不联网。"
      }
    ) }) : error ? /* @__PURE__ */ jsxRuntimeExports.jsx("div", { style: { padding: 18 }, children: /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "t-banner t-banner--error", children: error }) }) : loading && items.length === 0 ? /* @__PURE__ */ jsxRuntimeExports.jsx(Loading, { text: "查询中…" }) : items.length === 0 ? /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "conn-empty", children: /* @__PURE__ */ jsxRuntimeExports.jsx(
      EmptyState,
      {
        icon: "search",
        title: `没有匹配「${query.trim()}」的命令`,
        text: "试试更短的关键词，或直接用命令名（支持前缀/包含/描述命中）。"
      }
    ) }) : /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "cm-split", children: [
      /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "cm-list", children: [
        grouped.map(([category, list]) => /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { children: [
          /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "cm-list__group", children: category }),
          list.map((it) => /* @__PURE__ */ jsxRuntimeExports.jsxs(
            "button",
            {
              type: "button",
              className: `cm-item${it.name === selectedName ? " cm-item--active" : ""}`,
              onClick: () => setSelectedName(it.name),
              children: [
                /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "cm-item__name", children: it.name }),
                /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "cm-item__summary", children: it.summary ?? "" })
              ]
            },
            it.name
          ))
        ] }, category)),
        truncated ? /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "cm-list__more", children: [
          "已显示前 ",
          items.length,
          " 条，还有更多结果 —— 再输入几个字符缩小范围即可。"
        ] }) : null
      ] }),
      /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "cm-detail", children: !selected ? /* @__PURE__ */ jsxRuntimeExports.jsx(EmptyState, { icon: "list", title: "选择左侧的命令" }) : /* @__PURE__ */ jsxRuntimeExports.jsxs(jsxRuntimeExports.Fragment, { children: [
        /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "cm-detail__head", children: [
          /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "cm-detail__name mono", children: selected.name }),
          selected.category ? /* @__PURE__ */ jsxRuntimeExports.jsx(Badge, { tone: "outline", children: selected.category }) : null
        ] }),
        selected.summary ? /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "cm-detail__summary", children: selected.summary }) : null,
        /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "cm-detail__body", children: [
          selected.usage ? /* @__PURE__ */ jsxRuntimeExports.jsx(Section, { title: "语法", icon: "terminal", children: /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "cm-code", children: [
            /* @__PURE__ */ jsxRuntimeExports.jsx("code", { children: selected.usage }),
            /* @__PURE__ */ jsxRuntimeExports.jsx(CopyButton, { text: selected.usage, label: "复制语法" })
          ] }) }) : null,
          selected.options && selected.options.length > 0 ? /* @__PURE__ */ jsxRuntimeExports.jsx(Section, { title: `参数（${selected.options.length}）`, icon: "sliders", children: /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "cm-kv", children: selected.options.map((o) => /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "cm-kv__row", children: [
            /* @__PURE__ */ jsxRuntimeExports.jsxs("span", { className: "cm-kv__key mono", children: [
              o.name,
              o.arg ? /* @__PURE__ */ jsxRuntimeExports.jsxs("span", { className: "cm-kv__arg", children: [
                " ",
                o.arg
              ] }) : null
            ] }),
            /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "cm-kv__val", children: o.description })
          ] }, o.name)) }) }) : null,
          selected.subcommands && selected.subcommands.length > 0 ? /* @__PURE__ */ jsxRuntimeExports.jsx(Section, { title: `子命令（${selected.subcommands.length}）`, icon: "list", children: /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "cm-kv", children: selected.subcommands.map((s) => /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "cm-kv__row", children: [
            /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "cm-kv__key mono", children: s.name }),
            /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "cm-kv__val", children: s.description })
          ] }, s.name)) }) }) : null,
          selected.examples && selected.examples.length > 0 ? /* @__PURE__ */ jsxRuntimeExports.jsx(Section, { title: "常用示例", icon: "zap", children: /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "cm-examples", children: selected.examples.map((ex) => /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "cm-example", children: [
            /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "cm-example__cmd", children: [
              /* @__PURE__ */ jsxRuntimeExports.jsx("code", { children: ex.command }),
              /* @__PURE__ */ jsxRuntimeExports.jsx(CopyButton, { text: ex.command, label: `复制示例 ${ex.command}` })
            ] }),
            ex.description ? /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "cm-example__desc", children: ex.description }) : null
          ] }, ex.command)) }) }) : null,
          selected.shortcuts && selected.shortcuts.length > 0 ? /* @__PURE__ */ jsxRuntimeExports.jsx(Section, { title: "常用快捷键", icon: "key", children: /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "cm-keys", children: selected.shortcuts.map((s) => /* @__PURE__ */ jsxRuntimeExports.jsxs("span", { className: "cm-key", children: [
            /* @__PURE__ */ jsxRuntimeExports.jsx("kbd", { className: "t-kbd", children: s.key }),
            s.description
          ] }, s.key)) }) }) : null,
          selected.install ? /* @__PURE__ */ jsxRuntimeExports.jsx(Section, { title: "安装方式", icon: "download", children: /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "cm-code", children: [
            /* @__PURE__ */ jsxRuntimeExports.jsx("code", { children: selected.install }),
            /* @__PURE__ */ jsxRuntimeExports.jsx(CopyButton, { text: selected.install, label: "复制安装命令" })
          ] }) }) : null,
          !selected.usage && !selected.options?.length && !selected.examples?.length ? /* @__PURE__ */ jsxRuntimeExports.jsx("p", { className: "t-field__hint", children: "这条命令目前只有简要说明（详版 73 条之一尚未覆盖到它）。" }) : null
        ] }),
        /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "cm-detail__foot", children: [
          /* @__PURE__ */ jsxRuntimeExports.jsx(
            Button,
            {
              size: "sm",
              variant: "outline",
              icon: "copy",
              onClick: () => {
                void navigator.clipboard.writeText(`${selected.name} — ${selected.summary ?? ""}`);
                toast.ok("已复制命令名与用途");
              },
              children: "复制这条说明"
            }
          ),
          /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "t-field__hint", children: "手册只提供参考；要执行请自己在终端里输入。" })
        ] })
      ] }) })
    ] })
  ] });
}
const TOOLS = [
  { id: "password", label: "密码生成器", icon: "key", blurb: "本机生成，不落盘不联网" },
  { id: "manual", label: "命令手册", icon: "list", blurb: "离线命令速查（214 条 / 9 类）" }
];
const CHARSETS = {
  lower: "abcdefghijkmnopqrstuvwxyz",
  upper: "ABCDEFGHJKLMNPQRSTUVWXYZ",
  digit: "23456789",
  symbol: "!@#$%^&*()-_=+[]{};:,.?"
};
const AMBIGUOUS = /[Il1O0o]/g;
function randomInt(max) {
  const limit = Math.floor(4294967295 / max) * max;
  const buf = new Uint32Array(1);
  for (; ; ) {
    crypto.getRandomValues(buf);
    const v = buf[0] ?? 0;
    if (v < limit) return v % max;
  }
}
function generate(length, pool, excludeAmbiguous) {
  const charset = excludeAmbiguous ? pool.replace(AMBIGUOUS, "") : pool;
  if (charset.length === 0) return "";
  let out = "";
  for (let i = 0; i < length; i += 1) out += charset[randomInt(charset.length)];
  return out;
}
function entropyBits(length, poolSize) {
  return poolSize <= 1 ? 0 : Math.round(length * Math.log2(poolSize));
}
function PasswordTool() {
  const [length, setLength] = reactExports.useState(20);
  const [useLower, setUseLower] = reactExports.useState(true);
  const [useUpper, setUseUpper] = reactExports.useState(true);
  const [useDigit, setUseDigit] = reactExports.useState(true);
  const [useSymbol, setUseSymbol] = reactExports.useState(true);
  const [excludeAmbiguous, setExcludeAmbiguous] = reactExports.useState(true);
  const [nonce, setNonce] = reactExports.useState(0);
  const pool = reactExports.useMemo(() => {
    let p = "";
    if (useLower) p += CHARSETS.lower;
    if (useUpper) p += CHARSETS.upper;
    if (useDigit) p += CHARSETS.digit;
    if (useSymbol) p += CHARSETS.symbol;
    return excludeAmbiguous ? p.replace(AMBIGUOUS, "") : p;
  }, [useLower, useUpper, useDigit, useSymbol, excludeAmbiguous]);
  const value = reactExports.useMemo(
    () => generate(Math.max(4, Math.min(128, length)), pool, excludeAmbiguous),
    // nonce 是「重新生成」的触发器
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [length, pool, excludeAmbiguous, nonce]
  );
  const bits = entropyBits(length, pool.length);
  const strength = bits >= 128 ? "很强" : bits >= 90 ? "强" : bits >= 60 ? "中等" : "偏弱";
  const tone = bits >= 90 ? "ok" : bits >= 60 ? "warn" : "danger";
  return /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "t-grid", style: { maxWidth: 620 }, children: [
    /* @__PURE__ */ jsxRuntimeExports.jsxs(
      "div",
      {
        style: {
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "12px 14px",
          border: "1px solid var(--t1000-border-strong)",
          borderRadius: "var(--t1000-radius)",
          background: "var(--t1000-bg-input)"
        },
        children: [
          /* @__PURE__ */ jsxRuntimeExports.jsx(
            "code",
            {
              className: "mono",
              style: { flex: 1, minWidth: 0, wordBreak: "break-all", fontSize: 14, lineHeight: 1.6 },
              children: value || "—"
            }
          ),
          /* @__PURE__ */ jsxRuntimeExports.jsx(IconButton, { icon: "refresh", label: "重新生成", onClick: () => setNonce((n) => n + 1) }),
          /* @__PURE__ */ jsxRuntimeExports.jsx(
            IconButton,
            {
              icon: "copy",
              label: "复制",
              onClick: () => {
                if (!value) return;
                void navigator.clipboard.writeText(value).then(() => toast.ok("已复制到剪贴板"));
              }
            }
          )
        ]
      }
    ),
    /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { style: { display: "flex", alignItems: "center", gap: 10 }, children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx(Badge, { tone, children: strength }),
      /* @__PURE__ */ jsxRuntimeExports.jsxs("span", { className: "metric__sub", children: [
        "熵 ≈ ",
        bits,
        " bit · 字符集 ",
        pool.length,
        " 个"
      ] })
    ] }),
    /* @__PURE__ */ jsxRuntimeExports.jsx(Field, { label: `长度：${length}`, children: /* @__PURE__ */ jsxRuntimeExports.jsx(
      "input",
      {
        type: "range",
        min: 8,
        max: 64,
        value: length,
        "aria-label": "密码长度",
        onChange: (e) => setLength(Number(e.target.value)),
        style: { width: "100%", accentColor: "var(--t1000-accent)" }
      }
    ) }),
    /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "t-grid t-grid--2", style: { gap: 10 }, children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx(Switch, { checked: useLower, onChange: setUseLower, label: "小写字母" }),
      /* @__PURE__ */ jsxRuntimeExports.jsx(Switch, { checked: useUpper, onChange: setUseUpper, label: "大写字母" }),
      /* @__PURE__ */ jsxRuntimeExports.jsx(Switch, { checked: useDigit, onChange: setUseDigit, label: "数字" }),
      /* @__PURE__ */ jsxRuntimeExports.jsx(Switch, { checked: useSymbol, onChange: setUseSymbol, label: "符号" }),
      /* @__PURE__ */ jsxRuntimeExports.jsx(
        Switch,
        {
          checked: excludeAmbiguous,
          onChange: setExcludeAmbiguous,
          label: "排除易混淆字符 (I l 1 O 0 o)"
        }
      )
    ] }),
    /* @__PURE__ */ jsxRuntimeExports.jsxs("p", { className: "t-field__hint", style: { margin: 0 }, children: [
      "生成过程完全在本机用 ",
      /* @__PURE__ */ jsxRuntimeExports.jsx("code", { className: "mono", children: "crypto.getRandomValues" }),
      " 完成， 不落盘、不发网络请求。"
    ] })
  ] });
}
function ToolsSidebar() {
  const section = useStoreShallow((s) => ({ section: s.toolsSection })).section;
  return /* @__PURE__ */ jsxRuntimeExports.jsxs("aside", { className: "panel", "aria-label": "工具", children: [
    /* @__PURE__ */ jsxRuntimeExports.jsx("header", { className: "panel-header", children: /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "panel-title", children: "工具" }) }),
    /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "panel-body", children: /* @__PURE__ */ jsxRuntimeExports.jsx("nav", { className: "sessions", children: TOOLS.map((tool) => /* @__PURE__ */ jsxRuntimeExports.jsxs(
      "button",
      {
        type: "button",
        className: `settings-nav${tool.id === section ? " settings-nav--active" : ""}`,
        "aria-current": tool.id === section || void 0,
        onClick: () => actions.setToolsSection(tool.id),
        children: [
          /* @__PURE__ */ jsxRuntimeExports.jsx(Icon, { name: tool.icon, size: 14 }),
          /* @__PURE__ */ jsxRuntimeExports.jsxs("span", { className: "settings-nav__body", children: [
            /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "settings-nav__title", children: tool.label }),
            /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "settings-nav__desc", children: tool.blurb })
          ] })
        ]
      },
      tool.id
    )) }) }),
    /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "panel-footer", children: /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "form-footer-hint", children: "AI 助手与命令手册已各自成页（左侧导航「AI 助手」）" }) })
  ] });
}
function ToolsView() {
  const section = useStoreShallow((s) => ({ section: s.toolsSection })).section;
  if (section === "manual") {
    return /* @__PURE__ */ jsxRuntimeExports.jsx("main", { className: "content", "aria-label": "命令手册", children: /* @__PURE__ */ jsxRuntimeExports.jsx(CommandManual, {}) });
  }
  return /* @__PURE__ */ jsxRuntimeExports.jsxs("main", { className: "content", "aria-label": "工具", children: [
    /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "t-toolbar", children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx(Icon, { name: "key", size: 15 }),
      /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "panel-title", children: "密码生成器" }),
      /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "t-toolbar__spacer" }),
      /* @__PURE__ */ jsxRuntimeExports.jsx(Button, { size: "sm", variant: "ghost", icon: "connections", onClick: () => actions.setView("connections"), children: "返回连接中心" })
    ] }),
    /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "content-scroll", style: { padding: 18 }, children: /* @__PURE__ */ jsxRuntimeExports.jsx(PasswordTool, {}) })
  ] });
}
export {
  ToolsSidebar,
  ToolsView as default
};
