import { r as reactExports, u as useStoreShallow, U as subscribe, a0 as Events, j as jsxRuntimeExports, I as Icon, B as Badge, h as Button, t as toast, n as IconButton, f as Banner, J as EmptyState, i as invoke, e as errorText } from "./index-CwfghMy4.js";
const STATE_LABEL = {
  idle: "空闲",
  connecting: "连接中",
  authenticating: "认证中",
  "verifying-host-key": "校验主机指纹",
  ready: "已连接",
  disconnected: "已断开",
  failed: "失败"
};
function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8ClampedArray(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}
function bgraToRgbaInPlace(bytes) {
  for (let i = 0; i + 3 < bytes.length; i += 4) {
    const b = bytes[i] ?? 0;
    bytes[i] = bytes[i + 2] ?? 0;
    bytes[i + 2] = b;
  }
}
const SPECIAL_KEYSYMS = {
  Backspace: 65288,
  Tab: 65289,
  Enter: 65293,
  Escape: 65307,
  Delete: 65535,
  Insert: 65379,
  Home: 65360,
  End: 65367,
  PageUp: 65365,
  PageDown: 65366,
  ArrowLeft: 65361,
  ArrowUp: 65362,
  ArrowRight: 65363,
  ArrowDown: 65364,
  Shift: 65505,
  Control: 65507,
  Alt: 65513,
  Meta: 65511,
  CapsLock: 65509,
  F1: 65470,
  F2: 65471,
  F3: 65472,
  F4: 65473,
  F5: 65474,
  F6: 65475,
  F7: 65476,
  F8: 65477,
  F9: 65478,
  F10: 65479,
  F11: 65480,
  F12: 65481
};
function toKeysym(e) {
  const special = SPECIAL_KEYSYMS[e.key];
  if (special !== void 0) return special;
  if (e.key.length === 1) {
    const cp = e.key.codePointAt(0);
    if (cp === void 0) return null;
    return cp < 256 ? cp : 16777216 | cp;
  }
  return null;
}
function toButtonMask(buttons) {
  let mask = 0;
  if (buttons & 1) mask |= 1;
  if (buttons & 4) mask |= 2;
  if (buttons & 2) mask |= 4;
  return mask;
}
function VncViewer({
  sessionId,
  title,
  viewOnly,
  scaleViewport,
  clipViewport
}) {
  const canvasRef = reactExports.useRef(null);
  const ctxRef = reactExports.useRef(null);
  const sizeRef = reactExports.useRef({ w: 0, h: 0 });
  const queueRef = reactExports.useRef([]);
  const rafRef = reactExports.useRef(0);
  const [state, setState] = reactExports.useState("connecting");
  const [message, setMessage] = reactExports.useState(null);
  const [size, setSize] = reactExports.useState(null);
  const [stats, setStats] = reactExports.useState({ frames: 0, rects: 0 });
  const [clipboard, setClipboard] = reactExports.useState(null);
  const bellMode = useStoreShallow((s) => ({ bell: s.bellMode })).bell;
  const flush = reactExports.useCallback(() => {
    rafRef.current = 0;
    const ctx = ctxRef.current;
    const canvas = canvasRef.current;
    const rects = queueRef.current;
    if (!ctx || !canvas || rects.length === 0) return;
    queueRef.current = [];
    let drawn = 0;
    for (const r of rects) {
      try {
        if (r.pixels) {
          const bytes = base64ToBytes(r.pixels);
          bgraToRgbaInPlace(bytes);
          const img = ctx.createImageData(r.width, r.height);
          img.data.set(bytes);
          ctx.putImageData(img, r.x, r.y);
          drawn += 1;
        } else if (r.copyFrom) {
          ctx.drawImage(
            canvas,
            r.copyFrom.x,
            r.copyFrom.y,
            r.width,
            r.height,
            r.x,
            r.y,
            r.width,
            r.height
          );
          drawn += 1;
        }
      } catch {
      }
    }
    setStats((s) => ({ frames: s.frames + 1, rects: s.rects + drawn }));
  }, []);
  const enqueue = reactExports.useCallback(
    (rects) => {
      queueRef.current.push(...rects);
      if (rafRef.current === 0) rafRef.current = requestAnimationFrame(flush);
    },
    [flush]
  );
  reactExports.useEffect(() => {
    if (!sessionId) return;
    return subscribe(Events.VNC_FRAME, (p) => {
      if (p.sessionId !== sessionId) return;
      const cur = sizeRef.current;
      if (cur.w !== p.framebufferWidth || cur.h !== p.framebufferHeight) {
        sizeRef.current = { w: p.framebufferWidth, h: p.framebufferHeight };
        const canvas = canvasRef.current;
        if (canvas) {
          canvas.width = p.framebufferWidth;
          canvas.height = p.framebufferHeight;
          ctxRef.current = canvas.getContext("2d");
        }
        setSize({ w: p.framebufferWidth, h: p.framebufferHeight });
      }
      enqueue(p.rects ?? []);
    });
  }, [sessionId, enqueue]);
  reactExports.useEffect(
    () => () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    },
    []
  );
  reactExports.useEffect(() => {
    if (!sessionId) return;
    const offs = [
      subscribe(Events.VNC_STATE, (p) => {
        if (p.sessionId !== sessionId) return;
        setState(p.state);
        setMessage(p.message ?? null);
      }),
      subscribe(Events.VNC_ERROR, (p) => {
        if (p.sessionId !== sessionId) return;
        setState("failed");
        setMessage(p.message);
      }),
      subscribe(Events.VNC_CLIPBOARD, (p) => {
        if (p.sessionId !== sessionId) return;
        setClipboard(p.text);
      }),
      subscribe(Events.VNC_BELL, (p) => {
        if (p.sessionId !== sessionId) return;
        if (bellMode === "sound") {
          try {
            const Ctx = window.AudioContext ?? window.webkitAudioContext;
            if (Ctx) {
              const ac = new Ctx();
              const osc = ac.createOscillator();
              const gain = ac.createGain();
              gain.gain.value = 0.04;
              osc.frequency.value = 800;
              osc.connect(gain).connect(ac.destination);
              osc.start();
              osc.stop(ac.currentTime + 0.08);
            }
          } catch {
          }
        }
        setMessage("远端发出响铃");
      })
    ];
    return () => {
      for (const off of offs) off();
    };
  }, [sessionId, bellMode]);
  const toFb = (e) => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    const x = Math.floor((e.clientX - rect.left) / rect.width * canvas.width);
    const y = Math.floor((e.clientY - rect.top) / rect.height * canvas.height);
    return {
      x: Math.max(0, Math.min(canvas.width - 1, x)),
      y: Math.max(0, Math.min(canvas.height - 1, y))
    };
  };
  const pointer = (e) => {
    if (viewOnly || !sessionId) return;
    const pos = toFb(e);
    if (!pos) return;
    void invoke("vnc", "sendPointer", {
      sessionId,
      buttonMask: toButtonMask(e.buttons),
      x: pos.x,
      y: pos.y
    }).catch(() => void 0);
  };
  const onKey = (e, down) => {
    if (viewOnly || !sessionId) return;
    const keysym = toKeysym(e);
    if (keysym === null) return;
    e.preventDefault();
    void invoke("vnc", "sendKey", {
      sessionId,
      keysym,
      down
    }).catch(() => void 0);
  };
  const canvasStyle = reactExports.useMemo(() => {
    if (!size) return {};
    if (clipViewport) return { maxWidth: "100%", maxHeight: "100%" };
    if (scaleViewport) return { width: "100%", height: "auto" };
    return {};
  }, [size, clipViewport, scaleViewport]);
  const ready = state === "ready";
  return /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "vnc", children: [
    /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "t-toolbar", children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx(Icon, { name: "eye", size: 15 }),
      /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "panel-title", children: title }),
      /* @__PURE__ */ jsxRuntimeExports.jsx(Badge, { tone: ready ? "ok" : state === "failed" ? "danger" : "accent", children: STATE_LABEL[state] ?? state }),
      viewOnly ? /* @__PURE__ */ jsxRuntimeExports.jsx(Badge, { tone: "warn", children: "只读（不回送键鼠）" }) : null,
      size ? /* @__PURE__ */ jsxRuntimeExports.jsxs("span", { className: "term-toolbar__meta", children: [
        size.w,
        "×",
        size.h,
        " · 已渲染 ",
        stats.frames,
        " 帧 / ",
        stats.rects,
        " 矩形"
      ] }) : null,
      /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "t-toolbar__spacer" }),
      clipboard !== null ? /* @__PURE__ */ jsxRuntimeExports.jsx(
        Button,
        {
          size: "sm",
          variant: "outline",
          icon: "copy",
          title: clipboard.slice(0, 120),
          onClick: () => {
            void navigator.clipboard.writeText(clipboard);
            toast.ok("已复制远端剪贴板内容");
          },
          children: "取回剪贴板"
        }
      ) : null,
      /* @__PURE__ */ jsxRuntimeExports.jsx(IconButton, { icon: "refresh", label: "重新连接", onClick: () => window.location.reload() })
    ] }),
    state === "failed" ? /* @__PURE__ */ jsxRuntimeExports.jsx("div", { style: { padding: "10px 12px 0" }, children: /* @__PURE__ */ jsxRuntimeExports.jsxs(Banner, { tone: "error", children: [
      "连接失败：",
      message ?? "未知原因"
    ] }) }) : null,
    /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "vnc-stage", children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx(
        "canvas",
        {
          ref: canvasRef,
          className: `vnc-canvas${ready ? "" : " vnc-canvas--hidden"}`,
          style: canvasStyle,
          tabIndex: 0,
          onMouseDown: (e) => {
            e.currentTarget.focus();
            pointer(e);
          },
          onMouseUp: pointer,
          onMouseMove: (e) => {
            if (e.buttons !== 0) pointer(e);
          },
          onContextMenu: (e) => e.preventDefault(),
          onKeyDown: (e) => onKey(e, true),
          onKeyUp: (e) => onKey(e, false)
        }
      ),
      !ready ? /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "vnc-overlay", children: state === "failed" ? /* @__PURE__ */ jsxRuntimeExports.jsx(
        EmptyState,
        {
          icon: "alert-triangle",
          title: "画面不可用",
          text: message ?? "连接失败或已断开。"
        }
      ) : /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "t-loading", children: [
        /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "t-spinner", "aria-hidden": true }),
        /* @__PURE__ */ jsxRuntimeExports.jsxs("span", { children: [
          STATE_LABEL[state] ?? state,
          "…"
        ] })
      ] }) }) : null
    ] }),
    /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "term-pane__status", children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx("span", { children: viewOnly ? "只读模式：不会发送任何键鼠事件" : "鼠标键盘已转发（X11 keysym）" }),
      /* @__PURE__ */ jsxRuntimeExports.jsx("div", { style: { flex: 1 } }),
      /* @__PURE__ */ jsxRuntimeExports.jsxs("span", { children: [
        "缩放 ",
        scaleViewport ? "自适应" : "原始",
        " · ",
        clipViewport ? "裁剪" : "不裁剪"
      ] })
    ] })
  ] });
}
async function connectVnc(connection) {
  try {
    const res = await invoke("vnc", "connect", { connection });
    return {
      sessionId: res.sessionId,
      scaleViewport: res.scaleViewport === true,
      clipViewport: res.clipViewport === true
    };
  } catch (err) {
    toast.error(`VNC 连接失败：${errorText(err)}`);
    return null;
  }
}
export {
  VncViewer,
  connectVnc,
  VncViewer as default
};
