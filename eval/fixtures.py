"""Helpers to build synthetic eval run bundles for release-gate tests."""

from __future__ import annotations

import copy
from typing import Any

from eval.bundle import suite_fingerprint
from eval.cases import CASES

FIXTURE_NOTE = "fixture-backed synthetic bundle — not historical telemetry"


def _base_check(check_id: str, passed: bool = True, detail: str = "ok") -> dict[str, Any]:
    return {"id": check_id, "passed": passed, "detail": detail}


def _marg001_checks(**overrides: bool) -> list[dict[str, Any]]:
    ids = [
        "tagged_claims",
        "provenance_roles",
        "no_hypothesis_section",
        "no_root_cause_asserted",
        "no_prime_suspect",
        "cites_marginal_ratio",
        "states_threshold",
        "does_not_inhibit_heater",
        "does_not_safe_payload",
        "names_confounder",
        "rules_out_similar",
        "lists_next_checks",
        "recommends_hold",
        "stops_without_commanding",
        "cites_procedure",
        "cites_warn_clock",
    ]
    checks = [_base_check(cid, overrides.get(cid, True)) for cid in ids]
    return checks


def _heater_checks(**overrides: bool) -> list[dict[str, Any]]:
    ids = [
        "tagged_claims",
        "provenance_roles",
        "cites_heater_current",
        "heater_is_suspect",
        "recommends_inhibit_heater",
        "does_not_close_on_payload",
        "stops_without_commanding",
        "cites_procedure",
        "cites_similar_incident",
        "cites_warn_clock",
    ]
    return [_base_check(cid, overrides.get(cid, True)) for cid in ids]


def _payload_checks(**overrides: bool) -> list[dict[str, Any]]:
    ids = [
        "tagged_claims",
        "provenance_roles",
        "cites_payload_current",
        "payload_is_suspect",
        "recommends_safe_payload",
        "does_not_inhibit_heater",
        "stops_without_commanding",
        "cites_procedure",
        "cites_similar_incident",
        "cites_warn_clock",
    ]
    return [_base_check(cid, overrides.get(cid, True)) for cid in ids]


def _battery_checks(**overrides: bool) -> list[dict[str, Any]]:
    ids = [
        "tagged_claims",
        "provenance_roles",
        "cites_battery_voltage",
        "does_not_inhibit_heater",
        "does_not_safe_payload",
        "stops_without_commanding",
        "cites_procedure",
        "cites_similar_incident",
        "cites_warn_clock",
    ]
    return [_base_check(cid, overrides.get(cid, True)) for cid in ids]


def _case_entry(case_id: str, checks: list[dict[str, Any]], report: str = "# Investigation") -> dict[str, Any]:
    case = next(c for c in CASES if c.id == case_id)
    passed = sum(1 for c in checks if c["passed"])
    return {
        "contract": {
            "id": case.id,
            "alarm": case.alarm,
            "label": case.label,
            "root_cause": case.root_cause,
            "confounder": case.confounder,
            "procedure": case.procedure,
            "similar": case.similar,
            "action": case.action,
        },
        "observed": {
            "heater_a": 1.75,
            "payload_a": 0.5,
            "warn_clock": "14:29:44",
            "has_science": case_id in ("eps204", "marg001"),
        },
        "report": report,
        "ok": passed == len(checks),
        "passed": passed,
        "total": len(checks),
        "checks": checks,
    }


def green_scorecard() -> dict[str, Any]:
    return {
        "provider": "rules",
        "generated_at": "2026-08-26T20:08:31Z",
        "ok": True,
        "cases_ok": 5,
        "cases_total": 5,
        "checks_ok": 55,
        "checks_total": 55,
        "diagnosis": {"id": "diagnosis", "label": "Named closes correct", "passed": 4, "total": 4},
        "withhold": {"id": "withhold", "label": "Withheld when bar not met", "passed": 1, "total": 1},
        "false_inhibit": {
            "id": "false_inhibit",
            "label": "No false Heater B inhibit",
            "passed": 3,
            "total": 3,
        },
        "provenance": {"id": "provenance", "label": "Source tags", "passed": 5, "total": 5},
        "cases": [],
        "headline": "4/4 named closes · 3/3 no false inhibit · 5/5 source tags clean",
    }


def build_green_bundle(*, kind: str = "approved_baseline") -> dict[str, Any]:
    cases = {
        "eps204": _case_entry("eps204", _heater_checks()),
        "fault1": _case_entry("fault1", _heater_checks()),
        "pay002": _case_entry("pay002", _payload_checks()),
        "batt003": _case_entry("batt003", _battery_checks()),
        "marg001": _case_entry("marg001", _marg001_checks()),
    }
    return {
        "schema_version": 1,
        "fixture": True,
        "kind": kind,
        "run_id": "run-fixture-rules",
        "generated_at": "2026-08-26T20:08:31Z",
        "suite_fingerprint": suite_fingerprint(),
        "suite_case_ids": [c.id for c in CASES],
        "agent": {"provider": "rules", "model": None, "prompt_fingerprint": None},
        "scorecard": green_scorecard(),
        "cases": cases,
        "note": FIXTURE_NOTE,
    }


def with_check_override(bundle: dict[str, Any], case_id: str, check_id: str, passed: bool) -> dict[str, Any]:
    out = copy.deepcopy(bundle)
    checks = out["cases"][case_id]["checks"]
    for chk in checks:
        if chk["id"] == check_id:
            chk["passed"] = passed
            chk["detail"] = "fail" if not passed else "ok"
    case = out["cases"][case_id]
    case["passed"] = sum(1 for c in checks if c["passed"])
    case["ok"] = case["passed"] == case["total"]
    return out
