# Vendored dependency: DOMPurify

- **File:** `purify.min.js`
- **Version:** 3.2.4
- **Source:** https://unpkg.com/dompurify@3.2.4/dist/purify.min.js
- **Project:** https://github.com/cure53/DOMPurify
- **License:** Apache-2.0 OR MPL-2.0 (dual) — © Cure53 and contributors
- **Used by:** `static/js/core/html.js` (`sanitizeRichHtml`) — auto-detected at runtime;
  if this file is absent, `html.js` falls back to a built-in conservative sanitizer.

## Updating

```bash
curl -sS -o static/vendor/dompurify/purify.min.js \
  https://unpkg.com/dompurify@<version>/dist/purify.min.js
node --check static/vendor/dompurify/purify.min.js
```

Then update the version/source above.
