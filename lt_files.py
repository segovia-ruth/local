"""Assignment files, summaries, tags, compile & run, and the Generate-Hints workbench."""
import sqlite3
import threading

from flask import Blueprint, Response, g, jsonify, render_template, request

import lt_exec
import lt_llm
from lt_common import (can_asn, can_file, default_tags, err, file_row_dict, file_text, inst_api,
                       quick_summary)
from lt_db import DB_PATH, jdump, jload, new_id, q, q1, run, ts

bp = Blueprint("files", __name__)
MAX_UPLOAD = 15 * 1024 * 1024


# ── helpers ──────────────────────────────────────────────────────────────────

def siblings(asn_id):
    return {f["name"]: bytes(f["data"] or b"") for f in
            q("SELECT name, data FROM files WHERE assignment_id=? AND is_text=1", (asn_id,))}


def make_summary(name, language, text):
    """-> (summary, error). Uses the LLM when configured, else a heuristic."""
    if not lt_llm.available():
        return quick_summary(name, language, text), None
    try:
        s = lt_llm.complete(
            "You write short file descriptions for a coding-tutor's course materials. Reply with 2-3 plain "
            "sentences: what the file is, what it does, and anything a tutor should know. No markdown.",
            [{"role": "user", "content": f"File: {name}\n\n{(text or '')[:8000]}"}], max_tokens=300)
        return s, None
    except lt_llm.LLMUnavailable as e:
        return None, str(e)


def _bg_summaries(file_ids):
    """Background worker: its own sqlite connection (Flask's g isn't available in threads)."""
    con = sqlite3.connect(DB_PATH, timeout=30)
    con.row_factory = sqlite3.Row
    try:
        for fid in file_ids:
            f = con.execute("SELECT * FROM files WHERE id=?", (fid,)).fetchone()
            if not f or not f["is_text"]:
                continue
            text = bytes(f["data"] or b"").decode("utf-8", "replace")
            summary, error = make_summary(f["name"], f["language"], text)
            if summary:
                con.execute("UPDATE files SET summary=? WHERE id=?", (summary, fid))
            else:
                con.execute("INSERT INTO llm_tasks(id, assignment_id, file_id, kind, status, error, created_at) "
                            "VALUES(?,?,?,?,?,?,?)", (new_id(), f["assignment_id"], fid, "summary", "failed", error, ts()))
            con.commit()
    finally:
        con.close()


def store_file(asn_id, name, data, session_id=None):
    """Create or replace a file; returns its id."""
    info = lt_exec.detect(name, data)
    h = lt_exec.sha(data)
    where, args = ("assignment_id=? AND name=?", (asn_id, name)) if session_id is None else ("session_id=? AND name=?", (session_id, name))
    ex = q1(f"SELECT id FROM files WHERE {where}", args)
    text = data.decode("utf-8", "replace") if info["is_text"] else ""
    summary = ""
    if info["is_text"] and not (session_id is None and lt_llm.available()):
        summary = quick_summary(name, info["language"], text)       # LLM summaries arrive via background thread
    if ex:
        run("UPDATE files SET data=?, size=?, content_hash=?, mimetype=?, language=?, is_source=?, has_main=?, is_text=?, "
            "summary=? WHERE id=?", (data, len(data), h, info["mimetype"], info["language"], int(info["is_source"]),
                                     int(info["has_main"]), int(info["is_text"]), summary, ex["id"]))
        return ex["id"]
    fid = new_id()
    run("INSERT INTO files(id, assignment_id, session_id, name, mimetype, language, is_source, has_main, is_text, data, "
        "size, content_hash, summary, created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (fid, asn_id if session_id is None else None, session_id, name, info["mimetype"], info["language"],
         int(info["is_source"]), int(info["has_main"]), int(info["is_text"]), data, len(data), h, summary, ts()))
    return fid


