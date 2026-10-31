"""Interactive runs for Deep Coding: an IDLE / terminal-style shell.

A program is started and kept alive; the browser polls its output and types into its stdin while it runs,
so input() / scanf / Scanner work live (the prompt shows first, you answer, the program continues).
Also provides a Python shell (>>> prompt) and a Java shell (jshell) that can import the student's files.

  POST /api/deep/live/start   {session_id, file_id?, mode: "run"|"repl", language?: "python"|"java"}
  GET  /api/deep/live/poll    ?run_id=...&since=N     -> {text, next, done, exit_code}
  POST /api/deep/live/input   {run_id, text}          (a newline is added)
  POST /api/deep/live/signal  {run_id, signal: "interrupt"|"eof"|"kill"}

On Linux/macOS the program runs inside a pseudo-terminal, so it behaves like a real terminal (prompts appear,
the typed line is echoed). On Windows there is no pty: pipes are used and the browser echoes the typed line.

SECURITY: like lt_exec this runs code on THIS machine (keyword screen + time limits, NOT a sandbox).
State lives in this process's memory, so run a single server process (the default `python leaftutor_local.py`).
"""
import codecs
import os
import re
import shutil
import signal
import subprocess
import tempfile
import threading
import time
import uuid

from flask import Blueprint, g, jsonify, request

import lt_exec
from lt_common import err
from lt_student import _compilable, _file, _sess, _siblings, _usage, student_api

try:
    import pty
    HAS_PTY = True
except ImportError:                      # Windows
    pty = None
    HAS_PTY = False

bp = Blueprint("live", __name__)

MAX_SECONDS = int(os.environ.get("LT_LIVE_MAX_SECONDS", "600"))     # hard cap per run
IDLE_SECONDS = int(os.environ.get("LT_LIVE_IDLE_SECONDS", "300"))   # no output and no input
MAX_CHARS = 200_000
KEEP_FINISHED = 120                                                  # seconds a finished run stays pollable
ANSI = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07|\x1b[()][A-Z0-9]")

RUNS = {}
LOCK = threading.Lock()
_reaper_started = False


class Run:
    def __init__(self, owner, tmp, language):
        self.id = uuid.uuid4().hex[:16]
        self.owner, self.tmp, self.language = owner, tmp, language
        self.proc = None
        self.fd = None                  # pty master
        self.out = ""
        self.done = False
        self.exit_code = None
        self.started = self.last_io = time.time()
        self.finished_at = None
        self.lock = threading.Lock()
        self.pty = False
        self.repl = False               # True for the Python / Java shells (typed text is screened)

    def add(self, s):
        s = ANSI.sub("", s).replace("\r\n", "\n").replace("\x00", "").replace(self.tmp + os.sep, "")
        if not s:
            return
        with self.lock:
            self.out += s
            self.last_io = time.time()
            if len(self.out) > MAX_CHARS:
                self.out = self.out[:MAX_CHARS] + "\n…[output limit reached - program stopped]\n"
                self.kill()

    def kill(self):
        try:
            if self.proc and self.proc.poll() is None:
                if os.name == "posix":
                    os.killpg(os.getpgid(self.proc.pid), signal.SIGKILL)
                else:
                    self.proc.kill()
        except (ProcessLookupError, PermissionError, OSError):
            pass

    def write(self, data: bytes):
        if self.pty and self.fd is not None:
            os.write(self.fd, data)
        elif self.proc and self.proc.stdin:
            self.proc.stdin.write(data)
            self.proc.stdin.flush()
        self.last_io = time.time()

    def cleanup(self):
        if self.fd is not None:
            try:
                os.close(self.fd)
            except OSError:
                pass
            self.fd = None
        shutil.rmtree(self.tmp, ignore_errors=True)


