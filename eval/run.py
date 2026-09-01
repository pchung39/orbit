"""Run cases through the investigator and score the reports.

Default provider is rules (no paid LLM). Pass --provider only if you
explicitly want a live model. Always prints a scorecard and writes
eval/scorecard.json when the full suite runs.
"""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import asdict, dataclass

from agent.investigate import investigate
from agent.tools import Tools
from agent.tracing import flush_tracing, init_tracing
from eval.bundle import (
    BASELINE_PATH,
    build_run_bundle,
    promote_candidate_to_baseline,
    write_candidate,
)
from eval.cases import CASES, Case
from eval.compare import print_comparison, run_compare
from eval.feedback import export_jsonl, load_feedback_rows, print_summary
from eval.score import Check, Observed, score
from eval.scorecard import build_scorecard, print_scorecard, write_scorecard
from simulator.scenarios import format_clock
from simulator.simulate import load_and_validate
from storage.store import connect, init_schema


@dataclass
class CaseResult:
    case_id: str
    label: str
    provider: str
    passed: int
    total: int
    ok: bool
    checks: list[Check]
    report: str = ""
    observed: Observed | None = None


def observe(case: Case) -> Observed:
    spec = load_and_validate()
    conn = connect()
    init_schema(conn)
    tools = Tools(conn, spec)
    crossing = tools.first_warn(case.id, case.alarm)
    if crossing is None:
        return Observed(heater_a=None, payload_a=None, warn_clock=None, has_science=False)
    t = crossing["time_s"]
    heater = tools.sample(case.id, "THM.heater_b_current", t)
    payload = tools.sample(case.id, "PAY.payload_current", t)
    events = tools.events_before(case.id, t, window_s=600.0)
    return Observed(
        heater_a=heater["value_num"] if heater else None,
        payload_a=payload["value_num"] if payload else None,
        warn_clock=format_clock(t),
        has_science=any(e["detail"] == "SCIENCE_MODE" for e in events),
    )


def run_case(case: Case, provider: str, model: str | None) -> CaseResult:
    observed = observe(case)
    report = investigate(case.id, case.alarm, provider, model)
    checks = score(report, case, observed)
    passed = sum(1 for c in checks if c.passed)
    return CaseResult(
        case_id=case.id,
        label=case.label,
        provider=provider,
        passed=passed,
        total=len(checks),
        ok=all(c.passed for c in checks),
        checks=checks,
        report=report,
        observed=observed,
    )


def _print(results: list[CaseResult]) -> None:
    for result in results:
        mark = "pass" if result.ok else "FAIL"
        print(f"{result.case_id:8} {result.passed}/{result.total}  {mark}  {result.label}")
        for check in result.checks:
            flag = "ok" if check.passed else "no"
            print(f"  [{flag}] {check.id:28} {check.detail}")
        print()
    ok = sum(r.ok for r in results)
    checks = sum(r.passed for r in results)
    total = sum(r.total for r in results)
    print(f"{ok}/{len(results)} cases  {checks}/{total} checks  provider={results[0].provider if results else '-'}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Score ORBIT investigations against the matching close")
    parser.add_argument("--case", choices=[c.id for c in CASES], default=None)
    parser.add_argument(
        "--provider",
        choices=("rules", "anthropic", "openai"),
        default="rules",
        help="rules is the default; paid models only if you pass them here",
    )
    parser.add_argument("--model", default=None)
    parser.add_argument("--json", action="store_true")
    parser.add_argument(
        "--feedback",
        action="store_true",
        help="print operator hypothesis feedback summary (adoption metrics)",
    )
    parser.add_argument(
        "--export",
        action="store_true",
        help="with --feedback, write eval/feedback.jsonl",
    )
    parser.add_argument(
        "--scorecard-only",
        action="store_true",
        help="print the last written eval/scorecard.json without re-running cases",
    )
    parser.add_argument(
        "--compare-baseline",
        nargs="?",
        const=str(BASELINE_PATH),
        default=None,
        metavar="PATH",
        help="after full suite, compare candidate vs baseline (default eval/baseline.json)",
    )
    parser.add_argument(
        "--compare-only",
        action="store_true",
        help="compare existing candidate vs baseline without re-running cases",
    )
    parser.add_argument(
        "--promote-baseline",
        action="store_true",
        help="promote eval/candidate.json to eval/baseline.json (requires PASS or --force)",
    )
    parser.add_argument("--promote-note", default=None, help="note stored on promoted baseline")
    parser.add_argument(
        "--force",
        action="store_true",
        help="with --promote-baseline, promote without PASS verdict",
    )
    args = parser.parse_args()

    if args.feedback:
        rows = load_feedback_rows()
        print_summary(rows)
        if args.export:
            path = export_jsonl(rows)
            print(f"exported {len(rows)} rows → {path}")
        sys.exit(0)

    if args.scorecard_only:
        from eval.scorecard import load_scorecard

        data = load_scorecard()
        if not data:
            print("no eval/scorecard.json — run: python -m eval", file=sys.stderr)
            sys.exit(1)
        print(json.dumps(data, indent=2))
        sys.exit(0 if data.get("ok") else 1)

    if args.promote_baseline:
        try:
            path = promote_candidate_to_baseline(note=args.promote_note, force=args.force)
            print(f"promoted candidate → {path}")
            sys.exit(0)
        except Exception as exc:
            print(str(exc), file=sys.stderr)
            sys.exit(1)

    if args.compare_only:
        from pathlib import Path

        baseline_path = Path(args.compare_baseline) if args.compare_baseline else BASELINE_PATH
        result = run_compare(baseline_path=baseline_path)
        print_comparison(result)
        rec = result.get("recommendation")
        sys.exit(0 if rec == "PASS" else 1)

    selected = [c for c in CASES if args.case is None or c.id == args.case]
    init_tracing()
    try:
        results = [run_case(case, args.provider, args.model) for case in selected]
        card = build_scorecard(results, args.provider)

        if args.json:
            print(
                json.dumps(
                    {
                        "scorecard": card.as_dict(),
                        "results": [
                            {
                                **{k: v for k, v in asdict(r).items() if k not in ("checks", "observed")},
                                "checks": [asdict(c) for c in r.checks],
                                "observed": asdict(r.observed) if r.observed else None,
                            }
                            for r in results
                        ],
                    },
                    indent=2,
                )
            )
        else:
            _print(results)
            print()
            print_scorecard(card)

        comparison_result = None
        if args.case is None:
            path = write_scorecard(card)
            bundle = build_run_bundle(results, card, args.provider, args.model, kind="candidate")
            cand_path = write_candidate(bundle)
            if not args.json:
                print(f"wrote {path}")
                print(f"wrote {cand_path}")
            if args.compare_baseline is not None:
                from pathlib import Path

                comparison_result = run_compare(baseline_path=Path(args.compare_baseline))
                if not args.json:
                    print()
                    print_comparison(comparison_result)

        exit_code = 0 if all(r.ok for r in results) else 1
        if comparison_result and comparison_result.get("recommendation") != "PASS":
            exit_code = 1
        sys.exit(exit_code)
    finally:
        flush_tracing()


if __name__ == "__main__":
    main()
