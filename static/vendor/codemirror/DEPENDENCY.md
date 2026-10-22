# Vendored dependency: CodeMirror 6 (custom bundle)

- **File:** `codemirror.bundle.js` (IIFE, minified — ~537 KB / ~184 KB gzip)
- **Built with:** esbuild 0.28.0 (`--bundle --format=iife --minify --target=es2018`)
- **Project:** https://codemirror.net/
- **License:** MIT — © Marijn Haverbeke and contributors
- **Used by:** `templates/ide.html` (Deep Coding IDE) via the `x-cm-editor` directive in
  `static/js/pages/deep/editor.js`. Loaded only on the IDE page so the rest of the app is
  unaffected. Exposes a flat toolkit on `window.LTCodeMirror` for the no-module page.

## Why a custom bundle (not a CDN file)

CodeMirror 6 ships as ESM packages with no official single browser file; a one-time
author-side bundle is the supported way to use it without a per-deploy build step. The bundle
is then vendored exactly like `alpine.min.js`. Chosen over Monaco because CM6 needs **no
`eval`, no web worker, no `blob:`** — it does not loosen the app's CSP (and `EditorView.cspNonce`
lets us later drop `style-src 'unsafe-inline'`).

## Included packages (resolved versions)

```
@codemirror/state@6.6.0        @codemirror/view@6.43.0
@codemirror/commands@6.10.3    @codemirror/language@6.12.3
@codemirror/autocomplete@6.20.2 @codemirror/lint@6.9.6
@codemirror/lang-java@6.0.2    @codemirror/lang-python@6.2.1
@codemirror/lang-cpp@6.0.3
```

`lang-cpp` covers both C and C++. The light theme + highlight style are applied in
`editor.js` (not bundled) so the bundle stays generic.

## Rebuilding

```bash
mkdir -p /tmp/cmbuild && cd /tmp/cmbuild
npm init -y >/dev/null && npm pkg set type=module
npm install @codemirror/state @codemirror/view @codemirror/commands @codemirror/language \
  @codemirror/autocomplete @codemirror/lint \
  @codemirror/lang-java @codemirror/lang-python @codemirror/lang-cpp esbuild
# entry.mjs imports the symbols and assigns window.LTCodeMirror = { ... }
#   (see git history of static/vendor/codemirror for the exact entry file)
npx esbuild entry.mjs --bundle --format=iife --minify --target=es2018 \
  --outfile=codemirror.bundle.js
cp codemirror.bundle.js <repo>/static/vendor/codemirror/
node --check <repo>/static/vendor/codemirror/codemirror.bundle.js
```

Keep the `entry.mjs` symbol list in sync with what `editor.js` reads off `window.LTCodeMirror`.
Then update the versions above.
