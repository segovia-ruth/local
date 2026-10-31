"""Student chat backend: sessions, threads, ask/retry, uploads, in-chat files, run, help flag.

Implements the endpoints static/js/pages/student/store.js calls:
  /start_session  /api/student/threads  /api/student/new_thread  /load_messages  /ask
  /upload  /api/student/session_files  /api/student/session_file_{detail,content,rename,analyze,run,download}
  /api/student/llm_tasks/<id>/retry  /api/student/flag_help  /api/student/orphan_sessions

Students may only touch their OWN sessions (kind='student', owner_user_id = them) of an
assignment they are actively enrolled in (class + assignment active).

SECURITY: session_file_run executes student code on this machine via lt_exec (keyword screen + timeout,
NOT a sandbox). Run the backend in a container/VM if students are untrusted.
"""
import re
from functools import wraps

from flask import Blueprint, Response, g, jsonify, redirect, render_template, request
from werkzeug.utils import secure_filename

import lt_exec
import lt_llm
from lt_chat import HISTORY, REFUSAL, TUTOR_REMINDER, build_context, expand_option, in_scope
from lt_common import add_message, b, current_user, deep_enabled, err, file_row_dict, file_text, full_name
from lt_db import jdump, jload, new_id, q, q1, run, ts, ts_minute

bp = Blueprint("student", __name__)
MAX_CHAT_FILE = 2 * 1024 * 1024
COMPILE_PROMPTS = {
    True: "The code compiled and ran. Please analyze the output and explain what it means.",
    False: "The compilation or run failed. Please help me understand the errors and how to fix them (hints first).",
}


# ── guards / lookups ─────────────────────────────────────────────────────────

def student_api(fn):
    @wraps(fn)
    def wrapper(*a, **kw):
        u = current_user()
        if not u:
            return err("Not logged in.", 401)
        if u["role"] != "student":
            return err("Students only.", 403)
        g.u = u
        return fn(*a, **kw)
    return wrapper


def _asn(aid):
    """Assignment the current student may use (enrolled+active, class active, assignment active)."""
    from lt_files import _student_asn
    return _student_asn(aid or "")


def _closed_resp():
    return jsonify(ok=False, error="This conversation has been closed by the instructor.", session_closed=True), 403


def _sess(sid, write=False):
    """-> (session_row, error_response). Own student sessions only."""
    s = q1("SELECT * FROM sessions WHERE id=? AND kind='student' AND owner_user_id=?", (sid or "", g.u["id"]))
    if not s or not _asn(s["assignment_id"]):
        return None, err("Conversation not found.", 404)
    if write and s["closed"]:
        return None, _closed_resp()
    return s, None


def _file(fid, write=False):
    """-> (session_row, file_row, error_response) for a file attached to one of the student's sessions."""
    f = q1("SELECT * FROM files WHERE id=? AND session_id IS NOT NULL", (fid or "",))
    if not f:
        return None, None, err("File not found.", 404)
    s, e = _sess(f["session_id"], write)
    return (s, f, None) if not e else (None, None, e)


def _create_session(aid):
    sid = new_id()
    u = g.u
    run("INSERT INTO sessions(id, assignment_id, kind, owner_user_id, student_name, username, title, started_at, updated_at) "
        "VALUES(?,?,?,?,?,?,?,?,?)",
        (sid, aid, "student", u["id"], full_name(u, u["username"]), u["username"], "", ts_minute(), ts()))
    return q1("SELECT * FROM sessions WHERE id=?", (sid,))


def _iso(t):
    """Stored naive-UTC strings -> ISO with Z so the browser shows local time."""
    if not t:
        return t
    t = t.replace(" ", "T")
    if len(t) == 16:
        t += ":00"
    return t if t.endswith("Z") else t + "Z"


def _compilable(f):
    return b(f["is_source"] and f["has_main"] and f["language"] in lt_exec.RUNNABLE)


def _threads(aid):
    rows = q("SELECT * FROM sessions WHERE assignment_id=? AND kind='student' AND owner_user_id=? ORDER BY started_at, rowid",
             (aid, g.u["id"]))
    return [{"session_id": s["id"], "number": i, "name": s["title"] or "", "started_at": _iso(s["started_at"]),
             "mode": s["mode"] or None, "closed": b(s["closed"])} for i, s in enumerate(rows, 1)]


