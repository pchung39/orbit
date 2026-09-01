"""Release gate tests — synthetic fixtures plus optional Postgres integration."""

from __future__ import annotations

import unittest
from pathlib import Path

from eval.bundle import PromoteError, promote_candidate_to_baseline, suite_fingerprint, write_comparison, write_json
from eval.compare import compare_bundles
from eval.fixtures import build_green_bundle, with_check_override
from eval.release_gate import release_verdict
from eval.run import run_case
from eval.cases import CASES

ROOT = Path(__file__).resolve().parent.parent
APP_JS = ROOT / "ui" / "app.js"
SEED_BASELINE = Path(__file__).resolve().parent / "baselines" / "seed-rules.fixture.json"


class ReleaseGateTests(unittest.TestCase):
    def test_clean_pass(self) -> None:
        baseline = build_green_bundle(kind="approved_baseline")
        candidate = build_green_bundle(kind="candidate")
        verdict = release_verdict(baseline, candidate)
        self.assertEqual(verdict["recommendation"], "PASS")

    def test_aggregate_improvement_critical_regression_blocked(self) -> None:
        baseline = build_green_bundle(kind="approved_baseline")
        candidate = with_check_override(
            build_green_bundle(kind="candidate"),
            "marg001",
            "does_not_inhibit_heater",
            False,
        )
        verdict = release_verdict(baseline, candidate)
        self.assertEqual(verdict["recommendation"], "BLOCKED")
        kinds = {b["kind"] for b in verdict["blockers"]}
        self.assertTrue("false_inhibit_failure" in kinds or "marg001_invariant_failure" in kinds)

    def test_provenance_failure_blocked(self) -> None:
        baseline = build_green_bundle(kind="approved_baseline")
        candidate = with_check_override(
            build_green_bundle(kind="candidate"),
            "eps204",
            "provenance_roles",
            False,
        )
        verdict = release_verdict(baseline, candidate)
        self.assertEqual(verdict["recommendation"], "BLOCKED")
        self.assertTrue(any(b["kind"] == "provenance_failure" for b in verdict["blockers"]))

    def test_heater_b_contrast_failure_blocked(self) -> None:
        baseline = build_green_bundle(kind="approved_baseline")
        candidate = with_check_override(
            build_green_bundle(kind="candidate"),
            "pay002",
            "does_not_inhibit_heater",
            False,
        )
        verdict = release_verdict(baseline, candidate)
        self.assertEqual(verdict["recommendation"], "BLOCKED")
        self.assertTrue(any(b["kind"] == "false_inhibit_failure" for b in verdict["blockers"]))

    def test_incomplete_suite_insufficient(self) -> None:
        baseline = build_green_bundle(kind="approved_baseline")
        candidate = build_green_bundle(kind="candidate")
        del candidate["cases"]["marg001"]
        verdict = release_verdict(baseline, candidate)
        self.assertEqual(verdict["recommendation"], "INSUFFICIENT_COVERAGE")

    def test_suite_fingerprint_mismatch(self) -> None:
        baseline = build_green_bundle(kind="approved_baseline")
        candidate = build_green_bundle(kind="candidate")
        candidate["suite_fingerprint"] = "deadbeef"
        verdict = release_verdict(baseline, candidate)
        self.assertEqual(verdict["recommendation"], "INSUFFICIENT_COVERAGE")
        self.assertIn("suite_fingerprint_mismatch", verdict["coverage_issues"])

    def test_marg001_check_regression_blocked(self) -> None:
        baseline = build_green_bundle(kind="approved_baseline")
        candidate = with_check_override(
            build_green_bundle(kind="candidate"),
            "marg001",
            "recommends_hold",
            False,
        )
        verdict = release_verdict(baseline, candidate)
        self.assertEqual(verdict["recommendation"], "BLOCKED")
        self.assertTrue(any(b["kind"] == "marg001_regression" for b in verdict["blockers"]))

    def test_promote_requires_pass(self) -> None:
        import tempfile

        baseline = build_green_bundle(kind="approved_baseline")
        candidate = with_check_override(
            build_green_bundle(kind="candidate"),
            "pay002",
            "does_not_inhibit_heater",
            False,
        )
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            cand_path = tmp_path / "candidate.json"
            base_path = tmp_path / "baseline.json"
            cmp_path = tmp_path / "comparison.json"
            write_json(cand_path, candidate)
            write_comparison(compare_bundles(baseline, candidate), cmp_path)
            with self.assertRaises(PromoteError):
                promote_candidate_to_baseline(
                    force=False,
                    candidate_path=cand_path,
                    baseline_path=base_path,
                    comparison_path=cmp_path,
                )

    def test_promote_explicit_ok(self) -> None:
        import tempfile

        candidate = build_green_bundle(kind="candidate")
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            cand_path = tmp_path / "candidate.json"
            base_path = tmp_path / "baseline.json"
            cmp_path = tmp_path / "comparison.json"
            write_json(cand_path, candidate)
            comparison = compare_bundles(build_green_bundle(kind="approved_baseline"), candidate)
            write_comparison(comparison, cmp_path)
            path = promote_candidate_to_baseline(
                note="test",
                candidate_path=cand_path,
                baseline_path=base_path,
                comparison_path=cmp_path,
            )
            self.assertTrue(path.exists())
            data = path.read_text(encoding="utf-8")
            self.assertIn("approved_baseline", data)

    def test_trust_api_uses_artifacts(self) -> None:
        baseline = build_green_bundle(kind="approved_baseline")
        candidate = build_green_bundle(kind="candidate")
        result = compare_bundles(baseline, candidate)
        self.assertIn("metrics", result)
        self.assertIn("cases", result)
        js = APP_JS.read_text(encoding="utf-8")
        self.assertIn("releaseCompare", js)
        self.assertNotIn("4/4 named closes", js)

    def test_seed_fixture_matches_suite(self) -> None:
        if not SEED_BASELINE.exists():
            write_json(SEED_BASELINE, build_green_bundle(kind="approved_baseline"))
        data = SEED_BASELINE.read_text(encoding="utf-8")
        self.assertIn('"fixture": true', data)
        self.assertIn(suite_fingerprint(), data)


class RulesSuiteIntegration(unittest.TestCase):
    def test_rules_suite_passes(self) -> None:
        try:
            from storage.store import connect, init_schema

            conn = connect()
            init_schema(conn)
        except Exception:
            self.skipTest("Postgres unavailable")
        for case in CASES:
            result = run_case(case, "rules", None)
            self.assertTrue(result.ok, f"{case.id} failed")


if __name__ == "__main__":
    unittest.main()
