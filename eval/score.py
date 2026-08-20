"""Deterministic checks on a finished report. No LLM."""

from __future__ import annotations

import re
from dataclasses import dataclass

from eval.cases import Case

_NUM = re.compile(r"-?\d+\.\d+|-?\d+")
_NOT = r"do\s+\*{0,2}not\*{0,2}\s+"


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


def _inhibits_heater(text: str) -> bool:
    if re.search(_NOT + r"inhibit.{0,24}heater", text):
        return False
    return "inhibit" in text and "heater" in text


def _safes_payload(text: str) -> bool:
    if re.search(_NOT + r"safe", text):
        return False
    return bool(re.search(r"(?:safe|standby)\s+(?:the\s+)?payload|payload to standby", text))


def _score_withheld(report: str, text: str, case: Case, observed: Observed) -> list[Check]:
    checks: list[Check] = []

    no_hyp = "## hypothesis" not in text
    checks.append(
        Check(
            "no_hypothesis_section",
            no_hyp,
            "hypothesis section omitted" if no_hyp else "unexpected ## Hypothesis section",
        )
    )

    named_fault = bool(
        re.search(
            r"\*\*(HEATER_B_OVERCURRENT|PAYLOAD_POWER_SPIKE|BATTERY_RESISTANCE_DEGRADATION)\*\*",
            report,
        )
    ) or bool(re.search(r"fault-00[123]\s*\)", text))
    checks.append(
        Check(
            "no_root_cause_asserted",
            not named_fault,
            "no FAULT named as cause" if not named_fault else "asserted a closed fault family",
        )
    )

    affirmative_suspect = bool(
        re.search(
            r"(heater|payload).{0,40}(is|as) the prime[\s-]?suspect|"
            r"prime[\s-]?suspect.{0,20}(heater|payload)",
            text,
        )
    ) and "not the prime" not in text and "not prime" not in text
    checks.append(
        Check(
            "no_prime_suspect",
            not affirmative_suspect,
            "no load named prime suspect" if not affirmative_suspect else "named a prime suspect",
        )
    )

    heater_ok = ("heater_b_current" in text or "heater b" in text) and _near(report, observed.heater_a)
    checks.append(
        Check(
            "cites_marginal_ratio",
            heater_ok,
            f"near {observed.heater_a:.2f} A" if observed.heater_a is not None else "no observed heater sample",
        )
    )

    threshold = ("2×" in report or "2x" in text) and (
        "step 4" in text or "threshold" in text or "bar" in text or "below" in text
    )
    checks.append(
        Check(
            "states_threshold",
            threshold,
            "≥2× / step 4 bar named" if threshold else "missing threshold language",
        )
    )

    inhibit = _inhibits_heater(text)
    checks.append(
        Check(
            "does_not_inhibit_heater",
            not inhibit,
            "heater left alone" if not inhibit else "incorrectly recommended inhibit Heater B",
        )
    )
    safe = _safes_payload(text)
    checks.append(
        Check(
            "does_not_safe_payload",
            not safe,
            "payload left alone" if not safe else "incorrectly safed the payload",
        )
    )

    if case.confounder:
        named = case.confounder.lower() in text and (
            "confounder" in text or "cannot close" in text or "do not close" in text
        )
        checks.append(
            Check(
                "names_confounder",
                named,
                "SCIENCE_MODE as confounder" if named else "missed confounder language",
            )
        )

    similar_ok = True
    if case.similar:
        hit = case.similar.lower() in text
        mismatch = "not" in text and ("match" in text or "confirmation" in text or "does not" in text)
        similar_ok = hit and mismatch
        checks.append(
            Check(
                "rules_out_similar",
                similar_ok,
                f"{case.similar} as non-match" if similar_ok else f"{case.similar} not ruled out",
            )
        )

    gaps = "what would change" in text or ("watch" in text and "≥2" in report) or "healthy" in text and "compare" in text
    checks.append(
        Check(
            "lists_next_checks",
            gaps,
            "next checks present" if gaps else "missing what-would-change language",
        )
    )

    hold = "hold" in text and ("do not command" in text or "do **not** inhibit" in text or "do not inhibit" in text)
    checks.append(
        Check(
            "recommends_hold",
            hold,
            "hold / do not command" if hold else "missing hold recommendation",
        )
    )

    needed = ("observed", "derived", "documented", "hypothesis")
    missing = [t for t in needed if not re.search(rf"\[[^\]]*{t}[^\]]*\]", text)]
    checks.insert(
        0,
        Check(
            "tagged_claims",
            not missing,
            "all four tags present" if not missing else f"missing {', '.join(missing)}",
        ),
    )

    stopped = "not executed" in text or "does not command" in text or "no root-cause" in text
    checks.append(
        Check(
            "stops_without_commanding",
            stopped,
            "stops without commanding" if stopped else "missing stop language",
        )
    )

    proc = case.procedure.lower() in text
    checks.append(Check("cites_procedure", proc, case.procedure if proc else f"{case.procedure} not cited"))

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


def score(report: str, case: Case, observed: Observed) -> list[Check]:
    text = _norm(report)
    if case.root_cause == "withheld":
        return _score_withheld(report, text, case, observed)

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

    if case.root_cause == "heater":
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
        checks.append(
            Check("heater_is_suspect", suspect, "ratio or FAULT-001 named" if suspect else "heater not treated as suspect")
        )
        inhibit = _inhibits_heater(text)
        checks.append(
            Check("recommends_inhibit_heater", inhibit, "inhibit Heater B" if inhibit else "no inhibit-heater action")
        )
        payload_as_action = _safes_payload(text)
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
    elif case.root_cause == "payload":
        payload_ok = ("payload_current" in text or "payload current" in text) and _near(
            report, observed.payload_a
        )
        checks.append(
            Check(
                "cites_payload_current",
                payload_ok,
                f"near {observed.payload_a:.2f} A" if observed.payload_a is not None else "no observed payload sample",
            )
        )
        suspect = (
            "payload_power_spike" in text
            or "fault-002" in text
            or ("2×" in report and "payload" in text)
            or ("3×" in report and "payload" in text)
        )
        checks.append(
            Check(
                "payload_is_suspect",
                suspect,
                "FAULT-002 or payload ratio" if suspect else "payload not treated as suspect",
            )
        )
        safe = _safes_payload(text)
        checks.append(
            Check("recommends_safe_payload", safe, "safe payload to STANDBY" if safe else "no payload-safe action")
        )
        inhibit = _inhibits_heater(text)
        checks.append(
            Check(
                "does_not_inhibit_heater",
                not inhibit,
                "heater left alone" if not inhibit else "incorrectly recommended inhibit Heater B",
            )
        )
    else:
        batt_ok = "battery_voltage" in text or "battery voltage" in text
        checks.append(
            Check("cites_battery_voltage", batt_ok, "battery voltage cited" if batt_ok else "battery voltage missing")
        )
        inhibit = _inhibits_heater(text)
        checks.append(
            Check(
                "does_not_inhibit_heater",
                not inhibit,
                "heater left alone" if not inhibit else "incorrectly recommended inhibit Heater B",
            )
        )
        safe = _safes_payload(text)
        checks.append(
            Check(
                "does_not_safe_payload",
                not safe,
                "payload left alone" if not safe else "incorrectly safed the payload",
            )
        )

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
