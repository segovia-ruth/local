/*
 * core/qr.js — LT.qr: QR codes for share links (open a chat on a phone).
 *
 * Two surfaces, both in-page (never a browser popup — see the overlay-not-popups rule):
 *   LT.qr.pop(anchorEl, url, caption)  — small hover popover anchored to a button
 *   LT.qr.unpop()                      — hide the popover (mouseleave)
 *   LT.qr.show(url, caption, note)     — large centered overlay (click; good for
 *                                        projecting to a class), Esc / backdrop closes
 *
 * The QR image is generated entirely client-side by the vendored qrcode-generator lib
 * (static/vendor/qrcode/) as a data: URI, so it works under the strict CSP
 * (img-src 'self' data:) with no server endpoint. Styles live in static/css/qr.css.
 */
(function () {
  'use strict';
  window.LT = window.LT || {};

  function dataUrl(text, cellSize) {
    // type 0 = auto-pick the smallest QR version that fits; 'M' error correction.
    var qr = qrcode(0, 'M');
    qr.addData(String(text));
    qr.make();
    return qr.createDataURL(cellSize || 6, 8);
  }

  function el(tag, cls, parent) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (parent) parent.appendChild(e);
    return e;
  }

  // ── hover popover ─────────────────────────────────────────────────────────────
  var pop = null;
  function ensurePop() {
    if (pop) return pop;
    pop = el('div', 'qr-pop', document.body);
    pop.setAttribute('role', 'img');
    el('img', 'qr-pop-img', pop);
    el('div', 'qr-pop-caption', pop);
    return pop;
  }

  // ── centered overlay ──────────────────────────────────────────────────────────
  var overlay = null;
  function ensureOverlay() {
    if (overlay) return overlay;
    overlay = el('div', 'qr-overlay', document.body);
    overlay.id = 'qrOverlay';
    var box = el('div', 'qr-box', overlay);
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-label', 'QR code');
    el('div', 'qr-caption', box);
    el('img', 'qr-img', box);
    el('div', 'qr-url', box);
    el('div', 'qr-note', box);
    var close = el('button', 'btn small qr-close', box);
    close.type = 'button';
    close.textContent = 'Close';
    close.addEventListener('click', function () { LT.qr.close(); });
    overlay.addEventListener('click', function (ev) { if (ev.target === overlay) LT.qr.close(); });
    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape' && overlay.classList.contains('open')) LT.qr.close();
    });
    return overlay;
  }

  LT.qr = {
    pop: function (anchorEl, url, caption) {
      if (!url) return;
      var p = ensurePop();
      try { p.querySelector('.qr-pop-img').src = dataUrl(url, 4); } catch (e) { return; }
      p.querySelector('.qr-pop-caption').textContent = caption || 'Scan with your phone camera';
      p.classList.add('show');
      // Position under the anchor, clamped to the viewport.
      var r = anchorEl.getBoundingClientRect();
      var w = p.offsetWidth || 190;
      var left = Math.min(Math.max(8, r.left + r.width / 2 - w / 2), window.innerWidth - w - 8);
      var top = r.bottom + 8;
      if (top + (p.offsetHeight || 220) > window.innerHeight - 8) top = Math.max(8, r.top - (p.offsetHeight || 220) - 8);
      p.style.left = left + 'px';
      p.style.top = top + 'px';
    },
    unpop: function () { if (pop) pop.classList.remove('show'); },
    show: function (url, caption, note) {
      if (!url) return;
      this.unpop();
      var o = ensureOverlay();
      try { o.querySelector('.qr-img').src = dataUrl(url, 8); } catch (e) { return; }
      o.querySelector('.qr-caption').textContent = caption || 'Open on your phone';
      o.querySelector('.qr-url').textContent = url;
      o.querySelector('.qr-note').textContent = note || '';
      o.classList.add('open');
    },
    close: function () { if (overlay) overlay.classList.remove('open'); },
  };
})();
