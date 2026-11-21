import { u as useStoreShallow, r as reactExports, j as jsxRuntimeExports, n as IconButton, a as actions, a2 as openLocalTerminal, J as EmptyState, h as Button, $ as closeTab, I as Icon, s as setActiveTab, S as StatusDot } from "./index-CwfghMy4.js";
/* empty css                  */
const STATE_TONE = {
  idle: "muted",
  connecting: "accent",
  authenticating: "accent",
  "verifying-host-key": "warn",
  ready: "ok",
  disconnected: "muted",
  failed: "danger"
};
const STATE_LABEL = {
  idle: "空闲",
  connecting: "连接中",
  authenticating: "认证中",
  "verifying-host-key": "校验指纹",
  ready: "已连接",
  disconnected: "已断开",
  failed: "失败"
};
const KIND_LABEL = {
  ssh: "SSH",
  local: "本地终端",
  telnet: "Telnet",
  vnc: "VNC",
  rdp: "RDP",
  tunnel: "隧道"
};
const LAYOUT_LABEL = {
  single: "单窗格",
  hsplit: "左右分屏",
  vsplit: "上下分屏"
};
function Item({ tab, active }) {
  return /* @__PURE__ */ jsxRuntimeExports.jsxs(
    "div",
    {
      className: `session-item${active ? " session-item--active" : ""}`,
      role: "button",
      tabIndex: 0,
      "aria-current": active || void 0,
      onClick: () => setActiveTab(tab.tabId),
      onKeyDown: (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          setActiveTab(tab.tabId);
        }
      },
      children: [
        /* @__PURE__ */ jsxRuntimeExports.jsx(
          StatusDot,
          {
            tone: STATE_TONE[tab.state] ?? "muted",
            pulse: tab.state === "connecting" || tab.state === "authenticating",
            label: STATE_LABEL[tab.state] ?? tab.state
          }
        ),
        /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "session-item__body", children: [
          /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "session-item__title", title: tab.title, children: tab.title }),
          /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "session-item__meta", children: [
            tab.kind === "local" ? "本地" : tab.subtitle ?? "SSH",
            " · ",
            STATE_LABEL[tab.state] ?? tab.state
          ] })
        ] }),
        /* @__PURE__ */ jsxRuntimeExports.jsx(
          IconButton,
          {
            icon: "close",
            label: `关闭 ${tab.title}`,
            size: 12,
            onClick: (e) => {
              e.stopPropagation();
              closeTab(tab.tabId);
            }
          }
        )
      ]
    }
  );
}
function MiniItem({
  tab,
  active,
  onHover
}) {
  const tone = STATE_TONE[tab.state] ?? "muted";
  return /* @__PURE__ */ jsxRuntimeExports.jsxs(
    "button",
    {
      type: "button",
      className: `sess-mini${active ? " sess-mini--active" : ""}`,
      "aria-label": `${tab.title}：${STATE_LABEL[tab.state] ?? tab.state}`,
      "aria-current": active || void 0,
      onClick: () => setActiveTab(tab.tabId),
      onMouseEnter: (e) => onHover(tab, e.currentTarget),
      onMouseLeave: () => onHover(null, null),
      onFocus: (e) => onHover(tab, e.currentTarget),
      onBlur: () => onHover(null, null),
      children: [
        /* @__PURE__ */ jsxRuntimeExports.jsx(Icon, { name: tab.kind === "local" ? "console" : "terminal", size: 16 }),
        /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: `sess-mini__dot sess-mini__dot--${tone}`, "aria-hidden": true })
      ]
    }
  );
}
function SessionSidebar() {
  const { tabs, activeTabId, collapsed } = useStoreShallow((s) => ({
    tabs: s.tabs,
    activeTabId: s.activeTabId,
    collapsed: s.panelCollapsed
  }));
  const [tip, setTip] = reactExports.useState(null);
  const hover = (tab, anchor) => {
    if (!tab || !anchor) {
      setTip(null);
      return;
    }
    const r = anchor.getBoundingClientRect();
    const top = Math.min(r.top, Math.max(8, window.innerHeight - 170));
    setTip({ tab, top, left: r.right + 10 });
  };
  const active = tabs.filter((t) => t.state === "ready").length;
  if (collapsed) {
    return /* @__PURE__ */ jsxRuntimeExports.jsxs("aside", { className: "panel panel--mini", "aria-label": "会话列表（已折叠）", children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "panel-mini__head", children: /* @__PURE__ */ jsxRuntimeExports.jsx(
        IconButton,
        {
          icon: "panel-left",
          label: "展开会话栏",
          size: 14,
          onClick: () => actions.togglePanelCollapsed()
        }
      ) }),
      tabs.length === 0 ? /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "panel-mini__empty", title: "没有打开的会话", children: "—" }) : /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "sessions-mini", role: "list", children: tabs.map((tab) => /* @__PURE__ */ jsxRuntimeExports.jsx(
        MiniItem,
        {
          tab,
          active: tab.tabId === activeTabId,
          onHover: hover
        },
        tab.tabId
      )) }),
      /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "panel-mini__foot", children: /* @__PURE__ */ jsxRuntimeExports.jsx(IconButton, { icon: "plus", label: "新建本地终端", size: 14, onClick: () => void openLocalTerminal() }) }),
      tip ? /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "sess-tip", role: "tooltip", style: { top: tip.top, left: tip.left }, children: [
        /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "sess-tip__head", children: [
          /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "sess-tip__title", children: tip.tab.title }),
          /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: `sess-tip__state sess-tip__state--${STATE_TONE[tip.tab.state] ?? "muted"}`, children: STATE_LABEL[tip.tab.state] ?? tip.tab.state })
        ] }),
        /* @__PURE__ */ jsxRuntimeExports.jsxs("dl", { className: "sess-tip__props", children: [
          /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { children: [
            /* @__PURE__ */ jsxRuntimeExports.jsx("dt", { children: "类型" }),
            /* @__PURE__ */ jsxRuntimeExports.jsx("dd", { children: KIND_LABEL[tip.tab.kind] ?? tip.tab.kind })
          ] }),
          /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { children: [
            /* @__PURE__ */ jsxRuntimeExports.jsx("dt", { children: "地址" }),
            /* @__PURE__ */ jsxRuntimeExports.jsx("dd", { className: "mono", children: tip.tab.subtitle ?? "—" })
          ] }),
          /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { children: [
            /* @__PURE__ */ jsxRuntimeExports.jsx("dt", { children: "会话 ID" }),
            /* @__PURE__ */ jsxRuntimeExports.jsx("dd", { className: "mono", children: tip.tab.sessionId ? tip.tab.sessionId.slice(0, 12) : "尚未建立" })
          ] }),
          /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { children: [
            /* @__PURE__ */ jsxRuntimeExports.jsx("dt", { children: "窗格" }),
            /* @__PURE__ */ jsxRuntimeExports.jsx("dd", { children: LAYOUT_LABEL[tip.tab.layout] })
          ] }),
          /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { children: [
            /* @__PURE__ */ jsxRuntimeExports.jsx("dt", { children: "文件栏" }),
            /* @__PURE__ */ jsxRuntimeExports.jsx("dd", { children: tip.tab.filesOpen ? "展开" : "收起" })
          ] }),
          /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { children: [
            /* @__PURE__ */ jsxRuntimeExports.jsx("dt", { children: "监控" }),
            /* @__PURE__ */ jsxRuntimeExports.jsx("dd", { children: tip.tab.monitorOpen ? "展开" : "收起" })
          ] })
        ] })
      ] }) : null
    ] });
  }
  return /* @__PURE__ */ jsxRuntimeExports.jsxs("aside", { className: "panel", "aria-label": "会话列表", children: [
    /* @__PURE__ */ jsxRuntimeExports.jsxs("header", { className: "panel-header", children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "panel-title", children: "会话" }),
      /* @__PURE__ */ jsxRuntimeExports.jsxs("span", { className: "t-badge", children: [
        active,
        "/",
        tabs.length
      ] }),
      /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "t-toolbar__spacer" }),
      /* @__PURE__ */ jsxRuntimeExports.jsx(
        IconButton,
        {
          icon: "search",
          label: "全局搜索（Ctrl+K）",
          size: 13,
          onClick: () => actions.toggleGlobalSearch()
        }
      ),
      /* @__PURE__ */ jsxRuntimeExports.jsx(
        IconButton,
        {
          icon: "panel-left",
          label: "折叠会话栏（只留图标，悬停看属性）",
          size: 14,
          onClick: () => actions.togglePanelCollapsed()
        }
      )
    ] }),
    /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "panel-body", children: tabs.length === 0 ? /* @__PURE__ */ jsxRuntimeExports.jsx(
      EmptyState,
      {
        icon: "terminal",
        title: "没有打开的会话",
        text: "从连接中心双击一台服务器，或直接开一个本地终端。",
        actions: /* @__PURE__ */ jsxRuntimeExports.jsx(Button, { size: "sm", variant: "primary", onClick: () => actions.setView("connections"), children: "去连接中心" })
      }
    ) : /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "sessions", role: "list", children: tabs.map((tab) => /* @__PURE__ */ jsxRuntimeExports.jsx(Item, { tab, active: tab.tabId === activeTabId }, tab.tabId)) }) }),
    /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "panel-footer", children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx(
        Button,
        {
          size: "sm",
          variant: "outline",
          icon: "plus",
          style: { flex: 1 },
          onClick: () => void openLocalTerminal(),
          children: "本地终端"
        }
      ),
      /* @__PURE__ */ jsxRuntimeExports.jsx(
        IconButton,
        {
          icon: "trash",
          label: "关闭全部会话",
          disabled: tabs.length === 0,
          onClick: () => {
            for (const t of tabs) closeTab(t.tabId);
          }
        }
      )
    ] })
  ] });
}
export {
  SessionSidebar
};
