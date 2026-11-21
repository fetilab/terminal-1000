import { u as useStoreShallow, j as jsxRuntimeExports, I as Icon, B as Badge, n as IconButton, aD as refreshMonitor, J as EmptyState, y as formatRelativeTime, a as actions, h as Button, aE as uninstallAgent, aF as installAgent, aG as formatPercent, al as formatBytes, aH as formatTemperature, aI as formatSpeed, aJ as formatFrequency, aK as formatUptime, r as reactExports } from "./index-CwfghMy4.js";
import { V as VirtualList } from "./VirtualList-CIIV3xPp.js";
const CARD_ICON = {
  system: "server",
  cpu: "cpu",
  memory: "memory",
  network: "network",
  disk: "disk",
  process: "list",
  gpu: "activity"
};
const CARD_TITLE = {
  system: "系统",
  cpu: "CPU",
  memory: "内存",
  network: "网络",
  disk: "磁盘",
  process: "进程",
  gpu: "GPU"
};
function Card({
  kind,
  extra,
  empty,
  children
}) {
  return /* @__PURE__ */ jsxRuntimeExports.jsxs("section", { className: "mcard", "aria-label": CARD_TITLE[kind], children: [
    /* @__PURE__ */ jsxRuntimeExports.jsxs("header", { className: "mcard__head", children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx(Icon, { name: CARD_ICON[kind], size: 14 }),
      /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "mcard__head-title", children: CARD_TITLE[kind] }),
      empty ? /* @__PURE__ */ jsxRuntimeExports.jsx(Badge, { tone: "outline", children: "无数据" }) : null,
      extra
    ] }),
    /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "mcard__body", children: empty ? /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "mcard__empty", children: empty }) : children })
  ] });
}
function barTone(percent) {
  if (percent >= 90) return " bar__fill--danger";
  if (percent >= 75) return " bar__fill--warn";
  return "";
}
function MetricBar({
  label,
  value,
  detail,
  percent
}) {
  const clamped = Math.min(100, Math.max(0, percent));
  return /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "metric", children: [
    /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "metric__top", children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "metric__label", children: label }),
      /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "metric__value", children: value }),
      detail ? /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "metric__sub", children: detail }) : null
    ] }),
    /* @__PURE__ */ jsxRuntimeExports.jsx(
      "div",
      {
        className: "bar",
        role: "progressbar",
        "aria-valuenow": Math.round(clamped),
        "aria-valuemin": 0,
        "aria-valuemax": 100,
        "aria-label": typeof label === "string" ? label : void 0,
        children: /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: `bar__fill${barTone(clamped)}`, style: { width: `${clamped}%` } })
      }
    )
  ] });
}
const Sparkline = reactExports.memo(function Sparkline2({
  values,
  max = 100,
  height = 34
}) {
  const width = 260;
  const path = reactExports.useMemo(() => {
    if (values.length < 2) return { line: "", area: "" };
    const step = width / (values.length - 1);
    const safeMax = max <= 0 ? 1 : max;
    const points = values.map((v, i) => {
      const x = i * step;
      const y = height - Math.min(safeMax, Math.max(0, v)) / safeMax * (height - 3) - 1.5;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    });
    const line = `M${points.join(" L")}`;
    const area = `${line} L${width},${height} L0,${height} Z`;
    return { line, area };
  }, [values, max, height]);
  if (!path.line) {
    return /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "metric__sub", children: "采样中…" });
  }
  return /* @__PURE__ */ jsxRuntimeExports.jsxs("svg", { className: "spark", viewBox: `0 0 ${width} ${height}`, preserveAspectRatio: "none", "aria-hidden": true, children: [
    /* @__PURE__ */ jsxRuntimeExports.jsx("defs", { children: /* @__PURE__ */ jsxRuntimeExports.jsxs("linearGradient", { id: "t1000-spark", x1: "0", y1: "0", x2: "0", y2: "1", children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx("stop", { offset: "0%", stopColor: "var(--t1000-accent)", stopOpacity: "0.32" }),
      /* @__PURE__ */ jsxRuntimeExports.jsx("stop", { offset: "100%", stopColor: "var(--t1000-accent)", stopOpacity: "0" })
    ] }) }),
    /* @__PURE__ */ jsxRuntimeExports.jsx("path", { d: path.area, fill: "url(#t1000-spark)" }),
    /* @__PURE__ */ jsxRuntimeExports.jsx("path", { d: path.line, fill: "none", stroke: "var(--t1000-accent)", strokeWidth: "1.4" })
  ] });
});
function SystemCard({ data }) {
  const rows = [
    ["主机名", data.hostname ?? "—"],
    ["发行版", data.distro ?? "—"],
    ["内核", data.kernel ?? "—"],
    ["架构", data.arch ?? "—"],
    ["时区", data.timezone ?? "—"],
    ["运行时长", formatUptime(data.uptimeSeconds)],
    ["登录用户", data.users === void 0 ? "—" : `${data.users} 人`],
    [
      "负载",
      data.loadAvg ? data.loadAvg.map((n) => n.toFixed(2)).join(" / ") : "—"
    ]
  ];
  return /* @__PURE__ */ jsxRuntimeExports.jsx(Card, { kind: "system", children: /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "kv", children: rows.map(([k, v]) => /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { style: { display: "contents" }, children: [
    /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "kv__k", children: k }),
    /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "kv__v", children: v })
  ] }, k)) }) });
}
function CpuCard({ data, history }) {
  return /* @__PURE__ */ jsxRuntimeExports.jsxs(
    Card,
    {
      kind: "cpu",
      extra: data.temperatureC === void 0 ? null : /* @__PURE__ */ jsxRuntimeExports.jsx(Badge, { tone: "warn", children: formatTemperature(data.temperatureC) }),
      children: [
        /* @__PURE__ */ jsxRuntimeExports.jsx(
          MetricBar,
          {
            label: data.model ?? "总体使用率",
            value: formatPercent(data.usage, 1),
            detail: data.logicalCount === void 0 ? void 0 : `${data.physicalCount ?? "—"} 物理 / ${data.logicalCount} 逻辑`,
            percent: data.usage
          }
        ),
        /* @__PURE__ */ jsxRuntimeExports.jsx(Sparkline, { values: history, max: 100 }),
        data.cores.length > 0 ? /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "cores", children: data.cores.map((c) => /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "core", title: `核心 ${c.index} · ${formatPercent(c.usage, 1)} · ${formatFrequency(c.mhz)}`, children: [
          /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "core__fill", style: { height: `${Math.min(100, Math.max(0, c.usage))}%` } }),
          /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "core__text", children: Math.round(c.usage) })
        ] }, c.index)) }) : null
      ]
    }
  );
}
function MemoryCard({ data }) {
  const usedPercent = data.totalBytes > 0 ? data.usedBytes / data.totalBytes * 100 : 0;
  const swapPercent = data.swapTotalBytes && data.swapTotalBytes > 0 ? (data.swapUsedBytes ?? 0) / data.swapTotalBytes * 100 : 0;
  return /* @__PURE__ */ jsxRuntimeExports.jsxs(Card, { kind: "memory", children: [
    /* @__PURE__ */ jsxRuntimeExports.jsx(
      MetricBar,
      {
        label: "内存",
        value: formatBytes(data.usedBytes),
        detail: `/ ${formatBytes(data.totalBytes)}`,
        percent: usedPercent
      }
    ),
    data.cachedBytes !== void 0 ? /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "metric__sub", children: [
      "缓存 ",
      formatBytes(data.cachedBytes)
    ] }) : null,
    data.swapTotalBytes ? /* @__PURE__ */ jsxRuntimeExports.jsx(
      MetricBar,
      {
        label: "Swap",
        value: formatBytes(data.swapUsedBytes),
        detail: `/ ${formatBytes(data.swapTotalBytes)}`,
        percent: swapPercent
      }
    ) : null
  ] });
}
function NetworkCard({ data }) {
  return /* @__PURE__ */ jsxRuntimeExports.jsxs(Card, { kind: "network", children: [
    /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "metric", children: [
      /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "metric__top", children: [
        /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "metric__label", children: "↓ 接收" }),
        /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "metric__value", children: formatSpeed(data.rxSpeed) })
      ] }),
      /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "metric__sub", children: [
        "累计 ",
        formatBytes(data.rxTotalBytes)
      ] })
    ] }),
    /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "metric", children: [
      /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "metric__top", children: [
        /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "metric__label", children: "↑ 发送" }),
        /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "metric__value", children: formatSpeed(data.txSpeed) })
      ] }),
      /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "metric__sub", children: [
        "累计 ",
        formatBytes(data.txTotalBytes)
      ] })
    ] }),
    data.interfaces.length > 0 ? /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "kv", style: { marginTop: 2 }, children: data.interfaces.slice(0, 6).map((nic) => /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { style: { display: "contents" }, children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "kv__k", children: nic.name }),
      /* @__PURE__ */ jsxRuntimeExports.jsxs("span", { className: "kv__v", children: [
        "↓",
        formatSpeed(nic.rxSpeed ?? 0),
        " ↑",
        formatSpeed(nic.txSpeed ?? 0)
      ] })
    ] }, nic.name)) }) : null
  ] });
}
function DiskCard({ data }) {
  return /* @__PURE__ */ jsxRuntimeExports.jsxs(Card, { kind: "disk", children: [
    data.partitions.map((p) => /* @__PURE__ */ jsxRuntimeExports.jsx(
      MetricBar,
      {
        label: p.mount,
        value: formatPercent(p.usedPercent, 0),
        detail: `${formatBytes(p.usedBytes)} / ${formatBytes(p.totalBytes)}`,
        percent: p.usedPercent
      },
      p.mount
    )),
    data.partitions.length === 0 ? /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "metric__sub", children: "未采集到分区信息" }) : null
  ] });
}
function ProcessCard({ data }) {
  return /* @__PURE__ */ jsxRuntimeExports.jsxs(Card, { kind: "process", extra: /* @__PURE__ */ jsxRuntimeExports.jsx(Badge, { children: data.length }), children: [
    /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "proc__row proc__head", children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx("span", { children: "PID" }),
      /* @__PURE__ */ jsxRuntimeExports.jsx("span", { children: "命令" }),
      /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "proc__num", children: "CPU" }),
      /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "proc__num", children: "内存" })
    ] }),
    /* @__PURE__ */ jsxRuntimeExports.jsx(
      VirtualList,
      {
        items: data,
        rowHeight: 24,
        threshold: 40,
        overscan: 8,
        className: "proc__list",
        getKey: (p, i) => `${p.pid}-${i}`,
        renderRow: (p) => /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "proc__row", title: `${p.command}${p.user ? ` · ${p.user}` : ""}`, children: [
          /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "proc__pid", children: p.pid }),
          /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "proc__cmd", children: p.command }),
          /* @__PURE__ */ jsxRuntimeExports.jsxs("span", { className: "proc__num", children: [
            p.cpu.toFixed(1),
            "%"
          ] }),
          /* @__PURE__ */ jsxRuntimeExports.jsxs("span", { className: "proc__num", children: [
            p.memory.toFixed(1),
            "%"
          ] })
        ] })
      }
    )
  ] });
}
function GpuCard({ data }) {
  return /* @__PURE__ */ jsxRuntimeExports.jsx(Card, { kind: "gpu", children: data.map((gpu) => /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "metric", children: [
    /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "metric__top", children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "metric__label", children: gpu.name }),
      /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "metric__value", children: gpu.utilization === void 0 ? "—" : formatPercent(gpu.utilization) })
    ] }),
    gpu.memoryTotalBytes ? /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "metric__sub", children: [
      "显存 ",
      formatBytes(gpu.memoryUsedBytes),
      " / ",
      formatBytes(gpu.memoryTotalBytes),
      gpu.temperatureC === void 0 ? "" : ` · ${formatTemperature(gpu.temperatureC)}`
    ] }) : null
  ] }, gpu.index)) });
}
const MISSING_HINT = {
  system: "等待首次采集…",
  cpu: "等待 CPU 采样…",
  memory: "没有读到 /proc/meminfo（该环境可能不是 Linux）",
  network: "没有读到可用网卡（/proc/net/dev 为空）",
  disk: "没有采集到分区（容器 / 只读根文件系统常见）",
  process: "没有采集到进程列表（ps 不可用或权限不足）",
  gpu: "没有检测到 GPU（需要 nvidia-smi 或 AMD 驱动）"
};
function MonitorPanel({ sessionId, title, onClose }) {
  const { snapshot, status, cards, cpuHistory, error, agentBusy } = useStoreShallow((s) => {
    const snap = sessionId ? s.snapshots[sessionId] : void 0;
    const hist = sessionId ? s.cpuHistory[sessionId] : void 0;
    return {
      snapshot: snap,
      status: sessionId ? s.monitorStatus[sessionId] : void 0,
      cards: s.monitorCards,
      cpuHistory: hist,
      error: sessionId ? s.monitorError[sessionId] : void 0,
      agentBusy: s.agentBusy
    };
  });
  const enabled = cards.filter((c) => c.enabled).sort((a, b) => a.order - b.order);
  const useAgent = snapshot?.source === "agent";
  return /* @__PURE__ */ jsxRuntimeExports.jsxs("aside", { className: "monitor", "aria-label": "服务器监控", children: [
    /* @__PURE__ */ jsxRuntimeExports.jsxs("header", { className: "monitor__head", children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx(Icon, { name: "activity", size: 15 }),
      /* @__PURE__ */ jsxRuntimeExports.jsxs("span", { className: "monitor__title", children: [
        "监控 · ",
        title
      ] }),
      status ? /* @__PURE__ */ jsxRuntimeExports.jsx(Badge, { tone: status === "running" ? "ok" : status === "unavailable" ? "warn" : "default", children: status === "running" ? "采集中" : status === "starting" ? "启动中" : status === "paused" ? "已暂停" : status === "unavailable" ? "不可用" : "已停止" }) : null,
      snapshot ? /* @__PURE__ */ jsxRuntimeExports.jsx(
        Badge,
        {
          tone: useAgent ? "accent" : "outline",
          title: useAgent ? "数据来自远端常驻代理，经 SSH 隧道直连远端 127.0.0.1（不开放任何入站端口）" : "数据来自每次 exec 的采集脚本（服务器没装代理时的兼容模式）",
          children: useAgent ? "代理 · 隧道" : "脚本模式"
        }
      ) : null,
      sessionId ? /* @__PURE__ */ jsxRuntimeExports.jsx(IconButton, { icon: "refresh", label: "立即刷新", onClick: () => void refreshMonitor(sessionId) }) : null,
      /* @__PURE__ */ jsxRuntimeExports.jsx(IconButton, { icon: "close", label: "关闭监控面板", onClick: onClose })
    ] }),
    /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "monitor__body", children: !sessionId ? /* @__PURE__ */ jsxRuntimeExports.jsx(EmptyState, { icon: "activity", title: "没有活动会话", text: "先连接一台服务器，再打开监控面板。" }) : status === "unavailable" && !snapshot ? /* @__PURE__ */ jsxRuntimeExports.jsx(
      EmptyState,
      {
        icon: "alert-triangle",
        title: "监控采集不可用",
        text: "主进程的监控服务尚未就绪（或该会话不支持采集）。面板会在服务上线后自动恢复。"
      }
    ) : !snapshot ? /* @__PURE__ */ jsxRuntimeExports.jsx(
      EmptyState,
      {
        icon: "clock",
        title: "等待首次采集",
        text: `已启用 ${enabled.length} 个卡片。首个采样周期结束后这里会出现数据。`
      }
    ) : /* @__PURE__ */ jsxRuntimeExports.jsxs(jsxRuntimeExports.Fragment, { children: [
      error ? /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "monitor__warn", role: "status", children: [
        /* @__PURE__ */ jsxRuntimeExports.jsx(Icon, { name: "alert-triangle", size: 12 }),
        /* @__PURE__ */ jsxRuntimeExports.jsxs("span", { children: [
          "最近一次采集失败：",
          error,
          "（会自动重试）"
        ] })
      ] }) : null,
      /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "metric__sub", children: [
        "采集于 ",
        formatRelativeTime(snapshot.at),
        snapshot.elapsedMs === void 0 ? "" : ` · 耗时 ${snapshot.elapsedMs} ms`,
        snapshot.agentVersion ? ` · 代理 v${snapshot.agentVersion}` : ""
      ] }),
      enabled.map((card) => {
        switch (card.kind) {
          case "system":
            return snapshot.system ? /* @__PURE__ */ jsxRuntimeExports.jsx(SystemCard, { data: snapshot.system }, card.kind) : /* @__PURE__ */ jsxRuntimeExports.jsx(Card, { kind: "system", empty: MISSING_HINT.system }, card.kind);
          case "cpu":
            return snapshot.cpu ? /* @__PURE__ */ jsxRuntimeExports.jsx(CpuCard, { data: snapshot.cpu, history: cpuHistory ?? [] }, card.kind) : /* @__PURE__ */ jsxRuntimeExports.jsx(Card, { kind: "cpu", empty: MISSING_HINT.cpu }, card.kind);
          case "memory":
            return snapshot.memory ? /* @__PURE__ */ jsxRuntimeExports.jsx(MemoryCard, { data: snapshot.memory }, card.kind) : /* @__PURE__ */ jsxRuntimeExports.jsx(Card, { kind: "memory", empty: MISSING_HINT.memory }, card.kind);
          case "network":
            return snapshot.network ? /* @__PURE__ */ jsxRuntimeExports.jsx(NetworkCard, { data: snapshot.network }, card.kind) : /* @__PURE__ */ jsxRuntimeExports.jsx(Card, { kind: "network", empty: MISSING_HINT.network }, card.kind);
          case "disk":
            return snapshot.disk && snapshot.disk.partitions.length > 0 ? /* @__PURE__ */ jsxRuntimeExports.jsx(DiskCard, { data: snapshot.disk }, card.kind) : /* @__PURE__ */ jsxRuntimeExports.jsx(Card, { kind: "disk", empty: MISSING_HINT.disk }, card.kind);
          case "process":
            return snapshot.processes && snapshot.processes.length > 0 ? /* @__PURE__ */ jsxRuntimeExports.jsx(ProcessCard, { data: snapshot.processes }, card.kind) : /* @__PURE__ */ jsxRuntimeExports.jsx(Card, { kind: "process", empty: MISSING_HINT.process }, card.kind);
          case "gpu":
            return snapshot.gpu && snapshot.gpu.length > 0 ? /* @__PURE__ */ jsxRuntimeExports.jsx(GpuCard, { data: snapshot.gpu }, card.kind) : /* @__PURE__ */ jsxRuntimeExports.jsx(Card, { kind: "gpu", empty: MISSING_HINT.gpu }, card.kind);
          default:
            return null;
        }
      }),
      snapshot.warnings && snapshot.warnings.length > 0 ? /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "mcard monitor__issues", children: [
        /* @__PURE__ */ jsxRuntimeExports.jsxs("header", { className: "mcard__head", children: [
          /* @__PURE__ */ jsxRuntimeExports.jsx(Icon, { name: "alert-triangle", size: 14 }),
          /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "mcard__head-title", children: "采集告警" }),
          /* @__PURE__ */ jsxRuntimeExports.jsx(Badge, { tone: "warn", children: snapshot.warnings.length })
        ] }),
        /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "mcard__body", children: snapshot.warnings.slice(0, 4).map((w, i) => /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "metric__sub", children: [
          "· ",
          w
        ] }, `${w}-${i}`)) })
      ] }) : null,
      /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "mcard", children: [
        /* @__PURE__ */ jsxRuntimeExports.jsxs("header", { className: "mcard__head", children: [
          /* @__PURE__ */ jsxRuntimeExports.jsx(Icon, { name: "sliders", size: 14 }),
          /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "mcard__head-title", children: "卡片开关" })
        ] }),
        /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "mcard__body", children: [
          /* @__PURE__ */ jsxRuntimeExports.jsx("div", { style: { display: "flex", flexWrap: "wrap", gap: 6 }, children: cards.slice().sort((a, b) => a.order - b.order).map((c) => /* @__PURE__ */ jsxRuntimeExports.jsx(
            "button",
            {
              type: "button",
              className: `t-badge${c.enabled ? " t-badge--accent" : ""}`,
              style: { cursor: "pointer", border: "1px solid transparent" },
              "aria-pressed": c.enabled,
              onClick: () => actions.toggleMonitorCard(c.kind),
              children: CARD_TITLE[c.kind]
            },
            c.kind
          )) }),
          /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "metric__sub", children: "关闭的卡片不会产生对应的采集命令，改完立即生效。" }),
          /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "monitor__channel", children: [
            /* @__PURE__ */ jsxRuntimeExports.jsxs("span", { children: [
              "采集通道：",
              useAgent ? "远端常驻代理，经 SSH 隧道取数（推荐）" : "每次 exec 采集脚本（兼容模式）"
            ] }),
            useAgent ? /* @__PURE__ */ jsxRuntimeExports.jsx(
              Button,
              {
                size: "sm",
                variant: "ghost",
                loading: agentBusy,
                onClick: () => void uninstallAgent(sessionId),
                children: "卸载代理"
              }
            ) : /* @__PURE__ */ jsxRuntimeExports.jsx(
              Button,
              {
                size: "sm",
                variant: "outline",
                icon: "download",
                loading: agentBusy,
                onClick: () => void installAgent(sessionId),
                children: "安装代理（更快）"
              }
            )
          ] })
        ] })
      ] })
    ] }) })
  ] });
}
export {
  MonitorPanel,
  MonitorPanel as default
};
