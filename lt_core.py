"""Auth, page routes, classes, roster, teaching assistants, assignments, calendar."""
import csv
import io
import re
import secrets
from datetime import datetime
from urllib.parse import quote

from flask import (Blueprint, g, jsonify, redirect, render_template, render_template_string,
                   request, session)
from werkzeug.security import check_password_hash, generate_password_hash

from lt_common import (asn_dict, b, can_asn, can_class, clean_due, current_user, err, full_name,
                       inst_api, login_required_api, principal, ta_principal)
from lt_db import future, new_id, now_dt, q, q1, run, ts

bp = Blueprint("core", __name__)
EMAIL_RE = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")


# ── helpers ──────────────────────────────────────────────────────────────────

def make_user(username, password, role, first="", last="", email=None):
    uid = new_id()
    run("INSERT INTO users(id, username, email, password_hash, first_name, last_name, role, created_at) "
        "VALUES(?,?,?,?,?,?,?,?)",
        (uid, username.lower(), (email or username).lower(),
         generate_password_hash(password) if password else None, first, last, role, ts()))
    return uid


def error_page(heading, message, detail="", status=400):
    try:
        return render_template("local_error.html", heading=heading, message=message, detail=detail), status
    except Exception:
        return f"<h1>{heading}</h1><p>{message}</p><pre>{detail}</pre>", status


def home_for(user):
    return "/courses" if user["role"] == "instructor" else "/welcome"


def class_dict(c):
    owner = q1("SELECT * FROM users WHERE id=?", (c["owner_id"],))
    return {"id": c["id"], "name": c["name"], "term": c["term"] or "", "code": c["code"] or "",
            "description": c["description"] or "", "is_active": b(c["is_active"]),
            "instructor": full_name(owner, owner["username"]) if owner else "",
            "student_count": q1("SELECT COUNT(*) n FROM enrollments WHERE class_id=?", (c["id"],))["n"]}


def visible_classes():
    """Classes the current login can see: owned (instructor), their class (TA) or enrolled (student)."""
    ta = ta_principal()
    if ta:
        return q("SELECT * FROM classes WHERE id=?", (ta["class_id"],))
    u = current_user()
    if not u:
        return None
    if u["role"] == "instructor":
        return q("SELECT * FROM classes WHERE owner_id=? ORDER BY created_at", (u["id"],))
    return q("SELECT c.* FROM classes c JOIN enrollments e ON e.class_id=c.id "
             "WHERE e.user_id=? AND e.active=1 AND c.is_active=1 ORDER BY c.created_at", (u["id"],))


def page_user(role=None):
    u = current_user()
    if not u or (role and u["role"] != role):
        return None
    return u


# ── auth ─────────────────────────────────────────────────────────────────────

@bp.get("/")
@bp.get("/login")
def login_page():
    u = current_user()
    if u:
        return redirect(home_for(u))
    return render_template("LT_loging_slight_mu.html")


@bp.post("/login")
def login_submit():
    data = request.get_json(silent=True) or request.form
    ident = (data.get("username") or data.get("email") or "").strip().lower()
    pw = data.get("password") or ""
    u = q1("SELECT * FROM users WHERE username=? OR email=?", (ident, ident))
    if not u or not u["password_hash"] or not check_password_hash(u["password_hash"], pw):
        msg = "Invalid username/email or password."
        if request.is_json or request.headers.get("X-Requested-With"):
            return jsonify(ok=False, error=msg, next=None), 401
        return render_template("LT_loging_slight_mu.html", error=msg), 401
    session.clear()
    session["uid"] = u["id"]
    session.permanent = True
    dest = home_for(u)
    if request.is_json or request.headers.get("X-Requested-With"):
        return jsonify(ok=True, next=dest)
    return redirect(dest, 303)


@bp.route("/logout", methods=["GET", "POST"])
def logout():
    session.clear()
    return redirect("/login")


