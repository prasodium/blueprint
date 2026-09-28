/* Blueprint — app orchestration. UI wiring, pipeline, refine chat, export, settings. */
import { parseGitHubUrl, fetchAndDistill } from "./github.js";
import { buildSystemPrompt, buildUserPrompt, buildRefinePrompt } from "./prompts.js";
import {
  generateSpec, PROVIDERS, getProvider, currentProviderId, setProviderId,
  providerKey, setProviderKey, providerModel, setProviderModel, providerReady,
} from "./providers.js";
import { validateSpec, browserFetchJson } from "./validate.js";
import { renderDiagram, findNode, relatedEdges, cardsHtml } from "./render.js";

const $ = (id) => document.getElementById(id);

const state = {
  spec: null, type: "architecture", repoLabel: "", repoSummary: "",
  rendering: false,
};

const STEPS = ["fetch", "distill", "generate", "validate", "render"];
const STEP_LABEL = {
  fetch: "Fetching repo", distill: "Distilling evidence",
  generate: "Generating diagram", validate: "Validating spec", render: "Rendering",
};

function setProgress(activeStep, detail) {
  const bar = $("progress");
  if (!activeStep) { bar.classList.add("hidden"); return; }
  bar.classList.remove("hidden");
  bar.innerHTML = STEPS.map((s) => {
    const i = STEPS.indexOf(s), j = STEPS.indexOf(activeStep);
    const cls = i < j ? "done" : i === j ? "active" : "";
    return `<div class="pstep ${cls}"><span class="pdot"></span>${STEP_LABEL[s]}</div>`;
  }).join("") + (detail ? `<div class="pdetail">${detail}</div>` : "");
}

function showError(title, errors) {
  const box = $("errorbox");
  box.classList.remove("hidden");
  box.innerHTML = `<strong>${title}</strong>` +
    (errors && errors.length ? `<ul>${errors.map((e) => `<li>${e}</li>`).join("")}</ul>` : "");
  box.scrollIntoView({ behavior: "smooth", block: "nearest" });
}
function hideError() { $("errorbox").classList.add("hidden"); $("errorbox").innerHTML = ""; }

/* ---------- render into viewport ---------- */
function mountDiagram() {
  const { spec } = state;
  const out = renderDiagram(spec);
  const vp = $("viewport");
  vp.innerHTML = `<div class="svgwrap">${out.svg}</div>`;
  vp.dataset.w = out.W; vp.dataset.h = out.H;
  resetView();
  $("diagram-title").textContent = out.title;
  $("diagram-meta").textContent = `${state.repoLabel} · ${spec.diagram_type}`;
  const cards = $("cards");
  cards.innerHTML = cardsHtml(out.cards);
  cards.classList.toggle("hidden", !out.cards || !out.cards.length);
  $("toolbar").classList.remove("hidden");
  $("stage").classList.remove("hidden");
  $("refinebar").classList.remove("hidden");
  wireNodeClicks();
}

/* pan & zoom on the svg via viewBox */
let view = null;
function resetView() {
  const vp = $("viewport");
  const w = +vp.dataset.w, h = +vp.dataset.h;
  view = { x: 0, y: 0, w, h, baseW: w, baseH: h };
  applyView();
}
function applyView() {
  const svg = $("bp-svg");
  if (svg && view) svg.setAttribute("viewBox", `${view.x} ${view.y} ${view.w} ${view.h}`);
}
function zoomAt(factor, cx, cy) {
  if (!view) return;
  const nw = Math.min(view.baseW * 3, Math.max(view.baseW / 6, view.w * factor));
  const nh = (nw / view.w) * view.h;
  const rx = (cx - view.x) / view.w, ry = (cy - view.y) / view.h;
  view.x = cx - rx * nw; view.y = cy - ry * nh; view.w = nw; view.h = nh;
  applyView();
}

function wireNodeClicks() {
  const svg = $("bp-svg");
  if (!svg) return;
  // pan
  let drag = null;
  svg.addEventListener("pointerdown", (e) => { drag = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, moved: false }; svg.setPointerCapture(e.pointerId); });
  svg.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
    const scale = view.w / svg.clientWidth;
    view.x = drag.vx - dx * scale; view.y = drag.vy - dy * scale;
    applyView();
  });
  svg.addEventListener("pointerup", (e) => {
    const wasDrag = drag && drag.moved;
    drag = null;
    if (wasDrag) return;
    const g = e.target.closest(".bp-node");
    if (g) showNodeDetail(g.dataset.nodeId);
    else hideNodeDetail();
  });
  svg.addEventListener("wheel", (e) => {
    e.preventDefault();
    const r = svg.getBoundingClientRect();
    const cx = view.x + ((e.clientX - r.left) / r.width) * view.w;
    const cy = view.y + ((e.clientY - r.top) / r.height) * view.h;
    zoomAt(e.deltaY > 0 ? 1.15 : 1 / 1.15, cx, cy);
  }, { passive: false });
}

