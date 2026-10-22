// instructor/core.js — imperative carve-outs reused by the Alpine `inst` store.
// Reactive state + rendering live in store.js; this file keeps only the things
// Alpine adds no value to: cookies, viewport-fit math, the split-pane drag, the
// sidebar/right-panel collapse (class + flex juggling), and the inline-rename helper.
/* ========= Error trap ========= */
window.addEventListener('error', e => { console.error('[JS ERROR]', e.message, e); });

/* ========= Helpers ========= */
const $id = (id) => document.getElementById(id);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const isValidEmail = (e) => EMAIL_RE.test((e||'').trim().toLowerCase());

/* ===== Last-accessed assignment cookie (read by the store on boot) =====
   TA mode uses its own cookie so a TA session in the same browser never
   clobbers the instructor's last-accessed restore state. */
const LAST_ASN_COOKIE = (window.LT_PANEL && window.LT_PANEL.mode === 'ta') ? 'ta_last_asn' : 'inst_last_asn';

function setCookie(name, value, days){
  let expires = '';
  if (days){
    const d = new Date();
    d.setTime(d.getTime() + days*24*60*60*1000);
    expires = '; expires=' + d.toUTCString();
  }
  document.cookie = `${name}=${encodeURIComponent(value)}${expires}; path=/; SameSite=Lax`;
}
function getCookie(name){
  const prefix = name + '=';
  for (const part of document.cookie.split(';')){
    const c = part.trim();
    if (c.startsWith(prefix)) return decodeURIComponent(c.slice(prefix.length));
  }
  return null;
}

// Inline text editor triggered from an Alpine @click; operates on a passed element.
// Enter or click-outside confirms; Escape cancels. onConfirm(newValue) persists.
function startInlineEdit(el, currentText, onConfirm){
  if (el.querySelector('input')) return;
  el.textContent = '';
  const input = document.createElement('input');
  input.className = 'inline-rename-input';
  input.value = currentText;
  el.appendChild(input);
  input.addEventListener('click',     e => e.stopPropagation());
  input.addEventListener('mousedown', e => e.stopPropagation());
  input.focus({ preventScroll: true });
  input.select();

  let done = false, outsideHandler;
  const finish = (save) => {
    if (done) return;
    done = true;
    document.removeEventListener('mousedown', outsideHandler, true);
    const val = input.value.trim();
    el.textContent = (save && val) ? val : currentText;
    if (save && val && val !== currentText){
      try {
        const p = onConfirm(val);
        if (p && typeof p.catch === 'function') p.catch(e => console.warn('Rename not persisted:', e));
      } catch(e){ console.warn('Rename not persisted:', e); }
    }
  };
  outsideHandler = e => { if (!el.contains(e.target)) finish(true); };
  document.addEventListener('mousedown', outsideHandler, true);
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter')  { e.preventDefault(); finish(true); }
    if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  });
}

// Adjust list heights so they fit within the viewport (the flex/grid chain here
// isn't reliably bounded, so the scroll height is computed in JS).
function fitRosterScroll(){
  const list = $id('studentList');
  if(!list) return;
  const rect = list.getBoundingClientRect();
  list.style.maxHeight = Math.max(140, window.innerHeight - rect.top - 16) + 'px';
  list.style.overflowY = 'auto';
}
function fitFilesListScroll(){
  const list = $id('asnFilesList');
  if (!list || list.closest('#asnFilesCard')?.style.display === 'none') return;
  const rect = list.getBoundingClientRect();
  list.style.maxHeight = Math.max(120, window.innerHeight - rect.top - 24) + 'px';
}
window.addEventListener('resize', () => { fitRosterScroll(); fitFilesListScroll(); });

/* ========= Sidebar collapse (class list) ========= */
function toggleSidebar(){
  const sidebar = document.getElementById('sidebar');
  const btn = document.getElementById('sidebarToggle');
  const collapsed = sidebar.classList.toggle('collapsed');
  if (btn){
    btn.textContent = collapsed ? '→' : '←';
    btn.title = collapsed ? 'Expand sidebar' : 'Collapse sidebar';
  }
}