@bp.get("/api/me")
def api_me():
    u = current_user()
    if not u:
        ta = ta_principal()
        if ta:
            return jsonify(logged_in=True, role="ta", name=ta["name"], user_id=ta["id"], email=ta["email"] or "")
        return jsonify(logged_in=False)
    return jsonify(logged_in=True, user_id=u["id"], username=u["username"], email=u["email"],
                   first_name=u["first_name"], last_name=u["last_name"],
                   name=full_name(u, u["username"]), role=u["role"])


@bp.post("/api/active_class")
@login_required_api
def active_class():
    session["active_class"] = (request.get_json(silent=True) or {}).get("class_id")
    return jsonify(ok=True)


@bp.get("/healthz")
def health():
    return jsonify(ok=True, mode="local-backend")


# ── password reset (target of roster "reset link") ───────────────────────────

RESET_HTML = """<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
<title>Set password — LeafTutor</title>
<style>body{font:15px system-ui;max-width:380px;margin:12vh auto;padding:0 16px}input,button{width:100%;box-sizing:border-box;
padding:10px;margin:6px 0;font:inherit}button{background:#2f7d4f;color:#fff;border:0;border-radius:6px;cursor:pointer}
.err{color:#b91c1c}</style>
<h2>🍃 Set your password</h2>
{% if bad %}<p class=err>{{ bad }}</p>{% else %}
<p>Account: <b>{{ username }}</b></p>
<form method=post><input type=password name=password placeholder="New password (8+ characters)" minlength=8 required>
<input type=password name=confirm placeholder="Confirm password" required>
{% if msg %}<p class=err>{{ msg }}</p>{% endif %}<button>Save password</button></form>{% endif %}"""


def _valid_token(token):
    t = q1("SELECT * FROM reset_tokens WHERE token=?", (token,))
    if not t or t["used_at"] or t["expires_at"] < ts():
        return None
    return t


@bp.route("/reset/<token>", methods=["GET", "POST"])
def reset_password(token):
    t = _valid_token(token)
    if not t:
        return render_template_string(RESET_HTML, bad="This link is invalid, expired, or was already used."), 410
    u = q1("SELECT * FROM users WHERE id=?", (t["user_id"],))
    if request.method == "POST":
        pw, conf = request.form.get("password", ""), request.form.get("confirm", "")
        if len(pw) < 8 or pw != conf:
            return render_template_string(RESET_HTML, username=u["username"],
                                          msg="Passwords must match and be at least 8 characters.")
        run("UPDATE users SET password_hash=? WHERE id=?", (generate_password_hash(pw), u["id"]))
        run("UPDATE reset_tokens SET used_at=? WHERE token=?", (ts(), token))
        return redirect("/login")
    return render_template_string(RESET_HTML, username=u["username"])


# ── pages ────────────────────────────────────────────────────────────────────

@bp.get("/courses")
def courses_page():
    u = current_user()
    if not u:
        return redirect("/login")
    student = u["role"] == "student"
    cards = []
    for c in visible_classes():
        n = q1("SELECT COUNT(*) n FROM assignments WHERE class_id=?" + (" AND active=1" if student else ""),
               (c["id"],))["n"]
        d = class_dict(c)
        cards.append({**d, "assignments": n, "url": f"/courses/{quote(c['id'])}",
                      "assignments_url": f"/courses/{quote(c['id'])}#assignments"})
    return render_template("courses.html", anon=False, courses=cards, is_student=student)


@bp.post("/courses/new")
def course_create():
    p = principal()
    if not p or p["role"] != "instructor":
        return err("Not allowed.", 403)
    return create_class_impl(request.get_json(silent=True) or {}, p)


@bp.get("/courses/<course_id>")
def course_page(course_id):
    u = current_user()
    if not u:
        return redirect("/login")
    c = next((c for c in visible_classes() if c["id"] == course_id), None)
    if not c:
        return error_page("Not found", "That course doesn't exist or you don't have access.", status=404)
    d = class_dict(c)
    if u["role"] == "student":      # read-only view: only assignments the instructor has activated
        d["assignments"] = [asn_dict(a) for a in
                            q("SELECT * FROM assignments WHERE class_id=? AND active=1 ORDER BY created_at", (c["id"],))]
        return render_template("course_detail.html", anon=False, course=d, is_student=True)
    d["assignments"] = [asn_dict(a) for a in q("SELECT * FROM assignments WHERE class_id=? ORDER BY created_at", (c["id"],))]
    return render_template("course_detail.html", anon=False, course=d)


