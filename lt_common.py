"""Auth principals, access checks, JSON helpers and serializers shared by all blueprints."""
import os
import re
from datetime import datetime
from functools import wraps

from flask import g, jsonify, request, session

import lt_exec
from lt_db import jdump, jload, q, q1, run

DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
TIME_RE = re.compile(r"^\d{2}:\d{2}$")


def deep_enabled():
    """Deep Coding IDE on/off for the whole server (LT_DEEP_CODING=0 turns it off)."""
    return os.environ.get("LT_DEEP_CODING", "1") != "0"


def err(msg, code=400, **extra):
    return jsonify(ok=False, error=msg, **extra), code


def b(v):
    return bool(v)


def full_name(row, fallback=""):
    n = f"{row['first_name'] or ''} {row['last_name'] or ''}".strip()
    return n or fallback


# ── principals ───────────────────────────────────────────────────────────────

def current_user():
    uid = session.get("uid")
    return q1("SELECT * FROM users WHERE id=?", (uid,)) if uid else None


def ta_principal():
    """A TA acts only when the page sends X-LT-Actor: ta AND the session holds a TA link login."""
    if request.headers.get("X-LT-Actor") == "ta" and session.get("ta_id"):
        return q1("SELECT * FROM assistants WHERE id=? AND is_active=1", (session["ta_id"],))
    return None


def principal():
    ta = ta_principal()
    if ta:
        return {"role": "ta", "ta": ta, "user": None}
    u = current_user()
    if u and u["role"] == "instructor":
        return {"role": "instructor", "user": u, "ta": None}
    return None


def inst_api(manage=False, instructor_only=False):
    """Guard for /api/instructor/* style endpoints (instructor or TA principal)."""
    def deco(fn):
        @wraps(fn)
        def wrapper(*a, **kw):
            p = principal()
            if not p:
                return err("Not logged in.", 401)
            if p["role"] == "ta":
                if instructor_only:
                    return err("Not allowed for teaching assistants.", 403)
                if manage and not p["ta"]["assignment_management"]:
                    return err("Your assistant link cannot manage assignments.", 403)
            g.p = p
            return fn(*a, **kw)
        return wrapper
    return deco


def login_required_api(fn):
    @wraps(fn)
    def wrapper(*a, **kw):
        if not (current_user() or ta_principal()):
            return err("Not logged in.", 401)
        return fn(*a, **kw)
    return wrapper


# ── access checks (return the row or None) ───────────────────────────────────

def can_class(p, class_id):
    c = q1("SELECT * FROM classes WHERE id=?", (class_id,))
    if not c:
        return None
    if p["role"] == "ta":
        return c if p["ta"]["class_id"] == class_id else None
    return c if c["owner_id"] == p["user"]["id"] else None


def can_asn(p, asn_id):
    a = q1("SELECT * FROM assignments WHERE id=?", (asn_id,))
    if not a or not can_class(p, a["class_id"]):
        return None
    return a


def can_file(p, file_id):
    """Assignment-level file. Returns (file_row, assignment_row) or (None, None)."""
    f = q1("SELECT * FROM files WHERE id=? AND assignment_id IS NOT NULL", (file_id,))
    if not f:
        return None, None
    a = can_asn(p, f["assignment_id"])
    return (f, a) if a else (None, None)


def can_session(p, sid):
    s = q1("SELECT * FROM sessions WHERE id=?", (sid,))
    if not s or not can_asn(p, s["assignment_id"]):
        return None
    return s


def owns_session(p, s):
    """May this principal write to the session? Instructors: any; TAs: only their own threads."""
    return p["role"] == "instructor" or (s["ta_id"] and s["ta_id"] == p["ta"]["id"])


def actor_name(p):
    if p["role"] == "ta":
        return "TA: " + (p["ta"]["name"] or "Assistant")
    return full_name(p["user"], p["user"]["username"])


# ── validation ───────────────────────────────────────────────────────────────

