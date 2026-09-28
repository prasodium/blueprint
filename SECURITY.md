# Security Policy

## Supported versions

Blueprint is a static client-side app. The latest `main` is the supported
version; older commits are not patched.

## Reporting a vulnerability

**Do not open a public issue for security reports.**

Instead, use GitHub's private vulnerability reporting:
repo → **Security** tab → **Report a vulnerability**
(or email the maintainer via the address on their GitHub profile).

Please include:

- A description of the issue and its impact
- Steps to reproduce
- Any suggested mitigation, if you have one

We will acknowledge your report and work on a fix. If the issue is
confirmed, we will release a fix and credit you unless you prefer to stay
anonymous.

## Scope notes

- Blueprint runs entirely in the visitor's browser; there is no server-side
  component to attack.
- The app never sees your Gemini API key — it is stored only in your own
  browser's `localStorage` and sent directly to Google's API.
- The most security-relevant code paths are URL parsing (`js/github.js`)
  and spec validation (`js/validate.js`) — extra eyes there are welcome.