@bp.get("/courses/<course_id>/assignments/<assignment_id>")
def assignment_page(course_id, assignment_id):
    u = current_user()
    if not u:
        return redirect("/login")
    if u["role"] == "student":
        return redirect(f"/student?assignment={quote(assignment_id)}")
    return redirect(f"/instructor?class={quote(course_id)}&view=assignments&assignment={quote(assignment_id)}")


@bp.get("/instructor")
def instructor_page():
    u = current_user()
    if not u:
        return redirect("/login")
    if u["role"] != "instructor":
        return redirect("/student")
    return render_template("instructor.html", anon=False, panel=None)


@bp.get("/student")
def student_page():
    u = current_user()
    if not u:
        return redirect("/login")
    return render_template("student.html", anon=False, feature_add_class=False,
                           feature_deep_coding=False, initial_session=None)


@bp.get("/welcome")
def welcome_page():
    u = current_user()
    if not u:
        return redirect("/login")
    if u["role"] != "student":
        return redirect(home_for(u))
    classes = [class_dict(c) for c in visible_classes()]
    return render_template("welcome.html", anon=False, first=u["first_name"] or u["username"],
                           classes=classes)


@bp.get("/ta/<token>")
def ta_page(token):
    ta = q1("SELECT * FROM assistants WHERE token=?", (token,))
    if not ta or not ta["is_active"]:
        return error_page("Link unavailable", "This assistant link is invalid or has been disabled.", status=404)
    cls = q1("SELECT * FROM classes WHERE id=?", (ta["class_id"],))
    session["ta_id"] = ta["id"]
    run("UPDATE assistants SET last_used_at=? WHERE id=?", (ts(), ta["id"]))
    panel = {"mode": "ta", "ta_id": ta["id"], "ta_name": ta["name"],
             "assignment_management": b(ta["assignment_management"]),
             "class_id": ta["class_id"], "class_name": cls["name"]}
    return render_template("instructor.html", anon=True, panel=panel)


@bp.get("/account")
def account_page():
    if not current_user():
        return redirect("/login")
    return render_template("account.html", anon=False)


@bp.get("/help")
def help_page():
    if not current_user():
        return redirect("/login")
    return render_template("help.html", anon=False)


@bp.get("/calendar")
def calendar_page():
    u = current_user()
    if not u:
        return redirect("/login")
    events = []
    for c in visible_classes():
        label = c["code"] or c["name"]
        for a in q("SELECT * FROM assignments WHERE class_id=? AND due_date IS NOT NULL", (c["id"],)):
            tm = None
            if a["due_time"]:
                try:
                    tm = datetime.strptime(a["due_time"], "%H:%M").strftime("%I:%M %p").lstrip("0")
                except ValueError:
                    pass
            events.append({"title": a["title"], "date": a["due_date"], "time": tm,
                           "course": label, "type": "assignment"})
    return render_template("calendar.html", anon=False, events=events, usage={},
                           is_instructor=u["role"] == "instructor")


@bp.get("/api/calendar/usage")
def calendar_usage():
    p = principal()
    if not p or p["role"] != "instructor":
        return err("Instructors only.", 403)
    try:
        y, m = int(request.args["year"]), int(request.args["month"])
    except (KeyError, ValueError):
        return err("year and month are required.")
    prefix = f"{y:04d}-{m:02d}-"
    rows = q("SELECT day, COUNT(DISTINCT user_key) n FROM usage_events WHERE day LIKE ? AND class_id IN "
             "(SELECT id FROM classes WHERE owner_id=?) GROUP BY day", (prefix + "%", p["user"]["id"]))
    return jsonify(usage={r["day"]: r["n"] for r in rows})


# ── classes ──────────────────────────────────────────────────────────────────