def _usage(s):
    a = q1("SELECT class_id FROM assignments WHERE id=?", (s["assignment_id"],))
    if a:
        run("INSERT OR IGNORE INTO usage_events(day, user_key, class_id) VALUES(?,?,?)",
            (ts()[:10], g.u["id"], a["class_id"]))


# ── sessions & threads ───────────────────────────────────────────────────────

@bp.get("/api/student/orphan_sessions")
@student_api
def orphan_sessions():
    return jsonify(sessions=[])                       # custom (no-assignment) projects are not supported locally


@bp.post("/start_session")
@student_api
def start_session():
    aid = (request.get_json(silent=True) or {}).get("assignment_id") or ""
    if not _asn(aid):
        return err("Assignment not found.", 404)
    s = q1("SELECT * FROM sessions WHERE assignment_id=? AND kind='student' AND owner_user_id=? "
           "ORDER BY COALESCE(updated_at, started_at) DESC, rowid DESC", (aid, g.u["id"])) or _create_session(aid)
    return jsonify(ok=True, session_id=s["id"])


@bp.get("/api/student/threads")
@student_api
def threads():
    aid = request.args.get("assignment_id", "")
    if not aid:                                        # group_id (custom projects): none
        return jsonify(threads=[])
    if not _asn(aid):
        return err("Assignment not found.", 404)
    return jsonify(threads=_threads(aid))


@bp.post("/api/student/new_thread")
@student_api
def new_thread():
    aid = (request.get_json(silent=True) or {}).get("assignment_id") or ""
    if not _asn(aid):
        return err("Assignment not found.", 404)
    s = _create_session(aid)
    return jsonify(ok=True, session_id=s["id"], threads=_threads(aid))


@bp.post("/load_messages")
@student_api
def load_messages():
    s, e = _sess((request.get_json(silent=True) or {}).get("session_id"))
    if e:
        return e
    out = []
    for m in q("SELECT * FROM messages WHERE session_id=? AND role!='system' ORDER BY id", (s["id"],)):
        if m["role"] == "file":
            extra = jload(m["extra"], {})
            if extra.get("action") == "run":
                continue
            f = q1("SELECT * FROM files WHERE id=?", (extra.get("file_id"),))
            out.append({"role": "file", "content": m["content"], "filename": m["content"],
                        "file_id": f["id"] if f else None, "compilable": _compilable(f) if f else False,
                        "created_at": _iso(m["created_at"])})
        else:
            out.append({"role": m["role"], "content": m["content"], "created_at": _iso(m["created_at"])})
    return jsonify(ok=True, messages=out, closed=b(s["closed"]), help_flagged=b(s["help_flagged"]))


# ── asking the tutor ─────────────────────────────────────────────────────────

DEEP_RULES = """

You are working inside the student's code editor (Deep Coding). When a concrete change to their code is needed
(a compile/run error, or the student asks you to apply a change), explain the idea in 1-3 sentences, then give the
change as one or more SEARCH/REPLACE blocks in exactly this format - the editor offers an "Apply fix" button:

FILE: <filename>            (optional line; only when the change belongs to a file other than the open one)
<<<<<<< SEARCH
<existing lines copied verbatim, with enough context to be unique>
=======
<replacement lines>
>>>>>>> REPLACE

SEARCH must match the current code character for character. Keep each block small. Use SEARCH/REPLACE only to fix the specific compile or run error, one small block at a
time. Never use it to write the assignment's solution or to add features the learner has not built yet. For graded
work give hints, not solutions. For illustrations that should NOT be applied, use ordinary ``` code fences instead of these blocks."""


def _deep_addendum(code, language):
    extra = DEEP_RULES
    if code:
        extra += f"\n\nThe file currently open in the editor ({language or 'unknown language'}):\n```\n{str(code)[:12000]}\n```"
    return extra


def _too_much_code(text, limit=12):
    """True if the reply has a fenced code block longer than `limit` lines (a likely full solution)."""
    return any(len(blk.strip().splitlines()) > limit
               for blk in re.findall(r"```[^\n]*\n(.*?)```", text, re.S))


