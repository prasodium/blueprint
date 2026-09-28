# Blueprint — your repo's blueprint in seconds

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Live site](https://img.shields.io/badge/Live-blueprint-blue)](https://prasodium.github.io/blueprint/)
[![GitHub stars](https://img.shields.io/github/stars/prasodium/blueprint?style=social)](https://github.com/prasodium/blueprint/stargazers)
[![Last commit](https://img.shields.io/github/last-commit/prasodium/blueprint)](https://github.com/prasodium/blueprint/commits/main)

Paste a public GitHub repo URL → get an interactive architecture / sequence /
workflow / data-flow / lifecycle diagram in seconds.

**Cost: $0.** Blueprint is a pure static site. There is no backend, no
database, no signup, no tracking. Everything runs in the visitor's browser:

| Piece | How it's free |
|---|---|
| Hosting | Any static host: GitHub Pages, Cloudflare Pages |
| Repo reading | Browser downloads the public repo zip from `codeload.github.com` and distills it locally (JSZip) |
| The AI | The visitor pastes their own **free** Gemini API key (Google AI Studio, no credit card). Calls go browser → Google directly |
| Validation | Real Archify JSON schemas, checked in-browser with a bundled Ajv |
| Rendering | Custom SVG renderer (no build step, no dependencies) |

The diagram spec format, JSON schemas, and authoring discipline are derived
from [tt-a1i/archify](https://github.com/tt-a1i/archify) (MIT) — see
`THIRD_PARTY_NOTICES.md`. Blueprint keeps Archify's core rule: **verify
before rendering**. The model's JSON is validated against the real schemas
plus semantic checks (unique ids, no dangling references); invalid output is
rejected with a readable error instead of drawn.

## Run locally

Any static file server works:

```bash
cd blueprint-web        # (folder may be named archify-web in this workspace)
python3 -m http.server 8000
# open http://localhost:8000
```

No build step. No `npm install`.

## Deploy to GitHub Pages

This repo is already Pages-ready:

1. Repo → **Settings → Pages** → Deploy from branch → `main` / `/ (root)`.
2. Done — the site is live at `https://prasodium.github.io/blueprint/`.

Cloudflare Pages works the same way (connect the repo; no build command,
no output directory).

## Get the free Gemini key (one-time, ~30 seconds)

1. Go to <https://aistudio.google.com/apikey> and sign in with a Google account.
2. **Create API key** (no billing needed — the free tier is enough).
3. In Blueprint, open **⚙ Settings**, paste the key, Save.

The key is stored **only** in your browser's `localStorage` and sent **only**
to `generativelanguage.googleapis.com`. Blueprint has no server, so there is
nowhere else it could go.

## How it works

1. **Fetch** — the repo zip is downloaded from
   `https://codeload.github.com/<owner>/<repo>/zip/HEAD` (public repos only,
   50 MB cap).
2. **Distill** — file tree + README + manifests (`package.json`, `go.mod`,
   …) + entry-point files, trimmed to a ~24k-character evidence budget.
   `node_modules`, `dist`, `.git`, binaries etc. are skipped.
3. **Generate** — the evidence plus a strict system prompt (derived from the
   Archify skill: typed JSON only, 8–12 core components, primary path first,
   no invented relationships) goes to Gemini with `responseMimeType:
   application/json`.
4. **Validate** — Ajv checks the spec against the vendored Archify schemas;
   semantic checks catch duplicate ids and dangling `from`/`to` references.
5. **Render** — a dependency-free SVG renderer draws the diagram: dark/light
   themes, pan & zoom, click-a-node detail panel, PNG/SVG/JSON export.

**Refine in chat** — after a diagram renders, follow-ups like *"add Redis"*
or *"highlight the cache-miss path"* re-prompt Gemini with the previous spec
and render the revised result.

## File layout

```
index.html            UI shell (Blueprint branding)
css/style.css         dark/light themes
js/app.js             orchestration: pipeline, progress, refine, export, settings
js/github.js          URL parsing, zip fetch, distill (pure functions = testable)
js/prompts.js         system prompts per diagram type (from the Archify skill)
js/gemini.js          Gemini REST client (x-goog-api-key header, JSON mode)
js/validate.js        Ajv + real schemas + semantic checks
js/render.js          custom SVG renderers for the 5 diagram types (no DOM)
js/ajv2020.bundle.js  Ajv 8 (draft 2020-12) bundled locally — no CDN needed
schemas/              the 6 Archify JSON schemas, vendored verbatim (MIT)
THIRD_PARTY_NOTICES.md  attribution
```

## Limitations (honest)

- **Public repos only.** Private repos need auth; the zip endpoint would need
  the visitor's GitHub token (not implemented).
- **LLM quality varies.** The spec is only as good as the model + the
  evidence budget. Very large or polyglot monorepos get a distilled view, not
  a complete map — by design (same tradeoff Archify makes).
- **Renderer is not pixel-identical to Archify's.** The official renderer is
  Node-bound; Blueprint ships a clean-room SVG renderer over the same typed
  spec. Layout is simpler (authored coordinates honored, auto-layout fallback
  when missing).
- **Free-tier quotas.** Gemini's free tier is generous but rate-limited; if
  you hit 429, wait a minute and retry.
- **No key = no generation.** Everything else (UI, validation, rendering)
  works offline; generation needs the visitor's free key.
