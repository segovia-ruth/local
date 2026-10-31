# LeafTutor local backend (Flask + SQLite)

Replaces the `leaftutor.org` proxy in `localweb.py`. Your templates/static are served as-is; all `/api/*`
endpoints the instructor, student, Deep Coding, calendar, courses and workbench pages call are implemented against a local
SQLite file (`leaftutor.db`). No leaftutor.org account or network connection is needed.

## What it covers
* **Instructor side:** login, courses, roster (add, upload, deactivate, remove, password-reset links), teaching
  assistants, assignments, assignment files, calendar, tutoring threads, anonymous chat links, audit views and the
  compile workbench.
* **Student side:** the AI Tutor chat (`/student`), threaded chats, in-chat files, assignment PDFs, "Instructor
  help" flags, bookmark / copy-link / QR to reopen a chat, and the course dashboard with its navigation.
* **Deep Coding IDE (`/deep`):** editor, files, run, a live IDLE-style shell with real `input()` support, and
  assignment PDF preview.
* **AI tutor:** a local model (Ollama, LM Studio, llama.cpp) or the Anthropic API.

## Setup
    pip install -r requirements.txt
    # Local AI tutor (Ollama is not a pip package; install it from https://ollama.com first):
    ollama pull qwen2.5-coder:7b         # ~4.7 GB; skip if you use ANTHROPIC_API_KEY instead
    python leaftutor_local.py            # first run prints a demo instructor login
    python leaftutor_local.py --create-user alice 'pw-12345678' --role instructor --first Alice --last Smith
    python leaftutor_local.py --create-user sam 'pw-12345678' --role student --first Sam --last Lee

Then open http://127.0.0.1:5000. Templates and static files are read from `--frontend-dir`. By default this is the
script's folder, or its parent if the parent holds `templates/` and `static/`. The database is `leaftutor.db`,
next to the script. Run a **single server process**: live shell state lives in memory.

Optional flags: `--host`, `--port`, `--frontend-dir`.

## AI tutor setup
Check your setup with `python lt_llm.py`. The server also prints `AI tutor: ON/OFF` at startup, and
`GET /api/llm_status` reports the same thing.

| Variable | Default | Meaning |
|---|---|---|
| `LT_LLM` | `auto` | `auto` uses Anthropic if `ANTHROPIC_API_KEY` is set, otherwise the local server. Or force `local` / `anthropic`. |
| `ANTHROPIC_API_KEY` | – | Needed for Anthropic (also `pip install anthropic`). |
| `LT_MODEL` | `claude-sonnet-5-5` | Anthropic model. |
| `LT_LOCAL_URL` | `http://127.0.0.1:11434` | Local model server. |
| `LT_LOCAL_MODEL` | `qwen2.5-coder:7b` | Local model name (`ollama pull <model>` first). |
| `LT_LOCAL_API` | `ollama` | `ollama` or `openai` (LM Studio / llama.cpp / vLLM). |
| `LT_NUM_CTX` | `8192` | Context window requested from Ollama. |
| `LT_LOCAL_TIMEOUT` | `180` | Seconds. The first request loads the model, so it is slower. |

## Other settings
| Variable | Default | Meaning |
|---|---|---|
| `LT_DEEP_CODING` | `1` | Set to `0` to turn the Deep Coding IDE off for the whole server. |
| `LT_RUN_TIMEOUT` | `10` | Seconds a compile and run may take. |
| `LT_LIVE_MAX_SECONDS` | `600` | Hard cap for one live shell run. |
| `LT_LIVE_IDLE_SECONDS` | `300` | A live run with no output and no input is stopped after this long. |

## Files
| file | role |
|---|---|
| `leaftutor_local.py` | app factory, CLI, first-run seed, `/api/llm_status` |
| `lt_db.py` | schema + helpers (SQLite), including `course_visits`, `usage_events` and `llm_tasks` |
| `lt_common.py` | auth principals (instructor / TA), access checks, serializers, `deep_enabled()` |
| `lt_core.py` | login, pages, classes, roster, reset links, TAs, assignments, calendar |
| `lt_files.py` | assignment files, tags, summaries, assignment PDFs, compile & run, Generate-Hints workbench |
| `lt_chat.py` | tutoring threads + files, anonymous links, audit |
| `lt_student.py` | student chat backend (sessions, threads, ask/retry, uploads, in-chat files, help flag) and the `/deep` page and its `/api/deep/*` routes |
| `lt_live.py` | live IDLE-style shell for Deep Coding (`/api/deep/live/*`, Python and Java REPLs) |
| `lt_llm.py` | LLM adapter: local model or Anthropic |
| `lt_exec.py` | language detection, risk screen, static analysis, local code runner |
| `tests/smoke_test.py` | 71-check end-to-end test (`python tests/smoke_test.py <frontend_dir>`) |

Templates you edit alongside the backend: `templates/student.html` (AI Tutor page) and `templates/ide.html`
(Deep Coding IDE).

## Student URLs
* `/welcome` – the student's most recently opened courses (up to 3).
* `/student?class=<course_id>` – AI Tutor with the course navigation.
* `/student?session=<session_id>` – reopens that exact chat (used by Bookmark, Copy link and QR).
* `/deep` – Deep Coding IDE.

## Notes
* **Check my code:** the button and results panel were removed from `ide.html`. The backend route
  `POST /api/deep/check_file` (runs the instructor's test files) and `js/pages/deep/check.js` are still in place
  and unused. Delete them if you want the feature gone completely.
* If the browser shows 404s on `/start_session` or `/api/student/threads`, the server is running an old
  `leaftutor_local.py`. It must register `lt_student` and `lt_live` as well as `lt_core`, `lt_files` and `lt_chat`.

## Security notes
* **Code execution is not sandboxed.** Compile & run, file run, checks and the live shell all run uploaded code on
  your machine (temp dir, time limits, scrubbed environment). The keyword "risk screen" blocks obvious abuse only.
  Run inside Docker or a VM for real classes or untrusted students.
* The live shell uses a pseudo-terminal on Linux/macOS. On Windows it falls back to pipes, and the browser echoes
  the typed line.
* Binds to `127.0.0.1` by default, and prints a warning if you bind elsewhere. Passwords are hashed (werkzeug),
  sessions are signed cookies (`.secret_key`), and state-changing requests are rejected when their `Origin` does
  not match the server.

