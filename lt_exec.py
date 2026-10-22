"""Language detection, risk screening, static analysis and local code execution.

WARNING: runs code directly on this machine in a temp dir with a timeout. The risk
screen below is a best-effort keyword filter, NOT a sandbox. Only run code you trust,
or run this backend inside a container/VM.
"""
import hashlib
import mimetypes
import os
import re
import shutil
import subprocess
import tempfile

RUN_TIMEOUT = int(os.environ.get("LT_RUN_TIMEOUT", "10"))
MAX_OUT = 20000

LANG_BY_EXT = {
    "py": "python", "c": "c", "h": "c", "cpp": "cpp", "cc": "cpp", "cxx": "cpp", "hpp": "cpp",
    "java": "java", "js": "javascript", "mjs": "javascript", "ts": "typescript",
    "rb": "ruby", "go": "go", "rs": "rust", "cs": "csharp", "php": "php", "sh": "bash",
    "html": "html", "css": "css", "json": "json", "md": "markdown", "txt": "text",
    "csv": "csv", "sql": "sql", "kt": "kotlin", "swift": "swift",
}
SOURCE_LANGS = {"python", "c", "cpp", "java", "javascript", "typescript", "ruby", "go", "rust",
                "csharp", "php", "bash", "kotlin", "swift", "sql"}
RUNNABLE = {"python", "c", "cpp", "java", "javascript"}
TEXT_EXT = set(LANG_BY_EXT) | {"xml", "yml", "yaml", "ini", "cfg", "toml", "log", "tsv", "rst"}

TAG_LABELS = {
    "assignment_spec": "Assignment spec", "starter_code": "Starter code", "solution": "Solution",
    "test": "Tests / grader", "data": "Data file", "reference": "Reference material",
    "rubric": "Rubric",
}
AVAILABLE_TAGS = list(TAG_LABELS)

RISK_PATTERNS = [
    (r"\bos\.system\b|\bsubprocess\b|\bPopen\b|\bpopen\s*\(|\bsystem\s*\(", "Spawns shell commands / subprocesses"),
    (r"\bsocket\b|\burllib\b|\brequests\b|\bhttp\.client\b|\bcurl\b|\bwget\b|java\.net\.|XMLHttpRequest|\bfetch\(", "Network access"),
    (r"\brm\s+-rf\b|\bshutil\.rmtree\b|\bos\.remove\b|\bos\.unlink\b|\bunlink\s*\(|\bremove\s*\(\s*[\"']/", "Deletes files"),
    (r"\bfork\s*\(|\bexecv?[lpe]*\s*\(|Runtime\.getRuntime|ProcessBuilder|child_process", "Process creation / exec"),
    (r"/etc/passwd|/etc/shadow|~/\.ssh|\.aws/credentials|\bos\.environ\b|\bgetenv\s*\(", "Reads system secrets / environment"),
    (r"\beval\s*\(|\bexec\s*\(|__import__\s*\(", "Dynamic code execution"),
    (r"while\s*\(\s*(true|1)\s*\)\s*\{\s*\}|while\s+True\s*:\s*pass", "Obvious infinite loop"),
]


def ext_of(name):
    return name.rsplit(".", 1)[-1].lower() if "." in (name or "") else ""


def detect(name, data: bytes):
    """-> dict(language, mimetype, is_text, is_source, has_main)"""
    ext = ext_of(name)
    mime = mimetypes.guess_type(name)[0] or ("text/plain" if ext in TEXT_EXT else "application/octet-stream")
    is_text = ext in TEXT_EXT or (not ext and b"\x00" not in data[:2048])
    if is_text and b"\x00" in data[:4096]:
        is_text = False
    lang = LANG_BY_EXT.get(ext, "")
    text = data.decode("utf-8", "replace") if is_text else ""
    has_main = False
    if lang == "python":
        has_main = True     # a python script is runnable on its own
    elif lang in ("c", "cpp"):
        has_main = bool(re.search(r"\bint\s+main\s*\(", text))
    elif lang == "java":
        has_main = bool(re.search(r"public\s+static\s+void\s+main\s*\(", text))
    elif lang == "javascript":
        has_main = True
    return {"language": lang, "mimetype": mime, "is_text": is_text,
            "is_source": lang in SOURCE_LANGS, "has_main": has_main}


def sha(data: bytes):
    return hashlib.sha256(data or b"").hexdigest()[:16]


def screen(code: str):
    """-> (risk 'low'|'medium'|'high', [reasons])"""
    reasons = [why for pat, why in RISK_PATTERNS if re.search(pat, code or "", re.I)]
    risk = "low" if not reasons else ("medium" if len(reasons) == 1 else "high")
    return risk, reasons