def _answer(s, extra=""):
    hist = q("SELECT role, content FROM messages WHERE session_id=? AND role IN ('user','assistant') ORDER BY id DESC LIMIT ?",
             (s["id"], HISTORY))
    msgs = [{"role": m["role"], "content": m["content"]} for m in reversed(hist)]
    while msgs and msgs[0]["role"] != "user":
        msgs.pop(0)
    if not msgs:
        raise lt_llm.LLMUnavailable("Nothing to answer yet.")
    system = build_context(s) + extra + TUTOR_REMINDER
    out = lt_llm.complete(system, msgs)
    if _too_much_code(out):                      # retry once with a stricter nudge
        out = lt_llm.complete(system + "\n\nYour last draft gave too much code. Rewrite it with hints and "
                              "questions only, and at most 4 lines of code.", msgs)
    return out


def _compile_turn(res, question):
    """The stored 'user' turn for a compile & run result (render.js turns it into a terminal card)."""
    ok = bool(res.get("ok"))
    lang = str(res.get("language") or "code")[:30]
    code = res.get("exit_code")
    head = f"[Code compiled & run ({lang})] Status: {'success' if ok else 'failed'}" + (f" (exit {code})" if code is not None else "")
    body = str(res.get("stdout") or res.get("output") or "")[:6000]
    text = f"{head}\n\nProgram output:\n{body}"
    if not ok and res.get("stderr"):
        text += f"\n\nErrors:\n{str(res['stderr'])[:6000]}"
    return text + "\n\n" + (question or COMPILE_PROMPTS[ok])


@bp.post("/ask")
@student_api
def ask():
    d = request.get_json(silent=True) or {}
    if d.get("session_id"):
        s, e = _sess(d["session_id"], write=True)
        if e:
            return e
    else:
        a = _asn(d.get("assignment_id"))
        if not a:
            return err("Open a conversation first.")
        s = _create_session(a["id"])
    question = (d.get("question") or "").strip()
    comp = d.get("compilation_result")
    if isinstance(comp, dict):
        content = _compile_turn(comp, question)
    else:
        names = [str(n) for n in (d.get("filenames") or [])][:10]
        if not question:
            if not names:
                return err("Enter a question.")
            question = f"Please look at the file(s) I uploaded ({', '.join(names)}), explain what they do and point out anything wrong."
        content = expand_option(s["id"], question)[:8000]
    add_message(s["id"], "user", content)
    _usage(s)
    if not isinstance(comp, dict) and not in_scope(s["id"], content):
        add_message(s["id"], "assistant", REFUSAL)
        return jsonify(answer=REFUSAL, failed=False)
    extra = _deep_addendum(d.get("code"), d.get("language")) if d.get("mode") == "deep_coding" else ""
    try:
        answer = _answer(s, extra)
    except lt_llm.LLMUnavailable as e:
        tid = new_id()
        run("INSERT INTO llm_tasks(id, assignment_id, file_id, kind, status, error, created_at) VALUES(?,?,?,?,?,?,?)",
            (tid, None, s["id"], "chat_reply", "failed", str(e), ts()))
        return jsonify(answer="⚠️ The tutor couldn't answer right now. Your message is saved — use Retry in a moment.\n\n"
                              f"Reason: {e}",
                       failed=True, task_id=tid)
    add_message(s["id"], "assistant", answer)
    return jsonify(answer=answer, failed=False)


@bp.post("/api/student/llm_tasks/<tid>/retry")
@student_api
def retry(tid):
    t = q1("SELECT * FROM llm_tasks WHERE id=? AND kind='chat_reply'", (tid,))
    if not t:
        return err("Task not found.", 404)
    s, e = _sess(t["file_id"], write=True)
    if e:
        return e
    try:
        answer = _answer(s, DEEP_RULES if s["mode"] == "deep_coding" else "")
    except lt_llm.LLMUnavailable as ex:
        return jsonify(ok=False, error=str(ex))
    add_message(s["id"], "assistant", answer)
    run("DELETE FROM llm_tasks WHERE id=?", (tid,))
    return jsonify(ok=True, answer=answer)


