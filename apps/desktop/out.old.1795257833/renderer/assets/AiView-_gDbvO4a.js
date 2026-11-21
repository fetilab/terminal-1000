import { r as reactExports, U as subscribe, i as invoke, e as errorText, a0 as Events, u as useStoreShallow, j as jsxRuntimeExports, I as Icon, B as Badge, f as Banner, J as EmptyState, h as Button, a as actions, L as Loading, ag as TextArea, n as IconButton, F as Field, z as Select, y as formatRelativeTime, t as toast } from "./index-CwfghMy4.js";
let state = {
  chats: [],
  activeChatId: null,
  messages: [],
  providers: [],
  activeProviderId: null,
  streamingId: null,
  streamingText: "",
  toolTraces: {},
  sending: false,
  error: null
};
const listeners = /* @__PURE__ */ new Set();
function emit() {
  for (const l of listeners) l();
}
function set(patch) {
  state = { ...state, ...patch };
  emit();
}
function subscribeStore(listener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
function snapshot() {
  return state;
}
function useAi(selector, isEqual = Object.is) {
  const cache = reactExports.useRef(null);
  const selectorRef = reactExports.useRef(selector);
  const equalRef = reactExports.useRef(isEqual);
  selectorRef.current = selector;
  equalRef.current = isEqual;
  const getSnapshot = reactExports.useCallback(() => {
    const current = snapshot();
    const cached = cache.current;
    if (cached && cached.state === current) return cached.value;
    const value = selectorRef.current(current);
    if (cached && equalRef.current(cached.value, value)) {
      cache.current = { state: current, value: cached.value };
      return cached.value;
    }
    cache.current = { state: current, value };
    return value;
  }, []);
  return reactExports.useSyncExternalStore(subscribeStore, getSnapshot, getSnapshot);
}
async function loadChats() {
  try {
    const chats = await invoke(
      "ai",
      "listChats",
      {}
    );
    set({ chats: Array.isArray(chats) ? chats : [], error: null });
  } catch (err) {
    set({ error: errorText(err) });
  }
}
async function loadProviders() {
  try {
    const res = await invoke(
      "ai",
      "listProviders",
      {}
    );
    set({ providers: res?.providers ?? [] });
  } catch {
    set({ providers: [] });
  }
}
async function openChat(chatId) {
  try {
    const chat = await invoke("ai", "getChat", {
      chatId
    });
    set({
      activeChatId: chat.id,
      messages: chat.messages ?? [],
      streamingId: null,
      streamingText: "",
      toolTraces: {},
      error: null
    });
  } catch (err) {
    set({ error: errorText(err) });
  }
}
function startNewChat() {
  set({
    activeChatId: null,
    messages: [],
    streamingId: null,
    streamingText: "",
    toolTraces: {},
    error: null
  });
}
async function deleteChat(chatId) {
  try {
    await invoke("ai", "deleteChat", { chatId });
    if (state.activeChatId === chatId) startNewChat();
    await loadChats();
  } catch (err) {
    set({ error: errorText(err) });
  }
}
async function setProvider(providerId) {
  try {
    await invoke("ai", "setProvider", {
      providerId
    });
    set({ activeProviderId: providerId });
  } catch (err) {
    set({ error: errorText(err) });
  }
}
async function sendMessage(text) {
  const trimmed = text.trim();
  if (!trimmed || state.sending) return;
  const localUserId = `local-user-${Date.now()}`;
  set({
    messages: [
      ...state.messages,
      { id: localUserId, role: "user", content: trimmed, createdAt: (/* @__PURE__ */ new Date()).toISOString() }
    ],
    sending: true,
    error: null
  });
  try {
    const payload = { text: trimmed };
    if (state.activeChatId) payload.chatId = state.activeChatId;
    const res = await invoke("ai", "send", payload);
    set({
      activeChatId: res.chatId,
      sending: false,
      streamingId: null,
      streamingText: "",
      messages: [
        ...state.messages.filter((m) => m.id !== res.messageId),
        { id: res.messageId, role: "assistant", content: res.text, createdAt: (/* @__PURE__ */ new Date()).toISOString() }
      ]
    });
    await loadChats();
  } catch (err) {
    set({ sending: false, streamingId: null, error: errorText(err) });
  }
}
async function cancelSend() {
  if (!state.activeChatId) return;
  try {
    await invoke("ai", "cancel", {
      chatId: state.activeChatId
    });
  } catch {
  }
}
let wired = false;
function wireAiEvents() {
  if (wired) return;
  wired = true;
  subscribe(Events.AI_DELTA, (p) => {
    set({ streamingId: p.messageId, streamingText: state.streamingText + p.text });
  });
  subscribe(Events.AI_TOOL_CALL, (p) => {
    const list = state.toolTraces[p.messageId] ?? [];
    set({
      toolTraces: {
        ...state.toolTraces,
        [p.messageId]: [...list, { id: `${p.tool}-${list.length}`, tool: p.tool, args: p.args, done: false }]
      }
    });
  });
  subscribe(Events.AI_TOOL_RESULT, (p) => {
    const list = state.toolTraces[p.messageId] ?? [];
    let idx = -1;
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const item = list[i];
      if (item && item.tool === p.tool && !item.done) {
        idx = i;
        break;
      }
    }
    const next = list.slice();
    if (idx >= 0) {
      const cur = next[idx];
      if (cur) next[idx] = { ...cur, result: p.result, isError: p.isError === true, done: true };
    } else {
      next.push({
        id: `${p.tool}-${list.length}`,
        tool: p.tool,
        args: void 0,
        result: p.result,
        isError: p.isError === true,
        done: true
      });
    }
    set({ toolTraces: { ...state.toolTraces, [p.messageId]: next } });
  });
  subscribe(Events.AI_DONE, (p) => {
    const text = state.streamingText;
    set({
      streamingId: null,
      streamingText: "",
      sending: false,
      messages: [
        ...state.messages.filter((m) => m.id !== p.messageId),
        { id: p.messageId, role: "assistant", content: text, createdAt: (/* @__PURE__ */ new Date()).toISOString() }
      ]
    });
  });
  subscribe(Events.AI_ERROR, (p) => {
    set({ sending: false, streamingId: null, streamingText: "", error: p.message });
  });
}
const MODE_LABEL = {
  chat: "只聊天",
  assistant: "自动协助",
  confirm: "每步确认",
  thinking: "扩展思考"
};
function ToolTraceCard({ trace }) {
  const [open, setOpen] = reactExports.useState(false);
  const args = trace.args === void 0 ? "" : JSON.stringify(trace.args, null, 2);
  const result = trace.result === void 0 ? "" : typeof trace.result === "string" ? trace.result : JSON.stringify(trace.result, null, 2);
  return /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: `ai-tool${trace.isError ? " ai-tool--error" : ""}`, children: [
    /* @__PURE__ */ jsxRuntimeExports.jsxs("button", { type: "button", className: "ai-tool__head", onClick: () => setOpen((v) => !v), children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx(Icon, { name: trace.isError ? "alert-triangle" : "sliders", size: 13 }),
      /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "ai-tool__name", children: trace.tool }),
      trace.done ? /* @__PURE__ */ jsxRuntimeExports.jsx(Badge, { tone: trace.isError ? "danger" : "ok", children: trace.isError ? "被拒绝/失败" : "已执行" }) : /* @__PURE__ */ jsxRuntimeExports.jsx(Badge, { tone: "accent", children: "执行中…" }),
      /* @__PURE__ */ jsxRuntimeExports.jsx(Icon, { name: open ? "chevron-down" : "chevron-right", size: 12 })
    ] }),
    open ? /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "ai-tool__body", children: [
      args ? /* @__PURE__ */ jsxRuntimeExports.jsxs(jsxRuntimeExports.Fragment, { children: [
        /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "ai-tool__label", children: "请求参数" }),
        /* @__PURE__ */ jsxRuntimeExports.jsx("pre", { className: "ai-tool__pre", children: args })
      ] }) : null,
      result ? /* @__PURE__ */ jsxRuntimeExports.jsxs(jsxRuntimeExports.Fragment, { children: [
        /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "ai-tool__label", children: trace.isError ? "拒绝原因" : "执行结果" }),
        /* @__PURE__ */ jsxRuntimeExports.jsx("pre", { className: "ai-tool__pre", children: result })
      ] }) : null
    ] }) : null
  ] });
}
function AiSidebar() {
  const { chats, activeChatId, providers, activeProviderId } = useAi((s) => ({
    chats: s.chats,
    activeChatId: s.activeChatId,
    providers: s.providers,
    activeProviderId: s.activeProviderId
  }));
  reactExports.useEffect(() => {
    void loadChats();
    void loadProviders();
  }, []);
  return /* @__PURE__ */ jsxRuntimeExports.jsxs("aside", { className: "panel", "aria-label": "AI 会话", children: [
    /* @__PURE__ */ jsxRuntimeExports.jsxs("header", { className: "panel-header", children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "panel-title", children: "AI 助手" }),
      /* @__PURE__ */ jsxRuntimeExports.jsx(IconButton, { icon: "refresh", label: "刷新会话列表", onClick: () => void loadChats() })
    ] }),
    /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "panel-body", children: [
      providers.length === 0 ? /* @__PURE__ */ jsxRuntimeExports.jsx("div", { style: { padding: 10 }, children: /* @__PURE__ */ jsxRuntimeExports.jsx(Banner, { tone: "warn", children: "还没有配置 AI 供应商。密钥只存本机（BYO-key，不经任何中转）。" }) }) : /* @__PURE__ */ jsxRuntimeExports.jsx("div", { style: { padding: "8px 8px 0" }, children: /* @__PURE__ */ jsxRuntimeExports.jsx(Field, { label: "当前供应商", children: /* @__PURE__ */ jsxRuntimeExports.jsx(
        Select,
        {
          value: activeProviderId ?? providers.find((p) => p.id)?.id ?? "",
          options: providers.map((p) => ({
            value: p.id,
            label: `${p.name} · ${p.model}${p.hasApiKey ? "" : "（缺密钥）"}`
          })),
          onChange: (e) => void setProvider(e.target.value)
        }
      ) }) }),
      /* @__PURE__ */ jsxRuntimeExports.jsxs("nav", { className: "sessions", children: [
        /* @__PURE__ */ jsxRuntimeExports.jsxs(
          "button",
          {
            type: "button",
            className: `session-item${activeChatId === null ? " session-item--active" : ""}`,
            onClick: () => startNewChat(),
            children: [
              /* @__PURE__ */ jsxRuntimeExports.jsx(Icon, { name: "plus", size: 14 }),
              /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "session-item__body", children: /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "session-item__title", children: "新对话" }) })
            ]
          }
        ),
        chats.map((c) => /* @__PURE__ */ jsxRuntimeExports.jsxs(
          "div",
          {
            className: `session-item ai-chat-item${c.id === activeChatId ? " session-item--active" : ""}`,
            role: "button",
            tabIndex: 0,
            onClick: () => void openChat(c.id),
            onKeyDown: (e) => {
              if (e.key === "Enter") void openChat(c.id);
            },
            children: [
              /* @__PURE__ */ jsxRuntimeExports.jsx(Icon, { name: "activity", size: 14 }),
              /* @__PURE__ */ jsxRuntimeExports.jsxs("span", { className: "session-item__body", children: [
                /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "session-item__title", children: c.title || "未命名对话" }),
                /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "session-item__meta", children: formatRelativeTime(c.updatedAt) })
              ] }),
              /* @__PURE__ */ jsxRuntimeExports.jsx(
                IconButton,
                {
                  icon: "trash",
                  label: "删除对话",
                  size: 12,
                  onClick: (e) => {
                    e.stopPropagation();
                    void deleteChat(c.id);
                  }
                }
              )
            ]
          },
          c.id
        ))
      ] })
    ] }),
    /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "panel-footer", children: /* @__PURE__ */ jsxRuntimeExports.jsx(Button, { size: "sm", variant: "outline", icon: "plus", style: { flex: 1 }, onClick: () => startNewChat(), children: "新对话" }) })
  ] });
}
function AiView() {
  const { messages, providers, streamingId, streamingText, toolTraces, sending, error, activeChatId } = useAi((s) => ({
    messages: s.messages,
    providers: s.providers,
    streamingId: s.streamingId,
    streamingText: s.streamingText,
    toolTraces: s.toolTraces,
    sending: s.sending,
    error: s.error,
    activeChatId: s.activeChatId
  }));
  const aiMode = useStoreShallow((s) => ({ mode: s.aiMode })).mode;
  const [input, setInput] = reactExports.useState("");
  const scrollerRef = reactExports.useRef(null);
  reactExports.useEffect(() => {
    wireAiEvents();
  }, []);
  reactExports.useEffect(() => {
    const el = scrollerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, streamingText]);
  const submit = () => {
    const text = input;
    if (!text.trim()) return;
    if (providers.length === 0) {
      toast.warn("请先在设置 → AI 助手里配置供应商与密钥");
      return;
    }
    setInput("");
    void sendMessage(text);
  };
  const noProvider = providers.length === 0;
  return /* @__PURE__ */ jsxRuntimeExports.jsxs("main", { className: "content", "aria-label": "AI 助手", children: [
    /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "t-toolbar", children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx(Icon, { name: "activity", size: 15 }),
      /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "panel-title", children: "AI 助手" }),
      /* @__PURE__ */ jsxRuntimeExports.jsx(Badge, { tone: "outline", children: MODE_LABEL[aiMode] ?? aiMode }),
      sending ? /* @__PURE__ */ jsxRuntimeExports.jsx(Badge, { tone: "accent", children: "生成中" }) : null,
      /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "t-toolbar__spacer" }),
      /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "term-toolbar__meta", children: "密钥只存本机 · 直连供应商" })
    ] }),
    error ? /* @__PURE__ */ jsxRuntimeExports.jsx("div", { style: { padding: "10px 12px 0" }, children: /* @__PURE__ */ jsxRuntimeExports.jsx(Banner, { tone: "error", children: error }) }) : null,
    /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "ai-messages", ref: scrollerRef, children: [
      messages.length === 0 ? /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "conn-empty", children: /* @__PURE__ */ jsxRuntimeExports.jsx(
        EmptyState,
        {
          icon: "activity",
          title: noProvider ? "先配置一个供应商" : "开始一段对话",
          text: noProvider ? "AI 助手使用你自己的 API key 直连供应商，不经过任何中转。到「设置 → AI 助手」填写 endpoint、模型与密钥。" : "可以问命令怎么用、让它解释报错，或在开启执行权限后让它协助排查。执行类操作受风险黑白名单与三重上限约束。",
          actions: noProvider ? /* @__PURE__ */ jsxRuntimeExports.jsx(Button, { variant: "primary", icon: "settings", onClick: () => actions.setView("settings"), children: "去配置" }) : null
        }
      ) }) : messages.map((m) => {
        if (m.role === "system" || m.role === "tool") return null;
        const traces = toolTraces[m.id] ?? [];
        return /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: `ai-msg ai-msg--${m.role}`, children: [
          /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "ai-msg__role", children: [
            /* @__PURE__ */ jsxRuntimeExports.jsx(Icon, { name: m.role === "user" ? "user" : "activity", size: 12 }),
            m.role === "user" ? "你" : "助手"
          ] }),
          /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "ai-msg__body", children: [
            m.content ? /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "ai-msg__text", children: m.content }) : null,
            traces.map((t) => /* @__PURE__ */ jsxRuntimeExports.jsx(ToolTraceCard, { trace: t }, t.id))
          ] })
        ] }, m.id);
      }),
      streamingId ? /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "ai-msg ai-msg--assistant", children: [
        /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "ai-msg__role", children: [
          /* @__PURE__ */ jsxRuntimeExports.jsx(Icon, { name: "activity", size: 12 }),
          "助手",
          /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "ai-caret", "aria-hidden": true })
        ] }),
        /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "ai-msg__body", children: [
          /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "ai-msg__text", children: streamingText || "…" }),
          (toolTraces[streamingId] ?? []).map((t) => /* @__PURE__ */ jsxRuntimeExports.jsx(ToolTraceCard, { trace: t }, t.id))
        ] })
      ] }) : null,
      sending && !streamingId ? /* @__PURE__ */ jsxRuntimeExports.jsx(Loading, { text: "思考中…" }) : null
    ] }),
    /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "ai-composer", children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx(
        TextArea,
        {
          className: "ai-composer__input",
          value: input,
          rows: 3,
          placeholder: noProvider ? "先配置供应商…" : "输入问题（Enter 发送，Shift+Enter 换行）",
          disabled: noProvider,
          onChange: (e) => setInput(e.target.value),
          onKeyDown: (e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }
        }
      ),
      /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "ai-composer__actions", children: [
        /* @__PURE__ */ jsxRuntimeExports.jsxs("span", { className: "t-field__hint", children: [
          activeChatId ? "继续当前对话" : "将创建新对话",
          aiMode === "chat" ? " · 只聊天模式不会执行命令" : ""
        ] }),
        /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "t-toolbar__spacer" }),
        sending ? /* @__PURE__ */ jsxRuntimeExports.jsx(Button, { variant: "outline", icon: "close", onClick: () => void cancelSend(), children: "停止" }) : null,
        /* @__PURE__ */ jsxRuntimeExports.jsx(Button, { variant: "primary", icon: "zap", disabled: noProvider || !input.trim(), onClick: submit, children: "发送" })
      ] })
    ] })
  ] });
}
export {
  AiSidebar,
  AiView as default
};
