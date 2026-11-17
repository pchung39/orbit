"""Alarms in the connected history become cases sealed straight from the source.

python -m unittest storage.test_alarms -v
Uses the dummy mission (CSV source). No Postgres needed.
"""

from __future__ import annotations

import os
import unittest

from agent.brief import build_brief
from storage.alarms import find_episodes, seal_episode
from storage.evidence import SEALED_DIR, query_events


class HistoryAlarmTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.episodes = find_episodes()
        cls.sealed: list[str] = []

    @classmethod
    def tearDownClass(cls) -> None:
        for sid in cls.sealed:
            for ext in ("csv", "json"):
                path = SEALED_DIR / f"{sid}.{ext}"
                if path.exists():
                    os.remove(path)

    def _seal(self, i: int) -> tuple[str, dict]:
        sid, _notes, ep = seal_episode(self.episodes[i]["key"])
        self.sealed.append(sid)
        return sid, ep

    def test_three_fault_episodes_no_glitches(self) -> None:
        """Three injected faults; the 8 single-sample glitches must not become alarms."""
        prim = [e["primary"]["channel"] for e in self.episodes]
        self.assertEqual(prim, ["EPS.bus_voltage", "PAY.payload_current", "EPS.bus_voltage"])
        self.assertEqual(len(self.episodes[0]["alarms"]), 3)  # heater current, heater temp, bus voltage

    def test_opens_on_the_alarm_procedures_start_from(self) -> None:
        first = self.episodes[0]
        self.assertEqual(first["primary"]["channel"], "EPS.bus_voltage")
        self.assertLess(first["alarms"][0]["t"], first["primary"]["t"])  # heater current tripped first

    def test_sealed_window_carries_its_commands(self) -> None:
        sid, ep = self._seal(0)
        details = [e["detail"] for e in query_events(sid)]
        self.assertIn("HEATER_B_ENABLE", details)
        self.assertIn("HEATER_B_DISABLE", details)  # what the operators did, after the alarm

    def test_heater_episode_investigates_as_heater(self) -> None:
        sid, ep = self._seal(2)
        b = build_brief(sid, ep["primary"]["channel"])
        self.assertEqual(b["family"], "heater")
        dec = b["simulation"]["decision"]
        self.assertLess(dec["t"], dec["actual"]["t"], "decide before the operators acted")
        self.assertEqual(dec["actual"]["option"], "heater_off")
        self.assertLess(dec["actual"]["mean_error"], 0.1, "forecast should match what really happened")

    def test_payload_episode_investigates_as_payload(self) -> None:
        sid, ep = self._seal(1)
        self.assertEqual(build_brief(sid, ep["primary"]["channel"])["family"], "payload")


if __name__ == "__main__":
    unittest.main()
