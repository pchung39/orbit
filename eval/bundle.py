"""Run bundles for baseline/candidate release comparison.

Full-suite runs write eval/candidate.json with check-level detail.
Approved baselines live in eval/baseline.json (explicit promotion only).
"""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Sequence

from eval.cases import CASES, Case
from eval.score import Observed
from eval.scorecard import Scorecard

EVAL_DIR = Path(__file__).resolve().parent
CANDIDATE_PATH = EVAL_DIR / "candidate.json"
BASELINE_PATH = EVAL_DIR / "baseline.json"
COMPARISON_PATH = EVAL_DIR / "comparison.json"
LLM_PATH = Path(__file__).resolve().parent.parent / "agent" / "llm.py"

SUITE_CASE_IDS = [c.id for c in CASES]


def suite_fingerprint() -> str:
    payload = [
        {
            "id": c.id,
            "alarm": c.alarm,
            "root_cause": c.root_cause,
            "action": c.action,
        }
        for c in CASES
    ]
    raw = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def case_contract(case: Case) -> dict[str, Any]:
    return {
        "id": case.id,
        "alarm": case.alarm,
        "label": case.label,
        "root_cause": case.root_cause,
        "confounder": case.confounder,
        "procedure": case.procedure,
        "similar": case.similar,
        "action": case.action,
    }


def observed_to_dict(observed: Observed) -> dict[str, Any]:
    return {
        "heater_a": observed.heater_a,
        "payload_a": observed.payload_a,
        "warn_clock": observed.warn_clock,
        "has_science": observed.has_science,
    }


def withhold_explanation(case: Case, observed: Observed) -> str:
    heater = f"{observed.heater_a:.2f} A" if observed.heater_a is not None else "observed sample"
    confounder = case.confounder or "SCIENCE_MODE"
    similar = case.similar or "INC-0187"
    return (
        "Why withholding is correct for marg001:\n"
        f"- Heater B current (~{heater}) is below the EPS-17 step-4 ≥2× bar — not prime-suspect territory.\n"
        f"- {confounder} is a confounder in the same window, not proof of payload guilt.\n"
        f"- Prior {similar} must be ruled out as a non-match, not used as confirmation.\n"
        "- Correct action is hold / do not command — no inhibit Heater B, no payload safe, no FAULT id."
    )


def prompt_fingerprint(provider: str) -> str | None:
    if provider == "rules":
        return None
    if not LLM_PATH.exists():
        return None
    text = LLM_PATH.read_text(encoding="utf-8")
    match = re.search(r'SYSTEM\s*=\s*"""(.*?)"""', text, re.DOTALL)
    if not match:
        return None
    return hashlib.sha256(match.group(1).encode("utf-8")).hexdigest()


def build_run_bundle(
    results: Sequence[Any],
    card: Scorecard,
    provider: str,
    model: str | None,
    *,
    kind: str = "candidate",
    baseline_id: str | None = None,
    approved_at: str | None = None,
    note: str | None = None,
) -> dict[str, Any]:
    generated_at = card.generated_at
    run_id = f"run-{generated_at.replace(':', '').replace('-', '')}-{provider}"
    cases: dict[str, Any] = {}
    case_by_id = {c.id: c for c in CASES}

    for result in results:
        case = case_by_id.get(result.case_id)
        if case is None:
            continue
        observed: Observed = result.observed
        case_entry: dict[str, Any] = {
            "contract": case_contract(case),
            "observed": observed_to_dict(observed),
            "report": result.report,
            "ok": bool(result.ok),
            "passed": result.passed,
            "total": result.total,
            "checks": [asdict(c) for c in result.checks],
        }
        if case.id == "marg001":
            case_entry["withhold_explanation"] = withhold_explanation(case, observed)
        cases[case.id] = case_entry

    bundle: dict[str, Any] = {
        "schema_version": 1,
        "kind": kind,
        "run_id": run_id,
        "generated_at": generated_at,
        "suite_fingerprint": suite_fingerprint(),
        "suite_case_ids": list(SUITE_CASE_IDS),
        "agent": {
            "provider": provider,
            "model": model,
            "prompt_fingerprint": prompt_fingerprint(provider),
        },
        "scorecard": card.as_dict(),
        "cases": cases,
    }
    if kind == "approved_baseline":
        bundle["baseline_id"] = baseline_id or run_id
        bundle["approved_at"] = approved_at or generated_at
        if note:
            bundle["note"] = note
    return bundle


def write_json(path: Path, data: dict[str, Any]) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
    return path


def write_candidate(bundle: dict[str, Any], path: Path = CANDIDATE_PATH) -> Path:
    return write_json(path, bundle)


def write_baseline(bundle: dict[str, Any], path: Path = BASELINE_PATH) -> Path:
    return write_json(path, bundle)


def write_comparison(data: dict[str, Any], path: Path = COMPARISON_PATH) -> Path:
    return write_json(path, data)


def load_json(path: Path) -> dict[str, Any] | None:
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else None
    except (OSError, json.JSONDecodeError):
        return None


def load_candidate(path: Path = CANDIDATE_PATH) -> dict[str, Any] | None:
    return load_json(path)


def load_baseline(path: Path = BASELINE_PATH) -> dict[str, Any] | None:
    return load_json(path)


def load_comparison(path: Path = COMPARISON_PATH) -> dict[str, Any] | None:
    return load_json(path)


class PromoteError(Exception):
    """Baseline promotion rejected."""


def promote_candidate_to_baseline(
    *,
    note: str | None = None,
    force: bool = False,
    candidate_path: Path = CANDIDATE_PATH,
    baseline_path: Path = BASELINE_PATH,
    comparison_path: Path = COMPARISON_PATH,
) -> Path:
    candidate = load_candidate(candidate_path)
    if candidate is None:
        raise PromoteError("no eval/candidate.json — run a full suite first")

    if not force:
        comparison = load_comparison(comparison_path)
        if comparison is None or comparison.get("recommendation") != "PASS":
            raise PromoteError(
                "last comparison is not PASS — run python -m eval --compare-baseline or use --force"
            )

    approved_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    baseline_id = f"bl-{approved_at.replace(':', '').replace('-', '')}"
    bundle = dict(candidate)
    bundle["kind"] = "approved_baseline"
    bundle["baseline_id"] = baseline_id
    bundle["approved_at"] = approved_at
    if note:
        bundle["note"] = note
    return write_baseline(bundle, baseline_path)
