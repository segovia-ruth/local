/* Deep Coding — assignment PDF preview ($store.pdfp).
 *
 * Self-contained: it does not touch the IDE store ($store.ide). It lists the assignment's student-visible
 * PDFs, shows the first one in a panel docked above the editor, and lets the student zoom, fit to width,
 * jump between pages and resize the panel.
 *
 * Rendering engines
 *   pdfjs  - used when pdf.js (v3.x UMD build) is vendored at static/vendor/pdfjs/pdf.min.js (+ pdf.worker.min.js).
 *            Continuous scroll, lazy page rendering, crisp on HiDPI screens, Ctrl+wheel / Ctrl +/- zoom.
 *   native - fallback when pdf.js is missing: the browser's built-in PDF viewer in an <iframe>.
 *            Zoom buttons reload it with a #zoom=N hint; page navigation is left to the viewer's own toolbar.
 *
 * Backend: GET /api/deep/assignment_pdfs?session_id=...   -> { ok, files: [{id, name, size}] }
 *          GET /api/deep/assignment_pdf?session_id=...&file_id=...[&download=1] -> application/pdf
 */
(function () {
  'use strict';

  var STEPS = [25, 50, 75, 100, 125, 150, 200, 300, 400];   // zoom % (100% = 96 dpi, like a desktop viewer)
  var CSS_PER_PT = 96 / 72;
  var MIN_ZOOM = 25, MAX_ZOOM = 400;
  var PDFJS_BASE = '/static/vendor/pdfjs/';

  // pdf.js objects live outside the reactive store: Alpine would wrap them in proxies and break pdf.js internals.
  var pdf = null, pageCache = [], sizes = [], observer = null, resizeObs = null;
  var renderGen = 0, loadGen = 0, lastWidth = 0, lastWheel = 0, scrollQueued = false;

  function $(id) { return document.getElementById(id); }
  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
  function frame() { return new Promise(function (r) { requestAnimationFrame(function () { requestAnimationFrame(r); }); }); }
  function lsGet(k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { window.localStorage.setItem(k, v); } catch (e) { /* storage blocked */ } }

  if (window.pdfjsLib && window.pdfjsLib.GlobalWorkerOptions) {
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_BASE + 'pdf.worker.min.js';
  }

  document.addEventListener('alpine:init', function () {
    Alpine.store('pdfp', {
      sid: '',
      files: [],
      fileId: '',
      open: false,
      loading: false,
      error: '',
      engine: '',        // '' | 'pdfjs' | 'native'
      pages: 0,
      page: 1,
      zoom: 100,         // percent
      fitWidth: true,
      height: 320,       // px

      get currentName() {
        var f = this.files.find(function (x) { return x.id === this.fileId; }, this);
        return f ? f.name : '';
      },
      get zoomLabel() { return Math.round(this.zoom) + '%'; },

      pdfUrl: function (id, download) {
        if (!id) return '#';
        return '/api/deep/assignment_pdf?session_id=' + encodeURIComponent(this.sid) +
          '&file_id=' + encodeURIComponent(id) + (download ? '&download=1' : '');
      },

      // ── startup ──────────────────────────────────────────────────────────
      init: function () {
        var D = window.DEEP || {};
        this.sid = D.session_id || '';
        var h = parseInt(lsGet('lt_pdfp_h'), 10);
        this.height = h >= 120 ? h : Math.max(200, Math.round(window.innerHeight * 0.4));
        var o = lsGet('lt_pdfp_open');
        this.open = o === null ? true : o === '1';       // first visit: show it
        if (this.sid) this.fetchList();
      },

      fetchList: async function () {
        try {
          var r = await fetch('/api/deep/assignment_pdfs?session_id=' + encodeURIComponent(this.sid), { credentials: 'same-origin' });
          var d = await r.json().catch(function () { return {}; });
          if (!r.ok || !d.ok || !(d.files || []).length) return;   // no PDF (or not available here) → feature stays hidden
          this.files = d.files;
          this.fileId = d.files[0].id;
          if (this.open) await this.load();
        } catch (e) { /* network error: leave the panel hidden */ }
      },

      select: function (id) {
        if (!id || id === this.fileId) return;
        this.fileId = id;
        this.load();
      },

      toggle: async function () {
        this.open = !this.open;
        lsSet('lt_pdfp_open', this.open ? '1' : '0');
        if (!this.open) return;
        await frame();                                    // wait until the panel is visible so widths are real
        if (this.engine === 'pdfjs' && pdf) this.layout(true);
        else if (this.engine === 'native') { /* iframe is still mounted */ }
        else await this.load();
      },

      // ── loading ──────────────────────────────────────────────────────────
      load: async function () {
        if (!this.fileId) return;
        var my = ++loadGen;
        this.loading = true; this.error = ''; this.pages = 0; this.page = 1;
        pdf = null; pageCache = []; sizes = [];
        var host = $('pdfpPages');
        if (host) host.innerHTML = '';
        await frame();
        if (my !== loadGen) return;
        try {
          if (window.pdfjsLib) {
            this.engine = 'pdfjs';
            var resp = await fetch(this.pdfUrl(this.fileId), { credentials: 'same-origin' });
            if (!resp.ok) throw new Error('HTTP ' + resp.status);
            var buf = new Uint8Array(await resp.arrayBuffer());
            var doc = await window.pdfjsLib.getDocument({ data: buf }).promise;
            if (my !== loadGen) return;
            pdf = doc;
            pageCache = await Promise.all(Array.from({ length: doc.numPages }, function (_, i) { return doc.getPage(i + 1); }));
            if (my !== loadGen) return;
            sizes = pageCache.map(function (p) { var v = p.getViewport({ scale: 1 }); return { w: v.width, h: v.height }; });
            this.pages = doc.numPages;
            this.fitWidth = true;
            this.watchSize();
            this.layout(false);
          } else {
            this.engine = 'native';
            this.showNative();
          }
        } catch (e) {
          if (my === loadGen) this.error = 'Could not display this PDF. Use the download button to open it instead.';
        } finally {
          if (my === loadGen) this.loading = false;
        }
      },

      // ── pdf.js layout / rendering ────────────────────────────────────────
      layout: function (keepScroll) {
        if (!pdf || !sizes.length) return;
        var scroller = $('pdfpScroll'), host = $('pdfpPages');
        if (!scroller || !host) return;
        var avail = scroller.clientWidth - 24;
        if (avail < 60) return;                           // hidden / not laid out yet
        lastWidth = scroller.clientWidth;
        if (this.fitWidth) {
          var maxW = Math.max.apply(null, sizes.map(function (s) { return s.w; }));
          this.zoom = clamp(avail / (maxW * CSS_PER_PT) * 100, 10, MAX_ZOOM);
        }
        var scale = this.zoom / 100 * CSS_PER_PT;
        var ratio = (keepScroll && scroller.scrollHeight > 0)
          ? (scroller.scrollTop + scroller.clientHeight / 2) / scroller.scrollHeight : 0;

        var gen = ++renderGen;
        if (observer) observer.disconnect();
        host.innerHTML = '';
        host.classList.remove('native');
        observer = new IntersectionObserver(function (entries) {
          entries.forEach(function (en) {
            if (!en.isIntersecting) return;
            var div = en.target;
            if (div.dataset.done) return;
            div.dataset.done = '1';
            observer.unobserve(div);
            renderPage(div, parseInt(div.dataset.i, 10), scale, gen);
          });
        }, { root: scroller, rootMargin: '900px 0px' });

        for (var i = 0; i < sizes.length; i++) {
          var div = document.createElement('div');
          div.className = 'ide-pdf-page';
          div.dataset.i = String(i);
          div.style.width = Math.floor(sizes[i].w * scale) + 'px';
          div.style.height = Math.floor(sizes[i].h * scale) + 'px';
          host.appendChild(div);
          observer.observe(div);
        }
        scroller.scrollTop = keepScroll ? Math.max(0, ratio * scroller.scrollHeight - scroller.clientHeight / 2) : 0;
        this.onScroll();
      },

      watchSize: function () {                            // keep "fit width" correct when panels are resized
        if (resizeObs || !window.ResizeObserver) return;
        var self = this, t = null, scroller = $('pdfpScroll');
        if (!scroller) return;
        resizeObs = new ResizeObserver(function () {
          clearTimeout(t);
          t = setTimeout(function () {
            if (self.engine === 'pdfjs' && pdf && self.fitWidth && Math.abs(scroller.clientWidth - lastWidth) > 2) self.layout(true);
          }, 120);
        });
        resizeObs.observe(scroller);
      },

      // ── zoom ─────────────────────────────────────────────────────────────
      setZoom: function (z) {
        this.fitWidth = false;
        this.zoom = clamp(z, MIN_ZOOM, MAX_ZOOM);
        if (this.engine === 'native') this.showNative(); else this.layout(true);
      },
      zoomBy: function (dir) {
        var z = this.zoom, next;
        if (dir > 0) next = STEPS.find(function (s) { return s > z + 0.5; }) || MAX_ZOOM;
        else next = STEPS.slice().reverse().find(function (s) { return s < z - 0.5; }) || MIN_ZOOM;
        this.setZoom(next);
      },
      fit: function () {
        this.fitWidth = true;
        if (this.engine === 'native') this.showNative(); else this.layout(true);
      },
      onWheel: function (e) {                             // Ctrl/⌘ + wheel (also trackpad pinch) zooms the PDF, not the page
        if (!(e.ctrlKey || e.metaKey) || this.engine !== 'pdfjs') return;
        e.preventDefault();
        var now = Date.now();
        if (now - lastWheel < 90) return;
        lastWheel = now;
        this.zoomBy(e.deltaY < 0 ? 1 : -1);
      },
      onKey: function (e) {
        if (!(e.ctrlKey || e.metaKey)) return;
        if (e.key === '+' || e.key === '=') { e.preventDefault(); this.zoomBy(1); }
        else if (e.key === '-' || e.key === '_') { e.preventDefault(); this.zoomBy(-1); }
        else if (e.key === '0') { e.preventDefault(); this.fit(); }
      },

      // ── pages ────────────────────────────────────────────────────────────
      onScroll: function () {                             // which page is in view (throttled to one pass per frame)
        if (this.engine !== 'pdfjs' || scrollQueued) return;
        scrollQueued = true;
        var self = this;
        requestAnimationFrame(function () {
          scrollQueued = false;
          var scroller = $('pdfpScroll'), host = $('pdfpPages');
          if (!scroller || !host || !host.children.length) return;
          var probe = scroller.scrollTop + scroller.clientHeight * 0.3, cur = 1;
          for (var i = 0; i < host.children.length; i++) {
            if (host.children[i].offsetTop <= probe) cur = i + 1; else break;
          }
          if (cur !== self.page) self.page = cur;
        });
      },
      gotoPage: function (n) {
        if (!n || this.engine !== 'pdfjs') return;
        n = clamp(n, 1, this.pages || 1);
        var scroller = $('pdfpScroll'), host = $('pdfpPages');
        if (!scroller || !host || !host.children[n - 1]) return;
        scroller.scrollTop = host.children[n - 1].offsetTop - 8;
        this.page = n;
      },

      // ── native fallback ──────────────────────────────────────────────────
      showNative: function () {
        var host = $('pdfpPages');
        if (!host) return;
        host.innerHTML = '';
        host.classList.add('native');
        var frameEl = document.createElement('iframe');
        frameEl.className = 'ide-pdf-native';
        frameEl.title = this.currentName || 'Assignment PDF';
        frameEl.src = this.pdfUrl(this.fileId) + '#toolbar=1&navpanes=0&zoom=' + (this.fitWidth ? 'page-width' : Math.round(this.zoom));
        host.appendChild(frameEl);
      },

      // ── panel height ─────────────────────────────────────────────────────
      startResize: function (e) {
        e.preventDefault();
        var self = this, startY = e.clientY, startH = this.height;
        var main = document.querySelector('.ide-editor');
        var maxH = Math.max(180, (main ? main.clientHeight : 700) - 180);
        document.body.classList.add('ide-pdf-resizing');
        function move(ev) { self.height = clamp(startH + (ev.clientY - startY), 120, maxH); }
        function up() {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
          document.body.classList.remove('ide-pdf-resizing');
          lsSet('lt_pdfp_h', String(Math.round(self.height)));
          if (self.engine === 'pdfjs' && self.fitWidth) self.layout(true);
        }
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
      },
      nudgeHeight: function (d) {
        this.height = clamp(this.height + d, 120, 900);
        lsSet('lt_pdfp_h', String(Math.round(this.height)));
      },
      resetHeight: function () {
        this.height = Math.max(200, Math.round(window.innerHeight * 0.4));
        lsSet('lt_pdfp_h', String(this.height));
      }
    });
  });

  function renderPage(div, i, scale, gen) {
    var page = pageCache[i];
    if (!page) return;
    var vp = page.getViewport({ scale: scale });
    var dpr = window.devicePixelRatio || 1;
    var px = vp.width * vp.height * dpr * dpr;
    if (px > 16e6) dpr = Math.sqrt(16e6 / (vp.width * vp.height));   // cap canvas size at high zoom
    var c = document.createElement('canvas');
    c.width = Math.floor(vp.width * dpr);
    c.height = Math.floor(vp.height * dpr);
    c.style.width = Math.floor(vp.width) + 'px';
    c.style.height = Math.floor(vp.height) + 'px';
    var task = page.render({
      canvasContext: c.getContext('2d'),
      viewport: vp,
      transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null
    });
    task.promise.then(function () { if (gen === renderGen) div.appendChild(c); }).catch(function () { /* cancelled / replaced by a newer layout */ });
  }
})();
