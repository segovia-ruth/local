/*
 * core/html.js — shared rich-content safety layer (LeafTutor frontend).
 *
 * Single, audited sink for inserting model/user-derived rich HTML into the DOM.
 * The chat renderer already escapes every dynamic value before assembling HTML,
 * so this is defense-in-depth: it guarantees that even if some future code path
 * forgets to escape, no active content (scripts, inline handlers, javascript:
 * URLs, etc.) can reach the page.
 *
 * Auto-upgrade: if DOMPurify is vendored (static/vendor/dompurify/purify.min.js
 * loaded before this file), it is used automatically. Until then a conservative,
 * allowlist-based DOM sanitizer is used. Either way callers use the same API:
 *
 *     element.innerHTML = sanitizeRichHtml(renderMessageHtml(text));
 *
 * Exposed as both a global (for classic-script call sites) and on window.LT.
 */
(function (global) {
  "use strict";

  // Tags the chat/file renderers legitimately produce. img: chat image
  // attachments / program-generated images, served by our own inline routes —
  // src is restricted to same-origin paths below.
  var ALLOWED_TAGS = new Set([
    "a", "b", "br", "button", "code", "div", "em", "h1", "h2", "h3", "h4",
    "i", "img", "li", "ol", "p", "pre", "small", "span", "strong", "table",
    "tbody", "td", "th", "thead", "tr", "u", "ul"
  ]);

  // Attributes allowed on any element. Event handlers (on*) are never allowed.
  var ALLOWED_ATTR = new Set([
    "class", "title", "type", "href", "colspan", "rowspan", "aria-hidden",
    "aria-label", "role", "src", "alt", "loading", "width", "height"
  ]);

  // href/src values that begin with these (after trimming + lowercasing) are dropped.
  var DANGEROUS_URI = /^\s*(javascript|data|vbscript):/i;

  function sanitizeNode(node) {
    // Walk children first so we can safely unwrap/remove as we go.
    var child = node.firstChild;
    while (child) {
      var next = child.nextSibling;
      if (child.nodeType === 1) {            // element
        var tag = child.tagName.toLowerCase();
        if (!ALLOWED_TAGS.has(tag)) {
          // Disallowed element: drop it entirely (and its subtree). This is the
          // conservative choice for a tutoring app — unknown structure is noise.
          node.removeChild(child);
          child = next;
          continue;
        }
        // Scrub attributes.
        for (var i = child.attributes.length - 1; i >= 0; i--) {
          var attr = child.attributes[i];
          var name = attr.name.toLowerCase();
          var keep = ALLOWED_ATTR.has(name) || name.indexOf("data-") === 0;
          if (!keep) { child.removeAttribute(attr.name); continue; }
          if ((name === "href" || name === "src") && DANGEROUS_URI.test(attr.value)) {
            child.removeAttribute(attr.name);
          }
        }
        // <img> may only load from this app's own origin (relative path):
        // external/absolute image URLs are tracking/exfil vectors in chat.
        if (tag === "img") {
          var src = child.getAttribute("src") || "";
          if (!/^\/(?!\/)/.test(src)) { node.removeChild(child); child = next; continue; }
        }
        sanitizeNode(child);                 // recurse
      } else if (child.nodeType === 8) {     // comment
        node.removeChild(child);
      }
      // text nodes (nodeType 3) are kept as-is
      child = next;
    }
    return node;
  }

  function fallbackSanitize(dirty) {
    var tpl = document.createElement("template");
    tpl.innerHTML = String(dirty == null ? "" : dirty);
    sanitizeNode(tpl.content);
    return tpl.innerHTML;
  }

  function sanitizeRichHtml(dirty) {
    if (global.DOMPurify && typeof global.DOMPurify.sanitize === "function") {
      // Same-origin-only <img> rule, mirrored on the DOMPurify path (which
      // otherwise allows any http(s) image URL). Registered once.
      if (typeof global.DOMPurify.addHook === "function" && !global.DOMPurify.__ltImgHook) {
        global.DOMPurify.__ltImgHook = true;
        global.DOMPurify.addHook("afterSanitizeAttributes", function (node) {
          if (node.tagName === "IMG") {
            var src = node.getAttribute("src") || "";
            if (!/^\/(?!\/)/.test(src) && node.parentNode) node.parentNode.removeChild(node);
          }
        });
      }
      // DOMPurify keeps class + data-* by default; allow our one custom data attr explicitly.
      return global.DOMPurify.sanitize(String(dirty == null ? "" : dirty), {
        USE_PROFILES: { html: true },
        ADD_ATTR: ["data-option"]
      });
    }
    return fallbackSanitize(dirty);
  }

  global.sanitizeRichHtml = sanitizeRichHtml;
  global.LT = global.LT || {};
  global.LT.sanitizeRichHtml = sanitizeRichHtml;
})(window);
