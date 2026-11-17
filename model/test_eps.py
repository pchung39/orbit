"""The power model learns the dummy mission's hidden truth and forecasts honestly.

python -m unittest model.test_eps -v
Uses generated files only (no Postgres, no network). ~15 s.
"""

from __future__ import annotations

import unittest

from model import eps
from simulator import replay as sim
from simulator.scenarios import clock_to_s
from storage.evidence import load_frame


class CalibrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.report = eps.calibrate(save=False)
        cls.model = eps.EpsModel(params=cls.report["params"], status="calibrated",
                                 calibrated_at=cls.report["calibrated_at"], backtest=cls.report["backtest"])

    def test_learns_hidden_truth(self) -> None:
        for row in self.report["truth_check"]:
            with self.subTest(param=row["param"]):
                self.assertTrue(row["ok"], f"{row['label']}: learned {row['learned']} vs truth {row['truth']}")

    def test_moves_away_from_wrong_datasheet(self) -> None:
        p, prior = self.report["params"], self.report["prior"]
        self.assertGreater(p["bus_harness_ohm"], prior["bus_harness_ohm"] * 1.15)
        self.assertGreater(p["heater_healthy_a"], prior["heater_healthy_a"] * 1.1)

    def test_backtest_on_unseen_days(self) -> None:
        bt = self.report["backtest"]
        self.assertGreater(bt["n"], 100)
        for ch, b in bt["channels"].items():
            with self.subTest(channel=ch):
                self.assertGreaterEqual(b["hits"] / b["total"], 0.85)
                self.assertLess(b["mae"], 0.08)
        self.assertIn("fault", bt["miss_kinds"], "the final-week heater fault should be an honest miss")

    def test_fit_levels(self) -> None:
        cases = {"eps204": ("EPS.bus_voltage", "high"), "pay002": ("EPS.bus_voltage", "high"),
                 "batt003": ("EPS.battery_voltage", "low")}
        for run, (ch, want) in cases.items():
            df = load_frame(run)
            t_dec = float(df["time_s"].min()) + 900
            with self.subTest(run=run):
                if run == "batt003":
                    t0, t_dec = clock_to_s("00:07:00"), clock_to_s("00:12:00")
                elif run == "pay002":
                    t0, t_dec = clock_to_s("10:09:00"), clock_to_s("10:14:00")
                else:
                    t0, t_dec = clock_to_s("14:26:44"), clock_to_s("14:33:55")
                self.assertEqual(eps.fit_check(self.model, df, ch, t0, t_dec)["level"], want)

    def test_forecasts_match_hidden_truth(self) -> None:
        """Model previews vs the generator's actual outcome for each option, eps204 and fault1."""
        for run, t_dec in (("eps204", clock_to_s("14:33:55")), ("fault1", clock_to_s("14:35:05"))):
            df = load_frame(run)
            for opt in ("heater_off", "payload_safe", "hold"):
                pv = eps.preview(self.model, df, "EPS.bus_voltage", t_dec, opt)
                cmd = sim.OPTION_COMMANDS[opt]
                truth = sim.replay(run, extra=((t_dec, cmd),) if cmd else (), end_s=t_dec + 900)
                for minutes in (1, 5, 10):
                    t = t_dec + minutes * 60
                    pred = min(pv["series"], key=lambda p: abs(p[0] - t))[1]
                    actual = float(truth.iloc[(truth["time_s"] - t).abs().argmin()]["EPS.bus_voltage"])
                    with self.subTest(run=run, option=opt, minutes=minutes):
                        self.assertLess(abs(pred - actual), 0.15)

    def test_datasheet_model_is_worse(self) -> None:
        df = load_frame("eps204")
        t0, t_dec = clock_to_s("14:26:44"), clock_to_s("14:33:55")
        learned = eps.fit_check(self.model, df, "EPS.bus_voltage", t0, t_dec)["rms"]
        datasheet = eps.fit_check(eps.datasheet(), df, "EPS.bus_voltage", t0, t_dec)["rms"]
        self.assertLess(learned * 3, datasheet)


if __name__ == "__main__":
    unittest.main()
