"""LLM adapter: runs a LOCAL model (Ollama, LM Studio, llama.cpp) or the Anthropic API.

Pick the provider with LT_LLM:
  auto       (default) Anthropic if ANTHROPIC_API_KEY is set, otherwise the local server
  local      always use the local server
  anthropic  always use Anthropic

Local server settings (defaults match a stock Ollama install):
  LT_LOCAL_URL    http://127.0.0.1:11434
  LT_LOCAL_MODEL  qwen2.5-coder:7b
  LT_LOCAL_API    ollama | openai     (openai = LM Studio / llama.cpp / vLLM at <url>/v1/...)
  LT_NUM_CTX      8192                (context window requested from Ollama)
  LT_LOCAL_TIMEOUT 180                (seconds; first request loads the model, so it is slower)

Anthropic: ANTHROPIC_API_KEY, optional LT_MODEL (default claude-sonnet-5-5).

Test your setup:  python lt_llm.py
Stdlib only for the local path (no extra pip packages).
"""
import json
import os
import time
import urllib.error
import urllib.request

PROVIDER = os.environ.get("LT_LLM", "auto").lower()
# Anthropic model
MODEL = os.environ.get("LT_MODEL", "claude-sonnet-5-5")
LOCAL_URL = os.environ.get(
    "LT_LOCAL_URL", "http://127.0.0.1:11434").rstrip("/")
LOCAL_MODEL = os.environ.get("LT_LOCAL_MODEL", "qwen2.5-coder:7b")
LOCAL_API = os.environ.get("LT_LOCAL_API", "ollama").lower()
NUM_CTX = int(os.environ.get("LT_NUM_CTX", "8192"))
LOCAL_TIMEOUT = float(os.environ.get("LT_LOCAL_TIMEOUT", "180"))
# ~4 chars/token -> leave half the window for chat + answer
MAX_SYSTEM_CHARS = NUM_CTX * 2

_cache = {"t": 0.0, "val": None}


class LLMUnavailable(RuntimeError):
    pass


def provider():
    if PROVIDER in ("local", "anthropic"):
        return PROVIDER
    return "anthropic" if os.environ.get("ANTHROPIC_API_KEY") else "local"


def _http(path, payload=None, timeout=5.0):
    req = urllib.request.Request(LOCAL_URL + path, method="POST" if payload is not None else "GET",
                                 data=json.dumps(payload).encode(
                                 ) if payload is not None else None,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8", "replace") or "{}")


def _local_status():
    try:
        if LOCAL_API == "ollama":
            names = [m.get("name", "")
                     for m in _http("/api/tags").get("models", [])]
            base = LOCAL_MODEL if ":" in LOCAL_MODEL else LOCAL_MODEL + ":latest"
            if base not in names and LOCAL_MODEL not in names:
                return False, (f"Ollama is running but model '{LOCAL_MODEL}' is not installed. "
                               f"Run:  ollama pull {LOCAL_MODEL}")
        else:
            _http("/v1/models")
    except urllib.error.URLError as e:
        return False, (f"No local model server at {LOCAL_URL} ({getattr(e, 'reason', e)}). "
                       "Install Ollama (ollama.com), start it, then:  ollama pull " + LOCAL_MODEL)
    except Exception as e:
        return False, f"Local model server check failed: {e}"
    return True, f"Local model ready: {LOCAL_MODEL} via {LOCAL_URL}"


def status():
    """-> (ok, reason). Cheap; the local check is cached for 10 s."""
    if provider() == "anthropic":
        if not os.environ.get("ANTHROPIC_API_KEY"):
            return False, "ANTHROPIC_API_KEY is not set in the terminal that starts the server."
        try:
            import anthropic  # noqa: F401
        except ImportError:
            return False, "The 'anthropic' package is not installed (pip install anthropic)."
        return True, f"Anthropic ready (model: {MODEL})."
    if time.time() - _cache["t"] > 10 or _cache["val"] is None:
        _cache.update(t=time.time(), val=_local_status())
    return _cache["val"]


def label():
    return LOCAL_MODEL if provider() == "local" else MODEL


def available():
    return status()[0]


def _complete_local(system, messages, max_tokens):
    system = (system or "")[:MAX_SYSTEM_CHARS]
    msgs = ([{"role": "system", "content": system}]
            if system else []) + list(messages)
    try:
        if LOCAL_API == "ollama":
            d = _http("/api/chat", {"model": LOCAL_MODEL, "messages": msgs, "stream": False, "keep_alive": "30m",
                                    "options": {"num_ctx": NUM_CTX, "num_predict": max_tokens, "temperature": 0.3}},
                      timeout=LOCAL_TIMEOUT)
            return (d.get("message", {}).get("content") or "").strip()
        d = _http("/v1/chat/completions", {"model": LOCAL_MODEL, "messages": msgs, "max_tokens": max_tokens,
                                           "temperature": 0.3}, timeout=LOCAL_TIMEOUT)
        return (d["choices"][0]["message"]["content"] or "").strip()
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace")[:300]
        raise LLMUnavailable(f"Local model error {e.code}: {body}")
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        _cache["val"] = None
        raise LLMUnavailable(f"Could not get an answer from the local model at {LOCAL_URL}: {getattr(e, 'reason', e)}. "
                             "If this is the first request, the model may still be loading; try again.")
    except (KeyError, IndexError, ValueError) as e:
        raise LLMUnavailable(
            f"Unexpected reply from the local model server: {e}")


def _complete_anthropic(system, messages, max_tokens):
    import anthropic
    try:
        client = anthropic.Anthropic(timeout=60.0)
        resp = client.messages.create(
            model=MODEL, max_tokens=max_tokens, system=system, messages=messages)
        return "".join(b.text for b in resp.content if getattr(b, "type", "") == "text").strip()
    except anthropic.AuthenticationError:
        raise LLMUnavailable(
            "Anthropic rejected the API key (401). Check ANTHROPIC_API_KEY.")
    except anthropic.NotFoundError:
        raise LLMUnavailable(
            f"Model '{MODEL}' was not found for this key. Set LT_MODEL to a model you can use.")
    except anthropic.RateLimitError:
        raise LLMUnavailable(
            "Rate limit or quota reached (429). Try again shortly or check your billing.")
    except anthropic.APIConnectionError as e:
        raise LLMUnavailable(
            f"Could not reach the Anthropic API (network/proxy/firewall): {e}")
    except Exception as e:
        raise LLMUnavailable(f"LLM request failed: {e}")


def complete(system, messages, max_tokens=1200):
    """messages = [{"role": "user"|"assistant", "content": str}, ...] -> str"""
    ok, why = status()
    if not ok:
        raise LLMUnavailable(why)
    out = _complete_anthropic(system, messages, max_tokens) if provider() == "anthropic" \
        else _complete_local(system, messages, max_tokens)
    if not out:
        raise LLMUnavailable("The model returned an empty reply.")
    return out


if __name__ == "__main__":
    ok, why = status()
    print(f"provider={provider()}  |  {why}")
    if ok:
        t0 = time.time()
        try:
            print("Reply:", complete("Reply in one short sentence.",
                  [{"role": "user", "content": "Say ready."}], 40))
            print(f"({time.time() - t0:.1f}s, includes model load on first call)")
        except LLMUnavailable as e:
            print("FAILED:", e)