@bp.post("/api/student/rename_thread")
@student_api
def rename_thread():
    d = request.get_json(silent=True) or {}
    s, e = _sess(d.get("session_id"), write=True)
    if e:
        return e
    name = " ".join(str(d.get("name") or "").split())[:80]
    run("UPDATE sessions SET title=? WHERE id=?", (name, s["id"]))
    return jsonify(ok=True, name=name)


@bp.post("/api/student/flag_help")
@student_api
def flag_help():
    d = request.get_json(silent=True) or {}
    s, e = _sess(d.get("session_id"), write=True)
    if e:
        return e
    run("UPDATE sessions SET help_flagged=1, help_flagged_at=?, help_note=? WHERE id=?",
        (ts_minute(), str(d.get("note") or "").strip()[:500], s["id"]))
    return jsonify(ok=True)


# ── files in a chat ──────────────────────────────────────────────────────────

def _chip(f):
    return {"id": f["id"], "name": f["name"], "rel_dir": "", "origin": "upload", "available": True,
            "compilable": _compilable(f), "language": f["language"], "size": f["size"], "mimetype": f["mimetype"]}


@bp.get("/api/student/session_files")
@student_api
def session_files():
    s, e = _sess(request.args.get("session_id"))
    if e:
        return e
    rows = q("SELECT * FROM files WHERE session_id=? ORDER BY created_at DESC, name", (s["id"],))
    return jsonify(ok=True, files=[_chip(f) for f in rows])


@bp.post("/upload")
@student_api
def upload():
    from lt_files import store_file
    if request.form.get("session_id"):
        s, e = _sess(request.form["session_id"], write=True)
        if e:
            return e
    else:
        a = _asn(request.form.get("assignment_id"))
        if not a:
            return err("Open a conversation first.")
        s = _create_session(a["id"])
    f = request.files.get("file")
    if not f:
        return err("No file uploaded.")
    data = f.read(MAX_CHAT_FILE + 1)
    if len(data) > MAX_CHAT_FILE:
        return err("Files attached to a chat are limited to 2 MB.", 413)
    name = secure_filename((f.filename or "file").replace("\\", "/").rsplit("/", 1)[-1])[:100] or "file"
    fid = store_file(None, name, data, session_id=s["id"])
    add_message(s["id"], "file", name, {"file_id": fid, "action": "attach"})
    row = q1("SELECT * FROM files WHERE id=?", (fid,))
    return jsonify(status="ok", filename=name, unique_name=name, file_id=fid,
                   compilable=_compilable(row), language=row["language"])


@bp.get("/api/student/session_file_detail")
@student_api
def file_detail():
    from lt_files import file_detail_dict
    s, f, e = _file(request.args.get("file_id"))
    if e:
        return e
    d = file_detail_dict(f)
    d["editable"] = b(f["is_text"]) and not s["closed"]
    d["stdin"] = f["stdin"] or ""
    return jsonify(d)


@bp.post("/api/student/session_file_content")
@student_api
def file_save():
    d = request.get_json(silent=True) or {}
    s, f, e = _file(d.get("file_id"), write=True)
    if e:
        return e
    if not f["is_text"]:
        return err("Binary files can't be edited.")
    data = (d.get("content") or "").encode("utf-8")
    if len(data) > MAX_CHAT_FILE:
        return err("File is too large.")
    info = lt_exec.detect(f["name"], data)
    run("UPDATE files SET data=?, size=?, content_hash=?, has_main=? WHERE id=?",
        (data, len(data), lt_exec.sha(data), int(info["has_main"]), f["id"]))
    return jsonify(ok=True)


