const __vite__mapDeps=(i,m=__vite__mapDeps,d=(m.f||(m.f=["./monacoSetup-DnLkW-Qc.js","./index-C6luzS_t.js","./index-DD-jW_Hd.css","./monacoSetup-BUJJVUiO.css"])))=>i.map(i=>d[i]);
import { r as reactExports, _ as __vitePreload, j as jsxRuntimeExports, f as Banner, L as Loading, I as Icon, B as Badge } from "./index-C6luzS_t.js";
function monacoThemeFor() {
  const t = document.documentElement.getAttribute("data-theme");
  return t === "light" ? "vs" : "vs-dark";
}
function CodeEditor({
  value,
  language,
  onChange,
  onSave,
  readOnly = false,
  height = 360,
  statusLeft,
  ariaLabel
}) {
  const hostRef = reactExports.useRef(null);
  const editorRef = reactExports.useRef(null);
  const monacoRef = reactExports.useRef(null);
  const valueRef = reactExports.useRef(value);
  const onChangeRef = reactExports.useRef(onChange);
  const onSaveRef = reactExports.useRef(onSave);
  onChangeRef.current = onChange;
  onSaveRef.current = onSave;
  const [status, setStatus] = reactExports.useState("loading");
  const [failure, setFailure] = reactExports.useState(null);
  reactExports.useEffect(() => {
    let disposed = false;
    void (async () => {
      try {
        const { monaco } = await __vitePreload(async () => {
          const { monaco: monaco2 } = await import("./monacoSetup-DnLkW-Qc.js").then((n) => n.m);
          return { monaco: monaco2 };
        }, true ? __vite__mapDeps([0,1,2,3]) : void 0, import.meta.url);
        if (disposed || !hostRef.current) return;
        monacoRef.current = monaco;
        const editor = monaco.editor.create(hostRef.current, {
          value,
          language,
          theme: monacoThemeFor(),
          readOnly,
          automaticLayout: true,
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
          fontSize: 12.5,
          fontFamily: "'JetBrains Mono', Menlo, Consolas, monospace",
          tabSize: 2,
          renderWhitespace: "selection",
          // 换行：配置文件里长行很常见，不换行会逼用户横向滚
          wordWrap: "on",
          // 查找/替换相关：Monaco 自带 widget，这里只是让它在小尺寸下也好用
          find: { addExtraSpaceOnTop: false, autoFindInSelection: "never" }
        });
        editorRef.current = editor;
        editor.onDidChangeModelContent(() => {
          const next = editor.getValue();
          valueRef.current = next;
          onChangeRef.current(next);
        });
        editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
          onSaveRef.current?.();
        });
        setStatus("ready");
      } catch (err) {
        if (disposed) return;
        setFailure(err instanceof Error ? err.message : String(err));
        setStatus("failed");
      }
    })();
    return () => {
      disposed = true;
      editorRef.current?.dispose();
      editorRef.current = null;
    };
  }, []);
  reactExports.useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    if (value === valueRef.current) return;
    valueRef.current = value;
    editor.setValue(value);
  }, [value]);
  reactExports.useEffect(() => {
    const editor = editorRef.current;
    const monaco = monacoRef.current;
    if (!editor || !monaco) return;
    const model = editor.getModel();
    if (model) monaco.editor.setModelLanguage(model, language);
  }, [language, status]);
  reactExports.useEffect(() => {
    editorRef.current?.updateOptions({ readOnly });
  }, [readOnly]);
  reactExports.useEffect(() => {
    if (status !== "ready") return;
    const apply = () => monacoRef.current?.editor.setTheme(monacoThemeFor());
    apply();
    const observer = new MutationObserver(apply);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, [status]);
  const focus = reactExports.useCallback(() => editorRef.current?.focus(), []);
  if (status === "failed") {
    return /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "code-editor code-editor--fallback", children: [
      /* @__PURE__ */ jsxRuntimeExports.jsxs(Banner, { tone: "warn", children: [
        "代码编辑器（Monaco）加载失败，已退回纯文本编辑：",
        failure ?? "未知原因",
        /* @__PURE__ */ jsxRuntimeExports.jsx("br", {}),
        "语法高亮与查找替换在本机不可用，但内容仍可正常编辑与保存。"
      ] }),
      /* @__PURE__ */ jsxRuntimeExports.jsx(
        "textarea",
        {
          className: "code-editor__fallback",
          style: { height },
          value,
          spellCheck: false,
          "aria-label": ariaLabel ?? "代码编辑",
          onChange: (e) => onChange(e.target.value)
        }
      )
    ] });
  }
  return /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "code-editor", children: [
    /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "code-editor__host", ref: hostRef, style: { height }, onClick: focus }),
    /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "code-editor__status", children: status === "loading" ? /* @__PURE__ */ jsxRuntimeExports.jsx(Loading, { text: "载入编辑器…" }) : /* @__PURE__ */ jsxRuntimeExports.jsxs(jsxRuntimeExports.Fragment, { children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx(Icon, { name: "edit", size: 12 }),
      statusLeft,
      /* @__PURE__ */ jsxRuntimeExports.jsx("div", { style: { flex: 1 } }),
      /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "metric__sub", children: "Ctrl+S 保存 · Ctrl+F 查找 · Ctrl+H 替换" }),
      /* @__PURE__ */ jsxRuntimeExports.jsx(Badge, { tone: "outline", children: language })
    ] }) })
  ] });
}
export {
  CodeEditor as C
};
