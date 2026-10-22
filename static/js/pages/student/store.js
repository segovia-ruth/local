/*
 * student/store.js — Alpine `chat` store for the student page.
 *
 * Full rewrite of the former app.js / files.js / compile.js / filemodal.js / anon.js
 * onto reactive state. The chat thread is a reactive `messages[]` array rendered with
 * <template x-for> in student.html; projects/threads/session-files/pending-files are
 * reactive lists; the file modal and orphan-title editor are reactive UI state.
 *
 * render.js (pure markdown→HTML helpers) is reused as-is via the x-rich directive.
 * Every backend endpoint, payload, and method is preserved byte-for-byte.
 */

// Global shim: option links rendered by render.js's wireOptionLinks call sendMessage().
function sendMessage(optionText) { try { Alpine.store('chat').send(optionText || null); } catch {} }

document.addEventListener('alpine:init', () => {
  // Any file type may be uploaded (with or without an extension); the server validates
  // content and size. Only the size pre-check stays client-side for fast feedback.
  const FE_MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10 MB (mirror MAX_UPLOAD_BYTES)

  const humanSize = (b) => b < 1024 ? b + " B" : b < 1048576 ? (b/1024).toFixed(0) + " KB" : (b/1048576).toFixed(1) + " MB";
  const timeAgo   = (iso) => { try { const n = (iso.endsWith("Z")||iso.includes("+")) ? iso : iso+"Z"; const s = Math.floor((Date.now()-new Date(n).getTime())/1000); if (s<60) return "just now"; if (s<3600) return Math.floor(s/60)+"m ago"; if (s<86400) return Math.floor(s/3600)+"h ago"; return Math.floor(s/86400)+"d ago"; } catch { return ""; } };

  Alpine.store('chat', {
    // ── reactive state ──────────────────────────────────────────────────────
    anon: window.ANON || null,
    // Server-chosen thread to auto-open: the one last worked on (resume cookie) or, on a
    // first visit, the newest assignment's most recent session. See loadProjects().
    lastSession: window.LAST_SESSION || null,
    projects: [],
    currentProjectId: null,
    messages: [],
    msgSeq: 0,
    pendingFiles: [],
    pendingFileSeq: 0,
    sessionFiles: [],
    messageText: '',
    uploadStatus: { text: '', cls: '' },
    // duplicate-name overwrite confirm overlay (run at send time on the pending chips,
    // mirroring the Deep Coding IDE): checked = overwrite the server copy, unchecked =
    // chip is dropped and not uploaded. Chat uploads always land in the session root.
    uploadConflictOpen: false,
    uploadConflictItems: [],           // [{i, c, label, checked}] — c is the pending chip
    _uploadConflictResolve: null,
    // Instructor closed this conversation: transcript stays viewable, composer/uploads off.
    sessionClosed: false,
    // One-time chooser: conversation vs Deep Coding for a conversation with no stored mode.
    modeAskOpen: false,
    sidebarCollapsed: false,
    noCourses: false,
    thinking: false,
    thinkTimer: null,
    loadTimer: null,
    // orphan (custom conversation) title editing
    orphanEditing: false,
    orphanInput: '',
    // file modal
    sfOpen: false,
    sf: null,            // detail object for the file open in the modal
    sfStdin: '',
    sfSaveStatus: '',
    sfRunStatus: '',
    sfBusy: { analyze: false, save: false, run: false },
    // inline rename of the file open in the modal (click its name in the header)
    sfRenaming: false,
    sfRenameValue: '',
    sfRenameErr: '',
    // anon top bar
    anonAlias: '',
    // drag-drop
    dragging: false,
    _dragDepth: 0,

    // ── getters ─────────────────────────────────────────────────────────────
    get currentProject() { return this.projects.find(p => p.id === this.currentProjectId) || null; },
    get isAnon() { return !!this.anon; },
    get threads() { return this.currentProject ? (this.currentProject.threads || []) : []; },
    get showThreadBar() { return this.threads.length > 0; },
    get isCustomProject() { const p = this.currentProject; return !!p && p.assignment_id == null; },
    get orphanTitle() { const p = this.currentProject; return (p && p.name) || 'Untitled Conversation'; },
    get showWelcome() { return !this.thinking && !this.messages.some(m => m.kind === 'user' || m.kind === 'assistant'); },
    // Deep Coding button visibility for the current thread. The button is server-gated by
    // the {% if feature_deep_coding %} wrapper (system flag); here we additionally require an
    // open session and, for assignment projects, the per-assignment/course switch. Anon link
    // chats carry the server's full gate verdict in the injected config (deep_ok).
    get canDeepCode() {
      if (this.anon) return !!this.anon.deep_ok && !!this.anon.session_id;
      const p = this.currentProject;
      if (!p || !p.session_id) return false;
      return p.kind === 'assignment' ? !!p.deep_coding_enabled : true;
    },

    // ── init / bootstrap ─────────────────────────────────────────────────────
    init() {
      if (this.anon && this.anon.assignment_id) { this.initAnonProject(); }
      else { this.loadProjects(); }
    },

    initAnonProject() {
      this.projects = [{
        id: this.anon.assignment_id, name: 'Tutoring', class_name: '', class_term: '',
        chatHistory: [], sessionActive: false, assignment_id: this.anon.assignment_id,
        kind: 'assignment', key: this.anon.assignment_id, threads: [], activeSessionId: this.anon.session_id
      }];
      this.switchProject(this.anon.assignment_id);
    },

    async loadProjects() {
      try {
        const [assignData, orphanData] = await Promise.all([
          fetch('/api/student/active_assignments').then(r => r.json()),
          fetch('/api/student/orphan_sessions').then(r => r.json()).catch(() => ({ sessions: [] }))
        ]);
        const assignments = Array.isArray(assignData) ? assignData : (assignData.assignments || []);
        const hasEnrollments = Array.isArray(assignData) ? false : (assignData.has_enrollments === true);
        const orphanSessions = orphanData.sessions || [];

        this.projects = assignments.map(a => ({
          id: a.id, name: a.title, class_name: a.class_name || "", class_term: a.class_term || "",
          chatHistory: [], sessionActive: false, assignment_id: a.id, kind: 'assignment',
          key: a.id, threads: [], activeSessionId: null, deep_coding_enabled: !!a.deep_coding_enabled,
          image_chat_enabled: !!a.image_chat_enabled
        }));
        orphanSessions.forEach(g => this.projects.push({
          id: g.id, name: g.name, class_name: "", class_term: "", chatHistory: [], sessionActive: false,
          assignment_id: null, kind: 'custom', key: g.id, threads: [], activeSessionId: null
        }));

        if (this.projects.length > 0 && !this.currentProjectId) {
          this.switchProject(this.urlProjectId() || this.resumeProjectId() || this.projects[0].id);
        }
        if (this.projects.length === 0) {
          if (hasEnrollments) this.noCourses = true;
          else setTimeout(() => this.refreshSessionFiles(), 600);
        }
      } catch (err) {
        console.error('Failed to load projects:', err);
        this.projects = [];
      }
    },

    // Project requested via /student?assignment=<id> (links from the course page), else null.
    urlProjectId() {
      const a = new URLSearchParams(window.location.search).get('assignment');
      const p = a && this.projects.find(x => x.kind === 'assignment' && String(x.key) === String(a));
      return p ? p.id : null;
    },

    // Resolve which project to open from the server's resume target (the thread last worked
    // on, or the newest assignment's most recent session). Pre-seeds that project's
    // activeSessionId so openThreads() reopens the exact thread; returns the project id to
    // switch to, or null to fall back to projects[0].
    resumeProjectId() {
      const ls = this.lastSession;
      if (!ls) return null;
      const proj = this.projects.find(p =>
        ls.assignment_id
          ? (p.kind === 'assignment' && String(p.key) === String(ls.assignment_id))
          : (ls.group_id ? (p.kind === 'custom' && String(p.key) === String(ls.group_id)) : false)
      );
      if (!proj) return null;
      if (ls.session_id) proj.activeSessionId = ls.session_id;
      return proj.id;
    },

    projectCourseLabel(p) {
      let s = p.class_name || "";
      if (p.class_term) s += (s ? " · " : "") + p.class_term;
      return s;
    },

    // ── project / thread navigation ───────────────────────────────────────────
    async switchProject(projectId) {
      this.saveCurrentChatHistory();
      this.clearPendingFiles();
      this.currentProjectId = projectId;
      try { await this.openThreads(); } catch (e) { console.warn('[switchProject] openThreads error:', e); }
      await this.loadChatHistory();
    },

    async openThreads() {
      const project = this.currentProject;
      if (!project) return;

      // Anon link chats: /api/student/threads and /start_session require login and 401 for an
      // anon visitor (same reason openDeepCoding falls back to window.ANON). The injected anon
      // config IS the authoritative chat, so use its session_id directly and skip those calls —
      // otherwise the reset below nulls out activeSessionId (ids is empty) and the transcript
      // never loads, leaving a blank chat on reopen even though the messages exist server-side.
      if (this.anon && this.anon.session_id) {
        project.activeSessionId = this.anon.session_id;
        project.session_id = this.anon.session_id;
        return;
      }

      if (project.kind === 'assignment') {
        let defaultSid = null;
        try { defaultSid = await this.startStudentSession(); } catch (e) { console.warn('[openThreads] startStudentSession failed:', e); }
        try {
          const data = await LT.api.getJson(`/api/student/threads?assignment_id=${encodeURIComponent(project.key)}`);
          project.threads = data.threads || [];
        } catch (e) { console.error('[openThreads] threads fetch failed:', e); project.threads = []; }
        const ids = project.threads.map(t => t.session_id);
        if (!project.activeSessionId || !ids.includes(project.activeSessionId)) {
          project.activeSessionId = defaultSid || (project.threads.length ? project.threads[project.threads.length - 1].session_id : null);
        }
      } else {
        try {
          const r = await fetch(`/api/student/threads?group_id=${encodeURIComponent(project.key)}`);
          const data = await r.json();
          project.threads = data.threads || [];
        } catch (e) { console.error('[openThreads] custom threads fetch failed:', e); project.threads = []; }
        const ids = project.threads.map(t => t.session_id);
        if (!project.activeSessionId || !ids.includes(project.activeSessionId)) {
          project.activeSessionId = project.threads.length ? project.threads[project.threads.length - 1].session_id : null;
        }
      }
      project.session_id = project.activeSessionId;
    },

    threadLabel(t) { return t.name || ('Session ' + t.number); },
    threadTitle(t) { return t.started_at ? ('Started ' + fmtDateTime(t.started_at)) : ''; },

    async switchThread(sessionId) {
      const project = this.currentProject;
      if (!project || project.activeSessionId === sessionId) return;
      this.saveCurrentChatHistory();
      this.clearPendingFiles();
      project.activeSessionId = sessionId;
      project.session_id = sessionId;
      await this.loadChatHistory();
    },

    async startNewThread() {
      const project = this.currentProject;
      if (!project) return;
      this.saveCurrentChatHistory();
      this.clearPendingFiles();
      const payload = project.kind === 'assignment' ? { assignment_id: project.key } : { group_id: project.key };
      try {
        const r = await fetch('/api/student/new_thread', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
        });
        const data = await r.json();
        if (!r.ok) { console.error('[startNewThread] failed:', data); showNotification(data.error || 'Could not start a new thread'); return; }
        project.threads = data.threads || project.threads;
        project.activeSessionId = data.session_id;
        project.session_id = data.session_id;
        project.chatHistory = [];
        this.messages = [];
        this.refreshSessionFiles();
        this.focusComposer();
        this.maybeRouteMode();   // brand-new thread has no stored mode → ask
      } catch (e) { console.error('[startNewThread] error:', e); }
    },

    async startStudentSession() {
      const project = this.currentProject;
      if (!project) return null;
      if (project.assignment_id == null && project.session_id) { project.sessionActive = true; return project.session_id; }
      const payload = { assignment_id: project.assignment_id ?? null };
      const r = await fetch('/start_session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      let data = null; try { data = await r.json(); } catch {}
      if (!r.ok) { console.error('[startStudentSession] server error:', r.status, data); throw new Error((data && data.error) || 'Failed to start session'); }
      if (data && data.session_id) { project.session_id = data.session_id; project.sessionActive = true; return project.session_id; }
      return null;
    },

    saveCurrentChatHistory() {
      const project = this.currentProject;
      if (!project) return;
      project.chatHistory = this.messages
        .filter(m => m.kind === 'user' || m.kind === 'assistant')
        .map(m => ({ isUser: m.kind === 'user', content: m.content || this.htmlToText(m.html) }));
    },

    async loadChatHistory() {
      this.messages = [];
      this.sessionClosed = false;
      const project = this.currentProject;
      if (!project) return;

      let renderList = (project.chatHistory || []).map(m => ({ role: m.isUser ? 'user' : 'assistant', content: m.content }));
      if (project.session_id) {
        try {
          const data = await LT.api.postJson('/load_messages', { session_id: project.session_id, assignment_id: project.assignment_id ?? null });
          renderList = data.messages || [];
          this.sessionClosed = !!data.closed;
          const ALLOWED = new Set(['user', 'assistant']);
          project.chatHistory = renderList.filter(m => ALLOWED.has(m.role)).map(m => ({ isUser: m.role === 'user', content: m.content, created_at: m.created_at }));
        } catch (e) { console.error('Failed to load messages:', e); }
      } else { console.warn('[loadChatHistory] no session_id on project'); }

      const isRunResult = (c) => (typeof looksLikeRunResult === 'function') && looksLikeRunResult(c);
      renderList.forEach(msg => {
        if (msg.role === 'file') {
          this.messages.push({ id: ++this.msgSeq, kind: 'file', filename: msg.filename || 'file', fileId: msg.file_id || null, compilable: !!msg.compilable });
        } else if (msg.role === 'user' && !isRunResult(msg.content)) {
          this.messages.push({ id: ++this.msgSeq, kind: 'user', content: msg.content, attachments: null, attCount: 0 });
        } else {
          // A "compile & run" turn is stored under the user role but, like the live
          // view, reads as an assistant-side terminal card (renderMessageHtml detects it).
          this.messages.push({ id: ++this.msgSeq, kind: 'assistant', content: msg.content, html: null, failed: false, taskId: null, netError: false, retrying: false, deepHint: null });
        }
      });
      this.scrollEnd();
      this.refreshSessionFiles();
      // Every conversation open funnels through here (initial load, project/thread
      // switch): follow the stored mode default, or ask once when there is none.
      this.maybeRouteMode();
    },

    async addProject() {
      const name = (prompt('Enter project name:') || '').trim();
      if (!name) return;
      const res = await fetch('/api/student/add_project', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
      if (!res.ok) return;
      const data = await res.json();
      const groupId = data.group_id;
      this.projects.push({
        id: groupId, name, class_name: "", class_term: "", chatHistory: [], sessionActive: true,
        assignment_id: null, kind: 'custom', key: groupId, threads: [],
        activeSessionId: data.session_id || null, session_id: data.session_id || null
      });
      this.switchProject(groupId);
    },

    toggleSidebar() { this.sidebarCollapsed = !this.sidebarCollapsed; },

    // Open the Deep Coding IDE for the current thread — same tab: the IDE is this
    // conversation's surface, not a companion window. /deep re-verifies ownership + the
    // module gate server-side and stores deep_coding as this conversation's mode default,
    // so the next open of this conversation routes straight to the IDE.
    openDeepCoding() {
      // For anon link chats the project's session_id may be empty (the threads/start_session
      // endpoints require login, so they 401 for an anon visitor and openThreads can't populate
      // it). Fall back to the injected anon config — the authoritative anon session, exactly as
      // anonSaveAlias() uses it. Logged-in pages have no window.ANON, so they use the project.
      const p = this.currentProject;
      const sid = (this.anon && this.anon.session_id) || (p && p.session_id) || '';
      const aid = (this.anon && this.anon.assignment_id) || (p && p.assignment_id) || null;
      if (!sid) { showNotification('Open a conversation first'); return; }
      const params = new URLSearchParams({ session_id: sid });
      if (aid) params.set('assignment_id', aid);
      window.location.assign('/deep?' + params.toString());
    },

    // ── per-conversation mode default (conversation | deep_coding) ────────────
    // The stored mode of the OPEN conversation: anon chats carry it in the injected
    // config; logged-in threads carry it on their /api/student/threads entry.
    currentMode() {
      if (this.anon) return this.anon.mode || null;
      const p = this.currentProject;
      const sid = p && p.session_id;
      if (!sid) return null;
      const t = (p.threads || []).find(t => t.session_id === sid);
      if (t) return t.mode || null;
      const ls = this.lastSession;
      return (ls && ls.session_id === sid && ls.mode) || null;
    },

    // Called whenever a conversation is opened (initial load, project/thread switch, new
    // thread): follow its stored mode default, or ask once when there is none. Skipped on
    // the mobile shell (no Deep Coding there) and when the module gate denies (canDeepCode)
    // — those simply stay in conversation view without storing anything.
    maybeRouteMode() {
      if (document.body.classList.contains('mobile-chat-page')) return;
      if (!this.canDeepCode) return;
      const mode = this.currentMode();
      if (mode === 'deep_coding') { this.openDeepCoding(); return; }
      if (!mode) this.modeAskOpen = true;
    },

    async chooseMode(mode) {
      this.modeAskOpen = false;
      const p = this.currentProject;
      const sid = (this.anon && this.anon.session_id) || (p && p.session_id) || '';
      if (!sid) return;
      // reflect locally so the chooser doesn't reappear on the next thread switch
      if (this.anon) this.anon.mode = mode;
      else {
        const t = p && (p.threads || []).find(t => t.session_id === sid);
        if (t) t.mode = mode;
        if (this.lastSession && this.lastSession.session_id === sid) this.lastSession.mode = mode;
      }
      if (mode === 'deep_coding') { this.openDeepCoding(); return; } // /deep stores the mode itself
      try { await LT.api.postJson('/api/session_mode', { session_id: sid, mode }); }
      catch (e) { console.warn('[chooseMode] save failed:', e); }
    },

    // ── messages helpers ───────────────────────────────────────────────────────
    htmlToText(html) {
      if (!html) return '';
      const div = document.createElement('div');
      div.innerHTML = sanitizeRichHtml(html);
      return div.textContent || '';
    },
    pushAssistant(raw, opts = {}) {
      const msg = { id: ++this.msgSeq, kind: 'assistant', content: raw || '', html: null, failed: !!opts.failed, taskId: opts.taskId || null, netError: false, retrying: false, deepHint: null };
      this.messages.push(msg);
      const project = this.currentProject;
      if (project && opts.history !== false) { project.chatHistory = project.chatHistory || []; project.chatHistory.push({ isUser: false, content: raw || '' }); }
      this.scrollEnd();
      return msg;
    },
    pushAssistantHtml(html, plainText = '') {
      const msg = { id: ++this.msgSeq, kind: 'assistant', content: plainText || this.htmlToText(html), html, failed: false, taskId: null, netError: false, retrying: false, deepHint: null };
      this.messages.push(msg);
      this.scrollEnd();
      return msg;
    },
    removeMessage(id) { this.messages = this.messages.filter(m => m.id !== id); },
    scrollEnd() {
      Alpine.nextTick(() => {
        const el = document.getElementById('messages');
        if (!el) return;
        const nodes = el.querySelectorAll('.message, .file-marker');
        const last = nodes[nodes.length - 1];
        if (last) last.scrollIntoView({ block: 'start' }); else el.scrollTop = el.scrollHeight;
      });
    },
    focusComposer() { Alpine.nextTick(() => document.getElementById('userInput')?.focus()); },

    // ── composer / thinking indicator ──────────────────────────────────────────
    onComposerKey(e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this.send(); } },
    resizeComposer(ta) { if (!ta) return; ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 160) + 'px'; },

    showThinking() {
      this.hideThinking();
      if (this.sfOpen) { Alpine.store('ui').showLoading(); }
      else { this.thinking = true; this.scrollEnd(); }
      if (this.thinkTimer) clearTimeout(this.thinkTimer);
      this.thinkTimer = setTimeout(() => { this.hideThinking(); this.thinkTimer = null; }, 45000);
    },
    hideThinking() {
      if (this.thinkTimer) { clearTimeout(this.thinkTimer); this.thinkTimer = null; }
      this.thinking = false;
      Alpine.store('ui').hideLoading();
    },

    // ── send ────────────────────────────────────────────────────────────────────
    send(optionText = null) {
      if (this.sessionClosed) { showNotification('This conversation has been closed by the instructor — it is view-only.', true); return; }
      if (!optionText && this.pendingFiles.length > 0) { this.sendWithUploads(); return; }
      const input = optionText || this.messageText;
      if (!input || input.trim() === '') return;
      const project = this.currentProject;
      if (!project) return;

      this.messages.push({ id: ++this.msgSeq, kind: 'user', content: input, attachments: null, attCount: 0 });
      project.chatHistory = project.chatHistory || [];
      project.chatHistory.push({ isUser: true, content: input });
      if (!optionText) this.messageText = '';
      Alpine.nextTick(() => this.resizeComposer(document.getElementById('userInput')));
      this.scrollEnd();
      this.showThinking();

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 60000);
      const body = { question: input, projectId: this.currentProjectId, session_id: project.session_id || '', code: null, language: '', assignment_id: project.assignment_id ?? null };

      fetch('/ask', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: controller.signal })
        .then(async r => {
          if (r.status === 403) {
            // The instructor may have closed the conversation while it was open here.
            const d = await r.json().catch(() => null);
            if (d && d.session_closed) { this.sessionClosed = true; throw Object.assign(new Error(d.error || 'closed'), { sessionClosed: true }); }
          }
          if (!r.ok) throw new Error('Server error: ' + r.status); return r.json();
        })
        .then(data => { this.hideThinking(); this.pushAssistant(data.answer || '', { failed: !!data.failed, taskId: data.task_id }); })
        .catch(err => {
          this.hideThinking(); console.error(err);
          if (err && err.sessionClosed) { this.pushAssistant('🔒 ' + err.message, { history: false }); return; }
          const m = this.pushAssistant('⚠️ There was a network problem sending your message.', { history: false });
          m.netError = true; m.resendInput = input;
        })
        .finally(() => clearTimeout(timeoutId));
    },

    async retryTask(msg) {
      if (msg.retrying) return;
      if (this.sessionClosed) { showNotification('This conversation has been closed by the instructor — it is view-only.', true); return; }
      msg.retrying = true;
      try {
        const res = await fetch(`/api/student/llm_tasks/${msg.taskId}/retry`, { method: 'POST' });
        const data = await res.json();
        if (data.ok) {
          msg.failed = false; msg.html = null; msg.content = data.answer || '';
          const project = this.currentProject;
          if (project && project.chatHistory && project.chatHistory.length) {
            const last = project.chatHistory[project.chatHistory.length - 1];
            if (last && !last.isUser) last.content = data.answer || '';
          }
        } else { alert('Retry failed: ' + (data.error || 'still unavailable') + '. Please try again in a moment.'); }
      } catch { alert('Network error during retry.'); }
      finally { msg.retrying = false; }
    },

    retryNet(msg) { const input = msg.resendInput; this.removeMessage(msg.id); this.send(input); },

    // ── pending files / upload ──────────────────────────────────────────────────
    triggerFileUpload() {
      if (this.sessionClosed) { showNotification('This conversation has been closed by the instructor — it is view-only.', true); return; }
      document.getElementById('fileInput')?.click();
    },
    onFilePicked(e) { this.addPendingFiles(e.target.files); e.target.value = ''; },

    addPendingFiles(fileList) {
      const project = this.currentProject;
      if (!project) { this.uploadStatus = { text: '⚠️ Please open a conversation before adding files.', cls: 'warning-text' }; return; }
      const rejected = [];
      Array.from(fileList || []).forEach(file => {
        if (file.size > FE_MAX_UPLOAD_BYTES) { rejected.push(`${file.name} (over ${humanSize(FE_MAX_UPLOAD_BYTES)})`); return; }
        if (this.pendingFiles.some(p => p.file.name === file.name && p.file.size === file.size)) return;
        this.pendingFiles.push({ id: ++this.pendingFileSeq, file, name: file.name, size: humanSize(file.size) });
      });
      this.uploadStatus = rejected.length ? { text: '⚠️ Skipped: ' + rejected.join(', '), cls: 'warning-text' } : { text: '', cls: '' };
    },
    removePendingFile(id) { this.pendingFiles = this.pendingFiles.filter(p => p.id !== id); },
    clearPendingFiles() { this.pendingFiles = []; },

    uploadOne(file, aid, sid) {
      const fd = new FormData();
      fd.append('file', file);
      if (aid) fd.append('assignment_id', aid);
      if (sid) fd.append('session_id', sid);
      return fetch('/upload', { method: 'POST', body: fd })
        .then(r => r.json().then(data => ({ ok: r.ok, data })))
        .then(({ ok, data }) => ({
          ok: ok && data && data.status === 'ok',
          filename: (data && data.filename) || file.name,
          unique_name: (data && data.unique_name) || null,
          file_id: (data && data.file_id) || null,
          compilable: !!(data && data.compilable),
          language: (data && data.language) || null,
          error: (data && data.error) || (ok ? '' : 'Upload failed')
        }))
        .catch(() => ({ ok: false, filename: file.name, error: 'Network error' }));
    },

    // Resolves once the user answers the overwrite-confirm overlay: the subset of the
    // passed conflicts left CHECKED (→ overwrite), or null on Cancel/Esc (= skip all).
    confirmOverwrite(conflicts) {
      return new Promise((resolve) => {
        // A second send while the overlay is already open must not strand the first
        // caller's promise — answer it as "skip all" before taking the overlay over.
        if (this._uploadConflictResolve) this._uploadConflictResolve(null);
        this.uploadConflictItems = conflicts.map((c, i) => ({ i, c, label: c.name, checked: true }));
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

    // Duplicate-name gate for the pending chips, run at send time BEFORE anything is
    // cleared or uploaded. Skipped duplicates are removed from pendingFiles. Returns
    // false only when the existence check itself failed — FAIL CLOSED: uploading blind
    // could silently replace server files (including Deep Coding created files, which
    // uploads also displace — see _overwrite_origin_filter server-side).
    async _resolveUploadConflicts(sid) {
      if (!this.pendingFiles.length) return true;
      if (!sid) return true;   // brand-new chat: the session doesn't exist yet, nothing to collide with
      let rows;
      try {
        const data = await LT.api.getJson('/api/student/session_files?session_id=' + encodeURIComponent(sid));
        rows = data.files || [];
      } catch (e) {
        this.uploadStatus = { text: '⚠️ Not sent — could not check for existing files. Please try again.', cls: 'warning-text' };
        return false;
      }
      // Uploaded AND IDE-created files count; generated output is a separate namespace.
      const existing = new Set(rows
        .filter(f => ['upload', 'created'].includes(f.origin || 'upload'))
        .map(f => LT.files.fileKey(f.rel_dir, f.name)));
      const clean = [], conflicts = [];
      for (const p of this.pendingFiles) {
        const key = LT.files.destKey('', p.file.name);   // chat uploads land in the root
        if (existing.has(key)) conflicts.push(p);
        else { clean.push(p); existing.add(key); }       // batch-internal duplicates count too
      }
      if (!conflicts.length) return true;
      const chosen = new Set(await this.confirmOverwrite(conflicts) || []);
      const skipped = conflicts.filter(c => !chosen.has(c));
      if (skipped.length) {
        const drop = new Set(skipped.map(s => s.id));
        this.pendingFiles = this.pendingFiles.filter(p => !drop.has(p.id));
        this.uploadStatus = { text: '⚠️ Kept the existing copy of: ' + skipped.map(s => s.name).join(', '), cls: 'warning-text' };
      }
      return true;
    },

    async sendWithUploads() {
      const project = this.currentProject;
      if (!project) return;
      const aid = project.assignment_id || '';
      const sid = project.session_id || '';
      if (!aid && !sid) { this.uploadStatus = { text: '⚠️ Please open a conversation before uploading files.', cls: 'warning-text' }; return; }

      // Duplicate-name gate: may pause on the overwrite overlay and drop skipped chips.
      if (!await this._resolveUploadConflicts(sid)) return;
      if (!this.pendingFiles.length) {
        // Every file was skipped — send any typed text as a normal message.
        if ((this.messageText || '').trim()) this.send();
        return;
      }

      const files = this.pendingFiles.map(p => p.file);
      const typed = (this.messageText || '').trim();
      this.pendingFiles = [];
      this.messageText = '';
      Alpine.nextTick(() => this.resizeComposer(document.getElementById('userInput')));

      const userMsg = { id: ++this.msgSeq, kind: 'user', content: typed, attCount: files.length, attachments: files.map((f, i) => ({ key: 'p' + i, name: f.name, fileId: null })) };
      this.messages.push(userMsg);
      project.chatHistory = project.chatHistory || [];
      project.chatHistory.push({ isUser: true, content: typed || ('Uploaded files: ' + files.map(f => f.name).join(', ')) });
      this.scrollEnd();
      this.showThinking();

      const results = await Promise.all(files.map(f => this.uploadOne(f, aid, sid)));
      const succeeded = results.filter(r => r.ok);
      const uploaded = succeeded.map(r => r.filename);
      const compilableFiles = succeeded.filter(r => r.compilable && r.unique_name);
      const failed = results.filter(r => !r.ok);

      userMsg.attachments = results.map((r, i) => ({ key: 'u' + i, name: r.filename || files[i].name, fileId: r.ok ? r.file_id : null }));
      this.refreshSessionFiles();

      if (uploaded.length === 0) {
        this.hideThinking();
        this.uploadStatus = { text: '✖ Upload failed: ' + failed.map(f => f.filename + (f.error ? ' — ' + f.error : '')).join('; '), cls: 'error-text' };
        return;
      }
      if (failed.length) this.uploadStatus = { text: '⚠️ Some files were not uploaded: ' + failed.map(f => f.filename).join(', '), cls: 'warning-text' };

      // Image uploads ride along explicitly so the server's vision analysis
      // (instructor-gated image chat) targets exactly these files.
      const IMG_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|tiff?)$/i;
      const imageIds = succeeded.filter(r => r.file_id && IMG_EXT_RE.test(r.filename || '')).map(r => r.file_id);
      const body = { question: typed, session_id: sid, assignment_id: aid || null, analyze_uploads: true, filenames: uploaded, code: null, language: '', image_file_ids: imageIds };
      try {
        const r = await fetch('/ask', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        if (!r.ok) throw new Error('Server error: ' + r.status);
        const data = await r.json();
        this.hideThinking();
        const aiMsg = this.pushAssistant(data.answer || '', { failed: !!data.failed, taskId: data.task_id });
        // Uploaded source is never compiled from here (the analysis above explains it and
        // predicts its result instead) — hint at Deep Coding, where compile/run lives.
        // Display is additionally gated in the template (feature flag + canDeepCode).
        if (!data.failed && compilableFiles.length > 0) {
          aiMsg.deepHint = { filename: compilableFiles[0].filename };
        }
      } catch (err) {
        this.hideThinking(); console.error(err);
        this.pushAssistantHtml("Sorry, there was a problem analyzing the uploaded files.");
      }
    },

    // ── compile-result rendering (used by the file window's Run) ────────────────────
    renderCompileResult(result, language, aid, sid) {
      const project = this.currentProject;
      if (result.security_rejected) {
        const reasons = result.reasons || [];
        const reasonsHtml = reasons.length ? `<ul class="compile-security-reasons">${reasons.map(r => `<li>${escapeHtml(r)}</li>`).join('')}</ul>` : '';
        this.pushAssistantHtml(
          `<div class='compile-security-notice'><strong>&#9888; Code not executed — analyzed instead</strong>This code contains patterns that cannot be safely run on the server.${reasonsHtml}</div>`,
          `Code not executed — analyzed instead. This code contains patterns that cannot be safely run on the server.${reasons.length ? ' ' + reasons.join(' ') : ''}`
        );
        if (result.analysis) this.pushAssistant(result.analysis);
        return;
      }
      const icon = result.ok ? '&#10003;' : '&#10007;';
      const status = result.ok ? 'Success' : `Failed (${escapeHtml(result.phase || 'error')})`;
      const rawOut = result.output || (result.ok ? 'No output.' : result.stderr || 'Compilation failed.');
      const supportNote = (result.extra_files_used && result.extra_files_used.length)
        ? `<div style="font-size:11px;color:#6b7280;margin-top:4px;">Supporting files: ${result.extra_files_used.map(f => escapeHtml(f)).join(', ')}</div>` : '';
      const plain = `Compilation ${status}:\n\`\`\`\n${rawOut}\n\`\`\``;
      this.pushAssistantHtml(`<strong>${icon} Compilation ${escapeHtml(status)}</strong>${codeBlockHtml(language, rawOut)}${supportNote}`, plain);
      if (project) { project.chatHistory = project.chatHistory || []; project.chatHistory.push({ isUser: false, content: plain }); }
      this.askCompileAnalysis(result, aid, sid);
    },

    async askCompileAnalysis(result, aid, sid) {
      this.showThinking();
      // Host-environment failures are not the student's bug: the tutor analyzes the
      // code itself and points to running it locally (see the run's Environment note).
      const question = result.ok ? 'The code compiled and ran. Please analyze the output and explain what it means.'
                                 : (result.host_env
                                     ? 'The server could not run this program because of its own environment. Please analyze my code directly instead — check the logic against the assignment and predict what it would print — and remind me how to run it on my own machine.'
                                     : 'The compilation or run failed. Please help me understand the errors and how to fix them.');
      try {
        const askResp = await fetch('/ask', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ question, session_id: sid, assignment_id: aid, compilation_result: { ok: result.ok, language: result.language, output: result.output, stdout: result.stdout, stderr: result.stderr, exit_code: result.exit_code, phase: result.phase, host_env: result.host_env || '' } })
        });
        const askData = await askResp.json();
        this.hideThinking();
        this.pushAssistant(askData.answer || '');
      } catch (e) { this.hideThinking(); console.error(e); this.pushAssistant('Sorry, there was a problem getting the analysis.'); }
    },

    // ── drag & drop ───────────────────────────────────────────────────────────────
    onDragEnter(e) { if (!e.dataTransfer.types.includes('Files')) return; e.preventDefault(); this._dragDepth++; this.dragging = true; },
    onDragOver(e)  { if (!e.dataTransfer.types.includes('Files')) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; },
    onDragLeave()  { this._dragDepth--; if (this._dragDepth <= 0) { this._dragDepth = 0; this.dragging = false; } },
    onDrop(e)      { e.preventDefault(); this._dragDepth = 0; this.dragging = false; const files = e.dataTransfer.files; if (files && files.length) this.addPendingFiles(files); },

    // ── orphan (custom conversation) title ──────────────────────────────────────────
    startEditOrphan() {
      // Closed conversation: the title stays as the instructor last saw it (server rejects it too).
      if (this.sessionClosed) { showNotification('This conversation has been closed by the instructor — it is view-only.', true); return; }
      this.orphanInput = this.orphanTitle; this.orphanEditing = true;
      Alpine.nextTick(() => { const el = document.getElementById('orphanTitleInput'); if (el) { el.focus(); el.select(); } });
    },
    onOrphanKey(e) { if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); } else if (e.key === 'Escape') { e.preventDefault(); this.orphanEditing = false; } },
    async saveOrphan() {
      const newName = (this.orphanInput || '').trim();
      this.orphanEditing = false;
      if (!newName || this.sessionClosed) return;
      const project = this.currentProject;
      if (!project || project.assignment_id != null || !project.key) return;
      if (newName === this.orphanTitle) return;
      try {
        const res = await fetch(`/api/student/orphan_sessions/${project.key}/name`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: newName }) });
        if (res.ok) project.name = newName;
      } catch (e) { console.error('[saveOrphan] failed:', e); }
    },

    // ── session files bar ────────────────────────────────────────────────────────────
    async refreshSessionFiles() {
      const project = this.currentProject;
      const sid = project && project.session_id;
      if (!sid) { this.sessionFiles = []; return; }
      try {
        const data = await LT.api.getJson('/api/student/session_files?session_id=' + encodeURIComponent(sid));
        this.sessionFiles = data.files || [];
      } catch (e) { console.warn('[sessionFiles] load failed', e); this.sessionFiles = []; }
    },
    sessionFileTitle(f) { return f.compilable ? 'Open to analyze, edit, compile & run' : 'Open file'; },
    // Group the session files by their logical folder (rel_dir) so the bar shows a
    // folder/subfolder/file layout. Root files ('') come first, then folders A→Z. On-disk
    // storage is flat; rel_dir is metadata the server returns per file.
    get sessionFileGroups() {
      const groups = {};
      for (const f of (this.sessionFiles || [])) {
        const d = String(f.rel_dir || '').replace(/^\/+|\/+$/g, '');
        (groups[d] = groups[d] || []).push(f);
      }
      return Object.keys(groups)
        .sort((a, b) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b)))
        .map(d => ({ dir: d, files: groups[d] }));
    },

    // ── file modal ─────────────────────────────────────────────────────────────────────
    async openFile(fileId) {
      if (!fileId) return;
      this.sfOpen = true;
      this.sf = null;            // null → loading state in template
      this.sfStdin = '';
      this.sfSaveStatus = '';
      this.sfRunStatus = '';
      try {
        const r = await fetch('/api/student/session_file_detail?file_id=' + encodeURIComponent(fileId));
        const f = await r.json();
        if (f.error) { this.sf = { error: f.error }; return; }
        // suggested stdin (mirrors original behavior: prefilled when analysis says so)
        const sug = f.last_analysis && (f.last_analysis.safe_stdin || f.last_analysis.suggested_stdin) || '';
        if (f.last_analysis && f.last_analysis.needs_stdin && sug) this.sfStdin = sug;
        f._savedContent = f.content;   // baseline so runFile only re-saves real edits
        f.analysisError = null;
        this.sf = f;
      } catch (e) { this.sf = { error: 'Could not load this file.' }; }
    },
    closeFile() { this.sfOpen = false; this.sf = null; this.sfRenaming = false; this.sfRenameErr = ''; },

    // ── rename the file open in the modal (click its name in the header) ──────────────
    startSfRename() {
      const f = this.sf;
      if (!f || f.error || !f.id) return;
      if (this.sessionClosed) { showNotification('This conversation has been closed by the instructor — it is view-only.', true); return; }
      this.sfRenameValue = f.name || '';
      this.sfRenameErr = '';
      this.sfRenaming = true;
      Alpine.nextTick(() => {
        const el = document.getElementById('sfRenameInput');
        if (!el) return;
        el.focus();
        const dot = el.value.lastIndexOf('.');          // select the stem, keep the extension
        try { el.setSelectionRange(0, dot > 0 ? dot : el.value.length); } catch (e) {}
      });
    },
    cancelSfRename() { this.sfRenaming = false; this.sfRenameErr = ''; },
    async commitSfRename() {
      if (!this.sfRenaming || !this.sf) return;            // guards the blur after enter/escape
      const name = (this.sfRenameValue || '').trim();
      if (!name || name === this.sf.name) { this.cancelSfRename(); return; }
      this.sfRenameErr = '';
      try {
        const r = await fetch('/api/student/session_file_rename', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ file_id: this.sf.id, filename: name }),
        });
        const d = await r.json().catch(() => ({}));
        if (!r.ok || !d.ok) { this.sfRenameErr = (d && d.error) || 'Could not rename the file.'; return; }
        const nf = d.file || {};
        this.sf.name = nf.name || name;
        if (nf.language !== undefined)   this.sf.language   = nf.language || '';
        if (nf.compilable !== undefined) this.sf.compilable = !!nf.compilable;
        if (nf.editable !== undefined)   this.sf.editable   = !!nf.editable;
        this.sfRenaming = false;
        this.refreshSessionFiles();
      } catch (e) {
        this.sfRenameErr = 'Network error — please try again.';
      }
    },

    sfMeta(f) {
      const bits = [];
      if (f.size) bits.push(humanSize(f.size));
      if (f.language) bits.push(f.language);
      if (f.last_analysis_at) bits.push('analyzed ' + timeAgo(f.last_analysis_at) + (f.analysis_stale ? ' · code changed' : ''));
      if (f.last_run_at) bits.push('last run ' + timeAgo(f.last_run_at) + (f.run_stale ? ' · code changed' : ''));
      return bits.join('  ·  ');
    },
    sfAnalysisHtml(f) {
      const data = f.last_analysis, stale = f.analysis_stale;
      if (!f.last_analysis) return "<div class='sf-muted'>Not analyzed yet — click Analyze for an explanation of what this code does.</div>";
      if (!data || typeof data !== 'object') return "<div class='sf-muted'>No analysis.</div>";
      let h = '';
      if (stale) h += "<div class='sf-stale'>⚠ Code changed since this analysis — click Re-analyze.</div>";
      if (data.program_description) h += "<p class='sf-desc'>" + escapeHtml(data.program_description) + "</p>";
      if (data.security_notes) h += "<div class='sf-note sf-note-warn'><strong>Safety:</strong> " + escapeHtml(data.security_notes) + "</div>";
      const deps = data.missing_deps || [];
      if (deps.length) h += "<div class='sf-note'><strong>Missing dependencies:</strong> " + deps.map(escapeHtml).join(', ') + "</div>";
      const io = [];
      if (data.reads_files && (data.expected_read_files || []).length) io.push('reads ' + data.expected_read_files.map(escapeHtml).join(', '));
      if (data.writes_files && (data.expected_write_files || []).length) io.push('writes ' + data.expected_write_files.map(escapeHtml).join(', '));
      if (io.length) h += "<div class='sf-note'><strong>Files:</strong> " + io.join(' · ') + "</div>";
      if (data.uses_absolute_paths && data.absolute_path_warning) h += "<div class='sf-note sf-note-warn'>" + escapeHtml(data.absolute_path_warning) + "</div>";
      if (data.needs_stdin) { const sug = data.safe_stdin || data.suggested_stdin || ''; h += "<div class='sf-note'><strong>Reads keyboard input.</strong>" + (sug ? ' A suggested test input has been filled in below.' : '') + "</div>"; }
      return h || "<div class='sf-muted'>Analysis complete.</div>";
    },
    sfRunText(f) {
      const run = f.last_run; if (!run) return '';
      if (run.security_rejected) return '⛔ Not executed (flagged for safety).\n\n' + (run.analysis || '');
      const ec = (run.exit_code !== null && run.exit_code !== undefined) ? (' (exit ' + run.exit_code + ')') : '';
      const status = (run.ok ? '✓ success' : '✗ failed') + ec + (f.run_stale ? '  · code changed since' : '');
      const out = run.output || run.stdout || (run.ok ? 'No output.' : (run.stderr || 'Compilation failed.'));
      return status + '\n\n' + out;
    },

    async analyzeFile() {
      if (!this.sf) return;
      if (this.sessionClosed) { showNotification('This conversation has been closed by the instructor — it is view-only.', true); return; }
      this.sfBusy.analyze = true;
      try {
        const r = await fetch('/api/student/session_file_analyze', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ file_id: this.sf.id }) });
        const data = await r.json();
        if (data.error) { this.sf.analysisError = data.error; return; }
        this.sf.analysisError = null;
        this.sf.last_analysis = data; this.sf.analysis_stale = false;
        const sug = data.safe_stdin || data.suggested_stdin || '';
        if (data.needs_stdin && sug && !this.sfStdin.trim()) this.sfStdin = sug;
        this.refreshSessionFiles();
      } catch (e) { this.sf.analysisError = 'Analysis failed. Please try again.'; }
      finally { this.sfBusy.analyze = false; }
    },

    async saveFile() {
      if (!this.sf) return;
      if (this.sessionClosed) { showNotification('This conversation has been closed by the instructor — it is view-only.', true); return; }
      this.sfBusy.save = true; this.sfSaveStatus = 'Saving…';
      try {
        const r = await fetch('/api/student/session_file_content', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ file_id: this.sf.id, content: this.sf.content }) });
        const data = await r.json();
        if (data.error) { this.sfSaveStatus = '✖ ' + data.error; return; }
        this.sfSaveStatus = '✓ Saved';
        this.sf._savedContent = this.sf.content;
        this.sf.analysis_stale = true; this.sf.run_stale = true;
        this.refreshSessionFiles();
      } catch (e) { this.sfSaveStatus = '✖ Save failed'; }
      finally { this.sfBusy.save = false; }
    },

    async runFile() {
      if (!this.sf) return;
      if (this.sessionClosed) { showNotification('This conversation has been closed by the instructor — it is view-only.', true); return; }
      // Persist in-editor changes first (only when content actually changed isn't tracked here;
      // we save whenever editable to mirror "the run reflects what's on screen").
      if (this.sf.editable && !this.sf.content_error && this.sf._savedContent !== this.sf.content) {
        await this.saveFile();
      }
      this.sfBusy.run = true; this.sfRunStatus = 'Running…';
      let result;
      try {
        const r = await fetch('/api/student/session_file_run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ file_id: this.sf.id, stdin: this.sfStdin }) });
        result = await r.json();
      } catch (e) { this.sfRunStatus = '✖ Network error'; this.sfBusy.run = false; return; }
      this.sfBusy.run = false;
      if (result.error) { this.sfRunStatus = '✖ ' + result.error; return; }
      this.sfRunStatus = '';
      // The server generated input for this run (program reads stdin, none was set) —
      // mirror it into the input box so the student sees what ran and can adjust it.
      // The run output itself carries an "Input note" explaining the values used.
      if (result.stdin_generated && result.stdin_used) this.sfStdin = result.stdin_used;
      this.sf.last_run = result; this.sf.run_stale = false;
      this.sf._savedContent = this.sf.content;
      this.refreshSessionFiles();
      this.appendCompileResultToChat(result);
      // Auto-repair rewrote the file on disk (corrected + annotated, original lines kept as
      // comments). Reload it so the editor, the saved baseline, and a download all match what
      // ran — and the user can't accidentally save the stale pre-fix version back. openFile
      // restores last_run (with the diff); preserve the stdin box across the reload.
      if (result.auto_repaired) { const _stdin = this.sfStdin; await this.openFile(this.sf.id); this.sfStdin = _stdin; }
    },

    downloadFile() { if (this.sf) window.open('/api/student/session_file_download?file_id=' + encodeURIComponent(this.sf.id), '_blank'); },

    appendCompileResultToChat(result) {
      const project = this.currentProject;
      const sid = (project && project.session_id) || '';
      const aid = (project && project.assignment_id) || null;
      const language = result.language || 'code';
      this.renderCompileResult(result, language, aid, sid);
    },

    // ── "I'm still stuck" escalation ──────────────────────────────────────────────────
    // Works for logged-in AND anonymous chats: flags this thread for the instructor
    // (badge + top of their audit list) with an optional note in the student's words.
    // The graceful hand-off when the AI tutor isn't enough — never a silent dead end.
    helpFlagged: false,
    helpOpen: false,
    helpNote: '',
    helpBusy: false,
    flagHelp() {
      const sid = (this.anon && this.anon.session_id)
        || (this.currentProject && this.currentProject.activeSessionId);
      if (!sid) { showNotification('Open a chat first', true); return; }
      this.helpNote = '';
      this.helpOpen = true;
      Alpine.nextTick(() => document.getElementById('helpFlagNote')?.focus());
    },
    closeHelpFlag() { this.helpOpen = false; },
    async submitHelpFlag() {
      if (this.helpBusy) return;
      const sid = (this.anon && this.anon.session_id)
        || (this.currentProject && this.currentProject.activeSessionId);
      if (!sid) { this.helpOpen = false; showNotification('Open a chat first', true); return; }
      this.helpBusy = true;
      try {
        const r = await fetch('/api/student/flag_help', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ session_id: sid, note: (this.helpNote || '').trim() }),
        });
        const d = await r.json().catch(() => ({}));
        if (r.ok && d.ok) {
          this.helpFlagged = true;
          this.helpOpen = false;
          showNotification('Flagged for your instructor — they can see this chat and everything you tried.');
        } else showNotification(d.error || 'Could not flag this chat', true);
      } catch { showNotification('Network error', true); }
      finally { this.helpBusy = false; }
    },

    // ── anonymous top bar ─────────────────────────────────────────────────────────────
    anonCopyLink() {
      const url = this.anon.share_url;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(url).then(() => showNotification('Chat link copied'), () => window.prompt('Copy this chat link:', url));
      } else { window.prompt('Copy this chat link:', url); }
    },
    async anonSaveAlias() {
      if (this.sessionClosed) return;   // frozen chat — the server rejects the rename too
      const alias = (this.anonAlias || '').trim();
      try { await fetch(`/t/${encodeURIComponent(this.anon.slug)}/alias`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ alias, session_id: this.anon.session_id }) }); } catch {}
    },
    anonBookmark() {
      const slug = encodeURIComponent(this.anon.slug), token = encodeURIComponent(this.anon.token);
      const relUrl = `/t/${slug}/chat?id=${token}`;
      const absUrl = this.anon.share_url || (location.origin + relUrl);
      const title = document.title || 'LeafTutor tutoring chat';
      try { history.replaceState(null, '', relUrl); } catch {}
      try {
        if (window.external && typeof window.external.AddFavorite === 'function') { window.external.AddFavorite(absUrl, title); return; }
        if (window.sidebar && typeof window.sidebar.addPanel === 'function') { window.sidebar.addPanel(title, absUrl, ''); return; }
      } catch {}
      const mac = /Mac|iPhone|iPad|iPod/.test(navigator.platform || '');
      showNotification((mac ? 'Press ⌘D' : 'Press Ctrl+D') + ' to add this chat to your favourites');
    },
    async anonNewChat() {
      if (this.anon && this.anon.view_only) { showNotification('This link is view-only — new chats cannot be started.', true); return; }
      try {
        const r = await fetch(`/t/${encodeURIComponent(this.anon.slug)}/new`, { method: 'POST' });
        const d = await r.json();
        if (r.ok && d.path) window.location = d.path;
        else showNotification(d.error || 'Could not start a new chat', true);
      } catch (e) { showNotification('Network error', true); }
    },
  });
});
