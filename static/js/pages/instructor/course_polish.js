/*
 * LeafTutor — Course page polish (Assignments view of /instructor?class=…)
 *
 * 1. Adds an assignment picker. In course mode the left sidebar is hidden, so right
 *    now there is no way to see or switch assignments from this page.
 * 2. Restyles the Files tab: clearer card grouping, full-width remarks, a friendlier
 *    drop zone and empty state, sturdier tabs.
 *
 * Install: save as static/js/pages/instructor/course_polish.js and add AFTER store.js
 *   <script src="{{ static_v('js/pages/instructor/course_polish.js') }}"></script>
 * Add ?plain=1 to the URL to switch it off.
 */
(function () {
  'use strict';
  if (/[?&]plain=1(&|$)/.test(location.search)) return;

  var CSS = `
html.course-mode.cv-assignments .main-layout > .container { padding: 20px 16px 32px; }

/* Panel card */
html.course-mode #assignSection {
  border-radius: 14px;
  box-shadow: 0 1px 2px rgba(0,0,0,.05), 0 4px 16px rgba(0,0,0,.04);
  overflow: hidden;
}

/* ---- assignment picker ---- */
.lt-asn-picker {
  display: flex; align-items: center; gap: 10px;
  padding: 14px 20px; border-bottom: 1px solid var(--lt-border-secondary);
  background: var(--lt-bg-container);
}
.lt-asn-picker label {
  font-size: 11px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase;
  color: var(--lt-text-tertiary); white-space: nowrap;
}
.lt-asn-picker select {
  flex: 1; min-width: 0; max-width: 420px; font: inherit; font-size: 15px; font-weight: 600;
  padding: 8px 10px; cursor: pointer; color: var(--lt-text);
  background: var(--lt-bg-container);
  border: 1px solid var(--lt-border); border-radius: 8px;
}
.lt-asn-picker .lt-asn-count { font-size: 12px; color: var(--lt-text-tertiary); margin-left: auto; white-space: nowrap; }

/* ---- tabs ---- */
html.course-mode .asn-tab-bar { padding: 0 12px; background: var(--lt-bg-container); }
html.course-mode .asn-tab { font-size: 14px; padding: 12px 16px; font-weight: 500; }
html.course-mode .asn-tab.active { font-weight: 700; }

/* ---- Files tab body ---- */
html.course-mode #asnFilesTabPanel { padding: 20px; background: var(--lt-bg-layout); }
html.course-mode #asnFilesCard {
  background: var(--lt-bg-container); border: 1px solid var(--lt-border-secondary) !important;
  border-radius: 12px; padding: 20px 22px !important; box-shadow: none;
}
html.course-mode #asnFilesCard .section-header { border-bottom: 0; padding-bottom: 0; margin-bottom: 4px; }
html.course-mode #asnFilesTitle { font-size: 18px !important; font-weight: 700; }

/* Remarks */
html.course-mode #asnFilesCard label[for="asnRemarks"] {
  font-size: 11px !important; font-weight: 700; letter-spacing: .06em; text-transform: uppercase;
  color: var(--lt-text-tertiary) !important; margin: 14px 0 6px !important;
}
html.course-mode #asnRemarks {
  max-width: none !important; min-height: 88px; font-size: 14px !important; line-height: 1.5;
  padding: 10px 12px !important; border-radius: 8px !important;
  border: 1px solid var(--lt-border) !important; background: var(--lt-bg-container);
  color: var(--lt-text);
}
html.course-mode #asnRemarks:focus {
  outline: none; border-color: var(--lt-primary) !important;
  box-shadow: 0 0 0 3px var(--lt-primary-bg);
}
/* Save Remarks is secondary; Upload stays the one primary action */
html.course-mode #asnFilesCard button.btn.small[\\@click*="saveRemarks"] {
  background: transparent; color: var(--lt-primary); border: 1px solid var(--lt-primary-border);
}

/* Drop zone */
html.course-mode #asnUploadZone {
  margin: 18px 0 8px !important; padding: 26px 16px; text-align: center;
  border: 2px dashed var(--lt-border) !important; border-radius: 12px;
  background: var(--lt-fill-quaternary); color: var(--lt-text-secondary);
  transition: background .15s, border-color .15s;
}
html.course-mode #asnUploadZone::before { content: "⬆"; display: block; font-size: 22px; margin-bottom: 4px; opacity: .6; }
html.course-mode #asnUploadZone:hover,
html.course-mode #asnUploadZone.dragover {
  border-color: var(--lt-primary) !important; background: var(--lt-primary-bg);
}

/* Files list + empty state */
html.course-mode #asnFilesList { margin-top: 8px; }
html.course-mode #asnFilesList .empty {
  text-align: center; padding: 36px 12px; font-size: 14px; color: var(--lt-text-tertiary);
  border: 1px dashed var(--lt-border-secondary); border-radius: 10px;
}
html.course-mode #asnFilesList .empty::before { content: "📂"; display: block; font-size: 26px; margin-bottom: 6px; }
html.course-mode #asnFilesList .file-row { border-radius: 8px; padding: 8px 10px; margin-bottom: 6px; }
`;

  function start() {
    if (!document.documentElement.classList.contains('course-mode')) return;
    if (document.documentElement.classList.contains('cv-roster')) return;
    if (document.getElementById('lt-course-polish')) return;
    var inst = Alpine.store && Alpine.store('inst');
    if (!inst) return;

    var s = document.createElement('style');
    s.id = 'lt-course-polish';
    s.textContent = CSS;
    document.head.appendChild(s);

    var sec = document.getElementById('assignSection');
    if (!sec || sec.querySelector('.lt-asn-picker')) return;
    var picker = document.createElement('div');
    picker.className = 'lt-asn-picker';
    picker.setAttribute('x-data', '{}');
    picker.setAttribute('x-show', '$store.inst.currentClassId');
    picker.innerHTML =
      '<label for="ltAsnSelect">Assignment</label>' +
      '<select id="ltAsnSelect" @change="$store.inst.openAssignmentInstructor($event.target.value)">' +
        '<option value="" :selected="!$store.inst.currentAsnId" disabled>Choose an assignment…</option>' +
        '<template x-for="a in (($store.inst.sidebarAsn[$store.inst.currentClassId] || {}).items || [])" :key="a.id">' +
          '<option :value="a.id" :selected="a.id === $store.inst.currentAsnId" x-text="a.title"></option>' +
        '</template>' +
      '</select>' +
      '<span class="lt-asn-count" x-text="((($store.inst.sidebarAsn[$store.inst.currentClassId] || {}).items || []).length) + \' assignments\'"></span>';
    sec.insertBefore(picker, sec.firstChild);
  }

  if (window.Alpine && Alpine.store && Alpine.store('inst')) start();
  else document.addEventListener('alpine:initialized', start);
})();