@bp.post("/api/student/session_file_rename")
@student_api
def file_rename():
    d = request.get_json(silent=True) or {}
    s, f, e = _file(d.get("file_id"), write=True)
    if e:
        return e
    name = secure_filename(str(d.get("filename") or "").replace("\\", "/").rsplit("/", 1)[-1])[:100]
    if not name:
        return err("Enter a file name.")
    if q1("SELECT 1 FROM files WHERE session_id=? AND name=? AND id!=?", (s["id"], name, f["id"])):
        return err("A file with that name already exists in this conversation.", 409)
    info = lt_exec.detect(name, bytes(f["data"] or b""))
    run("UPDATE files SET name=?, language=?, mimetype=?, is_source=?, has_main=? WHERE id=?",
        (name, info["language"], info["mimetype"], int(info["is_source"]), int(info["has_main"]), f["id"]))
    nf = q1("SELECT * FROM files WHERE id=?", (f["id"],))
    return jsonify(ok=True, file={"name": nf["name"], "language": nf["language"], "compilable": _compilable(nf),
                                  "editable": b(nf["is_text"])})


def _siblings(sid):
    return {r["name"]: bytes(r["data"] or b"") for r in
            q("SELECT name, data FROM files WHERE session_id=? AND is_text=1", (sid,))}


@bp.post("/api/student/session_file_analyze")
@student_api
def file_analyze():
    s, f, e = _file((request.get_json(silent=True) or {}).get("file_id"), write=True)
    if e:
        return e
    if not f["is_text"]:
        return err("Binary files can't be analyzed.")
    res = lt_exec.analyze(f["name"], file_text(f), f["language"], list(_siblings(s["id"])))
    run("UPDATE files SET last_analysis=?, last_analysis_at=?, analysis_hash=? WHERE id=?",
        (jdump(res), ts(), f["content_hash"], f["id"]))
    return jsonify(res)


@bp.post("/api/student/session_file_run")
@student_api
def file_run():
    d = request.get_json(silent=True) or {}
    s, f, e = _file(d.get("file_id"), write=True)
    if e:
        return e
    if not _compilable(f):
        return err("This file can't be compiled/run.")
    res = lt_exec.execute(f["name"], f["language"], _siblings(s["id"]), d.get("stdin") or "")
    res["language"] = f["language"]
    run("UPDATE files SET last_run=?, last_run_at=?, run_hash=?, issue_dismissed=0 WHERE id=?",
        (jdump(res), ts(), f["content_hash"], f["id"]))
    return jsonify(res)


@bp.get("/api/student/session_file_download")
@student_api
def file_download():
    s, f, e = _file(request.args.get("file_id"))
    if e:
        return e
    safe = f["name"].replace('"', "").replace("\r", "").replace("\n", "")
    return Response(bytes(f["data"] or b""), mimetype=f["mimetype"] or "application/octet-stream",
                    headers={"Content-Disposition": f'attachment; filename="{safe}"'})


# ── conversation / Deep Coding mode ──────────────────────────────────────────

@bp.post("/api/session_mode")
@student_api
def session_mode():
    d = request.get_json(silent=True) or {}
    s, e = _sess(d.get("session_id"))
    if e:
        return e
    if d.get("mode") not in ("conversation", "deep_coding"):
        return err("Unknown mode.")
    run("UPDATE sessions SET mode=? WHERE id=?", (d["mode"], s["id"]))
    return jsonify(ok=True, mode=d["mode"])


@bp.get("/deep")
def deep_page():
    u = current_user()
    if not u:
        return redirect("/login")
    if u["role"] != "student":
        return redirect("/instructor")
    g.u = u
    s, e = _sess(request.args.get("session_id"))
    if e or not deep_enabled():
        return render_template("deep_unavailable.html", anon=False), 403
    # custom (no-assignment) conversations have no assignment row — don't crash on them
    a = q1("SELECT * FROM assignments WHERE id=?", (s["assignment_id"],)) if s["assignment_id"] else None
    run("UPDATE sessions SET mode='deep_coding' WHERE id=?", (s["id"],))      # remembered for this conversation
    return render_template("ide.html", anon=False, deep_session_id=s["id"],
                           deep_assignment_id=a["id"] if a else "",
                           deep_assignment_title=a["title"] if a else "Conversation",
                           deep_cap_bytes=20 * 1024 * 1024,
                           deep_closed=b(s["closed"]),
                           deep_chat_url=("/student?assignment=" + a["id"]) if a else ("/student?session=" + s["id"]))


# ── Deep Coding: assignment PDF preview ──────────────────────────────────────

