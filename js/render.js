/* Blueprint — custom SVG renderer for the Archify typed JSON IR.
   The official Archify renderer is Node-bound (CLI); this is a clean-room
   browser renderer that consumes the SAME typed spec contract (validated
   against the real vendored schemas before we ever get here).
   Pure functions: spec -> SVG string. No DOM needed, so it runs in node too. */

export const THEMES = ["dark", "light"];

const PAL = {
  dark: {
    bg: "#0c1322", bg2: "#101a30", text: "#e9effc", muted: "#8fa1c4",
    nodeFill: "#152036", nodeStroke: "#2b3c60", grid: "rgba(140,165,210,0.07)",
    laneBand: "rgba(120,150,210,0.05)", edge: "#8494b8", edgeLblBg: "#0c1322",
    boundary: "#24365c", boundaryLbl: "#a9bede",
  },
  light: {
    bg: "#f6f8fc", bg2: "#ffffff", text: "#16213a", muted: "#5b6b8c",
    nodeFill: "#ffffff", nodeStroke: "#c9d5ea", grid: "rgba(40,70,130,0.06)",
    laneBand: "rgba(60,100,180,0.05)", edge: "#5b6b8c", edgeLblBg: "#f6f8fc",
    boundary: "#b9c9e8", boundaryLbl: "#33456b",
  },
};

const TYPE_COLORS = {
  frontend: "#38bdf8", backend: "#a78bfa", database: "#fbbf24",
  cloud: "#22d3ee", security: "#fb7185", messagebus: "#fb923c",
  external: "#94a3b8",
};
const STATE_COLORS = {
  start: "#34d399", active: "#38bdf8", waiting: "#fbbf24",
  decision: "#a78bfa", success: "#34d399", failure: "#fb7185",
};
const DOT_COLORS = { emerald: "#34d399", cyan: "#22d3ee", rose: "#fb7185", amber: "#fbbf24" };

