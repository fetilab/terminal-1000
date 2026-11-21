const __vite__mapDeps=(i,m=__vite__mapDeps,d=(m.f||(m.f=["./engine-CUOvIwGl.js","./index-CwfghMy4.js","./index-DD-jW_Hd.css","./QuickCommandPanel-BuPbt0Xz.js","./highlights-DAa5Pc3k.js","./QuickCommandPanel-66ziIXgP.css","./xterm-GVL3fBIr.css","./terminal-v87mNeZ6.css","./MonitorPanel-CaOAOq7p.js","./VirtualList-CIIV3xPp.js","./MonitorPanel-BAzegy-z.css","./SftpBrowser-DvVJlZbd.js","./CodeEditor-_oooyGAs.js","./SftpBrowser-NdRs7ClF.css","./VncViewer-D7EMM2WE.js","./VncViewer-vcU0X4vj.css","./RdpView-De_UW8x5.js","./TunnelView-BZ2pXtye.js"])))=>i.map(i=>d[i]);
import { r as reactExports, j as jsxRuntimeExports, O as reactDomExports, I as Icon, B as Badge, u as useStoreShallow, i as invoke, _ as __vitePreload, t as toast, P as broadcastGroupOf, Q as sendBroadcast, e as errorText, R as setSessionCwd, U as subscribe, n as IconButton, a as actions, V as setTabLayout, W as stopSessionLog, X as startSessionLog, Y as loadSessionLogs, Z as getConnection, $ as closeTab, c as connectTo, a0 as Events, a1 as loadBroadcastGroups, J as EmptyState, h as Button, a2 as openLocalTerminal, s as setActiveTab, a3 as toggleTabFiles, a4 as setBroadcastMode, a5 as dissolveBroadcastGroup, a6 as toggleTabMonitor, L as Loading } from "./index-CwfghMy4.js";
/* empty css               */
import { s as segmentText, a as segmentHighlightStyle, n as normalizeHexColor, c as cellsFor } from "./highlights-DAa5Pc3k.js";
/* empty css                  */
function Splitter({
  size,
  min,
  max,
  onResize,
  side,
  onReset,
  label,
  thin = false
}) {
  const [dragging, setDragging] = reactExports.useState(false);
  const drag = reactExports.useRef(null);
  const clamp2 = (n) => Math.min(max, Math.max(min, n));
  const onPointerDown = reactExports.useCallback(
    (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      drag.current = { startX: e.clientX, startSize: size };
      setDragging(true);
      document.documentElement.classList.add("t-resizing");
      const move = (ev) => {
        const d = drag.current;
        if (!d) return;
        const delta = side === "left" ? ev.clientX - d.startX : d.startX - ev.clientX;
        onResize(clamp2(d.startSize + delta));
      };
      const end = () => {
        drag.current = null;
        setDragging(false);
        document.documentElement.classList.remove("t-resizing");
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", end);
        window.removeEventListener("pointercancel", end);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", end);
      window.addEventListener("pointercancel", end);
    },
    [max, min, onResize, side, size]
  );
  const onKeyDown = (e) => {
    const step = e.shiftKey ? 48 : 16;
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      const dir = e.key === "ArrowRight" ? 1 : -1;
      onResize(clamp2(size + dir * step * (side === "left" ? 1 : -1)));
      return;
    }
    if (e.key === "Home" && onReset) {
      e.preventDefault();
      onReset();
    }
  };
  return /* @__PURE__ */ jsxRuntimeExports.jsx(
    "div",
    {
      role: "separator",
      "aria-orientation": "vertical",
      "aria-label": label,
      "aria-valuenow": size,
      "aria-valuemin": min,
      "aria-valuemax": max,
      tabIndex: 0,
      title: `${label}（双击复位）`,
      className: `t-splitter${thin ? " t-splitter--thin" : ""}${dragging ? " t-splitter--active" : ""}`,
      onPointerDown,
      onDoubleClick: () => onReset?.(),
      onKeyDown
    }
  );
}
function readWidth(key, initial, min, max) {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return initial;
    const n = Number(raw);
    if (!Number.isFinite(n)) return initial;
    return Math.min(max, Math.max(min, Math.round(n)));
  } catch {
    return initial;
  }
}
function usePaneWidth({ key, initial, min, max }) {
  const [width, setWidthState] = reactExports.useState(() => readWidth(key, initial, min, max));
  const timer = reactExports.useRef(null);
  const persist = reactExports.useCallback(
    (value) => {
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => {
        try {
          localStorage.setItem(key, String(value));
        } catch {
        }
      }, 200);
    },
    [key]
  );
  const setWidth = reactExports.useCallback(
    (next) => {
      const clamped = Math.min(max, Math.max(min, Math.round(next)));
      setWidthState(clamped);
      persist(clamped);
    },
    [max, min, persist]
  );
  const reset = reactExports.useCallback(() => {
    setWidthState(initial);
    persist(initial);
  }, [initial, persist]);
  reactExports.useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    []
  );
  return { width, setWidth, reset, min, max };
}
function ContextMenu({ open, x, y, items, onClose }) {
  const ref = reactExports.useRef(null);
  const [pos, setPos] = reactExports.useState({ left: x, top: y });
  reactExports.useLayoutEffect(() => {
    if (!open) return;
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const left = x + rect.width > window.innerWidth - 8 ? Math.max(8, x - rect.width) : x;
    const top = y + rect.height > window.innerHeight - 8 ? Math.max(8, y - rect.height) : y;
    setPos({ left, top });
  }, [open, x, y, items.length]);
  reactExports.useEffect(() => {
    if (!open) return;
    const close = () => onClose();
    const onKey = (e) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("pointerdown", close, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("pointerdown", close, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", close);
    };
  }, [open, onClose]);
  if (!open) return null;
  return reactDomExports.createPortal(
    /* @__PURE__ */ jsxRuntimeExports.jsx(
      "div",
      {
        ref,
        className: "ctxmenu",
        style: { left: pos.left, top: pos.top },
        role: "menu",
        onPointerDown: (e) => e.stopPropagation(),
        children: items.map((item) => /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { children: [
          item.separatorBefore ? /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "ctxmenu__sep", role: "separator" }) : null,
          /* @__PURE__ */ jsxRuntimeExports.jsxs(
            "button",
            {
              type: "button",
              role: "menuitem",
              className: `ctxmenu__item${item.danger ? " ctxmenu__item--danger" : ""}`,
              disabled: item.disabled,
              title: item.title,
              onClick: () => {
                item.onSelect();
                onClose();
              },
              children: [
                /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "ctxmenu__icon", children: item.icon ? /* @__PURE__ */ jsxRuntimeExports.jsx(Icon, { name: item.icon, size: 14 }) : null }),
                /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "ctxmenu__label", children: item.label }),
                item.hint ? /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "ctxmenu__hint", children: item.hint }) : null
              ]
            }
          )
        ] }, item.id))
      }
    ),
    document.body
  );
}
const KIND_LABEL = {
  command: "命令",
  subcommand: "子命令",
  option: "选项",
  history: "历史",
  directory: "目录",
  argument: "参数",
  ai: "AI"
};
class LineTracker {
  constructor() {
    this.buffer = "";
    this.unreliable = false;
  }
  get line() {
    return this.buffer;
  }
  get cursor() {
    return this.buffer.length;
  }
  get isReliable() {
    return !this.unreliable;
  }
  reset() {
    this.buffer = "";
    this.unreliable = false;
  }
  /** 消费一段来自终端的输入字节，返回是否需要重新计算补全 */
  consume(data) {
    for (let i = 0; i < data.length; i += 1) {
      const ch = data[i];
      if (ch === void 0) continue;
      if (ch === "\r" || ch === "\n") {
        this.reset();
        continue;
      }
      if (ch === "" || ch === "" || ch === "" || ch === "\x1B") {
        if (ch === "\x1B") this.unreliable = true;
        else this.reset();
        continue;
      }
      if (ch === "" || ch === "\b") {
        this.buffer = this.buffer.slice(0, -1);
        continue;
      }
      if (ch < " ") continue;
      this.buffer += ch;
    }
  }
}
function applyCandidate(line, context, candidate) {
  const start = Math.max(0, Math.min(context.tokenStart, line.length));
  const end = Math.max(start, Math.min(context.replaceEnd, line.length));
  const backspaces = "".repeat(end - start);
  const nextLine = line.slice(0, start) + candidate.value + line.slice(end);
  return {
    payload: `${backspaces}${candidate.value}`,
    line: nextLine,
    cursor: start + candidate.value.length
  };
}
const KIND_ICON = {
  command: "terminal",
  subcommand: "chevron-right",
  option: "sliders",
  history: "clock",
  directory: "folder",
  argument: "list",
  ai: "zap"
};
const MAX_ROWS = 8;
function CompletionPopup({
  candidates,
  selected,
  onHover,
  onAccept,
  elapsedMs,
  specName,
  aiRequested,
  anchor
}) {
  if (candidates.length === 0) return null;
  const current = candidates[Math.min(selected, candidates.length - 1)];
  const list = candidates.slice(0, MAX_ROWS);
  const style = anchor ? {
    left: anchor.left,
    width: anchor.width,
    maxHeight: anchor.maxHeight,
    ...anchor.placement === "above" ? { bottom: anchor.bottom } : { top: anchor.top }
  } : {};
  return /* @__PURE__ */ jsxRuntimeExports.jsxs(
    "div",
    {
      className: "completion",
      role: "listbox",
      "aria-label": "命令补全候选",
      "data-placement": anchor?.placement ?? "float",
      style,
      children: [
        /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "completion__head", children: [
          /* @__PURE__ */ jsxRuntimeExports.jsx(Icon, { name: "zap", size: 12 }),
          /* @__PURE__ */ jsxRuntimeExports.jsx("span", { children: "补全" }),
          specName ? /* @__PURE__ */ jsxRuntimeExports.jsx(Badge, { tone: "outline", children: specName }) : null,
          aiRequested ? /* @__PURE__ */ jsxRuntimeExports.jsx(Badge, { tone: "accent", children: "AI" }) : null,
          /* @__PURE__ */ jsxRuntimeExports.jsxs("span", { className: "completion__count", children: [
            candidates.length,
            " 项",
            elapsedMs === void 0 ? "" : ` · ${Math.round(elapsedMs)}ms`
          ] })
        ] }),
        /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "completion__list", children: [
          list.map((c, i) => /* @__PURE__ */ jsxRuntimeExports.jsxs(
            "button",
            {
              type: "button",
              role: "option",
              "aria-selected": i === selected,
              className: `completion__item${i === selected ? " completion__item--active" : ""}`,
              onMouseEnter: () => onHover(i),
              onMouseDown: (e) => {
                e.preventDefault();
                onAccept(i);
              },
              children: [
                /* @__PURE__ */ jsxRuntimeExports.jsx(Icon, { name: KIND_ICON[c.kind], size: 12 }),
                /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "completion__label", children: c.label ?? c.value }),
                /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "completion__kind", children: KIND_LABEL[c.kind] }),
                c.description ? /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "completion__desc", children: c.description }) : null
              ]
            },
            `${c.value}-${i}`
          )),
          candidates.length > list.length ? /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "completion__more", children: [
            "还有 ",
            candidates.length - list.length,
            " 项，继续输入以缩小范围"
          ] }) : null
        ] }),
        current?.description ? /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "completion__preview", children: [
          /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "completion__preview-title", children: current.label ?? current.value }),
          /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "completion__preview-body", children: current.description })
        ] }) : null,
        /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "completion__foot", children: [
          /* @__PURE__ */ jsxRuntimeExports.jsx("kbd", { className: "t-kbd", children: "↑" }),
          /* @__PURE__ */ jsxRuntimeExports.jsx("kbd", { className: "t-kbd", children: "↓" }),
          /* @__PURE__ */ jsxRuntimeExports.jsx("kbd", { className: "t-kbd", children: "Tab" }),
          /* @__PURE__ */ jsxRuntimeExports.jsx("kbd", { className: "t-kbd", children: "Esc" }),
          /* @__PURE__ */ jsxRuntimeExports.jsx("span", { children: "选择 / 接受 / 关闭" })
        ] })
      ]
    }
  );
}
const DEFAULT_MARGIN = 8;
const DEFAULT_GAP = 6;
const DEFAULT_MIN_COMFORT = 168;
const MIN_WIDTH = 240;
const MIN_HEIGHT = 96;
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
function computeCompletionAnchor(input) {
  const margin = input.margin ?? DEFAULT_MARGIN;
  const gap = input.gap ?? DEFAULT_GAP;
  const minComfort = input.minComfortHeight ?? DEFAULT_MIN_COMFORT;
  const cursorLeft = input.screen.left + input.cursor.x * input.cell.width;
  const cursorTop = input.screen.top + input.cursor.y * input.cell.height;
  const cursorBottom = cursorTop + input.cell.height;
  const availableWidth = Math.max(MIN_WIDTH, input.pane.width - margin * 2);
  const width = clamp(input.preferred.width, MIN_WIDTH, availableWidth);
  const spaceAbove = cursorTop - gap - margin;
  const spaceBelow = input.pane.height - cursorBottom - gap - margin;
  const placement = spaceAbove >= minComfort ? "above" : spaceBelow > spaceAbove ? "below" : "above";
  const space = placement === "above" ? spaceAbove : spaceBelow;
  const maxHeight = clamp(space, MIN_HEIGHT, Math.max(MIN_HEIGHT, input.preferred.height));
  const left = clamp(cursorLeft, margin, Math.max(margin, input.pane.width - width - margin));
  const anchor = { placement, left, width, maxHeight };
  if (placement === "above") {
    anchor.bottom = Math.max(margin, input.pane.height - (cursorTop - gap));
  } else {
    anchor.top = cursorBottom + gap;
  }
  return anchor;
}
const MAX_BUFFER_CHARS = 4 * 1024 * 1024;
const EMOJI_FALLBACK_FONTS = '"Noto Color Emoji", "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol"';
const withEmojiFallback = (fontFamily) => /emoji/i.test(fontFamily) ? fontFamily : `${fontFamily}, ${EMOJI_FALLBACK_FONTS}`;
class BackpressureWriter {
  constructor() {
    this.term = null;
    this.queue = [];
    this.buffered = 0;
    this.writing = false;
    this.dropped = 0;
  }
  attach(term) {
    this.term = term;
    this.drain();
  }
  detach() {
    this.term = null;
    this.queue = [];
    this.buffered = 0;
    this.writing = false;
  }
  /** 累计被丢弃的字符数，供状态栏展示 */
  get droppedChars() {
    return this.dropped;
  }
  get pendingChars() {
    return this.buffered;
  }
  push(data) {
    if (data.length === 0) return;
    this.buffered += data.length;
    if (this.buffered > MAX_BUFFER_CHARS) {
      this.dropped += this.buffered;
      this.queue = [];
      this.buffered = 0;
      this.queue.push(
        "\r\n\x1B[33m[输出过快，渲染层已丢弃积压内容以保持可交互]\x1B[0m\r\n"
      );
    } else {
      this.queue.push(data);
    }
    this.drain();
  }
  drain() {
    const term = this.term;
    if (!term || this.writing || this.queue.length === 0) return;
    const batch = this.queue.join("");
    this.queue = [];
    this.buffered = 0;
    this.writing = true;
    term.write(batch, () => {
      this.writing = false;
      this.drain();
    });
  }
}
function sessionPayload(kind, sessionId, extra) {
  return kind === "local" ? { ptyId: sessionId, ...extra } : { sessionId, ...extra };
}
function pasteFromClipboard(target) {
  void navigator.clipboard.readText().then((text) => {
    if (text) target?.paste(text);
    else toast.info("剪贴板是空的，没有可粘贴的内容");
  }).catch(() => toast.warn("读取剪贴板失败：系统可能未授予剪贴板权限"));
}
const TERMINAL_THEME = {
  background: "#0d0f14",
  foreground: "#e4e7ee",
  cursor: "#3ec9d6",
  cursorAccent: "#0d0f14",
  selectionBackground: "rgba(62, 201, 214, 0.28)",
  black: "#1e222b",
  red: "#e5484d",
  green: "#46b17b",
  yellow: "#d9a441",
  blue: "#6f8dff",
  magenta: "#b48ce0",
  cyan: "#3ec9d6",
  white: "#c6ccd8",
  brightBlack: "#4c5361",
  brightRed: "#ff6b6f",
  brightGreen: "#63d29a",
  brightYellow: "#f0c065",
  brightBlue: "#8fa6ff",
  brightMagenta: "#cfa8f0",
  brightCyan: "#63dde8",
  brightWhite: "#f2f4f8"
};
const TERMINAL_THEME_HC = {
  ...TERMINAL_THEME,
  background: "#000000",
  foreground: "#ffffff",
  cursor: "#ffff00",
  selectionBackground: "rgba(255, 255, 0, 0.32)",
  brightBlack: "#8a8a8a"
};
function parseOsc7(data) {
  const raw = data.trim();
  const withoutScheme = raw.startsWith("file://") ? raw.slice("file://".length) : raw;
  const slash = withoutScheme.indexOf("/");
  if (slash < 0) return null;
  const path = withoutScheme.slice(slash);
  try {
    return decodeURIComponent(path) || null;
  } catch {
    return path || null;
  }
}
function themeFor(colorScheme, resolved) {
  if (colorScheme === "light") return TERMINAL_THEME_LIGHT;
  if (colorScheme === "high-contrast") return TERMINAL_THEME_HC;
  return resolved === "light" ? TERMINAL_THEME_LIGHT : TERMINAL_THEME;
}
const TERMINAL_THEME_LIGHT = {
  ...TERMINAL_THEME,
  background: "#fbfcfe",
  foreground: "#1b2029",
  cursor: "#12909e",
  cursorAccent: "#fbfcfe",
  selectionBackground: "rgba(18, 144, 158, 0.24)"
};
function TerminalPane({ tab, visible }) {
  const paneRef = reactExports.useRef(null);
  const hostRef = reactExports.useRef(null);
  const termRef = reactExports.useRef(null);
  const fitRef = reactExports.useRef(null);
  const searchRef = reactExports.useRef(null);
  const writerRef = reactExports.useRef(new BackpressureWriter());
  const tabRef = reactExports.useRef(tab);
  tabRef.current = tab;
  const [ready, setReady] = reactExports.useState(false);
  const [error, setError] = reactExports.useState(null);
  const [findOpen, setFindOpen] = reactExports.useState(false);
  const [menu, setMenu] = reactExports.useState(null);
  const [findText, setFindText] = reactExports.useState("");
  const [dims, setDims] = reactExports.useState(null);
  const kittyRef = reactExports.useRef(null);
  const kittyBrokenRef = reactExports.useRef(false);
  const [engineNonce, setEngineNonce] = reactExports.useState(0);
  const [backendLabel, setBackendLabel] = reactExports.useState("");
  const trackerRef = reactExports.useRef(new LineTracker());
  const historyRef = reactExports.useRef([]);
  const [completion, setCompletion] = reactExports.useState(null);
  const [selected, setSelected] = reactExports.useState(0);
  const [anchor, setAnchor] = reactExports.useState(null);
  const completionSeq = reactExports.useRef(0);
  const writeWarnedRef = reactExports.useRef(false);
  const debounceTimer = reactExports.useRef(void 0);
  const debounceMsRef = reactExports.useRef(80);
  const resolvedTheme = useStoreShallow((s) => ({ resolvedTheme: s.resolvedTheme })).resolvedTheme;
  const sessionCwd = useStoreShallow((s) => ({
    v: tab.sessionId ? s.sessionCwd[tab.sessionId] : void 0
  })).v;
  const termCfg = useStoreShallow((s) => ({ t: s.terminalSettings })).t;
  const toolbarVisible = useStoreShallow((s) => ({ v: s.toolbarVisible })).v;
  const zebra = termCfg.zebraStripes;
  const [zebraSupported, setZebraSupported] = reactExports.useState(true);
  const linksCtorRef = reactExports.useRef(null);
  const linksAddonRef = reactExports.useRef(null);
  const sessionIdRef = reactExports.useRef(tab.sessionId);
  sessionIdRef.current = tab.sessionId;
  const highlightRules = useStoreShallow((s) => ({ r: s.highlightRules })).r;
  const highlightRulesRef = reactExports.useRef(highlightRules);
  highlightRulesRef.current = highlightRules;
  const termSettingsRef = reactExports.useRef(termCfg);
  termSettingsRef.current = termCfg;
  const resolvedThemeRef = reactExports.useRef(resolvedTheme);
  resolvedThemeRef.current = resolvedTheme;
  const recording = useStoreShallow((s) => ({
    rec: s.activeRecordings.find((r) => r.sessionId === tab.sessionId)
  })).rec;
  const negotiations = useStoreShallow((s) => ({
    list: tab.sessionId ? s.negotiations[tab.sessionId] : void 0
  })).list;
  const [negOpen, setNegOpen] = reactExports.useState(false);
  const [everVisible, setEverVisible] = reactExports.useState(visible);
  reactExports.useEffect(() => {
    if (visible) setEverVisible(true);
  }, [visible]);
  const closeCompletion = reactExports.useCallback(() => {
    window.clearTimeout(debounceTimer.current);
    completionSeq.current += 1;
    setCompletion(null);
    setSelected(0);
  }, []);
  const requestCompletion = reactExports.useCallback(async () => {
    const tab2 = tabRef.current;
    if (!tab2.sessionId) return;
    const tracker = trackerRef.current;
    const line = tracker.line;
    if (!tracker.isReliable || line.trim().length === 0) {
      setCompletion(null);
      return;
    }
    const seq = ++completionSeq.current;
    try {
      const res = await invoke(
        "completion",
        "complete",
        {
          line,
          cursor: tracker.cursor,
          history: historyRef.current.slice(-200)
        }
      );
      if (seq !== completionSeq.current) return;
      debounceMsRef.current = res.debounceMs ?? debounceMsRef.current;
      if (!res.candidates || res.candidates.length === 0) {
        setCompletion(null);
        return;
      }
      setCompletion(res);
      setSelected(0);
    } catch {
      if (seq === completionSeq.current) setCompletion(null);
    }
  }, []);
  const scheduleCompletion = reactExports.useCallback(() => {
    window.clearTimeout(debounceTimer.current);
    debounceTimer.current = window.setTimeout(() => void requestCompletion(), debounceMsRef.current);
  }, [requestCompletion]);
  const refreshAnchor = reactExports.useCallback(() => {
    const term = termRef.current;
    const pane = paneRef.current;
    if (!term || !pane) return;
    const screen = term.element?.querySelector(".xterm-screen");
    if (!screen || term.cols <= 0 || term.rows <= 0) return;
    const s = screen.getBoundingClientRect();
    const p = pane.getBoundingClientRect();
    if (s.width <= 0 || s.height <= 0 || p.width <= 0 || p.height <= 0) return;
    const buf = term.buffer.active;
    setAnchor(
      computeCompletionAnchor({
        cursor: { x: buf.cursorX, y: buf.cursorY },
        cell: { width: s.width / term.cols, height: s.height / term.rows },
        screen: { left: s.left - p.left, top: s.top - p.top, width: s.width, height: s.height },
        pane: { width: p.width, height: p.height },
        preferred: { width: 400, height: 300 }
      })
    );
  }, []);
  reactExports.useEffect(() => {
    if (!completion) return;
    refreshAnchor();
    const term = termRef.current;
    if (!term) return;
    let raf = 0;
    const tick = () => {
      if (raf !== 0) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        refreshAnchor();
      });
    };
    const sub = term.onRender(tick);
    const pane = paneRef.current;
    const ro = pane ? new ResizeObserver(tick) : null;
    if (pane && ro) ro.observe(pane);
    return () => {
      sub.dispose();
      ro?.disconnect();
      if (raf !== 0) cancelAnimationFrame(raf);
    };
  }, [completion, refreshAnchor]);
  const acceptCandidate = reactExports.useCallback(
    (index) => {
      const res = completion;
      const candidate = res?.candidates[index];
      const tab2 = tabRef.current;
      if (!res || !candidate || !tab2.sessionId) return;
      const applied = applyCandidate(trackerRef.current.line, res.context, candidate);
      trackerRef.current.reset();
      trackerRef.current.consume(applied.line);
      closeCompletion();
      const domain = tab2.kind === "ssh" ? "ssh" : "pty";
      void invoke(domain, "write", sessionPayload(tab2.kind, tab2.sessionId, { data: applied.payload })).catch(
        () => void 0
      );
    },
    [completion, closeCompletion]
  );
  const ringBell = reactExports.useCallback(() => {
    const mode = termSettingsRef.current.bell;
    if (mode === "none") return;
    if (mode === "sound") {
      try {
        const Ctx = window.AudioContext ?? window.webkitAudioContext;
        if (Ctx) {
          const ac = new Ctx();
          const osc = ac.createOscillator();
          const gain = ac.createGain();
          gain.gain.value = 0.03;
          osc.frequency.value = 760;
          osc.connect(gain).connect(ac.destination);
          osc.start();
          osc.stop(ac.currentTime + 0.07);
        }
      } catch {
      }
      return;
    }
    const el = hostRef.current;
    if (!el) return;
    el.classList.add("term-bell-flash");
    window.setTimeout(() => el.classList.remove("term-bell-flash"), 160);
  }, []);
  reactExports.useEffect(() => {
    if (!everVisible) return;
    const host = hostRef.current;
    if (!host) return;
    let disposed = false;
    const cleanups = [];
    const writer = writerRef.current;
    void (async () => {
      try {
        const [
          { Terminal: XTerm },
          { FitAddon: Fit },
          { SearchAddon: Search },
          { WebLinksAddon: Links },
          { Unicode11Addon: Unicode11 }
        ] = await Promise.all([
          __vitePreload(() => import("./xterm-CYpUPaQB.js"), true ? [] : void 0, import.meta.url),
          __vitePreload(() => import("./addon-fit-CuwN6ks5.js"), true ? [] : void 0, import.meta.url),
          __vitePreload(() => import("./addon-search-DH5tJShy.js"), true ? [] : void 0, import.meta.url),
          __vitePreload(() => import("./addon-web-links-DbgQOipZ.js"), true ? [] : void 0, import.meta.url),
          __vitePreload(() => import("./addon-unicode11-BdKAtcvp.js"), true ? [] : void 0, import.meta.url)
        ]);
        if (disposed) return;
        const st = termSettingsRef.current;
        const useKitty = st.renderer !== "xterm" && !kittyBrokenRef.current;
        let term;
        let fit;
        let search;
        if (useKitty) {
          const { KittyEngine } = await __vitePreload(async () => {
            const { KittyEngine: KittyEngine2 } = await import("./engine-CUOvIwGl.js");
            return { KittyEngine: KittyEngine2 };
          }, true ? __vite__mapDeps([0,1,2]) : void 0, import.meta.url);
          const engine = new KittyEngine({
            host,
            sessionId: tab.sessionId ?? `pending-${tab.tabId}`,
            kind: tab.kind === "telnet" ? "telnet" : tab.kind === "ssh" ? "ssh" : "local",
            settings: st,
            resolvedTheme: resolvedThemeRef.current,
            onWrite: (data) => {
              const current = tabRef.current;
              if (!current.sessionId) return;
              const group = broadcastGroupOf(current.sessionId);
              if (group && group.mode === "broadcast") {
                void sendBroadcast(group.groupId, data);
                return;
              }
              const domain = current.kind === "ssh" ? "ssh" : current.kind === "telnet" ? "telnet" : "pty";
              void invoke(domain, "write", sessionPayload(current.kind, current.sessionId, { data })).catch(
                (err) => {
                  if (writeWarnedRef.current) return;
                  writeWarnedRef.current = true;
                  toast.error(`终端写入失败：${errorText(err)}`);
                }
              );
            },
            onBell: () => ringBell(),
            onFatal: (message) => {
              kittyBrokenRef.current = true;
              toast.warn(`kitty 渲染内核异常，已回退到 xterm：${message}`);
              setEngineNonce((n) => n + 1);
            }
          });
          await engine.open();
          kittyRef.current = engine;
          term = engine;
          fit = { fit: () => engine.fit() };
          search = engine.searchShim;
          term.element?.querySelector(".xterm-screen")?.setAttribute("data-engine", "kitty");
          setBackendLabel(engine.backendLabel);
        } else {
          term = new XTerm({
            fontFamily: withEmojiFallback(st.fontFamily),
            fontSize: st.fontSize,
            lineHeight: st.lineHeight,
            letterSpacing: st.letterSpacing,
            cursorBlink: st.cursorBlink,
            cursorStyle: st.cursorStyle,
            scrollback: st.scrollback,
            allowProposedApi: true,
            convertEol: false,
            macOptionIsMeta: true,
            theme: themeFor(st.colorScheme, resolvedThemeRef.current)
          });
          const fitAddon = new Fit();
          const searchAddon = new Search();
          term.loadAddon(new Unicode11());
          term.unicode.activeVersion = "11";
          term.loadAddon(fitAddon);
          term.loadAddon(searchAddon);
          fit = fitAddon;
          search = searchAddon;
          setBackendLabel("xterm");
        }
        linksCtorRef.current = Links;
        const makeLinks = () => new Links((event, uri) => {
          event.preventDefault();
          void invoke("app", "openExternal", {
            url: uri
          }).catch(() => void 0);
        });
        if (st.linkDetection && !useKitty) {
          const addon = makeLinks();
          linksAddonRef.current = addon;
          term.loadAddon(addon);
        }
        if (!useKitty) term.open(host);
        termRef.current = term;
        fitRef.current = fit;
        searchRef.current = search;
        writer.attach(term);
        setReady(true);
        const resizeSub = term.onResize(({ cols, rows }) => {
          setDims({ cols, rows });
          const current = tabRef.current;
          if (!current.sessionId) return;
          const domain = current.kind === "ssh" ? "ssh" : "pty";
          void invoke(domain, "resize", sessionPayload(current.kind, current.sessionId, { cols, rows })).catch(
            () => void 0
          );
        });
        cleanups.push(() => resizeSub.dispose());
        const dataSub = term.onData((data) => {
          const current = tabRef.current;
          const tracker = trackerRef.current;
          const before = tracker.line;
          tracker.consume(data);
          if (data === "\r" || data === "\n") {
            const submitted = before.trim();
            if (submitted) {
              historyRef.current = [...historyRef.current.filter((h) => h !== submitted), submitted].slice(-500);
            }
            closeCompletion();
          } else if (data.length > 0) {
            scheduleCompletion();
          }
          if (!current.sessionId) return;
          const group = broadcastGroupOf(current.sessionId);
          if (group && group.mode === "broadcast") {
            void sendBroadcast(group.groupId, data);
            return;
          }
          const domain = current.kind === "ssh" ? "ssh" : current.kind === "telnet" ? "telnet" : "pty";
          void invoke(domain, "write", sessionPayload(current.kind, current.sessionId, { data })).catch(
            (err) => {
              if (writeWarnedRef.current) return;
              writeWarnedRef.current = true;
              toast.error(`终端写入失败：${errorText(err)}`);
            }
          );
        });
        cleanups.push(() => dataSub.dispose());
        const selSub = term.onSelectionChange(() => {
          if (!termSettingsRef.current.copyOnSelect) return;
          const sel = term.getSelection();
          if (sel) void navigator.clipboard.writeText(sel).catch(() => void 0);
        });
        cleanups.push(() => selSub.dispose());
        const bellSub = term.onBell(ringBell);
        cleanups.push(() => bellSub.dispose());
        const oscSub = term.parser.registerOscHandler(7, (data) => {
          const sid = sessionIdRef.current;
          const path = parseOsc7(data);
          if (path && sid) setSessionCwd(sid, path);
          return false;
        });
        cleanups.push(() => oscSub.dispose());
        const decorations = [];
        let lastScannedY = -1;
        const applyHighlights = () => {
          const rules = highlightRulesRef.current;
          if (!rules || rules.length === 0) return;
          const buf = term.buffer.active;
          const curY = buf.baseY + buf.cursorY;
          if (lastScannedY < 0) lastScannedY = Math.max(0, curY - 1);
          if (curY <= lastScannedY) {
            lastScannedY = curY;
            return;
          }
          for (let y = lastScannedY; y < curY; y += 1) {
            const line = buf.getLine(y);
            if (!line) continue;
            const text = line.translateToString(true);
            if (!text) continue;
            for (const seg of segmentText(text, rules)) {
              if (!seg.rule) continue;
              const style = segmentHighlightStyle(seg.rule);
              if (style.color === void 0) continue;
              const fg = normalizeHexColor(style.color);
              if (!fg) continue;
              const x = cellsFor(text, seg.start);
              const width = Math.max(1, cellsFor(text, seg.end) - x);
              const marker = term.registerMarker(y - curY);
              if (!marker) continue;
              const deco = term.registerDecoration({
                marker,
                anchor: "left",
                x,
                width,
                height: 1,
                layer: "top",
                foregroundColor: fg
              });
              if (!deco) {
                marker.dispose();
                continue;
              }
              deco.onRender((el) => {
                el.textContent = "";
                el.style.pointerEvents = "none";
              });
              decorations.push(deco);
              deco.onDispose(() => {
                const i = decorations.indexOf(deco);
                if (i >= 0) decorations.splice(i, 1);
              });
            }
          }
          lastScannedY = curY;
        };
        const writeSub = term.onWriteParsed(applyHighlights);
        cleanups.push(() => {
          writeSub.dispose();
          for (const d of decorations) d.dispose();
          decorations.length = 0;
        });
        requestAnimationFrame(() => {
          if (disposed) return;
          fitSafely(host, fit);
          term.focus();
        });
      } catch (err) {
        if (!disposed) {
          setError(err instanceof Error ? err.message : String(err));
        }
      }
    })();
    return () => {
      disposed = true;
      for (const fn of cleanups) fn();
      window.clearTimeout(debounceTimer.current);
      writer.detach();
      termRef.current?.dispose();
      termRef.current = null;
      kittyRef.current = null;
      setBackendLabel("");
      fitRef.current = null;
      searchRef.current = null;
      setReady(false);
    };
  }, [everVisible, tab.tabId, engineNonce]);
  const fitSafely = (host, fit) => {
    if (host.clientWidth < 40 || host.clientHeight < 24) return;
    try {
      fit.fit();
    } catch {
    }
  };
  reactExports.useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const kitty = Boolean(kittyRef.current);
    const rows = el.querySelector(".xterm-rows");
    setZebraSupported(kitty || Boolean(rows));
    el.classList.toggle("term-zebra", zebra && (kitty || Boolean(rows)));
  }, [zebra, ready]);
  reactExports.useEffect(() => {
    const kitty = kittyRef.current;
    if (kitty) {
      kitty.applySettings({ ...termCfg, fontFamily: withEmojiFallback(termCfg.fontFamily) });
      setBackendLabel(kitty.backendLabel);
      return;
    }
    const term = termRef.current;
    if (!term) return;
    term.options.fontFamily = withEmojiFallback(termCfg.fontFamily);
    term.options.fontSize = termCfg.fontSize;
    term.options.lineHeight = termCfg.lineHeight;
    term.options.letterSpacing = termCfg.letterSpacing;
    term.options.cursorBlink = termCfg.cursorBlink;
    term.options.cursorStyle = termCfg.cursorStyle;
    term.options.scrollback = termCfg.scrollback;
    term.options.theme = themeFor(termCfg.colorScheme, resolvedTheme);
    const ctor = linksCtorRef.current;
    if (ctor) {
      if (termCfg.linkDetection && !linksAddonRef.current) {
        const addon = new ctor((event, uri) => {
          event.preventDefault();
          void invoke("app", "openExternal", {
            url: uri
          }).catch(() => void 0);
        });
        linksAddonRef.current = addon;
        term.loadAddon(addon);
      } else if (!termCfg.linkDetection && linksAddonRef.current) {
        linksAddonRef.current.dispose();
        linksAddonRef.current = null;
      }
    }
  }, [termCfg, resolvedTheme, ready]);
  reactExports.useEffect(() => {
    const host = hostRef.current;
    const fit = fitRef.current;
    if (!host || !fit) return;
    const ro = new ResizeObserver(() => fitSafely(host, fit));
    ro.observe(host);
    return () => ro.disconnect();
  }, [ready, visible]);
  reactExports.useEffect(() => {
    if (!visible || !ready) return;
    const host = hostRef.current;
    const fit = fitRef.current;
    if (!host || !fit) return;
    const raf = requestAnimationFrame(() => {
      fitSafely(host, fit);
      termRef.current?.focus();
    });
    return () => cancelAnimationFrame(raf);
  }, [visible, ready]);
  reactExports.useEffect(() => {
    const sessionId = tab.sessionId;
    if (!sessionId) return;
    const writer = writerRef.current;
    if (tab.kind === "local") {
      return subscribe(Events.PTY_DATA, (p) => {
        if (p.ptyId !== sessionId) return;
        writer.push(p.data);
      });
    }
    if (tab.kind === "telnet") {
      return subscribe(Events.TELNET_DATA, (p) => {
        if (p.sessionId !== sessionId) return;
        writer.push(p.data);
      });
    }
    return subscribe(Events.SSH_DATA, (p) => {
      if (p.sessionId !== sessionId) return;
      writer.push(p.data);
    });
  }, [tab.sessionId, tab.kind]);
  const onKeyDownCapture = reactExports.useCallback(
    (e) => {
      if (!completion) return;
      const count = completion.candidates.length;
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          e.stopPropagation();
          setSelected((i) => count === 0 ? 0 : (i + 1) % count);
          return;
        case "ArrowUp":
          e.preventDefault();
          e.stopPropagation();
          setSelected((i) => count === 0 ? 0 : (i - 1 + count) % count);
          return;
        case "Tab":
          e.preventDefault();
          e.stopPropagation();
          acceptCandidate(selected);
          return;
        case "Escape":
          e.preventDefault();
          e.stopPropagation();
          closeCompletion();
          return;
        default:
          return;
      }
    },
    [completion, selected, acceptCandidate, closeCompletion]
  );
  const onKeyDown = reactExports.useCallback(
    (e) => {
      const term = termRef.current;
      if (!term) return;
      if (e.ctrlKey && e.shiftKey && (e.key === "F" || e.key === "f")) {
        e.preventDefault();
        setFindOpen(true);
        return;
      }
      if (e.ctrlKey && e.key === " ") {
        e.preventDefault();
        void requestCompletion();
        return;
      }
      if (e.ctrlKey && e.shiftKey && (e.key === "C" || e.key === "c")) {
        const sel = term.getSelection();
        if (sel) {
          e.preventDefault();
          void navigator.clipboard.writeText(sel);
        }
        return;
      }
      if (e.ctrlKey && e.shiftKey && (e.key === "V" || e.key === "v")) {
        e.preventDefault();
        pasteFromClipboard(term);
        return;
      }
      if (e.ctrlKey && !e.shiftKey && (e.key === "l" || e.key === "L")) {
        return;
      }
    },
    []
  );
  const menuItems = () => {
    const term = termRef.current;
    const selection = term?.getSelection() ?? "";
    const hasSelection = selection.trim().length > 0;
    const NO_SEL = "先在终端里选中文本（拖选或双击词）";
    const copySelection = () => {
      if (selection) void navigator.clipboard.writeText(selection);
    };
    const reconnect = async () => {
      const conn = getConnection(tab.connectionId);
      if (!conn) {
        toast.error("找不到这条连接（可能已被删除），无法重连");
        return;
      }
      closeTab(tab.tabId);
      await connectTo(conn);
    };
    const AI_MAX_CHARS = 4e3;
    const askAi = async (instruction) => {
      if (!selection.trim()) return;
      let usable = false;
      try {
        const list = await invoke(
          "ai",
          "listProviders",
          {}
        );
        usable = (list ?? []).some((p) => p.hasApiKey);
      } catch {
        usable = false;
      }
      if (!usable) {
        toast.error(
          "AI 建议需要先配置 AI 供应商：请打开「设置 > AI 助手」，选择供应商并填写 API Key 后重试"
        );
        return;
      }
      const truncated = selection.length > AI_MAX_CHARS;
      const body = truncated ? selection.slice(0, AI_MAX_CHARS) : selection;
      const text = `${instruction}

\`\`\`
${body}
\`\`\`` + (truncated ? `

（原文 ${selection.length} 字符，已截断到 ${AI_MAX_CHARS} 字符）` : "");
      try {
        await invoke("ai", "send", { text });
        actions.setView("ai");
        toast.ok(truncated ? "已发给 AI 助手（选区较长，已截断）" : "已发给 AI 助手");
      } catch (err) {
        toast.error(
          `AI 请求失败：${errorText(err)} —— 可在「设置 > AI 助手」检查供应商与 API Key`
        );
      }
    };
    return [
      {
        id: "toolbar",
        label: toolbarVisible ? "隐藏工具条" : "打开工具条",
        icon: "sliders",
        hint: "Ctrl+Shift+T",
        onSelect: () => actions.toggleToolbar()
      },
      {
        id: "copy",
        label: "复制",
        icon: "copy",
        hint: "Ctrl+Shift+C",
        disabled: !hasSelection,
        title: hasSelection ? void 0 : NO_SEL,
        onSelect: copySelection
      },
      {
        id: "paste",
        label: "粘贴",
        icon: "download",
        hint: "Ctrl+Shift+V",
        onSelect: () => pasteFromClipboard(termRef.current)
      },
      {
        id: "copy-paste",
        label: "复制并粘贴",
        icon: "copy",
        hint: "把输出直接当输入",
        disabled: !hasSelection,
        title: hasSelection ? void 0 : NO_SEL,
        onSelect: () => {
          copySelection();
          if (selection) termRef.current?.paste(selection);
        }
      },
      {
        id: "copy-search",
        label: "复制并搜索",
        icon: "search",
        disabled: !hasSelection,
        title: hasSelection ? void 0 : NO_SEL,
        onSelect: () => {
          copySelection();
          setFindText(selection);
          setFindOpen(true);
          if (searchRef.current && selection) {
            searchRef.current.findNext(selection, { incremental: false });
          }
        }
      },
      { id: "clear", label: "清屏", icon: "close", hint: "Ctrl+Shift+L", onSelect: () => termRef.current?.clear() },
      {
        id: "bottom",
        label: "到底部",
        icon: "chevron-down",
        hint: "回到最新输出",
        onSelect: () => termRef.current?.scrollToBottom()
      },
      {
        id: "split-h",
        separatorBefore: true,
        label: "水平切分",
        icon: "split-h",
        onSelect: () => setTabLayout(tab.tabId, "hsplit")
      },
      {
        id: "split-v",
        label: "垂直切分",
        icon: "split-v",
        onSelect: () => setTabLayout(tab.tabId, "vsplit")
      },
      {
        id: "reconnect",
        label: "重新连接终端",
        icon: "refresh",
        disabled: tab.kind === "local",
        title: tab.kind === "local" ? "本地终端没有远端会话可重连；请新建一个终端" : void 0,
        onSelect: () => void reconnect()
      },
      {
        id: "translate",
        separatorBefore: true,
        label: "翻译（发给 AI）",
        icon: "globe",
        disabled: !hasSelection,
        title: hasSelection ? void 0 : NO_SEL,
        onSelect: () => void askAi("把下面这段终端输出翻译成中文，只给译文，技术名词保留原文。")
      },
      {
        id: "ask-ai",
        label: "问问小易",
        icon: "zap",
        disabled: !hasSelection,
        title: hasSelection ? void 0 : NO_SEL,
        onSelect: () => void askAi("解释下面这段终端输出：它在说什么、有没有问题、需要我做什么。")
      },
      { id: "find", separatorBefore: true, label: "查找", icon: "search", hint: "Ctrl+Shift+F", onSelect: () => setFindOpen(true) },
      {
        id: "record",
        // 本地终端也已支持：pty 服务现在会把输出 publishSessionData 到 session-registry
        // （此前只有 SSH 在 publish，本地终端录制会静默产出 0 字节空文件）
        label: recording ? "停止记录日志" : "开始记录日志",
        icon: recording ? "stop" : "record",
        danger: Boolean(recording),
        disabled: !tab.sessionId,
        onSelect: () => {
          if (!tab.sessionId) return;
          if (recording) void stopSessionLog(tab.sessionId);
          else void startSessionLog(tab.sessionId, tab.title);
        }
      },
      {
        id: "logs",
        label: recording ? "查看日志列表" : "查看已有日志",
        icon: "notes",
        onSelect: () => {
          void loadSessionLogs();
          actions.setView("logs");
        }
      }
    ];
  };
  const onFind = (direction) => {
    const search = searchRef.current;
    if (!search || !findText) return;
    const opts = { incremental: true, caseSensitive: false };
    if (direction === "next") search.findNext(findText, opts);
    else search.findPrevious(findText, opts);
  };
  const stateLabel = {
    idle: "空闲",
    connecting: "连接中",
    authenticating: "认证中",
    "verifying-host-key": "校验主机指纹",
    ready: "已就绪",
    disconnected: "已断开",
    failed: "连接失败"
  };
  return /* @__PURE__ */ jsxRuntimeExports.jsxs(
    "div",
    {
      ref: paneRef,
      className: "term-pane",
      onKeyDown,
      onKeyDownCapture,
      onContextMenu: (e) => {
        e.preventDefault();
        setMenu({ x: e.clientX, y: e.clientY });
      },
      children: [
        /* @__PURE__ */ jsxRuntimeExports.jsx(
          "div",
          {
            ref: hostRef,
            className: "term-pane__surface",
            onClick: () => termRef.current?.focus(),
            "data-testid": "terminal-surface"
          }
        ),
        /* @__PURE__ */ jsxRuntimeExports.jsx(
          ContextMenu,
          {
            open: menu !== null,
            x: menu?.x ?? 0,
            y: menu?.y ?? 0,
            items: menuItems(),
            onClose: () => setMenu(null)
          }
        ),
        completion ? /* @__PURE__ */ jsxRuntimeExports.jsx(
          CompletionPopup,
          {
            candidates: completion.candidates,
            selected,
            elapsedMs: completion.elapsedMs,
            specName: completion.specName,
            aiRequested: completion.aiRequested,
            anchor,
            onHover: setSelected,
            onAccept: acceptCandidate
          }
        ) : null,
        findOpen ? /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "term-find", role: "search", children: [
          /* @__PURE__ */ jsxRuntimeExports.jsx(
            "input",
            {
              className: "t-input",
              autoFocus: true,
              value: findText,
              placeholder: "在终端中查找…",
              "aria-label": "终端内查找",
              onChange: (e) => {
                setFindText(e.target.value);
                const search = searchRef.current;
                if (search && e.target.value) search.findNext(e.target.value, { incremental: true });
              },
              onKeyDown: (e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  onFind(e.shiftKey ? "prev" : "next");
                } else if (e.key === "Escape") {
                  setFindOpen(false);
                  termRef.current?.focus();
                }
              }
            }
          ),
          /* @__PURE__ */ jsxRuntimeExports.jsx(IconButton, { icon: "chevron-left", label: "上一个", onClick: () => onFind("prev") }),
          /* @__PURE__ */ jsxRuntimeExports.jsx(IconButton, { icon: "chevron-right", label: "下一个", onClick: () => onFind("next") }),
          /* @__PURE__ */ jsxRuntimeExports.jsx(
            IconButton,
            {
              icon: "close",
              label: "关闭查找",
              onClick: () => {
                setFindOpen(false);
                termRef.current?.focus();
              }
            }
          )
        ] }) : null,
        !ready && !error ? /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "term-pane__overlay", children: /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "t-loading", children: [
          /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "t-spinner", "aria-hidden": true }),
          /* @__PURE__ */ jsxRuntimeExports.jsx("span", { children: "正在准备终端…" })
        ] }) }) : null,
        error ? /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "term-pane__overlay", children: /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "t-empty", children: [
          /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "t-empty__art", children: /* @__PURE__ */ jsxRuntimeExports.jsx(Icon, { name: "alert-triangle", size: 24 }) }),
          /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "t-empty__title", children: "终端组件加载失败" }),
          /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "t-empty__text", children: error })
        ] }) }) : null,
        tab.kind === "telnet" ? /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: `telnet-neg${negOpen ? " telnet-neg--open" : ""}`, children: [
          /* @__PURE__ */ jsxRuntimeExports.jsxs("button", { type: "button", className: "telnet-neg__head", onClick: () => setNegOpen((v) => !v), children: [
            /* @__PURE__ */ jsxRuntimeExports.jsx(Icon, { name: negOpen ? "chevron-down" : "chevron-right", size: 12 }),
            /* @__PURE__ */ jsxRuntimeExports.jsx(Icon, { name: "route", size: 12 }),
            "选项协商",
            negotiations && negotiations.length > 0 ? /* @__PURE__ */ jsxRuntimeExports.jsx(Badge, { tone: "outline", children: negotiations.length }) : null,
            negotiations && negotiations.some((n) => !n.accepted) ? /* @__PURE__ */ jsxRuntimeExports.jsx(Badge, { tone: "warn", children: "有未接受的选项" }) : null,
            /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "telnet-neg__hint", children: "连上但键盘没反应时，先看这里——多半是协商没谈拢" })
          ] }),
          negOpen ? /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "telnet-neg__body", children: !negotiations || negotiations.length === 0 ? /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "telnet-neg__empty", children: "还没有协商记录。" }) : negotiations.map((n, i) => /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "telnet-neg__row", children: [
            /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "telnet-neg__dir", children: n.direction === "local" ? "本机" : "远端" }),
            /* @__PURE__ */ jsxRuntimeExports.jsxs("span", { className: "telnet-neg__name", children: [
              n.optionName,
              " ",
              /* @__PURE__ */ jsxRuntimeExports.jsxs("span", { className: "telnet-neg__num", children: [
                "#",
                n.option
              ] })
            ] }),
            /* @__PURE__ */ jsxRuntimeExports.jsx(Badge, { tone: n.accepted ? "ok" : "warn", children: n.accepted ? "已接受" : "拒绝/未接受" }),
            n.detail ? /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "telnet-neg__detail", children: n.detail }) : null
          ] }, `${n.option}-${n.at}-${i}`)) }) : null
        ] }) : null,
        /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "term-pane__status", children: [
          recording ? /* @__PURE__ */ jsxRuntimeExports.jsxs("span", { className: "term-pane__rec", title: `正在记录日志（${recording.logId}）`, children: [
            /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "rec-dot" }),
            "录制中"
          ] }) : null,
          /* @__PURE__ */ jsxRuntimeExports.jsx("span", { children: stateLabel[tab.state] ?? tab.state }),
          tab.message ? /* @__PURE__ */ jsxRuntimeExports.jsxs("span", { title: tab.message, children: [
            "· ",
            tab.message
          ] }) : null,
          zebra && !zebraSupported ? /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "term-pane__cwd", title: "行间斑马纹需要 xterm 的 DOM 渲染器（逐行元素）；canvas/webgl 渲染器把整屏画在位图上，无法做行背景", children: "· 斑马纹不可用（当前渲染器非 DOM）" }) : null,
          sessionCwd ? /* @__PURE__ */ jsxRuntimeExports.jsxs("span", { className: "term-pane__cwd", title: `远端当前目录：${sessionCwd}（来自 shell 的 OSC 7 报告）`, children: [
            "· ",
            sessionCwd
          ] }) : null,
          /* @__PURE__ */ jsxRuntimeExports.jsx("div", { style: { flex: 1 } }),
          /* @__PURE__ */ jsxRuntimeExports.jsxs("span", { children: [
            "编码 ",
            tab.encoding
          ] }),
          backendLabel ? /* @__PURE__ */ jsxRuntimeExports.jsxs("span", { title: "当前渲染后端（设置 > 终端美化 可切换）", children: [
            "· ",
            backendLabel
          ] }) : null,
          dims ? /* @__PURE__ */ jsxRuntimeExports.jsxs("span", { children: [
            dims.cols,
            "×",
            dims.rows
          ] }) : null,
          /* @__PURE__ */ jsxRuntimeExports.jsx(
            IconButton,
            {
              icon: "search",
              label: "查找 (Ctrl+Shift+F)",
              size: 12,
              onClick: () => setFindOpen((v) => !v)
            }
          ),
          /* @__PURE__ */ jsxRuntimeExports.jsx(
            IconButton,
            {
              icon: "copy",
              label: "复制选中内容",
              size: 12,
              onClick: () => {
                const sel = termRef.current?.getSelection();
                if (sel) void navigator.clipboard.writeText(sel);
              }
            }
          ),
          /* @__PURE__ */ jsxRuntimeExports.jsx(IconButton, { icon: "close", label: "清屏", size: 12, onClick: () => termRef.current?.clear() })
        ] })
      ]
    }
  );
}
const QuickCommandPanel = reactExports.lazy(() => __vitePreload(() => import("./QuickCommandPanel-BuPbt0Xz.js"), true ? __vite__mapDeps([3,1,2,4,5,6,7]) : void 0, import.meta.url));
const MonitorPanel = reactExports.lazy(() => __vitePreload(() => import("./MonitorPanel-CaOAOq7p.js"), true ? __vite__mapDeps([8,1,2,9,10]) : void 0, import.meta.url));
const SftpBrowser = reactExports.lazy(() => __vitePreload(() => import("./SftpBrowser-DvVJlZbd.js"), true ? __vite__mapDeps([11,1,2,12,9,4,13,6,7]) : void 0, import.meta.url));
const VncViewer = reactExports.lazy(() => __vitePreload(() => import("./VncViewer-D7EMM2WE.js"), true ? __vite__mapDeps([14,1,2,15]) : void 0, import.meta.url));
const RdpView = reactExports.lazy(() => __vitePreload(() => import("./RdpView-De_UW8x5.js"), true ? __vite__mapDeps([16,1,2]) : void 0, import.meta.url));
const TunnelView = reactExports.lazy(() => __vitePreload(() => import("./TunnelView-BZ2pXtye.js"), true ? __vite__mapDeps([17,1,2]) : void 0, import.meta.url));
const LAYOUTS = [
  { value: "single", icon: "panel-right", label: "单窗格" },
  { value: "hsplit", icon: "split-h", label: "左右分屏" },
  { value: "vsplit", icon: "split-v", label: "上下分屏" }
];
const STATE_TONE = {
  idle: "default",
  connecting: "accent",
  authenticating: "accent",
  "verifying-host-key": "warn",
  ready: "ok",
  disconnected: "default",
  failed: "danger"
};
const STATE_LABEL = {
  idle: "空闲",
  connecting: "连接中",
  authenticating: "认证中",
  "verifying-host-key": "校验主机指纹",
  ready: "已连接",
  disconnected: "已断开",
  failed: "失败"
};
function TerminalWorkspace() {
  const { tabs, activeTabId, recordings, groups, lastSend, bcErrors } = useStoreShallow((s) => ({
    tabs: s.tabs,
    activeTabId: s.activeTabId,
    recordings: s.activeRecordings,
    groups: s.broadcastGroups,
    lastSend: s.broadcastLastSend,
    bcErrors: s.broadcastErrors
  }));
  reactExports.useEffect(() => {
    void loadBroadcastGroups();
  }, []);
  const [secondaryTabId, setSecondaryTabId] = reactExports.useState(null);
  const quickW = usePaneWidth({ key: "t1000:ws:quickcmd", initial: 286, min: 180, max: 480 });
  const filesW = usePaneWidth({ key: "t1000:ws:files", initial: 420, min: 260, max: 760 });
  const monitorW = usePaneWidth({ key: "t1000:ws:monitor", initial: 320, min: 220, max: 640 });
  const wsRef = reactExports.useRef(null);
  const [wsWidth, setWsWidth] = reactExports.useState(0);
  const PANES_MIN = 320;
  reactExports.useEffect(() => {
    const el = wsRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0;
      setWsWidth(Math.round(w));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const active = tabs.find((t) => t.tabId === activeTabId) ?? null;
  const quickcmdOpen = useStoreShallow((s) => ({ v: s.quickcmdOpen })).v;
  const toolbarVisible = useStoreShallow((s) => ({ v: s.toolbarVisible })).v;
  const isTerminalLike = active?.kind === "ssh" || active?.kind === "local" || active?.kind === "telnet" || active === void 0;
  const hasFiles = active?.kind === "ssh" || active?.kind === "local" || active === void 0;
  const activeGroup = broadcastGroupOf(active?.sessionId);
  const groupOf = (sessionId) => sessionId ? groups.find((g) => g.members.some((m) => m.sessionId === sessionId)) : void 0;
  const sendInfo = activeGroup ? lastSend[activeGroup.groupId] : void 0;
  const groupErrors = activeGroup ? bcErrors.filter((e) => e.groupId === activeGroup.groupId).slice(0, 3) : [];
  const layout = active?.layout ?? "single";
  reactExports.useEffect(() => {
    if (secondaryTabId && !tabs.some((t) => t.tabId === secondaryTabId)) setSecondaryTabId(null);
  }, [tabs, secondaryTabId]);
  const visibleIds = reactExports.useMemo(() => {
    if (!active) return [];
    if (layout === "single" || !secondaryTabId) return [active.tabId];
    return [active.tabId, secondaryTabId];
  }, [active, layout, secondaryTabId]);
  if (!active) {
    return /* @__PURE__ */ jsxRuntimeExports.jsx("main", { className: "content", "aria-label": "终端工作区", children: /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "conn-empty", children: /* @__PURE__ */ jsxRuntimeExports.jsx(
      EmptyState,
      {
        icon: "terminal",
        title: "工作区是空的",
        text: "在连接中心双击一台服务器打开 SSH 会话，或者开一个本地终端。所有会话都会以标签形式留在这里。",
        actions: /* @__PURE__ */ jsxRuntimeExports.jsxs(jsxRuntimeExports.Fragment, { children: [
          /* @__PURE__ */ jsxRuntimeExports.jsx(Button, { variant: "primary", icon: "connections", onClick: () => actions.setView("connections"), children: "打开连接中心" }),
          /* @__PURE__ */ jsxRuntimeExports.jsx(Button, { variant: "outline", icon: "terminal", onClick: () => void openLocalTerminal(), children: "本地终端" })
        ] })
      }
    ) }) });
  }
  const mono = active;
  const showQuick = isTerminalLike && quickcmdOpen;
  const showFiles = isTerminalLike && hasFiles && mono.filesOpen && Boolean(mono.sessionId);
  const showMonitor = isTerminalLike && mono.monitorOpen;
  const budget = wsWidth > 0 ? Math.max(0, wsWidth - PANES_MIN) : Number.POSITIVE_INFINITY;
  const want = (showQuick ? quickW.width : 0) + (showFiles ? filesW.width : 0) + (showMonitor ? monitorW.width : 0);
  const k = budget !== Number.POSITIVE_INFINITY && want > budget && want > 0 ? budget / want : 1;
  const effQuick = showQuick ? Math.max(150, Math.round(quickW.width * k)) : 0;
  const effFiles = showFiles ? Math.max(200, Math.round(filesW.width * k)) : 0;
  const effMonitor = showMonitor ? Math.max(180, Math.round(monitorW.width * k)) : 0;
  const dragBudget = budget === Number.POSITIVE_INFINITY ? 0 : budget;
  const quickMax = budget === Number.POSITIVE_INFINITY ? quickW.max : Math.max(quickW.min, dragBudget - effFiles - effMonitor);
  const filesMax = budget === Number.POSITIVE_INFINITY ? filesW.max : Math.max(filesW.min, dragBudget - effQuick - effMonitor);
  const monitorMax = budget === Number.POSITIVE_INFINITY ? monitorW.max : Math.max(monitorW.min, dragBudget - effQuick - effFiles);
  return /* @__PURE__ */ jsxRuntimeExports.jsxs("main", { className: "content", "aria-label": "终端工作区", children: [
    /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "term-tabs", role: "tablist", "aria-label": "终端标签", children: [
      tabs.map((tab) => /* @__PURE__ */ jsxRuntimeExports.jsxs(
        "div",
        {
          role: "tab",
          tabIndex: tab.tabId === activeId(tabs, activeTabId) ? 0 : -1,
          "aria-selected": tab.tabId === activeTabId,
          className: `term-tab${tab.tabId === activeTabId ? " term-tab--active" : ""}`,
          title: tab.subtitle ? `${tab.title} · ${tab.subtitle}` : tab.title,
          onClick: () => setActiveTab(tab.tabId),
          onKeyDown: (e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              setActiveTab(tab.tabId);
            }
          },
          children: [
            /* @__PURE__ */ jsxRuntimeExports.jsx(Icon, { name: tab.kind === "local" ? "console" : "terminal", size: 13 }),
            recordings.some((r) => r.sessionId === tab.sessionId) ? /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "rec-dot", title: "正在记录会话日志" }) : null,
            (() => {
              const g = groupOf(tab.sessionId);
              if (!g) return null;
              return /* @__PURE__ */ jsxRuntimeExports.jsx(
                "span",
                {
                  className: `bc-chip${g.mode === "broadcast" ? " bc-chip--live" : ""}`,
                  title: `属于广播组「${g.name}」（${g.mode === "broadcast" ? "广播模式" : "独立模式"}，${g.members.length} 台）`,
                  children: g.mode === "broadcast" ? "广播" : "组"
                }
              );
            })(),
            /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "term-tab__label", children: tab.title }),
            /* @__PURE__ */ jsxRuntimeExports.jsx(
              "button",
              {
                type: "button",
                className: "term-tab__close",
                "aria-label": `关闭 ${tab.title}`,
                onClick: (e) => {
                  e.stopPropagation();
                  closeTab(tab.tabId);
                },
                children: /* @__PURE__ */ jsxRuntimeExports.jsx(Icon, { name: "close", size: 11 })
              }
            )
          ]
        },
        tab.tabId
      )),
      /* @__PURE__ */ jsxRuntimeExports.jsx(IconButton, { icon: "plus", label: "新建本地终端", onClick: () => void openLocalTerminal() }),
      /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "term-tabs__spacer" })
    ] }),
    /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: `term-toolbar${toolbarVisible ? "" : " term-toolbar--hidden"}`, children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "term-toolbar__title", children: mono.title }),
      /* @__PURE__ */ jsxRuntimeExports.jsx(Badge, { tone: STATE_TONE[mono.state] ?? "default", children: STATE_LABEL[mono.state] ?? mono.state }),
      mono.subtitle ? /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "term-toolbar__meta", children: mono.subtitle }) : null,
      /* @__PURE__ */ jsxRuntimeExports.jsx("div", { style: { flex: 1 } }),
      isTerminalLike ? /* @__PURE__ */ jsxRuntimeExports.jsxs(jsxRuntimeExports.Fragment, { children: [
        /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "t-toolbar__divider" }),
        hasFiles ? /* @__PURE__ */ jsxRuntimeExports.jsx(
          IconButton,
          {
            icon: "folder",
            label: mono.filesOpen ? "收起文件栏" : "展开文件栏",
            tone: mono.filesOpen ? "accent" : "default",
            onClick: () => toggleTabFiles(mono.tabId)
          }
        ) : null,
        /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "t-toolbar__divider" }),
        LAYOUTS.map((l) => /* @__PURE__ */ jsxRuntimeExports.jsx(
          IconButton,
          {
            icon: l.icon,
            label: l.label,
            tone: layout === l.value ? "accent" : "default",
            onClick: () => {
              setTabLayout(mono.tabId, l.value);
              if (l.value !== "single" && !secondaryTabId) {
                const other = tabs.find((t) => t.tabId !== mono.tabId);
                setSecondaryTabId(other?.tabId ?? null);
              }
            }
          },
          l.value
        )),
        layout !== "single" ? /* @__PURE__ */ jsxRuntimeExports.jsxs(
          "select",
          {
            className: "t-select",
            style: { width: 150, height: 26 },
            "aria-label": "第二窗格的会话",
            value: secondaryTabId ?? "",
            onChange: (e) => setSecondaryTabId(e.target.value || null),
            children: [
              /* @__PURE__ */ jsxRuntimeExports.jsx("option", { value: "", children: "选择会话…" }),
              tabs.filter((t) => t.tabId !== mono.tabId).map((t) => /* @__PURE__ */ jsxRuntimeExports.jsx("option", { value: t.tabId, children: t.title }, t.tabId))
            ]
          }
        ) : null,
        activeGroup ? /* @__PURE__ */ jsxRuntimeExports.jsxs(jsxRuntimeExports.Fragment, { children: [
          /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "t-toolbar__divider" }),
          /* @__PURE__ */ jsxRuntimeExports.jsxs(Badge, { tone: activeGroup.mode === "broadcast" ? "danger" : "outline", children: [
            activeGroup.name,
            " · ",
            activeGroup.members.length,
            " 台"
          ] }),
          /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "t-segmented", role: "tablist", "aria-label": "会话模式", children: [
            ["independent", "独立"],
            ["broadcast", "广播"]
          ].map(([value, label]) => /* @__PURE__ */ jsxRuntimeExports.jsx(
            "button",
            {
              type: "button",
              role: "tab",
              "aria-selected": activeGroup.mode === value,
              className: `t-segmented__item${activeGroup.mode === value ? " t-segmented__item--active" : ""}`,
              onClick: () => void setBroadcastMode(activeGroup.groupId, value),
              children: label
            },
            value
          )) }),
          /* @__PURE__ */ jsxRuntimeExports.jsx(
            IconButton,
            {
              icon: "close",
              label: "解散广播组",
              onClick: () => void dissolveBroadcastGroup(activeGroup.groupId)
            }
          )
        ] }) : null
      ] }) : null,
      /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "t-toolbar__divider" }),
      isTerminalLike ? /* @__PURE__ */ jsxRuntimeExports.jsx(
        IconButton,
        {
          icon: "zap",
          label: quickcmdOpen ? "关闭快速命令" : "打开快速命令（终端左栏）",
          tone: quickcmdOpen ? "accent" : "default",
          onClick: () => actions.toggleQuickcmd()
        }
      ) : null,
      isTerminalLike ? /* @__PURE__ */ jsxRuntimeExports.jsx(
        IconButton,
        {
          icon: "activity",
          label: mono.monitorOpen ? "关闭监控" : "打开监控",
          tone: mono.monitorOpen ? "accent" : "default",
          onClick: () => toggleTabMonitor(mono.tabId)
        }
      ) : null
    ] }),
    activeGroup?.mode === "broadcast" ? /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "bc-ribbon", role: "status", children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx(Icon, { name: "alert-triangle", size: 15 }),
      /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "bc-ribbon__body", children: [
        /* @__PURE__ */ jsxRuntimeExports.jsxs("b", { children: [
          "广播已开启：一次输入会同时发送到 ",
          activeGroup.members.length,
          " 台服务器。"
        ] }),
        /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "bc-ribbon__sub", children: [
          "各机回显快慢不一，",
          /* @__PURE__ */ jsxRuntimeExports.jsx("b", { children: "屏幕上分不出谁先执行" }),
          "，而远端实际耗时也不同 —— 涉及有副作用的命令（重启服务、改配置、删文件）时这一点很危险。"
        ] }),
        activeGroup.members.some((m) => !m.writable) ? /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "bc-ribbon__sub", children: [
          "其中有 ",
          activeGroup.members.filter((m) => !m.writable).length,
          ' 台标记为**只读**： 不会收到输入，但会计入"跳过"。见下方成员列表。'
        ] }) : null,
        sendInfo ? /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "bc-ribbon__sub", children: [
          "最近一次：已送达 ",
          /* @__PURE__ */ jsxRuntimeExports.jsx("b", { children: sendInfo.delivered }),
          " 台",
          sendInfo.skipped > 0 ? /* @__PURE__ */ jsxRuntimeExports.jsxs(jsxRuntimeExports.Fragment, { children: [
            "，跳过 ",
            /* @__PURE__ */ jsxRuntimeExports.jsx("b", { className: "bc-ribbon__warn", children: sendInfo.skipped }),
            " 台"
          ] }) : null
        ] }) : null,
        groupErrors.map((e) => /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "bc-ribbon__err", children: [
          e.title,
          "：",
          e.message
        ] }, `${e.sessionId}-${e.at}`))
      ] }),
      /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "bc-ribbon__members", children: activeGroup.members.map((m) => /* @__PURE__ */ jsxRuntimeExports.jsxs(
        "span",
        {
          className: `bc-member${m.writable ? "" : " bc-member--ro"}`,
          title: m.writable ? `${m.title}（可写）` : `${m.title}：后端不会写入该会话（只读）`,
          children: [
            m.writable ? null : /* @__PURE__ */ jsxRuntimeExports.jsx(Icon, { name: "lock", size: 10 }),
            m.title
          ]
        },
        m.sessionId
      )) })
    ] }) : null,
    /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "term-workspace", ref: wsRef, children: [
      showQuick ? /* @__PURE__ */ jsxRuntimeExports.jsxs(jsxRuntimeExports.Fragment, { children: [
        /* @__PURE__ */ jsxRuntimeExports.jsx("aside", { className: "term-quickcmd", style: { width: effQuick }, "aria-label": "快速命令", children: /* @__PURE__ */ jsxRuntimeExports.jsx(reactExports.Suspense, { fallback: /* @__PURE__ */ jsxRuntimeExports.jsx(Loading, { text: "载入快速命令…" }), children: /* @__PURE__ */ jsxRuntimeExports.jsx(QuickCommandPanel, {}) }) }),
        /* @__PURE__ */ jsxRuntimeExports.jsx(
          Splitter,
          {
            side: "left",
            size: effQuick,
            min: quickW.min,
            max: quickMax,
            onResize: quickW.setWidth,
            onReset: quickW.reset,
            label: "拖动调整快速命令栏宽度"
          }
        )
      ] }) : null,
      showFiles ? /* @__PURE__ */ jsxRuntimeExports.jsxs(jsxRuntimeExports.Fragment, { children: [
        /* @__PURE__ */ jsxRuntimeExports.jsx("aside", { className: "term-files", style: { width: effFiles }, "aria-label": "文件浏览", children: /* @__PURE__ */ jsxRuntimeExports.jsx(reactExports.Suspense, { fallback: /* @__PURE__ */ jsxRuntimeExports.jsx(Loading, { text: "正在载入文件浏览器…" }), children: /* @__PURE__ */ jsxRuntimeExports.jsx(SftpBrowser, { sessionId: mono.sessionId, title: mono.title }) }) }),
        /* @__PURE__ */ jsxRuntimeExports.jsx(
          Splitter,
          {
            side: "left",
            size: effFiles,
            min: filesW.min,
            max: filesMax,
            onResize: filesW.setWidth,
            onReset: filesW.reset,
            label: "拖动调整文件栏宽度"
          }
        )
      ] }) : null,
      /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: `term-panes term-panes--${isTerminalLike ? layout : "single"}`, children: tabs.map((tab) => {
        const visible = visibleIds.includes(tab.tabId);
        const conn = getConnection(tab.connectionId);
        return /* @__PURE__ */ jsxRuntimeExports.jsx(
          "div",
          {
            className: `term-slot${visible ? "" : " term-slot--hidden"}`,
            "aria-hidden": !visible,
            children: /* @__PURE__ */ jsxRuntimeExports.jsx(reactExports.Suspense, { fallback: /* @__PURE__ */ jsxRuntimeExports.jsx(Loading, { text: "载入视图…" }), children: tab.kind === "vnc" ? /* @__PURE__ */ jsxRuntimeExports.jsx(
              VncViewer,
              {
                sessionId: tab.sessionId,
                title: tab.title,
                viewOnly: conn?.viewOnly === true,
                scaleViewport: conn?.scaleViewport === true,
                clipViewport: conn?.clipViewport === true
              }
            ) : tab.kind === "rdp" ? /* @__PURE__ */ jsxRuntimeExports.jsx(
              RdpView,
              {
                sessionId: tab.sessionId,
                title: tab.title,
                host: conn?.host ?? "",
                width: conn?.width ?? 1280,
                height: conn?.height ?? 800,
                ...tab.message === void 0 ? {} : { errorMessage: tab.message }
              }
            ) : tab.kind === "tunnel" && conn ? /* @__PURE__ */ jsxRuntimeExports.jsx(
              TunnelView,
              {
                sessionId: tab.sessionId,
                connection: conn,
                state: tab.state,
                ...tab.message === void 0 ? {} : { message: tab.message }
              }
            ) : (
              /* 从未可见过的标签不创建 xterm，切过去时才初始化 */
              /* @__PURE__ */ jsxRuntimeExports.jsx(TerminalPane, { tab, visible })
            ) })
          },
          tab.tabId
        );
      }) }),
      showMonitor ? /* @__PURE__ */ jsxRuntimeExports.jsxs(jsxRuntimeExports.Fragment, { children: [
        /* @__PURE__ */ jsxRuntimeExports.jsx(
          Splitter,
          {
            side: "right",
            size: effMonitor,
            min: monitorW.min,
            max: monitorMax,
            onResize: monitorW.setWidth,
            onReset: monitorW.reset,
            label: "拖动调整监控栏宽度"
          }
        ),
        /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "term-monitor", style: { width: effMonitor }, children: /* @__PURE__ */ jsxRuntimeExports.jsx(reactExports.Suspense, { fallback: /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "monitor", children: /* @__PURE__ */ jsxRuntimeExports.jsx(Loading, { text: "正在载入监控面板…" }) }), children: /* @__PURE__ */ jsxRuntimeExports.jsx(
          MonitorPanel,
          {
            sessionId: mono.sessionId,
            title: mono.title,
            onClose: () => toggleTabMonitor(mono.tabId)
          }
        ) }) })
      ] }) : null
    ] })
  ] });
}
function activeId(tabs, activeTabId) {
  return tabs.some((t) => t.tabId === activeTabId) ? activeTabId : tabs[0]?.tabId ?? null;
}
const TerminalWorkspace$1 = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  default: TerminalWorkspace
}, Symbol.toStringTag, { value: "Module" }));
export {
  ContextMenu as C,
  TerminalWorkspace$1 as T
};