def file_detail_dict(f):
    d = file_row_dict(f)
    text = file_text(f)
    cur = f["content_hash"]
    d.update({
        "content": text if text is not None else "",
        "content_error": None if text is not None else "Binary file — preview not available. Use Download.",
        "remarks": "", "available_tags": lt_exec.AVAILABLE_TAGS, "tag_labels": lt_exec.TAG_LABELS,
        "last_analysis": jload(f["last_analysis"], None), "last_analysis_at": f["last_analysis_at"],
        "analysis_stale": bool(f["last_analysis"]) and f["analysis_hash"] != cur,
        "last_run": jload(f["last_run"], None), "last_run_at": f["last_run_at"],
        "run_stale": bool(f["last_run"]) and f["run_hash"] != cur,
        "last_success_run": jload(f["last_success_run"], None), "last_success_run_at": f["last_success_run_at"],
        "success_stale": bool(f["last_success_run"]) and f["success_hash"] != cur,
        "compilation_hint": None, "hint_stale": False,
    })
    if f["assignment_id"]:
        prof = jload(q1("SELECT profile FROM assignments WHERE id=?", (f["assignment_id"],))["profile"], {})
        hint = (prof.get("hints") or {}).get(f["id"])
        if hint:
            d["compilation_hint"], d["compilation_hint_at"] = hint.get("text"), hint.get("at")
            d["hint_stale"] = hint.get("hash") != cur
    return d


# ── assignment files ─────────────────────────────────────────────────────────

@bp.get("/api/instructor/assignment_files")
@inst_api()
def files_list():
    if not can_asn(g.p, request.args.get("assignment_id", "")):
        return err("Assignment not found.", 404)
    rows = q("SELECT * FROM files WHERE assignment_id=? ORDER BY name COLLATE NOCASE", (request.args["assignment_id"],))
    return jsonify([file_row_dict(f) for f in rows])


@bp.post("/api/instructor/assignment_upload")
@inst_api(manage=True)
def files_upload():
    a = can_asn(g.p, request.form.get("assignment_id", ""))
    if not a:
        return err("Assignment not found.", 404)
    remarks = (request.form.get("remarks") or "").strip()
    if remarks:
        run("UPDATE assignments SET description=? WHERE id=?", (remarks, a["id"]))
    uploaded = []
    for f in request.files.getlist("file"):
        data = f.read(MAX_UPLOAD + 1)
        if len(data) > MAX_UPLOAD:
            return err(f"{f.filename} is larger than 15 MB.")
        name = (f.filename or "file").replace("\\", "/").rsplit("/", 1)[-1]
        uploaded.append({"id": store_file(a["id"], name, data), "name": name})
    if lt_llm.available():
        threading.Thread(target=_bg_summaries, args=([u["id"] for u in uploaded],), daemon=True).start()
    return jsonify(ok=True, uploaded=uploaded)


@bp.get("/api/instructor/file_detail")
@inst_api()
def file_detail():
    f, _ = can_file(g.p, request.args.get("file_id", ""))
    return jsonify(file_detail_dict(f)) if f else err("File not found.", 404)


@bp.post("/api/instructor/file_content")
@inst_api(manage=True)
def file_content_save():
    d = request.get_json(silent=True) or {}
    f, _ = can_file(g.p, d.get("file_id", ""))
    if not f:
        return err("File not found.", 404)
    if not f["is_text"]:
        return err("Binary files can't be edited.")
    content = d.get("content") or ""
    if f["is_source"]:
        risk, reasons = lt_exec.screen(content)
        if risk != "low" and not d.get("confirm"):
            return jsonify(needs_confirm=True, risk=risk, reasons=reasons)
    data = content.encode("utf-8")
    run("UPDATE files SET data=?, size=?, content_hash=? WHERE id=?", (data, len(data), lt_exec.sha(data), f["id"]))
    return jsonify(ok=True, reindexed=True)


