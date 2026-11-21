const __vite__mapDeps=(i,m=__vite__mapDeps,d=(m.f||(m.f=["./SyncPanel-yos_S8DN.js","./index-C6luzS_t.js","./index-DD-jW_Hd.css","./ServerIdentityPanel-Bl4FrydH.js","./ServerIdentityPanel-Bq-UM-tI.css","./McpPanel-BwhFWOTq.js"])))=>i.map(i=>d[i]);
import { u as useStoreShallow, j as jsxRuntimeExports, I as Icon, r as reactExports, L as Loading, a as actions, _ as __vitePreload } from "./index-C6luzS_t.js";
const SyncPanel = reactExports.lazy(() => __vitePreload(() => import("./SyncPanel-yos_S8DN.js"), true ? __vite__mapDeps([0,1,2,3,4]) : void 0, import.meta.url));
const McpPanel = reactExports.lazy(() => __vitePreload(() => import("./McpPanel-BwhFWOTq.js"), true ? __vite__mapDeps([5,1,2]) : void 0, import.meta.url));
const SERVICES = [
  { id: "sync", label: "同步与云端", icon: "cloud", blurb: "零知识加密的多端同步" },
  { id: "mcp", label: "MCP 服务", icon: "server", blurb: "把能力暴露给 MCP 客户端" }
];
function ServicesSidebar() {
  const section = useStoreShallow((s) => ({ section: s.servicesSection })).section;
  return /* @__PURE__ */ jsxRuntimeExports.jsxs("aside", { className: "panel", "aria-label": "外部服务", children: [
    /* @__PURE__ */ jsxRuntimeExports.jsx("header", { className: "panel-header", children: /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "panel-title", children: "外部服务" }) }),
    /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "panel-body", children: /* @__PURE__ */ jsxRuntimeExports.jsx("nav", { className: "sessions", children: SERVICES.map((svc) => /* @__PURE__ */ jsxRuntimeExports.jsxs(
      "button",
      {
        type: "button",
        className: `settings-nav${svc.id === section ? " settings-nav--active" : ""}`,
        "aria-current": svc.id === section || void 0,
        onClick: () => actions.setServicesSection(svc.id),
        children: [
          /* @__PURE__ */ jsxRuntimeExports.jsx(Icon, { name: svc.icon, size: 14 }),
          /* @__PURE__ */ jsxRuntimeExports.jsxs("span", { className: "settings-nav__body", children: [
            /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "settings-nav__title", children: svc.label }),
            /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "settings-nav__desc", children: svc.blurb })
          ] })
        ]
      },
      svc.id
    )) }) }),
    /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "panel-footer", children: /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "form-footer-hint", children: "两个服务都是可选的" }) })
  ] });
}
function ServicesView() {
  const section = useStoreShallow((s) => ({ section: s.servicesSection })).section;
  return /* @__PURE__ */ jsxRuntimeExports.jsxs("main", { className: "content", "aria-label": "外部服务", children: [
    /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "t-toolbar", children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx(Icon, { name: section === "sync" ? "cloud" : "server", size: 15 }),
      /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "panel-title", children: section === "sync" ? "同步与云端" : "MCP 服务" }),
      /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "term-toolbar__meta", children: section === "sync" ? "服务端只保存密文，密钥不出本机" : "默认只监听回环，策略默认最保守" })
    ] }),
    /* @__PURE__ */ jsxRuntimeExports.jsx(reactExports.Suspense, { fallback: /* @__PURE__ */ jsxRuntimeExports.jsx(Loading, { text: "正在载入…" }), children: section === "sync" ? /* @__PURE__ */ jsxRuntimeExports.jsx(SyncPanel, {}) : /* @__PURE__ */ jsxRuntimeExports.jsx(McpPanel, {}) })
  ] });
}
export {
  ServicesSidebar,
  ServicesView as default
};
