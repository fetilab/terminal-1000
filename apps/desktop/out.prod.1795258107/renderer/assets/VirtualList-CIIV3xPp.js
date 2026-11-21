import { r as reactExports, j as jsxRuntimeExports } from "./index-CwfghMy4.js";
function VirtualList({
  items,
  rowHeight,
  overscan = 6,
  threshold = 60,
  className,
  renderRow,
  getKey,
  empty,
  role
}) {
  const viewportRef = reactExports.useRef(null);
  const [scrollTop, setScrollTop] = reactExports.useState(0);
  const [viewportHeight, setViewportHeight] = reactExports.useState(0);
  const rafRef = reactExports.useRef(0);
  const pendingRef = reactExports.useRef(0);
  reactExports.useLayoutEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const measure = () => setViewportHeight(el.clientHeight);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => {
      ro.disconnect();
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, []);
  const handleScroll = reactExports.useCallback((e) => {
    pendingRef.current = e.currentTarget.scrollTop;
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0;
      setScrollTop(pendingRef.current);
    });
  }, []);
  const virtualize = items.length > threshold;
  const classes = ["t-vlist"];
  if (className) classes.push(className);
  if (items.length === 0) {
    return /* @__PURE__ */ jsxRuntimeExports.jsx("div", { ref: viewportRef, className: classes.join(" "), role, children: empty });
  }
  if (!virtualize) {
    return /* @__PURE__ */ jsxRuntimeExports.jsx("div", { ref: viewportRef, className: classes.join(" "), role, onScroll: handleScroll, children: items.map((item, i) => /* @__PURE__ */ jsxRuntimeExports.jsx("div", { children: renderRow(item, i) }, getKey(item, i))) });
  }
  const total = items.length * rowHeight;
  const visibleCount = Math.ceil(viewportHeight / rowHeight) + overscan * 2;
  const start = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const end = Math.min(items.length, start + Math.max(visibleCount, 1));
  const slice = items.slice(start, end);
  return /* @__PURE__ */ jsxRuntimeExports.jsx(
    "div",
    {
      ref: viewportRef,
      className: classes.join(" "),
      role,
      onScroll: handleScroll,
      tabIndex: -1,
      children: /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "t-vlist__inner", style: { height: total }, children: /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "t-vlist__window", style: { transform: `translateY(${start * rowHeight}px)` }, children: slice.map((item, i) => /* @__PURE__ */ jsxRuntimeExports.jsx("div", { children: renderRow(item, start + i) }, getKey(item, start + i))) }) })
    }
  );
}
export {
  VirtualList as V
};
