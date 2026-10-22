/*
 * core/files.js — client mirror of the server's stored-file naming (LeafTutor frontend).
 *
 * The server sanitizes every uploaded/created file before storing it: display_name =
 * werkzeug secure_filename(filename); rel_dir = _clean_rel_dir(folder) (helpers/files.py).
 * Duplicate-name detection in the browser must therefore compare what the server will
 * STORE, not the raw picker name — "my file.py" collides with an already-uploaded
 * "my_file.py". This file is the ONE client copy of that mirror, shared by the Deep
 * Coding IDE and the chat page; keep it in sync with werkzeug's secure_filename and
 * helpers/files.py:_clean_rel_dir (verified byte-identical against both — see the
 * upload-overwrite tests).
 *
 * Exposed as window.LT.files:
 *   secureName(name)     → what the server's secure_filename() will store for `name`
 *   fileKey(dir, name)   → the (folder, name) identity key collision checks compare
 *   destKey(path, name)  → fileKey of where an upload will land; `path` may carry a
 *                          folder (rel_path), `name` is the File object's own name
 */
(function (global) {
  "use strict";

  // werkzeug secure_filename (POSIX server): NFKD → ASCII, '/' → ' ', whitespace runs
  // → '_', every char outside [A-Za-z0-9_.-] dropped, leading/trailing '.'/'_' trimmed.
  function secureName(s) {
    s = String(s || "").normalize("NFKD").replace(/[^\x00-\x7F]/g, "").replace(/\//g, " ");
    s = s.split(/\s+/).filter(Boolean).join("_");
    return s.replace(/[^A-Za-z0-9_.-]/g, "").replace(/^[._]+/, "").replace(/[._]+$/, "").slice(0, 255);
  }

  function fileKey(dir, name) { return (dir || "") + " " + (name || ""); }

  // Mirrors the /upload route exactly: display_name comes from the FILE's own name;
  // rel_dir is derived only when a rel_path accompanies the upload (path !== bare name,
  // matching the client send condition) as _clean_rel_dir(dirname(rel_path.strip())) —
  // dirname splits on '/' only, and absolute / '~' / drive / '..'-escaping /
  // empty-securing folders collapse to the root.
  function destKey(path, fileName) {
    var name = secureName(fileName || String(path || "").split("/").pop() || "");
    var dir = "";
    var p = String(path || "");
    if (p && p !== fileName) {
      var stripped = p.trim();
      var cut = stripped.lastIndexOf("/");
      var rawDir = (cut >= 0 ? stripped.slice(0, cut) : "").trim().replace(/\\/g, "/");
      if (rawDir && rawDir[0] !== "/" && rawDir[0] !== "~" && rawDir.indexOf(":") < 0) {
        var out = [], ok = true, segs = rawDir.split("/");
        for (var i = 0; i < segs.length; i++) {
          var t = segs[i].trim();
          if (!t || t === ".") continue;
          if (t === "..") { ok = false; break; }
          var safe = secureName(t);
          if (!safe) { ok = false; break; }
          out.push(safe);
        }
        if (ok) dir = out.join("/").slice(0, 400);
      }
    }
    return fileKey(dir, name);
  }

  global.LT = global.LT || {};
  global.LT.files = { secureName: secureName, fileKey: fileKey, destKey: destKey };
})(window);
