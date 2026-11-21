const __vite__mapDeps=(i,m=__vite__mapDeps,d=(m.f||(m.f=["./NoteEditor-BxYxowQF.js","./index-CwfghMy4.js","./index-DD-jW_Hd.css","./CodeEditor-_oooyGAs.js"])))=>i.map(i=>d[i]);
import { u as useStoreShallow, r as reactExports, a7 as loadNoteFolders, a8 as loadNotes, a as actions, j as jsxRuntimeExports, a9 as purgeNote, aa as restoreNote, ab as trashNote, ac as saveNoteDraft, t as toast, ad as updateNoteDraft, L as Loading, J as EmptyState, h as Button, ae as newNote, I as Icon, n as IconButton, B as Badge, f as Banner, y as formatRelativeTime, o as openNote, _ as __vitePreload, M as Modal, F as Field, T as TextInput, af as saveNoteFolder } from "./index-CwfghMy4.js";
const NoteEditor = reactExports.lazy(() => __vitePreload(() => import("./NoteEditor-BxYxowQF.js"), true ? __vite__mapDeps([0,1,2,3]) : void 0, import.meta.url));
function FolderDialog({ open, onClose }) {
  const [name, setName] = reactExports.useState("");
  const [error, setError] = reactExports.useState(null);
  const submit = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setError("文件夹名不能为空");
      return;
    }
    await saveNoteFolder(trimmed);
    setName("");
    onClose();
  };
  return /* @__PURE__ */ jsxRuntimeExports.jsx(
    Modal,
    {
      open,
      size: "sm",
      title: "新建文件夹",
      onClose,
      footer: /* @__PURE__ */ jsxRuntimeExports.jsxs(jsxRuntimeExports.Fragment, { children: [
        /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "t-modal__footer-spacer" }),
        /* @__PURE__ */ jsxRuntimeExports.jsx(Button, { variant: "ghost", onClick: onClose, children: "取消" }),
        /* @__PURE__ */ jsxRuntimeExports.jsx(Button, { variant: "primary", onClick: () => void submit(), children: "创建" })
      ] }),
      children: /* @__PURE__ */ jsxRuntimeExports.jsx(Field, { label: "名称", required: true, error, children: /* @__PURE__ */ jsxRuntimeExports.jsx(
        TextInput,
        {
          value: name,
          placeholder: "例如：变更记录",
          autoFocus: true,
          onChange: (e) => {
            setName(e.target.value);
            setError(null);
          },
          onKeyDown: (e) => {
            if (e.key === "Enter") void submit();
          }
        }
      ) })
    }
  );
}
function NotesSidebar() {
  const { filter, stats, folders } = useStoreShallow((s) => ({
    filter: s.notesFilter,
    stats: s.noteStats,
    folders: s.noteFolders
  }));
  const [dialogOpen, setDialogOpen] = reactExports.useState(false);
  const row = (key, icon, label, count) => /* @__PURE__ */ jsxRuntimeExports.jsxs(
    "button",
    {
      type: "button",
      className: `tree__row${filter === key ? " tree__row--active" : ""}`,
      "aria-current": filter === key || void 0,
      onClick: () => {
        actions.setNotesFilter(key);
        void loadNotes();
      },
      children: [
        /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "tree__twisty tree__twisty--leaf", "aria-hidden": true, children: /* @__PURE__ */ jsxRuntimeExports.jsx(Icon, { name: "chevron-right", size: 12 }) }),
        /* @__PURE__ */ jsxRuntimeExports.jsx(Icon, { name: icon, size: 14 }),
        /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "tree__label", children: label }),
        /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "tree__count", children: count })
      ]
    },
    key
  );
  return /* @__PURE__ */ jsxRuntimeExports.jsxs("aside", { className: "panel", "aria-label": "笔记", children: [
    /* @__PURE__ */ jsxRuntimeExports.jsxs("header", { className: "panel-header", children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "panel-title", children: "笔记" }),
      /* @__PURE__ */ jsxRuntimeExports.jsx(
        IconButton,
        {
          icon: "refresh",
          label: "刷新",
          onClick: () => {
            void loadNotes();
            void loadNoteFolders();
          }
        }
      )
    ] }),
    /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "panel-body", children: /* @__PURE__ */ jsxRuntimeExports.jsxs("nav", { className: "tree", role: "tree", "aria-label": "笔记分类", children: [
      row("all", "notes", "全部笔记", stats.all),
      row("favorites", "star-filled", "我的收藏", stats.favorites),
      row("trash", "trash", "废纸篓", stats.trash),
      /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "tree__section", children: "文件夹" }),
      folders.length === 0 ? /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "tree__empty", children: "还没有文件夹。用下方按钮把笔记按主题归类。" }) : folders.map((f) => row(`folder:${f.id}`, "folder", f.name, stats.byFolder[f.id] ?? 0))
    ] }) }),
    /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "panel-footer", children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx(IconButton, { icon: "folder", label: "新建文件夹", onClick: () => setDialogOpen(true) }),
      /* @__PURE__ */ jsxRuntimeExports.jsx(
        Button,
        {
          size: "sm",
          variant: "outline",
          icon: "plus",
          style: { flex: 1 },
          onClick: () => {
            const fid = filter.startsWith("folder:") ? filter.slice("folder:".length) : void 0;
            newNote(fid);
          },
          children: "新建笔记"
        }
      )
    ] }),
    /* @__PURE__ */ jsxRuntimeExports.jsx(FolderDialog, { open: dialogOpen, onClose: () => setDialogOpen(false) })
  ] });
}
function NotesView() {
  const { notes, folders, filter, query, draft, dirty, saving, loading, ready, error, connections, groups } = useStoreShallow((s) => ({
    notes: s.notes,
    folders: s.noteFolders,
    filter: s.notesFilter,
    query: s.notesQuery,
    draft: s.noteDraft,
    dirty: s.noteDirty,
    saving: s.noteSaving,
    loading: s.notesLoading,
    ready: s.notesReady,
    error: s.notesError,
    connections: s.connections,
    groups: s.groups
  }));
  reactExports.useEffect(() => {
    void loadNoteFolders();
    void loadNotes();
  }, []);
  const [search, setSearch] = reactExports.useState(query);
  reactExports.useEffect(() => {
    const t = window.setTimeout(() => {
      if (search !== query) {
        actions.setNotesQuery(search);
        void loadNotes();
      }
    }, 350);
    return () => window.clearTimeout(t);
  }, [search, query]);
  const flatGroups = reactExports.useMemo(() => {
    const out = [];
    const walk = (nodes, depth) => {
      for (const n of nodes) {
        out.push({ id: n.id, name: `${"　".repeat(depth)}${n.name}` });
        walk(n.children, depth + 1);
      }
    };
    walk(groups, 0);
    return out;
  }, [groups]);
  const trashed = filter === "trash";
  const editorNode = draft ? /* @__PURE__ */ jsxRuntimeExports.jsx(reactExports.Suspense, { fallback: /* @__PURE__ */ jsxRuntimeExports.jsx(Loading, { text: "正在载入编辑器…" }), children: /* @__PURE__ */ jsxRuntimeExports.jsx(
    NoteEditor,
    {
      draft,
      folders,
      connections,
      groups: flatGroups,
      dirty,
      saving,
      onPatch: (patch) => updateNoteDraft(patch),
      onSave: () => {
        void saveNoteDraft().then((ok) => {
          if (ok) toast.ok("笔记已保存");
        });
      },
      onTrash: () => {
        if (draft.id) void trashNote(draft.id);
      },
      onRestore: () => {
        if (draft.id) void restoreNote(draft.id);
      },
      onPurge: () => {
        if (draft.id) void purgeNote(draft.id);
      }
    }
  ) }) : /* @__PURE__ */ jsxRuntimeExports.jsx(
    EmptyState,
    {
      icon: "notes",
      title: notes.length === 0 ? "这里还没有笔记" : "选择左侧的一条笔记",
      text: "笔记支持 Markdown，并且可以关联到具体连接或分组——排查问题时把结论就地记在对应机器上。",
      actions: /* @__PURE__ */ jsxRuntimeExports.jsx(Button, { variant: "primary", icon: "plus", onClick: () => newNote(), children: "新建笔记" })
    }
  );
  return /* @__PURE__ */ jsxRuntimeExports.jsxs("main", { className: "content", "aria-label": "笔记", children: [
    /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "t-toolbar", children: [
      /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "t-search", children: [
        /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "t-search__icon", children: /* @__PURE__ */ jsxRuntimeExports.jsx(Icon, { name: "search", size: 14 }) }),
        /* @__PURE__ */ jsxRuntimeExports.jsx(
          "input",
          {
            className: "t-input",
            value: search,
            placeholder: "搜索标题或正文…",
            "aria-label": "搜索笔记",
            onChange: (e) => setSearch(e.target.value)
          }
        ),
        search ? /* @__PURE__ */ jsxRuntimeExports.jsx(
          IconButton,
          {
            className: "t-search__clear",
            icon: "close",
            label: "清空搜索",
            onClick: () => setSearch("")
          }
        ) : null
      ] }),
      /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "t-toolbar__spacer" }),
      trashed ? /* @__PURE__ */ jsxRuntimeExports.jsx(Badge, { tone: "warn", children: "废纸篓" }) : null,
      /* @__PURE__ */ jsxRuntimeExports.jsxs(Badge, { children: [
        notes.length,
        " 条"
      ] }),
      /* @__PURE__ */ jsxRuntimeExports.jsx(IconButton, { icon: "refresh", label: "刷新列表", onClick: () => void loadNotes() })
    ] }),
    !ready && error ? /* @__PURE__ */ jsxRuntimeExports.jsx("div", { style: { padding: "10px 12px 0" }, children: /* @__PURE__ */ jsxRuntimeExports.jsxs(Banner, { tone: "warn", children: [
      "笔记服务不可用：",
      error
    ] }) }) : null,
    /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "notes-split", children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "notes-list", role: "list", children: loading && notes.length === 0 ? /* @__PURE__ */ jsxRuntimeExports.jsx(Loading, { text: "读取笔记…" }) : notes.length === 0 ? /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "notes-list__empty", children: query ? "没有匹配的笔记" : trashed ? "废纸篓是空的" : filter === "favorites" ? "还没有收藏的笔记" : "这个分类下还没有笔记" }) : notes.map((n) => {
        const active = draft?.id === n.id;
        return /* @__PURE__ */ jsxRuntimeExports.jsxs(
          "div",
          {
            role: "listitem",
            className: `notes-item${active ? " notes-item--active" : ""}`,
            tabIndex: 0,
            onClick: () => void openNote(n.id),
            onKeyDown: (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                void openNote(n.id);
              }
            },
            children: [
              /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "notes-item__head", children: [
                n.favorite ? /* @__PURE__ */ jsxRuntimeExports.jsx(Icon, { name: "star-filled", size: 12 }) : null,
                /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "notes-item__title", children: n.title || "未命名笔记" })
              ] }),
              n.excerpt ? /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "notes-item__excerpt", children: n.excerpt }) : null,
              /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "notes-item__meta", children: [
                /* @__PURE__ */ jsxRuntimeExports.jsx("span", { children: formatRelativeTime(n.updatedAt) }),
                n.contentLength > 0 ? /* @__PURE__ */ jsxRuntimeExports.jsxs("span", { children: [
                  n.contentLength,
                  " 字"
                ] }) : null,
                n.connectionId ? /* @__PURE__ */ jsxRuntimeExports.jsx(Badge, { tone: "accent", children: connections.find((c) => c.id === n.connectionId)?.name ?? "已关联连接" }) : null
              ] })
            ]
          },
          n.id
        );
      }) }),
      /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "notes-detail", children: editorNode })
    ] })
  ] });
}
export {
  NotesSidebar,
  NotesView as default
};