@bp.get("/api/classes")
@login_required_api
def classes_list():
    return jsonify([class_dict(c) for c in visible_classes()])


def create_class_impl(payload, p):
    name = (payload.get("name") or "").strip()
    if not name:
        return err("Class name is required.")
    cid = new_id()
    run("INSERT INTO classes(id, name, term, code, owner_id, created_at) VALUES(?,?,?,?,?,?)",
        (cid, name, (payload.get("term") or "").strip(), (payload.get("code") or "").strip(),
         p["user"]["id"], ts()))
    return jsonify(ok=True, id=cid, **{"class": class_dict(q1("SELECT * FROM classes WHERE id=?", (cid,)))})


@bp.post("/api/classes")
@inst_api(instructor_only=True)
def class_create():
    return create_class_impl(request.get_json(silent=True) or {}, g.p)


@bp.patch("/api/classes/<cid>")
@inst_api(instructor_only=True)
def class_patch(cid):
    if not can_class(g.p, cid):
        return err("Class not found.", 404)
    d = request.get_json(silent=True) or {}
    for key in ("name", "term", "code", "description"):
        if key in d and (key != "name" or str(d[key]).strip()):
            run(f"UPDATE classes SET {key}=? WHERE id=?", (str(d[key]).strip(), cid))
    return jsonify(ok=True, **{"class": class_dict(q1("SELECT * FROM classes WHERE id=?", (cid,)))})


@bp.delete("/api/classes/<cid>")
@inst_api(instructor_only=True)
def class_delete(cid):
    if not can_class(g.p, cid):
        return err("Class not found.", 404)
    run("DELETE FROM classes WHERE id=?", (cid,))
    return jsonify(ok=True)


@bp.post("/api/classes/<cid>/toggle_active")
@inst_api(instructor_only=True)
def class_toggle(cid):
    c = can_class(g.p, cid)
    if not c:
        return err("Class not found.", 404)
    new = 0 if c["is_active"] else 1
    run("UPDATE classes SET is_active=? WHERE id=?", (new, cid))
    return jsonify(ok=True, is_active=b(new))


# ── roster ───────────────────────────────────────────────────────────────────

def add_student(cid, first, last, email):
    """-> 'added' | 'updated' | 'skipped'"""
    email = email.strip().lower()
    if not (first and last and EMAIL_RE.match(email)):
        return "skipped"
    existing = q1("SELECT * FROM enrollments WHERE class_id=? AND email=?", (cid, email))
    if existing:
        return "skipped"
    u = q1("SELECT * FROM users WHERE username=? OR email=?", (email, email))
    if u and u["role"] != "student":
        return "skipped"
    if not u:
        uid = make_user(email, None, "student", first, last, email)
    else:
        uid = u["id"]
    run("INSERT INTO enrollments(id, class_id, user_id, first_name, last_name, email, created_at) "
        "VALUES(?,?,?,?,?,?,?)", (new_id(), cid, uid, first, last, email, ts()))
    return "added"


@bp.post("/api/classes/<cid>/students")
@inst_api(instructor_only=True)
def student_add(cid):
    if not can_class(g.p, cid):
        return err("Class not found.", 404)
    d = request.get_json(silent=True) or {}
    email = (d.get("email") or "").strip()
    if not EMAIL_RE.match(email.lower()):
        return err("Please enter a valid email.")
    if not (d.get("first_name") or "").strip() or not (d.get("last_name") or "").strip():
        return err("First and last name are required.")
    if add_student(cid, d["first_name"].strip(), d["last_name"].strip(), email) == "skipped":
        return err("That student is already in this class.", 409)
    return jsonify(ok=True)


def _rows_from_upload(f):
    name = (f.filename or "").lower()
    raw = f.read()
    if name.endswith(".xlsx"):
        import openpyxl
        wb = openpyxl.load_workbook(io.BytesIO(raw), read_only=True, data_only=True)
        rows = [[("" if c is None else str(c)) for c in r] for r in wb.active.iter_rows(values_only=True)]
    else:
        rows = list(csv.reader(io.StringIO(raw.decode("utf-8-sig", "replace"))))
    if not rows:
        return []
    head = [re.sub(r"[\s\-]+", "_", h.strip().lower()) for h in rows[0]]
    return [dict(zip(head, r)) for r in rows[1:] if any(str(x).strip() for x in r)]