@bp.get("/api/instructor/file_download")
@inst_api()
def file_download():
    f, _ = can_file(g.p, request.args.get("file_id", ""))
    if not f:
        return err("File not found.", 404)
    safe = f["name"].replace('"', "")
    return Response(bytes(f["data"] or b""), mimetype=f["mimetype"] or "application/octet-stream",
                    headers={"Content-Disposition": f'attachment; filename="{safe}"'})


def _flag(col):
    @inst_api(manage=True)
    def view():
        d = request.get_json(silent=True) or {}
        f, _ = can_file(g.p, d.get("file_id", ""))
        if not f:
            return err("File not found.", 404)
        key = "starred" if col == "starred" else "active"
        run(f"UPDATE files SET {key}=? WHERE id=?", (1 if d.get(key) else 0, f["id"]))
        return jsonify(ok=True, **{key: bool(d.get(key))})
    view.__name__ = f"set_{col}"
    return view


bp.add_url_rule("/api/instructor/star_file", view_func=_flag("starred"), methods=["POST"])
bp.add_url_rule("/api/instructor/toggle_file", view_func=_flag("active"), methods=["POST"])


@bp.post("/api/instructor/file_tags")
@inst_api(manage=True)
def file_tags():
    d = request.get_json(silent=True) or {}
    f, _ = can_file(g.p, d.get("file_id", ""))
    if not f:
        return err("File not found.", 404)
    tags = [t for t in dict.fromkeys(d.get("tags") or []) if t in lt_exec.AVAILABLE_TAGS]
    run("UPDATE files SET tags=?, tags_customized=1 WHERE id=?", (jdump(tags), f["id"]))
    return jsonify(ok=True, tags=tags, reindexed=True)


@bp.post("/api/instructor/generate_file_summary")
@inst_api(manage=True)
def gen_summary():
    f, _ = can_file(g.p, (request.get_json(silent=True) or {}).get("file_id", ""))
    if not f:
        return err("File not found.", 404)
    if not f["is_text"]:
        return err("No text to summarize in a binary file.")
    summary, error = make_summary(f["name"], f["language"], file_text(f))
    if not summary:
        return err(error or "Summary generation failed.", 502)
    run("UPDATE files SET summary=? WHERE id=?", (summary, f["id"]))
    return jsonify(ok=True, summary=summary)


# ── failed LLM tasks ─────────────────────────────────────────────────────────

@bp.get("/api/instructor/llm_tasks")
@inst_api(instructor_only=True)
def llm_tasks():
    aid = request.args.get("assignment_id", "")
    if not can_asn(g.p, aid):
        return err("Assignment not found.", 404)
    rows = q("SELECT t.*, f.name fname FROM llm_tasks t LEFT JOIN files f ON f.id=t.file_id "
             "WHERE t.assignment_id=? AND t.status='failed' ORDER BY t.created_at DESC", (aid,))
    return jsonify(tasks=[{"id": t["id"], "kind": t["kind"], "kind_label": "Summary", "file_id": t["file_id"],
                           "title": t["fname"] or "file", "name": t["fname"], "error": t["error"]} for t in rows])


@bp.post("/api/instructor/llm_tasks/<tid>/retry")
@inst_api(instructor_only=True)
def llm_retry(tid):
    t = q1("SELECT * FROM llm_tasks WHERE id=?", (tid,))
    if not t or not can_asn(g.p, t["assignment_id"]):
        return err("Task not found.", 404)
    f = q1("SELECT * FROM files WHERE id=?", (t["file_id"],))
    if not f:
        run("DELETE FROM llm_tasks WHERE id=?", (tid,))
        return jsonify(ok=True)
    summary, error = make_summary(f["name"], f["language"], file_text(f))
    if not summary:
        run("UPDATE llm_tasks SET error=? WHERE id=?", (error, tid))
        return jsonify(ok=False, error=error)
    run("UPDATE files SET summary=? WHERE id=?", (summary, f["id"]))
    run("DELETE FROM llm_tasks WHERE id=?", (tid,))
    return jsonify(ok=True)