def _deep_pdfs(s):
    """Assignment PDFs a student may read in the preview: active files that are PDFs and tagged
    'assignment_spec' (the default tag for PDFs unless the name looks like a test/grader, or the
    instructor re-tagged it). Tests, rubrics and other reference material stay hidden."""
    out = []
    for f in q("SELECT * FROM files WHERE assignment_id=? AND active=1 ORDER BY name", (s["assignment_id"],)):
        is_pdf = (f["mimetype"] or "").lower() == "application/pdf" or (f["name"] or "").lower().endswith(".pdf")
        if is_pdf and "assignment_spec" in file_row_dict(f)["tags"]:
            out.append(f)
    return out


@bp.get("/api/deep/assignment_pdfs")
@student_api
def deep_assignment_pdfs():
    s, e = _sess(request.args.get("session_id"))
    if e:
        return e
    return jsonify(ok=True, files=[{"id": f["id"], "name": f["name"], "size": f["size"]} for f in _deep_pdfs(s)])


@bp.get("/api/deep/assignment_pdf")
@student_api
def deep_assignment_pdf():
    s, e = _sess(request.args.get("session_id"))
    if e:
        return e
    f = next((x for x in _deep_pdfs(s) if x["id"] == request.args.get("file_id")), None)
    if not f:
        return err("PDF not found.", 404)
    safe = f["name"].replace('"', "").replace("\r", "").replace("\n", "")
    disp = "attachment" if request.args.get("download") else "inline"
    return Response(bytes(f["data"] or b""), mimetype="application/pdf",
                    headers={"Content-Disposition": f'{disp}; filename="{safe}"', "Cache-Control": "private, no-store"})


# ── Deep Coding API ──────────────────────────────────────────────────────────

@bp.post("/api/deep/new_file")
@student_api
def deep_new_file():
    from lt_files import store_file
    d = request.get_json(silent=True) or {}
    s, e = _sess(d.get("session_id"), write=True)
    if e:
        return e
    name = secure_filename(str(d.get("filename") or "").replace("\\", "/").rsplit("/", 1)[-1])[:100]
    if not name:
        return err("Enter a valid file name.")
    if q1("SELECT 1 FROM files WHERE session_id=? AND name=?", (s["id"], name)):
        return err(f"A file named {name} already exists.", 409)
    fid = store_file(None, name, b"", session_id=s["id"])
    return jsonify(ok=True, file=_chip(q1("SELECT * FROM files WHERE id=?", (fid,))))


@bp.post("/api/deep/delete_file")
@student_api
def deep_delete_file():
    s, f, e = _file((request.get_json(silent=True) or {}).get("file_id"), write=True)
    if e:
        return e
    run("DELETE FROM messages WHERE session_id=? AND role='file' AND extra LIKE ?",
        (s["id"], f'%"file_id": "{f["id"]}"%'))
    run("DELETE FROM files WHERE id=?", (f["id"],))
    return jsonify(ok=True)


@bp.post("/api/deep/rename_file")
@student_api
def deep_rename_file():
    return file_rename()


@bp.post("/api/deep/save_stdin")
@student_api
def deep_save_stdin():
    d = request.get_json(silent=True) or {}
    s, f, e = _file(d.get("file_id"), write=True)
    if e:
        return e
    run("UPDATE files SET stdin=? WHERE id=?", (str(d.get("stdin") or "")[:65536], f["id"]))
    return jsonify(ok=True)


def _gen_stdin(f):
    """Ask the LLM for realistic keyboard input that lets the program finish. Raises LLMUnavailable."""
    return lt_llm.complete("Produce realistic keyboard input (one entry per line) that lets this program run to completion. "
                           "Reply with only the input.", [{"role": "user", "content": (file_text(f) or "")[:8000]}], 300)


@bp.post("/api/deep/suggest_stdin")
@student_api
def deep_suggest_stdin():
    d = request.get_json(silent=True) or {}
    s, f, e = _file(d.get("file_id"), write=True)
    if e:
        return e
    current = str(d.get("current_stdin") or "")
    if not lt_exec.analyze(f["name"], file_text(f) or "", f["language"])["needs_stdin"]:
        return jsonify(ok=True, stdin=current)                     # nothing to generate
    try:
        return jsonify(ok=True, stdin=_gen_stdin(f).strip("\n")[:65536])
    except lt_llm.LLMUnavailable as ex:
        return err(str(ex), 502)


