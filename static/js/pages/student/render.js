// student/render.js — assistant-message rendering: markdown/code -> sanitized HTML.
  function inlineFormat(s) {
    return escapeHtml(s).replace(/`([^`]+)`/g, '<code class="inline-code">$1</code>');
  }

  // Inline chat images. Only the app's own auth-checked inline routes render as
  // <img> (anything else stays plain text), matching the sanitizer's
  // same-origin-only rule for images.
  const CHAT_IMG_URL_RE = /^\/api\/(?:student\/session_file_raw|instructor\/tutoring\/file_raw)\?file_id=[0-9a-fA-F-]{36}$/;
  // Line the backend appends to run output for each image a program produced.
  const GEN_IMG_LINE_RE = /^🖼️ Generated image (.+?): (\S+)$/;

  function chatImageHtml(name, url) {
    if (!CHAT_IMG_URL_RE.test(url)) return null;
    const u = escapeHtml(url), n = escapeHtml(name || 'image');
    return '<div class="chat-img"><a href="' + u + '" target="_blank" rel="noopener">'
         + '<img src="' + u + '" alt="' + n + '" loading="lazy"></a>'
         + '<div class="chat-img-name">🖼️ ' + n + '</div></div>';
  }

  // Format a prose segment: numbered lines become clickable options; newlines -> <br>.
  function formatTextSegment(text) {
    return text.split("\n").map(line => {
      const gi = line.match(GEN_IMG_LINE_RE);
      if (gi) {
        const img = chatImageHtml(gi[1], gi[2]);
        if (img) return img;
      }
      const m = line.match(/^(\d+)\.\s(.+)/);
      if (m) {
        return `${m[1]}. <a href="#" class="option-link" data-option="${m[1]}">${inlineFormat(m[2])}</a>`;
      }
      return inlineFormat(line);
    }).join("<br>");
  }

  function codeBlockHtml(lang, code) {
    const cls = lang ? ` language-${escapeHtml(lang)}` : '';
    const label = escapeHtml(lang || 'code');
    return '<div class="code-wrap">'
         + '<div class="code-bar"><span class="code-lang">' + label + '</span>'
         + '<button class="code-copy" type="button" title="Copy code">Copy</button></div>'
         + '<pre class="code-block"><code class="hljs' + cls + '">' + escapeHtml(code) + '</code></pre>'
         + '</div>';
  }

  // ── Compile/run result turns ─────────────────────────────────────────────────
  // A reloaded chat turn can carry a "compile & run" result the backend prepends to
  // the analysis turn (built in routes/student_chat.py):
  //   [Code compiled & run (java)] Status: success (exit 0)
  //   \n\nProgram output:\n<output>      \n\nErrors:\n<stderr> (failures only)
  //   \n\n<fixed tutor-analysis prompt>
  // Both live views already show this as a styled assistant block; only the reloaded
  // turn renders raw, where newlines coalesce into one unreadable line. Detect it and
  // emit a terminal-style card so a reopened thread looks the same as it did live.
  const RUN_RESULT_RE =
    /^\[Code compiled & run \(([^)]*)\)\]\s+Status:\s*(success|failed)(?:\s*\(exit\s*(-?\d+)\))?/i;

  // Fixed prompts the backend appends after the result block (see the student/deep
  // stores). Dropped on display so the reopened turn shows only the result, as live.
  const RUN_ANALYSIS_PROMPTS = [
    'The code compiled and ran. Please analyze the output and explain what it means.',
    'The compilation or run failed. Please help me understand the errors and how to fix them (hints first).',
    'The compilation or run failed. Please help me understand the errors and how to fix them.'
  ];

  function looksLikeRunResult(text) { return RUN_RESULT_RE.test(text || ''); }

  // Terminal card: status bar (✓/✗ + language + exit code) over a monospace body.
  // Reuses the dark chat-code palette (see .run-result in app.css) for consistency.
  function runResultCardHtml(ok, lang, exitCode, body) {
    const meta = [];
    if (lang) meta.push(escapeHtml(lang));
    if (exitCode !== '' && exitCode != null) meta.push('exit ' + escapeHtml(String(exitCode)));
    const metaHtml = meta.length ? '<span class="run-result-meta">' + meta.join(' · ') + '</span>' : '';
    return '<div class="run-result ' + (ok ? 'run-ok' : 'run-fail') + '">'
         + '<div class="run-result-bar">'
         + '<span class="run-result-status">' + (ok ? '&#10003; Compilation succeeded' : '&#10007; Compilation failed') + '</span>'
         + metaHtml + '</div>'
         + '<pre class="run-result-body">' + escapeHtml(body) + '</pre>'
         + '</div>';
  }

  // If `text` is a compile/run result turn, render it as a terminal card and return
  // the HTML; otherwise return null so the caller falls back to normal rendering.
  function renderRunResult(text) {
    const m = (text || '').match(RUN_RESULT_RE);
    if (!m) return null;
    const langRaw = (m[1] || '').toLowerCase();
    const lang = (langRaw === 'code') ? '' : langRaw;   // "code" = generic, no tag
    const ok = m[2].toLowerCase() === 'success';
    const exitCode = (m[3] === undefined) ? '' : m[3];

    let body = text.slice(m[0].length);
    // Strip a trailing fixed analysis prompt (kept off-screen, as it was live).
    for (let i = 0; i < RUN_ANALYSIS_PROMPTS.length; i++) {
      const p = RUN_ANALYSIS_PROMPTS[i], at = body.lastIndexOf(p);
      if (at !== -1 && body.slice(at + p.length).trim() === '') { body = body.slice(0, at); break; }
    }
    // Drop the redundant leading "Program output:" label (the bar already says so),
    // then trim surrounding blank lines.
    body = body.replace(/^\s+/, '').replace(/^Program output:[ \t]*\r?\n?/, '').replace(/\s+$/, '');
    // Generated-image lines leave the monospace body and render as real images
    // below the card (the link line stays useful as text if the URL check fails).
    let imgsHtml = '';
    body = body.split('\n').filter(line => {
      const gi = line.match(GEN_IMG_LINE_RE);
      if (gi) {
        const img = chatImageHtml(gi[1], gi[2]);
        if (img) { imgsHtml += img; return false; }
      }
      return true;
    }).join('\n').replace(/\s+$/, '');
    if (!body && !imgsHtml) body = 'No output.';
    return runResultCardHtml(ok, lang, exitCode, body || 'No output.') + imgsHtml;
  }

  // Render assistant text: a compile/run result becomes a terminal card; otherwise
  // fenced ```code``` blocks become highlighted code blocks and everything else keeps
  // the prose/option formatting.
  function renderMessageHtml(text) {
    text = text || "";
    const runCard = renderRunResult(text);
    if (runCard !== null) return runCard;
    const fence = /```([\w+#.\-]*)[ \t]*\r?\n?([\s\S]*?)```/g;
    let out = "", last = 0, m;
    while ((m = fence.exec(text)) !== null) {
      if (m.index > last) out += renderNonFenced(text.slice(last, m.index).replace(/^\n+|\n+$/g, ''));
      out += codeBlockHtml((m[1] || '').toLowerCase(), m[2].replace(/\n$/, ''));
      last = fence.lastIndex;
    }
    if (last < text.length) {
      const tail = (last > 0) ? text.slice(last).replace(/^\n+/, '') : text.slice(last);
      out += renderNonFenced(tail);
    }
    return out;
  }

  // Heuristic: a single line that strongly looks like source code (used to detect
  // unfenced code the model didn't wrap in ``` fences). Conservative on purpose so
  // ordinary prose (even when it mentions programming terms) is not treated as code.
  function looksLikeCode(line) {
    const t = line.replace(/\s+$/, '');
    if (t.trim() === "") return false;
    if (/[;{}]$/.test(t)) return true;                                  // ends with ; { }
    if (/^\s*(\/\/|\/\*|\*\/)/.test(t)) return true;                    // // or /* */ comments
    if (/=>|->|::|==|!=|>=|<=|\+\+|--/.test(t)) return true;            // code operators
    if (/^\s{2,}\S.*[(){}\[\];=]/.test(t)) return true;                 // indented line w/ code symbol
    if (/^\s*(public|private|protected|static|final|abstract)\s+\S/.test(t)) return true;
    if (/^\s*(#include|#define|using\s+namespace|package\s+\w|import\s+\w)/.test(t)) return true;
    if (/^\s*(def|class|interface|enum|struct|function)\s+\w+/.test(t)) return true;
    if (/^\s*(const|let|var)\s+\w+\s*=/.test(t)) return true;
    if (/^\s*(if|for|while|switch)\s*\(/.test(t)) return true;
    if (/^\s*(else|try|catch|finally|do)\b\s*[\({]/.test(t)) return true;
    if (/^\s*return\b.*;/.test(t)) return true;
    if (/^\s*@\w+(\(|$)/.test(t)) return true;                          // annotations/decorators
    if (/\w+\s*\([^)]*\)\s*[{;]$/.test(t)) return true;                 // call/declaration ending { or ;
    return false;
  }

  // Render a non-fenced segment: a run that STARTS with a strong code line and spans
  // >=2 code-or-indented lines (interior blanks allowed) becomes a highlighted code
  // block; everything else stays prose. Indented continuation lines are included so a
  // function's last line (e.g. "    return s") isn't dropped.
  function renderNonFenced(text) {
    const lines = text.split("\n");
    const isIndented = (l) => /^(\t| {2,})\S/.test(l);
    let html = "", prose = [], i = 0;
    const flush = () => { if (prose.length) { html += formatTextSegment(prose.join("\n")); prose = []; } };
    while (i < lines.length) {
      if (looksLikeCode(lines[i])) {
        let j = i, real = 0, lastReal = i - 1;
        while (j < lines.length) {
          const l = lines[j];
          if (looksLikeCode(l) || isIndented(l)) { real++; lastReal = j; j++; }
          else if (l.trim() === "") {
            let n = j; while (n < lines.length && lines[n].trim() === "") n++;
            if (n < lines.length && (looksLikeCode(lines[n]) || isIndented(lines[n]))) { j = n; } else break;
          } else break;
        }
        if (real >= 2) {
          flush();
          html += codeBlockHtml('', lines.slice(i, lastReal + 1).join("\n"));
          i = lastReal + 1;
          continue;
        }
      }
      prose.push(lines[i]);
      i++;
    }
    flush();
    return html;
  }

  // Backwards-compatible name used elsewhere.
  function formatWithClickableOptions(text) {
    return renderMessageHtml(text);
  }

  const HLJS_ALIASES = {
    py: 'python', js: 'javascript', jsx: 'javascript', ts: 'typescript',
    sh: 'bash', shell: 'bash', 'c++': 'cpp', 'c#': 'csharp', html: 'xml', yml: 'yaml'
  };

  function highlightCodeIn(container) {
    if (!window.hljs) return;
    container.querySelectorAll('pre code').forEach(block => {
      let lang = '';
      const cm = block.className.match(/language-([\w+#.\-]+)/);
      if (cm) lang = cm[1];
      if (HLJS_ALIASES[lang]) lang = HLJS_ALIASES[lang];
      const codeText = block.textContent;
      try {
        if (lang && hljs.getLanguage(lang)) {
          block.className = 'hljs language-' + lang;
          block.innerHTML = hljs.highlight(codeText, { language: lang }).value;
        } else {
          block.className = 'hljs';
          block.innerHTML = hljs.highlightAuto(codeText).value;
        }
      } catch (e) { /* leave as plain escaped text */ }
    });
  }

  function wireCodeCopyButtons(container) {
    container.querySelectorAll('.code-wrap').forEach(wrap => {
      const btn = wrap.querySelector('.code-copy');
      const code = wrap.querySelector('pre code');
      if (!btn || !code) return;
      btn.onclick = () => {
        const text = code.textContent;
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(() => {
            const prev = btn.textContent;
            btn.textContent = 'Copied';
            setTimeout(() => { btn.textContent = prev; }, 1200);
          }).catch(() => {});
        }
      };
    });
  }

  function wireOptionLinks(container) {
    container.querySelectorAll('.option-link').forEach(link => {
      link.onclick = (e) => { e.preventDefault(); sendMessage(link.getAttribute('data-option')); };
    });
  }

  // Render an assistant message into a .message-content element with highlighting + wiring.
  // All assistant/model-derived HTML passes through the shared sanitizer (core/html.js)
  // as defense-in-depth before it reaches the DOM.
  function renderAiInto(contentEl, rawText) {
    contentEl.innerHTML = sanitizeRichHtml(renderMessageHtml(rawText || ""));
    highlightCodeIn(contentEl);
    wireCodeCopyButtons(contentEl);
    wireOptionLinks(contentEl);
  }