/* ========= Right panel (Roster/Audit) collapse ========= */
function toggleRosterPanel(){
  const section = $id('rosterSection');
  const assign  = $id('assignSection');
  const handle  = document.querySelector('#rosterAssignSplit .lt-handle');
  const btn     = $id('rosterCollapseToggle');
  if (!section) return;
  const collapsed = section.classList.toggle('collapsed');
  if (collapsed) {
    if (assign) { assign._prevFlex = assign.style.flex; assign.style.flex = '1 1 auto'; }
    if (handle) handle.style.display = 'none';
    if (btn) { btn.textContent = '←'; btn.title = 'Expand panel'; btn.setAttribute('aria-label','Expand panel'); }
  } else {
    if (assign && assign._prevFlex) assign.style.flex = assign._prevFlex;
    if (handle) handle.style.display = '';
    if (btn) { btn.textContent = '→'; btn.title = 'Collapse panel'; btn.setAttribute('aria-label','Collapse panel'); }
  }
  fitRosterScroll();
  fitFilesListScroll();
}

/* ========= Resizable split (Assignments | Roster) ========= */
(function initSplit(){
  const wrap = $id('rosterAssignSplit');
  const left = $id('assignSection');
  const right = $id('rosterSection');
  if (!wrap || !left || !right) return;

  const key = 'split:rosterAssign';
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(key) || 'null'); } catch {}
  let l0 = Number(saved?.l), r0 = Number(saved?.r);

  const notNum = (x) => !isFinite(x);
  const badSum = (l0 + r0 < 95) || (l0 + r0 > 105);
  const tooSmall = (l0 <= 10) || (r0 <= 10);
  if (notNum(l0) || notNum(r0) || badSum || tooSmall) { l0 = 50; r0 = 50; }

  left.style.flex  = `0 0 ${l0}%`;
  right.style.flex = `0 0 ${r0}%`;

  const handle = document.createElement('div');
  handle.className = 'lt-handle';
  wrap.insertBefore(handle, right);

  let dragging=false, startX=0, startL=0, startR=0;
  function startDrag(x){ dragging=true; startX=x; startL=left.getBoundingClientRect().width; startR=right.getBoundingClientRect().width; document.body.classList.add('lt-dragging','resizing'); }
  function moveDrag(x){
    if (!dragging) return;
    const dx = x - startX, total = Math.max(1, startL + startR);
    let l = ((startL + dx) * 100) / total, r = 100 - l;
    const MIN = 20;
    if (l < MIN) { l = MIN; r = 100 - MIN; }
    if (r < MIN) { r = MIN; l = 100 - MIN; }
    left.style.flex  = `0 0 ${l}%`;
    right.style.flex = `0 0 ${r}%`;
    localStorage.setItem(key, JSON.stringify({ l: Math.round(l), r: Math.round(r) }));
  }
  function endDrag(){ dragging=false; document.body.classList.remove('lt-dragging','resizing'); }

  handle.addEventListener('mousedown', e => { e.preventDefault(); startDrag(e.clientX); });
  window.addEventListener('mousemove', e => { if (dragging){ e.preventDefault(); moveDrag(e.clientX); } }, { passive:false });
  window.addEventListener('mouseup', endDrag);
  handle.addEventListener('touchstart', e => { const t=e.touches?.[0]; if(t){ e.preventDefault(); startDrag(t.clientX); } }, { passive:false });
  window.addEventListener('touchmove', e => { const t=e.touches?.[0]; if (dragging && t){ e.preventDefault(); moveDrag(t.clientX); } }, { passive:false });
  window.addEventListener('touchend', endDrag, { passive:true });

  // Start with the Roster/Audit panel collapsed by default (full dashboard only; course pages
  // open the roster expanded: side-by-side in the assignments view, full-width in the roster view).
  if (!document.documentElement.classList.contains('course-mode') && !right.classList.contains('collapsed')) toggleRosterPanel();
})();
