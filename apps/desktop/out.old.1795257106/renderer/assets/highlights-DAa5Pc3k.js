function compileHighlightRule(rule) {
  try {
    const flags = rule.flags?.includes("g") ? rule.flags : `${rule.flags ?? ""}g`;
    return new RegExp(rule.pattern, flags);
  } catch {
    return null;
  }
}
function activeHighlightRules(rules) {
  return rules.filter((r) => r.enabled && r.pattern).slice().sort((a, b) => b.priority - a.priority);
}
function segmentText(text, rules) {
  if (text.length === 0) return [];
  const active = activeHighlightRules(rules);
  if (active.length === 0) return [{ text, start: 0, end: text.length }];
  const owner = new Array(text.length);
  for (const rule of active) {
    const re = compileHighlightRule(rule);
    if (!re) continue;
    let guard = 0;
    let m;
    while ((m = re.exec(text)) !== null && guard < 500) {
      guard += 1;
      if (m[0].length === 0) {
        re.lastIndex += 1;
        continue;
      }
      for (let i = m.index; i < m.index + m[0].length; i += 1) {
        if (owner[i] === void 0) owner[i] = rule;
      }
    }
  }
  const segs = [];
  let cur = null;
  for (let i = 0; i < text.length; i += 1) {
    const rule = owner[i];
    if (cur && cur.rule === rule) {
      cur.text += text[i];
    } else {
      if (cur) segs.push({ text: cur.text, start: cur.start, end: i, ...cur.rule ? { rule: cur.rule } : {} });
      cur = { ...rule ? { rule } : {}, start: i, text: text[i] ?? "" };
    }
  }
  if (cur) {
    segs.push({
      text: cur.text,
      start: cur.start,
      end: text.length,
      ...cur.rule ? { rule: cur.rule } : {}
    });
  }
  return segs;
}
function normalizeHexColor(input) {
  if (!input) return null;
  const s = input.trim();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(s);
  if (hex) {
    const h = hex[1] ?? "";
    if (h.length === 3) {
      return `#${h[0]}${h[0]}${h[1]}${h[1]}${h[2]}${h[2]}`.toLowerCase();
    }
    return `#${h.slice(0, 6)}`.toLowerCase();
  }
  const rgb = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(s);
  if (rgb) {
    const a = rgb[4];
    if (a !== void 0 && Number(a) < 1) return null;
    const to2 = (v) => Math.max(0, Math.min(255, Number(v))).toString(16).padStart(2, "0");
    return `#${to2(rgb[1] ?? "0")}${to2(rgb[2] ?? "0")}${to2(rgb[3] ?? "0")}`;
  }
  return null;
}
function segmentHighlightStyle(rule) {
  const fg = rule.foreground?.trim();
  if (fg) return { color: fg };
  const bg = rule.background?.trim();
  if (bg) return { color: bg };
  return {};
}
const WIDE_RANGES = [
  [4352, 4447],
  [8986, 8987],
  [9001, 9002],
  [9193, 9196],
  [9200, 9200],
  [9203, 9203],
  [9725, 9726],
  [9748, 9749],
  [9800, 9811],
  [9855, 9855],
  [9875, 9875],
  [9889, 9889],
  [9898, 9899],
  [9917, 9918],
  [9924, 9925],
  [9934, 9934],
  [9940, 9940],
  [9962, 9962],
  [9970, 9971],
  [9973, 9973],
  [9978, 9978],
  [9981, 9981],
  [9989, 9989],
  [9994, 9995],
  [10024, 10024],
  [10060, 10060],
  [10062, 10062],
  [10067, 10069],
  [10071, 10071],
  [10133, 10135],
  [10160, 10160],
  [10175, 10175],
  [11035, 11036],
  [11088, 11088],
  [11093, 11093],
  [11904, 11929],
  [11931, 12019],
  [12032, 12245],
  [12272, 12283],
  [12288, 12329],
  [12334, 12350],
  [12353, 12438],
  [12443, 12543],
  [12549, 12591],
  [12593, 12686],
  [12688, 12730],
  [12736, 12771],
  [12784, 12830],
  [12832, 12871],
  [12880, 19903],
  [19968, 42124],
  [42128, 42182],
  [43360, 43388],
  [44032, 55203],
  [63744, 64255],
  [65040, 65049],
  [65072, 65106],
  [65108, 65126],
  [65128, 65131],
  [65281, 65376],
  [65504, 65510],
  // astral：emoji / 符号 / 表意扩展
  [94176, 94179],
  [94208, 100343],
  [100352, 101106],
  [110592, 110878],
  [110928, 110930],
  [110948, 110951],
  [110960, 111355],
  [126980, 126980],
  [127183, 127183],
  [127374, 127374],
  [127377, 127386],
  [127488, 127490],
  [127504, 127547],
  [127552, 127560],
  [127568, 127569],
  [127584, 127589],
  [127744, 127776],
  [127789, 127797],
  [127799, 127868],
  [127870, 127891],
  [127904, 127946],
  [127951, 127955],
  [127968, 127984],
  [127988, 127988],
  [127992, 128062],
  [128064, 128064],
  [128066, 128252],
  [128255, 128317],
  [128331, 128334],
  [128336, 128359],
  [128378, 128378],
  [128405, 128406],
  [128420, 128420],
  [128507, 128591],
  [128640, 128709],
  [128716, 128716],
  [128720, 128722],
  [128725, 128725],
  [128747, 128748],
  [128756, 128762],
  [128992, 129003],
  [129293, 129393],
  [129395, 129398],
  [129402, 129442],
  [129445, 129450],
  [129454, 129482],
  [129485, 129535],
  [129648, 129651],
  [129656, 129658],
  [129664, 129666],
  [129680, 129685],
  [131072, 196605],
  [196608, 262141]
];
function charCells(cp) {
  if (cp === 8205) return 0;
  if (cp >= 768 && cp <= 879) return 0;
  if (cp >= 65024 && cp <= 65039) return 0;
  for (const [lo, hi] of WIDE_RANGES) {
    if (cp >= lo && cp <= hi) return 2;
  }
  return 1;
}
function cellsFor(text, charIndex) {
  let cells = 0;
  const upto = Math.max(0, Math.min(charIndex, text.length));
  for (let i = 0; i < upto; i += 1) {
    const cp = text.codePointAt(i);
    if (cp === void 0) break;
    cells += charCells(cp);
    if (cp > 65535) i += 1;
  }
  return cells;
}
export {
  segmentHighlightStyle as a,
  cellsFor as c,
  normalizeHexColor as n,
  segmentText as s
};
