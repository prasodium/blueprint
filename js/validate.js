/* Blueprint — "verify before rendering" gate.
   Validates the LLM's JSON against Archify's REAL JSON schemas (vendored,
   MIT tt-a1i/archify) via Ajv, then runs semantic checks (unique ids,
   dangling references). Returns { ok, errors[] } — never throws on bad input. */

const TYPE_SCHEMAS = {
  architecture: "architecture.schema.json",
  workflow: "workflow.schema.json",
  sequence: "sequence.schema.json",
  dataflow: "dataflow.schema.json",
  lifecycle: "lifecycle.schema.json",
};

// Works in browser (AjvBundle global from local bundle) and in node (import).
let _ajvClass = null;
export function setAjv(cls) { _ajvClass = cls; }
function getAjvClass() {
  if (_ajvClass) return _ajvClass;
  if (typeof AjvBundle !== "undefined" && AjvBundle.Ajv2020) return AjvBundle.Ajv2020;
  if (typeof Ajv2020 !== "undefined") return Ajv2020;
  throw new Error("Ajv failed to load. Check your connection and reload.");
}

let _cache = null;
async function getValidators(fetchJson) {
  if (_cache) return _cache;
  const AjvClass = getAjvClass();
  const ajv = new AjvClass({ allErrors: true, strict: false });
  const common = await fetchJson("schemas/common.schema.json");
  ajv.addSchema(common);
  const validators = {};
  for (const [type, file] of Object.entries(TYPE_SCHEMAS)) {
    validators[type] = ajv.compile(await fetchJson(`schemas/${file}`));
  }
  _cache = validators;
  return validators;
}

function fmtAjv(errors) {
  return (errors || []).slice(0, 10).map((e) => {
    const where = e.instancePath ? `at ${e.instancePath}` : "at root";
    return `${where}: ${e.message}`;
  });
}

/** Semantic checks: ids unique, every from/to points at a real node. */
function semanticChecks(spec, type) {
  const errs = [];
  const ids = (arr) => (arr || []).map((n) => n && n.id).filter(Boolean);
  let nodeIds = new Set();
  let edges = [];
  if (type === "architecture") {
    nodeIds = new Set(ids(spec.components));
    edges = (spec.connections || []).map((c, i) => ({ ...c, _i: i, _kind: "connection" }));
    for (const b of spec.boundaries || []) {
      for (const w of b.wraps || []) {
        if (!nodeIds.has(w)) errs.push(`boundary "${b.label || b.kind}" wraps unknown component "${w}"`);
      }
    }
  } else if (type === "workflow") {
    nodeIds = new Set(ids(spec.nodes));
    const lanes = new Set(ids(spec.lanes));
    edges = (spec.edges || []).map((e, i) => ({ ...e, _i: i, _kind: "edge" }));
    for (const n of spec.nodes || []) {
      if (n.lane && !lanes.has(n.lane)) errs.push(`node "${n.id}" is in unknown lane "${n.lane}"`);
    }
    for (const mp of spec.mainPath || []) {
      if (!nodeIds.has(mp)) errs.push(`mainPath references unknown node "${mp}"`);
    }
  } else if (type === "sequence") {
    nodeIds = new Set(ids(spec.participants));
    edges = (spec.messages || []).map((m, i) => ({ ...m, _i: i, _kind: "message" }));
  } else if (type === "dataflow") {
    nodeIds = new Set(ids(spec.nodes));
    edges = (spec.flows || []).map((f, i) => ({ ...f, _i: i, _kind: "flow" }));
  } else if (type === "lifecycle") {
    nodeIds = new Set(ids(spec.states));
    const lanes = new Set(ids(spec.lanes));
    edges = (spec.transitions || []).map((t, i) => ({ ...t, _i: i, _kind: "transition" }));
    for (const s of spec.states || []) {
      if (s.lane && !lanes.has(s.lane)) errs.push(`state "${s.id}" is in unknown lane "${s.lane}"`);
    }
  }
  // duplicate ids
  const counts = {};
  const collect = (arr) => (arr || []).forEach((n) => { if (n && n.id) counts[n.id] = (counts[n.id] || 0) + 1; });
  if (type === "architecture") collect(spec.components);
  if (type === "workflow") collect(spec.nodes);
  if (type === "sequence") collect(spec.participants);
  if (type === "dataflow") collect(spec.nodes);
  if (type === "lifecycle") collect(spec.states);
  for (const [id, c] of Object.entries(counts)) {
    if (c > 1) errs.push(`duplicate id "${id}" (${c} times)`);
  }
  for (const e of edges) {
    if (e.from && !nodeIds.has(e.from)) errs.push(`${e._kind} #${e._i} "from" points at unknown id "${e.from}"`);
    if (e.to && !nodeIds.has(e.to)) errs.push(`${e._kind} #${e._i} "to" points at unknown id "${e.to}"`);
  }
  if (nodeIds.size === 0) errs.push("no nodes found — the spec is empty");
  return errs;
}

export async function validateSpec(spec, type, fetchJson) {
  try {
    if (!spec || typeof spec !== "object") return { ok: false, errors: ["Spec is not a JSON object."] };
    if (spec.diagram_type !== type) {
      return { ok: false, errors: [`diagram_type is "${spec.diagram_type}", expected "${type}". The model drifted — try generating again.`] };
    }
    const validators = await getValidators(fetchJson);
    const valid = validators[type](spec);
    if (!valid) {
      return { ok: false, errors: ["Schema check failed:", ...fmtAjv(validators[type].errors)] };
    }
    const sem = semanticChecks(spec, type);
    if (sem.length) return { ok: false, errors: ["Semantic check failed:", ...sem.slice(0, 10)] };
    return { ok: true, errors: [] };
  } catch (e) {
    return { ok: false, errors: ["Validator crashed: " + e.message] };
  }
}

/** Default fetchJson for the browser (relative to index.html). */
export const browserFetchJson = (p) => fetch(p).then((r) => {
  if (!r.ok) throw new Error("Could not load " + p);
  return r.json();
});