@bp.post("/api/deep/run_file")
@student_api
def deep_run_file():
    d = request.get_json(silent=True) or {}
    s, f, e = _file(d.get("file_id"), write=True)
    if e:
        return e
    if not _compilable(f):
        return err("This file can't be compiled/run.")
    stdin, generated = str(d.get("stdin") or "")[:65536], False
    if not stdin.strip() and lt_exec.analyze(f["name"], file_text(f) or "", f["language"])["needs_stdin"] and lt_llm.available():
        try:
            stdin = _gen_stdin(f).strip("\n")[:65536]
            generated = bool(stdin.strip())
        except lt_llm.LLMUnavailable:
            pass
    res = lt_exec.execute(f["name"], f["language"], _siblings(s["id"]), stdin)
    res["language"] = f["language"]
    if generated:
        res["stdin_generated"], res["stdin_used"] = True, stdin
    run("UPDATE files SET last_run=?, last_run_at=?, run_hash=?, issue_dismissed=0, stdin=? WHERE id=?",
        (jdump(res), ts(), f["content_hash"], stdin, f["id"]))
    return jsonify(res)


@bp.post("/api/deep/check_file")
@student_api
def deep_check_file():
    """freeCodeCamp-style check: run the instructor's test file(s) for this assignment against the student's code."""
    d = request.get_json(silent=True) or {}
    s, f, e = _file(d.get("file_id"), write=True)
    if e:
        return e
    tests = [t for t in q("SELECT * FROM files WHERE assignment_id=? AND active=1 AND is_text=1 ORDER BY name", (s["assignment_id"],))
             if "test" in file_row_dict(t)["tags"] and t["language"] == f["language"]]
    if not tests:
        return jsonify(ok=False, has_tests=False,
                       error="This assignment has no checks for this language yet. Your instructor can add a test file "
                             "(tag it 'Tests / grader') to turn on 'Check my code'.")
    files = _siblings(s["id"])
    results, all_tests = [], []
    for t in tests:
        r = lt_exec.check(files, t["name"], bytes(t["data"] or b""), t["language"], str(d.get("stdin") or "")[:65536])
        if r.get("error"):
            return jsonify(ok=False, has_tests=True, error=r["error"])
        results.append(r)
        all_tests += r["tests"]
    passed = sum(r["passed"] for r in results)
    total = sum(r["total"] for r in results)
    out = {"ok": passed == total and total > 0, "has_tests": True, "passed": passed, "total": total,
           "tests": all_tests, "output": results[0]["output"] if len(results) == 1 else "\n".join(r["output"] for r in results)}
    run("UPDATE files SET last_run=?, last_run_at=?, run_hash=? WHERE id=?", (jdump(out), ts(), f["content_hash"], f["id"]))
    return jsonify(out)


# apply_fix: SEARCH/REPLACE edits, atomic across files, then a verification run ------------------

def _indent(line):
    return line[:len(line) - len(line.lstrip())]


def _apply_edit(content, search, replace):
    """-> (new_content, reanchored, error_reason, nearby). Exact match first, then a whitespace-tolerant one."""
    if not search.strip():
        return content, False, "The SEARCH block is empty.", ""
    n = content.count(search)
    if n == 1:
        return content.replace(search, replace, 1), False, None, ""
    if n > 1:
        return content, False, f"The SEARCH text matches {n} places — it needs more surrounding lines.", ""
    clines, slines = content.split("\n"), search.strip("\n").split("\n")
    key = [l.strip() for l in slines]
    hits = [i for i in range(len(clines) - len(slines) + 1) if [l.strip() for l in clines[i:i + len(slines)]] == key]
    if len(hits) == 1:
        i = hits[0]
        s_ind, m_ind = _indent(slines[0]), _indent(clines[i])
        rlines = replace.split("\n")
        if m_ind != s_ind and m_ind.startswith(s_ind):
            rlines = [(m_ind[len(s_ind):] + l) if l.strip() else l for l in rlines]
        return "\n".join(clines[:i] + rlines + clines[i + len(slines):]), True, None, ""
    import difflib
    close = difflib.get_close_matches(slines[0].strip(), [l.strip() for l in clines], n=1, cutoff=0.5)
    nearby = ""
    if close:
        j = next(i for i, l in enumerate(clines) if l.strip() == close[0])
        nearby = "\n".join(f"{k + 1}: {clines[k]}" for k in range(max(0, j - 1), min(len(clines), j + 3)))
    reason = "The SEARCH text matches more than one place." if len(hits) > 1 else "The SEARCH text was not found (the code may have changed)."
    return content, False, reason, nearby


