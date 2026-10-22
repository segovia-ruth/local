/*
 * deep/store.js — Alpine `ide` store for the Deep Coding IDE page (Phase 1).
 *
 * A presentation layer over the EXISTING student endpoints. The IDE window operates on
 * exactly one chat thread (window.DEEP.session_id, injected by the parent page):
 *   • chat   → POST /ask, POST /load_messages, POST /api/student/llm_tasks/<id>/retry
 *   • files  → GET /api/student/session_files, POST /upload, GET .../session_file_download
 *   • viewer → GET /api/student/session_file_detail  (read-only in Phase 1)
 *
 * Rich rendering reuses render.js + the shared x-rich directive (the app's XSS boundary).
 * The CodeMirror editor, compile/run, and the mock-agent edit protocol arrive in later phases.
 */

// Global shim: option links rendered by render.js call sendMessage().
function sendMessage(optionText) { try { Alpine.store('ide').send(optionText || null); } catch {} }

// Parse aider-style SEARCH/REPLACE blocks the tutor may emit in Deep Coding edit mode.
// An optional "FILE: <name>" line directly above a block targets ANOTHER file of the
// project (multi-file fixes — e.g. the bug is in Util.java while Main.java is open);
// without it the edit targets the open file, exactly as before.
// Returns [{ search, replace, target, ... }] and a cleaned text with the raw blocks removed.
function parseEditBlocks(text) {
  const re = /(?:^[ \t]*FILE:[ \t]*([^\n]+?)[ \t]*\r?\n)?<<<<<<<\s*SEARCH\s*\r?\n([\s\S]*?)\r?\n?=======\s*\r?\n([\s\S]*?)\r?\n?>>>>>>>\s*REPLACE/gm;
  const edits = []; let m;
  while ((m = re.exec(text || '')) !== null) {
    edits.push({ target: (m[1] || '').trim(), search: m[2], replace: m[3], applied: false, busy: false, note: '' });
  }
  return edits;
}
function stripEditBlocks(text) {
  return String(text || '')
    .replace(/(?:^[ \t]*FILE:[ \t]*[^\n]+\r?\n)?<<<<<<<\s*SEARCH[\s\S]*?>>>>>>>\s*REPLACE/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
function editDiffHtml(ed) {
  const esc = (typeof escapeHtml === 'function') ? escapeHtml : (s) => s;
  const del = (ed.search || '').split('\n').map(l => '<span class="d-del">- ' + esc(l) + '</span>').join('\n');
  const ins = (ed.replace || '').split('\n').map(l => '<span class="d-ins">+ ' + esc(l) + '</span>').join('\n');
  return del + '\n' + ins;
}

// Shown whenever an action is attempted on a thread the instructor has closed (view-only).
const CLOSED_MSG = 'This conversation has been closed by the instructor — Deep Coding is view-only.';

document.addEventListener('alpine:init', () => {
  const humanSize = (b) => b < 1024 ? b + " B" : b < 1048576 ? (b/1024).toFixed(0) + " KB" : (b/1048576).toFixed(1) + " MB";
  const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif']);
  const fileExt = (name) => { const i = (name || '').lastIndexOf('.'); return i >= 0 ? name.slice(i).toLowerCase() : ''; };
  const downloadUrl = (id) => '/api/student/session_file_download?file_id=' + encodeURIComponent(id);
  // Cheap heuristic: does the source read from stdin? Gates the AI auto-prepare on Run so we
  // don't make an LLM call for programs that take no input. (Covers Python/Java/C/C++.)
  const STDIN_READ_PATTERNS = [
    /\binput\s*\(/, /\bsys\.stdin\b/,                                   // python
    /\bScanner\b/, /\bSystem\.in\b/, /\bBufferedReader\b/, /\breadLine\s*\(/,   // java
    /\bscanf\s*\(/, /\bstd::cin\b/, /\bcin\s*>>/, /\bgetchar\s*\(/, /\bfgets\s*\(/, /\bgetline\s*\(/,  // c/c++
  ];
  const codeReadsStdin = (code) => { const c = String(code || ''); return STDIN_READ_PATTERNS.some(re => re.test(c)); };

  Alpine.store('ide', {
    cfg: window.DEEP || {},
    // Instructor/super-admin closed this thread → the whole IDE is view-only: files, code and
    // transcript stay readable, but chat, uploads, file create/rename/delete, edits, Apply fix,
    // stdin and Run are all off. Seeded by the page (no action flash on first paint) and
    // refreshed from /load_messages, since the instructor may close it while the IDE is open.
    // The server enforces it either way (every /api/deep/* + /ask + /upload 403s with
    // session_closed); these guards keep the UI honest and avoid pointless requests.
    sessionClosed: !!((window.DEEP || {}).closed),
    // chat
    messages: [],
    msgSeq: 0,
    thinking: false,
    messageText: '',
    // files
    files: [],
    // Folder tree view: on-disk storage stays flat; folders are derived purely from each file's
    // rel_dir (logical path). expandedDirs maps a folder path -> false when collapsed; an absent
    // key (or true) means expanded, so a freshly-loaded tree shows everything by default.
    expandedDirs: {},
    uploadStatus: { text: '', cls: '' },
    // duplicate-name overwrite confirm overlay: uploadFiles() pauses on any name collision
    // and awaits the user's PER-FILE choice (checkbox per conflict: checked = overwrite,
    // unchecked = don't upload); non-conflicting files in the same batch upload right away.
    uploadConflictOpen: false,
    uploadConflictItems: [],           // [{i, label, checked}] — i indexes the conflicts batch
    _uploadConflictResolve: null,
    // delete-file confirm overlay (standing convention: in-page overlays, no native popups)
    deleteAsk: { open: false, id: null, name: '' },
    // True while either confirm overlay is up — other Esc handlers defer to it so one
    // keystroke never answers a confirm AND closes the overlay underneath it.
    get confirmOpen() { return this.uploadConflictOpen || this.deleteAsk.open; },
    // drag-drop upload onto the file panel (depth counter ignores child enter/leave noise)
    dragging: false,
    _dragDepth: 0,
    // center editor + viewer.  `content` + `reloadSeq` feed the x-cm-editor directive
    // (reloaded only when reloadSeq changes); `viewerHtml` is the read-only fallback for
    // non-editable files (images/pdf/binaries).
    center: { fileId: null, name: '', language: '', compilable: false, editable: false,
              isImage: false, imageUrl: '', content: '', viewerHtml: '',
              loading: false, error: '', reloadSeq: 0 },
    stdin: '',             // canonical stdin blob sent to /api/deep/run_file (batch)
    // stdin composer overlay: edit the blob as one value-per-line (rows are {id,v}); the blob
    // stays the source of truth (run() uses this.stdin) so the backend contract is unchanged.
    stdinOpen: false,
    stdinLines: [],
    stdinSeq: 0,
    generating: false,     // AI "Generate input" in flight
    autoStdin: true,       // Run auto-fills input (AI) when the program needs it and none is set
    saveStatus: '',
    runStatus: '',
    busy: { save: false, run: false, create: false },
    run: null,            // last run result for the open file
    outputOpen: false,    // run-output overlay over the code area (✕/Esc closes, Output button reopens)
    outputWrap: true,     // wrap long output lines (toggle in the overlay header)
    _cm: null,            // editor API bound by the x-cm-editor directive
    _savedContent: '',
    _stdinSaveTimer: null,   // debounce handle for persisting stdin
    // new-file inline form
    newFileOpen: false,
    newFileName: '',
    newFileErr: '',
    // inline rename of the open file (click its name in the editor header)
    renaming: false,
    renameValue: '',
    renameErr: '',

    get sessionId()    { return this.cfg.session_id || ''; },
    get assignmentId() { return this.cfg.assignment_id || null; },
    get capBytes()     { return this.cfg.cap_bytes || (20 * 1024 * 1024); },
    get showWelcome()  { return !this.thinking && !this.messages.some(m => m.kind === 'user' || m.kind === 'assistant'); },
    get stdinSummary() {
      const s = this.stdin || '';
      if (!s.replace(/\n/g, '').length) return '⌨ Add input';
      const n = s.split('\n').length;
      return '⌨ Edit input (' + n + (n === 1 ? ' line)' : ' lines)');
    },
    get usedBytes()    { return this.files.reduce((s, f) => s + (Number(f.size) || 0), 0); },
    get usagePct()     { return Math.min(100, Math.round((this.usedBytes / this.capBytes) * 100)); },
    get usageLabel()   { return humanSize(this.usedBytes) + ' / ' + humanSize(this.capBytes); },

    init() {
      if (!this.sessionId) { console.error('[ide] missing session_id'); return; }
      this.restoreFilesWidth();
      this.loadMessages();
      this.refreshFiles();
    },

    // ── closed thread ───────────────────────────────────────────────────────────
    // Single guard in front of every action. Returns true when the action must NOT run.
    blockedByClosed(silent) {
      if (!this.sessionClosed) return false;
      if (!silent) showNotification(CLOSED_MSG, true);
      return true;
    },
    // Marks the thread closed (from /load_messages, or from a server 403 if it was closed
    // while the IDE was open) and reloads the editor so CodeMirror turns read-only.
    setClosed(closed) {
      if (!closed || this.sessionClosed) return;
      this.sessionClosed = true;
      this.newFileOpen = false; this.renaming = false; this.stdinOpen = false; this.helpOpen = false;
      // Confirm overlays too — answer a pending overwrite decision as "skip all" so the
      // awaiting uploadFiles() settles instead of hanging on a now view-only thread.
      this.deleteAsk = { open: false, id: null, name: '' };
      if (this._uploadConflictResolve) this.resolveUploadConflict(false);
      this.center = { ...this.center, reloadSeq: this.center.reloadSeq + 1 };
    },
    // Any endpoint answers 403 {session_closed:true} once the thread is closed — catch it
    // centrally so a stale open IDE flips to view-only instead of failing silently.
    noteResponse(data) {
      if (data && data.session_closed) { this.setClosed(true); showNotification(CLOSED_MSG, true); return true; }
      return false;
    },

    // ── layout: draggable file-panel / editor divider ──────────────────────────
    // Drives the grid's first column via the --ide-files-w CSS var; the editor (1fr)
    // absorbs the change, the chat column is untouched. Width is clamped + persisted.
    _root() { return document.querySelector('.ide-root'); },
    _setFilesWidth(px, persist) {
      const root = this._root(); if (!root) return null;
      const min = 140;
      // leave room for the chat (≤380) + splitter (6) + a usable editor (≥200)
      const max = Math.max(min, root.clientWidth - 380 - 6 - 200);
      const w = Math.round(Math.max(min, Math.min(max, px)));
      root.style.setProperty('--ide-files-w', w + 'px');
      if (persist) { try { localStorage.setItem('lt-deep-files-w', String(w)); } catch (e) {} }
      return w;
    },
    restoreFilesWidth() {
      let saved = null;
      try { saved = localStorage.getItem('lt-deep-files-w'); } catch (e) {}
      const n = parseInt(saved, 10);
      if (!isNaN(n)) this._setFilesWidth(n, false);
    },
    startResize(e) {
      const root = (e.currentTarget && e.currentTarget.closest('.ide-root')) || this._root();
      if (!root) return;
      e.preventDefault();
      const left = root.getBoundingClientRect().left;
      const onMove = (ev) => { this._setFilesWidth(ev.clientX - left, false); };
      const onUp = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        document.body.classList.remove('ide-resizing');
        const cur = parseInt(root.style.getPropertyValue('--ide-files-w'), 10);
        if (!isNaN(cur)) { try { localStorage.setItem('lt-deep-files-w', String(cur)); } catch (e) {} }
        this._remeasureEditor();
      };
      document.body.classList.add('ide-resizing');
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    },
    nudgeFilesWidth(dx) {
      const root = this._root(); if (!root) return;
      const files = root.querySelector('.ide-files');
      const cur = files ? files.getBoundingClientRect().width : 260;
      this._setFilesWidth(cur + dx, true);
      this._remeasureEditor();
    },
    resetFilesWidth() {
      const root = this._root(); if (!root) return;
      root.style.removeProperty('--ide-files-w');
      try { localStorage.removeItem('lt-deep-files-w'); } catch (e) {}
      this._remeasureEditor();
    },
    _remeasureEditor() {
      try { this._cm && this._cm.view && this._cm.view.requestMeasure(); } catch (e) {}
    },

    // ── chat ──────────────────────────────────────────────────────────────────
    async loadMessages() {
      try {
        const data = await LT.api.postJson('/load_messages', { session_id: this.sessionId, assignment_id: this.assignmentId });
        this.setClosed(!!data.closed);
        this.messages = [];
        const isRunResult = (c) => (typeof looksLikeRunResult === 'function') && looksLikeRunResult(c);
        (data.messages || []).forEach(m => {
          if (m.role === 'file') {
            this.messages.push({ id: ++this.msgSeq, kind: 'file', filename: m.filename || 'file', fileId: m.file_id || null, compilable: !!m.compilable });
          } else if (m.role === 'user' && !isRunResult(m.content)) {
            this.messages.push({ id: ++this.msgSeq, kind: 'user', content: m.content });
          } else {
            // A "compile & run" turn is stored under the user role but, like the live
            // run view, reads as an assistant-side terminal card (renderMessageHtml detects it).
            this.messages.push({ id: ++this.msgSeq, kind: 'assistant', content: m.content, html: null, failed: false, taskId: null, netError: false, retrying: false });
          }
        });
        this.scrollEnd();
      } catch (e) { console.error('[ide.loadMessages]', e); }
    },

    onComposerKey(e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this.send(); } },
    resizeComposer(ta) { if (!ta) return; ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 160) + 'px'; },

    send(optionText = null) {
      const input = (optionText || this.messageText || '').trim();
      if (!input) return;
      if (this.blockedByClosed()) return;
      this.messages.push({ id: ++this.msgSeq, kind: 'user', content: input });
      if (!optionText) { this.messageText = ''; Alpine.nextTick(() => this.resizeComposer(document.getElementById('ideUserInput'))); }
      this.scrollEnd();
      this.thinking = true;

      // Deep Coding edit mode: send the open file so the tutor can reference exact lines for a
      // SEARCH/REPLACE syntax fix. Only editable source/text is sent as `code`.
      const body = {
        question: input, session_id: this.sessionId, assignment_id: this.assignmentId,
        mode: 'deep_coding', language: this.center.language || '',
        code: (this.center.editable ? this.currentText() : null),
      };
      LT.api.postJson('/ask', body)
        .then(data => {
          this.thinking = false;
          const m = this.pushAssistant(data.answer || '', { failed: !!data.failed, taskId: data.task_id });
          this.attachEdits(m, data.answer);
        })
        .catch(err => {
          this.thinking = false; console.error('[ide.send]', err);
          // Closed while this window was open: flip to view-only instead of offering a retry.
          if (this.noteResponse(err && err.data)) {
            this.pushAssistant('🔒 ' + CLOSED_MSG, {});
            return;
          }
          const m = this.pushAssistant('⚠️ There was a network problem sending your message.', {});
          m.netError = true; m.resendInput = input;
        });
    },

    pushAssistant(raw, opts = {}) {
      const msg = { id: ++this.msgSeq, kind: 'assistant', content: raw || '', html: null, failed: !!opts.failed, taskId: opts.taskId || null, netError: false, retrying: false, edits: [] };
      this.messages.push(msg);
      this.scrollEnd();
      return msg;
    },

    // ── transient action feed ──────────────────────────────────────────────────
    // Short "what's happening now" lines in the chat thread while a compile or
    // Apply-fix request is in flight, with a live elapsed counter after a few
    // seconds — so long server work never looks like a hang. The line is REMOVED
    // when the real result lands (the result messages tell the story).
    startAction(text) {
      this.messages.push({ id: ++this.msgSeq, kind: 'action', content: text, _base: text, _t0: Date.now(), _timer: null });
      // Work with the pushed element's reactive proxy — mutating the raw object
      // would bypass Alpine's set trap and the counter/phase text would never
      // re-render (the line itself only appears/disappears via push/filter).
      const msg = this.messages[this.messages.length - 1];
      msg._timer = setInterval(() => {
        const s = Math.round((Date.now() - msg._t0) / 1000);
        msg.content = msg._base + (s >= 4 ? ' — ' + s + 's' : '');
      }, 1000);
      this.scrollEnd();
      return msg;
    },
    updateAction(msg, text) {
      if (!msg) return;
      msg._base = text; msg.content = text; msg._t0 = Date.now();
      this.scrollEnd();
    },
    endAction(msg) {
      if (!msg) return;
      clearInterval(msg._timer);
      this.messages = this.messages.filter(m => m.id !== msg.id);
    },

    // Pull any SEARCH/REPLACE fix blocks out of an answer into ONE Apply-fix card, and clean
    // the raw markers out of the displayed text. All blocks of an answer form one coherent
    // fix (the prompt forbids alternatives), so the card gets a single Apply button.
    attachEdits(msg, answerText) {
      const edits = parseEditBlocks(answerText);
      if (!edits.length) return;
      edits.forEach(e => { e.diffHtml = editDiffHtml(e); });
      msg.edits = edits;
      msg.fix = { busy: false, applied: false, note: '', status: '', failures: [], phase: '' };
      msg.content = stripEditBlocks(answerText) || 'I suggested a fix below.';
      this.scrollEnd();
    },

    // Apply the tutor's WHOLE fix (every block, across all files) in one server call —
    // /api/deep/apply_fix applies atomically, then compiles internally and runs a bounded
    // LLM verify/correct loop before returning. Blocks without a "FILE: <name>" header
    // target the open file, exactly as the per-block apply did.
    async applyFix(msg) {
      const fix = msg.fix;
      if (!fix || fix.busy || fix.applied) return;
      if (this.sessionClosed) { fix.note = CLOSED_MSG; return; }
      if (!this.center.fileId) { fix.note = 'Open any project file to apply this fix.'; return; }
      if (!this.center.editable && (msg.edits || []).some(e => !e.target)) {
        fix.note = 'Open the file this fix belongs to, then apply it.'; return;
      }
      fix.busy = true; fix.note = ''; fix.failures = []; fix.phase = '';
      fix.status = 'Applying & verifying…';
      // Action feed: this call applies every block, recompiles internally and runs a
      // bounded verify loop — it can take a while, so say what's happening.
      const nEdits = (msg.edits || []).length;
      const act = this.startAction('🔧 Applying the fix (' + nEdits + ' change' + (nEdits === 1 ? '' : 's')
        + ') — then recompiling and verifying on the server…');
      try {
        const r = await fetch('/api/deep/apply_fix', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            file_id: this.center.fileId, stdin: this.stdin, tz: ((Intl.DateTimeFormat().resolvedOptions() || {}).timeZone || ''),
            intent: (msg.content || '').slice(0, 4000),
            edits: (msg.edits || []).map(e => ({ search: e.search, replace: e.replace,
                                                 ...(e.target ? { target: e.target } : {}) })),
          }),
        });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) { this.noteResponse(d); fix.note = d.error || ('Error ' + r.status); return; }
        if (!d.ok) {
          fix.failures = d.failures || [];
          fix.phase = d.phase || 'locate';
          const reasons = fix.failures.map(f => (f.target ? f.target + ': ' : '') + (f.reason || '')).join(' ');
          if (fix.phase === 'apply') {
            // Save-time failure (disk/DB). Files are saved one by one, so earlier files of
            // the fix may already be updated — re-sync and say so honestly. Asking the tutor
            // for a re-anchored fix wouldn't help here, so that button stays hidden.
            fix.note = '⚠ The fix stopped partway while saving — some files may already be updated. ' + reasons;
            this.refreshFiles();
            if (this.center.fileId) this.openFile(this.center.fileId);
          } else {
            // Atomic pre-write failure: nothing was written. Show the per-block reasons and
            // offer to ask the tutor for a fix re-anchored to the current code.
            fix.note = 'The fix could not be applied — nothing was changed. ' + reasons;
          }
          return;
        }
        fix.applied = true;
        // Sync the editor + file list with everything the fix (and its verification) wrote.
        const mine = (d.files || []).find(f => f.file_id === this.center.fileId);
        if (mine) {
          this.center = { ...this.center, content: mine.content, reloadSeq: this.center.reloadSeq + 1 };
          this._savedContent = mine.content;
        }
        this.refreshFiles();
        const v = d.verify || {};
        const vNote = (v.notes && v.notes.length) ? v.notes[v.notes.length - 1] : '';
        // Recovery transparency: the fix landed, but not verbatim — say what the
        // machinery did (re-anchored to current code / applied to a sibling file).
        const recovery = (d.reanchored ? '↺ Re-anchored to your current code. ' : '')
          + ((d.stage_notes || []).some(n => n.includes('applied to'))
              ? (d.stage_notes || []).filter(n => n.includes('applied to')).join(' ') + ' ' : '');
        if (v.achieved) {
          fix.note = recovery + '✓ Applied and verified' + (v.corrections ? ' (' + v.corrections + ' internal correction(s) were needed — review the changes)' : '') + '.';
        } else if (v.attempted) {
          fix.note = recovery + '⚠ Applied, but could not be fully verified: ' + (vNote || 'see the tutor’s reply.');
        } else {
          fix.note = recovery + '✓ Applied. ' + (vNote || '');
        }
        if (d.run) {
          // Surface the internal run exactly like a manual Run: output panel + squiggles
          // (only when the compiled entry file is the one open), then let the tutor comment
          // — on failure it will ask the student to choose or clarify next steps.
          if (d.entry_file_id === this.center.fileId) { this.showRun(d.run); this.applyDiagnostics(d.run); }
          const q = v.achieved
            ? 'I applied your suggested fix with one click; it was verified internally and the program compiles. Briefly confirm what changed and why, and tell me what to try next.'
            : 'I applied your suggested fix, but the automatic verification could not finish ('
              + (vNote || 'see the result above') + '). Please explain what happened; if I need to choose between approaches or clarify what I want, ask me with clear options.';
          this.feedRunToChat(d.run, q);
        }
      } catch (e) { fix.note = 'Network error.'; }
      finally { fix.busy = false; fix.status = ''; this.endAction(act); }
    },

    // A located-nowhere fix means the file changed since the suggestion: hand the mismatch
    // back to the tutor through the normal chat, asking for ONE re-anchored fix.
    askFixUpdate(msg) {
      const fix = msg.fix;
      if (!fix || !(fix.failures || []).length) return;
      const lines = fix.failures.map(f =>
        '- ' + (f.target ? f.target + ': ' : '') + (f.reason || '')
        + (f.nearby ? '\n  Closest code in my file:\n' + f.nearby : ''));
      this.send('I clicked "Apply fix" but it could not be applied:\n' + lines.join('\n')
        + '\nPlease send ONE updated fix that matches my current code.');
    },
    // "I'm still stuck" escalation — flags this session for the instructor (badge + top of
    // their audit list). The IDE shares the chat thread's session, so one endpoint serves all.
    helpFlagged: false,
    helpOpen: false,
    helpNote: '',
    helpBusy: false,
    // Back to the chat view — and remember conversation as this chat's mode default, so
    // the next open lands there instead of routing back into the IDE. Navigation happens
    // even if the save fails (the worst case is being asked/routed again next open).
    async switchToConversation() {
      try { await LT.api.postJson('/api/session_mode', { session_id: this.sessionId, mode: 'conversation' }); }
      catch (e) { console.warn('[ide] mode save failed:', e); }
      window.location.assign((this.cfg.chat_url) || '/student');
    },

    flagHelp() {
      if (this.blockedByClosed()) return;
      this.helpNote = '';
      this.helpOpen = true;
      Alpine.nextTick(() => document.getElementById('ideHelpNote')?.focus());
    },
    closeHelpFlag() { this.helpOpen = false; },
    async submitHelpFlag() {
      if (this.helpBusy) return;
      this.helpBusy = true;
      try {
        const r = await fetch('/api/student/flag_help', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ session_id: this.sessionId, note: (this.helpNote || '').trim() }),
        });
        const d = await r.json().catch(() => ({}));
        if (r.ok && d.ok) { this.helpFlagged = true; this.helpOpen = false; showNotification('Flagged for your instructor — they can see this session and everything you tried.'); }
        else if (!this.noteResponse(d)) showNotification(d.error || 'Could not flag this session', true);
      } catch { showNotification('Network error', true); }
      finally { this.helpBusy = false; }
    },
    removeMessage(id) { this.messages = this.messages.filter(m => m.id !== id); },
    retryNet(msg) { const input = msg.resendInput; this.removeMessage(msg.id); this.send(input); },

    async retryTask(msg) {
      if (msg.retrying || !msg.taskId) return;
      if (this.blockedByClosed()) return;
      msg.retrying = true;
      try {
        const data = await LT.api.postJson(`/api/student/llm_tasks/${msg.taskId}/retry`, {});
        if (data && data.ok) { msg.failed = false; msg.html = null; msg.content = data.answer || ''; }
        else showNotification('Retry failed: ' + ((data && data.error) || 'still unavailable'), true);
      } catch { showNotification('Network error during retry', true); }
      finally { msg.retrying = false; }
    },

    scrollEnd() { Alpine.nextTick(() => { const el = document.getElementById('ideMessages'); if (el) el.scrollTop = el.scrollHeight; }); },

    // ── files (left panel) ──────────────────────────────────────────────────────
    fileTitle(f) {
      const bits = [];
      if (f.language) bits.push(f.language);
      if (f.size) bits.push(humanSize(f.size));
      if (!f.available) bits.push('unavailable on server');
      return (f.compilable ? 'Source file' : 'File') + (bits.length ? ' — ' + bits.join(' · ') : '');
    },
    fileIcon(f) {
      if (IMAGE_EXTS.has(fileExt(f.name))) return '🖼';
      return f.compilable ? '</>' : '📄';
    },

    // ── folder tree ──────────────────────────────────────────────────────────────
    // Flatten the file list into a depth-first list of VISIBLE rows for the explorer.
    // Folders are grouped from each file's rel_dir; collapsed folders hide their subtree.
    // Each row is { type:'dir'|'file', key, depth, ... } so a single <template x-for> renders
    // the whole tree (Alpine has no recursive templates). Folders sort before files, both A→Z.
    isDirExpanded(path) { return this.expandedDirs[path] !== false; },
    // Reassign the whole map (not mutate a key) so the fileRows getter re-runs reliably even the
    // first time a folder path is toggled (the key didn't exist yet).
    toggleDir(path) { this.expandedDirs = { ...this.expandedDirs, [path]: !this.isDirExpanded(path) }; },
    get hasFolders() { return (this.files || []).some(f => (f.rel_dir || '').trim()); },
    get fileRows() {
      const root = { dirs: {}, files: [] };
      for (const f of (this.files || [])) {
        const rel = String(f.rel_dir || '').replace(/^\/+|\/+$/g, '');
        let node = root;
        if (rel) {
          let cum = '';
          for (const seg of rel.split('/')) {
            if (!seg) continue;
            cum = cum ? (cum + '/' + seg) : seg;
            node.dirs[seg] = node.dirs[seg] || { name: seg, path: cum, dirs: {}, files: [] };
            node = node.dirs[seg];
          }
        }
        node.files.push(f);
      }
      const countFiles = (n) => n.files.length + Object.values(n.dirs).reduce((s, d) => s + countFiles(d), 0);
      const rows = [];
      const walk = (node, depth) => {
        Object.keys(node.dirs).sort((a, b) => a.localeCompare(b)).forEach(name => {
          const d = node.dirs[name];
          const expanded = this.isDirExpanded(d.path);
          rows.push({ type: 'dir', key: 'd:' + d.path, name, path: d.path, depth, expanded, count: countFiles(d) });
          if (expanded) walk(d, depth + 1);
        });
        [...node.files].sort((a, b) => (a.name || '').localeCompare(b.name || '')).forEach(f => {
          rows.push({ type: 'file', key: 'f:' + f.id, file: f, depth });
        });
      };
      walk(root, 0);
      return rows;
    },
    rowIndent(depth) { return (8 + (depth || 0) * 14) + 'px'; },

    // ── new file ──────────────────────────────────────────────────────────────
    toggleNewFile(open) {
      if (this.blockedByClosed()) return;
      this.newFileOpen = (open === undefined) ? !this.newFileOpen : !!open;
      this.newFileErr = '';
      if (this.newFileOpen) { this.newFileName = ''; Alpine.nextTick(() => document.getElementById('ideNewName')?.focus()); }
    },
    async createFile() {
      if (this.blockedByClosed()) return;
      const name = (this.newFileName || '').trim();
      if (!name) { this.newFileErr = 'Enter a file name.'; return; }
      this.busy.create = true; this.newFileErr = '';
      try {
        const r = await fetch('/api/deep/new_file', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ session_id: this.sessionId, filename: name }),
        });
        const data = await r.json().catch(() => ({}));
        if (!r.ok || !data.ok) { this.newFileErr = (data && data.error) || 'Could not create file.'; return; }
        this.newFileOpen = false; this.newFileName = '';
        await this.refreshFiles();
        if (data.file && data.file.id) this.openFile(data.file.id);
      } catch (e) { this.newFileErr = 'Network error.'; }
      finally { this.busy.create = false; }
    },

    // ── delete file ───────────────────────────────────────────────────────────
    // The 🗑 button opens an in-page confirm overlay; the actual delete runs on Confirm.
    deleteFile(id, name) {
      if (!id) return;
      if (this.blockedByClosed()) return;
      this.deleteAsk = { open: true, id, name: name || '' };
    },
    cancelDelete() { this.deleteAsk = { open: false, id: null, name: '' }; },
    async confirmDelete() {
      const id = this.deleteAsk.id;
      this.deleteAsk = { open: false, id: null, name: '' };
      if (!id || this.blockedByClosed()) return;   // thread may have closed while the overlay was up
      try {
        const r = await fetch('/api/deep/delete_file', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ file_id: id }),
        });
        const data = await r.json().catch(() => ({}));
        if (!r.ok || !data.ok) { if (!this.noteResponse(data)) showNotification((data && data.error) || 'Delete failed', true); return; }
        if (this.center.fileId === id) {
          this.center = { ...this.center, fileId: null, name: '', editable: false, isImage: false,
                          compilable: false, content: '', viewerHtml: '', error: '' };
          this.run = null; this.outputOpen = false;
        }
        this.refreshFiles();
      } catch (e) { showNotification('Network error', true); }
    },

    async refreshFiles() {
      if (!this.sessionId) { this.files = []; return; }
      try {
        const data = await LT.api.getJson('/api/student/session_files?session_id=' + encodeURIComponent(this.sessionId));
        this.files = data.files || [];
      } catch (e) { console.warn('[ide.files]', e); this.files = []; }
    },

    triggerUpload() { if (this.blockedByClosed()) return; document.getElementById('ideFileInput')?.click(); },
    onFilePicked(e) { const files = Array.from(e.target.files || []); e.target.value = ''; this.uploadFiles(files); },
    // "Upload folder" uses a webkitdirectory input — each picked file carries webkitRelativePath
    // (e.g. "src/app/Main.java"), which _normalizeUploadItems turns into a rel_path for the server.
    triggerFolderUpload() { if (this.blockedByClosed()) return; document.getElementById('ideFolderInput')?.click(); },
    onFolderPicked(e) { const files = Array.from(e.target.files || []); e.target.value = ''; this.uploadFiles(files); },

    // Accepts either bare File objects (flat picker / file drag) or {file, path} descriptors
    // (folder drag, with the path including the folder). Returns a uniform [{file, path}] list.
    _normalizeUploadItems(items) {
      return (items || []).map(it => {
        if (it && it.file) return { file: it.file, path: it.path || it.file.name };
        return { file: it, path: (it && it.webkitRelativePath) || (it && it.name) || '' };
      }).filter(x => x.file);
    },

    // Server-name mirror lives in core/files.js (ONE copy, shared with the chat page):
    // conflict detection and reopen-after-overwrite compare what the server will STORE
    // (secure_filename / _clean_rel_dir), never the raw picker name.
    _secureName(s) { return LT.files.secureName(s); },
    _fileKey(dir, name) { return LT.files.fileKey(dir, name); },
    _uploadDestKey(path, fileName) { return LT.files.destKey(path, fileName); },

    async _uploadBatch(list) {
      let ok = 0; const failed = [];
      for (const { file, path } of list) {
        const fd = new FormData();
        fd.append('file', file);
        // Only send rel_path when it encodes a folder (path differs from the bare name); the
        // server derives rel_dir from it. Flat uploads send no rel_path → root, exactly as before.
        if (path && path !== file.name) fd.append('rel_path', path);
        if (this.assignmentId) fd.append('assignment_id', this.assignmentId);
        fd.append('session_id', this.sessionId);
        try {
          const r = await fetch('/upload', { method: 'POST', body: fd });
          const d = await r.json().catch(() => ({}));
          if (r.ok && d && d.status === 'ok') ok++;
          else failed.push((path || file.name) + (d && d.error ? ' — ' + d.error : ''));
        } catch { failed.push((path || file.name) + ' — network error'); }
      }
      return { ok, failed };
    },

    // Resolves once the user answers the overwrite-confirm overlay: the subset of the
    // passed conflicts the user left CHECKED (→ overwrite), or null on Cancel/Esc
    // (= skip all). Items carry the conflict object itself so no positional index has
    // to stay aligned with the caller's array.
    confirmOverwrite(conflicts) {
      return new Promise((resolve) => {
        // A second batch while the overlay is already open must not strand the first
        // caller's promise — answer it as "skip all" before taking the overlay over.
        if (this._uploadConflictResolve) this._uploadConflictResolve(null);
        this.uploadConflictItems = conflicts.map((c, i) => ({ i, c, label: c.label, checked: true }));
        this.uploadConflictOpen = true;
        this._uploadConflictResolve = resolve;
      });
    },
    resolveUploadConflict(proceed) {
      this.uploadConflictOpen = false;
      const resolve = this._uploadConflictResolve;
      const chosen = proceed ? this.uploadConflictItems.filter(x => x.checked).map(x => x.c) : null;
      this._uploadConflictResolve = null;
      this.uploadConflictItems = [];
      if (resolve) resolve(chosen);
    },

    async uploadFiles(items) {
      const list = this._normalizeUploadItems(items);
      if (!list.length) return;
      if (this.blockedByClosed()) return;    // also covers the drag-drop path
      // Re-pull the list so the duplicate check runs against the server's current state
      // (another tab may have added files). FAIL CLOSED: if we can't see what already
      // exists we must not upload blind — a wrong guess silently overwrites files. (Not
      // refreshFiles(): its error path blanks this.files, which would fail OPEN here.)
      try {
        const data = await LT.api.getJson('/api/student/session_files?session_id=' + encodeURIComponent(this.sessionId));
        this.files = data.files || [];
      } catch (e) {
        this.uploadStatus = { text: '⚠️ Upload cancelled — could not check for existing files. Please try again.', cls: 'warning-text' };
        return;
      }

      // Split off anything that would collide with a file already in this session (same
      // folder + name) so it can't silently replace an existing file without confirmation.
      // Uploaded AND IDE-created files count (the server replaces both on upload — they're
      // one user-source namespace, see _overwrite_origin_filter server-side); generated/run
      // output lives in its own namespace, so a same-named generated file is never at risk.
      const existing = new Set((this.files || [])
        .filter(f => ['upload', 'created'].includes(f.origin || 'upload'))
        .map(f => this._fileKey(f.rel_dir, f.name)));
      const clean = [], conflicts = [];
      for (const it of list) {
        const key = this._uploadDestKey(it.path, it.file.name);
        if (existing.has(key)) conflicts.push({ ...it, key, label: it.path || it.file.name });
        // Batch-internal collisions count too: once the first copy uploads, the second
        // WOULD overwrite it — so the first claims the key and the second must confirm.
        else { clean.push(it); existing.add(key); }
      }

      this.uploadStatus = { text: 'Uploading…', cls: '' };
      let ok = 0; const failed = [];

      // The clean batch and the user's overwrite decision are independent: start those
      // uploads immediately and show the overlay at the same time.
      const cleanDone = clean.length ? this._uploadBatch(clean) : null;
      let overwrite = [], skipped = [];
      if (conflicts.length) {
        const chosen = new Set(await this.confirmOverwrite(conflicts) || []);
        overwrite = conflicts.filter(c => chosen.has(c));
        skipped   = conflicts.filter(c => !chosen.has(c));
      }
      if (cleanDone) { const r = await cleanDone; ok += r.ok; failed.push(...r.failed); }

      // Overwriting replaces the file's DB row (new id): if the open file is among the
      // targets, remember its (folder, name) key so it can be reopened as the new row below.
      let reopenKey = null;
      if (overwrite.length) {
        const openRow = (this.files || []).find(f => f.id === this.center.fileId);
        const openKey = openRow ? this._fileKey(openRow.rel_dir, openRow.name) : null;
        if (openKey && overwrite.some(c => c.key === openKey)) reopenKey = openKey;
        const r = await this._uploadBatch(overwrite);
        ok += r.ok; failed.push(...r.failed);
      }
      failed.push(...skipped.map(c => c.label + ' — skipped (kept existing file)'));

      this.uploadStatus = failed.length
        ? { text: (ok ? '✓ Uploaded ' + ok + '. ' : '') + '⚠️ ' + failed.join('; '), cls: 'warning-text' }
        : { text: '✓ Uploaded ' + ok + ' file(s)', cls: '' };
      await this.refreshFiles();
      if (reopenKey) {
        const again = (this.files || []).find(f => this._fileKey(f.rel_dir, f.name) === reopenKey);
        if (again && again.id !== this.center.fileId) this.openFile(again.id);
      }
    },

    // Recursively collect {file, path} from a dropped FileSystemEntry tree (folders + subfolders).
    // `prefix` is the accumulated folder path; a file becomes prefix+name, a directory recurses
    // under prefix+dirname+'/'. readEntries must be drained in batches until it returns empty.
    _readEntry(entry, prefix) {
      if (!entry) return Promise.resolve([]);
      // Skip hidden files/dirs (.git, .DS_Store, .vscode, …) so a dropped project folder uploads
      // its real source, not its tooling. The server still validates every remaining file's type.
      if (entry.name && entry.name.startsWith('.')) return Promise.resolve([]);
      if (entry.isFile) {
        return new Promise((resolve) => {
          entry.file((file) => resolve([{ file, path: prefix + file.name }]), () => resolve([]));
        });
      }
      if (entry.isDirectory) {
        const reader = entry.createReader();
        const dirPrefix = prefix + entry.name + '/';
        const readBatch = () => new Promise((resolve) => reader.readEntries((b) => resolve(b || []), () => resolve([])));
        return (async () => {
          const children = []; let batch;
          do { batch = await readBatch(); children.push(...batch); } while (batch.length);
          const nested = await Promise.all(children.map((c) => this._readEntry(c, dirPrefix)));
          return nested.flat();
        })();
      }
      return Promise.resolve([]);
    },

    // ── drag & drop onto the file panel ─────────────────────────────────────────────
    // Same convention as the student chat (store('chat').onDrag*): only react to a FILE
    // drag, count enter/leave depth so child elements don't flicker the overlay, and hand
    // the dropped files to the existing uploadFiles() (multi-file + server-validated). A
    // drop with no active session is ignored so we never POST without one. Dropped FOLDERS
    // (and their subfolders) are walked via the webkitGetAsEntry API; browsers without it
    // fall back to the flat file list.
    _isFileDrag(e) { return !!e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files'); },
    onDragEnter(e) { if (!this._isFileDrag(e) || this.sessionClosed) return; e.preventDefault(); this._dragDepth++; this.dragging = true; },
    onDragOver(e)  { if (!this._isFileDrag(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; },
    onDragLeave()  { this._dragDepth--; if (this._dragDepth <= 0) { this._dragDepth = 0; this.dragging = false; } },
    async onDrop(e) {
      if (!this._isFileDrag(e)) return;
      e.preventDefault(); this._dragDepth = 0; this.dragging = false;
      if (!this.sessionId) return;
      const dt = e.dataTransfer;
      // Snapshot the directory entries SYNCHRONOUSLY — the DataTransferItemList is cleared once
      // this handler yields at the first await, so we must grab every entry before then.
      let entries = null;
      const items = dt.items;
      if (items && items.length && typeof items[0].webkitGetAsEntry === 'function') {
        entries = [];
        for (let i = 0; i < items.length; i++) { const en = items[i].webkitGetAsEntry(); if (en) entries.push(en); }
      }
      if (entries && entries.length) {
        const collected = (await Promise.all(entries.map((en) => this._readEntry(en, '')))).flat();
        if (collected.length) { this.uploadFiles(collected); return; }
      }
      const files = Array.from(dt.files || []);
      if (files.length) this.uploadFiles(files);
    },

    downloadFile(id) { if (id) window.open(downloadUrl(id), '_blank'); },

    // ── editor binding (set by the x-cm-editor directive) ────────────────────────
    bindEditor(api) { this._cm = api; },
    currentText() { return this._cm ? this._cm.getText() : (this.center.content || ''); },

    // ── center editor / viewer ────────────────────────────────────────────────────
    async openFile(id) {
      if (!id) return;
      this.center = { ...this.center, fileId: id, name: '', language: '', compilable: false,
                      editable: false, isImage: false, imageUrl: '', content: '', viewerHtml: '',
                      loading: true, error: '' };
      this.run = null; this.outputOpen = false; this.stdin = ''; this.saveStatus = ''; this.runStatus = '';
      try {
        const r = await fetch('/api/student/session_file_detail?file_id=' + encodeURIComponent(id));
        const f = await r.json();
        if (f.error) { this.center = { ...this.center, loading: false, error: f.error }; return; }
        const isImage = IMAGE_EXTS.has(fileExt(f.name || ''));
        // Editing is allowed only when the type is editable AND the content loaded cleanly
        // (a too-large/unreadable file is shown read-only, never partially editable).
        const hasErr = !!f.content_error;
        const editable = !!f.editable && !hasErr && !isImage;
        const content = (f.content != null) ? String(f.content) : '';
        let viewerHtml = '';
        if (!editable && !isImage) {
          const note = f.content_error || f.summary || 'No inline preview for this file type. Use Download to view it.';
          viewerHtml = '<div class="ide-empty">' + escapeHtml(note) + '</div>';
        }
        this._savedContent = content;
        this.center = {
          fileId: id, name: f.name || 'File', language: f.language || '',
          compilable: !!f.compilable, editable, isImage, imageUrl: isImage ? downloadUrl(id) : '',
          content, viewerHtml, loading: false, error: '', reloadSeq: this.center.reloadSeq + 1,
        };
        if (f.last_run) this.run = f.last_run;
        // Restore the persisted stdin for this file (permanent across reloads/switches). Only
        // fall back to an analysis-suggested input when nothing was saved. Setting this.stdin
        // directly (not via syncStdin) so loading never triggers a save.
        this.stdin = (f.stdin != null) ? String(f.stdin) : '';
        if (!this.stdin) {
          const sug = (f.last_analysis && (f.last_analysis.safe_stdin || f.last_analysis.suggested_stdin)) || '';
          if (f.last_analysis && f.last_analysis.needs_stdin && sug) this.stdin = sug;
        }
        if (editable) Alpine.nextTick(() => { try { this._cm && this._cm.focus(); } catch {} });
      } catch (e) {
        this.center = { ...this.center, loading: false, error: 'Could not load this file.' };
      }
    },

    // ── rename the open file (click its name in the editor header) ──────────────
    startRename() {
      if (!this.center.fileId) return;
      if (this.blockedByClosed()) return;
      this.renameValue = this.center.name || '';
      this.renameErr = '';
      this.renaming = true;
      Alpine.nextTick(() => {
        const el = document.getElementById('ideRenameInput');
        if (!el) return;
        el.focus();
        const dot = el.value.lastIndexOf('.');          // select the stem, keep the extension
        try { el.setSelectionRange(0, dot > 0 ? dot : el.value.length); } catch (e) {}
      });
    },
    cancelRename() { this.renaming = false; this.renameErr = ''; },
    async commitRename() {
      if (!this.renaming) return;                        // guards the blur that follows enter/escape
      const name = (this.renameValue || '').trim();
      if (!name || name === this.center.name) { this.cancelRename(); return; }
      this.renameErr = '';
      try {
        const r = await fetch('/api/deep/rename_file', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ file_id: this.center.fileId, filename: name }),
        });
        const d = await r.json().catch(() => ({}));
        if (!r.ok || !d.ok) { this.noteResponse(d); this.renameErr = (d && d.error) || 'Could not rename the file.'; return; }
        const f = d.file || {};
        const langChanged = (f.language || '') !== this.center.language;
        this.center = { ...this.center,
          name: f.name || name, language: f.language || '',
          compilable: !!f.compilable, editable: !!f.editable,
          // if the extension changed, reload the doc (same text) so highlighting follows
          ...(langChanged ? { content: this.currentText(), reloadSeq: this.center.reloadSeq + 1 } : {}) };
        this.renaming = false;
        this.refreshFiles();
      } catch (e) {
        this.renameErr = 'Network error — please try again.';
      }
    },

    async save() {
      if (!this.center.editable || !this.center.fileId) return false;
      if (this.sessionClosed) { this.saveStatus = '🔒 View only'; return false; }
      this.busy.save = true; this.saveStatus = 'Saving…';
      const content = this.currentText();
      try {
        const r = await fetch('/api/student/session_file_content', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ file_id: this.center.fileId, content }),
        });
        const data = await r.json().catch(() => ({}));
        if (!r.ok || (data && data.error)) { this.noteResponse(data); this.saveStatus = '✖ ' + ((data && data.error) || 'Save failed'); return false; }
        this.saveStatus = '✓ Saved';
        this._savedContent = content;
        this.refreshFiles();
        return true;
      } catch (e) { this.saveStatus = '✖ Save failed'; return false; }
      finally { this.busy.save = false; }
    },

    // ── stdin composer (value-by-value overlay) ────────────────────────────────
    openStdinEditor() {
      if (this.blockedByClosed()) return;
      const parts = (this.stdin || '').length ? this.stdin.split('\n') : [''];
      this.stdinLines = parts.map(v => ({ id: ++this.stdinSeq, v }));
      this.stdinOpen = true;
    },
    syncStdin() { this.stdin = this.stdinLines.map(l => l.v).join('\n'); this.scheduleStdinSave(); },
    // Persist stdin per file so the student's inputs are permanent (survive reloads / file
    // switches / reopening). Debounced; the fileId+value are captured so a later file switch
    // can't misroute a pending save.
    scheduleStdinSave() {
      const fid = this.center.fileId, val = this.stdin;
      if (!fid) return;
      clearTimeout(this._stdinSaveTimer);
      this._stdinSaveTimer = setTimeout(() => this._postStdin(fid, val), 400);
    },
    flushStdinSave() {
      clearTimeout(this._stdinSaveTimer);
      if (this.center.fileId) this._postStdin(this.center.fileId, this.stdin);
    },
    _postStdin(fileId, stdin) {
      if (!fileId || this.sessionClosed) return;
      fetch('/api/deep/save_stdin', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file_id: fileId, stdin: (stdin || '').slice(0, 65536) }),
      }).catch(() => {});
    },
    addStdinLine(afterId) {
      const row = { id: ++this.stdinSeq, v: '' };
      const i = this.stdinLines.findIndex(l => l.id === afterId);
      if (i >= 0) this.stdinLines.splice(i + 1, 0, row); else this.stdinLines.push(row);
      this.syncStdin();
      Alpine.nextTick(() => document.getElementById('stdin-row-' + row.id)?.focus());
    },
    removeStdinLine(id) {
      this.stdinLines = this.stdinLines.filter(l => l.id !== id);
      if (!this.stdinLines.length) this.stdinLines = [{ id: ++this.stdinSeq, v: '' }];
      this.syncStdin();
    },
    clearStdinLines() { this.stdinLines = [{ id: ++this.stdinSeq, v: '' }]; this.syncStdin(); },
    closeStdinEditor() { this.syncStdin(); this.flushStdinSave(); this.stdinOpen = false; },

    // AI-generate (or adjust) the program's stdin by reading the code. Used by the Generate
    // button and by runFile()'s auto-prepare. Returns true if it set a non-empty input.
    async generateStdin(opts = {}) {
      if (!this.center.fileId || !this.center.compilable || this.generating) return false;
      if (this.blockedByClosed(opts.silent)) return false;
      this.generating = true;
      try {
        const r = await fetch('/api/deep/suggest_stdin', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ file_id: this.center.fileId, current_stdin: this.stdin }),
        });
        const d = await r.json().catch(() => ({}));
        if (!r.ok || !d.ok) { if (!opts.silent) showNotification((d && d.error) || 'Could not generate input', true); return false; }
        this.stdin = d.stdin || '';
        // rebuild composer rows from the new stdin and persist it
        const parts = this.stdin.length ? this.stdin.split('\n') : [''];
        this.stdinLines = parts.map(v => ({ id: ++this.stdinSeq, v }));
        this.flushStdinSave();
        return !!this.stdin.trim();
      } catch (e) {
        if (!opts.silent) showNotification('Network error generating input', true);
        return false;
      } finally { this.generating = false; }
    },

    // NOTE: named runFile() (not run()) to avoid colliding with the `run` state property
    // above — a duplicate key in the store literal would shadow one of them.
    async runFile() {
      if (!this.center.compilable || !this.center.fileId) return;
      if (this.blockedByClosed()) return;
      // Action feed: a short what's-happening line in the chat for the whole run,
      // updated per phase, removed when the result message lands.
      const act = this.startAction('▶ Compiling & running ' + (this.center.name || 'your file') + '…');
      // Run reflects what's on screen: persist edits first (and bail if the save fails).
      if (this.center.editable && this.currentText() !== this._savedContent) {
        this.updateAction(act, '💾 Saving your edits…');
        const ok = await this.save();
        if (ok === false) { this.endAction(act); return; }
        this.updateAction(act, '▶ Compiling & running ' + (this.center.name || 'your file') + '…');
      }
      // Auto-prepare input: if enabled and the program reads stdin but none is set yet, ask the
      // LLM to fill it in first — so a program that needs input doesn't just fail on empty stdin.
      // Only fires when stdin is EMPTY (we never silently overwrite a student's deliberate input;
      // the explicit "Generate" button validates/adjusts existing input on demand).
      if (this.autoStdin && !this.stdin.trim() && codeReadsStdin(this.currentText())) {
        this.busy.run = true; this.runStatus = 'Preparing input…';
        this.updateAction(act, '⌨ Preparing sample program input…');
        const filled = await this.generateStdin({ silent: true });
        if (filled) showNotification('AI added sample input to run your program');
        this.updateAction(act, '▶ Compiling & running ' + (this.center.name || 'your file') + '…');
      }
      this.busy.run = true; this.runStatus = 'Running…';
      let result;
      try {
        const r = await fetch('/api/deep/run_file', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ file_id: this.center.fileId, stdin: this.stdin, tz: ((Intl.DateTimeFormat().resolvedOptions() || {}).timeZone || '') }),
        });
        result = await r.json().catch(() => ({}));
        // Always surface SOMETHING in the output panel — even on a non-200 (gate/rate-limit/
        // server error) — so the result is never silently swallowed.
        if (!r.ok) {
          this.busy.run = false; this.runStatus = ''; this.endAction(act);
          this.noteResponse(result);
          this.showRun({ ok: false, output: (result && (result.error || result.reason)) || ('Run failed (HTTP ' + r.status + ')') });
          return;
        }
      } catch (e) {
        this.busy.run = false; this.runStatus = ''; this.endAction(act);
        this.showRun({ ok: false, output: 'Network error while running. Please try again.' });
        return;
      }
      this.busy.run = false; this.runStatus = ''; this.endAction(act);
      if (result.error) { this.showRun({ ok: false, output: result.error }); return; }
      // The SERVER generated input for this run (the project reads stdin — often in a
      // helper file the client-side heuristic above can't see — and none was set).
      // Mirror it into the composer so the student sees what ran and the next run
      // reuses it; the server already persisted it as this file's saved input.
      if (result.stdin_generated && result.stdin_used) {
        this.stdin = result.stdin_used;
        const parts = this.stdin.split('\n');
        this.stdinLines = parts.map(v => ({ id: ++this.stdinSeq, v }));
        showNotification('Sample input was added to run your program');
      }
      this.showRun(result);
      this._savedContent = this.currentText();
      this.applyDiagnostics(result);
      this.refreshFiles();
      this.feedRunToChat(result);
      // Auto-repair rewrote the file on disk (corrected + annotated, original lines kept as
      // comments). Reload it so the editor and a download match what actually ran; openFile
      // restores this.run from the persisted last_run (which still carries the diff).
      if (result.auto_repaired) this.openFile(this.center.fileId);
    },

    // Map compiler stderr onto editor markers (authoritative diagnostics; no language server).
    applyDiagnostics(result) {
      if (!this._cm || typeof parseCompilerDiagnostics !== 'function') return;
      const stderr = result.stderr || (result.ok ? '' : (result.output || ''));
      const parsed = parseCompilerDiagnostics(stderr, this.center.language);
      const doc = this._cm.view.state.doc;
      const diags = [];
      for (const d of parsed) {
        const ln = Math.min(Math.max(d.line || 1, 1), doc.lines);
        const line = doc.line(ln);
        const from = line.from + Math.min(Math.max((d.col || 1) - 1, 0), line.length);
        diags.push({ from, to: line.to, severity: d.severity === 'warning' ? 'warning' : (d.severity === 'info' ? 'info' : 'error'), message: d.message || 'Error' });
      }
      this._cm.setDiagnostics(diags);
    },

    // A FRESH run result lands here: store it and auto-open the overlay. (openFile's
    // last_run restore assigns this.run directly — a restore must not pop the overlay.)
    showRun(result) {
      this.run = result;
      this.outputOpen = true;
    },

    copyOutput() {
      const text = this.runText();
      if (!text) return;
      navigator.clipboard.writeText(text).then(
        () => showNotification('Output copied'),
        () => showNotification('Could not copy to clipboard', true));
    },

    runText() {
      const r = this.run; if (!r) return '';
      if (r.security_rejected) return '⛔ Not executed (flagged for safety).\n\n' + (r.analysis || '');
      const ec = (r.exit_code !== null && r.exit_code !== undefined) ? (' (exit ' + r.exit_code + ')') : '';
      const status = (r.ok ? '✓ success' : '✗ failed') + ec;
      const out = r.output || r.stdout || (r.ok ? 'No output.' : (r.stderr || 'Compilation failed.'));
      return status + '\n\n' + out;
    },

    // Push the run result into the chat and ask the tutor to analyze it (hints-first).
    // `question` overrides the default analysis prompt (used by applyFix for post-fix runs).
    feedRunToChat(result, question) {
      if (result.security_rejected) {
        this.pushAssistant('⚠️ Your code was not executed — it was analyzed for safety instead.', {});
        if (result.analysis) this.pushAssistant(result.analysis, {});
        return;
      }
      const status = result.ok ? 'succeeded' : ('failed (' + (result.phase || 'error') + ')');
      const out = result.output || result.stdout || (result.ok ? 'No output.' : (result.stderr || 'Compilation failed.'));
      this.pushAssistant('▶ Compilation ' + status + ':\n\n```\n' + out + '\n```', {});
      // Auto-repair happened: show what changed as a chat card (the output strip is
      // height-capped, so the colored diff lives in the thread where it can scroll).
      if (result.auto_repaired && Array.isArray(result.auto_repair_diff) && result.auto_repair_diff.length
          && typeof autoRepairDiffHtml === 'function') {
        const dm = this.pushAssistant('', {});
        dm.html = autoRepairDiffHtml(result.auto_repair_diff);
      }
      this.thinking = true;
      // Host-environment failures (server backend/toolchain/sandbox, or interactive
      // input the server couldn't emulate) are NOT the student's bug: ask the tutor
      // to analyze the code itself and point to running it locally instead.
      const q = question || (result.ok
        ? 'The code compiled and ran. Please analyze the output and explain what it means.'
        : (result.host_env
            ? 'The server could not run this program because of its own environment. Please analyze my code directly instead — check the logic against the assignment and predict what it would print for the intended input — and remind me how to run it on my own machine.'
            : 'The compilation or run failed. Please help me understand the errors and how to fix them (hints first).'));
      LT.api.postJson('/ask', {
        question: q, session_id: this.sessionId, assignment_id: this.assignmentId,
        mode: 'deep_coding', language: result.language || this.center.language || '',
        code: (this.center.editable ? this.currentText() : null),
        compilation_result: { ok: result.ok, language: result.language, output: result.output,
                              stdout: result.stdout, stderr: result.stderr, exit_code: result.exit_code, phase: result.phase,
                              host_env: result.host_env || '' },
      })
        .then(d => {
          this.thinking = false;
          const m = this.pushAssistant(d.answer || '', { failed: !!d.failed, taskId: d.task_id });
          this.attachEdits(m, d.answer);
        })
        .catch(e => { this.thinking = false; console.error('[ide.feedRunToChat]', e); });
    },
  });
});
