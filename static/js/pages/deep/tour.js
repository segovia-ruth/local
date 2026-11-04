/* Deep Coding guided tour: a step-by-step "bubble" that highlights each part of the IDE.
   Self-contained (no Alpine/store dependency). Opens automatically the first time a student
   uses Deep Coding (once per user per browser); reopen with the "? Tour" button or
   window.ideTour.start(). Add ?tour=1 to the /deep URL to force it while testing.
   Place at static/js/pages/deep/tour.js

   Per-user scoping: ide.html must pass the user id in window.DEEP, e.g.
     window.DEEP = { ..., user_id: {{ (session.uid or '')|tojson }} };
*/
(function () {
  'use strict';
  var KEY = 'lt_ide_tour_done_v1';
  function key() { return KEY + ':' + ((window.DEEP && window.DEEP.user_id) || ''); }

  // Each step: CSS selectors to highlight (first VISIBLE one wins), bubble text, preferred side.
  var ALL_STEPS = [
    {
      selectors: ['.ide-files .ide-pane-actions', '.ide-files .ide-rail-actions', '.ide-files'],
      title: '1 · Create or upload a file',
      text: 'Start here. Click “+ New” to make a file, or upload files / a whole folder. You can also drag and drop onto this panel.',
      side: 'right'
    },
    {
      selectors: ['.ide-editor .ide-pane-actions button[title="Show or hide the assignment PDF"]'],
      title: '2 · View the assignment',
      text: 'Need the instructions? Click “📄 Assignment” to open the PDF next to your code.',
      side: 'bottom',
      optional: true            // only exists when the assignment has a PDF
    },
    {
      selectors: ['.ide-editor-body'],
      title: '3 · Write your code',
      text: 'Open a file from the list and type your code in the editor. Click Save when you want to keep your changes.',
      side: 'left'
    },
    {
      selectors: ['.ide-icon-btn.run', '.ide-shell'],
      title: '4 · Run your code',
      text: 'Press ▶ Run (or F5). Your program runs in the Shell below, and you can type answers to input prompts right there.',
      side: 'bottom'
    },
    {
      selectors: ['.ide-chat .ide-composer', '.ide-chat'],
      title: '5 · Questions? Ask the Tutor',
      text: 'Stuck or confused by an error? Ask the AI tutor here. It gives hints first. Still stuck? Use “Instructor help” to flag your instructor.',
      side: 'left'
    }
  ];

  var STEPS = ALL_STEPS;        // rebuilt on each start() (optional steps dropped when their target is missing)
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
  function renumber(steps) {    // keep "1 · ", "2 · " titles correct if a step was dropped
    return steps.map(function (s, i) {
      return {
        selectors: s.selectors, text: s.text, side: s.side, optional: s.optional,
        title: (i + 1) + ' · ' + s.title.replace(/^\d+\s*·\s*/, '')
      };
    });
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
    s.left = (r.left - pad) + 'px'; s.top = (r.top - pad) + 'px';
    s.width = (r.width + pad * 2) + 'px'; s.height = (r.height + pad * 2) + 'px';

    var bw = b.offsetWidth, bh = b.offsetHeight;
    var side = step.side || 'bottom';
    var fits = {
      right: r.right + gap + bw + m <= vw,
      left: r.left - gap - bw - m >= 0,
      bottom: r.bottom + gap + bh + m <= vh,
      top: r.top - gap - bh - m >= 0
    };
    if (!fits[side]) {
      var order = ['bottom', 'right', 'left', 'top'];
      side = order.filter(function (k) { return fits[k]; })[0] || side;
    }
    var left, top;
    if (side === 'right') { left = r.right + gap; top = r.top + r.height / 2 - bh / 2; }
    if (side === 'left') { left = r.left - gap - bw; top = r.top + r.height / 2 - bh / 2; }
    if (side === 'bottom') { top = r.bottom + gap; left = r.left + r.width / 2 - bw / 2; }
    if (side === 'top') { top = r.top - gap - bh; left = r.left + r.width / 2 - bw / 2; }
    left = Math.min(Math.max(m, left), vw - bw - m);
    top = Math.min(Math.max(m, top), vh - bh - m);
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
    setTimeout(place, 150);      // re-measure once layout (panes, CodeMirror, PDF) has settled
    els.next.focus({ preventScroll: true });
  }

  function onKey(e) {
    if (!active) return;
    if (e.key === 'Escape') { e.preventDefault(); finish(); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); els.next.click(); }
    else if (e.key === 'ArrowLeft' && idx > 0) { e.preventDefault(); go(idx - 1); }
  }

  function start() {
    if (active) return;
    // drop optional steps whose target isn't on screen (e.g. no assignment PDF)
    var steps = ALL_STEPS.filter(function (s) { return !s.optional || findTarget(s); });
    STEPS = renumber(steps);
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
    try { localStorage.setItem(key(), '1'); } catch (e) { }
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
    try { seen = localStorage.getItem(key()) === '1'; } catch (e) { }
    var force = /[?&]tour=1\b/.test(location.search);
    var closed = !!(window.DEEP && window.DEEP.closed);

    if ((seen && !force) || closed) {
      console.log('[tour] not auto-starting', { seen: seen, closed: closed, key: key() });
      return;
    }

    // Wait until Alpine has rendered the three panes, then give layout a moment to settle.
    var tries = 0;
    (function waitThenStart() {
      var ready = visible(document.querySelector('.ide-files')) &&
                  visible(document.querySelector('.ide-editor-body')) &&
                  visible(document.querySelector('.ide-chat'));
      if (ready || tries++ > 40) setTimeout(start, 400);   // gives up waiting after ~4 s and starts anyway
      else setTimeout(waitThenStart, 100);
    })();
  }

  window.ideTour = { start: start, finish: finish };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