# ── compile & run (instructor file modal) ────────────────────────────────────

@bp.post("/api/instructor/compile_analyze")
@inst_api()
def compile_analyze():
    f, a = can_file(g.p, (request.get_json(silent=True) or {}).get("file_id", ""))
    if not f:
        return err("File not found.", 404)
    if not f["is_text"]:
        return err("Binary files can't be analyzed.")
    sib = siblings(a["id"])
    res = lt_exec.analyze(f["name"], file_text(f), f["language"], list(sib))
    run("UPDATE files SET last_analysis=?, last_analysis_at=?, analysis_hash=? WHERE id=?",
        (jdump(res), ts(), f["content_hash"], f["id"]))
    return jsonify(res)


@bp.post("/api/instructor/compile_run")
@inst_api()
def compile_run():
    d = request.get_json(silent=True) or {}
    f, a = can_file(g.p, d.get("file_id", ""))
    if not f:
        return err("File not found.", 404)
    if not (f["is_source"] and f["has_main"] and f["language"] in lt_exec.RUNNABLE):
        return err("This file can't be compiled/run (no runnable entry point or unsupported language).")
    res = lt_exec.execute(f["name"], f["language"], siblings(a["id"]), d.get("stdin") or "")
    run("UPDATE files SET last_run=?, last_run_at=?, run_hash=? WHERE id=?", (jdump(res), ts(), f["content_hash"], f["id"]))
    if res.get("ok") and not res.get("security_rejected"):
        run("UPDATE files SET last_success_run=?, last_success_run_at=?, success_hash=? WHERE id=?",
            (jdump(res), ts(), f["content_hash"], f["id"]))
    return jsonify(res)


@bp.post("/api/instructor/compile_generate_dep")
@inst_api(manage=True)
def compile_generate_dep():
    d = request.get_json(silent=True) or {}
    f, a = can_file(g.p, d.get("file_id", ""))
    dep = (d.get("dep_name") or "").strip().replace("/", "").replace("\\", "")
    if not f or not dep:
        return err("File and dependency name are required.")
    try:
        code = lt_llm.complete(
            "Write a minimal, correct stand-in for the missing dependency so the main file compiles/runs. "
            "Reply with ONLY the file contents, no markdown fences.",
            [{"role": "user", "content": f"Main file {f['name']}:\n{file_text(f)[:6000]}\n\nMissing: {dep}"}], max_tokens=1500)
    except lt_llm.LLMUnavailable as e:
        return err(str(e), 502)
    code = code.strip().removeprefix("```").removesuffix("```").strip()
    store_file(a["id"], dep, code.encode("utf-8"))
    return jsonify(ok=True, filename=dep)


# ── Generate-Hints workbench ─────────────────────────────────────────────────

def _profile(a):
    return jload(a["profile"], {})


def _save_profile(aid, prof):
    run("UPDATE assignments SET profile=? WHERE id=?", (jdump(prof), aid))


def wb_payload(a):
    prof = _profile(a)
    rows = q("SELECT * FROM files WHERE assignment_id=? ORDER BY name COLLATE NOCASE", (a["id"],))
    src_sel, ctx_sel = prof.get("source_files"), prof.get("context_files")
    files, others, descs = [], [], []
    for f in rows:
        item = {"id": f["id"], "name": f["name"], "canonical": f["name"], "language": f["language"]}
        if f["is_source"]:
            item["included"] = f["name"] in src_sel if src_sel is not None else True
            files.append(item)
        else:
            item["included"] = f["name"] in ctx_sel if ctx_sel is not None else bool(f["active"])
            others.append(item)
        an = jload(f["last_analysis"], None)
        descs.append({"name": f["name"], "text": (an or {}).get("program_description") or f["summary"] or "",
                      "analyzed": bool(an)})
    hints = [{"file_id": fid, "name": next((f["name"] for f in rows if f["id"] == fid), fid), **h}
             for fid, h in (prof.get("hints") or {}).items()]
    return {"files": files, "others": others, "descriptions": descs, "hints": hints,
            "profile": {"remarks": prof.get("remarks", a["description"] or ""), "commands": prof.get("commands", []),
                        "sim_stdin": prof.get("sim_stdin", ""), "context_summary": prof.get("context_summary", ""),
                        "context_summary_at": prof.get("context_summary_at"),
                        "verified_output": prof.get("verified_output"), "presumed_output": prof.get("presumed_output")},
            "analyze": {"running": False}, "autogen": {"running": False, "note": prof.get("autogen_note", "")}}


