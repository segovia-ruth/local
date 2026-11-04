/* LeafTutor navigation tour: introduces the left rail (Home, Courses, Account, Calendar, Help).
   Auto-opens once per browser on /welcome (where users land after login). Reopen with window.navTour.start().
   Reuses the bubble styles from static/css/deep_tour.css (load that stylesheet in base.html).
   Place at static/js/core/nav_tour.js */
(function () {
  'use strict';
  var KEY = 'lt_nav_tour_done_v1';
  var AUTO_PATHS = ['/welcome', '/instructor/home'];   // post-login landing pages (student, instructor)
  var IS_INSTR = !!document.querySelector('.app-rail .rail-link[href="/instructor/home"]');

  var STEPS = [
    { sel: '.app-rail .rail-link[href="/welcome"], .app-rail .rail-link[href="/instructor/home"]',
      title: 'Home',
      text: 'Your starting page. Come back here any time.' },
    { sel: '.app-rail .rail-link[href="/courses"]',
      title: 'Courses',
      text: IS_INSTR
        ? 'Open a course to create and manage its assignments and see how students are doing.'
        : 'Open a course to find its assignments, then start coding with the AI tutor.' },
    { sel: '.app-rail .rail-link[href="/account"]',
      title: 'Account',
      text: 'Customize your account here, like theme, text size and accessibility options.' },
    { sel: '.app-rail .rail-link[href="/calendar"]',
      title: 'Calendar',
      text: IS_INSTR
        ? 'See assignment due dates across your courses.'
        : 'See when the due dates for your assignments are.' },
    { sel: '.app-rail .rail-link[href="/help"]',
      title: 'Help',
      text: 'Have any other question? Look here first.' }
  ];

  var steps = [], idx = 0, active = false, els = {};

  function visible(el) {
    if (!el) return false;
    var r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function build() {
    if (els.root) return;
    var root = document.createElement('div');
    root.className = 'lt-tour';
    root.innerHTML =
      '<div class="lt-tour-spot" aria-hidden="true"></div>' +
      '<div class="lt-tour-bubble" role="dialog" aria-live="polite" aria-label="Navigation tour">' +
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
      if (idx >= steps.length - 1) finish(); else go(idx + 1);
    });
  }

  function place() {
    if (!active) return;
    var target = document.querySelector(steps[idx].sel);
    var b = els.bubble, pad = 4, gap = 14, m = 12;
    var vw = window.innerWidth, vh = window.innerHeight;
    var r = target.getBoundingClientRect();
    var s = els.spot.style;
    s.display = 'block';
    s.left = (r.left - pad) + 'px';  s.top = (r.top - pad) + 'px';
    s.width = (r.width + pad * 2) + 'px'; s.height = (r.height + pad * 2) + 'px';

    var bw = b.offsetWidth, bh = b.offsetHeight;
    var left = r.right + gap;                       // rail is on the left: bubble goes to the right
    var top = r.top + r.height / 2 - bh / 2;
    left = Math.min(Math.max(m, left), vw - bw - m);
    top  = Math.min(Math.max(m, top),  vh - bh - m);
    b.style.left = left + 'px'; b.style.top = top + 'px';

    var a = els.arrow;
    a.style.display = 'block';
    a.className = 'lt-tour-arrow right';
    a.style.left = '';
    a.style.top = Math.min(Math.max(14, r.top + r.height / 2 - top - 7), bh - 28) + 'px';
  }

  function go(i) {
    idx = Math.max(0, Math.min(steps.length - 1, i));
    var st = steps[idx];
    els.title.textContent = st.title;
    els.text.textContent = st.text;
    els.back.style.visibility = idx === 0 ? 'hidden' : 'visible';
    els.next.textContent = idx === steps.length - 1 ? 'Got it' : 'Next';
    els.dots.innerHTML = steps.map(function (_, k) {
      return '<i class="' + (k === idx ? 'on' : '') + '"></i>';
    }).join('');
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
    // keep only steps whose link exists and is visible (e.g. a role without a Calendar link)
    steps = STEPS.filter(function (st) { return visible(document.querySelector(st.sel)); });
    if (!steps.length) return;
    build();
    active = true;
    els.root.classList.add('open');
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', place);
    go(0);
  }

  function finish() {
    active = false;
    if (els.root) els.root.classList.remove('open');
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', place);
    try { localStorage.setItem(KEY, '1'); } catch (e) {}
  }

  function init() {
    var seen = false;
    try { seen = localStorage.getItem(KEY) === '1'; } catch (e) {}
    if (seen || AUTO_PATHS.indexOf(location.pathname) === -1) return;
    // make sure the rail is expanded so the links are visible, then start
    setTimeout(function () {
      var rail = document.querySelector('.app-rail');
      if (rail && rail.classList.contains('collapsed')) {
        var t = rail.querySelector('.rail-toggle');
        if (t) t.click();
      }
      setTimeout(start, 250);
    }, 700);
  }

  window.navTour = { start: start, finish: finish };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
