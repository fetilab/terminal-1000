import { e as errorText, r as reactExports, i as invoke, j as jsxRuntimeExports, L as Loading, B as Badge, f as Banner, h as Button, I as Icon, t as toast } from "./index-C6luzS_t.js";
function classifySyncError(err, pinnedFingerprint) {
  const message = errorText(err);
  const e = err;
  const detail = typeof e?.detail === "object" && e.detail !== null ? e.detail : {};
  if (detail.code === "PLAINTEXT_NOT_ALLOWED") return { kind: "plaintext-not-allowed", message };
  if (detail.code === "UNTRUSTED_SERVER") {
    const offered = detail.fingerprint?.replace(/\s+/g, "").toLowerCase();
    const pinned = pinnedFingerprint?.replace(/\s+/g, "").toLowerCase();
    if (offered && pinned && offered !== pinned) {
      return { kind: "identity-changed", message, expected: pinned, actual: offered };
    }
    return {
      kind: "untrusted-server",
      message,
      ...detail.fingerprint === void 0 ? {} : { fingerprint: detail.fingerprint }
    };
  }
  if (detail.code === "SERVER_IDENTITY_CHANGED") {
    return {
      kind: "identity-changed",
      message,
      ...detail.expected === void 0 ? {} : { expected: detail.expected },
      ...detail.actual === void 0 ? {} : { actual: detail.actual }
    };
  }
  return { kind: "other", message };
}
function formatFingerprint(raw) {
  const hex = raw.replace(/\s+/g, "");
  return (hex.match(/.{1,4}/g) ?? []).join(" ");
}
function isLoopbackEndpoint(endpoint) {
  if (!endpoint) return false;
  try {
    const host = new URL(endpoint.includes("://") ? endpoint : `http://${endpoint}`).hostname;
    return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
  } catch {
    return false;
  }
}
function ServerIdentityPanel({
  initialFingerprint,
  initialError,
  onChanged
}) {
  const [status, setStatus] = reactExports.useState(null);
  const [probed, setProbed] = reactExports.useState(null);
  const [busy, setBusy] = reactExports.useState(null);
  const [warning, setWarning] = reactExports.useState(null);
  const load = reactExports.useCallback(async () => {
    try {
      const res = await invoke(
        "sync",
        "status",
        {}
      );
      setStatus(res);
    } catch (err) {
      setWarning(classifySyncError(err));
    }
  }, []);
  reactExports.useEffect(() => {
    void load();
  }, [load]);
  reactExports.useEffect(() => {
    if (initialFingerprint) {
      setProbed({ fingerprint: initialFingerprint, publicKey: "" });
    }
  }, [initialFingerprint]);
  reactExports.useEffect(() => {
    if (initialError && initialError.kind !== "other") setWarning(initialError);
  }, [initialError]);
  const setTransport = async (transport2) => {
    setBusy("transport");
    try {
      await invoke("sync", "setTransport", {
        transport: transport2
      });
      await load();
      onChanged?.();
    } catch (err) {
      setWarning(classifySyncError(err));
    } finally {
      setBusy(null);
    }
  };
  const probe = async () => {
    setBusy("probe");
    setWarning(null);
    try {
      const res = await invoke("sync", "inspectServer", {});
      setProbed(res);
    } catch (err) {
      setWarning(classifySyncError(err));
    } finally {
      setBusy(null);
    }
  };
  const trust = async () => {
    if (!probed?.publicKey) {
      await probe();
      return;
    }
    setBusy("trust");
    try {
      await invoke("sync", "trustServer", {
        fingerprint: probed.fingerprint,
        publicKey: probed.publicKey
      });
      toast.ok("已信任该服务端身份");
      setProbed(null);
      setWarning(null);
      await load();
      onChanged?.();
    } catch (err) {
      setWarning(classifySyncError(err));
    } finally {
      setBusy(null);
    }
  };
  const forget = async () => {
    setBusy("forget");
    try {
      await invoke("sync", "forgetServer", {});
      toast.ok("已清除钉扎，下次连接需要重新确认身份");
      setProbed(null);
      await load();
      onChanged?.();
    } catch (err) {
      setWarning(classifySyncError(err));
    } finally {
      setBusy(null);
    }
  };
  if (!status) return /* @__PURE__ */ jsxRuntimeExports.jsx(Loading, { text: "读取同步状态…" });
  const transport = status.transport;
  return /* @__PURE__ */ jsxRuntimeExports.jsxs(jsxRuntimeExports.Fragment, { children: [
    /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "synctransport-summary", children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "synctransport-summary__label", children: "当前传输方式" }),
      transport === "tsc1" ? /* @__PURE__ */ jsxRuntimeExports.jsx(Badge, { tone: "ok", children: "TSC/1 加密通道" }) : /* @__PURE__ */ jsxRuntimeExports.jsx(Badge, { tone: "warn", children: "明文 HTTP（仅回环）" })
    ] }),
    transport === "http" && !isLoopbackEndpoint(status.endpoint) ? /* @__PURE__ */ jsxRuntimeExports.jsxs(
      Banner,
      {
        tone: "error",
        actions: /* @__PURE__ */ jsxRuntimeExports.jsx(
          Button,
          {
            size: "sm",
            variant: "primary",
            loading: busy === "transport",
            onClick: () => void setTransport("tsc1"),
            children: "改为 TSC/1"
          }
        ),
        children: [
          "后端地址 ",
          /* @__PURE__ */ jsxRuntimeExports.jsx("code", { className: "mono", children: status.endpoint || "（未设置）" }),
          " 不是回环地址， 明文传输会被主进程拒绝（",
          /* @__PURE__ */ jsxRuntimeExports.jsx("code", { className: "mono", children: "PLAINTEXT_NOT_ALLOWED" }),
          "）： 登录口令与会话令牌会在公网明文传输。"
        ]
      }
    ) : null,
    warning?.kind === "plaintext-not-allowed" ? /* @__PURE__ */ jsxRuntimeExports.jsxs(Banner, { tone: "error", children: [
      "明文传输被拒绝：",
      warning.message
    ] }) : null,
    warning?.kind === "identity-changed" ? /* @__PURE__ */ jsxRuntimeExports.jsxs(Banner, { tone: "error", children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx("b", { children: "服务端身份与已记录的不一致，可能是中间人攻击。" }),
      /* @__PURE__ */ jsxRuntimeExports.jsx("br", {}),
      "已记录：",
      /* @__PURE__ */ jsxRuntimeExports.jsx("code", { className: "mono", children: formatFingerprint(warning.expected ?? "") }),
      /* @__PURE__ */ jsxRuntimeExports.jsx("br", {}),
      "本次收到：",
      /* @__PURE__ */ jsxRuntimeExports.jsx("code", { className: "mono", children: formatFingerprint(warning.actual ?? "") }),
      /* @__PURE__ */ jsxRuntimeExports.jsx("br", {}),
      "若你无法确认服务端确实更换过密钥，请停止同步并检查网络链路；只有在你亲自确认过后， 才应重新探测并更新钉扎。"
    ] }) : null,
    /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "t-field__label", style: { marginTop: 14 }, children: [
      "服务端身份",
      status.pinned ? /* @__PURE__ */ jsxRuntimeExports.jsx(Badge, { tone: "ok", children: "已钉扎" }) : /* @__PURE__ */ jsxRuntimeExports.jsx(Badge, { tone: "warn", children: "未确认" })
    ] }),
    status.pinned ? /* @__PURE__ */ jsxRuntimeExports.jsxs(jsxRuntimeExports.Fragment, { children: [
      /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "synckey", children: [
        /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "synckey__label", children: "已记录指纹" }),
        /* @__PURE__ */ jsxRuntimeExports.jsx("code", { className: "synckey__value", children: formatFingerprint(status.pinnedFingerprint ?? "") })
      ] }),
      /* @__PURE__ */ jsxRuntimeExports.jsx("p", { className: "t-field__hint", children: "连接时会校验服务端出示的身份。清除钉扎后，下次连接需要重新核对指纹。" }),
      /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "settings-actions", children: [
        /* @__PURE__ */ jsxRuntimeExports.jsx(
          Button,
          {
            variant: "outline",
            icon: "refresh",
            loading: busy === "probe",
            onClick: () => void probe(),
            children: "重新探测"
          }
        ),
        /* @__PURE__ */ jsxRuntimeExports.jsx(Button, { variant: "danger", icon: "trash", loading: busy === "forget", onClick: () => void forget(), children: "清除钉扎" })
      ] })
    ] }) : /* @__PURE__ */ jsxRuntimeExports.jsxs(jsxRuntimeExports.Fragment, { children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx("p", { className: "t-field__hint", children: "首次连接前需要确认服务端身份。探测只建立握手、不发送任何数据。" }),
      /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "settings-actions", children: /* @__PURE__ */ jsxRuntimeExports.jsx(
        Button,
        {
          variant: "primary",
          icon: "search",
          loading: busy === "probe",
          onClick: () => void probe(),
          children: "探测服务端身份"
        }
      ) })
    ] }),
    probed ? /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "syncfingerprint", children: [
      /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "syncfingerprint__head", children: [
        /* @__PURE__ */ jsxRuntimeExports.jsx(Icon, { name: "shield", size: 13 }),
        "本次探测到的指纹"
      ] }),
      /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "syncfingerprint__grid", children: formatFingerprint(probed.fingerprint).split(" ").map((group, i) => /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "syncfingerprint__group", children: group }, `${group}-${i}`)) }),
      /* @__PURE__ */ jsxRuntimeExports.jsxs("p", { className: "t-field__hint", children: [
        "请在",
        /* @__PURE__ */ jsxRuntimeExports.jsx("b", { children: "服务器本机的同步服务日志" }),
        "里核对同一指纹（服务端启动/建连时会打印自己的身份指纹）。 一致即可信任；不一致说明你连的不是那台服务器。"
      ] }),
      /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "settings-actions", children: [
        /* @__PURE__ */ jsxRuntimeExports.jsx(
          Button,
          {
            variant: "primary",
            icon: "check",
            loading: busy === "trust",
            disabled: !probed.publicKey,
            onClick: () => void trust(),
            children: probed.publicKey ? "信任此服务器" : "重新探测后信任"
          }
        ),
        probed.publicKey ? /* @__PURE__ */ jsxRuntimeExports.jsx(
          Button,
          {
            variant: "ghost",
            icon: "copy",
            onClick: () => {
              void navigator.clipboard.writeText(formatFingerprint(probed.fingerprint));
              toast.ok("指纹已复制");
            },
            children: "复制指纹"
          }
        ) : null,
        /* @__PURE__ */ jsxRuntimeExports.jsx(Button, { variant: "ghost", onClick: () => setProbed(null), children: "放弃" })
      ] })
    ] }) : null,
    warning?.kind === "untrusted-server" ? /* @__PURE__ */ jsxRuntimeExports.jsxs(Banner, { tone: "warn", children: [
      "服务端身份尚未确认：",
      warning.message
    ] }) : null
  ] });
}
export {
  ServerIdentityPanel as S,
  classifySyncError as c
};
