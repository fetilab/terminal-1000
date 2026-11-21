import { r as reactExports, i as invoke, e as errorText, U as subscribe, t as toast, j as jsxRuntimeExports, L as Loading, f as Banner, h as Button, ai as Section, I as Icon, B as Badge, F as Field, T as TextInput, G as Switch, y as formatRelativeTime, J as EmptyState, a as actions, a0 as Events, aL as IpcCallError } from "./index-C6luzS_t.js";
import { c as classifySyncError, S as ServerIdentityPanel } from "./ServerIdentityPanel-Bl4FrydH.js";
function SyncPanel() {
  const [status, setStatus] = reactExports.useState(null);
  const [loading, setLoading] = reactExports.useState(true);
  const [error, setError] = reactExports.useState(null);
  const [progress, setProgress] = reactExports.useState(null);
  const [conflict, setConflict] = reactExports.useState(null);
  const [identityFingerprint, setIdentityFingerprint] = reactExports.useState(null);
  const [identityError, setIdentityError] = reactExports.useState(null);
  const statusRef = reactExports.useRef(null);
  statusRef.current = status;
  const [endpoint, setEndpoint] = reactExports.useState("");
  const [username, setUsername] = reactExports.useState("");
  const [password, setPassword] = reactExports.useState("");
  const [passphrase, setPassphrase] = reactExports.useState("");
  const [register, setRegister] = reactExports.useState(false);
  const [busy, setBusy] = reactExports.useState(false);
  const refresh = reactExports.useCallback(async () => {
    try {
      const res = await invoke("sync", "status", {});
      setStatus(res);
      setEndpoint((prev) => prev || res.endpoint || "");
      setError(null);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setLoading(false);
    }
  }, []);
  reactExports.useEffect(() => {
    void refresh();
    const offState = subscribe(Events.SYNC_STATE, () => void refresh());
    const offProgress = subscribe(Events.SYNC_PROGRESS, (p) => {
      setProgress({ phase: p.phase, done: p.done, total: p.total });
    });
    return () => {
      offState();
      offProgress();
    };
  }, [refresh]);
  const doLogin = async () => {
    if (!endpoint.trim() || !username.trim() || !password) {
      toast.warn("后端地址、用户名、登录口令都要填");
      return;
    }
    setBusy(true);
    try {
      const res = await invoke("sync", "login", {
        endpoint: endpoint.trim(),
        username: username.trim(),
        password,
        register,
        // 同步口令单独传；它就是解密云端数据的那把钥匙
        ...passphrase ? { passphrase } : {}
      });
      setPassword("");
      setPassphrase("");
      toast.ok(
        `已登录 ${res.username}${res.hasPassphrase ? "" : "；尚未设置同步口令，push 前需要先设置"}`
      );
      await refresh();
    } catch (err) {
      handleSyncFailure(err, "登录");
    } finally {
      setBusy(false);
    }
  };
  const handleSyncFailure = reactExports.useCallback((err, what) => {
    const info = classifySyncError(err, statusRef.current?.pinnedFingerprint ?? null);
    if (info.kind === "untrusted-server") {
      setIdentityFingerprint(info.fingerprint ?? "");
      setIdentityError(info);
      toast.warn("该同步服务端身份尚未确认，请先核对指纹");
      return;
    }
    if (info.kind === "identity-changed") {
      setIdentityFingerprint("");
      setIdentityError(info);
      toast.error("服务端身份与已记录的不一致，可能是中间人攻击，请先核对");
      return;
    }
    if (info.kind === "plaintext-not-allowed") {
      toast.error("明文传输被拒绝：请在设置里把传输方式改为 TSC/1");
      return;
    }
    toast.error(`${what}失败：${errorText(err)}`);
  }, []);
  const doPush = async (force = false) => {
    setBusy(true);
    setConflict(null);
    try {
      await invoke("sync", "push", force ? { force } : {});
      toast.ok("已推送到云端");
      await refresh();
    } catch (err) {
      if (err instanceof IpcCallError && err.code === "CONFLICT") {
        setConflict(err.message);
      } else if (err instanceof IpcCallError && (err.code === "BAD_REQUEST" || err.code === "UNAUTHORIZED")) {
        toast.warn(err.message);
        setConflict(null);
      } else {
        handleSyncFailure(err, "推送");
      }
    } finally {
      setBusy(false);
    }
  };
  const doPull = async () => {
    setBusy(true);
    try {
      await invoke("sync", "pull", { mode: "merge" });
      toast.ok("已从云端拉取并合并");
      await refresh();
    } catch (err) {
      handleSyncFailure(err, "拉取");
    } finally {
      setBusy(false);
    }
  };
  const resolve = async (keep) => {
    setBusy(true);
    try {
      await invoke("sync", "resolveConflict", {
        keep
      });
      toast.ok(keep === "local" ? "已保留本地并覆盖云端" : "已采用远端并覆盖本地");
      setConflict(null);
      await refresh();
    } catch (err) {
      toast.error(`处置失败：${errorText(err)}`);
    } finally {
      setBusy(false);
    }
  };
  if (loading && !status) return /* @__PURE__ */ jsxRuntimeExports.jsx(Loading, { text: "读取同步状态…" });
  if (error && !status) {
    return /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "svc-body", children: /* @__PURE__ */ jsxRuntimeExports.jsx(Banner, { tone: "error", actions: /* @__PURE__ */ jsxRuntimeExports.jsx(Button, { size: "sm", onClick: () => void refresh(), children: "重试" }), children: error }) });
  }
  if (!status) return /* @__PURE__ */ jsxRuntimeExports.jsx("div", {});
  return /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "content-scroll svc-body", children: [
    /* @__PURE__ */ jsxRuntimeExports.jsx(Section, { children: "两个口令是两回事" }),
    /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "svc-passwords", children: [
      /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "svc-pass", children: [
        /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "svc-pass__head", children: [
          /* @__PURE__ */ jsxRuntimeExports.jsx(Icon, { name: "user", size: 14 }),
          "登录口令"
        ] }),
        /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "svc-pass__what", children: "证明「你是谁」。只用于登录自建同步后端，服务端保存的是它的哈希。" }),
        /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "svc-pass__warn", children: "忘了可以找服务端重置，不影响已有数据。" })
      ] }),
      /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "svc-pass svc-pass--key", children: [
        /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "svc-pass__head", children: [
          /* @__PURE__ */ jsxRuntimeExports.jsx(Icon, { name: "key", size: 14 }),
          "同步口令（仓库密码）"
        ] }),
        /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "svc-pass__what", children: [
          /* @__PURE__ */ jsxRuntimeExports.jsx("b", { children: "新设备用这个口令解密云端数据。" }),
          "数据在本机加密后才上传，服务端只有密文。"
        ] }),
        /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "svc-pass__warn", children: [
          "它只存在本机、服务端拿不到。",
          /* @__PURE__ */ jsxRuntimeExports.jsx("b", { children: "一旦忘记，云端数据无法解密" }),
          "——这是零知识的代价，不是缺陷。"
        ] })
      ] })
    ] }),
    /* @__PURE__ */ jsxRuntimeExports.jsx(Section, { children: "账号与后端" }),
    status.loggedIn ? /* @__PURE__ */ jsxRuntimeExports.jsx(jsxRuntimeExports.Fragment, { children: /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { style: { display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }, children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx(Badge, { tone: "ok", children: "已登录" }),
      /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "mono", style: { fontSize: 12 }, children: status.endpoint || "（未设置地址）" }),
      /* @__PURE__ */ jsxRuntimeExports.jsx("div", { style: { flex: 1 } }),
      /* @__PURE__ */ jsxRuntimeExports.jsx(
        Button,
        {
          size: "sm",
          variant: "outline",
          onClick: () => {
            void invoke("sync", "logout", {}).then(() => {
              toast.ok("已退出登录");
              return refresh();
            }).catch((err) => toast.error(`退出失败：${errorText(err)}`));
          },
          children: "退出登录"
        }
      )
    ] }) }) : /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "t-grid t-grid--2", style: { marginBottom: 8 }, children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx(Field, { label: "后端地址", required: true, className: "t-grid__span2", children: /* @__PURE__ */ jsxRuntimeExports.jsx(
        TextInput,
        {
          value: endpoint,
          mono: true,
          placeholder: "https://sync.example.com",
          onChange: (e) => setEndpoint(e.target.value)
        }
      ) }),
      /* @__PURE__ */ jsxRuntimeExports.jsx(Field, { label: "用户名", required: true, children: /* @__PURE__ */ jsxRuntimeExports.jsx(TextInput, { value: username, onChange: (e) => setUsername(e.target.value) }) }),
      /* @__PURE__ */ jsxRuntimeExports.jsx(Field, { label: "登录口令", required: true, hint: "证明身份用，不是加密口令", children: /* @__PURE__ */ jsxRuntimeExports.jsx(
        TextInput,
        {
          type: "password",
          value: password,
          autoComplete: "off",
          onChange: (e) => setPassword(e.target.value)
        }
      ) }),
      /* @__PURE__ */ jsxRuntimeExports.jsx(
        Field,
        {
          label: "同步口令（仓库密码）",
          className: "t-grid__span2",
          hint: "至少 8 位。它就是加密/解密云端数据的钥匙；首次可在此设置，之后在新设备上必须填同一个才能解密。",
          children: /* @__PURE__ */ jsxRuntimeExports.jsx(
            TextInput,
            {
              type: "password",
              value: passphrase,
              autoComplete: "off",
              placeholder: "留空表示沿用本机已保存的口令",
              onChange: (e) => setPassphrase(e.target.value)
            }
          )
        }
      ),
      /* @__PURE__ */ jsxRuntimeExports.jsx("div", { style: { display: "flex", alignItems: "center", gap: 18 }, children: /* @__PURE__ */ jsxRuntimeExports.jsx(Switch, { checked: register, onChange: setRegister, label: "没有账号，先注册" }) }),
      /* @__PURE__ */ jsxRuntimeExports.jsx("div", { style: { display: "flex", justifyContent: "flex-end" }, children: /* @__PURE__ */ jsxRuntimeExports.jsx(Button, { variant: "primary", icon: "cloud", loading: busy, onClick: () => void doLogin(), children: register ? "注册并登录" : "登录" }) })
    ] }),
    conflict ? /* @__PURE__ */ jsxRuntimeExports.jsx("div", { style: { margin: "14px 0" }, children: /* @__PURE__ */ jsxRuntimeExports.jsxs(
      Banner,
      {
        tone: "warn",
        actions: /* @__PURE__ */ jsxRuntimeExports.jsxs(jsxRuntimeExports.Fragment, { children: [
          /* @__PURE__ */ jsxRuntimeExports.jsx(Button, { size: "sm", variant: "outline", loading: busy, onClick: () => void resolve("local"), children: "保留本地" }),
          /* @__PURE__ */ jsxRuntimeExports.jsx(Button, { size: "sm", variant: "outline", loading: busy, onClick: () => void resolve("remote"), children: "采用远端" })
        ] }),
        children: [
          "云端与本机都有改动，自动合并被拒绝：",
          conflict,
          /* @__PURE__ */ jsxRuntimeExports.jsx("br", {}),
          "选择「保留本地」会用本机数据覆盖云端；「采用远端」会用云端数据覆盖本机。"
        ]
      }
    ) }) : null,
    identityFingerprint !== null || status && !status.pinned ? /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { style: { marginBottom: 14 }, children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx(Section, { children: "服务端身份确认" }),
      /* @__PURE__ */ jsxRuntimeExports.jsx(
        ServerIdentityPanel,
        {
          initialFingerprint: identityFingerprint ?? void 0,
          initialError: identityError ?? void 0,
          onChanged: () => {
            setIdentityFingerprint(null);
            setIdentityError(null);
            void refresh();
          }
        }
      )
    ] }) : null,
    /* @__PURE__ */ jsxRuntimeExports.jsx(Section, { children: "同步" }),
    /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { style: { display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 12 }, children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx(Badge, { tone: status.state === "error" ? "danger" : status.state === "syncing" ? "accent" : "default", children: status.state }),
      /* @__PURE__ */ jsxRuntimeExports.jsxs("span", { className: "metric__sub", children: [
        "上次同步 ",
        status.lastSyncAt ? formatRelativeTime(status.lastSyncAt) : "从未",
        status.lastVersion === null ? "" : ` · 远端版本 ${status.lastVersion}`
      ] }),
      /* @__PURE__ */ jsxRuntimeExports.jsx("div", { style: { flex: 1 } }),
      /* @__PURE__ */ jsxRuntimeExports.jsx(
        Button,
        {
          size: "sm",
          variant: "outline",
          icon: "upload",
          loading: busy,
          disabled: !status.loggedIn,
          onClick: () => void doPush(),
          children: "推送"
        }
      ),
      /* @__PURE__ */ jsxRuntimeExports.jsx(
        Button,
        {
          size: "sm",
          variant: "outline",
          icon: "download",
          loading: busy,
          disabled: !status.loggedIn,
          onClick: () => void doPull(),
          children: "拉取"
        }
      ),
      /* @__PURE__ */ jsxRuntimeExports.jsx(Button, { size: "sm", variant: "ghost", icon: "refresh", onClick: () => void refresh(), children: "刷新状态" })
    ] }),
    progress ? /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "metric", children: [
      /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "metric__top", children: [
        /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "metric__label", children: progress.phase === "push" ? "上传中" : "下载中" }),
        /* @__PURE__ */ jsxRuntimeExports.jsxs("span", { className: "metric__value", children: [
          progress.done,
          "/",
          progress.total
        ] })
      ] }),
      /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "bar", children: /* @__PURE__ */ jsxRuntimeExports.jsx(
        "div",
        {
          className: "bar__fill",
          style: { width: `${progress.total > 0 ? progress.done / progress.total * 100 : 0}%` }
        }
      ) })
    ] }) : null,
    status.lastError ? /* @__PURE__ */ jsxRuntimeExports.jsx("div", { style: { marginTop: 12 }, children: /* @__PURE__ */ jsxRuntimeExports.jsxs(Banner, { tone: "warn", children: [
      "上次错误：",
      status.lastError
    ] }) }) : null,
    !status.loggedIn ? /* @__PURE__ */ jsxRuntimeExports.jsx("div", { style: { marginTop: 16 }, children: /* @__PURE__ */ jsxRuntimeExports.jsx(
      EmptyState,
      {
        icon: "cloud",
        title: "还没有连接同步后端",
        text: "同步是可选的：全部数据本来就在本机 SQLite 里。启用后，服务端只保存密文、无法索引你的内容。"
      }
    ) }) : /* @__PURE__ */ jsxRuntimeExports.jsx("div", { style: { marginTop: 14 }, children: /* @__PURE__ */ jsxRuntimeExports.jsx(Button, { size: "sm", variant: "ghost", icon: "settings", onClick: () => actions.setView("settings"), children: "去设置里调整自动同步与同步范围" }) })
  ] });
}
export {
  SyncPanel as default
};
