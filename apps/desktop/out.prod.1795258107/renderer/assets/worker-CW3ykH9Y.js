(function() {
  "use strict";
  const CELL_U32 = 8;
  const CellFlags = Object.freeze({
    BOLD: 1,
    DIM: 2,
    ITALIC: 4,
    REVERSE: 8,
    STRIKETHROUGH: 16,
    BLINK: 32,
    WIDE: 64,
    WIDE_TRAIL: 128,
    UNDERLINE_SHIFT: 8,
    UNDERLINE_MASK: 7 << 8
  });
  function decodeColor(word) {
    const kind = word >>> 24;
    if (kind === 1)
      return { index: word & 255 };
    if (kind === 2)
      return { rgb: word & 16777215 };
    return null;
  }
  function decodeCell(words, i) {
    const at = (k) => words[i + k] ?? 0;
    const flags = at(6);
    const combining = [];
    if (at(1))
      combining.push(String.fromCodePoint(at(1)));
    if (at(2))
      combining.push(String.fromCodePoint(at(2)));
    return {
      ch: at(0) ? String.fromCodePoint(at(0)) : "",
      combining,
      fg: decodeColor(at(3)),
      bg: decodeColor(at(4)),
      decorationFg: decodeColor(at(5)),
      bold: !!(flags & CellFlags.BOLD),
      dim: !!(flags & CellFlags.DIM),
      italic: !!(flags & CellFlags.ITALIC),
      reverse: !!(flags & CellFlags.REVERSE),
      strikethrough: !!(flags & CellFlags.STRIKETHROUGH),
      blink: !!(flags & CellFlags.BLINK),
      wide: !!(flags & CellFlags.WIDE),
      wideTrail: !!(flags & CellFlags.WIDE_TRAIL),
      underline: (flags & CellFlags.UNDERLINE_MASK) >> CellFlags.UNDERLINE_SHIFT,
      hyperlinkId: at(7)
    };
  }
  function rowToString(words, cols) {
    let s = "";
    for (let x = 0; x < cols; x++) {
      const i = x * CELL_U32;
      if ((words[i + 6] ?? 0) & CellFlags.WIDE_TRAIL)
        continue;
      const ch = words[i] ?? 0;
      const cc1 = words[i + 1] ?? 0;
      const cc2 = words[i + 2] ?? 0;
      s += ch && ch !== 9 ? String.fromCodePoint(ch) : " ";
      if (cc1)
        s += String.fromCodePoint(cc1);
      if (cc2)
        s += String.fromCodePoint(cc2);
    }
    return s.replace(/ +$/, "");
  }
  function parseColorSpec(spec) {
    if (spec.startsWith("#")) {
      const hex = spec.slice(1);
      if (hex.length === 3) {
        const v = Number.parseInt(hex, 16);
        if (Number.isNaN(v))
          return null;
        const r = v >> 8 & 15, g = v >> 4 & 15, b = v & 15;
        return r * 17 << 16 | g * 17 << 8 | b * 17;
      }
      if (hex.length === 6) {
        const v = Number.parseInt(hex, 16);
        return Number.isNaN(v) ? null : v;
      }
      return null;
    }
    if (spec.startsWith("rgb:")) {
      const parts = spec.slice(4).split("/");
      if (parts.length !== 3)
        return null;
      const comps = parts.map((p) => {
        const v = Number.parseInt(p, 16);
        if (Number.isNaN(v))
          return null;
        switch (p.length) {
          case 1:
            return v * 17;
          case 2:
            return v;
          case 3:
            return v >> 4;
          case 4:
            return v >> 8;
          default:
            return null;
        }
      });
      const [r, g, b] = comps;
      if (r == null || g == null || b == null)
        return null;
      return (r & 255) << 16 | (g & 255) << 8 | b & 255;
    }
    return null;
  }
  function rgbSpec(rgb) {
    const c = (v) => v.toString(16).padStart(2, "0").repeat(2);
    return `rgb:${c(rgb >> 16 & 255)}/${c(rgb >> 8 & 255)}/${c(rgb & 255)}`;
  }
  var CursorShape;
  (function(CursorShape2) {
    CursorShape2[CursorShape2["None"] = 0] = "None";
    CursorShape2[CursorShape2["Block"] = 1] = "Block";
    CursorShape2[CursorShape2["Beam"] = 2] = "Beam";
    CursorShape2[CursorShape2["Underline"] = 3] = "Underline";
    CursorShape2[CursorShape2["Hollow"] = 4] = "Hollow";
  })(CursorShape || (CursorShape = {}));
  var SelectionExtendMode;
  (function(SelectionExtendMode2) {
    SelectionExtendMode2[SelectionExtendMode2["Cell"] = 0] = "Cell";
    SelectionExtendMode2[SelectionExtendMode2["Word"] = 1] = "Word";
    SelectionExtendMode2[SelectionExtendMode2["Line"] = 2] = "Line";
    SelectionExtendMode2[SelectionExtendMode2["LineFromBegin"] = 3] = "LineFromBegin";
    SelectionExtendMode2[SelectionExtendMode2["LineFromPoint"] = 4] = "LineFromPoint";
    SelectionExtendMode2[SelectionExtendMode2["WordAndLineFromPoint"] = 5] = "WordAndLineFromPoint";
  })(SelectionExtendMode || (SelectionExtendMode = {}));
  var ProgressState;
  (function(ProgressState2) {
    ProgressState2[ProgressState2["Unset"] = 0] = "Unset";
    ProgressState2[ProgressState2["Set"] = 1] = "Set";
    ProgressState2[ProgressState2["Error"] = 2] = "Error";
    ProgressState2[ProgressState2["Indeterminate"] = 3] = "Indeterminate";
    ProgressState2[ProgressState2["Paused"] = 4] = "Paused";
  })(ProgressState || (ProgressState = {}));
  function isGraphicsArg(v) {
    return typeof v === "object" && v !== null && !Array.isArray(v) && "action" in v && "payload" in v;
  }
  function loadModuleSync(source) {
    if (source instanceof WebAssembly.Module)
      return source;
    if (source instanceof ArrayBuffer || ArrayBuffer.isView(source))
      return new WebAssembly.Module(source);
    const g = globalThis;
    const fs = g.process?.getBuiltinModule?.("node:fs");
    if (!fs)
      throw new Error("loadModuleSync requires Node or Bun; use loadModule() in browsers");
    return new WebAssembly.Module(fs.readFileSync(source ?? new URL("" + new URL("kitty-vt-Dz-bhl-e.wasm", self.location.href).href, self.location.href)));
  }
  async function loadModule(source) {
    if (source instanceof WebAssembly.Module)
      return source;
    if (source instanceof ArrayBuffer || ArrayBuffer.isView(source))
      return WebAssembly.compile(source);
    const url = source ?? new URL("" + new URL("kitty-vt-Dz-bhl-e.wasm", self.location.href).href, self.location.href);
    const g = globalThis;
    if (g.process?.versions?.node || g.Bun) {
      const { readFile } = await Promise.resolve().then(function() {
        return __viteBrowserExternal;
      });
      const { fileURLToPath } = await Promise.resolve().then(function() {
        return __viteBrowserExternal;
      });
      const path = url instanceof URL ? fileURLToPath(url) : url;
      const buf = await readFile(path);
      return WebAssembly.compile(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    }
    const resp = await fetch(url);
    return "compileStreaming" in WebAssembly ? WebAssembly.compileStreaming(resp) : WebAssembly.compile(await resp.arrayBuffer());
  }
  function makeWasiStubs(getMemory, log) {
    const decoder = new TextDecoder();
    const view = () => {
      const memory = getMemory();
      if (!memory)
        throw new Error("wasm memory not ready");
      return new DataView(memory.buffer);
    };
    const stubs = {
      fd_write: (fd, iovsPtr, iovsLen, nwrittenPtr) => {
        const v = view();
        let written = 0, text = "";
        for (let i = 0; i < iovsLen; i++) {
          const ptr = v.getUint32(iovsPtr + i * 8, true);
          const len = v.getUint32(iovsPtr + i * 8 + 4, true);
          text += decoder.decode(new Uint8Array(v.buffer, ptr, len));
          written += len;
        }
        if (text.trim())
          log(`fd${fd}: ${text.trimEnd()}`);
        v.setUint32(nwrittenPtr, written, true);
        return 0;
      },
      fd_seek: () => 70,
      // ESPIPE
      fd_close: () => 0,
      clock_time_get: (_id, _precision, outPtr) => {
        view().setBigUint64(outPtr, BigInt(Date.now()) * 1000000n, true);
        return 0;
      },
      random_get: (ptr, len) => {
        const mem = new Uint8Array(view().buffer, ptr, len);
        for (let off = 0; off < len; off += 65536)
          crypto.getRandomValues(mem.subarray(off, Math.min(off + 65536, len)));
        return 0;
      },
      environ_sizes_get: (countPtr, sizePtr) => {
        const v = view();
        v.setUint32(countPtr, 0, true);
        v.setUint32(sizePtr, 0, true);
        return 0;
      },
      environ_get: () => 0,
      proc_exit: (code) => {
        throw new Error(`kitty-vt.wasm exited with code ${code}`);
      }
    };
    return new Proxy(stubs, {
      get: (target, prop) => target[prop] ?? (() => 52)
      // ENOSYS
    });
  }
  class KittyTerminal {
    #x;
    #t = 0;
    /** Receives bytes the terminal sends to the application (query replies). Reassignable. */
    onOutput;
    /** Receives host events (title, bell, clipboard, graphics, ...). Reassignable. */
    onEvent;
    #decoder = new TextDecoder();
    #encoder = new TextEncoder();
    #title = "";
    #titleStack = [];
    /** Live native handle; throws once the terminal has been disposed. */
    get #ptr() {
      if (!this.#t)
        throw new Error("KittyTerminal used after dispose()");
      return this.#t;
    }
    /** Load the wasm module and allocate a terminal. */
    static async create(opts = {}) {
      const module = await loadModule(opts.wasm);
      const term = new KittyTerminal();
      term.onOutput = opts.onOutput;
      term.onEvent = opts.onEvent;
      term.#attach(await WebAssembly.instantiate(module, term.#imports()), opts);
      return term;
    }
    /**
     * Synchronous {@link create} for Node/Bun hosts: compiles and instantiates
     * on the calling thread (see {@link loadModuleSync}). Browsers restrict
     * main-thread sync compilation of large modules — use {@link create} there.
     */
    static createSync(opts = {}) {
      const term = new KittyTerminal();
      term.onOutput = opts.onOutput;
      term.onEvent = opts.onEvent;
      term.#attach(new WebAssembly.Instance(loadModuleSync(opts.wasm), term.#imports()), opts);
      return term;
    }
    /** WASI import object; memory resolves lazily since exports land in #attach. */
    #imports() {
      return {
        wasi_snapshot_preview1: makeWasiStubs(() => this.#x?.memory, (message) => {
          if (this.onEvent)
            this.onEvent({ type: "log", message });
          else
            console.error("[kitty-vt]", message);
        })
      };
    }
    /** Bind a freshly instantiated module and allocate the native terminal. */
    #attach(instance, opts) {
      this.#x = instance.exports;
      this.#x._initialize();
      if (this.#x.term_cell_size() !== CELL_U32 * 4) {
        throw new Error("kitty-vt.wasm cell layout mismatch; rebuild the module");
      }
      const { columns = 80, rows = 24, scrollback = 2e3 } = opts;
      this.#t = this.#x.term_new(columns, rows, scrollback);
      if (!this.#t)
        throw new Error("failed to allocate terminal");
    }
    #mem() {
      return new Uint8Array(this.#x.memory.buffer);
    }
    #u32(ptr, len) {
      return new Uint32Array(this.#x.memory.buffer, ptr, len);
    }
    #cstr(ptr) {
      if (!ptr)
        return null;
      const mem = this.#mem();
      let end = ptr;
      while (mem[end] !== 0)
        end++;
      return this.#decoder.decode(mem.subarray(ptr, end));
    }
    /** Feed bytes emitted by the application/child. Parses synchronously. */
    write(data) {
      const bytes = typeof data === "string" ? this.#encoder.encode(data) : data;
      let off = 0;
      while (off < bytes.length) {
        const ptr = this.#x.term_input_ptr(this.#ptr);
        const cap = this.#x.term_input_cap(this.#ptr);
        const n = Math.min(cap, bytes.length - off);
        this.#mem().set(bytes.subarray(off, off + n), ptr);
        this.#x.term_input_commit(this.#ptr, n);
        off += n;
      }
      this.#drain();
    }
    /** Send bytes toward the application (host-generated responses). */
    #respond(data) {
      this.onOutput?.(this.#encoder.encode(data));
    }
    #drain() {
      const outLen = this.#x.term_out_len(this.#ptr);
      if (outLen) {
        const ptr = this.#x.term_out_ptr(this.#ptr);
        const out = this.#mem().slice(ptr, ptr + outLen);
        this.#x.term_out_clear(this.#ptr);
        this.onOutput?.(out);
      }
      const evLen = this.#x.term_events_len(this.#ptr);
      if (evLen) {
        const ptr = this.#x.term_events_ptr(this.#ptr);
        const raw = this.#decoder.decode(this.#mem().subarray(ptr, ptr + evLen));
        this.#x.term_events_clear(this.#ptr);
        for (const line of raw.split("\n")) {
          if (!line)
            continue;
          this.#dispatch(JSON.parse(line));
        }
      }
    }
    // Implements kitty's window.py responsibilities over the callback stream.
    #dispatch(ev) {
      const emit = this.onEvent;
      const str = (v) => typeof v === "string" ? v : "";
      const num = (v) => typeof v === "number" ? v : 0;
      switch (ev.cb) {
        case "title_changed":
          this.#title = str(ev.args[0]);
          emit?.({ type: "title", title: this.#title });
          return;
        case "icon_changed":
          emit?.({ type: "icon", icon: str(ev.args[0]) });
          return;
        case "manipulate_title_stack": {
          const [pop, title] = ev.args;
          if (title !== true && title !== 1)
            return;
          if (pop === true) {
            const t = this.#titleStack.pop();
            if (t !== void 0) {
              this.#title = t;
              emit?.({ type: "title", title: t });
            }
          } else {
            this.#titleStack.push(this.#title);
            if (this.#titleStack.length > 16)
              this.#titleStack.shift();
          }
          return;
        }
        case "on_bell":
          emit?.({ type: "bell" });
          return;
        case "on_reset":
          this.#titleStack.length = 0;
          emit?.({ type: "reset", hard: ev.args[0] === true });
          return;
        case "set_dynamic_color": {
          let code = num(ev.args[0]);
          const payload = str(ev.args[1]);
          if (code >= 110 && code <= 112) {
            this.#x.term_set_default_color(this.#ptr, code - 110, -1n);
            emit?.({ type: "colors_changed" });
            return;
          }
          for (const part of payload.split(";")) {
            const which = code - 10;
            if (which >= 0 && which <= 2 && part) {
              if (part === "?") {
                const cur = decodeColor([
                  this.#x.term_default_fg(this.#ptr),
                  this.#x.term_default_bg(this.#ptr),
                  this.#x.term_cursor_color(this.#ptr)
                ][which] ?? 0);
                const rgb = cur && "rgb" in cur ? cur.rgb : which === 1 ? 0 : 14540253;
                this.#respond(`\x1B]${code};${rgbSpec(rgb)}\x1B\\`);
              } else {
                const rgb = parseColorSpec(part);
                if (rgb !== null) {
                  this.#x.term_set_default_color(this.#ptr, which, BigInt(rgb));
                  emit?.({ type: "colors_changed" });
                }
              }
            }
            code++;
          }
          return;
        }
        case "set_color_table_color": {
          const code = num(ev.args[0]);
          const payload = str(ev.args[1]);
          if (code === 104) {
            if (!payload)
              this.#x.term_reset_palette_color(this.#ptr, -1);
            else
              for (const p of payload.split(";"))
                this.#x.term_reset_palette_color(this.#ptr, Number.parseInt(p, 10) & 255);
            emit?.({ type: "colors_changed" });
            return;
          }
          const parts = payload.split(";");
          for (let i = 0; i + 1 < parts.length; i += 2) {
            const idx = Number.parseInt(parts[i] ?? "", 10);
            if (!Number.isInteger(idx) || idx < 0 || idx > 255)
              continue;
            const spec = parts[i + 1] ?? "";
            if (spec === "?") {
              this.#respond(`\x1B]4;${idx};${rgbSpec(this.#x.term_palette_color(this.#ptr, idx))}\x1B\\`);
            } else {
              const rgb = parseColorSpec(spec);
              if (rgb !== null) {
                this.#x.term_set_palette_color(this.#ptr, idx, rgb);
                emit?.({ type: "colors_changed" });
              }
            }
          }
          return;
        }
        case "color_profile_popped":
          emit?.({ type: "colors_changed" });
          return;
        case "color_control":
          emit?.({
            type: "color_control",
            code: num(ev.args[0]),
            data: str(ev.args[1])
          });
          return;
        case "clipboard_control": {
          const payload = str(ev.args[0]) || str(ev.args[1]);
          const sep = payload.indexOf(";");
          const targets = sep >= 0 ? payload.slice(0, sep) : payload;
          const data = sep >= 0 ? payload.slice(sep + 1) : "";
          emit?.({ type: "clipboard", targets, data, query: data === "?" });
          return;
        }
        case "desktop_notify":
          if (num(ev.args[0]) === 9 && str(ev.args[1]).startsWith("4;")) {
            const [, state = "0", percent = "0"] = str(ev.args[1]).split(";");
            this.#x.term_set_progress(this.#ptr, Number.parseInt(state, 10) || 0, Number.parseInt(percent, 10) || 0);
            emit?.({ type: "progress", ...this.progress });
            return;
          }
          emit?.({
            type: "notification",
            code: num(ev.args[0]),
            data: str(ev.args[1])
          });
          return;
        case "file_transmission":
          emit?.({ type: "file_transmission", data: str(ev.args[0]) });
          return;
        case "osc_context":
          emit?.({ type: "osc_context", data: str(ev.args[0]) });
          return;
        case "cmd_output_marking":
          emit?.({ type: "shell_prompt", data: ev.args });
          return;
        case "request_capabilities": {
          const query = str(ev.args[0]);
          emit?.({ type: "request_capabilities", query });
          this.#respond(`\x1BP0+r${query}\x1B\\`);
          return;
        }
        case "graphics_command": {
          const g = ev.args[0];
          if (isGraphicsArg(g)) {
            emit?.({ type: "graphics_command", ...g });
            return;
          }
          break;
        }
        case "on_activity_since_last_focus":
          return;
      }
      emit?.({ type: "callback", name: ev.cb, args: ev.args });
    }
    /** Current column count. */
    get columns() {
      return this.#x.term_cols(this.#ptr);
    }
    /** Current row count. */
    get rows() {
      return this.#x.term_rows(this.#ptr);
    }
    /** Window title, tracking OSC 0/2 and the title stack. */
    get title() {
      return this.#title;
    }
    /** False while the alternate screen (mode 1049) is active. */
    get isMainScreen() {
      return !!this.#x.term_is_main_screen(this.#ptr);
    }
    /** Number of lines currently held in scrollback. */
    get scrollbackLength() {
      return this.#x.term_scrollback_count(this.#ptr);
    }
    /** True when cell data changed since the last clearDirty(). */
    get isDirty() {
      return !!this.#x.term_is_dirty(this.#ptr);
    }
    /** Acknowledge all pending damage; see {@link isDirty} and {@link lineDirty}. */
    clearDirty() {
      this.#x.term_clear_dirty(this.#ptr);
    }
    /** Cursor position and presentation. */
    get cursor() {
      return {
        x: this.#x.term_cursor_x(this.#ptr),
        y: this.#x.term_cursor_y(this.#ptr),
        shape: this.#x.term_cursor_shape(this.#ptr),
        visible: !!this.#x.term_cursor_visible(this.#ptr),
        blink: !!this.#x.term_cursor_blink(this.#ptr)
      };
    }
    /** Current kitty-keyboard-protocol flags (CSI u). */
    get keyEncodingFlags() {
      return this.#x.term_key_encoding_flags(this.#ptr);
    }
    /**
     * Query a terminal mode (DECRQM semantics): -1 unknown, 0 reset, 1 set.
     * Private modes (DECCKM=1, DECAWM=7, alt-screen=1049, bracketed paste=2004,
     * mouse=1000..1016, ...) use `isPrivate = true` (the default).
     */
    mode(mode, isPrivate = true) {
      return this.#x.term_mode(this.#ptr, mode, isPrivate ? 1 : 0);
    }
    /** Raw 8-words-per-cell snapshot of a screen row (see CellFlags). */
    lineCells(y) {
      const ptr = this.#x.term_line_cells(this.#ptr, y);
      return ptr ? this.#u32(ptr, this.columns * CELL_U32) : null;
    }
    /** Decode one cell. */
    cell(x, y) {
      const words = this.lineCells(y);
      if (!words || x >= this.columns)
        return null;
      return decodeCell(words, x * CELL_U32);
    }
    /** Text of one screen row (graphemes included, wide trails skipped). */
    line(y) {
      const words = this.lineCells(y);
      return words ? rowToString(words, this.columns) : "";
    }
    /** Whether screen row y is a wrap continuation of the previous row. */
    lineContinued(y) {
      return !!this.#x.term_line_continued(this.#ptr, y);
    }
    /** Whether row y's cell content changed since the last clearDirty(). */
    lineDirty(y) {
      return !!this.#x.term_line_dirty(this.#ptr, y);
    }
    // ---- viewport (scrolled-back view over history + screen) ----
    /** Lines currently scrolled back into history (0 = at the bottom). */
    get scrolledBy() {
      return this.#x.term_scrolled_by(this.#ptr);
    }
    /**
     * Scroll the viewport. Positive numbers scroll up into history, negative
     * back down; "top"/"bottom" jump, "page-up"/"page-down" move by a page.
     * Returns true when the viewport moved.
     */
    scrollViewport(action) {
      const SCROLL_PAGE = -999998, SCROLL_FULL = -999997;
      switch (action) {
        case "top":
          return !!this.#x.term_scroll_viewport(this.#ptr, SCROLL_FULL, 1);
        case "bottom":
          return !!this.#x.term_scroll_viewport(this.#ptr, SCROLL_FULL, 0);
        case "page-up":
          return !!this.#x.term_scroll_viewport(this.#ptr, SCROLL_PAGE, 1);
        case "page-down":
          return !!this.#x.term_scroll_viewport(this.#ptr, SCROLL_PAGE, 0);
        default:
          if (!action)
            return false;
          return !!this.#x.term_scroll_viewport(this.#ptr, Math.abs(action), action > 0 ? 1 : 0);
      }
    }
    /** Raw cell snapshot of what the user currently sees at viewport row y. */
    viewportLineCells(y) {
      const ptr = this.#x.term_viewport_line_cells(this.#ptr, y);
      return ptr ? this.#u32(ptr, this.columns * CELL_U32) : null;
    }
    /** Text of viewport row y (accounts for scrollback scrolling). */
    viewportLine(y) {
      const words = this.viewportLineCells(y);
      return words ? rowToString(words, this.columns) : "";
    }
    /** Whether viewport row y is a wrap continuation of the previous row. */
    viewportLineContinued(y) {
      return !!this.#x.term_viewport_line_continued(this.#ptr, y);
    }
    // ---- selection (viewport-relative coordinates, like kitty's mouse path) ----
    /** Begin a selection at viewport cell (x, y), like a mouse press. */
    selectionStart(x, y, opts = {}) {
      this.#x.term_selection_start(this.#ptr, x, y, opts.rectangle ? 1 : 0, opts.extendMode ?? SelectionExtendMode.Cell, opts.inLeftHalf === false ? 0 : 1);
    }
    /** Extend the selection to viewport cell (x, y), like a mouse drag. */
    selectionUpdate(x, y, opts = {}) {
      this.#x.term_selection_update(this.#ptr, x, y, opts.inLeftHalf === false ? 0 : 1, opts.ended === false ? 0 : 1);
    }
    /** Drop the current selection. */
    selectionClear() {
      this.#x.term_selection_clear(this.#ptr);
    }
    /** Extract the selected text; null when nothing is selected. */
    selectionText(opts = {}) {
      const ptr = this.#x.term_selection_text(this.#ptr, opts.ansi ? 1 : 0, opts.stripTrailingWhitespace ? 1 : 0);
      if (!ptr)
        return null;
      const len = this.#x.term_selection_text_len(this.#ptr);
      if (!len)
        return null;
      return this.#decoder.decode(this.#mem().subarray(ptr, ptr + len));
    }
    /** Select the word under (x, y) using kitty's word characters. */
    selectWord(x, y) {
      this.selectionStart(x, y, { extendMode: SelectionExtendMode.Word });
      this.selectionUpdate(x, y, { ended: true });
      return this.selectionText({ stripTrailingWhitespace: true });
    }
    /** Select the full (logical) line at viewport row y. */
    selectLine(y) {
      this.selectionStart(0, y, { extendMode: SelectionExtendMode.Line });
      this.selectionUpdate(0, y, { ended: true });
      return this.selectionText({ stripTrailingWhitespace: true });
    }
    // ---- buffer dumps / serialization (kitty's as_text machinery) ----
    /** Dump the buffer as plain text or ANSI/VT, optionally with scrollback. */
    dump(opts = {}) {
      const ptr = this.#x.term_dump(this.#ptr, opts.history === false ? 0 : 1, opts.ansi ? 1 : 0, opts.wrapMarkers ? 1 : 0);
      const len = this.#x.term_dump_len(this.#ptr);
      return ptr && len ? this.#decoder.decode(this.#mem().subarray(ptr, ptr + len)) : "";
    }
    /**
     * Serialize scrollback + screen as a VT byte stream (SGR attributes and
     * wrap markers included). Writing it into a fresh terminal reproduces the
     * content — a VT-based counterpart to libghostty's binary snapshots.
     */
    serialize() {
      return this.#encoder.encode(this.dump({ history: true, ansi: true, wrapMarkers: false }).replaceAll("\n", "\r\n"));
    }
    /** Shell-integration progress (OSC 9;4). */
    get progress() {
      return {
        state: this.#x.term_progress_state(this.#ptr),
        percent: this.#x.term_progress_percent(this.#ptr)
      };
    }
    /** Tracked kitty-graphics placements (positions only; pixels are host-side). */
    graphicsPlacements() {
      const n = this.#x.term_graphics_placement_count(this.#ptr);
      const out = [];
      for (let i = 0; i < n; i++) {
        const ptr = this.#x.term_graphics_placement_ptr(this.#ptr, i);
        if (!ptr)
          break;
        const [imageId = 0, imageNumber = 0, placementId = 0, col = 0, row = 0, numCols = 0, numRows = 0, z = 0, flags = 0] = this.#u32(ptr, 9);
        out.push({
          imageId,
          imageNumber,
          placementId,
          col,
          row,
          numCols,
          numRows,
          zIndex: z | 0,
          unicodePlacement: !!(flags & 1)
        });
      }
      return out;
    }
    /** Full visible screen as text. */
    text() {
      const lines = [];
      for (let y = 0; y < this.rows; y++)
        lines.push(this.line(y));
      return lines.join("\n");
    }
    /** Raw 8-words-per-cell snapshot of a scrollback line; index 0 is the oldest line. */
    scrollbackLineCells(i) {
      const ptr = this.#x.term_scrollback_line_cells(this.#ptr, i);
      return ptr ? this.#u32(ptr, this.columns * CELL_U32) : null;
    }
    /** Text of a scrollback line; index 0 is the oldest line. */
    scrollbackLine(i) {
      const words = this.scrollbackLineCells(i);
      return words ? rowToString(words, this.columns) : null;
    }
    /** Palette color as 0xRRGGBB (kitty's default 256-color table). */
    paletteColor(index) {
      return this.#x.term_palette_color(this.#ptr, index & 255);
    }
    /** Default foreground, tracking OSC 10. */
    get defaultFg() {
      return decodeColor(this.#x.term_default_fg(this.#ptr));
    }
    /** Default background, tracking OSC 11. */
    get defaultBg() {
      return decodeColor(this.#x.term_default_bg(this.#ptr));
    }
    /** Cursor color, tracking OSC 12. */
    get cursorColor() {
      return decodeColor(this.#x.term_cursor_color(this.#ptr));
    }
    /** Hyperlink target for a cell's hyperlink id ("tag:url" split apart). */
    hyperlink(id) {
      if (!id)
        return null;
      const ref = this.#cstr(this.#x.term_hyperlink_ref(this.#ptr, id));
      if (ref === null)
        return null;
      const sep = ref.indexOf(":");
      const tag = sep > 0 ? ref.slice(0, sep) : "";
      return { url: sep >= 0 ? ref.slice(sep + 1) : ref, id: tag || null };
    }
    /** Resize; kitty rewraps content and refills from scrollback. */
    resize(columns, rows) {
      if (!this.#x.term_resize(this.#ptr, columns, rows))
        throw new Error("invalid resize");
      this.#drain();
    }
    /** Full terminal reset (RIS). */
    reset() {
      this.#x.term_reset(this.#ptr);
      this.#drain();
    }
    /**
     * Encode a key press with kitty's real encoder (key_encoding.c), honoring
     * DECCKM and the active kitty-keyboard-protocol flags.
     * @param key a {@link Key} functional key or a single character
     */
    encodeKey(key, mods = {}, action = "press") {
      const modBits = (mods.shift ? 1 : 0) | (mods.alt ? 2 : 0) | (mods.ctrl ? 4 : 0) | (mods.super ? 8 : 0);
      const actionNum = action === "release" ? 0 : action === "repeat" ? 2 : 1;
      let code;
      let textPtr = 0;
      if (typeof key === "string") {
        code = key.codePointAt(0) ?? 0;
        if (!mods.ctrl && !mods.alt && action !== "release") {
          const bytes = this.#encoder.encode(key);
          const scratch = this.#x.term_text_scratch();
          const cap = this.#x.term_text_scratch_size();
          const n = Math.min(bytes.length, cap - 1);
          this.#mem().set(bytes.subarray(0, n), scratch);
          this.#mem()[scratch + n] = 0;
          textPtr = scratch;
        }
      } else {
        code = key;
      }
      const ptr = this.#x.term_encode_key(this.#ptr, code, 0, 0, modBits, actionNum, textPtr);
      return this.#cstr(ptr) ?? "";
    }
    /** Encode pasted text, honoring bracketed-paste mode (2004). */
    paste(text) {
      const safe = text.replaceAll("\x1B[201~", "");
      return this.mode(2004) === 1 ? `\x1B[200~${safe}\x1B[201~` : safe;
    }
    /** Encode a focus change (mode 1004); empty string when not tracked. */
    encodeFocus(focused) {
      return this.mode(1004) === 1 ? focused ? "\x1B[I" : "\x1B[O" : "";
    }
    /**
     * Encode a mouse event honoring the tracked mode (1000/1002/1003) and
     * protocol (1005 UTF-8, 1006 SGR, 1015 URXVT, 1016 SGR-pixel). Returns ""
     * when the application is not listening for this event.
     */
    encodeMouse(ev) {
      const anyMotion = this.mode(1003) === 1;
      const buttonMotion = this.mode(1002) === 1;
      const clicks = this.mode(1e3) === 1;
      if (!anyMotion && !buttonMotion && !clicks)
        return "";
      const action = ev.action ?? "press";
      const button = ev.button ?? (action === "move" ? "none" : "left");
      if (action === "move") {
        if (!anyMotion && !(buttonMotion && button !== "none"))
          return "";
      }
      const BUTTONS = {
        left: 0,
        middle: 1,
        right: 2,
        none: 3,
        "wheel-up": 64,
        "wheel-down": 65,
        "wheel-left": 66,
        "wheel-right": 67
      };
      let cb = BUTTONS[button];
      if (action === "move")
        cb += 32;
      const m = ev.mods ?? {};
      cb += (m.shift ? 4 : 0) + (m.alt ? 8 : 0) + (m.ctrl ? 16 : 0);
      const release = action === "release";
      if (this.mode(1006) === 1 || this.mode(1016) === 1) {
        return `\x1B[<${cb};${ev.x + 1};${ev.y + 1}${release ? "m" : "M"}`;
      }
      if (this.mode(1015) === 1) {
        return `\x1B[${(release ? BUTTONS.none : cb) + 32};${ev.x + 1};${ev.y + 1}M`;
      }
      const enc = release ? BUTTONS.none + (cb & 28) : cb;
      const coord = (v) => String.fromCharCode(Math.min(v + 33, this.mode(1005) === 1 ? 2047 : 255));
      return `\x1B[M${String.fromCharCode(32 + enc)}${coord(ev.x)}${coord(ev.y)}`;
    }
    /** Free the native terminal. Idempotent; further use throws. */
    dispose() {
      if (this.#t) {
        this.#x.term_free(this.#t);
        this.#t = 0;
      }
    }
    /** `using term = await KittyTerminal.create(...)` support. */
    [Symbol.dispose]() {
      this.dispose();
    }
  }
  var util;
  (function(util2) {
    util2.assertEqual = (_) => {
    };
    function assertIs(_arg) {
    }
    util2.assertIs = assertIs;
    function assertNever(_x) {
      throw new Error();
    }
    util2.assertNever = assertNever;
    util2.arrayToEnum = (items) => {
      const obj = {};
      for (const item of items) {
        obj[item] = item;
      }
      return obj;
    };
    util2.getValidEnumValues = (obj) => {
      const validKeys = util2.objectKeys(obj).filter((k) => typeof obj[obj[k]] !== "number");
      const filtered = {};
      for (const k of validKeys) {
        filtered[k] = obj[k];
      }
      return util2.objectValues(filtered);
    };
    util2.objectValues = (obj) => {
      return util2.objectKeys(obj).map(function(e) {
        return obj[e];
      });
    };
    util2.objectKeys = typeof Object.keys === "function" ? (obj) => Object.keys(obj) : (object) => {
      const keys = [];
      for (const key in object) {
        if (Object.prototype.hasOwnProperty.call(object, key)) {
          keys.push(key);
        }
      }
      return keys;
    };
    util2.find = (arr, checker) => {
      for (const item of arr) {
        if (checker(item))
          return item;
      }
      return void 0;
    };
    util2.isInteger = typeof Number.isInteger === "function" ? (val) => Number.isInteger(val) : (val) => typeof val === "number" && Number.isFinite(val) && Math.floor(val) === val;
    function joinValues(array, separator = " | ") {
      return array.map((val) => typeof val === "string" ? `'${val}'` : val).join(separator);
    }
    util2.joinValues = joinValues;
    util2.jsonStringifyReplacer = (_, value) => {
      if (typeof value === "bigint") {
        return value.toString();
      }
      return value;
    };
  })(util || (util = {}));
  var objectUtil;
  (function(objectUtil2) {
    objectUtil2.mergeShapes = (first, second) => {
      return {
        ...first,
        ...second
        // second overwrites first
      };
    };
  })(objectUtil || (objectUtil = {}));
  const ZodParsedType = util.arrayToEnum([
    "string",
    "nan",
    "number",
    "integer",
    "float",
    "boolean",
    "date",
    "bigint",
    "symbol",
    "function",
    "undefined",
    "null",
    "array",
    "object",
    "unknown",
    "promise",
    "void",
    "never",
    "map",
    "set"
  ]);
  const getParsedType = (data) => {
    const t = typeof data;
    switch (t) {
      case "undefined":
        return ZodParsedType.undefined;
      case "string":
        return ZodParsedType.string;
      case "number":
        return Number.isNaN(data) ? ZodParsedType.nan : ZodParsedType.number;
      case "boolean":
        return ZodParsedType.boolean;
      case "function":
        return ZodParsedType.function;
      case "bigint":
        return ZodParsedType.bigint;
      case "symbol":
        return ZodParsedType.symbol;
      case "object":
        if (Array.isArray(data)) {
          return ZodParsedType.array;
        }
        if (data === null) {
          return ZodParsedType.null;
        }
        if (data.then && typeof data.then === "function" && data.catch && typeof data.catch === "function") {
          return ZodParsedType.promise;
        }
        if (typeof Map !== "undefined" && data instanceof Map) {
          return ZodParsedType.map;
        }
        if (typeof Set !== "undefined" && data instanceof Set) {
          return ZodParsedType.set;
        }
        if (typeof Date !== "undefined" && data instanceof Date) {
          return ZodParsedType.date;
        }
        return ZodParsedType.object;
      default:
        return ZodParsedType.unknown;
    }
  };
  const ZodIssueCode = util.arrayToEnum([
    "invalid_type",
    "invalid_literal",
    "custom",
    "invalid_union",
    "invalid_union_discriminator",
    "invalid_enum_value",
    "unrecognized_keys",
    "invalid_arguments",
    "invalid_return_type",
    "invalid_date",
    "invalid_string",
    "too_small",
    "too_big",
    "invalid_intersection_types",
    "not_multiple_of",
    "not_finite"
  ]);
  class ZodError extends Error {
    get errors() {
      return this.issues;
    }
    constructor(issues) {
      super();
      this.issues = [];
      this.addIssue = (sub) => {
        this.issues = [...this.issues, sub];
      };
      this.addIssues = (subs = []) => {
        this.issues = [...this.issues, ...subs];
      };
      const actualProto = new.target.prototype;
      if (Object.setPrototypeOf) {
        Object.setPrototypeOf(this, actualProto);
      } else {
        this.__proto__ = actualProto;
      }
      this.name = "ZodError";
      this.issues = issues;
    }
    format(_mapper) {
      const mapper = _mapper || function(issue) {
        return issue.message;
      };
      const fieldErrors = { _errors: [] };
      const processError = (error) => {
        for (const issue of error.issues) {
          if (issue.code === "invalid_union") {
            issue.unionErrors.map(processError);
          } else if (issue.code === "invalid_return_type") {
            processError(issue.returnTypeError);
          } else if (issue.code === "invalid_arguments") {
            processError(issue.argumentsError);
          } else if (issue.path.length === 0) {
            fieldErrors._errors.push(mapper(issue));
          } else {
            let curr = fieldErrors;
            let i = 0;
            while (i < issue.path.length) {
              const el = issue.path[i];
              const terminal = i === issue.path.length - 1;
              if (!terminal) {
                curr[el] = curr[el] || { _errors: [] };
              } else {
                curr[el] = curr[el] || { _errors: [] };
                curr[el]._errors.push(mapper(issue));
              }
              curr = curr[el];
              i++;
            }
          }
        }
      };
      processError(this);
      return fieldErrors;
    }
    static assert(value) {
      if (!(value instanceof ZodError)) {
        throw new Error(`Not a ZodError: ${value}`);
      }
    }
    toString() {
      return this.message;
    }
    get message() {
      return JSON.stringify(this.issues, util.jsonStringifyReplacer, 2);
    }
    get isEmpty() {
      return this.issues.length === 0;
    }
    flatten(mapper = (issue) => issue.message) {
      const fieldErrors = {};
      const formErrors = [];
      for (const sub of this.issues) {
        if (sub.path.length > 0) {
          const firstEl = sub.path[0];
          fieldErrors[firstEl] = fieldErrors[firstEl] || [];
          fieldErrors[firstEl].push(mapper(sub));
        } else {
          formErrors.push(mapper(sub));
        }
      }
      return { formErrors, fieldErrors };
    }
    get formErrors() {
      return this.flatten();
    }
  }
  ZodError.create = (issues) => {
    const error = new ZodError(issues);
    return error;
  };
  const errorMap = (issue, _ctx) => {
    let message;
    switch (issue.code) {
      case ZodIssueCode.invalid_type:
        if (issue.received === ZodParsedType.undefined) {
          message = "Required";
        } else {
          message = `Expected ${issue.expected}, received ${issue.received}`;
        }
        break;
      case ZodIssueCode.invalid_literal:
        message = `Invalid literal value, expected ${JSON.stringify(issue.expected, util.jsonStringifyReplacer)}`;
        break;
      case ZodIssueCode.unrecognized_keys:
        message = `Unrecognized key(s) in object: ${util.joinValues(issue.keys, ", ")}`;
        break;
      case ZodIssueCode.invalid_union:
        message = `Invalid input`;
        break;
      case ZodIssueCode.invalid_union_discriminator:
        message = `Invalid discriminator value. Expected ${util.joinValues(issue.options)}`;
        break;
      case ZodIssueCode.invalid_enum_value:
        message = `Invalid enum value. Expected ${util.joinValues(issue.options)}, received '${issue.received}'`;
        break;
      case ZodIssueCode.invalid_arguments:
        message = `Invalid function arguments`;
        break;
      case ZodIssueCode.invalid_return_type:
        message = `Invalid function return type`;
        break;
      case ZodIssueCode.invalid_date:
        message = `Invalid date`;
        break;
      case ZodIssueCode.invalid_string:
        if (typeof issue.validation === "object") {
          if ("includes" in issue.validation) {
            message = `Invalid input: must include "${issue.validation.includes}"`;
            if (typeof issue.validation.position === "number") {
              message = `${message} at one or more positions greater than or equal to ${issue.validation.position}`;
            }
          } else if ("startsWith" in issue.validation) {
            message = `Invalid input: must start with "${issue.validation.startsWith}"`;
          } else if ("endsWith" in issue.validation) {
            message = `Invalid input: must end with "${issue.validation.endsWith}"`;
          } else {
            util.assertNever(issue.validation);
          }
        } else if (issue.validation !== "regex") {
          message = `Invalid ${issue.validation}`;
        } else {
          message = "Invalid";
        }
        break;
      case ZodIssueCode.too_small:
        if (issue.type === "array")
          message = `Array must contain ${issue.exact ? "exactly" : issue.inclusive ? `at least` : `more than`} ${issue.minimum} element(s)`;
        else if (issue.type === "string")
          message = `String must contain ${issue.exact ? "exactly" : issue.inclusive ? `at least` : `over`} ${issue.minimum} character(s)`;
        else if (issue.type === "number")
          message = `Number must be ${issue.exact ? `exactly equal to ` : issue.inclusive ? `greater than or equal to ` : `greater than `}${issue.minimum}`;
        else if (issue.type === "bigint")
          message = `Number must be ${issue.exact ? `exactly equal to ` : issue.inclusive ? `greater than or equal to ` : `greater than `}${issue.minimum}`;
        else if (issue.type === "date")
          message = `Date must be ${issue.exact ? `exactly equal to ` : issue.inclusive ? `greater than or equal to ` : `greater than `}${new Date(Number(issue.minimum))}`;
        else
          message = "Invalid input";
        break;
      case ZodIssueCode.too_big:
        if (issue.type === "array")
          message = `Array must contain ${issue.exact ? `exactly` : issue.inclusive ? `at most` : `less than`} ${issue.maximum} element(s)`;
        else if (issue.type === "string")
          message = `String must contain ${issue.exact ? `exactly` : issue.inclusive ? `at most` : `under`} ${issue.maximum} character(s)`;
        else if (issue.type === "number")
          message = `Number must be ${issue.exact ? `exactly` : issue.inclusive ? `less than or equal to` : `less than`} ${issue.maximum}`;
        else if (issue.type === "bigint")
          message = `BigInt must be ${issue.exact ? `exactly` : issue.inclusive ? `less than or equal to` : `less than`} ${issue.maximum}`;
        else if (issue.type === "date")
          message = `Date must be ${issue.exact ? `exactly` : issue.inclusive ? `smaller than or equal to` : `smaller than`} ${new Date(Number(issue.maximum))}`;
        else
          message = "Invalid input";
        break;
      case ZodIssueCode.custom:
        message = `Invalid input`;
        break;
      case ZodIssueCode.invalid_intersection_types:
        message = `Intersection results could not be merged`;
        break;
      case ZodIssueCode.not_multiple_of:
        message = `Number must be a multiple of ${issue.multipleOf}`;
        break;
      case ZodIssueCode.not_finite:
        message = "Number must be finite";
        break;
      default:
        message = _ctx.defaultError;
        util.assertNever(issue);
    }
    return { message };
  };
  let overrideErrorMap = errorMap;
  function getErrorMap() {
    return overrideErrorMap;
  }
  const makeIssue = (params) => {
    const { data, path, errorMaps, issueData } = params;
    const fullPath = [...path, ...issueData.path || []];
    const fullIssue = {
      ...issueData,
      path: fullPath
    };
    if (issueData.message !== void 0) {
      return {
        ...issueData,
        path: fullPath,
        message: issueData.message
      };
    }
    let errorMessage = "";
    const maps = errorMaps.filter((m) => !!m).slice().reverse();
    for (const map of maps) {
      errorMessage = map(fullIssue, { data, defaultError: errorMessage }).message;
    }
    return {
      ...issueData,
      path: fullPath,
      message: errorMessage
    };
  };
  function addIssueToContext(ctx, issueData) {
    const overrideMap = getErrorMap();
    const issue = makeIssue({
      issueData,
      data: ctx.data,
      path: ctx.path,
      errorMaps: [
        ctx.common.contextualErrorMap,
        // contextual error map is first priority
        ctx.schemaErrorMap,
        // then schema-bound map if available
        overrideMap,
        // then global override map
        overrideMap === errorMap ? void 0 : errorMap
        // then global default map
      ].filter((x) => !!x)
    });
    ctx.common.issues.push(issue);
  }
  class ParseStatus {
    constructor() {
      this.value = "valid";
    }
    dirty() {
      if (this.value === "valid")
        this.value = "dirty";
    }
    abort() {
      if (this.value !== "aborted")
        this.value = "aborted";
    }
    static mergeArray(status, results) {
      const arrayValue = [];
      for (const s of results) {
        if (s.status === "aborted")
          return INVALID;
        if (s.status === "dirty")
          status.dirty();
        arrayValue.push(s.value);
      }
      return { status: status.value, value: arrayValue };
    }
    static async mergeObjectAsync(status, pairs) {
      const syncPairs = [];
      for (const pair of pairs) {
        const key = await pair.key;
        const value = await pair.value;
        syncPairs.push({
          key,
          value
        });
      }
      return ParseStatus.mergeObjectSync(status, syncPairs);
    }
    static mergeObjectSync(status, pairs) {
      const finalObject = {};
      for (const pair of pairs) {
        const { key, value } = pair;
        if (key.status === "aborted")
          return INVALID;
        if (value.status === "aborted")
          return INVALID;
        if (key.status === "dirty")
          status.dirty();
        if (value.status === "dirty")
          status.dirty();
        if (key.value !== "__proto__" && (typeof value.value !== "undefined" || pair.alwaysSet)) {
          finalObject[key.value] = value.value;
        }
      }
      return { status: status.value, value: finalObject };
    }
  }
  const INVALID = Object.freeze({
    status: "aborted"
  });
  const DIRTY = (value) => ({ status: "dirty", value });
  const OK = (value) => ({ status: "valid", value });
  const isAborted = (x) => x.status === "aborted";
  const isDirty = (x) => x.status === "dirty";
  const isValid = (x) => x.status === "valid";
  const isAsync = (x) => typeof Promise !== "undefined" && x instanceof Promise;
  var errorUtil;
  (function(errorUtil2) {
    errorUtil2.errToObj = (message) => typeof message === "string" ? { message } : message || {};
    errorUtil2.toString = (message) => typeof message === "string" ? message : message?.message;
  })(errorUtil || (errorUtil = {}));
  class ParseInputLazyPath {
    constructor(parent, value, path, key) {
      this._cachedPath = [];
      this.parent = parent;
      this.data = value;
      this._path = path;
      this._key = key;
    }
    get path() {
      if (!this._cachedPath.length) {
        if (Array.isArray(this._key)) {
          this._cachedPath.push(...this._path, ...this._key);
        } else {
          this._cachedPath.push(...this._path, this._key);
        }
      }
      return this._cachedPath;
    }
  }
  const handleResult = (ctx, result) => {
    if (isValid(result)) {
      return { success: true, data: result.value };
    } else {
      if (!ctx.common.issues.length) {
        throw new Error("Validation failed but no issues detected.");
      }
      return {
        success: false,
        get error() {
          if (this._error)
            return this._error;
          const error = new ZodError(ctx.common.issues);
          this._error = error;
          return this._error;
        }
      };
    }
  };
  function processCreateParams(params) {
    if (!params)
      return {};
    const { errorMap: errorMap2, invalid_type_error, required_error, description } = params;
    if (errorMap2 && (invalid_type_error || required_error)) {
      throw new Error(`Can't use "invalid_type_error" or "required_error" in conjunction with custom error map.`);
    }
    if (errorMap2)
      return { errorMap: errorMap2, description };
    const customMap = (iss, ctx) => {
      const { message } = params;
      if (iss.code === "invalid_enum_value") {
        return { message: message ?? ctx.defaultError };
      }
      if (typeof ctx.data === "undefined") {
        return { message: message ?? required_error ?? ctx.defaultError };
      }
      if (iss.code !== "invalid_type")
        return { message: ctx.defaultError };
      return { message: message ?? invalid_type_error ?? ctx.defaultError };
    };
    return { errorMap: customMap, description };
  }
  class ZodType {
    get description() {
      return this._def.description;
    }
    _getType(input) {
      return getParsedType(input.data);
    }
    _getOrReturnCtx(input, ctx) {
      return ctx || {
        common: input.parent.common,
        data: input.data,
        parsedType: getParsedType(input.data),
        schemaErrorMap: this._def.errorMap,
        path: input.path,
        parent: input.parent
      };
    }
    _processInputParams(input) {
      return {
        status: new ParseStatus(),
        ctx: {
          common: input.parent.common,
          data: input.data,
          parsedType: getParsedType(input.data),
          schemaErrorMap: this._def.errorMap,
          path: input.path,
          parent: input.parent
        }
      };
    }
    _parseSync(input) {
      const result = this._parse(input);
      if (isAsync(result)) {
        throw new Error("Synchronous parse encountered promise.");
      }
      return result;
    }
    _parseAsync(input) {
      const result = this._parse(input);
      return Promise.resolve(result);
    }
    parse(data, params) {
      const result = this.safeParse(data, params);
      if (result.success)
        return result.data;
      throw result.error;
    }
    safeParse(data, params) {
      const ctx = {
        common: {
          issues: [],
          async: params?.async ?? false,
          contextualErrorMap: params?.errorMap
        },
        path: params?.path || [],
        schemaErrorMap: this._def.errorMap,
        parent: null,
        data,
        parsedType: getParsedType(data)
      };
      const result = this._parseSync({ data, path: ctx.path, parent: ctx });
      return handleResult(ctx, result);
    }
    "~validate"(data) {
      const ctx = {
        common: {
          issues: [],
          async: !!this["~standard"].async
        },
        path: [],
        schemaErrorMap: this._def.errorMap,
        parent: null,
        data,
        parsedType: getParsedType(data)
      };
      if (!this["~standard"].async) {
        try {
          const result = this._parseSync({ data, path: [], parent: ctx });
          return isValid(result) ? {
            value: result.value
          } : {
            issues: ctx.common.issues
          };
        } catch (err) {
          if (err?.message?.toLowerCase()?.includes("encountered")) {
            this["~standard"].async = true;
          }
          ctx.common = {
            issues: [],
            async: true
          };
        }
      }
      return this._parseAsync({ data, path: [], parent: ctx }).then((result) => isValid(result) ? {
        value: result.value
      } : {
        issues: ctx.common.issues
      });
    }
    async parseAsync(data, params) {
      const result = await this.safeParseAsync(data, params);
      if (result.success)
        return result.data;
      throw result.error;
    }
    async safeParseAsync(data, params) {
      const ctx = {
        common: {
          issues: [],
          contextualErrorMap: params?.errorMap,
          async: true
        },
        path: params?.path || [],
        schemaErrorMap: this._def.errorMap,
        parent: null,
        data,
        parsedType: getParsedType(data)
      };
      const maybeAsyncResult = this._parse({ data, path: ctx.path, parent: ctx });
      const result = await (isAsync(maybeAsyncResult) ? maybeAsyncResult : Promise.resolve(maybeAsyncResult));
      return handleResult(ctx, result);
    }
    refine(check, message) {
      const getIssueProperties = (val) => {
        if (typeof message === "string" || typeof message === "undefined") {
          return { message };
        } else if (typeof message === "function") {
          return message(val);
        } else {
          return message;
        }
      };
      return this._refinement((val, ctx) => {
        const result = check(val);
        const setError = () => ctx.addIssue({
          code: ZodIssueCode.custom,
          ...getIssueProperties(val)
        });
        if (typeof Promise !== "undefined" && result instanceof Promise) {
          return result.then((data) => {
            if (!data) {
              setError();
              return false;
            } else {
              return true;
            }
          });
        }
        if (!result) {
          setError();
          return false;
        } else {
          return true;
        }
      });
    }
    refinement(check, refinementData) {
      return this._refinement((val, ctx) => {
        if (!check(val)) {
          ctx.addIssue(typeof refinementData === "function" ? refinementData(val, ctx) : refinementData);
          return false;
        } else {
          return true;
        }
      });
    }
    _refinement(refinement) {
      return new ZodEffects({
        schema: this,
        typeName: ZodFirstPartyTypeKind.ZodEffects,
        effect: { type: "refinement", refinement }
      });
    }
    superRefine(refinement) {
      return this._refinement(refinement);
    }
    constructor(def) {
      this.spa = this.safeParseAsync;
      this._def = def;
      this.parse = this.parse.bind(this);
      this.safeParse = this.safeParse.bind(this);
      this.parseAsync = this.parseAsync.bind(this);
      this.safeParseAsync = this.safeParseAsync.bind(this);
      this.spa = this.spa.bind(this);
      this.refine = this.refine.bind(this);
      this.refinement = this.refinement.bind(this);
      this.superRefine = this.superRefine.bind(this);
      this.optional = this.optional.bind(this);
      this.nullable = this.nullable.bind(this);
      this.nullish = this.nullish.bind(this);
      this.array = this.array.bind(this);
      this.promise = this.promise.bind(this);
      this.or = this.or.bind(this);
      this.and = this.and.bind(this);
      this.transform = this.transform.bind(this);
      this.brand = this.brand.bind(this);
      this.default = this.default.bind(this);
      this.catch = this.catch.bind(this);
      this.describe = this.describe.bind(this);
      this.pipe = this.pipe.bind(this);
      this.readonly = this.readonly.bind(this);
      this.isNullable = this.isNullable.bind(this);
      this.isOptional = this.isOptional.bind(this);
      this["~standard"] = {
        version: 1,
        vendor: "zod",
        validate: (data) => this["~validate"](data)
      };
    }
    optional() {
      return ZodOptional.create(this, this._def);
    }
    nullable() {
      return ZodNullable.create(this, this._def);
    }
    nullish() {
      return this.nullable().optional();
    }
    array() {
      return ZodArray.create(this);
    }
    promise() {
      return ZodPromise.create(this, this._def);
    }
    or(option) {
      return ZodUnion.create([this, option], this._def);
    }
    and(incoming) {
      return ZodIntersection.create(this, incoming, this._def);
    }
    transform(transform) {
      return new ZodEffects({
        ...processCreateParams(this._def),
        schema: this,
        typeName: ZodFirstPartyTypeKind.ZodEffects,
        effect: { type: "transform", transform }
      });
    }
    default(def) {
      const defaultValueFunc = typeof def === "function" ? def : () => def;
      return new ZodDefault({
        ...processCreateParams(this._def),
        innerType: this,
        defaultValue: defaultValueFunc,
        typeName: ZodFirstPartyTypeKind.ZodDefault
      });
    }
    brand() {
      return new ZodBranded({
        typeName: ZodFirstPartyTypeKind.ZodBranded,
        type: this,
        ...processCreateParams(this._def)
      });
    }
    catch(def) {
      const catchValueFunc = typeof def === "function" ? def : () => def;
      return new ZodCatch({
        ...processCreateParams(this._def),
        innerType: this,
        catchValue: catchValueFunc,
        typeName: ZodFirstPartyTypeKind.ZodCatch
      });
    }
    describe(description) {
      const This = this.constructor;
      return new This({
        ...this._def,
        description
      });
    }
    pipe(target) {
      return ZodPipeline.create(this, target);
    }
    readonly() {
      return ZodReadonly.create(this);
    }
    isOptional() {
      return this.safeParse(void 0).success;
    }
    isNullable() {
      return this.safeParse(null).success;
    }
  }
  const cuidRegex = /^c[^\s-]{8,}$/i;
  const cuid2Regex = /^[0-9a-z]+$/;
  const ulidRegex = /^[0-9A-HJKMNP-TV-Z]{26}$/i;
  const uuidRegex = /^[0-9a-fA-F]{8}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{12}$/i;
  const nanoidRegex = /^[a-z0-9_-]{21}$/i;
  const jwtRegex = /^[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+\.[A-Za-z0-9-_]*$/;
  const durationRegex = /^[-+]?P(?!$)(?:(?:[-+]?\d+Y)|(?:[-+]?\d+[.,]\d+Y$))?(?:(?:[-+]?\d+M)|(?:[-+]?\d+[.,]\d+M$))?(?:(?:[-+]?\d+W)|(?:[-+]?\d+[.,]\d+W$))?(?:(?:[-+]?\d+D)|(?:[-+]?\d+[.,]\d+D$))?(?:T(?=[\d+-])(?:(?:[-+]?\d+H)|(?:[-+]?\d+[.,]\d+H$))?(?:(?:[-+]?\d+M)|(?:[-+]?\d+[.,]\d+M$))?(?:[-+]?\d+(?:[.,]\d+)?S)?)??$/;
  const emailRegex = /^(?!\.)(?!.*\.\.)([A-Z0-9_'+\-\.]*)[A-Z0-9_+-]@([A-Z0-9][A-Z0-9\-]*\.)+[A-Z]{2,}$/i;
  const _emojiRegex = `^(\\p{Extended_Pictographic}|\\p{Emoji_Component})+$`;
  let emojiRegex;
  const ipv4Regex = /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])$/;
  const ipv4CidrRegex = /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\/(3[0-2]|[12]?[0-9])$/;
  const ipv6Regex = /^(([0-9a-fA-F]{1,4}:){7,7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:)|fe80:(:[0-9a-fA-F]{0,4}){0,4}%[0-9a-zA-Z]{1,}|::(ffff(:0{1,4}){0,1}:){0,1}((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])|([0-9a-fA-F]{1,4}:){1,4}:((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9]))$/;
  const ipv6CidrRegex = /^(([0-9a-fA-F]{1,4}:){7,7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:)|fe80:(:[0-9a-fA-F]{0,4}){0,4}%[0-9a-zA-Z]{1,}|::(ffff(:0{1,4}){0,1}:){0,1}((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])|([0-9a-fA-F]{1,4}:){1,4}:((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9]))\/(12[0-8]|1[01][0-9]|[1-9]?[0-9])$/;
  const base64Regex = /^([0-9a-zA-Z+/]{4})*(([0-9a-zA-Z+/]{2}==)|([0-9a-zA-Z+/]{3}=))?$/;
  const base64urlRegex = /^([0-9a-zA-Z-_]{4})*(([0-9a-zA-Z-_]{2}(==)?)|([0-9a-zA-Z-_]{3}(=)?))?$/;
  const dateRegexSource = `((\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-((0[13578]|1[02])-(0[1-9]|[12]\\d|3[01])|(0[469]|11)-(0[1-9]|[12]\\d|30)|(02)-(0[1-9]|1\\d|2[0-8])))`;
  const dateRegex = new RegExp(`^${dateRegexSource}$`);
  function timeRegexSource(args) {
    let secondsRegexSource = `[0-5]\\d`;
    if (args.precision) {
      secondsRegexSource = `${secondsRegexSource}\\.\\d{${args.precision}}`;
    } else if (args.precision == null) {
      secondsRegexSource = `${secondsRegexSource}(\\.\\d+)?`;
    }
    const secondsQuantifier = args.precision ? "+" : "?";
    return `([01]\\d|2[0-3]):[0-5]\\d(:${secondsRegexSource})${secondsQuantifier}`;
  }
  function timeRegex(args) {
    return new RegExp(`^${timeRegexSource(args)}$`);
  }
  function datetimeRegex(args) {
    let regex = `${dateRegexSource}T${timeRegexSource(args)}`;
    const opts = [];
    opts.push(args.local ? `Z?` : `Z`);
    if (args.offset)
      opts.push(`([+-]\\d{2}:?\\d{2})`);
    regex = `${regex}(${opts.join("|")})`;
    return new RegExp(`^${regex}$`);
  }
  function isValidIP(ip, version) {
    if ((version === "v4" || !version) && ipv4Regex.test(ip)) {
      return true;
    }
    if ((version === "v6" || !version) && ipv6Regex.test(ip)) {
      return true;
    }
    return false;
  }
  function isValidJWT(jwt, alg) {
    if (!jwtRegex.test(jwt))
      return false;
    try {
      const [header] = jwt.split(".");
      if (!header)
        return false;
      const base64 = header.replace(/-/g, "+").replace(/_/g, "/").padEnd(header.length + (4 - header.length % 4) % 4, "=");
      const decoded = JSON.parse(atob(base64));
      if (typeof decoded !== "object" || decoded === null)
        return false;
      if ("typ" in decoded && decoded?.typ !== "JWT")
        return false;
      if (!decoded.alg)
        return false;
      if (alg && decoded.alg !== alg)
        return false;
      return true;
    } catch {
      return false;
    }
  }
  function isValidCidr(ip, version) {
    if ((version === "v4" || !version) && ipv4CidrRegex.test(ip)) {
      return true;
    }
    if ((version === "v6" || !version) && ipv6CidrRegex.test(ip)) {
      return true;
    }
    return false;
  }
  class ZodString extends ZodType {
    _parse(input) {
      if (this._def.coerce) {
        input.data = String(input.data);
      }
      const parsedType = this._getType(input);
      if (parsedType !== ZodParsedType.string) {
        const ctx2 = this._getOrReturnCtx(input);
        addIssueToContext(ctx2, {
          code: ZodIssueCode.invalid_type,
          expected: ZodParsedType.string,
          received: ctx2.parsedType
        });
        return INVALID;
      }
      const status = new ParseStatus();
      let ctx = void 0;
      for (const check of this._def.checks) {
        if (check.kind === "min") {
          if (input.data.length < check.value) {
            ctx = this._getOrReturnCtx(input, ctx);
            addIssueToContext(ctx, {
              code: ZodIssueCode.too_small,
              minimum: check.value,
              type: "string",
              inclusive: true,
              exact: false,
              message: check.message
            });
            status.dirty();
          }
        } else if (check.kind === "max") {
          if (input.data.length > check.value) {
            ctx = this._getOrReturnCtx(input, ctx);
            addIssueToContext(ctx, {
              code: ZodIssueCode.too_big,
              maximum: check.value,
              type: "string",
              inclusive: true,
              exact: false,
              message: check.message
            });
            status.dirty();
          }
        } else if (check.kind === "length") {
          const tooBig = input.data.length > check.value;
          const tooSmall = input.data.length < check.value;
          if (tooBig || tooSmall) {
            ctx = this._getOrReturnCtx(input, ctx);
            if (tooBig) {
              addIssueToContext(ctx, {
                code: ZodIssueCode.too_big,
                maximum: check.value,
                type: "string",
                inclusive: true,
                exact: true,
                message: check.message
              });
            } else if (tooSmall) {
              addIssueToContext(ctx, {
                code: ZodIssueCode.too_small,
                minimum: check.value,
                type: "string",
                inclusive: true,
                exact: true,
                message: check.message
              });
            }
            status.dirty();
          }
        } else if (check.kind === "email") {
          if (!emailRegex.test(input.data)) {
            ctx = this._getOrReturnCtx(input, ctx);
            addIssueToContext(ctx, {
              validation: "email",
              code: ZodIssueCode.invalid_string,
              message: check.message
            });
            status.dirty();
          }
        } else if (check.kind === "emoji") {
          if (!emojiRegex) {
            emojiRegex = new RegExp(_emojiRegex, "u");
          }
          if (!emojiRegex.test(input.data)) {
            ctx = this._getOrReturnCtx(input, ctx);
            addIssueToContext(ctx, {
              validation: "emoji",
              code: ZodIssueCode.invalid_string,
              message: check.message
            });
            status.dirty();
          }
        } else if (check.kind === "uuid") {
          if (!uuidRegex.test(input.data)) {
            ctx = this._getOrReturnCtx(input, ctx);
            addIssueToContext(ctx, {
              validation: "uuid",
              code: ZodIssueCode.invalid_string,
              message: check.message
            });
            status.dirty();
          }
        } else if (check.kind === "nanoid") {
          if (!nanoidRegex.test(input.data)) {
            ctx = this._getOrReturnCtx(input, ctx);
            addIssueToContext(ctx, {
              validation: "nanoid",
              code: ZodIssueCode.invalid_string,
              message: check.message
            });
            status.dirty();
          }
        } else if (check.kind === "cuid") {
          if (!cuidRegex.test(input.data)) {
            ctx = this._getOrReturnCtx(input, ctx);
            addIssueToContext(ctx, {
              validation: "cuid",
              code: ZodIssueCode.invalid_string,
              message: check.message
            });
            status.dirty();
          }
        } else if (check.kind === "cuid2") {
          if (!cuid2Regex.test(input.data)) {
            ctx = this._getOrReturnCtx(input, ctx);
            addIssueToContext(ctx, {
              validation: "cuid2",
              code: ZodIssueCode.invalid_string,
              message: check.message
            });
            status.dirty();
          }
        } else if (check.kind === "ulid") {
          if (!ulidRegex.test(input.data)) {
            ctx = this._getOrReturnCtx(input, ctx);
            addIssueToContext(ctx, {
              validation: "ulid",
              code: ZodIssueCode.invalid_string,
              message: check.message
            });
            status.dirty();
          }
        } else if (check.kind === "url") {
          try {
            new URL(input.data);
          } catch {
            ctx = this._getOrReturnCtx(input, ctx);
            addIssueToContext(ctx, {
              validation: "url",
              code: ZodIssueCode.invalid_string,
              message: check.message
            });
            status.dirty();
          }
        } else if (check.kind === "regex") {
          check.regex.lastIndex = 0;
          const testResult = check.regex.test(input.data);
          if (!testResult) {
            ctx = this._getOrReturnCtx(input, ctx);
            addIssueToContext(ctx, {
              validation: "regex",
              code: ZodIssueCode.invalid_string,
              message: check.message
            });
            status.dirty();
          }
        } else if (check.kind === "trim") {
          input.data = input.data.trim();
        } else if (check.kind === "includes") {
          if (!input.data.includes(check.value, check.position)) {
            ctx = this._getOrReturnCtx(input, ctx);
            addIssueToContext(ctx, {
              code: ZodIssueCode.invalid_string,
              validation: { includes: check.value, position: check.position },
              message: check.message
            });
            status.dirty();
          }
        } else if (check.kind === "toLowerCase") {
          input.data = input.data.toLowerCase();
        } else if (check.kind === "toUpperCase") {
          input.data = input.data.toUpperCase();
        } else if (check.kind === "startsWith") {
          if (!input.data.startsWith(check.value)) {
            ctx = this._getOrReturnCtx(input, ctx);
            addIssueToContext(ctx, {
              code: ZodIssueCode.invalid_string,
              validation: { startsWith: check.value },
              message: check.message
            });
            status.dirty();
          }
        } else if (check.kind === "endsWith") {
          if (!input.data.endsWith(check.value)) {
            ctx = this._getOrReturnCtx(input, ctx);
            addIssueToContext(ctx, {
              code: ZodIssueCode.invalid_string,
              validation: { endsWith: check.value },
              message: check.message
            });
            status.dirty();
          }
        } else if (check.kind === "datetime") {
          const regex = datetimeRegex(check);
          if (!regex.test(input.data)) {
            ctx = this._getOrReturnCtx(input, ctx);
            addIssueToContext(ctx, {
              code: ZodIssueCode.invalid_string,
              validation: "datetime",
              message: check.message
            });
            status.dirty();
          }
        } else if (check.kind === "date") {
          const regex = dateRegex;
          if (!regex.test(input.data)) {
            ctx = this._getOrReturnCtx(input, ctx);
            addIssueToContext(ctx, {
              code: ZodIssueCode.invalid_string,
              validation: "date",
              message: check.message
            });
            status.dirty();
          }
        } else if (check.kind === "time") {
          const regex = timeRegex(check);
          if (!regex.test(input.data)) {
            ctx = this._getOrReturnCtx(input, ctx);
            addIssueToContext(ctx, {
              code: ZodIssueCode.invalid_string,
              validation: "time",
              message: check.message
            });
            status.dirty();
          }
        } else if (check.kind === "duration") {
          if (!durationRegex.test(input.data)) {
            ctx = this._getOrReturnCtx(input, ctx);
            addIssueToContext(ctx, {
              validation: "duration",
              code: ZodIssueCode.invalid_string,
              message: check.message
            });
            status.dirty();
          }
        } else if (check.kind === "ip") {
          if (!isValidIP(input.data, check.version)) {
            ctx = this._getOrReturnCtx(input, ctx);
            addIssueToContext(ctx, {
              validation: "ip",
              code: ZodIssueCode.invalid_string,
              message: check.message
            });
            status.dirty();
          }
        } else if (check.kind === "jwt") {
          if (!isValidJWT(input.data, check.alg)) {
            ctx = this._getOrReturnCtx(input, ctx);
            addIssueToContext(ctx, {
              validation: "jwt",
              code: ZodIssueCode.invalid_string,
              message: check.message
            });
            status.dirty();
          }
        } else if (check.kind === "cidr") {
          if (!isValidCidr(input.data, check.version)) {
            ctx = this._getOrReturnCtx(input, ctx);
            addIssueToContext(ctx, {
              validation: "cidr",
              code: ZodIssueCode.invalid_string,
              message: check.message
            });
            status.dirty();
          }
        } else if (check.kind === "base64") {
          if (!base64Regex.test(input.data)) {
            ctx = this._getOrReturnCtx(input, ctx);
            addIssueToContext(ctx, {
              validation: "base64",
              code: ZodIssueCode.invalid_string,
              message: check.message
            });
            status.dirty();
          }
        } else if (check.kind === "base64url") {
          if (!base64urlRegex.test(input.data)) {
            ctx = this._getOrReturnCtx(input, ctx);
            addIssueToContext(ctx, {
              validation: "base64url",
              code: ZodIssueCode.invalid_string,
              message: check.message
            });
            status.dirty();
          }
        } else {
          util.assertNever(check);
        }
      }
      return { status: status.value, value: input.data };
    }
    _regex(regex, validation, message) {
      return this.refinement((data) => regex.test(data), {
        validation,
        code: ZodIssueCode.invalid_string,
        ...errorUtil.errToObj(message)
      });
    }
    _addCheck(check) {
      return new ZodString({
        ...this._def,
        checks: [...this._def.checks, check]
      });
    }
    email(message) {
      return this._addCheck({ kind: "email", ...errorUtil.errToObj(message) });
    }
    url(message) {
      return this._addCheck({ kind: "url", ...errorUtil.errToObj(message) });
    }
    emoji(message) {
      return this._addCheck({ kind: "emoji", ...errorUtil.errToObj(message) });
    }
    uuid(message) {
      return this._addCheck({ kind: "uuid", ...errorUtil.errToObj(message) });
    }
    nanoid(message) {
      return this._addCheck({ kind: "nanoid", ...errorUtil.errToObj(message) });
    }
    cuid(message) {
      return this._addCheck({ kind: "cuid", ...errorUtil.errToObj(message) });
    }
    cuid2(message) {
      return this._addCheck({ kind: "cuid2", ...errorUtil.errToObj(message) });
    }
    ulid(message) {
      return this._addCheck({ kind: "ulid", ...errorUtil.errToObj(message) });
    }
    base64(message) {
      return this._addCheck({ kind: "base64", ...errorUtil.errToObj(message) });
    }
    base64url(message) {
      return this._addCheck({
        kind: "base64url",
        ...errorUtil.errToObj(message)
      });
    }
    jwt(options) {
      return this._addCheck({ kind: "jwt", ...errorUtil.errToObj(options) });
    }
    ip(options) {
      return this._addCheck({ kind: "ip", ...errorUtil.errToObj(options) });
    }
    cidr(options) {
      return this._addCheck({ kind: "cidr", ...errorUtil.errToObj(options) });
    }
    datetime(options) {
      if (typeof options === "string") {
        return this._addCheck({
          kind: "datetime",
          precision: null,
          offset: false,
          local: false,
          message: options
        });
      }
      return this._addCheck({
        kind: "datetime",
        precision: typeof options?.precision === "undefined" ? null : options?.precision,
        offset: options?.offset ?? false,
        local: options?.local ?? false,
        ...errorUtil.errToObj(options?.message)
      });
    }
    date(message) {
      return this._addCheck({ kind: "date", message });
    }
    time(options) {
      if (typeof options === "string") {
        return this._addCheck({
          kind: "time",
          precision: null,
          message: options
        });
      }
      return this._addCheck({
        kind: "time",
        precision: typeof options?.precision === "undefined" ? null : options?.precision,
        ...errorUtil.errToObj(options?.message)
      });
    }
    duration(message) {
      return this._addCheck({ kind: "duration", ...errorUtil.errToObj(message) });
    }
    regex(regex, message) {
      return this._addCheck({
        kind: "regex",
        regex,
        ...errorUtil.errToObj(message)
      });
    }
    includes(value, options) {
      return this._addCheck({
        kind: "includes",
        value,
        position: options?.position,
        ...errorUtil.errToObj(options?.message)
      });
    }
    startsWith(value, message) {
      return this._addCheck({
        kind: "startsWith",
        value,
        ...errorUtil.errToObj(message)
      });
    }
    endsWith(value, message) {
      return this._addCheck({
        kind: "endsWith",
        value,
        ...errorUtil.errToObj(message)
      });
    }
    min(minLength, message) {
      return this._addCheck({
        kind: "min",
        value: minLength,
        ...errorUtil.errToObj(message)
      });
    }
    max(maxLength, message) {
      return this._addCheck({
        kind: "max",
        value: maxLength,
        ...errorUtil.errToObj(message)
      });
    }
    length(len, message) {
      return this._addCheck({
        kind: "length",
        value: len,
        ...errorUtil.errToObj(message)
      });
    }
    /**
     * Equivalent to `.min(1)`
     */
    nonempty(message) {
      return this.min(1, errorUtil.errToObj(message));
    }
    trim() {
      return new ZodString({
        ...this._def,
        checks: [...this._def.checks, { kind: "trim" }]
      });
    }
    toLowerCase() {
      return new ZodString({
        ...this._def,
        checks: [...this._def.checks, { kind: "toLowerCase" }]
      });
    }
    toUpperCase() {
      return new ZodString({
        ...this._def,
        checks: [...this._def.checks, { kind: "toUpperCase" }]
      });
    }
    get isDatetime() {
      return !!this._def.checks.find((ch) => ch.kind === "datetime");
    }
    get isDate() {
      return !!this._def.checks.find((ch) => ch.kind === "date");
    }
    get isTime() {
      return !!this._def.checks.find((ch) => ch.kind === "time");
    }
    get isDuration() {
      return !!this._def.checks.find((ch) => ch.kind === "duration");
    }
    get isEmail() {
      return !!this._def.checks.find((ch) => ch.kind === "email");
    }
    get isURL() {
      return !!this._def.checks.find((ch) => ch.kind === "url");
    }
    get isEmoji() {
      return !!this._def.checks.find((ch) => ch.kind === "emoji");
    }
    get isUUID() {
      return !!this._def.checks.find((ch) => ch.kind === "uuid");
    }
    get isNANOID() {
      return !!this._def.checks.find((ch) => ch.kind === "nanoid");
    }
    get isCUID() {
      return !!this._def.checks.find((ch) => ch.kind === "cuid");
    }
    get isCUID2() {
      return !!this._def.checks.find((ch) => ch.kind === "cuid2");
    }
    get isULID() {
      return !!this._def.checks.find((ch) => ch.kind === "ulid");
    }
    get isIP() {
      return !!this._def.checks.find((ch) => ch.kind === "ip");
    }
    get isCIDR() {
      return !!this._def.checks.find((ch) => ch.kind === "cidr");
    }
    get isBase64() {
      return !!this._def.checks.find((ch) => ch.kind === "base64");
    }
    get isBase64url() {
      return !!this._def.checks.find((ch) => ch.kind === "base64url");
    }
    get minLength() {
      let min = null;
      for (const ch of this._def.checks) {
        if (ch.kind === "min") {
          if (min === null || ch.value > min)
            min = ch.value;
        }
      }
      return min;
    }
    get maxLength() {
      let max = null;
      for (const ch of this._def.checks) {
        if (ch.kind === "max") {
          if (max === null || ch.value < max)
            max = ch.value;
        }
      }
      return max;
    }
  }
  ZodString.create = (params) => {
    return new ZodString({
      checks: [],
      typeName: ZodFirstPartyTypeKind.ZodString,
      coerce: params?.coerce ?? false,
      ...processCreateParams(params)
    });
  };
  function floatSafeRemainder(val, step) {
    const valDecCount = (val.toString().split(".")[1] || "").length;
    const stepDecCount = (step.toString().split(".")[1] || "").length;
    const decCount = valDecCount > stepDecCount ? valDecCount : stepDecCount;
    const valInt = Number.parseInt(val.toFixed(decCount).replace(".", ""));
    const stepInt = Number.parseInt(step.toFixed(decCount).replace(".", ""));
    return valInt % stepInt / 10 ** decCount;
  }
  class ZodNumber extends ZodType {
    constructor() {
      super(...arguments);
      this.min = this.gte;
      this.max = this.lte;
      this.step = this.multipleOf;
    }
    _parse(input) {
      if (this._def.coerce) {
        input.data = Number(input.data);
      }
      const parsedType = this._getType(input);
      if (parsedType !== ZodParsedType.number) {
        const ctx2 = this._getOrReturnCtx(input);
        addIssueToContext(ctx2, {
          code: ZodIssueCode.invalid_type,
          expected: ZodParsedType.number,
          received: ctx2.parsedType
        });
        return INVALID;
      }
      let ctx = void 0;
      const status = new ParseStatus();
      for (const check of this._def.checks) {
        if (check.kind === "int") {
          if (!util.isInteger(input.data)) {
            ctx = this._getOrReturnCtx(input, ctx);
            addIssueToContext(ctx, {
              code: ZodIssueCode.invalid_type,
              expected: "integer",
              received: "float",
              message: check.message
            });
            status.dirty();
          }
        } else if (check.kind === "min") {
          const tooSmall = check.inclusive ? input.data < check.value : input.data <= check.value;
          if (tooSmall) {
            ctx = this._getOrReturnCtx(input, ctx);
            addIssueToContext(ctx, {
              code: ZodIssueCode.too_small,
              minimum: check.value,
              type: "number",
              inclusive: check.inclusive,
              exact: false,
              message: check.message
            });
            status.dirty();
          }
        } else if (check.kind === "max") {
          const tooBig = check.inclusive ? input.data > check.value : input.data >= check.value;
          if (tooBig) {
            ctx = this._getOrReturnCtx(input, ctx);
            addIssueToContext(ctx, {
              code: ZodIssueCode.too_big,
              maximum: check.value,
              type: "number",
              inclusive: check.inclusive,
              exact: false,
              message: check.message
            });
            status.dirty();
          }
        } else if (check.kind === "multipleOf") {
          if (floatSafeRemainder(input.data, check.value) !== 0) {
            ctx = this._getOrReturnCtx(input, ctx);
            addIssueToContext(ctx, {
              code: ZodIssueCode.not_multiple_of,
              multipleOf: check.value,
              message: check.message
            });
            status.dirty();
          }
        } else if (check.kind === "finite") {
          if (!Number.isFinite(input.data)) {
            ctx = this._getOrReturnCtx(input, ctx);
            addIssueToContext(ctx, {
              code: ZodIssueCode.not_finite,
              message: check.message
            });
            status.dirty();
          }
        } else {
          util.assertNever(check);
        }
      }
      return { status: status.value, value: input.data };
    }
    gte(value, message) {
      return this.setLimit("min", value, true, errorUtil.toString(message));
    }
    gt(value, message) {
      return this.setLimit("min", value, false, errorUtil.toString(message));
    }
    lte(value, message) {
      return this.setLimit("max", value, true, errorUtil.toString(message));
    }
    lt(value, message) {
      return this.setLimit("max", value, false, errorUtil.toString(message));
    }
    setLimit(kind, value, inclusive, message) {
      return new ZodNumber({
        ...this._def,
        checks: [
          ...this._def.checks,
          {
            kind,
            value,
            inclusive,
            message: errorUtil.toString(message)
          }
        ]
      });
    }
    _addCheck(check) {
      return new ZodNumber({
        ...this._def,
        checks: [...this._def.checks, check]
      });
    }
    int(message) {
      return this._addCheck({
        kind: "int",
        message: errorUtil.toString(message)
      });
    }
    positive(message) {
      return this._addCheck({
        kind: "min",
        value: 0,
        inclusive: false,
        message: errorUtil.toString(message)
      });
    }
    negative(message) {
      return this._addCheck({
        kind: "max",
        value: 0,
        inclusive: false,
        message: errorUtil.toString(message)
      });
    }
    nonpositive(message) {
      return this._addCheck({
        kind: "max",
        value: 0,
        inclusive: true,
        message: errorUtil.toString(message)
      });
    }
    nonnegative(message) {
      return this._addCheck({
        kind: "min",
        value: 0,
        inclusive: true,
        message: errorUtil.toString(message)
      });
    }
    multipleOf(value, message) {
      return this._addCheck({
        kind: "multipleOf",
        value,
        message: errorUtil.toString(message)
      });
    }
    finite(message) {
      return this._addCheck({
        kind: "finite",
        message: errorUtil.toString(message)
      });
    }
    safe(message) {
      return this._addCheck({
        kind: "min",
        inclusive: true,
        value: Number.MIN_SAFE_INTEGER,
        message: errorUtil.toString(message)
      })._addCheck({
        kind: "max",
        inclusive: true,
        value: Number.MAX_SAFE_INTEGER,
        message: errorUtil.toString(message)
      });
    }
    get minValue() {
      let min = null;
      for (const ch of this._def.checks) {
        if (ch.kind === "min") {
          if (min === null || ch.value > min)
            min = ch.value;
        }
      }
      return min;
    }
    get maxValue() {
      let max = null;
      for (const ch of this._def.checks) {
        if (ch.kind === "max") {
          if (max === null || ch.value < max)
            max = ch.value;
        }
      }
      return max;
    }
    get isInt() {
      return !!this._def.checks.find((ch) => ch.kind === "int" || ch.kind === "multipleOf" && util.isInteger(ch.value));
    }
    get isFinite() {
      let max = null;
      let min = null;
      for (const ch of this._def.checks) {
        if (ch.kind === "finite" || ch.kind === "int" || ch.kind === "multipleOf") {
          return true;
        } else if (ch.kind === "min") {
          if (min === null || ch.value > min)
            min = ch.value;
        } else if (ch.kind === "max") {
          if (max === null || ch.value < max)
            max = ch.value;
        }
      }
      return Number.isFinite(min) && Number.isFinite(max);
    }
  }
  ZodNumber.create = (params) => {
    return new ZodNumber({
      checks: [],
      typeName: ZodFirstPartyTypeKind.ZodNumber,
      coerce: params?.coerce || false,
      ...processCreateParams(params)
    });
  };
  class ZodBigInt extends ZodType {
    constructor() {
      super(...arguments);
      this.min = this.gte;
      this.max = this.lte;
    }
    _parse(input) {
      if (this._def.coerce) {
        try {
          input.data = BigInt(input.data);
        } catch {
          return this._getInvalidInput(input);
        }
      }
      const parsedType = this._getType(input);
      if (parsedType !== ZodParsedType.bigint) {
        return this._getInvalidInput(input);
      }
      let ctx = void 0;
      const status = new ParseStatus();
      for (const check of this._def.checks) {
        if (check.kind === "min") {
          const tooSmall = check.inclusive ? input.data < check.value : input.data <= check.value;
          if (tooSmall) {
            ctx = this._getOrReturnCtx(input, ctx);
            addIssueToContext(ctx, {
              code: ZodIssueCode.too_small,
              type: "bigint",
              minimum: check.value,
              inclusive: check.inclusive,
              message: check.message
            });
            status.dirty();
          }
        } else if (check.kind === "max") {
          const tooBig = check.inclusive ? input.data > check.value : input.data >= check.value;
          if (tooBig) {
            ctx = this._getOrReturnCtx(input, ctx);
            addIssueToContext(ctx, {
              code: ZodIssueCode.too_big,
              type: "bigint",
              maximum: check.value,
              inclusive: check.inclusive,
              message: check.message
            });
            status.dirty();
          }
        } else if (check.kind === "multipleOf") {
          if (input.data % check.value !== BigInt(0)) {
            ctx = this._getOrReturnCtx(input, ctx);
            addIssueToContext(ctx, {
              code: ZodIssueCode.not_multiple_of,
              multipleOf: check.value,
              message: check.message
            });
            status.dirty();
          }
        } else {
          util.assertNever(check);
        }
      }
      return { status: status.value, value: input.data };
    }
    _getInvalidInput(input) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.bigint,
        received: ctx.parsedType
      });
      return INVALID;
    }
    gte(value, message) {
      return this.setLimit("min", value, true, errorUtil.toString(message));
    }
    gt(value, message) {
      return this.setLimit("min", value, false, errorUtil.toString(message));
    }
    lte(value, message) {
      return this.setLimit("max", value, true, errorUtil.toString(message));
    }
    lt(value, message) {
      return this.setLimit("max", value, false, errorUtil.toString(message));
    }
    setLimit(kind, value, inclusive, message) {
      return new ZodBigInt({
        ...this._def,
        checks: [
          ...this._def.checks,
          {
            kind,
            value,
            inclusive,
            message: errorUtil.toString(message)
          }
        ]
      });
    }
    _addCheck(check) {
      return new ZodBigInt({
        ...this._def,
        checks: [...this._def.checks, check]
      });
    }
    positive(message) {
      return this._addCheck({
        kind: "min",
        value: BigInt(0),
        inclusive: false,
        message: errorUtil.toString(message)
      });
    }
    negative(message) {
      return this._addCheck({
        kind: "max",
        value: BigInt(0),
        inclusive: false,
        message: errorUtil.toString(message)
      });
    }
    nonpositive(message) {
      return this._addCheck({
        kind: "max",
        value: BigInt(0),
        inclusive: true,
        message: errorUtil.toString(message)
      });
    }
    nonnegative(message) {
      return this._addCheck({
        kind: "min",
        value: BigInt(0),
        inclusive: true,
        message: errorUtil.toString(message)
      });
    }
    multipleOf(value, message) {
      return this._addCheck({
        kind: "multipleOf",
        value,
        message: errorUtil.toString(message)
      });
    }
    get minValue() {
      let min = null;
      for (const ch of this._def.checks) {
        if (ch.kind === "min") {
          if (min === null || ch.value > min)
            min = ch.value;
        }
      }
      return min;
    }
    get maxValue() {
      let max = null;
      for (const ch of this._def.checks) {
        if (ch.kind === "max") {
          if (max === null || ch.value < max)
            max = ch.value;
        }
      }
      return max;
    }
  }
  ZodBigInt.create = (params) => {
    return new ZodBigInt({
      checks: [],
      typeName: ZodFirstPartyTypeKind.ZodBigInt,
      coerce: params?.coerce ?? false,
      ...processCreateParams(params)
    });
  };
  class ZodBoolean extends ZodType {
    _parse(input) {
      if (this._def.coerce) {
        input.data = Boolean(input.data);
      }
      const parsedType = this._getType(input);
      if (parsedType !== ZodParsedType.boolean) {
        const ctx = this._getOrReturnCtx(input);
        addIssueToContext(ctx, {
          code: ZodIssueCode.invalid_type,
          expected: ZodParsedType.boolean,
          received: ctx.parsedType
        });
        return INVALID;
      }
      return OK(input.data);
    }
  }
  ZodBoolean.create = (params) => {
    return new ZodBoolean({
      typeName: ZodFirstPartyTypeKind.ZodBoolean,
      coerce: params?.coerce || false,
      ...processCreateParams(params)
    });
  };
  class ZodDate extends ZodType {
    _parse(input) {
      if (this._def.coerce) {
        input.data = new Date(input.data);
      }
      const parsedType = this._getType(input);
      if (parsedType !== ZodParsedType.date) {
        const ctx2 = this._getOrReturnCtx(input);
        addIssueToContext(ctx2, {
          code: ZodIssueCode.invalid_type,
          expected: ZodParsedType.date,
          received: ctx2.parsedType
        });
        return INVALID;
      }
      if (Number.isNaN(input.data.getTime())) {
        const ctx2 = this._getOrReturnCtx(input);
        addIssueToContext(ctx2, {
          code: ZodIssueCode.invalid_date
        });
        return INVALID;
      }
      const status = new ParseStatus();
      let ctx = void 0;
      for (const check of this._def.checks) {
        if (check.kind === "min") {
          if (input.data.getTime() < check.value) {
            ctx = this._getOrReturnCtx(input, ctx);
            addIssueToContext(ctx, {
              code: ZodIssueCode.too_small,
              message: check.message,
              inclusive: true,
              exact: false,
              minimum: check.value,
              type: "date"
            });
            status.dirty();
          }
        } else if (check.kind === "max") {
          if (input.data.getTime() > check.value) {
            ctx = this._getOrReturnCtx(input, ctx);
            addIssueToContext(ctx, {
              code: ZodIssueCode.too_big,
              message: check.message,
              inclusive: true,
              exact: false,
              maximum: check.value,
              type: "date"
            });
            status.dirty();
          }
        } else {
          util.assertNever(check);
        }
      }
      return {
        status: status.value,
        value: new Date(input.data.getTime())
      };
    }
    _addCheck(check) {
      return new ZodDate({
        ...this._def,
        checks: [...this._def.checks, check]
      });
    }
    min(minDate, message) {
      return this._addCheck({
        kind: "min",
        value: minDate.getTime(),
        message: errorUtil.toString(message)
      });
    }
    max(maxDate, message) {
      return this._addCheck({
        kind: "max",
        value: maxDate.getTime(),
        message: errorUtil.toString(message)
      });
    }
    get minDate() {
      let min = null;
      for (const ch of this._def.checks) {
        if (ch.kind === "min") {
          if (min === null || ch.value > min)
            min = ch.value;
        }
      }
      return min != null ? new Date(min) : null;
    }
    get maxDate() {
      let max = null;
      for (const ch of this._def.checks) {
        if (ch.kind === "max") {
          if (max === null || ch.value < max)
            max = ch.value;
        }
      }
      return max != null ? new Date(max) : null;
    }
  }
  ZodDate.create = (params) => {
    return new ZodDate({
      checks: [],
      coerce: params?.coerce || false,
      typeName: ZodFirstPartyTypeKind.ZodDate,
      ...processCreateParams(params)
    });
  };
  class ZodSymbol extends ZodType {
    _parse(input) {
      const parsedType = this._getType(input);
      if (parsedType !== ZodParsedType.symbol) {
        const ctx = this._getOrReturnCtx(input);
        addIssueToContext(ctx, {
          code: ZodIssueCode.invalid_type,
          expected: ZodParsedType.symbol,
          received: ctx.parsedType
        });
        return INVALID;
      }
      return OK(input.data);
    }
  }
  ZodSymbol.create = (params) => {
    return new ZodSymbol({
      typeName: ZodFirstPartyTypeKind.ZodSymbol,
      ...processCreateParams(params)
    });
  };
  class ZodUndefined extends ZodType {
    _parse(input) {
      const parsedType = this._getType(input);
      if (parsedType !== ZodParsedType.undefined) {
        const ctx = this._getOrReturnCtx(input);
        addIssueToContext(ctx, {
          code: ZodIssueCode.invalid_type,
          expected: ZodParsedType.undefined,
          received: ctx.parsedType
        });
        return INVALID;
      }
      return OK(input.data);
    }
  }
  ZodUndefined.create = (params) => {
    return new ZodUndefined({
      typeName: ZodFirstPartyTypeKind.ZodUndefined,
      ...processCreateParams(params)
    });
  };
  class ZodNull extends ZodType {
    _parse(input) {
      const parsedType = this._getType(input);
      if (parsedType !== ZodParsedType.null) {
        const ctx = this._getOrReturnCtx(input);
        addIssueToContext(ctx, {
          code: ZodIssueCode.invalid_type,
          expected: ZodParsedType.null,
          received: ctx.parsedType
        });
        return INVALID;
      }
      return OK(input.data);
    }
  }
  ZodNull.create = (params) => {
    return new ZodNull({
      typeName: ZodFirstPartyTypeKind.ZodNull,
      ...processCreateParams(params)
    });
  };
  class ZodAny extends ZodType {
    constructor() {
      super(...arguments);
      this._any = true;
    }
    _parse(input) {
      return OK(input.data);
    }
  }
  ZodAny.create = (params) => {
    return new ZodAny({
      typeName: ZodFirstPartyTypeKind.ZodAny,
      ...processCreateParams(params)
    });
  };
  class ZodUnknown extends ZodType {
    constructor() {
      super(...arguments);
      this._unknown = true;
    }
    _parse(input) {
      return OK(input.data);
    }
  }
  ZodUnknown.create = (params) => {
    return new ZodUnknown({
      typeName: ZodFirstPartyTypeKind.ZodUnknown,
      ...processCreateParams(params)
    });
  };
  class ZodNever extends ZodType {
    _parse(input) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.never,
        received: ctx.parsedType
      });
      return INVALID;
    }
  }
  ZodNever.create = (params) => {
    return new ZodNever({
      typeName: ZodFirstPartyTypeKind.ZodNever,
      ...processCreateParams(params)
    });
  };
  class ZodVoid extends ZodType {
    _parse(input) {
      const parsedType = this._getType(input);
      if (parsedType !== ZodParsedType.undefined) {
        const ctx = this._getOrReturnCtx(input);
        addIssueToContext(ctx, {
          code: ZodIssueCode.invalid_type,
          expected: ZodParsedType.void,
          received: ctx.parsedType
        });
        return INVALID;
      }
      return OK(input.data);
    }
  }
  ZodVoid.create = (params) => {
    return new ZodVoid({
      typeName: ZodFirstPartyTypeKind.ZodVoid,
      ...processCreateParams(params)
    });
  };
  class ZodArray extends ZodType {
    _parse(input) {
      const { ctx, status } = this._processInputParams(input);
      const def = this._def;
      if (ctx.parsedType !== ZodParsedType.array) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.invalid_type,
          expected: ZodParsedType.array,
          received: ctx.parsedType
        });
        return INVALID;
      }
      if (def.exactLength !== null) {
        const tooBig = ctx.data.length > def.exactLength.value;
        const tooSmall = ctx.data.length < def.exactLength.value;
        if (tooBig || tooSmall) {
          addIssueToContext(ctx, {
            code: tooBig ? ZodIssueCode.too_big : ZodIssueCode.too_small,
            minimum: tooSmall ? def.exactLength.value : void 0,
            maximum: tooBig ? def.exactLength.value : void 0,
            type: "array",
            inclusive: true,
            exact: true,
            message: def.exactLength.message
          });
          status.dirty();
        }
      }
      if (def.minLength !== null) {
        if (ctx.data.length < def.minLength.value) {
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_small,
            minimum: def.minLength.value,
            type: "array",
            inclusive: true,
            exact: false,
            message: def.minLength.message
          });
          status.dirty();
        }
      }
      if (def.maxLength !== null) {
        if (ctx.data.length > def.maxLength.value) {
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_big,
            maximum: def.maxLength.value,
            type: "array",
            inclusive: true,
            exact: false,
            message: def.maxLength.message
          });
          status.dirty();
        }
      }
      if (ctx.common.async) {
        return Promise.all([...ctx.data].map((item, i) => {
          return def.type._parseAsync(new ParseInputLazyPath(ctx, item, ctx.path, i));
        })).then((result2) => {
          return ParseStatus.mergeArray(status, result2);
        });
      }
      const result = [...ctx.data].map((item, i) => {
        return def.type._parseSync(new ParseInputLazyPath(ctx, item, ctx.path, i));
      });
      return ParseStatus.mergeArray(status, result);
    }
    get element() {
      return this._def.type;
    }
    min(minLength, message) {
      return new ZodArray({
        ...this._def,
        minLength: { value: minLength, message: errorUtil.toString(message) }
      });
    }
    max(maxLength, message) {
      return new ZodArray({
        ...this._def,
        maxLength: { value: maxLength, message: errorUtil.toString(message) }
      });
    }
    length(len, message) {
      return new ZodArray({
        ...this._def,
        exactLength: { value: len, message: errorUtil.toString(message) }
      });
    }
    nonempty(message) {
      return this.min(1, message);
    }
  }
  ZodArray.create = (schema, params) => {
    return new ZodArray({
      type: schema,
      minLength: null,
      maxLength: null,
      exactLength: null,
      typeName: ZodFirstPartyTypeKind.ZodArray,
      ...processCreateParams(params)
    });
  };
  function deepPartialify(schema) {
    if (schema instanceof ZodObject) {
      const newShape = {};
      for (const key in schema.shape) {
        const fieldSchema = schema.shape[key];
        newShape[key] = ZodOptional.create(deepPartialify(fieldSchema));
      }
      return new ZodObject({
        ...schema._def,
        shape: () => newShape
      });
    } else if (schema instanceof ZodArray) {
      return new ZodArray({
        ...schema._def,
        type: deepPartialify(schema.element)
      });
    } else if (schema instanceof ZodOptional) {
      return ZodOptional.create(deepPartialify(schema.unwrap()));
    } else if (schema instanceof ZodNullable) {
      return ZodNullable.create(deepPartialify(schema.unwrap()));
    } else if (schema instanceof ZodTuple) {
      return ZodTuple.create(schema.items.map((item) => deepPartialify(item)));
    } else {
      return schema;
    }
  }
  class ZodObject extends ZodType {
    constructor() {
      super(...arguments);
      this._cached = null;
      this.nonstrict = this.passthrough;
      this.augment = this.extend;
    }
    _getCached() {
      if (this._cached !== null)
        return this._cached;
      const shape = this._def.shape();
      const keys = util.objectKeys(shape);
      this._cached = { shape, keys };
      return this._cached;
    }
    _parse(input) {
      const parsedType = this._getType(input);
      if (parsedType !== ZodParsedType.object) {
        const ctx2 = this._getOrReturnCtx(input);
        addIssueToContext(ctx2, {
          code: ZodIssueCode.invalid_type,
          expected: ZodParsedType.object,
          received: ctx2.parsedType
        });
        return INVALID;
      }
      const { status, ctx } = this._processInputParams(input);
      const { shape, keys: shapeKeys } = this._getCached();
      const extraKeys = [];
      if (!(this._def.catchall instanceof ZodNever && this._def.unknownKeys === "strip")) {
        for (const key in ctx.data) {
          if (!shapeKeys.includes(key)) {
            extraKeys.push(key);
          }
        }
      }
      const pairs = [];
      for (const key of shapeKeys) {
        const keyValidator = shape[key];
        const value = ctx.data[key];
        pairs.push({
          key: { status: "valid", value: key },
          value: keyValidator._parse(new ParseInputLazyPath(ctx, value, ctx.path, key)),
          alwaysSet: key in ctx.data
        });
      }
      if (this._def.catchall instanceof ZodNever) {
        const unknownKeys = this._def.unknownKeys;
        if (unknownKeys === "passthrough") {
          for (const key of extraKeys) {
            pairs.push({
              key: { status: "valid", value: key },
              value: { status: "valid", value: ctx.data[key] }
            });
          }
        } else if (unknownKeys === "strict") {
          if (extraKeys.length > 0) {
            addIssueToContext(ctx, {
              code: ZodIssueCode.unrecognized_keys,
              keys: extraKeys
            });
            status.dirty();
          }
        } else if (unknownKeys === "strip") ;
        else {
          throw new Error(`Internal ZodObject error: invalid unknownKeys value.`);
        }
      } else {
        const catchall = this._def.catchall;
        for (const key of extraKeys) {
          const value = ctx.data[key];
          pairs.push({
            key: { status: "valid", value: key },
            value: catchall._parse(
              new ParseInputLazyPath(ctx, value, ctx.path, key)
              //, ctx.child(key), value, getParsedType(value)
            ),
            alwaysSet: key in ctx.data
          });
        }
      }
      if (ctx.common.async) {
        return Promise.resolve().then(async () => {
          const syncPairs = [];
          for (const pair of pairs) {
            const key = await pair.key;
            const value = await pair.value;
            syncPairs.push({
              key,
              value,
              alwaysSet: pair.alwaysSet
            });
          }
          return syncPairs;
        }).then((syncPairs) => {
          return ParseStatus.mergeObjectSync(status, syncPairs);
        });
      } else {
        return ParseStatus.mergeObjectSync(status, pairs);
      }
    }
    get shape() {
      return this._def.shape();
    }
    strict(message) {
      errorUtil.errToObj;
      return new ZodObject({
        ...this._def,
        unknownKeys: "strict",
        ...message !== void 0 ? {
          errorMap: (issue, ctx) => {
            const defaultError = this._def.errorMap?.(issue, ctx).message ?? ctx.defaultError;
            if (issue.code === "unrecognized_keys")
              return {
                message: errorUtil.errToObj(message).message ?? defaultError
              };
            return {
              message: defaultError
            };
          }
        } : {}
      });
    }
    strip() {
      return new ZodObject({
        ...this._def,
        unknownKeys: "strip"
      });
    }
    passthrough() {
      return new ZodObject({
        ...this._def,
        unknownKeys: "passthrough"
      });
    }
    // const AugmentFactory =
    //   <Def extends ZodObjectDef>(def: Def) =>
    //   <Augmentation extends ZodRawShape>(
    //     augmentation: Augmentation
    //   ): ZodObject<
    //     extendShape<ReturnType<Def["shape"]>, Augmentation>,
    //     Def["unknownKeys"],
    //     Def["catchall"]
    //   > => {
    //     return new ZodObject({
    //       ...def,
    //       shape: () => ({
    //         ...def.shape(),
    //         ...augmentation,
    //       }),
    //     }) as any;
    //   };
    extend(augmentation) {
      return new ZodObject({
        ...this._def,
        shape: () => ({
          ...this._def.shape(),
          ...augmentation
        })
      });
    }
    /**
     * Prior to zod@1.0.12 there was a bug in the
     * inferred type of merged objects. Please
     * upgrade if you are experiencing issues.
     */
    merge(merging) {
      const merged = new ZodObject({
        unknownKeys: merging._def.unknownKeys,
        catchall: merging._def.catchall,
        shape: () => ({
          ...this._def.shape(),
          ...merging._def.shape()
        }),
        typeName: ZodFirstPartyTypeKind.ZodObject
      });
      return merged;
    }
    // merge<
    //   Incoming extends AnyZodObject,
    //   Augmentation extends Incoming["shape"],
    //   NewOutput extends {
    //     [k in keyof Augmentation | keyof Output]: k extends keyof Augmentation
    //       ? Augmentation[k]["_output"]
    //       : k extends keyof Output
    //       ? Output[k]
    //       : never;
    //   },
    //   NewInput extends {
    //     [k in keyof Augmentation | keyof Input]: k extends keyof Augmentation
    //       ? Augmentation[k]["_input"]
    //       : k extends keyof Input
    //       ? Input[k]
    //       : never;
    //   }
    // >(
    //   merging: Incoming
    // ): ZodObject<
    //   extendShape<T, ReturnType<Incoming["_def"]["shape"]>>,
    //   Incoming["_def"]["unknownKeys"],
    //   Incoming["_def"]["catchall"],
    //   NewOutput,
    //   NewInput
    // > {
    //   const merged: any = new ZodObject({
    //     unknownKeys: merging._def.unknownKeys,
    //     catchall: merging._def.catchall,
    //     shape: () =>
    //       objectUtil.mergeShapes(this._def.shape(), merging._def.shape()),
    //     typeName: ZodFirstPartyTypeKind.ZodObject,
    //   }) as any;
    //   return merged;
    // }
    setKey(key, schema) {
      return this.augment({ [key]: schema });
    }
    // merge<Incoming extends AnyZodObject>(
    //   merging: Incoming
    // ): //ZodObject<T & Incoming["_shape"], UnknownKeys, Catchall> = (merging) => {
    // ZodObject<
    //   extendShape<T, ReturnType<Incoming["_def"]["shape"]>>,
    //   Incoming["_def"]["unknownKeys"],
    //   Incoming["_def"]["catchall"]
    // > {
    //   // const mergedShape = objectUtil.mergeShapes(
    //   //   this._def.shape(),
    //   //   merging._def.shape()
    //   // );
    //   const merged: any = new ZodObject({
    //     unknownKeys: merging._def.unknownKeys,
    //     catchall: merging._def.catchall,
    //     shape: () =>
    //       objectUtil.mergeShapes(this._def.shape(), merging._def.shape()),
    //     typeName: ZodFirstPartyTypeKind.ZodObject,
    //   }) as any;
    //   return merged;
    // }
    catchall(index) {
      return new ZodObject({
        ...this._def,
        catchall: index
      });
    }
    pick(mask) {
      const shape = {};
      for (const key of util.objectKeys(mask)) {
        if (mask[key] && this.shape[key]) {
          shape[key] = this.shape[key];
        }
      }
      return new ZodObject({
        ...this._def,
        shape: () => shape
      });
    }
    omit(mask) {
      const shape = {};
      for (const key of util.objectKeys(this.shape)) {
        if (!mask[key]) {
          shape[key] = this.shape[key];
        }
      }
      return new ZodObject({
        ...this._def,
        shape: () => shape
      });
    }
    /**
     * @deprecated
     */
    deepPartial() {
      return deepPartialify(this);
    }
    partial(mask) {
      const newShape = {};
      for (const key of util.objectKeys(this.shape)) {
        const fieldSchema = this.shape[key];
        if (mask && !mask[key]) {
          newShape[key] = fieldSchema;
        } else {
          newShape[key] = fieldSchema.optional();
        }
      }
      return new ZodObject({
        ...this._def,
        shape: () => newShape
      });
    }
    required(mask) {
      const newShape = {};
      for (const key of util.objectKeys(this.shape)) {
        if (mask && !mask[key]) {
          newShape[key] = this.shape[key];
        } else {
          const fieldSchema = this.shape[key];
          let newField = fieldSchema;
          while (newField instanceof ZodOptional) {
            newField = newField._def.innerType;
          }
          newShape[key] = newField;
        }
      }
      return new ZodObject({
        ...this._def,
        shape: () => newShape
      });
    }
    keyof() {
      return createZodEnum(util.objectKeys(this.shape));
    }
  }
  ZodObject.create = (shape, params) => {
    return new ZodObject({
      shape: () => shape,
      unknownKeys: "strip",
      catchall: ZodNever.create(),
      typeName: ZodFirstPartyTypeKind.ZodObject,
      ...processCreateParams(params)
    });
  };
  ZodObject.strictCreate = (shape, params) => {
    return new ZodObject({
      shape: () => shape,
      unknownKeys: "strict",
      catchall: ZodNever.create(),
      typeName: ZodFirstPartyTypeKind.ZodObject,
      ...processCreateParams(params)
    });
  };
  ZodObject.lazycreate = (shape, params) => {
    return new ZodObject({
      shape,
      unknownKeys: "strip",
      catchall: ZodNever.create(),
      typeName: ZodFirstPartyTypeKind.ZodObject,
      ...processCreateParams(params)
    });
  };
  class ZodUnion extends ZodType {
    _parse(input) {
      const { ctx } = this._processInputParams(input);
      const options = this._def.options;
      function handleResults(results) {
        for (const result of results) {
          if (result.result.status === "valid") {
            return result.result;
          }
        }
        for (const result of results) {
          if (result.result.status === "dirty") {
            ctx.common.issues.push(...result.ctx.common.issues);
            return result.result;
          }
        }
        const unionErrors = results.map((result) => new ZodError(result.ctx.common.issues));
        addIssueToContext(ctx, {
          code: ZodIssueCode.invalid_union,
          unionErrors
        });
        return INVALID;
      }
      if (ctx.common.async) {
        return Promise.all(options.map(async (option) => {
          const childCtx = {
            ...ctx,
            common: {
              ...ctx.common,
              issues: []
            },
            parent: null
          };
          return {
            result: await option._parseAsync({
              data: ctx.data,
              path: ctx.path,
              parent: childCtx
            }),
            ctx: childCtx
          };
        })).then(handleResults);
      } else {
        let dirty = void 0;
        const issues = [];
        for (const option of options) {
          const childCtx = {
            ...ctx,
            common: {
              ...ctx.common,
              issues: []
            },
            parent: null
          };
          const result = option._parseSync({
            data: ctx.data,
            path: ctx.path,
            parent: childCtx
          });
          if (result.status === "valid") {
            return result;
          } else if (result.status === "dirty" && !dirty) {
            dirty = { result, ctx: childCtx };
          }
          if (childCtx.common.issues.length) {
            issues.push(childCtx.common.issues);
          }
        }
        if (dirty) {
          ctx.common.issues.push(...dirty.ctx.common.issues);
          return dirty.result;
        }
        const unionErrors = issues.map((issues2) => new ZodError(issues2));
        addIssueToContext(ctx, {
          code: ZodIssueCode.invalid_union,
          unionErrors
        });
        return INVALID;
      }
    }
    get options() {
      return this._def.options;
    }
  }
  ZodUnion.create = (types, params) => {
    return new ZodUnion({
      options: types,
      typeName: ZodFirstPartyTypeKind.ZodUnion,
      ...processCreateParams(params)
    });
  };
  function mergeValues(a, b) {
    const aType = getParsedType(a);
    const bType = getParsedType(b);
    if (a === b) {
      return { valid: true, data: a };
    } else if (aType === ZodParsedType.object && bType === ZodParsedType.object) {
      const bKeys = util.objectKeys(b);
      const sharedKeys = util.objectKeys(a).filter((key) => bKeys.indexOf(key) !== -1);
      const newObj = { ...a, ...b };
      for (const key of sharedKeys) {
        const sharedValue = mergeValues(a[key], b[key]);
        if (!sharedValue.valid) {
          return { valid: false };
        }
        newObj[key] = sharedValue.data;
      }
      return { valid: true, data: newObj };
    } else if (aType === ZodParsedType.array && bType === ZodParsedType.array) {
      if (a.length !== b.length) {
        return { valid: false };
      }
      const newArray = [];
      for (let index = 0; index < a.length; index++) {
        const itemA = a[index];
        const itemB = b[index];
        const sharedValue = mergeValues(itemA, itemB);
        if (!sharedValue.valid) {
          return { valid: false };
        }
        newArray.push(sharedValue.data);
      }
      return { valid: true, data: newArray };
    } else if (aType === ZodParsedType.date && bType === ZodParsedType.date && +a === +b) {
      return { valid: true, data: a };
    } else {
      return { valid: false };
    }
  }
  class ZodIntersection extends ZodType {
    _parse(input) {
      const { status, ctx } = this._processInputParams(input);
      const handleParsed = (parsedLeft, parsedRight) => {
        if (isAborted(parsedLeft) || isAborted(parsedRight)) {
          return INVALID;
        }
        const merged = mergeValues(parsedLeft.value, parsedRight.value);
        if (!merged.valid) {
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_intersection_types
          });
          return INVALID;
        }
        if (isDirty(parsedLeft) || isDirty(parsedRight)) {
          status.dirty();
        }
        return { status: status.value, value: merged.data };
      };
      if (ctx.common.async) {
        return Promise.all([
          this._def.left._parseAsync({
            data: ctx.data,
            path: ctx.path,
            parent: ctx
          }),
          this._def.right._parseAsync({
            data: ctx.data,
            path: ctx.path,
            parent: ctx
          })
        ]).then(([left, right]) => handleParsed(left, right));
      } else {
        return handleParsed(this._def.left._parseSync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx
        }), this._def.right._parseSync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx
        }));
      }
    }
  }
  ZodIntersection.create = (left, right, params) => {
    return new ZodIntersection({
      left,
      right,
      typeName: ZodFirstPartyTypeKind.ZodIntersection,
      ...processCreateParams(params)
    });
  };
  class ZodTuple extends ZodType {
    _parse(input) {
      const { status, ctx } = this._processInputParams(input);
      if (ctx.parsedType !== ZodParsedType.array) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.invalid_type,
          expected: ZodParsedType.array,
          received: ctx.parsedType
        });
        return INVALID;
      }
      if (ctx.data.length < this._def.items.length) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.too_small,
          minimum: this._def.items.length,
          inclusive: true,
          exact: false,
          type: "array"
        });
        return INVALID;
      }
      const rest = this._def.rest;
      if (!rest && ctx.data.length > this._def.items.length) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.too_big,
          maximum: this._def.items.length,
          inclusive: true,
          exact: false,
          type: "array"
        });
        status.dirty();
      }
      const items = [...ctx.data].map((item, itemIndex) => {
        const schema = this._def.items[itemIndex] || this._def.rest;
        if (!schema)
          return null;
        return schema._parse(new ParseInputLazyPath(ctx, item, ctx.path, itemIndex));
      }).filter((x) => !!x);
      if (ctx.common.async) {
        return Promise.all(items).then((results) => {
          return ParseStatus.mergeArray(status, results);
        });
      } else {
        return ParseStatus.mergeArray(status, items);
      }
    }
    get items() {
      return this._def.items;
    }
    rest(rest) {
      return new ZodTuple({
        ...this._def,
        rest
      });
    }
  }
  ZodTuple.create = (schemas, params) => {
    if (!Array.isArray(schemas)) {
      throw new Error("You must pass an array of schemas to z.tuple([ ... ])");
    }
    return new ZodTuple({
      items: schemas,
      typeName: ZodFirstPartyTypeKind.ZodTuple,
      rest: null,
      ...processCreateParams(params)
    });
  };
  class ZodMap extends ZodType {
    get keySchema() {
      return this._def.keyType;
    }
    get valueSchema() {
      return this._def.valueType;
    }
    _parse(input) {
      const { status, ctx } = this._processInputParams(input);
      if (ctx.parsedType !== ZodParsedType.map) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.invalid_type,
          expected: ZodParsedType.map,
          received: ctx.parsedType
        });
        return INVALID;
      }
      const keyType = this._def.keyType;
      const valueType = this._def.valueType;
      const pairs = [...ctx.data.entries()].map(([key, value], index) => {
        return {
          key: keyType._parse(new ParseInputLazyPath(ctx, key, ctx.path, [index, "key"])),
          value: valueType._parse(new ParseInputLazyPath(ctx, value, ctx.path, [index, "value"]))
        };
      });
      if (ctx.common.async) {
        const finalMap = /* @__PURE__ */ new Map();
        return Promise.resolve().then(async () => {
          for (const pair of pairs) {
            const key = await pair.key;
            const value = await pair.value;
            if (key.status === "aborted" || value.status === "aborted") {
              return INVALID;
            }
            if (key.status === "dirty" || value.status === "dirty") {
              status.dirty();
            }
            finalMap.set(key.value, value.value);
          }
          return { status: status.value, value: finalMap };
        });
      } else {
        const finalMap = /* @__PURE__ */ new Map();
        for (const pair of pairs) {
          const key = pair.key;
          const value = pair.value;
          if (key.status === "aborted" || value.status === "aborted") {
            return INVALID;
          }
          if (key.status === "dirty" || value.status === "dirty") {
            status.dirty();
          }
          finalMap.set(key.value, value.value);
        }
        return { status: status.value, value: finalMap };
      }
    }
  }
  ZodMap.create = (keyType, valueType, params) => {
    return new ZodMap({
      valueType,
      keyType,
      typeName: ZodFirstPartyTypeKind.ZodMap,
      ...processCreateParams(params)
    });
  };
  class ZodSet extends ZodType {
    _parse(input) {
      const { status, ctx } = this._processInputParams(input);
      if (ctx.parsedType !== ZodParsedType.set) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.invalid_type,
          expected: ZodParsedType.set,
          received: ctx.parsedType
        });
        return INVALID;
      }
      const def = this._def;
      if (def.minSize !== null) {
        if (ctx.data.size < def.minSize.value) {
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_small,
            minimum: def.minSize.value,
            type: "set",
            inclusive: true,
            exact: false,
            message: def.minSize.message
          });
          status.dirty();
        }
      }
      if (def.maxSize !== null) {
        if (ctx.data.size > def.maxSize.value) {
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_big,
            maximum: def.maxSize.value,
            type: "set",
            inclusive: true,
            exact: false,
            message: def.maxSize.message
          });
          status.dirty();
        }
      }
      const valueType = this._def.valueType;
      function finalizeSet(elements2) {
        const parsedSet = /* @__PURE__ */ new Set();
        for (const element of elements2) {
          if (element.status === "aborted")
            return INVALID;
          if (element.status === "dirty")
            status.dirty();
          parsedSet.add(element.value);
        }
        return { status: status.value, value: parsedSet };
      }
      const elements = [...ctx.data.values()].map((item, i) => valueType._parse(new ParseInputLazyPath(ctx, item, ctx.path, i)));
      if (ctx.common.async) {
        return Promise.all(elements).then((elements2) => finalizeSet(elements2));
      } else {
        return finalizeSet(elements);
      }
    }
    min(minSize, message) {
      return new ZodSet({
        ...this._def,
        minSize: { value: minSize, message: errorUtil.toString(message) }
      });
    }
    max(maxSize, message) {
      return new ZodSet({
        ...this._def,
        maxSize: { value: maxSize, message: errorUtil.toString(message) }
      });
    }
    size(size, message) {
      return this.min(size, message).max(size, message);
    }
    nonempty(message) {
      return this.min(1, message);
    }
  }
  ZodSet.create = (valueType, params) => {
    return new ZodSet({
      valueType,
      minSize: null,
      maxSize: null,
      typeName: ZodFirstPartyTypeKind.ZodSet,
      ...processCreateParams(params)
    });
  };
  class ZodLazy extends ZodType {
    get schema() {
      return this._def.getter();
    }
    _parse(input) {
      const { ctx } = this._processInputParams(input);
      const lazySchema = this._def.getter();
      return lazySchema._parse({ data: ctx.data, path: ctx.path, parent: ctx });
    }
  }
  ZodLazy.create = (getter, params) => {
    return new ZodLazy({
      getter,
      typeName: ZodFirstPartyTypeKind.ZodLazy,
      ...processCreateParams(params)
    });
  };
  class ZodLiteral extends ZodType {
    _parse(input) {
      if (input.data !== this._def.value) {
        const ctx = this._getOrReturnCtx(input);
        addIssueToContext(ctx, {
          received: ctx.data,
          code: ZodIssueCode.invalid_literal,
          expected: this._def.value
        });
        return INVALID;
      }
      return { status: "valid", value: input.data };
    }
    get value() {
      return this._def.value;
    }
  }
  ZodLiteral.create = (value, params) => {
    return new ZodLiteral({
      value,
      typeName: ZodFirstPartyTypeKind.ZodLiteral,
      ...processCreateParams(params)
    });
  };
  function createZodEnum(values, params) {
    return new ZodEnum({
      values,
      typeName: ZodFirstPartyTypeKind.ZodEnum,
      ...processCreateParams(params)
    });
  }
  class ZodEnum extends ZodType {
    _parse(input) {
      if (typeof input.data !== "string") {
        const ctx = this._getOrReturnCtx(input);
        const expectedValues = this._def.values;
        addIssueToContext(ctx, {
          expected: util.joinValues(expectedValues),
          received: ctx.parsedType,
          code: ZodIssueCode.invalid_type
        });
        return INVALID;
      }
      if (!this._cache) {
        this._cache = new Set(this._def.values);
      }
      if (!this._cache.has(input.data)) {
        const ctx = this._getOrReturnCtx(input);
        const expectedValues = this._def.values;
        addIssueToContext(ctx, {
          received: ctx.data,
          code: ZodIssueCode.invalid_enum_value,
          options: expectedValues
        });
        return INVALID;
      }
      return OK(input.data);
    }
    get options() {
      return this._def.values;
    }
    get enum() {
      const enumValues = {};
      for (const val of this._def.values) {
        enumValues[val] = val;
      }
      return enumValues;
    }
    get Values() {
      const enumValues = {};
      for (const val of this._def.values) {
        enumValues[val] = val;
      }
      return enumValues;
    }
    get Enum() {
      const enumValues = {};
      for (const val of this._def.values) {
        enumValues[val] = val;
      }
      return enumValues;
    }
    extract(values, newDef = this._def) {
      return ZodEnum.create(values, {
        ...this._def,
        ...newDef
      });
    }
    exclude(values, newDef = this._def) {
      return ZodEnum.create(this.options.filter((opt) => !values.includes(opt)), {
        ...this._def,
        ...newDef
      });
    }
  }
  ZodEnum.create = createZodEnum;
  class ZodNativeEnum extends ZodType {
    _parse(input) {
      const nativeEnumValues = util.getValidEnumValues(this._def.values);
      const ctx = this._getOrReturnCtx(input);
      if (ctx.parsedType !== ZodParsedType.string && ctx.parsedType !== ZodParsedType.number) {
        const expectedValues = util.objectValues(nativeEnumValues);
        addIssueToContext(ctx, {
          expected: util.joinValues(expectedValues),
          received: ctx.parsedType,
          code: ZodIssueCode.invalid_type
        });
        return INVALID;
      }
      if (!this._cache) {
        this._cache = new Set(util.getValidEnumValues(this._def.values));
      }
      if (!this._cache.has(input.data)) {
        const expectedValues = util.objectValues(nativeEnumValues);
        addIssueToContext(ctx, {
          received: ctx.data,
          code: ZodIssueCode.invalid_enum_value,
          options: expectedValues
        });
        return INVALID;
      }
      return OK(input.data);
    }
    get enum() {
      return this._def.values;
    }
  }
  ZodNativeEnum.create = (values, params) => {
    return new ZodNativeEnum({
      values,
      typeName: ZodFirstPartyTypeKind.ZodNativeEnum,
      ...processCreateParams(params)
    });
  };
  class ZodPromise extends ZodType {
    unwrap() {
      return this._def.type;
    }
    _parse(input) {
      const { ctx } = this._processInputParams(input);
      if (ctx.parsedType !== ZodParsedType.promise && ctx.common.async === false) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.invalid_type,
          expected: ZodParsedType.promise,
          received: ctx.parsedType
        });
        return INVALID;
      }
      const promisified = ctx.parsedType === ZodParsedType.promise ? ctx.data : Promise.resolve(ctx.data);
      return OK(promisified.then((data) => {
        return this._def.type.parseAsync(data, {
          path: ctx.path,
          errorMap: ctx.common.contextualErrorMap
        });
      }));
    }
  }
  ZodPromise.create = (schema, params) => {
    return new ZodPromise({
      type: schema,
      typeName: ZodFirstPartyTypeKind.ZodPromise,
      ...processCreateParams(params)
    });
  };
  class ZodEffects extends ZodType {
    innerType() {
      return this._def.schema;
    }
    sourceType() {
      return this._def.schema._def.typeName === ZodFirstPartyTypeKind.ZodEffects ? this._def.schema.sourceType() : this._def.schema;
    }
    _parse(input) {
      const { status, ctx } = this._processInputParams(input);
      const effect = this._def.effect || null;
      const checkCtx = {
        addIssue: (arg) => {
          addIssueToContext(ctx, arg);
          if (arg.fatal) {
            status.abort();
          } else {
            status.dirty();
          }
        },
        get path() {
          return ctx.path;
        }
      };
      checkCtx.addIssue = checkCtx.addIssue.bind(checkCtx);
      if (effect.type === "preprocess") {
        const processed = effect.transform(ctx.data, checkCtx);
        if (ctx.common.async) {
          return Promise.resolve(processed).then(async (processed2) => {
            if (status.value === "aborted")
              return INVALID;
            const result = await this._def.schema._parseAsync({
              data: processed2,
              path: ctx.path,
              parent: ctx
            });
            if (result.status === "aborted")
              return INVALID;
            if (result.status === "dirty")
              return DIRTY(result.value);
            if (status.value === "dirty")
              return DIRTY(result.value);
            return result;
          });
        } else {
          if (status.value === "aborted")
            return INVALID;
          const result = this._def.schema._parseSync({
            data: processed,
            path: ctx.path,
            parent: ctx
          });
          if (result.status === "aborted")
            return INVALID;
          if (result.status === "dirty")
            return DIRTY(result.value);
          if (status.value === "dirty")
            return DIRTY(result.value);
          return result;
        }
      }
      if (effect.type === "refinement") {
        const executeRefinement = (acc) => {
          const result = effect.refinement(acc, checkCtx);
          if (ctx.common.async) {
            return Promise.resolve(result);
          }
          if (result instanceof Promise) {
            throw new Error("Async refinement encountered during synchronous parse operation. Use .parseAsync instead.");
          }
          return acc;
        };
        if (ctx.common.async === false) {
          const inner = this._def.schema._parseSync({
            data: ctx.data,
            path: ctx.path,
            parent: ctx
          });
          if (inner.status === "aborted")
            return INVALID;
          if (inner.status === "dirty")
            status.dirty();
          executeRefinement(inner.value);
          return { status: status.value, value: inner.value };
        } else {
          return this._def.schema._parseAsync({ data: ctx.data, path: ctx.path, parent: ctx }).then((inner) => {
            if (inner.status === "aborted")
              return INVALID;
            if (inner.status === "dirty")
              status.dirty();
            return executeRefinement(inner.value).then(() => {
              return { status: status.value, value: inner.value };
            });
          });
        }
      }
      if (effect.type === "transform") {
        if (ctx.common.async === false) {
          const base = this._def.schema._parseSync({
            data: ctx.data,
            path: ctx.path,
            parent: ctx
          });
          if (!isValid(base))
            return INVALID;
          const result = effect.transform(base.value, checkCtx);
          if (result instanceof Promise) {
            throw new Error(`Asynchronous transform encountered during synchronous parse operation. Use .parseAsync instead.`);
          }
          return { status: status.value, value: result };
        } else {
          return this._def.schema._parseAsync({ data: ctx.data, path: ctx.path, parent: ctx }).then((base) => {
            if (!isValid(base))
              return INVALID;
            return Promise.resolve(effect.transform(base.value, checkCtx)).then((result) => ({
              status: status.value,
              value: result
            }));
          });
        }
      }
      util.assertNever(effect);
    }
  }
  ZodEffects.create = (schema, effect, params) => {
    return new ZodEffects({
      schema,
      typeName: ZodFirstPartyTypeKind.ZodEffects,
      effect,
      ...processCreateParams(params)
    });
  };
  ZodEffects.createWithPreprocess = (preprocess, schema, params) => {
    return new ZodEffects({
      schema,
      effect: { type: "preprocess", transform: preprocess },
      typeName: ZodFirstPartyTypeKind.ZodEffects,
      ...processCreateParams(params)
    });
  };
  class ZodOptional extends ZodType {
    _parse(input) {
      const parsedType = this._getType(input);
      if (parsedType === ZodParsedType.undefined) {
        return OK(void 0);
      }
      return this._def.innerType._parse(input);
    }
    unwrap() {
      return this._def.innerType;
    }
  }
  ZodOptional.create = (type, params) => {
    return new ZodOptional({
      innerType: type,
      typeName: ZodFirstPartyTypeKind.ZodOptional,
      ...processCreateParams(params)
    });
  };
  class ZodNullable extends ZodType {
    _parse(input) {
      const parsedType = this._getType(input);
      if (parsedType === ZodParsedType.null) {
        return OK(null);
      }
      return this._def.innerType._parse(input);
    }
    unwrap() {
      return this._def.innerType;
    }
  }
  ZodNullable.create = (type, params) => {
    return new ZodNullable({
      innerType: type,
      typeName: ZodFirstPartyTypeKind.ZodNullable,
      ...processCreateParams(params)
    });
  };
  class ZodDefault extends ZodType {
    _parse(input) {
      const { ctx } = this._processInputParams(input);
      let data = ctx.data;
      if (ctx.parsedType === ZodParsedType.undefined) {
        data = this._def.defaultValue();
      }
      return this._def.innerType._parse({
        data,
        path: ctx.path,
        parent: ctx
      });
    }
    removeDefault() {
      return this._def.innerType;
    }
  }
  ZodDefault.create = (type, params) => {
    return new ZodDefault({
      innerType: type,
      typeName: ZodFirstPartyTypeKind.ZodDefault,
      defaultValue: typeof params.default === "function" ? params.default : () => params.default,
      ...processCreateParams(params)
    });
  };
  class ZodCatch extends ZodType {
    _parse(input) {
      const { ctx } = this._processInputParams(input);
      const newCtx = {
        ...ctx,
        common: {
          ...ctx.common,
          issues: []
        }
      };
      const result = this._def.innerType._parse({
        data: newCtx.data,
        path: newCtx.path,
        parent: {
          ...newCtx
        }
      });
      if (isAsync(result)) {
        return result.then((result2) => {
          return {
            status: "valid",
            value: result2.status === "valid" ? result2.value : this._def.catchValue({
              get error() {
                return new ZodError(newCtx.common.issues);
              },
              input: newCtx.data
            })
          };
        });
      } else {
        return {
          status: "valid",
          value: result.status === "valid" ? result.value : this._def.catchValue({
            get error() {
              return new ZodError(newCtx.common.issues);
            },
            input: newCtx.data
          })
        };
      }
    }
    removeCatch() {
      return this._def.innerType;
    }
  }
  ZodCatch.create = (type, params) => {
    return new ZodCatch({
      innerType: type,
      typeName: ZodFirstPartyTypeKind.ZodCatch,
      catchValue: typeof params.catch === "function" ? params.catch : () => params.catch,
      ...processCreateParams(params)
    });
  };
  class ZodNaN extends ZodType {
    _parse(input) {
      const parsedType = this._getType(input);
      if (parsedType !== ZodParsedType.nan) {
        const ctx = this._getOrReturnCtx(input);
        addIssueToContext(ctx, {
          code: ZodIssueCode.invalid_type,
          expected: ZodParsedType.nan,
          received: ctx.parsedType
        });
        return INVALID;
      }
      return { status: "valid", value: input.data };
    }
  }
  ZodNaN.create = (params) => {
    return new ZodNaN({
      typeName: ZodFirstPartyTypeKind.ZodNaN,
      ...processCreateParams(params)
    });
  };
  class ZodBranded extends ZodType {
    _parse(input) {
      const { ctx } = this._processInputParams(input);
      const data = ctx.data;
      return this._def.type._parse({
        data,
        path: ctx.path,
        parent: ctx
      });
    }
    unwrap() {
      return this._def.type;
    }
  }
  class ZodPipeline extends ZodType {
    _parse(input) {
      const { status, ctx } = this._processInputParams(input);
      if (ctx.common.async) {
        const handleAsync = async () => {
          const inResult = await this._def.in._parseAsync({
            data: ctx.data,
            path: ctx.path,
            parent: ctx
          });
          if (inResult.status === "aborted")
            return INVALID;
          if (inResult.status === "dirty") {
            status.dirty();
            return DIRTY(inResult.value);
          } else {
            return this._def.out._parseAsync({
              data: inResult.value,
              path: ctx.path,
              parent: ctx
            });
          }
        };
        return handleAsync();
      } else {
        const inResult = this._def.in._parseSync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx
        });
        if (inResult.status === "aborted")
          return INVALID;
        if (inResult.status === "dirty") {
          status.dirty();
          return {
            status: "dirty",
            value: inResult.value
          };
        } else {
          return this._def.out._parseSync({
            data: inResult.value,
            path: ctx.path,
            parent: ctx
          });
        }
      }
    }
    static create(a, b) {
      return new ZodPipeline({
        in: a,
        out: b,
        typeName: ZodFirstPartyTypeKind.ZodPipeline
      });
    }
  }
  class ZodReadonly extends ZodType {
    _parse(input) {
      const result = this._def.innerType._parse(input);
      const freeze = (data) => {
        if (isValid(data)) {
          data.value = Object.freeze(data.value);
        }
        return data;
      };
      return isAsync(result) ? result.then((data) => freeze(data)) : freeze(result);
    }
    unwrap() {
      return this._def.innerType;
    }
  }
  ZodReadonly.create = (type, params) => {
    return new ZodReadonly({
      innerType: type,
      typeName: ZodFirstPartyTypeKind.ZodReadonly,
      ...processCreateParams(params)
    });
  };
  var ZodFirstPartyTypeKind;
  (function(ZodFirstPartyTypeKind2) {
    ZodFirstPartyTypeKind2["ZodString"] = "ZodString";
    ZodFirstPartyTypeKind2["ZodNumber"] = "ZodNumber";
    ZodFirstPartyTypeKind2["ZodNaN"] = "ZodNaN";
    ZodFirstPartyTypeKind2["ZodBigInt"] = "ZodBigInt";
    ZodFirstPartyTypeKind2["ZodBoolean"] = "ZodBoolean";
    ZodFirstPartyTypeKind2["ZodDate"] = "ZodDate";
    ZodFirstPartyTypeKind2["ZodSymbol"] = "ZodSymbol";
    ZodFirstPartyTypeKind2["ZodUndefined"] = "ZodUndefined";
    ZodFirstPartyTypeKind2["ZodNull"] = "ZodNull";
    ZodFirstPartyTypeKind2["ZodAny"] = "ZodAny";
    ZodFirstPartyTypeKind2["ZodUnknown"] = "ZodUnknown";
    ZodFirstPartyTypeKind2["ZodNever"] = "ZodNever";
    ZodFirstPartyTypeKind2["ZodVoid"] = "ZodVoid";
    ZodFirstPartyTypeKind2["ZodArray"] = "ZodArray";
    ZodFirstPartyTypeKind2["ZodObject"] = "ZodObject";
    ZodFirstPartyTypeKind2["ZodUnion"] = "ZodUnion";
    ZodFirstPartyTypeKind2["ZodDiscriminatedUnion"] = "ZodDiscriminatedUnion";
    ZodFirstPartyTypeKind2["ZodIntersection"] = "ZodIntersection";
    ZodFirstPartyTypeKind2["ZodTuple"] = "ZodTuple";
    ZodFirstPartyTypeKind2["ZodRecord"] = "ZodRecord";
    ZodFirstPartyTypeKind2["ZodMap"] = "ZodMap";
    ZodFirstPartyTypeKind2["ZodSet"] = "ZodSet";
    ZodFirstPartyTypeKind2["ZodFunction"] = "ZodFunction";
    ZodFirstPartyTypeKind2["ZodLazy"] = "ZodLazy";
    ZodFirstPartyTypeKind2["ZodLiteral"] = "ZodLiteral";
    ZodFirstPartyTypeKind2["ZodEnum"] = "ZodEnum";
    ZodFirstPartyTypeKind2["ZodEffects"] = "ZodEffects";
    ZodFirstPartyTypeKind2["ZodNativeEnum"] = "ZodNativeEnum";
    ZodFirstPartyTypeKind2["ZodOptional"] = "ZodOptional";
    ZodFirstPartyTypeKind2["ZodNullable"] = "ZodNullable";
    ZodFirstPartyTypeKind2["ZodDefault"] = "ZodDefault";
    ZodFirstPartyTypeKind2["ZodCatch"] = "ZodCatch";
    ZodFirstPartyTypeKind2["ZodPromise"] = "ZodPromise";
    ZodFirstPartyTypeKind2["ZodBranded"] = "ZodBranded";
    ZodFirstPartyTypeKind2["ZodPipeline"] = "ZodPipeline";
    ZodFirstPartyTypeKind2["ZodReadonly"] = "ZodReadonly";
  })(ZodFirstPartyTypeKind || (ZodFirstPartyTypeKind = {}));
  const stringType = ZodString.create;
  const unknownType = ZodUnknown.create;
  ZodNever.create;
  ZodArray.create;
  const objectType = ZodObject.create;
  ZodUnion.create;
  ZodIntersection.create;
  ZodTuple.create;
  const enumType = ZodEnum.create;
  ZodPromise.create;
  ZodOptional.create;
  ZodNullable.create;
  const IPC_DOMAINS = [
    "app",
    "store",
    "ssh",
    "sftp",
    "forward",
    "pty",
    "telnet",
    "vnc",
    "rdp",
    "monitor",
    "notes",
    "completion",
    "ai",
    "mcp",
    "sessionlog",
    "settings",
    "sync",
    "hotkey",
    "broadcast",
    "quickcmd",
    "system",
    "update",
    "shellIntegration"
  ];
  objectType({
    domain: enumType(IPC_DOMAINS),
    action: stringType().min(1),
    payload: unknownType()
  });
  const KITTY_CELL_WORDS = 8;
  const FUNCTION_KEYS = {
    Escape: 57344,
    Enter: 57345,
    Tab: 57346,
    Backspace: 57347,
    Insert: 57348,
    Delete: 57349,
    ArrowLeft: 57350,
    ArrowRight: 57351,
    ArrowUp: 57352,
    ArrowDown: 57353,
    PageUp: 57354,
    PageDown: 57355,
    Home: 57356,
    End: 57357,
    F1: 57364,
    F2: 57365,
    F3: 57366,
    F4: 57367,
    F5: 57368,
    F6: 57369,
    F7: 57370,
    F8: 57371,
    F9: 57372,
    F10: 57373,
    F11: 57374,
    F12: 57375
  };
  const CURSOR_SHAPES = {
    0: "block",
    1: "block",
    2: "beam",
    3: "underline",
    4: "hollow"
  };
  const sessions = /* @__PURE__ */ new Map();
  let wasmBuffer = null;
  let wasmModule = null;
  let flushScheduled = false;
  const pendingFlush = /* @__PURE__ */ new Set();
  function post(msg, transfer = []) {
    self.postMessage(msg, transfer);
  }
  function fail(id, error) {
    post({ t: "reply", id, ok: false, error: error instanceof Error ? error.message : String(error) });
  }
  async function createSession(sessionId, cols, rows, scrollback) {
    if (!wasmBuffer && !wasmModule) throw new Error("内核尚未加载");
    if (!wasmModule && wasmBuffer) {
      wasmModule = await WebAssembly.compile(wasmBuffer);
    }
    const opts = {
      columns: cols,
      rows,
      scrollback,
      wasm: wasmModule ?? wasmBuffer ?? void 0,
      onOutput: (bytes) => {
        post({ t: "write", sessionId, data: decode(bytes) });
      },
      onEvent: (ev) => handleEvent(sessionId, ev)
    };
    const term = await KittyTerminal.create(opts);
    const session = {
      term,
      cols,
      rows,
      cols_words: cols * KITTY_CELL_WORDS,
      seq: 0,
      lastScrolledBy: 0,
      forceFull: true,
      title: "",
      cwd: "",
      selectionAnchor: null,
      selectionCursor: null,
      rectangle: false,
      searchIndex: -1,
      searchHits: [],
      cwdTail: "",
      lastActivity: Date.now()
    };
    sessions.set(sessionId, session);
    scheduleFlush(sessionId);
  }
  function decode(bytes) {
    return new TextDecoder().decode(bytes);
  }
  function handleEvent(sessionId, ev) {
    const s = sessions.get(sessionId);
    if (!s) return;
    switch (ev.type) {
      case "title":
        s.title = ev.title;
        post({ t: "event", sessionId, event: { type: "title", title: ev.title } });
        return;
      case "bell":
        post({ t: "event", sessionId, event: { type: "bell" } });
        return;
      case "clipboard":
        post({ t: "event", sessionId, event: { type: "clipboard", data: ev.data, query: ev.query } });
        return;
      case "notification":
        post({ t: "event", sessionId, event: { type: "notify", message: ev.data } });
        return;
      case "progress":
        post({ t: "event", sessionId, event: { type: "progress", state: ev.state, percent: ev.percent } });
        return;
      case "reset":
        post({ t: "event", sessionId, event: { type: "reset" } });
        scheduleFlush(sessionId, true);
        return;
      case "graphics_command":
        post({ t: "event", sessionId, event: { type: "graphics", command: mapGraphics(ev) } });
        return;
      default:
        return;
    }
  }
  function mapGraphics(ev) {
    return {
      action: ev.action,
      deleteAction: ev.delete_action,
      transmission: ev.transmission,
      id: ev.id,
      imageNumber: ev.image_number,
      placementId: ev.placement_id,
      format: ev.format,
      more: ev.more,
      width: ev.width,
      height: ev.height,
      xOffset: ev.x_offset,
      yOffset: ev.y_offset,
      dataWidth: ev.data_width,
      dataHeight: ev.data_height,
      zIndex: ev.z_index,
      compressed: ev.compressed,
      unicodePlacement: ev.unicode_placement,
      payload: ev.payload
    };
  }
  function scheduleFlush(sessionId, full = false) {
    const s = sessions.get(sessionId);
    if (s && full) s.forceFull = true;
    pendingFlush.add(sessionId);
    if (flushScheduled) return;
    flushScheduled = true;
    setTimeout(() => {
      flushScheduled = false;
      const ids = [...pendingFlush];
      pendingFlush.clear();
      for (const id of ids) {
        try {
          flush(id);
        } catch (err) {
          post({ t: "event", sessionId: id, event: { type: "notify", message: `渲染帧失败：${String(err)}` } });
        }
      }
    }, 8);
  }
  function flush(sessionId) {
    const s = sessions.get(sessionId);
    if (!s) return;
    const term = s.term;
    const rows = term.rows;
    const cols = term.columns;
    const colsWords = cols * KITTY_CELL_WORDS;
    if (colsWords !== s.cols_words || rows !== s.rows) {
      s.cols = cols;
      s.rows = rows;
      s.cols_words = colsWords;
      s.forceFull = true;
    }
    const scrolledBy = term.scrolledBy;
    const full = s.forceFull || scrolledBy !== s.lastScrolledBy;
    s.forceFull = false;
    s.lastScrolledBy = scrolledBy;
    const rowsOut = [];
    const transfer = [];
    for (let y = 0; y < rows; y += 1) {
      if (!full && !term.lineDirty(y)) continue;
      const words = term.viewportLineCells(y);
      if (!words || words.length === 0) continue;
      const copy = words.slice(0, colsWords);
      rowsOut.push({ y, words: copy.buffer });
      transfer.push(copy.buffer);
    }
    term.clearDirty();
    const meta = buildMeta(s, term, scrolledBy);
    s.seq += 1;
    meta.seq = s.seq;
    post({ t: "frame", sessionId, meta, rows: rowsOut, full }, transfer);
  }
  function rgbOf(color) {
    if (!color) return null;
    return "rgb" in color ? color.rgb : null;
  }
  function buildMeta(s, term, scrolledBy) {
    const cur = term.cursor;
    const shape = CURSOR_SHAPES[cur.shape] ?? "block";
    const palette = new Array(256);
    for (let i = 0; i < 256; i += 1) palette[i] = term.paletteColor(i);
    return {
      seq: s.seq,
      cols: term.columns,
      rows: term.rows,
      cursor: { x: cur.x, y: cur.y, shape: cur.visible ? shape : "none", visible: cur.visible, blink: cur.blink },
      modes: {
        bracketedPaste: term.mode(2004) === 1,
        applicationCursorKeys: term.mode(1) === 1,
        altScreen: !term.isMainScreen,
        mouseTracking: term.mode(1e3) === 1 || term.mode(1002) === 1 || term.mode(1003) === 1,
        focusTracking: term.mode(1004) === 1
      },
      scrolledBy,
      scrollbackLength: term.scrollbackLength,
      title: s.title,
      defaultFg: rgbOf(term.defaultFg),
      defaultBg: rgbOf(term.defaultBg),
      cursorColor: rgbOf(term.cursorColor),
      palette,
      selection: computeSelectionSpans(s, term)
    };
  }
  function computeSelectionSpans(s, term, scrolledBy) {
    const a = s.selectionAnchor;
    const b = s.selectionCursor;
    if (!a || !b) return null;
    const spans = [];
    const y1 = Math.min(a.y, b.y);
    const y2 = Math.max(a.y, b.y);
    const cols = term.columns;
    for (let y = y1; y <= y2; y += 1) {
      if (y < 0 || y >= term.rows) continue;
      if (s.rectangle) {
        const x1 = Math.min(a.x, b.x);
        const x2 = Math.max(a.x, b.x);
        spans.push({ y, x1, x2 });
        continue;
      }
      if (y1 === y2) {
        spans.push({ y, x1: Math.min(a.x, b.x), x2: Math.max(a.x, b.x) });
        continue;
      }
      const fromStart = a.y <= b.y;
      if (y === y1) {
        spans.push({ y, x1: fromStart ? a.x : 0, x2: cols - 1 });
      } else if (y === y2) {
        spans.push({ y, x1: 0, x2: fromStart ? b.x : a.x });
      } else {
        spans.push({ y, x1: 0, x2: cols - 1 });
      }
    }
    return spans.length > 0 ? spans : null;
  }
  const OSC7_PREFIX = "\x1B]7;";
  const OSC7_RE = /\x1b]7;(?:file:\/\/[^/]*)?([^\x07\x1b]*)(?:\x07|\x1b\\)/;
  function sniffCwd(sessionId, text) {
    const s = sessions.get(sessionId);
    if (!s || !text.includes(OSC7_PREFIX)) return;
    const hay = s.cwdTail + text;
    s.cwdTail = hay.slice(-64);
    const m = OSC7_RE.exec(hay);
    if (!m || !m[1]) return;
    const path = decodeURIComponent(m[1]);
    if (path && path !== s.cwd) {
      s.cwd = path;
      post({ t: "event", sessionId, event: { type: "cwd", path } });
    }
  }
  function modsOf(mask) {
    return { shift: (mask & 1) !== 0, alt: (mask & 2) !== 0, ctrl: (mask & 4) !== 0, super: (mask & 8) !== 0 };
  }
  function searchOver(s, term, pattern) {
    s.searchHits = [];
    s.searchIndex = -1;
    if (!pattern) return;
    const needle = pattern.toLowerCase();
    const history = term.scrollbackLength;
    const rows = term.rows;
    const scan = (text, abs) => {
      if (!text) return;
      const lower = text.toLowerCase();
      let from = 0;
      for (; ; ) {
        const at = lower.indexOf(needle, from);
        if (at < 0) break;
        s.searchHits.push({ abs, x1: at, x2: at + needle.length - 1 });
        from = at + Math.max(1, needle.length);
        if (s.searchHits.length > 5e3) break;
      }
    };
    for (let i = 0; i < history; i += 1) scan(term.scrollbackLine(i) ?? "", i);
    for (let y = 0; y < rows; y += 1) scan(term.line(y), history + y);
  }
  function jumpToHit(s, term, abs) {
    const history = term.scrollbackLength;
    const rows = term.rows;
    const current = term.scrolledBy;
    const wantY = Math.max(0, Math.min(rows - 1, Math.floor(rows / 3)));
    const targetScrolledBy = Math.max(0, Math.min(history, history - abs + wantY));
    const delta = targetScrolledBy - current;
    if (delta !== 0) term.scrollViewport(delta);
  }
  function searchResult(s, term, index) {
    const scrolledBy = term.scrolledBy;
    const history = term.scrollbackLength;
    const hits = s.searchHits.map((h) => ({
      y: h.abs - (history - scrolledBy),
      x1: h.x1,
      x2: h.x2
    }));
    return { hits, index, total: hits.length, scrolledBy };
  }
  async function handle(req) {
    switch (req.t) {
      case "init": {
        wasmBuffer = req.wasm;
        wasmModule = await WebAssembly.compile(req.wasm);
        post({ t: "reply", id: req.id, ok: true, value: { bytes: req.wasm.byteLength } });
        post({ t: "ready" });
        return;
      }
      case "create": {
        await createSession(req.sessionId, req.cols, req.rows, req.scrollback);
        post({ t: "reply", id: req.id, ok: true, value: { sessionId: req.sessionId } });
        return;
      }
      case "dispose": {
        const s = sessions.get(req.sessionId);
        s?.term.dispose();
        sessions.delete(req.sessionId);
        post({ t: "reply", id: req.id, ok: true, value: null });
        return;
      }
      case "data": {
        const s = sessions.get(req.sessionId);
        if (!s) {
          post({ t: "reply", id: req.id, ok: true, value: null });
          return;
        }
        const bytes = new Uint8Array(req.chunk);
        s.term.write(bytes);
        s.lastActivity = Date.now();
        if (bytes.length > 0) {
          if (bytes.includes(27)) {
            sniffCwd(req.sessionId, new TextDecoder().decode(bytes));
          }
        }
        scheduleFlush(req.sessionId, s.searchHits.length > 0);
        post({ t: "reply", id: req.id, ok: true, value: { bytes: bytes.length } });
        return;
      }
      case "resize": {
        const s = sessions.get(req.sessionId);
        if (!s) throw new Error("会话不存在");
        s.term.resize(req.cols, req.rows);
        s.forceFull = true;
        scheduleFlush(req.sessionId, true);
        post({ t: "reply", id: req.id, ok: true, value: { cols: req.cols, rows: req.rows } });
        return;
      }
      case "key": {
        const s = sessions.get(req.sessionId);
        if (!s) throw new Error("会话不存在");
        const key = FUNCTION_KEYS[req.key] ?? req.key;
        const encoded = s.term.encodeKey(key, modsOf(req.mods), req.action);
        if (encoded) post({ t: "write", sessionId: req.sessionId, data: encoded });
        post({ t: "reply", id: req.id, ok: true, value: encoded });
        return;
      }
      case "paste": {
        const s = sessions.get(req.sessionId);
        if (!s) throw new Error("会话不存在");
        const encoded = s.term.paste(req.text);
        if (encoded) post({ t: "write", sessionId: req.sessionId, data: encoded });
        post({ t: "reply", id: req.id, ok: true, value: encoded });
        return;
      }
      case "mouse": {
        const s = sessions.get(req.sessionId);
        if (!s) throw new Error("会话不存在");
        const encoded = s.term.encodeMouse({
          x: req.x,
          y: req.y,
          button: req.button,
          action: req.action,
          mods: modsOf(req.mods)
        });
        if (encoded) post({ t: "write", sessionId: req.sessionId, data: encoded });
        post({ t: "reply", id: req.id, ok: true, value: encoded });
        return;
      }
      case "focus": {
        const s = sessions.get(req.sessionId);
        if (!s) throw new Error("会话不存在");
        const encoded = s.term.encodeFocus(req.focused);
        if (encoded) post({ t: "write", sessionId: req.sessionId, data: encoded });
        post({ t: "reply", id: req.id, ok: true, value: encoded });
        return;
      }
      case "scroll": {
        const s = sessions.get(req.sessionId);
        if (!s) throw new Error("会话不存在");
        const moved = s.term.scrollViewport(req.action);
        if (moved) scheduleFlush(req.sessionId, true);
        post({ t: "reply", id: req.id, ok: true, value: moved });
        return;
      }
      case "selection": {
        const s = sessions.get(req.sessionId);
        if (!s) throw new Error("会话不存在");
        if (req.kind === "clear") {
          s.selectionAnchor = null;
          s.selectionCursor = null;
          s.term.selectionClear();
          scheduleFlush(req.sessionId, true);
          post({ t: "reply", id: req.id, ok: true, value: null });
          return;
        }
        if (req.kind === "start") {
          s.selectionAnchor = { x: req.x, y: req.y };
          s.selectionCursor = { x: req.x, y: req.y };
          s.rectangle = req.rectangle ?? false;
          s.term.selectionStart(req.x, req.y, { rectangle: req.rectangle });
        } else {
          s.selectionCursor = { x: req.x, y: req.y };
          s.term.selectionUpdate(req.x, req.y, { ended: req.ended });
        }
        scheduleFlush(req.sessionId, true);
        const text = s.term.selectionText({ stripTrailingWhitespace: true });
        post({ t: "reply", id: req.id, ok: true, value: { text } });
        return;
      }
      case "search": {
        const s = sessions.get(req.sessionId);
        if (!s) throw new Error("会话不存在");
        if (req.step === "first") {
          searchOver(s, s.term, req.pattern);
          const first = s.searchHits[0];
          if (first) {
            s.searchIndex = 0;
            jumpToHit(s, s.term, first.abs);
          }
        } else if (s.searchHits.length > 0) {
          const n = s.searchHits.length;
          s.searchIndex = (s.searchIndex + (req.step === "next" ? 1 : -1) + n) % n;
          const hit = s.searchHits[s.searchIndex];
          if (hit) jumpToHit(s, s.term, hit.abs);
        }
        scheduleFlush(req.sessionId, true);
        post({ t: "reply", id: req.id, ok: true, value: searchResult(s, s.term, s.searchIndex) });
        return;
      }
      case "selectAll": {
        const s = sessions.get(req.sessionId);
        if (!s) throw new Error("会话不存在");
        s.term.selectionStart(0, 0);
        s.term.selectionUpdate(s.term.columns - 1, s.term.rows - 1, { ended: true });
        s.selectionAnchor = { x: 0, y: 0 };
        s.selectionCursor = { x: s.term.columns - 1, y: s.term.rows - 1 };
        scheduleFlush(req.sessionId, true);
        post({ t: "reply", id: req.id, ok: true, value: { text: s.term.selectionText() } });
        return;
      }
      case "serialize": {
        const s = sessions.get(req.sessionId);
        if (!s) throw new Error("会话不存在");
        const bytes = s.term.serialize();
        post({ t: "reply", id: req.id, ok: true, value: { text: new TextDecoder().decode(bytes) } });
        return;
      }
      case "refresh": {
        scheduleFlush(req.sessionId, true);
        post({ t: "reply", id: req.id, ok: true, value: null });
        return;
      }
      case "stats": {
        const s = sessions.get(req.sessionId);
        if (!s) throw new Error("会话不存在");
        post({
          t: "reply",
          id: req.id,
          ok: true,
          value: {
            cols: s.term.columns,
            rows: s.term.rows,
            scrollback: s.term.scrollbackLength,
            title: s.title,
            cwd: s.cwd,
            memoryBytes: 0
          }
        });
        return;
      }
      default:
        throw new Error("未知请求");
    }
  }
  self.onmessage = (ev) => {
    const req = ev.data;
    void handle(req).catch((err) => {
      if (typeof req.id === "number") fail(req.id, err);
      else post({ t: "fatal", error: String(err) });
    });
  };
  var __viteBrowserExternal = /* @__PURE__ */ Object.freeze({
    __proto__: null
  });
})();
