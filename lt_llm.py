"""Optional LLM adapter.

Set ANTHROPIC_API_KEY (and `pip install anthropic`) to enable AI tutoring and AI file
summaries. Without a key every call raises LLMUnavailable; the app handles that
gracefully (messages are saved, summaries fall back to a simple heuristic, the UI shows
"Saved for retry — generation failed").

Override the model with LT_MODEL (default: claude-sonnet-5-5).
"""
import os

MODEL = os.environ.get("LT_MODEL", "claude-sonnet-5-5")


class LLMUnavailable(RuntimeError):
    pass


def available():
    if not os.environ.get("ANTHROPIC_API_KEY"):
        return False
    try:
        import anthropic  # noqa: F401
        return True
    except ImportError:
        return False


def complete(system, messages, max_tokens=1200):
    """messages = [{"role": "user"|"assistant", "content": str}, ...] -> str"""
    if not os.environ.get("ANTHROPIC_API_KEY"):
        raise LLMUnavailable("No ANTHROPIC_API_KEY set; AI features are disabled.")
    try:
        import anthropic
    except ImportError:
        raise LLMUnavailable("The 'anthropic' package is not installed (pip install anthropic).")
    try:
        client = anthropic.Anthropic()
        resp = client.messages.create(model=MODEL, max_tokens=max_tokens, system=system, messages=messages)
        return "".join(b.text for b in resp.content if getattr(b, "type", "") == "text").strip()
    except Exception as e:                       # network/auth/quota -> treat as unavailable
        raise LLMUnavailable(f"LLM request failed: {e}")
