import { i as invoke } from "./index-CwfghMy4.js";
const KITTY_CELL_WORDS = 8;
const ATLAS_SIZE = 2048;
const PAD = 1;
const COLOR_GLYPH = new RegExp("\\p{Extended_Pictographic}|\\p{Regional_Indicator}", "u");
class GlyphAtlas {
  constructor(opts) {
    this.cache = /* @__PURE__ */ new Map();
    this.shelfY = 0;
    this.shelfH = 0;
    this.penX = 0;
    this.dirty = null;
    this.fullUpload = true;
    this.opts = opts;
    this.canvas = document.createElement("canvas");
    this.canvas.width = ATLAS_SIZE;
    this.canvas.height = ATLAS_SIZE;
    const ctx = this.canvas.getContext("2d", { alpha: true });
    if (!ctx) throw new Error("无法创建 2D 画布（字形图集）");
    this.ctx = ctx;
    const { cssFont, fontPx } = this.fontOf(false);
    this.ctx.font = cssFont;
    const metrics = this.ctx.measureText("M");
    const advance = metrics.width || fontPx * 0.6;
    this.cellW = Math.max(1, Math.round(advance));
    const ascent = metrics.fontBoundingBoxAscent || metrics.actualBoundingBoxAscent || fontPx * 0.8;
    const descent = metrics.fontBoundingBoxDescent || metrics.actualBoundingBoxDescent || fontPx * 0.2;
    const lineHeightPx = Math.round(fontPx * 1.2);
    this.cellH = Math.max(Math.round(ascent + descent) + 2, Math.round(lineHeightPx));
    this.baseline = Math.round((this.cellH - (ascent + descent)) / 2 + ascent);
  }
  /** canvas 回退渲染器要用的字号（设备像素） */
  get fontSizeDpr() {
    return Math.round(this.opts.fontSize * this.opts.dpr);
  }
  get fontWeight() {
    return this.opts.fontWeight;
  }
  get fontFamilyCss() {
    return this.opts.fontFamily;
  }
  fontOf(bold) {
    const weight = bold ? this.opts.boldWeight : this.opts.fontWeight;
    const fontPx = Math.round(this.opts.fontSize * this.opts.dpr);
    this.opts.fontFeatures.length > 0 ? `font-feature-settings: ${this.opts.fontFeatures.join(", ")};` : "";
    return {
      cssFont: `${weight} ${fontPx}px ${this.opts.fontFamily}`,
      fontPx
    };
  }
  /** 计算一段文本的覆盖列数（等宽字体下就是字符数，宽字符按 2 算） */
  spanOf(text) {
    let span = 0;
    for (const ch of text) {
      const cp = ch.codePointAt(0) ?? 0;
      span += isWide(cp) ? 2 : 1;
    }
    return Math.max(1, span);
  }
  /** 取一个字形条目；没有就现光栅化 */
  entry(text, style, span) {
    const key = `${style.bold ? "b" : "n"}${style.italic ? "i" : "n"}:${span}:${text}`;
    const hit = this.cache.get(key);
    if (hit) return hit;
    const { cssFont } = this.fontOf(style.bold);
    this.ctx.font = cssFont;
    this.ctx.textBaseline = "alphabetic";
    const w = Math.max(1, Math.min(ATLAS_SIZE, this.cellW * span));
    const h = this.cellH;
    const rect = this.alloc(w + PAD * 2, h + PAD * 2);
    if (!rect) {
      this.reset();
      const again = this.alloc(w + PAD * 2, h + PAD * 2);
      if (!again) throw new Error("字形图集已满");
      return this.rasterize(text, style, span, again);
    }
    return this.rasterize(text, style, span, rect);
  }
  rasterize(text, style, span, rect) {
    const { cssFont } = this.fontOf(style.bold);
    const ctx = this.ctx;
    ctx.save();
    ctx.font = cssFont;
    ctx.textBaseline = "alphabetic";
    ctx.clearRect(rect.x, rect.y, rect.w, rect.h);
    const colored = COLOR_GLYPH.test(text);
    ctx.fillStyle = colored ? "#ffffff" : "#ffffff";
    ctx.fillText(text, rect.x + PAD, rect.y + PAD + this.baseline);
    ctx.restore();
    const entry = {
      u0: (rect.x + PAD) / ATLAS_SIZE,
      v0: (rect.y + PAD) / ATLAS_SIZE,
      u1: (rect.x + PAD + this.cellW * span) / ATLAS_SIZE,
      v1: (rect.y + PAD + this.cellH) / ATLAS_SIZE,
      span,
      colored
    };
    const key = `${style.bold ? "b" : "n"}${style.italic ? "i" : "n"}:${span}:${text}`;
    this.cache.set(key, entry);
    this.markDirty(rect);
    return entry;
  }
  reset() {
    this.cache.clear();
    this.ctx.clearRect(0, 0, ATLAS_SIZE, ATLAS_SIZE);
    this.shelfY = 0;
    this.shelfH = 0;
    this.penX = 0;
    this.fullUpload = true;
    this.dirty = null;
  }
  /** 货架式分配：一行一行铺，铺满换下一行 */
  alloc(w, h) {
    if (w > ATLAS_SIZE) return null;
    if (this.penX + w > ATLAS_SIZE) {
      this.shelfY += this.shelfH;
      this.shelfH = 0;
      this.penX = 0;
    }
    if (this.shelfY + h > ATLAS_SIZE) return null;
    const rect = { x: this.penX, y: this.shelfY, w, h };
    this.penX += w;
    this.shelfH = Math.max(this.shelfH, h);
    return rect;
  }
  markDirty(rect) {
    if (!this.dirty) {
      this.dirty = { ...rect };
      return;
    }
    const x0 = Math.min(this.dirty.x, rect.x);
    const y0 = Math.min(this.dirty.y, rect.y);
    const x1 = Math.max(this.dirty.x + this.dirty.w, rect.x + rect.w);
    const y1 = Math.max(this.dirty.y + this.dirty.h, rect.y + rect.h);
    this.dirty = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }
  /**
   * 把新增字形补进纹理。
   * @returns true 表示这次是全量上传（首次或图集重建）
   */
  upload(gl, texture) {
    gl.bindTexture(gl.TEXTURE_2D, texture);
    if (this.fullUpload) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.canvas);
      this.fullUpload = false;
      this.dirty = null;
      return true;
    }
    const d = this.dirty;
    if (!d) return false;
    const sub = gl.texSubImage2D.bind(gl);
    sub(gl.TEXTURE_2D, 0, d.x, d.y, gl.RGBA, gl.UNSIGNED_BYTE, this.canvas, d.x, d.y, d.w, d.h);
    this.dirty = null;
    return false;
  }
  /**
   * 这段文本在这套字体下是否真的会被「连起来」。
   *
   * 判据很朴素：整段成形的宽度明显小于逐字宽度之和。像 `->`、`!=`、`=>` 这类
   * 连字在 JetBrains Mono / Fira Code 里都满足；普通 `abc` 不满足，于是回退到
   * 逐格绘制（保持每格可独立着色与选中）。
   */
  hasLigature(text, span) {
    if (span < 2) return false;
    const { cssFont } = this.fontOf(false);
    this.ctx.save();
    this.ctx.font = cssFont;
    const width = this.ctx.measureText(text).width;
    this.ctx.restore();
    return width > 0 && width < span * this.cellW - 0.5;
  }
  /** 供 canvas 回退渲染器直接取像素源 */
  get source() {
    return this.canvas;
  }
}
function isWide(cp) {
  return cp >= 4352 && cp <= 4447 || cp >= 11904 && cp <= 42191 || cp >= 44032 && cp <= 55203 || cp >= 63744 && cp <= 64255 || cp >= 65072 && cp <= 65135 || cp >= 65280 && cp <= 65376 || cp >= 65504 && cp <= 65510 || cp >= 127744 && cp <= 128591 || cp >= 129280 && cp <= 129535 || cp >= 128640 && cp <= 128767 || cp >= 127462 && cp <= 127487 || cp >= 131072 && cp <= 262141;
}
const SCHEME_DARK = [
  "#1e222b",
  "#e5484d",
  "#46b17b",
  "#d9a441",
  "#6f8dff",
  "#b48ce0",
  "#3ec9d6",
  "#c6ccd8",
  "#4c5361",
  "#ff6b6f",
  "#63d29a",
  "#f0c065",
  "#8fa6ff",
  "#cfa8f0",
  "#63dde8",
  "#f2f4f8"
];
const SCHEME_LIGHT = [
  "#1e222b",
  "#c62f34",
  "#1f8a52",
  "#9a6b00",
  "#3457d5",
  "#8b4bb5",
  "#0f7f8b",
  "#4a5260",
  "#6b7382",
  "#e5484d",
  "#2aa869",
  "#b8860b",
  "#5b7bff",
  "#a86fd1",
  "#1a9ba8",
  "#20242c"
];
const BG_DARK = "#0d0f14";
const BG_LIGHT = "#fbfcfe";
function parseHex(hex, alpha = 1) {
  const trimmed = hex.trim();
  if (trimmed.startsWith("#")) {
    const h = trimmed.slice(1);
    if (h.length === 3) {
      const v = Number.parseInt(h, 16);
      return { r: (v >> 8 & 15) / 15, g: (v >> 4 & 15) / 15, b: (v & 15) / 15, a: alpha };
    }
    if (h.length === 6 || h.length === 8) {
      const v = Number.parseInt(h.slice(0, 6), 16);
      return {
        r: (v >> 16 & 255) / 255,
        g: (v >> 8 & 255) / 255,
        b: (v & 255) / 255,
        a: h.length === 8 ? Number.parseInt(h.slice(6, 8), 16) / 255 : alpha
      };
    }
  }
  const m = /rgba?\(([^)]+)\)/.exec(trimmed);
  if (m && m[1]) {
    const parts = m[1].split(",").map((p) => Number.parseFloat(p.trim()));
    return {
      r: (parts[0] ?? 0) / 255,
      g: (parts[1] ?? 0) / 255,
      b: (parts[2] ?? 0) / 255,
      a: parts[3] ?? alpha
    };
  }
  return { r: 1, g: 1, b: 1, a: alpha };
}
function fromRgbInt(rgb, alpha = 1) {
  return {
    r: (rgb >> 16 & 255) / 255,
    g: (rgb >> 8 & 255) / 255,
    b: (rgb & 255) / 255,
    a: alpha
  };
}
function buildTheme(input) {
  const { settings, resolved, core } = input;
  const scheme = settings.colorScheme === "light" || settings.colorScheme === "default-dark" && resolved === "light" ? SCHEME_LIGHT : settings.colorScheme === "high-contrast" ? [...SCHEME_DARK.slice(0, 8), "#8a8a8a", "#ff6b6f", "#63d29a", "#f0c065", "#8fa6ff", "#cfa8f0", "#63dde8", "#ffffff"] : SCHEME_DARK;
  const palette = new Array(256);
  for (let i = 0; i < 256; i += 1) {
    const override = settings.palette[i];
    if (override) palette[i] = parseHex(override);
    else if (i < 16) palette[i] = parseHex(scheme[i] ?? "#ffffff");
    else if (core && core.palette[i] !== void 0) palette[i] = fromRgbInt(core.palette[i] ?? 0);
    else palette[i] = defaultPalette(i);
  }
  const lightTheme = scheme === SCHEME_LIGHT;
  const bgBase = parseHex(lightTheme ? BG_LIGHT : BG_DARK);
  const fgBase = parseHex(lightTheme ? "#1b2029" : "#e4e7ee");
  const bg = core?.bg != null ? fromRgbInt(core.bg, settings.backgroundOpacity) : { ...bgBase, a: settings.backgroundOpacity };
  const fg = core?.fg != null ? fromRgbInt(core.fg) : fgBase;
  const cursor = core?.cursor != null ? fromRgbInt(core.cursor, settings.cursorOpacity) : { ...parseHex(lightTheme ? "#12909e" : "#3ec9d6"), a: settings.cursorOpacity };
  return {
    fg,
    bg,
    cursor,
    selectionBg: parseHex(settings.selectionBackground, 0.72),
    selectionFg: parseHex(settings.selectionForeground, 1),
    underline: settings.underlineColor ? parseHex(settings.underlineColor) : null,
    palette
  };
}
function defaultPalette(index) {
  if (index < 16) return parseHex(SCHEME_DARK[index] ?? "#ffffff");
  if (index < 232) {
    const n = index - 16;
    const steps = [0, 95, 135, 175, 215, 255];
    const r = steps[Math.floor(n / 36) % 6] ?? 0;
    const g = steps[Math.floor(n / 6) % 6] ?? 0;
    const b = steps[n % 6] ?? 0;
    return { r: r / 255, g: g / 255, b: b / 255, a: 1 };
  }
  const v = 8 + (index - 232) * 10;
  return { r: v / 255, g: v / 255, b: v / 255, a: 1 };
}
const F_DIM$1 = 2;
const F_REVERSE$1 = 8;
const F_STRIKE$1 = 16;
const F_BLINK$1 = 32;
const F_WIDE$1 = 64;
const F_WIDE_TRAIL$1 = 128;
const F_UNDERLINE_MASK$1 = 7 << 8;
const F_UNDERLINE_SHIFT$1 = 8;
function css(c) {
  return `rgba(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)},${c.a})`;
}
class CanvasTerminalRenderer {
  constructor(canvas, atlas, theme, opts, dpr, fontFamily) {
    this.cols = 80;
    this.rows = 24;
    this.meta = null;
    this.grid = new Uint32Array(0);
    this.highlights = [];
    this.search = [];
    this.searchActive = -1;
    this.blinkOff = false;
    this.canvas = canvas;
    this.atlas = atlas;
    this.theme = theme;
    this.opts = opts;
    this.dpr = dpr;
    this.fontFamily = fontFamily;
    const ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) throw new Error("2D 画布不可用");
    this.ctx = ctx;
  }
  setTheme(theme) {
    this.theme = theme;
  }
  setOptions(opts) {
    this.opts = opts;
  }
  setHighlights(spans) {
    this.highlights = spans;
  }
  setSearch(spans, active) {
    this.search = spans;
    this.searchActive = active;
  }
  setBlinkOff(off) {
    if (this.blinkOff === off) return false;
    this.blinkOff = off;
    return true;
  }
  setGrid(cols, rows) {
    if (cols === this.cols && rows === this.rows) return;
    this.cols = cols;
    this.rows = rows;
    this.grid = new Uint32Array(cols * rows * KITTY_CELL_WORDS);
  }
  resize(cssWidth, cssHeight, cols, rows, dpr) {
    const w = Math.max(1, Math.round(cssWidth * dpr));
    const h = Math.max(1, Math.round(cssHeight * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.dpr = dpr;
    this.setGrid(cols, rows);
  }
  applyFrame(meta, rows, _full) {
    this.setGrid(meta.cols, meta.rows);
    this.meta = meta;
    for (const row of rows) {
      if (row.y < 0 || row.y >= this.rows) continue;
      const dst = new Uint32Array(
        this.grid.buffer,
        row.y * this.cols * KITTY_CELL_WORDS * 4,
        this.cols * KITTY_CELL_WORDS
      );
      const src = new Uint32Array(row.words);
      dst.set(src.subarray(0, Math.min(src.length, dst.length)));
    }
  }
  get hasFrame() {
    return this.meta !== null;
  }
  packed(word, background) {
    const kind = word >>> 24;
    if (kind === 1) return this.theme.palette[word & 255] ?? this.theme.fg;
    if (kind === 2) {
      const rgb = word & 16777215;
      return { r: (rgb >> 16 & 255) / 255, g: (rgb >> 8 & 255) / 255, b: (rgb & 255) / 255, a: 1 };
    }
    return background ? this.theme.bg : this.theme.fg;
  }
  render() {
    const meta = this.meta;
    if (!meta) return;
    const ctx = this.ctx;
    const cw = this.atlas.cellW;
    const ch = this.atlas.cellH;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.fillStyle = css(this.theme.bg);
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.textBaseline = "alphabetic";
    ctx.font = `${this.atlas.fontWeight} ${this.atlas.fontSizeDpr}px ${this.atlas.fontFamilyCss}`;
    const abs0 = meta.scrollbackLength - meta.scrolledBy;
    for (let y = 0; y < this.rows; y += 1) {
      const abs = abs0 + y;
      const sel = meta.selection?.find((s) => s.y === y) ?? null;
      for (let x = 0; x < this.cols; x += 1) {
        const i = (y * this.cols + x) * KITTY_CELL_WORDS;
        const cp = this.grid[i] ?? 0;
        const flags = this.grid[i + 6] ?? 0;
        const reverse = (flags & F_REVERSE$1) !== 0;
        let fg = this.packed(this.grid[i + 3] ?? 0, false);
        let bg = this.packed(this.grid[i + 4] ?? 0, true);
        if (reverse) {
          const tmp = fg;
          fg = { ...bg, a: 1 };
          bg = { ...tmp, a: this.theme.bg.a };
        }
        if ((flags & F_DIM$1) !== 0) fg = { ...fg, r: fg.r * 0.62, g: fg.g * 0.62, b: fg.b * 0.62 };
        const selected = sel !== null && x >= sel.x1 && x <= sel.x2;
        if (selected) {
          bg = this.theme.selectionBg;
          fg = this.theme.selectionFg;
        }
        const hit = this.search.findIndex((s) => s.line === abs && x >= s.x1 && x <= s.x2);
        if (hit >= 0 && !selected) {
          bg = parseHex(hit === this.searchActive ? "#f5c451" : "#f5c451", hit === this.searchActive ? 0.85 : 0.38);
          fg = parseHex("#101318");
        }
        const hi = this.highlights.find((s) => s.line === abs && x >= s.x1 && x <= s.x2);
        if (hi) fg = hi.color;
        const px = x * cw;
        const py = y * ch;
        if (bg.a > 0 && (selected || hit >= 0 || reverse || (this.grid[i + 4] ?? 0) !== 0)) {
          ctx.fillStyle = css(bg);
          ctx.fillRect(px, py, cw, ch);
        }
        if (cp === 0 || (flags & F_WIDE_TRAIL$1) !== 0) continue;
        const wide = (flags & F_WIDE$1) !== 0;
        let text = String.fromCodePoint(cp);
        if (this.grid[i + 1]) text += String.fromCodePoint(this.grid[i + 1] ?? 0);
        if (this.grid[i + 2]) text += String.fromCodePoint(this.grid[i + 2] ?? 0);
        if ((flags & F_BLINK$1) !== 0 && this.blinkOff) continue;
        ctx.fillStyle = css(fg);
        ctx.fillText(text, px, py + this.atlas.baseline);
        const underline = (flags & F_UNDERLINE_MASK$1) >> F_UNDERLINE_SHIFT$1;
        if (underline > 0 || (flags & F_STRIKE$1) !== 0) {
          ctx.strokeStyle = css(this.theme.underline ?? fg);
          ctx.lineWidth = Math.max(1, Math.round(this.dpr));
          const width = wide ? cw * 2 : cw;
          if ((flags & F_STRIKE$1) !== 0) {
            ctx.beginPath();
            ctx.moveTo(px, py + ch * 0.52);
            ctx.lineTo(px + width, py + ch * 0.52);
            ctx.stroke();
          }
          if (underline > 0) {
            const ys = underline === 2 ? [0.8, 0.93] : [0.88];
            for (const ratio of ys) {
              ctx.beginPath();
              if (underline === 3) {
                for (let k = 0; k <= width; k += 2) {
                  const yy = py + ch * 0.86 + Math.sin(k / cw * Math.PI * 4) * ch * 0.035;
                  if (k === 0) ctx.moveTo(px + k, yy);
                  else ctx.lineTo(px + k, yy);
                }
              } else {
                ctx.moveTo(px, py + ch * ratio);
                ctx.lineTo(px + width, py + ch * ratio);
              }
              ctx.stroke();
            }
          }
        }
      }
    }
    this.drawCursor(meta);
  }
  drawCursor(meta) {
    if (!meta.cursor.visible || meta.cursor.shape === "none") return;
    const ctx = this.ctx;
    const cw = this.atlas.cellW;
    const ch = this.atlas.cellH;
    const x = meta.cursor.x * cw;
    const y = meta.cursor.y * ch;
    const c = this.theme.cursor;
    ctx.fillStyle = css({ ...c, a: this.blinkOff ? c.a * 0.35 : c.a });
    switch (meta.cursor.shape) {
      case "beam":
        ctx.fillRect(x, y, Math.max(1, cw * 0.14), ch);
        break;
      case "underline":
        ctx.fillRect(x, y + ch * 0.88, cw, Math.max(1, ch * 0.12));
        break;
      case "hollow":
        ctx.strokeStyle = css(c);
        ctx.lineWidth = Math.max(1, this.dpr);
        ctx.strokeRect(x + 0.5, y + 0.5, cw - 1, ch - 1);
        break;
      default:
        ctx.fillRect(x, y, cw, ch);
    }
    void this.opts;
  }
  dispose() {
    this.meta = null;
  }
}
let workerRef = null;
let readyRef = null;
let nextId = 1;
const pending = /* @__PURE__ */ new Map();
const sessions = /* @__PURE__ */ new Map();
const handlers = /* @__PURE__ */ new Map();
function decodeBase64(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out.buffer;
}
function ensureWorker() {
  if (workerRef) return workerRef;
  const worker = new Worker(new URL(
    /* @vite-ignore */
    "" + new URL("worker-CW3ykH9Y.js", import.meta.url).href,
    import.meta.url
  ), {
    type: "module",
    name: "kitty-vt"
  });
  worker.onmessage = (ev) => {
    const msg = ev.data;
    switch (msg.t) {
      case "ready":
        return;
      case "reply": {
        const p = pending.get(msg.id);
        if (!p) return;
        pending.delete(msg.id);
        if (msg.ok) p.resolve(msg.value);
        else p.reject(new Error(msg.error));
        return;
      }
      case "frame": {
        handlers.get(msg.sessionId)?.onFrame({ meta: msg.meta, rows: msg.rows, full: msg.full });
        return;
      }
      case "state": {
        handlers.get(msg.sessionId)?.onFrame({ meta: msg.meta, rows: [], full: false });
        return;
      }
      case "event": {
        handlers.get(msg.sessionId)?.onEvent(msg.event);
        return;
      }
      case "write": {
        sessions.get(msg.sessionId)?.emitWrite(msg.data);
        return;
      }
      case "fatal": {
        for (const p of pending.values()) p.reject(new Error(msg.error));
        pending.clear();
        for (const h of handlers.values()) h.onFatal?.(msg.error);
        workerRef = null;
        readyRef = null;
        return;
      }
      default:
        return;
    }
  };
  worker.onerror = (ev) => {
    const message = ev.message || "kitty 内核线程异常退出";
    for (const p of pending.values()) p.reject(new Error(message));
    pending.clear();
    for (const h of handlers.values()) h.onFatal?.(message);
    workerRef = null;
    readyRef = null;
  };
  workerRef = worker;
  return worker;
}
function request(msg, transfer = []) {
  const worker = ensureWorker();
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker.postMessage({ ...msg, id }, transfer);
  });
}
async function ensureKittyCore() {
  if (readyRef) return readyRef;
  readyRef = (async () => {
    ensureWorker();
    const asset = await invoke(
      "app",
      "kittyWasm",
      {}
    );
    const buffer = decodeBase64(asset.base64);
    await request({ t: "init", wasm: buffer }, [buffer]);
  })();
  try {
    await readyRef;
  } catch (err) {
    readyRef = null;
    throw err;
  }
}
class KittySession {
  constructor(sessionId, h) {
    this.onWrite = null;
    this.sessionId = sessionId;
    handlers.set(sessionId, h);
  }
  static async open(sessionId, opts) {
    await ensureKittyCore();
    const session = new KittySession(sessionId, opts.handlers);
    sessions.set(sessionId, session);
    await request({
      t: "create",
      sessionId,
      cols: opts.cols,
      rows: opts.rows,
      scrollback: opts.scrollback
    });
    return session;
  }
  emitWrite(data) {
    this.onWrite?.(data);
  }
  /** 把远端输出喂进内核（零拷贝：chunk 的 buffer 直接转移） */
  write(chunk) {
    const buf = chunk instanceof Uint8Array ? chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength) : chunk;
    void request({ t: "data", sessionId: this.sessionId, chunk: buf }, [buf]).catch(() => void 0);
  }
  resize(cols, rows) {
    return request({ t: "resize", sessionId: this.sessionId, cols, rows });
  }
  key(key, mods, action = "press") {
    void request({ t: "key", sessionId: this.sessionId, key, mods, action }).catch(() => void 0);
  }
  paste(text) {
    void request({ t: "paste", sessionId: this.sessionId, text }).catch(() => void 0);
  }
  mouse(spec) {
    void request({ t: "mouse", sessionId: this.sessionId, ...spec }).catch(() => void 0);
  }
  focus(focused) {
    void request({ t: "focus", sessionId: this.sessionId, focused }).catch(() => void 0);
  }
  scroll(action) {
    void request({ t: "scroll", sessionId: this.sessionId, action }).catch(() => void 0);
  }
  selection(kind, x, y, opts) {
    return request({
      t: "selection",
      sessionId: this.sessionId,
      kind,
      x,
      y,
      rectangle: opts?.rectangle,
      ended: opts?.ended
    });
  }
  search(pattern, step = "first") {
    return request({ t: "search", sessionId: this.sessionId, pattern, step });
  }
  selectAll() {
    return request({ t: "selectAll", sessionId: this.sessionId });
  }
  serialize() {
    return request({ t: "serialize", sessionId: this.sessionId });
  }
  refresh() {
    void request({ t: "refresh", sessionId: this.sessionId }).catch(() => void 0);
  }
  stats() {
    return request({ t: "stats", sessionId: this.sessionId });
  }
  dispose() {
    sessions.delete(this.sessionId);
    handlers.delete(this.sessionId);
    void request({ t: "dispose", sessionId: this.sessionId }).catch(() => void 0);
  }
}
const FLOATS = 14;
const STRIDE = FLOATS * 4;
const F_BOLD = 1;
const F_DIM = 2;
const F_ITALIC = 4;
const F_REVERSE = 8;
const F_STRIKE = 16;
const F_BLINK = 32;
const F_WIDE = 64;
const F_WIDE_TRAIL = 128;
const F_UNDERLINE_MASK = 7 << 8;
const F_UNDERLINE_SHIFT = 8;
const VERT = `#version 300 es
precision highp float;
layout(location=0) in vec2 a_cell;
layout(location=1) in vec4 a_uv;
layout(location=2) in vec4 a_color;
layout(location=3) in vec4 a_flags;

uniform vec2 u_res;
uniform vec2 u_cell;
uniform float u_pass;   // 0 = 背景/实心, 1 = 字形, 2 = 装饰线

out vec2 v_uv;
out vec4 v_color;
out vec4 v_flags;
out vec2 v_local;

const vec2 QUAD[6] = vec2[6](
  vec2(0.0, 0.0), vec2(1.0, 0.0), vec2(0.0, 1.0),
  vec2(0.0, 1.0), vec2(1.0, 0.0), vec2(1.0, 1.0)
);

void main() {
  vec2 corner = QUAD[gl_VertexID];
  // pass 0（背景/光标）用 flags.xy 当尺寸倍数：背景是 1×1，光标可以是细条
  vec2 size = u_pass < 0.5 ? a_flags.xy : vec2(1.0);
  vec2 px = (a_cell + corner * size) * u_cell;
  vec2 clip = vec2(px.x / u_res.x * 2.0 - 1.0, 1.0 - px.y / u_res.y * 2.0);
  gl_Position = vec4(clip, 0.0, 1.0);
  v_uv = vec2(mix(a_uv.x, a_uv.z, corner.x), mix(a_uv.y, a_uv.w, corner.y));
  v_color = a_color;
  v_flags = a_flags;
  v_local = corner;
}`;
const FRAG = `#version 300 es
precision highp float;
in vec2 v_uv;
in vec4 v_color;
in vec4 v_flags;
in vec2 v_local;

uniform sampler2D u_atlas;
uniform float u_pass;
uniform float u_blinkOff;

out vec4 outColor;

void main() {
  if (u_pass < 0.5) {
    // 背景/光标/图片：纯色，alpha 由 CPU 侧算好
    outColor = v_color;
    return;
  }
  if (u_pass < 1.5) {
    if (u_blinkOff > 0.5 && v_flags.y > 0.5) discard;
    vec4 tex = texture(u_atlas, v_uv);
    if (tex.a < 0.02) discard;
    vec3 rgb = mix(v_color.rgb, tex.rgb, step(0.5, v_flags.x));
    outColor = vec4(rgb, tex.a * v_color.a);
    return;
  }
  // 装饰线：u_flags.z 是样式（1 直/2 双/3 波浪/4 点/5 虚/9 删除线）
  float style = v_flags.z;
  float y = v_local.y;
  bool on = false;
  float thickness = v_flags.w;
  if (style > 8.5) {
    on = abs(y - 0.52) < thickness;
  } else if (style > 4.5) {
    // 虚线
    on = y > 0.86 - thickness && y < 0.86 + thickness && fract(v_local.x * 2.0) < 0.62;
  } else if (style > 3.5) {
    // 点线
    on = y > 0.86 - thickness && y < 0.86 + thickness && fract(v_local.x * 2.0) < 0.34;
  } else if (style > 2.5) {
    // 波浪
    float wave = 0.86 + sin(v_local.x * 12.566) * 0.035;
    on = abs(y - wave) < thickness;
  } else if (style > 1.5) {
    // 双下划线
    on = (abs(y - 0.80) < thickness) || (abs(y - 0.93) < thickness);
  } else {
    on = abs(y - 0.88) < thickness;
  }
  if (!on) discard;
  outColor = v_color;
}`;
class WebGLTerminalRenderer {
  constructor(canvas, atlas, theme, opts, dpr) {
    this.atlasTex = null;
    this.cols = 80;
    this.rows = 24;
    this.meta = null;
    this.grid = new Uint32Array(0);
    this.rowValid = new Uint8Array(0);
    this.instances = new Float32Array(0);
    this.dirty = /* @__PURE__ */ new Set();
    this.highlights = [];
    this.search = [];
    this.searchActive = -1;
    this.cursorInstances = new Float32Array(FLOATS * 4);
    this.blinkOff = false;
    this.disposed = false;
    this.cursorCount = 0;
    this.canvas = canvas;
    this.atlas = atlas;
    this.theme = theme;
    this.opts = opts;
    this.dpr = dpr;
    const gl = canvas.getContext("webgl2", {
      alpha: true,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
      powerPreference: "high-performance"
    });
    if (!gl) throw new Error("WebGL2 不可用");
    this.gl = gl;
    this.program = this.link();
    const vao = gl.createVertexArray();
    const buffer = gl.createBuffer();
    const cursorBuffer = gl.createBuffer();
    const cursorVao = gl.createVertexArray();
    if (!vao || !buffer || !cursorBuffer || !cursorVao) throw new Error("WebGL 资源分配失败");
    this.vao = vao;
    this.buffer = buffer;
    this.cursorBuffer = cursorBuffer;
    this.cursorVao = cursorVao;
    this.setupVao(this.vao, this.buffer);
    this.setupVao(this.cursorVao, this.cursorBuffer);
    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  }
  link() {
    const gl = this.gl;
    const compile = (type, src) => {
      const sh = gl.createShader(type);
      if (!sh) throw new Error("createShader 失败");
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        const log = gl.getShaderInfoLog(sh) ?? "";
        throw new Error(`着色器编译失败：${log}`);
      }
      return sh;
    };
    const prog = gl.createProgram();
    if (!prog) throw new Error("createProgram 失败");
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error(`着色器链接失败：${gl.getProgramInfoLog(prog) ?? ""}`);
    }
    return prog;
  }
  setupVao(vao, buffer) {
    const gl = this.gl;
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    const loc = (name) => gl.getAttribLocation(this.program, name);
    gl.enableVertexAttribArray(loc("a_cell"));
    gl.vertexAttribPointer(loc("a_cell"), 2, gl.FLOAT, false, STRIDE, 0);
    gl.vertexAttribDivisor(loc("a_cell"), 1);
    gl.enableVertexAttribArray(loc("a_uv"));
    gl.vertexAttribPointer(loc("a_uv"), 4, gl.FLOAT, false, STRIDE, 2 * 4);
    gl.vertexAttribDivisor(loc("a_uv"), 1);
    gl.enableVertexAttribArray(loc("a_color"));
    gl.vertexAttribPointer(loc("a_color"), 4, gl.FLOAT, false, STRIDE, 6 * 4);
    gl.vertexAttribDivisor(loc("a_color"), 1);
    gl.enableVertexAttribArray(loc("a_flags"));
    gl.vertexAttribPointer(loc("a_flags"), 4, gl.FLOAT, false, STRIDE, 10 * 4);
    gl.vertexAttribDivisor(loc("a_flags"), 1);
    gl.bindVertexArray(null);
  }
  setTheme(theme) {
    this.theme = theme;
    for (let y = 0; y < this.rows; y += 1) this.dirty.add(y);
  }
  setOptions(opts) {
    this.opts = opts;
    for (let y = 0; y < this.rows; y += 1) this.dirty.add(y);
  }
  setHighlights(spans) {
    this.highlights = spans;
    for (let y = 0; y < this.rows; y += 1) this.dirty.add(y);
  }
  setSearch(spans, active) {
    this.search = spans;
    this.searchActive = active;
    for (let y = 0; y < this.rows; y += 1) this.dirty.add(y);
  }
  setBlinkOff(off) {
    if (this.blinkOff === off) return false;
    this.blinkOff = off;
    return true;
  }
  /** 画布尺寸（CSS 像素）；返回是否需要重排 */
  resize(cssWidth, cssHeight, cols, rows, dpr) {
    const w = Math.max(1, Math.round(cssWidth * dpr));
    const h = Math.max(1, Math.round(cssHeight * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.dpr = dpr;
    this.setGrid(cols, rows);
  }
  /** 只重排网格（不改画布像素尺寸） */
  setGrid(cols, rows) {
    if (cols === this.cols && rows === this.rows) return;
    this.cols = cols;
    this.rows = rows;
    this.grid = new Uint32Array(cols * rows * KITTY_CELL_WORDS);
    this.rowValid = new Uint8Array(rows);
    this.instances = new Float32Array(cols * rows * FLOATS * 3);
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.instances.byteLength, gl.DYNAMIC_DRAW);
    for (let y = 0; y < rows; y += 1) this.dirty.add(y);
  }
  applyFrame(meta, rows, full) {
    this.setGrid(meta.cols, meta.rows);
    this.meta = meta;
    if (full) for (let y = 0; y < this.rows; y += 1) this.dirty.add(y);
    for (const row of rows) {
      if (row.y < 0 || row.y >= this.rows) continue;
      const dst = new Uint32Array(this.grid.buffer, row.y * this.cols * KITTY_CELL_WORDS * 4, this.cols * KITTY_CELL_WORDS);
      const src = new Uint32Array(row.words);
      dst.set(src.subarray(0, Math.min(src.length, dst.length)));
      this.rowValid[row.y] = 1;
      this.dirty.add(row.y);
    }
    for (let y = 0; y < this.rows; y += 1) {
      if (!this.rowValid[y]) {
        this.dirty.add(y);
        this.rowValid[y] = 1;
      }
    }
  }
  /** 供主线程合成光标闪烁时判断是否有可见内容 */
  get hasFrame() {
    return this.meta !== null;
  }
  /* ─────────────────────────── 构建实例 ─────────────────────────── */
  rgba(color, alphaScale = 1) {
    return [color.r, color.g, color.b, color.a * alphaScale];
  }
  packed(word, background) {
    const kind = word >>> 24;
    if (kind === 1) return this.theme.palette[word & 255] ?? this.theme.fg;
    if (kind === 2) {
      const rgb = word & 16777215;
      return { r: (rgb >> 16 & 255) / 255, g: (rgb >> 8 & 255) / 255, b: (rgb & 255) / 255, a: 1 };
    }
    return background ? this.theme.bg : this.theme.fg;
  }
  selectionAt(y) {
    const spans = this.meta?.selection;
    if (!spans) return null;
    for (const s of spans) if (s.y === y) return s;
    return null;
  }
  highlightAt(abs, x) {
    for (const span of this.highlights) {
      if (span.line === abs && x >= span.x1 && x <= span.x2) return span.color;
    }
    return null;
  }
  searchHitAt(abs, x) {
    let found = 0;
    for (let i = 0; i < this.search.length; i += 1) {
      const span = this.search[i];
      if (!span || span.line !== abs || x < span.x1 || x > span.x2) continue;
      found = i === this.searchActive ? 2 : Math.max(found, 1);
    }
    return found;
  }
  buildRow(y) {
    const cols = this.cols;
    const rows = this.rows;
    const grid = this.grid;
    const inst = this.instances;
    const N = cols * rows;
    const rowBase = y * cols;
    const bgBase = rowBase * FLOATS;
    const glyphBase = (N + rowBase) * FLOATS;
    const decoBase = (2 * N + rowBase) * FLOATS;
    const atlas = this.atlas;
    const abs = (this.meta?.scrollbackLength ?? 0) - (this.meta?.scrolledBy ?? 0) + y;
    const sel = this.selectionAt(y);
    const zebra = this.opts.zebra && y % 2 === 1;
    const blinkOff = this.blinkOff ? 1 : 0;
    let glyphSkipUntil = -1;
    for (let x = 0; x < cols; x += 1) {
      const i = (rowBase + x) * KITTY_CELL_WORDS;
      const ch = grid[i] ?? 0;
      const cc1 = grid[i + 1] ?? 0;
      const cc2 = grid[i + 2] ?? 0;
      const flags = grid[i + 6] ?? 0;
      const bold = (flags & F_BOLD) !== 0;
      const dim = (flags & F_DIM) !== 0;
      const italic = (flags & F_ITALIC) !== 0;
      const reverse = (flags & F_REVERSE) !== 0;
      const strike = (flags & F_STRIKE) !== 0;
      const blink = (flags & F_BLINK) !== 0;
      const wideTrail = (flags & F_WIDE_TRAIL) !== 0;
      const wide = (flags & F_WIDE) !== 0;
      let underline = (flags & F_UNDERLINE_MASK) >> F_UNDERLINE_SHIFT;
      let fg = this.packed(grid[i + 3] ?? 0, false);
      let bg = this.packed(grid[i + 4] ?? 0, true);
      if (reverse) {
        const tmp = fg;
        fg = { ...bg, a: 1 };
        bg = { ...tmp, a: this.theme.bg.a };
      }
      if (dim) fg = { ...fg, r: fg.r * 0.62, g: fg.g * 0.62, b: fg.b * 0.62 };
      if (zebra && !reverse) bg = { ...bg, r: bg.r + 0.03, g: bg.g + 0.03, b: bg.b + 0.05 };
      const selected = sel !== null && x >= sel.x1 && x <= sel.x2;
      if (selected) {
        bg = this.theme.selectionBg;
        fg = this.theme.selectionFg;
      }
      const hit = this.searchHitAt(abs, x);
      if (hit > 0 && !selected) {
        bg = hit === 2 ? parseHex("#f5c451", 0.85) : parseHex("#f5c451", 0.38);
        fg = parseHex("#101318", 1);
      }
      const hi = this.highlightAt(abs, x);
      if (hi) fg = hi;
      const cc = this.rgba(bg);
      const ob = bgBase + x * FLOATS;
      inst[ob] = x;
      inst[ob + 1] = y;
      inst[ob + 2] = 0;
      inst[ob + 3] = 0;
      inst[ob + 4] = 0;
      inst[ob + 5] = 0;
      inst[ob + 6] = cc[0];
      inst[ob + 7] = cc[1];
      inst[ob + 8] = cc[2];
      inst[ob + 9] = cc[3];
      inst[ob + 10] = 1;
      inst[ob + 11] = 1;
      inst[ob + 12] = 0;
      inst[ob + 13] = 0;
      const og = glyphBase + x * FLOATS;
      const empty = !ch || wideTrail || x <= glyphSkipUntil;
      if (empty) {
        this.zero(inst, og);
      } else {
        let text = String.fromCodePoint(ch);
        if (cc1) text += String.fromCodePoint(cc1);
        if (cc2) text += String.fromCodePoint(cc2);
        let span = wide ? 2 : 1;
        if (this.opts.ligatures && !wide && ch < 127 && x + 1 < cols) {
          const run = this.ligatureRun(y, x);
          if (run && run.span > 1) {
            text = run.text;
            span = run.span;
          }
        }
        const entry = atlas.entry(text, { bold, italic }, span);
        const fc = this.rgba(fg);
        inst[og] = x;
        inst[og + 1] = y;
        inst[og + 2] = entry.u0;
        inst[og + 3] = entry.v0;
        inst[og + 4] = entry.u1;
        inst[og + 5] = entry.v1;
        inst[og + 6] = fc[0];
        inst[og + 7] = fc[1];
        inst[og + 8] = fc[2];
        inst[og + 9] = fc[3];
        inst[og + 10] = entry.colored ? 1 : 0;
        inst[og + 11] = blink && blinkOff ? 1 : 0;
        inst[og + 12] = 0;
        inst[og + 13] = 0;
        if (span > 1) glyphSkipUntil = x + span - 1;
      }
      const od = decoBase + x * FLOATS;
      const decoColor = this.theme.underline ?? fg;
      if (underline > 0 || strike) {
        const dc = this.rgba(decoColor);
        inst[od] = x;
        inst[od + 1] = y;
        inst[od + 6] = dc[0];
        inst[od + 7] = dc[1];
        inst[od + 8] = dc[2];
        inst[od + 9] = dc[3];
        inst[od + 10] = 0;
        inst[od + 11] = 0;
        inst[od + 12] = strike && underline === 0 ? 9 : underline;
        inst[od + 13] = 0.055;
      } else {
        this.zero(inst, od);
      }
    }
  }
  /** 用零尺寸实例占位（不画任何东西） */
  zero(inst, offset) {
    for (let k = 0; k < FLOATS; k += 1) inst[offset + k] = 0;
  }
  /** 连字游程：返回整段文本与覆盖列数 */
  ligatureRun(y, x) {
    const cols = this.cols;
    const base = (y * cols + x) * KITTY_CELL_WORDS;
    const flags0 = this.grid[base + 6] ?? 0;
    let text = "";
    let span = 0;
    for (let k = 0; x + k < cols; k += 1) {
      const i = (y * cols + x + k) * KITTY_CELL_WORDS;
      const ch = this.grid[i] ?? 0;
      const flags = this.grid[i + 6] ?? 0;
      if (ch === 0 || ch >= 127 || (flags & (F_WIDE | F_WIDE_TRAIL)) !== 0) break;
      if ((flags & (F_BOLD | F_ITALIC)) !== (flags0 & (F_BOLD | F_ITALIC))) break;
      if ((this.grid[i + 3] ?? 0) !== (this.grid[base + 3] ?? 0)) break;
      text += String.fromCodePoint(ch);
      span += 1;
      if (span >= 6) break;
    }
    if (span < 2) return null;
    if (!this.atlas.hasLigature(text, span)) return null;
    return { text, span };
  }
  /* ───────────────────────────── 绘制 ───────────────────────────── */
  render() {
    if (this.disposed) return;
    const gl = this.gl;
    const N = this.cols * this.rows;
    if (N === 0) return;
    if (!this.atlasTex) {
      const tex = gl.createTexture();
      if (!tex) return;
      this.atlasTex = tex;
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    }
    this.atlas.upload(gl, this.atlasTex);
    if (this.dirty.size > 0) {
      for (const y of this.dirty) this.buildRow(y);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
      const rowFloats = this.cols * FLOATS;
      for (const y of this.dirty) {
        const byteOffset = y * this.cols * FLOATS * 4;
        const secondOffset = (N + y * this.cols) * FLOATS * 4;
        const thirdOffset = (2 * N + y * this.cols) * FLOATS * 4;
        gl.bufferSubData(gl.ARRAY_BUFFER, byteOffset, this.instances, y * this.cols * FLOATS, rowFloats);
        gl.bufferSubData(gl.ARRAY_BUFFER, secondOffset, this.instances, (N + y * this.cols) * FLOATS, rowFloats);
        gl.bufferSubData(gl.ARRAY_BUFFER, thirdOffset, this.instances, (2 * N + y * this.cols) * FLOATS, rowFloats);
      }
      this.dirty.clear();
    }
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(this.theme.bg.r, this.theme.bg.g, this.theme.bg.b, this.theme.bg.a);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.program);
    gl.uniform2f(gl.getUniformLocation(this.program, "u_res"), this.canvas.width, this.canvas.height);
    gl.uniform2f(gl.getUniformLocation(this.program, "u_cell"), this.atlas.cellW, this.atlas.cellH);
    gl.uniform1f(gl.getUniformLocation(this.program, "u_blinkOff"), this.blinkOff ? 1 : 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.atlasTex);
    gl.uniform1i(gl.getUniformLocation(this.program, "u_atlas"), 0);
    const passLoc = gl.getUniformLocation(this.program, "u_pass");
    const drawPass = (pass) => {
      gl.bindVertexArray(this.vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, STRIDE, pass * N * STRIDE);
      gl.vertexAttribPointer(1, 4, gl.FLOAT, false, STRIDE, pass * N * STRIDE + 2 * 4);
      gl.vertexAttribPointer(2, 4, gl.FLOAT, false, STRIDE, pass * N * STRIDE + 6 * 4);
      gl.vertexAttribPointer(3, 4, gl.FLOAT, false, STRIDE, pass * N * STRIDE + 10 * 4);
      gl.uniform1f(passLoc, pass);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, N);
    };
    drawPass(0);
    drawPass(1);
    drawPass(2);
    this.drawCursor();
    gl.bindVertexArray(null);
  }
  drawCursor() {
    const meta = this.meta;
    if (!meta || !meta.cursor.visible || meta.cursor.shape === "none") return;
    if (meta.modes.altScreen && !meta.cursor.visible) return;
    const gl = this.gl;
    const { x, y, shape } = meta.cursor;
    const color = this.theme.cursor;
    const build = (ox, oy, w, h, c2) => {
      const base = this.cursorCount * FLOATS;
      const inst = this.cursorInstances;
      inst[base] = x + ox;
      inst[base + 1] = y + oy;
      inst[base + 2] = 0;
      inst[base + 3] = 0;
      inst[base + 4] = 0;
      inst[base + 5] = 0;
      inst[base + 6] = c2.r;
      inst[base + 7] = c2.g;
      inst[base + 8] = c2.b;
      inst[base + 9] = c2.a;
      inst[base + 10] = w;
      inst[base + 11] = h;
      inst[base + 12] = 0;
      inst[base + 13] = 0;
      this.cursorCount += 1;
    };
    this.cursorCount = 0;
    const c = { ...color, a: this.blinkOff ? color.a * 0.35 : color.a };
    if (shape === "block") build(0, 0, 1, 1, c);
    else if (shape === "beam") build(0, 0, 0.14, 1, c);
    else if (shape === "underline") build(0, 0.88, 1, 0.12, c);
    else if (shape === "hollow") {
      const t = 0.08;
      build(0, 0, 1, t, c);
      build(0, 1 - t, 1, t, c);
      build(0, 0, t, 1, c);
      build(1 - t, 0, t, 1, c);
    }
    if (this.cursorCount === 0) return;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.cursorBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.cursorInstances.subarray(0, this.cursorCount * FLOATS), gl.DYNAMIC_DRAW);
    gl.bindVertexArray(this.cursorVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.cursorBuffer);
    gl.uniform1f(gl.getUniformLocation(this.program, "u_pass"), 0);
    for (let i = 0; i < this.cursorCount; i += 1) {
      const off = i * STRIDE;
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, STRIDE, off);
      gl.vertexAttribPointer(1, 4, gl.FLOAT, false, STRIDE, off + 2 * 4);
      gl.vertexAttribPointer(2, 4, gl.FLOAT, false, STRIDE, off + 6 * 4);
      gl.vertexAttribPointer(3, 4, gl.FLOAT, false, STRIDE, off + 10 * 4);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, 1);
    }
    gl.bindVertexArray(null);
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    const gl = this.gl;
    gl.deleteProgram(this.program);
    gl.deleteBuffer(this.buffer);
    gl.deleteBuffer(this.cursorBuffer);
    gl.deleteVertexArray(this.vao);
    gl.deleteVertexArray(this.cursorVao);
    if (this.atlasTex) gl.deleteTexture(this.atlasTex);
  }
}
class DecorationImpl {
  constructor(absLine, x, width, color) {
    this.disposed = false;
    this.onRenderCb = null;
    this.onDisposeCb = null;
    this.absLine = absLine;
    this.x = x;
    this.width = width;
    this.color = color;
  }
  onRender(cb) {
    this.onRenderCb = cb;
  }
  onDispose(cb) {
    this.onDisposeCb = cb;
  }
  dispose() {
    this.disposed = true;
    this.onDisposeCb?.();
  }
}
const SPECIAL_KEYS = {
  Enter: "Enter",
  Tab: "Tab",
  Backspace: "Backspace",
  Escape: "Escape",
  ArrowUp: "ArrowUp",
  ArrowDown: "ArrowDown",
  ArrowLeft: "ArrowLeft",
  ArrowRight: "ArrowRight",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown",
  Insert: "Insert",
  Delete: "Delete",
  F1: "F1",
  F2: "F2",
  F3: "F3",
  F4: "F4",
  F5: "F5",
  F6: "F6",
  F7: "F7",
  F8: "F8",
  F9: "F9",
  F10: "F10",
  F11: "F11",
  F12: "F12"
};
class KittyEngine {
  constructor(opts) {
    this.cols = 80;
    this.rows = 24;
    this.session = null;
    this.meta = null;
    this.grid = new Uint32Array(0);
    this.rowValid = new Uint8Array(0);
    this.rowsText = [];
    this.disposed = false;
    this.ready = false;
    this.raf = 0;
    this.blinkTimer = 0;
    this.blinkOff = false;
    this.selectionText = "";
    this.markers = [];
    this.decorations = [];
    this.searchSpans = [];
    this.searchActive = -1;
    this.searchPattern = "";
    this.oscHandlers = /* @__PURE__ */ new Map();
    this.dataListeners = /* @__PURE__ */ new Set();
    this.resizeListeners = /* @__PURE__ */ new Set();
    this.bellListeners = /* @__PURE__ */ new Set();
    this.selectionListeners = /* @__PURE__ */ new Set();
    this.renderListeners = /* @__PURE__ */ new Set();
    this.dragging = false;
    this.composing = false;
    this.visible = true;
    this.lastCwd = "";
    this.customThemeBase = null;
    this.onKeyDown = (e) => {
      if (this.disposed || !this.session) return;
      if (this.composing) return;
      if (e.ctrlKey && e.shiftKey) return;
      if (e.metaKey) return;
      if (e.key === "Process" || e.key === "Unidentified") return;
      if (e.key === "Shift" || e.key === "Control" || e.key === "Alt" || e.key === "Meta") return;
      const special = SPECIAL_KEYS[e.key];
      const mods = this.modsOf(e);
      if (special) {
        e.preventDefault();
        this.session.key(special, mods, e.repeat ? "repeat" : "press");
        this.scheduleRender();
        return;
      }
      if (e.key.length === 1) {
        e.preventDefault();
        this.session.key(e.key, mods, e.repeat ? "repeat" : "press");
        return;
      }
    };
    this.onMouseDown = (e) => {
      this.focus();
      if (e.button === 2) {
        if (this.options.rightClickPaste) {
          e.preventDefault();
          void navigator.clipboard.readText().then((text) => {
            if (text) this.session?.paste(text);
          }).catch(() => void 0);
        }
        return;
      }
      if (e.button !== 0) return;
      const { x, y } = this.cellAt(e.clientX, e.clientY);
      if (this.meta?.modes.mouseTracking) {
        this.session?.mouse({ x, y, button: "left", action: "press", mods: this.modsOf(e) });
        return;
      }
      this.dragging = true;
      void this.session?.selection("start", x, y, { rectangle: e.altKey });
      window.addEventListener("mousemove", this.onMouseMove);
      window.addEventListener("mouseup", this.onMouseUp, { once: true });
    };
    this.onMouseMove = (e) => {
      if (!this.dragging) return;
      const { x, y } = this.cellAt(e.clientX, e.clientY);
      if (this.meta?.modes.mouseTracking) {
        this.session?.mouse({ x, y, button: "none", action: "move", mods: this.modsOf(e) });
        return;
      }
      void this.session?.selection("update", x, y, {});
    };
    this.onMouseUp = (e) => {
      this.dragging = false;
      window.removeEventListener("mousemove", this.onMouseMove);
      if (this.meta?.modes.mouseTracking) {
        const { x, y } = this.cellAt(e.clientX, e.clientY);
        this.session?.mouse({ x, y, button: "left", action: "release", mods: this.modsOf(e) });
        return;
      }
      void this.session?.selection("update", this.cellAt(e.clientX, e.clientY).x, this.cellAt(e.clientX, e.clientY).y, {
        ended: true
      }).then((res) => {
        this.selectionText = res?.text ?? "";
        for (const cb of this.selectionListeners) cb();
        this.opts.onSelectionChange?.();
        if (this.options.copyOnSelect && this.selectionText) {
          void navigator.clipboard.writeText(this.selectionText).catch(() => void 0);
        }
      });
    };
    this.onWheel = (e) => {
      e.preventDefault();
      const mode = this.meta?.modes;
      if (mode?.mouseTracking && mode.altScreen) {
        const { x, y } = this.cellAt(e.clientX, e.clientY);
        const button = e.deltaY < 0 ? "wheel-up" : "wheel-down";
        this.session?.mouse({ x, y, button, action: "press", mods: this.modsOf(e) });
        return;
      }
      const lines = Math.max(1, Math.round(Math.abs(e.deltaY) / 40 * this.options.wheelMultiplier));
      this.session?.scroll(e.deltaY < 0 ? lines : -lines);
    };
    this.parser = {
      registerOscHandler: (code, cb) => {
        this.oscHandlers.set(code, cb);
        return { dispose: () => this.oscHandlers.delete(code) };
      }
    };
    this.searchShim = {
      findNext: (term, opts2) => {
        this.runSearch(term, opts2?.incremental && term === this.searchPattern ? "next" : "first");
        return this.searchSpans.length > 0;
      },
      findPrevious: (term) => {
        this.runSearch(term, "prev");
        return this.searchSpans.length > 0;
      },
      clearDecorations: () => {
        this.searchSpans = [];
        this.searchActive = -1;
        this.scheduleRender();
      }
    };
    this.opts = opts;
    this.options = opts.settings;
    this.element = opts.host;
    this.theme = buildTheme({ settings: opts.settings, resolved: opts.resolvedTheme });
    this.wrap = document.createElement("div");
    this.wrap.className = "kitty-surface";
    this.wrap.tabIndex = 0;
    this.wrap.style.position = "absolute";
    this.wrap.style.inset = "0";
    this.wrap.style.outline = "none";
    this.canvas = document.createElement("canvas");
    this.canvas.className = "kitty-canvas";
    this.canvas.style.position = "absolute";
    this.canvas.style.inset = "0";
    this.canvas.style.width = "100%";
    this.canvas.style.height = "100%";
    this.wrap.appendChild(this.canvas);
    this.screen = document.createElement("div");
    this.screen.className = "xterm-screen";
    this.screen.style.position = "absolute";
    this.screen.style.pointerEvents = "none";
    this.screen.style.inset = "0";
    this.wrap.appendChild(this.screen);
    this.ime = document.createElement("textarea");
    this.ime.className = "kitty-ime";
    this.ime.setAttribute("aria-label", "终端输入");
    this.ime.autocapitalize = "off";
    this.ime.autocomplete = "off";
    this.ime.spellcheck = false;
    this.ime.style.position = "absolute";
    this.ime.style.opacity = "0";
    this.ime.style.width = "1px";
    this.ime.style.height = "1px";
    this.ime.style.left = "0";
    this.ime.style.top = "0";
    this.ime.style.border = "none";
    this.ime.style.padding = "0";
    this.ime.style.resize = "none";
    this.wrap.appendChild(this.ime);
    this.element.appendChild(this.wrap);
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    this.atlas = new GlyphAtlas({
      fontFamily: opts.settings.fontFamily,
      fontSize: opts.settings.fontSize,
      fontWeight: opts.settings.fontWeight,
      boldWeight: opts.settings.boldWeight,
      fontFeatures: opts.settings.fontFeatures,
      ligatures: opts.settings.ligatures,
      dpr
    });
    this.renderer = this.createRenderer(dpr);
    this.bindDom();
  }
  createRenderer(dpr) {
    const renderOpts = { ligatures: this.options.ligatures, zebra: this.options.zebraStripes };
    try {
      return new WebGLTerminalRenderer(this.canvas, this.atlas, this.theme, renderOpts, dpr);
    } catch (err) {
      console.warn("[kitty] WebGL2 不可用，回退 canvas", err);
      return new CanvasTerminalRenderer(
        this.canvas,
        this.atlas,
        this.theme,
        renderOpts,
        dpr,
        this.options.fontFamily
      );
    }
  }
  /* ─────────────────────────── 启动 ─────────────────────────── */
  async open() {
    await ensureKittyCore();
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const { cols, rows } = this.measure();
    this.cols = cols;
    this.rows = rows;
    this.renderer.resize(this.cssWidth(), this.cssHeight(), cols, rows, dpr);
    this.session = await KittySession.open(this.opts.sessionId, {
      cols,
      rows,
      scrollback: this.options.scrollback,
      handlers: {
        onFrame: (frame) => {
          this.meta = frame.meta;
          this.applyRows(frame.rows, frame.full);
          this.refreshThemeBase(frame.meta);
          this.scheduleRender();
          if (frame.meta.title && this.opts.onTitle) this.opts.onTitle(frame.meta.title);
        },
        onEvent: (ev) => this.onHostEvent(ev),
        onFatal: (msg) => {
          this.opts.onFatal?.(msg);
        }
      }
    });
    this.session.onWrite = (data) => this.emitData(data);
    if (!this.options.wrapLines) this.session.write(new TextEncoder().encode("\x1B[?7l"));
    this.ready = true;
    this.startBlink();
    this.scheduleRender();
  }
  applyRows(rows, full) {
    if (this.grid.length !== this.cols * this.rows * KITTY_CELL_WORDS) {
      this.grid = new Uint32Array(this.cols * this.rows * KITTY_CELL_WORDS);
      this.rowValid = new Uint8Array(this.rows);
      this.rowsText = new Array(this.rows).fill("");
    }
    if (full) this.rowValid.fill(0);
    for (const row of rows) {
      if (row.y < 0 || row.y >= this.rows) continue;
      const src = new Uint32Array(row.words);
      const perRow = this.cols * KITTY_CELL_WORDS;
      const dst = new Uint32Array(this.grid.buffer, row.y * perRow * 4, perRow);
      dst.set(src.subarray(0, Math.min(src.length, perRow)));
      this.rowValid[row.y] = 1;
      this.rowsText[row.y] = this.rowToText(dst);
    }
    this.renderer.applyFrame(this.meta, rows, full);
  }
  rowToText(words) {
    let out = "";
    for (let x = 0; x < this.cols; x += 1) {
      const i = x * KITTY_CELL_WORDS;
      const flags = words[i + 6] ?? 0;
      if ((flags & 128) !== 0) continue;
      const cp = words[i] ?? 0;
      if (!cp) {
        out += " ";
        continue;
      }
      out += String.fromCodePoint(cp);
      if (words[i + 1]) out += String.fromCodePoint(words[i + 1] ?? 0);
      if (words[i + 2]) out += String.fromCodePoint(words[i + 2] ?? 0);
    }
    return out.replace(/\s+$/, "");
  }
  refreshThemeBase(meta) {
    const base = {
      fg: meta.defaultFg,
      bg: meta.defaultBg,
      cursor: meta.cursorColor,
      palette: meta.palette
    };
    this.customThemeBase = base;
    this.theme = buildTheme({
      settings: this.options,
      resolved: this.opts.resolvedTheme,
      core: base
    });
    this.renderer.setTheme(this.theme);
  }
  /* ─────────────────────────── 事件 ─────────────────────────── */
  onHostEvent(ev) {
    switch (ev.type) {
      case "bell":
        this.opts.onBell?.();
        for (const cb of this.bellListeners) cb();
        return;
      case "title":
        this.opts.onTitle?.(ev.title);
        return;
      case "cwd":
        this.lastCwd = ev.path;
        this.opts.onCwd?.(ev.path);
        this.notifyOsc(7, `file://localhost${ev.path}`);
        return;
      case "clipboard":
        if (!ev.query && ev.data) void navigator.clipboard.writeText(ev.data).catch(() => void 0);
        return;
      case "graphics":
        return;
      case "reset":
        this.decorations = [];
        this.markers = [];
        return;
      default:
        return;
    }
  }
  notifyOsc(code, data) {
    const handler = this.oscHandlers.get(code);
    if (handler) handler(data);
  }
  /* ─────────────────────────── 渲染 ─────────────────────────── */
  scheduleRender() {
    if (this.disposed || !this.visible) return;
    if (this.raf !== 0) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.renderNow();
    });
  }
  renderNow() {
    if (this.disposed) return;
    this.syncDecorations();
    this.renderer.render();
    for (const cb of this.renderListeners) cb();
    this.opts.onWriteParsed?.();
  }
  syncDecorations() {
    const meta = this.meta;
    if (!meta) return;
    const base = meta.scrollbackLength - meta.scrolledBy;
    const spans = [];
    for (const deco of this.decorations) {
      if (deco.disposed) continue;
      const y = deco.absLine - base;
      if (y < 0 || y >= this.rows) continue;
      spans.push({ line: deco.absLine, x1: deco.x, x2: deco.x + deco.width - 1, color: parseHex(deco.color) });
    }
    this.renderer.setHighlights(spans);
    this.renderer.setSearch(this.searchSpans, this.searchActive);
  }
  startBlink() {
    window.clearInterval(this.blinkTimer);
    this.blinkTimer = window.setInterval(() => {
      if (this.disposed) return;
      this.blinkOff = !this.blinkOff;
      if (this.renderer.setBlinkOff(this.blinkOff)) this.scheduleRender();
    }, 540);
  }
  /* ─────────────────────────── 尺寸 ─────────────────────────── */
  cssWidth() {
    return Math.max(1, this.element.clientWidth);
  }
  cssHeight() {
    return Math.max(1, this.element.clientHeight);
  }
  measure() {
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const pad = this.options.padding;
    const cw = this.atlas.cellW / dpr;
    const ch = this.atlas.cellH / dpr;
    const cols = Math.max(2, Math.floor((this.cssWidth() - pad * 2) / cw));
    const rows = Math.max(1, Math.floor((this.cssHeight() - pad * 2) / ch));
    return { cols, rows };
  }
  fit() {
    if (this.disposed) return;
    const pad = this.options.padding;
    const { cols, rows } = this.measure();
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const width = cols * (this.atlas.cellW / dpr);
    const height = rows * (this.atlas.cellH / dpr);
    this.canvas.style.left = `${pad}px`;
    this.canvas.style.top = `${pad}px`;
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
    this.screen.style.left = `${pad}px`;
    this.screen.style.top = `${pad}px`;
    this.screen.style.width = `${width}px`;
    this.screen.style.height = `${height}px`;
    this.renderer.resize(width, height, cols, rows, dpr);
    if (cols !== this.cols || rows !== this.rows) {
      this.cols = cols;
      this.rows = rows;
      this.grid = new Uint32Array(cols * rows * KITTY_CELL_WORDS);
      this.rowValid = new Uint8Array(rows);
      this.rowsText = new Array(rows).fill("");
      void this.session?.resize(cols, rows);
      this.opts.onResize?.(cols, rows);
      for (const cb of this.resizeListeners) cb({ cols, rows });
    }
    this.scheduleRender();
  }
  /* ─────────────────────────── 输入 ─────────────────────────── */
  bindDom() {
    const wrap = this.wrap;
    wrap.addEventListener("mousedown", this.onMouseDown);
    wrap.addEventListener("wheel", this.onWheel, { passive: false });
    this.ime.addEventListener("keydown", this.onKeyDown);
    this.ime.addEventListener("compositionstart", () => {
      this.composing = true;
    });
    this.ime.addEventListener("compositionend", (e) => {
      this.composing = false;
      if (e.data) void this.sendText(e.data);
      this.ime.value = "";
    });
    this.ime.addEventListener("input", () => {
      if (this.composing) return;
      const value = this.ime.value;
      if (value) void this.sendText(value);
      this.ime.value = "";
    });
    this.ime.addEventListener("paste", (e) => {
      const text = e.clipboardData?.getData("text/plain") ?? "";
      if (!text) return;
      e.preventDefault();
      this.session?.paste(text);
    });
    this.ime.addEventListener("focus", () => {
      this.session?.focus(true);
    });
    this.ime.addEventListener("blur", () => {
      this.session?.focus(false);
    });
  }
  modsOf(e) {
    return (e.shiftKey ? 1 : 0) | (e.altKey ? 2 : 0) | (e.ctrlKey ? 4 : 0) | (e.metaKey ? 8 : 0);
  }
  /** 文本输入（IME 提交、多字符粘贴等价路径） */
  async sendText(text) {
    if (!this.session) return;
    for (const ch of text) this.session.key(ch, 0, "press");
  }
  cellAt(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const cw = this.atlas.cellW / dpr;
    const ch = this.atlas.cellH / dpr;
    const x = Math.floor((clientX - rect.left) / cw);
    const y = Math.floor((clientY - rect.top) / ch);
    return {
      x: Math.max(0, Math.min(this.cols - 1, x)),
      y: Math.max(0, Math.min(this.rows - 1, y))
    };
  }
  /* ─────────────────────────── xterm 兼容面 ─────────────────────────── */
  focus() {
    this.ime.focus({ preventScroll: true });
  }
  /**
   * 写入输出。
   *
   * 第二个参数是 **xterm 的写入完成回调**：窗格的背压写入器依赖它串行化写入
   * （一次只允许一个未完成的 write）。我们这里把「已投递给 Worker」当作完成，
   * 用微任务回调即可 —— 背压的目标是不让队列无限膨胀，这一点已经达到。
   */
  write(data, cb) {
    if (!this.session) {
      cb?.();
      return;
    }
    this.session.write(new TextEncoder().encode(data));
    if (cb) queueMicrotask(cb);
  }
  paste(text) {
    this.session?.paste(text);
  }
  clear() {
    this.write("\x1B[H\x1B[2J");
  }
  scrollToBottom() {
    this.session?.scroll("bottom");
  }
  getSelection() {
    return this.selectionText;
  }
  refresh() {
    this.session?.refresh();
    this.scheduleRender();
  }
  /** 焦点/可见性：隐藏时停止渲染，保留内核状态（资源分级） */
  setVisible(visible) {
    this.visible = visible;
    if (visible) {
      this.fit();
      this.session?.refresh();
    }
  }
  onData(cb) {
    this.dataListeners.add(cb);
    return { dispose: () => this.dataListeners.delete(cb) };
  }
  emitData(data) {
    for (const cb of this.dataListeners) cb(data);
  }
  onResize(cb) {
    this.resizeListeners.add(cb);
    return { dispose: () => this.resizeListeners.delete(cb) };
  }
  onBell(cb) {
    this.bellListeners.add(cb);
    return { dispose: () => this.bellListeners.delete(cb) };
  }
  onSelectionChange(cb) {
    this.selectionListeners.add(cb);
    return { dispose: () => this.selectionListeners.delete(cb) };
  }
  onRender(cb) {
    this.renderListeners.add(cb);
    return { dispose: () => this.renderListeners.delete(cb) };
  }
  onWriteParsed(cb) {
    return this.onRender(cb);
  }
  /**
   * 注册书签。
   *
   * xterm 的 `registerMarker(offset)` 收的是**相对光标行的偏移**（负数向上），
   * 这里换算成绝对行号，后续窗口滚动/回看都不会让它漂移。
   */
  registerMarker(offset) {
    if (!this.meta) return void 0;
    const cursorAbs = this.meta.scrollbackLength - this.meta.scrolledBy + this.meta.cursor.y;
    const marker = {
      absLine: cursorAbs + offset,
      disposed: false,
      dispose: () => {
        marker.disposed = true;
        const i = this.markers.indexOf(marker);
        if (i >= 0) this.markers.splice(i, 1);
      }
    };
    this.markers.push(marker);
    return marker;
  }
  registerDecoration(opts) {
    if (!opts.foregroundColor) return void 0;
    const deco = new DecorationImpl(opts.marker.absLine, opts.x, Math.max(1, opts.width), opts.foregroundColor);
    this.decorations.push(deco);
    this.scheduleRender();
    return deco;
  }
  /** 供窗格读取光标位置（补全弹窗定位用）：形如 xterm 的 `term.buffer` */
  get buffer() {
    return { active: this.activeBuffer };
  }
  get activeBuffer() {
    const base = this.meta ? this.meta.scrollbackLength - this.meta.scrolledBy : 0;
    return {
      baseY: base,
      cursorX: this.meta?.cursor.x ?? 0,
      cursorY: this.meta?.cursor.y ?? 0,
      getLine: (absY) => {
        const y = absY - base;
        if (y < 0 || y >= this.rows) return null;
        const text = this.rowsText[y] ?? "";
        return { translateToString: (trimRight = true) => trimRight ? text.replace(/\s+$/, "") : text };
      }
    };
  }
  runSearch(term, step) {
    if (!this.session) return;
    if (step === "first") this.searchPattern = term;
    void this.session.search(term, step).then((res) => {
      res.scrolledBy;
      const meta = this.meta;
      if (!meta) return;
      const abs0 = meta.scrollbackLength - meta.scrolledBy;
      this.searchSpans = res.hits.map((h) => ({ line: abs0 + h.y, x1: h.x1, x2: h.x2 }));
      this.searchActive = res.index;
      this.scheduleRender();
    });
  }
  /** 换主题/字体（设置热更新） */
  applySettings(settings) {
    Object.assign(this.options, settings);
    if (settings.renderer === "xterm") return;
    const fontChanged = settings.fontFamily !== void 0 && (this.atlas.fontFamilyCss !== settings.fontFamily || this.atlas.fontSizeDpr !== Math.round(settings.fontSize * (window.devicePixelRatio || 1)) || this.atlas.fontWeight !== settings.fontWeight);
    if (fontChanged) {
      this.rebuildAtlas(settings);
      return;
    }
    this.theme = buildTheme({
      settings,
      resolved: this.opts.resolvedTheme,
      core: this.customThemeBase ?? void 0
    });
    this.renderer.setTheme(this.theme);
    this.renderer.setOptions({ ligatures: settings.ligatures, zebra: settings.zebraStripes });
    this.fit();
  }
  rebuildAtlas(settings) {
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const atlas = new GlyphAtlas({
      fontFamily: settings.fontFamily,
      fontSize: settings.fontSize,
      fontWeight: settings.fontWeight,
      boldWeight: settings.boldWeight,
      fontFeatures: settings.fontFeatures,
      ligatures: settings.ligatures,
      dpr
    });
    this.renderer.dispose();
    Object.assign(this, { atlas });
    this.renderer = this.createRenderer(dpr);
    this.fit();
  }
  get backendLabel() {
    return this.renderer instanceof WebGLTerminalRenderer ? "WebGL2" : "Canvas";
  }
  get kernelLabel() {
    return `kitty VT · ${this.cols}×${this.rows}`;
  }
  /** 供状态栏/诊断读取 */
  get stats() {
    const meta = this.meta;
    return {
      scrollback: meta?.scrollbackLength ?? 0,
      scrolledBy: meta?.scrolledBy ?? 0,
      mode: meta?.modes.altScreen ? "alt" : "main",
      cwd: this.lastCwd
    };
  }
  /** 当前视口文本（诊断/截图比对用） */
  viewportText() {
    return this.rowsText.join("\n");
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    window.clearInterval(this.blinkTimer);
    if (this.raf !== 0) cancelAnimationFrame(this.raf);
    window.removeEventListener("mousemove", this.onMouseMove);
    this.ime.removeEventListener("keydown", this.onKeyDown);
    this.session?.dispose();
    this.session = null;
    this.renderer.dispose();
    this.wrap.remove();
  }
}
export {
  KittyEngine
};