export function esc(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function fit(s, maxChars) {
  s = String(s ?? "");
  if (s.length <= maxChars) return s;
  return s.slice(0, Math.max(0, maxChars - 1)) + "…";
}
const tcol = (t) => TYPE_COLORS[t] || "#8fa1c4";

function edgeStyle(variant, pal) {
  switch (variant) {
    case "emphasis": return { stroke: "#e9effc", dark: "#16213a", width: 2.6, dash: "", op: 1 };
    case "security": return { stroke: "#fb7185", width: 2, dash: "", op: 1 };
    case "dashed": return { stroke: pal.edge, width: 1.8, dash: "7 5", op: 0.9 };
    case "return": return { stroke: pal.muted, width: 1.6, dash: "5 4", op: 0.85 };
    default: return { stroke: pal.edge, width: 1.8, dash: "", op: 1 };
  }
}
function edgeColor(variant, pal, theme) {
  const s = edgeStyle(variant, pal);
  if (variant === "emphasis") return theme === "dark" ? "#f2f6ff" : "#1c2a4a";
  return s.stroke;
}

/* Build a smooth path through pts [[x,y],...]; returns {d, angle} where angle
   is the direction of the final segment (for the arrowhead). */
function smoothPath(pts) {
  if (pts.length === 2) {
    const [[x1, y1], [x2, y2]] = pts;
    const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
    const horiz = Math.abs(x2 - x1) >= Math.abs(y2 - y1);
    const d = horiz
      ? `M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`
      : `M ${x1} ${y1} C ${x1} ${my}, ${x2} ${my}, ${x2} ${y2}`;
    return { d, angle: Math.atan2(y2 - my, x2 - mx) };
  }
  let d = `M ${pts[0][0]} ${pts[0][1]}`;
  for (let i = 1; i < pts.length; i++) d += ` L ${pts[i][0]} ${pts[i][1]}`;
  const a = pts[pts.length - 2], b = pts[pts.length - 1];
  return { d, angle: Math.atan2(b[1] - a[1], b[0] - a[0]) };
}

function arrowhead(x, y, angle, color, size = 9) {
  const a1 = angle + Math.PI * 0.82, a2 = angle - Math.PI * 0.82;
  const p1 = [x + Math.cos(a1) * size, y + Math.sin(a1) * size];
  const p2 = [x + Math.cos(a2) * size, y + Math.sin(a2) * size];
  return `<polygon points="${x},${y} ${p1[0].toFixed(1)},${p1[1].toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}" fill="${color}"/>`;
}

function edgeLabel(x, y, text, pal, accent) {
  if (!text) return "";
  const t = fit(text, 34);
  // Halo as a real rect behind the text: works in every SVG renderer
  // (paint-order:stroke is not universally supported).
  const w = t.length * 6.3 + 14, h = 19;
  return `<rect x="${(x - w / 2).toFixed(1)}" y="${(y - 15).toFixed(1)}" width="${w.toFixed(1)}" height="${h}" rx="6" fill="${pal.edgeLblBg}" opacity="0.94"/>` +
    `<text x="${x}" y="${y}" text-anchor="middle" font-size="11.5" fill="${accent || pal.muted}" font-family="inherit">${esc(t)}</text>`;
}

function anchorOf(box, side) {
  const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
  switch (side) {
    case "top": return [cx, box.y];
    case "bottom": return [cx, box.y + box.h];
    case "left": return [box.x, cy];
    case "right": return [box.x + box.w, cy];
    default: return [cx, cy];
  }
}

/* Pick sensible sides when the author didn't specify. */
function autoSides(a, b) {
  const dx = (b.x + b.w / 2) - (a.x + a.w / 2);
  const dy = (b.y + b.h / 2) - (a.y + a.h / 2);
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? ["right", "left"] : ["left", "right"];
  return dy >= 0 ? ["bottom", "top"] : ["top", "bottom"];
}

function drawEdge(pal, theme, { p1, p2, via, label, labelAt, labelDy, variant }) {
  const pts = [p1, ...(via || []), p2];
  const { d, angle } = smoothPath(pts);
  const st = edgeStyle(variant, pal);
  const color = edgeColor(variant, pal, theme);
  let lx, ly;
  if (labelAt) { [lx, ly] = labelAt; }
  else {
    const mid = pts[Math.floor(pts.length / 2)];
    lx = (p1[0] + p2[0]) / 2; ly = (p1[1] + p2[1]) / 2;
    if (pts.length > 2) { lx = mid[0]; ly = mid[1]; }
  }
  ly += (labelDy || 0) - 6;
  return `<path d="${d}" fill="none" stroke="${color}" stroke-width="${st.width}" ` +
    `${st.dash ? `stroke-dasharray="${st.dash}"` : ""} opacity="${st.op}" stroke-linecap="round"/>` +
    arrowhead(p2[0], p2[1], angle, color) +
    (label ? edgeLabel(lx, ly, label, pal, variant === "security" ? "#fb7185" : null) : "");
}

function nodeBox(pal, theme, { x, y, w, h, label, sublabel, tag, accent, nodeId, dim }) {
  const cx = x + w / 2;
  const labelChars = Math.max(6, Math.floor((w - 20) / 7));
  const subChars = Math.max(6, Math.floor((w - 20) / 6));
  return `<g class="bp-node" data-node-id="${esc(nodeId)}" ${dim ? 'opacity="0.35"' : ""}>` +
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="10" fill="${pal.nodeFill}" stroke="${pal.nodeStroke}" stroke-width="1.4"/>` +
    `<rect x="${x}" y="${y}" width="5" height="${h}" rx="2.5" fill="${accent}"/>` +
    `<text x="${cx + 3}" y="${y + h / 2 - (sublabel ? 4 : -5)}" text-anchor="middle" font-size="13.5" font-weight="650" fill="${pal.text}" font-family="inherit">${esc(fit(label, labelChars))}</text>` +
    (sublabel ? `<text x="${cx + 3}" y="${y + h / 2 + 15}" text-anchor="middle" font-size="11" fill="${pal.muted}" font-family="inherit">${esc(fit(sublabel, subChars))}</text>` : "") +
    (tag ? `<text x="${cx + 3}" y="${y + h / 2 + 30}" text-anchor="middle" font-size="10" font-weight="600" fill="${accent}" font-family="inherit">${esc(fit(tag, subChars))}</text>` : "") +
    `</g>`;
}

function svgOpen(w, h, pal) {
  return `<svg id="bp-svg" xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" ` +
    `viewBox="0 0 ${w} ${h}" font-family="ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif">` +
    `<rect width="${w}" height="${h}" fill="${pal.bg}"/>`;
}

/* ---------------- architecture ---------------- */
function renderArchitecture(spec, pal, theme) {
  const comps = spec.components || [];
  const boxes = {};
  // auto-layout fallback if the model skipped positions
  const missing = comps.some((c) => !Array.isArray(c.pos));
  let ax = 60, ay = 80, col = 0;
  for (const c of comps) {
    const w = (c.size && c.size[0]) || 140, h = (c.size && c.size[1]) || 62;
    let x, y;
    if (Array.isArray(c.pos)) { [x, y] = c.pos; }
    else { x = ax + col * 200; y = ay; col++; if (col > 4) { col = 0; ay += 140; } }
    boxes[c.id] = { x, y, w, h, c };
  }
  // viewBox
  let maxX = 0, maxY = 0;
  for (const id of Object.keys(boxes)) {
    const b = boxes[id];
    maxX = Math.max(maxX, b.x + b.w); maxY = Math.max(maxY, b.y + b.h);
  }
  const W = Math.max(900, maxX + 70), H = Math.max(560, maxY + 80);

  let s = "";
  // boundaries (behind)
  for (const b of spec.boundaries || []) {
    const inside = (b.wraps || []).map((id) => boxes[id]).filter(Boolean);
    if (!inside.length) continue;
    const x0 = Math.min(...inside.map((b2) => b2.x)) - 22;
    const y0 = Math.min(...inside.map((b2) => b2.y)) - 40;
    const x1 = Math.max(...inside.map((b2) => b2.x + b2.w)) + 22;
    const y1 = Math.max(...inside.map((b2) => b2.y + b2.h)) + 22;
    s += `<rect x="${x0}" y="${y0}" width="${x1 - x0}" height="${y1 - y0}" rx="14" fill="none" ` +
      `stroke="${pal.boundary}" stroke-width="1.6" stroke-dasharray="${b.kind === "security-group" ? "8 5" : "3 0"}"/>` +
      `<text x="${x0 + 14}" y="${y0 + 22}" font-size="12" font-weight="700" fill="${pal.boundaryLbl}" font-family="inherit">${esc(b.label)}</text>`;
  }
  // connections (under nodes? over boundaries, under nodes looks cleaner)
  let edges = "";
  for (const c of spec.connections || []) {
    const a = boxes[c.from], b = boxes[c.to];
    if (!a || !b) continue;
    const [fs, ts] = (c.fromSide && c.toSide) ? [c.fromSide, c.toSide] : autoSides(a, b);
    edges += drawEdge(pal, theme, {
      p1: anchorOf(a, fs), p2: anchorOf(b, ts), via: c.via,
      label: c.label, labelAt: c.labelAt, labelDy: c.labelDy, variant: c.variant,
    });
  }
  s += edges;
  for (const c of comps) {
    const b = boxes[c.id];
    s += nodeBox(pal, theme, {
      x: b.x, y: b.y, w: b.w, h: b.h, label: c.label, sublabel: c.sublabel,
      tag: c.tag, accent: tcol(c.type), nodeId: c.id,
    });
  }
  const cards = (spec.cards || []).map((card) => ({
    dot: DOT_COLORS[card.dot] || "#8fa1c4",
    title: card.title, items: card.items || [],
  }));
  return { svg: svgOpen(W, H, pal) + s + "</svg>", W, H, cards };
}

/* ---------------- workflow / lifecycle (lane grids) ---------------- */
function laneGrid(spec, nodes, pal, theme, opts) {
  const lanes = spec.lanes || [];
  const laneH = opts.laneH || 128, topPad = (spec.phases && spec.phases.length ? 46 : 18);
  const maxCol = Math.max(0, ...nodes.map((n) => n.col || 0));
  const colW = opts.colW || 215, leftPad = 90;
  const X = (col) => leftPad + col * colW;
  const laneY = (i) => topPad + i * laneH;
  const W = Math.max(900, leftPad * 2 + maxCol * colW + 170);
  const H = topPad + lanes.length * laneH + 60;
  const laneIdx = {};
  lanes.forEach((l, i) => { laneIdx[l.id] = i; });

  let s = "";
  lanes.forEach((l, i) => {
    const y = laneY(i);
    s += `<rect x="8" y="${y}" width="${W - 16}" height="${laneH - 14}" rx="12" fill="${pal.laneBand}"/>` +
      `<text x="22" y="${y + 24}" font-size="12" font-weight="700" fill="${pal.muted}" font-family="inherit">${esc(l.label)}</text>`;
  });
  // phases
  for (const p of spec.phases || []) {
    const x0 = X(p.fromCol) - colW / 2 + 24, x1 = X(p.toCol) + colW / 2 - 24;
    s += `<rect x="${x0}" y="6" width="${Math.max(40, x1 - x0)}" height="30" rx="8" fill="${pal.bg2}" stroke="${pal.nodeStroke}"/>` +
      `<text x="${x0 + 12}" y="26" font-size="12" font-weight="700" fill="${pal.text}" font-family="inherit">${esc(p.label)}</text>`;
  }
  // groups
  for (const g of spec.groups || []) {
    const li = laneIdx[g.lane];
    if (li == null) continue;
    const x0 = X(g.fromCol) - colW / 2 + 14, x1 = X(g.toCol) + colW / 2 - 14;
    const y = laneY(li) + 30;
    s += `<rect x="${x0}" y="${y}" width="${Math.max(60, x1 - x0)}" height="${laneH - 58}" rx="12" fill="none" ` +
      `stroke="${pal.muted}" stroke-width="1.4" stroke-dasharray="7 5" opacity="0.8"/>` +
      `<text x="${x0 + 12}" y="${y - 8}" font-size="11" font-weight="600" fill="${pal.muted}" font-family="inherit">${esc(g.label)}</text>`;
  }
  const boxes = {};
  for (const n of nodes) {
    const w = n.width || opts.nodeW || 160, h = opts.nodeH || 66;
    const li = laneIdx[n.lane] ?? 0;
    boxes[n.id] = { x: X(n.col || 0) - w / 2, y: laneY(li) + (laneH - 14) / 2 - h / 2 + 8, w, h, n };
  }
  return { s, boxes, W, H, laneIdx };
}

function renderWorkflow(spec, pal, theme) {
  const nodes = spec.nodes || [];
  const g = laneGrid(spec, nodes, pal, theme, { laneH: 132, colW: 218, nodeW: 160, nodeH: 68 });
  const mainSet = new Set(spec.mainPath || []);
  let s = g.s;
  for (const e of spec.edges || []) {
    const a = g.boxes[e.from], b = g.boxes[e.to];
    if (!a || !b) continue;
    const sameCol = Math.abs((a.x + a.w / 2) - (b.x + b.w / 2)) < 40;
    const p1 = sameCol ? anchorOf(a, "bottom") : anchorOf(a, "right");
    const p2 = sameCol ? anchorOf(b, "top") : anchorOf(b, "left");
    const variant = e.variant || (mainSet.has(e.from) && mainSet.has(e.to) ? "emphasis" : "default");
    s += drawEdge(pal, theme, { p1, p2, label: e.label, variant });
  }
  for (const n of nodes) {
    const b = g.boxes[n.id];
    s += nodeBox(pal, theme, {
      x: b.x, y: b.y, w: b.w, h: b.h, label: n.label, sublabel: n.sublabel,
      tag: n.tag, accent: tcol(n.type), nodeId: n.id,
    });
  }
  return { svg: svgOpen(g.W, g.H, pal) + s + "</svg>", W: g.W, H: g.H, cards: [] };
}

function renderLifecycle(spec, pal, theme) {
  const states = spec.states || [];
  const g = laneGrid(spec, states, pal, theme, { laneH: 138, colW: 225, nodeW: 168, nodeH: 70 });
  let s = g.s;
  for (const t of spec.transitions || []) {
    const a = g.boxes[t.from], b = g.boxes[t.to];
    if (!a || !b) continue;
    const back = (a.x + a.w / 2) > (b.x + b.w / 2) + 30; // rollback edge: route underneath
    let p1, p2, via;
    if (back) {
      p1 = anchorOf(a, "bottom"); p2 = anchorOf(b, "bottom");
      const y = Math.max(a.y + a.h, b.y + b.h) + 34;
      via = [[p1[0], y], [p2[0], y]];
    } else {
      const sameCol = Math.abs((a.x + a.w / 2) - (b.x + b.w / 2)) < 40;
      p1 = sameCol ? anchorOf(a, "bottom") : anchorOf(a, "right");
      p2 = sameCol ? anchorOf(b, "top") : anchorOf(b, "left");
    }
    s += drawEdge(pal, theme, { p1, p2, via, label: t.label, variant: t.variant });
  }
  for (const st of states) {
    const b = g.boxes[st.id];
    const accent = STATE_COLORS[st.type] || tcol("backend");
    s += nodeBox(pal, theme, {
      x: b.x, y: b.y, w: b.w, h: b.h, label: st.label, sublabel: st.sublabel,
      tag: st.tag || st.type, accent, nodeId: st.id,
    });
    if (st.step) {
      s += `<text x="${b.x + 12}" y="${b.y + 18}" font-size="10.5" font-weight="700" fill="${pal.muted}" font-family="inherit">${esc(st.step)}</text>`;
    }
  }
  return { svg: svgOpen(g.W, g.H, pal) + s + "</svg>", W: g.W, H: g.H, cards: [] };
}

/* ---------------- sequence ---------------- */
function renderSequence(spec, pal, theme) {
  const parts = spec.participants || [];
  const msgs = spec.messages || [];
  const vb = spec.meta && spec.meta.viewBox;
  const W = (vb && vb[0]) || 1080;
  const maxY = Math.max(300, ...msgs.map((m) => m.y || 0));
  const H = maxY + 120;
  const n = Math.max(1, parts.length);
  const X = (i) => (n === 1 ? W / 2 : 80 + (i * (W - 160)) / (n - 1));
  const idx = {};
  parts.forEach((p, i) => { idx[p.id] = i; });

  let s = "";
  for (const sg of spec.segments || []) {
    s += `<rect x="8" y="${sg.from}" width="${W - 16}" height="${sg.to - sg.from}" rx="10" fill="${pal.laneBand}"/>` +
      `<text x="20" y="${sg.from + 22}" font-size="12" font-weight="700" fill="${pal.muted}" font-family="inherit">${esc(sg.label)}</text>`;
  }
  parts.forEach((p, i) => {
    const x = X(i);
    s += `<line x1="${x}" y1="104" x2="${x}" y2="${H - 40}" stroke="${pal.nodeStroke}" stroke-width="1.6" stroke-dasharray="6 5"/>`;
    s += `<g class="bp-node" data-node-id="${esc(p.id)}">` +
      `<rect x="${x - 78}" y="42" width="156" height="56" rx="10" fill="${pal.nodeFill}" stroke="${pal.nodeStroke}" stroke-width="1.4"/>` +
      `<rect x="${x - 78}" y="42" width="5" height="56" rx="2.5" fill="${tcol(p.type)}"/>` +
      `<text x="${x + 4}" y="64" text-anchor="middle" font-size="13" font-weight="650" fill="${pal.text}" font-family="inherit">${esc(fit(p.label, 20))}</text>` +
      (p.sublabel ? `<text x="${x + 4}" y="82" text-anchor="middle" font-size="10.5" fill="${pal.muted}" font-family="inherit">${esc(fit(p.sublabel, 24))}</text>` : "") +
      `</g>`;
  });
  for (const a of spec.activations || []) {
    const i = idx[a.participant];
    if (i == null) continue;
    const x = X(i);
    s += `<rect x="${x - 8}" y="${a.from}" width="16" height="${Math.max(8, a.to - a.from)}" rx="4" fill="${pal.nodeStroke}" opacity="0.85"/>`;
  }
  // sort messages by y for sane layering
  const sorted = [...msgs].sort((a, b) => (a.y || 0) - (b.y || 0));
  for (const m of sorted) {
    const fi = idx[m.from], ti = idx[m.to];
    if (fi == null || ti == null) continue;
    const x1 = X(fi), x2 = X(ti), y = m.y;
    const leftToRight = x2 >= x1;
    const sx = leftToRight ? x1 + 8 : x1 - 8, ex = leftToRight ? x2 - 8 : x2 + 8;
    const color = edgeColor(m.variant, pal, theme);
    const st = edgeStyle(m.variant, pal);
    const mx = (sx + ex) / 2;
    s += `<path d="M ${sx} ${y} C ${mx} ${y}, ${mx} ${y}, ${ex} ${y}" fill="none" stroke="${color}" ` +
      `stroke-width="${st.width}" ${st.dash ? `stroke-dasharray="${st.dash}"` : ""} opacity="${st.op}"/>` +
      arrowhead(ex, y, leftToRight ? 0 : Math.PI, color, 8) +
      edgeLabel((sx + ex) / 2, y - 7, m.label, pal, m.variant === "security" ? "#fb7185" : null);
  }
  return { svg: svgOpen(W, H, pal) + s + "</svg>", W, H, cards: [] };
}

/* ---------------- dataflow ---------------- */
function renderDataflow(spec, pal, theme) {
  const stages = spec.stages || [];
  const nodes = spec.nodes || [];
  const stageW = 225, rowH = 135, leftPad = 70, topPad = 70;
  const maxRow = Math.max(0, ...nodes.map((n) => n.row || 0));
  const W = Math.max(960, leftPad * 2 + (stages.length - 1) * stageW + 180);
  const H = topPad + (maxRow + 1) * rowH + 70;
  const X = (st) => leftPad + st * stageW;
  const Y = (row) => topPad + row * rowH;

  let s = "";
  stages.forEach((st, i) => {
    s += `<text x="${X(i) + 85}" y="34" text-anchor="middle" font-size="12.5" font-weight="700" fill="${pal.muted}" font-family="inherit" letter-spacing="1">${esc((st.label || "").toUpperCase())}</text>`;
    if (i < stages.length - 1) {
      s += `<line x1="${X(i) + 200}" y1="20" x2="${X(i) + 200}" y2="${H - 30}" stroke="${pal.grid}" stroke-width="1.5" stroke-dasharray="4 6"/>`;
    }
  });
  const boxes = {};
  for (const nd of nodes) {
    boxes[nd.id] = { x: X(nd.stage || 0), y: Y(nd.row || 0), w: 170, h: 66, n: nd };
  }
  for (const f of spec.flows || []) {
    const a = boxes[f.from], b = boxes[f.to];
    if (!a || !b) continue;
    const [fs, ts] = (f.fromSide && f.toSide) ? [f.fromSide, f.toSide] : autoSides(a, b);
    s += drawEdge(pal, theme, {
      p1: anchorOf(a, fs), p2: anchorOf(b, ts), via: f.via,
      label: f.label, labelAt: f.labelAt, variant: f.variant,
    });
    if (f.classification) {
      const mid = f.labelAt || [(a.x + b.x) / 2 + 85, (a.y + b.y) / 2 + 33];
      s += `<text x="${mid[0]}" y="${mid[1] + 16}" text-anchor="middle" font-size="10" font-style="italic" fill="${pal.muted}" font-family="inherit">${esc(f.classification)}</text>`;
    }
  }
  for (const nd of nodes) {
    const b = boxes[nd.id];
    s += nodeBox(pal, theme, {
      x: b.x, y: b.y, w: b.w, h: b.h, label: nd.label, sublabel: nd.sublabel,
      tag: nd.tag, accent: tcol(nd.type), nodeId: nd.id,
    });
  }
  return { svg: svgOpen(W, H, pal) + s + "</svg>", W, H, cards: [] };
}

/* ---------------- entry ---------------- */
const RENDERERS = {
  architecture: renderArchitecture,
  workflow: renderWorkflow,
  sequence: renderSequence,
  dataflow: renderDataflow,
  lifecycle: renderLifecycle,
};

export function renderDiagram(spec, theme = "dark") {
  const t = THEMES.includes(theme) ? theme : "dark";
  const pal = PAL[t];
  const fn = RENDERERS[spec.diagram_type];
  if (!fn) throw new Error("No renderer for diagram type: " + spec.diagram_type);
  return { ...fn(spec, pal, t), theme: t, title: (spec.meta && spec.meta.title) || "Untitled" };
}

/** Find a node/state/participant/component by id for the detail panel. */
export function findNode(spec, type, id) {
  const arr = { architecture: spec.components, workflow: spec.nodes, sequence: spec.participants, dataflow: spec.nodes, lifecycle: spec.states }[type] || [];
  return arr.find((n) => n && n.id === id) || null;
}

/** Related edges for the detail panel. */
export function relatedEdges(spec, type, id) {
  const edges = { architecture: spec.connections, workflow: spec.edges, sequence: spec.messages, dataflow: spec.flows, lifecycle: spec.transitions }[type] || [];
  return edges.filter((e) => e && (e.from === id || e.to === id));
}

export function cardsHtml(cards) {
  if (!cards || !cards.length) return "";
  return cards.map((c) =>
    `<div class="bp-card"><div class="bp-card-head"><span class="bp-dot" style="background:${c.dot}"></span><span>${esc(c.title)}</span></div>` +
    `<ul>${c.items.map((i) => `<li>${esc(i)}</li>`).join("")}</ul></div>`
  ).join("");
}
