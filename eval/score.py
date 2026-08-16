"""Deterministic checks on a finished report. No LLM."""

from __future__ import annotations

import re
from dataclasses import dataclass

from eval.cases import Case

_NUM = re.compile(r"-?\d+\.\d+|-?\d+")


@dataclass(frozen=True)
class Observed:
    heater_a: float | None
    payload_a: float | None
    warn_clock: str | None
    has_science: bool


@dataclass(frozen=True)
class Check:
    id: str
    passed: bool
    detail: str


def _norm(report: str) -> str:
    return report.lower()


def _numbers(report: str) -> list[float]:
    return [float(m) for m in _NUM.findall(report)]


def _near(report: str, target: float | None, tol: float = 0.2) -> bool:
    if target is None:
        return False
    return any(abs(n - target) <= tol for n in _numbers(report))


def score(report: str, case: Case, observed: Observed) -> list[Check]:
    text = _norm(report)
    checks: list[Check] = []

    def _tagged(name: str) -> bool:
        return re.search(rf"\[[^\]]*{name}[^\]]*\]", text) is not None

    needed = ("observed", "derived", "documented", "hypothesis")
    missing = [t for t in needed if not _tagged(t)]
    checks.append(
        Check(
            "tagged_claims",
            not missing,
            "all four tags present" if not missing else f"missing {', '.join(missing)}",
        )
    )

    heater_ok = ("heater_b_current" in text or "heater b" in text) and _near(report, observed.heater_a)
    checks.append(
        Check(
            "cites_heater_current",
            heater_ok,
            f"near {observed.heater_a:.2f} A" if observed.heater_a is not None else "no observed heater sample",
        )
    )

    suspect = (
        "heater_b_overcurrent" in text
        or "2×" in report
        or "2x" in text
        or "3×" in report
        or "3x" in text
        or "prime suspect" in text
    )
    checks.append(Check("heater_is_suspect", suspect, "ratio or FAULT-001 named" if suspect else "heater not treated as suspect"))

    inhibit = "inhibit" in text and "heater" in text
    checks.append(Check("recommends_inhibit_heater", inhibit, "inhibit Heater B" if inhibit else "no inhibit-heater action"))

    payload_as_action = bool(
        re.search(r"(?:safe|standby|inhibit)\s+(?:the\s+)?payload", text)
    ) and not re.search(r"do\s+\*?\*?not\*?\*?\s+safe", text)
    if case.confounder:
        named = case.confounder.lower() in text and (
            "confounder" in text or "do not" in text or "cannot" in text
        )
        not_payload_first = named and inhibit and not payload_as_action
        detail = (
            "confounder named; action is the heater"
            if not_payload_first
            else "missed the confounder or closed on the payload"
        )
    else:
        invented = "science_mode" in text and "root cause" in text and "confounder" not in text
        not_payload_first = inhibit and not payload_as_action and not invented
        detail = "payload not the action" if not_payload_first else "closed on payload"
    checks.append(Check("does_not_close_on_payload", not_payload_first, detail))

    stopped = (
        "not executed" in text
        or "does not command" in text
        or "operator has to" in text
        or "not sent" in text
    )
    commanded = bool(re.search(r"(command sent|heater disabled|commanded off)", text))
    checks.append(
        Check(
            "stops_without_commanding",
            stopped and not commanded,
            "stops at a human decision" if stopped and not commanded else "missing stop language",
        )
    )

    proc = case.procedure.lower() in text
    checks.append(Check("cites_procedure", proc, case.procedure if proc else f"{case.procedure} not cited"))

    if case.similar:
        hit = case.similar.lower() in text
        checks.append(Check("cites_similar_incident", hit, case.similar if hit else f"{case.similar} not cited"))

    if observed.warn_clock:
        clock_hit = observed.warn_clock in report
        checks.append(
            Check(
                "cites_warn_clock",
                clock_hit,
                observed.warn_clock if clock_hit else f"expected {observed.warn_clock}",
            )
        )

    return checks
