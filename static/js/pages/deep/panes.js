/* Deep Coding — show / hide the Files and Tutor panels ($store.panes).
 *
 * Each panel has a slim rail that is ALWAYS visible (see deep_panes.css), styled like NotebookLM's collapsed
 * panel: an expand / collapse button on top, then round icon buttons below it. The rail MARKUP lives in
 * ide.html (so its buttons can use the real LeafTutor actions and Alpine bindings); this file only
 *   - fills each rail's expand button with the panel icon,
 *   - adds the collapse button to each panel header,
 *   - keeps tooltips / aria state in sync,
 *   - shows and hides the panels.
 *
 * Collapsing a panel adds a class on .ide-root, and the editor takes the freed space.
 * If .ide-root is a CSS grid with fixed column tracks, the track list is rewritten too and the original
 * value is restored when both panels are expanded again. State is remembered in localStorage.
 *
 * Toggles: the rail buttons, the Files / Tutor buttons in the editor header, and a collapse button in each
 * panel header. $store.panes.show('files' | 'chat') expands a panel if it is collapsed (used by the rail actions).
 */
(function () {
  'use strict';

  function lsGet(k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { window.localStorage.setItem(k, v); } catch (e) { /* storage blocked */ } }
  function root() { return document.querySelector('.ide-root'); }

  // side-panel icon shared by the rail expand button and the header collapse button
  var PANEL_SVG =
    '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false">' +
    '<rect x="3" y="4" width="18" height="16" rx="2" fill="none" stroke="currentColor" stroke-width="1.8"/>' +
    '<line x1="9.5" y1="4" x2="9.5" y2="20" stroke="currentColor" stroke-width="1.8"/></svg>';

  var PANELS = {
    files: { selector: '.ide-files', label: 'Files' },
    chat:  { selector: '.ide-chat',  label: 'Tutor' }
  };

  document.addEventListener('alpine:init', function () {
    Alpine.store('panes', {
      files: true,
      chat: true,
      _orig: null,        // { inline, cols } captured while both panels are visible

      init: function () {
        var self = this;
        this.files = lsGet('lt_panes_files') !== '0';
        this.chat = lsGet('lt_panes_chat') !== '0';
        // wait for the IDE store to lay out first, so the captured column widths are the real ones
        requestAnimationFrame(function () {
          requestAnimationFrame(function () {
            self.buildControls();
            self.capture();
            self.apply();
          });
        });
      },

      // wire the rail expand buttons (markup is in ide.html) and add the header collapse buttons
      buildControls: function () {
        var self = this, r = root();
        if (!r) return;

        r.querySelectorAll('.ide-rail-expand[data-pane]').forEach(function (b) { b.innerHTML = PANEL_SVG; });

        Object.keys(PANELS).forEach(function (which) {
          var panel = r.querySelector(':scope > ' + PANELS[which].selector);
          if (!panel) return;
          var head = panel.querySelector(':scope > .ide-pane-head');
          if (!head) return;
          head.querySelectorAll(':scope > .ide-pane-collapse').forEach(function (old) { old.remove(); });
          var btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'ide-pane-collapse';
          btn.dataset.pane = which;
          btn.innerHTML = PANEL_SVG;
          btn.addEventListener('click', function (e) { e.stopPropagation(); self.toggle(which); });
          // Files (left panel): button at the right end of the header. Tutor (right panel): at the left end.
          if (which === 'files') head.appendChild(btn); else head.insertBefore(btn, head.firstChild);
        });
        this.syncRails();
      },

      // keep each button's tooltip and aria state in line with the panel state
      syncRails: function () {
        var self = this;
        document.querySelectorAll('.ide-rail-expand[data-pane], .ide-pane-collapse[data-pane]').forEach(function (btn) {
          var which = btn.dataset.pane, cfg = PANELS[which];
          if (!cfg) return;
          var open = !!self[which];
          var text = (open ? 'Collapse ' : 'Expand ') + cfg.label + ' panel';
          btn.setAttribute('aria-label', text);
          btn.setAttribute('aria-expanded', open ? 'true' : 'false');
          btn.title = text;
        });
      },

      // remember the fully-visible layout (called before the first hide and whenever both are shown)
      capture: function () {
        var r = root();
        if (!r) return;
        var hadF = r.classList.contains('ide-files-hidden'), hadC = r.classList.contains('ide-chat-hidden');
        r.classList.remove('ide-files-hidden', 'ide-chat-hidden');
        var grid = getComputedStyle(r).display === 'grid';
        this._orig = {
          inline: r.style.gridTemplateColumns || '',
          cols: grid ? getComputedStyle(r).gridTemplateColumns.split(' ') : null
        };
        if (hadF) r.classList.add('ide-files-hidden');
        if (hadC) r.classList.add('ide-chat-hidden');
      },

      toggle: function (which) {
        if (this.files && this.chat) this.capture();          // fresh widths (the user may have dragged the splitter)
        this[which] = !this[which];
        lsSet('lt_panes_' + which, this[which] ? '1' : '0');
        this.apply();
      },

      // expand a panel if it is collapsed (rail actions use this so their dialogs / status text are visible)
      show: function (which) {
        if (!this[which]) this.toggle(which);
      },

      apply: function () {
        var r = root();
        if (!r) return;
        r.classList.toggle('ide-files-hidden', !this.files);
        r.classList.toggle('ide-chat-hidden', !this.chat);

        if (getComputedStyle(r).display === 'grid' && this._orig) {
          if (this.files && this.chat) {
            r.style.gridTemplateColumns = this._orig.inline;   // back to whatever the IDE store had set
          } else if (this._orig.cols && this._orig.cols.length === 4) {
            // children order: files, splitter, editor, tutor
            var c = this._orig.cols, out = [];
            if (this.files) out.push(c[0], c[1]);              // files + splitter
            else out.push('var(--ide-rail-w)');                // collapsed: slim rail (splitter is hidden)
            out.push('minmax(0, 1fr)');                        // editor takes the rest
            out.push(this.chat ? c[3] : 'var(--ide-rail-w)');  // tutor, or its rail
            r.style.gridTemplateColumns = out.join(' ');
          }
        }
        this.syncRails();
        // let CodeMirror and the PDF preview re-measure
        setTimeout(function () { window.dispatchEvent(new Event('resize')); }, 0);
      }
    });
  });
})();
