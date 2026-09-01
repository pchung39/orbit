"""Compare candidate run bundle against an approved baseline."""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from eval.bundle import (
    BASELINE_PATH,
    CANDIDATE_PATH,
    COMPARISON_PATH,
    load_baseline,
    load_candidate,
    write_comparison,
)
from eval.release_gate import release_verdict


def compare_bundles(
    baseline: dict[str, Any] | None,
    candidate: dict[str, Any] | None,
) -> dict[str, Any]:
    verdict = release_verdict(baseline, candidate)
    return {
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "baseline": {
            "run_id": (baseline or {}).get("run_id"),
            "baseline_id": (baseline or {}).get("baseline_id"),
            "approved_at": (baseline or {}).get("approved_at"),
            "generated_at": (baseline or {}).get("generated_at"),
            "agent": (baseline or {}).get("agent"),
        },
        "candidate": {
            "run_id": (candidate or {}).get("run_id"),
            "generated_at": (candidate or {}).get("generated_at"),
            "agent": (candidate or {}).get("agent"),
        },
        **verdict,
    }


def run_compare(
    baseline_path: Path | None = None,
    candidate_path: Path | None = None,
    *,
    write: bool = True,
) -> dict[str, Any]:
    baseline = load_baseline(baseline_path or BASELINE_PATH)
    candidate = load_candidate(candidate_path or CANDIDATE_PATH)
    result = compare_bundles(baseline, candidate)
    if write:
        write_comparison(result)
    return result


def print_comparison(result: dict[str, Any]) -> None:
    rec = result.get("recommendation", "—")
    print(f"RELEASE: {rec}")
    print(result.get("explanation") or "")
    print()
    if blockers := result.get("blockers") or []:
        print("Blockers:")
        for b in blockers:
            print(f"  - [{b.get('kind')}] {b.get('case_id')}.{b.get('check_id')}: {b.get('detail')}")
        print()
    if warnings := result.get("warnings") or []:
        print("Warnings (non-blocking):")
        for w in warnings:
            print(f"  - {w.get('message')}")
        print()
    if metrics := result.get("metrics") or []:
        print("Metrics (baseline → candidate, Δ):")
        for m in metrics:
            print(
                f"  {m.get('label')}: {m.get('baseline_passed')}/{m.get('baseline_total')} → "
                f"{m.get('candidate_passed')}/{m.get('candidate_total')} (Δ{m.get('delta'):+d})"
            )
        print()
    cases = result.get("cases") or {}
    print(
        f"Cases: {cases.get('improved', 0)} improved · "
        f"{cases.get('unchanged', 0)} unchanged · "
        f"{cases.get('regressed', 0)} regressed"
    )
