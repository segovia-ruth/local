/* Deep Coding — "Check my code" ($store.check), freeCodeCamp-style.
 *
 * Runs the instructor's test file(s) for the assignment against the open file and lists each test
 * as passed / failed with a short message. Backend: POST /api/deep/check_file {file_id}.
 * Instructors turn it on by uploading a test file to the assignment (tag: "Tests / grader"),
 * e.g. test_solution.py using unittest. Python and JavaScript are supported.
 *
 * Self-contained: injects its own CSS, depends only on $store.ide (center.fileId, save(), currentText()).
 */
(function () {
  'use strict';

  var css = [
    '.ide-check{border-bottom:1px solid var(--lt-border);background:var(--lt-bg-container);max-height:38%;overflow:auto;padding:10px 14px;font-size:13px}',
    '.ide-check-head{display:flex;align-items:center;gap:10px;margin-bottom:6px}',
    '.ide-check-head strong{font-size:13px}',
    '.ide-check-badge{padding:2px 10px;border-radius:999px;font-size:12px;font-weight:600}',
    '.ide-check-badge.ok{background:var(--lt-primary-bg);color:var(--lt-primary)}',
    '.ide-check-badge.bad{background:#fde8e8;color:#b91c1c}',
    '.ide-check-close{margin-left:auto;background:none;border:0;cursor:pointer;font-size:18px;color:var(--lt-text-tertiary)}',
    '.ide-check ul{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:4px}',
    '.ide-check li{display:grid;grid-template-columns:20px 1fr;gap:6px;align-items:start}',
    '.ide-check .t-pass{color:var(--lt-primary)}.ide-check .t-fail{color:#b91c1c}',
    '.ide-check .t-msg{display:block;color:var(--lt-text-secondary);font-family:var(--lt-font-mono);font-size:12px;white-space:pre-wrap}',
    '.ide-check-note{color:var(--lt-text-secondary);margin:4px 0 0}',
    '.ide-check details{margin-top:8px}.ide-check pre{margin:6px 0 0;white-space:pre-wrap;font-size:12px;font-family:var(--lt-font-mono)}'
  ].join('\n');
  var st = document.createElement('style');
  st.textContent = css;
  document.head.appendChild(st);

  document.addEventListener('alpine:init', function () {
    Alpine.store('check', {
      busy: false,
      open: false,
      result: null,      // { ok, passed, total, tests:[{name,status,message}], output }
      error: '',

      get label() { return this.busy ? 'Checking…' : '✓ Check my code'; },

      async run() {
        var ide = Alpine.store('ide');
        if (this.busy || !ide.center.fileId) return;
        this.busy = true; this.error = ''; this.open = true; this.result = null;
        try {
          // check what's on screen: persist unsaved edits first
          if (ide.center.editable && ide.currentText() !== ide._savedContent) {
            var saved = await ide.save();
            if (saved === false) { this.error = 'Could not save your edits, so nothing was checked.'; return; }
          }
          var r = await fetch('/api/deep/check_file', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ file_id: ide.center.fileId, stdin: ide.stdin || '' })
          });
          var d = await r.json().catch(function () { return {}; });
          if (!r.ok || d.error) { this.error = d.error || 'Could not run the checks.'; return; }
          this.result = d;
        } catch (e) {
          this.error = 'Network error. Is the server still running?';
        } finally {
          this.busy = false;
        }
      },

      close() { this.open = false; }
    });
  });
})();
