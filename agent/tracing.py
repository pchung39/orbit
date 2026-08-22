"""Braintrust tracing for ORBIT investigations.

Optional: if BRAINTRUST_API_KEY is unset or the SDK is missing, tracing is a no-op.
Loads `.env` and `.env.braintrust` (gitignored) the same way the LLM CLI does.
"""

from __future__ import annotations

import functools
import os
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Callable, Iterator, TypeVar

ROOT = Path(__file__).resolve().parent.parent
_F = TypeVar("_F", bound=Callable[..., Any])

_inited = False
_enabled = False


def load_env_files() -> None:
    """Load KEY=VALUE pairs from .env then .env.braintrust (do not override existing)."""
    for name in (".env", ".env.braintrust"):
        path = ROOT / name
        if not path.exists():
            continue
        for line in path.read_text().splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            key = key.strip()
            if key.startswith("//"):
                continue
            os.environ.setdefault(key, value.strip().strip("'").strip('"'))


def init_tracing(project: str | None = None) -> bool:
    """Initialize Braintrust logger once. Returns True when tracing is active."""
    global _inited, _enabled
    if _inited:
        return _enabled

    load_env_files()
    # Also pick up wizard JSON if the shell didn't export the key.
    json_path = ROOT / ".braintrust.json"
    if json_path.exists() and not os.environ.get("BRAINTRUST_API_KEY"):
        try:
            import json

            data = json.loads(json_path.read_text())
            key = data.get("BRAINTRUST_API_KEY")
            if isinstance(key, str) and key and not key.startswith("//"):
                os.environ.setdefault("BRAINTRUST_API_KEY", key)
        except (OSError, json.JSONDecodeError, TypeError):
            pass

    _inited = True
    api_key = os.environ.get("BRAINTRUST_API_KEY")
    if not api_key:
        _enabled = False
        return False

    try:
        import braintrust

        braintrust.auto_instrument()
        braintrust.init_logger(
            api_key=api_key,
            project=project or os.environ.get("BRAINTRUST_PROJECT", "ORBIT_AI"),
        )
        _enabled = True
    except Exception:
        _enabled = False
    return _enabled


def flush_tracing() -> None:
    if not _enabled:
        return
    try:
        import braintrust

        flush = getattr(braintrust, "flush", None)
        if callable(flush):
            flush()
    except Exception:
        pass


def tracing_enabled() -> bool:
    return _enabled


@contextmanager
def span(
    name: str,
    *,
    span_type: str = "task",
    input: Any = None,
    metadata: dict[str, Any] | None = None,
) -> Iterator[Any]:
    """Open a Braintrust span, or yield None when tracing is off."""
    if not init_tracing():
        yield None
        return
    try:
        from braintrust import start_span

        with start_span(name=name, type=span_type) as sp:
            payload: dict[str, Any] = {}
            if input is not None:
                payload["input"] = input
            if metadata:
                payload["metadata"] = metadata
            if payload:
                sp.log(**payload)
            yield sp
    except Exception:
        yield None


def log_to_span(sp: Any, **kwargs: Any) -> None:
    if sp is None:
        return
    try:
        sp.log(**kwargs)
    except Exception:
        pass


def traced(name: str | None = None, *, span_type: str = "task") -> Callable[[_F], _F]:
    """Decorator: wrap a function in a Braintrust span when tracing is enabled."""

    def decorate(fn: _F) -> _F:
        span_name = name or fn.__name__

        @functools.wraps(fn)
        def wrapper(*args: Any, **kwargs: Any) -> Any:
            with span(span_name, span_type=span_type) as sp:
                result = fn(*args, **kwargs)
                log_to_span(sp, output=_safe_output(result))
                return result

        return wrapper  # type: ignore[return-value]

    return decorate


def _safe_output(value: Any) -> Any:
    if value is None or isinstance(value, (bool, int, float)):
        return value
    if isinstance(value, str):
        # Cap huge investigation reports in the span payload.
        if len(value) > 80_000:
            return value[:80_000] + "\n…[truncated]"
        return value
    if isinstance(value, dict):
        return {str(k): _safe_output(v) for k, v in list(value.items())[:40]}
    if isinstance(value, (list, tuple)):
        return [_safe_output(v) for v in list(value)[:40]]
    return str(value)[:2000]
