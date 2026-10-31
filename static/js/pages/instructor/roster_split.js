/*
 * LeafTutor — Course page, split view for "Roster & audit" (/instructor?class=…&view=roster)
 *
 * Replaces the "Class Roster | Audit | Assistant" tabs with cards shown together:
 *   ≥1281px : [ Class roster (full height) | Audit over Assistants ]
 *   ≤1280px : same, a little narrower
 *   ≤860px  : one column, page scrolls
 * Companion to course_split.js (which does the Assignments view). Load both; each
 * only acts on its own view.
 *
 * Install: save as static/js/pages/instructor/roster_split.js and add after store.js:
 *   <script src="{{ static_v('js/pages/instructor/roster_split.js') }}"></script>
 * Add ?tabs=1 to the URL to get the tabbed layout back.
 */
(function () {
  'use strict';
  if (/[?&]tabs=1(&|$)/.test(location.search)) return;

  var A = 'html.course-mode.cv-roster ';

  var CSS = `
${A}.main-layout > .container { max-width: 1760px; padding: 12px 16px 16px; box-sizing: border-box; }
${A}#rosterAssignSplit.lt-split { height: 100%; }

/* #rosterSection becomes the grid; its cards are the three panels */
${A}#rosterSection {
  display: grid; height: 100%; min-height: 0; padding: 0; overflow: visible;
  background: transparent; border: 0; box-shadow: none; gap: 12px;
  /* PURPOSE: Give the roster and audit their own side-by-side columns.
   REASON: Teaching Assistants will have a separate navigation view. */
  grid-template-columns: minmax(0, 1fr) minmax(0, 1.3fr);
  grid-template-rows: minmax(0, 1fr);
}
${A}#rosterSection > .roster-tab-bar,
${A}#rosterSection > .roster-collapsed-label { display: none !important; }

${A}#rosterTabPanel,
${A}#auditTabPanel,
${A}#assistantTabPanel {
  display: block !important; min-width: 0; min-height: 0; overflow-y: auto; overscroll-behavior: contain;
  padding: 0 16px 14px; box-sizing: border-box;
  background: var(--lt-bg-container); border: 1px solid var(--lt-border-secondary);
  border-top-width: 3px; border-radius: 12px;
}
  
/* PURPOSE: Position roster and audit in separate columns.
   REASON: Assistant management no longer belongs in this layout. */
${A}#rosterTabPanel { grid-column: 1; grid-row: 1; border-top-color: var(--lt-primary); }
${A}#auditTabPanel  { grid-column: 2; grid-row: 1; border-top-color: var(--lt-warning, #faad14); }

/* Hide Teaching Assistants specifically from Roster & Audit. */
${A}#assistantTabPanel { display: none !important; }         border-top-color: var(--lt-success, #52c41a); }

/* Panel titles (the tab bar that used to name them is gone) */
${A}#rosterTabPanel::before,
${A}#auditTabPanel::before,
${A}#assistantTabPanel::before {
  display: block; position: sticky; top: 0; z-index: 2;
  margin: 0 -16px 10px; padding: 12px 16px 8px;
  background: var(--lt-bg-container); border-bottom: 1px solid var(--lt-border-secondary);
  font-size: 15px; font-weight: 700; color: var(--lt-text);
}
${A}#rosterTabPanel::before    { content: "Class roster"; }
${A}#auditTabPanel::before     { content: "Audit — student conversations"; }
${A}#assistantTabPanel::before { content: "Teaching assistants"; }

/* ---- roster: compact so more students fit ---- */
${A}#rosterBody .row { margin-top: 0; }
${A}#rosterBody > .card { padding: 10px 12px !important; }
${A}#rosterDrop { padding: 10px 12px; margin-top: 6px !important; }
${A}#studentList { max-height: none !important; overflow: visible !important; margin-top: 10px !important; }
${A}#studentList > .card { padding: 8px 12px !important; margin-bottom: 6px !important; }

/* ---- audit + assistants fill their panel ---- */
${A}.inst-audit-table-wrap { max-height: none; }
${A}#assistantList { max-height: none !important; overflow: visible !important; }

/* ---- small screens ---- */
@media (max-width: 860px) {
  ${A}.main-layout { height: auto; }
  ${A}.main-layout > .container { overflow-y: auto; }
  ${A}#rosterSection { display: flex; flex-direction: column; height: auto; }
  ${A}#rosterTabPanel, ${A}#auditTabPanel, ${A}#assistantTabPanel { overflow-y: visible; }
}
`;

  function start() {
    var root = document.documentElement;
    if (!root.classList.contains('course-mode') || !root.classList.contains('cv-roster')) return;
    if (document.getElementById('lt-roster-split')) return;
    var inst = window.Alpine && Alpine.store && Alpine.store('inst');
    if (!inst) return;

    var s = document.createElement('style');
    s.id = 'lt-roster-split';
    s.textContent = CSS;
    document.head.appendChild(s);

    // The store loads these only when their tab is opened, so load them ourselves.
    // Teaching assistants: whenever the class changes.
    Alpine.effect(function () {
      var id = inst.currentClassId;
      setTimeout(function () {
        if (id && typeof inst.loadAssistants === 'function') inst.loadAssistants();
      }, 0);
    });
    // Class audit: needs the class's assignment list, which arrives after the class is
    // selected — so re-run when the class or the number of assignments changes.
    Alpine.effect(function () {
      var id = inst.currentClassId;
      var n = (inst.assignments || []).length;   // tracked on purpose
      setTimeout(function () {
        if (typeof inst.renderInstAuditPanel === 'function') inst.renderInstAuditPanel();
      }, 0);
      void id; void n;
    });
  }

  if (window.Alpine && Alpine.store && Alpine.store('inst')) start();
  else document.addEventListener('alpine:initialized', start);
})();
