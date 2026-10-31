#!/usr/bin/env python3
"""LeafTutor — fully local frontend + backend (Flask + SQLite). No leaftutor.org needed.

  pip install -r requirements.txt
  python leaftutor_local.py                      # http://127.0.0.1:5000
  python leaftutor_local.py --create-user alice pw12345678 --role instructor --first Alice --last Smith

Templates/static are read from --frontend-dir (default: this folder, or its parent if the
parent holds templates/ and static/). Data lives in leaftutor.db next to this script.
Optional AI: export ANTHROPIC_API_KEY=... (and pip install anthropic).
"""
import argparse
import logging
import secrets
import sys
from datetime import datetime, timedelta
from pathlib import Path
from urllib.parse import urlsplit

from flask import Flask, jsonify, request, url_for

import lt_db
from lt_db import close_db, init_db, q1

HERE = Path(__file__).resolve().parent


def find_frontend(arg=None):
    if arg:
        return Path(arg).resolve()
    for cand in (HERE, HERE.parent):
        if (cand / "templates").is_dir():
            return cand
    return HERE


def secret_key():
    f = HERE / ".secret_key"
    if not f.exists():
        f.write_text(secrets.token_hex(32))
        try:
            f.chmod(0o600)
        except OSError:
            pass
    return f.read_text().strip()


def create_app(frontend_dir=None):
    fe = find_frontend(frontend_dir)
    app = Flask(__name__, template_folder=str(fe / "templates"), static_folder=str(fe / "static"))
    app.config.update(SECRET_KEY=secret_key(), TEMPLATES_AUTO_RELOAD=True, SEND_FILE_MAX_AGE_DEFAULT=0,
                      MAX_CONTENT_LENGTH=64 * 1024 * 1024, SESSION_COOKIE_HTTPONLY=True,
                      SESSION_COOKIE_SAMESITE="Lax", PERMANENT_SESSION_LIFETIME=timedelta(days=30))
    init_db()

    app.jinja_env.globals["static_v"] = lambda path: url_for("static", filename=path)

    def nice_date(value):
        try:
            d = datetime.strptime(str(value)[:10], "%Y-%m-%d")
            return f"{d:%a}, {d:%b} {d.day}, {d.year}"      # %-d is not portable (fails on Windows)
        except (TypeError, ValueError):
            return value or ""

    def nice_time(value):
        try:
            return datetime.strptime(str(value), "%H:%M").strftime("%I:%M %p").lstrip("0")
        except (TypeError, ValueError):
            return value or ""

    app.jinja_env.filters["nice_date"] = nice_date
    app.jinja_env.filters["nice_time"] = nice_time
    app.teardown_appcontext(close_db)

    @app.before_request
    def check_origin():
        origin = request.headers.get("Origin")
        if request.method not in ("GET", "HEAD", "OPTIONS") and origin and origin != request.host_url.rstrip("/"):
            return jsonify(ok=False, error="Request origin does not match this local server."), 403

    @app.after_request
    def headers(resp):
        resp.headers["Cache-Control"] = "no-store"
        resp.headers["X-Content-Type-Options"] = "nosniff"
        return resp

    from lt_common import current_user

    @app.context_processor
    def inject_role():
        u = current_user()
        return {"current_role": u["role"] if u else None}
      
    @app.get("/api/llm_status")
    def llm_status():
        import lt_llm
        ok, why = lt_llm.status()
        return jsonify(ok=ok, provider=lt_llm.provider(), model=lt_llm.label(), detail=why)

    @app.errorhandler(404)
    def not_found(_e):
        if request.path.startswith("/api/"):
            return jsonify(ok=False, error="Not found."), 404
        return "Not found", 404

    @app.errorhandler(413)
    def too_big(_e):
        return jsonify(ok=False, error="Upload too large."), 413

    from lt_chat import bp as chat_bp
    from lt_core import bp as core_bp
    from lt_files import bp as files_bp
    from lt_live import bp as live_bp
    from lt_student import bp as student_bp
    for bp in (core_bp, files_bp, chat_bp, student_bp, live_bp):
        app.register_blueprint(bp)
    return app


def cli_create_user(app, username, password, role, first, last):
    from lt_core import make_user
    with app.app_context():
        if q1("SELECT 1 FROM users WHERE username=?", (username.lower(),)):
            sys.exit(f"User '{username}' already exists.")
        make_user(username, password, role, first, last, username if "@" in username else None)
    print(f"Created {role} '{username}'.")


def first_run_seed(app):
    """No users yet -> create a demo instructor so you can log in immediately."""
    import sqlite3
    con = sqlite3.connect(lt_db.DB_PATH)
    empty = con.execute("SELECT COUNT(*) FROM users").fetchone()[0] == 0
    con.close()
    if not empty:
        return
    pw = secrets.token_urlsafe(9)
    from lt_core import make_user
    with app.app_context():
        make_user("instructor", pw, "instructor", "Demo", "Instructor", "instructor@localhost")
    print("\n  First run: created a demo instructor account")
    print(f"    username: instructor\n    password: {pw}   (change/replace with --create-user)\n")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=5000)
    ap.add_argument("--frontend-dir", help="folder containing templates/ and static/")
    ap.add_argument("--create-user", nargs=2, metavar=("USERNAME", "PASSWORD"))
    ap.add_argument("--role", choices=["instructor", "student"], default="instructor")
    ap.add_argument("--first", default="")
    ap.add_argument("--last", default="")
    a = ap.parse_args()

    app = create_app(a.frontend_dir)
    if a.create_user:
        return cli_create_user(app, *a.create_user, a.role, a.first, a.last)
    first_run_seed(app)
    import lt_llm
    ok, why = lt_llm.status()
    print(f"  AI tutor: {'ON' if ok else 'OFF'} - {why}")
    if urlsplit(f"//{a.host}").hostname not in ("127.0.0.1", "localhost", "::1"):
        print("  WARNING: binding to a non-local address. This server runs student code on your machine.")
    print(f"LeafTutor (local backend): http://{a.host}:{a.port}   db: {lt_db.DB_PATH}")
    logging.getLogger("werkzeug").setLevel(logging.WARNING)
    app.run(host=a.host, port=a.port, threaded=True, debug=False)


if __name__ == "__main__":
    main()
