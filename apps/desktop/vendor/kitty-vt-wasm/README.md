# kitty-vt-wasm

[kitty](https://github.com/kovidgoyal/kitty)'s **real terminal core** — the
actual `screen.c`, `vt-parser.c`, `line-buf.c`, `history.c`, Unicode tables and
key encoder, compiled unmodified to WebAssembly — wrapped as a typed
TypeScript library with all I/O abstracted, in the spirit of libghostty.

![styles demo](docs/styles.png)

That's kitty's own grid rendered from wasm state: real SGR handling, all five
kitty underline styles, 256-color/truecolor, graphemes, wide chars, hyperlinks.
Here is vim (with syntax highlighting) editing kitty's own `vt-parser.c`,
replayed byte-for-byte through the wasm terminal and rasterized with Menlo:

![vim demo](docs/vim.png)

## How it works

```
 app/child bytes ──▶ term.write(bytes) ──▶ vt-parser.c ──▶ screen.c grid
                                                │               │
       onOutput(bytes) ◀── DA/DSR/DECRQSS/OSC replies           │
       onEvent(ev)     ◀── window callbacks (title, bell,       │
                           clipboard, graphics, notifications)  │
       term.line(y) / term.cell(x,y) / term.lineCells(y) ◀──────┘
       term.encodeKey() ──▶ kitty's key_encoding.c (kitty keyboard protocol)
```

kitty's C core talks to its Python side through two seams: the CPython API and
window callbacks. This repo fakes the first and bridges the second:

- `shim/Python.h` + `native/pyshim.c` — a minimal refcounted object runtime
  (~140 CPython APIs: unicode as UCS-4, tuples, a working `PyArg_ParseTuple`,
  `Py_BuildValue`, buffers). kitty's type objects, constructors and destructors
  run as-is on top of it.
- `PyObject_CallMethod` is the callback landing pad: kitty's `CALLBACK()`
  invocations (`title_changed`, `clipboard_control`, `desktop_notify`,
  graphics commands, ...) are serialized to JSON events the host consumes.
  Queries kitty answers in Python (DA1) are answered in the bridge.
- `shim/state.h` + `native/stubs.c` — kitty options with default values, output
  capture for `schedule_write_to_child`, and no-op stubs for the windowing/
  font/DnD/graphics-texture surfaces (pixels are the host's job; kitty
  graphics protocol commands are surfaced as events with base64 payloads).
- `native/exports.c` — the wasm ABI: terminals are kitty `Screen` objects
  constructed through `Screen_Type.tp_new`; cell snapshots are flattened from
  kitty's `CPUCell`/`GPUCell` + `TextCache` into a stable 8-word ABI.
- `src/index.ts` — the library. It plays kitty's `window.py` role: consumes
  the callback stream, owns dynamic-color/title-stack behavior (state stays in
  kitty's `ColorProfile` in C), and exposes rendering + input encoding.

What you get for free because it is kitty's real code: resize **rewraps** and
refills from scrollback, grapheme segmentation and East-Asian widths match
kitty exactly, DECRQSS/DECRQM/DA responses are byte-identical to kitty 0.48.2,
the kitty keyboard protocol encoder is `key_encoding.c` itself, and upstream
fixes arrive with a submodule bump.
Feature parity with libghostty-vt's embedder surface: viewport scrolling over
history (`scrollViewport`/`viewportLine`), row-level dirty tracking
(`lineDirty`), kitty's real selection machinery (`selectionStart/Update`,
`selectWord`, `selectLine`, plain/ANSI extraction), full-buffer dumps and
VT-stream serialization (`dump`, `serialize` — kitty's `as_text` machinery),
mouse/focus event encoders honoring the tracked modes, paste-safety checks,
OSC 9;4 progress state, and bookkeeping of kitty-graphics placements
(`graphicsPlacements()` — positions/z-order; pixels stay host-side).

## Usage

```ts
import { KittyTerminal, Key } from "kitty-vt-wasm";

const term = await KittyTerminal.create({
  columns: 80,
  rows: 24,
  scrollback: 2000,
  onOutput: (bytes) => pty.write(bytes), // query replies for the child
  onEvent: (ev) => {
    if (ev.type === "title") document.title = ev.title;
    if (ev.type === "graphics_command") drawKittyImage(ev); // payload: base64
  },
});

pty.onData((bytes) => term.write(bytes)); // feed child output

// render
for (let y = 0; y < term.rows; y++) draw(term.line(y), term.lineCells(y));
const cell = term.cell(0, 0); // { ch, fg, bg, bold, underline, hyperlinkId, ... }

// user input — kitty's real encoder, honoring DECCKM and kitty keyboard flags
pty.write(term.encodeKey(Key.ArrowUp, { ctrl: true }));
pty.write(term.paste(clipboardText)); // honors bracketed paste
pty.write(term.encodeMouse({ x: 10, y: 3, button: "left" })); // honors 1000-1016
pty.write(term.encodeFocus(true)); // honors mode 1004

// scrollback viewport, selection, dumps
term.scrollViewport("page-up");
draw(term.viewportLine(0)); // what the user sees while scrolled
const word = term.selectWord(x, y); // kitty's word-boundary selection
const replay = term.serialize(); // VT stream reproducing screen + scrollback
```

Runs in browsers, node and bun. The wasm module imports only a 4-function WASI
stub (stderr logging + clock), provided by the wrapper.

### PNG screenshots

`examples/screenshot.ts` rasterizes a terminal with a real font
(Menlo + CJK/emoji fallbacks via `@napi-rs/canvas`):

```sh
bun examples/screenshot.ts out.png [raw-escape-stream-file]
```

## Building

Requires a wasm32-capable clang, wasi-libc and wasm compiler builtins
(`brew install llvm wasi-libc wasi-runtimes`), plus bun.

```sh
git clone --recurse-submodules --shallow-submodules https://github.com/can1357/kitty-vt-wasm
cd kitty-vt-wasm && bun install
bun run build     # wasm (build.sh) + TypeScript (tsgo / TypeScript 7)
bun test
```
(Already cloned? `git submodule update --init --depth 1` fetches kitty.)

`build.sh` compiles kitty's sources from `upstream/` through a header overlay:
kitty's own headers everywhere, except `state.h`/`fonts.h`/`base64.h` (the
three that drag in HarfBuzz/GLFW/SIMD-libbase64) and the fake `<Python.h>`.

## Layout

- `upstream/` — kitty, pinned as a git submodule (unmodified)
- `shim/` — fake CPython + replacement headers
- `native/` — pyshim runtime, host stubs, wasm exports
- `src/index.ts` — the TypeScript library
- `test/` — behavior suite (49 tests) · `examples/` — PNG renderer

## License

GPL-3.0-only. Copyright (C) 2026 Can Bölük <me@can.ac>.
Derived from kitty, Copyright (C) Kovid Goyal — see `LICENSE` and `upstream/`.
