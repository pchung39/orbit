"""LangSmith tracing for ORBIT investigations (Braintrust fallback).

Optional: if neither LANGSMITH_API_KEY nor BRAINTRUST_API_KEY is set, tracing is a no-op.
Loads `.env`, `.env.langsmith`, and `.env.braintrust` (gitignored) without overriding existing env.
"""

from __future__ import annotations

import functools
import os
import sys
import warnings
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Callable, Iterator, Literal, TypeVar

ROOT = Path(__file__).resolve().parent.parent
_F = TypeVar("_F", bound=Callable[..., Any])

_inited = False
_enabled = False
_backend: Literal["langsmith", "braintrust", ""] = ""

_RUN_TYPE_MAP = {
    "task": "chain",
    "chain": "chain",
    "tool": "tool",
    "llm": "llm",
}


def load_env_files() -> None:
    """Load KEY=VALUE pairs from .env then provider-specific files (do not override existing)."""
    for name in (".env", ".env.langsmith", ".env.braintrust"):
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


def _project_name(project: str | None = None) -> str:
    return project or os.environ.get("LANGSMITH_PROJECT", "ORBIT")


def _langsmith_available() -> bool:
    try:
        import langsmith  # noqa: F401

        return True
    except ImportError:
        return False


def init_tracing(project: str | None = None) -> bool:
    """Initialize tracing once. Returns True when tracing is active."""
    global _inited, _enabled, _backend
    if _inited:
        return _enabled

    load_env_files()
    _inited = True

    api_key = os.environ.get("LANGSMITH_API_KEY")
    if api_key:
        if not _langsmith_available():
            warnings.warn(
                "LANGSMITH_API_KEY is set but the langsmith package is not installed "
                "in this Python environment. Run: pip install -r requirements.txt",
                stacklevel=2,
            )
        else:
            os.environ.setdefault("LANGSMITH_TRACING", "true")
            os.environ.setdefault("LANGSMITH_PROJECT", _project_name(project))
            _backend = "langsmith"
            _enabled = True
            return True

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

    bt_key = os.environ.get("BRAINTRUST_API_KEY")
    if bt_key:
        try:
            import braintrust

            braintrust.auto_instrument()
            braintrust.init_logger(
                api_key=bt_key,
                project=project or os.environ.get("BRAINTRUST_PROJECT", "ORBIT_AI"),
            )
            _backend = "braintrust"
            _enabled = True
        except Exception:
            _enabled = False
            _backend = ""
    return _enabled


def flush_tracing() -> None:
    if not _enabled:
        return
    if _backend == "langsmith":
        try:
            from langsmith import Client

            Client().flush()
        except Exception:
            pass
        return
    if _backend == "braintrust":
        try:
            import braintrust

            flush = getattr(braintrust, "flush", None)
            if callable(flush):
                flush()
        except Exception:
            pass


def tracing_enabled() -> bool:
    return _enabled


def tracing_backend() -> str:
    init_tracing()
    return _backend


def wrap_openai_client(client: Any) -> Any:
    if init_tracing() and _backend == "langsmith":
        try:
            from langsmith.wrappers import wrap_openai

            return wrap_openai(client)
        except Exception:
            return client
    if _backend == "braintrust":
        try:
            from braintrust import wrap_openai

            return wrap_openai(client)
        except Exception:
            return client
    return client


def wrap_anthropic_client(client: Any) -> Any:
    if init_tracing() and _backend == "langsmith":
        try:
            from langsmith.wrappers import wrap_anthropic

            return wrap_anthropic(client)
        except Exception:
            return client
    if _backend == "braintrust":
        try:
            from braintrust import wrap_anthropic

            return wrap_anthropic(client)
        except Exception:
            return client
    return client


@contextmanager
def span(
    name: str,
    *,
    span_type: str = "task",
    input: Any = None,
    metadata: dict[str, Any] | None = None,
) -> Iterator[Any]:
    """Open a trace span, or yield None when tracing is off."""
    if not init_tracing():
        yield None
        return
    if _backend == "langsmith":
        with _langsmith_span(name, span_type=span_type, input=input, metadata=metadata) as sp:
            yield sp
        return
    with _braintrust_span(name, span_type=span_type, input=input, metadata=metadata) as sp:
        yield sp


@contextmanager
def _langsmith_span(
    name: str,
    *,
    span_type: str,
    input: Any,
    metadata: dict[str, Any] | None,
) -> Iterator[Any]:
    try:
        from langsmith.run_helpers import get_current_run_tree, tracing_context
        from langsmith.run_trees import RunTree

        inputs: dict[str, Any] = {}
        if input is not None:
            inputs["input"] = _safe_output(input)
        run = RunTree(
            name=name,
            run_type=_RUN_TYPE_MAP.get(span_type, span_type),
            inputs=inputs,
            parent_run=get_current_run_tree(),
            project_name=_project_name(),
        )
        if metadata:
            run.add_metadata(metadata)
        run.post()
        with tracing_context(parent=run):
            try:
                yield run
            finally:
                run.end()
                run.patch()
    except Exception as exc:
        print(f"LangSmith span {name!r} failed: {exc}", file=sys.stderr)
        yield None


@contextmanager
def _braintrust_span(
    name: str,
    *,
    span_type: str,
    input: Any,
    metadata: dict[str, Any] | None,
) -> Iterator[Any]:
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
        from langsmith.run_trees import RunTree

        if isinstance(sp, RunTree):
            if "input" in kwargs and kwargs["input"] is not None:
                sp.add_inputs({"input": _safe_output(kwargs["input"])})
            if "output" in kwargs and kwargs["output"] is not None:
                sp.add_outputs({"output": _safe_output(kwargs["output"])})
            if "metadata" in kwargs and kwargs["metadata"]:
                sp.add_metadata(kwargs["metadata"])
            return
    except Exception:
        pass
    try:
        sp.log(**kwargs)
    except Exception:
        pass


def traced(name: str | None = None, *, span_type: str = "task") -> Callable[[_F], _F]:
    """Decorator: wrap a function in a trace span when tracing is enabled."""

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
        if len(value) > 80_000:
            return value[:80_000] + "\n…[truncated]"
        return value
    if isinstance(value, dict):
        return {str(k): _safe_output(v) for k, v in list(value.items())[:40]}
    if isinstance(value, (list, tuple)):
        return [_safe_output(v) for v in list(value)[:40]]
    return str(value)[:2000]