def analyze(name, code, language, sibling_names=()):
    """Cheap static analysis (no LLM needed). Shape matches what the modal renders."""
    risk, reasons = screen(code)
    needs_stdin = bool(re.search(r"\binput\s*\(|\bscanf\s*\(|\bcin\s*>>|Scanner\s*\(\s*System\.in|readline\s*\(|fgets\s*\(\s*\w+\s*,\s*\w+\s*,\s*stdin", code))
    reads = re.findall(r"open\(\s*[\"']([^\"']+)[\"']\s*(?:,\s*[\"']r[b]?[\"'])?\s*\)", code)
    writes = re.findall(r"open\(\s*[\"']([^\"']+)[\"']\s*,\s*[\"'][wa]", code)
    reads = [r for r in reads if r not in writes]
    includes = re.findall(r'#include\s+"([^"]+)"', code)
    imports = re.findall(r"^\s*(?:from|import)\s+([A-Za-z_][\w]*)", code, re.M) if language == "python" else []
    local_mods = {n.rsplit(".", 1)[0] for n in sibling_names}
    missing = [i for i in includes if i not in sibling_names]
    missing += [f"{m}.py" for m in imports if m in local_mods and f"{m}.py" not in sibling_names]
    abs_paths = re.findall(r"[\"'](/(?:home|Users|tmp|var|etc)/[^\"']*|[A-Za-z]:\\\\[^\"']*)[\"']", code)
    return {
        "program_description": f"{language or 'text'} file '{name}', {len(code.splitlines())} lines.",
        "needs_stdin": needs_stdin, "suggested_stdin": "", "safe_stdin": "",
        "reads_files": bool(reads), "writes_files": bool(writes),
        "expected_read_files": reads, "expected_write_files": writes,
        "aux_files": [n for n in sibling_names if n != name],
        "missing_deps": missing, "sibling_count": len(sibling_names),
        "uses_absolute_paths": bool(abs_paths),
        "absolute_path_warning": ("Uses absolute paths: " + ", ".join(abs_paths[:3])) if abs_paths else "",
        "security_notes": reasons, "risk": risk,
    }


def _clip(s):
    s = s or ""
    return s if len(s) <= MAX_OUT else s[:MAX_OUT] + "\n…[output truncated]"


def _sh(cmd, cwd, stdin="", timeout=RUN_TIMEOUT):
    try:
        p = subprocess.run(cmd, cwd=cwd, input=stdin, capture_output=True, text=True, timeout=timeout,
                           env={"PATH": os.environ.get("PATH", ""), "HOME": cwd, "LANG": "C.UTF-8"})
        return p.returncode, p.stdout, p.stderr, False
    except subprocess.TimeoutExpired as e:
        return 124, (e.stdout or b"").decode() if isinstance(e.stdout, bytes) else (e.stdout or ""), \
            f"Timed out after {timeout}s", True
    except FileNotFoundError as e:
        return 127, "", f"Toolchain not found: {e.filename}", False


def execute(main_name, language, files, stdin="", confirmed=False):
    """Compile (if needed) + run `main_name`. `files` = {name: bytes} (siblings included).

    Returns the dict shape the frontend expects (ok, exit_code, stdout, stderr, phase,
    written_files, security_rejected, risk, reasons, analysis).
    """
    code = files[main_name].decode("utf-8", "replace")
    risk, reasons = screen(code)
    if risk == "high" and not confirmed:
        return {"ok": False, "security_rejected": True, "risk": risk, "reasons": reasons,
                "analysis": "Blocked by the local keyword screen before execution.",
                "exit_code": None, "stdout": "", "stderr": "", "phase": "screen"}
    if language not in RUNNABLE:
        return {"ok": False, "exit_code": None, "stdout": "", "stderr": f"Running '{language or 'this file type'}' is not supported.",
                "phase": "unsupported", "output": f"Running '{language or 'this file type'}' is not supported."}

    tmp = tempfile.mkdtemp(prefix="lt_run_")
    try:
        before = {}
        for n, data in files.items():
            safe = os.path.basename(n)
            with open(os.path.join(tmp, safe), "wb") as fh:
                fh.write(data)
            before[safe] = sha(data)
        main = os.path.basename(main_name)
        stem = main.rsplit(".", 1)[0]
        phase = "run"
        if language == "python":
            cmd = [shutil.which("python3") or "python3", main]
        elif language == "javascript":
            cmd = [shutil.which("node") or "node", main]
        elif language in ("c", "cpp"):
            cc = shutil.which("gcc" if language == "c" else "g++") or ("gcc" if language == "c" else "g++")
            srcs = [os.path.basename(n) for n in files if ext_of(n) in (("c",) if language == "c" else ("cpp", "cc", "cxx"))]
            rc, so, se, _ = _sh([cc, "-O0", "-o", "prog", *srcs, "-lm"], tmp)
            if rc != 0:
                return {"ok": False, "exit_code": rc, "stdout": _clip(so), "stderr": _clip(se),
                        "phase": "compile", "output": _clip(se or so)}
            cmd = [os.path.join(tmp, "prog")]
        else:  # java
            rc, so, se, _ = _sh([shutil.which("javac") or "javac", *[os.path.basename(n) for n in files if ext_of(n) == "java"]], tmp)
            if rc != 0:
                return {"ok": False, "exit_code": rc, "stdout": _clip(so), "stderr": _clip(se),
                        "phase": "compile", "output": _clip(se or so)}
            cmd = [shutil.which("java") or "java", "-cp", tmp, stem]
        rc, so, se, timed_out = _sh(cmd, tmp, stdin or "")
        written = []
        for n in sorted(os.listdir(tmp)):
            p = os.path.join(tmp, n)
            if n in ("prog",) or n.endswith(".class") or not os.path.isfile(p):
                continue
            with open(p, "rb") as fh:
                data = fh.read()
            if n not in before or before[n] != sha(data):
                written.append({"filename": n, "size": len(data), "truncated": len(data) > 5000,
                                "content": data[:5000].decode("utf-8", "replace")})
        return {"ok": rc == 0 and not timed_out, "exit_code": rc, "stdout": _clip(so), "stderr": _clip(se),
                "phase": "timeout" if timed_out else phase, "written_files": written,
                "output": _clip(so or se), "output_evaluations": [], "security_rejected": False,
                "risk": risk, "reasons": reasons}
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