@bp.post("/api/classes/<cid>/students/upload")
@inst_api(instructor_only=True)
def student_upload(cid):
    if not can_class(g.p, cid):
        return err("Class not found.", 404)
    f = request.files.get("file")
    if not f:
        return err("No file uploaded.")
    try:
        rows = _rows_from_upload(f)
    except Exception as e:
        return err(f"Could not read the file: {e}")
    if rows and not {"first_name", "last_name", "email"} <= set(rows[0]):
        return err("Required columns: first_name, last_name, email.")
    counts = {"added": 0, "updated": 0, "skipped": 0}
    for r in rows:
        counts[add_student(cid, str(r.get("first_name", "")).strip(), str(r.get("last_name", "")).strip(),
                           str(r.get("email", "")))] += 1
    return jsonify(ok=True, **counts)


@bp.patch("/api/classes/<cid>/students/<eid>/active")
@inst_api(instructor_only=True)
def student_active(cid, eid):
    if not can_class(g.p, cid):
        return err("Class not found.", 404)
    e = q1("SELECT * FROM enrollments WHERE id=? AND class_id=?", (eid, cid))
    if not e:
        return err("Student not found.", 404)
    run("UPDATE enrollments SET active=? WHERE id=?", (0 if e["active"] else 1, eid))
    return jsonify(ok=True, active=not b(e["active"]))


@bp.post("/api/classes/<cid>/students/<eid>/reset_link")
@inst_api(instructor_only=True)
def student_reset_link(cid, eid):
    if not can_class(g.p, cid):
        return err("Class not found.", 404)
    e = q1("SELECT * FROM enrollments WHERE id=? AND class_id=?", (eid, cid))
    if not e:
        return err("Student not found.", 404)
    force = b((request.get_json(silent=True) or {}).get("force_new"))
    live = q1("SELECT * FROM reset_tokens WHERE enrollment_id=? AND used_at IS NULL AND expires_at>? "
              "ORDER BY expires_at DESC", (eid, ts()))
    reused = bool(live) and not force
    if not reused:
        run("DELETE FROM reset_tokens WHERE enrollment_id=? AND used_at IS NULL", (eid,))
        tok = secrets.token_urlsafe(24)
        run("INSERT INTO reset_tokens(token, enrollment_id, user_id, expires_at) VALUES(?,?,?,?)",
            (tok, eid, e["user_id"], future(days=7)))
        live = q1("SELECT * FROM reset_tokens WHERE token=?", (tok,))
    u = q1("SELECT username FROM users WHERE id=?", (e["user_id"],))
    return jsonify(ok=True, link=request.host_url.rstrip("/") + "/reset/" + live["token"],
                   expires_at=live["expires_at"], username=u["username"] if u else "", reused=reused)


ROSTER_HTML = """{% if not rows %}<div class="muted">No students yet.</div>{% endif %}
{% for e in rows %}{% set nm = (e.first_name ~ ' ' ~ e.last_name).strip() %}
<div class="item" style="display:flex;align-items:center;gap:8px;{% if not e.active %}opacity:.5;{% endif %}">
  <div style="flex:1;min-width:0;display:flex;flex-direction:column;gap:1px;">
    <span style="font-weight:600;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">{{ nm }}</span>
    <span class="muted" style="font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">{{ e.email }}</span>
  </div>
  {% if not e.active %}<span class="muted" style="font-size:10px;">inactive</span>{% endif %}
  <button type="button" class="btn small" title="Generate a single-use password link"
          onclick="studentResetLink({{ e.id|tojson|forceescape }}, {{ nm|tojson|forceescape }})">🔑</button>
  <button type="button" class="btn small" onclick="toggleStudent({{ e.id|tojson|forceescape }})">
    {{ 'Deactivate' if e.active else 'Activate' }}</button>
</div>{% endfor %}"""