def _wb():
    """Resolve + authorize the assignment for workbench calls (GET query or JSON body)."""
    d = request.get_json(silent=True) or {}
    aid = request.args.get("assignment_id") or d.get("assignment_id") or ""
    return can_asn(g.p, aid), d


def default_commands(names, language_of):
    cmds = []
    by_lang = {}
    for n in names:
        by_lang.setdefault(language_of(n), []).append(n)
    for lang, ns in by_lang.items():
        if lang == "python":
            cmds.append(f"python3 {ns[0]}")
        elif lang == "c":
            cmds += [f"gcc -o prog {' '.join(ns)} -lm", "./prog"]
        elif lang == "cpp":
            cmds += [f"g++ -o prog {' '.join(ns)}", "./prog"]
        elif lang == "java":
            cmds += [f"javac {' '.join(ns)}", f"java {ns[0].rsplit('.', 1)[0]}"]
        elif lang == "javascript":
            cmds.append(f"node {ns[0]}")
    return cmds


@bp.get("/instructor/compile_workbench")
def workbench_page():
    from lt_common import principal
    from flask import redirect
    p = principal()
    if not p:
        return redirect("/login")
    aid = request.args.get("assignment") or request.args.get("assignment_id") or ""
    g.p = p
    a = can_asn(p, aid)
    if not a:
        return err("Assignment not found.", 404)
    for tpl in ("instructor/compile_workbench.html", "compile_workbench.html"):
        try:
            return render_template(tpl, anon=False, assignment=asn_min(a), assignment_id=a["id"],
                                   wb={"assignmentId": a["id"]})
        except Exception as e:                                    # template missing/mismatched
            last = e
    return err(f"No compile_workbench template found ({last}).", 501)


def asn_min(a):
    return {"id": a["id"], "title": a["title"], "class_id": a["class_id"]}


@bp.get("/api/instructor/compile_profile")
@inst_api()
def wb_get():
    a, _ = _wb()
    return jsonify(wb_payload(a)) if a else err("Assignment not found.", 404)


@bp.post("/api/instructor/compile_profile/save")
@inst_api(manage=True)
def wb_save():
    a, d = _wb()
    if not a:
        return err("Assignment not found.", 404)
    prof = _profile(a)
    for k in ("source_files", "context_files", "remarks", "sim_stdin"):
        if k in d:
            prof[k] = d[k]
    if "commands_text" in d:
        prof["commands"] = [l.strip() for l in (d["commands_text"] or "").splitlines() if l.strip()]
    if "context_summary" in d:
        prof["context_summary"], prof["context_summary_at"] = d["context_summary"], ts()
    _save_profile(a["id"], prof)
    return jsonify(ok=True, **wb_payload(q1("SELECT * FROM assignments WHERE id=?", (a["id"],))))


@bp.post("/api/instructor/compile_profile/commands")
@inst_api(manage=True)
def wb_commands():
    a, d = _wb()
    if not a:
        return err("Assignment not found.", 404)
    names = d.get("source_files") or []
    rows = {f["name"]: f for f in q("SELECT * FROM files WHERE assignment_id=?", (a["id"],))}
    cmds = default_commands(names, lambda n: rows[n]["language"] if n in rows else "")
    reads_stdin = any(rows[n]["is_text"] and lt_exec.analyze(n, file_text(rows[n]), rows[n]["language"])["needs_stdin"]
                      for n in names if n in rows)
    return jsonify(ok=True, commands=cmds, note="seeded from file types", reads_stdin=reads_stdin)


