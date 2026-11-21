import { r as reactExports, U as subscribe, a0 as Events, j as jsxRuntimeExports, I as Icon, B as Badge, h as Button, f as Banner, t as toast, n as IconButton, i as invoke, e as errorText } from "./index-C6luzS_t.js";
function RdpView({
  sessionId,
  title,
  host,
  width,
  height,
  errorMessage
}) {
  const [exit, setExit] = reactExports.useState(null);
  const [restarting, setRestarting] = reactExports.useState(false);
  const [size, setSize] = reactExports.useState({ w: width, h: height });
  reactExports.useEffect(() => {
    if (!sessionId) return;
    return subscribe(Events.RDP_EXIT, (p) => {
      setExit({ code: p.code, signal: p.signal, crashed: p.crashed });
    });
  }, [sessionId]);
  const missingBinary = Boolean(errorMessage && /xfreerdp|freerdp/i.test(errorMessage));
  const applyResize = async () => {
    if (!sessionId) return;
    setRestarting(true);
    try {
      const res = await invoke(
        "rdp",
        "sendResize",
        { sessionId, width: size.w, height: size.h }
      );
      toast.info(res?.restarted ? "正在重启远程桌面窗口（外部窗口无法原地改分辨率）" : "已发送尺寸");
    } catch (err) {
      toast.error(`调整尺寸失败：${errorText(err)}`);
    } finally {
      setTimeout(() => setRestarting(false), 1500);
    }
  };
  return /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "content", "aria-label": `RDP ${title}`, children: [
    /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "t-toolbar", children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx(Icon, { name: "server", size: 15 }),
      /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "panel-title", children: title }),
      /* @__PURE__ */ jsxRuntimeExports.jsx(Badge, { tone: errorMessage ? "danger" : exit?.crashed ? "danger" : exit ? "default" : "ok", children: errorMessage ? "启动失败" : exit?.crashed ? "异常退出" : exit ? "已关闭" : "运行中" }),
      /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "t-toolbar__spacer" }),
      /* @__PURE__ */ jsxRuntimeExports.jsx(
        Button,
        {
          size: "sm",
          variant: "ghost",
          icon: "refresh",
          loading: restarting,
          disabled: !sessionId,
          onClick: () => void applyResize(),
          children: "应用新的窗口尺寸"
        }
      )
    ] }),
    /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "content-scroll", style: { padding: 18, maxWidth: 780 }, children: [
      errorMessage ? /* @__PURE__ */ jsxRuntimeExports.jsx("div", { style: { marginBottom: 16 }, children: /* @__PURE__ */ jsxRuntimeExports.jsx(
        Banner,
        {
          tone: "error",
          actions: /* @__PURE__ */ jsxRuntimeExports.jsx(
            Button,
            {
              size: "sm",
              variant: "outline",
              icon: "copy",
              onClick: () => {
                void navigator.clipboard.writeText(errorMessage);
                toast.ok("已复制错误信息（含安装命令）");
              },
              children: "复制"
            }
          ),
          children: errorMessage
        }
      ) }) : null,
      /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "settings-switch-row", style: { gap: 10 }, children: [
        /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { style: { display: "flex", alignItems: "center", gap: 8, fontSize: 14, fontWeight: 650 }, children: [
          /* @__PURE__ */ jsxRuntimeExports.jsx(Icon, { name: "eye", size: 16 }),
          errorMessage ? "未启动" : exit ? "已结束" : "画面已在独立窗口打开"
        ] }),
        /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "t-field__hint", style: { lineHeight: 1.7 }, children: [
          "RDP 通过**外部 xfreerdp 进程**运行，",
          /* @__PURE__ */ jsxRuntimeExports.jsx("b", { children: "画面在它自己的窗口里，不会嵌入本标签页" }),
          "。 如果你没看到那个窗口，可能被最小化或被其它窗口挡住； 关闭那个窗口即视为结束会话。",
          missingBinary ? " 当前错误看起来是缺少 FreeRDP，请按上面的命令安装后重试。" : ""
        ] })
      ] }),
      /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "kv", style: { gridTemplateColumns: "120px minmax(0, 1fr)", marginTop: 16 }, children: [
        /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { style: { display: "contents" }, children: [
          /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "kv__k", children: "目标" }),
          /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "kv__v mono", children: host })
        ] }),
        /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { style: { display: "contents" }, children: [
          /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "kv__k", children: "会话 ID" }),
          /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "kv__v mono", children: sessionId ?? "（未建立）" })
        ] }),
        /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { style: { display: "contents" }, children: [
          /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "kv__k", children: "窗口尺寸" }),
          /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "kv__v", children: /* @__PURE__ */ jsxRuntimeExports.jsxs("span", { style: { display: "inline-flex", alignItems: "center", gap: 8 }, children: [
            /* @__PURE__ */ jsxRuntimeExports.jsx(
              "input",
              {
                className: "t-input",
                style: { width: 90, height: 28 },
                type: "number",
                value: size.w,
                "aria-label": "宽度",
                onChange: (e) => setSize((s) => ({ ...s, w: Number(e.target.value) || 0 }))
              }
            ),
            "×",
            /* @__PURE__ */ jsxRuntimeExports.jsx(
              "input",
              {
                className: "t-input",
                style: { width: 90, height: 28 },
                type: "number",
                value: size.h,
                "aria-label": "高度",
                onChange: (e) => setSize((s) => ({ ...s, h: Number(e.target.value) || 0 }))
              }
            ),
            /* @__PURE__ */ jsxRuntimeExports.jsx(
              IconButton,
              {
                icon: "check",
                label: "应用尺寸（会重启查看器进程）",
                loading: restarting,
                onClick: () => void applyResize()
              }
            )
          ] }) })
        ] })
      ] }),
      exit ? /* @__PURE__ */ jsxRuntimeExports.jsx("div", { style: { marginTop: 16 }, children: /* @__PURE__ */ jsxRuntimeExports.jsx(Banner, { tone: exit.crashed ? "error" : "info", children: exit.crashed ? `远程桌面进程异常退出（code ${exit.code ?? "—"}${exit.signal === null ? "" : `, signal ${exit.signal}`}）。可能是参数不被 FreeRDP 接受或连接中断。` : "远程桌面窗口已由用户关闭，会话结束。" }) }) : null,
      /* @__PURE__ */ jsxRuntimeExports.jsx("p", { className: "t-field__hint", style: { marginTop: 18 }, children: "说明：本次不做内嵌画面。把外部窗口的画面搬进标签页需要 RDP 协议级实现或窗口嵌入 （X11 下还要处理无边框重定向），属于独立课题，不在本轮范围。" })
    ] })
  ] });
}
export {
  RdpView,
  RdpView as default
};