def _reader(run):
    dec = codecs.getincrementaldecoder("utf-8")("replace")
    try:
        if run.pty:
            import select
            while True:
                r, _, _ = select.select([run.fd], [], [], 0.1)
                if r:
                    try:
                        data = os.read(run.fd, 4096)
                    except OSError:                          # EIO: the child closed the terminal
                        break
                    if not data:
                        break
                    run.add(dec.decode(data))
                elif run.proc.poll() is not None:
                    break
        else:
            fd = run.proc.stdout.fileno()
            while True:
                data = os.read(fd, 4096)
                if not data:
                    break
                run.add(dec.decode(data))
        run.add(dec.decode(b"", final=True))
    except Exception as e:                                   # never let the thread die silently
        run.add(f"\n[shell error: {e}]\n")
    finally:
        try:
            run.exit_code = run.proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            run.kill()
            run.exit_code = run.proc.wait()
        run.finished_at = time.time()
        run.done = True


def _reap():
    while True:
        time.sleep(3)
        now = time.time()
        with LOCK:
            items = list(RUNS.items())
        for rid, r in items:
            if not r.done and (now - r.started > MAX_SECONDS or now - r.last_io > IDLE_SECONDS):
                r.add(f"\n[stopped: {'time limit' if now - r.started > MAX_SECONDS else 'idle too long'}]\n")
                r.kill()
            if r.done and r.finished_at and now - r.finished_at > KEEP_FINISHED:
                with LOCK:
                    RUNS.pop(rid, None)
                r.cleanup()


def _ensure_reaper():
    global _reaper_started
    if not _reaper_started:
        _reaper_started = True
        threading.Thread(target=_reap, daemon=True).start()


def _env(tmp):
    env = {"PATH": os.environ.get("PATH", ""), "HOME": tmp, "LANG": "C.UTF-8", "TERM": "dumb",
           "PYTHONUNBUFFERED": "1", "PYTHON_BASIC_REPL": "1", "PYTHONDONTWRITEBYTECODE": "1"}
    for k in ("SYSTEMROOT", "TEMP", "TMP", "JAVA_HOME"):
        if os.environ.get(k):
            env[k] = os.environ[k]
    return env


def _spawn(run, cmd):
    kw = dict(cwd=run.tmp, env=_env(run.tmp))
    if HAS_PTY:
        master, slave = pty.openpty()
        run.proc = subprocess.Popen(cmd, stdin=slave, stdout=slave, stderr=slave, close_fds=True,
                                    start_new_session=True, **kw)
        os.close(slave)
        run.fd, run.pty = master, True
    else:
        run.proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                    bufsize=0, **kw)
    threading.Thread(target=_reader, args=(run,), daemon=True).start()


def _stop_owner_runs(owner):
    """One live run per student, like IDLE: starting a new one stops the old one."""
    with LOCK:
        mine = [r for r in RUNS.values() if r.owner == owner and not r.done]
    for r in mine:
        r.kill()