@bp.post("/api/instructor/compile_profile/analyze")
@inst_api(manage=True)
def wb_analyze():
    a, _ = _wb()
    if not a:
        return err("Assignment not found.", 404)
    sib = siblings(a["id"])
    for f in q("SELECT * FROM files WHERE assignment_id=? AND is_source=1", (a["id"],)):
        res = lt_exec.analyze(f["name"], file_text(f), f["language"], list(sib))
        run("UPDATE files SET last_analysis=?, last_analysis_at=?, analysis_hash=? WHERE id=?",
            (jdump(res), ts(), f["content_hash"], f["id"]))
    return jsonify(ok=True)


def _entry_file(a, prof):
    chosen = prof.get("source_files")
    for f in q("SELECT * FROM files WHERE assignment_id=? AND is_source=1 AND has_main=1 ORDER BY name", (a["id"],)):
        if chosen is None or f["name"] in chosen:
            return f
    return None


@bp.post("/api/instructor/compile_profile/run")
@inst_api(manage=True)
def wb_run():
    a, d = _wb()
    if not a:
        return err("Assignment not found.", 404)
    prof = _profile(a)
    stdin = d.get("stdin") or prof.get("sim_stdin") or ""
    if d.get("presume"):
        f = _entry_file(a, prof)
        if not f:
            return err("No runnable source file selected.")
        try:
            out = lt_llm.complete("Predict the exact stdout of this program for the given stdin. Reply with only the output.",
                                  [{"role": "user", "content": f"{file_text(f)[:8000]}\n\nSTDIN:\n{stdin}\n\n{d.get('error_text', '')}"}], 600)
        except lt_llm.LLMUnavailable as e:
            return err(str(e), 502)
        prof["presumed_output"] = {"stdout": out, "at": ts()}
        _save_profile(a["id"], prof)
        return jsonify(ok=True, presumed=True, notes="", **wb_payload(q1("SELECT * FROM assignments WHERE id=?", (a["id"],))))
    f = _entry_file(a, prof)
    if not f:
        return err("No runnable source file (with a main entry point) is selected.")
    res = lt_exec.execute(f["name"], f["language"], siblings(a["id"]), stdin)
    if res.get("ok"):
        prof["verified_output"] = {"stdout": res["stdout"], "stderr": res["stderr"],
                                   "written_files": res.get("written_files", []), "at": ts()}
        prof.pop("presumed_output", None)
        _save_profile(a["id"], prof)
    payload = wb_payload(q1("SELECT * FROM assignments WHERE id=?", (a["id"],)))
    return jsonify({**payload, **res, "ok": res.get("ok", False), "stdin_used": stdin, "stdin_generated": False})


@bp.post("/api/instructor/compile_profile/stdin")
@inst_api(manage=True)
def wb_stdin():
    a, d = _wb()
    if not a:
        return err("Assignment not found.", 404)
    f = _entry_file(a, _profile(a))
    if not f:
        return jsonify(ok=True, needs_stdin=False, stdin="")
    needs = lt_exec.analyze(f["name"], file_text(f), f["language"])["needs_stdin"]
    if not needs:
        return jsonify(ok=True, needs_stdin=False, stdin="")
    try:
        out = lt_llm.complete("Produce realistic keyboard input (one entry per line) that lets this program run to completion. "
                              "Reply with only the input.", [{"role": "user", "content": file_text(f)[:8000]}], 300)
    except lt_llm.LLMUnavailable:
        out = d.get("current_stdin") or ""
    return jsonify(ok=True, needs_stdin=True, stdin=out)


