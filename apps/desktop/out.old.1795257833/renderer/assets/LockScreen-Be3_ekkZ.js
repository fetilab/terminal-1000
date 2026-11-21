import { r as reactExports, g as getVaultState, b as setMasterPassword, d as unlockVault, e as errorText, j as jsxRuntimeExports, I as Icon, f as Banner, F as Field, T as TextInput, h as Button, B as Badge } from "./index-CwfghMy4.js";
function formatIdle(seconds) {
  if (seconds === void 0) return "";
  if (seconds < 60) return `（已空闲 ${seconds} 秒）`;
  const m = Math.floor(seconds / 60);
  return `（已空闲 ${m} 分钟）`;
}
function LockScreen({ reason, idleSeconds, onUnlocked }) {
  const [pw, setPw] = reactExports.useState("");
  const [pw2, setPw2] = reactExports.useState("");
  const [err, setErr] = reactExports.useState(null);
  const [busy, setBusy] = reactExports.useState(false);
  const [state, setState] = reactExports.useState(null);
  const inputRef = reactExports.useRef(null);
  reactExports.useEffect(() => {
    void getVaultState().then(setState);
    inputRef.current?.focus();
  }, []);
  const creating = state !== null && !state.initialized;
  const submit = reactExports.useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      if (creating) {
        if (pw.length < 8) {
          setErr("主密码至少 8 位");
          return;
        }
        if (pw !== pw2) {
          setErr("两次输入的密码不一致");
          return;
        }
        await setMasterPassword(pw);
      } else {
        if (!pw) {
          setErr("请输入主密码");
          return;
        }
        const res = await unlockVault(pw);
        const ok = res !== null && typeof res === "object" && "unlocked" in res ? Boolean(res.unlocked) : true;
        if (!ok) {
          setPw("");
          setErr("主密码不正确");
          inputRef.current?.focus();
          return;
        }
      }
      onUnlocked();
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  }, [busy, creating, pw, pw2, onUnlocked]);
  return /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "lockscreen", role: "dialog", "aria-modal": "true", "aria-label": "已锁定", children: /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "lockscreen__card", children: [
    /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "lockscreen__brand", children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "lockscreen__logo", children: /* @__PURE__ */ jsxRuntimeExports.jsx(Icon, { name: "lock", size: 22 }) }),
      /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { children: [
        /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "lockscreen__title", children: "已锁定" }),
        /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "lockscreen__sub", children: reason === "idle" ? `因空闲自动锁定${formatIdle(idleSeconds)}` : "已手动锁定" })
      ] })
    ] }),
    /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "lockscreen__hint", children: "输入主密码解锁。本地库中的连接凭据已加密，解锁后本次运行期间不再询问。" }),
    creating ? /* @__PURE__ */ jsxRuntimeExports.jsxs(Banner, { tone: "warn", children: [
      "还没有设置主密码，先创建一个 —— 用于加密保存的连接凭据。",
      /* @__PURE__ */ jsxRuntimeExports.jsx("b", { children: "忘记后无法恢复。" })
    ] }) : null,
    /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "lockscreen__form", children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx(Field, { label: "主密码", error: err, required: true, children: /* @__PURE__ */ jsxRuntimeExports.jsx(
        TextInput,
        {
          ref: inputRef,
          type: "password",
          autoComplete: "current-password",
          value: pw,
          placeholder: creating ? "至少 8 位" : "",
          onChange: (e) => {
            setPw(e.target.value);
            setErr(null);
          },
          onKeyDown: (e) => {
            if (e.key === "Enter" && !creating) void submit();
          }
        }
      ) }),
      creating ? /* @__PURE__ */ jsxRuntimeExports.jsx(Field, { label: "再输入一次", required: true, children: /* @__PURE__ */ jsxRuntimeExports.jsx(
        TextInput,
        {
          type: "password",
          autoComplete: "new-password",
          value: pw2,
          onChange: (e) => {
            setPw2(e.target.value);
            setErr(null);
          },
          onKeyDown: (e) => {
            if (e.key === "Enter") void submit();
          }
        }
      ) }) : null,
      /* @__PURE__ */ jsxRuntimeExports.jsx(Button, { variant: "primary", loading: busy, onClick: () => void submit(), children: creating ? "创建并解锁" : "解锁" })
    ] }),
    /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "lockscreen__foot", children: [
      /* @__PURE__ */ jsxRuntimeExports.jsxs(Badge, { tone: "outline", children: [
        /* @__PURE__ */ jsxRuntimeExports.jsx(Icon, { name: "shield", size: 11 }),
        " scrypt 派生密钥"
      ] }),
      /* @__PURE__ */ jsxRuntimeExports.jsx("span", { children: "主密码不会被保存，也不会离开这台机器" })
    ] })
  ] }) });
}
export {
  LockScreen,
  LockScreen as default
};
