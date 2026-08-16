"""Run cases through the investigator and score the reports.

Default provider is rules (no paid LLM). Pass --provider only if you
explicitly want a live model.
"""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import asdict, dataclass

from agent.investigate import investigate
from agent.tools import Tools
from eval.cases import CASES, Case
from eval.score import Check, Observed, score
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
    parser = argparse.ArgumentParser(description="Score ORBIT investigations against the EPS-17 close")
    parser.add_argument("--case", choices=[c.id for c in CASES], default=None)
    parser.add_argument(
        "--provider",
        choices=("rules", "anthropic", "openai"),
        default="rules",
        help="rules is the default; paid models only if you pass them here",
    )
    parser.add_argument("--model", default=None)
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()

    selected = [c for c in CASES if args.case is None or c.id == args.case]
    results = [run_case(case, args.provider, args.model) for case in selected]
    if args.json:
        print(
            json.dumps(
                [
                    {
                        **{k: v for k, v in asdict(r).items() if k != "checks"},
                        "checks": [asdict(c) for c in r.checks],
                    }
                    for r in results
                ],
                indent=2,
            )
        )
    else:
        _print(results)
    sys.exit(0 if all(r.ok for r in results) else 1)


if __name__ == "__main__":
    main()
