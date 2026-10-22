# LeafTutor local backend (Flask + SQLite)

Replaces the `leaftutor.org` proxy in `localweb.py`. Your templates/static are served as-is; all `/api/*`
endpoints the instructor, calendar, courses and workbench pages call are implemented against a local
SQLite file (`leaftutor.db`).

## Setup
    pip install -r requirements.txt
    # put these files next to your templates/ and static/ folders (or pass --frontend-dir)
    python leaftutor_local.py            # first run prints a demo instructor login
    python leaftutor_local.py --create-user alice 'pw-12345678' --role instructor --first Alice --last Smith

Optional AI (tutoring replies, file summaries, workbench chat): `export ANTHROPIC_API_KEY=...`
(model via `LT_MODEL`, default `claude-sonnet-5-5`). Without a key everything else works; chat questions are
saved and the UI shows "Saved for retry — generation failed"; file summaries fall back to a simple heuristic.

## Files
| file | role |
|---|---|
| `leaftutor_local.py` | app factory, CLI, first-run seed |
| `lt_db.py` | schema + helpers (SQLite) |
| `lt_common.py` | auth principals (instructor / TA), access checks, serializers |
| `lt_core.py` | login, pages, classes, roster, reset links, TAs, assignments, calendar |
| `lt_files.py` | assignment files, tags, summaries, compile & run, Generate-Hints workbench |
| `lt_chat.py` | tutoring threads + files, anonymous links, audit |
| `lt_exec.py` | language detection, risk screen, static analysis, local code runner |
| `lt_llm.py` | optional Anthropic adapter |
| `tests/smoke_test.py` | 71-check end-to-end test (`python tests/smoke_test.py <frontend_dir>`) |

## Security notes
* **Code execution is not sandboxed.** `compile_run` / `file_run` run uploaded code on your machine (temp dir,
  10 s timeout, scrubbed env). The keyword "risk screen" blocks obvious abuse only. Run inside Docker/a VM for real classes.
* Binds to 127.0.0.1 by default. Passwords are hashed (werkzeug); sessions are signed cookies (`.secret_key`).

## Not implemented yet (needs files I didn't have)
* **Student chat + anonymous `/t/<slug>` chat APIs** - called from `js/pages/student/store.js` and `js/core/api.js`,
  which weren't uploaded. The pages render and the data model (sessions/messages/files, `help_flagged`, `closed`,
  `anon_disabled`, usage tracking table) is ready; the student endpoints still need to be written to match that JS.
* `/deep` (Deep Coding IDE). `base.html`, `account.html`, `help.html` and `compile_workbench.html` were not provided,
  so those routes are untested against your real markup.