function showNodeDetail(id) {
  const n = findNode(state.spec, state.type, id);
  if (!n) return;
  const edges = relatedEdges(state.spec, state.type, id);
  const panel = $("nodedetail");
  panel.classList.remove("hidden");
  panel.innerHTML = `<button class="x" id="nd-x" aria-label="Close">×</button>
    <h4>${n.label || id}</h4>
    ${n.sublabel ? `<p class="nd-sub">${n.sublabel}</p>` : ""}
    <div class="nd-tags">${n.type ? `<span class="nd-tag">${n.type}</span>` : ""}${n.tag ? `<span class="nd-tag accent">${n.tag}</span>` : ""}</div>
    ${edges.length ? `<p class="nd-h">Connections</p><ul>${edges.slice(0, 12).map((e) =>
      `<li><span class="nd-dir">${e.from === id ? "→" : "←"}</span> ${e.from === id ? e.to : e.from}${e.label ? ` <span class="nd-lbl">· ${e.label}</span>` : ""}</li>`).join("")}</ul>` : ""}`;
  $("nd-x").onclick = hideNodeDetail;
}
function hideNodeDetail() { $("nodedetail").classList.add("hidden"); }

/* ---------- pipeline ---------- */
async function runGenerate(refineInstruction) {
  if (state.rendering) return;
  hideError(); hideNodeDetail();
  const urlRaw = $("repo-url").value;
  const parsed = parseGitHubUrl(urlRaw);
  if (!parsed.ok && !refineInstruction) { showError("Bad repo URL", [parsed.error]); return; }
  const pid = currentProviderId();
  const prov = getProvider(pid);
  const pkey = providerKey(pid);
  const pmodel = providerModel(pid);
  if (prov.needsKey && !pkey) {
    showError("No API key", [`Open <b>Settings</b>, pick <b>${prov.label}</b>, and paste your key${prov.keyUrl ? ` from <a href="${prov.keyUrl}" target="_blank" rel="noopener">${prov.keyUrl.replace(/^https?:\/\//, "")}</a>` : ""}.`]);
    return;
  }

  state.rendering = true;
  $("generate-btn").disabled = true;
  const abort = new AbortController();
  try {
    if (!refineInstruction) {
      state.type = $("diagram-type").value;
      setProgress("fetch");
      const { summary, stats } = await fetchAndDistill(parsed, (phase, detail) => {
        setProgress(phase === "fetch" || phase === "unzip" || phase === "read" ? "fetch" : "distill", detail);
      });
      state.repoSummary = summary;
      state.repoLabel = `${parsed.owner}/${parsed.repo}`;
      setProgress("generate", `Asking ${prov.label} · ${stats.files} files distilled`);
      const { spec } = await generateSpec({
        providerId: pid,
        apiKey: pkey,
        model: pmodel,
        systemPrompt: buildSystemPrompt(state.type),
        userPrompt: buildUserPrompt({
          type: state.type, owner: parsed.owner, repo: parsed.repo,
          branch: parsed.branch, summary, userNote: $("user-note").value,
        }),
        signal: abort.signal,
      });
      state.spec = spec;
    } else {
      setProgress("generate", "Refining diagram…");
      const { spec } = await generateSpec({
        providerId: pid,
        apiKey: pkey,
        model: pmodel,
        systemPrompt: buildSystemPrompt(state.type),
        userPrompt: buildRefinePrompt({
          type: state.type,
          prevSpecJson: JSON.stringify(state.spec),
          instruction: refineInstruction,
        }),
        signal: abort.signal,
      });
      state.spec = spec;
    }

    setProgress("validate", "Checking spec against the Archify schema…");
    const v = await validateSpec(state.spec, state.type, browserFetchJson);
    if (!v.ok) {
      showError("Spec validation failed — not rendering", v.errors);
      setProgress(null);
      return;
    }
    setProgress("render", "Drawing…");
    await new Promise((r) => setTimeout(r, 30));
    mountDiagram();
    setProgress(null);
    $("viewport").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (e) {
    if (e.name === "AbortError") showError("Cancelled", []);
    else showError("Something went wrong", [e.message]);
    setProgress(null);
  } finally {
    state.rendering = false;
    $("generate-btn").disabled = false;
  }
}

/* ---------- export ---------- */
function download(name, blob) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
function exportPNG() {
  const svg = $("bp-svg");
  if (!svg) return;
  const clone = svg.cloneNode(true);
  const w = +$("viewport").dataset.w, h = +$("viewport").dataset.h;
  clone.setAttribute("width", w * 2); clone.setAttribute("height", h * 2);
  const blob = new Blob([new XMLSerializer().serializeToString(clone)], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const img = new Image();
  img.onload = () => {
    const c = document.createElement("canvas");
    c.width = w * 2; c.height = h * 2;
    const ctx = c.getContext("2d");
    ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--paper") || "#fbf8f1";
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(img, 0, 0, c.width, c.height);
    URL.revokeObjectURL(url);
    c.toBlob((b) => download("blueprint.png", b), "image/png");
  };
  img.onerror = () => showError("PNG export failed", ["Could not rasterize the SVG. Try SVG download instead."]);
  img.src = url;
}

/* ---------- settings ---------- */
function refreshSettingsFields() {
  const pid = $("provider-select").value;
  const p = getProvider(pid);
  const keyField = $("key-field");
  keyField.style.display = p.needsKey ? "" : "none";
  $("key-label").textContent = `> ${p.keyName.toLowerCase()}`;
  $("api-key-input").placeholder = p.keyPlaceholder;
  $("api-key-input").value = providerKey(pid);
  const modelInput = $("model-input");
  modelInput.placeholder = p.defaultModel;
  modelInput.value = (() => {
    try {
      const m = JSON.parse(localStorage.getItem("blueprint_models") || "{}")[pid];
      return (m || "").trim();
    } catch { return ""; }
  })();
  $("provider-hint").innerHTML = p.needsKey
    ? `Get a key at <a href="${p.keyUrl}" target="_blank" rel="noopener">${p.keyUrl.replace(/^https?:\/\//, "")}</a> — ${p.hint} Paste it once; it stays in this browser's localStorage and goes only to ${p.label}. Blueprint has no backend.`
    : `${p.hint} Requests go straight to ${p.label}. Blueprint has no backend.`;
}
function openSettings() {
  const sel = $("provider-select");
  if (!sel.options.length) {
    for (const p of PROVIDERS) {
      const o = document.createElement("option");
      o.value = p.id; o.textContent = p.label;
      sel.appendChild(o);
    }
  }
  sel.value = currentProviderId();
  refreshSettingsFields();
  $("settings-modal").classList.remove("hidden");
}
function closeSettings(save) {
  if (save) {
    const pid = $("provider-select").value;
    setProviderId(pid);
    setProviderKey(pid, $("api-key-input").value);
    setProviderModel(pid, $("model-input").value);
    const p = getProvider(pid);
    toast(p.needsKey
      ? (providerKey(pid) ? `${p.label} key saved in this browser only.` : `${p.label} key cleared.`)
      : `${p.label} selected — no key needed.`);
  }
  $("settings-modal").classList.add("hidden");
}
let toastTimer = null;
function toast(msg) {
  const t = $("toast");
  t.textContent = msg; t.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add("hidden"), 2600);
}

/* ---------- wire up ---------- */
document.addEventListener("DOMContentLoaded", () => {
  $("generate-btn").addEventListener("click", () => runGenerate(null));
  $("refine-btn").addEventListener("click", () => {
    const v = $("refine-input").value.trim();
    if (!v) { toast("Type a refinement first — e.g. “add Redis”."); return; }
    if (!state.spec) { toast("Generate a diagram first."); return; }
    $("refine-input").value = "";
    runGenerate(v);
  });
  $("refine-input").addEventListener("keydown", (e) => { if (e.key === "Enter") $("refine-btn").click(); });
  $("settings-btn").addEventListener("click", openSettings);
  $("provider-select").addEventListener("change", refreshSettingsFields);
  $("settings-save").addEventListener("click", () => closeSettings(true));
  $("settings-cancel").addEventListener("click", () => closeSettings(false));
  $("settings-modal").addEventListener("click", (e) => { if (e.target.id === "settings-modal") closeSettings(false); });
  $("zoom-in").addEventListener("click", () => { if (view) zoomAt(1 / 1.25, view.x + view.w / 2, view.y + view.h / 2); });
  $("zoom-out").addEventListener("click", () => { if (view) zoomAt(1.25, view.x + view.w / 2, view.y + view.h / 2); });
  $("zoom-reset").addEventListener("click", resetView);
  $("export-png").addEventListener("click", exportPNG);
  $("export-svg").addEventListener("click", () => {
    const svg = $("bp-svg");
    if (svg) download("blueprint.svg", new Blob([new XMLSerializer().serializeToString(svg)], { type: "image/svg+xml" }));
  });
  $("export-json").addEventListener("click", () => {
    if (state.spec) download("blueprint.json", new Blob([JSON.stringify(state.spec, null, 2)], { type: "application/json" }));
  });
  $("new-btn").addEventListener("click", () => {
    state.spec = null;
    $("toolbar").classList.add("hidden");
    $("stage").classList.add("hidden");
    $("refinebar").classList.add("hidden");
    $("diagram-title").textContent = "";
    window.scrollTo({ top: 0, behavior: "smooth" });
  });
  if (!providerReady()) setTimeout(() => toast("Tip: pick a provider and add an API key in Settings to start."), 800);
});