def _compile(tmp, language, files, main):
    """-> (cmd | None, failure_dict | None)"""
    stem = main.rsplit(".", 1)[0]
    if language == "python":
        return [shutil.which("python3") or shutil.which("python") or "python3", "-u", main], None
    if language == "javascript":
        return [shutil.which("node") or "node", main], None
    if language in ("c", "cpp"):
        cc = shutil.which("gcc" if language == "c" else "g++") or ("gcc" if language == "c" else "g++")
        exts = ("c",) if language == "c" else ("cpp", "cc", "cxx")
        # the file being run + helper files; other files that have their own main() would clash at link time
        others = [os.path.basename(n) for n, data in files.items()
                  if lt_exec.ext_of(n) in exts and os.path.basename(n) != main
                  and not re.search(r"\bmain\s*\(", data.decode("utf-8", "replace"))]
        rc, so, se, _ = lt_exec._sh([cc, "-O0", "-o", "prog", main, *others, "-lm"], tmp, timeout=30)
        if rc != 0:
            return None, {"phase": "compile", "exit_code": rc, "stderr": lt_exec._clip(se or so), "output": lt_exec._clip(se or so)}
        return [os.path.join(tmp, "prog")], None
    if language == "java":
        base = [shutil.which("javac") or "javac", "-encoding", "UTF-8", "-sourcepath", ".", "-d", "."]
        # Compile ONLY the file being run: javac pulls in the other classes it uses from the project folder, so a
        # broken scratch file (new.java ...) in the same project can no longer block an unrelated file.
        rc, so, se, _ = lt_exec._sh([*base, main], tmp, timeout=30)
        if rc != 0:
            # helper classes may live in differently-named files: retry with every file; if that works, use it
            srcs = [os.path.basename(n) for n in files if lt_exec.ext_of(n) == "java"]
            rc2, _, _, _ = lt_exec._sh([*base, *srcs], tmp, timeout=30)
            if rc2 != 0:
                return None, {"phase": "compile", "exit_code": rc, "stderr": lt_exec._clip(se or so), "output": lt_exec._clip(se or so)}
        src = next((d.decode("utf-8", "replace") for n, d in files.items() if os.path.basename(n) == main), "")
        if not re.search(r"\bvoid\s+main\s*\(", src):          # compiled fine, but the JVM's own message is cryptic
            msg = (f"{main} has no main method, so there is nothing to run.\n"
                   "Add one inside your class, for example:\n\n"
                   "    public static void main(String[] args) {\n        // your code here\n    }\n")
            return None, {"phase": "run", "exit_code": 1, "stderr": msg, "output": msg}
        return [shutil.which("java") or "java", "-cp", tmp, stem], None
    return None, {"phase": "unsupported", "stderr": f"Running '{language}' is not supported.", "output": f"Running '{language}' is not supported."}


def _write_files(tmp, files):
    for n, data in files.items():
        with open(os.path.join(tmp, os.path.basename(n)), "wb") as fh:
            fh.write(data)


def _own(rid):
    r = RUNS.get(rid or "")
    return r if r and r.owner == g.u["id"] else None


@bp.post("/api/deep/live/start")
@student_api
def live_start():
    """Never return a bare 500: show the real cause in the Shell pane (and print the traceback in the terminal)."""
    try:
        return _live_start()
    except Exception as ex:                                  # noqa: BLE001
        import traceback
        traceback.print_exc()
        msg = f"Server error while starting the program: {type(ex).__name__}: {ex}"
        return jsonify(ok=False, error=msg, output=msg, phase="error"), 500


