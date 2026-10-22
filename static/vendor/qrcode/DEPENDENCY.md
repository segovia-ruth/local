# Vendored dependency: qrcode-generator

- **File:** `qrcode.min.js`
- **Version:** 1.4.4
- **Source:** https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.min.js
- **Project:** https://github.com/kazuhikoarase/qrcode-generator
- **License:** MIT — © Kazuhiko Arase ("QR Code" is a registered trademark of DENSO WAVE)
- **Used by:** `static/js/core/qr.js` (`LT.qr`) — renders share links (chat pages,
  instructor tutoring links) as QR codes, entirely client-side. The generated image is a
  `data:` URI, which the CSP's `img-src 'self' data:` already permits; no network request
  and no server endpoint are involved.

## Updating

```bash
curl -sS -o static/vendor/qrcode/qrcode.min.js \
  https://cdn.jsdelivr.net/npm/qrcode-generator@<version>/qrcode.min.js
node --check static/vendor/qrcode/qrcode.min.js
```

Then update the version/source above.
