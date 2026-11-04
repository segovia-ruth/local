/* Deep Coding guided tour: a step-by-step "bubble" that highlights each part of the IDE.
   Self-contained (no Alpine/store dependency). Shows once per browser; reopen with the "? Tour" button
   or by calling window.ideTour.start(). Place at static/js/pages/deep/tour.js */
(function () {
  'use strict';
  var KEY = 'lt_ide_tour_done_v1';

  // Each step: a CSS selector to highlight, bubble text, and preferred side.
  // `selectors` is tried in order; the first VISIBLE match wins (so it still works if a pane is collapsed).
  var STEPS = [
    { selectors: ['.ide-files .ide-pane-actions', '.ide-files .ide-rail-actions', '.ide-files'],
      title: '1 · Create or upload a file',
      text: 'Start here. Click “+ New” to make a file, or upload files / a whole folder. You can also drag and drop onto this panel.',
      side: 'right' },
    { selectors: ['.ide-editor .ide-pane-actions button[title="Show or hide the assignment PDF"]'],
      title: '2 · View the assignment',
      text: 'Need the instructions? Click “📄 Assignment” to open the PDF next to your code.',
      side: 'bottom' },
    { selectors: ['.ide-editor-body'],
      title: '3 · Write your code',
      text: 'Open a file from the list and type your code in the editor. Click Save when you want to keep your changes.',
      side: 'left' },
    { selectors: ['.ide-icon-btn.run', '.ide-shell'],
      title: '4 · Run your code',
      text: 'Press ▶ Run (or F5). Your program runs in the Shell below, and you can type answers to input prompts right there.',
      side: 'bottom' },
    { selectors: ['.ide-chat .ide-composer', '.ide-chat'],
      title: '5 · Questions? Ask the Tutor',
      text: 'Stuck or confused by an error? Ask the AI tutor here. It gives hints first. Still stuck? Use “Instructor help” to flag your instructor.',
      side: 'left' }
  ];

  var idx = 0, active = false, els = {};

  function visible(el) {
    if (!el) return false;
    var r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }
  function findTarget(step) {
    for (var i = 0; i < step.selectors.length; i++) {
      var el = document.querySelector(step.selectors[i]);
      if (visible(el)) return el;
    }
    return null;
  }

  function build() {
    if (els.root) return;
    var root = document.createElement('div');
    root.className = 'lt-tour';
    root.innerHTML =
      '<div class="lt-tour-spot" aria-hidden="true"></div>' +
      '<div class="lt-tour-bubble" role="dialog" aria-live="polite" aria-label="IDE tour">' +
        '<div class="lt-tour-arrow" aria-hidden="true"></div>' +
        '<button type="button" class="lt-tour-x" aria-label="Close tour">✕</button>' +
        '<div class="lt-tour-title"></div>' +
        '<div class="lt-tour-text"></div>' +
        '<div class="lt-tour-foot">' +
          '<span class="lt-tour-dots"></span>' +
          '<span class="lt-tour-btns">' +
            '<button type="button" class="lt-tour-skip">Skip</button>' +
            '<button type="button" class="lt-tour-back">Back</button>' +
            '<button type="button" class="lt-tour-next">Next</button>' +
          '</span>' +
        '</div>' +
      '</div>';
    document.body.appendChild(root);
    els = {
      root: root,
      spot: root.querySelector('.lt-tour-spot'),
      bubble: root.querySelector('.lt-tour-bubble'),
      arrow: root.querySelector('.lt-tour-arrow'),
      title: root.querySelector('.lt-tour-title'),
      text: root.querySelector('.lt-tour-text'),
      dots: root.querySelector('.lt-tour-dots'),
      back: root.querySelector('.lt-tour-back'),
      next: root.querySelector('.lt-tour-next')
    };
    root.querySelector('.lt-tour-x').addEventListener('click', finish);
    root.querySelector('.lt-tour-skip').addEventListener('click', finish);
    els.back.addEventListener('click', function () { go(idx - 1); });
    els.next.addEventListener('click', function () {
      if (idx >= STEPS.length - 1) finish(); else go(idx + 1);
    });
  }

  function place() {
    if (!active) return;
    var step = STEPS[idx];
    var target = findTarget(step);
    var b = els.bubble, pad = 6, gap = 14, m = 12;
    var vw = window.innerWidth, vh = window.innerHeight;

    if (!target) {               // nothing to point at: center the bubble, no spotlight
      els.spot.style.display = 'none';
      els.arrow.style.display = 'none';
      b.style.left = Math.max(m, (vw - b.offsetWidth) / 2) + 'px';
      b.style.top = Math.max(m, (vh - b.offsetHeight) / 2) + 'px';
      return;
    }
    var r = target.getBoundingClientRect();
    var s = els.spot.style;
    s.display = 'block';
    s.left = (r.left - pad) + 'px';  s.top = (r.top - pad) + 'px';
    s.width = (r.width + pad * 2) + 'px'; s.height = (r.height + pad * 2) + 'px';

    var bw = b.offsetWidth, bh = b.offsetHeight;
    var side = step.side || 'bottom';
    var fits = {
      right:  r.right + gap + bw + m <= vw,
      left:   r.left - gap - bw - m >= 0,
      bottom: r.bottom + gap + bh + m <= vh,
      top:    r.top - gap - bh - m >= 0
    };
    if (!fits[side]) {
      var order = ['bottom', 'right', 'left', 'top'];
      side = order.filter(function (k) { return fits[k]; })[0] || side;
    }
    var left, top;
    if (side === 'right')  { left = r.right + gap;       top = r.top + r.height / 2 - bh / 2; }
    if (side === 'left')   { left = r.left - gap - bw;   top = r.top + r.height / 2 - bh / 2; }
    if (side === 'bottom') { top = r.bottom + gap;       left = r.left + r.width / 2 - bw / 2; }
    if (side === 'top')    { top = r.top - gap - bh;     left = r.left + r.width / 2 - bw / 2; }
    left = Math.min(Math.max(m, left), vw - bw - m);
    top  = Math.min(Math.max(m, top),  vh - bh - m);
    b.style.left = left + 'px'; b.style.top = top + 'px';

    // arrow points at the target's center, clamped inside the bubble
    var a = els.arrow;
    a.style.display = 'block';
    a.className = 'lt-tour-arrow ' + side;
    if (side === 'left' || side === 'right') {
      a.style.top = Math.min(Math.max(14, r.top + r.height / 2 - top - 7), bh - 28) + 'px';
      a.style.left = ''; 
    } else {
      a.style.left = Math.min(Math.max(14, r.left + r.width / 2 - left - 7), bw - 28) + 'px';
      a.style.top = '';
    }
  }

  function go(i) {
    idx = Math.max(0, Math.min(STEPS.length - 1, i));
    var step = STEPS[idx];
    els.title.textContent = step.title;
    els.text.textContent = step.text;
    els.back.style.visibility = idx === 0 ? 'hidden' : 'visible';
    els.next.textContent = idx === STEPS.length - 1 ? 'Got it' : 'Next';
    els.dots.innerHTML = STEPS.map(function (_, k) {
      return '<i class="' + (k === idx ? 'on' : '') + '"></i>';
    }).join('');
    var t = findTarget(step);
    if (t && t.scrollIntoView) t.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    place();
    els.next.focus({ preventScroll: true });
  }

  function onKey(e) {
    if (!active) return;
    if (e.key === 'Escape') { e.preventDefault(); finish(); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); els.next.click(); }
    else if (e.key === 'ArrowLeft' && idx > 0) { e.preventDefault(); go(idx - 1); }
  }

  function start() {
    build();
    active = true;
    els.root.classList.add('open');
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    go(0);
  }
  function finish() {
    active = false;
    if (els.root) els.root.classList.remove('open');
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', place);
    window.removeEventListener('scroll', place, true);
    try { localStorage.setItem(KEY, '1'); } catch (e) {}
  }

  function addHelpButton() {
    var host = document.querySelector('.ide-editor .ide-pane-actions');
    if (!host || host.querySelector('.lt-tour-help')) return;
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ide-icon-btn lt-tour-help';
    btn.title = 'Take a quick tour of the IDE';
    btn.textContent = '? Tour';
    btn.addEventListener('click', start);
    host.insertBefore(btn, host.firstChild);
  }

  function init() {
    addHelpButton();
    var seen = false;
    try { seen = localStorage.getItem(KEY) === '1'; } catch (e) {}
    // wait a moment so Alpine has rendered the panes before measuring them
    if (!seen && !(window.DEEP && window.DEEP.closed)) setTimeout(start, 900);
  }

  window.ideTour = { start: start, finish: finish };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
