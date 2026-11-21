import { r as reactExports, j as jsxRuntimeExports, I as Icon, B as Badge, G as Switch, T as TextInput, n as IconButton, F as Field, h as Button, t as toast, g as getVaultState, f as Banner, ai as Section, ao as lockVault, e as errorText, d as unlockVault, b as setMasterPassword, u as useStoreShallow, L as Loading, ap as applyHighlightRules, a as actions, i as invoke, aq as applyTheme, ar as applyAppearance, as as applyTerminalSettings, z as Select } from "./index-C6luzS_t.js";
import { a as SETTINGS_FIELDS, S as SECTION_META, s as summarizeAi, r as readPath } from "./settingsFields-BLB3omCp.js";
import { a as segmentHighlightStyle } from "./highlights-DAa5Pc3k.js";
import { S as ServerIdentityPanel } from "./ServerIdentityPanel-Bl4FrydH.js";
const SAMPLE = `2026-11-07 09:12:03 [error] connection to 192.0.2.31 refused
2026-11-07 09:12:04 [warn] retrying in 2s
2026-11-07 09:12:06 [ok] tunnel active (running) on 127.0.0.1
Done. 3 hosts scanned, 1 unreachable`;
function buildPreview(text, rules) {
  const active = rules.filter((r) => r.enabled && r.pattern).slice().sort((a, b) => b.priority - a.priority);
  const owner = new Array(text.length);
  for (const rule of active) {
    let re;
    try {
      const flags = rule.flags?.includes("g") ? rule.flags : `${rule.flags ?? ""}g`;
      re = new RegExp(rule.pattern, flags);
    } catch {
      continue;
    }
    let guard = 0;
    let m;
    while ((m = re.exec(text)) !== null && guard < 500) {
      guard += 1;
      if (m[0].length === 0) {
        re.lastIndex += 1;
        continue;
      }
      for (let i = m.index; i < m.index + m[0].length; i += 1) {
        if (owner[i] === void 0) owner[i] = rule;
      }
    }
  }
  const segs = [];
  let cur = null;
  for (let i = 0; i < text.length; i += 1) {
    const rule = owner[i];
    if (cur && cur.rule === rule) {
      cur.text += text[i];
    } else {
      if (cur) segs.push(toSeg(cur));
      cur = { rule, text: text[i] ?? "" };
    }
  }
  if (cur) segs.push(toSeg(cur));
  return segs;
}
function toSeg(part) {
  if (!part.rule) return { text: part.text };
  const style = segmentHighlightStyle(part.rule);
  return {
    text: part.text,
    ...style.color ? { color: style.color } : {},
    ...part.rule.bold ? { bold: true } : {}
  };
}
function regexError(pattern, flags) {
  if (!pattern.trim()) return "正则不能为空";
  try {
    new RegExp(pattern, flags);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}
function HighlightsEditor({ rules, onChange }) {
  const [draft, setDraft] = reactExports.useState(rules);
  const dirty = reactExports.useRef(false);
  const timer = reactExports.useRef(void 0);
  reactExports.useEffect(() => {
    if (!dirty.current) setDraft(rules);
  }, [rules]);
  reactExports.useEffect(() => () => window.clearTimeout(timer.current), []);
  const commitSoon = reactExports.useCallback(
    (next, immediate = false) => {
      setDraft(next);
      dirty.current = true;
      window.clearTimeout(timer.current);
      if (immediate) {
        dirty.current = false;
        onChange(next);
        return;
      }
      timer.current = window.setTimeout(() => {
        dirty.current = false;
        onChange(next);
      }, 450);
    },
    [onChange]
  );
  const preview = reactExports.useMemo(() => buildPreview(SAMPLE, draft), [draft]);
  const broken = reactExports.useMemo(
    () => draft.filter((r) => regexError(r.pattern, r.flags) !== null).map((r) => r.id),
    [draft]
  );
  const patch = (id, p, immediate = false) => {
    commitSoon(draft.map((r) => r.id === id ? { ...r, ...p } : r), immediate);
  };
  return /* @__PURE__ */ jsxRuntimeExports.jsxs(jsxRuntimeExports.Fragment, { children: [
    /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "hl-preview", children: [
      /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "hl-preview__label", children: [
        /* @__PURE__ */ jsxRuntimeExports.jsx(Icon, { name: "eye", size: 13 }),
        "实时预览",
        broken.length > 0 ? /* @__PURE__ */ jsxRuntimeExports.jsxs(Badge, { tone: "danger", children: [
          broken.length,
          " 条正则无效"
        ] }) : null
      ] }),
      /* @__PURE__ */ jsxRuntimeExports.jsx("pre", { className: "hl-preview__text", children: preview.map((seg, i) => /* @__PURE__ */ jsxRuntimeExports.jsx(
        "span",
        {
          style: {
            color: seg.color,
            fontWeight: seg.bold ? 700 : void 0
          },
          children: seg.text
        },
        i
      )) }),
      /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "t-field__hint", children: "只对**增量渲染**生效，不会回刷已有历史输出（与原产品一致，避免滚动时重排卡顿）。" })
    ] }),
    /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "hl-list", children: draft.slice().sort((a, b) => b.priority - a.priority).map((rule) => {
      const err = regexError(rule.pattern, rule.flags);
      return /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "hl-rule", children: [
        /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "hl-rule__head", children: [
          /* @__PURE__ */ jsxRuntimeExports.jsx(
            Switch,
            {
              checked: rule.enabled,
              onChange: (v) => patch(rule.id, { enabled: v }, true),
              label: "启用",
              bare: true
            }
          ),
          /* @__PURE__ */ jsxRuntimeExports.jsx(
            TextInput,
            {
              className: "hl-rule__name",
              value: rule.name,
              "aria-label": "规则名称",
              onChange: (e) => patch(rule.id, { name: e.target.value })
            }
          ),
          /* @__PURE__ */ jsxRuntimeExports.jsx(
            TextInput,
            {
              className: "hl-rule__flags",
              value: rule.flags ?? "",
              "aria-label": "正则 flags",
              mono: true,
              placeholder: "gi",
              onChange: (e) => patch(rule.id, { flags: e.target.value })
            }
          ),
          /* @__PURE__ */ jsxRuntimeExports.jsx(
            TextInput,
            {
              className: "hl-rule__priority",
              type: "number",
              value: String(rule.priority),
              "aria-label": "优先级",
              mono: true,
              onChange: (e) => patch(rule.id, { priority: Number(e.target.value) || 0 })
            }
          ),
          /* @__PURE__ */ jsxRuntimeExports.jsx("label", { className: "hl-rule__color", title: "前景色", children: /* @__PURE__ */ jsxRuntimeExports.jsx(
            "input",
            {
              type: "color",
              value: rule.foreground ?? "#e4e7ee",
              onChange: (e) => patch(rule.id, { foreground: e.target.value }, true)
            }
          ) }),
          rule.builtin ? /* @__PURE__ */ jsxRuntimeExports.jsx(Badge, { tone: "outline", title: "内置规则不可删除", children: "内置" }) : /* @__PURE__ */ jsxRuntimeExports.jsx(
            IconButton,
            {
              icon: "trash",
              label: `删除规则 ${rule.name}`,
              tone: "danger",
              onClick: () => commitSoon(draft.filter((r) => r.id !== rule.id), true)
            }
          )
        ] }),
        /* @__PURE__ */ jsxRuntimeExports.jsx(Field, { label: "正则", error: err, children: /* @__PURE__ */ jsxRuntimeExports.jsx(
          TextInput,
          {
            value: rule.pattern,
            mono: true,
            invalid: Boolean(err),
            onChange: (e) => patch(rule.id, { pattern: e.target.value })
          }
        ) }),
        /* @__PURE__ */ jsxRuntimeExports.jsx(Field, { label: "文字颜色（可选）", children: /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "t-inputgroup", children: [
          /* @__PURE__ */ jsxRuntimeExports.jsx(
            TextInput,
            {
              value: rule.background ?? "",
              mono: true,
              placeholder: "#2a2f3a 或留空",
              onChange: (e) => patch(rule.id, {
                background: e.target.value.trim() === "" ? void 0 : e.target.value
              })
            }
          ),
          /* @__PURE__ */ jsxRuntimeExports.jsx("label", { className: "hl-rule__color", children: /* @__PURE__ */ jsxRuntimeExports.jsx(
            "input",
            {
              type: "color",
              value: rule.background ?? "#2a2f3a",
              onChange: (e) => patch(rule.id, { background: e.target.value }, true)
            }
          ) })
        ] }) })
      ] }, rule.id);
    }) }),
    /* @__PURE__ */ jsxRuntimeExports.jsx("div", { style: { marginTop: 14 }, children: /* @__PURE__ */ jsxRuntimeExports.jsx(
      Button,
      {
        variant: "outline",
        icon: "plus",
        onClick: () => commitSoon(
          [
            ...draft,
            {
              id: `custom-${Date.now()}`,
              name: "新规则",
              pattern: "",
              flags: "gi",
              foreground: "#3ec9d6",
              priority: 5,
              enabled: true
            }
          ],
          true
        ),
        children: "新增规则"
      }
    ) })
  ] });
}
const COMMAND_LABELS = {
  "terminal.newTab": "新建会话标签",
  "terminal.closeTab": "关闭当前标签",
  "terminal.find": "终端内查找",
  "terminal.clear": "清屏",
  "terminal.splitHorizontal": "左右分屏",
  "terminal.splitVertical": "上下分屏",
  "app.toggleWindow": "显示 / 隐藏主窗口"
};
function toAccelerator(e) {
  const mods = [];
  if (e.ctrlKey) mods.push("Ctrl");
  if (e.altKey) mods.push("Alt");
  if (e.shiftKey) mods.push("Shift");
  if (e.metaKey) mods.push("Super");
  const key = e.key;
  if (["Control", "Alt", "Shift", "Meta"].includes(key)) return null;
  if (mods.length === 0) return null;
  let main;
  if (key === " ") main = "Space";
  else if (key.length === 1) main = key.toUpperCase();
  else if (key.startsWith("Arrow")) main = key.slice(5);
  else main = key;
  return [...mods, main].join("+");
}
function Keycaps({ accelerator }) {
  if (!accelerator) return /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "t-field__hint", children: "未绑定" });
  return /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "hk-caps", children: accelerator.split("+").map((part) => /* @__PURE__ */ jsxRuntimeExports.jsx("kbd", { className: "t-kbd", children: part }, part)) });
}
function HotkeysEditor({ bindings, onChange }) {
  const [recording, setRecording] = reactExports.useState(null);
  const recordingRef = reactExports.useRef(null);
  recordingRef.current = recording;
  reactExports.useEffect(() => {
    if (!recording) return;
    const onKeyDown = (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        setRecording(null);
        return;
      }
      const acc = toAccelerator(e);
      if (!acc) {
        toast.warn("需要至少一个修饰键（Ctrl / Alt / Shift / Super）");
        return;
      }
      const target = recordingRef.current;
      setRecording(null);
      onChange(bindings.map((b) => b.id === target ? { ...b, accelerator: acc } : b));
      toast.ok(`已绑定 ${acc}`);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [recording, bindings, onChange]);
  const conflictsOf = reactExports.useCallback(
    (binding) => binding.accelerator ? bindings.filter(
      (b) => b.id !== binding.id && b.accelerator === binding.accelerator && b.enabled
    ) : [],
    [bindings]
  );
  return /* @__PURE__ */ jsxRuntimeExports.jsxs(jsxRuntimeExports.Fragment, { children: [
    /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "hk-list", children: bindings.map((b) => {
      const conflicts = conflictsOf(b);
      return /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "hk-row", children: [
        /* @__PURE__ */ jsxRuntimeExports.jsx(
          Switch,
          {
            checked: b.enabled,
            bare: true,
            label: `启用 ${COMMAND_LABELS[b.command] ?? b.command}`,
            onChange: (v) => onChange(bindings.map((x) => x.id === b.id ? { ...x, enabled: v } : x))
          }
        ),
        /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "hk-row__body", children: [
          /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "hk-row__name", children: COMMAND_LABELS[b.command] ?? b.command }),
          /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "hk-row__cmd mono", children: b.command })
        ] }),
        /* @__PURE__ */ jsxRuntimeExports.jsx(Keycaps, { accelerator: b.accelerator }),
        conflicts.length > 0 ? /* @__PURE__ */ jsxRuntimeExports.jsx(Badge, { tone: "danger", title: `与 ${conflicts.map((c) => COMMAND_LABELS[c.command] ?? c.command).join("、")} 冲突`, children: "冲突" }) : null,
        /* @__PURE__ */ jsxRuntimeExports.jsxs("label", { className: "hk-row__global", title: "全局快捷键：应用未聚焦时也生效", children: [
          /* @__PURE__ */ jsxRuntimeExports.jsx(
            "input",
            {
              type: "checkbox",
              checked: b.global,
              onChange: (e) => onChange(bindings.map((x) => x.id === b.id ? { ...x, global: e.target.checked } : x))
            }
          ),
          "全局"
        ] }),
        /* @__PURE__ */ jsxRuntimeExports.jsx(
          Button,
          {
            size: "sm",
            variant: recording === b.id ? "primary" : "outline",
            icon: recording === b.id ? "clock" : "edit",
            onClick: () => setRecording(recording === b.id ? null : b.id),
            children: recording === b.id ? "按下组合键…" : "录制"
          }
        ),
        /* @__PURE__ */ jsxRuntimeExports.jsx(
          IconButton,
          {
            icon: "close",
            label: `清除 ${COMMAND_LABELS[b.command] ?? b.command} 的绑定`,
            disabled: !b.accelerator,
            onClick: () => onChange(bindings.map((x) => x.id === b.id ? { ...x, accelerator: void 0 } : x))
          }
        )
      ] }, b.id);
    }) }),
    /* @__PURE__ */ jsxRuntimeExports.jsxs("p", { className: "t-field__hint", style: { marginTop: 12 }, children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx(Icon, { name: "info", size: 12 }),
      " 变更只落库；真正把快捷键注册到 Electron（含全局快捷键） 需要主进程的 hotkey 服务消费这份配置，这一步还没接。"
    ] })
  ] });
}
function VaultSettings() {
  const [state, setState] = reactExports.useState(null);
  const [mode, setMode] = reactExports.useState("idle");
  const [oldPw, setOldPw] = reactExports.useState("");
  const [newPw, setNewPw] = reactExports.useState("");
  const [again, setAgain] = reactExports.useState("");
  const [busy, setBusy] = reactExports.useState(false);
  const [err, setErr] = reactExports.useState(null);
  const refresh = reactExports.useCallback(async () => {
    setState(await getVaultState());
  }, []);
  reactExports.useEffect(() => {
    void refresh();
  }, [refresh]);
  const reset = () => {
    setMode("idle");
    setOldPw("");
    setNewPw("");
    setAgain("");
    setErr(null);
  };
  const submit = async () => {
    if (!state) return;
    if (mode === "unlock") {
      if (!oldPw) {
        setErr("请输入主密码");
        return;
      }
      setBusy(true);
      try {
        const res = await unlockVault(oldPw);
        const ok = res !== null && typeof res === "object" && "unlocked" in res ? Boolean(res.unlocked) : true;
        if (!ok) {
          setErr("主密码不正确");
          return;
        }
        toast.ok("本地库已解锁");
        reset();
        await refresh();
      } catch (e) {
        setErr(errorText(e));
      } finally {
        setBusy(false);
      }
      return;
    }
    if (newPw.length < 8) {
      setErr("主密码至少 8 位");
      return;
    }
    if (newPw !== again) {
      setErr("两次输入的密码不一致");
      return;
    }
    setBusy(true);
    try {
      const res = await setMasterPassword(
        newPw,
        mode === "change" ? oldPw : void 0
      );
      toast.ok(
        res.created ? "主密码已创建，本地库已解锁" : `主密码已修改（重新加密 ${res.reencrypted} 条凭据）`
      );
      reset();
      await refresh();
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  if (!state) return /* @__PURE__ */ jsxRuntimeExports.jsx("p", { className: "t-field__hint", children: "正在读取存储状态…" });
  return /* @__PURE__ */ jsxRuntimeExports.jsxs(jsxRuntimeExports.Fragment, { children: [
    /* @__PURE__ */ jsxRuntimeExports.jsx(Banner, { tone: state.unlocked ? "info" : "warn", children: state.initialized ? state.unlocked ? "本地库已解锁。本次运行期间的涉密操作不会再询问主密码。" : "本地库已锁定。保存凭据、导入 OpenSSH 配置等操作会先要求解锁。" : "还没有设置主密码。设置后，保存的 SSH 口令 / 私钥口令 / 同步口令会加密落盘。" }),
    /* @__PURE__ */ jsxRuntimeExports.jsx(Section, { right: /* @__PURE__ */ jsxRuntimeExports.jsx(Badge, { tone: state.unlocked ? "ok" : "warn", children: state.unlocked ? "已解锁" : "已锁定" }), children: "主密码" }),
    /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "t-field__hint", style: { lineHeight: 1.8 }, children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx(Icon, { name: "lock", size: 12 }),
      " 主密码用 scrypt 派生密钥，**只用于加解密本地库里的机密字段**， 不会被保存，也不会上传到任何地方。",
      /* @__PURE__ */ jsxRuntimeExports.jsx("br", {}),
      "⚠️ ",
      /* @__PURE__ */ jsxRuntimeExports.jsx("b", { children: "忘记后无法恢复" }),
      " —— 我们无法帮你重置，已加密的凭据将读不出来。"
    ] }),
    mode === "idle" ? /* @__PURE__ */ jsxRuntimeExports.jsx("div", { style: { display: "flex", gap: 8, flexWrap: "wrap", marginTop: 12 }, children: !state.initialized ? /* @__PURE__ */ jsxRuntimeExports.jsx(Button, { variant: "primary", icon: "key", onClick: () => setMode("create"), children: "创建主密码" }) : /* @__PURE__ */ jsxRuntimeExports.jsx(jsxRuntimeExports.Fragment, { children: !state.unlocked ? /* @__PURE__ */ jsxRuntimeExports.jsx(Button, { variant: "primary", icon: "lock", onClick: () => setMode("unlock"), children: "解锁" }) : /* @__PURE__ */ jsxRuntimeExports.jsxs(jsxRuntimeExports.Fragment, { children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx(Button, { variant: "outline", icon: "key", onClick: () => setMode("change"), children: "修改主密码" }),
      /* @__PURE__ */ jsxRuntimeExports.jsx(
        Button,
        {
          variant: "outline",
          icon: "lock",
          onClick: async () => {
            try {
              await lockVault();
              toast.ok("已锁定本地库");
              await refresh();
            } catch (e) {
              toast.error(`锁定失败：${errorText(e)}`);
            }
          },
          children: "立即锁定"
        }
      )
    ] }) }) }) : /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { style: { marginTop: 12, maxWidth: 420 }, children: [
      mode === "change" || mode === "unlock" ? /* @__PURE__ */ jsxRuntimeExports.jsx(Field, { label: mode === "unlock" ? "主密码" : "当前主密码", error: mode === "unlock" ? err : null, required: true, children: /* @__PURE__ */ jsxRuntimeExports.jsx(
        TextInput,
        {
          type: "password",
          autoFocus: true,
          autoComplete: "current-password",
          value: oldPw,
          onChange: (e) => {
            setOldPw(e.target.value);
            setErr(null);
          },
          onKeyDown: (e) => {
            if (e.key === "Enter" && mode === "unlock") void submit();
          }
        }
      ) }) : null,
      mode !== "unlock" ? /* @__PURE__ */ jsxRuntimeExports.jsxs(jsxRuntimeExports.Fragment, { children: [
        /* @__PURE__ */ jsxRuntimeExports.jsx(Field, { label: mode === "create" ? "新主密码" : "新主密码", error: err, required: true, hint: "至少 8 位", children: /* @__PURE__ */ jsxRuntimeExports.jsx(
          TextInput,
          {
            type: "password",
            autoFocus: mode === "create",
            autoComplete: "new-password",
            value: newPw,
            onChange: (e) => {
              setNewPw(e.target.value);
              setErr(null);
            }
          }
        ) }),
        /* @__PURE__ */ jsxRuntimeExports.jsx(Field, { label: "再输入一次", required: true, children: /* @__PURE__ */ jsxRuntimeExports.jsx(
          TextInput,
          {
            type: "password",
            autoComplete: "new-password",
            value: again,
            onChange: (e) => {
              setAgain(e.target.value);
              setErr(null);
            },
            onKeyDown: (e) => {
              if (e.key === "Enter") void submit();
            }
          }
        ) })
      ] }) : null,
      /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { style: { display: "flex", gap: 8 }, children: [
        /* @__PURE__ */ jsxRuntimeExports.jsx(Button, { variant: "ghost", onClick: reset, children: "取消" }),
        /* @__PURE__ */ jsxRuntimeExports.jsx(Button, { variant: "primary", loading: busy, onClick: () => void submit(), children: mode === "create" ? "创建" : mode === "change" ? "修改" : "解锁" })
      ] })
    ] })
  ] });
}
const SETTINGS_SECTIONS = [
  "app",
  "terminal",
  "highlights",
  "hotkeys",
  "completion",
  "ai",
  "transfer",
  "sync",
  "vault"
];
function useSettings() {
  const [settings, setSettings] = reactExports.useState(null);
  const [error, setError] = reactExports.useState(null);
  const [loading, setLoading] = reactExports.useState(true);
  const reload = reactExports.useCallback(async () => {
    setLoading(true);
    try {
      const all = await invoke(
        "settings",
        "getAll",
        {}
      );
      setSettings(all);
      setError(null);
      applyTheme(all.app.theme);
      applyAppearance(all);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setLoading(false);
    }
  }, []);
  reactExports.useEffect(() => {
    void reload();
  }, [reload]);
  const update = reactExports.useCallback(
    async (path, value) => {
      try {
        const next = await invoke(
          "settings",
          "set",
          { path, value }
        );
        setSettings(next);
        if (path === "app.theme") applyTheme(next.app.theme);
        if (path.startsWith("app.appearance.")) applyAppearance(next);
        if (path.startsWith("terminal.")) applyTerminalSettings(next.terminal);
      } catch (err) {
        toast.error(`设置保存失败：${errorText(err)}`);
        void reload();
      }
    },
    [reload]
  );
  const resetSection = reactExports.useCallback(async (section) => {
    try {
      const next = await invoke(
        "settings",
        "reset",
        { section }
      );
      setSettings(next);
      applyTheme(next.app.theme);
      applyAppearance(next);
      applyTerminalSettings(next.terminal);
      toast.ok(`「${SECTION_META[section].label}」已恢复默认值`);
    } catch (err) {
      toast.error(`重置失败：${errorText(err)}`);
    }
  }, []);
  return { settings, error, loading, update, resetSection, reload };
}
function useDebounced(value, commit, delay = 450) {
  const [draft, setDraft] = reactExports.useState(value);
  const dirty = reactExports.useRef(false);
  const timer = reactExports.useRef(void 0);
  reactExports.useEffect(() => {
    if (!dirty.current) setDraft(value);
  }, [value]);
  reactExports.useEffect(() => () => window.clearTimeout(timer.current), []);
  const onChange = reactExports.useCallback(
    (v) => {
      setDraft(v);
      dirty.current = true;
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => {
        dirty.current = false;
        commit(v);
      }, delay);
    },
    [commit, delay]
  );
  return [draft, onChange];
}
function FieldControl({
  def,
  value,
  onChange
}) {
  const str = value === void 0 || value === null ? "" : String(value);
  const [text, setText] = useDebounced(str, (v) => {
    if (def.kind === "number") {
      const n = Number(v);
      onChange(Number.isFinite(n) && v.trim() !== "" ? n : 0);
    } else {
      onChange(v);
    }
  });
  switch (def.kind) {
    case "switch":
      return /* @__PURE__ */ jsxRuntimeExports.jsx(Switch, { checked: value === true, onChange: (v) => onChange(v), label: def.label });
    case "select":
      return /* @__PURE__ */ jsxRuntimeExports.jsx(Select, { value: str, options: def.options ?? [], onChange: (e) => onChange(e.target.value) });
    case "number":
      return /* @__PURE__ */ jsxRuntimeExports.jsx(
        TextInput,
        {
          type: "number",
          mono: true,
          value: text,
          min: def.min,
          max: def.max,
          step: def.step,
          onChange: (e) => setText(e.target.value)
        }
      );
    default:
      return /* @__PURE__ */ jsxRuntimeExports.jsx(TextInput, { value: text, mono: def.path.includes("font"), onChange: (e) => setText(e.target.value) });
  }
}
function FieldsGrid({
  defs,
  settings,
  update
}) {
  return /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "t-grid t-grid--2 settings-grid", children: defs.map((def) => {
    const value = readPath(settings, def.path);
    if (def.kind === "switch") {
      return /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "settings-switch-row", children: [
        /* @__PURE__ */ jsxRuntimeExports.jsx(FieldControl, { def, value, onChange: (v) => update(def.path, v) }),
        /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "t-field__hint", children: [
          def.hint ?? def.path,
          def.caution ? /* @__PURE__ */ jsxRuntimeExports.jsx(Badge, { tone: "warn", children: "谨慎" }) : null
        ] })
      ] }, def.path);
    }
    return /* @__PURE__ */ jsxRuntimeExports.jsx(
      Field,
      {
        label: def.label,
        hint: def.hint,
        className: def.wide ? "t-grid__span2" : void 0,
        aside: def.caution ? /* @__PURE__ */ jsxRuntimeExports.jsx(Badge, { tone: "warn", children: "谨慎" }) : void 0,
        children: /* @__PURE__ */ jsxRuntimeExports.jsx(FieldControl, { def, value, onChange: (v) => update(def.path, v) })
      },
      def.path
    );
  }) });
}
function ReadonlyRows({ rows }) {
  return /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "kv", style: { gridTemplateColumns: "160px minmax(0, 1fr)" }, children: rows.map(([k, v]) => /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { style: { display: "contents" }, children: [
    /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "kv__k", children: k }),
    /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "kv__v", children: v })
  ] }, k)) });
}
function DataLocationPanel() {
  const [paths, setPaths] = reactExports.useState(null);
  const pathStyle = { wordBreak: "break-all", userSelect: "text" };
  reactExports.useEffect(() => {
    void (async () => {
      try {
        const p = await invoke("app", "getPaths", {});
        setPaths(p);
      } catch {
      }
    })();
  }, []);
  return /* @__PURE__ */ jsxRuntimeExports.jsxs(jsxRuntimeExports.Fragment, { children: [
    /* @__PURE__ */ jsxRuntimeExports.jsx(Section, { children: "存储位置" }),
    /* @__PURE__ */ jsxRuntimeExports.jsx(
      ReadonlyRows,
      {
        rows: [
          ["数据目录", /* @__PURE__ */ jsxRuntimeExports.jsx("code", { style: pathStyle, children: paths?.userData ?? "读取中…" }, "dir")],
          ["数据库", /* @__PURE__ */ jsxRuntimeExports.jsx("code", { style: pathStyle, children: paths?.dbFile ?? "—" }, "db")],
          ["备份", /* @__PURE__ */ jsxRuntimeExports.jsx("code", { style: pathStyle, children: paths?.backupDir ?? "—" }, "bak")]
        ]
      }
    ),
    /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "settings-actions", children: /* @__PURE__ */ jsxRuntimeExports.jsx(
      Button,
      {
        size: "sm",
        variant: "ghost",
        icon: "folder",
        disabled: !paths,
        onClick: () => {
          if (!paths) return;
          void invoke("app", "openPath", {
            path: paths.userData
          }).catch(() => toast.error("无法打开数据目录"));
        },
        children: "打开数据目录"
      }
    ) }),
    /* @__PURE__ */ jsxRuntimeExports.jsx("p", { className: "t-field__hint", children: "升级只会替换程序文件，不会动这个目录；库、笔记与备份都在这里，卸载时也不会自动删除。" })
  ] });
}
function SettingsSidebar() {
  const section = useStoreShallow((s) => ({ section: s.settingsSection })).section;
  return /* @__PURE__ */ jsxRuntimeExports.jsxs("aside", { className: "panel", "aria-label": "设置", children: [
    /* @__PURE__ */ jsxRuntimeExports.jsx("header", { className: "panel-header", children: /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "panel-title", children: "设置" }) }),
    /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "panel-body", children: /* @__PURE__ */ jsxRuntimeExports.jsx("nav", { className: "settings-nav-list", children: SETTINGS_SECTIONS.map((id) => /* @__PURE__ */ jsxRuntimeExports.jsxs(
      "button",
      {
        type: "button",
        className: `settings-nav${id === section ? " settings-nav--active" : ""}`,
        "aria-current": id === section || void 0,
        onClick: () => actions.setSettingsSection(id),
        children: [
          /* @__PURE__ */ jsxRuntimeExports.jsx(Icon, { name: SECTION_META[id].icon, size: 14 }),
          /* @__PURE__ */ jsxRuntimeExports.jsxs("span", { className: "settings-nav__body", children: [
            /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "settings-nav__title", children: SECTION_META[id].label }),
            /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "settings-nav__desc", children: SECTION_META[id].blurb })
          ] })
        ]
      },
      id
    )) }) })
  ] });
}
function SettingsView() {
  const section = useStoreShallow((s) => ({ section: s.settingsSection })).section;
  const { settings, error, loading, update, resetSection, reload } = useSettings();
  const backend = useStoreShallow((s) => ({ ready: s.backendReady, message: s.backendError }));
  const meta = SECTION_META[section];
  const defs = reactExports.useMemo(
    () => section === "highlights" || section === "hotkeys" || section === "vault" ? [] : SETTINGS_FIELDS[section],
    [section]
  );
  if (loading && !settings) {
    return /* @__PURE__ */ jsxRuntimeExports.jsx("main", { className: "content", "aria-label": "设置", children: /* @__PURE__ */ jsxRuntimeExports.jsx(Loading, { text: "正在读取设置…" }) });
  }
  if (error && !settings) {
    return /* @__PURE__ */ jsxRuntimeExports.jsx("main", { className: "content", "aria-label": "设置", children: /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "content-scroll", style: { padding: 18 }, children: /* @__PURE__ */ jsxRuntimeExports.jsxs(
      Banner,
      {
        tone: "error",
        actions: /* @__PURE__ */ jsxRuntimeExports.jsx(Button, { size: "sm", onClick: () => void reload(), children: "重试" }),
        children: [
          "无法读取设置：",
          error
        ]
      }
    ) }) });
  }
  if (!settings) return /* @__PURE__ */ jsxRuntimeExports.jsx("main", { className: "content" });
  return /* @__PURE__ */ jsxRuntimeExports.jsxs("main", { className: "content", "aria-label": "设置", children: [
    /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "t-toolbar", children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx(Icon, { name: meta.icon, size: 15 }),
      /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "panel-title", children: meta.label }),
      /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "term-toolbar__meta", children: meta.blurb }),
      /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "t-toolbar__spacer" }),
      /* @__PURE__ */ jsxRuntimeExports.jsx(Badge, { tone: backend.ready ? "ok" : "warn", children: backend.ready ? "已持久化" : "存储不可用" }),
      /* @__PURE__ */ jsxRuntimeExports.jsx(IconButton, { icon: "refresh", label: "重新读取", onClick: () => void reload() }),
      /* @__PURE__ */ jsxRuntimeExports.jsx(Button, { size: "sm", variant: "ghost", icon: "chevron-left", onClick: () => void resetSection(section), children: "本页恢复默认" })
    ] }),
    /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "content-scroll settings-body", children: [
      section === "vault" ? /* @__PURE__ */ jsxRuntimeExports.jsx(VaultSettings, {}) : section === "highlights" ? /* @__PURE__ */ jsxRuntimeExports.jsx(
        HighlightsEditor,
        {
          rules: settings.highlights,
          onChange: (rules) => {
            applyHighlightRules(rules);
            void update("highlights", rules);
          }
        }
      ) : section === "hotkeys" ? /* @__PURE__ */ jsxRuntimeExports.jsx(HotkeysEditor, { bindings: settings.hotkeys, onChange: (list) => void update("hotkeys", list) }) : /* @__PURE__ */ jsxRuntimeExports.jsx(FieldsGrid, { defs, settings, update: (p, v) => void update(p, v) }),
      section === "app" ? /* @__PURE__ */ jsxRuntimeExports.jsx(DataLocationPanel, {}) : null,
      section === "ai" ? /* @__PURE__ */ jsxRuntimeExports.jsxs(jsxRuntimeExports.Fragment, { children: [
        /* @__PURE__ */ jsxRuntimeExports.jsx(Section, { children: "供应商与名单（只读）" }),
        /* @__PURE__ */ jsxRuntimeExports.jsx(
          ReadonlyRows,
          {
            rows: [
              ["供应商", summarizeAi(settings)],
              [
                "只读白名单",
                settings.ai.riskPolicy.readOnlyAllowlist.length === 0 ? "使用内置默认名单" : `${settings.ai.riskPolicy.readOnlyAllowlist.length} 条`
              ],
              [
                "危险黑名单",
                settings.ai.riskPolicy.dangerousDenylist.length === 0 ? "使用内置默认名单" : `${settings.ai.riskPolicy.dangerousDenylist.length} 条`
              ]
            ]
          }
        ),
        /* @__PURE__ */ jsxRuntimeExports.jsx("p", { className: "t-field__hint", children: "供应商配置（endpoint / API key / 模型）需要单独表单，且密钥只存本机；这一版先只读展示。" })
      ] }) : null,
      section === "sync" ? /* @__PURE__ */ jsxRuntimeExports.jsxs(jsxRuntimeExports.Fragment, { children: [
        /* @__PURE__ */ jsxRuntimeExports.jsx(Section, { children: "零知识说明" }),
        /* @__PURE__ */ jsxRuntimeExports.jsx("p", { className: "t-field__hint", children: "服务端只保存密文块，密钥不离开本机。代价是服务端无法索引你的数据、忘记主密码也无法找回—— 这是设计取舍，不是缺陷。" }),
        /* @__PURE__ */ jsxRuntimeExports.jsx(
          ReadonlyRows,
          {
            rows: [
              ["令牌", settings.sync.token ? "已保存（仅本机）" : "未配置"],
              ["后端", settings.sync.endpoint || "未设置"]
            ]
          }
        ),
        /* @__PURE__ */ jsxRuntimeExports.jsx(Section, { children: "传输与服务端身份" }),
        /* @__PURE__ */ jsxRuntimeExports.jsx(ServerIdentityPanel, {})
      ] }) : null
    ] })
  ] });
}
export {
  SETTINGS_SECTIONS,
  SettingsSidebar,
  SettingsView as default
};