@bp.post("/api/deep/apply_fix")
@student_api
def deep_apply_fix():
    d = request.get_json(silent=True) or {}
    s, f, e = _file(d.get("file_id"), write=True)
    if e:
        return e
    edits = d.get("edits") or []
    if not isinstance(edits, list) or not edits or len(edits) > 20:
        return err("No edits to apply.")
    rows = {r["name"]: r for r in q("SELECT * FROM files WHERE session_id=? AND is_text=1", (s["id"],))}
    changed, failures, notes, reanchored = {}, [], [], False
    for ed in edits:
        target = secure_filename(str((ed or {}).get("target") or f["name"]).replace("\\", "/").rsplit("/", 1)[-1]) or f["name"]
        row = rows.get(target) or rows.get(str(ed.get("target") or ""))
        if not row:
            failures.append({"target": target, "reason": f"There is no file named {target} in this project."})
            continue
        cur = changed.get(row["name"], file_text(row))
        new, re_, reason, nearby = _apply_edit(cur, str(ed.get("search") or ""), str(ed.get("replace") or ""))
        if reason:
            failures.append({"target": row["name"], "reason": reason, **({"nearby": nearby} if nearby else {})})
        elif len(new.encode("utf-8")) > MAX_CHAT_FILE:
            failures.append({"target": row["name"], "reason": "The result would be too large."})
        else:
            changed[row["name"]] = new
            reanchored = reanchored or re_
            if row["name"] != f["name"]:
                note = f"Fix applied to {row['name']}."
                if note not in notes:
                    notes.append(note)
    if failures:                                           # atomic: nothing was written
        return jsonify(ok=False, phase="locate", failures=failures)
    out_files = []
    try:
        for name, text in changed.items():
            data = text.encode("utf-8")
            info = lt_exec.detect(name, data)
            run("UPDATE files SET data=?, size=?, content_hash=?, has_main=? WHERE id=?",
                (data, len(data), lt_exec.sha(data), int(info["has_main"]), rows[name]["id"]))
            out_files.append({"file_id": rows[name]["id"], "name": name, "content": text})
    except Exception as ex:                                # disk/DB failure partway
        return jsonify(ok=False, phase="apply", failures=[{"target": "", "reason": str(ex)}])
    # verify: run the open file (or the first changed runnable file) once
    entry = None
    for name in [f["name"]] + [n for n in changed if n != f["name"]]:
        r = q1("SELECT * FROM files WHERE session_id=? AND name=?", (s["id"], name))
        if r and _compilable(r):
            entry = r
            break
    verify, res = {"attempted": False, "achieved": False, "corrections": 0, "notes": []}, None
    if entry:
        stdin = str(d.get("stdin") or "")[:65536]
        res = lt_exec.execute(entry["name"], entry["language"], _siblings(s["id"]), stdin)
        res["language"] = entry["language"]
        run("UPDATE files SET last_run=?, last_run_at=?, run_hash=?, stdin=? WHERE id=?",
            (jdump(res), ts(), entry["content_hash"], stdin, entry["id"]))
        ok = bool(res.get("ok"))
        first = next((l for l in reversed((res.get("stderr") or res.get("output") or "").splitlines()) if l.strip()), "")
        verify = {"attempted": True, "achieved": ok, "corrections": 0,
                  "notes": ["The program ran successfully after the fix." if ok else ("It still fails after the fix: " + first[:200])]}
    return jsonify(ok=True, files=out_files, reanchored=reanchored, stage_notes=notes, verify=verify,
                   run=res, entry_file_id=entry["id"] if entry else None)
