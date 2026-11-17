"""Case brief: one classifier, numbers that match the tape, honest verdicts.

python -m unittest agent.test_brief -v
Reads tape files only (no Postgres).
"""

from __future__ import annotations

import re
import unittest

from agent.brief import build_brief
from agent.hypothesis import classify, measure
from agent.tools import Tools
from eval.cases import CASES
from simulator.simulate import load_and_validate
from storage.evidence import query_channel

LEADING = {"heater": "heater", "payload": "payload", "battery": "battery"}


class BriefTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.spec = load_and_validate()
        cls.briefs = {c.id: build_brief(c.id, c.alarm) for c in CASES}

    def test_family_matches_eval_contract(self) -> None:
        for case in CASES:
            with self.subTest(case=case.id):
                self.assertEqual(self.briefs[case.id]["family"], case.root_cause)

    def test_brief_and_report_share_one_classifier(self) -> None:
        for case in CASES:
            with self.subTest(case=case.id):
                m = measure(Tools(None, self.spec), self.spec, case.id, case.alarm)
                self.assertEqual(classify(m, self.spec), self.briefs[case.id]["family"])

    def test_verdicts(self) -> None:
        for case in CASES:
            brief = self.briefs[case.id]
            verdicts = {h["id"]: h["verdict"] for h in brief["hypotheses"]}
            with self.subTest(case=case.id):
                if case.root_cause in LEADING:
                    self.assertEqual(verdicts[LEADING[case.root_cause]], "leading")
                    self.assertEqual(list(verdicts.values()).count("leading"), 1)
                else:
                    self.assertNotIn("leading", verdicts.values())
                    self.assertEqual(verdicts["heater"], "below_bar")
                # Leading card is listed first and expanded by default in the UI.
                self.assertIn(brief["hypotheses"][0]["verdict"], ("leading", "below_bar"))

    def test_evidence_numbers_come_from_the_tape(self) -> None:
        """Every 'Draws X A' current in an evidence line is a sample on the tape."""
        pattern = re.compile(r"Draws (\d+\.\d+) A")
        for case in CASES:
            brief = self.briefs[case.id]
            for card in brief["hypotheses"]:
                channel = "THM.heater_b_current" if card["id"] == "heater" else "PAY.payload_current"
                values = [r["value_num"] for r in query_channel(case.id, channel) if r["value_num"] is not None]
                for ev in card["evidence"]:
                    for hit in pattern.findall(ev["text"]):
                        with self.subTest(case=case.id, text=ev["text"]):
                            self.assertTrue(any(abs(v - float(hit)) < 0.006 for v in values))

    def test_every_evidence_line_is_tagged(self) -> None:
        allowed = {"OBSERVED", "DERIVED", "DOCUMENTED", "SIMULATED"}
        for case in CASES:
            for card in self.briefs[case.id]["hypotheses"]:
                for ev in card["evidence"]:
                    with self.subTest(case=case.id, text=ev["text"]):
                        self.assertTrue(ev["tags"])
                        self.assertTrue(set(ev["tags"]) <= allowed)
                        self.assertIn(ev["sign"], ("+", "−"))

    def test_load_attribution_adds_up(self) -> None:
        for case in CASES:
            loads = self.briefs[case.id]["loads"]
            with self.subTest(case=case.id):
                for when in ("before", "after"):
                    total = loads["heater"][when] + loads["payload"][when] + loads["other"][when]
                    self.assertAlmostEqual(total, loads["bus"][when], places=2)

    def test_heater_moves_before_payload_on_confounder_tape(self) -> None:
        onsets = self.briefs["eps204"]["onsets"]
        self.assertLess(onsets["heater"]["t"], onsets["payload"]["t"])
        self.assertNotIn("heater", self.briefs["pay002"]["onsets"])

    def test_recommended_option_follows_family(self) -> None:
        expected = {"heater": "heater_off", "payload": "payload_safe", "battery": "hold", "withheld": "hold"}
        for case in CASES:
            options = self.briefs[case.id]["simulation"]["decision"]["options"]
            recommended = [o["id"] for o in options if o["recommended"]]
            with self.subTest(case=case.id):
                self.assertEqual(recommended, [expected[case.root_cause]])

    def test_recommended_fix_clears_warn_for_load_faults(self) -> None:
        for case in CASES:
            if case.root_cause not in ("heater", "payload"):
                continue
            options = {o["id"]: o for o in self.briefs[case.id]["simulation"]["decision"]["options"]}
            with self.subTest(case=case.id):
                rec = next(o for o in options.values() if o["recommended"])
                self.assertEqual(rec["result"], "clears")
                self.assertEqual(options["hold"]["result"], "stays")

    def test_withheld_case_has_no_proof_of_a_cause(self) -> None:
        brief = self.briefs["marg001"]
        self.assertNotIn("whatif", brief["simulation"])
        for card in brief["hypotheses"]:
            self.assertFalse(any(ev.get("proof") for ev in card["evidence"]))


if __name__ == "__main__":
    unittest.main()
