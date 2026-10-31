"""SQLite layer for the local LeafTutor backend (stdlib only)."""
import json
import sqlite3
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

from flask import g

DB_PATH = Path(__file__).with_name("leaftutor.db")

SCHEMA = """
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, email TEXT,
  password_hash TEXT, first_name TEXT DEFAULT '', last_name TEXT DEFAULT '',
  role TEXT NOT NULL CHECK (role IN ('instructor','student')), created_at TEXT
);

CREATE TABLE IF NOT EXISTS classes (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, term TEXT DEFAULT '', code TEXT DEFAULT '',
  description TEXT DEFAULT '', owner_id TEXT REFERENCES users(id),
  is_active INTEGER DEFAULT 1, created_at TEXT
);

CREATE TABLE IF NOT EXISTS enrollments (
  id TEXT PRIMARY KEY, class_id TEXT NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users(id), first_name TEXT, last_name TEXT, email TEXT,
  active INTEGER DEFAULT 1, created_at TEXT, UNIQUE(class_id, email)
);

CREATE TABLE IF NOT EXISTS reset_tokens (
  token TEXT PRIMARY KEY, enrollment_id TEXT REFERENCES enrollments(id) ON DELETE CASCADE,
  user_id TEXT, expires_at TEXT, used_at TEXT
);

CREATE TABLE IF NOT EXISTS assistants (
  id TEXT PRIMARY KEY, class_id TEXT NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  name TEXT, email TEXT DEFAULT '', token TEXT UNIQUE, is_active INTEGER DEFAULT 1,
  assignment_management INTEGER DEFAULT 0, last_used_at TEXT, created_at TEXT
);

CREATE TABLE IF NOT EXISTS assignments (
  id TEXT PRIMARY KEY, class_id TEXT NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  title TEXT NOT NULL, description TEXT DEFAULT '', remarks_active INTEGER DEFAULT 1,
  active INTEGER DEFAULT 0, due_date TEXT, due_time TEXT, created_at TEXT,
  profile TEXT DEFAULT '{}'
);

-- Chat sessions: instructor/TA tutoring threads, student chats and anonymous chats.
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, assignment_id TEXT NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'instructor',          -- instructor | student | anon
  owner_user_id TEXT, ta_id TEXT, link_id TEXT,
  student_name TEXT DEFAULT '', username TEXT DEFAULT '', title TEXT DEFAULT 'Tutoring chat',
  alias TEXT DEFAULT '', started_at TEXT, updated_at TEXT,
  closed INTEGER DEFAULT 0, anon_disabled INTEGER DEFAULT 0, favourite INTEGER DEFAULT 0,
  help_flagged INTEGER DEFAULT 0, help_flagged_at TEXT, help_note TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  role TEXT NOT NULL, content TEXT DEFAULT '', extra TEXT DEFAULT '{}', created_at TEXT
);

-- Files belong to an assignment (instructor material) OR a session (attached by a chat user).
CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  assignment_id TEXT REFERENCES assignments(id) ON DELETE CASCADE,
  session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
  name TEXT NOT NULL, mimetype TEXT DEFAULT '', language TEXT DEFAULT '',
  is_source INTEGER DEFAULT 0, has_main INTEGER DEFAULT 0, is_text INTEGER DEFAULT 1,
  data BLOB, size INTEGER DEFAULT 0, content_hash TEXT DEFAULT '',
  active INTEGER DEFAULT 1, starred INTEGER DEFAULT 0, summary TEXT DEFAULT '',
  tags TEXT DEFAULT '[]', tags_customized INTEGER DEFAULT 0,
  last_analysis TEXT, last_analysis_at TEXT, analysis_hash TEXT,
  last_run TEXT, last_run_at TEXT, run_hash TEXT,
  last_success_run TEXT, last_success_run_at TEXT, success_hash TEXT,
  issue_dismissed INTEGER DEFAULT 0, created_at TEXT
);

CREATE TABLE IF NOT EXISTS links (
  id TEXT PRIMARY KEY, assignment_id TEXT NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
  slug TEXT UNIQUE NOT NULL, alias TEXT DEFAULT '', is_enabled INTEGER DEFAULT 1,
  chats_disabled INTEGER DEFAULT 0, view_only INTEGER DEFAULT 0,
  password_enabled INTEGER DEFAULT 0, password TEXT DEFAULT '', created_at TEXT
);

CREATE TABLE IF NOT EXISTS llm_tasks (
  id TEXT PRIMARY KEY, assignment_id TEXT, file_id TEXT, kind TEXT,
  status TEXT DEFAULT 'failed', error TEXT DEFAULT '', created_at TEXT
);

-- Last time each user opened each class (drives "Most recent classes" on the welcome page).
CREATE TABLE IF NOT EXISTS course_visits (
  user_id TEXT NOT NULL, class_id TEXT NOT NULL, last_opened TEXT NOT NULL,
  PRIMARY KEY (user_id, class_id)
);

CREATE TABLE IF NOT EXISTS usage_events (
  day TEXT, user_key TEXT, class_id TEXT, UNIQUE(day, user_key, class_id)
);

CREATE INDEX IF NOT EXISTS idx_asn_class ON assignments(class_id);
CREATE INDEX IF NOT EXISTS idx_files_asn ON files(assignment_id);
CREATE INDEX IF NOT EXISTS idx_files_ses ON files(session_id);
CREATE INDEX IF NOT EXISTS idx_msg_ses ON messages(session_id);
CREATE INDEX IF NOT EXISTS idx_ses_asn ON sessions(assignment_id);
"""


def now_dt():
    return datetime.now(timezone.utc).replace(tzinfo=None)      # naive UTC, like the real backend


def ts():
    """ISO timestamp (naive UTC)."""
    return now_dt().strftime("%Y-%m-%dT%H:%M:%S")


def ts_minute():
    """Audit-style timestamp: lexicographic order == chronological order."""
    return now_dt().strftime("%Y-%m-%d %H:%M")


def future(**kw):
    return (now_dt() + timedelta(**kw)).strftime("%Y-%m-%dT%H:%M:%S")


def new_id():
    return uuid.uuid4().hex[:12]


def get_db():
    if "db" not in g:
        g.db = sqlite3.connect(DB_PATH, timeout=30)
        g.db.row_factory = sqlite3.Row
        g.db.execute("PRAGMA foreign_keys = ON")
    return g.db


def close_db(_exc=None):
    db = g.pop("db", None)
    if db is not None:
        db.close()


def init_db():
    con = sqlite3.connect(DB_PATH)
    con.executescript(SCHEMA)
    for ddl in ("ALTER TABLE sessions ADD COLUMN mode TEXT DEFAULT ''",      # conversation | deep_coding
                "ALTER TABLE files ADD COLUMN stdin TEXT DEFAULT ''"):       # saved program input (Deep Coding)
        try:
            con.execute(ddl)
        except sqlite3.OperationalError:                                      # column already exists
            pass
    con.execute("PRAGMA journal_mode = WAL")
    con.commit()
    con.close()


def q(sql, args=()):
    return get_db().execute(sql, args).fetchall()


def q1(sql, args=()):
    return get_db().execute(sql, args).fetchone()


def run(sql, args=()):
    cur = get_db().execute(sql, args)
    get_db().commit()
    return cur


def jload(value, default):
    try:
        return json.loads(value) if value else default
    except (TypeError, ValueError):
        return default


def jdump(value):
    return json.dumps(value, ensure_ascii=False)
