/*
 * deep/editor.js — CodeMirror 6 integration for the Deep Coding IDE (Phase 2).
 *
 * Registers the `x-cm-editor` Alpine directive (an editable, syntax-highlighted code
 * pane in the app's LIGHT theme) and a pure `parseCompilerDiagnostics()` that turns
 * javac/gcc/clang/python compiler stderr into line/column markers. Diagnostics are
 * authoritative (driven by the real server compiler — there is no language server);
 * CodeMirror's bracket matching gives the instant as-you-type feel between runs.
 *
 * Depends on window.LTCodeMirror (static/vendor/codemirror/codemirror.bundle.js).
 * The directive binds an editor API onto Alpine.store('ide') via bindEditor(), so the
 * store can read the live text (getText) and push diagnostics (setDiagnostics) at
 * save/run time. Content flows IN through the bound expression (reloaded when its
 * `reloadSeq` changes); edits are NOT written back on every keystroke (the view is the
 * source of truth during editing) — this avoids an effect/keystroke feedback loop.
 */

// ── Compiler stderr → diagnostics (pure; unit-tested) ────────────────────────────
// Returns [{ line, col, severity, message }] with 1-based line/col. The caller maps
// line/col onto document offsets (it owns the live doc). Best-effort and line-oriented:
// line numbers in the staged compile match the editor content (staging copies content
// verbatim; the Java public-class rename and data-path rewrites don't add/remove lines).
function parseCompilerDiagnostics(stderr, language) {
  const text = String(stderr || "");
  if (!text.trim()) return [];
  const lines = text.split(/\r?\n/);
  const out = [];
  const lang = String(language || "").toLowerCase();

  const caretCol = (s) => {
    if (!s) return 0;
    const i = s.indexOf("^");
    return i >= 0 ? i + 1 : 0;   // 1-based; also handles leading-space + ^ caret lines
  };

  if (lang === "python" || lang === "py") {
    // Traceback / py_compile SyntaxError:
    //   File "prog.py", line 3
    //     print(
    //          ^
    //   SyntaxError: '(' was never closed
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^\s*File\s+"[^"]*",\s+line\s+(\d+)/);
      if (!m) continue;
      const ln = parseInt(m[1], 10);
      let col = 0, msg = "";
      for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
        if (!col) { const c = caretCol(lines[j]); if (c && /\^/.test(lines[j])) col = c; }
        const em = lines[j].match(/^\s*(\w*Error|Warning):\s*(.*)$/);
        if (em) { msg = (em[1] + ": " + em[2]).trim(); break; }
      }
      out.push({ line: ln, col: col || 1, severity: "error", message: msg || "Syntax error" });
    }
    return dedupe(out);
  }

  // gcc / g++ / clang:  path:line:col: error|warning|note: message
  const gcc = /^(.*?):(\d+):(\d+):\s*(fatal error|error|warning|note):\s*(.*)$/;
  // javac (no column on the message line; a caret on a following line gives the column):
  //   path:line: error: message
  const javac = /^(.*?):(\d+):\s*(error|warning):\s*(.*)$/;

  let sawGcc = false;
  for (let i = 0; i < lines.length; i++) {
    const g = lines[i].match(gcc);
    if (g) {
      sawGcc = true;
      const sev = g[4].indexOf("error") >= 0 ? "error" : (g[4] === "note" ? "info" : "warning");
      out.push({ line: parseInt(g[2], 10), col: parseInt(g[3], 10) || 1, severity: sev, message: g[5].trim() });
    }
  }
  if (sawGcc) return dedupe(out);

  // javac path (only if no gcc-style lines matched, so we don't double-count)
  for (let i = 0; i < lines.length; i++) {
    const j = lines[i].match(javac);
    if (!j) continue;
    const ln = parseInt(j[2], 10);
    const sev = j[3] === "error" ? "error" : "warning";
    // Look ahead for the caret line (within the next 3 lines) to recover the column.
    let col = 1;
    for (let k = i + 1; k < Math.min(i + 4, lines.length); k++) {
      if (/^\s*\^\s*$/.test(lines[k]) || /^\s+\^/.test(lines[k])) { col = caretCol(lines[k]); break; }
    }
    out.push({ line: ln, col: col || 1, severity: sev, message: j[4].trim() });
  }
  return dedupe(out);
}