@bp.get("/partials/roster/<cid>")
@inst_api(instructor_only=True)
def roster_partial(cid):
    if not can_class(g.p, cid):
        return err("Class not found.", 404)
    rows = q("SELECT * FROM enrollments WHERE class_id=? ORDER BY last_name COLLATE NOCASE, first_name COLLATE NOCASE", (cid,))
    return render_template_string(ROSTER_HTML, rows=rows)


# ── teaching assistants ──────────────────────────────────────────────────────

def ta_dict(t):
    return {"id": t["id"], "class_id": t["class_id"], "name": t["name"], "email": t["email"] or "",
            "is_active": b(t["is_active"]), "assignment_management": b(t["assignment_management"]),
            "last_used_at": t["last_used_at"], "login_url": request.host_url.rstrip("/") + "/ta/" + t["token"]}


def _own_ta(tid):
    t = q1("SELECT * FROM assistants WHERE id=?", (tid,))
    return t if t and can_class(g.p, t["class_id"]) else None


@bp.get("/api/instructor/assistants")
@inst_api(instructor_only=True)
def ta_list():
    cid = request.args.get("class_id", "")
    if not can_class(g.p, cid):
        return err("Class not found.", 404)
    rows = q("SELECT * FROM assistants WHERE class_id=? ORDER BY created_at", (cid,))
    return jsonify(assistants=[ta_dict(t) for t in rows])


@bp.post("/api/instructor/assistants")
@inst_api(instructor_only=True)
def ta_create():
    d = request.get_json(silent=True) or {}
    if not can_class(g.p, d.get("class_id", "")):
        return err("Class not found.", 404)
    name = (d.get("name") or "").strip()
    if not name:
        return err("Name is required.")
    email = (d.get("email") or "").strip()
    if email and not EMAIL_RE.match(email):
        return err("Please enter a valid email.")
    tid = new_id()
    run("INSERT INTO assistants(id, class_id, name, email, token, created_at) VALUES(?,?,?,?,?,?)",
        (tid, d["class_id"], name, email, secrets.token_urlsafe(24), ts()))
    return jsonify(ok=True, assistant=ta_dict(q1("SELECT * FROM assistants WHERE id=?", (tid,))))


@bp.patch("/api/instructor/assistants/<tid>")
@inst_api(instructor_only=True)
def ta_patch(tid):
    if not _own_ta(tid):
        return err("Assistant not found.", 404)
    d = request.get_json(silent=True) or {}
    for key in ("is_active", "assignment_management"):
        if key in d:
            run(f"UPDATE assistants SET {key}=? WHERE id=?", (1 if d[key] else 0, tid))
    for key in ("name", "email"):
        if key in d and (key != "name" or str(d[key]).strip()):
            run(f"UPDATE assistants SET {key}=? WHERE id=?", (str(d[key]).strip(), tid))
    return jsonify(ok=True, assistant=ta_dict(q1("SELECT * FROM assistants WHERE id=?", (tid,))))


@bp.post("/api/instructor/assistants/<tid>/regenerate")
@inst_api(instructor_only=True)
def ta_regen(tid):
    if not _own_ta(tid):
        return err("Assistant not found.", 404)
    run("UPDATE assistants SET token=? WHERE id=?", (secrets.token_urlsafe(24), tid))
    return jsonify(ok=True, assistant=ta_dict(q1("SELECT * FROM assistants WHERE id=?", (tid,))))


@bp.delete("/api/instructor/assistants/<tid>")
@inst_api(instructor_only=True)
def ta_delete(tid):
    if not _own_ta(tid):
        return err("Assistant not found.", 404)
    run("DELETE FROM assistants WHERE id=?", (tid,))
    return jsonify(ok=True)


# ── assignments ──────────────────────────────────────────────────────────────

