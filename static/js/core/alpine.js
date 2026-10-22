/*
 * core/alpine.js — shared Alpine bootstrap.
 *
 * Registers the `x-rich` directive: the single declarative bridge into the audited
 * rich-content pipeline. It reuses render.js's pure text→HTML transform and
 * core/html.js's sanitizeRichHtml (the app's XSS boundary), then runs the same
 * post-render wiring (syntax highlight, copy buttons, option links) the imperative
 * renderer used.
 *
 *   <div x-rich="rawString"></div>                  ← markdown/code-fence parsed
 *   <div x-rich="{ content: msg.content }"></div>   ← same, but tracks msg.content reactively
 *   <div x-rich="{ html: msg.html }"></div>         ← pre-built HTML (sanitized + highlighted only)
 *
 * Passing an object literal that reads the message fields is what makes the body
 * re-render when those fields change (e.g. a failed answer is replaced on retry).
 *
 * Must be loaded before alpine.min.js (which is loaded last in base.html) so this
 * `alpine:init` listener is attached when Alpine boots.
 */
document.addEventListener('alpine:init', () => {
  const toHtml = (val) => {
    if (val && typeof val === 'object') {
      if (val.html != null) return String(val.html);
      const c = val.content == null ? '' : String(val.content);
      return (typeof renderMessageHtml === 'function') ? renderMessageHtml(c) : escapeHtml(c);
    }
    const text = val == null ? '' : String(val);
    return (typeof renderMessageHtml === 'function') ? renderMessageHtml(text) : escapeHtml(text);
  };

  Alpine.directive('rich', (el, { expression }, { evaluateLater, effect }) => {
    const getVal = evaluateLater(expression);
    effect(() => {
      getVal(val => {
        el.innerHTML = sanitizeRichHtml(toHtml(val));
        if (typeof highlightCodeIn === 'function')     highlightCodeIn(el);
        if (typeof wireCodeCopyButtons === 'function') wireCodeCopyButtons(el);
        if (typeof wireOptionLinks === 'function')     wireOptionLinks(el);
      });
    });
  });

  /*
   * x-tab-indent — make Tab behave like a code/text editor inside a <textarea>
   * instead of moving focus to the next control.
   *
   *   Tab            → insert a tab at the caret (or indent every selected line)
   *   Shift+Tab      → outdent the current/selected line(s)
   *   Ctrl/Alt/Meta+Tab and read-only/disabled editors keep the native behaviour
   *   (so users can still tab out of the field on purpose).
   *
   * Edits go through execCommand('insertText') when available so the browser's
   * native undo stack is preserved and an `input` event fires — which is what
   * keeps the bound x-model in sync. A manual fallback covers the rare browser
   * where execCommand is unavailable.
   */
  Alpine.directive('tab-indent', (el) => {
    const TAB = '\t';

    const insertText = (text) => {
      try {
        if (document.execCommand('insertText', false, text)) return;
      } catch (_) { /* fall through to manual edit */ }
      const s = el.selectionStart, e = el.selectionEnd;
      el.value = el.value.slice(0, s) + text + el.value.slice(e);
      el.setSelectionRange(s + text.length, s + text.length);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };

    el.addEventListener('keydown', (e) => {
      if (e.key !== 'Tab' || e.altKey || e.ctrlKey || e.metaKey) return;
      if (el.readOnly || el.disabled) return;
      e.preventDefault();

      const value = el.value, start = el.selectionStart, end = el.selectionEnd;
      const spansLines = start !== end && value.slice(start, end).indexOf('\n') !== -1;

      if (e.shiftKey || spansLines) {
        // Indent/outdent whole lines, starting at the line the selection begins on.
        const lineStart = value.lastIndexOf('\n', start - 1) + 1;
        const block = value.slice(lineStart, end);
        const newBlock = e.shiftKey
          ? block.replace(/^(\t| {1,4})/gm, '')   // drop one tab, or up to a tab-width of spaces
          : block.replace(/^/gm, TAB);            // add a tab to every line
        el.setSelectionRange(lineStart, end);
        insertText(newBlock);
        el.setSelectionRange(lineStart, lineStart + newBlock.length);
      } else {
        insertText(TAB);
      }
    });
  });

  /*
   * x-code-editor — syntax highlighting for a file-content <textarea> while
   * keeping it fully editable and in the app's light theme.
   *
   *   <textarea x-model="..." x-code-editor="{ content: <expr>, language: <expr>, name: <expr> }">
   *
   * It wraps the textarea and paints a highlighted <pre> behind it (the textarea
   * text is made transparent via CSS), syncing content + scroll. Highlighting is
   * powered by the vendored highlight.js; c / cpp / java / python are supported
   * (plus everything else in the bundle). Non-source files fall back to plain,
   * still-editable text. Pairs cleanly with x-tab-indent on the same element.
   */
  const HLJS_LANG_ALIASES = {
    py: 'python', py3: 'python', js: 'javascript', jsx: 'javascript',
    ts: 'typescript', sh: 'bash', shell: 'bash', 'c++': 'cpp', cc: 'cpp',
    cxx: 'cpp', hpp: 'cpp', hh: 'cpp', h: 'c', 'c#': 'csharp', cs: 'csharp',
    htm: 'xml', html: 'xml', yml: 'yaml', rb: 'ruby', kt: 'kotlin', rs: 'rust'
  };

  const escapeForPre = (s) => (typeof escapeHtml === 'function')
    ? escapeHtml(s)
    : String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  // Map a server-provided language and/or filename to a highlight.js language id.
  const resolveLang = (language, name) => {
    if (!window.hljs) return '';
    const tryOne = (raw) => {
      let l = String(raw || '').trim().toLowerCase();
      if (!l) return '';
      if (HLJS_LANG_ALIASES[l]) l = HLJS_LANG_ALIASES[l];
      return hljs.getLanguage(l) ? l : '';
    };
    return tryOne(language) || tryOne(String(name || '').split('.').pop());
  };

  // Typography/box properties copied from the textarea to the <pre> so glyphs line up.
  const MIRROR_PROPS = [
    'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'lineHeight',
    'letterSpacing', 'wordSpacing', 'textIndent', 'tabSize',
    'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
    'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth'
  ];

  Alpine.directive('code-editor', (el, { expression }, { evaluateLater, effect, cleanup }) => {
    if (el.tagName !== 'TEXTAREA' || el.closest('.code-editor')) return;

    // Build the overlay: wrapper > (pre.code > textarea).
    const wrap = document.createElement('div');
    wrap.className = 'code-editor';
    const pre = document.createElement('pre');
    pre.className = 'code-editor-pre';
    pre.setAttribute('aria-hidden', 'true');
    const code = document.createElement('code');
    pre.appendChild(code);
    el.parentNode.insertBefore(wrap, el);
    wrap.appendChild(pre);
    wrap.appendChild(el);
    el.classList.add('code-editor-input');

    const mirrorStyles = () => {
      const cs = getComputedStyle(el);
      MIRROR_PROPS.forEach(p => { pre.style[p] = cs[p]; });
    };
    const syncScroll = () => { pre.scrollTop = el.scrollTop; pre.scrollLeft = el.scrollLeft; };

    const paint = (content, lang) => {
      let html;
      if (lang) {
        try { html = hljs.highlight(content, { language: lang }).value; }
        catch (_) { html = escapeForPre(content); }
      } else {
        html = escapeForPre(content);
      }
      code.className = 'hljs' + (lang ? ' language-' + lang : '');
      // Trailing newline so the textarea's final empty line has a matching row.
      code.innerHTML = html + '\n';
      mirrorStyles();
      syncScroll();
    };

    const getData = evaluateLater(expression);
    effect(() => {
      getData(data => {
        const content = data && data.content != null ? String(data.content) : '';
        const lang = resolveLang(data && data.language, data && data.name);
        paint(content, lang);
      });
    });

    el.addEventListener('scroll', syncScroll);
    cleanup(() => el.removeEventListener('scroll', syncScroll));
  });
});