function dedupe(diags) {
  const seen = new Set(), out = [];
  for (const d of diags) {
    const k = d.line + ":" + d.col + ":" + d.message;
    if (seen.has(k)) continue;
    seen.add(k); out.push(d);
  }
  return out;
}

// Expose for reuse + tests.
window.parseCompilerDiagnostics = parseCompilerDiagnostics;

document.addEventListener('alpine:init', () => {
  const CM = window.LTCodeMirror;
  if (!CM) { console.error('[ide] CodeMirror bundle not loaded'); return; }

  const LANG_ALIASES = { py: 'python', py3: 'python', 'c++': 'cpp', cc: 'cpp', cxx: 'cpp',
                         hpp: 'cpp', h: 'cpp', c: 'cpp', java: 'java', python: 'python', cpp: 'cpp' };
  const resolveLang = (language) => {
    let l = String(language || '').trim().toLowerCase();
    if (LANG_ALIASES[l]) l = LANG_ALIASES[l];
    const f = CM.langs[l];
    return f ? f() : [];
  };

  // Editor font-size zoom (Cmd/Ctrl +/- ; Cmd/Ctrl 0 resets). The size is owned by a per-view
  // compartment (fontComp) so it's reconfigurable, and persisted across files/reloads.
  const FONT_MIN = 9, FONT_MAX = 28, FONT_DEFAULT = 13, FONT_KEY = "lt-deep-font-px";
  const clampFont = (px) => Math.max(FONT_MIN, Math.min(FONT_MAX, Math.round(px || FONT_DEFAULT)));
  const loadFontPx = () => { try { return clampFont(parseInt(localStorage.getItem(FONT_KEY), 10)); } catch (e) { return FONT_DEFAULT; } };
  const saveFontPx = (px) => { try { localStorage.setItem(FONT_KEY, String(px)); } catch (e) {} };
  const fontTheme = (px) => CM.EditorView.theme({ "&": { fontSize: px + "px" } });

  // Light theme bound to the app's --lt-* tokens (matches the locked theme decision).
  // (fontSize lives in fontComp, not here, so the zoom keys can reconfigure it.)
  const theme = CM.EditorView.theme({
    "&": { height: "100%", backgroundColor: "var(--lt-bg-elevated)", color: "var(--lt-text)" },
    ".cm-scroller": { fontFamily: "var(--lt-font-mono)", lineHeight: "1.6", overflow: "auto" },
    ".cm-content": { caretColor: "var(--lt-text)" },
    "&.cm-focused": { outline: "none" },
    ".cm-gutters": { backgroundColor: "var(--lt-bg-container)", color: "var(--lt-text-quaternary)",
                     border: "none", borderRight: "1px solid var(--lt-border)" },
    ".cm-activeLine": { backgroundColor: "var(--lt-fill-quaternary)" },
    ".cm-activeLineGutter": { backgroundColor: "var(--lt-fill-tertiary)" },
    ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": { backgroundColor: "var(--lt-primary-bg)" },
  }, { dark: false });

  Alpine.directive('cm-editor', (el, { expression }, { evaluateLater, effect, cleanup }) => {
    const langComp = new CM.Compartment();
    const roComp = new CM.Compartment();
    const fontComp = new CM.Compartment();
    let fontPx = loadFontPx();
    // Re-apply the font size to the view and persist it (CM command handlers receive the view).
    const setFont = (v, px) => {
      fontPx = clampFont(px);
      saveFontPx(fontPx);
      v.dispatch({ effects: fontComp.reconfigure(fontTheme(fontPx)) });
      v.requestMeasure();
      return true;
    };

    const view = new CM.EditorView({
      parent: el,
      state: CM.EditorState.create({
        doc: "",
        extensions: [
          CM.lineNumbers(),
          CM.highlightActiveLine(),
          CM.highlightActiveLineGutter(),
          CM.history(),
          CM.drawSelection(),
          CM.indentOnInput(),
          CM.bracketMatching(),
          CM.closeBrackets(),
          // Ctrl+S / Cmd+S saves the file (like the Save button) and suppresses the browser's
          // "save page" dialog. "Mod" = Cmd on macOS, Ctrl elsewhere; returning true makes
          // CodeMirror call preventDefault. Listed BEFORE the default keymaps so it always wins.
          // Fires only while the editor is focused (i.e. in the code editing section), as asked.
          CM.keymap.of([
            { key: "Mod-s", preventDefault: true, run: () => { try { Alpine.store('ide').save(); } catch (e) {} return true; } },
            // Editor-only font zoom: Cmd/Ctrl +/- inc/dec, Cmd/Ctrl 0 reset. preventDefault stops
            // the browser's page zoom while the editor is focused. Bind both "=" and "+" so it
            // works with or without Shift. Size persists across files/reloads (localStorage).
            { key: "Mod-=", preventDefault: true, run: (v) => setFont(v, fontPx + 1) },
            { key: "Mod-+", preventDefault: true, run: (v) => setFont(v, fontPx + 1) },
            { key: "Mod--", preventDefault: true, run: (v) => setFont(v, fontPx - 1) },
            { key: "Mod-0", preventDefault: true, run: (v) => setFont(v, FONT_DEFAULT) },
          ]),
          CM.keymap.of([...CM.closeBracketsKeymap, ...CM.defaultKeymap, ...CM.historyKeymap, CM.indentWithTab]),
          CM.syntaxHighlighting(CM.defaultHighlightStyle),
          CM.lintGutter(),
          fontComp.of(fontTheme(fontPx)),
          langComp.of([]),
          roComp.of([CM.EditorState.readOnly.of(true), CM.EditorView.editable.of(false)]),
          theme,
        ],
      }),
    });

    // Bind an API onto the store so save/run can read text + push diagnostics.
    const api = {
      view,
      getText: () => view.state.doc.toString(),
      setDiagnostics: (diags) => view.dispatch(CM.setDiagnostics(view.state, diags || [])),
      focus: () => view.focus(),
    };
    try { Alpine.store('ide').bindEditor(api); } catch (e) { /* store not ready yet */ }

    let lastSeq = null;
    const getCfg = evaluateLater(expression);
    effect(() => {
      getCfg(cfg => {
        if (!cfg || cfg.reloadSeq == null || cfg.reloadSeq === lastSeq) return;
        lastSeq = cfg.reloadSeq;
        // A closed (view-only) thread keeps the file readable and highlighted but not typable —
        // nothing can be saved, so we never let the student type work that would be discarded.
        // setClosed() bumps reloadSeq, so a thread closed while the IDE is open flips here too.
        const closed = (() => { try { return !!Alpine.store('ide').sessionClosed; } catch (e) { return false; } })();
        const editable = !!cfg.editable && !closed;
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: String(cfg.content || "") },
          effects: [
            // Highlighting follows the file TYPE (so a closed thread's code still reads as code);
            // typability follows `editable`, which a closed thread forces off.
            langComp.reconfigure(cfg.editable ? resolveLang(cfg.language) : []),
            roComp.reconfigure([CM.EditorState.readOnly.of(!editable), CM.EditorView.editable.of(editable)]),
          ],
        });
        // Clear stale markers from the previous file, then re-measure (host may have
        // just been un-hidden by x-show).
        view.dispatch(CM.setDiagnostics(view.state, []));
        view.requestMeasure();
      });
    });

    cleanup(() => view.destroy());
  });
});
