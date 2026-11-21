const __vite__mapDeps=(i,m=__vite__mapDeps,d=(m.f||(m.f=["./xterm-GVL3fBIr.css"])))=>i.map(i=>d[i]);
import { r as reactExports, i as invoke, e as errorText, _ as __vitePreload, j as jsxRuntimeExports, L as Loading, I as Icon, B as Badge, h as Button, f as Banner, n as IconButton, u as useStoreShallow, ah as loadRecordingSettings, Y as loadSessionLogs, ai as Section, G as Switch, aj as saveRecordingSettings, T as TextInput, J as EmptyState, ak as formatDate, al as formatBytes, M as Modal, am as deleteSessionLog, t as toast, y as formatRelativeTime, W as stopSessionLog, an as readSessionLog } from "./index-C6luzS_t.js";
const PAGE_LIMIT = 2e4;
const MAX_PAGES = 60;
const SPEEDS = [0.5, 1, 2, 4];
function formatClock(ms) {
  const total = Math.max(0, Math.floor(ms / 1e3));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}
function ReplayPlayer({ logId, title, onClose }) {
  const hostRef = reactExports.useRef(null);
  const termRef = reactExports.useRef(null);
  const [ready, setReady] = reactExports.useState(false);
  const [error, setError] = reactExports.useState(null);
  const [frames, setFrames] = reactExports.useState([]);
  const [meta, setMeta] = reactExports.useState(null);
  const [truncated, setTruncated] = reactExports.useState(false);
  const [loading, setLoading] = reactExports.useState(true);
  const [playing, setPlaying] = reactExports.useState(false);
  const [speed, setSpeed] = reactExports.useState(1);
  const [cursorMs, setCursorMs] = reactExports.useState(0);
  const idxRef = reactExports.useRef(0);
  const timerRef = reactExports.useRef(void 0);
  const anchorRef = reactExports.useRef({ wall: 0, tMs: 0 });
  const speedRef = reactExports.useRef(speed);
  speedRef.current = speed;
  const framesRef = reactExports.useRef(frames);
  framesRef.current = frames;
  reactExports.useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      try {
        const all = [];
        let from = 0;
        let first = null;
        for (let page = 0; page < MAX_PAGES; page += 1) {
          const res = await invoke(
            "sessionlog",
            "replay",
            { logId, fromMs: from, limit: PAGE_LIMIT }
          );
          if (cancelled) return;
          if (!first) first = res;
          all.push(...res.frames ?? []);
          if (!res.hasMore) break;
          const last = res.frames?.[res.frames.length - 1];
          const nextFrom = (res.toMs ?? last?.tMs ?? from) + (last ? 1 : 0);
          if (nextFrom <= from) break;
          from = nextFrom;
          if (page === MAX_PAGES - 1) setTruncated(true);
        }
        if (cancelled) return;
        setFrames(all);
        setMeta(first);
      } catch (err) {
        if (!cancelled) setError(errorText(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [logId]);
  reactExports.useEffect(() => {
    const host = hostRef.current;
    if (!host || loading) return;
    let disposed = false;
    void (async () => {
      try {
        const { Terminal } = await __vitePreload(async () => {
          const { Terminal: Terminal2 } = await import("./xterm-CYpUPaQB.js");
          return { Terminal: Terminal2 };
        }, true ? [] : void 0, import.meta.url);
        await __vitePreload(() => Promise.resolve({}), true ? __vite__mapDeps([0]) : void 0, import.meta.url);
        if (disposed) return;
        const term = new Terminal({
          // 录制回放是"看"，所以不接收输入、不要光标闪烁
          disableStdin: true,
          cursorBlink: false,
          scrollback: 2e4,
          fontSize: 12,
          fontFamily: "'JetBrains Mono', Menlo, Consolas, monospace",
          theme: { background: "#0d0f14", foreground: "#e4e7ee" }
        });
        term.open(host);
        if (meta?.cols && meta?.rows) term.resize(meta.cols, meta.rows);
        termRef.current = term;
        setReady(true);
      } catch (err) {
        if (!disposed) setError(errorText(err));
      }
    })();
    return () => {
      disposed = true;
      termRef.current?.dispose();
      termRef.current = null;
      setReady(false);
    };
  }, [loading, meta?.cols, meta?.rows]);
  const clearTimer = reactExports.useCallback(() => {
    if (timerRef.current) {
      window.clearTimeout(timerRef.current);
      timerRef.current = void 0;
    }
  }, []);
  const schedule = reactExports.useCallback(() => {
    clearTimer();
    const term = termRef.current;
    if (!term) return;
    const next = framesRef.current[idxRef.current];
    if (!next) {
      setPlaying(false);
      return;
    }
    const elapsed = performance.now() - anchorRef.current.wall;
    const due = (next.tMs - anchorRef.current.tMs) / speedRef.current - elapsed;
    timerRef.current = window.setTimeout(
      () => {
        term.write(next.data);
        idxRef.current += 1;
        setCursorMs(next.tMs);
        schedule();
      },
      Math.max(0, due)
    );
  }, [clearTimer]);
  const play = reactExports.useCallback(() => {
    if (framesRef.current.length === 0) return;
    if (idxRef.current >= framesRef.current.length) {
      idxRef.current = 0;
      termRef.current?.reset();
      setCursorMs(0);
    }
    anchorRef.current = { wall: performance.now(), tMs: cursorMs };
    setPlaying(true);
    schedule();
  }, [cursorMs, schedule]);
  const pause = reactExports.useCallback(() => {
    clearTimer();
    setPlaying(false);
  }, [clearTimer]);
  const seek = reactExports.useCallback(
    (targetMs) => {
      const term = termRef.current;
      if (!term) return;
      clearTimer();
      setPlaying(false);
      term.reset();
      const list = framesRef.current;
      let i = 0;
      for (; i < list.length; i += 1) {
        const f = list[i];
        if (!f || f.tMs > targetMs) break;
        term.write(f.data);
      }
      idxRef.current = i;
      setCursorMs(targetMs);
    },
    [clearTimer]
  );
  const stepFrame = reactExports.useCallback(
    (dir) => {
      const term = termRef.current;
      if (!term) return;
      if (dir === 1) {
        const next = framesRef.current[idxRef.current];
        if (!next) return;
        term.write(next.data);
        idxRef.current += 1;
        setCursorMs(next.tMs);
        return;
      }
      const prevIndex = Math.max(0, idxRef.current - 2);
      const prev = framesRef.current[prevIndex];
      seek(prev ? prev.tMs : 0);
    },
    [seek]
  );
  reactExports.useEffect(() => clearTimer, [clearTimer]);
  reactExports.useEffect(() => {
    if (!playing) return;
    anchorRef.current = { wall: performance.now(), tMs: cursorMs };
    schedule();
  }, [speed]);
  const totalMs = meta?.totalMs ?? 0;
  const percent = totalMs > 0 ? Math.min(100, cursorMs / totalMs * 100) : 0;
  const ticks = frames.length;
  const seekHint = reactExports.useMemo(
    () => ticks > 2e4 ? "这段录制很长，跳转需要从头重放，可能等几秒" : null,
    [ticks]
  );
  if (loading) return /* @__PURE__ */ jsxRuntimeExports.jsx(Loading, { text: "正在读取录制…" });
  return /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "replay", children: [
    /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "t-toolbar", children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx(Icon, { name: "eye", size: 15 }),
      /* @__PURE__ */ jsxRuntimeExports.jsxs("span", { className: "panel-title", children: [
        "回放 · ",
        title
      ] }),
      meta?.compressed ? /* @__PURE__ */ jsxRuntimeExports.jsx(Badge, { tone: "outline", children: "已压缩（自动解压）" }) : null,
      meta?.cols && meta?.rows ? /* @__PURE__ */ jsxRuntimeExports.jsxs(Badge, { tone: "outline", children: [
        meta.cols,
        "×",
        meta.rows
      ] }) : null,
      /* @__PURE__ */ jsxRuntimeExports.jsxs("span", { className: "term-toolbar__meta", children: [
        ticks,
        " 帧 · ",
        formatClock(totalMs),
        truncated ? "（仅载入前若干帧）" : ""
      ] }),
      /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "t-toolbar__spacer" }),
      /* @__PURE__ */ jsxRuntimeExports.jsx(Button, { size: "sm", variant: "ghost", icon: "chevron-left", onClick: onClose, children: "返回日志" })
    ] }),
    error ? /* @__PURE__ */ jsxRuntimeExports.jsx("div", { style: { padding: "10px 12px 0" }, children: /* @__PURE__ */ jsxRuntimeExports.jsx(Banner, { tone: "error", children: error }) }) : null,
    ticks === 0 && !error ? /* @__PURE__ */ jsxRuntimeExports.jsx("div", { style: { padding: "10px 12px 0" }, children: /* @__PURE__ */ jsxRuntimeExports.jsx(Banner, { tone: "warn", children: "这份日志没有录制数据（只有文本日志）。录制需要在会话期间开启，且录制设置为启用状态。" }) }) : null,
    /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "replay__note", children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx(Icon, { name: "info", size: 12 }),
      "录制存的是**带时间戳的输出流**，屏幕由这里重放得到。 因此**拖拽跳转 = 从开头快速重放到目标点**（不是瞬间取快照）",
      seekHint ? `；${seekHint}` : "。"
    ] }),
    /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "replay__stage", children: /* @__PURE__ */ jsxRuntimeExports.jsx("div", { ref: hostRef, className: "replay__term" }) }),
    /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "replay__controls", children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx(
        IconButton,
        {
          icon: playing ? "stop" : "power",
          label: playing ? "暂停" : "播放",
          tone: playing ? "danger" : "accent",
          onClick: () => playing ? pause() : play()
        }
      ),
      /* @__PURE__ */ jsxRuntimeExports.jsx(IconButton, { icon: "chevron-left", label: "后退一帧", onClick: () => stepFrame(-1) }),
      /* @__PURE__ */ jsxRuntimeExports.jsx(IconButton, { icon: "chevron-right", label: "前进一帧", onClick: () => stepFrame(1) }),
      /* @__PURE__ */ jsxRuntimeExports.jsx(IconButton, { icon: "refresh", label: "回到开头", onClick: () => seek(0) }),
      /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "replay__clock", children: formatClock(cursorMs) }),
      /* @__PURE__ */ jsxRuntimeExports.jsx(
        "input",
        {
          className: "replay__range",
          type: "range",
          min: 0,
          max: Math.max(totalMs, 1),
          value: cursorMs,
          "aria-label": "回放进度",
          onChange: (e) => setCursorMs(Number(e.target.value)),
          onMouseUp: (e) => seek(Number(e.currentTarget.value)),
          onKeyUp: (e) => seek(Number(e.currentTarget.value))
        }
      ),
      /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "replay__clock", children: formatClock(totalMs) }),
      /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "t-toolbar__divider" }),
      /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "t-segmented", role: "tablist", "aria-label": "播放速度", children: SPEEDS.map((sp) => /* @__PURE__ */ jsxRuntimeExports.jsxs(
        "button",
        {
          type: "button",
          role: "tab",
          "aria-selected": sp === speed,
          className: `t-segmented__item${sp === speed ? " t-segmented__item--active" : ""}`,
          onClick: () => setSpeed(sp),
          children: [
            sp,
            "×"
          ]
        },
        sp
      )) }),
      /* @__PURE__ */ jsxRuntimeExports.jsx("div", { style: { flex: 1 } }),
      /* @__PURE__ */ jsxRuntimeExports.jsxs("span", { className: "metric__sub", children: [
        "进度 ",
        percent.toFixed(0),
        "%"
      ] })
    ] })
  ] });
}
const READ_LIMIT = 256 * 1024;
function byteLength(text) {
  return new TextEncoder().encode(text).length;
}
function SessionLogSidebar() {
  const { logs, active } = useStoreShallow((s) => ({
    logs: s.sessionLogs,
    active: s.activeRecordings
  }));
  return /* @__PURE__ */ jsxRuntimeExports.jsxs("aside", { className: "panel", "aria-label": "会话日志", children: [
    /* @__PURE__ */ jsxRuntimeExports.jsxs("header", { className: "panel-header", children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "panel-title", children: "会话日志" }),
      /* @__PURE__ */ jsxRuntimeExports.jsx(IconButton, { icon: "refresh", label: "刷新", onClick: () => void loadSessionLogs() })
    ] }),
    /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "panel-body", children: /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "tree", children: [
      /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "tree__section", children: [
        "正在录制（",
        active.length,
        "）"
      ] }),
      active.length === 0 ? /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "tree__empty", children: "没有正在录制的会话。在终端里右键可以开始记录。" }) : active.map((r) => /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "log-active", children: [
        /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "rec-dot", "aria-label": "录制中" }),
        /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "log-active__body", children: [
          /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "log-active__title", children: r.title }),
          /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "log-active__meta", children: [
            formatBytes(r.bytes),
            " · ",
            formatRelativeTime(r.startedAt)
          ] }),
          r.bytes === 0 ? /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "log-active__warn", children: "尚未收到任何输出" }) : null
        ] }),
        /* @__PURE__ */ jsxRuntimeExports.jsx(
          IconButton,
          {
            icon: "stop",
            label: `停止记录 ${r.title}`,
            size: 12,
            tone: "danger",
            onClick: () => void stopSessionLog(r.sessionId)
          }
        )
      ] }, r.logId)),
      /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "tree__section", children: [
        "已保存（",
        logs.length,
        "）"
      ] }),
      logs.length === 0 ? /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "tree__empty", children: "还没有保存的日志。" }) : /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "log-summary", children: [
        "最早 ",
        formatRelativeTime(logs[logs.length - 1]?.startedAt),
        /* @__PURE__ */ jsxRuntimeExports.jsx("br", {}),
        "最新 ",
        formatRelativeTime(logs[0]?.startedAt)
      ] })
    ] }) }),
    /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "panel-footer", children: /* @__PURE__ */ jsxRuntimeExports.jsx(
      Button,
      {
        size: "sm",
        variant: "outline",
        icon: "stop",
        disabled: active.length === 0,
        style: { flex: 1 },
        onClick: () => void stopSessionLog(),
        children: "停止全部录制"
      }
    ) })
  ] });
}
function Viewer({ log }) {
  const [page, setPage] = reactExports.useState(null);
  const [loading, setLoading] = reactExports.useState(false);
  const scrollerRef = reactExports.useRef(null);
  const load = reactExports.useCallback(
    async (opts) => {
      setLoading(true);
      const res = await readSessionLog(log.logId, { limit: READ_LIMIT, ...opts });
      setLoading(false);
      if (res) {
        setPage(res);
        requestAnimationFrame(() => {
          const el = scrollerRef.current;
          if (!el) return;
          el.scrollTop = opts.fromEnd ? el.scrollHeight : 0;
        });
      }
    },
    [log.logId]
  );
  reactExports.useEffect(() => {
    setPage(null);
    void load({ fromEnd: true });
  }, [load]);
  const canUp = page?.hasMoreBefore === true;
  const canDown = page?.hasMoreAfter === true;
  const startOffset = page?.offset ?? 0;
  const endOffset = page ? page.offset + byteLength(page.content) : 0;
  return /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "log-viewer", children: [
    /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "log-viewer__head", children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx(Icon, { name: "notes", size: 14 }),
      /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "log-viewer__title", children: log.title }),
      /* @__PURE__ */ jsxRuntimeExports.jsx(Badge, { tone: "outline", children: formatBytes(log.sizeBytes) }),
      log.hasRecording ? /* @__PURE__ */ jsxRuntimeExports.jsxs(Badge, { tone: "accent", children: [
        "含录制 ",
        log.frames ?? 0,
        " 帧",
        log.recBytes ? ` · ${formatBytes(log.recBytes)}` : "",
        log.compressed ? "（已压缩）" : ""
      ] }) : /* @__PURE__ */ jsxRuntimeExports.jsx(Badge, { tone: "warn", children: "无录制数据" }),
      log.skippedTicks ? /* @__PURE__ */ jsxRuntimeExports.jsxs(Badge, { children: [
        "增量跳过 ",
        log.skippedTicks
      ] }) : null,
      log.hasTiming ? /* @__PURE__ */ jsxRuntimeExports.jsx(Badge, { tone: "accent", children: "含时间线" }) : null,
      log.stopReason ? /* @__PURE__ */ jsxRuntimeExports.jsx(Badge, { tone: log.stopReason.includes("上限") ? "warn" : "default", children: log.stopReason }) : null,
      /* @__PURE__ */ jsxRuntimeExports.jsx("div", { style: { flex: 1 } }),
      /* @__PURE__ */ jsxRuntimeExports.jsxs("span", { className: "metric__sub", children: [
        formatDate(log.startedAt),
        log.stoppedAt ? ` → ${formatDate(log.stoppedAt)}` : ""
      ] }),
      /* @__PURE__ */ jsxRuntimeExports.jsx(IconButton, { icon: "refresh", label: "重新从尾部加载", onClick: () => void load({ fromEnd: true }) })
    ] }),
    /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "log-viewer__pager", children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx(
        Button,
        {
          size: "sm",
          variant: "ghost",
          icon: "chevron-down",
          disabled: !canUp || loading,
          title: canUp ? "加载更早的内容" : "已经是最早的内容",
          onClick: () => void load({ offset: Math.max(0, startOffset - READ_LIMIT) }),
          children: "更早"
        }
      ),
      /* @__PURE__ */ jsxRuntimeExports.jsxs("span", { className: "metric__sub", children: [
        formatBytes(startOffset),
        " – ",
        formatBytes(endOffset),
        " / ",
        formatBytes(page?.totalBytes ?? log.sizeBytes)
      ] }),
      /* @__PURE__ */ jsxRuntimeExports.jsx(
        Button,
        {
          size: "sm",
          variant: "ghost",
          icon: "chevron-right",
          disabled: !canDown || loading,
          title: canDown ? "加载更新的内容" : "已经是最新的内容",
          onClick: () => void load({ offset: endOffset }),
          children: "更新"
        }
      )
    ] }),
    loading && !page ? /* @__PURE__ */ jsxRuntimeExports.jsx(Loading, { text: "读取日志…" }) : /* @__PURE__ */ jsxRuntimeExports.jsx("pre", { className: "log-viewer__text", ref: scrollerRef, children: page?.content || "（空日志）" })
  ] });
}
function SessionLogView() {
  const { logs, active, loading, ready, error } = useStoreShallow((s) => ({
    logs: s.sessionLogs,
    active: s.activeRecordings,
    loading: s.logsLoading,
    ready: s.logsReady,
    error: s.logsError
  }));
  const [selectedId, setSelectedId] = reactExports.useState(null);
  const [replayId, setReplayId] = reactExports.useState(null);
  const [pendingDelete, setPendingDelete] = reactExports.useState(null);
  const recording = useStoreShallow((s) => ({ cfg: s.recordingSettings })).cfg;
  reactExports.useEffect(() => {
    void loadRecordingSettings();
  }, []);
  reactExports.useEffect(() => {
    void loadSessionLogs();
  }, []);
  const selected = logs.find((l) => l.logId === selectedId) ?? null;
  const replayTarget = logs.find((l) => l.logId === replayId) ?? null;
  return /* @__PURE__ */ jsxRuntimeExports.jsxs("main", { className: "content", "aria-label": "会话日志", children: [
    /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "t-toolbar", children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx(Icon, { name: "notes", size: 15 }),
      /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "panel-title", children: "会话日志" }),
      /* @__PURE__ */ jsxRuntimeExports.jsxs(Badge, { children: [
        logs.length,
        " 份"
      ] }),
      active.length > 0 ? /* @__PURE__ */ jsxRuntimeExports.jsxs(Badge, { tone: "danger", children: [
        /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "rec-dot" }),
        " ",
        active.length,
        " 个录制中"
      ] }) : null,
      /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "t-toolbar__spacer" }),
      /* @__PURE__ */ jsxRuntimeExports.jsx(IconButton, { icon: "refresh", label: "刷新列表", loading, onClick: () => void loadSessionLogs() })
    ] }),
    /* @__PURE__ */ jsxRuntimeExports.jsx("div", { style: { padding: "10px 12px 0" }, children: /* @__PURE__ */ jsxRuntimeExports.jsx(Banner, { tone: "warn", children: "日志记录的是**终端的原始输出**：命令里出现过的密码、token、私钥片段都会原样落盘。 分享或上传日志前请先自行检查与脱敏。" }) }),
    recording ? /* @__PURE__ */ jsxRuntimeExports.jsxs(jsxRuntimeExports.Fragment, { children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx(Section, { right: /* @__PURE__ */ jsxRuntimeExports.jsx(Badge, { tone: recording.enabled ? "accent" : "default", children: recording.enabled ? "允许录制" : "未启用" }), children: "录制设置" }),
      /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "rec-settings", children: [
        /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "settings-switch-row", children: [
          /* @__PURE__ */ jsxRuntimeExports.jsx(
            Switch,
            {
              checked: recording.enabled,
              onChange: (v) => void saveRecordingSettings({ enabled: v }),
              label: "允许录制（默认关闭）"
            }
          ),
          /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "t-field__hint", children: "录制会把终端输出**原样**写进快照文件，可能含口令与 token。 默认关闭是刻意的：不该替用户决定留痕。" })
        ] }),
        /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "settings-switch-row", children: [
          /* @__PURE__ */ jsxRuntimeExports.jsx(
            Switch,
            {
              checked: recording.autoCompress,
              onChange: (v) => void saveRecordingSettings({ autoCompress: v }),
              label: "结束后自动压缩"
            }
          ),
          /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "t-field__hint", children: "实测可减少约 89% 体积，代价是停止时多等一点。" })
        ] }),
        /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "settings-switch-row", children: [
          /* @__PURE__ */ jsxRuntimeExports.jsx("label", { className: "t-field__label", htmlFor: "rec-interval", children: "快照间隔 (ms)" }),
          /* @__PURE__ */ jsxRuntimeExports.jsx(
            TextInput,
            {
              id: "rec-interval",
              type: "number",
              mono: true,
              value: String(recording.intervalMs),
              onChange: (e) => void saveRecordingSettings({ intervalMs: Number(e.target.value) || 1e3 })
            }
          ),
          /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "t-field__hint", children: "最小 1000ms；填更小的值会被自动抬到 1000。" })
        ] })
      ] })
    ] }) : null,
    !ready && error ? /* @__PURE__ */ jsxRuntimeExports.jsx("div", { style: { padding: "10px 12px 0" }, children: /* @__PURE__ */ jsxRuntimeExports.jsx(Banner, { tone: "error", children: error }) }) : null,
    /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "log-split", children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "log-list", children: logs.length === 0 ? /* @__PURE__ */ jsxRuntimeExports.jsx(
        EmptyState,
        {
          icon: "notes",
          title: "还没有日志",
          text: "在终端里右键选择「开始记录日志」，或直接开始一段需要留痕的操作。录制中的会话会实时出现在左侧。"
        }
      ) : logs.map((log) => /* @__PURE__ */ jsxRuntimeExports.jsxs(
        "div",
        {
          className: `log-item${log.logId === selectedId ? " log-item--active" : ""}`,
          role: "button",
          tabIndex: 0,
          onClick: () => setSelectedId(log.logId),
          onKeyDown: (e) => {
            if (e.key === "Enter") setSelectedId(log.logId);
          },
          children: [
            /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "log-item__head", children: [
              /* @__PURE__ */ jsxRuntimeExports.jsx(Icon, { name: "notes", size: 12 }),
              /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "log-item__title", children: log.title })
            ] }),
            /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "log-item__meta", children: [
              /* @__PURE__ */ jsxRuntimeExports.jsx("span", { children: formatDate(log.startedAt) }),
              /* @__PURE__ */ jsxRuntimeExports.jsx("span", { children: formatBytes(log.sizeBytes) }),
              log.hasRecording ? /* @__PURE__ */ jsxRuntimeExports.jsxs("span", { children: [
                log.frames ?? 0,
                " 帧"
              ] }) : /* @__PURE__ */ jsxRuntimeExports.jsx("span", { children: "无录制" }),
              log.stopReason ? /* @__PURE__ */ jsxRuntimeExports.jsx("span", { children: log.stopReason }) : null
            ] }),
            /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "log-item__actions", children: [
              /* @__PURE__ */ jsxRuntimeExports.jsx(
                IconButton,
                {
                  icon: "eye",
                  label: log.hasRecording ? `回放 ${log.title}` : `${log.title} 无录制数据（仅文本日志），无法回放`,
                  size: 12,
                  tone: log.hasRecording ? "accent" : "default",
                  disabled: !log.hasRecording,
                  onClick: (e) => {
                    e.stopPropagation();
                    setReplayId(log.logId);
                  }
                }
              ),
              /* @__PURE__ */ jsxRuntimeExports.jsx(
                IconButton,
                {
                  icon: "trash",
                  label: `删除 ${log.title}`,
                  size: 12,
                  tone: "danger",
                  onClick: (e) => {
                    e.stopPropagation();
                    setPendingDelete(log);
                  }
                }
              )
            ] })
          ]
        },
        log.logId
      )) }),
      /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "log-detail", children: replayTarget ? /* @__PURE__ */ jsxRuntimeExports.jsx(
        ReplayPlayer,
        {
          logId: replayTarget.logId,
          title: replayTarget.title,
          onClose: () => setReplayId(null)
        }
      ) : selected ? /* @__PURE__ */ jsxRuntimeExports.jsx(Viewer, { log: selected }, selected.logId) : /* @__PURE__ */ jsxRuntimeExports.jsx(
        EmptyState,
        {
          icon: "search",
          title: logs.length === 0 ? "没有可查看的日志" : "选择左侧的一份日志",
          text: "内容按 256KB 分块加载，可以从尾部往前翻，不会一次性把几十兆推给界面。"
        }
      ) })
    ] }),
    /* @__PURE__ */ jsxRuntimeExports.jsx(
      Modal,
      {
        open: pendingDelete !== null,
        size: "sm",
        title: "删除日志",
        onClose: () => setPendingDelete(null),
        footer: /* @__PURE__ */ jsxRuntimeExports.jsxs(jsxRuntimeExports.Fragment, { children: [
          /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "t-modal__footer-spacer" }),
          /* @__PURE__ */ jsxRuntimeExports.jsx(Button, { variant: "ghost", onClick: () => setPendingDelete(null), children: "取消" }),
          /* @__PURE__ */ jsxRuntimeExports.jsx(
            Button,
            {
              variant: "danger",
              onClick: () => {
                if (!pendingDelete) return;
                void deleteSessionLog(pendingDelete.logId).then(() => {
                  if (selectedId === pendingDelete.logId) setSelectedId(null);
                  setPendingDelete(null);
                  toast.info("日志已从磁盘删除，不可恢复");
                });
              },
              children: "删除"
            }
          )
        ] }),
        children: /* @__PURE__ */ jsxRuntimeExports.jsxs("p", { className: "t-field__hint", style: { marginTop: 0 }, children: [
          "将删除 ",
          /* @__PURE__ */ jsxRuntimeExports.jsx("b", { children: pendingDelete?.title }),
          "（",
          formatBytes(pendingDelete?.sizeBytes ?? 0),
          "）的 .log、.timing 与 .meta.json 三个文件，**不可恢复**。"
        ] })
      }
    )
  ] });
}
export {
  SessionLogSidebar,
  SessionLogView as default
};
