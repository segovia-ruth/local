/*
 * LeafTutor — Course page, split view (Assignments view of /instructor?class=…)
 *
 * Replaces the "Assignment Files | Tutoring | Audit" tab bar with three cards shown
 * side by side, so nothing sits behind a tab and the page fills the screen.
 *   ≥1281px : three columns   [ Files | Tutoring | Audit ]
 *   861–1280: two columns     [ Files | Tutoring over Audit ]
 *   ≤860px  : one column, page scrolls
 * Also adds an assignment picker (the sidebar is hidden on this page).
 *
 * Install (use this INSTEAD of course_polish.js): save as
 *   static/js/pages/instructor/course_split.js
 * and add after store.js in {% block extra_scripts %}:
 *   <script src="{{ static_v('js/pages/instructor/course_split.js') }}"></script>
 * Add ?tabs=1 to the URL to get the old tabbed layout back.
 */
(function () {
  'use strict';
  if (/[?&]tabs=1(&|$)/.test(location.search)) return;

  var A = 'html.course-mode.cv-assignments ';

  var CSS = `
/* ---- wider page, no outer card: the three panels are the cards ---- */
${A}.main-layout > .container { max-width: 1760px; padding: 12px 16px 16px; box-sizing: border-box; }
${A}#rosterAssignSplit.lt-split { height: 100%; }
${A}#assignSection {
  display: grid; height: 100%; min-height: 0; padding: 0; overflow: visible;
  background: transparent; border: 0; box-shadow: none; gap: 12px;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1.15fr) minmax(0, 1fr);
  grid-template-rows: auto minmax(0, 1fr);
}
${A}#assignSection > .asn-tab-bar,
${A}#assignSection > .lt-crumb { display: none !important; }

/* ---- assignment picker ---- */
.lt-asn-picker {
  grid-column: 1 / -1; display: flex; align-items: center; gap: 12px;
  padding: 10px 16px; background: var(--lt-bg-container);
  border: 1px solid var(--lt-border-secondary); border-radius: 12px;
}
.lt-asn-picker label { font-size: 11px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase;
  color: var(--lt-text-tertiary); white-space: nowrap; }
.lt-asn-picker select { flex: 1; min-width: 0; max-width: 460px; font: inherit; font-size: 15px; font-weight: 600;
  padding: 7px 10px; cursor: pointer; color: var(--lt-text); background: var(--lt-bg-container);
  border: 1px solid var(--lt-border); border-radius: 8px; }
.lt-asn-picker .lt-asn-count { margin-left: auto; font-size: 12px; color: var(--lt-text-tertiary); white-space: nowrap; }

/* ---- the three panels: always visible, each scrolls on its own ---- */
${A}#asnFilesTabPanel,
${A}#asnTutoringTabPanel,
${A}#asnAuditTabPanel {
  display: block !important; min-width: 0; min-height: 0; overflow-y: auto; overscroll-behavior: contain;
  padding: 14px 16px; box-sizing: border-box;
  background: var(--lt-bg-container); border: 1px solid var(--lt-border-secondary);
  border-top-width: 3px; border-radius: 12px;
}
${A}#asnFilesTabPanel    { border-top-color: var(--lt-primary); }
${A}#asnTutoringTabPanel { border-top-color: var(--lt-success, #52c41a); }
${A}#asnAuditTabPanel    { border-top-color: var(--lt-warning, #faad14); }

/* The Files card no longer needs its own box inside the panel */
${A}#asnFilesCard { border: 0 !important; padding: 0 !important; box-shadow: none; background: transparent; }
${A}#asnFilesCard .section-header { border-bottom: 0; padding-bottom: 0; }
${A}#asnFilesTitle,
${A}#asnTutoringTitle,
${A}#asnAuditTitle { font-size: 15px !important; font-weight: 700; }
${A}#asnFilesList { max-height: none !important; }   /* the panel scrolls instead */

/* Tighter Files form */
${A}#asnRemarks { max-width: none !important; min-height: 64px; font-size: 13px !important; }
${A}#asnUploadZone { margin: 10px 0 6px !important; padding: 14px 10px; text-align: center;
  border: 2px dashed var(--lt-border) !important; border-radius: 10px; background: var(--lt-fill-quaternary); }
${A}#asnUploadZone:hover, ${A}#asnUploadZone.dragover { border-color: var(--lt-primary) !important; background: var(--lt-primary-bg); }
${A}#asnFilesList .empty { text-align: center; padding: 18px 8px; color: var(--lt-text-tertiary);
  border: 1px dashed var(--lt-border-secondary); border-radius: 8px; }

/* Tutoring / audit content uses the full panel height */
${A}#asnTutoringBody, ${A}#asnAuditBody { max-height: none !important; overflow: visible !important; }
${A}.inst-audit-table-wrap { max-height: none; }

/* ---- medium screens: Files left, Tutoring over Audit on the right ---- */
@media (max-width: 1280px) {
  ${A}#assignSection { grid-template-columns: minmax(0, 1fr) minmax(0, 1.1fr); grid-template-rows: auto minmax(0, 1fr) minmax(0, 1fr); }
  ${A}#asnFilesTabPanel { grid-column: 1; grid-row: 2 / span 2; }
  ${A}#asnTutoringTabPanel { grid-column: 2; grid-row: 2; }
  ${A}#asnAuditTabPanel { grid-column: 2; grid-row: 3; }
}
/* ---- small screens: single column, whole page scrolls ---- */
@media (max-width: 860px) {
  ${A}.main-layout { height: auto; }
  ${A}.main-layout > .container { overflow-y: auto; }
  ${A}#assignSection { display: flex; flex-direction: column; height: auto; }
  ${A}#asnFilesTabPanel, ${A}#asnTutoringTabPanel, ${A}#asnAuditTabPanel { overflow-y: visible; }
}
`;

  function start() {
    var root = document.documentElement;
    if (!root.classList.contains('course-mode') || root.classList.contains('cv-roster')) return;
    if (document.getElementById('lt-course-split')) return;
    var inst = window.Alpine && Alpine.store && Alpine.store('inst');
    if (!inst) return;

    var s = document.createElement('style');
    s.id = 'lt-course-split';
    s.textContent = CSS;
    document.head.appendChild(s);

    var sec = document.getElementById('assignSection');
    if (sec && !sec.querySelector('.lt-asn-picker')) {
      var p = document.createElement('div');
      p.className = 'lt-asn-picker';
      p.setAttribute('x-data', '{}');
      p.innerHTML =
        '<label for="ltAsnSelect">Assignment</label>' +
        '<select id="ltAsnSelect" @change="$store.inst.selectAssignment($event.target.value)">' +
          '<option value="" :selected="!$store.inst.currentAsnId" disabled>Choose an assignment…</option>' +
          '<template x-for="a in (($store.inst.sidebarAsn[$store.inst.currentClassId] || {}).items || [])" :key="a.id">' +
            '<option :value="a.id" :selected="a.id === $store.inst.currentAsnId" x-text="a.title"></option>' +
          '</template>' +
        '</select>' +
        '<span class="lt-asn-count" x-text="((($store.inst.sidebarAsn[$store.inst.currentClassId] || {}).items || []).length) + \' assignments\'"></span>';
      sec.insertBefore(p, sec.firstChild);
    }

    // The store only loads Tutoring / Audit data when their tab is active (or on tab
    // click). With all three panels visible, load them whenever the assignment changes.
    Alpine.effect(function () {
      var id = inst.currentAsnId;
      setTimeout(function () {
        if (!id) return;
        if (typeof inst.renderAsnTutoringPanel === 'function') inst.renderAsnTutoringPanel();
        if (typeof inst.renderAsnAuditPanel === 'function') inst.renderAsnAuditPanel();
      }, 0);
    });
  }

  if (window.Alpine && Alpine.store && Alpine.store('inst')) start();
  else document.addEventListener('alpine:initialized', start);
})();
