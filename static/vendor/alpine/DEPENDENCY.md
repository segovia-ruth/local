# Vendored dependency: Alpine.js

- **File:** `alpine.min.js`
- **Version:** 3.14.9
- **Source:** https://unpkg.com/alpinejs@3.14.9/dist/cdn.min.js
- **Project:** https://github.com/alpinejs/alpine
- **License:** MIT — © Caleb Porzio and contributors
- **Used by:** `templates/base.html` (loaded last, `defer`) as the reactive UI runtime for the
  student and instructor pages. All `Alpine.store(...)` / `Alpine.data(...)` / `Alpine.directive(...)`
  registrations are made inside a `document.addEventListener('alpine:init', ...)` handler in the page
  scripts, which run before this file.

## Why the `cdn.min.js` build

The `cdn.min.js` distribution is the self-initializing build intended for a direct `<script>` tag: it
auto-starts on `DOMContentLoaded`. Our scripts only need to register stores/components on the
`alpine:init` event and be parsed before this file (guaranteed by `defer` + source order).

## Updating

```bash
curl -sS -o static/vendor/alpine/alpine.min.js \
  https://unpkg.com/alpinejs@<version>/dist/cdn.min.js
node --check static/vendor/alpine/alpine.min.js
```

Then update the version/source above.
