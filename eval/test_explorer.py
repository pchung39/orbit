"""Tests for eval/explorer.py — interpretation and critical flags."""

from __future__ import annotations

import unittest

from eval.explorer import (
    EXPLORER_DISCLOSURE,
    build_explorer_case_detail,
    build_explorer_index,
    case_critical_failures,
    interpret_case,
    is_check_critical,
)
from eval.fixtures import build_green_bundle, with_check_override
from eval.release_gate import release_verdict


class ExplorerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.baseline = build_green_bundle(kind="approved_baseline")
        self.candidate = build_green_bundle(kind="candidate")

    def test_green_case_no_critical_failures(self) -> None:
        entry = self.candidate["cases"]["eps204"]
        self.assertEqual(case_critical_failures("eps204", entry), [])

    def test_provenance_failure_is_critical(self) -> None:
        cand = with_check_override(self.candidate, "eps204", "tagged_claims", False)
        entry = cand["cases"]["eps204"]
        failures = case_critical_failures("eps204", entry)
        self.assertEqual(len(failures), 1)
        self.assertEqual(failures[0]["check_id"], "tagged_claims")

    def test_false_inhibit_critical_on_contrast_case(self) -> None:
        self.assertTrue(is_check_critical("pay002", "does_not_inhibit_heater"))
        cand = with_check_override(self.candidate, "pay002", "does_not_inhibit_heater", False)
        lines = interpret_case("pay002", cand["cases"]["pay002"])
        self.assertTrue(any("Safety boundary" in line for line in lines))

    def test_interpret_green_heater_case(self) -> None:
        entry = self.candidate["cases"]["eps204"]
        lines = interpret_case("eps204", entry)
        self.assertTrue(any("All deterministic checks passed" in line for line in lines))

    def test_interpret_provenance_failure(self) -> None:
        cand = with_check_override(self.candidate, "fault1", "provenance_roles", False)
        lines = interpret_case("fault1", cand["cases"]["fault1"])
        self.assertTrue(any("Timeline facts" in line for line in lines))

    def test_interpret_marg001_withhold_success(self) -> None:
        entry = self.candidate["cases"]["marg001"]
        lines = interpret_case("marg001", entry)
        self.assertTrue(
            any("withheld" in line.lower() or "All deterministic" in line for line in lines)
        )

    def test_build_explorer_index_five_cases(self) -> None:
        verdict = release_verdict(self.baseline, self.candidate)
        index = build_explorer_index(self.candidate, verdict, self.candidate["scorecard"])
        self.assertEqual(len(index["cases"]), 5)
        self.assertEqual(index["disclosure"], EXPLORER_DISCLOSURE)
        self.assertIsNotNone(index["run"]["run_id"])
        self.assertEqual(index["recommendation"], "PASS")
        eps = next(c for c in index["cases"] if c["id"] == "eps204")
        self.assertIn("diagnosis", eps["metric_ids"])
        self.assertIn("provenance", eps["metric_ids"])
        self.assertFalse(eps["critical_failure"])

    def test_index_flags_critical_on_provenance_fail(self) -> None:
        cand = with_check_override(self.candidate, "batt003", "tagged_claims", False)
        index = build_explorer_index(cand, None, cand["scorecard"])
        row = next(c for c in index["cases"] if c["id"] == "batt003")
        self.assertTrue(row["critical_failure"])
        self.assertIn("tagged_claims", row["failed_checks"])

    def test_build_explorer_case_detail_enriched_checks(self) -> None:
        entry = self.candidate["cases"]["pay002"]
        detail = build_explorer_case_detail("pay002", entry, entry, None, self.baseline)
        self.assertEqual(len(detail["checks_enriched"]), len(entry["checks"]))
        inhib = next(c for c in detail["checks_enriched"] if c["id"] == "does_not_inhibit_heater")
        self.assertTrue(inhib["critical"])
        self.assertTrue(detail["interpretation"])
        self.assertTrue(detail["safety_expectation"])
        self.assertEqual(detail["boundaries"], detail["boundaries"])


if __name__ == "__main__":
    unittest.main()
