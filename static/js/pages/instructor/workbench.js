/* Generate Hints workbench (/instructor/compile_workbench) — Alpine store `wb`.
 *
 * The page is a preparation surface for ONE assignment: file include/exclude on top,
 * preset actions + editable module fields on the left, the preparation chat on the
 * right. The chat is EPHEMERAL by design — the durable artifacts are the saved fields
 * (source_files/context_files, remarks, commands, sim_stdin, context_summary) and the
 * run results; "Summarize context" distills the chat into the stored summary.
 *
 * Every preset action reports into the chat as an assistant message, optionally with
 * clickable suggestions (next actions) and follow-up questions (decisions), so the
 * instructor can drive the whole preparation from the chat column.
 */
document.addEventListener('alpine:init', () => {
  const AID = (window.WB || {}).assignmentId || '';

  const post = (url, body) => fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ assignment_id: AID, ...body }),
  }).then(async r => ({ ok: r.ok, status: r.status, d: await r.json().catch(() => ({})) }));

  Alpine.store('wb', {
    files: [], others: [], descriptions: [], hints: [],
    remarks: '', commands: '', simStdin: '', summary: '', summaryAt: null,
    verified: null, presumed: null, runResult: null,
    busy: false, status: '',
    chat: [], chatInput: '', chatBusy: false,
    _loadedSummary: '',
    _pollTimer: null,

    async init() {
      await this.load(true);
    },

    // ── state <-> server ────────────────────────────────────────────────────────
    async load(fillEditors) {
      try {
        const r = await fetch(`/api/instructor/compile_profile?assignment_id=${encodeURIComponent(AID)}`);
        const d = await r.json();
        if (d.error) { this.status = d.error; return null; }
        this.applyPayload(d, fillEditors);
        return d;
      } catch (e) { this.status = 'Load failed'; return null; }
    },
    applyPayload(d, fillEditors) {
      this.files = d.files || [];
      this.others = d.others || [];
      this.descriptions = d.descriptions || [];
      this.hints = d.hints || [];
      const p = d.profile || {};
      this.verified = p.verified_output || null;
      this.presumed = p.presumed_output || null;
      if (fillEditors) {
        this.remarks = p.remarks || '';
        this.commands = (p.commands || []).join('\n');
        this.simStdin = p.sim_stdin || '';
        this.summary = p.context_summary || '';
        this._loadedSummary = this.summary;
        this.summaryAt = p.context_summary_at || null;
      }
    },
    saveBody() {
      const body = {
        source_files: this.files.filter(f => f.included).map(f => f.canonical),
        context_files: this.others.filter(f => f.included).map(f => f.canonical),
        remarks: this.remarks || '',
        commands_text: this.commands || '',
        sim_stdin: this.simStdin || '',
      };
      // context_summary uses present-only semantics server-side: only send it when the
      // instructor actually edited it, so a plain Save never bumps its timestamp.
      if (this.summary !== this._loadedSummary) body.context_summary = this.summary || '';
      return body;
    },
    async save(silent) {
      this.status = 'Saving…';
      const { ok, d } = await post('/api/instructor/compile_profile/save', this.saveBody());
      if (!ok || d.error) {
        this.status = d.error || 'Save failed';
        if (!silent) showNotification(this.status, true);
        return false;
      }
      this.applyPayload(d, false);
      const p = d.profile || {};
      this._loadedSummary = p.context_summary || '';
      this.summaryAt = p.context_summary_at || this.summaryAt;
      this.status = 'Saved ✓';
      setTimeout(() => { if (this.status === 'Saved ✓') this.status = ''; }, 2000);
      return true;
    },

    // ── file list ───────────────────────────────────────────────────────────────
    toggleFile(f) { f.included = !f.included; },
    // Files the reference run WROTE (e.g. data_out.txt) — fresh run first, else the
    // stored verified reference. Shown under the Result panel.
    resultFiles() {
      const r = this.runResult;
      if (r && (r.written_files || []).length) return r.written_files;
      return (this.verified && this.verified.written_files) || [];
    },
    allDescriptions() {
      const out = [];
      for (const d of this.descriptions) if (d.analyzed || d.text) out.push(d);
      for (const f of this.others) if (f.included && f.summary)
        out.push({ name: f.canonical, kind: f.kind, text: f.summary });
      return out;
    },

    // ── chat plumbing ───────────────────────────────────────────────────────────
    pushUser(text) { this.chat.push({ role: 'user', text }); this.scrollChat(); },
    pushAssistant(text, extra) {
      const m = { role: 'assistant', text, ...(extra || {}) };
      this.chat.push(m); this.scrollChat();
      return m;
    },
    scrollChat() {
      Alpine.nextTick(() => {
        const el = document.getElementById('wbChatMsgs');
        if (el) el.scrollTop = el.scrollHeight;
      });
    },
    transcriptTail() {
      return this.chat.slice(-12).map(m => ({ role: m.role, text: (m.text || '').slice(0, 600) }));
    },
    async sendChat(prefill) {
      const msg = (prefill != null ? prefill : this.chatInput).trim();
      if (!msg || this.chatBusy) return;
      if (prefill == null) this.chatInput = '';
      const tail = this.transcriptTail();          // BEFORE pushing, so the server gets history + message once
      this.pushUser(msg);
      this.chatBusy = true;
      try {
        const { ok, d } = await post('/api/instructor/compile_profile/chat',
                                     { message: msg, transcript: tail });
        if (!ok || d.error) { this.pushAssistant('⚠ ' + (d.error || 'The assistant is unavailable right now.')); return; }
        this.pushAssistant(d.reply || '(no reply)', { followups: (d.followups || []) });
      } catch (e) {
        this.pushAssistant('⚠ Network error — please try again.');
      } finally { this.chatBusy = false; }
    },
    // A follow-up answered by click: LLM follow-ups go back through the chat; action
    // follow-ups (client-made, e.g. "accept this input") run their handler directly.
    answerFollowup(m, fu, opt) {
      fu.answered = true;
      if (fu.onPick) { fu.onPick.call(this, opt); return; }
      this.sendChat(`${fu.question} — ${opt}`);
    },
    runSuggestion(s) {
      if (typeof this[s.action] === 'function') this[s.action]();
    },

    // ── preset actions (each reports into the chat) ────────────────────────────
    async analyze() {
      if (this.busy) return;
      if (!await this.save(true)) return;
      this.busy = true; this.status = 'Analyzing files…';
      try {
        const { ok, d } = await post('/api/instructor/compile_profile/analyze', {});
        if (!ok || d.error) { this.status = d.error || 'Analyze failed'; return; }
        this.pollAnalyze(40);
      } catch (e) { this.busy = false; this.status = 'Analyze failed'; }
    },
    pollAnalyze(left) {
      clearTimeout(this._pollTimer);
      this._pollTimer = setTimeout(async () => {
        const d = await this.load(false);
        const st = (d && d.analyze) || {};
        if (st.running && left > 0) {
          this.status = `Analyzing… ${st.done || 0}/${st.total || '?'}`;
          this.pollAnalyze(left - 1);
          return;
        }
        this.busy = false;
        if (st.error) { this.status = 'Analyze failed: ' + st.error; showNotification(this.status, true); return; }
        this.status = '';
        const n = this.allDescriptions().length;
        this.pushAssistant(
          `Analyzed the included files — ${n} description${n === 1 ? '' : 's'} are in the panel on the left.`,
          { suggestions: [{ label: '≡ Generate compile commands', action: 'genCommands' },
                          { label: '▶ Compile now', action: 'compile' }] });
      }, 2500);
    },

    async genCommands() {
      if (this.busy) return;
      this.busy = true; this.status = 'Seeding commands…';
      try {
        const { ok, d } = await post('/api/instructor/compile_profile/commands',
                                     { source_files: this.files.filter(f => f.included).map(f => f.canonical) });
        if (!ok || d.error) { this.status = d.error || 'Command seeding failed'; return; }
        this.commands = (d.commands || []).join('\n');
        this.status = '';
        const m = this.pushAssistant(
          'Compile commands (' + (d.note || 'seeded') + ') — review them in the panel, then Save:\n\n```\n'
          + (d.commands || []).join('\n') + '\n```',
          { suggestions: [{ label: '▶ Compile now', action: 'compile' }] });
        if (d.reads_stdin && !this.simStdin.trim()) {
          m.followups = [{
            question: 'This program reads keyboard input. Generate a simulated input for it?',
            options: ['Generate input', "I'll type my own"],
            onPick(opt) {
              if (opt === 'Generate input') this.suggestInput();
              else { this.pushAssistant('Type the input (one value per line) into the "Program input" panel, then Save.'); document.getElementById('wbStdin')?.focus(); }
            },
          }];
        }
      } catch (e) { this.status = 'Command seeding failed'; }
      finally { this.busy = false; }
    },

    async compile() {
      if (this.busy) return;
      if (!await this.save(true)) return;
      this.busy = true; this.status = 'Compiling on the server…'; this.runResult = null;
      try {
        const { ok, d } = await post('/api/instructor/compile_profile/run', { stdin: this.simStdin || '' });
        if (!ok || d.error) { this.status = d.error || 'Run failed'; showNotification(this.status, true); return; }
        this.applyPayload(d, false);
        this.runResult = d;
        this.status = '';
        if (d.stdin_generated && d.stdin_used && !this.simStdin.trim()) {
          this.simStdin = d.stdin_used;
          const mIn = this.pushAssistant('The program needed keyboard input, so this was generated and used:\n\n```\n'
                                         + d.stdin_used + '\n```');
          mIn.followups = [{
            question: 'Keep this as the assignment\'s simulated input (used by student runs too)?',
            options: ['Keep it', 'I\'ll edit it'],
            onPick(opt) {
              if (opt === 'Keep it') this.save();
              else document.getElementById('wbStdin')?.focus();
            },
          }];
        }
        if (d.presumed) {
          this.pushAssistant('⚠ The server has no toolchain for this language, so the output below is **presumed** '
            + '(LLM prediction, not executed).' + (d.notes ? '\n\n' + d.notes : ''),
            { suggestions: [{ label: '∑ Summarize context', action: 'summarize' }] });
        } else if (d.ok) {
          this.pushAssistant('✓ Compiled and ran cleanly — the output is stored as the verified reference (section on the left).'
            + (d.stdin_drip ? ' (Input was fed as simulated typing.)' : ''),
            { suggestions: [{ label: '∑ Summarize context', action: 'summarize' }] });
          if (d.scanner_note) this.pushAssistant(d.scanner_note);
        } else {
          this.pushAssistant('✗ The run failed:\n\n```\n' + ((d.stderr || d.stdout || '(no output)').slice(0, 1200)) + '\n```',
            { suggestions: [{ label: 'Ask the assistant about this error', action: 'askAboutError' },
                            { label: '≈ Presume output with LLM', action: 'presumeOutput' }] });
        }
        // File references were adapted for this run (local-IDE paths, typo fixes) —
        // worth the instructor knowing: their sample uses paths students won't have.
        const refNotes = (d.adapt_notes || []).filter(n => n.includes('->'));
        if (refNotes.length) {
          this.pushAssistant('ℹ File references were adapted for the server run (the stored file is unchanged):\n\n'
            + refNotes.map(n => '- `' + n + '`').join('\n')
            + '\n\nConsider using plain relative filenames (no `./src/` prefix) so the code runs the same everywhere.');
        }
      } catch (e) { this.status = 'Run failed'; }
      finally { this.busy = false; }
    },

    // Backup after real runs keep failing: LLM predicts the output from the sources +
    // commands + input + the last error. Stored as presumed_output, clearly labeled —
    // never mistaken for a verified run. Compile-first stays the contract.
    async presumeOutput() {
      if (this.busy) return;
      this.busy = true; this.status = 'Presuming output…';
      try {
        const r = this.runResult || {};
        const { ok, d } = await post('/api/instructor/compile_profile/run',
                                     { presume: true, stdin: this.simStdin || '',
                                       error_text: (r.stderr || r.stdout || '').slice(0, 1500) });
        if (!ok || d.error) { this.status = d.error || 'Presume failed'; showNotification(this.status, true); return; }
        this.applyPayload(d, false);
        this.runResult = null;   // the presumed panel takes over the Result display
        this.status = '';
        this.pushAssistant('≈ Presumed output stored (labeled "presumed — not executed"). '
          + 'It serves as the reference until a real run verifies.'
          + (d.notes ? '\n\n' + d.notes : ''),
          { suggestions: [{ label: '∑ Summarize context', action: 'summarize' }] });
      } catch (e) { this.status = 'Presume failed'; }
      finally { this.busy = false; }
    },
    askAboutError() {
      const r = this.runResult || {};
      this.sendChat('The compile failed with this error — what should I change in the module (files, commands, input)?\n\n'
                    + ((r.stderr || r.stdout || '').slice(0, 1200)));
    },

    async suggestInput() {
      if (this.busy) return;
      this.busy = true; this.status = 'Generating input…';
      try {
        const { ok, d } = await post('/api/instructor/compile_profile/stdin',
                                     { current_stdin: this.simStdin || '' });
        if (!ok || d.error) { this.status = d.error || 'Input generation failed'; showNotification(this.status, true); return; }
        this.status = '';
        if (!d.needs_stdin) { this.pushAssistant('This project does not read keyboard input — no simulated input is needed.'); return; }
        const m = this.pushAssistant('Suggested simulated keyboard input:\n\n```\n' + (d.stdin || '(empty)') + '\n```');
        m.followups = [{
          question: 'Use this input for all compiles here AND for student chat / Deep Coding runs?',
          options: ['Accept input', 'I\'ll edit it'],
          onPick(opt) {
            this.simStdin = d.stdin || '';
            if (opt === 'Accept input') this.save();
            else document.getElementById('wbStdin')?.focus();
          },
        }];
      } catch (e) { this.status = 'Input generation failed'; }
      finally { this.busy = false; }
    },

    async summarize() {
      if (this.busy) return;
      if (!await this.save(true)) return;
      this.busy = true; this.status = 'Summarizing context…';
      try {
        const { ok, d } = await post('/api/instructor/compile_profile/summarize',
                                     { transcript: this.chat.slice(-20).map(m => ({ role: m.role, text: (m.text || '').slice(0, 400) })) });
        if (!ok || d.error) { this.status = d.error || 'Summary failed'; showNotification(this.status, true); return; }
        this.applyPayload(d, false);
        this.summary = d.context_summary || '';
        this._loadedSummary = this.summary;
        this.summaryAt = (d.profile || {}).context_summary_at || null;
        this.status = '';
        this.pushAssistant('∑ Context summary generated and stored — student chat and Deep Coding tutoring now use it as '
          + 'the program execution module. Edit it in the panel and Save if you want to adjust anything.');
      } catch (e) { this.status = 'Summary failed'; }
      finally { this.busy = false; }
    },

    async autogen() {
      if (this.busy) return;
      this.busy = true; this.status = 'Auto-gen starting…';
      try {
        const { ok, d } = await post('/api/instructor/compile_profile/autogen', {});
        if (!ok || d.error) { this.busy = false; this.status = d.error || 'Auto-gen failed'; return; }
        this.pollAutogen(60);
      } catch (e) { this.busy = false; this.status = 'Auto-gen failed'; }
    },
    pollAutogen(left) {
      clearTimeout(this._pollTimer);
      this._pollTimer = setTimeout(async () => {
        const d = await this.load(false);
        const st = (d && d.autogen) || {};
        if (st.running && left > 0) {
          this.status = 'Auto-gen: ' + (st.step || 'working…');
          this.pollAutogen(left - 1);
          return;
        }
        this.busy = false;
        if (st.error) { this.status = 'Auto-gen failed: ' + st.error; showNotification(this.status, true); return; }
        await this.load(true);   // pull the generated sections into the editors
        this.status = st.note ? ('Auto-gen done — ' + st.note) : 'Auto-gen done ✓';
        this.pushAssistant('⚙ Auto-gen finished' + (st.note ? (' — ' + st.note) : ' — commands, descriptions and (when possible) a verified output are filled in.'),
          { suggestions: [{ label: '∑ Summarize context', action: 'summarize' }] });
      }, 2500);
    },
  });

  Alpine.store('wb').init();
});