def clean_due(payload):
    """-> (ok, due_date|None, due_time|None, error). Accepts due / due_date / due_time."""
    day = str(payload.get("due_date") or payload.get("due") or "").strip()[:10] or None
    tm = str(payload.get("due_time") or "").strip() or None
    try:
        if day:
            datetime.strptime(day, "%Y-%m-%d")
        if tm:
            datetime.strptime(tm, "%H:%M")
    except ValueError:
        return False, None, None, "Invalid date or time."
    return True, day, (tm if day else None), None


# ── file helpers ─────────────────────────────────────────────────────────────

def default_tags(name, language):
    n = (name or "").lower()
    ext = lt_exec.ext_of(n)
    if re.search(r"(^|[_\-.])test|test([_\-.]|$)|grader|autograd", n):
        return ["test"]
    if re.search(r"spec|readme|instruction|assignment|handout", n) or ext in ("md", "pdf", "docx", "html"):
        return ["assignment_spec"]
    if ext in ("csv", "json", "tsv", "txt", "xml"):
        return ["data"]
    if re.search(r"rubric|grading", n):
        return ["rubric"]
    if language in lt_exec.SOURCE_LANGS:
        return ["starter_code"]
    return ["reference"]


def quick_summary(name, language, text):
    """Offline fallback summary when no LLM is available."""
    lines = [l for l in (text or "").splitlines() if l.strip()]
    if not lines:
        return f"{name}: empty file."
    doc = re.search(r'"""(.+?)"""', text or "", re.S)
    if doc:
        first = doc.group(1).strip().splitlines()[0]
    else:
        first = next((re.sub(r"^\s*(#|//|/\*+|\*)\s*", "", l).strip() for l in lines
                      if re.match(r"\s*(#|//|/\*|\*)", l) and not l.startswith("#include") and not l.startswith("#!")), "")
    funcs = re.findall(r"^\s*(?:def|function|void|int|double|float|char|public\s+\w+|static\s+\w+)\s+(\w+)\s*\(", text or "", re.M)
    parts = [f"{(language or 'text').capitalize()} file, {len(lines)} non-empty lines."]
    if first:
        parts.append(first[:200])
    if funcs:
        parts.append("Defines: " + ", ".join(dict.fromkeys(funcs[:8])) + ".")
    return " ".join(parts)


def file_text(f):
    if not f["is_text"]:
        return None
    return bytes(f["data"] or b"").decode("utf-8", "replace")


def file_row_dict(f):
    """List-row shape (no content)."""
    tags = jload(f["tags"], []) if f["tags_customized"] else default_tags(f["name"], f["language"])
    return {
        "id": f["id"], "name": f["name"], "active": b(f["active"]), "starred": b(f["starred"]),
        "is_source": b(f["is_source"]), "has_main": b(f["has_main"]), "editable": b(f["is_text"]),
        "compilable": b(f["is_source"] and f["has_main"] and f["language"] in lt_exec.RUNNABLE),
        "mimetype": f["mimetype"], "language": f["language"], "size": f["size"],
        "summary": f["summary"] or "", "tags": tags, "tags_customized": b(f["tags_customized"]),
    }


def asn_dict(a):
    n_files = q1("SELECT COUNT(*) c FROM files WHERE assignment_id=?", (a["id"],))["c"]
    return {
        "id": a["id"], "class_id": a["class_id"], "title": a["title"], "name": a["title"],
        "description": a["description"] or "", "remarks_active": b(a["remarks_active"]),
        "active": b(a["active"]), "due": a["due_date"], "due_date": a["due_date"],
        "due_time": a["due_time"], "created_at": a["created_at"], "file_count": n_files,
        "deep_coding_enabled": deep_enabled(),
    }


def msg_count(sid):
    return q1("SELECT COUNT(*) c FROM messages WHERE session_id=? AND role IN ('user','assistant')", (sid,))["c"]


def add_message(sid, role, content, extra=None):
    from lt_db import ts
    run("INSERT INTO messages(session_id, role, content, extra, created_at) VALUES(?,?,?,?,?)",
        (sid, role, content, jdump(extra or {}), ts()))
    run("UPDATE sessions SET updated_at=? WHERE id=?", (ts(), sid))
