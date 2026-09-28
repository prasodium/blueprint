/* Blueprint — GitHub ingestion: parse URL, fetch tarball from codeload, unzip, distill.
   All client-side. Pure functions are exported for testability. */

export const MAX_TARBALL_BYTES = 50 * 1024 * 1024; // refuse absurd repos in-browser
const SUMMARY_BUDGET = 24000; // chars of repo evidence sent to the LLM

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

/** Browser: fetch tarball, unzip, distill. onProgress(phase, detail). */
export async function fetchAndDistill({ owner, repo, branch }, onProgress) {
  const ref = branch || "HEAD";
  // codeload /zip/HEAD resolves to the default branch and returns a real zip
  const url = `https://codeload.github.com/${owner}/${repo}/zip/${encodeURIComponent(ref)}`;
  onProgress?.("fetch", `Downloading ${owner}/${repo}…`);
  const res = await fetch(url);
  if (res.status === 404) throw new Error("Repo not found or not public. Blueprint only reads public repos.");
  if (!res.ok) throw new Error(`GitHub download failed (HTTP ${res.status}).`);
  const len = Number(res.headers.get("content-length") || 0);
  if (len > MAX_TARBALL_BYTES) throw new Error("Repo archive is over 50 MB — too big to analyze in the browser.");
  const buf = await res.arrayBuffer();
  if (buf.byteLength > MAX_TARBALL_BYTES) throw new Error("Repo archive is over 50 MB — too big to analyze in the browser.");

  onProgress?.("unzip", "Unpacking archive…");
  if (typeof JSZip === "undefined") throw new Error("JSZip failed to load from CDN. Check your connection and retry.");
  const zip = await JSZip.loadAsync(buf);
  const byRel = {};
  for (const [name, entry] of Object.entries(zip.files)) {
    if (entry.dir) continue;
    byRel[name.split("/").slice(1).join("/")] = entry;
  }
  const picked = pickFiles(Object.keys(byRel));

  onProgress?.("read", `Reading ${picked.length} source files…`);
  const fileMap = {};
  for (const rel of picked) {
    const entry = byRel[rel];
    if (!entry) continue;
    try {
      const text = await entry.async("string");
      if (text.length > 60000) fileMap[rel] = text.slice(0, 60000);
      else fileMap[rel] = text;
    } catch { /* skip unreadable */ }
    if (Object.keys(fileMap).length >= 220) break;
  }
  onProgress?.("distill", "Distilling repo evidence…");
  const { summary, files, chars } = buildSummary(fileMap);
  return { summary, stats: { files, chars } };
}
