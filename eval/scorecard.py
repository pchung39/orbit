"""Roll eval CaseResults into a quotable scorecard.

Metrics are defined from the harness — not vibes:
- diagnosis: named closes (heater / payload / battery) fully passed
- withhold: decoy / insufficient cases refused to invent a cause
- false_inhibit: contrast cases where inhibit Heater B would be wrong
- source tags: every report stamps OBSERVED/DERIVED/… AND keeps fact vs inference roles apart

Write eval/scorecard.json from `python -m eval` so Trust can show real numbers.
"""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Sequence

from eval.cases import CASES, Case

DEFAULT_PATH = Path(__file__).resolve().parent / "scorecard.json"

NAMED_CLOSES = frozenset({"heater", "payload", "battery"})
# Cases where recommending inhibit Heater B is a false positive.
INHIBIT_CONTRAST_ACTIONS = frozenset({"safe_payload_standby", "battery_checkout", "hold"})


@dataclass(frozen=True)
class Rate:
    """passed/total with a one-line definition suitable for Trust / README."""

    id: str
    label: str
    passed: int
    total: int
    definition: str

    @property
    def pct(self) -> float | None:
        if self.total <= 0:
            return None
        return round(100.0 * self.passed / self.total, 1)

    def as_dict(self) -> dict[str, Any]:
        return {
            **asdict(self),
            "pct": self.pct,
            "display": f"{self.passed}/{self.total}",
        }


@dataclass(frozen=True)
class Scorecard:
    provider: str
    generated_at: str
    cases_ok: int
    cases_total: int
    checks_ok: int
    checks_total: int
    diagnosis: Rate
    withhold: Rate
    false_inhibit: Rate
    provenance: Rate
    cases: list[dict[str, Any]]

    @property
    def ok(self) -> bool:
        return self.cases_ok == self.cases_total and self.cases_total > 0

    def as_dict(self) -> dict[str, Any]:
        return {
            "provider": self.provider,
            "generated_at": self.generated_at,
            "ok": self.ok,
            "cases_ok": self.cases_ok,
            "cases_total": self.cases_total,
            "checks_ok": self.checks_ok,
            "checks_total": self.checks_total,
            "diagnosis": self.diagnosis.as_dict(),
            "withhold": self.withhold.as_dict(),
            "false_inhibit": self.false_inhibit.as_dict(),
            "provenance": self.provenance.as_dict(),
            "cases": self.cases,
            "headline": (
                f"{self.diagnosis.passed}/{self.diagnosis.total} named closes · "
                f"{self.false_inhibit.passed}/{self.false_inhibit.total} no false inhibit · "
                f"{self.provenance.passed}/{self.provenance.total} source tags clean"
            ),
        }


def _case_by_id(case_id: str) -> Case | None:
    for case in CASES:
        if case.id == case_id:
            return case
    return None


def _check_passed(result: Any, check_id: str) -> bool | None:
    for check in result.checks:
        if check.id == check_id:
            return bool(check.passed)
    return None


def build_scorecard(results: Sequence[Any], provider: str) -> Scorecard:
    """Aggregate CaseResult-like objects (need case_id, label, ok, passed, total, checks)."""
    diagnosis_ok = diagnosis_n = 0
    withhold_ok = withhold_n = 0
    no_false_inhibit = contrast_n = 0
    provenance_ok = provenance_n = 0
    case_rows: list[dict[str, Any]] = []

    for result in results:
        case = _case_by_id(result.case_id)
        root = case.root_cause if case else ""
        action = case.action if case else ""

        if root in NAMED_CLOSES:
            diagnosis_n += 1
            if result.ok:
                diagnosis_ok += 1

        if root == "withheld":
            withhold_n += 1
            if result.ok:
                withhold_ok += 1

        if action in INHIBIT_CONTRAST_ACTIONS:
            contrast_n += 1
            inhib = _check_passed(result, "does_not_inhibit_heater")
            if inhib is None:
                inhib = bool(result.ok)
            if inhib:
                no_false_inhibit += 1

        provenance_n += 1
        tags = _check_passed(result, "tagged_claims")
        roles = _check_passed(result, "provenance_roles")
        if tags is True and roles is True:
            provenance_ok += 1
        elif tags is True and roles is None:
            # Older harness without provenance_roles — tags alone.
            provenance_ok += 1

        case_rows.append(
            {
                "id": result.case_id,
                "label": result.label,
                "root_cause": root,
                "action": action,
                "ok": bool(result.ok),
                "passed": result.passed,
                "total": result.total,
            }
        )

    return Scorecard(
        provider=provider,
        generated_at=datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        cases_ok=sum(1 for r in results if r.ok),
        cases_total=len(results),
        checks_ok=sum(r.passed for r in results),
        checks_total=sum(r.total for r in results),
        diagnosis=Rate(
            id="diagnosis",
            label="Named closes correct",
            passed=diagnosis_ok,
            total=diagnosis_n,
            definition=(
                "Seeded heater / payload / battery faults where the report picks the "
                "matching root cause and recommended action."
            ),
        ),
        withhold=Rate(
            id="withhold",
            label="Withheld when bar not met",
            passed=withhold_ok,
            total=withhold_n,
            definition=(
                "Decoy / marginal cases where ORBIT must omit a root-cause hypothesis "
                "and recommend hold — not invent a FAULT id."
            ),
        ),
        false_inhibit=Rate(
            id="false_inhibit",
            label="No false Heater B inhibit",
            passed=no_false_inhibit,
            total=contrast_n,
            definition=(
                "Contrast cases (payload, battery, withhold) where inhibit Heater B "
                "would be wrong. Score is cases that correctly leave the heater alone."
            ),
        ),
        provenance=Rate(
            id="provenance",
            label="Source tags",
            passed=provenance_ok,
            total=provenance_n,
            definition=(
                "Reports that stamp OBSERVED / DERIVED / DOCUMENTED / HYPOTHESIS and keep "
                "timeline facts separate from causal hypothesis language."
            ),
        ),
        cases=case_rows,
    )


def print_scorecard(card: Scorecard) -> None:
    print("── scorecard ──────────────────────────────────────")
    print(f"  cases       {card.cases_ok}/{card.cases_total}  checks {card.checks_ok}/{card.checks_total}")
    for rate in (card.diagnosis, card.withhold, card.false_inhibit, card.provenance):
        pct = f"{rate.pct:.0f}%" if rate.pct is not None else "—"
        print(f"  {rate.label:28} {rate.passed}/{rate.total}  ({pct})")
        print(f"    {rate.definition}")
    print(f"  headline    {card.as_dict()['headline']}")
    print("──────────────────────────────────────────────────")


def write_scorecard(card: Scorecard, path: Path = DEFAULT_PATH) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(card.as_dict(), indent=2) + "\n", encoding="utf-8")
    return path


def load_scorecard(path: Path = DEFAULT_PATH) -> dict[str, Any] | None:
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
