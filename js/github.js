/* Blueprint — GitHub ingestion: list files via the GitHub API, fetch raw file
   contents, distill to an evidence summary. All client-side.
   NOTE: we deliberately do NOT download the codeload zip — codeload.github.com
   only sends `Access-Control-Allow-Origin: https://render.githubusercontent.com`,
   so browsers block the fetch ("Failed to fetch"). api.github.com and
   raw.githubusercontent.com both send `Access-Control-Allow-Origin: *`.
   Pure functions are exported for testability. */

const SUMMARY_BUDGET = 24000; // chars of repo evidence sent to the LLM
const MAX_FILES = 220; // cap on raw files fetched per repo
const MAX_FILE_CHARS = 60000; // per-file slice kept in memory
const FETCH_CONCURRENCY = 6;

const TEXT_EXTS = new Set([
  "md", "markdown", "txt", "json", "yaml", "yml", "toml", "ini", "cfg",
  "js", "mjs", "cjs", "ts", "tsx", "jsx", "py", "rb", "go", "rs", "java",
  "kt", "c", "h", "cpp", "hpp", "cs", "php", "swift", "sh", "sql", "html",
  "css", "vue", "svelte", "dockerfile", "tf",
]);
const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "out", "target", "vendor",
  "__pycache__", ".venv", "venv", ".next", ".nuxt", "coverage", ".idea", ".vscode",
]);

export function parseGitHubUrl(raw) {
  const s = (raw || "").trim().replace(/\/+$/, "");
  const m = s.match(/^https?:\/\/(www\.)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:\/(?:tree|blob)\/([^/]+)(?:\/.*)?)?$/);
  if (!m) return { ok: false, error: "That doesn't look like a GitHub repo URL. Use https://github.com/owner/repo" };
  return { ok: true, owner: m[2], repo: m[3], branch: m[4] || null };
}

function isTextFile(path) {
  const base = path.split("/").pop().toLowerCase();
  if (base === "dockerfile" || base === "makefile") return true;
  const ext = base.includes(".") ? base.split(".").pop() : "";
  return TEXT_EXTS.has(ext);
}

function skipped(path) {
  return path.split("/").some((seg) => SKIP_DIRS.has(seg));
}

/** Pure: choose which files to read. `rels` are repo-relative paths (no top dir). */
export function pickFiles(rels) {
  const files = [];
  for (const rel of rels) {
    if (!rel || rel.endsWith("/")) continue;
    if (skipped(rel)) continue;
    if (isTextFile(rel)) files.push(rel);
    if (files.length >= 4000) break;
  }
  const score = (p) => {
    const b = p.split("/").pop().toLowerCase();
    if (/^readme/i.test(b)) return 0;
    if (b === "package.json" || b === "pyproject.toml" || b === "go.mod" || b === "cargo.toml") return 1;
    if (/(^|\/)(index|main|app|server|cli)\.[a-z]+$/.test(b)) return 2;
    if (p.split("/").length <= 2) return 3;
    return 4;
  };
  files.sort((a, b) => score(a) - score(b) || a.localeCompare(b));
  return files;
}

/** Pure: build the prompt-sized summary from {path: text} map. */
export function buildSummary(fileMap) {
  const paths = Object.keys(fileMap).sort();
  let tree = paths.slice(0, 400).join("\n");
  if (paths.length > 400) tree += `\n... and ${paths.length - 400} more files`;
  const parts = [`FILE TREE (${paths.length} text files):\n${tree}`];
  let used = tree.length;

  const take = (header, text, max) => {
    if (used >= SUMMARY_BUDGET) return;
    const chunk = text.slice(0, Math.min(max, SUMMARY_BUDGET - used));
    parts.push(`\n${header}:\n${chunk}`);
    used += chunk.length;
  };

  const readme = paths.find((p) => /^readme\.?/i.test(p.split("/").pop()));
  if (readme && fileMap[readme]) take(`README (${readme})`, fileMap[readme], 4000);

  const manifests = paths.filter((p) => /^(package\.json|pyproject\.toml|go\.mod|cargo\.toml|pom\.xml|requirements\.txt)$/i.test(p.split("/").pop()));
  for (const m of manifests.slice(0, 2)) take(`MANIFEST (${m})`, fileMap[m], 2500);

  const entries = paths.filter((p) => /(^|\/)(index|main|app|server|cli)\.[a-z]+$/i.test(p)).slice(0, 6);
  for (const e of entries) take(`ENTRY (${e})`, fileMap[e], 2200);

  return { summary: parts.join("\n"), files: paths.length, chars: used };
}

/** Browser: list repo files via the GitHub API, fetch raw contents, distill.
    onProgress(phase, detail). Phases: "fetch" (repo+tree), "read" (files), "distill". */
export async function fetchAndDistill({ owner, repo, branch }, onProgress) {
  const api = `https://api.github.com/repos/${owner}/${repo}`;
  onProgress?.("fetch", `Reading ${owner}/${repo}…`);

  let ref = branch;
  if (!ref) {
    const r = await fetch(api);
    if (r.status === 404) throw new Error("Repo not found or not public. Blueprint only reads public repos.");
    if (!r.ok) throw new Error(`GitHub API error (HTTP ${r.status}).`);
    ref = (await r.json()).default_branch || "main";
  }

  const t = await fetch(`${api}/git/trees/${encodeURIComponent(ref)}?recursive=1`);
  if (t.status === 404) throw new Error("Repo not found or not public. Blueprint only reads public repos.");
  if (!t.ok) throw new Error(`Couldn't list repo files (GitHub API HTTP ${t.status}).`);
  const tree = await t.json();
  const rels = (tree.tree || [])
    .filter((e) => e && e.type === "blob" && e.path)
    .map((e) => e.path);
  const picked = pickFiles(rels);

  onProgress?.("read", `Reading ${picked.length} source files…`);
  const enc = (p) => p.split("/").map(encodeURIComponent).join("/");
  const rawBase = `https://raw.githubusercontent.com/${owner}/${repo}/${encodeURIComponent(ref)}`;
  const fileMap = {};
  for (let i = 0; i < picked.length && Object.keys(fileMap).length < MAX_FILES; i += FETCH_CONCURRENCY) {
    const batch = picked.slice(i, i + FETCH_CONCURRENCY);
    const results = await Promise.all(
      batch.map(async (rel) => {
        try {
          const fr = await fetch(`${rawBase}/${enc(rel)}`);
          if (!fr.ok) return null;
          const text = await fr.text();
          return [rel, text.length > MAX_FILE_CHARS ? text.slice(0, MAX_FILE_CHARS) : text];
        } catch {
          return null; // skip unreadable files
        }
      })
    );
    for (const r of results) if (r) fileMap[r[0]] = r[1];
    onProgress?.("read", `Reading source files… ${Math.min(i + FETCH_CONCURRENCY, picked.length)}/${picked.length}`);
  }

  onProgress?.("distill", "Distilling repo evidence…");
  const { summary, files, chars } = buildSummary(fileMap);
  return { summary, stats: { files, chars } };
}
