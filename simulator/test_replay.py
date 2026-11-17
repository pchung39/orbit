"""Replays reproduce the archive tapes exactly; one change shows a different outcome.

python -m unittest simulator.test_replay -v
"""

from __future__ import annotations

import unittest

import numpy as np
import pandas as pd

from simulator.replay import PREVIEW_HORIZON_S, RECIPES, outcome, replay
from simulator.scenarios import clock_to_s
from storage.evidence import ARCHIVE, ensure_archive_csv

ARCHIVE_PATHS = {row[0]: row[2] for row in ARCHIVE}
WARN, DIRECTION = 26.5, "below"


class ReplayTests(unittest.TestCase):
    def test_unchanged_replay_matches_archive_tape(self) -> None:
        """If this fails, simulator code drifted from the stored tapes; what-ifs would be wrong."""
        for tape in RECIPES:
            with self.subTest(tape=tape):
                path = ARCHIVE_PATHS[tape]
                ensure_archive_csv(tape, path)
                stored = pd.read_csv(path)
                fresh = replay(tape)
                self.assertEqual(len(stored), len(fresh))
                for col in stored.columns:
                    if col in ("timestamp", "PAY.mode"):
                        continue
                    np.testing.assert_allclose(stored[col].to_numpy(), fresh[col].to_numpy(), atol=1e-9)
                self.assertTrue((stored["PAY.mode"].to_numpy() == fresh["PAY.mode"].to_numpy()).all())

    def test_healthy_heater_removes_the_eps204_alarm(self) -> None:
        healthy = replay("eps204", remove_fault=True)
        self.assertGreater(float(healthy["EPS.bus_voltage"].min()), WARN)
        actual = replay("eps204")
        self.assertLess(float(actual["EPS.bus_voltage"].min()), WARN)

    def test_heater_off_clears_and_payload_safe_does_not(self) -> None:
        t = clock_to_s("14:33:55")
        end = t + PREVIEW_HORIZON_S
        heater_off = replay("eps204", extra=((t, "HEATER_B_DISABLE"),), end_s=end)
        payload_safe = replay("eps204", extra=((t, "PAYLOAD_STANDBY"),), end_s=end)
        self.assertTrue(outcome(heater_off, "EPS.bus_voltage", t, WARN, DIRECTION)["clears"])
        self.assertFalse(outcome(payload_safe, "EPS.bus_voltage", t, WARN, DIRECTION)["clears"])

    def test_extra_command_does_not_change_the_past(self) -> None:
        t = clock_to_s("14:33:55")
        base = replay("eps204")
        changed = replay("eps204", extra=((t, "HEATER_B_DISABLE"),))
        before = base["time_s"] < t
        np.testing.assert_allclose(
            base.loc[before, "EPS.bus_voltage"].to_numpy(),
            changed.loc[before, "EPS.bus_voltage"].to_numpy(),
        )

    def test_disable_wins_over_earlier_enable(self) -> None:
        t = clock_to_s("14:33:55")
        df = replay("fault1", extra=((t, "HEATER_B_DISABLE"),))
        after = df[df["time_s"] >= t]
        self.assertLess(float(after["THM.heater_b_current"].abs().max()), 0.1)  # off, plus sensor noise


if __name__ == "__main__":
    unittest.main()
