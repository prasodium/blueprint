# Contributing to Blueprint

Thanks for wanting to contribute! Blueprint is a tiny static site on purpose —
no build step, no backend, no dependencies to install. Keep it that way.

## Quick start

```bash
python3 -m http.server 8000
# open http://localhost:8000
```

Paste a public repo URL and a free Gemini API key (Google AI Studio) in
Settings to try generation end to end.

## How to contribute

1. **Fork** the repo and create a branch from `main`:
   `feat/short-description` or `fix/short-description`.
2. Make your change. Keep the app dependency-free and working from a plain
   static file server.
3. **Test** what you touched:
   - `js/github.js`, `js/validate.js`, `js/render.js` have pure functions —
     add or extend the offline checks if you change them.
   - Try at least one real public repo URL in the UI.
4. Open a **pull request** against `main` using the PR template. Small,
   focused PRs get reviewed fastest.

## PR checklist

- [ ] Works from `python3 -m http.server` with no build step
- [ ] No new runtime dependencies (CDN or bundled) without discussion
- [ ] No API keys, tokens, or personal data committed
- [ ] README updated if behavior or setup changed
- [ ] The $0-cost rule still holds: nothing here may require a server,
      a paid API, or user tracking

## Ground rules

- **Verify before rendering** is a core invariant: any new diagram output
  must validate against the schemas in `schemas/` before it is drawn.
- Don't invent relationships the evidence doesn't support — the prompts in
  `js/prompts.js` encode this discipline; keep it.
- Be kind. See `CODE_OF_CONDUCT.md`.
