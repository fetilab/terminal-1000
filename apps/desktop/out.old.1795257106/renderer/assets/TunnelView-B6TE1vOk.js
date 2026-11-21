import { r as reactExports, j as jsxRuntimeExports, I as Icon, B as Badge, h as Button, f as Banner, i as invoke, t as toast, e as errorText } from "./index-C6luzS_t.js";
const TYPE_LABEL = {
  local: "本地转发 (-L)",
  remote: "远程转发 (-R)",
  dynamic: "动态代理 (-D, SOCKS5)"
};
const STATE_TONE = {
  idle: "default",
  connecting: "accent",
  ready: "ok",
  disconnected: "warn",
  failed: "danger"
};
function TunnelView({
  sessionId,
  connection,
  state,
  message
}) {
  const [busy, setBusy] = reactExports.useState(false);
  const close = async () => {
    if (!sessionId) return;
    setBusy(true);
    try {
      await invoke("forward", "close", {
        tunnelId: sessionId
      });
      toast.ok("隧道已关闭，监听端口已收回");
    } catch (err) {
      toast.error(`关闭失败：${errorText(err)}`);
    } finally {
      setBusy(false);
    }
  };
  const type = connection.type;
  const rows = [
    ["类型", TYPE_LABEL[type] ?? type],
    ["承载服务器", connection.serverId],
    ["本机监听", `${connection.localHost}:${connection.localPort}`],
    ...type === "dynamic" ? [["代理方式", "SOCKS5（客户端自行决定目标）"]] : [["远端目标", `${connection.remoteHost}:${connection.remotePort}`]],
    ["自动重连", connection.autoReconnect ? "已开启" : "关闭"],
    ["运行 ID", sessionId ?? "（未建立）"]
  ];
  return /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "content", "aria-label": `隧道 ${connection.name}`, children: [
    /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "t-toolbar", children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx(Icon, { name: "route", size: 15 }),
      /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "panel-title", children: connection.name }),
      /* @__PURE__ */ jsxRuntimeExports.jsx(Badge, { tone: STATE_TONE[state] ?? "default", children: state === "ready" ? "已就绪" : state === "connecting" ? "打开中" : state === "failed" ? "失败" : state }),
      /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "t-toolbar__spacer" }),
      /* @__PURE__ */ jsxRuntimeExports.jsx(
        Button,
        {
          size: "sm",
          variant: "danger",
          icon: "power",
          loading: busy,
          disabled: !sessionId || state === "disconnected",
          onClick: () => void close(),
          children: "关闭隧道"
        }
      )
    ] }),
    /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "content-scroll", style: { padding: 18, maxWidth: 720 }, children: [
      state === "failed" ? /* @__PURE__ */ jsxRuntimeExports.jsx("div", { style: { marginBottom: 14 }, children: /* @__PURE__ */ jsxRuntimeExports.jsxs(Banner, { tone: "error", children: [
        "隧道打开失败：",
        message ?? "未知原因"
      ] }) }) : null,
      state === "ready" && connection.autoReconnect ? /* @__PURE__ */ jsxRuntimeExports.jsx("div", { style: { marginBottom: 14 }, children: /* @__PURE__ */ jsxRuntimeExports.jsx(Banner, { tone: "info", children: "已开启自动重连：意外断开后会按退避策略重建，无需手动干预。" }) }) : null,
      /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "kv", style: { gridTemplateColumns: "120px minmax(0, 1fr)" }, children: rows.map(([k, v]) => /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { style: { display: "contents" }, children: [
        /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "kv__k", children: k }),
        /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "kv__v mono", style: { fontSize: 12 }, children: v })
      ] }, k)) }),
      /* @__PURE__ */ jsxRuntimeExports.jsx("p", { className: "t-field__hint", style: { marginTop: 18 }, children: type === "local" ? `连接本机 ${connection.localHost}:${connection.localPort} 就等于连接远端的 ${connection.remoteHost}:${connection.remotePort}。` : type === "remote" ? `连接远端 ${connection.remoteHost}:${connection.remotePort} 会被转发回本机的服务。` : `把本机 ${connection.localHost}:${connection.localPort} 当作 SOCKS5 代理使用，目标由客户端指定。` }),
      state === "disconnected" ? /* @__PURE__ */ jsxRuntimeExports.jsx("p", { className: "t-field__hint", children: "隧道已关闭。可以用连接列表的「连接」按钮重新打开。" }) : null
    ] })
  ] });
}
export {
  TunnelView,
  TunnelView as default
};
