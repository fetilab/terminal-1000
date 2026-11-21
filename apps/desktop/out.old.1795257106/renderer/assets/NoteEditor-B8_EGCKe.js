import { r as reactExports, j as jsxRuntimeExports, T as TextInput, n as IconButton, F as Field, z as Select, G as Switch, ak as formatDate, I as Icon, B as Badge, h as Button } from "./index-C6luzS_t.js";
import { C as CodeEditor } from "./CodeEditor-Dg2wjzaM.js";
function escapeHtml(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function inline(text) {
  return text.replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replace(/\*([^*]+)\*/g, "<em>$1</em>").replace(/~~([^~]+)~~/g, "<del>$1</del>").replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
}
function renderMarkdown(source) {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const out = [];
  let inCode = false;
  let codeBuf = [];
  let listKind = null;
  const closeList = () => {
    if (listKind) {
      out.push(`</${listKind}>`);
      listKind = null;
    }
  };
  for (const raw of lines) {
    if (raw.trimStart().startsWith("```")) {
      if (inCode) {
        out.push(`<pre><code>${escapeHtml(codeBuf.join("\n"))}</code></pre>`);
        codeBuf = [];
        inCode = false;
      } else {
        closeList();
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      codeBuf.push(raw);
      continue;
    }
    const line = raw.trimEnd();
    if (line.trim() === "") {
      closeList();
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      closeList();
      const level = heading[1]?.length ?? 1;
      out.push(`<h${level}>${inline(escapeHtml(heading[2] ?? ""))}</h${level}>`);
      continue;
    }
    if (/^(---|\*\*\*|___)\s*$/.test(line)) {
      closeList();
      out.push("<hr />");
      continue;
    }
    const quote = /^>\s?(.*)$/.exec(line);
    if (quote) {
      closeList();
      out.push(`<blockquote>${inline(escapeHtml(quote[1] ?? ""))}</blockquote>`);
      continue;
    }
    const ul = /^[-*+]\s+(.*)$/.exec(line);
    if (ul) {
      if (listKind !== "ul") {
        closeList();
        out.push("<ul>");
        listKind = "ul";
      }
      out.push(`<li>${inline(escapeHtml(ul[1] ?? ""))}</li>`);
      continue;
    }
    const ol = /^\d+\.\s+(.*)$/.exec(line);
    if (ol) {
      if (listKind !== "ol") {
        closeList();
        out.push("<ol>");
        listKind = "ol";
      }
      out.push(`<li>${inline(escapeHtml(ol[1] ?? ""))}</li>`);
      continue;
    }
    closeList();
    out.push(`<p>${inline(escapeHtml(line))}</p>`);
  }
  if (inCode && codeBuf.length > 0) {
    out.push(`<pre><code>${escapeHtml(codeBuf.join("\n"))}</code></pre>`);
  }
  closeList();
  return out.join("\n");
}
function NoteEditor({
  draft,
  folders,
  connections,
  groups,
  dirty,
  saving,
  onPatch,
  onSave,
  onTrash,
  onRestore,
  onPurge
}) {
  const [mode, setMode] = reactExports.useState("split");
  const [confirmPurge, setConfirmPurge] = reactExports.useState(false);
  const bodyRef = reactExports.useRef(null);
  const html = reactExports.useMemo(() => renderMarkdown(draft.content), [draft.content]);
  const isNew = !draft.id;
  const trashed = draft.trashed === true;
  reactExports.useEffect(() => {
    const onKeyDown = (e) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === "s" || e.key === "S")) {
        e.preventDefault();
        onSave();
      }
      if (e.key === "Tab" && document.activeElement === bodyRef.current) {
        e.preventDefault();
        const el = bodyRef.current;
        if (!el) return;
        const start = el.selectionStart;
        const end = el.selectionEnd;
        const next = `${draft.content.slice(0, start)}  ${draft.content.slice(end)}`;
        onPatch({ content: next });
        requestAnimationFrame(() => {
          el.selectionStart = el.selectionEnd = start + 2;
        });
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [draft.content, onPatch, onSave]);
  return /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "note-editor", children: [
    /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "note-editor__bar", children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx(
        TextInput,
        {
          className: "note-editor__title",
          value: draft.title,
          placeholder: "笔记标题",
          "aria-label": "笔记标题",
          onChange: (e) => onPatch({ title: e.target.value })
        }
      ),
      /* @__PURE__ */ jsxRuntimeExports.jsx(
        IconButton,
        {
          icon: draft.favorite ? "star-filled" : "star",
          label: draft.favorite ? "取消收藏" : "加入收藏",
          tone: draft.favorite ? "on" : "default",
          onClick: () => onPatch({ favorite: !draft.favorite })
        }
      ),
      /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "t-toolbar__divider" }),
      /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "t-segmented", role: "tablist", "aria-label": "编辑器视图", children: [
        ["split", "分栏"],
        ["edit", "编辑"],
        ["preview", "预览"]
      ].map(([value, label]) => /* @__PURE__ */ jsxRuntimeExports.jsx(
        "button",
        {
          type: "button",
          role: "tab",
          "aria-selected": mode === value,
          className: `t-segmented__item${mode === value ? " t-segmented__item--active" : ""}`,
          onClick: () => setMode(value),
          children: label
        },
        value
      )) })
    ] }),
    /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "note-editor__meta", children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx(Field, { label: "文件夹", children: /* @__PURE__ */ jsxRuntimeExports.jsx(
        Select,
        {
          value: draft.folderId ?? "",
          options: [{ value: "", label: "（未分类）" }, ...folders.map((f) => ({ value: f.id, label: f.name }))],
          onChange: (e) => onPatch({ folderId: e.target.value || void 0 })
        }
      ) }),
      /* @__PURE__ */ jsxRuntimeExports.jsx(Field, { label: "关联连接", hint: "运维时随手记：这条笔记属于哪台机器", children: /* @__PURE__ */ jsxRuntimeExports.jsx(
        Select,
        {
          value: draft.connectionId ?? "",
          options: [
            { value: "", label: "（不关联）" },
            ...connections.map((c) => ({ value: c.id, label: `${c.name} · ${c.kind.toUpperCase()}` }))
          ],
          onChange: (e) => onPatch({ connectionId: e.target.value || void 0 })
        }
      ) }),
      /* @__PURE__ */ jsxRuntimeExports.jsx(Field, { label: "关联分组", children: /* @__PURE__ */ jsxRuntimeExports.jsx(
        Select,
        {
          value: draft.groupId ?? "",
          options: [{ value: "", label: "（不关联）" }, ...groups.map((g) => ({ value: g.id, label: g.name }))],
          onChange: (e) => onPatch({ groupId: e.target.value || void 0 })
        }
      ) }),
      /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "note-editor__flags", children: [
        /* @__PURE__ */ jsxRuntimeExports.jsx(Switch, { checked: draft.favorite === true, onChange: (v) => onPatch({ favorite: v }), label: "收藏" }),
        /* @__PURE__ */ jsxRuntimeExports.jsxs("span", { className: "t-field__hint", children: [
          isNew ? "尚未保存" : `更新于 ${formatDate(draft.updatedAt)}`,
          dirty ? " · 有未保存改动" : ""
        ] })
      ] })
    ] }),
    /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: `note-editor__panes note-editor__panes--${mode}`, children: [
      mode !== "preview" ? /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "note-editor__pane", children: [
        /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "note-editor__pane-label", children: [
          /* @__PURE__ */ jsxRuntimeExports.jsx(Icon, { name: "edit", size: 12 }),
          " Markdown"
        ] }),
        /* @__PURE__ */ jsxRuntimeExports.jsx(
          CodeEditor,
          {
            value: draft.content,
            language: "markdown",
            height: 360,
            ariaLabel: "笔记内容",
            onChange: (next) => onPatch({ content: next }),
            onSave,
            statusLeft: "Markdown"
          }
        )
      ] }) : null,
      mode !== "edit" ? /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "note-editor__pane", children: [
        /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "note-editor__pane-label", children: [
          /* @__PURE__ */ jsxRuntimeExports.jsx(Icon, { name: "eye", size: 12 }),
          " 预览"
        ] }),
        /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "note-preview markdown-body", dangerouslySetInnerHTML: { __html: html } })
      ] }) : null
    ] }),
    /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "note-editor__actions", children: trashed ? /* @__PURE__ */ jsxRuntimeExports.jsxs(jsxRuntimeExports.Fragment, { children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx(Badge, { tone: "warn", children: "在废纸篓中" }),
      /* @__PURE__ */ jsxRuntimeExports.jsx(Button, { variant: "outline", icon: "refresh", onClick: onRestore, children: "恢复" }),
      confirmPurge ? /* @__PURE__ */ jsxRuntimeExports.jsxs(jsxRuntimeExports.Fragment, { children: [
        /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "t-field__error", children: "彻底删除后无法恢复，确认？" }),
        /* @__PURE__ */ jsxRuntimeExports.jsx(Button, { variant: "danger", icon: "trash", onClick: onPurge, children: "确认彻底删除" }),
        /* @__PURE__ */ jsxRuntimeExports.jsx(Button, { variant: "ghost", onClick: () => setConfirmPurge(false), children: "取消" })
      ] }) : /* @__PURE__ */ jsxRuntimeExports.jsx(Button, { variant: "danger", icon: "trash", onClick: () => setConfirmPurge(true), children: "彻底删除" })
    ] }) : /* @__PURE__ */ jsxRuntimeExports.jsxs(jsxRuntimeExports.Fragment, { children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx(Button, { variant: "primary", icon: "check", loading: saving, disabled: !dirty && !isNew, onClick: onSave, children: isNew ? "创建笔记" : "保存" }),
      /* @__PURE__ */ jsxRuntimeExports.jsxs("span", { className: "t-field__hint", children: [
        /* @__PURE__ */ jsxRuntimeExports.jsx("kbd", { className: "t-kbd", children: "Ctrl" }),
        "+",
        /* @__PURE__ */ jsxRuntimeExports.jsx("kbd", { className: "t-kbd", children: "S" })
      ] }),
      /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "t-toolbar__spacer" }),
      /* @__PURE__ */ jsxRuntimeExports.jsx(IconButton, { icon: "trash", label: "移入废纸篓", tone: "danger", onClick: onTrash, disabled: isNew })
    ] }) })
  ] });
}
export {
  NoteEditor,
  NoteEditor as default
};