@bp.get("/api/instructor/assignments")
@inst_api()
def asn_list():
    cid = request.args.get("class_id")
    if cid:
        if not can_class(g.p, cid):
            return err("Class not found.", 404)
        rows = q("SELECT * FROM assignments WHERE class_id=? ORDER BY created_at", (cid,))
    else:
        rows = [a for c in visible_classes() for a in q("SELECT * FROM assignments WHERE class_id=? ORDER BY created_at", (c["id"],))]
    return jsonify([asn_dict(a) for a in rows])


@bp.post("/api/instructor/assignments")
@inst_api(manage=True)
def asn_create():
    d = request.get_json(silent=True) or {}
    if not can_class(g.p, d.get("class_id", "")):
        return err("Class not found.", 404)
    title = (d.get("title") or "").strip()[:200]
    if not title:
        return err("Title is required.")
    ok, day, tm, msg = clean_due(d)
    if not ok:
        return err(msg)
    aid = new_id()
    run("INSERT INTO assignments(id, class_id, title, due_date, due_time, created_at) VALUES(?,?,?,?,?,?)",
        (aid, d["class_id"], title, day, tm, ts()))
    return jsonify(ok=True, id=aid, assignment=asn_dict(q1("SELECT * FROM assignments WHERE id=?", (aid,))))


# NOTE: declared before the <aid> routes so "activate" isn't captured as an id.
@bp.post("/api/instructor/assignments/activate")
@inst_api(manage=True)
def asn_activate():
    d = request.get_json(silent=True) or {}
    a = can_asn(g.p, d.get("assignment_id", ""))
    if not a:
        return err("Assignment not found.", 404)
    run("UPDATE assignments SET active=? WHERE id=?", (1 if d.get("active") else 0, a["id"]))
    return jsonify(ok=True, active=b(d.get("active")))


@bp.patch("/api/instructor/assignments/<aid>")
@inst_api(manage=True)
def asn_patch(aid):
    a = can_asn(g.p, aid)
    if not a:
        return err("Assignment not found.", 404)
    d = request.get_json(silent=True) or {}
    if "title" in d:
        t = str(d["title"]).strip()[:200]
        if not t:
            return err("Title cannot be empty.")
        run("UPDATE assignments SET title=? WHERE id=?", (t, aid))
    if any(k in d for k in ("due", "due_date", "due_time")):
        ok, day, tm, msg = clean_due(d)
        if not ok:
            return err(msg)
        run("UPDATE assignments SET due_date=?, due_time=? WHERE id=?", (day, tm, aid))
    if "description" in d:
        run("UPDATE assignments SET description=? WHERE id=?", (str(d["description"]), aid))
    return jsonify(ok=True, assignment=asn_dict(q1("SELECT * FROM assignments WHERE id=?", (aid,))))


@bp.delete("/api/instructor/assignments/<aid>")
@inst_api(manage=True)
def asn_delete(aid):
    if not can_asn(g.p, aid):
        return err("Assignment not found.", 404)
    run("DELETE FROM assignments WHERE id=?", (aid,))
    return jsonify(ok=True)


@bp.get("/api/student/active_assignments")
@login_required_api
def active_assignments():
    out = []
    for c in visible_classes():
        for a in q("SELECT * FROM assignments WHERE class_id=? AND active=1 ORDER BY created_at", (c["id"],)):
            out.append({**asn_dict(a), "class_name": c["name"]})
    return jsonify(out)


@bp.post("/api/instructor/assignment_remarks")
@inst_api(manage=True)
def asn_remarks():
    d = request.get_json(silent=True) or {}
    a = can_asn(g.p, d.get("assignment_id", ""))
    if not a:
        return err("Assignment not found.", 404)
    run("UPDATE assignments SET description=? WHERE id=?", ((d.get("remarks") or "").strip(), a["id"]))
    return jsonify(ok=True)


@bp.post("/api/instructor/toggle_remarks")
@inst_api(manage=True)
def asn_toggle_remarks():
    d = request.get_json(silent=True) or {}
    a = can_asn(g.p, d.get("assignment_id", ""))
    if not a:
        return err("Assignment not found.", 404)
    run("UPDATE assignments SET remarks_active=? WHERE id=?", (1 if d.get("active") else 0, a["id"]))
    return jsonify(ok=True)
