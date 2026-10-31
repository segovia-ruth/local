/* Deep Coding — IDLE-style Shell ($store.shell).
 *
 * Run (F5 / Ctrl+Enter) starts the open file and keeps it alive in a Shell pane under the editor:
 * output streams in live and you type your answer to input() / scanf / Scanner right in the pane
 * (Enter sends it), exactly like IDLE or a terminal. Also: a Python shell (>>> prompt, can
 * `import` your files) and a Java shell (jshell).
 *
 * Keys in the pane:  Enter send | ↑/↓ history | Ctrl+C interrupt | Ctrl+D end of input | Ctrl+L clear
 *
 * Backend: lt_live.py  (/api/deep/live/start | poll | input | signal)
 * Depends on $store.ide: center, sessionId, currentText(), save(), _savedContent, blockedByClosed(),
 * applyDiagnostics(), feedRunToChat().
 */
(function () {
  'use strict';

  var H_KEY = 'lt_shell_h', OPEN_KEY = 'lt_shell_open', MAX_TEXT = 300000;
  function lsGet(k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { window.localStorage.setItem(k, v); } catch (e) { /* storage blocked */ } }
  function $(id) { return document.getElementById(id); }
  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
  function post(url, body) {
    return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  }

  var css = [
    '.ide-editor-body{min-height:0}',
    '.ide-shell{flex:0 0 auto;display:flex;flex-direction:column;min-height:0;border-top:1px solid var(--lt-border);background:var(--lt-bg-elevated)}',
    '.ide-shell-grip{height:7px;margin-top:-4px;cursor:row-resize;flex:0 0 auto;touch-action:none}',
    '.ide-shell-bar{display:flex;align-items:center;gap:8px;padding:4px 10px;background:var(--lt-bg-container);border-bottom:1px solid var(--lt-border);font-size:12px;flex-wrap:wrap}',
    '.ide-shell-bar strong{font-size:12px;letter-spacing:.04em;text-transform:uppercase}',
    '.ide-shell-dot{width:8px;height:8px;border-radius:50%;background:var(--lt-text-quaternary)}',
    '.ide-shell-dot.run{background:var(--lt-primary)}.ide-shell-dot.err{background:#b91c1c}',
    '.ide-shell-status{color:var(--lt-text-secondary)}',
    '.ide-shell-tools{margin-left:auto;display:flex;gap:6px;flex-wrap:wrap}',
    '.ide-shell-body{flex:1;min-height:0;overflow:auto;padding:8px 12px;cursor:text;font-family:var(--lt-font-mono);font-size:13px;line-height:1.5;',
    'white-space:pre-wrap;word-break:break-word;color:var(--lt-text)}',
    '.ide-shell-hint{color:var(--lt-text-tertiary)}',
    '.ide-shell-in{border:0;border-bottom:1px dashed var(--lt-primary);outline:0;background:transparent;color:inherit;font:inherit;',
    'padding:0;margin:0;min-width:24ch;max-width:100%;field-sizing:content;caret-color:var(--lt-primary)}',
    'body.ide-shell-resizing{cursor:row-resize;user-select:none}'
  ].join('\n');
  var st = document.createElement('style');
  st.textContent = css;
  document.head.appendChild(st);

  document.addEventListener('alpine:init', function () {
    Alpine.store('shell', {
      open: true,
      running: false,
      busyStart: false,
      runId: '',
      mode: '',            // 'run' | 'repl'
      language: '',
      text: '',
      since: 0,
      echo: false,         // true when the server has no pty: we echo typed lines ourselves
      input: '',
      hist: [],
      hi: -1,
      height: 260,
      status: 'Ready',
      failed: false,
      lastResult: null,
      _t: null,
      _gen: 0,

      init: function () {
        var self = this;
        var h = parseInt(lsGet(H_KEY), 10);
        this.height = h >= 100 ? h : 260;
        this.open = lsGet(OPEN_KEY) !== '0';
        // F5 (as in IDLE) or Ctrl/Cmd+Enter runs the open file; only on the IDE page
        document.addEventListener('keydown', function (e) {
          if (!document.querySelector('.ide-root')) return;
          if (e.key === 'F5' || ((e.ctrlKey || e.metaKey) && e.key === 'Enter')) { e.preventDefault(); self.run(); }
        });
        // leaving the page stops the program (the server also stops idle runs after a few minutes)
        window.addEventListener('pagehide', function () {
          if (self.runId && navigator.sendBeacon) {
            navigator.sendBeacon('/api/deep/live/signal',
              new Blob([JSON.stringify({ run_id: self.runId, signal: 'kill' })], { type: 'application/json' }));
          }
        });
      },

      get statusClass() { return this.running ? 'run' : (this.failed ? 'err' : ''); },
      // Runnable = the IDE says so, OR it is an editable source file by extension (a brand-new file has no
      // main() yet, so `compilable` is false until it is saved; the server still has the final say)
      get canRun() {
        var c = Alpine.store('ide').center;
        if (!c.fileId) return false;
        return !!c.compilable || (!!c.editable && /\.(java|py|c|cc|cpp|cxx|js)$/i.test(c.name || ''));
      },
      get isPython() { var l = (Alpine.store('ide').center.language || '').toLowerCase(); return l === 'python' || l === 'py'; },
      get isJava() { return (Alpine.store('ide').center.language || '').toLowerCase() === 'java'; },

      toggle: function () { this.open = !this.open; lsSet(OPEN_KEY, this.open ? '1' : '0'); },

      // ── starting ────────────────────────────────────────────────────────
      run: async function () {
        var ide = Alpine.store('ide');
        if (this.busyStart || !this.canRun) return;
        if (ide.blockedByClosed && ide.blockedByClosed()) return;
        this.busyStart = true;
        try {
          // run what is on screen: persist unsaved edits first
          if (ide.center.editable && ide.currentText() !== ide._savedContent) {
            var ok = await ide.save();
            if (ok === false) return;
          }
          await this._start({ mode: 'run', file_id: ide.center.fileId });
        } finally { this.busyStart = false; }
      },

      startRepl: async function (language) {
        var ide = Alpine.store('ide');
        if (this.busyStart) return;
        if (ide.blockedByClosed && ide.blockedByClosed()) return;
        this.busyStart = true;
        try {
          if (ide.center.editable && ide.currentText() !== ide._savedContent) await ide.save();   // so `import yourfile` sees it
          await this._start({ mode: 'repl', language: language });
        } finally { this.busyStart = false; }
      },

      _start: async function (body) {
        var ide = Alpine.store('ide');
        this._stopPolling();
        var gen = ++this._gen;
        this.open = true; lsSet(OPEN_KEY, '1');
        this.text = ''; this.since = 0; this.runId = ''; this.running = false; this.failed = false;
        this.lastResult = null; this.input = ''; this.hi = -1;
        this.mode = body.mode; this.status = 'Starting…';
        body.session_id = ide.sessionId;
        var r, d;
        try {
          r = await post('/api/deep/live/start', body);
          d = await r.json().catch(function () { return {}; });
        } catch (e) {
          if (gen !== this._gen) return;
          this.append('Network error. Is the server still running?\n');
          this.status = 'Not started'; this.failed = true;
          return;
        }
        if (gen !== this._gen) return;
        if (!r.ok || d.ok === false || !d.run_id) {
          var out = d.output || d.error || ('Could not start (HTTP ' + r.status + ')');
          this.append(out + (out.slice(-1) === '\n' ? '' : '\n'));
          this.failed = true;
          this.status = d.phase === 'compile' ? 'Compile failed' : 'Not started';
          this.lastResult = { ok: false, language: d.language || ide.center.language, output: out, stdout: '', stderr: d.stderr || out,
                              exit_code: d.exit_code == null ? null : d.exit_code, phase: d.phase || 'error',
                              security_rejected: !!d.security_rejected };
          if (d.phase === 'compile') { try { ide.applyDiagnostics(this.lastResult); } catch (e) { /* editor not ready */ } }
          return;
        }
        try { ide.applyDiagnostics({ ok: true }); } catch (e) { /* clears old error markers */ }
        this.runId = d.run_id; this.language = d.language || ''; this.echo = !!d.echo_input;
        this.running = true;
        this.status = body.mode === 'repl' ? (this.language === 'java' ? 'Java shell' : 'Python shell') : 'Running…';
        this.focusInput();
        this.poll(gen);
      },

      // ── output polling ──────────────────────────────────────────────────
      poll: async function (gen) {
        if (gen !== this._gen || !this.runId) return;
        var delay = 120, self = this;
        try {
          var r = await fetch('/api/deep/live/poll?run_id=' + encodeURIComponent(this.runId) + '&since=' + this.since);
          var d = await r.json().catch(function () { return {}; });
          if (gen !== this._gen) return;
          if (!r.ok || !d.ok) { this._finish(null, 'Lost connection to the program.'); return; }
          if (d.text) this.append(d.text); else delay = 250;
          this.since = d.next;
          if (d.done) { this._finish(d.exit_code); return; }
        } catch (e) { delay = 800; }
        this._t = setTimeout(function () { self.poll(gen); }, delay);
      },

      _stopPolling: function () { if (this._t) { clearTimeout(this._t); this._t = null; } },

      _finish: function (code, note) {
        var ide = Alpine.store('ide');
        this._stopPolling();
        var wasRun = this.mode === 'run';
        this.running = false; this.runId = '';
        var killed = code != null && code < 0;
        var ok = code === 0;
        this.failed = !ok && !killed && wasRun;
        if (wasRun) {
          this.lastResult = { ok: ok, language: this.language, output: this.text, stdout: this.text, stderr: ok ? '' : this.text,
                              exit_code: code, phase: 'run' };
          if (!ok && !killed) { try { ide.applyDiagnostics(this.lastResult); } catch (e) { /* ignore */ } }
        }
        var label = note ? note : (killed ? 'Stopped.' : (ok ? 'Finished.' : 'Exited with code ' + code + '.'));
        this.status = note ? 'Disconnected' : (killed ? 'Stopped' : (ok ? 'Finished (exit 0)' : 'Exited (code ' + code + ')'));
        this.append((this.text && this.text.slice(-1) !== '\n' ? '\n' : '') + '[' + label + ']\n');
        try { ide._savedContent = ide.currentText(); } catch (e) { /* ignore */ }
      },

      append: function (s) {
        var t = this.text + s;
        this.text = t.length > MAX_TEXT ? t.slice(t.length - MAX_TEXT) : t;
        requestAnimationFrame(function () { var b = $('shellBody'); if (b) b.scrollTop = b.scrollHeight; });
      },

      // ── typing into the program ─────────────────────────────────────────
      send: async function () {
        if (!this.running || !this.runId) return;
        var t = this.input;
        this.input = ''; this.hi = -1;
        if (t.trim() && this.hist[this.hist.length - 1] !== t) { this.hist.push(t); if (this.hist.length > 100) this.hist.shift(); }
        if (this.echo) this.append(t + '\n');
        try {
          var r = await post('/api/deep/live/input', { run_id: this.runId, text: t });
          var d = await r.json().catch(function () { return {}; });
          if (!r.ok || d.ok === false) this.append('[' + (d.error || 'Could not send input') + ']\n');
        } catch (e) { this.append('[Network error while sending input]\n'); }
      },

      onKey: function (e) {
        if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); this.send(); return; }
        if (e.key === 'ArrowUp' && this.hist.length) {
          e.preventDefault();
          this.hi = this.hi < 0 ? this.hist.length - 1 : Math.max(0, this.hi - 1);
          this.input = this.hist[this.hi];
        } else if (e.key === 'ArrowDown' && this.hi >= 0) {
          e.preventDefault();
          this.hi += 1;
          if (this.hi >= this.hist.length) { this.hi = -1; this.input = ''; } else this.input = this.hist[this.hi];
        } else if (e.ctrlKey && !e.metaKey && (e.key === 'c' || e.key === 'C')) {
          var el = e.target, sel = (el.selectionStart !== el.selectionEnd) || String(window.getSelection()).length > 0;
          if (!sel) { e.preventDefault(); this.signal('interrupt'); }         // with text selected, Ctrl+C still copies
        } else if (e.ctrlKey && (e.key === 'd' || e.key === 'D') && !this.input) {
          e.preventDefault(); this.signal('eof');
        } else if (e.ctrlKey && (e.key === 'l' || e.key === 'L')) {
          e.preventDefault(); this.clear();
        }
      },

      signal: async function (sig) {
        if (!this.runId) return;
        try { await post('/api/deep/live/signal', { run_id: this.runId, signal: sig }); } catch (e) { /* poll will report */ }
      },
      stop: function () { this.signal('kill'); },

      // ── pane actions ────────────────────────────────────────────────────
      clear: function () { this.text = ''; },
      focusInput: function () { setTimeout(function () { var i = $('shellIn'); if (i) i.focus(); }, 30); },
      clickBody: function () { if (!String(window.getSelection())) this.focusInput(); },
      copy: function () {
        if (!this.text) return;
        navigator.clipboard.writeText(this.text).then(
          function () { if (window.showNotification) showNotification('Shell output copied'); },
          function () { if (window.showNotification) showNotification('Could not copy to clipboard', true); });
      },
      askTutor: function () {
        var ide = Alpine.store('ide');
        if (!this.lastResult) return;
        try { Alpine.store('panes').show('chat'); } catch (e) { /* panes store optional */ }
        ide.feedRunToChat(this.lastResult);
      },

      startResize: function (e) {
        e.preventDefault();
        var self = this, y0 = e.clientY, h0 = this.height;
        var main = document.querySelector('.ide-editor');
        var maxH = Math.max(160, (main ? main.clientHeight : 700) - 200);
        document.body.classList.add('ide-shell-resizing');
        function move(ev) { self.height = clamp(h0 + (y0 - ev.clientY), 100, maxH); }
        function up() {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
          document.body.classList.remove('ide-shell-resizing');
          lsSet(H_KEY, String(Math.round(self.height)));
          window.dispatchEvent(new Event('resize'));             // let CodeMirror re-measure
        }
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
      }
    });
  });
})();