@bp.post("/api/instructor/compile_profile/summarize")
@inst_api(manage=True)
def wb_summarize():
    a, d = _wb()
    if not a:
        return err("Assignment not found.", 404)
    prof = _profile(a)
    docs = "\n".join(f"- {f['name']}: {f['summary'] or ''}" for f in q("SELECT name, summary FROM files WHERE assignment_id=?", (a["id"],)))
    chat = "\n".join(f"{m.get('role')}: {m.get('text')}" for m in (d.get("transcript") or []))
    try:
        summary = lt_llm.complete("Write a concise 'program execution module' note for a tutoring assistant: how to build/run this "
                                  "assignment, expected behavior, and pitfalls.",
                                  [{"role": "user", "content": f"Assignment: {a['title']}\nFiles:\n{docs}\n\nInstructor chat:\n{chat}"}], 700)
    except lt_llm.LLMUnavailable as e:
        return err(str(e), 502)
    prof["context_summary"], prof["context_summary_at"] = summary, ts()
    _save_profile(a["id"], prof)
    return jsonify(ok=True, context_summary=summary, **wb_payload(q1("SELECT * FROM assignments WHERE id=?", (a["id"],))))


@bp.post("/api/instructor/compile_profile/chat")
@inst_api(manage=True)
def wb_chat():
    a, d = _wb()
    if not a:
        return err("Assignment not found.", 404)
    hist = [{"role": "assistant" if m.get("role") == "assistant" else "user", "content": str(m.get("text", ""))[:2000]}
            for m in (d.get("transcript") or [])[-12:]]
    docs = "\n".join(f"- {f['name']}: {f['summary'] or ''}" for f in q("SELECT name, summary FROM files WHERE assignment_id=?", (a["id"],)))
    try:
        reply = lt_llm.complete("You help an instructor prepare how a programming assignment is compiled and run for a tutoring "
                                f"assistant. Assignment: {a['title']}\nFiles:\n{docs}",
                                hist + [{"role": "user", "content": d.get("message", "")}], 700)
    except lt_llm.LLMUnavailable as e:
        return err(str(e), 502)
    return jsonify(ok=True, reply=reply, followups=[])


@bp.post("/api/instructor/compile_profile/autogen")
@inst_api(manage=True)
def wb_autogen():
    a, _ = _wb()
    if not a:
        return err("Assignment not found.", 404)
    prof = _profile(a)
    sib = siblings(a["id"])
    rows = q("SELECT * FROM files WHERE assignment_id=? AND is_source=1", (a["id"],))
    prof["hints"] = prof.get("hints") or {}
    for f in rows:
        res = lt_exec.analyze(f["name"], file_text(f), f["language"], list(sib))
        run("UPDATE files SET last_analysis=?, last_analysis_at=?, analysis_hash=? WHERE id=?",
            (jdump(res), ts(), f["content_hash"], f["id"]))
        if f["has_main"]:
            cmd = default_commands([f["name"]], lambda n, f=f: f["language"])
            prof["hints"][f["id"]] = {"text": " && ".join(cmd) + ("   (reads stdin)" if res["needs_stdin"] else ""),
                                      "at": ts(), "hash": f["content_hash"]}
    prof["commands"] = prof.get("commands") or default_commands(
        [f["name"] for f in rows if f["has_main"]], lambda n: next(f["language"] for f in rows if f["name"] == n))
    entry = _entry_file(a, prof)
    note = "analyzed files and seeded commands"
    if entry:
        res = lt_exec.execute(entry["name"], entry["language"], sib, prof.get("sim_stdin", ""))
        if res.get("ok"):
            prof["verified_output"] = {"stdout": res["stdout"], "stderr": res["stderr"],
                                       "written_files": res.get("written_files", []), "at": ts()}
            note += "; verified a real run"
    prof["autogen_note"] = note
    _save_profile(a["id"], prof)
    return jsonify(ok=True)