def _live_start():
    d = request.get_json(silent=True) or {}
    mode = d.get("mode") or "run"
    f = None
    if mode == "run":
        s, f, e = _file(d.get("file_id"), write=True)
        if e:
            return e
        # A new file has no main() yet, so _compilable() can be false; still run any supported language
        # and let the compiler/interpreter report the real problem in the shell.
        if not (_compilable(f) or (f["language"] or "").lower() in ("python", "java", "javascript", "c", "cpp")):
            return err("This file can't be compiled/run (supported: Java, Python, JavaScript, C, C++).")
    else:
        s, e = _sess(d.get("session_id"), write=True)
        if e:
            return e
    _ensure_reaper()
    _stop_owner_runs(g.u["id"])
    files = _siblings(s["id"])
    tmp = tempfile.mkdtemp(prefix="lt_live_")
    try:
        _write_files(tmp, files)
        if mode == "run":
            language = f["language"]
            risk, reasons = lt_exec.screen(files[f["name"]].decode("utf-8", "replace"))
            if risk == "high":
                shutil.rmtree(tmp, ignore_errors=True)
                return jsonify(ok=False, security_rejected=True, risk=risk, reasons=reasons, language=language,
                               output="Not run: flagged by the local safety screen (" + "; ".join(reasons) + ").")
            cmd, fail = _compile(tmp, language, files, os.path.basename(f["name"]))
        else:
            language = (d.get("language") or "python").lower()
            if language == "python":
                cmd, fail = [shutil.which("python3") or shutil.which("python") or "python3", "-i", "-q", "-u"], None
            elif language == "java":
                jsh = shutil.which("jshell")
                if not jsh:
                    cmd, fail = None, {"phase": "unsupported", "stderr": "jshell was not found (it ships with JDK 9+).", "output": "jshell was not found (it ships with JDK 9+)."}
                else:
                    # make each of the student's classes importable; a file that doesn't compile is simply skipped
                    for n in files:
                        if lt_exec.ext_of(n) == "java":
                            lt_exec._sh([shutil.which("javac") or "javac", "-encoding", "UTF-8", "-sourcepath", ".", "-d", ".",
                                         os.path.basename(n)], tmp, timeout=30)
                    cmd, fail = [jsh, "-q", "--class-path", tmp], None
            else:
                cmd, fail = None, {"phase": "unsupported", "stderr": f"No shell for '{language}'.", "output": f"No shell for '{language}'."}
        if fail:
            shutil.rmtree(tmp, ignore_errors=True)
            return jsonify(ok=False, language=language, **fail)
        run_obj = Run(g.u["id"], tmp, language)
        run_obj.repl = mode != "run"
        try:
            _spawn(run_obj, cmd)
        except FileNotFoundError as ex:
            shutil.rmtree(tmp, ignore_errors=True)
            return jsonify(ok=False, language=language, phase="unsupported",
                           stderr=f"Toolchain not found: {ex.filename}", output=f"Toolchain not found: {ex.filename}")
        with LOCK:
            RUNS[run_obj.id] = run_obj
        _usage(s)
        return jsonify(ok=True, run_id=run_obj.id, language=language, pty=run_obj.pty, echo_input=not run_obj.pty)
    except Exception:
        shutil.rmtree(tmp, ignore_errors=True)
        raise


@bp.get("/api/deep/live/poll")
@student_api
def live_poll():
    r = _own(request.args.get("run_id"))
    if not r:
        return err("That run has ended.", 404)
    try:
        since = max(0, int(request.args.get("since", "0")))
    except ValueError:
        since = 0
    with r.lock:
        done = r.done                      # read BEFORE the output: output is final once `done` is set
        text = r.out[since:]
        nxt = len(r.out)
    return jsonify(ok=True, text=text, next=nxt, done=done, exit_code=r.exit_code if done else None)


@bp.post("/api/deep/live/input")
@student_api
def live_input():
    d = request.get_json(silent=True) or {}
    r = _own(d.get("run_id"))
    if not r or r.done:
        return err("The program is not running.", 409)
    text = str(d.get("text") or "")[:4000]
    if r.repl:
        risk, reasons = lt_exec.screen(text)                  # shell mode: screen what is typed
        if reasons:
            return err("Blocked by the local safety screen: " + "; ".join(reasons))
    try:
        r.write(text.encode("utf-8") + (b"\n" if os.name == "posix" or r.pty else b"\r\n"))
    except (BrokenPipeError, OSError):
        return err("The program is not running.", 409)
    return jsonify(ok=True)


@bp.post("/api/deep/live/signal")
@student_api
def live_signal():
    d = request.get_json(silent=True) or {}
    r = _own(d.get("run_id"))
    if not r or r.done:
        return jsonify(ok=True, done=True)
    sig = d.get("signal")
    try:
        if sig == "interrupt" and os.name == "posix":
            os.killpg(os.getpgid(r.proc.pid), signal.SIGINT)   # same as Ctrl+C in a terminal (KeyboardInterrupt)
        elif sig == "eof" and r.pty:
            r.write(b"\x04")
        elif sig == "eof":
            r.proc.stdin.close()
        else:                                                 # kill (and interrupt without a pty)
            r.kill()
    except (BrokenPipeError, ProcessLookupError, OSError):
        pass
    return jsonify(ok=True)
